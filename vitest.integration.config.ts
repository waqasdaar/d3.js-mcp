import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "reports/integration-results.json" },
  },
});
