// Types for the Agent Client Protocol (ACP) as spoken by `devin acp`.
// Only the subset we use is modelled here. See https://agentclientprotocol.com

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: "resource_link"; uri: string; name?: string };

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: Record<string, unknown>;
    [k: string]: unknown;
  };
  authMethods?: { id: string; name: string; description?: string }[];
  agentInfo?: { name?: string; title?: string; version?: string };
  _meta?: Record<string, unknown>;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModeState;
  configOptions?: ConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface SessionModeState {
  currentModeId?: string;
  availableModes?: { id: string; name: string; description?: string }[];
}

// A generic session config option (Devin exposes `mode` and `model` this way).
export interface ConfigOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ConfigOptionChoice[];
}

export interface ConfigOptionChoice {
  value: string;
  name?: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResult {
  stopReason: StopReason;
}

// session/update notification payloads (discriminated by `sessionUpdate`).
// `_meta` carries Devin's extensions, including the subagent tags below.
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; messageId?: string; content: ContentBlock; _meta?: UpdateMeta }
  | { sessionUpdate: "agent_thought_chunk"; messageId?: string; content: ContentBlock; _meta?: UpdateMeta }
  | { sessionUpdate: "user_message_chunk"; messageId?: string; content: ContentBlock }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "tool_call"; toolCallId: string; title?: string; kind?: string; status?: ToolCallStatus; content?: ToolCallContent[]; rawInput?: unknown; locations?: { path: string; line?: number }[]; _meta?: UpdateMeta }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; title?: string; kind?: string; status?: ToolCallStatus; content?: ToolCallContent[]; rawInput?: unknown; locations?: { path: string; line?: number }[]; _meta?: UpdateMeta }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

// Devin's `_meta` on a session update. `inferenceToolName`/`toolName`/`eventType`
// identify the real tool behind the coarse ACP `kind`; the subagent keys track
// delegated work (unlocked by clientCapabilities._meta["cognition.ai/subagentSupport"],
// without which only the subagent's opening tool_call leaks through, never its
// updates, leaving those rows stuck at pending).
export interface UpdateMeta {
  "cognition.ai/inferenceToolName"?: string;
  "cognition.ai/toolName"?: string;
  "cognition.ai/eventType"?: string;
  // On a tool_call_update whose toolCallId is the subagent's own agentId.
  "cognition.ai/subagent_started"?: SubagentStarted;
  "cognition.ai/subagent_completed"?: SubagentCompleted;
  // On every update the subagent itself produces (tool calls, message and
  // thought chunks), naming the subagent that produced it.
  "cognition.ai/subagent_context"?: { parentAgentId?: string };
  [k: string]: unknown;
}

export interface SubagentStarted {
  agentId: string;
  title?: string;
  task?: string;
  // Display name of the profile, e.g. "Explore".
  profile?: string;
  depth?: number;
  isBackground?: boolean;
}

export interface SubagentCompleted {
  agentId: string;
  success?: boolean;
  // The subagent's final report, which the parent reads to continue.
  summary?: string;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: string; [k: string]: unknown };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  // ACP's core statuses are pending/in_progress/completed. The agent may also
  // mark an entry it decided not to do as skipped (or cancelled); both render as
  // a struck-through, dimmed row.
  status?: "pending" | "in_progress" | "completed" | "skipped" | "cancelled";
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: unknown;
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

// session/request_permission
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    content?: ToolCallContent[];
    locations?: { path: string; line?: number }[];
    // Devin sends no title for a command it wants to run, only the command
    // itself, under `cognition.ai/editableCommand`.
    _meta?: Record<string, unknown>;
  };
  options: PermissionOption[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export type RequestPermissionResult =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

// terminal/* client methods
export interface CreateTerminalParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string;
  outputByteLimit?: number;
}

export interface TerminalRef {
  sessionId: string;
  terminalId: string;
}

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

// _cognition.ai/revert/* (verified extension; unlocked by advertising
// clientCapabilities._meta["cognition.ai/revert"] = true).
export interface RevertParams {
  sessionId: string;
  targetNodeId: number;
  force?: boolean;
  skipFileUndo?: boolean;
}

export interface RevertFileAction {
  path?: string;
  // "restore" | "delete" | "recreate" and similar
  action?: string;
  additions?: number;
  deletions?: number;
  [k: string]: unknown;
}

export interface RevertPreviewResult {
  fileActions: RevertFileAction[];
  irreversibleWarnings: { toolName?: string; description?: string }[];
  conflicts: unknown[];
}

// fs/* client methods
export interface ReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}
export interface WriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

// `_cognition.ai/output`: the CLI's own log stream. The MCP channel is the only
// place it says a configured server would not start, which is otherwise invisible.
export interface CliOutput {
  channel?: string;
  level?: string; // info | warn | error
  message?: string;
  sessionId?: string;
}

// `_cognition.ai/agent_stopped`: what a finished turn cost. `responseDimensions`
// is the CLI's own display contract for it (a label and a value, ready to show),
// so the panel renders those rather than inventing its own wording.
export interface ResponseDimension {
  uid?: string;
  groupTitle?: string;
  label?: string;
  kind?: { type?: string; value?: number | string; prefix?: string; tail?: string; pluralTail?: string };
}

export interface AgentStopped {
  cause?: string;
  sessionId?: string;
  stats?: {
    toolCalls?: number;
    filesChanged?: number;
    commandsRun?: number;
    totalTimeMs?: number;
    modelLabel?: string;
    responseDimensions?: ResponseDimension[];
  };
}
