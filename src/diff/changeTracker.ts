import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface Snapshot {
  original: string | null; // null means the file did not exist before the session
  // Sessions that have edited this file. The original content belongs to the
  // file, but the working set is per session: each chat shows what it changed,
  // and reopening one gets its own files back rather than the last chat's.
  sessions: Set<string>;
  // Kept or undone: out of the working set, but the original text is still held
  // so an open diff keeps rendering against it. Dropping it outright made the
  // left hand side resolve to empty, which drew the whole file as newly added.
  resolved?: boolean;
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

  // QuickDiffProvider: the "original" to diff the working file against. A file
  // whose change has been kept or undone has nothing left to review, so it gets
  // no gutter markers.
  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    const snap = this.snapshots.get(uri.fsPath);
    return snap && !snap.resolved ? this.originalUri(uri.fsPath) : undefined;
  }

  // The original text, including for a resolved file, so a diff the user still
  // has open keeps rendering against what the file really was.
  provideTextDocumentContent(uri: vscode.Uri): string {
    const fsPath = uri.query || uri.fsPath;
    return this.snapshots.get(fsPath)?.original ?? "";
  }

  recordDiff(fsPath: string, oldText: string | null, _newText: string, sessionId: string): void {
    const snap = this.snapshots.get(fsPath);
    if (snap) {
      snap.sessions.add(sessionId);
      // Edited again after being kept or undone: back into the working set,
      // still against the text the file had before Devin first touched it.
      snap.resolved = false;
    } else {
      this.snapshots.set(fsPath, { original: oldText, sessions: new Set([sessionId]) });
    }
    this.contentChanged.fire(this.originalUri(fsPath));
    this.refreshGroup();
  }

  // Every file still awaiting review, whichever chat changed it: what the Source
  // Control view and "Open all" work on.
  changedPaths(): string[] {
    return [...this.snapshots].filter(([, s]) => !s.resolved).map(([p]) => p);
  }

  // What one chat changed and has not resolved, which is its working set.
  pathsFor(sessionId?: string): string[] {
    if (!sessionId) {
      return [];
    }
    return [...this.snapshots].filter(([, s]) => !s.resolved && s.sessions.has(sessionId)).map(([p]) => p);
  }

  // Whether an original is held for this file, kept or undone included: a revert
  // has to be able to put back a change the user had already accepted.
  hasChange(fsPath: string): boolean {
    return this.snapshots.has(fsPath);
  }

  // Forget one chat's files entirely, leaving them on disk as they are (used
  // after a revert, which has already put the files back itself).
  clearFor(sessionId: string): void {
    for (const [p, snap] of [...this.snapshots]) {
      if (!snap.sessions.has(sessionId)) {
        continue;
      }
      this.snapshots.delete(p);
      this.contentChanged.fire(this.originalUri(p));
    }
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

  // Open every tracked change in a single multi-diff editor, falling back to
  // individual diffs if the multi-diff command is unavailable.
  async openAll(): Promise<void> {
    const paths = this.changedPaths();
    if (!paths.length) {
      return;
    }
    const list = paths.map((p) => [vscode.Uri.file(p), this.originalUri(p), vscode.Uri.file(p)]);
    try {
      await vscode.commands.executeCommand("vscode.changes", "Devin Changes", list);
    } catch {
      for (const p of paths) {
        await this.openDiff(p);
      }
    }
  }

  // Keep: leave the current content alone and drop the file from the working
  // set. The original text stays held (see provideTextDocumentContent), and no
  // content change is fired because nothing about the original changed.
  accept(fsPath?: string): void {
    const snap = fsPath ? this.snapshots.get(fsPath) : undefined;
    if (!snap) {
      return;
    }
    snap.resolved = true;
    this.refreshGroup();
  }

  // Undo: restore the original content (or delete the file if it was new), then
  // drop it from the working set. The original stays held so an open diff renders
  // against it, now showing no difference, rather than the whole file as added.
  async reject(fsPath?: string): Promise<void> {
    const snap = fsPath ? this.snapshots.get(fsPath) : undefined;
    if (!fsPath || !snap) {
      return;
    }
    try {
      if (snap.original === null) {
        await fs.promises.rm(fsPath, { force: true });
      } else {
        await fs.promises.writeFile(fsPath, snap.original, "utf8");
      }
    } catch {
      // ignore write failures; still drop from the working set
    }
    snap.resolved = true;
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
    // The exact fsPath is carried in the query (and used for content lookup).
    // The path component is normalised to a valid POSIX-style URI path so a
    // Windows drive path (C:\...) does not produce a malformed URI.
    const uriPath = "/" + fsPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return vscode.Uri.from({ scheme: ChangeTracker.scheme, path: uriPath, query: fsPath });
  }
}

function pathOf(r?: vscode.SourceControlResourceState): string | undefined {
  return r?.resourceUri?.fsPath;
}
