import { describe, expect, it } from "vitest";
import { ingest } from "../../src/core/data/ingest.js";
import { profileDataset } from "../../src/core/data/profile.js";
import { D3McpError } from "../../src/shared/errors.js";
import { geo, hierarchy, network, sales, telemetryCsv } from "../fixtures/data.js";
import { config } from "../helpers/render.js";

describe("ingest", () => {
  it("normalizes record arrays", () => {
    const ds = ingest(sales, config);
    expect(ds.kind).toBe("table");
    expect(ds.rows).toHaveLength(sales.length);
    expect(ds.rows[0]).toMatchObject({ region: "North", revenue: 120 });
  });

  it("parses CSV and converts numeric columns", () => {
    const ds = ingest({ format: "csv", text: telemetryCsv() }, config);
    expect(ds.source).toBe("csv");
    expect(ds.rows).toHaveLength(144);
    expect(typeof ds.rows[0]!.latency_ms).toBe("number");
    expect(typeof ds.rows[0]!.site).toBe("string");
  });

  it("parses TSV and JSON text", () => {
    const tsv = ingest({ format: "tsv", text: "a\tb\n1\tx\n2\ty" }, config);
    expect(tsv.rows).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    const json = ingest({ format: "json", text: JSON.stringify(sales.slice(0, 3)) }, config);
    expect(json.rows).toHaveLength(3);
  });

  it("ingests graphs, hierarchies and GeoJSON", () => {
    const g = ingest(network, config);
    expect(g.kind).toBe("graph");
    expect(g.rows).toHaveLength(network.nodes.length);
    expect(g.links).toHaveLength(network.links.length);
    const h = ingest({ format: "hierarchy", root: hierarchy }, config);
    expect(h.kind).toBe("hierarchy");
    expect(h.hierarchy).toBeDefined();
    const gj = ingest(geo, config);
    expect(gj.kind).toBe("geo");
    expect(gj.rows).toHaveLength(geo.features.length);
  });

  it("rejects links that reference unknown nodes", () => {
    expect(() => ingest({ nodes: [{ id: "a" }], links: [{ source: "a", target: "zzz" }] }, config)).toThrow(
      D3McpError,
    );
  });

  it("rejects unsupported input shapes with an actionable error", () => {
    expect(() => ingest("not data", config)).toThrow(D3McpError);
    expect(() => ingest(42, config)).toThrow(D3McpError);
  });

  it("enforces row limits", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ i }));
    expect(() => ingest(rows, { ...config, maxRows: 10 })).toThrow(/limit is 10/);
  });

  it("enforces input byte limits", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ i, s: "x".repeat(50) }));
    expect(() => ingest(rows, { ...config, maxInputBytes: 1000 })).toThrow(D3McpError);
  });

  it("records missing values without imputing them", () => {
    const ds = ingest([{ a: 1, b: "x" }, { a: null, b: "y" }, { a: 3 }], config);
    const p = profileDataset(ds);
    const a = p.fields.find((f) => f.name === "a")!;
    expect(a.missing).toBe(1);
    expect(ds.rows[1]!.a).toBeNull();
  });
});

describe("profileDataset", () => {
  it("infers types, summaries and temporal coverage", () => {
    const ds = ingest({ format: "csv", text: telemetryCsv() }, config);
    const p = profileDataset(ds);
    const byName = Object.fromEntries(p.fields.map((f) => [f.name, f]));
    expect(byName.timestamp!.type).toBe("temporal");
    expect(byName.latency_ms!.type).toBe("quantitative");
    expect(byName.site!.type).toBe("nominal");
    expect(byName.latency_ms!.numeric!.max).toBeGreaterThan(byName.latency_ms!.numeric!.min);
    expect(byName.latency_ms!.numeric!.outlierCount).toBeGreaterThan(0);
    expect(byName.timestamp!.temporal!.spanDays).toBeCloseTo(47 / 24, 1);
  });

  it("reports correlations descriptively", () => {
    const ds = ingest({ format: "csv", text: telemetryCsv() }, config);
    const p = profileDataset(ds);
    for (const c of p.correlations) {
      expect(Math.abs(c.pearson)).toBeLessThanOrEqual(1);
      expect(c.n).toBeGreaterThan(2);
    }
  });
});
