import { D3McpError } from "../../shared/errors.js";
import { FORBIDDEN_KEYS } from "../../shared/escape.js";
import type { Dataset, Row, Scalar } from "./types.js";

export interface LinkSource {
  ds: Dataset;
  label: string;
}

export interface LinkCandidate {
  left: string;
  leftField: string;
  right: string;
  rightField: string;
  /** Shared distinct key values. */
  overlap: number;
  /** Share of each side's distinct values found on the other side. */
  leftCoverage: number;
  rightCoverage: number;
  nameSimilarity: number;
  cardinality: "1:1" | "1:N" | "N:1" | "N:M";
  score: number;
  sampleMatches: string[];
  description: string;
}

export interface LinkSpec {
  left: string;
  leftField: string;
  right: string;
  rightField: string;
  how?: "left" | "inner";
}

export interface LinkQuestion {
  id: string;
  pair: [string, string];
  question: string;
  options: Array<{ value: string; label: string }>;
  why: string;
  /** False when no candidate is plausible enough to hold up a dashboard (reported as a note instead). */
  blocking: boolean;
}

export interface LinkAnalysis {
  candidates: LinkCandidate[];
  recommended: LinkSpec[];
  questions: LinkQuestion[];
}

/** Values are compared trimmed and case-insensitively, so "SJC", " sjc" and "Sjc" link. */
export function normKey(v: Scalar | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v).trim().toLowerCase().replace(/\|/g, "¦");
}

const MAX_DISTINCT = 20_000;

function distinct(rows: Row[], field: string): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    const v = r[field];
    if (v === null || v === undefined || v === "") continue;
    s.add(normKey(v));
    if (s.size > MAX_DISTINCT) break;
  }
  return s;
}

function fieldsOf(rows: Row[]): string[] {
  const s = new Set<string>();
  for (const r of rows.slice(0, 500)) Object.keys(r).forEach((k) => s.add(k));
  return [...s];
}

/** Fields that can identify an entity: text or id-like integers, not dates or measures, more than one distinct value. */
function keyFields(src: LinkSource): Array<{ field: string; values: Set<string>; unique: boolean }> {
  const rows = src.ds.rows;
  const out = [];
  for (const f of fieldsOf(rows)) {
    if (["_index", "depth", "leaf", "parent", "_sheet"].includes(f)) continue;
    const vals = rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined && v !== "");
    if (!vals.length) continue;
    const idLike = /(^|_)(id|code|key|no|num|number)$/i.test(f) || /[a-z]Id$/.test(f);
    if (vals.some((v) => typeof v === "number") && !idLike) continue;
    if (vals.every((v) => typeof v === "boolean")) continue;
    if (vals.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) continue;
    const values = distinct(rows, f);
    if (values.size < 2 && rows.length > 1) continue;
    out.push({ field: f, values, unique: values.size === vals.length });
  }
  return out;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !["id", "key", "code", "name", "no", "num"].includes(t));

/** 1 for the same name, 0.7 when the meaningful words overlap (site ~ site_code ~ siteId), else 0. */
export function nameSimilarity(a: string, b: string): number {
  if (a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "")) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length && tb.length && ta.some((t) => tb.includes(t))) return 0.7;
  if (/^(id|key|code|name)$/i.test(a) || /^(id|key|code|name)$/i.test(b)) return 0.3;
  return 0;
}

function describe(c: Omit<LinkCandidate, "description">): string {
  return `${c.left}.${c.leftField} = ${c.right}.${c.rightField}: ${c.overlap} shared value(s); ${Math.round(c.leftCoverage * 100)}% of ${c.left} and ${Math.round(c.rightCoverage * 100)}% of ${c.right} values match (${c.cardinality})`;
}

/** Rank candidate join keys between every pair of sources and decide which links are clear and which need a question. */
export function analyzeLinks(sources: LinkSource[], explicit: LinkSpec[] = []): LinkAnalysis {
  const keys = sources.map(keyFields);
  const candidates: LinkCandidate[] = [];
  const recommended: LinkSpec[] = [];
  const questions: LinkQuestion[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const A = sources[i]!;
      const B = sources[j]!;
      const given = explicit.find(
        (l) => (l.left === A.label && l.right === B.label) || (l.left === B.label && l.right === A.label),
      );
      const pair: LinkCandidate[] = [];
      for (const ka of keys[i]!) {
        for (const kb of keys[j]!) {
          let overlap = 0;
          const [small, large] =
            ka.values.size <= kb.values.size ? [ka.values, kb.values] : [kb.values, ka.values];
          const sample: string[] = [];
          for (const v of small) {
            if (large.has(v)) {
              overlap++;
              if (sample.length < 5) sample.push(v);
            }
          }
          if (!overlap) continue;
          const leftCoverage = overlap / ka.values.size;
          const rightCoverage = overlap / kb.values.size;
          const nameSim = nameSimilarity(ka.field, kb.field);
          const containment = Math.max(leftCoverage, rightCoverage);
          // Single shared values of large domains (e.g. a stray "1") are noise unless the names agree.
          if (overlap < 2 && nameSim < 0.7) continue;
          if (containment < 0.3 && nameSim < 0.7) continue;
          const score =
            Math.round(
              (0.65 * containment + 0.2 * Math.min(leftCoverage, rightCoverage) + 0.15 * nameSim) * 1000,
            ) / 1000;
          const c = {
            left: A.label,
            leftField: ka.field,
            right: B.label,
            rightField: kb.field,
            overlap,
            leftCoverage: Math.round(leftCoverage * 1000) / 1000,
            rightCoverage: Math.round(rightCoverage * 1000) / 1000,
            nameSimilarity: nameSim,
            cardinality: (ka.unique && kb.unique
              ? "1:1"
              : ka.unique
                ? "1:N"
                : kb.unique
                  ? "N:1"
                  : "N:M") as LinkCandidate["cardinality"],
            score,
            sampleMatches: sample,
          };
          pair.push({ ...c, description: describe(c) });
        }
      }
      pair.sort((a, b) => b.score - a.score);
      candidates.push(...pair.slice(0, 5));
      if (given) {
        recommended.push(given);
        continue;
      }
      const qid = `link_${i}_${j}`;
      const options = pair
        .slice(0, 4)
        .map((c) => ({ value: `${c.left}.${c.leftField}=${c.right}.${c.rightField}`, label: c.description }));
      const top = pair[0];
      const second = pair[1];
      const clear =
        top && top.score >= 0.6 && (!second || top.score - second.score >= 0.12) && top.cardinality !== "N:M";
      if (clear) {
        recommended.push({
          left: top.left,
          leftField: top.leftField,
          right: top.right,
          rightField: top.rightField,
        });
      } else if (top) {
        // Shared category words with different field names (type "router" vs product "Router") are usually coincidence.
        const coincidental = top.cardinality === "N:M" && top.nameSimilarity < 0.7;
        questions.push({
          id: qid,
          pair: [A.label, B.label],
          question: `How should "${A.label}" be linked to "${B.label}"?`,
          options: [...options, { value: "none", label: `Do not link ${A.label} and ${B.label}` }],
          blocking: !coincidental,
          why: coincidental
            ? `${top.leftField} and ${top.rightField} share ${top.overlap} value(s) but repeat on both sides and have unrelated names, which looks coincidental; not linked unless you pass it in links.`
            : top.cardinality === "N:M"
              ? `The best match (${top.leftField} ↔ ${top.rightField}) repeats on both sides, so joining would multiply rows.`
              : second && top.score - second.score < 0.12
                ? `Several fields match about equally well (${pair
                    .slice(0, 3)
                    .map((c) => `${c.leftField}↔${c.rightField}`)
                    .join(", ")}).`
                : `The best match covers only ${Math.round(Math.max(top.leftCoverage, top.rightCoverage) * 100)}% of values.`,
        });
      } else {
        questions.push({
          id: qid,
          pair: [A.label, B.label],
          question: `"${A.label}" and "${B.label}" share no values. Which fields describe the same thing?`,
          options: [{ value: "none", label: `Keep ${A.label} and ${B.label} separate` }],
          blocking: false,
          why: `No field in ${A.label} has values that also appear in ${B.label}. Provide links explicitly, e.g. {left:"${A.label}", leftField:"…", right:"${B.label}", rightField:"…"}.`,
        });
      }
    }
  }
  // A pair that is already connected through other links (A–C–B) does not need its own link.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const l of recommended) parent.set(find(l.left), find(l.right));
  const open = questions.filter((q) => find(q.pair[0]) !== find(q.pair[1]));
  return { candidates, recommended, questions: open };
}

/** Parse "left.field=right.field" (labels may contain dots; the field is the last segment). */
export function parseLinkOption(value: string): LinkSpec | null {
  const m = /^(.+)\.([^.=]+)=(.+)\.([^.=]+)$/.exec(value);
  return m ? { left: m[1]!, leftField: m[2]!, right: m[3]!, rightField: m[4]! } : null;
}

export interface JoinResult {
  dataset: Dataset;
  matched: number;
  unmatched: number;
  addedFields: string[];
}

/**
 * Join `right` onto `left` by key (trimmed, case-insensitive). Left rows are never dropped by a left join;
 * graph nodes and geo features keep their structure and gain the right side's fields.
 */
export function joinDatasets(
  left: LinkSource,
  right: LinkSource,
  link: {
    leftField: string;
    rightField: string;
    how?: "left" | "inner";
    fields?: string[];
    attributesOnly?: boolean;
  },
  maxRows: number,
): JoinResult {
  const how = link.how ?? "left";
  if (left.ds.kind === "hierarchy") {
    throw new D3McpError(
      "INCOMPATIBLE_DATA",
      `Cannot attach fields to the hierarchy ${left.label}`,
      `Join ${left.label} as the right side instead, or link it only for cross-highlighting.`,
    );
  }
  for (const [src, f] of [
    [left, link.leftField],
    [right, link.rightField],
  ] as const) {
    if (!src.ds.rows.some((r) => f in r)) {
      throw new D3McpError(
        "FIELD_NOT_FOUND",
        `Field "${f}" not found in ${src.label}`,
        `Fields: ${fieldsOf(src.ds.rows).slice(0, 30).join(", ")}`,
      );
    }
  }
  const index = new Map<string, Row[]>();
  for (const r of right.ds.rows) {
    const k = normKey(r[link.rightField]);
    if (!k) continue;
    const list = index.get(k);
    if (list) list.push(r);
    else index.set(k, [r]);
  }
  const leftFields = new Set(fieldsOf(left.ds.rows));
  const allRight = fieldsOf(right.ds.rows);
  for (const f of link.fields ?? []) {
    if (!allRight.includes(f))
      throw new D3McpError(
        "FIELD_NOT_FOUND",
        `Field "${f}" not found in ${right.label}`,
        `Fields: ${allRight.slice(0, 30).join(", ")}`,
      );
  }
  const numeric = (f: string) => {
    const vals = right.ds.rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined && v !== "");
    return vals.length > 0 && vals.every((v) => typeof v === "number");
  };
  const rightFields = allRight.filter(
    (f) =>
      f !== link.rightField &&
      !(f === "_index" && right.ds.kind === "geo") &&
      (!link.fields || link.fields.includes(f)) &&
      !(link.attributesOnly && numeric(f)),
  );
  const rename = new Map<string, string>();
  for (const f of rightFields) {
    const name = leftFields.has(f) ? `${right.label}.${f}` : f;
    if (FORBIDDEN_KEYS.has(name))
      throw new D3McpError("SECURITY_VIOLATION", `Field name "${name}" is not allowed`);
    rename.set(f, name);
  }
  const isStructural = left.ds.kind !== "table";
  const many = [...index.values()].some((l) => l.length > 1);
  if (isStructural && many) {
    throw new D3McpError(
      "INCOMPATIBLE_DATA",
      `${right.label}.${link.rightField} repeats values, so it cannot be attached to ${left.ds.kind} items one-to-one`,
      `Aggregate ${right.label} per ${link.rightField} first, or join in the other direction (${right.label} as left).`,
    );
  }
  const rows: Row[] = [];
  let matched = 0;
  let unmatched = 0;
  for (const l of left.ds.rows) {
    const hits = index.get(normKey(l[link.leftField]));
    if (!hits) {
      unmatched++;
      if (how === "left" || isStructural)
        rows.push({ ...l, ...Object.fromEntries([...rename.values()].map((n) => [n, null])) });
      continue;
    }
    matched++;
    for (const h of hits) {
      const merged: Row = { ...l };
      for (const [f, n] of rename) merged[n] = h[f] ?? null;
      rows.push(merged);
      if (rows.length > maxRows) {
        throw new D3McpError(
          "LIMIT_EXCEEDED",
          `Joining ${left.label} with ${right.label} produces more than ${maxRows} rows`,
          "The key repeats on both sides (N:M). Pick a unique key on one side or aggregate first.",
        );
      }
    }
  }
  const note = `Joined ${left.label} (${left.ds.rows.length} ${left.ds.kind === "graph" ? "nodes" : "rows"}) with ${right.label} (${right.ds.rows.length}) on ${left.label}.${link.leftField} = ${right.label}.${link.rightField} (${how} join, trimmed and case-insensitive): ${matched} matched, ${unmatched} without a match${how === "inner" && !isStructural ? " (dropped)" : " (kept with empty fields)"}; added ${rename.size} field(s).`;
  const renamed = [...rename].filter(([f, n]) => f !== n).map(([f, n]) => `${f}→${n}`);
  const fanOut = rows.length > left.ds.rows.length;
  const repeatedMeasures = [...rename.keys()].filter(numeric);
  const extraWarnings: string[] = [];
  if (unmatched) extraWarnings.push(`${unmatched} ${left.label} item(s) had no match in ${right.label}.`);
  if (repeatedMeasures.length && !fanOut && index.size < left.ds.rows.length) {
    extraWarnings.push(
      `Numeric field(s) ${repeatedMeasures.join(", ")} from ${right.label} repeat for every matching ${left.label} row; use mean/max/min (not sum) when aggregating them.`,
    );
  }
  if (fanOut)
    extraWarnings.push(
      `Some ${left.label} rows matched several ${right.label} rows and were duplicated (${left.ds.rows.length} → ${rows.length} rows).`,
    );
  const dataset: Dataset = {
    ...left.ds,
    id: `ds_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    rows,
    warnings: [...left.ds.warnings, ...extraWarnings],
    transformations: [
      ...left.ds.transformations,
      note,
      ...(renamed.length ? [`Renamed clashing ${right.label} fields: ${renamed.join(", ")}.`] : []),
      ...(link.attributesOnly && allRight.some((f) => f !== link.rightField && numeric(f))
        ? [
            `Only descriptive (non-numeric) ${right.label} fields were attached, so lookup measures are not double-counted.`,
          ]
        : []),
    ],
    origin: { format: "join", file: `${left.label} + ${right.label}` },
  };
  if (left.ds.kind === "geo" && left.ds.geojson) {
    dataset.geojson = {
      ...left.ds.geojson,
      features: left.ds.geojson.features.map((f, i) => ({
        ...f,
        properties: {
          ...(f.properties ?? {}),
          ...Object.fromEntries(
            Object.entries(rows[i] ?? {}).filter(([k]) => [...rename.values()].includes(k)),
          ),
        },
      })),
    };
  }
  return { dataset, matched, unmatched, addedFields: [...rename.values()] };
}

/** Decide which side is the detail (many rows per key) and which the lookup, so joins never multiply the lookup. */
export function orientLink(
  sources: LinkSource[],
  link: LinkSpec,
): { left: LinkSource; right: LinkSource; leftField: string; rightField: string } {
  const a = sources.find((s) => s.label === link.left);
  const b = sources.find((s) => s.label === link.right);
  if (!a || !b)
    throw new D3McpError(
      "INVALID_INPUT",
      `Unknown dataset label in link ${link.left} ↔ ${link.right}`,
      `Labels: ${sources.map((s) => s.label).join(", ")}`,
    );
  const uniqueA =
    distinct(a.ds.rows, link.leftField).size === a.ds.rows.filter((r) => r[link.leftField] != null).length;
  const uniqueB =
    distinct(b.ds.rows, link.rightField).size === b.ds.rows.filter((r) => r[link.rightField] != null).length;
  const structural = (s: LinkSource) => s.ds.kind !== "table";
  // Attach the side with unique keys (the lookup) onto the other; structural data (graph/geo) stays the base when its keys are unique.
  if (structural(a) && uniqueB)
    return { left: a, right: b, leftField: link.leftField, rightField: link.rightField };
  if (structural(b) && uniqueA)
    return { left: b, right: a, leftField: link.rightField, rightField: link.leftField };
  if (!uniqueA && uniqueB)
    return { left: a, right: b, leftField: link.leftField, rightField: link.rightField };
  if (uniqueA && !uniqueB)
    return { left: b, right: a, leftField: link.rightField, rightField: link.leftField };
  return { left: a, right: b, leftField: link.leftField, rightField: link.rightField };
}

export interface EntityKeys {
  /** Dataset label and field whose values identify the shared entity (e.g. sites.site_code). */
  home: { label: string; field: string };
  /** Per source label: the entity keys behind each row (same order as the rows). */
  tokens: Map<string, string[][]>;
  /** Sources the link graph could not reach. */
  unreachable: string[];
}

/**
 * Pick the entity that ties the sources together (the key used by the most links, preferring its unique side)
 * and propagate its keys through the link graph, so a region polygon carries all of its sites' keys and a
 * telemetry row carries its site's key.
 */
export function entityKeys(sources: LinkSource[], links: LinkSpec[]): EntityKeys | null {
  if (!links.length) return null;
  const count = new Map<string, number>();
  const bump = (label: string, field: string) =>
    count.set(`${label}\u0000${field}`, (count.get(`${label}\u0000${field}`) ?? 0) + 1);
  for (const l of links) {
    bump(l.left, l.leftField);
    bump(l.right, l.rightField);
  }
  const ranked = [...count].map(([k, n]) => {
    const [label, field] = k.split("\u0000") as [string, string];
    const src = sources.find((s) => s.label === label);
    const nonNull = src
      ? src.ds.rows.filter((r) => r[field] !== null && r[field] !== undefined && r[field] !== "").length
      : 0;
    const unique = src ? distinct(src.ds.rows, field).size === nonNull : false;
    return { label, field, n, unique, rows: src?.ds.rows.length ?? 0 };
  });
  ranked.sort((a, b) => b.n - a.n || Number(b.unique) - Number(a.unique) || b.rows - a.rows);
  const home = ranked[0]!;
  const tokens = new Map<string, string[][]>();
  const homeSrc = sources.find((s) => s.label === home.label)!;
  tokens.set(
    home.label,
    homeSrc.ds.rows.map((r) => (normKey(r[home.field]) ? [normKey(r[home.field])] : [])),
  );
  let progress = true;
  while (progress) {
    progress = false;
    for (const l of links) {
      for (const [from, ff, to, tf] of [
        [l.left, l.leftField, l.right, l.rightField],
        [l.right, l.rightField, l.left, l.leftField],
      ] as const) {
        if (!tokens.has(from) || tokens.has(to)) continue;
        const fromSrc = sources.find((s) => s.label === from)!;
        const toSrc = sources.find((s) => s.label === to);
        if (!toSrc) continue;
        const fromTokens = tokens.get(from)!;
        const index = new Map<string, Set<string>>();
        fromSrc.ds.rows.forEach((r, i) => {
          const k = normKey(r[ff]);
          if (!k) return;
          const set = index.get(k) ?? new Set<string>();
          for (const t of fromTokens[i] ?? []) set.add(t);
          index.set(k, set);
        });
        tokens.set(
          to,
          toSrc.ds.rows.map((r) => [...(index.get(normKey(r[tf]))?.values() ?? [])]),
        );
        progress = true;
      }
    }
  }
  return {
    home: { label: home.label, field: home.field },
    tokens,
    unreachable: sources.filter((s) => !tokens.has(s.label)).map((s) => s.label),
  };
}

/** Map rows of a derived dataset (e.g. a join) to entity keys through one of its fields shared with a source. */
export function tokensVia(
  rows: Row[],
  field: string,
  source: LinkSource,
  sourceField: string,
  sourceTokens: string[][],
): string[][] {
  const index = new Map<string, Set<string>>();
  source.ds.rows.forEach((r, i) => {
    const k = normKey(r[sourceField]);
    if (!k) return;
    const set = index.get(k) ?? new Set<string>();
    for (const t of sourceTokens[i] ?? []) set.add(t);
    index.set(k, set);
  });
  return rows.map((r) => [...(index.get(normKey(r[field]))?.values() ?? [])]);
}
