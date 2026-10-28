import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, resolved from this module's location (works from src/ via tsx and from dist/). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Config {
  artifactDir: string;
  maxRows: number;
  maxColumns: number;
  maxInputBytes: number;
  maxCellChars: number;
  maxForceNodes: number;
  maxForceLinks: number;
  maxHierarchyNodes: number;
  maxSvgMarks: number;
  maxGeoFeatures: number;
  ttlHours: number;
  browserTimeoutMs: number;
  maxArtifactReadBytes: number;
  logLevel: LogLevel;
  dataDirs: string[];
  maxFileBytes: number;
  renderWorkers: number;
  renderTimeoutMs: number;
  http: {
    host: string;
    port: number;
    token: string | undefined;
    allowedOrigins: string[];
  };
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}=${raw}: expected an integer between ${min} and ${max}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env.D3MCP_ARTIFACT_DIR;
  const level = (env.D3MCP_LOG_LEVEL ?? "info") as LogLevel;
  return {
    artifactDir: dir ? path.resolve(dir) : path.join(PACKAGE_ROOT, "artifacts"),
    maxRows: intEnv(env, "D3MCP_MAX_ROWS", 50_000, 1, 5_000_000),
    maxColumns: 500,
    maxInputBytes: intEnv(env, "D3MCP_MAX_INPUT_BYTES", 10_000_000, 1_000, 500_000_000),
    maxCellChars: 10_000,
    maxForceNodes: 3_000,
    maxForceLinks: 10_000,
    maxHierarchyNodes: 20_000,
    maxSvgMarks: 20_000,
    maxGeoFeatures: 5_000,
    ttlHours: intEnv(env, "D3MCP_ARTIFACT_TTL_HOURS", 72, 1, 24 * 365),
    browserTimeoutMs: intEnv(env, "D3MCP_BROWSER_TIMEOUT_MS", 30_000, 1_000, 600_000),
    maxArtifactReadBytes: 2_000_000,
    logLevel: ["error", "warn", "info", "debug"].includes(level) ? level : "info",
    dataDirs: (env.D3MCP_DATA_DIRS ?? "")
      .split(path.delimiter)
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) =>
        path.resolve(d === "~" ? os.homedir() : d.startsWith("~/") ? path.join(os.homedir(), d.slice(2)) : d),
      ),
    maxFileBytes: intEnv(env, "D3MCP_MAX_FILE_BYTES", 25_000_000, 1_000, 1_000_000_000),
    renderWorkers: intEnv(
      env,
      "D3MCP_RENDER_WORKERS",
      Math.max(1, Math.min(4, os.availableParallelism() - 1)),
      0,
      32,
    ),
    renderTimeoutMs: intEnv(env, "D3MCP_RENDER_TIMEOUT_MS", 60_000, 1_000, 600_000),
    http: {
      host: env.D3MCP_HTTP_HOST || "127.0.0.1",
      port: intEnv(env, "D3MCP_HTTP_PORT", 3333, 0, 65_535),
      token: env.D3MCP_HTTP_TOKEN || undefined,
      allowedOrigins: (env.D3MCP_HTTP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  };
}
