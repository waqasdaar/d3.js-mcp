import { describe, expect, it } from "vitest";
import { profileDataset } from "../../src/core/data/profile.js";
import { planVisualization } from "../../src/core/planning/planner.js";
import { recommend } from "../../src/core/planning/recommend.js";
import { applyInstructions } from "../../src/core/planning/refine.js";
import { D3McpError } from "../../src/shared/errors.js";
import { geo, hierarchy, network, sales, simpleBars, telemetryCsv } from "../fixtures/data.js";
import { ds } from "../helpers/render.js";

function plan(data: unknown, prompt: string, type?: string) {
  const d = ds(data);
  return planVisualization({
    dataset: d,
    profile: profileDataset(d),
    prompt,
    ...(type ? { type: type as never } : {}),
  });
}

describe("planner", () => {
  it("chooses a bar chart for category + measure", () => {
    const p = plan(simpleBars, "compare value by category");
    expect(p.chosenType).toBe("bar");
    expect(p.spec.encoding.x?.field).toBe("category");
    expect(p.spec.encoding.y?.field).toBe("value");
    expect(p.explanation.length).toBeGreaterThan(10);
  });

  it("chooses a time-series chart for temporal data", () => {
    const p = plan({ format: "csv", text: telemetryCsv() }, "show latency over time by site");
    expect(["line", "area"]).toContain(p.chosenType);
    expect(p.spec.encoding.x?.field).toBe("timestamp");
    expect(p.spec.encoding.y?.field).toBe("latency_ms");
  });

  it("chooses network, hierarchy and geo layouts by data kind", () => {
    expect(["force", "radial-network", "chord"]).toContain(plan(network, "show the topology").chosenType);
    expect(["treemap", "sunburst", "pack", "tree", "cluster", "partition"]).toContain(
      plan({ format: "hierarchy", root: hierarchy }, "").chosenType,
    );
    expect(plan(geo, "map the values").chosenType).toBe("geo");
  });

  it("honours explicit visualization types and keywords", () => {
    expect(plan(sales, "", "pie").chosenType).toBe("pie");
    expect(plan(sales, "a histogram of revenue").chosenType).toBe("histogram");
  });

  it("rejects unknown types", () => {
    expect(() => plan(sales, "", "not-a-chart")).toThrow(D3McpError);
  });

  it("the documented OpenChamber example prompt yields an interactive degree-sized force graph", () => {
    const p = plan(
      network,
      "Create an interactive force-directed network graph from the provided nodes and links. Color nodes by group, size them by degree, add searchable labels and tooltips, support zoom and pan, and export a standalone HTML file.",
    );
    expect(p.chosenType).toBe("force");
    expect(p.spec.interaction.zoom).toBe(true);
    expect(p.spec.interaction.search).toBe(true);
    expect(p.spec.interaction.tooltip).toBe(true);
    expect(p.spec.options.nodeSizeBy).toBe("degree");
    expect(p.spec.encoding.color?.field).toBe("group");
  });

  it("documents aggregation instead of silently applying it", () => {
    const p = plan(sales, "total revenue by region");
    if (p.spec.encoding.y?.aggregate) expect(p.transformations.join(" ")).toMatch(/aggregat|sum/i);
  });

  it("recommends ranked alternatives with questions and trade-offs", () => {
    const d = ds(sales);
    const recs = recommend(d, profileDataset(d));
    expect(recs.length).toBeGreaterThan(1);
    for (const r of recs) {
      expect(r.question).toBeTruthy();
      expect(r.rationale).toBeTruthy();
    }
    const scores = recs.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("refine", () => {
  const base = plan(simpleBars, "value by category").spec;
  const d = ds(simpleBars);

  it("sets a log scale and preserves unrelated configuration", () => {
    const r = applyInstructions(base, "use a logarithmic y scale", d);
    expect(r.spec.scales.y?.type).toBe("log");
    expect(r.spec.encoding).toEqual(base.encoding);
    expect(r.spec.title).toBe(base.title);
    expect(r.spec.layout).toEqual(base.layout);
  });

  it("falls back to symlog when values are non-positive", () => {
    const zero = ds([...simpleBars, { category: "Z", value: 0 }]);
    const r = applyInstructions(base, "logarithmic scale", zero);
    expect(r.spec.scales.y?.type).toBe("symlog");
  });

  it("adds threshold lines, dark theme and highlights", () => {
    const r = applyInstructions(base, "add a threshold line at 50; use a dark theme; highlight the top 2", d);
    expect(r.spec.annotations).toContainEqual(expect.objectContaining({ type: "rule", value: 50 }));
    expect(r.spec.theme).toBe("dark");
    expect(r.spec.interaction.highlight).toEqual(["B", "D"]);
  });

  it("changes type and reports unrecognized instructions", () => {
    const r = applyInstructions(base, "change to a line chart; make it sparkle", d);
    expect(r.spec.type).toBe("line");
    expect(r.unrecognized.join(" ")).toMatch(/sparkle/);
  });

  it("does not duplicate an existing reference line", () => {
    const once = applyInstructions(base, "threshold at 50", d).spec;
    const twice = applyInstructions(once, "threshold at 50", d).spec;
    expect(twice.annotations.filter((a) => a.value === 50)).toHaveLength(1);
  });

  it("does not mutate the input spec", () => {
    const before = JSON.stringify(base);
    applyInstructions(base, "dark theme; threshold at 10", d);
    expect(JSON.stringify(base)).toBe(before);
  });
});
