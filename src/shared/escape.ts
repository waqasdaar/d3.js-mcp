const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Serialize JSON for embedding inside a <script type="application/json"> element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + "…";
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
