# 11, Copilot features that are N/A or out of scope for Devin

These exist in Copilot Chat but should **not** be on the Devin backlog, either
because they are Copilot/GitHub specific, or because they belong to the Devin
CLI rather than our extension, or because they are a different product surface
than an ACP chat client. Listed so nobody spends time on them.

| Feature | Why it is out of scope |
|---|---|
| Inline completions / ghost text | A separate completions product; the Devin CLI does not expose a completions endpoint to the extension. |
| Next Edit Suggestions (NES), xtab, edit prediction | Same as above, a completions subsystem. |
| BYOK model providers (Anthropic, OpenAI, Gemini, xAI, OpenRouter, Ollama, Azure, OpenAI compatible) | Devin manages models and credentials itself; we ask the CLI for the model list. |
| GitHub cloud / background "coding agent" delegation, PR bots | GitHub product. Devin has its own cloud sessions in the CLI, not wired into this extension. |
| Copilot CLI worktree/branch/commit/PR session management | Tied to Copilot's own CLI + GitHub worktree model. |
| Code citations / public code matching | Copilot policy feature. |
| Public code / content exclusion, `.copilotignore` semantics | Copilot specific; Devin has its own ignore handling. |
| Telemetry, OpenTelemetry export, experimentation flags | We ship no telemetry backend by design. |
| Enterprise device management, organization instructions/agents, policy | GitHub/Microsoft enterprise plumbing. |
| Dozens of `debug.*`, prompt archive/JSON export, request logger, NES capture, context inspector | Internal developer tooling for the Copilot team. A simple output channel is enough for us (we have it). |
| Alt text generation, rename suggestions, dev container config, semantic search view results | Peripheral editor AI features, not core to an ACP chat client. |
| Survey / feedback telemetry, "helpful/unhelpful" voting wired to a service | No backend to receive it. Could add local no ops if desired, but not parity critical. |
| Speech/voice (STT) | Depends on the VS Code Speech extension; optional, low priority. |
| Anthropic/OpenAI provider specific settings (thinking budgets, responses API, prompt caching, web search tool) | Provider tuning that Devin handles agent side. |

Anything Copilot does that is essentially "surface Devin CLI capability X" (MCP
management, hooks, skills, rules, subagents, review agent, `/loop`, `/compact`,
`/revert`) is **in scope** and lives in the other files, because the value is in
exposing what Devin already has.
