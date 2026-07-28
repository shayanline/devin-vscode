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
import { listSessions } from "../session/sessionList";
import { ChangeTracker } from "../diff/changeTracker";

export class ChatViewProvider implements vscode.WebviewViewProvider, AcpHost {
  public static readonly viewType = "devin.chatView";

  private view?: vscode.WebviewView;
  private client?: AcpClient;
  private sessionId?: string;
  private starting?: Promise<void>;
  private busy = false;

  private readonly permissionResolvers = new Map<string, (res: RequestPermissionResult) => void>();
  private permissionSeq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly changes: ChangeTracker,
    private readonly output: vscode.OutputChannel
  ) {}

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
          this.postConfig();
          void this.refreshSessions();
          return;
        case "send":
          await this.handleSend(String(msg.text || ""));
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
        default:
          return;
      }
    } catch (err) {
      this.log(`[error] ${err instanceof Error ? err.stack || err.message : String(err)}`);
      this.post({ type: "error", text: err instanceof Error ? err.message : String(err) });
      this.setBusy(false);
    }
  }

  private postConfig(): void {
    const cfg = vscode.workspace.getConfiguration("devin");
    this.post({
      type: "config",
      mode: cfg.get<string>("defaultMode", "normal"),
      model: cfg.get<string>("defaultModel", ""),
      workspace: this.workspaceName()
    });
  }

  // --- Session management --------------------------------------------------

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || process.cwd();
  }

  private workspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name || "no folder open";
  }

  private cliPath(): string {
    return vscode.workspace.getConfiguration("devin").get<string>("cliPath", "devin") || "devin";
  }

  private ensureClient(): AcpClient {
    if (this.client) {
      return this.client;
    }
    const client = new AcpClient({ cliPath: this.cliPath(), cwd: this.cwd() });
    client.setHost(this);
    client.on("log", (line: string) => this.log(line));
    client.on("update", (n: SessionUpdateNotification) => this.onUpdate(n));
    client.on("exit", () => {
      this.client = undefined;
      this.sessionId = undefined;
      this.starting = undefined;
      this.setBusy(false);
    });
    client.start();
    this.client = client;
    return client;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = (async () => {
      const client = this.ensureClient();
      await client.initialize();
      const res = await client.newSession();
      this.sessionId = res.sessionId;
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
    this.client?.dispose();
    this.client = undefined;
    this.sessionId = undefined;
    this.starting = undefined;
    this.changes.clear();
    this.post({ type: "clear" });
    await this.ensureSession();
  }

  private async loadSession(id: string): Promise<void> {
    if (!id) {
      return;
    }
    this.client?.dispose();
    this.client = undefined;
    this.sessionId = undefined;
    this.starting = undefined;
    this.changes.clear();
    this.post({ type: "clear" });
    const client = this.ensureClient();
    await client.initialize();
    this.post({ type: "assistantStart" });
    await client.loadSession(id);
    this.sessionId = id;
    this.post({ type: "assistantEnd" });
    this.post({ type: "sessionReady", sessionId: id });
  }

  async refreshSessions(): Promise<void> {
    const sessions = await listSessions(this.cliPath(), this.cwd());
    this.post({ type: "sessions", sessions, activeId: this.sessionId });
  }

  // Surface the mode + model pickers to the webview from the session's
  // configOptions (Devin returns both, with full choice lists).
  private publishOptions(options: ConfigOption[] | undefined, currentModeId?: string): void {
    const byId = new Map((options || []).map((o) => [o.id, o]));
    const modeOpt = byId.get("mode");
    const modelOpt = byId.get("model");
    this.post({
      type: "options",
      modes: (modeOpt?.options || []).map((c) => ({ value: c.value, name: c.name || c.value })),
      currentMode: modeOpt?.currentValue || currentModeId,
      models: (modelOpt?.options || []).map((c) => ({ value: c.value, name: c.name || c.value })),
      currentModel: modelOpt?.currentValue
    });
  }

  private async applyDefaults(res: NewSessionResult): Promise<void> {
    if (!this.sessionId || !this.client) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("devin");
    const mode = cfg.get<string>("defaultMode", "accept-edits");
    const model = cfg.get<string>("defaultModel", "");
    const currentMode = res.modes?.currentModeId;
    try {
      if (mode && mode !== currentMode) {
        await this.client.setConfigOption(this.sessionId, "mode", mode);
      }
      if (model) {
        await this.client.setConfigOption(this.sessionId, "model", model);
      }
    } catch (err) {
      this.log(`[apply-defaults-failed] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async setMode(mode: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("devin")
      .update("defaultMode", mode, vscode.ConfigurationTarget.Workspace);
    if (this.sessionId && this.client) {
      try {
        await this.client.setConfigOption(this.sessionId, "mode", mode);
      } catch (err) {
        this.log(`[set-mode-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.post({ type: "mode", mode });
  }

  private async setModel(model: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("devin")
      .update("defaultModel", model, vscode.ConfigurationTarget.Workspace);
    if (this.sessionId && this.client) {
      try {
        await this.client.setConfigOption(this.sessionId, "model", model);
      } catch (err) {
        this.log(`[set-model-failed] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.post({ type: "model", model });
  }

  // --- Prompting -----------------------------------------------------------

  private async handleSend(text: string): Promise<void> {
    if (!text.trim() || this.busy) {
      return;
    }
    await this.ensureSession();
    if (!this.sessionId || !this.client) {
      return;
    }
    this.post({ type: "userMessage", text });
    this.setBusy(true);
    this.post({ type: "assistantStart" });

    const blocks: ContentBlock[] = [{ type: "text", text }];
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
    // Reject pending permission prompts as cancelled.
    for (const [, resolve] of this.permissionResolvers) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionResolvers.clear();
    this.setBusy(false);
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
        this.post({ type: "thoughtChunk", text: textOf(u.content) });
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>Devin</title>
</head>
<body>
  <div id="app">
    <div id="sessions-bar" class="hidden"></div>
    <div id="thread"></div>
    <div id="composer">
      <div id="permission-tray"></div>
      <div id="input-row">
        <textarea id="input" rows="1" placeholder="Ask Devin, @ to add context..."></textarea>
        <button id="send" title="Send">Send</button>
        <button id="stop" class="hidden" title="Stop">Stop</button>
      </div>
      <div id="controls">
        <select id="mode" title="Session mode"></select>
        <select id="model" title="Model"></select>
        <span id="status"></span>
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

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
