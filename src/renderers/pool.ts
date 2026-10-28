import { Worker } from "node:worker_threads";
import type { Dataset } from "../core/data/types.js";
import type { VisualizationSpec } from "../core/schema/spec.js";
import type { LogLevel } from "../shared/config.js";
import { D3McpError, type ErrorCode } from "../shared/errors.js";
import { log } from "../shared/logger.js";
import { renderSvgMarkup, type SvgRenderResult } from "./render-svg.js";
import type { RenderLimits } from "./types.js";
import type { RenderJob } from "./worker.js";

interface Pending {
  job: RenderJob;
  resolve(r: SvgRenderResult): void;
  reject(e: Error): void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  timer: NodeJS.Timeout | null;
}

type Reply =
  | { id: number; ok: true; result: SvgRenderResult }
  | { id: number; ok: false; error: { code: string; message: string; hint?: string; details?: unknown } };

// From source (tests, tsx scripts) the worker is a .ts file and needs the tsx loader; from dist it is plain JS.
const FROM_SOURCE = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(FROM_SOURCE ? "./worker.ts" : "./worker.js", import.meta.url);

/**
 * Fixed-size pool of render workers so D3 layouts (notably force simulations) never block the MCP event loop.
 * size 0 renders inline (no workers).
 */
export class RenderPool {
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    readonly size: number,
    private readonly timeoutMs: number,
    private readonly logLevel: LogLevel,
  ) {}

  render(spec: VisualizationSpec, ds: Dataset, limits: RenderLimits): Promise<SvgRenderResult> {
    if (this.size === 0) {
      return new Promise((resolve, reject) => {
        try {
          resolve(renderSvgMarkup(spec, ds, limits));
        } catch (e) {
          reject(e as Error);
        }
      });
    }
    if (this.closed) return Promise.reject(new D3McpError("RENDER_FAILED", "Render pool is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ job: { id: this.nextId++, spec, ds, limits }, resolve, reject });
      this.pump();
    });
  }

  get stats() {
    return {
      size: this.size,
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new D3McpError("RENDER_FAILED", "Render pool closed"));
    await Promise.all(this.slots.splice(0).map((s) => s.worker.terminate()));
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.busy);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const p = this.queue.shift()!;
      slot.busy = p;
      slot.worker.ref();
      slot.timer = setTimeout(() => this.timeout(slot!), this.timeoutMs);
      slot.worker.postMessage(p.job);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      workerData: { logLevel: this.logLevel },
      ...(FROM_SOURCE ? { execArgv: ["--import", "tsx"] } : {}),
    });
    const slot: Slot = { worker, busy: null, timer: null };
    worker.unref();
    worker.on("message", (msg: Reply) => {
      const p = slot.busy;
      if (!p || p.job.id !== msg.id) return;
      this.finish(slot);
      if (msg.ok) p.resolve(msg.result);
      else
        p.reject(
          new D3McpError(msg.error.code as ErrorCode, msg.error.message, msg.error.hint, msg.error.details),
        );
    });
    worker.on("error", (e: Error) => this.crash(slot, `Render worker crashed: ${e.message}`));
    worker.on("exit", (code) => {
      if (slot.busy) this.crash(slot, `Render worker exited with code ${code}`);
      else this.remove(slot);
    });
    this.slots.push(slot);
    return slot;
  }

  private finish(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.busy = null;
    slot.worker.unref();
    queueMicrotask(() => this.pump());
  }

  private timeout(slot: Slot): void {
    const p = slot.busy;
    if (!p) return;
    log.warn("render timed out; terminating worker", { ms: this.timeoutMs, type: p.job.spec.type });
    slot.busy = null;
    this.remove(slot);
    void slot.worker.terminate();
    p.reject(
      new D3McpError(
        "LIMIT_EXCEEDED",
        `Rendering ${p.job.spec.type} exceeded ${this.timeoutMs} ms and was stopped`,
        "Reduce the data size, lower options.iterations for force layouts, or raise D3MCP_RENDER_TIMEOUT_MS.",
      ),
    );
    this.pump();
  }

  private crash(slot: Slot, message: string): void {
    const p = slot.busy;
    slot.busy = null;
    if (slot.timer) clearTimeout(slot.timer);
    this.remove(slot);
    p?.reject(new D3McpError("RENDER_FAILED", message));
    if (!this.closed) this.pump();
  }

  private remove(slot: Slot): void {
    this.slots = this.slots.filter((s) => s !== slot);
  }
}
