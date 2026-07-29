# 07, Customization: instructions, prompt files, modes, skills, hooks, memory

Copilot has a large "agent customization" surface: custom instructions,
reusable prompt files, custom chat modes, skills, hooks, and a memory tool.
Devin has an equivalent extensibility model **in the CLI** (`AGENTS.md`, rules,
`.devin/skills`, subagents, hooks, MCP), but our extension exposes almost none
of it in the UI.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Custom instructions files | Native (`.github/copilot-instructions.md`, `*.instructions.md`, `codeGeneration.instructions` etc.) | Devin reads `AGENTS.md`/rules automatically (CLI), but no UI to view/create/edit | 🟡 | Devin honours instructions agent side. Add UI: detect and list active rules; a "create instructions" helper. |
| Reusable prompt files (`.prompt.md`) | Native `chatPromptFiles`; run via a picker; 7 built in prompts (plan, init, create-prompt, etc.) | ❌ in UI | ❌ | Devin skills are the closest analogue and are already surfaced via `/`. Could add first class prompt file support. |
| Custom chat modes | Native (user defined mode = tools + model + instructions) | ❌ | ❌ | Devin subagents/profiles are the analogue. Could expose subagent profiles as selectable modes. |
| Skills | Native `chatSkills` (SKILL.md), 6 built in | Devin skills are advertised over ACP and appear in `/` autocomplete | ✅ | Good parity for invocation. Missing: a manager UI (list/create/edit skills), which Copilot has via commands. |
| Skill/agent/mode creation helpers | Native prompts: create-prompt, create-instructions, create-skill, create-agent, create-hook | ❌ | 🟡 | Could add "Create skill/agent" commands that scaffold `.devin/...`. |
| Hooks | Native `chatHooks` + "Configure Hooks" (Claude agent) | Devin supports hooks (CLI `.devin/hooks.v1.json`); no UI | 🟡 | Add a "Configure Hooks" command that opens/scaffolds the file. |
| Memory | Native memory tool + "Show/Clear Memories" commands | Devin has a memory MCP configured; no dedicated UI | 🟡 | Optional: surface memory notes. |
| Organisation/enterprise instructions | Native (`organizationInstructions`, `organizationCustomAgents`) | ➖ | ➖ | Enterprise Copilot. Out of scope. |
| User preferences profile | Native (`enableUserPreferences`, "Open User Preferences") | ❌ | 🟡 | Low priority. |

Note: the strategic point is that Devin's customization is real and powerful,
but it lives in the CLI and on disk. The extension's opportunity is to **surface
and scaffold** it (rules, skills, subagents, hooks, MCP) rather than reinvent
it. See the `automation-recommender` idea.
