# OpenChamber setup

Verified against [OpenChamber → MCP Servers](https://docs.openchamber.dev/mcp/) and, for the file-based schema, [OpenCode → MCP servers](https://opencode.ai/docs/mcp-servers/) (last updated 2026-10-27). Both were retrieved on 2026-10-28.

OpenChamber manages personal-scope servers in `~/.config/opencode/opencode.jsonc`. After adding the entry below, `opencode mcp list` should report `✓ d3-visualization connected`. Restart OpenChamber, or toggle the server in Settings → MCP, to pick it up in an open session.

OpenChamber sets up MCP servers in **Settings → MCP**. Server names may contain only lowercase letters, numbers, hyphens and underscores, so use `d3-visualization`.

In the examples below, replace `/path/to/d3-visualization-mcp` with the folder where you cloned this repository and `/Users/you` with your home folder. Use absolute paths.

## 1. Install prerequisites

```bash
node -v        # must be >= 20.19; `which node` gives the absolute path (e.g. /opt/homebrew/bin/node)
cd /path/to/d3-visualization-mcp
npm ci
npx playwright install chromium
```

## 2. Build

```bash
npm run build
```

## 3. Run manually

```bash
/opt/homebrew/bin/node /path/to/d3-visualization-mcp/dist/server/index.js
```

The process waits silently for MCP messages on stdin. stdout is reserved for the protocol, and the log goes to stderr (`{"level":"info","msg":"d3-visualization-mcp ready",...}`). Press Ctrl+C to stop.

## 4. Verify the handshake and tool discovery

```bash
npm run smoke
```

This launches the server, completes the MCP `initialize` handshake with the official SDK client, lists the 17 tools, creates a bar chart, opens it in Chromium and writes `reports/smoke-report.json`. A zero exit status means every mandatory check passed.

## 5. Add the server in OpenChamber

1. Open **Settings → MCP**.
2. Add a server with type **local**.
3. **Name:** `d3-visualization`
4. **Command:** `/opt/homebrew/bin/node /path/to/d3-visualization-mcp/dist/server/index.js`
   If the form takes the command and arguments as separate entries, enter the Node path and the path to `dist/server/index.js` as two items. If the path contains spaces or parentheses, keep it as one argument.
5. **Environment variables (optional):** `D3MCP_ARTIFACT_DIR=/Users/you/d3mcp-artifacts` keeps artifacts in a local folder. `D3MCP_DATA_DIRS=/Users/you/Downloads:/Users/you/Desktop` lets the server read files from those folders. `D3MCP_LOG_LEVEL=info`.
6. **Scope:** **personal** makes it available in every project. **project** saves it with the current project's settings.
7. Save. Servers are enabled by default and can be switched off without being deleted.

### File-based equivalent (OpenCode config schema)

OpenChamber runs on OpenCode, whose config stores local MCP servers under `mcp` with `type: "local"` and a **command array**. This is not the VS Code `servers` format or the portable `mcpServers` format:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "d3-visualization": {
      "type": "local",
      "command": ["/opt/homebrew/bin/node", "/path/to/d3-visualization-mcp/dist/server/index.js"],
      "environment": {
        "D3MCP_ARTIFACT_DIR": "/Users/you/d3mcp-artifacts",
        "D3MCP_DATA_DIRS": "/Users/you/Downloads:/Users/you/Desktop",
        "D3MCP_LOG_LEVEL": "info"
      },
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Set `timeout` above the 30 s default so PNG/PDF exports and browser validation have time to finish.

## 6–8. Enable and confirm the tools

After saving, check that the server is enabled. In a chat, the agent should list tools such as `d3_visualize`, `d3_create_dashboard`, `d3_link_datasets`, `d3_join_datasets` and `d3_list_capabilities` (17 in total; OpenCode shows them prefixed with the server name, e.g. `d3-visualization_d3_link_datasets`). OpenCode reads the tool list when the server starts, so restart OpenChamber, or toggle the server off and on, after rebuilding. If they don't appear, see troubleshooting below.

## 9. Run a real prompt

Paste the network fixture (`examples/network-graph/request.json` → `arguments.data`) and ask:

> Create an interactive force-directed network graph from the provided nodes and links. Color nodes by group, size them by degree, add searchable labels and tooltips, support zoom and pan, and export a standalone HTML file.

The agent should call `d3_visualize` with `visualization_type: "force"`. The prompt alone enables search and zoom, but you can also pass `options.interaction` explicitly. The result includes `files.html.path` and `files.svg.path`.

## 10. Open the artifact

```bash
open "<files.html.path>"
```

The HTML file is self-contained: d3 7.9.0 is embedded inline, a strict CSP is set, and it needs no network access. OpenChamber does not need to render it.

## 11. Linked dashboard from several files

> Build one interactive dashboard of WAN health by site and region from `examples/data-files/linked/`: wan-telemetry.csv, sites.xlsx, incidents.json, wan-topology.yaml and regions.geojson.

The server finds the links (site code, region) itself. When a link is ambiguous and the client doesn't show an MCP elicitation form, the tool returns `status: "needs_input"` with the question and options instead of guessing. The agent asks you in chat, then calls again with your choice as `links`. You can also say up front _"use devices.hostname = cpu.device"_, or _"pick the best match"_ (`link_mode: "best"`). Files must be inside a folder listed in `D3MCP_DATA_DIRS`.

## Troubleshooting

| Problem                                       | Check                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Server shows as failed                        | Run the exact command from step 3 in a terminal and read the stderr output.                       |
| `node: command not found`                     | Desktop apps may not inherit your shell `PATH`; use the absolute path `/opt/homebrew/bin/node`.   |
| `Cannot find module .../dist/server/index.js` | Run `npm run build`. Check the argument is one item, not split at a space in the path.            |
| Working directory                             | Not required; the server finds its data files relative to its own location.                       |
| Tool calls time out on PNG export             | Install Chromium (`npx playwright install chromium`) and raise `timeout`.                         |
| New tools missing after an update             | Run `npm run build`, then restart OpenChamber or toggle the server in Settings → MCP.             |
| `SECURITY_VIOLATION` for a data file          | The file is outside `D3MCP_DATA_DIRS`. Add its folder (colon-separated), then restart the server. |
| Logs                                          | stderr only (JSON lines). Set `D3MCP_LOG_LEVEL=debug` for more detail. User data is never logged. |
