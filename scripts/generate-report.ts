/** Render reports/verification-report.md from reports/verification-report.json. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ROOT } from "../src/shared/config.js";

export interface StepResult {
  name: string;
  command: string;
  mandatory: boolean;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  summary: string;
  outputTail: string;
}

export interface VerificationReport {
  generatedAt: string;
  overall: "passed" | "failed";
  environment: Record<string, string>;
  steps: StepResult[];
  coverage?: Record<string, unknown>;
  outstandingFailures: string[];
}

export function renderMarkdown(r: VerificationReport): string {
  const lines = [
    "# Verification report",
    "",
    `Generated: ${r.generatedAt}  `,
    `Overall: **${r.overall.toUpperCase()}**`,
    "",
    "## Environment",
    "",
    ...Object.entries(r.environment).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Steps",
    "",
    "| Step | Mandatory | Status | Duration | Summary |",
    "|---|---|---|---|---|",
    ...r.steps.map(
      (s) =>
        `| ${s.name} | ${s.mandatory ? "yes" : "no"} | ${s.status} | ${(s.durationMs / 1000).toFixed(1)}s | ${s.summary.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    ),
    "",
  ];
  if (r.coverage) {
    lines.push("## D3 API coverage", "", "```json", JSON.stringify(r.coverage, null, 2), "```", "");
  }
  lines.push(
    "## Outstanding failures",
    "",
    ...(r.outstandingFailures.length ? r.outstandingFailures.map((f) => `- ${f}`) : ["None."]),
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = path.join(PACKAGE_ROOT, "reports", "verification-report.json");
  if (!existsSync(p)) {
    process.stderr.write("No reports/verification-report.json; run npm run verify\n");
    process.exit(1);
  }
  const md = renderMarkdown(JSON.parse(readFileSync(p, "utf8")) as VerificationReport);
  writeFileSync(path.join(PACKAGE_ROOT, "reports", "verification-report.md"), md);
  process.stderr.write("Wrote reports/verification-report.md\n");
}
