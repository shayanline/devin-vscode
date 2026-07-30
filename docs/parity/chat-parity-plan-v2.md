# Devin ⇄ VS Code Copilot Chat — Parity Review v2 (from scratch)

> This is a **fresh, independent** component-by-component review of the Devin
> VS Code chat webview against the **real** VS Code core chat source
> (`microsoft/vscode`, `src/vs/workbench/contrib/chat/`), checked out locally at
> `~/VSCode/vscode/src/vs/workbench/contrib/chat/` (branch `main`, commit
> `663aa23`, July 2026).
>
> It **replaces** `chat-parity-plan.md`. That earlier plan declared all phases
> "shipped"; this review does **not** trust those claims. Every row below was
> re-verified against the current code on both sides:
> - Devin: `webview/main.js` (2289 lines), `media/main.css` (2272 lines),
>   `media/webview-body.html`, `webview/markdown.js`, and the host contract in
>   `src/chat/chatViewProvider.ts` (1472 lines), `src/acp/*`.
> - VS Code: `chatListRenderer.ts`, `chatWidget.ts`, `input/chatInputPart.ts`,
>   the ~65 files under `chatContentParts/`, `common/widget/chatColors.ts`, and
>   the ~4825-line `widget/media/chat.css`.
>
> **Goal:** a faithful 1:1 replica of the Copilot Chat panel — same layout,
> tokens, colours, animations, easing curves, and behaviours — swapping only the
> transport (Devin ACP instead of the Copilot language-model backend) and
> dropping what the ACP protocol genuinely cannot express.

---

## 0. How to read this document

**Status legend**

| Symbol | Meaning |
|---|---|
| ✅ | Matches VS Code closely; only trivial polish (if any) left. |
| 🟡 | Present in Devin but visibly diverges (structure, tokens, motion, or behaviour). |
| ❌ | Missing entirely from Devin. |
| 🚫 | Not achievable over Devin ACP today (documented boundary; revisit if the protocol grows). |
| ➖ | Copilot-specific / not applicable to Devin (telemetry, GitHub, Copilot entitlements). |

Each section is **VS Code reference → Devin now → Status → Action**. Exact class
names, tokens, px values and timings are quoted so the actions are directly
executable. Section 10 is the prioritised execution plan.

---

## 1. Architecture: what "1:1" can and cannot mean here

VS Code chat is a **native workbench contribution**: a Monaco-backed input
editor, a virtualised `WorkbenchList` of rows, `MenuId`-driven toolbars, and
~65 typed content-part renderers, all themed by registered colours and the
workbench design-token ramp.

Devin chat is a **single webview**: `webview-body.html` mounts a fixed DOM, and
`main.js` imperatively renders a flat transcript from ACP `session/update`
notifications relayed by `chatViewProvider.ts`. Styling is one hand-written
`main.css`.

This shapes what parity means:

- **Achievable and in scope (cosmetic + behavioural):** the transcript layout,
  bubbles, headers/footers, tokens, colours, radii, spacing, every animation and
  easing curve, the content-part visuals (thinking, tools, code, pills,
  confirmations, carousels, plan/todo, changes summary), the composer chrome
  (working border, pickers, attachments, usage ring), welcome, sessions.
- **Accepted structural divergence (not worth replicating literally):**
  - The input is a **`<textarea>`, not a Monaco editor.** Embedding Monaco in a
    webview is impractical; we keep the textarea and mimic look + behaviour
    (placeholder, autosize, `@`/`/` autocomplete). *Do not* plan to port Monaco.
  - Response code blocks are **`highlight.js` `<pre>`**, not live Monaco
    editors. We match the *frame* (border, radius, hover toolbar) but not the
    editor internals.
  - The transcript is **imperative DOM**, not a virtualised list. Fine at chat
    scale.
- **ACP-bounded (🚫):** anything requiring protocol surface Devin does not emit.
  See §2.

Everything else is fair game for pixel parity.

---

## 2. Devin ACP capability boundary (the hard limits)

Verified from `src/acp/client.ts`, `src/acp/types.ts`, `chatViewProvider.ts`.

**What ACP gives us (usable signal):**

| ACP surface | Feeds |
|---|---|
| `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` | assistant text, thinking, replayed user turns |
| `plan` (`entries[]` with status) | plan / todo widget |
| `tool_call` / `tool_call_update` (`title`, `kind`, `status`, `content[]`, `rawInput`, `locations[]`) | tool cards, terminal, diffs, used-references |
| `usage_update` (`used`, `size`, `cost`) | context-usage ring + cost |
| `available_commands_update` | `/` slash-command autocomplete |
| `current_mode_update` + `configOptions` (`mode`, `model`) | mode + model pickers |
| `session/request_permission` (`options[]` with `kind`) | permission confirmation widget |
| `_session/elicitation` (JSON schema form / url) | question carousel |
| `terminal/*` client methods | live terminal output |
| `_cognition.ai/revert/*` (gated by `clientCapabilities._meta["cognition.ai/revert"]`) | edit-in-place, checkpoints, undo |
| `_cognition.ai/session/rename`, `session/delete`, `session/load`, `session/new` | session management |

**Hard boundaries (🚫 — do not promise these as "matched"):**

1. **No tool risk level.** ACP tool calls carry no risk/severity. VS Code's
   green/orange/red `tool-risk-badge` (`chat.tools.riskAssessment.*`) cannot be
   populated. Leave a styled slot; do not fake an assessment.
2. **No redo, no fork.** `_cognition.ai/revert` only rewinds. There is no
   forward step and `fork`/branch RPCs return `-32601`. VS Code's Fork
   (`chatForkActions.ts`) and redo are not implementable.
3. **No standalone warning content part.** ACP has no "warning" update distinct
   from errors, so VS Code's `chat-notification-widget` (info/warning) has no
   direct feed. Tool failures + the error card cover the observable cases.
4. **No follow-up suggestions.** ACP emits no `followups`; VS Code's
   `interactive-input-followups` chips have no source. (Could be heuristically
   derived later, but that is invention, not parity.)
5. **No thumbs / helpful-unhelpful, no "Report Issue", no quota/entitlement
   flows** (`chatQuotaExceededPart`, `chatAnonymousRateLimitedPart`,
   title-bar sign-in): these are Copilot telemetry / GitHub-entitlement
   features. ➖.
6. **No PR / extensions-install / MCP-app rows** as first-class parts — Copilot
   ecosystem specific. *Exception:* Devin does emit `_cognition.ai/*`
   notifications (currently only logged in `client.ts handleNotification`); MCP
   "starting/interaction" dim lines could be surfaced if we parse them (see
   §6.14). ➖ for the rest.
7. **Node ids are not in the stream.** Revert targets are discovered by probing
   `revertPreview` and parsing `"...from head H..."` (`client.currentHead`).
   This works but means checkpoints only exist for turns whose head we captured
   (live turns), not arbitrary replayed history. Already handled via
   `turn.replayed`.

Everything in §3–§9 below is achievable **unless** tagged 🚫/➖.

---

## 3. Design-token foundation

VS Code declares the chat font ramp locally on `.interactive-session`
(`chat.css:15-26`) and pulls radius/spacing/stroke from the global workbench
ramp (`baseSizes.ts`), all on a **13px base**.

| Token | VS Code value | Devin now (`main.css` `:root`) | Status | Action |
|---|---|---|---|---|
| Base font size | container forced to `13px`, ramp is `em` | inherits `--vscode-font-size` (13px in sidebar, but not pinned) | 🟡 | Pin the chat root to `font-size: 13px` (or `var(--vscode-font-size, 13px)`) so the `em` ramp is exact regardless of host. |
| body-xs … body-xxl | `0.846 / 0.923 / 1 / 1.077 / 1.231 / 1.538 em` | `--dv-fs-xs…xxl` = identical values | ✅ | Keep. Optionally alias to the real `--vscode-chat-font-size-body-*` names for grep-parity. |
| cornerRadius xSmall→xLarge | `2 / 4 / 6 / 8 / 12` | `--dv-radius-xs…xl` = `2/4/6/8/12` | ✅ | Keep. |
| cornerRadius circle | `9999` | **missing** | ❌ | Add `--dv-radius-circle: 9999px` for pills/dots (usage badge, price badge). |
| spacing ramp | `0/2/4/6/8/10/12/16…` | `--dv-space-1…8` = `2/4/6/8/10/12/16` | ✅ | Keep. |
| stroke | `1px` (`--vscode-strokeThickness`) | hard-coded `1px` everywhere | ✅ | Fine. |
| Universal border colour | `--vscode-chat-requestBorder` | `--dv-border` aliases it | ✅ | Keep. |

**Colours** — VS Code injects every registered `chat.*` colour into the webview
as a `--vscode-chat-*` variable, so they are *already available to us*. Devin
already consumes the important ones (`requestBorder`, `requestBubbleBackground`,
`requestBubbleHoverBackground`, `thinkingShimmer`, `linesAdded/RemovedForeground`,
`checkpointSeparator`). Two are **not yet used**:

- `--vscode-chat-inputWorkingBorderColor1` — the colour of the working "comet"
  border (§5.2). Devin currently hard-codes `--vscode-focusBorder`. **Switch to
  `inputWorkingBorderColor1`** to match hue.
- `--vscode-chat-avatarBackground/Foreground` — only needed if we ever add the
  header (we correctly do not; see §4.2).

Full colour table for reference is in Appendix A.

---

## 4. Shell: turn container, header, footer, toolbars

### 4.1 Column + row layout

| Item | VS Code | Devin now | Status | Action |
|---|---|---|---|---|
| Centred column | `.interactive-session { max-width:950px; margin:auto }` + `layout()` clamps width to 950 | `#thread { align-items:center }` + `#thread > * { max-width:950px }` | ✅ | Equivalent. Keep. |
| Row padding | rows `padding:12px 16px` (panel welcome variant `5px 16px`) | `#thread { padding:12px }`, turns have no side padding | 🟡 | Add `padding:0 4px` inside turns or bump thread side padding to `16px` to match horizontal rhythm. Low priority. |
| Inter-item gap | list rows are contiguous; spacing via row padding | `#thread { gap:16px }`, `.turn { gap:6px }`, `.turn-response { gap:8px }` | ✅ | Reads the same. Keep. |

### 4.2 Header (avatar + username) — **correctly omitted**

VS Code builds a `.header` with a 24px round `.avatar` + `h3.username` +
`.detail`. **But** `shouldHideChatUserIdentity()` (`chatListRenderer.ts:455`)
**hides the avatar and username for Copilot sessions, agent-host sessions, the
sessions window, and system-initiated requests** — i.e. the entire standard
Copilot panel renders **bubble-only, header-less**, exactly like Devin.

**Conclusion:** Devin's no-header design is the faithful replica, not a gap. ✅
Do **not** add avatars/usernames. (This overturns nothing — it confirms the
earlier decision was right, but for the *correct* reason: the reference itself
hides identity.)

### 4.3 Per-request hover toolbar (`MenuId.ChatMessageTitle` / `.request-hover`)

VS Code: absolute pill top-right (`top:-13px; right:20px; height:26px; radius:3px;
border:1px solid requestBorder`), revealed on request hover/`:focus-within`;
actions Edit, Undo, Cancel-Edit (+ pending-queue actions).

Devin: `.req-actions` absolute `top:4px; right:4px`, revealed on `.turn:hover`;
actions **Copy + Edit**.

| Aspect | Status | Action |
|---|---|---|
| Reveal on whole-turn hover | ✅ | Keep (`.turn:hover`). |
| Position / chrome | 🟡 | Optional: move to a bordered pill at `top:-13px` like VS Code. Low priority (cosmetic, and our bubble is right-aligned so top-right-of-bubble reads well). |
| Undo action in this toolbar | 🟡 | Devin exposes undo via the checkpoint **Restore** row instead. Acceptable; optionally add an explicit "Undo" icon here mapping to `revertExecute(headBefore)`. |
| Queue actions (Send Immediately / Remove from Queue) | ➖ | Devin has no request queue. Skip. |

### 4.4 Persistent response footer (`MenuId.ChatMessageFooter` / `.chat-footer-toolbar`)

VS Code: `display:none` until complete, then `opacity:0` revealed to `1` on
`.chat-most-recent-response` / `:focus-within` / `.group-hovered`; actions Retry,
Helpful/Unhelpful (telemetry), Report Issue (telemetry), Copy; **copy button
cross-fades two stacked icons** (`.chat-copy-action-icon-copy` ↔ `-copied`,
`140ms cubic-bezier(0.2,0,0,1)`); details block (`.chat-footer-details`) shows
timing + model, `font-size:body-xs; opacity:0.7; margin-left:auto`.

Devin: `.chat-footer` hidden until `.turn.complete`, revealed on last turn /
hover / focus; actions **Copy + Retry**; `flashCheck` swaps the copy icon to a
check for 1200ms; `.chat-footer-details` shows completion time.

| Aspect | Status | Action |
|---|---|---|
| Persistent-on-last, hover-on-older | ✅ | Matches. Keep. |
| Retry + Copy | ✅ | Keep (thumbs/report are telemetry ➖). |
| Copy affordance | 🟡 | Replace `flashCheck` swap with the **two-icon cross-fade** (stack copy + check in a 16×16 grid, `opacity+transform 140ms cubic-bezier(0.2,0,0,1)`), reduced-motion gated. |
| Details | 🟡 | Add the **model name** next to the time (`{model} · {time}`); VS Code shows model in the footer detail. |
| Reveal easing | 🟡 | VS Code `opacity 0.1s ease-in-out`; Devin `0.12s ease`. Align to `0.1s ease-in-out`. |

### 4.5 Timestamps (`chat.verbose`)

VS Code: request + response timestamps with a **flip micro-interaction** —
relative↔absolute slide on hover (`.chat-response-timing` inline-grid,
`translateY(±100%)`, `160ms ease`), reduced-motion gated.

Devin: static "Sent HH:MM" under the request + completion time in the footer,
revealed on hover. No flip.

| Status | Action |
|---|---|
| 🟡 | Optional polish: add the relative↔absolute flip (store `createdAt`/`completedAt`, show "just now"/"2m ago" resting, absolute on hover) with the `160ms ease` slide. Low priority. |

### 4.6 Disabled / superseded overlay

VS Code: `.chat-row-disabled-overlay.disabled { inset:0; background:sideBar; opacity:0.6; z-index:101 }` over non-edited rows during editing.
Devin: `.turn.discardable { opacity:0.4; pointer-events:none }`.

| Status | Action |
|---|---|
| ✅ | Equivalent effect. Optionally match the `0.6` overlay approach for a cleaner dim, but current is fine. |

---

## 5. Composer / input

### 5.1 Input container

| Item | VS Code (`chat.css:1080-1107`) | Devin (`#input-box`) | Status | Action |
|---|---|---|---|---|
| Background / border | `input-background` / `1px input-border` | same | ✅ | Keep. |
| Radius | `cornerRadius-large` (8px) | `8px` | ✅ | Keep. |
| Padding | `0 6px 6px 6px` | `8px 8px 6px` | 🟡 | Minor; align to `0 6px 6px` if we want exact. |
| Focus | `.focused { border-color: focusBorder }` | `:focus-within` same | ✅ | Keep. |
| Loses top radius under a docked widget | yes (editing-session/todo sit flush on top) | working-set sits above with its own radius, not flush | 🟡 | When the working-set / plan widget is docked, square the input's top corners and flush the widget onto it (see §6.11, §6.12). |

### 5.2 Working "comet" border — **priority cosmetic gap** ★

VS Code (`chat.css:1109-1251`) is a **two-layer** animated ring:
- `@property --chat-input-anim-angle` (`<angle>`, 135deg).
- `::before` **beam**: `inset:-1px; padding:1px`, `conic-gradient(from angle,
  transparent 0deg, color-mix(color1 90%,transparent) 20deg, color1 30deg,
  color-mix(color1 60%,transparent) 50deg, transparent 90deg…)`, clipped to a
  1px ring with the `mask … mask-composite:exclude` trick.
- `::after` **glow**: same gradient, `padding:2px; filter:blur(1.5px)`, softer
  stops.
- Colour: **`--vscode-chat-inputWorkingBorderColor1`** (= `buttonBackground`).
- Spin: `chat-input-working-border-spin` 135deg→495deg, duration **dynamic
  1.4s–2.5s** = `clamp(1.4, 0.55 + 0.075*sqrt(width), 2.5)`, restarted via a
  one-frame `.chat-input-anim-restart` when width changes.
- Fades in/out via `opacity 350ms ease`; on `.working` container keeps a faint
  ring and forces the editor bg transparent so the beam shows through.
- Fully disabled under `prefers-reduced-motion` **and** gated in JS.

Devin (`main.css:599-635`): single-layer `::before` conic-gradient
(`transparent…focusBorder 330-360deg`), **fixed 1.5s**, `--vscode-focusBorder`
colour, no glow, no dynamic duration, no fade transition, no restart.

| Status | Action |
|---|---|
| 🟡 → target ✅ | Rebuild to match: (1) recolour to `--vscode-chat-inputWorkingBorderColor1`; (2) widen the beam gradient to the 20/30/50/90-deg stops with `color-mix`; (3) add the blurred `::after` glow ring; (4) spin 135→495deg; (5) add `opacity 350ms ease` fade in/out; (6) make the editor bg transparent while busy; (7) dynamic duration `clamp(1.4s, 0.55+0.075*sqrt(width), 2.5s)` via a ResizeObserver-driven CSS var (we already have a ResizeObserver on `#input-box`). Keep the reduced-motion gate. |

### 5.3 Left picker toolbar & send/stop

| Item | VS Code | Devin | Status | Action |
|---|---|---|---|---|
| Toolbar layout | `.chat-input-toolbars` flex, left pickers + right execute | `#toolbar` `.toolbar-left` + `.toolbar-right` | ✅ | Keep. |
| Send icon | `codicon-arrow-up-compact` (up arrow), 22×22 filled `button-background`, `border-radius:small` | `codicon-newline` (return glyph), 22×22 filled | 🟡 | **Change send icon to `codicon-arrow-up`** (VS Code uses an up-arrow, not a return glyph — visible mismatch). |
| Send icon nudge | `.codicon-arrow-up-compact::before { translateY(0.5px) }` | none | 🟡 | Add the 0.5px nudge for optical centring. |
| Send bg transition | `background-color 250ms ease` (+120ms idle) | none | 🟡 | Add `transition: background-color 120ms ease`. |
| Stop icon | `codicon-debug-stop` | `codicon-primitive-square` | 🟡 | Switch to `codicon-debug-stop` (or keep square — both read as "stop"; low priority). |
| Disabled send | still shown as a real (disabled) button | becomes transparent icon-only | 🟡 | Cosmetic; VS Code keeps the filled look. Optional. |
| Focus ring | `outline:1px focusBorder; offset:1px` on wrapper | none explicit | 🟡 | Add a focus ring on send/stop for keyboard parity. |

### 5.4 Mode picker

VS Code: Ask / Edit / Agent (+ custom agents), grouped dropdown, icons
`ask`/`tasklist`/`agent`/`edit`, keybinding `Ctrl/Cmd+.`.

Devin: **Devin's own ACP modes** — Accept Edits / Ask / Plan / Bypass, dropdown
with icons `code`/`comment-discussion`/`checklist`/`unlock`.

| Status | Action |
|---|---|
| ✅ | The *modes themselves* are correctly Devin's (parity is with the picker UX, not Copilot's mode names). Keep. Optional: raise the picker button styling to match `.chat-input-picker-item` (`height:16px; padding:3px 6px; radius:4px`, chevron `font-size:10px; opacity:0.75`). |

### 5.5 Model picker (+ thinking variants)

VS Code: split `.model-picker-name` / `.model-picker-config` + `.model-picker-badge`; grouped dropdown with filter; **hover cost card** (name, description, price pill, cost grid); provider icons.

Devin: family dropdown (`createDropdown`) + separate **thinking-effort**
dropdown for variants; brand SVG mask icons (claude/openai/grok); filter when
>10 items; grouping + separators.

| Aspect | Status | Action |
|---|---|---|
| Family + variant split | ✅ | Devin's two-dropdown (family + thinking) is a reasonable, arguably clearer, mapping of Copilot's model+config split. Keep. |
| Provider icons | ✅ | Keep (nice touch). |
| Hover cost card | 🟡 | Optional: on model-button hover, show a small card with model name + `usage.cost` if known. Low value without per-model pricing from ACP. |
| Picker chrome | 🟡 | Align dropdown-button padding/height/chevron to `.chat-input-picker-item` tokens. |

### 5.6 Attachments

VS Code: `.chat-attached-context-attachment` pills, `height:18px`, `1px
requestBorder`, `radius:4px`, `show-file-icons`, image thumbnails
(`.chat-attached-context-pill-image` 13×13), **implicit context pill** (current
file, dashed when disabled), hover popups, arrow-key nav, Delete-to-remove.

Devin: `.chip` pills (`1px panel-border`, `radius:4px`, `badge-background`),
generic codicon per type (file/media/selection), remove `×`. No implicit-context
pill, no image thumbnail, no keyboard nav.

| Aspect | Status | Action |
|---|---|---|
| Pill chrome | 🟡 | Recolour border to `requestBorder`, height `18px`, `font-size:11px` to match. |
| File-type icons | 🟡 | Use `show-file-icons` style (per-extension icon) instead of a generic file glyph. |
| Image thumbnail | ❌ | Render a 13×13 thumbnail for image attachments (we already carry base64). |
| Implicit context (active file) pill | ❌ | Add an auto "current file" pill (dashed when off) mirroring `chat.implicitContext` — host already knows the active editor. High value; users expect it. |
| Keyboard nav / Delete | ❌ | Arrow between pills + Delete to remove. Low priority. |

### 5.7 Add-context autocomplete (`@` / `/` / `#`)

VS Code: Monaco completions for `/` (slash), `@` (agents), `#` (variables:
files, selection, symbols, `#session`).

Devin: custom dropdown — `/` slash from `available_commands`, `@` file search
via host `queryFiles`. No `#` variables, no symbol/selection tokens.

| Aspect | Status | Action |
|---|---|---|
| `/` and `@files` | ✅ | Works well. Keep. |
| `#` variables (symbols, selection) | 🟡 | Optional: add `#` for symbol/selection references if we want the full token set. `@` already covers files. Low priority. |
| Autocomplete chrome | ✅ | `.ac-item` styling is close to VS Code's suggest rows. Keep. |

### 5.8 Context-usage ring

VS Code: `.chat-context-usage-widget` — SVG `.circular-progress` (36-viewBox),
`.progress-arc` `icon-foreground` (warning/error thresholds), `%` label that
**expands on hover** (`max-width 0→4em; opacity 0.1s ease-out`), click for
details.

Devin: `.usage-ring` — inline SVG ring (18-viewBox), red past 85%, `%` always
shown, click opens `.usage-popup` (context %, token bar, cost).

| Aspect | Status | Action |
|---|---|---|
| Ring + click details | ✅ | Devin's popup is richer (adds cost). Keep. |
| % label reveal | 🟡 | Optional: hide the `%` at rest and expand on hover like VS Code (currently `cmp-sm` hides it responsively — different behaviour). |
| Warning/error colours | 🟡 | VS Code uses `editorWarning`/`editorError`; Devin uses `charts-red` at 85%. Add an amber warning tier (e.g. warning at 75%, error at 90%) with the editor colours. |

### 5.9 Followups / tips / goal / artifacts banners

| Item | VS Code | Devin | Status | Action |
|---|---|---|---|---|
| Followup chips | `.interactive-input-followups` | none | 🚫 | ACP emits no followups. Skip (§2.4). |
| Getting-started tips (`chat.tips.enabled`) | rotating tip above input | none | ❌ | Low value; optional later. |
| Goal / artifacts banners | Copilot-specific | none | ➖ | Skip. |
| Todo widget above input | docked `.chat-todo-list-widget` | plan renders **inline** in transcript | 🟡 | See §6.12 — decide whether to dock the plan above the composer. |

---

## 6. Content parts (the response body)

### 6.1 Markdown / text

VS Code: `.chat-markdown-part.rendered-markdown`, body-m, `p` margin `0 0 16px`,
h1/h2/h3 = xxl/xl/l @600 `margin:1.5em 0 0.875em`, KaTeX math
(`chat.math.enabled`), inline-code chip with `textPreformat` tokens.

Devin: `.bubble` via markdown-it + highlight.js, `p` margin `0 0 8px`, headings
mapped to the same ramp `margin:1.5em 0 0.5em`, inline code chip present.

| Aspect | Status | Action |
|---|---|---|
| Heading scale | ✅ | Matches ramp. Keep. |
| Paragraph margin | 🟡 | Bump `.bubble p` to `16px` (VS Code) — currently `8px`; and heading bottom margin to `0.875em`. |
| Math (KaTeX) | ❌ | Optional; only if Devin emits LaTeX. Low priority. |
| Inline code chip | ✅ | Close. Keep. |

### 6.2 Code block + toolbar

VS Code: `.interactive-result-code-block` = a **live Monaco editor** with
`radius:medium`, hover toolbar (`.monaco-toolbar` `top:-15px`, `height:26px`,
`1px requestBorder`), vulnerability UI, compare/diff header.

Devin: `.bubble pre.code-block.hljs` + `.code-toolbar` (Copy / Insert / Apply /
Run-in-terminal), `radius:medium`.

| Aspect | Status | Action |
|---|---|---|
| Frame (border/radius/hover toolbar) | 🟡 | Toolbar reveal + radius are close. Add `1px requestBorder` around the toolbar buttons' container and match `top` offset. Devin actually exceeds VS Code on actions (Insert/Apply/Run). Keep those. |
| Live editor internals | 🚫/accepted | Cannot embed Monaco; hljs is the pragmatic match. Keep. |
| Copy animation | 🟡 | Use the two-icon cross-fade (as §4.4) instead of className swap. |

### 6.3 Thinking / chain-of-thought

VS Code: `.chat-thinking-box` with shimmer header
(`chat-thinking-shimmer 2s`), a **grid-animated** collapse, a chain-of-thought
spine (`::before` dashed connector, curved header `::after`), and
**`chat.agent.thinkingStyle`** = collapsed / collapsedPreview / **fixedScrolling**
(streaming peek with top/bottom fade masks, `max-height:200px`, `180ms
cubic-bezier(0.2,0,0,1)`), plus generated step titles.

Devin: `.thinking` `<details>` with shimmer label, timeline spine
(`.thinking-item::before` masked connector, curved `.thinking-body::before`),
per-step nodes, "Thinking… Ns" / "Thought for Ns" label.

| Aspect | Status | Action |
|---|---|---|
| Shimmer + spine + nodes | ✅ | Genuinely close (same recipe). Keep. |
| Collapse animation | 🟡 | `<details>` toggles instantly. Replace with the **grid `1fr↔0fr` collapse** (`180ms/140ms cubic-bezier(0.2,0,0,1)`) so expand/collapse is animated like VS Code. |
| Chevron reveal | 🟡 | VS Code chevron `opacity 100ms + transform 180ms cubic-bezier(0.2,0,0,1)` rotate 0→90; Devin uses `0.12s ease`. Align curve/timing. |
| fixedScrolling peek | ❌ | Optional (`chat.agent.thinkingStyle`): while streaming, show only the last ~200px with top/bottom fade masks. Nice-to-have. |
| Generated titles | 🚫 | ACP has no thinking titles. Skip. |

### 6.4 Tool invocation

VS Code: `.chat-tool-invocation-part`, status icon logic (loading→check /
error / circleSlash), verb + dimmed detail, expandable, plus specialised
sub-parts (terminal, confirmation, streaming, output-markdown, result-list).

Devin: `.tool` `<details>` — chevron + kind icon + verb/detail label + status
icon; body renders Input / Result / Terminal / diff+location file pills; status
class drives icon; completed tools show no icon (matches VS Code).

| Aspect | Status | Action |
|---|---|---|
| Verb + dimmed detail | ✅ | Matches (`.tool-verb` + `.tool-detail`). Keep. |
| Status icon behaviour | ✅ | Loading/failed shown, completed hidden — matches. Keep. |
| Collapse animation | 🟡 | Same `<details>` snap issue — move to grid collapse for parity. |
| Box recipe | 🟡 | VS Code tool rows are borderless text (matches), but inside thinking they get `padding:4px 12px 4px 18px`; align paddings. |
| `.show-checkmarks` swap | 🟡 | VS Code swaps spinner→check on completion within a step context. Devin's per-tool status already does this; extend to plan/progress rows. |

### 6.5 Tool risk badge — 🚫

VS Code `tool-risk-badge` (green/orange/red, `chat.tools.riskAssessment.*`).
ACP has no risk level (§2.1). **Leave a styled but empty slot** in the
confirmation widget; do not fabricate.

### 6.6 Terminal tool

VS Code: `.chat-terminal-content-part` — titled command block, **xterm**
output, collapsible `max-height:300px`, decorations (success/error), auto-expand
on failure.

Devin: terminal shown as a `.tool-pre.terminal-pre` inside the tool body, live
output streamed from the host, auto-open when present.

| Aspect | Status | Action |
|---|---|---|
| Live output | ✅ | Works. Keep. |
| Title/command block | 🟡 | Wrap the output in a titled `.chat-terminal-content-title` (command + status) with the `1px requestBorder` frame and bottom-rounded output box for visual parity. |
| xterm rendering | accepted | A styled `<pre>` is the pragmatic match. Keep. |
| Auto-expand-on-failure | 🟡 | Optional: auto-open failed terminal tools. |

### 6.7 Code-block edit pill (+N/-M, progress fill)

VS Code: `.chat-codeblock-pill-container` — `.status-icon` + `.status-label` +
pill (`show-file-icons`, `1px requestBorder`, `radius:4px`), **`.progress-fill`
sweep** (`width 0.2s ease-out`), `.label-added`/`.label-removed`
(lines colours), `.label-detail` italic.

Devin: `.edit-pill` = check icon + `filePill` (file icon, name, `+added`
`-removed` in the lines colours). No progress fill, no label-detail.

| Aspect | Status | Action |
|---|---|---|
| +/- counts + colours | ✅ | Matches (`--vscode-chat-linesAdded/RemovedForeground`). Keep. |
| File-type icon | 🟡 | Use `show-file-icons` per-extension icon. |
| Progress-fill sweep | ❌ | Optional cosmetic: animate a `.progress-fill` while a file is being written (host knows write start/end). Nice polish. |
| Status label | 🟡 | Add a text status ("Edited"/"Created") next to the icon like VS Code's `.status-label`. |

### 6.8 Inline anchor / file chip

VS Code: `.chat-inline-anchor-widget.show-file-icons` — `0.5px requestBorder`,
`radius:4px`, `padding:1px 3px`, `.label-suffix` peek colour; **link-style
variant** (`chat.inlineReferences.style`).

Devin: `.anchor-chip` — `1px border`, `radius:sm`, file glyph + text; applied to
non-URL links in prose (`enhanceAnchors`).

| Aspect | Status | Action |
|---|---|---|
| Bordered chip | ✅ | Close. Match border to `0.5px` and add `show-file-icons`. |
| link-style variant | 🟡 | Optional: honour a `devin.inlineReferences.style` = box/link. Low priority. |

### 6.9 Used references / used-context

VS Code: `.chat-used-context` collapsible with a `monaco-list`, action bar,
warning icons, `1px requestBorder; radius:4px`.

Devin: `.used-refs` `<details>` "Used N references", file pills in the body,
inserted at top of a turn's response.

| Aspect | Status | Action |
|---|---|---|
| Collapsible + list | ✅ | Good. Keep. |
| Collapse animation | 🟡 | Grid-animate (same as §6.3). |
| Frame | 🟡 | Optional: wrap in the `1px requestBorder; radius:4px` box for exact match. |

### 6.10 Confirmation widget (permissions / elicitation URL / edit-discard)

VS Code widget2: `1px requestBorder; radius:medium; margin-bottom:8px`; title
row (`border-bottom`, `heading3` `semiBold`, toolbar), message
(`requestBackground` fill, bottom border), buttons row (`padding:4px 8px;
column-gap:4px`); grid collapse; risk-badge slot; terminal disclaimer;
modified-files list.

Devin: `.cw` — title (`border-bottom`, `weight:600`), `.cw-body`
(`requestBackground` fill, bottom border), `.cw-buttons` right-aligned; used by
permission, elicitation-URL, and edit-discard (with "Don't ask again").

| Aspect | Status | Action |
|---|---|---|
| Structure + tokens | ✅ | Faithfully mirrors widget2. Keep. |
| Title font | 🟡 | Use `heading3` / `semiBold` sizing to match exactly. |
| Collapse animation | 🟡 | Optional grid collapse if the body is long. |
| Risk-badge slot | 🚫 | Leave empty (§2.1). |
| Placement | ✅ | VS Code docks confirmation/question carousels **in the input area**, not the transcript — Devin's tray placement matches. Keep. |

### 6.11 Question carousel (elicitation forms)

VS Code `.chat-question-carousel`: header (title `heading3 semiBold` + close +
collapse toggle + focus-terminal), body = list items with `.selected` indicator
(codicon-check), multi-select checkboxes, `.has-description`, numbered items,
**freeform textarea**, footer (nav arrows, step indicator, Submit, hint),
validation message, summary after submit; `1px input-border; radius:large;
background:panel-background; max-height:min(420px,45vh)`; focus-within →
focusBorder.

Devin `.qc`: header (title + close), body shows one `elicit-field` at a time
(radio/checkbox/text/number/other), footer (prev/next, step, Submit),
validation line, single-question collapses nav; leaves a `.qa-recap` Q/A block
in the transcript after answering.

| Aspect | Status | Action |
|---|---|---|
| One-at-a-time carousel + nav + submit | ✅ | Core matches. Keep. |
| Container tokens | 🟡 | Align to `1px input-border; radius:large; background:panel-background; max-height:min(420px,45vh)`; focus-within → focusBorder. |
| List-item chrome | 🟡 | Style options as VS Code `.chat-question-list-item` (`padding:6px 8px; radius:medium`, selected uses `list-inactiveSelectionBackground`, check indicator). Devin uses raw radios/checkboxes. |
| Freeform textarea | 🟡 | Use a `textarea` for free-text (VS Code `.chat-question-freeform-textarea`) instead of single-line input where the schema is long-form. |
| Q/A recap | ✅ | Nice touch matching VS Code's post-answer summary. Keep. |

### 6.12 Plan / todo list

VS Code `chatTodoListWidget`: a **docked widget above the input**
(`.chat-todo-list-widget.has-todos`, `1px input-border; radius:large … 0 0;
background:editor-background`), expand/collapse with auto-collapse while active,
clear button, status icons (pass green / record blue / circle-outline), scroll
`max-height:6.5*21px`. **Also** a separate `chat-plan-review` widget for Plan
mode.

Devin: `.plan` card **inline in the transcript** (`1px border; radius:large`),
title "Plan", rows with status glyphs (`pass-filled` green / spinner blue /
`circle-large-outline` dim), strikethrough on done. Reused per turn.

| Aspect | Status | Action |
|---|---|---|
| Card + status glyphs | ✅ | Visual recipe matches the todo widget well. Keep. |
| Placement | 🟡 (decision) | VS Code **docks** the live todo list above the composer (persistent, flush on the input). Devin renders it inline per-turn. **Recommended:** dock the *current* plan above the composer (in `#working-set`'s sibling slot) so it persists and squares the input top corners, matching VS Code; keep an inline snapshot in the transcript for history. Medium effort. |
| Auto-collapse | 🟡 | Auto-collapse completed/active plans (expand on demand), like the todo widget. |
| Plan-review widget (Plan mode) | ❌ | VS Code's rich `chat-plan-review` (comments, feedback, approve) has no ACP feed beyond the plan entries + confirmation. Low priority; the plan card + a confirmation covers the observable flow. |

### 6.13 Changes summary / multi-diff / working set

VS Code: `.checkpoint-file-changes-summary` (collapsible `<details>`,
insertions/deletions counts in lines colours, "view changes" icon,
`chat-summary-list`), **turn pills** (`chatTurnPillsPart`), and the docked
`.chat-editing-session` working-set overview (title + line counts + list,
flush on the input, `radius:large … 0 0`).

Devin: `#working-set` card docked above the composer — header ("N changed
files" + Open all / Keep all / Undo all), per-file rows with Keep/Undo, opens
diffs. No per-turn changes pill, no insertions/deletions totals.

| Aspect | Status | Action |
|---|---|---|
| Docked working set with per-file accept/reject | ✅ | Matches the editing-session overview intent; arguably richer (Keep/Undo per file). Keep. |
| Flush on input + squared top | 🟡 | Dock it flush on the composer and square the input's top corners (as VS Code does). |
| Total +/- counts | 🟡 | Add insertions/deletions totals in the header (`linesAdded/Removed` colours) — we already compute per-file `diffStat`. |
| Per-turn changes pill | 🟡 | Optional: a small "N files changed (+x/-y)" pill under each turn linking to the diffs. |

### 6.14 Notification / warning, MCP, PR, extensions

| Part | Status | Action |
|---|---|---|
| `chat-notification-widget` (info/warning) | 🚫 | No ACP warning update; error card covers errors. |
| MCP starting/interaction dim rows | ❌ (possible) | Devin logs `_cognition.ai/*` notifications (`client.ts:126`). If any signal MCP start/interaction, surface them as VS Code's italic-12px `.chat-mcp-servers-message` dim line. Investigate the actual notification names first. |
| PR / extensions-install rows | ➖ | Copilot/GitHub ecosystem. Skip. |
| Subagent content part | ➖/🚫 | Not surfaced by ACP today. Skip. |

### 6.15 Error / quota / sign-in

VS Code: dedicated `chatQuotaExceededPart` / `chatAnonymousRateLimitedPart` with
upgrade/sign-in actions (Copilot entitlements).

Devin: `.error-card` (`tray-card`) heuristically detects logged-out / rate-limit
from the message and offers Log in / Re-check / Retry.

| Status | Action |
|---|---|
| ✅ / ➖ | Devin's heuristic error card is the right fit; the Copilot quota/entitlement widgets are ➖. Keep; align the card to the `1px requestBorder; radius:4px; padding:8px 12px` notification recipe. |

---

## 7. Modes, sessions, editing, checkpoints

### 7.1 Chat modes/types
Devin exposes its own ACP modes (Accept Edits / Ask / Plan / Bypass) — the
correct analogue of Copilot's Ask/Edit/Agent. ✅ No mode-switch confirmation
dialog is needed (Devin switches server-side via `set_config_option`). Keep.

### 7.2 Sessions & history

| Feature | VS Code | Devin | Status | Action |
|---|---|---|---|---|
| Session list | Agent Sessions view + history quickpick | full grouped, searchable list + title-dropdown switcher, rename/delete | ✅ | Devin's is arguably better (workspace grouping, search, inline rename/delete). Keep. |
| New chat / clear | `newChat` | `newSession` + `clear` | ✅ | Keep. |
| Export / import | `chat.export` / `.import` (JSON) | none | ❌ | Optional: export/import a transcript to JSON. Low priority. |
| Transfer across workspaces | `chatTransfer` | none | ➖ | Skip. |
| Restore last on open | `chat.restoreLastPanelSession` | `devin.autoResumeLast` | ✅ | Keep. |

### 7.3 Edit-in-place (`editRequests`)

| Value | VS Code | Devin | Status |
|---|---|---|---|
| inline | click request → edit in place | ✅ implemented (`editable-inline`) | ✅ |
| hover | edit affordance on hover | ✅ (`msg-actions` Edit) | ✅ |
| input | edit reuses the **bottom composer** | ❌ missing | ❌ |
| none | disabled | ✅ | ✅ |

Action: add the **`input`** editRequests mode (route the request text into the
bottom composer with an "editing" banner, submit rewinds via
`revertExecute(headBefore, resendText)`), and add it to `devin.editRequests`
enum. Truncate-on-submit + "Don't ask again" confirmation already match VS Code
(`confirmDiscard`). ✅ for the rest.

### 7.4 Checkpoints / undo / redo / fork

| Feature | VS Code | Devin | Status | Action |
|---|---|---|---|---|
| Restore checkpoint | inline two-state confirm | ✅ `.checkpoint-row` restore + confirm | ✅ | Keep. |
| "Checkpoint Restored" divider | `.checkpoint-restore-container` | ✅ `renderRestoredRow` | ✅ | Keep. |
| Conversational undo | `undoEdits` (Delete key) | via Restore (=undo) | 🟡 | Optional: add an explicit "Undo" icon + `Delete` keybinding mapping to `revertExecute(headBefore)`. |
| Redo | checkpoint forward nav | none | 🚫 | Non-deterministic; ACP has no forward step (§2.2). |
| Fork | `forkConversation` | none | 🚫 | ACP `-32601` (§2.2). |
| Start Over | `startOver` | New Session | ✅ | Equivalent. |

---

## 8. Welcome / empty state

VS Code `.chat-welcome-view`: icon (`chatSparkle`, `40px` / large `72px`) +
title (`13px/600`) + message (markdown, `max-width:280px`, `12px`) + disclaimer
+ tips + **suggested prompts as a bottom-docked wrapping bar**
(`.chat-welcome-view-suggested-prompts`, absolutely positioned, chips
`height:20px; radius:4px; editorWidget-background; 1px requestBorder`).

Devin `.welcome`: Devin logo (48px) + title ("Ask Devin anything", `1.15em/600`)
+ sub (`max-width:320px`) + **vertically stacked** starter chips
(`.welcome-chip`, `radius:6px; 1px panel-border`, left-aligned, full-width).

| Aspect | Status | Action |
|---|---|---|
| Icon + title + sub | ✅ | Close. Optionally size the title to exactly `13px` and message to `12px`. |
| Disclaimer / tips | ➖ | Copilot legal/tips; skip (or a one-line Devin note). |
| Prompt chips | 🟡 | Cosmetic choice: VS Code uses a **bottom wrapping bar** of small chips; Devin uses a vertical stack. Either reads fine; if strict parity is wanted, switch to the wrapping bar with `height:20px; radius:4px; border:1px requestBorder; background:editorWidget-background`. |

---

## 9. Animation & motion catalogue (parity checklist)

VS Code's dominant easing is **`cubic-bezier(0.2, 0, 0, 1)`** with durations
clustering at 100/120/140/160/180/350ms and loops at 1–3s. Devin currently uses
`ease`/`ease-out` and a couple of custom loops.

| Motion | VS Code | Devin now | Action |
|---|---|---|---|
| Collapse/expand (thinking, tools, used-refs, confirmations) | grid `1fr↔0fr`, `180ms cubic-bezier(0.2,0,0,1)` + `opacity 140ms` | native `<details>` snap (no animation) | **Replace `<details>` toggles with the grid collapse** — the single biggest motion gap. |
| Input working border | 2-layer comet, dynamic 1.4–2.5s | 1-layer sweep, fixed 1.5s | Rebuild (§5.2). |
| Copy → check | two-icon cross-fade `140ms cubic-bezier(0.2,0,0,1)` | className swap | Cross-fade (§4.4). |
| Chevron rotate | `opacity 100ms + transform 180ms cubic-bezier(0.2,0,0,1)` | `transform 0.12s ease` | Align curve/timing. |
| Streaming block entrance | 6 variants (fade/rise/blur/scale/slide/reveal), 600ms stagger, `cubic-bezier(0,0,0.2,1)` | single `dv-appear` 140ms `ease-out` | Optional: add rise/fade at 600ms with `cubic-bezier(0,0,0.2,1)`; keep it subtle. |
| Shimmer | `chat-thinking-shimmer 2s linear`, `descriptionForeground → thinkingShimmer`, `background-size:400%` | `dv-thinking-shimmer 2s linear`, same gradient/size | ✅ Matches. Keep. |
| Timing flip | `160ms ease` relative↔absolute | static | Optional (§4.5). |
| Reduced motion | `@media reduce` + `.monaco-reduce-motion` + opt-in `.monaco-enable-motion` | `@media reduce` on shimmer/appear/border | Extend the reduced-motion guard to the new grid-collapse + comet + cross-fade. |

---

## 10. Execution plan (prioritised, independently shippable)

Ordered by **user-visible impact per unit effort**. Each phase is verifiable in
the jsdom harness (`scripts/webview-harness.js`) + a Playwright preview
screenshot before moving on. Nothing here trusts the old plan's "done" flags —
treat every item as to-verify-then-fix.

> **Status: all six phases shipped (v0.6.23 → v0.6.29).** Each phase was
> verified in the jsdom harness + a Playwright preview screenshot, committed on
> `main`, and installed. Item-level notes and any deferrals are inline below.
> Remaining divergences are the documented boundaries at the end of this
> section (ACP/platform limits), plus the tool-content rendering follow-up
> tracked in §11.
>
> | Phase | Version | Notes |
> |---|---|---|
> | A — motion foundation | 0.6.23 / 0.6.24 | grid collapse, comet border, easings, copy cross-fade, footer model+time, used-refs frame |
> | B — composer polish | 0.6.25 | send/stop icons, attachment pills + image thumbs + implicit "current file" pill, picker chrome, usage-ring tiers |
> | C — content-part fidelity | 0.6.26 | markdown margins, edit-pill icon+status, framed terminal, question-carousel list rows + freeform, confirmation title, inline-anchor 0.5px, `inlineReferences.style` |
> | D — docked widgets | 0.6.27 | docked plan/todo (auto-collapse + inline snapshot), docked working set with +/- totals, squared input top |
> | E — behaviour gaps | 0.6.28 | `editRequests:input` mode, Delete-to-restore keybinding, welcome sizing/chips, `_cognition.ai/*` notification logging |
> | F — polish | 0.6.29 | thinking `fixedScrolling` peek, streaming entrance variants, timestamp relative↔absolute flip |

**Phase A — Motion foundation (highest visual impact). ✅ Shipped v0.6.23–0.6.24.**
- A1. Introduce a shared collapse utility (`grid-template-rows:1fr↔0fr`,
  `180ms/140ms cubic-bezier(0.2,0,0,1)`, reduced-motion gated) and convert
  thinking, tools, used-refs, and long confirmations off native `<details>`
  onto it. (§6.3, §6.4, §6.9, §9)
- A2. Rebuild the input working border as the 2-layer comet: recolour to
  `inputWorkingBorderColor1`, add the blurred glow `::after`, 135→495° spin,
  `opacity 350ms` fade, transparent editor bg while busy, dynamic
  `clamp(1.4s,0.55+0.075*sqrt(width),2.5s)` duration. (§5.2)
- A3. Adopt `cubic-bezier(0.2,0,0,1)` and VS Code timings for chevrons, footer
  reveal (`0.1s ease-in-out`), and the copy→check cross-fade. (§4.4, §9)

**Phase B — Composer polish. ✅ Shipped v0.6.25.**
- B1. Send icon → `codicon-arrow-up` (+0.5px nudge, `120ms` bg transition);
  stop → `codicon-debug-stop`; focus rings on send/stop. (§5.3)
- B2. Attachments: `requestBorder`/`18px`/`11px` pill chrome, per-extension file
  icons, image thumbnails, and the **implicit "current file" pill** (dashed when
  off). (§5.6)
- B3. Pickers: align mode/model dropdown buttons to `.chat-input-picker-item`
  tokens; usage ring amber/error tiers + hover-expand `%`. (§5.4, §5.5, §5.8)

**Phase C — Content-part fidelity. ✅ Shipped v0.6.26.**
- C1. Markdown: `p` margin 16px, heading bottom `0.875em`. (§6.1)
- C2. Edit pill: file-type icon + status label ("Edited"/"Created"); optional
  progress-fill sweep. (§6.7)
- C3. Terminal tool: titled command block + framed, bottom-rounded output box;
  optional auto-expand-on-failure. (§6.6)
- C4. Question carousel: VS Code list-item chrome (`padding:6px 8px;
  radius:medium`, check indicator, `list-inactiveSelectionBackground`),
  freeform `textarea`, container tokens. (§6.11)
- C5. Confirmation widget: `heading3/semiBold` title; keep the (empty) risk-badge
  slot. (§6.10)
- C6. Inline anchor: `0.5px` border + `show-file-icons`. (§6.8)

**Phase D — Docked widgets & changes. ✅ Shipped v0.6.27.**
- D1. Dock the **live plan/todo** above the composer (flush, squared input top)
  with auto-collapse; keep an inline history snapshot. (§6.12)
- D2. Working set: dock flush on the composer, square the input top corners, add
  total +/- counts in the header; optional per-turn changes pill. (§6.13)

**Phase E — Behaviour gaps. ✅ Shipped v0.6.28.**
- E1. Add the `input` value to `devin.editRequests` (edit in the bottom
  composer). (§7.3)
- E2. Explicit "Undo" affordance + `Delete` keybinding → `revertExecute`. (§7.4)
- E3. Welcome: optional bottom-docked suggested-prompt bar; message/title exact
  sizing. (§8)
- E4. Investigate `_cognition.ai/*` notifications for MCP start/interaction dim
  lines; surface if present. (§6.14)

> **Phase E notes.** E2 shipped as the **Delete/Backspace keybinding** on the
> focused request bubble (Enter/Space edits); the standalone Undo icon was
> intentionally omitted because with checkpoints enabled (the default) VS Code
> itself shows **Restore**, which the checkpoint row already provides. E4 shipped
> as **notification logging only** — surfacing MCP start/interaction rows is
> blocked until we capture the real `_cognition.ai/*` payload shapes.

**Phase F — Nice-to-have / low priority. ✅ Shipped v0.6.29 (3 of 7; rest deferred).**
- ✅ Timing relative↔absolute flip (§4.5); streaming entrance variants
  (`devin.incrementalRendering.animationStyle`, §9); thinking `fixedScrolling`
  peek (`devin.thinking.style`, default fixedScrolling, §6.3).
- ➖ Deferred (data / platform limits): model hover cost card (§5.5 — ACP has
  no per-model metadata/pricing), `#` variable completions (§5.7 — redundant
  with `@`, no symbol provider in a webview), export/import sessions (§7.2 —
  Devin persists sessions server-side), KaTeX math (§6.1 — heavy dependency for
  output Devin does not emit).

**Explicitly not doing (documented boundaries):**
- 🚫 Tool risk badge (no ACP risk), redo & fork (`-32601` / non-deterministic),
  standalone warning part, generated thinking titles.
- ➖ Thumbs/Report-Issue telemetry, Copilot quota/entitlement/sign-in flows,
  PR/extensions/subagent parts, followup chips, Monaco input editor, live-Monaco
  code blocks.

---

## 11. Follow-up: tool-content rendering (running commands, questions)

Phases A–F made the **chrome** match VS Code, but the **inside** of a tool card
is still low-fidelity: the tool body renders `rawInput` as a raw JSON `<pre>`
("Input") and results as a plain `<pre>`. Copilot instead renders each tool
**kind** with a purpose-built view — a terminal command block for a run, a file
pill for a read, a diff for an edit — and never shows the argument JSON.

Plan:
- Replace the generic "Input: {json}" section with **kind-aware** rendering:
  - `execute` → a shell **command block** (extract `command`/`cmd`/`script`/`args`)
    ahead of the (already framed) terminal/text output; not JSON.
  - `read` / `edit` / `move` / `delete` → suppress the JSON (the title + file
    pill + diff already convey it).
  - `search` → a one-line "Search: {query/pattern}"; `fetch` → the URL.
  - unknown / MCP tools → keep the JSON, but as a collapsed **"Raw input"**
    fallback rather than the primary content.
- Confirm the exact `rawInput` key names against a real Devin session (the tool
  arg shapes are agent-specific), and handle common aliases.

This is tracked separately from the six styling phases because it needs real
ACP tool payloads to get the field extraction exactly right.

### Status (shipped)

Kind-aware bodies (execute/read/edit/search/fetch) shipped earlier. The tool
identity was then probed against a live `devin acp` (see the harness idea in
`scripts/preview.js` and the `tools` scenario) and the real discriminators live
in `_meta`, not the coarse ACP `kind`:

- Web search: `kind:"fetch"`, `_meta["cognition.ai/inferenceToolName"]="web_search"`,
  `rawInput.query`. The result is a text summary ("Found N result(s)…"), and there
  are **no** structured per-result blocks in the stream, so we render the query as
  a Search line plus a dim caption.
- Web fetch: `kind:"fetch"`, `inferenceToolName="webfetch"`, `rawInput.url`. The
  result reads "Fetched N characters…", and the URL renders as a clickable link
  plus a caption.
- MCP tool call: `_meta["cognition.ai/eventType"]="mcp_tool_call"`,
  `toolName="mcp__<server>__<tool>"`, `rawInput` holds the tool args, and the
  result is usually a JSON string. Rendered with a plug icon, an **Arguments**
  section, and a pretty-printed, highlighted **Result** (it falls back to text
  when the payload is not JSON). `mcp_list_tools` (`inferenceToolName`) is treated
  the same way.

The host now forwards these `_meta` fields (`toolMeta` in `chatViewProvider.ts`),
and the webview classifies via `toolInfo` (`webview/main.js`).

Also shipped alongside:
- **Grouped tool disclosure**: a run of consecutive tool cards collapses under a
  single "Used N tools" header (broken by any non-tool response content).
- **Mermaid diagrams**: ```` ```mermaid ```` fences render as SVG once the turn
  settles, via a lazily-injected `dist/mermaid.js` bundle (kept out of the main
  bundle, and only fetched when a diagram first appears).

---

## Appendix A — `--vscode-chat-*` colour reference (from `chatColors.ts`)

| Colour id | dark | light | Meaning / where |
|---|---|---|---|
| `chat.requestBorder` | rgba(255,255,255,.10) | rgba(0,0,0,.10) | universal border/divider (cards, tables, connectors, dividers) |
| `chat.requestBackground` | editorBackground @62% | editorBackground @62% | request/confirmation body fill |
| `chat.requestBubbleBackground` | editorSelection @30% | editorSelection @30% | user request bubble |
| `chat.requestBubbleHoverBackground` | editorSelection @60% | editorSelection @60% | request bubble hover |
| `chat.requestCodeBorder` | #004972B8 | #0e639c40 | code block border inside a request bubble |
| `chat.avatarBackground` / `avatarForeground` | #1f1f1f / fg | #f2f2f2 / fg | avatar disc (unused — header hidden) |
| `chat.editedFileForeground` | #E2C08D | #895503 | edited file name |
| `chat.checkpointSeparator` | #585858 | #a9a9a9 | checkpoint / restored divider line |
| `chat.linesAddedForeground` | #54B054 | #107C10 | +N counts |
| `chat.linesRemovedForeground` | #FC6A6A | #BC2F32 | -M counts |
| `chat.thinkingShimmer` | #ffffff | #000000 | shimmer highlight |
| `chat.inputWorkingBorderColor1` | buttonBackground | buttonBackground | working comet border (use this!) |
| `chat.inputWorkingBorderColor2/3` | derived | derived | registered but unused by the border |
| `chat.dictationActiveMicGlow` | #58A6FF | #2E8BE6 | dictation glow (➖ no voice) |

## Appendix C — Revert node ids and conversation flow (edit / retry / restore)

Devin's revert is node-id based (`_cognition.ai/revert/{preview,execute}`, target =
an "expanded chain" node id). VS Code instead removes by request id and lets the
agent host revert files via checkpoints. Two hard constraints were established by
probing a live `devin acp` (see `scripts/acp-probe.js` and the throwaway probes):

- **Node ids survive across processes.** A head captured in one `devin acp`
  process is still valid after a fresh process does `session/load` (verified:
  h1=27 valid in a second process, currentHead matched).
- **BUT a session/load re-expands the conversation on the next prompt, orphaning
  every pre-load node id.** After load (head 27), sending one turn jumped the head
  to 64 and `revert(27)` then failed with `Invalid params: target node 27 is not
  on the expanded chain from head 64`. Turns sent *after* the re-expansion are
  revertable among themselves (64 stays valid after 67). There is no API to
  enumerate the conversation nodes, and no way to force re-expansion without
  adding a turn.

Consequences (implemented):

- A revert target is trusted only when it is a **reliable** head, i.e. captured
  live on the current expansion: a live turn completion, or an instant restore
  (no reload). The head read right after a `session/load` is marked unreliable.
  `postTurnHead(reliable)` on the host; `lastHeadReliable` / `headBeforeReliable`
  in the webview; `turnRevertable()` gates edit / retry / restore.
- Therefore **historical (replayed) turns and the first turn sent after a reload
  are not revertable** (their "before" node is orphaned by re-expansion). Editing
  old messages after a window reload is not possible with the current ACP. The
  earlier "persist per-turn heads and rehydrate on reload" approach was removed:
  those persisted ids are orphaned the moment the reloaded session is prompted.
- **Retry** only regenerates in place (rewind + rerun) and is shown only on the
  last response, and only when that turn is revertable. It never falls back to
  re-sending the message as a new prompt (that produced a surprising duplicate).

## Appendix B — Source anchors

- Devin: `webview/main.js`, `media/main.css`, `media/webview-body.html`,
  `webview/markdown.js`, `src/chat/chatViewProvider.ts`, `src/acp/{client,types}.ts`,
  `package.json` (`contributes.configuration`).
- VS Code (`~/VSCode/vscode/src/vs/workbench/contrib/chat/`):
  `browser/widget/chatListRenderer.ts`, `browser/widget/chatWidget.ts`,
  `browser/widget/input/chatInputPart.ts`,
  `browser/widget/chatContentParts/**`, `browser/widget/media/chat.css`,
  `browser/widget/media/chatViewWelcome.css`, `common/widget/chatColors.ts`,
  `common/constants.ts`, `browser/chat.shared.contribution.ts`.
