import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../src/core/artifacts/store.js";
import { ingest } from "../../src/core/data/ingest.js";
import type { Dataset } from "../../src/core/data/types.js";
import { parseSpec, type VisualizationSpecInput } from "../../src/core/schema/spec.js";
import { VisualizationService } from "../../src/core/service.js";
import { renderVisualization } from "../../src/renderers/render.js";
import { createNodeDom } from "../../src/renderers/svg/node-dom.js";
import { loadConfig } from "../../src/shared/config.js";

export const config = loadConfig({ D3MCP_LOG_LEVEL: "error" });

export function ds(data: unknown): Dataset {
  return ingest(data, config);
}

export function spec(type: string, d: Dataset, extra: Partial<VisualizationSpecInput> = {}) {
  return parseSpec({
    id: `t_${type.replace(/[^a-z]/g, "")}`,
    type,
    data: { datasetId: d.id },
    title: `Test ${type}`,
    ...extra,
  });
}

export function render(type: string, data: unknown, extra: Partial<VisualizationSpecInput> = {}) {
  const d = ds(data);
  const s = spec(type, d, extra);
  const dom = createNodeDom();
  try {
    const out = renderVisualization(dom.doc, s, d);
    return { out, svg: dom.serialize(out.svg), spec: s, dataset: d, doc: dom.doc };
  } finally {
    dom.close();
  }
}

export function tempService(): VisualizationService {
  const dir = mkdtempSync(path.join(os.tmpdir(), "d3mcp-test-"));
  const cfg = { ...config, artifactDir: dir };
  return new VisualizationService(cfg, new ArtifactStore(dir, cfg.ttlHours));
}
