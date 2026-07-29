# Devin for VS Code

A native chat panel for the [Devin CLI](https://docs.devin.ai), built on the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com). It runs
`devin acp` as a subprocess and speaks JSON-RPC over stdio, so you get the full
agent experience inside VS Code: streaming replies, live tool calls, inline
permission prompts, per workspace sessions, and trackable diffs.

## Requirements

- The Devin CLI installed and on your PATH (`devin --version`).
- Authenticated once via `devin auth login`.

If `devin` is not on your PATH, set an absolute path in
`devin.cliPath`.

## Features

- Streaming chat backed by a persistent `devin acp` session.
- Model picker and session mode selector (Code, Ask, Plan, Bypass), populated
  from the CLI itself.
- Per workspace session list, scoped to the current window (separate lists for
  separate `.code-workspace` files), with resume, rename, and delete.
- Multi root aware: every folder in a `.code-workspace` is passed to Devin.
- Permission prompts surfaced as approve or deny buttons.
- Agent file edits are tracked as a working set with native diffs and per file
  keep or undo, plus inline per hunk revert in the editor gutter.
- Context attachments: add files or the current selection, and paste images.
- First run setup panel with CLI detection and login, and a status bar item.

## Settings

- `devin.cliPath`: path to the devin executable (auto detected if on PATH).
- `devin.defaultModel`, `devin.defaultMode`: defaults for new sessions.
- `devin.sessionScope`: `both`, `workspace`, or `directory`.
- `devin.autoResumeLast`: resume the last session when the chat opens.
- `devin.showThinking`, `devin.extraArgs`, `devin.env`.

## Status

Early work in progress. See the roadmap in the repository.

## Acknowledgements

Inspired by the community `Devin-Cli_Chat` extension by Luiz Alberto Abarca
Ferrarezi, and by the design of GitHub Copilot Chat. This is an independent
rewrite around the ACP protocol.

## License

MIT
