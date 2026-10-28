import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataInputSchema } from "../../core/data/ingest.js";
import {
  analyzeLinks,
  entityKeys,
  joinDatasets,
  parseLinkOption,
  type LinkAnalysis,
  type LinkQuestion,
  type LinkSource,
  type LinkSpec,
} from "../../core/data/link.js";
import type { Dataset } from "../../core/data/types.js";
import type { VisualizationService } from "../../core/service.js";
import { D3McpError } from "../../shared/errors.js";
import { log } from "../../shared/logger.js";
import { handler, ok, ResultSchema, SessionId } from "../util.js";

export const LinkInput = z
  .object({
    left: z.string().max(80).describe("Label of the first dataset"),
    left_field: z.string().max(200),
    right: z.string().max(80).describe("Label of the second dataset"),
    right_field: z.string().max(200),
  })
  .strict();

export const LinkMode = z
  .enum(["auto", "best", "none"])
  .optional()
  .describe(
    "How to link several datasets. auto (default): infer shared keys; if a link is ambiguous, ask the user (MCP elicitation) or return the questions. best: take the highest-scoring candidate without asking. none: keep datasets independent.",
  );

export const LabeledData = z
  .object({
    data: DataInputSchema,
    label: z.string().max(80).optional().describe("Short name (defaults to the file name)"),
    prompt: z.string().max(2000).optional().describe("Extra focus for this dataset"),
  })
  .strict();

/** Unique, readable labels: the given label, else the file name without extension, else "Dataset N". */
export function labelSources(items: Array<{ ds: Dataset; label?: string | undefined }>): string[] {
  const used = new Set<string>();
  return items.map((it, i) => {
    const file = it.ds.origin?.file;
    let base = it.label ?? (file ? path.basename(file).replace(/\.[^.]+$/, "") : `Dataset ${i + 1}`);
    if (it.ds.origin?.sheet && !it.label) base = `${base} ${it.ds.origin.sheet}`;
    let label = base;
    for (let n = 2; used.has(label); n++) label = `${base} (${n})`;
    used.add(label);
    return label;
  });
}

export const toSpec = (l: z.infer<typeof LinkInput>): LinkSpec => ({
  left: l.left,
  leftField: l.left_field,
  right: l.right,
  rightField: l.right_field,
});

export interface ResolvedLinks {
  links: LinkSpec[];
  analysis: LinkAnalysis;
  /** Questions still open (only when the user must decide and could not be asked). */
  pending: LinkQuestion[];
  asked: "elicitation" | "none" | "declined";
  notes: string[];
}

/** Only plausible ambiguities hold up a dashboard; unrelated or coincidental pairs are reported as notes. */
const blocking = (q: LinkQuestion) => q.blocking;

/**
 * Settle the links between sources: explicit links win; clear inferences are used; ambiguous pairs are put to the
 * user through MCP elicitation when the client supports it, otherwise returned as questions for the agent to ask.
 */
export async function resolveLinks(
  server: McpServer,
  sources: LinkSource[],
  explicit: LinkSpec[],
  mode: "auto" | "best" | "none",
  elicit = true,
): Promise<ResolvedLinks> {
  const labels = new Set(sources.map((s) => s.label));
  for (const l of explicit) {
    for (const [lab, f] of [
      [l.left, l.leftField],
      [l.right, l.rightField],
    ] as const) {
      if (!labels.has(lab))
        throw new D3McpError(
          "INVALID_INPUT",
          `Link refers to unknown dataset "${lab}"`,
          `Labels: ${[...labels].join(", ")}`,
        );
      const src = sources.find((s) => s.label === lab)!;
      if (!src.ds.rows.some((r) => f in r)) {
        throw new D3McpError(
          "FIELD_NOT_FOUND",
          `Field "${f}" not found in ${lab}`,
          `Fields: ${Object.keys(src.ds.rows[0] ?? {})
            .slice(0, 30)
            .join(", ")}`,
        );
      }
    }
  }
  const analysis = analyzeLinks(sources, explicit);
  const notes: string[] = [];
  if (mode === "none") return { links: explicit, analysis, pending: [], asked: "none", notes };
  const links = [...analysis.recommended];
  const open = analysis.questions.filter(blocking);
  for (const q of analysis.questions.filter((x) => !blocking(x)))
    notes.push(`${q.pair[0]} and ${q.pair[1]}: ${q.why}`);
  if (!open.length) return { links, analysis, pending: [], asked: "none", notes };
  if (mode === "best") {
    for (const q of open) {
      const l = parseLinkOption(q.options[0]!.value);
      if (l) {
        links.push(l);
        notes.push(`Picked ${q.options[0]!.label} without asking (link_mode "best"). ${q.why}`);
      }
    }
    return { links, analysis, pending: [], asked: "none", notes };
  }
  const caps = server.server.getClientCapabilities();
  if (!elicit || !caps?.elicitation) return { links, analysis, pending: open, asked: "none", notes };
  try {
    const properties: Record<string, unknown> = {};
    for (const q of open) {
      properties[q.id] = {
        type: "string",
        title: q.question,
        description: q.why,
        enum: q.options.map((o) => o.value),
        enumNames: q.options.map((o) => o.label),
        default: q.options[0]!.value,
      };
    }
    const res = await server.server.elicitInput({
      mode: "form",
      message: `I found ${open.length} dataset pair(s) that could be linked in more than one way. Which fields refer to the same thing?`,
      requestedSchema: { type: "object", properties, required: open.map((q) => q.id) } as never,
    });
    if (res.action !== "accept" || !res.content) {
      return { links, analysis, pending: open, asked: "declined", notes };
    }
    for (const q of open) {
      const v = res.content[q.id];
      if (typeof v !== "string" || v === "none") {
        notes.push(`Kept ${q.pair[0]} and ${q.pair[1]} separate (user choice).`);
        continue;
      }
      const l = parseLinkOption(v);
      if (l && q.options.some((o) => o.value === v)) {
        links.push(l);
        notes.push(`User linked ${l.left}.${l.leftField} = ${l.right}.${l.rightField}.`);
      }
    }
    return { links, analysis, pending: [], asked: "elicitation", notes };
  } catch (e) {
    log.warn("elicitation failed; returning questions", { error: (e as Error).message });
    return { links, analysis, pending: open, asked: "none", notes };
  }
}

/** Response telling the agent which questions to put to the user before calling again with explicit links. */
export function needsInput(r: ResolvedLinks, sources: LinkSource[], tool: string) {
  return ok(
    `Need input: ${r.pending.length} dataset pair(s) can be linked in more than one way. Ask the user the question(s) below, then call ${tool} again with "links" (or link_mode "best" to accept the top suggestion).\n` +
      r.pending
        .map((q) => `- ${q.question} ${q.why}\n  Options: ${q.options.map((o) => o.label).join(" | ")}`)
        .join("\n"),
    {
      status: "needs_input",
      questions: r.pending.map((q) => ({
        id: q.id,
        question: q.question,
        why: q.why,
        options: q.options.map((o) => {
          const l = parseLinkOption(o.value);
          return {
            label: o.label,
            ...(l
              ? { link: { left: l.left, left_field: l.leftField, right: l.right, right_field: l.rightField } }
              : { link: null }),
          };
        }),
      })),
      links_already_clear: r.links.map((l) => ({
        left: l.left,
        left_field: l.leftField,
        right: l.right,
        right_field: l.rightField,
      })),
      datasets: sources.map((s) => ({ label: s.label, dataset_id: s.ds.id })),
      how_to_continue:
        'Call again with links: [{"left": "<label>", "left_field": "<field>", "right": "<label>", "right_field": "<field>"}, …] using the dataset_id references above as data, so files are not re-read.',
    },
  );
}

const linkOut = (l: LinkSpec) => ({
  left: l.left,
  left_field: l.leftField,
  right: l.right,
  right_field: l.rightField,
});

export function registerLinkingTools(server: McpServer, svc: VisualizationService): void {
  server.registerTool(
    "d3_link_datasets",
    {
      title: "Find how datasets relate",
      description:
        "Given 2–8 datasets in any format (CSV, Excel, JSON, YAML, GeoJSON, graphs, …), find the fields that link them (shared key values, matched trimmed and case-insensitively; name similarity; cardinality). Clear links are returned; ambiguous ones are asked through MCP elicitation when the client supports it, otherwise returned as questions. Use the result as 'links' for d3_create_dashboard or d3_join_datasets.",
      inputSchema: {
        datasets: z.array(LabeledData).min(2).max(8),
        links: z.array(LinkInput).max(20).optional().describe("Links you already know; others are inferred"),
        ask: z
          .boolean()
          .optional()
          .describe("Ask the user about ambiguous links via elicitation when supported (default true)"),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_link_datasets", async (a) => {
      const sessionId = a.session_id ?? "default";
      const loaded = [];
      for (const d of a.datasets)
        loaded.push({ ds: await svc.resolveData(d.data, sessionId), label: d.label });
      const labels = labelSources(loaded);
      const sources: LinkSource[] = loaded.map((l, i) => ({ ds: l.ds, label: labels[i]! }));
      const r = await resolveLinks(server, sources, (a.links ?? []).map(toSpec), "auto", a.ask !== false);
      const keys = entityKeys(sources, r.links);
      const summary = r.links.length
        ? `Linked ${r.links.length} pair(s): ${r.links.map((l) => `${l.left}.${l.leftField} = ${l.right}.${l.rightField}`).join("; ")}.`
        : "No links found.";
      return ok(
        `${summary}${r.pending.length ? ` ${r.pending.length} question(s) need the user's answer (see questions).` : ""}${keys ? ` Shared entity: ${keys.home.label}.${keys.home.field}.` : ""}`,
        {
          status: r.pending.length ? "needs_input" : "linked",
          datasets: sources.map((s) => ({ label: s.label, ...svc.datasetSummary(s.ds) })),
          links: r.links.map(linkOut),
          ...(keys ? { entity: keys.home, unlinked_datasets: keys.unreachable } : {}),
          candidates: r.analysis.candidates.slice(0, 20),
          questions: r.pending.map((q) => ({
            id: q.id,
            question: q.question,
            why: q.why,
            options: q.options,
          })),
          asked_user: r.asked,
          notes: r.notes,
          matching_rule:
            "Values are compared after trimming whitespace and ignoring case (SJC = sjc). Dates and numeric measures are not used as keys; numeric id/code fields are.",
          next_steps: [
            "d3_create_dashboard with the same datasets and these links → linked, cross-filtering dashboard",
            "d3_join_datasets with one link → a combined dataset_id usable by every tool",
          ],
        },
      );
    }),
  );

  server.registerTool(
    "d3_join_datasets",
    {
      title: "Join two datasets",
      description:
        "Join two datasets on a key (trimmed, case-insensitive) into a new dataset_id usable by every tool. left join (default) keeps all left rows; inner keeps matches only. Graph nodes and GeoJSON features can be enriched with table attributes. Omit the fields to use the inferred link (asks when ambiguous). Reports matched/unmatched counts and refuses joins that would multiply rows beyond the row limit.",
      inputSchema: {
        left: LabeledData,
        right: LabeledData,
        left_field: z.string().max(200).optional(),
        right_field: z.string().max(200).optional(),
        how: z.enum(["left", "inner"]).optional(),
        fields: z
          .array(z.string().max(200))
          .max(100)
          .optional()
          .describe("Only bring these fields from the right side"),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_join_datasets", async (a) => {
      const sessionId = a.session_id ?? "default";
      const L = await svc.resolveData(a.left.data, sessionId);
      const R = await svc.resolveData(a.right.data, sessionId);
      const [ll, rl] = labelSources([
        { ds: L, label: a.left.label },
        { ds: R, label: a.right.label },
      ]) as [string, string];
      const left: LinkSource = { ds: L, label: ll };
      const right: LinkSource = { ds: R, label: rl };
      let lf = a.left_field;
      let rf = a.right_field;
      if (!lf || !rf) {
        const r = await resolveLinks(server, [left, right], [], "auto");
        if (r.pending.length) return needsInput(r, [left, right], "d3_join_datasets");
        const l = r.links[0];
        if (!l)
          throw new D3McpError(
            "INCOMPATIBLE_DATA",
            `${ll} and ${rl} share no key values`,
            "Pass left_field and right_field explicitly.",
          );
        [lf, rf] = l.left === ll ? [l.leftField, l.rightField] : [l.rightField, l.leftField];
      }
      const j = joinDatasets(
        left,
        right,
        { leftField: lf, rightField: rf, how: a.how ?? "left", ...(a.fields ? { fields: a.fields } : {}) },
        svc.config.maxRows,
      );
      await svc.store.saveDataset(j.dataset, sessionId);
      return ok(
        `Joined ${ll}.${lf} = ${rl}.${rf}: ${j.matched} matched, ${j.unmatched} unmatched → dataset ${j.dataset.id} (${j.dataset.rows.length} rows, ${j.addedFields.length} added fields).`,
        {
          dataset_id: j.dataset.id,
          link: { left: ll, left_field: lf, right: rl, right_field: rf, how: a.how ?? "left" },
          matched: j.matched,
          unmatched: j.unmatched,
          added_fields: j.addedFields,
          dataset: svc.datasetSummary(j.dataset),
          sample_rows: j.dataset.rows.slice(0, 5),
          next_steps: [
            `Use {"dataset_id": "${j.dataset.id}"} as data in d3_visualize, d3_create_dashboard, …`,
          ],
        },
      );
    }),
  );
}
