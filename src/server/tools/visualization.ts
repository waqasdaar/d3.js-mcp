import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DataInputSchema } from "../../core/data/ingest.js";
import { profileDataset } from "../../core/data/profile.js";
import { planVisualization, PlanOptionsSchema, newVizId } from "../../core/planning/planner.js";
import { recommend } from "../../core/planning/recommend.js";
import { applyInstructions } from "../../core/planning/refine.js";
import { parseSpec, VIS_TYPES, type VisualizationSpec } from "../../core/schema/spec.js";
import type { VisualizationService } from "../../core/service.js";
import type { Dataset } from "../../core/data/types.js";
import { D3McpError } from "../../shared/errors.js";
import { labelSources, LinkInput, LinkMode, needsInput, resolveLinks, toSpec } from "./linking.js";
import {
  artifactSummary,
  Formats,
  handler,
  ok,
  openInstructions,
  ResultSchema,
  SessionId,
  validationStatus,
} from "../util.js";

const VisTypeInput = z
  .union([z.enum(VIS_TYPES), z.literal("auto")])
  .optional()
  .describe("Visualization type, or 'auto' (default) to let the planner choose");

const LIMITATIONS = [
  "Standalone HTML embeds the d3 v7 bundle inline (offline-capable); no network access is needed or allowed (strict CSP).",
  "Static SVG/PNG exports do not include interactivity (tooltips, zoom, brush, search work only in the HTML file).",
];

export function registerVisualizationTools(server: McpServer, svc: VisualizationService): void {
  server.registerTool(
    "d3_visualize",
    {
      title: "Create a D3 visualization",
      description:
        "Create a complete D3 visualization from data and a natural-language request. Profiles the data, plans the chart (or uses visualization_type), renders SVG + standalone interactive HTML (+ optional PNG/PDF/CSV), validates the output, and returns the specification, data mappings, findings and artifact file paths.",
      inputSchema: {
        data: DataInputSchema,
        prompt: z
          .string()
          .max(5000)
          .describe(
            "Analytical question / instructions, e.g. 'compare revenue by region, highlight the top 3, dark theme'",
          ),
        visualization_type: VisTypeInput,
        title: z.string().max(300).optional(),
        options: PlanOptionsSchema.optional(),
        output_formats: Formats,
        validate_in_browser: z
          .boolean()
          .optional()
          .describe("Also load the HTML in headless Chromium and verify rendering (slower)"),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler("d3_visualize", async (a) => {
      const sessionId = a.session_id ?? "default";
      const ds = await svc.resolveData(a.data, sessionId);
      const profile = profileDataset(ds);
      const plan = planVisualization({
        dataset: ds,
        profile,
        prompt: a.prompt,
        ...(a.visualization_type ? { type: a.visualization_type } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.options ? { options: a.options } : {}),
      });
      const formats = a.output_formats ?? (plan.suggestedFormats as never);
      const r = await svc.renderArtifact(plan.spec, ds, {
        formats,
        sessionId,
        validateInBrowser: a.validate_in_browser ?? false,
      });
      const art = artifactSummary(r.record);
      return ok(
        `Created ${plan.chosenType} visualization "${plan.spec.title}" (${r.render.markCount} marks). ${plan.explanation}\nHTML: ${art.files.html?.path}\nSVG: ${art.files.svg?.path}${art.files.png ? `\nPNG: ${art.files.png.path}` : ""}${Object.keys(r.record.exportErrors).length ? `\nExport failures: ${JSON.stringify(r.record.exportErrors)}` : ""}`,
        {
          ...art,
          explanation: plan.explanation,
          spec: plan.spec,
          data_mapping: plan.mappings,
          transformations: [...plan.transformations, ...r.render.transformsApplied],
          assumptions: plan.assumptions,
          alternatives: plan.alternatives,
          dataset: svc.datasetSummary(ds),
          validation_status: validationStatus(r.record),
          findings: r.findings,
          warnings: r.record.warnings,
          limitations: LIMITATIONS,
          how_to_open: openInstructions(r.record),
        },
      );
    }),
  );

  server.registerTool(
    "d3_recommend_visualizations",
    {
      title: "Recommend visualizations",
      description:
        "Profile a dataset and rank suitable visualizations with the analytical question each answers, rationale, trade-offs and proposed encodings.",
      inputSchema: {
        data: DataInputSchema,
        prompt: z.string().max(5000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_recommend_visualizations", async (a) => {
      const ds = await svc.resolveData(a.data, a.session_id ?? "default");
      const recs = recommend(ds, profileDataset(ds), a.prompt ?? "").slice(0, a.limit ?? 6);
      return ok(`${recs.length} recommendation(s); top: ${recs[0]?.type ?? "none"}.`, {
        dataset_id: ds.id,
        recommendations: recs,
      });
    }),
  );

  server.registerTool(
    "d3_analyze_data",
    {
      title: "Analyze / profile data",
      description:
        "Return schema, inferred field types, row count, missing values, unique counts, numeric summaries, outliers (Tukey fences), time coverage and notable correlations. Descriptive only; no causal claims.",
      inputSchema: { data: DataInputSchema, session_id: SessionId },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_analyze_data", async (a) => {
      const ds = await svc.resolveData(a.data, a.session_id ?? "default");
      const p = profileDataset(ds);
      return ok(
        `Profiled ${p.rowCount} ${ds.kind === "graph" ? "nodes" : "rows"} with ${p.fields.length} fields.`,
        { dataset_id: ds.id, profile: p, transformations: ds.transformations, warnings: ds.warnings },
      );
    }),
  );

  server.registerTool(
    "d3_create_spec",
    {
      title: "Create visualization specification",
      description:
        "Plan and return a validated, reusable visualization specification (JSON, schema v1.0) without rendering. The dataset is stored and referenced by data.datasetId.",
      inputSchema: {
        data: DataInputSchema,
        prompt: z.string().max(5000),
        visualization_type: VisTypeInput,
        title: z.string().max(300).optional(),
        options: PlanOptionsSchema.optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_create_spec", async (a) => {
      const sessionId = a.session_id ?? "default";
      const ds = await svc.resolveData(a.data, sessionId);
      const plan = planVisualization({
        dataset: ds,
        profile: profileDataset(ds),
        prompt: a.prompt,
        ...(a.visualization_type ? { type: a.visualization_type } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.options ? { options: a.options } : {}),
      });
      // Dry-run render validates field references and data compatibility before returning the spec.
      const dry = await svc.renderSvg(plan.spec, ds);
      const specPath = await svc.store.saveSpec(plan.spec, sessionId);
      return ok(
        `Specification ${plan.spec.id} (${plan.chosenType}) created and validated (${dry.out.markCount} marks in dry run).`,
        {
          spec: plan.spec,
          spec_path: specPath,
          dataset_id: ds.id,
          explanation: plan.explanation,
          data_mapping: plan.mappings,
          transformations: plan.transformations,
          assumptions: plan.assumptions,
          alternatives: plan.alternatives,
          dry_run: { mark_count: dry.out.markCount, warnings: dry.out.warnings },
          schema_resource: "d3://schema/visualization-spec",
        },
      );
    }),
  );

  server.registerTool(
    "d3_render",
    {
      title: "Render a specification",
      description:
        "Render an existing visualization specification (from d3_create_spec or hand-written) into validated SVG/HTML (+PNG/PDF/CSV) artifacts. Data comes from spec.data.datasetId or the 'data' argument.",
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .describe("Visualization specification object (see resource d3://schema/visualization-spec)"),
        data: DataInputSchema.optional().describe("Data to render; overrides spec.data.datasetId"),
        output_formats: Formats,
        validate_in_browser: z.boolean().optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_render", async (a) => {
      const sessionId = a.session_id ?? "default";
      let ds: Dataset;
      const rawSpec = { ...a.spec } as Record<string, unknown>;
      if (a.data) {
        ds = await svc.resolveData(a.data, sessionId);
        rawSpec.data = { datasetId: ds.id };
      } else {
        const id = (rawSpec.data as { datasetId?: string } | undefined)?.datasetId;
        if (!id) throw new D3McpError("INVALID_INPUT", "Provide 'data' or spec.data.datasetId");
        ds = await svc.store.getDataset(id);
      }
      if (!rawSpec.id) rawSpec.id = newVizId();
      const spec = parseSpec(rawSpec);
      const r = await svc.renderArtifact(spec, ds, {
        formats: a.output_formats ?? ["html", "svg"],
        sessionId,
        validateInBrowser: a.validate_in_browser ?? false,
      });
      return ok(`Rendered ${spec.type} (${r.render.markCount} marks). HTML: ${r.record.files.html?.path}`, {
        ...artifactSummary(r.record),
        spec,
        validation_status: validationStatus(r.record),
        findings: r.findings,
        warnings: r.record.warnings,
        transformations: r.render.transformsApplied,
        how_to_open: openInstructions(r.record),
      });
    }),
  );

  const ChartInput = z
    .object({
      data: DataInputSchema.optional().describe("Chart data (defaults to the shared 'data')"),
      prompt: z.string().max(5000).optional(),
      visualization_type: VisTypeInput,
      title: z.string().max(300).optional(),
      options: PlanOptionsSchema.optional(),
      spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("A complete spec instead of prompt-based planning"),
    })
    .strict();

  server.registerTool(
    "d3_compose_visualizations",
    {
      title: "Compose a dashboard",
      description:
        "Compose several charts into one responsive HTML dashboard with a shared category filter, cross-chart highlighting of matching marks, clickable legends, and an optional shared time brush across temporal charts.",
      inputSchema: {
        title: z.string().max(300),
        description: z.string().max(2000).optional(),
        data: DataInputSchema.optional().describe("Shared data used by charts that do not provide their own"),
        charts: z.array(ChartInput).min(1).max(12),
        columns: z.number().int().min(1).max(4).optional(),
        theme: z.enum(["light", "dark"]).optional(),
        shared_time_brush: z
          .boolean()
          .optional()
          .describe("Enable brushing on temporal charts; the selected time range filters all charts"),
        output_formats: Formats,
        validate_in_browser: z.boolean().optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_compose_visualizations", async (a) => {
      const sessionId = a.session_id ?? "default";
      const shared = a.data ? await svc.resolveData(a.data, sessionId) : null;
      const columns = a.columns ?? Math.min(2, a.charts.length);
      const items: Array<{ spec: VisualizationSpec; ds: Dataset }> = [];
      const plans: Array<Record<string, unknown>> = [];
      for (const [i, c] of a.charts.entries()) {
        const ds = c.data ? await svc.resolveData(c.data, sessionId) : shared;
        if (!ds)
          throw new D3McpError("INVALID_INPUT", `charts[${i}] has no data and no shared data was provided`);
        let spec: VisualizationSpec;
        if (c.spec) {
          spec = parseSpec({
            ...c.spec,
            id: (c.spec.id as string) ?? newVizId(),
            data: { datasetId: ds.id },
          });
        } else {
          const opts = {
            width: columns > 1 ? 560 : 900,
            height: 360,
            ...(a.theme ? { theme: a.theme } : {}),
            ...(c.options ?? {}),
          };
          const plan = planVisualization({
            dataset: ds,
            profile: profileDataset(ds),
            prompt: c.prompt ?? "",
            ...(c.visualization_type ? { type: c.visualization_type } : {}),
            ...(c.title ? { title: c.title } : {}),
            options: opts,
          });
          spec = plan.spec;
          plans.push({
            index: i,
            type: spec.type,
            explanation: plan.explanation,
            data_mapping: plan.mappings,
          });
        }
        if (a.shared_time_brush && ["line", "area", "cumulative", "scatter"].includes(spec.type)) {
          spec = parseSpec({ ...spec, interaction: { ...spec.interaction, brush: true } });
        }
        items.push({ spec, ds });
      }
      const r = await svc.renderDashboard(items, {
        title: a.title,
        ...(a.description ? { description: a.description } : {}),
        columns,
        formats: a.output_formats ?? ["html"],
        sessionId,
        validateInBrowser: a.validate_in_browser ?? false,
      });
      return ok(`Dashboard "${a.title}" with ${r.charts.length} charts. HTML: ${r.record.files.html?.path}`, {
        ...artifactSummary(r.record),
        charts: r.charts,
        plans,
        findings: r.findings,
        warnings: r.record.warnings,
        validation_status: validationStatus(r.record),
        linked_interactions: [
          "shared category filter",
          "cross-chart hover highlighting by data-key",
          "legend click highlighting",
          ...(a.shared_time_brush ? ["shared time-range brush"] : []),
        ],
        how_to_open: openInstructions(r.record),
      });
    }),
  );

  server.registerTool(
    "d3_create_dashboard",
    {
      title: "Create a dashboard automatically",
      description:
        "Build a complete dashboard from data and a goal, without specifying charts: profiles each dataset, picks a complementary set of charts (trends per measure, comparisons, shares, distributions, relationships, maps, networks, hierarchies), adds KPI tiles, enables a shared category filter, linked highlighting and a shared time brush, and renders one standalone HTML file. Accepts every data format (records, CSV/TSV, JSON, JSON Lines, YAML, Excel/ODS, GeoJSON/TopoJSON, graphs, files). With several datasets it finds the shared keys (or uses 'links'), asks the user when a link is ambiguous, adds joined views (e.g. a measure by an attribute from another file), colours maps by linked measures, and makes the dashboard cross-filter: clicking a site/region/node/bar selects the same entity in every chart and lists its records from every source. Use d3_compose_visualizations instead when you want to choose each chart yourself.",
      inputSchema: {
        prompt: z
          .string()
          .max(5000)
          .describe(
            "What the dashboard should help answer, e.g. 'SD-WAN health by site: latency, loss, throughput'",
          ),
        data: DataInputSchema.optional().describe("A single dataset"),
        datasets: z
          .array(
            z
              .object({
                data: DataInputSchema,
                label: z
                  .string()
                  .max(80)
                  .optional()
                  .describe("Short name shown in chart titles and KPI tiles"),
                prompt: z.string().max(2000).optional().describe("Extra focus for this dataset"),
              })
              .strict(),
          )
          .min(1)
          .max(8)
          .optional()
          .describe("Several datasets (e.g. different files or sheets); each gets at least one chart"),
        split_sheets: z
          .boolean()
          .optional()
          .describe("With a spreadsheet in 'data', treat every sheet as its own dataset"),
        links: z
          .array(LinkInput)
          .max(20)
          .optional()
          .describe(
            "How datasets relate, by label, e.g. telemetry.site = sites.site_code (others are inferred)",
          ),
        link_mode: LinkMode,
        title: z.string().max(300).optional(),
        description: z.string().max(2000).optional(),
        max_charts: z.number().int().min(1).max(12).optional().describe("Default 6"),
        kpis: z.boolean().optional().describe("Show KPI tiles (default true)"),
        columns: z.number().int().min(1).max(4).optional(),
        theme: z.enum(["light", "dark"]).optional(),
        output_formats: Formats,
        validate_in_browser: z.boolean().optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_create_dashboard", async (a) => {
      const sessionId = a.session_id ?? "default";
      if (!a.data && !a.datasets) throw new D3McpError("INVALID_INPUT", "Provide 'data' or 'datasets'");
      const inputs: Array<{ ds: Dataset; label?: string; prompt?: string }> = [];
      if (a.data && a.split_sheets) {
        const src = a.data as Record<string, unknown>;
        if (Array.isArray(a.data) || (typeof src.file !== "string" && typeof src.base64 !== "string")) {
          throw new D3McpError(
            "INVALID_INPUT",
            "split_sheets requires a spreadsheet (xlsx, xls, ods, …) in 'data'",
            'Pass {"file": "book.xlsx"} or {"base64": "…", "filename": "book.xlsx"}.',
          );
        }
        const all = await svc.resolveData({ ...src, sheet: "all" }, sessionId);
        const sheets = all.origin?.sheets;
        if (!sheets?.length)
          throw new D3McpError(
            "INVALID_INPUT",
            "split_sheets requires a spreadsheet (xlsx, xls, ods, …) in 'data'",
          );
        for (const sheet of sheets.slice(0, 8)) {
          inputs.push({
            ds: await svc.resolveData({ ...(a.data as Record<string, unknown>), sheet }, sessionId),
            label: sheet,
          });
        }
      } else if (a.data) {
        inputs.push({ ds: await svc.resolveData(a.data, sessionId) });
      }
      for (const d of a.datasets ?? []) {
        inputs.push({
          ds: await svc.resolveData(d.data, sessionId),
          ...(d.label ? { label: d.label } : {}),
          ...(d.prompt ? { prompt: d.prompt } : {}),
        });
      }
      if (inputs.length > 1) {
        const labels = labelSources(inputs);
        inputs.forEach((i, n) => (i.label = labels[n]!));
      }
      const mode = a.link_mode ?? "auto";
      const resolved =
        inputs.length > 1 && (mode !== "none" || a.links?.length)
          ? await resolveLinks(
              server,
              inputs.map((i) => ({ ds: i.ds, label: i.label! })),
              (a.links ?? []).map(toSpec),
              mode,
            )
          : null;
      if (resolved?.pending.length) {
        return needsInput(
          resolved,
          inputs.map((i) => ({ ds: i.ds, label: i.label! })),
          "d3_create_dashboard",
        );
      }
      const r = await svc.autoDashboard(inputs, {
        prompt: a.prompt,
        maxCharts: a.max_charts ?? 6,
        kpis: a.kpis ?? true,
        formats: a.output_formats ?? ["html"],
        sessionId,
        validateInBrowser: a.validate_in_browser ?? false,
        ...(resolved?.links.length ? { links: resolved.links } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.description ? { description: a.description } : {}),
        ...(a.columns ? { columns: a.columns } : {}),
        ...(a.theme ? { chartOptions: { theme: a.theme } } : {}),
      });
      return ok(
        `Dashboard "${r.record.title}" with ${r.plan.length} charts (${r.plan.map((p) => p.type).join(", ")})${r.kpis.length ? ` and ${r.kpis.length} KPI tiles` : ""}. HTML: ${r.record.files.html?.path}`,
        {
          ...artifactSummary(r.record),
          charts: r.plan,
          kpis: r.kpis,
          skipped_candidates: r.skipped,
          datasets: inputs.map((i) => ({ label: i.label ?? null, ...svc.datasetSummary(i.ds) })),
          findings: r.findings,
          warnings: r.record.warnings,
          validation_status: validationStatus(r.record),
          ...(r.linking
            ? {
                linking: {
                  ...r.linking,
                  links: r.linking.links.map((l) => ({
                    left: l.left,
                    left_field: l.leftField,
                    right: l.right,
                    right_field: l.rightField,
                  })),
                  asked_user: resolved?.asked ?? "none",
                  notes: resolved?.notes ?? [],
                },
              }
            : resolved
              ? { linking: { links: [], asked_user: resolved.asked, notes: resolved.notes } }
              : {}),
          linked_interactions: [
            ...(r.linking
              ? [
                  `click any mark to select its ${r.linking.entity.field} in every chart (click again or Reset to clear)`,
                  "detail panel listing the selected entity's records from every source",
                ]
              : []),
            "shared category filter",
            "cross-chart hover highlighting by data-key",
            "legend click highlighting",
            ...(r.sharedTimeBrush ? ["shared time-range brush"] : []),
          ],
          kpi_rule:
            "KPI tiles are descriptive: totals for additively-named fields (revenue, count, units, …), otherwise averages; min/max shown for context.",
          how_to_open: openInstructions(r.record),
        },
      );
    }),
  );

  server.registerTool(
    "d3_refine_visualization",
    {
      title: "Refine a visualization",
      description:
        "Modify an existing visualization with natural-language instructions (e.g. 'use a logarithmic y scale', 'add a threshold line at 50', 'highlight the top 5', 'use a dark theme', 'sort descending', 'change to a line chart'). Unrelated settings are preserved; a new artifact is produced.",
      inputSchema: {
        artifact_id: z
          .string()
          .max(64)
          .optional()
          .describe("Artifact to refine (from d3_visualize/d3_render)"),
        spec_id: z.string().max(64).optional().describe("Alternatively, a stored spec id"),
        instructions: z.string().min(1).max(2000),
        output_formats: Formats,
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_refine_visualization", async (a) => {
      let specId = a.spec_id;
      let parent: string | undefined;
      if (a.artifact_id) {
        const rec = await svc.store.get(a.artifact_id);
        if (rec.kind !== "visualization")
          throw new D3McpError(
            "INVALID_INPUT",
            "Only single visualizations can be refined; refine dashboard charts individually.",
          );
        specId = rec.specIds[0];
        parent = rec.id;
      }
      if (!specId) throw new D3McpError("INVALID_INPUT", "Provide artifact_id or spec_id");
      const prev = await svc.store.getSpec(specId);
      const ds = await svc.store.getDataset(prev.data.datasetId);
      const refined = applyInstructions(prev, a.instructions, ds);
      const spec = parseSpec({ ...refined.spec, id: newVizId() });
      const sessionId = a.session_id ?? "default";
      const r = await svc.renderArtifact(spec, ds, {
        formats: a.output_formats ?? ["html", "svg"],
        sessionId,
        ...(parent ? { parentArtifactId: parent } : {}),
      });
      return ok(
        `Refined visualization: ${refined.changes.join(" ")}${refined.unrecognized.length ? ` Unrecognized: ${refined.unrecognized.join(" | ")}` : ""}\nHTML: ${r.record.files.html?.path}`,
        {
          ...artifactSummary(r.record),
          previous_spec_id: prev.id,
          changes: refined.changes,
          unrecognized_instructions: refined.unrecognized,
          spec,
          validation_status: validationStatus(r.record),
          findings: r.findings,
          warnings: r.record.warnings,
          how_to_open: openInstructions(r.record),
        },
      );
    }),
  );
}
