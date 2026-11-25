// Tests for the host side of a chat (src/chat/chatViewProvider.ts), through the
// harness in chat-harness.js: the real controller, driven by the same messages the
// page sends, talking to a real ACP agent over stdio.
//
// They all pin one property, because one shape of bug keeps being found here and it
// is always this: everything the controller does takes seconds (spawning an agent,
// opening a session, waking one), the user can open another chat while it happens,
// and the code after the await speaks for whatever is on screen by then rather than
// for the chat it was working on. Every fix for it used to be made by reading, which
// is why the same mistake kept being made one line away from where it was fixed.
//
// The agent's delays are the whole technique: holding session/new or session/load
// open is what makes the window between asking and arriving wide enough to act in.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("node:path");
const { createChat, createManager, cleanup } = require("./chat-harness");

// The fake agent is a `/bin/sh` wrapper, so the CLI resolver cannot run it on Windows:
// the health check fails, no chat starts, and every test here would fail for that one
// reason. Skipped rather than left to fail, until the harness grows a `.cmd` shim (which
// would also exercise the Windows quoting path in cli/locate.ts, so it is worth doing).
const posixOnly = { skip: process.platform === "win32" };

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// The per session message snapshot path, and a valid empty one to seed.
const messagesFile = (storage, id) =>
  path.join(storage, "messages", `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
const seedMessageFile = (storage, id) => {
  const file = messagesFile(storage, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, queued: [], sent: [] }));
  return file;
};

test("bypass mode answers command permission requests without showing them", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "" } });
  h.setAgentMode("bypass");
  const id = await h.startChat("bypass commands");
  const pending = h.controller.requestPermission({
    sessionId: id,
    toolCall: {
      toolCallId: "command",
      _meta: { "cognition.ai/editableCommand": "gh api graphql" }
    },
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 100))
    ]);
    assert.deepStrictEqual(result, { outcome: { outcome: "selected", optionId: "allow_once" } });
    assert.strictEqual(h.postsOf("permission").length, 0);
  } finally {
    await h.dispose();
  }
});

test("ACP configuration exposes grouped models and applies thinking effort", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  try {
    await h.ready();
    await h.startChat("configure Fusion");

    const initialize = h.agentSaw("initialize")[0];
    assert.strictEqual(initialize.params.clientCapabilities._meta["cognition.ai/groupedSessionConfigOptions"], true);
    assert.strictEqual(initialize.params.clientCapabilities._meta["cognition.ai/multiRootWorkspace"], true);

    const options = h.last("options");
    assert.deepStrictEqual(options.modelChoices.fusion.map((choice) => choice.value), [
      "fusion-claude-opus-5-high-sidekick-swe-2-medium",
      "fusion-gpt-6-astra-high-sidekick-swe-2-high"
    ]);
    assert.strictEqual(options.currentThoughtLevel, "high");
    assert.deepStrictEqual(options.thoughtLevels.map((choice) => choice.value), ["low", "high"]);

    h.send({ type: "setConfigOption", configId: "thought_level", value: "low" });
    await h.until(() => h.agentSaw("session/set_config_option").some((request) => request.params.configId === "thought_level"));
    const request = h.agentSaw("session/set_config_option").find((item) => item.params.configId === "thought_level");
    assert.strictEqual(request.params.value, "low");
    await h.until(() => h.last("options")?.currentThoughtLevel === "low");

    const before = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setFusionModel", model: "fusion-gpt-6-astra-high-sidekick-swe-2-high", thoughtLevel: "low" });
    await h.until(() => h.agentSaw("session/set_config_option").length === before + 2);
    assert.deepStrictEqual(
      h.agentSaw("session/set_config_option").slice(before).map((item) => [item.params.configId, item.params.value]),
      [["model", "fusion-gpt-6-astra-high-sidekick-swe-2-high"], ["thought_level", "low"]],
      "changing a Fusion pair restores the chosen lead effort after the model resets it"
    );
  } finally {
    await h.dispose();
  }
});

test("standard ACP tool names reach the webview", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "" } });
  try {
    await h.ready();
    const id = await h.startChat("name the tool");
    h.controller.runtimes.get(id).client.emit("update", {
      sessionId: id,
      update: { sessionUpdate: "tool_call", toolCallId: "search", name: "web_search", kind: "fetch" }
    });
    await h.until(() => h.postsOf("toolCall").some((message) => message.id === "search"));
    assert.strictEqual(h.postsOf("toolCall").find((message) => message.id === "search").meta.inferenceToolName, "web_search");
  } finally {
    await h.dispose();
  }
});

test("idle sessions do not hand diagnostics to the agent", posixOnly, async () => {
  const h = createChat({ promptDelay: 500, config: { "editorContext.diagnostics": true } });
  await h.ready();
  const uri = globalThis.__dvVscode.Uri.file(path.join(h.cwd, "src", "example.ts"));
  globalThis.__dvVscode.languages.diagnostics.set(uri.fsPath, [{
    message: "Lint errors detected.",
    severity: globalThis.__dvVscode.DiagnosticSeverity.Error,
    code: "lint",
    source: "eslint",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  }]);

  const id = await h.startChat("check the file");
  await h.until(() => h.postsOf("busy").some((m) => m.value === true));
  globalThis.__dvFolders = [{ name: path.basename(h.cwd), uri: globalThis.__dvVscode.Uri.file(h.cwd), index: 0 }];
  assert.deepStrictEqual(
    h.controller.requestDiagnostics({ sessionId: id }).items,
    [],
    "unscoped requests must not return workspace diagnostics"
  );
  assert.strictEqual(
    h.controller.requestDiagnostics({ sessionId: id, path: uri.fsPath }).items.length,
    1,
    "active turns still receive editor diagnostics"
  );

  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 3000);
  assert.deepStrictEqual(
    h.controller.requestDiagnostics({ sessionId: id, path: uri.fsPath }).items,
    [],
    "idle sessions must not trigger an unsolicited diagnostics turn"
  );
  await h.dispose();
});

test("unscoped diagnostics are withheld when multiple sessions exist", posixOnly, async () => {
  const h = createChat({ promptDelay: 60000, config: { "editorContext.diagnostics": true } });
  await h.ready();
  const first = await h.startChat("first chat");
  const uri = globalThis.__dvVscode.Uri.file(path.join(h.cwd, "src", "example.ts"));
  globalThis.__dvVscode.languages.diagnostics.set(uri.fsPath, [{
    message: "Lint errors detected.",
    severity: globalThis.__dvVscode.DiagnosticSeverity.Error,
    code: "lint",
    source: "eslint",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  }]);
  globalThis.__dvFolders = [{ name: path.basename(h.cwd), uri: globalThis.__dvVscode.Uri.file(h.cwd), index: 0 }];

  h.setDelays({ promptDelay: 500 });
  h.send({ type: "send", text: "second chat", newSession: true });
  await h.until(() => {
    const active = h.controller.runtimes.get(h.activeId());
    return h.liveChats() === 2 && h.activeId() !== first && active?.busy;
  }, 6000);

  assert.deepStrictEqual(
    h.controller.requestDiagnostics({ path: uri.fsPath }).items,
    [],
    "an unscoped request must not use another session's active runtime"
  );
  await h.dispose();
});

// What each prompt actually carried, in the order the agent was asked.
function prompts(h) {
  return h.agentSaw("session/prompt").map((m) => {
    const blocks = m.params.prompt || [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join(""),
      images: blocks.filter((b) => b.type === "image").length
    };
  });
}

test("file URI links open the referenced file", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  globalThis.__dvOpened = [];
  const fileUri = globalThis.__dvVscode.Uri.file(path.join(h.cwd, "src", "client.ts")).toString();
  const upperFileUri = fileUri.replace(/^file:/, "FILE:");

  for (const href of [fileUri, upperFileUri]) {
    await h.webview._handler({ type: "openFile", path: href });
  }

  assert.deepStrictEqual(globalThis.__dvOpened.slice(-2), [fileUri, fileUri]);
  await h.dispose();
});

test("a message does not take the files of the chat opened while it was being sent", posixOnly, async () => {
  // Starting a chat takes seconds, and the composer belongs to whatever is on screen.
  // Opening another chat and staging a file in it during that window used to end with
  // the file sent to the agent of the chat being started, and then deleted, because
  // clearing the composer afterwards saves against whichever chat is being shown.
  const h = createChat();
  await h.ready();
  const existing = await h.startChat("an existing chat");
  h.send({ type: "leaveToList" });
  await h.settle(100);

  // A new chat, held open at session/new.
  h.setDelays({ newDelay: 900 });
  h.send({ type: "send", text: "a brand new chat", newSession: true });
  await h.settle(150);

  // While it starts, the user opens the chat they had and stages a file in it.
  h.send({ type: "loadSession", id: existing });
  await h.until(() => h.activeId() === existing, 4000);
  // Opening a chat hands the composer its own staged files, so the file is staged
  // after that has happened rather than into the middle of it.
  await h.settle(150);
  h.send({ type: "attachImage", name: "staged-here.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  await h.settle(1200);

  assert.strictEqual(h.activeId(), existing, "the panel is still on the chat the user opened");
  const staged = h.last("attachments");
  assert.strictEqual(staged.items.length, 1, "its staged file is still staged");
  assert.strictEqual(staged.items[0].label, "staged-here.png");
  assert.deepStrictEqual(
    prompts(h).map((p) => p.images),
    [0, 0],
    "and no prompt carried a file staged in another chat"
  );
  await h.dispose();
});

test("a file staged before a chat exists follows it into the chat", posixOnly, async () => {
  // The sessions list has a composer of its own, so a screenshot can be attached
  // before there is any chat to attach it to. Starting a chat carries what was waiting
  // there into it, and sending carries it with the message instead.
  const h = createChat();
  await h.ready();
  h.send({ type: "attachImage", name: "from-the-list.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);

  h.send({ type: "newSession" });
  await h.until(() => !!h.activeId(), 6000);
  await h.settle(200);
  const started = h.activeId();
  assert.strictEqual(
    ((h.last("attachments") || {}).items || []).length,
    1,
    "it is still staged in the chat the box became"
  );

  // Sent from there, it goes with the message and stops being staged, rather than
  // being sent again with the next one.
  h.send({ type: "send", text: "look at this" });
  await h.until(() => h.agentSaw("session/prompt").length === 1, 6000);
  await h.settle(200);
  assert.deepStrictEqual(prompts(h).map((p) => p.images), [1], "the message carried it");
  assert.strictEqual(((h.last("attachments") || {}).items || []).length, 0, "and nothing is left staged");
  assert.ok(started, "the chat started");
  await h.dispose();
});

test("a file sent with the first message is not left staged in the chat it started", posixOnly, async () => {
  // Sending from the sessions list starts a chat and sends in one go, so the file is
  // staged in the box, carried into the chat the box becomes, and sent. It has to stop
  // being staged in both places, or the next message sends it again.
  const h = createChat();
  await h.ready();
  h.send({ type: "attachImage", name: "sent-with-the-first.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);

  h.send({ type: "send", text: "start with this", newSession: true });
  await h.until(() => h.agentSaw("session/prompt").length === 1, 6000);
  await h.settle(250);

  assert.deepStrictEqual(prompts(h).map((p) => p.images), [1], "the first message carried it");
  assert.strictEqual(((h.last("attachments") || {}).items || []).length, 0, "and it is no longer staged");
  await h.dispose();
});

test("a file staged and not sent is still there after a reload", posixOnly, async () => {
  // A staged file belongs to a prompt that has not been sent, so it outlives the agent:
  // an image pasted into the composer has no source file to attach again, and nothing
  // else in the extension can put it back. Written down per chat, and read back for a
  // chat this window has not staged anything for yet.
  const first = createChat();
  await first.ready();
  const id = await first.startChat("before the reload");
  first.send({ type: "attachImage", name: "survives-a-reload.png", mime: "image/png", data: PNG });
  await first.until(() => ((first.last("attachments") || {}).items || []).length === 1);
  await first.settle(150);
  await first.dispose();

  // A new window over the same workspace: a fresh controller, the same storage.
  const next = createChat({ storage: first.storage, cwd: first.cwd });
  await next.ready();
  next.send({ type: "loadSession", id });
  await next.until(() => next.activeId() === id, 8000);
  await next.until(() => ((next.last("attachments") || {}).items || []).length === 1, 4000);

  const staged = next.last("attachments").items;
  assert.strictEqual(staged.length, 1, "it is staged again");
  assert.strictEqual(staged[0].label, "survives-a-reload.png");
  assert.ok(staged[0].thumb.startsWith("data:image/png;base64,"), "with the image itself, not just its name");
  await next.dispose();
});

test("a chat handed to another surface leaves its staged files readable", posixOnly, async () => {
  // Moving a chat to an editor tab hands the staged files over and deliberately leaves
  // the copy on disk, because whichever surface shows the chat next reads it back the
  // same way a reload does. So this surface must let go of it completely: an entry left
  // behind here, even an empty one, is what stops that file ever being read again.
  const h = createChat();
  await h.ready();
  const id = await h.startChat("moving out");
  h.send({ type: "attachImage", name: "goes-with-the-chat.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  await h.settle(150);

  const transfer = h.controller.exportRuntime(id);
  assert.ok(transfer, "the chat was handed over");
  assert.strictEqual(transfer.attachments.length, 1, "with what was staged for it");
  // Handing a chat over means giving up responsibility for its agent, so in production
  // the arriving surface stops it. Here nobody does, and an agent nothing can stop keeps
  // the test runner alive for ever, so this test owns it.
  await transfer.rt.client.shutdown().catch(() => {});

  // Later, the chat is opened here again: the tab was closed, or it was terminated.
  h.send({ type: "loadSession", id });
  await h.until(() => h.activeId() === id, 8000);
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 4000);
  assert.strictEqual(
    h.last("attachments").items[0].label,
    "goes-with-the-chat.png",
    "and the file it left on disk is read back"
  );
  await h.dispose();
});

test("a staged read held open does not append over a fresher attach", posixOnly, async () => {
  // loadStaged reads the on disk copy after an await. A file attached while
  // that read was in flight must win: the disk copy only fills a list that is
  // still empty, never appends beside or over the newer change.
  const h = createChat({ promptDelay: 150 });
  await h.ready();
  const a = await h.startChat("first chat");
  const b = await h.startChat("second chat");
  const idle = (id) => h.until(() => {
    const rt = h.controller.runtimes.get(id);
    return !!rt && rt.busy === false;
  }, 8000);
  assert.ok(await idle(b), "the second chat's turn ended");

  h.send({ type: "activateSession", id: a });
  await h.until(() => h.activeId() === a, 8000);
  h.send({ type: "attachImage", name: "old-on-disk.png", mime: "image/png", data: IMG_A });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  await h.controller.messageStore.flush();

  // Back on b, and this window forgets it ever staged for a: only the disk
  // file can restore it now.
  h.send({ type: "activateSession", id: b });
  await h.until(() => h.activeId() === b, 8000);
  h.controller.staged.delete(a);

  const vscode = globalThis.__dvVscode;
  const fsApi = vscode.workspace.fs;
  const originalRead = fsApi.readFile;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let readEntered = false;
  fsApi.readFile = async (uri) => {
    const bytes = await originalRead(uri);
    if (String(uri.path).includes("/attachments/")) {
      readEntered = true;
      await gate;
    }
    return bytes;
  };
  try {
    const draftsBefore = h.postsOf("draft").length;
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => readEntered, 8000), "the staged read reached the disk");
    h.send({ type: "attachImage", name: "fresh.png", mime: "image/png", data: IMG_B });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000);
    releaseRead();
    // postDraft runs after loadStaged, so its arrival means the gated read
    // has been applied (or correctly skipped).
    assert.ok(await h.until(() => h.postsOf("draft").length > draftsBefore, 8000),
      "the activation finished its staged read");
    const items = (h.last("attachments") || {}).items || [];
    assert.deepStrictEqual(items.map((x) => x.label), ["fresh.png"],
      "only the fresh attachment is staged, once");
  } finally {
    releaseRead();
    fsApi.readFile = originalRead;
    await h.dispose();
  }
});

test("a chat that finishes starting in the background does not take the panel", posixOnly, async () => {
  // No configured default mode, so each chat keeps the mode its own agent reports and
  // the two can be told apart.
  const h = createChat({ config: { defaultMode: "" } });
  await h.ready();
  const first = await h.startChat("first chat");

  // The chat started in the background is in a different mode, so its own settings
  // can be told from the visible chat's.
  h.setDelays({ newDelay: 700 });
  h.setAgentMode("plan");
  const newSessionRequests = h.agentSaw("session/new").length;
  h.send({ type: "send", text: "a new chat", newSession: true });
  assert.ok(
    await h.until(() => h.agentSaw("session/new").length > newSessionRequests, 60000),
    "The second session/new request was sent."
  );
  h.send({ type: "loadSession", id: first });
  await h.until(() => h.activeId() === first);
  // The background chat really did finish starting: without this every assertion below
  // is satisfied by it never having got there. Waiting on the request being logged is
  // not enough, since the agent logs it before it answers.
  // Generous, because the whole suite runs in parallel and this waits on a process being
  // spawned: the budget is not the thing under test, so it says why if it runs out.
  assert.ok(
    await h.until(() => h.liveChats() === 2, 60000),
    `the second chat finished opening. asked: ${h.agentSaw("session/new").length}, open: ${h.liveChats()},` +
      ` errors: ${JSON.stringify(h.postsOf("error"))}, log: ${h.logs.slice(-3).join(" | ")}`
  );
  await h.settle(300);

  assert.strictEqual(h.activeId(), first, "the panel stays where the user put it");
  // What a window reload resumes from has to name the chat being read, not whichever
  // one happened to finish opening last.
  assert.strictEqual(h.store.viewing(), first, "and that is what a reload would reopen");
  const announced = new Set(h.postsOf("sessionReady").map((m) => m.sessionId));
  assert.deepStrictEqual([...announced], [first], "only the visible chat announces itself");
  // The mode picker is the one control where being wrong matters, since it says
  // whether permission will be asked for before anything runs.
  assert.strictEqual(h.last("mode").mode, "default", "the picker still shows the visible chat's mode");
  assert.notStrictEqual(h.controller.currentMode, "plan", "and the panel did not take the background chat's");
  await h.dispose();
});

test("a chat still opening is reported as starting, not as idle", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("hello");

  // Terminated so it can be opened again, which is the path that replays history.
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => (h.last("sessionStatuses") || { statuses: {} }).statuses[id] === undefined);

  h.setDelays({ loadDelay: 900 });
  h.send({ type: "loadSession", id });
  await h.until(() => ((h.last("sessionStatuses") || { statuses: {} }).statuses[id]) === "starting", 4000);
  assert.strictEqual(
    h.last("sessionStatuses").statuses[id],
    "starting",
    "the row says it is opening while it opens"
  );
  await h.until(() => (h.last("sessionStatuses") || { statuses: {} }).statuses[id] === "idle", 6000);
  await h.dispose();
});

test("messages queued behind a turn survive the surface as a paused queue", posixOnly, async () => {
  // The queue only ever lived on the runtime, so losing the surface flattened it
  // into the chat's draft and dropped what was attached to it. It is now a
  // structured snapshot of its own: paused on restore, and the restore itself
  // never sends it.
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "attachImage", name: "kept.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: "queued behind it" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);
  assert.deepStrictEqual(prompts(h).map((p) => p.text), ["the turn"], "the second is not sent");

  h.controller.dispose();
  await h.dispose();
  assert.strictEqual(h.store.draft(id) || "", "", "the queue is not flattened into the draft");
  const dir = path.join(h.storage, "messages");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.strictEqual(files.length, 1, "one message snapshot was written");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  assert.strictEqual(saved.version, 1);
  assert.strictEqual(saved.queued.length, 1);
  assert.strictEqual(saved.queued[0].text, "queued behind it");
  assert.strictEqual(saved.queued[0].kind, "queue");
  assert.strictEqual(saved.queued[0].attachments[0].label, "kept.png");
  assert.strictEqual(saved.queued[0].attachments[0].block.data, PNG);
  assert.deepStrictEqual(saved.sent, []);
});

test("a staged file goes with one message, not with both of them", posixOnly, async () => {
  // The message written first owns what was staged when it was written. A second one
  // written while the first is still waiting for its chat to open must not find the
  // same files still staged: they belong to a message that has already gone.
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  h.send({ type: "attachImage", name: "one-message-only.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);

  // Sent from the list, so the chat has to be created first, which is the window the
  // second message is written in.
  h.setDelays({ newDelay: 900 });
  h.send({ type: "send", text: "first message", newSession: true });
  await h.settle(200);
  h.send({ type: "send", text: "second message" });
  await h.settle(2500);

  // The first message went out with it. The second is waiting behind that turn, and
  // must not be holding the same file: it would be sent again when the queue drains.
  const sent = prompts(h).reduce((n, p) => n + p.images, 0);
  const waiting = (h.last("queued").items || []).reduce((n, q) => n + (q.attachments || []).length, 0);
  assert.strictEqual(sent, 1, "the message that was written with it carried it: " + JSON.stringify(prompts(h)));
  assert.strictEqual(waiting, 0, "and the one written after it is not holding it too");
  await h.dispose();
});

test("a later queued image stays on its own message", posixOnly, async () => {
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  await h.startChat("turn in progress");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "send", text: "text only" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);

  h.send({ type: "attachImage", name: "later.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: "with image" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 2);

  const items = h.last("queued").items;
  assert.deepStrictEqual(items.map((q) => q.text), ["text only", "with image"]);
  assert.deepStrictEqual(
    items.map((q) => (q.attachments || []).map((a) => a.label)),
    [[], ["later.png"]]
  );
  await h.dispose();
});

test("a second send never puts a second prompt on the same channel", posixOnly, async () => {
  // Opening a chat drains whatever was typed while it opened, so the turn that starts
  // can be in flight exactly when the send that asked for the wake resumes. ACP has no
  // way to hand a prompt to a live one: a second contends with the first, and they are
  // delivered out of order.
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  const id = await h.startChat("start");

  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => (h.last("sessionStatuses") || { statuses: {} }).statuses[id] === undefined);

  // The first send wakes it. The second is written while it is waking, so it waits,
  // and the wake drains the queue the moment it finishes.
  h.setDelays({ loadDelay: 900 });
  h.send({ type: "send", text: "first message" });
  await h.settle(200);
  h.send({ type: "send", text: "second message" });
  await h.settle(2500);

  const after = prompts(h).slice(1).map((p) => p.text);
  assert.strictEqual(after.length, 1, "one turn was started, not two: " + JSON.stringify(after));
  assert.strictEqual(h.last("queued").items.length, 1, "and the other is waiting its turn");
  await h.dispose();
});

test("a message written while a chat wakes is sent once it is awake", posixOnly, async () => {
  // A wake takes seconds and its channel is busy replaying, so a message written into
  // it waits in the queue. Opening a chat drains that queue on the way out and waking
  // one did not, so the message sat there until some later turn happened to end: sent
  // out of order, or never, from a chat whose composer had gone quiet.
  const h = createChat({ promptDelay: 150 });
  await h.ready();
  const id = await h.startChat("first");
  await h.until(() => prompts(h).length === 1, 6000);

  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => h.liveChats() === 0, 6000);
  h.answerWith(undefined);

  h.setDelays({ loadDelay: 900 });
  h.send({ type: "wakeSession", id });
  await h.settle(250);
  h.send({ type: "send", text: "typed while it woke" });
  const sent = await h.until(() => prompts(h).some((p) => p.text === "typed while it woke"), 8000);

  assert.ok(sent, "the message went out: " + JSON.stringify(prompts(h)));
  assert.deepStrictEqual((h.last("queued") || { items: [] }).items, [], "and nothing is left waiting");
  await h.dispose();
});

test("a message goes to the chat it was written in, not the one opened while it woke", posixOnly, async () => {
  // The same shape as every other bug here: the send waits for the wake, and the code
  // after the await asked what was on screen by then. Writing into a chat, then opening
  // another while it wakes, used to send the message to that other chat's agent. The
  // wake is held on its load gate rather than a guessed delay, so the send and the
  // navigation land inside it every time.
  const h = createChat({ promptDelay: 150 });
  try {
    await h.ready();
    const woken = await h.startChat("the chat with the message");
    assert.ok(await h.until(() => prompts(h).length === 1, 6000), "the first chat's prompt went out");
    h.answerWith("Terminate");
    h.send({ type: "terminateSession", id: woken });
    assert.ok(await h.until(() => h.liveChats() === 0, 6000), "the first chat was terminated");
    h.answerWith(undefined);

    const other = await h.startChat("the chat opened instead");
    assert.ok(await h.until(() => prompts(h).length === 2, 6000), "the second chat's prompt went out");
    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => h.activeId() === undefined, 8000), "the list is showing");

    // Wake the first, write into it, then open the other one while it is still waking.
    const realLoad = h.controller.loadWithTakeover.bind(h.controller);
    let releaseWake;
    let wakeStarted = false;
    const wakeGate = new Promise((resolve) => { releaseWake = resolve; });
    h.controller.loadWithTakeover = async (...args) => {
      if (args[1] === woken) {
        wakeStarted = true;
        await wakeGate;
      }
      return realLoad(...args);
    };
    const realSend = h.controller.handleSend.bind(h.controller);
    let captured = false;
    h.controller.handleSend = (...args) => {
      const pending = realSend(...args);
      if (args[0] === "for the chat I wrote it in") captured = true;
      return pending;
    };
    try {
      h.send({ type: "wakeSession", id: woken });
      assert.ok(await h.until(() => wakeStarted, 8000), "the wake reached its load");
      h.send({ type: "send", text: "for the chat I wrote it in" });
      assert.ok(await h.until(() => captured, 8000), "the send was dispatched while the wake was held");
      h.send({ type: "activateSession", id: other });
      assert.ok(await h.until(() => h.activeId() === other, 8000), "the other chat was opened");
      releaseWake();
      const carried = () => h.agentSaw("session/prompt").filter((m) =>
        (m.params.prompt || []).some((b) => b.text === "for the chat I wrote it in"));
      assert.ok(await h.until(() => carried().length > 0, 10000), "the message was sent");
      assert.strictEqual(carried().length, 1, "it was sent once");
      assert.strictEqual(carried()[0].params.sessionId, woken, "to the chat it was written in");
    } finally {
      releaseWake();
      delete h.controller.loadWithTakeover;
      delete h.controller.handleSend;
    }
  } finally {
    await h.dispose();
  }
});

test("a chat announcing its mode while it starts does not set the panel's", posixOnly, async () => {
  // A session's first updates arrive before session/new returns, so its runtime is not
  // in the pool to be found by id. Answering those with whatever is on screen flipped
  // the mode picker of the chat being read to a background chat's, which is the one
  // control where being wrong matters: it says whether permission is asked for before
  // anything runs.
  const h = createChat({ config: { defaultMode: "" }, promptDelay: 150 });
  await h.ready();
  const first = await h.startChat("the chat on screen");
  await h.until(() => (h.last("mode") || {}).mode === "default", 6000);

  h.setAgentMode("plan");
  h.setDelays({ newDelay: 700 });
  h.send({ type: "send", text: "a chat started in the background", newSession: true });
  await h.settle(120);
  h.send({ type: "loadSession", id: first });
  await h.until(() => h.activeId() === first, 6000);
  assert.ok(await h.until(() => h.liveChats() === 2, 60000), "the background chat finished starting");
  await h.settle(300);

  assert.strictEqual(h.activeId(), first, "the panel stays where the user put it");
  assert.strictEqual(h.last("mode").mode, "default", "and still shows its own mode");
  assert.notStrictEqual(h.controller.currentMode, "plan", "not the one the background chat announced");
  await h.dispose();
});

test("stopping a turn does not let the next message contend with it", posixOnly, async () => {
  // Stop is a notification: the prompt stays open until the agent answers it, which can
  // take as long as the command it is waiting on. Freeing the composer is right, but
  // clearing the turn's own busy flag with it let the next message straight past the one
  // gate there is and onto a channel that already had a prompt on it.
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  await h.startChat("a turn that will not end");
  await h.until(() => prompts(h).length === 1, 6000);

  h.send({ type: "cancel" });
  await h.settle(100);
  h.send({ type: "send", text: "after the stop" });
  await h.settle(600);

  assert.strictEqual(prompts(h).length, 1, "still one prompt: " + JSON.stringify(prompts(h)));
  assert.strictEqual(h.last("queued").items.length, 1, "and the message is waiting, not lost");
  await h.dispose();
});

test("a closed surface does not start an ACP agent after delayed startup", posixOnly, async () => {
  const h = createChat();
  h.controller.autoNewSession = true;
  const runHealthCheck = h.controller.runHealthCheck.bind(h.controller);
  h.controller.runHealthCheck = async () => {
    await h.settle(400);
    await runHealthCheck();
  };

  h.send({ type: "ready" });
  await h.settle(50);
  h.controller.markClosed();
  h.controller.dispose();
  await h.settle(1200);

  assert.strictEqual(h.agentSaw("initialize").length, 0, "no ACP process starts after disposal");
  assert.strictEqual(h.liveChats(), 0, "no runtime is retained after disposal");
  await h.dispose();
});

test("a closed destination rejects pending readiness waiters", async () => {
  const h = createChat();
  const ready = h.controller.whenReady().then(() => false, () => true);

  h.controller.markClosed();
  const released = await Promise.race([ready, h.settle(100).then(() => false)]);

  assert.strictEqual(released, true, "a closed surface stops a move before it exports a runtime");
  await h.dispose();
});

test("a restored chat starts loading before a slow session list returns", posixOnly, async () => {
  const h = createChat();
  const id = "restored";
  h.store.add(id, h.cwd);
  h.store.setViewing(id);
  let releaseListing;
  h.controller.refreshSessions = async () => {
    await new Promise((resolve) => { releaseListing = resolve; });
  };

  h.send({ type: "ready" });
  const loaded = await h.until(() => h.agentSaw("session/load").length === 1, 4000);
  releaseListing?.();

  assert.ok(loaded, "session/load starts without waiting for session listing");
  await h.dispose();
});

test("a visible session list loads its initial rows", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  await h.until(() => h.postsOf("ready").length > 0, 4000);
  h.send({ type: "listVisible", value: true });

  const listed = await h.until(() => h.postsOf("sessions").length === 1, 2000);

  assert.ok(listed, "the visible list receives its initial session rows");
  await h.dispose();
});

test("concurrent session refreshes share one ACP list request", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  const listSessions = rt.client.listSessions.bind(rt.client);
  rt.client.listSessions = async () => {
    await h.settle(300);
    return listSessions();
  };
  h.controller.sessionsCache = undefined;
  const before = h.agentSaw("session/list").length;

  await Promise.all(Array.from({ length: 5 }, () => h.controller.refreshSessions(true)));

  assert.strictEqual(h.agentSaw("session/list").length - before, 1, "all callers share one ACP list request");
  await h.dispose();
});

test("a completed turn does not list sessions while the list is hidden", posixOnly, async () => {
  const h = createChat({ promptDelay: 100 });
  await h.ready();
  await h.startChat("first turn");
  await h.until(() => h.postsOf("busy").filter((m) => m.value === false).length === 1, 5000);
  await h.settle(200);
  const before = h.agentSaw("session/list").length;

  h.send({ type: "send", text: "second turn" });
  await h.until(() => h.postsOf("busy").filter((m) => m.value === false).length === 2, 5000);
  await h.settle(300);

  assert.strictEqual(h.agentSaw("session/list").length - before, 0, "a hidden list does not use ACP");
  await h.dispose();
});

test("a stored session list paints before a cold revalidation", posixOnly, async () => {
  const cached = {
    id: "stored",
    short_id: "stored",
    working_directory: "/workspace",
    title: "Stored chat",
    tracked: true
  };
  const h = createChat({ state: { "devin.sessionList.v1": { at: 1, sessions: [cached] } } });
  h.controller.listOverProtocol = () => new Promise(() => {});
  await h.ready();
  h.send({ type: "listVisible", value: true });

  const painted = await h.until(() => h.postsOf("sessions").some((m) => m.sessions.some((s) => s.id === "stored")), 1000);

  assert.ok(painted, "cached rows appear before the cold request settles");
  await h.dispose();
});

test("a visible session list revalidates after its surface returns", posixOnly, async () => {
  const h = createChat({ listDelay: 250 });
  try {
    await h.ready();
    await h.startChat("keep the agent live");
    h.send({ type: "listVisible", value: true });
    assert.ok(await h.until(() => h.agentSaw("session/list").length > 0, 5000),
      "the initial session list request never started");
    // Local rows can paint before ACP answers, so join the whole refresh first.
    await h.controller.refreshSessions();
    const before = h.agentSaw("session/list").length;

    h.controller.setSurfaceVisible(false);
    h.controller.setSurfaceVisible(true);
    const refreshed = await h.until(() => h.agentSaw("session/list").length > before, 5000);

    assert.ok(refreshed, "returning to a visible list revalidates its rows");
  } finally {
    await h.dispose();
  }
});

test("a direct send wakes a visible retained transcript without clearing it", posixOnly, async () => {
  const h = createChat({ promptDelay: 150 });
  await h.ready();
  const id = await h.startChat("first");
  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 5000);
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => h.liveChats() === 0, 5000);
  h.answerWith(undefined);
  h.controller.activeId = id;
  h.setDelays({ loadDelay: 900 });
  const clears = h.postsOf("clear").length;

  h.send({ type: "send", text: "continue", preserveTranscript: true });
  await h.settle(250);

  assert.strictEqual(h.postsOf("clear").slice(clears).filter((m) => m.loading).length, 0, "the retained thread stays on screen while waking");
  await h.dispose();
});

test("a queued send does not wait for the wake checkpoint query", posixOnly, async () => {
  const h = createChat({ promptDelay: 100, stepsDelay: 1000 });
  await h.ready();
  const id = await h.startChat("first");
  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 5000);
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => h.liveChats() === 0, 5000);
  h.answerWith(undefined);
  const promptsBefore = h.agentSaw("session/prompt").length;

  h.send({ type: "wakeSession", id });
  await h.settle(100);
  h.send({ type: "send", text: "after wake" });
  const sent = await h.until(() => h.agentSaw("session/prompt").length === promptsBefore + 1, 500);

  assert.ok(sent, "the prompt is sent before the delayed checkpoint query returns");
  await h.dispose();
});

test("a queued send does not wait for the load checkpoint query", posixOnly, async () => {
  const h = createChat({ promptDelay: 100, stepsDelay: 1000 });
  await h.ready();
  const id = await h.startChat("first");
  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 5000);
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => h.liveChats() === 0, 5000);
  h.answerWith(undefined);
  const promptsBefore = h.agentSaw("session/prompt").length;

  h.send({ type: "loadSession", id });
  await h.settle(100);
  h.send({ type: "send", text: "after load" });
  const sent = await h.until(() => h.agentSaw("session/prompt").length === promptsBefore + 1, 500);

  assert.ok(sent, "the prompt is sent before the delayed checkpoint query returns");
  await h.dispose();
});

test("editor lifecycle events go only to a visible chat surface", posixOnly, async () => {
  const h = createChat({ documentLifecycle: true });
  await h.ready();
  await h.startChat("keep the agent live");
  const doc = {
    uri: globalThis.__dvVscode.Uri.file(path.join(h.cwd, "src", "active.ts")),
    languageId: "typescript",
    isDirty: false
  };
  globalThis.__dvVscode.window.activeTextEditor = { document: doc };
  const before = h.agentSaw("_cognition.ai/document/didFocus").length;

  h.controller.setSurfaceVisible(false);
  globalThis.__dvVscode.window.__fire.editorChanged.fire({ document: doc });
  await h.settle(100);
  assert.strictEqual(h.agentSaw("_cognition.ai/document/didFocus").length, before, "a hidden surface sends no editor context");

  h.controller.setSurfaceVisible(true);
  globalThis.__dvVscode.window.__fire.editorChanged.fire({ document: doc });
  const sent = await h.until(() => h.agentSaw("_cognition.ai/document/didFocus").length >= before + 1, 1000);
  assert.ok(sent, "the visible surface still sends editor context");
  globalThis.__dvVscode.window.activeTextEditor = undefined;
  await h.dispose();
});

test("completed subagents release their runtime identifier mapping", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);

  h.controller.onSubagentUpdate({ _meta: { "cognition.ai/subagent_started": { agentId: "worker", title: "Worker" } } }, rt);
  h.controller.onSubagentUpdate({ _meta: { "cognition.ai/subagent_completed": { agentId: "worker", success: true } } }, rt);

  assert.strictEqual(rt.subagentIds.size, 0);
  await h.dispose();
});

test("a session evicted from history releases its staged attachments", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  await h.until(() => h.postsOf("ready").length > 0, 5000);
  for (let i = 0; i < 200; i++) {
    h.store.add(`s${i}`, h.cwd);
  }
  h.controller.staged.set("s0", [{ id: "attachment", label: "image", type: "image", block: { type: "image", mimeType: "image/png", data: "a" } }]);
  const evictedFile = seedMessageFile(h.storage, "s0");

  await h.controller.createSession();
  await h.controller.messageStore.flush();
  await h.settle(100);

  assert.strictEqual(h.controller.staged.has("s0"), false);
  assert.ok(!fs.existsSync(evictedFile), "the evicted session's message snapshot went with it");
  await h.dispose();
});

test("a session pruned from the list releases its staged attachments", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const liveId = await h.startChat("keep the agent live");
  h.store.add("gone", h.cwd);
  h.controller.staged.set("gone", [{ id: "attachment", label: "image", type: "image", block: { type: "image", mimeType: "image/png", data: "a" } }]);
  const goneFile = seedMessageFile(h.storage, "gone");
  const liveFile = seedMessageFile(h.storage, liveId);
  // The agent no longer lists either id: gone is unowned and pruned, while the
  // live runtime keeps its own snapshot regardless.
  h.controller.listOverProtocol = () => Promise.resolve({ sessions: [], prunedIds: ["gone", liveId] });

  await h.controller.refreshSessions(true);
  await h.controller.messageStore.flush();
  await h.settle(100);

  assert.strictEqual(h.store.has("gone"), false);
  assert.strictEqual(h.controller.staged.has("gone"), false);
  assert.ok(!fs.existsSync(goneFile), "the unowned snapshot was removed");
  assert.ok(fs.existsSync(liveFile), "the live session's snapshot was kept");
  assert.strictEqual(h.store.has(liveId), true, "and its tracking row too");
  await h.dispose();
});

test("an idle runtime cap releases the oldest background session", posixOnly, async () => {
  const h = createChat({ promptDelay: 100, config: { maxIdleSessions: 1 } });
  await h.ready();
  const first = await h.startChat("first");
  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 5000);
  h.send({ type: "newSession" });
  await h.until(() => h.liveChats() === 2 && h.activeId() !== first, 5000);

  h.controller.reapIdleRuntimes();
  await h.settle(100);

  assert.strictEqual(h.controller.runtimes.has(first), false);
  assert.strictEqual(h.liveChats(), 1);
  await h.dispose();
});

test("transcript replay is sent in bounded batches", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  rt.log = Array.from({ length: 201 }, (_, i) => ({ type: "toolCall", id: `t${i}` }));
  h.posted.length = 0;

  h.controller.replayLog(rt);

  const batches = h.postsOf("replay");
  assert.deepStrictEqual(batches.map((batch) => batch.items.length), [100, 100, 2]);
  assert.strictEqual(h.posted.at(-1).type, "loaded");
  await h.dispose();
});

test("an idle handover replays a complete local transcript without loading", posixOnly, async () => {
  const from = createChat({ promptDelay: 100 });
  await from.ready();
  const id = await from.startChat("first");
  await from.until(() => from.postsOf("busy").some((m) => m.value === false), 5000);
  const transfer = from.controller.exportRuntime(id);
  const to = createChat();
  await to.ready();
  const before = from.agentSaw("session/load").length;

  await to.controller.importRuntime(transfer);

  assert.strictEqual(from.agentSaw("session/load").length, before);
  assert.ok(to.postsOf("replay").length > 0, "the local transcript is replayed into the destination");
  await to.dispose();
  await from.dispose();
});

test("an idle handover replays retained terminal output", posixOnly, async () => {
  const from = createChat({ promptDelay: 100 });
  await from.ready();
  const id = await from.startChat("first");
  await from.until(() => from.postsOf("busy").some((m) => m.value === false), 5000);
  const rt = from.controller.runtimes.get(id);
  const terminalId = rt.terminals.create({ sessionId: id, command: "printf saved" }).terminalId;
  await rt.terminals.waitForExit(terminalId);
  const transfer = from.controller.exportRuntime(id);
  const to = createChat();
  await to.ready();

  await to.controller.importRuntime(transfer);

  assert.ok(to.postsOf("terminalOutput").some((message) => message.terminalId === terminalId && /saved/.test(message.output)));
  await to.dispose();
  await from.dispose();
});

test("a cold surface lists sessions through another surface's live ACP client", posixOnly, async () => {
  const source = createChat();
  await source.ready();
  await source.startChat("keep the agent live");
  const target = createChat({
    surfaceHost: {
      sessionListClient: () => source.controller.sessionListClient(),
      elsewhere: () => [],
      statuses: () => ({}),
      titlesChanged: () => {}
    }
  });
  await target.ready();
  target.store.add("tracked", target.cwd);
  const before = source.agentSaw("session/list").length;

  await target.controller.refreshSessions(true);

  assert.strictEqual(source.agentSaw("session/list").length, before + 1);
  await target.dispose();
  await source.dispose();
});

test("a session running in an editor tab reports its status to the sidebar", posixOnly, async () => {
  const chats = [];
  const surfaceHost = {
    elsewhere: (except) => chats.filter((chat) => chat.controller !== except).flatMap((chat) => chat.controller.liveSessions()),
    statuses: (except) => Object.assign({}, ...chats.filter((chat) => chat.controller !== except).map((chat) => chat.controller.liveSessionStatuses())),
    sessionsChanged: (except) => chats.filter((chat) => chat.controller !== except).forEach((chat) => chat.controller.surfacesChanged()),
    sessionListClient: () => undefined,
    titlesChanged: () => {}
  };
  const editor = createChat({ kind: "editor", promptDelay: 2000, surfaceHost });
  chats.push(editor);
  await editor.ready();
  const id = await editor.startChat("keep working");
  const sidebar = createChat({ surfaceHost });
  chats.push(sidebar);

  sidebar.controller.surfacesChanged();

  assert.ok(await sidebar.until(() => sidebar.last("sessionStatuses")?.statuses[id] === "running"));
  assert.ok(await sidebar.until(() => sidebar.last("sessionStatuses")?.statuses[id] === "idle"));
  await sidebar.dispose();
  await editor.dispose();
});

test("a background runtime does not receive the visible editor documents", posixOnly, async () => {
  const h = createChat({ documentLifecycle: true });
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  const doc = {
    uri: globalThis.__dvVscode.Uri.file(path.join(h.cwd, "src", "active.ts")),
    languageId: "typescript",
    isDirty: false
  };
  globalThis.__dvVscode.workspace.textDocuments = [doc];
  globalThis.__dvVscode.window.activeTextEditor = { document: doc };
  h.controller.activeId = undefined;
  const before = h.agentSaw("_cognition.ai/document/didOpen").length;

  h.controller.sendOpenDocuments(rt);
  await h.settle(100);

  assert.strictEqual(h.agentSaw("_cognition.ai/document/didOpen").length, before);
  globalThis.__dvVscode.workspace.textDocuments = [];
  globalThis.__dvVscode.window.activeTextEditor = undefined;
  await h.dispose();
});

test("a closed destination refuses a live runtime handover", posixOnly, async () => {
  const from = createChat({ promptDelay: 100 });
  await from.ready();
  const id = await from.startChat("first");
  await from.until(() => from.postsOf("busy").some((m) => m.value === false), 5000);
  const transfer = from.controller.exportRuntime(id);
  const to = createChat();
  to.controller.markClosed();

  await assert.rejects(() => to.controller.importRuntime(transfer), /closed/);

  assert.strictEqual(to.liveChats(), 0);
  await transfer.rt.client.shutdown();
  await to.dispose();
  await from.dispose();
});

test("resolving a takeover clears its timeout", async () => {
  const h = createChat();
  const setTimeout = global.setTimeout;
  const clearTimeout = global.clearTimeout;
  const timer = { unref() {} };
  let cleared = false;
  global.setTimeout = () => timer;
  global.clearTimeout = (value) => { if (value === timer) cleared = true; };
  try {
    const pending = h.controller.askTakeover("session");
    h.controller.resolveTakeover("lock-1", "cancel");
    await pending;
    assert.strictEqual(cleared, true);
  } finally {
    global.setTimeout = setTimeout;
    global.clearTimeout = clearTimeout;
    await h.dispose();
  }
});

test("checkpoint identity: a pushed revert step list avoids a follow-up ACP query", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  rt.steps = [{ stepNumber: 1, kind: "prompt", userMessageId: "m1", revertTargetNodeId: 1, forkTargetNodeId: 2 }];
  rt.stepsKnown = true;
  const before = h.agentSaw("_cognition.ai/revert/listSteps").length;

  await h.controller.refreshCheckpoints(rt);

  assert.strictEqual(h.agentSaw("_cognition.ai/revert/listSteps").length, before);
  assert.ok(h.postsOf("checkpoints").some((message) =>
    message.sessionId === id
    && message.checkpoints.some((c) => c.userMessageId === "m1" && c.canFork === false)));
  await h.dispose();
});

test("session loading starts ACP while staged attachments are restored", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  await h.until(() => h.postsOf("ready").length > 0, 5000);
  h.store.add("stored", h.cwd);
  const loadStaged = h.controller.loadStaged.bind(h.controller);
  let spawned = false;
  const spawnRuntime = h.controller.spawnRuntime.bind(h.controller);
  h.controller.loadStaged = async (...args) => {
    await h.settle(500);
    return loadStaged(...args);
  };
  h.controller.spawnRuntime = (...args) => {
    spawned = true;
    return spawnRuntime(...args);
  };

  h.send({ type: "loadSession", id: "stored" });
  await h.settle(100);

  assert.strictEqual(spawned, true);
  await h.dispose();
});

test("a session list refresh records one timing summary", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  await h.startChat("keep the agent live");
  h.logs.length = 0;

  await h.controller.refreshSessions(true);

  assert.strictEqual(h.logs.filter((line) => /^\[perf\] session-list /.test(line)).length, 1);
  await h.dispose();
});

test("a session load records one timing summary", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  await h.until(() => h.postsOf("ready").length > 0, 5000);
  h.store.add("stored", h.cwd);
  h.logs.length = 0;

  h.send({ type: "loadSession", id: "stored" });
  await h.until(() => h.postsOf("loaded").length > 0, 5000);

  assert.strictEqual(h.logs.filter((line) => /^\[perf\] session-load /.test(line)).length, 1);
  await h.dispose();
});

test("an optimistic ready hint refreshes a list after health succeeds", posixOnly, async () => {
  const h = createChat({ state: { "devin.readyHint.v1": true } });
  const healthCheck = h.controller.runHealthCheck.bind(h.controller);
  let release;
  h.controller.runHealthCheck = async () => new Promise((resolve) => { release = resolve; }).then(healthCheck);

  h.send({ type: "ready" });
  assert.strictEqual(await h.until(() => h.postsOf("ready").length === 1, 1000), true);
  h.send({ type: "listVisible", value: true });
  // The rows already known publish at once, while the remote listing still
  // waits on health.
  assert.strictEqual(await h.until(() => h.postsOf("sessions").length === 1, 1000), true);
  assert.strictEqual(h.postsOf("sessions").length, 1);

  release();
  const published = h.postsOf("sessions").length;
  assert.ok(await h.until(() => h.postsOf("sessions").length > published, 5000));
  await h.dispose();
});

test("a successful recheck resumes the last viewed session", posixOnly, async () => {
  const h = createChat({ state: { "devin.viewingSession.v1": "stored" } });
  const healthCheck = h.controller.runHealthCheck.bind(h.controller);
  h.controller.runHealthCheck = async () => {
    h.controller.health = { found: false, loggedIn: false, path: "devin" };
  };

  h.send({ type: "ready" });
  assert.strictEqual(await h.until(() => h.postsOf("setup").length > 0, 1000), true);
  h.controller.runHealthCheck = healthCheck;
  h.send({ type: "recheck" });

  assert.strictEqual(await h.until(() => h.agentSaw("session/load").some((message) => message.params.sessionId === "stored"), 5000), true);
  await h.dispose();
});

test("the idle runtime cap keeps a session that is still loading", posixOnly, async () => {
  const h = createChat({ promptDelay: 100, loadDelay: 1000, config: { maxIdleSessions: 1 } });
  await h.ready();
  const first = await h.startChat("keep the first session idle");
  assert.strictEqual(await h.until(() => h.postsOf("busy").some((message) => message.value === false), 5000), true);
  h.store.add("loading", h.cwd);
  h.send({ type: "loadSession", id: "loading" });
  assert.strictEqual(await h.until(() => h.controller.runtimes.get("loading")?.replaying === true, 1000), true);
  h.controller.activeId = first;

  h.controller.reapIdleRuntimes();

  assert.strictEqual(h.controller.runtimes.has("loading"), true);
  await h.dispose();
});

test("revealing a chat reconciles documents changed while hidden", posixOnly, async () => {
  const h = createChat({ documentLifecycle: true });
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  const first = { uri: globalThis.__dvVscode.Uri.file(path.join(h.cwd, "first.ts")), languageId: "typescript", isDirty: false };
  const second = { uri: globalThis.__dvVscode.Uri.file(path.join(h.cwd, "second.ts")), languageId: "typescript", isDirty: true };
  globalThis.__dvVscode.workspace.textDocuments = [first];
  globalThis.__dvVscode.window.activeTextEditor = { document: first };
  h.controller.sendOpenDocuments(rt);
  await h.settle(50);
  h.controller.setSurfaceVisible(false);
  globalThis.__dvVscode.workspace.textDocuments = [second];
  globalThis.__dvVscode.window.activeTextEditor = { document: second };
  const beforeClose = h.agentSaw("_cognition.ai/document/didClose").length;
  const beforeOpen = h.agentSaw("_cognition.ai/document/didOpen").length;

  h.controller.setSurfaceVisible(true);

  assert.strictEqual(await h.until(() => h.agentSaw("_cognition.ai/document/didClose").length === beforeClose + 1, 1000), true);
  assert.strictEqual(await h.until(() => h.agentSaw("_cognition.ai/document/didOpen").length === beforeOpen + 1, 1000), true);
  globalThis.__dvVscode.workspace.textDocuments = [];
  globalThis.__dvVscode.window.activeTextEditor = undefined;
  await h.dispose();
});

test("a replaying runtime is not exported before loading settles", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep the agent live");
  const rt = h.controller.runtimes.get(id);
  rt.replaying = true;
  let transfer;
  try {
    transfer = h.controller.exportRuntime(id);
    assert.strictEqual(transfer, undefined);
  } finally {
    if (transfer) {
      rt.replaying = false;
      await h.controller.importRuntime(transfer);
    }
  }
  await h.dispose();
});

test("history eviction retains attachments for a live session", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("keep this session live");
  h.controller.staged.set(id, [{ id: "attachment", label: "image", type: "image", block: { type: "image", mimeType: "image/png", data: "a" } }]);
  const liveFile = seedMessageFile(h.storage, id);
  for (let i = 0; i < 199; i++) {
    h.store.add(`older-${i}`, h.cwd);
  }

  h.controller.rememberSession("new", h.cwd);
  await h.controller.messageStore.flush();
  await h.settle(50);

  assert.strictEqual(h.controller.staged.has(id), true);
  assert.ok(fs.existsSync(liveFile), "the live session's message snapshot was kept");
  await h.dispose();
});

test("a forced refresh follows a stale list request after session removal", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  assert.strictEqual(await h.until(() => h.postsOf("ready").length > 0, 5000), true);
  h.store.add("gone", h.cwd);
  let resolve;
  let calls = 0;
  h.controller.listOverProtocol = () => {
    calls++;
    if (calls === 1) {
      return new Promise((done) => { resolve = done; });
    }
    return Promise.resolve({ sessions: [], prunedIds: [] });
  };

  const initial = h.controller.refreshSessions(true);
  await h.settle(25);
  h.store.remove("gone");
  const forced = h.controller.refreshSessions(true);
  resolve({ sessions: [{ id: "gone", short_id: "gone", working_directory: h.cwd }], prunedIds: [] });
  await Promise.all([initial, forced]);

  assert.strictEqual(calls, 2);
  assert.strictEqual(h.last("sessions").sessions.some((session) => session.id === "gone"), false);
  await h.dispose();
});

test("a new prompt invalidates its previous revert step list", posixOnly, async () => {
  const h = createChat({ promptDelay: 100 });
  await h.ready();
  const id = await h.startChat("first");
  assert.strictEqual(await h.until(() => h.postsOf("busy").some((message) => message.value === false), 5000), true);
  await h.settle(100);
  const rt = h.controller.runtimes.get(id);
  rt.steps = [{ stepNumber: 1, revertTargetNodeId: 1, forkTargetNodeId: 2 }];
  rt.stepsKnown = true;
  const before = h.agentSaw("_cognition.ai/revert/listSteps").length;

  h.send({ type: "send", text: "second" });

  assert.strictEqual(await h.until(() => h.agentSaw("_cognition.ai/revert/listSteps").length > before, 5000), true);
  await h.dispose();
});

test("a busy handover replays retained terminal output", posixOnly, async () => {
  const from = createChat({ promptDelay: 60000 });
  await from.ready();
  const id = await from.startChat("keep the turn running");
  assert.strictEqual(await from.until(() => from.postsOf("busy").some((message) => message.value), 5000), true);
  const rt = from.controller.runtimes.get(id);
  const terminalId = rt.terminals.create({ sessionId: id, command: "printf saved" }).terminalId;
  await rt.terminals.waitForExit(terminalId);
  const transfer = from.controller.exportRuntime(id);
  const to = createChat();
  await to.ready();

  await to.controller.importRuntime(transfer);

  assert.ok(to.postsOf("terminalOutput").some((message) => message.terminalId === terminalId && /saved/.test(message.output)));
  await to.dispose();
  await from.dispose();
});

test("a watched list update follows an in-flight session refresh", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  assert.strictEqual(await h.until(() => h.postsOf("ready").length > 0, 5000), true);
  h.controller.listVisible = true;
  let resolve;
  let calls = 0;
  h.controller.listOverProtocol = () => {
    calls++;
    if (calls === 1) {
      return new Promise((done) => { resolve = done; });
    }
    return Promise.resolve({ sessions: [], prunedIds: [] });
  };

  const initial = h.controller.refreshSessions(true);
  await h.settle(25);
  h.controller.relistIfWatched();
  resolve({ sessions: [], prunedIds: [] });
  await initial;

  assert.strictEqual(await h.until(() => calls === 2, 1000), true);
  await h.dispose();
});

test("a model pick waits for a stored session to finish loading", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  let release;
  try {
    await h.ready();
    const baseline = await h.startChat("baseline config");
    const configOptions = JSON.parse(JSON.stringify(h.controller.runtimes.get(baseline).configOptions));
    h.store.add("stored", h.cwd);

    let loadedRuntime;
    const blocked = new Promise((resolve) => { release = resolve; });
    h.controller.loadWithTakeover = async (rt) => {
      loadedRuntime = rt;
      await blocked;
      return { configOptions };
    };

    h.send({ type: "loadSession", id: "stored" });
    assert.ok(await h.until(() => !!loadedRuntime), "the full session load entered");
    assert.strictEqual(loadedRuntime.replaying, true, "the stored session is still replaying");

    const calls = [];
    const original = loadedRuntime.client.setConfigOption.bind(loadedRuntime.client);
    loadedRuntime.client.setConfigOption = async (sessionId, configId, value) => {
      calls.push([configId, value]);
      return original(sessionId, configId, value);
    };
    h.send({
      type: "setConfigOption",
      configId: "thought_level",
      value: "low",
      model: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
      requestId: 51
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(calls, [], "the config RPC waits for the full session load");

    release();
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").some((message) => message.requestId === 51)), "the request is acknowledged after loading");
    const ack = h.postsOf("modelConfigApplied").find((message) => message.requestId === 51);
    assert.strictEqual(loadedRuntime.configOptions.find((option) => option.id === "thought_level").currentValue, "low");
    assert.strictEqual(ack.thoughtLevel, "low", "the acknowledgement keeps the user's effort instead of the loaded high effort");
  } finally {
    release?.();
    await h.dispose();
  }
});

test("model picks serialize and coalesce to the latest full selection", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback),
    update: async (key, value) => { writes.push([key, value]); }
  });
  let release;
  try {
    await h.ready();
    const id = await h.startChat("serialize picks");
    const rt = h.controller.runtimes.get(id);
    const original = rt.client.setConfigOption.bind(rt.client);
    const calls = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const blocked = new Promise((resolve) => { release = resolve; });
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      calls.push([configId, value]);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (calls.length === 1) await blocked;
        return await original(sessionId, configId, value);
      } finally {
        inFlight -= 1;
      }
    };

    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 1 });
    await h.until(() => calls.length === 1);
    h.send({ type: "setConfigOption", configId: "thought_level", value: "high", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 2 });
    h.send({ type: "setFusionModel", model: "fusion-gpt-6-astra-high-sidekick-swe-2-high", thoughtLevel: "low", requestId: 3 });
    h.send({ type: "setConfigOption", configId: "thought_level", value: "high", model: "fusion-gpt-6-astra-high-sidekick-swe-2-high", requestId: 4 });

    const intermediate = JSON.parse(JSON.stringify(rt.configOptions));
    intermediate.find((option) => option.id === "thought_level").currentValue = "low";
    rt.client.emit("update", { sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: intermediate } });
    await h.controller.publishInitialOptions();
    assert.notStrictEqual(h.last("options")?.currentThoughtLevel, "low", "an intermediate notification cannot paint over a pending pick");

    release();
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "exactly one acknowledgement arrives");

    assert.strictEqual(maxInFlight, 1, "the agent never saw two config calls at once");
    assert.deepStrictEqual(calls, [
      ["thought_level", "low"],
      ["model", "fusion-gpt-6-astra-high-sidekick-swe-2-high"],
      ["thought_level", "high"]
    ], "queued intermediate states are skipped and the final pair and effort land once");
    const ack = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(ack.requestId, 4, "only the latest request is acknowledged");
    assert.strictEqual(ack.model, "fusion-gpt-6-astra-high-sidekick-swe-2-high");
    assert.strictEqual(ack.thoughtLevel, "high");
    assert.strictEqual(h.last("options").currentModel, "fusion-gpt-6-astra-high-sidekick-swe-2-high");
    assert.strictEqual(h.last("options").currentThoughtLevel, "high");
    assert.ok(writes.some(([key, value]) => key === "defaultThoughtLevel" && value === "high"), "the applied effort is persisted");
  } finally {
    vscode.workspace.getConfiguration = realGetConfiguration;
    release?.();
    await h.dispose();
  }
});

test("a superseded model change still leaves its confirmed state recorded", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback),
    update: async (key, value) => { writes.push([key, value]); }
  });
  let release;
  const uidA = "fusion-claude-opus-5-high-sidekick-swe-2-medium";
  const uidB = "fusion-gpt-6-astra-high-sidekick-swe-2-high";
  try {
    await h.ready();
    const id = await h.startChat("record the superseded reply");
    const rt = h.controller.runtimes.get(id);
    const original = rt.client.setConfigOption.bind(rt.client);
    const calls = [];
    const blocked = new Promise((resolve) => { release = resolve; });
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      calls.push([configId, value]);
      if (calls.length === 1) await blocked;
      return original(sessionId, configId, value);
    };

    h.send({ type: "setFusionModel", model: uidB, thoughtLevel: "low", requestId: 21 });
    assert.ok(await h.until(() => calls.length === 1), "the model change is in flight");
    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: uidA, requestId: 22 });
    release();
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "only the latest request is acknowledged");

    assert.deepStrictEqual(calls, [
      ["model", uidB],
      ["model", uidA],
      ["thought_level", "low"]
    ], "the queued pick still sends its own model, because B was recorded when its call finished");
    const ack = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(ack.requestId, 22);
    assert.strictEqual(ack.model, uidA);
    assert.strictEqual(ack.thoughtLevel, "low");
    assert.strictEqual(rt.configOptions.find((option) => option.id === "model").currentValue, uidA, "the runtime knows its real model");
    assert.strictEqual(rt.model, uidA, "the runtime model agrees with the confirmed option");
  } finally {
    vscode.workspace.getConfiguration = realGetConfiguration;
    release?.();
    await h.dispose();
  }
});

test("a failed effort still acknowledges the model that did apply", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback),
    update: async (key, value) => { writes.push([key, value]); }
  });
  const uidA = "fusion-claude-opus-5-high-sidekick-swe-2-medium";
  const uidB = "fusion-gpt-6-astra-high-sidekick-swe-2-high";
  try {
    await h.ready();
    const id = await h.startChat("fail the effort only");
    const rt = h.controller.runtimes.get(id);
    const original = rt.client.setConfigOption.bind(rt.client);
    let failEffort = true;
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      if (configId === "thought_level" && failEffort) throw new Error("effort refused");
      return original(sessionId, configId, value);
    };

    h.send({ type: "setFusionModel", model: uidB, thoughtLevel: "low", requestId: 31 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "the failed request is still acknowledged");
    const ack = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(ack.model, uidB, "the model change that did land is reported");
    assert.strictEqual(ack.thoughtLevel, "high", "the effort the agent actually kept is reported");
    assert.strictEqual(rt.model, uidB, "the runtime records the applied model");
    assert.ok(vscode.window.shown.warning.length >= 1, "the failure is surfaced as a warning");
    assert.ok(!writes.some(([key]) => key === "defaultModel" || key === "defaultThoughtLevel"), "nothing about the failed pick is persisted");

    failEffort = false;
    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: uidA, requestId: 32 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 2), "a retry after the failure works");
    const retry = h.postsOf("modelConfigApplied")[1];
    assert.strictEqual(retry.model, uidA);
    assert.strictEqual(retry.thoughtLevel, "low");
  } finally {
    vscode.workspace.getConfiguration = realGetConfiguration;
    await h.dispose();
  }
});

test("an effort the agent does not offer is neither sent nor persisted", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback),
    update: async (key, value) => { writes.push([key, value]); }
  });
  try {
    await h.ready();
    await h.startChat("reject unknown effort");
    h.send({ type: "setConfigOption", configId: "thought_level", value: "xhigh", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 41 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "the request is still acknowledged");
    assert.ok(!h.agentSaw("session/set_config_option").some((request) => request.params.configId === "thought_level"), "no call goes out for a value the agent does not list");
    const ack = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(ack.thoughtLevel, "high", "the agent's real effort is acknowledged");
    assert.ok(writes.some(([key, value]) => key === "defaultThoughtLevel" && value === "high"), "the confirmed effort is persisted");
    assert.ok(!writes.some(([key, value]) => value === "xhigh"), "the unsupported value is never persisted");
  } finally {
    vscode.workspace.getConfiguration = realGetConfiguration;
    await h.dispose();
  }
});

test("a rejected model change restores the confirmed effort and still acknowledges", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback),
    update: async (key, value) => { writes.push([key, value]); }
  });
  try {
    await h.ready();
    const id = await h.startChat("reject the pick");
    const rt = h.controller.runtimes.get(id);
    const original = rt.client.setConfigOption.bind(rt.client);
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      if (configId === "thought_level") throw new Error("thought_level refused");
      return original(sessionId, configId, value);
    };

    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 7 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "the failed request is still acknowledged");
    const ack = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(ack.requestId, 7);
    assert.strictEqual(ack.thoughtLevel, "high", "the acknowledgement reports the confirmed effort, not the rejected pick");
    assert.ok(vscode.window.shown.warning.length >= 1, "the failure is surfaced as a warning");
    assert.strictEqual(h.last("options").currentThoughtLevel, "high", "the pickers are repainted with confirmed state");
    assert.ok(!writes.some(([key, value]) => key === "defaultThoughtLevel" && value === "low"), "the rejected effort is not persisted");

    rt.client.setConfigOption = original;
    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 8 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 2), "a retry after the failure works");
    assert.strictEqual(h.last("options").currentThoughtLevel, "low");
  } finally {
    vscode.workspace.getConfiguration = realGetConfiguration;
    await h.dispose();
  }
});

test("a model change cannot paint the session that replaced the one it was for", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  let release;
  try {
    await h.ready();
    const first = await h.startChat("first chat");
    const rtA = h.controller.runtimes.get(first);
    const original = rtA.client.setConfigOption.bind(rtA.client);
    let entered = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    rtA.client.setConfigOption = async (sessionId, configId, value) => {
      entered = true;
      await blocked;
      return original(sessionId, configId, value);
    };
    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 9 });
    assert.ok(await h.until(() => entered), "the first session's change is in flight");

    const second = await h.startChat("second chat");
    h.send({ type: "activateSession", id: second });
    assert.ok(await h.until(() => h.activeId() === second), "the second session is on screen");

    const rtB = h.controller.runtimes.get(second);
    const bOptions = JSON.parse(JSON.stringify(rtB.configOptions));
    bOptions.find((option) => option.id === "model").currentValue = "fusion-gpt-6-astra-high-sidekick-swe-2-high";
    bOptions.find((option) => option.id === "thought_level").currentValue = "low";
    rtB.client.emit("update", { sessionId: second, update: { sessionUpdate: "config_option_update", configOptions: bOptions } });
    assert.ok(await h.until(() => h.last("options")?.currentModel === "fusion-gpt-6-astra-high-sidekick-swe-2-high" && h.last("options")?.currentThoughtLevel === "low"), "the active session's own update is not held back by another session's pending change");

    const posts = (type) => h.postsOf(type).length;
    const beforeRelease = { options: posts("options"), model: posts("model"), ack: posts("modelConfigApplied") };
    release();
    await h.controller.modelConfigTail;
    await h.settle(50);
    assert.strictEqual(posts("options"), beforeRelease.options, "the released request repaints nothing");
    assert.strictEqual(posts("model"), beforeRelease.model, "no model message lands either");
    assert.strictEqual(posts("modelConfigApplied"), beforeRelease.ack, "a request whose session went away is not acknowledged");
    assert.strictEqual(h.last("options").currentModel, "fusion-gpt-6-astra-high-sidekick-swe-2-high", "the new session's own state stays on screen");
  } finally {
    release?.();
    await h.dispose();
  }
});

test("a pick made before any session persists its defaults and applies once one starts", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  const vscode = globalThis.__dvVscode;
  const writes = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => {
      const written = [...writes].reverse().find(([k]) => k === key);
      if (written) return written[1];
      return globalThis.__dvConfig && key in globalThis.__dvConfig ? globalThis.__dvConfig[key] : fallback;
    },
    update: async (key, value) => { writes.push([key, value]); }
  });
  let release;
  try {
    await h.ready();

    h.send({ type: "setFusionModel", model: "fusion-gpt-6-astra-high-sidekick-swe-2-high", thoughtLevel: "low", requestId: 11 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "the pre session pick is acknowledged");
    const first = h.postsOf("modelConfigApplied")[0];
    assert.strictEqual(first.requestId, 11);
    assert.strictEqual(first.model, "fusion-gpt-6-astra-high-sidekick-swe-2-high");
    assert.strictEqual(first.thoughtLevel, "low");
    assert.ok(writes.some(([key, value]) => key === "defaultModel" && value === "fusion-gpt-6-astra-high-sidekick-swe-2-high"), "the model default is persisted");
    assert.ok(writes.some(([key, value]) => key === "defaultThoughtLevel" && value === "low"), "the effort default is persisted");
    assert.strictEqual(h.agentSaw("session/set_config_option").length, 0, "no agent existed to call");

    let creating = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const spawn = h.controller.spawnRuntime.bind(h.controller);
    h.controller.spawnRuntime = (...args) => {
      const rt = spawn(...args);
      const newSession = rt.client.newSession.bind(rt.client);
      rt.client.newSession = async (...params) => {
        creating = true;
        await blocked;
        return newSession(...params);
      };
      return rt;
    };
    h.send({ type: "send", text: "start a chat", newSession: true });
    assert.ok(await h.until(() => creating), "session creation is held open for the pick");
    h.send({ type: "setConfigOption", configId: "thought_level", value: "low", model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", requestId: 12 });
    release();
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 2), "the queued pick waits for the starting session");
    const second = h.postsOf("modelConfigApplied")[1];
    assert.strictEqual(second.requestId, 12);
    assert.strictEqual(second.model, "fusion-claude-opus-5-high-sidekick-swe-2-medium");
    assert.strictEqual(second.thoughtLevel, "low");
    assert.ok(h.agentSaw("session/set_config_option").some((request) => request.params.configId === "thought_level" && request.params.value === "low"), "the new session's agent gets the effort");
  } finally {
    release?.();
    vscode.workspace.getConfiguration = realGetConfiguration;
    await h.dispose();
  }
});

test("catalogue uids are translated to the values the session's model option accepts", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "" } });
  try {
    await h.ready();
    const id = await h.startChat("translate the pick");
    const rt = h.controller.runtimes.get(id);
    // The real session offers one uid per family, not the per effort uids the
    // catalogue (and so the picker) is built from. Every reply has to report it:
    // publishOptions replaces the snapshot each time.
    const widen = (options) => {
      options.find((option) => option.id === "model").options.push({
        group: "gpt-5.6-sol", name: "GPT-5.6 Sol", options: [{ value: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol" }]
      });
      options.find((option) => option.id === "thought_level").options.push({ value: "none", name: "None" }, { value: "medium", name: "Medium" });
      return options;
    };
    widen(rt.configOptions);
    const original = rt.client.setConfigOption.bind(rt.client);
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      const res = await original(sessionId, configId, value);
      if (res?.configOptions) widen(res.configOptions);
      return res;
    };

    h.send({ type: "setModel", model: "gpt-5-6-sol-none", requestId: 51 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 1), "the normal model pick is acknowledged");
    assert.deepStrictEqual(
      h.agentSaw("session/set_config_option").map((item) => [item.params.configId, item.params.value]),
      [["model", "gpt-5-6-sol-medium"], ["thought_level", "none"]],
      "the effort variant uid becomes the accepted family uid plus a thought_level call"
    );

    const before = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setFusionModel", model: "fusion-claude-opus-5-medium-sidekick-swe-2-medium", thoughtLevel: "medium", requestId: 52 });
    assert.ok(await h.until(() => h.postsOf("modelConfigApplied").length === 2), "the Fusion pick is acknowledged");
    assert.deepStrictEqual(
      h.agentSaw("session/set_config_option").slice(before).map((item) => [item.params.configId, item.params.value]),
      [["model", "fusion-claude-opus-5-high-sidekick-swe-2-medium"], ["thought_level", "medium"]],
      "a Fusion pair the session does not list maps to its accepted uid, with the lead effort going to thought_level"
    );
  } finally {
    await h.dispose();
  }
});

// --- Steering and the pending queue ---------------------------------------
// A steer is a second session/prompt on a running session (the agent advertises
// cognition.ai/midTurnPrompts), both replies wait for the shared turn's
// completion, and anything else waits in a client owned queue. The fake agent's
// promptGate holds each prompt until its release file appears, which is what
// makes settling them in either order reachable.

test("a steer joins the running turn as a second prompt, and the turn ends once", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  assert.strictEqual(h.last("capabilities").sendWhileWorking, "steer");
  assert.strictEqual(h.last("capabilities").steering, true);
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "send", text: "steer the work", kind: "steer" });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000), "the steer reached the agent while the first was open");
  const seen = h.agentSaw("session/prompt");
  assert.strictEqual(seen[1].params.sessionId, id, "on the same session");
  assert.strictEqual(seen[1].params.prompt.at(-1).text, "steer the work");
  assert.ok(!h.agentSaw("session/cancel").length, "and it never cancels");
  assert.strictEqual(h.postsOf("assistantStart").length, 1, "one turn preamble, not two");
  assert.ok(h.postsOf("busy").some((m) => m.value === true) && !h.postsOf("busy").some((m) => m.value === false), "still busy while both are open");

  // The steer settles first: the shared barrier must wait for the original too.
  h.releasePrompt(id, 2);
  await h.settle(400);
  assert.ok(!h.postsOf("busy").some((m) => m.value === false), "one reply is not the end of the turn");
  h.releasePrompt(id, 1);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000));
  await h.dispose();
});

test("the shared turn also waits when the original settles first", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "steer the work", kind: "steer" });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000));

  h.releasePrompt(id, 1);
  await h.settle(400);
  assert.ok(!h.postsOf("busy").some((m) => m.value === false), "the steer's reply is still owed");
  h.releasePrompt(id, 2);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000));
  await h.dispose();
});

test("a queued message waits for both replies, then drains in order", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "steer the work", kind: "steer" });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000));
  h.send({ type: "send", text: "queued behind", kind: "queue" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));
  assert.strictEqual(h.last("queued").items[0].kind, "queue");

  h.releasePrompt(id, 1);
  h.releasePrompt(id, 2);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000), "the queue drains once the shared turn ends");
  const texts = prompts(h).map((p) => p.text);
  assert.deepStrictEqual(texts, ["the turn", "steer the work", "queued behind"]);
  assert.ok(!h.agentSaw("session/cancel").length);
  h.releasePrompt(id, 3);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000));
  await h.dispose();
});

test("several steers share the one running turn", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "steer one", kind: "steer" });
  h.send({ type: "send", text: "steer two", kind: "steer" });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000));
  assert.strictEqual(h.postsOf("assistantStart").length, 1, "still one turn");
  assert.strictEqual(h.controller.runtimes.get(id).turnCount, 1, "and one turn count");
  for (const n of [1, 2, 3]) h.releasePrompt(id, n);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000));
  await h.dispose();
});

test("a requested steer queues quietly when the agent cannot take it", posixOnly, async () => {
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "send", text: "steer words", kind: "steer" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));
  assert.strictEqual(h.last("queued").items[0].kind, "queue", "unsupported steering normalizes to queue");
  await h.settle(200);
  assert.strictEqual(h.agentSaw("session/prompt").length, 1, "nothing extra reached the agent");
  assert.ok(!h.agentSaw("session/cancel").length, "and nothing was cancelled for it");
  await h.dispose();
});

test("a steer's attachments belong to it, not to the message queued behind", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "attachImage", name: "steer-only.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: "steer with file", kind: "steer" });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000));
  h.send({ type: "send", text: "plain queue", kind: "queue" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));

  h.releasePrompt(id, 1);
  h.releasePrompt(id, 2);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000));
  const sent = prompts(h);
  assert.deepStrictEqual(sent.map((p) => p.images), [0, 1, 0], "the image went with the steer only");
  h.releasePrompt(id, 3);
  await h.dispose();
});

test("reordering the queue changes the order messages actually go out", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "first" });
  h.send({ type: "send", text: "second" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2));
  const items = h.last("queued").items;

  // Bogus reorders change nothing: an unknown id, and a message onto itself.
  h.send({ type: "reorderQueued", id: "q-nope", targetId: items[0].id, before: true });
  h.send({ type: "reorderQueued", id: items[0].id, targetId: items[0].id, before: true });
  await h.settle(150);
  assert.deepStrictEqual(h.last("queued").items.map((q) => q.text), ["first", "second"]);

  h.send({ type: "reorderQueued", id: items[1].id, targetId: items[0].id, before: true });
  assert.ok(await h.until(() => h.last("queued").items[0].text === "second"));

  h.releasePrompt(id, 1);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000));
  assert.strictEqual(prompts(h)[1].text, "second", "the reordered message went first");
  h.releasePrompt(id, 2);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000));
  assert.strictEqual(prompts(h)[2].text, "first");
  h.releasePrompt(id, 3);
  await h.dispose();
});

test("an edited pending message can change kind, and reorder stays inside a kind", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "queue-a" });
  h.send({ type: "send", text: "queue-b" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2));
  const items = h.last("queued").items;

  // Hold queue-a for editing and convert it to a steer: it moves to the steering
  // group but stays put until the edit is released.
  h.send({ type: "queueEditing", id: items[0].id });
  h.send({ type: "editQueued", id: items[0].id, text: "queue-a steered", kind: "steer" });
  assert.ok(await h.until(() => h.last("queued").items.some((q) => q.id === items[0].id && q.kind === "steer")));

  // Cross kind reorders are refused in both directions.
  h.send({ type: "reorderQueued", id: items[1].id, targetId: items[0].id, before: true });
  h.send({ type: "reorderQueued", id: items[0].id, targetId: items[1].id, before: true });
  await h.settle(150);
  const after = h.last("queued").items;
  assert.strictEqual(after.find((q) => q.id === items[0].id).kind, "steer");
  assert.strictEqual(after.find((q) => q.id === items[1].id).kind, "queue");

  // Releasing the edit lets the steer join the running turn mid flight.
  h.send({ type: "queueEditing", id: null });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000), "the steered edit went out without waiting");
  assert.strictEqual(prompts(h)[1].text, "queue-a steered");
  assert.ok(!h.agentSaw("session/cancel").length);
  assert.strictEqual(h.last("queued").items.length, 1, "queue-b still waits");

  for (const n of [1, 2, 3]) h.releasePrompt(id, n);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000));
  assert.strictEqual(prompts(h)[2].text, "queue-b");
  await h.dispose();
});

test("send immediately wins over the waiting queue and cancels once", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true, cancelDelay: 200 });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "wait-a" });
  h.send({ type: "send", text: "wait-b" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2));
  const items = h.last("queued").items;

  h.send({ type: "sendQueuedNow", id: items[1].id });
  assert.ok(await h.until(() => h.agentSaw("session/cancel").length === 1, 6000), "the running turn is cancelled for it");
  // A steer typed into the cancellation window cannot join the dying turn. The
  // agent's cancel lands after cancelDelay, so this check runs well inside it.
  h.send({ type: "send", text: "steer-late", kind: "steer" });
  await h.settle(80);
  assert.ok(!h.agentSaw("session/prompt").some((m) => (m.params.prompt || []).some((b) => b.text === "steer-late")),
    "it did not reach the wire during the cancel");
  assert.ok(h.last("queued").items.some((q) => q.text === "steer-late"), "it waits instead");
  // Repeated Stop does not put another session/cancel on the wire.
  h.send({ type: "cancel" });
  await h.settle(300);
  assert.strictEqual(h.agentSaw("session/cancel").length, 1, "one cancel for the whole cancellation");

  // wait-b was the pick: it is the next prompt once the cancelled turn settles,
  // and the late steer joins THAT turn rather than queueing behind it. The two
  // dispatch in one drain, so count at least, never exactly.
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length >= 2, 6000));
  assert.strictEqual(prompts(h)[1].text, "wait-b");
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length >= 3, 6000), "the steer joins the new turn");
  assert.strictEqual(prompts(h)[2].text, "steer-late");
  h.releasePrompt(id, 2);
  h.releasePrompt(id, 3);
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length >= 4, 6000));
  assert.strictEqual(prompts(h)[3].text, "wait-a", "the rest of the queue drains after");
  h.releasePrompt(id, 4);
  await h.dispose();
});

test("removing the message being edited lets the queue drain again", posixOnly, async () => {
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "blocked" });
  h.send({ type: "send", text: "behind it" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2));
  const items = h.last("queued").items;

  // Hold the head for editing: nothing behind it may pass.
  h.send({ type: "queueEditing", id: items[0].id });
  await h.settle(200);
  assert.strictEqual(h.agentSaw("session/prompt").length, 1);

  // Removing it clears the hold, so the drain resumes with what is left.
  h.send({ type: "removeQueued", id: items[0].id });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));
  // Still busy, so "behind it" stays queued. The point is the hold is gone and
  // the surviving item is now the head the drain will pick.
  assert.strictEqual(h.last("queued").items[0].text, "behind it");
  await h.dispose();
});

test("a prompt that never reached the wire returns its text and files to the draft", posixOnly, async () => {
  const h = createChat({ promptDelay: 300 });
  await h.ready();
  const id = await h.startChat("first");
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000), "the first turn ends");

  h.send({ type: "attachImage", name: "back-to-you.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  const rt = h.controller.runtimes.get(id);
  const realPrompt = rt.client.prompt.bind(rt.client);
  rt.client.prompt = () => Promise.reject(new h.AcpRequestNotSentError("ACP connection is closed"));

  h.send({ type: "send", text: "never sent", kind: "queue" });
  assert.ok(await h.until(() => /never sent/.test(h.store.draft(id) || ""), 6000), "the text is back in the draft");
  assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).some((a) => a.label === "back-to-you.png")), "and so are its files");
  assert.strictEqual(h.agentSaw("session/prompt").length, 1, "nothing reached the agent, so nothing is retried");
  assert.ok(h.postsOf("error").length > 0, "and the failure is surfaced");
  rt.client.prompt = realPrompt;
  await h.dispose();
});

test("an ambiguous prompt failure is surfaced without a retry or a duplicate", posixOnly, async () => {
  const h = createChat({ promptDelay: 300 });
  await h.ready();
  const id = await h.startChat("first");
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000));

  const rt = h.controller.runtimes.get(id);
  const realPrompt = rt.client.prompt.bind(rt.client);
  rt.client.prompt = () => Promise.reject(new Error("ACP process exited"));

  h.send({ type: "send", text: "maybe sent", kind: "queue" });
  assert.ok(await h.until(() => h.postsOf("error").length > 0, 6000), "the failure is surfaced");
  await h.settle(300);
  assert.strictEqual(h.agentSaw("session/prompt").length, 1, "and it is not sent again: delivery was unknown");
  rt.client.prompt = realPrompt;
  await h.dispose();
});

test("a steer written while a chat wakes goes out once it is ready, to its own session", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  await h.ready();
  const id = await h.startChat("first");
  h.releasePrompt(id, 1);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000));
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", id });
  await h.until(() => h.liveChats() === 0, 6000);
  h.answerWith(undefined);

  const other = await h.startChat("the chat opened instead");
  h.releasePrompt(other, 1);
  await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000);
  h.send({ type: "leaveToList" });
  await h.settle(100);

  h.setDelays({ loadDelay: 900 });
  h.send({ type: "wakeSession", id });
  await h.settle(250);
  h.send({ type: "send", text: "steer after wake", kind: "steer" });
  await h.settle(100);
  h.send({ type: "activateSession", id: other });
  await h.until(() => h.activeId() === other, 4000);

  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 8000), "the steer went out after the load");
  const last = h.agentSaw("session/prompt").at(-1);
  assert.strictEqual(last.params.sessionId, id, "to the session it was written in, not the one on screen");
  assert.strictEqual(last.params.prompt.at(-1).text, "steer after wake");
  h.releasePrompt(id, 2);
  await h.dispose();
});

test("a steered turn finishes and drains on the surface that took it", posixOnly, async () => {
  const from = createChat({ midTurnPrompts: true, promptGate: true });
  await from.ready();
  const id = await from.startChat("the turn");
  await from.until(() => from.postsOf("busy").some((m) => m.value));
  from.send({ type: "send", text: "steer the work", kind: "steer" });
  assert.ok(await from.until(() => from.agentSaw("session/prompt").length === 2, 6000));
  from.send({ type: "send", text: "queued behind", kind: "queue" });
  assert.ok(await from.until(() => (from.last("queued") || { items: [] }).items.length === 1));
  const pendingId = from.last("queued").items[0].id;

  const transfer = from.controller.exportRuntime(id);
  assert.strictEqual(transfer.rt.messages.queued[0]?.id, pendingId, "the pending id survives the handover unchanged");
  const to = createChat({ promptGate: path.join(from.storage, "prompt-gate") });
  await to.ready();
  await to.controller.importRuntime(transfer);

  const endsBefore = from.postsOf("assistantEnd").length;
  from.releasePrompt(id, 1);
  from.releasePrompt(id, 2);
  assert.ok(await to.until(() => to.postsOf("busy").some((m) => m.value === false), 8000), "the new owner saw the turn end");
  assert.strictEqual(from.postsOf("assistantEnd").length, endsBefore, "the old surface did not finish it too");
  assert.ok(await from.until(() => from.agentSaw("session/prompt").length === 3, 6000), "and its queue drained on the new owner");
  assert.strictEqual(prompts(from)[2]?.text, "queued behind");
  from.releasePrompt(id, 3);
  await to.dispose();
  await from.dispose();
});

// A steer's reply can fail or come back cancelled while the original prompt is
// still open. The shared barrier owes both replies, so the turn must stay busy
// and the queue must not drain until the original settles too.
for (const mode of ["error", "cancelled"]) {
  test(`a steer reply that ends ${mode} still waits for the shared turn`, posixOnly, async () => {
    const h = createChat({ midTurnPrompts: true, promptGate: true, promptFail: { 2: mode } });
    await h.ready();
    const id = await h.startChat("the turn");
    await h.until(() => h.postsOf("busy").some((m) => m.value));
    h.send({ type: "send", text: "steer the work", kind: "steer" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000));
    h.send({ type: "send", text: "queued behind", kind: "queue" });
    assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));

    h.releasePrompt(id, 2);
    await h.settle(400);
    assert.strictEqual(h.controller.runtimes.get(id).busy, true, "one settled reply is not the turn's end");
    assert.strictEqual(h.postsOf("assistantEnd").length, 0, "and the turn has not ended");
    assert.strictEqual(h.agentSaw("session/prompt").length, 2, "the queued message was not dispatched");
    assert.strictEqual((h.last("queued") || { items: [] }).items.length, 1, "it still waits");

    h.releasePrompt(id, 1);
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 6000), "the queue drains once the barrier settles");
    if (mode === "error") {
      assert.ok(await h.until(() => h.postsOf("error").length === 1, 6000), "the failure is surfaced once");
    } else {
      assert.ok(await h.until(() => h.postsOf("assistantEnd").some((m) => m.stopReason === "cancelled"), 6000),
        "a cancelled reply ends the shared turn as cancelled");
    }
    h.releasePrompt(id, 3);
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000));
    await h.dispose();
  });
}

test("removing the held queue head clears the files its edit borrowed", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "attachImage", name: "held-file.png", mime: "image/png", data: PNG });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: "blocked", kind: "queue" });
  h.send({ type: "send", text: "behind it", kind: "queue" });
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2));
  const head = h.last("queued").items[0];

  // Hold the head for editing: its files are copied into the composer, and the
  // turn ending must not let anything behind it pass.
  h.send({ type: "queueEditing", id: head.id });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.releasePrompt(id, 1);
  assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 6000), "the turn ends idle");
  await h.settle(200);
  assert.strictEqual(h.agentSaw("session/prompt").length, 1, "the held head blocks the drain");
  assert.strictEqual((h.last("queued") || { items: [] }).items.length, 2);

  // Removing it while idle: the borrowed files go with it, and the message
  // behind drains. The removed text must never reach the agent.
  h.send({ type: "removeQueued", id: head.id });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 6000), "the next message drains");
  assert.strictEqual(prompts(h)[1].text, "behind it");
  assert.ok(!prompts(h).some((p) => p.text === "blocked"), "the removed message was never sent");
  assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 0),
    "the composer's borrowed copy is cleared, not left for the next draft");
  h.releasePrompt(id, 2);
  await h.dispose();
});

test("an unsent prompt restores to the surface that owns the chat after the wait", posixOnly, async () => {
  // One drafts object shared by both surfaces' stores, the way a workspace's
  // storage is shared when a chat moves between the panel and an editor tab.
  const drafts = {};
  const seed = { "devin.drafts.v1": drafts };
  const from = createChat({ promptDelay: 300, state: seed });
  await from.ready();
  const id = await from.startChat("first");
  assert.ok(await from.until(() => from.postsOf("busy").some((m) => m.value === false), 6000), "the first turn ends");

  from.send({ type: "attachImage", name: "hand-back.png", mime: "image/png", data: PNG });
  await from.until(() => ((from.last("attachments") || {}).items || []).length === 1);
  const rt = from.controller.runtimes.get(id);
  const realPrompt = rt.client.prompt.bind(rt.client);
  rt.client.prompt = () => Promise.reject(new from.AcpRequestNotSentError("ACP connection is closed"));

  // Hold the draft write open so the chat can be handed to another surface
  // while the recovery is still waiting on it.
  const realBack = from.store.queuedBackToDrafts.bind(from.store);
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let writeStarted = false;
  from.store.queuedBackToDrafts = (entries) => {
    writeStarted = true;
    return writeGate.then(() => realBack(entries));
  };

  from.send({ type: "send", text: "never sent", kind: "queue" });
  assert.ok(await from.until(() => writeStarted, 6000), "the recovery reached the draft write");

  const transfer = from.controller.exportRuntime(id);
  const to = createChat({ state: seed });
  await to.ready();
  await to.controller.importRuntime(transfer);
  const fromAttachments = from.postsOf("attachments").length;
  releaseWrite();

  assert.ok(await to.until(() => ((to.last("attachments") || {}).items || []).some((a) => a.label === "hand-back.png"), 6000),
    "the files land on the surface that owns the chat now");
  assert.ok(await to.until(() => /never sent/.test((to.last("draft") || {}).text || ""), 6000),
    "and the text is back in its composer");
  await from.settle(200);
  assert.strictEqual(from.postsOf("attachments").length, fromAttachments,
    "and nothing is restored onto the surface it left");
  assert.strictEqual(from.agentSaw("session/prompt").length, 1, "the failed prompt never reached the wire, so nothing is retried");
  await to.until(() => to.postsOf("busy").some((m) => m.value === false), 6000);
  await to.dispose();
  await from.dispose();
});

// A message typed while a session is still loading has its kind decided before
// the agent's capabilities exist: initialize is still pending, so
// supportsMidTurnPrompts cannot answer yet. The queue must keep a requested
// steer as a steer through that window and let the drain normalize it once the
// real answer arrives, in either direction.
for (const midTurnPrompts of [true, false]) {
  test(`a steer sent before capabilities are known keeps its kind through the load (${midTurnPrompts ? "supported" : "unsupported"})`, posixOnly, async () => {
    const h = createChat({ midTurnPrompts, initDelay: 700, promptDelay: 400 });
    await h.ready();
    const id = await h.startChat("first");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000), "the first turn ends");
    h.answerWith("Terminate");
    h.send({ type: "terminateSession", id });
    await h.until(() => h.liveChats() === 0, 6000);
    h.answerWith(undefined);

    h.send({ type: "activateSession", id });
    // The runtime exists and is replaying while initialize is still pending:
    // this is the window where capabilities cannot be known yet.
    assert.ok(await h.until(() => {
      const rt = h.controller.runtimes.get(id);
      return rt && !rt.initialized && rt.replaying;
    }, 6000), "the load is inside its initialization window");
    const cancels = h.agentSaw("session/cancel").length;

    h.send({ type: "send", text: "queue words", kind: "queue" });
    h.send({ type: "send", text: "steer words", kind: "steer" });
    assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 2, 6000),
      "both waited for the channel instead of being sent into the replay");
    const steerItem = h.last("queued").items.find((q) => q.text === "steer words");
    assert.strictEqual(steerItem.kind, "steer",
      "the steer kept its kind even though capabilities were not yet known");

    // Once the load drains, the supported agent takes the steer first even
    // though it was written second. The unsupported one keeps plain FIFO with
    // the steer normalized to a queue entry.
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 10000),
      "the queue drained after the load");
    const wire = h.agentSaw("session/prompt").slice(1);
    assert.deepStrictEqual(wire.map((m) => m.params.prompt.at(-1).text),
      midTurnPrompts ? ["steer words", "queue words"] : ["queue words", "steer words"],
      midTurnPrompts ? "steer joins ahead of the queue" : "unsupported steering stays FIFO");
    assert.ok(wire.every((m) => m.params.sessionId === id),
      "both went to the session they were written in");
    assert.strictEqual(h.agentSaw("session/cancel").length, cancels, "steering never cancelled anything");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000));
    await h.dispose();
  });
}

// --- Session search, prompt history, background shell stop -------------------

test("a session search answers display rows and never prunes the store", posixOnly, async () => {
  const h = createChat({
    listLive: true,
    listCaps: {
      "cognition.ai/sessionListContentSearch": true,
      "cognition.ai/sessionListOrderBy": ["updated_at", "created_at"],
      "cognition.ai/sessionListSortDirection": true
    }
  });
  try {
    const id = await h.startChat("searchable chat");
    // A tracked session the agent does not list: exactly what a pruned
    // membership decision would silently drop.
    h.store.add("ghost-session", h.cwd);
    const trackedBefore = h.store.ids().slice().sort();

    h.send({ type: "querySessions", requestId: "q1", query: "needle", orderBy: "created_at", sortDirection: "asc" });
    assert.ok(await h.until(() => h.postsOf("sessionSearchResults").some((m) => m.requestId === "q1"), 8000),
      "the search was answered");
    const answer = h.postsOf("sessionSearchResults").find((m) => m.requestId === "q1");

    assert.strictEqual(answer.contentSearch, true, "the query really went out as content");
    assert.strictEqual(answer.serverSorted, true, "created_at + direction were honoured");
    assert.deepStrictEqual(answer.capabilities, {
      contentSearch: true,
      orderBy: ["updated_at", "created_at"],
      sortDirection: true
    });
    // The agent only knows the live chat's session, so the ghost cannot appear
    // in the answer, and the live one maps through the shared row normalizer.
    assert.deepStrictEqual(answer.sessions.map((s) => s.id), [id]);
    assert.strictEqual(answer.sessions[0].tracked, true);
    assert.strictEqual(typeof answer.sessions[0].last_activity_at, "number");

    // The search is display data: membership, the cache, and the authoritative
    // list push are all untouched.
    assert.deepStrictEqual(h.store.ids().slice().sort(), trackedBefore, "nothing was pruned");
    assert.strictEqual(h.postsOf("sessions").length, 0, "no authoritative list push came from a search");
    const listCall = h.agentSaw("session/list").at(-1);
    assert.strictEqual(listCall.params._meta["cognition.ai/content"], "needle");
    assert.strictEqual(listCall.params._meta["cognition.ai/orderBy"], "created_at");
    assert.strictEqual(listCall.params._meta["cognition.ai/sortDirection"], "asc");
  } finally {
    await h.dispose();
  }
});

test("a session deleted mid query is filtered out of the answer", posixOnly, async () => {
  const h = createChat({ listLive: true, listDelay: 300 });
  try {
    const id = await h.startChat("doomed chat");
    const listsBefore = h.agentSaw("session/list").length;
    h.send({ type: "querySessions", requestId: "q2", query: "", orderBy: "updated_at", sortDirection: "desc" });
    // The agent holds the list reply open (listDelay), so the request being
    // observed means the answer is genuinely still in flight.
    assert.ok(await h.until(() => h.agentSaw("session/list").length > listsBefore, 8000),
      "the list request reached the agent");
    h.store.remove(id);

    assert.ok(await h.until(() => h.postsOf("sessionSearchResults").some((m) => m.requestId === "q2"), 8000));
    const answer = h.postsOf("sessionSearchResults").find((m) => m.requestId === "q2");
    assert.deepStrictEqual(answer.sessions, [], "a session gone before the answer landed is not shown");
  } finally {
    await h.dispose();
  }
});

test("a session search with no live agent answers with empty capabilities", posixOnly, async () => {
  const h = createChat();
  try {
    h.send({ type: "querySessions", requestId: "q3", query: "anything", orderBy: "created_at", sortDirection: "asc" });
    assert.ok(await h.until(() => h.postsOf("sessionSearchResults").some((m) => m.requestId === "q3"), 4000),
      "the search was answered without spawning anything");
    const answer = h.postsOf("sessionSearchResults").find((m) => m.requestId === "q3");
    assert.strictEqual(answer.contentSearch, false);
    assert.strictEqual(answer.serverSorted, false);
    assert.strictEqual(answer.sessions, undefined, "no rows are invented for a missing agent");
    assert.deepStrictEqual(answer.capabilities, { contentSearch: false, orderBy: [], sortDirection: false });
    assert.strictEqual(h.agentSaw("session/list").length, 0, "no agent was asked");
  } finally {
    await h.dispose();
  }
});

test("a global session/list hit from another workspace never reaches the search", posixOnly, async () => {
  const h = createChat({
    listLive: true,
    listExtra: [
      { sessionId: "foreign-workspace-session", cwd: "/other/workspace", title: "Foreign chat", updatedAt: new Date().toISOString() },
      { sessionId: "tracked-local-session", cwd: "/tracked/dir", title: "Local chat", updatedAt: new Date().toISOString() }
    ],
    listCaps: {
      "cognition.ai/sessionListContentSearch": true,
      "cognition.ai/sessionListOrderBy": ["updated_at", "created_at"],
      "cognition.ai/sessionListSortDirection": true
    }
  });
  try {
    await h.startChat("live chat");
    h.store.add("tracked-local-session", h.cwd);
    const idsBefore = h.store.ids().slice().sort();

    h.send({ type: "querySessions", requestId: "qf", query: "chat", orderBy: "updated_at", sortDirection: "desc" });
    assert.ok(await h.until(() => h.postsOf("sessionSearchResults").some((m) => m.requestId === "qf"), 8000),
      "the search was answered");
    const answer = h.postsOf("sessionSearchResults").find((m) => m.requestId === "qf");
    const offered = answer.sessions.map((s) => s.id);
    assert.ok(offered.includes("tracked-local-session"), "this workspace's tracked hit is offered");
    assert.ok(!offered.includes("foreign-workspace-session"),
      "a global hit owned by another workspace is not");
    assert.deepStrictEqual(h.store.ids().slice().sort(), idsBefore,
      "and membership is untouched by the foreign row");
  } finally {
    await h.dispose();
  }
});

test("prompt history offers only this workspace's own submitted prompts", posixOnly, async () => {
  // The native CLI history is global across every directory, so it can never be
  // the source: a marker planted there must not reach the picker, and the only
  // text offered is what this extension itself submitted in this workspace.
  const h = createChat({
    history: [
      { text: "GLOBAL-OTHER-DIRECTORY-MARKER", isShell: false },
      { text: "unrelated directory prompt", isShell: false }
    ]
  });
  try {
    const id = await h.startChat("owned workspace prompt");
    h.answerWith({ text: "owned workspace prompt" });
    h.send({ type: "promptHistory", requestId: "ph-j", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-j"), 8000),
      "the picker was answered");
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-j");
    assert.strictEqual(answer.sessionId, id);
    assert.strictEqual(answer.text, "owned workspace prompt");

    const quickPick = globalThis.__dvVscode.window.lastQuickPick;
    const items = await quickPick.items;
    const texts = items.map((i) => i.text).filter(Boolean);
    assert.ok(texts.includes("owned workspace prompt"), "the submitted prompt is offered");
    assert.ok(!texts.some((t) => t.includes("GLOBAL-OTHER-DIRECTORY-MARKER")),
      "the native global history marker never appears");
    assert.ok(!texts.some((t) => t.includes("unrelated directory prompt")),
      "nor any other directory's prompt");
    assert.strictEqual(h.agentSaw("_cognition.ai/reads/promptHistory").length, 0,
      "the native history endpoint is never called");
    assert.strictEqual(quickPick.options.placeHolder, `Prompts from ${h.cwd}`);
    assert.strictEqual(quickPick.options.matchOnDetail, true);
  } finally {
    await h.dispose();
  }
});

test("prompt history picks a recent workspace prompt into the composer draft", posixOnly, async () => {
  const h = createChat();
  try {
    await h.startChat("fix the failing test");
    const id = await h.startChat("deploy the build");
    h.answerWith({ text: "deploy the build" });
    h.send({ type: "promptHistory", requestId: "ph1", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph1"), 8000),
      "the picker was answered");
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph1");
    assert.strictEqual(answer.sessionId, id);
    assert.strictEqual(answer.text, "deploy the build");
    assert.strictEqual(answer.error, undefined);

    // Both prompts were submitted in this workspace's directory, newest first,
    // and the journal is local: no agent is ever asked for history.
    const quickPick = globalThis.__dvVscode.window.lastQuickPick;
    const items = await quickPick.items;
    assert.deepStrictEqual(items.map((i) => i.text), ["deploy the build", "fix the failing test"]);
    assert.strictEqual(items[0].detail, "deploy the build", "full text stays searchable");
    assert.strictEqual(quickPick.options.placeHolder, `Prompts from ${h.cwd}`);
    assert.strictEqual(quickPick.options.matchOnDetail, true);
    assert.strictEqual(h.agentSaw("_cognition.ai/reads/promptHistory").length, 0);
  } finally {
    await h.dispose();
  }
});

test("a cancelled prompt history picker replies without text", posixOnly, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("history cancel");
    h.answerWith(undefined);
    h.send({ type: "promptHistory", requestId: "ph2", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph2"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph2");
    assert.strictEqual(answer.sessionId, id);
    assert.strictEqual(answer.text, undefined, "cancellation carries no text");
    assert.strictEqual(answer.error, undefined);
  } finally {
    await h.dispose();
  }
});

test("an empty journal explains itself and never asks an agent", posixOnly, async () => {
  const h = createChat();
  try {
    // Nothing has been submitted yet, and with no session the request carries
    // no sessionId: it resolves the folder a new chat would be created in.
    h.answerWith(undefined);
    h.send({ type: "promptHistory", requestId: "ph3", sessionId: null });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph3"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph3");
    assert.strictEqual(answer.sessionId, null);
    assert.strictEqual(answer.text, undefined);
    assert.strictEqual(answer.error, undefined);

    const quickPick = globalThis.__dvVscode.window.lastQuickPick;
    const items = await quickPick.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].label, "No prompts have been recorded for this folder yet.");
    assert.strictEqual(items[0].detail, "History records prompts sent through this extension.");
    assert.strictEqual(items[0].alwaysShow, true, "a typed query cannot filter the explanation away");
    assert.ok(!("text" in items[0]), "the row has no text property at all");
    assert.strictEqual(quickPick.options.placeHolder, `Prompts from ${h.cwd}`);
    assert.strictEqual(h.agentSaw("initialize").length, 0, "no query agent was spawned");
    assert.strictEqual(h.agentSaw("_cognition.ai/reads/promptHistory").length, 0);
  } finally {
    await h.dispose();
  }
});

test("a failed prompt history picker still replies with the safe error", posixOnly, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("history picker dies");
    globalThis.__dvVscode.window.answer = Promise.reject(new Error("picker died"));
    h.send({ type: "promptHistory", requestId: "ph-f", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-f"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-f");
    assert.strictEqual(answer.error, "Could not load prompt history.");
    assert.strictEqual(answer.text, undefined);
  } finally {
    await h.dispose();
  }
});

test("history follows the session's own directory, not the editor's folder", posixOnly, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("session A prompt");
    // Another tracked session owns a different folder's prompts.
    h.store.add("sess-b", "/other/folder-b");
    h.store.rememberPrompt("sess-b", "folder B private prompt");
    // The user is now looking at a file somewhere else entirely.
    globalThis.__dvFolders = [
      { name: "b", uri: globalThis.__dvVscode.Uri.file("/other/folder-b"), index: 0 }
    ];
    h.answerWith({ text: "session A prompt" });
    h.send({ type: "promptHistory", requestId: "ph-d", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-d"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-d");
    assert.strictEqual(answer.text, "session A prompt");
    const quickPick = globalThis.__dvVscode.window.lastQuickPick;
    const items = await quickPick.items;
    assert.deepStrictEqual(items.map((i) => i.text), ["session A prompt"]);
    assert.strictEqual(quickPick.options.placeHolder, `Prompts from ${h.cwd}`,
      "the scope is the session's directory, not the folder on screen");
  } finally {
    await h.dispose();
  }
});

test("a new chat reads its creation folder's journal without an agent", posixOnly, async () => {
  const h = createChat();
  try {
    h.store.add("seeded", h.cwd);
    h.store.rememberPrompt("seeded", "journaled before any chat");
    h.answerWith({ text: "journaled before any chat" });
    h.send({ type: "promptHistory", requestId: "ph-n", sessionId: null });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-n"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-n");
    assert.strictEqual(answer.text, "journaled before any chat");

    const quickPick = globalThis.__dvVscode.window.lastQuickPick;
    const items = await quickPick.items;
    assert.deepStrictEqual(items.map((i) => i.text), ["journaled before any chat"]);
    assert.strictEqual(quickPick.options.placeHolder, `Prompts from ${h.cwd}`);
    assert.strictEqual(h.agentSaw("initialize").length, 0, "no query agent was spawned");
    assert.strictEqual(h.agentSaw("_cognition.ai/reads/promptHistory").length, 0);
  } finally {
    await h.dispose();
  }
});

test("a history request for a foreign session never opens a picker", posixOnly, async () => {
  const h = createChat();
  try {
    await h.startChat("mine");
    const before = globalThis.__dvVscode.window.lastQuickPick;
    h.send({ type: "promptHistory", requestId: "ph-x", sessionId: "someone-elses-session" });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-x"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-x");
    assert.strictEqual(answer.text, undefined);
    assert.strictEqual(answer.error, undefined);
    assert.strictEqual(globalThis.__dvVscode.window.lastQuickPick, before, "no picker was opened");
  } finally {
    await h.dispose();
  }
});

test("a history request on a closed surface never opens a picker", posixOnly, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("mine");
    const before = globalThis.__dvVscode.window.lastQuickPick;
    // A request the page queued before it closed still names this session:
    // the dead surface must answer empty without opening a picker.
    h.controller.markClosed();
    h.send({ type: "promptHistory", requestId: "ph-c", sessionId: id });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-c"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-c");
    assert.strictEqual(answer.text, undefined);
    assert.strictEqual(answer.error, undefined);
    assert.strictEqual(globalThis.__dvVscode.window.lastQuickPick, before, "no picker was opened");
  } finally {
    await h.dispose();
  }
});

test("a held picker cannot outlive its folder scope", posixOnly, async () => {
  const h = createChat();
  try {
    h.store.add("seeded", h.cwd);
    h.store.rememberPrompt("seeded", "folder one prompt");
    let release;
    globalThis.__dvVscode.window.answer = new Promise((resolve) => { release = resolve; });
    h.send({ type: "promptHistory", requestId: "ph-h", sessionId: null });
    assert.ok(await h.until(() => globalThis.__dvVscode.window.lastQuickPick, 4000), "the picker opened");

    // Before the pick lands, the folder a new chat would be created in moves:
    // the old scope's text must not be inserted into it.
    globalThis.__dvFolders = [
      { name: "two", uri: globalThis.__dvVscode.Uri.file("/tmp/other-folder"), index: 0 }
    ];
    release({ text: "folder one prompt" });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-h"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-h");
    assert.strictEqual(answer.text, undefined, "a retargeted composer rejects the old folder's pick");
    assert.strictEqual(answer.error, undefined);
  } finally {
    await h.dispose();
  }
});

test("a window that turns folderless mid pick rejects the selection", posixOnly, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("workspace prompt");
    let release;
    globalThis.__dvVscode.window.answer = new Promise((resolve) => { release = resolve; });
    h.send({ type: "promptHistory", requestId: "ph-wf", sessionId: id });
    assert.ok(await h.until(() => globalThis.__dvVscode.window.lastQuickPick, 4000), "the picker opened");

    // The window loses its folder while the picker is still open, with the same
    // session and cwd still active: the journal scope it was opened under no
    // longer exists, so the pick belongs to nothing.
    globalThis.__dvFolders = [];
    release({ text: "workspace prompt" });

    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-wf"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-wf");
    assert.strictEqual(answer.text, undefined, "a folderless switch mid pick rejects the selection");
    assert.strictEqual(answer.error, undefined);
  } finally {
    await h.dispose();
  }
});

test("replayed chunks and usage output never enter the prompt journal", posixOnly, async () => {
  const h = createChat({
    promptDelay: 60,
    bgUpdates: [
      { sessionUpdate: "user_message_chunk", messageId: "u-replay", content: { type: "text", text: "REPLAYED-ATTACHED-FILE" } },
      { sessionUpdate: "usage_update", used: 10, size: 100,
        _meta: { "cognition.ai/contextUsage": { modelId: "m", totalTokens: 10, maxTokens: 100 } } }
    ]
  });
  try {
    const id = await h.startChat("the real submitted prompt");
    const log = () => h.controller.runtimes.get(id)?.log || [];
    assert.ok(await h.until(() => log().some((e) => e.type === "userChunk"), 8000),
      "the replayed chunk reached the transcript");
    assert.ok(await h.until(() => log().some((e) => e.type === "usage"), 8000),
      "the usage report reached the transcript");
    assert.deepStrictEqual(h.store.promptHistory(h.cwd), ["the real submitted prompt"],
      "only the submitted prompt is journaled");
  } finally {
    await h.dispose();
  }
});

test("queued input joins the journal only when it is actually sent", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  try {
    const id = await h.startChat("first gated prompt");
    h.send({ type: "send", text: "second queued prompt" });
    assert.ok(await h.until(() => (h.controller.runtimes.get(id)?.messages.queued || []).length === 1, 8000),
      "the second message is queued behind the running turn");
    assert.deepStrictEqual(h.store.promptHistory(h.cwd), ["first gated prompt"],
      "a pending queue row is not journaled yet");

    h.releasePrompt(id, 1);
    assert.ok(await h.until(
      () => h.agentSaw("session/prompt").filter((p) => p.params.sessionId === id).length === 2, 8000),
      "the queued message was flushed");
    assert.deepStrictEqual(h.store.promptHistory(h.cwd), ["second queued prompt", "first gated prompt"],
      "the flush journals it once, newest first");
    h.releasePrompt(id, 2);
  } finally {
    await h.dispose();
  }
});

test("a folderless window keeps history in memory only", posixOnly, async () => {
  const leaked = [{ sessionId: "ghost", text: "WORKSPACE-ONLY-LEAK" }];
  const h = createChat({ state: { "devin.promptHistory.v1": leaked } });
  // The journal key must not be written at all in this mode, not even a prune
  // that would drop the seeded row: watch every update the store attempts.
  const journalWrites = [];
  const realUpdate = h.state.update;
  h.state.update = (key, value) => {
    if (key === "devin.promptHistory.v1") {
      journalWrites.push(value);
    }
    return realUpdate(key, value);
  };
  try {
    globalThis.__dvFolders = [];
    // With no session yet the picker explains the empty conversation journal.
    h.answerWith(undefined);
    h.send({ type: "promptHistory", requestId: "ph-f0", sessionId: null });
    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-f0"), 8000));
    let quickPick = globalThis.__dvVscode.window.lastQuickPick;
    let items = await quickPick.items;
    assert.strictEqual(items[0].label, "No prompts have been recorded for this conversation yet.");
    assert.strictEqual(quickPick.options.placeHolder, "Prompts from this conversation");

    const id = await h.startChat("folderless owned prompt");
    h.answerWith({ text: "folderless owned prompt" });
    h.send({ type: "promptHistory", requestId: "ph-f1", sessionId: id });
    assert.ok(await h.until(() => h.postsOf("promptHistorySelected").some((m) => m.requestId === "ph-f1"), 8000));
    const answer = h.postsOf("promptHistorySelected").find((m) => m.requestId === "ph-f1");
    assert.strictEqual(answer.text, "folderless owned prompt");

    quickPick = globalThis.__dvVscode.window.lastQuickPick;
    items = await quickPick.items;
    const texts = items.map((i) => i.text).filter(Boolean);
    assert.deepStrictEqual(texts, ["folderless owned prompt"]);
    assert.ok(!texts.some((t) => t.includes("WORKSPACE-ONLY-LEAK")),
      "the workspace journal cannot leak into a folderless window");

    // Removing the session runs the prune path the journal key would
    // otherwise see rewritten to drop the untracked seeded row.
    h.store.remove(id);
    await h.settle(50);
    assert.strictEqual(journalWrites.length, 0, "the journal key was never written");
    assert.deepStrictEqual(h.state.__map.get("devin.promptHistory.v1"), leaked,
      "the seeded journal is unchanged");
  } finally {
    await h.dispose();
  }
});

// The palette command routes through the manager to the surface the user was
// last in, which the single surface harness cannot express.
test("the history command follows the last focused owned surface", posixOnly, async () => {
  const m = createManager();
  try {
    m.resolveSidebar();
    m.manager.newSessionEditor();
    const panelCtrl = m.panelControllers()[0];
    panelCtrl.autoNewSession = false;
    const panelWebview = m.panelWebview(panelCtrl);
    await m.ready(panelWebview);
    await m.ready(m.sidebarWebview);

    // Focus the editor chat, then blur into the palette the way a command does.
    m.sendTo(panelWebview, { type: "chatFocus", value: true });
    m.sendTo(panelWebview, { type: "chatFocus", value: false });
    await m.manager.showPromptHistory();

    assert.ok(m.panelPosted(panelCtrl).some((p) => p.type === "showPromptHistory"),
      "the editor chat the user was in got the command");
    assert.ok(!m.sidebarPosted.some((p) => p.type === "showPromptHistory"),
      "the sidebar did not");
  } finally {
    await m.dispose();
  }
});

test("a closed surface is ignored by the history command", posixOnly, async () => {
  const m = createManager();
  try {
    m.resolveSidebar();
    m.manager.newSessionEditor();
    const panelCtrl = m.panelControllers()[0];
    panelCtrl.autoNewSession = false;
    const panelWebview = m.panelWebview(panelCtrl);
    await m.ready(panelWebview);
    await m.ready(m.sidebarWebview);

    // The editor chat holds focus when its tab closes: no blur ever arrives,
    // and a focus message still in flight from the dead page must not re-arm it.
    m.sendTo(panelWebview, { type: "chatFocus", value: true });
    panelCtrl.markClosed();
    m.sendTo(panelWebview, { type: "chatFocus", value: true });
    await m.manager.showPromptHistory();

    assert.ok(m.sidebarPosted.some((p) => p.type === "showPromptHistory"),
      "the command fell back to the side panel");
    assert.ok(!m.panelPosted(panelCtrl).some((p) => p.type === "showPromptHistory"),
      "the closed tab got nothing");
  } finally {
    await m.dispose();
  }
});

test("a last focused controller from another manager is rejected", posixOnly, async () => {
  const mine = createManager();
  const other = createManager();
  try {
    mine.resolveSidebar();
    other.resolveSidebar();
    await mine.ready(mine.sidebarWebview);
    await other.ready(other.sidebarWebview);

    // The other window's sidebar was the last chat to hold focus anywhere.
    other.sendTo(other.sidebarWebview, { type: "chatFocus", value: true });
    other.sendTo(other.sidebarWebview, { type: "chatFocus", value: false });
    await mine.manager.showPromptHistory();

    assert.ok(mine.sidebarPosted.some((p) => p.type === "showPromptHistory"),
      "this manager's sidebar got the command");
    assert.ok(!other.sidebarPosted.some((p) => p.type === "showPromptHistory"),
      "the foreign surface was never touched");
  } finally {
    await mine.dispose();
    await other.dispose();
  }
});

test("a reported background shell can be stopped, and the row is marked stopped", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    terminalLifecycle: true,
    bgUpdates: [
      { sessionUpdate: "tool_call", toolCallId: "tc-bg", title: "sleep 90", status: "in_progress",
        _meta: { "cognition.ai/inferenceToolName": "exec" } },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-bg", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-42",
          "cognition.ai/backgroundCommand": "sleep 90" } }
    ]
  });
  try {
    const id = await h.startChat("run a background command");
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 1), 8000),
      "the live shell was published");
    const published = h.postsOf("backgroundShells").find((m) => m.items && m.items.length === 1);
    assert.strictEqual(published.sessionId, id);
    assert.deepStrictEqual(published.items, [{ toolCallId: "tc-bg", stopping: false }]);
    assert.ok(!JSON.stringify(h.postsOf("backgroundShells")).includes("sh-42"),
      "the agent-side shell id never leaves the host");

    // The registry outlives the turn: busy is false by now, the shell still runs.
    await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000);
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-bg" });

    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 1, 8000),
      "the kill reached the agent");
    assert.deepStrictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell")[0].params,
      { sessionId: id, shellId: "sh-42" });
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 0), 8000),
      "the control went away once the shell was stopped");
    assert.ok(h.postsOf("toolCallUpdate").some((m) => m.id === "tc-bg" && m.status === "cancelled" && m.stopped === true),
      "the transcript row was marked stopped, non actionably");

    // A stale request for a tool the registry no longer holds is ignored.
    const kills = h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length;
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-bg" });
    h.send({ type: "stopBackgroundShell", sessionId: "other-session", toolCallId: "tc-bg" });
    await h.settle(200);
    assert.strictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, kills,
      "stale stop requests are dropped, not queued");
  } finally {
    await h.dispose();
  }
});

test("an unsupported kill clears the controls instead of erroring per click", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    terminalLifecycle: true,
    killUnsupported: true,
    bgUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-bg2", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-7" } }
    ]
  });
  try {
    const id = await h.startChat("unsupported kill");
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 1), 8000));
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-bg2" });

    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 1, 8000));
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 0), 8000),
      "every control on the connection is cleared");
    assert.strictEqual(h.postsOf("toolCallUpdate").filter((m) => m.stopped).length, 0,
      "no stopped row is recorded for a kill that never happened");
  } finally {
    await h.dispose();
  }
});

test("live shell metadata without the advertised lifecycle grows no controls", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    bgUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-nocap", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-nocap" } }
    ]
  });
  try {
    const id = await h.startChat("shell without lifecycle");
    await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000);
    await h.settle(200);
    const items = h.postsOf("backgroundShells").flatMap((m) => m.items || []);
    assert.strictEqual(items.length, 0, "no advertised lifecycle means no stop control");
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-nocap" });
    await h.settle(200);
    assert.strictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 0,
      "and no kill is ever sent");
  } finally {
    await h.dispose();
  }
});

test("an unsupported kill cannot regrow shell controls on later updates", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    terminalLifecycle: true,
    killUnsupported: true,
    bgUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-regrow", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-regrow" } }
    ]
  });
  try {
    const id = await h.startChat("kill unsupported once");
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 1), 8000),
      "the first live update published a control");
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-regrow" });
    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 1, 8000));
    assert.ok(await h.until(() => h.postsOf("backgroundShells").some((m) => m.items && m.items.length === 0), 8000),
      "the -32601 cleared every control");

    // The same live update shape arrives again on the next turn. The
    // connection already learned it cannot kill, so nothing may repopulate.
    h.send({ type: "send", text: "another turn" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 8000),
      "the second turn ran and replayed the same metadata");
    await h.settle(300);
    // Everything published after the -32601 clear must stay empty: the
    // stopping-in-flight publish before the kill resolved does not count.
    const pubs = h.postsOf("backgroundShells");
    let clearedAt = -1;
    pubs.forEach((m, i) => { if (m.items && m.items.length === 0) clearedAt = i; });
    const repopulated = pubs.slice(clearedAt + 1).flatMap((m) => m.items || []);
    assert.strictEqual(repopulated.length, 0, "later live updates never repopulated the cleared controls");
    assert.strictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 1,
      "and no second kill was attempted");
  } finally {
    await h.dispose();
  }
});

test("an in-flight shell stop completes on the surface that owns the runtime", posixOnly, async () => {
  const from = createChat({
    promptDelay: 80,
    terminalLifecycle: true,
    killDelay: 1000,
    killFailOnce: true,
    bgUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-move", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-move" } }
    ]
  });
  try {
    const id = await from.startChat("moving shell stop");
    assert.ok(await from.until(() => from.postsOf("backgroundShells").some((m) => m.items && m.items.length === 1), 8000),
      "the live shell was published");

    // The first attempt fails once: the registry keeps the entry and the
    // control offers an inline retry.
    from.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-move" });
    assert.ok(await from.until(() => from.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 1, 8000));
    assert.ok(await from.until(() => from.postsOf("backgroundShells").some((m) => m.items && m.items[0] && m.items[0].error), 8000),
      "the failure kept the entry and showed the inline error");

    // The retry is genuinely in flight (the agent holds it for killDelay)
    // when the runtime moves to another surface mid request.
    from.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-move" });
    assert.ok(await from.until(() => from.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 2, 8000),
      "the retry reached the agent");
    from.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-move" });
    await from.settle(100);
    assert.strictEqual(from.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 2,
      "a duplicate click while stopping is ignored");

    const transfer = from.controller.exportRuntime(id);
    assert.ok(transfer, "the runtime exported while the kill was pending");
    const to = createChat();
    await to.ready();
    await to.controller.importRuntime(transfer);

    assert.ok(await to.until(() => to.postsOf("backgroundShells").some((m) => m.items && m.items.length === 0), 10000),
      "the arriving owner saw the shell cleared");
    assert.ok(to.postsOf("toolCallUpdate").some((m) => m.id === "tc-move" && m.stopped === true),
      "and recorded the stopped row itself");
    assert.strictEqual(from.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 2,
      "exactly one failure and one successful retry reached the agent");
    assert.strictEqual(from.agentSaw("session/cancel").length, 0, "a kill is never a cancel");
    assert.ok(!to.postsOf("busy").some((m) => m.value === true),
      "the parent turn state was not corrupted by the handover");
    assert.deepStrictEqual((to.last("queued") || { items: [] }).items, [], "and nothing queued up");
    await to.dispose();
  } finally {
    await from.dispose();
  }
});

test("silent replay metadata never authorizes a shell stop", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    terminalLifecycle: true
  });
  try {
    const id = await h.startChat("silent flag shell");
    await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000);
    const rt = h.controller.runtimes.get(id);
    assert.ok(rt, "the runtime is live");

    // A wake replays history with silentReplay set (and replaying already
    // cleared by the time stray live updates can arrive). Drive the real
    // update path with that flag up: the registry must stay empty.
    rt.silentReplay = true;
    rt.client.emit("update", {
      sessionId: id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-silent",
        status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-silent" }
      }
    });
    rt.silentReplay = false;
    await h.settle(200);

    const items = h.postsOf("backgroundShells").flatMap((m) => m.items || []);
    assert.strictEqual(items.length, 0, "silent replay metadata never authorizes a stop");
    h.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-silent" });
    await h.settle(200);
    assert.strictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 0,
      "and a stop for it reaches nothing");
  } finally {
    await h.dispose();
  }
});

test("background shell state replayed from history never authorizes a stop", posixOnly, async () => {
  const first = createChat();
  const id = await first.startChat("replayed shell");
  await first.dispose();

  // A reload replays the recorded tool updates. They carry the same metadata
  // a live turn would, but the registry must not treat history as runnable.
  const next = createChat({
    storage: first.storage,
    cwd: first.cwd,
    terminalLifecycle: true,
    loadUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-replay", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-replay" } }
    ]
  });
  try {
    next.send({ type: "loadSession", id });
    assert.ok(await next.until(() => next.activeId() === id, 8000), "the session loaded");
    assert.ok(await next.until(() => next.postsOf("sessionReady").some((m) => m.sessionId === id), 8000),
      "the replay finished");
    await next.settle(200);
    const items = next.postsOf("backgroundShells").flatMap((m) => m.items || []);
    assert.strictEqual(items.length, 0, "replayed metadata never authorizes a stop control");
    next.send({ type: "stopBackgroundShell", sessionId: id, toolCallId: "tc-replay" });
    await next.settle(200);
    assert.strictEqual(next.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 0,
      "and a stop for it reaches nothing");
  } finally {
    await next.dispose();
  }
});

test("two sessions sharing a toolCallId stop only their own shell", posixOnly, async () => {
  const h = createChat({
    promptDelay: 80,
    terminalLifecycle: true,
    bgUpdates: [
      { sessionUpdate: "tool_call_update", toolCallId: "tc-same", status: "in_progress",
        _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "sh-${sessionId}" } }
    ]
  });
  try {
    const idA = await h.startChat("chat A");
    const idB = await h.startChat("chat B");
    const rtA = h.controller.runtimes.get(idA);
    const rtB = h.controller.runtimes.get(idB);
    assert.ok(await h.until(() => rtA?.backgroundShells?.has("tc-same") && rtB?.backgroundShells?.has("tc-same"), 8000),
      "both runtimes registered the shared toolCallId");
    assert.strictEqual(rtA.backgroundShells.get("tc-same").shellId, `sh-${idA}`);
    assert.strictEqual(rtB.backgroundShells.get("tc-same").shellId, `sh-${idB}`);

    // Back on A, a stop resolves A's own runtime: A's client, A's session id
    // and A's shell id, even though B reports the same toolCallId.
    h.send({ type: "activateSession", id: idA });
    assert.ok(await h.until(() => h.activeId() === idA, 8000), "session A is on screen");
    h.send({ type: "stopBackgroundShell", sessionId: idA, toolCallId: "tc-same" });
    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length === 1, 8000),
      "the kill reached an agent");
    assert.deepStrictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell")[0].params,
      { sessionId: idA, shellId: `sh-${idA}` }, "A's own session and shell id were used");
    assert.ok(await h.until(() => !rtA.backgroundShells?.has("tc-same"), 8000),
      "A's registry retired the stopped shell");
    assert.strictEqual(rtB.backgroundShells.get("tc-same")?.shellId, `sh-${idB}`,
      "B's registry and shell id are untouched");

    // Naming B while A is on screen is a foreign request: rejected, no kill.
    h.send({ type: "stopBackgroundShell", sessionId: idB, toolCallId: "tc-same" });
    await h.settle(200);
    assert.strictEqual(h.agentSaw("_cognition.ai/terminal/killBackgroundShell").length, 1,
      "the foreign stop never reached an agent");
    assert.strictEqual(rtB.backgroundShells.get("tc-same")?.shellId, `sh-${idB}`);
  } finally {
    await h.dispose();
  }
});

// The text of the last text block a prompt carried, which is the user's own
// words: implicit context blocks are prepended ahead of it.
function lastPromptText(m) {
  const texts = (m.params.prompt || []).filter((b) => b.type === "text").map((b) => b.text);
  return texts.at(-1) || "";
}

test("session lifecycle: a new chat finishing after the user left the list stays in the background", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    const existing = await h.startChat("existing chat");
    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => !h.activeId(), 5000), "the panel never left the session");

    // session/new is held open while the user is already on the list.
    h.setDelays({ newDelay: 800 });
    h.send({ type: "send", text: "background chat", newSession: true });
    assert.ok(await h.until(() => h.agentSaw("session/new").length === 2, 10000), "session/new never went out");
    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => h.liveChats() === 2, 20000), "the background chat never finished");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId !== existing && lastPromptText(m) === "background chat"), 10000), "the submitted prompt never went out");
    await h.settle(200);

    const bgId = [...h.controller.runtimes.keys()].find((k) => k !== existing);
    assert.ok(bgId, "no second runtime was created");
    assert.strictEqual(h.activeId(), undefined, "the list still owns the panel");
    assert.strictEqual(h.store.viewing(), undefined, "no viewed session was recorded for a background chat");
    assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === bgId), "the background chat announced itself");
    const sent = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === bgId && lastPromptText(m) === "background chat");
    assert.strictEqual(sent.length, 1, "the submitted prompt ran once in the background");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: leaving while session defaults apply keeps the finished chat in the background", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "plan" } });
  try {
    await h.ready();
    const first = await h.startChat("first chat");
    // Hold every set_config_option the shared client prototype serves, so the
    // next session's applyDefaults parks midway through its creation.
    const proto = Object.getPrototypeOf(h.controller.runtimes.get(first).client);
    const original = proto.setConfigOption;
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    proto.setConfigOption = function (...args) {
      calls++;
      return gate.then(() => original.apply(this, args));
    };
    try {
      h.setDelays({ newDelay: 50 });
      h.send({ type: "send", text: "held defaults", newSession: true });
      // Wait until the new runtime exists and its defaults call is parked: the
      // id is already claimed by then, which is exactly the window the fix
      // guards.
      let rt2;
      assert.ok(await h.until(() => {
        rt2 = [...h.controller.runtimes.values()].find((r) => r.id && r.id !== first);
        return !!rt2 && calls > 0;
      }, 15000), "applyDefaults never reached setConfigOption");
      const newId = rt2.id;
      assert.strictEqual(h.activeId(), newId, "the creation claimed the panel");

      h.send({ type: "leaveToList" });
      assert.ok(await h.until(() => !h.activeId(), 5000), "the panel never left");
      release();
      assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === newId && lastPromptText(m) === "held defaults"), 15000), "the submitted prompt never went out");
      await h.settle(200);

      assert.strictEqual(h.activeId(), undefined, "the list still owns the panel");
      assert.strictEqual(h.store.viewing(), undefined, "no viewed session was recorded");
      assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === newId), "the finished chat announced itself after the user left");
      const sent = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === newId && lastPromptText(m) === "held defaults");
      assert.strictEqual(sent.length, 1, "the prompt ran once, on the runtime that created it");
    } finally {
      proto.setConfigOption = original;
      release?.();
    }
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: two rapid new chat intents run independent sessions with one prompt each", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    h.setDelays({ newDelay: 700 });
    h.send({ type: "send", text: "first intent", newSession: true });
    assert.ok(await h.until(() => h.agentSaw("session/new").length === 1, 10000), "the first session/new never went out");
    h.send({ type: "send", text: "second intent", newSession: true });
    assert.ok(await h.until(() => h.agentSaw("session/new").length === 2, 10000), "the second session/new never went out");
    assert.ok(await h.until(() => h.liveChats() === 2, 30000), "the second chat never finished");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").filter((m) => ["first intent", "second intent"].includes(lastPromptText(m))).length === 2, 15000), "both prompts never went out");
    await h.settle(200);

    const sent = h.agentSaw("session/prompt").filter((m) => ["first intent", "second intent"].includes(lastPromptText(m)));
    assert.strictEqual(sent.length, 2, "each submission prompted exactly once");
    const byText = Object.fromEntries(sent.map((m) => [lastPromptText(m), m.params.sessionId]));
    assert.notStrictEqual(byText["first intent"], byText["second intent"], "the two intents shared one session");
    assert.strictEqual(h.activeId(), byText["second intent"], "the later intent owns the panel");
    assert.ok(h.postsOf("sessionReady").some((m) => m.sessionId === byText["second intent"]), "the claimed chat announced itself");
    assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === byText["first intent"]), "the abandoned intent announced itself");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a send into a new chat waits out its defaults and lands once", posixOnly, async () => {
  const h = createChat({ config: { defaultMode: "plan" } });
  try {
    await h.ready();
    // Hold applyDefaults open on this controller only. The new session's
    // runtime is already claimed and in the pool when the gate parks, which is
    // the window a plain first message has to wait out.
    const originalDefaults = h.controller.applyDefaults.bind(h.controller);
    let releaseDefaults;
    const defaultsGate = new Promise((r) => { releaseDefaults = r; });
    let defaultsCalls = 0;
    h.controller.applyDefaults = async (rt, res) => {
      defaultsCalls++;
      await defaultsGate;
      return originalDefaults(rt, res);
    };
    try {
      h.send({ type: "newSession" });
      assert.ok(await h.until(() => defaultsCalls === 1, 15000), "creation never reached applyDefaults");
      const newId = h.activeId();
      assert.ok(newId, "the new session was never claimed");
      assert.ok(h.controller.runtimes.has(newId), "the runtime was not in the pool yet");

      h.send({ type: "send", text: "held first message" });
      await h.settle(200);
      assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "held first message").length, 0,
        "the message went out before the defaults finished");

      releaseDefaults();
      assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === newId && lastPromptText(m) === "held first message"), 15000), "the held message never went out");
      await h.settle(200);

      assert.strictEqual(h.agentSaw("session/new").length, 1, "more than one session was created");
      const rt = h.controller.runtimes.get(newId);
      assert.ok(rt, "the created runtime is gone");
      assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === newId && lastPromptText(m) === "held first message").length, 1,
        "the message did not reach the created session exactly once");
      assert.strictEqual((rt.log || []).filter((e) => e.type === "userMessage" && e.text === "held first message").length, 1,
        "the record does not hold the message exactly once");
    } finally {
      releaseDefaults?.();
    }
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a send during session/new reuses the creation it shares", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    h.setDelays({ newDelay: 800 });
    h.send({ type: "newSession" });
    assert.ok(await h.until(() => h.agentSaw("session/new").length === 1, 10000), "session/new never went out");
    // session/new is still held open, so this send has no runtime to aim at and
    // has to wait on the creation its navigation already started.
    h.send({ type: "send", text: "early first message" });
    assert.ok(await h.until(() => h.liveChats() === 1, 30000), "the shared creation never finished");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => lastPromptText(m) === "early first message"), 15000), "the early message never went out");
    await h.settle(200);

    assert.strictEqual(h.agentSaw("session/new").length, 1, "the send opened a second session");
    const id = h.activeId();
    assert.ok(id, "the shared creation never claimed the panel");
    const sent = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id && lastPromptText(m) === "early first message");
    assert.strictEqual(sent.length, 1, "the message did not reach the created session exactly once");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a first turn resend finishing after navigation stays in its own session", posixOnly, async () => {
  const h = createChat({
    promptDelay: 200,
    steps: [{ stepNumber: 1, kind: "prompt", userMessageId: "m1", revertTargetNodeId: 42, forkTargetNodeId: 43 }]
  });
  try {
    await h.ready();
    const a = await h.startChat("first turn in A");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "the first turn never settled");
    const b = await h.startChat("chat B");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "the second turn never settled");
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "session A never came back");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn in A")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");

    // The rewind is held inside the agent's revert/execute while the user picks B.
    const rtA = h.controller.runtimes.get(a);
    let releaseRewind;
    const rewindGate = new Promise((r) => { releaseRewind = r; });
    let rewindEntered = false;
    const agentExecute = rtA.client.revertExecute.bind(rtA.client);
    rtA.client.revertExecute = async (sessionId, userMessageId, opts) => {
      rewindEntered = true;
      await rewindGate;
      return agentExecute(sessionId, userMessageId, opts);
    };

    h.send({ type: "revertExecute", sessionId: a, userMessageId: mid, resendText: "edited first turn" });
    assert.ok(await h.until(() => rewindEntered, 15000), "the rewind never reached the agent");

    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "session B never came back");
    releaseRewind();
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === a && lastPromptText(m) === "edited first turn"), 20000), "the resend never went out");
    await h.settle(200);

    // The resend belongs to the session being rewound: it reached A exactly
    // once, B kept the selection, and no reverted trim was painted into it.
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === a && lastPromptText(m) === "edited first turn").length, 1,
      "the resend did not reach session A exactly once");
    assert.strictEqual(h.activeId(), b, "the rewind stole the selection");
    assert.strictEqual(h.postsOf("reverted").length, 0, "a reverted was painted into another session's transcript");
    assert.ok(h.postsOf("sessionHistoryChanged").some((m) => m.sessionId === a), "the rewound session was not marked changed");
    assert.strictEqual(h.agentSaw("session/new").length, 2, "the first turn edit created another session");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a new send detaches before readiness and a fast follow up cannot reach the old session", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  try {
    await h.ready();
    const existing = await h.startChat("existing chat");
    // Force the next send through a fresh health check and hold it open, which
    // is the window the synchronous detach has to survive.
    h.controller.health = undefined;
    const runHealthCheck = h.controller.runHealthCheck.bind(h.controller);
    let releaseHealth;
    const healthGate = new Promise((r) => { releaseHealth = r; });
    h.controller.runHealthCheck = async () => { await healthGate; await runHealthCheck(); };

    h.send({ type: "send", text: "first", newSession: true });
    // Health is still held, so these can only be the synchronous detach and
    // echo, not anything that waited on readiness.
    assert.ok(await h.until(() => h.activeId() === undefined && h.postsOf("userMessage").some((m) => m.text === "first"), 10000), "the detach and echo never landed while readiness was held");
    assert.strictEqual(h.activeId(), undefined, "the old session was not detached before readiness");
    assert.ok(h.postsOf("clear").some((m) => m.pendingSend === true), "the pending clear was not posted early");
    assert.ok(h.postsOf("userMessage").some((m) => m.text === "first"), "the echo was not posted early");

    // What the thread composer sends next while readiness is still held: a
    // plain send that must not be pointed at the session being left.
    h.send({ type: "send", text: "second", newSession: false });
    releaseHealth();
    assert.ok(await h.until(() => h.liveChats() === 2, 30000), "the new chat never finished");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").filter((m) => ["first", "second"].includes(lastPromptText(m))).length === 2, 15000), "both prompts never went out");
    await h.settle(200);

    const newId = [...h.controller.runtimes.keys()].find((k) => k !== existing);
    assert.ok(newId, "no new runtime was created");
    const onExisting = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === existing && ["first", "second"].includes(lastPromptText(m)));
    assert.strictEqual(onExisting.length, 0, "a send landed in the session being left");
    const onNew = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === newId && ["first", "second"].includes(lastPromptText(m)));
    assert.strictEqual(onNew.length, 2, "both sends reached the new session once each");
    assert.deepStrictEqual(onNew.map(lastPromptText).sort(), ["first", "second"]);
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a failed visible load returns to the list while a failed background load preserves the open chat", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    const existing = await h.startChat("existing chat");
    // Every loadWithTakeover parks on its own gate, so each failure is released
    // exactly when the test wants it.
    const gates = [];
    let entered = 0;
    h.controller.loadWithTakeover = () => {
      entered++;
      return new Promise((_, reject) => gates.push(() => reject(new Error("load blew up"))));
    };

    // The visible cold load fails: the runtime goes away, the panel returns to
    // the list, and the failure is diagnosed.
    h.send({ type: "loadSession", id: "ghost-visible" });
    assert.ok(await h.until(() => entered === 1, 15000), "the visible load never reached the agent seam");
    gates[0]();
    assert.ok(await h.until(() => !h.controller.runtimes.has("ghost-visible"), 10000), "the failed runtime was not removed");
    assert.ok(await h.until(() => h.activeId() === undefined && h.last("body")?.body === "list", 10000), "the panel did not return to the list");
    assert.ok(h.logs.some((l) => l.includes("[load-failed]")), "the failure was not diagnosed");
    assert.ok(globalThis.__dvVscode.window.shown.error.some((m) => m.includes("Couldn't open this session")), "the user was not told");

    // The same failure while another chat is on screen must not touch it.
    h.send({ type: "loadSession", id: "ghost-bg" });
    assert.ok(await h.until(() => entered === 2, 15000), "the background load never reached the agent seam");
    h.send({ type: "activateSession", id: existing });
    assert.ok(await h.until(() => h.activeId() === existing, 10000), "the existing chat never came back");
    const listBefore = h.postsOf("body").filter((m) => m.body === "list").length;
    gates[1]();
    assert.ok(await h.until(() => h.logs.some((l) => l.includes("[load-failed] ghost-bg (no longer on screen)")), 10000), "the background failure was not diagnosed");
    assert.strictEqual(h.activeId(), existing, "the background failure moved the panel");
    assert.ok(h.controller.runtimes.has(existing), "the open chat's runtime was removed");
    assert.ok(!h.controller.runtimes.has("ghost-bg"), "the failed runtime was not removed");
    assert.strictEqual(h.postsOf("body").filter((m) => m.body === "list").length, listBefore, "the panel was sent back to the list");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a send whose target was left mid readiness wakes it silently in the background", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, config: { idleSessionKeepAliveMinutes: 60 } });
  try {
    await h.ready();
    const b = await h.startChat("live chat B");
    const a = await h.startChat("exited chat A");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "A's turn never settled");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "B's turn never settled");

    // Age A past the reap window: it stays the panel's target as history but
    // its runtime is gone, which is the idle exited session a send wakes.
    const rtA = h.controller.runtimes.get(a);
    rtA.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
    h.controller.reapIdleRuntimes();
    assert.ok(await h.until(() => !h.controller.runtimes.has(a), 5000), "the idle runtime was not reaped");
    assert.strictEqual(h.activeId(), a, "the exited session is still the send's target");

    // Hold this send's readiness check open, pick B while it waits, then let it
    // go: the wake it starts must not steal the selection back.
    const originalEnsure = h.controller.ensureReady.bind(h.controller);
    let releaseReady;
    const readyGate = new Promise((r) => { releaseReady = r; });
    let ensureCalls = 0;
    h.controller.ensureReady = async () => { ensureCalls++; await readyGate; return originalEnsure(); };
    h.send({ type: "send", text: "text for A", preserveTranscript: true });
    assert.ok(await h.until(() => ensureCalls === 1, 10000), "the send never reached its readiness wait");
    h.controller.ensureReady = originalEnsure;
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "session B never came back");
    const readyBefore = h.postsOf("sessionReady").filter((m) => m.sessionId === a).length;
    releaseReady();

    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === a && lastPromptText(m) === "text for A"), 20000), "the woken send never went out");
    await h.settle(200);
    assert.strictEqual(h.activeId(), b, "the background wake stole the selection");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === a && lastPromptText(m) === "text for A").length, 1,
      "the submitted text did not reach A exactly once");
    assert.strictEqual(h.postsOf("sessionReady").filter((m) => m.sessionId === a).length, readyBefore, "the background wake announced itself");
    assert.ok(h.controller.runtimes.has(a), "the woken runtime did not stay in the pool");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a background wake during an in progress load waits for it instead of returning early", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, config: { idleSessionKeepAliveMinutes: 60 } });
  try {
    await h.ready();
    const b = await h.startChat("live chat B");
    const a = await h.startChat("exited chat A");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "A's turn never settled");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "B's turn never settled");

    // Age A past the reap window so its runtime is gone: an exited session a
    // background wake has to rebuild.
    const rtA = h.controller.runtimes.get(a);
    rtA.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
    h.controller.reapIdleRuntimes();
    assert.ok(await h.until(() => !h.controller.runtimes.has(a), 5000), "the idle runtime was not reaped");
    // B is the session left on screen while A wakes in the background.
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "session B never came back");

    // Hold the agent load open. The wake installs its runtime and its loading
    // entry before it gets there, which is the state a second wake used to
    // mistake for a ready session and return on immediately.
    const realLoad = h.controller.loadWithTakeover.bind(h.controller);
    let releaseLoad;
    const loadGate = new Promise((r) => { releaseLoad = r; });
    let loadCalls = 0;
    h.controller.loadWithTakeover = (rt, id, cwd) => {
      loadCalls++;
      return loadGate.then(() => realLoad(rt, id, cwd));
    };
    const first = h.controller.wakeSession(a, false);
    assert.ok(await h.until(() => loadCalls === 1 && h.controller.loading.has(a) && h.controller.runtimes.has(a), 15000),
      "the first wake never reached its in-flight load");

    // A second background wake for the same session shares that load. Before the
    // reorder it saw the installed runtime and returned at once, which let a
    // caller prompt a session still replaying its history.
    let secondResolved = false;
    const second = h.controller.wakeSession(a, false).then(() => { secondResolved = true; });
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(secondResolved, false, "the second wake returned before the load finished");
    assert.strictEqual(h.activeId(), b, "the background wake moved the selection");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === a && lastPromptText(m) === "for A").length, 0,
      "a prompt went out before the wake finished");

    releaseLoad();
    await Promise.all([first, second]);
    assert.ok(await h.until(() => h.controller.runtimes.has(a) && !h.controller.loading.has(a) && !h.controller.runtimes.get(a)?.waking, 10000),
      "the shared wake never completed");
    assert.strictEqual(loadCalls, 1, "the load ran twice");
    assert.strictEqual(h.agentSaw("session/load").filter((m) => m.params?.sessionId === a).length, 1, "the agent load ran twice");
    assert.strictEqual(h.activeId(), b, "the completed wake moved the selection");

    // The woken session takes a submitted message exactly once.
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "the woken session never came back");
    h.send({ type: "send", text: "for A" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === a && lastPromptText(m) === "for A"), 20000),
      "the submitted message never reached the woken session");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === a && lastPromptText(m) === "for A").length, 1,
      "the submitted message did not reach A exactly once");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a new session failing after navigation logs instead of posting an error", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  try {
    await h.ready();
    const a = await h.startChat("existing chat A");
    const b = await h.startChat("existing chat B");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "B's turn never settled");
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "session A never came back");

    // Park this controller's creation on a gate the test rejects later.
    let entered = 0;
    let rejectCreate;
    const createGate = new Promise((_, reject) => { rejectCreate = reject; });
    h.controller.createSession = async () => { entered++; await createGate; };
    h.send({ type: "newSession" });
    assert.ok(await h.until(() => entered === 1, 10000), "the held creation never started");
    assert.ok(h.postsOf("clear").some((m) => m.reset === true), "the new session clear never posted");

    // The user picks B while the creation is still parked, then it fails.
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "session B never came back");
    const errorsBefore = h.postsOf("error").length;
    const readyBefore = h.postsOf("sessionReady").length;
    rejectCreate(new Error("creation blew up"));
    assert.ok(await h.until(() => h.logs.some((l) => l.includes("[new-session] creation blew up")), 10000), "the failure was not logged");
    await h.settle(200);

    assert.strictEqual(h.postsOf("error").length, errorsBefore, "the failed creation posted an error into B's chat");
    assert.strictEqual(h.activeId(), b, "the failed creation moved the selection");
    assert.strictEqual(h.last("body")?.body, "thread", "the panel left B's thread");
    assert.ok(!h.controller.runtimes.get(b)?.busy, "B was left busy by the failed creation");
    assert.strictEqual(h.postsOf("sessionReady").length, readyBefore, "the failed creation announced a session");
    assert.ok(h.controller.runtimes.has(b), "B's runtime was removed");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a failed visible wake returns to the list while a failed background wake only logs", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, config: { idleSessionKeepAliveMinutes: 60 } });
  try {
    await h.ready();
    const a = await h.startChat("waking chat");
    const b = await h.startChat("live chat");
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "session A never came back");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "A's turn never settled");

    // Age A past the reap window so the next open takes the wake path, then
    // hold every wake's loadWithTakeover on its own gate.
    const rtA = h.controller.runtimes.get(a);
    rtA.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
    h.controller.reapIdleRuntimes();
    assert.ok(await h.until(() => !h.controller.runtimes.has(a), 5000), "the idle runtime was not reaped");

    const gates = [];
    let entered = 0;
    h.controller.loadWithTakeover = () => {
      entered++;
      return new Promise((_, reject) => gates.push(() => reject(new Error("wake blew up"))));
    };

    // The visible cold wake fails: the half spawned runtime goes away, the
    // panel returns to the list, and the failure is diagnosed.
    const visibleWake = h.webview._handler({ type: "wakeSession", id: a });
    assert.ok(await h.until(() => entered === 1, 15000), "the wake never reached the agent seam");
    assert.ok(await h.until(() => h.controller.runtimes.has(a), 5000), "the waking runtime never spawned");
    gates[0]();
    await visibleWake;
    assert.ok(await h.until(() => !h.controller.runtimes.has(a), 10000), "the failed wake runtime was not removed");
    assert.ok(await h.until(() => h.activeId() === undefined && h.last("body")?.body === "list", 10000), "the panel did not return to the list");
    assert.ok(h.logs.some((l) => l.includes("[load-failed]")), "the wake failure was not diagnosed");
    assert.ok(globalThis.__dvVscode.window.shown.error.some((m) => m.includes("Couldn't open this session")), "the user was not told");

    // The same failure while B is on screen must not touch it: only the log
    // learns about it, once the diagnostic line lands.
    h.send({ type: "wakeSession", id: a });
    assert.ok(await h.until(() => entered === 2, 15000), "the second wake never reached the agent seam");
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "session B never came back");
    const readyBefore = h.postsOf("sessionReady").length;
    gates[1]();
    assert.ok(await h.until(() => h.logs.some((l) => l.includes(`[wake-failed] ${a} (no longer on screen)`)), 10000), "the background wake failure was not logged");
    assert.strictEqual(h.activeId(), b, "the background failure moved the panel");
    assert.strictEqual(h.postsOf("sessionReady").length, readyBefore, "the background failure posted a sessionReady");
    assert.ok(h.controller.runtimes.has(b), "the open chat's runtime was removed");
    assert.ok(!h.controller.runtimes.has(a), "the failed wake runtime was not removed");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a failed live reload keeps the log partial, survives on an editor surface, and retries through ACP", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  try {
    await h.ready();
    const id = await h.startChat("reload me");
    const rt = h.controller.runtimes.get(id);
    await h.until(() => !rt.busy, 10000);
    // The local record is marked incomplete, so the next open takes the full
    // ACP path rather than the local replay seam.
    rt.logFull = false;
    const original = h.controller.loadWithTakeover.bind(h.controller);
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    h.controller.loadWithTakeover = async (runtime, sessionId, cwd) => {
      calls++;
      if (calls === 1) {
        await gate;
        throw new Error("load blew up");
      }
      return original(runtime, sessionId, cwd);
    };

    h.send({ type: "loadSession", id });
    assert.ok(await h.until(() => calls === 1, 15000), "the reload never reached the agent seam");
    release();
    assert.ok(await h.until(() => rt.logFull === false && h.last("body")?.body === "list", 10000), "the failed reload did not settle");
    assert.ok(h.controller.runtimes.has(id), "a live runtime was destroyed by a failed reload");
    assert.strictEqual(rt.logFull, false, "a failed replay left the log marked complete");

    // Retrying asks the agent again rather than trusting the same partial log.
    h.send({ type: "loadSession", id });
    assert.ok(await h.until(() => calls === 2, 15000), "the retry never reached the agent seam");
    assert.ok(await h.until(() => h.agentSaw("session/load").some((m) => m.params.sessionId === id), 15000), "the retry never issued session/load");
    assert.strictEqual(calls, 2, "the retry went somewhere other than ACP");
  } finally {
    await h.dispose();
  }

  // An editor surface has no list to fall back to: a failed live reload keeps
  // its target id so Retry still names the same session.
  const editor = createChat({ kind: "editor", promptDelay: 200 });
  try {
    await editor.ready();
    const id = await editor.startChat("editor reload");
    const rt = editor.controller.runtimes.get(id);
    await editor.until(() => !rt.busy, 10000);
    rt.logFull = false;
    editor.controller.loadWithTakeover = async () => { throw new Error("load blew up"); };
    editor.send({ type: "loadSession", id });
    assert.ok(await editor.until(() => editor.logs.some((l) => l.includes("[load-failed]")), 15000), "the editor reload failure was not diagnosed");
    await editor.settle(200);
    assert.strictEqual(editor.activeId(), id, "the editor surface lost its target id");
    assert.ok(editor.controller.runtimes.has(id), "the editor surface's runtime was removed");
    assert.strictEqual(rt.logFull, false, "a failed replay left the log marked complete");
  } finally {
    await editor.dispose();
  }
});

test("session lifecycle: reopening a live idle session replays its complete local log without a second ACP load", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, stepsDelay: 200, config: { defaultMode: "" } });
  try {
    await h.ready();
    const id = await h.startChat("big log session");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => !rt.busy, 10000), "the first turn never settled");
    // A transcript bigger than one replay batch, the way a long session's
    // painted log actually looks.
    for (let i = 0; i < 250; i++) {
      rt.log.push({ type: "userMessage", text: `painted ${i}` });
    }
    const expectedItems = rt.log.length + 1; // paintedReplay settles the last block
    const sessionLoads = () => h.agentSaw("session/load").filter((m) => m.params.sessionId === id).length;
    const loadsBefore = sessionLoads();
    const replaysBefore = h.postsOf("replay").length;
    const postsBefore = h.posted.length;
    const loadedBefore = h.postsOf("loaded").length;

    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => !h.activeId(), 5000), "the panel never left");
    h.send({ type: "loadSession", id });
    assert.ok(await h.until(() => h.postsOf("loaded").length > loadedBefore && h.activeId() === id, 10000), "the local replay never finished");
    await h.settle(200);

    assert.strictEqual(sessionLoads(), loadsBefore, "a second ACP load went out for a complete local log");
    const replays = h.postsOf("replay").slice(replaysBefore);
    const items = replays.flatMap((m) => m.items || []);
    assert.strictEqual(items.length, expectedItems, "every painted record replayed once");
    assert.ok(replays.every((m) => m.items.length <= 100), "the replay stayed in bounded batches");
    assert.strictEqual(Math.ceil(expectedItems / 100), replays.length, "the batches cover the log exactly");
    const lastReplay = h.posted.map((m, i) => (m.type === "replay" ? i : -1)).filter((i) => i >= postsBefore && i >= 0).at(-1);
    const loadedIdx = h.posted.findIndex((m, i) => i > (lastReplay ?? -1) && m.type === "loaded");
    assert.ok(lastReplay !== undefined && loadedIdx > lastReplay, "loaded did not follow the last replay batch");

    // Mark the log partial: the next open must ask the agent again.
    rt.logFull = false;
    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => !h.activeId(), 5000), "the panel never left");
    await h.webview._handler({ type: "loadSession", id });
    assert.ok(await h.until(() => sessionLoads() === loadsBefore + 1, 15000), "a partial log did not go through ACP");
    assert.ok(await h.until(() => h.activeId() === id, 10000), "the reloaded session never came back");

    // A successful rewind invalidates the local record: what follows must ask
    // the agent again rather than trust a transcript the rewind superseded.
    const revertedBefore = h.postsOf("reverted").length;
    await h.webview._handler({ type: "revertExecute", sessionId: id, userMessageId: "m-x" });
    assert.ok(await h.until(() => h.postsOf("reverted").length > revertedBefore, 10000), "the rewind never completed");
    assert.strictEqual(rt.log.length, 0, "the superseded transcript was kept");
    assert.strictEqual(rt.logFull, false, "the log still claimed to be complete");
    assert.deepStrictEqual(rt.bgBuffer, [], "the background buffer was kept");

    const loadsAfterRewind = sessionLoads();
    h.send({ type: "leaveToList" });
    assert.ok(await h.until(() => !h.activeId(), 5000), "the panel never left");
    h.send({ type: "loadSession", id });
    assert.ok(await h.until(() => sessionLoads() === loadsAfterRewind + 1, 15000), "the post rewind open trusted the invalidated log");
  } finally {
    await h.dispose();
  }
});

test("session lifecycle: a superseded activation does not post the old session's pending widgets", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, stepsDelay: 900, config: { defaultMode: "" } });
  try {
    await h.ready();
    const a = await h.startChat("chat a");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "chat a's turn never settled");
    const b = await h.startChat("chat b");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "chat b's turn never settled");

    // A is in the background with a permission request and a queued message
    // waiting to be re-surfaced on activation.
    const rtA = h.controller.runtimes.get(a);
    const permission = h.controller.requestPermission({
      sessionId: a,
      toolCall: { toolCallId: "perm-a", title: "run it", kind: "execute" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }]
    });
    permission.catch(() => {});
    h.controller.enqueueMessage(rtA, h.controller.pendingMessage("queued words", [], "queue"));
    const headsBefore = h.agentSaw("_cognition.ai/revert/listSteps").length;

    // Reactivate A while the agent's delay holds its turn head read open, then
    // B takes the panel while it is still in flight.
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/revert/listSteps").length > headsBefore, 10000), "the head read never went out");
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "B never took the panel");
    assert.ok(await h.until(() => rtA.stepsKnown, 10000), "A's held head read never settled");

    assert.strictEqual(h.postsOf("permission").length, 0, "A's pending permission painted into B's session");
    assert.ok(!h.postsOf("queued").some((m) => (m.items || []).some((i) => i.text === "queued words")), "A's queue rows painted into B's session");
    assert.strictEqual(h.activeId(), b, "the panel moved again");
    for (const p of [...rtA.pending]) {
      h.controller.resolvePermission(p.requestId, "cancelled");
    }
  } finally {
    await h.dispose();
  }
});

test("reported regressions: editing the first message rewinds to its checkpoint in the same session", posixOnly, async () => {
  const h = createChat({
    promptDelay: 200,
    steps: [{ stepNumber: 1, kind: "prompt", userMessageId: "m1", revertTargetNodeId: 42, forkTargetNodeId: 43 }]
  });
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");

    // The confirmation preview asks about the stable prompt id, on this session,
    // with no node id or execute flags.
    h.send({ type: "revertPreview", sessionId: id, userMessageId: mid, token: "p1" });
    assert.ok(await h.until(() => h.postsOf("revertPreview").some((m) => m.token === "p1"), 10000), "the preview never answered");
    const previewReq = h.agentSaw("_cognition.ai/revert/preview").at(-1);
    assert.deepStrictEqual(previewReq.params, { sessionId: id, userMessageId: mid }, "the preview did not carry exactly the scoped prompt id");

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited first turn" });
    assert.ok(await h.until(() => h.postsOf("reverted").some((m) => m.userMessageId === mid && m.resending === true), 15000), "the rewind never completed");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "edited first turn"), 15000), "the resend never went out");
    await h.settle(200);

    const executeReq = h.agentSaw("_cognition.ai/revert/execute").at(-1);
    assert.strictEqual(executeReq.params.sessionId, id, "the rewind hit another session");
    assert.strictEqual(executeReq.params.userMessageId, mid, "the rewind did not target the prompt's stable id");
    assert.strictEqual(executeReq.params.force, true);
    assert.strictEqual(executeReq.params.skipFileUndo, false);
    assert.strictEqual(h.activeId(), id, "the session changed under the edit");
    assert.strictEqual(h.agentSaw("session/new").length, 1, "editing the first message created a session");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id && lastPromptText(m) === "edited first turn").length, 1,
      "the resend did not reach the session exactly once");
    const echo = h.postsOf("userMessage").filter((m) => m.text === "edited first turn");
    assert.strictEqual(echo.length, 1, "the resend echo did not post exactly once");
    assert.ok(echo[0].clientMessageId, "the resend echo carries no dedupe id");
    assert.ok(h.postsOf("sessionHistoryChanged").some((m) => m.sessionId === id), "the rewound session was not marked changed");
  } finally {
    await h.dispose();
  }
});

test("reported regressions: editing the first message when the rewind fails keeps the conversation", posixOnly, async () => {
  const h = createChat({ promptDelay: 200, executeFail: true });
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");

    // The agent refuses the rewind: the edit must fail with the chat intact and
    // the resend text handed back, exactly like a checkpoint that cannot be read.
    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited first turn" });
    assert.ok(await h.until(() => h.postsOf("error").length > 0, 15000), "the refused rewind was not reported");
    await h.settle(200);

    assert.strictEqual(h.agentSaw("_cognition.ai/revert/execute").length, 1, "the rewind was not attempted");
    assert.strictEqual(h.agentSaw("session/new").length, 1, "the failed edit created a session");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "edited first turn").length, 0,
      "the resend went out anyway");
    assert.ok(h.postsOf("draft").some((m) => m.text === "edited first turn"), "the resend text was not handed back");
    assert.strictEqual(h.activeId(), id, "the session changed under the failed edit");
    const rt = h.controller.runtimes.get(id);
    assert.ok(rt && rt.log.length > 0, "the conversation record was cleared");
  } finally {
    await h.dispose();
  }
});

test("reported regressions: editing a later message still rewinds to its own checkpoint", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    h.send({ type: "send", text: "second turn" });
    // A plain send is dispatched asynchronously: waiting only for !busy can
    // return in the gap before the new turn flips it, so wait for the turn to
    // start and then settle.
    assert.ok(await h.until(() => h.controller.runtimes.get(id)?.busy, 10000), "the second turn never started");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the second turn never settled");
    const mid = h.postsOf("userMessage").filter((m) => m.text === "second turn").pop()?.clientMessageId;
    assert.ok(mid, "the second turn's echo carried no stable prompt id");

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "second try" });
    assert.ok(await h.until(() => h.postsOf("reverted").some((m) => m.userMessageId === mid), 15000), "the rewind never completed");
    await h.settle(200);

    const executeReq = h.agentSaw("_cognition.ai/revert/execute").at(-1);
    assert.strictEqual(executeReq.params.sessionId, id);
    assert.strictEqual(executeReq.params.userMessageId, mid, "a later turn's prompt id was not used as the target");
    assert.strictEqual(h.activeId(), id);
    assert.ok(h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "second try"), "the resend never went out");
    // The rewind kept the earlier turn: only the targeted prompt and what
    // followed it left the painted record.
    const rt = h.controller.runtimes.get(id);
    assert.ok(rt && !rt.log.some((p) => p.type === "userMessage" && p.clientMessageId === mid), "the rewound prompt stayed painted");
    assert.ok(rt && rt.log.some((p) => p.type === "userMessage" && p.text === "first turn"), "the earlier turn was discarded too");
  } finally {
    await h.dispose();
  }
});

test("reported regressions: restoring the first message keeps the same session", posixOnly, async () => {
  const h = createChat({
    promptDelay: 200,
    steps: [{ stepNumber: 1, kind: "prompt", userMessageId: "m1", revertTargetNodeId: 42, forkTargetNodeId: 43 }]
  });
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");
    const promptsBefore = h.agentSaw("session/prompt").length;

    // No resend: the rewind still targets the first prompt's checkpoint inside
    // this session, and nothing new is created or sent.
    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid });
    assert.ok(await h.until(() => h.postsOf("reverted").some((m) => m.userMessageId === mid && m.resending === false), 15000), "the rewind never completed");
    await h.settle(200);

    const executeReq = h.agentSaw("_cognition.ai/revert/execute").at(-1);
    assert.strictEqual(executeReq.params.sessionId, id);
    assert.strictEqual(executeReq.params.userMessageId, mid);
    assert.strictEqual(h.activeId(), id, "the restore moved the selection");
    assert.strictEqual(h.agentSaw("session/new").length, 1, "the restore created a session");
    assert.strictEqual(h.agentSaw("session/prompt").length, promptsBefore, "the restore sent a prompt");
  } finally {
    await h.dispose();
  }
});

test("reported regressions: the session list publishes a new live row before the remote listing answers", posixOnly, async () => {
  const h = createChat();
  let releaseList;
  let releaseDefaults;
  try {
    await h.ready();
    h.send({ type: "listVisible", value: true });
    // Hold the remote listing and the new session's defaults: the two waits the
    // old list used to sit behind before a started chat could be seen.
    const listGate = new Promise((r) => { releaseList = r; });
    h.controller.listOverProtocol = () => listGate.then(() => ({ sessions: [], prunedIds: [] }));
    const originalDefaults = h.controller.applyDefaults.bind(h.controller);
    const defaultsGate = new Promise((r) => { releaseDefaults = r; });
    h.controller.applyDefaults = async (rt, res) => {
      await defaultsGate;
      return originalDefaults(rt, res);
    };

    h.send({ type: "send", text: "listed first", newSession: true });
    assert.ok(await h.until(() => h.controller.runtimes.size === 1, 15000), "the creation never registered its runtime");
    const id = [...h.controller.runtimes.keys()][0];
    assert.ok(h.controller.runtimes.get(id)?.initializing, "the runtime never marked itself initializing");

    // The row is listed even though the remote listing has not answered.
    assert.ok(await h.until(() => h.postsOf("sessions").some((m) => (m.sessions || []).some((s) => s.id === id)), 10000),
      "the live row never reached the list while the remote listing was held");

    // Opening it while defaults are still held waits for readiness instead of
    // loading or creating another agent.
    h.send({ type: "activateSession", id });
    await h.settle(100);
    assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === id), "the half built session announced itself");
    releaseDefaults();
    assert.ok(await h.until(() => h.postsOf("sessionReady").some((m) => m.sessionId === id) && h.activeId() === id, 15000),
      "the session never finished activating");
    releaseList();
    await h.settle(200);

    assert.strictEqual(h.agentSaw("session/new").length, 1, "opening the row created another session");
    assert.strictEqual(h.agentSaw("session/load").length, 0, "opening the row reloaded the live session");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "listed first"), 15000),
      "the first prompt never went out");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id && lastPromptText(m) === "listed first").length, 1,
      "the first prompt went out more than once");
    // The send echoed twice, optimistically and canonically, under one dedupe
    // id: that pairing is what lets a returning view render it exactly once.
    const echoes = h.postsOf("userMessage").filter((m) => m.text === "listed first");
    assert.strictEqual(echoes.length, 2, "the send did not echo optimistically and canonically");
    assert.ok(echoes.every((m) => m.clientMessageId), "an echo carries no dedupe id");
    assert.strictEqual(echoes[0].clientMessageId, echoes[1].clientMessageId, "the two echoes carry different dedupe ids");
  } finally {
    releaseList?.();
    releaseDefaults?.();
    await h.dispose();
  }
});

test("review regressions: a reload retried while the failed load's cleanup still runs asks the agent again", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseClose;
  try {
    await h.ready();
    const id = await h.startChat("reload me");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => !rt.busy, 10000), "the first turn never settled");
    // The local record is marked incomplete, so the next open takes the full
    // ACP path rather than the local replay seam.
    rt.logFull = false;
    // Warm the list cache so the failed load's own return to the list does not
    // wait on a remote listing.
    await h.controller.refreshSessions(true);
    const original = h.controller.loadWithTakeover.bind(h.controller);
    let calls = 0;
    h.controller.loadWithTakeover = async (runtime, sessionId, cwd) => {
      calls++;
      if (calls === 1) {
        throw new Error("load blew up");
      }
      return original(runtime, sessionId, cwd);
    };
    // Hold the failed load's cleanup AFTER it has already returned the panel to
    // the list: the original loading promise is still in flight, which is the
    // window a fast retry used to be swallowed by.
    const closeOut = h.controller.closeOutSession.bind(h.controller);
    const closeGate = new Promise((r) => { releaseClose = r; });
    let closeEntered = 0;
    h.controller.closeOutSession = async (...args) => {
      closeEntered++;
      const result = await closeOut(...args);
      await closeGate;
      return result;
    };
    try {
      h.send({ type: "loadSession", id });
      assert.ok(await h.until(() => closeEntered === 1 && h.last("body")?.body === "list" && rt.logFull === false, 15000),
        "the failed load never reached the list");
      h.send({ type: "loadSession", id });
      assert.ok(await h.until(() => h.activeId() === id, 10000), "the retry never became active");
      await h.settle(50);
      assert.strictEqual(calls, 1, "the retry started its own agent load before the first one finished cleaning up");
      releaseClose();
      releaseClose = undefined;
      assert.ok(await h.until(() => calls === 2, 15000), "the retry never reached the agent seam");
      assert.ok(await h.until(() => h.agentSaw("session/load").some((m) => m.params.sessionId === id), 15000), "the retry never issued session/load");
    } finally {
      releaseClose?.();
    }
  } finally {
    await h.dispose();
  }
});

test("review regressions: a failed readiness check hands an edited resend back with its files and keeps a newer draft", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseHealth;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    h.send({ type: "attachImage", name: "edit-file.png", mime: "image/png", data: PNG });
    assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 10000), "the file never staged");

    // Hold the next health check open, then let it answer signed out: the
    // resend must go back to the chat rather than vanish with the failure.
    const healthGate = new Promise((r) => { releaseHealth = r; });
    let healthCalls = 0;
    h.controller.runHealthCheck = async () => {
      healthCalls++;
      await healthGate;
      h.controller.health = { found: false, loggedIn: false, path: "devin" };
    };
    h.controller.health = undefined;

    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");
    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await h.until(() => healthCalls >= 1, 15000), "the rewind never reached the readiness check");
    // A newer draft typed while readiness was out is preserved, not overwritten.
    h.store.setDraft(id, "typed while waiting");
    releaseHealth();
    releaseHealth = undefined;
    assert.ok(await h.until(() => h.store.draft(id) === "edited words\n\ntyped while waiting", 10000), "the resend was not handed back");
    assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).some((a) => a.label === "edit-file.png"), 10000), "the resend's file was not handed back");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/execute").length, 0, "the rewind ran without readiness");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "edited words").length, 0, "the resend went out anyway");
    assert.strictEqual(h.activeId(), id, "the session changed under the failed readiness");
  } finally {
    releaseHealth?.();
    await h.dispose();
  }
});

test("review regressions: a rewind finishing after its chat moved surfaces echoes and resends through the new owner", posixOnly, async () => {
  const a = createChat({ promptDelay: 200 });
  // B is built only once A's agents exist: a second harness rewrites the shared
  // vscode stub globals, and an agent spawned after that would log somewhere
  // `a.agentSaw` never reads.
  let b;
  let releaseRevert;
  try {
    await a.ready();
    const id = await a.startChat("first");
    assert.ok(await a.until(() => !a.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    // A second chat on A gives it a different selected session after the move.
    const other = await a.startChat("second");
    assert.ok(await a.until(() => !a.controller.runtimes.get(other)?.busy, 10000), "the second turn never settled");
    a.send({ type: "activateSession", id });
    assert.ok(await a.until(() => a.activeId() === id, 10000), "the first chat never came back");

    const rt = a.controller.runtimes.get(id);
    assert.ok(await a.until(() => !rt.replaying, 10000), "the transcript was still replaying");
    const mid = a.postsOf("userMessage").find((m) => m.text === "first")?.clientMessageId;
    assert.ok(mid, "the first turn's echo carried no stable prompt id");
    const originalRevert = rt.client.revertExecute.bind(rt.client);
    const revertGate = new Promise((r) => { releaseRevert = r; });
    let revertCalls = 0;
    rt.client.revertExecute = (...args) => {
      revertCalls++;
      return revertGate.then(() => originalRevert(...args));
    };

    a.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await a.until(() => revertCalls === 1, 15000), "the rewind never reached the agent");

    // Move the chat to B while the rewind is still on the wire, then put A on
    // its other chat: everything the rewind still has to say belongs to B.
    b = createChat({ promptDelay: 200 });
    await b.ready();
    const transfer = a.controller.exportRuntime(id);
    assert.ok(transfer, "the chat could not be handed over");
    await b.controller.importRuntime(transfer);
    a.send({ type: "activateSession", id: other });
    assert.ok(await a.until(() => a.activeId() === other, 10000), "A never selected its other chat");

    releaseRevert();
    releaseRevert = undefined;
    assert.ok(await b.until(() => b.postsOf("reverted").some((m) => m.userMessageId === mid && m.resending === true), 15000), "the rewind never completed on the new owner");
    assert.ok(await b.until(() => b.postsOf("userMessage").some((m) => m.text === "edited words"), 15000), "the resend echo never reached the new owner");
    await a.settle(200);

    assert.strictEqual(a.agentSaw("session/prompt").filter((m) => m.params.sessionId === id && lastPromptText(m) === "edited words").length, 1,
      "the resend did not reach the session exactly once");
    const echo = b.postsOf("userMessage").filter((m) => m.text === "edited words");
    assert.strictEqual(echo.length, 1, "the resend echo did not post exactly once on the new owner");
    assert.ok(echo[0].clientMessageId, "the resend echo carries no dedupe id");
    assert.ok(b.postsOf("sessionHistoryChanged").some((m) => m.sessionId === id), "the new owner was not told the history changed");
    assert.ok(!a.postsOf("userMessage").some((m) => m.text === "edited words"), "the echo painted into the old surface");
    assert.strictEqual(a.postsOf("reverted").length, 0, "the rewind notice painted into the old surface");
    // The scoped history notice DOES reach the old surface: it is what makes
    // its cached copy of this chat reload instead of resurrecting superseded
    // history. What must not cross is an unscoped trim, echo or error.
    assert.ok(a.postsOf("sessionHistoryChanged").some((m) => m.sessionId === id), "the old surface was not told to invalidate its cached copy");
    assert.strictEqual(a.activeId(), other, "the old surface's selection moved");
    assert.strictEqual(b.activeId(), id, "the new owner does not show the chat");
  } finally {
    releaseRevert?.();
    await b?.dispose();
    await a.dispose();
  }
});

test("review regressions: a new session that fails while opening returns the panel to the list", posixOnly, async () => {
  const h = createChat();
  let releaseDefaults;
  try {
    await h.ready();
    h.send({ type: "listVisible", value: true });
    const defaultsGate = new Promise((r) => { releaseDefaults = r; });
    let defaultsCalls = 0;
    h.controller.applyDefaults = async () => {
      defaultsCalls++;
      await defaultsGate;
      throw new Error("defaults blew up");
    };

    h.send({ type: "newSession" });
    assert.ok(await h.until(() => defaultsCalls === 1, 15000), "creation never reached applyDefaults");
    const rt = [...h.controller.runtimes.values()][0];
    assert.ok(rt?.initializing, "the runtime never marked itself initializing");
    const id = rt.id;
    // The row is already listed, so selecting it waits on the same readiness.
    assert.ok(await h.until(() => h.postsOf("sessions").some((m) => (m.sessions || []).some((s) => s.id === id)), 10000), "the live row never reached the list");
    h.send({ type: "activateSession", id });
    await h.settle(50);
    assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === id), "the half built session announced itself");

    releaseDefaults();
    releaseDefaults = undefined;
    assert.ok(await h.until(() => h.last("body")?.body === "list" && !h.controller.runtimes.has(id), 15000), "the failed creation never returned to the list");
    assert.ok(h.logs.some((l) => l.includes("[new-session-failed]")), "the failure was not diagnosed");
    assert.ok(!h.postsOf("sessionReady").some((m) => m.sessionId === id), "the failed session announced itself");
    assert.strictEqual(h.postsOf("error").length, 0, "the superseded creation posted an error");
    assert.strictEqual(h.activeId(), undefined, "the panel kept a dead session");
  } finally {
    releaseDefaults?.();
    await h.dispose();
  }
});

test("review regressions: an editor surface opening a failing new session gets the error in place", posixOnly, async () => {
  const editor = createChat({ kind: "editor" });
  let releaseDefaults;
  try {
    await editor.ready();
    const defaultsGate = new Promise((r) => { releaseDefaults = r; });
    let defaultsCalls = 0;
    editor.controller.applyDefaults = async () => {
      defaultsCalls++;
      await defaultsGate;
      throw new Error("defaults blew up");
    };

    editor.send({ type: "newSession" });
    assert.ok(await editor.until(() => defaultsCalls === 1, 15000), "creation never reached applyDefaults");
    const rt = [...editor.controller.runtimes.values()][0];
    assert.ok(rt?.initializing, "the runtime never marked itself initializing");
    const id = rt.id;
    editor.send({ type: "activateSession", id });
    await editor.settle(50);

    releaseDefaults();
    releaseDefaults = undefined;
    assert.ok(await editor.until(() => editor.postsOf("loaded").length > 0
      && editor.postsOf("error").some((m) => (m.text || "").includes("Couldn't open")), 15000), "the editor never learned the creation failed");
    assert.ok(editor.logs.some((l) => l.includes("[new-session-failed]")), "the failure was not diagnosed");
    assert.strictEqual(editor.activeId(), id, "the editor surface lost its target id");
    assert.ok(!editor.controller.runtimes.has(id), "the failed runtime was kept");
  } finally {
    releaseDefaults?.();
    await editor.dispose();
  }
});

test("review regressions: a failed creation does not disturb the chat selected after it", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseDefaults;
  try {
    await h.ready();
    const a = await h.startChat("chat a");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "chat a's turn never settled");
    const defaultsGate = new Promise((r) => { releaseDefaults = r; });
    let defaultsCalls = 0;
    h.controller.applyDefaults = async () => {
      defaultsCalls++;
      await defaultsGate;
      throw new Error("defaults blew up");
    };

    h.send({ type: "newSession" });
    assert.ok(await h.until(() => defaultsCalls === 1, 15000), "creation never reached applyDefaults");
    const rt = [...h.controller.runtimes.values()].find((r) => r.id !== a);
    assert.ok(rt?.initializing, "the runtime never marked itself initializing");
    const b = rt.id;
    // Opening the half built chat parks on its readiness, then the user picks
    // the chat that was already working instead.
    h.send({ type: "activateSession", id: b });
    await h.settle(50);
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "chat a never came back");

    releaseDefaults();
    releaseDefaults = undefined;
    await h.settle(200);

    assert.strictEqual(h.activeId(), a, "the failed creation moved the selection");
    assert.ok(!h.controller.runtimes.has(b), "the failed runtime was kept");
    assert.strictEqual(h.postsOf("error").length, 0, "the superseded creation posted an error");
    assert.ok(h.logs.some((l) => l.includes("[new-session-failed]")), "the failure was not diagnosed");
  } finally {
    releaseDefaults?.();
    await h.dispose();
  }
});

test("checkpoint identity: editing a middle message keeps the first turn, resends once and drops the third", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  try {
    await h.ready();
    const id = await h.startChat("FIRST");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the first turn never settled");
    h.send({ type: "send", text: "SECOND" });
    assert.ok(await h.until(() => h.controller.runtimes.get(id)?.busy, 10000), "the second turn never started");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the second turn never settled");
    h.send({ type: "send", text: "THIRD" });
    assert.ok(await h.until(() => h.controller.runtimes.get(id)?.busy, 10000), "the third turn never started");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the third turn never settled");

    const mids = Object.fromEntries(h.postsOf("userMessage").map((m) => [m.text, m.clientMessageId]));
    assert.ok(mids.FIRST && mids.SECOND && mids.THIRD, "every echo carried a stable prompt id");
    for (const mid of Object.values(mids)) {
      assert.match(mid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        "the prompt identity must be a UUID that can be shared with ACP");
    }
    const rt = h.controller.runtimes.get(id);

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mids.SECOND, resendText: "edited SECOND" });
    assert.ok(await h.until(() => h.postsOf("reverted").some((m) => m.userMessageId === mids.SECOND && m.resending === true), 15000), "the rewind never completed");
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "edited SECOND"), 15000), "the resend never went out");
    await h.settle(300);

    const executeReq = h.agentSaw("_cognition.ai/revert/execute").at(-1);
    assert.deepStrictEqual(executeReq.params, { sessionId: id, userMessageId: mids.SECOND, force: true, skipFileUndo: false },
      "the rewind did not carry exactly the scoped prompt id and execute flags");
    const resends = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id && lastPromptText(m) === "edited SECOND");
    assert.strictEqual(resends.length, 1, "the edited resend went out more than once");
    const resendId = resends[0].params._meta?.["cognition.ai/clientMessageId"];
    assert.ok(typeof resendId === "string" && resendId !== mids.SECOND && resendId !== mids.FIRST && resendId !== mids.THIRD,
      "the resend did not declare a fresh stable id");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "THIRD").length, 1,
      "the discarded turn was prompted again");

    // FIRST stays painted and the record still claims to be complete: the
    // retained prefix is the whole point of the scoped rewind.
    assert.ok(rt.log.some((p) => p.type === "userMessage" && p.clientMessageId === mids.FIRST), "FIRST left the painted record");
    assert.ok(!rt.log.some((p) => p.clientMessageId === mids.SECOND || p.clientMessageId === mids.THIRD), "SECOND or THIRD stayed painted");
    assert.strictEqual(rt.logFull, true, "the retained prefix was marked partial");
    const echo = h.postsOf("userMessage").filter((m) => m.text === "edited SECOND");
    assert.strictEqual(echo.length, 1, "the resend echo did not post exactly once");
    assert.strictEqual(echo[0].clientMessageId, resendId, "the echo id does not match the prompt metadata");
    assert.strictEqual(h.activeId(), id, "the session changed under the edit");
  } finally {
    await h.dispose();
  }
});

test("checkpoint identity: a rewind whose preview fails still releases the sends queued behind it", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releasePreview;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the turn's echo carried no stable prompt id");
    const rt = h.controller.runtimes.get(id);

    // Hold the preview open so a send can queue behind the rewind, then refuse
    // it: the mutation never happens and the queue must not stay locked.
    const previewGate = new Promise((r) => { releasePreview = r; });
    let previewCalls = 0;
    rt.client.revertPreview = (...args) => {
      previewCalls++;
      return previewGate.then(() => { throw new Error("preview blew up"); });
    };

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await h.until(() => previewCalls === 1, 15000), "the rewind never reached the preview");
    h.send({ type: "send", text: "queued behind" });
    await h.settle(150);
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "queued behind").length, 0,
      "the queued send went out while the rewind held the lock");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/execute").length, 0, "the rewind executed without a preview");

    releasePreview();
    releasePreview = undefined;
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "queued behind"), 15000),
      "the queued send never went out after the failed rewind");
    await h.settle(300);

    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "queued behind").length, 1,
      "the queued send went out more than once");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "edited words").length, 0,
      "the refused edit's resend went out anyway");
    assert.strictEqual(h.store.draft(id), "edited words", "the refused edit was not handed back");
    assert.ok(h.postsOf("error").length > 0, "the failed rewind was not reported");
    assert.strictEqual(rt.rewinding, undefined, "the rewind lock was left set");
    assert.strictEqual(h.activeId(), id, "the session changed under the failed rewind");
  } finally {
    releasePreview?.();
    await h.dispose();
  }
});

test("checkpoint identity: a rewind refused at readiness still releases the sends queued behind it", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseHealth;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the turn's echo carried no stable prompt id");
    const rt = h.controller.runtimes.get(id);

    // Hold the readiness check open so a send can queue behind the rewind,
    // then answer signed out: the mutation stops before the preview and the
    // queue must not stay locked behind a resend that will never come.
    const healthGate = new Promise((r) => { releaseHealth = r; });
    let healthCalls = 0;
    h.controller.runHealthCheck = async () => {
      healthCalls++;
      await healthGate;
      h.controller.health = { found: false, loggedIn: false, path: "devin" };
    };
    h.controller.health = undefined;

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await h.until(() => healthCalls >= 1, 15000), "the rewind never reached the readiness check");
    // A send typed through the composer would be refused at the same readiness
    // gate, so the queued message is put where handleSend would have put it:
    // on the runtime's queue, behind the rewind's lock.
    h.controller.enqueueMessage(rt, h.controller.pendingMessage("queued behind", []));
    await h.settle(150);
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "queued behind").length, 0,
      "the queued send went out while the rewind held the lock");

    releaseHealth();
    releaseHealth = undefined;
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "queued behind"), 15000),
      "the queued send never went out after the refused rewind");
    await h.settle(300);

    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "queued behind").length, 1,
      "the queued send went out more than once");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/preview").length, 0, "the preview ran without readiness");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/execute").length, 0, "the rewind ran without readiness");
    assert.strictEqual(h.agentSaw("session/prompt").filter((m) => lastPromptText(m) === "edited words").length, 0,
      "the refused edit's resend went out anyway");
    assert.strictEqual(h.store.draft(id), "edited words", "the refused edit was not handed back");
    assert.strictEqual(rt.rewinding, undefined, "the rewind lock was left set");
    assert.strictEqual(h.activeId(), id, "the session changed under the refused rewind");
  } finally {
    releaseHealth?.();
    await h.dispose();
  }
});

test("checkpoint identity: a successful rewind keeps its resend ahead of the sends queued behind it", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseRevert;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the turn's echo carried no stable prompt id");
    const rt = h.controller.runtimes.get(id);

    const revertGate = new Promise((r) => { releaseRevert = r; });
    let revertCalls = 0;
    const agentRevert = rt.client.revertExecute.bind(rt.client);
    rt.client.revertExecute = (...args) => {
      revertCalls++;
      return revertGate.then(() => agentRevert(...args));
    };

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await h.until(() => revertCalls === 1, 15000), "the rewind never reached the agent");
    h.send({ type: "send", text: "queued behind" });
    await h.settle(150);

    releaseRevert();
    releaseRevert = undefined;
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "queued behind"), 20000),
      "the queued send never went out");
    await h.settle(400);

    const prompts = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id).map(lastPromptText);
    const editedAt = prompts.indexOf("edited words");
    const queuedAt = prompts.indexOf("queued behind");
    assert.ok(editedAt !== -1 && queuedAt !== -1, "both prompts went out");
    assert.ok(editedAt < queuedAt, "the queued send overtook the edited resend");
    assert.strictEqual(prompts.filter((t) => t === "edited words").length, 1, "the resend went out twice");
    assert.strictEqual(prompts.filter((t) => t === "queued behind").length, 1, "the queued send went out twice");
  } finally {
    releaseRevert?.();
    await h.dispose();
  }
});

test("checkpoint identity: reopening a chat while its rewind runs publishes busy without another step read", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseRevert;
  try {
    await h.ready();
    const a = await h.startChat("chat a");
    assert.ok(await h.until(() => !h.controller.runtimes.get(a)?.busy, 10000), "chat a's turn never settled");
    const b = await h.startChat("chat b");
    assert.ok(await h.until(() => !h.controller.runtimes.get(b)?.busy, 10000), "chat b's turn never settled");
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "chat a never came back");
    const mid = h.postsOf("userMessage").find((m) => m.text === "chat a")?.clientMessageId;
    assert.ok(mid, "chat a's echo carried no stable prompt id");

    const rtA = h.controller.runtimes.get(a);
    const revertGate = new Promise((r) => { releaseRevert = r; });
    let revertCalls = 0;
    const agentRevert = rtA.client.revertExecute.bind(rtA.client);
    rtA.client.revertExecute = (...args) => {
      revertCalls++;
      return revertGate.then(() => agentRevert(...args));
    };
    const listsFor = () => h.agentSaw("_cognition.ai/revert/listSteps").filter((m) => m.params.sessionId === a).length;

    h.send({ type: "revertExecute", sessionId: a, userMessageId: mid, resendText: "edited a" });
    assert.ok(await h.until(() => revertCalls === 1, 15000), "the rewind never reached the agent");

    // Away and back while the mutation is held: the activation must publish the
    // busy checkpoint state it already knows, not start a competing step read.
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "chat b never came back");
    const listsBefore = listsFor();
    h.send({ type: "activateSession", id: a });
    assert.ok(await h.until(() => h.activeId() === a, 10000), "chat a never reopened");
    await h.settle(400);

    assert.strictEqual(listsFor(), listsBefore, "the activation started a step read over the rewind");
    assert.ok(h.postsOf("checkpoints").some((m) => m.sessionId === a && m.busy === true),
      "the busy checkpoint state never published on activation");

    // And when the rewind finishes elsewhere, the selection stays where the
    // user put it rather than being dragged back to the rewound chat.
    h.send({ type: "activateSession", id: b });
    assert.ok(await h.until(() => h.activeId() === b, 10000), "chat b never came back again");
    releaseRevert();
    releaseRevert = undefined;
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === a && lastPromptText(m) === "edited a"), 20000),
      "the resend never went out");
    await h.settle(300);
    assert.strictEqual(h.activeId(), b, "the finished rewind stole the selection");
    assert.strictEqual(h.postsOf("reverted").length, 0, "a reverted painted into another session's transcript");
  } finally {
    releaseRevert?.();
    await h.dispose();
  }
});

test("checkpoint identity: a repeated rewind is ignored and a different edit waits its turn", posixOnly, async () => {
  const h = createChat({ promptDelay: 200 });
  let releaseRevert;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const mid = h.postsOf("userMessage").find((m) => m.text === "first turn")?.clientMessageId;
    assert.ok(mid, "the turn's echo carried no stable prompt id");
    const rt = h.controller.runtimes.get(id);

    const revertGate = new Promise((r) => { releaseRevert = r; });
    let revertCalls = 0;
    const agentRevert = rt.client.revertExecute.bind(rt.client);
    rt.client.revertExecute = (...args) => {
      revertCalls++;
      return revertGate.then(() => agentRevert(...args));
    };

    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    assert.ok(await h.until(() => revertCalls === 1, 15000), "the rewind never reached the agent");

    // The exact same request again is the same operation, not a second one.
    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "edited words" });
    await h.settle(200);
    assert.strictEqual(revertCalls, 1, "the duplicate rewind reached the agent");

    // A different edit cannot join the locked operation: it is handed back
    // rather than queued behind a mutation it does not belong to.
    h.send({ type: "revertExecute", sessionId: id, userMessageId: mid, resendText: "other edit" });
    await h.settle(200);
    assert.strictEqual(revertCalls, 1, "the different edit reached the agent");
    assert.ok(h.postsOf("error").some((m) => /current checkpoint action/.test(m.text)),
      "the locked-out edit was not told to wait");
    assert.strictEqual(h.store.draft(id), "other edit", "the different edit was not handed back");

    releaseRevert();
    releaseRevert = undefined;
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => m.params.sessionId === id && lastPromptText(m) === "edited words"), 20000),
      "the resend never went out");
    await h.settle(300);
    const prompts = h.agentSaw("session/prompt").filter((m) => m.params.sessionId === id).map(lastPromptText);
    assert.strictEqual(prompts.filter((t) => t === "edited words").length, 1, "the resend went out twice");
    assert.strictEqual(prompts.filter((t) => t === "other edit").length, 0, "the handed back edit went out anyway");
  } finally {
    releaseRevert?.();
    await h.dispose();
  }
});

test("checkpoint identity: a fork read raced by a new prompt does not fork a stale node", posixOnly, async () => {
  const h = createChat({
    promptDelay: 150,
    steps: [{ stepNumber: 1, kind: "prompt", userMessageId: "m-old", revertTargetNodeId: 9, forkTargetNodeId: 10 }]
  });
  let releaseList;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const rt = h.controller.runtimes.get(id);

    // Hold the fork's step read open, land a fresh prompt while it is out (the
    // turn start bumps the steps revision), then let the read answer: the node
    // it found belongs to a conversation that has already moved on.
    const listGate = new Promise((r) => { releaseList = r; });
    let listCalls = 0;
    const agentList = rt.client.listRevertSteps.bind(rt.client);
    rt.client.listRevertSteps = (...args) => {
      listCalls++;
      return listGate.then(() => agentList(...args));
    };
    let forkCalls = 0;
    const agentFork = rt.client.revertForkFromStep.bind(rt.client);
    rt.client.revertForkFromStep = (...args) => {
      forkCalls++;
      return agentFork(...args);
    };

    h.send({ type: "revertFork", sessionId: id, userMessageId: "m-old" });
    assert.ok(await h.until(() => listCalls >= 1, 15000), "the fork never read the step list");
    h.send({ type: "send", text: "fresh prompt" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").some((m) => lastPromptText(m) === "fresh prompt"), 15000), "the fresh prompt never went out");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 15000), "the fresh prompt never settled");

    releaseList();
    releaseList = undefined;
    assert.ok(await h.until(() => h.postsOf("error").some((m) => /changed while the fork/.test(m.text)), 15000),
      "the stale fork read was not refused");
    await h.settle(300);
    assert.strictEqual(forkCalls, 0, "the fork reached the agent on a stale node");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/forkFromStep").length, 0, "a fork went out on the wire");
    assert.strictEqual(h.activeId(), id, "the session changed under the refused fork");
  } finally {
    releaseList?.();
    await h.dispose();
  }
});

test("checkpoint boundary: fork uses the boundary before the selected message", posixOnly, async () => {
  const h = createChat({ promptDelay: 100, forkId: "checkpoint-fork" });
  try {
    await h.ready();
    const id = await h.startChat("FIRST");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => !rt.busy && rt.stepsKnown, 10000));
    for (const text of ["SECOND", "THIRD"]) {
      const before = h.agentSaw("session/prompt").length;
      h.send({ type: "send", text });
      assert.ok(await h.until(() => h.agentSaw("session/prompt").length > before && !rt.busy && rt.stepsKnown, 10000));
    }
    const mids = Object.fromEntries(h.postsOf("userMessage").map((m) => [m.text, m.clientMessageId]));
    assert.ok(mids.FIRST && mids.SECOND && mids.THIRD);
    const sourceLog = JSON.parse(JSON.stringify(rt.log));
    rt.client.listRevertSteps = async () => [
      { stepNumber: 1, kind: "prompt", userMessageId: mids.FIRST, revertTargetNodeId: 10, forkTargetNodeId: 20 },
      { stepNumber: 2, kind: "prompt", userMessageId: mids.SECOND, revertTargetNodeId: 20, forkTargetNodeId: 30 },
      { stepNumber: 3, kind: "prompt", userMessageId: mids.THIRD, revertTargetNodeId: 30, forkTargetNodeId: 40 }
    ];
    h.send({ type: "revertFork", sessionId: id, userMessageId: mids.SECOND });
    assert.ok(await h.until(() => h.agentSaw("_cognition.ai/revert/forkFromStep").length === 1, 10000));
    assert.deepStrictEqual(h.agentSaw("_cognition.ai/revert/forkFromStep")[0].params, { sessionId: id, targetNodeId: 20 });
    assert.ok(await h.until(() => h.activeId() === "checkpoint-fork", 10000));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rt.log)), sourceLog, "fork leaves all original turns and tool results unchanged");
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/execute").length, 0);
    assert.strictEqual(h.agentSaw("_cognition.ai/revert/preview").length, 0);
    assert.strictEqual(h.agentSaw("session/prompt").length, 3, "fork does not resend any prompt");
  } finally {
    await h.dispose();
  }
});

test("checkpoint identity: a newer step push beats an older list read", posixOnly, async () => {
  const h = createChat({
    promptDelay: 200,
    steps: [{ stepNumber: 1, kind: "prompt", userMessageId: "m-old", revertTargetNodeId: 9, forkTargetNodeId: 10 }]
  });
  let releaseList;
  try {
    await h.ready();
    const id = await h.startChat("first turn");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const rt = h.controller.runtimes.get(id);

    // Gate the list read, deliver the agent's push while it is out, then let
    // the older answer arrive: the push is the newer word on the conversation
    // and must be what the bindings publish.
    const listGate = new Promise((r) => { releaseList = r; });
    let listCalls = 0;
    const agentList = rt.client.listRevertSteps.bind(rt.client);
    rt.client.listRevertSteps = (...args) => {
      listCalls++;
      return listGate.then(() => agentList(...args));
    };

    void h.controller.refreshCheckpoints(rt, true);
    assert.ok(await h.until(() => listCalls === 1, 15000), "the gated read never went out");
    rt.client.emit("revertSteps", {
      sessionId: id,
      steps: [{ stepNumber: 2, kind: "prompt", userMessageId: "m-push", revertTargetNodeId: 20, forkTargetNodeId: 21 }]
    });
    await h.settle(100);
    releaseList();
    releaseList = undefined;
    await h.settle(300);

    const last = h.postsOf("checkpoints").filter((m) => m.sessionId === id).at(-1);
    assert.ok(last, "no checkpoint frame was published");
    assert.deepStrictEqual(last.checkpoints.map((c) => c.userMessageId), ["m-push"],
      "the older list read overwrote the newer push");
    assert.strictEqual(rt.steps[0]?.userMessageId, "m-push", "the runtime kept the stale step list");
  } finally {
    releaseList?.();
    await h.dispose();
  }
});

test("checkpoint identity: a replayed prompt's client id becomes the chunk's message id", posixOnly, async () => {
  // Replay reports the stable prompt id through _meta, not the standard
  // messageId: the painted record must key on it or the turn can never bind.
  const h = createChat({
    loadUpdates: [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old prompt" }, messageId: "node-1", _meta: { "cognition.ai/clientMessageId": "m-replay" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" }, messageId: "a-1" }
    ]
  });
  try {
    await h.ready();
    h.store.add("stored", h.cwd);
    h.send({ type: "loadSession", id: "stored" });
    assert.ok(await h.until(() => h.activeId() === "stored", 15000), "the stored session never opened");
    assert.ok(await h.until(() => h.postsOf("sessionReady").some((m) => m.sessionId === "stored"), 15000), "the replay never finished");
    await h.settle(300);

    const rt = h.controller.runtimes.get("stored");
    assert.ok(rt, "the session has no runtime");
    assert.ok(rt.log.some((p) => p.type === "userChunk" && p.messageId === "m-replay"),
      "the replayed prompt did not paint under its stable id");
    assert.ok(!rt.log.some((p) => p.type === "userChunk" && p.messageId === "node-1"),
      "the raw node id was painted as the prompt id");
    // The replay batches carry the same painted entries to the page.
    const replayed = h.postsOf("replay").flatMap((m) => m.items || []);
    assert.ok(replayed.some((item) => item.type === "userChunk" && item.messageId === "m-replay"),
      "the webview never saw the stable id");
  } finally {
    await h.dispose();
  }
});

test("checkpoint identity: unsupported agents settle readiness without a step read", posixOnly, async () => {
  const h = createChat({ noRevertByUserMessageId: true, promptDelay: 200 });
  try {
    await h.ready();
    const id = await h.startChat("hello");
    assert.ok(await h.until(() => !h.controller.runtimes.get(id)?.busy, 10000), "the turn never settled");
    const rt = h.controller.runtimes.get(id);
    const before = h.agentSaw("_cognition.ai/revert/listSteps").length;

    await h.controller.refreshCheckpoints(rt);

    assert.strictEqual(h.agentSaw("_cognition.ai/revert/listSteps").length, before,
      "an unsupported agent received a checkpoint query");
    const frame = h.postsOf("checkpoints").filter((m) => m.sessionId === id).at(-1);
    assert.ok(frame, "the checkpoint readiness state never settled");
    assert.strictEqual(frame.busy, false, "a cached wake would remain marked as pending");
    assert.deepStrictEqual(frame.checkpoints, []);
    assert.strictEqual(h.postsOf("capabilities").at(-1).revert, false,
      "an unsupported agent offered checkpoint controls");
  } finally {
    await h.dispose();
  }
});

// --- Message persistence ---------------------------------------------------
// Queued messages and the manifest of what each sent request displayed are kept
// per session on disk, so a restart, a wake or a move between surfaces puts back
// exactly what the user had: the queue paused until Resume Queue, and sent
// requests rebuilt from the saved manifest rather than guessed from text.

const IMG_A = PNG;
const IMG_B = "aGVsbG8td29ybGQtcGl4ZWw=";
const IMPLICIT_NOTE = { type: "text", text: "implicit note for the queue" };

for (const end of ["shutdown", "dispose"]) {
  test(`message persistence restores a queued message after ${end}`, posixOnly, async () => {
    const h = createChat({ promptGate: true });
    await h.ready();
    const id = await h.startChat("the turn");
    await h.until(() => h.postsOf("busy").some((m) => m.value));
    // A fixed nonempty implicit snapshot, so the restore proves the whole
    // queued message travelled rather than just its text and attachments.
    h.controller.buildImplicitBlocks = () => [IMPLICIT_NOTE];

    h.send({ type: "attachImage", name: "queued.png", mime: "image/png", data: IMG_A });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
    h.send({ type: "send", text: "first queued" });
    await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);

    h.send({ type: "attachDroppedText", name: "notes.txt", text: "the dropped file's contents" });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
    h.send({ type: "send", text: "second queued" });
    await h.until(() => (h.last("queued") || { items: [] }).items.length === 2);

    // The second row moves to the front, then is edited through the composer.
    let items = h.last("queued").items;
    h.send({ type: "reorderQueued", id: items[1].id, targetId: items[0].id, before: true });
    items = h.last("queued").items;
    const head = items[0];
    assert.strictEqual(head.text, "second queued");
    const queuedIds = items.map((q) => q.id);
    h.send({ type: "queueEditing", id: head.id });
    h.send({ type: "attachImage", name: "added-while-editing.png", mime: "image/png", data: IMG_A });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 2);
    h.send({ type: "editQueued", id: head.id, text: "second queued, edited" });
    h.send({ type: "queueEditing", id: null });
    // A draft of its own, so the restore cannot confuse the two.
    h.send({ type: "draft", id, text: "composer draft, not queued" });
    await h.until(() => h.store.draft(id) === "composer draft, not queued");

    if (end === "shutdown") {
      await h.controller.shutdown();
    } else {
      h.controller.dispose();
    }
    await h.dispose();

    const next = createChat({
      storage: h.storage,
      cwd: h.cwd,
      state: Object.fromEntries(h.state.__map),
      promptGate: true
    });
    try {
      await next.ready();
      next.send({ type: "loadSession", id });
      assert.ok(await next.until(() => {
        const q = next.last("queued");
        return next.activeId() === id && q && q.paused === true && (q.items || []).length === 2;
      }, 8000), "the saved queue came back paused");

      const restored = next.last("queued").items;
      assert.deepStrictEqual(restored.map((q) => q.id), queuedIds, "the same rows came back in the same order");
      assert.deepStrictEqual(restored.map((q) => q.text), ["second queued, edited", "first queued"]);
      assert.deepStrictEqual(restored.map((q) => q.kind), ["queue", "queue"]);
      assert.deepStrictEqual(
        restored.map((q) => (q.attachments || []).map((a) => a.label)),
        [["notes.txt", "added-while-editing.png"], ["queued.png"]]
      );

      const rt = next.controller.runtimes.get(id);
      assert.ok(rt, "the session has a runtime after load");
      const stored = rt.messages.queued;
      assert.deepStrictEqual(stored.map((q) => q.id), queuedIds);
      assert.deepStrictEqual(stored.map((q) => q.text), ["second queued, edited", "first queued"]);
      const headBlocks = stored[0].attachments.map((a) => a.block);
      assert.strictEqual(headBlocks.filter((b) => b.type === "image" && b.data === IMG_A).length, 1,
        "the head row's image kept its bytes");
      assert.ok(headBlocks.some((b) => b.type === "text" && b.text.includes("the dropped file's contents")),
        "the dropped file's contents survived");
      assert.strictEqual(stored[1].attachments[0].block.data, IMG_A);
      assert.deepStrictEqual(stored.map((q) => q.implicit), [[IMPLICIT_NOTE], [IMPLICIT_NOTE]],
        "the implicit snapshots travelled unchanged");
      assert.strictEqual(next.agentSaw("session/prompt").length, 0, "the restore itself sent nothing");
      assert.strictEqual(next.store.draft(id), "composer draft, not queued", "the draft stayed a draft");

      // Editing a restored row hands its attachments back. The fresh attach must
      // not collide with the ids the restore brought back.
      next.send({ type: "queueEditing", id: restored[0].id });
      await next.until(() => ((next.last("attachments") || {}).items || []).length === 2);
      next.send({ type: "attachImage", name: "post-restore.png", mime: "image/png", data: IMG_A });
      await next.until(() => ((next.last("attachments") || {}).items || []).length === 3);
      const stagedIds = (next.last("attachments").items || []).map((a) => a.id);
      assert.strictEqual(new Set(stagedIds).size, stagedIds.length, "restored and fresh attachment ids are unique");
      next.send({ type: "editQueued", id: restored[0].id, text: "second queued, edited twice" });
      next.send({ type: "queueEditing", id: null });
      assert.ok(await next.until(() => (next.last("queued") || { items: [] }).items[0]?.text === "second queued, edited twice"),
        "the edit committed while paused");
      assert.strictEqual(next.last("queued").paused, true, "and the queue stayed paused");

      next.send({ type: "resumeQueue" });
      assert.ok(await next.until(() => next.agentSaw("session/prompt").length === 1, 8000), "the first restored message went out");
      const first = next.agentSaw("session/prompt")[0].params.prompt;
      assert.strictEqual(first.at(-1).text, "second queued, edited twice");
      assert.strictEqual(first[0].text, IMPLICIT_NOTE.text, "the implicit snapshot led the wire prompt");
      assert.strictEqual(first.filter((b) => b.type === "image" && b.data === IMG_A).length, 2,
        "every attachment image went once, with its bytes");
      assert.ok(first.some((b) => b.type === "text" && b.text.includes("the dropped file's contents")));
      next.releasePrompt(id, 1);
      assert.ok(await next.until(() => next.agentSaw("session/prompt").length === 2, 8000), "the second followed in order");
      const second = next.agentSaw("session/prompt")[1].params.prompt;
      assert.strictEqual(second.at(-1).text, "first queued");
      assert.strictEqual(second[0].text, IMPLICIT_NOTE.text);
      assert.strictEqual(second.filter((b) => b.type === "image").length, 1);
      next.releasePrompt(id, 2);
      assert.ok(await next.until(() => next.postsOf("busy").some((m) => m.value === false), 8000));
      assert.deepStrictEqual((next.last("queued") || { items: [] }).items, [], "the queue drained");

      await next.controller.shutdown();
      await next.dispose();

      const third = createChat({
        storage: h.storage,
        cwd: h.cwd,
        state: Object.fromEntries(next.state.__map)
      });
      try {
        await third.ready();
        third.send({ type: "loadSession", id });
        assert.ok(await third.until(() => third.postsOf("loaded").length > 0, 8000), "the cold load finished");
        const q3 = third.last("queued");
        assert.ok(q3 && (q3.items || []).length === 0, "nothing already sent came back queued");
        assert.strictEqual(q3.paused, false, "and the drained queue is not paused");
        const rt3 = third.controller.runtimes.get(id);
        assert.ok(rt3, "the session has a runtime after load");
        assert.strictEqual(rt3.messages.sent.length, 2, "the sent manifest survived the cold restore");
      } finally {
        await third.dispose();
      }
    } finally {
      await next.dispose();
    }
  });
}

test("message persistence restores sent attachments on load, wake and transfer", posixOnly, async () => {
  const h = createChat({ promptDelay: 150 });
  await h.ready();
  const id = await h.startChat("warmup");
  assert.ok(await h.until(() => prompts(h).length === 1, 8000));
  const idle = () => h.until(() => {
    const rt = h.controller.runtimes.get(id);
    return !!rt && rt.busy === false;
  }, 8000);
  assert.ok(await idle(), "the warmup turn ends");

  fs.writeFileSync(path.join(h.cwd, "notes.txt"), "the notes file contents");
  const TEXT = "same typed text";
  const sentBlocks = () => h.agentSaw("session/prompt").slice(1).map((m) => m.params.prompt);
  const stageAll = async (imageName, imageData) => {
    h.send({ type: "addMention", path: path.join(h.cwd, "notes.txt") });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
    h.send({ type: "attachImage", name: imageName, mime: "image/png", data: imageData });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 2);
    h.send({ type: "attachDroppedText", name: "dropped.txt", text: "dropped file contents" });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 3);
    h.controller.stagedFor(id).push({
      id: `att-sel-${imageName}`, label: "pick.ts:1-2", type: "selection",
      block: { type: "text", text: "From pick.ts lines 1-2:\n\n```ts\nconst x = 1;\n```" }
    });
    h.controller.stagedChanged(id);
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 4);
  };

  // Three sends of the same typed text: the first and third carry byte
  // identical blocks (only the image label differs), the second different ones,
  // so plain text matching could never tell them apart.
  await stageAll("first.png", IMG_A);
  h.send({ type: "send", text: TEXT });
  assert.ok(await h.until(() => sentBlocks().length === 1, 8000));
  await idle();

  h.send({ type: "attachImage", name: "second.png", mime: "image/png", data: IMG_B });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: TEXT });
  assert.ok(await h.until(() => sentBlocks().length === 2, 8000));
  await idle();

  await stageAll("renamed.png", IMG_A);
  h.send({ type: "send", text: TEXT });
  assert.ok(await h.until(() => sentBlocks().length === 3, 8000));
  await idle();

  const captured = sentBlocks();
  assert.strictEqual(captured.length, 3);
  await h.dispose();

  // Replay the captured blocks as history, each user message split over two
  // chunks so the accumulation path is exercised, with agent chunks between.
  const updates = [];
  captured.forEach((blocks, i) => {
    const mid = blocks.length >> 1;
    updates.push({ sessionUpdate: "user_message_chunk", messageId: `u-${i}`, content: blocks.slice(0, mid) });
    updates.push({ sessionUpdate: "user_message_chunk", messageId: `u-${i}`, content: blocks.slice(mid) });
    updates.push({ sessionUpdate: "agent_message_chunk", messageId: `a-${i}`, content: { type: "text", text: `reply ${i}` } });
  });
  // The memento carried over, minus the "which chat was on screen" markers:
  // ready() reopens that chat by itself, which would race the explicit load
  // below and the transfer's import, so each surface here opens only when asked.
  const carried = (from) => {
    const state = Object.fromEntries(from.state.__map);
    delete state["devin.viewingSession.v1"];
    delete state["devin.activeSession.v1"];
    return state;
  };
  const next = createChat({
    storage: h.storage,
    cwd: h.cwd,
    state: carried(h),
    loadUpdates: updates
  });
  try {
    await next.ready();
    next.send({ type: "loadSession", id });
    // Replayed transcript arrives in batches, not as top level userChunk posts.
    const replayedUserChunks = () => next.postsOf("replay")
      .flatMap((m) => m.items || []).filter((p) => p.type === "userChunk");
    assert.ok(await next.until(() => replayedUserChunks().length === 3, 8000), "three user chunks replayed");
    const chunks = replayedUserChunks();
    assert.deepStrictEqual(chunks.map((c) => c.text), [TEXT, TEXT, TEXT], "the typed text, not rebuilt content");
    assert.deepStrictEqual(chunks.map((c) => c.messageId), ["u-0", "u-1", "u-2"]);
    assert.deepStrictEqual(chunks[0].attachments.map((a) => a.label),
      ["notes.txt", "first.png", "dropped.txt", "pick.ts:1-2"]);
    assert.strictEqual(chunks[0].attachments[1].thumb, `data:image/png;base64,${IMG_A}`);
    assert.deepStrictEqual(chunks[1].attachments.map((a) => a.label), ["second.png"]);
    assert.strictEqual(chunks[1].attachments[0].thumb, `data:image/png;base64,${IMG_B}`);
    // The repeated blocks matched in send order: the third group took the third
    // record's labels, not the first record's identical key.
    assert.deepStrictEqual(chunks[2].attachments.map((a) => a.label),
      ["notes.txt", "renamed.png", "dropped.txt", "pick.ts:1-2"]);
    assert.ok(!JSON.stringify(chunks).includes("the notes file contents"), "no file contents leaked into the display");

    // A silent wake replays the same history against the same manifest. The
    // agent dies without a terminate round trip, the path that must not prune
    // the saved records.
    const dead = next.controller.runtimes.get(id);
    assert.ok(dead, "the loaded session has a runtime");
    next.controller.destroyRuntime(dead);
    next.controller.onRuntimeExit(dead);
    assert.ok(await next.until(() => !next.controller.runtimes.has(id), 8000));
    next.send({ type: "wakeSession", id });
    assert.ok(await next.until(() => {
      const rt = next.controller.runtimes.get(id);
      return rt && rt.log.filter((p) => p.type === "userChunk").length === 3;
    }, 10000), "the woken replay rebuilt the same three requests");
    const woke = next.controller.runtimes.get(id).log.filter((p) => p.type === "userChunk");
    assert.deepStrictEqual(woke.map((c) => c.text), [TEXT, TEXT, TEXT]);
    assert.deepStrictEqual(woke[2].attachments.map((a) => a.label),
      ["notes.txt", "renamed.png", "dropped.txt", "pick.ts:1-2"]);

    // And a live transfer carries the woken transcript, attachments included.
    const transfer = next.controller.exportRuntime(id);
    const to = createChat({ storage: next.storage, cwd: next.cwd, state: carried(next) });
    try {
      await to.ready();
      await to.controller.importRuntime(transfer);
      assert.ok(await to.until(() => {
        const items = to.postsOf("replay").flatMap((m) => m.items || []);
        return items.filter((p) => p.type === "userChunk").length === 3;
      }, 8000), "the transferred transcript replayed");
      const moved = to.postsOf("replay").flatMap((m) => m.items || []).filter((p) => p.type === "userChunk");
      assert.deepStrictEqual(moved[0].attachments.map((a) => a.label),
        ["notes.txt", "first.png", "dropped.txt", "pick.ts:1-2"]);
      assert.strictEqual(moved[0].attachments[1].thumb, `data:image/png;base64,${IMG_A}`);
      assert.deepStrictEqual(moved[2].attachments.map((a) => a.label),
        ["notes.txt", "renamed.png", "dropped.txt", "pick.ts:1-2"]);
      // The queue and manifest travelled unpaused with the live runtime.
      assert.strictEqual(to.controller.runtimes.get(id)?.messages.paused, false);
      assert.strictEqual(to.controller.runtimes.get(id)?.messages.sent.length, 3);
    } finally {
      await to.dispose();
    }
  } finally {
    await next.dispose();
  }
});

test("message persistence replay without a manifest still restores attachment pills", posixOnly, async () => {
  // History written before the manifest existed has no saved records: the
  // request is rebuilt from the blocks themselves. A resource block becomes a
  // file pill without its contents, and every image keeps its thumbnail.
  const h = createChat({
    loadUpdates: [
      { sessionUpdate: "user_message_chunk", messageId: "u1", content: [
        { type: "resource", resource: { uri: "file:///w/notes.txt", text: "the notes file contents" } },
        { type: "image", mimeType: "image/png", data: IMG_A },
        { type: "image", mimeType: "image/png", data: IMG_B },
        { type: "text", text: "what about these" }
      ] },
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "ok" } }
    ]
  });
  try {
    await h.ready();
    h.send({ type: "loadSession", id: "legacy-session" });
    // Replayed transcript arrives in batches, not as top level userChunk posts.
    assert.ok(await h.until(() => h.postsOf("replay")
      .flatMap((m) => m.items || []).some((p) => p.type === "userChunk"), 8000), "the request replayed");
    const chunk = h.postsOf("replay").flatMap((m) => m.items || []).find((p) => p.type === "userChunk");
    assert.strictEqual(chunk.text, "what about these", "the resource text stayed out of the message body");
    assert.deepStrictEqual(chunk.attachments.map((a) => a.label), ["notes.txt", "Image", "Image"]);
    assert.deepStrictEqual(chunk.attachments.map((a) => a.type), ["file", "image", "image"]);
    assert.strictEqual(chunk.attachments[1].thumb, `data:image/png;base64,${IMG_A}`);
    assert.strictEqual(chunk.attachments[2].thumb, `data:image/png;base64,${IMG_B}`);
    assert.ok(!JSON.stringify(chunk).includes("the notes file contents"), "file contents did not leak");

    // The same chunk survives being recorded and replayed for a transfer.
    const rt = h.controller.runtimes.get("legacy-session");
    assert.ok(rt, "the session has a runtime");
    const logged = rt.log.filter((p) => p.type === "userChunk");
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].attachments.length, 3, "all three pills were recorded");
  } finally {
    await h.dispose();
  }
});

test("message persistence a user only replay tail flushes at load completion", posixOnly, async () => {
  // The last request of a history can be a user message with no reply after
  // it, and config or usage traffic can land in the middle of one request's
  // chunks. Neither may lose or split what the replay puts back.
  const h = createChat({
    loadUpdates: [
      { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "first half " } },
      { sessionUpdate: "usage_update", used: 10, size: 100 },
      { sessionUpdate: "config_option_update", configOptions: [{
        id: "mode", name: "Session Mode", type: "select", currentValue: "default",
        options: [{ value: "default", name: "Default" }]
      }] },
      { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "second half" } },
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "reply one" } },
      { sessionUpdate: "user_message_chunk", messageId: "u2", content: { type: "text", text: "unanswered tail" } }
    ]
  });
  try {
    await h.ready();
    h.send({ type: "loadSession", id: "tail-session" });
    const chunks = () => h.postsOf("replay")
      .flatMap((m) => m.items || []).filter((p) => p.type === "userChunk");
    assert.ok(await h.until(() => chunks().length === 2, 8000), "both requests replayed");
    assert.strictEqual(chunks()[0].text, "first half second half",
      "usage and config updates did not split the request");
    assert.strictEqual(chunks()[1].text, "unanswered tail",
      "the user only tail flushed when the load finished");
    assert.deepStrictEqual(chunks().map((c) => c.messageId), ["u1", "u2"]);
  } finally {
    await h.dispose();
  }
});

test("message persistence keeps queue and attachments through a live transfer", posixOnly, async () => {
  const from = createChat({ promptGate: true, midTurnPrompts: true });
  await from.ready();
  const id = await from.startChat("the turn");
  await from.until(() => from.postsOf("busy").some((m) => m.value));

  // A sent request with attachment display in the log.
  from.send({ type: "attachImage", name: "sent.png", mime: "image/png", data: IMG_A });
  await from.until(() => ((from.last("attachments") || {}).items || []).length === 1);
  from.send({ type: "send", text: "with picture", kind: "steer" });
  assert.ok(await from.until(() => from.agentSaw("session/prompt").length === 2, 8000));

  // A queued message with its own image, and separate staged draft files.
  from.send({ type: "attachImage", name: "queued.png", mime: "image/png", data: IMG_B });
  await from.until(() => ((from.last("attachments") || {}).items || []).length === 1);
  from.send({ type: "send", text: "queued with image", kind: "queue" });
  await from.until(() => (from.last("queued") || { items: [] }).items.length === 1);
  from.send({ type: "attachImage", name: "draft.png", mime: "image/png", data: IMG_B });
  await from.until(() => ((from.last("attachments") || {}).items || []).length === 1);

  const transfer = from.controller.exportRuntime(id);
  const to = createChat({
    storage: from.storage,
    cwd: from.cwd,
    state: Object.fromEntries(from.state.__map),
    promptGate: path.join(from.storage, "prompt-gate")
  });
  try {
    await to.ready();
    await to.controller.importRuntime(transfer);
    assert.ok(await to.until(() => (to.last("queued") || { items: [] }).items.length === 1, 8000),
      "the queue arrived with the runtime");
    const arrived = to.last("queued");
    assert.strictEqual(arrived.paused, false, "a live transfer keeps running semantics");
    assert.strictEqual(arrived.items[0].text, "queued with image");
    assert.strictEqual(arrived.items[0].kind, "queue");
    assert.strictEqual(arrived.items[0].attachments[0].label, "queued.png");
    assert.strictEqual(arrived.items[0].attachments[0].thumb, `data:image/png;base64,${IMG_B}`);
    // The sent request's display travelled in the recorded transcript.
    const sentEcho = to.postsOf("replay").flatMap((m) => m.items || [])
      .find((p) => p.type === "userMessage" && p.text === "with picture");
    assert.ok(sentEcho, "the sent request replayed");
    assert.strictEqual(sentEcho.attachments[0].label, "sent.png");
    assert.strictEqual(sentEcho.attachments[0].thumb, `data:image/png;base64,${IMG_A}`);
    // The staged draft files travelled with the surface, not into the queue.
    assert.deepStrictEqual(((to.last("attachments") || {}).items || []).map((a) => a.label), ["draft.png"]);
    assert.strictEqual(to.controller.runtimes.get(id)?.messages.queued[0].attachments[0].block.data, IMG_B,
      "the queued image kept its bytes under the new owner");

    // And back again: the destination becomes the source.
    const back = to.controller.exportRuntime(id);
    const third = createChat({
      storage: from.storage,
      cwd: from.cwd,
      state: Object.fromEntries(to.state.__map),
      promptGate: path.join(from.storage, "prompt-gate")
    });
    try {
      await third.ready();
      await third.controller.importRuntime(back);
      assert.ok(await third.until(() => (third.last("queued") || { items: [] }).items.length === 1, 8000));
      assert.strictEqual(third.last("queued").paused, false);
      assert.strictEqual(third.last("queued").items[0].text, "queued with image");
      assert.strictEqual(third.last("queued").items[0].attachments[0].label, "queued.png");
      assert.deepStrictEqual(((third.last("attachments") || {}).items || []).map((a) => a.label), ["draft.png"]);
    } finally {
      await third.dispose();
    }
  } finally {
    await to.dispose();
    await from.dispose();
  }
});

test("message persistence serializes a late write behind the new owner's", posixOnly, async () => {
  // A save the old surface already had in flight when it handed the session over
  // must land before the new owner's own save, never on top of it: the shared
  // per file write queue is what orders them.
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "first queued" });
  h.send({ type: "send", text: "second queued" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 2);

  // Hold every write to the messages snapshot so the next save stays in flight.
  const vscode = globalThis.__dvVscode;
  const fsApi = vscode.workspace.fs;
  const originalWrite = fsApi.writeFile;
  let releaseWrites;
  const gate = new Promise((resolve) => { releaseWrites = resolve; });
  let entered = false;
  fsApi.writeFile = async (uri, bytes) => {
    if (String(uri.path).includes("/messages/")) {
      entered = true;
      await gate;
    }
    return originalWrite(uri, bytes);
  };
  try {
    // The old surface queues one more message: its save is now stuck mid write.
    h.send({ type: "send", text: "from the old surface" });
    assert.ok(await h.until(() => entered, 8000), "the old surface's save reached the disk");

    const transfer = h.controller.exportRuntime(id);
    const to = createChat({
      storage: h.storage,
      cwd: h.cwd,
      state: Object.fromEntries(h.state.__map),
      promptGate: path.join(h.storage, "prompt-gate")
    });
    try {
      await to.ready();
      await to.controller.importRuntime(transfer);
      // The destination adds its own entry while the old write is still held.
      to.send({ type: "send", text: "from the new surface", kind: "queue" });
      await to.until(() => (to.last("queued") || { items: [] }).items.length === 4, 8000);
    } finally {
      releaseWrites();
      await to.dispose();
    }
    await h.dispose();

    const third = createChat({ storage: h.storage, cwd: h.cwd, state: Object.fromEntries(h.state.__map) });
    try {
      await third.ready();
      third.send({ type: "loadSession", id });
      assert.ok(await third.until(() => third.activeId() === id, 8000));
      assert.ok(await third.until(() => {
        const q = third.last("queued");
        return q && (q.items || []).length === 4;
      }, 8000));
      // The stale write landed first, the new owner's last: the destination's
      // latest state is what the file holds.
      assert.deepStrictEqual(third.last("queued").items.map((q) => q.text),
        ["first queued", "second queued", "from the old surface", "from the new surface"]);
      assert.strictEqual(third.last("queued").paused, true);
    } finally {
      await third.dispose();
    }
  } finally {
    fsApi.writeFile = originalWrite;
    await h.dispose();
  }
});

test("message persistence keeps a dead session's queue editable until resume", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "keep me" });
  h.send({ type: "send", text: "drop me" });
  h.send({ type: "send", text: "edit me" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 3);
  const items = h.last("queued").items;

  // The agent dies on its own: the session stays on screen with no runtime, and
  // the queue it left is paused in the store.
  const rt = h.controller.runtimes.get(id);
  const agentsBefore = h.agentSaw("session/new").length + h.agentSaw("session/load").length;
  h.controller.destroyRuntime(rt);
  h.controller.onRuntimeExit(rt);
  assert.ok(await h.until(() => !h.controller.runtimes.has(id), 8000));
  assert.strictEqual(h.activeId(), id, "the session is still on screen");
  const state = h.controller.messageStore.get(id);
  assert.strictEqual(state.paused, true, "the dead runtime's queue is paused");
  assert.strictEqual(state.queued.length, 3);

  // Rows still work with no process behind them.
  h.send({ type: "removeQueued", id: items[1].id });
  h.send({ type: "reorderQueued", id: items[2].id, targetId: items[0].id, before: false });
  h.send({ type: "editQueued", id: items[2].id, text: "edit me, revised" });
  await h.until(() => state.queued.map((q) => q.text).join("|") === "keep me|edit me, revised");
  assert.strictEqual(h.agentSaw("session/new").length + h.agentSaw("session/load").length, agentsBefore,
    "no agent was started for the offline edits");

  // Send Immediately on the offline queue wakes that session and sends only it.
  h.send({ type: "sendQueuedNow", id: items[2].id });
  assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2, 10000),
    "the picked message woke the session and went out");
  const woke = h.agentSaw("session/prompt")[1];
  assert.strictEqual(woke.params.sessionId, id);
  assert.strictEqual(woke.params.prompt.at(-1).text, "edit me, revised");
  h.releasePrompt(id, 1);
  h.releasePrompt(id, 2);
  assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1, 8000));
  assert.strictEqual(h.last("queued").items[0].text, "keep me", "the rest stayed queued");
  assert.strictEqual(state.paused, true, "and stayed paused");
  await h.dispose();
});

test("message persistence resume during a wake keeps prompts on their own session", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "queued for resume" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);

  // The agent dies with the queue waiting: paused, with no process behind it.
  const rt = h.controller.runtimes.get(id);
  h.controller.destroyRuntime(rt);
  h.controller.onRuntimeExit(rt);
  assert.ok(await h.until(() => !h.controller.runtimes.has(id), 8000));
  assert.strictEqual(h.controller.messageStore.get(id).paused, true);
  assert.strictEqual(h.activeId(), id, "the session is still on screen");

  // Resume starts a wake, and the user moves to another chat while the load is
  // still in flight. The queued message must still go to the session it was
  // written in, and the panel must not be pulled back to it.
  h.setDelays({ loadDelay: 900 });
  h.send({ type: "resumeQueue" });
  await h.settle(250);
  const other = await h.startChat("the chat opened instead");
  assert.strictEqual(h.activeId(), other, "the user is on the other chat");

  assert.ok(await h.until(() => h.agentSaw("session/prompt")
    .filter((p) => p.params.sessionId === id).length === 2, 10000),
    "the resumed queue went out on its own session");
  const resumed = h.agentSaw("session/prompt").filter((p) => p.params.sessionId === id).at(-1);
  assert.strictEqual(resumed.params.prompt.at(-1).text, "queued for resume");
  assert.strictEqual(h.activeId(), other, "and the panel stayed where the user put it");
  assert.strictEqual(h.controller.messageStore.get(id).paused, false, "the resume landed");

  h.releasePrompt(id, 1);
  await h.until(() => {
    const woke = h.controller.runtimes.get(id);
    return woke && woke.busy === false;
  }, 8000);
  await h.dispose();
});

test("message persistence a failed resume wake leaves the queue paused", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  try {
    await h.ready();
    const id = await h.startChat("the turn");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value)));
    h.send({ type: "attachImage", name: "queued.png", mime: "image/png", data: PNG });
    assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1));
    h.send({ type: "send", text: "queued for resume" });
    assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1));
    await h.controller.messageStore.flush();
    const file = messagesFile(h.storage, id);

    const rt = h.controller.runtimes.get(id);
    h.controller.destroyRuntime(rt);
    h.controller.onRuntimeExit(rt);
    assert.ok(await h.until(() => !h.controller.runtimes.has(id), 8000));
    assert.strictEqual(h.controller.messageStore.get(id).paused, true);

    h.controller.loadWithTakeover = async () => { throw new Error("the load failed"); };
    await h.controller.resumeQueue();
    await h.controller.refreshSessions(true);
    await h.controller.messageStore.flush();

    const state = h.controller.messageStore.get(id);
    assert.strictEqual(state.paused, true, "a failed wake did not unpause the queue");
    assert.strictEqual(state.queued.length, 1, "the message is still there");
    assert.strictEqual(h.store.has(id), true, "the queued session remains tracked");
    assert.ok(h.last("sessions").sessions.some((session) => session.id === id),
      "the saved queue remains reachable from the session list");
    assert.ok(fs.existsSync(file), "the queue snapshot remains on disk");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).queued[0].attachments[0].block.data, PNG,
      "the saved attachment kept its bytes");
    assert.strictEqual(h.agentSaw("session/prompt").length, 1, "nothing else was sent");
  } finally {
    await h.dispose();
  }
});

test("message persistence a cold list retains saved queues missing from discovery", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    const id = "saved-queue-without-discovery";
    h.store.add(id, h.cwd);
    const file = seedMessageFile(h.storage, id);
    const queued = {
      id: "saved-message", kind: "queue", text: "saved follow up", implicit: [],
      attachments: [{
        id: "saved-attachment", label: "saved.png", type: "image",
        block: { type: "image", mimeType: "image/png", data: PNG }
      }]
    };
    const snapshot = JSON.stringify({ version: 1, queued: [queued], sent: [] });
    fs.writeFileSync(file, snapshot);
    h.controller.listOverProtocol = () => Promise.resolve({ sessions: [], prunedIds: [id] });

    await h.controller.refreshSessions(true);
    await h.controller.messageStore.flush();

    assert.strictEqual(h.store.has(id), true, "discovery did not remove the queued session");
    assert.ok(h.last("sessions").sessions.some((session) => session.id === id),
      "the cold queue has a session row");
    assert.strictEqual(fs.readFileSync(file, "utf8"), snapshot, "discovery left the snapshot intact");
    const state = await h.controller.messageStore.load(id);
    assert.strictEqual(state.paused, true, "the cold queue remains paused");
    assert.deepStrictEqual(state.queued, [queued], "the full message and attachment survive");
    assert.strictEqual(h.agentSaw("session/prompt").length, 0, "listing the queue sends nothing");
  } finally {
    await h.dispose();
  }
});

test("message persistence reports a corrupt snapshot instead of overwriting it", posixOnly, async () => {
  const h = createChat();
  await h.ready();
  const id = await h.startChat("the turn");
  assert.ok(await h.until(() => prompts(h).length === 1, 8000));
  // Flush first: the live session's own shutdown save must not be what writes
  // over the fixtures below.
  await h.controller.shutdown();
  await h.dispose();

  // Snapshots that fail validation the way a torn or foreign write would. Each
  // is checked byte for byte after its reader has also shut down, so a save
  // during teardown cannot quietly replace the bad file with an empty state.
  const dir = path.join(h.storage, "messages");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  const fixtures = [
    ["malformed JSON", "{not json"],
    ["a bad version", JSON.stringify({ version: 2, queued: [], sent: [] })],
    ["a bad schema", JSON.stringify({
      version: 1,
      queued: [{ id: "q1", kind: "queue", text: "", implicit: [], attachments: [] }],
      sent: []
    })]
  ];
  for (const [name, raw] of fixtures) {
    fs.writeFileSync(file, raw);
    const next = createChat({
      storage: h.storage,
      cwd: h.cwd,
      state: Object.fromEntries(h.state.__map),
      loadUpdates: [{ sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "old question" } }]
    });
    try {
      await next.ready();
      next.send({ type: "loadSession", id });
      assert.ok(await next.until(() => next.postsOf("error")
        .some((m) => /saved messages and attachments/.test(m.text || "")), 8000),
        `${name}: the corrupt snapshot was reported`);
      // The transcript still replayed from the agent's own history.
      assert.ok(await next.until(() => next.postsOf("replay")
        .flatMap((m) => m.items || []).some((p) => p.type === "userChunk"), 8000),
        `${name}: the transcript replayed`);
      const replayed = next.postsOf("replay").flatMap((m) => m.items || []).find((p) => p.type === "userChunk");
      assert.strictEqual(replayed.text, "old question");
    } finally {
      await next.dispose();
    }
    assert.strictEqual(fs.readFileSync(file, "utf8"), raw, `${name}: the file was left in place, byte for byte`);
  }
});

test("message persistence a failed snapshot write keeps the last good file", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));
  h.send({ type: "send", text: "first queued" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);
  // Commit the first snapshot before breaking writes, so the file on disk
  // provably holds it when the second save fails.
  await h.controller.messageStore.flush();
  const good = h.controller.messageStore.get(id);
  assert.strictEqual(good.queued.length, 1);

  // Break writes to the snapshot file only.
  const vscode = globalThis.__dvVscode;
  const fsApi = vscode.workspace.fs;
  const originalWrite = fsApi.writeFile;
  fsApi.writeFile = async (uri, bytes) => {
    if (String(uri.path).includes("/messages/")) {
      const err = new Error("ENOSPC: no space left on device");
      err.code = "ENOSPC";
      throw err;
    }
    return originalWrite(uri, bytes);
  };
  try {
    h.send({ type: "send", text: "second queued" });
    assert.ok(await h.until(() => h.postsOf("error").some((m) => /couldn't save this chat's messages and attachments/i.test(m.text || "")), 8000),
      "the failed save was reported");
  } finally {
    fsApi.writeFile = originalWrite;
  }
  // The queue still in memory kept working, and the last committed file still has
  // only what it had before the failed write.
  assert.strictEqual(good.queued.length, 2, "the queue in memory still took the message");
  assert.strictEqual((h.last("queued") || { items: [] }).items.length, 2);
  const dir = path.join(h.storage, "messages");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.strictEqual(files.length, 1, "no temp file was left behind");
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  assert.strictEqual(saved.queued.length, 1, "the last committed snapshot is intact");
  assert.strictEqual(saved.queued[0].text, "first queued");
  await h.dispose();
});

test("message persistence slow storage does not reorder a sent request and a steer", posixOnly, async () => {
  // The sent manifest is recorded in memory and its save requested, but the
  // dispatch barrier must be installed without waiting on disk: a steer that
  // lands while storage is still blocked has to join the same turn, in order.
  const h = createChat({ promptGate: true, midTurnPrompts: true });
  await h.ready();
  const id = await h.startChat("warmup");
  assert.ok(await h.until(() => prompts(h).length === 1, 8000));
  h.releasePrompt(id, 1);
  const rt = () => h.controller.runtimes.get(id);
  assert.ok(await h.until(() => rt()?.busy === false, 8000), "the warmup turn ended");

  const vscode = globalThis.__dvVscode;
  const fsApi = vscode.workspace.fs;
  const originalWrite = fsApi.writeFile;
  let releaseWrites;
  const gate = new Promise((resolve) => { releaseWrites = resolve; });
  let entered = false;
  fsApi.writeFile = async (uri, bytes) => {
    if (String(uri.path).includes("/messages/")) {
      entered = true;
      await gate;
    }
    return originalWrite(uri, bytes);
  };
  try {
    h.send({ type: "attachImage", name: "shot.png", mime: "image/png", data: IMG_A });
    await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
    h.send({ type: "send", text: "first with image" });
    assert.ok(await h.until(() => entered, 8000), "the manifest write reached the disk");
    assert.ok(rt().turn, "the turn barrier is installed while storage is still blocked");

    h.send({ type: "send", text: "second steer", kind: "steer" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 3, 8000),
      "both requests reached the wire");
    const wire = h.agentSaw("session/prompt").slice(1).map((m) => m.params.prompt.at(-1).text);
    assert.deepStrictEqual(wire, ["first with image", "second steer"],
      "the sent request and the steer went out in order");

    h.releasePrompt(id, 2);
    await h.settle(400);
    assert.strictEqual(rt().busy, true, "one reply is not the end of the shared turn");
    h.releasePrompt(id, 3);
    assert.ok(await h.until(() => rt()?.busy === false, 8000), "the shared turn ended");
  } finally {
    releaseWrites();
    fsApi.writeFile = originalWrite;
    await h.dispose();
  }
});

test("message persistence a delayed remove completes before a later adopted save", posixOnly, async () => {
  // A remove that is still waiting on hydration must not delete the file after
  // a newer owner has already saved over it: the store's per session chain is
  // what orders the two, so the save scheduled second lands last.
  const h = createChat();
  await h.ready();
  const id = "ghost-session";
  const digest = crypto.createHash("sha256").update(id).digest("hex");
  const file = path.join(h.storage, "messages", `${digest}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    queued: [{ id: "old-q", kind: "queue", text: "old queued", implicit: [], attachments: [] }],
    sent: []
  }));

  const vscode = globalThis.__dvVscode;
  const fsApi = vscode.workspace.fs;
  const originalRead = fsApi.readFile;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let readEntered = false;
  fsApi.readFile = async (uri) => {
    const bytes = await originalRead(uri);
    if (String(uri.path).includes(`/messages/${digest}.json`)) {
      readEntered = true;
      await gate;
    }
    return bytes;
  };
  try {
    const store = h.controller.messageStore;
    store.get(id);
    const loaded = store.load(id);
    store.remove(id);
    store.adopt(id, {
      queued: [{ id: "new-q", kind: "queue", text: "adopted queued", implicit: [], attachments: [] }],
      sent: [],
      paused: false
    });
    const saved = store.save(id);
    assert.ok(await h.until(() => readEntered, 8000), "hydration reached the gated read");
    releaseRead();
    await loaded.catch(() => {});
    await saved.catch(() => {});
    await store.flush();

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(onDisk.queued.map((q) => q.id), ["new-q"],
      "the adopted state is what the file holds, not a deletion that landed late");
    assert.strictEqual(onDisk.queued[0].text, "adopted queued");
  } finally {
    releaseRead();
    fsApi.readFile = originalRead;
    await h.dispose();
  }
});

for (const variant of ["before rejection", "during recovery"]) {
  test(`message persistence a deleted session is not resurrected by a late not sent error (${variant})`, posixOnly, async () => {
    const h = createChat({ promptDelay: 150 });
    let releaseCleanup;
    let boundSave;
    try {
      await h.ready();
      const id = await h.startChat("warmup");
      assert.ok(await h.until(() => prompts(h).length === 1, 8000));
      const idle = () => h.until(() => {
        const rt = h.controller.runtimes.get(id);
        return !!rt && rt.busy === false;
      }, 8000);
      assert.ok(await idle(), "the warmup turn ended");

      // A sent request leaves its manifest on disk, so the delete below has a
      // real file to remove and the late failure has something it must not
      // recreate.
      h.send({ type: "attachImage", name: "shot.png", mime: "image/png", data: IMG_A });
      await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
      h.send({ type: "send", text: "with file" });
      assert.ok(await h.until(() => prompts(h).length === 2, 8000));
      assert.ok(await idle(), "the attachment turn ended");
      await h.controller.messageStore.flush();
      const file = path.join(h.storage, "messages", `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
      assert.ok(fs.existsSync(file), "the manifest is on disk before the delete");

      // The next prompt never answers, so its not sent failure lands when the
      // test releases it, after the session is gone.
      const rt = h.controller.runtimes.get(id);
      let rejectPrompt;
      let promptStarted = false;
      rt.client.prompt = () => {
        promptStarted = true;
        return new Promise((_, reject) => { rejectPrompt = reject; });
      };
      h.send({ type: "attachImage", name: "late.png", mime: "image/png", data: IMG_B });
      await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
      h.send({ type: "send", text: "never sent" });
      assert.ok(await h.until(() => promptStarted, 8000), "the prompt reached the stub");
      const pendingTurn = rt.turn;

      const deleteSession = async () => {
        h.answerWith("Delete");
        h.send({ type: "deleteSession", id, title: "warmup" });
        assert.ok(await h.until(() => !h.store.has(id), 8000), "the session was deleted");
        await h.controller.messageStore.flush();
        assert.ok(!fs.existsSync(file), "the delete removed the snapshot");
      };

      if (variant === "during recovery") {
        // Park the recovery's own manifest save: the delete lands while the
        // not sent callback is still inside it, so only a recheck after that
        // await can see the session is gone.
        boundSave = h.controller.saveRuntimeMessages.bind(h.controller);
        let cleanupEntered = false;
        const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
        h.controller.saveRuntimeMessages = (target) => {
          if (target !== rt) {
            return boundSave(target);
          }
          cleanupEntered = true;
          return cleanupGate.then(() => boundSave(target));
        };
        rejectPrompt(new h.AcpRequestNotSentError("ACP connection is closed"));
        assert.ok(await h.until(() => cleanupEntered, 8000), "the recovery reached its save");
        await deleteSession();
        releaseCleanup();
      } else {
        await deleteSession();
        rejectPrompt(new h.AcpRequestNotSentError("ACP connection is closed"));
      }
      await pendingTurn.catch(() => {});
      await h.controller.messageStore.flush();

      assert.ok(!fs.existsSync(file), "the late failure did not recreate the snapshot");
      assert.ok(!((h.store.draft(id) || "").includes("never sent")), "and no draft came back");
      assert.strictEqual(h.controller.staged.has(id), false, "and no staged files were restored");
    } finally {
      releaseCleanup?.();
      if (boundSave) {
        delete h.controller.saveRuntimeMessages;
      }
      await h.dispose();
    }
  });
}

test("message persistence dispose during a borrowed queue edit restores without a duplicate attachment", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "attachImage", name: "queued.png", mime: "image/png", data: IMG_A });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  h.send({ type: "send", text: "queued with image" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);

  // Borrow the row into the composer: its attachment is now staged for the
  // session as well as recorded on the queue row itself.
  const qid = h.last("queued").items[0].id;
  h.send({ type: "queueEditing", id: qid });
  await h.until(() => ((h.last("attachments") || {}).items || []).length === 1);
  assert.strictEqual(h.last("attachments").items[0].label, "queued.png");

  // Dispose with the edit still open, then shut the surface down and flush.
  h.controller.dispose();
  await h.dispose();

  const next = createChat({
    storage: h.storage,
    cwd: h.cwd,
    state: Object.fromEntries(h.state.__map),
    promptGate: true
  });
  try {
    await next.ready();
    next.send({ type: "loadSession", id });
    assert.ok(await next.until(() => {
      const q = next.last("queued");
      return q && q.paused === true && (q.items || []).length === 1;
    }, 8000), "the queue came back paused with its row");
    // The borrowed copy was dropped at dispose, so the composer holds nothing
    // that would show the same file twice next to the queue row.
    const stagedItems = (next.last("attachments") || {}).items || [];
    assert.deepStrictEqual(stagedItems.map((a) => a.label), [], "no duplicate composer attachment");
    assert.strictEqual(next.last("queued").items[0].attachments[0].label, "queued.png",
      "the queue row still owns its attachment");
  } finally {
    await next.dispose();
  }
});

test("message persistence replay uses stable prompt ids after a history cut", posixOnly, async () => {
  const h = createChat({ promptDelay: 100 });
  let next;
  try {
    await h.ready();
    const id = await h.startChat("warmup");
    const idle = () => h.until(() => h.controller.runtimes.get(id)?.busy === false, 10000);
    assert.ok(await idle());
    for (const name of ["discarded.png", "retained.png"]) {
      h.send({ type: "attachImage", name, mime: "image/png", data: PNG });
      assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000));
      const before = h.agentSaw("session/prompt").length;
      h.send({ type: "send", text: "same typed text" });
      assert.ok(await h.until(() => h.agentSaw("session/prompt").length > before, 8000));
      assert.ok(await idle());
    }
    const latest = h.postsOf("userMessage").filter((m) => m.text === "same typed text").at(-1);
    assert.ok(latest?.clientMessageId);
    const blocks = h.agentSaw("session/prompt").at(-1).params.prompt;
    await h.dispose();
    const state = Object.fromEntries(h.state.__map);
    delete state["devin.viewingSession.v1"];
    delete state["devin.activeSession.v1"];
    // A restore can remove the earlier prompt from history while both sent
    // records remain. The identical blocks must keep the surviving prompt's label.
    next = createChat({
      storage: h.storage, cwd: h.cwd, state,
      loadUpdates: [
        { sessionUpdate: "user_message_chunk", messageId: "history-new",
          _meta: { "cognition.ai/clientMessageId": latest.clientMessageId }, content: blocks },
        { sessionUpdate: "agent_message_chunk", messageId: "history-answer", content: { type: "text", text: "reply" } }
      ]
    });
    await next.ready();
    next.send({ type: "loadSession", id });
    const chunks = () => next.postsOf("replay").flatMap((m) => m.items || []).filter((p) => p.type === "userChunk");
    assert.ok(await next.until(() => chunks().length === 1, 10000));
    assert.deepStrictEqual(chunks()[0].attachments.map((a) => a.label), ["retained.png"]);
    assert.strictEqual(chunks()[0].attachments[0].thumb, `data:image/png;base64,${PNG}`);
    assert.strictEqual(chunks()[0].messageId, latest.clientMessageId);
  } finally {
    if (next) await next.dispose();
    await h.dispose();
  }
});


for (const variant of ["cold", "warm"]) {
  test(`message persistence history eviction preserves a saved queue (${variant})`, posixOnly, async () => {
    const h = createChat();
    try {
      await h.ready();
      await h.controller.refreshSessions(true);
      const id = "queue-past-the-cap";
      // Added first, so it sits at the tail the cap drops first.
      h.store.add(id, h.cwd);
      for (let i = 0; i < 199; i++) h.store.add(`cap-old-${i}`, h.cwd);
      const queued = {
        id: "queued-row", kind: "queue", text: "saved queued work",
        implicit: [IMPLICIT_NOTE],
        attachments: [{
          id: "kept-attachment", label: "kept.png", type: "image",
          block: { type: "image", mimeType: "image/png", data: PNG }
        }]
      };
      const snapshot = JSON.stringify({ version: 1, queued: [queued], sent: [] });
      const file = messagesFile(h.storage, id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, snapshot);
      h.store.setDraft(id, "composer words kept");
      h.store.rememberPrompt(id, "the prompt that queued it");
      if (variant === "warm") {
        const state = await h.controller.messageStore.load(id);
        assert.strictEqual(state.queued.length, 1, "setup: the queue was hydrated");
        assert.strictEqual(state.paused, true, "setup: the recovered queue is paused");
      }

      await h.controller.rememberSession("new-session", h.cwd);
      await h.controller.messageStore.flush();

      assert.ok(h.store.has(id), "the queued session stayed tracked past the cap");
      assert.ok(h.store.has("new-session"), "the new session registered");
      assert.strictEqual(h.store.cwds()[id], h.cwd, "its cwd survived");
      assert.strictEqual(h.store.draft(id), "composer words kept", "its draft survived");
      assert.ok(h.store.promptHistory(h.cwd).includes("the prompt that queued it"),
        "its prompt history survived");
      assert.strictEqual(fs.readFileSync(file, "utf8"), snapshot, "the snapshot is byte for byte intact");
      assert.strictEqual(h.store.hasPendingQueue(id), true, "the pending flag protects it from here on");
      const state = await h.controller.messageStore.load(id);
      assert.strictEqual(state.queued.length, 1);
      assert.strictEqual(state.queued[0].id, "queued-row");
      assert.strictEqual(state.queued[0].kind, "queue");
      assert.deepStrictEqual(state.queued[0].implicit, [IMPLICIT_NOTE]);
      assert.strictEqual(state.queued[0].attachments[0].block.data, PNG, "the attachment kept its bytes");
      assert.strictEqual(state.paused, true, "and it is still paused");

      await h.controller.shutdown();
      await h.dispose();

      const carried = Object.fromEntries(h.state.__map);
      delete carried["devin.viewingSession.v1"];
      delete carried["devin.activeSession.v1"];
      const next = createChat({ storage: h.storage, cwd: h.cwd, state: carried });
      try {
        await next.ready();
        assert.ok(next.store.has(id), "the session is still tracked after a reload");
        await next.controller.refreshSessions(true);
        assert.ok(await next.until(() => (next.last("sessions")?.sessions || []).some((s) => s.id === id), 8000),
          "and it is discoverable in the session list");
        next.send({ type: "loadSession", id });
        assert.ok(await next.until(() => {
          const q = next.last("queued");
          return next.activeId() === id && q && q.paused === true && (q.items || []).length === 1;
        }, 10000), "the saved queue loaded paused");
        const rt = next.controller.runtimes.get(id);
        const stored = rt.messages.queued;
        assert.strictEqual(stored.length, 1);
        assert.strictEqual(stored[0].id, "queued-row");
        assert.strictEqual(stored[0].kind, "queue");
        assert.strictEqual(stored[0].text, "saved queued work");
        assert.deepStrictEqual(stored[0].implicit, [IMPLICIT_NOTE]);
        assert.strictEqual(stored[0].attachments[0].label, "kept.png");
        assert.strictEqual(stored[0].attachments[0].block.data, PNG);
        assert.strictEqual(next.store.draft(id), "composer words kept", "the draft came back too");
        assert.ok(next.store.promptHistory(h.cwd).includes("the prompt that queued it"),
          "and so did the prompt history");
      } finally {
        await next.dispose();
      }
    } finally {
      await h.dispose();
    }
  });
}

test("message persistence history eviction preserves an unreadable snapshot", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    await h.controller.refreshSessions(true);
    const id = "corrupt-past-the-cap";
    h.store.add(id, h.cwd);
    for (let i = 0; i < 199; i++) h.store.add(`cap-old-${i}`, h.cwd);
    const file = messagesFile(h.storage, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const raw = "{not valid json";
    fs.writeFileSync(file, raw);

    await h.controller.rememberSession("new-session", h.cwd);
    await h.controller.messageStore.flush();

    assert.ok(h.store.has(id), "an unreadable snapshot is retained rather than evicted");
    assert.strictEqual(fs.readFileSync(file, "utf8"), raw, "the corrupt file is left byte for byte");
    assert.ok(h.store.has("new-session"), "the new session registered");
    assert.ok(h.postsOf("error").some((m) => /saved messages and attachments/.test(m.text || "")),
      "the restore failure was reported");
    assert.ok(h.logs.some((line) => line.includes(`[messages-restore-failed] ${id}`)),
      "and written to the log");
  } finally {
    await h.dispose();
  }
});

test("message persistence discovery isolates a corrupt snapshot", posixOnly, async () => {
  const h = createChat();
  try {
    await h.ready();
    const bad = "discovery-corrupt";
    const healthy = "discovery-empty";
    h.store.add(bad, h.cwd);
    h.store.add(healthy, h.cwd);
    const badFile = messagesFile(h.storage, bad);
    fs.mkdirSync(path.dirname(badFile), { recursive: true });
    const raw = "{not valid json";
    fs.writeFileSync(badFile, raw);
    const healthyFile = seedMessageFile(h.storage, healthy);
    const cached = { id: "cached-row", short_id: "cached-row", title: "Cached chat", working_directory: h.cwd, last_activity_at: 1 };
    const fresh = { id: "fresh-row", short_id: "fresh-row", title: "Fresh chat", working_directory: h.cwd, last_activity_at: 2 };
    h.controller.sessionsCache = { at: 0, sessions: [cached] };
    let listed = false;
    h.controller.listOverProtocol = () => {
      listed = true;
      return Promise.resolve({ sessions: [fresh], prunedIds: [bad, healthy] });
    };

    await h.controller.refreshSessions(true);
    await h.controller.messageStore.flush();

    assert.ok(listed, "the fresh listing was actually fetched");
    const shown = (h.last("sessions")?.sessions || []).map((s) => s.id);
    assert.ok(shown.includes("fresh-row"), "the fresh row is shown");
    assert.ok(!shown.includes("cached-row"), "the stale cache row did not answer for it");
    assert.ok(h.store.has(bad), "the corrupt snapshot's session stayed tracked");
    assert.strictEqual(fs.readFileSync(badFile, "utf8"), raw, "the corrupt file is preserved");
    assert.ok(h.postsOf("error").some((m) => /saved messages and attachments/.test(m.text || "")),
      "the unreadable snapshot was reported");
    assert.strictEqual(h.store.has(healthy), false, "the healthy empty snapshot was pruned");
    assert.strictEqual(fs.existsSync(healthyFile), false, "and its file removed");
    assert.deepStrictEqual((h.controller.sessionsCache?.sessions || []).map((s) => s.id), ["fresh-row"],
      "the cache holds the fresh listing");
  } finally {
    await h.dispose();
  }
});

test("message persistence queued not sent failures retain structured work on reload", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  try {
    await h.ready();
    const id = await h.startChat("the running turn");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value), 8000), "the turn is running");
    h.controller.buildImplicitBlocks = () => [IMPLICIT_NOTE];
    const rt = h.controller.runtimes.get(id);

    const texts = ["first queued task", "second queued task", "third queued task"];
    const names = ["q1.png", "q2.png", "q3.png"];
    const datas = [IMG_A, IMG_B, IMG_A];
    const stagedIds = [];
    for (let i = 0; i < texts.length; i++) {
      h.send({ type: "attachImage", name: names[i], mime: "image/png", data: datas[i] });
      assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000),
        `attachment ${i} staged`);
      stagedIds.push(h.last("attachments").items[0].id);
      h.send({ type: "send", text: texts[i], kind: "queue" });
      assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === i + 1, 8000),
        `queued message ${i} listed`);
    }
    const queuedSnapshot = JSON.parse(JSON.stringify(rt.messages.queued));
    assert.strictEqual(queuedSnapshot.length, 3);

    // Composer state of its own, saved after the queue was written.
    h.send({ type: "draft", id, text: "composer words, not queued" });
    assert.ok(await h.until(() => h.store.draft(id) === "composer words, not queued", 8000));
    h.send({ type: "attachImage", name: "composer.png", mime: "image/png", data: IMG_B });
    assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000),
      "the composer image staged");
    const composerStagedId = h.last("attachments").items[0].id;

    const realPrompt = rt.client.prompt.bind(rt.client);
    let queuedCalls = 0;
    rt.client.prompt = () => {
      queuedCalls++;
      return Promise.reject(new h.AcpRequestNotSentError("ACP connection is closed"));
    };
    try {
      h.releasePrompt(id, 1);
      assert.ok(await h.until(() => rt.messages.paused === true && rt.busy === false, 10000),
        "the unsent queue settled paused and idle");
      assert.strictEqual(queuedCalls, 1, "only the first queued dispatch was attempted");
      assert.strictEqual(h.agentSaw("session/prompt").length, 1, "only the original prompt reached the wire");

      const restored = rt.messages.queued;
      assert.deepStrictEqual(restored.map((q) => q.id), queuedSnapshot.map((q) => q.id),
        "the same rows came back in order");
      assert.deepStrictEqual(restored.map((q) => q.kind), ["queue", "queue", "queue"]);
      assert.deepStrictEqual(restored.map((q) => q.text), texts);
      assert.deepStrictEqual(restored.map((q) => q.implicit), [[IMPLICIT_NOTE], [IMPLICIT_NOTE], [IMPLICIT_NOTE]],
        "each kept its implicit context");
      restored.forEach((q, i) => {
        assert.strictEqual(q.attachments.length, 1, `row ${i} kept its attachment`);
        assert.strictEqual(q.attachments[0].id, stagedIds[i], `row ${i} kept its staged id`);
        assert.strictEqual(q.attachments[0].label, names[i]);
        assert.strictEqual(q.attachments[0].block.data, datas[i], `row ${i} kept its image bytes`);
      });
      assert.strictEqual(h.store.draft(id), "composer words, not queued",
        "the independent draft was never concatenated into");
      const stagedNow = (h.last("attachments") || {}).items || [];
      assert.strictEqual(stagedNow.length, 1, "the composer image is still staged");
      assert.strictEqual(stagedNow[0].id, composerStagedId);
      assert.strictEqual(rt.messages.sent.length, 0, "the failed dispatch's manifest record is gone");

      await h.controller.messageStore.flush();
      await h.controller.shutdown();
      await h.dispose();

      const carried = Object.fromEntries(h.state.__map);
      delete carried["devin.viewingSession.v1"];
      delete carried["devin.activeSession.v1"];
      const next = createChat({ storage: h.storage, cwd: h.cwd, state: carried, promptGate: true });
      try {
        await next.ready();
        next.send({ type: "loadSession", id });
        assert.ok(await next.until(() => {
          const q = next.last("queued");
          return next.activeId() === id && q && q.paused === true && (q.items || []).length === 3;
        }, 10000), "the paused queue came back after the reload");
        const rt2 = next.controller.runtimes.get(id);
        const stored = rt2.messages.queued;
        assert.deepStrictEqual(stored.map((q) => q.id), queuedSnapshot.map((q) => q.id));
        assert.deepStrictEqual(stored.map((q) => q.kind), ["queue", "queue", "queue"]);
        assert.deepStrictEqual(stored.map((q) => q.text), texts);
        assert.deepStrictEqual(stored.map((q) => q.implicit), [[IMPLICIT_NOTE], [IMPLICIT_NOTE], [IMPLICIT_NOTE]]);
        stored.forEach((q, i) => {
          assert.strictEqual(q.attachments.length, 1);
          assert.strictEqual(q.attachments[0].label, names[i]);
          assert.strictEqual(q.attachments[0].block.data, datas[i]);
        });
        assert.strictEqual(next.store.draft(id), "composer words, not queued",
          "the draft survived the reload untouched");
        assert.ok(await next.until(() => (next.last("attachments")?.items || []).some((a) => a.id === composerStagedId), 8000),
          "the independent composer image came back after reload");
        const composerFiles = next.controller.staged.get(id) || [];
        assert.strictEqual(composerFiles.length, 1);
        assert.strictEqual(composerFiles[0].id, composerStagedId);
        assert.strictEqual(composerFiles[0].label, "composer.png");
        assert.strictEqual(composerFiles[0].block.data, IMG_B);
        assert.strictEqual(next.agentSaw("session/prompt").length, 0,
          "the restored queue sent nothing by itself");
      } finally {
        await next.dispose();
      }
    } finally {
      rt.client.prompt = realPrompt;
    }
  } finally {
    await h.dispose();
  }
});

test("message persistence concurrent unsent steers recover in dispatch order", posixOnly, async () => {
  const h = createChat({ midTurnPrompts: true, promptGate: true });
  try {
    await h.ready();
    const id = await h.startChat("the running turn");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value), 8000), "the turn is running");
    h.controller.buildImplicitBlocks = () => [IMPLICIT_NOTE];
    const rt = h.controller.runtimes.get(id);
    const realPrompt = rt.client.prompt.bind(rt.client);
    const rejecters = [];
    rt.client.prompt = () => new Promise((_, reject) => rejecters.push(reject));
    try {
      const texts = ["steer one", "steer two", "steer three"];
      const names = ["s1.png", "s2.png", "s3.png"];
      const datas = [IMG_A, IMG_B, IMG_A];
      const stagedIds = [];
      for (let i = 0; i < texts.length; i++) {
        h.send({ type: "attachImage", name: names[i], mime: "image/png", data: datas[i] });
        assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000),
          `attachment ${i} staged`);
        stagedIds.push(h.last("attachments").items[0].id);
        h.send({ type: "send", text: texts[i], kind: "steer" });
      }
      assert.ok(await h.until(() => rejecters.length === 3, 8000),
        "all three steers reached the stub in dispatch order");
      const echoIds = h.postsOf("userMessage")
        .filter((m) => texts.includes(m.text))
        .map((m) => m.clientMessageId);
      assert.deepStrictEqual(echoIds.length, 3, "each steer echoed once");
      const dispatchIds = rt.queuedDispatches.map((d) => d.message.id);
      assert.deepStrictEqual(dispatchIds, echoIds, "the dispatch records match the echoes");

      h.send({ type: "draft", id, text: "draft while steers fly" });
      assert.ok(await h.until(() => h.store.draft(id) === "draft while steers fly", 8000));

      const notSent = () => new h.AcpRequestNotSentError("ACP connection is closed");
      // Out of order on purpose: the queue must still come back in dispatch order.
      rejecters[2](notSent());
      assert.ok(await h.until(() => rt.messages.queued.length === 1, 8000), "the third steer recovered first");
      rejecters[0](notSent());
      assert.ok(await h.until(() => rt.messages.queued.length === 2, 8000), "then the first");
      rejecters[1](notSent());
      assert.ok(await h.until(() => rt.messages.queued.length === 3 && rt.messages.paused === true, 8000),
        "then the second, leaving a paused queue of three");

      h.releasePrompt(id, 1);
      assert.ok(await h.until(() => rt.busy === false, 10000), "the turn settled");

      const q = rt.messages.queued;
      assert.deepStrictEqual(q.map((x) => x.id), dispatchIds, "dispatch order, not rejection order");
      assert.deepStrictEqual(q.map((x) => x.kind), ["steer", "steer", "steer"]);
      assert.deepStrictEqual(q.map((x) => x.text), texts);
      assert.deepStrictEqual(q.map((x) => x.implicit), [[IMPLICIT_NOTE], [IMPLICIT_NOTE], [IMPLICIT_NOTE]]);
      q.forEach((x, i) => {
        assert.strictEqual(x.attachments.length, 1);
        assert.strictEqual(x.attachments[0].id, stagedIds[i]);
        assert.strictEqual(x.attachments[0].label, names[i]);
        assert.strictEqual(x.attachments[0].block.data, datas[i]);
      });
      assert.strictEqual(h.store.draft(id), "draft while steers fly", "the draft was untouched");
      assert.strictEqual(rt.messages.sent.length, 0, "every rejected request's manifest record is gone");
      assert.strictEqual(h.agentSaw("session/prompt").length, 1,
        "the original prompt only: no automatic retries reached the wire");
      await h.controller.messageStore.flush();
      const onDisk = JSON.parse(fs.readFileSync(messagesFile(h.storage, id), "utf8"));
      assert.strictEqual(onDisk.sent.length, 0, "and none survived on disk");
      assert.strictEqual(onDisk.queued.length, 3, "the paused queue is what the file holds");
      assert.strictEqual(onDisk.queued[0].text, texts[0]);
    } finally {
      for (const reject of rejecters) {
        reject(new Error("test cleanup"));
      }
      rt.client.prompt = realPrompt;
      h.releasePrompt(id, 1);
    }
  } finally {
    await h.dispose();
  }
});

test("message persistence a late queued not sent failure cannot resurrect a deleted session", posixOnly, async () => {
  const h = createChat({ promptGate: true });
  try {
    await h.ready();
    const id = await h.startChat("the running turn");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value), 8000), "the turn is running");
    h.send({ type: "attachImage", name: "queued.png", mime: "image/png", data: IMG_A });
    assert.ok(await h.until(() => ((h.last("attachments") || {}).items || []).length === 1, 8000));
    h.send({ type: "send", text: "queued then deleted", kind: "queue" });
    assert.ok(await h.until(() => (h.last("queued") || { items: [] }).items.length === 1, 8000));
    await h.controller.messageStore.flush();
    const file = messagesFile(h.storage, id);
    assert.ok(fs.existsSync(file), "the queued snapshot is on disk before the delete");

    const rt = h.controller.runtimes.get(id);
    const realPrompt = rt.client.prompt.bind(rt.client);
    let rejectQueued;
    let queuedStarted = false;
    rt.client.prompt = () => {
      queuedStarted = true;
      return new Promise((_, reject) => { rejectQueued = reject; });
    };
    try {
      h.releasePrompt(id, 1);
      assert.ok(await h.until(() => queuedStarted, 8000), "the queued dispatch reached the stub");
      const barrier = rt.turn;
      h.answerWith("Delete");
      h.send({ type: "deleteSession", id, title: "queued then deleted" });
      assert.ok(await h.until(() => !h.store.has(id) && !h.controller.runtimes.has(id), 8000),
        "the session was deleted while its prompt was in flight");
      await h.controller.messageStore.flush();
      assert.ok(!fs.existsSync(file), "the delete removed the snapshot");

      rejectQueued(new h.AcpRequestNotSentError("ACP connection is closed"));
      await barrier.catch(() => {});
      await h.controller.messageStore.flush();

      assert.ok(!fs.existsSync(file), "the late failure did not recreate the snapshot");
      assert.strictEqual(h.store.draft(id), "", "and no draft came back");
      assert.strictEqual(h.controller.staged.has(id), false, "and no staged files were restored");
      assert.strictEqual(h.store.hasPendingQueue(id), false, "and no pending flag survived");
    } finally {
      rejectQueued?.(new Error("test cleanup"));
      rt.client.prompt = realPrompt;
    }
  } finally {
    await h.dispose();
  }
});

test("message persistence a registration that outlives its runtime does not resurrect it", posixOnly, async () => {
  const h = createChat({ promptDelay: 150 });
  try {
    await h.ready();
    const id = await h.startChat("the live chat");
    assert.ok(await h.until(() => h.postsOf("busy").some((m) => m.value === false), 8000),
      "the opening turn ended");
    const rt = h.controller.runtimes.get(id);
    // A tracked list past the cap gives the registration a tail to scan, with
    // the last entry's snapshot read held open below.
    const olds = [];
    for (let i = 0; i < 200; i++) olds.push(`register-old-${i}`);
    await h.state.update("devin.sessionIds.v1", [id, ...olds]);
    h.store.setDraft(id, "draft that must not return");
    await h.controller.messageStore.save(id);
    await h.controller.messageStore.flush();
    const file = messagesFile(h.storage, id);
    assert.ok(fs.existsSync(file), "the live session's snapshot is on disk");

    const realLoad = h.controller.messageStore.load.bind(h.controller.messageStore);
    let releaseRead;
    const gate = new Promise((resolve) => { releaseRead = resolve; });
    let readHit = false;
    h.controller.messageStore.load = (sid) => {
      if (sid === "register-old-199") {
        readHit = true;
        return gate.then(() => realLoad(sid));
      }
      return realLoad(sid);
    };
    try {
      const pending = h.controller.rememberSession(id, h.cwd, rt);
      assert.ok(await h.until(() => readHit, 8000), "the tail scan reached the gated read");
      h.answerWith("Delete");
      h.send({ type: "deleteSession", id, title: "the live chat" });
      assert.ok(await h.until(() => !h.store.has(id) && !h.controller.runtimes.has(id), 8000),
        "the session was deleted while the read was held");
      await h.controller.messageStore.flush();
      releaseRead();
      await pending;
      await h.controller.messageStore.flush();

      assert.strictEqual(h.store.has(id), false, "the deleted session was not re-registered");
      assert.strictEqual(h.store.draft(id), "", "and its draft stayed gone");
      assert.ok(!fs.existsSync(file), "and no snapshot was recreated");
      assert.strictEqual(h.store.hasPendingQueue(id), false, "and no pending flag survived");
    } finally {
      releaseRead?.();
      delete h.controller.messageStore.load;
    }
  } finally {
    await h.dispose();
  }
});


for (const action of ["remove", "edit", "retry"]) {
  test(`message persistence concurrent failure respects a recovered row ${action}`, posixOnly, async () => {
    const h = createChat({ midTurnPrompts: true, promptGate: true });
    try {
      await h.ready();
      const id = await h.startChat("the original turn");
      const rt = h.controller.runtimes.get(id);
      const realPrompt = rt.client.prompt.bind(rt.client);
      const rejects = [];
      rt.client.prompt = () => new Promise((_, reject) => rejects.push(reject));
      try {
        for (const [text, name] of [["recover A", "a.png"], ["recover B", "b.png"]]) {
          h.send({ type: "attachImage", name, mime: "image/png", data: PNG });
          assert.ok(await h.until(() => (h.last("attachments")?.items || []).length === 1, 8000));
          h.send({ type: "send", text, kind: "steer" });
        }
        assert.ok(await h.until(() => rejects.length === 2, 8000));
        const ids = h.postsOf("userMessage").filter((m) => ["recover A", "recover B"].includes(m.text))
          .map((m) => m.clientMessageId);
        assert.strictEqual(ids.length, 2);
        h.store.setDraft(id, "independent composer words");
        const notSent = () => new h.AcpRequestNotSentError("ACP connection is closed");
        rejects[0](notSent());
        assert.ok(await h.until(() => rt.messages.paused && rt.messages.queued.length === 1, 8000));
        assert.strictEqual(rt.messages.queued[0].id, ids[0]);
        if (action === "remove") {
          h.send({ type: "removeQueued", id: ids[0] });
          assert.ok(await h.until(() => rt.messages.queued.length === 0, 8000));
        } else if (action === "edit") {
          h.send({ type: "queueEditing", id: ids[0] });
          assert.ok(await h.until(() => (h.last("attachments")?.items || []).some((a) => a.label === "a.png"), 8000));
          h.send({ type: "editQueued", id: ids[0], text: "edited recovery A", kind: "steer" });
          h.send({ type: "queueEditing", id: null });
          assert.ok(await h.until(() => rt.messages.queued[0]?.text === "edited recovery A", 8000));
        } else {
          h.send({ type: "resumeQueue" });
          assert.ok(await h.until(() => rejects.length === 3, 8000), "the explicit retry reached the stub");
          rejects[2](notSent());
          assert.ok(await h.until(() => rt.messages.paused && rt.messages.queued.length === 1, 8000),
            "the retry restored exactly one row");
        }
        rejects[1](notSent());
        h.releasePrompt(id, 1);
        assert.ok(await h.until(() => !rt.busy, 10000));
        const expectedIds = action === "remove" ? [ids[1]] : ids;
        const expectedTexts = action === "remove" ? ["recover B"]
          : action === "edit" ? ["edited recovery A", "recover B"] : ["recover A", "recover B"];
        assert.deepStrictEqual(rt.messages.queued.map((q) => q.id), expectedIds,
          "late failures preserve the current rows without resurrecting or duplicating an id");
        assert.deepStrictEqual(rt.messages.queued.map((q) => q.text), expectedTexts);
        assert.deepStrictEqual(rt.messages.queued.map((q) => q.attachments[0].label),
          action === "remove" ? ["b.png"] : ["a.png", "b.png"]);
        assert.ok(rt.messages.queued.every((q) => q.attachments[0].block.data === PNG));
        assert.strictEqual(rt.messages.paused, true);
        assert.strictEqual(h.store.draft(id), "independent composer words");
        assert.strictEqual(rejects.length, action === "retry" ? 3 : 2,
          "only the explicit retry made an extra attempt");
        await h.controller.messageStore.flush();
        const saved = JSON.parse(fs.readFileSync(messagesFile(h.storage, id), "utf8"));
        assert.deepStrictEqual(saved.queued.map((q) => q.id), expectedIds);
      } finally {
        for (const reject of rejects) reject(new Error("test cleanup"));
        rt.client.prompt = realPrompt;
        h.releasePrompt(id, 1);
      }
    } finally {
      await h.dispose();
    }
  });
}

test.after(() => cleanup());
