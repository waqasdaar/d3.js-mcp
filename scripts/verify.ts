/**
 * npm run verify — run every supported check, distinguish mandatory failures from optional checks that
 * could not run, and write reports/verification-report.{json,md}. Exit 1 if any mandatory step fails.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeCapabilities } from "../src/core/capabilities/registry.js";
import { browserAvailable, closeBrowser } from "../src/export/browser.js";
import { PACKAGE_ROOT } from "../src/shared/config.js";
import { renderMarkdown, type StepResult, type VerificationReport } from "./generate-report.js";

const REPORTS = path.join(PACKAGE_ROOT, "reports");
mkdirSync(REPORTS, { recursive: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function readJson<T>(file: string): T | null {
  const p = path.join(REPORTS, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

function vitestSummary(file: string): string {
  const j = readJson<{
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
  }>(file);
  return j
    ? `${j.numPassedTests}/${j.numTotalTests} passed, ${j.numFailedTests} failed, ${j.numPendingTests} skipped`
    : "";
}

function playwrightSummary(): string {
  const j = readJson<{ stats: { expected: number; unexpected: number; skipped: number; flaky: number } }>(
    "browser-results.json",
  );
  return j
    ? `${j.stats.expected} passed, ${j.stats.unexpected} failed, ${j.stats.skipped} skipped, ${j.stats.flaky} flaky`
    : "";
}

function run(
  name: string,
  args: string[],
  mandatory: boolean,
  summarize?: (out: string) => string,
): StepResult {
  const t0 = Date.now();
  process.stderr.write(`\n▶ ${name}: ${args.join(" ")}\n`);
  const p = spawnSync(args[0]!, args.slice(1), {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", D3MCP_LOG_LEVEL: "error" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${p.stdout ?? ""}${p.stderr ?? ""}`;
  const status = p.status === 0 ? "passed" : "failed";
  const summary = (summarize?.(out) || (status === "passed" ? "ok" : `exit ${p.status ?? p.signal}`)).trim();
  process.stderr.write(`${status === "passed" ? "✔" : "✘"} ${name} — ${summary}\n`);
  return {
    name,
    command: args.join(" "),
    mandatory,
    status,
    durationMs: Date.now() - t0,
    summary,
    outputTail: out.split("\n").slice(-40).join("\n"),
  };
}

function skipped(name: string, command: string, mandatory: boolean, reason: string): StepResult {
  process.stderr.write(`\n- ${name} skipped — ${reason}\n`);
  return { name, command, mandatory, status: "skipped", durationMs: 0, summary: reason, outputTail: "" };
}

const steps: StepResult[] = [];
steps.push(run("verify-install", [npx, "tsx", "scripts/verify-install.ts"], true));
steps.push(
  run("lint", [npx, "eslint", "."], true, (o) =>
    /problems?/.test(o) ? (o.split("\n").find((l) => /problems?/.test(l)) ?? "") : "0 problems",
  ),
);
steps.push(
  run("format check", [npx, "prettier", "--check", "src", "tests", "scripts"], false, (o) =>
    /All matched files use Prettier/.test(o)
      ? "all files formatted"
      : `${(o.match(/\[warn\]/g) ?? []).length} file(s) need formatting`,
  ),
);
steps.push(run("typecheck", [npx, "tsc", "-p", "tsconfig.json", "--noEmit"], true));
steps.push(run("build", [npx, "tsc", "-p", "tsconfig.build.json"], true));
steps.push(run("schema", [npx, "tsx", "scripts/generate-schema.ts"], true));
steps.push(run("workbench typecheck", [npx, "tsc", "-p", "workbench/tsconfig.json"], false));
steps.push(
  run("workbench build (Vite)", [npx, "vite", "build", "--config", "workbench/vite.config.ts"], false),
);
steps.push(
  run("unit + security tests", [npx, "vitest", "run", "--config", "vitest.config.ts"], true, () =>
    vitestSummary("unit-results.json"),
  ),
);
steps.push(
  run("MCP integration tests", [npx, "vitest", "run", "--config", "vitest.integration.config.ts"], true, () =>
    vitestSummary("integration-results.json"),
  ),
);
const browser = await browserAvailable();
await closeBrowser();
if (browser.available) {
  steps.push(run("browser tests (Playwright)", [npx, "playwright", "test"], true, playwrightSummary));
} else {
  steps.push(
    skipped(
      "browser tests (Playwright)",
      "npx playwright test",
      false,
      `Chromium unavailable (${browser.reason ?? "unknown"}); run: npx playwright install chromium`,
    ),
  );
}
steps.push(
  run("MCP smoke test", [npx, "tsx", "scripts/smoke.ts"], true, () => {
    const s = readJson<{ overall: string; checks: Array<{ passed: boolean | null }> }>("smoke-report.json");
    return s
      ? `${s.overall}: ${s.checks.filter((c) => c.passed).length}/${s.checks.length} checks passed`
      : "";
  }),
);
steps.push(run("D3 coverage report", [npx, "tsx", "scripts/coverage-report.ts"], true));
steps.push(
  run("D3 API drift check (network)", [npx, "tsx", "scripts/audit-d3-api.ts", "--check"], false, (o) => {
    const m = /"liveEntries": (\d+),\s*"added": \[([^\]]*)\],\s*"removed": \[([^\]]*)\]/.exec(o);
    if (!m) return o.split("\n").find((l) => /Error/.test(l)) ?? "";
    const count = (s: string) => (s.trim() ? s.split(",").length : 0);
    return `${m[1]} live entries; ${count(m[2]!)} added, ${count(m[3]!)} removed vs committed snapshot`;
  }),
);
steps.push(
  run(
    "examples",
    [npx, "tsx", "scripts/generate-examples.ts"],
    false,
    (o) => `${(o.match(/marks/g) ?? []).length} examples generated`,
  ),
);
steps.push(
  run("benchmark", [npx, "tsx", "scripts/benchmark.ts"], false, (o) => {
    const lines = o.split("\n").filter((l) => /^(ok|FAIL)/.test(l));
    return `${lines.filter((l) => l.startsWith("ok")).length}/${lines.length} cases ok (reports/benchmark.json)`;
  }),
);

const cov = computeCapabilities();
const report: VerificationReport = {
  generatedAt: new Date().toISOString(),
  overall: steps.some((s) => s.mandatory && s.status !== "passed") ? "failed" : "passed",
  environment: {
    node: `${process.version} (${process.execPath})`,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    cpus: `${os.cpus().length} × ${os.cpus()[0]?.model ?? "unknown"}`,
    memory: `${Math.round(os.totalmem() / 2 ** 30)} GiB`,
    chromium: browser.available ? String(browser.version) : `unavailable: ${browser.reason}`,
    d3: cov.d3Version,
    packageRoot: "<project>",
  },
  steps,
  coverage: {
    source: cov.source,
    retrievedAt: cov.retrievedAt,
    countingMethod: cov.countingMethod,
    totals: cov.totals,
  },
  outstandingFailures: steps
    .filter((s) => s.status !== "passed")
    .map((s) => `${s.mandatory ? "[mandatory]" : "[optional]"} ${s.name}: ${s.status} — ${s.summary}`),
};
// Reports are committed, so local paths and the username are redacted.
const redact = (s: string) =>
  s
    .split(PACKAGE_ROOT)
    .join("<project>")
    .split(os.homedir())
    .join("~")
    .split(os.userInfo().username)
    .join("<user>");
writeFileSync(path.join(REPORTS, "verification-report.json"), redact(JSON.stringify(report, null, 2)) + "\n");
writeFileSync(path.join(REPORTS, "verification-report.md"), redact(renderMarkdown(report)));
process.stderr.write(`\nOverall: ${report.overall.toUpperCase()} — reports/verification-report.md\n`);
process.exitCode = report.overall === "passed" ? 0 : 1;
