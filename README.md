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
- Per workspace session list (resume a previous conversation in one click).
- Permission prompts (Normal, Accept Edits, Plan, Bypass) surfaced as buttons.
- File edits made by the agent are tracked and viewable as native diffs.

## Status

Early work in progress. See the roadmap in the repository.

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
