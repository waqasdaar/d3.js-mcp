import type { DataProfile, FieldProfile } from "../data/profile.js";
import type { Dataset } from "../data/types.js";
import type { Encoding, VisType } from "../schema/spec.js";

export interface Recommendation {
  type: VisType;
  score: number;
  encoding: Encoding;
  question: string;
  rationale: string;
  tradeoffs: string;
  options?: Record<string, unknown>;
}

/** Field names that denote quantities which can be meaningfully summed (as opposed to rates, latencies, percentages). */
export const ADDITIVE =
  /(revenue|sales|amount|total|count|qty|quantity|units|volume|bytes|packets|cost|spend|profit|orders|tickets|visits|users|incidents|calls|value|q[1-4])$/i;

/** Prompt cues: explicit chart names win outright (+100); analytical intent words nudge the ranking (+30). */
const EXPLICIT = 100;
const INTENT = 30;
export const KEYWORDS: Array<[VisType, RegExp, number]> = [
  ["stacked-area", /stacked[- ]area/i, EXPLICIT],
  ["stacked-bar", /stacked(?![- ]area)( bar)?/i, EXPLICIT],
  ["stacked-bar", /composition/i, INTENT],
  ["grouped-bar", /grouped bar|side[- ]by[- ]side|clustered bar/i, EXPLICIT],
  ["cumulative", /cumulative|running total/i, EXPLICIT],
  ["waterfall", /waterfall|bridge chart/i, EXPLICIT],
  ["line", /line chart/i, EXPLICIT],
  ["line", /trend|over time|time[- ]series|timeline|evolution|per (day|hour|minute|month)/i, INTENT],
  ["area", /area chart|(?<!stacked[- ])\barea\b/i, EXPLICIT],
  ["connected-scatter", /connected scatter|trajectory/i, EXPLICIT],
  ["bubble", /bubble/i, EXPLICIT],
  ["scatter", /scatter/i, EXPLICIT],
  ["scatter", /correlat|relat(ed|ion|ionship)|associat|\bvs\.?\b|versus/i, INTENT],
  ["histogram", /histogram/i, EXPLICIT],
  ["histogram", /distribution|frequenc|spread/i, INTENT],
  ["boxplot", /box ?plot/i, EXPLICIT],
  ["boxplot", /quartile|outlier|variabilit/i, INTENT],
  ["density", /(?<!contour |2d )\bdensity\b(?! map)|\bkde\b/i, EXPLICIT],
  ["heatmap", /heat ?map/i, EXPLICIT],
  ["heatmap", /matrix of/i, INTENT],
  ["donut", /donut|doughnut/i, EXPLICIT],
  ["pie", /\bpie\b/i, EXPLICIT],
  ["pie", /share of|proportion|percentage|part[- ]to[- ]whole/i, INTENT],
  ["bar", /bar chart/i, EXPLICIT],
  ["bar", /compar|rank|\btop \d+|highest|lowest|by category/i, INTENT],
  ["treemap", /treemap/i, EXPLICIT],
  ["sunburst", /sunburst/i, EXPLICIT],
  ["pack", /circle pack|packing/i, EXPLICIT],
  ["cluster", /dendrogram|cluster layout/i, EXPLICIT],
  ["partition", /icicle|partition/i, EXPLICIT],
  ["tree", /\btree\b|org chart/i, EXPLICIT],
  ["tree", /hierarch/i, INTENT],
  ["radial-network", /radial network/i, EXPLICIT],
  ["chord", /\bchord/i, EXPLICIT],
  ["sankey", /sankey/i, EXPLICIT],
  ["sankey", /\bflows?\b/i, INTENT],
  ["force", /force[- ]directed/i, EXPLICIT],
  ["force", /network|graph|topology|nodes? and links/i, INTENT],
  ["geo", /choropleth/i, EXPLICIT],
  ["geo", /\bmap\b|geograph|projection|geojson/i, INTENT],
  ["voronoi", /voronoi/i, EXPLICIT],
  ["delaunay", /delaunay|triangulat/i, EXPLICIT],
  ["contour", /contour|density map|2d density/i, EXPLICIT],
];

/** Name variants users type: the field itself, with spaces, and without a short unit suffix (latency_ms → latency). */
function fieldVariants(f: string): string[] {
  const lower = f.toLowerCase();
  const out = new Set([lower, lower.replace(/[_-]+/g, " ")]);
  const unitless = /^(.{4,}?)[_-]([a-z%]{1,4})$/.exec(lower)?.[1];
  if (unitless) {
    out.add(unitless);
    out.add(unitless.replace(/[_-]+/g, " "));
  }
  return [...out];
}

/** Fields mentioned in the prompt, in order of first appearance. */
export function mentionedFields(prompt: string, fields: string[]): string[] {
  const p = prompt.toLowerCase();
  const hits: Array<[string, number]> = [];
  for (const f of fields) {
    let best = -1;
    for (const v of fieldVariants(f)) {
      const re = new RegExp(`(^|[^a-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
      const m = re.exec(p);
      if (m && (best === -1 || m.index < best)) best = m.index;
    }
    if (best >= 0) hits.push([f, best]);
  }
  return hits.sort((a, b) => a[1] - b[1]).map((h) => h[0]);
}

function pick(fields: FieldProfile[], mentioned: string[]): FieldProfile | undefined {
  return fields.find((f) => mentioned.includes(f.name)) ?? fields[0];
}

function keywordBoost(prompt: string): Map<VisType, number> {
  const boosts = new Map<VisType, number>();
  for (const [type, re, weight] of KEYWORDS) {
    if (re.test(prompt)) boosts.set(type, Math.max(boosts.get(type) ?? 0, weight));
  }
  return boosts;
}

export function recommend(ds: Dataset, profile: DataProfile, prompt = ""): Recommendation[] {
  const fieldNames = profile.fields.map((f) => f.name);
  const mentioned = mentionedFields(prompt, fieldNames);
  const byMention = (fs: FieldProfile[]) =>
    [...fs].sort((a, b) => {
      const ia = mentioned.indexOf(a.name);
      const ib = mentioned.indexOf(b.name);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  const Q = byMention(
    profile.fields.filter(
      (f) =>
        f.type === "quantitative" &&
        !f.semantic.includes("identifier") &&
        !f.semantic.includes("latitude") &&
        !f.semantic.includes("longitude") &&
        f.name !== "_index" &&
        f.name !== "depth",
    ),
  );
  const T = byMention(profile.fields.filter((f) => f.type === "temporal"));
  const N = byMention(
    profile.fields.filter(
      (f) => (f.type === "nominal" || f.type === "boolean") && f.unique >= 1 && f.unique <= 60,
    ),
  );
  const out: Recommendation[] = [];
  const add = (r: Omit<Recommendation, "score"> & { score: number }) => out.push(r);
  const n0 = pick(N, mentioned);
  const q0 = Q[0];
  const q1 = Q[1];
  const t0 = T[0];

  if (ds.kind === "graph") {
    const nominal = profile.fields.filter((f) => f.type === "nominal" && f.unique > 1 && f.unique <= 60);
    const group =
      nominal.find((f) => mentioned.includes(f.name)) ??
      nominal.find((f) => /group|type|category|role|cluster|site|region|tier/i.test(f.name));
    const enc: Encoding = group ? { color: { field: group.name } } : {};
    add({
      type: "force",
      score: 70,
      encoding: enc,
      question: "How are entities connected and which are central?",
      rationale: `Graph with ${profile.rowCount} nodes and ${profile.linkCount ?? 0} links; force layout reveals clusters and hubs.`,
      tradeoffs: "Layout is approximate; node positions carry no quantitative meaning.",
    });
    add({
      type: "radial-network",
      score: 45,
      encoding: enc,
      question: "How do groups relate to each other?",
      rationale: "Rings per group make group membership explicit.",
      tradeoffs: "Less faithful to link structure than a free force layout.",
    });
    add({
      type: "chord",
      score: 40,
      encoding: {},
      question: "What is the magnitude of flows between entities?",
      rationale: "Chord diagrams show weighted, bidirectional flows.",
      tradeoffs: "Hard to read beyond ~30 entities.",
    });
    add({
      type: "sankey",
      score: 35,
      encoding: {},
      question: "How does volume flow through stages?",
      rationale: "Sankey diagrams show directed flow magnitudes.",
      tradeoffs: "Requires an acyclic graph (optional d3-sankey plugin).",
    });
  } else if (ds.kind === "hierarchy") {
    add({
      type: "treemap",
      score: 70,
      encoding: {},
      question: "Which branches contribute most to the total?",
      rationale: "Treemaps compare sizes of nested parts efficiently.",
      tradeoffs: "Deep structure is harder to perceive than in node-link trees.",
    });
    add({
      type: "sunburst",
      score: 55,
      encoding: {},
      question: "How is the total divided across levels?",
      rationale: "Radial partition shows all levels at once.",
      tradeoffs: "Angles/areas are less precise than lengths.",
    });
    add({
      type: "tree",
      score: 50,
      encoding: {},
      question: "What is the structure of the hierarchy?",
      rationale: "Node-link trees show parent/child structure clearly.",
      tradeoffs: "Does not encode size well.",
    });
    add({
      type: "pack",
      score: 40,
      encoding: {},
      question: "How do nested groups compare?",
      rationale: "Circle packing shows containment.",
      tradeoffs: "Wastes space; areas are hard to compare.",
    });
    add({
      type: "cluster",
      score: 30,
      encoding: {},
      question: "How are leaves grouped?",
      rationale: "Dendrogram aligns leaves at the same depth.",
      tradeoffs: "Ignores node values.",
    });
    add({
      type: "partition",
      score: 30,
      encoding: {},
      question: "How is the total divided by level?",
      rationale: "Icicle chart: rectangular partition by depth.",
      tradeoffs: "Small nodes become unreadable.",
    });
  } else if (ds.kind === "geo") {
    const c = Q[0];
    add({
      type: "geo",
      score: 75,
      encoding: c ? { color: { field: c.name } } : {},
      question: c ? `How does ${c.name} vary geographically?` : "Where are the features located?",
      rationale: c
        ? `Choropleth of ${c.name} over ${profile.rowCount} features.`
        : "Projected map of the features.",
      tradeoffs:
        "Large areas dominate visually; consider normalizing by area or population (not done automatically).",
    });
    if (c)
      add({
        type: "bar",
        score: 35,
        encoding: { x: { field: (N[0] ?? profile.fields[0]!).name }, y: { field: c.name } },
        question: `Which features have the highest ${c.name}?`,
        rationale: "Bars allow precise comparison without area bias.",
        tradeoffs: "Loses spatial context.",
      });
  } else {
    const lat = profile.fields.find((f) => f.semantic.includes("latitude"));
    const lon = profile.fields.find((f) => f.semantic.includes("longitude"));
    const src = profile.fields.find((f) => f.semantic.includes("link-source"));
    const tgt = profile.fields.find((f) => f.semantic.includes("link-target"));
    const parent = profile.fields.find((f) => f.semantic.includes("hierarchy-parent"));
    const idf = profile.fields.find((f) => f.name === "id" || f.semantic.includes("identifier"));
    if (lat && lon) {
      add({
        type: "geo",
        score: 60,
        encoding: {
          latitude: { field: lat.name },
          longitude: { field: lon.name },
          ...(q0 ? { size: { field: q0.name } } : {}),
          ...(n0 ? { color: { field: n0.name } } : {}),
        },
        question: "Where are the observations located?",
        rationale: `Latitude/longitude fields detected (${lat.name}, ${lon.name}).`,
        tradeoffs: "No basemap is included (offline-safe); only sphere and graticule.",
      });
    }
    if (src && tgt) {
      const val = Q[0];
      const enc: Encoding = {
        source: { field: src.name },
        target: { field: tgt.name },
        ...(val ? { value: { field: val.name } } : {}),
      };
      add({
        type: "force",
        score: 55,
        encoding: enc,
        question: "How are the entities connected?",
        rationale: `Source/target fields detected (${src.name} → ${tgt.name}).`,
        tradeoffs: "Node positions are not quantitative.",
      });
      add({
        type: "sankey",
        score: 45,
        encoding: enc,
        question: "How does flow move between entities?",
        rationale: "Directed weighted edges suit a Sankey diagram.",
        tradeoffs: "Requires an acyclic graph.",
      });
      add({
        type: "chord",
        score: 35,
        encoding: enc,
        question: "How large are the flows between pairs?",
        rationale: "Chord diagrams show pairwise flow magnitudes.",
        tradeoffs: "Cluttered with many entities.",
      });
    }
    if (parent && idf) {
      add({
        type: "treemap",
        score: 55,
        encoding: {
          id: { field: idf.name },
          parent: { field: parent.name },
          ...(q0 ? { value: { field: q0.name } } : {}),
        },
        question: "Which branches are largest?",
        rationale: "id/parent fields form a hierarchy (d3.stratify).",
        tradeoffs: "Requires exactly one root.",
      });
      add({
        type: "tree",
        score: 45,
        encoding: { id: { field: idf.name }, parent: { field: parent.name } },
        question: "What is the structure?",
        rationale: "Node-link tree of the stratified hierarchy.",
        tradeoffs: "Values not encoded.",
      });
    }
    if (t0 && q0) {
      const series = N.find((f) => f.unique <= 12 && f.unique > 1);
      // Fewer than 4 points per line cannot show a trend; demote rather than hide (an explicit request still works).
      const sparse = profile.rowCount / (series?.unique ?? 1) < 4;
      add({
        type: "line",
        score: sparse ? 10 : 65,
        encoding: {
          x: { field: t0.name },
          y: { field: q0.name },
          ...(series ? { series: { field: series.name } } : {}),
        },
        question: `How does ${q0.name} change over time${series ? ` for each ${series.name}` : ""}?`,
        rationale: `Temporal field ${t0.name} with quantitative ${q0.name}.${sparse ? " Very few points per series, so the trend is unreliable." : ""}`,
        tradeoffs: "Lines imply continuity between samples.",
      });
      add({
        type: "area",
        score: sparse ? 8 : 35,
        encoding: { x: { field: t0.name }, y: { field: q0.name } },
        question: `How large is ${q0.name} over time?`,
        rationale: "Area emphasises volume.",
        tradeoffs: "Overlapping areas obscure each other.",
      });
      add({
        type: "cumulative",
        score: sparse || !ADDITIVE.test(q0.name) ? 6 : 25,
        encoding: {
          x: { field: t0.name },
          y: { field: q0.name },
          ...(series ? { series: { field: series.name } } : {}),
        },
        question: `What is the running total of ${q0.name}?`,
        rationale: "Cumulative sums reveal growth.",
        tradeoffs: "Only meaningful for additive measures.",
      });
      if (series)
        add({
          type: "stacked-area",
          score: sparse || !ADDITIVE.test(q0.name) ? 6 : 35,
          encoding: { x: { field: t0.name }, y: { field: q0.name }, series: { field: series.name } },
          question: `How does the composition of ${q0.name} by ${series.name} change?`,
          rationale: "Stacked areas show composition over time.",
          tradeoffs: "Only the bottom layer has a common baseline.",
        });
    }
    if (n0 && /\b(number of|how many|count(s|ing)?( of)?|frequency of)\b/i.test(prompt)) {
      add({
        type: "bar",
        score: 90,
        encoding: { x: { field: n0.name }, y: { field: n0.name, aggregate: "count" } },
        question: `How many records are there per ${n0.name}?`,
        rationale: `The request asks for a count; one bar per ${n0.name} (${n0.unique} values) with the number of records.`,
        tradeoffs: "Counts records, not a measure; each record weighs the same.",
        ...(n0.unique > 12 ? { options: { orientation: "horizontal" } } : {}),
      });
    }
    if (n0 && q0) {
      const dup = n0.unique < profile.rowCount;
      const yEnc = {
        field: q0.name,
        ...(dup
          ? {
              aggregate:
                /average|mean/i.test(prompt) || !ADDITIVE.test(q0.name)
                  ? ("mean" as const)
                  : ("sum" as const),
            }
          : {}),
      };
      add({
        type: "bar",
        score: 60,
        encoding: { x: { field: n0.name }, y: yEnc },
        question: `How does ${q0.name} compare across ${n0.name}?`,
        rationale: `Categorical ${n0.name} (${n0.unique} values) with quantitative ${q0.name}${dup ? `; ${yEnc.aggregate} per category` : ""}.`,
        tradeoffs: "Bars need a zero baseline.",
        ...(n0.unique > 12 ? { options: { orientation: "horizontal" } } : {}),
      });
      // Shares of a mean are meaningless; only offer part-to-whole charts for sums or one value per category.
      if (n0.unique <= 6 && yEnc.aggregate !== "mean") {
        add({
          type: "donut",
          score: 30,
          encoding: { color: { field: n0.name }, value: yEnc },
          question: `What share of total ${q0.name} does each ${n0.name} have?`,
          rationale: "Few categories; part-to-whole.",
          tradeoffs: "Angles are less precise than bar lengths.",
        });
        add({
          type: "pie",
          score: 25,
          encoding: { color: { field: n0.name }, value: yEnc },
          question: `What share of total ${q0.name} does each ${n0.name} have?`,
          rationale: "Few categories; part-to-whole.",
          tradeoffs: "Prefer bars for precise comparison.",
        });
      }
      if (dup)
        add({
          type: "boxplot",
          score: 35,
          encoding: { x: { field: n0.name }, y: { field: q0.name } },
          question: `How is ${q0.name} distributed within each ${n0.name}?`,
          rationale: "Multiple observations per category.",
          tradeoffs: "Hides multimodality.",
        });
      const n1 = N.find((f) => f.name !== n0.name && f.unique <= 20);
      if (n1) {
        const agg2 = yEnc.aggregate ?? (ADDITIVE.test(q0.name) ? ("sum" as const) : ("mean" as const));
        add({
          type: "grouped-bar",
          score: 40,
          encoding: {
            x: { field: n0.name },
            y: { ...yEnc, aggregate: agg2 },
            series: { field: n1.name },
          },
          question: `How does ${q0.name} compare across ${n0.name} and ${n1.name}?`,
          rationale: "Two categorical dimensions.",
          tradeoffs: "Gets crowded with many sub-groups.",
        });
        if (agg2 === "sum")
          add({
            type: "stacked-bar",
            score: 38,
            encoding: {
              x: { field: n0.name },
              y: { ...yEnc, aggregate: agg2 },
              series: { field: n1.name },
            },
            question: `What is the composition of ${q0.name} by ${n1.name}?`,
            rationale: "Part-to-whole per category.",
            tradeoffs: "Only the bottom segment has a common baseline.",
          });
        add({
          type: "heatmap",
          score: 33,
          encoding: {
            x: { field: n0.name },
            y: { field: n1.name },
            color: { field: q0.name, aggregate: agg2 },
          },
          question: `Where are ${q0.name} values concentrated across ${n0.name} × ${n1.name}?`,
          rationale: "Matrix of two categorical fields.",
          tradeoffs: "Color is less precise than position.",
        });
      }
      if (/waterfall|bridge/i.test(prompt))
        add({
          type: "waterfall",
          score: 30,
          encoding: { x: { field: n0.name }, y: { field: q0.name } },
          question: `How do changes in ${q0.name} accumulate?`,
          rationale: "Sequential contributions.",
          tradeoffs: "Only meaningful for additive deltas.",
        });
    }
    if (t0 && n0 && q0 && !Q[1]) {
      add({
        type: "heatmap",
        score: 20,
        encoding: {
          x: { field: t0.name },
          y: { field: n0.name },
          color: { field: q0.name, aggregate: "mean" },
        },
        question: `How does ${q0.name} vary by ${n0.name} over time?`,
        rationale: "Time × category matrix.",
        tradeoffs: "Time treated as discrete.",
      });
    }
    if (q0 && q1) {
      const color = N.find((f) => f.unique <= 12);
      const label = profile.fields.find(
        (f) => (f.type === "nominal" || f.type === "identifier") && f.unique === profile.rowCount,
      );
      const big = profile.rowCount > 5000;
      const tiny = profile.rowCount < 5;
      add({
        type: "scatter",
        score: tiny ? 12 : 55,
        encoding: {
          x: { field: q0.name },
          y: { field: q1.name },
          ...(color ? { color: { field: color.name } } : {}),
          ...(label ? { label: { field: label.name } } : {}),
        },
        question: `Is ${q1.name} related to ${q0.name}?`,
        rationale: "Two quantitative fields." + (big ? " Large point count: canvas renderer." : ""),
        tradeoffs: "Correlation does not imply causation; overplotting with many points.",
        ...(big ? { options: { renderer: "canvas" } } : {}),
      });
      // Size field: "sized by <field>" in the prompt, else a third measure.
      const sizedBy = /\bsized?\s+(?:by|on)\s+([\w -]+)/i.exec(prompt)?.[1];
      const sizeField =
        (sizedBy ? Q.find((f) => mentionedFields(sizedBy, [f.name]).length) : undefined) ?? Q[2];
      if (sizeField)
        add({
          type: "bubble",
          score: 35,
          encoding: {
            x: { field: q0.name },
            y: { field: q1.name },
            size: { field: sizeField.name },
            ...(color ? { color: { field: color.name } } : {}),
            ...(label ? { label: { field: label.name } } : {}),
          },
          question: `How do ${q0.name}, ${q1.name} and ${sizeField.name} relate?`,
          rationale: "Third measure as bubble area.",
          tradeoffs: "Area is hard to compare precisely.",
        });
      add({
        type: "contour",
        score: profile.rowCount > 300 ? 35 : 5,
        encoding: { x: { field: q0.name }, y: { field: q1.name } },
        question: "Where are observations concentrated?",
        rationale: "Density contours reduce overplotting.",
        tradeoffs: "Smoothing bandwidth affects shape.",
      });
      add({
        type: "voronoi",
        score: 12,
        encoding: { x: { field: q0.name }, y: { field: q1.name } },
        question: "Which regions are nearest to each point?",
        rationale: "Voronoi tessellation.",
        tradeoffs: "Rarely the primary analytical view.",
      });
      add({
        type: "delaunay",
        score: 10,
        encoding: { x: { field: q0.name }, y: { field: q1.name } },
        question: "What is the triangulated neighbourhood structure?",
        rationale: "Delaunay triangulation.",
        tradeoffs: "Geometric, not statistical.",
      });
      if (t0)
        add({
          type: "connected-scatter",
          score: 20,
          encoding: { x: { field: q0.name }, y: { field: q1.name } },
          question: `How do ${q0.name} and ${q1.name} co-evolve?`,
          rationale: "Ordered pairs over time.",
          tradeoffs: "Hard to read with many points.",
        });
    }
    if (q0) {
      add({
        type: "histogram",
        score: 40,
        encoding: { x: { field: q0.name } },
        question: `How is ${q0.name} distributed?`,
        rationale: `Quantitative ${q0.name} (${profile.rowCount} values).`,
        tradeoffs: "Bin choice changes the shape.",
      });
      add({
        type: "density",
        score: 25,
        encoding: { x: { field: q0.name }, ...(n0 && n0.unique <= 6 ? { series: { field: n0.name } } : {}) },
        question: `What is the smoothed distribution of ${q0.name}?`,
        rationale: "Kernel density estimate.",
        tradeoffs: "Bandwidth choice affects shape.",
      });
    }
  }
  const boosts = keywordBoost(prompt);
  for (const r of out) r.score += boosts.get(r.type) ?? 0;
  out.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.type) ? false : (seen.add(r.type), true)));
}
