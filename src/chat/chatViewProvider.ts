import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { AcpClient, AcpHost } from "../acp/client";
import {
  ConfigOption,
  ContentBlock,
  CreateTerminalParams,
  NewSessionResult,
  ReadTextFileParams,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionUpdateNotification,
  TerminalExitStatus,
  TerminalRef,
  WriteTextFileParams
} from "../acp/types";
import { TerminalManager } from "../acp/terminal";
import { DevinSession, listSessions } from "../session/sessionList";
import { SessionStore } from "../session/sessionStore";
import { ChangeTracker } from "../diff/changeTracker";
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
  lastActivityAt: number; // for idle auto-exit
  mode?: string;
  model?: string;
  // A permission/elicitation request from a background session, re-surfaced to
  // the webview when the session is next opened.
  pending?: { requestId: string; payload: Record<string, unknown> };
}

// The dot shown next to a session in the list.
type SessionStatus = "running" | "idle" | "starting";

export class ChatViewProvider implements vscode.WebviewViewProvider, AcpHost {
  public static readonly viewType = "devin.chatView";

  private view?: vscode.WebviewView;

  // Live runtimes keyed by session id. Absent = dead (gray) history.
  private readonly runtimes = new Map<string, Runtime>();
  // The session currently shown in the webview (the interactive one).
  private activeId?: string;
  // A runtime "starting" label per id (e.g. waking / creating), for the dots.
  private readonly starting = new Set<string>();
  // A brand-new session being created (id not known until session/new returns).
  private startingNew?: Promise<Runtime>;
  private idleTimer?: NodeJS.Timeout;

  private health?: CliHealth;
  private resolvedCli = "devin";
  private env?: NodeJS.ProcessEnv;
  private currentMode?: string;
  private currentModel?: string;

  private readonly permissionResolvers = new Map<string, { resolve: (res: RequestPermissionResult) => void; rid: string }>();
  private permissionSeq = 0;

  private attachments: { id: string; label: string; type: string; block: ContentBlock }[] = [];
  private attachSeq = 0;

  // Whether the active editor file is sent as implicit context (VS Code's
  // current-file behaviour). Mirrored to the composer as a pill.
  private implicitEnabled = true;
  private implicitTimer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly changes: ChangeTracker,
    private readonly statusBar: StatusBar,
    private readonly output: vscode.OutputChannel
  ) {
    this.changes.onDidChangeList((paths) => this.postWorkingSet(paths));
    this.implicitEnabled = this.cfg().get<boolean>("implicitContext.enabled", true);
    // Keep the implicit "current file" pill in sync with the active editor and
    // its selection (the latter debounced, since selection changes fire often).
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postImplicitContext()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.scheduleImplicitPost();
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

  private postWorkingSet(paths: string[]): void {
    this.post({
      type: "workingSet",
      files: paths.map((p) => ({ path: p, name: path.basename(p) }))
    });
  }

  // --- Webview lifecycle ---------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  focus(): void {
    void vscode.commands.executeCommand("devin.chatView.focus");
  }

  // Kill every live ACP process (and its terminals) so a window reload or
  // extension deactivate does not leave stranded `devin acp` agents (and their
  // MCP servers). This is item 6: stop all sessions on exit.
  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const rt of this.runtimes.values()) {
      this.destroyRuntime(rt);
    }
    this.runtimes.clear();
    this.starting.clear();
    this.activeId = undefined;
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
      lastActivityAt: Date.now()
    };
    ref = rt;
    client.setHost(this);
    client.on("log", (line: string) => this.log(line));
    client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n));
    client.on("exit", () => this.onRuntimeExit(rt));
    client.start();
    return rt;
  }

  // A runtime's `devin acp` exited (crash, kill, or idle exit). Drop it from
  // the pool and, if it was the visible one, reflect the disconnected state.
  private onRuntimeExit(rt: Runtime): void {
    if (rt.id) {
      this.runtimes.delete(rt.id);
      this.starting.delete(rt.id);
    }
    if (this.activeId === rt.id) {
      this.setBusy(false);
      this.statusBar.set({ connected: false });
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

  private broadcastStatuses(): void {
    const statuses: Record<string, SessionStatus> = {};
    for (const id of this.starting) {
      statuses[id] = "starting";
    }
    for (const [id, rt] of this.runtimes) {
      statuses[id] = rt.busy && rt.awaiting === 0 ? "running" : "idle";
    }
    this.post({ type: "sessionStatuses", statuses, activeId: this.activeId });
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
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
    void this.view?.webview.postMessage(message);
  }

  private log(line: string): void {
    this.output.appendLine(line);
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
        case "loadSession":
          await this.loadSession(String(msg.id || ""));
          return;
        case "activateSession":
          await this.activateSession(String(msg.id || ""));
          return;
        case "renameSession":
          await this.renameSession(String(msg.id || ""), msg.title);
          return;
        case "deleteSession":
          await this.deleteSession(String(msg.id || ""), msg.title);
          return;
        case "refreshSessions":
          await this.refreshSessions(true);
          return;
        case "leaveToList":
          this.leaveToList();
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
        case "reviewChanges":
          await vscode.commands.executeCommand("workbench.view.scm");
          return;
        case "addContext":
          await this.addContext();
          return;
        case "addSelection":
          await this.addSelection();
          return;
        case "setImplicit":
          this.implicitEnabled = !!msg.enabled;
          await this.cfg().update("implicitContext.enabled", this.implicitEnabled, vscode.ConfigurationTarget.Workspace);
          this.postImplicitContext();
          return;
        case "attachImage":
          this.attachImage(msg.name, msg.mime, msg.data);
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
        case "saveDefaults":
          await this.saveDefaults(msg.model, msg.mode);
          return;
        case "setConfig":
          await this.setConfig(msg.key, msg.value);
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
    this.post({ type: "workspace", name: this.workspaceName() });
    this.postImplicitContext();
    // The CLI health check spawns a login shell and calls the CLI, which can
    // take several seconds. Paint the chat shell immediately using the last
    // known readiness so the sidebar is never blank while it runs; the check
    // below then reconciles (switching to setup only if the CLI is missing or
    // signed out).
    if (this.context.globalState.get<boolean>(ChatViewProvider.READY_HINT, false)) {
      this.post({ type: "ready" });
      void this.publishInitialOptions();
    }
    await this.runHealthCheck();
    await this.pushReadiness();
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
    void this.context.globalState.update(ChatViewProvider.READY_HINT, this.isReady());
    if (this.isReady()) {
      this.post({ type: "ready" });
      void this.publishInitialOptions();
      await this.refreshSessions();
      if (this.cfg().get<boolean>("autoResumeLast", false)) {
        const last = this.store.activeId();
        if (last && !this.activeId) {
          this.post({ type: "body", body: "thread" });
          await this.loadSession(last);
        }
      }
    } else {
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
    this.statusBar.setInfo({ version: this.health.version, account: this.health.account });
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
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
    this.post({ type: "authStarted" });
  }

  private async saveDefaults(model: unknown, mode: unknown): Promise<void> {
    if (typeof model === "string") {
      await this.cfg().update("defaultModel", model, vscode.ConfigurationTarget.Global);
    }
    if (typeof mode === "string") {
      await this.cfg().update("defaultMode", mode, vscode.ConfigurationTarget.Global);
    }
  }

  // Persist a UI preference the webview toggled (e.g. a "don't ask again"
  // checkbox). Allowlisted so the webview cannot write arbitrary settings.
  private static readonly WRITABLE_KEYS = new Set(["editing.confirmEditRequestRemoval"]);
  private async setConfig(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== "string" || !ChatViewProvider.WRITABLE_KEYS.has(key)) return;
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
        this.store.setActive(rt.id);
        this.postCapabilities();
        this.publishOptions(res.configOptions, res.modes?.currentModeId);
        await this.applyDefaults(rt, res);
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
  private readonly takeoverResolvers = new Map<string, (d: "takeover" | "cancel") => void>();
  private takeoverSeq = 0;
  private askTakeover(id: string, pid?: number): Promise<"takeover" | "cancel"> {
    const requestId = `lock-${++this.takeoverSeq}`;
    this.post({ type: "lockConflict", requestId, id, pid });
    return new Promise((resolve) => this.takeoverResolvers.set(requestId, resolve));
  }
  private resolveTakeover(requestId: string, decision: string): void {
    const resolve = this.takeoverResolvers.get(requestId);
    if (!resolve) {
      return;
    }
    this.takeoverResolvers.delete(requestId);
    resolve(decision === "takeover" ? "takeover" : "cancel");
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
  // in the background (its runtime stays alive, shown green/amber in the list);
  // we only detach the composer's pending attachments so they do not bleed into
  // the next chat.
  private leaveToList(): void {
    this.clearAttachments();
  }

  private clearAttachments(): void {
    if (this.attachments.length) {
      this.attachments = [];
    }
    this.postAttachments();
  }

  async newSession(): Promise<void> {
    if (!(await this.ensureReady())) {
      return;
    }
    // The previous session (if any) is left alive in the background.
    this.activeId = undefined;
    this.changes.clear();
    this.attachments = [];
    this.focus();
    this.post({ type: "body", body: "thread" });
    this.post({ type: "clear" });
    try {
      await this.createSession();
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  // Open a session: reuse its live runtime if it is already alive, otherwise
  // wake it (spawn a fresh acp and load its history). Either way the session is
  // alive when this returns. Item 4.
  private async loadSession(id: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    const already = this.runtimes.get(id);
    this.activeId = id;
    this.changes.clear();
    this.attachments = [];
    // "Waking session…" while a fresh acp spins up; a live one loads instantly.
    this.post({ type: "clear", loading: true, waking: !already });
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
    try {
      if (!already) {
        await this.ensureInitialized(rt);
      }
      this.postCapabilities();
      const res = await this.loadWithTakeover(rt, id, cwd);
      rt.lastActivityAt = Date.now();
      this.store.add(id, cwd);
      this.store.setActive(id);
      if (res && (res.configOptions || res.modes)) {
        rt.mode = res.modes?.currentModeId || rt.mode;
        this.publishOptions(res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      this.post({ type: "assistantEnd" });
      this.post({ type: "sessionReady", sessionId: id });
      this.ensureIdleTimer();
    } catch (err) {
      // Waking failed: drop the half-spawned runtime so the row goes gray again.
      if (!already) {
        this.destroyRuntime(rt);
        this.runtimes.delete(id);
      }
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      rt.replaying = false;
      this.starting.delete(id);
      this.post({ type: "loaded" });
      await this.postTurnHead();
      this.broadcastStatuses();
      // Re-surface a permission/question this session raised while it was in the
      // background, now that it is visible again.
      const opened = this.runtimes.get(id);
      if (opened?.pending && this.activeId === id) {
        this.post(opened.pending.payload);
      }
      void this.refreshSessions();
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
    this.store.setActive(id);
    this.changes.clear();
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
    this.broadcastStatuses();
    await this.postTurnHead();
    // Re-surface a prompt this session raised while backgrounded.
    if (rt.pending) {
      this.post(rt.pending.payload);
    }
    void this.refreshSessions();
  }

  private sessionsCache?: { at: number; sessions: DevinSession[] };

  // `force` bypasses the short TTL cache (used for explicit refresh/rename/delete);
  // implicit refreshes after a load/prompt reuse the cache to avoid respawning
  // `devin list` repeatedly.
  async refreshSessions(force = false): Promise<void> {
    if (!this.isReady()) {
      return;
    }
    const folders = this.folders();
    let sessions: DevinSession[] = [];
    if (!force && this.sessionsCache && Date.now() - this.sessionsCache.at < 4000) {
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
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("devin list timed out")), 20000)
        );
        const { sessions: live, prunedIds } = await Promise.race([listing, timeout]);
        // Drop tracked ids Devin no longer knows about so stale rows self-heal.
        for (const id of prunedIds) {
          this.store.remove(id);
        }
        sessions = live;
        this.sessionsCache = { at: Date.now(), sessions };
      } catch (err) {
        this.log(`[list-failed] ${err instanceof Error ? err.message : String(err)}`);
        sessions = this.sessionsCache?.sessions ?? [];
      }
    }
    // Persist titles, and fill any tracked session whose title we only know
    // from the cache (e.g. its directory is not currently listed).
    const cached = this.store.titles();
    const freshTitles: Record<string, string> = {};
    for (const s of sessions) {
      if (s.title) {
        freshTitles[s.id] = s.title;
      } else if (cached[s.id]) {
        s.title = cached[s.id];
      }
    }
    this.store.cacheTitles(freshTitles);
    this.post({
      type: "sessions",
      sessions,
      activeId: this.activeId,
      statuses: this.statusMap(),
      folders: folders.map((f) => ({ path: f, name: path.basename(f) }))
    });
  }

  private statusMap(): Record<string, SessionStatus> {
    const statuses: Record<string, SessionStatus> = {};
    for (const id of this.starting) {
      statuses[id] = "starting";
    }
    for (const [id, rt] of this.runtimes) {
      statuses[id] = rt.busy && rt.awaiting === 0 ? "running" : "idle";
    }
    return statuses;
  }

  private async renameSession(id: string, currentTitle?: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    const title = await vscode.window.showInputBox({
      title: "Rename session",
      value: currentTitle || "",
      prompt: "New session title"
    });
    if (title === undefined || title.trim() === "") {
      return;
    }
    try {
      await this.withClient((client) => client.renameSession(id, title.trim()));
    } catch (err) {
      this.log(`[rename-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refreshSessions(true);
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

  private publishOptions(options: ConfigOption[] | undefined, currentModeId?: string): void {
    const byId = new Map((options || []).map((o) => [o.id, o]));
    const modeOpt = byId.get("mode");
    const modelOpt = byId.get("model");
    this.currentMode = modeOpt?.currentValue || currentModeId || this.currentMode;
    this.currentModel = modelOpt?.currentValue || this.currentModel;
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.postModelOptions(this.currentModel || "adaptive");
  }

  // Posts the mode + model-family options. Model families come from
  // `devin models list` (cached); if not fetched yet, fetch and re-post.
  private postModelOptions(currentModel: string): void {
    const families = cachedFamilies();
    const payload = {
      type: "options",
      modes: ChatViewProvider.STATIC_MODES,
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
          this.post({ ...payload, models: f });
          this.store.cacheOptions({ ...payload, models: f });
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
  // and the uids match what the ACP model option accepts). A live session's
  // own options still override these once one is created.
  private async publishInitialOptions(): Promise<void> {
    const cfgMode = this.cfg().get<string>("defaultMode", "accept-edits");
    const cfgModel = this.cfg().get<string>("defaultModel", "");
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
    const payload = {
      type: "options",
      modes: ChatViewProvider.STATIC_MODES,
      currentMode: cfgMode || "accept-edits",
      models: families,
      currentModel: cfgModel || "adaptive"
    };
    this.store.cacheOptions(payload);
    this.post(payload);
  }

  private async applyDefaults(rt: Runtime, res: NewSessionResult): Promise<void> {
    const mode = this.cfg().get<string>("defaultMode", "accept-edits");
    const model = this.cfg().get<string>("defaultModel", "");
    const currentMode = res.modes?.currentModeId;
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
      this.statusBar.set({ connected: true, mode: this.currentMode, model: this.currentModel });
      this.post({ type: "mode", mode: this.currentMode });
      if (this.currentModel) {
        this.post({ type: "model", model: this.currentModel });
      }
    } catch (err) {
      this.log(`[apply-defaults-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setMode(mode: string): Promise<void> {
    await this.cfg().update("defaultMode", mode, vscode.ConfigurationTarget.Workspace);
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
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({ type: "mode", mode });
  }

  private async setModel(model: string): Promise<void> {
    await this.cfg().update("defaultModel", model, vscode.ConfigurationTarget.Workspace);
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
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({ type: "model", model });
  }

  // --- Context attachments -------------------------------------------------

  private postAttachments(): void {
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
    const picks: (vscode.QuickPickItem & { id: string })[] = [
      { label: "$(list-selection) Current selection or file", id: "__sel__" },
      { label: "$(folder-opened) Browse...", id: "__browse__" },
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
    if (chosen.id === "__browse__") {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Add" });
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
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      const options: vscode.TextDocumentShowOptions = {};
      if (typeof line === "number" && line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        options.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      this.log(`[open-file-failed] ${err instanceof Error ? err.message : String(err)}`);
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
    try {
      const raw = await fs.promises.readFile(fsPath, "utf8");
      const text = raw.length > 200000 ? raw.slice(0, 200000) : raw;
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
    const text = `From ${rel}${hasSel ? ` lines ${sel.start.line + 1}-${sel.end.line + 1}` : ""}:\n\n\`\`\`${doc.languageId}\n${body.slice(0, 200000)}\n\`\`\``;
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
    if (!(await this.ensureReady())) {
      return;
    }
    // Starting a fresh chat leaves the previous session alive in the background.
    if (startNew) {
      this.activeId = undefined;
      this.changes.clear();
      this.attachments = [];
      this.post({ type: "clear" });
    }

    let rt = startNew ? undefined : this.active();
    if (rt && rt.busy) {
      return; // one turn at a time within a session
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
    this.post({ type: "userMessage", text });
    this.setRuntimeBusy(sent, true);
    this.post({ type: "assistantStart" });

    const blocks: ContentBlock[] = [...this.buildImplicitBlocks(), ...this.attachments.map((a) => a.block), { type: "text", text }];
    this.attachments = [];
    this.postAttachments();
    try {
      const result = await sent.client.prompt(sent.id, blocks);
      // Only render the completion if this session is still the visible one.
      if (this.activeId === sent.id) {
        this.post({ type: "assistantEnd", stopReason: result.stopReason });
        await this.postTurnHead();
      }
    } catch (err) {
      if (this.activeId === sent.id) {
        this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.setRuntimeBusy(sent, false);
      void this.refreshSessions();
    }
  }

  // After a turn completes, read the current head node id and hand it to the
  // webview so it can pin a revert target ("checkpoint") to the finished turn.
  private async postTurnHead(): Promise<void> {
    const rt = this.active();
    if (!rt || !rt.client.supportsRevert()) {
      return;
    }
    try {
      const head = await rt.client.currentHead(rt.id);
      if (head != null && this.activeId === rt.id) {
        this.post({ type: "turnHead", head });
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
      await rt.client.revertExecute(rt.id, head);
      // The rewind undoes file edits agent-side; drop our tracked working set
      // so the SCM group and working-set card reflect the reverted state.
      this.changes.clear();
      this.post({ type: "reverted", head });
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (typeof resendText === "string" && resendText.trim()) {
      await this.handleSend(resendText, false);
    }
  }

  cancel(): void {
    const rt = this.active();
    if (rt) {
      rt.client.cancel(rt.id);
      // Resolve pending requests owned by the visible session as cancelled.
      for (const [rid, e] of [...this.permissionResolvers]) {
        if (e.rid === rt.id) {
          e.resolve({ outcome: { outcome: "cancelled" } });
          this.permissionResolvers.delete(rid);
        }
      }
      for (const [rid, e] of [...this.elicitationResolvers]) {
        if (e.rid === rt.id) {
          e.resolve({ action: "cancel" });
          this.elicitationResolvers.delete(rid);
        }
      }
      rt.awaiting = 0;
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
    await this.refreshSessions(true);
  }

  // Set a runtime's busy state, mirroring it to the webview only when it is the
  // visible session, and refreshing the status dots.
  private setRuntimeBusy(rt: Runtime, value: boolean): void {
    rt.busy = value;
    if (!value) {
      rt.lastActivityAt = Date.now();
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
      editRequests: this.cfg().get<string>("editRequests", "inline"),
      checkpoints: this.cfg().get<boolean>("checkpoints.enabled", true),
      showFileChanges: this.cfg().get<boolean>("checkpoints.showFileChanges", true),
      confirmRemoval: this.cfg().get<boolean>("editing.confirmEditRequestRemoval", true),
      verbose: this.cfg().get<boolean>("verbose", true),
      progressBorder: this.cfg().get<boolean>("progressBorder.enabled", true),
      contextUsage: this.cfg().get<boolean>("contextUsage.enabled", true),
      inlineReferencesStyle: this.cfg().get<string>("inlineReferences.style", "box"),
      thinkingStyle: this.cfg().get<string>("thinking.style", "fixedScrolling"),
      streamAnim: this.cfg().get<string>("incrementalRendering.animationStyle", "rise")
    });
  }

  // --- Incoming session/update notifications -------------------------------

  private onUpdate(n: SessionUpdateNotification): void {
    const u = n.update as any;
    const rt = this.runtimeBySessionId(n.sessionId);
    // Only the visible session streams into the transcript. Background sessions
    // keep running; their progress is reflected by the status dot, and their
    // history is replayed when they are next opened.
    const active = !!rt && this.activeId === rt.id;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (active) this.post({ type: "assistantChunk", text: textOf(u.content), messageId: u.messageId });
        return;
      case "user_message_chunk":
        if (active) this.post({ type: "userChunk", text: textOf(u.content), messageId: u.messageId });
        return;
      case "agent_thought_chunk":
        if (active && this.cfg().get<boolean>("showThinking", true)) {
          this.post({ type: "thoughtChunk", text: textOf(u.content), messageId: u.messageId });
        }
        return;
      case "plan":
        if (active) this.post({ type: "plan", entries: u.entries });
        return;
      case "tool_call":
        if (active) {
          this.post({
            type: "toolCall",
            id: u.toolCallId,
            title: u.title,
            kind: u.kind,
            status: u.status || "pending",
            rawInput: u.rawInput,
            content: normalizeToolContent(u.content),
            locations: normalizeLocations(u.locations)
          });
        }
        this.recordDiffs(u, rt);
        return;
      case "tool_call_update":
        if (active) {
          this.post({
            type: "toolCallUpdate",
            id: u.toolCallId,
            title: u.title,
            kind: u.kind,
            status: u.status,
            rawInput: u.rawInput,
            content: normalizeToolContent(u.content),
            locations: normalizeLocations(u.locations)
          });
        }
        this.recordDiffs(u, rt);
        return;
      case "usage_update":
        if (active) this.post({ type: "usage", used: u.used, size: u.size, cost: u.cost });
        return;
      case "available_commands_update":
        if (active) this.post({ type: "commands", commands: u.availableCommands });
        return;
      case "current_mode_update":
        if (rt) rt.mode = u.currentModeId || rt.mode;
        if (active) {
          this.currentMode = u.currentModeId || this.currentMode;
          this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
          this.post({ type: "mode", mode: u.currentModeId });
        }
        return;
      default:
        return;
    }
  }

  private recordDiffs(u: any, rt?: Runtime): void {
    // Historical diffs from a session/load replay are already resolved, and
    // edits from a background session belong to a transcript we are not showing.
    // Only the visible, live session feeds the actionable working set.
    if (!rt || rt.replaying || this.activeId !== rt.id) {
      return;
    }
    const content = Array.isArray(u.content) ? u.content : [];
    for (const c of content) {
      if (c && c.type === "diff" && typeof c.path === "string") {
        const s = diffStat(c.oldText, c.newText);
        // Post the per-file counts before recordDiff fires the working-set list,
        // so the list renders with the deltas already known.
        this.post({ type: "fileChange", path: c.path, added: s.added, removed: s.removed, created: c.oldText == null || c.oldText === "" });
        this.changes.recordDiff(c.path, c.oldText ?? null, c.newText ?? "");
      }
    }
  }

  // --- AcpHost implementation (agent -> client requests) -------------------

  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const rt = this.runtimeBySessionId(params.sessionId);
    const requestId = `perm-${++this.permissionSeq}`;
    const payload = {
      type: "permission",
      requestId,
      title: params.toolCall?.title || "Devin wants to run a tool",
      kind: params.toolCall?.kind,
      options: params.options
    };
    if (rt) {
      rt.awaiting++;
      rt.pending = { requestId, payload };
    }
    // Show now if it's the visible session; otherwise mark amber and re-surface
    // when the session is opened.
    if (!rt || this.activeId === rt.id) {
      this.post(payload);
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
  private elicitationSeq = 0;

  createElicitation(params: any): Promise<unknown> {
    const rt = this.runtimeBySessionId(typeof params?.sessionId === "string" ? params.sessionId : undefined);
    const requestId = `elicit-${++this.elicitationSeq}`;
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
      rt.pending = { requestId, payload };
    }
    if (!rt || this.activeId === rt.id) {
      this.post(payload);
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

  // Drop a resolved request from its runtime's awaiting count and clear the
  // stored pending payload if it was the one just answered.
  private clearAwaiting(rid: string, requestId: string): void {
    const rt = this.runtimes.get(rid);
    if (rt) {
      rt.awaiting = Math.max(0, rt.awaiting - 1);
      if (rt.pending?.requestId === requestId) {
        rt.pending = undefined;
      }
    }
    this.broadcastStatuses();
  }

  async readTextFile(params: ReadTextFileParams): Promise<{ content: string }> {
    const full = params.path;
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

  killTerminal(params: TerminalRef): null {
    this.runtimeBySessionId(params.sessionId)?.terminals.kill(params.terminalId);
    return null;
  }

  releaseTerminal(params: TerminalRef): null {
    this.runtimeBySessionId(params.sessionId)?.terminals.release(params.terminalId);
    return null;
  }

  async writeTextFile(params: WriteTextFileParams): Promise<null> {
    const full = params.path;
    let original: string | null = null;
    try {
      original = await fs.promises.readFile(full, "utf8");
    } catch {
      original = null;
    }
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, params.content, "utf8");
    // Only the visible session's edits feed the working set (a background
    // session's edits belong to a transcript we are not showing).
    const rt = this.runtimeBySessionId(params.sessionId);
    if (rt && this.activeId === rt.id) {
      const s = diffStat(original, params.content);
      this.post({ type: "fileChange", path: full, added: s.added, removed: s.removed, created: original == null });
      this.changes.recordDiff(full, original, params.content);
    }
    return null;
  }

  // --- HTML ---------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
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
<body data-logo="${logoUri}" data-model-icons="${modelIcons}">
  ${appBody}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Added/removed line counts for a diff, from an LCS over lines (so the edit
// pills can show +N/-M like VS Code). Capped to avoid O(n*m) blowups on huge
// files, where it falls back to the net line delta.
function diffStat(oldText: string | null | undefined, newText: string | null | undefined): { added: number; removed: number } {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (!a.length) return { added: b.length, removed: 0 };
  if (!b.length) return { added: 0, removed: a.length };
  if (a.length > 4000 || b.length > 4000) {
    return { added: Math.max(0, b.length - a.length), removed: Math.max(0, a.length - b.length) };
  }
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const lcs = prev[n];
  return { added: n - lcs, removed: m - lcs };
}

// Flatten ACP tool-call content into renderable items for the webview.
function normalizeToolContent(content: any): { type: string; text?: string; path?: string; terminalId?: string; added?: number; removed?: number }[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: { type: string; text?: string; path?: string; terminalId?: string; added?: number; removed?: number }[] = [];
  for (const c of content) {
    if (!c) {
      continue;
    }
    if (c.type === "diff" && typeof c.path === "string") {
      const s = diffStat(c.oldText, c.newText);
      out.push({ type: "diff", path: c.path, added: s.added, removed: s.removed });
    } else if (c.type === "terminal" && typeof c.terminalId === "string") {
      out.push({ type: "terminal", terminalId: c.terminalId });
    } else if (c.type === "content") {
      const text = textOf(c.content);
      if (text) {
        out.push({ type: "text", text });
      }
    } else if (typeof c.text === "string") {
      out.push({ type: "text", text: c.text });
    }
  }
  return out;
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
  return "";
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

function getNonce(): string {
  // A CSP nonce must be unguessable, so use a CSPRNG rather than Math.random.
  return crypto.randomBytes(16).toString("hex");
}
