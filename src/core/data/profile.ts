import { deviation, extent, max, mean, median, min, quantile, rollup, sort } from "d3";
import type { Dataset, FieldType, Row, Scalar } from "./types.js";
import { looksTemporal, toDate } from "./values.js";

export interface NumericSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number | null;
  q1: number;
  q3: number;
  outlierCount: number;
  outlierRule: string;
}

export interface FieldProfile {
  name: string;
  type: FieldType;
  semantic: string[];
  count: number;
  missing: number;
  unique: number;
  numeric?: NumericSummary;
  temporal?: { min: string; max: string; spanDays: number };
  topValues?: Array<{ value: string; count: number }>;
  mixedTypes?: Record<string, number>;
}

export interface Correlation {
  a: string;
  b: string;
  pearson: number;
  n: number;
}

export interface DataProfile {
  datasetId: string;
  kind: Dataset["kind"];
  rowCount: number;
  linkCount?: number;
  fields: FieldProfile[];
  correlations: Correlation[];
  notes: string[];
}

const LAT = /^(lat|latitude)$/i;
const LON = /^(lon|lng|long|longitude)$/i;
const ID = /(^id$|_id$|Id$|^key$|^uuid$)/;

function jsType(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "string") return looksTemporal(v) ? "temporal-string" : "string";
  return typeof v;
}

export function profileField(name: string, rows: Row[]): FieldProfile {
  const values = rows.map((r) => (name in r ? r[name]! : null));
  const present = values.filter((v): v is Exclude<Scalar, null> => v !== null && v !== "");
  const typeCounts = rollup(present, (g) => g.length, jsType);
  const unique = new Set(present.map(String)).size;
  const semantic: string[] = [];
  let type: FieldType;
  const dominant = sort([...typeCounts], (d) => -d[1])[0]?.[0];
  const mixed =
    typeCounts.size > 1 &&
    !(typeCounts.size === 2 && typeCounts.has("string") && typeCounts.has("temporal-string"));

  if (present.length === 0) type = "nominal";
  else if (mixed) type = "mixed";
  else if (dominant === "number") type = "quantitative";
  else if (dominant === "boolean") type = "boolean";
  else if (dominant === "temporal-string" && (typeCounts.get("temporal-string") ?? 0) / present.length >= 0.9)
    type = "temporal";
  else type = "nominal";

  if (ID.test(name) && unique === present.length && present.length > 0) {
    semantic.push("identifier");
    if (type === "nominal" || (type === "quantitative" && present.every((v) => Number.isInteger(v))))
      type = "identifier";
  }
  if (/^(source|from|src)$/i.test(name)) semantic.push("link-source");
  if (/^(target|to|dst|dest)$/i.test(name)) semantic.push("link-target");
  if (/^(parent|parent_id|parentId)$/i.test(name)) semantic.push("hierarchy-parent");
  if (/(date|time|timestamp|day|month|year|ts)$/i.test(name)) semantic.push("time-like-name");
  if (/(country|state|region|city|iso|fips|county)/i.test(name)) semantic.push("geographic-name");

  const profile: FieldProfile = {
    name,
    type,
    semantic,
    count: values.length,
    missing: values.length - present.length,
    unique,
  };
  if (mixed) profile.mixedTypes = Object.fromEntries(typeCounts);

  if (type === "quantitative") {
    const nums = present as number[];
    const sorted = sort(nums);
    const q1 = quantile(sorted, 0.25)!;
    const q3 = quantile(sorted, 0.75)!;
    const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    profile.numeric = {
      min: min(nums)!,
      max: max(nums)!,
      mean: mean(nums)!,
      median: median(nums)!,
      stdev: deviation(nums) ?? null,
      q1,
      q3,
      outlierCount: nums.filter((v) => v < lo || v > hi).length,
      outlierRule: "Tukey fences: value < Q1 − 1.5·IQR or > Q3 + 1.5·IQR",
    };
    if (LAT.test(name) && profile.numeric.min >= -90 && profile.numeric.max <= 90) semantic.push("latitude");
    if (LON.test(name) && profile.numeric.min >= -180 && profile.numeric.max <= 180)
      semantic.push("longitude");
  }
  if (type === "temporal") {
    const dates = present.map((v) => toDate(v)).filter((d): d is Date => d !== null);
    const [d0, d1] = extent(dates) as [Date, Date];
    profile.temporal = {
      min: d0.toISOString(),
      max: d1.toISOString(),
      spanDays: Math.round(((+d1 - +d0) / 86_400_000) * 100) / 100,
    };
  }
  if (type === "nominal" || type === "boolean" || type === "mixed" || type === "identifier") {
    const counts = rollup(
      present,
      (g) => g.length,
      (v) => String(v),
    );
    profile.topValues = sort([...counts], (d) => -d[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));
  }
  return profile;
}

function pearson(rows: Row[], a: string, b: string): Correlation | null {
  const pairs: Array<[number, number]> = [];
  for (const r of rows) {
    const x = r[a];
    const y = r[b];
    if (typeof x === "number" && typeof y === "number") pairs.push([x, y]);
  }
  // Coefficients from fewer than 10 pairs are too unstable to report.
  if (pairs.length < 10) return null;
  const mx = mean(pairs, (p) => p[0])!;
  const my = mean(pairs, (p) => p[1])!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return { a, b, pearson: Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000, n: pairs.length };
}

export function profileDataset(ds: Dataset): DataProfile {
  const names = new Set<string>();
  for (const r of ds.rows) for (const k of Object.keys(r)) names.add(k);
  const fields = [...names].map((n) => profileField(n, ds.rows));
  const numeric = fields.filter((f) => f.type === "quantitative").map((f) => f.name);
  const correlations: Correlation[] = [];
  for (let i = 0; i < numeric.length && i < 30; i++) {
    for (let j = i + 1; j < numeric.length && j < 30; j++) {
      const c = pearson(ds.rows, numeric[i]!, numeric[j]!);
      if (c && Math.abs(c.pearson) >= 0.5) correlations.push(c);
    }
  }
  correlations.sort((x, y) => Math.abs(y.pearson) - Math.abs(x.pearson));
  const notes: string[] = [];
  if (correlations.length) {
    notes.push("Correlations (|r| ≥ 0.5) are descriptive only and do not imply causation.");
  }
  const mixedFields = fields.filter((f) => f.type === "mixed");
  if (mixedFields.length) {
    notes.push(`Fields with mixed value types (not coerced): ${mixedFields.map((f) => f.name).join(", ")}.`);
  }
  const withMissing = fields.filter((f) => f.missing > 0);
  if (withMissing.length) {
    notes.push(
      `Missing values present in: ${withMissing.map((f) => `${f.name} (${f.missing})`).join(", ")}. No imputation is performed.`,
    );
  }
  return {
    datasetId: ds.id,
    kind: ds.kind,
    rowCount: ds.rows.length,
    ...(ds.links ? { linkCount: ds.links.length } : {}),
    fields,
    correlations: correlations.slice(0, 20),
    notes,
  };
}
