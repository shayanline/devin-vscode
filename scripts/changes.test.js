// Tests for the working set (src/diff/changeTracker.ts), the one piece of the
// host that touches the user's files. It is loaded outside VS Code through a
// small `vscode` stub (scripts/vscode-stub.js).
//
// The behaviour that matters here is what a file's ORIGINAL text resolves to
// after the change is kept or undone: the diff editor's left hand side reads it
// through the content provider, so dropping it made an accepted change render as
// if the whole file had just been created.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-changes-"));

const outfile = path.join(TMP, "changeTracker.js");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/diff/changeTracker.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error",
  alias: { vscode: path.join(__dirname, "vscode-stub.js") }
});
const { ChangeTracker } = require(outfile);

function write(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}
// What the diff editor's left hand side would show for this path.
function original(tracker, p) {
  return tracker.provideTextDocumentContent({ query: p, fsPath: p });
}

test("keeping a change leaves the diff rendering against the real original", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("kept.ts", "line one\nline two\nline three\n");

  tracker.recordDiff(file, "line one\n", "line one\nline two\nline three\n", "A");
  assert.deepStrictEqual(tracker.pathsFor("A"), [file], "the file is in the session's working set");
  assert.ok(tracker.provideOriginalResource({ fsPath: file }), "and has gutter markers while it awaits review");
  assert.strictEqual(original(tracker, file), "line one\n");

  tracker.accept(file);
  assert.deepStrictEqual(tracker.pathsFor("A"), [], "Keep drops it from the working set");
  assert.deepStrictEqual(tracker.changedPaths(), [], "and from the Source Control group");
  assert.strictEqual(
    tracker.provideOriginalResource({ fsPath: file }),
    undefined,
    "a kept file has nothing left to review, so no gutter markers"
  );
  // The regression: this used to fall back to "", so an open diff drew every
  // line as added, as though Devin had created the file.
  assert.strictEqual(original(tracker, file), "line one\n", "the original text is still what the diff resolves");
  assert.strictEqual(fs.readFileSync(file, "utf8"), "line one\nline two\nline three\n", "Keep does not touch the file");
});

test("undoing a change restores the file and still resolves its original", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("undone.ts", "changed\n");

  tracker.recordDiff(file, "before\n", "changed\n", "A");
  await tracker.reject(file);

  assert.strictEqual(fs.readFileSync(file, "utf8"), "before\n", "Undo puts the original content back");
  assert.deepStrictEqual(tracker.pathsFor("A"), [], "and drops it from the working set");
  assert.strictEqual(original(tracker, file), "before\n", "so an open diff shows no difference, not a new file");
});

test("a file Devin created is deleted by Undo", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = path.join(TMP, "created.ts");
  fs.writeFileSync(file, "brand new\n", "utf8");

  tracker.recordDiff(file, null, "brand new\n", "A");
  assert.strictEqual(original(tracker, file), "", "a created file has no original text");
  await tracker.reject(file);
  assert.strictEqual(fs.existsSync(file), false, "Undo removes it rather than leaving it empty");
});

test("editing a kept file again puts it back in the working set", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("again.ts", "v2\n");

  tracker.recordDiff(file, "v1\n", "v2\n", "A");
  tracker.accept(file);
  assert.deepStrictEqual(tracker.pathsFor("A"), []);

  tracker.recordDiff(file, "v2\n", "v3\n", "A");
  assert.deepStrictEqual(tracker.pathsFor("A"), [file], "the next edit is reviewable again");
  assert.strictEqual(original(tracker, file), "v1\n", "still against what the file was before Devin touched it");
});

test("each session gets its own working set, and a revert forgets only its own", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const mine = write("mine.ts", "mine\n");
  const theirs = write("theirs.ts", "theirs\n");
  const shared = write("shared.ts", "shared\n");

  tracker.recordDiff(mine, "", "mine\n", "A");
  tracker.recordDiff(theirs, "", "theirs\n", "B");
  tracker.recordDiff(shared, "", "shared\n", "A");
  tracker.recordDiff(shared, "shared\n", "shared again\n", "B");

  assert.deepStrictEqual(tracker.pathsFor("A").sort(), [mine, shared].sort(), "A lists only what A changed");
  assert.deepStrictEqual(tracker.pathsFor("B").sort(), [theirs, shared].sort(), "B lists only what B changed");
  assert.strictEqual(tracker.changedPaths().length, 3, "the Source Control view lists every file");
  assert.deepStrictEqual(tracker.pathsFor(undefined), [], "no session means no working set");

  // A revert forgets that chat's files outright, including the one it shared.
  tracker.clearFor("A");
  assert.deepStrictEqual(tracker.pathsFor("A"), []);
  assert.deepStrictEqual(tracker.pathsFor("B"), [theirs], "B keeps its own");
  assert.strictEqual(tracker.hasChange(mine), false, "and nothing of A's is held any more");
});

test("a kept file can still be put back by a checkpoint restore", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("checkpoint.ts", "after\n");

  tracker.recordDiff(file, "before\n", "after\n", "A");
  tracker.accept(file);
  assert.strictEqual(tracker.hasChange(file), true, "the original is still held after Keep");

  await tracker.reject(file);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "before\n", "so a restore can undo a change you had kept");
});
