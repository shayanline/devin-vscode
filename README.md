# Devin for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/shayanline.devin-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

**Chat with the Devin coding agent inside VS Code.** Ask it to build a feature,
fix a bug, refactor, or explain code, and watch it work in a side panel:
streaming replies, live tool calls, and every edit shown as a diff you can keep
or undo. Your chats are saved per workspace, so you can pick any one back up
later. No terminal, no context switching.

The interface is inspired by GitHub Copilot Chat and follows the same design, so
if you use Copilot it feels familiar from the first message.

> **Preview.** Early release, under active development. Expect rough edges and
> frequent updates. Feedback and issues are welcome.

## Install

1. In VS Code open Extensions, search for **Devin for VS Code**, and click
   Install. Or run `code --install-extension shayanline.devin-vscode`.
2. Install the [Devin CLI](https://docs.devin.ai) and sign in with
   `devin auth login`.

On first run the extension finds the CLI and helps you finish setup.

## What you get

- Streaming answers with the agent's reasoning shown as it works
- Every file edit as a native diff, keep or undo per file
- Approve tool actions and answer the agent's questions inline
- A session browser, grouped by workspace, that survives restarts
- `/` for commands and skills, `@` to attach files, and image paste
- Markdown replies with syntax highlighting and Mermaid diagrams

## Screenshots

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" width="30%" />
<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" width="30%" />
<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" width="30%" />
<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" width="30%" />

## Settings

Set defaults like model, mode, and checkpoints in the **Devin** section of VS
Code settings.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
