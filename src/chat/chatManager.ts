import * as vscode from "vscode";
import { ChatController, SurfaceHost } from "./chatViewProvider";
import { ChangeTracker } from "../diff/changeTracker";
import { SessionStore } from "../session/sessionStore";
import { StatusBar } from "../ui/statusBar";
import { checkHealth, loginShellEnv } from "../cli/locate";

// Owns the chat surfaces: the sidebar view (one ChatController) and any number
// of editor/window chat panels (one ChatController each). Shared singletons
// (SessionStore, ChangeTracker, StatusBar) live here and are passed into each
// controller. The runtime pool is per controller, so each surface runs its own
// `devin acp` sessions independently.
export class ChatManager implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer, SurfaceHost {
  public static readonly viewType = "devin.chatView";
  public static readonly editorViewType = "devin.chatEditor";

  private sidebar?: ChatController;
  private readonly panels = new Map<ChatController, vscode.WebviewPanel>();
  // A session being moved between surfaces, so the tab it is leaving does not
  // treat its own closure as the user abandoning the chat.
  private moving?: string;

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
      this.sidebar = new ChatController(this.context, this.store, this.changes, this.statusBar, this.output, "view", this);
    }
    this.sidebar.bind(view.webview, () => void vscode.commands.executeCommand("devin.chatView.focus"));
  }

  // --- Moving a session between surfaces (SurfaceHost) ----------------------

  owner(id: string, except?: ChatController): ChatController | undefined {
    if (!id) {
      return undefined;
    }
    for (const c of this.controllers()) {
      if (c !== except && c.ownsSession(id)) {
        return c;
      }
    }
    return undefined;
  }

  label(controller: ChatController): string {
    return controller === this.sidebar ? "the side panel" : "an editor tab";
  }

  reveal(controller: ChatController): void {
    controller.focus();
  }

  elsewhere(except: ChatController): string[] {
    const ids: string[] = [];
    for (const c of this.controllers()) {
      if (c === except) {
        continue;
      }
      const id = c.visibleSession();
      if (id) {
        ids.push(id);
      }
    }
    return ids;
  }

  // Move a session into a brand new editor tab, beside the current one.
  async detach(id: string): Promise<void> {
    if (!id) {
      return;
    }
    const from = this.owner(id);
    const to = this.openPanel(vscode.ViewColumn.Active, false);
    await to.whenReady();
    if (!from) {
      // Not running anywhere (a dead session): the tab just opens it itself.
      await to.openSession(id);
      this.titlePanel(to, id);
      return;
    }
    await this.move(from, to, id);
  }

  // Move a session back into the side panel, opening the panel if need be.
  async attach(id: string): Promise<void> {
    if (!id) {
      return;
    }
    const from = this.owner(id);
    const to = await this.ensureSidebar();
    if (!to) {
      return;
    }
    if (!from) {
      await to.openSession(id);
      return;
    }
    await this.move(from, to, id);
    // The tab it came from has nothing left to show.
    this.closePanelFor(from);
  }

  async moveHere(to: ChatController, id: string): Promise<void> {
    const from = this.owner(id, to);
    if (!from) {
      await to.openSession(id);
      return;
    }
    await this.move(from, to, id);
    if (from !== this.sidebar) {
      this.closePanelFor(from);
    }
  }

  // The handover itself: the live agent, its terminals and anything it is waiting
  // on leave one surface and are adopted by the other. Nothing restarts.
  private async move(from: ChatController, to: ChatController, id: string): Promise<void> {
    const transfer = from.exportRuntime(id);
    if (!transfer) {
      await to.openSession(id);
      return;
    }
    this.moving = id;
    try {
      await to.whenReady();
      await to.importRuntime(transfer);
      this.titlePanel(to, id);
    } finally {
      this.moving = undefined;
    }
  }

  // An editor tab showing one chat is named after it, like any other editor.
  private titlePanel(controller: ChatController, id: string): void {
    const panel = this.panels.get(controller);
    if (panel) {
      panel.title = this.store.titles()[id] || "Devin";
    }
  }

  // The sidebar controller only exists once its view has been resolved, which the
  // focus command triggers, so give VS Code a moment to do it.
  private async ensureSidebar(): Promise<ChatController | undefined> {
    await vscode.commands.executeCommand("devin.chatView.focus");
    for (let i = 0; i < 50 && !this.sidebar; i++) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return this.sidebar;
  }

  private controllers(): ChatController[] {
    return [this.sidebar, ...this.panels.keys()].filter(Boolean) as ChatController[];
  }

  private closePanelFor(controller: ChatController): void {
    const panel = this.panels.get(controller);
    if (panel) {
      panel.dispose();
    }
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
    const controller = new ChatController(this.context, this.store, this.changes, undefined, this.output, "editor", this);
    controller.autoNewSession = autoNewSession;
    this.panels.set(controller, panel);
    controller.bind(panel.webview, () => panel.reveal());
    panel.onDidDispose(() => {
      const live = controller.visibleSession();
      this.panels.delete(controller);
      // Closing a tab must never quietly kill a session that is still working.
      // VS Code cannot veto an editor closing, so the choice is offered after the
      // fact, and "Keep it open" reopens the tab it was just in.
      if (live && !this.stopped && this.moving !== live) {
        void this.decideClosedTab(controller, live);
        return;
      }
      controller.dispose();
    });
  }

  // A detached chat's tab was closed while its session was still alive.
  private async decideClosedTab(controller: ChatController, id: string): Promise<void> {
    const title = this.store.titles()[id] || id;
    const choice = await vscode.window.showWarningMessage(
      `The chat "${title}" is still running.`,
      { modal: true, detail: "Its tab has closed. Keep it open where it was, move it into the side panel, or stop it." },
      "Keep it open",
      "Move to side panel",
      "Terminate"
    );
    if (choice === "Move to side panel") {
      await vscode.commands.executeCommand("devin.chatView.focus");
      if (this.sidebar) {
        await this.move(controller, this.sidebar, id);
      }
      controller.dispose();
      return;
    }
    if (choice === "Keep it open") {
      // Put it back in a fresh tab: the agent never stopped, so this only costs
      // the transcript being repainted.
      const panel = this.openPanel(vscode.ViewColumn.Active, false);
      await this.move(controller, panel, id);
      controller.dispose();
      return;
    }
    // Anything else (Terminate, or dismissing the dialog) stops it, which is what
    // closing the tab used to do unconditionally.
    controller.dispose();
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
