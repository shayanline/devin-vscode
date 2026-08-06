# Changelog

All notable changes to **Devin for VS Code**, newest first.

> This is a fast moving preview, so a few entries group several rapid builds
> under one milestone version where those builds were only ever installed
> locally. The builds between 0.6.65 and 0.6.91 reached the Marketplace together
> in 0.6.92.

## [0.8.0] - 2026-08-06

A feature sized release, so this moves to 0.8.0: Devin's subagents are now shown
in the panel, alongside a fix for how dropped files and folders are described.

### Highlights
- Subagents are rendered. When Devin hands a task to a subagent you now get one
  collapsible block for it, the way VS Code's own chat shows a delegated task: a
  single row whose title reads "Explore: map session persistence", shimmering
  while it works and naming the tool it is on. Opening it shows the brief it was
  given, everything it did and said in order, and the report it handed back.
  Subagents working in parallel each get their own block.
- A subagent's work is no longer mistaken for the main agent's. Its tool calls
  used to land in the transcript alongside Devin's own, stuck at "pending"
  forever because the updates that would have finished them never arrived.
- A running subagent can be moved between the foreground and the background from
  its header, which is the panel's equivalent of Ctrl+B in the CLI.
- A folder dragged in from outside VS Code no longer sends Devin looking for a
  folder that is not there. The attachment used to read "Folder chat contains:",
  the same shape as a folder dragged from the Explorer, where that slot holds a
  full path. A bare name in a path's place reads as a folder in the workspace, so
  Devin went hunting for it. It now says plainly that the folder came from outside
  VS Code with no path attached, that it may or may not be in the workspace, and
  that its listing is what identifies it on disk, so Devin can find the real one
  or ask which is meant.
- A file dragged in from outside VS Code says the same, since its bare name could
  just as easily be read as a file in the workspace. Its contents are still sent
  in full, and when a very large one is cut short the block now says so rather
  than passing the first part off as the whole file.

### Under the hood
- The CLI streams a subagent's tool calls, messages and reasoning tagged with the
  subagent that produced them, but only to a client that asks: the extension now
  advertises `cognition.ai/subagentSupport`, without which just the opening tool
  call of each subagent leaks through and never resolves. Control comes from
  `cognition.ai/subagentControl` and the `_cognition.ai/subagent/{background,
  foreground}` methods. There is no method to cancel one, so the header offers
  only the mode switch.
- The parent's own `run_subagent` call is what owns the block rather than the
  subagent's lifecycle, because it is the one part a reloaded session is sure to
  get back. A foreground subagent's whole transcript is replayed on load, but of
  a background one the CLI keeps only that row, so its block comes back with the
  brief and no report. A background subagent also outlives the turn that spawned
  it, so its block keeps running after the turn ends and accepts a report later.
- `scripts/smoke-subagent.ts` drives a real session through the extension's own
  client, spawning both kinds of subagent and exercising the mode switch.
- An OS drag never carries a filesystem path: Chromium keeps local paths from web
  content, and VS Code resolves them through an Electron preload API
  (`webUtils.getPathForFile`) that exists in the workbench renderer but not in a
  webview. That is why the terminal and the Explorer get a full path and the chat
  panel cannot, and it applies to files as much as folders. Files are unaffected
  because their bytes come through and are attached as content, while a folder has
  no bytes to read, which is what left it needing a path.

## [0.7.1] - 2026-08-06

A fix for drag and drop, which VS Code was quietly taking away from the panel.

### Highlights
- Dropping files onto the chat works again. A file dragged in from outside VS Code
  used to flash the drop overlay for a moment and then open in an editor instead
  of attaching, and a drag from the Explorer or an editor tab did nothing at all.
- The whole panel takes a drop now, the sessions panel included, rather than only
  the chat column.
- A drag that starts inside VS Code (the Explorer, an editor tab) needs Shift held
  as you drop, which is VS Code's own gesture for dropping into a webview. Since
  VS Code makes the panel inert for the whole of such a drag, there is no event to
  hint from while it happens, so the gesture is spelled out where it can be read
  instead: on the empty chat screen, in the Add context (+) tooltip and in the
  README.
- A folder dragged in from outside VS Code attaches as a listing of what it holds,
  the same as one dragged from the Explorer, instead of quietly attaching nothing.
- Escape stops the turn while the composer has focus, not only Ctrl/Cmd+Esc, and
  the Stop button's tooltip says so.
- New Session in the sessions list is a real split button. The labelled half
  starts a session in the panel straight away, and the chevron beside it opens the
  menu for the editor, a window or the terminal, rather than the whole button
  opening the menu.

### Under the hood
- VS Code drops pointer-events on a webview iframe the moment it sees a drag, so
  that the editor can own the drop (webviewWindowDragMonitor): once on any
  dragstart in the window, and again for every dragover its host script forwards
  back out of the webview. Drag events are now claimed on the window in the
  capture phase and stopped there, before they reach those host listeners, which
  keeps the drag with the panel. A drag started inside VS Code is cut off before
  any event reaches the webview at all, which is why Shift is the only way in for
  those.
- Claiming the events on the window also means a stray dragenter on the sessions
  panel or a panel edge can no longer hand the whole drag away, and the overlay
  anchors on the chat row so it covers the sessions panel too.
- Drops are ignored while the boot and setup screens are up.
- An OS drag carries no path, so a dropped folder used to be read as a file and
  fail silently. Dropped items are now taken off the drag through the entries API
  while the drop event is still on the stack, and a folder's top level is read
  there and sent to be attached as a listing.
- New tests assert that no drag event escapes to VS Code's host listeners, that a
  drag over the sessions panel still offers the drop, that a dropped folder
  attaches as a listing, and that Escape stops a turn only while one is running.

## [0.7.0] - 2026-08-05

A big round of chat quality fixes: a real message queue, background sessions that
keep working and catch you up when you return, calmer scrolling, and better
questions.

### Highlights
- You can now type while Devin is working. A message sent mid turn is queued
  instead of lost, shown at the bottom of the transcript under a "Queued"
  divider as dimmed request bubbles, and sent in order as the session frees up.
  Each one can be edited in place (it keeps its position in the queue rather than
  jumping to the end), sent immediately, or removed, and Stop interrupts only the
  current turn and leaves the queue in place so it carries on after the interrupt.
  While a turn runs, the Send button becomes a Queue button as soon as you type,
  so you can click to queue instead of only pressing Enter.
- Editing a queued message holds just that message. The ones ahead of it keep
  sending, the queue pauses when the edited one reaches the front, and the ones
  behind it wait, so a turn finishing mid edit never submits it from under you.
- Drag and drop files, images and folders onto the chat to attach them as
  context, with the same drop overlay VS Code uses. Images are attached inline so
  the model can actually see them, a folder attaches as a listing, and dragging a
  multiple selection attaches every file rather than just the first.
- The Add context (+) button now offers folders as well as files, and attaching
  an image through + or @ sends it as a real image.
- Keyboard shortcuts match Copilot: Ctrl/Cmd+Esc stops the current turn,
  Ctrl/Cmd+. opens the mode picker, Ctrl/Cmd+Alt+. opens the model picker, and
  ArrowUp on an empty composer recalls your last message.
- Background sessions really run in the background. A session you leave keeps
  working, and reopening it replays everything it did while you were away, even
  when the turn is still going, instead of showing the state from when you left.
- When a background session needs your input it now tells you, with a
  notification that has an Open button and a pulsing marker next to the session
  in the list.
- Questions are easier to answer. A question with more than one answer shows real
  checkboxes, the Submit button stays disabled with a tooltip until every
  question has an answer, and moving between questions now updates the question
  text itself, not only the choices below it.
- Opening a session is calmer. A loading indicator shows the moment you click,
  and a large session no longer scrolls and reflows in front of you while it
  loads: it appears once, already scrolled to the latest message.
- Reading is no longer interrupted. Expanding a tool card or a chain of thought
  while Devin streams no longer yanks you to the bottom, and a section you opened
  by hand is never collapsed back on you. Your collapse choice for the plan and
  the file changes list is remembered for the rest of the session.
- Plan steps can be skipped. A step the agent decides to skip shows struck
  through with a slashed circle.
- Going back to the session list is instant. The listing is cached and painted
  straight away, then revalidated behind you, instead of re-running `devin list`
  and blanking the list every time.
- Loading shows as a thin animated bar along the top edge, using the same accent
  that travels around the composer while Devin works, rather than a spinner in
  the middle of the panel.
- The session list filter takes any combination of states rather than one at a
  time, "Ended" is now called "Terminated", and a Sort by option orders the list
  by last activity, by state (working sessions on top) or by name.
- Switching session no longer carries the previous one's Stop button and working
  border across to the new one.
- Leaving a session mid thought no longer leaves it stuck on "Thinking…": the
  section settles to "Thought for Xs" and the continuation picks up when you
  return.
- A folder attached as context shows a folder icon instead of a file icon.
- An unsent draft now belongs to the session you typed it in. Switching away
  parks it and switching back puts it in the composer, instead of following you
  into the next session.
- Leaving a session while it was working and coming back no longer leaves a
  frozen "Working…" line behind, which used to sit next to the real one on the
  next message.
- The slash command list scrolls to follow the highlighted item as you arrow
  through it.
- Links in the chat open once, not twice.

### Under the hood
- A backgrounded session's stream is buffered on its runtime and replayed when
  the session is reopened, so its progress is never dropped. A finished session
  reloads its transcript on return instead.
- The message queue lives on the session's runtime, so it survives switching away
  to another session and back, and it drains itself turn by turn.
- Auto scroll follows the stream only while you are at the bottom, and a manual
  expand anchors the toggled section in place (VS Code's getAnchoredScrollTop)
  rather than following, handing control back on your next scroll.
- Manual collapse state is tracked per section so nothing auto collapses what you
  opened, matching VS Code's userManuallyExpanded behaviour.
- The `PlanEntry` type accepts skipped and cancelled statuses.
- External links are left to VS Code's own webview link handling. Its preload
  posts `did-click-link` for any anchor, so opening them ourselves as well was
  what opened a second tab. Workspace paths still stop propagation so VS Code
  does not also try to open a relative href.
- Drops read `application/vnd.code.uri-list`, `ResourceURLs` and `CodeFiles`
  before the standard `text/uri-list`, which VS Code truncates to the first
  resource, so a multiple selection is no longer reduced to one file.
- Attached images are capped at 30 MB, matching VS Code, instead of being sent
  whole.
- A queued turn is flushed before the revert head probe rather than after it, so
  the next queued message goes out without waiting on an extra round trip.
- The queue is republished after a reload as well as after an instant re-attach,
  so messages waiting on a session survive every way of leaving and returning to
  it (the list, the switcher, and the side panel).
- Only the Refresh button forces a re-listing now. Returning to the list serves
  the cached sessions at any age and revalidates in the background.
- The drop overlay is cleared on dragend, drop and Escape, so a drag that ends
  outside the panel cannot leave it stuck on screen.
- A failed session load drops the cached listing before returning to the list,
  so a session deleted elsewhere cannot be served back from the cache.
- New regression tests cover the queue (bubbles, in place edit, send immediately,
  the per message hold), drag and drop (overlay and multi file drops), the smooth
  load, the attention marker, the skipped plan step, the plan collapse memory,
  links deferring to VS Code, the question carousel text, and the keyboard
  shortcuts.

## [0.6.93] - 2026-08-04

Refreshes the Marketplace listing, which went out before the screenshots were
rebuilt.

### Highlights
- Tags in a settings list (an MCP server's transport, `disabled`, the number of
  environment variables) no longer break one letter per line when the panel is
  narrow, such as in a split editor. They stay whole and wrap as complete tags.

### Under the hood
- Every README screenshot is now the same size (620 by 860). They used to be
  captured element by element, so each was as tall as its content and the grid
  showed them at four different scales with ragged gaps. Each is now a fixed size
  capture, scrolled to the bottom of the transcript, and a little wider so the
  text no longer wraps cramped. `scripts/preview.js` gained a `--width` flag for
  this.

## [0.6.92] - 2026-08-04

### Highlights
- Every action that talks to the extension now shows that it is working and stops
  taking input until it finishes, so nothing looks frozen and the same action
  cannot fire twice. An icon shows a spinner, a toggle or field dims, and a
  submitted form stays open with a spinning button until it is done. This covers
  everything: disabling an MCP server, removing a permission, resetting a group,
  clearing an override, installing a plugin, and the rest.
- A disabled MCP server now reads as switched off at a glance. Its name and
  subtitle are struck through and dimmed, rather than relying on a small tag to
  say so.

### Under the hood
- The extension now replies to every write, even one that changed nothing (a
  confirmation you declined), so a control can never be left spinning forever.
- Leaving a text field you did not edit no longer writes the same value back,
  which used to cost a needless round trip through the config file on every focus
  change.

## [0.6.91] - 2026-08-04

### Highlights
- Icon only buttons (MCP log in, enable, remove, edit, clear override, and the
  rest) now show a tooltip on hover and on keyboard focus, so you can tell what
  each does even though it has no label. Long paths and truncated text use the
  same tooltip.
- Values you type (a proxy URL, a domain list, a hook command) now sit under
  their label and use the full width, the way VS Code's own Settings editor lays
  them out, so a path or a list is actually readable. Dropdowns and toggles stay
  on the right, lined up into a column you can scan.
- The add and install forms (Add hook, Add MCP server, New skill, Install plugin)
  are now a single full width column, so nothing is squeezed into the right half.
  The Add hook form names its value field after the type you picked (Command or
  Prompt), gives a prompt a resizable multi line box, and keeps whatever you typed
  in each when you switch between them.
- Field placeholders are helpful examples again, and the trickier fields
  (matcher, timeout, MCP transport, skill name) carry a short hint.

### Under the hood
- Moving between settings sections re-reads the config from disk, so you never
  land on a stale view. Switching scope already did this.

## [0.6.90] - 2026-08-04

### Highlights
- Every dropdown in the settings panel now matches VS Code's own Settings editor,
  down to the theme colours, the flat corners, and the chevron, instead of the
  browser's default select. They stay real controls, so keyboard handling and the
  native popup keep working and cannot be clipped by the scrolling page. Text
  inputs and the search box got the same flat corners so the whole panel matches.
- The sandbox network mode is now simply Full or Limited, with the methods Limited
  allows moved into the row's hint, so that one dropdown no longer stretches wider
  than the rest.

## [0.6.89] - 2026-08-04

Session lifecycle across a window reload or an extension restart, plus a
collapsible working set.

### Highlights
- The working set above the composer can now be collapsed with a chevron, so a
  turn that touches a lot of files no longer squeezes the transcript. Its file
  list scrolls once it grows tall instead of stretching the panel, and Open all,
  Keep all and Undo all stay in the header. The collapsed state is remembered
  across the frequent redraws during a turn.
- If the window reloads in the middle of a turn, the turn is no longer lost
  silently. The session is reopened on the other side, and the thread shows a
  clear notice that the turn stopped, that your files and the rest of the
  conversation are untouched, and a "Send it again" button.

### Under the hood
- Shutdown is now reliable. A Devin agent runs its commands, file writes and
  prompts through this extension, so it cannot be handed to a new extension host.
  On the way out the extension now waits for each agent to actually exit,
  escalating step by step (cancel the turn, close its input, terminate the
  process group, then force kill) within a time budget. Previously the final force
  kill sat on a timer that never fired once the host was gone, so an agent that
  ignored the polite signals could survive as an orphan holding the session lock.
- Commands the agent was running are stopped the same way, and a turn in flight
  is cancelled before its agent is stopped. On Windows the whole process tree is
  now killed (via `taskkill /T /F`), which previously left MCP servers and command
  trees running.
- Waiting for agents to exit also removes a race where a reloaded window could
  find its own dying agent still holding the lock and ask you to take over your
  own session.
- Added `scripts/lifecycle.test.js`, which exercises the shutdown path against
  fake agents that ignore the polite signals.

## [0.6.88] - 2026-08-04

A tidy up of the settings surface. Nothing was removed: every option and action
is still there, in about a third of the vertical space.

### Highlights
- You now pick the scope (Global or a workspace folder) once at the top, instead
  of seeing every setting repeated for each scope. With one folder open the scopes
  are two tabs, and with several they collapse into a grouped picker.
- The old **User** scope is now called **Global**, since it applies to every
  workspace.
- Ten sections became eight, with a lighter layout of small headings and hairline
  rows instead of heavy bordered cards, so a single toggle no longer costs a
  titled box.
- A search box filters settings across every section at once, matching a row's
  label, hint, config key, or heading.
- Each row now says whether the current scope sets the value or inherits it, with
  a Clear override action on a folder scope, so a folder shows the value that
  actually applies rather than a bare default.
- When a VS Code setting (`devin.defaultModel`) overrides the CLI's model for
  chats in the extension, the model row now says so, with links to open or clear
  it, rather than the panel silently having no effect.
- The panel refreshes itself when the config changes on disk or in VS Code
  settings, so the manual Refresh button is gone.

### Under the hood
- Setting a value back to the one that already applies now removes the key instead
  of writing it back, the way VS Code drops a setting you return to its default,
  and no longer leaves an empty object behind.
- Import rules from other tools (`read_config_from`) is now scope aware instead of
  always writing to the Global config.
- Dropped the separate gitignored "local" scope. Settings now use Global and
  Workspace only, and you decide what to gitignore.
- Removed dead code left by earlier iterations: an unused list row helper, an
  unreachable folder switcher, a collapse that never collapsed, and several unused
  helpers.
- Added `npm run preview:settings` to render the settings panel in a browser from
  mock data, plus `scripts/settings.test.js`, which guards that every config key
  keeps a row and every section keeps its actions.

## [0.6.87] - 2026-08-04

A large iteration on the settings surface (the Devin customisations editor), plus
a session lifecycle fix.

### Highlights
- Create flows throughout the settings: a new skill (which scaffolds a
  `SKILL.md`), add an MCP server, add a hook, and install a plugin, each from an
  Add button that opens a modal.
- A Plugins section that lists installed plugins with update and remove, and an
  install form for a Git source or a local path.
- MCP sign in and sign out. Sign in runs in a terminal so the interactive code
  flow can complete, and the buttons follow the real sign in state, so a signed in
  server shows only Log out.
- Edit and remove actions on skills, instructions, hooks and MCP servers. Removals
  ask first, and Edit opens the underlying file next to the settings tab.
- Reset to defaults per value section, which clears that section's keys in the
  chosen scope.
- Full multi root workspace support: every project aware section groups by scope
  (Global and one group per workspace folder) with no folder switcher, and marks a
  setting as overridden in a folder only when that folder genuinely differs.

### Under the hood
- MCP servers are read from the correct place (`mcp_config.json` globally and
  under `.devin/` per folder), so configured servers actually appear, and their
  subtitles show only a safe summary (the host and path, or the command name),
  never raw commands, arguments or headers, so tokens are not exposed.
- Instructions read `AGENTS.md` first and fall back to `CLAUDE.md`, and create
  always writes `AGENTS.md`.
- Leaving an active session mid turn and returning no longer throws an error or
  scrambles the message order. Leaving now detaches the running turn and returning
  reattaches, instead of reloading over the live channel.
- MCP remove, enable and disable now pass the matching scope, so global servers
  can be removed, and skill paths the CLI prints with a `~` prefix now resolve
  correctly.

## [0.6.65] - 2026-07-31

Three features carried over from GitHub Copilot Chat.

### Highlights
- **New chat locations.** The `+` in the chat title is now a split button
  offering a new session in the sidebar, in the editor area, in a new window, or
  as a Devin CLI session in a terminal. Editor and window chats can run several at
  once, each independent.
- **Embedded sessions panel.** A history button toggles a sessions list beside the
  chat when there is room and stacked above it when narrow, with its own toolbar:
  new session, refresh, a status filter (all, running, idle), and a collapsible
  search.
- **Settings surface.** A gear opens a Devin customisations editor for the full
  Devin CLI config: model and mode, rules and instructions, skills, MCP servers,
  hooks, permissions, behaviour, proxy and sandbox, and terminal display, each
  with the scopes it supports.

### Under the hood
- The chat provider was split into a per surface controller managed by a
  `ChatManager`, so the sidebar and each editor or window panel run independently
  while sharing the session store and change tracker.

## [0.6.64] - 2026-07-31

### Highlights
- Composer attachments are cleared when you switch to an already live session, so
  they no longer carry over into the wrong chat.
- A background session can now queue more than one pending message and show all of
  them when you reopen it.

### Under the hood
- Opening the same session twice in quick succession no longer spawns a second
  agent process that orphaned the first and held its lock. Loads and wakes now
  share a single in flight request per session.
- Outstanding permission and question prompts are cancelled on every teardown
  path, so the agent's calls never hang and no dead prompt is left on screen, and
  teardown now clears its timers, maps and subscriptions, closing several leaks on
  window reload.
- Relative file paths from the agent now resolve against the session working
  directory rather than the extension host's.
- Long streaming responses render on a coarser cadence to cap CPU, and redundant
  session list rebuilds are skipped.
- Removed dead webview message handlers and an unused message.

## [0.6.63] - 2026-07-30

### Under the hood
- Rewrote the README around the Devin CLI: clearer framing, corrected docs links,
  a two per row screenshot layout, and a note that the interface mirrors GitHub
  Copilot Chat.

## [0.6.62] - 2026-07-30

### Under the hood
- Trimmed the README to end user content and moved the build and release notes
  into `CONTRIBUTING.md`, and reframed the intro and the screenshot captions
  around the VS Code integration.
- Fixed the Marketplace badge (moved to badgen after the previous provider started
  erroring) and dropped a flaky install count badge.

## [0.6.61] - 2026-07-30

First public release on the VS Code Marketplace and Open VSX.

### Highlights
- Richer tool call cards, with consecutive tool calls grouped into a single
  disclosure, and Mermaid diagrams rendered in replies.
- A closer match to the VS Code and Copilot chat UI, with fixes to session
  handling, request editing and scrolling.

### Under the hood
- Release automation: pushing a tag builds the extension, creates a GitHub Release
  with the packaged `.vsix`, and publishes to the Marketplace and Open VSX.
- Marketplace preview metadata and a richer README with screenshots.
- Pinned the GitHub Actions to their current major versions.

## 0.6.38 - 2026-07-30

### Highlights
- Images in replies and tool results, keep and undo shown inline on each file
  edit, and clickable web fetch results.

## 0.6.37 - 2026-07-30

### Highlights
- A terminate control for a running session, Copilot style send and stop icons,
  and tidier terminal cards.

## 0.6.36 - 2026-07-30

### Highlights
- Session transcripts are kept in the panel, so returning to an idle session
  restores it instantly without a reload.

## 0.6.35 - 2026-07-30

### Highlights
- One agent process per session with a live status dot, so a session keeps running
  in the background while you look at another.

## 0.6.34 - 2026-07-30

### Highlights
- Retry now regenerates a reply in place, reloads are cleaner, the input border
  animation is smoother, and a loader covers startup.

## 0.6.33 - 2026-07-30

### Under the hood
- A round of review fixes across the composer and the session lifecycle.

## 0.6.30 to 0.6.31 - 2026-07-30

### Highlights
- Tool cards now render a body suited to the kind of tool instead of raw argument
  JSON (0.6.30).

### Under the hood
- Agent terminal commands run through a shell, so compound command lines (`cd`,
  `&&`, pipes, globs, quoting) behave as they would in a real terminal (0.6.31).

## 0.6.23 to 0.6.29 - 2026-07-30

A second pass at matching VS Code's Copilot Chat.

### Highlights
- Entrance animations for streamed reply parts, a composer polish, a docked plan
  and a working set summary, and a thinking peek that shows the latest reasoning as
  it streams then collapses.

### Under the hood
- Fixed behaviour gaps found during the parity pass.

## 0.6.8 to 0.6.22 - 2026-07-29

A first pass at matching VS Code's Copilot Chat, plus visual polish.

### Highlights
- Interactive questions from the agent, with a question carousel and answered
  question recaps.
- Collapsible thinking with a "Thought for Xs" summary, expandable tool call cards
  showing inputs, results and locations, and a hover toolbar on code blocks (copy,
  insert, apply, run).
- A welcome screen, message actions, actionable errors, a context usage bar, a to
  do style plan, a used references summary, and a working shimmer.

### Under the hood
- A design token foundation, VS Code style tool labels, file reference pills, and
  more space between turns.

## 0.6.0 to 0.6.7 - 2026-07-28 to 2026-07-29

The foundation of the extension.

### Highlights
- A Devin chat panel for VS Code with streaming replies, backed by the Agent
  Client Protocol.
- Workspace scoped sessions, Devin CLI detection, and a first run setup flow.
- A diff working set with keep and undo per file, session rename and delete, and
  context attachments.
- A Copilot style history view with `/` and `@` autocomplete and question options.
- A model picker populated from the CLI, grouped by family with a filter, usable
  before any session starts.
- Live terminal output streaming, edit in place, checkpoints, and undo.
- A status bar popover with the signed in account, plan, version and links.
- Rich markdown rendering (markdown-it and highlight.js).

### Under the hood
- Kill the whole agent process group on dispose so MCP servers are not leaked, and
  reap stranded agents on startup.
- Correct replay of a loaded session, right aligned request bubbles, a self
  healing session list, and faster startup.
- A jsdom based webview test harness with regression tests, and a browser preview
  harness for visual iteration.

[0.8.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.8.0
[0.7.1]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.1
[0.7.0]: https://github.com/shayanline/devin-vscode/releases/tag/v0.7.0
[0.6.93]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.93
[0.6.92]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.92
[0.6.63]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.63
[0.6.62]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.62
[0.6.61]: https://github.com/shayanline/devin-vscode/releases/tag/v0.6.61
