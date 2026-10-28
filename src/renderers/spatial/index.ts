import * as d3 from "d3";
import type { Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import {
  checkMarkLimit,
  colorEncoder,
  decorate,
  drawAxes,
  drawLegend,
  encType,
  field,
  fmtValue,
  positionScale,
  requireField,
  tooltipFor,
} from "../svg/helpers.js";

interface SP {
  row: Row;
  x: number;
  y: number;
}

function projectPoints(ctx: RenderContext) {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const valid = ctx.rows.filter((r) => toNumber(r[xf] ?? null) !== null && toNumber(r[yf] ?? null) !== null);
  if (valid.length < ctx.rows.length)
    ctx.warnings.push(`${ctx.rows.length - valid.length} row(s) with missing ${xf}/${yf} excluded.`);
  const xs = positionScale(
    ctx,
    "x",
    valid.map((r) => r[xf] ?? null),
    [0, ctx.innerWidth],
    "quantitative",
  );
  const ys = positionScale(
    ctx,
    "y",
    valid.map((r) => r[yf] ?? null),
    [ctx.innerHeight, 0],
    "quantitative",
  );
  const pts: SP[] = valid.map((r) => ({ row: r, x: xs.map(r[xf] ?? null)!, y: ys.map(r[yf] ?? null)! }));
  return { xf, yf, xs, ys, pts };
}

function renderVoronoi(ctx: RenderContext, mode: "voronoi" | "delaunay"): RenderResult {
  const { xf, yf, xs, ys, pts } = projectPoints(ctx);
  checkMarkLimit(ctx, pts.length * 2, "cells");
  const delaunay = d3.Delaunay.from(
    pts,
    (p) => p.x,
    (p) => p.y,
  );
  const cf = field(ctx, "color");
  const color = cf
    ? colorEncoder(
        ctx,
        pts.map((p) => p.row[cf] ?? null),
        encType(ctx, "color"),
      )
    : null;
  const g = ctx.plot.append("g").attr("class", "marks spatial");
  let markCount: number;
  let markSelector: string;
  if (mode === "voronoi") {
    const voronoi = delaunay.voronoi([0, 0, ctx.innerWidth, ctx.innerHeight]);
    const cells = g
      .append("g")
      .attr("class", "cells")
      .selectAll("path")
      .data(pts)
      .join("path")
      .attr("class", "voronoi-cell")
      .attr("d", (_, i) => voronoi.renderCell(i))
      .attr("fill", (p) => (color ? color.color(p.row[cf!] ?? null) : ctx.theme.accent))
      .attr("fill-opacity", 0.25)
      .attr("stroke", ctx.theme.muted)
      .attr("stroke-width", 0.6);
    decorate(cells, (p, i) => ({
      tooltip: tooltipFor(ctx, p.row, [
        [xf, p.row[xf] ?? null],
        [yf, p.row[yf] ?? null],
      ]),
      key: String(i),
      cat: cf ? toLabel(p.row[cf] ?? null) : undefined,
    }));
    markCount = pts.length;
    markSelector = "path.voronoi-cell";
  } else {
    const tris: Array<[number, number, number]> = [];
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      tris.push([delaunay.triangles[i]!, delaunay.triangles[i + 1]!, delaunay.triangles[i + 2]!]);
    }
    const paths = g
      .append("g")
      .attr("class", "triangles")
      .selectAll("path")
      .data(tris)
      .join("path")
      .attr("class", "delaunay-triangle")
      .attr("d", (_, i) => delaunay.renderTriangle(i))
      .attr("fill", ctx.theme.accent)
      .attr("fill-opacity", 0.08)
      .attr("stroke", ctx.theme.accent)
      .attr("stroke-width", 0.7);
    decorate(paths, (t, i) => ({ tooltip: `triangle ${i}\nvertices: ${t.join(", ")}`, key: `tri-${i}` }));
    g.append("path")
      .attr("class", "hull")
      .attr("fill", "none")
      .attr("stroke", ctx.theme.foreground)
      .attr("stroke-width", 1.5)
      .attr("d", delaunay.renderHull());
    markCount = tris.length;
    markSelector = "path.delaunay-triangle";
  }
  g.append("g")
    .attr("class", "sites")
    .selectAll("circle")
    .data(pts)
    .join("circle")
    .attr("class", "site")
    .attr("cx", (p) => p.x)
    .attr("cy", (p) => p.y)
    .attr("r", 2.2)
    .attr("fill", ctx.theme.foreground);
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: yf });
  if (color) drawLegend(ctx, color, cf!);
  return {
    markCount,
    markSelector,
    meta: { sites: pts.length, triangles: delaunay.triangles.length / 3, hullSize: delaunay.hull.length },
  };
}

function renderContour(ctx: RenderContext): RenderResult {
  const { xf, yf, xs, ys, pts } = projectPoints(ctx);
  const bw = ctx.spec.options.bandwidth ?? 20;
  const density = d3
    .contourDensity<SP>()
    .x((p) => p.x)
    .y((p) => p.y)
    .size([ctx.innerWidth, ctx.innerHeight])
    .bandwidth(bw)
    .thresholds(ctx.spec.options.thresholds ?? 12)(pts);
  const color = colorEncoder(
    ctx,
    density.map((d) => d.value),
    "quantitative",
  );
  const geoPath = d3.geoPath();
  const paths = ctx.plot
    .append("g")
    .attr("class", "marks contours")
    .selectAll("path")
    .data(density)
    .join("path")
    .attr("class", "contour")
    .attr("d", (d) => geoPath(d) ?? "")
    .attr("fill", (d) => color.color(d.value))
    .attr("fill-opacity", 0.75)
    .attr("stroke", ctx.theme.background)
    .attr("stroke-width", 0.5);
  decorate(paths, (d, i) => ({
    tooltip: `density ≥ ${fmtValue(d.value)} (points per px², bandwidth ${bw}px)`,
    key: `level-${i}`,
  }));
  if (ctx.spec.options.showPoints ?? pts.length <= 2000) {
    ctx.plot
      .append("g")
      .attr("class", "points")
      .selectAll("circle")
      .data(pts)
      .join("circle")
      .attr("cx", (p) => p.x)
      .attr("cy", (p) => p.y)
      .attr("r", 1.2)
      .attr("fill", ctx.theme.foreground)
      .attr("fill-opacity", 0.4);
  }
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: yf });
  drawLegend(ctx, color, "density");
  return {
    markCount: density.length,
    markSelector: "path.contour",
    meta: { levels: density.length, bandwidth: bw, points: pts.length },
  };
}

const SYMBOLS = {
  circle: d3.symbolCircle,
  cross: d3.symbolCross,
  diamond: d3.symbolDiamond,
  square: d3.symbolSquare,
  star: d3.symbolStar,
  triangle: d3.symbolTriangle,
  wye: d3.symbolWye,
} as const;

function safeColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const parsed = d3.color(c);
  return parsed ? parsed.formatHex8() : fallback;
}

function renderCustom(ctx: RenderContext): RenderResult {
  const shapes = ctx.spec.options.shapes ?? [];
  if (!shapes.length) ctx.warnings.push("Custom visualization has no options.shapes; nothing to draw.");
  const g = ctx.plot.append("g").attr("class", "marks custom");
  const sel = g
    .selectAll("g.shape")
    .data(shapes)
    .join("g")
    .attr("class", "shape")
    .each(function (s) {
      const el = d3.select(this);
      const fill = safeColor(s.fill, ctx.theme.accent);
      const stroke = safeColor(s.stroke, "none");
      switch (s.kind) {
        case "rect":
          el.append("rect")
            .attr("x", s.x)
            .attr("y", s.y)
            .attr("width", s.width ?? 10)
            .attr("height", s.height ?? 10)
            .attr("fill", fill)
            .attr("stroke", stroke);
          break;
        case "circle":
          el.append("circle")
            .attr("cx", s.x)
            .attr("cy", s.y)
            .attr("r", s.r ?? 5)
            .attr("fill", fill)
            .attr("stroke", stroke);
          break;
        case "line":
          el.append("line")
            .attr("x1", s.x)
            .attr("y1", s.y)
            .attr("x2", s.x2 ?? s.x)
            .attr("y2", s.y2 ?? s.y)
            .attr("stroke", safeColor(s.stroke, ctx.theme.foreground));
          break;
        case "text":
          el.append("text")
            .attr("x", s.x)
            .attr("y", s.y)
            .attr("fill", safeColor(s.fill, ctx.theme.foreground))
            .attr("font-family", ctx.theme.font)
            .attr("font-size", 12)
            .text(s.text ?? "");
          break;
        case "symbol":
          el.append("path")
            .attr("transform", `translate(${s.x},${s.y})`)
            .attr("d", d3.symbol(SYMBOLS[s.symbol ?? "circle"], s.size ?? 64)())
            .attr("fill", fill)
            .attr("stroke", stroke);
          break;
      }
    });
  decorate(sel, (s, i) => ({ tooltip: s.tooltip ?? `${s.kind} ${i}`, key: `shape-${i}` }));
  return { markCount: shapes.length, markSelector: "g.shape", meta: { shapes: shapes.length } };
}

export const spatialRenderers: RendererPlugin[] = [
  {
    type: "voronoi",
    family: "spatial",
    label: "Voronoi diagram",
    description: "Voronoi tessellation of 2D points (d3-delaunay), clipped to the plot area.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: [
      "Delaunay.from",
      "delaunay.voronoi",
      "voronoi.renderCell",
      "scaleLinear",
      "axisBottom",
      "axisLeft",
    ],
    render: (ctx) => renderVoronoi(ctx, "voronoi"),
  },
  {
    type: "delaunay",
    family: "spatial",
    label: "Delaunay triangulation",
    description: "Delaunay triangulation and convex hull of 2D points.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    d3Apis: [
      "Delaunay.from",
      "delaunay.triangles",
      "delaunay.renderTriangle",
      "delaunay.renderHull",
      "delaunay.hull",
      "scaleLinear",
    ],
    render: (ctx) => renderVoronoi(ctx, "delaunay"),
  },
  {
    type: "contour",
    family: "spatial",
    label: "Density contours",
    description: "2D kernel density contours (d3.contourDensity) for dense point clouds.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: [
      "contourDensity",
      "density.x",
      "density.y",
      "density.size",
      "density.bandwidth",
      "density.thresholds",
      "geoPath",
      "scaleSequential",
      "interpolateViridis",
    ],
    render: renderContour,
  },
  {
    type: "custom",
    family: "custom",
    label: "Custom SVG primitives",
    description: "Declarative rect/circle/line/text/symbol primitives (no user code execution).",
    core: true,
    dataKinds: ["table", "graph", "hierarchy", "geo"],
    requiredChannels: [],
    d3Apis: [
      "symbol",
      "symbolCircle",
      "symbolCross",
      "symbolDiamond",
      "symbolSquare",
      "symbolStar",
      "symbolTriangle",
      "symbolWye",
      "color",
      "color.formatHex8",
    ],
    render: renderCustom,
  },
];
