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
PATH and helps you finish setup. It needs VS Code 1.93 or newer.

## What you get

- Streaming replies, with Devin's reasoning shown as it works.
- Work Devin hands to a subagent shown as its own collapsible block: the brief it
  was given, what it did and said, and the report it came back with. Move a
  running one between the foreground and the background from its header.
- Commands run in a real VS Code terminal you can open, watch and take over,
  streamed into the chat as they go. Leave a long one running and Devin moves on.
- Every file edit shown as a native VS Code diff, kept or undone per file: an
  edit row opens what that edit did, the changed files tray the whole change.
- Approve or decline the tools Devin runs, and answer its questions, inline in
  the chat. Allowing something for the whole session, or every project, is one
  level in, so the narrow yes stays the easy one.
- Rewind to any turn to undo what came after it, or fork that turn into a new
  chat to try a second answer while keeping the first.
- Right click in the editor or the Explorer for Devin's own actions: Explain
  This, Fix Problems Here, and Add File to Chat. The code, and the problems that
  editor reports, come with the question.
- Devin sees the errors and warnings your editor is already showing, and which
  file you are working in, so it does not have to run a build to find out.
- Open a chat in the sidebar, the editor area, a new window, or a terminal, from
  the `+` split button.
- Move a chat between the side panel and an editor tab, live agent and all: an
  editor tab is that one chat, named after it, and renamed from its tab menu.
- Sessions saved per workspace that survive restarts, listed in a built in panel
  grouped by workspace, with search and a status filter. `Cmd+K Cmd+D` opens the
  list, and `Cmd+1` to `Cmd+9` open your nine most recent chats.
- The Devin model and mode (code, smart, ask, plan, or bypass) picked from the
  composer, which offers whatever modes your CLI reports.
- A link to any chat, copied from its header, for sharing what Devin did.
- Commands run in the CLI's own sandbox, once you turn `devin.sandbox` on.
- The Devin CLI's own settings edited natively in a built in editor, no config
  files by hand: instructions, skills, plugins, MCP servers, hooks, permissions,
  and more, per machine or per workspace folder, with search. It writes the CLI's
  real config, so the `devin` command in your terminal picks up the same changes.
- `/` for Devin commands and skills, `@` to attach a file or a symbol from your
  code, and image paste.
- Files, folders and images dragged onto the chat attach as context. Hold Shift
  while dragging from the Explorer or an editor tab, since VS Code otherwise
  keeps that drag for itself.
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

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html), copyright Shayan
Khaksar. Use it, study it, change it and share it, at work or anywhere else. If
you distribute a modified version, or run one as a network service, it stays
under the same license with its source available.

Commercial licenses are available if those terms do not suit you. Open an issue
to ask.
