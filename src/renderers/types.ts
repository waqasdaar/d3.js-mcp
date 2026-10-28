import type { Selection } from "d3";
import type { Dataset, DatasetKind, Row } from "../core/data/types.js";
import type { Channel, VisType, VisualizationSpec } from "../core/schema/spec.js";

export interface Theme {
  name: "light" | "dark";
  background: string;
  foreground: string;
  muted: string;
  grid: string;
  stroke: string;
  accent: string;
  font: string;
}

export const THEMES: Record<"light" | "dark", Theme> = {
  light: {
    name: "light",
    background: "#ffffff",
    foreground: "#1f2328",
    muted: "#59636e",
    grid: "#e6e8eb",
    stroke: "#ffffff",
    accent: "#4269d0",
    font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  dark: {
    name: "dark",
    background: "#0d1117",
    foreground: "#e6edf3",
    muted: "#9198a1",
    grid: "#30363d",
    stroke: "#0d1117",
    accent: "#6cb6ff",
    font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
};

export interface RenderLimits {
  maxSvgMarks: number;
  maxForceNodes: number;
  maxForceLinks: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  maxSvgMarks: 20_000,
  maxForceNodes: 3_000,
  maxForceLinks: 10_000,
};

export type SvgSel = Selection<SVGSVGElement, unknown, null, undefined>;
export type GSel = Selection<SVGGElement, unknown, null, undefined>;

export interface RenderContext {
  doc: Document;
  spec: VisualizationSpec;
  dataset: Dataset;
  /** Rows after spec transforms. */
  rows: Row[];
  svg: SvgSel;
  /** Plot group translated by the margins; renderers draw here. */
  plot: GSel;
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  margin: { top: number; right: number; bottom: number; left: number };
  theme: Theme;
  warnings: string[];
  limits: RenderLimits;
}

export interface RenderResult {
  markCount: number;
  /** CSS selector matching the primary data marks (used by validators and browser tests). */
  markSelector: string;
  meta?: Record<string, unknown>;
}

export type RendererFamily = "chart" | "statistical" | "hierarchy" | "network" | "geo" | "spatial" | "custom";

export interface RendererPlugin {
  type: VisType;
  family: RendererFamily;
  label: string;
  description: string;
  /** true when the renderer only uses modules of the core d3 bundle. */
  core: boolean;
  dataKinds: DatasetKind[];
  /** Each inner array is a set of channels; at least one set must be fully provided. Empty = no requirement. */
  requiredChannels: Channel[][];
  /** Normalized D3 API symbols this renderer actually calls (audited by tests against the source). */
  d3Apis: string[];
  /** Whether the renderer can draw into a <canvas> in the HTML artifact. */
  supportsCanvas?: boolean;
  /** Draws a legend; the frame reserves right margin when true and a color channel exists. */
  usesLegend?: boolean;
  render(ctx: RenderContext): RenderResult;
}
