import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
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

export class ChatViewProvider implements vscode.WebviewViewProvider, AcpHost {
  public static readonly viewType = "devin.chatView";

  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private sessionId?: string;
  private starting?: Promise<void>;
  private busy = false;
  private initialized = false;
  // Working directory of the active session (used for the terminal and for
  // resolving relative file paths against the right folder).
  private activeCwd?: string;

  private health?: CliHealth;
  private resolvedCli = "devin";
  private env?: NodeJS.ProcessEnv;
  private currentMode?: string;
  private currentModel?: string;

  private readonly permissionResolvers = new Map<string, (res: RequestPermissionResult) => void>();
  private permissionSeq = 0;

  private attachments: { id: string; label: string; type: string; block: ContentBlock }[] = [];
  private attachSeq = 0;

  private terminals?: TerminalManager;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly changes: ChangeTracker,
    private readonly statusBar: StatusBar,
    private readonly output: vscode.OutputChannel
  ) {
    this.changes.onDidChangeList((paths) => this.postWorkingSet(paths));
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

  // Kill the ACP process (and its terminals) so a window reload or extension
  // deactivate does not leave a stranded `devin acp` (and its MCP servers).
  dispose(): void {
    try {
      this.client?.dispose();
    } catch {
      // ignore
    }
    this.client = undefined;
    this.sessionId = undefined;
    this.terminals?.disposeAll();
    this.terminals = undefined;
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
        case "renameSession":
          await this.renameSession(String(msg.id || ""), msg.title);
          return;
        case "deleteSession":
          await this.deleteSession(String(msg.id || ""), msg.title);
          return;
        case "refreshSessions":
          await this.refreshSessions(true);
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
        if (last && !this.sessionId) {
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

  // --- Session management --------------------------------------------------

  private extraArgs(): string[] {
    const v = this.cfg().get<string[]>("extraArgs", []);
    return Array.isArray(v) ? v.map(String) : [];
  }

  private clientEnv(): NodeJS.ProcessEnv {
    const extra = this.cfg().get<Record<string, string>>("env", {}) || {};
    return { ...(this.env || process.env), ...extra };
  }

  private ensureClient(): AcpClient {
    if (this.client) {
      return this.client;
    }
    const client = new AcpClient({
      cliPath: this.resolvedCli || "devin",
      cwd: this.cwd(),
      env: this.clientEnv(),
      extraArgs: this.extraArgs()
    });
    client.setHost(this);
    client.on("log", (line: string) => this.log(line));
    client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n));
    client.on("exit", () => {
      this.client = undefined;
      this.sessionId = undefined;
      this.starting = undefined;
      this.initialized = false;
      this.activeCwd = undefined;
      this.terminals?.disposeAll();
      this.terminals = undefined;
      this.setBusy(false);
      this.statusBar.set({ connected: false });
    });
    client.start();
    this.client = client;
    return client;
  }

  private async ensureInitialized(): Promise<AcpClient> {
    const client = this.ensureClient();
    if (!this.initialized) {
      await client.initialize();
      this.initialized = true;
    }
    return client;
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

  private async ensureSession(): Promise<void> {
    if (this.sessionId) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = (async () => {
      const client = await this.ensureInitialized();
      this.postCapabilities();
      const cwd = this.resolveNewSessionCwd();
      const res = await client.newSession(cwd, this.additionalDirs(cwd));
      this.sessionId = res.sessionId;
      this.activeCwd = cwd;
      this.store.add(res.sessionId, cwd);
      this.store.setActive(res.sessionId);
      this.publishOptions(res.configOptions, res.modes?.currentModeId);
      await this.applyDefaults(res);
      this.post({ type: "sessionReady", sessionId: this.sessionId });
      void this.refreshSessions();
    })();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async newSession(): Promise<void> {
    if (!(await this.ensureReady())) {
      return;
    }
    if (this.busy) {
      this.cancel();
    }
    // Start a fresh session on the existing connection (no process respawn).
    this.sessionId = undefined;
    this.starting = undefined;
    this.changes.clear();
    this.focus();
    this.post({ type: "body", body: "thread" });
    this.post({ type: "clear" });
    await this.ensureSession();
  }

  private async loadSession(id: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    if (this.busy) {
      this.cancel();
    }
    // Reuse the existing ACP connection (it supports multiple sessions); only
    // respawn if there is no live process. This makes switching sessions fast.
    this.changes.clear();
    this.post({ type: "clear", loading: true });
    try {
      const client = await this.ensureInitialized();
      this.postCapabilities();
      // Reuse the session's own directory if we know it; otherwise adopt the
      // active-editor folder (e.g. an external session opened for the first time).
      const cwd = this.store.cwds()[id] || this.resolveNewSessionCwd();
      const res = (await client.loadSession(id, cwd, this.additionalDirs(cwd))) as NewSessionResult | undefined;
      this.sessionId = id;
      this.activeCwd = cwd;
      this.store.add(id, cwd);
      this.store.setActive(id);
      if (res && (res.configOptions || res.modes)) {
        this.publishOptions(res.configOptions, res.modes?.currentModeId);
      } else {
        void this.publishInitialOptions();
      }
      this.post({ type: "assistantEnd" });
      this.post({ type: "sessionReady", sessionId: id });
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.post({ type: "loaded" });
      // Establish the current head so live turns after a resume can be reverted.
      await this.postTurnHead();
      void this.refreshSessions();
    }
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
      activeId: this.sessionId,
      folders: folders.map((f) => ({ path: f, name: path.basename(f) }))
    });
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
      const client = await this.ensureInitialized();
      await client.renameSession(id, title.trim());
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
    try {
      const client = await this.ensureInitialized();
      await client.deleteSession(id);
    } catch (err) {
      this.log(`[delete-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
    this.store.remove(id);
    if (this.sessionId === id) {
      this.sessionId = undefined;
      this.post({ type: "clear" });
    }
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

  private async applyDefaults(res: NewSessionResult): Promise<void> {
    if (!this.sessionId || !this.client) {
      return;
    }
    const mode = this.cfg().get<string>("defaultMode", "accept-edits");
    const model = this.cfg().get<string>("defaultModel", "");
    const currentMode = res.modes?.currentModeId;
    try {
      if (mode && mode !== currentMode) {
        await this.client.setConfigOption(this.sessionId, "mode", mode);
        this.currentMode = mode;
      }
      // Only re-apply a remembered model if it's still an available model
      // (when we know the list); otherwise keep the session's own default.
      const modelKnown = cachedFamilies().length === 0 || !!familyOf(model);
      if (model && modelKnown) {
        await this.client.setConfigOption(this.sessionId, "model", model);
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
    if (this.sessionId && this.client) {
      try {
        await this.client.setConfigOption(this.sessionId, "mode", mode);
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
    if (this.sessionId && this.client) {
      try {
        await this.client.setConfigOption(this.sessionId, "model", model);
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
      items: this.attachments.map((a) => ({ id: a.id, label: a.label, type: a.type }))
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
      fsPath = path.join(this.activeCwd || this.cwd(), fsPath);
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
    if (!text.trim() || this.busy) {
      return;
    }
    if (!(await this.ensureReady())) {
      return;
    }
    // Sending from the sessions list starts a fresh session (reusing the
    // existing ACP connection).
    if (startNew) {
      this.sessionId = undefined;
      this.starting = undefined;
      this.changes.clear();
      this.post({ type: "clear" });
    }
    await this.ensureSession();
    if (!this.sessionId || !this.client) {
      return;
    }
    this.post({ type: "userMessage", text });
    this.setBusy(true);
    this.post({ type: "assistantStart" });

    const blocks: ContentBlock[] = [...this.attachments.map((a) => a.block), { type: "text", text }];
    this.attachments = [];
    this.postAttachments();
    try {
      const result = await this.client.prompt(this.sessionId, blocks);
      this.post({ type: "assistantEnd", stopReason: result.stopReason });
      await this.postTurnHead();
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.setBusy(false);
      void this.refreshSessions();
    }
  }

  // After a turn completes, read the current head node id and hand it to the
  // webview so it can pin a revert target ("checkpoint") to the finished turn.
  private async postTurnHead(): Promise<void> {
    if (!this.sessionId || !this.client || !this.client.supportsRevert()) {
      return;
    }
    try {
      const head = await this.client.currentHead(this.sessionId);
      if (head != null) {
        this.post({ type: "turnHead", head });
      }
    } catch (err) {
      this.log(`[turn-head-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Preview what reverting to a node would undo (files + irreversible actions),
  // so the webview can render an inline confirmation before executing.
  private async handleRevertPreview(head: number, token?: unknown): Promise<void> {
    if (!this.sessionId || !this.client || !Number.isFinite(head)) {
      return;
    }
    try {
      const result = await this.client.revertPreview(this.sessionId, head);
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
    if (!this.sessionId || !this.client) {
      return;
    }
    try {
      await this.client.revertExecute(this.sessionId, head);
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
    if (this.sessionId) {
      this.client?.cancel(this.sessionId);
    }
    for (const [, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    for (const [, resolve] of this.elicitationResolvers) {
      resolve({ action: "cancel" });
    }
    this.elicitationResolvers.clear();
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
    this.post({ type: "body", body: "list" });
    await this.refreshSessions(true);
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.post({ type: "busy", value });
  }

  // Tell the webview which optional features are available/enabled so it can
  // gate edit-in-place, checkpoints, and undo.
  private postCapabilities(): void {
    this.post({
      type: "capabilities",
      revert: !!this.client?.supportsRevert(),
      editRequests: this.cfg().get<string>("editRequests", "inline"),
      checkpoints: this.cfg().get<boolean>("checkpoints.enabled", true),
      showFileChanges: this.cfg().get<boolean>("checkpoints.showFileChanges", true),
      confirmRemoval: this.cfg().get<boolean>("editing.confirmEditRequestRemoval", true)
    });
  }

  // --- Incoming session/update notifications -------------------------------

  private onUpdate(n: SessionUpdateNotification): void {
    const u = n.update as any;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.post({ type: "assistantChunk", text: textOf(u.content), messageId: u.messageId });
        return;
      case "user_message_chunk":
        this.post({ type: "userChunk", text: textOf(u.content), messageId: u.messageId });
        return;
      case "agent_thought_chunk":
        if (this.cfg().get<boolean>("showThinking", true)) {
          this.post({ type: "thoughtChunk", text: textOf(u.content), messageId: u.messageId });
        }
        return;
      case "plan":
        this.post({ type: "plan", entries: u.entries });
        return;
      case "tool_call":
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
        this.recordDiffs(u);
        return;
      case "tool_call_update":
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
        this.recordDiffs(u);
        return;
      case "usage_update":
        this.post({ type: "usage", used: u.used, size: u.size, cost: u.cost });
        return;
      case "available_commands_update":
        this.post({ type: "commands", commands: u.availableCommands });
        return;
      case "current_mode_update":
        this.currentMode = u.currentModeId || this.currentMode;
        this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
        this.post({ type: "mode", mode: u.currentModeId });
        return;
      default:
        return;
    }
  }

  private recordDiffs(u: any): void {
    const content = Array.isArray(u.content) ? u.content : [];
    for (const c of content) {
      if (c && c.type === "diff" && typeof c.path === "string") {
        this.changes.recordDiff(c.path, c.oldText ?? null, c.newText ?? "");
        this.post({ type: "fileChange", path: c.path });
      }
    }
  }

  // --- AcpHost implementation (agent -> client requests) -------------------

  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
    const requestId = `perm-${++this.permissionSeq}`;
    this.post({
      type: "permission",
      requestId,
      title: params.toolCall?.title || "Devin wants to run a tool",
      kind: params.toolCall?.kind,
      options: params.options
    });
    return new Promise<RequestPermissionResult>((resolve) => {
      this.permissionResolvers.set(requestId, resolve);
    });
  }

  private resolvePermission(requestId: string, optionId: unknown): void {
    const resolve = this.permissionResolvers.get(requestId);
    if (!resolve) {
      return;
    }
    this.permissionResolvers.delete(requestId);
    if (typeof optionId === "string" && optionId.length > 0) {
      resolve({ outcome: { outcome: "selected", optionId } });
    } else {
      resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  // The agent asks the user a structured question (e.g. ask_user_question).
  private readonly elicitationResolvers = new Map<string, (res: unknown) => void>();
  private elicitationSeq = 0;

  createElicitation(params: any): Promise<unknown> {
    const requestId = `elicit-${++this.elicitationSeq}`;
    this.post({
      type: "elicitation",
      requestId,
      mode: params?.mode || "form",
      message: params?.message || "",
      schema: params?.requestedSchema,
      url: params?.url
    });
    return new Promise((resolve) => {
      this.elicitationResolvers.set(requestId, resolve);
    });
  }

  private resolveElicitation(requestId: string, action: string, content: unknown): void {
    const resolve = this.elicitationResolvers.get(requestId);
    if (!resolve) {
      return;
    }
    this.elicitationResolvers.delete(requestId);
    if (action === "accept") {
      resolve({ action: "accept", content: content ?? null });
    } else {
      resolve({ action: action === "decline" ? "decline" : "cancel" });
    }
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

  private ensureTerminals(): TerminalManager {
    if (!this.terminals) {
      this.terminals = new TerminalManager(
        this.clientEnv(),
        this.activeCwd || this.cwd(),
        (terminalId, output, exitStatus) => this.post({ type: "terminalOutput", terminalId, output, exitStatus }),
        (line) => this.log(line)
      );
    }
    return this.terminals;
  }

  createTerminal(params: CreateTerminalParams): { terminalId: string } {
    return this.ensureTerminals().create(params);
  }

  terminalOutput(params: TerminalRef): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null } {
    return this.ensureTerminals().output(params.terminalId);
  }

  waitForTerminalExit(params: TerminalRef): Promise<TerminalExitStatus> {
    return this.ensureTerminals().waitForExit(params.terminalId);
  }

  killTerminal(params: TerminalRef): null {
    this.terminals?.kill(params.terminalId);
    return null;
  }

  releaseTerminal(params: TerminalRef): null {
    this.terminals?.release(params.terminalId);
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
    this.changes.recordDiff(full, original, params.content);
    this.post({ type: "fileChange", path: full });
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

// Flatten ACP tool-call content into renderable items for the webview.
function normalizeToolContent(content: any): { type: string; text?: string; path?: string; terminalId?: string }[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: { type: string; text?: string; path?: string; terminalId?: string }[] = [];
  for (const c of content) {
    if (!c) {
      continue;
    }
    if (c.type === "diff" && typeof c.path === "string") {
      out.push({ type: "diff", path: c.path });
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
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
