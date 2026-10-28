import type { Dataset } from "../core/data/types.js";
import type { VisualizationSpec } from "../core/schema/spec.js";
import { validateSvg, type StructuralReport } from "../core/validation/structural.js";
import { D3McpError } from "../shared/errors.js";
import { renderVisualization, type RenderOutput } from "./render.js";
import { createNodeDom } from "./svg/node-dom.js";
import type { RenderLimits } from "./types.js";

export type RenderInfo = Omit<RenderOutput, "svg">;

export interface SvgRenderResult {
  svg: string;
  out: RenderInfo;
  report: StructuralReport;
}

/** Render a spec to validated SVG markup. Pure and synchronous; runs inside render workers. */
export function renderSvgMarkup(spec: VisualizationSpec, ds: Dataset, limits: RenderLimits): SvgRenderResult {
  const dom = createNodeDom();
  try {
    const { svg: el, ...out } = renderVisualization(dom.doc, spec, ds, limits);
    const svg = dom.serialize(el);
    const report = validateSvg(svg, {
      markSelector: out.markSelector,
      expectedMarks: out.markCount,
      minMarks: out.markCount > 0 ? 1 : 0,
    });
    if (!report.valid) {
      throw new D3McpError(
        "VALIDATION_FAILED",
        `Rendered SVG failed validation: ${report.errors.slice(0, 5).join("; ")}`,
        "This is a renderer defect or invalid data; no artifact was written.",
        report,
      );
    }
    return { svg, out, report };
  } finally {
    dom.close();
  }
}
