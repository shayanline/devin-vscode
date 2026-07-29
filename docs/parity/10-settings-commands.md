# 10, Settings, commands, keybindings, menus, status

Numbers: Copilot Chat contributes ~134 commands, ~159 settings across 4
configuration sections, keybindings, 38 menu groups, a walkthrough, icons, and
an icon font. Devin contributes 10 commands, 8 settings, 4 menu groups, 1 view.
Most of Copilot's surface is for features we do not have (completions, review,
cloud/CLI agents, debug tooling), so raw counts are not the goal; the relevant
control surfaces are below.

| Surface | Copilot Chat | Devin (current) | Status | Notes |
|---|---|---|---|---|
| Command palette entries for core chat actions | Many (new chat, focus, attach file/selection, etc.) | New session, show sessions, open chat, cancel, run setup | 🟡 | Add: attach file, attach selection, export session, clear history, review changes, open logs. |
| Keybindings | A few (terminal add ref, rerun with debug, NES capture) | None | 🟡 | Add sensible defaults: focus chat, new chat, and an editor "Ask Devin about selection". |
| Editor context menu integration | Yes (Explain/Fix/Review) | None | ❌ | See `09`. High value. |
| SCM integration (commit message, changes group) | Commit message sparkle + review | "Devin Changes" SCM group + accept/reject | 🟡 | We have the changes group; add commit message generation. |
| Terminal integration | Explain last command, quick fixes | None | 🟡 | See `09`. |
| Status bar item | Yes (rich menu) | Yes (model/mode/connection, opens chat) | 🟡 | Add a small dropdown menu. |
| Settings: transport/CLI | n/a | `cliPath`, `extraArgs`, `env` | ✅ | Devin specific, good. |
| Settings: defaults | Model, mode, many | `defaultModel`, `defaultMode` | ✅ | Parity for our scope. |
| Settings: sessions | Native | `sessionScope`, `autoResumeLast` | ✅ | Devin specific. |
| Settings: behaviour toggles | ~159 | `showThinking` | 🟡 | Add as features land (e.g. auto attach current file, reveal edits, terminal capability). |
| Icons / icon font | Custom + codicons | Codicons bundled | ✅ | Parity (we use codicons). |
| Walkthrough (getting started) | Yes | Setup panel only | 🟡 | Optional. |
| Localisation (`package.nls.json`) | Yes, many locales | No | ❌ | Optional. |
| Telemetry / experimentation | Extensive | None | ➖ | Out of scope. |

## Our current commands (for reference)

`devin.newSession`, `devin.showSessions`, `devin.focusChat`, `devin.cancel`,
`devin.runSetup`, `devin.acceptChange`, `devin.rejectChange`,
`devin.acceptAllChanges`, `devin.rejectAllChanges`, `devin.openChangeDiff`.

## Our current settings (for reference)

`devin.cliPath`, `devin.defaultModel`, `devin.defaultMode`,
`devin.sessionScope`, `devin.autoResumeLast`, `devin.showThinking`,
`devin.extraArgs`, `devin.env`.
