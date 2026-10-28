import * as d3 from "d3";
import type { Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import {
  aggregateBy,
  checkMarkLimit,
  colorEncoder,
  decorate,
  drawAnnotations,
  drawAxes,
  drawLegend,
  field,
  fmtValue,
  positionScale,
  requireField,
  title,
} from "../svg/helpers.js";

function numericValues(ctx: RenderContext, f: string, rows: Row[] = ctx.rows): number[] {
  const vals = rows.map((r) => toNumber(r[f] ?? null)).filter((n): n is number => n !== null);
  if (vals.length < rows.length)
    ctx.warnings.push(`${rows.length - vals.length} missing/non-numeric value(s) of ${f} excluded.`);
  return vals;
}

function renderHistogram(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  const vals = numericValues(ctx, xf);
  const ext = d3.extent(vals) as [number, number];
  const nice = d3
    .scaleLinear()
    .domain(ext[0] === undefined ? [0, 1] : ext)
    .nice();
  const bin = d3
    .bin()
    .domain(nice.domain() as [number, number])
    .thresholds(ctx.spec.options.bins ?? d3.thresholdSturges);
  const bins = bin(vals);
  const xs = positionScale(ctx, "x", [], [0, ctx.innerWidth], "quantitative", {
    domain: nice.domain() as [number, number],
  });
  const ys = positionScale(
    ctx,
    "y",
    bins.map((b) => b.length),
    [ctx.innerHeight, 0],
    "quantitative",
    { zero: true },
  );
  const rects = ctx.plot
    .append("g")
    .attr("class", "marks bins")
    .selectAll("rect")
    .data(bins)
    .join("rect")
    .attr("class", "bar bin")
    .attr("x", (b) => xs.map(b.x0!)! + 0.5)
    .attr("width", (b) => Math.max(0, xs.map(b.x1!)! - xs.map(b.x0!)! - 1))
    .attr("y", (b) => ys.map(b.length)!)
    .attr("height", (b) => ys.map(0)! - ys.map(b.length)!)
    .attr("fill", ctx.theme.accent)
    .each(function (b, i) {
      const last = i === bins.length - 1;
      (this as SVGRectElement & { __linkRows?: Row[] }).__linkRows = ctx.rows.filter((r) => {
        const v = toNumber(r[xf] ?? null);
        return v !== null && v >= b.x0! && (last ? v <= b.x1! : v < b.x1!);
      });
    });
  decorate(rects, (b) => ({
    tooltip: `${xf}: ${fmtValue(b.x0!)} – ${fmtValue(b.x1!)}\ncount: ${b.length}`,
    key: `${b.x0}`,
  }));
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: "count" });
  drawAnnotations(ctx, xs, ys);
  return {
    markCount: bins.length,
    markSelector: "rect.bin",
    meta: { bins: bins.length, values: vals.length },
  };
}

function renderBoxplot(ctx: RenderContext): RenderResult {
  const yf = requireField(ctx, "y");
  const gf = field(ctx, "x") ?? field(ctx, "group");
  const groups = gf
    ? d3.groups(ctx.rows, (r) => toLabel(r[gf] ?? null))
    : [["all", ctx.rows] as [string, Row[]]];
  const stats = groups.map(([key, rows]) => {
    const v = numericValues(ctx, yf, rows).sort(d3.ascending);
    const q1 = d3.quantileSorted(v, 0.25) ?? 0;
    const med = d3.quantileSorted(v, 0.5) ?? 0;
    const q3 = d3.quantileSorted(v, 0.75) ?? 0;
    const iqr = q3 - q1;
    const lo = d3.min(v.filter((x) => x >= q1 - 1.5 * iqr)) ?? q1;
    const hi = d3.max(v.filter((x) => x <= q3 + 1.5 * iqr)) ?? q3;
    return { key, q1, med, q3, lo, hi, n: v.length, outliers: v.filter((x) => x < lo || x > hi), rows };
  });
  const xs = positionScale(
    ctx,
    "x",
    stats.map((s) => s.key),
    [0, ctx.innerWidth],
    "nominal",
    { band: true, padding: 0.3 },
  );
  const all = stats.flatMap((s) => [s.lo, s.hi, ...s.outliers]);
  const ys = positionScale(ctx, "y", all, [ctx.innerHeight, 0], "quantitative");
  const g = ctx.plot.append("g").attr("class", "marks boxes");
  const box = g
    .selectAll("g.box")
    .data(stats)
    .join("g")
    .attr("class", "box")
    .attr("transform", (s) => `translate(${xs.map(s.key)},0)`);
  const bw = xs.bandwidth;
  box
    .append("line")
    .attr("x1", bw / 2)
    .attr("x2", bw / 2)
    .attr("y1", (s) => ys.map(s.lo)!)
    .attr("y2", (s) => ys.map(s.hi)!)
    .attr("stroke", ctx.theme.muted);
  const rects = box
    .append("rect")
    .attr("class", "box-body")
    .attr("width", bw)
    .attr("y", (s) => ys.map(s.q3)!)
    .attr("height", (s) => Math.max(1, ys.map(s.q1)! - ys.map(s.q3)!))
    .attr("fill", ctx.theme.accent)
    .attr("fill-opacity", 0.35)
    .attr("stroke", ctx.theme.accent);
  decorate(rects, (s) => ({
    tooltip: `${gf ?? "group"}: ${s.key}\nn: ${s.n}\nmin (whisker): ${fmtValue(s.lo)}\nQ1: ${fmtValue(s.q1)}\nmedian: ${fmtValue(s.med)}\nQ3: ${fmtValue(s.q3)}\nmax (whisker): ${fmtValue(s.hi)}\noutliers: ${s.outliers.length}`,
    key: s.key,
    cat: s.key,
  }));
  box
    .append("line")
    .attr("class", "median")
    .attr("x1", 0)
    .attr("x2", bw)
    .attr("y1", (s) => ys.map(s.med)!)
    .attr("y2", (s) => ys.map(s.med)!)
    .attr("stroke", ctx.theme.foreground)
    .attr("stroke-width", 2);
  box
    .selectAll("circle")
    .data((s) => s.outliers.map((v) => ({ v, key: s.key })))
    .join("circle")
    .attr("class", "outlier")
    .attr("cx", bw / 2)
    .attr("cy", (d) => ys.map(d.v)!)
    .attr("r", 2.5)
    .attr("fill", "none")
    .attr("stroke", "#d62728");
  drawAxes(ctx, xs, ys, { xTitle: gf ?? "", yTitle: yf });
  drawAnnotations(ctx, xs, ys);
  return {
    markCount: stats.length,
    markSelector: "rect.box-body",
    meta: { groups: stats.length, rule: "Whiskers at most 1.5·IQR beyond quartiles" },
  };
}

function epanechnikov(bw: number) {
  return (v: number) => (Math.abs((v /= bw)) <= 1 ? (0.75 * (1 - v * v)) / bw : 0);
}

function renderDensity(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  const sf = field(ctx, "series") ?? field(ctx, "color");
  const groups = sf
    ? d3.groups(ctx.rows, (r) => toLabel(r[sf] ?? null))
    : [["all", ctx.rows] as [string, Row[]]];
  const allVals = numericValues(ctx, xf);
  const ext = d3.extent(allVals) as [number, number];
  const sd = d3.deviation(allVals) ?? 1;
  // Silverman's rule of thumb unless an explicit bandwidth is provided.
  const bw = ctx.spec.options.bandwidth ?? Math.max(1e-9, 1.06 * sd * Math.pow(allVals.length, -0.2));
  const ticks = d3.ticks(ext[0] - bw * 2, ext[1] + bw * 2, 120);
  const kernel = epanechnikov(bw);
  const curves = groups.map(([key, rows]) => {
    const v = rows.map((r) => toNumber(r[xf] ?? null)).filter((n): n is number => n !== null);
    return {
      key,
      n: v.length,
      pts: ticks.map((t) => [t, d3.mean(v, (x) => kernel(t - x)) ?? 0] as [number, number]),
    };
  });
  const xs2 = positionScale(ctx, "x", ticks, [0, ctx.innerWidth], "quantitative");
  const ys = positionScale(
    ctx,
    "y",
    curves.flatMap((c) => c.pts.map((p) => p[1])),
    [ctx.innerHeight, 0],
    "quantitative",
    { zero: true },
  );
  const color = colorEncoder(
    ctx,
    curves.map((c) => c.key),
    "nominal",
  );
  const area = d3
    .area<[number, number]>()
    .x((p) => xs2.map(p[0])!)
    .y0(ys.map(0)!)
    .y1((p) => ys.map(p[1])!)
    .curve(d3.curveBasis);
  const paths = ctx.plot
    .append("g")
    .attr("class", "marks densities")
    .selectAll("path")
    .data(curves)
    .join("path")
    .attr("class", "density")
    .attr("fill", (c) => color.color(c.key))
    .attr("fill-opacity", 0.35)
    .attr("stroke", (c) => color.color(c.key))
    .attr("d", (c) => area(c.pts));
  decorate(paths, (c) => ({
    tooltip: `${sf ?? "density"}: ${c.key}\nn: ${c.n}\nbandwidth: ${fmtValue(bw)}`,
    cat: c.key,
    key: c.key,
  }));
  drawAxes(ctx, xs2, ys, { xTitle: xf, yTitle: "density" });
  drawAnnotations(ctx, xs2, ys);
  if (sf) drawLegend(ctx, color, sf);
  return {
    markCount: curves.length,
    markSelector: "path.density",
    meta: { bandwidth: bw, kernel: "epanechnikov" },
  };
}

function renderHeatmap(ctx: RenderContext): RenderResult {
  const xf = requireField(ctx, "x");
  const yf = requireField(ctx, "y");
  const vch = ctx.spec.encoding.color ? "color" : "value";
  const cells = aggregateBy(ctx, [xf, yf], vch);
  checkMarkLimit(ctx, cells.length, "cells");
  const xs = positionScale(
    ctx,
    "x",
    cells.map((c) => c.keys[0] ?? null),
    [0, ctx.innerWidth],
    "nominal",
    { band: true, padding: 0.02 },
  );
  const ys = positionScale(
    ctx,
    "y",
    cells.map((c) => c.keys[1] ?? null),
    [0, ctx.innerHeight],
    "nominal",
    { band: true, padding: 0.02 },
  );
  const color = colorEncoder(
    ctx,
    cells.map((c) => c.value),
    "quantitative",
  );
  const rects = ctx.plot
    .append("g")
    .attr("class", "marks cells")
    .selectAll("rect")
    .data(cells)
    .join("rect")
    .attr("class", "cell")
    .attr("x", (c) => xs.map(c.keys[0] ?? null)!)
    .attr("y", (c) => ys.map(c.keys[1] ?? null)!)
    .attr("width", xs.bandwidth)
    .attr("height", ys.bandwidth)
    .attr("fill", (c) => color.color(c.value));
  decorate(rects, (c) => ({
    tooltip: `${xf}: ${toLabel(c.keys[0] ?? null)}\n${yf}: ${toLabel(c.keys[1] ?? null)}\n${title(ctx, vch)}: ${fmtValue(c.value)}`,
    key: `${toLabel(c.keys[0] ?? null)}|${toLabel(c.keys[1] ?? null)}`,
  }));
  drawAxes(ctx, xs, ys, { xTitle: xf, yTitle: yf });
  drawLegend(ctx, color, title(ctx, vch) || "value");
  return { markCount: cells.length, markSelector: "rect.cell", meta: { cells: cells.length } };
}

export const statRenderers: RendererPlugin[] = [
  {
    type: "histogram",
    family: "statistical",
    label: "Histogram",
    description: "Distribution of one quantitative field using d3.bin (Sturges thresholds by default).",
    core: true,
    dataKinds: ["table", "graph", "geo"],
    requiredChannels: [["x"]],
    d3Apis: [
      "bin",
      "bin.domain",
      "bin.thresholds",
      "thresholdSturges",
      "extent",
      "scaleLinear",
      "linear.nice",
      "axisBottom",
      "axisLeft",
    ],
    render: renderHistogram,
  },
  {
    type: "boxplot",
    family: "statistical",
    label: "Box plot",
    description: "Quartiles, median, 1.5·IQR whiskers and outliers per group.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["y"]],
    d3Apis: [
      "quantileSorted",
      "groups",
      "min",
      "max",
      "ascending",
      "scaleBand",
      "scaleLinear",
      "axisBottom",
      "axisLeft",
    ],
    render: renderBoxplot,
  },
  {
    type: "density",
    family: "statistical",
    label: "Density plot",
    description: "Kernel density estimate (Epanechnikov kernel, Silverman bandwidth) per series.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [["x"]],
    usesLegend: true,
    d3Apis: [
      "ticks",
      "mean",
      "deviation",
      "extent",
      "area",
      "curveBasis",
      "scaleLinear",
      "axisBottom",
      "axisLeft",
    ],
    render: renderDensity,
  },
  {
    type: "heatmap",
    family: "statistical",
    label: "Heatmap",
    description: "Matrix of two categorical dimensions colored by an aggregated measure.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["x", "y", "color"],
      ["x", "y", "value"],
    ],
    usesLegend: true,
    d3Apis: [
      "scaleBand",
      "scaleSequential",
      "interpolateViridis",
      "groups",
      "axisBottom",
      "axisLeft",
      "axisRight",
    ],
    render: renderHeatmap,
  },
];
