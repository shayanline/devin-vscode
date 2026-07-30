# Devin for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/shayanline.devin-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

Bring the Devin coding agent into VS Code as a native chat panel, so you stop
switching to a terminal and work with it the way you already work in the editor.

It shows the whole session inside VS Code: streaming replies, the agent's
reasoning as it happens, tool calls as cards, every file edit as a diff you can
keep or undo, permission and question prompts inline, and a session browser for
your workspace. There is no extra account or service to set up, it uses the
[Devin](https://docs.devin.ai) you already sign in to.

> **Preview.** This is an early release and under active development. It works
> day to day, but expect rough edges and frequent updates. Feedback and issues
> are very welcome.

## Install

The extension is published to the VS Code Marketplace as a preview. Install it in whichever way suits you:

- In VS Code, open the Extensions view, search for "Devin for VS Code" by shayanline, and install.
- Or from a terminal, run `code --install-extension shayanline.devin-vscode`.
- Or download the `.vsix` from the [latest release](https://github.com/shayanline/devin-vscode/releases/latest) and run `code --install-extension devin-vscode-<version>.vsix`.

You also need the Devin CLI, see [Requirements](#requirements) below.

## Screenshots

### Session browser

Your sessions live in a browser inside the panel, grouped by the workspace
folder they belong to. A liveness dot marks each one as running, waiting on you,
waking, or stopped, and any row can be resumed, renamed, or deleted, so picking
work back up is one click away.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" alt="The session browser grouped by workspace folder, with liveness dots and a new-chat composer" width="440" />

### A full agent turn

A turn as the panel renders it: a tracked plan, a collapsible group of tool
calls, and file references in the reply that open the file on click. Requests
for input surface in place too, a permission prompt with approve or deny
buttons, and a multiple choice question as clickable options, so you answer
without leaving the editor.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" alt="A full turn with a plan, grouped tools, a permission prompt, and an interactive question" width="440" />

### Fixing a bug and proving it

The full shape of a fix, rendered inline: the reasoning stream, grouped tool
calls, an edit shown with its added and removed line counts, a benchmark run to
prove the result, an end of turn summary of the files that changed, and the
context window ring in the composer.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" alt="A bug fix turn showing reasoning, tool calls, an edit, a benchmark result, and inline file references" width="440" />

### Research and diagrams

Different tool types are drawn as distinct cards, so web search, fetch, and MCP
calls each read clearly at a glance. Markdown replies render rich content in the
panel, including Mermaid diagrams drawn inline.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" alt="Web search, fetch, and MCP tool cards followed by a rendered Mermaid flowchart" width="440" />

## Requirements

- The Devin CLI installed and on your PATH (`devin --version`).
- Authenticated once via `devin auth login`.

If `devin` is not on your PATH, set an absolute path in `devin.cliPath`. On first
run the extension shows a setup panel that detects the CLI and helps you log in.

## Features

- Streaming chat with the agent's reasoning shown live as it works.
- Pick the model and the session mode (Code, Ask, Plan, Bypass), and the
  thinking effort for models that support it.
- A session browser to open past chats and resume, rename, or delete them.
  Sessions are grouped by workspace folder and persist across restarts.
- Rich tool cards for reads, edits, terminal runs, web search, fetch, and MCP
  tools, with back to back calls collapsed into one group.
- Plan tracking, a context window usage ring, and an end of turn summary of the
  files that changed.
- Type `/` to autocomplete commands and skills, and `@` to search and attach
  files from your workspace.
- The agent's questions appear as clickable options, and permission prompts as
  approve or deny buttons.
- Every file edit is tracked with native VS Code diffs, keep or undo per file,
  and inline revert in the editor gutter.
- Restore the workspace and chat to an earlier point, or edit a sent message to
  rerun from there.
- Attach files or your current selection, paste images, and include the active
  file as context.
- Markdown replies with syntax highlighting and inline Mermaid diagrams.

## Settings

- `devin.cliPath`: path to the devin executable (auto detected if on PATH).
- `devin.defaultModel`, `devin.defaultMode`: defaults for new sessions.
- `devin.autoResumeLast`: resume the last session when the chat opens.
- `devin.idleSessionKeepAliveMinutes`: how long to keep an idle session alive
  before it is exited (0 keeps idle sessions alive indefinitely).
- `devin.showThinking`, `devin.thinking.style`: show the reasoning stream and how
  it is displayed while streaming.
- `devin.checkpoints.enabled`, `devin.checkpoints.showFileChanges`: turn level
  restore and the files changed summary.
- `devin.editRequests`: how to edit a previously sent message (inline, hover,
  input, or none).
- `devin.contextUsage.enabled`, `devin.implicitContext.enabled`,
  `devin.inlineReferences.style`, `devin.progressBorder.enabled`,
  `devin.incrementalRendering.animationStyle`, `devin.verbose`: composer and
  transcript presentation.
- `devin.extraArgs`, `devin.env`: extra arguments and environment variables
  passed to Devin.

## Commands

Available from the Command Palette under the **Devin** category: New Session,
Show Sessions, Open Chat, Cancel Current Turn, Run Setup, and About / Status.
Accept and reject actions for tracked changes appear in the source control view.

## Contributing

Contributions and issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
how to build, run, and release the extension.

## Acknowledgements

Inspired by the community `Devin-Cli_Chat` extension by Luiz Alberto Abarca
Ferrarezi, and by the design of GitHub Copilot Chat.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html), copyright Shayan
Khaksar. Use it, study it, change it and share it, at work or anywhere else. If
you distribute a modified version, or run one as a network service, it stays
under the same license with its source available.

Commercial licenses are available if those terms do not suit you. Open an issue
to ask.
