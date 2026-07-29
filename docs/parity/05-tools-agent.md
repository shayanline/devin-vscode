# 05, Tools and the agent loop

Copilot ships 37 built in language model tools, groups them into tool sets, and
gives users a tool picker per mode. Devin's tools live inside the Devin CLI and
run agent side, exposed to us over ACP as `tool_call` events plus permission
requests. So the tools themselves are not our concern, but the **visibility and
control** over them is.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Rich set of built in tools (read, edit, search, terminal, fetch, problems, tests, notebooks, etc.) | 37 contributed tools | Provided by Devin CLI agent side | ➖ | We do not author tools; Devin does. Not a gap. |
| Tool invocation shown in chat | Native expandable row | Static pill (title only) | ❌ | See `01`. The most visible tool gap. |
| Tool inputs/outputs visible | Native (expandable, file widget, URI list) | ❌ | ❌ | ACP carries `rawInput`, `content`, `locations`. Render them. |
| Tool confirmation before dangerous actions | Native confirmation with details | ACP `session/request_permission` → buttons | ✅ | Parity. |
| Terminal tool with live output + auto approve controls | Native (auto approve allow/deny lists, per command) | ❌ | ❌ | Enable ACP terminal capability; consider surfacing Devin's permission modes as the "auto approve" analogue. |
| Tool picker (enable/disable tools per request/mode) | Native tool picker + tool sets | ➖ | 🟡 | Devin's tool availability is governed by mode/profile and MCP config, not per request. Could surface which tools/MCP are active (read only display). |
| Tool sets (named groups of tools) | Native `languageModelToolSets` + user defined | ➖ | ➖ | Not applicable to our model. |
| Virtual tool grouping (when too many tools) | Native (`virtualTools.threshold`) | ➖ | ➖ | Agent side concern for Devin. |
| MCP tools | Native (see `08-mcp.md`) | Devin loads its own MCP servers automatically | 🟡 | We should surface MCP status/among tools. See `08`. |
| Todo / plan tool rendering | Native todo tool invocation part + plan | We render ACP `plan` entries as a checklist | ✅ | Parity for plans. Could make it a live updating, collapsible todo widget. |
| Subagent invocations shown | Native `ChatSubagentToolInvocationData` (nested) | ❌ | 🟡 | Devin can spawn subagents; render nested activity if ACP exposes it. |
| "Show tools" / tool log / debug view | Native chat debug panel, request logger, export | Devin output channel (raw ACP log) | 🟡 | We log raw ACP to the output channel. Copilot has a dedicated inspector. Low priority for users. |
| Agent auto continue / max turns / loop control | Native agent loop with limits, `/loop` | Devin runs the loop agent side; `/loop` available as a slash command | ✅ | Parity via slash commands. |
| Agent auto fix on errors | `agent.autoFix` setting | Agent side | ➖ | Devin decides. |
| Context compaction | Native background compaction + `/compact` | `/compact` available as a slash command | 🟡 | Add a visible "compact" action near the context meter. |
