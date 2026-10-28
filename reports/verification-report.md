# Verification report

Generated: 2026-10-28T15:47:59.433Z  
Overall: **PASSED**

## Environment

- node: v26.12.1 (/opt/homebrew/Cellar/node/26.12.1_1/bin/node)
- platform: darwin 27.0.0 arm64
- cpus: 12 × Apple M4 Pro
- memory: 24 GiB
- chromium: 156.0.8078.4
- d3: 7.9.0
- packageRoot: <project>

## Steps

| Step | Mandatory | Status | Duration | Summary |
|---|---|---|---|---|
| verify-install | yes | passed | 0.8s | ok |
| lint | yes | passed | 1.5s | 0 problems |
| format check | no | passed | 1.1s | all files formatted |
| typecheck | yes | passed | 1.9s | ok |
| build | yes | passed | 1.6s | ok |
| schema | yes | passed | 0.5s | ok |
| workbench typecheck | no | passed | 1.1s | ok |
| workbench build (Vite) | no | passed | 0.6s | ok |
| unit + security tests | yes | passed | 8.4s | 212/212 passed, 0 failed, 0 skipped |
| MCP integration tests | yes | passed | 9.9s | 46/46 passed, 0 failed, 0 skipped |
| browser tests (Playwright) | yes | passed | 14.2s | 27 passed, 0 failed, 0 skipped, 0 flaky |
| MCP smoke test | yes | passed | 2.2s | passed: 12/12 checks passed |
| D3 coverage report | yes | passed | 0.6s | ok |
| D3 API drift check (network) | no | passed | 0.8s | 1117 live entries; 0 added, 0 removed vs committed snapshot |
| examples | no | passed | 35.4s | 9 examples generated |
| benchmark | no | passed | 7.3s | 10/10 cases ok (reports/benchmark.json) |

## D3 API coverage

```json
{
  "source": "https://raw.githubusercontent.com/d3/d3/v7.9.0/docs/api.md",
  "retrievedAt": "2026-10-28T15:45:53.319Z",
  "countingMethod": "One entry per bullet in the official API index (docs/api.md): top-level exports, constructors, instance invocations (*x*) and instance methods (*x*.method). Duplicated bullets are counted once per module.",
  "totals": {
    "implemented-and-tested": 211,
    "implemented-with-constraints": 21,
    "available-through-safe-composition": 244,
    "documented-but-not-yet-implemented": 630,
    "unsupported-by-current-runtime": 11,
    "total": 1117,
    "percentages": {
      "implemented-and-tested": 18.89,
      "implemented-with-constraints": 1.88,
      "available-through-safe-composition": 21.84,
      "documented-but-not-yet-implemented": 56.4,
      "unsupported-by-current-runtime": 0.98
    }
  }
}
```

## Outstanding failures

None.
