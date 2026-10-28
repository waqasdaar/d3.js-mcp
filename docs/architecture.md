# Architecture

## Layers

| Layer            | Path                                | Responsibility                                                                                                                |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Protocol adapter | `src/server/index.ts`, `server.ts`  | stdio transport, server info and instructions, resources, prompt, graceful shutdown                                           |
| Tools            | `src/server/tools/*.ts`, `util.ts`  | Zod input schemas, a loose `{ok}` output schema, uniform success/error envelopes                                              |
| Ingestion        | `src/core/data/ingest.ts`           | Records / CSV / TSV / JSON / graph / hierarchy / GeoJSON → `Dataset`; limits; forbidden keys                                  |
| Profiling        | `src/core/data/profile.ts`          | Type inference, missing values, uniques, numeric summaries, Tukey outliers, temporal span, Pearson r                          |
| Planning         | `src/core/planning/`                | `recommend` ranks types; `planner` builds a spec; `refine` applies natural-language edits; `findings` gives descriptive facts |
| Spec             | `src/core/schema/spec.ts`           | Versioned (1.0), strict Zod schema; exported as JSON Schema in `schemas/` and as an MCP resource                              |
| Renderers        | `src/renderers/`                    | Plugin registry (`RendererPlugin`) with families chart / statistical / hierarchy / network / geo / spatial / custom           |
| Plugins          | `src/plugins/sankey.ts`             | Non-core D3 extension (`d3-sankey`), registered like any other renderer                                                       |
| Validation       | `src/core/validation/structural.ts` | SVG/HTML safety and structure, mark counts, accessibility, PNG/PDF signatures                                                 |
| Export           | `src/export/`                       | Standalone HTML (inline d3 + CSP-hashed runtime), Chromium PNG/PDF and browser inspection                                     |
| Artifacts        | `src/core/artifacts/store.ts`       | Session-scoped directories, ID validation, path confinement, metadata, TTL cleanup                                            |
| Capabilities     | `src/core/capabilities/`            | Official API inventory → per-symbol status from actual renderer, runtime and composition usage                                |
| Composition      | `src/core/composition/executor.ts`  | Declarative, whitelisted D3 operations with step references                                                                   |
| Workbench        | `workbench/`                        | React + Vite UI that reuses the planner and renderers in the browser                                                          |

## Request flow (`d3_visualize`)

1. Zod validates the arguments, and `resolveData` ingests and stores the dataset (`ds_*`).
2. `profileDataset` → `recommend` → `planVisualization` builds a spec. Prompt clauses such as "log scale" or "threshold at 50" go through `applyInstructions`.
3. `renderSvg` creates a jsdom document, the plugin draws with D3, and `validateSvg` checks the result. An invalid SVG throws, and nothing is written.
4. `buildHtml` embeds the SVG, d3 and the runtime, then `validateHtml` checks it.
5. The artifact directory gets `chart.svg`, `chart.html`, `spec.json`, plus optional `chart.png`/`chart.pdf` (Chromium) and `data.csv`.
6. The response contains the spec, mapping, transformations, assumptions, alternatives, findings, validation status, absolute paths and per-format export errors.

## Multi-source linking (`d3_create_dashboard` with `datasets`, `d3_link_datasets`, `d3_join_datasets`)

1. **Infer links.** `core/data/link.ts` `analyzeLinks` scores every field pair across datasets. The score combines value overlap after trimming and ignoring case, name similarity and cardinality. Clear links are kept; ambiguous ones become questions.
2. **Resolve questions.** `server/tools/linking.ts` `resolveLinks` puts open questions to the user through MCP elicitation (`elicitInput`, form mode) when the client supports it. Otherwise it returns `needs_input` with the questions.
3. **Build views.** `service.autoDashboard` with `links`:
   - adds joined views (`joinDatasets`, attributes only);
   - computes entity keys through the link graph (`entityKeys`, multi-hop, e.g. region → its sites);
   - colours maps by a linked measure.
4. **Tag marks.** Each chart's dataset copy gets a `_link` field, and the spec gets `interaction.link`. After the plugin draws, `render.ts` `tagLinkKeys` writes `data-link` tokens on every mark. They are read from the mark's bound datum (row, aggregated group, series, pie/stack/hierarchy node, feature) or from `__linkRows`, which renderers attach to aggregated marks.
5. **Embed records.** `buildHtml` embeds up to 500 rows per source as inert JSON (`#d3mcp-linked`).
6. **Runtime.** The HTML runtime selects matching tokens across charts on click and fills the detail panel using DOM text nodes only.

## Design decisions

- **Server-side D3 + jsdom.** Every artifact is validated before it is returned, and SVG export works without a browser. The browser is needed only for PNG/PDF and interaction checks.
- **Self-contained HTML.** d3 is inlined and the CSP uses `default-src 'none'`, so artifacts work offline and can't exfiltrate data.
- **Deterministic planner.** The same input always produces the same spec. Unknown instructions are reported back, never guessed.
- **Data is never fetched.** d3-fetch is marked `unsupported-by-current-runtime`, and the server has no fetch tool.
- **React hosts, D3 owns.** `workbench/src/D3Chart.tsx` gives D3 a container ref; React never reconciles the SVG subtree.
- **Loose output schema.** Tools declare `{ ok: boolean }` with `additionalProperties` allowed, so clients that validate `structuredContent` accept the rich results.

## Adding a visualization

```ts
import { registerRenderer } from "./src/renderers/registry.js";
registerRenderer({
  type: "my-chart",
  family: "custom",
  label: "My chart",
  description: "...",
  core: false,
  dataKinds: ["table"],
  requiredChannels: [["x", "y"]],
  d3Apis: ["scaleLinear", "line"],
  render(ctx) {
    /* draw into ctx.plot with d3 */ return { markCount, markSelector: "path.my-mark" };
  },
});
```

A type that should be selectable through `visualization_type` also needs adding to `VIS_TYPES` in `spec.ts`. `d3Apis` feeds the coverage report automatically.
