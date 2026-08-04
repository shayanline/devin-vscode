# Changelog

All notable changes to **Devin for VS Code** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This extension is a fast moving preview. During early development many patch
> builds were packaged locally without a separate tag, so the entries below the
> first Marketplace release (0.6.61) group those rapid iterations by milestone
> rather than listing every intermediate build.
>
> The same happened between 0.6.65 and 0.6.91: each was built and installed
> locally while the work was in progress, and they reach the Marketplace together
> in 0.6.92. Their entries are kept separate because each is a coherent change
> worth reading on its own.

## [Unreleased]

### Fixed
- Tags in a settings list (an MCP server's transport, `disabled`, the env count)
  no longer break one letter per line when the panel is narrow, which happens in
  a split editor group. They keep their width and wrap as whole tags.

## [0.6.92] - 2026-08-04

### Added
- Every action that hands work to the extension host now shows that it is
  running, and stops accepting input until it finishes, so nothing looks dead and
  the same write cannot be fired twice. An icon action swaps its glyph for a
  spinner, a toggle, dropdown or field dims, and a submitted form stays open with
  its button spinning until the host answers, rather than closing onto a panel
  that has not caught up. It covers everything, including disabling an MCP server,
  removing a permission, resetting a group, clearing an override and installing a
  plugin, because the controls derive it from whether the click actually gave the
  host work rather than each action opting in.
- The host now answers every write, even one that changed nothing (a confirmation
  you declined), so a control can never be left spinning.

### Changed
- A disabled MCP server is struck through on its name and its subtitle, and
  dimmed, so a switched-off server reads as switched off rather than being told so
  by a small tag. Its tags stay legible.

### Fixed
- Leaving a text field without editing it no longer writes the same value back.
  Blur committed unconditionally, which cost a pointless round trip through the
  config file on every focus change.

## [0.6.91] - 2026-08-04

### Added
- Icon-only actions (MCP log in, enable, remove, edit, clear override, and the
  rest) now show a tooltip on hover after a short delay, drawn as VS Code's own
  hover widget rather than the platform tooltip, and on keyboard focus too, since
  those buttons have no visible label. Long paths and truncated descriptions use
  the same hover.
- Moving between sections re-reads the config from disk, so arriving at a section
  never shows a stale view. Switching scope already did this, through the message
  that retargets the CLI at that folder.

### Changed
- Values you type (a proxy URL, a domain list, a hook command) now sit under their
  label and take the full width, the way VS Code's own Settings editor lays out a
  text setting. A right-aligned control left them about 180 pixels, which is not
  enough to read a path or a list. Dropdowns and toggles stay on the right, where
  they line up into a column that can be scanned.
- Every modal is now a single full width column with no row separators, so the
  Add hook, Add MCP server, New skill and Install plugin forms use the width they
  have instead of squeezing controls into the right half.
- The Add hook form names its value field after the type that is selected, showing
  **Command** or **Prompt** rather than one box labelled with both, and a prompt
  gets a resizable multi-line box. Whatever was typed in each survives switching
  between them.
- Placeholders in those forms are examples again rather than a second copy of the
  label, and the fields that needed explaining (matcher, timeout, MCP transport,
  skill name) now carry a hint.

## [0.6.90] - 2026-08-04

### Changed
- Every dropdown in the settings panel now follows VS Code's own Settings editor,
  using its `settings.dropdown*` theme tokens (falling back to `dropdown.*`), a
  flat 2 pixel corner and the codicon chevron, instead of the platform's default
  select control. They stay real `select` elements, which keeps native keyboard
  handling, native option grouping and the platform popup that VS Code itself
  uses, and cannot be clipped by the scrolling page the way a custom menu would.
  The scope picker keeps its heading and divider for the workspace folders, now
  through the same shared helper as every other dropdown.
- Text inputs and the search box moved to the same 2 pixel corner, so the whole
  control set matches.
- The sandbox network mode options are now Full and Limited, with the methods
  Limited allows moved into the row's hint. The long option label was stretching
  that one dropdown wider than the rest of the column.

## [0.6.89] - 2026-08-04

Session lifecycle across a window reload or an extension restart, and a
collapsible working set.

A `devin acp` agent cannot be handed to a new extension host: it runs its shell
commands, file writes and permission prompts *through* this extension, over our
stdio. Leaving one alive would strand an agent that can do nothing while still
holding the CLI's session lock, so the safe move is to stop every agent
deterministically and make the reload a clean handover instead.

### Changed
- The working set above the composer is now collapsible, with a chevron in its
  header, so a turn that touches a lot of files no longer squeezes the
  transcript. Its file list scrolls once it grows past roughly 260 pixels
  instead of stretching the dock, and Open all, Keep all and Undo all stay in
  the header without toggling the collapse when clicked. The collapsed state is
  kept across the frequent re-renders during a turn.

### Fixed
- Shutdown now finishes the job. `deactivate` is awaited and escalates per agent
  within a bounded budget: cancel the turn, close stdin (a clean EOF most stdio
  agents exit on), SIGTERM the process group so docker-backed MCP servers can
  tidy up, then SIGKILL. Previously the escalation to SIGKILL sat on a
  `setTimeout(…).unref()` inside a process that was about to exit, so it never
  fired: an agent that ignored SIGTERM survived as an orphan until the next
  window's reaper collected it, holding a session lock in the meantime.
- Commands the agent was running are now stopped on the way out too, with the
  same two passes. They are children of the extension host, and the orphan reaper
  only looks for `devin acp`, so a long build or test run that ignored SIGTERM
  could previously be left running with nothing to collect it.
- A turn in flight is now cancelled before the agent is stopped, rather than the
  process being signalled from under it.
- Windows no longer strands the agent's children. `killTree` had no process group
  to signal there and fell back to killing only the direct child, so MCP servers
  and command trees survived. Both now go through `taskkill /T /F`.
- Waiting for the agents to actually exit also removes a self-inflicted lock
  race: the reloaded window could previously find its own dying agent still
  holding the session lock and ask you to take over your own session.

### Added
- An interrupted turn is now reported instead of vanishing. If the window reloads
  mid-turn, the session is recorded, reopened on the other side even when
  `devin.autoResumeLast` is off, and the thread shows a notice saying the turn
  stopped and that your files and the rest of the conversation are untouched,
  with a "Send it again" action.
- `scripts/lifecycle.test.js` covers the shutdown path against fake agents that
  ignore stdin EOF and SIGTERM, so the escalation and the bounded budget are
  guarded rather than assumed.

## [0.6.88] - 2026-08-04

A simplification pass over the settings surface. Nothing was removed: every
option and action is still there, in about a third of the vertical space.

### Changed
- Scope is now chosen once at the top, not repeated down the page. The page shows
  one scope at a time, the way VS Code's own Settings editor does. Previously
  every setting was rendered once per scope, so the six Behaviour toggles
  appeared twice in a single folder workspace and four times with three folders.
  With one folder open the scopes are two tabs. With several, they collapse into
  a picker with the folders grouped, so a six folder workspace no longer wraps
  into a wall of buttons.
- The **User** scope is now called **Global**, since it applies to every
  workspace rather than to a particular user of the machine.
- Ten sections became eight: Models & Mode and Behaviour merged into **General**,
  Rules & Instructions became **Instructions**, and Network & Sandbox merged into
  **Advanced**. Skills, Plugins, Hooks, MCP Servers, and Permissions are
  unchanged. Plugins hides the scope picker, because the CLI installs a plugin
  once for the machine and a choice there would have no effect.
- One row rhythm throughout: a group is a small heading plus rows separated by
  hairlines, replacing the bordered card with its own title and description. A
  single toggle no longer costs a titled box.
- Row actions (edit, remove, and so on) are dimmed until the row is hovered or
  focused, rather than competing for attention at full strength.
- Permissions takes one rule input with a bucket dropdown, replacing three
  always visible inputs that used their placeholder as a label.
- Reset now sits on the group whose keys it clears, and only appears when the
  active scope actually sets one of them, so it is never a no-op.
- `devin.defaultModel` and `devin.defaultMode` descriptions now say they apply to
  chats started in the extension, and that an empty `devin.defaultModel` follows
  the Devin CLI's own `agent.model`.

### Added
- A search box that filters settings across every section at once, matching a
  row's label, its hint, its config key, and its group heading.
- "Set here" markers, so a row says whether the active scope sets it or inherits
  the Global value, with a Clear override action on a folder scope. A folder scope
  now shows the value that actually applies rather than the bare default.
- Deep links from General into VS Code settings for the extension's own options
  (all of them, session defaults, thinking display, checkpoints and editing).
- Disclosure of the one place the two settings systems overlap: when the VS Code
  setting `devin.defaultModel` is set, the CLI model row carries a notice saying
  it is overridden for chats in the extension, with links to open or clear it.
  Previously the panel's model control silently had no effect on those chats. It
  is a notice on the affected row rather than a setting of its own, so this
  surface still only ever edits Devin CLI config, and it appears only while the
  conflict exists.
- The config file the active scope writes to is named under the toolbar, with an
  open or create action, which replaces the Config files list.
- The panel refreshes itself when a config file changes on disk, when a `devin.*`
  VS Code setting changes, or when it is revealed after a change, so the manual
  Refresh button is gone.
- `npm run preview:settings` renders the settings panel in a browser from mock
  data, and `scripts/settings.test.js` covers the surface, including a guard that
  every config key keeps a row and every section keeps its actions.

### Fixed
- Setting a value back to the one that already applies no longer leaves the row
  marked as changed. The key is removed from the config instead of being written
  back, the way VS Code drops a setting you return to its default. At a workspace
  folder that means matching the Global value clears the override, and removing a
  nested key no longer leaves an empty `"proxy": {}` behind.
- The sidebar no longer promises a "Mode" setting that was never on the page.
  Mode is a VS Code setting and is linked to from General.
- Import rules from other tools (`read_config_from`) is now scope aware, instead
  of always writing to the Global config while sitting under a folder heading.
- Removed dead code left behind by earlier iterations: an unused list row helper,
  an unreachable folder switcher, a decorative collapse that never collapsed, and
  four unused config and CLI helpers.

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
