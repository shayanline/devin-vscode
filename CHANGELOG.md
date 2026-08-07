# Changelog

All notable changes to **Devin for VS Code**, newest first. One line per change:
the commit messages carry the detail.

> This is a fast moving preview, so a few entries group several rapid builds
> under one milestone version where those builds were only ever installed
> locally. The builds between 0.6.65 and 0.6.91 reached the Marketplace together
> in 0.6.92.

## [0.8.2] - 2026-08-06

Moving between sessions and surfaces, and keeping what you had typed.

### Highlights
- Move a chat between the side panel and an editor tab, live agent and all.
- A chat open on another surface is marked, and offers to show or move it.
- Closing a detached tab asks: reopen, move it to the panel, or stop it.
- The sessions panel docks on the right by default, or the left, from a setting.
- Drag the panel by its own header to move it to the other side.
- Reloading the window puts you back in the chat you were reading.
- An unsent prompt is kept per chat, through switches, reloads and restarts.
- Answers given to a question, "Other" text included, survive leaving a session.
- Enter walks the questions and submits the last one, Shift+Enter for a line.
- A permission prompt now shows the command it is asking you to allow.
- Waiting on a subagent reads as agent work, naming the agent and the wait.
- Reasoning blocks, subagents and agent waits lead with their own icon.
- The header no longer narrates the tool that is running.
- JSON in tool input and output is formatted, coloured and can be copied.
- Terminal output and every tool block carry a copy action.
- A wrapped command keeps its prompt and Run action on its first line.
- Staged attachments follow a chat when it moves surfaces.
- A chat moved while Devin is working takes its transcript with it.
- Keeping a change no longer draws its diff as if the whole file were new.
- A restore no longer winds a kept file back further than the checkpoint.
- A pending question is no longer duplicated, or left over another chat.
- The question and permission trays scroll instead of hiding the transcript.
- Switching sessions keeps each chat's plan, changed files and context ring.
- The mode picker now shows the mode the session is really in.
- A resumed chat paints its replies with its tool calls, not seconds later.
- A replayed reasoning block reads "Thought", with the original time on hover.
- The sessions panel and switcher get the New Session split button.
- A collapsed plan, reasoning block or subagent takes only its header's height.
- Panel settings apply as you change them.

### Under the hood
- A moved chat hands over its live runtime: no process, lock or turn restarts.
- File edits are tracked per session, so a panel lists only its own chat's.
- Kept and undone files keep their original text, for open diffs and restores.
- Drafts live in workspace state, answers ride on the pending request.

## [0.8.0] - 2026-08-06

Devin's subagents, rendered in the panel.

### Highlights
- A subagent gets its own collapsible block: brief, everything it did, report.
- A subagent's tool calls no longer sit in the transcript stuck at pending.
- A running subagent can be moved between foreground and background.
- A file or folder dropped from outside VS Code now says where it came from.

### Under the hood
- Subagent streaming needs `cognition.ai/subagentSupport` to be advertised.
- An OS drag carries no filesystem path into a webview, hence the listing.

## [0.7.1] - 2026-08-06

### Highlights
- Dropping files onto the chat works again.
- The whole panel takes a drop, the sessions panel included.
- A drag started inside VS Code needs Shift held, which is VS Code's gesture.
- A folder dropped from outside attaches as a listing of what it holds.
- Escape stops the turn from the composer, not only Ctrl/Cmd+Esc.
- New Session is a split button: the label acts, the chevron picks where.

### Under the hood
- VS Code takes drag events off a webview, so they are claimed on the window.

## [0.7.0] - 2026-08-05

Chat quality: a message queue, background sessions, and calmer reading.

### Highlights
- Type while Devin works: messages queue, to edit, send now or drop.
- Drag files, images and folders onto the chat to attach them as context.
- The + button offers folders, and an image is attached as a real image.
- Copilot keyboard shortcuts for stop, the mode and model pickers, and recall.
- A session you leave keeps working, and replays its progress when you return.
- A background session needing input notifies you and pulses in the list.
- Questions get real checkboxes, a gated Submit, and text that follows the step.
- A large session no longer scrolls and reflows in front of you as it loads.
- Expanding a tool card or a thought no longer yanks you to the bottom.
- A plan step the agent skips shows struck through.
- Returning to the session list is instant, from cache, revalidated behind you.
- Loading shows as a bar along the top edge instead of a spinner.
- The list filter takes several states, and sorts by activity, state or name.
- An unsent draft stays with the session it was typed in.
- No carried over Stop button, frozen "Working…" line, or twice opened links.

### Under the hood
- A backgrounded session's stream is buffered on its runtime and replayed later.
- The queue lives on the runtime, so it survives every way of leaving a session.

## [0.6.93] - 2026-08-04

### Highlights
- Settings tags no longer break one letter per line in a narrow panel.

### Under the hood
- Every README screenshot is captured at one size, via a `--width` flag.

## [0.6.92] - 2026-08-04

### Highlights
- Every settings action shows that it is working and cannot fire twice.
- A disabled MCP server reads as switched off, struck through and dimmed.

### Under the hood
- The extension replies to every write, so a control cannot spin forever.

## [0.6.91] - 2026-08-04

### Highlights
- Icon only buttons carry a tooltip, on hover and on keyboard focus.
- A typed value sits under its label at full width, like VS Code's own editor.
- The add and install forms are a single full width column.
- Placeholders are useful examples again, with hints on the trickier fields.

### Under the hood
- Moving between settings sections re-reads the config, so no view is stale.

## [0.6.90] - 2026-08-04

### Highlights
- Every settings dropdown matches VS Code's own, keyboard handling included.
- Sandbox network mode is Full or Limited, with the detail in the row's hint.

## [0.6.89] - 2026-08-04

### Highlights
- The working set above the composer collapses, and scrolls once it grows tall.
- A turn cut short by a window reload says so, and offers "Send it again".

### Under the hood
- Shutdown waits for each agent to exit, so no orphan keeps the session lock.
- On Windows the whole agent process tree is killed, MCP servers included.

## [0.6.88] - 2026-08-04

A third of the vertical space, with nothing removed.

### Highlights
- Pick the scope once at the top instead of every setting repeating per scope.
- The **User** scope is now **Global**, since it applies to every workspace.
- Ten sections became eight, with small headings instead of bordered cards.
- A search box filters settings across every section at once.
- Each row says if the scope sets or inherits the value, with Clear override.
- A VS Code setting that overrides the CLI's model now says so, with links.
- The panel refreshes itself when the config changes, so Refresh is gone.

### Under the hood
- Setting a value back to the one that applies removes the key, as VS Code does.
- Import rules from other tools is scope aware instead of always writing Global.

## [0.6.87] - 2026-08-04

### Highlights
- Create flows for a skill, an MCP server, a hook and a plugin.
- A Plugins section, with install from a Git source or a local path.
- MCP sign in and out, following the real sign in state.
- Edit and remove on skills, instructions, hooks and MCP servers.
- Reset to defaults, per section and per scope.
- Multi root support: every project aware section groups by scope.

### Under the hood
- MCP servers are read from the right files, and never show secrets.
- Leaving a session mid turn and returning re-attaches instead of reloading.

## [0.6.65] - 2026-07-31

Three features carried over from GitHub Copilot Chat.

### Highlights
- New chat locations: the sidebar, an editor, a window, or a CLI terminal.
- A sessions panel beside the chat, with its own toolbar, search and filter.
- A settings editor for the whole Devin CLI configuration.

### Under the hood
- The chat provider became one controller per surface under a `ChatManager`.

## [0.6.64] - 2026-07-31

### Highlights
- Composer attachments no longer carry over into the wrong chat.
- A background session can queue more than one pending message.

### Under the hood
- Opening a session twice in quick succession no longer spawns a second agent.
- Prompts are cancelled on every teardown path, closing several reload leaks.
- A relative path from the agent resolves against the session's directory.

## [0.6.63] - 2026-07-30

### Under the hood
- Rewrote the README around the Devin CLI, with corrected links.

## [0.6.62] - 2026-07-30

### Under the hood
- Trimmed the README to end user content, build notes to `CONTRIBUTING.md`.
- Fixed the Marketplace badge and dropped a flaky install count.

## [0.6.61] - 2026-07-30

First public release on the VS Code Marketplace and Open VSX.

### Highlights
- Richer tool call cards, grouped tool runs, and Mermaid diagrams in replies.
- A closer match to VS Code and Copilot chat in sessions, editing, scrolling.

### Under the hood
- Release automation: a pushed tag builds, releases and publishes the extension.

## 0.6.38 - 2026-07-30

### Highlights
- Images in replies and tool results, inline keep and undo, clickable fetches.

## 0.6.37 - 2026-07-30

### Highlights
- A terminate control, Copilot send and stop icons, tidier terminal cards.

## 0.6.36 - 2026-07-30

### Highlights
- Transcripts are retained, so returning to an idle session is instant.

## 0.6.35 - 2026-07-30

### Highlights
- One agent process per session, with a live status dot in the list.

## 0.6.34 - 2026-07-30

### Highlights
- Retry regenerates in place, reloads are cleaner, and startup has a loader.

## 0.6.33 - 2026-07-30

### Under the hood
- A round of review fixes across the composer and the session lifecycle.

## 0.6.30 to 0.6.31 - 2026-07-30

### Highlights
- Tool cards render a body suited to the tool instead of raw argument JSON.

### Under the hood
- Agent commands run through a shell, so `cd`, `&&`, pipes and globs behave.

## 0.6.23 to 0.6.29 - 2026-07-30

A second pass at matching VS Code's Copilot Chat.

### Highlights
- Entrance animations for streamed parts, and a polished composer.
- A docked plan, a working set summary, and a live peek at the reasoning.

## 0.6.8 to 0.6.22 - 2026-07-29

A first pass at matching VS Code's Copilot Chat.

### Highlights
- Interactive questions from the agent, with a carousel and answered recaps.
- Collapsible thinking with "Thought for Xs", and expandable tool call cards.
- A welcome screen, message actions, context usage, and a to do style plan.
- A hover toolbar on code blocks: copy, insert, apply, run.

## 0.6.0 to 0.6.7 - 2026-07-28 to 2026-07-29

The foundation of the extension.

### Highlights
- A Devin chat panel for VS Code with streaming replies, backed by ACP.
- Workspace scoped sessions, Devin CLI detection, and a first run setup.
- A diff working set with keep and undo per file, and context attachments.
- A model picker from the CLI, grouped by family, usable before a session.
- Live terminal output, edit in place, checkpoints and undo.
- A status bar popover with the account, plan, version and links.
- Rich markdown rendering, with `markdown-it` and `highlight.js`.

### Under the hood
- The agent's whole process group is killed on dispose, so no MCP server leaks.
- A jsdom webview test harness, and a browser preview for visual iteration.

[0.8.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.8.0
[0.7.1]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.1
[0.7.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.0
[0.6.93]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.93
[0.6.92]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.92
[0.6.63]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.63
[0.6.62]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.62
[0.6.61]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.61
