import { describe, expect, it } from "vitest";
import { ingest } from "../../src/core/data/ingest.js";
import { parseSpec } from "../../src/core/schema/spec.js";
import { RenderPool } from "../../src/renderers/pool.js";
import { DEFAULT_RENDER_LIMITS } from "../../src/renderers/types.js";
import { D3McpError } from "../../src/shared/errors.js";
import { simpleBars } from "../fixtures/data.js";
import { config } from "../helpers/render.js";

function bigGraph(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, group: `g${i % 6}` }));
  const links = Array.from({ length: n * 2 }, (_, i) => ({
    source: `n${i % n}`,
    target: `n${(i * 7919 + 13) % n}`,
  })).filter((l) => l.source !== l.target);
  return { nodes, links };
}

const bars = ingest(simpleBars, config);
const barSpec = parseSpec({
  id: "pool_bar",
  type: "bar",
  data: { datasetId: bars.id },
  encoding: { x: { field: "category" }, y: { field: "value" } },
});

describe("RenderPool", () => {
  it("renders in a worker with the same result as inline rendering", async () => {
    const pool = new RenderPool(2, 30_000, "error");
    const inline = new RenderPool(0, 30_000, "error");
    try {
      const [a, b] = await Promise.all([
        pool.render(barSpec, bars, DEFAULT_RENDER_LIMITS),
        inline.render(barSpec, bars, DEFAULT_RENDER_LIMITS),
      ]);
      expect(a.out.markCount).toBe(5);
      expect(a.svg).toBe(b.svg);
      expect(a.report.valid).toBe(true);
    } finally {
      await pool.close();
    }
  });

  it("preserves error codes and hints across the worker boundary", async () => {
    const pool = new RenderPool(1, 30_000, "error");
    try {
      const bad = parseSpec({ ...barSpec, encoding: { x: { field: "nope" }, y: { field: "value" } } });
      const err = await pool.render(bad, bars, DEFAULT_RENDER_LIMITS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(D3McpError);
      expect((err as D3McpError).code).toBe("FIELD_NOT_FOUND");
      expect((err as D3McpError).hint).toMatch(/Available fields/);
      // The worker survives a failed job.
      expect((await pool.render(barSpec, bars, DEFAULT_RENDER_LIMITS)).out.markCount).toBe(5);
    } finally {
      await pool.close();
    }
  });

  it("keeps the event loop responsive while a 2,000-node force layout runs", async () => {
    const pool = new RenderPool(1, 60_000, "error");
    const g = ingest(bigGraph(2000), config);
    const spec = parseSpec({
      id: "pool_force",
      type: "force",
      data: { datasetId: g.id },
      options: { seed: 1 },
    });
    try {
      let ticks = 0;
      let maxGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const t0 = performance.now();
      const r = await pool.render(spec, g, DEFAULT_RENDER_LIMITS);
      const elapsed = performance.now() - t0;
      clearInterval(timer);
      expect(r.out.markCount).toBe(2000);
      expect(elapsed).toBeGreaterThan(300);
      // Inline rendering would block for the whole layout; in a worker the 10 ms timer keeps firing.
      expect(maxGap).toBeLessThan(250);
      expect(ticks).toBeGreaterThan(elapsed / 10 / 4);
    } finally {
      await pool.close();
    }
  });

  it("renders concurrent jobs in parallel and queues beyond pool size", async () => {
    const pool = new RenderPool(2, 30_000, "error");
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => pool.render(barSpec, bars, DEFAULT_RENDER_LIMITS)),
      );
      expect(results.every((r) => r.out.markCount === 5)).toBe(true);
      expect(pool.stats.workers).toBeLessThanOrEqual(2);
      expect(pool.stats.queued).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it("terminates a render that exceeds the timeout and recovers", async () => {
    const pool = new RenderPool(1, 1_000, "error");
    const g = ingest(bigGraph(3000), config);
    const slow = parseSpec({
      id: "pool_slow",
      type: "force",
      data: { datasetId: g.id },
      options: { iterations: 1000, seed: 1 },
    });
    try {
      const err = await pool.render(slow, g, DEFAULT_RENDER_LIMITS).catch((e: unknown) => e);
      expect((err as D3McpError).code).toBe("LIMIT_EXCEEDED");
      expect((err as D3McpError).message).toMatch(/exceeded 1000 ms/);
      expect((await pool.render(barSpec, bars, DEFAULT_RENDER_LIMITS)).out.markCount).toBe(5);
    } finally {
      await pool.close();
    }
  });
});
