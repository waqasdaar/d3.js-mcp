import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { profileDataset } from "../../src/core/data/profile.js";
import { computeKpis, planDashboardCandidates } from "../../src/core/planning/dashboard.js";
import { computeFindings } from "../../src/core/planning/findings.js";
import { parseSpec } from "../../src/core/schema/spec.js";
import { validateHtml } from "../../src/core/validation/structural.js";
import { geo, network, sales, telemetryCsv, topology } from "../fixtures/data.js";
import { ds, tempService } from "../helpers/render.js";

const telemetry = () => ds({ format: "csv", text: telemetryCsv() });
const plan = (data: ReturnType<typeof ds>, prompt = "", max = 6) =>
  planDashboardCandidates([{ dataset: data, profile: profileDataset(data), prompt }], max);

describe("dashboard planner", () => {
  it("telemetry: one trend per measure, plus other views, no duplicates", () => {
    const top = plan(telemetry(), "SD-WAN health: latency, packet loss and throughput by site").slice(0, 6);
    const trends = top.filter((c) => c.family === "trend");
    expect(trends.map((c) => c.encoding.y?.field).sort()).toEqual([
      "latency_ms",
      "packet_loss_pct",
      "throughput_mbps",
    ]);
    expect(trends.every((c) => c.encoding.series?.field === "site")).toBe(true);
    expect(new Set(top.map((c) => c.family)).size).toBeGreaterThanOrEqual(3);
    const sigs = top.map((c) => `${c.type}|${JSON.stringify(c.encoding)}`);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(top[0]!.family).toBe("trend");
  });

  it("sales: comparison, share, relationship and distribution views, capped per family", () => {
    const top = plan(ds(sales)).slice(0, 6);
    const fam = top.map((c) => c.family);
    expect(fam).toEqual(expect.arrayContaining(["comparison", "share", "relationship", "distribution"]));
    expect(fam.filter((f) => f === "comparison").length).toBeLessThanOrEqual(2);
    expect(fam.filter((f) => f === "share").length).toBeLessThanOrEqual(1);
  });

  it("prompt keywords steer the selection", () => {
    const top = plan(ds(sales), "show the distribution and outliers of revenue", 3).slice(0, 3);
    expect(top.some((c) => c.family === "distribution")).toBe(true);
    const plain = plan(ds(sales), "", 3).slice(0, 3);
    expect(plain.some((c) => c.family === "distribution")).toBe(false);
  });

  it("every dataset gets at least one chart in multi-dataset dashboards", () => {
    const inputs = [ds(sales), ds(network), ds(geo)].map((d) => ({
      dataset: d,
      profile: profileDataset(d),
      prompt: "",
    }));
    const top = planDashboardCandidates(inputs, 4).slice(0, 4);
    expect(new Set(top.map((c) => c.datasetIndex))).toEqual(new Set([0, 1, 2]));
    expect(top.find((c) => c.datasetIndex === 1)!.family).toBe("network");
    expect(top.find((c) => c.datasetIndex === 2)!.family).toBe("geo");
  });
});

describe("analytical soundness (found in visual review)", () => {
  it("averages non-additive measures such as latency instead of summing them", () => {
    const top = plan(telemetry());
    const bars = top.filter((c) => c.type === "bar");
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) {
      const f = b.encoding.y!.field;
      expect(b.encoding.y!.aggregate, f).toBe(/throughput|latency|loss/.test(f) ? "mean" : "sum");
    }
    expect(top.some((c) => c.family === "share")).toBe(false);
  });

  it("still sums additive measures and offers share charts for them", () => {
    const top = plan(ds(sales));
    expect(top.find((c) => c.type === "bar")!.encoding.y).toMatchObject({
      field: "revenue",
      aggregate: "sum",
    });
    expect(top.some((c) => c.family === "share")).toBe(true);
  });

  it("does not pick trend charts for series with fewer than 4 points", () => {
    const sparse = ds([
      { date: "2026-10-01", site: "SJC", latency_ms: 21 },
      { date: "2026-10-02", site: "SJC", latency_ms: 23 },
      { date: "2026-10-03", site: "NYC", latency_ms: 48 },
    ]);
    expect(
      plan(sparse)
        .slice(0, 6)
        .some((c) => c.family === "trend"),
    ).toBe(false);
  });

  it("balances KPI tiles across datasets and derives the title from the goal", async () => {
    const svc = tempService();
    const inputs = await Promise.all(
      [sales, sales, sales].map(async (d, i) => ({ ds: await svc.resolveData(d, "auto"), label: `S${i}` })),
    );
    const r = await svc.autoDashboard(inputs, {
      prompt: "Regional sales review. Focus on revenue.",
      maxCharts: 3,
      kpis: true,
      formats: ["html"],
      sessionId: "auto",
    });
    for (const l of ["S0", "S1", "S2"])
      expect(r.kpis.filter((k) => k.label.startsWith(`${l} · `)).length).toBe(4);
    expect(r.record.title).toBe("Regional sales review.");
    await svc.close();
  });
});

describe("small-sample honesty", () => {
  const tiny = [
    { site: "SJC", latency_ms: 21.5, loss_pct: 0.2 },
    { site: "SJC", latency_ms: 23.1, loss_pct: 0.3 },
    { site: "NYC", latency_ms: 48, loss_pct: 0.9 },
  ];

  it("does not report a correlation coefficient for fewer than 10 pairs", () => {
    const d = ds(tiny);
    const spec = parseSpec({
      id: "t",
      type: "scatter",
      data: { datasetId: d.id },
      encoding: { x: { field: "latency_ms" }, y: { field: "loss_pct" } },
    });
    const f = computeFindings(spec, d).join(" ");
    expect(f).not.toMatch(/r = /);
    expect(f).toMatch(/Only 3 paired values .* too few to assess correlation/);
    expect(profileDataset(d).correlations).toEqual([]);
  });

  it("does not choose scatterplots for fewer than 5 rows", () => {
    expect(
      plan(ds(tiny), "", 4)
        .slice(0, 4)
        .some((c) => c.family === "relationship"),
    ).toBe(false);
  });

  it("does not double the word 'total' in KPI labels", () => {
    const d = ds([
      { region: "N", total: 330 },
      { region: "E", total: 380 },
    ]);
    expect(computeKpis(d, profileDataset(d), "").map((k) => k.label)).toContain("total");
  });
});

describe("KPIs", () => {
  it("totals for additive fields, averages otherwise, plus time span and categories", () => {
    const k = computeKpis(ds(sales), profileDataset(ds(sales)), "");
    expect(k[0]).toEqual({ label: "records", value: "12" });
    expect(k.find((x) => x.label === "total revenue")!.value).toBe(
      String(sales.reduce((s, r) => s + r.revenue, 0)).replace(/\B(?=(\d{3})+$)/g, ","),
    );
    expect(k.find((x) => x.label === "total units")).toBeDefined();
    const t = telemetry();
    const kt = computeKpis(t, profileDataset(t), "");
    expect(kt.find((x) => x.label === "avg latency_ms")!.detail).toMatch(/^min .* · max /);
    expect(kt.find((x) => x.label === "timestamp range")!.value).toBe("Oct 1, 2026 – Oct 2, 2026");
    expect(kt.find((x) => x.label === "site values")!.value).toBe("3");
  });

  it("graph KPIs count nodes and links", () => {
    const g = ds(topology);
    expect(computeKpis(g, profileDataset(g), "")[0]).toEqual({
      label: "nodes",
      value: String(topology.nodes.length),
      detail: `${topology.links.length} links`,
    });
  });
});

describe("autoDashboard (service)", () => {
  it("renders a validated dashboard with KPI tiles, charts and a shared time brush", async () => {
    const svc = tempService();
    const t = await svc.resolveData({ format: "csv", text: telemetryCsv() }, "auto");
    const r = await svc.autoDashboard([{ ds: t }], {
      prompt: "SD-WAN health by site",
      maxCharts: 5,
      kpis: true,
      formats: ["html"],
      sessionId: "auto",
    });
    expect(r.plan).toHaveLength(5);
    expect(r.sharedTimeBrush).toBe(true);
    const html = readFileSync(r.record.files.html!.path, "utf8");
    expect(validateHtml(html).errors).toEqual([]);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelectorAll("svg.d3mcp-root")).toHaveLength(5);
    expect(doc.querySelectorAll(".d3mcp-kpi").length).toBe(r.kpis.length);
    expect(doc.querySelector(".d3mcp-kpi .l")!.textContent).toBe("records");
    expect(doc.querySelectorAll('svg.d3mcp-root[data-brush="true"]').length).toBeGreaterThanOrEqual(2);
    await svc.close();
  });

  it("labels charts and KPIs per dataset and escapes hostile field names", async () => {
    const svc = tempService();
    const evil = await svc.resolveData(
      [
        { "<img src=x onerror=alert(1)>": 5, cat: "a" },
        { "<img src=x onerror=alert(1)>": 7, cat: "b" },
      ],
      "auto",
    );
    const s = await svc.resolveData(sales, "auto");
    const r = await svc.autoDashboard(
      [
        { ds: s, label: "Sales" },
        { ds: evil, label: "Odd" },
      ],
      { prompt: "", maxCharts: 4, kpis: true, formats: ["html"], sessionId: "auto" },
    );
    expect(new Set(r.plan.map((p) => p.dataset))).toEqual(new Set(["Sales", "Odd"]));
    expect(r.plan.every((p) => p.title!.startsWith(`${p.dataset} · `))).toBe(true);
    const html = readFileSync(r.record.files.html!.path, "utf8");
    expect(html).not.toContain("<img src=x");
    expect(validateHtml(html).errors).toEqual([]);
    await svc.close();
  });

  it("reports why no chart could be built instead of producing an empty dashboard", async () => {
    const svc = tempService();
    const d = await svc.resolveData(sales, "auto");
    await expect(
      svc.autoDashboard([{ ds: d }], {
        prompt: "",
        maxCharts: 3,
        kpis: false,
        formats: ["html"],
        sessionId: "auto",
        chartOptions: { encoding: { x: { field: "missing" } } },
      }),
    ).rejects.toThrow(/No chart could be built/);
    await svc.close();
  });
});
