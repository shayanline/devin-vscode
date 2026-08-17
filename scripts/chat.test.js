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
const path = require("node:path");
const { createChat, cleanup } = require("./chat-harness");

// The fake agent is a `/bin/sh` wrapper, so the CLI resolver cannot run it on Windows:
// the health check fails, no chat starts, and every test here would fail for that one
// reason. Skipped rather than left to fail, until the harness grows a `.cmd` shim (which
// would also exercise the Windows quoting path in cli/locate.ts, so it is worth doing).
const posixOnly = { skip: process.platform === "win32" };

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
    h.send({ type: "openFile", path: href });
    await h.until(() => globalThis.__dvOpened.at(-1) === fileUri);
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
  h.send({ type: "send", text: "a new chat", newSession: true });
  await h.settle(120);
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

test("messages queued behind a turn come back as a draft when the surface goes", posixOnly, async () => {
  // The queue only ever lived on the runtime. Closing a chat tab mid turn offers to
  // terminate it, and taking that offer went through dispose, which threw the queue
  // away, while terminating the same chat from the list handed it back.
  const h = createChat({ promptDelay: 60000 });
  await h.ready();
  const id = await h.startChat("the turn");
  await h.until(() => h.postsOf("busy").some((m) => m.value));

  h.send({ type: "send", text: "queued behind it" });
  await h.until(() => (h.last("queued") || { items: [] }).items.length === 1);
  assert.deepStrictEqual(prompts(h).map((p) => p.text), ["the turn"], "the second is not sent");

  h.controller.dispose();
  await h.until(() => /queued behind it/.test(h.store.draft(id) || ""));
  assert.match(h.store.draft(id), /queued behind it/, "the writing is back in that chat's box");
  await h.dispose();
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
  // another while it wakes, used to send the message to that other chat's agent.
  const h = createChat({ promptDelay: 150 });
  await h.ready();
  const woken = await h.startChat("the chat with the message");
  await h.until(() => prompts(h).length === 1, 6000);
  h.answerWith("Terminate");
  h.send({ type: "terminateSession", woken, id: woken });
  await h.until(() => h.liveChats() === 0, 6000);
  h.answerWith(undefined);

  const other = await h.startChat("the chat opened instead");
  await h.until(() => prompts(h).length === 2, 6000);
  h.send({ type: "leaveToList" });
  await h.settle(100);

  // Wake the first, write into it, then open the other one while it is still waking.
  h.setDelays({ loadDelay: 1200 });
  h.send({ type: "wakeSession", id: woken });
  await h.settle(250);
  h.send({ type: "send", text: "for the chat I wrote it in" });
  await h.settle(50);
  h.send({ type: "activateSession", id: other });
  await h.until(() => h.activeId() === other, 4000);
  await h.settle(2000);

  const carried = h.agentSaw("session/prompt").filter((m) =>
    (m.params.prompt || []).some((b) => b.text === "for the chat I wrote it in")
  );
  assert.strictEqual(carried.length, 1, "it was sent once");
  assert.strictEqual(carried[0].params.sessionId, woken, "to the chat it was written in");
  await h.dispose();
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

test.after(() => cleanup());
