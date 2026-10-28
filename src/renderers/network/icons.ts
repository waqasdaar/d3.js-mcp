import { z } from "zod";
import { D3McpError } from "../../shared/errors.js";

export interface IconPath {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fillRule?: "nonzero" | "evenodd";
  linecap?: "butt" | "round" | "square";
  linejoin?: "miter" | "round" | "bevel";
  transform?: string;
}

export interface IconDef {
  viewBox: [number, number, number, number];
  paths: IconPath[];
}

const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,20000}$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|rgba?\([0-9\s.,%]+\)|hsla?\([0-9\s.,%deg]+\))$/;
const TRANSFORM = /^\s*((matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE\s.,+-]*\)\s*,?\s*){1,8}$/;
const ICON_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export const IconPathSchema = z
  .object({
    d: z.string().regex(PATH_D, "Path data may only contain SVG path commands and numbers"),
    fill: z.string().regex(COLOR, "Use a hex, rgb(), hsl() or named color").optional(),
    stroke: z.string().regex(COLOR, "Use a hex, rgb(), hsl() or named color").optional(),
    strokeWidth: z.number().min(0).max(100).optional(),
    fillRule: z.enum(["nonzero", "evenodd"]).optional(),
    linecap: z.enum(["butt", "round", "square"]).optional(),
    linejoin: z.enum(["miter", "round", "bevel"]).optional(),
    transform: z
      .string()
      .regex(TRANSFORM, "Only matrix/translate/scale/rotate/skew transforms are allowed")
      .optional(),
  })
  .strict();

export const CustomIconSchema = z
  .object({
    viewBox: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).optional(),
    paths: z.array(IconPathSchema).min(1).max(64).optional(),
    svg: z
      .string()
      .max(50_000)
      .optional()
      .describe(
        "SVG markup of a single icon; only basic shapes are kept (path, circle, ellipse, rect, line, polyline, polygon)",
      ),
  })
  .strict()
  .refine((v) => (v.paths ? 1 : 0) + (v.svg ? 1 : 0) === 1, "Provide exactly one of 'paths' or 'svg'");
export type CustomIcon = z.infer<typeof CustomIconSchema>;

export const IconMapSchema = z
  .record(z.string().regex(ICON_NAME), CustomIconSchema)
  .refine((r) => Object.keys(r).length <= 50, "At most 50 custom icons");

const stroke = (d: string): IconPath => ({
  d,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  linecap: "round",
  linejoin: "round",
});
const icon = (...d: string[]): IconDef => ({ viewBox: [0, 0, 24, 24], paths: d.map(stroke) });

/** Built-in 24×24 line icons for common network and IT elements. */
export const BUILTIN_ICONS: Record<string, IconDef> = {
  router: icon(
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
    "M7 9.5h10M14.5 7l2.5 2.5-2.5 2.5",
    "M17 14.5H7M9.5 12L7 14.5 9.5 17",
  ),
  switch: icon("M3 7h18v10H3z", "M6.5 10.5h11M15.5 8.7l2 1.8-2 1.8", "M17.5 13.5h-11M8.5 11.7l-2 1.8 2 1.8"),
  firewall: icon(
    "M3 5h18v14H3z",
    "M3 9.7h18M3 14.3h18",
    "M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19",
  ),
  server: icon("M4 4h16v6H4zM4 14h16v6H4z", "M8 7h.01M8 17h.01M12 7h4M12 17h4"),
  cloud: icon("M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18z"),
  database: icon(
    "M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z",
    "M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6",
    "M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3",
  ),
  laptop: icon("M5 5h14v10H5z", "M2 19h20"),
  desktop: icon("M3 4h18v12H3z", "M8 20h8M12 16v4"),
  phone: icon("M7 2h10v20H7z", "M11 18h2"),
  "access-point": icon(
    "M2 9a14 14 0 0 1 20 0",
    "M5 12.5a10 10 0 0 1 14 0",
    "M8.5 15.8a5 5 0 0 1 7 0",
    "M12 19.5h.01",
  ),
  "load-balancer": icon(
    "M10 3h4v4h-4z",
    "M12 7v4M5 11h14M5 11v4M12 11v4M19 11v4",
    "M3 15h4v5H3zM10 15h4v5h-4zM17 15h4v5h-4z",
  ),
  internet: icon(
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z",
    "M3 12h18",
    "M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z",
  ),
  user: icon("M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M4 21a8 8 0 0 1 16 0"),
  vpn: icon("M6 11h12v10H6z", "M8 11V7a4 4 0 0 1 8 0v4", "M12 15v2"),
  controller: icon(
    "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z",
    "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  ),
  storage: icon("M3 6h18v4H3zM3 14h18v4H3z", "M6 8h.01M6 16h.01"),
  camera: icon("M3 7h13v10H3z", "M16 10l5-3v10l-5-3"),
  iot: icon("M8 8h8v8H8z", "M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"),
};

const ALIASES: Record<string, string> = {
  rtr: "router",
  "wan-edge": "router",
  edge: "router",
  sw: "switch",
  "l2-switch": "switch",
  "l3-switch": "switch",
  fw: "firewall",
  host: "server",
  vm: "server",
  db: "database",
  pc: "desktop",
  workstation: "desktop",
  mobile: "phone",
  ap: "access-point",
  wifi: "access-point",
  wireless: "access-point",
  lb: "load-balancer",
  globe: "internet",
  wan: "internet",
  saas: "cloud",
  person: "user",
  nas: "storage",
  san: "storage",
  sensor: "iot",
};

export const BUILTIN_ICON_NAMES = Object.keys(BUILTIN_ICONS);

const SHAPES = "path,circle,ellipse,rect,line,polyline,polygon";
const NON_RENDERED =
  "defs,clipPath,mask,symbol,pattern,marker,linearGradient,radialGradient,title,desc,metadata";

function num(el: Element, a: string): number {
  const v = Number.parseFloat(el.getAttribute(a) ?? "0");
  return Number.isFinite(v) ? v : 0;
}

function shapeToPath(el: Element): string | null {
  switch (el.localName) {
    case "path":
      return el.getAttribute("d");
    case "circle":
    case "ellipse": {
      const cx = num(el, "cx");
      const cy = num(el, "cy");
      const rx = el.localName === "circle" ? num(el, "r") : num(el, "rx");
      const ry = el.localName === "circle" ? num(el, "r") : num(el, "ry");
      if (!(rx > 0 && ry > 0)) return null;
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`;
    }
    case "rect": {
      const w = num(el, "width");
      const h = num(el, "height");
      if (!(w > 0 && h > 0)) return null;
      return `M${num(el, "x")} ${num(el, "y")}h${w}v${h}h${-w}z`;
    }
    case "line":
      return `M${num(el, "x1")} ${num(el, "y1")}L${num(el, "x2")} ${num(el, "y2")}`;
    case "polyline":
    case "polygon": {
      const pts = (el.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (pts.length < 4 || pts.some((n) => !Number.isFinite(n))) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return el.localName === "polygon" ? `${d}z` : d;
    }
  }
  return null;
}

function styleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute("style");
  if (style) {
    for (const decl of style.split(";")) {
      const [k, ...v] = decl.split(":");
      if (k?.trim().toLowerCase() === prop) return v.join(":").trim();
    }
  }
  return el.getAttribute(prop);
}

/** Inherited presentation value (element → ancestors → root svg). */
function inherited(el: Element, root: Element, prop: string): string | null {
  for (let cur: Element | null = el; cur; cur = cur === root ? null : cur.parentElement) {
    const v = styleProp(cur, prop);
    if (v !== null && v !== "inherit") return v.trim();
  }
  return null;
}

/**
 * Convert untrusted SVG icon markup into sanitized path geometry. Nothing from the markup is inserted verbatim:
 * only path data, validated colors/transforms and stroke settings survive.
 */
export function parseSvgIcon(doc: Document, name: string, markup: string, warnings: string[]): IconDef {
  if (/<!DOCTYPE|<!ENTITY/i.test(markup))
    throw new D3McpError("SECURITY_VIOLATION", `Icon "${name}": DOCTYPE/ENTITY declarations are not allowed`);
  const Parser = (doc.defaultView as (Window & typeof globalThis) | null)?.DOMParser;
  if (!Parser) throw new D3McpError("RENDER_FAILED", "No DOMParser available to read SVG icons");
  const xml = new Parser().parseFromString(markup, "image/svg+xml");
  const root = xml.documentElement;
  if (root.localName !== "svg" || xml.getElementsByTagName("parsererror").length) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Icon "${name}": not well-formed SVG markup`,
      "Pass a single <svg>…</svg> element.",
    );
  }
  const vb = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox: IconDef["viewBox"] =
    vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
      ? [vb[0]!, vb[1]!, vb[2]!, vb[3]!]
      : [0, 0, num(root, "width") || 24, num(root, "height") || 24];
  const paths: IconPath[] = [];
  let dropped = 0;
  for (const el of Array.from(root.querySelectorAll(SHAPES))) {
    if (el.closest(NON_RENDERED)) continue;
    if (paths.length >= 64) {
      dropped++;
      continue;
    }
    const d = shapeToPath(el);
    if (!d || !PATH_D.test(d)) {
      dropped++;
      continue;
    }
    const p: IconPath = { d };
    const color = (prop: "fill" | "stroke"): string | undefined => {
      const v = inherited(el, root, prop);
      if (v === null) return prop === "fill" ? "currentColor" : undefined;
      if (COLOR.test(v)) return v;
      warnings.push(`Icon "${name}": unsupported ${prop} "${v.slice(0, 40)}" replaced with currentColor.`);
      return "currentColor";
    };
    p.fill = color("fill");
    const s = color("stroke");
    if (s) p.stroke = s;
    const sw = Number.parseFloat(inherited(el, root, "stroke-width") ?? "");
    if (Number.isFinite(sw) && sw >= 0 && sw <= 100) p.strokeWidth = sw;
    const fr = inherited(el, root, "fill-rule");
    if (fr === "evenodd" || fr === "nonzero") p.fillRule = fr;
    const lc = inherited(el, root, "stroke-linecap");
    if (lc === "round" || lc === "butt" || lc === "square") p.linecap = lc;
    const lj = inherited(el, root, "stroke-linejoin");
    if (lj === "round" || lj === "miter" || lj === "bevel") p.linejoin = lj;
    const chain: string[] = [];
    for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
      const t = cur.getAttribute("transform");
      if (t) chain.unshift(t);
    }
    if (chain.length) {
      const t = chain.join(" ");
      if (!TRANSFORM.test(t)) {
        dropped++;
        continue;
      }
      p.transform = t;
    }
    paths.push(p);
  }
  const ignored = root.querySelectorAll("text,image,use,foreignObject,script,style,a").length;
  if (ignored)
    warnings.push(
      `Icon "${name}": ignored ${ignored} unsupported element(s) (text, image, use, script, style, …).`,
    );
  if (dropped)
    warnings.push(`Icon "${name}": dropped ${dropped} shape(s) with invalid geometry or transforms.`);
  if (!paths.length)
    throw new D3McpError(
      "INVALID_INPUT",
      `Icon "${name}": no drawable shapes found`,
      "Use path, circle, ellipse, rect, line, polyline or polygon elements.",
    );
  return { viewBox, paths };
}

/** Built-in icons plus validated custom icons (custom names override built-ins). */
export function resolveIconSet(
  doc: Document,
  custom: Record<string, CustomIcon> | undefined,
  warnings: string[],
): Map<string, IconDef> {
  const set = new Map<string, IconDef>(Object.entries(BUILTIN_ICONS));
  for (const [name, def] of Object.entries(custom ?? {})) {
    set.set(
      iconKey(name),
      def.svg
        ? parseSvgIcon(doc, name, def.svg, warnings)
        : { viewBox: def.viewBox ?? [0, 0, 24, 24], paths: def.paths! },
    );
  }
  return set;
}

function iconKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function lookupIcon(set: Map<string, IconDef>, value: string): string | null {
  const k = iconKey(value);
  if (set.has(k)) return k;
  const alias = ALIASES[k];
  return alias && set.has(alias) ? alias : null;
}
