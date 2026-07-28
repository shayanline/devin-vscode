import * as vscode from "vscode";

// Tracks file changes made by the agent during a session so the user can
// review them as native VS Code diffs (original snapshot vs current on disk).
export class ChangeTracker implements vscode.TextDocumentContentProvider {
  static readonly scheme = "devin-original";

  private readonly originals = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  register(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(ChangeTracker.scheme, this);
  }

  // Records the original content the first time a path is touched, so later
  // writes still diff against the pre-session state.
  recordDiff(fsPath: string, oldText: string | null, _newText: string): void {
    if (!this.originals.has(fsPath)) {
      this.originals.set(fsPath, oldText ?? "");
    }
    this.emitter.fire(this.originalUri(fsPath));
  }

  changedPaths(): string[] {
    return [...this.originals.keys()];
  }

  clear(): void {
    this.originals.clear();
  }

  async openDiff(fsPath: string): Promise<void> {
    if (!fsPath) {
      return;
    }
    const left = this.originalUri(fsPath);
    const right = vscode.Uri.file(fsPath);
    const title = `${basename(fsPath)} (Devin changes)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const fsPath = uri.query || uri.fsPath;
    return this.originals.get(fsPath) ?? "";
  }

  private originalUri(fsPath: string): vscode.Uri {
    // Encode the real path in the query so the scheme stays clean.
    return vscode.Uri.from({ scheme: ChangeTracker.scheme, path: fsPath, query: fsPath });
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
