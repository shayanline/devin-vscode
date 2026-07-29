# 09, Editor integrations (beyond the chat panel)

Copilot Chat reaches far outside the chat view: inline chat in the editor,
next edit suggestions, code review, commit message generation, PR descriptions,
terminal helpers, notebooks, semantic search, and more. Devin's extension is
currently a chat panel only. These are the "surrounding" surfaces.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Inline chat in the editor (Cmd/Ctrl+I) | Native inline chat participant | ❌ | ❌ | Would need a separate inline surface driving ACP. Large. High value for "feels native". |
| Quick chat (ephemeral) | Native | ❌ | 🟡 | Lower priority. |
| Editor context menu: Explain / Fix / Review selection | Native `editor/context` entries | ❌ | ❌ | Add "Ask Devin about selection", "Explain", "Fix" that open the panel with the selection attached and a preset prompt. Medium, high value. |
| Inline gutter actions (explain/review on selection) | Native `chat/editor/inlineGutter` | ❌ | 🟡 | Depends on inline chat. |
| Next Edit Suggestions (NES) / inline completions | Native, large subsystem (`nextEditSuggestions.*`) | ➖ | ➖ | Ghost text completions are a different product from agent chat; Devin CLI does not provide a completions endpoint to us. Out of scope. |
| Code review (AI): review changes/selection, review comments UI | Native, extensive (`review.*`, comment threads, apply/discard) | ❌ | 🟡 | Devin has a review agent (`devin acp --agent-type review`) and `/review`. Could add "Review changes" that runs it and posts results. Medium. |
| Generate commit message (SCM input) | Native `git.generateCommitMessage` (sparkle in SCM) | ❌ | 🟡 | Could add an SCM input action that asks Devin to draft a commit message from the diff. Medium, popular. |
| Resolve merge conflicts | Native `git.resolveMergeConflicts` | ❌ | 🟡 | Lower priority. |
| PR description generation | Native | ❌ | ➖ | Lower priority. |
| Terminal: explain last command / "rerun with debug" | Native terminal participant + quick fixes | ❌ | 🟡 | "Explain terminal selection/last command" that opens chat with context. Medium. |
| Terminal quick fixes | Native `terminalQuickFixes` | ❌ | ➖ | Low priority. |
| Notebook chat / edits / follow cell execution | Native notebook participant + tools | ❌ | ➖ | Low priority unless notebook users matter. |
| Semantic / codebase search participant (`@workspace`, `#codebase`) | Native workspace indexing + search | 🟡 | 🟡 | Devin has search tools agent side; we could add a `#codebase` context hint. |
| Search view AI results | Native `searchPanel/aiResults` | ➖ | ➖ | Out of scope. |
| Rename suggestions (AI) | Native | ➖ | ➖ | Out of scope. |
| Test generation / fix failing test | Native (`/tests`, testing menus) | 🟡 (via `/` skills/prompts) | 🟡 | Available through prompting; no dedicated test UI. |
| Setup/scaffold new workspace / new Jupyter notebook | Native tools | 🟡 | 🟡 | Via prompting; no dedicated flow. |
| Dev container config generation | Native | ➖ | ➖ | Out of scope. |
| Alt text generation for images | Native | ➖ | ➖ | Out of scope. |
| Status bar Copilot menu (enable/disable, model, status) | Native status item | 🟡 (our status bar shows model/mode/connection, click opens chat) | 🟡 | Could add a small menu (open setup, toggle, docs). |
| Walkthrough / getting started | Native `walkthroughs` | ❌ | 🟡 | We have a setup panel; a proper walkthrough is optional. |
