import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  analyzeLinks,
  entityKeys,
  joinDatasets,
  nameSimilarity,
  normKey,
  orientLink,
  parseLinkOption,
  tokensVia,
  type LinkSource,
} from "../../src/core/data/link.js";
import { buildHtml } from "../../src/export/html.js";
import { linkValuesOf } from "../../src/renderers/render.js";
import { geo, network, sales, telemetryCsv } from "../fixtures/data.js";
import { ds, render } from "../helpers/render.js";

const src = (label: string, data: unknown): LinkSource => ({ label, ds: ds(data) });

const sites = src("sites", [
  { site_code: "SJC", city: "San Jose", region: "Americas", circuit_mbps: 1000 },
  { site_code: "NYC", city: "New York", region: "Americas", circuit_mbps: 500 },
  { site_code: "LON", city: "London", region: "EMEA", circuit_mbps: 1000 },
]);
const metrics = src("metrics", [
  { date: "2026-10-01", site: "SJC", latency_ms: 20 },
  { date: "2026-10-01", site: " nyc ", latency_ms: 40 },
  { date: "2026-10-02", site: "sjc", latency_ms: 22 },
  { date: "2026-10-02", site: "PAR", latency_ms: 90 },
]);

describe("link inference", () => {
  it("normalizes keys (trim, case) and scores names", () => {
    expect(normKey(" SJC ")).toBe("sjc");
    expect(normKey(null)).toBe("");
    expect(normKey("a|b")).toBe("a¦b");
    expect(nameSimilarity("site_code", "SiteCode")).toBe(1);
    expect(nameSimilarity("site", "site_code")).toBe(0.7);
    expect(nameSimilarity("latency", "region")).toBe(0);
  });

  it("finds the shared key with coverage and cardinality, ignoring dates and measures", () => {
    const a = analyzeLinks([metrics, sites]);
    expect(a.recommended).toEqual([
      { left: "metrics", leftField: "site", right: "sites", rightField: "site_code" },
    ]);
    const top = a.candidates[0]!;
    expect(top).toMatchObject({ overlap: 2, cardinality: "N:1", leftCoverage: 0.667, rightCoverage: 0.667 });
    expect(top.sampleMatches.sort()).toEqual(["nyc", "sjc"]);
    expect(a.candidates.some((c) => c.leftField === "date" || c.leftField === "latency_ms")).toBe(false);
    expect(a.questions).toEqual([]);
  });

  it("asks when two fields match equally well, with a 'do not link' option", () => {
    const devices = src("devices", [
      { id: "r1", hostname: "r1" },
      { id: "r2", hostname: "r2" },
      { id: "r3", hostname: "r3" },
    ]);
    const m = src("m", [{ device: "r1" }, { device: "r2" }, { device: "r3" }, { device: "r1" }]);
    const a = analyzeLinks([devices, m]);
    expect(a.recommended).toEqual([]);
    expect(a.questions).toHaveLength(1);
    const q = a.questions[0]!;
    expect(q.why).toMatch(/Several fields match about equally well/);
    expect(q.options.map((o) => o.value)).toEqual([
      "devices.id=m.device",
      "devices.hostname=m.device",
      "none",
    ]);
    expect(parseLinkOption(q.options[1]!.value)).toEqual({
      left: "devices",
      leftField: "hostname",
      right: "m",
      rightField: "device",
    });
    // An explicit link settles the pair.
    const settled = analyzeLinks(
      [devices, m],
      [{ left: "devices", leftField: "hostname", right: "m", rightField: "device" }],
    );
    expect(settled.questions).toEqual([]);
    expect(settled.recommended[0]!.leftField).toBe("hostname");
  });

  it("does not ask about pairs already connected through other links, and flags unrelated data", () => {
    const incidents = src("incidents", [
      { ticket: "1", site: "sjc" },
      { ticket: "2", site: "sjc" },
      { ticket: "3", site: "lon" },
    ]);
    const other = src("other", [{ x: "q" }, { x: "w" }]);
    const a = analyzeLinks([metrics, sites, incidents, other]);
    // metrics–incidents (N:M) is reachable through sites, so no question for it.
    expect(
      a.questions.find((q) => q.pair.includes("metrics") && q.pair.includes("incidents")),
    ).toBeUndefined();
    const unrelated = a.questions.filter((q) => q.pair.includes("other"));
    expect(unrelated.length).toBeGreaterThan(0);
    expect(unrelated[0]!.options.map((o) => o.value)).toEqual(["none"]);
    expect(unrelated.every((q) => !q.blocking)).toBe(true);
  });

  it("treats shared category words under unrelated names as coincidence, not a blocking question", () => {
    const devices = src("devices", [
      { name: "a", type: "router" },
      { name: "b", type: "switch" },
      { name: "c", type: "router" },
    ]);
    const orders = src("orders", [
      { order: "1", product: "Router" },
      { order: "2", product: "Switch" },
      { order: "3", product: "router" },
    ]);
    const q = analyzeLinks([devices, orders]).questions[0]!;
    expect(q.blocking).toBe(false);
    expect(q.why).toMatch(/coincidental/);
  });
});

describe("joins", () => {
  it("left join keeps unmatched rows, matches case-insensitively and reports counts", () => {
    const j = joinDatasets(metrics, sites, { leftField: "site", rightField: "site_code" }, 1000);
    expect(j.matched).toBe(3);
    expect(j.unmatched).toBe(1);
    expect(j.dataset.rows).toHaveLength(4);
    expect(j.dataset.rows[1]).toMatchObject({ site: " nyc ", city: "New York", region: "Americas" });
    expect(j.dataset.rows[3]).toMatchObject({ site: "PAR", city: null });
    expect(j.dataset.transformations.join(" ")).toMatch(/3 matched, 1 without a match/);
    expect(j.dataset.warnings.join(" ")).toMatch(/circuit_mbps.*repeat.*mean\/max\/min/);
    const inner = joinDatasets(
      metrics,
      sites,
      { leftField: "site", rightField: "site_code", how: "inner" },
      1000,
    );
    expect(inner.dataset.rows).toHaveLength(3);
  });

  it("attributesOnly drops lookup measures; clashing names are prefixed", () => {
    const left = src("a", [{ site: "SJC", city: "x" }]);
    const j = joinDatasets(
      left,
      sites,
      { leftField: "site", rightField: "site_code", attributesOnly: true },
      100,
    );
    expect(j.addedFields.sort()).toEqual(["region", "sites.city"]);
    expect(j.dataset.transformations.join(" ")).toMatch(/Only descriptive/);
  });

  it("refuses row explosions and one-to-many joins onto graphs", () => {
    const dup = src("dup", [
      { k: "a", v: 1 },
      { k: "a", v: 2 },
      { k: "a", v: 3 },
    ]);
    expect(() => joinDatasets(dup, dup, { leftField: "k", rightField: "k" }, 5)).toThrow(/more than 5 rows/);
    const g = src("net", network);
    const many = src("many", [
      { node: "hub-sjc", x: 1 },
      { node: "hub-sjc", x: 2 },
    ]);
    expect(() => joinDatasets(g, many, { leftField: "id", rightField: "node" }, 100)).toThrow(
      /repeats values/,
    );
    expect(() => joinDatasets(sites, sites, { leftField: "nope", rightField: "site_code" }, 100)).toThrow(
      /not found/,
    );
  });

  it("enriches graph nodes and GeoJSON features without changing their structure", () => {
    const g = src("net", network);
    const info = src("info", [{ node: "HUB-SJC", owner: "ops" }]);
    const j = joinDatasets(g, info, { leftField: "id", rightField: "node" }, 100);
    expect(j.dataset.kind).toBe("graph");
    expect(j.dataset.links).toBe(g.ds.links);
    expect(j.dataset.rows.find((r) => r.id === "hub-sjc")!.owner).toBe("ops");
    const map = src("map", geo);
    const names = map.ds.rows.map((r) => r.name);
    const props = src("props", [{ name: String(names[0]).toUpperCase(), owner: "team-a" }]);
    const jg = joinDatasets(map, props, { leftField: "name", rightField: "name" }, 100);
    expect(jg.dataset.geojson!.features[0]!.properties!.owner).toBe("team-a");
    expect(jg.dataset.geojson!.features).toHaveLength(map.ds.geojson!.features.length);
  });

  it("orients joins so the unique side is the lookup", () => {
    const o = orientLink([sites, metrics], {
      left: "sites",
      leftField: "site_code",
      right: "metrics",
      rightField: "site",
    });
    expect(o.left.label).toBe("metrics");
    expect(o.leftField).toBe("site");
  });
});

describe("entity keys", () => {
  it("propagates the shared entity through multi-hop links", () => {
    const regions = src("regions", [{ name: "Americas" }, { name: "EMEA" }]);
    const links = [
      { left: "metrics", leftField: "site", right: "sites", rightField: "site_code" },
      { left: "sites", leftField: "region", right: "regions", rightField: "name" },
    ];
    const k = entityKeys([metrics, sites, regions], links)!;
    expect(k.home).toEqual({ label: "sites", field: "site_code" });
    expect(k.tokens.get("regions")).toEqual([["sjc", "nyc"], ["lon"]]);
    expect(k.tokens.get("metrics")!.map((t) => t.join())).toEqual(["sjc", "nyc", "sjc", ""]);
    const j = joinDatasets(metrics, sites, { leftField: "site", rightField: "site_code" }, 100);
    expect(tokensVia(j.dataset.rows, "site", metrics, "site", k.tokens.get("metrics")!)[1]).toEqual(["nyc"]);
    expect(entityKeys([metrics, sites], [])).toBeNull();
  });
});

describe("linked marks", () => {
  const linkOf = (svg: string, sel: string) => {
    const doc = new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
    return Array.from(doc.querySelectorAll(sel)).map((e) => e.getAttribute("data-link"));
  };

  it("extracts keys from rows, groups, series, hierarchy/pie nodes and features", () => {
    expect([...linkValuesOf({ site: "SJC" }, "site")]).toEqual(["sjc"]);
    expect([...linkValuesOf({ rows: [{ site: "A" }, { site: "b" }] }, "site")]).toEqual(["a", "b"]);
    expect([...linkValuesOf([{ site: "A" }, { site: "A" }], "site")]).toEqual(["a"]);
    expect([...linkValuesOf({ data: { site: "x" } }, "site")]).toEqual(["x"]);
    expect([...linkValuesOf({ f: {}, row: { site: "y" } }, "site")]).toEqual(["y"]);
    expect([...linkValuesOf({ _link: "a\u001fb" }, "_link")]).toEqual(["a", "b"]);
  });

  it("tags marks of aggregated bars, lines, scatter, donut, networks and maps", () => {
    const bar = render("bar", sales, {
      encoding: { x: { field: "region" }, y: { field: "revenue" } },
      interaction: { link: "product" },
    });
    expect(bar.svg).toContain('data-link-field="product"');
    expect(linkOf(bar.svg, "rect.mark").every((l) => l === "router|switch")).toBe(true);
    const line = render(
      "line",
      { format: "csv", text: telemetryCsv() },
      {
        encoding: { x: { field: "timestamp" }, y: { field: "latency_ms" }, color: { field: "site" } },
        interaction: { link: "site" },
      },
    );
    expect(linkOf(line.svg, "path.line.mark").sort()).toEqual(["lon", "nyc", "sjc"]);
    const pie = render("donut", sales, {
      encoding: { color: { field: "region" }, value: { field: "revenue" } },
      interaction: { link: "region" },
    });
    expect(linkOf(pie.svg, ".mark").sort()).toEqual(["east", "north", "south", "west"]);
    const net = render("force", network, { interaction: { link: "id" } });
    expect(linkOf(net.svg, "circle.node.mark")).toContain("hub-sjc");
    const map = render("geo", geo, { interaction: { link: "name" } });
    expect(linkOf(map.svg, "path.feature").every((l) => !!l)).toBe(true);
    const none = render("bar", sales, {
      encoding: { x: { field: "region" }, y: { field: "revenue" } },
      interaction: { link: "nope" },
    });
    expect(none.out.warnings.join(" ")).toMatch(/No mark carries the link field "nope"/);
  });

  it("embeds linked records as inert JSON and escapes hostile values", () => {
    const html = buildHtml({
      title: "t",
      charts: [],
      theme: "light",
      d3: "none",
      dashboard: true,
      linked: {
        entity: "site",
        sources: [
          {
            label: "x",
            columns: ["n"],
            rows: [{ n: "</script><script>alert(1)</script>", _k: ["a"] }],
            truncated: false,
          },
        ],
      },
    });
    expect(html).toContain('<script type="application/json" id="d3mcp-linked">');
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain('class="d3mcp-details"');
  });
});
