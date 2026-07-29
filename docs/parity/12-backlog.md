# 12, Prioritised implementation backlog

A proposal for the implementing agent. Ordered by user visible value per unit
of effort. Each item references the area file with the detail. Effort is a rough
T shirt size (S < 1 day, M 1-3 days, L > 3 days) for a webview + ACP client.

## Tier 1, closes the gaps the user explicitly named

1. **Expandable tool call cards** (`01`, `05`) — M. Replace the static pill with
   a card that shows tool kind, a readable title, `rawInput` (args), and result
   `content`, collapsed by default, expandable. Include a file widget for reads
   and a URI list for searches. This is the biggest visible parity gap.
2. **Collapsible reasoning ("thinking")** (`01`) — S. Wrap thought chunks in a
   collapsible block, collapsed by default, with a "Thought for Xs" summary.
3. **Real markdown + syntax highlighting** (`01`) — M. Replace the mini renderer
   with a proper markdown library plus a themed highlighter. Unlocks lists,
   tables, headings, links, and readable code.
4. **Code block toolbar** (`01`, `04`) — M. Copy, Insert at cursor, and Apply to
   file on hover for fenced code.
5. **Terminal tool output** (`01`, `05`) — M. Enable the ACP `terminal`
   capability and render command + streamed output in an expandable block.

## Tier 2, high value native affordances

6. **Checkpoints / restore to a step** (`04`) — M. Use Devin `/steps`,
   `/revert`, `/fork` to offer "restore to here" on prior turns.
7. **Edit a previous request and resend; retry/regenerate** (`01`) — M.
8. **Richer `#` context types** (`03`) — M. Active editor, open editors,
   problems/diagnostics, terminal last command/selection, git changes, folder,
   codebase. Auto attach current file as a removable pill.
9. **Editor context menu + keybindings** (`09`, `10`) — M. "Ask Devin about
   selection", "Explain", "Fix", each opening the panel with the selection
   attached and a preset prompt; add focus/new chat keybindings.
10. **Multi diff "Review all changes" + reveal edits live** (`04`) — S/M.
11. **New chat welcome / greeting with starter prompts** (`01`) — S.
12. **Actionable error states** (auth expired, rate limited, offline) (`01`) — S.

## Tier 3, surface Devin's own power

13. **MCP status panel** (read only: connected/failed servers + tool counts)
    (`08`) — S/M. Consume `_cognition.ai/mcp/serversChanged` + output logs.
14. **Customization surfacing/scaffolding**: list active rules; "Create skill /
    agent / hook" commands that scaffold `.devin/...`; "Configure Hooks" (`07`)
    — M.
15. **Commit message generation** in the SCM input (`09`) — M.
16. **Review changes** using Devin's review agent / `/review` (`09`) — M.
17. **Session extras**: search/filter, export to markdown, clear all, open chat
    in the editor area, fork (`02`) — M total.
18. **Context / usage meter** with a compact action, near the input (`01`,
    `05`) — S.
19. **Custom modes** mapped to Devin subagent profiles; per mode model (`06`,
    `07`) — M.

## Tier 4, polish and breadth

20. Drag and drop files/images into the composer; image files via attach (`03`)
    — S.
21. Input history recall (Up arrow) (`03`) — S.
22. Follow up suggestions (heuristic) (`01`) — M.
23. Accessibility pass: ARIA roles, live regions for streaming, keyboard nav,
    focus management (`01`) — M. Important if shipping broadly.
24. Localisation scaffolding (`01`, `10`) — M, optional.
25. Status bar dropdown menu (open setup, docs, toggle) (`09`, `10`) — S.
26. Inline chat in the editor (`09`) — L, only if "feels native in the editor"
    becomes a goal.

## Explicitly not on the backlog

See `11-out-of-scope.md`: inline completions/NES, BYOK providers, GitHub cloud
agents, Copilot CLI worktree/PR flows, telemetry/OTel, enterprise policy,
code citations, and the Copilot team's internal debug tooling.

## Suggested sequencing

Do Tier 1 as one milestone (it directly answers the user's feedback and makes
the chat feel complete), then Tier 2. Tiers 3 and 4 can be picked up
opportunistically. Every Tier 1 and 2 item is webview rendering plus existing
ACP data, so no backend/protocol work is required beyond enabling the ACP
terminal capability (item 5) and using the existing `/steps` `/revert` `/fork`
slash commands (item 6).
