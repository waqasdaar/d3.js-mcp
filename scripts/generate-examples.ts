/** Generate the example gallery in examples/<name>/ (input data + HTML/SVG/PNG/spec outputs) through the real service. */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/core/artifacts/store.js";
import { analyzeLinks } from "../src/core/data/link.js";
import { profileDataset } from "../src/core/data/profile.js";
import { planVisualization, type PlanOptions } from "../src/core/planning/planner.js";
import type { VisType } from "../src/core/schema/spec.js";
import { VisualizationService } from "../src/core/service.js";
import type { ArtifactRecord } from "../src/core/artifacts/store.js";
import { closeBrowser } from "../src/export/browser.js";
import { loadConfig, PACKAGE_ROOT } from "../src/shared/config.js";
import {
  cities,
  customSvgIcon,
  geo,
  hierarchy,
  network,
  sales,
  telemetryCsv,
  TIER_ORDER,
  topology,
} from "../tests/fixtures/data.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "d3mcp-examples-"));
const config = {
  ...loadConfig({ D3MCP_LOG_LEVEL: "error" }),
  artifactDir: tmp,
  dataDirs: [path.join(PACKAGE_ROOT, "examples", "data-files")],
};
const svc = new VisualizationService(config, new ArtifactStore(tmp, config.ttlHours));
const EXAMPLES = path.join(PACKAGE_ROOT, "examples");

interface Example {
  name: string;
  prompt: string;
  data: unknown;
  type?: VisType;
  options?: PlanOptions;
}

const telemetry = { format: "csv", text: telemetryCsv() };
const examples: Example[] = [
  {
    name: "bar-chart",
    prompt: "Compare total revenue by region; highlight the top region",
    data: sales,
    type: "bar",
    options: { encoding: { x: { field: "region" }, y: { field: "revenue", aggregate: "sum" } } },
  },
  {
    name: "time-series",
    prompt: "Show latency over time for each site with an SLA line at 150 ms",
    data: telemetry,
    type: "line",
    options: {
      encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, series: { field: "site" } },
      annotations: [{ type: "rule", axis: "y", value: 150, label: "SLA 150 ms" }],
      interaction: { brush: true },
    },
  },
  {
    name: "network-graph",
    prompt: "Force-directed network colored by group, sized by degree, with search, zoom and drag",
    data: network,
    type: "force",
    options: {
      interaction: { zoom: true, search: true, drag: true },
      options: { nodeSizeBy: "degree", showLabels: true, seed: 7 },
    },
  },
  {
    name: "topology-icons",
    prompt:
      "Three-tier network topology with device icons, layered from WAN to endpoints; enable zoom, drag and search",
    data: topology,
    type: "force",
    options: {
      encoding: { color: { field: "tier" } },
      interaction: { zoom: true, drag: true, search: true },
      options: {
        tierField: "tier",
        tierOrder: TIER_ORDER,
        nodeSizeBy: "constant",
        linkDistance: 60,
        seed: 3,
      },
    },
  },
  {
    name: "topology-custom-icons",
    prompt: "Topology using custom icons: a path icon for Kubernetes and an SVG icon for the NIC",
    data: {
      nodes: topology.nodes.map((n) => ({
        ...n,
        icon: n.id === "srv-1" ? "k8s" : n.id === "db-1" ? "nic" : n.type,
      })),
      links: topology.links,
    },
    type: "force",
    options: {
      encoding: { color: { field: "site" } },
      options: {
        seed: 3,
        nodeSizeBy: "constant",
        iconStyle: "plain",
        icons: {
          k8s: {
            viewBox: [0, 0, 100, 100],
            paths: [
              { d: "M50 5L90 27v46L50 95 10 73V27z", fill: "#326ce5" },
              {
                d: "M50 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40z",
                fill: "none",
                stroke: "white",
                strokeWidth: 8,
              },
            ],
          },
          nic: { svg: customSvgIcon },
        },
      },
    },
  },
  {
    name: "hierarchy",
    prompt: "Treemap of site capacity by region",
    data: { format: "hierarchy", root: hierarchy },
    type: "treemap",
  },
  {
    name: "hierarchy-sunburst",
    prompt: "Sunburst of site capacity by region",
    data: { format: "hierarchy", root: hierarchy },
    type: "sunburst",
  },
  {
    name: "geographic-map",
    prompt: "Choropleth of value by area",
    data: geo,
    type: "geo",
    options: {
      encoding: { color: { field: "value" } },
      options: { projection: "mercator", graticule: true },
    },
  },
  {
    name: "geographic-points",
    prompt: "Users by city on a world map",
    data: cities,
    type: "geo",
    options: {
      encoding: {
        latitude: { field: "lat" },
        longitude: { field: "lon" },
        size: { field: "users" },
        label: { field: "city" },
      },
      options: { projection: "naturalEarth1", graticule: true },
    },
  },
];

function copyOut(rec: ArtifactRecord, dir: string): string[] {
  const out: string[] = [];
  for (const f of Object.values(rec.files)) {
    const target = path.join(dir, path.basename(f!.path));
    copyFileSync(f!.path, target);
    out.push(path.relative(PACKAGE_ROOT, target));
  }
  return out;
}

const index: Array<Record<string, unknown>> = [];
for (const ex of examples) {
  const dir = path.join(EXAMPLES, ex.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify(
      {
        tool: "d3_visualize",
        arguments: {
          data: ex.data,
          prompt: ex.prompt,
          ...(ex.type ? { visualization_type: ex.type } : {}),
          ...(ex.options ? { options: ex.options } : {}),
          output_formats: ["html", "svg", "png"],
        },
      },
      null,
      2,
    ) + "\n",
  );
  const ds = await svc.resolveData(ex.data, "examples");
  const plan = planVisualization({
    dataset: ds,
    profile: profileDataset(ds),
    prompt: ex.prompt,
    ...(ex.type ? { type: ex.type } : {}),
    ...(ex.options ? { options: ex.options } : {}),
  });
  const r = await svc.renderArtifact(plan.spec, ds, {
    formats: ["html", "svg", "png"],
    sessionId: "examples",
  });
  const files = copyOut(r.record, dir);
  index.push({
    name: ex.name,
    type: plan.chosenType,
    marks: r.record.markCount,
    files,
    exportErrors: r.record.exportErrors,
    findings: r.findings,
  });
  process.stderr.write(
    `${ex.name}: ${plan.chosenType}, ${r.record.markCount} marks, ${files.length} files${Object.keys(r.record.exportErrors).length ? ` (export errors: ${JSON.stringify(r.record.exportErrors)})` : ""}\n`,
  );
}

const dashDir = path.join(EXAMPLES, "dashboard");
mkdirSync(dashDir, { recursive: true });
const tds = await svc.resolveData(telemetry, "examples");
const gds = await svc.resolveData(network, "examples");
const tp = profileDataset(tds);
const mk = (type: VisType, y: string, extra: PlanOptions = {}) =>
  planVisualization({
    dataset: tds,
    profile: tp,
    prompt: `${y} over time`,
    type,
    options: {
      width: 560,
      height: 340,
      encoding: { x: { field: "timestamp" }, y: { field: y }, series: { field: "site" } },
      interaction: { brush: true },
      ...extra,
    },
  }).spec;
const charts = [
  { spec: mk("line", "latency_ms"), ds: tds },
  { spec: mk("line", "packet_loss_pct"), ds: tds },
  { spec: mk("line", "throughput_mbps"), ds: tds },
  {
    spec: planVisualization({
      dataset: gds,
      profile: profileDataset(gds),
      prompt: "site topology",
      type: "force",
      options: { width: 560, height: 340, options: { nodeSizeBy: "degree", seed: 7 } },
    }).spec,
    ds: gds,
  },
];
writeFileSync(
  path.join(dashDir, "request.json"),
  JSON.stringify(
    {
      tool: "d3_compose_visualizations",
      note: "Generated through the service API; see tests/integration/mcp.test.ts for the equivalent MCP call.",
    },
    null,
    2,
  ) + "\n",
);
const dash = await svc.renderDashboard(charts, {
  title: "SD-WAN health dashboard",
  description:
    "Latency, packet loss and throughput per site with a shared time brush, plus the site topology.",
  columns: 2,
  formats: ["html", "png"],
  sessionId: "examples",
});
index.push({
  name: "dashboard",
  type: "dashboard",
  marks: dash.record.markCount,
  files: copyOut(dash.record, dashDir),
  exportErrors: dash.record.exportErrors,
  findings: dash.findings,
});

const fileCharts: Array<{
  data: Record<string, unknown>;
  type: VisType;
  title: string;
  options: PlanOptions;
}> = [
  {
    data: { file: "workbook.xlsx", sheet: "Totals" },
    type: "bar",
    title: "Excel (.xlsx) · Totals sheet",
    options: { encoding: { x: { field: "region" }, y: { field: "total" } } },
  },
  {
    data: { file: "workbook.xlsx", sheet: "KPIs" },
    type: "line",
    title: "Excel (.xlsx) · KPIs sheet (dates)",
    options: {
      encoding: { x: { field: "date" }, y: { field: "latency_ms" }, series: { field: "site" } },
      options: { showPoints: true },
    },
  },
  {
    data: { file: "workbook.ods" },
    type: "grouped-bar",
    title: "OpenDocument (.ods)",
    options: { encoding: { x: { field: "region" }, y: { field: "revenue" }, series: { field: "product" } } },
  },
  {
    data: { file: "sales.yaml" },
    type: "donut",
    title: "YAML",
    options: { encoding: { color: { field: "product" }, value: { field: "units" } } },
  },
  {
    data: { file: "sales.jsonl" },
    type: "scatter",
    title: "JSON Lines",
    options: { encoding: { x: { field: "units" }, y: { field: "revenue" }, color: { field: "region" } } },
  },
  {
    data: { file: "sales-semicolon.csv" },
    type: "bar",
    title: "CSV with ; and decimal commas",
    options: { encoding: { x: { field: "region" }, y: { field: "revenue_eur" } } },
  },
  {
    data: { file: "regions.topojson" },
    type: "geo",
    title: "TopoJSON",
    options: { encoding: { color: { field: "value" } } },
  },
  {
    data: { file: "topology.yaml" },
    type: "force",
    title: "YAML graph with icons",
    options: { encoding: { color: { field: "tier" } }, options: { seed: 3, nodeSizeBy: "constant" } },
  },
];
const fileItems = [];
for (const c of fileCharts) {
  const ds = await svc.resolveData(c.data, "examples");
  fileItems.push({
    ds,
    spec: planVisualization({
      dataset: ds,
      profile: profileDataset(ds),
      prompt: "",
      type: c.type,
      title: c.title,
      options: { width: 560, height: 340, ...c.options },
    }).spec,
  });
}
const fileDir = path.join(EXAMPLES, "dashboard-from-files");
mkdirSync(fileDir, { recursive: true });
writeFileSync(
  path.join(fileDir, "request.json"),
  JSON.stringify(
    {
      tool: "d3_compose_visualizations",
      arguments: {
        title: "One dashboard, every input format",
        columns: 2,
        charts: fileCharts.map((c) => ({
          data: c.data,
          visualization_type: c.type,
          title: c.title,
          options: c.options,
        })),
      },
      env: { D3MCP_DATA_DIRS: "<project>/examples/data-files" },
    },
    null,
    2,
  ) + "\n",
);
const fileDash = await svc.renderDashboard(fileItems, {
  title: "One dashboard, every input format",
  description: "Each chart reads a different file from examples/data-files.",
  columns: 2,
  formats: ["html", "png"],
  sessionId: "examples",
});
index.push({
  name: "dashboard-from-files",
  type: "dashboard",
  marks: fileDash.record.markCount,
  files: copyOut(fileDash.record, fileDir),
  exportErrors: fileDash.record.exportErrors,
  findings: fileDash.findings,
});

for (const auto of [
  {
    name: "auto-dashboard",
    args: {
      data: { file: "telemetry.csv" },
      prompt: "SD-WAN health by site: latency, packet loss and throughput",
    },
    inputs: [{ data: { file: "telemetry.csv" } }],
  },
  {
    name: "auto-dashboard-excel",
    args: { data: { file: "workbook.xlsx" }, split_sheets: true, prompt: "Workbook overview" },
    inputs: ["Sales", "KPIs", "Totals"].map((sheet) => ({
      data: { file: "workbook.xlsx", sheet },
      label: sheet,
    })),
  },
]) {
  const dir = path.join(EXAMPLES, auto.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify(
      {
        tool: "d3_create_dashboard",
        arguments: auto.args,
        env: { D3MCP_DATA_DIRS: "<project>/examples/data-files" },
      },
      null,
      2,
    ) + "\n",
  );
  const inputs = [];
  for (const i of auto.inputs)
    inputs.push({
      ds: await svc.resolveData(i.data, "examples"),
      ...("label" in i ? { label: i.label } : {}),
    });
  const r = await svc.autoDashboard(inputs, {
    prompt: auto.args.prompt,
    maxCharts: 6,
    kpis: true,
    formats: ["html", "png"],
    sessionId: "examples",
  });
  index.push({
    name: auto.name,
    type: "dashboard",
    marks: r.record.markCount,
    files: copyOut(r.record, dir),
    exportErrors: r.record.exportErrors,
    findings: r.findings,
    charts: r.plan.map((p) => `${p.dataset}: ${p.type}`),
  });
  process.stderr.write(`${auto.name}: ${r.plan.map((p) => p.type).join(", ")}; ${r.kpis.length} KPIs\n`);
}

// Five files in five formats, linked by site code and region (links inferred exactly as d3_create_dashboard does).
{
  const datasets = [
    { data: { file: "linked/wan-telemetry.csv" }, label: "telemetry" },
    { data: { file: "linked/sites.xlsx" }, label: "sites" },
    {
      data: { file: "linked/incidents.json" },
      label: "incidents",
      prompt: "number of incidents by severity",
    },
    { data: { file: "linked/wan-topology.yaml" }, label: "topology" },
    { data: { file: "linked/regions.geojson" }, label: "regions" },
  ];
  const prompt = "WAN health by site and region: latency, packet loss and incidents";
  const dir = path.join(EXAMPLES, "linked-dashboard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "request.json"),
    JSON.stringify(
      {
        tool: "d3_create_dashboard",
        arguments: { prompt, datasets, max_charts: 8 },
        env: { D3MCP_DATA_DIRS: "<project>/examples/data-files" },
      },
      null,
      2,
    ) + "\n",
  );
  const inputs = [];
  for (const d of datasets)
    inputs.push({
      ds: await svc.resolveData(d.data, "examples"),
      label: d.label,
      ...(d.prompt ? { prompt: d.prompt } : {}),
    });
  const links = analyzeLinks(inputs.map((i) => ({ ds: i.ds, label: i.label }))).recommended;
  const r = await svc.autoDashboard(inputs, {
    prompt,
    maxCharts: 8,
    kpis: true,
    formats: ["html", "png"],
    sessionId: "examples",
    links,
  });
  index.push({
    name: "linked-dashboard",
    type: "dashboard",
    marks: r.record.markCount,
    files: copyOut(r.record, dir),
    exportErrors: r.record.exportErrors,
    findings: r.findings,
    charts: r.plan.map((p) => `${p.dataset}: ${p.type}`),
    links: links.map((l) => `${l.left}.${l.leftField} = ${l.right}.${l.rightField}`),
  });
  process.stderr.write(`linked-dashboard: ${r.plan.map((p) => `${p.dataset}:${p.type}`).join(", ")}\n`);
}

writeFileSync(
  path.join(EXAMPLES, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), examples: index }, null, 2) + "\n",
);
await closeBrowser();
process.stderr.write(`Examples written to ${EXAMPLES}\n`);
