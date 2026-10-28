import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { profileDataset } from "../../src/core/data/profile.js";
import { planVisualization } from "../../src/core/planning/planner.js";
import { validateHtml } from "../../src/core/validation/structural.js";
import { buildHtml, d3BundleSource } from "../../src/export/html.js";
import { largeRecords, sales, simpleBars } from "../fixtures/data.js";
import { tempService } from "../helpers/render.js";

describe("VisualizationService", () => {
  it("renders an artifact and writes SVG, HTML, JSON and CSV", async () => {
    const svc = tempService();
    const d = await svc.resolveData(simpleBars, "s1");
    const p = planVisualization({ dataset: d, profile: profileDataset(d), prompt: "value by category" });
    const r = await svc.renderArtifact(p.spec, d, { formats: ["html", "svg", "csv"], sessionId: "s1" });
    for (const f of ["svg", "html", "json", "csv"] as const) {
      const file = r.record.files[f]!;
      expect(existsSync(file.path), f).toBe(true);
      expect(file.bytes).toBeGreaterThan(0);
      expect(file.path.startsWith(svc.config.artifactDir)).toBe(true);
    }
    const html = readFileSync(r.record.files.html!.path, "utf8");
    expect(validateHtml(html).valid).toBe(true);
    expect(r.record.markCount).toBe(5);
    const again = await svc.store.get(r.record.id);
    expect(again.id).toBe(r.record.id);
  });

  it("resolves stored datasets by reference", async () => {
    const svc = tempService();
    const d = await svc.resolveData(sales, "s1");
    const d2 = await svc.resolveData({ dataset_id: d.id }, "s1");
    expect(d2.rows).toHaveLength(sales.length);
  });

  it("rejects empty datasets", async () => {
    await expect(tempService().resolveData([], "s1")).rejects.toThrow(/no records/);
  });

  it("builds dashboards from several specs", async () => {
    const svc = tempService();
    const d = await svc.resolveData(sales, "s1");
    const prof = profileDataset(d);
    const a = planVisualization({ dataset: d, profile: prof, prompt: "revenue by region", type: "bar" }).spec;
    const b = planVisualization({
      dataset: d,
      profile: prof,
      prompt: "units vs revenue",
      type: "scatter",
    }).spec;
    const r = await svc.renderDashboard(
      [
        { spec: a, ds: d },
        { spec: b, ds: d },
      ],
      { title: "Dash", columns: 2, formats: ["html"], sessionId: "s1" },
    );
    expect(r.charts).toHaveLength(2);
    const html = readFileSync(r.record.files.html!.path, "utf8");
    expect((html.match(/<svg[^>]*d3mcp-root/g) ?? []).length).toBe(2);
  });

  it("reports export failures instead of fake success for unavailable formats", async () => {
    const svc = tempService();
    const d = await svc.resolveData(simpleBars, "s1");
    const p = planVisualization({ dataset: d, profile: profileDataset(d), prompt: "" });
    const r = await svc.renderArtifact(p.spec, d, { formats: ["html"], sessionId: "s1" });
    const rec = await svc.exportArtifact(r.record.id, ["csv"]);
    expect(rec.files.csv?.bytes).toBeGreaterThan(0);
  });

  it("switches large scatterplots to canvas or reports limits", async () => {
    const svc = tempService();
    const d = await svc.resolveData(largeRecords(30_000), "s1");
    const p = planVisualization({
      dataset: d,
      profile: profileDataset(d),
      prompt: "x vs y",
      type: "scatter",
    });
    try {
      const r = await svc.renderArtifact(p.spec, d, { formats: ["html"], sessionId: "s1" });
      expect(r.record.warnings.length + (p.spec.renderer === "canvas" ? 1 : 0)).toBeGreaterThan(0);
    } catch (e) {
      expect((e as Error).message).toMatch(/limit|marks/i);
    }
  });
});

describe("HTML export", () => {
  it("embeds d3 inline and pins scripts by CSP hash", () => {
    const html = buildHtml({
      title: "T",
      charts: [
        {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" class="d3mcp-root" width="10" height="10"><rect/></svg>',
          specId: "x",
        },
      ],
      findings: ["f"],
      warnings: [],
      theme: "light",
      d3: "inline",
    });
    const r = validateHtml(html);
    expect(r.errors).toEqual([]);
    expect(html).toContain(d3BundleSource().version);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
