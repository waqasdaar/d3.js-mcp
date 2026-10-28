import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeCapabilities, queryApi } from "../../src/core/capabilities/registry.js";
import { executeComposition, OPS } from "../../src/core/composition/executor.js";
import { parseSpec } from "../../src/core/schema/spec.js";
import { validatePdf, validatePng, validateSvg } from "../../src/core/validation/structural.js";
import { applyTransforms } from "../../src/renderers/transforms.js";
import { D3McpError } from "../../src/shared/errors.js";
import { hierarchy, network, sales, scatterPoints } from "../fixtures/data.js";
import { ds } from "../helpers/render.js";

describe("spec schema", () => {
  it("applies defaults", () => {
    const s = parseSpec({ id: "a", type: "bar", data: { datasetId: "d" } });
    expect(s.schemaVersion).toBe("1.0");
    expect(s.layout.width).toBe(800);
    expect(s.interaction.tooltip).toBe(true);
    expect(s.accessibility.reducedMotion).toBe(true);
  });

  it("rejects unknown keys, bad ids and bad types", () => {
    expect(() => parseSpec({ id: "a", type: "bar", data: { datasetId: "d" }, evil: 1 })).toThrow();
    expect(() => parseSpec({ id: "../x", type: "bar", data: { datasetId: "d" } })).toThrow();
    expect(() => parseSpec({ id: "a", type: "nope", data: { datasetId: "d" } })).toThrow();
    expect(() =>
      parseSpec({ id: "a", type: "bar", data: { datasetId: "d" }, layout: { width: 10 } }),
    ).toThrow();
  });
});

describe("transforms", () => {
  it("filter, aggregate, sort and limit", () => {
    const { rows, applied } = applyTransforms(ds(sales).rows, [
      { type: "filter", field: "quarter", op: "eq", value: "Q1" },
      { type: "aggregate", groupBy: ["region"], field: "revenue", op: "sum", as: "total" },
      { type: "sort", field: "total", order: "descending" },
      { type: "limit", count: 2 },
    ]);
    expect(rows).toEqual([
      { region: "East", total: 220 },
      { region: "North", total: 200 },
    ]);
    expect(applied).toHaveLength(4);
  });
});

describe("composition executor", () => {
  const d = ds(scatterPoints(100));

  it("runs chained whitelisted operations and reports APIs used", () => {
    const r = executeComposition(
      {
        steps: [
          { id: "ext", op: "array.extent", input: "$data", field: "x" },
          { id: "mean", op: "array.mean", input: "$data", field: "x" },
        ],
      },
      d,
    );
    const ext = r.results.ext as [number, number];
    expect(ext[0]).toBeLessThan(ext[1]);
    expect(r.results.mean).toBeGreaterThan(ext[0]);
    expect(r.d3ApisUsed).toEqual(expect.arrayContaining(["extent", "mean"]));
  });

  it("supports hierarchy and force layouts", () => {
    const h = ds({ format: "hierarchy", root: hierarchy });
    const layoutOps = Object.keys(OPS).filter((k) => k.startsWith("hierarchy."));
    expect(layoutOps.length).toBeGreaterThan(0);
    const r = executeComposition({ steps: [{ id: "l", op: layoutOps[0]!, input: "$hierarchy" }] }, h);
    expect(r.results.l).toBeDefined();
    const g = ds(network);
    const forceOp = Object.keys(OPS).find((k) => k.startsWith("force."));
    if (forceOp) {
      const f = executeComposition(
        { steps: [{ id: "f", op: forceOp, input: "$data", args: { links: "$links", iterations: 50 } }] },
        g,
      );
      expect(f.results.f).toBeDefined();
    }
  });

  it("every operation is reachable through the schema", () => {
    expect(Object.keys(OPS).length).toBeGreaterThan(40);
    for (const [name, op] of Object.entries(OPS)) {
      expect(op.apis.length, name).toBeGreaterThan(0);
      expect(op.description, name).toBeTruthy();
    }
  });

  it("rejects unknown ops, forward references and duplicate ids", () => {
    expect(() => executeComposition({ steps: [{ id: "a", op: "eval", input: [] }] })).toThrow();
    expect(() => executeComposition({ steps: [{ id: "a", op: "array.sum", input: "$b" }] })).toThrow(
      D3McpError,
    );
    expect(() =>
      executeComposition({
        steps: [
          { id: "a", op: "array.sum", input: [1] },
          { id: "a", op: "array.sum", input: [1] },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it("truncates oversized results", () => {
    const r = executeComposition(
      {
        steps: [
          { id: "a", op: Object.keys(OPS).find((k) => k.startsWith("random."))!, args: { count: 5000 } },
        ],
      },
      undefined,
      500,
    );
    expect(r.truncated).toContain("a");
  });
});

describe("capability registry", () => {
  const report = computeCapabilities();

  it("has exact totals that sum to the inventory size", () => {
    const t = report.totals;
    const sum =
      t["implemented-and-tested"] +
      t["implemented-with-constraints"] +
      t["available-through-safe-composition"] +
      t["documented-but-not-yet-implemented"] +
      t["unsupported-by-current-runtime"];
    expect(sum).toBe(t.total);
    expect(t.total).toBeGreaterThan(1000);
  });

  it("covers every documented module family", () => {
    const mods = new Set(report.modules.map((m) => m.module));
    for (const m of [
      "d3-array",
      "d3-axis",
      "d3-brush",
      "d3-chord",
      "d3-color",
      "d3-contour",
      "d3-delaunay",
      "d3-dispatch",
      "d3-drag",
      "d3-dsv",
      "d3-ease",
      "d3-fetch",
      "d3-force",
      "d3-format",
      "d3-geo",
      "d3-hierarchy",
      "d3-interpolate",
      "d3-path",
      "d3-polygon",
      "d3-quadtree",
      "d3-random",
      "d3-scale",
      "d3-scale-chromatic",
      "d3-selection",
      "d3-shape",
      "d3-time",
      "d3-time-format",
      "d3-timer",
      "d3-transition",
      "d3-zoom",
    ]) {
      expect(mods.has(m), m).toBe(true);
    }
  });

  it("only marks APIs used by renderers as implemented-and-tested", () => {
    for (const e of report.entries.filter((x) => x.status === "implemented-and-tested")) {
      expect(
        e.usedBy.some((u) => u.startsWith("renderer:")),
        e.symbol,
      ).toBe(true);
    }
    for (const e of report.entries.filter((x) => x.module === "d3-fetch"))
      expect(e.status).toBe("unsupported-by-current-runtime");
  });

  it("every usage key maps to an inventory entry", () => {
    expect(report.unmatchedUsageKeys).toEqual([]);
  });

  it("queryApi finds symbols and modules", () => {
    expect(queryApi("scaleLinear")[0]!.normalized).toBe("scaleLinear");
    expect(queryApi("d3-force").every((e) => e.module === "d3-force")).toBe(true);
  });

  it("the committed coverage report matches the current registry", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../data/d3-api-coverage.json", import.meta.url), "utf8"),
    ) as { totals: { total: number } };
    expect(committed.totals.total).toBe(report.totals.total);
  });
});

describe("structural validation", () => {
  it("accepts a minimal valid SVG and flags NaN geometry", () => {
    const ok = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" role="img"><title>t</title><desc>d</desc><rect width="5" height="5"/></svg>',
    );
    expect(ok.valid).toBe(true);
    const bad = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="NaN" height="5"/></svg>',
    );
    expect(bad.valid).toBe(false);
  });

  it("rejects non-PNG and non-PDF buffers", () => {
    expect(validatePng(Buffer.from("hello")).valid).toBe(false);
    expect(validatePdf(Buffer.from("hello")).valid).toBe(false);
  });
});
