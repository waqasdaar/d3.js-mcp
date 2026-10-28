/** Check the runtime prerequisites: Node version, dependencies, build output, Chromium and the D3 inventory. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { browserAvailable, closeBrowser } from "../src/export/browser.js";
import { PACKAGE_ROOT } from "../src/shared/config.js";

interface Item {
  check: string;
  ok: boolean;
  mandatory: boolean;
  detail: string;
}

const items: Item[] = [];
const add = (check: string, ok: boolean, mandatory: boolean, detail: string) =>
  items.push({ check, ok, mandatory, detail });

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
add(
  "node >= 20.19",
  major > 20 || (major === 20 && minor >= 19),
  true,
  `${process.version} at ${process.execPath}`,
);

const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
for (const [name, spec] of Object.entries(pkg.dependencies)) {
  // Vendored tarballs are pinned as file:vendor/<name>-<version>.tgz.
  const want = /-(\d+\.\d+\.\d+[^/]*?)\.tgz$/.exec(spec)?.[1] ?? spec;
  const p = path.join(PACKAGE_ROOT, "node_modules", name, "package.json");
  const have = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version : null;
  add(
    `dependency ${name}`,
    have === want,
    true,
    have ? `installed ${have} (pinned ${spec})` : "missing — run npm ci",
  );
}
add("package-lock.json", existsSync(path.join(PACKAGE_ROOT, "package-lock.json")), true, "");
add(
  "build output",
  existsSync(path.join(PACKAGE_ROOT, "dist", "server", "index.js")),
  false,
  "dist/server/index.js (run npm run build)",
);
add(
  "D3 API inventory",
  existsSync(path.join(PACKAGE_ROOT, "data", "d3-api-inventory.json")),
  true,
  "data/d3-api-inventory.json",
);
const b = await browserAvailable();
await closeBrowser();
add(
  "Chromium (PNG/PDF/browser validation)",
  b.available,
  false,
  b.available
    ? `version ${b.version}`
    : `${b.reason ?? "unavailable"} — run: npx playwright install chromium`,
);

for (const i of items)
  process.stderr.write(
    `${i.ok ? "OK  " : i.mandatory ? "FAIL" : "WARN"}  ${i.check}${i.detail ? ` — ${i.detail}` : ""}\n`,
  );
const failed = items.filter((i) => i.mandatory && !i.ok);
process.stdout.write(JSON.stringify({ ok: failed.length === 0, items }, null, 2) + "\n");
process.exitCode = failed.length ? 1 : 0;
