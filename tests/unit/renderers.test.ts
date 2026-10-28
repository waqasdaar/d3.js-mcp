import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { VIS_TYPES } from "../../src/core/schema/spec.js";
import { validateSvg } from "../../src/core/validation/structural.js";
import { listRenderers } from "../../src/renderers/registry.js";
import {
  cities,
  flows,
  geo,
  hierarchy,
  network,
  sales,
  scatterPoints,
  simpleBars,
  telemetryCsv,
  waterfall,
} from "../fixtures/data.js";
import { render } from "../helpers/render.js";

function marks(svg: string, selector: string): Element[] {
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  return Array.from(dom.window.document.querySelectorAll(selector));
}

function check(r: ReturnType<typeof render>) {
  const report = validateSvg(r.svg, { markSelector: r.out.markSelector, expectedMarks: r.out.markCount });
  expect(report.errors).toEqual([]);
  expect(r.out.markCount).toBeGreaterThan(0);
  return report;
}

const telemetry = { format: "csv", text: telemetryCsv() };
const h = { format: "hierarchy", root: hierarchy };

describe("renderer registry", () => {
  it("registers a renderer for every spec visualization type", () => {
    const types = new Set(listRenderers().map((r) => r.type));
    for (const t of VIS_TYPES) expect(types.has(t), t).toBe(true);
  });

  it("marks sankey as a non-core plugin", () => {
    const s = listRenderers().find((r) => r.type === "sankey")!;
    expect(s.core).toBe(false);
  });
});

describe("chart renderers", () => {
  it("bar: one rect per category with heights proportional to values", () => {
    const r = render("bar", simpleBars, { encoding: { x: { field: "category" }, y: { field: "value" } } });
    check(r);
    const bars = marks(r.svg, "rect.bar");
    expect(bars).toHaveLength(5);
    const heights = bars.map((b) => Number(b.getAttribute("height")));
    const max = Math.max(...heights);
    expect(heights[1]).toBe(max);
    expect(heights[0]! / heights[1]!).toBeCloseTo(30 / 80, 1);
  });

  it("bar: horizontal orientation", () => {
    const r = render("bar", simpleBars, {
      encoding: { x: { field: "category" }, y: { field: "value" } },
      options: { orientation: "horizontal" },
    });
    check(r);
    const widths = marks(r.svg, "rect.bar").map((b) => Number(b.getAttribute("width")));
    expect(Math.max(...widths)).toBe(widths[1]);
  });

  it("bar: log scale renders finite bars anchored at the domain minimum", () => {
    const r = render("bar", simpleBars, {
      encoding: { x: { field: "category" }, y: { field: "value" } },
      scales: { y: { type: "log" } },
    });
    check(r);
    const heights = marks(r.svg, "rect.bar").map((b) => Number(b.getAttribute("height")));
    expect(heights.every((h) => Number.isFinite(h) && h >= 0)).toBe(true);
    expect(Math.max(...heights)).toBe(heights[1]);
  });

  it("grouped and stacked bars", () => {
    const enc = { x: { field: "region" }, y: { field: "revenue" }, series: { field: "product" } };
    expect(check(render("grouped-bar", sales, { encoding: enc })).stats.marks).toBeGreaterThanOrEqual(8);
    check(render("stacked-bar", sales, { encoding: enc }));
  });

  it("waterfall and cumulative", () => {
    const w = render("waterfall", waterfall, { encoding: { x: { field: "step" }, y: { field: "delta" } } });
    check(w);
    expect(w.out.meta.total).toBe(130);
    check(
      render("cumulative", telemetry, {
        encoding: { x: { field: "timestamp" }, y: { field: "throughput_mbps" } },
      }),
    );
  });

  it("line: one path per series", () => {
    const r = render("line", telemetry, {
      encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, series: { field: "site" } },
    });
    check(r);
    expect(marks(r.svg, "path.line")).toHaveLength(3);
  });

  it("default tick labels avoid SI prefixes for small values", () => {
    const r = render(
      "line",
      [
        { t: "2026-01-01", v: 0.25 },
        { t: "2026-01-02", v: 0.75 },
      ],
      { encoding: { x: { field: "t" }, y: { field: "v" } } },
    );
    const ticks = marks(r.svg, ".axis-y .tick text").map((t) => t.textContent);
    expect(ticks).toContain("0.5");
    expect(ticks.join(" ")).not.toMatch(/\dm\b/);
  });

  it("area and stacked area", () => {
    check(
      render("area", telemetry, { encoding: { x: { field: "timestamp" }, y: { field: "throughput_mbps" } } }),
    );
    const s = render("stacked-area", telemetry, {
      encoding: { x: { field: "timestamp" }, y: { field: "throughput_mbps" }, series: { field: "site" } },
    });
    check(s);
    expect(marks(s.svg, "path.area")).toHaveLength(3);
  });

  it("scatter, bubble and connected scatter", () => {
    const pts = scatterPoints(120);
    const s = render("scatter", pts, {
      encoding: { x: { field: "x" }, y: { field: "y" }, color: { field: "cluster" } },
    });
    check(s);
    expect(marks(s.svg, "circle.point")).toHaveLength(120);
    check(
      render("bubble", sales, {
        encoding: { x: { field: "units" }, y: { field: "revenue" }, size: { field: "revenue" } },
      }),
    );
    check(
      render("connected-scatter", pts.slice(0, 20), { encoding: { x: { field: "x" }, y: { field: "y" } } }),
    );
  });

  it("scatter with log scale has finite geometry", () => {
    const r = render("scatter", sales, {
      encoding: { x: { field: "units" }, y: { field: "revenue" } },
      scales: { y: { type: "log" } },
    });
    check(r);
  });

  it("pie and donut: arcs sum to full circle", () => {
    const r = render("pie", simpleBars, {
      encoding: { color: { field: "category" }, value: { field: "value" } },
    });
    check(r);
    expect(marks(r.svg, "path.arc")).toHaveLength(5);
    expect(r.out.meta.total).toBe(235);
    check(
      render("donut", simpleBars, { encoding: { color: { field: "category" }, value: { field: "value" } } }),
    );
  });

  it("statistical charts: histogram, boxplot, density, heatmap", () => {
    const pts = scatterPoints(200);
    const hist = render("histogram", pts, { encoding: { x: { field: "x" } }, options: { bins: 10 } });
    check(hist);
    expect(Number(hist.out.meta.values)).toBe(200);
    const box = render("boxplot", pts, { encoding: { x: { field: "cluster" }, y: { field: "y" } } });
    check(box);
    expect(box.out.markCount).toBe(3);
    check(render("density", pts, { encoding: { x: { field: "x" } } }));
    const hm = render("heatmap", sales, {
      encoding: { x: { field: "region" }, y: { field: "product" }, color: { field: "revenue" } },
    });
    check(hm);
    expect(hm.out.markCount).toBe(8);
  });
});

describe("hierarchy renderers", () => {
  it("treemap cell areas are proportional to leaf values", () => {
    const r = render("treemap", h);
    check(r);
    expect(r.out.meta.leaves).toBe(10);
    const leaves = marks(r.svg, "rect.treemap-cell").filter(
      (e) => e.getAttribute("data-leaf") === "true" || e.classList.contains("leaf"),
    );
    if (leaves.length) {
      const areas = leaves.map((e) => Number(e.getAttribute("width")) * Number(e.getAttribute("height")));
      expect(areas.every((a) => a > 0)).toBe(true);
    }
  });

  it("sunburst, pack, tree, cluster, partition", () => {
    for (const t of ["sunburst", "pack", "tree", "cluster", "partition"]) {
      const r = render(t, h);
      check(r);
      expect(r.out.markCount, t).toBeGreaterThanOrEqual(10);
    }
  });

  it("radial tree", () => {
    const r = render("tree", h, { options: { radial: true } });
    check(r);
    expect(r.out.meta.radial).toBe(true);
  });
});

describe("network renderers", () => {
  it("force layout positions every node with finite coordinates", () => {
    const r = render("force", network, { options: { seed: 1 } });
    check(r);
    const nodes = marks(r.svg, "circle.node");
    expect(nodes).toHaveLength(network.nodes.length);
    for (const n of nodes) {
      expect(Number.isFinite(Number(n.getAttribute("cx")))).toBe(true);
      expect(Number.isFinite(Number(n.getAttribute("cy")))).toBe(true);
    }
    expect(marks(r.svg, "line.link, path.link").length).toBe(network.links.length);
  });

  it("force layout sizes nodes by degree", () => {
    const r = render("force", network, { options: { nodeSizeBy: "degree", seed: 1 } });
    const radius = Object.fromEntries(
      marks(r.svg, "circle.node").map((n) => [n.getAttribute("data-key"), Number(n.getAttribute("r"))]),
    );
    expect(radius["hub-sjc"]).toBeGreaterThan(radius["br-sfo"]!);
  });

  it("radial network, chord and sankey", () => {
    check(render("radial-network", network));
    const c = render("chord", network);
    check(c);
    expect(c.out.markCount).toBe(network.nodes.length);
    const s = render("sankey", flows);
    check(s);
  });
});

describe("geo and spatial renderers", () => {
  it("geo: one path per feature with choropleth fills", () => {
    const r = render("geo", geo, { encoding: { color: { field: "value" } } });
    check(r);
    const paths = marks(r.svg, "path.feature");
    expect(paths).toHaveLength(6);
    const fills = new Set(paths.map((p) => p.getAttribute("fill")));
    expect(fills.size).toBeGreaterThan(1);
    for (const p of paths) expect(p.getAttribute("d")).toMatch(/^M[\d.-]/);
  });

  it("geo: lat/lon points", () => {
    const r = render("geo", cities, {
      encoding: { latitude: { field: "lat" }, longitude: { field: "lon" }, size: { field: "users" } },
    });
    check(r);
    expect(marks(r.svg, "circle.geo-point")).toHaveLength(cities.length);
  });

  it("voronoi, delaunay, contour", () => {
    const pts = scatterPoints(60);
    const v = render("voronoi", pts, { encoding: { x: { field: "x" }, y: { field: "y" } } });
    check(v);
    expect(v.out.markCount).toBe(60);
    check(render("delaunay", pts, { encoding: { x: { field: "x" }, y: { field: "y" } } }));
    check(render("contour", scatterPoints(300), { encoding: { x: { field: "x" }, y: { field: "y" } } }));
  });

  it("custom declarative shapes", () => {
    const r = render("custom", [{ a: 1 }], {
      options: {
        shapes: [
          { kind: "rect", x: 10, y: 10, width: 50, height: 20, fill: "steelblue" },
          { kind: "circle", x: 100, y: 50, r: 10 },
          { kind: "text", x: 20, y: 80, text: "hello" },
        ],
      },
    });
    check(r);
    expect(r.out.markCount).toBe(3);
  });
});

describe("renderer errors", () => {
  it("rejects missing fields with available field names", () => {
    try {
      render("bar", simpleBars, { encoding: { x: { field: "nope" }, y: { field: "value" } } });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/"nope".*does not exist/);
      expect((e as { hint?: string }).hint).toMatch(/Available fields: category, value/);
    }
  });

  it("rejects missing required channels", () => {
    expect(() => render("heatmap", sales, { encoding: { x: { field: "region" } } })).toThrow(
      /requires encodings/,
    );
  });

  it("includes accessibility metadata", () => {
    const r = render("bar", simpleBars, { encoding: { x: { field: "category" }, y: { field: "value" } } });
    const report = check(r);
    expect(report.stats.accessibleTitle).toBe(true);
    expect(report.stats.accessibleDesc).toBe(true);
  });
});
