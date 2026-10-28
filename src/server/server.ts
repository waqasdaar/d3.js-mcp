import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeCapabilities } from "../core/capabilities/registry.js";
import { VisualizationSpecSchema } from "../core/schema/spec.js";
import type { VisualizationService } from "../core/service.js";
import { registerInspectionTools } from "./tools/inspection.js";
import { registerLinkingTools } from "./tools/linking.js";
import { registerVisualizationTools } from "./tools/visualization.js";

export const SERVER_NAME = "d3-visualization-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `D3 visualization server. Typical flow:
1. d3_analyze_data or d3_recommend_visualizations to understand the data.
2. d3_visualize with data + prompt (or d3_create_spec then d3_render) to produce SVG + standalone HTML (+PNG/PDF).
3. d3_refine_visualization to adjust; d3_compose_visualizations for dashboards; d3_validate_visualization / d3_export as needed.
Artifacts are files on disk: return the HTML path to the user so they can open it in a browser. Data is never fetched from URLs.`;

export function createServer(svc: VisualizationService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerVisualizationTools(server, svc);
  registerLinkingTools(server, svc);
  registerInspectionTools(server, svc);

  server.registerResource(
    "visualization-spec-schema",
    "d3://schema/visualization-spec",
    {
      title: "Visualization specification JSON Schema (v1.0)",
      description: "JSON Schema for the reusable visualization specification",
      mimeType: "application/schema+json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: JSON.stringify(z.toJSONSchema(VisualizationSpecSchema, { io: "input" }), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "d3-api-coverage",
    "d3://capabilities/coverage",
    {
      title: "D3 API coverage",
      description: "Coverage of the official D3 API index by status",
      mimeType: "application/json",
    },
    async (uri) => {
      const r = computeCapabilities();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                source: r.source,
                retrievedAt: r.retrievedAt,
                d3Version: r.d3Version,
                totals: r.totals,
                modules: r.modules,
                statusRules: r.statusRules,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  server.registerPrompt(
    "visualize-data",
    {
      title: "Visualize data with D3",
      description:
        "Guide the model to analyze a dataset and produce a D3 visualization through this server's tools",
      argsSchema: {
        question: z.string().describe("What do you want to learn from the data?"),
        chart: z.string().optional().describe("Preferred chart type, or leave empty"),
      },
    },
    ({ question, chart }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use d3_analyze_data on the provided data, then call d3_visualize with prompt "${question}"${chart ? ` and visualization_type "${chart}"` : ""}. Report the explanation, findings, limitations and the absolute HTML/SVG paths. Do not claim findings that are not in the tool output.`,
          },
        },
      ],
    }),
  );
  return server;
}
