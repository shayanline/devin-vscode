# 01, Chat UI affordances (message rendering)

This is the richest gap area. In Copilot these are almost all **native VS Code
chat widget** behaviours driven by typed response parts (see the proposed API
`ChatResponseStream` parts: markdown, thinking, tool invocation, confirmation,
question carousel, multi diff, anchor, reference, warning, progress, code
citation, follow ups). We render our own webview, so we must build each one.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Streaming assistant text | Native, markdown streamed | Streamed, rendered with markdown-it (HTML disabled) | ✅ | Implemented: `markdown-it` bundled into the webview with `html:false`, `linkify`, `breaks`. Full markdown (lists, headings, tables, links, blockquotes, nested). See `webview/markdown.js`. |
| Reasoning / "thinking" display | Native collapsible section, collapsed by default with a summary label, expandable | Collapsible `<details>` block, collapsed by default, "Thought for Xs" summary + chevron | ✅ | Implemented in `webview/main.js` (`appendThought`/`finalizeThinking`): thoughts stream into a collapsed block that shows "Thinking…" then "Thought for Xs", markdown rendered. Still respects `devin.showThinking` (gated in the extension host). |
| Tool call rows | Native row with icon + label, **expandable to show inputs/outputs/results**, file widget for read, expandable URI list for search | Static status pill with a title only; no inputs, no outputs, no expansion | ❌ | User called this out. ACP `tool_call`/`tool_call_update` carry `rawInput`, `content`, `locations`, `kind`. Render an expandable card showing kind, args, and result content. |
| Tool call status (pending/running/done/failed/cancelled) | Native, animated | We map status to a dot/icon colour | 🟡 | Add a spinner for in_progress and clearer failed/cancelled states. |
| Terminal tool output | Native: live terminal render inside the chat with output streaming | Not surfaced (we set ACP `terminal:false`) | ❌ | Enable the ACP `terminal` capability and render command + streamed output in an expandable block. |
| Code blocks: syntax highlight | Native, full theme aware highlighting | `highlight.js` (common languages) themed to VS Code chart colours | ✅ | Implemented: `highlight.js/lib/common` in `webview/markdown.js`; `.hljs-*` classes mapped to `--vscode-charts-*` in `media/main.css` so it follows the active theme. |
| Code block toolbar: Copy | Native | ❌ | ❌ | Add a hover toolbar on code blocks. |
| Code block toolbar: Insert at cursor | Native | ❌ | ❌ | Insert into active editor. |
| Code block toolbar: Apply to file (smart apply) | Native (mapped edits) | ❌ | ❌ | Apply a suggested block into the target file. Devin usually edits directly via tools, so this is mainly for fenced suggestions in Ask mode. |
| Code block: "Create file" / "Run in terminal" | Native (for shell blocks) | ❌ | ❌ | Contextual action for shell code blocks. |
| Inline file/symbol anchors in responses | Native `ChatResponseAnchorPart`, clickable, hover preview | File change links only | 🟡 | Make file references in assistant text clickable (open file at range). |
| "Used references" / context transparency | Native collapsible "Used N references" list | Not shown | ❌ | Show which files/context were sent, collapsible. ACP does not always surface this; may need our own tracking of attachments + tool reads. |
| Confirmation prompts | Native `ChatResponseConfirmationPart` with buttons | We render permission requests as buttons (tray) | ✅ | Parity for the common case (permission approve/deny). |
| Question with options (elicitation) | Native question carousel / elicitation form | We render enum as buttons and general schema as a small form | ✅ | Good parity. Could polish multi field forms. |
| Follow up suggestions | Native suggested follow up chips after a turn | ❌ | ❌ | ACP does not send follow ups; would need us to derive them or a heuristic. Lower priority. |
| Progress messages | Native `ChatResponseProgressPart` ("Searching...", "Reading X") | We show a "Working..." status only | 🟡 | Render step progress inline from tool activity. |
| Warnings in stream | Native `ChatResponseWarningPart` | ❌ | ❌ | Render agent/tool warnings distinctly. |
| Multi file diff summary in response | Native `ChatResponseMultiDiffPart` (open a multi diff editor) | We list changed files in a working set | 🟡 | Add "open all changes" as a multi diff. |
| Code citations / license notices | Native `ChatResponseCodeCitationPart` | ➖ | ➖ | Copilot specific public code matching. N/A for Devin. |
| Message actions: Copy response | Native | ❌ | ❌ | Add per message copy. |
| Message actions: thumbs up/down feedback | Native, wired to telemetry | ❌ | ➖/❌ | We have no feedback backend; could no op or drop. Low priority. |
| Message actions: edit a previous request and resend | Native (edit request, re run) | ❌ | ❌ | Valuable. Allow editing the last user message and re prompting. |
| Message actions: retry / regenerate | Native | ❌ | ❌ | Re run the last turn. |
| Cancel / stop mid turn | Native stop button | ✅ (Stop button, ACP `session/cancel`) | ✅ | Parity. |
| Request/response separation, turn grouping | Native, clean turn cards | Role label + bubble per message | 🟡 | Visual polish: group a user turn with its assistant turn, timestamps, hover actions. |
| Empty state / welcome | Native `chatViewsWelcome` + walkthrough, greeting with example prompts | Sessions list has an empty state; no per chat welcome/greeting | 🟡 | Add a new chat welcome (title, one liner, a few starter prompts). |
| Error rendering (auth expired, rate limit, offline) | Native `chatViewsWelcome` states with actions (sign in, upgrade, retry) | Generic error bubble | 🟡 | Detect common ACP errors (not logged in, rate limited) and show actionable UI. |
| Accessibility (screen reader, audio cues, ARIA) | Native, extensive (VS Code chat is a11y audited) | Minimal | ❌ | Custom webview means we own a11y: ARIA roles, live regions for streaming, focus management, keyboard nav of messages. |
| Localisation | Native, `package.nls.json` (many locales) | English only | ❌ | Externalise strings if localisation is wanted. |
| Usage / cost indicator | Native `ChatResultUsage` (tokens, cost) | We receive `usage_update` and show a "% context" in status | 🟡 | Show tokens used/size and cost per turn, like Copilot's context bar; add a compaction action. |

## Notable specifics the user asked about

- **Collapse the agent's thinking**: Copilot yes (collapsible, collapsed by
  default). Devin: no, it is always inline italic. **Gap.**
- **See details of tool calls**: Copilot yes (expandable row with
  inputs/outputs, file widget, URI lists). Devin: no, only a title pill.
  **Gap, high value.**
