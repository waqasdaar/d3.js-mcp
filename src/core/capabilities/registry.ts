import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OPS } from "../composition/executor.js";
import { listRenderers } from "../../renderers/registry.js";
import { RUNTIME_D3_APIS } from "../../export/runtime.js";
import { PACKAGE_ROOT } from "../../shared/config.js";
import type { Inventory, InventoryEntry } from "./inventory.js";

export type CapabilityStatus =
  | "implemented-and-tested"
  | "implemented-with-constraints"
  | "available-through-safe-composition"
  | "documented-but-not-yet-implemented"
  | "unsupported-by-current-runtime";

export const STATUSES: CapabilityStatus[] = [
  "implemented-and-tested",
  "implemented-with-constraints",
  "available-through-safe-composition",
  "documented-but-not-yet-implemented",
  "unsupported-by-current-runtime",
];

export interface CapabilityEntry extends InventoryEntry {
  status: CapabilityStatus;
  usedBy: string[];
  note?: string;
}

export interface CapabilityReport {
  source: string;
  retrievedAt: string;
  d3Version: string;
  countingMethod: string;
  statusRules: Record<CapabilityStatus, string>;
  totals: Record<CapabilityStatus | "total", number> & { percentages: Record<CapabilityStatus, number> };
  modules: Array<{ module: string; total: number } & Record<CapabilityStatus, number>>;
  entries: CapabilityEntry[];
  unmatchedUsageKeys: string[];
  runtimeExportsNotInIndex: string[];
  indexExportsMissingAtRuntime: string[];
}

export const STATUS_RULES: Record<CapabilityStatus, string> = {
  "implemented-and-tested":
    "Called by at least one registered renderer; every renderer is exercised by unit and browser tests.",
  "implemented-with-constraints":
    "Used only by the in-browser runtime of HTML artifacts (requires JavaScript and the embedded d3 bundle); covered by Playwright tests.",
  "available-through-safe-composition":
    "Reachable through a whitelisted d3_execute_composition operation; every operation is exercised by unit tests.",
  "documented-but-not-yet-implemented":
    "Listed in the official API index but not used by any renderer, runtime feature, or composition operation.",
  "unsupported-by-current-runtime":
    "Intentionally unavailable: d3-fetch (network/file access is disabled by the security policy).",
};

let cachedInventory: Inventory | null = null;

export function inventoryPath(): string {
  return path.join(PACKAGE_ROOT, "data", "d3-api-inventory.json");
}

export function loadInventory(): Inventory {
  if (cachedInventory) return cachedInventory;
  const p = inventoryPath();
  if (!existsSync(p)) throw new Error(`D3 API inventory not found at ${p}; run "npm run audit:d3"`);
  cachedInventory = JSON.parse(readFileSync(p, "utf8")) as Inventory;
  return cachedInventory;
}

/** Map of normalized API key -> list of consumers ("renderer:bar", "composition:array.bin", "runtime"). */
export function usageIndex(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  const add = (k: string, who: string) => {
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k)!.add(who);
  };
  for (const r of listRenderers()) for (const a of r.d3Apis) add(a, `renderer:${r.type}`);
  for (const [name, op] of Object.entries(OPS)) for (const a of op.apis) add(a, `composition:${name}`);
  for (const a of RUNTIME_D3_APIS) add(a, "runtime");
  return idx;
}

function consumersFor(e: InventoryEntry, idx: Map<string, Set<string>>): string[] {
  const out = new Set<string>(idx.get(e.normalized) ?? []);
  if (e.kind === "invocation") {
    const base = e.normalized.slice(0, -2);
    for (const [k, v] of idx) if (k === base || k.startsWith(`${base}.`)) v.forEach((x) => out.add(x));
  }
  return [...out].sort();
}

export function computeCapabilities(inv: Inventory = loadInventory()): CapabilityReport {
  const idx = usageIndex();
  const matched = new Set<string>();
  const entries: CapabilityEntry[] = inv.entries.map((e) => {
    const usedBy = consumersFor(e, idx);
    if (idx.has(e.normalized)) matched.add(e.normalized);
    let status: CapabilityStatus;
    let note: string | undefined;
    if (e.module === "d3-fetch") {
      status = "unsupported-by-current-runtime";
      note = "Network and file fetching are disabled; pass data inline to the MCP tools.";
    } else if (usedBy.some((u) => u.startsWith("renderer:"))) status = "implemented-and-tested";
    else if (usedBy.includes("runtime")) {
      status = "implemented-with-constraints";
      note = "Browser runtime only (HTML artifacts).";
    } else if (usedBy.some((u) => u.startsWith("composition:")))
      status = "available-through-safe-composition";
    else status = "documented-but-not-yet-implemented";
    return { ...e, status, usedBy, ...(note ? { note } : {}) };
  });
  const totals = Object.fromEntries(
    STATUSES.map((s) => [s, entries.filter((e) => e.status === s).length]),
  ) as Record<CapabilityStatus, number>;
  const total = entries.length;
  const percentages = Object.fromEntries(
    STATUSES.map((s) => [s, Math.round((totals[s] / total) * 10000) / 100]),
  ) as Record<CapabilityStatus, number>;
  const modules = [...new Set(entries.map((e) => e.module))].map((module) => {
    const es = entries.filter((e) => e.module === module);
    return {
      module,
      total: es.length,
      ...(Object.fromEntries(STATUSES.map((s) => [s, es.filter((e) => e.status === s).length])) as Record<
        CapabilityStatus,
        number
      >),
    };
  });
  const allKeys = new Set(inv.entries.map((e) => e.normalized));
  const unmatchedUsageKeys = [...idx.keys()].filter((k) => !allKeys.has(k) && !matched.has(k)).sort();
  return {
    source: inv.source,
    retrievedAt: inv.retrievedAt,
    d3Version: inv.d3Version,
    countingMethod: inv.countingMethod,
    statusRules: STATUS_RULES,
    totals: { ...totals, total, percentages },
    modules,
    entries,
    unmatchedUsageKeys,
    runtimeExportsNotInIndex: inv.runtimeExportsNotInIndex,
    indexExportsMissingAtRuntime: inv.indexExportsMissingAtRuntime,
  };
}

export function queryApi(query: string, limit = 25): CapabilityEntry[] {
  const q = query.trim().toLowerCase().replace(/^d3\./, "");
  const report = computeCapabilities();
  const score = (e: CapabilityEntry) => {
    const n = e.normalized.toLowerCase();
    if (n === q || e.symbol.toLowerCase() === q) return 0;
    if (e.module.toLowerCase() === q || e.module.toLowerCase() === `d3-${q}`) return 1;
    if (n.startsWith(q)) return 2;
    if (n.includes(q)) return 3;
    if (e.description.toLowerCase().includes(q) || e.section.toLowerCase().includes(q)) return 4;
    return 9;
  };
  return report.entries
    .map((e) => [score(e), e] as const)
    .filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, e]) => e);
}
