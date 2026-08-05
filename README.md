# Devin for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/shayanline.devin-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

**Runs the [Devin CLI](https://docs.devin.ai/cli) in a native VS Code panel.**
Chat with Devin in a side panel instead of a terminal, and ask it to build a
feature, fix a bug, refactor, or explain code. Replies stream in, tool calls run
once you approve them, and every file edit is shown as a diff you can keep or
undo. Each chat is a real Devin CLI session, saved per workspace, so you can
reopen it later.

The interface follows GitHub Copilot Chat, so it is familiar if you already use
Copilot.

> **Preview.** Early release, under active development. Expect rough edges and
> frequent updates. Feedback and issues are welcome.

## Install

1. Install this extension: search **Devin for VS Code** in the Extensions view,
   or run `code --install-extension shayanline.devin-vscode`.
2. Install the [Devin CLI](https://docs.devin.ai/cli) and sign in with
   `devin auth login`.

The extension runs the Devin CLI for you. On first run it finds `devin` on your
PATH and helps you finish setup.

## What you get

- Streaming replies, with Devin's reasoning shown as it works.
- Every file edit shown as a native VS Code diff, kept or undone per file.
- Approve or decline the tools Devin runs, and answer its questions, inline in
  the chat.
- Open a chat in the sidebar, the editor area, a new window, or a terminal, from
  the `+` split button.
- Sessions saved per workspace that survive restarts, listed in a built in panel
  grouped by workspace, with search and a status filter.
- The Devin model and mode (code, ask, plan, or bypass) picked from the composer.
- The Devin CLI's own configuration edited from the gear: instructions, skills,
  plugins, MCP servers, hooks, permissions, and more, per machine or per
  workspace folder, with search.
- `/` for Devin commands and skills, `@` to attach files, and image paste.
- Markdown replies with syntax highlighting and inline Mermaid diagrams.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" width="100%" alt="The session browser, with sessions grouped by workspace folder and a liveness dot on each" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" width="100%" alt="A refactor turn: grouped tool calls, an edit with line counts, a plan, a question and a permission prompt" /></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" width="100%" alt="A bug fix on Claude Sonnet 4.5, with reasoning, grouped tools and an edit shown as a diff" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" width="100%" alt="A research turn on GPT-5: web search, fetch and MCP tool cards, and a Mermaid diagram rendered inline" /></td>
  </tr>
</table>

## Settings

Settings live in whichever place owns them, and each links to the other:

- **This extension** (session mode, the model new chats start with, the thinking
  display, checkpoints, edit requests, `devin.cliPath`) lives in the **Devin**
  section of VS Code settings. If `devin` is not on your PATH, point
  `devin.cliPath` at it.
- **The Devin CLI** (instructions, skills, plugins, MCP servers, hooks,
  permissions, proxy, sandbox) lives in **Devin: Open Settings**, the gear in the
  chat panel, which edits the CLI's own config files. Pick Global or a workspace
  folder at the top.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
