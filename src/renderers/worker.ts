import { parentPort, workerData } from "node:worker_threads";
import type { Dataset } from "../core/data/types.js";
import type { VisualizationSpec } from "../core/schema/spec.js";
import { toErrorPayload } from "../shared/errors.js";
import type { LogLevel } from "../shared/config.js";
import { setLogLevel } from "../shared/logger.js";
import { renderSvgMarkup } from "./render-svg.js";
import type { RenderLimits } from "./types.js";

export interface RenderJob {
  id: number;
  spec: VisualizationSpec;
  ds: Dataset;
  limits: RenderLimits;
}

setLogLevel(((workerData as { logLevel?: LogLevel } | undefined)?.logLevel ?? "warn") as LogLevel);

parentPort!.on("message", (job: RenderJob) => {
  try {
    parentPort!.postMessage({ id: job.id, ok: true, result: renderSvgMarkup(job.spec, job.ds, job.limits) });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, error: toErrorPayload(e) });
  }
});
