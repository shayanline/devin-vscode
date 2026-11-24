import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { AcpClient, AcpHost } from "../acp/client";
import {
  AcpRequestNotSentError,
  AgentStopped,
  CliOutput,
  ConfigOption,
  ContentBlock,
  PromptResult,
  CreateTerminalParams,
  NewSessionResult,
  ReadTextFileParams,
  RequestDiagnosticsParams,
  RequestDiagnosticsResult,
  RequestPermissionParams,
  RequestPermissionResult,
  ResponseDimension,
  RevertPreviewResult,
  RevertStep,
  RevertStepsUpdate,
  SessionListCapabilities,
  SessionListQuery,
  SessionUpdateNotification,
  SubagentCompleted,
  SubagentStarted,
  TerminalExitStatus,
  TerminalRef,
  WriteTextFileParams
} from "../acp/types";
import { diagnosticItems } from "../acp/diagnostics";
import { TerminalManager } from "../acp/terminal";
import { VsCodeTerminalRunner } from "../acp/vscodeTerminal";
import { userConfigDir } from "../settings/configService";
import { DevinSession, ListResult, fromAcpRow, fromAcpRows, listSessions } from "../session/sessionList";
import { SessionStore } from "../session/sessionStore";
import { ChangeTracker } from "../diff/changeTracker";
import { diffStat } from "../diff/diffStat";
import { paintedReplay, recordPainted, rewindPainted } from "./transcriptLog";
import {
  deleteJson,
  MessageState,
  MessageStateStore,
  PendingKind,
  PendingMessage,
  promptKey,
  readJson,
  SentAttachmentRecord,
  ShownAttachment,
  Staged,
  writeJson
} from "./messageState";
import { StatusBar } from "../ui/statusBar";
import { checkHealth, CliHealth, loginShellEnv } from "../cli/locate";
import { cachedFamilies, familyOf, listModelFamilies, ModelFamily } from "../cli/models";
import { fusionIdentity, fusionModelKey, modelIdentity } from "../cli/modelId";
import { lockOwner, removeLock } from "../cli/sessionLocks";
import { contextReportFromUpdate } from "../acp/usage";

interface QueuedDispatch {
  message: PendingMessage;
  failed: boolean;
}

// One live session: its own `devin acp` process and terminal manager, plus the
// per-session state that used to be flat on the provider. Several of these can
// be alive at once (one acp each), which is what lets a session keep running
// in the background while you look at another.
interface Runtime {
  id: string; // ACP session id
  cwd: string;
  client: AcpClient;
  terminals: TerminalManager;
  initialized: boolean;
  busy: boolean; // a turn is in flight
  awaiting: number; // pending permission/elicitation requests (needs the user)
  replaying: boolean; // a session/load replay is in progress
  // A silent background wake is in flight (the webview already shows the cached
  // transcript, so the replay is not streamed to it). Resolves when interactive.
  waking?: Promise<void>;
  // A session/new is still settling (defaults, readiness). Set once the agent has
  // issued the id, cleared when creation finishes either way: anything that would
  // prompt or replay this runtime waits on it rather than racing a half session.
  initializing?: Promise<Runtime>;
  // While true, session/update notifications are consumed but NOT streamed to the
  // webview (used during a silent wake so the cached transcript is not disturbed).
  silentReplay?: boolean;
  lastActivityAt: number; // for idle auto-exit
  mode?: string;
  model?: string;
  configOptions?: ConfigOption[];
  // Permission/elicitation requests from a background session, re-surfaced to
  // the webview when the session is next opened. Several can be outstanding at
  // once, so this is a queue rather than a single slot.
  pending: { requestId: string; payload: Record<string, unknown> }[];
  // A "needs your input" notification has already been shown for the current
  // attention episode, so we don't fire one per tool call. Reset when the
  // session is opened or its requests are all answered.
  attentionNotified?: boolean;
  // The prompt in flight, if any. A session can change surface mid turn, and the
  // surface it lands on has to be the one that ends it.
  turn?: Promise<PromptResult>;
  // How many prompts this session has run, which is what an edit row belongs to:
  // one row per file per turn, and the row's diff is that turn's work on it.
  turnCount: number;
  // Set when a session arrived on this surface mid turn and its own record of the
  // transcript was incomplete, so the rest is fetched from the CLI once the turn
  // ends and the channel is free.
  needsReplay?: boolean;
  // Everything this session has painted into a transcript, in order, so a chat
  // that moves surface can be rebuilt on the new one. The CLI cannot be asked for
  // it mid turn: `session/load` over a live channel kills the running prompt.
  log: Record<string, unknown>[];
  replay: Record<string, unknown>[];
  // False once the oldest entries were dropped, which makes a rebuild partial.
  logFull: boolean;
  // The session's durable queue and sent manifest, the same object its
  // MessageStateStore entry persists so both survive the process.
  messages: MessageState;
  // A user_message_chunk group being accumulated during a history replay,
  // keyed by the message id the agent gave it, and how far into
  // messages.sent the replay matcher has already walked.
  replayUser?: { messageId?: string; blocks: ContentBlock[] };
  replaySentIndex?: number;
  // Set between asking the agent to stop a turn and that turn actually settling:
  // steering is off the table while the cancel is in flight, and the composer
  // stays busy until the shared turn really ends.
  cancelling?: boolean;
  // The queued message "Send Immediately" (or Stop and Send) picked, which the
  // next drain sends ahead of everything else, of either kind. One shot: it is
  // cleared when the message goes out or leaves the queue.
  runNextId?: string;
  // Records keep each queued message's first dispatch order until the turn settles.
  queuedDispatches?: QueuedDispatch[];
  // Webview messages a background turn produced while this session was not the
  // visible one. Replayed when the session is reopened so its progress is shown
  // even for a turn that is still running (capped so it can't grow unbounded).
  bgBuffer: Record<string, unknown>[];
  // MCP servers this agent could not reach, by name. The CLI only says so on its
  // output stream, so without this a broken server is invisible in the panel and
  // an aborted session load can only guess at the reason.
  mcpProblems: Map<string, string>;
  // Terminals we have started but not yet matched to the tool call that asked for
  // them, newest last.
  pendingTerminals: { id: string; command: string }[];
  // Subagent bookkeeping. A subagent is announced twice: first as the parent's
  // `run_subagent` tool call (which owns the rendered block) and then under its
  // own agentId, which is what all its later work is tagged with. These map one
  // to the other so the webview only ever sees the block's id.
  subagentSpawns: { id: string; title: string }[];
  subagentIds: Map<string, string>;
  // Every revertible point in this conversation, as the agent last reported it.
  // Pushed after each turn, so this is the authoritative source of the prompt
  // ids checkpoints and edit-and-resubmit rewind to.
  steps: RevertStep[];
  stepsKnown: boolean;
  // Bumped every time the step list is replaced or invalidated, so a list read
  // started before a newer push or a new turn cannot overwrite it when it lands.
  stepsRevision: number;
  // A rewind in flight for this runtime. Sends and steers queue behind it so a
  // prompt cannot overtake the mutation or the edited resend it prepares.
  rewinding?: { userMessageId: string; resendText?: string };
  openDocuments: Map<string, { uri: string; languageId: string; isDirty: boolean }>;
  // A usage read in flight for this session, so overlapping triggers coalesce
  // into one /context + /session-stats pair.
  usagePending?: Promise<void>;
  // The surface that currently owns this runtime's reports and recovery. A read
  // or a failed prompt can outlive a surface transfer, so the reply goes to
  // whoever holds the runtime when it lands rather than the controller that
  // asked for it.
  owner: ChatController;
  // When the last usage read was scheduled; non-forced triggers inside the
  // window are skipped so every signal does not become its own read.
  usageRefreshedAt: number;
  // Which Fusion role produced the latest meaningful update this turn, and the
  // model the turn was started under. Snapshotted at turn start so a mid turn
  // model change cannot misattribute the old request's frames. Cleared when
  // the turn ends.
  modelActivity?: { model: string; role: "lead" | "sub" | null };
  // Background shells this session's tools reported, keyed by toolCallId, with
  // the agent-side shellId kept host only. Lives on the runtime rather than in
  // the transcript because it authorizes an action: it is published to the webview
  // as ephemeral state and must never be recorded for replay.
  backgroundShells?: Map<string, { shellId: string; stopping?: boolean; error?: string }>;
}

// Cap on a backgrounded session's replay buffer (oldest dropped past this).
const BG_BUFFER_MAX = 6000;
const REPLAY_BATCH_SIZE = 100;

// Session updates that mean the agent has started producing its own side of the
// transcript, which ends any user message still being accumulated for replay.
// Config, options, usage and similar housekeeping updates do not.
const REPLAY_USER_ENDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan"
]);

// Shown in place of a transcript that could not be opened. The reason itself goes
// to the output channel, which the notification points at.
const OPEN_FAILED = "Couldn't open this chat. See the Devin output for details.";

// A live session handed from one chat surface to another (the side panel to an
// editor tab, or back). The `devin acp` process, its terminals and any request it
// is still waiting on all travel together, so the agent never restarts, keeps the
// CLI's session lock, and an in flight turn is not interrupted.
export interface RuntimeTransfer {
  rt: Runtime;
  // Files and images staged in the composer but not sent yet.
  attachments: Staged[];
  permissions: [string, { resolve: (res: RequestPermissionResult) => void; rid: string }][];
  elicitations: [string, { resolve: (res: unknown) => void; rid: string }][];
  // Which models cannot read an image, which the agent only reports when it lists
  // its options. The arriving surface never asks again, and an image sent to a
  // model that cannot decode it breaks the session for good, so it travels.
  modelImages: [string, boolean][];
  from: string; // where it came from, for the log line the handover leaves
}

// What a controller needs from the surface that owns it: which other surface has
// a session, how to move one, and how to bring one to the front. Implemented by
// the ChatManager, which is the only thing that knows about all the surfaces.
export interface SurfaceHost {
  // Move a session to a new editor tab, or back to the side panel.
  detach(id: string): Promise<void>;
  attach(id: string): Promise<void>;
  // Move it to a specific surface, whichever one has it now.
  moveHere(to: ChatController, id: string): Promise<void>;
  owner(id: string, except?: ChatController): ChatController | undefined;
  label(controller: ChatController): string;
  reveal(controller: ChatController): void;
  // Live session ids held by every surface other than this one.
  elsewhere(except: ChatController): string[];
  statuses(except: ChatController): Record<string, SessionStatus>;
  sessionListClient(except: ChatController): AcpClient | undefined;
  // Half given answers for a request that has moved to another surface.
  saveAnswerDraft(requestId: string, state: unknown, except: ChatController): void;
  // One surface's live session state changed, so every other surface's list,
  // status dots and "running elsewhere" badges are now out of date.
  sessionsChanged(except: ChatController): void;
  // A session was renamed, or the CLI finally reported its name, so any editor
  // tab showing it needs its own title updating.
  titlesChanged(): void;
}

// Image file extensions we attach inline (as base64): the formats the agent can
// decode. Anything else is attached as text, including an image it cannot read
// (svg, heic, avif), which as an image block gets the whole request rejected.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon"
};

// Match VS Code chat's cap on an attached image (it refuses larger ones).
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

// How much of an attached file's text is sent. A dropped file says so when it is
// cut short, since its bytes are all the agent gets: it has no path to read more.
const MAX_ATTACH_CHARS = 200000;

// The mode a chat starts in when nothing else says otherwise.
const DEFAULT_MODE = "accept-edits";

// How long typing settles before the agent is told a file has unsaved edits. It
// only needs to know that the file is dirty, so one message per pause is enough.
const DIRTY_DEBOUNCE_MS = 1500;

// How many problems "Fix Problems Here" hands over. A file with hundreds is a
// build that is broken everywhere, not a question about a few lines.
const MAX_ATTACHED_PROBLEMS = 40;

// Below this many filename matches, the query is probably naming a symbol rather
// than a file, so the language servers are asked too.
const SYMBOL_FALLBACK_AT = 5;

// How long a "take over this session?" question waits for an answer before it is
// treated as declined. Long enough to walk away from and come back to, short of
// leaving the session unopenable for the rest of the window.
const TAKEOVER_TIMEOUT_MS = 3 * 60_000;
const SESSION_LIST_ACP_TIMEOUT_MS = 8_000;
const SESSION_LIST_CLI_TIMEOUT_MS = 12_000;

// A real file the user is working in, worth telling the agent about. The diff
// views git opens are a second scheme, but git also opens true files inside
// .git (a commit message), and those are plumbing, not the user's work. It has
// to be a path segment: `.github/workflows` and `.gitignore` are ordinary files.
function isEditorDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && !/(^|[/\\])\.git([/\\]|$)/.test(doc.uri.fsPath);
}

// The few symbol kinds worth naming in a suggestion row. Anything else is left as
// "symbol" rather than spelling out every kind VS Code knows.
function symbolKindLabel(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.Class: return "class";
    case vscode.SymbolKind.Interface: return "interface";
    case vscode.SymbolKind.Function: return "function";
    case vscode.SymbolKind.Method: return "method";
    case vscode.SymbolKind.Enum: return "enum";
    case vscode.SymbolKind.Constant: return "constant";
    case vscode.SymbolKind.Variable: return "variable";
    case vscode.SymbolKind.Struct: return "struct";
    default: return "symbol";
  }
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
  if (s === vscode.DiagnosticSeverity.Error) return "error";
  if (s === vscode.DiagnosticSeverity.Warning) return "warning";
  if (s === vscode.DiagnosticSeverity.Information) return "info";
  return "hint";
}

// Shown until a session reports the real list. Deliberately the modes every
// supported CLI has: anything newer (`smart`, and whatever comes next) arrives
// from the agent instead of being hardcoded here.
const FALLBACK_MODES = [
  { value: DEFAULT_MODE, name: "Code", icon: "codicon-code" },
  { value: "ask", name: "Ask", icon: "codicon-comment-discussion" },
  { value: "plan", name: "Plan", icon: "codicon-checklist" },
  { value: "bypass", name: "Bypass", icon: "codicon-unlock" }
];

// Devin names its mode icons after its own icon set, so map the ones it sends to
// the nearest codicon. An unknown name falls back to a neutral one rather than
// rendering an empty square.
const MODE_ICONS: Record<string, string> = {
  code: "codicon-code",
  sparkles: "codicon-sparkle",
  "message-circle": "codicon-comment-discussion",
  "file-text": "codicon-checklist",
  "shield-off": "codicon-unlock",
  shield: "codicon-shield",
  zap: "codicon-zap"
};

// The mode picker's options, from the agent's own `mode` config option. Devin also
// sends a description for each ("Auto-approve actions the model judges safe"),
// which the picker has nowhere to show yet, so it is left out rather than passed
// through unused.
function configChoices(opt?: ConfigOption): { value: string; name?: string; description?: string; _meta?: Record<string, unknown> }[] {
  return (opt?.options || []).flatMap((choice) => "group" in choice ? choice.options : [choice]);
}

function groupedModelChoices(options?: ConfigOption[]): Record<string, { value: string; name?: string; description?: string }[]> {
  const model = options?.find((option) => option.id === "model" || option.category === "model");
  const groups: Record<string, { value: string; name?: string; description?: string }[]> = {};
  for (const choice of model?.options || []) {
    if ("group" in choice) {
      groups[choice.group] = choice.options;
    }
  }
  return groups;
}

function thoughtOption(options?: ConfigOption[]): ConfigOption | undefined {
  return options?.find((option) => option.id === "thought_level" || option.category === "thought_level");
}

function speedOption(options?: ConfigOption[]): ConfigOption | undefined {
  return options?.find((option) => option.id === "speed");
}

// The catalogue includes effort and speed variants, while ACP accepts a base
// model uid with separate thought_level and speed options.
function acceptedModelUid(options: ConfigOption[] | undefined, requested: string): { model: string; effort?: string; speed?: string } {
  const accepted = new Set(
    configChoices(options?.find((o) => o.id === "model" || o.category === "model")).map((c) => c.value)
  );
  if (!accepted.size || accepted.has(requested)) return { model: requested };
  const fusion = fusionModelKey(requested);
  if (fusion) {
    const lead = fusionIdentity(requested);
    for (const value of accepted) {
      if (fusionModelKey(value) === fusion) return { model: value, effort: lead.effort, speed: lead.speed };
    }
    return { model: requested };
  }
  const identity = modelIdentity(requested);
  for (const value of accepted) {
    if (modelIdentity(value).id === identity.id) return { model: value, effort: identity.effort, speed: identity.speed };
  }
  return { model: requested };
}

function modeChoices(opt?: ConfigOption): { value: string; name: string; icon: string }[] {
  return configChoices(opt).map((c) => ({
    value: c.value,
    name: c.name || c.value,
    icon: MODE_ICONS[String(c._meta?.["cognition.ai/icon"] || "")] || "codicon-circle-outline"
  }));
}

// The dot shown next to a session in the list. "attention" means a backgrounded
// session raised a permission/question and is now blocked waiting on the user.
type SessionStatus = "running" | "idle" | "starting" | "attention";

// One chat surface. The sidebar view and each editor/window panel is its own
// ChatController bound to a single `vscode.Webview`, with its own visible
// session and its own runtime pool. Shared singletons (SessionStore,
// ChangeTracker, StatusBar) are passed in by the ChatManager.
export class ChatController implements AcpHost {
  private webview?: vscode.Webview;
  // How to bring this surface to the front (focus the view, or reveal the panel).
  private reveal?: () => void;
  // When set (a freshly created editor/window surface), start a new session as
  // soon as the webview is ready instead of showing the session list.
  autoNewSession = false;
  // The chat an editor tab was holding before a window reload, reopened as soon as
  // the restored page is ready so the tab comes back to it rather than empty.
  openOnReady?: string;
  private readonly ownDisposables: vscode.Disposable[] = [];

  // Live runtimes keyed by session id. Absent = dead (gray) history.
  private readonly runtimes = new Map<string, Runtime>();
  // The session currently shown in the webview (the interactive one).
  private activeId?: string;
  // A runtime "starting" label per id (e.g. waking / creating), for the dots.
  private readonly starting = new Set<string>();
  // In-flight load/wake per session id. `onDidReceiveMessage` is fire-and-forget,
  // so two quick opens of the same session would otherwise both spawn a
  // `devin acp` (the second orphaning the first and holding its lock). Sharing
  // the promise keeps it to one process.
  private readonly loading = new Map<string, Promise<void>>();
  // A brand-new session being created (id not known until session/new returns).
  private startingNew?: Promise<Runtime>;
  // Bumped on every navigation intent: it invalidates earlier presentation
  // work, including when activeId stays undefined (the sessions list and a not
  // yet claimed new chat look the same to activeId alone).
  private navigationVersion = 0;
  // The navigation generation `startingNew` belongs to. A different intent
  // starts its own creation rather than adopting this one.
  private startingNewVersion = -1;
  private idleTimer?: NodeJS.Timeout;

  private health?: CliHealth;
  private resolvedCli = "devin";
  private env?: NodeJS.ProcessEnv;
  private currentMode?: string;
  private currentModel?: string;
  private currentThoughtLevel?: string;
  private currentSpeed?: string;
  // Bumped every time a model change is queued or starts. After each await the
  // caller checks whether the generation moved, and bails if a newer call has
  // taken over, so only the latest model change publishes options.
  private modelGen = 0;
  private modelConfigTail: Promise<void> = Promise.resolve();
  private pendingModelConfig?: {
    rt: Runtime | undefined;
    model: string;
    thoughtLevel?: string;
    speed?: string;
    requestId?: number;
  };

  private readonly permissionResolvers = new Map<string, { resolve: (res: RequestPermissionResult) => void; rid: string }>();
  // Shared across surfaces: a request id has to stay unique when a session (and
  // the requests it is waiting on) moves from one surface to another.
  private static permissionSeq = 0;

  // Queued and sent message state per session, on disk under this storage
  // root so it survives the window, the process and a move between surfaces.
  private readonly messageStore: MessageStateStore;

  // Whether the active editor file is sent as implicit context (VS Code's
  // current-file behaviour). Mirrored to the composer as a pill.
  private implicitEnabled = true;
  private implicitTimer?: NodeJS.Timeout;
  private changeListSub?: vscode.Disposable;
  private changeResolveSub?: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly changes: ChangeTracker,
    private readonly statusBar: StatusBar | undefined,
    private readonly output: vscode.OutputChannel,
    private readonly kind: "view" | "editor" = "view",
    // The surface that owns this controller, so a session can be moved between
    // surfaces and one already open elsewhere is revealed rather than fought over.
    private readonly surfaces?: SurfaceHost
  ) {
    this.messageStore = new MessageStateStore(context.storageUri || context.globalStorageUri);
    this.changeListSub = this.changes.onDidChangeList(() => this.postWorkingSet());
    // Keeping or undoing a change is answered by the tracker, not by the button
    // that asked: "Keep all" and the Source Control view resolve files nobody
    // clicked, and the edit rows for those have to say so too.
    this.changeResolveSub = this.changes.onDidResolve((e) =>
      this.post({ type: "changesResolved", paths: e.paths, action: e.action })
    );
    this.implicitEnabled = this.cfg().get<boolean>("implicitContext.enabled", true);
    this.sessionsCache = this.store.sessionList();
    // Keep the implicit "current file" pill in sync with the active editor and
    // its selection (the latter debounced, since selection changes fire often).
    // Stored per controller so an editor/window surface cleans them up on close.
    this.ownDisposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.postImplicitContext();
        // Which file the user is looking at, so "this file" means something and the
        // agent stops having to ask or guess.
        if (e) this.sendDocumentEvent("didFocus", e.document);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.scheduleImplicitPost();
      }),
      vscode.workspace.onDidOpenTextDocument((d) => this.sendDocumentEvent("didOpen", d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.sendDocumentEvent("didClose", d)),
      // A file the agent read and the user has since edited without saving is the
      // stale read it cannot otherwise know about.
      vscode.workspace.onDidSaveTextDocument((d) => this.sendDocumentEvent("didChangeDirty", d)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.isDirty) this.scheduleDirtyEvent(e.document);
      }),
      // Every panel preference rides on the capabilities message, so a setting
      // changed in the Settings editor applies to an open chat straight away
      // instead of waiting for the next session event.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("devin")) this.postCapabilities();
      })
    );
  }

  private scheduleImplicitPost(): void {
    if (this.implicitTimer) {
      clearTimeout(this.implicitTimer);
    }
    this.implicitTimer = setTimeout(() => this.postImplicitContext(), 150);
  }

  // Tell the webview about the active editor file (and selection range) so it
  // can render the implicit-context pill.
  private postImplicitContext(): void {
    const ed = vscode.window.activeTextEditor;
    let file: { path: string; name: string; line1?: number; line2?: number } | null = null;
    if (ed && ed.document.uri.scheme === "file") {
      const doc = ed.document;
      const sel = ed.selection;
      const hasSel = !!sel && !sel.isEmpty;
      file = {
        path: doc.uri.fsPath,
        name: path.basename(doc.uri.fsPath),
        line1: hasSel ? sel.start.line + 1 : undefined,
        line2: hasSel ? sel.end.line + 1 : undefined
      };
    }
    this.post({ type: "implicitContext", file, enabled: this.implicitEnabled });
  }

  // Tell the live agent what the user is doing in the editor. This is the half of
  // the editor context the extension can give that the CLI in a terminal cannot,
  // and the agent needs it for diagnostics too: it only reports problems for
  // documents it has been told are open.
  //
  // Only the visible session is told. A background agent is working on its own
  // turn and the user's editor is not part of it, and telling every runtime would
  // multiply every keystroke by the number of open chats.
  private sendDocumentEvent(kind: "didOpen" | "didClose" | "didChangeDirty" | "didFocus", doc: vscode.TextDocument): void {
    const rt = this.active();
    if (!this.surfaceVisible || !rt || !rt.initialized || !rt.client.supportsDocumentLifecycle() || !isEditorDocument(doc)) {
      return;
    }
    // A URI, not a path: a path is rejected outright by the agent.
    const state = { uri: doc.uri.toString(), languageId: doc.languageId, isDirty: doc.isDirty };
    rt.client.documentEvent(kind, { sessionId: rt.id, ...state });
    if (kind === "didClose") {
      rt.openDocuments.delete(state.uri);
    } else if (kind !== "didFocus") {
      rt.openDocuments.set(state.uri, state);
    }
  }

  // Typing fires a change event per keystroke, so the dirty signal is coalesced:
  // the agent only needs to know a file has unsaved edits, not how many.
  private scheduleDirtyEvent(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (this.dirtyTimers.has(key)) {
      return;
    }
    const t = setTimeout(() => {
      this.dirtyTimers.delete(key);
      this.sendDocumentEvent("didChangeDirty", doc);
    }, DIRTY_DEBOUNCE_MS);
    t.unref?.();
    this.dirtyTimers.set(key, t);
  }

  private readonly dirtyTimers = new Map<string, NodeJS.Timeout>();

  // Everything the user has open right now, sent to a session that has just
  // started so its context is not empty until the next editor event.
  private sendOpenDocuments(rt: Runtime): void {
    if (!this.surfaceVisible || this.activeId !== rt.id || !rt.client.supportsDocumentLifecycle()) {
      return;
    }
    const documents = new Map<string, { uri: string; languageId: string; isDirty: boolean }>();
    for (const doc of vscode.workspace.textDocuments) {
      if (isEditorDocument(doc)) {
        const state = { uri: doc.uri.toString(), languageId: doc.languageId, isDirty: doc.isDirty };
        documents.set(state.uri, state);
      }
    }
    for (const [uri, state] of rt.openDocuments) {
      if (!documents.has(uri)) {
        rt.client.documentEvent("didClose", { sessionId: rt.id, ...state });
      }
    }
    for (const [uri, state] of documents) {
      const previous = rt.openDocuments.get(uri);
      if (!previous) {
        rt.client.documentEvent("didOpen", { sessionId: rt.id, ...state });
      } else if (previous.languageId !== state.languageId || previous.isDirty !== state.isDirty) {
        rt.client.documentEvent("didChangeDirty", { sessionId: rt.id, ...state });
      }
    }
    rt.openDocuments = documents;
    const active = vscode.window.activeTextEditor?.document;
    if (active && isEditorDocument(active)) {
      rt.client.documentEvent("didFocus", {
        sessionId: rt.id,
        uri: active.uri.toString(),
        languageId: active.languageId,
        isDirty: active.isDirty
      });
    }
  }

  // The active editor as implicit context: the selection when there is one,
  // otherwise a lightweight resource link the agent can open.
  private buildImplicitBlocks(): ContentBlock[] {
    if (!this.implicitEnabled) {
      return [];
    }
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") {
      return [];
    }
    const doc = ed.document;
    const uri = doc.uri;
    const sel = ed.selection;
    const rel = vscode.workspace.asRelativePath(uri);
    if (sel && !sel.isEmpty) {
      const body = doc.getText(sel).slice(0, 20000);
      return [{
        type: "text",
        text: `Current selection from ${rel} lines ${sel.start.line + 1}-${sel.end.line + 1}:\n\n\`\`\`${doc.languageId}\n${body}\n\`\`\``
      }];
    }
    return [{ type: "resource_link", uri: uri.toString(), name: path.basename(uri.fsPath) }];
  }

  // Hand the webview the unsent text stored for whichever composer it is showing
  // (a session's own, or the "new chat" box when there is none). The id travels
  // with it so a late arrival for a session already left is ignored.
  private postDraft(): void {
    this.post({ type: "draft", id: this.activeId || null, text: this.store.draft(this.activeId) });
  }

  // Part way through answering a question, remembered against the request so it
  // survives leaving the session and coming back. It lives on the pending payload
  // the host re-posts, so it is restored by the same path that re-shows the
  // question, and is dropped with it once the question is answered.
  private saveAnswerDraft(requestId: string, state: unknown): void {
    // The widget flushes its answers as it is torn down, which is also how a
    // session leaves a surface, so by now the request may belong to another one.
    if (!this.storeAnswerDraft(requestId, state)) {
      this.surfaces?.saveAnswerDraft(requestId, state, this);
    }
  }

  storeAnswerDraft(requestId: string, state: unknown): boolean {
    for (const rt of this.runtimes.values()) {
      const p = rt.pending.find((x) => x.requestId === requestId);
      if (p) {
        p.payload.answers = state;
        return true;
      }
    }
    return false;
  }

  // The working set is what the visible session changed. Other sessions keep
  // their own edits tracked (reopening one gets its files back), and the Source
  // Control view still lists everything.
  private postWorkingSet(): void {
    this.post({
      type: "workingSet",
      // The counts travel with the files, so a working set restored after a reload
      // arrives complete instead of waiting for each edit to be reported again.
      files: this.changes.changesFor(this.activeId).map((c) => ({
        path: c.path,
        name: path.basename(c.path),
        added: c.added,
        removed: c.removed
      }))
    });
  }

  // --- Webview lifecycle ---------------------------------------------------

  // Bind this controller to a webview (from a WebviewView or a WebviewPanel).
  // `reveal` brings the surface to the front when focus() is called.
  bind(webview: vscode.Webview, reveal?: () => void): void {
    this.navigationVersion++;
    this.webview = webview;
    this.reveal = reveal;
    // A re-bind is a brand new page with an empty transcript, and nothing painted
    // into it yet.
    this.webviewReady = false;
    this.painted = false;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  // Resolves once the webview is listening, so a session handed to a freshly
  // created surface is not posted into a page that cannot hear it yet.
  private webviewReady = false;
  // Set when the page this controller was bound to has gone for good (its editor
  // tab closed), so nothing waits on a reply that can never come.
  private webviewGone = false;
  private closed = false;
  // Whether a chat has been painted into the current page. The readiness chain
  // restores the last chat only when nothing has, so a session handed to this
  // surface is not immediately reloaded on top of itself.
  private painted = false;
  private readyWaiters: { resolve: () => void; reject: (reason: Error) => void }[] = [];
  whenReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Chat surface is closed"));
    }
    if (this.webviewReady) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private releaseReadyWaiters(error?: Error): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }

  markClosed(): void {
    this.webviewGone = true;
    this.closed = true;
    this.setFocused(false);
    if (ChatController.lastFocused === this) {
      ChatController.lastFocused = undefined;
    }
    this.releaseReadyWaiters(new Error("Chat surface is closed"));
  }

  // What the composer holds is only known to the page: the draft is debounced and
  // a question's answers are half given. A handover is instant, so the page is
  // asked to write both back BEFORE the chat leaves, and waited on, or a prompt
  // someone was part way through writing arrives on the new surface empty.
  private flushWaiters: (() => void)[] = [];
  async flushSurfaceState(): Promise<void> {
    if (!this.webviewReady || this.webviewGone) {
      return;
    }
    this.post({ type: "flushState" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.flushWaiters = this.flushWaiters.filter((w) => w !== done);
        resolve();
      }, 250);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.flushWaiters.push(done);
    });
  }

  private onStateFlushed(): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const w of waiters) {
      w();
    }
  }

  // Open a session on this surface (used when a move has nothing live to carry).
  async openSession(id: string): Promise<void> {
    if (!id) {
      return;
    }
    this.post({ type: "body", body: "thread" });
    await this.loadSession(id);
    this.focus();
  }

  focus(): void {
    if (this.reveal) {
      this.reveal();
    } else {
      void vscode.commands.executeCommand("devin.chatView.focus");
    }
  }

  // The palette's on demand history picker: waits for the page, refuses a
  // surface that has gone, then asks it to run the composer history flow.
  async showPromptHistory(): Promise<void> {
    try {
      await this.whenReady();
    } catch {
      return;
    }
    if (this.closed) {
      return;
    }
    this.focus();
    this.post({ type: "showPromptHistory" });
  }

  // Kill every live ACP process (and its terminals) so a window reload or
  // extension deactivate does not leave stranded `devin acp` agents (and their
  // MCP servers). This is item 6: stop all sessions on exit.
  //
  // Synchronous, so the escalation to SIGKILL is left on a timer. Prefer
  // `shutdown()` when the extension host itself is going away, since that timer
  // will not fire once it has exited.
  dispose(): void {
    this.navigationVersion++;
    this.closed = true;
    if (ChatController.lastFocused === this) {
      ChatController.lastFocused = undefined;
    }
    this.releaseReadyWaiters(new Error("Chat surface is closed"));
    this.stopLocalState();
    // A surface that has gone cannot be the one holding the keyboard.
    this.setFocused(false);
    for (const rt of new Set([...this.runtimes.values(), ...this.spawnedRuntimes])) {
      // The same as terminating the chat, which this is one of the ways of doing:
      // closing a tab mid turn offers to terminate, and the prompt promises the
      // conversation is kept, not that the writing behind it is thrown away.
      this.keepQueued(rt);
      this.destroyRuntime(rt);
    }
    // Queues were just paused, so releasing a borrowed edit cannot send: its
    // staged copy is dropped rather than carried into the next draft.
    this.setQueueEditing(undefined);
    this.runtimes.clear();
    this.spawnedRuntimes.clear();
    this.starting.clear();
    this.activeId = undefined;
  }

  // Stop everything for good on the way out (window reload, extension
  // deactivate), and resolve only once every agent is really gone.
  //
  // A `devin acp` agent cannot be handed over to the next extension host: it
  // runs its shell commands, file writes and permission prompts through us, over
  // our stdio, so leaving it alive would strand an agent that can do nothing
  // while still holding the CLI's session lock. Instead each one is stopped
  // deterministically here, and any session with a turn in flight is recorded so
  // the next window can say the turn was interrupted rather than losing it
  // silently.
  async shutdown(): Promise<void> {
    this.navigationVersion++;
    this.closed = true;
    if (ChatController.lastFocused === this) {
      ChatController.lastFocused = undefined;
    }
    this.releaseReadyWaiters(new Error("Chat surface is closed"));
    // Everything with a process, not just everything with a session id: a chat
    // still waiting on session/new is not in the pool yet, and it is exactly as
    // unable to outlive us as the rest.
    const live = [...new Set([...this.runtimes.values(), ...this.spawnedRuntimes])];
    const interrupted = live.filter((rt) => rt.id && (rt.busy || rt.awaiting > 0)).map((rt) => rt.id);
    // Anything still waiting behind a turn is the user's own writing, and it only
    // ever lived on the runtime we are about to stop: each queue is paused and
    // saved before its process goes, so the next window finds it structured.
    for (const rt of live) {
      this.keepQueued(rt);
    }
    // A borrowed queue edit ends here too: its staged copy is dropped rather than
    // saved as an unrelated draft or sent by the shutdown.
    this.setQueueEditing(undefined);
    this.stopLocalState();
    this.runtimes.clear();
    this.spawnedRuntimes.clear();
    this.starting.clear();
    this.activeId = undefined;
    // Record before killing: the write has to be in flight while the host is
    // still alive to flush it.
    const recorded = this.store.markInterrupted(interrupted);
    await Promise.all(live.map((rt) => this.stopRuntime(rt)));
    try {
      await recorded;
    } catch {
      // workspaceState is best effort; losing the note is not worth failing on
    }
    await this.messageStore.flush();
  }

  // Stop one runtime in order: cancel the turn so the agent can stop cleanly,
  // stop its commands, wait for the agent to exit, then force anything left.
  private async stopRuntime(rt: Runtime): Promise<void> {
    if (rt.busy && rt.id) {
      try {
        rt.client.cancel(rt.id);
      } catch {
        // the pipe may already be gone
      }
    }
    try {
      rt.terminals.requestStopAll();
    } catch {
      // ignore
    }
    try {
      await rt.client.shutdown();
    } catch {
      // ignore
    }
    try {
      rt.terminals.forceStopAll();
    } catch {
      // ignore
    }
  }

  // Everything except the runtimes: timers, in-flight agent requests, and our
  // own subscriptions. Shared by both stop paths.
  private stopLocalState(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.implicitTimer) {
      clearTimeout(this.implicitTimer);
      this.implicitTimer = undefined;
    }
    // Settle every in-flight agent request so its client-side call never hangs.
    for (const [, e] of this.permissionResolvers) {
      e.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    for (const [, e] of this.elicitationResolvers) {
      e.resolve({ action: "cancel" });
    }
    this.elicitationResolvers.clear();
    for (const [requestId] of [...this.takeoverResolvers]) {
      this.resolveTakeover(requestId, "cancel");
    }
    this.loading.clear();
    this.changeListSub?.dispose();
    this.changeListSub = undefined;
    this.changeResolveSub?.dispose();
    this.changeResolveSub = undefined;
    for (const [, t] of this.dirtyTimers) {
      clearTimeout(t);
    }
    this.dirtyTimers.clear();
    for (const d of this.ownDisposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.ownDisposables.length = 0;
  }

  // --- Moving a live session between surfaces ------------------------------

  // Record the session this surface is showing. Only the side panel is restored
  // after a reload, so only it writes the marker.
  private markVisible(id: string): void {
    this.store.setActive(id);
    if (this.kind === "view") {
      this.store.setViewing(id);
    }
  }

  // Which sessions this surface is running, and whether it is showing one.
  ownsSession(id: string): boolean {
    return this.runtimes.has(id);
  }
  visibleSession(): string | undefined {
    return this.activeId;
  }
  // Every session this surface is running, including ones working in the
  // background while its list or another chat is on screen.
  liveSessions(): string[] {
    return [...this.runtimes.keys()].filter(Boolean);
  }
  liveSessionStatuses(): Record<string, SessionStatus> {
    return this.statusMap();
  }
  async waitForSessionLoad(id: string): Promise<void> {
    await this.loading.get(id);
  }
  sessionListClient(): AcpClient | undefined {
    return this.anyLiveClient();
  }

  // The chat is being opened on another surface and has no live agent to hand
  // over, so this surface simply stops showing it.
  releaseSession(id: string): void {
    if (this.activeId !== id) {
      return;
    }
    this.navigationVersion++;
    this.activeId = undefined;
    if (this.kind === "view") {
      this.store.setViewing(undefined);
      this.post({ type: "body", body: "list" });
    }
  }

  // Hand a live session out: it leaves this surface's pool with its process, its
  // terminals and anything it is still waiting on, and this surface stops showing
  // it. The agent is untouched, so nothing restarts and no lock changes hands.
  exportRuntime(id: string): RuntimeTransfer | undefined {
    const rt = this.runtimes.get(id);
    if (!rt || rt.replaying) {
      return undefined;
    }
    this.runtimes.delete(id);
    this.starting.delete(id);
    // The message state itself travels inside rt. Only this surface's cached
    // entry is dropped, so a late save from here cannot land on the file the
    // arriving surface now owns.
    this.messageStore.forget(id);
    // Drop this controller's listeners: the new one attaches its own.
    rt.client.removeAllListeners();
    // The arriving surface owns the process from here, so this one must stop
    // counting it among the agents it is responsible for stopping.
    this.spawnedRuntimes.delete(rt);
    const take = <T>(map: Map<string, T & { rid: string }>): [string, T][] => {
      const taken: [string, T][] = [];
      for (const [key, entry] of [...map]) {
        if (entry.rid === id) {
          taken.push([key, entry]);
          map.delete(key);
        }
      }
      return taken;
    };
    // What was staged for this chat travels with it, whichever chat is on screen.
    const visible = this.activeId === id;
    const transfer: RuntimeTransfer = {
      rt,
      attachments: this.stagedFor(id),
      permissions: take(this.permissionResolvers),
      elicitations: take(this.elicitationResolvers),
      modelImages: [...this.modelImageSupport],
      from: this.kind === "view" ? "the side panel" : "an editor tab"
    };
    // Held by the surface it is going to now. The file on disk stays: it is that chat's,
    // and whichever surface shows it next reads it back the same way a reload does, which
    // is why the post below must not put an empty entry back in its place.
    this.staged.delete(this.stagedKey(id));
    if (visible) {
      this.postStaged();
    }
    // A lock takeover question belongs to a load this surface is abandoning, and
    // its widget goes with the transcript, so settle it rather than leave the load
    // waiting on an answer that can never arrive.
    for (const [rid, entry] of [...this.takeoverResolvers]) {
      if (entry.rid === id) {
        this.resolveTakeover(rid, "cancel");
      }
    }
    if (visible) {
      // This surface has nothing to show any more, so it goes back to its list.
      // An editor tab has no list: it is one chat, and the manager closes it.
      this.navigationVersion++;
      this.activeId = undefined;
      if (this.kind === "view") {
        this.store.setViewing(undefined);
        this.post({ type: "busy", value: false });
        this.post({ type: "body", body: "list" });
      }
    }
    this.broadcastStatuses();
    void this.refreshSessionsIfVisible();
    return transfer;
  }

  // Take a live session over: adopt its process and outstanding requests, then
  // show it. An idle session repaints its transcript from the agent it already
  // has (about a second, no new process); one mid turn cannot be reloaded over
  // its live channel, so it picks up from here and says so.
  async importRuntime(transfer: RuntimeTransfer): Promise<void> {
    if (this.closed) {
      throw new Error("Chat surface is closed");
    }
    this.navigationVersion++;
    const rt = transfer.rt;
    this.runtimes.set(rt.id, rt);
    // A usage read that was already in flight reports to this surface now that
    // the runtime lives here.
    rt.owner = this;
    // The queue and sent manifest travelled with the runtime: adopt the same
    // live state rather than letting a disk snapshot load over it, then persist
    // it under this surface's ownership.
    this.messageStore.adopt(rt.id, rt.messages);
    void this.saveMessages(rt.id);
    rt.client.setHost(this);
    rt.client.on("log", (line: string) => this.log(line));
    rt.client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n, rt));
    rt.client.on("output", (o: CliOutput) => this.onCliOutput(rt, o));
    rt.client.on("stopped", (s: AgentStopped) => this.onAgentStopped(rt, s));
    rt.client.on("revertSteps", (s: RevertStepsUpdate) => this.onRevertSteps(rt, s));
    rt.client.on("exit", () => this.onRuntimeExit(rt));
    rt.terminals.retarget(
      (terminalId, output, exitStatus) => {
        if (this.activeId === rt.id) {
          this.postTerminal(rt.terminals, terminalId, output, exitStatus);
        }
      },
      (line) => this.log(line)
    );
    for (const [key, entry] of transfer.permissions) {
      this.permissionResolvers.set(key, entry);
    }
    for (const [key, entry] of transfer.elicitations) {
      this.elicitationResolvers.set(key, entry);
    }
    for (const [model, supported] of transfer.modelImages) {
      this.modelImageSupport.set(model, supported);
    }
    // This surface is responsible for stopping it now.
    this.spawnedRuntimes.add(rt);
    this.activeId = rt.id;
    const remembered = this.rememberSession(rt.id, rt.cwd, rt);
    this.markVisible(rt.id);
    this.ensureIdleTimer();
    // The agent can die during the handover, when its exit has no listener and is
    // never emitted again, so the arriving surface has to ask.
    if (rt.client.hasExited()) {
      await remembered;
      this.onRuntimeExit(rt);
      return;
    }
    // A turn that was already running is finished by this surface from now on.
    if (rt.busy && rt.turn) {
      void this.adoptTurn(rt, rt.turn);
    }
    this.post({ type: "body", body: "thread" });
    if (rt.busy) {
      // A running turn cannot be replayed by the agent (loading over a live
      // channel kills the prompt), so the chat brings its own transcript with it.
      if (rt.log.length) {
        this.replayLog(rt);
      } else {
        this.post({ type: "clear" });
      }
      this.log(
        `[move] ${rt.id} arrived from ${transfer.from} mid turn: rebuilt ${rt.log.length} ` +
        `transcript ${rt.log.length === 1 ? "part" : "parts"}${rt.logFull ? "" : " (partial, the rest follows this turn)"}`
      );
      // Only what the record could not hold is worth asking the CLI for later.
      rt.needsReplay = !rt.logFull;
      await this.activateSession(rt.id);
    } else if (rt.logFull) {
      this.replayLog(rt);
      await this.activateSession(rt.id);
      this.log(`[move] ${rt.id} arrived from ${transfer.from} idle: restored from the local transcript`);
    } else {
      await this.doLoadSession(rt.id);
      this.log(`[move] ${rt.id} arrived from ${transfer.from} idle: reloaded from the agent`);
    }
    if (this.runtimes.get(rt.id) === rt && this.activeId === rt.id) {
      // The registry travelled with the runtime, so re-announce it for the
      // surface that now owns the chat.
      this.postBackgroundShells(rt);
      for (const terminal of rt.terminals.snapshots()) {
        this.postTerminal(rt.terminals, terminal.terminalId, terminal.output, terminal.exitStatus);
      }
    }
    if (transfer.attachments.length) {
      this.staged.set(this.stagedKey(rt.id), transfer.attachments);
      this.stagedChanged(rt.id);
    }
    // A brand new surface announces its own readiness while this is running, so
    // say once more where it should be: showing the chat, not its session list.
    this.post({ type: "body", body: "thread" });
    this.focus();
    await remembered;
  }

  // --- Runtime pool --------------------------------------------------------

  private active(): Runtime | undefined {
    return this.activeId ? this.runtimes.get(this.activeId) : undefined;
  }

  private destroyRuntime(rt: Runtime): void {
    this.spawnedRuntimes.delete(rt);
    try {
      // Stop listening before stopping the process: everything this runtime could
      // still say is about a session we have finished with, and its exit is about
      // to arrive late enough to be mistaken for a live one's.
      rt.client.removeAllListeners();
      rt.client.dispose();
    } catch {
      // ignore
    }
    try {
      rt.terminals.disposeAll();
    } catch {
      // ignore
    }
  }

  // Every runtime whose process is alive, whether or not it has a session id yet.
  // The pool is keyed by session id, so a runtime waiting on session/new is not in
  // it, and a reload during those seconds left the agent running: it survived the
  // host that spawned it, still holding a lock, and on Windows nothing reaps it.
  private readonly spawnedRuntimes = new Set<Runtime>();

  // Spawn a fresh `devin acp` process and wire its events. The runtime is not
  // yet in the pool: its session id is unknown until session/new or /load.
  private spawnRuntime(cwd: string): Runtime {
    if (this.closed) {
      throw new Error("Chat surface is closed");
    }
    const client = new AcpClient({
      cliPath: this.resolvedCli || "devin",
      cwd,
      env: this.clientEnv(),
      extraArgs: this.extraArgs(),
      diagnostics: this.cfg().get<boolean>("editorContext.diagnostics", true)
    });
    let ref: Runtime | undefined;
    const terminals = new TerminalManager(
      this.clientEnv(),
      cwd,
      (terminalId, output, exitStatus) => {
        // Only the visible session streams terminal output to the webview.
        if (ref && this.activeId === ref.id) {
          this.postTerminal(terminals, terminalId, output, exitStatus);
        }
      },
      (line) => this.log(line),
      new VsCodeTerminalRunner(cwd, this.configuredEnv(), (line) => this.log(line))
    );
    const rt: Runtime = {
      id: "",
      cwd,
      client,
      terminals,
      initialized: false,
      busy: false,
      awaiting: 0,
      replaying: false,
      turnCount: 0,
      lastActivityAt: Date.now(),
      pending: [],
      messages: { queued: [], sent: [], paused: false },
      bgBuffer: [],
      log: [],
      replay: [],
      logFull: true,
      mcpProblems: new Map(),
      steps: [],
      stepsKnown: false,
      stepsRevision: 0,
      openDocuments: new Map(),
      pendingTerminals: [],
      subagentSpawns: [],
      subagentIds: new Map(),
      usageRefreshedAt: 0,
      owner: this
    };
    ref = rt;
    this.spawnedRuntimes.add(rt);
    client.setHost(this);
    client.on("log", (line: string) => this.log(line));
    client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n, rt));
    client.on("output", (o: CliOutput) => this.onCliOutput(rt, o));
    client.on("stopped", (s: AgentStopped) => this.onAgentStopped(rt, s));
    client.on("revertSteps", (s: RevertStepsUpdate) => this.onRevertSteps(rt, s));
    client.on("exit", () => this.onRuntimeExit(rt));
    client.start();
    return rt;
  }

  // The CLI's own output stream. Its MCP channel is the only place a server that
  // would not start is reported: the tool call simply never happens, and a session
  // load the agent aborts over it says nothing about why.
  private onCliOutput(rt: Runtime, out: CliOutput): void {
    this.log(`[${out.channel || "cli"}] ${out.message || ""}`);
    if (out.channel !== "MCP" || (out.level !== "warn" && out.level !== "error")) {
      return;
    }
    const name = /'([^']+)'/.exec(out.message || "")?.[1];
    if (name) {
      rt.mcpProblems.set(name, (out.message || "").trim());
      this.postMcpProblems(rt);
    }
  }

  // Which chat surfaces currently hold the keyboard. A keybinding cannot ask
  // whether focus is inside a webview (`focusedView` is the view pane, and it is
  // not the pane that has focus once the iframe takes it, nor is there a view at
  // all for a chat in an editor tab), so the panel says so itself and this
  // publishes it as a context key for the `when` clauses to use.
  private static readonly focused = new Set<ChatController>();
  // The chat that most recently held the keyboard, kept through the blur into
  // the command palette so an on demand command still lands on the surface the
  // user was in. Cleared when that surface closes.
  private static lastFocused?: ChatController;

  // The chat the keyboard is in, for a shortcut that should act on the chat the
  // user is looking at rather than always on the side panel's.
  static focusedSurface(): ChatController | undefined {
    return [...ChatController.focused][0];
  }

  // The last chat surface to hold focus, for a command reached through the
  // palette rather than a keybinding inside a chat. Closed surfaces are skipped.
  static lastFocusedSurface(): ChatController | undefined {
    const last = ChatController.lastFocused;
    return last && !last.closed ? last : undefined;
  }

  private setFocused(has: boolean): void {
    if (this.closed) {
      has = false;
    }
    const before = ChatController.focused.size;
    if (has) {
      ChatController.focused.add(this);
      ChatController.lastFocused = this;
    } else {
      ChatController.focused.delete(this);
    }
    const now = ChatController.focused.size;
    if (!before !== !now) {
      void vscode.commands.executeCommand("setContext", "devin.chatFocused", now > 0);
    }
  }

  // Muted for this window only ("not again now"): a restart is a fresh start, so
  // a server that is still broken says so again. Turning it off for good is the
  // setting, which this reads too.
  private static mcpMutedHere = false;

  private muteMcpWarnings(scope: string): void {
    if (scope === "always") {
      void this.cfg().update("showMcpWarnings", false, vscode.ConfigurationTarget.Global);
    } else {
      ChatController.mcpMutedHere = true;
    }
  }

  // A command's output, with what can be done about it: opened in the terminal
  // it is really running in, and left running so the agent stops waiting on it.
  private postTerminal(
    terminals: TerminalManager,
    terminalId: string,
    output: string,
    exitStatus: TerminalExitStatus | null
  ): void {
    this.post({
      type: "terminalOutput",
      terminalId,
      output,
      exitStatus,
      integrated: terminals.isIntegrated(terminalId),
      skipped: terminals.isSkipped(terminalId),
      revealed: terminals.isRevealed(terminalId)
    });
  }

  // The skill behind an invocation, opened where it is written. The CLI looks in
  // the workspace first and then the user's own directories, and takes either
  // spelling of the folder, so this looks in the same places in the same order.
  private async openSkill(name: string): Promise<void> {
    if (!name || /[\\/]/.test(name)) {
      return;
    }
    const roots = [
      ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
      userConfigDir(),
      os.homedir()
    ];
    for (const root of roots) {
      for (const dir of [".devin", ".agents", ""]) {
        const file = path.join(root, dir, "skills", name, "SKILL.md");
        if (fs.existsSync(file)) {
          await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
          return;
        }
      }
    }
    void vscode.window.showWarningMessage(`Couldn't find the skill "${name}" on this machine.`);
  }

  // Always posts for the visible chat, including an empty list: the card lives above
  // the composer rather than in the transcript, so it is not swapped out with the
  // thread, and staying silent left the last chat's failures sitting over the next
  // one, telling the user it was missing tools it actually had.
  private postMcpProblems(rt: Runtime): void {
    if (this.activeId !== rt.id) {
      return;
    }
    const muted = ChatController.mcpMutedHere || !this.cfg().get<boolean>("showMcpWarnings", true);
    this.post({
      type: "mcpProblems",
      servers: muted ? [] : [...rt.mcpProblems].map(([name, message]) => ({ name, message }))
    });
  }

  // What a finished turn cost. The CLI hands over its own labelled figures
  // (`responseDimensions`), so the footer shows those rather than inventing names
  // for them, alongside the wall clock time it reports.
  private onAgentStopped(rt: Runtime, stopped: AgentStopped): void {
    const stats = stopped.stats;
    if (!stats) {
      return;
    }
    this.emit(rt, {
      type: "turnStats",
      model: stats.modelLabel,
      totalTimeMs: stats.totalTimeMs,
      dimensions: (stats.responseDimensions || []).map((d) => ({
        label: d.label,
        value: dimensionText(d)
      })).filter((d) => d.label && d.value)
    });
  }

  // A runtime's `devin acp` exited (crash, kill, or idle exit). Drop it from
  // the pool and, if it was the visible one, reflect the disconnected state.
  private onRuntimeExit(rt: Runtime): void {
    // A disposed agent is SIGKILLed on a timer, so its exit can arrive up to a
    // second and a half after we stopped caring, by which time the user may have
    // reopened the session and a NEW runtime holds this id. Deleting by id alone
    // removed that one instead: the live agent kept the CLI's session lock while
    // being invisible to the pool, so the row went gray, Terminate disappeared,
    // the next send met its own lock, and shutdown never stopped it.
    const current = rt.id ? this.runtimes.get(rt.id) : undefined;
    if (current && current !== rt) {
      this.log(`[exit] a replaced agent for ${rt.id} exited, keeping the live one`);
      // Still stop counting the dead one among the agents to stop, or its transcript
      // and buffers are held for the life of the window.
      this.spawnedRuntimes.delete(rt);
      return;
    }
    this.spawnedRuntimes.delete(rt);
    if (rt.id) {
      // Settle any prompt the agent was still waiting on so its client-side
      // call does not hang and no dead widget is left on screen.
      this.settleRequestsFor(rt.id);
      // An agent can also go without us asking: a crash, an external kill, the CLI
      // giving up. Every teardown we start keeps the queued messages, and this is the
      // one where the user is least expecting to lose anything.
      this.keepQueued(rt);
      this.runtimes.delete(rt.id);
      this.starting.delete(rt.id);
    }
    if (this.activeId === rt.id) {
      this.setBusy(false);
      this.statusBar?.set({ connected: false });
      // The side panel says this in its list (the dot goes gray). An editor tab
      // has no list, so the chat itself has to explain why it went quiet.
      if (this.kind === "editor") {
        this.post({ type: "sessionEnded" });
      }
    }
    this.broadcastStatuses();
  }

  private runtimeBySessionId(sessionId?: string, owner?: Runtime): Runtime | undefined {
    if (sessionId && this.runtimes.has(sessionId)) {
      return this.runtimes.get(sessionId);
    }
    // The agent it came from, whenever the caller knows which that is. A session's
    // first updates arrive before `session/new` returns, so its runtime is not in
    // the pool to be found by id, and answering with whatever is on screen painted
    // a chat starting in the background into the chat the user was reading.
    if (owner) {
      return owner;
    }
    // Otherwise the active runtime (e.g. a request that arrives before the
    // session id is stamped, or a client that only serves one session).
    return this.active();
  }

  // --- Status dots ---------------------------------------------------------

  // What this surface is running, and which of them it is showing. Every other
  // surface lists these statuses too, so a change here has to reach them: without
  // it a chat started in a tab is missing from the side panel's list until it is
  // refreshed by hand.
  private ownership = "";

  private broadcastStatuses(): void {
    const own = this.statusMap();
    this.post({ type: "sessionStatuses", statuses: { ...this.surfaces?.statuses(this), ...own }, activeId: this.activeId, elsewhere: this.elsewhere() });
    const owned = `${Object.keys(own).sort().map((id) => `${id}:${own[id]}`).join(",")}|${this.activeId || ""}`;
    if (owned !== this.ownership) {
      this.ownership = owned;
      this.surfaces?.sessionsChanged(this);
    }
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
  }

  // Auto-exit idle (amber) runtimes that have been waiting longer than the
  // keep-alive window. Running sessions are never touched. Item 3.
  private ensureIdleTimer(): void {
    if (this.idleTimer) {
      return;
    }
    this.idleTimer = setInterval(() => this.reapIdleRuntimes(), 30000);
    this.idleTimer.unref?.();
  }

  private reapIdleRuntimes(): void {
    const minutes = this.cfg().get<number>("idleSessionKeepAliveMinutes", 60);
    const limit = Math.floor(this.cfg().get<number>("maxIdleSessions", 3));
    const now = Date.now();
    const idle = [...this.runtimes.values()].filter((rt) => !rt.replaying && !rt.waking && !rt.busy && !rt.rewinding && rt.awaiting === 0 && !rt.terminals.hasRunning());
    const reaped = new Set<Runtime>();
    if (minutes > 0) {
      const maxIdleMs = minutes * 60000;
      for (const rt of idle) {
        if (now - rt.lastActivityAt > maxIdleMs) {
          this.log(`[idle-exit] session ${rt.id} exceeded ${minutes}m idle; exiting`);
          reaped.add(rt);
        }
      }
    }
    if (limit > 0) {
      const remaining = idle.filter((rt) => !reaped.has(rt));
      const excess = remaining.length - limit;
      if (excess > 0) {
        for (const rt of remaining
          .filter((rt) => rt.id !== this.activeId)
          .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
          .slice(0, excess)) {
          this.log(`[idle-exit] session ${rt.id} exceeded the idle session limit; exiting`);
          reaped.add(rt);
        }
      }
    }
    for (const rt of reaped) {
      this.settleRequestsFor(rt.id);
      this.keepQueued(rt);
      this.destroyRuntime(rt);
      this.runtimes.delete(rt.id);
      this.starting.delete(rt.id);
      if (this.activeId === rt.id) {
        // The visible session died; it stays on screen as history and will be
        // re-woken on the next send.
        this.setBusy(false);
      }
    }
    if (reaped.size) {
      this.broadcastStatuses();
    }
  }

  private post(message: unknown): void {
    // postMessage rejects if the webview is being disposed; swallow it so it
    // never surfaces as an unhandled rejection in the extension host.
    this.webview?.postMessage(message).then(undefined, () => {});
  }

  private log(line: string): void {
    this.output.appendLine(line);
  }

  // A session/load the agent aborted (most often because a configured MCP server
  // failed to start, which it treats as fatal). Point the user at the output for
  // the underlying reason rather than showing the opaque agent message.
  private reportLoadFailure(message: string, rt?: Runtime): void {
    this.log(`[load-failed] ${message}`);
    const show = "Show Output";
    // The agent treats an MCP server that will not start as fatal, and it is by
    // far the most common reason a load is aborted. When its output stream named
    // the servers, say which, instead of leaving the user to guess.
    const blamed = rt && rt.mcpProblems.size ? [...rt.mcpProblems.keys()].join(", ") : "";
    void vscode.window
      .showErrorMessage(
        blamed
          ? `Couldn't open this session. These MCP servers failed to start: ${blamed}. See the Devin output for details.`
          : "Couldn't open this session. A configured MCP server may have failed to start, or the session is unavailable. See the Devin output for details.",
        show
      )
      .then((choice) => {
        if (choice === show) {
          this.output.show(true);
        }
      });
  }

  // --- Message handling from the webview ----------------------------------

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case "ready":
          await this.onWebviewReady();
          return;
        case "send":
          await this.handleSend(
            String(msg.text || ""),
            !!msg.newSession,
            !!msg.preserveTranscript,
            msg.kind === "steer" ? "steer" : "queue"
          );
          return;
        case "stopAndSend":
          this.stopAndSend(String(msg.text || ""));
          return;
        case "removeQueued":
          this.removeQueued(String(msg.id || ""));
          return;
        case "editQueued":
          this.editQueued(
            String(msg.id || ""),
            String(msg.text || ""),
            msg.kind === "steer" || msg.kind === "queue" ? msg.kind : undefined
          );
          return;
        case "reorderQueued":
          this.reorderQueued(String(msg.id || ""), String(msg.targetId || ""), !!msg.before);
          return;
        case "sendQueuedNow":
          await this.sendQueuedNow(String(msg.id || ""));
          return;
        case "resumeQueue":
          await this.resumeQueue();
          return;
        case "queueEditing":
          // Which queued message (if any) the composer is editing. Changing it can
          // unblock a flush a completed turn deferred, so re-run the drain.
          this.setQueueEditing(msg.id ? String(msg.id) : undefined);
          return;
        case "cancel":
          this.cancel();
          return;
        case "webviewError":
          this.log(`[webview-error] in "${msg.where}": ${msg.message}`);
          return;
        case "revertPreview":
          if (typeof msg.sessionId === "string" && typeof msg.userMessageId === "string") {
            await this.handleRevertPreview(msg.sessionId, msg.userMessageId, msg.token);
          }
          return;
        case "revertFork":
          if (typeof msg.sessionId === "string" && typeof msg.userMessageId === "string") {
            await this.handleRevertFork(msg.sessionId, msg.userMessageId);
          }
          return;
        case "shareSession":
          await this.shareSession();
          return;
        case "revertExecute":
          if (typeof msg.sessionId === "string" && typeof msg.userMessageId === "string") {
            await this.handleRevertExecute(msg.sessionId, msg.userMessageId, msg.resendText);
          }
          return;
        case "newSession":
          await this.newSession();
          return;
        case "newSessionAt":
          await this.newSessionAt(String(msg.target || "view"));
          return;
        case "openSettings":
          await vscode.commands.executeCommand("devin.openSettings");
          return;
        case "loadSession":
          await this.loadSession(String(msg.id || ""));
          return;
        case "activateSession":
          await this.activateSession(String(msg.id || ""));
          return;
        case "wakeSession":
          await this.wakeSession(String(msg.id || ""));
          return;
        case "renameSession":
          await this.renameSession(String(msg.id || ""), msg.title);
          return;
        case "deleteSession":
          await this.deleteSession(String(msg.id || ""), msg.title);
          return;
        case "refreshSessions":
          // Only the explicit Refresh button forces a re-listing; going back to
          // the list serves the cache and revalidates behind it.
          if (msg.force) {
            await this.refreshSessions(true);
          } else {
            await this.refreshSessionsFast();
          }
          return;
        case "leaveToList":
          this.leaveToList();
          return;
        case "listVisible": {
          const visible = msg.value === true;
          if (this.listVisible !== visible) {
            this.listVisible = visible;
            if (visible && this.surfaceVisible) {
              void this.refreshSessionsFast();
            }
          }
          return;
        }
        case "detachSession":
          await this.surfaces?.detach(String(msg.id || this.activeId || ""));
          return;
        case "attachSession":
          await this.surfaces?.attach(String(msg.id || this.activeId || ""));
          return;
        case "moveHere":
          await this.surfaces?.moveHere(this, String(msg.id || ""));
          return;
        case "revealSession":
          this.revealOwner(String(msg.id || ""));
          return;
        case "stateFlushed":
          this.onStateFlushed();
          return;
        case "refreshUsage":
          // The usage popup asks for fresh figures. Only the visible session is
          // read, and the read is skipped while a real turn owns the channel.
          this.refreshUsage(this.active(), true);
          return;
        case "terminateSession":
          await this.terminateSession(String(msg.id || ""), msg.title, !!msg.returnToList);
          return;
        case "takeoverDecision":
          this.resolveTakeover(String(msg.requestId || ""), String(msg.decision || "cancel"));
          return;
        case "setMode":
          await this.setMode(String(msg.mode || DEFAULT_MODE));
          return;
        case "setModel":
          await this.queueModelConfig(String(msg.model || ""), msg.thoughtLevel, msg.requestId, msg.speed);
          return;
        case "setFusionModel":
          await this.queueModelConfig(String(msg.model || ""), String(msg.thoughtLevel || ""), msg.requestId, msg.speed);
          return;
        case "setConfigOption":
          if ((msg.configId === "thought_level" || msg.configId === "speed") && typeof msg.value === "string") {
            const thought = msg.configId === "thought_level" ? msg.value : msg.thoughtLevel;
            const speed = msg.configId === "speed" ? msg.value : msg.speed;
            await this.queueModelConfig(String(msg.model || this.currentModel || ""), thought, msg.requestId, speed);
            return;
          }
          await this.setSessionConfig(String(msg.configId || ""), msg.value);
          return;
        case "permission":
          this.resolvePermission(String(msg.requestId), msg.optionId);
          return;
        case "subagentMode":
          await this.setSubagentMode(String(msg.id || ""), msg.background === true);
          return;
        case "chatFocus":
          this.setFocused(msg.value === true);
          return;
        case "openSkill":
          await this.openSkill(String(msg.name || ""));
          return;
        case "showTerminal": {
          // Reveal and focus the terminal a command is running in, and say so:
          // the action is named for whether it is hidden.
          const rt = this.active();
          const id = String(msg.terminalId || "");
          if (rt) {
            rt.terminals.show(id);
            this.postTerminal(rt.terminals, id, rt.terminals.output(id).output, rt.terminals.output(id).exitStatus);
          }
          return;
        }
        case "continueInBackground": {
          // The command keeps running; the agent stops waiting for it. Its row
          // says so as soon as the host confirms.
          const rt = this.active();
          const id = String(msg.terminalId || "");
          if (rt && rt.terminals.skip(id)) {
            this.postTerminal(rt.terminals, id, rt.terminals.output(id).output, null);
          }
          return;
        }
        case "querySessions":
          await this.querySessionSearch(msg);
          return;
        case "promptHistory":
          await this.answerPromptHistory(msg);
          return;
        case "stopBackgroundShell":
          await this.stopBackgroundShell(msg);
          return;
        case "muteMcpWarnings":
          this.muteMcpWarnings(String(msg.scope || "window"));
          return;
        case "openDiff":
          // An edit row opens what that edit did; the working set opens what the
          // file is still holding, which is every edit not yet reviewed.
          if (msg.editId) {
            await this.changes.openEdit(String(msg.editId), String(msg.path || ""));
          } else {
            await this.changes.openDiff(String(msg.path || ""));
          }
          return;
        case "openFile":
          await this.openFile(String(msg.path || ""), typeof msg.line === "number" ? msg.line : undefined);
          return;
        case "copyText":
          await vscode.env.clipboard.writeText(String(msg.text || ""));
          return;
        case "insertAtCursor":
          await this.insertAtCursor(String(msg.text || ""));
          return;
        case "applyToFile":
          await this.applyToFile(String(msg.text || ""));
          return;
        case "runInTerminal":
          this.runInTerminal(String(msg.text || ""));
          return;
        case "openExternal":
          if (msg.url) {
            await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
          }
          return;
        case "openAllDiffs":
          await this.openAllDiffs();
          return;
        case "acceptFile":
          this.changes.accept(String(msg.path || ""));
          return;
        case "rejectFile":
          await this.changes.reject(String(msg.path || ""));
          return;
        // From the chat's own changed files tray, so scoped to that chat. The
        // Source Control title buttons stay unscoped: they speak for the view they
        // are in, which lists every chat's files.
        case "acceptAll":
          this.changes.acceptAll(this.activeId);
          return;
        case "rejectAll":
          await this.changes.rejectAll(this.activeId);
          return;
        case "addContext":
          await this.addContext();
          return;
        case "setImplicit":
          this.implicitEnabled = !!msg.enabled;
          await this.cfg().update("implicitContext.enabled", this.implicitEnabled, vscode.ConfigurationTarget.Workspace);
          this.postImplicitContext();
          return;
        case "attachImage":
          this.attachImage(msg.name, msg.mime, msg.data);
          return;
        case "attachDroppedText":
          this.attachDroppedText(msg.name, msg.text);
          return;
        case "attachDroppedFolder":
          this.attachDroppedFolder(msg.name, msg.entries);
          return;
        case "removeAttachment":
          this.removeAttachment(String(msg.id || ""));
          return;
        case "queryFiles":
          await this.queryFiles(String(msg.query || ""));
          return;
        case "addMention":
          await this.addFile(String(msg.path || ""));
          return;
        case "elicitationResponse":
          this.resolveElicitation(String(msg.requestId), String(msg.action || "cancel"), msg.content);
          return;
        case "browseCli":
          await this.browseCli();
          return;
        case "recheck":
          await this.runHealthCheck();
          await this.pushReadiness();
          await this.restoreAfterReady();
          return;
        case "authenticate":
          await this.authenticate();
          return;
        case "setConfig":
          await this.setConfig(msg.key, msg.value);
          return;
        case "draft":
          this.store.setDraft(typeof msg.id === "string" && msg.id ? msg.id : undefined, String(msg.text ?? ""));
          return;
        case "answerDraft":
          this.saveAnswerDraft(String(msg.requestId || ""), msg.state);
          return;
        case "finishSetup":
          this.post({ type: "ready" });
          return;
        default:
          return;
      }
    } catch (err) {
      this.log(`[error] ${err instanceof Error ? err.stack || err.message : String(err)}`);
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      this.setBusy(false);
    }
  }

  private async onWebviewReady(): Promise<void> {
    this.webviewReady = true;
    this.releaseReadyWaiters();
    this.post({ type: "workspace", name: this.workspaceName() });
    // Which surface this is decides the whole chrome (an editor tab is one chat,
    // with no session list and no back button), so it is settled before anything
    // is drawn rather than waiting for the first session to load.
    this.postCapabilities();
    this.postImplicitContext();
    // A prompt left half written before the window closed is put straight back.
    this.postDraft();
    // The CLI health check spawns a login shell and calls the CLI, which can
    // take several seconds. Paint the chat shell immediately using the last
    // known readiness so the sidebar is never blank while it runs; the check
    // below then reconciles (switching to setup only if the CLI is missing or
    // signed out).
    if (this.context.globalState.get<boolean>(ChatController.READY_HINT, false)) {
      this.post({ type: "ready" });
      void this.publishInitialOptions();
    }
    await this.runHealthCheck();
    if (this.closed) {
      return;
    }
    await this.pushReadiness();
    await this.restoreAfterReady();
  }

  private async restoreAfterReady(): Promise<void> {
    if (this.closed || !this.isReady() || this.activeId) {
      return;
    }
    // A freshly opened editor/window surface starts a new session immediately
    // instead of landing on the session list, and one restored after a reload
    // reopens the chat it was holding.
    if (this.autoNewSession) {
      this.autoNewSession = false;
      this.post({ type: "body", body: "thread" });
      await this.newSession();
      return;
    }
    if (this.openOnReady) {
      const id = this.openOnReady;
      this.openOnReady = undefined;
      await this.openSession(id);
      return;
    }
    // Auto-resume only applies to the sidebar surface. Editor/window surfaces
    // that were freshly opened start a new session instead (see onWebviewReady).
    // A window reload builds a brand new webview with an empty transcript, so
    // the session the panel was showing is reopened: without that, the chat you
    // were reading comes back blank until you go to the list and pick it again.
    const viewing = this.store.viewing();
    const last = viewing || this.store.activeId();
    // Always reopen a session whose turn we had to kill on the way out, even
    // when auto-resume is off: landing on the session list with no word of the
    // interruption is the one case where it is genuinely confusing.
    const wasInterrupted = !!last && this.store.interrupted().includes(last);
    const resume = !!viewing || wasInterrupted || this.cfg().get<boolean>("autoResumeLast", false);
    // Another surface may already be running it (an editor tab that outlived a
    // reload), in which case it belongs there and this panel stays on the list.
    const heldElsewhere = !!last && !!this.surfaces?.owner(last, this);
    if (this.kind === "view" && resume && last && !heldElsewhere && !this.painted) {
      this.post({ type: "body", body: "thread" });
      await this.loadSession(last);
    }
  }

  private static readonly READY_HINT = "devin.readyHint.v1";

  async runSetup(): Promise<void> {
    this.focus();
    await this.runHealthCheck();
    this.post({ type: "setup", health: this.publicHealth() });
  }

  // Decides whether the webview shows the setup panel or the chat.
  private async pushReadiness(): Promise<void> {
    // Remember readiness so the next launch can paint the chat shell instantly.
    void this.context.globalState.update(ChatController.READY_HINT, this.isReady());
    if (this.isReady()) {
      this.post({ type: "ready" });
      void this.publishInitialOptions();
      void this.refreshSessionsIfVisible();
    } else if (this.runtimes.size === 0) {
      this.post({ type: "setup", health: this.publicHealth() });
    }
  }

  // --- Config + workspace helpers -----------------------------------------

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("devin");
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  }

  // Whether this window has a workspace of its own to journal prompts into. A
  // folderless window shares the global storage directory with every other
  // folderless window, so its history stays in the runtime's own log instead.
  private hasWorkspace(): boolean {
    return this.folders().length > 0 || !!vscode.workspace.workspaceFile;
  }

  private cwd(): string {
    // Never process.cwd(): for the extension host that is the VS Code install
    // directory, which nothing may write to.
    return this.folders()[0] || os.homedir();
  }

  // A multi-root workspace has no single root, so a new session belongs to the
  // folder the user is actually working in: the active editor's workspace
  // folder, falling back to the first folder (then HOME).
  private resolveNewSessionCwd(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return this.cwd();
  }

  // All workspace folders except the session's own cwd, passed as extra
  // context so the agent can still reach the rest of the workspace.
  private additionalDirs(cwd: string): string[] {
    return this.folders().filter((f) => f !== cwd);
  }

  private workspaceName(): string {
    if (vscode.workspace.workspaceFile) {
      return path.basename(vscode.workspace.workspaceFile.fsPath).replace(/\.code-workspace$/, "");
    }
    return vscode.workspace.workspaceFolders?.[0]?.name || "no folder open";
  }

  // --- CLI health + setup --------------------------------------------------

  private isReady(): boolean {
    return !!this.health?.found && this.health?.loggedIn !== false;
  }

  private publicHealth() {
    return {
      found: !!this.health?.found,
      loggedIn: this.health?.loggedIn,
      version: this.health?.version,
      path: this.health?.path,
      error: this.health?.error
    };
  }

  private async runHealthCheck(): Promise<void> {
    const startedAt = Date.now();
    const setting = this.cfg().get<string>("cliPath", "devin") || "devin";
    this.health = await checkHealth(setting);
    this.resolvedCli = this.health.path || "devin";
    this.env = await loginShellEnv();
    this.log(
      `[health] path=${this.health.path} found=${this.health.found} loggedIn=${this.health.loggedIn} version=${this.health.version || ""} ${this.health.error || ""}`
    );
    // The same environment the agents run with: the account usage read needs
    // the CLI credentials wherever the CLI would find them.
    this.statusBar?.setInfo({ version: this.health.version, account: this.health.account, env: this.clientEnv() });
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.log(`[perf] health-check ${Date.now() - startedAt}ms`);
  }

  private async browseCli(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Select the devin executable"
    });
    if (!picked || !picked.length) {
      return;
    }
    await this.cfg().update("cliPath", picked[0].fsPath, vscode.ConfigurationTarget.Global);
    await this.runHealthCheck();
    await this.pushReadiness();
    await this.restoreAfterReady();
  }

  private async authenticate(): Promise<void> {
    const bin = this.resolvedCli || "devin";
    const term = vscode.window.createTerminal({ name: "Devin Login", env: this.env });
    term.show(true);
    term.sendText(`${quote(bin)} auth login`);
  }

  // Persist a UI preference the webview toggled (e.g. a "don't ask again"
  // checkbox). Allowlisted so the webview cannot write arbitrary settings.
  private static readonly WRITABLE_KEYS = new Set(["editing.confirmEditRequestRemoval", "sessionsPanel.side"]);
  private async setConfig(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== "string" || !ChatController.WRITABLE_KEYS.has(key)) return;
    await this.cfg().update(key, value, vscode.ConfigurationTarget.Global);
  }

  // --- Session management --------------------------------------------------

  private extraArgs(): string[] {
    const v = this.cfg().get<string[]>("extraArgs", []);
    return Array.isArray(v) ? v.map(String) : [];
  }

  private clientEnv(): NodeJS.ProcessEnv {
    return { ...(this.env || process.env), ...this.configuredEnv() };
  }

  // What the user asked to be set, on top of whatever environment the thing
  // being started already has. The integrated terminal takes only this: it opens
  // its own login shell, so handing it a whole cached environment would put a
  // stale copy of that shell's own variables back over it.
  private configuredEnv(): Record<string, string> {
    const extra = this.cfg().get<Record<string, string>>("env", {}) || {};
    // `devin acp` has no --sandbox flag: the env var is the only way in, which is
    // why the sandbox rows in the settings panel did nothing on their own. Set
    // before `devin.env` so an explicit DEVIN_SANDBOX there still wins.
    const sandbox: Record<string, string> = this.cfg().get<boolean>("sandbox", false) ? { DEVIN_SANDBOX: "1" } : {};
    return { ...sandbox, ...extra };
  }

  private async ensureInitialized(rt: Runtime): Promise<void> {
    if (!rt.initialized) {
      await rt.client.initialize();
      rt.initialized = true;
    }
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.health) {
      await this.runHealthCheck();
    }
    if (!this.isReady()) {
      this.post({ type: "setup", health: this.publicHealth() });
      return false;
    }
    return true;
  }

  // Create a brand-new session in its own `devin acp` and make it active.
  private async createSession(navigationVersion = this.navigationVersion): Promise<Runtime> {
    if (this.startingNew && this.startingNewVersion === navigationVersion) {
      return this.startingNew;
    }
    // `starting` is referenced inside its own closure (the runtime's readiness
    // marker is this creation), which only runs after the awaits below, so the
    // definite assignment is safe even though TS cannot prove it here.
    let starting!: Promise<Runtime>;
    starting = (async () => {
      const cwd = this.resolveNewSessionCwd();
      const rt = this.spawnRuntime(cwd);
      try {
        await this.ensureInitialized(rt);
        const res = await rt.client.newSession(cwd, this.additionalDirs(cwd));
        rt.id = res.sessionId;
        rt.messages = this.messageStore.get(rt.id);
        rt.lastActivityAt = Date.now();
        this.runtimes.set(rt.id, rt);
        // The id is real now, so the row can be listed before defaults finish:
        // initializing gates anything that would use the half built runtime.
        rt.initializing = starting;
        await this.rememberSession(rt.id, cwd, rt);
        if (this.listVisible && this.surfaceVisible) {
          this.postSessionList(this.sessionsCache?.sessions ?? []);
        }
        // A brand new session has no saved messages, but the read still has to
        // settle before the session is handed back as ready.
        await this.messageStore.load(rt.id);
        // Starting a chat takes seconds, and the user can open an existing one
        // while it does. It is a real session either way, so it stays in the pool
        // and runs in the background, but it must not take the panel back from
        // whatever they are looking at now. `activeId === undefined` alone cannot
        // tell the sessions list from this new chat, so the navigation that
        // asked for it has to still be the current one.
        const claimed = !this.closed
          && this.navigationVersion === navigationVersion
          && this.activeId === undefined;
        if (claimed) {
          this.activeId = rt.id;
          this.currentMode = undefined;
          this.currentModel = undefined;
          this.currentThoughtLevel = undefined;
          this.markVisible(rt.id);
          this.painted = true;
          this.postCapabilities();
        } else {
          this.log(`[new-session] ${rt.id} arrived after another chat was opened, left in the background`);
        }
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
        await this.applyDefaults(rt, res);
        // Start it off knowing what is already open, rather than waiting for the
        // user to switch files before it has any editor context at all.
        this.sendOpenDocuments(rt);
        // The claim was made before applyDefaults, and the user may have
        // navigated since, so only the navigation that still owns this view
        // gets its draft, staged files and readiness announcement.
        const ownsView = () =>
          !this.closed
          && this.navigationVersion === navigationVersion
          && this.activeId === rt.id
          && this.runtimes.get(rt.id) === rt;
        if (ownsView()) {
          // Whatever was in the "new chat" box has been carried into this session,
          // so it is no longer waiting in the list: the text, and the files staged
          // with it, belong to this chat now.
          this.store.setDraft(undefined, "");
          const carried = this.stagedFor(undefined);
          if (carried.length) {
            this.staged.set(this.stagedKey(rt.id), carried);
          }
          await this.dropStaged(undefined);
          if (ownsView()) {
            this.stagedChanged(rt.id);
            this.post({ type: "sessionReady", sessionId: rt.id });
          }
        }
        this.ensureIdleTimer();
        this.broadcastStatuses();
        this.refreshUsage(rt);
        void this.refreshSessionsIfVisible();
        return rt;
      } catch (err) {
        this.destroyRuntime(rt);
        if (rt.id) {
          this.runtimes.delete(rt.id);
        }
        throw err;
      } finally {
        // Readiness ends with the creation, success or failure, without touching
        // a readiness marker another creation may have left on this runtime.
        if (rt.initializing === starting) {
          rt.initializing = undefined;
        }
      }
    })();
    this.startingNew = starting;
    this.startingNewVersion = navigationVersion;
    try {
      return await starting;
    } finally {
      if (this.startingNew === starting) {
        this.startingNew = undefined;
        this.startingNewVersion = -1;
      }
    }
  }

  // Load a session into `rt`, taking over a lock when needed (item 5): a stale
  // lock (dead owner) is reclaimed automatically; a lock held by a live process
  // prompts the user, and force take-over removes it and loads anyway.
  private async loadWithTakeover(rt: Runtime, id: string, cwd: string): Promise<NewSessionResult | undefined> {
    if (!rt.client.supportsLoadSession()) {
      // Nothing to fall back to: without session/load an existing chat cannot be
      // reopened, and saying so beats a raw "method not found" from the agent.
      throw new Error("This Devin CLI cannot reopen an existing chat. Start a new one instead.");
    }
    const attempt = () =>
      rt.client.loadSession(id, cwd, this.additionalDirs(cwd)) as Promise<NewSessionResult | undefined>;
    try {
      return await attempt();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/currently running|already running|another process|is locked|cannot be resumed/i.test(msg)) {
        throw err;
      }
      const owner = lockOwner(id);
      if (!owner.locked) {
        removeLock(id); // stale lock, dead owner: reclaim and retry
        return await attempt();
      }
      const decision = await this.askTakeover(id, owner.pid);
      if (decision !== "takeover") {
        throw new Error(`This session is open in another Devin process (PID ${owner.pid}). Close it there, or take over.`);
      }
      removeLock(id);
      return await attempt();
    }
  }

  // Ask the webview whether to force take-over a session held by a live process.
  // `rid` is the session the question belongs to, so a chat that moves surface
  // takes only its own with it.
  private readonly takeoverResolvers = new Map<string, { resolve: (d: "takeover" | "cancel") => void; rid: string; timer?: NodeJS.Timeout }>();
  private takeoverSeq = 0;
  private askTakeover(id: string, pid?: number): Promise<"takeover" | "cancel"> {
    const requestId = `lock-${++this.takeoverSeq}`;
    this.post({ type: "lockConflict", requestId, id, pid });
    return new Promise((resolve) => {
      const entry: { resolve: (d: "takeover" | "cancel") => void; rid: string; timer?: NodeJS.Timeout } = { resolve, rid: id };
      this.takeoverResolvers.set(requestId, entry);
      // An unanswered question held the load open for ever, and a load that never
      // returns pins the session: every later attempt to open it waits on the same
      // promise, its row keeps a starting dot, and everything sent to it is queued
      // behind a replay that will not finish. Left long enough to be answered, but
      // not left for the life of the window.
      entry.timer = setTimeout(() => {
        if (!this.takeoverResolvers.has(requestId)) {
          return;
        }
        this.log(`[takeover] no answer for ${id}, treating it as cancelled`);
        this.resolveTakeover(requestId, "cancel");
      }, TAKEOVER_TIMEOUT_MS);
      entry.timer.unref?.();
    });
  }
  private resolveTakeover(requestId: string, decision: string): void {
    const entry = this.takeoverResolvers.get(requestId);
    if (!entry) {
      return;
    }
    this.takeoverResolvers.delete(requestId);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.resolve(decision === "takeover" ? "takeover" : "cancel");
  }

  // Borrow an initialized client for a session-agnostic call (rename/delete),
  // preferring a live runtime and otherwise spawning a short-lived one.
  private async withClient<T>(fn: (client: AcpClient) => Promise<T>): Promise<T> {
    for (const rt of this.runtimes.values()) {
      if (rt.initialized) {
        return fn(rt.client);
      }
    }
    const rt = this.spawnRuntime(this.cwd());
    try {
      await this.ensureInitialized(rt);
      return await fn(rt.client);
    } finally {
      this.destroyRuntime(rt);
    }
  }

  // Leaving the active session for the sessions list. The session keeps running
  // in the background (its runtime stays alive, shown green/amber in the list).
  // Detaching `activeId` is what makes "background" real: a turn still in flight
  // stops streaming into the now-hidden thread, and its completion/error is not
  // posted to the list view. Returning to the session re-attaches (activate).
  private leaveToList(): void {
    this.navigationVersion++;
    this.activeId = undefined;
    if (this.kind === "view") {
      this.store.setViewing(undefined);
    }
    // The composer is a "new chat" box again, so it gets that box's own draft and
    // staged files back, rather than being emptied.
    void this.loadStaged(undefined);
    this.postDraft();
  }

  // Terminate a session's live process (kill its acp + terminals), freeing its
  // lock and turning its dot gray, after a confirmation prompt. The conversation
  // is preserved and can be woken again later. Terminating the open session (or
  // any terminate that asks) returns to the sessions list.
  private async terminateSession(id: string, title?: string, returnToList?: boolean): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Terminate the session "${title || id}"? This stops its running process. The conversation is kept and can be resumed later.`,
      { modal: true },
      "Terminate"
    );
    if (choice !== "Terminate") {
      return;
    }
    // The runtime may have changed while the modal was open; re-read it.
    const live = this.runtimes.get(id);
    if (!live) {
      return;
    }
    this.settleRequestsFor(id);
    this.keepQueued(live);
    this.destroyRuntime(live);
    this.runtimes.delete(id);
    this.starting.delete(id);
    const wasActive = this.activeId === id;
    if (wasActive) {
      this.setBusy(false);
    }
    this.broadcastStatuses();
    // Terminating the open session returns to the list; otherwise just refresh.
    if (returnToList || wasActive) {
      await this.closeOutSession();
    } else {
      void this.refreshSessionsIfVisible();
    }
  }

  // Nothing left to show for the chat this surface was on. The side panel falls
  // back to its session list. An editor tab is one chat, so it stays on it: the
  // transcript remains, a send wakes the agent again, and a chat that could not
  // be opened at all says so in place of the transcript.
  private async closeOutSession(reason?: string): Promise<void> {
    if (this.kind === "view") {
      await this.showSessionsView();
      return;
    }
    if (reason) {
      this.post({ type: "loaded" });
      this.post({ type: "error", text: reason });
    }
  }

  // Start a new session in a chosen location. "view" is this surface; the
  // others run the corresponding registered command (handled by ChatManager).
  private async newSessionAt(target: string): Promise<void> {
    switch (target) {
      case "editor":
        await vscode.commands.executeCommand("devin.newSessionEditor");
        return;
      case "window":
        await vscode.commands.executeCommand("devin.newSessionWindow");
        return;
      case "terminal":
        await vscode.commands.executeCommand("devin.newSessionTerminal");
        return;
      default:
        await this.newSession();
        return;
    }
  }

  async newSession(): Promise<void> {
    const navigationVersion = ++this.navigationVersion;
    if (!(await this.ensureReady())) {
      return;
    }
    if (this.closed || this.navigationVersion !== navigationVersion) {
      return;
    }
    // The previous session (if any) is left alive in the background and keeps its
    // own edits tracked; the clear below starts this chat with an empty one. What
    // was staged in the "new chat" box comes with it: that is what it was for.
    this.activeId = undefined;
    await this.loadStaged(undefined);
    if (this.closed || this.navigationVersion !== navigationVersion) {
      return;
    }
    this.focus();
    this.post({ type: "body", body: "thread" });
    // `reset` tells the webview this is a fresh session so it clears the title
    // (and code badge) instead of keeping the previous session's.
    this.post({ type: "clear", reset: true });
    try {
      await this.createSession(navigationVersion);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.closed && this.navigationVersion === navigationVersion) {
        this.post({ type: "error", text: message });
      } else {
        this.log(`[new-session] ${message}`);
      }
    }
  }

  // Tell the thread, once, that this session's turn was killed by a window reload
  // or an extension shutdown, so an interrupted turn is visible and re-sendable
  // rather than silently missing.
  private reportInterrupted(id: string): void {
    if (!this.store.interrupted().includes(id)) {
      return;
    }
    this.store.clearInterrupted(id);
    this.post({ type: "interrupted" });
  }

  // Open a session: reuse its live runtime if it is already alive, otherwise
  // wake it (spawn a fresh acp and load its history). Either way the session is
  // alive when this returns. Item 4.
  private async loadSession(id: string): Promise<void> {
    if (!id) {
      return;
    }
    const navigationVersion = ++this.navigationVersion;
    if (!(await this.ensureReady())) {
      return;
    }
    if (this.closed || this.navigationVersion !== navigationVersion) {
      return;
    }
    if (this.openedElsewhere(id)) {
      return;
    }
    const inflight = this.loading.get(id);
    if (inflight) {
      // A load/wake for this session is already running; make it the active one
      // and share its result rather than spawning a second acp.
      this.activeId = id;
      await inflight;
      // The shared operation just finished. If the panel is still on this
      // session, rebuild its transcript from the local log: the webview that
      // asked is showing a loader the silent wake never painted a replay for.
      if (this.activeId === id && this.runtimes.has(id)) {
        const rt = this.runtimes.get(id);
        if (rt && !rt.logFull) {
          // It left no complete local record (a failed reload keeps the runtime
          // but marks the log partial), so this request still needs the agent's
          // history. `loading` is clear by now, so run the load again.
          await this.loadSession(id);
        } else {
          await this.activateSession(id, true);
        }
      }
      return;
    }
    const p = this.doLoadSession(id);
    this.loading.set(id, p);
    try {
      await p;
    } finally {
      this.loading.delete(id);
      // Anything typed while it was opening was queued rather than sent. The
      // load's own flush ran while `loading` still held the id and gated out,
      // so the drain happens here, the same as a wake's does.
      const opened = this.runtimes.get(id);
      if (opened) {
        this.flushQueue(opened);
      }
    }
  }

  private async doLoadSession(id: string): Promise<void> {
    const already = this.runtimes.get(id);
    // Never reload a session whose turn is in flight: issuing a loadSession over
    // its live channel aborts the running prompt ("channel closed"). Re-attach
    // to the running runtime instead (it keeps streaming), rebuilding the
    // transcript the requesting webview has no copy of. The same seam serves a
    // complete local transcript: replaying it locally costs nothing and avoids
    // a second ACP load of history the runtime already proved it has. A runtime
    // still being created joins them: session/load over it would race the
    // creation, so activateSession waits on its readiness instead.
    if (already && (already.busy || already.rewinding || already.initializing || (already.logFull && !already.replaying && !already.waking))) {
      await this.activateSession(id, true);
      return;
    }
    const startedAt = Date.now();
    this.activeId = id;
    // A full reload rebuilds the whole transcript, so any buffered background
    // stream for this runtime is superseded, as is any replay it was owed.
    if (already) {
      already.bgBuffer = [];
      already.needsReplay = false;
      // The transcript is about to be rebuilt from the agent, so the record of
      // what is painted starts again with it.
      already.log = [];
      already.replay = [];
      already.logFull = true;
      already.steps = [];
      already.stepsKnown = false;
      already.stepsRevision++;
    }
    // "Waking session…" while a fresh acp spins up; a live one loads instantly.
    this.post({ type: "clear", loading: true, waking: !already });
    // Name the session before anything keyed on it: the stored draft is only
    // accepted for the session the composer belongs to.
    this.painted = true;
    this.post({ type: "sessionReady", sessionId: id, title: this.store.titles()[id] });
    // The clear empties the working set and the composer, so re-send this
    // session's own pending edits, unsent text and staged files: a reload throws
    // none of them away.
    this.postWorkingSet();
    this.postDraft();
    const staged = this.loadStaged(id);
    // The saved queue and sent manifest hydrate alongside the staged files, but
    // must be settled before the replay starts: user_message_chunk updates are
    // matched against it as they arrive.
    const messagesReady = this.messageStore.load(id);
    if (!already) {
      this.starting.add(id);
    }
    this.broadcastStatuses();

    const cwd = this.store.cwds()[id] || this.resolveNewSessionCwd();
    const rt = already ?? this.spawnRuntime(cwd);
    if (!already) {
      rt.id = id;
      rt.messages = this.messageStore.get(id);
      this.runtimes.set(id, rt);
    }
    rt.replaying = true;
    rt.replayUser = undefined;
    rt.replaySentIndex = 0;
    let loadFailed = "";
    try {
      if (!already) {
        await this.ensureInitialized(rt);
      }
      this.postCapabilities();
      try {
        await messagesReady;
      } catch (err) {
        // A corrupt snapshot is reported rather than silently read as empty,
        // and its file is left in place: replay then falls back to rebuilding
        // each request from the blocks the agent actually sends.
        this.reportMessageRestoreFailure(id, err);
      }
      const res = await this.loadWithTakeover(rt, id, cwd);
      // The last user_message_chunk of the history may have no following
      // transcript update to flush it, including a user only interrupted tail.
      this.flushReplayUser(rt);
      await staged;
      rt.lastActivityAt = Date.now();
      await this.rememberSession(id, cwd, rt);
      // Loading a chat means spawning an agent and replaying its history, which
      // takes seconds, and nothing stops the user picking a different chat while
      // it runs. Everything below speaks for the panel, so it only applies if this
      // is still the chat the panel is showing.
      if (this.activeId === id) {
        this.markVisible(id);
      }
      if (res && (res.configOptions || res.modes)) {
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      // A woken session starts knowing nothing about the editor, same as a new one.
      this.sendOpenDocuments(rt);
      if (this.activeId === id) {
        this.post({ type: "assistantEnd" });
        this.post({ type: "sessionReady", sessionId: id });
        // A reload over a live runtime keeps its shell registry, so announce
        // it again for the rebuilt transcript.
        this.postBackgroundShells(rt);
      }
      this.ensureIdleTimer();
    } catch (err) {
      // Waking failed: drop the half-spawned runtime so the row goes gray again.
      // `activeId` is left alone here: the finally block decides whether this
      // failure is on screen before clearing it, because clearing it early used
      // to make a visible failure look like a background one.
      if (!already) {
        this.destroyRuntime(rt);
        this.runtimes.delete(id);
      }
      loadFailed = err instanceof Error ? err.message : String(err);
    } finally {
      rt.replaying = false;
      if (loadFailed) {
        // A failed replay is incomplete, so the local record can no longer
        // stand in for the agent's history on the next open.
        rt.replay = [];
        rt.logFull = false;
        rt.replayUser = undefined;
        rt.replaySentIndex = 0;
      }
      this.starting.delete(id);
      if (loadFailed) {
        // The agent aborted the load (commonly because a configured MCP server
        // failed to initialise, which it treats as fatal, or the session no
        // longer exists). Don't strand the user on a broken empty thread: return
        // to the list with a clear message. Drop the cached listing first so a
        // session that has since been deleted elsewhere cannot be served back
        // from the cache and clicked again.
        this.sessionsCache = undefined;
        this.broadcastStatuses();
        // Only if the user is still on this chat. Closing out would otherwise send
        // them back to the list from a chat that opened perfectly well. A cold
        // load's runtime is already gone, so its id has to be released here. A
        // live runtime keeps it so an editor surface's Retry still names it.
        if (this.activeId === id) {
          if (!already) {
            this.navigationVersion++;
            this.activeId = undefined;
          }
          await this.closeOutSession(OPEN_FAILED);
          this.reportLoadFailure(loadFailed, rt);
        } else {
          this.log(`[load-failed] ${id} (no longer on screen): ${loadFailed}`);
        }
      } else {
        const updateHead = this.activeId === id;
        if (updateHead) {
          this.flushReplay(rt);
          this.post({ type: "loaded" });
          this.reportInterrupted(id);
        } else {
          rt.replay = [];
        }
        this.broadcastStatuses();
        // Re-surface permissions/questions this session raised while it was in
        // the background, now that it is visible again.
        const opened = this.runtimes.get(id);
        if (opened && this.activeId === id) {
          for (const p of opened.pending) {
            this.post(p.payload);
          }
          // Republish the queue so any messages still waiting on this session
          // reappear after a reload, not just after an instant re-attach.
          this.postQueued(id);
          this.postMcpProblems(opened);
        }
        // Anything typed while it was opening has been waiting for the channel.
        if (opened) {
          this.flushQueue(opened);
        }
        if (updateHead && opened && !opened.busy && !opened.rewinding) {
          void this.refreshCheckpoints(opened);
        }
        if (opened) {
          this.refreshUsage(opened);
        }
        void this.refreshSessionsIfVisible();
      }
      this.log(`[perf] session-load ${already ? "live" : "cold"} ${Date.now() - startedAt}ms`);
    }
  }

  // Re-show an already-alive session WITHOUT reloading its history: the webview
  // has kept its rendered transcript and restores it locally, so we only need to
  // re-point the active session and refresh the composer chrome. Falls back to a
  // full wake/load if the runtime is not alive. Item: switch without reload.
  private async activateSession(id: string, replay = false): Promise<void> {
    const navigationVersion = ++this.navigationVersion;
    const rt = this.runtimes.get(id);
    if (!rt) {
      await this.loadSession(id);
      return;
    }
    this.activeId = id;
    // A session still being created has no settled state to paint: wait for its
    // creation, then bail if the user has moved on or it failed meanwhile.
    if (rt.initializing) {
      try {
        await rt.initializing;
      } catch (err) {
        this.log(`[new-session-failed] ${err instanceof Error ? err.message : String(err)}`);
        if (!this.closed && this.navigationVersion === navigationVersion && this.activeId === id) {
          await this.closeOutSession(OPEN_FAILED);
        }
        return;
      }
      if (this.closed || this.navigationVersion !== navigationVersion || this.activeId !== id || this.runtimes.get(id) !== rt) {
        return;
      }
    }
    if (replay) {
      // The caller has no usable transcript (a full load was asked for over a
      // busy or still-waking session), so rebuild from the recorded log: this
      // clears the loader, replays what was painted and empties the buffer of
      // anything the log already covers.
      this.replayLog(rt);
    }
    this.markVisible(id);
    this.sendOpenDocuments(rt);
    this.postWorkingSet();
    // The composer belongs to this chat now, so it shows this chat's own unsent
    // text and staged files, not the ones from wherever we just were.
    await this.loadStaged(id);
    // The awaits above can outlive this activation: the user can open another
    // chat, or this runtime can be replaced, while staged files load. Nothing
    // below may paint into a session that is no longer the one on screen.
    if (this.closed || this.navigationVersion !== navigationVersion || this.activeId !== id || this.runtimes.get(id) !== rt) {
      return;
    }
    this.postDraft();
    this.currentMode = rt.mode;
    this.currentModel = rt.model;
    this.currentThoughtLevel = thoughtOption(rt.configOptions)?.currentValue as string | undefined;
    this.currentSpeed = speedOption(rt.configOptions)?.currentValue as string | undefined;
    this.postCapabilities();
    this.postModelOptions(rt.model || "adaptive", rt.configOptions);
    if (rt.mode) {
      this.post({ type: "mode", mode: rt.mode });
    }
    if (rt.model) {
      this.post({ type: "model", model: rt.model });
    }
    this.post({ type: "busy", value: rt.busy });
    // Which servers failed to start belongs to the agent behind this chat, so the
    // card above the composer is re-derived for the chat now on screen rather than
    // being left saying what was wrong with the last one.
    this.postMcpProblems(rt);
    // Name the session: a surface handed a chat never called into `switchToSession`,
    // so without this its header, terminate and move controls have no session.
    this.painted = true;
    this.post({ type: "sessionReady", sessionId: id, title: this.store.titles()[id] });
    // Restore the role marker a backgrounded turn has reached. It is ephemeral
    // chrome, so it posts directly rather than riding the transcript buffers.
    this.post({
      type: "modelActivity",
      sessionId: id,
      model: rt.model,
      role: rt.modelActivity && rt.modelActivity.model === rt.model ? rt.modelActivity.role : null
    });
    // Same for the background shell registry: ephemeral state that a surface
    // switch or reload must re-announce, since it is never in the transcript.
    this.postBackgroundShells(rt);
    // Replay anything the turn streamed while this session was in the background
    // (including a turn still running), so the restored transcript catches up
    // instead of showing the stale state from when the user left.
    this.flushBgBuffer(rt);
    this.broadcastStatuses();
    // An instant restore does not reload, so the step list stays valid. While a
    // turn or a rewind is in flight the read is skipped so it never contends with
    // the running prompt, but the bindings still publish: a rewind in progress
    // is exactly the state the checkpoint controls must show as busy.
    if (!rt.busy && !rt.rewinding) {
      await this.refreshCheckpoints(rt);
    } else {
      rt.owner.postCheckpoints(rt);
    }
    // refreshCheckpoints awaited too: the same activation may have been superseded
    // while the steps were read, so check again before showing its pending widgets.
    if (this.closed || this.navigationVersion !== navigationVersion || this.activeId !== id || this.runtimes.get(id) !== rt) {
      return;
    }
    // Re-surface any prompts this session raised while backgrounded.
    for (const p of rt.pending) {
      this.post(p.payload);
    }
    // Restore the composer's queued-message rows for this session.
    this.postQueued(id);
    this.refreshUsage(rt);
    void this.refreshSessionsIfVisible();
  }

  // A session is already running on another surface. Two panels cannot share one
  // agent, so the chat opens as a placeholder saying where it is, with a button
  // that brings it here. Returns true when this surface should not open it itself.
  private openedElsewhere(id: string): boolean {
    const owner = this.surfaces?.owner(id, this);
    if (!owner) {
      return false;
    }
    this.post({
      type: "elsewhere",
      id,
      where: this.surfaces!.label(owner),
      here: this.kind === "view" ? "the side panel" : "this tab",
      title: this.store.titles()[id]
    });
    void this.refreshSessionsIfVisible();
    return true;
  }

  // Bring the surface running a chat to the front, for the placeholder's second
  // action ("show it where it is").
  private revealOwner(id: string): void {
    const owner = id ? this.surfaces?.owner(id, this) : undefined;
    if (owner) {
      this.surfaces!.reveal(owner);
    }
  }

  // Seamlessly bring a dead (terminated / idle-exited) session back to life when
  // the webview already shows its cached transcript: spawn a fresh acp and load
  // its history WITHOUT clearing the thread or streaming a replay ("Waking…"
  // spinner). The row shows a "starting" dot until it is interactive. A send
  // that races the wake waits on `rt.waking`.
  private async wakeSession(id: string, select = true): Promise<void> {
    if (!id) {
      return;
    }
    const navigationVersion = select ? ++this.navigationVersion : this.navigationVersion;
    if (!(await this.ensureReady())) {
      return;
    }
    if (this.closed || (select && this.navigationVersion !== navigationVersion)) {
      return;
    }
    if (select) {
      if (this.openedElsewhere(id)) {
        return;
      }
    } else if (this.surfaces?.owner(id, this)) {
      // A background wake must not post an elsewhere placeholder into another chat.
      return;
    }
    const inflight = this.loading.get(id);
    if (inflight) {
      // A load/wake for this session is already spawning an acp, so share it. The
      // runtime it installs can be present while the load is still running, so
      // this has to be checked before runtimes.has or the caller would prompt a
      // half loaded session.
      if (select) {
        this.activeId = id;
      }
      return inflight;
    }
    const live = this.runtimes.get(id);
    if (live) {
      if (select) {
        await this.activateSession(id);
      } else if (live.initializing) {
        // A background wake asked for a runtime that is still being created:
        // wait for its readiness so the caller never prompts a half session.
        await live.initializing.catch(() => undefined);
      }
      return;
    }
    const p = this.doWakeSession(id, select);
    this.loading.set(id, p);
    try {
      await p;
    } finally {
      this.loading.delete(id);
      // Anything typed while it was waking was queued rather than sent, because
      // the channel was busy. A load drains its queue on the way out and a wake
      // did not, so that message sat there until some later turn finished, out of
      // order, or until the user noticed and sent it by hand.
      const opened = this.runtimes.get(id);
      if (opened) {
        this.flushQueue(opened);
      }
    }
  }

  private async doWakeSession(id: string, select = true): Promise<void> {
    const startedAt = Date.now();
    if (select) {
      this.activeId = id;
      this.postWorkingSet();
      this.postDraft();
    }
    const staged = this.loadStaged(id);
    const messagesReady = this.messageStore.load(id);
    const cwd = this.store.cwds()[id] || this.resolveNewSessionCwd();
    const rt = this.spawnRuntime(cwd);
    rt.id = id;
    rt.messages = this.messageStore.get(id);
    this.runtimes.set(id, rt);
    rt.replaying = true;
    rt.silentReplay = true;
    rt.replayUser = undefined;
    rt.replaySentIndex = 0;
    this.starting.add(id);
    this.broadcastStatuses();
    let done: () => void = () => {};
    let wakeFailed = "";
    rt.waking = new Promise<void>((resolve) => { done = resolve; });
    try {
      await this.ensureInitialized(rt);
      try {
        await messagesReady;
      } catch (err) {
        this.reportMessageRestoreFailure(id, err);
      }
      const res = await this.loadWithTakeover(rt, id, cwd);
      this.flushReplayUser(rt);
      await staged;
      rt.lastActivityAt = Date.now();
      await this.rememberSession(id, cwd, rt);
      // A wake takes seconds too, so this only speaks for the panel while the panel
      // is still showing this chat, the same as loading one does. Recording it as
      // the chat being viewed regardless sent the next window reload to the chat the
      // user had left rather than the one they were reading.
      if (this.activeId === id) {
        this.markVisible(id);
      }
      if (res && (res.configOptions || res.modes)) {
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      // A woken session starts knowing nothing about the editor, same as a new one.
      this.sendOpenDocuments(rt);
      this.postCapabilities();
      if (this.activeId === id) {
        this.post({ type: "sessionReady", sessionId: id });
        this.reportInterrupted(id);
      }
      // A queue restored with this wake is paused until Resume Queue, but its
      // rows still have to reach the composer that is showing this chat.
      this.postQueued(id);
      this.ensureIdleTimer();
    } catch (err) {
      if (this.runtimes.get(id) === rt) {
        this.destroyRuntime(rt);
        this.runtimes.delete(id);
      }
      wakeFailed = err instanceof Error ? err.message : String(err);
    } finally {
      rt.replaying = false;
      rt.silentReplay = false;
      rt.replayUser = undefined;
      rt.replaySentIndex = 0;
      rt.waking = undefined;
      this.starting.delete(id);
      this.broadcastStatuses();
      if (wakeFailed) {
        // The agent could not reload this session: return to the list rather
        // than leaving a stale, non interactive transcript on screen. Only if the
        // user is still on it, though. A wake takes seconds, and closing out after
        // they have moved to another chat rips them out of the one they are reading
        // to report a failure in the one they left. The runtime is already gone,
        // so its id has to be released here before the close out.
        this.sessionsCache = undefined;
        if (this.activeId === id) {
          this.navigationVersion++;
          this.activeId = undefined;
          await this.closeOutSession(OPEN_FAILED);
          this.reportLoadFailure(wakeFailed, rt);
        } else {
          this.log(`[wake-failed] ${id} (no longer on screen): ${wakeFailed}`);
        }
      }
      const updateHead = !wakeFailed && this.activeId === id;
      done();
      if (updateHead && !rt.busy && !rt.rewinding) {
        void this.refreshCheckpoints(rt);
      }
      if (!wakeFailed) {
        this.refreshUsage(rt);
      }
      this.log(`[perf] session-wake ${Date.now() - startedAt}ms`);
    }
  }

  private sessionsCache?: { at: number; sessions: DevinSession[] };
  private sessionsRefreshing?: Promise<void>;
  private sessionsRefreshingIds?: string;
  private sessionsRefreshingGeneration?: number;
  private sessionsForcePending = false;
  private sessionListGeneration = 0;

  // `force` bypasses the short TTL cache (used for explicit refresh/rename/delete);
  // implicit refreshes after a load/prompt reuse the cache to avoid respawning
  // `devin list` repeatedly.
  // `staleOk` serves the cache at any age (used when returning to the list, so it
  // paints instantly) and is paired with a background revalidate.
  // List through a live agent when there is one, which costs no process at all,
  // rather than spawning `devin list` once per directory. Returns undefined when
  // nothing is live, leaving the CLI path to answer a cold panel (measured at
  // roughly the same cost as spawning an agent purely to ask, so there is nothing
  // to gain by starting one).
  private listOverProtocol(): Promise<ListResult> | undefined {
    const client = this.anyLiveClient() || this.surfaces?.sessionListClient(this);
    if (!client) {
      return undefined;
    }
    const ids = this.store.ids();
    return client
      .listSessions(SESSION_LIST_ACP_TIMEOUT_MS)
      .then((rows) => {
        // No rows at all, from an agent that has a session of its own to report, is
        // not an answer about the user's sessions: it is the call not working (a
        // renamed field after a CLI upgrade, a reset store). Fall back rather than
        // paint an empty list.
        if (!rows.length && ids.length) {
          throw new Error("session/list answered with no sessions");
        }
        return fromAcpRows(rows, ids);
      })
      .catch((err) => {
        // An agent that cannot answer must not empty the list: fall back for this
        // refresh and let the next one try again.
        this.log(`[list-over-acp-failed] ${err instanceof Error ? err.message : String(err)}`);
        return listSessions({
          cliPath: this.resolvedCli || "devin",
          env: this.clientEnv(),
          timeoutMs: SESSION_LIST_CLI_TIMEOUT_MS,
          folders: this.folders(),
          trackedIds: ids,
          cwdById: this.store.cwds()
        });
      });
  }

  // Any agent that has finished initialize, since `session/list` belongs to the
  // connection rather than to a session.
  private anyLiveClient(): AcpClient | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.initialized && !rt.client.hasExited()) {
        return rt.client;
      }
    }
    return undefined;
  }

  // What the session list surfaces can actually ask of `session/list` here: the
  // agent that would answer, or nothing when there is none, so the filter menus
  // know before offering a sort the agent cannot serve.
  private sessionListCaps(): SessionListCapabilities {
    const client = this.anyLiveClient() || this.surfaces?.sessionListClient(this);
    return client?.sessionListCapabilities() || { contentSearch: false, orderBy: [], sortDirection: false };
  }

  // A filtered `session/list` for a list surface's search box. The answer is
  // display data only: rows are filtered back to ids this window still tracks
  // before they are mapped, and nothing here touches membership, the cache, or
  // the store, so a search can never prune a session.
  private async querySessionSearch(msg: any): Promise<void> {
    const requestId = String(msg.requestId || "");
    const query = String(msg.query || "").trim();
    const orderBy: "updated_at" | "created_at" = msg.orderBy === "created_at" ? "created_at" : "updated_at";
    const sortDirection: "asc" | "desc" = msg.sortDirection === "asc" ? "asc" : "desc";
    const client = this.anyLiveClient() || this.surfaces?.sessionListClient(this);
    const caps = () => client?.sessionListCapabilities() || { contentSearch: false, orderBy: [], sortDirection: false };
    const respond = (fields: Record<string, unknown>) =>
      this.post({ type: "sessionSearchResults", requestId, capabilities: caps(), ...fields });
    if (!client) {
      // No live agent to ask, and searching is not worth spawning one: the
      // webview falls back to its cached list and title filter.
      respond({ contentSearch: false, serverSorted: false });
      return;
    }
    // Whether the query really went out as content is only known against what
    // the agent advertised, and whether it still counts after the call is only
    // known once a rejected `_meta` has had its say.
    const wanted: SessionListQuery = { content: query || undefined, orderBy, sortDirection };
    const sentContent = !!query && client.sessionListCapabilities().contentSearch;
    const trackedAtStart = new Set(this.store.ids());
    try {
      const rows = await client.listSessions(SESSION_LIST_ACP_TIMEOUT_MS, wanted);
      const trackedNow = new Set(this.store.ids());
      const after = client.sessionListCapabilities();
      respond({
        sessions: rows
          .filter((row) => row && trackedAtStart.has(row.sessionId) && trackedNow.has(row.sessionId))
          .map(fromAcpRow),
        contentSearch: sentContent && after.contentSearch,
        serverSorted: after.orderBy.includes(orderBy) && after.sortDirection
      });
    } catch (err) {
      // The query text never reaches the log: the failure is the protocol's,
      // not the user's words.
      const code = (err as { code?: number })?.code;
      this.log(`[session-search-failed] ${typeof code === "number" ? `rpc ${code}` : "request failed"}`);
      respond({ contentSearch: false, serverSorted: false, error: "Could not search sessions." });
    }
  }

  // The composer's prompt history picker reads this window's own journal: only
  // prompts this extension submitted, scoped to the exact directory the chat
  // belongs to. The CLI's global input history names no owner, so it is never a
  // source. Exactly one reply goes out per request.
  private async answerPromptHistory(msg: any): Promise<void> {
    const requestId = String(msg.requestId || "");
    const sessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : null;
    const reply = (fields: Record<string, unknown>) =>
      this.post({ type: "promptHistorySelected", requestId, sessionId, ...fields });
    // A request that does not name the session (or the new chat box) on screen
    // here is stale or foreign: it gets an empty answer and never opens a picker.
    if (this.closed || sessionId !== (this.activeId || null)) {
      reply({});
      return;
    }
    const workspace = this.hasWorkspace();
    const cwd = this.promptHistoryCwd(sessionId, workspace);
    let texts: string[];
    let placeHolder: string;
    let emptyLabel: string;
    if (workspace) {
      if (!cwd) {
        // An active session with no known directory has no honest owner, so it
        // gets no text rather than another folder's history.
        reply({});
        return;
      }
      texts = this.store.promptHistory(cwd);
      placeHolder = `Prompts from ${cwd}`;
      emptyLabel = "No prompts have been recorded for this folder yet.";
    } else {
      texts = this.runtimePromptTexts(sessionId ? this.runtimes.get(sessionId) : undefined);
      placeHolder = "Prompts from this conversation";
      emptyLabel = "No prompts have been recorded for this conversation yet.";
    }
    const pick = await this.pickPromptHistory(texts, placeHolder, emptyLabel);
    // The picker can stay open while the user moves on: a different chat, a
    // closed surface, or a new chat retargeted to another folder all void the
    // answer rather than insert the wrong scope's prompt.
    if (this.closed || sessionId !== (this.activeId || null) || this.hasWorkspace() !== workspace
      || this.promptHistoryCwd(sessionId, workspace) !== cwd) {
      reply({});
      return;
    }
    if (pick.error) {
      reply({ error: "Could not load prompt history." });
    } else if (pick.text !== undefined) {
      reply({ text: pick.text });
    } else {
      // Cancellation and an informational row both land here: no text is the
      // whole answer.
      reply({});
    }
  }

  // The directory a history request is scoped to: the live runtime's cwd wins,
  // then the saved one for a session with no agent running, and the new chat
  // resolver for the composer that has no session yet. Undefined means there is
  // no honest owner for the request.
  private promptHistoryCwd(sessionId: string | null, workspace: boolean): string | undefined {
    if (sessionId) {
      return this.runtimes.get(sessionId)?.cwd || this.store.cwds()[sessionId] || undefined;
    }
    return workspace ? this.resolveNewSessionCwd() : undefined;
  }

  // A folderless window keeps no workspace journal, so its picker can only
  // offer what this runtime itself submitted, newest first, under the same
  // rules and limit the store applies. Replayed chunks are a different payload
  // type and never land in the log as userMessage.
  private runtimePromptTexts(rt: Runtime | undefined): string[] {
    if (!rt) {
      return [];
    }
    const texts: string[] = [];
    const seen = new Set<string>();
    for (let i = rt.log.length - 1; i >= 0 && texts.length < SessionStore.MAX_PROMPTS; i--) {
      const entry = rt.log[i];
      const text = entry && entry.type === "userMessage" ? entry.text : undefined;
      if (typeof text !== "string" || !text.trim() || text.length > SessionStore.MAX_DRAFT || seen.has(text)) {
        continue;
      }
      seen.add(text);
      texts.push(text);
    }
    return texts;
  }

  // The picker opens over the journal, which is local and immediate, so its
  // items are ready at once. Informational rows carry no `text`, so they can
  // never be handed back as a prompt, and `alwaysShow` keeps a typed query from
  // filtering the explanation away.
  private async pickPromptHistory(
    texts: string[],
    placeHolder: string,
    emptyLabel: string
  ): Promise<{ text?: string; error?: boolean }> {
    type HistoryItem = vscode.QuickPickItem & { text?: string };
    const info = (label: string, detail?: string): HistoryItem => ({
      label,
      ...(detail ? { detail } : {}),
      alwaysShow: true
    });
    const items: HistoryItem[] = texts.length
      ? texts.map((text) => {
          const flat = text.replace(/\s+/g, " ").trim();
          return {
            label: flat.length > 80 ? `${flat.slice(0, 80)}...` : flat,
            detail: text,
            text
          };
        })
      : [info(emptyLabel, "History records prompts sent through this extension.")];
    try {
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder,
        matchOnDetail: true
      });
      return picked && typeof picked.text === "string" ? { text: picked.text } : {};
    } catch {
      return { error: true };
    }
  }

  // Record what a live tool update says about background shells, then publish
  // the change as ephemeral state. Replays and silent wakes are excluded: the
  // registry authorizes an action, so it must reflect what is running now, not
  // what the transcript once showed.
  private trackBackgroundShell(rt: Runtime | undefined, u: any): void {
    if (!rt || rt.replaying || rt.silentReplay || !rt.client.supportsBackgroundShellControl()
      || !u || typeof u.toolCallId !== "string") {
      return;
    }
    const meta = u._meta;
    const bg = meta?.["cognition.ai/background"];
    const shellId = meta?.["cognition.ai/backgroundShellId"];
    const status = u.status;
    // A finished tool or an explicit background:false retires the entry before
    // any add is considered, so a completed command never keeps a stop control.
    if (status === "completed" || status === "failed" || bg === false) {
      if (rt.backgroundShells?.delete(u.toolCallId)) {
        this.publishShellState(rt);
      }
      return;
    }
    if (bg === true && typeof shellId === "string" && shellId) {
      const shells = rt.backgroundShells || (rt.backgroundShells = new Map());
      const prev = shells.get(u.toolCallId);
      if (!prev || prev.shellId !== shellId) {
        shells.set(u.toolCallId, { shellId });
        this.publishShellState(rt);
      }
    }
  }

  // Publish the registry to the webview, but only while this surface actually
  // owns and is showing the runtime: during a transfer the old owner no longer
  // holds it and the new one republishes on import.
  private postBackgroundShells(rt: Runtime): void {
    if (this.closed || this.runtimes.get(rt.id) !== rt || this.activeId !== rt.id) {
      return;
    }
    const shells = rt.backgroundShells;
    const items = shells?.size
      ? [...shells.entries()].map(([toolCallId, e]) => ({
          toolCallId,
          stopping: e.stopping === true,
          ...(e.error ? { error: e.error } : {})
        }))
      : [];
    this.post({ type: "backgroundShells", sessionId: rt.id, items });
  }

  // A late result goes to whoever owns the runtime when it lands, never to the
  // surface that asked.
  private publishShellState(rt: Runtime): void {
    rt.owner.postBackgroundShells(rt);
  }

  // Stop one background shell the agent reported. The request must name the
  // session this surface is showing and a toolCallId its registry still holds.
  // Anything else is stale and ignored rather than queued across a transfer.
  private async stopBackgroundShell(msg: any): Promise<void> {
    const sessionId = String(msg.sessionId || "");
    const toolCallId = String(msg.toolCallId || "");
    const rt = sessionId && this.activeId === sessionId ? this.runtimes.get(sessionId) : undefined;
    const entry = rt?.backgroundShells?.get(toolCallId);
    if (!rt || !entry || entry.stopping) {
      return;
    }
    entry.stopping = true;
    entry.error = undefined;
    this.publishShellState(rt);
    try {
      const killed = await rt.client.killBackgroundShell(rt.id, entry.shellId);
      const current = rt.backgroundShells?.get(toolCallId);
      if (killed) {
        // The entry may have been replaced by newer metadata mid flight, so
        // only retire the shell this request actually stopped.
        if (current === entry) {
          rt.backgroundShells!.delete(toolCallId);
          // Historical and non actionable: it replays as a stopped row but
          // carries no shell id, so it can never authorize another stop.
          rt.owner.emit(rt, { type: "toolCallUpdate", id: toolCallId, status: "cancelled", stopped: true });
        }
      } else {
        // -32601: the agent does not serve the kill at all, so every control
        // on this connection goes away rather than erroring per click.
        rt.backgroundShells?.clear();
      }
    } catch (err) {
      const current = rt.backgroundShells?.get(toolCallId);
      if (current === entry) {
        entry.stopping = false;
        entry.error = "Could not stop the background command.";
      }
      const code = (err as { code?: number })?.code;
      this.log(`[stop-background-shell-failed] ${typeof code === "number" ? `rpc ${code}` : "request failed"}`);
    }
    this.publishShellState(rt);
  }

  async refreshSessions(force = false, staleOk = false): Promise<void> {
    // The rows we already know go out first: a live session synthesizes its row
    // from local state, so the list never waits on a slow `devin list` or ACP
    // reply to show what is already true.
    if (this.listVisible && this.surfaceVisible) {
      this.postSessionList(this.sessionsCache?.sessions ?? []);
    }
    const inflight = this.sessionsRefreshing;
    if (inflight) {
      if (!force) {
        return inflight;
      }
      if (
        this.sessionsRefreshingIds !== this.store.ids().join("\u0000") ||
        this.sessionsRefreshingGeneration !== this.sessionListGeneration
      ) {
        this.sessionsForcePending = true;
      }
      await inflight;
      if (this.sessionsForcePending) {
        this.sessionsForcePending = false;
        await this.refreshSessions(true);
      }
      return;
    }
    const refresh = this.refreshSessionsNow(force, staleOk);
    this.sessionsRefreshing = refresh;
    this.sessionsRefreshingIds = this.store.ids().join("\u0000");
    this.sessionsRefreshingGeneration = this.sessionListGeneration;
    try {
      await refresh;
    } finally {
      if (this.sessionsRefreshing === refresh) {
        this.sessionsRefreshing = undefined;
        this.sessionsRefreshingIds = undefined;
        this.sessionsRefreshingGeneration = undefined;
      }
    }
  }

  private async refreshSessionsNow(force = false, staleOk = false): Promise<void> {
    if (!this.isReady()) {
      return;
    }
    const startedAt = Date.now();
    const folders = this.folders();
    const trackedAtStart = new Set(this.store.ids());
    let source = "cache";
    let sessions: DevinSession[] = [];
    if (!force && this.sessionsCache && (staleOk || Date.now() - this.sessionsCache.at < 4000)) {
      sessions = this.sessionsCache.sessions;
    } else {
      this.post({ type: "sessionsLoading" });
      // Never let a slow/failed `devin list` leave the list stuck on its
      // spinner: cap the wait and fall back to the cache (or empty).
      try {
        const protocol = this.listOverProtocol();
        source = protocol ? "acp" : "cli";
        const listing = protocol || listSessions({
          cliPath: this.resolvedCli || "devin",
          env: this.clientEnv(),
          timeoutMs: SESSION_LIST_CLI_TIMEOUT_MS,
          folders,
          trackedIds: this.store.ids(),
          cwdById: this.store.cwds()
        });
        const { sessions: live, prunedIds } = await listing;
        // A first turn may not have persisted yet. Keep live sessions and saved
        // queues even when the agent does not list them.
        for (const id of prunedIds) {
          let messages: MessageState;
          try {
            messages = await this.messageStore.load(id);
          } catch (err) {
            this.reportMessageRestoreFailure(id, err);
            continue;
          }
          const held = this.runtimes.has(id) || this.starting.has(id) || !!this.surfaces?.owner(id)
            || this.store.hasPendingQueue(id) || messages.queued.length > 0;
          if (messages.queued.length) {
            this.store.setQueuePending(id, true);
          }
          if (!held) {
            this.store.remove(id);
            void this.dropStaged(id);
            void this.messageStore.remove(id);
          }
        }
        sessions = live;
        this.sessionsCache = { at: Date.now(), sessions };
        this.store.cacheSessionList(this.sessionsCache);
      } catch (err) {
        this.log(`[list-failed] ${err instanceof Error ? err.message : String(err)}`);
        sessions = this.sessionsCache?.sessions ?? [];
      }
    }
    const trackedNow = new Set(this.store.ids());
    sessions = sessions.filter((session) => !trackedAtStart.has(session.id) || trackedNow.has(session.id));
    this.postSessionList(sessions);
    this.log(`[perf] session-list ${source} ${Date.now() - startedAt}ms`);
  }

  // Publish the remote list plus live sessions and saved queues that the agent
  // has not listed yet. The input array stays untouched.
  private postSessionList(listed: DevinSession[]): void {
    const sessions = [...listed];
    // A saved queue remains reachable even if its process is gone and the
    // session has not reached the agent's persisted history.
    const known = new Set(sessions.map((s) => s.id));
    const cwds = this.store.cwds();
    const titles = this.store.titles();
    const localIds = new Set<string>([
      ...this.starting, ...this.runtimes.keys(), ...this.elsewhere(),
      ...this.messageStore.queuedIds()
    ]);
    const synthesized: DevinSession[] = [];
    for (const id of localIds) {
      if (known.has(id)) {
        continue;
      }
      const cwd = cwds[id] || this.runtimes.get(id)?.cwd || this.cwd();
      synthesized.push({
        id,
        short_id: id,
        working_directory: cwd,
        title: titles[id],
        last_activity_at: Math.floor(Date.now() / 1000),
        tracked: true
      });
    }
    if (synthesized.length) {
      sessions.unshift(...synthesized);
    }
    // Persist titles, and fill any tracked session whose title we only know
    // from the cache (e.g. its directory is not currently listed). A name we set
    // ourselves wins until the listing catches up with it, so a rename is not
    // undone a moment later by a `devin list` taken before it landed.
    const cached = this.store.titles();
    const pinned = this.store.pinnedTitles();
    const freshTitles: Record<string, string> = {};
    for (const s of sessions) {
      if (s.title) {
        freshTitles[s.id] = s.title;
      }
      const own = pinned[s.id] || (s.title ? undefined : cached[s.id]);
      if (own) {
        s.title = own;
      }
    }
    this.store.cacheTitles(freshTitles);
    // An editor tab is named after the chat it holds, so a name the CLI has just
    // reported (or one that was changed) retitles the tab.
    this.surfaces?.titlesChanged();
    this.post({
      type: "sessions",
      sessions,
      activeId: this.activeId,
      statuses: this.allStatuses(),
      // Rows another surface is running, so they can say so before being clicked.
      elsewhere: this.elsewhere(),
      folders: this.folders().map((f) => ({ path: f, name: path.basename(f) }))
    });
  }

  private elsewhere(): string[] {
    return this.surfaces?.elsewhere(this) || [];
  }

  private allStatuses(): Record<string, SessionStatus> {
    return { ...this.surfaces?.statuses(this), ...this.statusMap() };
  }

  // Another surface started, moved or stopped a chat: re-list, so this surface's
  // rows, dots and "running elsewhere" badges say what is actually true.
  surfacesChanged(): void {
    this.post({ type: "sessionStatuses", statuses: this.allStatuses(), activeId: this.activeId, elsewhere: this.elsewhere() });
    void this.refreshSessionsIfVisible();
  }

  // Whether a session list is on screen here (the full list, the docked panel, or
  // the switcher) and this surface is actually showing. Only then is it worth
  // re-listing on every change to the CLI's store: a list nobody can see is re-read
  // when it comes back, and every listing runs `devin list`.
  private listVisible = false;
  private surfaceVisible = true;

  setSurfaceVisible(visible: boolean): void {
    const changed = this.surfaceVisible !== visible;
    this.surfaceVisible = visible;
    if (changed && visible) {
      const rt = this.active();
      if (rt) {
        this.sendOpenDocuments(rt);
      }
      void this.refreshSessionsIfVisible(true);
    }
  }

  private refreshSessionsIfVisible(force = false, staleOk = false): Promise<void> {
    if (this.closed || !this.listVisible || !this.surfaceVisible) {
      return Promise.resolve();
    }
    return this.refreshSessions(force, staleOk);
  }

  private invalidateSessionList(): void {
    this.sessionsCache = undefined;
    this.sessionListGeneration++;
  }

  relistIfWatched(): void {
    this.invalidateSessionList();
    void this.refreshSessionsIfVisible(true);
  }

  private statusMap(): Record<string, SessionStatus> {
    const statuses: Record<string, SessionStatus> = {};
    for (const [id, rt] of this.runtimes) {
      if (rt.awaiting > 0 && id !== this.activeId) {
        statuses[id] = "attention";
      } else {
        statuses[id] = rt.busy && rt.awaiting === 0 ? "running" : "idle";
      }
    }
    // Last, not first: a load and a wake both register the runtime before the replay
    // has finished, so reading the pool afterwards called every one of them "idle"
    // and the starting dot was never shown for either. Not over "attention", which
    // is a question waiting to be answered.
    for (const id of this.starting) {
      if (statuses[id] !== "attention") {
        statuses[id] = "starting";
      }
    }
    return statuses;
  }

  // Rename the chat this surface is showing (the editor tab's context menu, and
  // the side panel's header title).
  async renameVisibleSession(): Promise<void> {
    const id = this.activeId;
    if (id) {
      await this.renameSession(id, this.store.titles()[id]);
    }
  }

  private async renameSession(id: string, currentTitle?: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: "Rename session",
      value: currentTitle || "",
      prompt: "New session title"
    });
    const title = (input || "").trim();
    if (!title) {
      return;
    }
    try {
      // The agent holding this session has its own copy of the name, so it is the
      // one that has to be told: renaming through any other agent leaves the
      // holder with the old name, which it writes back a moment later.
      const holder = this.runtimes.has(id) ? this : this.surfaces?.owner(id, this);
      await (holder ? holder.renameOwned(id, title) : this.withClient((c) => c.renameSession(id, title)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[rename-failed] ${message}`);
      // A rename that failed must not look like one that worked.
      void vscode.window.showErrorMessage(`Couldn't rename this session: ${message}`);
      return;
    }
    // Name it here rather than waiting for the CLI's next listing, so the header,
    // the lists and the editor tab all follow straight away.
    this.store.setTitle(id, title);
    this.invalidateSessionList();
    if (this.activeId === id) {
      this.post({ type: "sessionReady", sessionId: id, title });
    }
    this.surfaces?.titlesChanged();
    this.surfaces?.sessionsChanged(this);
    await this.refreshSessionsIfVisible(true);
  }

  // A name the agent chose itself, rather than one the user typed. Painted like a
  // rename, but nothing is sent back to the agent, since this came from it. The
  // pin `setTitle` leaves behind is wanted here too: it stops a `devin list`
  // already in flight from putting the older name back.
  private applyAgentTitle(rt: Runtime, title: string): void {
    if (this.store.titles()[rt.id] === title) {
      return;
    }
    this.store.setTitle(rt.id, title);
    if (this.activeId === rt.id) {
      this.post({ type: "sessionReady", sessionId: rt.id, title });
    }
    this.surfaces?.titlesChanged();
    this.surfaces?.sessionsChanged(this);
    // Repaint the list from the cached listing rather than shelling out for a
    // fresh one: the only thing that changed is a name we already hold.
    void this.refreshSessionsIfVisible(false, true);
  }

  // Rename through the agent this surface holds the session in, so its own copy of
  // the name goes with it. Falls back to a throwaway agent if it has since gone.
  async renameOwned(id: string, title: string): Promise<void> {
    const rt = this.runtimes.get(id);
    await (rt?.initialized
      ? rt.client.renameSession(id, title)
      : this.withClient((c) => c.renameSession(id, title)));
  }

  private async deleteSession(id: string, title?: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete the session "${title || id}"? This permanently removes it and cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") {
      return;
    }
    // Kill its live runtime first (frees the lock), then delete server-side.
    const rt = this.runtimes.get(id);
    if (rt) {
      this.settleRequestsFor(id);
      this.destroyRuntime(rt);
      this.runtimes.delete(id);
      this.starting.delete(id);
    }
    try {
      await this.withClient((client) => client.deleteSession(id));
    } catch (err) {
      this.log(`[delete-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    this.store.remove(id);
    this.invalidateSessionList();
    // A deleted chat has nothing left to stage for, and what it was holding can be
    // images: kilobytes to megabytes of base64 that would otherwise sit in the
    // workspace's storage for good, since nothing else ever looks at that file again.
    void this.dropStaged(id);
    void this.messageStore.remove(id);
    if (this.activeId === id) {
      this.navigationVersion++;
      this.activeId = undefined;
      this.post({ type: "clear" });
    }
    this.broadcastStatuses();
    await this.refreshSessionsIfVisible(true);
  }

  // --- Mode + model --------------------------------------------------------

  // What the pickers and the status bar are showing. A chat's own mode and model live
  // on its runtime, and this is only what is on screen, so every write that crossed an
  // await goes through here: a chat that is not the one being shown records its own
  // settings and may not paint them. The synchronous writers, taking a new chat and the
  // user's own pickers, set it directly, since the panel cannot have moved on under
  // them. The rule used to be written out again at each of these sites, and the one that
  // left it out flipped the pickers of the chat the user was reading to a background
  // chat's, which matters most on the mode, since it says whether permission is asked
  // for before anything runs. Answers whether the panel is really showing this chat, so
  // a caller can post the rest of what it was going to say.
  private showOptions(rt: Runtime | undefined, mode?: string, model?: string, thoughtLevel?: string, speed?: string): boolean {
    if (rt && this.activeId !== rt.id) {
      return false;
    }
    this.currentMode = mode || this.currentMode;
    this.currentModel = model || this.currentModel;
    // When thoughtLevel is undefined the caller did not supply one, so keep the
    // current value. An explicit empty string means "this model has no thought
    // level", which must clear the stale value from the previous model.
    this.currentThoughtLevel = thoughtLevel !== undefined ? thoughtLevel : this.currentThoughtLevel;
    this.currentSpeed = speed !== undefined ? speed : this.currentSpeed;
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    return true;
  }

  // `rt` is the session the options came from: its mode and model are recorded on it so
  // switching back to it later restores the pickers to what that session is actually set
  // to, rather than to the last session's or to a default.
  private publishOptions(rt: Runtime | undefined, options: ConfigOption[] | undefined, currentModeId?: string): void {
    const activeOptions = options || rt?.configOptions;
    const byId = new Map((activeOptions || []).map((o) => [o.id, o]));
    const modeOpt = byId.get("mode");
    const modelOpt = byId.get("model");
    const thoughtOpt = thoughtOption(activeOptions);
    const speedOpt = speedOption(activeOptions);
    const mode = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : currentModeId;
    const model = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : undefined;
    // When the agent reports config options but thought_level is absent (the
    // model does not support it), pass "" so showOptions clears the stale value
    // left by a previous model. undefined means "not reported at all" (e.g. no
    // options yet), so the old value is preserved.
    const thoughtLevel = typeof thoughtOpt?.currentValue === "string"
      ? thoughtOpt.currentValue
      : activeOptions ? "" : undefined;
    const speed = typeof speedOpt?.currentValue === "string" ? speedOpt.currentValue : activeOptions ? "" : undefined;
    if (rt) {
      rt.configOptions = activeOptions;
      rt.mode = mode || rt.mode;
      rt.model = model || rt.model;
    }
    // The agent reports the modes it actually has, with their names, descriptions
    // and icons. Remember them so the picker offers whatever this CLI supports
    // rather than a list compiled into the extension.
    const modes = modeChoices(modeOpt);
    if (modes.length) {
      this.modes = modes;
    }
    // Which models can read an image. Not every one can (Inkling cannot), and an
    // image block sent to one that cannot poisons the whole session, so this is
    // recorded whenever the agent reports it.
    for (const choice of configChoices(modelOpt)) {
      const supported = choice._meta?.["cognition.ai/supportsImages"];
      if (typeof supported === "boolean") {
        this.modelImageSupport.set(choice.value, supported);
      }
    }
    if (this.pendingModelConfig && this.pendingModelConfig.rt === rt) {
      return;
    }
    // A background session reports its own mode and model too, and they belong to it
    // alone: recorded on its runtime above, and not painted over the pickers.
    if (!this.showOptions(rt, mode || currentModeId, model, thoughtLevel, speed)) {
      return;
    }
    this.postModelOptions(this.currentModel || "adaptive", activeOptions);
  }

  // Posts the mode + model-family options. Model families come from
  // `devin models list` (cached); if not fetched yet, fetch and re-post.
  private postModelOptions(currentModel: string, options = this.active()?.configOptions): void {
    if (this.pendingModelConfig && this.pendingModelConfig.rt === this.active()) return;
    const families = cachedFamilies();
    const thought = thoughtOption(options);
    const speed = speedOption(options);
    const payload = {
      type: "options",
      modes: this.modes,
      currentMode: this.currentMode || DEFAULT_MODE,
      models: families,
      currentModel,
      modelChoices: groupedModelChoices(options),
      sessionConfig: options !== undefined,
      thoughtLevels: configChoices(thought),
      currentThoughtLevel: typeof thought?.currentValue === "string" ? thought.currentValue : this.currentThoughtLevel || "",
      speedOptions: configChoices(speed),
      currentSpeed: typeof speed?.currentValue === "string" ? speed.currentValue : this.currentSpeed || ""
    };
    if (families.length) {
      this.store.cacheOptions(payload);
    }
    this.post(payload);
    if (!families.length) {
      void listModelFamilies(this.resolvedCli || "devin", this.env).then((f) => {
        if (f.length) {
          // Listing takes seconds, so re-read the mode: the visible session may
          // have changed by now and this post must not put the old one back.
          this.postModelOptions(this.active()?.model || this.currentModel || "adaptive");
        }
      });
    }
  }

  // Whether each model can read an image, as the agent reported it. A model that
  // is not in here has not said, and is given the benefit of the doubt.
  private readonly modelImageSupport = new Map<string, boolean>();

  // Can the model this chat is on read an image? `warn` tells the user why not,
  // for the paths where they just tried to attach one.
  private imagesSupported(warn = false): boolean {
    const model = this.active()?.model || this.currentModel;
    if (!model || this.modelImageSupport.get(model) !== false) {
      return true;
    }
    if (warn) {
      const name = familyOf(model)?.name || model;
      void vscode.window.showWarningMessage(
        `${name} cannot read images. Pick another model to attach one.`
      );
    }
    return false;
  }

  // The modes this CLI offers, as it reported them. Seeded with the ones every
  // supported CLI has so the picker is never empty before a session exists, then
  // replaced wholesale by the real list (which is where `smart` comes from, and
  // any mode a later CLI adds).
  private modes = FALLBACK_MODES;

  // Populate the dropdowns before any session exists so they are never empty.
  // Models come from `devin models list` (no session needed, and the uids match
  // what the ACP model option accepts).
  private async publishInitialOptions(): Promise<void> {
    let families: ModelFamily[] = [];
    try {
      families = await listModelFamilies(this.resolvedCli || "devin", this.env);
    } catch (err) {
      this.log(`[models-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!families.length) {
      const cached = this.store.options() as { models?: ModelFamily[] } | undefined;
      families = cached?.models?.length
        ? cached.models
        : [{ id: "adaptive", name: "Adaptive", default: "adaptive", variants: [{ value: "adaptive", name: "Adaptive" }] }];
    }
    // Listing the models spawns the CLI, so this often resolves after a session
    // has already been opened. Read the state only now, and let the visible
    // session's own mode and model win: posting the configured defaults over
    // them would show (say) Bypass on a session the agent is still asking
    // permission for.
    const live = this.active();
    if (this.pendingModelConfig && this.pendingModelConfig.rt === live) return;
    const mode = live?.mode || this.currentMode || this.cfg().get<string>("defaultMode", DEFAULT_MODE);
    const model = live?.model || this.currentModel || this.cfg().get<string>("defaultModel", "");
    const options = live?.configOptions;
    const thought = thoughtOption(options);
    const speed = speedOption(options);
    const payload = {
      type: "options",
      modes: this.modes,
      currentMode: mode || DEFAULT_MODE,
      models: families,
      currentModel: model || "adaptive",
      modelChoices: groupedModelChoices(options),
      sessionConfig: options !== undefined,
      thoughtLevels: configChoices(thought),
      currentThoughtLevel: typeof thought?.currentValue === "string" ? thought.currentValue : "",
      speedOptions: configChoices(speed),
      currentSpeed: typeof speed?.currentValue === "string" ? speed.currentValue : this.currentSpeed || this.cfg().get<string>("defaultSpeed", "")
    };
    this.store.cacheOptions(payload);
    this.post(payload);
  }

  private async applyDefaults(rt: Runtime, res: NewSessionResult): Promise<void> {
    const mode = this.cfg().get<string>("defaultMode", DEFAULT_MODE);
    const model = this.cfg().get<string>("defaultModel", "");
    const thoughtLevel = this.cfg().get<string>("defaultThoughtLevel", "");
    const speed = this.cfg().get<string>("defaultSpeed", "");
    const currentMode = res.modes?.currentModeId;
    // Record the session's own mode first. The `current_mode_update` that
    // announces it arrives before session/new returns, so the runtime is not in
    // the pool yet to receive it, and a session that already starts in the
    // configured mode would otherwise have no mode recorded at all.
    rt.mode = currentMode || rt.mode;
    // Show it straight away, if this is the chat being shown at all.
    this.showOptions(rt, rt.mode);
    const gen = ++this.modelGen;
    try {
      if (mode && mode !== currentMode) {
        const result = await rt.client.setConfigOption(rt.id, "mode", mode);
        rt.mode = mode;
        this.publishOptions(rt, result.configOptions);
      }
      if (gen !== this.modelGen) return;
      // Only re-apply a remembered model if it's still an available model
      // (when we know the list); otherwise keep the session's own default. The
      // session accepts a narrower set than the catalog, so translate first.
      const resolved = acceptedModelUid(rt.configOptions, model);
      const modelKnown = resolved.model !== model || cachedFamilies().length === 0 || !!familyOf(model);
      if (model && modelKnown) {
        const result = await rt.client.setConfigOption(rt.id, "model", resolved.model);
        this.publishOptions(rt, result.configOptions);
        if (gen !== this.modelGen) return;
      }
      const rememberedLevel = thoughtLevel || resolved.effort;
      if (rememberedLevel && configChoices(thoughtOption(rt.configOptions)).some((choice) => choice.value === rememberedLevel)) {
        const result = await rt.client.setConfigOption(rt.id, "thought_level", rememberedLevel);
        this.publishOptions(rt, result.configOptions);
        if (gen !== this.modelGen) return;
      }
      const rememberedSpeed = speed || resolved.speed;
      if (rememberedSpeed && configChoices(speedOption(rt.configOptions)).some((choice) => choice.value === rememberedSpeed)) {
        const result = await rt.client.setConfigOption(rt.id, "speed", rememberedSpeed);
        this.publishOptions(rt, result.configOptions);
        if (gen !== this.modelGen) return;
      }
      if (!this.showOptions(rt, rt.mode, rt.model)) {
        return;
      }
      this.post({ type: "mode", mode: this.currentMode });
      if (this.currentModel) {
        this.post({ type: "model", model: this.currentModel });
      }
    } catch (err) {
      this.log(`[apply-defaults-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setMode(mode: string): Promise<void> {
    this.currentMode = mode;
    const rt = this.active();
    if (rt) {
      rt.mode = mode;
      try {
        const result = await rt.client.setConfigOption(rt.id, "mode", mode);
        this.publishOptions(rt, result.configOptions);
      } catch (err) {
        this.log(`[set-mode-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Remember it for the next chat, after the session itself has it: a settings
    // write can fail (e.g. no workspace open) and that must never be what stops
    // the mode reaching the agent.
    try {
      await this.cfg().update("defaultMode", mode, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      this.log(`[set-mode-persist-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({ type: "mode", mode });
  }

  // Move a running subagent between foreground and background. The agent sends
  // no confirmation, so the webview flips its own state optimistically and we
  // only report a failure.
  private async setSubagentMode(agentId: string, background: boolean): Promise<void> {
    const rt = this.active();
    if (!agentId || !rt) {
      return;
    }
    try {
      if (background) await rt.client.subagentBackground(rt.id, agentId);
      else await rt.client.subagentForeground(rt.id, agentId);
    } catch (err) {
      this.log(`[subagent-mode-failed] ${err instanceof Error ? err.message : String(err)}`);
      this.post({ type: "subagentMode", id: agentId, background: !background });
    }
  }

  private async setSessionConfig(configId: string, value: unknown): Promise<void> {
    const rt = this.active();
    const option = rt?.configOptions?.find((item) => item.id === configId);
    if (!rt || !option || (typeof value !== "string" && typeof value !== "boolean")) {
      return;
    }
    if (option.type === "select" && (typeof value !== "string" || !configChoices(option).some((choice) => choice.value === value))) {
      return;
    }
    try {
      const result = await rt.client.setConfigOption(rt.id, configId, value);
      this.publishOptions(rt, result.configOptions);
    } catch (err) {
      this.log(`[set-config-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private queueModelConfig(model: string, thoughtLevel?: string, requestId?: number, speed?: string): Promise<void> {
    const request = { rt: this.active(), model, thoughtLevel, requestId, speed };
    this.pendingModelConfig = request;
    ++this.modelGen;
    const barriers: (Promise<Runtime> | Promise<void> | undefined)[] = [
      this.startingNew,
      request.rt?.waking,
      this.activeId ? this.loading.get(this.activeId) : undefined
    ];
    const task = this.modelConfigTail.then(async () => {
      let started: Runtime | undefined;
      for (const barrier of barriers) {
        if (!barrier) continue;
        const result = await barrier.then((rt) => rt, () => undefined);
        if (result) started = result as Runtime;
      }
      if (this.pendingModelConfig !== request) return;
      const rt = request.rt || (started && this.active() === started ? started : undefined);
      request.rt = rt;
      if (this.active() !== rt) {
        this.pendingModelConfig = undefined;
        return;
      }
      const previousModel = this.currentModel;
      const previousThought = this.currentThoughtLevel;
      const previousSpeed = this.currentSpeed;
      // The session's own option is the authority on the `model` values it
      // takes, which is narrower than the `devin models list` catalog the
      // picker was built from. Translate before asking.
      const resolved = acceptedModelUid(rt?.configOptions, model);
      const level = thoughtLevel ?? resolved.effort;
      const requestedSpeed = speed ?? resolved.speed;
      let failure: unknown;
      try {
        await this.setModelConfig(resolved.model, level, requestedSpeed);
      } catch (err) {
        failure = err;
      }
      if (this.pendingModelConfig !== request) return;
      this.pendingModelConfig = undefined;
      if (this.active() !== rt) return;
      const options = rt?.configOptions;
      const modelOpt = options?.find((option) => option.id === "model" || option.category === "model");
      const modeOpt = options?.find((option) => option.id === "mode" || option.category === "mode");
      const confirmedMode = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : rt?.mode;
      const confirmedModel = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : (failure ? previousModel : this.currentModel) || resolved.model;
      const confirmedThought = typeof thoughtOption(options)?.currentValue === "string"
        ? thoughtOption(options)?.currentValue as string
        : options ? "" : (failure ? previousThought : this.currentThoughtLevel);
      const confirmedSpeed = typeof speedOption(options)?.currentValue === "string"
        ? speedOption(options)?.currentValue as string
        : options ? "" : (failure ? previousSpeed : this.currentSpeed);
      if (rt && options) {
        rt.mode = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : rt.mode;
        rt.model = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : rt.model;
      }
      if (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        this.log(`[model-config-failed] model=${model} thoughtLevel=${thoughtLevel ?? ""} ${message}`);
        void vscode.window.showWarningMessage(`Could not update model configuration: ${message}`);
      }
      this.showOptions(rt, confirmedMode, confirmedModel, confirmedThought, confirmedSpeed);
      this.postModelOptions(this.currentModel || "adaptive", options);
      this.post({ type: "modelConfigApplied", requestId, model: confirmedModel, thoughtLevel: confirmedThought, speed: confirmedSpeed });
    });
    this.modelConfigTail = task;
    return task;
  }

  private async setModelConfig(model: string, thoughtLevel?: string, speed?: string): Promise<void> {
    const gen = ++this.modelGen;
    this.currentModel = model;
    if (thoughtLevel !== undefined) this.currentThoughtLevel = thoughtLevel;
    if (speed !== undefined) this.currentSpeed = speed;
    const rt = this.active();
    if (rt) {
      try {
        const confirmed = rt.configOptions?.find((option) => option.id === "model" || option.category === "model");
        // A Fast Sub variant the session does not advertise is rejected by the
        // agent: refuse it locally before any RPC so the queue never emits an
        // invalid model value or persists the unsupported pair.
        const accepted = configChoices(confirmed).map((c) => c.value);
        if (accepted.length && fusionModelKey(model) && !accepted.includes(model)) {
          throw new Error("This Fusion sub model configuration is not supported by the current ACP session.");
        }
        // Changing the model resets effort and speed, so restore both before
        // acknowledging the queued selection.
        let result = confirmed?.currentValue === model
          ? { configOptions: rt.configOptions }
          : await rt.client.setConfigOption(rt.id, "model", model);
        this.publishOptions(rt, result.configOptions);
        if (gen !== this.modelGen) return;
        // If the user changed the effort level while the model call was in
        // flight, use their latest choice rather than the stale captured value.
        const latestThought = this.pendingModelConfig?.thoughtLevel ?? thoughtLevel;
        if (latestThought && configChoices(thoughtOption(result.configOptions)).some((choice) => choice.value === latestThought)) {
          result = await rt.client.setConfigOption(rt.id, "thought_level", latestThought);
          this.publishOptions(rt, result.configOptions);
          if (gen !== this.modelGen) return;
        }
        const latestSpeed = this.pendingModelConfig?.speed ?? speed;
        const speedOpt = speedOption(result.configOptions);
        if (latestSpeed && speedOpt?.currentValue !== latestSpeed && configChoices(speedOpt).some((choice) => choice.value === latestSpeed)) {
          result = await rt.client.setConfigOption(rt.id, "speed", latestSpeed);
        }
        this.publishOptions(rt, result.configOptions);
        if (gen !== this.modelGen) return;
      } catch (err) {
        this.log(`[set-model-config-failed] ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    if (gen !== this.modelGen) return;
    const appliedOptions = rt?.configOptions;
    const appliedModelOpt = appliedOptions?.find((option) => option.id === "model" || option.category === "model");
    const appliedThoughtOpt = thoughtOption(appliedOptions);
    const appliedSpeedOpt = speedOption(appliedOptions);
    const appliedModel = rt ? (typeof appliedModelOpt?.currentValue === "string" ? appliedModelOpt.currentValue : model) : model;
    const appliedThought = rt ? (typeof appliedThoughtOpt?.currentValue === "string" ? appliedThoughtOpt.currentValue : "") : thoughtLevel;
    const appliedSpeed = rt ? (typeof appliedSpeedOpt?.currentValue === "string" ? appliedSpeedOpt.currentValue : "") : speed;
    try {
      await this.cfg().update("defaultModel", appliedModel, vscode.ConfigurationTarget.Workspace);
    } catch {}
    try {
      if (appliedThought !== undefined) await this.cfg().update("defaultThoughtLevel", appliedThought, vscode.ConfigurationTarget.Workspace);
    } catch {}
    try {
      if (appliedSpeed !== undefined) await this.cfg().update("defaultSpeed", appliedSpeed, vscode.ConfigurationTarget.Workspace);
    } catch {}
    if (gen !== this.modelGen || (rt && this.active() !== rt)) return;
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({ type: "model", model: appliedModel });
  }

  // --- Context attachments -------------------------------------------------

  // Attachments in the shape the request itself shows them: a label, and for a
  // picture the picture, so the pill can be a thumbnail of it.
  private shownAttachments(list: Staged[]): ShownAttachment[] {
    return list.map((a) => {
      const b = a.block as { type?: string; mimeType?: string; data?: string };
      const thumb = a.type === "image" && b?.type === "image" && b.data
        ? `data:${b.mimeType || "image/png"};base64,${b.data}`
        : undefined;
      return { label: a.label, type: a.type, thumb };
    });
  }

  // Files and images staged in the composer belong to the chat they were staged
  // for, and to a prompt that has not been sent yet, so they outlive leaving the
  // chat, moving it, and reloading the window. They live on disk rather than in
  // workspace state: an image is inlined as base64, which has no business in a
  // settings blob. A pasted screenshot has no file to point back to, so the block
  // itself is what has to be kept.
  private static readonly NEW_CHAT_ATTACHMENTS = "__new__";
  // Past this the staged files are kept for the session only: writing tens of
  // megabytes of base64 on every attach is not worth it.
  private static readonly MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

  // Held per chat, not as one list belonging to whatever is on screen. The list used
  // to be swapped on every switch, and that swap is what made the late writes land on
  // the wrong chat: a send that had to wake a chat first read the composer again when
  // it finished, and by then it was another chat's, so its files went to an agent they
  // were never meant for and were then deleted, since saving was keyed on what was
  // being shown. Keyed by chat id, or by the "new chat" box, which is a real place of
  // its own: a screenshot can be attached from the sessions list before a chat exists.
  private readonly staged = new Map<string, Staged[]>();

  private stagedKey(id?: string): string {
    return id || ChatController.NEW_CHAT_ATTACHMENTS;
  }

  // Read eviction candidates before dropping their snapshots. Recheck the tail
  // after reads because another registration may have moved it.
  private async rememberSession(id: string, cwd: string, runtime?: Runtime): Promise<void> {
    const checked = new Set<string>();
    const retained = new Set<string>();
    for (;;) {
      const candidates = this.store.ids().filter((value) => value !== id)
        .slice(SessionStore.MAX_SESSIONS - 1).filter((value) => !checked.has(value));
      if (!candidates.length) {
        break;
      }
      for (const candidate of candidates) {
        checked.add(candidate);
        if (this.runtimes.has(candidate) || this.starting.has(candidate)
          || this.surfaces?.owner(candidate) || this.store.hasPendingQueue(candidate)) {
          retained.add(candidate);
          continue;
        }
        try {
          const state = await this.messageStore.load(candidate);
          if (state.queued.length) {
            retained.add(candidate);
            this.store.setQueuePending(candidate, true);
          }
        } catch (err) {
          retained.add(candidate);
          this.reportMessageRestoreFailure(candidate, err);
        }
      }
    }
    if (runtime && (this.closed || this.runtimes.get(id) !== runtime)) {
      return;
    }
    for (const live of this.runtimes.keys()) retained.add(live);
    for (const live of this.starting) retained.add(live);
    for (const live of this.elsewhere()) retained.add(live);
    for (const evicted of this.store.add(id, cwd, retained)) {
      if (!this.runtimes.has(evicted) && !this.surfaces?.owner(evicted)) {
        void this.dropStaged(evicted);
        void this.messageStore.remove(evicted);
      }
    }
  }

  // What is staged for one chat. The array is live: pushing to it stages a file.
  private stagedFor(id?: string): Staged[] {
    const key = this.stagedKey(id);
    const held = this.staged.get(key);
    if (held) {
      return held;
    }
    const list: Staged[] = [];
    this.staged.set(key, list);
    return list;
  }

  // Something staged for a chat changed: remember it, and show it if that chat is the
  // one on screen. One place decides what the composer shows and what is written down.
  private stagedChanged(id?: string): void {
    void this.saveStaged(id);
    if (this.stagedKey(id) === this.stagedKey(this.activeId)) {
      this.postStaged();
    }
  }

  // The files a message is being sent with. Taken rather than read, and taken before
  // anything is awaited: a second message written while this one is still waiting for
  // its chat to open would otherwise find the same files still staged and carry them
  // too, so one image went to the agent twice.
  private takeStaged(id?: string): Staged[] {
    const held = this.stagedFor(id);
    this.staged.set(this.stagedKey(id), []);
    if (held.length) {
      this.stagedChanged(id);
    }
    return held;
  }

  // Put them back, for a send that could not go through: the text is handed back to
  // the composer the same way, and the two belong together.
  private restoreStaged(id: string | undefined, items: Staged[]): void {
    if (items.length) {
      this.staged.set(this.stagedKey(id), items);
      this.stagedChanged(id);
    }
  }

  private postStaged(): void {
    this.post({
      type: "attachments",
      // Not `stagedFor`, which would insert an entry: a read must not create one, or a
      // chat handed to another surface gets an empty entry here that then shadows the
      // files still on disk, and they are never read back.
      items: (this.staged.get(this.stagedKey(this.activeId)) || []).map((a) => {
        const item: { id: string; label: string; type: string; thumb?: string } = { id: a.id, label: a.label, type: a.type };
        const b = a.block as { type?: string; mimeType?: string; data?: string };
        if (a.type === "image" && b && b.type === "image" && b.data) {
          item.thumb = `data:${b.mimeType || "image/png"};base64,${b.data}`;
        }
        return item;
      })
    });
  }

  private attachmentsFile(id?: string): vscode.Uri | undefined {
    const root = this.context.storageUri || this.context.globalStorageUri;
    const key = this.stagedKey(id).replace(/[^A-Za-z0-9._-]/g, "_");
    return root ? vscode.Uri.joinPath(root, "attachments", `${key}.json`) : undefined;
  }

  private async saveStaged(id?: string): Promise<void> {
    const file = this.attachmentsFile(id);
    if (!file) {
      return;
    }
    const items = this.stagedFor(id);
    try {
      if (!items.length) {
        await deleteJson(file);
        return;
      }
      if (Buffer.byteLength(JSON.stringify(items), "utf8") > ChatController.MAX_ATTACHMENT_BYTES) {
        this.log(`[attachments] staged files too large to keep past this window`);
        // And the older, smaller set that is still on disk is not the answer either: it
        // would come back after a reload as though it were what the composer holds.
        await deleteJson(file);
        return;
      }
      await writeJson(file, items);
    } catch {
      // Nothing staged to delete, or the storage is not writable: the composer is
      // still correct, it just will not survive a reload.
    }
  }

  // Forget what was staged for a chat, here and on disk: a chat that has been deleted, or
  // the "new chat" box once what was in it has been carried into a real chat.
  private async dropStaged(id?: string): Promise<void> {
    this.staged.delete(this.stagedKey(id));
    const file = this.attachmentsFile(id);
    if (file) {
      await deleteJson(file).then(undefined, () => {});
    }
  }

  // Read back what was staged for a chat before the window was reloaded. Only for a
  // chat this window has not staged anything for yet: what is held here is never
  // older than the file, and reading over it would undo an attach. The shared
  // write queue settles first, so a surface that has just handed this chat over
  // cannot have its late write land after this read.
  private async loadStaged(id?: string): Promise<void> {
    const file = this.attachmentsFile(id);
    if (file && !this.staged.has(this.stagedKey(id))) {
      const list = this.stagedFor(id);
      try {
        const parsed = await readJson(file);
        // The read waited on the shared write queue, so the composer may have
        // been staged for while it ran: only a list still empty and still the
        // same one gets the disk copy, never over or beside a newer change.
        if (Array.isArray(parsed)
          && this.staged.get(this.stagedKey(id)) === list
          && list.length === 0) {
          list.push(...parsed.filter((a) => a && a.id && a.block));
        }
      } catch {
        // Nothing staged for this chat.
      }
    }
    this.postStaged();
  }

  private removeAttachment(id: string): void {
    const list = this.stagedFor(this.activeId);
    const at = list.findIndex((a) => a.id === id);
    if (at !== -1) {
      list.splice(at, 1);
      this.stagedChanged(this.activeId);
    }
  }

  private async addContext(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,.git,dist,out,build,.venv,__pycache__,target}/**",
      1000
    );
    // findFiles never returns directories, so derive the folders under each
    // workspace root from the files, letting a folder be picked by name the way
    // VS Code's "Add Folder to Chat" does.
    const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const dirs = new Set<string>();
    for (const u of uris) {
      let d = path.dirname(u.fsPath);
      while (d && roots.some((r) => d !== r && d.startsWith(r + path.sep))) {
        dirs.add(d);
        d = path.dirname(d);
      }
    }
    const picks: (vscode.QuickPickItem & { id: string })[] = [
      { label: "$(list-selection) Current selection or file", id: "__sel__" },
      { label: "$(file) Browse files...", id: "__browse__" },
      { label: "$(folder-opened) Browse folders...", id: "__browseDir__" },
      ...[...dirs].sort().slice(0, 300).map((d) => ({
        label: "$(folder) " + vscode.workspace.asRelativePath(d) + "/",
        id: d
      })),
      ...uris.map((u) => ({ label: "$(file) " + vscode.workspace.asRelativePath(u), id: u.fsPath }))
    ];
    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: "Add context for Devin",
      matchOnDescription: true
    });
    if (!chosen) {
      return;
    }
    if (chosen.id === "__sel__") {
      await this.addSelection();
      return;
    }
    if (chosen.id === "__browse__" || chosen.id === "__browseDir__") {
      const dirs = chosen.id === "__browseDir__";
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: !dirs,
        canSelectFolders: dirs,
        openLabel: "Add"
      });
      for (const p of picked || []) {
        await this.addFile(p.fsPath);
      }
      return;
    }
    await this.addFile(chosen.id);
  }

  private async openFile(fsPath: string, line?: number): Promise<void> {
    if (!fsPath) {
      return;
    }
    fsPath = path.resolve(this.active()?.cwd || this.cwd(), fileFromUri(fsPath));
    const uri = vscode.Uri.file(fsPath);
    const stat = await fs.promises.stat(fsPath).catch(() => undefined);
    if (stat?.isDirectory()) {
      if (vscode.workspace.getWorkspaceFolder(uri)) {
        try {
          // Revealing a child expands this folder. Select the folder last.
          const [child] = await fs.promises.readdir(fsPath);
          if (child) {
            await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.joinPath(uri, child));
          }
          await vscode.commands.executeCommand("revealInExplorer", uri);
          return;
        } catch (err) {
          this.log(`[reveal-directory-failed] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = { preview: false };
      if (typeof line === "number" && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      // Not openable as text (an image, a PDF, a binary): let VS Code pick the
      // editor for it rather than refusing to open a file the user clicked.
      try {
        await vscode.commands.executeCommand("vscode.open", uri, { preview: false });
      } catch {
        this.log(`[open-file-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async insertAtCursor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file to insert this code into.");
      return;
    }
    await editor.edit((b) => b.insert(editor.selection.active, text));
  }

  private async applyToFile(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file to apply this code to.");
      return;
    }
    const doc = editor.document;
    await editor.edit((b) => {
      if (!editor.selection.isEmpty) {
        b.replace(editor.selection, text);
      } else {
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        b.replace(full, text);
      }
    });
  }

  private async openAllDiffs(): Promise<void> {
    await this.changes.openAll();
  }

  // Insert the command into a terminal without auto-running it, so the user
  // reviews it before pressing Enter.
  private runInTerminal(text: string): void {
    const existing = vscode.window.terminals.find((t) => t.name === "Devin");
    const term = existing || vscode.window.createTerminal({ name: "Devin", env: this.env });
    term.show(true);
    term.sendText(text, false);
  }

  // The path or, from a drop, the file URI that names it.
  private async addFile(dropped: string): Promise<void> {
    const fsPath = fileFromUri(dropped);
    const ext = path.extname(fsPath).toLowerCase().replace(/^\./, "");
    const imageMime = IMAGE_MIME_BY_EXT[ext];
    try {
      // A dropped folder attaches as a listing rather than failing to be read.
      const stat = await fs.promises.stat(fsPath);
      if (stat.isDirectory()) {
        await this.addDirectory(fsPath);
        return;
      }
      // An image file (dropped or @-mentioned) is attached inline as base64 so
      // the model can actually see it, rather than as unreadable text.
      if (imageMime) {
        if (stat.size > MAX_IMAGE_BYTES) {
          void vscode.window.showWarningMessage(`${path.basename(fsPath)} is too large to attach (over 30 MB).`);
          return;
        }
        if (!this.imagesSupported(true)) {
          return;
        }
        const buf = await fs.promises.readFile(fsPath);
        this.stagedFor(this.activeId).push({
          id: `att-${crypto.randomUUID()}`,
          label: path.basename(fsPath),
          type: "image",
          block: { type: "image", mimeType: imageMime, data: buf.toString("base64") }
        });
        this.stagedChanged(this.activeId);
        return;
      }
      const raw = await fs.promises.readFile(fsPath, "utf8");
      const text = raw.length > MAX_ATTACH_CHARS ? raw.slice(0, MAX_ATTACH_CHARS) : raw;
      this.stagedFor(this.activeId).push({
        id: `att-${crypto.randomUUID()}`,
        label: path.basename(fsPath),
        type: "file",
        block: {
          type: "resource",
          resource: { uri: vscode.Uri.file(fsPath).toString(), text }
        }
      });
      this.stagedChanged(this.activeId);
    } catch (err) {
      this.log(`[attach-file-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A dropped folder attaches as a listing of what it contains, so the agent
  // knows the shape of it and can read whichever files it needs.
  private async addDirectory(dirPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 500)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    const label = path.basename(dirPath) || dirPath;
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label,
      type: "directory",
      block: { type: "text", text: `Folder ${dirPath} contains:\n\n${lines.join("\n")}` }
    });
    this.stagedChanged(this.activeId);
  }

  // A folder dropped from outside VS Code. An OS drag carries no filesystem path,
  // so the webview reads the folder's top level and sends the names instead. The
  // block has to say so: worded like the path based listing above, a bare folder
  // name reads as a path relative to the agent's cwd, and it goes hunting for a
  // folder that is not there. The listing doubles as the fingerprint for finding
  // the real one.
  private attachDroppedFolder(name: unknown, entries: unknown): void {
    const label = typeof name === "string" && name ? name : "folder";
    const lines = (Array.isArray(entries) ? entries : []).filter((e): e is string => typeof e === "string");
    const text = [
      `A folder named "${label}" was dropped into the chat from outside VS Code, so no filesystem`,
      "path came with it and its location is unknown (it may or may not be inside the workspace).",
      "Its top level, which can be used to identify it on disk, is:",
      "",
      lines.join("\n"),
      "",
      `To read inside it, find the folder that matches this listing (or ask which "${label}" is meant)`,
      "rather than assuming a path."
    ].join("\n");
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label,
      type: "directory",
      block: { type: "text", text }
    });
    this.stagedChanged(this.activeId);
  }

  // Attach the raw content of a file dropped from outside VS Code (an OS drag
  // gives us bytes but no path). Images arrive via attachImage instead. Same
  // caveat as a dropped folder: a bare name in the place a path usually goes
  // invites the agent to treat a same named workspace file as this one, so the
  // block says where it came from, and says when it was cut short.
  private attachDroppedText(name: unknown, text: unknown): void {
    if (typeof text !== "string" || !text.trim()) {
      return;
    }
    const label = typeof name === "string" && name ? name : "file";
    const body = text.slice(0, MAX_ATTACH_CHARS);
    const truncated = text.length > MAX_ATTACH_CHARS;
    const blockText = [
      `A file named "${label}" was dropped into the chat from outside VS Code, so no filesystem`,
      "path came with it and its location is unknown (it may or may not be inside the workspace).",
      truncated
        ? `Its first ${MAX_ATTACH_CHARS} characters are below, so treat these as the file rather than a`
        : "Its contents are below, so treat these as the file rather than a",
      "same named one in the workspace:",
      "",
      body
    ].join("\n");
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label,
      type: "file",
      block: { type: "text", text: blockText }
    });
    this.stagedChanged(this.activeId);
  }

  // Reports whether there was anything to attach, so a caller that follows it with
  // a question does not ask one about nothing.
  private async addSelection(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return false;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const hasSel = sel && !sel.isEmpty;
    const body = hasSel ? doc.getText(sel) : doc.getText();
    if (!body.trim()) {
      return false;
    }
    const rel = vscode.workspace.asRelativePath(doc.uri);
    const label = hasSel
      ? `${path.basename(doc.uri.fsPath)}:${sel.start.line + 1}-${sel.end.line + 1}`
      : path.basename(doc.uri.fsPath);
    const text = `From ${rel}${hasSel ? ` lines ${sel.start.line + 1}-${sel.end.line + 1}` : ""}:\n\n\`\`\`${doc.languageId}\n${body.slice(0, MAX_ATTACH_CHARS)}\n\`\`\``;
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label,
      type: "selection",
      block: { type: "text", text }
    });
    this.stagedChanged(this.activeId);
    return true;
  }

  // --- Entry points from the editor ----------------------------------------
  // Attach what the user is pointing at and put a starting question in the
  // composer, without sending it. Same convention as "Run in terminal" on a code
  // block: the extension sets things up, the user decides to go ahead.

  // Reachable from the command palette with no editor in front, where there is no
  // code to explain and a question on its own would be nonsense.
  async explainSelection(): Promise<void> {
    if (await this.addSelection()) {
      this.prefill("Explain this code.");
    }
  }

  // The problems the editor reports where the cursor is, handed over explicitly.
  // The agent can pull diagnostics itself, but that is the whole workspace: this
  // is the user pointing at the ones they care about.
  async fixProblemsHere(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const sel = editor.selection;
    const all = vscode.languages.getDiagnostics(editor.document.uri);
    // With a selection, the problems it covers. With just a cursor, the whole file,
    // since one line rarely holds the problem the user means.
    const here = sel.isEmpty ? all : all.filter((d) => !!d.range.intersection(sel));
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    if (!here.length) {
      void vscode.window.showInformationMessage(`No problems reported in ${rel}.`);
      return;
    }
    const lines = here
      .slice(0, MAX_ATTACHED_PROBLEMS)
      .map((d) => `- line ${d.range.start.line + 1}: ${severityLabel(d.severity)} ${d.message}${d.source ? ` (${d.source})` : ""}`);
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label: `${path.basename(editor.document.uri.fsPath)}: ${here.length} problem${here.length === 1 ? "" : "s"}`,
      type: "selection",
      block: { type: "text", text: `Problems the editor reports in ${rel}:\n\n${lines.join("\n")}` }
    });
    await this.addSelection();
    this.prefill(here.length === 1 ? "Fix this problem." : "Fix these problems.");
  }

  async attachUri(uri: vscode.Uri): Promise<void> {
    await this.addFile(uri.fsPath);
  }

  // Put text in the composer, focused and ready to send. Whatever the user has
  // already typed wins: this never overwrites their own words.
  private prefill(text: string): void {
    this.store.setDraft(this.activeId, text);
    this.postDraft();
    this.post({ type: "focusInput" });
  }

  private fileCache?: { at: number; uris: vscode.Uri[] };

  private async queryFiles(query: string): Promise<void> {
    const now = Date.now();
    if (!this.fileCache || now - this.fileCache.at > 15000) {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.venv,__pycache__,target}/**",
        3000
      );
      this.fileCache = { at: now, uris };
    }
    const q = query.toLowerCase();
    const files = this.fileCache.uris
      .map((u) => ({ u, rel: vscode.workspace.asRelativePath(u) }))
      .filter((x) => !q || x.rel.toLowerCase().includes(q))
      .slice(0, 20)
      .map((x) => ({ path: x.u.fsPath, label: path.basename(x.u.fsPath), detail: x.rel }));
    // Filenames are only one way to name the thing you mean. When few files match,
    // ask the language servers: "@ChatController" then finds the file that declares
    // it, which no amount of filename matching would.
    const items = files.length >= SYMBOL_FALLBACK_AT || q.length < 2
      ? files
      : [...files, ...await this.querySymbols(q, files.map((f) => f.path))];
    this.post({ type: "fileSuggestions", query, items });
  }

  // Workspace symbols matching the query, as suggestion rows naming the file that
  // holds them. Attaching one attaches its file, which is what the agent needs to
  // read it in context.
  private async querySymbols(query: string, already: string[]): Promise<{ path: string; label: string; detail: string }[]> {
    try {
      const found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query
      );
      const seen = new Set(already);
      const rows: { path: string; label: string; detail: string }[] = [];
      for (const s of found || []) {
        const uri = s.location?.uri;
        if (!uri || uri.scheme !== "file" || seen.has(uri.fsPath)) {
          continue;
        }
        seen.add(uri.fsPath);
        rows.push({
          path: uri.fsPath,
          label: s.name,
          detail: `${symbolKindLabel(s.kind)} in ${vscode.workspace.asRelativePath(uri)}`
        });
        if (rows.length >= 8) {
          break;
        }
      }
      return rows;
    } catch {
      // No symbol provider for this workspace, or none ready yet: files only.
      return [];
    }
  }

  private attachImage(name: unknown, mime: unknown, data: unknown): void {
    if (typeof data !== "string" || typeof mime !== "string" || !this.imagesSupported(true)) {
      return;
    }
    this.stagedFor(this.activeId).push({
      id: `att-${crypto.randomUUID()}`,
      label: typeof name === "string" && name ? name : "image",
      type: "image",
      block: { type: "image", mimeType: mime, data }
    });
    this.stagedChanged(this.activeId);
  }

  // --- Prompting -----------------------------------------------------------

  private async handleSend(text: string, startNew = false, preserveTranscript = false, kind: PendingKind = "queue"): Promise<void> {
    if (!text.trim()) {
      return;
    }
    // Captured before the first await so a later navigation cannot retarget
    // this send or let it paint into a chat it was not written in.
    const navigationVersion = startNew ? ++this.navigationVersion : this.navigationVersion;
    const sharedStarting = this.startingNewVersion === navigationVersion ? this.startingNew : undefined;
    // A plain send's session can still be finishing its creation: its runtime is
    // already registered but not ready, so prefer that runtime's own readiness
    // promise, falling back to this navigation's shared creation as before.
    const starting = !startNew && this.activeId
      ? this.runtimes.get(this.activeId)?.initializing ?? sharedStarting
      : sharedStarting;
    // The text has left the composer, so it is no longer a draft. Every way out
    // of this method from here on either sends it, queues it, or hands it back:
    // clearing the draft and then returning is how a message disappears.
    const draftFor = startNew ? undefined : this.activeId;
    this.store.setDraft(draftFor, "");
    // Taken from the chat this message was written in, not from whatever is on screen
    // by the time it goes out: waking a chat and creating one both take seconds, and the
    // user can open another one while they run. Taken now rather than cleared later, so a
    // second message written in the meantime cannot pick up the same files.
    const staged = this.takeStaged(draftFor);
    // The whole message is captured before the first await, so the context it
    // carries is the one it was written with, not whatever the editor shows once
    // a wake or a create has finished.
    const message = this.pendingMessage(text, staged, kind);
    const giveBack = (why?: string) => {
      this.store.setDraft(draftFor, message.text);
      this.restoreStaged(draftFor, message.attachments);
      // Only paint the recovery into the composer this send still owns.
      const owns = draftFor ? this.activeId === draftFor : this.navigationVersion === navigationVersion;
      if (owns) {
        this.post({ type: "draft", id: draftFor || null, text: message.text });
        if (why) {
          this.post({ type: "error", text: why });
        }
      } else if (why) {
        this.log(`[send-recovery] ${why}`);
      }
    };
    // Starting a fresh chat leaves the previous session alive in the background. What was
    // staged in the sessions list was staged for THIS message, so it goes with it. The
    // detach and the echo run synchronously with the intent capture, before any await,
    // so a second send can never be pointed at the session being left.
    if (startNew) {
      this.activeId = undefined;
      // `pendingSend` tells the webview not to show the welcome screen on this
      // clear, and we render the user's message right away, so a new chat
      // started from the list never flashes the welcome while the ACP session
      // spins up.
      this.post({ type: "clear", reset: true, pendingSend: true });
      this.post({ type: "userMessage", text: message.text, attachments: this.shownAttachments(message.attachments), clientMessageId: message.id });
    }
    if (!(await this.ensureReady())) {
      giveBack();
      return;
    }
    // Everything from here on is about `target`, the chat this message was written
    // in, and never about whatever is on screen by the time it goes out. A wake
    // takes seconds, and a message written in one chat and sent to another is the
    // worst thing this method can do.
    const target = draftFor;
    // If that session is still coming back to life (a silent background wake),
    // wait for it so the prompt lands on a ready runtime.
    if (!startNew && target) {
      const waking = this.runtimes.get(target)?.waking;
      if (waking) {
        await waking;
      }
      // A session still opening has its channel busy replaying its history, and a
      // prompt sent into that is swallowed. Queue it: the load drains the queue
      // when it finishes, and it shows as pending in the meantime instead of
      // seeming to vanish.
      const rt = this.runtimes.get(target);
      if (rt && (rt.replaying || this.loading.has(target))) {
        this.enqueueMessage(rt, message);
        this.flushQueue(rt);
        return;
      }
    }
    // A creation this navigation already started is the session this message
    // belongs to: wait for it rather than opening a second one, and rather than
    // reading a runtime whose defaults have not finished applying.
    let started: Runtime | undefined;
    if (starting) {
      try {
        // While the shared creation is still registered, go through
        // createSession so this send resolves on the same promise chain as the
        // one that started it and cannot overtake its prompt. The version it
        // matches on is the creation's own, not this send's navigation: a send
        // that arrived after the user re-selected the still-creating session
        // carries a newer navigationVersion, and passing it would open a second
        // session instead of sharing the first. Once that creation has finished
        // and cleared the slot, await the captured promise directly rather than
        // opening a second session.
        started = this.startingNew === starting
          ? await this.createSession(this.startingNewVersion)
          : await starting;
      } catch (err) {
        giveBack(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    let rt = startNew || !target ? undefined : this.runtimes.get(target);
    // One turn at a time within a session, except a steering message the agent
    // takes mid turn: anything else sent while the visible session is mid turn
    // or mid rewind is queued (and shown as a pending row) rather than dropped,
    // then sent when it finishes.
    if (rt && (rt.busy || rt.rewinding)) {
      this.enqueueMessage(rt, message);
      this.flushQueue(rt);
      return;
    }
    if (!rt) {
      try {
        if (!startNew && target) {
          // The session this was written in was idle-exited: wake it, then send. The
          // wake takes seconds, so the message belongs to the session it was written
          // in. If the user has navigated on while this send waited, the wake runs
          // silently in the background rather than stealing the selection back.
          if (this.activeId === target && this.navigationVersion === navigationVersion) {
            await (preserveTranscript ? this.wakeSession(target) : this.loadSession(target));
          } else {
            await this.wakeSession(target, false);
          }
          rt = this.runtimes.get(target);
        } else {
          rt = started ?? await this.createSession(navigationVersion);
        }
      } catch (err) {
        // Waking or creating the session failed, so there is nowhere to send it.
        giveBack(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (!rt) {
      giveBack("Couldn't open a session to send that to. Your message is back in the box.");
      return;
    }
    // A turn or a rewind can have started while the wake or the create was
    // running: opening a chat drains whatever was typed while it opened, and two
    // sends from the new chat box share one session/new and so arrive at one
    // runtime. The busy check above ran before all of that. What does not fit
    // goes to the queue, which is where a message sent during a turn goes.
    if (rt.busy || rt.rewinding) {
      this.enqueueMessage(rt, message);
      this.flushQueue(rt);
      return;
    }

    const sent = rt;
    // What was attached goes with the message, so the request keeps saying what it
    // was asked about instead of the context vanishing the moment it is sent.
    // The id is the dedupe key: a new chat's optimistic echo already painted this
    // bubble, and emit's record+buffer path is what a cached or backgrounded view
    // needs to rebuild it, so the canonical copy must carry the same id.
    const attachments = this.shownAttachments(message.attachments);
    const userMessage = { type: "userMessage", text: message.text, attachments, clientMessageId: message.id };
    this.emit(sent, userMessage);
    await this.runPrompt(sent, message);
  }

  // Run one prompt turn against a runtime and stream its outcome, rendering only
  // while that session is the visible one. On completion it flushes the next
  // queued message, so a session's queue drains itself turn by turn. Shared by a
  // live send and a queued flush.
  //
  // A steering message does not start a turn: the agent takes a second
  // session/prompt while the first runs, and both replies wait for the same
  // completion. `rt.turn` is a barrier over every prompt that joined the turn,
  // and only the newest barrier owns its completion (see adoptTurn).
  private async runPrompt(rt: Runtime, message: PendingMessage, queued?: QueuedDispatch): Promise<void> {
    // Last stop before the wire. Attaching already refuses an image the model
    // cannot read, but the model can be changed after that (or while the message
    // sat in the queue), and an image block the model cannot decode does not fail
    // the turn, it breaks the session for good.
    const blocks = this.withoutUnreadableImages(rt, this.messageBlocks(message));
    // The manifest a later history replay matches this request against: the
    // digest of the exact wire blocks, the typed text, and what the request
    // displayed. A plain message needs none, its replay rebuilds from blocks.
    const includedAttachments = message.attachments.filter((a) => blocks.includes(a.block));
    let sentRecord: SentAttachmentRecord | undefined;
    if (includedAttachments.length) {
      sentRecord = {
        key: promptKey(blocks),
        messageId: message.id,
        text: message.text,
        attachments: this.shownAttachments(includedAttachments)
      };
      rt.messages.sent.push(sentRecord);
      // The manifest is on disk before graceful shutdown can need it, but the
      // save is not awaited here: the turn barrier below must be installed
      // without a disk round trip in the dispatch path.
      void this.saveRuntimeMessages(rt);
    }
    const prior = rt.turn;
    if (!prior) {
      // Only a genuinely new turn resets the checkpoint view, flips busy and
      // counts: a steer joining the running one repeats none of that.
      rt.steps = [];
      rt.stepsKnown = false;
      rt.stepsRevision++;
      this.setRuntimeBusy(rt, true);
      if (this.activeId === rt.id) {
        this.post({ type: "assistantStart" });
      }
      rt.turnCount++;
    }
    const prompt = rt.client.prompt(rt.id, blocks, message.id).catch(async (error: unknown) => {
      if (error instanceof AcpRequestNotSentError && rt.owner.messageStore.owns(rt.id, rt.messages)) {
        // The request provably never reached the agent, so the message is safe
        // to hand back: its manifest record goes with it, or a later replay
        // would restore attachments for a prompt that was never sent. The
        // owns gate keeps an explicit session delete from having its snapshot
        // or draft resurrected by this late failure.
        if (sentRecord) {
          const at = rt.messages.sent.indexOf(sentRecord);
          if (at !== -1) {
            rt.messages.sent.splice(at, 1);
          }
        }
        if (queued) {
          // A queued message goes back into the queue it left, in dispatch
          // order and paused so the drain cannot cascade the rest into the
          // draft. No await sits between the owns check and these mutations,
          // and pendingChanged is the one save.
          queued.failed = true;
          const waiting = new Map(rt.messages.queued.map((entry) => [entry.id, entry]));
          const failed = (rt.queuedDispatches || []).flatMap((entry) => {
            if (!entry.failed) {
              return [];
            }
            if (entry === queued) {
              return [message];
            }
            const recovered = waiting.get(entry.message.id);
            return recovered ? [recovered] : [];
          });
          const ids = new Set(failed.map((entry) => entry.id));
          rt.messages.queued = [...failed, ...rt.messages.queued.filter((entry) => !ids.has(entry.id))];
          rt.messages.paused = true;
          rt.runNextId = undefined;
          rt.owner.pendingChanged(rt.id);
        } else {
          if (sentRecord) {
            await this.saveRuntimeMessages(rt);
          }
          if (!rt.owner.messageStore.owns(rt.id, rt.messages)) {
            throw error;
          }
          await rt.owner.store.queuedBackToDrafts([{ id: rt.id, text: message.text }]);
          // Read the owner again after the awaits: a surface move retargets who
          // restores the staged files, and only while that owner still holds
          // this state is the draft posted.
          const owner = rt.owner;
          if (owner.messageStore.owns(rt.id, rt.messages)) {
            owner.restoreStaged(rt.id, message.attachments);
            if (owner.activeId === rt.id) {
              owner.postDraft();
            }
          }
        }
      }
      throw error;
    });
    const turn: Promise<PromptResult> = prior
      ? Promise.allSettled([prior, prompt]).then(([previous, current]) => {
          if (previous.status === "rejected") {
            throw previous.reason;
          }
          if (current.status === "rejected") {
            throw current.reason;
          }
          return current.value;
        })
      : prompt;
    rt.turn = turn;
    await this.adoptTurn(rt, turn);
  }

  // Close out a finished turn, but only for the surface that still holds the
  // session: one that moved away mid turn is finished by its new surface (see
  // `adoptTurn`), which owns the webview the result belongs to and its queue.
  private endTurn(rt: Runtime): void {
    if (this.runtimes.get(rt.id) !== rt) {
      return;
    }
    rt.cancelling = false;
    this.setRuntimeBusy(rt, false);
    // The turn barrier this queue belonged to has settled: its dispatch
    // records go with it, so a later turn starts its own list.
    rt.queuedDispatches = undefined;
    // Send the next queued message first: the revert-head probe below is an
    // extra round trip on the same channel, and awaiting it here is what used
    // to leave a visible gap before a queued message went out.
    this.flushQueue(rt);
    void this.refreshSessionsIfVisible();
    // A chat moved here mid turn has no history on this surface, and now that the
    // channel is free it can be asked for. Only when the queue did not start
    // another turn, and it is still what the user is looking at.
    if (!rt.busy && rt.needsReplay && this.activeId === rt.id) {
      rt.needsReplay = false;
      void this.loadSession(rt.id);
      return;
    }
    // Publish the checkpoint list once the session is idle again. Only read it
    // when the session actually went idle, so it never contends with a queued
    // turn we just started.
    if (!rt.busy && !rt.rewinding && this.activeId === rt.id) {
      void this.refreshCheckpoints(rt);
    }
  }

  // Own the completion of a turn barrier: only the controller still holding
  // `rt.turn` when it settles reports the end and drains the queue, so an
  // earlier barrier or a departed surface does none of that.
  private async adoptTurn(rt: Runtime, turn: Promise<PromptResult>): Promise<void> {
    const ownsTurn = () => this.runtimes.get(rt.id) === rt && rt.turn === turn;
    try {
      const result = await turn;
      if (ownsTurn() && this.activeId === rt.id) {
        this.post({ type: "assistantEnd", stopReason: result.stopReason });
      }
    } catch (err) {
      if (ownsTurn() && this.activeId === rt.id) {
        this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (ownsTurn()) {
        rt.turn = undefined;
        this.endTurn(rt);
      }
    }
  }

  // Snapshot a message the moment it is submitted: the implicit context and the
  // staged attachments it was written with, its text, and what it is (a queue
  // entry, or a steer into the running turn).
  private pendingMessage(text: string, attachments: Staged[], kind: PendingKind = "queue"): PendingMessage {
    return { id: crypto.randomUUID(), kind, text, implicit: this.buildImplicitBlocks(), attachments };
  }
  // The queued message currently being edited in the composer, if any. The queue
  // still drains past it: only that one message is held back when it is chosen,
  // so earlier messages keep going and later ones stay behind it.
  private queueEditingId?: string;

  // Add a captured message to the runtime's queue and reflect it in the
  // composer. The list stays chronological: a steer the agent cannot take is
  // only downgraded once capabilities are actually known (rt.initialized),
  // because a wake or load holds the queue before initialize has answered.
  // Which message the drain picks next is flushQueue's call, not this one's.
  private enqueueMessage(rt: Runtime, message: PendingMessage): void {
    if (rt.initialized && message.kind === "steer" && !rt.client.supportsMidTurnPrompts()) {
      message.kind = "queue";
    }
    rt.messages.queued.push(message);
    this.pendingChanged(rt.id);
  }

  // Ask the agent to stop the turn in flight, once: a second Stop while the
  // cancel is still settling must not put another session/cancel on the wire.
  // Anything the agent was asking is answered "cancelled" at the same time.
  private cancelRuntime(rt: Runtime): void {
    if (rt.busy && !rt.cancelling) {
      rt.cancelling = true;
      rt.client.cancel(rt.id);
    }
    this.settleRequestsFor(rt.id);
  }

  // VS Code's "Stop and Send": the message is queued like any other, but named
  // by `runNextId` so the drain picks it ahead of everything waiting, of either
  // kind, the moment the cancelled turn settles. With no turn running it is an
  // ordinary send.
  private stopAndSend(text: string): void {
    if (!text.trim()) {
      return;
    }
    const rt = this.active();
    if (!rt || !rt.busy) {
      void this.handleSend(text, false);
      return;
    }
    this.store.setDraft(this.activeId, "");
    const message = this.pendingMessage(text, this.takeStaged(this.activeId), "queue");
    this.enqueueMessage(rt, message);
    rt.runNextId = message.id;
    // A load in flight is not a turn to cancel: the priority pick waits for it,
    // and the load's own drain sends it first.
    if (!rt.replaying && !rt.waking && !this.loading.has(rt.id)) {
      this.cancelRuntime(rt);
    }
    this.flushQueue(rt);
  }

  // Send the next queued message once a runtime is free. Runs one at a time:
  // runPrompt calls back into this in its finally, so the queue drains in order.
  //
  // While a turn is running, only a steering message the agent advertised goes
  // out, and it joins that turn rather than waiting for it: the prompt is a
  // second session/prompt on the same session, never a session/cancel. A queue
  // message, an unsupported steer, a turn being cancelled, or a "send
  // immediately" pick all wait for the turn to end instead.
  private flushQueue(rt: Runtime): void {
    // The same gates a load applies to itself: a prompt sent into a replaying
    // or waking channel is swallowed, so the queue waits for the load's
    // own flush instead of draining back into it. !rt.initialized belongs here
    // too: supportsMidTurnPrompts cannot answer before initialize has, and a
    // steer kept chronological through that window is normalized below once
    // the real answer exists.
    if (rt.replaying || rt.waking || rt.rewinding || !rt.initialized || this.loading.has(rt.id)) {
      return;
    }
    const supportsSteering = rt.client.supportsMidTurnPrompts();
    if (!supportsSteering && rt.messages.queued.some((q) => q.kind === "steer")) {
      for (const message of rt.messages.queued) message.kind = "queue";
      this.pendingChanged(rt.id);
    }
    while (rt.messages.queued.length) {
      // A queue restored from disk waits for Resume Queue. Its one exception is
      // an explicit Send Immediately pick, which runs exactly that message: the
      // pick is consumed on dequeue and everything behind it stays paused.
      if (rt.messages.paused && !rt.runNextId) {
        return;
      }
      // "Send Immediately" is authoritative over the order: its message is
      // sent next whatever kind it is. A stale pick (its message was removed)
      // is dropped and the ordinary order resumes. Otherwise a supported steer
      // goes before the queued messages behind it, keeping submission order
      // inside each kind.
      let index = supportsSteering ? rt.messages.queued.findIndex((q) => q.kind === "steer") : 0;
      if (index === -1) index = 0;
      if (rt.runNextId) {
        const at = rt.messages.queued.findIndex((q) => q.id === rt.runNextId);
        if (at === -1) {
          rt.runNextId = undefined;
          continue;
        }
        index = at;
      }
      const message = rt.messages.queued[index];
      // Hold only the message being edited, and only once it is chosen: the
      // ones before it still send, the ones after it wait behind it. Resumes
      // when the edit is committed or cancelled (see the queueEditing message).
      if (this.queueEditingId === message.id) {
        return;
      }
      if (rt.busy) {
        const canSteer = message.kind === "steer"
          && supportsSteering
          && !rt.cancelling
          && !rt.runNextId;
        if (!canSteer) {
          return;
        }
      }
      rt.messages.queued.splice(index, 1);
      if (rt.runNextId === message.id) {
        rt.runNextId = undefined;
      }
      this.pendingChanged(rt.id);
      // Route the echo through emit so a flush that happens while the session
      // is backgrounded is buffered and replays (its user bubble shows on
      // return), instead of being dropped like the old active only post. What
      // was attached goes with it, as it does for a message sent straight away.
      const dispatch: QueuedDispatch = { message, failed: false };
      const dispatches = (rt.queuedDispatches ??= []);
      const previous = dispatches.findIndex((entry) => entry.message.id === message.id);
      if (previous === -1) {
        dispatches.push(dispatch);
      } else {
        dispatches[previous] = dispatch;
      }
      this.emit(rt, { type: "userMessage", text: message.text, attachments: this.shownAttachments(message.attachments), clientMessageId: message.id });
      void this.runPrompt(rt, message, dispatch);
    }
  }

  // Start or stop editing a queued message. Its attachments are copied into the
  // composer the way its text is: there to be seen and changed while editing,
  // and still on the message, whose row goes on saying what it will send if the
  // edit is abandoned. Committing replaces them with whatever the composer ended
  // up holding (editQueued), and abandoning drops that copy.
  private setQueueEditing(id?: string): void {
    const active = this.activeMessages();
    const was = this.queueEditingId;
    this.queueEditingId = id;
    if (was && was !== id && this.stagedFor(this.activeId).length) {
      // Abandoning an edit drops the copy of that message's files it was given.
      this.staged.set(this.stagedKey(this.activeId), []);
      this.stagedChanged(this.activeId);
    }
    const to = id && active ? active.state.queued.find((q) => q.id === id) : undefined;
    if (to) {
      this.staged.set(this.stagedKey(this.activeId), to.attachments.map((a) => ({ ...a })));
      this.stagedChanged(this.activeId);
    }
    if (active?.rt) {
      this.flushQueue(active.rt);
    }
  }

  // Remove a queued message the user dropped or moved back to the composer.
  // If it was the "send immediately" pick or the one being edited, those go
  // with it, and the drain runs again so removing a blocker cannot strand the
  // queue behind it.
  private removeQueued(id: string): void {
    const active = this.activeMessages();
    if (!active) {
      return;
    }
    const before = active.state.queued.length;
    active.state.queued = active.state.queued.filter((q) => q.id !== id);
    if (active.state.queued.length !== before) {
      const rt = active.rt;
      if (rt?.runNextId === id) {
        rt.runNextId = undefined;
      }
      if (this.queueEditingId === id) {
        this.queueEditingId = undefined;
        // The edit borrowed the composer's staged files for this message. With
        // the message gone they must not leak into the next draft or send.
        if (this.stagedFor(this.activeId).length) {
          this.staged.set(this.stagedKey(this.activeId), []);
          this.stagedChanged(this.activeId);
        }
      }
      this.pendingChanged(active.id);
      if (rt) {
        this.flushQueue(rt);
      }
    }
  }

  // Move one queued message within its own kind's group, the drag reorder
  // Copilot's pending rows offer. Anything else (an unknown id, a target of a
  // different kind, the message onto itself) is not a reorder and changes
  // nothing.
  private reorderQueued(id: string, targetId: string, before: boolean): void {
    const active = this.activeMessages();
    if (!active || id === targetId) {
      return;
    }
    const queued = active.state.queued;
    const from = queued.findIndex((q) => q.id === id);
    const to = queued.findIndex((q) => q.id === targetId);
    if (from === -1 || to === -1 || queued[from].kind !== queued[to].kind) {
      return;
    }
    const [moved] = queued.splice(from, 1);
    // The target's index moved with the removal, so it is found again rather
    // than adjusted by arithmetic that a second removal would break.
    const at = queued.findIndex((q) => q.id === targetId);
    queued.splice(before ? at : at + 1, 0, moved);
    this.pendingChanged(active.id);
    if (active.rt) {
      this.flushQueue(active.rt);
    }
  }

  // VS Code's "Send Immediately" on a pending request, which means now rather
  // than next: the message is named by `runNextId`, the request in flight is
  // cancelled and the queue drains into the gap once it settles
  // (chatServiceImpl's sendPendingRequestImmediately). The pick also moves to
  // the front of its own kind for display, matching Copilot. On an idle
  // session there is nothing to cancel, so it simply goes next. A queue with
  // no live runtime is woken first: the pick belongs to the session it was
  // made on, never to whichever chat is on screen once the wake finishes.
  private async sendQueuedNow(id: string): Promise<void> {
    const active = this.activeMessages();
    if (!active) {
      return;
    }
    const sessionId = active.id;
    if (!active.rt) {
      await this.wakeSession(sessionId);
    }
    // Read the session's runtime again after the wake: the chat on screen, or
    // even the runtime itself, may have changed while it ran.
    const rt = this.runtimes.get(sessionId);
    const state = this.messageStore.get(sessionId);
    const at = state.queued.findIndex((q) => q.id === id);
    if (at === -1) {
      return;
    }
    const message = state.queued[at];
    state.queued.splice(at, 1);
    const front = state.queued.findIndex((q) => q.kind === message.kind);
    state.queued.splice(front === -1 ? state.queued.length : front, 0, message);
    if (rt) {
      rt.runNextId = id;
    }
    this.pendingChanged(sessionId);
    // The turn ending drains the queue, and this message is the pick. A load in
    // flight is not a turn to cancel: the pick waits for the load's own drain.
    if (rt?.busy && !rt.replaying && !rt.waking && !this.loading.has(sessionId)) {
      this.cancelRuntime(rt);
      return;
    }
    if (rt) {
      this.flushQueue(rt);
    }
  }

  // The queue the visible composer is editing, with its live runtime when the
  // session still has one. A paused or dead session's rows stay usable: the
  // state lives in the message store, not on the process.
  private activeMessages(): { id: string; state: MessageState; rt?: Runtime } | undefined {
    const id = this.activeId;
    return id ? { id, state: this.messageStore.get(id), rt: this.runtimes.get(id) } : undefined;
  }

  // A queue mutation is persisted and republished together. An empty queue
  // clears the pause flag: there is nothing left for Resume Queue to resume.
  private pendingChanged(id: string): void {
    const state = this.messageStore.get(id);
    if (!state.queued.length) {
      state.paused = false;
    }
    void this.saveMessages(id);
    this.postQueued(id);
  }

  // Resume Queue: the recovered queue was paused on restore, and only this
  // explicit ask lets it drain. The session is woken if its runtime is gone,
  // but the resume always lands on the session the button belonged to.
  private async resumeQueue(): Promise<void> {
    const active = this.activeMessages();
    if (!active) {
      return;
    }
    const id = active.id;
    if (!active.rt) {
      await this.wakeSession(id);
    }
    // The wake can fail, or another surface can take the session while it was
    // opening: unpausing a queue this surface cannot drain would strand it, so
    // only a runtime that actually came up here gets the resume.
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
    const state = this.messageStore.get(id);
    state.paused = false;
    this.pendingChanged(id);
    this.flushQueue(rt);
  }

  // Persist a session's message state, reporting a failure where the user can
  // see it: a queue that cannot be saved is the user's own writing, and
  // silently dropping it is the one outcome worse than an error message.
  private saveMessages(id: string): Promise<void> {
    this.store.setQueuePending(id, this.messageStore.get(id).queued.length > 0);
    return this.messageStore.save(id).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[messages-save-failed] ${id}: ${message}`);
      this.post({
        type: "error",
        text: "Couldn't save this chat's messages and attachments. Keep this window open and check the Devin output."
      });
    });
  }

  // A save that outlives its runtime's place in the pool (a prompt still
  // dispatching when its session was deleted or moved) must not write state
  // the current owner no longer holds. Ordinary exit keeps ownership, so a
  // not sent record is still cleaned up for a session that merely closed.
  private saveRuntimeMessages(rt: Runtime): Promise<void> {
    const owner = rt.owner;
    return owner.messageStore.owns(rt.id, rt.messages)
      ? owner.saveMessages(rt.id)
      : Promise.resolve();
  }

  // What a queued message finally sends: the context it was queued with, then
  // whatever is attached to it, then the message itself.
  private messageBlocks(q: { text: string; implicit: ContentBlock[]; attachments: Staged[] }): ContentBlock[] {
    return [...q.implicit, ...q.attachments.map((a) => a.block), { type: "text", text: q.text }];
  }

  // Drop image blocks a model that cannot read them would choke on, and say so in
  // the chat: sending the rest of the message is far better than breaking the
  // session, but the user has to know their screenshot did not go.
  private withoutUnreadableImages(rt: Runtime, blocks: ContentBlock[]): ContentBlock[] {
    const model = rt.model || this.currentModel;
    if (!model || this.modelImageSupport.get(model) !== false || !blocks.some((b) => b.type === "image")) {
      return blocks;
    }
    const kept = blocks.filter((b) => b.type !== "image");
    const dropped = blocks.length - kept.length;
    const name = familyOf(model)?.name || model;
    this.emit(rt, {
      type: "error",
      text: `${name} cannot read images, so ${dropped === 1 ? "an image was" : `${dropped} images were`} left out of this request.`
    });
    return kept;
  }

  // Update a queued message's text in place. Editing borrowed the composer, so
  // whatever is staged there is now this message's context: that is both what
  // the edit started with and anything attached while editing. A kind change
  // (queue to steer or back, as the send menu offers while editing) moves the
  // message to the end of the list, since the drain picks steers first anyway
  // and its place in line was chosen under the old kind. The implicit context
  // it was queued with stays.
  private editQueued(id: string, text: string, kind?: PendingKind): void {
    const active = this.activeMessages();
    if (!active || !text.trim()) {
      return;
    }
    const at = active.state.queued.findIndex((x) => x.id === id);
    if (at === -1) {
      return;
    }
    const q = active.state.queued[at];
    q.text = text;
    q.attachments = this.takeStaged(active.id);
    const rt = active.rt;
    const nextKind = kind === "steer" && rt?.initialized && !rt.client.supportsMidTurnPrompts()
      ? "queue"
      : kind || q.kind;
    if (nextKind !== q.kind) {
      active.state.queued.splice(at, 1);
      q.kind = nextKind;
      active.state.queued.push(q);
    }
    this.pendingChanged(active.id);
    if (rt) {
      this.flushQueue(rt);
    }
  }

  // Replay a backgrounded session's buffered stream into the (now visible)
  // transcript and clear it, so returning shows the progress the turn made while
  // it was not on screen.
  private record(rt: Runtime, payload: Record<string, unknown>): void {
    if (recordPainted(rt.log, payload)) {
      rt.logFull = false;
    }
    // Only what this extension submitted is journaled, once per send: queued
    // rows and replayed chunks are different payload types and never reach here.
    if (payload.type === "userMessage" && typeof payload.text === "string" && this.hasWorkspace()) {
      this.store.rememberPrompt(rt.id, payload.text);
    }
  }

  private postReplay(items: Record<string, unknown>[]): void {
    for (let start = 0; start < items.length; start += REPLAY_BATCH_SIZE) {
      this.post({ type: "replay", items: items.slice(start, start + REPLAY_BATCH_SIZE) });
    }
  }

  private flushReplay(rt: Runtime): void {
    if (!rt.replay.length) {
      return;
    }
    const items = rt.replay;
    rt.replay = [];
    this.postReplay(items);
  }

  // Rebuild a transcript from what this session has already painted. This is how
  // a chat keeps its history when it moves surface mid turn, when asking the agent
  // for it would abort the turn.
  private replayLog(rt: Runtime): void {
    this.post({ type: "clear", loading: true });
    this.postReplay(paintedReplay(rt.log));
    this.post({ type: "loaded" });
    // The log is a superset of anything buffered while the session was hidden.
    rt.bgBuffer = [];
  }

  private flushBgBuffer(rt: Runtime): void {
    if (!rt.bgBuffer.length) {
      return;
    }
    const buffered = rt.bgBuffer;
    rt.bgBuffer = [];
    for (const payload of buffered) {
      // Reasoning that streamed while the session was in the background renders
      // in one go now, so it is timed no more usefully than a replay is.
      if (payload.type === "thoughtChunk") {
        payload.replayed = true;
      }
      this.post(payload);
    }
    // The turn-boundary markers (assistantStart/End) are only posted for the
    // visible session, so a background turn that has already finished never sent
    // its End. Settle the last replayed block if the turn is done.
    if (!rt.busy) {
      this.post({ type: "assistantEnd" });
    }
  }

  // During a history replay, user_message_chunk updates are accumulated per
  // message id rather than emitted chunk by chunk, so the flush can put back
  // the whole request at once. A different message id, a transcript producing
  // update, or the end of the load each close the group.
  private accumulateReplayUser(rt: Runtime, u: { messageId?: string; content?: unknown }): void {
    const content = Array.isArray(u.content) ? u.content : [u.content];
    if (rt.replayUser && rt.replayUser.messageId !== u.messageId) {
      this.flushReplayUser(rt);
    }
    if (!rt.replayUser) {
      rt.replayUser = { messageId: u.messageId, blocks: [] };
    }
    for (const block of content) {
      if (typeof block === "string") {
        rt.replayUser.blocks.push({ type: "text", text: block });
      } else if (block && typeof block === "object") {
        rt.replayUser.blocks.push(block as ContentBlock);
      }
    }
  }

  // Match the stable prompt id and exact wire digest first, so a history cut
  // cannot give a repeated prompt an older record's attachment labels. Older
  // snapshots and replay sources without a known id match by digest in order.
  // Anything unmatched is rebuilt from the blocks themselves.
  private flushReplayUser(rt: Runtime): void {
    const group = rt.replayUser;
    rt.replayUser = undefined;
    if (!group || !group.blocks.length) {
      return;
    }
    const saved = rt.messages.sent;
    const from = rt.replaySentIndex ?? 0;
    const key = promptKey(group.blocks);
    const identifiedIndex = group.messageId
      ? saved.findIndex((record, i) => i >= from && record.messageId === group.messageId && record.key === key)
      : -1;
    const index = identifiedIndex !== -1
      ? identifiedIndex
      : saved.findIndex((record, i) => i >= from && record.key === key);
    const record = saved[index];
    if (record) {
      rt.replaySentIndex = index + 1;
      this.emit(rt, {
        type: "userChunk",
        messageId: group.messageId,
        text: record.text,
        attachments: record.attachments
      });
      return;
    }
    const text = group.blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
    this.emit(rt, {
      type: "userChunk",
      messageId: group.messageId,
      text,
      attachments: replayedAttachments(group.blocks)
    });
  }

  // A saved queue or sent manifest that cannot be read is reported, not
  // silently treated as empty: the file is left in place for inspection.
  private reportMessageRestoreFailure(id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`[messages-restore-failed] ${id}: ${message}`);
    this.post({
      type: "error",
      text: "Couldn't restore this chat's saved messages and attachments. The saved file was left in place. Check the Devin output."
    });
  }

  // Keep a dead runtime's queue editable until the user explicitly resumes it.
  private keepQueued(rt: Runtime): void {
    if (!rt.id) {
      return;
    }
    if (rt.messages.queued.length) {
      rt.messages.paused = true;
    }
    rt.runNextId = undefined;
    void this.saveMessages(rt.id);
    this.postQueued(rt.id);
  }

  // Mirror a session's queue to the webview, but only while it is visible: the
  // composer only ever shows the active session's queue.
  private postQueued(id: string): void {
    if (this.activeId !== id) {
      return;
    }
    const state = this.messageStore.get(id);
    this.post({
      type: "queued",
      items: state.queued.map((q) => ({ id: q.id, kind: q.kind, text: q.text, attachments: this.shownAttachments(q.attachments) })),
      paused: state.paused
    });
  }

  // The agent pushes the whole revertible step list after every turn, so the
  // checkpoint targets are handed to us rather than asked for. Recorded on the
  // runtime so a session switch can restore them without a round trip.
  private onRevertSteps(rt: Runtime, update: RevertStepsUpdate): void {
    // The push arrives on this client's transport, so the runtime may already
    // have moved to another surface: ask its CURRENT owner whether it still
    // holds this runtime rather than this controller's own map.
    if (rt.owner.runtimes.get(rt.id) !== rt) {
      return;
    }
    if (update.sessionId && update.sessionId !== rt.id) {
      return;
    }
    rt.steps = Array.isArray(update.steps) ? update.steps : [];
    rt.stepsKnown = true;
    rt.stepsRevision++;
    rt.owner.postCheckpoints(rt);
  }

  // Publish this chat and put the link on the clipboard. The agent refuses until
  // the conversation has something in it, and says so, which is worth passing on
  // rather than reporting as a failure.
  private async shareSession(): Promise<void> {
    const rt = this.active();
    if (!rt || !rt.client.supportsSessionShare()) {
      return;
    }
    try {
      const res = await rt.client.shareSession(rt.id);
      const url = res?.url;
      if (!url) {
        void vscode.window.showInformationMessage("Devin did not return a link for this chat.");
        return;
      }
      await vscode.env.clipboard.writeText(url);
      const open = await vscode.window.showInformationMessage("Link to this chat copied.", "Open");
      if (open === "Open") {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`Couldn't share this chat: ${message}`);
    }
  }

  // The runtime a scoped checkpoint action belongs to, wherever it lives now.
  // Actions name their session, so a navigation while the request was in flight
  // cannot retarget them onto a different chat.
  private checkpointRuntime(sessionId: string): Runtime | undefined {
    const owner = this.runtimes.has(sessionId) ? this : this.surfaces?.owner(sessionId, this);
    return owner?.runtimes.get(sessionId);
  }

  // Publish this chat's checkpoint bindings: one entry per prompt step the agent
  // reported, keyed by the stable userMessageId every send now carries. The
  // webview turns these into Restore/Fork controls; a step list that has not
  // arrived yet simply leaves the controls hidden.
  private postCheckpoints(rt: Runtime): void {
    const owner = rt.owner;
    if (owner.closed || owner.runtimes.get(rt.id) !== rt || owner.activeId !== rt.id || rt.silentReplay) {
      return;
    }
    const prompts = rt.steps.filter((step) => step.kind === "prompt" && typeof step.userMessageId === "string");
    owner.post({
      type: "checkpoints",
      sessionId: rt.id,
      checkpoints: prompts.map((step, index) => ({ userMessageId: step.userMessageId, canFork: index > 0 })),
      busy: !!rt.rewinding
    });
  }

  // Make sure the step list behind the checkpoint bindings is current, then
  // publish it. A push that landed while a list read was in flight wins: the
  // revision captured before the read decides whether the answer is still the
  // newest word on the conversation.
  private async refreshCheckpoints(rt: Runtime, force = false): Promise<void> {
    if (!rt.client.supportsRevert() || !rt.client.supportsRevertByUserMessageId()) {
      this.postCheckpoints(rt);
      return;
    }
    if (!rt.stepsKnown || force) {
      const revision = rt.stepsRevision;
      try {
        const steps = await rt.client.listRevertSteps(rt.id);
        if (rt.owner.runtimes.get(rt.id) !== rt) {
          return;
        }
        if (rt.stepsRevision === revision) {
          rt.steps = steps;
          rt.stepsKnown = true;
          rt.stepsRevision++;
        }
      } catch (err) {
        rt.owner.log(`[checkpoint-list-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.postCheckpoints(rt);
  }

  // Fork: continue from an earlier turn in a new chat, leaving this one untouched.
  // The agent copies the conversation into a new session and hands back its id,
  // which is the chat to open. Nothing is rewound and no file is undone, so unlike
  // a restore there is nothing to confirm. The fork point is resolved fresh from
  // the step list: the prompt step's revert target is the node before that
  // request ran, which is where the copy stops.
  private async handleRevertFork(sessionId: string, userMessageId: string): Promise<void> {
    const rt = this.checkpointRuntime(sessionId);
    const navigationVersion = this.navigationVersion;
    const report = (text: string) => {
      const owner = rt?.owner ?? this;
      if (owner.activeId === sessionId) {
        owner.post({ type: "error", text });
      } else {
        owner.log(`[fork-failed] ${sessionId}: ${text}`);
      }
    };
    if (!rt || rt.busy || rt.rewinding || rt.replaying || rt.waking || rt.initializing || rt.client.hasExited()) {
      report("This chat is not ready for checkpoint actions. Reopen it and try again.");
      return;
    }
    try {
      const revision = rt.stepsRevision;
      const steps = await rt.client.listRevertSteps(rt.id);
      // The read raced a turn, a steps push or a rewind: forking from the node
      // it found would copy a conversation that has already moved on. Recheck
      // everything the entry gate checked before using that raw node.
      if (this.checkpointRuntime(sessionId) !== rt
        || rt.stepsRevision !== revision
        || rt.client.hasExited()
        || rt.busy || rt.rewinding || rt.replaying || rt.waking || rt.initializing) {
        report("This chat changed while the fork was being prepared. Try again.");
        return;
      }
      const step = steps.find((s) => s.kind === "prompt" && s.userMessageId === userMessageId);
      if (!step || !Number.isFinite(step.revertTargetNodeId)) {
        report("This message has no valid checkpoint.");
        return;
      }
      const forked = await rt.client.revertForkFromStep(rt.id, step.revertTargetNodeId);
      if (!forked) {
        report("Couldn't fork this chat: the agent did not return a new session.");
        return;
      }
      // The fork is a separate session with its own agent, so it is opened the way
      // any other existing chat is. It only takes the selection when the chat it
      // came from is still the one on screen and nothing navigated meanwhile: an
      // offscreen result is remembered for the session list instead of pulling
      // the user away from what they are reading.
      await this.rememberSession(forked, rt.cwd);
      if (this.activeId === rt.id && this.navigationVersion === navigationVersion) {
        await this.loadSession(forked);
        await this.refreshSessionsIfVisible(true);
      }
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    }
  }

  // Preview what rewinding to a prompt would undo (files + irreversible actions),
  // so the webview can render an inline confirmation before executing. The reply
  // goes back to the controller that asked: its token belongs to that page.
  private async handleRevertPreview(sessionId: string, userMessageId: string, token?: unknown): Promise<void> {
    const rt = this.checkpointRuntime(sessionId);
    // The agent's plan is only half the answer: it reports no file actions for the
    // edits it made through us, so the count of this chat's unreviewed files is
    // what tells the user their edits are staying on disk.
    const pendingFiles = rt ? rt.owner.changes.changesFor(rt.id).length : 0;
    if (!rt) {
      this.post({ type: "revertPreview", sessionId, userMessageId, token, pendingFiles, error: "This chat is not ready for checkpoint actions. Reopen it and try again." });
      return;
    }
    try {
      const result = await rt.client.revertPreview(rt.id, userMessageId);
      this.post({ type: "revertPreview", sessionId: rt.id, userMessageId, token, result, pendingFiles });
    } catch (err) {
      this.post({ type: "revertPreview", sessionId: rt.id, userMessageId, token, pendingFiles, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Execute a revert (edit-in-place submit, restore checkpoint, or undo). When
  // `resendText` is given, resend it as the next prompt after the rewind, on the
  // same session the rewind happened in. The whole operation is scoped to the
  // sessionId the webview named: a navigation while it runs cannot retarget the
  // mutation, the transcript trim, or the recovered draft onto another chat.
  private async handleRevertExecute(sessionId: string, userMessageId: string, resendText: unknown): Promise<void> {
    const rt = this.checkpointRuntime(sessionId);
    const text = typeof resendText === "string" ? resendText.trim() : undefined;
    // A repeat of the request already in flight is the same operation, not a
    // second one: answering it again would double the draft recovery and put a
    // second revert on the wire.
    if (rt?.rewinding && rt.rewinding.userMessageId === userMessageId && rt.rewinding.resendText === text) {
      return;
    }
    // The resend is captured against THIS session before the rewind's awaits: it
    // belongs to the chat being rewound, not to whatever is selected when the
    // agent answers, and a failure hands the text and its files back to it. The
    // owner is read again inside giveBack/fail because a surface move in between
    // retargets where the recovered draft and files land.
    const owner0 = rt?.owner ?? this;
    const resend = text
      ? owner0.pendingMessage(text, owner0.takeStaged(sessionId))
      : undefined;
    const ownerNow = () => this.checkpointRuntime(sessionId)?.owner ?? rt?.owner ?? this;
    const giveBack = () => {
      if (!resend) {
        return;
      }
      const owner = ownerNow();
      const held = owner.store.draft(sessionId);
      const recovered = held && held !== resend.text ? `${resend.text}\n\n${held}` : resend.text;
      owner.store.setDraft(sessionId, recovered);
      owner.restoreStaged(sessionId, resend.attachments);
      // Only paint the recovered draft into the composer this rewind still owns.
      if (owner.activeId === sessionId) {
        owner.postDraft();
      }
    };
    const fail = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      giveBack();
      const owner = ownerNow();
      if (owner.activeId === sessionId) {
        owner.post({ type: "error", text: message });
      } else {
        owner.log(`[revert-failed] ${sessionId}: ${message}`);
      }
    };
    if (!rt) {
      fail(new Error("This chat is not ready for checkpoint actions. Reopen it and try again."));
      return;
    }
    if (rt.rewinding) {
      fail(new Error("Wait for the current checkpoint action to finish."));
      return;
    }
    if (rt.busy || rt.replaying || rt.waking || rt.initializing || rt.client.hasExited()) {
      fail(new Error("Wait for the current response to finish before restoring a checkpoint."));
      return;
    }
    const operation = { userMessageId, resendText: text };
    rt.rewinding = operation;
    rt.owner.postCheckpoints(rt);
    let resendReady = false;
    try {
      if (!(await this.ensureReady())) {
        giveBack();
        return;
      }
      // The agent truncates the conversation but does NOT touch the client's disk,
      // and it does not tell us what to put back either: probing a real agent, the
      // file plan is empty even for files it edited through us. So read the plan,
      // rewind, apply whatever it did ask for, and keep everything it did not. A
      // preview that fails or is refused stops the whole operation: executing
      // without it would discard edits with no warning and no way back.
      const preview = await rt.client.revertPreview(rt.id, userMessageId);
      await rt.client.revertExecute(rt.id, userMessageId);
      // The conversation was rewound, so the painted record no longer matches it:
      // drop the target prompt and everything after it, keeping the earlier
      // history. When the local record cannot place the prompt (it was already
      // partial), the safe answer is an empty record that forces a fresh replay
      // rather than a guessed prefix.
      if (!rewindPainted(rt.log, userMessageId)) {
        rt.log = [];
        rt.logFull = false;
      }
      rt.bgBuffer = [];
      rt.steps = [];
      rt.stepsKnown = false;
      rt.stepsRevision++;
      // The rewind is authoritative the moment execute returns, so the history
      // change is committed before the file undo's awaits: a later failure there
      // must not leave the UI showing a transcript the agent already discarded.
      // Both controllers can hold a cached copy of this chat, so each is told;
      // the trimmed transcript itself only goes to the surface showing it now.
      this.post({ type: "sessionHistoryChanged", sessionId: rt.id });
      const owner = rt.owner;
      if (owner !== this) {
        owner.post({ type: "sessionHistoryChanged", sessionId: rt.id });
      }
      if (owner.activeId === rt.id) {
        owner.post({ type: "reverted", sessionId: rt.id, userMessageId, resending: !!resend });
      }
      const restored = await owner.applyRevertFileUndo(preview, rt);
      // Only the files that were really put back leave the working set. The rest
      // still hold the agent's edits, so they stay listed and undoable rather than
      // being silently abandoned on disk with no way back. The owner is read
      // again after the await: a surface move in between retargets both.
      rt.owner.changes.clearFor(rt.id, restored);
      // A mutation can remove checkpoints as well as add them, so the bindings
      // are re-read rather than trusted from before the rewind.
      await rt.owner.refreshCheckpoints(rt, true);
      resendReady = true;
    } catch (err) {
      fail(err);
      return;
    } finally {
      if (rt.rewinding === operation) {
        rt.rewinding = undefined;
        rt.owner.postCheckpoints(rt);
      }
      // A failed rewind still owes the queue its turn: sends that queued behind
      // the lock must not wait for a resend that will never come. The success
      // paths drain below once the resend (if any) is underway.
      if (!resendReady && rt.owner.runtimes.get(rt.id) === rt) {
        rt.owner.flushQueue(rt);
      }
    }
    if (resendReady && resend) {
      // The resend goes out on the runtime the rewind happened in, through the
      // same emit/runPrompt a queued message takes, so its echo records once and
      // buffers for a view that is not watching. The owner is captured
      // synchronously: whatever holds the runtime now is who paints it.
      const owner = rt.owner;
      owner.emit(rt, { type: "userMessage", text: resend.text, attachments: owner.shownAttachments(resend.attachments), clientMessageId: resend.id });
      const prompting = owner.runPrompt(rt, resend);
      owner.flushQueue(rt);
      await prompting;
    } else {
      // The lock is released, so whatever queued behind the rewind can go. With a
      // resend the drain already ran above, once its prompt was underway.
      rt.owner.flushQueue(rt);
    }
  }

  // Apply the file undo the agent planned in revert/preview, and report which
  // files it actually put back.
  //
  // The agent's own content is preferred over the working set's, because they are
  // not the same text: the working set holds what the file was before this chat
  // FIRST touched it, which for a file edited in two turns is older than the
  // checkpoint being restored, so using it would discard the earlier turn's work
  // as well (and delete a file that turn had created).
  //
  // Probed against a real agent: `fileActions` comes back empty even for a file
  // the agent edited through our own fs/write_text_file, and `revert/execute`
  // leaves the disk alone (`outcomes: []`). So in practice this restores nothing,
  // which is why the caller must keep whatever is left reviewable.
  private async applyRevertFileUndo(preview: RevertPreviewResult | undefined, rt: Runtime): Promise<string[]> {
    const actions = preview?.fileActions;
    if (!Array.isArray(actions) || !actions.length) {
      return [];
    }
    const restored: string[] = [];
    for (const a of actions) {
      const p = typeof a.path === "string" ? this.resolvePath(a.path, rt.id) : undefined;
      if (!p) {
        continue;
      }
      const original = (a.kind as { originalContent?: string } | undefined)?.originalContent;
      try {
        if (typeof original === "string") {
          await fs.promises.writeFile(p, original, "utf8");
          restored.push(p);
        } else if (a.action === "delete" && this.changes.hasUnresolvedChange(p)) {
          // The agent asking for the file to go. The working set knows whether it
          // existed before this chat, and deletes it if not. Only counted as put
          // back when it really was: an undo that failed still holds the agent's
          // content, and forgetting it would take away the only way back.
          if (await this.changes.reject(p)) {
            restored.push(p);
          }
        } else {
          this.log(`[revert] no content for ${p}, left as it is`);
        }
      } catch (err) {
        // A failed restore must not abort the rewind, but it must not be silent
        // either: the file still holds the agent's content.
        this.log(`[revert-failed] ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return restored;
  }

  // Settle every outstanding permission/elicitation request owned by a session
  // as cancelled, so the agent's client-side calls never hang and the resolver
  // maps do not leak. Used both by the user Stop button and by every teardown
  // path (terminate, delete, idle-exit, process exit), where these would
  // otherwise be left unresolved with a dead prompt still on screen.
  private settleRequestsFor(sessionId: string): void {
    if (!sessionId) {
      return;
    }
    for (const [rid, e] of [...this.permissionResolvers]) {
      if (e.rid === sessionId) {
        e.resolve({ outcome: { outcome: "cancelled" } });
        this.permissionResolvers.delete(rid);
      }
    }
    for (const [rid, e] of [...this.elicitationResolvers]) {
      if (e.rid === sessionId) {
        e.resolve({ action: "cancel" });
        this.elicitationResolvers.delete(rid);
      }
    }
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.awaiting = 0;
      // The questions/permissions are no longer outstanding, so drop the stored
      // payloads: they must not re-surface when the session is reopened.
      rt.pending = [];
    }
    // Close any open permission/question widgets for the visible session.
    if (this.activeId === sessionId) {
      this.post({ type: "cancelPrompts" });
    }
  }

  cancel(): void {
    const rt = this.active();
    if (rt) {
      // Stop interrupts only the current turn; any queued messages remain and
      // are sent once the interrupt settles (the user clears the queue by hand
      // if they meant to abandon it).
      this.cancelRuntime(rt);
    }
    // Whatever the agent was asking is answered now, with "cancelled", so the
    // question goes with the turn it belonged to. Settling the requests only
    // tells the agent: the widgets are on the other side and were left on
    // screen, still offering to answer a question nobody was waiting on.
    this.post({ type: "cancelPrompts" });
    // The composer stays busy until the turn really ends: cancel is a
    // notification, and the prompt stays open until the agent answers it, which
    // can take as long as the command it is waiting on. `endTurn` clears it
    // when the turn really ends, and drains anything queued in between.
  }

  // The menu uses cached usage until the user selects Refresh account usage.
  async showInfo(): Promise<void> {
    type Item = vscode.QuickPickItem & {
      action?: "chat" | "cloud" | "details" | "login" | "refreshUsage";
    };
    const a = this.health?.account;
    const org = a?.plan || a?.tier;
    const identity = this.isReady() && (a?.name || a?.email) ? a : undefined;
    const items: Item[] = [{ label: "Account", kind: vscode.QuickPickItemKind.Separator }];
    if (this.statusBar) {
      items.push(this.statusBar.getUsageItem(identity));
    }
    if (identity) {
      const name = identity.name?.trim();
      const email = identity.email?.trim();
      const distinct = !!name && !!email && name.toLowerCase() !== email.toLowerCase();
      items.push({
        label: `$(account) ${identity.name || identity.email}`,
        description: distinct ? email : undefined,
        detail: org
      });
    } else if (this.isReady()) {
      if (org) {
        items.push({ label: `$(organization) ${org}` });
      }
    } else {
      items.push({ label: "$(error) Not signed in", description: "Sign in", action: "login" });
    }
    const actions: Item[] = [
      { label: "$(comment-discussion) Open chat", action: "chat" },
      { label: "$(link-external) Open Devin Cloud", action: "cloud" }
    ];
    if (this.statusBar) {
      actions.push({ label: "$(refresh) Refresh account usage", action: "refreshUsage" });
    }
    actions.push({ label: "$(info) Connection details", action: "details" });
    items.push({ label: "Actions", kind: vscode.QuickPickItemKind.Separator }, ...actions);
    const picked = await vscode.window.showQuickPick(items, {
      title: "Devin",
      placeHolder: "Account usage and shortcuts",
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (picked?.action === "cloud") {
      await vscode.env.openExternal(vscode.Uri.parse("https://app.devin.ai"));
    } else if (picked?.action === "login") {
      await this.authenticate();
    } else if (picked?.action === "refreshUsage") {
      await this.statusBar?.refreshUsage();
      await this.showInfo();
    } else if (picked?.action === "chat") {
      await vscode.commands.executeCommand("devin.focusChat");
    } else if (picked?.action === "details") {
      await this.showConnectionDetails();
    }
  }

  private async showConnectionDetails(): Promise<void> {
    type Item = vscode.QuickPickItem & { action?: "back" };
    const items: Item[] = [
      { label: "$(arrow-left) Back to Devin", action: "back" },
      { label: "Model", description: this.currentModel || "Not reported" },
      { label: "Mode", description: this.currentMode || "Not reported" },
      { label: "Devin CLI", description: this.health?.version || "Unknown" }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: "Devin connection details" });
    if (picked?.action === "back") {
      await this.showInfo();
    }
  }

  async showSessionsView(): Promise<void> {
    this.focus();
    this.leaveToList();
    this.post({ type: "body", body: "list" });
    await this.refreshSessionsFast();
  }

  // Open the chat wearing this number in the list (Ctrl/Cmd+1..9).
  pickSession(index: number): void {
    this.focus();
    this.post({ type: "pickSession", index });
  }

  // Returning to the list should be instant: paint the cached listing at any age,
  // then revalidate in the background so it is still correct. Only a cold cache
  // waits on `devin list`.
  private async refreshSessionsFast(): Promise<void> {
    const warm = !!this.sessionsCache;
    await this.refreshSessions(false, true);
    if (warm) {
      void this.refreshSessions(true);
    }
  }

  // Set a runtime's busy state, mirroring it to the webview only when it is the
  // visible session, and refreshing the status dots.
  private setRuntimeBusy(rt: Runtime, value: boolean): void {
    const wasBusy = rt.busy;
    rt.busy = value;
    if (!wasBusy && value) {
      // Only a Fusion session has roles to mark, and only the model the turn
      // started under is attributable to its frames.
      rt.modelActivity = rt.model?.startsWith("fusion-") ? { model: rt.model, role: null } : undefined;
    }
    if (!value) {
      rt.modelActivity = undefined;
      rt.lastActivityAt = Date.now();
      // A finished turn is when the CLI names a new chat, so this is what puts
      // that name in the header and the lists without anyone asking for it.
      void this.refreshSessionsIfVisible(true);
    }
    if (this.activeId === rt.id) {
      this.post({ type: "busy", value });
    } else if (value) {
      // A backgrounded session started working, so the webview's saved
      // transcript for it is now stale and must be reloaded on return.
      this.post({ type: "sessionActivity", id: rt.id });
    }
    this.broadcastStatuses();
    if (wasBusy && !value) {
      // A finished turn changed both the context window and the ACU spend, and
      // the prompt channel is free again to ask for them. The forced read skips
      // the throttle so a fast turn inside the startup window still counts.
      this.refreshUsage(rt, true);
      void this.statusBar?.refreshUsage();
    }
  }

  private setBusy(value: boolean): void {
    const rt = this.active();
    if (rt) {
      this.setRuntimeBusy(rt, value);
    } else {
      this.post({ type: "busy", value });
    }
  }

  // Tell the webview which optional features are available/enabled so it can
  // gate edit-in-place, checkpoints, and undo.
  private postCapabilities(): void {
    this.post({
      type: "capabilities",
      // So a list of results can name the folder each one is in without repeating
      // the whole absolute path on every row.
      root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      revert: !!this.active()?.client.supportsRevert() && !!this.active()?.client.supportsRevertByUserMessageId(),
      subagentControl: !!this.active()?.client.supportsSubagentControl(),
      sessionShare: !!this.active()?.client.supportsSessionShare(),
      steering: !!this.active()?.client.supportsMidTurnPrompts(),
      editRequests: this.cfg().get<string>("editRequests", "inline"),
      checkpoints: this.cfg().get<boolean>("checkpoints.enabled", true),
      showFileChanges: this.cfg().get<boolean>("checkpoints.showFileChanges", true),
      confirmRemoval: this.cfg().get<boolean>("editing.confirmEditRequestRemoval", true),
      verbose: this.cfg().get<boolean>("verbose", true),
      progressBorder: this.cfg().get<boolean>("progressBorder.enabled", true),
      contextUsage: this.cfg().get<boolean>("contextUsage.enabled", true),
      inlineReferencesStyle: this.cfg().get<string>("inlineReferences.style", "box"),
      thinkingStyle: this.cfg().get<string>("thinking.style", "fixedScrolling"),
      streamAnim: this.cfg().get<string>("incrementalRendering.animationStyle", "rise"),
      panelSide: this.cfg().get<string>("sessionsPanel.side", "right"),
      sendWhileWorking: this.cfg().get<string>("sendWhileWorking", "steer"),
      surface: this.kind,
      sessionList: this.sessionListCaps()
    });
  }

  // Ask the agent for the session's context windows and ACU spend. The read
  // rides the same prompt channel as a turn, so it only runs while the session
  // is idle: a busy turn wins, and the finish/open triggers retry. The reply is
  // routed through `emit`, so a background session's figures wait in its own
  // buffer rather than painting into the chat on screen.
  private refreshUsage(rt: Runtime | undefined, force = false): void {
    if (rt?.id && this.runtimes.get(rt.id) === rt) {
      // The report lands on whichever surface owns the session when it
      // resolves, so a transfer mid read does not drop it.
      rt.owner = this;
    }
    if (!rt || !rt.id || !rt.initialized || rt.busy || rt.rewinding || rt.replaying || rt.silentReplay || rt.client.hasExited()) {
      return;
    }
    if (!this.cfg().get<boolean>("contextUsage.enabled", true)) {
      return;
    }
    if (rt.usagePending) {
      return;
    }
    const now = Date.now();
    if (!force && now - rt.usageRefreshedAt < 5000) {
      return;
    }
    rt.usageRefreshedAt = now;
    const sessionId = rt.id;
    const model = rt.model;
    this.emit(rt, { type: "usageState", loading: true });
    const pending = rt.client.readUsage(sessionId).then((report) => {
      const owner = rt.owner;
      if (!owner || owner.closed || owner.runtimes.get(sessionId) !== rt) {
        return;
      }
      const usage: Record<string, unknown> = { type: "usage" };
      // The context windows belong to the model they were read under; if the
      // session moved to another model mid read they are stale. Session ACUs
      // are not model scoped, so they still apply.
      if (report.contexts && rt.model === model) {
        usage.contexts = report.contexts;
        usage.contextModel = model;
      }
      if ("sessionAcus" in report) {
        usage.sessionAcus = report.sessionAcus;
      }
      // An agent that cannot answer returns an empty report: there is nothing
      // to paint, so only the loading state is settled.
      if (report.contexts || "sessionAcus" in report) {
        owner.emit(rt, usage);
      }
      owner.emit(rt, { type: "usageState", loading: false, error: report.error });
    }).catch(() => {
      const owner = rt.owner;
      if (owner && !owner.closed && owner.runtimes.get(sessionId) === rt) {
        owner.emit(rt, { type: "usageState", loading: false, error: "Could not refresh usage." });
      }
    }).finally(() => {
      if (rt.usagePending === pending) {
        rt.usagePending = undefined;
      }
    });
    rt.usagePending = pending;
  }

  // --- Incoming session/update notifications -------------------------------

  // Send a transcript message to the webview if its session is the visible one,
  // otherwise buffer it on the runtime so the missed stream can be replayed when
  // the user returns (background progress is never lost). History replays (a
  // session/load or a silent wake) are neither shown nor buffered here.
  private emit(rt: Runtime | undefined, payload: Record<string, unknown>): void {
    if (!rt) {
      return;
    }
    this.record(rt, payload);
    // The visible session streams straight into the transcript. This includes an
    // active session/load replay (rt.replaying), which is how a reload paints its
    // history; a silent background wake is suppressed (its cached view is shown).
    if (this.activeId === rt.id && !rt.silentReplay) {
      if (rt.replaying) {
        rt.replay.push(payload);
        if (rt.replay.length >= REPLAY_BATCH_SIZE) {
          this.flushReplay(rt);
        }
      } else {
        this.post(payload);
      }
      return;
    }
    // A live background turn (not a history replay): buffer so the user sees the
    // progress it made when they reopen the session.
    if (!rt.silentReplay && !rt.replaying) {
      rt.bgBuffer.push(payload);
      if (rt.bgBuffer.length > BG_BUFFER_MAX) {
        rt.bgBuffer.splice(0, rt.bgBuffer.length - BG_BUFFER_MAX);
      }
    }
  }

  // Track which Fusion role produced the latest meaningful update of a running
  // turn, so the composer can mark the model actually working. The role is
  // ephemeral chrome, not transcript: it posts only for the visible session and
  // is never recorded or buffered. A background runtime still keeps its own
  // state, which activateSession restores when the session comes back.
  private updateModelActivity(rt: Runtime | undefined, u: any): void {
    if (!rt || this.runtimes.get(rt.id) !== rt || !rt.busy || rt.replaying || rt.silentReplay) {
      return;
    }
    const activity = rt.modelActivity;
    // A mid turn model change leaves the snapshot stale: the old request's
    // frames cannot be attributed to its replacement, so the label stays quiet.
    if (!activity || activity.model !== rt.model) {
      return;
    }
    const role = activityRole(u);
    if (!role || role === activity.role) {
      return;
    }
    activity.role = role;
    if (this.activeId === rt.id) {
      this.post({ type: "modelActivity", sessionId: rt.id, model: activity.model, role });
    }
  }

  private onUpdate(n: SessionUpdateNotification, owner?: Runtime): void {
    const u = n.update as any;
    const rt = this.runtimeBySessionId(n.sessionId, owner);
    this.updateModelActivity(rt, u);
    // A user message being accumulated for replay ends where the transcript
    // moves on to anything the agent produced.
    if (rt?.replaying && rt.replayUser && REPLAY_USER_ENDS.has(String(u.sessionUpdate))) {
      this.flushReplayUser(rt);
    }
    // Context windows ride `_meta` on parent and delegated updates alike: the
    // real Sub report is tagged parentAgentId "sidekick" and would be filtered
    // out by the subagent dispatch below, so it is lifted here first. A raw
    // array is a whole snapshot, while a single object merges into the stored
    // picture (which is how the Sub's own report joins the Lead's).
    const contextReport = contextReportFromUpdate(u);
    if (contextReport !== undefined && (u.sessionUpdate !== "usage_update" || subagentParent(u))) {
      this.emit(rt, { type: "usage", contexts: contextReport });
    }
    // Delegated work arrives on the same stream as the parent's, tagged in
    // `_meta`. Lift the lifecycle out first, then hand the rest to the switch
    // with the owning subagent attached so the webview can nest it.
    if (this.onSubagentUpdate(u, rt)) {
      return;
    }
    const parentId = rt ? this.subagentBlockId(rt, subagentParent(u)) : undefined;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const img = imageOf(u.content);
        if (parentId) {
          this.emit(rt, { type: "subagentChunk", parentId, stream: "message", text: textOf(u.content) });
        } else if (img) {
          this.emit(rt, { type: "assistantImage", mime: img.mimeType, data: img.data, messageId: u.messageId });
        } else {
          this.emit(rt, { type: "assistantChunk", text: textOf(u.content), messageId: u.messageId });
        }
        return;
      }
      case "user_message_chunk": {
        // The stable prompt id the send declared arrives in _meta, not the
        // standard messageId; that id is what checkpoint bindings match on.
        const metaId = u._meta?.["cognition.ai/clientMessageId"];
        const messageId = typeof metaId === "string" ? metaId : u.messageId;
        if (rt?.replaying) {
          // During a history replay the chunks of one user message are
          // accumulated and flushed whole, so the saved sent manifest can
          // restore the exact text and attachments it was sent with.
          this.accumulateReplayUser(rt, { messageId, content: u.content });
          return;
        }
        // A replayed request carries what was attached to it as its own content
        // blocks. Reading only the text out of them lost the attachments on every
        // reload, so a request that had asked about a screenshot came back bare.
        this.emit(rt, {
          type: "userChunk",
          text: textOf(u.content),
          messageId,
          attachments: replayedAttachments(u.content)
        });
        return;
      }
      case "agent_thought_chunk":
        if (this.cfg().get<boolean>("showThinking", true)) {
          if (parentId) this.emit(rt, { type: "subagentChunk", parentId, stream: "thought", text: textOf(u.content) });
          // A replayed thought is not being timed: it already happened, so the
          // panel must not present the replay's own elapsed time as how long
          // Devin thought for. `cognition.ai/timestamp` cannot stand in for the
          // duration (it is per message node, so a thought and the tool call it
          // led to carry the same one), but it does say when it happened, which
          // the panel shows on hover instead.
          else this.emit(rt, {
            type: "thoughtChunk",
            text: textOf(u.content),
            messageId: u.messageId,
            replayed: rt?.replaying === true,
            at: metaTimestamp(u)
          });
        }
        return;
      case "plan":
        this.emit(rt, { type: "plan", entries: u.entries });
        return;
      case "tool_call":
        this.trackBackgroundShell(rt, u);
        this.emit(rt, {
          type: "toolCall",
          id: u.toolCallId,
          parentId,
          title: u.title,
          kind: u.kind,
          meta: toolMeta(u),
          status: u.status || "pending",
          rawInput: u.rawInput,
          content: normalizeToolContent(u.content, rt ? (p) => this.editId(rt, p) : undefined),
          locations: normalizeLocations(u.locations),
          terminalId: claimTerminal(rt, u)
        });
        this.recordDiffs(u, rt);
        return;
      case "tool_call_update":
        this.trackBackgroundShell(rt, u);
        this.emit(rt, {
          type: "toolCallUpdate",
          id: u.toolCallId,
          parentId,
          title: u.title,
          kind: u.kind,
          meta: toolMeta(u),
          status: u.status,
          rawInput: u.rawInput,
          content: normalizeToolContent(u.content, rt ? (p) => this.editId(rt, p) : undefined),
          locations: normalizeLocations(u.locations)
        });
        this.recordDiffs(u, rt);
        return;
      case "usage_update":
        if (!parentId) this.emit(rt, {
          type: "usage", used: u.used, size: u.size, cost: u.cost,
          contexts: contextReport
        });
        return;
      case "available_commands_update":
        this.emit(rt, { type: "commands", commands: u.availableCommands });
        // Commands can arrive after the session already looked unqueryable:
        // the first usage read ran before the reads were advertised. The gates
        // inside keep this a no-op while a turn or another read is in flight.
        this.refreshUsage(rt, true);
        return;
      case "current_mode_update":
        if (rt) rt.mode = u.currentModeId || rt.mode;
        if (rt && !rt.silentReplay && this.showOptions(rt, u.currentModeId)) {
          this.post({ type: "mode", mode: u.currentModeId });
        }
        return;
      // The mode or model changed somewhere other than our own pickers: a `/model`
      // slash command, or another client on the same session. Without this the
      // composer keeps showing the model the session is no longer using.
      case "config_option_update":
        this.publishOptions(rt, u.configOptions);
        return;
      // The agent names a session after its first request, and renames it as the
      // conversation moves on. This is the push feed for that, so the header, the
      // lists and the editor tab follow it without waiting for a `devin list`.
      case "session_info_update":
        if (rt && typeof u.title === "string" && u.title.trim()) {
          this.applyAgentTitle(rt, u.title.trim());
        }
        return;
      default:
        return;
    }
  }

  // Handle the subagent lifecycle, returning true when the update was one and
  // needs no further rendering.
  //
  // The parent's `run_subagent` call is what owns the rendered block: it is the
  // only part of a subagent a reloaded session is guaranteed to get back (the
  // CLI replays a foreground subagent's whole transcript, but of a background one
  // keeps just this row), and its `rawInput` already holds the task, the prompt
  // and the mode. The `subagent_started` tag that follows carries the agentId
  // everything else is tagged with, so it is bound to the block rather than
  // rendered itself.
  private onSubagentUpdate(u: any, rt?: Runtime): boolean {
    if (!rt) {
      return false;
    }
    const started = subagentStarted(u);
    if (started) {
      const spawn = takeSubagentSpawn(rt, started.title);
      const id = spawn || started.agentId;
      rt.subagentIds.set(started.agentId, id);
      this.emit(rt, {
        type: "subagentStart",
        id,
        title: started.title,
        task: started.task,
        profile: started.profile,
        background: started.isBackground === true
      });
      return true;
    }
    const completed = subagentCompleted(u);
    if (completed) {
      const id = this.subagentBlockId(rt, completed.agentId);
      rt.subagentIds.delete(completed.agentId);
      this.emit(rt, {
        type: "subagentEnd",
        id,
        success: completed.success !== false,
        summary: completed.summary
      });
      return true;
    }
    if (u._meta?.["cognition.ai/inferenceToolName"] !== "run_subagent") {
      return false;
    }
    const raw = u.rawInput;
    if (raw && typeof raw === "object") {
      rt.subagentSpawns.push({ id: u.toolCallId, title: String(raw.title || "") });
      this.emit(rt, {
        type: "subagentStart",
        id: u.toolCallId,
        title: raw.title,
        task: raw.task,
        profile: profileName(raw.profile),
        background: raw.is_background === true
      });
      return true;
    }
    // A spawn that failed never produces a lifecycle of its own, so it has to
    // close its own block or it would shimmer forever. Drop it from the waiting
    // list too, or the next subagent to start could claim it as its own.
    if (u.status === "failed" || u.status === "cancelled") {
      rt.subagentSpawns = rt.subagentSpawns.filter((s) => s.id !== u.toolCallId);
      this.emit(rt, {
        type: "subagentEnd",
        id: u.toolCallId,
        success: false,
        summary: textOf(firstContent(u.content))
      });
    }
    return true;
  }

  // The block id a subagent's own agentId belongs to (itself, when the spawn
  // that created it was never seen).
  private subagentBlockId(rt: Runtime, agentId?: string): string | undefined {
    if (!agentId) {
      return undefined;
    }
    return rt.subagentIds.get(agentId) || agentId;
  }

  // The edit row a file's change belongs to. There is one row per file per turn,
  // so that is what the row's own diff covers: what this turn did to this file,
  // as against the working set, which is everything still awaiting review.
  private editId(rt: Runtime, fsPath: string): string {
    return `${rt.id}#${rt.turnCount}#${fsPath}`;
  }

  private recordDiffs(u: any, rt?: Runtime): void {
    // Historical diffs from a session/load replay are already resolved, so they
    // are not part of an actionable working set. A background session's edits
    // are tracked under that session and shown when it is next opened.
    if (!rt || rt.replaying) {
      return;
    }
    const content = Array.isArray(u.content) ? u.content : [];
    for (const c of content) {
      if (c && c.type === "diff" && typeof c.path === "string") {
        // Against the session's own directory, like every other agent supplied path:
        // resolving a relative one against the extension host's working directory
        // gives a path in the VS Code install, which is then what an undo writes to.
        const full = this.resolvePath(c.path, rt.id);
        const s = diffStat(c.oldText, c.newText);
        const editId = this.editId(rt, full);
        this.changes.recordEdit(editId, full, c.oldText ?? null, c.newText ?? "");
        // Post the per-file counts before recordDiff fires the working-set list,
        // so the list renders with the deltas already known.
        this.emit(rt, { type: "fileChange", path: full, added: s.added, removed: s.removed, created: c.oldText == null || c.oldText === "", editId });
        // `oldText` is optional on the wire, and a missing one must not become the
        // sentinel that makes Undo delete the file: only our own read of the disk
        // can say a file did not exist. Without a baseline there is nothing to
        // review against, so the row stands on its own and the file is left out of
        // the working set until the write itself records it.
        if (typeof c.oldText === "string") {
          this.changes.recordDiff(full, c.oldText, c.newText ?? "", rt.id, s);
        }
      }
    }
  }

  // --- AcpHost implementation (agent -> client requests) -------------------

  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const tc = params.toolCall || ({} as RequestPermissionParams["toolCall"]);
    // Devin asks about a command without a title, putting the command itself in
    // `_meta`. Without it the widget could only say "a tool", which is not enough
    // to answer: the user has to see what would run.
    const command = typeof tc._meta?.["cognition.ai/editableCommand"] === "string"
      ? (tc._meta["cognition.ai/editableCommand"] as string).trim()
      : undefined;
    const rt = this.runtimeBySessionId(params.sessionId);
    if (command && rt?.mode === "bypass") {
      const allow = params.options.find((option) => option.optionId === "allow_once");
      if (allow) {
        return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
      }
    }
    const requestId = `perm-${++ChatController.permissionSeq}`;
    const payload = {
      type: "permission",
      requestId,
      title: tc.title || (command ? "Devin wants to run a command" : "Devin wants to run a tool"),
      kind: tc.kind,
      command,
      toolCallId: tc.toolCallId,
      content: tc.content,
      locations: tc.locations,
      options: params.options
    };
    if (rt) {
      rt.awaiting++;
      rt.pending.push({ requestId, payload });
    }
    // Show now if it's the visible session; otherwise mark it "attention" and
    // re-surface when the session is opened, plus a one-off notification so the
    // user knows a background session is blocked waiting on them.
    if (!rt || this.activeId === rt.id) {
      this.post(payload);
    } else {
      this.notifyBackgroundAttention(rt);
    }
    this.broadcastStatuses();
    return new Promise<RequestPermissionResult>((resolve) => {
      this.permissionResolvers.set(requestId, { resolve, rid: rt?.id || this.activeId || "" });
    });
  }

  private resolvePermission(requestId: string, optionId: unknown): void {
    const e = this.permissionResolvers.get(requestId);
    if (!e) {
      return;
    }
    this.permissionResolvers.delete(requestId);
    this.clearAwaiting(e.rid, requestId);
    if (typeof optionId === "string" && optionId.length > 0) {
      e.resolve({ outcome: { outcome: "selected", optionId } });
    } else {
      e.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  // The agent asks the user a structured question (e.g. ask_user_question).
  private readonly elicitationResolvers = new Map<string, { resolve: (res: unknown) => void; rid: string }>();
  private static elicitationSeq = 0;

  createElicitation(params: any): Promise<unknown> {
    const rt = this.runtimeBySessionId(typeof params?.sessionId === "string" ? params.sessionId : undefined);
    const requestId = `elicit-${++ChatController.elicitationSeq}`;
    const payload = {
      type: "elicitation",
      requestId,
      mode: params?.mode || "form",
      message: params?.message || "",
      schema: params?.requestedSchema,
      allowOther: params?._meta?.["cognition.ai/allowOther"] === true,
      url: params?.url
    };
    if (rt) {
      rt.awaiting++;
      rt.pending.push({ requestId, payload });
    }
    if (!rt || this.activeId === rt.id) {
      this.post(payload);
    } else {
      this.notifyBackgroundAttention(rt);
    }
    this.broadcastStatuses();
    return new Promise((resolve) => {
      this.elicitationResolvers.set(requestId, { resolve, rid: rt?.id || this.activeId || "" });
    });
  }

  private resolveElicitation(requestId: string, action: string, content: unknown): void {
    const e = this.elicitationResolvers.get(requestId);
    if (!e) {
      return;
    }
    this.elicitationResolvers.delete(requestId);
    this.clearAwaiting(e.rid, requestId);
    if (action === "accept") {
      e.resolve({ action: "accept", content: content ?? null });
    } else {
      e.resolve({ action: action === "decline" ? "decline" : "cancel" });
    }
  }

  // Drop a resolved request from its runtime's awaiting count and remove the
  // stored pending payload for the request just answered.
  private clearAwaiting(rid: string, requestId: string): void {
    const rt = this.runtimes.get(rid);
    if (rt) {
      rt.awaiting = Math.max(0, rt.awaiting - 1);
      rt.pending = rt.pending.filter((p) => p.requestId !== requestId);
      // Attention episode is over once nothing is outstanding: allow the next
      // background block to notify again.
      if (rt.awaiting === 0) {
        rt.attentionNotified = false;
      }
    }
    this.broadcastStatuses();
  }

  // A backgrounded session is now blocked waiting on the user. Show one toast
  // per attention episode (not per tool call) with an Open action that brings
  // this surface forward and opens the session so its request can be answered.
  private notifyBackgroundAttention(rt: Runtime): void {
    if (rt.attentionNotified) {
      return;
    }
    rt.attentionNotified = true;
    const title = this.store.titles()[rt.id] || "a background session";
    void vscode.window.showInformationMessage(`Devin needs your input in ${title}.`, "Open").then((choice) => {
      if (choice === "Open") {
        this.focus();
        this.post({ type: "body", body: "thread" });
        this.post({ type: "openSession", id: rt.id });
      }
    });
  }

  // Resolve an agent-supplied path against the session's cwd when it is
  // relative, so it never accidentally resolves against the extension host's
  // own working directory.
  private resolvePath(p: string, sessionId?: string): string {
    if (path.isAbsolute(p)) {
      return p;
    }
    const base = this.runtimeBySessionId(sessionId)?.cwd || this.cwd();
    return path.join(base, p);
  }

  async readTextFile(params: ReadTextFileParams): Promise<{ content: string }> {
    const full = this.resolvePath(params.path, params.sessionId);
    let content = await fs.promises.readFile(full, "utf8");
    if (params.line || params.limit) {
      const lines = content.split("\n");
      const start = Math.max(0, (params.line ?? 1) - 1);
      const end = params.limit ? start + params.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    return { content };
  }

  // Each runtime owns its own TerminalManager, so terminal client requests are
  // routed to the runtime that owns the session.
  createTerminal(params: CreateTerminalParams): { terminalId: string } {
    const rt = this.runtimeBySessionId(params.sessionId);
    if (!rt) {
      return { terminalId: "" };
    }
    const created = rt.terminals.create(params);
    // The tool call for this command lands a moment later and says nothing about
    // the terminal, so the row would have no way to show the output arriving. We
    // are the ones running it, so hold on to the command and hand the id to the
    // row that matches.
    rt.pendingTerminals.push({ id: created.terminalId, command: params.command });
    if (rt.pendingTerminals.length > 8) {
      rt.pendingTerminals.shift();
    }
    return created;
  }

  terminalOutput(params: TerminalRef): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null } {
    const rt = this.runtimeBySessionId(params.sessionId);
    return rt ? rt.terminals.output(params.terminalId) : { output: "", truncated: false, exitStatus: null };
  }

  waitForTerminalExit(params: TerminalRef): Promise<TerminalExitStatus> {
    const rt = this.runtimeBySessionId(params.sessionId);
    return rt ? rt.terminals.waitForExit(params.terminalId) : Promise.resolve({ exitCode: null, signal: null });
  }

  // Empty-object results, not null: the agent deserializes these responses into
  // structs and rejects a bare null with a "Parse error" (as fs/write_text_file
  // did). An empty object is the safe "void" response.
  killTerminal(params: TerminalRef): Record<string, never> {
    this.runtimeBySessionId(params.sessionId)?.terminals.kill(params.terminalId);
    return {};
  }

  releaseTerminal(params: TerminalRef): Record<string, never> {
    this.runtimeBySessionId(params.sessionId)?.terminals.release(params.terminalId);
    return {};
  }

  // What the editor already knows is wrong with a file the agent names. Unscoped
  // pulls receive nothing, so workspace wide editor noise never enters the chat.
  // Documents must also be open, which `sendDocumentEvent` covers.
  requestDiagnostics(params: RequestDiagnosticsParams): RequestDiagnosticsResult {
    if (!this.cfg().get<boolean>("editorContext.diagnostics", true) || !params.path) {
      return { items: [] };
    }
    const runtimes = [...new Set([...this.runtimes.values(), ...this.spawnedRuntimes])];
    const runtime = params.sessionId
      ? runtimes.find((candidate) => candidate.id === params.sessionId)
      : runtimes.length === 1
        ? runtimes[0]
        : undefined;
    if (!runtime?.busy) {
      return { items: [] };
    }
    const only = params.path ? vscode.Uri.file(this.resolvePath(params.path, runtime.id)) : undefined;
    const entries = only
      ? [[only, vscode.languages.getDiagnostics(only)] as [vscode.Uri, readonly vscode.Diagnostic[]]]
      : vscode.languages.getDiagnostics();
    return {
      items: diagnosticItems(entries, {
        touched: new Set(this.changes.pathsFor(runtime.id)),
        roots: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)
      })
    };
  }

  async writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
    const full = this.resolvePath(params.path, params.sessionId);
    let bytes: Buffer | undefined;
    try {
      bytes = await fs.promises.readFile(full);
    } catch (err) {
      // Only "it is not there" may become a null original: that is the sentinel for
      // a file this chat created, and it is what makes Undo DELETE rather than
      // restore. Folding a permission error, a lock, or running out of file handles
      // into it meant an edit to an existing file was recorded as a creation, and
      // undoing it deleted the user's file with nothing kept to put back.
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw err;
      }
      bytes = undefined;
    }
    const original = bytes ? bytes.toString("utf8") : null;
    // Reading a UTF-16 or Latin-1 file as text gives replacement characters, and
    // writing that back would destroy every byte they stood for. Refuse instead:
    // the agent is told why, which is better than a file it silently ruined.
    if (bytes && original !== null && !bytes.equals(Buffer.from(original, "utf8"))) {
      throw new Error(`${path.basename(full)} is not UTF-8 text, so it was left alone.`);
    }
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // Keep the file's own line endings: the agent writes LF, and rewriting a
    // CRLF file with it would show every line as changed in git.
    let content = original && /\r\n/.test(original) && !/\r\n/.test(params.content)
      ? params.content.replace(/\n/g, "\r\n")
      : params.content;
    // And keep its byte order mark for the same reason: the agent's content will
    // not have one, and dropping it is a real change to a .csproj, a .ps1 or
    // anything else Windows authored, on a line the diff does not even show.
    if (original && original.startsWith("\uFEFF") && !content.startsWith("\uFEFF")) {
      content = "\uFEFF" + content;
    }
    await fs.promises.writeFile(full, content, "utf8");
    // The edit is tracked against the session that made it, so a background
    // session's working set is waiting for it when it is next opened.
    const rt = this.runtimeBySessionId(params.sessionId);
    if (rt) {
      const s = diffStat(original, content);
      const editId = this.editId(rt, full);
      this.changes.recordEdit(editId, full, original, content);
      this.emit(rt, { type: "fileChange", path: full, added: s.added, removed: s.removed, created: original == null, editId });
      this.changes.recordDiff(full, original, content, rt.id, s);
    }
    // The agent's fs/write_text_file expects an (empty) object result; returning
    // null makes it report a spurious "Parse error" even though the write landed.
    return {};
  }

  // --- HTML ---------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "mermaid.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon", "codicon.css")
    );
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "devin-logo.svg"));
    // The panel markup lives in a standalone file so the webview harness
    // (scripts/webview-harness.js) can mount the exact same DOM in tests.
    const appBody = fs.readFileSync(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview-body.html").fsPath,
      "utf8"
    );
    const modelIcon = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "models", f)).toString();
    const modelIcons = JSON.stringify({
      claude: modelIcon("claude.svg"),
      openai: modelIcon("openai.svg"),
      grok: modelIcon("grok.svg")
    }).replace(/"/g, "&quot;");
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Devin</title>
</head>
<body data-logo="${logoUri}" data-model-icons="${modelIcons}" data-mermaid-src="${mermaidUri}" data-nonce="${nonce}" data-surface="${this.kind}">
  ${appBody}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface ToolContentItem {
  type: string;
  text?: string;
  path?: string;
  terminalId?: string;
  added?: number;
  removed?: number;
  created?: boolean;
  mime?: string;
  data?: string;
  // Which edit this diff belongs to, so its row can open just that edit.
  editId?: string;
  // A file a tool pointed at rather than quoted: rendered as a pill that opens it.
  link?: boolean;
}

// Flatten ACP tool-call content into renderable items for the webview.
function normalizeToolContent(content: any, editId?: (path: string) => string): ToolContentItem[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: ToolContentItem[] = [];
  for (const c of content) {
    if (!c) {
      continue;
    }
    if (c.type === "diff" && typeof c.path === "string") {
      const s = diffStat(c.oldText, c.newText);
      // `created` so a reloaded transcript can say Created rather than Edited: it
      // has only the tool call to go on, never the live change event.
      out.push({
        type: "diff",
        path: c.path,
        added: s.added,
        removed: s.removed,
        created: c.oldText == null || c.oldText === "",
        editId: editId ? editId(c.path) : undefined
      });
    } else if (c.type === "terminal" && typeof c.terminalId === "string") {
      out.push({ type: "terminal", terminalId: c.terminalId });
    } else if (c.type === "content") {
      const img = imageOf(c.content);
      const link = c.content && c.content.type === "resource_link" && typeof c.content.uri === "string"
        ? { uri: c.content.uri as string, name: c.content.name as string | undefined }
        : undefined;
      if (img) {
        out.push({ type: "image", mime: img.mimeType, data: img.data });
      } else if (link) {
        // A file the tool is pointing at (a search hit, a listing). Dropped before
        // now, because only text and images were read out of a content block.
        out.push({ type: "link", path: fileFromUri(link.uri), text: link.name });
      } else {
        const text = textOf(c.content);
        if (text) {
          out.push({ type: "text", text });
        }
      }
    } else if (typeof c.text === "string") {
      out.push({ type: "text", text: c.text });
    }
  }
  return out;
}

// An image content block ({ type: "image", mimeType, data }), or null.
function imageOf(content: any): { mimeType?: string; data: string } | null {
  if (content && content.type === "image" && typeof content.data === "string" && content.data) {
    return { mimeType: content.mimeType, data: content.data };
  }
  return null;
}

// Devin tags each tool with its real identity in `_meta` (the ACP `kind` is a
// coarse bucket, e.g. both web search and fetch report kind "fetch"). We surface
// these so the webview can render web search / fetch / MCP tools distinctly.
function toolMeta(u: any): { inferenceToolName?: string; toolName?: string; eventType?: string } | undefined {
  const m = u && u._meta;
  const out: { inferenceToolName?: string; toolName?: string; eventType?: string } = {};
  if (typeof u?.name === "string") out.inferenceToolName = u.name;
  if (m && typeof m === "object") {
    if (typeof m["cognition.ai/inferenceToolName"] === "string") out.inferenceToolName = m["cognition.ai/inferenceToolName"];
    if (typeof m["cognition.ai/toolName"] === "string") out.toolName = m["cognition.ai/toolName"];
    if (typeof m["cognition.ai/eventType"] === "string") out.eventType = m["cognition.ai/eventType"];
  }
  return Object.keys(out).length ? out : undefined;
}

// --- Subagent tags on a session update -----------------------------------
// A subagent announces itself on a tool_call_update whose toolCallId is its own
// agentId, and finishes the same way carrying its report. Everything it does in
// between is tagged with the agentId that produced it.
function subagentStarted(u: any): SubagentStarted | undefined {
  const s = u?._meta?.["cognition.ai/subagent_started"];
  return s && typeof s.agentId === "string" ? (s as SubagentStarted) : undefined;
}

function subagentCompleted(u: any): SubagentCompleted | undefined {
  const c = u?._meta?.["cognition.ai/subagent_completed"];
  return c && typeof c.agentId === "string" ? (c as SubagentCompleted) : undefined;
}

// When the agent produced this update, as the CLI records it on the message node
// it belongs to. Only useful on a replay: live content is happening now.
function metaTimestamp(u: any): string | undefined {
  const at = u?._meta?.["cognition.ai/timestamp"];
  return typeof at === "string" && at ? at : undefined;
}

function subagentParent(u: any): string | undefined {
  const id = u?._meta?.["cognition.ai/subagent_context"]?.parentAgentId;
  return typeof id === "string" && id ? id : undefined;
}

// Which Fusion role a session update most recently showed doing meaningful
// work, if any. Nonempty thought or message text, a tool call, and a tool
// update moving to in progress all count. They mark the latest role observed
// producing work rather than proving a model is generating. Report replies,
// lifecycle noise and terminal tool completions never move the marker, and
// neither does a spawned subagent's work: it is its own agent, not a role.
function activityRole(u: any): "lead" | "sub" | undefined {
  const meta = u?._meta;
  let meaningful = false;
  switch (u?.sessionUpdate) {
    case "agent_thought_chunk":
    case "agent_message_chunk":
      // Context/ACU report replies ride this stream as chunks and say nothing
      // about which model is working.
      if (meta?.["cognition.ai/instant"] === true
        || meta?.["cognition.ai/contextUsage"] !== undefined
        || meta?.["cognition.ai/sessionStats"] !== undefined) {
        return undefined;
      }
      meaningful = !!textOf(u.content).trim();
      break;
    case "tool_call":
      meaningful = true;
      break;
    case "tool_call_update":
      meaningful = u.status === "in_progress";
      break;
    default:
      break;
  }
  if (!meaningful) {
    return undefined;
  }
  const parent = subagentParent(u);
  // Frames another worker produced carry its own parent id, so they are not a
  // Fusion role even when they also carry the sidekick flag.
  if (parent && parent !== "sidekick") {
    return undefined;
  }
  return parent === "sidekick" || meta?.["cognition.ai/sidekick"] === true ? "sub" : "lead";
}

// Claim the spawn a starting subagent belongs to. Both sides carry the same
// title, which is what tells parallel spawns apart; without a match take the
// oldest still-unclaimed one.
function takeSubagentSpawn(rt: Runtime, title?: string): string | undefined {
  const i = rt.subagentSpawns.findIndex((s) => s.title === (title || ""));
  const [spawn] = rt.subagentSpawns.splice(i >= 0 ? i : 0, 1);
  return spawn?.id;
}

// "subagent_explore" is the profile as the tool takes it; the display name the
// lifecycle reports for the same profile is "Explore".
function profileName(profile: unknown): string | undefined {
  if (typeof profile !== "string" || !profile) {
    return undefined;
  }
  const name = profile.replace(/^subagent[_-]/, "").replace(/[_-]+/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function firstContent(content: any): any {
  const first = Array.isArray(content) ? content[0] : undefined;
  return first && first.type === "content" ? first.content : first;
}

function normalizeLocations(locations: any): { path: string; line?: number }[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations
    .filter((l) => l && typeof l.path === "string")
    .map((l) => ({ path: l.path, line: typeof l.line === "number" ? l.line : undefined }));
}

function textOf(content: any): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (content.type === "text") {
    return content.text || "";
  }
  // An embedded resource carries its own text (a file a tool is quoting back).
  if (content.type === "resource" && content.resource && typeof content.resource.text === "string") {
    return content.resource.text;
  }
  return "";
}

// What was attached to a request, read back out of the content blocks it was sent
// as: a file it pointed at, or a picture, which travels with its data so the pill
// can show it.
function replayedAttachments(content: unknown): { label: string; type: string; thumb?: string }[] {
  const blocks = Array.isArray(content) ? content : [content];
  const out: { label: string; type: string; thumb?: string }[] = [];
  for (const b of blocks) {
    const block = b as {
      type?: string; uri?: string; name?: string; mimeType?: string; data?: string;
      resource?: { uri?: string }
    };
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "image" && block.data) {
      out.push({ label: "Image", type: "image", thumb: `data:${block.mimeType || "image/png"};base64,${block.data}` });
    } else if (block.type === "resource_link" && block.uri) {
      out.push({ label: block.name || path.basename(fileFromUri(block.uri) || block.uri), type: "file" });
    } else if (block.type === "resource" && block.resource?.uri) {
      // A file attachment: the pill names it, its contents stay out of the
      // typed message body.
      out.push({ label: path.basename(fileFromUri(block.resource.uri) || block.resource.uri), type: "file" });
    }
  }
  return out;
}

// The terminal this tool call is running in. The agent asks the client to create
// one, then only reads it once it has exited, so the call itself never mentions
// it: the command is the only thing they share. Matching on it lets the row show
// the output as it arrives, which is ours to show because we are running it.
function claimTerminal(rt: Runtime | undefined, u: { rawInput?: Record<string, unknown> }): string | undefined {
  const command = typeof u.rawInput?.command === "string" ? u.rawInput.command : "";
  if (!rt || !command) {
    return undefined;
  }
  const i = rt.pendingTerminals.findIndex((t) => t.command === command);
  if (i < 0) {
    return undefined;
  }
  return rt.pendingTerminals.splice(i, 1)[0].id;
}

// One of the CLI's own response figures as text: it supplies the number, the unit
// and both spellings of it, so the panel only has to pick the right one.
function dimensionText(d: ResponseDimension): string {
  const k = d.kind;
  if (!k || k.value === undefined || k.value === null) {
    return "";
  }
  if (typeof k.value === "string") {
    return k.value;
  }
  const rounded = Math.abs(k.value) >= 10 || Number.isInteger(k.value)
    ? Math.round(k.value).toLocaleString()
    : k.value.toFixed(2);
  const unit = Math.abs(k.value) === 1 ? k.tail : k.pluralTail || k.tail;
  return `${k.prefix || ""}${rounded}${unit || ""}`;
}

// The path inside a file URI, for a resource a tool points at.
function fileFromUri(uri: string): string {
  try {
    return /^file:/i.test(uri) ? vscode.Uri.parse(uri).fsPath : uri;
  } catch {
    return uri;
  }
}

// Quote a binary path for the user's shell before it is sent to a VS Code
// terminal. On POSIX, single-quote and escape any embedded single quotes so no
// path metacharacter ($, ;, spaces, quotes) can break out; on Windows, paths
// cannot contain `"`, so double-quoting when there is whitespace is enough.
function quote(p: string): string {
  if (process.platform === "win32") {
    return /\s/.test(p) ? `"${p}"` : p;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function getNonce(): string {
  // A CSP nonce must be unguessable, so use a CSPRNG rather than Math.random.
  return crypto.randomBytes(16).toString("hex");
}
