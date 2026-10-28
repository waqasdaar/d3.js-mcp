import * as d3 from "d3";
import { toLabel } from "../../core/data/values.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import {
  aggregateBy,
  checkMarkLimit,
  colorEncoder,
  decorate,
  drawAnnotations,
  drawAxes,
  drawLegend,
  encType,
  field,
  fmtValue,
  positionScale,
  requireField,
  title,
  tooltipFor,
} from "../svg/helpers.js";

function stackOffset(name: string | undefined) {
  switch (name) {
    case "expand":
      return d3.stackOffsetExpand;
    case "diverging":
      return d3.stackOffsetDiverging;
    case "silhouette":
      return d3.stackOffsetSilhouette;
    case "wiggle":
      return d3.stackOffsetWiggle;
    default:
      return d3.stackOffsetNone;
  }
}

export function stackOrder(name: string | undefined) {
  switch (name) {
    case "ascending":
      return d3.stackOrderAscending;
    case "descending":
      return d3.stackOrderDescending;
    case "insideOut":
      return d3.stackOrderInsideOut;
    case "reverse":
      return d3.stackOrderReverse;
    case "appearance":
      return d3.stackOrderAppearance;
    default:
      return d3.stackOrderNone;
  }
}

function renderBar(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  requireField(ctx, "y");
  const horizontal = ctx.spec.options.orientation === "horizontal";
  const agg = aggregateBy(ctx, [xf], "y");
  checkMarkLimit(ctx, agg.length, "bars");
  const cats = agg.map((a) => a.keys[0] ?? null);
  const vals = agg.map((a) => a.value);
  const catRange: [number, number] = horizontal ? [0, ctx.innerHeight] : [0, ctx.innerWidth];
  const valRange: [number, number] = horizontal ? [0, ctx.innerWidth] : [ctx.innerHeight, 0];
  const cat = positionScale(ctx, horizontal ? "y" : "x", cats, catRange, "nominal", { band: true });
  const val = positionScale(ctx, horizontal ? "x" : "y", vals, valRange, "quantitative", { zero: true });
  const cf = field(ctx, "color");
  const color = cf
    ? colorEncoder(
        ctx,
        agg.map((a) => a.rows[0]![cf] ?? null),
        encType(ctx, "color"),
      )
    : null;
  const base = val.map(0)!;
  const bars = ctx.plot
    .append("g")
    .attr("class", "marks bars")
    .selectAll("rect")
    .data(agg)
    .join("rect")
    .attr("class", "bar")
    .attr("fill", (d) => (color ? color.color(d.rows[0]![cf!] ?? null) : ctx.theme.accent));
  if (horizontal) {
    bars
      .attr("y", (d) => cat.map(d.keys[0] ?? null)!)
      .attr("height", cat.bandwidth)
      .attr("x", (d) => Math.min(base, val.map(d.value)!))
      .attr("width", (d) => Math.abs(val.map(d.value)! - base));
  } else {
    bars
      .attr("x", (d) => cat.map(d.keys[0] ?? null)!)
      .attr("width", cat.bandwidth)
      .attr("y", (d) => Math.min(base, val.map(d.value)!))
      .attr("height", (d) => Math.abs(val.map(d.value)! - base));
  }
  decorate(bars, (d) => ({
    tooltip: tooltipFor(ctx, d.rows[0]!, [
      [xf, d.keys[0] ?? null],
      [title(ctx, "y"), d.value],
    ]),
    key: toLabel(d.keys[0] ?? null),
    cat: cf ? toLabel(d.rows[0]![cf] ?? null) : toLabel(d.keys[0] ?? null),
    label: toLabel(d.keys[0] ?? null),
  }));
  if (horizontal) drawAxes(ctx, val, cat, { xTitle: title(ctx, "y"), yTitle: xf });
  else drawAxes(ctx, cat, val, { xTitle: xf, yTitle: title(ctx, "y") });
  drawAnnotations(ctx, horizontal ? val : cat, horizontal ? cat : val);
  if (color && cf !== xf) drawLegend(ctx, color, cf!);
  return { markCount: agg.length, markSelector: "rect.bar", meta: { categories: cats.length } };
}

function seriesField(ctx: RenderContext): string {
  const f = field(ctx, "series") ?? field(ctx, "color") ?? field(ctx, "group");
  if (!f) return requireField(ctx, "series");
  return f;
}

function renderGroupedBar(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  requireField(ctx, "y");
  const sf = seriesField(ctx);
  const agg = aggregateBy(ctx, [xf, sf], "y");
  checkMarkLimit(ctx, agg.length, "bars");
  const xs = positionScale(
    ctx,
    "x",
    agg.map((a) => a.keys[0] ?? null),
    [0, ctx.innerWidth],
    "nominal",
    { band: true },
  );
  const series = Array.from(new Set(agg.map((a) => toLabel(a.keys[1] ?? null))));
  const sub = d3.scaleBand<string>().domain(series).range([0, xs.bandwidth]).padding(0.05);
  const ys = positionScale(
    ctx,
    "y",
    agg.map((a) => a.value),
    [ctx.innerHeight, 0],
    "quantitative",
    { zero: true },
  );
  const color = colorEncoder(ctx, series, "nominal");
  const base = ys.map(0)!;
  const bars = ctx.plot
    .append("g")
    .attr("class", "marks bars")
    .selectAll("rect")
    .data(agg)
    .join("rect")
    .attr("class", "bar")
    .attr("x", (d) => xs.map(d.keys[0] ?? null)! + (sub(toLabel(d.keys[1] ?? null)) ?? 0))
    .attr("width", sub.bandwidth())
    .attr("y", (d) => Math.min(base, ys.map(d.value)!))
    .attr("height", (d) => Math.abs(ys.map(d.value)! - base))
    .attr("fill", (d) => color.color(d.keys[1] ?? null));
  decorate(bars, (d) => ({
    tooltip: tooltipFor(ctx, d.rows[0]!, [
      [xf, d.keys[0] ?? null],
      [sf, d.keys[1] ?? null],
      [title(ctx, "y"), d.value],
    ]),
    key: `${toLabel(d.keys[0] ?? null)}|${toLabel(d.keys[1] ?? null)}`,
    cat: toLabel(d.keys[1] ?? null),
  }));
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: title(ctx, "y") });
  drawAnnotations(ctx, xs, ys);
  drawLegend(ctx, color, sf);
  return { markCount: agg.length, markSelector: "rect.bar", meta: { series: series.length } };
}

function renderStackedBar(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  requireField(ctx, "y");
  const sf = seriesField(ctx);
  const agg = aggregateBy(ctx, [xf, sf], "y");
  const rowsOf = new Map(
    agg.map((a) => [`${toLabel(a.keys[0] ?? null)}\u0001${toLabel(a.keys[1] ?? null)}`, a.rows]),
  );
  const xKeys = Array.from(new Set(agg.map((a) => toLabel(a.keys[0] ?? null))));
  const sKeys = Array.from(new Set(agg.map((a) => toLabel(a.keys[1] ?? null))));
  checkMarkLimit(ctx, xKeys.length * sKeys.length, "bars");
  const pivot = d3.rollup(
    agg,
    (g) => g[0]!.value,
    (a) => toLabel(a.keys[0] ?? null),
    (a) => toLabel(a.keys[1] ?? null),
  );
  const stack = d3
    .stack<[string, Map<string, number>], string>()
    .keys(sKeys)
    .value(([, m], k) => m.get(k) ?? 0)
    .offset(stackOffset(ctx.spec.options.stackOffset))
    .order(stackOrder(ctx.spec.options.stackOrder));
  const layers = stack(xKeys.map((k) => [k, pivot.get(k) ?? new Map<string, number>()]));
  const yExt: [number, number] = [
    d3.min(layers, (l) => d3.min(l, (d) => d[0])) ?? 0,
    d3.max(layers, (l) => d3.max(l, (d) => d[1])) ?? 1,
  ];
  const xs = positionScale(ctx, "x", xKeys, [0, ctx.innerWidth], "nominal", { band: true });
  const ys = positionScale(ctx, "y", [], [ctx.innerHeight, 0], "quantitative", { domain: yExt, zero: true });
  const color = colorEncoder(ctx, sKeys, "nominal");
  const g = ctx.plot.append("g").attr("class", "marks stacks");
  let count = 0;
  for (const layer of layers) {
    const rects = g
      .append("g")
      .attr("class", "layer")
      .attr("fill", color.color(layer.key))
      .selectAll("rect")
      .data(layer)
      .join("rect")
      .attr("class", "bar")
      .attr("x", (d) => xs.map(d.data[0])!)
      .attr("width", xs.bandwidth)
      .attr("y", (d) => ys.map(d[1])!)
      .attr("height", (d) => Math.max(0, ys.map(d[0])! - ys.map(d[1])!))
      .each(function (d) {
        (this as SVGRectElement & { __linkRows?: unknown }).__linkRows = rowsOf.get(
          `${d.data[0]}\u0001${layer.key}`,
        );
      });
    decorate(rects, (d) => ({
      tooltip: `${xf}: ${d.data[0]}\n${sf}: ${layer.key}\n${title(ctx, "y")}: ${fmtValue(d.data[1].get(layer.key) ?? 0)}`,
      key: `${d.data[0]}|${layer.key}`,
      cat: layer.key,
    }));
    count += layer.length;
  }
  drawAxes(ctx, xs, ys, {
    xTitle: xf,
    yTitle: ctx.spec.options.stackOffset === "expand" ? `share of ${title(ctx, "y")}` : title(ctx, "y"),
  });
  drawAnnotations(ctx, xs, ys);
  drawLegend(ctx, color, sf);
  return { markCount: count, markSelector: "rect.bar", meta: { series: sKeys.length } };
}

function renderWaterfall(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const rows = ctx.rows.filter((r) => typeof r[yf] === "number");
  if (rows.length < ctx.rows.length)
    ctx.warnings.push(`${ctx.rows.length - rows.length} row(s) without numeric ${yf} were not plotted.`);
  checkMarkLimit(ctx, rows.length + 1, "bars");
  let running = 0;
  const steps = rows.map((r) => {
    const v = r[yf] as number;
    const start = running;
    running += v;
    return { label: toLabel(r[xf] ?? null), start, end: running, value: v, row: r, total: false };
  });
  steps.push({ label: "Total", start: 0, end: running, value: running, row: {}, total: true });
  const xs = positionScale(
    ctx,
    "x",
    steps.map((s) => s.label),
    [0, ctx.innerWidth],
    "nominal",
    { band: true },
  );
  const ys = positionScale(
    ctx,
    "y",
    steps.flatMap((s) => [s.start, s.end]),
    [ctx.innerHeight, 0],
    "quantitative",
    { zero: true },
  );
  const pos = "#2ca02c";
  const neg = "#d62728";
  const bars = ctx.plot
    .append("g")
    .attr("class", "marks bars")
    .selectAll("rect")
    .data(steps)
    .join("rect")
    .attr("class", (d) => (d.total ? "bar total" : "bar"))
    .attr("x", (d) => xs.map(d.label)!)
    .attr("width", xs.bandwidth)
    .attr("y", (d) => ys.map(Math.max(d.start, d.end))!)
    .attr("height", (d) => Math.max(1, Math.abs(ys.map(d.start)! - ys.map(d.end)!)))
    .attr("fill", (d) => (d.total ? ctx.theme.accent : d.value >= 0 ? pos : neg));
  decorate(bars, (d) => ({
    tooltip: d.total
      ? `Total: ${fmtValue(d.end)}`
      : tooltipFor(ctx, d.row, [
          [xf, d.label],
          [yf, d.value],
          ["running total", d.end],
        ]),
    key: d.label,
    cat: d.total ? "total" : d.value >= 0 ? "increase" : "decrease",
  }));
  ctx.plot
    .append("g")
    .attr("class", "connectors")
    .selectAll("line")
    .data(steps.slice(0, -1))
    .join("line")
    .attr("x1", (d) => xs.map(d.label)! + xs.bandwidth)
    .attr("x2", (_, i) => xs.map(steps[i + 1]!.label)!)
    .attr("y1", (d) => ys.map(d.end)!)
    .attr("y2", (d) => ys.map(d.end)!)
    .attr("stroke", ctx.theme.muted)
    .attr("stroke-dasharray", "2,2");
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: yf });
  drawAnnotations(ctx, xs, ys);
  return { markCount: steps.length, markSelector: "rect.bar", meta: { total: running } };
}

const BAR_APIS = [
  "scaleBand",
  "band.bandwidth",
  "band.padding",
  "scaleLinear",
  "linear.nice",
  "axisBottom",
  "axisLeft",
  "groups",
  "sum",
  "select",
  "selection.append",
  "selection.attr",
  "selection.selectAll",
  "selection.data",
  "selection.join",
];

export const barRenderers: RendererPlugin[] = [
  {
    type: "bar",
    family: "chart",
    label: "Bar chart",
    description: "Compare a quantitative measure across categories (vertical or horizontal).",
    core: true,
    dataKinds: ["table", "graph", "hierarchy", "geo"],
    requiredChannels: [["x", "y"]],
    usesLegend: true,
    d3Apis: BAR_APIS,
    render: renderBar,
  },
  {
    type: "grouped-bar",
    family: "chart",
    label: "Grouped bar chart",
    description: "Compare a measure across categories and sub-groups side by side.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["x", "y", "series"],
      ["x", "y", "color"],
    ],
    usesLegend: true,
    d3Apis: [...BAR_APIS, "scaleOrdinal", "schemeTableau10"],
    render: renderGroupedBar,
  },
  {
    type: "stacked-bar",
    family: "chart",
    label: "Stacked bar chart",
    description: "Show part-to-whole composition per category using d3.stack.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["x", "y", "series"],
      ["x", "y", "color"],
    ],
    usesLegend: true,
    d3Apis: [
      ...BAR_APIS,
      "stack",
      "stack.keys",
      "stack.value",
      "stack.offset",
      "stack.order",
      "stackOffsetNone",
      "stackOffsetExpand",
      "stackOrderNone",
      "rollup",
      "scaleOrdinal",
    ],
    render: renderStackedBar,
  },
  {
    type: "waterfall",
    family: "chart",
    label: "Waterfall chart",
    description: "Show how sequential positive and negative changes accumulate to a total.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x", "y"]],
    d3Apis: BAR_APIS,
    render: renderWaterfall,
  },
];
