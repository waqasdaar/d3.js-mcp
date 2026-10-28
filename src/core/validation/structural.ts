import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

export interface StructuralReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: Record<string, number | string | boolean>;
}

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "image",
  "use",
  "animate",
  "set",
  "animatetransform",
  "animatemotion",
  "handler",
  "listener",
]);
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);

/** Validate an SVG document produced by the renderer (or supplied by a user) for safety and structure. */
export function validateSvg(
  svg: string,
  opts: { markSelector?: string; expectedMarks?: number; minMarks?: number } = {},
): StructuralReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: StructuralReport["stats"] = { bytes: Buffer.byteLength(svg, "utf8") };
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) {
    errors.push("DOCTYPE/ENTITY declarations are not allowed in SVG");
    return { valid: false, errors, warnings, stats };
  }
  let dom: JSDOM;
  try {
    dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  } catch (e) {
    errors.push(`SVG is not well-formed XML: ${(e as Error).message.slice(0, 200)}`);
    return { valid: false, errors, warnings, stats };
  }
  try {
    const doc = dom.window.document;
    const root = doc.documentElement;
    if (doc.getElementsByTagName("parsererror").length || root.nodeName === "parsererror") {
      errors.push("SVG is not well-formed XML");
      return { valid: false, errors, warnings, stats };
    }
    if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg")
      errors.push("Root element must be <svg> in the SVG namespace");
    const width = Number(root.getAttribute("width"));
    const height = Number(root.getAttribute("height"));
    if (!(width > 0) || !(height > 0)) errors.push("SVG must have positive width and height");
    if (!root.getAttribute("viewBox")) warnings.push("SVG has no viewBox (not responsive)");
    stats.width = width;
    stats.height = height;
    const all = Array.from(root.querySelectorAll("*"));
    stats.elements = all.length + 1;
    let nanAttrs = 0;
    for (const el of [root, ...all]) {
      const name = el.localName.toLowerCase();
      if (FORBIDDEN_ELEMENTS.has(name)) errors.push(`Forbidden element <${el.localName}>`);
      for (const attr of Array.from(el.attributes)) {
        const an = attr.name.toLowerCase();
        const v = attr.value;
        if (an.startsWith("on")) errors.push(`Event handler attribute "${attr.name}" on <${el.localName}>`);
        if (URL_ATTRS.has(an) && !/^#[A-Za-z0-9_-]+$/.test(v.trim()))
          errors.push(`External or unsafe reference ${attr.name}="${v.slice(0, 60)}"`);
        // Data-derived text in data-*/aria-* attributes is inert; only URL-bearing attributes can activate a scheme.
        if ((URL_ATTRS.has(an) || an === "style") && /javascript:|vbscript:|data:text\/html/i.test(v))
          errors.push(`Unsafe URL scheme in ${attr.name}`);
        if (/url\(\s*['"]?(?!#)/i.test(v)) errors.push(`External url() reference in ${attr.name}`);
        if (
          /\b(NaN|Infinity|undefined)\b/.test(v) &&
          [
            "d",
            "x",
            "y",
            "cx",
            "cy",
            "r",
            "width",
            "height",
            "transform",
            "x1",
            "x2",
            "y1",
            "y2",
            "points",
          ].includes(an)
        )
          nanAttrs++;
      }
      if (name === "style" && /@import|url\(\s*['"]?(?!#)|expression\(/i.test(el.textContent ?? ""))
        errors.push("Unsafe CSS in <style>");
    }
    if (nanAttrs) errors.push(`${nanAttrs} geometry attribute(s) contain NaN/Infinity/undefined`);
    const hasTitle = !!root.querySelector(":scope > title");
    const hasDesc = !!root.querySelector(":scope > desc");
    if (!hasTitle) warnings.push("Missing <title> for accessibility");
    if (!hasDesc) warnings.push("Missing <desc> for accessibility");
    if (root.getAttribute("role") !== "img") warnings.push('Root <svg> should have role="img"');
    stats.accessibleTitle = hasTitle;
    stats.accessibleDesc = hasDesc;
    stats.texts = root.querySelectorAll("text").length;
    if (opts.markSelector) {
      const marks = root.querySelectorAll(opts.markSelector).length;
      stats.marks = marks;
      if (opts.expectedMarks !== undefined && marks !== opts.expectedMarks)
        errors.push(`Expected ${opts.expectedMarks} marks (${opts.markSelector}), found ${marks}`);
      if ((opts.minMarks ?? 1) > marks)
        errors.push(
          `Expected at least ${opts.minMarks ?? 1} mark(s) matching ${opts.markSelector}, found ${marks}`,
        );
    }
  } finally {
    dom.window.close();
  }
  return { valid: errors.length === 0, errors, warnings, stats };
}

/** Validate a standalone HTML artifact: CSP present, scripts pinned by hash, no external resources, embedded SVG safe. */
export function validateHtml(
  html: string,
  opts: { markSelector?: string; expectedMarks?: number } = {},
): StructuralReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: StructuralReport["stats"] = { bytes: Buffer.byteLength(html, "utf8") };
  if (!/^<!DOCTYPE html>/i.test(html.trimStart())) errors.push("Missing <!DOCTYPE html>");
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    if (!doc.documentElement.getAttribute("lang")) warnings.push("Missing lang attribute");
    if (!doc.querySelector("meta[charset]")) errors.push("Missing <meta charset>");
    if (!doc.title) warnings.push("Missing <title>");
    const cspMeta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const csp = cspMeta?.getAttribute("content") ?? "";
    if (!csp) errors.push("Missing Content-Security-Policy");
    if (!/default-src 'none'/.test(csp)) errors.push("CSP must set default-src 'none'");
    const scripts = Array.from(doc.querySelectorAll("script"));
    let executable = 0;
    for (const s of scripts) {
      const type = s.getAttribute("type");
      if (s.hasAttribute("src")) errors.push(`External script not allowed: ${s.getAttribute("src")}`);
      if (type === "application/json") continue;
      executable++;
      const hash =
        "sha256-" +
        createHash("sha256")
          .update(s.textContent ?? "", "utf8")
          .digest("base64");
      if (!csp.includes(`'${hash}'`)) errors.push("Inline script is not pinned by a CSP hash");
    }
    stats.scripts = executable;
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes)) {
        if (a.name.toLowerCase().startsWith("on"))
          errors.push(`Inline event handler ${a.name} on <${el.localName}>`);
      }
    }
    for (const l of Array.from(doc.querySelectorAll("link[href], img[src], iframe, object, embed"))) {
      errors.push(`External resource element <${l.localName}>`);
    }
    const svgs = Array.from(doc.querySelectorAll("svg"));
    stats.svgs = svgs.length;
    if (!svgs.length) errors.push("No <svg> found in HTML");
    let marks = 0;
    for (const svg of svgs) {
      const xml = new dom.window.XMLSerializer().serializeToString(svg);
      const r = validateSvg(xml, {
        ...(opts.markSelector ? { markSelector: opts.markSelector, minMarks: 0 } : {}),
      });
      errors.push(...r.errors.map((e) => `embedded SVG: ${e}`));
      marks += Number(r.stats.marks ?? 0);
    }
    if (opts.markSelector) {
      stats.marks = marks;
      if (opts.expectedMarks !== undefined && marks !== opts.expectedMarks)
        errors.push(`Expected ${opts.expectedMarks} marks in HTML, found ${marks}`);
    }
  } finally {
    dom.window.close();
  }
  return { valid: errors.length === 0, errors, warnings, stats };
}

export function validatePng(buf: Buffer): StructuralReport {
  const errors: string[] = [];
  const sig = buf.subarray(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") errors.push("Not a PNG (bad signature)");
  const width = buf.length >= 24 ? buf.readUInt32BE(16) : 0;
  const height = buf.length >= 24 ? buf.readUInt32BE(20) : 0;
  if (!(width > 0 && height > 0)) errors.push("PNG has zero dimensions");
  if (buf.length < 1000) errors.push("PNG is suspiciously small (possibly blank)");
  return { valid: errors.length === 0, errors, warnings: [], stats: { bytes: buf.length, width, height } };
}

export function validatePdf(buf: Buffer): StructuralReport {
  const errors: string[] = [];
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") errors.push("Not a PDF (bad header)");
  if (buf.length < 1000) errors.push("PDF is suspiciously small");
  return { valid: errors.length === 0, errors, warnings: [], stats: { bytes: buf.length } };
}
