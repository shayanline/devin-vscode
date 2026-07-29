# Devin for VS Code, feature parity with GitHub Copilot Chat

This folder is a detailed, comprehensive comparison between our extension
(`devin-vscode`, a custom webview client for the Devin CLI over ACP) and the
GitHub Copilot Chat extension (`microsoft/vscode-copilot-chat`). It exists so a
later agent can pick up implementation work with a precise, prioritised backlog.

It was produced by reading the Copilot Chat source (its `package.json`
`contributes`, the proposed chat API type definitions it consumes, the tools
docs, and the changelog) and cross referencing every item against the current
state of `devin-vscode`.

## The single most important thing to understand

Copilot Chat does **not** draw most of its chat interface. It registers **chat
participants**, **language model tools**, **chat session providers**, and
**model providers** against VS Code's built in chat framework, and the VS Code
workbench renders the actual UI: the message list, collapsible reasoning, the
expandable tool call rows, code block Apply/Insert/Copy buttons, the model and
mode pickers, the `#` context picker, edit accept/reject overlays, checkpoints,
follow ups, and so on.

Our extension takes the opposite approach: a **custom webview** that talks to
`devin acp`. That was the right call (Devin is a full agent behind ACP, and the
native edit/agent surfaces are effectively Copilot gated), but it means every
one of those built in affordances has to be **re implemented by hand** in our
webview. Most of the gaps below are exactly that: native chat widget behaviour
we have not rebuilt yet.

There are two consequences worth stating up front:

1. A large share of "missing" items are UI affordances, not backend work. The
   ACP backend already streams the data (tool calls, diffs, reasoning, usage);
   we mostly need to render it richly.
2. A meaningful share of Copilot features are simply **not applicable** to us
   (Copilot inline completions/NES, GitHub cloud agents, BYOK model providers,
   telemetry/OTel, enterprise device management). Those are listed in
   `11-out-of-scope.md` so nobody wastes time on them.

## How to read the tables

Every area file has a table with these columns:

- **Feature**: the capability.
- **Copilot Chat**: how Copilot does it, and whether it is a native VS Code
  chat widget behaviour or Copilot extension code.
- **Devin (current)**: what `devin-vscode` does today.
- **Status**: parity marker (below).
- **Notes / effort**: where it lives, and a rough build estimate.

Status legend:

- ✅ **Parity**: we have a comparable capability.
- 🟡 **Partial**: we have some of it, but it is thinner or less polished.
- ❌ **Missing**: not implemented.
- ➖ **N/A**: not applicable to the Devin/ACP model, or out of scope.

## Index

| File | Area |
|---|---|
| `01-chat-ui-affordances.md` | Message rendering: reasoning, tool calls, code blocks, confirmations, follow ups, references, usage, feedback |
| `02-sessions-navigation.md` | Sessions list, history, resume, rename/delete, layout, empty states |
| `03-context-input.md` | Composer, `@`/`#` context, `/` commands, attachments, images, drag and drop, voice |
| `04-editing-diffs.md` | Applying edits, working set, accept/reject, checkpoints, undo |
| `05-tools-agent.md` | Tool system, tool picker, tool sets, confirmations, agent loop, subagents, todos |
| `06-models-modes.md` | Model picker, modes (Ask/Edit/Agent vs Devin modes), reasoning effort |
| `07-customization.md` | Custom instructions, prompt files, custom chat modes, skills, hooks, memory |
| `08-mcp.md` | MCP server management and UI |
| `09-editor-integrations.md` | Inline chat, completions/NES, code review, commit messages, PRs, terminal, notebooks, search |
| `10-settings-commands.md` | Settings, commands, keybindings, context menus, status bar, walkthrough |
| `11-out-of-scope.md` | Copilot features that are N/A for Devin |
| `12-backlog.md` | Prioritised implementation proposal |

## Source snapshot

- `microsoft/vscode-copilot-chat` cloned at analysis time (version line ~0.41,
  `package.json` ~220 KB, 134 commands, 37 tools, 9 chat participants, 11 model
  providers, 3 chat session types, 159 settings).
- `devin-vscode` at v0.5.0: 10 commands, 8 settings, 1 webview view, custom
  webview UI, ACP backend.
