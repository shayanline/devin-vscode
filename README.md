# Devin for VS Code

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/shayanline.devin-vscode.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs-short/shayanline.devin-vscode.svg?label=Installs)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

A native chat panel for the [Devin CLI](https://docs.devin.ai), built on the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). It runs
`devin acp` as a subprocess and speaks JSON-RPC over stdio, so you get the full
agent experience inside VS Code: streaming replies, live tool calls, inline
permission prompts, per workspace sessions, and trackable diffs.

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

Every chat you start is a real Devin session, grouped by the workspace folder it
belongs to. A liveness dot shows whether a session is running, waiting for you,
waking up, or stopped, and each row can be resumed, renamed, or deleted.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" alt="The session browser grouped by workspace folder, with liveness dots and a new-chat composer" width="440" />

### A full agent turn

Plan tracking, a collapsible group of tool calls, inline file references in the
reply, plus the two ways Devin asks for input: a permission prompt with approve
or deny buttons, and an interactive question rendered as clickable options.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" alt="A full turn with a plan, grouped tools, a permission prompt, and an interactive question" width="440" />

### Fixing a bug and proving it

A focused turn: the reasoning stream, grouped tool calls, an edit rendered with
its line counts, a benchmark run, the end of turn file changes summary, and the
context window ring in the composer.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" alt="A bug fix turn showing reasoning, tool calls, an edit, a benchmark result, and inline file references" width="440" />

### Research and diagrams

Web search, fetch, and MCP tools each render distinctly, and Markdown replies
support rich content, including Mermaid diagrams drawn inline.

<img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" alt="Web search, fetch, and MCP tool cards followed by a rendered Mermaid flowchart" width="440" />

## Requirements

- The Devin CLI installed and on your PATH (`devin --version`).
- Authenticated once via `devin auth login`.

If `devin` is not on your PATH, set an absolute path in `devin.cliPath`. On first
run the extension shows a setup panel that detects the CLI and helps you log in.

## Features

- Streaming chat backed by a persistent `devin acp` session, with the agent's
  reasoning shown live as it thinks.
- Model picker and session mode selector (Code, Ask, Plan, Bypass), populated
  from the CLI itself, plus a thinking effort picker for models that support it.
- A session browser: click the back arrow to see your sessions, click one to
  open it. Sessions are grouped by repository in multi root workspaces and
  persist across restarts, with resume, rename, and delete.
- Per workspace session list, scoped to the current window (separate lists for
  separate `.code-workspace` files), with live status dots and take over of a
  session that is running elsewhere.
- Multi root aware: every folder in a `.code-workspace` is passed to Devin, and
  its sessions are grouped by folder.
- Rich tool cards: reads, edits, terminal runs, web search, fetch, and MCP tools
  each render distinctly, and consecutive calls collapse into a grouped card.
- Plan tracking, a context window usage ring, and an end of turn summary of the
  files that changed.
- Slash commands and skills: type `/` to autocomplete Devin's commands and your
  skills. Type `@` to search and attach workspace files.
- The agent's questions are shown as clickable options, and permission prompts
  are surfaced as approve or deny buttons.
- Agent file edits are tracked as a working set with native VS Code diffs and per
  file keep or undo, plus inline per hunk revert in the editor gutter.
- Checkpoints and editable requests: restore the workspace and conversation to
  an earlier turn, or edit a sent message to rewind and re-run from that point
  (requires the Devin CLI revert capability).
- Context attachments: add files or the current selection, paste images, and
  include the active editor file as implicit context per message.
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
- `devin.extraArgs`, `devin.env`: extra arguments and environment variables for
  the `devin acp` process.

## Commands

Available from the Command Palette under the **Devin** category: New Session,
Show Sessions, Open Chat, Cancel Current Turn, Run Setup, and About / Status.
Accept and reject actions for tracked changes appear in the source control view.

## Building from source

- `npm install` to install dependencies.
- `npm run watch` (or `npm run compile`), then press F5 in VS Code to launch an Extension Development Host.
- `npm run check-types` type checks and `npm test` runs the webview unit tests.
- `npm run package` builds a `.vsix` you can install with `code --install-extension`.
- `npm run preview -- --scenario full` opens a mock chat in a browser for fast UI iteration without the CLI. See [the screenshots guide](docs/screenshots.md) for the scenarios behind the images above and how to regenerate them.

## Releasing

Releases are automated. To cut one:

1. Bump the version and create the tag: `npm version patch` (or `minor` / `major`).
2. Push it: `git push --follow-tags`.

The [release workflow](.github/workflows/release.yml) then type checks, tests, builds the extension, creates a GitHub Release with the `.vsix` attached, and publishes to the VS Code Marketplace (and Open VSX). The [CI workflow](.github/workflows/ci.yml) runs the same checks on every push and pull request.

One time setup for Marketplace publishing:

- Create the `shayanline` publisher on the [Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
- Generate an Azure DevOps personal access token scoped to Marketplace publish.
- Add it as a repository Actions secret named `VSCE_PAT` (and optionally `OVSX_PAT` for Open VSX).

While `"preview": true` is set in `package.json`, the Marketplace listing keeps the preview badge.

## Acknowledgements

Inspired by the community `Devin-Cli_Chat` extension by Luiz Alberto Abarca
Ferrarezi, and by the design of GitHub Copilot Chat. This is an independent
rewrite around the ACP protocol.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html), copyright Shayan
Khaksar. Use it, study it, change it and share it, at work or anywhere else. If
you distribute a modified version, or run one as a network service, it stays
under the same license with its source available.

Commercial licenses are available if those terms do not suit you. Open an issue
to ask.
