import * as vscode from "vscode";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { ChangeTracker } from "./diff/changeTracker";
import { SessionStore } from "./session/sessionStore";
import { StatusBar } from "./ui/statusBar";
import { reapOrphanedAgents } from "./cli/reaper";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Devin");
  // Clean up any agents left stranded by a previous crash or force-quit before
  // we start a fresh one. Only orphans (ppid == 1) are touched.
  reapOrphanedAgents((line) => output.appendLine(line));
  const changes = new ChangeTracker();
  const store = new SessionStore(context.workspaceState);
  const statusBar = new StatusBar();
  context.subscriptions.push(output, changes.register(), statusBar);

  const provider = new ChatViewProvider(context, store, changes, statusBar, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    // Ensure the ACP process is killed on reload/deactivate.
    { dispose: () => provider.dispose() }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devin.focusChat", () => provider.focus()),
    vscode.commands.registerCommand("devin.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("devin.showSessions", () => provider.showSessionsView()),
    vscode.commands.registerCommand("devin.cancel", () => provider.cancel()),
    vscode.commands.registerCommand("devin.runSetup", () => provider.runSetup()),
    vscode.commands.registerCommand("devin.showInfo", () => provider.showInfo())
  );
}

export function deactivate(): void {
  // Subscriptions dispose the provider and ACP process.
}
