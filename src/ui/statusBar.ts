import * as vscode from "vscode";
import { CliAccount } from "../cli/locate";
import { AccountUsageSnapshot, fetchAccountUsage } from "../cli/accountUsage";
import { acuText } from "../acp/usage";

interface State {
  connected: boolean;
  mode?: string;
  model?: string;
}

interface Info {
  version?: string;
  account?: CliAccount;
  // The environment the agents are spawned with, so the usage read finds the
  // account credentials exactly where the CLI would.
  env?: NodeJS.ProcessEnv;
}

type UsageReader = (env?: NodeJS.ProcessEnv) => Promise<AccountUsageSnapshot>;

// Anything from the CLI or the agent, made safe for a trusted Markdown tooltip: the
// characters that could turn a name into a link, an image or a command, plus the
// newlines that could add a line of their own.
function safe(text?: string): string {
  return String(text ?? "").replace(/[\\`*_[\]()<>#|$]/g, "\\$&").replace(/\s+/g, " ").trim();
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private state: State = { connected: false };
  private info: Info = {};
  private usageEnv?: NodeJS.ProcessEnv;
  private usageEnvKey?: string;
  private usage?: AccountUsageSnapshot;
  private usageError = false;
  private usagePending?: Promise<void>;
  private usagePendingGeneration = 0;
  private usageTimer?: ReturnType<typeof setInterval>;
  private usageGeneration = 0;
  private disposed = false;

  constructor(private readonly usageReader: UsageReader = fetchAccountUsage) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "Devin";
    this.item.command = "devin.showInfo";
    this.render();
    this.item.show();
  }

  set(state: State): void {
    if (this.disposed) {
      return;
    }
    this.state = state;
    this.render();
  }

  // Account and CLI metadata for the hover. Polling starts when the merged CLI environment is first supplied.
  setInfo(info: Info): void {
    if (this.disposed) {
      return;
    }
    this.info = info || {};
    if (this.info.env) {
      this.supplyEnvironment(this.info.env);
    }
    this.render();
  }

  // The bar is shared by every chat surface, so each health check hands its own
  // environment over. An identical one restarts nothing: there is exactly one
  // polling loop no matter how many surfaces ask. A different one means the
  // account or endpoint changed, so the old figures are dropped before the next
  // read rather than being shown under the wrong account.
  private supplyEnvironment(env: NodeJS.ProcessEnv): void {
    if (this.disposed) {
      return;
    }
    // The same variables under a different signed-in account are a different
    // quota, so the CLI account identity is part of the generation key.
    const identity = this.info.account?.email || this.info.account?.name || "";
    const key = identity + "\n" + JSON.stringify(Object.keys(env).sort().map((name) => [name, env[name]]));
    if (key === this.usageEnvKey) {
      return;
    }
    this.usageEnvKey = key;
    this.usageEnv = env;
    this.usageGeneration++;
    this.usage = undefined;
    this.usageError = false;
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
    }
    this.usageTimer = setInterval(() => void this.refreshUsage(), 60_000);
    this.usageTimer.unref?.();
    void this.refreshUsage();
  }

  // One read at a time, whichever trigger asked: the 60s cycle, a finished turn
  // or an environment change. A reply arriving after the environment moved on is
  // discarded so an old account's quota is never shown under the new one.
  refreshUsage(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    // A read started under an earlier environment is not shared: its result is
    // discarded by the generation check anyway, so a new one begins now.
    if (this.usagePending && this.usagePendingGeneration === this.usageGeneration) {
      return this.usagePending;
    }
    const env = this.usageEnv;
    if (!env) {
      return Promise.resolve();
    }
    const generation = this.usageGeneration;
    const pending = (async () => {
      try {
        const snapshot = await this.usageReader(env);
        if (generation !== this.usageGeneration) {
          return;
        }
        // Wholesale replacement: a signed-out or quota-less reply clears the
        // figures instead of leaving the previous account's on screen.
        this.usage = snapshot;
        this.usageError = false;
        this.render();
      } catch {
        if (generation !== this.usageGeneration) {
          return;
        }
        // The last good snapshot stays; the tooltip says it is stale.
        this.usageError = true;
        this.render();
      }
    })();
    this.usagePending = pending;
    this.usagePendingGeneration = generation;
    void pending.finally(() => {
      if (this.usagePending === pending) {
        this.usagePending = undefined;
      }
    });
    return pending;
  }

  // The caller supplies its displayed identity so cached usage retains a different owner.
  getUsageItem(displayedAccount?: CliAccount): vscode.QuickPickItem {
    const item: vscode.QuickPickItem = {
      label: "$(graph) Cycle usage",
      description: this.usageDescription()
    };
    const details = this.usageDetails(displayedAccount);
    if (details.length) {
      item.detail = details.join(" | ");
    }
    return item;
  }

  private usageDescription(): string {
    if (this.usage?.usage) {
      return this.usageText();
    }
    if (this.usage) {
      return "No ACU quota reported";
    }
    if (this.usageError) {
      return "Could not refresh account usage.";
    }
    if (this.usagePending) {
      return "Refreshing account usage.";
    }
    return "Usage has not been reported.";
  }

  private usageText(): string {
    const usage = this.usage?.usage;
    if (!usage) {
      return "";
    }
    if (usage.limit !== undefined) {
      return `${acuText(usage.used, 2)} / ${acuText(usage.limit, 2)} ACU`;
    }
    return `${acuText(usage.used, 2)} ACU used`;
  }

  // A shared name cannot identify the same owner when the emails differ.
  private usageOwner(displayedAccount?: CliAccount): string | undefined {
    const a = this.usage?.account;
    const email = a?.email?.trim();
    const name = a?.name?.trim();
    const owner = email || name;
    if (!owner) {
      return undefined;
    }
    const shownEmail = displayedAccount?.email?.trim();
    const sameEmail = !!email && !!shownEmail && email.toLowerCase() === shownEmail.toLowerCase();
    const sameName = !email && !shownEmail && !!name && name === displayedAccount?.name?.trim();
    if (sameEmail || sameName) {
      return undefined;
    }
    return "Usage for " + owner.replace(/\s+/g, " ");
  }

  private usageDetails(displayedAccount?: CliAccount): string[] {
    const lines: string[] = [];
    const owner = this.usageOwner(displayedAccount);
    if (owner) {
      lines.push(owner);
    }
    const usage = this.usage?.usage;
    if (usage) {
      if (usage.overage && usage.overage > 0) {
        lines.push(`Over the limit by ${acuText(usage.overage, 2)} ACU`);
      } else if (usage.remaining !== undefined) {
        lines.push(`${acuText(usage.remaining, 2)} ACU left`);
      }
    }
    if (this.usage) {
      const when = new Date(this.usage.fetchedAt).toLocaleString();
      lines.push(this.usageError
        ? `Refresh failed. Showing the last report from ${when}`
        : `Last reported ${when}`);
    }
    return lines;
  }

  private render(): void {
    this.item.text = this.state.connected ? "$(chat-sparkle)" : "$(debug-disconnect)";
    this.item.accessibilityInformation = {
      label: `Devin ${this.state.connected ? "connected" : "disconnected"}. Open account usage and shortcuts.`
    };
    this.item.tooltip = this.buildTooltip();
  }

  // Only the chat command link is trusted, so external account metadata still passes through safe().
  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["devin.focusChat"] };
    md.supportThemeIcons = true;
    md.appendMarkdown("**$(chat-sparkle) Devin**\n\n");

    if (!this.state.connected) {
      md.appendMarkdown("$(debug-disconnect) Not connected\n\n");
    }
    const a = this.info.account;
    const displayed = a && (a.name || a.email) ? a : undefined;
    this.appendUsage(md, displayed);

    const lines: string[] = [];
    const name = a?.name?.trim();
    const email = a?.email?.trim();
    if (name || email) {
      const distinct = !!name && !!email && name.toLowerCase() !== email.toLowerCase();
      lines.push(`$(account) **${safe(name || email)}**${distinct ? `  \n${safe(email)}` : ""}`);
    }
    const org = a?.plan || a?.tier;
    if (org) {
      lines.push(`$(organization) ${safe(org)}`);
    }
    md.appendMarkdown("\n---\n\n");
    if (lines.length) {
      md.appendMarkdown(lines.join("  \n") + "\n\n---\n\n");
    }
    md.appendMarkdown("[$(link-external) Open Devin Cloud](https://app.devin.ai) &nbsp; ");
    md.appendMarkdown("[$(comment-discussion) Open chat](command:devin.focusChat)");
    return md;
  }

  private appendUsage(md: vscode.MarkdownString, displayedAccount?: CliAccount): void {
    md.appendMarkdown("$(graph) **Cycle usage**\n\n");
    if (this.usage?.usage) {
      md.appendMarkdown(`**${safe(this.usageText())}**\n\n`);
    } else {
      md.appendMarkdown(`${this.usageDescription()}\n\n`);
    }
    const details = this.usageDetails(displayedAccount);
    if (details.length) {
      const lines = details.map((line, i) => (i === details.length - 1 ? `_${safe(line)}_` : safe(line)));
      md.appendMarkdown(lines.join("  \n") + "\n\n");
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
    }
    this.usageGeneration++;
    this.item.dispose();
  }
}
