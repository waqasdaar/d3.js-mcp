import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../shared/config.js";
import { D3McpError } from "../../shared/errors.js";
import { formatFromFilename, isSpreadsheet } from "./formats.js";

export function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function inside(child: string, dir: string): boolean {
  return child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * Turn a {file: ...} data input into an encoded input for `ingest`. Only regular files inside D3MCP_DATA_DIRS
 * are readable; symlinks are resolved before the check so they cannot escape the allow-list.
 */
export async function resolveFileInput(
  input: Record<string, unknown>,
  config: Pick<Config, "dataDirs" | "maxFileBytes">,
): Promise<{ data: Record<string, unknown>; file: string }> {
  if (!config.dataDirs.length) {
    throw new D3McpError(
      "SECURITY_VIOLATION",
      "Reading local files is disabled",
      "Set D3MCP_DATA_DIRS to one or more directories (separated by ':' on macOS/Linux, ';' on Windows), or pass the data inline.",
    );
  }
  let raw = String(input.file).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (!raw.toLowerCase().startsWith("file://")) {
      throw new D3McpError(
        "SECURITY_VIOLATION",
        "Only local file paths are accepted; URLs are never fetched",
        "Download the file into a data directory first.",
      );
    }
    raw = fileURLToPath(raw);
  }
  if (raw.includes("\0")) throw new D3McpError("SECURITY_VIOLATION", "Invalid file path");
  raw = expandHome(raw);
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(config.dataDirs[0]!, raw);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new D3McpError(
      "ARTIFACT_NOT_FOUND",
      `File not found: ${raw}`,
      `Allowed data directories: ${config.dataDirs.join(", ")}`,
    );
  }
  const allowed = await Promise.all(config.dataDirs.map((d) => realpath(d).catch(() => null)));
  if (!allowed.some((d) => d && inside(real, d))) {
    throw new D3McpError(
      "SECURITY_VIOLATION",
      `File is outside the allowed data directories: ${raw}`,
      `Allowed: ${config.dataDirs.join(", ")} (D3MCP_DATA_DIRS)`,
    );
  }
  const st = await stat(real);
  if (!st.isFile()) throw new D3McpError("INVALID_INPUT", `Not a regular file: ${raw}`);
  if (st.size > config.maxFileBytes) {
    throw new D3McpError(
      "LIMIT_EXCEEDED",
      `File is ${st.size} bytes; the limit is ${config.maxFileBytes}`,
      "Raise D3MCP_MAX_FILE_BYTES or reduce the file.",
    );
  }
  const format = (typeof input.format === "string" ? input.format : null) ?? formatFromFilename(real);
  if (!format) {
    throw new D3McpError(
      "INVALID_INPUT",
      `Cannot tell the format of ${path.basename(real)}`,
      'Set format, e.g. {file, format: "csv"}.',
    );
  }
  const buf = await readFile(real);
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "file" && k !== "format"));
  const data = isSpreadsheet(format)
    ? { ...rest, format, base64: buf.toString("base64"), filename: path.basename(real) }
    : { ...rest, format, text: buf.toString("utf8"), filename: path.basename(real) };
  return { data, file: real };
}
