import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology } from "topojson-specification";
import { z } from "zod";
import type { Config } from "../../shared/config.js";
import { D3McpError } from "../../shared/errors.js";
import { FORBIDDEN_KEYS } from "../../shared/escape.js";
import {
  formatFromFilename,
  isSpreadsheet,
  parseDsvRows,
  parseJson,
  parseJsonLines,
  parseSpreadsheet,
  parseYaml,
  reshapeDocument,
  sniffDelimiter,
  SPREADSHEET_FORMATS,
  TEXT_FORMATS,
  topologyToGeo,
} from "./formats.js";
import type { Dataset, DatasetOrigin, DatasetSource, HierarchyDatum, Row, Scalar } from "./types.js";
import { looksNumeric } from "./values.js";

const RecordSchema = z.record(z.string(), z.unknown());
const SheetSchema = z
  .union([z.string().max(100), z.number().int().min(1).max(1000)])
  .describe(
    'Sheet name, 1-based index, or "all" to combine every sheet (adds a _sheet column). Default: first sheet',
  );
const ParseOptions = {
  delimiter: z
    .string()
    .max(2)
    .optional()
    .describe("Delimiter for csv/dsv (default: auto-detected from , ; tab |)"),
  records_path: z
    .string()
    .max(200)
    .optional()
    .describe('Dot path to the records inside a JSON/YAML document, e.g. "response.items"'),
  sheet: SheetSchema.optional(),
  header_row: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Spreadsheet header row (1-based, default 1)"),
  object: z.string().max(200).optional().describe("TopoJSON object name (default: first object)"),
};
const ANY_FORMAT = [...TEXT_FORMATS, ...SPREADSHEET_FORMATS] as const;

export const DataInputSchema = z
  .union([
    z.array(RecordSchema).describe('Array of flat records, e.g. [{"region":"EU","sales":10}]'),
    z
      .object({
        format: z.enum(TEXT_FORMATS),
        text: z
          .string()
          .describe(
            "Raw text: CSV/TSV/delimited with a header row, JSON, JSON Lines, YAML, GeoJSON or TopoJSON",
          ),
        ...ParseOptions,
      })
      .describe("Text data (csv, tsv, dsv, json, jsonl/ndjson, yaml/yml, geojson, topojson)"),
    z
      .object({
        base64: z.string().describe("Base64 file contents (spreadsheets or any text format)"),
        format: z.enum(ANY_FORMAT).optional(),
        filename: z.string().max(255).optional().describe("Used to infer the format from the extension"),
        ...ParseOptions,
      })
      .describe("Binary or encoded file contents, e.g. an .xlsx workbook"),
    z
      .object({
        file: z
          .string()
          .max(4096)
          .describe(
            "Path to a local file inside D3MCP_DATA_DIRS (absolute, ~/..., file:// or relative to the first data dir)",
          ),
        format: z.enum(ANY_FORMAT).optional().describe("Override the format inferred from the extension"),
        ...ParseOptions,
      })
      .describe(
        "Local file: .csv .tsv .txt .psv .json .jsonl .ndjson .yaml .yml .geojson .topojson .xlsx .xlsm .xlsb .xls .ods .fods",
      ),
    z
      .object({
        nodes: z.array(RecordSchema).describe("Nodes; each requires a unique 'id'"),
        links: z.array(RecordSchema).describe("Links with 'source' and 'target' node ids, optional 'value'"),
      })
      .describe("Graph / network data"),
    z
      .object({
        type: z.literal("FeatureCollection"),
        features: z.array(z.unknown()),
      })
      .describe("GeoJSON FeatureCollection"),
    z
      .object({ type: z.literal("Topology"), objects: RecordSchema, arcs: z.array(z.unknown()) })
      .passthrough()
      .describe("TopoJSON Topology"),
    z
      .object({
        format: z.literal("hierarchy"),
        root: RecordSchema.describe("Root node: {name, value?, children?: [...]}"),
      })
      .describe("Nested hierarchy"),
    z.object({ dataset_id: z.string().describe("Reference to a dataset stored by an earlier call") }),
  ])
  .describe(
    "Dataset: records array; text in csv/tsv/dsv/json/jsonl/yaml/geojson/topojson; base64 file contents (xlsx, xls, ods, …); a local file path; graph {nodes,links}; GeoJSON; TopoJSON; hierarchy; or dataset_id",
  );

export type DataInput = z.infer<typeof DataInputSchema>;

export type IngestLimits = Pick<
  Config,
  "maxRows" | "maxColumns" | "maxInputBytes" | "maxCellChars" | "maxHierarchyNodes" | "maxGeoFeatures"
>;

function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

const encoder = new TextEncoder();
function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

function checkKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new D3McpError("SECURITY_VIOLATION", `Field name "${key}" is not allowed`, "Rename the field.");
  }
}

function normalizeRecords(
  input: Array<Record<string, unknown>>,
  limits: IngestLimits,
  warnings: string[],
  transformations: string[],
  label = "records",
): Row[] {
  if (input.length > limits.maxRows) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Dataset has ${input.length} ${label}; the configured limit is ${limits.maxRows}`,
      "Pre-aggregate or sample the data, or raise D3MCP_MAX_ROWS.",
    );
  }
  const columns = new Set<string>();
  let nestedCount = 0;
  let truncated = 0;
  const rows: Row[] = input.map((rec, i) => {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      throw new D3McpError("INVALID_INPUT", `Record ${i} is not an object`);
    }
    const row: Row = {};
    for (const [k, v] of Object.entries(rec)) {
      checkKey(k);
      columns.add(k);
      let out: Scalar;
      if (v === null || v === undefined) out = null;
      else if (typeof v === "number") out = Number.isFinite(v) ? v : null;
      else if (typeof v === "string" || typeof v === "boolean") out = v;
      else {
        nestedCount++;
        out = JSON.stringify(v);
      }
      if (typeof out === "string" && out.length > limits.maxCellChars) {
        out = out.slice(0, limits.maxCellChars);
        truncated++;
      }
      row[k] = out;
    }
    return row;
  });
  if (columns.size > limits.maxColumns) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Dataset has ${columns.size} columns; limit is ${limits.maxColumns}`,
    );
  }
  if (nestedCount > 0) {
    transformations.push(`Serialized ${nestedCount} nested object/array value(s) to JSON strings.`);
  }
  if (truncated > 0) {
    warnings.push(`Truncated ${truncated} text value(s) longer than ${limits.maxCellChars} characters.`);
  }
  return rows;
}

function parseDelimited(text: string, delimiter: string, limits: IngestLimits, transformations: string[]) {
  const parsed = parseDsvRows(text, delimiter);
  const label =
    delimiter === "," ? "CSV" : delimiter === "\t" ? "TSV" : `${JSON.stringify(delimiter)}-delimited`;
  if (parsed.columns.length === 0 || (parsed.columns.length === 1 && parsed.columns[0] === "")) {
    throw new D3McpError("DATA_PARSE_ERROR", `No header row found in ${label} text`);
  }
  if (parsed.rows.length > limits.maxRows) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Dataset has ${parsed.rows.length} records; the configured limit is ${limits.maxRows}`,
      "Pre-aggregate or sample the data, or raise D3MCP_MAX_ROWS.",
    );
  }
  const columns = parsed.columns;
  const numericCols: string[] = [];
  const commaDecimalCols: string[] = [];
  const boolCols: string[] = [];
  const COMMA_DECIMAL = /^-?(\d{1,3}(\.\d{3})+|\d+),\d+$/;
  for (const col of columns) {
    checkKey(col);
    const vals = parsed.rows.map((r) => (r[col] ?? "").trim()).filter((v) => v !== "");
    if (vals.length === 0) continue;
    if (vals.every(looksNumeric)) numericCols.push(col);
    else if (
      delimiter !== "," &&
      vals.every((v) => looksNumeric(v) || COMMA_DECIMAL.test(v)) &&
      vals.some((v) => COMMA_DECIMAL.test(v))
    ) {
      commaDecimalCols.push(col);
    } else if (vals.every((v) => v === "true" || v === "false")) boolCols.push(col);
  }
  let empties = 0;
  const records = parsed.rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const raw = r[col];
      if (raw === undefined || raw.trim() === "") {
        out[col] = null;
        empties++;
      } else if (numericCols.includes(col)) out[col] = Number(raw.trim());
      else if (commaDecimalCols.includes(col)) {
        const t = raw.trim();
        out[col] = COMMA_DECIMAL.test(t) ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
      } else if (boolCols.includes(col)) out[col] = raw.trim() === "true";
      else out[col] = raw;
    }
    return out;
  });
  if (numericCols.length) {
    transformations.push(`Parsed numeric text to numbers in column(s): ${numericCols.join(", ")}.`);
  }
  if (commaDecimalCols.length) {
    transformations.push(
      `Parsed decimal-comma numbers (e.g. "1.234,5" → 1234.5) in column(s): ${commaDecimalCols.join(", ")}.`,
    );
  }
  if (boolCols.length)
    transformations.push(`Parsed "true"/"false" text to booleans in: ${boolCols.join(", ")}.`);
  if (empties)
    transformations.push(`Treated ${empties} empty cell(s) as missing (null); no imputation applied.`);
  return normalizeRecords(records, limits, [], transformations);
}

function ingestHierarchy(
  root: Record<string, unknown>,
  limits: IngestLimits,
): { rows: Row[]; root: HierarchyDatum } {
  const rows: Row[] = [];
  const stack: Array<{ node: Record<string, unknown>; depth: number; parent: string | null; path: string }> =
    [{ node: root, depth: 0, parent: null, path: "" }];
  let count = 0;
  while (stack.length) {
    const { node, depth, parent, path } = stack.pop()!;
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      throw new D3McpError("INVALID_INPUT", `Hierarchy node at "${path || "root"}" is not an object`);
    }
    if (++count > limits.maxHierarchyNodes) {
      throw new D3McpError("LIMIT_EXCEEDED", `Hierarchy exceeds ${limits.maxHierarchyNodes} nodes`);
    }
    if (depth > 64) throw new D3McpError("LIMIT_EXCEEDED", "Hierarchy deeper than 64 levels");
    for (const k of Object.keys(node)) checkKey(k);
    const name = String(node.name ?? node.id ?? `node${count}`);
    const id = path ? `${path}/${name}` : name;
    const value = typeof node.value === "number" && Number.isFinite(node.value) ? node.value : null;
    const children = node.children;
    if (children !== undefined && !Array.isArray(children)) {
      throw new D3McpError("INVALID_INPUT", `"children" of "${id}" must be an array`);
    }
    rows.push({ id, name, parent, depth, value, leaf: !children || children.length === 0 });
    if (Array.isArray(children)) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i] as Record<string, unknown>, depth: depth + 1, parent: id, path: id });
      }
    }
  }
  return { rows, root: JSON.parse(JSON.stringify(root)) as HierarchyDatum };
}

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function countCoords(c: unknown, depth = 0): number {
  if (depth > 6) throw new D3McpError("INVALID_INPUT", "GeoJSON coordinates nested too deeply");
  if (!Array.isArray(c)) return 0;
  if (c.length >= 2 && typeof c[0] === "number") {
    if (!c.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new D3McpError("INVALID_INPUT", "GeoJSON coordinates must be finite numbers");
    }
    return 1;
  }
  return c.reduce((s: number, x) => s + countCoords(x, depth + 1), 0);
}

function ingestGeo(fc: { features: unknown[] }, limits: IngestLimits, transformations: string[]) {
  if (fc.features.length > limits.maxGeoFeatures) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `GeoJSON has ${fc.features.length} features; limit is ${limits.maxGeoFeatures}`,
    );
  }
  let coords = 0;
  const features: Feature[] = fc.features.map((f, i) => {
    const feat = f as Partial<Feature> & {
      geometry?: Partial<Geometry> & { coordinates?: unknown; geometries?: unknown[] };
    };
    if (!feat || feat.type !== "Feature")
      throw new D3McpError("INVALID_INPUT", `features[${i}] is not a GeoJSON Feature`);
    if (feat.geometry !== null && feat.geometry !== undefined) {
      if (!GEOMETRY_TYPES.has(String(feat.geometry.type))) {
        throw new D3McpError(
          "INVALID_INPUT",
          `features[${i}] has unsupported geometry type ${String(feat.geometry.type)}`,
        );
      }
      coords += countCoords(feat.geometry.coordinates);
      if (feat.geometry.geometries)
        for (const g of feat.geometry.geometries)
          coords += countCoords((g as { coordinates?: unknown }).coordinates);
    }
    return feat as Feature;
  });
  if (coords > 2_000_000)
    throw new D3McpError("LIMIT_EXCEEDED", `GeoJSON has ${coords} coordinates; limit is 2,000,000`);
  const props = features.map((f, i) => ({ _index: i, ...(f.properties ?? {}) }));
  const rows = normalizeRecords(props, limits, [], transformations, "features");
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: JSON.parse(JSON.stringify(features)),
  };
  return { rows, geojson };
}

function ingestGraph(
  input: { nodes: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> },
  limits: IngestLimits,
  warnings: string[],
  transformations: string[],
) {
  const linksIn = input.links.map((l) => {
    const out: Record<string, unknown> = { ...l };
    for (const end of ["source", "target"] as const) {
      const v = l[end];
      if (v && typeof v === "object" && "id" in (v as object)) out[end] = (v as { id: unknown }).id;
    }
    return out;
  });
  const nodes = normalizeRecords(input.nodes, limits, warnings, transformations, "nodes");
  const links = normalizeRecords(linksIn, limits, warnings, transformations, "links");
  const ids = new Set<string>();
  nodes.forEach((n, i) => {
    if (n.id === null || n.id === undefined)
      throw new D3McpError("INVALID_INPUT", `nodes[${i}] is missing "id"`);
    const key = String(n.id);
    if (ids.has(key)) throw new D3McpError("INVALID_INPUT", `Duplicate node id "${key}"`);
    ids.add(key);
  });
  const missing = new Set<string>();
  links.forEach((l, i) => {
    if (l.source === null || l.target === null || l.source === undefined || l.target === undefined) {
      throw new D3McpError("INVALID_INPUT", `links[${i}] requires "source" and "target"`);
    }
    if (!ids.has(String(l.source))) missing.add(String(l.source));
    if (!ids.has(String(l.target))) missing.add(String(l.target));
  });
  if (missing.size) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Links reference ${missing.size} unknown node id(s): ${[...missing].slice(0, 5).join(", ")}`,
      "Add the missing nodes or remove the links; links are never dropped silently.",
    );
  }
  return { nodes, links };
}

function isHierarchyLike(v: unknown): v is Record<string, unknown> {
  return (
    !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { children?: unknown }).children)
  );
}

/** Ingest any supported data input into a normalized Dataset. Dataset references are resolved by the caller. */
export function ingest(input: unknown, limits: IngestLimits): Dataset {
  const warnings: string[] = [];
  const transformations: string[] = [];
  const make = (
    source: DatasetSource,
    kind: Dataset["kind"],
    rows: Row[],
    extra: Partial<Dataset> = {},
  ): Dataset => ({
    id: newId("ds"),
    kind,
    source,
    rows,
    warnings,
    transformations,
    ...extra,
  });

  const isEncoded =
    !!input &&
    typeof input === "object" &&
    (typeof (input as { text?: unknown }).text === "string" ||
      typeof (input as { base64?: unknown }).base64 === "string");
  if (
    !isEncoded &&
    input &&
    typeof input === "object" &&
    utf8Bytes(JSON.stringify(input)) > limits.maxInputBytes
  ) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Input data exceeds ${limits.maxInputBytes} bytes`,
      "Aggregate or sample the data, or raise D3MCP_MAX_INPUT_BYTES.",
    );
  }
  if (Array.isArray(input)) {
    return make(
      "records",
      "table",
      normalizeRecords(input as Array<Record<string, unknown>>, limits, warnings, transformations),
    );
  }
  if (!input || typeof input !== "object") {
    throw new D3McpError("INVALID_INPUT", "Data must be an array of records or a supported data object");
  }
  const obj = input as Record<string, unknown>;
  const opts = {
    delimiter: typeof obj.delimiter === "string" ? obj.delimiter : undefined,
    recordsPath: typeof obj.records_path === "string" ? obj.records_path : undefined,
    sheet: typeof obj.sheet === "string" || typeof obj.sheet === "number" ? obj.sheet : undefined,
    headerRow: typeof obj.header_row === "number" ? obj.header_row : undefined,
    object: typeof obj.object === "string" ? obj.object : undefined,
  };
  const origin = (o: Partial<DatasetOrigin> & { format: string }): DatasetOrigin => ({
    ...(typeof obj.filename === "string" ? { file: obj.filename } : {}),
    ...o,
  });
  // Parse a JSON/YAML document and ingest whatever shape it has, keeping this call's notes.
  const document = (doc: unknown, source: DatasetSource, format: string): Dataset => {
    const shaped = reshapeDocument(doc, opts.recordsPath, transformations);
    if (shaped && typeof shaped === "object" && (shaped as { type?: unknown }).type === "Topology") {
      const fc = topologyToGeo(shaped as Topology, opts.object, transformations);
      const { rows, geojson } = ingestGeo(fc, limits, transformations);
      return make("topojson", "geo", rows, { geojson, origin: origin({ format }) });
    }
    if (!shaped || typeof shaped !== "object") {
      throw new D3McpError(
        "INVALID_INPUT",
        `The ${format.toUpperCase()} document contains no records (got ${shaped === null ? "null" : typeof shaped})`,
        "Provide a list of objects, or set records_path.",
      );
    }
    const inner = ingest(shaped, limits);
    return {
      ...inner,
      source: inner.source === "records" ? source : inner.source,
      warnings: [...warnings, ...inner.warnings],
      transformations: [...transformations, ...inner.transformations],
      origin: origin({ format }),
    };
  };

  if (typeof obj.file === "string") {
    throw new D3McpError("INVALID_INPUT", "File inputs must be resolved by the server before ingestion");
  }
  let format = typeof obj.format === "string" ? obj.format.toLowerCase() : undefined;
  let text: string | undefined = typeof obj.text === "string" ? obj.text : undefined;
  if (typeof obj.base64 === "string") {
    format ??= typeof obj.filename === "string" ? (formatFromFilename(obj.filename) ?? undefined) : undefined;
    if (!format) {
      throw new D3McpError(
        "INVALID_INPUT",
        "Cannot tell the format of base64 data",
        "Set format (e.g. xlsx, csv) or a filename with an extension.",
      );
    }
    const b64 = obj.base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))
      throw new D3McpError("DATA_PARSE_ERROR", "base64 contains invalid characters");
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > limits.maxInputBytes) {
      throw new D3McpError(
        "LIMIT_EXCEEDED",
        `File contents (${bytes} bytes) exceed ${limits.maxInputBytes} bytes`,
        "Raise D3MCP_MAX_INPUT_BYTES or reduce the file.",
      );
    }
    if (isSpreadsheet(format)) {
      const sheet = parseSpreadsheet(
        b64,
        {
          sheet: opts.sheet,
          headerRow: opts.headerRow,
          maxRows: limits.maxRows,
          maxColumns: limits.maxColumns,
        },
        transformations,
        warnings,
      );
      return make(
        "spreadsheet",
        "table",
        normalizeRecords(sheet.records, limits, warnings, transformations),
        {
          origin: origin({ format, sheet: sheet.sheet, sheets: sheet.sheets }),
        },
      );
    }
    text = new TextDecoder("utf-8").decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }
  if (text !== undefined && format !== undefined) {
    if (utf8Bytes(text) > limits.maxInputBytes) {
      throw new D3McpError("LIMIT_EXCEEDED", `Input text exceeds ${limits.maxInputBytes} bytes`);
    }
    switch (format) {
      case "csv":
      case "dsv": {
        const delimiter = opts.delimiter ?? sniffDelimiter(text);
        if (!opts.delimiter && delimiter !== ",")
          transformations.push(`Detected ${JSON.stringify(delimiter)} as the delimiter.`);
        const source = delimiter === "," ? "csv" : "dsv";
        return make(source, "table", parseDelimited(text, delimiter, limits, transformations), {
          origin: origin({ format, delimiter }),
        });
      }
      case "tsv":
        return make("tsv", "table", parseDelimited(text, opts.delimiter ?? "\t", limits, transformations), {
          origin: origin({ format }),
        });
      case "json":
      case "geojson":
      case "topojson":
        return document(parseJson(text), "json", format);
      case "jsonl":
      case "ndjson": {
        const records = parseJsonLines(text, limits.maxRows);
        return make("jsonl", "table", normalizeRecords(records, limits, warnings, transformations), {
          origin: origin({ format }),
        });
      }
      case "yaml":
      case "yml":
        return document(parseYaml(text), "yaml", "yaml");
      default:
        if (isSpreadsheet(format)) {
          throw new D3McpError(
            "INVALID_INPUT",
            `${format} is a binary format; pass it as base64 or as a file path, not as text`,
          );
        }
    }
  }
  if (obj.type === "Topology" && obj.objects && typeof obj.objects === "object") {
    const fc = topologyToGeo(obj as unknown as Topology, opts.object, transformations);
    const { rows, geojson } = ingestGeo(fc, limits, transformations);
    return make("topojson", "geo", rows, { geojson });
  }
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) {
    const { nodes, links } = ingestGraph(obj as never, limits, warnings, transformations);
    return make("graph", "graph", nodes, { links });
  }
  if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
    const { rows, geojson } = ingestGeo(obj as { features: unknown[] }, limits, transformations);
    return make("geojson", "geo", rows, { geojson });
  }
  if (obj.format === "hierarchy" || isHierarchyLike(obj)) {
    const root = (obj.format === "hierarchy" ? obj.root : obj) as Record<string, unknown>;
    const { rows, root: h } = ingestHierarchy(root, limits);
    return make("hierarchy", "hierarchy", rows, { hierarchy: h });
  }
  throw new D3McpError(
    "INVALID_INPUT",
    "Unrecognized data shape",
    "Provide an array of records, {format, text} (csv, tsv, dsv, json, jsonl, yaml, geojson, topojson), {base64, format|filename} for spreadsheets, {file}, {nodes, links}, a GeoJSON FeatureCollection, a TopoJSON Topology, or {format:'hierarchy', root}.",
  );
}
