import * as d3 from "d3";
import type { Row } from "../core/data/types.js";
import { toNumber } from "../core/data/values.js";
import type { Transform } from "../core/schema/spec.js";
import { D3McpError } from "../shared/errors.js";
import { reduce } from "./svg/helpers.js";

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** Apply declarative, documented spec transforms. Returns new rows and human-readable descriptions. */
export function applyTransforms(rows: Row[], transforms: Transform[]): { rows: Row[]; applied: string[] } {
  let out = rows;
  const applied: string[] = [];
  for (const t of transforms) {
    const before = out.length;
    switch (t.type) {
      case "filter": {
        const v = t.value;
        out = out.filter((r) => {
          const x = r[t.field];
          switch (t.op) {
            case "eq":
              return x === v;
            case "neq":
              return x !== v;
            case "lt":
              return compare(x, v) < 0;
            case "lte":
              return compare(x, v) <= 0;
            case "gt":
              return compare(x, v) > 0;
            case "gte":
              return compare(x, v) >= 0;
            case "in":
              return Array.isArray(v) && (v as unknown[]).includes(x as never);
            case "notNull":
              return x !== null && x !== undefined;
          }
        });
        applied.push(
          `filter ${t.field} ${t.op} ${JSON.stringify(v ?? null)}: ${before} → ${out.length} rows`,
        );
        break;
      }
      case "aggregate": {
        if (t.op !== "count" && !t.field)
          throw new D3McpError("INVALID_INPUT", `aggregate "${t.op}" requires "field"`);
        const groups = d3.groups(out, (r) => t.groupBy.map((k) => String(r[k] ?? "")).join("\u0001"));
        out = groups.map(([, g]) => {
          const row: Row = {};
          for (const k of t.groupBy) row[k] = g[0]![k] ?? null;
          const vals = t.field
            ? g.map((r) => toNumber(r[t.field!] ?? null)).filter((n): n is number => n !== null)
            : [];
          row[t.as] = t.op === "count" ? g.length : reduce(vals, t.op);
          return row;
        });
        applied.push(
          `aggregate ${t.op}(${t.field ?? "*"}) by ${t.groupBy.join(", ")} as ${t.as}: ${before} → ${out.length} rows`,
        );
        break;
      }
      case "sort": {
        const dir = t.order === "ascending" ? 1 : -1;
        out = [...out].sort((a, b) => dir * compare(a[t.field], b[t.field]));
        applied.push(`sort by ${t.field} ${t.order}`);
        break;
      }
      case "limit":
        out = out.slice(0, t.count);
        applied.push(`limit to first ${t.count} rows: ${before} → ${out.length}`);
        break;
    }
  }
  return { rows: out, applied };
}
