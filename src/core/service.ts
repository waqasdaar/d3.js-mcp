import { readFile } from "node:fs/promises";
import path from "node:path";
import { csvFormat } from "d3";
import type { Config } from "../shared/config.js";
import { D3McpError } from "../shared/errors.js";
import { log } from "../shared/logger.js";
import { RenderPool } from "../renderers/pool.js";
import type { RenderInfo, SvgRenderResult } from "../renderers/render-svg.js";
import { applyTransforms } from "../renderers/transforms.js";
import { buildHtml, type D3Embed, type HtmlChart, type LinkedPanelData } from "../export/html.js";
import { htmlToPdf, htmlToPng, inspectHtml, svgToPng, type BrowserInspection } from "../export/browser.js";
import { ArtifactStore, type ArtifactFormat, type ArtifactRecord } from "./artifacts/store.js";
import { ingest } from "./data/ingest.js";
import { resolveFileInput } from "./data/files.js";
import {
  entityKeys,
  joinDatasets,
  orientLink,
  tokensVia,
  type LinkSource,
  type LinkSpec,
} from "./data/link.js";
import { profileDataset } from "./data/profile.js";
import type { Dataset, Row } from "./data/types.js";
import { computeFindings } from "./planning/findings.js";
import {
  computeKpis,
  planDashboardCandidates,
  type DashboardCandidate,
  type Kpi,
} from "./planning/dashboard.js";
import { planVisualization, type PlanOptions } from "./planning/planner.js";
import type { VisualizationSpec } from "./schema/spec.js";
import { validateHtml, validatePdf, validatePng } from "./validation/structural.js";

export const FORMATS = ["html", "svg", "png", "pdf", "json", "csv"] as const;

export interface RenderOptions {
  formats: ArtifactFormat[];
  sessionId: string;
  validateInBrowser?: boolean;
  d3Embed?: D3Embed;
  parentArtifactId?: string;
  findings?: string[];
  extraWarnings?: string[];
}

export interface RenderedArtifact {
  record: ArtifactRecord;
  render: RenderInfo;
  findings: string[];
  browser?: BrowserInspection;
}

function newArtifactId(prefix = "art"): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class VisualizationService {
  private readonly pool: RenderPool;

  constructor(
    readonly config: Config,
    readonly store: ArtifactStore,
  ) {
    this.pool = new RenderPool(config.renderWorkers, config.renderTimeoutMs, config.logLevel);
  }

  get renderPoolStats() {
    return this.pool.stats;
  }

  private limits() {
    return {
      maxSvgMarks: this.config.maxSvgMarks,
      maxForceNodes: this.config.maxForceNodes,
      maxForceLinks: this.config.maxForceLinks,
    };
  }

  /** Resolve a data argument: a dataset reference or inline data that is ingested and stored. */
  async resolveData(data: unknown, sessionId: string): Promise<Dataset> {
    if (data && typeof data === "object" && !Array.isArray(data) && "dataset_id" in data) {
      return this.store.getDataset(String((data as { dataset_id: unknown }).dataset_id));
    }
    let ds: Dataset;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof (data as { file?: unknown }).file === "string"
    ) {
      const { data: encoded, file } = await resolveFileInput(data as Record<string, unknown>, this.config);
      ds = ingest(encoded, {
        ...this.config,
        maxInputBytes: Math.max(this.config.maxInputBytes, this.config.maxFileBytes),
      });
      ds.origin = { ...(ds.origin ?? { format: String(encoded.format) }), file };
    } else {
      ds = ingest(data, this.config);
    }
    if (ds.rows.length === 0 && ds.kind === "table") {
      throw new D3McpError("INVALID_INPUT", "Dataset contains no records", "Provide at least one record.");
    }
    await this.store.saveDataset(ds, sessionId);
    return ds;
  }

  datasetSummary(ds: Dataset) {
    const p = profileDataset(ds);
    return {
      datasetId: ds.id,
      kind: ds.kind,
      source: ds.source,
      rowCount: ds.rows.length,
      ...(ds.origin ? { origin: ds.origin } : {}),
      ...(ds.links ? { linkCount: ds.links.length } : {}),
      fields: p.fields.map((f) => ({ name: f.name, type: f.type, missing: f.missing, unique: f.unique })),
      transformations: ds.transformations,
      warnings: ds.warnings,
    };
  }

  renderSvg(spec: VisualizationSpec, ds: Dataset): Promise<SvgRenderResult> {
    return this.pool.render(spec, ds, this.limits());
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private canvasFor(spec: VisualizationSpec, out: RenderInfo): HtmlChart["canvas"] | undefined {
    if (spec.renderer !== "canvas" || !Array.isArray(out.meta.canvasPoints)) return undefined;
    const m = spec.layout.margin;
    return {
      points: out.meta.canvasPoints as unknown[],
      width: out.width,
      left: Math.max(m.left, 0),
      top: m.top,
    };
  }

  async renderArtifact(spec: VisualizationSpec, ds: Dataset, opts: RenderOptions): Promise<RenderedArtifact> {
    const { svg, out, report } = await this.renderSvg(spec, ds);
    const findings = opts.findings ?? computeFindings(spec, ds);
    const warnings = [...new Set([...(opts.extraWarnings ?? []), ...out.warnings])];
    const canvas = this.canvasFor(spec, out);
    // The plot margins may be adjusted by the renderer (e.g. legend space); read the effective translate from the SVG.
    if (canvas) {
      const m = /class="plot" transform="translate\(([-\d.]+),([-\d.]+)\)"/.exec(svg);
      if (m) {
        canvas.left = Number(m[1]);
        canvas.top = Number(m[2]);
      }
    }
    const html = buildHtml({
      title: spec.title ?? spec.type,
      ...(spec.description || spec.subtitle ? { description: spec.description ?? spec.subtitle } : {}),
      charts: [
        { svg, specId: spec.id, ...(spec.title ? { title: spec.title } : {}), ...(canvas ? { canvas } : {}) },
      ],
      findings,
      warnings,
      theme: spec.theme,
      d3: opts.d3Embed ?? "inline",
    });
    const htmlReport = validateHtml(html, { markSelector: out.markSelector, expectedMarks: out.markCount });
    if (!htmlReport.valid)
      throw new D3McpError(
        "VALIDATION_FAILED",
        `HTML artifact failed validation: ${htmlReport.errors.slice(0, 5).join("; ")}`,
        undefined,
        htmlReport,
      );

    const id = newArtifactId();
    const dir = await this.store.createArtifactDir(opts.sessionId, id);
    await this.store.saveSpec(spec, opts.sessionId);
    const files: ArtifactRecord["files"] = {};
    const exportErrors: ArtifactRecord["exportErrors"] = {};
    const validation: Record<string, unknown> = { svg: report, html: htmlReport };
    const formats = new Set<ArtifactFormat>(["svg", "html", "json", ...opts.formats]);
    files.svg = await this.store.writeArtifactFile(dir, "chart.svg", svg);
    files.html = await this.store.writeArtifactFile(dir, "chart.html", html);
    files.json = await this.store.writeArtifactFile(dir, "spec.json", JSON.stringify(spec, null, 2));
    if (formats.has("csv")) {
      const { rows } = applyTransforms(ds.rows, spec.transforms);
      files.csv = await this.store.writeArtifactFile(dir, "data.csv", csvFormat(rows));
    }
    if (formats.has("png")) await this.exportPng(svg, dir, spec, files, exportErrors, validation);
    if (formats.has("pdf")) await this.exportPdf(html, dir, spec, files, exportErrors, validation);
    let browser: BrowserInspection | undefined;
    if (opts.validateInBrowser) {
      try {
        browser = await inspectHtml(html, {
          markSelector: out.markSelector,
          expectedMarks: out.markCount,
          timeoutMs: this.config.browserTimeoutMs,
          screenshotPath: path.join(dir, "screenshot.png"),
        });
        validation.browser = browser;
      } catch (e) {
        validation.browser = { ok: false, error: (e as Error).message };
      }
    }
    const record: ArtifactRecord = {
      id,
      sessionId: opts.sessionId,
      kind: "visualization",
      title: spec.title ?? spec.type,
      visualizationType: spec.type,
      specIds: [spec.id],
      datasetIds: [ds.id],
      createdAt: new Date().toISOString(),
      dir,
      width: out.width,
      height: out.height,
      markCount: out.markCount,
      markSelector: out.markSelector,
      files,
      exportErrors,
      validation,
      warnings,
      ...(opts.parentArtifactId ? { parentArtifactId: opts.parentArtifactId } : {}),
    };
    await this.store.saveRecord(record);
    return { record, render: out, findings, ...(browser ? { browser } : {}) };
  }

  private async exportPng(
    svg: string,
    dir: string,
    spec: VisualizationSpec,
    files: ArtifactRecord["files"],
    errors: ArtifactRecord["exportErrors"],
    validation: Record<string, unknown>,
  ): Promise<void> {
    try {
      const p = path.join(dir, "chart.png");
      await svgToPng(svg, p, spec.layout, spec.layout.pixelRatio, this.config.browserTimeoutMs);
      const report = validatePng(await readFile(p));
      validation.png = report;
      if (!report.valid) throw new Error(report.errors.join("; "));
      files.png = await this.store.describeFile(p);
    } catch (e) {
      errors.png = (e as Error).message;
      log.warn("png export failed", { error: (e as Error).message });
    }
  }

  private async exportPdf(
    html: string,
    dir: string,
    spec: VisualizationSpec,
    files: ArtifactRecord["files"],
    errors: ArtifactRecord["exportErrors"],
    validation: Record<string, unknown>,
  ): Promise<void> {
    try {
      const p = path.join(dir, "chart.pdf");
      await htmlToPdf(html, p, spec.layout, this.config.browserTimeoutMs);
      const report = validatePdf(await readFile(p));
      validation.pdf = report;
      if (!report.valid) throw new Error(report.errors.join("; "));
      files.pdf = await this.store.describeFile(p);
    } catch (e) {
      errors.pdf = (e as Error).message;
      log.warn("pdf export failed", { error: (e as Error).message });
    }
  }

  /** Render several specs into one dashboard HTML with linked filtering/highlighting. */
  async renderDashboard(
    items: Array<{ spec: VisualizationSpec; ds: Dataset }>,
    opts: RenderOptions & {
      title: string;
      description?: string;
      columns: number;
      kpis?: Kpi[];
      linked?: LinkedPanelData;
    },
  ): Promise<{
    record: ArtifactRecord;
    charts: Array<{ specId: string; type: string; markCount: number; warnings: string[] }>;
    findings: string[];
  }> {
    if (!items.length) throw new D3McpError("INVALID_INPUT", "Dashboard requires at least one chart");
    const rendered = await Promise.all(
      items.map(async ({ spec, ds }) => ({ spec, ds, ...(await this.renderSvg(spec, ds)) })),
    );
    const findings = rendered.flatMap((r) =>
      computeFindings(r.spec, r.ds).map((f) => `${r.spec.title ?? r.spec.type}: ${f}`),
    );
    const warnings = [
      ...new Set(rendered.flatMap((r) => r.out.warnings.map((w) => `${r.spec.title ?? r.spec.type}: ${w}`))),
    ];
    const theme = items[0]!.spec.theme;
    const html = buildHtml({
      title: opts.title,
      ...(opts.description ? { description: opts.description } : {}),
      charts: rendered.map((r) => ({
        svg: r.svg,
        specId: r.spec.id,
        ...(r.spec.title ? { title: r.spec.title } : {}),
      })),
      findings,
      warnings,
      theme,
      d3: opts.d3Embed ?? "inline",
      dashboard: true,
      columns: opts.columns,
      ...(opts.kpis?.length ? { kpis: opts.kpis } : {}),
      ...(opts.linked ? { linked: opts.linked } : {}),
    });
    const htmlReport = validateHtml(html);
    if (!htmlReport.valid)
      throw new D3McpError(
        "VALIDATION_FAILED",
        `Dashboard HTML failed validation: ${htmlReport.errors.slice(0, 5).join("; ")}`,
      );
    const id = newArtifactId("dash");
    const dir = await this.store.createArtifactDir(opts.sessionId, id);
    const files: ArtifactRecord["files"] = {};
    const exportErrors: ArtifactRecord["exportErrors"] = {};
    const validation: Record<string, unknown> = { html: htmlReport, svg: rendered.map((r) => r.report) };
    files.html = await this.store.writeArtifactFile(dir, "dashboard.html", html);
    for (const [i, r] of rendered.entries()) {
      await this.store.saveSpec(r.spec, opts.sessionId);
      await this.store.writeArtifactFile(dir, `chart-${i + 1}.svg`, r.svg);
    }
    files.svg = await this.store.describeFile(path.join(dir, "chart-1.svg"));
    files.json = await this.store.writeArtifactFile(
      dir,
      "dashboard.json",
      JSON.stringify(
        { title: opts.title, kpis: opts.kpis ?? [], specs: rendered.map((r) => r.spec) },
        null,
        2,
      ),
    );
    const width = Math.max(...rendered.map((r) => r.out.width)) * Math.min(opts.columns, rendered.length);
    const height = rendered.reduce((s, r) => s + r.out.height, 0);
    if (opts.formats.includes("png")) {
      try {
        const p = path.join(dir, "dashboard.png");
        await htmlToPng(
          html,
          p,
          { width: Math.min(width, 2400), height: Math.min(height, 4000) },
          1,
          this.config.browserTimeoutMs,
        );
        validation.png = validatePng(await readFile(p));
        files.png = await this.store.describeFile(p);
      } catch (e) {
        exportErrors.png = (e as Error).message;
      }
    }
    let browser: BrowserInspection | undefined;
    if (opts.validateInBrowser) {
      try {
        browser = await inspectHtml(html, {
          markSelector: "svg.d3mcp-root .mark",
          timeoutMs: this.config.browserTimeoutMs,
          screenshotPath: path.join(dir, "screenshot.png"),
        });
        validation.browser = browser;
      } catch (e) {
        validation.browser = { ok: false, error: (e as Error).message };
      }
    }
    const record: ArtifactRecord = {
      id,
      sessionId: opts.sessionId,
      kind: "dashboard",
      title: opts.title,
      visualizationType: "dashboard",
      specIds: rendered.map((r) => r.spec.id),
      datasetIds: [...new Set(rendered.map((r) => r.ds.id))],
      createdAt: new Date().toISOString(),
      dir,
      width,
      height,
      markCount: rendered.reduce((s, r) => s + r.out.markCount, 0),
      markSelector: "svg.d3mcp-root .mark",
      files,
      exportErrors,
      validation,
      warnings,
    };
    await this.store.saveRecord(record);
    return {
      record,
      charts: rendered.map((r) => ({
        specId: r.spec.id,
        type: r.spec.type,
        markCount: r.out.markCount,
        warnings: r.out.warnings,
      })),
      findings,
    };
  }

  /**
   * Build a dashboard automatically: rank complementary charts across one or more datasets, dry-render each
   * (falling back to the next candidate when one cannot render), add descriptive KPI tiles, and render it.
   */
  async autoDashboard(
    inputs: Array<{ ds: Dataset; label?: string; prompt?: string }>,
    opts: Omit<RenderOptions, "findings"> & {
      title?: string;
      prompt: string;
      description?: string;
      maxCharts: number;
      columns?: number;
      kpis: boolean;
      chartOptions?: PlanOptions;
      /** Resolved links between inputs (by label). Enables joined charts, cross-chart entity selection and a detail panel. */
      links?: LinkSpec[];
    },
  ) {
    if (!inputs.length) throw new D3McpError("INVALID_INPUT", "Provide data or datasets");
    const labels = inputs.map((i, n) => i.label ?? (inputs.length > 1 ? `Dataset ${n + 1}` : "data"));
    const sources: LinkSource[] = inputs.map((i, n) => ({ ds: i.ds, label: labels[n]! }));
    const links = opts.links ?? [];
    type Prepared = {
      ds: Dataset;
      label: string;
      prompt: string;
      profile: ReturnType<typeof profileDataset>;
      joinedFrom?: { label: string; field: string };
      enrichedField?: string;
    };
    const prepared: Prepared[] = inputs.map((i, n) => ({
      ds: i.ds,
      label: labels[n]!,
      profile: profileDataset(i.ds),
      prompt: [opts.prompt, i.prompt].filter(Boolean).join(". "),
    }));
    const joins: Array<{ dataset_id: string; label: string; transformations: string[]; warnings: string[] }> =
      [];
    const said = (n: string) => {
      const p = opts.prompt.toLowerCase();
      return p.includes(n.toLowerCase()) || p.includes(n.toLowerCase().replace(/_/g, " "));
    };
    // One joined view per detail source: its measure broken down by an attribute that only the linked source has.
    const views = new Map<
      string,
      {
        ds: Dataset;
        attr: string;
        measure: string;
        field: string;
        rank: number;
        tx: string[];
        warnings: string[];
      }
    >();
    for (const link of links) {
      const o = orientLink(sources, link);
      if (o.left.ds.kind !== "table") continue;
      try {
        const j = joinDatasets(
          o.left,
          o.right,
          { leftField: o.leftField, rightField: o.rightField, attributesOnly: true },
          this.config.maxRows,
        );
        const p = profileDataset(j.dataset);
        const attrs = j.addedFields
          .map((f) => p.fields.find((x) => x.name === f))
          .filter(
            (fp): fp is NonNullable<typeof fp> =>
              !!fp &&
              fp.type !== "quantitative" &&
              fp.type !== "temporal" &&
              fp.unique >= 2 &&
              fp.unique <= 20,
          )
          .sort((a, b) => Number(said(b.name)) - Number(said(a.name)) || a.unique - b.unique);
        const attr = attrs[0];
        const measures = p.fields.filter((f) => f.type === "quantitative" && !j.addedFields.includes(f.name));
        const measure = measures.find((f) => said(f.name)) ?? measures[0];
        if (!attr || !measure) continue;
        const rank = (said(attr.name) ? 100 : 0) - attr.unique;
        const prev = views.get(o.left.label);
        if (prev && prev.rank >= rank) continue;
        views.set(o.left.label, {
          ds: j.dataset,
          attr: attr.name,
          measure: measure.name,
          field: o.leftField,
          rank,
          tx: j.dataset.transformations.slice(-3),
          warnings: j.dataset.warnings,
        });
      } catch (e) {
        log.debug("join skipped", { error: (e as Error).message });
      }
    }
    for (const [source, v] of [...views].slice(0, 2)) {
      const label = `${source} by ${v.attr}`;
      await this.store.saveDataset(v.ds, opts.sessionId);
      prepared.push({
        ds: v.ds,
        label,
        profile: profileDataset(v.ds),
        prompt: `compare ${v.measure} by ${v.attr}`,
        joinedFrom: { label: source, field: v.field },
      });
      joins.push({ dataset_id: v.ds.id, label, transformations: v.tx, warnings: v.warnings });
    }
    const keys = links.length ? entityKeys(sources, links) : null;
    // Maps and networks rarely carry measures; colour them by the linked fact table's measure (mean per feature/node).
    const enriched: string[] = [];
    if (keys) {
      const fact = prepared
        .filter((p) => !p.joinedFrom && p.ds.kind === "table" && keys.tokens.has(p.label))
        .sort((a, b) => b.ds.rows.length - a.ds.rows.length)[0];
      const qs = fact?.profile.fields.filter((f) => f.type === "quantitative") ?? [];
      const m = qs.find((f) => said(f.name)) ?? qs[0];
      if (fact && m) {
        const ft = keys.tokens.get(fact.label)!;
        const byToken = new Map<string, number[]>();
        fact.ds.rows.forEach((r, i) => {
          const v = r[m.name];
          if (typeof v !== "number" || !Number.isFinite(v)) return;
          for (const t of ft[i] ?? []) {
            const list = byToken.get(t);
            if (list) list.push(v);
            else byToken.set(t, [v]);
          }
        });
        const name = `avg_${m.name}`;
        for (const p of prepared) {
          if (p.joinedFrom || (p.ds.kind !== "geo" && p.ds.kind !== "graph")) continue;
          const t = keys.tokens.get(p.label);
          if (!t || p.ds.rows.some((r) => name in r)) continue;
          const values = p.ds.rows.map((_, i) => {
            const vals = [...new Set(t[i] ?? [])].flatMap((k) => byToken.get(k) ?? []);
            return vals.length
              ? Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 100) / 100
              : null;
          });
          if (values.every((v) => v === null)) continue;
          const rows = p.ds.rows.map((r, i) => ({ ...r, [name]: values[i] ?? null }));
          const ds: Dataset = {
            ...p.ds,
            rows,
            transformations: [
              ...p.ds.transformations,
              `Added ${name}: mean of ${fact.label}.${m.name} over the ${keys.home.field.replace(/_/g, " ")} values linked to each ${p.ds.kind === "geo" ? "feature" : "node"}.`,
            ],
          };
          if (ds.geojson) {
            ds.geojson = {
              ...ds.geojson,
              features: ds.geojson.features.map((f, i) => ({
                ...f,
                properties: { ...(f.properties ?? {}), [name]: values[i] ?? null },
              })),
            };
          }
          p.ds = ds;
          p.profile = profileDataset(ds);
          p.enrichedField = name;
          // Maps become choropleths of the linked measure; networks keep their categorical grouping (value in tooltips).
          if (ds.kind === "geo") p.prompt = `${p.prompt}. color by ${name}`;
          enriched.push(`${p.label}.${name}`);
        }
      }
    }
    const candidates = planDashboardCandidates(
      prepared.map((p) => ({ dataset: p.ds, profile: p.profile, prompt: p.prompt })),
      opts.maxCharts,
    );
    const columns = opts.columns ?? (opts.maxCharts === 1 ? 1 : 2);
    const size = columns > 1 ? { width: 560, height: 340 } : { width: 900, height: 420 };
    const items: Array<{ spec: VisualizationSpec; ds: Dataset; candidate: DashboardCandidate }> = [];
    const skipped: Array<{ type: string; dataset: string; reason: string }> = [];
    const labelOf = (i: number) => prepared[i]!.label;
    for (const c of candidates) {
      if (items.length >= opts.maxCharts) break;
      const p = prepared[c.datasetIndex]!;
      const title = `${prepared.length > 1 ? `${labelOf(c.datasetIndex)} · ` : ""}${c.question.charAt(0).toUpperCase()}${c.question.slice(1)}`;
      try {
        const plan = planVisualization({
          dataset: p.ds,
          profile: p.profile,
          prompt: p.prompt,
          type: c.type,
          title: title.slice(0, 300),
          options: {
            ...size,
            ...(opts.chartOptions ?? {}),
            encoding: { ...c.encoding, ...(opts.chartOptions?.encoding ?? {}) },
            ...(c.options
              ? {
                  options: {
                    ...(c.options as PlanOptions["options"]),
                    ...(opts.chartOptions?.options ?? {}),
                  },
                }
              : {}),
          },
        });
        await this.renderSvg(plan.spec, p.ds);
        const spec =
          p.enrichedField && p.ds.kind === "graph"
            ? {
                ...plan.spec,
                encoding: {
                  ...plan.spec.encoding,
                  tooltip: [...(plan.spec.encoding.tooltip ?? []), p.enrichedField],
                },
              }
            : plan.spec;
        items.push({ spec, ds: p.ds, candidate: c });
      } catch (e) {
        skipped.push({
          type: c.type,
          dataset: labelOf(c.datasetIndex),
          reason: (e as Error).message.slice(0, 200),
        });
      }
    }
    if (!items.length) {
      throw new D3McpError(
        "INCOMPATIBLE_DATA",
        "No chart could be built from this data",
        skipped
          .map((s) => `${s.type}: ${s.reason}`)
          .slice(0, 5)
          .join(" | "),
      );
    }
    const temporal = items.filter((i) =>
      ["line", "area", "cumulative", "stacked-area"].includes(i.spec.type),
    );
    // A brush overlay would swallow clicks, so linked dashboards select by clicking marks instead.
    const sharedBrush = temporal.length >= 2 && !links.length;
    if (sharedBrush) {
      for (const i of temporal) i.spec = { ...i.spec, interaction: { ...i.spec.interaction, brush: true } };
    }
    let linked: LinkedPanelData | undefined;
    const linkedCharts: string[] = [];
    if (keys) {
      const tokensFor = (idx: number): string[][] | undefined => {
        const p = prepared[idx]!;
        if (p.joinedFrom) {
          const src = sources.find((s) => s.label === p.joinedFrom!.label)!;
          const t = keys.tokens.get(src.label);
          return t ? tokensVia(p.ds.rows, p.joinedFrom.field, src, p.joinedFrom.field, t) : undefined;
        }
        return keys.tokens.get(p.label);
      };
      items.forEach((it, n) => {
        const t = tokensFor(it.candidate.datasetIndex);
        if (!t || it.ds.kind === "hierarchy") return;
        const rows: Row[] = it.ds.rows.map((r, i) => ({ ...r, _link: (t[i] ?? []).join("\u001f") }));
        items[n] = {
          ...it,
          ds: { ...it.ds, rows },
          spec: { ...it.spec, interaction: { ...it.spec.interaction, link: "_link" } },
        };
        linkedCharts.push(it.spec.title ?? it.spec.type);
      });
      const MAX_PANEL_ROWS = 500;
      linked = {
        entity: keys.home.field.replace(/_/g, " "),
        sources: sources
          .filter((s) => keys.tokens.has(s.label))
          .map((s) => {
            const t = keys.tokens.get(s.label)!;
            const columns = Object.keys(s.ds.rows[0] ?? {})
              .filter((c) => !c.startsWith("_"))
              .slice(0, 10);
            return {
              label: s.label,
              columns,
              truncated: s.ds.rows.length > MAX_PANEL_ROWS,
              rows: s.ds.rows.slice(0, MAX_PANEL_ROWS).map((r, i) => ({
                ...Object.fromEntries(columns.map((c) => [c, r[c] ?? null])),
                _k: t[i] ?? [],
              })),
            };
          }),
      };
    }
    // KPIs describe the original inputs: joined views and linked averages would repeat other sources' figures.
    const kpiSources = sources.map((s, i) => {
      const p = prepared[i]!;
      return {
        label: s.label,
        ds: s.ds,
        prompt: p.prompt,
        profile: p.ds === s.ds ? p.profile : profileDataset(s.ds),
      };
    });
    const perDataset = kpiSources.length === 1 ? 6 : Math.max(2, Math.floor(12 / kpiSources.length));
    const kpis = opts.kpis
      ? kpiSources.flatMap((p) =>
          computeKpis(p.ds, p.profile, p.prompt, kpiSources.length > 1 ? p.label : undefined, perDataset),
        )
      : [];
    const fileName = prepared[0]!.ds.origin?.file?.split(/[\\/]/).pop();
    const goal = opts.prompt
      .trim()
      .split(/(?<=[.!?])\s/)[0]!
      .slice(0, 120);
    const title =
      opts.title ??
      (goal
        ? goal.charAt(0).toUpperCase() + goal.slice(1)
        : `Dashboard: ${kpiSources.length > 1 ? kpiSources.map((p) => p.label).join(", ") : (fileName ?? "data")}`);
    const r = await this.renderDashboard(
      items.map(({ spec, ds }) => ({ spec, ds })),
      {
        ...opts,
        title,
        columns: Math.min(columns, items.length),
        kpis,
        ...(linked ? { linked } : {}),
        ...(opts.description ? { description: opts.description } : {}),
      },
    );
    return {
      ...r,
      kpis,
      skipped,
      sharedTimeBrush: sharedBrush,
      ...(keys
        ? {
            linking: {
              entity: keys.home,
              links,
              joined_views: joins,
              enriched_fields: enriched,
              linked_charts: linkedCharts,
              unlinked_sources: keys.unreachable,
            },
          }
        : {}),
      plan: items.map(({ spec, candidate }, idx) => ({
        position: idx + 1,
        dataset: labelOf(candidate.datasetIndex),
        type: spec.type,
        family: candidate.family,
        title: spec.title,
        question: candidate.question,
        rationale: candidate.rationale,
        encoding: spec.encoding,
        spec_id: spec.id,
      })),
    };
  }

  /** Export additional formats for an existing artifact. Never reports success for a format that was not produced. */
  async exportArtifact(id: string, formats: ArtifactFormat[]): Promise<ArtifactRecord> {
    const rec = await this.store.get(id);
    const html = rec.files.html ? await readFile(rec.files.html.path, "utf8") : null;
    const svg = rec.files.svg ? await readFile(rec.files.svg.path, "utf8") : null;
    rec.exportErrors = { ...rec.exportErrors };
    for (const f of formats) {
      if (rec.files[f] && f !== "png" && f !== "pdf") continue;
      if (f === "png") {
        if (rec.kind === "dashboard" && html) {
          try {
            const p = path.join(rec.dir, "dashboard.png");
            await htmlToPng(
              html,
              p,
              { width: Math.min(rec.width, 2400), height: Math.min(rec.height, 4000) },
              1,
              this.config.browserTimeoutMs,
            );
            const r = validatePng(await readFile(p));
            if (!r.valid) throw new Error(r.errors.join("; "));
            rec.files.png = await this.store.describeFile(p);
            delete rec.exportErrors.png;
          } catch (e) {
            rec.exportErrors.png = (e as Error).message;
          }
        } else if (svg) {
          const spec = await this.store.getSpec(rec.specIds[0]!);
          const validation = rec.validation;
          await this.exportPng(svg, rec.dir, spec, rec.files, rec.exportErrors, validation);
          if (rec.files.png) delete rec.exportErrors.png;
        }
      } else if (f === "pdf" && html) {
        const spec = rec.kind === "visualization" ? await this.store.getSpec(rec.specIds[0]!) : null;
        await this.exportPdf(
          html,
          rec.dir,
          spec ?? ({ layout: { width: rec.width, height: rec.height } } as VisualizationSpec),
          rec.files,
          rec.exportErrors,
          rec.validation,
        );
        if (rec.files.pdf) delete rec.exportErrors.pdf;
      } else if (f === "csv") {
        try {
          const ds = await this.store.getDataset(rec.datasetIds[0]!);
          const spec = await this.store.getSpec(rec.specIds[0]!);
          rec.files.csv = await this.store.writeArtifactFile(
            rec.dir,
            "data.csv",
            csvFormat(applyTransforms(ds.rows, spec.transforms).rows),
          );
        } catch (e) {
          rec.exportErrors.csv = (e as Error).message;
        }
      } else if (!rec.files[f]) {
        rec.exportErrors[f] = `Format ${f} is not available for this artifact`;
      }
    }
    await this.store.saveRecord(rec);
    return rec;
  }
}
