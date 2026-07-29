import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { AcpClient, AcpHost } from "../acp/client";
import {
  ConfigOption,
  ContentBlock,
  NewSessionResult,
  ReadTextFileParams,
  RequestPermissionParams,
  RequestPermissionResult,
  SessionUpdateNotification,
  WriteTextFileParams
} from "../acp/types";
import { listSessions, SessionScope } from "../session/sessionList";
import { SessionStore } from "../session/sessionStore";
import { ChangeTracker } from "../diff/changeTracker";
import { StatusBar } from "../ui/statusBar";
import { checkHealth, CliHealth, loginShellEnv } from "../cli/locate";

export class ChatViewProvider implements vscode.WebviewViewProvider, AcpHost {
  public static readonly viewType = "devin.chatView";

  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private sessionId?: string;
  private starting?: Promise<void>;
  private busy = false;
  private initialized = false;

  private health?: CliHealth;
  private resolvedCli = "devin";
  private env?: NodeJS.ProcessEnv;
  private currentMode?: string;
  private currentModel?: string;

  private readonly permissionResolvers = new Map<string, (res: RequestPermissionResult) => void>();
  private permissionSeq = 0;

  private attachments: { id: string; label: string; type: string; block: ContentBlock }[] = [];
  private attachSeq = 0;

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
          await this.refreshSessions();
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
    await this.runHealthCheck();
    await this.pushReadiness();
  }

  async runSetup(): Promise<void> {
    this.focus();
    await this.runHealthCheck();
    this.post({ type: "setup", health: this.publicHealth() });
  }

  // Decides whether the webview shows the setup panel or the chat.
  private async pushReadiness(): Promise<void> {
    if (this.isReady()) {
      this.post({ type: "ready" });
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

  private additionalDirs(): string[] {
    return this.folders().slice(1);
  }

  private workspaceName(): string {
    if (vscode.workspace.workspaceFile) {
      return path.basename(vscode.workspace.workspaceFile.fsPath).replace(/\.code-workspace$/, "");
    }
    return vscode.workspace.workspaceFolders?.[0]?.name || "no folder open";
  }

  private scope(): SessionScope {
    const v = this.cfg().get<string>("sessionScope", "both");
    return v === "workspace" || v === "directory" ? v : "both";
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
      const res = await client.newSession(this.additionalDirs());
      this.sessionId = res.sessionId;
      this.store.add(res.sessionId);
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
    this.resetClient();
    this.changes.clear();
    this.post({ type: "clear" });
    await this.ensureSession();
  }

  private resetClient(): void {
    this.client?.dispose();
    this.client = undefined;
    this.sessionId = undefined;
    this.starting = undefined;
    this.initialized = false;
  }

  private async loadSession(id: string): Promise<void> {
    if (!id || !(await this.ensureReady())) {
      return;
    }
    this.resetClient();
    this.changes.clear();
    this.post({ type: "clear" });
    const client = await this.ensureInitialized();
    this.post({ type: "assistantStart" });
    await client.loadSession(id, this.additionalDirs());
    this.sessionId = id;
    this.store.add(id);
    this.store.setActive(id);
    this.post({ type: "assistantEnd" });
    this.post({ type: "sessionReady", sessionId: id });
    void this.refreshSessions();
  }

  async refreshSessions(): Promise<void> {
    if (!this.isReady()) {
      return;
    }
    const folders = this.folders();
    const sessions = await listSessions({
      cliPath: this.resolvedCli || "devin",
      env: this.env,
      folders,
      trackedIds: this.store.ids(),
      scope: this.scope()
    });
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
    await this.refreshSessions();
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
      this.resetClient();
      this.post({ type: "clear" });
    }
    await this.refreshSessions();
  }

  // --- Mode + model --------------------------------------------------------

  private publishOptions(options: ConfigOption[] | undefined, currentModeId?: string): void {
    const byId = new Map((options || []).map((o) => [o.id, o]));
    const modeOpt = byId.get("mode");
    const modelOpt = byId.get("model");
    this.currentMode = modeOpt?.currentValue || currentModeId || this.currentMode;
    this.currentModel = modelOpt?.currentValue || this.currentModel;
    this.statusBar.set({ connected: this.isReady(), mode: this.currentMode, model: this.currentModel });
    this.post({
      type: "options",
      modes: (modeOpt?.options || []).map((c) => ({ value: c.value, name: c.name || c.value })),
      currentMode: this.currentMode,
      models: (modelOpt?.options || []).map((c) => ({ value: c.value, name: c.name || c.value })),
      currentModel: this.currentModel
    });
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
      if (model) {
        await this.client.setConfigOption(this.sessionId, "model", model);
        this.currentModel = model;
      }
      this.statusBar.set({ connected: true, mode: this.currentMode, model: this.currentModel });
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
    // Sending from the sessions list starts a fresh session.
    if (startNew) {
      this.resetClient();
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
    } catch (err) {
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.setBusy(false);
      void this.refreshSessions();
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

  async showSessionsView(): Promise<void> {
    this.focus();
    this.post({ type: "body", body: "list" });
    await this.refreshSessions();
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.post({ type: "busy", value });
  }

  // --- Incoming session/update notifications -------------------------------

  private onUpdate(n: SessionUpdateNotification): void {
    const u = n.update as any;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.post({ type: "assistantChunk", text: textOf(u.content) });
        return;
      case "agent_thought_chunk":
        if (this.cfg().get<boolean>("showThinking", true)) {
          this.post({ type: "thoughtChunk", text: textOf(u.content) });
        }
        return;
      case "plan":
        this.post({ type: "plan", entries: u.entries });
        return;
      case "tool_call":
        this.post({ type: "toolCall", id: u.toolCallId, title: u.title, kind: u.kind, status: u.status || "pending" });
        this.recordDiffs(u);
        return;
      case "tool_call_update":
        this.post({ type: "toolCallUpdate", id: u.toolCallId, title: u.title, status: u.status });
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
<body>
  <div id="app">
    <div id="setup" class="hidden"></div>

    <div id="chat" class="hidden">
      <div id="chat-header">
        <button id="history-btn" class="icon-btn" title="Show chats"><i class="codicon codicon-list-unordered"></i></button>
        <span id="chat-title">Chat</span>
        <span class="spacer"></span>
        <span id="status"></span>
        <button id="newchat-btn" class="icon-btn" title="New chat"><i class="codicon codicon-add"></i></button>
      </div>

      <div id="body">
        <div id="sessions-list" class="hidden"></div>
        <div id="thread"></div>
      </div>

      <div id="composer">
        <div id="working-set" class="hidden"></div>
        <div id="elicitation-tray"></div>
        <div id="permission-tray"></div>
        <div id="autocomplete" class="hidden"></div>
        <div id="input-box">
          <div id="attachments" class="hidden"></div>
          <textarea id="input" rows="1" placeholder="Ask Devin"></textarea>
          <div id="toolbar">
            <div class="toolbar-left">
              <button id="attach" class="icon-btn" title="Add context"><i class="codicon codicon-attach"></i></button>
              <div id="mode-dd" class="dd"></div>
            </div>
            <div class="toolbar-right">
              <div id="model-dd" class="dd right"></div>
              <button id="send" class="icon-btn send" title="Send"><i class="codicon codicon-send"></i></button>
              <button id="stop" class="icon-btn hidden" title="Stop"><i class="codicon codicon-debug-stop"></i></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
