# 13, True VS Code chat UI/UX parity (edit, checkpoints, undo, fork, and the turn model)

This report re-analyses parity against the **actual VS Code core chat**
(`microsoft/vscode`, [`src/vs/workbench/contrib/chat`](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat)),
not the Copilot Chat extension. The earlier files in this folder (01 to 12) were
written against `vscode-copilot-chat`, which registers participants into the
native chat widget but does **not** contain the widget itself. The interaction
flows the user cares about (editing a sent message in place, checkpoints,
restore, undo/redo, forking) all live in the **core** widget, so they were
undercounted or described only at surface level before.

The goal is to match VS Code's chat interaction and visual design as closely as
makes sense, everywhere, changing only what is genuinely Devin specific or where
we are arguably better.

Everything below was checked against a checkout of the core chat contrib and
cross referenced with the current `devin-vscode` webview
(`webview/main.js`, `media/main.css`, `src/chat/chatViewProvider.ts`,
`src/acp/client.ts`).

---

## 0. The single most important finding

The four headline features the user named (edit a message in place, restore
checkpoints, undo, fork) are **not four separate features**. In VS Code they are
four views onto one underlying model:

1. The conversation is a **list of turns**, each a `request` (the user message)
   paired with its `response` (the assistant output), each with a **stable id**.
2. Before each request runs, VS Code takes a **checkpoint**: a snapshot of the
   files that request will touch.
3. Every one of the four features is "pick a turn by id, then truncate the
   conversation back to it and revert the files it changed", with a different
   entry point and a different destination:
   - **Edit in place**: pick a turn, replace its text, truncate everything from
     that turn onward, revert those files, re-run from there.
   - **Restore checkpoint**: pick a turn, truncate from that turn onward, revert
     those files, put the prompt text back in the box (do not auto-run).
   - **Undo / redo edits**: step the truncation point back or forward by one
     turn (checkpoint navigation).
   - **Fork**: copy the conversation up to and including a turn into a **new**
     session, leaving the original intact.

Our current webview has **none of this foundation**. It renders a **flat stream
of blocks** in arrival order (`block` in `webview/main.js`), with no turn model,
no request ids, and no per-turn file snapshots. `ChangeTracker` snapshots files
globally, not per turn. So today:

- **Edit** just copies the old text into the composer and sends it as a brand
  new message appended to the end (`messageActions` in `webview/main.js`, the
  "Edit & resend" button). It does not edit in place and does not truncate.
- **Retry** re-sends the last user text as a new appended turn.
- There are **no** checkpoints, **no** restore, **no** true conversational undo
  (only a global working-set "Undo all" that reverts file snapshots), and **no**
  fork.

**The good news**: Devin already has the exact backend primitives (see Part 2).
The work is (a) give the webview a real turn model, and (b) wire the turn model
to Devin's `/steps`, `/revert`, and `/fork`. Once the turn model exists, all
four features are mostly rendering plus one backend call each.

**This report therefore front-loads the foundational refactor (Part 1), then
specs each feature against it.** Trying to build edit-in-place or checkpoints on
top of the current flat stream will not work and should not be attempted.

---

## 1. Foundational refactor: a real turn model in the webview

VS Code's chat is a virtualised list where each row is one `request` or
`response` view-model with a stable id, and the whole thing is driven by
`chatModel.getRequests()`. We need the webview equivalent.

### 1.1 What to build

Introduce a `turns` array in `webview/main.js`, replacing the single mutable
`block`:

```
turn = {
  id,                 // our stable id for this user turn
  stepId,             // Devin step id from /steps (filled in lazily, see Part 2)
  request:  { text, attachments, model, mode, el },
  response: { blocks: [ ...assistant text, thinking, tool cards, plan ], el },
  state:    'complete' | 'streaming' | 'removed',
  changedFiles: [ ... ],   // files this turn edited (for the changes summary + revert)
}
```

Rendering rules that mirror VS Code:

- A **new turn** starts on every user message. All assistant text, thinking,
  tool calls, and plan entries that arrive before the next user message belong
  to that turn's `response`. Today these are appended as independent siblings of
  the thread with no grouping; group them under the turn container instead.
- Each turn keeps its own DOM subtree so we can (a) mount an inline editor into
  the request, (b) show a per-turn checkpoint row, (c) dim/remove a turn, and
  (d) render a per-turn changes summary.
- Keep the current streaming behaviour (throttled `requestAnimationFrame`
  re-render) but scope it to `turn.response`.

### 1.2 Per-turn file snapshots

`ChangeTracker` (`src/diff/changeTracker.ts`) currently tracks a single global
set of changed files with one snapshot each. For checkpoints and per-turn
revert to be correct, snapshots must be **keyed by turn**. Two options:

- **Preferred**: do not snapshot in the extension at all for revert purposes;
  delegate revert to Devin's `/revert <step>`, which reverts file changes from a
  step onward on the agent side. Keep `ChangeTracker` only for the live
  working-set accept/undo affordance we already have.
- **Fallback** (if `/revert` is not reachable over ACP, see Part 2): extend
  `ChangeTracker` to record, per turn id, the pre-turn contents of every file
  that turn wrote via `fs/write_text_file`, so we can restore them ourselves.

### 1.3 Context keys / state we need to track

VS Code drives a lot of UI off context keys. We do not have a context-key
service, but we should track the equivalents as webview state so the toolbars
and buttons enable/disable correctly:

- `editing` (which turn id is currently being edited in place; VS Code:
  `viewModel.editing`, context key `chatSessionCurrentlyEditing`).
- `canUndo` / `canRedo` (whether there is a turn to revert to or redo; VS Code:
  `chatEditingCanUndo` / `chatEditingCanRedo`).
- `isFirstRequest` (fork and some actions hide on the first turn).
- `busy` (already tracked) to suppress edit/restore while a turn is running.

---

## 2. Backend mapping: verified ACP revert protocol

**Status: verified against `devin 3000.2.17` on 2026-07-29 by probing `devin acp`
directly.** The Devin CLI has `/steps`, `/revert <step>`, and `/fork [step]` in
the TUI, but those slash commands are **not** executed over ACP (sending
`/steps` as a prompt is treated as ordinary chat text, and they are not in the
`available_commands_update` list). However, Devin exposes a proper **revert
capability and JSON-RPC methods** over ACP, which is what we will use.

### 2.1 The revert capability (verified)

Advertise it in `initialize` under client capabilities:

```json
"clientCapabilities": {
  "fs": { "readTextFile": true, "writeTextFile": true },
  "terminal": true,
  "elicitation": { "form": {}, "url": {} },
  "_meta": { "cognition.ai/revert": true }
}
```

When set, the agent advertises `agentCapabilities._meta["cognition.ai/revert"]:
true` in the `initialize` result. (Without the client flag the agent logs
`revert=false` and the methods below reject.)

### 2.2 The revert methods (verified)

Two JSON-RPC methods, both taking the same params:

```
_cognition.ai/revert/preview   { sessionId, targetNodeId, force, skipFileUndo }
_cognition.ai/revert/execute   { sessionId, targetNodeId, force, skipFileUndo }
```

- `targetNodeId` is a **number**: a node id on the session's "expanded chain".
- `force` (bool): proceed despite conflicts.
- `skipFileUndo` (bool): rewind the conversation without reverting files.
- **preview** returns, without mutating anything:
  ```json
  {
    "fileActions": [ ... ],
    "irreversibleWarnings": [ { "toolName": "...", "description": "..." } ],
    "conflicts": [ ... ]
  }
  ```
  This is precisely what powers VS Code's "revert preview" (the file diff stats,
  the irreversible-action warnings, and the conflict list for the inline
  "Discard Edits" confirmation).
- **execute** performs the rewind: it undoes the file edits made from
  `targetNodeId` onward **and** truncates the conversation back to that node, in
  the same session. Verified end to end (a file the agent created was removed
  after execute).

Invalid or off-chain targets return
`-32602 Invalid params` with `data` like *"target node N is not on the expanded
chain from head H (only expanded-chain IDs are valid revert targets)"*. This is
also how we read the current **head** node id cheaply (probe with a large
invalid id and parse `head H` from the error).

### 2.3 Mapping a user turn to a node id (the one gap, solved)

Node ids are **not** surfaced in the `session/update` stream (message/tool chunks
carry no node id in `_meta`), `session/load` returns only `{ modes, configOptions }`,
and there is no reachable "list steps" method. So we track it ourselves:

- **After each user turn completes**, probe `_cognition.ai/revert/preview` with a
  large invalid `targetNodeId` and parse `head H` from the error. Store
  `turn.headAfter = H`. The head is always a valid revert target.
- To **truncate at turn K** (edit-in-place submit, restore checkpoint, undo):
  `revert/execute` to `turn[K-1].headAfter` (the tip just before turn K). For the
  **first** turn there is no prior head with history (the agent reports "Session
  has no conversation history to revert"), so editing/restoring turn 1 is handled
  by starting a fresh session and resending.
- Always call `revert/preview` first to render the confirmation (files affected +
  irreversible warnings), matching VS Code's inline "Discard Edits" flow.

### 2.4 Fork is not available over ACP (verified)

Every fork method name (`_cognition.ai/revert/fork`, `_cognition.ai/fork`,
`_cognition.ai/session/fork`) returns `-32601 Method not found`, and `/fork` is
TUI only. So true server-side fork is not exposable today. Options for the Fork
feature: (a) approximate it by opening a **new** session and replaying the user
prompts up to the chosen turn (re-runs the agent, non-deterministic, costs
tokens), (b) request that Cognition expose a fork ACP method, or (c) defer Fork
and ship edit/checkpoints/undo (all powered by revert) first. Recommended: (c)
now, revisit (a) or (b) later. This is a decision for Shayan (see Part 8).

### 2.5 New ACP client methods to add

Wrap the calls in `src/acp/client.ts`, mirroring the existing `renameSession`
custom method:

```
revertPreview(sessionId, targetNodeId, opts?)   // -> { fileActions, irreversibleWarnings, conflicts }
revertExecute(sessionId, targetNodeId, opts?)   // rewind + file undo
currentHead(sessionId)                          // probe preview(bigId), parse "head H"
```

And advertise `_meta["cognition.ai/revert"]` in `initialize`.

---

## 3. Feature specs (matched to VS Code core)

Each spec gives: the exact VS Code behaviour (verified against the core
source), what we do today, the target, the implementation, and the backend
dependency. CSS class names are the VS Code ones so we can mirror them.

### 3.1 Edit a previous request, in place

This is the flow the user explicitly called out as wrong today.

**VS Code behaviour (verified):**

- Governed by the setting `chat.editRequests` with values `inline` (default),
  `hover`, `input`, `none`. `inline` and `hover` both edit **in place**; `input`
  loads it into the bottom composer (what we do now); `none` is the old
  copy-to-input undo button.
- **Trigger**: in `inline` mode you **click directly on the sent request text**;
  in `hover` mode a pencil button (`Codicon.edit`, tooltip "Edit Request")
  appears in the per-request hover toolbar (`MenuId.ChatMessageTitle`). Keyboard:
  focus the request row and press Enter. All paths call
  `IChatWidget.startEditing(requestId)`.
- **Visual**: the request row gets the class `.interactive-request.editing`, and
  a full inline editor (a second `ChatInputPart`) is mounted **in place of the
  request text**, seeded with the original text, attachments, model, and mode.
  The Send button and toolbar are the editor's own (same as the composer). The
  bottom composer's Stop/Cancel button is suppressed while editing
  (`ChatContextKeys.currentlyEditing.negate()`). Verified CSS:
  `.interactive-session .interactive-request.editing .interactive-input-part .chat-input-container .chat-editor-container .monaco-editor`
  and the request bubble background is set solid via
  `--vscode-chat-requestBubbleBackground` while editing.
- **On submit (the important part)**: it **truncates**. VS Code computes
  `requestsToRemove = chatRequests.slice(itemIndex)` (the edited turn and every
  turn after it), sets `shouldBeRemovedOnSend` on them, undoes the file edits
  those turns made, and re-runs from that point. It is not an append. (`isHidden`
  is deprecated; the live flag is `shouldBeRemovedOnSend`.)
- **On cancel / Escape**: `finishedEditing(false)`, dispose the inline editor,
  restore the original text, no truncation. The inline editor's model choice is
  deliberately **not** copied back to the composer.
- **Confirmation**: only if the discarded turns actually made file edits, gated
  by `chat.editing.confirmEditRequestRemoval`. Dialog has a "Don't ask again"
  checkbox and messages that vary by "last request" vs "all subsequent
  requests" and single vs multiple files. Text-only threads truncate silently.

**Devin today:** the "Edit & resend" hover button copies `rawText` into the
composer and focuses it; sending appends a new turn. No in-place editor, no
truncation. (`webview/main.js`, `messageActions`.)

**Target:** default to `inline`. Clicking a sent user message turns it into an
in-place editor (reuse the existing composer DOM/logic factored into a component
so the inline instance and the docked composer share code). Send truncates from
that turn and re-runs; Escape cancels.

**Implementation:**

1. Turn model (Part 1) so we can address the turn and mount an editor in its
   request subtree.
2. Extract the composer (textarea, autosize, attachments, model/mode picker,
   send) into a factory used for both the docked composer and the inline editor.
3. On click of a user turn's text (when not busy), replace the request body with
   an inline editor seeded from `turn.request`. Add `.editing` to the row, hide
   the composer Stop button, add a solid background.
4. On submit: mark this turn and all later turns `state = 'removed'`, dim them
   (VS Code uses a `.disabled` overlay), call the backend to rewind to this
   turn's step (`revert`), remove the dimmed turns from the DOM, then send the
   edited prompt as the new turn.
5. On Escape/blur-cancel: restore the original request rendering.
6. Confirmation: if any of the removed turns have `changedFiles`, show a small
   in-thread confirm (match VS Code copy) with "Don't ask again" persisted to a
   setting; otherwise proceed silently.

**Backend dependency:** the truncation needs `/revert <step>` (or the
client-side fallback in 1.2). The in-place UI itself is pure webview and can ship
first, initially wired to "revert then resend".

**Effort:** M for the UI, plus the turn-model refactor (L, shared across all
features).

### 3.2 Restore checkpoints (restore to a point)

**VS Code behaviour (verified):**

- Gated by `chat.checkpoints.enabled`. A checkpoint is an automatic snapshot of
  affected files taken before each request; every turn has one, plus an initial
  "Initial State" checkpoint.
- **Affordance**: a per-request inline divider row, `.checkpoint-container`, with
  fading gradient lines on each side (`.checkpoint-line-left` /
  `.checkpoint-line-right`) and a toolbar (`MenuId.ChatMessageCheckpoint`). It is
  shown only on **request** rows, only when checkpoints are enabled, and is
  revealed on hover/focus (`opacity` 0 to 1 transition; hidden entirely while
  that row is being edited).
- **Action**: `workbench.action.chat.restoreCheckpoint`, label "Restore
  Checkpoint", tooltip "Restores workspace and chat to this point", keybinding
  Delete (macOS Cmd+Backspace).
- **Inline two-state confirm**: implemented by
  `ChatRestoreCheckpointActionViewItem`. If the restore would discard later
  edits, the first click does **not** restore; it flips the button in place to
  "Discard Edits" with an adjacent close (Cancel) button. A second click on
  "Discard Edits" restores; Cancel, focus-out, or Escape reverts the button.
  This is a lightweight in-place warning, distinct from the modal used elsewhere.
- **What it does**: reverts the files those turns touched to the snapshot **and**
  truncates the conversation back to that turn (same `slice(itemIndex)` logic as
  edit), then puts that turn's prompt text back into the composer (does not
  auto-run), so the user can tweak and resend.
- **Restored-state row**: after a restore, VS Code shows a
  `.checkpoint-restore-container` with a "Checkpoint Restored" label, a middle-dot
  separator, and an Undo/Redo toolbar; Redo walks forward and re-applies the
  undone turn.
- **Changes summary per turn**: gated by `chat.checkpoints.showFileChanges`
  (default on), a summary at the end of each completed turn showing
  "N files changed +ins -del", a "View All File Changes" action (opens the
  multi-file diff), an inline preview of the first file, and an expandable list;
  clicking a file opens a diff editor.

**Devin today:** none. We have a global working-set card with "Keep all / Undo
all" and per-file keep/undo, which is a different concept (accept/reject of the
current uncommitted edits, not point-in-time restore).

**Target:** a per-turn checkpoint divider row on hover, matching the gradient
line + label + restore button, with the inline "Discard Edits"/Cancel two-state
confirm, wired to `/revert <step>`. Add the per-turn changes summary pill.

**Implementation:**

1. Turn model + step mapping (Parts 1 and 2).
2. Render `.checkpoint-container` into each user turn's subtree, hidden by
   default, revealed on row hover/focus, styled with the two gradient lines and
   a "Restore Checkpoint" button. Copy the VS Code CSS behaviour.
3. Implement the inline two-state confirm exactly as
   `ChatRestoreCheckpointActionViewItem` does: first click, if this turn or a
   later one has `changedFiles`, swaps the label to "Discard Edits" and shows a
   Cancel (close icon) affordance; Escape/blur/Cancel reverts.
4. On confirm: call `revert(sessionId, stepId)`, remove later turns from the DOM,
   and put the turn's prompt text back into the composer.
5. Add the per-turn changes summary: at the end of a completed turn, render
   "N files changed" with a disclosure list and a "View All File Changes" button
   that reuses our existing `openAllDiffs`. We already receive diff locations per
   tool call, so we can attribute changed files to the turn.
6. Add a `devin.checkpoints.enabled` setting (default on) and a
   `devin.checkpoints.showFileChanges` setting.

**Backend dependency:** `/revert <step>` and `/steps`. If unreachable, fall back
to client-side per-turn snapshots (1.2); note that client-side cannot truncate
Devin's own server-side memory, so a fork-based restore may be more honest in
that case (see 3.4).

**Effort:** M (UI) once the turn model exists.

### 3.3 Undo / redo edits

**VS Code behaviour (verified):**

- `workbench.action.chat.undoEdit` ("Undo Last Edit", `Codicon.discard`) and
  `workbench.action.chat.redoEdit` ("Redo Last Edit", `Codicon.redo`), enabled by
  `chatEditingCanUndo` / `chatEditingCanRedo`, shown in the view title menu
  (hidden by default), no default keybinding.
- Granularity is a **whole turn** (interaction), not per-file or per-hunk.
  `undoInteraction` / `redoInteraction` map onto checkpoint
  `undoToLastCheckpoint()` / `redoToNextCheckpoint()`. So undo/redo edits **is**
  checkpoint navigation by one step.
- Separate from this is "Undo All Edits" (`chatEditing.discardAllFiles`, tooltip
  "Undo All Edits", keybinding Cmd/Ctrl+Backspace when the input is empty) with a
  confirm dialog, and per-file "Undo" (`chatEditing.discardFile`). Those are the
  working-set discard actions, closer to what we already have.

**Devin today:** only the working-set "Undo all" / per-file "Undo", which is the
"Undo All Edits" analogue, not conversational undo.

**Target:** add conversational **Undo Last Edit** / **Redo Last Edit** as
title-bar (or header) actions that step the revert point back and forward by one
turn, driven by `/revert`. Keep our existing working-set undo as the "Undo All
Edits" analogue and relabel accordingly for clarity.

**Implementation:** maintain `canUndo` (there is at least one completed turn) and
`canRedo` (we just reverted and have a forward turn cached). Undo calls
`revert` to the previous turn's step; Redo re-sends the cached truncated turn.
Because Devin re-runs the model on redo (there is no cheap "re-apply"), make
Redo's behaviour explicit in the UI (a tooltip like "Re-run the reverted turn").

**Backend dependency:** `/revert`. Redo may require re-prompting rather than a
true replay, which is an honest divergence to document.

**Effort:** S once restore (3.2) exists.

### 3.4 Fork conversation

**VS Code behaviour (verified):**

- `workbench.action.chat.forkConversation`, title "Fork Conversation", tooltip
  "Fork conversation from this point", icon `Codicon.repoForked`, hidden on the
  first request.
- It serialises the conversation, truncates the requests to `slice(0, targetIndex
  + 1)` (up to and including the chosen turn), gives it a new session id and a
  title prefixed "Forked: ", regenerates request/response ids, loads it as a new
  session, and navigates to it. The original session is untouched.

**Devin today:** none.

**Target:** a "Fork from here" action on each turn (in the per-turn hover
toolbar, or the checkpoint row's overflow) that calls `/fork [step]`, then opens
the returned new session. Because `/fork` creates a real new Devin session, this
is the **most faithful** of the four features to implement and does not require
truncating the current session.

**Implementation:** add `fork(sessionId, stepId)` to the ACP client; on click,
call it, then `loadSession(newId)` and switch the body to the thread. Refresh
the sessions list so the "Forked: ..." session appears. Prefix behaviour and
title can match VS Code.

**Backend dependency:** `/fork [step]` reachable over ACP (verify per 2.1). This
is likely the easiest to confirm because fork is inherently a session-creating
command.

**Effort:** S to M.

---

## 4. Turn layout and message chrome (the biggest visual decision)

**VS Code behaviour (verified):** the chat is **not** a left/right bubble chat.
Both the user turn and the assistant turn are **full-width, left-aligned rows**
(`.interactive-item-container`, with `.interactive-request` /
`.interactive-response`), each with an optional header (avatar + username +
detail/slash-command + timestamp), then a `.value` body, then toolbars. It reads
like a document/transcript, not a messaging app. Panel content is centred in a
max-width column (about 950px) with 32px side padding.

Per-turn chrome, driven by two menus:

- `MenuId.ChatMessageTitle`: a per-message toolbar revealed **top-right on
  hover/focus**. For requests: Edit (pencil) and Remove/Undo. For responses:
  Copy.
- `MenuId.ChatMessageFooter`: a persistent **footer toolbar under a completed
  response** with Helpful (thumbs up), Unhelpful (thumbs down), and Copy, plus a
  details element for response timing. Shown on the most recent response and on
  hover/focus of older ones (`.chat-footer-toolbar`).
- Request **timestamps** (`chat-request-timestamp`, aria-label "Sent {time}").

**Devin today:** we render left-aligned "You"/"Devin" role labels with **bubbles**
(the user recently added "left user bubbles"), and a small hover action bar per
message with Copy plus Edit (user) or Retry (assistant). Tool calls, thinking,
and plans are siblings in the flat stream, not grouped under a turn.

**Decision needed (flagged, not decided here):** VS Code's design is
deliberately bubble-less and transcript-like. We recently moved toward bubbles.
To truly match VS Code we would drop bubbles in favour of full-width rows with an
avatar + name header and grouped turn content. This is a meaningful visual change
and the opposite direction from the recent styling work, so it is called out as
the top open decision (Part 8) rather than assumed. My recommendation is to match
VS Code (full-width, avatar + name header, no bubbles, centred column, footer
toolbar on responses), because the user asked for the same UI/UX everywhere and
this is the core layout everything else sits inside.

**Implementation (if we match):**

- Turn container per turn (Part 1). Request row: avatar (Devin logo for us is for
  the assistant; use a generic person icon or the workspace/user avatar for the
  user) + "You" + timestamp, then the text. Response row: Devin logo + "Devin",
  then grouped content (text, thinking, tool cards, plan), then the footer
  toolbar.
- Move per-message actions into the two-toolbar model: a hover title toolbar
  (Edit + Remove on requests; Copy on responses) and a persistent footer toolbar
  on completed responses (Copy, and optionally Retry; thumbs up/down only if we
  ever wire feedback, otherwise omit as we already decided in 01).
- Centre the thread in a max-width column with side padding to match the panel
  card feel.
- Keep our richer tool cards, thinking blocks, terminal rendering, and usage
  meter; those are either Devin specific or arguably better and should stay.

---

## 5. Other flows to match while we are in here

These are smaller but part of "same UI/UX everywhere".

- **Follow-up chips**: VS Code renders `ChatFollowups` as monaco-style buttons
  under the last completed response (`.interactive-session-followups`), click
  submits. ACP does not send follow-ups, so this stays a heuristic/optional item
  (as in 01). If we add it, match the chip styling and placement exactly.
- **Confirmation widget**: our permission/elicitation trays should match VS
  Code's confirmation DOM and tokens: a container with a bold (markdown) title,
  a message paragraph, and a right-aligned button pair (primary filled +
  secondary), using `--vscode-button-*` and `--vscode-cornerRadius-medium`.
  Classes to mirror: `.chat-confirmation-widget`, `.chat-confirmation-widget-title`,
  `.chat-confirmation-widget-message`, `.chat-buttons-container`, `.chat-buttons`.
  Today ours is a generic `tray-card`; re-skin it to match.
- **Code block toolbar**: we already have Copy / Insert / Apply / Run in
  terminal. VS Code drives these from `MenuId.ChatCodeBlock` and animates the
  Copy icon (copy to check). Our icons and hover behaviour are close; align the
  copy-to-check animation and iconography.
- **Changes summary pill** per turn: covered in 3.2; it is the VS Code way of
  showing "what this turn changed" and replaces our single global working-set
  card conceptually (we can keep the working-set card for live, uncommitted
  edits and add the per-turn summary for history).
- **Request/response grouping and hover**: VS Code reveals a turn's toolbar on
  `group-hovered`/`focus-within` of the whole row, not just the small action bar.
  Match that hover scope.
- **"Used references"**: VS Code shows a collapsible "Used N references" in the
  request detail. We flagged this missing in 01; if we surface attachments and
  tool reads per turn, render it in the request header detail slot.

---

## 6. Settings to add (mirroring VS Code keys)

To keep behaviour configurable the way VS Code is, add:

- `devin.editRequests`: `"inline" | "hover" | "input" | "none"`, default
  `"inline"`. Mirrors `chat.editRequests`.
- `devin.checkpoints.enabled`: boolean, default true. Mirrors
  `chat.checkpoints.enabled`.
- `devin.checkpoints.showFileChanges`: boolean, default true. Mirrors
  `chat.checkpoints.showFileChanges`.
- `devin.editing.confirmEditRequestRemoval`: boolean, default true. Mirrors
  `chat.editing.confirmEditRequestRemoval` (with the "Don't ask again" wiring).
- (Optional) `devin.chat.bubbleLayout`: boolean, to let us keep bubbles as a
  non-default while the VS Code transcript layout becomes default. Only if we do
  not want to commit fully to one layout.

---

## 7. Prioritised plan

**Milestone A, the foundation (do first, nothing else works without it):**

1. Turn model in the webview (Part 1). L.
2. Verify `/steps`, `/revert`, `/fork` reachability over ACP (Part 2.1) and add
   the client wrappers (Part 2.2). S, but gates the semantics of B.

**Milestone B, the four headline features (the user's explicit asks):**

3. Edit a request in place (3.1), initially wired to revert-then-resend. M.
4. Restore checkpoints with the inline two-state confirm and the per-turn
   changes summary (3.2). M.
5. Undo / redo edits (3.3). S.
6. Fork conversation (3.4). S to M (likely the easiest backend path).

**Milestone C, layout and chrome parity:**

7. Decide bubbles vs transcript (Part 8), then implement the full-width
   avatar + name + footer-toolbar layout (Part 4). M.
8. Re-skin confirmation/elicitation to the VS Code confirmation widget (Part 5).
   S.
9. Code block copy-to-check animation and hover-scope polish (Part 5). S.

**Milestone D, smaller parity items** (from 01 to 12 that still stand): richer
`#` context types, request timestamps, "Used references", session
search/export/clear-all, follow-ups (heuristic), accessibility pass.

Suggested sequencing: A then B is the core of what the user asked for. C makes it
feel native. Do not start B before A.

---

## 8. Decisions needed from Shayan

1. **Bubbles vs VS Code transcript layout (Part 4).** VS Code has no bubbles;
   turns are full-width rows with an avatar + name header. We recently added
   bubbles. Do we switch to match VS Code (my recommendation, given the "same
   UI/UX everywhere" goal), keep bubbles, or make it a setting?
2. **Backend path for truncation (Part 2.1).** Should the implementer spend time
   confirming `/revert` and `/fork` over ACP first (recommended), and if they are
   TUI-only, do we (a) request a Devin side ACP method, or (b) accept the
   client-side snapshot + fork-based fallback with its limitations?
3. **Where this work lands.** One large branch that does Milestone A then B, or
   incremental PRs per feature on top of A?
4. **Fork destination.** Open the forked session in the same sidebar (like VS
   Code navigating the pane) or offer "open to the side" as well?

---

## Provenance

- VS Code core chat contrib: identifiers, action ids, settings, truncation
  logic (`shouldBeRemovedOnSend`, `slice(itemIndex)`), the inline edit editor
  (`.interactive-request.editing`), the checkpoint row
  (`.checkpoint-container`, `.checkpoint-line-left`, `ChatRestoreCheckpointActionViewItem`),
  fork (`ForkConversationAction`), and undo/redo (`undoInteraction` /
  `redoInteraction`) were read from a checkout of
  [`src/vs/workbench/contrib/chat`](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat)
  and confirmed present in the current snapshot (`chatWidget.ts`,
  `chatListRenderer.ts`, `chatEditingActions.ts`, `chatForkActions.ts`,
  `chatRestoreCheckpointActionViewItem.ts`, `widget/media/chat.css`,
  `chat.shared.contribution.ts`).
- Devin CLI primitives: `reference/commands.mdx` (Session Management) in the
  installed CLI docs (`/steps`, `/revert <step>`, `/fork [step]`, `/export`).
- Devin current state: `webview/main.js`, `media/main.css`,
  `src/chat/chatViewProvider.ts`, `src/acp/client.ts`, `src/diff/changeTracker.ts`.
