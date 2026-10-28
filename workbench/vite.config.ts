import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: false,
    fs: { allow: [path.resolve(import.meta.dirname, "..")] },
  },
});
