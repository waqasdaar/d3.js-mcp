import * as d3 from "d3";
import type { GeoProjection } from "d3";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import { D3McpError } from "../../shared/errors.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import { colorEncoder, decorate, drawLegend, encType, field, fmtValue, tooltipFor } from "../svg/helpers.js";

export const PROJECTIONS: Record<string, () => GeoProjection> = {
  mercator: d3.geoMercator,
  equirectangular: d3.geoEquirectangular,
  naturalEarth1: d3.geoNaturalEarth1,
  albers: d3.geoAlbers,
  albersUsa: d3.geoAlbersUsa as unknown as () => GeoProjection,
  orthographic: d3.geoOrthographic,
  equalEarth: d3.geoEqualEarth,
  conicEqualArea: d3.geoConicEqualArea,
  transverseMercator: d3.geoTransverseMercator,
  azimuthalEqualArea: d3.geoAzimuthalEqualArea,
  stereographic: d3.geoStereographic,
  gnomonic: d3.geoGnomonic,
};

function reverseRings(g: Geometry): Geometry {
  if (g.type === "Polygon")
    return { ...g, coordinates: g.coordinates.map((r: Position[]) => [...r].reverse()) };
  if (g.type === "MultiPolygon")
    return { ...g, coordinates: g.coordinates.map((p: Position[][]) => p.map((r) => [...r].reverse())) };
  return g;
}

/** d3-geo uses spherical winding (clockwise exteriors). Rewind RFC 7946 polygons that would otherwise cover the globe. */
export function fixWinding(fc: FeatureCollection): { fc: FeatureCollection; rewound: number } {
  let rewound = 0;
  const features = fc.features.map((f) => {
    if (!f.geometry || (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")) return f;
    if (d3.geoArea(f) > 2 * Math.PI) {
      rewound++;
      return { ...f, geometry: reverseRings(f.geometry) } as Feature;
    }
    return f;
  });
  return { fc: { type: "FeatureCollection", features }, rewound };
}

function renderGeo(ctx: RenderContext): RenderResult {
  const ds = ctx.dataset;
  const projName = ctx.spec.options.projection ?? (ds.kind === "geo" ? "equalEarth" : "naturalEarth1");
  const projection = PROJECTIONS[projName]!();
  const latF = field(ctx, "latitude") ?? field(ctx, "y");
  const lonF = field(ctx, "longitude") ?? field(ctx, "x");
  const g = ctx.plot.append("g").attr("class", "marks geo");
  let markCount: number;
  let markSelector = "path.feature";
  const meta: Record<string, unknown> = { projection: projName };
  if (ds.kind === "geo" && ds.geojson) {
    const { fc, rewound } = fixWinding(ds.geojson);
    if (rewound)
      ctx.warnings.push(
        `Rewound ${rewound} polygon(s) whose ring orientation would otherwise cover the whole sphere (RFC 7946 vs d3-geo winding).`,
      );
    projection.fitSize([ctx.innerWidth, ctx.innerHeight], fc);
    const path = d3.geoPath(projection).pointRadius(4);
    if (ctx.spec.options.graticule) {
      g.append("path")
        .attr("class", "graticule")
        .attr("fill", "none")
        .attr("stroke", ctx.theme.grid)
        .attr("d", path(d3.geoGraticule10()));
    }
    const cf = field(ctx, "color");
    const rowsByIndex = new Map<number, Row>(ctx.rows.map((r) => [Number(r._index), r]));
    const color = cf
      ? colorEncoder(
          ctx,
          ctx.rows.map((r) => r[cf] ?? null),
          encType(ctx, "color"),
        )
      : null;
    const items = fc.features.map((f, i) => ({ f, row: rowsByIndex.get(i) })).filter((d) => d.row);
    const lf = field(ctx, "label") ?? (ctx.rows[0] && "name" in ctx.rows[0] ? "name" : undefined);
    const paths = g
      .selectAll("path.feature")
      .data(items)
      .join("path")
      .attr("class", "feature")
      .attr("d", (d) => path(d.f) ?? "")
      .attr("fill", (d) =>
        color && cf
          ? color.color(d.row![cf] ?? null)
          : d.f.geometry?.type.includes("Point")
            ? ctx.theme.accent
            : ctx.theme.grid,
      )
      .attr("stroke", ctx.theme.background)
      .attr("stroke-width", 0.6);
    decorate(paths, (d) => ({
      tooltip:
        tooltipFor(ctx, d.row!, [
          ...(lf ? ([[lf, d.row![lf] ?? null]] as const) : []),
          ...(cf ? ([[cf, d.row![cf] ?? null]] as const) : []),
        ]) || `feature ${d.row!._index}`,
      key: lf ? toLabel(d.row![lf] ?? null) : String(d.row!._index),
      label: lf ? toLabel(d.row![lf] ?? null) : undefined,
    }));
    markCount = items.length;
    meta.features = items.length;
    meta.bounds = path.bounds(fc);
    if (color) {
      drawLegend(ctx, color, cf!);
      meta.choropleth = cf;
    }
  } else {
    if (!latF || !lonF) {
      throw new D3McpError(
        "INCOMPATIBLE_DATA",
        "Geographic map requires GeoJSON data or encoding.latitude and encoding.longitude",
        "Provide a FeatureCollection or table rows with lat/lon fields.",
      );
    }
    const pts = ctx.rows
      .map((r) => ({ r, lon: toNumber(r[lonF] ?? null), lat: toNumber(r[latF] ?? null) }))
      .filter(
        (p): p is { r: Row; lon: number; lat: number } =>
          p.lon !== null && p.lat !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180,
      );
    if (pts.length < ctx.rows.length)
      ctx.warnings.push(
        `${ctx.rows.length - pts.length} row(s) with missing/out-of-range coordinates not plotted.`,
      );
    const mp: d3.GeoPermissibleObjects = { type: "MultiPoint", coordinates: pts.map((p) => [p.lon, p.lat]) };
    if (projName === "naturalEarth1" || projName === "equalEarth" || projName === "equirectangular")
      projection.fitSize([ctx.innerWidth, ctx.innerHeight], { type: "Sphere" });
    else projection.fitSize([ctx.innerWidth, ctx.innerHeight], mp);
    const path = d3.geoPath(projection);
    g.append("path")
      .attr("class", "sphere")
      .attr("fill", ctx.theme.name === "dark" ? "#161b22" : "#f6f8fa")
      .attr("stroke", ctx.theme.grid)
      .attr("d", path({ type: "Sphere" }) ?? "");
    g.append("path")
      .attr("class", "graticule")
      .attr("fill", "none")
      .attr("stroke", ctx.theme.grid)
      .attr("d", path(d3.geoGraticule10()) ?? "");
    const cf = field(ctx, "color");
    const sf = field(ctx, "size");
    const color = cf
      ? colorEncoder(
          ctx,
          pts.map((p) => p.r[cf] ?? null),
          encType(ctx, "color"),
        )
      : null;
    const rs = sf
      ? d3
          .scaleSqrt()
          .domain([0, d3.max(pts, (p) => toNumber(p.r[sf] ?? null) ?? 0) ?? 1])
          .range([2, 18])
      : null;
    const circles = g
      .selectAll("circle")
      .data(pts.filter((p) => projection([p.lon, p.lat]) !== null))
      .join("circle")
      .attr("class", "geo-point")
      .attr("cx", (p) => projection([p.lon, p.lat])![0])
      .attr("cy", (p) => projection([p.lon, p.lat])![1])
      .attr("r", (p) => (rs ? rs(Math.max(0, toNumber(p.r[sf!] ?? null) ?? 0)) : 4))
      .attr("fill", (p) => (color ? color.color(p.r[cf!] ?? null) : ctx.theme.accent))
      .attr("fill-opacity", 0.75)
      .attr("stroke", ctx.theme.stroke);
    const lf = field(ctx, "label");
    decorate(circles, (p) => ({
      tooltip: tooltipFor(ctx, p.r, [
        ...(lf ? ([[lf, p.r[lf] ?? null]] as const) : []),
        [latF, p.lat],
        [lonF, p.lon],
        ...(sf ? ([[sf, p.r[sf] ?? null]] as const) : []),
      ]),
      key: lf ? toLabel(p.r[lf] ?? null) : `${p.lat},${p.lon}`,
      label: lf ? toLabel(p.r[lf] ?? null) : undefined,
    }));
    markCount = circles.size();
    markSelector = "circle.geo-point";
    meta.points = markCount;
    meta.distanceNote =
      pts.length >= 2
        ? `Great-circle distance between first two points: ${fmtValue(d3.geoDistance([pts[0]!.lon, pts[0]!.lat], [pts[1]!.lon, pts[1]!.lat]) * 6371)} km`
        : undefined;
    if (color) drawLegend(ctx, color, cf!);
  }
  return { markCount, markSelector, meta };
}

export const geoRenderers: RendererPlugin[] = [
  {
    type: "geo",
    family: "geo",
    label: "Geographic map / choropleth",
    description:
      "Projects GeoJSON features (choropleth with encoding.color) or lat/lon points using core d3-geo projections.",
    core: true,
    dataKinds: ["geo", "table"],
    requiredChannels: [],
    usesLegend: true,
    d3Apis: [
      "geoPath",
      "path.pointRadius",
      "path.bounds",
      "projection.fitSize",
      "geoArea",
      "geoDistance",
      "geoGraticule10",
      "geoMercator",
      "geoEquirectangular",
      "geoNaturalEarth1",
      "geoAlbers",
      "geoAlbersUsa",
      "geoOrthographic",
      "geoEqualEarth",
      "geoConicEqualArea",
      "geoTransverseMercator",
      "geoAzimuthalEqualArea",
      "geoStereographic",
      "geoGnomonic",
      "scaleSqrt",
    ],
    render: renderGeo,
  },
];
