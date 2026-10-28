import { z } from "zod";
import { IconMapSchema } from "../../renderers/network/icons.js";

export const SPEC_VERSION = "1.0" as const;

export const VIS_TYPES = [
  "bar",
  "grouped-bar",
  "stacked-bar",
  "line",
  "area",
  "stacked-area",
  "scatter",
  "bubble",
  "connected-scatter",
  "histogram",
  "boxplot",
  "density",
  "heatmap",
  "pie",
  "donut",
  "waterfall",
  "cumulative",
  "treemap",
  "sunburst",
  "pack",
  "tree",
  "cluster",
  "partition",
  "force",
  "radial-network",
  "chord",
  "sankey",
  "geo",
  "voronoi",
  "delaunay",
  "contour",
  "custom",
] as const;
export type VisType = (typeof VIS_TYPES)[number];

const FieldName = z.string().min(1).max(200);

export const FieldEncodingSchema = z.object({
  field: FieldName,
  type: z.enum(["quantitative", "temporal", "nominal", "ordinal"]).optional(),
  aggregate: z.enum(["sum", "mean", "median", "min", "max", "count"]).optional(),
  title: z.string().max(200).optional(),
  format: z.string().max(40).optional().describe("d3-format or d3-time-format specifier"),
});
export type FieldEncoding = z.infer<typeof FieldEncodingSchema>;

export const EncodingSchema = z
  .object({
    x: FieldEncodingSchema.optional(),
    y: FieldEncodingSchema.optional(),
    y2: FieldEncodingSchema.optional(),
    color: FieldEncodingSchema.optional(),
    size: FieldEncodingSchema.optional(),
    shape: FieldEncodingSchema.optional(),
    opacity: FieldEncodingSchema.optional(),
    label: FieldEncodingSchema.optional(),
    series: FieldEncodingSchema.optional(),
    group: FieldEncodingSchema.optional(),
    value: FieldEncodingSchema.optional(),
    source: FieldEncodingSchema.optional(),
    target: FieldEncodingSchema.optional(),
    id: FieldEncodingSchema.optional(),
    parent: FieldEncodingSchema.optional(),
    latitude: FieldEncodingSchema.optional(),
    longitude: FieldEncodingSchema.optional(),
    order: FieldEncodingSchema.optional(),
    tooltip: z.array(FieldName).max(20).optional(),
  })
  .strict();
export type Encoding = z.infer<typeof EncodingSchema>;
export type Channel = Exclude<keyof Encoding, "tooltip">;

const ScaleSchema = z
  .object({
    type: z.enum(["linear", "log", "pow", "sqrt", "symlog", "time", "utc", "band", "point"]).optional(),
    domain: z
      .array(z.union([z.number(), z.string()]))
      .max(1000)
      .optional(),
    nice: z.boolean().optional(),
    zero: z.boolean().optional(),
    exponent: z.number().optional(),
    reverse: z.boolean().optional(),
  })
  .strict();

const ColorScaleSchema = z
  .object({
    type: z.enum(["ordinal", "sequential", "diverging", "quantize", "quantile", "threshold"]).optional(),
    scheme: z
      .string()
      .max(40)
      .optional()
      .describe("d3-scale-chromatic scheme name, e.g. Tableau10, Viridis, RdBu"),
    domain: z
      .array(z.union([z.number(), z.string()]))
      .max(1000)
      .optional(),
    range: z.array(z.string().max(40)).max(256).optional().describe("Explicit CSS colors"),
    thresholds: z.array(z.number()).max(50).optional(),
  })
  .strict();

const AxisSchema = z
  .object({
    show: z.boolean().default(true),
    title: z.string().max(200).optional(),
    format: z.string().max(40).optional(),
    ticks: z.number().int().min(0).max(50).optional(),
    grid: z.boolean().optional(),
  })
  .strict();

export const AnnotationSchema = z
  .object({
    type: z.enum(["rule", "band", "text"]),
    axis: z.enum(["x", "y"]).default("y"),
    value: z.union([z.number(), z.string()]).optional(),
    from: z.union([z.number(), z.string()]).optional(),
    to: z.union([z.number(), z.string()]).optional(),
    label: z.string().max(200).optional(),
    color: z.string().max(40).optional(),
  })
  .strict();
export type Annotation = z.infer<typeof AnnotationSchema>;

export const LayoutSchema = z
  .object({
    width: z.number().int().min(100).max(8000).default(800),
    height: z.number().int().min(100).max(8000).default(500),
    margin: z
      .object({
        top: z.number().min(0).max(500).default(56),
        right: z.number().min(0).max(500).default(24),
        bottom: z.number().min(0).max(500).default(56),
        left: z.number().min(0).max(500).default(64),
      })
      .strict()
      .default({ top: 56, right: 24, bottom: 56, left: 64 }),
    responsive: z.boolean().default(true),
    pixelRatio: z.number().min(1).max(4).default(2),
  })
  .strict();

export const InteractionSchema = z
  .object({
    tooltip: z.boolean().default(true),
    zoom: z.boolean().default(false),
    brush: z.boolean().default(false),
    drag: z.boolean().default(false),
    search: z.boolean().default(false),
    highlight: z
      .array(z.union([z.string(), z.number()]))
      .max(100)
      .optional(),
    /** Field holding the entity key shared with other charts (cross-chart linked selection). */
    link: z.string().max(200).optional(),
  })
  .strict();

export const AccessibilitySchema = z
  .object({
    ariaLabel: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    keyboard: z.boolean().default(true),
    reducedMotion: z.boolean().default(true),
  })
  .strict();

export const TransformSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("filter"),
      field: FieldName,
      op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in", "notNull"]),
      value: z
        .union([z.number(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()]))])
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("aggregate"),
      groupBy: z.array(FieldName).min(1).max(5),
      field: FieldName.optional(),
      op: z.enum(["sum", "mean", "median", "min", "max", "count"]),
      as: FieldName,
    })
    .strict(),
  z
    .object({ type: z.literal("sort"), field: FieldName, order: z.enum(["ascending", "descending"]) })
    .strict(),
  z.object({ type: z.literal("limit"), count: z.number().int().min(1).max(100000) }).strict(),
]);
export type Transform = z.infer<typeof TransformSchema>;

export const OptionsSchema = z
  .object({
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    curve: z.enum(["linear", "monotoneX", "step", "basis", "cardinal", "catmullRom", "natural"]).optional(),
    innerRadius: z.number().min(0).max(0.95).optional().describe("Fraction of outer radius (donut/sunburst)"),
    bins: z.number().int().min(1).max(500).optional(),
    bandwidth: z.number().min(0.1).max(200).optional(),
    tile: z.enum(["squarify", "binary", "slice", "dice", "sliceDice", "resquarify"]).optional(),
    stackOffset: z.enum(["none", "expand", "diverging", "silhouette", "wiggle"]).optional(),
    stackOrder: z.enum(["none", "ascending", "descending", "insideOut", "reverse", "appearance"]).optional(),
    projection: z
      .enum([
        "mercator",
        "equirectangular",
        "naturalEarth1",
        "albers",
        "albersUsa",
        "orthographic",
        "equalEarth",
        "conicEqualArea",
        "transverseMercator",
        "azimuthalEqualArea",
        "stereographic",
        "gnomonic",
      ])
      .optional(),
    graticule: z.boolean().optional(),
    iterations: z.number().int().min(1).max(1000).optional().describe("Force simulation ticks"),
    linkDistance: z.number().min(1).max(1000).optional(),
    chargeStrength: z.number().min(-5000).max(0).optional(),
    nodeSizeBy: z.enum(["degree", "value", "constant"]).optional(),
    iconField: FieldName.optional().describe(
      "Node field whose value names the icon (auto: 'icon' if present)",
    ),
    iconMap: z
      .record(z.string().max(200), z.string().max(40))
      .refine((r) => Object.keys(r).length <= 500, "At most 500 icon mappings")
      .optional()
      .describe(
        "Map field values to icon names, e.g. {hub:'router', branch:'switch'}; applied to iconField or the color/group field",
      ),
    icons: IconMapSchema.optional().describe(
      "Custom icons by name: {paths:[{d,fill?,stroke?}], viewBox?} or {svg:'<svg>…</svg>'}",
    ),
    iconStyle: z
      .enum(["badge", "plain"])
      .optional()
      .describe("badge: white icon on a colored disc (default); plain: colored icon, no disc"),
    tierField: FieldName.optional().describe(
      "Arrange nodes in horizontal layers by this field (e.g. core/distribution/access)",
    ),
    tierOrder: z.array(z.string().max(200)).max(20).optional().describe("Top-to-bottom order of tier values"),
    showLabels: z.boolean().optional(),
    labelLimit: z.number().int().min(0).max(1000).optional(),
    showPoints: z.boolean().optional(),
    thresholds: z.number().int().min(2).max(100).optional(),
    radial: z.boolean().optional(),
    seed: z.number().int().optional(),
    shapes: z
      .array(
        z
          .object({
            kind: z.enum(["rect", "circle", "line", "text", "symbol"]),
            x: z.number(),
            y: z.number(),
            width: z.number().min(0).max(8000).optional(),
            height: z.number().min(0).max(8000).optional(),
            r: z.number().min(0).max(4000).optional(),
            x2: z.number().optional(),
            y2: z.number().optional(),
            text: z.string().max(500).optional(),
            symbol: z.enum(["circle", "cross", "diamond", "square", "star", "triangle", "wye"]).optional(),
            size: z.number().min(0).max(100000).optional(),
            fill: z.string().max(40).optional(),
            stroke: z.string().max(40).optional(),
            tooltip: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(5000)
      .optional()
      .describe("Declarative primitives for the 'custom' visualization type"),
  })
  .strict();
export type Options = z.infer<typeof OptionsSchema>;

export const VisualizationSpecSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SPEC_VERSION).default(SPEC_VERSION),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    type: z.enum(VIS_TYPES),
    renderer: z.enum(["svg", "canvas"]).default("svg"),
    title: z.string().max(300).optional(),
    subtitle: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    question: z.string().max(2000).optional(),
    data: z.object({ datasetId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
    encoding: EncodingSchema.default({}),
    transforms: z.array(TransformSchema).max(20).default([]),
    layout: LayoutSchema.default(LayoutSchema.parse({})),
    axes: z.object({ x: AxisSchema.optional(), y: AxisSchema.optional() }).strict().default({}),
    scales: z
      .object({
        x: ScaleSchema.optional(),
        y: ScaleSchema.optional(),
        size: ScaleSchema.optional(),
        color: ColorScaleSchema.optional(),
      })
      .strict()
      .default({}),
    legend: z
      .object({
        show: z.boolean().default(true),
        position: z.enum(["right", "top", "bottom"]).default("right"),
      })
      .strict()
      .default({ show: true, position: "right" }),
    annotations: z.array(AnnotationSchema).max(50).default([]),
    interaction: InteractionSchema.default(InteractionSchema.parse({})),
    accessibility: AccessibilitySchema.default(AccessibilitySchema.parse({})),
    theme: z.enum(["light", "dark"]).default("light"),
    options: OptionsSchema.default({}),
  })
  .strict();

export type VisualizationSpec = z.infer<typeof VisualizationSpecSchema>;
export type VisualizationSpecInput = z.input<typeof VisualizationSpecSchema>;

export function parseSpec(input: unknown): VisualizationSpec {
  return VisualizationSpecSchema.parse(input);
}
