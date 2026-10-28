export type ApiKind = "export" | "constructor" | "invocation" | "method";

export interface InventoryEntry {
  id: string;
  module: string;
  section: string;
  symbol: string;
  normalized: string;
  kind: ApiKind;
  docUrl: string;
  description: string;
  exportedAtRuntime?: boolean;
}

export interface Inventory {
  source: string;
  retrievedAt: string;
  d3Version: string;
  sha256: string;
  countingMethod: string;
  entries: InventoryEntry[];
  runtimeExportsNotInIndex: string[];
  indexExportsMissingAtRuntime: string[];
}

export function normalizeSymbol(symbol: string): { normalized: string; kind: ApiKind } {
  const s = symbol.trim();
  if (s.startsWith("new "))
    return { normalized: s.slice(4).trim().replace(/^d3\./, ""), kind: "constructor" };
  let m = /^\*([\w$]+)\*$/.exec(s);
  if (m) return { normalized: `${m[1]}()`, kind: "invocation" };
  m = /^\*([\w$]+)\*\.?(.+)$/.exec(s);
  if (m) return { normalized: `${m[1]}.${m[2]!.replace(/^\[|\]$/g, "")}`, kind: "method" };
  return { normalized: s.replace(/^d3\./, ""), kind: "export" };
}

/** Parse the official D3 API index markdown (docs/api.md). */
export function parseApiIndex(md: string): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  const seen = new Set<string>();
  let module = "";
  let section = "";
  for (const line of md.split(/\r?\n/)) {
    let m = /^## \[([^\]]+)\]/.exec(line);
    if (m) {
      module = m[1]!;
      section = "";
      continue;
    }
    m = /^### \[([^\]]+)\]/.exec(line);
    if (m) {
      section = m[1]!;
      continue;
    }
    m = /^\* \[(.+?)\]\((.+?)\)\s*[-–]\s*(.*)$/.exec(line);
    if (!m || !module) continue;
    const symbol = m[1]!;
    const { normalized, kind } = normalizeSymbol(symbol);
    const id = `${module}:${normalized}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const link = m[2]!.replace(/^\.\//, "").replace(/\.md(#|$)/, "$1");
    out.push({
      id,
      module,
      section,
      symbol,
      normalized,
      kind,
      docUrl: `https://d3js.org/${link}`,
      description: m[3]!.trim(),
    });
  }
  return out;
}
