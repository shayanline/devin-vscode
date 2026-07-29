# 02, Sessions and navigation

Copilot's chat session model is powered by the native chat widget plus a
`chatSessionsProvider` (used for its Copilot CLI, Claude, and Cloud agent
session types). The everyday "local" chat history is a native workbench feature
(history picker, restore). We rebuilt a sessions list ourselves in the webview.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Persistent session list across restarts | Native history + session providers persist | `workspaceState` ids + title cache + `devin list`; persists | ✅ | Parity. |
| Sessions as the default landing view | Native shows last chat; history via picker | Sessions list is the default body | ✅ | We match the user's requested behaviour. |
| Always visible composer; send from list starts new | Native input always present | Composer always docked; sending from list starts a new session | ✅ | Matches the requested behaviour. |
| Open a session | Native | Click a row loads it (ACP `session/load`, replays history) | ✅ | Parity. |
| Back to list | Native history icon | History icon toggles to list | ✅ | Parity. |
| New chat | Native `+` | `+` in header, and from list | ✅ | Parity. |
| Rename session | Native (session providers expose rename) | Rename via `_cognition.ai/session/rename`, hover action + input box | ✅ | Parity. |
| Delete session | Native | Delete via `session/delete`, hover action + modal confirm | ✅ | Parity. |
| Group sessions | Copilot groups CLI/cloud sessions by repo/worktree in a dedicated Sessions window | Grouped by repository folder in multi root | ✅ | Parity for our scope. |
| Per workspace scoping | Native | `workspaceState` + directory union, `devin.sessionScope` | ✅ | Parity; arguably better isolation. |
| Session search / filter | Native quick pick fuzzy filter | ❌ | ❌ | Add a filter box atop the sessions list. |
| Timestamps / last activity | Native | `last_activity_ago` shown | ✅ | Parity. |
| Multi root awareness | Native | folders passed as `additionalDirectories`; grouped | ✅ | Parity. |
| Auto resume last session | Native "continue" | `devin.autoResumeLast` (default off) | ✅ | Parity. |
| Fork a session | Copilot CLI has `forkSessions` (preview) | ❌ | ❌ | Devin CLI has `/fork`; could expose. Medium. |
| Session in its own editor tab / to the side | Copilot `newSessionToSide`, open worktree in new window | ❌ | 🟡 | We are a sidebar webview only. Could add "open chat in editor area". |
| Export a session (markdown/json) | Native + Copilot debug export | ❌ | ❌ | The old community extension had markdown export; easy win. |
| Delete all / clear history | Native | ❌ (only per session) | 🟡 | Add clear all. |
| Worktree / branch session management | Extensive (Copilot CLI: open worktree, commit, PR, sync) | ➖ | ➖ | Tied to Copilot's cloud/CLI worktree model. Devin CLI has isolation options; revisit later, mostly out of scope. |
| Cloud / background agent sessions | Native (delegate to GitHub cloud agent) | ➖ | ➖ | Copilot specific cloud. Devin has cloud sessions via `/cloud-sessions`; not in our extension. Out of scope for now. |
