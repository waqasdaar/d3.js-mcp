import * as d3 from "d3";
import type { Row, Scalar } from "../../core/data/types.js";
import { toDate, toLabel, toNumber } from "../../core/data/values.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import { stackOrder } from "./bar.js";
import {
  checkMarkLimit,
  colorEncoder,
  curveFactory,
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

interface Pt {
  x: Scalar | Date;
  xKey: number | string;
  y: number | null;
  row: Row;
  series: string;
}

function points(
  ctx: RenderContext,
  cumulative: boolean,
): { pts: Pt[]; xType: ReturnType<typeof encType>; sf?: string } {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const sf = field(ctx, "series") ?? field(ctx, "color");
  const xType = encType(ctx, "x");
  const pts: Pt[] = ctx.rows.map((r) => {
    const raw = r[xf] ?? null;
    const x = xType === "temporal" ? toDate(raw) : raw;
    const xKey = x instanceof Date ? +x : typeof x === "number" ? x : toLabel(x);
    return { x, xKey, y: toNumber(r[yf] ?? null), row: r, series: sf ? toLabel(r[sf] ?? null) : "all" };
  });
  const order =
    xType === "nominal" || xType === "ordinal"
      ? null
      : (a: Pt, b: Pt) => (a.xKey as number) - (b.xKey as number);
  if (order) pts.sort(order);
  const missing = pts.filter((p) => p.y === null).length;
  if (missing)
    ctx.warnings.push(`${missing} point(s) have missing ${yf}; lines show gaps there (no interpolation).`);
  if (cumulative) {
    for (const [, g] of d3.group(pts, (p) => p.series)) {
      const sums = d3.cumsum(g, (p) => p.y ?? 0);
      g.forEach((p, i) => {
        if (p.y !== null) p.y = sums[i]!;
      });
    }
    ctx.warnings.push(`Values of "${yf}" are shown as running totals per series (d3.cumsum).`);
  }
  return { pts, xType, ...(sf ? { sf } : {}) };
}

function renderLineLike(ctx: RenderContext, mode: "line" | "area" | "cumulative"): RenderResult {
  const { pts, xType, sf } = points(ctx, mode === "cumulative");
  checkMarkLimit(ctx, pts.length, "points");
  const xf = requireField(ctx, "x");
  const xs = positionScale(
    ctx,
    "x",
    pts.map((p) => p.x),
    [0, ctx.innerWidth],
    xType,
    xType === "nominal" ? { band: false } : {},
  );
  const xPoint =
    xType === "nominal" || xType === "ordinal"
      ? positionScale(
          ctx,
          "x",
          pts.map((p) => p.x),
          [0, ctx.innerWidth],
          "nominal",
        )
      : xs;
  const xpos = (p: Pt) => xPoint.map(p.x)! + xPoint.bandwidth / 2;
  const ys = positionScale(
    ctx,
    "y",
    pts.map((p) => p.y),
    [ctx.innerHeight, 0],
    "quantitative",
    { zero: mode !== "line" },
  );
  const groups = d3.group(pts, (p) => p.series);
  const color = sf ? colorEncoder(ctx, [...groups.keys()], "nominal") : null;
  const curve = curveFactory(
    ctx.spec.options.curve ?? (mode === "line" || mode === "cumulative" ? "linear" : "monotoneX"),
  );
  const line = d3
    .line<Pt>()
    .defined((p) => p.y !== null)
    .x(xpos)
    .y((p) => ys.map(p.y)!)
    .curve(curve);
  const area = d3
    .area<Pt>()
    .defined((p) => p.y !== null)
    .x(xpos)
    .y0(ys.map(Math.max(0, (ys.domain[0] as number) ?? 0))!)
    .y1((p) => ys.map(p.y)!)
    .curve(curve);
  const g = ctx.plot.append("g").attr("class", "marks series");
  for (const [key, gpts] of groups) {
    const c = color ? color.color(key) : ctx.theme.accent;
    if (mode === "area") {
      g.append("path")
        .attr("class", "area")
        .attr("data-cat", key)
        .attr("fill", c)
        .attr("fill-opacity", 0.3)
        .attr("d", area(gpts));
    }
    const path = g
      .append("path")
      .datum(gpts)
      .attr("class", "line")
      .attr("fill", "none")
      .attr("stroke", c)
      .attr("stroke-width", 2)
      .attr("d", line);
    decorate(path, () => ({
      tooltip: sf ? `${sf}: ${key}` : title(ctx, "y"),
      cat: key,
      key: `series:${key}`,
    }));
  }
  const showPoints = ctx.spec.options.showPoints ?? pts.length <= 300;
  let pointCount = 0;
  if (showPoints) {
    const circles = g
      .append("g")
      .attr("class", "points")
      .selectAll("circle")
      .data(pts.filter((p) => p.y !== null))
      .join("circle")
      .attr("class", "point")
      .attr("cx", xpos)
      .attr("cy", (p) => ys.map(p.y)!)
      .attr("r", 3)
      .attr("fill", (p) => (color ? color.color(p.series) : ctx.theme.accent));
    decorate(circles, (p) => ({
      tooltip: tooltipFor(ctx, p.row, [
        [xf, p.x instanceof Date ? p.x.toISOString().slice(0, 19).replace("T00:00:00", "") : (p.x as Scalar)],
        [mode === "cumulative" ? `cumulative ${title(ctx, "y")}` : title(ctx, "y"), p.y],
        ...(sf ? ([[sf, p.series]] as Array<[string, Scalar]>) : []),
      ]),
      key: `${p.series}|${p.xKey}`,
      cat: p.series,
      t: p.x instanceof Date ? +p.x : null,
    }));
    pointCount = circles.size();
  }
  drawAxes(ctx, xs, ys, {
    xTitle: xf,
    yTitle: mode === "cumulative" ? `cumulative ${title(ctx, "y")}` : title(ctx, "y"),
  });
  drawAnnotations(ctx, xs, ys);
  if (color && groups.size > 1) drawLegend(ctx, color, sf!);
  return {
    markCount: groups.size,
    markSelector: "path.line",
    meta: { series: groups.size, points: pts.length, pointMarks: pointCount },
  };
}

function renderStackedArea(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const sf = field(ctx, "series") ?? field(ctx, "color") ?? requireField(ctx, "series");
  const xType = encType(ctx, "x");
  const keyOf = (r: Row) => {
    const v = r[xf] ?? null;
    return xType === "temporal" ? +(toDate(v) ?? 0) : (toNumber(v) ?? 0);
  };
  const series = Array.from(new Set(ctx.rows.map((r) => toLabel(r[sf] ?? null))));
  const pivot = d3.rollup(
    ctx.rows,
    (g) => d3.sum(g, (r) => toNumber(r[yf] ?? null) ?? 0),
    keyOf,
    (r) => toLabel(r[sf] ?? null),
  );
  const xKeys = [...pivot.keys()].sort((a, b) => a - b);
  checkMarkLimit(ctx, xKeys.length * series.length, "points");
  const stack = d3
    .stack<number, string>()
    .keys(series)
    .value((x, k) => pivot.get(x)?.get(k) ?? 0)
    .order(stackOrder(ctx.spec.options.stackOrder))
    .offset(
      ctx.spec.options.stackOffset === "expand"
        ? d3.stackOffsetExpand
        : ctx.spec.options.stackOffset === "wiggle"
          ? d3.stackOffsetWiggle
          : ctx.spec.options.stackOffset === "silhouette"
            ? d3.stackOffsetSilhouette
            : d3.stackOffsetNone,
    );
  const layers = stack(xKeys);
  const xs = positionScale(
    ctx,
    "x",
    xKeys.map((k) => (xType === "temporal" ? new Date(k) : k)),
    [0, ctx.innerWidth],
    xType === "temporal" ? "temporal" : "quantitative",
  );
  const yExt: [number, number] = [
    d3.min(layers, (l) => d3.min(l, (d) => d[0])) ?? 0,
    d3.max(layers, (l) => d3.max(l, (d) => d[1])) ?? 1,
  ];
  const ys = positionScale(ctx, "y", [], [ctx.innerHeight, 0], "quantitative", { domain: yExt });
  const color = colorEncoder(ctx, series, "nominal");
  const area = d3
    .area<d3.SeriesPoint<number>>()
    .x((d) => xs.map(xType === "temporal" ? new Date(d.data) : d.data)!)
    .y0((d) => ys.map(d[0])!)
    .y1((d) => ys.map(d[1])!)
    .curve(curveFactory(ctx.spec.options.curve ?? "monotoneX"));
  const paths = ctx.plot
    .append("g")
    .attr("class", "marks layers")
    .selectAll("path")
    .data(layers)
    .join("path")
    .attr("class", "area")
    .attr("fill", (l) => color.color(l.key))
    .attr("d", (l) => area(l))
    .each(function (l) {
      (this as SVGPathElement & { __linkRows?: Row[] }).__linkRows = ctx.rows.filter(
        (r) => toLabel(r[sf] ?? null) === l.key,
      );
    });
  decorate(paths, (l) => ({
    tooltip: `${sf}: ${l.key}\ntotal ${yf}: ${d3.format(",~r")(d3.sum(l, (d) => d[1] - d[0]))}`,
    cat: l.key,
    key: `series:${l.key}`,
  }));
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: yf });
  drawAnnotations(ctx, xs, ys);
  drawLegend(ctx, color, sf);
  return { markCount: layers.length, markSelector: "path.area", meta: { series: series.length } };
}

const LINE_APIS = [
  "line",
  "line.x",
  "line.y",
  "line.defined",
  "line.curve",
  "curveLinear",
  "curveMonotoneX",
  "scaleUtc",
  "scaleLinear",
  "linear.nice",
  "axisBottom",
  "axisLeft",
  "group",
  "extent",
  "select",
  "selection.append",
  "selection.attr",
  "selection.datum",
  "selection.data",
  "selection.join",
];

export const lineRenderers: RendererPlugin[] = [
  {
    type: "line",
    family: "chart",
    label: "Line / multi-line chart",
    description: "Show trends over an ordered (usually temporal) dimension; one line per series.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: LINE_APIS,
    render: (ctx) => renderLineLike(ctx, "line"),
  },
  {
    type: "area",
    family: "chart",
    label: "Area chart",
    description: "Line chart with filled area to the baseline; emphasises magnitude over time.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: [...LINE_APIS, "area", "area.x", "area.y0", "area.y1", "area.defined", "area.curve"],
    render: (ctx) => renderLineLike(ctx, "area"),
  },
  {
    type: "cumulative",
    family: "chart",
    label: "Cumulative line chart",
    description: "Running total of a measure over an ordered dimension (d3.cumsum).",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: [...LINE_APIS, "cumsum"],
    render: (ctx) => renderLineLike(ctx, "cumulative"),
  },
  {
    type: "stacked-area",
    family: "chart",
    label: "Stacked area chart",
    description: "Composition of several series over time using d3.stack.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["x", "y", "series"],
      ["x", "y", "color"],
    ],
    usesLegend: true,
    d3Apis: [
      ...LINE_APIS,
      "area",
      "stack",
      "stack.keys",
      "stack.value",
      "stack.order",
      "stack.offset",
      "stackOffsetNone",
      "rollup",
      "sum",
      "scaleOrdinal",
    ],
    render: renderStackedArea,
  },
];
