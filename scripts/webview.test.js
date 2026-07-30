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

test("elicitation renders oneOf/anyOf options and submits the chosen consts", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "Focus",
    allowOther: true,
    schema: {
      type: "object",
      required: ["q0", "q1"],
      properties: {
        q0: {
          type: "string",
          title: "Focus",
          description: "Focus",
          oneOf: [{ const: "A", title: "Option A" }, { const: "B", title: "Option B" }]
        },
        q1: {
          type: "array",
          title: "Tasks",
          description: "Tasks",
          minItems: 1,
          items: { anyOf: [{ const: "X", title: "Option X" }, { const: "Y", title: "Option Y" }] }
        }
      }
    }
  });
  await h.settle(30);

  const tray = h.window.document.getElementById("elicitation-tray");
  assert.ok(tray.querySelectorAll(".elicit-option").length >= 4, "options should render");

  const radios = [...tray.querySelectorAll('input[type="radio"]')];
  const checks = [...tray.querySelectorAll('input[type="checkbox"]')];
  radios.find((r) => r.value === "A").checked = true;
  checks.find((c) => c.value === "X").checked = true;
  [...tray.querySelectorAll("button")].find((b) => b.textContent === "Submit").click();
  await h.settle(10);

  const resp = h.posted.find((m) => m.type === "elicitationResponse");
  assert.ok(resp, "an elicitationResponse should be posted");
  assert.strictEqual(resp.action, "accept");
  assert.deepStrictEqual(resp.content, { q0: "A", q1: ["X"] });
  assert.strictEqual(h.errors().length, 0);
});

test("leaving a running session to the list detaches the composer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "userMessage", text: "do a big task" });
  h.post({ type: "assistantStart" });
  h.post({ type: "busy", value: true });
  h.post({ type: "attachments", items: [{ id: "a1", label: "file.ts", type: "file" }] });
  const input = h.document.getElementById("input");
  input.value = "draft I never sent";
  await h.settle(20);

  // Go back to history while the turn is still running.
  h.document.getElementById("history-btn").click();
  await h.settle(20);

  assert.ok(h.posted.some((m) => m.type === "leaveToList"), "should ask the host to cancel/detach");
  assert.strictEqual(input.value, "", "the draft should be cleared for a clean new-chat box");
  assert.ok(
    h.document.getElementById("composer").classList.contains("list-mode"),
    "the composer should switch to list mode"
  );
  assert.strictEqual(
    h.document.getElementById("attachments").children.length,
    0,
    "attachment pills from the old session should be cleared"
  );
  assert.ok(
    h.document.getElementById("stop").classList.contains("hidden"),
    "the Stop/working indicator should not persist in the list view"
  );
  assert.ok(
    !h.document.getElementById("sessions-list").classList.contains("hidden"),
    "the sessions list should be visible"
  );
  assert.strictEqual(h.errors().length, 0, "leaving to list threw: " + JSON.stringify(h.errors()));
});

test("session list shows liveness dots and offers take-over", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [
      { id: "aaa", short_id: "aaa", title: "Running one", working_directory: "/w" },
      { id: "bbb", short_id: "bbb", title: "Idle one", working_directory: "/w" },
      { id: "ccc", short_id: "ccc", title: "Dead one", working_directory: "/w" }
    ],
    activeId: "aaa",
    statuses: { aaa: "running", bbb: "idle" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(20);

  const cls = [...h.document.querySelectorAll("#sessions-list .session-dot")].map((d) => d.className);
  assert.ok(cls.some((c) => c.includes("dot-running")), "a running (green) dot");
  assert.ok(cls.some((c) => c.includes("dot-idle")), "an idle (amber) dot");
  assert.ok(cls.some((c) => c.includes("dot-dead")), "a dead (gray) dot for the session with no status");

  // Live sessions offer a terminate action; dead ones do not.
  const rows = [...h.document.querySelectorAll("#sessions-list .session-item")];
  const terminate = rows[0].querySelector(".session-actions .codicon-circle-slash");
  assert.ok(terminate, "a live session row has a terminate button");
  assert.ok(!rows[2].querySelector(".codicon-circle-slash"), "a dead session row has no terminate button");
  terminate.parentElement.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "terminateSession" && m.id === "aaa"), "terminate posts terminateSession");

  // A locked session offers take-over, which posts the decision back.
  h.post({ type: "lockConflict", requestId: "lock-1", id: "aaa", pid: 4242 });
  await h.settle(10);
  const takeover = [...h.document.querySelectorAll("#permission-tray button")].find((b) => b.textContent === "Take over");
  assert.ok(takeover, "a Take over button renders");
  takeover.click();
  await h.settle(10);
  const decision = h.posted.find((m) => m.type === "takeoverDecision");
  assert.ok(decision && decision.decision === "takeover" && decision.requestId === "lock-1", "take-over decision posted");
  assert.strictEqual(h.errors().length, 0, "status/lock handling threw: " + JSON.stringify(h.errors()));
});

test("returning to an idle session restores its transcript without reloading", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "hello from A" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "hi A" });
  h.post({ type: "assistantEnd" });
  await h.settle(20);
  assert.deepStrictEqual(h.reqTexts(), ["hello from A"]);

  // Go back to the list (session A is snapshotted, kept alive in the background).
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: { A: "idle" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(10);

  const before = h.posted.filter((m) => m.type === "loadSession").length;
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);

  assert.ok(h.posted.some((m) => m.type === "activateSession" && m.id === "A"), "activate without reload");
  assert.strictEqual(
    h.posted.filter((m) => m.type === "loadSession").length,
    before,
    "an idle, unchanged session must not be reloaded"
  );
  assert.deepStrictEqual(h.reqTexts(), ["hello from A"], "the transcript is restored, not rebuilt");
  assert.strictEqual(h.errors().length, 0, "restore threw: " + JSON.stringify(h.errors()));
});

test("a session that changed in the background is reloaded, not restored", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "hello from A" });
  h.post({ type: "assistantEnd" });
  await h.settle(20);
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  // A started working again while backgrounded.
  h.post({ type: "sessionActivity", id: "A" });
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: { A: "running" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(10);
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "loadSession" && m.id === "A"), "changed session reloads");
  assert.strictEqual(h.errors().length, 0);
});

test("renders response images and inline keep/undo on edits", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "take a screenshot and edit a file" });
  h.post({ type: "assistantStart" });
  const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  h.post({ type: "assistantImage", mime: "image/png", data: px });
  h.post({ type: "fileChange", path: "/w/app.ts", added: 3, removed: 1 });
  h.post({ type: "assistantEnd" });
  await h.settle(20);

  const img = h.document.querySelector("#thread .resp-image");
  assert.ok(img && img.src.startsWith("data:image/png;base64,"), "response image renders");

  const pill = h.document.querySelector("#thread .edit-pill");
  assert.ok(pill, "edit pill renders");
  const keep = pill.querySelector(".edit-pill-actions .codicon-check");
  assert.ok(keep, "inline Keep action renders");
  keep.parentElement.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "acceptFile" && m.path === "/w/app.ts"), "Keep posts acceptFile");
  assert.ok(pill.classList.contains("resolved"), "pill marks resolved after keep");
  assert.strictEqual(h.errors().length, 0, "image/edit rendering threw: " + JSON.stringify(h.errors()));
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
