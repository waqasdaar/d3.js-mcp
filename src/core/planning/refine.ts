import { descending, rollup } from "d3";
import type { Dataset } from "../data/types.js";
import { toLabel, toNumber } from "../data/values.js";
import { parseSpec, VIS_TYPES, type VisType, type VisualizationSpec } from "../schema/spec.js";
import { D3McpError } from "../../shared/errors.js";

export interface RefineResult {
  spec: VisualizationSpec;
  changes: string[];
  unrecognized: string[];
}

const TYPE_ALIASES: Record<string, VisType> = {
  bar: "bar",
  column: "bar",
  line: "line",
  "multi-line": "line",
  area: "area",
  "stacked area": "stacked-area",
  "stacked bar": "stacked-bar",
  "grouped bar": "grouped-bar",
  scatter: "scatter",
  scatterplot: "scatter",
  bubble: "bubble",
  histogram: "histogram",
  "box plot": "boxplot",
  boxplot: "boxplot",
  density: "density",
  heatmap: "heatmap",
  pie: "pie",
  donut: "donut",
  waterfall: "waterfall",
  cumulative: "cumulative",
  treemap: "treemap",
  sunburst: "sunburst",
  pack: "pack",
  "circle packing": "pack",
  tree: "tree",
  dendrogram: "cluster",
  icicle: "partition",
  network: "force",
  "force-directed": "force",
  "radial network": "radial-network",
  chord: "chord",
  sankey: "sankey",
  map: "geo",
  choropleth: "geo",
  voronoi: "voronoi",
  delaunay: "delaunay",
  contour: "contour",
};

function fieldsOf(ds: Dataset | undefined): string[] {
  if (!ds) return [];
  const s = new Set<string>();
  for (const r of ds.rows.slice(0, 500)) Object.keys(r).forEach((k) => s.add(k));
  return [...s];
}

function findField(name: string, ds: Dataset | undefined): string | undefined {
  const fields = fieldsOf(ds);
  const n = name.toLowerCase().replace(/[\s-]+/g, "_");
  return (
    fields.find((f) => f.toLowerCase() === n) ??
    fields.find((f) => f.toLowerCase().replace(/[\s-]+/g, "_") === n)
  );
}

function topKeys(spec: VisualizationSpec, ds: Dataset, n: number): string[] {
  if (ds.kind === "graph" && ds.links) {
    const deg = new Map<string, number>();
    for (const l of ds.links) {
      for (const end of [l.source, l.target]) deg.set(String(end), (deg.get(String(end)) ?? 0) + 1);
    }
    return [...deg]
      .sort((a, b) => descending(a[1], b[1]))
      .slice(0, n)
      .map((d) => d[0]);
  }
  const key = spec.encoding.x?.field ?? spec.encoding.color?.field ?? spec.encoding.label?.field;
  const val = spec.encoding.y?.field ?? spec.encoding.value?.field ?? spec.encoding.size?.field;
  if (!key || !val) return [];
  const sums = rollup(
    ds.rows,
    (g) => g.reduce((s, r) => s + (toNumber(r[val] ?? null) ?? 0), 0),
    (r) => toLabel(r[key] ?? null),
  );
  return [...sums]
    .sort((a, b) => descending(a[1], b[1]))
    .slice(0, n)
    .map((d) => d[0]);
}

/** Apply natural-language refinement instructions deterministically, preserving unrelated configuration. */
export function applyInstructions(
  input: VisualizationSpec,
  instructions: string,
  ds?: Dataset,
): RefineResult {
  const spec = structuredClone(input) as VisualizationSpec;
  const changes: string[] = [];
  const unrecognized: string[] = [];
  const clauses = instructions
    .split(
      /;|\.\s|\n|,\s*(?:and\s+)?|\band\b(?=\s+(?:add|use|make|change|switch|set|highlight|show|hide|enable|disable|remove|sort|color|title))/i,
    )
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of clauses) {
    let hit = false;
    const m = (re: RegExp) => re.exec(c);
    let r: RegExpExecArray | null;
    const axis: "x" | "y" = /\bx[- ]?axis\b|\bx scale\b|horizontal axis/i.test(c) ? "x" : "y";

    if (
      (r = m(
        /\b(log(?:arithmic)?|symlog|sqrt|square root|linear)\b.*\bscale\b|\bscale\b.*\b(log(?:arithmic)?|symlog|sqrt|linear)\b/i,
      ))
    ) {
      const word = (r[1] ?? r[2] ?? "").toLowerCase();
      const type = word.startsWith("log")
        ? "log"
        : word === "symlog"
          ? "symlog"
          : word.startsWith("sq")
            ? "sqrt"
            : "linear";
      const f = axis === "x" ? spec.encoding.x?.field : spec.encoding.y?.field;
      let chosen = type;
      if (type === "log" && f && ds && ds.rows.some((row) => (toNumber(row[f] ?? null) ?? 1) <= 0)) {
        chosen = "symlog";
        changes.push(`${f} contains zero/negative values: used symlog instead of log on ${axis}.`);
      }
      spec.scales[axis] = { ...(spec.scales[axis] ?? {}), type: chosen as "log" };
      changes.push(`Set ${axis} scale to ${chosen}.`);
      hit = true;
    }
    if (
      (r = m(/\b(dark|light)\b\s*(theme|mode)?/i)) &&
      /theme|mode|dark|light/i.test(c) &&
      !/color|colour/i.test(c.replace(/dark|light/gi, ""))
    ) {
      spec.theme = r[1]!.toLowerCase() as "dark" | "light";
      changes.push(`Theme set to ${spec.theme}.`);
      hit = true;
    }
    if ((r = m(/(threshold|reference|target|goal|limit|sla)\s*(line)?\s*(at|of|=)?\s*(-?\d+(?:\.\d+)?)/i))) {
      const value = Number(r[4]);
      const label =
        /label(?:ed)?\s+["“']?([^"”']+)["”']?/i.exec(c)?.[1] ??
        `${r[1]![0]!.toUpperCase()}${r[1]!.slice(1).toLowerCase()} ${value}`;
      if (!spec.annotations.some((a) => a.type === "rule" && a.axis === axis && Number(a.value) === value)) {
        spec.annotations.push({ type: "rule", axis, value, label });
      }
      changes.push(`Added ${axis}-axis reference line at ${value}.`);
      hit = true;
    }
    if ((r = m(/highlight\s+(?:the\s+)?top\s+(\d+)/i))) {
      if (!ds) throw new D3McpError("INVALID_INPUT", "Highlighting top N requires the dataset");
      const keys = topKeys(spec, ds, Number(r[1]));
      if (keys.length) {
        spec.interaction.highlight = keys;
        changes.push(`Highlighted top ${r[1]}: ${keys.join(", ")}.`);
        hit = true;
      }
    } else if ((r = m(/highlight\s+["“']?([^"”']+?)["”']?$/i))) {
      const vals = r[1]!.split(/\s*(?:,|\bor\b)\s*/).filter(Boolean);
      spec.interaction.highlight = vals;
      changes.push(`Highlighted ${vals.join(", ")}.`);
      hit = true;
    }
    if (/\bhorizontal(ly)?\b/i.test(c) && !/axis/i.test(c)) {
      spec.options.orientation = "horizontal";
      changes.push("Bars oriented horizontally.");
      hit = true;
    } else if (/\bvertical(ly)?\b/i.test(c) && !/axis/i.test(c)) {
      spec.options.orientation = "vertical";
      changes.push("Bars oriented vertically.");
      hit = true;
    }
    if ((r = m(/\bsort(?:ed)?\b.*\b(desc|descending|asc|ascending)/i))) {
      const f = spec.encoding.y?.aggregate
        ? undefined
        : (spec.encoding.y?.field ?? spec.encoding.value?.field);
      if (f) {
        spec.transforms = spec.transforms.filter((t) => t.type !== "sort");
        spec.transforms.push({
          type: "sort",
          field: f,
          order: r[1]!.toLowerCase().startsWith("desc") ? "descending" : "ascending",
        });
        changes.push(`Sorted by ${f} ${r[1]}.`);
        hit = true;
      }
    }
    if ((r = m(/\b(?:sub)?title\s*(?:to|=|:)?\s*["“']([^"”']+)["”']/i))) {
      if (/subtitle/i.test(c)) spec.subtitle = r[1]!;
      else spec.title = r[1]!;
      changes.push(`${/subtitle/i.test(c) ? "Subtitle" : "Title"} set.`);
      hit = true;
    }
    for (const feature of ["zoom", "brush", "drag", "search", "tooltip"] as const) {
      const re = new RegExp(
        `\\b(enable|add|turn on|allow|with|support|disable|remove|turn off|no|without)\\b[^.]*\\b${feature === "zoom" ? "(zoom|pan)" : feature}`,
        "i",
      );
      const fm = re.exec(c);
      if (fm) {
        const on = !/disable|remove|turn off|\bno\b|without/i.test(fm[1]!);
        (spec.interaction as Record<string, unknown>)[feature] = on;
        changes.push(`${on ? "Enabled" : "Disabled"} ${feature}.`);
        hit = true;
      }
    }
    if ((r = m(/\bcolou?r(?:ed)?\b(?:\s+\w+)?\s+(?:by|on)\s+([\w-]+)/i))) {
      const f = findField(r[1]!, ds);
      if (f) {
        spec.encoding.color = { field: f };
        changes.push(`Color encodes ${f}.`);
        hit = true;
      }
    }
    if ((r = m(/\b(?:size|sized)\b(?:\s+\w+)?\s+(?:by|on)\s+([\w-]+)/i))) {
      const word = r[1]!.toLowerCase();
      if (word === "degree") {
        spec.options.nodeSizeBy = "degree";
        changes.push("Node size encodes degree.");
        hit = true;
      } else {
        const f = findField(word, ds);
        if (f) {
          spec.encoding.size = { field: f };
          changes.push(`Size encodes ${f}.`);
          hit = true;
        }
      }
    }
    if (
      (r = m(
        /\b(?:scheme|palette)\s+([A-Za-z0-9]+)|\b(viridis|magma|inferno|plasma|turbo|cividis|tableau10|category10|blues|reds|greens|rdbu|spectral)\b/i,
      ))
    ) {
      const name = (r[1] ?? r[2]!).replace(/^./, (ch) => ch.toUpperCase());
      const canonical =
        name.toLowerCase() === "tableau10"
          ? "Tableau10"
          : name.toLowerCase() === "category10"
            ? "Category10"
            : name.toLowerCase() === "rdbu"
              ? "RdBu"
              : name;
      spec.scales.color = { ...(spec.scales.color ?? {}), scheme: canonical };
      changes.push(`Color scheme ${canonical}.`);
      hit = true;
    }
    if ((r = m(/(\d+)\s*bins?/i))) {
      spec.options.bins = Number(r[1]);
      changes.push(`Histogram bins: ${r[1]}.`);
      hit = true;
    }
    if ((r = m(/\bwidth\s*(?:to|=|of)?\s*(\d{3,4})/i))) {
      spec.layout.width = Number(r[1]);
      changes.push(`Width ${r[1]}px.`);
      hit = true;
    }
    if ((r = m(/\bheight\s*(?:to|=|of)?\s*(\d{3,4})/i))) {
      spec.layout.height = Number(r[1]);
      changes.push(`Height ${r[1]}px.`);
      hit = true;
    }
    if (/\bsmooth/i.test(c)) {
      spec.options.curve = "monotoneX";
      changes.push("Smoothed lines (curveMonotoneX).");
      hit = true;
    }
    if ((r = m(/\b(show|hide|remove)\s+(?:the\s+)?(labels|legend|grid(?:lines)?|points)/i))) {
      const on = r[1]!.toLowerCase() === "show";
      const what = r[2]!.toLowerCase();
      if (what === "labels") spec.options.showLabels = on;
      else if (what === "legend") spec.legend.show = on;
      else if (what === "points") spec.options.showPoints = on;
      else spec.axes.y = { ...(spec.axes.y ?? { show: true }), grid: on };
      changes.push(`${on ? "Show" : "Hide"} ${what}.`);
      hit = true;
    }
    if (
      (r = m(
        /\b(?:change|switch|convert|turn|make)\b.*?\b(?:to|into|as)\s+(?:an?\s+)?([a-z -]+?)(?:\s+(?:chart|plot|diagram|graph|map))?$/i,
      ))
    ) {
      const word = r[1]!.trim().toLowerCase();
      const t = TYPE_ALIASES[word] ?? (VIS_TYPES as readonly string[]).find((v) => v === word);
      if (t) {
        spec.type = t as VisType;
        changes.push(`Visualization type changed to ${t}.`);
        hit = true;
      }
    }
    if (/\bradial\b/i.test(c) && (spec.type === "tree" || spec.type === "cluster")) {
      spec.options.radial = true;
      changes.push("Radial tree layout.");
      hit = true;
    }
    if (!hit) unrecognized.push(c);
  }
  if (changes.length === 0) {
    throw new D3McpError(
      "INVALID_INPUT",
      `No refinement could be applied from: "${instructions}"`,
      "Supported instructions include: 'use a logarithmic y scale', 'add a threshold line at 50', 'highlight the top 5', 'use a dark theme', 'sort descending', 'color by <field>', 'change to a line chart', 'enable zoom', 'show labels', 'title \"...\"', '20 bins'.",
    );
  }
  return { spec: parseSpec(spec), changes, unrecognized };
}
