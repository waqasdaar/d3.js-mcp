export type ErrorCode =
  | "INVALID_INPUT"
  | "DATA_PARSE_ERROR"
  | "LIMIT_EXCEEDED"
  | "FIELD_NOT_FOUND"
  | "UNSUPPORTED_VISUALIZATION"
  | "INCOMPATIBLE_DATA"
  | "RENDER_FAILED"
  | "VALIDATION_FAILED"
  | "ARTIFACT_NOT_FOUND"
  | "EXPORT_FAILED"
  | "BROWSER_UNAVAILABLE"
  | "SECURITY_VIOLATION"
  | "COMPOSITION_ERROR";

export class D3McpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "D3McpError";
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function toErrorPayload(err: unknown): {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
} {
  if (err instanceof D3McpError) {
    return { code: err.code, message: err.message, hint: err.hint, details: err.details };
  }
  if (
    err &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    const issues = (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    return {
      code: "INVALID_INPUT",
      message: issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; "),
      hint: "Check the argument against the tool's input schema.",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL_ERROR", message };
}
