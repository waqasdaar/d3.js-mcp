import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DIST = path.resolve("workbench", "dist", "index.html");
let server: ChildProcess | undefined;
let url = "";

test.beforeAll(async () => {
  test.skip(!existsSync(DIST), "Run npm run workbench:build first");
  server = spawn(
    process.execPath,
    [
      path.resolve("node_modules", "vite", "bin", "vite.js"),
      "preview",
      "--config",
      "workbench/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--strictPort",
      "false",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite preview did not start")), 20_000);
    server!.stdout!.on("data", (b: Buffer) => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/?)/.exec(
        b.toString().replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""),
      );
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

test("workbench renders the sample with D3 inside a React host and re-renders on type change", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const host = page.getByTestId("chart-host");
  await expect(host.locator("svg.d3mcp-root")).toHaveCount(1);
  await expect(host.locator("rect.bar")).toHaveCount(4);
  await page.locator("select").first().selectOption("pie");
  await expect(host.locator("path.arc")).toHaveCount(4);
  await expect(host.locator("svg.d3mcp-root")).toHaveCount(1);
  await page.locator("textarea").fill('[{"broken": ');
  await expect(page.getByRole("alert")).toBeVisible();
  expect(errors).toEqual([]);
});
