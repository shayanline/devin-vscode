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

// The line counting is a pure function, so it is loaded on its own.
const statFile = path.join(TMP, "diffStat.js");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/diff/diffStat.ts")],
  outfile: statFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error"
});
const { diffStat } = require(statFile);

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
  // Reviewing the next edit means reviewing THAT edit: keeping the older text made
  // its diff show every change of the session again, including the kept ones.
  assert.strictEqual(original(tracker, file), "v2\n", "against what was kept, not the whole session");
});

test("opening the same diff twice resolves its original once", async () => {
  // The diff editor's left hand side and the Source Control gutter both want the
  // original, and when they raced to create it VS Code refused the second with
  // "Cannot add model because it already exists" and opened nothing.
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("raced.ts", "after\n");
  tracker.recordDiff(file, "before\n", "after\n", "A");

  globalThis.__dvOpened = [];
  await Promise.all([tracker.openDiff(file), tracker.openDiff(file)]);
  const originals = (globalThis.__dvOpened || []).filter((u) => u.startsWith("devin-original"));
  assert.strictEqual(originals.length, 1, "two clicks, one original: " + JSON.stringify(originals));

  // And it is resolved before the diff is asked for, so nothing else has to.
  assert.ok(originals[0].includes(file.replace(/\\/g, "/")) || originals[0].includes(file));
});

test("the working set survives a window reload, counts and all", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "store-"));
  const store = { scheme: "file", path: dir, fsPath: dir, query: "", toString: () => "file://" + dir };
  const file = write("kept-open.ts", "v2\n");
  const gone = write("deleted-since.ts", "v2\n");

  const before = new ChangeTracker();
  before.register();
  await before.useStore(store);
  before.recordDiff(file, "v1\n", "v2\n", "A", { added: 3, removed: 1 });
  before.recordDiff(gone, "v1\n", "v2\n", "A", { added: 1, removed: 0 });
  // The save is debounced, so give it its moment.
  await new Promise((r) => setTimeout(r, 600));
  fs.rmSync(gone);

  // A new window: the agent is gone, but a change waiting to be reviewed is not.
  const after = new ChangeTracker();
  after.register();
  await after.useStore(store);
  assert.deepStrictEqual(after.pathsFor("A"), [file], "what is still there comes back");
  assert.deepStrictEqual(after.changesFor("A"), [{ path: file, added: 3, removed: 1 }],
    "with its line counts, so the tray is not a list of bare names");
  assert.strictEqual(original(after, file), "v1\n", "and its diff still has a left hand side");

  // Keeping it is remembered too: it must not come back a third time.
  after.accept(file);
  await new Promise((r) => setTimeout(r, 600));
  const last = new ChangeTracker();
  last.register();
  await last.useStore(store);
  assert.deepStrictEqual(last.pathsFor("A"), [], "a change already dealt with stays dealt with");
});

test("a one line change in a large file is counted, and counted quickly", async () => {
  // The count ran a full table over both sides, so replaying a session's worth of
  // edits was seconds of work. Trimming what the two sides share at each end makes
  // it proportional to the change rather than to the file.
  const big = Array.from({ length: 20000 }, (_, i) => "line " + i).join("\n");
  const edited = big.replace("line 9000", "line 9000 changed");
  const started = Date.now();
  assert.deepStrictEqual(diffStat(big, edited), { added: 1, removed: 1 });
  assert.ok(Date.now() - started < 250, "and does not take seconds over it");

  // The plain cases still hold.
  assert.deepStrictEqual(diffStat(null, "a\nb\n"), { added: 3, removed: 0 }, "a new file is all additions");
  assert.deepStrictEqual(diffStat("a\nb\n", ""), { added: 0, removed: 3 }, "an emptied one is all removals");
  assert.deepStrictEqual(diffStat("a\nb\n", "a\nb\n"), { added: 0, removed: 0 }, "no change, no counts");
  assert.deepStrictEqual(diffStat("a\nb\nc\n", "a\nx\ny\nc\n"), { added: 2, removed: 1 });
});

test("a CRLF file rewritten with LF is not counted as every line changed", async () => {
  assert.deepStrictEqual(
    diffStat("a\r\nb\r\nc\r\n", "a\nb\nc\n"),
    { added: 0, removed: 0 },
    "the endings are not the change"
  );
  assert.deepStrictEqual(diffStat("a\r\nb\r\nc\r\n", "a\nx\nc\n"), { added: 1, removed: 1 }, "only the line that changed");
});

test("an edit row opens what that edit did, not the whole file", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("twice.ts", "one\ntwo\nthree\n");

  // Two turns touching the same file: the working set spans both, each row only
  // its own.
  tracker.recordEdit("turn1", file, "one\n", "one\ntwo\n");
  tracker.recordDiff(file, "one\n", "one\ntwo\n", "A");
  tracker.recordEdit("turn2", file, "one\ntwo\n", "one\ntwo\nthree\n");
  tracker.recordDiff(file, "one\ntwo\n", "one\ntwo\nthree\n", "A");

  const read = (id, side) =>
    tracker.provideTextDocumentContent({ scheme: "devin-edit", query: id + "\u0000" + side, fsPath: file });
  assert.strictEqual(read("turn2", "before"), "one\ntwo\n", "the second row starts where the first left off");
  assert.strictEqual(read("turn2", "after"), "one\ntwo\nthree\n");
  assert.strictEqual(read("turn1", "before"), "one\n", "and the first still shows its own");

  globalThis.__dvOpened = [];
  await tracker.openEdit("turn2", file);
  assert.ok(
    (globalThis.__dvOpened || []).some((u) => u.startsWith("devin-edit")),
    "the row opens its own two sides: " + JSON.stringify(globalThis.__dvOpened)
  );
  // The working set is still the whole change, which is what the tray opens.
  assert.strictEqual(original(tracker, file), "one\n");

  // An edit whose text is no longer held falls back to the file's own diff.
  globalThis.__dvOpened = [];
  await tracker.openEdit("forgotten", file);
  assert.ok((globalThis.__dvOpened || []).some((u) => u.startsWith("devin-original")));
});

test("a file is the same file however its path is spelled", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("spelled.ts", "after\n");
  // What the agent reports and what VS Code hands back from a URI are the same
  // file written two ways: an unresolved path, and (on Windows) another casing.
  const roundabout = path.join(TMP, ".", "spelled.ts");

  tracker.recordDiff(file, "before\n", "after\n", "A");
  assert.strictEqual(tracker.hasUnresolvedChange(roundabout), true, "it is found by either spelling");
  assert.ok(tracker.provideOriginalResource({ fsPath: roundabout }), "and keeps its gutter markers");
  assert.deepStrictEqual(tracker.pathsFor("A"), [file], "the working set keeps the path as it was reported");

  await tracker.reject(roundabout);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "before\n", "and Undo puts the one file back");
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
  assert.strictEqual(tracker.hasUnresolvedChange(mine), false, "and nothing of A's is held any more");
});

test("a rewind only forgets the files it really put back", async () => {
  // The agent's revert reports a file plan that is empty even for files it edited
  // through us, and its own rewind leaves the disk alone. So forgetting the whole
  // chat would strand the edits on disk with no way left to undo them.
  const tracker = new ChangeTracker();
  tracker.register();
  const putBack = write("restored.ts", "agent wrote this\n");
  const stillThere = write("untouched.ts", "agent wrote this too\n");

  tracker.recordDiff(putBack, "original\n", "agent wrote this\n", "A");
  tracker.recordDiff(stillThere, "original\n", "agent wrote this too\n", "A");

  tracker.clearFor("A", [putBack]);

  assert.deepStrictEqual(tracker.pathsFor("A"), [stillThere],
    "the file the rewind did not touch stays reviewable");
  assert.strictEqual(tracker.hasUnresolvedChange(putBack), false, "the restored one is done with");
  assert.strictEqual(tracker.hasUnresolvedChange(stillThere), true, "and the other can still be undone");

  // Undoing it afterwards still works, which is the whole point of keeping it.
  await tracker.reject(stillThere);
  assert.strictEqual(fs.readFileSync(stillThere, "utf8"), "original\n");
});

test("a kept file is no longer offered for review, but can still be put back", async () => {
  const tracker = new ChangeTracker();
  tracker.register();
  const file = write("checkpoint.ts", "after\n");

  tracker.recordDiff(file, "before\n", "after\n", "A");
  tracker.accept(file);
  // A revert asks this before winding a file back itself. A kept file must answer
  // no: its snapshot is the text from before Devin first touched it, which is older
  // than any checkpoint taken since, so the agent's own plan is the accurate one.
  assert.strictEqual(tracker.hasUnresolvedChange(file), false, "Keep settles the review");

  // The original text is still held, so an explicit undo still restores it.
  await tracker.reject(file);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "before\n", "and an undo still restores it");
});
