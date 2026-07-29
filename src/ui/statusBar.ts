import * as vscode from "vscode";

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "devin.showInfo";
    this.item.text = "$(comment-discussion)";
    this.item.tooltip = "Devin";
    this.item.show();
  }

  // Icon-only in the status bar; the model/mode/connection detail lives in the
  // tooltip and the click-through info popup.
  set(state: { connected: boolean; mode?: string; model?: string }): void {
    if (!state.connected) {
      this.item.text = "$(debug-disconnect)";
      this.item.tooltip = "Devin: not connected. Click for details.";
      return;
    }
    const parts = [state.model, state.mode].filter(Boolean).join(" / ");
    this.item.text = "$(comment-discussion)";
    this.item.tooltip = `Devin${parts ? ": " + parts : ""}`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
