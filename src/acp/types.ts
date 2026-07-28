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
export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; messageId?: string; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; messageId?: string; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; messageId?: string; content: ContentBlock }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "tool_call"; toolCallId: string; title?: string; kind?: string; status?: ToolCallStatus; content?: ToolCallContent[]; rawInput?: unknown; locations?: { path: string; line?: number }[] }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; title?: string; kind?: string; status?: ToolCallStatus; content?: ToolCallContent[]; rawInput?: unknown; locations?: { path: string; line?: number }[] }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: string; [k: string]: unknown };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
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
