import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/core/artifacts/store.js";
import { executeComposition } from "../../src/core/composition/executor.js";
import { ingest } from "../../src/core/data/ingest.js";
import { profileDataset } from "../../src/core/data/profile.js";
import { planVisualization } from "../../src/core/planning/planner.js";
import { validateHtml, validateSvg } from "../../src/core/validation/structural.js";
import { buildHtml } from "../../src/export/html.js";
import { escapeHtml, jsonForScript } from "../../src/shared/escape.js";
import { malicious } from "../fixtures/data.js";
import { config, render, tempService } from "../helpers/render.js";

describe("untrusted data is escaped", () => {
  it("malicious labels never produce executable markup in SVG", () => {
    const r = render("bar", malicious, {
      encoding: { x: { field: "name" }, y: { field: "value" } },
      title: '<script>alert("t")</script>',
    });
    const report = validateSvg(r.svg);
    expect(report.errors).toEqual([]);
    const doc = new JSDOM(r.svg, { contentType: "image/svg+xml" }).window.document;
    expect(doc.querySelectorAll("script, img, foreignObject").length).toBe(0);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes))
        expect(a.name.toLowerCase().startsWith("on"), a.name).toBe(false);
    }
    expect(Array.from(doc.querySelectorAll("text")).some((t) => t.textContent?.includes("<script>"))).toBe(
      true,
    );
  });

  it("malicious labels are escaped in standalone HTML", async () => {
    const svc = tempService();
    const d = await svc.resolveData(malicious, "sec");
    const p = planVisualization({
      dataset: d,
      profile: profileDataset(d),
      prompt: "",
      type: "bar",
      title: "</title><script>alert(1)</script>",
    });
    const r = await svc.renderArtifact(p.spec, d, { formats: ["html"], sessionId: "sec" });
    const html = readFileSync(r.record.files.html!.path, "utf8");
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    for (const s of scripts) expect(s).not.toMatch(/src=/i);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toMatch(/Content-Security-Policy/);
  });

  it("escapeHtml and jsonForScript neutralize breakouts", () => {
    expect(escapeHtml('<a href="x">&\'')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(jsonForScript({ a: "</script><script>x()</script>" })).not.toContain("</script>");
  });

  it("HTML builder never emits SVG containing scripts or handlers", () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>x()</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="x()"></svg>',
    ]) {
      expect(validateSvg(svg).valid).toBe(false);
      let html: string;
      try {
        html = buildHtml({
          title: "t",
          charts: [{ svg, specId: "a" }],
          findings: [],
          warnings: [],
          theme: "light",
          d3: "none",
        });
      } catch {
        continue;
      }
      expect(validateHtml(html).valid).toBe(false);
    }
  });
});

describe("user-supplied SVG validation", () => {
  const cases = {
    script: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
    handler: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect onclick="alert(1)"/></svg>',
    jsHref:
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1" height="1"><a xlink:href="javascript:alert(1)"><rect/></a></svg>',
    external:
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="http://169.254.169.254/latest/meta-data"/></svg>',
    foreign:
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><foreignObject><div/></foreignObject></svg>',
    entity:
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><text>&x;</text></svg>',
    cssImport:
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><style>@import url(http://evil)</style></svg>',
  };
  for (const [name, svg] of Object.entries(cases)) {
    it(`rejects ${name}`, () => {
      expect(validateSvg(svg).valid).toBe(false);
    });
  }
});

describe("input hardening", () => {
  it("rejects prototype-pollution field names", () => {
    expect(() => ingest(JSON.parse('[{"__proto__": {"x": 1}, "a": 1}]'), config)).toThrow(/not allowed/);
    expect(() => ingest([{ constructor: 1 }], config)).toThrow(/not allowed/);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("rejects path traversal in ids", async () => {
    const store = new ArtifactStore(tempService().config.artifactDir, 1);
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/Invalid/);
    await expect(store.getDataset("..")).rejects.toThrow(/Invalid/);
    expect(() => store.sessionDir("../x")).toThrow(/Invalid/);
    await expect(store.writeArtifactFile(store.root, "../evil.txt", "x")).rejects.toThrow();
  });

  it("composition never evaluates code", () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__pwned;
    expect(() =>
      executeComposition({
        steps: [
          {
            id: "a",
            op: "array.sum",
            input: [1],
            field: "constructor.constructor('globalThis.__pwned=1')()",
          },
        ],
      }),
    ).not.toThrow(/pwned/);
    expect(g.__pwned).toBeUndefined();
    expect(() =>
      executeComposition({
        steps: [
          {
            id: "a",
            op: "scale.create",
            args: { type: "linear", domain: [0, 1], interpolator: "constructor" },
          },
        ],
      }),
    ).not.toThrow(/pwned/);
    expect(g.__pwned).toBeUndefined();
  });

  it("truncates oversized cells and reports it", () => {
    const d = ingest([{ a: "x".repeat(config.maxCellChars + 1) }], config);
    expect(String(d.rows[0]!.a)).toHaveLength(config.maxCellChars);
    expect(d.warnings.join(" ")).toMatch(/Truncated 1/);
  });
});
