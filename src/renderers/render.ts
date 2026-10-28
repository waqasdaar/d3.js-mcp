import * as d3 from "d3";
import type { Dataset } from "../core/data/types.js";
import type { Channel, VisualizationSpec } from "../core/schema/spec.js";
import { D3McpError } from "../shared/errors.js";
import { getRenderer, listRenderers } from "./registry.js";
import { applyHighlight } from "./svg/helpers.js";
import { applyTransforms } from "./transforms.js";
import {
  DEFAULT_RENDER_LIMITS,
  THEMES,
  type RenderContext,
  type RenderLimits,
  type SvgSel,
} from "./types.js";

export interface RenderOutput {
  svg: SVGSVGElement;
  markCount: number;
  markSelector: string;
  warnings: string[];
  transformsApplied: string[];
  meta: Record<string, unknown>;
  width: number;
  height: number;
}

function fieldsOf(rows: Dataset["rows"]): Set<string> {
  const s = new Set<string>();
  for (const r of rows.slice(0, 1000)) for (const k of Object.keys(r)) s.add(k);
  return s;
}

const MAX_LINK_VALUES = 200;

/** Normalized key token: trimmed, lower-case, "|" reserved as the list separator (mirrored by the HTML runtime). */
export function linkToken(v: unknown): string {
  return String(v).trim().toLowerCase().replace(/\|/g, "¦");
}

/**
 * Collect the entity keys behind a mark from its bound datum, whatever shape the renderer used:
 * a row, an aggregated group ({rows}), a series (array of rows), a hierarchy/pie/stack node ({data}),
 * a GeoJSON feature ({properties}) or a graph node.
 */
export function linkValuesOf(datum: unknown, field: string, out = new Set<string>(), depth = 0): Set<string> {
  if (datum === null || datum === undefined || depth > 4 || out.size >= MAX_LINK_VALUES) return out;
  if (Array.isArray(datum)) {
    for (const d of datum) {
      linkValuesOf(d, field, out, depth + 1);
      if (out.size >= MAX_LINK_VALUES) break;
    }
    return out;
  }
  if (typeof datum !== "object") return out;
  const o = datum as Record<string, unknown>;
  const v = o[field];
  if (v !== undefined && v !== null && v !== "" && typeof v !== "object") {
    // Pre-linked fields may carry several keys separated by U+001F.
    for (const part of String(v).split("\u001f")) if (part) out.add(linkToken(part));
    return out;
  }
  for (const k of ["row", "rows", "data", "properties", "values", "points", "children", "datum"]) {
    if (k in o && o[k] && typeof o[k] === "object") linkValuesOf(o[k], field, out, depth + 1);
  }
  if (typeof o.leaves === "function" && depth === 0) {
    try {
      linkValuesOf(
        (o.leaves as () => unknown[])().map((n) => (n as { data?: unknown }).data),
        field,
        out,
        depth + 1,
      );
    } catch {
      /* not a hierarchy node */
    }
  }
  return out;
}

/** Tag marks with the normalized entity keys they represent so the runtime can link selections across charts. */
function tagLinkKeys(ctx: RenderContext, field: string): void {
  let tagged = 0;
  ctx.svg.attr("data-link-field", field);
  ctx.svg.selectAll<SVGElement, unknown>(".mark").each(function (d) {
    const values = linkValuesOf((this as SVGElement & { __linkRows?: unknown }).__linkRows ?? d, field);
    if (!values.size) return;
    this.setAttribute("data-link", [...values].join("|"));
    tagged++;
  });
  if (!tagged)
    ctx.warnings.push(
      `No mark carries the link field "${field}", so this chart does not take part in linked selection.`,
    );
}

/** Ensure every encoded field exists in the dataset; return actionable errors otherwise. */
export function validateEncodingFields(spec: VisualizationSpec, ds: Dataset): void {
  const nodeFields = fieldsOf(ds.rows);
  const linkFields = ds.links ? fieldsOf(ds.links) : new Set<string>();
  const derived = new Set(spec.transforms.flatMap((t) => (t.type === "aggregate" ? [t.as] : [])));
  const check = (f: string, where: string) => {
    if (nodeFields.has(f) || linkFields.has(f) || derived.has(f)) return;
    if (ds.rows.length === 0) return;
    throw new D3McpError(
      "FIELD_NOT_FOUND",
      `Field "${f}" referenced by ${where} does not exist in the dataset`,
      `Available fields: ${[...nodeFields, ...linkFields].slice(0, 40).join(", ")}`,
    );
  };
  for (const [ch, e] of Object.entries(spec.encoding)) {
    if (ch === "tooltip") for (const f of e as string[]) check(f, "encoding.tooltip");
    else if (e && typeof e === "object" && "field" in e)
      check((e as { field: string }).field, `encoding.${ch}`);
  }
  for (const t of spec.transforms) {
    if (t.type === "filter" || t.type === "sort") check(t.field, `transform ${t.type}`);
    if (t.type === "aggregate") {
      t.groupBy.forEach((g) => check(g, "transform aggregate.groupBy"));
      if (t.field) check(t.field, "transform aggregate.field");
    }
  }
}

export function renderVisualization(
  doc: Document,
  spec: VisualizationSpec,
  dataset: Dataset,
  limits: RenderLimits = DEFAULT_RENDER_LIMITS,
): RenderOutput {
  const plugin = getRenderer(spec.type);
  if (!plugin) {
    throw new D3McpError(
      "UNSUPPORTED_VISUALIZATION",
      `No renderer registered for "${spec.type}"`,
      `Supported: ${listRenderers()
        .map((r) => r.type)
        .join(", ")}`,
    );
  }
  if (!plugin.dataKinds.includes(dataset.kind)) {
    const suitable = listRenderers()
      .filter((r) => r.dataKinds.includes(dataset.kind))
      .map((r) => r.type);
    throw new D3McpError(
      "INCOMPATIBLE_DATA",
      `"${spec.type}" cannot render ${dataset.kind} data`,
      `Types that accept ${dataset.kind} data: ${suitable.join(", ")}`,
    );
  }
  if (plugin.requiredChannels.length) {
    const ok = plugin.requiredChannels.some((set) => set.every((ch) => spec.encoding[ch as Channel]));
    if (!ok) {
      throw new D3McpError(
        "INVALID_INPUT",
        `"${spec.type}" requires encodings: ${plugin.requiredChannels.map((s) => s.join("+")).join(" or ")}`,
        "Add the missing encoding channels or let d3_create_spec choose them.",
      );
    }
  }
  if (spec.renderer === "canvas" && !plugin.supportsCanvas) {
    throw new D3McpError(
      "INVALID_INPUT",
      `renderer "canvas" is not supported for "${spec.type}"`,
      "Use renderer:'svg'.",
    );
  }
  validateEncodingFields(spec, dataset);
  const { rows, applied } = applyTransforms(dataset.rows, spec.transforms);
  const theme = THEMES[spec.theme];
  const { width, height } = spec.layout;
  const margin = { ...spec.layout.margin };
  const hasColor = !!(spec.encoding.color || spec.encoding.series || spec.encoding.group);
  const legendRight = plugin.usesLegend && spec.legend.show && (hasColor || plugin.family === "network");
  if (legendRight) margin.right = Math.max(margin.right, 150);
  if (!spec.title) margin.top = Math.min(margin.top, 32);
  if (
    plugin.family === "hierarchy" ||
    plugin.type === "pie" ||
    plugin.type === "donut" ||
    plugin.type === "chord" ||
    plugin.family === "network" ||
    plugin.family === "geo" ||
    plugin.type === "custom"
  ) {
    margin.left = Math.min(margin.left, 24);
    margin.bottom = Math.min(margin.bottom, 24);
  }
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (innerWidth < 40 || innerHeight < 40) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Plot area ${innerWidth}×${innerHeight}px is too small`,
      "Increase layout.width/height or reduce margins.",
    );
  }
  const svgEl = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  const svg = d3.select(svgEl) as unknown as SvgSel;
  const titleId = `${spec.id}-title`;
  const descId = `${spec.id}-desc`;
  svg
    .attr("class", "d3mcp-root")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-labelledby", `${titleId} ${descId}`)
    .attr("data-vis-type", spec.type)
    .attr("data-spec-id", spec.id)
    .attr("font-family", theme.font)
    .attr("data-zoom", spec.interaction.zoom ? "true" : null)
    .attr("data-brush", spec.interaction.brush ? "true" : null)
    .attr("data-drag", spec.interaction.drag ? "true" : null)
    .attr("data-search", spec.interaction.search ? "true" : null)
    .attr("data-tooltip-enabled", spec.interaction.tooltip ? "true" : "false");
  if (spec.layout.responsive) svg.attr("style", "max-width:100%;height:auto");
  svg
    .append("title")
    .attr("id", titleId)
    .text(spec.accessibility.ariaLabel ?? spec.title ?? `${plugin.label}`);
  svg
    .append("desc")
    .attr("id", descId)
    .text(spec.accessibility.description ?? spec.description ?? `${plugin.label} of ${rows.length} records.`);
  svg.append("defs");
  svg
    .append("rect")
    .attr("class", "background")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", theme.background);
  if (spec.title) {
    svg
      .append("text")
      .attr("class", "chart-title")
      .attr("x", 16)
      .attr("y", 24)
      .attr("fill", theme.foreground)
      .attr("font-size", 16)
      .attr("font-weight", 600)
      .text(spec.title);
  }
  if (spec.subtitle) {
    svg
      .append("text")
      .attr("class", "chart-subtitle")
      .attr("x", 16)
      .attr("y", 42)
      .attr("fill", theme.muted)
      .attr("font-size", 12)
      .text(spec.subtitle);
  }
  const clipTop = spec.title ? (spec.subtitle ? 48 : 32) : 0;
  const clipWrap = svg.append("g").attr("class", "d3mcp-clip");
  if (spec.interaction.zoom) {
    svg
      .select("defs")
      .append("clipPath")
      .attr("id", `${spec.id}-clip`)
      .append("rect")
      .attr("x", 0)
      .attr("y", clipTop)
      .attr("width", width)
      .attr("height", height - clipTop);
    clipWrap.attr("clip-path", `url(#${spec.id}-clip)`);
  }
  const viewport = clipWrap.append("g").attr("class", "d3mcp-viewport");
  const plot = viewport
    .append("g")
    .attr("class", "plot")
    .attr("transform", `translate(${margin.left},${margin.top})`)
    .attr("data-inner-width", innerWidth)
    .attr("data-inner-height", innerHeight);
  const ctx: RenderContext = {
    doc,
    spec,
    dataset,
    rows,
    svg,
    plot,
    width,
    height,
    innerWidth,
    innerHeight,
    margin,
    theme,
    warnings: [...dataset.warnings],
    limits,
  };
  let result;
  try {
    result = plugin.render(ctx);
  } catch (e) {
    if (e instanceof D3McpError) throw e;
    throw new D3McpError("RENDER_FAILED", `Renderer "${spec.type}" failed: ${(e as Error).message}`);
  }
  applyHighlight(ctx);
  if (spec.interaction.link) tagLinkKeys(ctx, spec.interaction.link);
  if (spec.accessibility.keyboard === false) svg.selectAll(".mark").attr("tabindex", null);
  return {
    svg: svgEl,
    markCount: result.markCount,
    markSelector: result.markSelector,
    warnings: ctx.warnings,
    transformsApplied: applied,
    meta: result.meta ?? {},
    width,
    height,
  };
}
