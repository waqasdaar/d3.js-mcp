import * as d3 from "d3";
import type { FeatureCollection, GeoJsonObject } from "geojson";
import { z } from "zod";
import type { Dataset } from "../data/types.js";
import { D3McpError } from "../../shared/errors.js";
import { PROJECTIONS, fixWinding } from "../../renderers/geography/index.js";

const D3 = d3 as unknown as Record<string, unknown>;
const num = z.number().finite();
const nums = z.array(num).max(1_000_000);
const pt = z.tuple([num, num]);
const pts = z.array(pt).max(200_000);

interface OpCtx {
  input: unknown;
  field?: string;
  args: Record<string, unknown>;
}
interface OpDef {
  apis: string[];
  description: string;
  run(ctx: OpCtx): unknown;
}

function values(ctx: OpCtx): number[] {
  const arr = ctx.input;
  if (!Array.isArray(arr)) throw new D3McpError("COMPOSITION_ERROR", "Operation requires an array input");
  if (ctx.field)
    return arr
      .map((r) => Number((r as Record<string, unknown>)?.[ctx.field!]))
      .filter((n) => Number.isFinite(n));
  return arr.map(Number).filter((n) => Number.isFinite(n));
}

function rows(ctx: OpCtx): Array<Record<string, unknown>> {
  if (!Array.isArray(ctx.input))
    throw new D3McpError("COMPOSITION_ERROR", "Operation requires an array of records");
  return ctx.input as Array<Record<string, unknown>>;
}

function key(ctx: OpCtx, k: unknown): (r: Record<string, unknown>) => unknown {
  const f = z.string().parse(k);
  return (r) => r[f];
}

const REDUCERS: Record<string, (v: number[]) => number | undefined> = {
  sum: (v) => d3.sum(v),
  mean: (v) => d3.mean(v),
  median: (v) => d3.median(v),
  min: (v) => d3.min(v),
  max: (v) => d3.max(v),
  count: (v) => v.length,
  deviation: (v) => d3.deviation(v),
  variance: (v) => d3.variance(v),
};

function namedFn<T>(prefix: string, name: string, kind: "function" | "array" = "function"): T {
  if (!/^[A-Za-z0-9]{1,40}$/.test(name)) throw new D3McpError("COMPOSITION_ERROR", `Invalid name "${name}"`);
  const v = D3[`${prefix}${name}`];
  if ((kind === "function" && typeof v !== "function") || (kind === "array" && !Array.isArray(v))) {
    throw new D3McpError("COMPOSITION_ERROR", `Unknown d3.${prefix}${name}`);
  }
  return v as T;
}

function buildScale(a: Record<string, unknown>) {
  const s = z
    .object({
      type: z.enum([
        "linear",
        "log",
        "pow",
        "sqrt",
        "symlog",
        "time",
        "utc",
        "band",
        "point",
        "ordinal",
        "quantize",
        "quantile",
        "threshold",
        "sequential",
        "diverging",
        "radial",
        "identity",
      ]),
      domain: z.array(z.union([num, z.string()])).max(100_000),
      range: z
        .array(z.union([num, z.string()]))
        .max(10_000)
        .optional(),
      interpolator: z.string().optional(),
      exponent: num.optional(),
      base: num.optional(),
      clamp: z.boolean().optional(),
      nice: z.boolean().optional(),
      padding: num.optional(),
    })
    .parse(a);
  const nd = s.domain.map(Number);
  const range = s.range ?? [0, 1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sc: any;
  switch (s.type) {
    case "linear":
      sc = d3
        .scaleLinear()
        .domain(nd)
        .range(range as number[]);
      break;
    case "log":
      sc = d3
        .scaleLog()
        .base(s.base ?? 10)
        .domain(nd)
        .range(range as number[]);
      break;
    case "pow":
      sc = d3
        .scalePow()
        .exponent(s.exponent ?? 1)
        .domain(nd)
        .range(range as number[]);
      break;
    case "sqrt":
      sc = d3
        .scaleSqrt()
        .domain(nd)
        .range(range as number[]);
      break;
    case "symlog":
      sc = d3
        .scaleSymlog()
        .domain(nd)
        .range(range as number[]);
      break;
    case "radial":
      sc = d3
        .scaleRadial()
        .domain(nd)
        .range(range as number[]);
      break;
    case "identity":
      sc = d3.scaleIdentity().domain(nd);
      break;
    case "time":
      sc = d3
        .scaleTime()
        .domain(s.domain.map((d) => new Date(d)))
        .range(range as number[]);
      break;
    case "utc":
      sc = d3
        .scaleUtc()
        .domain(s.domain.map((d) => new Date(d)))
        .range(range as number[]);
      break;
    case "band":
      sc = d3
        .scaleBand()
        .domain(s.domain.map(String))
        .range(range as [number, number])
        .padding(s.padding ?? 0.1);
      break;
    case "point":
      sc = d3
        .scalePoint()
        .domain(s.domain.map(String))
        .range(range as [number, number])
        .padding(s.padding ?? 0.5);
      break;
    case "ordinal":
      sc = d3.scaleOrdinal().domain(s.domain.map(String)).range(range);
      break;
    case "quantize":
      sc = d3
        .scaleQuantize()
        .domain(nd as [number, number])
        .range(range as number[]);
      break;
    case "quantile":
      sc = d3
        .scaleQuantile()
        .domain(nd)
        .range(range as number[]);
      break;
    case "threshold":
      sc = d3.scaleThreshold<number, unknown>().domain(nd).range(range);
      break;
    case "sequential":
      sc = d3
        .scaleSequential(namedFn<(t: number) => string>("interpolate", s.interpolator ?? "Viridis"))
        .domain(nd as [number, number]);
      break;
    case "diverging":
      sc = d3
        .scaleDiverging(namedFn<(t: number) => string>("interpolate", s.interpolator ?? "RdBu"))
        .domain(nd as [number, number, number]);
      break;
  }
  if (s.clamp && typeof sc.clamp === "function") sc.clamp(true);
  if (s.nice && typeof sc.nice === "function") sc.nice();
  return { sc, type: s.type };
}

function hierarchyFrom(input: unknown) {
  if (!input || typeof input !== "object")
    throw new D3McpError(
      "COMPOSITION_ERROR",
      "hierarchy.layout requires a hierarchy input ($hierarchy or {name, children})",
    );
  return d3
    .hierarchy(input as { children?: unknown[] }, (d) => d.children as { children?: unknown[] }[] | undefined)
    .sum((d) => Number((d as { value?: unknown }).value) || 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

function randomSource(seed: unknown) {
  return d3.randomLcg(z.number().int().optional().parse(seed) ?? 42);
}

export const OPS: Record<string, OpDef> = {
  "array.extent": { apis: ["extent"], description: "Min and max", run: (c) => d3.extent(values(c)) },
  "array.min": { apis: ["min"], description: "Minimum", run: (c) => d3.min(values(c)) },
  "array.max": { apis: ["max"], description: "Maximum", run: (c) => d3.max(values(c)) },
  "array.sum": { apis: ["sum"], description: "Sum", run: (c) => d3.sum(values(c)) },
  "array.fsum": {
    apis: ["fsum", "Adder", "adder.add", "adder.valueOf"],
    description: "Full-precision sum",
    run: (c) => {
      const a = new d3.Adder();
      for (const v of values(c)) a.add(v);
      return { fsum: d3.fsum(values(c)), adder: a.valueOf() };
    },
  },
  "array.mean": { apis: ["mean"], description: "Mean", run: (c) => d3.mean(values(c)) },
  "array.median": { apis: ["median"], description: "Median", run: (c) => d3.median(values(c)) },
  "array.mode": { apis: ["mode"], description: "Mode", run: (c) => d3.mode(values(c)) },
  "array.variance": {
    apis: ["variance"],
    description: "Sample variance",
    run: (c) => d3.variance(values(c)),
  },
  "array.deviation": {
    apis: ["deviation"],
    description: "Sample standard deviation",
    run: (c) => d3.deviation(values(c)),
  },
  "array.count": { apis: ["count"], description: "Count of valid numbers", run: (c) => d3.count(values(c)) },
  "array.quantile": {
    apis: ["quantile", "quantileSorted", "quantileIndex"],
    description: "Quantile p ∈ [0,1] (args.p or args.ps)",
    run: (c) => {
      const v = values(c);
      const ps = z
        .array(z.number().min(0).max(1))
        .max(100)
        .parse(c.args.ps ?? [c.args.p ?? 0.5]);
      const sorted = d3.sort(v);
      return ps.map((p) => ({
        p,
        value: d3.quantile(v, p),
        sortedValue: d3.quantileSorted(sorted, p),
        index: d3.quantileIndex(v, p),
      }));
    },
  },
  "array.cumsum": {
    apis: ["cumsum"],
    description: "Cumulative sum",
    run: (c) => Array.from(d3.cumsum(values(c))),
  },
  "array.rank": {
    apis: ["rank"],
    description: "Ranks (ascending)",
    run: (c) => Array.from(d3.rank(values(c))),
  },
  "array.sort": {
    apis: ["sort", "ascending", "descending"],
    description: "Sort values or records by field (args.order)",
    run: (c) => {
      const order = z.enum(["ascending", "descending"]).parse(c.args.order ?? "ascending");
      const cmp = order === "ascending" ? d3.ascending : d3.descending;
      if (c.field) return d3.sort(rows(c), (a, b) => cmp(a[c.field!] as number, b[c.field!] as number));
      return d3.sort(values(c), cmp);
    },
  },
  "array.filter": {
    apis: ["filter"],
    description: "Filter records by field (args.op: eq|neq|lt|lte|gt|gte, args.value)",
    run: (c) => {
      const op = z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]).parse(c.args.op);
      const v = z.union([num, z.string(), z.boolean()]).parse(c.args.value);
      if (!c.field) throw new D3McpError("COMPOSITION_ERROR", "array.filter requires field");
      return d3.filter(rows(c), (r) => {
        const x = r[c.field!] as number;
        const w = v as number;
        return op === "eq"
          ? x === v
          : op === "neq"
            ? x !== v
            : op === "lt"
              ? x < w
              : op === "lte"
                ? x <= w
                : op === "gt"
                  ? x > w
                  : x >= w;
      });
    },
  },
  "array.bin": {
    apis: [
      "bin",
      "bin.value",
      "bin.domain",
      "bin.thresholds",
      "thresholdSturges",
      "thresholdScott",
      "thresholdFreedmanDiaconis",
      "nice",
    ],
    description: "Histogram bins (args.thresholds number|rule)",
    run: (c) => {
      const v = values(c);
      const t = c.args.thresholds ?? "sturges";
      const rule =
        t === "scott"
          ? d3.thresholdScott
          : t === "freedman-diaconis"
            ? d3.thresholdFreedmanDiaconis
            : t === "sturges"
              ? d3.thresholdSturges
              : z.number().int().min(1).max(1000).parse(t);
      const ext = d3.extent(v) as [number, number];
      const domain = d3.nice(ext[0] ?? 0, ext[1] ?? 1, 10) as [number, number];
      const bins = d3
        .bin<number, number>()
        .value((x) => x)
        .domain(domain)
        .thresholds(rule)(v);
      return bins.map((b) => ({ x0: b.x0, x1: b.x1, count: b.length }));
    },
  },
  "array.group": {
    apis: ["group", "groups", "index"],
    description: "Group records by args.keys (field names); returns [key, count] pairs per level",
    run: (c) => {
      const keys = z.array(z.string()).min(1).max(4).parse(c.args.keys);
      const fns = keys.map((k) => key(c, k));
      const g = (
        d3.groups as (d: unknown[], ...k: Array<(r: Record<string, unknown>) => unknown>) => unknown
      )(rows(c), ...fns);
      const summarize = (x: unknown): unknown =>
        Array.isArray(x) &&
        x.length === 2 &&
        Array.isArray(x[1]) &&
        x[1].every((y) => Array.isArray(y) && y.length === 2)
          ? [x[0], (x[1] as unknown[]).map(summarize)]
          : Array.isArray(x) && x.length === 2 && Array.isArray(x[1])
            ? [x[0], (x[1] as unknown[]).length]
            : x;
      return (g as unknown[]).map(summarize);
    },
  },
  "array.rollup": {
    apis: ["rollup", "rollups", "flatRollup"],
    description: "Reduce records grouped by args.keys with args.reducer over field",
    run: (c) => {
      const keys = z.array(z.string()).min(1).max(4).parse(c.args.keys);
      const red = REDUCERS[z.string().parse(c.args.reducer ?? "sum")];
      if (!red)
        throw new D3McpError("COMPOSITION_ERROR", `Unknown reducer; use ${Object.keys(REDUCERS).join(", ")}`);
      const f = c.field;
      const reduce = (g: Array<Record<string, unknown>>) =>
        red(f ? g.map((r) => Number(r[f])).filter(Number.isFinite) : g.map(() => 1));
      return (
        d3.flatRollup as (
          d: unknown[],
          r: (g: Array<Record<string, unknown>>) => unknown,
          ...k: Array<(r: Record<string, unknown>) => unknown>
        ) => unknown
      )(rows(c), reduce, ...keys.map((k) => key(c, k)));
    },
  },
  "array.least": {
    apis: ["least", "greatest", "leastIndex", "greatestIndex"],
    description: "Record with least and greatest field value",
    run: (c) => {
      if (!c.field) throw new D3McpError("COMPOSITION_ERROR", "array.least requires field");
      const acc = (r: Record<string, unknown>) => Number(r[c.field!]);
      return {
        least: d3.least(rows(c), acc),
        greatest: d3.greatest(rows(c), acc),
        leastIndex: d3.leastIndex(rows(c), acc),
        greatestIndex: d3.greatestIndex(rows(c), acc),
      };
    },
  },
  "array.ticks": {
    apis: ["ticks", "tickIncrement", "tickStep", "nice"],
    description: "Nice tick values for args.start/stop/count",
    run: (c) => {
      const { start, stop, count } = z
        .object({ start: num, stop: num, count: z.number().int().min(1).max(1000) })
        .parse(c.args);
      return {
        ticks: d3.ticks(start, stop, count),
        step: d3.tickStep(start, stop, count),
        increment: d3.tickIncrement(start, stop, count),
        nice: d3.nice(start, stop, count),
      };
    },
  },
  "array.range": {
    apis: ["range"],
    description: "Arithmetic progression",
    run: (c) => {
      const { start, stop, step } = z.object({ start: num, stop: num, step: num.default(1) }).parse(c.args);
      if (Math.abs((stop - start) / step) > 100_000)
        throw new D3McpError("LIMIT_EXCEEDED", "range would exceed 100000 values");
      return d3.range(start, stop, step);
    },
  },
  "array.bisect": {
    apis: ["bisectLeft", "bisectRight", "bisectCenter"],
    description: "Insertion points of args.x in sorted values",
    run: (c) => {
      const v = d3.sort(values(c));
      const x = num.parse(c.args.x);
      return { left: d3.bisectLeft(v, x), right: d3.bisectRight(v, x), center: d3.bisectCenter(v, x) };
    },
  },
  "array.sets": {
    apis: ["union", "intersection", "difference", "disjoint", "subset", "superset"],
    description: "Set operations between input values and args.other",
    run: (c) => {
      const a = (c.input as unknown[]).map(String);
      const b = z
        .array(z.union([z.string(), num]))
        .max(100_000)
        .parse(c.args.other)
        .map(String);
      return {
        union: [...d3.union(a, b)],
        intersection: [...d3.intersection(a, b)],
        difference: [...d3.difference(a, b)],
        disjoint: d3.disjoint(a, b),
        subset: d3.subset(a, b),
        superset: d3.superset(a, b),
      };
    },
  },
  "array.shuffle": {
    apis: ["shuffler", "randomLcg"],
    description: "Deterministic shuffle with args.seed",
    run: (c) => d3.shuffler(randomSource(c.args.seed))([...(c.input as unknown[])]),
  },
  "array.pairs": {
    apis: ["pairs", "cross", "zip", "transpose"],
    description: "Adjacent pairs, cross product with args.other, zip and transpose",
    run: (c) => {
      const a = c.input as unknown[];
      const other = z.array(z.unknown()).max(1000).optional().parse(c.args.other) ?? [];
      return {
        pairs: d3.pairs(a),
        cross: d3.cross(a.slice(0, 1000), other),
        zip: d3.zip(a, other),
        transpose: d3.transpose([a, other]),
      };
    },
  },
  "array.summarize": {
    apis: ["extent", "mean", "median", "deviation", "quantile"],
    description: "Summary statistics",
    run: (c) => {
      const v = values(c);
      return {
        count: v.length,
        extent: d3.extent(v),
        mean: d3.mean(v),
        median: d3.median(v),
        deviation: d3.deviation(v),
        q1: d3.quantile(v, 0.25),
        q3: d3.quantile(v, 0.75),
      };
    },
  },
  "scale.apply": {
    apis: [
      "scaleLinear",
      "scaleLog",
      "scalePow",
      "scaleSqrt",
      "scaleSymlog",
      "scaleRadial",
      "scaleIdentity",
      "scaleTime",
      "scaleUtc",
      "scaleBand",
      "scalePoint",
      "scaleOrdinal",
      "scaleQuantize",
      "scaleQuantile",
      "scaleThreshold",
      "scaleSequential",
      "scaleDiverging",
      "linear.clamp",
      "linear.nice",
      "linear.invert",
      "linear.ticks",
      "band.bandwidth",
      "band.step",
    ],
    description:
      "Build a scale (args.type, domain, range...) and map args.values; returns ticks/invert/bandwidth where applicable",
    run: (c) => {
      const { sc, type } = buildScale(c.args);
      const vals = z
        .array(z.union([num, z.string()]))
        .max(100_000)
        .parse(c.args.values ?? c.input ?? []);
      const mapped = vals.map((v) => {
        const x =
          type === "time" || type === "utc"
            ? new Date(v)
            : ["band", "point", "ordinal"].includes(type)
              ? String(v)
              : Number(v);
        const y = sc(x);
        return y instanceof Date ? y.toISOString() : (y ?? null);
      });
      const out: Record<string, unknown> = {
        mapped,
        domain: sc.domain().map((d: unknown) => (d instanceof Date ? d.toISOString() : d)),
        range: typeof sc.range === "function" ? sc.range() : undefined,
      };
      if (typeof sc.ticks === "function")
        out.ticks = sc
          .ticks(
            z
              .number()
              .int()
              .min(1)
              .max(100)
              .parse(c.args.ticks ?? 10),
          )
          .map((d: unknown) => (d instanceof Date ? d.toISOString() : d));
      if (typeof sc.invert === "function" && Array.isArray(c.args.invert))
        out.inverted = (c.args.invert as unknown[]).slice(0, 10000).map((p) => {
          const v = sc.invert(Number(p));
          return v instanceof Date ? v.toISOString() : v;
        });
      if (typeof sc.bandwidth === "function") out.bandwidth = sc.bandwidth();
      if (typeof sc.step === "function") out.step = sc.step();
      return out;
    },
  },
  "format.number": {
    apis: [
      "format",
      "formatPrefix",
      "formatSpecifier",
      "precisionFixed",
      "precisionRound",
      "precisionPrefix",
    ],
    description: "Format numbers with a d3-format specifier",
    run: (c) => {
      const spec = z.string().max(40).parse(c.args.specifier);
      let f: (n: number) => string;
      try {
        f = d3.format(spec);
      } catch (e) {
        throw new D3McpError("COMPOSITION_ERROR", (e as Error).message);
      }
      const v = values(c);
      const parsed = d3.formatSpecifier(spec);
      return {
        formatted: v.map(f),
        specifier: { type: parsed.type, precision: parsed.precision ?? null, comma: parsed.comma },
        precisionFixed: v.length > 1 ? d3.precisionFixed(Math.abs(v[1]! - v[0]!) || 1) : undefined,
        prefixExample: v.length ? d3.formatPrefix(",.1", Math.max(1, Math.abs(v[0]!)))(v[0]!) : undefined,
        precisionRound: d3.precisionRound(0.01, 1.01),
        precisionPrefix: d3.precisionPrefix(1e5, 1.3e6),
      };
    },
  },
  "format.time": {
    apis: ["utcFormat", "utcParse", "timeFormat", "isoFormat", "isoParse"],
    description:
      "Format (args.values ISO/epoch) or parse (args.parse strings) times with a d3-time-format specifier (UTC)",
    run: (c) => {
      const spec = z.string().max(60).parse(c.args.specifier);
      if (Array.isArray(c.args.parse)) {
        const p = d3.utcParse(spec);
        return {
          parsed: (c.args.parse as unknown[])
            .slice(0, 100_000)
            .map((s) => p(String(s))?.toISOString() ?? null),
        };
      }
      const f = d3.utcFormat(spec);
      const vals = z
        .array(z.union([z.string(), num]))
        .max(100_000)
        .parse(c.args.values ?? c.input);
      return {
        formatted: vals.map((v) => f(new Date(v))),
        iso: vals.map((v) => d3.isoFormat(new Date(v))),
        roundTrip: vals.slice(0, 1).map((v) => d3.isoParse(d3.isoFormat(new Date(v)))?.toISOString() ?? null),
      };
    },
  },
  "time.interval": {
    apis: [
      "utcDay",
      "utcHour",
      "utcMinute",
      "utcSecond",
      "utcWeek",
      "utcMonth",
      "utcYear",
      "utcMillisecond",
      "interval.range",
      "interval.floor",
      "interval.ceil",
      "interval.count",
      "interval.every",
      "timeTicks",
      "utcTicks",
      "utcTickInterval",
    ],
    description: "UTC calendar intervals: range/floor/ceil/count between args.start and args.stop",
    run: (c) => {
      const { interval, start, stop, step } = z
        .object({
          interval: z.enum(["millisecond", "second", "minute", "hour", "day", "week", "month", "year"]),
          start: z.union([z.string(), num]),
          stop: z.union([z.string(), num]),
          step: z.number().int().min(1).max(1000).default(1),
        })
        .parse(c.args);
      const map = {
        millisecond: d3.utcMillisecond,
        second: d3.utcSecond,
        minute: d3.utcMinute,
        hour: d3.utcHour,
        day: d3.utcDay,
        week: d3.utcWeek,
        month: d3.utcMonth,
        year: d3.utcYear,
      } as const;
      const iv = map[interval];
      const a = new Date(start);
      const b = new Date(stop);
      const count = iv.count(a, b);
      if (count / step > 100_000)
        throw new D3McpError("LIMIT_EXCEEDED", "Interval range would exceed 100000 dates");
      const ranged = (step > 1 ? (iv.every(step) ?? iv) : iv).range(a, b);
      return {
        count,
        range: ranged.map((d) => d.toISOString()),
        floor: iv.floor(a).toISOString(),
        ceil: iv.ceil(b).toISOString(),
        ticks: d3.utcTicks(a, b, 10).map((d) => d.toISOString()),
        tickIntervalExists: d3.utcTickInterval(a, b, 10) !== null,
        localTicks: d3.timeTicks(a, b, 5).length,
      };
    },
  },
  "color.parse": {
    apis: [
      "color",
      "rgb",
      "hsl",
      "lab",
      "hcl",
      "cubehelix",
      "color.formatHex",
      "color.formatRgb",
      "color.brighter",
      "color.darker",
    ],
    description: "Parse CSS colors and convert between color spaces",
    run: (c) => {
      const colors = z
        .array(z.string().max(60))
        .max(10_000)
        .parse(c.args.colors ?? c.input);
      return colors.map((s) => {
        const col = d3.color(s);
        if (!col) return { input: s, valid: false };
        const lab = d3.lab(col);
        const hcl = d3.hcl(col);
        const hsl = d3.hsl(col);
        const ch = d3.cubehelix(col);
        return {
          input: s,
          valid: true,
          hex: col.formatHex(),
          rgb: d3.rgb(col).formatRgb(),
          hsl: hsl.formatHsl(),
          lab: { l: lab.l, a: lab.a, b: lab.b },
          hcl: { h: hcl.h, c: hcl.c, l: hcl.l },
          cubehelix: { h: ch.h, s: ch.s, l: ch.l },
          brighter: col.brighter().formatHex(),
          darker: col.darker().formatHex(),
        };
      });
    },
  },
  "color.scheme": {
    apis: [
      "schemeCategory10",
      "schemeTableau10",
      "schemeAccent",
      "schemeDark2",
      "schemePaired",
      "schemePastel1",
      "schemePastel2",
      "schemeSet1",
      "schemeSet2",
      "schemeSet3",
      "schemeBlues",
      "schemeRdBu",
    ],
    description: "Return a named d3-scale-chromatic scheme (args.name, args.k for sequential/diverging)",
    run: (c) => {
      const name = z.string().parse(c.args.name);
      const k = z.number().int().min(3).max(11).optional().parse(c.args.k);
      const s = namedFn<unknown[]>("scheme", name, "array");
      return typeof s[0] === "string" ? s : (s[k ?? 9] ?? s.filter(Boolean).at(-1));
    },
  },
  "color.interpolate": {
    apis: [
      "interpolateViridis",
      "interpolateTurbo",
      "interpolateRdBu",
      "interpolateBlues",
      "interpolateRainbow",
      "interpolateSinebow",
      "interpolateCividis",
      "interpolateWarm",
      "interpolateCool",
      "interpolateMagma",
      "interpolateInferno",
      "interpolatePlasma",
      "quantize",
    ],
    description: "Sample a named interpolator (args.name) at args.t values or args.n evenly spaced",
    run: (c) => {
      const f = namedFn<(t: number) => string>("interpolate", z.string().parse(c.args.name));
      if (c.args.n !== undefined) return d3.quantize(f, z.number().int().min(2).max(1000).parse(c.args.n));
      return z
        .array(z.number().min(0).max(1))
        .max(10_000)
        .parse(c.args.t ?? [0, 0.5, 1])
        .map(f);
    },
  },
  "interpolate.values": {
    apis: [
      "interpolate",
      "interpolateNumber",
      "interpolateRound",
      "interpolateString",
      "interpolateArray",
      "interpolateObject",
      "interpolateRgb",
      "interpolateHsl",
      "interpolateLab",
      "interpolateHcl",
      "interpolateCubehelix",
      "interpolateDate",
      "interpolateZoom",
      "interpolateDiscrete",
      "interpolateBasis",
      "interpolateTransformSvg",
      "piecewise",
    ],
    description: "Interpolate between args.a and args.b (args.kind) at args.t",
    run: (c) => {
      const kind = z
        .enum([
          "auto",
          "number",
          "round",
          "string",
          "array",
          "object",
          "rgb",
          "hsl",
          "lab",
          "hcl",
          "cubehelix",
          "date",
          "zoom",
          "discrete",
          "basis",
          "transformSvg",
          "piecewise",
        ])
        .parse(c.args.kind ?? "auto");
      const t = z
        .array(z.number().min(0).max(1))
        .max(1000)
        .parse(c.args.t ?? [0, 0.5, 1]);
      const a = c.args.a as never;
      const b = c.args.b as never;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fns: Record<string, () => (t: number) => any> = {
        auto: () => d3.interpolate(a, b),
        number: () => d3.interpolateNumber(Number(a), Number(b)),
        round: () => d3.interpolateRound(Number(a), Number(b)),
        string: () => d3.interpolateString(String(a), String(b)),
        array: () => d3.interpolateArray(a as number[], b as number[]),
        object: () => d3.interpolateObject(a as object, b as object),
        rgb: () => d3.interpolateRgb(String(a), String(b)),
        hsl: () => d3.interpolateHsl(String(a), String(b)),
        lab: () => d3.interpolateLab(String(a), String(b)),
        hcl: () => d3.interpolateHcl(String(a), String(b)),
        cubehelix: () => d3.interpolateCubehelix(String(a), String(b)),
        date: () => {
          const f = d3.interpolateDate(new Date(a), new Date(b));
          return (x: number) => f(x).toISOString();
        },
        zoom: () => d3.interpolateZoom(z.tuple([num, num, num]).parse(a), z.tuple([num, num, num]).parse(b)),
        discrete: () => d3.interpolateDiscrete(z.array(z.unknown()).parse(a)),
        basis: () => d3.interpolateBasis(z.array(num).parse(a)),
        transformSvg: () => d3.interpolateTransformSvg(String(a), String(b)),
        piecewise: () => d3.piecewise(d3.interpolateRgb, z.array(z.string()).min(2).parse(a)),
      };
      const f = fns[kind]!();
      return t.map((x) => ({ t: x, value: f(x) }));
    },
  },
  "shape.line": {
    apis: [
      "line",
      "line.curve",
      "curveLinear",
      "curveMonotoneX",
      "curveBasis",
      "curveCardinal",
      "curveCatmullRom",
      "curveNatural",
      "curveStep",
      "curveStepBefore",
      "curveStepAfter",
      "curveBumpX",
      "curveBumpY",
      "curveLinearClosed",
      "curveBasisClosed",
      "curveMonotoneY",
      "lineRadial",
    ],
    description: "SVG path for args.points with args.curve; args.radial for [angle, radius] points",
    run: (c) => {
      const points = pts.parse(c.args.points ?? c.input);
      const curve = namedFn<d3.CurveFactory>("curve", z.string().parse(c.args.curve ?? "Linear"));
      if (c.args.radial) return { path: d3.lineRadial().curve(curve)(points) };
      return { path: d3.line().curve(curve)(points) };
    },
  },
  "shape.area": {
    apis: ["area", "area.y0", "areaRadial"],
    description: "SVG area path for args.points (x, y1) with baseline args.y0",
    run: (c) => {
      const points = pts.parse(c.args.points ?? c.input);
      const y0 = num.parse(c.args.y0 ?? 0);
      return {
        path: d3.area().y0(y0)(points),
        radial: d3
          .areaRadial()
          .innerRadius(Math.max(0, y0))
          .outerRadius((d) => d[1])
          .angle((d) => d[0])(points),
      };
    },
  },
  "shape.arc": {
    apis: [
      "arc",
      "arc.innerRadius",
      "arc.outerRadius",
      "arc.startAngle",
      "arc.endAngle",
      "arc.padAngle",
      "arc.cornerRadius",
      "arc.centroid",
    ],
    description: "Arc path and centroid",
    run: (c) => {
      const a = z
        .object({
          innerRadius: num.min(0),
          outerRadius: num.min(0),
          startAngle: num,
          endAngle: num,
          padAngle: num.default(0),
          cornerRadius: num.default(0),
        })
        .parse(c.args);
      const gen = d3
        .arc()
        .innerRadius(a.innerRadius)
        .outerRadius(a.outerRadius)
        .startAngle(a.startAngle)
        .endAngle(a.endAngle)
        .padAngle(a.padAngle)
        .cornerRadius(a.cornerRadius);
      return { path: gen({} as d3.DefaultArcObject), centroid: gen.centroid({} as d3.DefaultArcObject) };
    },
  },
  "shape.pie": {
    apis: ["pie", "pie.value", "pie.padAngle", "pie.sort", "pie.startAngle", "pie.endAngle"],
    description: "Pie angles for values",
    run: (c) => {
      const v = values(c);
      const gen = d3
        .pie<number>()
        .sort(null)
        .padAngle(num.parse(c.args.padAngle ?? 0))
        .startAngle(num.parse(c.args.startAngle ?? 0))
        .endAngle(num.parse(c.args.endAngle ?? 2 * Math.PI));
      return gen(v).map((a) => ({
        value: a.value,
        startAngle: a.startAngle,
        endAngle: a.endAngle,
        index: a.index,
      }));
    },
  },
  "shape.symbol": {
    apis: [
      "symbol",
      "symbolsFill",
      "symbolsStroke",
      "symbolCircle",
      "symbolSquare",
      "symbolTriangle",
      "symbolPlus",
      "symbolAsterisk",
      "symbolSquare2",
      "symbolDiamond2",
    ],
    description: "Symbol path for args.type (e.g. Circle, Star) and args.size",
    run: (c) => {
      const type = namedFn<d3.SymbolType>("symbol", z.string().parse(c.args.type ?? "Circle"));
      return {
        path: d3.symbol(
          type,
          num
            .min(0)
            .max(1e6)
            .parse(c.args.size ?? 64),
        )(),
        fillTypes: d3.symbolsFill.length,
        strokeTypes: d3.symbolsStroke.length,
      };
    },
  },
  "shape.stack": {
    apis: [
      "stack",
      "stack.keys",
      "stack.value",
      "stack.offset",
      "stack.order",
      "stackOffsetExpand",
      "stackOffsetDiverging",
      "stackOffsetNone",
      "stackOffsetSilhouette",
      "stackOffsetWiggle",
      "stackOrderNone",
      "stackOrderAscending",
      "stackOrderDescending",
      "stackOrderInsideOut",
      "stackOrderReverse",
      "stackOrderAppearance",
    ],
    description: "Stack records (input) on args.keys with args.offset/args.order",
    run: (c) => {
      const keys = z.array(z.string()).min(1).max(100).parse(c.args.keys);
      const offset = namedFn<typeof d3.stackOffsetNone>(
        "stackOffset",
        z.string().parse(c.args.offset ?? "None"),
      );
      const order = namedFn<typeof d3.stackOrderNone>("stackOrder", z.string().parse(c.args.order ?? "None"));
      const s = d3
        .stack<Record<string, unknown>>()
        .keys(keys)
        .value((d, k) => Number(d[k]) || 0)
        .offset(offset)
        .order(order)(rows(c));
      return s.map((layer) => ({
        key: layer.key,
        index: layer.index,
        values: layer.map((p) => [p[0], p[1]]),
      }));
    },
  },
  "shape.link": {
    apis: ["linkHorizontal", "linkVertical", "linkRadial", "link"],
    description: "Link path between args.source and args.target points",
    run: (c) => {
      const s = pt.parse(c.args.source);
      const t = pt.parse(c.args.target);
      return {
        horizontal: d3.linkHorizontal()({ source: s, target: t }),
        vertical: d3.linkVertical()({ source: s, target: t }),
        radial: d3.linkRadial()({ source: s, target: t }),
        bumpX: d3.link(d3.curveBumpX)({ source: s, target: t }),
      };
    },
  },
  "path.build": {
    apis: [
      "path",
      "path.moveTo",
      "path.lineTo",
      "path.closePath",
      "path.quadraticCurveTo",
      "path.bezierCurveTo",
      "path.arcTo",
      "path.arc",
      "path.rect",
      "path.toString",
      "pathRound",
    ],
    description: "Build an SVG path from args.commands [{cmd, args}]",
    run: (c) => {
      const cmds = z
        .array(
          z.object({
            cmd: z.enum([
              "moveTo",
              "lineTo",
              "closePath",
              "quadraticCurveTo",
              "bezierCurveTo",
              "arcTo",
              "arc",
              "rect",
            ]),
            args: z.array(num).max(6).default([]),
          }),
        )
        .max(10_000)
        .parse(c.args.commands);
      const p =
        c.args.digits !== undefined
          ? d3.pathRound(z.number().int().min(0).max(15).parse(c.args.digits))
          : d3.path();
      for (const { cmd, args } of cmds) (p[cmd] as (...a: number[]) => void).apply(p, args);
      return { path: p.toString() };
    },
  },
  "polygon.metrics": {
    apis: ["polygonArea", "polygonCentroid", "polygonHull", "polygonContains", "polygonLength"],
    description: "Area, centroid, hull, perimeter and containment of args.points",
    run: (c) => {
      const polygon = pts.parse(c.args.points ?? c.input);
      const test = c.args.test ? pt.parse(c.args.test) : null;
      return {
        area: d3.polygonArea(polygon),
        centroid: d3.polygonCentroid(polygon),
        hull: d3.polygonHull(polygon),
        length: d3.polygonLength(polygon),
        contains: test ? d3.polygonContains(polygon, test) : undefined,
      };
    },
  },
  "quadtree.find": {
    apis: [
      "quadtree",
      "quadtree.addAll",
      "quadtree.find",
      "quadtree.extent",
      "quadtree.size",
      "quadtree.x",
      "quadtree.y",
    ],
    description: "Nearest point to args.x,args.y within args.radius",
    run: (c) => {
      const points = pts.parse(c.args.points ?? c.input);
      const q = d3
        .quadtree<[number, number]>()
        .x((p) => p[0])
        .y((p) => p[1])
        .addAll(points);
      const x = num.parse(c.args.x);
      const y = num.parse(c.args.y);
      const r = c.args.radius === undefined ? undefined : num.parse(c.args.radius);
      return { found: q.find(x, y, r) ?? null, size: q.size(), extent: q.extent() };
    },
  },
  "delaunay.compute": {
    apis: [
      "Delaunay.from",
      "delaunay.triangles",
      "delaunay.hull",
      "delaunay.neighbors",
      "delaunay.find",
      "delaunay.voronoi",
      "voronoi.cellPolygon",
      "voronoi.contains",
    ],
    description: "Triangulation, hull, neighbors and Voronoi cells for args.points within args.bounds",
    run: (c) => {
      const points = pts.parse(c.args.points ?? c.input);
      if (points.length > 50_000)
        throw new D3McpError("LIMIT_EXCEEDED", "delaunay.compute supports up to 50000 points");
      const del = d3.Delaunay.from(points);
      const bounds = z.tuple([num, num, num, num]).optional().parse(c.args.bounds) ?? [
        d3.min(points, (p) => p[0])! - 1,
        d3.min(points, (p) => p[1])! - 1,
        d3.max(points, (p) => p[0])! + 1,
        d3.max(points, (p) => p[1])! + 1,
      ];
      const vor = del.voronoi(bounds);
      const find = c.args.find ? pt.parse(c.args.find) : null;
      return {
        triangles: Array.from(del.triangles),
        hull: Array.from(del.hull),
        neighbors: points.slice(0, 1000).map((_, i) => Array.from(del.neighbors(i))),
        cells: points.slice(0, 2000).map((_, i) => vor.cellPolygon(i)),
        find: find ? del.find(find[0], find[1]) : undefined,
        firstCellContainsOwnSite: points.length ? vor.contains(0, points[0]![0], points[0]![1]) : undefined,
      };
    },
  },
  "contour.density": {
    apis: [
      "contourDensity",
      "density.x",
      "density.y",
      "density.size",
      "density.bandwidth",
      "density.thresholds",
      "contours",
      "contours.size",
      "contours.thresholds",
    ],
    description: "Density contours of args.points, or contours of a grid args.grid (with args.width/height)",
    run: (c) => {
      if (c.args.grid) {
        const { grid, width, height, thresholds } = z
          .object({
            grid: nums,
            width: z.number().int().min(1).max(2000),
            height: z.number().int().min(1).max(2000),
            thresholds: z.number().int().min(1).max(100).default(10),
          })
          .parse(c.args);
        if (grid.length !== width * height)
          throw new D3McpError("COMPOSITION_ERROR", "grid length must equal width × height");
        return d3
          .contours()
          .size([width, height])
          .thresholds(thresholds)(grid)
          .map((m) => ({ value: m.value, polygons: m.coordinates.length }));
      }
      const points = pts.parse(c.args.points ?? c.input);
      const { size, bandwidth, thresholds } = z
        .object({
          size: z.tuple([num, num]).default([500, 500]),
          bandwidth: num.min(0.1).max(500).default(20),
          thresholds: z.number().int().min(1).max(100).default(10),
        })
        .parse(c.args);
      return d3
        .contourDensity()
        .x((p) => p[0])
        .y((p) => p[1])
        .size(size)
        .bandwidth(bandwidth)
        .thresholds(thresholds)(points)
        .map((m) => ({ value: m.value, polygons: m.coordinates.length, path: d3.geoPath()(m) }));
    },
  },
  "chord.layout": {
    apis: ["chord", "chordDirected", "chordTranspose", "ribbon", "ribbonArrow"],
    description: "Chord groups and ribbons for a square args.matrix",
    run: (c) => {
      const matrix = z
        .array(nums)
        .max(200)
        .parse(c.args.matrix ?? c.input);
      if (!matrix.every((r) => r.length === matrix.length))
        throw new D3McpError("COMPOSITION_ERROR", "matrix must be square");
      const ch = d3.chord()(matrix);
      const directed = d3.chordDirected()(matrix);
      const transposed = d3.chordTranspose()(matrix);
      const rib = d3.ribbon<d3.Chord, d3.ChordSubgroup>().radius(100);
      const arrow = d3.ribbonArrow<d3.Chord, d3.ChordSubgroup>().radius(100);
      return {
        groups: ch.groups,
        chords: ch.length,
        directedChords: directed.length,
        transposedChords: transposed.length,
        firstRibbon: ch[0] ? rib(ch[0]) : null,
        firstArrow: directed[0] ? arrow(directed[0]) : null,
      };
    },
  },
  "hierarchy.layout": {
    apis: [
      "hierarchy",
      "node.sum",
      "node.sort",
      "node.descendants",
      "node.leaves",
      "node.links",
      "node.path",
      "node.find",
      "node.copy",
      "node.each",
      "treemap",
      "pack",
      "partition",
      "tree",
      "cluster",
      "packSiblings",
      "packEnclose",
    ],
    description: "Lay out a hierarchy ($hierarchy or {name, children}) with args.layout and args.size",
    run: (c) => {
      const layout = z
        .enum(["treemap", "pack", "partition", "tree", "cluster"])
        .parse(c.args.layout ?? "treemap");
      const [w, h] = z.tuple([num, num]).parse(c.args.size ?? [800, 600]);
      const root = hierarchyFrom(c.input);
      if (root.descendants().length > 50_000)
        throw new D3McpError("LIMIT_EXCEEDED", "hierarchy exceeds 50000 nodes");
      const nameOf = (d: unknown) => String((d as { name?: unknown }).name ?? "");
      let visited = 0;
      root.copy().each(() => visited++);
      const leaves = root.leaves();
      const pathLen = leaves.length > 1 ? root.path(leaves[leaves.length - 1]!).length : 0;
      const found = root.find((n) => n.depth === 1)?.data;
      const circles = leaves.slice(0, 50).map((_, i) => ({ r: 5 + (i % 5), x: 0, y: 0 }));
      d3.packSiblings(circles);
      const enclose = d3.packEnclose(circles);
      const base = {
        visited,
        rootToLastLeafPathLength: pathLen,
        firstChild: found ? nameOf(found) : null,
        packEnclose: enclose ? { r: enclose.r } : null,
      };
      if (layout === "tree" || layout === "cluster") {
        const laid = (layout === "tree" ? d3.tree() : d3.cluster()).size([w, h])(
          root as d3.HierarchyNode<unknown>,
        );
        return {
          ...base,
          nodes: laid.descendants().map((n) => ({ name: nameOf(n.data), depth: n.depth, x: n.x, y: n.y })),
          links: laid.links().length,
        };
      }
      if (layout === "pack") {
        const laid = d3.pack().size([w, h]).padding(2)(root as d3.HierarchyNode<unknown>);
        return {
          ...base,
          nodes: laid
            .descendants()
            .map((n) => ({ name: nameOf(n.data), depth: n.depth, value: n.value, x: n.x, y: n.y, r: n.r })),
        };
      }
      const laid = (
        layout === "treemap" ? d3.treemap().size([w, h]).paddingInner(1) : d3.partition().size([w, h])
      )(root as d3.HierarchyNode<unknown>);
      return {
        ...base,
        nodes: laid.descendants().map((n) => ({
          name: nameOf(n.data),
          depth: n.depth,
          value: n.value,
          x0: n.x0,
          y0: n.y0,
          x1: n.x1,
          y1: n.y1,
        })),
      };
    },
  },
  "force.layout": {
    apis: [
      "forceSimulation",
      "forceLink",
      "forceManyBody",
      "forceCenter",
      "forceCollide",
      "forceX",
      "forceY",
      "forceRadial",
      "simulation.tick",
      "simulation.nodes",
      "simulation.randomSource",
      "randomLcg",
    ],
    description: "Run a bounded force simulation on {nodes, links} ($data/$links or args)",
    run: (c) => {
      const nodes = z
        .array(z.object({ id: z.union([z.string(), num]) }).loose())
        .max(5000)
        .parse(c.args.nodes ?? c.input)
        .map((n) => ({ ...n, id: String(n.id) })) as Array<{ id: string; x?: number; y?: number }>;
      const links = z
        .array(z.object({ source: z.union([z.string(), num]), target: z.union([z.string(), num]) }).loose())
        .max(20000)
        .parse(c.args.links ?? [])
        .map((l) => ({ source: String(l.source), target: String(l.target) }));
      const iterations = z
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(c.args.iterations ?? 300);
      const [w, h] = z.tuple([num, num]).parse(c.args.size ?? [800, 600]);
      const sim = d3
        .forceSimulation(nodes)
        .randomSource(randomSource(c.args.seed))
        .force(
          "link",
          d3
            .forceLink<{ id: string; x?: number; y?: number }, { source: string; target: string }>(links)
            .id((d) => d.id),
        )
        .force("charge", d3.forceManyBody())
        .force("center", d3.forceCenter(w / 2, h / 2))
        .force("collide", d3.forceCollide(4))
        .force("x", d3.forceX(w / 2).strength(0.02))
        .force("y", d3.forceY(h / 2).strength(0.02));
      if (c.args.radial) sim.force("radial", d3.forceRadial(Math.min(w, h) / 3, w / 2, h / 2));
      sim.stop().tick(iterations);
      return {
        nodes: sim
          .nodes()
          .map((n) => ({ id: n.id, x: Math.round(n.x! * 100) / 100, y: Math.round(n.y! * 100) / 100 })),
        iterations,
      };
    },
  },
  "geo.project": {
    apis: [
      "geoPath",
      "projection.fitSize",
      "projection.invert",
      "geoMercator",
      "geoEqualEarth",
      "geoNaturalEarth1",
      "geoOrthographic",
      "geoAlbersUsa",
      "geoBounds",
      "geoCentroid",
      "geoArea",
      "geoLength",
      "geoContains",
    ],
    description:
      "Project args.points [[lon,lat]] and/or args.geojson with args.projection fitted to args.size",
    run: (c) => {
      const name = z
        .enum(Object.keys(PROJECTIONS) as [string, ...string[]])
        .parse(c.args.projection ?? "equalEarth");
      const size = z.tuple([num, num]).parse(c.args.size ?? [800, 500]);
      const proj = PROJECTIONS[name]!();
      const gj = (c.args.geojson ??
        (c.input && typeof c.input === "object" && "type" in (c.input as object)
          ? c.input
          : null)) as GeoJsonObject | null;
      const points = c.args.points ? pts.parse(c.args.points) : [];
      let fc: FeatureCollection | null = null;
      if (gj) {
        fc =
          gj.type === "FeatureCollection"
            ? fixWinding(gj as FeatureCollection).fc
            : {
                type: "FeatureCollection",
                features: [
                  gj.type === "Feature"
                    ? (gj as never)
                    : { type: "Feature", properties: {}, geometry: gj as never },
                ],
              };
        proj.fitSize(size, fc);
      } else if (points.length) proj.fitSize(size, { type: "MultiPoint", coordinates: points });
      const path = d3.geoPath(proj);
      return {
        projected: points.map((p) => proj(p)),
        inverted: points.slice(0, 1).map((p) => {
          const q = proj(p);
          return q && proj.invert ? proj.invert(q) : null;
        }),
        paths: fc ? fc.features.slice(0, 2000).map((f) => path(f)) : [],
        bounds: fc ? d3.geoBounds(fc) : null,
        centroid: fc ? d3.geoCentroid(fc) : null,
        area: fc ? d3.geoArea(fc) : null,
        length: fc ? d3.geoLength(fc) : null,
        containsFirstPoint: fc && points[0] ? d3.geoContains(fc, points[0]) : null,
      };
    },
  },
  "geo.sphere": {
    apis: ["geoDistance", "geoInterpolate", "geoRotation", "geoCircle", "geoGraticule", "geoGraticule10"],
    description:
      "Great-circle distance/interpolation between args.a and args.b ([lon,lat]); circle of args.radius degrees",
    run: (c) => {
      const a = pt.parse(c.args.a);
      const b = pt.parse(c.args.b);
      const t = z
        .array(z.number().min(0).max(1))
        .max(1000)
        .parse(c.args.t ?? [0, 0.5, 1]);
      const interp = d3.geoInterpolate(a, b);
      return {
        distanceRadians: d3.geoDistance(a, b),
        distanceKm: d3.geoDistance(a, b) * 6371.0088,
        interpolated: t.map(interp),
        rotated: d3.geoRotation([-a[0], -a[1]])(b),
        circleVertices: d3
          .geoCircle()
          .center(a)
          .radius(
            num
              .min(0)
              .max(180)
              .parse(c.args.radius ?? 10),
          )().coordinates[0]!.length,
        graticuleLines: d3.geoGraticule().lines().length,
        graticule10Type: d3.geoGraticule10().type,
      };
    },
  },
  "random.sample": {
    apis: [
      "randomLcg",
      "randomUniform",
      "randomInt",
      "randomNormal",
      "randomLogNormal",
      "randomExponential",
      "randomBates",
      "randomIrwinHall",
      "randomGamma",
      "randomBeta",
      "randomWeibull",
      "randomCauchy",
      "randomLogistic",
      "randomPoisson",
      "randomBinomial",
      "randomGeometric",
      "randomPareto",
      "randomBernoulli",
      "random.source",
    ],
    description: "Deterministic samples (args.seed) from args.distribution with args.params",
    run: (c) => {
      const dist = z
        .enum([
          "uniform",
          "int",
          "normal",
          "logNormal",
          "exponential",
          "bates",
          "irwinHall",
          "gamma",
          "beta",
          "weibull",
          "cauchy",
          "logistic",
          "poisson",
          "binomial",
          "geometric",
          "pareto",
          "bernoulli",
        ])
        .parse(c.args.distribution ?? "normal");
      const params = z
        .array(num)
        .max(3)
        .parse(c.args.params ?? []);
      const count = z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .parse(c.args.count ?? 100);
      const source = randomSource(c.args.seed);
      const name = `random${dist.charAt(0).toUpperCase()}${dist.slice(1)}`;
      const gen = (D3[name] as { source(s: () => number): (...p: number[]) => () => number }).source(source);
      const f = gen(...params);
      return Array.from({ length: count }, () => f());
    },
  },
  "dsv.format": {
    apis: [
      "csvFormat",
      "tsvFormat",
      "csvParse",
      "tsvParse",
      "dsvFormat",
      "dsv.parse",
      "dsv.format",
      "autoType",
      "csvFormatRows",
      "csvParseRows",
    ],
    description: "Serialize records to CSV/TSV (args.format) or parse args.text",
    run: (c) => {
      const format = z.enum(["csv", "tsv", "pipe"]).parse(c.args.format ?? "csv");
      if (typeof c.args.text === "string") {
        if (c.args.text.length > 5_000_000) throw new D3McpError("LIMIT_EXCEEDED", "text too large");
        const parsed =
          format === "csv"
            ? d3.csvParse(c.args.text, d3.autoType)
            : format === "tsv"
              ? d3.tsvParse(c.args.text, d3.autoType)
              : d3.dsvFormat("|").parse(c.args.text, d3.autoType);
        return {
          rows: parsed.slice(0, 10_000),
          columns: parsed.columns,
          rawRows: d3.csvParseRows(format === "csv" ? c.args.text : "").length,
        };
      }
      const r = rows(c);
      return {
        text:
          format === "csv"
            ? d3.csvFormat(r)
            : format === "tsv"
              ? d3.tsvFormat(r)
              : d3.dsvFormat("|").format(r),
        headerRow: d3.csvFormatRows([Object.keys(r[0] ?? {})]),
      };
    },
  },
  "ease.sample": {
    apis: [
      "easeLinear",
      "easeQuadInOut",
      "easeCubicInOut",
      "easeSinInOut",
      "easeExpInOut",
      "easeCircleInOut",
      "easeElasticOut",
      "easeBackInOut",
      "easeBounceOut",
      "easePolyInOut",
    ],
    description: "Sample easing function args.name (e.g. CubicInOut) at args.t",
    run: (c) => {
      const f = namedFn<(t: number) => number>("ease", z.string().parse(c.args.name ?? "CubicInOut"));
      return z
        .array(z.number().min(0).max(1))
        .max(1000)
        .parse(c.args.t ?? [0, 0.25, 0.5, 0.75, 1])
        .map((t) => ({ t, value: f(t) }));
    },
  },
};

export const StepSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    op: z.enum(Object.keys(OPS) as [string, ...string[]]),
    input: z
      .union([
        z.string().regex(/^\$[A-Za-z0-9_-]{1,40}$/),
        z.array(z.unknown()).max(200_000),
        z.record(z.string(), z.unknown()),
      ])
      .optional()
      .describe('"$data", "$links", "$hierarchy", "$geojson", "$<stepId>" or a literal array/object'),
    field: z.string().max(200).optional().describe("Field accessor (records only); no code is evaluated"),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const CompositionSchema = z.object({ steps: z.array(StepSchema).min(1).max(50) }).strict();
export type Composition = z.infer<typeof CompositionSchema>;

export interface CompositionResult {
  results: Record<string, unknown>;
  d3ApisUsed: string[];
  truncated: string[];
}

function cap(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const s = JSON.stringify(value) ?? "null";
  if (s.length <= maxBytes) return { value, truncated: false };
  if (Array.isArray(value)) {
    const n = Math.max(1, Math.floor((value.length * maxBytes) / s.length) - 1);
    return { value: value.slice(0, n), truncated: true };
  }
  return { value: { truncated: true, preview: s.slice(0, maxBytes) }, truncated: true };
}

/** Execute a validated, declarative pipeline of whitelisted D3 operations. No user code is evaluated. */
export function executeComposition(
  input: unknown,
  dataset?: Dataset,
  maxResultBytes = 1_000_000,
): CompositionResult {
  const comp = CompositionSchema.parse(input);
  const results: Record<string, unknown> = {};
  const used = new Set<string>();
  const truncated: string[] = [];
  const resolve = (ref: unknown): unknown => {
    if (typeof ref !== "string") return ref;
    if (ref === "$data") return dataset?.rows ?? fail("$data requires data or dataset_id");
    if (ref === "$links") return dataset?.links ?? fail("$links requires graph data");
    if (ref === "$hierarchy") return dataset?.hierarchy ?? fail("$hierarchy requires hierarchy data");
    if (ref === "$geojson") return dataset?.geojson ?? fail("$geojson requires GeoJSON data");
    const id = ref.slice(1);
    if (!(id in results)) fail(`Unknown step reference ${ref}; steps can only reference earlier steps`);
    return results[id];
  };
  for (const step of comp.steps) {
    if (step.id in results) fail(`Duplicate step id "${step.id}"`);
    const op = OPS[step.op]!;
    const args = Object.fromEntries(
      Object.entries(step.args).map(([k, v]) => [
        k,
        typeof v === "string" && /^\$[A-Za-z0-9_-]+$/.test(v) ? resolve(v) : v,
      ]),
    );
    let out: unknown;
    try {
      out = op.run({ input: resolve(step.input), ...(step.field ? { field: step.field } : {}), args });
    } catch (e) {
      if (e instanceof D3McpError)
        throw new D3McpError(e.code, `Step "${step.id}" (${step.op}): ${e.message}`, e.hint);
      if (e && typeof e === "object" && "issues" in e)
        throw new D3McpError(
          "COMPOSITION_ERROR",
          `Step "${step.id}" (${step.op}) has invalid args: ${(e as unknown as { message: string }).message.slice(0, 500)}`,
        );
      throw new D3McpError(
        "COMPOSITION_ERROR",
        `Step "${step.id}" (${step.op}) failed: ${(e as Error).message}`,
      );
    }
    const c = cap(out, maxResultBytes);
    if (c.truncated) truncated.push(step.id);
    results[step.id] = c.value;
    op.apis.forEach((a) => used.add(a));
  }
  return { results, d3ApisUsed: [...used].sort(), truncated };
}

function fail(msg: string): never {
  throw new D3McpError("COMPOSITION_ERROR", msg);
}
