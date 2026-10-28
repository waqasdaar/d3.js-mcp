import { descending, extent, format, groups, mean, quantile, rollup, sum } from "d3";
import type { Dataset, Row } from "../data/types.js";
import { toDate, toLabel, toNumber } from "../data/values.js";
import type { VisualizationSpec } from "../schema/spec.js";
import { applyTransforms } from "../../renderers/transforms.js";

const f = (n: number) => format(",~r")(Math.round(n * 1000) / 1000);
const pct = format(".1%");

/** Below this many pairs a correlation coefficient is too unstable to report as a finding. */
export const MIN_CORRELATION_N = 10;

function pearson(rows: Row[], a: string, b: string): { r: number; n: number } | null {
  const p = rows
    .map((r) => [toNumber(r[a] ?? null), toNumber(r[b] ?? null)])
    .filter((x): x is [number, number] => x[0] !== null && x[1] !== null);
  if (p.length < 3) return null;
  const mx = mean(p, (d) => d[0])!;
  const my = mean(p, (d) => d[1])!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of p) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? { r: sxy / Math.sqrt(sxx * syy), n: p.length } : null;
}

/** Deterministic, descriptive findings computed from the data. They never assert causation. */
export function computeFindings(spec: VisualizationSpec, ds: Dataset): string[] {
  const out: string[] = [];
  const { rows } = applyTransforms(ds.rows, spec.transforms);
  const e = spec.encoding;
  try {
    if (ds.kind === "graph" && ds.links) {
      const deg = new Map<string, number>();
      for (const l of ds.links)
        for (const end of [l.source, l.target]) deg.set(String(end), (deg.get(String(end)) ?? 0) + 1);
      const top = [...deg].sort((a, b) => descending(a[1], b[1])).slice(0, 3);
      const parent = new Map<string, string>(ds.rows.map((n) => [String(n.id), String(n.id)]));
      const find = (x: string): string =>
        parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!);
      for (const l of ds.links) parent.set(find(String(l.source)), find(String(l.target)));
      const components = new Set(ds.rows.map((n) => find(String(n.id)))).size;
      out.push(
        `${ds.rows.length} nodes and ${ds.links.length} links in ${components} connected component(s).`,
      );
      if (top.length) out.push(`Highest-degree nodes: ${top.map(([k, v]) => `${k} (${v})`).join(", ")}.`);
      const isolated = ds.rows.filter((n) => !deg.has(String(n.id))).length;
      if (isolated) out.push(`${isolated} node(s) have no links.`);
      return out;
    }
    if (ds.kind === "hierarchy" && ds.hierarchy) {
      const kids = (ds.hierarchy.children ?? []) as Array<{
        name?: string;
        value?: number;
        children?: unknown[];
      }>;
      const total = (n: { value?: number; children?: unknown[] }): number =>
        n.children?.length
          ? sum(n.children as Array<{ value?: number }>, (c) => total(c as never))
          : (n.value ?? 0);
      const sums = kids.map((k) => [String(k.name ?? "?"), total(k)] as const).sort((a, b) => b[1] - a[1]);
      const all = sum(sums, (s) => s[1]);
      out.push(
        `${ds.rows.length} nodes; ${ds.rows.filter((r) => r.leaf).length} leaves; maximum depth ${Math.max(...ds.rows.map((r) => Number(r.depth)))}.`,
      );
      if (sums[0] && all > 0)
        out.push(
          `Largest top-level branch: ${sums[0][0]} (${pct(sums[0][1] / all)} of total value ${f(all)}).`,
        );
      return out;
    }
    const x = e.x?.field;
    const y = e.y?.field ?? e.value?.field;
    switch (spec.type) {
      case "bar":
      case "pie":
      case "donut":
      case "grouped-bar":
      case "stacked-bar": {
        const key =
          spec.type === "pie" || spec.type === "donut" ? (e.color?.field ?? e.x?.field ?? e.label?.field) : x;
        if (!key || !y) break;
        const agg = e.y?.aggregate ?? e.value?.aggregate ?? "sum";
        const sums = [
          ...rollup(
            rows,
            (g) =>
              (agg === "mean"
                ? mean(g, (r) => toNumber(r[y] ?? null) ?? undefined)
                : agg === "count"
                  ? g.length
                  : sum(g, (r) => toNumber(r[y] ?? null) ?? 0)) ?? 0,
            (r) => toLabel(r[key] ?? null),
          ),
        ].sort((a, b) => b[1] - a[1]);
        const total = sum(sums, (s) => s[1]);
        if (sums.length) {
          out.push(
            `Highest ${agg} of ${y}: ${sums[0]![0]} (${f(sums[0]![1])}${agg === "sum" && total > 0 ? `, ${pct(sums[0]![1] / total)} of total` : ""}).`,
          );
          out.push(`Lowest: ${sums.at(-1)![0]} (${f(sums.at(-1)![1])}). ${sums.length} categories compared.`);
        }
        break;
      }
      case "line":
      case "area":
      case "cumulative":
      case "stacked-area": {
        if (!x || !y) break;
        const s = e.series?.field ?? e.color?.field;
        for (const [k, g] of groups(rows, (r) => (s ? toLabel(r[s] ?? null) : "all")).slice(0, 8)) {
          const pts = g
            .map((r) => ({ t: toDate(r[x] ?? null), v: toNumber(r[y] ?? null) }))
            .filter((p): p is { t: Date; v: number } => p.t !== null && p.v !== null)
            .sort((a, b) => +a.t - +b.t);
          if (pts.length < 2) continue;
          const first = pts[0]!;
          const last = pts.at(-1)!;
          const maxP = pts.reduce((m, p) => (p.v > m.v ? p : m));
          const change = first.v !== 0 ? ` (${pct((last.v - first.v) / Math.abs(first.v))})` : "";
          out.push(
            `${s ? `${k}: ` : ""}${y} went from ${f(first.v)} to ${f(last.v)}${change} between ${first.t.toISOString().slice(0, 10)} and ${last.t.toISOString().slice(0, 10)}; peak ${f(maxP.v)} at ${maxP.t.toISOString().replace(".000Z", "Z")}.`,
          );
        }
        break;
      }
      case "scatter":
      case "bubble":
      case "connected-scatter":
      case "contour":
      case "voronoi":
      case "delaunay": {
        if (!x || !e.y?.field) break;
        const c = pearson(rows, x, e.y.field);
        if (c && c.n < MIN_CORRELATION_N) {
          out.push(
            `Only ${c.n} paired values of ${x} and ${e.y.field}; too few to assess correlation (needs at least ${MIN_CORRELATION_N}).`,
          );
        } else if (c)
          out.push(
            `Pearson correlation between ${x} and ${e.y.field}: r = ${c.r.toFixed(3)} (n = ${c.n}). Correlation does not imply causation.`,
          );
        break;
      }
      case "histogram":
      case "boxplot":
      case "density": {
        const fld = spec.type === "boxplot" ? y : x;
        if (!fld) break;
        const v = rows
          .map((r) => toNumber(r[fld] ?? null))
          .filter((n): n is number => n !== null)
          .sort((a, b) => a - b);
        if (v.length < 2) break;
        const q1 = quantile(v, 0.25)!;
        const q3 = quantile(v, 0.75)!;
        const iqr = q3 - q1;
        const outliers = v.filter((n) => n < q1 - 1.5 * iqr || n > q3 + 1.5 * iqr).length;
        const [lo, hi] = extent(v) as [number, number];
        out.push(
          `${fld}: median ${f(quantile(v, 0.5)!)}, IQR ${f(q1)}–${f(q3)}, range ${f(lo)}–${f(hi)} (n = ${v.length}); ${outliers} value(s) beyond 1.5·IQR.`,
        );
        break;
      }
      case "heatmap": {
        const v = e.color?.field ?? e.value?.field;
        if (!x || !e.y?.field || !v) break;
        const cells = [
          ...rollup(
            rows,
            (g) => sum(g, (r) => toNumber(r[v] ?? null) ?? 0),
            (r) => `${toLabel(r[x] ?? null)} × ${toLabel(r[e.y!.field] ?? null)}`,
          ),
        ].sort((a, b) => b[1] - a[1]);
        if (cells[0]) out.push(`Highest cell: ${cells[0][0]} (${f(cells[0][1])}).`);
        break;
      }
      case "geo": {
        const v = e.color?.field ?? e.size?.field;
        const label = e.label?.field ?? (rows[0] && "name" in rows[0] ? "name" : undefined);
        if (!v) {
          out.push(`${rows.length} geographic features/points plotted.`);
          break;
        }
        const sorted = rows
          .filter((r) => toNumber(r[v] ?? null) !== null)
          .sort((a, b) => toNumber(b[v] ?? null)! - toNumber(a[v] ?? null)!);
        if (sorted.length)
          out.push(
            `Highest ${v}: ${label ? toLabel(sorted[0]![label] ?? null) : "feature " + sorted[0]!._index} (${f(toNumber(sorted[0]![v] ?? null)!)}); lowest: ${label ? toLabel(sorted.at(-1)![label] ?? null) : "feature " + sorted.at(-1)!._index} (${f(toNumber(sorted.at(-1)![v] ?? null)!)}).`,
          );
        break;
      }
      default:
        break;
    }
  } catch {
    out.push("Findings could not be computed for this configuration.");
  }
  return out;
}
