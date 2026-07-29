# 04, Editing and diffs

Copilot's Edit and Agent modes use VS Code's native chat editing surface: a
working set, inline diff overlays in the editor, per hunk and per file
accept/reject, checkpoints, and undo. We implemented a QuickDiff + SCM group +
an in chat working set.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Agent edits files directly | Agent mode edits via tools | ACP `fs/write_text_file` (we apply + snapshot) or Devin edits on disk | ✅ | Parity. |
| Working set (list of changed files) | Native working set panel | In chat working set card + SCM "Devin Changes" group | ✅ | Parity in spirit. |
| Per file accept (keep) | Native | "Keep" per file, "Keep all" | ✅ | Parity. |
| Per file reject (undo) | Native (restores original) | "Undo" per file / "Undo all" (restores snapshot, deletes new files) | ✅ | Parity. |
| Per hunk accept/reject | Native inline overlay in the editor | QuickDiffProvider gives the editor gutter "Revert Change" per hunk | 🟡 | We get native per hunk revert (undo) via QuickDiff, but not per hunk **accept** as a distinct action, and no in editor overlay toolbar. Acceptable. |
| Inline diff overlay in the editor while editing | Native (colored insert/delete regions with a floating toolbar) | ❌ (we show a normal diff editor on click) | 🟡 | We open a standard diff (original vs current). No live inline overlay as edits stream. Could add decorations. |
| Auto open the diff as files change | Native reveals edits live | ❌ (user clicks a file to see the diff) | 🟡 | Optionally reveal/scroll to edited files. |
| Checkpoints / restore to a point | Native chat checkpoints (revert workspace + conversation to a prior turn) | ❌ | ❌ | Devin CLI has `/steps`, `/revert`, `/fork`. We could expose "restore to this step" using those. High value, medium effort. |
| Undo last edit / undo all agent edits | Native | 🟡 (Undo all in working set) | 🟡 | Tie to Devin `/revert` for true conversational undo. |
| Move/rename file edits rendered | Native `ChatResponseMovePart` | ❌ | 🟡 | Render renames/moves in the working set. |
| Multi diff "review all changes" editor | Native `ChatResponseMultiDiffPart` | ❌ (per file only) | 🟡 | Add "Review all changes" opening a multi diff. |
| New file creation shown | Native | 🟡 (tracked as a change; undo deletes it) | 🟡 | Mark created vs modified distinctly in the working set. |
| Keep/undo from the editor title bar | Native | ➖ | 🟡 | We expose accept/reject in SCM + chat, not editor title. |
| Notebook edits | Native notebook edit parts | ➖ | ➖ | See editor integrations; low priority. |
| "Apply" a suggested code block (Ask mode) | Native smart apply (mapped edits) | ❌ | ❌ | For fenced suggestions in non agent turns. See `01`. |
