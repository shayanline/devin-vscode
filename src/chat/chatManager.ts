import * as vscode from "vscode";
import { ChatController } from "./chatViewProvider";
import { ChangeTracker } from "../diff/changeTracker";
import { SessionStore } from "../session/sessionStore";
import { StatusBar } from "../ui/statusBar";
import { checkHealth, loginShellEnv } from "../cli/locate";

// Owns the chat surfaces: the sidebar view (one ChatController) and any number
// of editor/window chat panels (one ChatController each). Shared singletons
// (SessionStore, ChangeTracker, StatusBar) live here and are passed into each
// controller. The runtime pool is per controller, so each surface runs its own
// `devin acp` sessions independently.
export class ChatManager implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  public static readonly viewType = "devin.chatView";
  public static readonly editorViewType = "devin.chatEditor";

  private sidebar?: ChatController;
  private readonly panels = new Map<ChatController, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly changes: ChangeTracker,
    private readonly statusBar: StatusBar,
    private readonly output: vscode.OutputChannel
  ) {}

  // --- Sidebar view ---------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    if (!this.sidebar) {
      this.sidebar = new ChatController(this.context, this.store, this.changes, this.statusBar, this.output, "view");
    }
    this.sidebar.bind(view.webview, () => void vscode.commands.executeCommand("devin.chatView.focus"));
  }

  // --- Commands proxied to the sidebar surface ------------------------------

  focus(): void {
    if (this.sidebar) {
      this.sidebar.focus();
    } else {
      void vscode.commands.executeCommand("devin.chatView.focus");
    }
  }
  newSession(): void {
    this.focus();
    void this.sidebar?.newSession();
  }
  showSessions(): void {
    void this.sidebar?.showSessionsView();
  }
  cancel(): void {
    this.sidebar?.cancel();
  }
  runSetup(): void {
    void this.sidebar?.runSetup();
  }
  showInfo(): void {
    void this.sidebar?.showInfo();
  }

  // --- New session in the editor area / a new window ------------------------

  newSessionEditor(): void {
    this.openPanel(vscode.ViewColumn.Active, true);
  }

  async newSessionWindow(): Promise<void> {
    // No stable API creates a webview directly in an auxiliary window, so open
    // it in the active group, then move that editor into a new window.
    this.openPanel(vscode.ViewColumn.Active, true);
    try {
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch {
      // Fall back to leaving it in the editor area if the move is unavailable.
    }
  }

  private openPanel(column: vscode.ViewColumn, autoNewSession: boolean): ChatController {
    const panel = vscode.window.createWebviewPanel(
      ChatManager.editorViewType,
      "Devin",
      column,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icon.png");
    this.adoptPanel(panel, autoNewSession);
    return this.controllerForPanel(panel)!;
  }

  private controllerForPanel(panel: vscode.WebviewPanel): ChatController | undefined {
    for (const [controller, p] of this.panels) {
      if (p === panel) {
        return controller;
      }
    }
    return undefined;
  }

  private adoptPanel(panel: vscode.WebviewPanel, autoNewSession: boolean): void {
    const controller = new ChatController(this.context, this.store, this.changes, undefined, this.output, "editor");
    controller.autoNewSession = autoNewSession;
    this.panels.set(controller, panel);
    controller.bind(panel.webview, () => panel.reveal());
    panel.onDidDispose(() => {
      controller.dispose();
      this.panels.delete(controller);
    });
  }

  // Restore editor/window chats after a reload. We reopen the surface (it lands
  // on the session list so the user can pick a session back up) rather than
  // starting a fresh session, to avoid spawning an unwanted new acp.
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown): Promise<void> {
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    this.adoptPanel(panel, false);
  }

  // --- New Devin CLI session in a terminal ----------------------------------

  async newSessionTerminal(): Promise<void> {
    const setting = vscode.workspace.getConfiguration("devin").get<string>("cliPath", "devin") || "devin";
    const [health, env] = await Promise.all([checkHealth(setting), loginShellEnv()]);
    const bin = health.path || "devin";
    const extra = vscode.workspace.getConfiguration("devin").get<Record<string, string>>("env", {}) || {};
    const term = vscode.window.createTerminal({
      name: "Devin CLI",
      cwd: this.terminalCwd(),
      env: { ...env, ...extra }
    });
    term.show(true);
    term.sendText(quoteArg(bin));
  }

  private terminalCwd(): string {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || process.cwd();
  }

  // Whichever stop path runs first wins, so the fallback dispose after an awaited
  // shutdown is a no-op rather than a second round of signals.
  private stopped = false;

  // Stop every surface for good and resolve once every agent has really exited.
  // Called from `deactivate`, which VS Code awaits, so a window reload leaves no
  // stranded agents, MCP servers or running commands behind.
  async shutdown(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const controllers = [this.sidebar, ...this.panels.keys()].filter(Boolean) as ChatController[];
    await Promise.all(controllers.map((c) => c.shutdown()));
    this.panels.clear();
  }

  dispose(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.sidebar?.dispose();
    for (const controller of this.panels.keys()) {
      controller.dispose();
    }
    this.panels.clear();
  }
}

// Quote a binary path for the user's shell (POSIX single-quote / Windows
// double-quote), matching the escaping used elsewhere for the auth command.
function quoteArg(p: string): string {
  if (process.platform === "win32") {
    return /\s/.test(p) ? `"${p}"` : p;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
