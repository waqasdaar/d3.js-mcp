import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFileInput } from "../../src/core/data/files.js";
import { ingest } from "../../src/core/data/ingest.js";
import { profileDataset } from "../../src/core/data/profile.js";
import type { Dataset } from "../../src/core/data/types.js";
import { planVisualization } from "../../src/core/planning/planner.js";
import { applyInstructions } from "../../src/core/planning/refine.js";
import type { VisType, VisualizationSpec } from "../../src/core/schema/spec.js";
import { config } from "../helpers/render.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FILES = path.join(ROOT, "examples", "data-files");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");

/** Rows of the markdown table between <!-- prompts:NAME --> markers. */
function table(name: string): string[][] {
  const block = new RegExp(`<!-- prompts:${name} -->([\\s\\S]*?)<!-- /prompts:${name} -->`).exec(README);
  if (!block) throw new Error(`README is missing the prompts:${name} table`);
  return block[1]!
    .trim()
    .split("\n")
    .slice(2)
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
}

const strip = (s: string) => s.replace(/`/g, "").trim();

async function load(data: string): Promise<Dataset> {
  const m = /^`([^`]+)`(?: sheet `([^`]+)`)?$/.exec(data);
  if (!m) throw new Error(`Unparseable data cell: ${data}`);
  const cfg = { ...config, dataDirs: [FILES] };
  const { data: encoded } = await resolveFileInput({ file: m[1]!, ...(m[2] ? { sheet: m[2] } : {}) }, cfg);
  return ingest(encoded, { ...cfg, maxInputBytes: cfg.maxFileBytes });
}

describe("README single-chart prompts produce the documented chart", () => {
  const rows = table("charts");
  it("has rows", () => expect(rows.length).toBeGreaterThan(20));
  for (const [prompt, data, chart] of rows) {
    it(`${prompt} → ${chart}`, async () => {
      const ds = await load(data!);
      const plan = planVisualization({ dataset: ds, profile: profileDataset(ds), prompt: prompt! });
      expect(plan.chosenType).toBe(strip(chart!));
    });
  }
});

/** One check per documented instruction; a README row without a check fails the suite. */
const REFINE_CHECKS: Record<string, (s: VisualizationSpec, before: VisualizationSpec) => void> = {
  "use a logarithmic y scale": (s) => expect(["log", "symlog"]).toContain(s.scales.y?.type),
  "add a threshold line at 100": (s) =>
    expect(s.annotations).toContainEqual(expect.objectContaining({ type: "rule", value: 100 })),
  "highlight the top 2": (s) => expect(s.interaction.highlight).toEqual(["East", "North"]),
  "highlight East": (s) => expect(s.interaction.highlight).toEqual(["East"]),
  "use a dark theme": (s) => expect(s.theme).toBe("dark"),
  "sort descending": (s) =>
    expect(s.transforms).toContainEqual(expect.objectContaining({ type: "sort", order: "descending" })),
  "make it horizontal": (s) => expect(s.options.orientation).toBe("horizontal"),
  "change to a line chart": (s) => expect(s.type).toBe("line"),
  "color by product": (s) => expect(s.encoding.color?.field).toBe("product"),
  'title "Q3 revenue"': (s) => expect(s.title).toBe("Q3 revenue"),
  "use the viridis palette": (s) => expect(s.scales.color?.scheme).toBe("Viridis"),
  "hide the legend": (s) => expect(s.legend.show).toBe(false),
  "width 1000": (s) => expect(s.layout.width).toBe(1000),
  "enable zoom and pan": (s) => expect(s.interaction.zoom).toBe(true),
  "20 bins": (s) => expect(s.options.bins).toBe(20),
  "smooth the lines": (s) => expect(s.options.curve).toBe("monotoneX"),
  "size by degree": (s) => expect(s.options.nodeSizeBy).toBe("degree"),
  "show labels": (s) => expect(s.options.showLabels).toBe(true),
  "make it radial": (s) => expect(s.options.radial).toBe(true),
};

describe("README refinement instructions do what the table says", () => {
  const rows = table("refine");
  it("every documented instruction has a check", () => {
    expect(rows.map((r) => r[0])).toEqual(Object.keys(REFINE_CHECKS));
  });
  for (const [instruction, start] of rows) {
    it(`${instruction} (${start})`, async () => {
      const m = /^`([a-z-]+)` of (.+)$/.exec(start!)!;
      const ds = await load(m[2]!);
      const before = planVisualization({
        dataset: ds,
        profile: profileDataset(ds),
        prompt: "",
        type: m[1] as VisType,
      }).spec;
      const r = applyInstructions(before, instruction!, ds);
      expect(r.unrecognized).toEqual([]);
      expect(r.changes.length).toBeGreaterThan(0);
      REFINE_CHECKS[instruction!]!(r.spec, before);
      expect(r.spec.data).toEqual(before.data);
    });
  }

  it("the combined example applies every part", async () => {
    const ds = await load("`sales.csv`");
    const before = planVisualization({
      dataset: ds,
      profile: profileDataset(ds),
      prompt: "",
      type: "bar",
    }).spec;
    const r = applyInstructions(
      before,
      "use a dark theme; add a threshold line at 100 and highlight the top 2",
      ds,
    );
    expect(r.unrecognized).toEqual([]);
    expect(r.spec.theme).toBe("dark");
    expect(r.spec.annotations.some((a) => a.value === 100)).toBe(true);
    expect(r.spec.interaction.highlight).toHaveLength(2);
  });
});
