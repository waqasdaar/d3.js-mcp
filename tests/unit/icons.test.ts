import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/core/schema/spec.js";
import { validateSvg } from "../../src/core/validation/structural.js";
import { BUILTIN_ICON_NAMES } from "../../src/renderers/network/icons.js";
import { customSvgIcon, network, TIER_ORDER, topology } from "../fixtures/data.js";
import { render } from "../helpers/render.js";

function doc(svg: string) {
  return new JSDOM(svg, { contentType: "image/svg+xml" }).window.document;
}

function check(r: ReturnType<typeof render>) {
  expect(
    validateSvg(r.svg, { markSelector: r.out.markSelector, expectedMarks: r.out.markCount }).errors,
  ).toEqual([]);
  return doc(r.svg);
}

const iconOf = (d: Document, id: string) =>
  d.querySelector(`g.node-icon[data-id="${id}"]`)?.getAttribute("data-icon");

describe("topology icons", () => {
  it("auto-detects device types (with aliases) and draws one icon per node", () => {
    const r = render("force", topology, { options: { seed: 3 } });
    const d = check(r);
    expect(d.querySelectorAll("circle.node")).toHaveLength(topology.nodes.length);
    expect(d.querySelectorAll("g.node-icon")).toHaveLength(topology.nodes.length);
    expect(iconOf(d, "fw-2")).toBe("firewall");
    expect(iconOf(d, "dist-1")).toBe("switch");
    expect(iconOf(d, "ap-1")).toBe("access-point");
    expect(iconOf(d, "pc-1")).toBe("desktop");
    expect(r.out.warnings.join(" ")).toMatch(/icons taken from field "type"/);
    expect(r.out.meta.icons).toEqual(expect.arrayContaining([{ icon: "router", count: 2 }]));
  });

  it("centres each icon on its node", () => {
    const d = check(render("force", topology, { options: { seed: 3 } }));
    for (const c of Array.from(d.querySelectorAll("circle.node"))) {
      const ic = d.querySelector(`g.node-icon[data-id="${c.getAttribute("data-id")}"]`)!;
      const m = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(ic.getAttribute("transform")!)!;
      const k = Number(m[3]);
      expect(Number(m[1]) + 12 * k).toBeCloseTo(Number(c.getAttribute("cx")), 3);
      expect(Number(m[2]) + 12 * k).toBeCloseTo(Number(c.getAttribute("cy")), 3);
      expect(12 * k * 2).toBeLessThan(Number(c.getAttribute("r")) * 2);
    }
  });

  it("maps group values to icons with iconMap", () => {
    const r = render("force", network, {
      encoding: { color: { field: "group" } },
      options: {
        seed: 1,
        iconMap: { hub: "router", branch: "switch", datacenter: "server", cloud: "cloud" },
      },
    });
    const d = check(r);
    expect(iconOf(d, "hub-sjc")).toBe("router");
    expect(iconOf(d, "br-sfo")).toBe("switch");
    expect(iconOf(d, "dc-1")).toBe("server");
    expect(iconOf(d, "cloud")).toBe("cloud");
  });

  it("uses custom path icons and custom SVG icons", () => {
    const nodes = topology.nodes.map((n) =>
      n.id === "srv-1"
        ? { ...n, icon: "k8s" }
        : n.id === "db-1"
          ? { ...n, icon: "nic" }
          : { ...n, icon: n.type },
    );
    const r = render(
      "force",
      { nodes, links: topology.links },
      {
        options: {
          seed: 3,
          icons: {
            k8s: {
              viewBox: [0, 0, 100, 100],
              paths: [
                { d: "M50 5L90 27v46L50 95 10 73V27z", fill: "#326ce5" },
                {
                  d: "M50 30a20 20 0 1 0 0 40a20 20 0 1 0 0-40z",
                  fill: "none",
                  stroke: "white",
                  strokeWidth: 8,
                },
              ],
            },
            nic: { svg: customSvgIcon },
          },
        },
      },
    );
    const d = check(r);
    expect(iconOf(d, "srv-1")).toBe("k8s");
    expect(d.querySelector('g.node-icon[data-id="srv-1"] path')!.getAttribute("fill")).toBe("#326ce5");
    const nic = d.querySelector('g.node-icon[data-id="db-1"]')!;
    expect(nic.getAttribute("data-icon")).toBe("nic");
    const paths = Array.from(nic.querySelectorAll("path"));
    // rect + circle + polyline + line → 4 sanitized paths; inherited root stroke settings and the group transform are kept.
    expect(paths).toHaveLength(4);
    expect(nic.querySelectorAll("rect,circle,polyline,line,g g")).toHaveLength(0);
    expect(
      paths.every((p) => p.getAttribute("stroke") === "currentColor" && p.getAttribute("fill") === "none"),
    ).toBe(true);
    expect(paths[2]!.getAttribute("transform")).toBe("translate(1 0)");
    expect(paths[1]!.getAttribute("d")).toMatch(/^M5 12a2 2/);
  });

  it("sanitizes hostile custom SVG icons", () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" onload="alert(1)">' +
      "<script>alert(2)</script><foreignObject><div>x</div></foreignObject>" +
      '<a xlink:href="javascript:alert(3)"><path d="M2 2h20v20H2z" fill="url(#g)" onclick="alert(4)"/></a>' +
      '<image href="http://169.254.169.254/x"/><use href="#p"/>' +
      '<path d="M4 4L20 20" style="stroke:red;fill:none" transform="url(evil)"/>' +
      '<circle cx="12" cy="12" r="4" fill="expression(alert(5))"/></svg>';
    const r = render("force", topology, { options: { seed: 3, icons: { router: { svg: evil } } } });
    expect(r.svg).not.toMatch(
      /alert|javascript|onload|onclick|169\.254|<script|foreignObject|<image|<use|expression|url\(/i,
    );
    check(r);
    const warn = r.out.warnings.join(" ");
    expect(warn).toMatch(/unsupported fill "url\(#g\)"/);
    expect(warn).toMatch(/ignored \d+ unsupported element/);
    expect(warn).toMatch(/dropped 1 shape/);
  });

  it("rejects DOCTYPE/ENTITY in custom SVG icons", () => {
    const xxe =
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>';
    expect(() => render("force", topology, { options: { icons: { router: { svg: xxe } } } })).toThrow(
      /DOCTYPE/,
    );
  });

  it("rejects script injection through path data, colors and transforms at the schema level", () => {
    const base = { id: "x", type: "force", data: { datasetId: "d" } };
    expect(() =>
      parseSpec({
        ...base,
        options: { icons: { a: { paths: [{ d: 'M0 0"/><script>alert(1)</script>' }] } } },
      }),
    ).toThrow();
    expect(() =>
      parseSpec({
        ...base,
        options: { icons: { a: { paths: [{ d: "M0 0", fill: "url(javascript:alert(1))" }] } } },
      }),
    ).toThrow();
    expect(() =>
      parseSpec({ ...base, options: { icons: { a: { paths: [{ d: "M0 0", transform: "url(x)" }] } } } }),
    ).toThrow();
    expect(() =>
      parseSpec({ ...base, options: { icons: { a: { paths: [{ d: "M0 0" }], svg: "<svg/>" } } } }),
    ).toThrow(/exactly one/);
    expect(() =>
      parseSpec({ ...base, options: { icons: { "../x": { paths: [{ d: "M0 0" }] } } } }),
    ).toThrow();
  });

  it("warns about unknown icon names and still renders those nodes", () => {
    const nodes = topology.nodes.map((n, i) => ({ ...n, icon: i === 0 ? "toaster" : n.type }));
    const r = render("force", { nodes, links: topology.links }, { options: { seed: 3 } });
    const d = check(r);
    expect(d.querySelectorAll("g.node-icon")).toHaveLength(topology.nodes.length - 1);
    expect(r.out.warnings.join(" ")).toMatch(/No icon for toaster/);
    expect(r.out.warnings.join(" ")).toContain(BUILTIN_ICON_NAMES[0]!);
  });

  it("supports plain icon style and radial networks", () => {
    const plain = check(render("force", topology, { options: { seed: 3, iconStyle: "plain" } }));
    const c = plain.querySelector('circle.node[data-id="core-1"]')!;
    expect(c.getAttribute("fill")).toBe("#ffffff");
    expect(plain.querySelector('g.node-icon[data-id="core-1"]')!.getAttribute("color")).not.toBe("#ffffff");
    const radial = check(
      render("radial-network", topology, { encoding: { color: { field: "tier" } }, options: { seed: 3 } }),
    );
    expect(radial.querySelectorAll("g.node-icon")).toHaveLength(topology.nodes.length);
  });

  it("rejects an iconField that does not exist", () => {
    expect(() => render("force", topology, { options: { iconField: "nope" } })).toThrow(/iconField "nope"/);
  });
});

describe("tiered topology layout", () => {
  it("places tiers in top-to-bottom order", () => {
    const r = render("force", topology, {
      encoding: { color: { field: "tier" } },
      options: { seed: 3, tierField: "tier", tierOrder: TIER_ORDER },
    });
    const d = check(r);
    expect(r.out.meta.tiers).toEqual(TIER_ORDER);
    const y = (tier: string) => {
      const ids = topology.nodes.filter((n) => n.tier === tier).map((n) => n.id);
      const ys = ids.map((id) => Number(d.querySelector(`circle.node[data-id="${id}"]`)!.getAttribute("cy")));
      return { min: Math.min(...ys), max: Math.max(...ys) };
    };
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(y(TIER_ORDER[i]!).min, `${TIER_ORDER[i - 1]} above ${TIER_ORDER[i]}`).toBeGreaterThan(
        y(TIER_ORDER[i - 1]!).max,
      );
    }
  });

  it("rejects a tierField that does not exist", () => {
    expect(() => render("force", topology, { options: { tierField: "floor" } })).toThrow(/tierField "floor"/);
  });
});
