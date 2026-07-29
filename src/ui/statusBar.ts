import * as vscode from "vscode";
import { CliAccount } from "../cli/locate";

interface State {
  connected: boolean;
  mode?: string;
  model?: string;
}

interface Info {
  version?: string;
  account?: CliAccount;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private state: State = { connected: false };
  private info: Info = {};

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "devin.focusChat";
    this.render();
    this.item.show();
  }

  set(state: State): void {
    this.state = state;
    this.render();
  }

  // CLI version + signed-in account, shown in the hover popover.
  setInfo(info: Info): void {
    this.info = info || {};
    this.render();
  }

  private render(): void {
    this.item.text = this.state.connected ? "$(comment-discussion)" : "$(debug-disconnect)";
    this.item.tooltip = this.buildTooltip();
  }

  // A rich Markdown tooltip acts as the designed popover anchored above the
  // status-bar icon (VS Code has no click-anchored popover API for it).
  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown("**$(comment-discussion) Devin**\n\n");

    if (!this.state.connected) {
      md.appendMarkdown("$(debug-disconnect) Not connected\n\n");
    } else {
      const a = this.info.account || {};
      if (a.name || a.email) {
        md.appendMarkdown(`$(account) **${a.name || a.email}**${a.name && a.email ? `  \n${a.email}` : ""}\n\n`);
      }
      const org = a.plan || a.tier;
      if (org) {
        md.appendMarkdown(`$(organization) ${org}\n\n`);
      }
      const mm = [this.state.model, this.state.mode].filter(Boolean).join("  /  ");
      if (mm) {
        md.appendMarkdown(`$(sparkle) ${mm}\n\n`);
      }
      if (this.info.version) {
        md.appendMarkdown(`$(versions) CLI ${this.info.version}\n\n`);
      }
    }

    md.appendMarkdown("\n---\n\n");
    md.appendMarkdown("[$(link-external) Open Devin Cloud](https://app.devin.ai) &nbsp; ");
    md.appendMarkdown("[$(comment-discussion) Open chat](command:devin.focusChat)");
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
