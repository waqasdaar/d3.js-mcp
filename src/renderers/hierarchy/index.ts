import * as d3 from "d3";
import type { HierarchyNode, HierarchyRectangularNode } from "d3";
import type { HierarchyDatum, Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import { D3McpError } from "../../shared/errors.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import { checkMarkLimit, colorEncoder, decorate, field, fmtValue, textWidth } from "../svg/helpers.js";

type Datum = HierarchyDatum | Row | [string, unknown];

function nameOf(d: Datum): string {
  if (Array.isArray(d)) return toLabel(d[0] as string);
  const o = d as Record<string, unknown>;
  return toLabel((o.name ?? o.id ?? o.label ?? "") as string);
}

export function buildHierarchy(ctx: RenderContext): HierarchyNode<Datum> {
  const ds = ctx.dataset;
  const valueField = field(ctx, "value") ?? field(ctx, "size") ?? "value";
  let root: HierarchyNode<Datum>;
  if (ds.kind === "hierarchy" && ds.hierarchy) {
    root = d3.hierarchy<Datum>(ds.hierarchy, (d) =>
      Array.isArray(d) ? undefined : ((d as HierarchyDatum).children as Datum[] | undefined),
    );
  } else if (field(ctx, "id") && field(ctx, "parent")) {
    const idf = field(ctx, "id")!;
    const pf = field(ctx, "parent")!;
    try {
      root = d3
        .stratify<Row>()
        .id((r) => toLabel(r[idf] ?? null))
        .parentId((r) => (r[pf] === null || r[pf] === undefined || r[pf] === "" ? null : toLabel(r[pf])))(
        ctx.rows,
      ) as unknown as HierarchyNode<Datum>;
    } catch (e) {
      throw new D3McpError(
        "INVALID_INPUT",
        `Could not build hierarchy with d3.stratify: ${(e as Error).message}`,
        "Ensure exactly one root (empty parent) and that every parent id exists.",
      );
    }
  } else {
    const levels = [
      field(ctx, "group"),
      field(ctx, "series"),
      field(ctx, "color"),
      field(ctx, "label"),
      field(ctx, "x"),
    ].filter((f, i, a): f is string => !!f && a.indexOf(f) === i);
    if (!levels.length) {
      throw new D3McpError(
        "INCOMPATIBLE_DATA",
        `"${ctx.spec.type}" needs hierarchical data`,
        "Provide nested {name, children} data, or table data with encoding.id + encoding.parent, or encoding.group (+ series/label) fields to nest by.",
      );
    }
    const keyFns = levels.map((f) => (r: Row) => toLabel(r[f] ?? null));
    const grouped = (d3.group as (data: Row[], ...keys: Array<(r: Row) => string>) => Map<string, unknown>)(
      ctx.rows,
      ...keyFns,
    );
    root = d3.hierarchy<Datum>(["root", grouped], (d) => {
      if (!Array.isArray(d)) return undefined;
      const v = d[1];
      if (v instanceof Map) return [...v.entries()] as Datum[];
      if (Array.isArray(v)) return v as Datum[];
      return undefined;
    });
    ctx.warnings.push(`Hierarchy built by nesting rows on: ${levels.join(" → ")}.`);
  }
  const leafValue = (d: Datum): number => {
    if (Array.isArray(d)) return 0;
    return toNumber(((d as Record<string, unknown>)[valueField] ?? null) as number | null) ?? 0;
  };
  root.sum((d) => (Array.isArray(d) ? 0 : leafValue(d)));
  if (!root.value) {
    root.count();
    ctx.warnings.push(
      `No numeric "${valueField}" values found; node sizes use leaf counts (d3 hierarchy.count).`,
    );
  }
  root.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  checkMarkLimit(ctx, root.descendants().length, "hierarchy nodes");
  return root;
}

function pathOf(n: HierarchyNode<Datum>): string {
  return n
    .ancestors()
    .reverse()
    .slice(1)
    .map((a) => nameOf(a.data))
    .join(" / ");
}

function topColor(ctx: RenderContext, root: HierarchyNode<Datum>) {
  const tops = (root.children ?? [root]).map((c) => nameOf(c.data));
  const color = colorEncoder(ctx, tops, "nominal");
  return (n: HierarchyNode<Datum>) => {
    const top = n.ancestors().reverse()[1] ?? n;
    return color.color(nameOf(top.data));
  };
}

function tooltip(n: HierarchyNode<Datum>): string {
  return `${pathOf(n) || nameOf(n.data)}\nvalue: ${fmtValue(n.value ?? 0)}\ndepth: ${n.depth}${n.children ? `\nchildren: ${n.children.length}` : ""}`;
}

function renderTreemap(ctx: RenderContext, partition: boolean): RenderResult {
  const root = buildHierarchy(ctx);
  const tileName = ctx.spec.options.tile ?? "squarify";
  const tiles = {
    squarify: d3.treemapSquarify,
    binary: d3.treemapBinary,
    slice: d3.treemapSlice,
    dice: d3.treemapDice,
    sliceDice: d3.treemapSliceDice,
    resquarify: d3.treemapResquarify,
  } as const;
  let laid: HierarchyRectangularNode<Datum>;
  if (partition) laid = d3.partition<Datum>().size([ctx.innerHeight, ctx.innerWidth]).padding(1)(root);
  else
    laid = d3
      .treemap<Datum>()
      .tile(tiles[tileName])
      .size([ctx.innerWidth, ctx.innerHeight])
      .paddingInner(1)
      .paddingOuter(2)
      .round(true)(root);
  const colorOf = topColor(ctx, root);
  const nodes = partition ? laid.descendants().filter((d) => d.depth > 0) : laid.leaves();
  const g = ctx.plot.append("g").attr("class", "marks cells");
  const cell = g
    .selectAll("g.node")
    .data(nodes)
    .join("g")
    .attr("class", "node")
    .attr("transform", (d) => (partition ? `translate(${d.y0},${d.x0})` : `translate(${d.x0},${d.y0})`));
  const w = (d: HierarchyRectangularNode<Datum>) => (partition ? d.y1 - d.y0 : d.x1 - d.x0);
  const h = (d: HierarchyRectangularNode<Datum>) => (partition ? d.x1 - d.x0 : d.y1 - d.y0);
  const rects = cell
    .append("rect")
    .attr("class", partition ? "partition-cell" : "treemap-cell")
    .attr("width", (d) => Math.max(0, w(d)))
    .attr("height", (d) => Math.max(0, h(d)))
    .attr("fill", (d) => colorOf(d))
    .attr("fill-opacity", (d) => (partition ? 1 - d.depth * 0.12 : 0.85));
  decorate(rects, (d) => ({
    tooltip: tooltip(d),
    key: pathOf(d),
    cat: nameOf((d.ancestors().reverse()[1] ?? d).data),
    label: nameOf(d.data),
  }));
  cell
    .filter((d) => w(d) > 40 && h(d) > 16)
    .append("text")
    .attr("x", 4)
    .attr("y", 13)
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 11)
    .attr("fill", "#fff")
    .text((d) => {
      const name = nameOf(d.data);
      const max = Math.floor((w(d) - 8) / 6.6);
      return name.length > max ? name.slice(0, Math.max(1, max - 1)) + "…" : name;
    });
  return {
    markCount: nodes.length,
    markSelector: partition ? "rect.partition-cell" : "rect.treemap-cell",
    meta: {
      nodes: root.descendants().length,
      leaves: root.leaves().length,
      tile: partition ? undefined : tileName,
    },
  };
}

function renderSunburst(ctx: RenderContext): RenderResult {
  const root = buildHierarchy(ctx);
  const radius = Math.min(ctx.innerWidth, ctx.innerHeight) / 2;
  const laid = d3.partition<Datum>().size([2 * Math.PI, radius])(root);
  const colorOf = topColor(ctx, root);
  const inner = ctx.spec.options.innerRadius ?? 0;
  const arc = d3
    .arc<HierarchyRectangularNode<Datum>>()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.004))
    .innerRadius((d) => Math.max(d.y0, inner * radius))
    .outerRadius((d) => d.y1 - 1);
  const nodes = laid.descendants().filter((d) => d.depth > 0 && d.x1 - d.x0 > 0.0005);
  const g = ctx.plot
    .append("g")
    .attr("class", "marks arcs")
    .attr("transform", `translate(${ctx.innerWidth / 2},${ctx.innerHeight / 2})`);
  const paths = g
    .selectAll("path")
    .data(nodes)
    .join("path")
    .attr("class", "sunburst-arc")
    .attr("fill", (d) => colorOf(d))
    .attr("fill-opacity", (d) => Math.max(0.35, 1 - (d.depth - 1) * 0.18))
    .attr("d", arc);
  decorate(paths, (d) => ({
    tooltip: tooltip(d),
    key: pathOf(d),
    cat: nameOf((d.ancestors().reverse()[1] ?? d).data),
    label: nameOf(d.data),
  }));
  g.append("g")
    .attr("class", "labels")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 10)
    .attr("text-anchor", "middle")
    .attr("fill", "#fff")
    .selectAll("text")
    .data(nodes.filter((d) => ((d.y0 + d.y1) / 2) * (d.x1 - d.x0) > 30 && d.y1 - d.y0 > 20))
    .join("text")
    .attr("transform", (d) => {
      const x = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
      const y = (d.y0 + d.y1) / 2;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    })
    .attr("dy", "0.35em")
    .text((d) => {
      const n = nameOf(d.data);
      return n.length > 12 ? n.slice(0, 11) + "…" : n;
    });
  return { markCount: nodes.length, markSelector: "path.sunburst-arc", meta: { nodes: nodes.length } };
}

function renderPack(ctx: RenderContext): RenderResult {
  const root = buildHierarchy(ctx);
  const size = Math.min(ctx.innerWidth, ctx.innerHeight);
  const laid = d3.pack<Datum>().size([size, size]).padding(3)(root);
  const colorOf = topColor(ctx, root);
  const nodes = laid.descendants();
  const g = ctx.plot
    .append("g")
    .attr("class", "marks circles")
    .attr("transform", `translate(${(ctx.innerWidth - size) / 2},${(ctx.innerHeight - size) / 2})`);
  const circles = g
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("class", (d) => (d.children ? "pack-node pack-parent" : "pack-node pack-leaf"))
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", (d) => d.r)
    .attr("fill", (d) => (d.depth === 0 ? ctx.theme.grid : colorOf(d)))
    .attr("fill-opacity", (d) => (d.children ? 0.25 : 0.85))
    .attr("stroke", (d) => (d.children ? ctx.theme.muted : "none"));
  decorate(circles, (d) => ({
    tooltip: tooltip(d),
    key: pathOf(d) || "root",
    cat: nameOf((d.ancestors().reverse()[1] ?? d).data),
    label: nameOf(d.data),
  }));
  g.append("g")
    .attr("class", "labels")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 10)
    .attr("text-anchor", "middle")
    .attr("fill", ctx.theme.foreground)
    .selectAll("text")
    .data(nodes.filter((d) => !d.children && d.r > textWidth(nameOf(d.data), 10) / 2 + 2))
    .join("text")
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("dy", "0.35em")
    .text((d) => nameOf(d.data));
  return { markCount: nodes.length, markSelector: "circle.pack-node", meta: { nodes: nodes.length } };
}

function renderTree(ctx: RenderContext, cluster: boolean): RenderResult {
  const root = buildHierarchy(ctx);
  const radial = ctx.spec.options.radial === true;
  const layout = cluster ? d3.cluster<Datum>() : d3.tree<Datum>();
  const g = ctx.plot.append("g").attr("class", "marks tree");
  let laid: d3.HierarchyPointNode<Datum>;
  let linkPath: (l: d3.HierarchyPointLink<Datum>) => string | null;
  let nodePos: (d: d3.HierarchyPointNode<Datum>) => [number, number];
  if (radial) {
    const r = Math.min(ctx.innerWidth, ctx.innerHeight) / 2 - 40;
    laid = layout
      .size([2 * Math.PI, r])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(root);
    g.attr("transform", `translate(${ctx.innerWidth / 2},${ctx.innerHeight / 2})`);
    const lr = d3
      .linkRadial<d3.HierarchyPointLink<Datum>, d3.HierarchyPointNode<Datum>>()
      .angle((d) => d.x)
      .radius((d) => d.y);
    linkPath = (l) => lr(l);
    nodePos = (d) => [d.y * Math.cos(d.x - Math.PI / 2), d.y * Math.sin(d.x - Math.PI / 2)];
  } else {
    const labelRoom = 110;
    laid = layout.size([ctx.innerHeight, Math.max(50, ctx.innerWidth - labelRoom)])(root);
    const lh = d3
      .linkHorizontal<d3.HierarchyPointLink<Datum>, d3.HierarchyPointNode<Datum>>()
      .x((d) => d.y)
      .y((d) => d.x);
    linkPath = (l) => lh(l);
    nodePos = (d) => [d.y, d.x];
  }
  g.append("g")
    .attr("class", "links")
    .attr("fill", "none")
    .attr("stroke", ctx.theme.muted)
    .attr("stroke-opacity", 0.5)
    .selectAll("path")
    .data(laid.links())
    .join("path")
    .attr("class", "tree-link")
    .attr("d", linkPath);
  const nodes = laid.descendants();
  const node = g
    .append("g")
    .attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("transform", (d) => `translate(${nodePos(d)})`);
  const circles = node
    .append("circle")
    .attr("class", "tree-node")
    .attr("r", 3.5)
    .attr("fill", (d) => (d.children ? ctx.theme.accent : ctx.theme.muted));
  decorate(circles, (d) => ({ tooltip: tooltip(d), key: pathOf(d) || "root", label: nameOf(d.data) }));
  if (nodes.length <= (ctx.spec.options.labelLimit ?? 400)) {
    node
      .append("text")
      .attr("font-family", ctx.theme.font)
      .attr("font-size", 10)
      .attr("fill", ctx.theme.foreground)
      .attr("dy", "0.32em")
      .attr("x", (d) => (radial ? 0 : d.children ? -6 : 6))
      .attr("y", radial ? -8 : 0)
      .attr("text-anchor", (d) => (radial ? "middle" : d.children ? "end" : "start"))
      .text((d) => nameOf(d.data));
  }
  return {
    markCount: nodes.length,
    markSelector: "circle.tree-node",
    meta: { nodes: nodes.length, links: nodes.length - 1, radial },
  };
}

const H_APIS = [
  "hierarchy",
  "node.sum",
  "node.count",
  "node.sort",
  "node.descendants",
  "node.leaves",
  "node.ancestors",
  "stratify",
  "stratify.id",
  "stratify.parentId",
  "group",
];

export const hierarchyRenderers: RendererPlugin[] = [
  {
    type: "treemap",
    family: "hierarchy",
    label: "Treemap",
    description: "Space-filling rectangles sized by value for hierarchical data.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [
      ...H_APIS,
      "treemap",
      "treemap.tile",
      "treemap.size",
      "treemap.paddingInner",
      "treemap.paddingOuter",
      "treemap.round",
      "treemapSquarify",
      "treemapBinary",
      "treemapSlice",
      "treemapDice",
      "treemapSliceDice",
      "treemapResquarify",
    ],
    render: (ctx) => renderTreemap(ctx, false),
  },
  {
    type: "partition",
    family: "hierarchy",
    label: "Icicle (partition)",
    description: "Adjacency diagram of a hierarchy laid out with d3.partition.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [...H_APIS, "partition", "partition.size", "partition.padding"],
    render: (ctx) => renderTreemap(ctx, true),
  },
  {
    type: "sunburst",
    family: "hierarchy",
    label: "Sunburst",
    description: "Radial partition of a hierarchy.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [
      ...H_APIS,
      "partition",
      "partition.size",
      "arc",
      "arc.startAngle",
      "arc.endAngle",
      "arc.padAngle",
      "arc.innerRadius",
      "arc.outerRadius",
    ],
    render: renderSunburst,
  },
  {
    type: "pack",
    family: "hierarchy",
    label: "Circle packing",
    description: "Nested circles sized by value.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [...H_APIS, "pack", "pack.size", "pack.padding"],
    render: renderPack,
  },
  {
    type: "tree",
    family: "hierarchy",
    label: "Tree (tidy tree)",
    description: "Node-link tree diagram (Reingold–Tilford); options.radial for a radial tree.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [
      ...H_APIS,
      "tree",
      "tree.size",
      "tree.separation",
      "node.links",
      "linkHorizontal",
      "linkRadial",
      "link.x",
      "link.y",
      "linkRadial.angle",
      "linkRadial.radius",
    ],
    render: (ctx) => renderTree(ctx, false),
  },
  {
    type: "cluster",
    family: "hierarchy",
    label: "Dendrogram (cluster)",
    description: "Cluster layout placing all leaves at the same depth.",
    core: true,
    dataKinds: ["hierarchy", "table"],
    requiredChannels: [],
    d3Apis: [
      ...H_APIS,
      "cluster",
      "cluster.size",
      "cluster.separation",
      "node.links",
      "linkHorizontal",
      "linkRadial",
    ],
    render: (ctx) => renderTree(ctx, true),
  },
];
