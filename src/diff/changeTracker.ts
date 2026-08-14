import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

interface Snapshot {
  // The file as it was named when it was first recorded. The map is keyed on a
  // normalised form of it (see `key`), so this is the one to show and write to.
  path: string;
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

// The same file arrives written two ways: as the agent wrote it, and as VS Code
// hands it back from a URI (which lower cases a Windows drive letter and always
// uses backslashes). One key for both, so a lookup finds what was recorded.
// One file, one entry, whatever it was called on the way in. Two spellings of the
// same file made two working set rows and two originals, and undoing them in order
// wrote the older text over the newer content.
const realNames = new Map<string, string>();

function key(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  const known = realNames.get(resolved);
  if (known) {
    return known;
  }
  let real = resolved;
  let answered = false;
  try {
    // What the filesystem itself calls it: the on-disk spelling on a case
    // insensitive volume, which macOS is by default, and one name for a file reached
    // through a symlinked directory.
    real = fs.realpathSync.native(resolved);
    answered = true;
  } catch {
    // Not there, so the resolved path is the best name available.
  }
  const folded = process.platform === "win32" ? real.toLowerCase() : real;
  // The finished key is what gets cached, not the step before it: caching the
  // unfolded path meant the second lookup of a file answered differently from the
  // first, so on Windows an undo went looking for a snapshot that was filed under
  // another name and quietly did nothing. Only cached once the filesystem answered,
  // so a file that does not exist yet is not pinned to the name it was guessed by.
  if (answered && realNames.size < 2000) {
    realNames.set(resolved, folded);
  }
  return folded;
}

// Tracks agent file edits so the user can review them as native diffs and
// accept or reject them. Uses a QuickDiffProvider so the editor shows gutter
// change markers with inline per-hunk "Revert Change" actions for free, plus a
// Source Control group that acts as the working set (accept/reject per file).
export class ChangeTracker
  implements vscode.TextDocumentContentProvider, vscode.QuickDiffProvider
{
  static readonly scheme = "devin-original";
  // Either side of a single edit, so an edit row can show just what it did.
  static readonly editScheme = "devin-edit";

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
  // Originals being resolved right now, so two clicks do not race each other to
  // create the same model.
  private readonly warming = new Map<string, Promise<void>>();
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
        this.snapshots.set(key(s.path), {
          path: s.path,
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
    const out: StoredSnapshot[] = [...this.snapshots.values()]
      .filter((s) => !s.resolved)
      .map((s) => ({
        path: s.path,
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
        // Too big to keep, and a stale file would restore older originals than the
        // ones held now, so it goes rather than being left behind.
        await vscode.workspace.fs.delete(this.store).then(undefined, () => undefined);
        return;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.store, ".."));
      // Beside it, then over it: this file is the only copy of the text every
      // pending undo would restore, so a half written one loses all of them.
      // Named for this process: two windows on one workspace share the storage
      // directory, and a shared scratch name lets one window's write land inside
      // another's, renaming a corrupt file into place and losing every original.
      const tmp = this.store.with({ path: `${this.store.path}.${process.pid}.tmp` });
      await vscode.workspace.fs.writeFile(tmp, body);
      await vscode.workspace.fs.rename(tmp, this.store, { overwrite: true });
    } catch {
      // Nothing to delete, or the storage is not writable: the working set is
      // still correct in this window, it just will not survive a reload.
    }
  }

  register(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ChangeTracker.scheme, this),
      vscode.workspace.registerTextDocumentContentProvider(ChangeTracker.editScheme, this)
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
    const snap = this.snapshots.get(key(uri.fsPath));
    return snap && !snap.resolved ? this.originalUri(snap.path) : undefined;
  }

  // The original text, including for a resolved file, so a diff the user still
  // has open keeps rendering against what the file really was, and either side
  // of a single edit, for the diff an edit row opens.
  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme === ChangeTracker.editScheme) {
      const [id, side] = uri.query.split("\u0000");
      const edit = this.edits.get(id);
      return (side === "after" ? edit?.after : edit?.before) ?? "";
    }
    return this.snapshots.get(key(uri.query || uri.fsPath))?.original ?? "";
  }

  // --- One edit's own diff ---------------------------------------------------

  // What a single edit did, as opposed to what the file is still holding: the
  // working set answers "what has Devin changed here", an edit row answers "what
  // did this change do". Keyed by the row that reports it, and capped: this is
  // two copies of a file's text per edit, kept only to show a diff nobody has to
  // ask for twice.
  private readonly edits = new Map<string, { path: string; before: string; after: string }>();
  private editBytes = 0;
  private static readonly MAX_EDIT_BYTES = 8 * 1024 * 1024;

  // Extend the edit under `id` (the first call sets what it started from, later
  // ones move its end), so a row that reports a file several times still opens
  // everything that row stands for.
  recordEdit(id: string, fsPath: string, before: string | null, after: string): void {
    const existing = this.edits.get(id);
    if (existing) {
      this.editBytes += after.length - existing.after.length;
      existing.after = after;
    } else {
      this.edits.set(id, { path: fsPath, before: before ?? "", after });
      this.editBytes += (before?.length ?? 0) + after.length;
    }
    for (const [k, e] of this.edits) {
      if (this.editBytes <= ChangeTracker.MAX_EDIT_BYTES) {
        break;
      }
      this.edits.delete(k);
      this.editBytes -= e.before.length + e.after.length;
    }
  }

  // Open what one edit did. Falls back to the file's working set diff when the
  // text behind it has been dropped (a reloaded transcript, or a long session).
  async openEdit(id: string, fsPath?: string): Promise<void> {
    const edit = this.edits.get(id);
    if (!edit) {
      await this.openDiff(fsPath);
      return;
    }
    const side = (s: "before" | "after") =>
      vscode.Uri.from({
        scheme: ChangeTracker.editScheme,
        path: "/" + edit.path.replace(/\\/g, "/").replace(/^\/+/, ""),
        query: `${id}\u0000${s}`
      });
    const left = side("before");
    await this.warmOriginal(left);
    await vscode.commands.executeCommand("vscode.diff", left, side("after"), `${path.basename(edit.path)} (this edit)`);
  }

  recordDiff(fsPath: string, oldText: string | null, newText: string, sessionId: string, stat?: { added: number; removed: number }): void {
    const snap = this.snapshots.get(key(fsPath));
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
      this.snapshots.set(key(fsPath), {
        path: fsPath,
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
    return [...this.snapshots.values()].filter((s) => !s.resolved).map((s) => s.path);
  }

  // What one chat changed and has not resolved, which is its working set.
  pathsFor(sessionId?: string): string[] {
    return this.unresolvedFor(sessionId).map((s) => s.path);
  }

  // What one chat changed, with the line counts, so a working set restored after a
  // reload arrives complete rather than as bare names.
  changesFor(sessionId?: string): { path: string; added?: number; removed?: number }[] {
    return this.unresolvedFor(sessionId).map((s) => ({ path: s.path, added: s.added, removed: s.removed }));
  }

  private unresolvedFor(sessionId?: string): Snapshot[] {
    if (!sessionId) {
      return [];
    }
    return [...this.snapshots.values()].filter((s) => !s.resolved && s.sessions.has(sessionId));
  }

  // Whether this file is still awaiting review. A kept or undone one is excluded:
  // its snapshot holds the text from before Devin first touched the file, which is
  // older than any checkpoint taken since, so a revert must use the agent's own
  // plan for it rather than winding the file all the way back.
  hasUnresolvedChange(fsPath: string): boolean {
    const snap = this.snapshots.get(key(fsPath));
    return !!snap && !snap.resolved;
  }

  // Forget files this chat changed, leaving them on disk as they are. `paths`
  // limits it to the ones a revert actually put back: anything else is still on
  // disk holding the agent's content, and dropping it would take away the only
  // way left to undo it.
  clearFor(sessionId: string, paths?: string[]): void {
    const only = paths ? new Set(paths.map((p) => key(p))) : undefined;
    for (const [k, snap] of [...this.snapshots]) {
      if (!snap.sessions.has(sessionId) || (only && !only.has(k))) {
        continue;
      }
      this.snapshots.delete(k);
      this.contentChanged.fire(this.originalUri(snap.path));
    }
    this.refreshGroup();
  }

  async openDiff(fsPath?: string): Promise<void> {
    if (!fsPath) {
      return;
    }
    const left = this.originalUri(fsPath);
    const right = vscode.Uri.file(fsPath);
    await this.warmOriginal(left);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(fsPath)} (Devin)`);
  }

  // Resolve the original once, before anything else asks for it. The diff
  // editor's left hand side and the Source Control gutter both want this same
  // document, and when they ask at the same moment each finds no model and each
  // sets out to make one, so the second is told it already exists and the editor
  // fails to open. Opening it here, and waiting, means both find one waiting.
  private async warmOriginal(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const inflight = this.warming.get(key);
    if (inflight) {
      await inflight;
      return;
    }
    const p = Promise.resolve(vscode.workspace.openTextDocument(uri)).then(
      () => undefined,
      () => undefined
    );
    this.warming.set(key, p);
    try {
      await p;
    } finally {
      this.warming.delete(key);
    }
  }

  // Open every tracked change in a single multi-diff editor, falling back to
  // individual diffs if the multi-diff command is unavailable.
  async openAll(): Promise<void> {
    const paths = this.changedPaths();
    if (!paths.length) {
      return;
    }
    await Promise.all(paths.map((p) => this.warmOriginal(this.originalUri(p))));
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
    const snap = fsPath ? this.snapshots.get(key(fsPath)) : undefined;
    if (!snap) {
      return;
    }
    snap.resolved = true;
    this.resolved.fire({ paths: [snap.path], action: "accept" });
    this.refreshGroup();
  }

  // Undo: restore the original content (or delete the file if it was new), then
  // drop it from the working set. The original stays held so an open diff renders
  // against it, now showing no difference, rather than the whole file as added.
  // Answers whether the file really was put back, so a caller that goes on to
  // forget it does not forget one that is still holding the agent's content.
  async reject(fsPath?: string): Promise<boolean> {
    const snap = fsPath ? this.snapshots.get(key(fsPath)) : undefined;
    if (!snap) {
      return false;
    }
    try {
      if (snap.original === null) {
        await fs.promises.rm(snap.path, { force: true });
      } else {
        await fs.promises.writeFile(snap.path, snap.original, "utf8");
      }
    } catch (err) {
      // A read only file, a lock held by another process, a directory that has
      // since gone. Resolving anyway would drop the original from the working set
      // and from the store, leaving the agent's content in place with nothing left
      // to put back, and the row saying it had been undone. So say so and keep it.
      void vscode.window.showErrorMessage(
        `Couldn't undo ${path.basename(snap.path)}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    snap.resolved = true;
    this.resolved.fire({ paths: [snap.path], action: "reject" });
    this.refreshGroup();
    return true;
  }

  // With a session, only that chat's files: the tray these come from says "N
  // changed files" for one chat, and another chat's edits are not the user's to
  // lose from a button they cannot see. Without one, everything, which is what the
  // Source Control title actions mean.
  acceptAll(sessionId?: string): void {
    for (const p of this.bulkPaths(sessionId)) {
      this.accept(p);
    }
  }

  async rejectAll(sessionId?: string): Promise<void> {
    for (const p of this.bulkPaths(sessionId)) {
      await this.reject(p);
    }
  }

  // What a bulk action from one chat may touch. A file is held once, with one
  // original, from before whichever chat edited it first, so a file two chats have
  // both edited cannot be undone for one of them: writing that original back would
  // discard the other chat's later work, from a button in a tray that does not
  // mention it. Those are left alone and named, so the decision is the user's.
  private bulkPaths(sessionId?: string): string[] {
    if (!sessionId) {
      return this.changedPaths();
    }
    const mine: string[] = [];
    const shared: string[] = [];
    for (const snap of this.unresolvedFor(sessionId)) {
      (snap.sessions.size > 1 ? shared : mine).push(snap.path);
    }
    if (shared.length) {
      void vscode.window.showWarningMessage(
        shared.length === 1
          ? `${path.basename(shared[0])} was also changed by another chat, so it was left alone. Keep or undo it from its own row.`
          : `${shared.length} files were also changed by another chat, so they were left alone.`
      );
    }
    return mine;
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
