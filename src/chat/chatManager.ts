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
  // Controllers whose tab has closed and whose fate the user is being asked about.
  // They are out of `panels` by then, so shutdown has to find them here.
  private readonly deciding = new Set<ChatController>();
  // Sessions being moved between surfaces, so a tab that is closed as part of a
  // move does not treat its own closure as the user abandoning the chat.
  private readonly moving = new Set<string>();

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

  // A question's half given answers, flushed as its widget is torn down, which is
  // also how a session leaves a surface: find whoever holds the request now.
  saveAnswerDraft(requestId: string, state: unknown, except: ChatController): void {
    for (const c of this.controllers()) {
      if (c !== except && c.storeAnswerDraft(requestId, state)) {
        return;
      }
    }
  }

  elsewhere(except: ChatController): string[] {
    const ids = new Set<string>();
    for (const c of this.controllers()) {
      if (c === except) {
        continue;
      }
      for (const id of c.liveSessions()) {
        ids.add(id);
      }
    }
    return [...ids];
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
    // Close the tab it came from only when that was all it was running.
    if (!from.liveSessions().length) {
      this.closePanelFor(from);
    }
  }

  async moveHere(to: ChatController, id: string): Promise<void> {
    const from = this.owner(id, to);
    if (!from) {
      await to.openSession(id);
      return;
    }
    await this.move(from, to, id);
    if (from !== this.sidebar && !from.liveSessions().length) {
      this.closePanelFor(from);
    }
  }

  // The handover itself: the live agent, its terminals and anything it is waiting
  // on leave one surface and are adopted by the other. Nothing restarts.
  private async move(from: ChatController, to: ChatController, id: string): Promise<void> {
    // Wait for the destination first: export and import then run back to back with
    // nothing in between, so the agent is never left with no listener, no host and
    // no owner while a webview loads.
    await to.whenReady();
    const transfer = from.exportRuntime(id);
    if (!transfer) {
      await to.openSession(id);
      return;
    }
    this.moving.add(id);
    try {
      await to.importRuntime(transfer);
      this.titlePanel(to, id);
    } catch (err) {
      // The destination could not take it: hand it back rather than leave a live
      // agent owned by nobody, holding the session lock until the window closes.
      try {
        await from.importRuntime(transfer);
      } catch {
        // Both surfaces refused it; the runtime exit handler cleans up.
      }
      throw err;
    } finally {
      this.moving.delete(id);
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
    return [this.sidebar, ...this.panels.keys(), ...this.deciding].filter(Boolean) as ChatController[];
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
      // Every chat this tab was running, not just the one on screen: it keeps its
      // own session list, so others can be working in the background.
      const live = controller.liveSessions().filter((id) => !this.moving.has(id));
      this.panels.delete(controller);
      // Closing a tab must never quietly kill a session that is still working.
      // VS Code cannot veto an editor closing, so the choice is offered after the
      // fact, and "Keep it open" reopens the tab it was just in.
      if (live.length && !this.stopped) {
        this.deciding.add(controller);
        void this.decideClosedTab(controller, live);
        return;
      }
      controller.dispose();
    });
  }

  // A detached chat's tab was closed while its sessions were still alive.
  private async decideClosedTab(controller: ChatController, ids: string[]): Promise<void> {
    const titles = this.store.titles();
    const named = ids.map((id) => titles[id] || id);
    const subject = ids.length === 1 ? `The chat "${named[0]}" is` : `${ids.length} chats are`;
    const detail = ids.length === 1
      ? "Its tab has closed. Reopen it, move it into the side panel, or stop it."
      : `Their tab has closed: ${named.join(", ")}. Reopen them, move them into the side panel, or stop them.`;
    try {
      const choice = await vscode.window.showWarningMessage(
        `${subject} still running.`,
        { modal: true, detail },
        "Reopen",
        "Move to side panel",
        "Terminate"
      );
      if (choice === "Move to side panel") {
        const to = await this.ensureSidebar();
        for (const id of to ? ids : []) {
          await this.move(controller, to!, id);
        }
      } else if (choice === "Reopen") {
        // Back into a fresh tab: the agent never stopped, so this only costs the
        // transcript being repainted.
        const to = this.openPanel(vscode.ViewColumn.Active, false);
        for (const id of ids) {
          await this.move(controller, to, id);
        }
      }
      // Anything else (Terminate, or dismissing the dialog) stops them, which is
      // what closing the tab used to do unconditionally.
    } finally {
      this.deciding.delete(controller);
      controller.dispose();
    }
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
