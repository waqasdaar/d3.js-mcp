import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as d3 from "d3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeCapabilities, queryApi, STATUS_RULES } from "../../core/capabilities/registry.js";
import { executeComposition, OPS, StepSchema } from "../../core/composition/executor.js";
import { DataInputSchema } from "../../core/data/ingest.js";
import { SPREADSHEET_FORMATS, TEXT_FORMATS } from "../../core/data/formats.js";
import { parseSpec } from "../../core/schema/spec.js";
import { FORMATS, type VisualizationService } from "../../core/service.js";
import { validateHtml, validateSvg } from "../../core/validation/structural.js";
import { browserAvailable, inspectHtml } from "../../export/browser.js";
import { listRenderers } from "../../renderers/registry.js";
import { PACKAGE_ROOT } from "../../shared/config.js";
import { D3McpError } from "../../shared/errors.js";
import { artifactSummary, handler, ok, ResultSchema, SessionId, validationStatus } from "../util.js";

const D3 = d3 as unknown as Record<string, unknown>;

export function registerInspectionTools(server: McpServer, svc: VisualizationService): void {
  server.registerTool(
    "d3_query_api",
    {
      title: "Query the D3 API registry",
      description:
        "Search the D3 capability registry (built from the official API index) by symbol, module or keyword. Returns module, documentation URL, description, runtime arity for exports, and implementation status.",
      inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_query_api", async (a) => {
      const res = queryApi(a.query, a.limit ?? 20).map((e) => {
        const head = e.normalized.split(".")[0]!.replace(/\(\)$/, "");
        const fn = e.kind === "export" || e.kind === "constructor" ? D3[head] : undefined;
        return {
          symbol: e.symbol,
          normalized: e.normalized,
          module: e.module,
          section: e.section,
          kind: e.kind,
          description: e.description,
          doc_url: e.docUrl,
          status: e.status,
          used_by: e.usedBy,
          ...(e.note ? { note: e.note } : {}),
          runtime:
            typeof fn === "function"
              ? { type: "function", declared_parameters: (fn as { length: number }).length }
              : fn !== undefined
                ? { type: Array.isArray(fn) ? "array" : typeof fn }
                : undefined,
          signature_note:
            "Full signatures are documented at doc_url; the official index does not include them.",
        };
      });
      if (!res.length)
        throw new D3McpError(
          "INVALID_INPUT",
          `No D3 API entries match "${a.query}"`,
          "Try a symbol (scaleLinear), module (d3-force) or keyword (histogram).",
        );
      return ok(`${res.length} match(es) for "${a.query}".`, {
        results: res,
        status_definitions: STATUS_RULES,
      });
    }),
  );

  server.registerTool(
    "d3_execute_composition",
    {
      title: "Execute a safe D3 composition",
      description:
        "Execute a typed, declarative pipeline of whitelisted D3 operations (statistics, binning, grouping, scales, formats, colors, shapes, paths, hierarchy/force/Delaunay/contour/geo layouts, random, time intervals). Steps reference '$data', '$links', '$hierarchy', '$geojson' or earlier steps ('$stepId'). Arbitrary JavaScript is never evaluated.",
      inputSchema: {
        steps: z.array(StepSchema).min(1).max(50),
        data: DataInputSchema.optional(),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_execute_composition", async (a) => {
      const ds = a.data ? await svc.resolveData(a.data, a.session_id ?? "default") : undefined;
      const r = executeComposition({ steps: a.steps }, ds);
      return ok(`Executed ${a.steps.length} step(s) using ${r.d3ApisUsed.length} D3 APIs.`, {
        ...r,
        available_operations: Object.keys(OPS),
      });
    }),
  );

  server.registerTool(
    "d3_validate_visualization",
    {
      title: "Validate a visualization",
      description:
        "Validate an artifact (or a spec + data): structural SVG/HTML safety checks (no scripts/event handlers/external refs, CSP hashes, NaN geometry), accessibility (title/desc/role), expected marks, and — when browser=true — real Chromium rendering at desktop and mobile sizes, console errors, tooltips and overflow.",
      inputSchema: {
        artifact_id: z.string().max(64).optional(),
        spec: z.record(z.string(), z.unknown()).optional(),
        data: DataInputSchema.optional(),
        svg: z
          .string()
          .max(5_000_000)
          .optional()
          .describe("Validate arbitrary SVG markup (untrusted input is parsed, never executed)"),
        browser: z.boolean().optional().describe("Run headless-Chromium checks (default true for artifacts)"),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_validate_visualization", async (a) => {
      if (a.svg !== undefined) {
        const r = validateSvg(a.svg);
        return ok(`SVG ${r.valid ? "passed" : "failed"} validation (${r.errors.length} error(s)).`, {
          valid: r.valid,
          svg: r,
        });
      }
      if (a.artifact_id) {
        const rec = await svc.store.get(a.artifact_id);
        const html = rec.files.html ? await readFile(rec.files.html.path, "utf8") : null;
        const svgText = rec.files.svg ? await readFile(rec.files.svg.path, "utf8") : null;
        const out: Record<string, unknown> = { artifact_id: rec.id };
        let valid = true;
        if (svgText) {
          const r = validateSvg(
            svgText,
            rec.kind === "visualization"
              ? { markSelector: rec.markSelector, expectedMarks: rec.markCount }
              : {},
          );
          out.svg = r;
          valid &&= r.valid;
        }
        if (html) {
          const r = validateHtml(
            html,
            rec.kind === "visualization"
              ? { markSelector: rec.markSelector, expectedMarks: rec.markCount }
              : {},
          );
          out.html = r;
          valid &&= r.valid;
          if (a.browser !== false) {
            const b = await inspectHtml(html, {
              markSelector: rec.markSelector,
              ...(rec.kind === "visualization" ? { expectedMarks: rec.markCount } : {}),
              timeoutMs: svc.config.browserTimeoutMs,
              screenshotPath: path.join(rec.dir, "validation-screenshot.png"),
            });
            out.browser = b;
            out.screenshot = path.join(rec.dir, "validation-screenshot.png");
            valid &&= b.ok;
          }
        }
        return ok(`Artifact ${rec.id} ${valid ? "passed" : "FAILED"} validation.`, { valid, ...out });
      }
      if (a.spec) {
        const sessionId = a.session_id ?? "default";
        const raw = { ...a.spec } as Record<string, unknown>;
        let ds;
        if (a.data) {
          ds = await svc.resolveData(a.data, sessionId);
          raw.data = { datasetId: ds.id };
        } else
          ds = await svc.store.getDataset(
            String((raw.data as { datasetId?: string } | undefined)?.datasetId ?? ""),
          );
        if (!raw.id) raw.id = "validation";
        const spec = parseSpec(raw);
        const { out, report } = await svc.renderSvg(spec, ds);
        return ok(`Specification is valid and renders ${out.markCount} marks.`, {
          valid: true,
          svg: report,
          warnings: out.warnings,
          mark_count: out.markCount,
        });
      }
      throw new D3McpError("INVALID_INPUT", "Provide artifact_id, spec (+data), or svg");
    }),
  );

  server.registerTool(
    "d3_export",
    {
      title: "Export an artifact",
      description:
        "Export an existing artifact to additional formats (png, pdf, csv, svg, html, json). Reports the exact path of every produced file and the reason for any format that failed.",
      inputSchema: { artifact_id: z.string().max(64), formats: z.array(z.enum(FORMATS)).min(1).max(6) },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    handler("d3_export", async (a) => {
      const rec = await svc.exportArtifact(a.artifact_id, a.formats);
      const produced = a.formats.filter((f) => rec.files[f]);
      const failed = a.formats.filter((f) => !rec.files[f]);
      return ok(
        `Exported ${produced.join(", ") || "nothing"}${failed.length ? `; failed: ${failed.map((f) => `${f} (${rec.exportErrors[f] ?? "unavailable"})`).join(", ")}` : ""}.`,
        {
          ...artifactSummary(rec),
          requested: a.formats,
          produced,
          failed: Object.fromEntries(failed.map((f) => [f, rec.exportErrors[f] ?? "unavailable"])),
          validation_status: validationStatus(rec),
        },
      );
    }),
  );

  server.registerTool(
    "d3_get_artifact",
    {
      title: "Get artifact metadata or content",
      description:
        "Retrieve metadata for an artifact, optionally with the text content of its SVG, HTML or spec (size-limited), or list artifacts in a session.",
      inputSchema: {
        artifact_id: z.string().max(64).optional(),
        include_content: z.enum(["none", "svg", "html", "spec"]).optional(),
        list: z.boolean().optional().describe("List artifacts (optionally filtered by session_id)"),
        session_id: SessionId,
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_get_artifact", async (a) => {
      if (a.list || !a.artifact_id) {
        const all = await svc.store.list(a.session_id);
        return ok(`${all.length} artifact(s).`, {
          artifacts: all.slice(0, 200).map((r) => ({
            artifact_id: r.id,
            session_id: r.sessionId,
            title: r.title,
            type: r.visualizationType,
            created_at: r.createdAt,
            formats: Object.keys(r.files),
          })),
        });
      }
      const rec = await svc.store.get(a.artifact_id);
      const out: Record<string, unknown> = {
        ...artifactSummary(rec),
        validation_status: validationStatus(rec),
        warnings: rec.warnings,
      };
      const inc = a.include_content ?? "none";
      if (inc !== "none") {
        const f = inc === "spec" ? rec.files.json : rec.files[inc];
        if (!f) throw new D3McpError("ARTIFACT_NOT_FOUND", `Artifact has no ${inc} file`);
        if (f.bytes > svc.config.maxArtifactReadBytes) {
          out.content_omitted = `File is ${f.bytes} bytes (limit ${svc.config.maxArtifactReadBytes}); open ${f.path} directly.`;
        } else out.content = await readFile(f.path, "utf8");
      }
      return ok(`Artifact ${rec.id}: ${rec.title}`, out);
    }),
  );

  server.registerTool(
    "d3_list_capabilities",
    {
      title: "List capabilities",
      description:
        "Supported visualization types, D3 module coverage (exact counts by status), composition operations, export formats and browser availability, and configured resource limits.",
      inputSchema: {
        check_browser: z
          .boolean()
          .optional()
          .describe("Launch Chromium to confirm PNG/PDF/browser validation availability"),
      },
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_list_capabilities", async (a) => {
      const cov = computeCapabilities();
      const browser = a.check_browser
        ? await browserAvailable()
        : { available: "not checked (pass check_browser:true)" };
      const c = svc.config;
      return ok(`${listRenderers().length} visualization types; D3 index entries: ${cov.totals.total}.`, {
        visualization_types: listRenderers().map((r) => ({
          type: r.type,
          family: r.family,
          label: r.label,
          description: r.description,
          core_d3: r.core,
          data_kinds: r.dataKinds,
          required_channels: r.requiredChannels,
          canvas: r.supportsCanvas ?? false,
        })),
        d3_coverage: {
          source: cov.source,
          retrieved_at: cov.retrievedAt,
          d3_version: cov.d3Version,
          counting_method: cov.countingMethod,
          totals: cov.totals,
          modules: cov.modules,
          status_definitions: cov.statusRules,
        },
        composition_operations: Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.description])),
        export: {
          formats: FORMATS,
          always_produced: ["html", "svg", "json"],
          browser_required: ["png", "pdf"],
          browser,
        },
        limits: {
          max_rows: c.maxRows,
          max_columns: c.maxColumns,
          max_input_bytes: c.maxInputBytes,
          max_svg_marks: c.maxSvgMarks,
          max_force_nodes: c.maxForceNodes,
          max_force_links: c.maxForceLinks,
          max_hierarchy_nodes: c.maxHierarchyNodes,
          max_geo_features: c.maxGeoFeatures,
          artifact_ttl_hours: c.ttlHours,
          browser_timeout_ms: c.browserTimeoutMs,
        },
        artifact_directory: c.artifactDir,
        data_input: {
          inline: ["records array", "graph {nodes,links}", "GeoJSON", "TopoJSON", "hierarchy", "dataset_id"],
          text_formats: TEXT_FORMATS,
          spreadsheet_formats: SPREADSHEET_FORMATS,
          encoded: "{base64, format|filename} for any format (required for binary spreadsheets sent inline)",
          file_access: c.dataDirs.length
            ? {
                enabled: true,
                directories: c.dataDirs,
                max_file_bytes: c.maxFileBytes,
                usage: '{"file": "/path/to/data.xlsx", "sheet": "Sales"}',
              }
            : { enabled: false, how_to_enable: "Set D3MCP_DATA_DIRS to the directories the server may read" },
          remote_urls: "never fetched",
        },
        transports: ["stdio", "streamable-http (--http)"],
        render_workers: svc.renderPoolStats,
      });
    }),
  );

  server.registerTool(
    "d3_get_test_report",
    {
      title: "Get the latest test report",
      description:
        "Return the most recent verification report produced by 'npm run verify' (environment, per-suite results, coverage summary, outstanding failures).",
      inputSchema: {},
      outputSchema: ResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler("d3_get_test_report", async () => {
      const p = path.join(PACKAGE_ROOT, "reports", "verification-report.json");
      if (!existsSync(p))
        throw new D3McpError(
          "ARTIFACT_NOT_FOUND",
          "No verification report found",
          `Run "npm run verify" in ${PACKAGE_ROOT}`,
        );
      const report = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
      return ok(
        `Verification report from ${String(report.generatedAt ?? "unknown time")}: ${String(report.overall ?? "unknown")}.`,
        { report_path: p, report },
      );
    }),
  );
}
