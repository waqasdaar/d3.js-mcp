import { dsvFormat } from "d3";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import { feature as topoFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import * as XLSX from "xlsx";
import { parse as parseYamlText } from "yaml";
import { D3McpError } from "../../shared/errors.js";

export const TEXT_FORMATS = [
  "csv",
  "tsv",
  "dsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "geojson",
  "topojson",
] as const;
export const SPREADSHEET_FORMATS = ["xlsx", "xlsm", "xlsb", "xls", "ods", "fods", "excel"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];
export type SpreadsheetFormat = (typeof SPREADSHEET_FORMATS)[number];

const EXTENSIONS: Record<string, TextFormat | SpreadsheetFormat> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  psv: "dsv",
  txt: "dsv",
  json: "json",
  jsonl: "jsonl",
  ndjson: "ndjson",
  yaml: "yaml",
  yml: "yaml",
  geojson: "geojson",
  topojson: "topojson",
  xlsx: "xlsx",
  xlsm: "xlsm",
  xlsb: "xlsb",
  xls: "xls",
  ods: "ods",
  fods: "fods",
};

export function formatFromFilename(name: string): TextFormat | SpreadsheetFormat | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? (EXTENSIONS[ext] ?? null) : null;
}

export function isSpreadsheet(format: string): format is SpreadsheetFormat {
  return (SPREADSHEET_FORMATS as readonly string[]).includes(format);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pick the delimiter that splits the header line most consistently across the first lines. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, 6).filter((l) => l.trim());
  let best = ",";
  let bestScore = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = first * consistent;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseDsvRows(
  text: string,
  delimiter: string,
): { columns: string[]; rows: Array<Record<string, string>> } {
  if (delimiter.length !== 1 || /["\r\n]/.test(delimiter)) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Invalid delimiter ${JSON.stringify(delimiter)}`,
      "Use a single character such as ',', ';', '|' or a tab.",
    );
  }
  const parsed = dsvFormat(delimiter).parse(stripBom(text));
  return { columns: parsed.columns, rows: parsed as unknown as Array<Record<string, string>> };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripBom(text));
  } catch (e) {
    throw new D3McpError("DATA_PARSE_ERROR", `Invalid JSON: ${(e as Error).message}`);
  }
}

export function parseJsonLines(text: string, maxRows: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const lines = stripBom(text).split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (out.length >= maxRows) {
      throw new D3McpError(
        "LIMIT_EXCEEDED",
        `JSON Lines input has more than ${maxRows} records`,
        "Raise D3MCP_MAX_ROWS or sample the file.",
      );
    }
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch (e) {
      throw new D3McpError("DATA_PARSE_ERROR", `Invalid JSON on line ${i + 1}: ${(e as Error).message}`);
    }
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new D3McpError("DATA_PARSE_ERROR", `Line ${i + 1} is not a JSON object`);
    out.push(v as Record<string, unknown>);
  }
  return out;
}

/** YAML 1.2 core schema only: no custom tags, bounded aliases (billion-laughs protection), duplicate keys rejected. */
export function parseYaml(text: string): unknown {
  try {
    return parseYamlText(stripBom(text), {
      schema: "core",
      maxAliasCount: 100,
      uniqueKeys: true,
      merge: false,
      prettyErrors: true,
    });
  } catch (e) {
    throw new D3McpError("DATA_PARSE_ERROR", `Invalid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
}

const WRAPPER_KEYS = ["data", "records", "rows", "items", "results", "values", "entries", "list", "result"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function scalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Turn common JSON/YAML document shapes into something `ingest` understands, recording what was done:
 * explicit records_path, {data:[…]} style wrappers, column-oriented {col:[…]} objects and {key: value} maps.
 */
export function reshapeDocument(
  doc: unknown,
  recordsPath: string | undefined,
  transformations: string[],
): unknown {
  if (recordsPath) {
    let cur: unknown = doc;
    for (const part of recordsPath.split(".")) {
      if (!isPlainObject(cur) && !Array.isArray(cur)) cur = undefined;
      else cur = (cur as Record<string, unknown>)[part];
      if (cur === undefined)
        throw new D3McpError(
          "INVALID_INPUT",
          `records_path "${recordsPath}" not found (stopped at "${part}")`,
        );
    }
    transformations.push(`Selected records at path "${recordsPath}".`);
    return cur;
  }
  if (!isPlainObject(doc)) return doc;
  if (
    doc.type === "FeatureCollection" ||
    doc.type === "Topology" ||
    (Array.isArray(doc.nodes) && Array.isArray(doc.links)) ||
    Array.isArray(doc.children)
  )
    return doc;
  for (const k of WRAPPER_KEYS) {
    const v = doc[k];
    if (Array.isArray(v) && v.every(isPlainObject)) {
      transformations.push(`Used the "${k}" array of the document as records.`);
      return v;
    }
  }
  const entries = Object.entries(doc);
  if (entries.length && entries.every(([, v]) => Array.isArray(v) && v.every(scalar))) {
    const len = (entries[0]![1] as unknown[]).length;
    if (entries.every(([, v]) => (v as unknown[]).length === len)) {
      transformations.push(
        `Converted column-oriented object (${entries.length} columns × ${len} rows) to records.`,
      );
      return Array.from({ length: len }, (_, i) =>
        Object.fromEntries(entries.map(([k, v]) => [k, (v as unknown[])[i]])),
      );
    }
  }
  if (entries.length && entries.every(([, v]) => scalar(v))) {
    transformations.push(
      `Converted key/value object (${entries.length} entries) to records with fields "key" and "value".`,
    );
    return entries.map(([key, value]) => ({ key, value }));
  }
  const arrays = entries.filter(([, v]) => Array.isArray(v) && v.length && v.every(isPlainObject));
  if (arrays.length === 1) {
    transformations.push(`Used the only array of objects in the document ("${arrays[0]![0]}") as records.`);
    return arrays[0]![1];
  }
  return doc;
}

export function topologyToGeo(
  topology: Topology,
  objectName: string | undefined,
  transformations: string[],
): FeatureCollection {
  const names = Object.keys(topology.objects ?? {});
  if (!names.length) throw new D3McpError("INVALID_INPUT", "TopoJSON has no objects");
  const name = objectName ?? names[0]!;
  const obj = topology.objects[name];
  if (!obj)
    throw new D3McpError(
      "INVALID_INPUT",
      `TopoJSON object "${name}" not found`,
      `Available: ${names.join(", ")}`,
    );
  let fc: ReturnType<typeof topoFeature>;
  try {
    fc = topoFeature(topology, obj);
  } catch (e) {
    throw new D3McpError("DATA_PARSE_ERROR", `Invalid TopoJSON: ${(e as Error).message}`);
  }
  transformations.push(
    `Converted TopoJSON object "${name}" to GeoJSON${names.length > 1 ? ` (other objects: ${names.filter((n) => n !== name).join(", ")})` : ""}.`,
  );
  return fc.type === "FeatureCollection"
    ? (fc as FeatureCollection)
    : { type: "FeatureCollection", features: [fc as GeoJSON.Feature<Geometry, GeoJsonProperties>] };
}

export interface SpreadsheetOptions {
  sheet?: string | number | undefined;
  headerRow?: number | undefined;
  maxRows: number;
  maxColumns: number;
}

function cellValue(v: unknown): unknown {
  if (!(v instanceof Date)) return v;
  if (Number.isNaN(+v)) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  // Spreadsheet dates have no time zone; keep the wall-clock value the user sees in the sheet.
  return v.getHours() || v.getMinutes() || v.getSeconds()
    ? `${date}T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
    : date;
}

function sheetRecords(
  ws: XLSX.WorkSheet,
  sheetName: string,
  opts: SpreadsheetOptions,
): Array<Record<string, unknown>> {
  const headerRow = opts.headerRow ?? 1;
  const full = ws["!fullref"] ?? ws["!ref"];
  if (full) {
    const total = XLSX.utils.decode_range(full).e.r + 1 - headerRow;
    if (total > opts.maxRows) {
      throw new D3McpError(
        "LIMIT_EXCEEDED",
        `Sheet "${sheetName}" has ${total} data rows; the configured limit is ${opts.maxRows}`,
        "Filter the sheet, or raise D3MCP_MAX_ROWS.",
      );
    }
  }
  // Keep blank rows so header_row matches the row number the user sees; drop them from the data afterwards.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  const header = grid[headerRow - 1];
  if (!header)
    throw new D3McpError("DATA_PARSE_ERROR", `Sheet "${sheetName}" has no header row ${headerRow}`);
  if (header.length > opts.maxColumns)
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Sheet "${sheetName}" has ${header.length} columns; limit is ${opts.maxColumns}`,
    );
  const seen = new Map<string, number>();
  const names = header.map((h, i) => {
    let n =
      h === null || h === undefined || String(h).trim() === ""
        ? `column_${i + 1}`
        : String(cellValue(h)).trim();
    const c = seen.get(n) ?? 0;
    seen.set(n, c + 1);
    if (c) n = `${n}_${c + 1}`;
    return n;
  });
  return grid
    .slice(headerRow)
    .filter((r) => r.some((v) => v !== null && v !== undefined && v !== ""))
    .map((r) => Object.fromEntries(names.map((n, i) => [n, cellValue(r[i] ?? null)])));
}

/** Read xlsx/xlsm/xlsb/xls/ods with SheetJS. Formulas yield their cached values; macros and external links are never evaluated. */
export function parseSpreadsheet(
  data: string | Uint8Array,
  opts: SpreadsheetOptions,
  transformations: string[],
  warnings: string[],
): { records: Array<Record<string, unknown>>; sheet: string; sheets: string[] } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, {
      type: typeof data === "string" ? "base64" : "array",
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
      dense: true,
      sheetRows: opts.maxRows + (opts.headerRow ?? 1) + 1,
    });
  } catch (e) {
    throw new D3McpError(
      "DATA_PARSE_ERROR",
      `Could not read spreadsheet: ${(e as Error).message}`,
      "Supported: xlsx, xlsm, xlsb, xls, ods, fods.",
    );
  }
  const sheets = wb.SheetNames;
  if (!sheets.length) throw new D3McpError("DATA_PARSE_ERROR", "Workbook has no sheets");
  const pick = (s: string | number): string => {
    if (typeof s === "number") {
      const n = sheets[s - 1];
      if (!n)
        throw new D3McpError(
          "INVALID_INPUT",
          `Sheet index ${s} out of range (1–${sheets.length})`,
          `Sheets: ${sheets.join(", ")}`,
        );
      return n;
    }
    const n = sheets.find((x) => x === s) ?? sheets.find((x) => x.toLowerCase() === s.toLowerCase());
    if (!n) throw new D3McpError("INVALID_INPUT", `Sheet "${s}" not found`, `Sheets: ${sheets.join(", ")}`);
    return n;
  };
  if (opts.sheet === "*" || opts.sheet === "all") {
    const records = sheets.flatMap((name) =>
      sheetRecords(wb.Sheets[name]!, name, opts).map((r) => ({ _sheet: name, ...r })),
    );
    if (records.length > opts.maxRows)
      throw new D3McpError(
        "LIMIT_EXCEEDED",
        `Workbook has ${records.length} rows across sheets; limit is ${opts.maxRows}`,
      );
    transformations.push(
      `Combined ${sheets.length} sheet(s) (${sheets.join(", ")}) into one table with a "_sheet" column.`,
    );
    return { records, sheet: "*", sheets };
  }
  const name = opts.sheet === undefined ? sheets[0]! : pick(opts.sheet);
  if (opts.sheet === undefined && sheets.length > 1) {
    warnings.push(
      `Workbook has ${sheets.length} sheets (${sheets.join(", ")}); used "${name}". Pass sheet to choose another, or sheet:"all" to combine them.`,
    );
  }
  const records = sheetRecords(wb.Sheets[name]!, name, opts);
  transformations.push(
    `Read sheet "${name}" (header row ${opts.headerRow ?? 1}); formulas use their cached values; dates converted to ISO text.`,
  );
  return { records, sheet: name, sheets };
}
