import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/security/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    reporters: ["default", "json"],
    outputFile: { json: "reports/unit-results.json" },
    env: { D3MCP_LOG_LEVEL: "error" },
  },
});
