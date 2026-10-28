import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: "reports/playwright-artifacts",
  reporter: [["list"], ["json", { outputFile: "reports/browser-results.json" }]],
  // Font rasterization differs per OS, so baselines are stored per platform.
  snapshotPathTemplate: "tests/browser/__screenshots__/{platform}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      threshold: 0.15,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "functional", testIgnore: /visual\.spec\.ts/ },
    {
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
    },
  ],
});
