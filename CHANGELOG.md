# Changelog

All notable changes to **Devin for VS Code**, newest first. One line per change:
the commit messages carry the detail.

> This is a fast moving preview, so a few entries group several rapid builds
> under one milestone version where those builds were only ever installed
> locally. The builds between 0.6.65 and 0.6.91 reached the Marketplace together
> in 0.6.92.

## [Unreleased]

### Highlights
- Every step of a thought in a run is on the chain, not just the first.

## [0.10.5] - 2026-08-10

### Highlights
- Reasoning that turned out to be blank leaves no gap in a run.

## [0.10.4] - 2026-08-10

### Highlights
- A reloaded run shows the reasoning in it, instead of a line to nothing.

## [0.10.3] - 2026-08-10

### Highlights
- The chain runs through the middle of every glyph, not past the side of it.

## [0.10.2] - 2026-08-10

### Highlights
- A subagent's line stops clear of its icons instead of running into them.
- A thought's dot is the larger one, so it reads as a node, not a speck.

## [0.10.1] - 2026-08-10

### Highlights
- A thought in a run is a row like any other: same column, same spacing.

## [0.10.0] - 2026-08-10

Commands you can watch, and a panel that keeps saying what it is doing.

### Highlights
- Commands run in a real terminal you can open, watch and take over.
- Show Terminal opens it, Skip leaves it running and lets Devin move on.
- The gap between one action and the next says the agent is still working.
- When something is waiting on you, it says that instead.
- A delegated task's header follows its work, not the last tool it ran.
- An edit row opens what that edit did, the tray still opens the whole file.
- A queued message keeps what you attached to it, and shows it.
- Editing a queued one hands its attachments back to the composer.
- The MCP warning can be turned off, for this window or for good.
- Cmd+1 to Cmd+9 open your nine most recent chats from the panel.
- Each of those chats wears the shortcut that opens it in the list.
- Cmd+K Cmd+D opens the session list, Ctrl+K Ctrl+D on Windows and Linux.
- It is in the command palette as "Devin: Session List".
- Folded work keeps its spacing when you open it, instead of cramming.
- A run's line joins its first step instead of stopping short of it.
- Every step's line breaks around its own glyph, by the same margin.
- Windows: the CLI is found and run even when npm installed it as a shim.
- Windows: sessions, locks and take over read the right data directory.
- Windows: a dropped file attaches, and its diff and Undo find it.
- A file's own line endings survive an edit, so git sees the real change.
- Linux: an agent stranded by a crash is cleaned up on a systemd desktop.

### Under the hood
- VS Code 1.93 or newer, for the terminal shell integration API.
- The tests and the type check now run on Windows and macOS too.

## [0.9.3] - 2026-08-10

Saying what the agent is doing, and folding it away once it is done.

### Highlights
- A finished turn folds its work behind one line, leaving the answer out.
- While Devin works the transcript says so, in a word that shimmers.
- No spinner beside it: one signal, not two saying the same thing.
- Reduced motion keeps the word readable instead of washing it out.
- Opening a new file's diff no longer fails with a model error.

## [0.9.2] - 2026-08-10

Nothing you typed or were asked goes missing.

### Highlights
- A message that cannot be sent goes back in the box, and says why.
- Stopping a turn takes its open question with it.

## [0.9.1] - 2026-08-10

Sections that fold themselves, and stay folded when you come back.

### Highlights
- A run folds to its summary once it is over, and a finished thought with it.
- A reloaded session comes back folded, not laid out end to end.
- A folded section is out of reach of Tab and of find in page.
- A section is not folded away while you are reading inside it.
- A run or a thought you opened by hand stays open when it ends.
- More of the reasoning stays in view while it is still streaming.
- A run's chevron appears on hover, like every other one.

## [0.9.0] - 2026-08-08

A chat you can move, and a transcript that reads like VS Code's own.

### Highlights
- Move a chat between the side panel and an editor tab, live agent and all.
- A detached chat is only that chat, named after it, and survives a reload.
- What a chat holds follows it: draft, answers, attachments, plan and edits.
- The session list keeps itself up to date, so the Refresh button is gone.
- Type while Devin works: queue the message, or stop and send it now.
- A run of tools says what it did, chained like a chain of thought.
- Reasoning inside a run reads as text on that chain, with nothing to open.
- A command titles its own row and shows its output as it is produced.
- Changes waiting to be reviewed survive a window reload, counts included.
- Keep all and Undo all mark every edit in the transcript, not just one.
- A sent message keeps what was attached to it, a picture as its thumbnail.
- An MCP server that will not start is named in the chat, and can be dismissed.
- Settings lists Windsurf's MCP servers, and manages them in place.
- A finished turn says how long it took, with what it cost on hover.
- The sessions panel docks either side, and drags by its own header.
- A permission prompt shows the command it is asking you to allow.

### Under the hood
- A moved chat hands over its live runtime: no process, lock or turn restarts.
- Every surface is told when another starts, moves, stops or renames a chat.
- Drafts, attachments and the working set outlive the agent, in storage.
- Devin's output and turn stats notifications are read, not just logged.

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

[0.9.3]: https://github.com/shayanline/devin-vscode/releases/tag/v0.9.3
[0.9.2]: https://github.com/shayanline/devin-vscode/releases/tag/v0.9.2
[0.9.1]: https://github.com/shayanline/devin-vscode/releases/tag/v0.9.1
[0.9.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.9.0
[0.8.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.8.0
[0.7.1]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.1
[0.7.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.0
[0.6.93]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.93
[0.6.92]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.92
[0.6.63]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.63
[0.6.62]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.62
[0.6.61]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.61
