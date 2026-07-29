import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface Snapshot {
  original: string | null; // null means the file did not exist before the session
}

// Tracks agent file edits so the user can review them as native diffs and
// accept or reject them. Uses a QuickDiffProvider so the editor shows gutter
// change markers with inline per-hunk "Revert Change" actions for free, plus a
// Source Control group that acts as the working set (accept/reject per file).
export class ChangeTracker
  implements vscode.TextDocumentContentProvider, vscode.QuickDiffProvider
{
  static readonly scheme = "devin-original";

  private readonly snapshots = new Map<string, Snapshot>();
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly listChanged = new vscode.EventEmitter<string[]>();

  readonly onDidChange = this.contentChanged.event;
  readonly onDidChangeList = this.listChanged.event;

  private scm?: vscode.SourceControl;
  private group?: vscode.SourceControlResourceGroup;

  register(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ChangeTracker.scheme, this)
    );

    this.scm = vscode.scm.createSourceControl("devin", "Devin");
    this.scm.quickDiffProvider = this;
    this.group = this.scm.createResourceGroup("devinChanges", "Devin Changes");
    disposables.push(this.scm);

    disposables.push(
      vscode.commands.registerCommand("devin.acceptChange", (r?: vscode.SourceControlResourceState) =>
        this.accept(pathOf(r))
      ),
      vscode.commands.registerCommand("devin.rejectChange", (r?: vscode.SourceControlResourceState) =>
        this.reject(pathOf(r))
      ),
      vscode.commands.registerCommand("devin.acceptAllChanges", () => this.acceptAll()),
      vscode.commands.registerCommand("devin.rejectAllChanges", () => this.rejectAll()),
      vscode.commands.registerCommand("devin.openChangeDiff", (r?: vscode.SourceControlResourceState) =>
        this.openDiff(pathOf(r))
      )
    );

    return vscode.Disposable.from(...disposables);
  }

  // QuickDiffProvider: the "original" to diff the working file against.
  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    return this.snapshots.has(uri.fsPath) ? this.originalUri(uri.fsPath) : undefined;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const fsPath = uri.query || uri.fsPath;
    return this.snapshots.get(fsPath)?.original ?? "";
  }

  recordDiff(fsPath: string, oldText: string | null, _newText: string): void {
    if (!this.snapshots.has(fsPath)) {
      this.snapshots.set(fsPath, { original: oldText });
    }
    this.contentChanged.fire(this.originalUri(fsPath));
    this.refreshGroup();
  }

  changedPaths(): string[] {
    return [...this.snapshots.keys()];
  }

  clear(): void {
    this.snapshots.clear();
    this.refreshGroup();
  }

  async openDiff(fsPath?: string): Promise<void> {
    if (!fsPath) {
      return;
    }
    const left = this.originalUri(fsPath);
    const right = vscode.Uri.file(fsPath);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(fsPath)} (Devin)`);
  }

  // Accept: keep the current content, stop tracking the file.
  accept(fsPath?: string): void {
    if (!fsPath) {
      return;
    }
    this.snapshots.delete(fsPath);
    this.contentChanged.fire(this.originalUri(fsPath));
    this.refreshGroup();
  }

  // Reject: restore the original content (or delete the file if it was new).
  async reject(fsPath?: string): Promise<void> {
    if (!fsPath) {
      return;
    }
    const snap = this.snapshots.get(fsPath);
    if (snap) {
      try {
        if (snap.original === null) {
          await fs.promises.rm(fsPath, { force: true });
        } else {
          await fs.promises.writeFile(fsPath, snap.original, "utf8");
        }
      } catch {
        // ignore write failures; still drop from the working set
      }
    }
    this.snapshots.delete(fsPath);
    this.contentChanged.fire(this.originalUri(fsPath));
    this.refreshGroup();
  }

  acceptAll(): void {
    for (const p of this.changedPaths()) {
      this.accept(p);
    }
  }

  async rejectAll(): Promise<void> {
    for (const p of this.changedPaths()) {
      await this.reject(p);
    }
  }

  private refreshGroup(): void {
    if (!this.group) {
      return;
    }
    this.group.resourceStates = this.changedPaths().map((p) => ({
      resourceUri: vscode.Uri.file(p),
      command: {
        command: "devin.openChangeDiff",
        title: "Open Diff",
        arguments: [{ resourceUri: vscode.Uri.file(p) }]
      },
      decorations: { tooltip: "Changed by Devin" }
    }));
    this.listChanged.fire(this.changedPaths());
  }

  private originalUri(fsPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ChangeTracker.scheme, path: fsPath, query: fsPath });
  }
}

function pathOf(r?: vscode.SourceControlResourceState): string | undefined {
  return r?.resourceUri?.fsPath;
}
