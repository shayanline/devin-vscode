import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AcpClient, AcpHost } from "../acp/client";
import {
  AgentStopped,
  CliOutput,
  ConfigOption,
  ContentBlock,
  PromptResult,
  CreateTerminalParams,
  NewSessionResult,
  ReadTextFileParams,
  RequestPermissionParams,
  RequestPermissionResult,
  ResponseDimension,
  RevertPreviewResult,
  SessionUpdateNotification,
  SubagentCompleted,
  SubagentStarted,
  TerminalExitStatus,
  TerminalRef,
  WriteTextFileParams
} from "../acp/types";
import { TerminalManager } from "../acp/terminal";
import { DevinSession, listSessions } from "../session/sessionList";
import { SessionStore } from "../session/sessionStore";
import { ChangeTracker } from "../diff/changeTracker";
import { diffStat } from "../diff/diffStat";
import { paintedReplay, recordPainted } from "./transcriptLog";
import { StatusBar } from "../ui/statusBar";
import { checkHealth, CliHealth, loginShellEnv } from "../cli/locate";
import { cachedFamilies, familyOf, listModelFamilies, ModelFamily } from "../cli/models";
import { lockOwner, removeLock } from "../cli/sessionLocks";

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
  // While true, session/update notifications are consumed but NOT streamed to the
  // webview (used during a silent wake so the cached transcript is not disturbed).
  silentReplay?: boolean;
  lastActivityAt: number; // for idle auto-exit
  mode?: string;
  model?: string;
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
  // Set when a session arrived on this surface mid turn and its own record of the
  // transcript was incomplete, so the rest is fetched from the CLI once the turn
  // ends and the channel is free.
  needsReplay?: boolean;
  // Everything this session has painted into a transcript, in order, so a chat
  // that moves surface can be rebuilt on the new one. The CLI cannot be asked for
  // it mid turn: `session/load` over a live channel kills the running prompt.
  log: Record<string, unknown>[];
  // False once the oldest entries were dropped, which makes a rebuild partial.
  logFull: boolean;
  // Messages the user submitted while a turn was in flight. The blocks (implicit
  // context + attachments + text) are snapshotted at queue time; the host sends
  // them in order as the session frees up (VS Code's chat queue).
  queued: { id: string; text: string; blocks: ContentBlock[] }[];
  // Webview messages a background turn produced while this session was not the
  // visible one. Replayed when the session is reopened so its progress is shown
  // even for a turn that is still running (capped so it can't grow unbounded).
  bgBuffer: Record<string, unknown>[];
  // MCP servers this agent could not reach, by name. The CLI only says so on its
  // output stream, so without this a broken server is invisible in the panel and
  // an aborted session load can only guess at the reason.
  mcpProblems: Map<string, string>;
  // Subagent bookkeeping. A subagent is announced twice: first as the parent's
  // `run_subagent` tool call (which owns the rendered block) and then under its
  // own agentId, which is what all its later work is tagged with. These map one
  // to the other so the webview only ever sees the block's id.
  subagentSpawns: { id: string; title: string }[];
  subagentIds: Map<string, string>;
}

// Cap on a backgrounded session's replay buffer (oldest dropped past this).
const BG_BUFFER_MAX = 6000;

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
  attachments: { id: string; label: string; type: string; block: ContentBlock }[];
  permissions: [string, { resolve: (res: RequestPermissionResult) => void; rid: string }][];
  elicitations: [string, { resolve: (res: unknown) => void; rid: string }][];
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
  // Half given answers for a request that has moved to another surface.
  saveAnswerDraft(requestId: string, state: unknown, except: ChatController): void;
  // One surface's set of live sessions changed, so every other surface's list,
  // status dots and "running elsewhere" badges are now out of date.
  sessionsChanged(except: ChatController): void;
  // A session was renamed, or the CLI finally reported its name, so any editor
  // tab showing it needs its own title updating.
  titlesChanged(): void;
}

// Image file extensions we attach inline (as base64), matching VS Code chat's
// attachable image types. Anything else is attached as text.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
};

// Match VS Code chat's cap on an attached image (it refuses larger ones).
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

// How much of an attached file's text is sent. A dropped file says so when it is
// cut short, since its bytes are all the agent gets: it has no path to read more.
const MAX_ATTACH_CHARS = 200000;

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
  private idleTimer?: NodeJS.Timeout;

  private health?: CliHealth;
  private resolvedCli = "devin";
  private env?: NodeJS.ProcessEnv;
  private currentMode?: string;
  private currentModel?: string;

  private readonly permissionResolvers = new Map<string, { resolve: (res: RequestPermissionResult) => void; rid: string }>();
  // Shared across surfaces: a request id has to stay unique when a session (and
  // the requests it is waiting on) moves from one surface to another.
  private static permissionSeq = 0;

  private attachments: { id: string; label: string; type: string; block: ContentBlock }[] = [];
  private attachSeq = 0;

  // Whether the active editor file is sent as implicit context (VS Code's
  // current-file behaviour). Mirrored to the composer as a pill.
  private implicitEnabled = true;
  private implicitTimer?: NodeJS.Timeout;
  private changeListSub?: vscode.Disposable;

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
    this.changeListSub = this.changes.onDidChangeList(() => this.postWorkingSet());
    this.implicitEnabled = this.cfg().get<boolean>("implicitContext.enabled", true);
    // Keep the implicit "current file" pill in sync with the active editor and
    // its selection (the latter debounced, since selection changes fire often).
    // Stored per controller so an editor/window surface cleans them up on close.
    this.ownDisposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postImplicitContext()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.scheduleImplicitPost();
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
  // Whether a chat has been painted into the current page. The readiness chain
  // restores the last chat only when nothing has, so a session handed to this
  // surface is not immediately reloaded on top of itself.
  private painted = false;
  private readyWaiters: (() => void)[] = [];
  whenReady(): Promise<void> {
    if (this.webviewReady) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.readyWaiters.push(resolve));
  }

  markClosed(): void {
    this.webviewGone = true;
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

  // Kill every live ACP process (and its terminals) so a window reload or
  // extension deactivate does not leave stranded `devin acp` agents (and their
  // MCP servers). This is item 6: stop all sessions on exit.
  //
  // Synchronous, so the escalation to SIGKILL is left on a timer. Prefer
  // `shutdown()` when the extension host itself is going away, since that timer
  // will not fire once it has exited.
  dispose(): void {
    this.stopLocalState();
    for (const rt of this.runtimes.values()) {
      this.destroyRuntime(rt);
    }
    this.runtimes.clear();
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
    const live = [...this.runtimes.values()];
    const interrupted = live.filter((rt) => rt.id && (rt.busy || rt.awaiting > 0)).map((rt) => rt.id);
    this.stopLocalState();
    this.runtimes.clear();
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
    for (const [, e] of this.takeoverResolvers) {
      e.resolve("cancel");
    }
    this.takeoverResolvers.clear();
    this.loading.clear();
    this.changeListSub?.dispose();
    this.changeListSub = undefined;
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

  // The chat is being opened on another surface and has no live agent to hand
  // over, so this surface simply stops showing it.
  releaseSession(id: string): void {
    if (this.activeId !== id) {
      return;
    }
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
    if (!rt) {
      return undefined;
    }
    this.runtimes.delete(id);
    this.starting.delete(id);
    // Drop this controller's listeners: the new one attaches its own.
    rt.client.removeAllListeners();
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
    // The composer's staged files belong to whichever chat is on screen, so they
    // only travel when that is the chat being handed over.
    const visible = this.activeId === id;
    const transfer: RuntimeTransfer = {
      rt,
      attachments: visible ? this.attachments : [],
      permissions: take(this.permissionResolvers),
      elicitations: take(this.elicitationResolvers),
      from: this.kind === "view" ? "the side panel" : "an editor tab"
    };
    if (visible) {
      this.attachments = [];
    }
    // A lock takeover question belongs to a load this surface is abandoning, and
    // its widget goes with the transcript, so settle it rather than leave the load
    // waiting on an answer that can never arrive.
    for (const [rid, entry] of [...this.takeoverResolvers]) {
      if (entry.rid === id) {
        this.takeoverResolvers.delete(rid);
        entry.resolve("cancel");
      }
    }
    if (visible) {
      // This surface has nothing to show any more, so it goes back to its list.
      // An editor tab has no list: it is one chat, and the manager closes it.
      this.activeId = undefined;
      if (this.kind === "view") {
        this.store.setViewing(undefined);
        this.post({ type: "busy", value: false });
        this.post({ type: "body", body: "list" });
      }
    }
    this.broadcastStatuses();
    void this.refreshSessions();
    return transfer;
  }

  // Take a live session over: adopt its process and outstanding requests, then
  // show it. An idle session repaints its transcript from the agent it already
  // has (about a second, no new process); one mid turn cannot be reloaded over
  // its live channel, so it picks up from here and says so.
  async importRuntime(transfer: RuntimeTransfer): Promise<void> {
    const rt = transfer.rt;
    this.runtimes.set(rt.id, rt);
    rt.client.setHost(this);
    rt.client.on("log", (line: string) => this.log(line));
    rt.client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n));
    rt.client.on("output", (o: CliOutput) => this.onCliOutput(rt, o));
    rt.client.on("stopped", (s: AgentStopped) => this.onAgentStopped(rt, s));
    rt.client.on("exit", () => this.onRuntimeExit(rt));
    rt.terminals.retarget(
      (terminalId, output, exitStatus) => {
        if (this.activeId === rt.id) {
          this.post({ type: "terminalOutput", terminalId, output, exitStatus });
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
    this.activeId = rt.id;
    this.store.add(rt.id, rt.cwd);
    this.markVisible(rt.id);
    this.ensureIdleTimer();
    // The agent can die during the handover, when its exit has no listener and is
    // never emitted again, so the arriving surface has to ask.
    if (rt.client.hasExited()) {
      this.onRuntimeExit(rt);
      return;
    }
    // A turn that was already running is finished by this surface from now on.
    if (rt.busy && rt.turn) {
      this.adoptTurn(rt, rt.turn);
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
    } else {
      await this.doLoadSession(rt.id);
      this.log(`[move] ${rt.id} arrived from ${transfer.from} idle: reloaded from the agent`);
    }
    if (transfer.attachments.length) {
      this.attachments = transfer.attachments;
      this.postAttachments();
    }
    // A brand new surface announces its own readiness while this is running, so
    // say once more where it should be: showing the chat, not its session list.
    this.post({ type: "body", body: "thread" });
    this.focus();
  }

  // --- Runtime pool --------------------------------------------------------

  private active(): Runtime | undefined {
    return this.activeId ? this.runtimes.get(this.activeId) : undefined;
  }

  private destroyRuntime(rt: Runtime): void {
    try {
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

  // Spawn a fresh `devin acp` process and wire its events. The runtime is not
  // yet in the pool: its session id is unknown until session/new or /load.
  private spawnRuntime(cwd: string): Runtime {
    const client = new AcpClient({
      cliPath: this.resolvedCli || "devin",
      cwd,
      env: this.clientEnv(),
      extraArgs: this.extraArgs()
    });
    let ref: Runtime | undefined;
    const terminals = new TerminalManager(
      this.clientEnv(),
      cwd,
      (terminalId, output, exitStatus) => {
        // Only the visible session streams terminal output to the webview.
        if (ref && this.activeId === ref.id) {
          this.post({ type: "terminalOutput", terminalId, output, exitStatus });
        }
      },
      (line) => this.log(line)
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
      lastActivityAt: Date.now(),
      pending: [],
      queued: [],
      bgBuffer: [],
      log: [],
      logFull: true,
      mcpProblems: new Map(),
      subagentSpawns: [],
      subagentIds: new Map()
    };
    ref = rt;
    client.setHost(this);
    client.on("log", (line: string) => this.log(line));
    client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n));
    client.on("output", (o: CliOutput) => this.onCliOutput(rt, o));
    client.on("stopped", (s: AgentStopped) => this.onAgentStopped(rt, s));
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

  private postMcpProblems(rt: Runtime): void {
    if (this.activeId !== rt.id || !rt.mcpProblems.size) {
      return;
    }
    this.post({
      type: "mcpProblems",
      servers: [...rt.mcpProblems].map(([name, message]) => ({ name, message }))
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
    if (rt.id) {
      // Settle any prompt the agent was still waiting on so its client-side
      // call does not hang and no dead widget is left on screen.
      this.settleRequestsFor(rt.id);
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

  private runtimeBySessionId(sessionId?: string): Runtime | undefined {
    if (sessionId && this.runtimes.has(sessionId)) {
      return this.runtimes.get(sessionId);
    }
    // Fall back to the active runtime (e.g. a request that arrives before the
    // session id is stamped, or a client that only serves one session).
    return this.active();
  }

  // --- Status dots ---------------------------------------------------------

  // What this surface is running, and which of them it is showing. Every other
  // surface lists these too (grayed, badged as running elsewhere), so a change
  // here has to reach them: without it a chat started in a tab is missing from
  // the side panel's list until it is refreshed by hand.
  private ownership = "";

  private broadcastStatuses(): void {
    this.post({ type: "sessionStatuses", statuses: this.statusMap(), activeId: this.activeId, elsewhere: this.elsewhere() });
    const owned = `${[...this.runtimes.keys()].sort().join(",")}|${this.activeId || ""}`;
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
    if (!minutes || minutes <= 0) {
      return; // 0 disables auto-exit
    }
    const maxIdleMs = minutes * 60000;
    const now = Date.now();
    let changed = false;
    for (const rt of [...this.runtimes.values()]) {
      const idle = !rt.busy && rt.awaiting === 0;
      if (idle && now - rt.lastActivityAt > maxIdleMs) {
        this.log(`[idle-exit] session ${rt.id} exceeded ${minutes}m idle; exiting`);
        this.settleRequestsFor(rt.id);
        this.destroyRuntime(rt);
        this.runtimes.delete(rt.id);
        this.starting.delete(rt.id);
        if (this.activeId === rt.id) {
          // The visible session died; it stays on screen as history and will be
          // re-woken on the next send.
          this.setBusy(false);
        }
        changed = true;
      }
    }
    if (changed) {
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
          await this.handleSend(String(msg.text || ""), !!msg.newSession);
          return;
        case "stopAndSend":
          this.stopAndSend(String(msg.text || ""));
          return;
        case "removeQueued":
          this.removeQueued(String(msg.id || ""));
          return;
        case "editQueued":
          this.editQueued(String(msg.id || ""), String(msg.text || ""));
          return;
        case "sendQueuedNow":
          this.sendQueuedNow(String(msg.id || ""));
          return;
        case "queueEditing": {
          // Which queued message (if any) the composer is editing. Changing it can
          // unblock a flush a completed turn deferred, so re-run the drain.
          this.queueEditingId = msg.id ? String(msg.id) : undefined;
          const rt = this.active();
          if (rt) {
            this.flushQueue(rt);
          }
          return;
        }
        case "cancel":
          this.cancel();
          return;
        case "webviewError":
          this.log(`[webview-error] in "${msg.where}": ${msg.message}`);
          return;
        case "revertPreview":
          await this.handleRevertPreview(Number(msg.head), msg.token);
          return;
        case "revertExecute":
          await this.handleRevertExecute(Number(msg.head), msg.resendText, !!msg.newSession);
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
        case "listVisible":
          this.listVisible = msg.value === true;
          return;
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
        case "terminateSession":
          await this.terminateSession(String(msg.id || ""), msg.title, !!msg.returnToList);
          return;
        case "takeoverDecision":
          this.resolveTakeover(String(msg.requestId || ""), String(msg.decision || "cancel"));
          return;
        case "setMode":
          await this.setMode(String(msg.mode || "accept-edits"));
          return;
        case "setModel":
          await this.setModel(String(msg.model || ""));
          return;
        case "permission":
          this.resolvePermission(String(msg.requestId), msg.optionId);
          return;
        case "subagentMode":
          await this.setSubagentMode(String(msg.id || ""), msg.background === true);
          return;
        case "openDiff":
          await this.changes.openDiff(String(msg.path || ""));
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
        case "acceptAll":
          this.changes.acceptAll();
          return;
        case "rejectAll":
          await this.changes.rejectAll();
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
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      w();
    }
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
    await this.pushReadiness();
    if (!this.isReady() || this.activeId) {
      return;
    }
    // A freshly opened editor/window surface starts a new session immediately
    // instead of landing on the session list, and one restored after a reload
    // reopens the chat it was holding.
    if (this.autoNewSession) {
      this.autoNewSession = false;
      this.post({ type: "body", body: "thread" });
      await this.newSession();
    } else if (this.openOnReady) {
      const id = this.openOnReady;
      this.openOnReady = undefined;
      await this.openSession(id);
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
      await this.refreshSessions();
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
      if (this.kind === "view" && !this.autoNewSession && resume && last && !heldElsewhere && !this.painted) {
        this.post({ type: "body", body: "thread" });
        await this.loadSession(last);
      }
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

  private cwd(): string {
    return this.folders()[0] || process.env.HOME || process.cwd();
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
    const setting = this.cfg().get<string>("cliPath", "devin") || "devin";
    this.health = await checkHealth(setting);
    this.resolvedCli = this.health.path || "devin";
    this.env = await loginShellEnv();
    this.log(
      `[health] path=${this.health.path} found=${this.health.found} loggedIn=${this.health.loggedIn} version=${this.health.version || ""} ${this.health.error || ""}`
    );
    this.statusBar?.setInfo({ version: this.health.version, account: this.health.account });
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
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
    const extra = this.cfg().get<Record<string, string>>("env", {}) || {};
    return { ...(this.env || process.env), ...extra };
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
  private async createSession(): Promise<Runtime> {
    if (this.startingNew) {
      return this.startingNew;
    }
    this.startingNew = (async () => {
      const cwd = this.resolveNewSessionCwd();
      const rt = this.spawnRuntime(cwd);
      try {
        await this.ensureInitialized(rt);
        const res = await rt.client.newSession(cwd, this.additionalDirs(cwd));
        rt.id = res.sessionId;
        rt.lastActivityAt = Date.now();
        this.runtimes.set(rt.id, rt);
        this.activeId = rt.id;
        this.currentMode = undefined;
        this.currentModel = undefined;
        this.store.add(rt.id, cwd);
        this.markVisible(rt.id);
        this.painted = true;
        this.postCapabilities();
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
        await this.applyDefaults(rt, res);
        // Whatever was in the "new chat" box has been carried into this session,
        // so it is no longer waiting in the list: the text, and the files staged
        // with it, belong to this chat now.
        this.store.setDraft(undefined, "");
        await this.dropStaged(undefined);
        this.postAttachments();
        this.post({ type: "sessionReady", sessionId: rt.id });
        this.ensureIdleTimer();
        this.broadcastStatuses();
        void this.refreshSessions();
        return rt;
      } catch (err) {
        this.destroyRuntime(rt);
        if (rt.id) {
          this.runtimes.delete(rt.id);
        }
        throw err;
      }
    })();
    try {
      return await this.startingNew;
    } finally {
      this.startingNew = undefined;
    }
  }

  // Load a session into `rt`, taking over a lock when needed (item 5): a stale
  // lock (dead owner) is reclaimed automatically; a lock held by a live process
  // prompts the user, and force take-over removes it and loads anyway.
  private async loadWithTakeover(rt: Runtime, id: string, cwd: string): Promise<NewSessionResult | undefined> {
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
  private readonly takeoverResolvers = new Map<string, { resolve: (d: "takeover" | "cancel") => void; rid: string }>();
  private takeoverSeq = 0;
  private askTakeover(id: string, pid?: number): Promise<"takeover" | "cancel"> {
    const requestId = `lock-${++this.takeoverSeq}`;
    this.post({ type: "lockConflict", requestId, id, pid });
    return new Promise((resolve) => this.takeoverResolvers.set(requestId, { resolve, rid: id }));
  }
  private resolveTakeover(requestId: string, decision: string): void {
    const entry = this.takeoverResolvers.get(requestId);
    if (!entry) {
      return;
    }
    this.takeoverResolvers.delete(requestId);
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
    this.activeId = undefined;
    if (this.kind === "view") {
      this.store.setViewing(undefined);
    }
    // The composer is a "new chat" box again, so it gets that box's own draft and
    // staged files back, rather than being emptied.
    void this.useAttachmentsOf(undefined);
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
      void this.refreshSessions();
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
    if (!(await this.ensureReady())) {
      return;
    }
    // The previous session (if any) is left alive in the background and keeps its
    // own edits tracked; the clear below starts this chat with an empty one. What
    // was staged in the "new chat" box comes with it: that is what it was for.
    this.activeId = undefined;
    await this.useAttachmentsOf(undefined);
    this.focus();
    this.post({ type: "body", body: "thread" });
    // `reset` tells the webview this is a fresh session so it clears the title
    // (and code badge) instead of keeping the previous session's.
    this.post({ type: "clear", reset: true });
    try {
      await this.createSession();
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
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
    if (!id || !(await this.ensureReady())) {
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
      return inflight;
    }
    const p = this.doLoadSession(id);
    this.loading.set(id, p);
    try {
      await p;
    } finally {
      this.loading.delete(id);
    }
  }

  private async doLoadSession(id: string): Promise<void> {
    const already = this.runtimes.get(id);
    // Never reload a session whose turn is in flight: issuing a loadSession over
    // its live channel aborts the running prompt ("channel closed"). Re-attach
    // to the running runtime instead (it keeps streaming).
    if (already && already.busy) {
      await this.activateSession(id);
      return;
    }
    this.activeId = id;
    // A full reload rebuilds the whole transcript, so any buffered background
    // stream for this runtime is superseded, as is any replay it was owed.
    if (already) {
      already.bgBuffer = [];
      already.needsReplay = false;
      // The transcript is about to be rebuilt from the agent, so the record of
      // what is painted starts again with it.
      already.log = [];
      already.logFull = true;
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
    await this.useAttachmentsOf(id);
    if (!already) {
      this.starting.add(id);
    }
    this.broadcastStatuses();

    const cwd = this.store.cwds()[id] || this.resolveNewSessionCwd();
    const rt = already ?? this.spawnRuntime(cwd);
    if (!already) {
      rt.id = id;
      this.runtimes.set(id, rt);
    }
    rt.replaying = true;
    let loadFailed = "";
    try {
      if (!already) {
        await this.ensureInitialized(rt);
      }
      this.postCapabilities();
      const res = await this.loadWithTakeover(rt, id, cwd);
      rt.lastActivityAt = Date.now();
      this.store.add(id, cwd);
      this.markVisible(id);
      if (res && (res.configOptions || res.modes)) {
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      this.post({ type: "assistantEnd" });
      this.post({ type: "sessionReady", sessionId: id });
      this.ensureIdleTimer();
    } catch (err) {
      // Waking failed: drop the half-spawned runtime so the row goes gray again,
      // and stop pointing `activeId` at a runtime that no longer exists.
      if (!already) {
        this.destroyRuntime(rt);
        this.runtimes.delete(id);
        if (this.activeId === id) {
          this.activeId = undefined;
        }
      }
      loadFailed = err instanceof Error ? err.message : String(err);
    } finally {
      rt.replaying = false;
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
        await this.closeOutSession(OPEN_FAILED);
        this.reportLoadFailure(loadFailed, rt);
      } else {
        this.post({ type: "loaded" });
        this.reportInterrupted(id);
        // The head read right after a reload is NOT a reliable revert target: the
        // next prompt re-expands the conversation and orphans it.
        await this.postTurnHead(false);
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
          this.postQueued(opened);
          this.postMcpProblems(opened);
        }
        // Anything typed while it was opening has been waiting for the channel.
        if (opened) {
          this.flushQueue(opened);
        }
        void this.refreshSessions();
      }
    }
  }

  // Re-show an already-alive session WITHOUT reloading its history: the webview
  // has kept its rendered transcript and restores it locally, so we only need to
  // re-point the active session and refresh the composer chrome. Falls back to a
  // full wake/load if the runtime is not alive. Item: switch without reload.
  private async activateSession(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      await this.loadSession(id);
      return;
    }
    this.activeId = id;
    this.markVisible(id);
    this.postWorkingSet();
    // The composer belongs to this chat now, so it shows this chat's own unsent
    // text and staged files, not the ones from wherever we just were.
    await this.useAttachmentsOf(id);
    this.postDraft();
    this.currentMode = rt.mode;
    this.currentModel = rt.model;
    this.postCapabilities();
    this.postModelOptions(rt.model || "adaptive");
    if (rt.mode) {
      this.post({ type: "mode", mode: rt.mode });
    }
    if (rt.model) {
      this.post({ type: "model", model: rt.model });
    }
    this.post({ type: "busy", value: rt.busy });
    // Name the session: a surface handed a chat never called into `switchToSession`,
    // so without this its header, terminate and move controls have no session.
    this.painted = true;
    this.post({ type: "sessionReady", sessionId: id, title: this.store.titles()[id] });
    // Replay anything the turn streamed while this session was in the background
    // (including a turn still running), so the restored transcript catches up
    // instead of showing the stale state from when the user left.
    this.flushBgBuffer(rt);
    this.broadcastStatuses();
    // An instant restore does not reload, so the current head stays valid. Skip
    // the head read while a turn is in flight so it never contends with the
    // running prompt on the channel; the next completion refreshes it.
    if (!rt.busy) {
      await this.postTurnHead(true);
    }
    // Re-surface any prompts this session raised while backgrounded.
    for (const p of rt.pending) {
      this.post(p.payload);
    }
    // Restore the composer's queued-message rows for this session.
    this.postQueued(rt);
    void this.refreshSessions();
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
    void this.refreshSessions();
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
  private async wakeSession(id: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    if (this.openedElsewhere(id)) {
      return;
    }
    if (this.runtimes.has(id)) {
      await this.activateSession(id);
      return;
    }
    const inflight = this.loading.get(id);
    if (inflight) {
      // A load/wake for this session is already spawning an acp; share it.
      this.activeId = id;
      return inflight;
    }
    const p = this.doWakeSession(id);
    this.loading.set(id, p);
    try {
      await p;
    } finally {
      this.loading.delete(id);
    }
  }

  private async doWakeSession(id: string): Promise<void> {
    this.activeId = id;
    this.postWorkingSet();
    this.postDraft();
    await this.useAttachmentsOf(id);
    const cwd = this.store.cwds()[id] || this.resolveNewSessionCwd();
    const rt = this.spawnRuntime(cwd);
    rt.id = id;
    this.runtimes.set(id, rt);
    rt.replaying = true;
    rt.silentReplay = true;
    this.starting.add(id);
    this.broadcastStatuses();
    let done: () => void = () => {};
    let wakeFailed = "";
    rt.waking = new Promise<void>((resolve) => { done = resolve; });
    try {
      await this.ensureInitialized(rt);
      const res = await this.loadWithTakeover(rt, id, cwd);
      rt.lastActivityAt = Date.now();
      this.store.add(id, cwd);
      this.markVisible(id);
      if (res && (res.configOptions || res.modes)) {
        this.publishOptions(rt, res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      this.postCapabilities();
      if (this.activeId === id) {
        this.post({ type: "sessionReady", sessionId: id });
        this.reportInterrupted(id);
      }
      this.ensureIdleTimer();
    } catch (err) {
      if (this.runtimes.get(id) === rt) {
        this.destroyRuntime(rt);
        this.runtimes.delete(id);
        if (this.activeId === id) {
          this.activeId = undefined;
        }
      }
      wakeFailed = err instanceof Error ? err.message : String(err);
    } finally {
      rt.replaying = false;
      rt.silentReplay = false;
      rt.waking = undefined;
      this.starting.delete(id);
      this.broadcastStatuses();
      if (wakeFailed) {
        // The agent could not reload this session: return to the list rather
        // than leaving a stale, non-interactive transcript on screen.
        await this.closeOutSession(OPEN_FAILED);
        this.reportLoadFailure(wakeFailed, rt);
      } else if (this.activeId === id) {
        await this.postTurnHead(false);
      }
      done();
    }
  }

  private sessionsCache?: { at: number; sessions: DevinSession[] };

  // `force` bypasses the short TTL cache (used for explicit refresh/rename/delete);
  // implicit refreshes after a load/prompt reuse the cache to avoid respawning
  // `devin list` repeatedly.
  // `staleOk` serves the cache at any age (used when returning to the list, so it
  // paints instantly) and is paired with a background revalidate.
  async refreshSessions(force = false, staleOk = false): Promise<void> {
    if (!this.isReady()) {
      return;
    }
    const folders = this.folders();
    let sessions: DevinSession[] = [];
    if (!force && this.sessionsCache && (staleOk || Date.now() - this.sessionsCache.at < 4000)) {
      sessions = this.sessionsCache.sessions;
    } else {
      this.post({ type: "sessionsLoading" });
      // Never let a slow/failed `devin list` leave the list stuck on its
      // spinner: cap the wait and fall back to the cache (or empty).
      try {
        const listing = listSessions({
          cliPath: this.resolvedCli || "devin",
          env: this.env,
          folders,
          trackedIds: this.store.ids(),
          cwdById: this.store.cwds()
        });
        const timeout = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("devin list timed out")), 20000);
          t.unref?.();
        });
        const { sessions: live, prunedIds } = await Promise.race([listing, timeout]);
        // Drop tracked ids Devin no longer knows about so stale rows self-heal,
        // but NEVER prune a session we still hold a live runtime for (or are
        // starting): a freshly created session is not in `devin list` until its
        // first turn persists, and pruning it here would make it vanish.
        for (const id of prunedIds) {
          const held = this.runtimes.has(id) || this.starting.has(id) || !!this.surfaces?.owner(id);
          if (!held) {
            this.store.remove(id);
          }
        }
        sessions = live;
        this.sessionsCache = { at: Date.now(), sessions };
      } catch (err) {
        this.log(`[list-failed] ${err instanceof Error ? err.message : String(err)}`);
        sessions = this.sessionsCache?.sessions ?? [];
      }
    }
    // List every live session even when `devin list` has not caught up yet (a
    // brand-new session appears there only after its first turn persists), so a
    // chat started from the list shows up immediately. Sessions running on
    // another surface count: a chat started in an editor tab belongs in this list
    // too, badged as running elsewhere.
    const known = new Set(sessions.map((s) => s.id));
    const cwds = this.store.cwds();
    const titles = this.store.titles();
    const liveIds = new Set<string>([...this.starting, ...this.runtimes.keys(), ...this.elsewhere()]);
    const synthesized: DevinSession[] = [];
    for (const id of liveIds) {
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
      sessions = [...synthesized, ...sessions];
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
      statuses: this.statusMap(),
      // Rows another surface is running, so they can say so before being clicked.
      elsewhere: this.elsewhere(),
      folders: folders.map((f) => ({ path: f, name: path.basename(f) }))
    });
  }

  private elsewhere(): string[] {
    return this.surfaces?.elsewhere(this) || [];
  }

  // Another surface started, moved or stopped a chat: re-list, so this surface's
  // rows, dots and "running elsewhere" badges say what is actually true.
  surfacesChanged(): void {
    this.post({ type: "sessionStatuses", statuses: this.statusMap(), activeId: this.activeId, elsewhere: this.elsewhere() });
    void this.refreshSessions();
  }

  // Whether a session list is on screen here (the full list, the docked panel, or
  // the switcher) and this surface is actually showing. Only then is it worth
  // re-listing on every change to the CLI's store: a list nobody can see is re-read
  // when it comes back, and every listing runs `devin list`.
  private listVisible = false;
  private surfaceVisible = true;

  setSurfaceVisible(visible: boolean): void {
    this.surfaceVisible = visible;
  }

  relistIfWatched(): void {
    if (this.listVisible && this.surfaceVisible) {
      void this.refreshSessions(true);
    }
  }

  private statusMap(): Record<string, SessionStatus> {
    const statuses: Record<string, SessionStatus> = {};
    for (const id of this.starting) {
      statuses[id] = "starting";
    }
    for (const [id, rt] of this.runtimes) {
      if (rt.awaiting > 0 && id !== this.activeId) {
        statuses[id] = "attention";
      } else {
        statuses[id] = rt.busy && rt.awaiting === 0 ? "running" : "idle";
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
    if (this.activeId === id) {
      this.post({ type: "sessionReady", sessionId: id, title });
    }
    this.surfaces?.titlesChanged();
    this.surfaces?.sessionsChanged(this);
    await this.refreshSessions(true);
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
    if (this.activeId === id) {
      this.activeId = undefined;
      this.post({ type: "clear" });
    }
    this.broadcastStatuses();
    await this.refreshSessions(true);
  }

  // --- Mode + model --------------------------------------------------------

  // `rt` is the session the options came from: its mode and model are recorded
  // on it so switching back to the session later restores the pickers to what
  // that session is actually set to, rather than the last session's or a default.
  private publishOptions(rt: Runtime | undefined, options: ConfigOption[] | undefined, currentModeId?: string): void {
    const byId = new Map((options || []).map((o) => [o.id, o]));
    const modeOpt = byId.get("mode");
    const modelOpt = byId.get("model");
    this.currentMode = modeOpt?.currentValue || currentModeId || this.currentMode;
    this.currentModel = modelOpt?.currentValue || this.currentModel;
    if (rt) {
      rt.mode = modeOpt?.currentValue || currentModeId || rt.mode;
      rt.model = modelOpt?.currentValue || rt.model;
    }
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.postModelOptions(this.currentModel || "adaptive");
  }

  // Posts the mode + model-family options. Model families come from
  // `devin models list` (cached); if not fetched yet, fetch and re-post.
  private postModelOptions(currentModel: string): void {
    const families = cachedFamilies();
    const payload = {
      type: "options",
      modes: ChatController.STATIC_MODES,
      currentMode: this.currentMode || "accept-edits",
      models: families,
      currentModel
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
          const late = { ...payload, models: f, currentMode: this.currentMode || payload.currentMode };
          this.post(late);
          this.store.cacheOptions(late);
        }
      });
    }
  }

  // Devin's session modes are fixed, so we can always show them even before a
  // session exists. (The model list only comes from a session, so it can only
  // be a cached list or a "default" placeholder until one is created.)
  private static readonly STATIC_MODES = [
    { value: "accept-edits", name: "Accept Edits", icon: "codicon-code" },
    { value: "ask", name: "Ask", icon: "codicon-comment-discussion" },
    { value: "plan", name: "Plan", icon: "codicon-checklist" },
    { value: "bypass", name: "Bypass", icon: "codicon-unlock" }
  ];

  // Populate the dropdowns before any session exists so they are never empty.
  // Modes are fixed; models come from `devin models list` (no session needed,
  // and the uids match what the ACP model option accepts).
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
    const mode = live?.mode || this.currentMode || this.cfg().get<string>("defaultMode", "accept-edits");
    const model = live?.model || this.currentModel || this.cfg().get<string>("defaultModel", "");
    const payload = {
      type: "options",
      modes: ChatController.STATIC_MODES,
      currentMode: mode || "accept-edits",
      models: families,
      currentModel: model || "adaptive"
    };
    this.store.cacheOptions(payload);
    this.post(payload);
  }

  private async applyDefaults(rt: Runtime, res: NewSessionResult): Promise<void> {
    const mode = this.cfg().get<string>("defaultMode", "accept-edits");
    const model = this.cfg().get<string>("defaultModel", "");
    const currentMode = res.modes?.currentModeId;
    // Record the session's own mode first. The `current_mode_update` that
    // announces it arrives before session/new returns, so the runtime is not in
    // the pool yet to receive it, and a session that already starts in the
    // configured mode would otherwise have no mode recorded at all.
    rt.mode = currentMode || rt.mode;
    this.currentMode = rt.mode || this.currentMode;
    try {
      if (mode && mode !== currentMode) {
        await rt.client.setConfigOption(rt.id, "mode", mode);
        rt.mode = mode;
        this.currentMode = mode;
      }
      // Only re-apply a remembered model if it's still an available model
      // (when we know the list); otherwise keep the session's own default.
      const modelKnown = cachedFamilies().length === 0 || !!familyOf(model);
      if (model && modelKnown) {
        await rt.client.setConfigOption(rt.id, "model", model);
        rt.model = model;
        this.currentModel = model;
      }
      this.statusBar?.set({ connected: true, mode: this.currentMode, model: this.currentModel });
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
        await rt.client.setConfigOption(rt.id, "mode", mode);
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

  private async setModel(model: string): Promise<void> {
    this.currentModel = model;
    const rt = this.active();
    if (rt) {
      rt.model = model;
      try {
        await rt.client.setConfigOption(rt.id, "model", model);
      } catch (err) {
        this.log(`[set-model-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await this.cfg().update("defaultModel", model, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      this.log(`[set-model-persist-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({ type: "model", model });
  }

  // --- Context attachments -------------------------------------------------

  private postAttachments(save = true): void {
    this.post({
      type: "attachments",
      items: this.attachments.map((a) => {
        const item: { id: string; label: string; type: string; thumb?: string } = { id: a.id, label: a.label, type: a.type };
        const b = a.block as { type?: string; mimeType?: string; data?: string };
        if (a.type === "image" && b && b.type === "image" && b.data) {
          item.thumb = `data:${b.mimeType || "image/png"};base64,${b.data}`;
        }
        return item;
      })
    });
    if (save) {
      void this.saveAttachments();
    }
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

  private attachmentsFile(id?: string): vscode.Uri | undefined {
    const root = this.context.storageUri || this.context.globalStorageUri;
    const key = (id || ChatController.NEW_CHAT_ATTACHMENTS).replace(/[^A-Za-z0-9._-]/g, "_");
    return root ? vscode.Uri.joinPath(root, "attachments", `${key}.json`) : undefined;
  }

  private async saveAttachments(): Promise<void> {
    const file = this.attachmentsFile(this.activeId);
    if (!file) {
      return;
    }
    try {
      if (!this.attachments.length) {
        await vscode.workspace.fs.delete(file);
        return;
      }
      const body = Buffer.from(JSON.stringify(this.attachments), "utf8");
      if (body.byteLength > ChatController.MAX_ATTACHMENT_BYTES) {
        this.log(`[attachments] ${body.byteLength} bytes staged, too much to keep past this window`);
        return;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, ".."));
      await vscode.workspace.fs.writeFile(file, body);
    } catch {
      // Nothing staged to delete, or the storage is not writable: the composer is
      // still correct, it just will not survive a reload.
    }
  }

  // Forget what was staged for a chat (or for the "new chat" box) without touching
  // what the composer is holding now.
  private async dropStaged(id?: string): Promise<void> {
    const file = this.attachmentsFile(id);
    if (file) {
      await vscode.workspace.fs.delete(file).then(undefined, () => {});
    }
  }

  // Show the composer whatever is staged for a chat, including anything left from
  // before the window was reloaded.
  private async useAttachmentsOf(id?: string): Promise<void> {
    const file = this.attachmentsFile(id);
    this.attachments = [];
    if (file) {
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.attachments = parsed.filter((a) => a && a.id && a.block);
        }
      } catch {
        // Nothing staged for this chat.
      }
    }
    this.postAttachments(false);
  }

  private removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    this.postAttachments();
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
    if (!path.isAbsolute(fsPath)) {
      fsPath = path.join(this.active()?.cwd || this.cwd(), fsPath);
    }
    const uri = vscode.Uri.file(fsPath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = {};
      if (typeof line === "number" && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      // Not openable as text (an image, a PDF, a binary): let VS Code pick the
      // editor for it rather than refusing to open a file the user clicked.
      try {
        await vscode.commands.executeCommand("vscode.open", uri);
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

  private async addFile(fsPath: string): Promise<void> {
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
        const buf = await fs.promises.readFile(fsPath);
        this.attachments.push({
          id: `att-${++this.attachSeq}`,
          label: path.basename(fsPath),
          type: "image",
          block: { type: "image", mimeType: imageMime, data: buf.toString("base64") }
        });
        this.postAttachments();
        return;
      }
      const raw = await fs.promises.readFile(fsPath, "utf8");
      const text = raw.length > MAX_ATTACH_CHARS ? raw.slice(0, MAX_ATTACH_CHARS) : raw;
      this.attachments.push({
        id: `att-${++this.attachSeq}`,
        label: path.basename(fsPath),
        type: "file",
        block: {
          type: "resource",
          resource: { uri: vscode.Uri.file(fsPath).toString(), text }
        }
      });
      this.postAttachments();
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
    this.attachments.push({
      id: `att-${++this.attachSeq}`,
      label,
      type: "directory",
      block: { type: "text", text: `Folder ${dirPath} contains:\n\n${lines.join("\n")}` }
    });
    this.postAttachments();
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
    this.attachments.push({
      id: `att-${++this.attachSeq}`,
      label,
      type: "directory",
      block: { type: "text", text }
    });
    this.postAttachments();
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
    this.attachments.push({
      id: `att-${++this.attachSeq}`,
      label,
      type: "file",
      block: { type: "text", text: blockText }
    });
    this.postAttachments();
  }

  private async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const hasSel = sel && !sel.isEmpty;
    const body = hasSel ? doc.getText(sel) : doc.getText();
    if (!body.trim()) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(doc.uri);
    const label = hasSel
      ? `${path.basename(doc.uri.fsPath)}:${sel.start.line + 1}-${sel.end.line + 1}`
      : path.basename(doc.uri.fsPath);
    const text = `From ${rel}${hasSel ? ` lines ${sel.start.line + 1}-${sel.end.line + 1}` : ""}:\n\n\`\`\`${doc.languageId}\n${body.slice(0, MAX_ATTACH_CHARS)}\n\`\`\``;
    this.attachments.push({
      id: `att-${++this.attachSeq}`,
      label,
      type: "selection",
      block: { type: "text", text }
    });
    this.postAttachments();
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
    const scored = this.fileCache.uris
      .map((u) => ({ u, rel: vscode.workspace.asRelativePath(u) }))
      .filter((x) => !q || x.rel.toLowerCase().includes(q))
      .slice(0, 20)
      .map((x) => ({ path: x.u.fsPath, label: path.basename(x.u.fsPath), detail: x.rel }));
    this.post({ type: "fileSuggestions", query, items: scored });
  }

  private attachImage(name: unknown, mime: unknown, data: unknown): void {
    if (typeof data !== "string" || typeof mime !== "string") {
      return;
    }
    this.attachments.push({
      id: `att-${++this.attachSeq}`,
      label: typeof name === "string" && name ? name : "image",
      type: "image",
      block: { type: "image", mimeType: mime, data }
    });
    this.postAttachments();
  }

  // --- Prompting -----------------------------------------------------------

  private async handleSend(text: string, startNew = false): Promise<void> {
    if (!text.trim()) {
      return;
    }
    // The text has left the composer, so it is no longer a draft.
    this.store.setDraft(startNew ? undefined : this.activeId, "");
    if (!(await this.ensureReady())) {
      return;
    }
    // If the visible session is still coming back to life (a silent background
    // wake), wait for it so the prompt lands on a ready runtime.
    if (!startNew && this.activeId) {
      const waking = this.runtimes.get(this.activeId)?.waking;
      if (waking) {
        await waking;
      }
      // A session still opening has its channel busy replaying its history, and a
      // prompt sent into that is swallowed. Queue it: the load drains the queue
      // when it finishes, and it shows as pending in the meantime instead of
      // seeming to vanish.
      const rt = this.runtimes.get(this.activeId);
      if (rt && (rt.replaying || this.loading.has(this.activeId))) {
        this.enqueueMessage(rt, text);
        return;
      }
    }
    // Starting a fresh chat leaves the previous session alive in the background.
    // Whatever is staged in the composer was staged for THIS message, so it goes
    // with it: clearing here dropped a screenshot attached in the sessions list.
    if (startNew) {
      this.activeId = undefined;
      // `pendingSend` tells the webview not to show the welcome screen on this
      // clear, and we render the user's message right away, so a new chat
      // started from the list never flashes the welcome while the ACP session
      // spins up.
      this.post({ type: "clear", pendingSend: true });
      this.post({ type: "userMessage", text });
    }

    let rt = startNew ? undefined : this.active();
    // One turn at a time within a session: a message sent while the visible
    // session is mid-turn is queued (and shown as a pending row) rather than
    // dropped, then auto-sent when the turn finishes.
    if (rt && rt.busy) {
      this.enqueueMessage(rt, text);
      return;
    }
    if (!rt) {
      try {
        if (!startNew && this.activeId && !this.runtimes.has(this.activeId)) {
          // The visible session was idle-exited: wake it, then send.
          await this.loadSession(this.activeId);
          rt = this.active();
        } else {
          rt = await this.createSession();
        }
      } catch (err) {
        this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    if (!rt) {
      return;
    }

    const sent = rt;
    this.record(sent, { type: "userMessage", text });
    // For a fresh chat the message was already rendered above; only echo it here
    // for a send within an existing (visible) session.
    if (!startNew) {
      this.post({ type: "userMessage", text });
    }
    const blocks: ContentBlock[] = [...this.buildImplicitBlocks(), ...this.attachments.map((a) => a.block), { type: "text", text }];
    this.attachments = [];
    this.postAttachments();
    await this.runPrompt(sent, blocks);
  }

  // Run one prompt turn against a runtime and stream its outcome, rendering only
  // while that session is the visible one. On completion it flushes the next
  // queued message, so a session's queue drains itself turn by turn. Shared by a
  // live send and a queued flush.
  private async runPrompt(rt: Runtime, blocks: ContentBlock[]): Promise<void> {
    this.setRuntimeBusy(rt, true);
    if (this.activeId === rt.id) {
      this.post({ type: "assistantStart" });
    }
    const turn = rt.client.prompt(rt.id, blocks);
    rt.turn = turn;
    try {
      const result = await turn;
      // Only render the completion if this session is still the visible one.
      if (this.activeId === rt.id) {
        this.post({ type: "assistantEnd", stopReason: result.stopReason });
      }
    } catch (err) {
      if (this.activeId === rt.id) {
        this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (rt.turn === turn) {
        rt.turn = undefined;
      }
      this.endTurn(rt);
    }
  }

  // Close out a finished turn, but only for the surface that still holds the
  // session: one that moved away mid turn is finished by its new surface (see
  // `adoptTurn`), which owns the webview the result belongs to and its queue.
  private endTurn(rt: Runtime): void {
    if (this.runtimes.get(rt.id) !== rt) {
      rt.busy = false;
      return;
    }
    this.setRuntimeBusy(rt, false);
    // Send the next queued message first: the revert-head probe below is an
    // extra round trip on the same channel, and awaiting it here is what used
    // to leave a visible gap before a queued message went out.
    this.flushQueue(rt);
    void this.refreshSessions();
    // A chat moved here mid turn has no history on this surface, and now that the
    // channel is free it can be asked for. Only when the queue did not start
    // another turn, and it is still what the user is looking at.
    if (!rt.busy && rt.needsReplay && this.activeId === rt.id) {
      rt.needsReplay = false;
      void this.loadSession(rt.id);
      return;
    }
    // A live completion's head is on the current expansion: a reliable revert
    // target. Only read it when the session actually went idle, so it never
    // contends with a queued turn we just started.
    if (!rt.busy && this.activeId === rt.id) {
      void this.postTurnHead(true);
    }
  }

  // Take over a turn that was already running when the session arrived here, so
  // it ends on this surface: the reply settles, the working state clears, and the
  // queue drains here rather than on the surface it left.
  private adoptTurn(rt: Runtime, turn: Promise<PromptResult>): void {
    void turn
      .then(
        (result) => {
          if (this.activeId === rt.id) {
            this.post({ type: "assistantEnd", stopReason: result.stopReason });
          }
        },
        (err) => {
          if (this.activeId === rt.id) {
            this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
          }
        }
      )
      .then(() => this.endTurn(rt));
  }

  private queueSeq = 0;
  // The queued message currently being edited in the composer, if any. The queue
  // still drains past it: only that one message is held back when it reaches the
  // head, so earlier messages keep going and later ones stay behind it.
  private queueEditingId?: string;

  // Snapshot a message (implicit context + attachments + text) and add it to the
  // runtime's queue, then reflect the queue in the composer.
  private enqueueMessage(rt: Runtime, text: string, first = false): void {
    const blocks: ContentBlock[] = [...this.buildImplicitBlocks(), ...this.attachments.map((a) => a.block), { type: "text", text }];
    const message = { id: `q-${++this.queueSeq}`, text, blocks };
    if (first) {
      rt.queued.unshift(message);
    } else {
      rt.queued.push(message);
    }
    this.attachments = [];
    this.postAttachments();
    this.postQueued(rt);
  }

  // Send a message into a turn that is already running. ACP has no way to hand one
  // to a live prompt (what VS Code calls steering, and what its own agents support
  // through their SDKs), so the nearest honest thing is to put it at the head of
  // the queue and end the turn: the queue drains the moment it settles, so this is
  // the next thing the agent sees, and nothing is lost that the turn had done.
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
    this.enqueueMessage(rt, text, true);
    rt.client.cancel(rt.id);
  }

  // Send the next queued message once a runtime is free. Runs one at a time:
  // runPrompt calls back into this in its finally, so the queue drains in order.
  private flushQueue(rt: Runtime): void {
    if (rt.busy || rt.queued.length === 0) {
      return;
    }
    // Hold only the message being edited, and only once it reaches the head: the
    // ones before it still send, the ones after it wait behind it. Resumes when
    // the edit is committed or cancelled (see the queueEditing message).
    if (this.queueEditingId && rt.queued[0].id === this.queueEditingId) {
      return;
    }
    const next = rt.queued.shift()!;
    this.postQueued(rt);
    // Route the echo through emit so a flush that happens while the session is
    // backgrounded is buffered and replays (its user bubble shows on return),
    // instead of being dropped like the old active-only post.
    this.emit(rt, { type: "userMessage", text: next.text });
    void this.runPrompt(rt, next.blocks);
  }

  // Remove a queued message the user dropped or moved back to the composer.
  private removeQueued(id: string): void {
    const rt = this.active();
    if (!rt) {
      return;
    }
    const before = rt.queued.length;
    rt.queued = rt.queued.filter((q) => q.id !== id);
    if (rt.queued.length !== before) {
      this.postQueued(rt);
    }
  }

  // Move a queued message to the front and send it as soon as the session is
  // free (VS Code's "Send Immediately" on a pending request).
  private sendQueuedNow(id: string): void {
    const rt = this.active();
    if (!rt) {
      return;
    }
    const at = rt.queued.findIndex((q) => q.id === id);
    if (at <= -1) {
      return;
    }
    if (at > 0) {
      rt.queued.unshift(rt.queued.splice(at, 1)[0]);
      this.postQueued(rt);
    }
    this.flushQueue(rt);
  }

  // Update a queued message's text in place, keeping its position in the queue
  // (editing must not move it to the end).
  private editQueued(id: string, text: string): void {
    const rt = this.active();
    if (!rt || !text.trim()) {
      return;
    }
    const q = rt.queued.find((x) => x.id === id);
    if (!q) {
      return;
    }
    q.text = text;
    // The text block is the last block built at enqueue time; update it, keeping
    // the snapshotted implicit-context and attachment blocks before it.
    const tail = q.blocks[q.blocks.length - 1];
    if (tail && tail.type === "text") {
      tail.text = text;
    } else {
      q.blocks.push({ type: "text", text });
    }
    this.postQueued(rt);
  }

  // Replay a backgrounded session's buffered stream into the (now visible)
  // transcript and clear it, so returning shows the progress the turn made while
  // it was not on screen.
  private record(rt: Runtime, payload: Record<string, unknown>): void {
    if (recordPainted(rt.log, payload)) {
      rt.logFull = false;
    }
  }

  // Rebuild a transcript from what this session has already painted. This is how
  // a chat keeps its history when it moves surface mid turn, when asking the agent
  // for it would abort the turn.
  private replayLog(rt: Runtime): void {
    this.post({ type: "clear", loading: true });
    for (const payload of paintedReplay(rt.log)) {
      this.post(payload);
    }
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

  // Mirror a runtime's queue to the webview, but only while it is visible (the
  // composer only ever shows the active session's queue).
  private postQueued(rt: Runtime): void {
    if (this.activeId === rt.id) {
      this.post({ type: "queued", items: rt.queued.map((q) => ({ id: q.id, text: q.text })) });
    }
  }

  // After a turn completes, read the current head node id and hand it to the
  // webview so it can pin a revert target ("checkpoint") to the finished turn.
  // `reliable` marks the head as a valid revert target on the CURRENT expansion.
  // The agent re-expands the conversation on a session/load and assigns fresh
  // node ids, so the head read right after a reload is NOT reliable (the next
  // prompt orphans it). Live turn completions and instant restores are reliable.
  private async postTurnHead(reliable = false): Promise<void> {
    const rt = this.active();
    if (!rt || !rt.client.supportsRevert()) {
      return;
    }
    try {
      const head = await rt.client.currentHead(rt.id);
      if (head != null && this.activeId === rt.id) {
        this.post({ type: "turnHead", head, reliable });
      }
    } catch (err) {
      this.log(`[turn-head-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Preview what reverting to a node would undo (files + irreversible actions),
  // so the webview can render an inline confirmation before executing.
  private async handleRevertPreview(head: number, token?: unknown): Promise<void> {
    const rt = this.active();
    if (!rt || !Number.isFinite(head)) {
      return;
    }
    try {
      const result = await rt.client.revertPreview(rt.id, head);
      this.post({ type: "revertPreview", head, token, result });
    } catch (err) {
      this.post({ type: "revertPreview", head, token, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Execute a revert (edit-in-place submit, restore checkpoint, or undo). When
  // `resendText` is given, resend it as the next prompt after the rewind.
  private async handleRevertExecute(head: number, resendText: unknown, startNew: boolean): Promise<void> {
    if (!(await this.ensureReady())) {
      return;
    }
    // Reverting the very first turn has no prior node: start fresh instead.
    if (startNew || !Number.isFinite(head)) {
      await this.newSession();
      if (typeof resendText === "string" && resendText.trim()) {
        await this.handleSend(resendText, false);
      }
      return;
    }
    const rt = this.active();
    if (!rt) {
      return;
    }
    try {
      // The agent truncates the conversation but does NOT touch the client's
      // disk: revert/preview returns the file undo it expects us to apply. So
      // read the plan first, then rewind, then restore/delete each file so a
      // "Discard edits" actually removes the changes (e.g. a newly created file).
      const preview = await rt.client.revertPreview(rt.id, head).catch(() => undefined);
      await rt.client.revertExecute(rt.id, head);
      await this.applyRevertFileUndo(preview);
      // The working set now matches the reverted state; drop this session's.
      this.changes.clearFor(rt.id);
      this.post({ type: "reverted", head });
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (typeof resendText === "string" && resendText.trim()) {
      await this.handleSend(resendText, false);
    }
  }

  // Apply the file undo the agent planned in revert/preview. For a file we know
  // we created this session, delete it (VS Code removes created files rather
  // than leaving them empty); otherwise write back its original content.
  private async applyRevertFileUndo(preview?: RevertPreviewResult): Promise<void> {
    const actions = preview?.fileActions;
    if (!Array.isArray(actions)) {
      return;
    }
    for (const a of actions) {
      const p = typeof a.path === "string" ? a.path : undefined;
      if (!p) {
        continue;
      }
      if (this.changes.hasUnresolvedChange(p)) {
        await this.changes.reject(p); // restores original, or deletes if created
        continue;
      }
      const original = (a.kind as { originalContent?: string } | undefined)?.originalContent;
      try {
        if (typeof original === "string") {
          await fs.promises.writeFile(p, original, "utf8");
        }
      } catch {
        // best-effort: a failed restore should not abort the rewind
      }
    }
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
      rt.client.cancel(rt.id);
      this.settleRequestsFor(rt.id);
    } else {
      // No live session, but still close any stray prompt widgets.
      this.post({ type: "cancelPrompts" });
    }
    this.setBusy(false);
  }

  // Click-through popup for the status bar (the hover card can't be triggered
  // by click; VS Code has no API for that), mirroring the same info.
  async showInfo(): Promise<void> {
    type Item = vscode.QuickPickItem & { action?: "cloud" | "login" };
    const a = this.health?.account || {};
    const items: Item[] = [{ label: "$(link-external) Open Devin Cloud", detail: "https://app.devin.ai", action: "cloud" }];
    if (this.isReady()) {
      if (a.name || a.email) {
        items.push({ label: `$(account) ${a.name || a.email}`, description: a.name && a.email ? a.email : undefined });
      }
      const org = a.plan || a.tier;
      if (org) {
        items.push({ label: `$(organization) ${org}` });
      }
    } else {
      items.push({ label: "$(error) Not signed in", description: "Sign in", action: "login" });
    }
    const mm = [this.currentModel, this.currentMode].filter(Boolean).join("  /  ");
    if (mm) {
      items.push({ label: `$(sparkle) ${mm}` });
    }
    items.push({ label: `$(versions) CLI ${this.health?.version || "unknown"}` });
    const picked = await vscode.window.showQuickPick(items, { title: "Devin" });
    if (picked?.action === "cloud") {
      await vscode.env.openExternal(vscode.Uri.parse("https://app.devin.ai"));
    } else if (picked?.action === "login") {
      await this.authenticate();
    }
  }

  async showSessionsView(): Promise<void> {
    this.focus();
    this.leaveToList();
    this.post({ type: "body", body: "list" });
    await this.refreshSessionsFast();
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
    rt.busy = value;
    if (!value) {
      rt.lastActivityAt = Date.now();
      // A finished turn is when the CLI names a new chat, so this is what puts
      // that name in the header and the lists without anyone asking for it.
      void this.refreshSessions(true);
    }
    if (this.activeId === rt.id) {
      this.post({ type: "busy", value });
    } else if (value) {
      // A backgrounded session started working, so the webview's saved
      // transcript for it is now stale and must be reloaded on return.
      this.post({ type: "sessionActivity", id: rt.id });
    }
    this.broadcastStatuses();
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
      revert: !!this.active()?.client.supportsRevert(),
      subagentControl: !!this.active()?.client.supportsSubagentControl(),
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
      sendWhileWorking: this.cfg().get<string>("sendWhileWorking", "queue"),
      surface: this.kind
    });
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
      this.post(payload);
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

  private onUpdate(n: SessionUpdateNotification): void {
    const u = n.update as any;
    const rt = this.runtimeBySessionId(n.sessionId);
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
      case "user_message_chunk":
        this.emit(rt, { type: "userChunk", text: textOf(u.content), messageId: u.messageId });
        return;
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
        this.emit(rt, {
          type: "toolCall",
          id: u.toolCallId,
          parentId,
          title: u.title,
          kind: u.kind,
          meta: toolMeta(u),
          status: u.status || "pending",
          rawInput: u.rawInput,
          content: normalizeToolContent(u.content),
          locations: normalizeLocations(u.locations)
        });
        this.recordDiffs(u, rt);
        return;
      case "tool_call_update":
        this.emit(rt, {
          type: "toolCallUpdate",
          id: u.toolCallId,
          parentId,
          title: u.title,
          kind: u.kind,
          meta: toolMeta(u),
          status: u.status,
          rawInput: u.rawInput,
          content: normalizeToolContent(u.content),
          locations: normalizeLocations(u.locations)
        });
        this.recordDiffs(u, rt);
        return;
      case "usage_update":
        this.emit(rt, { type: "usage", used: u.used, size: u.size, cost: u.cost });
        return;
      case "available_commands_update":
        this.emit(rt, { type: "commands", commands: u.availableCommands });
        return;
      case "current_mode_update":
        if (rt) rt.mode = u.currentModeId || rt.mode;
        if (rt && this.activeId === rt.id && !rt.silentReplay) {
          this.currentMode = u.currentModeId || this.currentMode;
          this.statusBar?.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
          this.post({ type: "mode", mode: u.currentModeId });
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
      this.emit(rt, {
        type: "subagentEnd",
        id: this.subagentBlockId(rt, completed.agentId),
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
        const s = diffStat(c.oldText, c.newText);
        // Post the per-file counts before recordDiff fires the working-set list,
        // so the list renders with the deltas already known.
        this.emit(rt, { type: "fileChange", path: c.path, added: s.added, removed: s.removed, created: c.oldText == null || c.oldText === "" });
        this.changes.recordDiff(c.path, c.oldText ?? null, c.newText ?? "", rt.id, s);
      }
    }
  }

  // --- AcpHost implementation (agent -> client requests) -------------------

  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const rt = this.runtimeBySessionId(params.sessionId);
    const requestId = `perm-${++ChatController.permissionSeq}`;
    const tc = params.toolCall || ({} as RequestPermissionParams["toolCall"]);
    // Devin asks about a command without a title, putting the command itself in
    // `_meta`. Without it the widget could only say "a tool", which is not enough
    // to answer: the user has to see what would run.
    const command = typeof tc._meta?.["cognition.ai/editableCommand"] === "string"
      ? (tc._meta["cognition.ai/editableCommand"] as string).trim()
      : undefined;
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
    return rt ? rt.terminals.create(params) : { terminalId: "" };
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

  async writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
    const full = this.resolvePath(params.path, params.sessionId);
    let original: string | null = null;
    try {
      original = await fs.promises.readFile(full, "utf8");
    } catch {
      original = null;
    }
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, params.content, "utf8");
    // The edit is tracked against the session that made it, so a background
    // session's working set is waiting for it when it is next opened.
    const rt = this.runtimeBySessionId(params.sessionId);
    if (rt) {
      const s = diffStat(original, params.content);
      this.emit(rt, { type: "fileChange", path: full, added: s.added, removed: s.removed, created: original == null });
      this.changes.recordDiff(full, original, params.content, rt.id, s);
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
  // A file a tool pointed at rather than quoted: rendered as a pill that opens it.
  link?: boolean;
}

// Flatten ACP tool-call content into renderable items for the webview.
function normalizeToolContent(content: any): ToolContentItem[] {
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
        created: c.oldText == null || c.oldText === ""
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
  if (!m || typeof m !== "object") {
    return undefined;
  }
  const out: { inferenceToolName?: string; toolName?: string; eventType?: string } = {};
  if (typeof m["cognition.ai/inferenceToolName"] === "string") out.inferenceToolName = m["cognition.ai/inferenceToolName"];
  if (typeof m["cognition.ai/toolName"] === "string") out.toolName = m["cognition.ai/toolName"];
  if (typeof m["cognition.ai/eventType"] === "string") out.eventType = m["cognition.ai/eventType"];
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
    return uri.startsWith("file:") ? vscode.Uri.parse(uri).fsPath : uri;
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
