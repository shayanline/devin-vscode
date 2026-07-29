# Devin chat, VS Code core chat parity: review and plan

This is a fresh, ground-up review of the Devin VS Code extension chat webview
against the **VS Code core chat** (`microsoft/vscode`,
`src/vs/workbench/contrib/chat`), checked out at `/private/tmp/vscode-src`. It
replaces the old `01` to `13` parity notes.

It was written against:

- The current webview: `webview/main.js` (~2000 lines), `media/main.css`
  (~1830 lines), `media/webview-body.html`, and the host contract in
  `src/chat/chatViewProvider.ts`.
- VS Code core: the list renderer (`chatListRenderer.ts`), the widget host
  (`chatWidget.ts`), the input part (`input/chatInputPart.ts`), the content
  parts under `chatContentParts/` and their `media/*.css`, and the colours in
  `common/widget/chatColors.ts`.

The goal is to get as close as reasonably possible to VS Code's look, feel, and
feature set, component by component, changing only what is genuinely Devin
specific (ACP transport, no telemetry backend) or where we are arguably better.

---

## 0. How VS Code chat is actually built (so we mirror the right thing)

Three facts shape everything below.

1. **It is a hybrid layout, not pure transcript.** Assistant **responses** are
   full width and bubble-less. User **requests** are a right-aligned rounded
   bubble (`--vscode-chat-requestBubbleBackground`, `cornerRadius-xLarge` =
   12px, `max-width: 90%`, `margin-left: auto`). Both sit inside a
   `.interactive-item-container` that has a **header** (avatar + username +
   detail + timestamp) and, for responses, a **footer toolbar**. The whole
   column is centred at `max-width: 950px`.

   Devin today already does the important half of this: right-aligned request
   bubble, full-width responses. What is missing is the header (avatar +
   name), the timestamps, the persistent footer toolbar, and the centred
   column. So matching the layout is **additive**, not a rewrite. This was
   overstated as an "either/or" in the old notes.

2. **Everything boxed shares one recipe.** Every card-like content part is
   `1px solid var(--vscode-chat-requestBorder)`, a radius from the
   `--vscode-cornerRadius-*` ramp (4px lists, 6px code/confirmations/terminal,
   8px carousels/plan/todo), `margin-bottom: 8px`, and dim
   `--vscode-descriptionForeground` labels at `body-s` (12px). Match this recipe
   once and most parts fall into place.

3. **Three interaction patterns repeat everywhere.**
   - Collapse: `grid-template-rows: 1fr -> 0fr` + opacity, 180ms / 140ms
     `cubic-bezier(0.2, 0, 0, 1)`, plus a hover-revealed chevron that rotates
     0 to 90deg.
   - "Working" text: a clipped-gradient **shimmer** (the same effect we shipped
     for thinking) reused on progress, tool titles, and the restore-checkpoint
     confirm.
   - `.show-checkmarks`: spinners are swapped for `codicon-check` when a step
     completes.

All motion is gated behind `prefers-reduced-motion`.

---

## 1. Design token foundation (do this first)

VS Code drives chat off a small token set. We already introduced `--dv-*`
tokens in an earlier pass; this aligns them to VS Code's names and values so the
rest of the work can reference one vocabulary. VS Code injects **all** registered
theme colours into webviews as `--vscode-*` variables, so the chat colours
(`--vscode-chat-requestBorder`, `--vscode-chat-requestBubbleBackground`,
`--vscode-chat-thinkingShimmer`, `--vscode-chat-linesAddedForeground`, etc.) are
already available to us. We only need to define the **size** tokens VS Code
defines outside the theme (they are not injected).

Add to `:root` in `media/main.css`:

| Token | Value | VS Code equivalent |
|---|---|---|
| font size body-xs | `0.846em` (11px) | `--vscode-chat-font-size-body-xs` |
| body-s | `0.923em` (12px) | `--vscode-chat-font-size-body-s` |
| body-m | `1em` (13px) | `--vscode-chat-font-size-body-m` |
| body-l | `1.077em` (14px) | body-l |
| body-xl | `1.231em` (16px) | body-xl |
| body-xxl | `1.538em` (20px) | body-xxl |
| radius xSmall/small/medium/large/xLarge | 2 / 4 / 6 / 8 / 12px | `--vscode-cornerRadius-*` |
| spacing 20..160 | 2 / 4 / 6 / 8 / 10 / 12 / 16px | `--vscode-spacing-size*` |
| stroke | 1px | `--vscode-strokeThickness` |

We already have most of these as `--dv-radius-*`, `--dv-space-*`, `--dv-fs-*`.
Action: keep the `--dv-*` names (less churn), make sure the **values** match the
table exactly, set the base font to 13px on the chat root, and expose the
`body-l/xl/xxl` sizes we are currently missing. Set headings to
`h1=body-xxl, h2=body-xl, h3=body-l, weight 600`.

Key colours to standardise on (all already injected by VS Code):

- `--vscode-chat-requestBorder`: the universal border/divider (we already alias
  this as `--dv-border`).
- `--vscode-chat-requestBubbleBackground` / `...HoverBackground`: request bubble.
- `--vscode-chat-avatarBackground` / `...avatarForeground`: avatar disc.
- `--vscode-chat-linesAddedForeground` / `...linesRemovedForeground`: +/- counts.
- `--vscode-chat-thinkingShimmer`: shimmer highlight (already used).

---

## 2. Component-by-component review

Legend for **Status**: ✅ close to VS Code, 🟡 present but diverges, ❌ missing,
➖ not applicable to Devin.

### 2.1 Turn container and layout

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Column width | centred, `max-width: 950px`, 16px side padding | full width of panel | 🟡 | Centre `#thread` content at a max width with side padding; keeps wide editors readable. |
| Turn grouping | `.interactive-item-container` per request and per response, paired | `.turn` groups request + response together | 🟡 | Fine as is, or split to per-row to match `group-hovered`. Low priority. |
| Request bubble | right-aligned, `requestBubbleBackground`, radius 12px, max-width 90% | right-aligned `.req-body` bubble, radius `xLarge` | ✅ | Confirm token + max-width 90%. |
| Response | full width, bubble-less | full width `.turn-response` | ✅ | Keep. |
| Avatar + username header | `.header` with 24px avatar disc + `h3.username` (600) + `.detail` | none | ❌ | Add an optional header: Devin logo avatar + "Devin" for responses, account icon + "You" for requests. Gate behind a setting (may be visual clutter in a 1:1 panel). **Decision needed.** |
| Timestamps | `.chat-request-timestamp` (Sent {time}) + response completion/elapsed timing, gated by `chat.verbose` | none | ❌ | Capture send/complete time client-side, render dim timestamps on hover. Needs no host change. |
| Dim overlay on superseded turns | `.chat-row-disabled-overlay` while editing earlier turn | `.turn.discardable` dims | ✅ | Keep. |

### 2.2 Per-turn toolbars

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Request hover toolbar (`ChatMessageTitle`) | top-right on hover: Edit, Undo/Remove | hover `.msg-actions`: Copy + Edit | 🟡 | Keep; add Remove/Undo-turn if we wire conversational undo. |
| Response footer toolbar (`ChatMessageFooter`) | **persistent** under completed response: Copy, Retry, (thumbs), timing/model detail | hover-only Copy + Retry | 🟡 | Add a persistent `.chat-footer-toolbar` under completed responses (always visible on the newest, hover on older). Copy-icon copy→check animation. |
| Reveal scope | `.group-hovered` reveals on hover of request or its response | per-element `:hover` | 🟡 | Widen hover scope to the whole turn. |
| Thumbs up/down | wired to telemetry | none | ➖ | Drop: no feedback backend. |

### 2.3 Rendered response content parts

| Part | VS Code class | Devin now | Status | Action |
|---|---|---|---|---|
| Markdown / text | `.chat-markdown-part.rendered-markdown`, body-m, heading scale | `.bubble` via markdown-it | ✅ | Align heading sizes to body-l/xl/xxl; paragraph margin 16px. |
| Thinking / reasoning | `.chat-thinking-box` chain of thought + shimmer | `.thinking` chain of thought + shimmer | ✅ | Shipped this pass. Optional: `thinkingStyle` (collapsed / fixedScrolling peek). |
| Tool invocation | `.chat-tool-invocation-part`, verb + dimmed detail, expandable | `.tool` expandable card, verb + dimmed detail | ✅ | Re-skin to the shared box recipe + `.show-checkmarks`; align paddings/tokens. |
| Tool risk badge | `.tool-risk-badge`, green/orange/red accent | none | ❌ | Add a risk row when a permission/tool is risky (maps to ACP permission kinds). |
| Code block | `.interactive-result-code-block`, radius 6px, hover toolbar | `.bubble pre` + `.code-toolbar` | 🟡 | Radius `medium`, toolbar border `requestBorder`, animate copy→check. |
| Code block edit pill | `.chat-codeblock-pill-container` (file icon, +/- counts, progress fill) | file-change `.tool-line` | 🟡 | Introduce a proper edit pill with added/removed counts and a fill animation. |
| Inline anchor chip | `.chat-inline-anchor-widget` (bordered chip, file icon) | plain link | 🟡 | Render file/symbol refs in text as bordered chips with an icon. |
| Used references / context | `.chat-used-context` collapsible "Used N references" | none | ❌ | Track per-turn attachments + tool reads in the host, render a collapsible list. |
| File tree | `.interactive-response-progress-tree` | none | ❌ | Low priority unless ACP emits trees. |
| Progress / working | `.progress-container` spinner + dim step, shimmer | header status + `.working` line | 🟡 | Render inline progress rows with the shimmer, `.show-checkmarks`. |
| Task / todo list | plan part + `.chat-todo-list-widget` | `.plan` card | 🟡 | Re-skin plan to the todo-widget look (status icons, radius large top). |
| Multi-diff / changes summary | `.chat-summary-list` + view-changes button, per-file +/- | working-set card + "Open all" | 🟡 | Add per-turn changes summary pill with counts; keep live working set. |
| Confirmation widget | `.chat-confirmation-widget2` (title / message / buttons, tokens) | generic `.tray-card` | 🟡 | Re-skin permission + elicitation trays to the widget2 DOM and tokens; move inline into the transcript. |
| Question carousel | `.chat-question-carousel` one-at-a-time, nav arrows, step indicator | multi-field `.tray-card` form | 🟡 | Rebuild as one-card-at-a-time carousel with nav + submit. |
| Warning / notification | `.chat-notification-widget` info/warning/error rows | none | ❌ | Render agent/tool warnings as icon rows. |
| Terminal | `.chat-terminal-content-part` title + output box | embedded terminal in tool card | ✅ | Align to title + collapsible output box styling. |
| Quota / rate-limit / sign-in | dedicated widgets with actions | `.error-card` with actions | ✅ | Keep; align classes/tokens. |
| Pull request / extensions / MCP rows | dedicated parts | none | ➖ | Mostly Copilot-specific. Add MCP "starting/interaction" dim line if ACP surfaces it. |

### 2.4 Input / composer

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Container | `.chat-input-container`, radius `large`, input bg/border | `#input-box`, focus ring | ✅ | Align radius to `large` (8px). |
| Working border | conic-gradient "comet" ring, `chat.progressBorder.enabled` | blue sweep `::before` while busy | 🟡 | Align the animation to VS Code's comet; gate on reduced motion (already). |
| Toolbars | left pickers row + execute (send/stop) toolbar | `.toolbar-left` + `.toolbar-right` | ✅ | Keep. |
| Model picker | `.chat-input-picker-item` + badge, grouped dropdown, hover cost card | dropdown with families + thinking variants | ✅ | Keep; optional cost hover. |
| Mode / agent picker | Ask / Plan / Agent with icons | mode dropdown | ✅ | Keep; add mode icons. |
| Send / stop | `arrowUpCompact` filled 22px / `stopCircle` | filled square send / stop | ✅ | Align icons/size. |
| Attachments | pills, 18px, `requestBorder`, file icons, image tiles | `.chip` pills + image? | 🟡 | Align pill styling; ensure image/selection pills. |
| Add context (`@`) | `.chat-add-files` + `@` autocomplete | `+` button + `@` autocomplete | ✅ | Keep. |
| Context usage | circular ring + details popup, `chat.contextUsage.enabled` | usage ring + popover | ✅ | Keep; align ring visuals. |
| Followups | `.interactive-input-followups` chips | none | ➖ | ACP sends none. Skip unless we heuristically derive. |
| Todo/tips/goal/artifacts banners | several stacked widgets above input | none | ➖/❌ | Only the todo widget is relevant; low priority. |

### 2.5 Welcome / empty state and errors

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Welcome | `.chat-welcome-view` icon + title + message + suggested prompts | `.welcome` logo + title + starter chips | ✅ | Align classes/spacing; prompts as pills. |
| Error / auth / rate limit | dedicated widgets with sign-in / upgrade / retry | `.error-card` with actions | ✅ | Keep; align tokens. |

### 2.6 Editing, checkpoints, undo, fork

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Edit in place | `chat.editRequests` inline/hover/input/none, truncate on submit | inline + hover, revert-then-resend | 🟡 | Replace native `confirm()` with an in-thread confirm widget; persist "don't ask again". |
| Restore checkpoint | `.checkpoint-container` divider + inline two-state "Discard Edits" | `.checkpoint-row` restore + confirm | ✅ | Add "Checkpoint Restored" row + per-turn changes pill. |
| Undo / redo edits | checkpoint navigation | working-set "Undo all" only | ❌ | Wire conversational undo/redo to ACP revert (step back/forward one turn). |
| Fork | new session copy | none | ➖ | Blocked: ACP fork methods return `-32601`. Revisit if Cognition exposes it. |

### 2.7 Settings to align (`package.json`)

Have: `showThinking`, `editRequests` (inline/hover/none), `checkpoints.enabled`,
`checkpoints.showFileChanges`, `editing.confirmEditRequestRemoval`.

Add / align to VS Code keys where they map: `chat.verbose` (timestamps),
`chat.progressBorder.enabled`, `chat.contextUsage.enabled`,
`chat.agent.thinkingStyle`, `chat.agent.collapseCompletedResponses`,
`chat.editRequests` fourth value `input`. Namespaced under `devin.*`.

---

## 3. Locked decisions

Confirmed with Shayan:

1. **No avatar / username header.** Keep the clean bubbles (no 24px avatar, no
   "You" / "Devin" name row). Still add subtle **hover timestamps**.
2. **Highest-visibility first.** Lead with the gaps a user sees every session
   (footer toolbar, inline confirmations, the question carousel, tool/code
   polish); defer the long tail.
3. **Include the behaviour gaps.** Conversational undo/redo via ACP revert and
   per-turn "Used N references" tracking are in scope, not deferred.

---

## 4. Roadmap (highest-visibility first)

Each phase is independently shippable and verified via the jsdom harness +
Playwright preview screenshot before moving on.

- **Phase 1, token foundation (quick prep). ✅ Done (v0.6.16).** Radius ramp
  aligned (added `xSmall`, `xLarge` now 12px, request bubble uses it), heading
  scale mapped to body-l/xl/xxl at weight 600, and a shared `.dv-card` box
  recipe added.
- **Phase 2, turn chrome (no header). ✅ Done (v0.6.16).** Centred 950px column,
  hover timestamps ("Sent HH:MM" on the request, completion time in the
  footer), a persistent footer toolbar under completed responses (Copy +
  Retry) that is always shown on the most recent turn and hover/focus on older
  ones, copy→check via `flashCheck`, and the `group-hovered` reveal widened to
  the whole turn. No avatar/name row (per decision 1). (§2.1, §2.2)
- **Phase 3, confirmations. ✅ Done (v0.6.17).** Re-skinned permission +
  elicitation to VS Code's `chat-confirmation-widget2` structure (a `.cw` card:
  bold title row with a bottom border, a body with a subtle `requestBackground`
  fill, and a right-aligned primary/secondary `.cw-buttons` row). Kept them in
  the composer trays, which matches VS Code's placement of the question and
  tool-confirmation **carousels in the input area** (not the transcript), a
  refinement on the original "move inline" wording. Replaced the native
  `confirm()` edit-discard dialog with an in-thread `.cw` confirm carrying a
  "Don't ask again" checkbox that persists via a new allowlisted `setConfig`
  host message (`devin.editing.confirmEditRequestRemoval`). (§2.3, §2.6)
- **Phase 4, question carousel. ✅ Done (v0.6.18).** Elicitation forms now
  render as a `.qc` carousel matching VS Code's `chat-question-carousel`: a
  prompt header with a close (cancel) action, a body showing one question at a
  time, and a footer with prev/next arrows, a "N / M" step indicator, and a
  right-aligned Submit. Submit validates every question and jumps to the first
  unanswered one with a validation line. Single-question prompts collapse the
  nav and step. URL prompts stay a simple `.cw` confirmation. (§2.3)
- **Phase 5, tools + code + edits polish. ✅ Mostly done (v0.6.19).** Shipped:
  edit pills with **+added / -removed line counts** (computed host side via an
  LCS line diff in `diffStat`, forwarded on `fileChange` and diff tool content),
  a `filePill` shared by file-change rows and tool diff rows (file icon, name,
  coloured counts), **inline anchor chips** for file/symbol refs in assistant
  prose (`enhanceAnchors`), and code-block / tool-pre radius aligned to the
  tokens (copy→check already existed). Deferred: the **risk badge** (ACP does
  not surface a risk level, needs agent support) and the diff-fill sweep
  animation (cosmetic). The per-turn changes summary is already covered by the
  working-set card plus the inline edit pills, so no separate pill was added.
  (§2.3)
- **Phase 6, progress + references + notifications. ✅ Mostly done (v0.6.20).**
  Shipped: a shared `.dv-shimmer` "working" highlight applied to the pending
  indicator (and reused by thinking), gated by reduced motion; and a collapsed
  **"Used N references"** summary per turn (`renderUsedRefs`) that aggregates
  and de-dupes the files the turn read or searched (from tool `locations`),
  rendered with the shared file pills. Deferred: standalone warning /
  notification content rows, since ACP does not emit a distinct warning part
  (errors are already handled by the error card). (§2.3, §2.6)
- **Phase 7, plan/todo widget + streaming animations. ✅ Mostly done (v0.6.21).**
  Re-skinned the plan card to VS Code's todo-widget look (bordered card on the
  token radius, status glyphs: green check + strikethrough for done, a spinner
  for active, an outline for pending), and added a gentle `dv-appear` entrance
  animation on each response part as it streams in, gated by reduced motion.
  Deferred: the full set of incremental-render variants (fade/rise/blur/slide)
  and `collapseCompletedResponses` (collapsing intermediate work in a finished
  response), which are larger and lower value. (§2.3)
- **Phase 8, behaviour gaps + settings.** Conversational undo/redo via ACP
  revert, the "Checkpoint Restored" row, and the `devin.*` settings that map to
  VS Code keys. (§2.6, §2.7)

Out of scope / not applicable: thumbs feedback (no backend), follow-up chips
(ACP sends none), fork (ACP blocked, `-32601`), Copilot-specific parts (public
code citations, PR/extensions widgets), the avatar/username header (decision 1).
