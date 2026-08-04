# Changelog

All notable changes to **Devin for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This extension is a fast moving preview. During early development many patch
> builds were packaged locally without a separate tag, so the entries below the
> first Marketplace release (0.6.61) group those rapid iterations by milestone
> rather than listing every intermediate build.

## [0.6.87] - 2026-08-04

A large iteration on the settings surface (the Devin customizations editor),
plus a session lifecycle fix. This groups the rapid builds from 0.6.66 through
0.6.87.

### Added
- Create flows throughout the settings: new skill (scaffolds a SKILL.md), add
  MCP server, add hook, and install plugin. Each opens from an Add button in the
  section and is presented as a modal.
- A Plugins section listing installed plugins with update and remove, and an
  install form (a Git source or a local path).
- MCP OAuth login and logout. Login runs in a terminal so the interactive code
  flow can complete, and the buttons follow the real login state read from the
  stored tokens, so a signed in server shows only Log out.
- Edit and remove actions on skills, instructions, hooks, and MCP servers.
  Removals confirm first, and Edit opens the underlying file next to the
  settings tab.
- Reset to defaults per value section (Models, Behaviour, Network, Advanced),
  which clears that section's keys in the chosen scope.
- Per scope grouping across every project aware section (Instructions, Skills,
  MCP, Hooks, Permissions, and the value sections). Each shows a User group and
  one group per workspace folder, so a multi root workspace is fully supported
  without a folder switcher.
- An "Overridden in Workspace" hint on a User setting when a folder genuinely
  sets a different value.
- Advanced toggles for a PTY backed non interactive exec and OSC escape
  sequences.

### Changed
- MCP servers are read from the correct location (`mcp_config.json` globally and
  under `.devin/` per folder), so configured servers actually appear.
- MCP subtitles show a safe summary only (the URL host and path, or the command
  name), never the raw command, args, or headers, so tokens are not exposed.
- Instructions read AGENTS.md first and fall back to CLAUDE.md. Create always
  creates AGENTS.md.
- Action buttons (edit, remove, and so on) are icon only with tooltips, and
  buttons no longer show a stray border.
- Files opened from the settings now open as a tab next to the settings tab.

### Fixed
- Leaving an active session mid turn and returning no longer throws "Agent
  communication channel closed" or scrambles message order. Leaving detaches the
  running turn, and returning reattaches instead of reloading over the live
  channel.
- MCP remove, enable, and disable pass the matching scope, so global servers can
  be removed.
- Skill paths the CLI prints with a `~` prefix now resolve correctly.
- The "Overridden in Workspace" hint no longer shows when the folder value
  matches the User value.
- The empty leading card in the Hooks section is gone.

### Removed
- The separate gitignored "local" scope. Settings use User and Workspace only,
  and you decide what to gitignore.

## [0.6.65] - 2026-07-31

Three features carried over from GitHub Copilot Chat, modelled on the VS Code
chat contrib.

### Added
- **New session locations.** The `+` in the chat title is now a split button (a
  primary `+` plus a chevron) offering New Session in the sidebar, in the editor
  area, in a new window, or as a Devin CLI session in a terminal. Multiple editor
  and window chats can run at once, each an independent surface.
- **Embedded sessions panel.** A history button in the chat header toggles a
  sessions list beside the chat when the surface is wide enough (~600px) and
  stacked above it when narrow, using the same rule on every surface. The list
  gained a toolbar: new session, refresh, a status filter (all / running / idle),
  and a collapsible search under an icon.
- **Settings surface.** A gear opens a Devin customizations editor exposing the
  full Devin CLI config surface: default model and mode, rules and instructions,
  skills, MCP servers (add, enable, disable, remove via the CLI), hooks,
  permissions, behaviour (attribution, updates, notifications, gitignore), proxy
  and sandbox, and terminal display settings, each with a user / project / local
  scope where supported.

### Changed
- The chat provider was refactored into a per surface controller managed by a
  ChatManager, so the sidebar view and each editor/window panel run independently
  while sharing the session store and change tracker.

## [0.6.64] - 2026-07-31

### Fixed
- Opening the same session twice in quick succession no longer spawns a second
  `devin acp` process that orphaned the first and held its session lock. Loads
  and wakes now share a single in flight promise per session id.
- Outstanding permission and question requests are now cancelled on every
  teardown path (terminate, delete, idle exit, process exit), so the agent's
  client side calls never hang and no dead prompt is left on screen.
- `dispose()` now clears the resolver maps, the implicit context timer, the
  in flight load map, and the change list subscription, closing several leaks
  on window reload.
- Relative file paths from the agent resolve against the session working
  directory instead of the extension host working directory.
- `activeId` is reset when a load or wake fails, so a failed open no longer
  leaves the panel pointing at a runtime that no longer exists.

### Changed
- Composer attachments are cleared when switching to an already live session,
  so they do not bleed between chats.
- Background sessions can now queue more than one pending prompt and re-surface
  all of them when reopened.
- Large streaming responses render on a coarser cadence to cap CPU on very long
  turns, and redundant session list rebuilds on unchanged status ticks are
  skipped.
- Transient per session UI (working set deltas, context usage ring, docked
  plan, working placeholder) is reset when switching sessions so it does not
  carry over.
- Hardened shell quoting for the sign in command, and made the model family
  sort and the live terminal selector robust against unusual input.

### Removed
- Dropped dead webview message handlers (`newSession`, `reviewChanges`,
  `addSelection`, `saveDefaults`) and the unused `authStarted` message.

## [0.6.63] - 2026-07-30

### Changed
- Rewrote the README around the Devin CLI: clearer framing, corrected the docs
  links, and a two per row screenshot layout.
- Noted that the interface is inspired by and mirrors GitHub Copilot Chat.

## [0.6.62] - 2026-07-30

### Changed
- Trimmed the README to end user content and moved the build and release notes
  into `CONTRIBUTING.md`.
- Reframed the intro and the screenshot captions around the VS Code integration
  rather than Devin itself.

### Fixed
- Marketplace badge: moved to badgen after the previous badge provider started
  erroring, and dropped a flaky install count badge.

## [0.6.61] - 2026-07-30

First public release on the VS Code Marketplace (and Open VSX). This rolls up
the rapid preview builds from 0.6.39 through 0.6.61.

### Added
- Release automation: a tag push builds the extension, creates a GitHub Release
  with the packaged VSIX, and publishes to the Marketplace and Open VSX.
- Marketplace preview metadata and a richer README with screenshots.
- Richer tool call cards, grouped consecutive tool calls into a single
  disclosure, and Mermaid diagram rendering in replies.

### Changed
- Mirrored the VS Code and Copilot chat UI more closely, with fixes to session
  handling, request editing, and scroll behaviour.
- Pinned the GitHub Actions to current major versions.

## 0.6.38 - 2026-07-30

### Added
- Images in responses and tool results, inline keep and undo per file edit, and
  clickable web fetch results.

## 0.6.37 - 2026-07-30

### Added
- Terminate controls for a running session, Copilot style send and stop icons,
  and polished terminal cards.

## 0.6.36 - 2026-07-30

### Added
- Session transcripts are retained in the webview, so returning to an idle
  session restores it instantly without a reload.

## 0.6.35 - 2026-07-30

### Added
- One `devin acp` process per session with live status dots, so a session keeps
  running in the background while you look at another.

## 0.6.34 - 2026-07-30

### Changed
- Retry now regenerates the response in place, reloads are cleaner, the input
  border animation is smoother, and a boot loader covers startup.

## 0.6.33 - 2026-07-30

### Fixed
- A round of review fixes across the composer and session lifecycle.

## 0.6.30 to 0.6.31 - 2026-07-30

### Changed
- Tool cards render kind aware bodies instead of raw argument JSON (0.6.30).

### Fixed
- Agent terminal commands run through a shell, so compound command lines
  (`cd`, `&&`, pipes, globs, quoting) work as in a real terminal (0.6.31).

## 0.6.23 to 0.6.29 - 2026-07-30

VS Code Copilot Chat parity, second pass (phases A to F).

### Added
- Motion foundation and entrance animations for streamed response parts.
- Composer polish, higher fidelity content parts, a docked plan and a working
  set summary.
- A thinking peek that shows the latest reasoning while it streams, then
  collapses, plus a time flip on timestamps.

### Fixed
- Behaviour gaps found during the parity pass.

## 0.6.8 to 0.6.22 - 2026-07-29

VS Code Copilot Chat parity, first pass (phases 1 to 8), plus visual polish.

### Added
- Interactive question support (elicitation) with a question carousel and
  answered question recaps.
- Collapsible thinking with a "Thought for Xs" summary, expandable tool call
  cards with inputs, results and locations, and a hover toolbar on code blocks
  (copy, insert, apply, run).
- Message actions, a welcome screen, actionable errors, a usage bar, a todo
  style plan, a used references summary, and a working shimmer.
- A settings driven capability model and a checkpoint restored divider.

### Changed
- A design token foundation, VS Code style tool invocation labels, file
  reference pills, and more breathing room between turns.

## 0.6.0 to 0.6.7 - 2026-07-28 to 2026-07-29

Initial development: the foundation of the extension.

### Added
- ACP backed Devin chat panel for VS Code, with streaming replies.
- Workspace scoped sessions, Devin CLI detection, and a first run setup flow.
- A diff working set with per file keep and undo, session rename and delete,
  and context attachments.
- A Copilot style history view with slash and `@` autocomplete, and question
  options.
- Bundled markdown-it and highlight.js for rich rendering.
- A model picker populated from `devin models list`, grouped by family with a
  filter, with no session required.
- Live terminal output streaming over the ACP terminal capability.
- Edit in place, checkpoints, and undo via the ACP revert capability.
- A rich status bar popover with the signed in account, plan, version and
  links.

### Fixed
- Kill the whole agent process group on dispose so MCP servers are not leaked,
  and reap stranded `devin acp` agents on activation.
- Correct loaded session replay, right aligned request bubbles, a self healing
  session list, and faster startup.

### Testing
- A jsdom based webview test harness with regression tests, and a browser
  preview harness for visual iteration.

[0.6.87]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.87
[0.6.65]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.65
[0.6.64]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.64
[0.6.63]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.63
[0.6.62]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.62
[0.6.61]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.61
