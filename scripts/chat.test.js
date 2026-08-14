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

test("a message does not take the files of the chat opened while it was being sent", async () => {
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

test("a chat that finishes starting in the background does not take the panel", async () => {
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
  await h.settle(900);

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

test("a chat still opening is reported as starting, not as idle", async () => {
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

test("messages queued behind a turn come back as a draft when the surface goes", async () => {
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

test("a second send never puts a second prompt on the same channel", async () => {
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
