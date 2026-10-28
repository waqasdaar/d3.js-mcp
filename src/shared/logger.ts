import type { LogLevel } from "./config.js";

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let current: LogLevel =
  (process.env.D3MCP_LOG_LEVEL as LogLevel) in ORDER ? (process.env.D3MCP_LOG_LEVEL as LogLevel) : "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

// stdout is reserved for MCP protocol messages; all diagnostics go to stderr. User data is never logged.
function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] > ORDER[current]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ?? {}) });
  process.stderr.write(line + "\n");
}

export const log = {
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
};
