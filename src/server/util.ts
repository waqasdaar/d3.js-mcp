import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toErrorPayload } from "../shared/errors.js";
import { log } from "../shared/logger.js";
import { FORMATS } from "../core/service.js";
import type { ArtifactRecord } from "../core/artifacts/store.js";

export const SessionId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .optional()
  .describe("Optional session identifier to group artifacts across calls (default: 'default')");

export const Formats = z
  .array(z.enum(FORMATS))
  .max(6)
  .optional()
  .describe(
    "Output formats. html, svg and json (spec) are always produced; png/pdf need Chromium (npx playwright install chromium); csv exports the transformed data",
  );

export const ResultSchema = z.looseObject({ ok: z.boolean() });

const MAX_TEXT = 60_000;

export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  const structured = { ok: true, ...data };
  let json = JSON.stringify(structured, null, 2);
  if (json.length > MAX_TEXT) json = json.slice(0, MAX_TEXT) + "\n… (truncated; see structuredContent)";
  return { content: [{ type: "text", text: `${summary}\n\n${json}` }], structuredContent: structured };
}

export function fail(err: unknown, tool: string): CallToolResult {
  const payload = toErrorPayload(err);
  log.warn("tool error", { tool, code: payload.code, message: payload.message.slice(0, 300) });
  const text = `Error ${payload.code}: ${payload.message}${payload.hint ? `\nHint: ${payload.hint}` : ""}`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { ok: false, error: payload },
  };
}

export function handler<A>(tool: string, fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    const t0 = Date.now();
    try {
      const r = await fn(args);
      log.info("tool ok", { tool, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      return fail(e, tool);
    }
  };
}

export function artifactSummary(rec: ArtifactRecord) {
  return {
    artifact_id: rec.id,
    session_id: rec.sessionId,
    kind: rec.kind,
    title: rec.title,
    visualization_type: rec.visualizationType,
    dimensions: { width: rec.width, height: rec.height },
    mark_count: rec.markCount,
    mark_selector: rec.markSelector,
    directory: rec.dir,
    files: Object.fromEntries(
      Object.entries(rec.files).map(([k, f]) => [
        k,
        { path: f!.path, uri: f!.uri, bytes: f!.bytes, sha256: f!.sha256 },
      ]),
    ),
    formats_produced: Object.keys(rec.files),
    export_errors: rec.exportErrors,
    created_at: rec.createdAt,
    ...(rec.parentArtifactId ? { parent_artifact_id: rec.parentArtifactId } : {}),
  };
}

export function validationStatus(rec: ArtifactRecord) {
  const v = rec.validation as Record<
    string,
    { valid?: boolean; ok?: boolean; errors?: string[] } | Array<{ valid: boolean }>
  >;
  const status: Record<string, string> = {};
  for (const [k, r] of Object.entries(v)) {
    if (Array.isArray(r)) status[k] = r.every((x) => x.valid) ? "passed" : "failed";
    else if (r && typeof r === "object")
      status[k] =
        r.valid === true || r.ok === true
          ? "passed"
          : r.valid === false || r.ok === false
            ? "failed"
            : "unknown";
  }
  for (const f of Object.keys(rec.exportErrors)) status[`${f}-export`] = "failed";
  return status;
}

export function openInstructions(rec: ArtifactRecord): string {
  const html = rec.files.html?.path;
  return html
    ? `Open the self-contained HTML file in any browser: open "${html}" (macOS) / xdg-open "${html}" (Linux) / start "" "${html}" (Windows). MCP clients may not render HTML inline.`
    : "No HTML file was produced.";
}
