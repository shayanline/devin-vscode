// Tests for what a chat link does when it is clicked: ChatController.openFile in
// src/chat/chatViewProvider.ts, driven through the real webview message handler.
// Files must keep their own editor tabs instead of replacing a preview, and a
// directory must be revealed in the Explorer inside the workspace or handed to
// the system file manager outside it, never opened in an editor.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createChat, cleanup } = require("./chat-harness");

const posixOnly = { skip: process.platform === "win32" };

async function fileLinks(t) {
  const h = createChat();
  t.after(() => h.dispose());
  await h.ready();
  const vscode = globalThis.__dvVscode;
  const opened = [];
  const shown = [];
  const calls = [];
  const openText = t.mock.method(vscode.workspace, "openTextDocument", async (uri) => {
    opened.push(uri.fsPath);
    return { uri };
  });
  t.mock.method(vscode.window, "showTextDocument", async (doc, options) => {
    shown.push({ path: doc.uri.fsPath, options });
  });
  const execute = t.mock.method(vscode.commands, "executeCommand", async (...args) => {
    calls.push(args);
  });
  return {
    h, vscode, opened, shown, calls, openText, execute,
    open: (target, line) => h.webview._handler({ type: "openFile", path: target, line })
  };
}

function commandPaths(calls) {
  return calls.map(([command, uri]) => [command, uri.fsPath]);
}

test.after(() => cleanup());

test("chat links: files keep separate editor tabs and their line selection", posixOnly, async (t) => {
  const { h, vscode, shown, calls, open } = await fileLinks(t);
  const names = ["one file.ts", "two file.ts", "three file.ts", "four file.ts", "five file.ts"];
  for (const name of names) {
    fs.writeFileSync(path.join(h.cwd, name), "export const value = 1;\n");
  }
  const abs = names.map((name) => path.join(h.cwd, name));
  const uri = (i) => vscode.Uri.file(abs[i]).toString();

  await open(names[0]);
  await open(uri(1));
  await open(names[2], 7);
  await open(uri(3));
  await open(names[4]);

  assert.deepStrictEqual(shown.map((s) => s.path), abs);
  assert.ok(shown.every((s) => s.options.preview === false));
  assert.deepStrictEqual(
    shown[2].options.selection,
    new vscode.Range(new vscode.Position(6, 0), new vscode.Position(6, 0))
  );
  assert.deepStrictEqual(calls, []);
});

test("chat links: binary files pin the editor chosen by VS Code", posixOnly, async (t) => {
  const { h, shown, calls, openText, open } = await fileLinks(t);
  const file = path.join(h.cwd, "binary blob.bin");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  openText.mock.mockImplementation(async () => {
    throw new Error("Binary file");
  });

  await open(file);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], "vscode.open");
  assert.strictEqual(calls[0][1].fsPath, file);
  assert.strictEqual(calls[0].length, 3);
  assert.deepStrictEqual(calls[0][2], { preview: false });
  assert.deepStrictEqual(shown, []);
});

test("chat links: workspace folders expand and keep focus on repeated clicks", posixOnly, async (t) => {
  const { h, vscode, opened, shown, calls, open } = await fileLinks(t);
  const folder = path.join(h.cwd, "folder with spaces");
  fs.mkdirSync(folder);
  const child = path.join(folder, "child.ts");
  fs.writeFileSync(child, "export {};\n");
  const folderUri = vscode.Uri.file(folder).toString().replace(/^file:/, "FILE:");

  await open("folder with spaces" + path.sep);
  await open(folder + path.sep);
  await open(folderUri);

  const expected = [];
  for (let i = 0; i < 3; i++) {
    expected.push(["revealInExplorer", child], ["revealInExplorer", folder]);
  }
  assert.deepStrictEqual(commandPaths(calls), expected);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
});

test("chat links: empty workspace folders focus the Explorer without an editor", posixOnly, async (t) => {
  const { h, opened, shown, calls, open } = await fileLinks(t);
  const folder = path.join(h.cwd, "empty folder");
  fs.mkdirSync(folder);

  await open(folder);

  assert.deepStrictEqual(commandPaths(calls), [["revealInExplorer", folder]]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
});

test("chat links: directory symlinks use the Explorer", posixOnly, async (t) => {
  const { h, opened, shown, calls, open } = await fileLinks(t);
  const target = path.join(h.cwd, "real folder");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "child.ts"), "export {};\n");
  const link = path.join(h.cwd, "linked folder");
  fs.symlinkSync(target, link, "dir");

  await open(link);

  assert.deepStrictEqual(commandPaths(calls), [
    ["revealInExplorer", path.join(link, "child.ts")],
    ["revealInExplorer", link]
  ]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
});

test("chat links: folders outside the workspace use the system file manager", posixOnly, async (t) => {
  const { h, vscode, opened, shown, calls, open } = await fileLinks(t);
  const folder = path.join(h.storage, "outside folder");
  fs.mkdirSync(folder);
  t.mock.method(vscode.workspace, "getWorkspaceFolder", () => undefined);

  await open(folder);

  assert.deepStrictEqual(commandPaths(calls), [["revealFileInOS", folder]]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
});

test("chat links: folders with no open workspace use the system file manager", posixOnly, async (t) => {
  const { h, opened, shown, calls, open } = await fileLinks(t);
  const folder = path.join(h.cwd, "folder without workspace");
  fs.mkdirSync(folder);
  const folders = globalThis.__dvFolders;
  globalThis.__dvFolders = undefined;
  t.after(() => {
    globalThis.__dvFolders = folders;
  });

  await open(folder);

  assert.deepStrictEqual(commandPaths(calls), [["revealFileInOS", folder]]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
});

test("chat links: Explorer failures fall back without opening a directory editor", posixOnly, async (t) => {
  const { h, opened, shown, calls, execute, open } = await fileLinks(t);
  const folder = path.join(h.cwd, "folder the Explorer refuses");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "child.ts"), "export {};\n");
  execute.mock.mockImplementation(async (...args) => {
    calls.push(args);
    if (args[0] === "revealInExplorer") {
      throw new Error("Explorer unavailable");
    }
  });

  await open(folder);

  assert.deepStrictEqual(commandPaths(calls), [
    ["revealInExplorer", path.join(folder, "child.ts")],
    ["revealFileInOS", folder]
  ]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
  assert.deepStrictEqual(h.postsOf("error"), []);
});

test("chat links: failed directory fallbacks report an error without an editor", posixOnly, async (t) => {
  const { h, vscode, opened, shown, calls, execute, open } = await fileLinks(t);
  const folder = path.join(h.storage, "outside folder");
  fs.mkdirSync(folder);
  t.mock.method(vscode.workspace, "getWorkspaceFolder", () => undefined);
  execute.mock.mockImplementation(async (...args) => {
    calls.push(args);
    throw new Error("System file manager unavailable");
  });

  await open(folder);

  assert.deepStrictEqual(commandPaths(calls), [["revealFileInOS", folder]]);
  assert.deepStrictEqual(opened, []);
  assert.deepStrictEqual(shown, []);
  assert.ok(h.postsOf("error").some((m) => String(m.text).includes("System file manager unavailable")));
});
