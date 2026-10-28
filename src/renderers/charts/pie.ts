import * as d3 from "d3";
import { toLabel } from "../../core/data/values.js";
import type { Row } from "../../core/data/types.js";
import type { Channel } from "../../core/schema/spec.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import {
  aggregateBy,
  colorEncoder,
  decorate,
  drawLegend,
  enc,
  fmtValue,
  requireField,
} from "../svg/helpers.js";

type Slice = { label: string; value: number; rows: Row[] };

function renderPie(ctx: RenderContext, donut: boolean): RenderResult {
  const catCh: Channel = enc(ctx, "color") ? "color" : enc(ctx, "x") ? "x" : "label";
  const valCh: Channel = enc(ctx, "value") ? "value" : "y";
  const cf = requireField(ctx, catCh);
  const agg = aggregateBy(ctx, [cf], valCh);
  const negatives = agg.filter((a) => a.value < 0);
  if (negatives.length) {
    ctx.warnings.push(
      `${negatives.length} negative value(s) cannot be shown as slices and were excluded; consider a bar chart.`,
    );
  }
  const slices: Slice[] = agg
    .filter((a) => a.value >= 0)
    .map((a) => ({ label: toLabel(a.keys[0] ?? null), value: a.value, rows: a.rows }));
  if (slices.length > 7) {
    ctx.warnings.push(
      `${slices.length} slices make angle comparison difficult; a sorted bar chart is recommended.`,
    );
  }
  const total = d3.sum(slices, (s) => s.value);
  const r = Math.min(ctx.innerWidth, ctx.innerHeight) / 2;
  const inner = donut ? r * (ctx.spec.options.innerRadius ?? 0.55) : r * (ctx.spec.options.innerRadius ?? 0);
  const pie = d3
    .pie<Slice>()
    .value((s) => s.value)
    .sort(null);
  const arcs = pie(slices);
  const arc = d3
    .arc<d3.PieArcDatum<Slice>>()
    .innerRadius(inner)
    .outerRadius(r)
    .padAngle(0.005)
    .cornerRadius(2);
  const labelArc = d3
    .arc<d3.PieArcDatum<Slice>>()
    .innerRadius(inner + (r - inner) * 0.55)
    .outerRadius(inner + (r - inner) * 0.55);
  const color = colorEncoder(
    ctx,
    slices.map((s) => s.label),
    "nominal",
  );
  const g = ctx.plot
    .append("g")
    .attr("class", "marks arcs")
    .attr("transform", `translate(${ctx.innerWidth / 2},${ctx.innerHeight / 2})`);
  const paths = g
    .selectAll("path")
    .data(arcs)
    .join("path")
    .attr("class", "arc")
    .attr("fill", (a) => color.color(a.data.label))
    .attr("stroke", ctx.theme.stroke)
    .attr("d", arc);
  decorate(paths, (a) => ({
    tooltip: `${cf}: ${a.data.label}\n${valCh === "value" ? (enc(ctx, "value")?.field ?? "value") : (enc(ctx, "y")?.field ?? "value")}: ${fmtValue(a.data.value)}\nshare: ${d3.format(".1%")(total ? a.data.value / total : 0)}`,
    key: a.data.label,
    cat: a.data.label,
    label: a.data.label,
  }));
  g.append("g")
    .attr("class", "labels")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 11)
    .attr("text-anchor", "middle")
    .selectAll("text")
    .data(arcs.filter((a) => a.endAngle - a.startAngle > 0.3))
    .join("text")
    .attr("transform", (a) => `translate(${labelArc.centroid(a)})`)
    .attr("fill", "#fff")
    .text((a) => d3.format(".0%")(total ? a.data.value / total : 0));
  if (donut) {
    g.append("text")
      .attr("class", "donut-total")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-family", ctx.theme.font)
      .attr("font-size", 16)
      .attr("font-weight", 600)
      .attr("fill", ctx.theme.foreground)
      .text(d3.format(",~r")(total));
  }
  drawLegend(ctx, color, cf);
  return { markCount: arcs.length, markSelector: "path.arc", meta: { total } };
}

const PIE_APIS = [
  "pie",
  "pie.value",
  "pie.sort",
  "arc",
  "arc.innerRadius",
  "arc.outerRadius",
  "arc.padAngle",
  "arc.cornerRadius",
  "arc.centroid",
  "sum",
  "format",
  "scaleOrdinal",
  "schemeTableau10",
];

export const pieRenderers: RendererPlugin[] = [
  {
    type: "pie",
    family: "chart",
    label: "Pie chart",
    description: "Part-to-whole for a few (≤7) non-negative categories. Prefer bars for precise comparison.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["color", "value"],
      ["x", "y"],
      ["color", "y"],
      ["label", "value"],
    ],
    usesLegend: true,
    d3Apis: PIE_APIS,
    render: (ctx) => renderPie(ctx, false),
  },
  {
    type: "donut",
    family: "chart",
    label: "Donut chart",
    description: "Pie chart with an inner radius and total in the center.",
    core: true,
    dataKinds: ["table"],
    requiredChannels: [
      ["color", "value"],
      ["x", "y"],
      ["color", "y"],
      ["label", "value"],
    ],
    usesLegend: true,
    d3Apis: PIE_APIS,
    render: (ctx) => renderPie(ctx, true),
  },
];
