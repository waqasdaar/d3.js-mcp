import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/core/artifacts/store.js";
import { ingest } from "../../src/core/data/ingest.js";
import { VisualizationService } from "../../src/core/service.js";
import { D3McpError } from "../../src/shared/errors.js";
import { sales, topology } from "../fixtures/data.js";
import { config } from "../helpers/render.js";

const FILES = path.resolve(import.meta.dirname, "..", "..", "examples", "data-files");
const text = (f: string) => readFileSync(path.join(FILES, f), "utf8");
const b64 = (f: string) => readFileSync(path.join(FILES, f)).toString("base64");

function svcWithDirs(dirs: string[], extra: Partial<typeof config> = {}) {
  const art = mkdtempSync(path.join(os.tmpdir(), "d3mcp-files-art-"));
  const cfg = { ...config, artifactDir: art, renderWorkers: 0, dataDirs: dirs, ...extra };
  return new VisualizationService(cfg, new ArtifactStore(art, 1));
}

describe("delimited text", () => {
  it("CSV, TSV and pipe-separated files give the same records", () => {
    const csv = ingest({ format: "csv", text: text("sales.csv") }, config);
    const tsv = ingest({ format: "tsv", text: text("sales.tsv") }, config);
    const psv = ingest({ format: "dsv", text: text("sales.psv") }, config);
    expect(csv.rows).toEqual(sales);
    expect(tsv.rows).toEqual(sales);
    expect(psv.rows).toEqual(sales);
    expect(psv.transformations.join(" ")).toMatch(/Detected "\|" as the delimiter/);
  });

  it("sniffs semicolons and parses decimal commas, documenting both", () => {
    const ds = ingest({ format: "csv", text: text("sales-semicolon.csv") }, config);
    expect(ds.source).toBe("dsv");
    expect(ds.origin?.delimiter).toBe(";");
    expect(ds.rows[0]).toEqual({ region: "North", product: "Router", revenue_eur: 1234.5, margin_pct: 12.5 });
    expect(ds.rows[2]!.margin_pct).toBe(14);
    expect(ds.transformations.join(" ")).toMatch(/decimal-comma numbers.*revenue_eur, margin_pct/);
  });

  it("never treats commas as decimals in comma-separated files", () => {
    const ds = ingest({ format: "csv", text: 'a,b\n"1,5",x\n"2,5",y' }, config);
    expect(ds.rows[0]!.a).toBe("1,5");
  });

  it("honours an explicit delimiter and strips a UTF-8 BOM", () => {
    const ds = ingest({ format: "dsv", text: "\ufeffa#b\n1#2", delimiter: "#" }, config);
    expect(ds.rows).toEqual([{ a: 1, b: 2 }]);
    expect(() => ingest({ format: "dsv", text: "a\n1", delimiter: '"' }, config)).toThrow(
      /Invalid delimiter/,
    );
  });
});

describe("JSON, JSON Lines and YAML", () => {
  it("unwraps {data:[...]} documents and honours records_path", () => {
    const ds = ingest({ format: "json", text: text("sales-wrapped.json") }, config);
    expect(ds.rows).toHaveLength(sales.length);
    expect(ds.transformations.join(" ")).toMatch(/Used the "data" array/);
    const p = ingest(
      {
        format: "json",
        text: JSON.stringify({ response: { page: { items: sales.slice(0, 2) } } }),
        records_path: "response.page.items",
      },
      config,
    );
    expect(p.rows).toHaveLength(2);
    expect(() => ingest({ format: "json", text: "{}", records_path: "a.b" }, config)).toThrow(
      /records_path "a.b" not found/,
    );
  });

  it("converts column-oriented and key/value JSON objects", () => {
    const cols = ingest(
      { format: "json", text: JSON.stringify({ month: ["Jan", "Feb"], sales: [10, 20] }) },
      config,
    );
    expect(cols.rows).toEqual([
      { month: "Jan", sales: 10 },
      { month: "Feb", sales: 20 },
    ]);
    const kv = ingest({ format: "json", text: JSON.stringify({ SJC: 42, NYC: 31 }) }, config);
    expect(kv.rows).toEqual([
      { key: "SJC", value: 42 },
      { key: "NYC", value: 31 },
    ]);
  });

  it("reads JSON Lines and reports the failing line", () => {
    const ds = ingest({ format: "jsonl", text: text("sales.jsonl") }, config);
    expect(ds.rows).toEqual(sales);
    expect(ds.source).toBe("jsonl");
    expect(() => ingest({ format: "ndjson", text: '{"a":1}\n{bad}\n' }, config)).toThrow(/line 2/);
    expect(() => ingest({ format: "jsonl", text: "[1,2]" }, config)).toThrow(/not a JSON object/);
  });

  it("reads YAML tables, graphs and hierarchies", () => {
    const t = ingest({ format: "yaml", text: text("sales.yaml") }, config);
    expect(t.rows).toEqual(sales);
    expect(t.source).toBe("yaml");
    expect(t.transformations.join(" ")).toMatch(/"records" array/);
    const g = ingest({ format: "yml", text: text("topology.yaml") }, config);
    expect(g.kind).toBe("graph");
    expect(g.links).toHaveLength(topology.links.length);
    const h = ingest({ format: "yaml", text: text("org.yaml") }, config);
    expect(h.kind).toBe("hierarchy");
  });

  it("YAML is parsed safely: no code tags, alias bombs, duplicate keys or prototype keys", () => {
    const tagged = ingest(
      { format: "yaml", text: "- a: !!js/function 'function(){ globalThis.pwned = 1 }'\n" },
      config,
    );
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
    expect(typeof tagged.rows[0]!.a).toBe("string");
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      ...Array.from(
        { length: 9 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}]`,
      ),
    ].join("\n");
    expect(() => ingest({ format: "yaml", text: bomb }, config)).toThrow(D3McpError);
    expect(() => ingest({ format: "yaml", text: "- a: 1\n  a: 2\n" }, config)).toThrow(/Invalid YAML/);
    expect(() => ingest({ format: "yaml", text: "- __proto__: 1\n" }, config)).toThrow(/not allowed/);
    expect(() => ingest({ format: "yaml", text: "just a string" }, config)).toThrow(/contains no records/);
  });
});

describe("geographic files", () => {
  it("reads GeoJSON and TopoJSON (shared arcs) into the same geo dataset shape", () => {
    const g = ingest({ format: "geojson", text: text("regions.geojson") }, config);
    expect(g.kind).toBe("geo");
    expect(g.rows).toHaveLength(6);
    const t = ingest({ format: "topojson", text: text("regions.topojson") }, config);
    expect(t.kind).toBe("geo");
    expect(t.source).toBe("topojson");
    expect(t.rows.map((r) => r.name)).toEqual(["West", "East"]);
    expect(t.geojson!.features[0]!.geometry.type).toBe("Polygon");
    expect(t.transformations.join(" ")).toMatch(/TopoJSON object "regions"/);
    const inline = ingest(JSON.parse(text("regions.topojson")), config);
    expect(inline.rows).toHaveLength(2);
    expect(() =>
      ingest({ format: "topojson", text: text("regions.topojson"), object: "nope" }, config),
    ).toThrow(/"nope" not found/);
  });
});

describe("spreadsheets (xlsx, xls, ods)", () => {
  for (const [file, format] of [
    ["workbook.xlsx", "xlsx"],
    ["workbook.xls", "xls"],
    ["workbook.ods", "ods"],
  ] as const) {
    it(`${format}: first sheet by default, with the sheet list in warnings`, () => {
      const ds = ingest({ base64: b64(file), format }, config);
      expect(ds.source).toBe("spreadsheet");
      expect(ds.rows).toEqual(sales);
      expect(ds.origin).toMatchObject({ format, sheet: "Sales", sheets: ["Sales", "KPIs", "Totals"] });
      expect(ds.warnings.join(" ")).toMatch(/3 sheets \(Sales, KPIs, Totals\)/);
    });

    it(`${format}: dates, blank and duplicate headers, cached formula values`, () => {
      const kpi = ingest({ base64: b64(file), filename: file, sheet: "kpis" }, config);
      expect(Object.keys(kpi.rows[0]!)).toEqual([
        "date",
        "site",
        "latency_ms",
        "loss_pct",
        "column_5",
        "site_2",
      ]);
      expect(kpi.rows[0]).toMatchObject({ date: "2026-10-01", site: "SJC", latency_ms: 21.5 });
      const totals = ingest({ base64: b64(file), format, sheet: 3 }, config);
      expect(totals.rows.map((r) => r.total)).toEqual([330, 380]);
    });
  }

  it("combines all sheets with a _sheet column", () => {
    const ds = ingest({ base64: b64("workbook.xlsx"), format: "xlsx", sheet: "all" }, config);
    expect(new Set(ds.rows.map((r) => r._sheet))).toEqual(new Set(["Sales", "KPIs", "Totals"]));
    expect(ds.rows).toHaveLength(sales.length + 3 + 2);
  });

  it("supports a header row below a title block", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["Quarterly report"], [], ["site", "value"], ["A", 1], ["B", 2]]),
      "R",
    );
    const data = (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
    expect(ingest({ base64: data, format: "xlsx", header_row: 3 }, config).rows).toEqual([
      { site: "A", value: 1 },
      { site: "B", value: 2 },
    ]);
  });

  it("enforces row limits, reports bad sheets and corrupt files", () => {
    expect(() => ingest({ base64: b64("workbook.xlsx"), format: "xlsx" }, { ...config, maxRows: 5 })).toThrow(
      /12 data rows; the configured limit is 5/,
    );
    expect(() => ingest({ base64: b64("workbook.xlsx"), format: "xlsx", sheet: "Nope" }, config)).toThrow(
      /Sheet "Nope" not found/,
    );
    expect(() => ingest({ base64: b64("workbook.xlsx"), format: "xlsx", sheet: 9 }, config)).toThrow(
      /out of range/,
    );
    expect(() =>
      ingest({ base64: Buffer.from("PK\u0003\u0004garbage").toString("base64"), format: "xlsx" }, config),
    ).toThrow(D3McpError);
    expect(() => ingest({ base64: "@@@", format: "xlsx" }, config)).toThrow(/invalid characters/);
    expect(() => ingest({ base64: b64("workbook.xlsx") }, config)).toThrow(/Cannot tell the format/);
    expect(() => ingest({ format: "xlsx", text: "x" } as never, config)).toThrow();
  });

  it("rejects prototype-pollution header names in sheets", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["__proto__", "b"],
        [1, 2],
      ]),
      "S",
    );
    const data = (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
    expect(() => ingest({ base64: data, format: "xlsx" }, config)).toThrow(/not allowed/);
  });

  it("decodes base64 text formats and data: URIs", () => {
    const ds = ingest({ base64: `data:text/csv;base64,${b64("sales.csv")}`, filename: "s.csv" }, config);
    expect(ds.rows).toEqual(sales);
  });
});

describe("local file input (D3MCP_DATA_DIRS)", () => {
  it("reads every sample file format from an allowed directory", async () => {
    const svc = svcWithDirs([FILES]);
    const expectRows: Record<string, number> = {
      "sales.csv": 12,
      "sales.tsv": 12,
      "sales.psv": 12,
      "sales-semicolon.csv": 3,
      "telemetry.csv": 144,
      "sales.json": 12,
      "sales-wrapped.json": 12,
      "sales.jsonl": 12,
      "sales.yaml": 12,
      "topology.yaml": topology.nodes.length,
      "regions.geojson": 6,
      "regions.topojson": 2,
      "workbook.xlsx": 12,
      "workbook.xls": 12,
      "workbook.ods": 12,
    };
    for (const [file, n] of Object.entries(expectRows)) {
      const ds = await svc.resolveData({ file: path.join(FILES, file) }, "files");
      expect(ds.rows.length, file).toBe(n);
      expect(ds.origin?.file, file).toBe(path.join(FILES, file));
    }
    const rel = await svc.resolveData({ file: "workbook.xlsx", sheet: "KPIs" }, "files");
    expect(rel.rows).toHaveLength(3);
    const url = await svc.resolveData(
      { file: `file://${encodeURI(path.join(FILES, "sales.csv"))}` },
      "files",
    );
    expect(url.rows).toHaveLength(12);
  });

  it("is disabled unless directories are configured", async () => {
    await expect(svcWithDirs([]).resolveData({ file: path.join(FILES, "sales.csv") }, "f")).rejects.toThrow(
      /Reading local files is disabled/,
    );
  });

  it("blocks paths outside the allowed directories, traversal and symlink escapes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "d3mcp-files-"));
    const allowed = path.join(root, "allowed");
    const secret = path.join(root, "secret");
    mkdirSync(allowed);
    mkdirSync(secret);
    writeFileSync(path.join(secret, "secret.csv"), "a\n1\n");
    writeFileSync(path.join(allowed, "ok.csv"), "a\n1\n");
    symlinkSync(path.join(secret, "secret.csv"), path.join(allowed, "link.csv"));
    mkdirSync(path.join(allowed, "dir.csv"));
    const svc = svcWithDirs([allowed]);
    expect((await svc.resolveData({ file: "ok.csv" }, "f")).rows).toEqual([{ a: 1 }]);
    for (const f of [path.join(secret, "secret.csv"), "../secret/secret.csv", "link.csv", "/etc/passwd"]) {
      const err = await svc.resolveData({ file: f }, "f").catch((e: unknown) => e);
      expect((err as D3McpError).code, f).toMatch(/SECURITY_VIOLATION|ARTIFACT_NOT_FOUND/);
      expect((err as D3McpError).code, f).not.toBe(undefined);
    }
    await expect(svc.resolveData({ file: "../secret/secret.csv" }, "f")).rejects.toThrow(
      /outside the allowed/,
    );
    await expect(svc.resolveData({ file: "link.csv" }, "f")).rejects.toThrow(/outside the allowed/);
    await expect(svc.resolveData({ file: "https://example.com/data.csv" }, "f")).rejects.toThrow(
      /URLs are never fetched/,
    );
    await expect(svc.resolveData({ file: "missing.csv" }, "f")).rejects.toThrow(/File not found/);
    await expect(svc.resolveData({ file: "dir.csv" }, "f")).rejects.toThrow(/Not a regular file/);
    await expect(svc.resolveData({ file: "ok.bin" }, "f")).rejects.toThrow(/File not found/);
    writeFileSync(path.join(allowed, "data.bin"), "a\n1\n");
    await expect(svc.resolveData({ file: "data.bin" }, "f")).rejects.toThrow(/Cannot tell the format/);
    expect((await svc.resolveData({ file: "data.bin", format: "csv" }, "f")).rows).toEqual([{ a: 1 }]);
    await expect(
      svcWithDirs([allowed], { maxFileBytes: 1_000 }).resolveData(
        { file: path.join(FILES, "workbook.xlsx") },
        "f",
      ),
    ).rejects.toThrow(/outside|limit/);
  });

  it("enforces D3MCP_MAX_FILE_BYTES", async () => {
    await expect(
      svcWithDirs([FILES], { maxFileBytes: 1_000 }).resolveData({ file: "workbook.xlsx" }, "f"),
    ).rejects.toThrow(/the limit is 1000/);
  });
});
