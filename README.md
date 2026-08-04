# Devin for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/shayanline.devin-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

**Brings the [Devin CLI](https://docs.devin.ai/cli) natively into VS Code.**
Chat with Devin in a side panel instead of a terminal. Ask it to build a
feature, fix a bug, refactor, or explain code, and watch it work: streaming
replies, live tool calls, and every edit shown as a diff you can keep or undo.
Each chat is a real Devin CLI session, saved per workspace, so you can pick any
one back up later.

The interface is inspired by GitHub Copilot Chat and follows the same design, so
if you use Copilot it feels familiar from the first message.

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

- Streaming answers, with Devin's reasoning shown as it works
- Every file edit as a native VS Code diff, keep or undo per file
- Approve the CLI's tool actions and answer its questions inline
- Open a new chat in the sidebar, the editor area, a new window, or a terminal (the `+` split button)
- An embedded sessions panel, beside the chat when there is room, with search, filter, and refresh
- A browser of your Devin CLI sessions, grouped by workspace, that survives restarts
- Pick the Devin model and mode right from the panel
- A settings surface (the gear) for the Devin CLI's own configuration: instructions, skills, plugins, MCP servers, hooks, permissions, and more, global or per workspace folder, with search
- `/` for Devin commands and skills, `@` to attach files, and image paste
- Markdown replies with syntax highlighting and Mermaid diagrams

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" width="100%" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" width="100%" /></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" width="100%" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" width="100%" /></td>
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
