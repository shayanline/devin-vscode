// Regression tests for the chat webview, run against the real bundle via the
// jsdom harness. Run with: npm test   (compiles the bundle first).
//
// These guard the rendering path that broke when `busy` was undefined: a throw
// inside buildTurnChrome left user request bubbles empty on session load and
// skipped scroll-to-bottom on live sends.

const test = require("node:test");
const assert = require("node:assert");
const { createHarness } = require("./webview-harness");

test("session load replays user request bubbles with their text", async () => {
  const h = createHarness();
  h.replay([
    { role: "user", text: "first user question" },
    { role: "assistant", text: "first assistant answer" },
    { role: "user", text: "second user question" },
    { role: "assistant", text: "second assistant answer" }
  ]);
  await h.settle();

  assert.deepStrictEqual(h.reqTexts(), ["first user question", "second user question"]);
  assert.deepStrictEqual(h.respTexts(), ["first assistant answer", "second assistant answer"]);
  assert.strictEqual(
    h.errors().length,
    0,
    "webview handler threw: " + JSON.stringify(h.errors())
  );
});

test("live user message renders without a handler error", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "userMessage", text: "hello from a live send" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "hi there" });
  h.post({ type: "assistantEnd" });
  await h.settle();

  assert.deepStrictEqual(h.reqTexts(), ["hello from a live send"]);
  assert.deepStrictEqual(h.respTexts(), ["hi there"]);
  assert.strictEqual(h.errors().length, 0, "webview handler threw: " + JSON.stringify(h.errors()));
});

test("per-turn edit/restore chrome builds while busy (no throw)", async () => {
  const h = createHarness();
  h.replay([{ role: "user", text: "q" }, { role: "assistant", text: "a" }]);
  // Toggling busy rebuilds every turn's chrome (canEditTurn/canRestoreTurn read `busy`).
  h.post({ type: "busy", value: true });
  h.post({ type: "busy", value: false });
  await h.settle();

  assert.strictEqual(h.errors().length, 0, "toggling busy threw: " + JSON.stringify(h.errors()));
});
