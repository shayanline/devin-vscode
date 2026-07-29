import * as vscode from "vscode";

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "devin.focusChat";
    this.item.text = "$(comment-discussion) Devin";
    this.item.tooltip = "Open the Devin chat";
    this.item.show();
  }

  set(state: { connected: boolean; mode?: string; model?: string }): void {
    if (!state.connected) {
      this.item.text = "$(debug-disconnect) Devin";
      this.item.tooltip = "Devin: not connected. Click to open and set up.";
      return;
    }
    const parts = [state.model, state.mode].filter(Boolean).join(" / ");
    this.item.text = `$(comment-discussion) Devin${parts ? ": " + parts : ""}`;
    this.item.tooltip = "Devin chat";
  }

  dispose(): void {
    this.item.dispose();
  }
}
