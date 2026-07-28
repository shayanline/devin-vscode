import * as vscode from "vscode";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { ChangeTracker } from "./diff/changeTracker";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Devin");
  const changes = new ChangeTracker();
  context.subscriptions.push(output, changes.register());

  const provider = new ChatViewProvider(context, changes, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devin.focusChat", () => provider.focus()),
    vscode.commands.registerCommand("devin.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("devin.showSessions", () => provider.refreshSessions()),
    vscode.commands.registerCommand("devin.cancel", () => provider.cancel())
  );
}

export function deactivate(): void {
  // Subscriptions dispose the provider and ACP process.
}
