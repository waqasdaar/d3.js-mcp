#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ArtifactStore } from "../core/artifacts/store.js";
import { VisualizationService } from "../core/service.js";
import { closeBrowser } from "../export/browser.js";
import { loadConfig } from "../shared/config.js";
import { log, setLogLevel } from "../shared/logger.js";
import { startHttpServer, type HttpHandle } from "./http.js";
import { createServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const useHttp = process.argv.includes("--http") || process.env.D3MCP_TRANSPORT === "http";
  const store = new ArtifactStore(config.artifactDir, config.ttlHours);
  await store.init();
  const svc = new VisualizationService(config, store);
  const server = useHttp ? null : createServer(svc);
  let http: HttpHandle | null = null;
  const cleanupTimer = setInterval(() => void store.cleanup().catch(() => undefined), 3_600_000);
  cleanupTimer.unref();
  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { reason });
    clearInterval(cleanupTimer);
    await http?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await svc.close().catch(() => undefined);
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  const common = {
    version: SERVER_VERSION,
    artifactDir: config.artifactDir,
    renderWorkers: config.renderWorkers,
    node: process.version,
  };
  if (useHttp) {
    http = await startHttpServer(svc);
    log.info("d3-visualization-mcp ready", {
      ...common,
      transport: "streamable-http",
      url: http.url,
      auth: config.http.token ? "bearer" : "none (loopback only)",
    });
    return;
  }
  process.stdin.on("close", () => void shutdown("stdin closed"));
  await server!.connect(new StdioServerTransport());
  log.info("d3-visualization-mcp ready", { ...common, transport: "stdio" });
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
