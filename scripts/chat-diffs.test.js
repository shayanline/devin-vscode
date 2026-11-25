// Regressions for tool diff fragments being mistaken for complete file snapshots.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createChat, cleanup } = require("./chat-harness");
const { createHarness } = require("./webview-harness");

const posixOnly = { skip: process.platform === "win32" };
const oldText = "beforeEach(() => {\n  localStorage.clear();\n});";
const newText = "beforeEach(() => {\n  localStorage.clear();\n  const height = 400;\n  Object.defineProperty(HTMLElement.prototype, \"clientHeight\", {\n    get: () => height\n  });\n});";
const prefix = "import { beforeEach, test } from \"vitest\";\n\n";
const suffix = "\n\ntest(\"resume\", () => {});\n";
const before = prefix + oldText + suffix;
const after = prefix + newText + suffix;

test.after(() => cleanup());

async function editedFile(t, page) {
  const h = createChat();
  t.after(() => h.dispose());
  if (page) {
    const post = h.webview.postMessage.bind(h.webview);
    h.webview.postMessage = (message) => {
      const result = post(message);
      page.post(message);
      return result;
    };
    const push = page.posted.push.bind(page.posted);
    page.posted.push = (...messages) => {
      const result = push(...messages);
      for (const message of messages) queueMicrotask(() => h.send(message));
      return result;
    };
  }
  await h.ready();
  const sessionId = await h.startChat("update the resume test");
  const file = path.join(h.cwd, "resume.test.tsx");
  fs.writeFileSync(file, before);
  const rt = h.controller.runtimes.get(sessionId);
  const notify = (sessionUpdate, diff = { oldText, newText }, operation = "edit-resume") => rt.client.emit("update", {
    sessionId,
    update: {
      sessionUpdate,
      toolCallId: operation,
      kind: "edit",
      status: sessionUpdate === "tool_call" ? "in_progress" : "completed",
      content: [{ type: "diff", path: file, ...diff }]
    }
  });
  const write = (content = after, operation = "edit-resume") => h.controller.writeTextFile({
    sessionId, path: file, content, _meta: { "cognition.ai/toolCallId": operation }
  });
  const read = (uri) => uri.scheme === "file"
    ? fs.readFileSync(uri.fsPath, "utf8")
    : h.changes.provideTextDocumentContent(uri);
  const diffs = [];
  t.mock.method(globalThis.__dvVscode.commands, "executeCommand", async (command, ...args) => {
    if (command === "vscode.diff") diffs.push(args);
  });
  const open = async (editId) => {
    await h.webview._handler({ type: "openDiff", path: file, editId });
    const [left, right] = diffs.at(-1);
    return [read(left), read(right)];
  };
  return { h, rt, file, notify, write, open };
}

for (const previewFirst of [true, false]) {
  test(`diff fragments ${previewFirst ? "before" : "after"} a write preserve both complete diff sides`, posixOnly, async (t) => {
    const { h, file, notify, write, open } = await editedFile(t);
    if (previewFirst) notify("tool_call");
    await write();
    notify("tool_call_update");

    assert.deepStrictEqual(await open(), [before, after], "the changed file compares complete file contents");
    assert.deepStrictEqual(await open(h.last("fileChange").editId), [before, after],
      "the edit row also compares complete file contents");
    assert.strictEqual(fs.readFileSync(file, "utf8"), after, "reviewing does not modify the file");
  });
}

test("Undo restores the complete file after a fragment preview and completion", posixOnly, async (t) => {
  const { h, file, notify, write } = await editedFile(t);
  const warning = t.mock.method(globalThis.__dvVscode.window, "showWarningMessage", async () => undefined);
  notify("tool_call");
  await write();
  notify("tool_call_update");

  assert.strictEqual(await h.changes.reject(file), true);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before, "Undo keeps the imports and unchanged tests");
  assert.strictEqual(warning.mock.callCount(), 0, "a reported fragment is not mistaken for later user edits");
});

test("an edit after Keep starts from the last complete file", posixOnly, async (t) => {
  const { h, file, notify, write, open } = await editedFile(t);
  notify("tool_call");
  await write();
  notify("tool_call_update");
  h.changes.accept(file);

  const next = after.replace("400", "500");
  const diff = { oldText: "const height = 400;", newText: "const height = 500;" };
  notify("tool_call", diff, "edit-again");
  await write(next, "edit-again");
  notify("tool_call_update", diff, "edit-again");

  assert.deepStrictEqual(await open(), [after, next], "the next review excludes the changes already kept");
  assert.deepStrictEqual(await open(h.last("fileChange").editId), [after, next]);
  assert.strictEqual(await h.changes.reject(file), true);
  assert.strictEqual(fs.readFileSync(file, "utf8"), after, "Undo preserves the changes already kept");
});

test("a tool preview cannot create a snapshot when the file write fails", posixOnly, async (t) => {
  const { h, file, notify, write } = await editedFile(t);
  const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
  fs.writeFileSync(file, bytes);
  notify("tool_call");

  await assert.rejects(write(), /not UTF-8/);
  assert.deepStrictEqual(h.changes.changedPaths(), [], "a failed write leaves nothing to keep or undo");
  assert.deepStrictEqual(fs.readFileSync(file), bytes, "the original bytes remain intact");
});

test("separate operations on one file in one turn keep separate clickable diffs", posixOnly, async (t) => {
  const page = createHarness();
  t.after(() => page.window.close());
  const { h, rt, notify, write, open } = await editedFile(t, page);
  const turn = rt.turnCount;
  notify("tool_call");
  await write();
  notify("tool_call_update");
  const firstId = h.last("fileChange").editId;

  const next = after.replace("400", "500");
  const diff = { oldText: "const height = 400;", newText: "const height = 500;" };
  notify("tool_call", diff, "edit-height");
  await write(next, "edit-height");
  notify("tool_call_update", diff, "edit-height");
  const secondId = h.last("fileChange").editId;
  notify("tool_call_update");

  assert.strictEqual(rt.turnCount, turn, "both operations happen in the same conversation turn");
  assert.notStrictEqual(firstId, secondId);
  assert.deepStrictEqual(await open(firstId), [before, after], "the earlier operation keeps its own final content");
  assert.deepStrictEqual(await open(secondId), [after, next], "the later operation starts after the earlier one");
  assert.deepStrictEqual(await open(), [before, next], "the changed file list remains cumulative");

  const rows = [...page.thread().querySelectorAll(".edit-pill")];
  assert.strictEqual(rows.length, 2, "repeated tool notifications update their own operation rows");
  assert.strictEqual(rows[0].dataset.editId, firstId);
  assert.strictEqual(rows[1].dataset.editId, secondId);
  assert.strictEqual(rows[0].querySelector(".edit-pill-actions"), null, "late reports cannot revive older file actions");
  assert.ok(rows[1].querySelector(".edit-pill-actions"), "the latest operation offers the file actions");
  for (const [row, editId] of [[rows[0], firstId], [rows[1], secondId]]) {
    row.querySelector(".file-pill").click();
    assert.deepStrictEqual(page.posted.at(-1), { type: "openDiff", path: row.dataset.path, editId });
  }
  page.post({ type: "assistantEnd" });
  page.post({ type: "userMessage", text: "continue with another task" });
  notify("tool_call_update");
  assert.strictEqual(page.thread().querySelectorAll(".edit-pill").length, 2,
    "a delayed report after the next turn starts still updates the original operation");
  assert.strictEqual(rows[0].querySelector(".edit-pill-actions"), null);
  h.changes.accept(rows[1].dataset.path);
  assert.ok(rows.every((row) => row.classList.contains("resolved")), "Keep still resolves every row for the file");
  assert.deepStrictEqual(page.errors(), []);
});

test("file writes without tool metadata still have distinct operation diffs", posixOnly, async (t) => {
  const { h, file, open } = await editedFile(t);
  const sessionId = h.activeId();
  await h.controller.writeTextFile({ sessionId, path: file, content: after });
  const firstId = h.last("fileChange").editId;
  const next = after.replace("400", "500");
  await h.controller.writeTextFile({ sessionId, path: file, content: next });
  const secondId = h.last("fileChange").editId;

  assert.notStrictEqual(firstId, secondId);
  assert.deepStrictEqual(await open(firstId), [before, after]);
  assert.deepStrictEqual(await open(secondId), [after, next]);
});
