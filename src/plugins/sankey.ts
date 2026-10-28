// Optional plugin: Sankey diagrams come from the separately installed d3-sankey package, not the core d3 bundle.
import {
  sankey,
  sankeyCenter,
  sankeyJustify,
  sankeyLeft,
  sankeyLinkHorizontal,
  sankeyRight,
} from "d3-sankey";
import type { SankeyLink, SankeyNode } from "d3-sankey";
import { D3McpError } from "../shared/errors.js";
import { graphFrom } from "../renderers/network/index.js";
import { colorEncoder, decorate, fmtValue } from "../renderers/svg/helpers.js";
import type { RenderContext, RendererPlugin, RenderResult } from "../renderers/types.js";

type N = { id: string; group: string };
type L = { source: string; target: string; value: number };

function renderSankey(ctx: RenderContext): RenderResult {
  const { nodes, links } = graphFrom(ctx);
  const align = { justify: sankeyJustify, left: sankeyLeft, right: sankeyRight, center: sankeyCenter };
  const gen = sankey<N, L>()
    .nodeId((d) => d.id)
    .nodeAlign(align.justify)
    .nodeWidth(14)
    .nodePadding(10)
    .extent([
      [0, 0],
      [ctx.innerWidth - 100, ctx.innerHeight],
    ]);
  const data = {
    nodes: nodes.map((n) => ({ id: n.id, group: n.group })),
    links: links.map((l) => ({
      source: String(l.source),
      target: String(l.target),
      value: Math.max(0, l.value),
    })),
  };
  let graph: { nodes: Array<SankeyNode<N, L>>; links: Array<SankeyLink<N, L>> };
  try {
    graph = gen(data);
  } catch (e) {
    throw new D3McpError(
      "INCOMPATIBLE_DATA",
      `Sankey layout failed: ${(e as Error).message}`,
      "Sankey requires a directed acyclic graph; remove circular links.",
    );
  }
  const color = colorEncoder(
    ctx,
    data.nodes.map((n) => (n.group === "node" ? n.id : n.group)),
    "nominal",
  );
  const nodeColor = (n: SankeyNode<N, L>) => color.color(n.group === "node" ? n.id : n.group);
  const g = ctx.plot.append("g").attr("class", "marks sankey");
  const linkSel = g
    .append("g")
    .attr("class", "links")
    .attr("fill", "none")
    .attr("stroke-opacity", 0.4)
    .selectAll("path")
    .data(graph.links)
    .join("path")
    .attr("class", "sankey-link")
    .attr("d", sankeyLinkHorizontal())
    .attr("stroke", (l) => nodeColor(l.source as SankeyNode<N, L>))
    .attr("stroke-width", (l) => Math.max(1, l.width ?? 1));
  decorate(linkSel, (l) => ({
    tooltip: `${(l.source as SankeyNode<N, L>).id} → ${(l.target as SankeyNode<N, L>).id}: ${fmtValue(l.value)}`,
    key: `${(l.source as SankeyNode<N, L>).id}|${(l.target as SankeyNode<N, L>).id}`,
  }));
  const rects = g
    .append("g")
    .attr("class", "nodes")
    .selectAll("rect")
    .data(graph.nodes)
    .join("rect")
    .attr("class", "sankey-node")
    .attr("x", (n) => n.x0!)
    .attr("y", (n) => n.y0!)
    .attr("width", (n) => n.x1! - n.x0!)
    .attr("height", (n) => Math.max(1, n.y1! - n.y0!))
    .attr("fill", nodeColor);
  decorate(rects, (n) => ({
    tooltip: `${n.id}\nflow: ${fmtValue(n.value ?? 0)}`,
    key: n.id,
    label: n.id,
    cat: n.group,
  }));
  g.append("g")
    .attr("class", "labels")
    .attr("font-family", ctx.theme.font)
    .attr("font-size", 10)
    .attr("fill", ctx.theme.foreground)
    .selectAll("text")
    .data(graph.nodes)
    .join("text")
    .attr("x", (n) => n.x1! + 6)
    .attr("y", (n) => (n.y0! + n.y1!) / 2)
    .attr("dy", "0.35em")
    .text((n) => n.id);
  return {
    markCount: graph.nodes.length,
    markSelector: "rect.sankey-node",
    meta: { nodes: graph.nodes.length, links: graph.links.length, plugin: "d3-sankey@0.12.3" },
  };
}

export const sankeyPlugin: RendererPlugin = {
  type: "sankey",
  family: "network",
  label: "Sankey diagram (plugin: d3-sankey)",
  description:
    "Flow magnitudes through a directed acyclic network. Provided by the optional d3-sankey package, not core D3.",
  core: false,
  dataKinds: ["graph", "table"],
  requiredChannels: [],
  d3Apis: ["scaleOrdinal", "schemeTableau10"],
  render: renderSankey,
};
