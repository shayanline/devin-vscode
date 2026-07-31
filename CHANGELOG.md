# Changelog

All notable changes to **Devin for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This extension is a fast moving preview. During early development many patch
> builds were packaged locally without a separate tag, so the entries below the
> first Marketplace release (0.6.61) group those rapid iterations by milestone
> rather than listing every intermediate build.

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

[0.6.64]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.64
[0.6.63]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.63
[0.6.62]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.62
[0.6.61]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.61
