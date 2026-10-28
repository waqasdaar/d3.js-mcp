import * as d3 from "d3";
import type { Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import {
  checkMarkLimit,
  colorEncoder,
  decorate,
  drawAnnotations,
  drawAxes,
  drawLegend,
  encType,
  field,
  positionScale,
  requireField,
  title,
  tooltipFor,
} from "../svg/helpers.js";

interface P {
  row: Row;
  x: number;
  y: number;
  r: number;
  c: string;
  cat: string;
}

function renderScatter(ctx: RenderContext, mode: "scatter" | "bubble" | "connected"): RenderResult {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const sizeF = field(ctx, "size");
  const cf = field(ctx, "color");
  const lf = field(ctx, "label");
  const xType = encType(ctx, "x");
  const valid = ctx.rows.filter(
    (r) => r[xf] !== null && r[xf] !== undefined && toNumber(r[yf] ?? null) !== null,
  );
  if (valid.length < ctx.rows.length) {
    ctx.warnings.push(
      `${ctx.rows.length - valid.length} row(s) with missing/non-numeric ${xf} or ${yf} were not plotted.`,
    );
  }
  const canvas = ctx.spec.renderer === "canvas";
  if (!canvas) checkMarkLimit(ctx, valid.length, "points");
  const xs = positionScale(
    ctx,
    "x",
    valid.map((r) => r[xf] ?? null),
    [0, ctx.innerWidth],
    xType === "temporal" ? "temporal" : xType,
  );
  const ys = positionScale(
    ctx,
    "y",
    valid.map((r) => r[yf] ?? null),
    [ctx.innerHeight, 0],
    "quantitative",
  );
  const sizeScale = sizeF
    ? d3
        .scaleSqrt()
        .domain([0, d3.max(valid, (r) => toNumber(r[sizeF] ?? null) ?? 0) ?? 1])
        .range([2, Math.min(40, ctx.innerWidth / 15)])
    : null;
  if (mode === "bubble" && !sizeScale)
    ctx.warnings.push("Bubble chart without encoding.size: all bubbles have equal size.");
  const color = cf
    ? colorEncoder(
        ctx,
        valid.map((r) => r[cf] ?? null),
        encType(ctx, "color"),
      )
    : null;
  const pts: P[] = valid.map((r) => ({
    row: r,
    x: xs.map(r[xf] ?? null)! + xs.bandwidth / 2,
    y: ys.map(r[yf] ?? null)!,
    r: sizeScale
      ? sizeScale(Math.max(0, toNumber(r[sizeF!] ?? null) ?? 0))
      : mode === "bubble"
        ? 8
        : canvas
          ? 2
          : 3.5,
    c: color ? color.color(r[cf!] ?? null) : ctx.theme.accent,
    cat: cf ? toLabel(r[cf] ?? null) : "all",
  }));
  const g = ctx.plot.append("g").attr("class", "marks points");
  if (mode === "connected") {
    const of = field(ctx, "order");
    const ordered = of
      ? [...pts].sort((a, b) => (toNumber(a.row[of] ?? null) ?? 0) - (toNumber(b.row[of] ?? null) ?? 0))
      : pts;
    g.append("path")
      .attr("class", "connector")
      .attr("fill", "none")
      .attr("stroke", ctx.theme.muted)
      .attr("stroke-width", 1.5)
      .attr(
        "d",
        d3
          .line<P>()
          .x((p) => p.x)
          .y((p) => p.y)
          .curve(d3.curveCatmullRom)(ordered),
      );
  }
  let markCount: number;
  let markSelector = "circle.point";
  if (canvas) {
    // SVG fallback: one compact path per color (round-capped zero-length segments). The HTML artifact draws a <canvas>.
    const byColor = d3.group(pts, (p) => p.c);
    for (const [c, ps] of byColor) {
      const path = d3.path();
      for (const p of ps) {
        path.moveTo(p.x, p.y);
        path.lineTo(p.x + 0.01, p.y);
      }
      g.append("path")
        .attr("class", "point-cloud")
        .attr("stroke", c)
        .attr("stroke-width", pts[0]?.r ? pts[0].r * 2 : 4)
        .attr("stroke-linecap", "round")
        .attr("stroke-opacity", 0.7)
        .attr("d", path.toString());
    }
    markCount = byColor.size;
    markSelector = "path.point-cloud";
  } else {
    const circles = g
      .selectAll("circle")
      .data(pts)
      .join("circle")
      .attr("class", "point")
      .attr("cx", (p) => p.x)
      .attr("cy", (p) => p.y)
      .attr("r", (p) => p.r)
      .attr("fill", (p) => p.c)
      .attr("fill-opacity", mode === "bubble" ? 0.6 : 0.8)
      .attr("stroke", mode === "bubble" ? ctx.theme.stroke : "none");
    decorate(circles, (p, i) => ({
      tooltip: tooltipFor(ctx, p.row, [
        ...(lf ? ([[lf, p.row[lf] ?? null]] as const) : []),
        [xf, p.row[xf] ?? null],
        [title(ctx, "y"), p.row[yf] ?? null],
        ...(sizeF ? ([[sizeF, p.row[sizeF] ?? null]] as const) : []),
        ...(cf ? ([[cf, p.row[cf] ?? null]] as const) : []),
      ]),
      key: lf ? toLabel(p.row[lf] ?? null) : String(i),
      cat: p.cat,
      label: lf ? toLabel(p.row[lf] ?? null) : undefined,
    }));
    markCount = pts.length;
    if (lf && (ctx.spec.options.showLabels ?? pts.length <= 40)) {
      g.append("g")
        .attr("class", "labels")
        .attr("font-family", ctx.theme.font)
        .attr("font-size", 10)
        .attr("fill", ctx.theme.foreground)
        .selectAll("text")
        .data(pts.slice(0, ctx.spec.options.labelLimit ?? 40))
        .join("text")
        .attr("x", (p) => p.x + p.r + 3)
        .attr("y", (p) => p.y + 3)
        .text((p) => toLabel(p.row[lf] ?? null));
    }
  }
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: title(ctx, "y") });
  drawAnnotations(ctx, xs, ys);
  if (color) drawLegend(ctx, color, cf!);
  return {
    markCount,
    markSelector,
    meta: canvas
      ? {
          points: pts.length,
          canvasPoints: pts.map((p) => [
            Math.round(p.x * 10) / 10,
            Math.round(p.y * 10) / 10,
            p.r,
            p.c,
            tooltipFor(ctx, p.row, [
              [xf, p.row[xf] ?? null],
              [yf, p.row[yf] ?? null],
            ]),
          ]),
        }
      : { points: pts.length },
  };
}

const SCATTER_APIS = [
  "scaleLinear",
  "scaleSqrt",
  "scaleOrdinal",
  "linear.nice",
  "axisBottom",
  "axisLeft",
  "max",
  "select",
  "selection.append",
  "selection.attr",
  "selection.selectAll",
  "selection.data",
  "selection.join",
];

export const scatterRenderers: RendererPlugin[] = [
  {
    type: "scatter",
    family: "chart",
    label: "Scatterplot",
    description:
      "Relationship between two quantitative fields; optional color and labels. renderer:'canvas' for large point sets.",
    core: true,
    dataKinds: ["table", "graph", "geo"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    supportsCanvas: true,
    d3Apis: [...SCATTER_APIS, "path", "path.moveTo", "path.lineTo", "path.toString", "group"],
    render: (ctx) => renderScatter(ctx, "scatter"),
  },
  {
    type: "bubble",
    family: "chart",
    label: "Bubble chart",
    description: "Scatterplot with a third quantitative field encoded as area (sqrt scale).",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: SCATTER_APIS,
    render: (ctx) => renderScatter(ctx, "bubble"),
  },
  {
    type: "connected-scatter",
    family: "chart",
    label: "Connected scatterplot",
    description: "Scatterplot whose points are connected in order (e.g. by time) to show a trajectory.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: [...SCATTER_APIS, "line", "curveCatmullRom"],
    render: (ctx) => renderScatter(ctx, "connected"),
  },
];
