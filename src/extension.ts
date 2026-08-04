import * as vscode from "vscode";
import { ChatManager } from "./chat/chatManager";
import { ChangeTracker } from "./diff/changeTracker";
import { SessionStore } from "./session/sessionStore";
import { StatusBar } from "./ui/statusBar";
import { reapOrphanedAgents } from "./cli/reaper";
import { sweepStaleLocks } from "./cli/sessionLocks";
import { SettingsPanel } from "./settings/settingsPanel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Devin");
  // Clean up anything left stranded by a previous crash or force-quit before we
  // start fresh: orphaned `devin acp` agents (ppid == 1), and session lock
  // files whose owning PID is dead. Deferred so activation never blocks on the
  // lock-dir scan. Live owners are left untouched.
  reapOrphanedAgents((line) => output.appendLine(line));
  setTimeout(() => {
    try {
      sweepStaleLocks((line) => output.appendLine(line));
    } catch {
      // best effort
    }
  }, 0).unref?.();
  const changes = new ChangeTracker();
  const store = new SessionStore(context.workspaceState);
  const statusBar = new StatusBar();
  context.subscriptions.push(output, changes.register(), statusBar);

  const manager = new ChatManager(context, store, changes, statusBar, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatManager.viewType, manager, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewPanelSerializer(ChatManager.editorViewType, manager),
    // Ensure the ACP processes are killed on reload/deactivate.
    { dispose: () => manager.dispose() }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devin.focusChat", () => manager.focus()),
    vscode.commands.registerCommand("devin.newSession", () => manager.newSession()),
    vscode.commands.registerCommand("devin.newSessionEditor", () => manager.newSessionEditor()),
    vscode.commands.registerCommand("devin.newSessionWindow", () => manager.newSessionWindow()),
    vscode.commands.registerCommand("devin.newSessionTerminal", () => manager.newSessionTerminal()),
    vscode.commands.registerCommand("devin.showSessions", () => manager.showSessions()),
    vscode.commands.registerCommand("devin.cancel", () => manager.cancel()),
    vscode.commands.registerCommand("devin.runSetup", () => manager.runSetup()),
    vscode.commands.registerCommand("devin.showInfo", () => manager.showInfo()),
    vscode.commands.registerCommand("devin.openSettings", () => SettingsPanel.show(context))
  );
}

export function deactivate(): void {
  // Subscriptions dispose the provider and ACP process.
}
