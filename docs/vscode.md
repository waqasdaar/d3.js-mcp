# VS Code setup

Verified against the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) (page last updated 2026-10-21, retrieved 2026-10-28).

Placeholders used below (replace them with your own values):

| Item         | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Node.js      | `/opt/homebrew/bin/node` on macOS with Homebrew; run `which node` to find yours (≥ 20.19) |
| Project      | `/path/to/d3-visualization-mcp` (where you cloned this repository)                        |
| Server entry | `/path/to/d3-visualization-mcp/dist/server/index.js`                                      |
| VS Code CLI  | `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code` on macOS           |

Use absolute paths: GUI apps may not inherit your shell `PATH`.

## 1. Build

```bash
cd /path/to/d3-visualization-mcp
npm ci
npx playwright install chromium   # PNG/PDF export and browser validation
npm run build
npm run smoke                     # starts the real server and runs a full tool round trip
```

## 2. Configure — VS Code format (`.vscode/mcp.json`)

This repository ships a VS Code-format config at [`.vscode/mcp.json`](../.vscode/mcp.json), used when you open the `d3-visualization-mcp` folder. If you open a parent folder instead, put a copy in that folder's `.vscode/mcp.json` and point `args` at `${workspaceFolder}/d3-visualization-mcp/dist/server/index.js`.

The project-level file:

```json
{
  "servers": {
    "d3-visualization": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["${workspaceFolder}/dist/server/index.js"],
      "env": {
        "D3MCP_DATA_DIRS": "${workspaceFolder}/examples/data-files",
        "D3MCP_LOG_LEVEL": "info"
      },
      "dev": { "watch": "dist/**/*.js" }
    }
  }
}
```

- `D3MCP_DATA_DIRS` allows the server to read local files from those folders (colon-separated), for example `/Users/you/Downloads:/Users/you/Desktop`.
- `dev.watch` uses VS Code's MCP development mode: when `npm run build` rewrites `dist/`, VS Code restarts the server automatically, so new tools and fixes are picked up without a manual restart.

To make the server available in **every** workspace instead, add it to your user profile with `code --add-mcp` (below) and remove the workspace files to avoid duplicates.

### HTTP alternative

Run `npm run start:http`, then:

```json
{ "servers": { "d3-visualization-http": { "type": "http", "url": "http://127.0.0.1:3333/mcp" } } }
```

If `D3MCP_HTTP_TOKEN` is set, add `"headers": { "Authorization": "Bearer ${input:d3mcp-token}" }` and an `inputs` entry of type `promptString` with `password: true`.

Optional `env` keys: `D3MCP_ARTIFACT_DIR` (default `<project>/artifacts`; point it at a local folder such as `/Users/you/d3mcp-artifacts` if the project lives in a cloud-synced folder), `D3MCP_MAX_ROWS`, `D3MCP_MAX_INPUT_BYTES`, `D3MCP_ARTIFACT_TTL_HOURS`, `D3MCP_BROWSER_TIMEOUT_MS`, `D3MCP_RENDER_WORKERS`, `D3MCP_RENDER_TIMEOUT_MS`.

### Alternative: user profile via the CLI

`code --add-mcp` writes the VS Code format into your **user profile** configuration:

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --add-mcp '{"name":"d3-visualization","type":"stdio","command":"/opt/homebrew/bin/node","args":["/path/to/d3-visualization-mcp/dist/server/index.js"]}'
```

### `servers` vs `mcpServers`

|                                            | VS Code format                                | Portable Copilot format                                    |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------- |
| File                                       | `.vscode/mcp.json` or user-profile `mcp.json` | workspace-root `.mcp.json` or `~/.copilot/mcp-config.json` |
| Top-level key                              | `servers`                                     | `mcpServers`                                               |
| `type` for stdio                           | `"stdio"` (required)                          | optional                                                   |
| `cwd`, `envFile`, `inputs`, `dev`, sandbox | supported                                     | not supported (`.mcp.json`)                                |
| Env references                             | `${env:NAME}`                                 | `${NAME}` / `${NAME:-default}`                             |

Equivalent portable `.mcp.json`:

```json
{
  "mcpServers": {
    "d3-visualization": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/d3-visualization-mcp/dist/server/index.js"]
    }
  }
}
```

Do not paste one format into the other's file. Other clients (Claude Desktop, Cursor, OpenChamber/OpenCode) have their own schemas — see [openchamber.md](openchamber.md).

## 3. Start and inspect

1. Save `.vscode/mcp.json`. A **Start** code lens appears above the server entry; click it (or run **MCP: List Servers** → `d3-visualization` → **Start Server**).
2. **MCP: List Servers** → `d3-visualization` → **Show Output** shows the server's stderr log (JSON lines). A healthy start logs `d3-visualization-mcp ready`.
3. In Chat (Agent mode), open the tools picker: 17 tools prefixed `d3_` should be listed, including `d3_create_dashboard`, `d3_link_datasets` and `d3_join_datasets`.
4. After rebuilding the server, `dev.watch` restarts it. If the tool list still looks stale, run **MCP: Reset Cached Tools**.

## 4. Run a real request

In Agent mode:

> Use d3_visualize with this data: [{"site":"SJC","tickets":42},{"site":"NYC","tickets":31},{"site":"LON","tickets":57}] — compare tickets by site as a bar chart and export HTML, SVG and PNG.

The tool result contains `files.html.path`, `files.svg.path` and `files.png.path` (absolute paths) plus `how_to_open`. Open the HTML from a terminal:

```bash
open "<files.html.path from the result>"
```

VS Code chat does not render the HTML inline; the file is self-contained and works offline.

### Linked dashboard from several files

> Using the files in `examples/data-files/linked/` (wan-telemetry.csv, sites.xlsx, incidents.json, wan-topology.yaml, regions.geojson), build one interactive dashboard of WAN health by site and region: latency, packet loss and incidents.

The agent calls `d3_create_dashboard` with five `datasets`, and the server links them by site code and region. VS Code supports MCP **elicitation**: when a link is ambiguous (for example, two columns both match), VS Code shows a form in chat asking which field links the datasets. Your answer goes straight back to the server, and the dashboard is built with that link. In the HTML, click any site, bar, node or region to select it in every chart.

## 5. Troubleshooting

| Symptom                    | Fix                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn node ENOENT`        | GUI apps may not inherit your shell `PATH`; use the absolute Node path (`which node`).                                                                        |
| Server exits immediately   | Run the same command in a terminal: `/opt/homebrew/bin/node ".../dist/server/index.js"`. If `dist/` is missing, run `npm run build`.                          |
| Tools missing after update | **MCP: Reset Cached Tools**, then restart the server.                                                                                                         |
| `png` in `export_errors`   | Run `npx playwright install chromium` in the project.                                                                                                         |
| `EACCES` writing artifacts | Set `D3MCP_ARTIFACT_DIR` to a writable directory.                                                                                                             |
| Cloud-sync churn           | Artifacts default to `<project>/artifacts`. If the project is in a cloud-synced folder, set `D3MCP_ARTIFACT_DIR` to a local path such as `~/d3mcp-artifacts`. |

See also [troubleshooting.md](troubleshooting.md).
