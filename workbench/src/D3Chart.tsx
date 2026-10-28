import { useEffect, useRef } from "react";
import type { Dataset } from "../../src/core/data/types.js";
import type { VisualizationSpec } from "../../src/core/schema/spec.js";
import { renderVisualization, type RenderOutput } from "../../src/renderers/render.js";

interface Props {
  spec: VisualizationSpec;
  dataset: Dataset;
  onRendered(out: Omit<RenderOutput, "svg"> & { svgMarkup: string }): void;
  onError(message: string): void;
}

/** React owns the container; D3 owns everything inside it. React never reconciles the SVG subtree. */
export function D3Chart({ spec, dataset, onRendered, onError }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    try {
      const { svg, ...out } = renderVisualization(document, spec, dataset);
      host.replaceChildren(svg);
      onRendered({ ...out, svgMarkup: new XMLSerializer().serializeToString(svg) });
    } catch (e) {
      host.replaceChildren();
      onError((e as Error).message);
    }
    return () => host.replaceChildren();
  }, [spec, dataset, onRendered, onError]);
  return <div ref={ref} className="chart-host" data-testid="chart-host" />;
}
