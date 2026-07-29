# 08, MCP (Model Context Protocol)

Copilot has first class MCP management: an `mcpServerDefinitionProvider`, a
GitHub MCP server integration with toolset/readonly/lockdown settings, MCP
elicitation UI, and an install/validate flow. Devin loads its own MCP servers
(from `~/.config/devin/config.json` / `.devin/config.json`) automatically when
the ACP session starts, so functionally MCP "works", but our extension exposes
no MCP UI.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| MCP servers connect and their tools are usable | Native, user configured | Devin connects all configured servers on session start (observed over ACP) | ✅ | Works, but invisible to the user. |
| See which MCP servers are connected/failed | Native MCP view + status | ❌ (only in the raw ACP output log) | ❌ | ACP emits `_cognition.ai/mcp/serversChanged` and output logs. Surface a small MCP status list (connected/failed). Medium value. |
| Add / remove / enable / disable MCP servers from UI | Native | ❌ | 🟡 | Devin CLI has `devin mcp add/remove/enable/disable`. Could wrap in commands. |
| MCP elicitation (server asks the user) | Native (improved UI in 0.40) | Handled generically via our elicitation renderer if routed over ACP | 🟡 | Our elicitation handling should cover it; verify with a real MCP elicitation. |
| MCP OAuth login flow | Native | Devin CLI handles OAuth (`devin mcp login`) agent side | ➖ | Could add a "MCP login" command wrapper. |
| GitHub MCP server integration + toolsets | Native, many settings | ➖ | ➖ | Copilot specific packaging. Devin users configure MCP directly. Out of scope. |
| MCP server registry / install flow | Native `mcp.setup.*` | ➖ | ➖ | Out of scope. |

The pragmatic parity target: a **read only MCP status panel** (which servers
are connected/failed, and their tool counts), plus optional thin command
wrappers around `devin mcp ...`. Full MCP management UI is not necessary because
Devin already owns that configuration.
