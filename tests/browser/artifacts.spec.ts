import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { profileDataset } from "../../src/core/data/profile.js";
import { analyzeLinks } from "../../src/core/data/link.js";
import { VisualizationService } from "../../src/core/service.js";
import { planVisualization, type PlanOptions } from "../../src/core/planning/planner.js";
import type { VisType } from "../../src/core/schema/spec.js";
import { validatePng } from "../../src/core/validation/structural.js";
import { closeBrowser } from "../../src/export/browser.js";
import {
  geo,
  hierarchy,
  largeRecords,
  network,
  sales,
  simpleBars,
  telemetryCsv,
  TIER_ORDER,
  topology,
} from "../fixtures/data.js";
import { tempService } from "../helpers/render.js";

const SHOTS = path.resolve("reports", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const svc = tempService();

async function artifact(
  data: unknown,
  type: VisType,
  options: PlanOptions = {},
  formats: Array<"html" | "svg" | "png"> = ["html", "svg"],
) {
  const ds = await svc.resolveData(data, "browser");
  const plan = planVisualization({
    dataset: ds,
    profile: profileDataset(ds),
    prompt: "",
    type,
    title: `Browser ${type}`,
    options,
  });
  return svc.renderArtifact(plan.spec, ds, { formats, sessionId: "browser" });
}

async function open(page: Page, htmlPath: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(pathToFileURL(htmlPath).href);
  await page.waitForFunction(
    () => (window as unknown as { __d3mcp?: { ready: boolean } }).__d3mcp?.ready === true,
  );
  return errors;
}

async function svgBox(page: Page) {
  const box = await page.locator("svg.d3mcp-root").first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(50);
  expect(box!.height).toBeGreaterThan(50);
  return box!;
}

test.afterAll(async () => {
  await closeBrowser();
});

test("bar chart: marks, axes, title, tooltip, keyboard, responsive", async ({ page }) => {
  const r = await artifact(simpleBars, "bar", {
    encoding: { x: { field: "category" }, y: { field: "value" } },
  });
  const errors = await open(page, r.record.files.html!.path);
  await svgBox(page);
  const bars = page.locator("rect.bar");
  await expect(bars).toHaveCount(5);
  const heights = await bars.evaluateAll((els) => els.map((e) => (e as SVGGraphicsElement).getBBox().height));
  expect(heights[1]).toBe(Math.max(...heights));
  expect(heights[0]! / heights[1]!).toBeCloseTo(30 / 80, 1);
  await expect(page.locator("svg.d3mcp-root .axis").first()).toBeVisible();
  await expect(page.locator("svg.d3mcp-root > title")).toHaveText(/Browser bar/);

  await bars.nth(1).hover();
  const tip = page.locator("#d3mcp-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("80");

  await bars.first().focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe("B");

  await page.screenshot({ path: path.join(SHOTS, "bar-desktop.png") });
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(tip).toBeHidden();
  const mobile = await svgBox(page);
  expect(mobile.width).toBeLessThanOrEqual(375);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(SHOTS, "bar-mobile.png") });
  expect(errors).toEqual([]);
});

test("line chart with brush selects a time range", async ({ page }) => {
  const r = await artifact({ format: "csv", text: telemetryCsv() }, "line", {
    encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, series: { field: "site" } },
    interaction: { brush: true },
    options: { showPoints: true },
  });
  const errors = await open(page, r.record.files.html!.path);
  await expect(page.locator("path.line")).toHaveCount(3);
  const overlay = page.locator("svg.d3mcp-root .brush .overlay");
  const b = (await overlay.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const state = await page.evaluate(
    () =>
      (window as unknown as { __d3mcp: { timeRange: [number, number] | null; brushed?: number } }).__d3mcp,
  );
  expect(state.timeRange !== null || (state.brushed ?? 0) > 0).toBe(true);
  const strokes = new Set(
    await page.locator("path.line").evaluateAll((els) => els.map((e) => getComputedStyle(e).stroke)),
  );
  expect(strokes.size).toBe(3);
  await page.screenshot({ path: path.join(SHOTS, "line-brush.png") });
  expect(errors).toEqual([]);
});

test("force graph: geometry, zoom, search, drag", async ({ page }) => {
  const r = await artifact(network, "force", {
    interaction: { zoom: true, search: true, drag: true },
    options: { nodeSizeBy: "degree", showLabels: true, seed: 1 },
  });
  const errors = await open(page, r.record.files.html!.path);
  const nodes = page.locator("circle.node");
  await expect(nodes).toHaveCount(network.nodes.length);
  await expect(page.locator("svg.d3mcp-root .link")).toHaveCount(network.links.length);
  const svg = await svgBox(page);
  for (const bb of await nodes.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
  )) {
    expect(bb.x).toBeGreaterThanOrEqual(svg.x - 1);
    expect(bb.x + bb.width).toBeLessThanOrEqual(svg.x + svg.width + 1);
  }

  const vp = page.locator("svg.d3mcp-root .d3mcp-viewport");
  const before = await vp.getAttribute("transform");
  await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => vp.getAttribute("transform")).not.toBe(before);

  await page.locator("input.d3mcp-search").fill("hub");
  const matches = await page.evaluate(
    () => (window as unknown as { __d3mcp: { searchMatches: number } }).__d3mcp.searchMatches,
  );
  expect(matches).toBeGreaterThanOrEqual(3);
  await expect(page.locator("circle.node.selected")).toHaveCount(3);
  await page.screenshot({ path: path.join(SHOTS, "force.png") });
  expect(errors).toEqual([]);
});

test("topology icons: centred on nodes, follow drag, dim with search", async ({ page }) => {
  const r = await artifact(topology, "force", {
    encoding: { color: { field: "tier" } },
    interaction: { drag: true, search: true },
    options: { tierField: "tier", tierOrder: TIER_ORDER, seed: 3 },
  });
  const errors = await open(page, r.record.files.html!.path);
  const icons = page.locator("g.node-icon");
  await expect(icons).toHaveCount(topology.nodes.length);
  const centre = async (sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width };
  };
  for (const id of ["core-1", "fw-2", "ap-1"]) {
    const c = await centre(`circle.node[data-id="${id}"]`);
    const i = await centre(`g.node-icon[data-id="${id}"]`);
    expect(Math.abs(c.x - i.x)).toBeLessThan(2);
    expect(Math.abs(c.y - i.y)).toBeLessThan(2);
    expect(i.w).toBeGreaterThan(8);
    expect(i.w).toBeLessThan(c.w);
  }

  const node = page.locator('circle.node[data-id="acc-1"]');
  await node.scrollIntoViewIfNeeded();
  const before = await centre('circle.node[data-id="acc-1"]');
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 60, before.y - 40, { steps: 6 });
  await page.mouse.up();
  const after = await centre('circle.node[data-id="acc-1"]');
  expect(after.x - before.x).toBeGreaterThan(40);
  const icon = await centre('g.node-icon[data-id="acc-1"]');
  expect(Math.abs(icon.x - after.x)).toBeLessThan(2);
  expect(Math.abs(icon.y - after.y)).toBeLessThan(2);
  await expect(node).toBeVisible();

  await page.locator("input.d3mcp-search").fill("core");
  await expect(page.locator("g.node-icon.dimmed")).toHaveCount(topology.nodes.length - 2);
  await expect(page.locator('g.node-icon[data-id="core-1"]')).not.toHaveClass(/dimmed/);
  await page.screenshot({ path: path.join(SHOTS, "topology-icons.png") });
  expect(errors).toEqual([]);
});

test("hierarchy: treemap and sunburst geometry", async ({ page }) => {
  for (const type of ["treemap", "sunburst"] as const) {
    const r = await artifact({ format: "hierarchy", root: hierarchy }, type);
    const errors = await open(page, r.record.files.html!.path);
    const sel = type === "treemap" ? "rect.treemap-cell" : "path.sunburst-arc";
    const marks = page.locator(sel);
    expect(await marks.count()).toBe(r.record.markCount);
    const areas = await marks.evaluateAll((els) =>
      els.map((e) => {
        const b = (e as SVGGraphicsElement).getBBox();
        return b.width * b.height;
      }),
    );
    expect(areas.every((a) => a > 0)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, `${type}.png`) });
    expect(errors).toEqual([]);
  }
});

test("geo: projected choropleth paths are inside the viewport", async ({ page }) => {
  const r = await artifact(geo, "geo", {
    encoding: { color: { field: "value" } },
    options: { projection: "mercator" },
  });
  const errors = await open(page, r.record.files.html!.path);
  const paths = page.locator("path.feature");
  await expect(paths).toHaveCount(6);
  const svg = await svgBox(page);
  const boxes = await paths.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
  );
  for (const b of boxes) {
    expect(b.width).toBeGreaterThan(5);
    expect(b.x).toBeGreaterThanOrEqual(svg.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(svg.x + svg.width + 1);
  }
  const fills = new Set(await paths.evaluateAll((els) => els.map((e) => getComputedStyle(e).fill)));
  expect(fills.size).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(SHOTS, "geo.png") });
  expect(errors).toEqual([]);
});

test("dashboard: shared category filter dims non-matching marks across charts", async ({ page }) => {
  const ds = await svc.resolveData(sales, "browser");
  const prof = profileDataset(ds);
  const a = planVisualization({
    dataset: ds,
    profile: prof,
    prompt: "",
    type: "bar",
    options: {
      encoding: { x: { field: "region" }, y: { field: "revenue", aggregate: "sum" } },
      width: 500,
      height: 320,
    },
  }).spec;
  const b = planVisualization({
    dataset: ds,
    profile: prof,
    prompt: "",
    type: "scatter",
    options: {
      encoding: { x: { field: "units" }, y: { field: "revenue" }, color: { field: "region" } },
      width: 500,
      height: 320,
    },
  }).spec;
  const r = await svc.renderDashboard(
    [
      { spec: a, ds },
      { spec: b, ds },
    ],
    { title: "Dash", columns: 2, formats: ["html"], sessionId: "browser" },
  );
  const errors = await open(page, r.record.files.html!.path);
  await expect(page.locator("svg.d3mcp-root")).toHaveCount(2);
  await page.locator("select.d3mcp-filter").selectOption("East");
  const selected = await page.locator("svg.d3mcp-root .mark.selected").count();
  const dimmed = await page.locator("svg.d3mcp-root .mark.dimmed").count();
  expect(selected).toBeGreaterThan(0);
  expect(dimmed).toBeGreaterThan(0);
  const charts = await page
    .locator("svg.d3mcp-root")
    .evaluateAll((svgs) => svgs.map((s) => s.querySelectorAll(".mark.selected").length));
  expect(charts.every((n) => n > 0)).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, "dashboard.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("linked dashboard: clicking a site or region selects it in every chart and lists its records", async ({
  page,
}) => {
  const linkedSvc = new VisualizationService(
    { ...svc.config, dataDirs: [path.resolve("examples", "data-files")] },
    svc.store,
  );
  const inputs = [];
  for (const [label, file] of [
    ["telemetry", "linked/wan-telemetry.csv"],
    ["sites", "linked/sites.xlsx"],
    ["incidents", "linked/incidents.json"],
    ["topology", "linked/wan-topology.yaml"],
    ["regions", "linked/regions.geojson"],
  ] as const) {
    inputs.push({ ds: await linkedSvc.resolveData({ file }, "browser"), label });
  }
  const links = analyzeLinks(inputs.map((i) => ({ ds: i.ds, label: i.label }))).recommended;
  const r = await linkedSvc.autoDashboard(inputs, {
    prompt: "WAN health by site and region: latency and incidents",
    maxCharts: 8,
    kpis: true,
    formats: ["html"],
    sessionId: "browser",
    links,
  });
  const errors = await open(page, r.record.files.html!.path);
  const perChart = () =>
    page
      .locator("svg.d3mcp-root")
      .evaluateAll((svgs) => svgs.map((s) => s.querySelectorAll(".mark.selected").length));
  await expect(page.locator(".d3mcp-details")).toContainText("Click any bar");

  await page.locator('svg.d3mcp-root rect.mark[data-link="lon"]').first().click();
  expect((await perChart()).every((n) => n > 0)).toBe(true);
  await expect(page.locator('circle.node.selected[data-id="LON"]')).toHaveCount(1);
  const panel = page.locator(".d3mcp-details");
  await expect(panel).toContainText("Linked records: LON");
  await expect(panel).toContainText("telemetry — 14 records");
  await expect(panel).toContainText("London");
  await expect(panel.locator("table").first().locator("tbody tr")).toHaveCount(14);

  await page.locator('path.feature.mark[data-key="EMEA"]').click();
  const emea = await page.evaluate(
    () => (window as unknown as { __d3mcp: { linkValues: Record<string, boolean> } }).__d3mcp.linkValues,
  );
  expect(Object.keys(emea).sort()).toEqual(["dxb", "fra", "lon"]);
  await expect(page.locator("svg.d3mcp-root rect.mark.selected[data-link='dxb']").first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "linked-dashboard.png"), fullPage: true });

  await page.locator("button.d3mcp-btn", { hasText: "Reset selection" }).click();
  await expect(page.locator("svg.d3mcp-root .mark.dimmed")).toHaveCount(0);
  await expect(panel).toContainText("Click any bar");
  expect(errors).toEqual([]);
});

test("large scatter uses canvas and draws non-blank pixels", async ({ page }) => {
  const r = await artifact(largeRecords(30_000), "scatter", {
    renderer: "canvas",
    encoding: { x: { field: "x" }, y: { field: "y" }, color: { field: "g" } },
  });
  const errors = await open(page, r.record.files.html!.path);
  const canvas = page.locator("canvas.d3mcp-canvas");
  await expect(canvas).toHaveCount(1);
  const painted = await canvas.evaluate((c) => {
    const el = c as HTMLCanvasElement;
    const data = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(1000);
  expect(
    await page.evaluate(
      () => (window as unknown as { __d3mcp: { canvasPoints: number } }).__d3mcp.canvasPoints,
    ),
  ).toBe(30_000);
  await page.screenshot({ path: path.join(SHOTS, "canvas-scatter.png") });
  expect(errors).toEqual([]);
});

test("PNG export is a valid, non-blank image", async () => {
  const r = await artifact(simpleBars, "bar", {}, ["html", "svg", "png"]);
  expect(r.record.exportErrors.png).toBeUndefined();
  const report = validatePng(readFileSync(r.record.files.png!.path));
  expect(report.errors).toEqual([]);
  expect(report.stats.width).toBeGreaterThanOrEqual(800);
});
