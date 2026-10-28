import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { VisualizationService } from "../core/service.js";
import { log } from "../shared/logger.js";
import { createServer } from "./server.js";

const MAX_SESSIONS = 100;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes)
      throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { status: 413 });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

/**
 * Streamable HTTP transport (MCP spec 2025-03-26+), stateful sessions, one McpServer per session.
 * Loopback-only by default; binding elsewhere requires D3MCP_HTTP_TOKEN. Host/Origin headers are validated.
 */
export async function startHttpServer(svc: VisualizationService): Promise<HttpHandle> {
  const { host, port, token, allowedOrigins } = svc.config.http;
  if (!LOOPBACK.has(host) && !token) {
    throw new Error(`Refusing to bind HTTP transport to non-loopback host ${host} without D3MCP_HTTP_TOKEN`);
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const maxBody = svc.config.maxInputBytes * 2 + 1_000_000;
  let boundPort = port;

  const allowedHosts = () => [
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
    `${host}:${boundPort}`,
  ];
  const origins = () => [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, ...allowedOrigins];

  const http = createHttpServer(async (req, res) => {
    const t0 = Date.now();
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (url.pathname === "/healthz" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size, renderPool: svc.renderPoolStats }));
        return;
      }
      if (url.pathname !== "/mcp") return jsonRpcError(res, 404, "Not found; the MCP endpoint is /mcp");
      if (!allowedHosts().includes(req.headers.host ?? ""))
        return jsonRpcError(res, 403, "Host header not allowed");
      const origin = req.headers.origin;
      if (origin && !origins().includes(origin)) return jsonRpcError(res, 403, "Origin not allowed");
      if (token && !tokenMatches(req.headers.authorization, token)) {
        return jsonRpcError(res, 401, "Missing or invalid bearer token", { "www-authenticate": "Bearer" });
      }

      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (req.method === "POST") {
        const body = await readJson(req, maxBody);
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (sessionId && !transport) return jsonRpcError(res, 404, "Unknown or expired session");
        if (!transport) {
          if (!isInitializeRequest(body))
            return jsonRpcError(res, 400, "No session: the first request must be initialize");
          if (sessions.size >= MAX_SESSIONS) return jsonRpcError(res, 503, "Too many sessions");
          const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: allowedHosts(),
            allowedOrigins: origins(),
            onsessioninitialized: (id) => {
              sessions.set(id, t);
              log.info("http session opened", { sessions: sessions.size });
            },
          });
          t.onclose = () => {
            if (t.sessionId) sessions.delete(t.sessionId);
          };
          await createServer(svc).connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport)
          return jsonRpcError(
            res,
            sessionId ? 404 : 400,
            sessionId ? "Unknown or expired session" : "Missing mcp-session-id",
          );
        await transport.handleRequest(req, res);
      } else {
        jsonRpcError(res, 405, "Method not allowed", { allow: "GET, POST, DELETE" });
      }
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      log.warn("http request failed", { status, message: (e as Error).message.slice(0, 200) });
      if (!res.headersSent)
        jsonRpcError(res, status, status === 500 ? "Internal error" : (e as Error).message);
    } finally {
      log.debug("http request", { method: req.method, ms: Date.now() - t0 });
    }
  });
  http.requestTimeout = svc.config.renderTimeoutMs + svc.config.browserTimeoutMs * 2;
  http.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve());
  });
  boundPort = (http.address() as AddressInfo).port;
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${boundPort}/mcp`,
    port: boundPort,
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close().catch(() => undefined)));
      sessions.clear();
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}
