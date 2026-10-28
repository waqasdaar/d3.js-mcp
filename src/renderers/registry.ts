import type { VisType } from "../core/schema/spec.js";
import { sankeyPlugin } from "../plugins/sankey.js";
import { barRenderers } from "./charts/bar.js";
import { lineRenderers } from "./charts/line.js";
import { pieRenderers } from "./charts/pie.js";
import { scatterRenderers } from "./charts/scatter.js";
import { statRenderers } from "./charts/stats.js";
import { geoRenderers } from "./geography/index.js";
import { hierarchyRenderers } from "./hierarchy/index.js";
import { networkRenderers } from "./network/index.js";
import { spatialRenderers } from "./spatial/index.js";
import type { RendererPlugin } from "./types.js";

const registry = new Map<string, RendererPlugin>();

/** Register (or replace) a renderer plugin. The MCP protocol layer discovers renderers only through this registry. */
export function registerRenderer(plugin: RendererPlugin): void {
  registry.set(plugin.type, plugin);
}

export function getRenderer(type: VisType | string): RendererPlugin | undefined {
  return registry.get(type);
}

export function listRenderers(): RendererPlugin[] {
  return [...registry.values()];
}

for (const p of [
  ...barRenderers,
  ...lineRenderers,
  ...scatterRenderers,
  ...statRenderers,
  ...pieRenderers,
  ...hierarchyRenderers,
  ...networkRenderers,
  ...geoRenderers,
  ...spatialRenderers,
  sankeyPlugin,
]) {
  registerRenderer(p);
}
