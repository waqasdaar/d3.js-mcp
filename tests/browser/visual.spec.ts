import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { profileDataset } from "../../src/core/data/profile.js";
import { planVisualization, type PlanOptions } from "../../src/core/planning/planner.js";
import type { VisType } from "../../src/core/schema/spec.js";
import { closeBrowser } from "../../src/export/browser.js";
import {
  customSvgIcon,
  flows,
  geo,
  hierarchy,
  network,
  sales,
  scatterPoints,
  simpleBars,
  telemetryCsv,
  TIER_ORDER,
  topology,
} from "../fixtures/data.js";
import { tempService } from "../helpers/render.js";

/**
 * Pixel-comparison regression tests. Baselines live in tests/browser/__screenshots__/<platform>/.
 * Update intentionally with: npm run test:visual:update
 */
const svc = tempService();
const telemetry = { format: "csv", text: telemetryCsv() };
const BASELINES = path.resolve("tests", "browser", "__screenshots__", process.platform);

// Playwright requires an object pattern for the fixtures argument.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  const updating = info.config.updateSnapshots === "all" || info.config.updateSnapshots === "changed";
  test.skip(
    !updating && !existsSync(BASELINES),
    `No visual baselines for ${process.platform}; create them with npm run test:visual:update`,
  );
});

async function chartHtml(data: unknown, type: VisType, options: PlanOptions = {}): Promise<string> {
  const ds = await svc.resolveData(data, "visual");
  const plan = planVisualization({
    dataset: ds,
    profile: profileDataset(ds),
    prompt: "",
    type,
    title: `Visual ${type}`,
    options: { width: 800, height: 500, ...options },
  });
  const r = await svc.renderArtifact(plan.spec, ds, { formats: ["html"], sessionId: "visual" });
  return r.record.files.html!.path;
}

async function open(page: Page, file: string): Promise<void> {
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(
    () => (window as unknown as { __d3mcp?: { ready: boolean } }).__d3mcp?.ready === true,
  );
  await page.evaluate(() => document.fonts.ready);
}

test.afterAll(async () => {
  await svc.close();
  await closeBrowser();
});

const CASES: Array<{ name: string; data: unknown; type: VisType; options?: PlanOptions }> = [
  {
    name: "bar",
    data: simpleBars,
    type: "bar",
    options: { encoding: { x: { field: "category" }, y: { field: "value" } } },
  },
  {
    name: "bar-dark-annotated",
    data: simpleBars,
    type: "bar",
    options: {
      theme: "dark",
      encoding: { x: { field: "category" }, y: { field: "value" } },
      annotations: [{ type: "rule", axis: "y", value: 50, label: "Target 50" }],
    },
  },
  {
    name: "grouped-bar",
    data: sales,
    type: "grouped-bar",
    options: { encoding: { x: { field: "region" }, y: { field: "revenue" }, series: { field: "product" } } },
  },
  {
    name: "line-multi",
    data: telemetry,
    type: "line",
    options: {
      encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, series: { field: "site" } },
    },
  },
  {
    name: "scatter",
    data: scatterPoints(150),
    type: "scatter",
    options: { encoding: { x: { field: "x" }, y: { field: "y" }, color: { field: "cluster" } } },
  },
  {
    name: "heatmap",
    data: sales,
    type: "heatmap",
    options: { encoding: { x: { field: "region" }, y: { field: "product" }, color: { field: "revenue" } } },
  },
  {
    name: "pie",
    data: simpleBars,
    type: "donut",
    options: { encoding: { color: { field: "category" }, value: { field: "value" } } },
  },
  { name: "treemap", data: { format: "hierarchy", root: hierarchy }, type: "treemap" },
  { name: "sunburst", data: { format: "hierarchy", root: hierarchy }, type: "sunburst" },
  {
    name: "force",
    data: network,
    type: "force",
    options: { options: { seed: 7, nodeSizeBy: "degree", showLabels: true } },
  },
  { name: "sankey", data: flows, type: "sankey" },
  {
    name: "topology-icons-tiered",
    data: topology,
    type: "force",
    options: {
      encoding: { color: { field: "tier" } },
      options: { seed: 3, tierField: "tier", tierOrder: TIER_ORDER, nodeSizeBy: "constant" },
    },
  },
  {
    name: "topology-custom-icons",
    data: {
      nodes: topology.nodes.map((n) => (n.id === "db-1" ? { ...n, type: "nic" } : n)),
      links: topology.links,
    },
    type: "force",
    options: {
      encoding: { color: { field: "site" } },
      options: {
        seed: 3,
        iconStyle: "plain",
        nodeSizeBy: "constant",
        icons: { nic: { svg: customSvgIcon } },
      },
    },
  },
  {
    name: "geo-choropleth",
    data: geo,
    type: "geo",
    options: { encoding: { color: { field: "value" } }, options: { projection: "mercator" } },
  },
];

for (const c of CASES) {
  test(`visual: ${c.name}`, async ({ page }) => {
    await open(page, await chartHtml(c.data, c.type, c.options));
    await expect(page.locator("svg.d3mcp-root")).toHaveScreenshot(`${c.name}.png`);
  });
}

test("visual: dashboard (full page)", async ({ page }) => {
  const ds = await svc.resolveData(sales, "visual");
  const prof = profileDataset(ds);
  const mk = (type: VisType, options: PlanOptions) =>
    planVisualization({
      dataset: ds,
      profile: prof,
      prompt: "",
      type,
      options: { width: 560, height: 340, ...options },
    }).spec;
  const r = await svc.renderDashboard(
    [
      {
        spec: mk("bar", { encoding: { x: { field: "region" }, y: { field: "revenue", aggregate: "sum" } } }),
        ds,
      },
      {
        spec: mk("scatter", {
          encoding: { x: { field: "units" }, y: { field: "revenue" }, color: { field: "region" } },
        }),
        ds,
      },
    ],
    { title: "Visual dashboard", columns: 2, formats: ["html"], sessionId: "visual" },
  );
  await open(page, r.record.files.html!.path);
  await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true });
});

test("visual comparison detects a single changed bar", async ({ page }, info) => {
  test.skip(
    info.config.updateSnapshots === "all" || info.config.updateSnapshots === "changed",
    "would overwrite the bar baseline",
  );
  const changed = simpleBars.map((d) => (d.category === "C" ? { ...d, value: 52 } : d));
  await open(
    page,
    await chartHtml(changed, "bar", { encoding: { x: { field: "category" }, y: { field: "value" } } }),
  );
  await expect(
    expect(page.locator("svg.d3mcp-root")).toHaveScreenshot("bar.png", { timeout: 2_000 }),
  ).rejects.toThrow(/pixels|different/i);
});
