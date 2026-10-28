import { extent, format as d3format, max, mean, min, sum, utcFormat } from "d3";
import type { DataProfile, FieldProfile } from "../data/profile.js";
import type { Dataset } from "../data/types.js";
import { toDate, toNumber } from "../data/values.js";
import type { Encoding, VisType } from "../schema/spec.js";
import { ADDITIVE, mentionedFields, recommend, type Recommendation } from "./recommend.js";

export type ChartFamily =
  | "trend"
  | "comparison"
  | "share"
  | "distribution"
  | "relationship"
  | "matrix"
  | "network"
  | "hierarchy"
  | "geo"
  | "other";

const FAMILY: Partial<Record<VisType, ChartFamily>> = {
  line: "trend",
  area: "trend",
  "stacked-area": "trend",
  cumulative: "trend",
  bar: "comparison",
  "grouped-bar": "comparison",
  "stacked-bar": "comparison",
  waterfall: "comparison",
  pie: "share",
  donut: "share",
  histogram: "distribution",
  density: "distribution",
  boxplot: "distribution",
  scatter: "relationship",
  bubble: "relationship",
  "connected-scatter": "relationship",
  contour: "relationship",
  heatmap: "matrix",
  force: "network",
  "radial-network": "network",
  chord: "network",
  sankey: "network",
  treemap: "hierarchy",
  sunburst: "hierarchy",
  pack: "hierarchy",
  tree: "hierarchy",
  cluster: "hierarchy",
  partition: "hierarchy",
  geo: "geo",
};

/** How many charts of each family a dashboard may hold before other families get a turn. */
const FAMILY_CAP: Record<ChartFamily, number> = {
  trend: 3,
  comparison: 2,
  share: 1,
  distribution: 1,
  relationship: 1,
  matrix: 1,
  network: 2,
  hierarchy: 2,
  geo: 1,
  other: 0,
};
const FAMILY_ORDER: ChartFamily[] = [
  "trend",
  "comparison",
  "geo",
  "network",
  "hierarchy",
  "share",
  "relationship",
  "distribution",
  "matrix",
  "other",
];

export interface DashboardCandidate {
  datasetIndex: number;
  type: VisType;
  family: ChartFamily;
  encoding: Encoding;
  question: string;
  rationale: string;
  score: number;
  options?: Record<string, unknown>;
}

export interface Kpi {
  label: string;
  value: string;
  detail?: string;
}

const fmt = (n: number) => (Math.abs(n) >= 1e6 ? d3format(".3~s")(n) : d3format(",.4~r")(n));

function signature(c: { type: VisType; encoding: Encoding }): string {
  const enc = Object.entries(c.encoding)
    .filter(([k]) => k !== "tooltip")
    .map(
      ([k, v]) =>
        `${k}=${(v as { field?: string; aggregate?: string }).field ?? ""}${(v as { aggregate?: string }).aggregate ?? ""}`,
    )
    .sort()
    .join(",");
  return `${FAMILY[c.type] ?? c.type}|${enc}`;
}

function measures(profile: DataProfile, prompt: string): FieldProfile[] {
  const q = profile.fields.filter(
    (f) =>
      f.type === "quantitative" &&
      !f.semantic.includes("identifier") &&
      !f.semantic.includes("latitude") &&
      !f.semantic.includes("longitude") &&
      !["_index", "depth"].includes(f.name),
  );
  const m = mentionedFields(
    prompt,
    q.map((f) => f.name),
  );
  return [...q].sort(
    (a, b) => (m.includes(a.name) ? m.indexOf(a.name) : 99) - (m.includes(b.name) ? m.indexOf(b.name) : 99),
  );
}

/** Extra candidates the single-chart recommender does not produce: one trend per measure, one comparison per measure. */
function perMeasureCandidates(
  recs: Recommendation[],
  profile: DataProfile,
  prompt: string,
): Recommendation[] {
  const extra: Recommendation[] = [];
  const Q = measures(profile, prompt).slice(1, 3);
  const line = recs.find((r) => r.type === "line");
  const bar = recs.find((r) => r.type === "bar");
  for (const [i, q] of Q.entries()) {
    if (line?.encoding.y) {
      extra.push({
        ...line,
        score: line.score - 5 - i,
        encoding: { ...line.encoding, y: { field: q.name } },
        question: `How does ${q.name} change over time${line.encoding.series ? ` for each ${line.encoding.series.field}` : ""}?`,
        rationale: `Additional measure ${q.name} on the shared time axis.`,
      });
    }
    if (bar?.encoding.y && bar.encoding.x) {
      const agg = bar.encoding.y.aggregate
        ? { aggregate: ADDITIVE.test(q.name) ? ("sum" as const) : ("mean" as const) }
        : {};
      extra.push({
        ...bar,
        score: bar.score - 12 - i,
        encoding: { ...bar.encoding, y: { field: q.name, ...agg } },
        question: `How does ${q.name} compare across ${bar.encoding.x.field}?`,
        rationale: `Additional measure ${q.name}${agg.aggregate ? ` (${agg.aggregate} per ${bar.encoding.x.field})` : ""}.`,
      });
    }
  }
  return extra;
}

/**
 * Rank chart candidates for a dashboard across one or more datasets. Families are capped so the dashboard
 * mixes views (trend, comparison, share, distribution, ...) instead of repeating one chart type.
 */
export function planDashboardCandidates(
  inputs: Array<{ dataset: Dataset; profile: DataProfile; prompt: string }>,
  maxCharts: number,
): DashboardCandidate[] {
  const pool: DashboardCandidate[] = [];
  inputs.forEach(({ dataset, profile, prompt }, datasetIndex) => {
    const recs = recommend(dataset, profile, prompt);
    // Each additional dataset starts slightly lower so the first dataset leads, but every dataset gets its best chart early.
    const offset = datasetIndex * 3;
    for (const r of [...recs, ...perMeasureCandidates(recs, profile, prompt)]) {
      const family = FAMILY[r.type] ?? "other";
      if (family === "other" || r.score < 15) continue;
      pool.push({
        datasetIndex,
        type: r.type,
        family,
        encoding: r.encoding,
        question: r.question,
        rationale: r.rationale,
        score: r.score - offset,
        ...(r.options ? { options: r.options } : {}),
      });
    }
  });
  pool.sort((a, b) => b.score - a.score);
  const chosen: DashboardCandidate[] = [];
  const used = new Map<string, number>();
  const seen = new Set<string>();
  const take = (c: DashboardCandidate) => {
    chosen.push(c);
    seen.add(`${c.datasetIndex}|${signature(c)}`);
    const k = `${c.datasetIndex}|${c.family}`;
    used.set(k, (used.get(k) ?? 0) + 1);
  };
  // First pass: the best chart of each dataset, so multi-dataset dashboards cover every input.
  for (let i = 0; i < inputs.length; i++) {
    const best = pool.find((c) => c.datasetIndex === i);
    if (best) take(best);
  }
  for (const c of pool) {
    if (seen.has(`${c.datasetIndex}|${signature(c)}`)) continue;
    if ((used.get(`${c.datasetIndex}|${c.family}`) ?? 0) >= FAMILY_CAP[c.family]) continue;
    take(c);
  }
  // Leftovers (beyond caps) are kept as fallbacks in case a chosen chart cannot render.
  const fallbacks = pool.filter((c) => !seen.has(`${c.datasetIndex}|${signature(c)}`));
  // Select by priority (per-dataset best first, then score); only the selected charts are re-ordered for display.
  const display = (cs: DashboardCandidate[]) =>
    [...cs].sort(
      (a, b) =>
        a.datasetIndex - b.datasetIndex ||
        FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
        b.score - a.score,
    );
  return [...display(chosen.slice(0, maxCharts)), ...chosen.slice(maxCharts), ...fallbacks];
}

/** Descriptive headline figures. Totals only for fields whose names suggest additive quantities; otherwise averages. */
export function computeKpis(
  dataset: Dataset,
  profile: DataProfile,
  prompt: string,
  label?: string,
  limit = 6,
): Kpi[] {
  const prefix = label ? `${label} · ` : "";
  const kpis: Kpi[] = [];
  const unit =
    dataset.kind === "graph"
      ? "nodes"
      : dataset.kind === "geo"
        ? "features"
        : dataset.kind === "hierarchy"
          ? "nodes"
          : "records";
  kpis.push({
    label: `${prefix}${unit}`,
    value: fmt(dataset.rows.length),
    ...(dataset.kind === "graph" ? { detail: `${dataset.links?.length ?? 0} links` } : {}),
  });
  for (const f of measures(profile, prompt).slice(0, 3)) {
    const vals = dataset.rows.map((r) => toNumber(r[f.name] ?? null)).filter((v): v is number => v !== null);
    if (!vals.length) continue;
    const range = `min ${fmt(min(vals)!)} · max ${fmt(max(vals)!)}`;
    if (ADDITIVE.test(f.name))
      kpis.push({
        label: `${prefix}${/^total|total$/i.test(f.name) ? f.name : `total ${f.name}`}`,
        value: fmt(sum(vals)),
        detail: range,
      });
    else kpis.push({ label: `${prefix}avg ${f.name}`, value: fmt(mean(vals)!), detail: range });
  }
  const t = profile.fields.find((f) => f.type === "temporal");
  if (t) {
    const dates = dataset.rows.map((r) => toDate(r[t.name] ?? null)).filter((d): d is Date => d !== null);
    const [a, b] = extent(dates);
    if (a && b) {
      const day = utcFormat("%b %-d, %Y");
      kpis.push({
        label: `${prefix}${t.name} range`,
        value: day(a) === day(b) ? day(a) : `${day(a)} – ${day(b)}`,
        detail: `${dates.length} timestamps`,
      });
    }
  }
  const cat = profile.fields.find(
    (f) => f.type === "nominal" && f.unique > 1 && f.unique <= 1000 && f.name !== "_sheet",
  );
  if (cat && kpis.length < 6)
    kpis.push({
      label: `${prefix}${cat.name} values`,
      value: fmt(cat.unique),
      ...(cat.topValues?.[0] ? { detail: `most frequent: ${cat.topValues[0].value}` } : {}),
    });
  return kpis.slice(0, limit);
}
