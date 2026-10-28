import type { Scalar } from "./types.js";

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function looksTemporal(value: Scalar): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!ISO_DATE.test(s) && !SLASH_DATE.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

export function looksNumeric(value: string): boolean {
  return NUMERIC.test(value.trim());
}

/** Parse a temporal value into a Date. Numbers are treated as epoch milliseconds. */
export function toDate(value: Scalar): Date | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

export function toNumber(value: Scalar): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (looksNumeric(value)) return Number(value);
  return null;
}

export function toLabel(value: Scalar): string {
  if (value === null || value === undefined) return "(missing)";
  return String(value);
}
