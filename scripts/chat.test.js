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
const { createChat, cleanup } = require("./chat-harness");

// The fake agent is a `/bin/sh` wrapper, so the CLI resolver cannot run it on Windows:
// the health check fails, no chat starts, and every test here would fail for that one
// reason. Skipped rather than left to fail, until the harness grows a `.cmd` shim (which
// would also exercise the Windows quoting path in cli/locate.ts, so it is worth doing).
const posixOnly = { skip: process.platform === "win32" };

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
    await h.until(() => h.liveChats() === 2, 20000),
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

test.after(() => cleanup());
