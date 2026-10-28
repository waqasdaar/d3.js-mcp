import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { network, simpleBars } from "../fixtures/data.js";

const SERVER = path.resolve(import.meta.dirname, "..", "..", "dist", "server", "index.js");
const TOKEN = "test-token-" + "x".repeat(24);
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

interface Running {
  proc: ChildProcess;
  url: string;
  stderr: () => string;
}

function startServer(env: Record<string, string>): Promise<Running> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "d3mcp-http-"));
  const proc = spawn(process.execPath, [SERVER, "--http"], {
    env: {
      ...(process.env as Record<string, string>),
      D3MCP_ARTIFACT_DIR: dir,
      D3MCP_HTTP_PORT: "0",
      D3MCP_LOG_LEVEL: "info",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 20_000);
    proc.stderr!.on("data", (b: Buffer) => {
      err += b.toString();
      const m = /"url":"(http:[^"]+)"/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, url: m[1]!, stderr: () => err });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`server exited ${code}: ${err}`), { code, stderr: err }));
    });
  });
}

function rawPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "d3mcp-http-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(url),
      token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {},
    ),
  );
  return client;
}

describe("Streamable HTTP transport (loopback, no token)", () => {
  let s: Running;
  beforeAll(async () => {
    s = await startServer({});
  });
  afterAll(() => {
    s?.proc.kill("SIGTERM");
  });

  it("binds to 127.0.0.1 and reports health", async () => {
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const r = await fetch(s.url.replace("/mcp", "/healthz"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it("serves the full tool set to the official SDK client and renders a chart", async () => {
    const client = await connect(s.url);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(17);
      const r = (await client.callTool({
        name: "d3_visualize",
        arguments: { data: simpleBars, prompt: "value by category", visualization_type: "bar" },
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as { mark_count: number }).mark_count).toBe(5);
    } finally {
      await client.close();
    }
  });

  it("keeps independent sessions and handles concurrent heavy renders", async () => {
    const [a, b] = await Promise.all([connect(s.url), connect(s.url)]);
    try {
      const big = {
        nodes: Array.from({ length: 800 }, (_, i) => ({ id: `n${i}` })),
        links: Array.from({ length: 1600 }, (_, i) => ({
          source: `n${i % 800}`,
          target: `n${(i * 31 + 7) % 800}`,
        })).filter((l) => l.source !== l.target),
      };
      const t0 = Date.now();
      const heavy = a.callTool({
        name: "d3_visualize",
        arguments: { data: big, prompt: "graph", visualization_type: "force" },
      });
      const light = await b.callTool({
        name: "d3_visualize",
        arguments: { data: network, prompt: "graph", visualization_type: "force" },
      });
      const lightMs = Date.now() - t0;
      const heavyRes = (await heavy) as CallToolResult;
      expect((light as CallToolResult).isError).toBeFalsy();
      expect(heavyRes.isError).toBeFalsy();
      expect(lightMs).toBeLessThan(5000);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("rejects foreign Origin and Host headers (DNS rebinding protection)", async () => {
    expect((await rawPost(s.url, INIT, { origin: "https://evil.example" })).status).toBe(403);
    expect((await rawPost(s.url, INIT, { host: "evil.example" })).status).toBe(403);
  });

  it("requires initialize first and rejects unknown sessions", async () => {
    const r1 = await rawPost(s.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r1.status).toBe(400);
    const r2 = await rawPost(
      s.url,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
    );
    expect(r2.status).toBe(404);
  });

  it("rejects malformed JSON without crashing", async () => {
    const u = new URL(s.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end("{not json");
    });
    expect(status).toBe(400);
    expect((await fetch(s.url.replace("/mcp", "/healthz"))).status).toBe(200);
  });
});

describe("Streamable HTTP transport (bearer token)", () => {
  let s: Running;
  beforeAll(async () => {
    s = await startServer({ D3MCP_HTTP_TOKEN: TOKEN });
  });
  afterAll(() => {
    s?.proc.kill("SIGTERM");
  });

  it("returns 401 without or with a wrong token", async () => {
    expect((await rawPost(s.url, INIT)).status).toBe(401);
    expect((await rawPost(s.url, INIT, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("accepts the SDK client with the correct token", async () => {
    const client = await connect(s.url, TOKEN);
    try {
      expect((await client.listTools()).tools.length).toBe(17);
    } finally {
      await client.close();
    }
    expect(s.stderr()).not.toContain(TOKEN);
  });
});

describe("Streamable HTTP transport (unsafe configuration)", () => {
  it("refuses to bind a non-loopback host without a token", async () => {
    const err = (await startServer({ D3MCP_HTTP_HOST: "0.0.0.0" }).catch((e: unknown) => e)) as {
      code: number;
      stderr: string;
    };
    expect(err.code).not.toBe(0);
    expect(err.stderr).toMatch(/Refusing to bind/);
  });
});
