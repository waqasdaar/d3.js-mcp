import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VIS_TYPES } from "../../src/core/schema/spec.js";
import {
  customSvgIcon,
  flows,
  geo,
  hierarchy,
  malicious,
  network,
  sales,
  simpleBars,
  telemetryCsv,
  TIER_ORDER,
  topology,
} from "../fixtures/data.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SERVER = path.join(ROOT, "dist", "server", "index.js");
const DATA_FILES = path.join(ROOT, "examples", "data-files");
const EXPECTED_TOOLS = [
  "d3_visualize",
  "d3_recommend_visualizations",
  "d3_analyze_data",
  "d3_create_spec",
  "d3_render",
  "d3_compose_visualizations",
  "d3_create_dashboard",
  "d3_link_datasets",
  "d3_join_datasets",
  "d3_refine_visualization",
  "d3_query_api",
  "d3_execute_composition",
  "d3_validate_visualization",
  "d3_export",
  "d3_get_artifact",
  "d3_list_capabilities",
  "d3_get_test_report",
];

let client: Client;
let artifactDir: string;
let stderr = "";

type Result = Record<string, unknown> & { ok: boolean };

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ raw: CallToolResult; data: Result }> {
  const raw = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { raw, data: raw.structuredContent as Result };
}

async function okCall(name: string, args: Record<string, unknown>): Promise<Result> {
  const { raw, data } = await call(name, args);
  if (raw.isError) throw new Error(`${name} failed: ${JSON.stringify(raw.content)}`);
  expect(data.ok).toBe(true);
  return data;
}

function files(d: Result) {
  return d.files as Record<string, { path: string; bytes: number }>;
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error(`Build first: ${SERVER} missing`);
  artifactDir = mkdtempSync(path.join(os.tmpdir(), "d3mcp-it-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...(process.env as Record<string, string>),
      D3MCP_ARTIFACT_DIR: artifactDir,
      D3MCP_LOG_LEVEL: "info",
      D3MCP_DATA_DIRS: DATA_FILES,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
  client = new Client({ name: "d3mcp-integration-test", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

describe("MCP protocol", () => {
  it("initializes with server info and instructions", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "d3-visualization-mcp" });
    expect(client.getInstructions()).toMatch(/d3_visualize/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it("lists every tool with input and output schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of EXPECTED_TOOLS) expect(names).toContain(n);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
    }
    const viz = tools.find((t) => t.name === "d3_visualize")!;
    expect(Object.keys(viz.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["data", "prompt", "visualization_type", "output_formats", "session_id"]),
    );
  });

  it("exposes resources and prompts", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["d3://schema/visualization-spec", "d3://capabilities/coverage"]),
    );
    const schema = await client.readResource({ uri: "d3://schema/visualization-spec" });
    const json = JSON.parse((schema.contents[0] as { text: string }).text) as {
      properties: Record<string, unknown>;
    };
    expect(json.properties.type).toBeDefined();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("visualize-data");
  });

  it("returns a protocol error for unknown tools", async () => {
    const r = await client
      .callTool({ name: "does_not_exist", arguments: {} })
      .catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
    expect((r as CallToolResult).isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not found|unknown/i);
  });

  it("rejects invalid arguments with a validation error", async () => {
    const r = (await client
      .callTool({ name: "d3_visualize", arguments: { prompt: 5 } })
      .catch((e: Error) => ({
        isError: true,
        content: [{ type: "text", text: e.message }],
      }))) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/data|prompt|invalid/i);
  });

  it("keeps stdout clean: diagnostics go to stderr", () => {
    expect(stderr).toMatch(/ready/);
  });
});

describe("end-to-end scenarios", () => {
  it("1. JSON → bar chart → SVG + HTML", async () => {
    const d = await okCall("d3_visualize", {
      data: simpleBars,
      prompt: "Compare value by category",
      visualization_type: "bar",
      output_formats: ["html", "svg"],
    });
    expect(d.visualization_type).toBe("bar");
    expect(d.mark_count).toBe(5);
    for (const f of ["html", "svg", "json"]) {
      expect(statSync(files(d)[f]!.path).size).toBeGreaterThan(0);
      expect(files(d)[f]!.path.startsWith(artifactDir)).toBe(true);
    }
    expect(readFileSync(files(d).svg!.path, "utf8").match(/class="bar[ "]/g)?.length).toBe(5);
    expect(d.spec).toBeDefined();
    expect(d.data_mapping).toBeDefined();
    expect((d.validation_status as Record<string, string>).svg).toBe("passed");
  });

  it("2. time-series CSV → line chart (PNG reported truthfully)", async () => {
    const d = await okCall("d3_visualize", {
      data: { format: "csv", text: telemetryCsv() },
      prompt: "latency over time by site",
      output_formats: ["html", "svg", "png"],
    });
    expect(["line", "area"]).toContain(d.visualization_type);
    const exportErrors = d.export_errors as Record<string, string>;
    if (files(d).png) {
      const buf = readFileSync(files(d).png!.path);
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
    } else {
      expect(exportErrors.png).toBeTruthy();
    }
  });

  it("3. network → force-directed graph", async () => {
    const d = await okCall("d3_visualize", {
      data: network,
      prompt: "force-directed topology colored by group, sized by degree",
      visualization_type: "force",
    });
    expect(d.mark_count).toBe(network.nodes.length);
    const svg = readFileSync(files(d).svg!.path, "utf8");
    expect(svg.match(/<circle[^>]*class="node/g)?.length).toBe(network.nodes.length);
  });

  it("4. hierarchy → treemap and sunburst", async () => {
    for (const t of ["treemap", "sunburst"]) {
      const d = await okCall("d3_visualize", {
        data: { format: "hierarchy", root: hierarchy },
        prompt: "site sizes",
        visualization_type: t,
      });
      expect(d.visualization_type).toBe(t);
      expect(d.mark_count as number).toBeGreaterThanOrEqual(10);
    }
  });

  it("5. GeoJSON → projected map", async () => {
    const d = await okCall("d3_visualize", {
      data: geo,
      prompt: "choropleth of value",
      options: { options: { projection: "mercator" } },
    });
    expect(d.visualization_type).toBe("geo");
    expect(d.mark_count).toBe(6);
  });

  it("6. multiple measures → composed dashboard", async () => {
    const d = await okCall("d3_compose_visualizations", {
      title: "SD-WAN health",
      data: { format: "csv", text: telemetryCsv() },
      charts: [
        {
          prompt: "latency over time by site",
          visualization_type: "line",
          options: {
            encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, series: { field: "site" } },
          },
        },
        {
          prompt: "packet loss over time",
          visualization_type: "line",
          options: {
            encoding: {
              x: { field: "timestamp" },
              y: { field: "packet_loss_pct" },
              series: { field: "site" },
            },
          },
        },
        {
          prompt: "throughput by site",
          visualization_type: "boxplot",
          options: { encoding: { x: { field: "site" }, y: { field: "throughput_mbps" } } },
        },
        { data: network, visualization_type: "force", prompt: "topology" },
      ],
      shared_time_brush: true,
    });
    expect((d.charts as unknown[]).length).toBe(4);
    expect(statSync(files(d).html!.path).size).toBeGreaterThan(1000);
  });

  it("7. refine an existing chart", async () => {
    const first = await okCall("d3_visualize", {
      data: sales,
      prompt: "revenue by region",
      visualization_type: "bar",
    });
    const d = await okCall("d3_refine_visualization", {
      artifact_id: first.artifact_id,
      instructions: "use a logarithmic y scale; add a threshold line at 100; dark theme",
    });
    const spec = d.spec as {
      scales: { y?: { type: string } };
      annotations: Array<{ value: number }>;
      theme: string;
      type: string;
      encoding: unknown;
    };
    expect(spec.scales.y?.type).toBe("log");
    expect(spec.annotations.some((a) => a.value === 100)).toBe(true);
    expect(spec.theme).toBe("dark");
    expect(spec.type).toBe("bar");
    expect(spec.encoding).toEqual((first.spec as { encoding: unknown }).encoding);
    expect(d.parent_artifact_id).toBe(first.artifact_id);
  });

  it("8. invalid dataset → actionable error, no false success", async () => {
    const { raw, data } = await call("d3_visualize", {
      data: { nodes: [{ id: "a" }], links: [{ source: "a", target: "missing" }] },
      prompt: "graph",
    });
    expect(raw.isError).toBe(true);
    expect(data.ok).toBe(false);
    expect(JSON.stringify(raw.content)).toMatch(/missing/);
    const empty = await call("d3_visualize", { data: [], prompt: "x" });
    expect(empty.raw.isError).toBe(true);
    const badField = await call("d3_visualize", {
      data: simpleBars,
      prompt: "x",
      visualization_type: "bar",
      options: { encoding: { x: { field: "nope" }, y: { field: "value" } } },
    });
    expect(badField.raw.isError).toBe(true);
    expect(JSON.stringify(badField.raw.content)).toMatch(/Available fields/);
  });

  it("9. malicious HTML/SVG input is escaped or rejected", async () => {
    const d = await okCall("d3_visualize", {
      data: malicious,
      prompt: "values by name",
      visualization_type: "bar",
      title: "<script>alert(1)</script>",
    });
    const html = readFileSync(files(d).html!.path, "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    const v = await okCall("d3_validate_visualization", {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    });
    expect(v.valid).toBe(false);
    const traversal = await call("d3_get_artifact", { artifact_id: "../../etc/passwd" });
    expect(traversal.raw.isError).toBe(true);
  });

  it("10. large dataset → controlled behaviour with documented limits", async () => {
    const rows = Array.from({ length: 25_000 }, (_, i) => ({
      x: (i * 7919) % 1000,
      y: (i * 104729) % 997,
      g: `g${i % 4}`,
    }));
    const { raw, data } = await call("d3_visualize", {
      data: rows,
      prompt: "x vs y",
      visualization_type: "scatter",
    });
    if (raw.isError) expect(JSON.stringify(raw.content)).toMatch(/limit/i);
    else
      expect(
        (data.warnings as string[]).length +
          ((data.spec as { renderer: string }).renderer === "canvas" ? 1 : 0),
      ).toBeGreaterThan(0);
  });
});

describe("data files and formats", () => {
  it("12. Excel sheet from a file → line chart, with origin and sheet list reported", async () => {
    const d = await okCall("d3_visualize", {
      data: { file: path.join(DATA_FILES, "workbook.xlsx"), sheet: "KPIs" },
      prompt: "latency over time by site",
      visualization_type: "line",
      options: { encoding: { x: { field: "date" }, y: { field: "latency_ms" }, series: { field: "site" } } },
    });
    expect(d.mark_count).toBe(2);
    const ds = d.dataset as {
      origin: { file: string; sheet: string; sheets: string[] };
      source: string;
      rowCount: number;
    };
    expect(ds.source).toBe("spreadsheet");
    expect(ds.rowCount).toBe(3);
    expect(ds.origin).toMatchObject({
      sheet: "KPIs",
      sheets: ["Sales", "KPIs", "Totals"],
      file: path.join(DATA_FILES, "workbook.xlsx"),
    });
  });

  it("13. dashboard mixing xlsx, xls, ods, YAML, JSON Lines, semicolon CSV and TopoJSON files", async () => {
    const d = await okCall("d3_compose_visualizations", {
      title: "Every input format",
      charts: [
        {
          data: { file: "workbook.xlsx", sheet: "Totals" },
          visualization_type: "bar",
          options: { encoding: { x: { field: "region" }, y: { field: "total" } } },
        },
        {
          data: { file: "workbook.xls" },
          visualization_type: "bar",
          options: { encoding: { x: { field: "region" }, y: { field: "revenue", aggregate: "sum" } } },
        },
        {
          data: { file: "workbook.ods", sheet: "all" },
          visualization_type: "bar",
          prompt: "rows per sheet",
          options: { encoding: { x: { field: "_sheet" }, y: { field: "_sheet", aggregate: "count" } } },
        },
        {
          data: { file: "sales.yaml" },
          visualization_type: "pie",
          options: { encoding: { color: { field: "product" }, value: { field: "units" } } },
        },
        {
          data: { file: "sales.jsonl" },
          visualization_type: "scatter",
          options: { encoding: { x: { field: "units" }, y: { field: "revenue" } } },
        },
        {
          data: { file: "sales-semicolon.csv" },
          visualization_type: "bar",
          options: { encoding: { x: { field: "region" }, y: { field: "revenue_eur" } } },
        },
        {
          data: { file: "regions.topojson" },
          visualization_type: "geo",
          options: { encoding: { color: { field: "value" } } },
        },
        { data: { file: "topology.yaml" }, visualization_type: "force", prompt: "topology" },
      ],
      columns: 2,
    });
    const charts = d.charts as Array<{ type: string; markCount: number }>;
    expect(charts.map((c) => c.markCount)).toEqual([2, 4, 3, 2, 12, 3, 2, topology.nodes.length]);
    expect(statSync(files(d).html!.path).size).toBeGreaterThan(1000);
  });

  it("14. inline base64 workbook and YAML text work without file access", async () => {
    const xlsx = readFileSync(path.join(DATA_FILES, "workbook.xlsx")).toString("base64");
    const a = await okCall("d3_analyze_data", {
      data: { base64: xlsx, filename: "report.xlsx", sheet: "Totals" },
    });
    expect((a.profile as { rowCount: number }).rowCount).toBe(2);
    const y = await okCall("d3_visualize", {
      data: { format: "yaml", text: readFileSync(path.join(DATA_FILES, "sales.yaml"), "utf8") },
      prompt: "revenue by region",
      visualization_type: "bar",
    });
    expect(y.mark_count).toBe(4);
  });

  it("15. file access stays inside D3MCP_DATA_DIRS and reports capabilities", async () => {
    for (const f of ["/etc/passwd", "../package.json", "https://example.com/x.csv"]) {
      const r = await call("d3_analyze_data", { data: { file: f } });
      expect(r.raw.isError, f).toBe(true);
      expect(JSON.stringify(r.raw.content), f).toMatch(/SECURITY_VIOLATION|outside|never fetched|not found/i);
    }
    const caps = await okCall("d3_list_capabilities", {});
    const input = caps.data_input as {
      text_formats: string[];
      spreadsheet_formats: string[];
      file_access: { enabled: boolean; directories: string[] };
    };
    expect(input.text_formats).toEqual(expect.arrayContaining(["csv", "yaml", "jsonl", "topojson"]));
    expect(input.spreadsheet_formats).toEqual(expect.arrayContaining(["xlsx", "xls", "ods"]));
    expect(input.file_access).toMatchObject({ enabled: true, directories: [DATA_FILES] });
  });
});

describe("automatic dashboards (d3_create_dashboard)", () => {
  it("16. data + goal only → multi-chart dashboard with KPIs and a shared time brush", async () => {
    const d = await okCall("d3_create_dashboard", {
      data: { file: "telemetry.csv" },
      prompt: "SD-WAN health by site: latency, packet loss and throughput",
      output_formats: ["html", "png"],
    });
    const charts = d.charts as Array<{ type: string; family: string; encoding: { y?: { field: string } } }>;
    expect(charts).toHaveLength(6);
    expect(
      charts
        .filter((c) => c.family === "trend")
        .map((c) => c.encoding.y?.field)
        .sort(),
    ).toEqual(["latency_ms", "packet_loss_pct", "throughput_mbps"]);
    expect((d.kpis as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(d.linked_interactions as string[]).toContain("shared time-range brush");
    const html = readFileSync(files(d).html!.path, "utf8");
    expect(html.match(/<svg[^>]*d3mcp-root/g)?.length).toBe(6);
    expect(html).toContain('class="d3mcp-kpis"');
    if (files(d).png) expect(statSync(files(d).png!.path).size).toBeGreaterThan(10_000);
    else expect((d.export_errors as Record<string, string>).png).toBeTruthy();
  });

  it("17. one dashboard section per Excel sheet (split_sheets)", async () => {
    const d = await okCall("d3_create_dashboard", {
      data: { file: "workbook.xlsx" },
      split_sheets: true,
      prompt: "overview",
      max_charts: 6,
    });
    const charts = d.charts as Array<{ dataset: string }>;
    expect(new Set(charts.map((c) => c.dataset))).toEqual(new Set(["Sales", "KPIs", "Totals"]));
    expect((d.datasets as Array<{ label: string }>).map((x) => x.label)).toEqual(["Sales", "KPIs", "Totals"]);
  });

  it("18. mixed datasets (YAML graph, GeoJSON, JSON Lines) in one call", async () => {
    const d = await okCall("d3_create_dashboard", {
      prompt: "network, regions and sales",
      datasets: [
        { data: { file: "topology.yaml" }, label: "Topology" },
        { data: { file: "regions.geojson" }, label: "Regions" },
        { data: { file: "sales.jsonl" }, label: "Sales" },
      ],
      max_charts: 5,
      theme: "dark",
    });
    const charts = d.charts as Array<{ dataset: string; family: string }>;
    expect(charts.find((c) => c.dataset === "Topology")!.family).toBe("network");
    expect(charts.find((c) => c.dataset === "Regions")!.family).toBe("geo");
    expect(charts.some((c) => c.dataset === "Sales")).toBe(true);
  });

  it("19. invalid requests fail with actionable errors", async () => {
    const none = await call("d3_create_dashboard", { prompt: "x" });
    expect(none.raw.isError).toBe(true);
    expect(JSON.stringify(none.raw.content)).toMatch(/Provide 'data' or 'datasets'/);
    const notSheet = await call("d3_create_dashboard", { prompt: "x", data: sales, split_sheets: true });
    expect(notSheet.raw.isError).toBe(true);
    expect(JSON.stringify(notSheet.raw.content)).toMatch(/split_sheets requires a spreadsheet/);
  });
});

const LINKED = [
  { data: { file: "linked/wan-telemetry.csv" }, label: "telemetry" },
  { data: { file: "linked/sites.xlsx" }, label: "sites" },
  { data: { file: "linked/incidents.json" }, label: "incidents" },
  { data: { file: "linked/wan-topology.yaml" }, label: "topology" },
  { data: { file: "linked/regions.geojson" }, label: "regions" },
];
// Two columns hold the same values, so the link to "metrics" is genuinely ambiguous.
const AMBIGUOUS = [
  {
    label: "devices",
    data: ["r1", "r2", "r3", "r4"].map((id, i) => ({ id, hostname: id, model: i % 2 ? "ISR" : "ASR" })),
  },
  {
    label: "metrics",
    data: ["r1", "r2", "r3", "r4", "r1", "r2"].map((device, i) => ({ device, cpu_pct: 20 + i * 7 })),
  },
];

describe("multi-source linking", () => {
  it("20. d3_link_datasets infers links across CSV, Excel, JSON, YAML and GeoJSON (case-insensitive keys)", async () => {
    const d = await okCall("d3_link_datasets", { datasets: LINKED });
    expect(d.status).toBe("linked");
    const links = (d.links as Array<Record<string, string>>).map(
      (l) => `${l.left}.${l.left_field}=${l.right}.${l.right_field}`,
    );
    expect(links).toEqual(
      expect.arrayContaining([
        "telemetry.site=sites.site_code",
        "sites.site_code=incidents.site",
        "sites.region=regions.name",
        "sites.site_code=topology.id",
      ]),
    );
    expect(d.entity).toEqual({ label: "sites", field: "site_code" });
    expect(d.questions).toEqual([]);
    expect(d.unlinked_datasets).toEqual([]);
  });

  it("21. linked dashboard: joined views, linked map colour, cross-chart keys and a detail panel", async () => {
    const d = await okCall("d3_create_dashboard", {
      prompt: "WAN health by site and region: latency, packet loss and incidents",
      datasets: LINKED,
      max_charts: 8,
    });
    const linking = d.linking as {
      entity: { field: string };
      links: unknown[];
      joined_views: Array<{ label: string }>;
      enriched_fields: string[];
      linked_charts: string[];
    };
    expect(linking.entity.field).toBe("site_code");
    expect(linking.links.length).toBeGreaterThanOrEqual(4);
    expect(linking.joined_views.map((j) => j.label)).toContain("telemetry by region");
    expect(linking.enriched_fields).toContain("regions.avg_latency_ms");
    const charts = d.charts as Array<{
      dataset: string;
      type: string;
      encoding: { color?: { field: string } };
    }>;
    for (const ds of ["telemetry", "sites", "incidents", "topology", "regions"]) {
      expect(
        charts.some((c) => c.dataset === ds),
        ds,
      ).toBe(true);
    }
    expect(charts.find((c) => c.dataset === "regions")!.encoding.color?.field).toBe("avg_latency_ms");
    expect(linking.linked_charts).toHaveLength(charts.length);
    expect((d.linked_interactions as string[])[0]).toMatch(/click any mark to select its site_code/);
    const html = readFileSync(files(d).html!.path, "utf8");
    expect(html.match(/<svg[^>]*data-link-field="_link"/g)?.length).toBe(charts.length);
    expect(html).toContain('data-link="lon"');
    expect(html).toContain('id="d3mcp-linked"');
    expect(html).toMatch(/<circle[^>]*class="node[^>]*data-tooltip="[^"]*avg_latency_ms: \d/);
    expect(html).toContain('class="d3mcp-details"');
    // Lower-case incident keys (sjc) matched the upper-case site codes (SJC).
    expect(html).toMatch(/"site":"sjc"[^}]*"_k":\["sjc"\]/);
  });

  it("22. ambiguous links without elicitation → needs_input questions, then explicit links", async () => {
    const first = await okCall("d3_create_dashboard", { prompt: "cpu by model", datasets: AMBIGUOUS });
    expect(first.status).toBe("needs_input");
    const q = (
      first.questions as Array<{ question: string; options: Array<{ link: Record<string, string> | null }> }>
    )[0]!;
    expect(q.question).toMatch(/devices.*metrics/);
    const fields = q.options.flatMap((o) => (o.link ? [o.link.left_field] : [])).sort();
    expect(fields).toEqual(["hostname", "id"]);
    expect(q.options.some((o) => o.link === null)).toBe(true);
    const ids = first.datasets as Array<{ label: string; dataset_id: string }>;
    const second = await okCall("d3_create_dashboard", {
      prompt: "cpu by model",
      datasets: ids.map((x) => ({ data: { dataset_id: x.dataset_id }, label: x.label })),
      links: [{ left: "devices", left_field: "id", right: "metrics", right_field: "device" }],
    });
    expect(second.status).toBeUndefined();
    expect((second.linking as { joined_views: Array<{ label: string }> }).joined_views[0]!.label).toBe(
      "metrics by model",
    );
    const best = await okCall("d3_create_dashboard", {
      prompt: "cpu",
      datasets: AMBIGUOUS,
      link_mode: "best",
    });
    expect((best.linking as { notes: string[] }).notes.join(" ")).toMatch(/without asking/);
  });

  it("23. d3_join_datasets joins Excel attributes onto CSV rows and the result feeds d3_visualize", async () => {
    const j = await okCall("d3_join_datasets", {
      left: { data: { file: "linked/wan-telemetry.csv" }, label: "telemetry" },
      right: { data: { file: "linked/sites.xlsx" }, label: "sites" },
    });
    expect(j.link).toMatchObject({ left_field: "site", right_field: "site_code", how: "left" });
    expect(j.matched).toBe(112);
    expect(j.unmatched).toBe(0);
    expect(j.added_fields).toEqual(expect.arrayContaining(["city", "region", "tier", "circuit_mbps"]));
    const v = await okCall("d3_visualize", {
      data: { dataset_id: j.dataset_id },
      prompt: "bar chart of average latency_ms by region",
    });
    expect(v.visualization_type).toBe("bar");
    const inner = await okCall("d3_join_datasets", {
      left: { data: AMBIGUOUS[1]!.data, label: "metrics" },
      right: { data: [{ name: "r1", site: "SJC" }], label: "inventory" },
      left_field: "device",
      right_field: "name",
      how: "inner",
    });
    expect(inner.matched).toBe(2);
    expect((inner.dataset as { rowCount: number }).rowCount).toBe(2);
  });

  it("24. invalid links fail with actionable errors", async () => {
    const badLabel = await call("d3_create_dashboard", {
      prompt: "x",
      datasets: AMBIGUOUS,
      links: [{ left: "nope", left_field: "id", right: "metrics", right_field: "device" }],
    });
    expect(badLabel.raw.isError).toBe(true);
    expect(JSON.stringify(badLabel.raw.content)).toMatch(
      /unknown dataset \\"nope\\".*Labels: devices, metrics/,
    );
    const badField = await call("d3_join_datasets", {
      left: { data: AMBIGUOUS[0]!.data },
      right: { data: AMBIGUOUS[1]!.data },
      left_field: "serial",
      right_field: "device",
    });
    expect(badField.raw.isError).toBe(true);
    expect(JSON.stringify(badField.raw.content)).toMatch(/FIELD_NOT_FOUND/);
  });
});

describe("multi-source linking with MCP elicitation", () => {
  let elicitClient: Client;
  const asked: Array<{ message: string; properties: Record<string, { enum: string[] }> }> = [];
  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        ...(process.env as Record<string, string>),
        D3MCP_ARTIFACT_DIR: artifactDir,
        D3MCP_DATA_DIRS: DATA_FILES,
        D3MCP_LOG_LEVEL: "warn",
      },
      stderr: "pipe",
    });
    elicitClient = new Client(
      { name: "d3mcp-elicit-test", version: "1.0.0" },
      { capabilities: { elicitation: {} } },
    );
    elicitClient.setRequestHandler(ElicitRequestSchema, (req) => {
      const params = req.params as {
        message: string;
        requestedSchema: { properties: Record<string, { enum: string[] }> };
      };
      asked.push({ message: params.message, properties: params.requestedSchema.properties });
      // The user picks the "hostname" option for every question.
      const content = Object.fromEntries(
        Object.entries(params.requestedSchema.properties).map(([k, p]) => [
          k,
          p.enum.find((v) => v.includes(".hostname=")) ?? p.enum[0]!,
        ]),
      );
      return { action: "accept", content };
    });
    await elicitClient.connect(transport);
  });
  afterAll(async () => {
    await elicitClient?.close();
  });

  it("25. asks the user through elicitation and uses the chosen link", async () => {
    const raw = (await elicitClient.callTool({
      name: "d3_create_dashboard",
      arguments: { prompt: "cpu by model", datasets: AMBIGUOUS },
    })) as CallToolResult;
    expect(raw.isError).toBeFalsy();
    const d = raw.structuredContent as Record<string, unknown>;
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toMatch(/linked in more than one way/);
    expect(Object.values(asked[0]!.properties)[0]!.enum).toContain("none");
    const linking = d.linking as {
      asked_user: string;
      links: Array<Record<string, string>>;
      notes: string[];
    };
    expect(linking.asked_user).toBe("elicitation");
    expect(linking.links[0]).toMatchObject({
      left: "devices",
      left_field: "hostname",
      right_field: "device",
    });
    expect(linking.notes.join(" ")).toMatch(/User linked devices.hostname = metrics.device/);
  });

  it("26. a declined elicitation returns the questions instead of guessing", async () => {
    elicitClient.setRequestHandler(ElicitRequestSchema, () => ({ action: "decline" }));
    const raw = (await elicitClient.callTool({
      name: "d3_link_datasets",
      arguments: { datasets: AMBIGUOUS },
    })) as CallToolResult;
    const d = raw.structuredContent as Record<string, unknown>;
    expect(d.status).toBe("needs_input");
    expect(d.asked_user).toBe("declined");
    expect((d.questions as unknown[]).length).toBe(1);
  });
});

describe("remaining tools", () => {
  it("11. topology with built-in + custom icons and tiers via d3_visualize", async () => {
    const nodes = topology.nodes.map((n) =>
      n.id === "srv-1" ? { ...n, type: "k8s" } : n.id === "db-1" ? { ...n, type: "nic" } : n,
    );
    const d = await okCall("d3_visualize", {
      data: { nodes, links: topology.links },
      prompt: "Network topology with device icons, layered by tier; enable zoom and search",
      visualization_type: "force",
      options: {
        encoding: { color: { field: "tier" } },
        options: {
          iconField: "type",
          tierField: "tier",
          tierOrder: TIER_ORDER,
          icons: {
            k8s: {
              viewBox: [0, 0, 100, 100],
              paths: [{ d: "M50 5L90 27v46L50 95 10 73V27z", fill: "#326ce5" }],
            },
            nic: { svg: customSvgIcon },
          },
        },
      },
      output_formats: ["html", "svg"],
    });
    expect(d.mark_count).toBe(nodes.length);
    const svg = readFileSync(files(d).svg!.path, "utf8");
    expect(svg.match(/<g class="node-icon"/g)?.length).toBe(nodes.length);
    expect(svg).toContain('data-icon="k8s"');
    expect(svg).toContain('data-icon="nic"');
    expect(svg).toContain('data-icon="firewall"');
    const spec = d.spec as { interaction: { zoom: boolean; search: boolean } };
    expect(spec.interaction.zoom && spec.interaction.search).toBe(true);
    const bad = await call("d3_visualize", {
      data: topology,
      prompt: "x",
      visualization_type: "force",
      options: { options: { icons: { a: { paths: [{ d: "<script>" }] } } } },
    });
    expect(bad.raw.isError).toBe(true);
  });

  it("README topology example runs unchanged", async () => {
    const md = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const block = /### Full example \(`d3_visualize`\)\s+```json\n([\s\S]+?)\n```/.exec(md);
    expect(block, "README full example block").not.toBeNull();
    const args = JSON.parse(block![1]!) as { data: { nodes: unknown[] } };
    const d = await okCall("d3_visualize", args);
    const svg = readFileSync(files(d).svg!.path, "utf8");
    expect(svg.match(/<g class="node-icon"/g)?.length).toBe(args.data.nodes.length);
    expect(svg).toContain('data-icon="k8s"');
    expect(svg).toContain('data-icon="access-point"');
    expect((d.export_errors as Record<string, string>).png).toBeUndefined();
  });

  it("d3_analyze_data and d3_recommend_visualizations", async () => {
    const a = await okCall("d3_analyze_data", { data: { format: "csv", text: telemetryCsv() } });
    const profile = a.profile as { rowCount: number; fields: Array<{ name: string; type: string }> };
    expect(profile.rowCount).toBe(144);
    expect(profile.fields.find((f) => f.name === "timestamp")?.type).toBe("temporal");
    const r = await okCall("d3_recommend_visualizations", { data: sales, limit: 3 });
    expect((r.recommendations as unknown[]).length).toBe(3);
  });

  it("d3_create_spec → d3_render → d3_get_artifact → d3_export → d3_validate_visualization", async () => {
    const s = await okCall("d3_create_spec", {
      data: flows,
      prompt: "traffic flow",
      visualization_type: "sankey",
    });
    const spec = s.spec as { id: string; data: { datasetId: string } };
    expect(existsSync(s.spec_path as string)).toBe(true);
    const r = await okCall("d3_render", { spec });
    expect(r.visualization_type).toBe("sankey");
    const g = await okCall("d3_get_artifact", { artifact_id: r.artifact_id, include_content: "svg" });
    expect(String(g.content)).toMatch(/^<svg/);
    const e = await okCall("d3_export", { artifact_id: r.artifact_id, formats: ["csv", "png"] });
    expect(e.produced as string[]).toContain("csv");
    if (!(e.produced as string[]).includes("png"))
      expect((e.failed as Record<string, string>).png).toBeTruthy();
    const v = await okCall("d3_validate_visualization", { artifact_id: r.artifact_id, browser: false });
    expect(v.valid).toBe(true);
    const list = await okCall("d3_get_artifact", { list: true });
    expect((list.artifacts as unknown[]).length).toBeGreaterThan(5);
  });

  it("d3_query_api, d3_execute_composition, d3_list_capabilities", async () => {
    const q = await okCall("d3_query_api", { query: "forceSimulation" });
    const first = (q.results as Array<{ normalized: string; status: string; doc_url: string }>)[0]!;
    expect(first.normalized).toBe("forceSimulation");
    expect(first.status).toBe("implemented-and-tested");
    expect(first.doc_url).toMatch(/^https:\/\/d3js\.org\//);
    const c = await okCall("d3_execute_composition", {
      data: simpleBars,
      steps: [{ id: "e", op: "array.extent", input: "$data", field: "value" }],
    });
    expect((c.results as Record<string, unknown>).e).toEqual([20, 80]);
    const bad = await call("d3_execute_composition", { steps: [{ id: "e", op: "eval", input: [] }] });
    expect(bad.raw.isError).toBe(true);
    const caps = await okCall("d3_list_capabilities", {});
    expect((caps.visualization_types as unknown[]).length).toBe(VIS_TYPES.length);
    expect((caps.d3_coverage as { totals: { total: number } }).totals.total).toBeGreaterThan(1000);
  });

  it("d3_get_test_report reports truthfully", async () => {
    const { raw, data } = await call("d3_get_test_report", {});
    if (raw.isError) expect(JSON.stringify(raw.content)).toMatch(/npm run verify/);
    else expect(data.report).toBeDefined();
  });
});
