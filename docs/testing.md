# Testing

| Suite                | Command                            | Location                                                                                         | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + security      | `npm run test:unit`                | `tests/unit`, `tests/security`                                                                   | Ingestion, profiling, planning/refinement, the spec schema, transforms, every renderer (geometry and mark counts), composition, capability registry, structural validation, service artifact writing, escaping and hardening                                                                                                                                                                                                                |
| MCP integration      | `npm run test:integration`         | `tests/integration/mcp.test.ts`                                                                  | Spawns `dist/server/index.js` over stdio with the official SDK client: initialization, tool/resource/prompt discovery, schemas, invalid arguments, unknown tools, every tool, the 10 required end-to-end scenarios, clean shutdown                                                                                                                                                                                                          |
| Browser              | `npm run test:browser`             | `tests/browser/*.spec.ts`                                                                        | Chromium loads real artifacts: no page errors, nonzero SVG, correct marks and proportions, axes and titles, tooltip, keyboard navigation, mobile viewport without overflow, brush, zoom, search, dashboard cross-filtering, canvas pixels, PNG validity, workbench                                                                                                                                                                          |
| Visual regression    | `npm run test:visual`              | `tests/browser/visual.spec.ts`                                                                   | Pixel comparison of 12 chart types plus a dashboard against committed baselines (`tests/browser/__screenshots__/<platform>/`), with `maxDiffPixelRatio` 0.2%. A control test proves that changing one bar's value fails the comparison.                                                                                                                                                                                                     |
| HTTP transport       | part of `npm run test:integration` | `tests/integration/http.test.ts`                                                                 | SDK HTTP client, sessions, concurrent heavy renders, bearer auth, Host/Origin rejection, unsafe-bind refusal                                                                                                                                                                                                                                                                                                                                |
| Render workers       | part of `npm run test:unit`        | `tests/unit/pool.test.ts`                                                                        | Identical output to inline rendering, error codes cross the worker boundary, event loop stays responsive during a 2k-node layout, parallelism, timeout termination and recovery                                                                                                                                                                                                                                                             |
| Multi-source linking | unit + integration + browser       | `tests/unit/link.test.ts`, `mcp.test.ts` scenarios 20–26, `artifacts.spec.ts` "linked dashboard" | Key inference across CSV/Excel/JSON/YAML/GeoJSON (case-insensitive); questions for ambiguous links; a real MCP elicitation round trip (accept and decline) with a second SDK client advertising `elicitation`; joins (left/inner, graph and geo enrichment, refusal of N:M explosions); mark tagging for every chart family; in Chromium, a click on a site or a region selects the same entities in every chart and fills the detail panel |
| Smoke                | `npm run smoke`                    | `scripts/smoke.ts`                                                                               | A full real round trip; writes `reports/smoke-report.json`; non-zero exit on any mandatory failure                                                                                                                                                                                                                                                                                                                                          |
| Everything           | `npm run verify`                   | `scripts/verify.ts`                                                                              | All of the above plus lint, format, types, build, schema, workbench, coverage, drift check, examples and benchmark → `reports/verification-report.{json,md}`                                                                                                                                                                                                                                                                                |

The end-to-end scenarios (integration test names `1.`–`10.`):

1. JSON → bar chart → SVG + HTML (5 bars counted in the SVG)
2. Time-series CSV → line chart → PNG (PNG signature checked, or a truthful `export_errors.png`)
3. Network → force graph (one `circle.node` per node)
4. Hierarchy → treemap and sunburst (≥ 10 marks each)
5. GeoJSON → projected map (6 feature paths)
6. Multiple measures → dashboard (4 charts)
7. Refinement preserves the encoding and links the parent artifact
8. Invalid datasets → `isError`, with no file paths
9. Malicious input escaped; malicious SVG rejected; traversal rejected
10. 25k-row dataset → canvas/warnings or `LIMIT_EXCEEDED`

Screenshots from browser runs go to `reports/screenshots/`. Visual review during development found and fixed three defects: lines turning black when selected, a duplicated threshold label, and an SI tick label ("500m"). Each now has an automated assertion.

## Updating visual baselines

When a rendering change is intentional:

```bash
npm run build
npm run test:visual:update   # rewrites tests/browser/__screenshots__/<platform>/*.png
```

Review the changed PNGs in the diff before committing. On a failed comparison, Playwright writes `*-expected.png`, `*-actual.png` and `*-diff.png` to `reports/playwright-artifacts/`. Platforms without baselines skip the visual tests and print the reason.

## Optional checks

- Browser tests need Chromium (`npx playwright install chromium`). `npm run verify` marks them as skipped (optional) when it is missing, rather than failing or claiming success.
- `audit:d3:check` needs network access to `raw.githubusercontent.com`.
