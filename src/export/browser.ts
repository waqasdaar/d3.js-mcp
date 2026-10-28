import { writeFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { D3McpError } from "../shared/errors.js";
import { log } from "../shared/logger.js";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch (e) {
        throw new D3McpError(
          "BROWSER_UNAVAILABLE",
          `Playwright is not installed: ${(e as Error).message}`,
          "Run: npm install && npx playwright install chromium",
        );
      }
      try {
        return await chromium.launch({ headless: true });
      } catch (e) {
        throw new D3McpError(
          "BROWSER_UNAVAILABLE",
          `Chromium could not be launched: ${(e as Error).message.split("\n")[0]}`,
          "Run: npx playwright install chromium",
        );
      }
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    await (await p).close();
  } catch {
    /* already closed */
  }
}

export async function browserAvailable(): Promise<{ available: boolean; reason?: string; version?: string }> {
  try {
    const b = await getBrowser();
    return { available: true, version: b.version() };
  } catch (e) {
    return { available: false, reason: (e as Error).message };
  }
}

/** Run fn with an isolated, offline browser page; all network requests are blocked. */
export async function withPage<T>(
  timeoutMs: number,
  viewport: { width: number; height: number; deviceScaleFactor?: number },
  fn: (
    page: Page,
    diagnostics: { consoleErrors: string[]; pageErrors: string[]; blockedRequests: string[] },
  ) => Promise<T>,
): Promise<T> {
  const browser = await getBrowser();
  let context: BrowserContext | undefined;
  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    blockedRequests: [] as string[],
  };
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      offline: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      permissions: [],
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) => {
      diagnostics.blockedRequests.push(route.request().url().slice(0, 200));
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on("console", (m) => {
      if (m.type() === "error") diagnostics.consoleErrors.push(m.text().slice(0, 500));
    });
    page.on("pageerror", (e) => diagnostics.pageErrors.push(e.message.slice(0, 500)));
    const result = await Promise.race([
      fn(page, diagnostics),
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new D3McpError("EXPORT_FAILED", `Browser operation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return result;
  } finally {
    if (context) await context.close().catch((e) => log.warn("context close failed", { error: String(e) }));
  }
}

export async function htmlToPng(
  html: string,
  out: string,
  size: { width: number; height: number },
  scale: number,
  timeoutMs: number,
): Promise<number> {
  return withPage(
    timeoutMs,
    {
      width: Math.max(size.width + 40, 400),
      height: Math.max(size.height + 40, 300),
      deviceScaleFactor: scale,
    },
    async (page) => {
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForFunction(
        () => (window as unknown as { __d3mcp?: { ready: boolean } }).__d3mcp?.ready === true,
        undefined,
        { timeout: timeoutMs },
      );
      const buf = await page.screenshot({ fullPage: true, type: "png" });
      await writeFile(out, buf);
      return buf.length;
    },
  );
}

export async function svgToPng(
  svg: string,
  out: string,
  size: { width: number; height: number },
  scale: number,
  timeoutMs: number,
): Promise<number> {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`;
  return withPage(
    timeoutMs,
    { width: size.width, height: size.height, deviceScaleFactor: scale },
    async (page) => {
      await page.setContent(html, { waitUntil: "load" });
      const el = await page.$("svg");
      if (!el) throw new D3McpError("EXPORT_FAILED", "SVG element not found while rasterizing");
      const buf = await el.screenshot({ type: "png", omitBackground: false });
      await writeFile(out, buf);
      return buf.length;
    },
  );
}

export async function htmlToPdf(
  html: string,
  out: string,
  size: { width: number; height: number },
  timeoutMs: number,
): Promise<number> {
  return withPage(timeoutMs, { width: size.width + 40, height: size.height + 40 }, async (page) => {
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "screen" });
    const buf = await page.pdf({
      printBackground: true,
      width: `${size.width + 40}px`,
      height: `${size.height + 200}px`,
    });
    await writeFile(out, buf);
    return buf.length;
  });
}

export interface BrowserInspection {
  ok: boolean;
  runtimeReady: boolean;
  d3Loaded: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  blockedRequests: string[];
  viewports: Array<{
    width: number;
    height: number;
    svgCount: number;
    svgBoxes: Array<{ width: number; height: number }>;
    markCount: number;
    visibleMarks: number;
    marksOutsideSvg: number;
    overlappingLabelPairs: number;
    horizontalOverflow: boolean;
  }>;
  tooltip?: { shown: boolean; text: string };
  keyboardFocusable: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

/** Load an HTML artifact in Chromium and verify rendering, marks, tooltips and responsiveness. */
export async function inspectHtml(
  html: string,
  opts: {
    markSelector: string;
    expectedMarks?: number;
    viewports?: Array<{ width: number; height: number }>;
    timeoutMs: number;
    screenshotPath?: string;
  },
): Promise<BrowserInspection> {
  const viewports = opts.viewports ?? [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ];
  return withPage(opts.timeoutMs, viewports[0]!, async (page, diag) => {
    await page.setContent(html, { waitUntil: "load" });
    const runtimeReady = await page
      .waitForFunction(
        () => (window as unknown as { __d3mcp?: { ready: boolean } }).__d3mcp?.ready === true,
        undefined,
        { timeout: Math.min(10000, opts.timeoutMs) },
      )
      .then(() => true)
      .catch(() => false);
    const d3Loaded = await page.evaluate(
      () => typeof (window as unknown as { d3?: unknown }).d3 !== "undefined",
    );
    const results: BrowserInspection["viewports"] = [];
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      results.push(
        await page.evaluate((sel) => {
          const svgs = Array.from(document.querySelectorAll("svg.d3mcp-root"));
          const marks = Array.from(document.querySelectorAll(sel)) as SVGGraphicsElement[];
          let visible = 0;
          let outside = 0;
          for (const m of marks) {
            const r = m.getBoundingClientRect();
            const owner = (m.ownerSVGElement ?? m.closest("svg"))!.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) visible++;
            if (
              r.right < owner.left - 1 ||
              r.left > owner.right + 1 ||
              r.bottom < owner.top - 1 ||
              r.top > owner.bottom + 1
            )
              outside++;
          }
          const labels = Array.from(
            document.querySelectorAll("svg.d3mcp-root .axis text, svg.d3mcp-root .labels text"),
          )
            .map((t) => t.getBoundingClientRect())
            .filter((r) => r.width > 0);
          let overlaps = 0;
          for (let i = 0; i < labels.length && i < 400; i++) {
            for (let j = i + 1; j < labels.length && j < 400; j++) {
              const a = labels[i]!;
              const b = labels[j]!;
              const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (ox > 2 && oy > 2) overlaps++;
            }
          }
          return {
            width: window.innerWidth,
            height: window.innerHeight,
            svgCount: svgs.length,
            svgBoxes: svgs.map((s) => {
              const r = s.getBoundingClientRect();
              return { width: Math.round(r.width), height: Math.round(r.height) };
            }),
            markCount: marks.length,
            visibleMarks: visible,
            marksOutsideSvg: outside,
            overlappingLabelPairs: overlaps,
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        }, opts.markSelector),
      );
    }
    await page.setViewportSize(viewports[0]!);
    let tooltip: BrowserInspection["tooltip"];
    const first = await page.$(`${opts.markSelector}.mark, ${opts.markSelector} .mark, svg.d3mcp-root .mark`);
    if (first) {
      await first.hover({ force: true }).catch(() => undefined);
      tooltip = await page.evaluate(() => {
        const t = document.getElementById("d3mcp-tooltip");
        return { shown: !!t && !t.hidden, text: t?.textContent ?? "" };
      });
    }
    const keyboardFocusable = await page.evaluate(
      () => document.querySelectorAll("svg.d3mcp-root .mark[tabindex]").length,
    );
    if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath, fullPage: true });
    const desk = results[0]!;
    const checks = [
      {
        name: "no-page-errors",
        passed: diag.pageErrors.length === 0,
        detail: diag.pageErrors.join(" | ") || undefined,
      },
      {
        name: "no-console-errors",
        passed: diag.consoleErrors.length === 0,
        detail: diag.consoleErrors.join(" | ") || undefined,
      },
      {
        name: "no-network-requests",
        passed: diag.blockedRequests.length === 0,
        detail: diag.blockedRequests.join(", ") || undefined,
      },
      { name: "runtime-ready", passed: runtimeReady },
      {
        name: "svg-present-nonzero",
        passed: desk.svgCount > 0 && desk.svgBoxes.every((b) => b.width > 0 && b.height > 0),
      },
      { name: "marks-present", passed: desk.markCount > 0, detail: `${desk.markCount} marks` },
      ...(opts.expectedMarks !== undefined
        ? [
            {
              name: "expected-mark-count",
              passed: desk.markCount === opts.expectedMarks,
              detail: `expected ${opts.expectedMarks}, found ${desk.markCount}`,
            },
          ]
        : []),
      { name: "marks-visible", passed: desk.visibleMarks > 0 },
      {
        name: "marks-within-svg",
        passed: desk.marksOutsideSvg === 0,
        detail: `${desk.marksOutsideSvg} outside`,
      },
      { name: "responsive-no-overflow", passed: results.every((r) => !r.horizontalOverflow) },
      ...(tooltip ? [{ name: "tooltip-on-hover", passed: tooltip.shown && tooltip.text.length > 0 }] : []),
    ];
    return {
      ok: checks.every((c) => c.passed),
      runtimeReady,
      d3Loaded,
      consoleErrors: diag.consoleErrors,
      pageErrors: diag.pageErrors,
      blockedRequests: diag.blockedRequests,
      viewports: results,
      ...(tooltip ? { tooltip } : {}),
      keyboardFocusable,
      checks,
    };
  });
}
