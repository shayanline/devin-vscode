# ACP integration contracts

These interfaces were checked against Devin CLI `3000.13.4`, commit `d9a56503ce88`, using ACP protocol version 1. Compatibility with other CLI versions requires a separate check. Recheck them after a CLI upgrade.

Agent capabilities describe operations the agent offers. Client capabilities describe handlers the extension serves. A missing agent echo does not disprove a client service, and a new client declaration must have a handler.

## Workspace prompt history

The extension offers prompt reuse through the `Devin: Show Prompt History` Command Palette action. There is no permanent composer button or default shortcut. Existing composer shortcuts keep their current behavior.

The picker reads the extension's own submitted input journal from `context.workspaceState`. It keeps at most 50 complete prompts per VS Code workspace and offers only entries whose tracked session has the exact requested directory. Directory comparison uses normalized absolute paths, with case folding on Windows. Parent directories, subdirectories and sibling directories are separate scopes.

An active conversation uses its live runtime directory, then its saved session directory if the runtime has exited. A new chat uses the same workspace folder resolver as session creation. The picker identifies that directory. A selection is discarded if its workspace, session, target directory or draft changed while the picker was open.

Only complete input submitted through this extension is recorded. Unsent drafts, pending queued messages, automatic usage reads, attachment contents and replayed ACP resource text are not imported into this journal. Removing or evicting a tracked session also removes its cached input. Oversized prompts are skipped rather than truncated for reuse.

If neither a workspace folder nor a workspace file is open, prompt history is not persisted. The picker can offer only submitted input still held in the current conversation's memory.

History starts building when the corrected extension records submitted inputs. Existing native CLI history cannot be safely migrated because its entries do not establish directory ownership.

### Native CLI history findings

The native CLI history endpoint accepts this request, but the extension does not use it for workspace prompt reuse.

```json
{
  "method": "_cognition.ai/reads/promptHistory",
  "params": {
    "sessionId": "<session id>",
    "currentSessionOnly": false,
    "limit": 50
  }
}
```

The result contains entries with `text` and `isShell`.

```json
{
  "entries": [
    {
      "text": "<prompt text>",
      "isShell": false
    }
  ]
}
```

With `currentSessionOnly: false`, the result includes native CLI input history from other sessions. The fixture returned no entries with `currentSessionOnly: true`, even after ACP prompts, so ACP messages must not be assumed to populate native CLI input history.

Positive limits return a bounded prefix. Omitted and negative limits returned the full available history in the tested build.

Extra `query` and `cursor` fields were accepted but ignored. Server history search and pagination are not established. Search must filter the bounded snapshot locally.

Native history entries have no validated session or directory metadata, so the global result cannot be reliably filtered to a VS Code workspace. These native global entries must not be imported into the extension's input journal or logs.

An unavailable method returns JSON RPC error `-32601`. This is a protocol research finding, not a prerequisite for the extension's local prompt picker.

## Session content search and sorting

`session/list` accepts standard cursor pagination plus namespaced query metadata. The underlying CLI listing is global. The extension filters every result to session ids tracked by this VS Code workspace, checking membership both before the request and after it completes. Filtered searches do not prune membership or overwrite the authoritative session cache. No server cwd filtering is assumed.

```json
{
  "method": "session/list",
  "params": {
    "_meta": {
      "cognition.ai/content": "<search text>",
      "cognition.ai/orderBy": "created_at",
      "cognition.ai/sortDirection": "asc",
      "cognition.ai/limit": 100
    }
  }
}
```

The relevant agent capabilities are in `agentCapabilities._meta`.

```json
{
  "cognition.ai/sessionListContentSearch": true,
  "cognition.ai/sessionListOrderBy": ["updated_at", "created_at"],
  "cognition.ai/sessionListSortDirection": true
}
```

Only send optional fields supported by those agent capabilities. The content filter matched text present in a conversation body but absent from its title. An absent fixture marker returned no sessions.

Both advertised order fields worked with `asc` and `desc`. Equal timestamps had no established tie breaker. Session rows use ISO timestamps in `updatedAt` and `_meta["cognition.ai/createdAt"]`.

The response contains `sessions` and may contain `nextCursor`. Continue with that opaque cursor and the same query metadata on every page. The list is complete only when no next cursor remains. A failed or repeated cursor must not turn a partial result into an authoritative session inventory.

Without `cwd`, the list spans workspaces. When supplied, `cwd` is an exact stored path filter. Different aliases for the same directory did not match.

Filtered display results must remain separate from authoritative session membership. An empty content match must not remove tracked sessions, working directories, drafts, or checkpoints. The extension must retain title and id filtering when server search is unavailable.

## Background shell control

A live background command reports its shell identifier on the tool update.

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "<tool call id>",
  "_meta": {
    "cognition.ai/background": true,
    "cognition.ai/backgroundRequested": true,
    "cognition.ai/backgroundShellId": "<shell id>",
    "cognition.ai/backgroundCommand": "<command>"
  }
}
```

The stop operation uses the owning session and that shell identifier.

```json
{
  "method": "_cognition.ai/terminal/killBackgroundShell",
  "params": {
    "sessionId": "<owning session id>",
    "shellId": "<shell id from the live tool update>"
  }
}
```

A successful call returned `{}` and terminated the fixture process, which was observed alive before the call and absent afterward. It did not cancel the parent prompt. No immediate completion notification was observed in the captured response window.

`cognition.ai/backgroundShellId` is not a VS Code terminal id. Do not derive it from command output or accept an arbitrary shell id from the webview. Only a live runtime registry may authorize a stop.

Both ordinary session loading and silent replay can contain historical tool metadata. Neither may repopulate an actionable shell registry. Keep control state separate from recorded transcript data, and transfer it with the live runtime.

The tested agent advertises `cognition.ai/terminalLifecycle`. No separate kill capability was established. Use relevant terminal support, actual live metadata, and graceful `-32601` handling.

## Deferred contracts

### Command editing before approval

Command generation succeeds with positional parameters.

```json
{
  "method": "_cognition.ai/command/revise",
  "params": [
    "<session id>",
    "printf 'original\\n'",
    "Replace original with edited. Make no other change."
  ]
}
```

The result contains a rewritten `command`. This does not establish an approval lifecycle that executes the edit.

A harmless command was held at a real permission request. The tested approval metadata overrides were ignored, and the original command executed. Do not ship command editing based only on successful generation. The named object parameters, edit application, cancellation, and stale permission behavior remain unresolved.

### Native rich mentions

The following session scoped lookups succeed.

| Method | Result collection | Observed item fields |
| --- | --- | --- |
| `_cognition.ai/rules/list` | `rules` | `name`, `path`, `provider`, `providerLabel`, `trigger`, `userInvocable`, `scope` |
| `_cognition.ai/skills/list` | `skills` | `name`, `displayName`, `description`, `path`, `provider`, `providerLabel`, `isBuiltin`, `scope` |
| `_cognition.ai/plans/list` | `plans` | `path`, `title`, `description` |

Each request uses `{ "sessionId": "<session id>" }`. A successful lookup does not establish native mention resolution or invocation.

`_cognition.ai/scope_search` requires `scope_type`. A request with `scope_type: "skill"` returned no items despite a populated skills list, so it is not a validated replacement for that list.

Native mention resolution and resource metadata for rules, skills, plans, conversations, terminals, and codemaps remain unmapped. Existing file mentions and attachments stay unchanged rather than inventing payloads.
