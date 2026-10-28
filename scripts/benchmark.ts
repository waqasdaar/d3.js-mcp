/** Measure end-to-end render time (ingest → plan → SVG/HTML artifact) for representative dataset sizes. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomLcg } from "d3";
import { ArtifactStore } from "../src/core/artifacts/store.js";
import { profileDataset } from "../src/core/data/profile.js";
import { planVisualization, type PlanOptions } from "../src/core/planning/planner.js";
import type { VisType } from "../src/core/schema/spec.js";
import { VisualizationService } from "../src/core/service.js";
import { loadConfig, PACKAGE_ROOT } from "../src/shared/config.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "d3mcp-bench-"));
const config = { ...loadConfig({ D3MCP_LOG_LEVEL: "error" }), artifactDir: tmp };
const svc = new VisualizationService(config, new ArtifactStore(tmp, 1));
const rng = randomLcg(1);

const points = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: rng() * 100, y: rng() * 100, g: `g${i % 5}` }));
const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    v: Math.sin(i / 50) * 10 + rng(),
    s: `s${i % 4}`,
  }));
function graph(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, group: `g${i % 6}` }));
  const links = Array.from({ length: n * 2 }, (_, i) => ({
    source: `n${i % n}`,
    target: `n${Math.floor(rng() * n)}`,
  })).filter((l) => l.source !== l.target);
  return { nodes, links };
}
function tree(leaves: number) {
  const children = Array.from({ length: Math.ceil(leaves / 50) }, (_, i) => ({
    name: `b${i}`,
    children: Array.from({ length: 50 }, (_, j) => ({
      name: `b${i}-${j}`,
      value: 1 + Math.floor(rng() * 100),
    })),
  }));
  return { format: "hierarchy", root: { name: "root", children } };
}

const cases: Array<{ name: string; type: VisType; rows: number; data: unknown; options?: PlanOptions }> = [
  {
    name: "bar 50 categories",
    type: "bar",
    rows: 50,
    data: Array.from({ length: 50 }, (_, i) => ({ c: `c${i}`, v: rng() * 100 })),
  },
  {
    name: "line 10k points / 4 series",
    type: "line",
    rows: 10_000,
    data: series(10_000),
    options: { encoding: { x: { field: "t" }, y: { field: "v" }, series: { field: "s" } } },
  },
  { name: "scatter 1k (SVG)", type: "scatter", rows: 1_000, data: points(1_000) },
  { name: "scatter 10k (SVG)", type: "scatter", rows: 10_000, data: points(10_000) },
  {
    name: "scatter 50k (canvas)",
    type: "scatter",
    rows: 50_000,
    data: points(50_000),
    options: { renderer: "canvas" },
  },
  {
    name: "histogram 50k",
    type: "histogram",
    rows: 50_000,
    data: points(50_000),
    options: { encoding: { x: { field: "x" } } },
  },
  { name: "force 500 nodes / ~1k links", type: "force", rows: 500, data: graph(500) },
  { name: "force 2k nodes / ~4k links", type: "force", rows: 2_000, data: graph(2_000) },
  { name: "treemap 5k leaves", type: "treemap", rows: 5_000, data: tree(5_000) },
  {
    name: "contour 20k points",
    type: "contour",
    rows: 20_000,
    data: points(20_000),
    options: { encoding: { x: { field: "x" }, y: { field: "y" } } },
  },
];

const results = [];
for (const c of cases) {
  const t0 = performance.now();
  try {
    const ds = await svc.resolveData(c.data, "bench");
    const plan = planVisualization({
      dataset: ds,
      profile: profileDataset(ds),
      prompt: "",
      type: c.type,
      ...(c.options ? { options: c.options } : {}),
    });
    const r = await svc.renderArtifact(plan.spec, ds, { formats: ["html", "svg"], sessionId: "bench" });
    const ms = Math.round(performance.now() - t0);
    results.push({
      case: c.name,
      rows: c.rows,
      ok: true,
      ms,
      marks: r.record.markCount,
      renderer: plan.spec.renderer,
      htmlBytes: r.record.files.html!.bytes,
      warnings: r.record.warnings,
    });
  } catch (e) {
    results.push({
      case: c.name,
      rows: c.rows,
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: (e as Error).message,
    });
  }
  const last = results.at(-1)!;
  process.stderr.write(
    `${last.ok ? "ok  " : "FAIL"} ${c.name.padEnd(30)} ${String(last.ms).padStart(6)} ms${"htmlBytes" in last ? `  ${(Number(last.htmlBytes) / 1e6).toFixed(2)} MB HTML` : ` ${"error" in last ? last.error : ""}`}\n`,
  );
}

mkdirSync(path.join(PACKAGE_ROOT, "reports"), { recursive: true });
writeFileSync(
  path.join(PACKAGE_ROOT, "reports", "benchmark.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model,
      note: "Single run, wall-clock, includes ingest, profiling, planning, SVG render, validation and file writes. Not a capacity guarantee.",
      results,
    },
    null,
    2,
  ) + "\n",
);
