/**
 * Real MCP smoke test: starts dist/server/index.js over stdio, drives it with the official SDK client,
 * verifies generated files and opens the HTML in Chromium. Writes reports/smoke-report.json.
 * Exit code is non-zero if any mandatory check fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { PACKAGE_ROOT } from "../src/shared/config.js";

interface Check {
  name: string;
  mandatory: boolean;
  passed: boolean | null;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, mandatory: boolean, passed: boolean | null, detail: string): boolean {
  checks.push({ name, mandatory, passed, detail });
  process.stderr.write(
    `${passed === null ? "SKIP" : passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`,
  );
  return passed === true;
}

const DATA = [
  { site: "SJC", tickets: 42 },
  { site: "NYC", tickets: 31 },
  { site: "LON", tickets: 57 },
  { site: "TYO", tickets: 18 },
];

async function main(): Promise<number> {
  const server = path.join(PACKAGE_ROOT, "dist", "server", "index.js");
  if (!record("server build exists", true, existsSync(server), server)) return finish();
  const artifactDir = process.env.D3MCP_ARTIFACT_DIR ?? mkdtempSync(path.join(os.tmpdir(), "d3mcp-smoke-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: {
      ...(process.env as Record<string, string>),
      D3MCP_ARTIFACT_DIR: artifactDir,
      D3MCP_LOG_LEVEL: "warn",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "d3mcp-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    record(
      "connect + initialize",
      true,
      true,
      `${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`,
    );
    const { tools } = await client.listTools();
    record("enumerate tools", true, tools.length >= 17, `${tools.length} tools`);

    const res = (await client.callTool({
      name: "d3_visualize",
      arguments: {
        data: DATA,
        prompt: "Compare tickets by site",
        visualization_type: "bar",
        title: "Tickets by site",
        output_formats: ["html", "svg", "png"],
      },
    })) as CallToolResult;
    const out = res.structuredContent as {
      ok: boolean;
      spec?: unknown;
      artifact_id?: string;
      files?: Record<string, { path: string; bytes: number }>;
      export_errors?: Record<string, string>;
    };
    if (
      !record(
        "d3_visualize bar chart",
        true,
        !res.isError && out.ok,
        res.isError ? JSON.stringify(res.content).slice(0, 300) : String(out.artifact_id),
      )
    )
      return finish(client);
    record("specification returned", true, !!out.spec, "");
    for (const f of ["html", "svg"]) {
      const file = out.files?.[f];
      record(
        `${f} file exists and is non-empty`,
        true,
        !!file && existsSync(file.path) && statSync(file.path).size > 0,
        file?.path ?? "missing",
      );
    }
    const svg = readFileSync(out.files!.svg!.path, "utf8");
    record("SVG contains 4 bars", true, (svg.match(/<rect[^>]*class="bar[ "]/g) ?? []).length === 4, "");

    let browser;
    try {
      browser = await chromium.launch();
    } catch (e) {
      record(
        "open HTML in Chromium",
        false,
        null,
        `Chromium unavailable: ${(e as Error).message.split("\n")[0]} (run: npx playwright install chromium)`,
      );
    }
    if (browser) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(pathToFileURL(out.files!.html!.path).href);
      await page.waitForFunction(
        () => (window as unknown as { __d3mcp?: { ready: boolean } }).__d3mcp?.ready === true,
        undefined,
        { timeout: 15_000 },
      );
      const bars = await page.locator("rect.bar").count();
      record("browser renders 4 bars", true, bars === 4, `${bars} bars`);
      record("no page errors", true, errors.length === 0, errors.join("; "));
      await browser.close();
      const png = out.files?.png;
      const pngOk = !!png && readFileSync(png.path).subarray(1, 4).toString() === "PNG" && png.bytes > 1000;
      record("PNG export", false, pngOk, png?.path ?? out.export_errors?.png ?? "not produced");
    }

    const bad = (await client.callTool({
      name: "d3_visualize",
      arguments: { data: [], prompt: "x" },
    })) as CallToolResult;
    record("invalid input returns isError (no false success)", true, bad.isError === true, "");
  } catch (e) {
    record("smoke run", true, false, (e as Error).message);
  }
  return finish(client);
}

async function finish(client?: Client): Promise<number> {
  await client?.close().catch(() => undefined);
  const failed = checks.filter((c) => c.mandatory && c.passed !== true);
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    overall: failed.length ? "failed" : "passed",
    checks,
  };
  mkdirSync(path.join(PACKAGE_ROOT, "reports"), { recursive: true });
  writeFileSync(
    path.join(PACKAGE_ROOT, "reports", "smoke-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
