import * as d3 from "d3";
import type { AxisDomain, AxisScale, Selection } from "d3";
import { profileField } from "../../core/data/profile.js";
import type { Row, Scalar } from "../../core/data/types.js";
import { toDate, toLabel, toNumber } from "../../core/data/values.js";
import type { Channel, FieldEncoding } from "../../core/schema/spec.js";
import { D3McpError } from "../../shared/errors.js";
import type { GSel, RenderContext } from "../types.js";

const D3 = d3 as unknown as Record<string, unknown>;

export type EncType = "quantitative" | "temporal" | "nominal" | "ordinal";

export function enc(ctx: RenderContext, ch: Channel): FieldEncoding | undefined {
  return ctx.spec.encoding[ch];
}

export function field(ctx: RenderContext, ch: Channel): string | undefined {
  return ctx.spec.encoding[ch]?.field;
}

export function requireField(ctx: RenderContext, ch: Channel): string {
  const f = field(ctx, ch);
  if (!f) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Visualization type "${ctx.spec.type}" requires encoding.${ch}`,
      `Set encoding.${ch}.field to one of the dataset fields.`,
    );
  }
  return f;
}

export function encType(ctx: RenderContext, ch: Channel, rows: Row[] = ctx.rows): EncType {
  const e = enc(ctx, ch);
  if (!e) return "nominal";
  if (e.type) return e.type;
  if (e.aggregate) return "quantitative";
  const t = profileField(e.field, rows).type;
  if (t === "quantitative" || t === "temporal") return t;
  return "nominal";
}

export function title(ctx: RenderContext, ch: Channel): string {
  const e = enc(ctx, ch);
  if (!e) return "";
  if (e.title) return e.title;
  return e.aggregate && e.aggregate !== "count"
    ? `${e.aggregate}(${e.field})`
    : e.aggregate === "count"
      ? "count"
      : e.field;
}

export function checkMarkLimit(ctx: RenderContext, n: number, what = "marks"): void {
  if (n > ctx.limits.maxSvgMarks) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Rendering would create ${n} SVG ${what}; the limit is ${ctx.limits.maxSvgMarks}`,
      "Aggregate the data (histogram, heatmap, contour density) or use renderer:'canvas' for scatterplots.",
    );
  }
}

const siFormat = d3.format("~s");
const plainFormat = d3.format(",~r");
/** SI prefixes only for large magnitudes; small values such as 0.5 stay "0.5" rather than "500m". */
export function defaultNumberFormat(n: number): string {
  return Math.abs(n) >= 1e4 ? siFormat(n) : plainFormat(n);
}

/** Safe d3-format / d3-time-format factory: invalid specifiers raise an actionable error. */
export function numberFormatter(spec: string | undefined): (n: number) => string {
  if (!spec) return defaultNumberFormat;
  try {
    return d3.format(spec);
  } catch {
    throw new D3McpError(
      "INVALID_INPUT",
      `Invalid d3-format specifier "${spec}"`,
      "See https://d3js.org/d3-format",
    );
  }
}

export function timeFormatter(spec: string | undefined): ((d: Date) => string) | null {
  if (!spec) return null;
  return d3.utcFormat(spec);
}

export function fmtValue(v: Scalar, format?: string): string {
  if (typeof v === "number")
    return format ? numberFormatter(format)(v) : d3.format(",~r")(Math.round(v * 1000) / 1000);
  return toLabel(v);
}

export interface PosScale {
  kind: "band" | "point" | "time" | "linear";
  map(v: Scalar | Date): number | null;
  bandwidth: number;
  axis: AxisScale<AxisDomain>;
  domain: unknown[];
  range: [number, number];
  invertible: boolean;
}

export function positionScale(
  ctx: RenderContext,
  axis: "x" | "y",
  values: Array<Scalar | Date>,
  range: [number, number],
  type: EncType,
  opts: { band?: boolean; zero?: boolean; padding?: number; domain?: [number, number] } = {},
): PosScale {
  const s = ctx.spec.scales[axis] ?? {};
  const requested = s.type;
  const discrete =
    opts.band || requested === "band" || requested === "point" || type === "nominal" || type === "ordinal";
  if (discrete && requested !== "linear" && requested !== "log" && requested !== "time") {
    const domain = (s.domain?.map(String) ??
      Array.from(new Set(values.map((v) => toLabel(v as Scalar))))) as string[];
    if (requested === "point") {
      const p = d3.scalePoint<string>().domain(domain).range(range).padding(0.5);
      return {
        kind: "point",
        map: (v) => p(toLabel(v as Scalar)) ?? null,
        bandwidth: 0,
        axis: p as unknown as AxisScale<AxisDomain>,
        domain,
        range,
        invertible: false,
      };
    }
    const b = d3
      .scaleBand<string>()
      .domain(domain)
      .range(range)
      .padding(opts.padding ?? 0.15);
    return {
      kind: "band",
      map: (v) => b(toLabel(v as Scalar)) ?? null,
      bandwidth: b.bandwidth(),
      axis: b as unknown as AxisScale<AxisDomain>,
      domain,
      range,
      invertible: false,
    };
  }
  if (type === "temporal" || requested === "time" || requested === "utc") {
    const dates = values.map((v) => (v instanceof Date ? v : toDate(v))).filter((d): d is Date => d !== null);
    const ext = (s.domain ? s.domain.map((d) => toDate(d)) : d3.extent(dates)) as [Date, Date];
    if (!ext[0] || !ext[1]) throw new D3McpError("INCOMPATIBLE_DATA", `No valid dates for the ${axis} axis`);
    const t = d3.scaleUtc().domain(ext).range(range);
    if (s.nice !== false) t.nice();
    return {
      kind: "time",
      map: (v) => {
        const d = v instanceof Date ? v : toDate(v);
        return d ? t(d) : null;
      },
      bandwidth: 0,
      axis: t as unknown as AxisScale<AxisDomain>,
      domain: t.domain().map((d) => +d),
      range,
      invertible: true,
    };
  }
  const nums = values.map((v) => toNumber(v as Scalar)).filter((n): n is number => n !== null);
  let domain: [number, number] =
    opts.domain ??
    (s.domain ? [Number(s.domain[0]), Number(s.domain[1])] : (d3.extent(nums) as [number, number]));
  if (domain[0] === undefined || Number.isNaN(domain[0])) domain = [0, 1];
  // A log scale cannot include zero; bar baselines are anchored at the domain minimum instead.
  const zero = requested === "log" ? false : (s.zero ?? opts.zero ?? false);
  if (zero && !s.domain) domain = [Math.min(0, domain[0]), Math.max(0, domain[1])];
  if (domain[0] === domain[1]) domain = [domain[0] - 1, domain[1] + 1];
  let sc: d3.ScaleContinuousNumeric<number, number>;
  switch (requested) {
    case "log": {
      if (domain[0] <= 0) {
        throw new D3McpError(
          "INCOMPATIBLE_DATA",
          `Log scale on ${axis} requires strictly positive values; minimum is ${domain[0]}`,
          "Use scales." + axis + '.type = "symlog" for data containing zero or negatives.',
        );
      }
      sc = d3.scaleLog().domain(domain);
      break;
    }
    case "pow":
      sc = d3
        .scalePow()
        .exponent(s.exponent ?? 2)
        .domain(domain);
      break;
    case "sqrt":
      sc = d3.scaleSqrt().domain(domain);
      break;
    case "symlog":
      sc = d3.scaleSymlog().domain(domain) as unknown as d3.ScaleContinuousNumeric<number, number>;
      break;
    default:
      sc = d3.scaleLinear().domain(domain);
  }
  sc.range(s.reverse ? [range[1], range[0]] : range);
  if (s.nice !== false) sc.nice();
  return {
    kind: "linear",
    map: (v) => {
      const n = v instanceof Date ? +v : toNumber(v as Scalar);
      if (n === null) return null;
      return requested === "log" && n <= 0 ? sc(sc.domain()[0]!) : sc(n);
    },
    bandwidth: 0,
    axis: sc as unknown as AxisScale<AxisDomain>,
    domain: sc.domain(),
    range,
    invertible: true,
  };
}

export function curveFactory(name: string | undefined): d3.CurveFactory {
  switch (name) {
    case "monotoneX":
      return d3.curveMonotoneX;
    case "step":
      return d3.curveStep;
    case "basis":
      return d3.curveBasis;
    case "cardinal":
      return d3.curveCardinal;
    case "catmullRom":
      return d3.curveCatmullRom;
    case "natural":
      return d3.curveNatural;
    default:
      return d3.curveLinear;
  }
}

function validColor(c: string): string {
  if (d3.color(c) === null) throw new D3McpError("INVALID_INPUT", `Invalid color "${c}"`);
  return d3.color(c)!.formatHex8();
}

function schemeArray(name: string, k: number): readonly string[] | null {
  const s = D3[`scheme${name}`];
  if (!Array.isArray(s)) return null;
  if (typeof s[0] === "string") return s as string[];
  const idx = Math.max(3, Math.min(k, s.length - 1));
  const arr = (s as Array<readonly string[] | undefined>)[idx];
  return arr ?? null;
}

function interpolator(name: string | undefined, fallback: (t: number) => string): (t: number) => string {
  if (!name) return fallback;
  const f = D3[`interpolate${name}`];
  if (typeof f !== "function") {
    throw new D3McpError(
      "INVALID_INPUT",
      `Unknown d3-scale-chromatic interpolator "${name}"`,
      "Examples: Viridis, Blues, RdBu, Turbo",
    );
  }
  return f as (t: number) => string;
}

export interface ColorEncoder {
  kind: "categorical" | "continuous";
  color(v: Scalar): string;
  categories?: string[];
  domain?: [number, number];
  interpolate?: (t: number) => string;
}

export function colorEncoder(ctx: RenderContext, values: Scalar[], type: EncType): ColorEncoder {
  const cs = ctx.spec.scales.color ?? {};
  if (type === "quantitative" && cs.type !== "ordinal") {
    const nums = values.map(toNumber).filter((n): n is number => n !== null);
    const ext = (cs.domain ? [Number(cs.domain[0]), Number(cs.domain.at(-1))] : d3.extent(nums)) as [
      number,
      number,
    ];
    const lo = ext[0] ?? 0;
    const hi = ext[1] ?? 1;
    if (cs.type === "threshold" || cs.type === "quantize" || cs.type === "quantile") {
      const k = cs.thresholds ? cs.thresholds.length + 1 : 5;
      const range = cs.range?.map(validColor) ?? [
        ...(schemeArray(cs.scheme ?? "Blues", k) ?? d3.schemeBlues[5]!),
      ];
      let sc: (n: number) => string;
      if (cs.type === "threshold") {
        sc = d3
          .scaleThreshold<number, string>()
          .domain(cs.thresholds ?? d3.ticks(lo, hi, range.length - 1))
          .range(range);
      } else if (cs.type === "quantile") {
        sc = d3.scaleQuantile<string>().domain(nums).range(range);
      } else {
        sc = d3.scaleQuantize<string>().domain([lo, hi]).range(range);
      }
      return {
        kind: "continuous",
        color: (v) => (toNumber(v) === null ? ctx.theme.grid : sc(toNumber(v)!)),
        domain: [lo, hi],
        interpolate: (t) => sc(lo + t * (hi - lo)),
      };
    }
    if (cs.type === "diverging") {
      const mid =
        cs.domain && cs.domain.length === 3 ? Number(cs.domain[1]) : lo < 0 && hi > 0 ? 0 : (lo + hi) / 2;
      const interp = interpolator(cs.scheme, d3.interpolateRdBu);
      const sc = d3.scaleDiverging(interp).domain([lo, mid, hi]);
      return {
        kind: "continuous",
        color: (v) => (toNumber(v) === null ? ctx.theme.grid : sc(toNumber(v)!)),
        domain: [lo, hi],
        interpolate: interp,
      };
    }
    const interp = interpolator(cs.scheme, d3.interpolateViridis);
    const sc = d3.scaleSequential(interp).domain([lo, hi]);
    return {
      kind: "continuous",
      color: (v) => (toNumber(v) === null ? ctx.theme.grid : sc(toNumber(v)!)),
      domain: [lo, hi],
      interpolate: interp,
    };
  }
  const cats = (cs.domain?.map(String) ?? Array.from(new Set(values.map(toLabel)))) as string[];
  let range: readonly string[];
  if (cs.range) range = cs.range.map(validColor);
  else if (cs.scheme) {
    const arr = schemeArray(cs.scheme, cats.length);
    if (!arr)
      throw new D3McpError(
        "INVALID_INPUT",
        `Unknown categorical scheme "${cs.scheme}"`,
        "Examples: Tableau10, Category10, Set2, Dark2",
      );
    range = arr;
  } else range = d3.schemeTableau10;
  const ord = d3.scaleOrdinal<string, string>().domain(cats).range(range);
  return { kind: "categorical", color: (v) => ord(toLabel(v)), categories: cats };
}

export function tooltipFor(
  ctx: RenderContext,
  row: Row,
  primary: ReadonlyArray<readonly [string, Scalar]> = [],
): string {
  const parts = primary.map(([k, v]) => `${k}: ${fmtValue(v)}`);
  const extra = ctx.spec.encoding.tooltip ?? [];
  for (const f of extra) if (!primary.some(([k]) => k === f)) parts.push(`${f}: ${fmtValue(row[f] ?? null)}`);
  return parts.join("\n");
}

export interface MarkInfo {
  tooltip: string;
  key?: string;
  cat?: string;
  t?: number | null;
  label?: string;
}

/** Apply common mark attributes used by tooltips, keyboard navigation, highlighting and linked views. */
export function decorate<E extends d3.BaseType, D>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sel: Selection<E, D, any, any>,
  info: (d: D, i: number) => MarkInfo,
): void {
  sel.each(function (d, i) {
    const m = info(d, i);
    const el = d3.select(this as Element);
    el.classed("mark", true)
      .attr("data-tooltip", m.tooltip)
      .attr("role", "graphics-symbol")
      .attr("aria-label", m.tooltip.replace(/\n/g, "; "));
    el.attr("tabindex", 0);
    if (m.key !== undefined) el.attr("data-key", m.key);
    if (m.cat !== undefined) el.attr("data-cat", m.cat);
    if (m.t !== undefined && m.t !== null) el.attr("data-t", m.t);
    if (m.label !== undefined) el.attr("data-label", m.label);
  });
}

export function applyHighlight(ctx: RenderContext): void {
  const hl = ctx.spec.interaction.highlight;
  if (!hl || hl.length === 0) return;
  const set = new Set(hl.map(String));
  ctx.plot.selectAll<Element, unknown>(".mark").each(function () {
    const el = d3.select(this);
    const key = el.attr("data-key");
    const cat = el.attr("data-cat");
    const label = el.attr("data-label");
    const hit = (key && set.has(key)) || (cat && set.has(cat)) || (label && set.has(label));
    el.classed("highlighted", !!hit).classed("dimmed", !hit);
    if (hit) el.attr("stroke", ctx.theme.foreground).attr("stroke-width", 2);
    else el.attr("opacity", 0.35);
  });
}

export function drawAxes(
  ctx: RenderContext,
  x: PosScale | null,
  y: PosScale | null,
  opts: { xTitle?: string; yTitle?: string } = {},
): void {
  const { innerWidth: w, innerHeight: h, theme } = ctx;
  const ax = ctx.spec.axes.x ?? { show: true };
  const ay = ctx.spec.axes.y ?? { show: true };
  const xFmt = ctx.spec.axes.x?.format ?? ctx.spec.encoding.x?.format;
  const yFmt = ctx.spec.axes.y?.format ?? ctx.spec.encoding.y?.format;
  const styleAxis = (g: GSel) => {
    g.attr("font-family", theme.font).attr("font-size", 11).attr("color", theme.muted);
    g.selectAll("text").attr("fill", theme.muted);
  };
  const formatFor = (s: PosScale, f: string | undefined) => {
    if (!f) return null;
    if (s.kind === "time") {
      const tf = timeFormatter(f)!;
      return (d: AxisDomain) => tf(d as Date);
    }
    if (s.kind === "linear") {
      const nf = numberFormatter(f);
      return (d: AxisDomain) => nf(Number(d));
    }
    return null;
  };
  if (x && ax.show !== false) {
    const axis = d3.axisBottom(x.axis);
    if (ax.ticks !== undefined) axis.ticks(ax.ticks);
    else if (x.kind === "linear" || x.kind === "time") axis.ticks(Math.max(2, Math.floor(w / 90)));
    const f = formatFor(x, xFmt);
    if (f) axis.tickFormat(f);
    if (x.kind === "band" && x.domain.length > 40) {
      const every = Math.ceil(x.domain.length / 40);
      axis.tickValues((x.domain as string[]).filter((_, i) => i % every === 0) as unknown as AxisDomain[]);
    }
    const g = ctx.plot
      .append("g")
      .attr("class", "axis axis-x")
      .attr("transform", `translate(0,${h})`)
      .call(axis);
    styleAxis(g);
    const longest = d3.max(x.domain.map((d) => String(d).length)) ?? 0;
    if (
      (x.kind === "band" || x.kind === "point") &&
      (x.domain.length > 10 || longest * 6.5 > x.bandwidth + 8)
    ) {
      g.selectAll("text")
        .attr("text-anchor", "end")
        .attr("transform", "rotate(-40)")
        .attr("dx", "-0.4em")
        .attr("dy", "0.6em");
    }
    if (ax.grid) {
      ctx.plot
        .insert("g", ":first-child")
        .attr("class", "grid grid-x")
        .attr("transform", `translate(0,${h})`)
        .call(axis.tickSize(-h).tickFormat(() => ""))
        .call((gg) => gg.select(".domain").remove())
        .selectAll("line")
        .attr("stroke", theme.grid);
    }
    const t = ax.title ?? opts.xTitle;
    if (t) {
      ctx.plot
        .append("text")
        .attr("class", "axis-title axis-title-x")
        .attr("x", w)
        .attr("y", h + ctx.margin.bottom - 10)
        .attr("text-anchor", "end")
        .attr("fill", theme.foreground)
        .attr("font-family", theme.font)
        .attr("font-size", 12)
        .text(t);
    }
  }
  if (y && ay.show !== false) {
    const axis = d3.axisLeft(y.axis);
    if (ay.ticks !== undefined) axis.ticks(ay.ticks);
    else if (y.kind === "linear" || y.kind === "time") axis.ticks(Math.max(2, Math.floor(h / 50)));
    const f = formatFor(y, yFmt);
    if (f) axis.tickFormat(f);
    else if (y.kind === "linear") axis.tickFormat((d) => defaultNumberFormat(Number(d)));
    const g = ctx.plot.append("g").attr("class", "axis axis-y").call(axis);
    styleAxis(g);
    if (ay.grid !== false && y.kind === "linear") {
      ctx.plot
        .insert("g", ":first-child")
        .attr("class", "grid grid-y")
        .call(
          d3
            .axisLeft(y.axis)
            .ticks(Math.max(2, Math.floor(h / 50)))
            .tickSize(-w)
            .tickFormat(() => ""),
        )
        .call((gg) => gg.select(".domain").remove())
        .selectAll("line")
        .attr("stroke", theme.grid);
    }
    const t = ay.title ?? opts.yTitle;
    if (t) {
      ctx.plot
        .append("text")
        .attr("class", "axis-title axis-title-y")
        .attr("x", -ctx.margin.left + 8)
        .attr("y", -14)
        .attr("text-anchor", "start")
        .attr("fill", theme.foreground)
        .attr("font-family", theme.font)
        .attr("font-size", 12)
        .text(t);
    }
  }
  if (x && y) {
    ctx.plot
      .attr("data-x-kind", x.kind)
      .attr("data-x-domain", x.invertible ? JSON.stringify(x.domain.map(Number)) : null)
      .attr("data-x-range", JSON.stringify(x.range));
  }
}

export function drawLegend(ctx: RenderContext, color: ColorEncoder, legendTitle: string): void {
  if (!ctx.spec.legend.show) return;
  const { theme } = ctx;
  const g = ctx.svg
    .append("g")
    .attr("class", "legend")
    .attr("font-family", theme.font)
    .attr("font-size", 11)
    .attr("transform", `translate(${ctx.width - ctx.margin.right + 16},${ctx.margin.top})`);
  g.append("text")
    .attr("class", "legend-title")
    .attr("fill", theme.foreground)
    .attr("font-weight", 600)
    .text(legendTitle);
  if (color.kind === "categorical" && color.categories) {
    const maxItems = Math.max(1, Math.floor((ctx.innerHeight - 20) / 18));
    const cats = color.categories.slice(0, maxItems);
    const item = g
      .selectAll("g.legend-item")
      .data(cats)
      .join("g")
      .attr("class", "legend-item")
      .attr("data-cat", (d) => d)
      .attr("transform", (_, i) => `translate(0,${16 + i * 18})`);
    item
      .append("rect")
      .attr("width", 12)
      .attr("height", 12)
      .attr("rx", 2)
      .attr("fill", (d) => color.color(d));
    item
      .append("text")
      .attr("x", 18)
      .attr("y", 10)
      .attr("fill", theme.muted)
      .text((d) => (d.length > 18 ? d.slice(0, 17) + "…" : d));
    if (color.categories.length > cats.length) {
      g.append("text")
        .attr("y", 16 + cats.length * 18 + 10)
        .attr("fill", theme.muted)
        .text(`+${color.categories.length - cats.length} more`);
    }
  } else if (color.domain && color.interpolate) {
    const id = `grad-${ctx.spec.id}`;
    const n = 10;
    const grad = ctx.svg
      .select<SVGDefsElement>("defs")
      .append("linearGradient")
      .attr("id", id)
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", 1)
      .attr("y2", 0);
    for (let i = 0; i <= n; i++) {
      grad
        .append("stop")
        .attr("offset", `${(i / n) * 100}%`)
        .attr("stop-color", color.interpolate(i / n));
    }
    const hgt = Math.min(160, ctx.innerHeight - 30);
    g.append("rect").attr("y", 12).attr("width", 14).attr("height", hgt).attr("fill", `url(#${id})`);
    const sc = d3
      .scaleLinear()
      .domain(color.domain)
      .range([12 + hgt, 12]);
    g.append("g")
      .attr("transform", "translate(14,0)")
      .call(
        d3
          .axisRight(sc)
          .ticks(5)
          .tickFormat((d) => defaultNumberFormat(Number(d))),
      )
      .call((a) => a.select(".domain").remove())
      .selectAll("text")
      .attr("fill", theme.muted);
  }
}

export function drawAnnotations(ctx: RenderContext, x: PosScale | null, y: PosScale | null): void {
  const anns = ctx.spec.annotations;
  if (!anns.length) return;
  const g = ctx.plot
    .append("g")
    .attr("class", "annotations")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 11);
  for (const a of anns) {
    const s = a.axis === "x" ? x : y;
    if (!s) {
      ctx.warnings.push(`Annotation on ${a.axis} axis ignored: chart has no ${a.axis} scale.`);
      continue;
    }
    const color = a.color && d3.color(a.color) ? a.color : "#d62728";
    const pos = (v: string | number | undefined) =>
      v === undefined ? null : s.map(v) === null ? null : s.map(v)! + s.bandwidth / 2;
    if (a.type === "rule" || a.type === "text") {
      const p = pos(a.value);
      if (p === null || Number.isNaN(p)) {
        ctx.warnings.push(`Annotation value ${String(a.value)} is outside the ${a.axis} scale.`);
        continue;
      }
      if (a.type === "rule") {
        const line = g
          .append("line")
          .attr("class", "annotation annotation-rule")
          .attr("stroke", color)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "6,4");
        if (a.axis === "y") line.attr("x1", 0).attr("x2", ctx.innerWidth).attr("y1", p).attr("y2", p);
        else line.attr("y1", 0).attr("y2", ctx.innerHeight).attr("x1", p).attr("x2", p);
      }
      if (a.label) {
        const t = g
          .append("text")
          .attr("class", "annotation annotation-label")
          .attr("fill", color)
          .text(a.label);
        if (a.axis === "y")
          t.attr("x", ctx.innerWidth - 4)
            .attr("y", p - 4)
            .attr("text-anchor", "end");
        else t.attr("x", p + 4).attr("y", 12);
      }
    } else {
      const p0 = pos(a.from);
      const p1 = pos(a.to);
      if (p0 === null || p1 === null) {
        ctx.warnings.push("Band annotation requires valid 'from' and 'to'.");
        continue;
      }
      const r = g
        .insert("rect", ":first-child")
        .attr("class", "annotation annotation-band")
        .attr("fill", color)
        .attr("opacity", 0.12);
      if (a.axis === "y")
        r.attr("x", 0)
          .attr("width", ctx.innerWidth)
          .attr("y", Math.min(p0, p1))
          .attr("height", Math.abs(p1 - p0));
      else
        r.attr("y", 0)
          .attr("height", ctx.innerHeight)
          .attr("x", Math.min(p0, p1))
          .attr("width", Math.abs(p1 - p0));
      if (a.label)
        g.append("text")
          .attr("fill", color)
          .attr("x", a.axis === "x" ? Math.min(p0, p1) + 4 : 4)
          .attr("y", a.axis === "y" ? Math.min(p0, p1) + 12 : 12)
          .text(a.label);
    }
  }
}

export type AggOp = "sum" | "mean" | "median" | "min" | "max" | "count";

export function reduce(values: number[], op: AggOp): number {
  switch (op) {
    case "sum":
      return d3.sum(values);
    case "mean":
      return d3.mean(values) ?? 0;
    case "median":
      return d3.median(values) ?? 0;
    case "min":
      return d3.min(values) ?? 0;
    case "max":
      return d3.max(values) ?? 0;
    case "count":
      return values.length;
  }
}

/**
 * Aggregate rows by key fields. If the value channel has no explicit aggregate but keys repeat,
 * values are summed and a warning is recorded (never silent).
 */
export function aggregateBy(
  ctx: RenderContext,
  keys: string[],
  valueCh: Channel,
): Array<{ keys: Scalar[]; value: number; rows: Row[] }> {
  const e = enc(ctx, valueCh);
  const vf = e?.field;
  let op: AggOp | undefined = e?.aggregate;
  const groups = d3.groups(ctx.rows, (r) => keys.map((k) => toLabel(r[k] ?? null)).join("\u0001"));
  const repeated = groups.some(([, g]) => g.length > 1);
  if (!op) {
    if (repeated) {
      op = "sum";
      ctx.warnings.push(
        `Multiple rows share the same ${keys.join(" × ")}; values of "${vf}" were summed. Set encoding.${valueCh}.aggregate to choose another reducer.`,
      );
    } else op = "sum";
  }
  return groups.map(([, g]) => {
    const vals =
      op === "count"
        ? g.map(() => 1)
        : g.map((r) => (vf ? toNumber(r[vf] ?? null) : null)).filter((n): n is number => n !== null);
    return {
      keys: keys.map((k) => g[0]![k] ?? null),
      value: op === "count" ? g.length : reduce(vals, op!),
      rows: g,
    };
  });
}

export function textWidth(s: string, fontSize = 11): number {
  return s.length * fontSize * 0.6;
}
