import { z } from "zod";
import type { DataProfile } from "../data/profile.js";
import type { Dataset } from "../data/types.js";
import {
  AccessibilitySchema,
  AnnotationSchema,
  EncodingSchema,
  InteractionSchema,
  OptionsSchema,
  parseSpec,
  SPEC_VERSION,
  TransformSchema,
  VIS_TYPES,
  type VisType,
  type VisualizationSpec,
} from "../schema/spec.js";
import { D3McpError } from "../../shared/errors.js";
import { recommend, type Recommendation } from "./recommend.js";
import { applyInstructions } from "./refine.js";

export const PlanOptionsSchema = z
  .object({
    width: z.number().int().min(100).max(8000).optional(),
    height: z.number().int().min(100).max(8000).optional(),
    margin: z
      .object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() })
      .partial()
      .optional(),
    theme: z.enum(["light", "dark"]).optional(),
    renderer: z.enum(["svg", "canvas"]).optional(),
    subtitle: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    encoding: EncodingSchema.optional().describe("Explicit encodings override automatic choices"),
    transforms: z.array(TransformSchema).max(20).optional(),
    scales: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Scale overrides, see visualization spec schema"),
    axes: z.record(z.string(), z.unknown()).optional(),
    legend: z
      .object({ show: z.boolean().optional(), position: z.enum(["right", "top", "bottom"]).optional() })
      .optional(),
    annotations: z.array(AnnotationSchema).max(50).optional(),
    interaction: InteractionSchema.partial().optional(),
    accessibility: AccessibilitySchema.partial().optional(),
    options: OptionsSchema.optional().describe(
      "Type-specific options (orientation, curve, bins, projection, ...)",
    ),
  })
  .strict();
export type PlanOptions = z.infer<typeof PlanOptionsSchema>;

export interface Plan {
  spec: VisualizationSpec;
  chosenType: VisType;
  explanation: string;
  mappings: Record<string, string>;
  transformations: string[];
  assumptions: string[];
  alternatives: Array<Pick<Recommendation, "type" | "question" | "rationale" | "tradeoffs">>;
  suggestedFormats: string[];
}

export function newVizId(): string {
  return `viz_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function planVisualization(input: {
  dataset: Dataset;
  profile: DataProfile;
  prompt: string;
  type?: VisType | "auto";
  title?: string;
  options?: PlanOptions;
}): Plan {
  const { dataset, profile, prompt } = input;
  const opts = input.options ?? {};
  const recs = recommend(dataset, profile, prompt);
  const assumptions: string[] = [];
  let rec: Recommendation | undefined;
  if (input.type && input.type !== "auto") {
    if (!(VIS_TYPES as readonly string[]).includes(input.type)) {
      throw new D3McpError(
        "UNSUPPORTED_VISUALIZATION",
        `Unknown visualization type "${input.type}"`,
        `Supported: ${VIS_TYPES.join(", ")}`,
      );
    }
    rec = recs.find((r) => r.type === input.type);
    if (!rec) {
      const base = recs[0];
      rec = {
        type: input.type,
        score: 0,
        encoding: base?.encoding ?? {},
        question: base?.question ?? prompt,
        rationale: `Requested explicitly.`,
        tradeoffs: "",
      };
      if (!opts.encoding)
        assumptions.push(
          `"${input.type}" was requested but the data profile did not suggest it; encodings were reused from "${base?.type ?? "none"}". Provide options.encoding to control the mapping.`,
        );
    }
  } else {
    rec = recs[0];
  }
  if (!rec) {
    throw new D3McpError(
      "INCOMPATIBLE_DATA",
      "Could not find a suitable visualization for this dataset",
      "Ensure the data has at least one quantitative, temporal, categorical, hierarchical, graph or geographic field, or pass visualization_type and options.encoding.",
    );
  }
  const encoding = { ...rec.encoding, ...(opts.encoding ?? {}) };
  const recOptions = { ...(rec.options ?? {}) } as Record<string, unknown>;
  const renderer = (opts.renderer ?? (recOptions.renderer as "svg" | "canvas" | undefined) ?? "svg") as
    "svg" | "canvas";
  delete recOptions.renderer;
  const raw = {
    schemaVersion: SPEC_VERSION,
    id: newVizId(),
    type: rec.type,
    renderer,
    title: input.title ?? capitalize(rec.question),
    ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    question: prompt.slice(0, 2000) || rec.question,
    data: { datasetId: dataset.id },
    encoding,
    transforms: opts.transforms ?? [],
    layout: {
      width: opts.width ?? 800,
      height:
        opts.height ??
        (["pie", "donut", "sunburst", "chord", "pack", "force", "radial-network"].includes(rec.type)
          ? 600
          : 500),
      margin: { top: 56, right: 24, bottom: 56, left: 64, ...(opts.margin ?? {}) },
    },
    axes: opts.axes ?? {},
    scales: opts.scales ?? {},
    legend: { show: opts.legend?.show ?? true, position: opts.legend?.position ?? "right" },
    annotations: opts.annotations ?? [],
    interaction: { tooltip: true, ...(opts.interaction ?? {}) },
    accessibility: { ...(opts.accessibility ?? {}) },
    theme: opts.theme ?? "light",
    options: { ...recOptions, ...(opts.options ?? {}) },
  };
  let spec = parseSpec(raw);
  const transformations = [...dataset.transformations];
  // Apply refinements expressed in the prompt (log scale, thresholds, highlight, interactions...) without changing the chosen type.
  if (prompt.trim()) {
    try {
      const refined = applyInstructions(spec, prompt, dataset);
      const kept = { ...refined.spec, type: spec.type };
      const applied = refined.changes.filter((ch) => !ch.startsWith("Visualization type changed"));
      if (applied.length) {
        spec = parseSpec(kept);
        assumptions.push(...applied.map((ch) => `From prompt: ${ch}`));
      }
    } catch (e) {
      if (!(e instanceof D3McpError) || e.code !== "INVALID_INPUT") throw e;
    }
  }
  for (const [ch, e] of Object.entries(spec.encoding)) {
    if (ch !== "tooltip" && e && typeof e === "object" && "aggregate" in e && e.aggregate) {
      transformations.push(
        `Aggregated ${e.field} with ${e.aggregate} per ${spec.encoding.x?.field ?? spec.encoding.color?.field ?? "group"}.`,
      );
    }
  }
  if (spec.type === "pie" || spec.type === "donut")
    assumptions.push("Pie/donut charts are less precise than bars; a bar chart is listed as an alternative.");
  const mappings: Record<string, string> = {};
  for (const [ch, e] of Object.entries(spec.encoding)) {
    if (ch === "tooltip") mappings[ch] = (e as string[]).join(", ");
    else if (e && typeof e === "object") {
      const fe = e as { field: string; aggregate?: string };
      mappings[ch] = fe.aggregate ? `${fe.aggregate}(${fe.field})` : fe.field;
    }
  }
  const suggestedFormats = ["html", "svg"];
  if (/\bpng\b|image|screenshot/i.test(prompt)) suggestedFormats.push("png");
  if (/\bpdf\b/i.test(prompt)) suggestedFormats.push("pdf");
  const explanation = `Chose ${spec.type} because ${rec.rationale.charAt(0).toLowerCase()}${rec.rationale.slice(1)}${rec.tradeoffs ? ` Trade-off: ${rec.tradeoffs}` : ""}`;
  return {
    spec,
    chosenType: spec.type,
    explanation,
    mappings,
    transformations,
    assumptions,
    alternatives: recs
      .filter((r) => r.type !== spec.type)
      .slice(0, 4)
      .map(({ type, question, rationale, tradeoffs }) => ({ type, question, rationale, tradeoffs })),
    suggestedFormats,
  };
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
