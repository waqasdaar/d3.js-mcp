import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { escapeHtml, jsonForScript } from "../shared/escape.js";
import { RUNTIME_JS } from "./runtime.js";

export type D3Embed = "inline" | "none";

export interface HtmlChart {
  svg: string;
  specId: string;
  title?: string;
  canvas?: { points: unknown[]; width: number; left: number; top: number };
}

export interface HtmlOptions {
  title: string;
  description?: string;
  charts: HtmlChart[];
  findings?: string[];
  warnings?: string[];
  theme: "light" | "dark";
  d3: D3Embed;
  dashboard?: boolean;
  columns?: number;
  kpis?: Array<{ label: string; value: string; detail?: string }>;
  /** Records shown in the detail panel when a linked entity is selected (rows carry their key token in `_k`). */
  linked?: LinkedPanelData;
}

export interface LinkedPanelData {
  entity: string;
  sources: Array<{
    label: string;
    columns: string[];
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
  }>;
}

let d3Bundle: string | null = null;
export function d3BundleSource(): { code: string; version: string; path: string } {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("d3");
  const root = path.resolve(path.dirname(entry), "..");
  const file = path.join(root, "dist", "d3.min.js");
  if (d3Bundle === null) d3Bundle = readFileSync(file, "utf8").replace(/<\/script/gi, "<\\/script");
  const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string })
    .version;
  return { code: d3Bundle, version, path: file };
}

function sha256(content: string): string {
  return "sha256-" + createHash("sha256").update(content, "utf8").digest("base64");
}

const CSS = (dark: boolean) => `
:root{color-scheme:${dark ? "dark" : "light"};--bg:${dark ? "#0d1117" : "#f6f8fa"};--card:${dark ? "#161b22" : "#ffffff"};--fg:${dark ? "#e6edf3" : "#1f2328"};--muted:${dark ? "#9198a1" : "#59636e"};--border:${dark ? "#30363d" : "#d1d9e0"}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:20px;margin:0 0 4px}
.d3mcp-desc{color:var(--muted);margin:0 0 12px;font-size:14px}
.d3mcp-grid{display:grid;gap:16px;grid-template-columns:repeat(var(--cols,1),minmax(0,1fr))}
@media (max-width:900px){.d3mcp-grid{grid-template-columns:minmax(0,1fr)}}
.d3mcp-card{position:relative;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px;overflow:hidden}
.d3mcp-toolbar,.d3mcp-dashboard-controls{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px;min-height:0}
.d3mcp-toolbar:empty{display:none}
.d3mcp-btn,.d3mcp-search,.d3mcp-filter{font:inherit;font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--fg)}
.d3mcp-tooltip{position:absolute;z-index:10;pointer-events:none;white-space:pre-line;max-width:320px;padding:6px 8px;font-size:12px;line-height:1.4;border-radius:6px;background:rgba(17,17,17,.92);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.d3mcp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.d3mcp-canvas{position:absolute;pointer-events:none}
svg.d3mcp-root{display:block;width:100%;height:auto}
svg .mark.hover{opacity:.8}
svg .mark.linked:not(.line):not(.density):not(.contour){stroke:currentColor;stroke-width:2}
svg .mark.dimmed{opacity:.18}
svg .node-icon.dimmed{opacity:.18}
svg .mark.selected:not(.line):not(.density):not(.contour){stroke:var(--fg);stroke-width:1.5}
svg .mark.selected.line,svg .mark.selected.density,svg .mark.selected.contour{stroke-width:3}
svg .mark:focus{outline:none;stroke:#f2a900;stroke-width:3}
@media (prefers-reduced-motion:no-preference){svg .mark{transition:opacity .15s}}
.d3mcp-findings{margin-top:16px;font-size:14px}
.d3mcp-findings li{margin:4px 0}
.d3mcp-warn{color:#b35900}
.d3mcp-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:0 0 16px}
.d3mcp-kpi{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.d3mcp-kpi .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.d3mcp-kpi .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.d3mcp-kpi .d{font-size:12px;color:var(--muted);margin-top:2px}
svg.d3mcp-root[data-link-field] .mark[data-link]{cursor:pointer}
.d3mcp-details{margin-top:16px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
.d3mcp-details h3{font-size:13px;margin:12px 0 4px}
.d3mcp-table-wrap{overflow-x:auto;max-height:320px}
.d3mcp-details table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.d3mcp-details th,.d3mcp-details td{border-bottom:1px solid var(--border);padding:3px 8px;text-align:left;white-space:nowrap}
.d3mcp-details th{position:sticky;top:0;background:var(--card)}
`;

/** Build a self-contained HTML document. All inline scripts are pinned by SHA-256 hashes in the CSP. */
export function buildHtml(opts: HtmlOptions): string {
  const dark = opts.theme === "dark";
  const scripts: string[] = [];
  if (opts.d3 === "inline") scripts.push(d3BundleSource().code);
  scripts.push(RUNTIME_JS);
  const csp = [
    "default-src 'none'",
    `script-src ${scripts.map((s) => `'${sha256(s)}'`).join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const cards = opts.charts
    .map((c) => {
      const canvasJson = c.canvas
        ? `<script type="application/json" id="d3mcp-canvas-${escapeHtml(c.specId)}">${jsonForScript(c.canvas)}</script>`
        : "";
      return `<section class="d3mcp-card" aria-label="${escapeHtml(c.title ?? "chart")}"><div class="d3mcp-toolbar"></div>${c.svg}${canvasJson}</section>`;
    })
    .join("\n");
  const list = (items: string[] | undefined, cls: string, heading: string) =>
    items && items.length
      ? `<section class="d3mcp-findings ${cls}"><h2 style="font-size:15px">${heading}</h2><ul>${items.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></section>`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="generator" content="d3-visualization-mcp">
<title>${escapeHtml(opts.title)}</title>
<style>${CSS(dark)}</style>
</head>
<body>
<main${opts.dashboard ? " data-dashboard" : ""}>
<h1>${escapeHtml(opts.title)}</h1>
${opts.description ? `<p class="d3mcp-desc">${escapeHtml(opts.description)}</p>` : ""}
${opts.dashboard ? '<div class="d3mcp-dashboard-controls"></div>' : ""}
${
  opts.kpis?.length
    ? `<section class="d3mcp-kpis" aria-label="Key figures">${opts.kpis.map((k) => `<div class="d3mcp-kpi"><div class="l">${escapeHtml(k.label)}</div><div class="v">${escapeHtml(k.value)}</div>${k.detail ? `<div class="d">${escapeHtml(k.detail)}</div>` : ""}</div>`).join("")}</section>`
    : ""
}
<div class="d3mcp-grid" style="--cols:${Math.max(1, Math.min(4, opts.columns ?? 1))}">
${cards}
</div>
${opts.linked ? `<section class="d3mcp-details" aria-live="polite" aria-label="Linked records"></section><script type="application/json" id="d3mcp-linked">${jsonForScript(opts.linked)}</script>` : ""}
${list(opts.findings, "", "Findings")}
${list(opts.warnings, "d3mcp-warn", "Notes and limitations")}
</main>
${scripts.map((s) => `<script>${s}</script>`).join("\n")}
</body>
</html>
`;
}
