import { useCallback, useMemo, useState } from "react";
import { ingest, type IngestLimits } from "../../src/core/data/ingest.js";
import { profileDataset } from "../../src/core/data/profile.js";
import type { Dataset } from "../../src/core/data/types.js";
import { computeFindings } from "../../src/core/planning/findings.js";
import { planVisualization, type Plan } from "../../src/core/planning/planner.js";
import { VIS_TYPES, type VisType } from "../../src/core/schema/spec.js";
import { D3Chart } from "./D3Chart";

const LIMITS: IngestLimits = {
  maxRows: 50_000,
  maxColumns: 500,
  maxInputBytes: 10_000_000,
  maxCellChars: 10_000,
  maxHierarchyNodes: 20_000,
  maxGeoFeatures: 5_000,
};

const SAMPLE = JSON.stringify(
  [
    { region: "North", product: "Router", revenue: 120 },
    { region: "North", product: "Switch", revenue: 80 },
    { region: "South", product: "Router", revenue: 95 },
    { region: "East", product: "Router", revenue: 150 },
    { region: "East", product: "Switch", revenue: 70 },
    { region: "West", product: "Switch", revenue: 55 },
  ],
  null,
  2,
);

function parseInput(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) return JSON.parse(t);
  return { format: t.split("\n")[0]!.includes("\t") ? "tsv" : "csv", text: t };
}

export function App() {
  const [text, setText] = useState(SAMPLE);
  const [prompt, setPrompt] = useState("Compare revenue by region");
  const [type, setType] = useState<VisType | "auto">("auto");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [error, setError] = useState<string | null>(null);
  const [svgMarkup, setSvgMarkup] = useState("");
  const [marks, setMarks] = useState(0);

  const result = useMemo((): { plan: Plan; dataset: Dataset; findings: string[] } | { error: string } => {
    try {
      const dataset = ingest(parseInput(text), LIMITS);
      const plan = planVisualization({
        dataset,
        profile: profileDataset(dataset),
        prompt,
        type,
        options: { theme, width: 900, height: 520 },
      });
      return { plan, dataset, findings: computeFindings(plan.spec, dataset) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text, prompt, type, theme]);

  const onRendered = useCallback((o: { markCount: number; svgMarkup: string }) => {
    setError(null);
    setMarks(o.markCount);
    setSvgMarkup(o.svgMarkup);
  }, []);
  const onError = useCallback((m: string) => setError(m), []);

  const download = () => {
    const url = URL.createObjectURL(new Blob([svgMarkup], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "chart.svg";
    a.click();
    URL.revokeObjectURL(url);
  };

  const planError = "error" in result ? result.error : null;
  return (
    <div className={`wb ${theme}`}>
      <style>{CSS}</style>
      <aside>
        <h1>D3 Workbench</h1>
        <label>
          Data (JSON records, graph, hierarchy, GeoJSON, CSV or TSV)
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false} />
        </label>
        <label>
          Prompt
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as VisType | "auto")}>
            <option value="auto">auto</option>
            {VIS_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value as "light" | "dark")}>
            <option>light</option>
            <option>dark</option>
          </select>
        </label>
        <button type="button" onClick={download} disabled={!svgMarkup || !!error || !!planError}>
          Download SVG
        </button>
        <p className="note">
          Rendering runs locally in this page with the same planner and renderers as the MCP server. Nothing
          is uploaded.
        </p>
      </aside>
      <main>
        {planError || error ? (
          <p role="alert" className="error">
            {planError ?? error}
          </p>
        ) : null}
        {"plan" in result ? (
          <>
            <p className="explain">
              <strong>{result.plan.chosenType}</strong> · {marks} marks — {result.plan.explanation}
            </p>
            <D3Chart
              spec={result.plan.spec}
              dataset={result.dataset}
              onRendered={onRendered}
              onError={onError}
            />
            {result.findings.length ? (
              <ul className="findings">
                {result.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

const CSS = `
body{margin:0;font:14px system-ui,sans-serif}
.wb{display:grid;grid-template-columns:340px 1fr;min-height:100vh}
.wb.dark{background:#111827;color:#e5e7eb}
aside{padding:16px;border-right:1px solid #8884;display:flex;flex-direction:column;gap:12px}
aside h1{font-size:18px;margin:0}
label{display:flex;flex-direction:column;gap:4px;font-weight:600}
textarea,input,select{font:12px ui-monospace,monospace;padding:6px;border:1px solid #8888;border-radius:4px;background:inherit;color:inherit}
button{padding:8px;border-radius:4px;border:1px solid #8888;cursor:pointer}
main{padding:16px;overflow:auto}
.chart-host svg{max-width:100%;height:auto}
.error{color:#dc2626;font-weight:600}
.note{font-size:12px;opacity:.7}
.findings{font-size:13px}
`;
