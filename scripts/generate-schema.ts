/** Write the visualization spec JSON Schema (v1.0) to schemas/visualization-spec.schema.json. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SPEC_VERSION, VisualizationSpecSchema } from "../src/core/schema/spec.js";
import { PACKAGE_ROOT } from "../src/shared/config.js";

const dir = path.join(PACKAGE_ROOT, "schemas");
mkdirSync(dir, { recursive: true });
const schema = {
  $id: "https://github.com/d3-visualization-mcp/schemas/visualization-spec.schema.json",
  title: `D3 MCP visualization specification v${SPEC_VERSION}`,
  ...z.toJSONSchema(VisualizationSpecSchema, { io: "input" }),
};
const out = path.join(dir, "visualization-spec.schema.json");
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
process.stderr.write(`Wrote ${out}\n`);
