/**
 * D3 API inventory audit.
 *
 *   tsx scripts/audit-d3-api.ts            # fetch official docs/api.md for the installed d3 version, write inventory + coverage report
 *   tsx scripts/audit-d3-api.ts --offline  # rebuild inventory/coverage from the committed snapshot (data/d3-api.md)
 *   tsx scripts/audit-d3-api.ts --check    # compare the committed snapshot with the live official index (main); exit 1 on drift
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as d3 from "d3";
import { PACKAGE_ROOT } from "../src/shared/config.js";
import { parseApiIndex, type Inventory } from "../src/core/capabilities/inventory.js";

const DATA = path.join(PACKAGE_ROOT, "data");
const SNAPSHOT = path.join(DATA, "d3-api.md");
const INVENTORY = path.join(DATA, "d3-api-inventory.json");
const d3Version = (
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "node_modules", "d3", "package.json"), "utf8")) as {
    version: string;
  }
).version;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function buildInventory(md: string, sourceUrl: string, retrievedAt: string): Inventory {
  const entries = parseApiIndex(md);
  const exportsSet = new Set(Object.keys(d3));
  const D3 = d3 as unknown as Record<string, Record<string, unknown> | undefined>;
  const exists = (name: string) => {
    const [head, ...rest] = name.split(".");
    let v: unknown = D3[head!];
    for (const r of rest)
      v =
        v && (typeof v === "object" || typeof v === "function")
          ? (v as Record<string, unknown>)[r]
          : undefined;
    return v !== undefined;
  };
  for (const e of entries) {
    if (e.kind === "export" || e.kind === "constructor") e.exportedAtRuntime = exists(e.normalized);
  }
  const documented = new Set(
    entries.filter((e) => e.kind === "export" || e.kind === "constructor").map((e) => e.normalized),
  );
  return {
    source: sourceUrl,
    retrievedAt,
    d3Version,
    sha256: createHash("sha256").update(md).digest("hex"),
    countingMethod:
      "One entry per bullet in the official API index (docs/api.md): top-level exports, constructors, instance invocations (*x*) and instance methods (*x*.method). Duplicated bullets are counted once per module.",
    entries,
    runtimeExportsNotInIndex: [...exportsSet].filter((k) => !documented.has(k)).sort(),
    indexExportsMissingAtRuntime: entries
      .filter((e) => (e.kind === "export" || e.kind === "constructor") && !e.exportedAtRuntime)
      .map((e) => e.normalized),
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  mkdirSync(DATA, { recursive: true });
  if (args.has("--check")) {
    if (!existsSync(SNAPSHOT)) throw new Error("No snapshot; run without --check first");
    const live = await fetchText("https://raw.githubusercontent.com/d3/d3/main/docs/api.md");
    const a = parseApiIndex(readFileSync(SNAPSHOT, "utf8"));
    const b = parseApiIndex(live);
    const ka = new Set(a.map((e) => e.id));
    const kb = new Set(b.map((e) => e.id));
    const added = [...kb].filter((k) => !ka.has(k));
    const removed = [...ka].filter((k) => !kb.has(k));
    const changed = b
      .filter((e) => ka.has(e.id) && a.find((x) => x.id === e.id)!.description !== e.description)
      .map((e) => e.id);
    const report = {
      checkedAt: new Date().toISOString(),
      snapshotEntries: a.length,
      liveEntries: b.length,
      added,
      removed,
      changedDescriptions: changed,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(added.length || removed.length ? 1 : 0);
  }
  let md: string;
  let source: string;
  let retrievedAt: string;
  if (args.has("--offline")) {
    md = readFileSync(SNAPSHOT, "utf8");
    const prev = existsSync(INVENTORY) ? (JSON.parse(readFileSync(INVENTORY, "utf8")) as Inventory) : null;
    source = prev?.source ?? "data/d3-api.md";
    retrievedAt = prev?.retrievedAt ?? "unknown";
  } else {
    const tagged = `https://raw.githubusercontent.com/d3/d3/v${d3Version}/docs/api.md`;
    try {
      md = await fetchText(tagged);
      source = tagged;
    } catch (e) {
      console.error(`Tagged docs unavailable (${(e as Error).message}); falling back to main`);
      source = "https://raw.githubusercontent.com/d3/d3/main/docs/api.md";
      md = await fetchText(source);
    }
    retrievedAt = new Date().toISOString();
    writeFileSync(SNAPSHOT, md);
  }
  const inv = buildInventory(md, source, retrievedAt);
  writeFileSync(INVENTORY, JSON.stringify(inv, null, 2) + "\n");
  console.error(`Inventory: ${inv.entries.length} entries from ${source}`);
  const { writeCoverageReport } = await import("./coverage-report.js");
  const summary = await writeCoverageReport();
  console.log(JSON.stringify(summary.totals, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
