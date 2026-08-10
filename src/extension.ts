import * as vscode from "vscode";
import { ChatManager } from "./chat/chatManager";
import { ChangeTracker } from "./diff/changeTracker";
import { SessionStore } from "./session/sessionStore";
import { StatusBar } from "./ui/statusBar";
import { reapOrphanedAgents } from "./cli/reaper";
import { sweepStaleLocks } from "./cli/sessionLocks";
import { SettingsPanel } from "./settings/settingsPanel";

// Held at module scope so `deactivate` can await the shutdown. A `devin acp`
// agent runs its commands, file writes and permission prompts through this
// extension host over our stdio, so it cannot be handed to the next one: the
// only safe move on the way out is to stop every agent deterministically.
let manager: ChatManager | undefined;

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
  // A change waiting to be reviewed has nothing to do with the agent that made it,
  // so it survives a window reload: without this the diffs and their Keep and Undo
  // were forgotten, and the next edit looked like a brand new set of changes.
  void changes.useStore(context.storageUri || context.globalStorageUri);

  manager = new ChatManager(context, store, changes, statusBar, output);
  const chat = manager;
  // Keep the session list live off the CLI's own store instead of a refresh button.
  chat.watchSessionStore();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatManager.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewPanelSerializer(ChatManager.editorViewType, chat),
    // A backstop for any path that disposes the extension without calling
    // `deactivate`. After an awaited shutdown this is a no-op.
    { dispose: () => chat.dispose() }
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("devin.focusChat", () => chat.focus()),
    vscode.commands.registerCommand("devin.newSession", () => chat.newSession()),
    vscode.commands.registerCommand("devin.newSessionEditor", () => chat.newSessionEditor()),
    vscode.commands.registerCommand("devin.newSessionWindow", () => chat.newSessionWindow()),
    vscode.commands.registerCommand("devin.newSessionTerminal", () => chat.newSessionTerminal()),
    vscode.commands.registerCommand("devin.renameTabSession", () => chat.renameTabSession()),
    vscode.commands.registerCommand("devin.showSessions", () => chat.showSessions()),
    vscode.commands.registerCommand("devin.switchSession", (index: number) => chat.switchSession(index)),
    vscode.commands.registerCommand("devin.cancel", () => chat.cancel()),
    vscode.commands.registerCommand("devin.runSetup", () => chat.runSetup()),
    vscode.commands.registerCommand("devin.showInfo", () => chat.showInfo()),
    vscode.commands.registerCommand("devin.openSettings", () => SettingsPanel.show(context))
  );
}

// VS Code awaits this (with a timeout) before tearing the extension host down,
// which is the only point where we can wait for the agents to actually exit. The
// synchronous dispose path cannot: its escalation to SIGKILL sits on a timer that
// never fires once the host has gone, which is how an agent that ignores SIGTERM
// used to survive as an orphan until the next window reaped it.
export async function deactivate(): Promise<void> {
  const chat = manager;
  manager = undefined;
  await chat?.shutdown();
}
