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
  // Lines the change added and removed, so the working set can say so without
  // waiting for the edit to be reported again.
  added?: number;
  removed?: number;
}

// One file as it is written to disk, so a window reload does not forget what is
// waiting to be reviewed.
interface StoredSnapshot {
  path: string;
  original: string | null;
  sessions: string[];
  resolved?: boolean;
  added?: number;
  removed?: number;
}

// Past this the working set is not written out. A handful of edited files is
// kilobytes; a repository's worth of generated output is not worth carrying
// across a reload.
const MAX_STORE_BYTES = 8 * 1024 * 1024;

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
  // A change was kept or undone, wherever from: the chat, the Source Control view
  // or a command. The chat listens so the edit it drew says so, whichever surface
  // resolved it.
  private readonly resolved = new vscode.EventEmitter<{ paths: string[]; action: "accept" | "reject" }>();

  readonly onDidChange = this.contentChanged.event;
  readonly onDidChangeList = this.listChanged.event;
  readonly onDidResolve = this.resolved.event;

  private scm?: vscode.SourceControl;
  private group?: vscode.SourceControlResourceGroup;

  // Where the working set is kept between windows. A `devin acp` agent cannot
  // outlive the extension host, but a change waiting to be reviewed has nothing to
  // do with the agent: forgetting it on a reload lost the diffs and left Keep and
  // Undo with nothing to act on, so the next edit looked like a brand new set.
  private store?: vscode.Uri;
  private saveTimer?: NodeJS.Timeout;

  async useStore(dir: vscode.Uri | undefined): Promise<void> {
    if (!dir) {
      return;
    }
    this.store = vscode.Uri.joinPath(dir, "changes.json");
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.store)).toString("utf8");
      const parsed = JSON.parse(raw) as StoredSnapshot[];
      for (const s of Array.isArray(parsed) ? parsed : []) {
        // A file that has since gone is nothing to review, and a change with no
        // session behind it can never be shown in a chat.
        if (!s || !s.path || !Array.isArray(s.sessions) || !s.sessions.length) {
          continue;
        }
        if (s.original !== null && !fs.existsSync(s.path)) {
          continue;
        }
        this.snapshots.set(s.path, {
          original: s.original ?? null,
          sessions: new Set(s.sessions),
          resolved: s.resolved,
          added: s.added,
          removed: s.removed
        });
      }
    } catch {
      // Nothing kept, or it is unreadable: start with an empty working set.
    }
    this.refreshGroup();
  }

  private scheduleSave(): void {
    if (!this.store || this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 400);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    if (!this.store) {
      return;
    }
    const out: StoredSnapshot[] = [...this.snapshots]
      .filter(([, s]) => !s.resolved)
      .map(([p, s]) => ({
        path: p,
        original: s.original,
        sessions: [...s.sessions],
        added: s.added,
        removed: s.removed
      }));
    try {
      if (!out.length) {
        await vscode.workspace.fs.delete(this.store);
        return;
      }
      const body = Buffer.from(JSON.stringify(out), "utf8");
      if (body.byteLength > MAX_STORE_BYTES) {
        return;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.store, ".."));
      await vscode.workspace.fs.writeFile(this.store, body);
    } catch {
      // Nothing to delete, or the storage is not writable: the working set is
      // still correct in this window, it just will not survive a reload.
    }
  }

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

  recordDiff(fsPath: string, oldText: string | null, newText: string, sessionId: string, stat?: { added: number; removed: number }): void {
    const snap = this.snapshots.get(fsPath);
    if (snap) {
      snap.added = stat?.added;
      snap.removed = stat?.removed;
      snap.sessions.add(sessionId);
      if (snap.resolved) {
        // Kept or undone, and now edited again. The review starts from what was
        // kept, not from what the file was before Devin first touched it: keeping
        // the older text made the next diff show every change of the session over
        // again, including the ones already dealt with. `oldText` is what the file
        // held immediately before this edit, which is exactly that baseline.
        snap.original = oldText;
        snap.resolved = false;
      }
    } else {
      this.snapshots.set(fsPath, {
        original: oldText,
        sessions: new Set([sessionId]),
        added: stat?.added,
        removed: stat?.removed
      });
    }
    void newText;
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

  // What one chat changed, with the line counts, so a working set restored after a
  // reload arrives complete rather than as bare names.
  changesFor(sessionId?: string): { path: string; added?: number; removed?: number }[] {
    return this.pathsFor(sessionId).map((p) => {
      const s = this.snapshots.get(p);
      return { path: p, added: s?.added, removed: s?.removed };
    });
  }

  // Whether this file is still awaiting review. A kept or undone one is excluded:
  // its snapshot holds the text from before Devin first touched the file, which is
  // older than any checkpoint taken since, so a revert must use the agent's own
  // plan for it rather than winding the file all the way back.
  hasUnresolvedChange(fsPath: string): boolean {
    const snap = this.snapshots.get(fsPath);
    return !!snap && !snap.resolved;
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
    this.resolved.fire({ paths: [fsPath as string], action: "accept" });
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
    this.resolved.fire({ paths: [fsPath], action: "reject" });
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
    this.scheduleSave();
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
