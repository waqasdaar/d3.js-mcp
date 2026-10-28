import type { FeatureCollection } from "geojson";

export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;

export interface HierarchyDatum {
  name?: string;
  id?: string | number;
  value?: number;
  children?: HierarchyDatum[];
  [key: string]: unknown;
}

export type DatasetKind = "table" | "graph" | "hierarchy" | "geo";
export type DatasetSource =
  | "records"
  | "csv"
  | "tsv"
  | "dsv"
  | "json"
  | "jsonl"
  | "yaml"
  | "spreadsheet"
  | "graph"
  | "hierarchy"
  | "geojson"
  | "topojson";

export interface DatasetOrigin {
  format: string;
  file?: string;
  sheet?: string;
  sheets?: string[];
  delimiter?: string;
}

export interface Dataset {
  id: string;
  kind: DatasetKind;
  source: DatasetSource;
  /** Table rows, graph nodes, flattened hierarchy nodes, or GeoJSON feature properties. */
  rows: Row[];
  links?: Row[];
  hierarchy?: HierarchyDatum;
  geojson?: FeatureCollection;
  origin?: DatasetOrigin;
  warnings: string[];
  /** Material transformations applied during ingestion (documented, never silent). */
  transformations: string[];
}

export type FieldType =
  "quantitative" | "temporal" | "nominal" | "ordinal" | "boolean" | "identifier" | "mixed";
