import * as d3 from "d3";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3";
import type { Row } from "../../core/data/types.js";
import { toLabel, toNumber } from "../../core/data/values.js";
import { D3McpError } from "../../shared/errors.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../types.js";
import { colorEncoder, decorate, drawLegend, field, fmtValue, textWidth } from "../svg/helpers.js";
import { BUILTIN_ICON_NAMES, lookupIcon, resolveIconSet, type IconDef } from "./icons.js";

export interface GNode extends SimulationNodeDatum {
  id: string;
  row: Row;
  degree: number;
  group: string;
  r: number;
  icon?: string;
}
export interface GLink extends SimulationLinkDatum<GNode> {
  value: number;
  row: Row;
}

/** Build nodes/links from a graph dataset, or from a table using encoding.source/target. */
export function graphFrom(ctx: RenderContext): { nodes: GNode[]; links: GLink[] } {
  const ds = ctx.dataset;
  const vf = field(ctx, "value") ?? "value";
  let nodeRows: Row[];
  let linkRows: Row[];
  let sf = "source";
  let tf = "target";
  if (ds.kind === "graph") {
    nodeRows = ctx.rows;
    linkRows = ds.links ?? [];
  } else {
    sf = field(ctx, "source") ?? "";
    tf = field(ctx, "target") ?? "";
    if (!sf || !tf) {
      throw new D3McpError(
        "INCOMPATIBLE_DATA",
        `"${ctx.spec.type}" requires graph data`,
        "Provide {nodes, links} or table rows with encoding.source and encoding.target.",
      );
    }
    linkRows = ctx.rows;
    const ids = Array.from(
      new Set(linkRows.flatMap((r) => [toLabel(r[sf] ?? null), toLabel(r[tf] ?? null)])),
    );
    nodeRows = ids.map((id) => ({ id }));
    ctx.warnings.push(`Nodes derived from unique ${sf}/${tf} values (${ids.length} nodes).`);
  }
  if (nodeRows.length > ctx.limits.maxForceNodes) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Graph has ${nodeRows.length} nodes; limit is ${ctx.limits.maxForceNodes}`,
      "Filter to a subgraph or aggregate nodes by group.",
    );
  }
  if (linkRows.length > ctx.limits.maxForceLinks) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `Graph has ${linkRows.length} links; limit is ${ctx.limits.maxForceLinks}`,
    );
  }
  const gf = field(ctx, "color") ?? field(ctx, "group");
  const nodes: GNode[] = nodeRows.map((r) => ({
    id: toLabel(r.id ?? null),
    row: r,
    degree: 0,
    group: gf ? toLabel(r[gf] ?? null) : "node",
    r: 5,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: GLink[] = linkRows.map((r) => {
    const s = byId.get(toLabel(r[sf] ?? null));
    const t = byId.get(toLabel(r[tf] ?? null));
    if (!s || !t)
      throw new D3McpError(
        "INVALID_INPUT",
        `Link references unknown node (${toLabel(r[sf] ?? null)} → ${toLabel(r[tf] ?? null)})`,
      );
    s.degree++;
    t.degree++;
    return { source: s.id, target: t.id, value: toNumber(r[vf] ?? null) ?? 1, row: r } as unknown as GLink;
  });
  const sizeBy = ctx.spec.options.nodeSizeBy ?? "degree";
  const sizeField = field(ctx, "size");
  const sizeVal = (n: GNode) =>
    sizeField
      ? (toNumber(n.row[sizeField] ?? null) ?? 0)
      : sizeBy === "value"
        ? (toNumber(n.row.value ?? null) ?? 0)
        : sizeBy === "degree"
          ? n.degree
          : 1;
  const maxV = d3.max(nodes, sizeVal) ?? 1;
  const rScale = d3
    .scaleSqrt()
    .domain([0, maxV || 1])
    .range([3, Math.max(6, Math.min(24, 600 / Math.sqrt(nodes.length + 1)))]);
  for (const n of nodes) n.r = sizeBy === "constant" && !sizeField ? 6 : rScale(sizeVal(n));
  return { nodes, links };
}

/** Scale settled positions (not radii) so the graph fills the plot area; capped so tiny graphs don't explode. */
function fitToBox(
  nodes: GNode[],
  w: number,
  h: number,
  labelRoom: (n: GNode) => number,
  independent = false,
): void {
  if (nodes.length < 2) return;
  const x0 = d3.min(nodes, (n) => n.x! - n.r)!;
  const x1 = d3.max(nodes, (n) => n.x! + n.r)!;
  const y0 = d3.min(nodes, (n) => n.y! - n.r)!;
  const y1 = d3.max(nodes, (n) => n.y! + n.r)!;
  const maxR = d3.max(nodes, (n) => n.r)!;
  const label = d3.max(nodes, labelRoom) ?? 0;
  let kx = (w - 2 * maxR - label) / Math.max(1, x1 - x0);
  let ky = (h - 2 * maxR) / Math.max(1, y1 - y0);
  if (!independent) kx = ky = Math.min(kx, ky, 4);
  kx = Math.min(kx, 4);
  ky = Math.min(ky, 4);
  if (!(kx > 1) && !(ky > 1)) return;
  kx = Math.max(kx, 1);
  ky = Math.max(ky, 1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (const n of nodes) {
    n.x = (w - label) / 2 + (n.x! - cx) * kx;
    n.y = h / 2 + (n.y! - cy) * ky;
  }
}

function hasField(nodes: GNode[], f: string): boolean {
  return nodes.some((n) => n.row[f] !== undefined && n.row[f] !== null);
}

const ICON_FIELD_CANDIDATES = ["type", "role", "device_type", "deviceType", "device", "kind", "category"];

/** Pick a node field whose values mostly name known icons (e.g. type: "router"). */
function detectIconField(
  ctx: RenderContext,
  nodes: GNode[],
  custom: RenderContext["spec"]["options"]["icons"],
): string | undefined {
  if (ctx.spec.options.iconMap) return undefined;
  const set = resolveIconSet(ctx.doc, custom, []);
  for (const f of ICON_FIELD_CANDIDATES) {
    if (!hasField(nodes, f)) continue;
    const hits = nodes.filter((n) => lookupIcon(set, toLabel(n.row[f] ?? null))).length;
    if (hits >= nodes.length / 2) {
      ctx.warnings.push(
        `Node icons taken from field "${f}" (${hits}/${nodes.length} values match known icons). Set options.iconField to override.`,
      );
      return f;
    }
  }
  return undefined;
}

/** Assign icon names to nodes; returns the icon set when any node has an icon. */
function assignIcons(ctx: RenderContext, nodes: GNode[]): Map<string, IconDef> | null {
  const o = ctx.spec.options;
  if (o.iconField && !hasField(nodes, o.iconField)) {
    throw new D3McpError(
      "FIELD_NOT_FOUND",
      `iconField "${o.iconField}" does not exist on any node`,
      `Node fields: ${Object.keys(nodes[0]?.row ?? {}).join(", ")}`,
    );
  }
  const iconField =
    o.iconField ?? (hasField(nodes, "icon") ? "icon" : undefined) ?? detectIconField(ctx, nodes, o.icons);
  if (!iconField && !o.iconMap && !o.icons) return null;
  const set = resolveIconSet(ctx.doc, o.icons, ctx.warnings);
  const missing = new Set<string>();
  for (const n of nodes) {
    const raw = iconField ? toLabel(n.row[iconField] ?? null) : n.group;
    if (!raw) continue;
    const name = lookupIcon(set, o.iconMap?.[raw] ?? raw);
    if (name) n.icon = name;
    else missing.add(raw);
  }
  if (missing.size) {
    ctx.warnings.push(
      `No icon for ${[...missing].slice(0, 10).join(", ")}; those nodes are drawn as plain circles. Built-in icons: ${BUILTIN_ICON_NAMES.join(", ")}${o.icons ? `; custom: ${Object.keys(o.icons).join(", ")}` : ""}.`,
    );
  }
  return nodes.some((n) => n.icon) ? set : null;
}

function renderForce(ctx: RenderContext, radial: boolean): RenderResult {
  const { nodes, links } = graphFrom(ctx);
  const { innerWidth: w, innerHeight: h } = ctx;
  const iconSet = assignIcons(ctx, nodes);
  const plainIcons = ctx.spec.options.iconStyle === "plain";
  for (const n of nodes) if (n.icon) n.r = Math.max(n.r, 11);
  const groups = Array.from(new Set(nodes.map((n) => n.group)));
  const color = colorEncoder(ctx, groups, "nominal");
  const seed = ctx.spec.options.seed ?? 42;
  const showLabels = ctx.spec.options.showLabels ?? nodes.length <= 80;
  const lf = field(ctx, "label") ?? "label";
  const labelOf = (n: GNode) => toLabel((n.row[lf] ?? n.row.name ?? n.id) as string);
  const sim = d3
    .forceSimulation<GNode>(nodes)
    .randomSource(d3.randomLcg(seed))
    .force(
      "link",
      d3
        .forceLink<GNode, GLink>(links)
        .id((d) => d.id)
        .distance(ctx.spec.options.linkDistance ?? 40),
    )
    .force("charge", d3.forceManyBody<GNode>().strength(ctx.spec.options.chargeStrength ?? -120))
    .force(
      "collide",
      d3.forceCollide<GNode>((d) => d.r + (showLabels ? 6 : 1.5)),
    )
    .stop();
  if (radial) {
    const maxR = Math.min(w, h) / 2 - 20;
    const ring = d3
      .scalePoint<string>()
      .domain(groups)
      .range([maxR * 0.25, maxR])
      .padding(0.5);
    sim.force(
      "radial",
      d3
        .forceRadial<GNode>((d) => (groups.length > 1 ? ring(d.group)! : maxR * 0.6), w / 2, h / 2)
        .strength(0.8),
    );
  } else {
    sim
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("x", d3.forceX<GNode>(w / 2).strength(0.05))
      .force("y", d3.forceY<GNode>(h / 2).strength(0.05));
  }
  const tierField = ctx.spec.options.tierField;
  let tiers: string[] = [];
  if (tierField && !radial) {
    if (!hasField(nodes, tierField)) {
      throw new D3McpError(
        "FIELD_NOT_FOUND",
        `tierField "${tierField}" does not exist on any node`,
        `Node fields: ${Object.keys(nodes[0]?.row ?? {}).join(", ")}`,
      );
    }
    const tierOf = (n: GNode) => toLabel(n.row[tierField] ?? null);
    const present = Array.from(new Set(nodes.map(tierOf)));
    const order = ctx.spec.options.tierOrder ?? [];
    tiers = [...order.filter((t) => present.includes(t)), ...present.filter((t) => !order.includes(t))];
    const ty = d3.scalePoint<string>().domain(tiers).range([0, h]).padding(0.5);
    sim.force("y", d3.forceY<GNode>((n) => ty(tierOf(n))!).strength(1));
    // Nodes in a layer share a row, so collisions must leave room for each node's centred label.
    if (showLabels)
      sim.force(
        "collide",
        d3.forceCollide<GNode>((n) => Math.max(n.r, textWidth(labelOf(n), 10) / 2) + 10),
      );
  } else if (tierField && radial) {
    ctx.warnings.push("tierField is ignored for radial-network; rings are formed by group.");
  }
  const iterations =
    ctx.spec.options.iterations ??
    Math.min(300, Math.max(100, Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()))));
  sim.tick(iterations);
  const labelsBelow = showLabels && tiers.length > 0;
  if (labelsBelow) {
    const half = (d3.max(nodes, (n) => textWidth(labelOf(n), 10)) ?? 0) / 2;
    fitToBox(nodes, w - 2 * half, h - 14, () => 0, true);
    for (const n of nodes) n.x! += half;
  } else if (!radial)
    fitToBox(nodes, w, h, showLabels ? (n) => textWidth(labelOf(n), 10) + 4 : () => 0, tiers.length > 0);
  for (const n of nodes) {
    n.x = Math.max(n.r, Math.min(w - n.r, n.x ?? 0));
    n.y = Math.max(n.r, Math.min(h - n.r, n.y ?? 0));
  }
  const maxVal = d3.max(links, (l) => l.value) ?? 1;
  const width = d3.scaleLinear().domain([0, maxVal]).range([0.8, 4]);
  const g = ctx.plot.append("g").attr("class", "marks network");
  const lines = g
    .append("g")
    .attr("class", "links")
    .attr("stroke", ctx.theme.muted)
    .attr("stroke-opacity", 0.55)
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link")
    .attr("x1", (l) => (l.source as GNode).x!)
    .attr("y1", (l) => (l.source as GNode).y!)
    .attr("x2", (l) => (l.target as GNode).x!)
    .attr("y2", (l) => (l.target as GNode).y!)
    .attr("stroke-width", (l) => width(l.value))
    .attr("data-source", (l) => (l.source as GNode).id)
    .attr("data-target", (l) => (l.target as GNode).id);
  lines
    .append("title")
    .text((l) => `${(l.source as GNode).id} → ${(l.target as GNode).id}: ${fmtValue(l.value)}`);
  const circles = g
    .append("g")
    .attr("class", "nodes")
    .attr("stroke", ctx.theme.stroke)
    .attr("stroke-width", 1.2)
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("class", "node")
    .attr("cx", (n) => n.x!)
    .attr("cy", (n) => n.y!)
    .attr("r", (n) => n.r)
    .attr("fill", (n) => (n.icon && plainIcons ? ctx.theme.background : color.color(n.group)))
    .attr("stroke", (n) => (n.icon && plainIcons ? color.color(n.group) : null))
    .attr("data-id", (n) => n.id)
    .attr("data-icon", (n) => n.icon ?? null);
  decorate(circles, (n) => ({
    tooltip: [
      `${labelOf(n)}`,
      `id: ${n.id}`,
      `group: ${n.group}`,
      `degree: ${n.degree}`,
      ...(ctx.spec.encoding.tooltip ?? []).map((f) => `${f}: ${fmtValue(n.row[f] ?? null)}`),
    ].join("\n"),
    key: n.id,
    cat: n.group,
    label: labelOf(n),
  }));
  if (iconSet)
    drawIcons(g, nodes, iconSet, (n) => (plainIcons ? color.color(n.group) : "#ffffff"), plainIcons);
  if (showLabels) {
    const limit = ctx.spec.options.labelLimit ?? 80;
    const top = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, limit);
    g.append("g")
      .attr("class", "labels")
      .attr("font-family", ctx.theme.font)
      .attr("font-size", 10)
      .attr("fill", ctx.theme.foreground)
      .attr("stroke", ctx.theme.background)
      .attr("stroke-width", 3)
      .attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke")
      .attr("pointer-events", "none")
      .selectAll("text")
      .data(top)
      .join("text")
      .attr("class", "node-label")
      .attr("data-id", (n) => n.id)
      .attr("data-pos", labelsBelow ? "below" : null)
      .attr("text-anchor", labelsBelow ? "middle" : null)
      .attr("x", (n) => (labelsBelow ? n.x! : n.x! + n.r + 2))
      .attr("y", (n) => (labelsBelow ? n.y! + n.r + 11 : n.y! + 3))
      .text(labelOf);
  }
  if (groups.length > 1) drawLegend(ctx, color, field(ctx, "color") ?? field(ctx, "group") ?? "group");
  return {
    markCount: nodes.length,
    markSelector: "circle.node",
    meta: {
      nodes: nodes.length,
      links: links.length,
      iterations,
      seed,
      finalAlpha: Math.round(sim.alpha() * 1e4) / 1e4,
      ...(iconSet
        ? {
            icons: d3
              .rollups(
                nodes.filter((n) => n.icon),
                (v) => v.length,
                (n) => n.icon!,
              )
              .map(([icon, count]) => ({ icon, count })),
          }
        : {}),
      ...(tiers.length ? { tiers } : {}),
    },
  };
}

/** Draw icons centred on nodes. data-dx/dy/k let the HTML runtime move icons when nodes are dragged. */
function drawIcons(
  g: d3.Selection<SVGGElement, unknown, null, undefined>,
  nodes: GNode[],
  set: Map<string, IconDef>,
  fg: (n: GNode) => string,
  plain: boolean,
): void {
  g.append("g")
    .attr("class", "node-icons")
    .attr("pointer-events", "none")
    .selectAll("g")
    .data(nodes.filter((n) => n.icon))
    .join("g")
    .attr("class", "node-icon")
    .attr("data-id", (n) => n.id)
    .attr("data-icon", (n) => n.icon!)
    .attr("color", fg)
    .each(function (n) {
      const def = set.get(n.icon!)!;
      const [vx, vy, vw, vh] = def.viewBox;
      const size = n.r * (plain ? 1.7 : 1.25);
      const k = size / Math.max(vw, vh);
      const dx = -(vx + vw / 2) * k;
      const dy = -(vy + vh / 2) * k;
      const el = d3
        .select(this)
        .attr("data-k", k)
        .attr("data-dx", dx)
        .attr("data-dy", dy)
        .attr("transform", `translate(${n.x! + dx},${n.y! + dy}) scale(${k})`);
      for (const p of def.paths) {
        el.append("path")
          .attr("d", p.d)
          .attr("fill", p.fill ?? "currentColor")
          .attr("stroke", p.stroke ?? null)
          .attr("stroke-width", p.strokeWidth ?? null)
          .attr("fill-rule", p.fillRule ?? null)
          .attr("stroke-linecap", p.linecap ?? null)
          .attr("stroke-linejoin", p.linejoin ?? null)
          .attr("transform", p.transform ?? null);
      }
    });
}

function renderChord(ctx: RenderContext): RenderResult {
  const { nodes, links } = graphFrom(ctx);
  const names = nodes.map((n) => n.id);
  const index = new Map(names.map((n, i) => [n, i]));
  const n = names.length;
  if (n > 200)
    throw new D3McpError("LIMIT_EXCEEDED", `Chord diagram supports at most 200 entities; got ${n}`);
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const l of links) {
    const s = index.get(typeof l.source === "object" ? (l.source as GNode).id : String(l.source))!;
    const t = index.get(typeof l.target === "object" ? (l.target as GNode).id : String(l.target))!;
    matrix[s]![t]! += l.value;
  }
  const r = Math.min(ctx.innerWidth, ctx.innerHeight) / 2 - 30;
  const chords = d3.chord().padAngle(0.04).sortSubgroups(d3.descending)(matrix);
  const color = colorEncoder(ctx, names, "nominal");
  const g = ctx.plot
    .append("g")
    .attr("class", "marks chord")
    .attr("transform", `translate(${ctx.innerWidth / 2},${ctx.innerHeight / 2})`);
  const arc = d3
    .arc<d3.ChordGroup>()
    .innerRadius(r)
    .outerRadius(r + 12);
  const groupPaths = g
    .append("g")
    .attr("class", "groups")
    .selectAll("path")
    .data(chords.groups)
    .join("path")
    .attr("class", "chord-group")
    .attr("fill", (d) => color.color(names[d.index]!))
    .attr("d", arc);
  decorate(groupPaths, (d) => ({
    tooltip: `${names[d.index]}\ntotal: ${fmtValue(d.value)}`,
    key: names[d.index]!,
    cat: names[d.index]!,
    label: names[d.index]!,
  }));
  const ribbon = d3.ribbon<d3.Chord, d3.ChordSubgroup>().radius(r - 1);
  const ribbons = g
    .append("g")
    .attr("class", "ribbons")
    .attr("fill-opacity", 0.7)
    .selectAll("path")
    .data(chords)
    .join("path")
    .attr("class", "chord-ribbon")
    .attr("fill", (d) => color.color(names[d.source.index]!))
    .attr("d", (d) => ribbon(d) as unknown as string);
  decorate(ribbons, (d) => ({
    tooltip: `${names[d.source.index]} → ${names[d.target.index]}: ${fmtValue(d.source.value)}${d.source.index !== d.target.index ? `\n${names[d.target.index]} → ${names[d.source.index]}: ${fmtValue(d.target.value)}` : ""}`,
    key: `${names[d.source.index]}|${names[d.target.index]}`,
    cat: names[d.source.index]!,
  }));
  g.append("g")
    .attr("class", "labels")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 10)
    .attr("fill", ctx.theme.foreground)
    .selectAll("text")
    .data(chords.groups.filter((d) => d.endAngle - d.startAngle > 0.08))
    .join("text")
    .each(function (d) {
      const a = (d.startAngle + d.endAngle) / 2;
      d3.select(this)
        .attr(
          "transform",
          `rotate(${(a * 180) / Math.PI - 90}) translate(${r + 16}) ${a > Math.PI ? "rotate(180)" : ""}`,
        )
        .attr("text-anchor", a > Math.PI ? "end" : "start")
        .attr("dy", "0.35em")
        .text(names[d.index]!);
    });
  return {
    markCount: chords.groups.length,
    markSelector: "path.chord-group",
    meta: { entities: n, ribbons: chords.length },
  };
}

const FORCE_APIS = [
  "forceSimulation",
  "simulation.force",
  "simulation.tick",
  "simulation.stop",
  "simulation.randomSource",
  "simulation.alpha",
  "simulation.alphaMin",
  "simulation.alphaDecay",
  "forceLink",
  "link.id",
  "link.distance",
  "forceManyBody",
  "manyBody.strength",
  "forceCollide",
  "randomLcg",
  "scaleSqrt",
  "scaleOrdinal",
  "max",
];

export const networkRenderers: RendererPlugin[] = [
  {
    type: "force",
    family: "network",
    label: "Force-directed network",
    description:
      "Node-link graph laid out with d3-force (deterministic seed, bounded iterations). Nodes sized by degree by default.",
    core: true,
    dataKinds: ["graph", "table"],
    requiredChannels: [],
    usesLegend: true,
    d3Apis: [
      ...FORCE_APIS,
      "forceCenter",
      "forceX",
      "forceY",
      "x.strength",
      "y.strength",
      "rollups",
      "scalePoint",
    ],
    render: (ctx) => renderForce(ctx, false),
  },
  {
    type: "radial-network",
    family: "network",
    label: "Radial network",
    description: "Force layout constrained to concentric rings per group (d3.forceRadial).",
    core: true,
    dataKinds: ["graph", "table"],
    requiredChannels: [],
    usesLegend: true,
    d3Apis: [...FORCE_APIS, "forceRadial", "radial.strength", "scalePoint", "rollups"],
    render: (ctx) => renderForce(ctx, true),
  },
  {
    type: "chord",
    family: "network",
    label: "Chord diagram",
    description: "Flows between entities in a square matrix (d3.chord + d3.ribbon).",
    core: true,
    dataKinds: ["graph", "table"],
    requiredChannels: [],
    usesLegend: false,
    d3Apis: [
      "chord",
      "chord.padAngle",
      "chord.sortSubgroups",
      "ribbon",
      "ribbon.radius",
      "arc",
      "descending",
      "scaleOrdinal",
    ],
    render: renderChord,
  },
];
