// Regression tests for the chat webview, run against the real bundle via the
// jsdom harness. Run with: npm test   (compiles the bundle first).
//
// These guard the rendering path that broke when `busy` was undefined: a throw
// inside buildTurnChrome left user request bubbles empty on session load and
// skipped scroll-to-bottom on live sends.

const { after, describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness: mountHarness } = require("./webview-harness");

const ROOT = path.resolve(__dirname, "..");
const harnesses = [];
const createHarness = (...args) => {
  const harness = mountHarness(...args);
  harnesses.push(harness);
  return harness;
};
after(() => harnesses.forEach(({ window }) => window.close()));

describe("webview", { concurrency: 8 }, () => {
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

test("ready reveals the chat before session data arrives", async () => {
  const h = createHarness();
  const boot = h.document.getElementById("boot");
  assert.ok(!boot.classList.contains("hidden"));

  h.post({ type: "ready" });
  await h.settle();

  assert.ok(boot.classList.contains("hidden"));
});

test("a thread send reports that its transcript can be preserved", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "an earlier message" });
  h.post({ type: "busy", value: false });
  const input = h.document.getElementById("input");
  input.value = "continue";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  await h.settle();

  const sent = h.posted.filter((m) => m.type === "send").pop();
  assert.deepStrictEqual(sent, { type: "send", text: "continue", newSession: false, preserveTranscript: true });
});

test("a replay batch preserves historical update order", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  h.post({
    type: "replay",
    items: [
      { type: "userChunk", text: "earlier question", messageId: "u1" },
      { type: "assistantChunk", text: "earlier answer", messageId: "a1" }
    ]
  });
  h.post({ type: "loaded" });
  await h.settle();

  assert.deepStrictEqual(h.reqTexts(), ["earlier question"]);
  assert.deepStrictEqual(h.respTexts(), ["earlier answer"]);
});

test("terminal output cache releases the oldest completed entry", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  for (let i = 0; i < 51; i++) {
    h.post({ type: "terminalOutput", terminalId: `term-${i}`, output: `output ${i}`, exitStatus: { exitCode: 0 } });
  }
  h.post({ type: "toolCall", id: "old", kind: "execute", status: "completed", rawInput: { command: "old" }, content: [{ type: "terminal", terminalId: "term-0" }] });
  h.post({ type: "toolCall", id: "new", kind: "execute", status: "completed", rawInput: { command: "new" }, content: [{ type: "terminal", terminalId: "term-50" }] });
  await h.settle();

  assert.strictEqual(h.thread().querySelector('pre[data-terminal="term-0"]').textContent, "…");
  assert.match(h.thread().querySelector('pre[data-terminal="term-50"]').textContent, /output 50/);
});

test("terminal output cache retains an oldest running terminal", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  for (let i = 0; i < 50; i++) {
    h.post({ type: "terminalOutput", terminalId: `running-${i}`, output: `running ${i}`, exitStatus: null });
  }
  h.post({ type: "terminalOutput", terminalId: "completed", output: "finished", exitStatus: { exitCode: 0 } });
  h.post({ type: "toolCall", id: "running", kind: "execute", status: "in_progress", rawInput: { command: "watch" }, content: [{ type: "terminal", terminalId: "running-0" }] });
  await h.settle();

  assert.match(h.thread().querySelector('pre[data-terminal="running-0"]').textContent, /running 0/);
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

test("assistant file references render as clickable links", async () => {
  const h = createHarness();
  const href = "file:///Users/shayan.khaksar/VSCode/devin-vscode/src/acp/client.ts#L20";
  h.replay([{ role: "assistant", text: `See [client.ts:243-251](${href})` }]);
  await h.settle();

  const link = h.thread().querySelector(".resp-text a");
  assert.ok(link, "file references should render as anchors");
  assert.ok(link.classList.contains("file-change"), "file references use the normal file pill class");
  assert.ok(link.classList.contains("file-pill"), "file references use the shared file pill base");
  assert.strictEqual(link.querySelector(".file-pill-name").textContent, "client.ts:243-251");
  assert.ok(link.querySelector(".file-pill-icon.codicon-file-code"), "file references use the path based file icon");
  assert.strictEqual(link.querySelector(".file-pill-icon").getAttribute("aria-hidden"), "true");
  assert.strictEqual(link.getAttribute("href"), href);
  assert.strictEqual(link.tabIndex, 0);
  assert.strictEqual(link.getAttribute("role"), "button");
  link.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  link.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  link.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(h.posted.at(-1), { type: "openFile", path: href });
  assert.strictEqual(h.errors().length, 0, "webview handler threw: " + JSON.stringify(h.errors()));
});

test("code wrapped file links become file pills without changing code", async () => {
  const h = createHarness();
  const href = "file:///Users/shayan.khaksar/VSCode/OpenIPTV/package.json";
  h.replay([{
    role: "assistant",
    text: `The version is in \`[package.json](${href})\`, \`[config](src/config.ts)\`, \`[spaced](<src/config file.ts>)\`, and \`[web](<https://example.com>)\`.\n\n\`\`\`text\n[leave this alone](file:///tmp/example.ts)\n\`\`\``
  }]);
  await h.settle();

  const links = [...h.thread().querySelectorAll(".resp-text a.file-pill")];
  assert.strictEqual(links.length, 3, "code wrapped file links become file pills");
  assert.deepStrictEqual(links.map((link) => link.querySelector(".file-pill-name").textContent), ["package.json", "config", "spaced"]);
  assert.ok([...h.thread().querySelectorAll("code")].some((code) => code.textContent.includes("[web]")),
    "angle wrapped external links remain code");
  assert.ok(h.thread().querySelector("pre code").textContent.includes("leave this alone"),
    "fenced code remains code");
});

test("external links stay external and relative links open decoded paths", async () => {
  const h = createHarness();
  h.replay([{
    role: "assistant",
    text: "[FTP](ftp://example.com/file) [Doc](docs/C%23.md#section) " +
      "[Drive](C:/repo/src/app.ts) [Query](?view=raw) [Section](./#section)"
  }]);
  await h.settle();

  const [ftp, doc, drive, query, section] = h.thread().querySelectorAll(".resp-text a");
  assert.ok(ftp && doc && drive && query && section, "all links should render");
  assert.ok(!ftp.classList.contains("file-pill"), "external links stay plain");
  assert.ok(doc.classList.contains("file-pill"), "relative links use file styling");
  assert.ok(drive.classList.contains("file-pill"), "drive paths use file styling");
  assert.ok(!query.classList.contains("file-pill"), "query links stay plain");
  assert.ok(!section.classList.contains("file-pill"), "empty relative fragments stay plain");
  ftp.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  query.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  section.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  assert.strictEqual(h.posted.some((m) => m.type === "openFile"), false, "non file links stay with VS Code");
  drive.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(h.posted.at(-1), { type: "openFile", path: "C:/repo/src/app.ts" });
  doc.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  assert.deepStrictEqual(h.posted.at(-1), { type: "openFile", path: "docs/C#.md" });
});

test("changing inline reference style updates existing links", async () => {
  const h = createHarness();
  h.replay([{ role: "assistant", text: "See [client.ts](src/client.ts)" }]);
  await h.settle();
  const link = h.thread().querySelector(".resp-text a");
  assert.ok(link.classList.contains("file-pill"));

  h.post({ type: "capabilities", inlineReferencesStyle: "link" });
  await h.settle();
  assert.ok(!link.classList.contains("file-pill"), "link mode removes existing pill styling");
  assert.strictEqual(link.querySelector(".file-pill-icon"), null, "link mode removes the file icon");

  h.post({ type: "capabilities", inlineReferencesStyle: "box" });
  await h.settle();
  assert.ok(link.classList.contains("file-pill"), "box mode restores existing pill styling");
  assert.ok(link.querySelector(".file-pill-icon"), "box mode restores the file icon");
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

  // VS Code layout: a leading 1-based number and a trailing check per row.
  const firstOpt = tray.querySelector(".elicit-option");
  assert.strictEqual(firstOpt.querySelector(".elicit-number").textContent, "1", "leading option number");
  assert.ok(firstOpt.lastElementChild.classList.contains("elicit-indicator"), "check indicator is trailing");

  const submitBtn = [...tray.querySelectorAll("button")].find((b) => b.textContent === "Submit");
  // Submit is disabled until every question is answered (no default selection).
  assert.ok(submitBtn.disabled, "Submit is disabled before any option is chosen");

  const radios = [...tray.querySelectorAll('input[type="radio"]')];
  const checks = [...tray.querySelectorAll('input[type="checkbox"]')];
  const pick = (input) => { input.checked = true; input.dispatchEvent(new h.window.Event("change", { bubbles: true })); };
  pick(radios.find((r) => r.value === "A"));
  assert.ok(submitBtn.disabled, "still disabled with one of two questions answered");
  pick(checks.find((c) => c.value === "X"));
  assert.ok(!submitBtn.disabled, "enabled once all questions are answered");
  submitBtn.click();
  await h.settle(10);

  const resp = h.posted.find((m) => m.type === "elicitationResponse");
  assert.ok(resp, "an elicitationResponse should be posted");
  assert.strictEqual(resp.action, "accept");
  assert.deepStrictEqual(resp.content, { q0: "A", q1: ["X"] });
  assert.strictEqual(h.errors().length, 0);
});

test("opening the session list delegates refresh to its visibility signal", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "A" });
  await h.settle();
  h.posted.length = 0;

  h.document.getElementById("history-btn").click();
  await h.settle();

  assert.ok(h.posted.some((message) => message.type === "listVisible" && message.value === true));
  assert.strictEqual(h.posted.some((message) => message.type === "refreshSessions"), false);
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
  const terminate = rows[0].querySelector(".session-actions .kill-glyph");
  assert.ok(terminate, "a live session row has a terminate (kill) button");
  assert.ok(!rows[2].querySelector(".kill-glyph"), "a dead session row has no terminate button");
  terminate.parentElement.click();
  await h.settle(5);
  assert.ok(
    h.posted.some((m) => m.type === "terminateSession" && m.id === "aaa" && m.title === "Running one" && !m.returnToList),
    "row terminate posts terminateSession with the title and no returnToList"
  );

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
  h.post({ type: "busy", value: false });
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

test("a changed, now-idle session is reloaded, not restored", async () => {
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
  // A changed while backgrounded and has since gone idle: its snapshot is stale,
  // and reloading an idle runtime is safe.
  h.post({ type: "sessionActivity", id: "A" });
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: { A: "idle" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(10);
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "loadSession" && m.id === "A"), "changed idle session reloads");
  assert.strictEqual(h.errors().length, 0);
});

test("a chat left while it was still opening is reloaded, not restored half rendered", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  // A full load: the spinner is up and the history streams in behind it.
  h.post({ type: "clear", loading: true });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "sessionStatuses", statuses: { A: "starting" }, activeId: "A" });
  h.post({ type: "userChunk", text: "the first of several turns" });
  await h.settle(20);

  // Left before the replay finished, so what is cached is a part of the transcript
  // with the spinner still in it, and the rest of the replay is dropped: the host
  // stops painting for a chat that is no longer on screen.
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

  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "loadSession" && m.id === "A"),
    "it loads the chat again rather than showing what it managed to render"
  );
  assert.ok(
    !h.posted.some((m) => m.type === "activateSession" && m.id === "A"),
    "and does not just re-point at it"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("returning to a session with a turn in flight re-attaches, never reloads", async () => {
  // Reloading a running session over its live channel aborts the prompt
  // ("Agent communication channel closed"), so a running session must activate.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", pendingSend: true });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "hello from A" });
  h.post({ type: "assistantStart" });
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: "A",
    statuses: { A: "running" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(20);
  // Leave to the list mid-turn, then reopen while still running.
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: { A: "running" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(10);
  const loadsBefore = h.posted.filter((m) => m.type === "loadSession").length;
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "activateSession" && m.id === "A"), "running session re-attaches");
  assert.strictEqual(
    h.posted.filter((m) => m.type === "loadSession").length,
    loadsBefore,
    "a running session must not be reloaded"
  );
  assert.deepStrictEqual(h.reqTexts(), ["hello from A"], "the user message is preserved and stays first");
  assert.strictEqual(h.errors().length, 0);
});

test("reselecting a terminated session restores its transcript and wakes silently", async () => {
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
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.deepStrictEqual(h.reqTexts(), ["hello from A"]);

  // Terminate returns us to the list (host-driven body:list) and the session is
  // now dead (no live status).
  h.post({ type: "body", body: "list" });
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: {},
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(10);

  const loadsBefore = h.posted.filter((m) => m.type === "loadSession").length;
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);

  assert.ok(h.posted.some((m) => m.type === "wakeSession" && m.id === "A"), "a dead session wakes in the background");
  assert.strictEqual(
    h.posted.filter((m) => m.type === "loadSession").length,
    loadsBefore,
    "no full reload (so no 'Waking…' spinner replaces the thread)"
  );
  assert.strictEqual(h.document.querySelectorAll(".thread-loading").length, 0, "no loading spinner is shown");
  assert.deepStrictEqual(h.reqTexts(), ["hello from A"], "the transcript stays on screen");
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

  const img = h.document.querySelector("#thread .dv-thumb");
  assert.ok(img && img.src.startsWith("data:image/png;base64,"), "response image renders");
  // A picture opens to full size in place, rather than only ever being a thumbnail.
  img.click();
  await h.settle(5);
  assert.ok(img.classList.contains("expanded"), "and can be opened up");

  const pill = h.document.querySelector("#thread .edit-pill");
  assert.ok(pill, "edit pill renders");
  const keep = pill.querySelector(".edit-pill-actions .codicon-check");
  assert.ok(keep, "inline Keep action renders");
  keep.parentElement.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "acceptFile" && m.path === "/w/app.ts"), "Keep posts acceptFile");
  h.post({ type: "changesResolved", paths: ["/w/app.ts"], action: "accept" });
  await h.settle(5);
  assert.ok(pill.classList.contains("resolved"), "pill marks resolved once the host says so");
  assert.strictEqual(h.errors().length, 0, "image/edit rendering threw: " + JSON.stringify(h.errors()));
});

test("web search, fetch, and MCP tools render distinctly via _meta", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "research" });
  h.post({ type: "assistantStart" });

  // Web search reports the coarse kind "fetch" but is identified via _meta.
  h.post({ type: "toolCall", id: "s1", title: "Searched web for node lts", kind: "fetch",
    meta: { inferenceToolName: "web_search" }, status: "pending", rawInput: { query: "node lts" } });
  h.post({ type: "toolCallUpdate", id: "s1", status: "completed", meta: { inferenceToolName: "web_search" },
    content: [{ type: "text", text: 'Found 5 result(s) for "node lts"' }] });

  // Web fetch: clickable URL.
  h.post({ type: "toolCall", id: "f1", title: "Fetched https://example.com", kind: "fetch",
    meta: { inferenceToolName: "webfetch" }, status: "pending", rawInput: { url: "https://example.com" } });
  h.post({ type: "toolCallUpdate", id: "f1", status: "completed", meta: { inferenceToolName: "webfetch" },
    content: [{ type: "text", text: "Fetched 176 characters from https://example.com" }] });

  // MCP tool call with a JSON result.
  h.post({ type: "toolCall", id: "m1", title: "Calling get_current_time from time",
    meta: { eventType: "mcp_tool_call", toolName: "mcp__time__get_current_time", inferenceToolName: "mcp__time__get_current_time" },
    status: "pending", rawInput: { timezone: "UTC" } });
  h.post({ type: "toolCallUpdate", id: "m1", status: "completed",
    meta: { eventType: "mcp_tool_call", toolName: "mcp__time__get_current_time" },
    content: [{ type: "text", text: '{\n  "timezone": "UTC",\n  "datetime": "2026-01-01T00:00:00+00:00"\n}' }] });

  await h.settle(20);

  const tools = [...h.document.querySelectorAll("#thread .tool")];
  const search = tools.find((t) => /Searched web/.test(t.textContent));
  assert.ok(search, "search tool renders");
  assert.ok(search.querySelector(".tool-kind.codicon-globe"), "search uses the globe icon");
  assert.ok(search.querySelector(".tool-summary-label"), "search shows a summary line, not raw JSON");
  assert.ok(search.querySelector(".tool-result-note"), "search shows a dim result caption");

  const fetchT = tools.find((t) => /Fetched https/.test(t.textContent));
  assert.ok(fetchT && fetchT.querySelector("a.tool-summary-value"), "fetch renders a clickable URL");

  const mcp = tools.find((t) => /Calling get_current_time/.test(t.textContent));
  assert.ok(mcp && mcp.querySelector(".tool-kind.codicon-mcp"), "mcp uses the VS Code MCP icon");
  assert.ok(
    [...mcp.querySelectorAll(".tool-section-title")].some((e) => e.textContent === "Arguments"),
    "mcp shows an Arguments section"
  );
  assert.ok(mcp.querySelector(".tool-pre.hljs"), "mcp JSON result is highlighted");

  assert.strictEqual(h.errors().length, 0, "tool rendering threw: " + JSON.stringify(h.errors()));
});

test("consecutive tool calls collapse into a grouped disclosure", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "explore" });
  h.post({ type: "assistantStart" });

  for (const id of ["t1", "t2", "t3"]) {
    h.post({ type: "toolCall", id, title: "Read src/" + id + ".ts", kind: "read", status: "pending" });
    h.post({ type: "toolCallUpdate", id, status: "completed" });
  }
  await h.settle(10);

  let groups = [...h.document.querySelectorAll("#thread .tool-group")];
  assert.strictEqual(groups.length, 1, "the three tools form a single group");
  assert.strictEqual(
    groups[0].querySelectorAll(".tool-group-body > .tool").length,
    3,
    "all three tools nest inside the group"
  );
  assert.ok(/^Read 3 files/.test(groups[0].textContent), "the group says what the run did");
  assert.ok(!groups[0].classList.contains("running"), "a finished group is not marked running");

  // Assistant text ends the run; a following tool starts fresh and ungrouped.
  h.post({ type: "assistantChunk", text: "done reading" });
  h.post({ type: "toolCall", id: "t4", title: "Read src/final.ts", kind: "read", status: "completed" });
  await h.settle(10);

  groups = [...h.document.querySelectorAll("#thread .tool-group")];
  assert.strictEqual(groups.length, 1, "the lone post-text tool does not form a new group");
  const t4 = [...h.document.querySelectorAll("#thread .tool")].find((t) => /final\.ts/.test(t.textContent));
  assert.ok(t4 && !t4.closest(".tool-group"), "a lone tool after text stays ungrouped");
  assert.strictEqual(h.errors().length, 0, "grouping threw: " + JSON.stringify(h.errors()));
});

test("a subagent nests its prompt, tools, output and report on one timeline", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, subagentControl: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "delegate this" });
  h.post({ type: "assistantStart" });

  h.post({ type: "subagentStart", id: "sa1", profile: "Explore", background: true,
    title: "Map session persistence", task: "Work out how sessions persist.\n\nStart at sessionStore.ts." });
  h.post({ type: "subagentChunk", parentId: "sa1", stream: "thought", text: "Reading the store first." });
  h.post({ type: "subagentChunk", parentId: "sa1", stream: "message", text: "See [client.ts](src/client.ts)." });
  h.post({ type: "toolCall", id: "sa1-t1", parentId: "sa1", title: "Read src/session/sessionStore.ts", kind: "read", status: "pending" });
  h.post({ type: "toolCallUpdate", id: "sa1-t1", parentId: "sa1", status: "in_progress" });
  await h.settle(15);

  const sub = h.document.querySelector("#thread .subagent");
  assert.ok(sub, "the subagent block renders");
  assert.ok(sub.classList.contains("subagent-active"), "a running subagent is marked active");
  assert.ok(sub.classList.contains("dv-collapsed"), "it starts collapsed, like VS Code");
  assert.strictEqual(sub.querySelector(".subagent-title").textContent, "Explore: Map session persistence",
    "the header is the capitalised profile then the task");
  assert.ok(sub.querySelector(".dv-collapsible-header > .subagent-glyph.codicon-hubot"),
    "the row leads with the agent glyph");
  assert.strictEqual(sub.querySelector(".subagent-detail").textContent, " \u2014 Read src/session/sessionStore.ts",
    "the running tool is appended to the header");
  assert.ok(sub.querySelector(".subagent-item.subagent-prompt"), "the prompt opens the timeline");
  assert.ok(sub.querySelector(".subagent-item.subagent-thought"), "its reasoning is on the timeline");
  const subLink = sub.querySelector(".subagent-prose-content a");
  assert.ok(subLink && subLink.classList.contains("file-pill"), "subagent file references use the file pill");
  assert.ok(subLink.querySelector(".file-pill-icon"), "subagent file references use the file icon");
  subLink.click();
  subLink.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  subLink.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  assert.ok(h.posted.some((m) => m.type === "openFile" && m.path === "src/client.ts"),
    "subagent file references open from mouse and keyboard");
  h.post({ type: "capabilities", inlineReferencesStyle: "link" });
  await h.settle(5);
  assert.ok(!subLink.classList.contains("file-pill"), "link mode updates subagent references");
  h.post({ type: "capabilities", inlineReferencesStyle: "box" });
  await h.settle(5);
  assert.ok(subLink.classList.contains("file-pill"), "box mode restores subagent references");
  assert.ok(sub.querySelector(".subagent-item.subagent-tool > .tool"), "its tool call nests as a row");
  assert.ok(sub.querySelector(".subagent-item.subagent-spinner"), "a working row shows while it runs");
  assert.strictEqual(h.document.querySelectorAll("#thread > .turn .tool-group").length, 0,
    "a subagent's tools do not join the turn's tool run");

  // The tool it was naming finishes and it thinks again: the header has to move
  // on with it, or a working subagent reads as stuck on the last thing it ran.
  const working = /^ \u2014 (Processing|Preparing|Loading|Analyzing|Evaluating|Thinking|Reasoning|Considering|Working|Executing|Running)$/;
  h.post({ type: "toolCallUpdate", id: "sa1-t1", parentId: "sa1", status: "completed" });
  await h.settle(10);
  assert.match(sub.querySelector(".subagent-detail").textContent, working,
    "with no tool running it says it is working, not which tool it last ran");
  h.post({ type: "subagentChunk", parentId: "sa1", stream: "thought", text: "Now the write path." });
  await h.settle(10);
  assert.match(sub.querySelector(".subagent-detail").textContent, working);
  assert.strictEqual(
    sub.querySelector(".subagent-spinner .subagent-spinner-label").textContent,
    sub.querySelector(".subagent-detail").textContent.replace(" \u2014 ", ""),
    "and its own working row says the same thing"
  );

  // The control flips optimistically and tells the host.
  sub.querySelector(".subagent-action").dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "subagentMode" && m.id === "sa1" && m.background === false),
    "the action asks the host to bring it to the foreground");
  assert.ok(sub.classList.contains("dv-collapsed"), "using the control does not toggle the disclosure");

  h.post({ type: "subagentEnd", id: "sa1", success: true, summary: "Sessions live in workspace state.\n\nUnder a single key." });
  await h.settle(15);

  assert.ok(!sub.classList.contains("subagent-active"), "a finished subagent is no longer active");
  assert.strictEqual(sub.querySelector(".subagent-detail").textContent, "", "the tool suffix is dropped when done");
  assert.ok(!sub.querySelector(".subagent-spinner"), "the working row is removed");
  const result = sub.querySelector(".subagent-item.subagent-result");
  assert.ok(result, "the report closes the timeline");
  assert.strictEqual(result.querySelector(".subagent-section-label").textContent, "Sessions live in workspace state.",
    "the report is titled with its first line");
  assert.ok(!sub.querySelector(".subagent-action"), "the controls go once it is no longer running");
  assert.strictEqual(h.errors().length, 0, "subagent rendering threw: " + JSON.stringify(h.errors()));
});

test("a turn ending settles a foreground subagent but leaves a background one running", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "delegate" });
  h.post({ type: "busy", value: true });
  h.post({ type: "subagentStart", id: "fg", profile: "Explore", title: "Look around", background: false });
  h.post({ type: "subagentStart", id: "bg", profile: "Explore", title: "Keep digging", background: true });
  await h.settle(10);
  h.post({ type: "busy", value: false });
  await h.settle(10);

  const subs = [...h.document.querySelectorAll("#thread .subagent")];
  const fg = subs.find((s) => /Look around/.test(s.textContent));
  const bg = subs.find((s) => /Keep digging/.test(s.textContent));
  assert.ok(fg && !fg.classList.contains("subagent-active"), "an interrupted foreground subagent stops shimmering");
  assert.ok(!fg.querySelector(".subagent-spinner"), "and drops its working row");
  assert.ok(bg.classList.contains("subagent-active"), "a background subagent keeps working past the turn");

  // Its report can land long after the turn that spawned it ended.
  h.post({ type: "subagentEnd", id: "bg", success: true, summary: "Found it.\n\nIn the store." });
  await h.settle(10);
  assert.ok(!bg.classList.contains("subagent-active"), "the late report settles it");
  assert.ok(bg.querySelector(".subagent-result"), "and is still rendered");
  assert.strictEqual(h.errors().length, 0, "finalising threw: " + JSON.stringify(h.errors()));
});

test("a subagent tool with no known parent still renders in the thread", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "replay" });
  h.post({ type: "assistantStart" });
  // A history replay can carry the tagged tool without the lifecycle that made
  // it, so the tool must fall back to the top level rather than vanish.
  h.post({ type: "toolCall", id: "orphan", parentId: "gone", title: "Read src/a.ts", kind: "read", status: "completed" });
  await h.settle(10);

  const tool = h.document.querySelector("#thread .tool");
  assert.ok(tool && !tool.closest(".subagent"), "an orphaned subagent tool renders at the top level");
  assert.strictEqual(h.errors().length, 0, "orphan rendering threw: " + JSON.stringify(h.errors()));
});

test("terminating the open session uses the kill glyph and asks to return to the list", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionStatuses", statuses: { S1: "running" }, activeId: "S1" });
  h.post({ type: "sessionReady", sessionId: "S1" });
  h.post({ type: "userMessage", text: "hi" });
  await h.settle(10);

  const term = h.document.getElementById("terminate-btn");
  assert.ok(!term.classList.contains("hidden"), "header terminate shows for a live open session");
  assert.ok(term.querySelector(".kill-glyph"), "header terminate uses the power/kill glyph, not a codicon");
  term.click();
  await h.settle(5);
  assert.ok(
    h.posted.some((m) => m.type === "terminateSession" && m.id === "S1" && m.returnToList === true),
    "header terminate posts returnToList so the host returns to the sessions list"
  );
  assert.strictEqual(h.errors().length, 0, "header terminate threw: " + JSON.stringify(h.errors()));
});

test("mermaid fences render as a source block (upgraded lazily)", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "draw" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "A diagram:\n\n```mermaid\ngraph TD; A-->B;\n```\n" });
  h.post({ type: "assistantEnd" });
  await h.settle(20);

  const pre = h.document.querySelector("#thread .resp-text pre.mermaid-src");
  assert.ok(pre, "mermaid fence renders as a mermaid-src block");
  assert.ok(/graph TD/.test(pre.textContent), "the mermaid source is preserved");
  assert.ok(!pre.querySelector(".code-toolbar"), "mermaid source is not given a code toolbar");
  // No data-mermaid-src is set in the harness, so the lazy load no-ops; the
  // source block must simply survive without throwing.
  assert.strictEqual(h.errors().length, 0, "mermaid rendering threw: " + JSON.stringify(h.errors()));
});

test("mermaid is told to keep its errors to itself", async () => {
  // A diagram it cannot parse draws a bomb and "Syntax error in text" into a
  // node it hangs off document.body, and leaves it there: outside the
  // transcript, under the whole panel. Suppressing that is what makes it throw
  // instead, which is how the source block survives in its place.
  const bundle = fs.readFileSync(path.join(ROOT, "dist", "webview.js"), "utf8");
  assert.ok(
    /suppressErrorRendering\s*:\s*!0|suppressErrorRendering\s*:\s*true/.test(bundle),
    "mermaid must be initialised with suppressErrorRendering"
  );
});

// Publish the authoritative checkpoint bindings the host sends after the agent's
// step list: one entry per prompt id, in order, with canFork on every prompt but
// the first. Tests name their prompt ids so turns and bindings line up.
function bindCheckpoints(h, sessionId, ids, busy = false) {
  h.post({
    type: "checkpoints",
    sessionId,
    checkpoints: ids.map((userMessageId, i) => ({ userMessageId, canFork: i > 0 })),
    busy
  });
}

// Helper: two completed live turns with stable prompt ids and bindings.
function twoLiveTurns(h) {
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  h.post({ type: "userMessage", text: "second", clientMessageId: "m2" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a2" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1", "m2"]);
}

test("a second Enter while an edit is being checked does not send it twice", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  h.post({ type: "userMessage", text: "second", clientMessageId: "m2" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a2" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1", "m2"]);
  await h.settle(20);

  const reqBodies = [...h.document.querySelectorAll("#thread .turn-request .req-body")];
  reqBodies[1].click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  assert.ok(ta, "the editor is open");
  ta.value = "second, but better";

  // Submitting asks the host what the rewind would discard first, and nothing about
  // the editor changes while that answer is on its way: the text is still there and
  // the editor is still open, so a user who saw nothing happen presses Enter again.
  const enter = () => ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  enter();
  enter();
  await h.settle(10);

  for (const asked of h.posted.filter((m) => m.type === "revertPreview")) {
    h.post({
      type: "revertPreview",
      token: asked.token,
      sessionId: asked.sessionId,
      userMessageId: asked.userMessageId,
      result: { fileActions: [], irreversibleWarnings: [], conflicts: [] },
      pendingFiles: 0
    });
  }
  await h.settle(20);

  // Two rewinds on one channel is the edited prompt sent twice, and the second
  // landing under the resend of the first.
  assert.strictEqual(
    h.posted.filter((m) => m.type === "revertExecute").length,
    1,
    "the edit is sent once"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("clearing a transcript cancels its pending revert preview timer", async () => {
  const h = createHarness();
  const setTimeout = h.window.setTimeout.bind(h.window);
  const clearTimeout = h.window.clearTimeout.bind(h.window);
  const timer = {};
  let cleared = false;
  h.window.setTimeout = (fn, delay, ...args) => delay === 4000 ? timer : setTimeout(fn, delay, ...args);
  h.window.clearTimeout = (value) => {
    if (value === timer) cleared = true;
    else clearTimeout(value);
  };
  try {
    h.post({ type: "ready" });
    h.post({ type: "body", body: "thread" });
    h.post({ type: "clear" });
    h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: true });
    h.post({ type: "sessionReady", sessionId: "S" });
    h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
    h.post({ type: "assistantStart" }); h.post({ type: "assistantEnd" });
    h.post({ type: "busy", value: false });
    h.post({ type: "userMessage", text: "second", clientMessageId: "m2" });
    h.post({ type: "assistantStart" }); h.post({ type: "assistantEnd" });
    h.post({ type: "busy", value: false });
    bindCheckpoints(h, "S", ["m1", "m2"]);
    await h.settle(10);
    h.document.querySelectorAll("#thread .turn-request .req-body")[1].click();
    await h.settle(5);
    const input = h.document.querySelector(".req-editor-input");
    input.value = "revised";
    input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await h.settle(5);
    assert.strictEqual(h.posted.filter((message) => message.type === "revertPreview").length, 1);

    h.post({ type: "clear" });

    assert.strictEqual(cleared, true);
  } finally {
    h.window.setTimeout = setTimeout;
    h.window.clearTimeout = clearTimeout;
  }
});

test("a delayed revert preview cannot execute against a newly selected session", async () => {
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(10);
  h.document.querySelectorAll("#thread .turn-request .req-body")[1].click();
  await h.settle(5);
  const input = h.document.querySelector(".req-editor-input");
  input.value = "revised";
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(5);
  const preview = h.posted.find((message) => message.type === "revertPreview");
  assert.ok(preview);

  h.post({ type: "sessionReady", sessionId: "other" });
  h.post({ type: "revertPreview", token: preview.token, sessionId: preview.sessionId, userMessageId: preview.userMessageId, result: { fileActions: [], irreversibleWarnings: [] }, pendingFiles: 0 });
  await h.settle(20);

  assert.strictEqual(h.posted.filter((message) => message.type === "revertExecute").length, 0);
});

test("only one inline request edits at a time and Cancel closes it", async () => {
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(20);

  const reqBodies = [...h.document.querySelectorAll("#thread .turn-request .req-body")];
  assert.strictEqual(reqBodies.length, 2, "two request rows");

  reqBodies[0].click();
  await h.settle(5);
  assert.strictEqual(h.document.querySelectorAll(".req-editor").length, 1, "one editor opens");

  // Opening a second edit closes the first (single editable request).
  reqBodies[1].click();
  await h.settle(5);
  assert.strictEqual(h.document.querySelectorAll(".req-editor").length, 1, "still exactly one editor open");

  const cancel = [...h.document.querySelectorAll(".req-editor button")].find((b) => b.textContent === "Cancel");
  assert.ok(cancel, "Cancel button present");
  cancel.click();
  await h.settle(5);
  assert.strictEqual(h.document.querySelectorAll(".req-editor").length, 0, "Cancel closes the editor and it does not reopen");
  assert.strictEqual(h.errors().length, 0, "edit flow threw: " + JSON.stringify(h.errors()));
});

test("Retry shows only on the last response", async () => {
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(20);

  const footers = [...h.document.querySelectorAll("#thread .chat-footer")];
  assert.strictEqual(footers.length, 2, "two response footers");
  const lastFooters = footers.filter((f) => f.classList.contains("is-last"));
  assert.strictEqual(lastFooters.length, 1, "exactly one footer is marked last");
  assert.ok(footers[footers.length - 1].classList.contains("is-last"), "the last turn's footer carries Retry");
  assert.ok(!footers[0].classList.contains("is-last"), "the earlier turn's footer does not");
  assert.strictEqual(h.errors().length, 0);
});

test("checkpoint identity: replayed turns bind only when the step list names them", async () => {
  // Checkpoint controls come from the agent's step list, not from anything the
  // page captured: a replayed turn whose prompt id the list does not name has
  // no safe target, and one it does name is revertable like a live send.
  const editableTexts = () =>
    [...h.document.querySelectorAll("#thread .turn-request.editable-inline .req-text")].map((e) => e.textContent.trim());
  const restoreRows = () =>
    [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")].length;

  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  // Replay history carrying the stable prompt ids, then loaded with no bindings
  // yet: nothing is revertable.
  h.post({ type: "userChunk", text: "old q", messageId: "old1" });
  h.post({ type: "assistantChunk", text: "old a" });
  h.post({ type: "loaded" });
  h.post({ type: "sessionReady", sessionId: "S" });
  await h.settle(20);
  assert.deepStrictEqual(editableTexts(), [], "unbound replayed turn is not editable");
  assert.strictEqual(restoreRows(), 0, "no restore rows without bindings");

  // The step list names only the first replayed prompt: it alone binds.
  bindCheckpoints(h, "S", ["old1"]);
  await h.settle(20);
  assert.deepStrictEqual(editableTexts(), ["old q"], "the bound replayed turn is editable");
  assert.strictEqual(restoreRows(), 1, "one restore row for the bound prompt");

  // A live send and a second replayed prompt join the list: every named prompt
  // binds, the unnamed one still does not.
  h.post({ type: "userMessage", text: "new q", clientMessageId: "new1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  h.post({ type: "userChunk", text: "older q", messageId: "old2" });
  h.post({ type: "assistantChunk", text: "older a" });
  bindCheckpoints(h, "S", ["old1", "old2", "new1"]);
  await h.settle(20);
  assert.deepStrictEqual(
    editableTexts().sort(),
    ["new q", "old q", "older q"].sort(),
    "every prompt the step list names is editable"
  );
  assert.strictEqual(restoreRows(), 3, "one restore row per bound prompt");
  assert.strictEqual(h.errors().length, 0, "binding handling threw: " + JSON.stringify(h.errors()));
});

test("starting a new chat from the list does not flash the welcome screen", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "capabilities", revert: true });

  // The host clears with pendingSend and then renders the message: no welcome
  // should appear in the gap while the ACP session spins up.
  h.post({ type: "clear", pendingSend: true });
  await h.settle(10);
  assert.strictEqual(
    h.document.querySelectorAll("#thread .welcome").length,
    0,
    "no welcome during a pending new-chat send"
  );
  h.post({ type: "userMessage", text: "hello new chat" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "still no welcome after the message renders");
  assert.deepStrictEqual(h.reqTexts(), ["hello new chat"]);

  // A normal clear (no pending send) still shows the welcome.
  h.post({ type: "clear" });
  await h.settle(10);
  assert.ok(h.document.querySelector("#thread .welcome"), "a plain clear still shows the welcome");
  assert.strictEqual(h.errors().length, 0);
});

test("a freshly sent message does not flash the Copy/Retry footer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "hello" });
  await h.settle(10);

  // Before the response completes the turn must not be "complete" (its footer
  // is hidden by CSS while not complete), so no Copy/Retry flashes.
  const turn = h.document.querySelector("#thread .turn");
  assert.ok(turn, "turn exists");
  assert.ok(!turn.classList.contains("complete"), "the in-flight turn is not marked complete");

  // After the response finishes it becomes complete and the footer appears.
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "hi" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  assert.ok(turn.classList.contains("complete"), "the turn is complete after the response");
  assert.strictEqual(h.errors().length, 0, "send flow threw: " + JSON.stringify(h.errors()));
});

test("Copy is hidden when the response is empty", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "S" });

  // A turn that produced no assistant output.
  h.post({ type: "userMessage", text: "hi" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  const emptyFooter = h.document.querySelector("#thread .chat-footer");
  assert.ok(emptyFooter, "footer exists");
  assert.strictEqual(emptyFooter.querySelectorAll(".dv-copy").length, 0, "no Copy button on an empty response");

  // A turn with output shows Copy.
  h.post({ type: "userMessage", text: "again" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "here is an answer" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  const footers = [...h.document.querySelectorAll("#thread .chat-footer")];
  assert.strictEqual(footers[footers.length - 1].querySelectorAll(".dv-copy").length, 1, "Copy shows when there is a response");
  assert.strictEqual(h.errors().length, 0);
});

test("stopping the turn closes an open question widget", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({
    type: "elicitation", requestId: "e1", mode: "form", message: "Pick",
    schema: { type: "object", required: ["q0"], properties: { q0: { type: "string", title: "Q0", oneOf: [{ const: "A", title: "A" }, { const: "B", title: "B" }] } } }
  });
  await h.settle(10);
  assert.ok(h.document.querySelector("#elicitation-tray .qc"), "the question widget is shown");

  // The host reports the request was cancelled (Stop, or leaving the turn).
  h.post({ type: "cancelPrompts" });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#elicitation-tray .qc").length, 0, "the question widget is closed on cancel");
  assert.strictEqual(h.errors().length, 0);
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

test("queued messages render as bubbles, edit in place keeps position, remove drops them", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "queued", items: [{ id: "q1", text: "first queued" }, { id: "q2", text: "second queued" }] });
  await h.settle(20);

  const box = h.document.querySelector("#thread .queued-inline");
  assert.ok(box, "the queued block renders at the bottom of the transcript");
  assert.ok(box.querySelector(".queued-divider"), "it has a Queued divider");
  const rows = box.querySelectorAll(".queued-item");
  assert.strictEqual(rows.length, 2, "one bubble per queued message");
  assert.strictEqual(box.querySelectorAll(".queued-bubble")[0].textContent, "first queued");

  // Edit the first: it loads into the composer for an in-place edit and is NOT
  // dropped from the queue (its slot is kept), so it cannot jump to the end.
  rows[0].querySelector(".queued-actions").querySelectorAll("button")[0].click();
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("input").value, "first queued", "edit loads text into the composer");
  assert.ok(!h.posted.some((m) => m.type === "removeQueued" && m.id === "q1"), "editing does not drop it from the queue");
  assert.ok(h.document.getElementById("input-editing-banner"), "an editing banner is shown");
  assert.ok(rows[0].classList.contains("editing"), "the edited bubble is marked");
  // The host is told which message is being edited, so only that one is held
  // back when it reaches the head (earlier ones keep sending).
  assert.ok(h.posted.some((m) => m.type === "queueEditing" && m.id === "q1"), "editing holds just that message");

  // Submitting the edit updates it in place (same position), not a fresh send.
  h.document.getElementById("input").value = "first edited";
  h.document.getElementById("input").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(10);
  const edit = h.posted.find((m) => m.type === "editQueued");
  assert.ok(edit && edit.id === "q1" && edit.text === "first edited", "submit updates the queued item in place");
  assert.ok(!h.posted.some((m) => m.type === "send"), "editing a queued item is not a fresh send");
  assert.ok(!h.document.getElementById("input-editing-banner"), "the editing banner clears after submit");
  // Committing the edit releases the hold so that message can be sent.
  assert.ok(h.posted.some((m) => m.type === "queueEditing" && m.id === null), "committing releases the hold");

  // Each bubble carries edit / send-immediately / remove, like VS Code's pending row.
  const actionBtns = rows[1].querySelector(".queued-actions").querySelectorAll("button");
  assert.strictEqual(actionBtns.length, 3, "edit, send immediately, and remove");

  // Send the second immediately: the host ends the turn in flight and drains
  // this one into the gap, which its hover says in VS Code's own words.
  assert.match(actionBtns[1].title, /^Cancel the current request and send this message immediately$/);
  actionBtns[1].click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "sendQueuedNow" && m.id === "q2"), "send immediately promotes it");

  // Remove the second: drops it.
  actionBtns[2].click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "removeQueued" && m.id === "q2"), "remove asks the host to drop it");

  // An empty update removes the block.
  h.post({ type: "queued", items: [] });
  await h.settle(10);
  assert.ok(!h.document.querySelector("#thread .queued-inline"), "an empty queue removes the block");
  assert.strictEqual(h.errors().length, 0);
});

test("session load hides the replay behind the spinner until it settles", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  await h.settle(10);

  const thread = h.thread();
  assert.ok(thread.classList.contains("loading-replay"), "the transcript is hidden while replaying");
  assert.ok(thread.querySelector(".thread-loading"), "the loading spinner is shown");

  h.post({ type: "userChunk", text: "old question" });
  h.post({ type: "assistantChunk", text: "old answer" });
  await h.settle(10);
  // The replay is what the spinner is covering, so the first chunk of it must not
  // take the spinner away: every renderer clears the welcome screen, and the
  // spinner used to go with it, leaving a blank panel for the rest of the load.
  assert.ok(thread.querySelector(".thread-loading"), "the spinner stays for the whole replay");

  h.post({ type: "loaded" });
  await h.settle(10);

  assert.ok(!thread.classList.contains("loading-replay"), "the transcript is revealed once loaded");
  assert.ok(!thread.querySelector(".thread-loading"), "the spinner is gone once loaded");
  assert.deepStrictEqual(h.reqTexts(), ["old question"]);
  assert.strictEqual(h.errors().length, 0);
});

test("a backgrounded session waiting on input shows the attention dot", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [{ id: "aaa", short_id: "aaa", title: "Waiting one", working_directory: "/w" }],
    activeId: null,
    statuses: { aaa: "attention" }
  });
  await h.settle(20);

  const dot = h.document.querySelector("#sessions-list .session-dot");
  assert.ok(dot.className.includes("dot-attention"), "the attention dot is rendered");
  assert.strictEqual(dot.title, "Needs your input");
  // The row is still treated as live, so it keeps its terminate action.
  assert.ok(h.document.querySelector("#sessions-list .session-item .kill-glyph"), "an attention session is live");
  assert.strictEqual(h.errors().length, 0);
});

test("the nine most recent chats wear the number that opens them", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [
      { id: "aaa", short_id: "aaa", title: "Oldest", working_directory: "/w", last_activity_at: 100 },
      { id: "bbb", short_id: "bbb", title: "Newest", working_directory: "/w", last_activity_at: 300 },
      { id: "ccc", short_id: "ccc", title: "Middle", working_directory: "/w", last_activity_at: 200 }
    ],
    activeId: null,
    statuses: { aaa: "idle", bbb: "idle", ccc: "idle" },
    folders: [{ path: "/w", name: "w" }]
  });
  await h.settle(20);

  const keyOf = (code) => [...h.document.querySelectorAll("#sessions-list .session-item")]
    .find((r) => r.querySelector(".session-code").textContent === code)
    .querySelector(".session-key").textContent;
  // Numbered by recency, whatever order the rows come out in.
  assert.ok(/1$/.test(keyOf("bbb")), "the most recent chat is number 1");
  assert.ok(/2$/.test(keyOf("ccc")), "the next most recent is number 2");
  assert.ok(/3$/.test(keyOf("aaa")), "the oldest of the three is number 3");

  // The host's Ctrl/Cmd+2 opens the chat wearing 2.
  h.post({ type: "pickSession", index: 2 });
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "loadSession" && m.id === "ccc"), "Ctrl/Cmd+2 opens that chat");
  assert.strictEqual(h.errors().length, 0);
});

test("keyboard shortcuts: Ctrl/Cmd+Esc stops, ArrowUp recalls, Ctrl/Cmd+. opens pickers", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "userMessage", text: "recall me" });
  h.post({ type: "assistantStart" });
  h.post({ type: "assistantChunk", text: "working" });
  await h.settle(20);

  // Ctrl/Cmd+Esc while busy stops the turn.
  h.post({ type: "busy", value: true });
  await h.settle(5);
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", metaKey: true, bubbles: true }));
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "cancel"), "Ctrl/Cmd+Esc asks the host to cancel");

  // A bare Escape from the composer stops it too, with nothing else open to close.
  h.posted.length = 0;
  h.document.getElementById("input").dispatchEvent(
    new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "cancel"), "Escape in the composer asks the host to cancel");
  h.post({ type: "busy", value: false });
  await h.settle(5);

  // Idle, Escape is not a stop: it must not fire a stray cancel.
  h.posted.length = 0;
  h.document.getElementById("input").dispatchEvent(
    new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  await h.settle(5);
  assert.deepStrictEqual(h.posted.filter((m) => m.type === "cancel"), [], "Escape while idle cancels nothing");

  // ArrowUp on an empty composer recalls the last message.
  const input = h.document.getElementById("input");
  input.value = "";
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await h.settle(5);
  assert.strictEqual(input.value, "recall me", "ArrowUp recalls the last message into the composer");

  assert.strictEqual(h.errors().length, 0);
});

test("leaving a working session and returning never shows two Working lines", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [
      { id: "aaa", short_id: "aaa", title: "A", working_directory: "/w" },
      { id: "bbb", short_id: "bbb", title: "B", working_directory: "/w" }
    ],
    activeId: null,
    statuses: { aaa: "idle", bbb: "idle" }
  });
  await h.settle(20);
  const openRow = (code) => [...h.document.querySelectorAll("#sessions-list .session-item")]
    .find((r) => r.querySelector(".session-code").textContent === code)
    .querySelector(".session-main").click();

  // Open A and leave it mid turn, with the "Working…" line on screen. The row
  // click asks the host to load the session, so `loaded` is what ends the
  // loader a real load would have sent.
  openRow("aaa");
  h.post({ type: "sessionReady", sessionId: "aaa" });
  h.post({ type: "loaded" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "assistantStart" });
  h.post({ type: "busy", value: true });
  // The list learns the session is working, which is what lets the retained
  // transcript re-attach on return rather than take the reload path.
  h.post({ type: "sessionStatuses", statuses: { aaa: "running", bbb: "idle" }, activeId: "aaa" });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelectorAll(".working").length, 1, "one Working line while it runs");

  // Switch away and back (the transcript is retained), then send again.
  openRow("bbb");
  h.post({ type: "sessionReady", sessionId: "bbb" });
  h.post({ type: "loaded" });
  await h.settle(10);
  openRow("aaa");
  await h.settle(10);
  h.post({ type: "userMessage", text: "second" });
  h.post({ type: "assistantStart" });
  await h.settle(20);

  assert.strictEqual(
    h.thread().querySelectorAll(".working").length,
    1,
    "the retained one is not left behind next to a new one"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("an unsent draft stays with its own session when switching", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [
      { id: "aaa", short_id: "aaa", title: "A", working_directory: "/w" },
      { id: "bbb", short_id: "bbb", title: "B", working_directory: "/w" }
    ],
    activeId: null,
    statuses: { aaa: "idle", bbb: "idle" }
  });
  await h.settle(20);
  const input = h.document.getElementById("input");
  const openRow = (code) => [...h.document.querySelectorAll("#sessions-list .session-item")]
    .find((r) => r.querySelector(".session-code").textContent === code)
    .querySelector(".session-main").click();

  // Open A, leave a draft, then switch to B: B must start clean.
  openRow("aaa");
  h.post({ type: "sessionReady", sessionId: "aaa" });
  h.post({ type: "loaded" });
  await h.settle(10);
  input.value = "draft for A";
  openRow("bbb");
  h.post({ type: "sessionReady", sessionId: "bbb" });
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.strictEqual(input.value, "", "the draft does not follow into the other session");

  // Back to A: its own draft comes back.
  openRow("aaa");
  await h.settle(10);
  assert.strictEqual(input.value, "draft for A", "the session's own draft is restored");
  assert.strictEqual(h.errors().length, 0);
});

test("the status filter is multi select, offers Terminated, and can sort by state", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [
      { id: "run", short_id: "run", title: "Running one", working_directory: "/w", last_activity_at: 10 },
      { id: "idle", short_id: "idle", title: "Idle one", working_directory: "/w", last_activity_at: 30 },
      { id: "dead", short_id: "dead", title: "Dead one", working_directory: "/w", last_activity_at: 20 }
    ],
    activeId: null,
    statuses: { run: "running", idle: "idle" }
  });
  await h.settle(20);

  h.document.getElementById("list-filter-btn").click();
  await h.settle(10);
  const labels = [...h.document.querySelectorAll(".session-filter-menu .dv-menu-item span")].map((s) => s.textContent);
  assert.ok(labels.includes("Terminated"), "the dead state is called Terminated");
  assert.ok(!labels.includes("Ended"), "the old Ended label is gone");
  assert.ok(labels.includes("Last activity") && labels.includes("State"), "a Sort by group is offered");

  // Tick Running, then also Terminated: both are kept (multi select).
  const click = (text) => [...h.document.querySelectorAll(".session-filter-menu .dv-menu-item")]
    .find((r) => r.textContent.trim() === text).click();
  click("Running");
  await h.settle(10);
  let ids = [...h.document.querySelectorAll("#sessions-list .session-item .session-code")].map((e) => e.textContent);
  assert.deepStrictEqual(ids, ["run"], "only running shows");

  click("Terminated");
  await h.settle(10);
  ids = [...h.document.querySelectorAll("#sessions-list .session-item .session-code")].map((e) => e.textContent).sort();
  assert.deepStrictEqual(ids, ["dead", "run"], "both selected states show together");
  assert.strictEqual(h.errors().length, 0);
});

test("New Session is a split button: the label starts one, the chevron picks where", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "sessions", sessions: [], activeId: null, statuses: {} });
  await h.settle(20);

  const split = h.document.querySelector("#new-session-dd .new-session-split");
  assert.ok(split, "the control is a split button");
  const main = split.querySelector(".new-session-btn");
  const more = split.querySelector(".new-session-more");
  assert.strictEqual(main.textContent.trim(), "New Session");

  // The labelled half starts a session here, with no menu in the way.
  main.click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "newSessionAt" && m.target === "view"),
    "clicking the label starts a session in the panel"
  );
  assert.ok(!h.document.querySelector(".dv-menu"), "no menu is opened by the label");

  // The chevron opens the menu with the other places to open one, and only those:
  // the labelled half is already "here".
  more.click();
  await h.settle(10);
  const labels = [...h.document.querySelectorAll(".dv-menu .dv-menu-item span")].map((s) => s.textContent);
  assert.deepStrictEqual(labels, [
    "New Session (Editor)",
    "New Session (Window)",
    "New Devin CLI Session (Terminal)"
  ]);
  assert.strictEqual(h.errors().length, 0);
});

test("the session list keeps itself live, with nothing to refresh by hand", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [{ id: "aaa", short_id: "aaa", title: "One", working_directory: "/w" }],
    activeId: null,
    statuses: {}
  });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("list-refresh-btn"), null, "no refresh button in the header");
  assert.ok(h.posted.some((m) => m.type === "listVisible" && m.value === true), "it says the list is on screen");

  // The switcher's own toolbar has no refresh either.
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "aaa" });
  await h.settle(10);
  const left = h.posted.filter((m) => m.type === "listVisible").pop();
  assert.strictEqual(left.value, false, "and says when it is not, so nothing is listed for no one");
  h.document.getElementById("panel-toggle").click();
  await h.settle(10);
  const tools = [...h.document.querySelectorAll("#title-menu .session-toolbar button")].map((b) => b.title);
  assert.deepStrictEqual(tools, ["New session", "New session in\u2026", "Search sessions", "Filter sessions"]);
  assert.strictEqual(h.posted.filter((m) => m.type === "listVisible").pop().value, true, "the switcher counts too");
  assert.strictEqual(h.errors().length, 0);
});

test("returning to the list keeps the cached rows and shows the top loading bar", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [{ id: "aaa", short_id: "aaa", title: "One", working_directory: "/w" }],
    activeId: null,
    statuses: {}
  });
  await h.settle(20);
  assert.strictEqual(h.document.querySelectorAll("#sessions-list .session-item").length, 1);

  const bar = h.document.querySelector("#body .dv-top-loading");
  assert.ok(bar, "the loading bar exists");
  assert.ok(bar.classList.contains("hidden"), "it is hidden when idle");

  // A revalidate must not blank the list: the cached rows stay, the bar runs.
  h.post({ type: "sessionsLoading" });
  await h.settle(10);
  assert.ok(!bar.classList.contains("hidden"), "the bar runs while revalidating");
  assert.strictEqual(
    h.document.querySelectorAll("#sessions-list .session-item").length,
    1,
    "the cached rows stay on screen instead of being replaced by a spinner"
  );

  h.post({ type: "sessions", sessions: [{ id: "aaa", short_id: "aaa", title: "One", working_directory: "/w" }], activeId: null, statuses: {} });
  await h.settle(10);
  assert.ok(bar.classList.contains("hidden"), "the bar stops once the listing arrives");
  assert.strictEqual(h.errors().length, 0);
});

test("a session load runs the top loading bar instead of a spinner", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  await h.settle(10);

  const bar = h.document.querySelector("#body .dv-top-loading");
  assert.ok(!bar.classList.contains("hidden"), "the bar runs while the session loads");
  const label = h.thread().querySelector(".thread-loading");
  assert.ok(label, "a load label is shown");
  assert.strictEqual(label.querySelectorAll(".codicon-modifier-spin").length, 0, "no spinner icon");

  h.post({ type: "loaded" });
  await h.settle(10);
  assert.ok(bar.classList.contains("hidden"), "the bar stops once loaded");
  assert.strictEqual(h.errors().length, 0);
});

test("dragging shows the attach overlay and dropping a file URI attaches it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  const chatMain = h.document.getElementById("chat-main");
  const overlay = h.document.getElementById("chat").querySelector(".chat-dnd-overlay");
  assert.ok(overlay, "the drop overlay exists");

  // VS Code's own host script listens on the webview window and takes the drag
  // away the moment it sees one, so nothing may reach the window listeners.
  const host = [];
  for (const type of ["dragenter", "dragover", "drop"]) {
    h.window.addEventListener(type, (e) => host.push(e.type));
  }

  // Dragging a file over the chat reveals the overlay.
  const enter = new h.window.Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(enter, "dataTransfer", { value: { types: ["Files"] } });
  chatMain.dispatchEvent(enter);
  assert.ok(overlay.classList.contains("visible"), "the overlay shows while dragging a file");

  // Dropping an internal file URI (Explorer / editor tab) attaches it by path.
  const drop = new h.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: {
      types: ["text/uri-list"],
      files: [],
      getData: (t) => (t === "text/uri-list" ? "file:///Users/me/src/app%20one.ts" : "")
    }
  });
  chatMain.dispatchEvent(drop);
  await h.settle(10);
  assert.ok(!overlay.classList.contains("visible"), "the overlay hides after the drop");
  assert.ok(
    h.posted.some((m) => m.type === "addMention" && m.path === "file:///Users/me/src/app%20one.ts"),
    "the dropped file is attached by its URI, which only the host can decode"
  );
  assert.deepStrictEqual(host, [], "no drag event escapes to VS Code's host listeners");
  assert.strictEqual(h.errors().length, 0);
});

test("a folder dropped from outside VS Code attaches as a listing, not silently nothing", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  // An OS drag gives no path for a folder, only an entry, so the top level is read
  // through the entries API. readEntries hands back one batch, then an empty one.
  let batches = [[{ name: "api.ts", isDirectory: false }, { name: "models", isDirectory: true }, { name: ".env", isDirectory: false }], []];
  const dir = {
    name: "orders",
    isDirectory: true,
    createReader: () => ({ readEntries: (cb) => cb(batches.shift() || []) })
  };
  const drop = new h.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: {
      types: ["Files"],
      files: [{ name: "orders" }],
      items: [{ kind: "file", webkitGetAsEntry: () => dir, getAsFile: () => ({ name: "orders" }) }],
      getData: () => ""
    }
  });
  h.document.getElementById("chat-main").dispatchEvent(drop);
  await h.settle(10);

  const folder = h.posted.find((m) => m.type === "attachDroppedFolder");
  assert.ok(folder, "the folder is attached rather than read as a file");
  assert.strictEqual(folder.name, "orders");
  assert.deepStrictEqual(folder.entries, ["api.ts", "models/"], "the listing marks folders and skips dotfiles");
  assert.ok(!h.posted.some((m) => m.type === "attachDroppedText"), "the folder is not also attached as text");
  assert.strictEqual(h.errors().length, 0);
});

test("an image the agent cannot decode is attached as a file, never as an image", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  // An svg sent as an image block has the whole request rejected, and the block
  // stays in the session, so every later message in that chat is rejected too.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
  const files = [
    new h.window.File([svg], "icon.svg", { type: "image/svg+xml" }),
    new h.window.File(["\u0089PNG"], "shot.png", { type: "image/png" })
  ];
  const drop = new h.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: {
      types: ["Files"],
      files,
      items: files.map((f) => ({ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => f })),
      getData: () => ""
    }
  });
  h.document.getElementById("chat-main").dispatchEvent(drop);
  await h.until(() => h.posted.filter((m) => m.type === "attachImage" || m.type === "attachDroppedText").length === 2);

  const images = h.posted.filter((m) => m.type === "attachImage");
  assert.deepStrictEqual(images.map((m) => m.name), ["shot.png"], "only the png goes inline as an image");
  const text = h.posted.find((m) => m.type === "attachDroppedText");
  assert.ok(text, "the svg is attached as a file instead of being dropped");
  assert.strictEqual(text.name, "icon.svg");
  assert.ok(text.text.includes("<svg"), "its source is what gets attached");
  assert.strictEqual(h.errors().length, 0);
});

test("a pasted image the agent cannot decode is attached as a file too", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  const file = new h.window.File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", { type: "image/svg+xml" });
  const paste = new h.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/svg+xml", getAsFile: () => file }] }
  });
  h.document.getElementById("input").dispatchEvent(paste);
  await h.until(() => h.posted.some((m) => m.type === "attachDroppedText"));

  assert.ok(!h.posted.some((m) => m.type === "attachImage"), "it does not go inline as an image");
  const text = h.posted.find((m) => m.type === "attachDroppedText");
  assert.ok(text, "the pasted svg is attached as a file");
  assert.strictEqual(text.name, "logo.svg");
  assert.strictEqual(h.errors().length, 0);
});

test("a drag anywhere in the panel, not just the chat column, is a drop target", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  const overlay = h.document.getElementById("chat").querySelector(".chat-dnd-overlay");
  const enter = new h.window.Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(enter, "dataTransfer", { value: { types: ["Files"] } });
  h.document.getElementById("sessions-panel").dispatchEvent(enter);
  assert.ok(overlay.classList.contains("visible"), "dragging over the sessions panel still offers the drop");

  const leave = new h.window.Event("dragleave", { bubbles: true, cancelable: true });
  Object.defineProperty(leave, "dataTransfer", { value: { types: ["Files"] } });
  h.document.getElementById("sessions-panel").dispatchEvent(leave);
  assert.ok(!overlay.classList.contains("visible"), "leaving hides the overlay again");
  assert.strictEqual(h.errors().length, 0);
});

test("an internal multi file drag attaches every file, not just the first", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  // VS Code truncates the standard text/uri-list to the FIRST resource and puts
  // them all in application/vnd.code.uri-list, so we must read the internal one.
  const chatMain = h.document.getElementById("chat-main");
  const drop = new h.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: {
      types: ["application/vnd.code.uri-list", "text/uri-list"],
      files: [],
      getData: (t) =>
        t === "application/vnd.code.uri-list"
          ? "file:///w/a.ts\nfile:///w/b.ts\nfile:///w/c.ts"
          : t === "text/uri-list" ? "file:///w/a.ts" : ""
    }
  });
  chatMain.dispatchEvent(drop);
  await h.settle(10);

  const added = h.posted.filter((m) => m.type === "addMention").map((m) => m.path);
  assert.deepStrictEqual(
    added,
    ["file:///w/a.ts", "file:///w/b.ts", "file:///w/c.ts"],
    "all three dragged files are attached"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("while busy, Send becomes a split button: steer it, queue it, or stop and send", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "assistantStart" });
  h.post({ type: "busy", value: true });
  await h.settle(10);

  const send = h.document.getElementById("send");
  const more = h.document.getElementById("send-more");
  const stop = h.document.getElementById("stop");
  assert.ok(!stop.classList.contains("hidden"), "Stop is shown while busy");
  assert.ok(send.classList.contains("hidden"), "Send is hidden while busy with an empty composer");
  assert.ok(more.classList.contains("hidden"), "and so is the chevron, with nothing to send");

  const input = h.document.getElementById("input");
  input.value = "a follow up";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);
  assert.ok(!send.classList.contains("hidden"), "Send appears once there is something to send");
  assert.ok(!more.classList.contains("hidden"), "with the chevron beside it");
  assert.ok(h.document.getElementById("send-group").classList.contains("split"), "joined as one control");
  // Stop is the filled action while a turn runs, and the send control stays at the
  // far end after it, which is the order VS Code's chat uses.
  const order = [...h.document.querySelector(".toolbar-right").children].map((c) => c.id);
  assert.ok(order.indexOf("stop") < order.indexOf("send-group"), "Stop comes first, Send last");
  // The default is steering: Enter sends a second prompt into the running turn.
  assert.match(send.querySelector("i").className, /codicon-newline/, "the default half steers it");
  assert.strictEqual(send.title, "Steer with Message (Enter)");
  assert.ok(!stop.classList.contains("hidden"), "Stop stays available alongside it");

  // The chevron offers all three in Copilot's order, each with its keys.
  more.click();
  await h.settle(10);
  const rows = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")];
  assert.deepStrictEqual(rows.map((r) => r.querySelector(".dv-menu-text span").textContent),
    ["Stop and Send", "Add to Queue", "Steer with Message"]);
  assert.deepStrictEqual(rows.map((r) => r.querySelector(".dv-menu-keys").textContent), ["", "Alt+Enter", "Enter"]);
  // The description is the hover title, not an inline paragraph: three of them
  // do not fit the panel.
  assert.match(rows[0].title, /Cancel the current request/);
  assert.ok(!rows[0].querySelector(".dv-menu-detail"), "no inline detail in the compact menu");
  assert.strictEqual(more.getAttribute("aria-expanded"), "true", "the chevron says its menu is open");
  // The rows are radios, and the effective default carries the check.
  assert.deepStrictEqual(rows.map((r) => r.getAttribute("role")), ["menuitemradio", "menuitemradio", "menuitemradio"]);
  assert.deepStrictEqual(rows.map((r) => r.getAttribute("aria-checked")), ["false", "false", "true"],
    "steer is the default here, so it is the checked radio");

  rows[0].click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "stopAndSend" && m.text === "a follow up"),
    "the first one ends the turn and sends"
  );
  assert.strictEqual(input.value, "", "and the composer is cleared either way");

  // Enter steers, Alt+Enter queues.
  input.value = "another";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "send" && m.text === "another" && m.kind === "steer"), "Enter steers it");
  input.value = "later";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }));
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "send" && m.text === "later" && m.kind === "queue"), "Alt+Enter queues it");
  assert.strictEqual(h.errors().length, 0);
});

test("the split button's default follows the setting, and Alt shows the other", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true, sendWhileWorking: "stopAndSend" });
  h.post({ type: "busy", value: true });
  const input = h.document.getElementById("input");
  input.value = "take over";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);

  const send = h.document.getElementById("send");
  assert.strictEqual(send.title, "Stop and Send (Enter)", "the setting decides what Enter does");
  assert.match(send.querySelector("i").className, /codicon-arrow-right/);
  send.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "stopAndSend" && m.text === "take over"));

  // Holding Alt flips the primary half, so it never claims the wrong thing.
  input.value = "and this after";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }));
  await h.settle(10);
  assert.strictEqual(send.title, "Add to Queue (Alt+Enter)");
  assert.match(send.querySelector("i").className, /codicon-add/);
  send.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "send" && m.text === "and this after" && m.kind === "queue"));
  assert.strictEqual(h.errors().length, 0);
});

test("without steering support Enter queues and the steer action stays hidden", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  // steering is absent (an older CLI), and the default preference is steer.
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "busy", value: true });
  const input = h.document.getElementById("input");
  input.value = "wait your turn";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);

  const send = h.document.getElementById("send");
  assert.strictEqual(send.title, "Add to Queue (Enter)", "an unsupported steer falls back to queue");
  assert.match(send.querySelector("i").className, /codicon-add/);
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "send" && m.text === "wait your turn" && m.kind === "queue"),
    "and it is sent as a queue entry, never a steer the agent cannot take");

  h.document.getElementById("send-more").click();
  await h.settle(10);
  const labels = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")]
    .map((r) => r.querySelector(".dv-menu-text span").textContent);
  assert.deepStrictEqual(labels, ["Stop and Send", "Add to Queue"], "steer is not offered at all");
  assert.strictEqual(h.errors().length, 0);
});

test("a queue preference makes Alt+Enter steer when the session supports it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true, sendWhileWorking: "queue" });
  h.post({ type: "busy", value: true });
  const input = h.document.getElementById("input");
  input.value = "change course";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);

  const send = h.document.getElementById("send");
  assert.strictEqual(send.title, "Add to Queue (Enter)");
  h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }));
  await h.settle(10);
  assert.strictEqual(send.title, "Steer with Message (Alt+Enter)", "Alt flips queue into steer");
  send.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "send" && m.text === "change course" && m.kind === "steer"));
  assert.strictEqual(h.errors().length, 0);
});

test("pending messages group under Steering and Queued dividers", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "queued", items: [
    { id: "s1", kind: "steer", text: "steer one" },
    { id: "s2", kind: "steer", text: "steer two" },
    { id: "q1", kind: "queue", text: "queue one" },
    { id: "q2", text: "queue two, kind missing like an old fixture" }
  ] });
  await h.settle(10);

  const dividers = [...h.thread().querySelectorAll(".queued-divider")];
  assert.deepStrictEqual(dividers.map((d) => d.textContent), ["Steering", "Queued"],
    "steering sits above queued under plain native labels");
  assert.match(dividers[0].title, /next opportunity/);
  assert.match(dividers[1].title, /after the current request completes/);
  const items = [...h.thread().querySelectorAll(".queued-item")];
  assert.deepStrictEqual(items.map((i) => i.querySelector(".queued-bubble").textContent),
    ["steer one", "steer two", "queue one", "queue two, kind missing like an old fixture"],
    "and the rows keep the host's order inside their groups");
  assert.ok(items[0].classList.contains("steering"), "a steer row is marked");
  assert.strictEqual(h.errors().length, 0);
});

test("a same kind drag posts reorderQueued, a cross kind one does not", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second" },
    { id: "s1", kind: "steer", text: "steer" }
  ] });
  await h.settle(10);

  // The steering group renders above the queued one, so find rows by text.
  const rows = [...h.thread().querySelectorAll(".queued-item")];
  const byText = (t) => rows.find((r) => r.querySelector(".queued-bubble").textContent === t);
  const q1 = byText("first");
  const q2 = byText("second");
  const s1 = byText("steer");
  const drag = (el, type, y) => {
    const e = new h.window.Event(type, { bubbles: true, cancelable: true });
    e.dataTransfer = {
      setData() {}, getData: () => "", effectAllowed: "", dropEffect: "",
      setDragImage(...args) { e.dragImage = args; }
    };
    if (y !== undefined) { e.clientY = y; }
    el.dispatchEvent(e);
    return e;
  };
  const gripOf = (row) => row.querySelector(".queued-grip");
  assert.ok(gripOf(q1) && gripOf(q2) && gripOf(s1), "every pending row has a drag grip");

  // Internal drags are claimed at the row: nothing may bubble to the window's
  // file drop surface, not even over a target the drag cannot land on.
  let leaked = 0;
  const count = () => { leaked++; };
  ["dragstart", "dragover", "drop", "dragend"].forEach((t) => h.window.addEventListener(t, count));

  // Drag q1 onto the lower half of q2: q1 lands after q2. jsdom reports empty
  // rects, so the midpoint is 0 and any positive clientY reads as "after".
  drag(gripOf(q1), "dragstart");
  drag(q2, "dragover", 1);
  assert.ok(q2.classList.contains("drop-after"), "the insertion rule shows on the target edge");
  drag(q2, "drop", 1);
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "reorderQueued" && m.id === "q1" && m.targetId === "q2" && m.before === false),
    "the drop posts the reorder to the host, which stays authoritative");
  drag(gripOf(q1), "dragend");

  // A steer row refuses a queue drag: dragover accepts nothing and drop posts nothing.
  const before = h.posted.filter((m) => m.type === "reorderQueued").length;
  drag(gripOf(q1), "dragstart");
  drag(s1, "dragover", 1);
  assert.ok(!s1.classList.contains("drop-before") && !s1.classList.contains("drop-after"),
    "a different kind is not a valid target");
  drag(s1, "drop", 1);
  drag(gripOf(q1), "dragend");
  await h.settle(5);
  assert.strictEqual(h.posted.filter((m) => m.type === "reorderQueued").length, before,
    "and nothing is posted for it");
  assert.strictEqual(leaked, 0, "no internal drag event reached the window");
  ["dragstart", "dragover", "drop", "dragend"].forEach((t) => h.window.removeEventListener(t, count));
  assert.strictEqual(h.errors().length, 0);
});

test("pending groups use plain native labels and only a same kind pair gets a live grip", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "queued", items: [
    { id: "s1", kind: "steer", text: "steer one" },
    { id: "q1", kind: "queue", text: "queue one" }
  ] });
  await h.settle(10);

  const dividers = [...h.thread().querySelectorAll(".queued-divider")];
  assert.deepStrictEqual(dividers.map((d) => d.textContent), ["Steering", "Queued"],
    "the groups carry the native labels with no count suffix");
  assert.strictEqual(dividers[0].title, "Steering message will be sent at the next opportunity");
  assert.strictEqual(dividers[1].title, "Queued messages will be sent after the current request completes");

  const gripState = (id) => {
    const grip = h.thread().querySelector(`.queued-item[data-id="${id}"] .queued-grip`);
    return { hidden: grip.classList.contains("hidden"), draggable: grip.draggable,
      iconHidden: grip.querySelector("i").getAttribute("aria-hidden") };
  };
  // A lone row of each kind keeps an inert grip: reorder needs a same kind target.
  ["s1", "q1"].forEach((id) => {
    const g = gripState(id);
    assert.ok(g.hidden && !g.draggable, `${id} grip sleeps while its kind has no sibling`);
    assert.strictEqual(g.iconHidden, "true", "the decorative grip icon is hidden from AT");
  });

  // A second steer wakes both steering grips. The queue row stays inert because
  // its own kind still has no sibling to land on.
  h.post({ type: "queued", items: [
    { id: "s1", kind: "steer", text: "steer one" },
    { id: "s2", kind: "steer", text: "steer two" },
    { id: "q1", kind: "queue", text: "queue one" }
  ] });
  await h.settle(10);
  ["s1", "s2"].forEach((id) => {
    const g = gripState(id);
    assert.ok(!g.hidden && g.draggable, `${id} grip is live beside a same kind sibling`);
  });
  assert.ok(gripState("q1").hidden && !gripState("q1").draggable,
    "a queue row cannot reorder into the steering group");

  // Losing the sibling puts the survivor's grip back to sleep.
  h.post({ type: "queued", items: [
    { id: "s2", kind: "steer", text: "steer two" },
    { id: "q1", kind: "queue", text: "queue one" }
  ] });
  await h.settle(10);
  assert.ok(gripState("s2").hidden && !gripState("s2").draggable,
    "the surviving steer grip sleeps alone again");
  assert.strictEqual(h.errors().length, 0);
});

test("a queued refresh reuses unchanged rows so action focus survives", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  const items = () => [
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second" }
  ];
  h.post({ type: "queued", items: items() });
  await h.settle(10);

  const rowOf = (id) => h.thread().querySelector(`.queued-item[data-id="${id}"]`);
  const removeBtn = (row) => row.querySelectorAll(".queued-actions button")[2];
  const q1 = rowOf("q1");
  const btn = removeBtn(q1);
  btn.focus();
  assert.strictEqual(h.document.activeElement, btn, "precondition: the remove button holds focus");

  // An identical refresh keeps the very same row and button elements.
  h.post({ type: "queued", items: items() });
  await h.settle(10);
  assert.strictEqual(rowOf("q1"), q1, "an unchanged row keeps its DOM");
  assert.strictEqual(removeBtn(rowOf("q1")), btn, "and its action button");
  assert.strictEqual(h.document.activeElement, btn, "focus survives the refresh");

  // Appending an unrelated message still leaves the focused row alone.
  h.post({ type: "queued", items: [...items(), { id: "q3", kind: "queue", text: "third" }] });
  await h.settle(10);
  assert.strictEqual(rowOf("q1"), q1, "the appended message did not rebuild the row");
  assert.strictEqual(h.document.activeElement, btn, "and did not steal focus");

  // Editing one id's text replaces only that row, and its actions carry the
  // new content.
  const q2old = rowOf("q2");
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second, edited" },
    { id: "q3", kind: "queue", text: "third" }
  ] });
  await h.settle(10);
  assert.strictEqual(rowOf("q1"), q1, "the untouched row is still the same element");
  const q2 = rowOf("q2");
  assert.ok(q2 && q2 !== q2old, "the edited row was rebuilt");
  q2.querySelector(".queued-actions button").click();
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("input").value, "second, edited",
    "the rebuilt row's edit action loads the current text");

  // Emptying the queue removes the rows. A session clear does the same and a
  // drag in flight cannot leak into the next session.
  h.post({ type: "queued", items: [] });
  await h.settle(10);
  assert.strictEqual(h.thread().querySelectorAll(".queued-item").length, 0);
  h.post({ type: "queued", items: items() });
  await h.settle(10);
  const grip = rowOf("q1").querySelector(".queued-grip");
  const start = new h.window.Event("dragstart", { bubbles: true, cancelable: true });
  start.dataTransfer = { setData() {}, getData: () => "", effectAllowed: "", dropEffect: "", setDragImage() {} };
  grip.dispatchEvent(start);
  assert.ok(rowOf("q1").classList.contains("dragging"), "the drag marks the row");
  h.post({ type: "clear" });
  await h.settle(10);
  assert.strictEqual(h.thread().querySelectorAll(".queued-item").length, 0, "the clear wipes the rows");
  h.post({ type: "queued", items: items() });
  await h.settle(10);
  const over = new h.window.Event("dragover", { bubbles: true, cancelable: true });
  over.dataTransfer = { setData() {}, getData: () => "", effectAllowed: "", dropEffect: "" };
  over.clientY = 1;
  rowOf("q1").dispatchEvent(over);
  assert.ok(!rowOf("q1").classList.contains("drop-before") && !rowOf("q1").classList.contains("drop-after"),
    "no stale drag id survives into the next session's queue");
  assert.strictEqual(h.errors().length, 0);
});

test("a rebuilt or removed earlier row does not move the focused row behind it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  const withSteer = (queue) => [{ id: "s1", kind: "steer", text: "steer one" }, ...queue];
  h.post({ type: "queued", items: withSteer([
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second" },
    { id: "q3", kind: "queue", text: "third" }
  ]) });
  await h.settle(10);

  const rowOf = (id) => h.thread().querySelector(`.queued-item[data-id="${id}"]`);
  const removeBtn = (row) => row.querySelectorAll(".queued-actions button")[2];
  const q3 = rowOf("q3");
  const btn = removeBtn(q3);
  btn.focus();
  assert.strictEqual(h.document.activeElement, btn, "precondition: q3's remove button holds focus");

  // A move inside the box shows up as a remove plus an add of the same row,
  // so watch for q3's row leaving and coming back across each refresh.
  const moved = [];
  const mo = new h.window.MutationObserver((records) => {
    records.forEach((r) => {
      [...r.removedNodes, ...r.addedNodes].forEach((n) => {
        if (n.nodeType === 1 && n.classList.contains("queued-item") && n.dataset.id === "q3") {
          moved.push(r.type);
        }
      });
    });
  });
  mo.observe(h.thread().querySelector(".queued-inline"), { childList: true });

  // q2's content changes: only its row rebuilds. q3 must not be carried across
  // the stale node a remove after the walk would leave on the cursor.
  h.post({ type: "queued", items: withSteer([
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second, edited", attachments: [{ label: "notes.txt", type: "file" }] },
    { id: "q3", kind: "queue", text: "third" }
  ]) });
  await h.settle(10);
  assert.strictEqual(rowOf("q3"), q3, "the row after a rebuilt sibling kept its DOM");
  assert.strictEqual(removeBtn(rowOf("q3")), btn, "and its action button");
  assert.strictEqual(h.document.activeElement, btn, "focus survived a preceding row rebuild");
  assert.deepStrictEqual(moved, [], "q3's row never left the box");

  // Removing q1 outright still leaves q3 where it was.
  moved.length = 0;
  h.post({ type: "queued", items: withSteer([
    { id: "q2", kind: "queue", text: "second, edited", attachments: [{ label: "notes.txt", type: "file" }] },
    { id: "q3", kind: "queue", text: "third" }
  ]) });
  await h.settle(10);
  assert.strictEqual(rowOf("q3"), q3, "the focused row kept its DOM when the row before it left");
  assert.strictEqual(h.document.activeElement, btn, "and kept focus");
  assert.deepStrictEqual(moved, [], "q3's row did not move for the removal either");

  // Dropping the whole Steering group ahead of the queue moves nothing either.
  moved.length = 0;
  h.post({ type: "queued", items: [
    { id: "q2", kind: "queue", text: "second, edited", attachments: [{ label: "notes.txt", type: "file" }] },
    { id: "q3", kind: "queue", text: "third" }
  ] });
  await h.settle(10);
  assert.strictEqual(rowOf("q3"), q3, "the focused row kept its DOM when an earlier group left");
  assert.strictEqual(h.document.activeElement, btn, "and kept focus");
  assert.deepStrictEqual(moved, [], "q3's row stayed put through the group drop");
  assert.strictEqual(h.thread().querySelectorAll(".queued-divider").length, 1,
    "only the Queued divider remains");
  assert.strictEqual(h.errors().length, 0);
});

test("a pending drag marks the whole row, refuses invalid targets and cleans up on end", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "first" },
    { id: "q2", kind: "queue", text: "second" },
    { id: "s1", kind: "steer", text: "steer" }
  ] });
  await h.settle(10);

  const rowOf = (id) => h.thread().querySelector(`.queued-item[data-id="${id}"]`);
  const drag = (el, type, y) => {
    const e = new h.window.Event(type, { bubbles: true, cancelable: true });
    e.dataTransfer = {
      setData() {}, getData: () => "", effectAllowed: "", dropEffect: "",
      setDragImage(...args) { e.dragImage = args; }
    };
    if (y !== undefined) { e.clientY = y; }
    el.dispatchEvent(e);
    return e;
  };
  const q1 = rowOf("q1");
  const q2 = rowOf("q2");
  const s1 = rowOf("s1");
  const grip = q1.querySelector(".queued-grip");

  const start = drag(grip, "dragstart");
  assert.strictEqual(start.dragImage[0], q1, "the drag image is the whole row");
  assert.deepStrictEqual(start.dragImage.slice(1), [0, 0]);
  assert.ok(q1.classList.contains("dragging"), "the source row is marked while dragging");

  // Self and cross kind targets accept nothing: no mark, no preventDefault.
  const selfOver = drag(q1, "dragover", 1);
  assert.ok(!q1.classList.contains("drop-before") && !q1.classList.contains("drop-after"),
    "dragging over itself shows no insertion line");
  assert.strictEqual(selfOver.defaultPrevented, false, "self is not a drop target");
  const crossOver = drag(s1, "dragover", 1);
  assert.ok(!s1.classList.contains("drop-before") && !s1.classList.contains("drop-after"),
    "a different kind shows no insertion line");
  assert.strictEqual(crossOver.defaultPrevented, false, "cross kind is not a drop target");

  // A valid target takes the mark and the drop. Moving to an invalid one clears it.
  const okOver = drag(q2, "dragover", 1);
  assert.ok(q2.classList.contains("drop-after"), "the valid target shows the insertion line");
  assert.strictEqual(okOver.defaultPrevented, true, "the valid target accepts the drop");
  drag(s1, "dragover", 1);
  assert.ok(!q2.classList.contains("drop-before") && !q2.classList.contains("drop-after"),
    "moving to an invalid target clears the old mark");
  drag(grip, "dragend");
  assert.ok(!q1.classList.contains("dragging"), "drag end clears the row mark");

  // A drop on the source row itself posts nothing.
  drag(grip, "dragstart");
  drag(q1, "drop", 1);
  await h.settle(5);
  assert.strictEqual(h.posted.filter((m) => m.type === "reorderQueued").length, 0,
    "dropping on itself is not a reorder");
  drag(grip, "dragend");
  assert.strictEqual(h.errors().length, 0);
});

for (const sendWhileWorking of ["steer", "stopAndSend"]) {
  for (const submit of ["Enter", "Send"]) {
    test(`cached queue edits keep their kind with ${submit} (${sendWhileWorking})`, () => {
      const h = createHarness();
      h.post({ type: "ready" });
      h.post({ type: "body", body: "thread" });
      h.post({ type: "clear" });
      h.post({ type: "sessionReady", sessionId: "A" });
      h.post({ type: "capabilities", steering: true, sendWhileWorking });
      h.post({ type: "sessionStatuses", statuses: { A: "running" }, activeId: "A" });
      h.post({ type: "busy", value: true });
      h.post({ type: "queued", items: [
        { id: "q1", kind: "queue", text: "first queued" },
        { id: "q2", kind: "queue", text: "second queued" }
      ] });

      h.document.getElementById("history-btn").click();
      h.post({ type: "body", body: "thread" });
      h.post({ type: "clear" });
      h.post({ type: "sessionReady", sessionId: "B" });
      h.document.getElementById("history-btn").click();
      h.post({
        type: "sessions",
        sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
        activeId: null,
        statuses: { A: "running", B: "idle" },
        folders: [{ path: "/w", name: "w" }]
      });
      h.document.querySelector("#sessions-list .session-main").click();
      assert.ok(h.posted.some((m) => m.type === "activateSession" && m.id === "A"));
      h.post({ type: "busy", value: true });

      h.thread().querySelector('.queued-item[data-id="q1"] .codicon-edit').parentElement.click();
      const input = h.document.getElementById("input");
      input.value = "first edited";
      input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
      const title = h.document.getElementById("send").title;
      const mark = h.posted.length;
      if (submit === "Enter") {
        input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      } else {
        h.document.getElementById("send").click();
      }

      const messages = h.posted.slice(mark).filter((m) =>
        ["send", "editQueued", "sendQueuedNow", "stopAndSend", "removeQueued", "queueEditing"].includes(m.type));
      assert.deepStrictEqual(messages, [
        { type: "editQueued", id: "q1", text: "first edited", kind: "queue" },
        { type: "queueEditing", id: null }
      ], "the edit keeps its queue kind and releases its hold without an immediate send");
      assert.strictEqual(title, "Add to Queue (Enter)");
      assert.deepStrictEqual([...h.thread().querySelectorAll(".queued-item")].map((row) => row.dataset.id), ["q1", "q2"]);
      assert.ok(!h.document.getElementById("input-editing-banner"));
      assert.strictEqual(h.errors().length, 0);
    });
  }
}

test("editing a pending message offers its kind in the send split", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "queued words" }] });
  await h.settle(10);

  const row = h.thread().querySelector(".queued-item");
  row.querySelector(".codicon-edit").parentElement.click();
  await h.settle(10);
  const input = h.document.getElementById("input");
  assert.strictEqual(input.value, "queued words");

  // The split is up even though the composer is editing, and its default is the
  // row's own kind: queue here, so Enter keeps it queued.
  const send = h.document.getElementById("send");
  assert.ok(h.document.getElementById("send-group").classList.contains("split"), "the split applies while editing pending");
  assert.strictEqual(send.title, "Add to Queue (Enter)");

  // Pick Steer from the menu: the edit carries the new kind.
  h.document.getElementById("send-more").click();
  await h.settle(10);
  const steerRow = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")]
    .find((r) => r.querySelector(".dv-menu-text span").textContent === "Steer with Message");
  steerRow.click();
  await h.settle(10);
  const edit = h.posted.find((m) => m.type === "editQueued");
  assert.ok(edit && edit.id === "q1" && edit.kind === "steer", "the edit says it is now a steer");
  const release = h.posted.findIndex((m) => m.type === "queueEditing" && m.id === null);
  assert.ok(release > h.posted.indexOf(edit), "and the hold is released after the edit lands");
  assert.strictEqual(h.errors().length, 0);
});

test("Stop and Send on an edited pending row sends it immediately, in order", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "queued words" }] });
  await h.settle(10);

  h.thread().querySelector(".queued-item .codicon-edit").parentElement.click();
  await h.settle(10);
  const input = h.document.getElementById("input");
  input.value = "queued words, edited";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);

  h.document.getElementById("send-more").click();
  await h.settle(10);
  const stopRow = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")]
    .find((r) => r.querySelector(".dv-menu-text span").textContent === "Stop and Send");
  stopRow.click();
  await h.settle(10);

  const types = h.posted.map((m) => m.type).filter((t) => ["editQueued", "sendQueuedNow", "queueEditing"].includes(t));
  assert.deepStrictEqual(types.slice(-3), ["editQueued", "sendQueuedNow", "queueEditing"],
    "the edit lands, then the immediate send, then the hold is released");
  const edit = h.posted.filter((m) => m.type === "editQueued").pop();
  assert.strictEqual(edit.text, "queued words, edited");
  const now = h.posted.filter((m) => m.type === "sendQueuedNow").pop();
  assert.strictEqual(now.id, "q1");
  assert.strictEqual(h.errors().length, 0);
});

test("a steered pending row's own buttons order edit, pick and release", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "s1", kind: "steer", text: "steer words" }] });
  await h.settle(10);

  const row = h.thread().querySelector(".queued-item.steering");
  const input = h.document.getElementById("input");
  const edit = row.querySelector(".codicon-edit").parentElement;
  const sendNow = row.querySelector(".codicon-newline").parentElement;
  const remove = row.querySelector(".codicon-close").parentElement;

  // Send Immediately on the row being edited: the edit must land first, then
  // the priority pick, and only then may the hold be released. Releasing early
  // would let the drain steer the stale text before its edit exists.
  edit.click();
  await h.settle(10);
  input.value = "steer words, edited";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);
  sendNow.click();
  await h.settle(10);
  const ordered = h.posted.map((m) => m.type)
    .filter((t) => ["editQueued", "sendQueuedNow", "queueEditing"].includes(t));
  assert.deepStrictEqual(ordered.slice(-3), ["editQueued", "sendQueuedNow", "queueEditing"],
    "edit, then send immediately, then release");
  assert.strictEqual(h.posted.filter((m) => m.type === "editQueued").pop().id, "s1");
  assert.strictEqual(h.posted.filter((m) => m.type === "sendQueuedNow").pop().id, "s1");
  assert.ok(!h.posted.some((m) => m.type === "send" && /steer words/.test(m.text || "")),
    "the row never falls through to a plain send");

  // Remove on the row being edited: the removal lands before the release, so
  // the drain cannot pick the message being deleted.
  edit.click();
  await h.settle(10);
  input.value = "steer words, edited again";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);
  const mark = h.posted.length;
  remove.click();
  await h.settle(10);
  const tail = h.posted.slice(mark).map((m) => m.type);
  assert.deepStrictEqual(tail.filter((t) => ["editQueued", "removeQueued", "sendQueuedNow", "queueEditing"].includes(t)),
    ["removeQueued", "queueEditing"], "removal first, release second, and no sendQueuedNow at all");
  assert.strictEqual(h.posted.filter((m) => m.type === "removeQueued").pop().id, "s1");
  assert.ok(!h.posted.slice(mark).some((m) => m.type === "send" || m.type === "sendQueuedNow"),
    "a removed row is never sent");
  assert.strictEqual(h.errors().length, 0);
});

test("the send menu is fully keyboard reachable from the split", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, steering: true });
  h.post({ type: "busy", value: true });
  const input = h.document.getElementById("input");
  input.value = "steer this";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);

  const send = h.document.getElementById("send");
  const more = h.document.getElementById("send-more");
  const key = (el, k, opts = {}) => el.dispatchEvent(new h.window.KeyboardEvent("keydown",
    Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));

  // ArrowRight walks from the primary half to the chevron, ArrowLeft back.
  send.focus();
  key(send, "ArrowRight");
  assert.strictEqual(h.document.activeElement, more, "ArrowRight on Send focuses the chevron");
  key(more, "ArrowLeft");
  assert.strictEqual(h.document.activeElement, send, "ArrowLeft on the chevron focuses Send");

  // ArrowDown opens the menu without a click and lands on the default row.
  key(more, "ArrowDown");
  await h.settle(10);
  let rows = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")];
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(h.document.activeElement, rows[2], "focus lands on the checked default (steer)");
  assert.strictEqual(more.getAttribute("aria-expanded"), "true");

  // Arrows wrap, Home and End jump.
  key(rows[2], "ArrowDown");
  assert.strictEqual(h.document.activeElement, rows[0], "ArrowDown wraps to the top");
  key(rows[0], "End");
  assert.strictEqual(h.document.activeElement, rows[2]);
  key(rows[2], "Home");
  assert.strictEqual(h.document.activeElement, rows[0]);
  key(rows[0], "ArrowUp");
  assert.strictEqual(h.document.activeElement, rows[2], "ArrowUp wraps to the bottom");

  // Escape closes, returns focus to the chevron, and sends nothing.
  const cancels = h.posted.filter((m) => m.type === "cancel").length;
  key(rows[2], "Escape");
  await h.settle(10);
  assert.ok(!h.document.querySelector(".dv-menu"), "the menu is closed");
  assert.strictEqual(h.document.activeElement, more, "focus is back on the chevron");
  assert.strictEqual(more.getAttribute("aria-expanded"), "false");
  assert.strictEqual(h.posted.filter((m) => m.type === "cancel").length, cancels, "Escape sent no cancel");

  // ArrowDown while closed reopens and refocuses the default. A click does too.
  key(more, "ArrowDown");
  await h.settle(10);
  rows = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")];
  assert.strictEqual(h.document.activeElement, rows[2], "reopening lands on the default again");
  key(rows[1], "ArrowRight");
  await h.settle(5);
  assert.ok(!h.document.querySelector(".dv-menu"), "ArrowRight closes back to the split");
  assert.strictEqual(h.document.activeElement, more);

  // Activating an action returns focus to the composer.
  more.click();
  await h.settle(10);
  rows = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")];
  assert.strictEqual(h.document.activeElement, rows[2]);
  rows[0].click();
  await h.settle(10);
  assert.strictEqual(h.document.activeElement, input, "focus returns to the composer after an action");
  assert.ok(h.posted.some((m) => m.type === "stopAndSend" && m.text === "steer this"));
  assert.strictEqual(h.errors().length, 0);
});

test("a run of tools says what it did, not how many tools it used", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "toolCall", id: "t1", title: "Read src/a.ts", kind: "read", status: "completed", locations: [{ path: "/w/src/a.ts" }] });
  h.post({ type: "toolCall", id: "t2", title: "Read src/b.ts", kind: "read", status: "completed", locations: [{ path: "/w/src/b.ts" }] });
  await h.settle(15);
  const label = () => h.thread().querySelector(".tool-group-label").textContent;
  assert.strictEqual(label(), "Read a.ts and b.ts", "two files are named");
  assert.strictEqual(
    h.thread().querySelector(".tool-group-label .tool-verb").textContent,
    "Read",
    "the verb leads, the rest is dimmed, like every other row"
  );
  assert.strictEqual(h.thread().querySelectorAll(".tool-group .codicon-tools").length, 0, "no icon of its own");

  // Past a couple of files it counts them, and other work adds its own clause.
  h.post({ type: "toolCall", id: "t3", title: "Read src/c.ts", kind: "read", status: "completed", locations: [{ path: "/w/src/c.ts" }] });
  h.post({ type: "toolCall", id: "t4", title: "Run npm test", kind: "execute", status: "completed", rawInput: { command: "npm test" } });
  await h.settle(15);
  assert.strictEqual(label(), "Read 3 files and ran npm test");

  h.post({ type: "toolCall", id: "t5", title: "Grep for auth", kind: "search", status: "completed", rawInput: { pattern: "auth", path: "/w/src" } });
  await h.settle(15);
  assert.strictEqual(label(), "Read 3 files and searched for auth in w/src");

  // A clause that already names two things carries its own "and", so the clauses
  // are separated by commas instead.
  h.post({ type: "assistantChunk", text: "now the other run" });
  h.post({ type: "toolCall", id: "u1", title: "Read one.ts", kind: "read", status: "completed", locations: [{ path: "/w/one.ts" }] });
  h.post({ type: "toolCall", id: "u2", title: "Read two.ts", kind: "read", status: "completed", locations: [{ path: "/w/two.ts" }] });
  h.post({ type: "toolCall", id: "u3", title: "Run npm run build", kind: "execute", status: "completed", rawInput: { command: "npm run build" } });
  await h.settle(15);
  const labels = [...h.thread().querySelectorAll(".tool-group-label")].map((l) => l.textContent);
  assert.strictEqual(labels[1], "Read one.ts and two.ts, ran npm run build");
  assert.strictEqual(h.errors().length, 0);
  // However much a run did, the summary is two clauses, as VS Code's chat keeps
  // it: chaining all of them ran the header past the panel and off its chevron.
  labels.forEach((l) => assert.ok(l.split(/, | and /).length <= 3, "at most two clauses: " + l));
});

test("a run holds its reasoning and its edits together, under one summary", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userChunk", text: "build the thing" });
  h.post({ type: "toolCall", id: "t1", title: "Read plan.ts", kind: "read", status: "completed", locations: [{ path: "/w/plan.ts" }] });
  h.post({ type: "fileChange", path: "/w/new.ts", added: 20, removed: 0, created: true });
  // Reasoning part way through the work used to split the run in two.
  h.post({ type: "thoughtChunk", text: "Now the callers need updating too.", messageId: "th1" });
  h.post({ type: "fileChange", path: "/w/shared.ts", added: 4, removed: 2 });
  await h.settle(30);

  const groups = [...h.thread().querySelectorAll(".tool-group")];
  assert.strictEqual(groups.length, 1, "one run, not one per interruption");
  const body = groups[0].querySelector(".tool-group-body");
  assert.strictEqual(body.querySelectorAll(".tool").length, 1, "the tool call is in it");
  assert.strictEqual(body.querySelectorAll(".edit-pill").length, 2, "so are both edits");
  assert.strictEqual(body.querySelectorAll(".thinking").length, 1, "and the reasoning between them");
  assert.strictEqual(
    groups[0].querySelector(".tool-group-label").textContent,
    "Created new.ts and updated shared.ts",
    "the summary names what it did to each file, and reads like VS Code's"
  );

  // The reply itself ends the run, and stays outside it.
  h.post({ type: "assistantChunk", text: "All done." });
  h.post({ type: "toolCall", id: "t2", title: "Read after.ts", kind: "read", status: "completed", locations: [{ path: "/w/after.ts" }] });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelectorAll(".tool-group").length, 1, "the answer closed the run");
  const reply = h.thread().querySelector(".resp-text");
  assert.ok(reply && !reply.closest(".tool-group"), "and the answer is not inside it");
  assert.strictEqual(h.errors().length, 0);
});

test("a tool that came back with a picture shows it, open or shut", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  h.post({
    type: "toolCall",
    id: "s1",
    title: "Capture browser screenshot",
    kind: "other",
    status: "completed",
    content: [{ type: "image", mime: "image/png", data: px }]
  });
  await h.settle(20);
  const tool = h.thread().querySelector(".tool");
  const shot = tool.querySelector(".tool-media .dv-thumb");
  assert.ok(shot, "the picture is the result, so it is shown");
  assert.ok(shot.src.startsWith("data:image/png;base64,"));
  assert.ok(tool.classList.contains("dv-collapsed"), "and it does not need the row opened");
  assert.ok(!tool.querySelector(".tool-body .dv-thumb"), "it is not buried inside the body");
  assert.strictEqual(h.errors().length, 0);
});

test("an executed command is the command and what it printed, uncaptioned", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "c1",
    title: "Run npm test",
    kind: "execute",
    status: "completed",
    rawInput: { command: "npm test" },
    content: [{ type: "text", text: "2 passing" }]
  });
  await h.settle(20);
  // VS Code's chat captions neither: a command followed by its output needs no
  // telling apart, and the captions were pure chrome on the most common row there is.
  const titles = [...h.thread().querySelectorAll(".tool-section-title")].map((t) => t.textContent);
  assert.deepStrictEqual(titles, [], "no Input and Output captions on a command");
  assert.strictEqual(h.thread().querySelector(".tool-command code").textContent, "npm test");
  // The row is titled by the command itself, highlighted, not by a sentence.
  assert.strictEqual(h.thread().querySelector(".tool .tool-label-code").textContent, "npm test");
  assert.strictEqual(h.errors().length, 0);
});

test("the chat says when it holds the keyboard, so its shortcuts can", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  await h.settle(10);

  // A keybinding's `when` cannot see into a webview, so Ctrl/Cmd+1..9 would go on
  // meaning what they mean everywhere else in VS Code unless the panel says this.
  h.window.dispatchEvent(new h.window.Event("focus"));
  await h.settle(5);
  assert.deepStrictEqual(h.posted.filter((m) => m.type === "chatFocus").pop(), { type: "chatFocus", value: true });

  h.window.dispatchEvent(new h.window.Event("blur"));
  await h.settle(5);
  assert.deepStrictEqual(h.posted.filter((m) => m.type === "chatFocus").pop(), { type: "chatFocus", value: false });
  assert.strictEqual(h.errors().length, 0);
});

test("a queued message shows what it is queued with, and keeps it when sent", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "busy", value: true });
  h.post({
    type: "queued",
    items: [{ id: "q-1", text: "look at this too", attachments: [{ label: "token.ts", type: "file" }] }]
  });
  await h.settle(20);

  const row = h.thread().querySelector(".queued-item .chat-attached-context");
  assert.ok(row, "the queued row says what is attached to it");
  assert.strictEqual(row.querySelector(".chat-attached-context-attachment").textContent, "token.ts");

  // The queue drains: the message becomes a request, still carrying its context.
  h.post({ type: "queued", items: [] });
  h.post({ type: "userMessage", text: "look at this too", attachments: [{ label: "token.ts", type: "file" }] });
  await h.settle(20);
  const sent = h.thread().querySelector(".turn-request .chat-attached-context-attachment");
  assert.ok(sent, "and the sent request still shows it");
  assert.strictEqual(sent.textContent, "token.ts");
  assert.strictEqual(h.document.getElementById("attachments").children.length, 0, "the composer is left empty");
  assert.strictEqual(h.errors().length, 0);
});

test("editing a queued message hands its attachments back to the composer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "q-1", text: "look at this", attachments: [{ label: "token.ts", type: "file" }] }] });
  await h.settle(20);

  h.thread().querySelector(".queued-item .codicon-edit").parentElement.click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "queueEditing" && m.id === "q-1"),
    "the host is told which message is being edited, so it can hand its context over"
  );
  // The host answers by staging a copy; the composer shows them as removable
  // pills, and the message keeps its own, so its row still says what it carries.
  h.post({ type: "attachments", items: [{ id: "a1", label: "token.ts", type: "file" }] });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("attachments").querySelectorAll(".chip").length, 1);
  assert.strictEqual(
    h.thread().querySelectorAll(".queued-item .chat-attached-context-attachment").length,
    1,
    "and the queued row goes on showing what it will send if this edit is abandoned"
  );

  const input = h.document.getElementById("input");
  input.value = "look at this, closely";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "editQueued" && m.id === "q-1" && m.text === "look at this, closely"),
    "committing the edit updates the message in place"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a request keeps what was attached to it, above the message", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "userMessage",
    text: "why does this look wrong?",
    attachments: [
      { label: "main.css", type: "file" },
      { label: "Screenshot.png", type: "image", thumb: "data:image/png;base64,iVBORw0KGgo=" }
    ]
  });
  await h.settle(20);

  const req = h.thread().querySelector(".turn-request");
  const row = req.querySelector(".chat-attached-context");
  assert.ok(row, "the context came with the message, so it stays with it");
  assert.ok(row.compareDocumentPosition(req.querySelector(".req-body")) & 4,
    "above the bubble, where VS Code puts it");
  const pills = [...row.querySelectorAll(".chat-attached-context-attachment")];
  assert.deepStrictEqual(pills.map((p) => p.textContent), ["main.css", "Screenshot.png"]);
  assert.ok(!pills[0].classList.contains("file-pill"), "attached context keeps its own pill styling");
  assert.ok(pills[0].querySelector(".attachment-icon"), "a file gets its file glyph");
  const img = pills[1].querySelector("img.chat-attached-context-pill-image");
  assert.ok(img, "a picture is its own thumbnail");
  assert.strictEqual(img.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");

  // A replayed request carries them too, so a reload does not strip the context.
  h.post({ type: "clear" });
  h.post({ type: "userChunk", text: "again", messageId: "m1", attachments: [{ label: "notes.md", type: "file" }] });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelectorAll(".chat-attached-context-attachment").length, 1);
  assert.strictEqual(h.errors().length, 0);
});

test("a long chain of commands is cut to a scannable length", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  const long = 'pkill -f "http.server 8899"; cd /Users/shayan/VSCode/devin-vscode && ' +
    "playwright-cli close >/dev/null 2>&1; rm -rf .playwright-cli /tmp/tg.png";
  h.post({ type: "toolCall", id: "c9", kind: "execute", status: "completed", rawInput: { command: long } });
  await h.settle(20);

  // VS Code stops at 80 characters in code rather than letting the panel decide,
  // so the row cannot run away however long the command is.
  const label = h.thread().querySelector(".tool .tool-label-code");
  assert.strictEqual(label.textContent.length, 80);
  assert.ok(label.textContent.endsWith("..."));
  assert.ok(long.startsWith(label.textContent.slice(0, 77)), "it is the start of the command");
  assert.strictEqual(h.thread().querySelector(".tool .dv-collapsible-header").title, long, "all of it on hover");
  assert.strictEqual(h.errors().length, 0);
});

test("an edit row waits for the host before it says a file was undone", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "do it" });
  h.post({ type: "fileChange", path: "/w/a.ts", added: 3, removed: 1 });
  await h.settle(20);

  const pill = () => h.thread().querySelector(".edit-pill");
  const undo = pill().querySelector('.edit-pill-actions button[title="Undo this file\'s changes"]');
  assert.ok(undo, "the row offers it");
  undo.click();
  assert.ok(h.posted.some((m) => m && m.type === "rejectFile" && m.path === "/w/a.ts"), "the host was asked");
  await h.settle(10);

  // An undo can fail: a read only file, a lock, a directory that has gone. The
  // host says so and keeps the file in the working set, so a row that had already
  // written "Undone" over itself would be the only thing claiming otherwise.
  assert.strictEqual(pill().querySelector(".edit-pill-label").textContent, "Edited", "it does not guess");
  assert.ok(!pill().classList.contains("resolved"));
  assert.ok(pill().querySelector(".edit-pill-actions"), "so it can be undone again");

  h.post({ type: "changesResolved", paths: ["/w/a.ts"], action: "reject" });
  await h.settle(10);
  assert.strictEqual(pill().querySelector(".edit-pill-label").textContent, "Undone", "and says so once it is");
  assert.strictEqual(h.thread().querySelectorAll(".edit-pill-actions").length, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("changed files header lets its controls wrap", () => {
  const css = fs.readFileSync(path.join(ROOT, "media", "main.css"), "utf8");
  const header = /\.ws-header\s*\{([^}]*)\}/.exec(css);
  assert.ok(header, "the changed files header has a style block");
  assert.match(header[1], /flex-wrap:\s*wrap/, "the header can reflow at narrow widths");
});

test("keeping every change marks every edit row, not just the one clicked", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "do it" });
  h.post({ type: "fileChange", path: "/w/a.ts", added: 3, removed: 1 });
  h.post({ type: "fileChange", path: "/w/b.ts", added: 2, removed: 0, created: true });
  h.post({ type: "workingSet", files: [{ path: "/w/a.ts", name: "a.ts" }, { path: "/w/b.ts", name: "b.ts" }] });
  await h.settle(20);

  const pills = () => [...h.thread().querySelectorAll(".edit-pill")];
  assert.strictEqual(pills().length, 2);
  assert.ok(pills().every((p) => !p.classList.contains("resolved")), "nothing is resolved yet");

  // "Keep all" resolves files nobody clicked, so the rows can only learn of it
  // from the host.
  const keepAll = [...h.document.querySelectorAll("#working-set button")].find((b) => b.textContent === "Keep all");
  assert.ok(keepAll, "the tray offers it");
  keepAll.click();
  assert.ok(h.posted.some((m) => m && m.type === "acceptAll"), "the tray asked the host");
  await h.settle(10);
  assert.ok(pills().every((p) => !p.classList.contains("resolved")), "and does not guess the answer");

  h.post({ type: "changesResolved", paths: ["/w/a.ts", "/w/b.ts"], action: "accept" });
  await h.settle(10);
  assert.ok(pills().every((p) => p.classList.contains("resolved")), "every row says so once it is done");
  assert.deepStrictEqual(
    pills().map((p) => p.querySelector(".edit-pill-label").textContent),
    ["Kept", "Kept"]
  );
  assert.strictEqual(h.thread().querySelectorAll(".edit-pill-actions").length, 0, "with nothing left to click");
  assert.strictEqual(h.errors().length, 0);
});

test("undoing every change says undone, and a later report cannot revive it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "do it" });
  h.post({ type: "fileChange", path: "/w/a.ts", added: 3, removed: 1 });
  await h.settle(20);

  h.post({ type: "changesResolved", paths: ["/w/a.ts"], action: "reject" });
  await h.settle(10);
  const pill = h.thread().querySelector(".edit-pill");
  assert.strictEqual(pill.querySelector(".edit-pill-label").textContent, "Undone");

  // The same edit arriving again must not put Keep and Undo back on a row that
  // has already been dealt with.
  h.post({ type: "fileChange", path: "/w/a.ts", added: 3, removed: 1 });
  await h.settle(10);
  assert.strictEqual(h.thread().querySelector(".edit-pill-label").textContent, "Undone");
  assert.strictEqual(h.thread().querySelectorAll(".edit-pill-actions").length, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("a run folds to its summary once it is over", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  await h.settle(20);
  const run = () => h.thread().querySelector(".tool-group");
  assert.ok(run(), "the two calls made a run");
  assert.ok(!run().classList.contains("dv-collapsed"), "open while the work is going on");

  // A word from the agent ends the run, as it does in VS Code's chat.
  h.post({ type: "assistantChunk", text: "Both read." });
  h.post({ type: "assistantEnd" });
  await h.settle(20);
  assert.ok(run().classList.contains("dv-collapsed"), "and folds to its summary after");
  assert.match(run().querySelector(".tool-group-label").textContent, /Read/, "and says what it did");

  // A turn that ends on its work, with no closing word, still ends its run.
  const h2 = createHarness();
  h2.post({ type: "ready" });
  h2.post({ type: "body", body: "thread" });
  h2.post({ type: "clear" });
  h2.post({ type: "userMessage", text: "go" });
  h2.post({ type: "busy", value: true });
  h2.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h2.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  await h2.settle(20);
  assert.ok(!h2.thread().querySelector(".tool-group").classList.contains("dv-collapsed"));
  h2.post({ type: "busy", value: false });
  await h2.settle(20);
  assert.ok(h2.thread().querySelector(".tool-group").classList.contains("dv-collapsed"),
    "otherwise the last run of every turn is the one left standing open");
  assert.strictEqual(h.errors().length + h2.errors().length, 0);
});

test("a finished turn puts its work behind one line, and keeps the answer out", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "assistantChunk", text: "Reading first." });
  h.post({ type: "assistantEnd" });
  h.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  h.post({ type: "assistantChunk", text: "Here is the answer." });
  h.post({ type: "assistantEnd" });
  h.post({ type: "turnStats", totalTimeMs: 83000, dimensions: [] });
  h.post({ type: "busy", value: false });
  await h.settle(30);

  const box = h.thread().querySelector("details.completed-work");
  assert.ok(box, "the work of a finished turn folds away");
  assert.strictEqual(
    box.querySelector(".completed-work-summary span").textContent,
    "Completed 3 steps in 1m 23s",
    "every node before the answer, counted and timed as VS Code does"
  );
  // The answer itself must never end up inside: folding it would hide the point.
  const answers = [...h.thread().querySelectorAll(".resp-text")];
  const last = answers[answers.length - 1];
  assert.ok(!box.contains(last), "the answer stays in the open");
  assert.match(last.textContent, /Here is the answer/);
  assert.strictEqual(h.errors().length, 0);
});

test("one step is left as itself, and a turn with no answer is left alone", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "assistantChunk", text: "Done." });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(30);
  assert.strictEqual(h.thread().querySelector("details.completed-work"), null,
    "one step reads better than a line saying there is one step");

  // A turn that ends on its work has no answer to keep out, so folding it all
  // away would leave the turn showing nothing at all.
  const h2 = createHarness();
  h2.post({ type: "ready" });
  h2.post({ type: "body", body: "thread" });
  h2.post({ type: "clear" });
  h2.post({ type: "userMessage", text: "go" });
  h2.post({ type: "busy", value: true });
  h2.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h2.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  h2.post({ type: "busy", value: false });
  await h2.settle(30);
  assert.strictEqual(h2.thread().querySelector("details.completed-work"), null, "nothing would be left showing");
  assert.strictEqual(h.errors().length + h2.errors().length, 0);
});

test("the working row shimmers a word, with no spinner beside it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "assistantStart" });
  await h.settle(20);

  const row = h.thread().querySelector(".working");
  assert.ok(row, "something has to say the agent is alive");
  const mark = row.querySelector(".working-mark");
  assert.ok(mark, "the Devin mark sits left of the working word");
  assert.strictEqual(mark.getAttribute("aria-hidden"), "true");
  assert.strictEqual(mark.getAttribute("focusable"), "false");
  assert.strictEqual(mark.getAttribute("viewBox"), "0 0 24 24");
  // The animated mark is the cog silhouette itself: the asset's paths under
  // per cog masks, with no grey base and nothing stroked or normalized.
  assert.strictEqual(mark.querySelectorAll(".working-mark-base").length, 0,
    "the grey silhouette base is gone");
  const asset = fs.readFileSync(path.join(ROOT, "media", "devin-logo.svg"), "utf8");
  const srcPaths = [...new h.window.DOMParser().parseFromString(asset, "image/svg+xml")
    .querySelectorAll("path")];
  const colored = [...mark.querySelectorAll(".working-mark-dynamic .working-mark-color")];
  const stat = [...mark.querySelectorAll(".working-mark-static > path")];
  assert.strictEqual(colored.length, 3, "the logo keeps its three coloured paths");
  assert.strictEqual(stat.length, 3, "the assembled mark keeps the same three paths");
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(colored[i].getAttribute("d"), srcPaths[i].getAttribute("d"),
      `dynamic path ${i} geometry drifted`);
    assert.strictEqual(colored[i].getAttribute("fill"), srcPaths[i].getAttribute("fill"),
      `dynamic path ${i} fill drifted`);
    assert.strictEqual(stat[i].getAttribute("d"), srcPaths[i].getAttribute("d"),
      `static path ${i} geometry drifted`);
    assert.ok(colored[i].getAttribute("mask"), `dynamic path ${i} lost its mask`);
  }
  for (const p of mark.querySelectorAll("path")) {
    assert.strictEqual(p.getAttribute("pathLength"), null, "the logo keeps its own geometry, nothing is normalized for a redraw");
    for (const attr of ["stroke", "stroke-width", "stroke-dasharray"]) {
      assert.strictEqual(p.getAttribute(attr), null, `a mark path carries ${attr}`);
    }
  }
  const label = row.querySelector(".dv-shimmer");
  assert.ok(label.classList.contains("working-label"), "the word needs its own label class");
  assert.strictEqual(mark.nextElementSibling, label, "the mark must sit before the word");
  assert.match(label.textContent, /^(Thinking|Reasoning|Considering|Analyzing|Evaluating|Working)$/,
    "one of VS Code's words, and no ellipsis: " + label.textContent);
  assert.strictEqual(row.querySelector("title"), null, "the decorative mark leaks a title into the row");
  assert.strictEqual(row.querySelector(".codicon-modifier-spin"), null,
    "the shimmer is the signal, so a spinner beside it says the same thing twice");
  // The row is rebuilt as the turn streams, so its sweep is pinned to a shared
  // clock: without this every rebuild restarts at 0% and reads as frozen.
  assert.match(label.style.animationDelay, /^-\d+ms$/);

  // A refresh that keeps the same word keeps the same mark, so its colour
  // cycle is never restarted.
  const markBefore = row.querySelector(".working-mark");
  h.post({ type: "usageState", loading: false });
  await h.settle(20);
  assert.strictEqual(row.querySelector(".working-mark"), markBefore,
    "a working refresh must not replace the mark");

  h.post({ type: "assistantChunk", text: "Here." });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null, "and it goes when the turn does");
  assert.strictEqual(h.errors().length, 0);
});

test("a session waking after idle says so without pretending a turn is running", async () => {
  const h = createHarness();
  h.replay([
    { role: "user", text: "earlier request" },
    { role: "assistant", text: "earlier answer" }
  ]);
  h.post({ type: "sessionReady", sessionId: "S1", title: "Chat" });
  h.post({ type: "busy", value: false });
  await h.settle(20);

  // The host reports the session waking: the row says so honestly, while no
  // turn is busy and Stop stays hidden.
  h.post({ type: "sessionStatuses", statuses: { S1: "starting" }, activeId: "S1" });
  await h.settle(20);
  const waking = h.thread().querySelector(".working .working-label");
  assert.ok(waking, "the working row appears while the session wakes");
  assert.strictEqual(waking.textContent, "Waking session");
  assert.ok(h.document.getElementById("stop").classList.contains("hidden"),
    "Stop stays hidden: nothing is running yet");

  // The wake settling to idle takes the row away again.
  h.post({ type: "sessionStatuses", statuses: { S1: "idle" }, activeId: "S1" });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null, "the row clears when the wake ends");

  // And it does not follow the panel to the session list.
  h.post({ type: "sessionStatuses", statuses: { S1: "starting" }, activeId: "S1" });
  await h.settle(20);
  assert.ok(h.thread().querySelector(".working .working-label"), "the row is back for another wake");
  h.post({ type: "body", body: "list" });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null, "the row stays with the thread it belongs to");
  assert.strictEqual(h.errors().length, 0);
});

test("the gap between one action and the next still says the agent is working", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "assistantStart" });
  h.post({ type: "toolCall", id: "t1", title: "Run npm test", kind: "execute", status: "in_progress" });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null,
    "a running command speaks for itself, so nothing is added beside it");

  // The command finishes and the agent goes quiet while it decides what is next.
  // That silence is exactly where the panel used to look like it had stopped.
  h.post({ type: "toolCallUpdate", id: "t1", status: "completed", content: [{ type: "text", text: "ok" }] });
  await h.settle(20);
  const row = h.thread().querySelector(".working");
  assert.ok(row, "the gap after a finished command says the agent is still working");
  assert.ok(row.previousElementSibling, "below the work it has done, at the end of the turn");
  assert.match(row.textContent, /^(Thinking|Reasoning|Considering|Analyzing|Evaluating|Working)$/);
  const gapMark = row.querySelector(".working-mark");
  assert.ok(gapMark && !gapMark.classList.contains("hidden"), "the mark shows while the agent works");

  // A question is not work: say what is actually being waited on, as VS Code does.
  h.post({ type: "permission", requestId: "p1", title: "Devin wants to run a command", options: [{ optionId: "allow", name: "Allow", kind: "allow" }] });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working").textContent, "1 confirmation pending");
  assert.ok(h.thread().querySelector(".working .working-mark").classList.contains("hidden"),
    "waiting on the user hides the mark");

  h.post({ type: "cancelPrompts" });
  h.post({ type: "assistantChunk", text: "All done." });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null, "streamed text speaks for itself");

  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelector(".working"), null, "and the turn ending takes it away");
  assert.strictEqual(h.errors().length, 0);
});

test("stopping a turn takes the question with it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({
    type: "elicitation",
    requestId: "q1",
    message: "Which one?",
    schema: { type: "object", properties: { pick: { type: "string", enum: ["a", "b"] } } }
  });
  await h.settle(20);
  assert.ok(h.document.querySelector("#elicitation-tray").children.length, "the agent asked something");

  // Stop answers it with "cancelled", so the question goes with the turn: leaving
  // it on screen offers to answer something nobody is waiting on.
  h.post({ type: "cancelPrompts" });
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector("#elicitation-tray").children.length, 0, "and stopping clears it");
  assert.strictEqual(h.document.querySelector("#permission-tray").children.length, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("a reloaded session comes back folded, and folded means hidden", async () => {
  const h = createHarness();
  h.replay([{ role: "user", text: "go" }]);
  h.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  h.post({ type: "thoughtChunk", text: "A replayed thought.", messageId: "t1", replayed: true });
  h.post({ type: "assistantChunk", text: "Done.", messageId: "a1" });
  await h.settle(30);

  // Before "loaded" the replay is still drawing, so nothing is folded yet.
  h.post({ type: "loaded" });
  await h.settle(30);

  const run = h.thread().querySelector(".tool-group");
  assert.ok(run.classList.contains("dv-collapsed"), "a whole session laid out end to end is not history, it is a wall");
  const think = [...h.thread().querySelectorAll(".thinking")].find((t) => !t.closest(".tool-group-body"));
  if (think) assert.ok(think.classList.contains("dv-collapsed"), "a replayed thought comes back folded too");
  // Except the reasoning inside the run, which folds to nothing rather than to a
  // header: an empty row on the chain, with its text beyond reach.
  const inRun = h.thread().querySelector(".tool-group-body > .thinking-plain");
  assert.ok(inRun, "the replayed thought joined the run it led to");
  assert.ok(!inRun.classList.contains("dv-collapsed"), "and opening the run shows it, rather than a line to nowhere");
  assert.strictEqual(inRun.querySelector(".dv-collapsible-anim-inner").inert, false, "so it is readable and searchable");

  // Folded is not merely invisible: Tab must not walk into it and find in page
  // must not match inside it.
  assert.strictEqual(run.querySelector(".dv-collapsible-anim-inner").inert, true);
  h.post({ type: "clear" });
  await h.settle(10);
  assert.strictEqual(h.errors().length, 0);
});

test("a run the user opened is left open when it ends", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "toolCall", id: "a", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "toolCall", id: "b", kind: "read", status: "completed", rawInput: { path: "/w/b.ts" } });
  await h.settle(20);

  // Closing something somebody deliberately opened is not tidying up.
  const run = h.thread().querySelector(".tool-group");
  run.querySelector(".dv-collapsible-header").click();  // collapse
  run.querySelector(".dv-collapsible-header").click();  // and open again, by hand
  await h.settle(10);
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.ok(!run.classList.contains("dv-collapsed"), "left as the user left it");
  assert.strictEqual(h.errors().length, 0);
});

test("scrolling back through a thought is not undone by the next one", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "busy", value: true });
  h.post({ type: "thoughtChunk", text: "First, the callers still import the old helpers." });
  await h.settle(30);

  // The peek is a fixed height box with its own scrollbar. jsdom has no layout, so
  // the geometry the pin reads is stated here.
  const box = h.thread().querySelector(".thinking .dv-collapsible-anim-inner");
  assert.ok(box, "the thought has a box of its own");
  Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });

  // The reader scrolls up inside it to read back through the chain.
  box.scrollTop = 300;
  h.post({ type: "thoughtChunk", text: "\n\nSecond, that means the rename has to cover them too." });
  await h.settle(30);
  const afterScrollingUp = box.scrollTop;

  // And back at the bottom, where it should follow the newest thought again.
  box.scrollTop = 800;
  h.post({ type: "thoughtChunk", text: "\n\nThird, the tests pin the old names." });
  await h.settle(30);
  const afterReturning = box.scrollTop;

  // Ending the thought stops the timer ticking its label, which is what keeps the
  // runner's event loop alive, so it happens before anything can throw.
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);

  assert.strictEqual(afterScrollingUp, 300, "the box stays where the reader left it");
  assert.strictEqual(afterReturning, 1000, "and follows again once they are back at the bottom");
  assert.strictEqual(h.errors().length, 0);
});

test("reasoning inside a run is text on the chain, not a section to open", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "toolCall", id: "t1", kind: "read", status: "completed", rawInput: { path: "/w/a.ts" } });
  h.post({ type: "thoughtChunk", text: "See [a.ts](src/a.ts)." });
  h.post({ type: "toolCall", id: "t2", kind: "edit", status: "completed", rawInput: { path: "/w/b.ts" } });
  await h.settle(30);

  const think = h.thread().querySelector(".thinking");
  assert.ok(think.classList.contains("thinking-plain"), "no header, nothing to open");
  // The stylesheet keys the headerless treatment off being inside a run, so this
  // is the invariant that decides how it is drawn.
  assert.ok(think.closest(".tool-group-body"), "and it sits on the run's chain with the work it led to");
  assert.match(think.textContent, /See a\.ts/, "the reasoning reads as itself");
  // A thought is a row of the run like any other, so it leads with a codicon in
  // the same column as the rows around it, and the chain treats it the same. The
  // stylesheet measures the node from those, so they are the invariant.
  const bullet = think.querySelector(".thinking-item > .thinking-icon");
  assert.ok(bullet, "the row leads with its glyph, before the text");
  assert.ok(bullet.classList.contains("codicon-circle-filled"), "a codicon, not a dot drawn by hand");
  assert.strictEqual(bullet.nextElementSibling.className, "thinking-item-content", "then what it thought");
  const thoughtLink = think.querySelector(".thinking-item-content a");
  assert.ok(thoughtLink && thoughtLink.classList.contains("file-pill"), "thinking references use the file pill");
  thoughtLink.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  thoughtLink.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  assert.ok(h.posted.some((m) => m.type === "openFile" && m.path === "src/a.ts"),
    "thinking references open from the keyboard");
  h.post({ type: "capabilities", inlineReferencesStyle: "link" });
  await h.settle(5);
  assert.ok(!thoughtLink.classList.contains("file-pill"), "link mode updates thinking references");
  h.post({ type: "capabilities", inlineReferencesStyle: "box" });
  await h.settle(5);
  assert.ok(thoughtLink.classList.contains("file-pill"), "box mode restores thinking references");
  assert.ok(!think.classList.contains("dv-collapsed"), "and it is open: there is no header left to open it with");

  // A thought on its own is a section of its own, and keeps its header: it is
  // not a step in anything, so headerless text would be a paragraph from nowhere.
  const h3 = createHarness();
  h3.post({ type: "ready" });
  h3.post({ type: "body", body: "thread" });
  h3.post({ type: "clear" });
  h3.post({ type: "thoughtChunk", text: "Weighing it up." });
  h3.post({ type: "assistantChunk", text: "Answer." });
  h3.post({ type: "assistantEnd" });
  await h3.settle(30);
  const lone = h3.thread().querySelector(".thinking");
  assert.ok(!lone.closest(".tool-group-body"), "not in a run, so the header stays");
  assert.strictEqual(lone.querySelector(".thinking-label").textContent, "Thought for 1s");
  assert.strictEqual(h3.errors().length, 0);

  // Asking for the folded style still gets a folded section.
  const h2 = createHarness();
  h2.post({ type: "ready" });
  h2.post({ type: "body", body: "thread" });
  h2.post({ type: "clear" });
  h2.post({ type: "capabilities", thinkingStyle: "collapsed" });
  h2.post({ type: "thoughtChunk", text: "Weighing two options." });
  // Settle the block: a live one keeps its "Thinking… Ns" ticker running.
  h2.post({ type: "assistantChunk", text: "Going with the first." });
  h2.post({ type: "assistantEnd" });
  await h2.settle(30);
  const folded = h2.thread().querySelector(".thinking");
  assert.ok(!folded.classList.contains("thinking-plain"));
  assert.ok(folded.querySelector(".thinking-label"), "which keeps its header");
  assert.strictEqual(h.errors().length + h2.errors().length, 0);
});

test("every step of a thought is a node on the run's chain", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "toolCall", id: "z0", kind: "execute", status: "completed", rawInput: { command: "echo one" } });
  h.post({ type: "thoughtChunk", text: "First this.\n\nThen that.\n\nAnd finally the other.", messageId: "t1" });
  h.post({ type: "toolCall", id: "z1", kind: "execute", status: "completed", rawInput: { command: "echo two" } });
  h.post({ type: "assistantChunk", text: "Done." });
  h.post({ type: "assistantEnd" });
  await h.settle(30);

  // The run's line only ever breaks around one node per row, so a thought of
  // several steps has to chain its own: the stylesheet keys that off the steps
  // being separate elements, each with its own bullet.
  const steps = [...h.thread().querySelectorAll(".tool-group-body > .thinking-plain .thinking-item")];
  assert.strictEqual(steps.length, 3, "one step per paragraph of reasoning");
  steps.forEach((s) => assert.ok(s.querySelector(".thinking-icon"), "each wearing its own bullet"));
  assert.strictEqual(h.errors().length, 0);
});

test("invoking a skill is one line, and the skill opens from it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "commit it" });
  h.post({
    type: "toolCall",
    id: "s1",
    kind: "other",
    status: "completed",
    title: "Invoked skill git-workflow",
    meta: { inferenceToolName: "skill" },
    rawInput: { skill: "git-workflow" }
  });
  await h.settle(30);

  const row = h.thread().querySelector(".tool");
  // Nothing to open: the body only ever held the skill's own name as JSON.
  assert.ok(row.classList.contains("dv-nocollapse"), "a skill invocation is a fact, not a step to expand");
  assert.strictEqual(row.querySelector(".tool-body").innerHTML, "");

  // The name is an inline anchor, as VS Code renders a skill in a tool title.
  const pill = row.querySelector(".chat-inline-anchor");
  assert.ok(pill, "the skill is a pill");
  assert.strictEqual(pill.textContent, "git-workflow");
  assert.ok(pill.querySelector(".codicon"), "with its icon on the left");
  assert.match(row.querySelector(".label").textContent, /^Invoked skill/, "after what the agent did with it");

  pill.click();
  await h.settle(5);
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "openSkill"),
    [{ type: "openSkill", name: "git-workflow" }],
    "and it opens where the skill is written"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a thought that says nothing is not left on the chain", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "toolCall", id: "z0", kind: "execute", status: "completed", rawInput: { command: "echo one" } });
  // Reasoning that turned out to be whitespace. Left in, it is a step with
  // nothing beside it and a gap in the run where the reader looks for one.
  h.post({ type: "thoughtChunk", text: "   \n\n", messageId: "t9" });
  h.post({ type: "toolCall", id: "z1", kind: "execute", status: "completed", rawInput: { command: "echo two" } });
  h.post({ type: "assistantChunk", text: "Done." });
  h.post({ type: "assistantEnd" });
  await h.settle(30);

  const rows = [...h.thread().querySelectorAll(".tool-group-body > *")];
  assert.deepStrictEqual(rows.map((r) => r.className.split(" ")[0]), ["tool", "tool"], "two commands, and nothing between them");
  assert.strictEqual(h.thread().querySelector(".tool-group-label").textContent, "Ran 2 commands");
  assert.strictEqual(h.errors().length, 0);
});

test("a reloaded command does not report its own input as its output", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  // How a replayed run arrives: the command comes back as the script it was sent
  // as, which is not output. Rendering it showed every old row its input twice.
  const cmd = "npm test -- --coverage";
  h.post({
    type: "toolCall",
    id: "r1",
    kind: "execute",
    status: "completed",
    rawInput: { command: cmd },
    content: [{ type: "text", text: cmd }]
  });
  await h.settle(20);

  const body = h.thread().querySelector(".tool-body");
  assert.strictEqual(body.querySelectorAll("pre").length, 0, "the command is not also the result");
  assert.strictEqual(h.thread().querySelector(".tool-command code").textContent, cmd, "it is still the command");

  // Real output is still shown.
  h.post({ type: "toolCallUpdate", id: "r1", content: [{ type: "text", text: "2 passing" }] });
  await h.settle(20);
  assert.match(h.thread().querySelector(".tool-body pre").textContent, /2 passing/);
  assert.strictEqual(h.errors().length, 0);
});

test("a command's row drops the cd that got it there", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "cd1",
    kind: "execute",
    status: "completed",
    rawInput: { command: "cd /Users/shayan/VSCode/devin-vscode && npm test" }
  });
  await h.settle(20);

  // VS Code's extractCdPrefix: the row is for the command, not for the path it
  // was run in, which is long enough to push the command off the end.
  assert.strictEqual(h.thread().querySelector(".tool .tool-label-code").textContent, "npm test");
  assert.strictEqual(
    h.thread().querySelector(".tool-command code").textContent,
    "cd /Users/shayan/VSCode/devin-vscode && npm test",
    "expanding it still shows what actually ran"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a listing is grouped by folder, not a wall of pills", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", root: "/repo" });
  const files = [
    "/repo/src/acp/client.ts", "/repo/src/acp/types.ts", "/repo/src/acp/terminal.ts",
    "/repo/src/chat/chatManager.ts", "/repo/src/chat/chatViewProvider.ts",
    "/repo/src/cli/locate.ts", "/repo/src/extension.ts"
  ];
  h.post({
    type: "toolCall",
    id: "g1",
    kind: "search",
    status: "completed",
    rawInput: { query: "src/**/*.ts" },
    content: files.map((path) => ({ type: "link", path }))
  });
  await h.settle(20);

  const heads = [...h.thread().querySelectorAll(".file-group-name")].map((n) => n.textContent);
  assert.deepStrictEqual(heads, ["src/acp", "src/chat", "src/cli", "src"], "one heading per folder, in the order found");
  const counts = [...h.thread().querySelectorAll(".file-group-count")].map((n) => n.textContent);
  assert.deepStrictEqual(counts, ["3", "2", "1", "1"], "each says how many are in it");
  assert.strictEqual(h.thread().querySelectorAll(".file-group-row").length, 7, "every file is still a row that opens");
  assert.strictEqual(h.thread().querySelectorAll(".tool-files").length, 0, "and none of it is pills");

  // The row carries what was looked for and how many turned up, so the body does
  // not repeat it, and the raw argument fallback must not dump it back as JSON.
  const row = [...h.thread().querySelectorAll(".tool .label")].find((l) => l.textContent.includes("src/**/*.ts"));
  assert.match(row.textContent, /src\/\*\*\/\*\.ts, 7 results/);
  assert.strictEqual(h.thread().querySelectorAll(".tool-summary").length, 0, "the query is not said twice");
  assert.strictEqual(h.thread().querySelectorAll(".tool-body pre").length, 0, "and never as raw JSON");

  // A handful stays as pills: grouping four files under one heading is worse.
  h.post({
    type: "toolCall",
    id: "g2",
    kind: "search",
    status: "completed",
    content: files.slice(0, 3).map((path) => ({ type: "link", path }))
  });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelectorAll(".tool-files").length, 1, "a short result is still pills");
  assert.strictEqual(h.errors().length, 0);
});

test("a Windows listing is grouped under the workspace, not under its full path", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  // VS Code lower cases the drive letter and uses backslashes; the agent answers
  // with the drive as the user typed it and forward slashes. Same folder.
  h.post({ type: "capabilities", root: "c:\\repo" });
  const files = [
    "C:/repo/src/acp/client.ts", "C:/repo/src/acp/types.ts", "C:/repo/src/acp/terminal.ts",
    "C:/repo/src/chat/chatManager.ts", "C:/repo/src/chat/chatViewProvider.ts",
    "C:/repo/src/cli/locate.ts", "C:/repo/extension.ts"
  ];
  h.post({
    type: "toolCall",
    id: "w1",
    kind: "search",
    status: "completed",
    rawInput: { query: "src/**/*.ts" },
    content: files.map((path) => ({ type: "link", path }))
  });
  await h.settle(20);

  const heads = [...h.thread().querySelectorAll(".file-group-name")].map((n) => n.textContent);
  assert.deepStrictEqual(heads, ["src/acp", "src/chat", "src/cli", "."], "folders relative to the workspace");
  assert.strictEqual(h.errors().length, 0);
});

test("a command spanning many lines still takes one row", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  const heredoc = "python3 - <<'PY'\nimport re\nprint(re)\nPY";
  h.post({
    type: "toolCall",
    id: "c2",
    title: "Run a script",
    kind: "execute",
    status: "completed",
    rawInput: { command: heredoc },
    content: [{ type: "text", text: "done" }]
  });
  await h.settle(20);

  const label = h.thread().querySelector(".tool .tool-label-code");
  // VS Code's buildCommandDisplayText: one line, newlines collapsed to spaces.
  assert.strictEqual(label.textContent, "python3 - <<'PY' import re print(re) PY");
  assert.ok(!label.querySelector("span"), "and plain, not highlighted: on the row a command is a label");
  assert.strictEqual(
    h.thread().querySelector(".tool .dv-collapsible-header").title,
    heredoc,
    "the whole command is still there on hover"
  );
  // And in full where it belongs, in the Input section.
  assert.strictEqual(h.thread().querySelector(".tool-command code").textContent, heredoc);
  assert.strictEqual(h.errors().length, 0);
});

test("a command's output opens itself only while it is still running", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "c1",
    title: "Run npm test",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm test" },
    content: [{ type: "terminal", terminalId: "term-1" }]
  });
  await h.settle(20);
  const tool = () => h.thread().querySelector(".tool");
  assert.ok(tool().classList.contains("dv-collapsed"), "a command that may finish at once stays shut");

  // Still going a moment later: the output is worth watching, so it opens.
  await h.settle(2200);
  assert.ok(!tool().classList.contains("dv-collapsed"), "a long running one opens itself");

  // Finished well: what was only opened to watch it closes again.
  h.post({ type: "toolCallUpdate", id: "c1", status: "completed" });
  await h.settle(20);
  assert.ok(tool().classList.contains("dv-collapsed"), "and closes when it succeeds");
  assert.strictEqual(h.errors().length, 0);
});

test("a search says what it looked for and where, in one line", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "s1",
    title: "Grep for showInfo",
    kind: "search",
    status: "completed",
    rawInput: { pattern: "devin.showInfo", path: "/w/src/ui" },
    content: [{ type: "text", text: "3 matches" }]
  });
  await h.settle(20);
  const tool = h.thread().querySelector(".tool");
  assert.strictEqual(tool.querySelector(".tool-verb").textContent, "Grep");
  assert.strictEqual(tool.querySelector(".tool-detail").textContent, " devin.showInfo in src/ui");
  assert.ok(tool.classList.contains("dv-nocollapse"), "there is nothing left to expand");
  assert.strictEqual(tool.querySelector(".tool-body").childElementCount, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("stepping between questions updates the question text, not just the options", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({
    type: "elicitation", requestId: "e1", mode: "form", message: "First question about auth?",
    schema: {
      type: "object",
      required: ["q0", "q1"],
      properties: {
        q0: { type: "string", title: "Auth", description: "First question about auth?", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
        q1: { type: "string", title: "DB", description: "Second question about the database?", oneOf: [{ const: "x", title: "X" }, { const: "y", title: "Y" }] }
      }
    }
  });
  await h.settle(20);

  const titleEl = h.document.querySelector("#elicitation-tray .qc-title");
  assert.strictEqual(titleEl.textContent, "First question about auth?", "the header shows the first question");

  const nextBtn = [...h.document.querySelectorAll("#elicitation-tray .qc-nav button")].find((b) => (b.title || "").includes("Next"));
  assert.ok(nextBtn, "there is a Next button");
  nextBtn.click();
  await h.settle(10);
  assert.strictEqual(titleEl.textContent, "Second question about the database?", "the header updates to the second question");
  assert.strictEqual(h.errors().length, 0);
});

test("clicking an external link defers to VS Code (no duplicate open)", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "assistantStart" });
  h.post({ type: "toolCall", id: "f1", title: "Fetched https://example.com", kind: "fetch",
    meta: { inferenceToolName: "webfetch" }, status: "pending", rawInput: { url: "https://example.com" } });
  h.post({ type: "toolCallUpdate", id: "f1", status: "completed", meta: { inferenceToolName: "webfetch" } });
  await h.settle(20);

  const link = h.document.querySelector("#thread a.tool-summary-value");
  assert.ok(link, "the fetch tool renders a clickable URL");
  link.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await h.settle(10);

  // http(s) links are opened by VS Code's built-in webview link handling; the
  // webview must NOT also post openExternal or the link opens in two tabs.
  const opens = h.posted.filter((m) => m.type === "openExternal");
  assert.strictEqual(opens.length, 0, "the webview does not duplicate VS Code's open");
  assert.strictEqual(h.errors().length, 0);
});

test("a skipped plan entry renders struck through with a slash icon", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "plan", entries: [
    { content: "Do A", status: "completed" },
    { content: "Skip B", status: "skipped" },
    { content: "Do C", status: "in_progress" }
  ] });
  await h.settle(20);

  const skipped = h.document.querySelector("#todo-widget .plan-skipped");
  assert.ok(skipped, "a skipped row is rendered");
  assert.ok(skipped.querySelector(".plan-mark.codicon-circle-slash"), "a skipped entry uses the slash icon");
  assert.strictEqual(skipped.querySelector(".plan-entry-text").textContent, "Skip B");
  assert.strictEqual(h.errors().length, 0);
});

test("a command shows the output it is producing, not just its exit code", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "c1",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "npm test" },
    terminalId: "term-1"
  });
  h.post({ type: "terminalOutput", terminalId: "term-1", output: "running 12 tests\n" });
  await h.settle(20);

  const pre = h.thread().querySelector('pre[data-terminal="term-1"]');
  assert.ok(pre, "the row shows the terminal it is running in");
  assert.match(pre.textContent, /running 12 tests/, "and the output as it arrives");

  // Devin reports only the exit code when it finishes, which the output already
  // ends with, so it must not be repeated as a second Output block.
  h.post({ type: "terminalOutput", terminalId: "term-1", output: "running 12 tests\nall passed\n", exitStatus: { exitCode: 0 } });
  h.post({
    type: "toolCallUpdate",
    id: "c1",
    status: "completed",
    content: [{ type: "text", text: "Exited with code 0" }]
  });
  await h.settle(20);

  const live = h.thread().querySelector('pre[data-terminal="term-1"]');
  assert.match(live.textContent, /all passed/);
  assert.match(live.textContent, /exited code 0/);
  const blocks = h.thread().querySelectorAll(".tool-body pre");
  assert.strictEqual(blocks.length, 1, "one output block, not two saying the same thing");
  assert.strictEqual(h.errors().length, 0);
});

test("a command running in a real terminal offers what VS Code offers", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "toolCall", id: "c1", kind: "execute", status: "in_progress", rawInput: { command: "npm run dev" }, terminalId: "term-9" });
  h.post({ type: "terminalOutput", terminalId: "term-9", output: "listening on 3000\n", integrated: true });
  await h.settle(20);

  // The row's own title carries them, icon only, in VS Code's order and wording
  // (chatTerminalToolProgressPart: Continue in Background, then focus).
  const bar = () => h.thread().querySelector("#thread .tool .tool-actions");
  const actions = () => [...bar().querySelectorAll("button")].map((b) => [b.title, b.querySelector("i").className.split(" ")[1]]);
  assert.deepStrictEqual(actions(), [
    ["Continue in Background", "codicon-debug-continue-small"],
    ["Show and Focus Terminal", "codicon-open-in-product"]
  ]);
  // And the disclosure is the third of them, named for what it would do.
  assert.strictEqual(h.thread().querySelector(".tool .tool-chevron").title, "Show Output");

  bar().querySelectorAll("button")[1].click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "showTerminal" && m.terminalId === "term-9"));
  // Once shown it is no longer hidden, so the action stops offering to show it.
  h.post({ type: "terminalOutput", terminalId: "term-9", output: "listening on 3000\n", integrated: true, revealed: true });
  await h.settle(10);
  assert.deepStrictEqual(actions().map((a) => a[0]), ["Continue in Background", "Focus Terminal"]);

  bar().querySelectorAll("button")[0].click();
  await h.settle(5);
  assert.ok(
    h.posted.some((m) => m.type === "continueInBackground" && m.terminalId === "term-9"),
    "backgrounding it tells the host to stop waiting"
  );

  // The host confirms: the command is still going, the agent is not waiting, and
  // there is nothing left to background.
  h.post({ type: "terminalOutput", terminalId: "term-9", output: "listening on 3000\n", integrated: true, revealed: true, skipped: true });
  await h.settle(10);
  assert.deepStrictEqual(actions().map((a) => a[0]), ["Focus Terminal"]);
  assert.match(
    h.thread().querySelector("#thread .tool .label").textContent,
    /^Running.*npm run dev in background$/,
    "and the row says it is still going, as VS Code titles it"
  );

  // A command that never had a terminal of its own has nothing to offer.
  h.post({ type: "toolCall", id: "c2", kind: "execute", status: "in_progress", rawInput: { command: "ls" }, terminalId: "term-10" });
  h.post({ type: "terminalOutput", terminalId: "term-10", output: "a.ts\n" });
  await h.settle(10);
  const rows = [...h.thread().querySelectorAll("#thread .tool")];
  assert.strictEqual(rows[rows.length - 1].querySelector(".tool-actions").children.length, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("an MCP server that would not start is said out loud", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({
    type: "mcpProblems",
    servers: [{ name: "godot-ai", message: "MCP server 'godot-ai' connection failed: refused" }]
  });
  await h.settle(10);

  const card = h.document.getElementById("mcp-problems");
  assert.ok(card, "a chat missing half its tools has to say so");
  assert.match(card.textContent, /godot-ai did not start/);
  assert.match(card.textContent, /connection failed: refused/, "with what the CLI actually said");

  // A second one folds into the same row rather than stacking.
  h.post({
    type: "mcpProblems",
    servers: [
      { name: "godot-ai", message: "MCP server 'godot-ai' connection failed: refused" },
      { name: "telegram", message: "Failed to connect to MCP server 'telegram'" }
    ]
  });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#mcp-problems").length, 1);
  assert.match(h.document.getElementById("mcp-problems").textContent, /2 MCP servers did not start/);

  // Read once, it is noise: it can be sent away and must stay away.
  h.document.querySelector("#mcp-problems .mcp-dismiss").click();
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("mcp-problems"), null, "dismissed");
  h.post({
    type: "mcpProblems",
    servers: [
      { name: "godot-ai", message: "MCP server 'godot-ai' connection failed: refused" },
      { name: "telegram", message: "Failed to connect to MCP server 'telegram'" }
    ]
  });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("mcp-problems"), null, "and does not come back on its own");

  // Dismiss is for this one. The other two say how much longer than that.
  h.post({ type: "mcpProblems", servers: [{ name: "fetch", message: "MCP server 'fetch' failed" }] });
  await h.settle(10);
  const mutes = [...h.document.querySelectorAll("#mcp-problems .dv-link-btn")];
  assert.deepStrictEqual(mutes.map((b) => b.textContent), ["Don't show again in this window", "Don't show again"]);
  mutes[1].click();
  await h.settle(10);
  assert.ok(
    h.posted.some((m) => m.type === "muteMcpWarnings" && m.scope === "always"),
    "turning it off for good is a setting, so the host owns it"
  );
  assert.strictEqual(h.document.getElementById("mcp-problems"), null, "and the card goes with it");

  // A server that fails afterwards is news again.
  h.post({
    type: "mcpProblems",
    servers: [
      { name: "godot-ai", message: "MCP server 'godot-ai' connection failed: refused" },
      { name: "fetch", message: "MCP server 'fetch' connection failed: timeout" }
    ]
  });
  await h.settle(10);
  const back = h.document.getElementById("mcp-problems");
  assert.ok(back, "a server that failed later says so");
  assert.match(back.textContent, /The MCP server fetch did not start/, "naming only the new one");

  // And a different chat starts over, dismissed or not.
  h.post({ type: "clear" });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("mcp-problems"), null, "the warning belongs to the chat it came from");
  assert.strictEqual(h.errors().length, 0);
});

test("a finished turn shows what it cost, in the CLI's own figures", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", verbose: true });
  h.post({ type: "userMessage", text: "do the thing" });
  h.post({ type: "assistantChunk", text: "done" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  h.post({
    type: "turnStats",
    model: "Claude Opus 5 High",
    totalTimeMs: 6605,
    dimensions: [
      { label: "ACUs spent", value: "0.11 ACUs" },
      { label: "Agent messages", value: "3 messages" }
    ]
  });
  await h.settle(20);

  const det = h.thread().querySelector(".chat-footer-details");
  assert.ok(det, "the footer carries the detail");
  assert.match(det.textContent, /6\.6s/, "how long it took, as the CLI measured it");
  assert.match(det.textContent, /Claude Opus 5 High/);
  assert.match(det.title, /ACUs spent: 0\.11 ACUs/, "and what it cost, on hover");
  assert.match(det.title, /Agent messages: 3 messages/);
  assert.strictEqual(h.errors().length, 0);
});

test("a folded plan says where it has got to, not just how far", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "plan", entries: [
    { content: "Read the auth module", status: "completed" },
    { content: "Extract the token service", status: "in_progress" },
    { content: "Run the tests", status: "pending" }
  ] });
  await h.settle(10);

  const widget = h.document.getElementById("todo-widget");
  assert.ok(widget._ctrl.isCollapsed(), "it folds itself once work is under way");
  assert.strictEqual(widget.querySelector(".plan-count").textContent, "1/3");
  assert.strictEqual(
    widget.querySelector(".plan-at").textContent,
    "Extract the token service",
    "and names the item being worked on, so a plan that stops moving reads as stale"
  );

  // Nothing under way: it names what is waiting instead.
  h.post({ type: "plan", entries: [
    { content: "Read the auth module", status: "completed" },
    { content: "Extract the token service", status: "pending" }
  ] });
  await h.settle(10);
  const at = widget.querySelector(".plan-at");
  assert.strictEqual(at.textContent, "Extract the token service");
  assert.ok(at.classList.contains("plan-at-next"), "marked as what is next rather than what is happening");
  assert.strictEqual(h.errors().length, 0);
});

test("the plan remembers a manual collapse for the next run in the session", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  // All pending -> the plan opens expanded (no auto-collapse yet).
  h.post({ type: "plan", entries: [{ content: "Task", status: "pending" }] });
  await h.settle(10);
  const widget = h.document.getElementById("todo-widget");
  let plan = widget.querySelector(".plan-docked");
  assert.ok(!plan.classList.contains("dv-collapsed"), "the plan starts expanded");

  // The user collapses it by hand.
  plan.querySelector(".dv-collapsible-header").click();
  await h.settle(10);
  assert.ok(plan.classList.contains("dv-collapsed"), "the plan collapses on the user's click");

  // Finish the turn (docked plan is cleared) and start a new one that raises a
  // fresh plan: it must stay collapsed, honouring the remembered choice.
  h.post({ type: "busy", value: true });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  h.post({ type: "plan", entries: [{ content: "Task", status: "in_progress" }] });
  await h.settle(10);
  plan = widget.querySelector(".plan-docked");
  assert.ok(plan.classList.contains("dv-collapsed"), "the plan stays collapsed for the next run");

  // A session change (clear) forgets the preference: a fresh plan auto-decides.
  h.post({ type: "clear" });
  h.post({ type: "plan", entries: [{ content: "Task", status: "pending" }] });
  await h.settle(10);
  plan = widget.querySelector(".plan-docked");
  assert.ok(!plan.classList.contains("dv-collapsed"), "a new session forgets the collapse preference");
  assert.strictEqual(h.errors().length, 0);
});

test("host-initiated openSession opens the session like a click", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    sessions: [{ id: "aaa", short_id: "aaa", title: "Background one", working_directory: "/w" }],
    activeId: null,
    statuses: { aaa: "attention" }
  });
  await h.settle(10);
  h.post({ type: "body", body: "thread" });
  h.post({ type: "openSession", id: "aaa" });
  await h.settle(10);

  // An attention (alive, no cached view yet) session opens via a full load.
  assert.ok(h.posted.some((m) => m.type === "loadSession" && m.id === "aaa"), "opens the session");
  assert.strictEqual(h.errors().length, 0);
});

test("a re-posted question replaces the open one instead of stacking", async () => {
  // The host re-posts every outstanding request whenever a session is reopened,
  // so going back and forth used to leave one copy of the same question per
  // visit, until they covered the whole transcript.
  const h = createHarness();
  const question = {
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "Which branch?",
    schema: {
      type: "object",
      required: ["q0"],
      properties: {
        q0: { type: "string", title: "Branch", description: "Branch", oneOf: [{ const: "main", title: "main" }] }
      }
    }
  };
  const tray = () => h.document.getElementById("elicitation-tray");
  const sessions = (activeId) => ({
    type: "sessions",
    activeId,
    statuses: { A: "attention", B: "idle" },
    folders: [{ path: "/w", name: "w" }],
    sessions: [
      { id: "A", short_id: "A", title: "A", working_directory: "/w" },
      { id: "B", short_id: "B", title: "B", working_directory: "/w" }
    ]
  });
  const rowFor = (title) =>
    [...h.document.querySelectorAll("#sessions-list .session-item")]
      .find((r) => r.textContent.includes(title))
      .querySelector(".session-main");

  // Open B first so it has a cached transcript, then A, which asks a question.
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "sessionReady", sessionId: "B" });
  h.post({ type: "userChunk", text: "hello from B" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "body", body: "list" });
  h.post(sessions(null));
  await h.settle(20);
  rowFor("A").click();
  await h.settle(10);
  h.post({ type: "clear", loading: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userChunk", text: "hello from A" });
  h.post({ type: "loaded" });
  h.post(question);
  h.post(sessions("A"));
  await h.settle(20);
  assert.strictEqual(tray().querySelectorAll(".qc").length, 1, "A shows its question");

  // Switch to B: the question belongs to A, so it must not hang over B's thread.
  h.document.getElementById("history-btn").click();
  h.post(sessions(null));
  await h.settle(10);
  rowFor("B").click();
  await h.settle(10);
  assert.strictEqual(tray().querySelectorAll(".qc").length, 0, "B does not show A's question");

  // Go back to A twice; the host re-posts the same still-pending request each
  // time and it must never stack.
  for (let i = 0; i < 2; i++) {
    h.document.getElementById("history-btn").click();
    h.post(sessions(null));
    await h.settle(10);
    rowFor("A").click();
    h.post(question);
    await h.settle(10);
    assert.strictEqual(tray().querySelectorAll(".qc").length, 1, "only ever one copy of the question");
    h.document.getElementById("history-btn").click();
    h.post(sessions(null));
    await h.settle(10);
    rowFor("B").click();
    await h.settle(10);
  }
  assert.strictEqual(h.errors().length, 0, "switching threw: " + JSON.stringify(h.errors()));
});

test("a re-posted permission replaces the open one instead of stacking", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  const perm = {
    type: "permission",
    requestId: "p1",
    title: "Devin wants to run: `git push`",
    options: [{ optionId: "allow", name: "Allow", kind: "allow" }, { optionId: "reject", name: "Reject", kind: "reject" }]
  };
  h.post(perm);
  h.post(perm);
  h.post(perm);
  await h.settle(10);
  assert.strictEqual(
    h.document.getElementById("permission-tray").querySelectorAll(".cw").length,
    1,
    "the same permission request renders once"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a replayed message renders its text as soon as it arrives", async () => {
  // On a session load a whole message arrives as one chunk. Waiting for the next
  // frame to render it left an empty bubble between the tool cards, so the
  // transcript came back as tool calls separated by blank gaps.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "userChunk", text: "the original question" });
  h.post({ type: "assistantChunk", text: "the first answer" });
  h.post({ type: "toolCall", id: "t1", title: "Read src/a.ts", kind: "read", status: "completed" });
  h.post({ type: "assistantChunk", text: "the second answer" });

  // No settle: nothing has had a chance to run on a later frame yet.
  assert.deepStrictEqual(h.respTexts(), ["the first answer", "the second answer"]);
  h.post({ type: "loaded" });
  await h.settle(20);
  assert.deepStrictEqual(h.respTexts(), ["the first answer", "the second answer"]);
  assert.strictEqual(h.errors().length, 0);
});

test("the sessions switcher offers the same New Session split button", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessions", sessions: [], activeId: null, statuses: {} });
  await h.settle(10);

  // Narrow surfaces (and jsdom, which has no layout) open the switcher menu
  // rather than the docked panel; both mount the same list controls.
  h.document.getElementById("panel-toggle").click();
  await h.settle(10);
  const split = h.document.querySelector("#title-menu .session-toolbar .new-session-split");
  assert.ok(split, "the switcher toolbar has the split control");
  split.querySelector(".new-session-btn").click();
  await h.settle(5);
  assert.ok(
    h.posted.some((m) => m.type === "newSessionAt" && m.target === "view"),
    "the icon half starts a session here"
  );
  assert.ok(!h.document.querySelector(".dv-menu"), "no menu is opened by the icon half");
  split.querySelector(".new-session-more").click();
  await h.settle(10);
  assert.deepStrictEqual(
    [...h.document.querySelectorAll(".dv-menu .dv-menu-item span")].map((s) => s.textContent),
    ["New Session (Editor)", "New Session (Window)", "New Devin CLI Session (Terminal)"],
    "the menu offers the other places, not the one the button already does"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a replayed thought is labelled without a made up duration", async () => {
  // Nothing records how long Devin thought for, so a reloaded transcript used to
  // time the replay itself and claim "Thought for 1s" for every block.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "userChunk", text: "a question" });
  h.post({ type: "thoughtChunk", text: "old reasoning", replayed: true, at: "2026-08-05T16:21:07.110866+00:00" });
  h.post({ type: "assistantChunk", text: "an answer" });
  h.post({ type: "loaded" });
  await h.settle(20);
  const replayedLabel = h.document.querySelector(".thinking-label");
  assert.strictEqual(replayedLabel.textContent, "Thought");
  // The CLI does record when it happened, so that is offered on hover instead.
  assert.match(replayedLabel.title, /^Thought at \d/, "the original time is shown on hover");

  // A live turn still reports how long it took.
  h.post({ type: "assistantStart" });
  h.post({ type: "thoughtChunk", text: "live reasoning" });
  await h.settle(20);
  const live = [...h.document.querySelectorAll(".thinking-label")].pop();
  assert.match(live.textContent, /^Thinking/, "a live thought is timed while it streams");
  h.post({ type: "assistantEnd" });
  await h.settle(10);
  assert.match(live.textContent, /^Thought for \d+s$/, "and keeps its duration once settled");
  assert.strictEqual(h.errors().length, 0);
});

test("Enter steps through the questions and submits the last one", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "Two questions",
    allowOther: true,
    schema: {
      type: "object",
      required: ["q0", "q1"],
      properties: {
        q0: { type: "string", title: "First", description: "First", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
        q1: { type: "string", title: "Second", description: "Second", oneOf: [{ const: "c", title: "C" }] }
      }
    }
  });
  await h.settle(20);
  const qc = h.document.querySelector(".qc");
  const step = qc.querySelector(".qc-step");
  const enter = (target, init) =>
    target.dispatchEvent(new h.window.KeyboardEvent("keydown", Object.assign({ key: "Enter", bubbles: true, cancelable: true }, init)));
  const fields = [...qc.querySelectorAll(".elicit-field")];

  // Answer the first question, then Enter moves on rather than submitting.
  fields[0].querySelectorAll(".elicit-native")[0].click();
  await h.settle(5);
  assert.strictEqual(step.textContent, "1 / 2");
  enter(qc);
  await h.settle(5);
  assert.strictEqual(step.textContent, "2 / 2", "Enter advances to the next question");
  assert.ok(!h.posted.some((m) => m.type === "elicitationResponse"), "and does not submit early");

  // Enter on the last question submits, once it has an answer.
  enter(qc);
  await h.settle(5);
  assert.ok(!h.posted.some((m) => m.type === "elicitationResponse"), "an unanswered last question is not submitted");
  fields[1].querySelectorAll(".elicit-native")[0].click();
  await h.settle(5);
  enter(qc);
  await h.settle(10);
  const res = h.posted.find((m) => m.type === "elicitationResponse");
  assert.deepStrictEqual(res && res.content, { q0: "a", q1: "c" }, "Enter on the last question submits every answer");
  assert.strictEqual(h.errors().length, 0);
});

test("Shift+Enter and Ctrl+Enter write a newline in an Other answer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "One question",
    allowOther: true,
    schema: {
      type: "object",
      required: ["q0"],
      properties: { q0: { type: "string", title: "Pick", description: "Pick", oneOf: [{ const: "a", title: "A" }] } }
    }
  });
  await h.settle(20);
  const other = h.document.querySelector(".elicit-other");
  other.value = "line one";
  other.selectionStart = other.selectionEnd = other.value.length;
  const enter = (init) =>
    other.dispatchEvent(new h.window.KeyboardEvent("keydown", Object.assign({ key: "Enter", bubbles: true, cancelable: true }, init)));

  // Shift+Enter is the browser's own newline, so the widget must leave it alone.
  const shift = enter({ shiftKey: true });
  assert.strictEqual(shift, true, "Shift+Enter is not intercepted");
  assert.ok(!h.posted.some((m) => m.type === "elicitationResponse"));

  // Ctrl+Enter writes the newline itself (the browser does not).
  enter({ ctrlKey: true });
  await h.settle(5);
  assert.strictEqual(other.value, "line one\n");
  assert.ok(!h.posted.some((m) => m.type === "elicitationResponse"), "Ctrl+Enter never submits");
  assert.strictEqual(h.errors().length, 0);
});

test("switching sessions keeps each one's plan and changed files", async () => {
  const h = createHarness();
  const sessions = (activeId) => ({
    type: "sessions",
    activeId,
    statuses: { A: "idle", B: "idle" },
    folders: [{ path: "/w", name: "w" }],
    sessions: [
      { id: "A", short_id: "A", title: "A", working_directory: "/w" },
      { id: "B", short_id: "B", title: "B", working_directory: "/w" }
    ]
  });
  const rowFor = (title) =>
    [...h.document.querySelectorAll("#sessions-list .session-item")]
      .find((r) => r.textContent.includes(title))
      .querySelector(".session-main");
  const planRows = () => [...h.document.querySelectorAll("#todo-widget .plan-entry")].map((r) => r.textContent.trim());
  const wsRows = () => [...h.document.querySelectorAll("#working-set .file-pill-name")].map((r) => r.textContent.trim());

  // A is working through a plan and has changed a file.
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, showFileChanges: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "do the work" });
  h.post({ type: "assistantStart" });
  h.post({ type: "plan", entries: [{ content: "step one", status: "completed" }, { content: "step two", status: "in_progress" }] });
  h.post({ type: "fileChange", path: "/w/a.ts", added: 3, removed: 1 });
  h.post({ type: "workingSet", files: [{ path: "/w/a.ts", name: "a.ts" }] });
  h.post(sessions("A"));
  await h.settle(20);
  assert.deepStrictEqual(planRows(), ["step one", "step two"]);
  assert.deepStrictEqual(wsRows(), ["a.ts"]);

  // Leave for the list and open B, which has neither.
  h.document.getElementById("history-btn").click();
  h.post(sessions(null));
  await h.settle(10);
  rowFor("B").click();
  h.post({ type: "clear", loading: true });
  h.post({ type: "sessionReady", sessionId: "B" });
  h.post({ type: "userChunk", text: "hello from B" });
  h.post({ type: "loaded" });
  h.post({ type: "workingSet", files: [] });
  await h.settle(20);
  assert.deepStrictEqual(planRows(), [], "B does not inherit A's plan");
  assert.deepStrictEqual(wsRows(), [], "nor A's changed files");

  // Back to A: both come back, once each. A's turn is still running, so the list
  // reports it as such and its retained transcript re-attaches rather than reloads.
  h.document.getElementById("history-btn").click();
  h.post(sessions(null));
  h.post({ type: "sessionStatuses", statuses: { A: "running", B: "idle" }, activeId: null });
  await h.settle(10);
  rowFor("A").click();
  h.post({ type: "workingSet", files: [{ path: "/w/a.ts", name: "a.ts" }] });
  await h.settle(20);
  assert.deepStrictEqual(planRows(), ["step one", "step two"], "A's plan is restored");
  assert.deepStrictEqual(wsRows(), ["a.ts"], "A's changed files are restored, not doubled");
  assert.strictEqual(
    h.document.querySelectorAll("#todo-widget .plan-docked").length,
    1,
    "one docked plan widget, not one per visit"
  );
  assert.match(
    h.document.querySelector("#working-set .file-change").textContent,
    /\+3/,
    "the line counts come back with the files"
  );
  assert.strictEqual(h.errors().length, 0, "switching threw: " + JSON.stringify(h.errors()));
});

test("the sessions panel side follows the setting, and moves the toggle with it", async () => {
  const h = createHarness();
  const chat = h.document.getElementById("chat");
  // jsdom reports no layout, so say how wide the chat area is: wide enough for a
  // docked panel to begin with.
  let width = 1000;
  Object.defineProperty(chat, "clientWidth", { get: () => width, configurable: true });

  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, panelSide: "right" });
  await h.settle(10);
  const icon = () => h.document.querySelector("#panel-toggle .codicon").className;
  assert.strictEqual(chat.dataset.panelSide, "right", "the layout is driven from one attribute");
  assert.match(icon(), /layout-sidebar-right/, "the toggle points at the side it opens on");

  h.post({ type: "capabilities", revert: true, panelSide: "left" });
  await h.settle(10);
  assert.strictEqual(chat.dataset.panelSide, "left");
  assert.match(icon(), /layout-sidebar-left/);

  // Too narrow for a docked panel: the same button becomes the session switcher,
  // whichever side it sits on.
  width = 420;
  h.post({ type: "capabilities", revert: true, panelSide: "right" });
  await h.settle(10);
  assert.match(icon(), /list-tree/, "no room for a docked panel means the switcher");
  assert.strictEqual(h.document.getElementById("panel-toggle").title, "Switch session");
  assert.strictEqual(h.errors().length, 0);
});

test("dragging the panel header to the other half moves and remembers the side", async () => {
  const h = createHarness();
  const chat = h.document.getElementById("chat");
  // Wide enough for the docked panel, with a box so the drag knows its midpoint.
  Object.defineProperty(chat, "clientWidth", { value: 1000, configurable: true });
  chat.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });

  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, panelSide: "right" });
  h.post({ type: "sessions", sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }], activeId: "A", statuses: { A: "idle" } });
  await h.settle(10);
  h.document.getElementById("panel-toggle").click();
  await h.settle(10);

  const toolbar = h.document.querySelector("#sessions-panel .session-toolbar");
  assert.ok(toolbar, "the docked panel is mounted");
  assert.ok(toolbar.classList.contains("session-toolbar-movable"), "and its header is the grab handle");

  const down = (x) => toolbar.dispatchEvent(new h.window.MouseEvent("mousedown", { clientX: x, clientY: 20, bubbles: true, button: 0 }));
  // The drag is tracked on the document, so that is where the rest is dispatched.
  const at = (type, x) => h.document.dispatchEvent(new h.window.MouseEvent(type, { clientX: x, clientY: 20, bubbles: true, button: 0 }));

  // A press with no movement is a click, not a move: the side must not change.
  down(800);
  at("mouseup", 800);
  await h.settle(5);
  assert.strictEqual(chat.dataset.panelSide, "right", "a click does not move the panel");
  assert.ok(!h.posted.some((m) => m.type === "setConfig"), "and nothing is written to settings");

  // Drag past the midpoint: the target edge is marked, then committed on release.
  down(800);
  at("mousemove", 700);
  at("mousemove", 200);
  assert.strictEqual(chat.dataset.dropSide, "left", "the edge it would land on is highlighted");
  assert.ok(h.document.body.classList.contains("dv-panel-dragging"), "and the pointer shows a drag");
  at("mouseup", 200);
  await h.settle(10);

  assert.strictEqual(chat.dataset.panelSide, "left", "the panel moves on release");
  assert.strictEqual(chat.dataset.dropSide, undefined, "the drop marker is cleared");
  assert.ok(!h.document.body.classList.contains("dv-panel-dragging"));
  assert.ok(
    h.posted.some((m) => m.type === "setConfig" && m.key === "sessionsPanel.side" && m.value === "left"),
    "and the choice is remembered in settings"
  );

  // Dragging back to the same side it is already on is a no-op.
  const writes = h.posted.filter((m) => m.type === "setConfig").length;
  down(200);
  at("mousemove", 100);
  assert.strictEqual(chat.dataset.dropSide, undefined, "no marker at all when it would not move");
  at("mouseup", 100);
  await h.settle(5);
  assert.strictEqual(h.posted.filter((m) => m.type === "setConfig").length, writes, "and nothing is rewritten");
  assert.strictEqual(h.errors().length, 0);
});

test("unsent text is saved as a draft and restored from the host", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  await h.settle(10);
  const input = h.document.getElementById("input");

  // Typing is saved against the session, debounced.
  input.value = "half a prompt";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(600);
  const saved = h.posted.filter((m) => m.type === "draft");
  assert.deepStrictEqual(saved[saved.length - 1], { type: "draft", id: "A", text: "half a prompt" });

  // Leaving flushes immediately, without waiting for the debounce.
  input.value = "half a prompt, plus more";
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  const onLeave = h.posted.filter((m) => m.type === "draft").pop();
  assert.deepStrictEqual(onLeave, { type: "draft", id: "A", text: "half a prompt, plus more" });
  assert.strictEqual(input.value, "", "the list gets a clean new chat box");

  // The host puts a stored draft back into an empty composer.
  h.post({ type: "draft", id: null, text: "a new chat I started earlier" });
  await h.settle(10);
  assert.strictEqual(input.value, "a new chat I started earlier");

  // A draft for a session we are no longer in is ignored.
  h.post({ type: "draft", id: "B", text: "belongs to another session" });
  await h.settle(10);
  assert.strictEqual(input.value, "a new chat I started earlier");
  assert.strictEqual(h.errors().length, 0);
});

test("a restored transcript keeps its own fresher draft over the stored one", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "hello" });
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  const input = h.document.getElementById("input");
  input.value = "the freshest text";
  h.document.getElementById("history-btn").click();
  h.post({
    type: "sessions",
    sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }],
    activeId: null,
    statuses: { A: "idle" }
  });
  await h.settle(10);
  h.document.querySelector("#sessions-list .session-main").click();
  await h.settle(10);
  assert.strictEqual(input.value, "the freshest text", "the retained transcript brings its draft back");

  // The host's copy lands late and must not overwrite it.
  h.post({ type: "draft", id: "A", text: "an older copy" });
  await h.settle(10);
  assert.strictEqual(input.value, "the freshest text");
  assert.strictEqual(h.errors().length, 0);
});

test("sending clears the draft, and editing a queued message gives it back", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "q1", text: "queued message" }] });
  await h.settle(10);
  const input = h.document.getElementById("input");

  input.value = "my draft";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(600);

  // Editing a queued message borrows the composer; the draft must not be
  // overwritten while it does, and comes back when the edit ends.
  const row = h.document.querySelector("#thread .queued-item");
  assert.ok(row, "the queued row renders");
  const before = h.posted.filter((m) => m.type === "draft").length;
  const editBtn = [...row.querySelectorAll(".queued-actions button")].find((b) => /edit/i.test(b.title || ""));
  assert.ok(editBtn, "the queued row offers an edit action");
  editBtn.click();
  await h.settle(10);
  assert.strictEqual(input.value, "queued message", "the composer shows the queued text");
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(600);
  assert.strictEqual(
    h.posted.filter((m) => m.type === "draft").length,
    before,
    "an edit in progress is never stored as the draft"
  );

  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await h.settle(10);
  assert.strictEqual(input.value, "my draft", "cancelling the edit hands the draft back");
  assert.strictEqual(h.errors().length, 0);
});

test("answers given before leaving a session come back with the question", async () => {
  const h = createHarness();
  const question = (answers) => ({
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "Two questions",
    allowOther: true,
    answers,
    schema: {
      type: "object",
      required: ["q0", "q1"],
      properties: {
        q0: { type: "string", title: "First", description: "First", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
        q1: { type: "string", title: "Second", description: "Second", oneOf: [{ const: "c", title: "C" }] }
      }
    }
  });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post(question());
  await h.settle(20);

  // Answer the first question and half type an Other answer on the second.
  const fields = () => [...h.document.querySelectorAll(".qc .elicit-field")];
  fields()[0].querySelectorAll(".elicit-native")[0].click();
  h.document.querySelector(".qc").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);
  assert.strictEqual(h.document.querySelector(".qc .qc-step").textContent, "2 / 2");
  const other = fields()[1].querySelector(".elicit-other");
  other.value = "something of my own";
  other.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(400);

  const state = h.posted.filter((m) => m.type === "answerDraft").pop();
  assert.ok(state, "the answers so far are sent to the host");
  assert.deepStrictEqual(state.state.by.q0.picked, ["a"], "the chosen option is recorded");
  assert.strictEqual(state.state.by.q1.other, "something of my own", "so is the free text");

  // Leaving flushes, and the host re-posts the question with those answers.
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll(".qc").length, 0, "the widget goes with the session");
  const flushed = h.posted.filter((m) => m.type === "answerDraft").pop();
  h.post({ type: "body", body: "thread" });
  h.post(question(flushed.state));
  await h.settle(20);

  assert.strictEqual(h.document.querySelectorAll(".qc").length, 1);
  assert.strictEqual(
    fields()[0].querySelectorAll(".elicit-native")[0].checked,
    true,
    "the option chosen before is still chosen"
  );
  assert.strictEqual(
    fields()[1].querySelector(".elicit-other").value,
    "something of my own",
    "and the half typed answer is still there"
  );
  assert.strictEqual(h.document.querySelector(".qc .qc-step").textContent, "2 / 2", "reopening on the question we were on");
  assert.strictEqual(h.errors().length, 0);
});

test("the header offers detach in the panel and attach in an editor tab", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, surface: "view", panelSide: "right" });
  h.post({ type: "sessionStatuses", statuses: { A: "idle" }, activeId: "A" });
  await h.settle(10);
  const btn = h.document.getElementById("detach-btn");
  const header = [...h.document.getElementById("chat-header").children].map((c) => c.id);

  assert.ok(!btn.classList.contains("hidden"), "the control shows inside a session");
  // Moving the chat reads before stopping it, so terminate stays at the far end.
  assert.ok(header.indexOf("detach-btn") < header.indexOf("terminate-btn"), "it sits beside terminate, on its left");
  assert.match(btn.querySelector(".codicon").className, /link-external/);
  assert.strictEqual(btn.title, "Open this chat in an editor tab");
  btn.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "detachSession" && m.id === "A"), "the panel asks to detach");

  // No session, no control.
  h.document.getElementById("history-btn").click();
  await h.settle(10);
  assert.ok(btn.classList.contains("hidden"), "the list has nothing to move");
  assert.strictEqual(h.errors().length, 0);
});

test("an editor tab is one chat: no list, no back, no terminate", async () => {
  const h = createHarness({ surface: "editor" });
  h.post({ type: "ready" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A", title: "Detached chat" });
  h.post({ type: "capabilities", revert: true, surface: "editor", panelSide: "left" });
  h.post({ type: "sessionStatuses", statuses: { A: "running" }, activeId: "A" });
  await h.settle(10);

  const shown = (id) => !h.document.getElementById(id).classList.contains("hidden");
  assert.ok(!shown("history-btn"), "no way back to a list it does not have");
  assert.ok(!shown("panel-toggle"), "and no sessions panel");
  assert.ok(!shown("terminate-btn"), "closing the tab is what stops the chat");
  assert.ok(!shown("header-divider"), "the divider has nothing left to divide");
  assert.ok(shown("detach-btn"), "moving it back to the side panel is the one control");
  assert.strictEqual(h.document.getElementById("detach-btn").title, "Move this chat to the side panel");
  assert.match(
    h.document.getElementById("detach-btn").querySelector(".codicon").className,
    /layout-sidebar-right-dock/,
    "the return icon points to the right sidebar"
  );
  assert.ok(h.document.getElementById("title-btn").classList.contains("as-heading"), "the title is a name, not a control");
  h.document.getElementById("title-btn").click();
  await h.settle(5);
  assert.ok(!h.posted.some((m) => m.type === "renameSession"), "the tab renames from its own context menu");

  // Which chat the tab holds is remembered, so a window reload restores it.
  assert.strictEqual(h.state().sessionId, "A");

  // Even asked to, it never falls back to a session list.
  h.post({ type: "body", body: "list" });
  await h.settle(10);
  assert.ok(h.document.getElementById("sessions-list").classList.contains("hidden"), "it stays on its chat");
  assert.strictEqual(h.errors().length, 0);
});

test("a chat open on the other surface says so instead of showing a stale copy", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    activeId: null,
    statuses: { B: "running" },
    elsewhere: ["B"],
    sessions: [{ id: "B", short_id: "B", title: "In a tab", working_directory: "/w" }]
  });
  await h.settle(10);
  // The row is honest about it before it is even clicked.
  const row = h.document.querySelector("#sessions-list .session-item");
  assert.ok(row.querySelector(".session-dot").className.includes("dot-running"), "it shows the editor tab's real status");
  assert.strictEqual(row.querySelector(".session-elsewhere").title, "Open in an editor tab");
  assert.ok(!row.querySelector(".kill-glyph"), "only the surface that owns the session can terminate it");

  row.querySelector(".session-main").click();
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "loadSession" && m.id === "B"), "the host still gets the final say");
  h.post({ type: "elsewhere", id: "B", where: "an editor tab", here: "the side panel", title: "In a tab" });
  await h.settle(10);

  assert.match(h.thread().querySelector(".welcome-title").textContent, /open in an editor tab/);
  assert.ok(h.document.getElementById("composer").classList.contains("hidden"), "and cannot be typed into");
  const actions = [...h.thread().querySelectorAll(".welcome-actions .btn")];
  assert.deepStrictEqual(actions.map((b) => b.textContent), [
    "Continue in the side panel",
    "Show it in an editor tab"
  ]);
  actions[0].click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "moveHere" && m.id === "B"), "the first brings it here, agent and all");
  actions[1].click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "revealSession" && m.id === "B"), "the second goes to it");

  // Once it is actually loaded here, the placeholder and the lock go.
  h.post({ type: "clear", loading: true });
  h.post({ type: "sessionReady", sessionId: "B", title: "In a tab" });
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.ok(!h.document.getElementById("composer").classList.contains("hidden"));
  assert.strictEqual(h.errors().length, 0);
});

test("a chat leaving a surface writes back its draft and its half given answers", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({
    type: "elicitation",
    requestId: "r1",
    questions: [{ id: "q1", question: "Which one?", options: [{ id: "o1", label: "First" }] }]
  });
  await h.settle(10);
  const input = h.document.getElementById("input");
  input.value = "half written prompt";
  input.dispatchEvent(new h.window.Event("input"));
  const opt = h.document.querySelector(".qc .elicit-native");
  if (opt) { opt.checked = true; opt.dispatchEvent(new h.window.Event("change", { bubbles: true })); }

  // The handover is instant, so the host asks for both before the chat leaves and
  // waits for the reply: a debounce would lose them.
  h.posted.length = 0;
  h.post({ type: "flushState" });
  await h.settle(5);

  const draft = h.posted.find((m) => m.type === "draft");
  assert.ok(draft && draft.text === "half written prompt", "the prompt goes back with its session");
  assert.ok(h.posted.some((m) => m.type === "answerDraft" && m.requestId === "r1"), "so do the answers so far");
  const order = h.posted.map((m) => m.type);
  assert.ok(
    order.indexOf("stateFlushed") === order.length - 1,
    "and the all clear comes last, so nothing is still in flight"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a flush during a borrowed queue edit releases the hold without committing it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", steering: true, sendWhileWorking: "steer" });
  h.post({ type: "busy", value: true });
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "queued words" }] });
  await h.settle(10);

  h.thread().querySelector('.queued-item[data-id="q1"] .codicon-edit').parentElement.click();
  await h.settle(10);
  const input = h.document.getElementById("input");
  assert.strictEqual(input.value, "queued words", "the composer borrowed the row");

  h.posted.length = 0;
  h.post({ type: "flushState" });
  await h.settle(5);

  const order = h.posted.map((m) => m.type);
  const release = h.posted.findIndex((m) => m.type === "queueEditing" && m.id === null);
  assert.ok(release !== -1 && release < order.indexOf("stateFlushed"),
    "the borrowed edit is released before the flush completes");
  assert.ok(order.indexOf("stateFlushed") === order.length - 1, "and the all clear is still last");
  assert.ok(!h.posted.some((m) => ["editQueued", "send", "sendQueuedNow", "stopAndSend", "removeQueued"].includes(m.type)),
    "the move committed nothing");

  // Back on this surface the row is still the one that was queued, unedited.
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "queued words" }] });
  await h.settle(10);
  const row = h.thread().querySelector('.queued-item[data-id="q1"]');
  assert.ok(row, "the queued row is still there");
  assert.ok(row.textContent.includes("queued words"), "with its original text");
  assert.ok(!h.document.getElementById("input-editing-banner"), "and no edit is still open");
  assert.strictEqual(h.errors().length, 0);
});

test("a chat whose agent stopped says so in a tab, and can be started again", async () => {
  const h = createHarness({ surface: "editor" });
  h.post({ type: "ready" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", surface: "editor" });
  h.post({ type: "sessionReady", sessionId: "A", title: "Stopped chat" });
  h.post({ type: "userChunk", text: "still here" });
  h.post({ type: "loaded" });
  h.post({ type: "sessionEnded" });
  await h.settle(10);

  const row = h.thread().querySelector(".ended-row");
  assert.ok(row, "the tab has no list to say it in, so the chat says it");
  assert.match(row.textContent, /Send a message to start it again/);
  assert.deepStrictEqual(h.reqTexts(), ["still here"], "the conversation is left alone");

  // Said once, not once per exit event.
  h.post({ type: "sessionEnded" });
  await h.settle(10);
  assert.strictEqual(h.thread().querySelectorAll(".ended-row").length, 1);
  assert.strictEqual(h.errors().length, 0);
});

test("a session running on another surface is marked in the list", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({
    type: "sessions",
    activeId: null,
    statuses: { A: "idle", B: "running" },
    elsewhere: ["B"],
    sessions: [
      { id: "A", short_id: "A", title: "Here", working_directory: "/w" },
      { id: "B", short_id: "B", title: "In a tab", working_directory: "/w" }
    ]
  });
  await h.settle(10);
  const rows = [...h.document.querySelectorAll("#sessions-list .session-item")];
  const badged = rows.filter((r) => r.querySelector(".session-elsewhere")).map((r) => r.textContent);
  assert.strictEqual(badged.length, 1, "only the one held elsewhere is marked");
  assert.match(badged[0], /In a tab/);

  // The marker follows a status tick, without a full list refresh.
  h.post({ type: "sessionStatuses", statuses: { A: "idle", B: "running" }, activeId: null, elsewhere: [] });
  await h.settle(10);
  assert.strictEqual(
    h.document.querySelectorAll("#sessions-list .session-elsewhere").length,
    0,
    "and clears when the session comes back"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a chat moved from another surface arrives with nothing said about it", async () => {
  // Moving a chat is not an event in the conversation, so the transcript carries
  // no note about it: it just carries on where it left off.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userChunk", text: "carried over" });
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["carried over"], "the transcript it was handed is intact");
  assert.strictEqual(h.thread().querySelectorAll(".restored-row").length, 0, "and nothing is announced");
  assert.strictEqual(h.errors().length, 0);
});

test("a chat being handed to a new surface is not sent back to the list", async () => {
  // A freshly created surface announces its readiness twice while the chat it is
  // being handed paints into it. That used to land mid load, before the session id
  // arrived, and reset the panel to its session list: the detached tab opened on
  // the list and the chat had to be clicked again.
  const h = createHarness();
  h.post({ type: "ready" });
  await h.settle(5);
  assert.ok(!h.document.getElementById("sessions-list").classList.contains("hidden"), "a new surface starts on the list");

  // The host starts handing over a chat.
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true, waking: false });
  h.post({ type: "capabilities", revert: true, surface: "editor" });
  h.post({ type: "userChunk", text: "the chat that was handed over" });

  // Its readiness lands mid load, before the session id has arrived.
  h.post({ type: "ready" });
  await h.settle(5);
  assert.ok(h.document.getElementById("sessions-list").classList.contains("hidden"), "the list does not take over");
  assert.ok(!h.thread().classList.contains("hidden"), "the thread stays on screen");

  h.post({ type: "assistantChunk", text: "with its reply" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "loaded" });
  h.post({ type: "body", body: "thread" });
  await h.settle(20);

  assert.deepStrictEqual(h.reqTexts(), ["the chat that was handed over"]);
  assert.deepStrictEqual(h.respTexts(), ["with its reply"]);
  assert.strictEqual(h.errors().length, 0);
});

test("a chat handed to a surface mid turn still knows which session it is", async () => {
  // The busy handover re-points the surface instead of reloading, so the host has
  // to name the session: without it the tab had no session id, which hid the move
  // back and terminate controls and sent its draft to the "new chat" key.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, surface: "editor" });
  h.post({ type: "busy", value: true });
  h.post({ type: "sessionReady", sessionId: "A", title: "A moved chat" });
  h.post({ type: "sessionStatuses", statuses: { A: "running" }, activeId: "A" });
  await h.settle(10);

  assert.strictEqual(h.document.getElementById("chat-title").textContent, "A moved chat", "the header names it");
  const detach = h.document.getElementById("detach-btn");
  assert.ok(!detach.classList.contains("hidden"), "the move back control is offered");
  detach.click();
  await h.settle(5);
  assert.ok(
    h.posted.some((m) => m.type === "attachSession" && m.id === "A"),
    "and it acts on the session that was handed over"
  );

  // Its draft is stored against the chat, not the new chat box.
  const input = h.document.getElementById("input");
  input.value = "typed after the move";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(600);
  assert.deepStrictEqual(h.posted.filter((m) => m.type === "draft").pop(), {
    type: "draft",
    id: "A",
    text: "typed after the move"
  });
  assert.strictEqual(h.errors().length, 0);
});

test("the drop marker only shows when the panel would actually move", async () => {
  const h = createHarness();
  const chat = h.document.getElementById("chat");
  Object.defineProperty(chat, "clientWidth", { value: 1000, configurable: true });
  chat.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, panelSide: "right" });
  h.post({ type: "sessions", sessions: [{ id: "A", short_id: "A", title: "A", working_directory: "/w" }], activeId: "A", statuses: { A: "idle" } });
  await h.settle(10);
  h.document.getElementById("panel-toggle").click();
  await h.settle(10);
  const toolbar = h.document.querySelector("#sessions-panel .session-toolbar");
  const at = (type, x) => h.document.dispatchEvent(new h.window.MouseEvent(type, { clientX: x, clientY: 20, bubbles: true, button: 0 }));

  toolbar.dispatchEvent(new h.window.MouseEvent("mousedown", { clientX: 800, clientY: 20, bubbles: true, button: 0 }));
  at("mousemove", 700);
  // Still in the half it is already docked in: no marker at all, since an empty
  // attribute still matched the selector and drew it on the left edge.
  assert.strictEqual(chat.dataset.dropSide, undefined, "no marker while the drop is a no-op");
  at("mousemove", 200);
  assert.strictEqual(chat.dataset.dropSide, "left", "and the target edge once it would move");

  // Losing the pointer ends the drag without moving anything.
  h.window.dispatchEvent(new h.window.Event("blur"));
  await h.settle(5);
  assert.strictEqual(chat.dataset.dropSide, undefined, "the marker is cleared");
  assert.ok(!h.document.body.classList.contains("dv-panel-dragging"), "and the drag cursor with it");
  at("mouseup", 200);
  await h.settle(5);
  assert.strictEqual(chat.dataset.panelSide, "right", "an interrupted drag never moves the panel");
  assert.ok(!h.posted.some((m) => m.type === "setConfig"), "nor writes a side to settings");
  assert.strictEqual(h.errors().length, 0);
});

test("stepping a question carousel moves focus, so Enter keeps working", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "elicitation",
    requestId: "e1",
    mode: "form",
    message: "Three questions",
    schema: {
      type: "object",
      required: ["q0", "q1", "q2"],
      properties: {
        q0: { type: "string", title: "One", description: "One", oneOf: [{ const: "a", title: "A" }] },
        q1: { type: "string", title: "Two", description: "Two", oneOf: [{ const: "b", title: "B" }] },
        q2: { type: "string", title: "Three", description: "Three", oneOf: [{ const: "c", title: "C" }] }
      }
    }
  });
  await h.settle(20);
  const qc = h.document.querySelector(".qc");
  const fields = [...qc.querySelectorAll(".elicit-field")];
  const step = () => qc.querySelector(".qc-step").textContent;

  // A question arriving must not steal focus from the composer.
  assert.ok(!qc.contains(h.document.activeElement), "the widget does not grab focus on arrival");
  // Once the user is inside it (clicking an option focuses the native radio), Enter
  // is handled on the widget, so focus has to stay inside it as it steps.
  fields[0].querySelector(".elicit-native").focus();
  const enter = () => h.document.activeElement.dispatchEvent(
    new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  );
  enter();
  await h.settle(5);
  assert.strictEqual(step(), "2 / 3");
  assert.ok(fields[1].contains(h.document.activeElement), "focus follows to the question now shown");
  enter();
  await h.settle(5);
  assert.strictEqual(step(), "3 / 3", "so a second Enter still reaches the widget");
  assert.strictEqual(h.errors().length, 0);
});

test("a checkpoint restore keeps the notice that the agent stopped", async () => {
  const h = createHarness({ surface: "editor" });
  h.post({ type: "ready" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", surface: "editor" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userChunk", text: "carried over" });
  h.post({ type: "loaded" });
  h.post({ type: "sessionEnded" });
  await h.settle(10);
  assert.ok(h.thread().querySelector(".ended-row"), "the notice is there");

  h.post({ type: "reverted", head: 3 });
  await h.settle(10);
  assert.ok(h.thread().querySelector(".ended-row"), "and survives a restore, which has its own divider");
  assert.deepStrictEqual(h.reqTexts(), ["carried over"], "and so does the conversation");
  assert.strictEqual(h.errors().length, 0);
});

test("starting a new chat clears the previous chat's thread controls", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "capabilities", revert: true, surface: "view" });
  h.post({ type: "sessionStatuses", statuses: { A: "idle" }, activeId: "A" });
  await h.settle(10);
  assert.ok(!h.document.getElementById("detach-btn").classList.contains("hidden"));

  // A fresh chat has no session yet, so neither control can act.
  h.post({ type: "clear", reset: true });
  await h.settle(10);
  assert.ok(h.document.getElementById("detach-btn").classList.contains("hidden"), "move is withdrawn");
  assert.ok(h.document.getElementById("terminate-btn").classList.contains("hidden"), "terminate is withdrawn");
  assert.strictEqual(h.errors().length, 0);
});

test("sharing is offered only for a chat the agent can share", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "sessionStatuses", statuses: { A: "idle" }, activeId: "A" });
  // An older CLI has no share method, so the button must not be there to press.
  h.post({ type: "capabilities", surface: "view" });
  await h.settle(10);
  const btn = h.document.getElementById("share-btn");
  assert.ok(btn.classList.contains("hidden"), "nothing to press against an agent that cannot share");

  h.post({ type: "capabilities", surface: "view", sessionShare: true });
  await h.settle(10);
  assert.ok(!btn.classList.contains("hidden"), "the agent says it can, so the control appears");
  btn.click();
  await h.settle(5);
  assert.ok(h.posted.some((m) => m.type === "shareSession"), "and it asks the host for a link");

  // The list has no chat to share, so the control goes with the rest of them.
  h.post({ type: "clear", reset: true });
  await h.settle(10);
  assert.ok(btn.classList.contains("hidden"), "and is withdrawn with the other session controls");
  assert.strictEqual(h.errors().length, 0);
});

test("a permission prompt says what it would run", async () => {
  // Devin asks about a command without a title, carrying the command in _meta,
  // so a prompt that only repeats "a tool" cannot be answered.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "permission",
    requestId: "p1",
    title: "Devin wants to run a command",
    command: "pwd && whoami && date",
    toolCallId: "t1",
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  await h.settle(10);
  const box = h.document.querySelector("#permission-tray .cw");
  assert.match(box.querySelector(".cw-title").textContent, /run a command/);
  assert.strictEqual(box.querySelector(".tool-command code").textContent, "pwd && whoami && date",
    "the command it wants to run is shown");
  assert.strictEqual(h.errors().length, 0);
});

test("an edit looks the same however it arrives, and reads as one line", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userChunk", text: "change two files" });
  // A run of tools, with an edit in the middle of it: the edit is its own row, not
  // a tool section inside the group with the file folded away.
  h.post({ type: "toolCall", id: "t1", title: "Read src/a.ts", kind: "read", status: "completed", locations: [{ path: "/w/src/a.ts" }] });
  h.post({ type: "toolCall", id: "t2", title: "Edit src/a.ts", kind: "edit", status: "in_progress", rawInput: { path: "/w/src/a.ts" } });
  h.post({
    type: "toolCall",
    id: "t2",
    status: "completed",
    content: [{ type: "diff", path: "/w/src/a.ts", added: 12, removed: 3 }]
  });
  await h.settle(20);

  const rows = [...h.thread().querySelectorAll(".edit-pill")];
  assert.strictEqual(rows.length, 1, "one row for the file, not one per update");
  assert.match(rows[0].textContent, /Edited/);
  assert.match(rows[0].querySelector(".file-pill-name").textContent, /^a\.ts$/, "named, not a full path");
  assert.match(rows[0].querySelector(".edit-pill-status").className, /codicon-edit/, "the same pencil everywhere");
  assert.strictEqual(rows[0].querySelector(".label-added").textContent, "+12");
  assert.strictEqual(
    [...h.thread().querySelectorAll(".tool .tool-verb")].map((v) => v.textContent).join(","),
    "Read",
    "the edit is not also a tool section"
  );

  // The same edit arriving as a live change event gains Keep and Undo, and stays
  // one row.
  h.post({ type: "fileChange", path: "/w/src/a.ts", added: 12, removed: 3 });
  await h.settle(10);
  const live = [...h.thread().querySelectorAll(".edit-pill")];
  assert.strictEqual(live.length, 1, "still one row");
  assert.strictEqual(live[0].querySelectorAll(".edit-pill-actions button").length, 2, "now it can be kept or undone");

  // A created file says so, with the same pencil.
  h.post({ type: "fileChange", path: "/w/src/new.ts", added: 40, removed: 0, created: true });
  await h.settle(10);
  const created = [...h.thread().querySelectorAll(".edit-pill")].pop();
  assert.match(created.textContent, /Created/);
  assert.match(created.querySelector(".edit-pill-status").className, /codicon-edit/);
  assert.strictEqual(h.errors().length, 0);
});

test("a file the agent read is one line that opens it", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({
    type: "toolCall",
    id: "r1",
    title: "Read /outside/the/workspace/notes.md",
    kind: "read",
    status: "completed",
    locations: [{ path: "/outside/the/workspace/notes.md", line: 12 }],
    content: [{ type: "text", text: "the whole file, which belongs in an editor" }]
  });
  await h.settle(20);

  const tool = h.thread().querySelector(".tool");
  assert.strictEqual(tool.querySelector(".tool-verb").textContent, "Read");
  assert.strictEqual(tool.querySelector(".tool-detail").textContent, " notes.md", "the file, not its path");
  assert.ok(tool.classList.contains("dv-nocollapse"), "there is nothing to expand");
  assert.strictEqual(tool.querySelector(".tool-body").childElementCount, 0, "the file is not dumped in the chat");
  const head = tool.querySelector(".dv-collapsible-header");
  assert.strictEqual(head.title, "/outside/the/workspace/notes.md");
  head.click();
  await h.settle(5);
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "openFile"),
    [{ type: "openFile", path: "/outside/the/workspace/notes.md", line: 12 }],
    "clicking opens the real file, wherever it lives"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a permission prompt with only a tool call names that tool", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "toolCall", id: "t9", status: "in_progress", title: "Edit src/auth/token.ts", kind: "edit" });
  h.post({
    type: "permission",
    requestId: "p2",
    title: "Devin wants to run a tool",
    toolCallId: "t9",
    options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }]
  });
  await h.settle(10);
  const box = h.document.querySelector("#permission-tray .cw");
  assert.strictEqual(box.querySelector(".cw-detail .cw-message").textContent, "Edit src/auth/token.ts",
    "it falls back to the tool line already in the transcript");

  // A file it names is shown as a pill.
  h.post({
    type: "permission",
    requestId: "p3",
    title: "Devin wants to run a tool",
    locations: [{ path: "/w/src/auth/token.ts" }],
    options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }]
  });
  await h.settle(10);
  const p3 = h.document.querySelector('#permission-tray [data-request-id="p3"]');
  const p3File = p3.querySelector(".file-change");
  assert.strictEqual(p3File.querySelector(".file-pill-name").textContent, "token.ts",
    "and names the file it would touch");
  assert.ok(p3File.classList.contains("file-pill"), "normal file references use the shared file pill class");
  assert.ok(p3File.querySelector(".file-pill-icon"), "normal file references use the shared file icon class");
  p3File.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(h.posted.some((m) => m.type === "openFile" && m.path === "/w/src/auth/token.ts"),
    "normal file references open from the keyboard");
  assert.strictEqual(h.errors().length, 0);
});

test("waiting on a subagent reads as agent work, not a tool dump", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "toolCall",
    id: "r1",
    status: "in_progress",
    title: "Checked on subagent",
    kind: "other",
    meta: { inferenceToolName: "read_subagent" },
    rawInput: { agent_id: "78cc5558", block: true, timeout: 600 }
  });
  await h.settle(20);
  const card = [...h.document.querySelectorAll("#thread .tool")].find((t) => /Checked on subagent/.test(t.textContent));
  assert.match(card.querySelector(".tool-kind").className, /codicon-copilot-in-progress/,
    "it is drawn as an agent in progress");
  const pairs = [...card.querySelectorAll(".tool-summary")].map((r) => [
    r.querySelector(".tool-summary-label").textContent,
    r.querySelector(".tool-summary-value").textContent
  ]);
  assert.deepStrictEqual(pairs, [
    ["Agent", "78cc5558"],
    ["Waiting", "until it responds, up to 10 min"]
  ]);
  assert.strictEqual(card.querySelector(".tool-section-title"), null, "and never dumps its arguments");

  h.post({ type: "toolCallUpdate", id: "r1", status: "completed", meta: { inferenceToolName: "read_subagent" } });
  await h.settle(20);
  assert.match(card.querySelector(".tool-kind").className, /codicon-copilot-success/,
    "and becomes a tick when the agent reports back");
  assert.strictEqual(h.errors().length, 0);
});

test("a reasoning block leads with the thinking glyph", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "assistantStart" });
  h.post({ type: "thoughtChunk", text: "Weighing two options", mid: "m1" });
  await h.settle(10);
  const header = h.thread().querySelector(".thinking > .dv-collapsible-header");
  assert.ok(header.querySelector(".thinking-glyph.codicon-thinking"), "the glyph is there");
  assert.ok(
    [...header.children].indexOf(header.querySelector(".thinking-glyph")) <
      [...header.children].indexOf(header.querySelector(".thinking-label")),
    "before the label"
  );
  h.post({ type: "assistantEnd" });
  await h.settle(10);
  assert.strictEqual(h.errors().length, 0);
});

test("the header no longer narrates the running tool", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "toolCall", id: "t1", status: "in_progress", title: "Ran npm test", kind: "execute" });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("status"), null, "the widget is gone");
  assert.strictEqual(h.document.getElementById("chat-title").textContent, "Chat", "and the title is left alone");
  assert.strictEqual(h.errors().length, 0);
});

test("a chat never opens holding text typed somewhere else", async () => {
  // A surface fills its new chat box before it is handed a session, so the
  // composer could open a moved chat with the sessions list's unsent text in it.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "draft", id: null, text: "half typed in the new chat box" });
  await h.settle(10);
  const input = h.document.getElementById("input");
  assert.strictEqual(input.value, "half typed in the new chat box");

  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "draft", id: "A", text: "this chat's own prompt" });
  await h.settle(10);
  assert.strictEqual(input.value, "this chat's own prompt", "the chat's own draft wins");

  // Text the user has actually typed into this chat is never replaced.
  input.value = "mine, typed here";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(500);
  h.post({ type: "draft", id: "A", text: "a stale copy from the host" });
  await h.settle(10);
  assert.strictEqual(input.value, "mine, typed here");
  assert.strictEqual(h.errors().length, 0);
});

test("the header divider never stands on its own", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "capabilities", revert: true, panelSide: "right", surface: "view" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "sessionStatuses", statuses: { A: "idle" }, activeId: "A" });
  await h.settle(10);
  const divider = h.document.getElementById("header-divider");
  assert.ok(!divider.classList.contains("hidden"), "it separates the controls from the toggle");

  // A chat with nothing to terminate or move leaves nothing to separate.
  h.post({ type: "clear", reset: true });
  await h.settle(10);
  assert.ok(divider.classList.contains("hidden"), "so it goes");

  // On the left the toggle leads the header, so the divider always belongs.
  h.post({ type: "capabilities", revert: true, panelSide: "left", surface: "view" });
  await h.settle(10);
  assert.ok(!divider.classList.contains("hidden"));
  assert.strictEqual(h.errors().length, 0);
});

test("Enter answers the option it is on before moving to the next question", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "elicitation",
    requestId: "e2",
    mode: "form",
    message: "Two questions",
    schema: {
      type: "object",
      required: ["q0", "q1"],
      properties: {
        q0: { type: "string", title: "One", description: "One", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
        q1: { type: "string", title: "Two", description: "Two", oneOf: [{ const: "c", title: "C" }] }
      }
    }
  });
  await h.settle(20);
  const qc = h.document.querySelector(".qc");
  const first = qc.querySelector(".elicit-field .elicit-native");
  first.focus();
  first.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);
  assert.ok(first.checked, "the focused option is answered, not skipped");
  assert.strictEqual(qc.querySelector(".qc-step").textContent, "2 / 2", "and it still moves on");
  assert.strictEqual(h.errors().length, 0);
});



// --- Announcements ---------------------------------------------------------
// Everything here happens without the user looking at the panel, and the
// transcript fills in silently, so without an announcement a screen reader user
// gets no signal that Devin started, finished, or is blocked waiting on them.

test("the panel says out loud when a turn starts, ends, and is stopped", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const said = () => h.document.querySelector("#announcer").textContent.replace(/\u200b/g, "");

  h.post({ type: "userChunk", text: "hi" });
  h.post({ type: "assistantStart" });
  await h.settle(10);
  assert.match(said(), /working/i);

  h.post({ type: "assistantEnd", stopReason: "end_turn" });
  await h.settle(10);
  assert.match(said(), /finished/i);

  h.post({ type: "assistantStart" });
  h.post({ type: "assistantEnd", stopReason: "cancelled" });
  await h.settle(10);
  assert.match(said(), /stopped/i, "a stop that landed is the one thing a user is waiting to hear");
  assert.strictEqual(h.errors().length, 0);
});

test("a request for a decision is announced and marked as a dialog", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "userChunk", text: "tidy up" });
  h.post({
    type: "permission",
    requestId: "p1",
    command: "rm -rf build",
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  await h.settle(20);
  const said = h.document.querySelector("#announcer").textContent;
  assert.match(said, /permission/i);
  assert.match(said, /rm -rf build/, "what it wants to run is the whole question");
  const widget = h.document.querySelector("#permission-tray [role='dialog']");
  assert.ok(widget, "a request for a decision is a dialog");
  // An unnamed dialog is announced as just "dialog", which says nothing about
  // what is being asked.
  assert.ok((widget.getAttribute("aria-label") || "").trim(), "and it is a named one");
  // Focus must stay where the user put it: a question arriving mid sentence must
  // not take the composer away.
  assert.notStrictEqual(h.document.activeElement, widget);
  assert.strictEqual(h.errors().length, 0);
});

test("the transcript is a log and the composer is labelled", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  await h.settle(10);
  assert.strictEqual(h.document.querySelector("#thread").getAttribute("role"), "log");
  assert.ok(h.document.querySelector("#thread").getAttribute("aria-label"));
  // A placeholder is not a label: it disappears the moment anything is typed.
  const input = h.document.querySelector("#input");
  assert.match(input.getAttribute("aria-label"), /ask devin/i);
  // The same box starts a new chat in the list, and the label has to follow it:
  // it overrides the placeholder, so a stale one is what gets read out.
  h.post({ type: "body", body: "list" });
  await h.settle(10);
  assert.match(input.getAttribute("aria-label"), /new chat/i);
  const announcer = h.document.querySelector("#announcer");
  assert.strictEqual(announcer.getAttribute("aria-live"), "polite");
  assert.ok(!announcer.classList.contains("hidden"), "display:none would remove it from the accessibility tree");
});

test("a permission prompt keeps the broad grants behind a chevron, and records the answer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "userChunk", text: "run something" });
  // The six options a real agent sends for a single shell command. Rendered flat,
  // "always allow in all projects" and "switch to bypass mode" look exactly as
  // ordinary as "Allow".
  h.post({
    type: "permission",
    requestId: "p1",
    title: "Devin wants to run a command",
    command: "exit 42",
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_session", name: "Yes, allow `exit` commands (this session)", kind: "allow_always" },
      { optionId: "allow_always", name: "Yes, always allow `exit` commands in `devin-vscode`", kind: "allow_always" },
      { optionId: "allow_always_global", name: "Yes, always allow `exit` commands in all projects", kind: "allow_always" },
      { optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  await h.settle(20);

  const tray = h.document.querySelector("#permission-tray");
  const labels = [...tray.querySelectorAll(".cw-buttons button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
  assert.deepStrictEqual(labels, ["Allow", "More ways to allow this", "Reject"], "only the narrow yes and the no are buttons");

  const more = tray.querySelector(".cw-more");
  more.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(20);
  const items = [...h.document.querySelectorAll(".dv-menu .dv-menu-item")];
  assert.strictEqual(items.length, 4, "every grant that outlives the request is one level in");

  items[1].dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(20);
  assert.deepStrictEqual(h.posted.filter((m) => m.type === "permission").pop(), {
    type: "permission",
    requestId: "p1",
    optionId: "allow_always"
  });
  // A grant that keeps applying has to leave a trace, or there is no way to see
  // later what was allowed.
  const recap = h.document.querySelector(".perm-recap");
  assert.ok(recap, "the decision is recorded in the transcript");
  assert.match(recap.textContent, /always allow .*exit.* in .*devin-vscode.*: exit 42/);
  assert.strictEqual(h.errors().length, 0);
});

test("a plain allow or reject still records what happened", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "userChunk", text: "run something" });
  h.post({
    type: "permission",
    requestId: "p2",
    command: "rm -rf build",
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  await h.settle(20);
  const tray = h.document.querySelector("#permission-tray");
  // With nothing broader on offer there is no chevron to show.
  assert.strictEqual(tray.querySelector(".cw-more"), null);
  [...tray.querySelectorAll(".cw-buttons button")].find((b) => b.textContent.trim() === "Reject").click();
  await h.settle(20);
  const recap = h.document.querySelector(".perm-recap");
  assert.ok(recap.classList.contains("rejected"));
  assert.strictEqual(recap.textContent.trim(), "Rejected: rm -rf build");
  assert.strictEqual(h.errors().length, 0);
});

test("a turn can be forked into a new chat without discarding anything", async () => {
  const h = createHarness();
  h.replay([{ role: "user", text: "first", mid: "m1" }, { role: "assistant", text: "answer" }]);
  await h.settle(20);
  h.post({ type: "sessionReady", sessionId: "S" });
  // The step list binds both prompts; the second may fork (the first has no
  // earlier point to copy from).
  h.post({ type: "userChunk", text: "second", messageId: "m2" });
  h.post({ type: "assistantChunk", text: "answer 2" });
  h.post({ type: "assistantEnd", stopReason: "end_turn" });
  bindCheckpoints(h, "S", ["m1", "m2"]);
  await h.settle(20);

  const fork = h.document.querySelector(".checkpoint-fork");
  assert.ok(fork, "a turn with a rewind point can also be forked from");
  assert.ok(fork.getAttribute("aria-label"), "an icon with no text still needs a name");
  fork.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(10);

  const msg = h.posted.filter((m) => m.type === "revertFork").pop();
  // The stable prompt id the binding named, scoped to this session.
  assert.deepStrictEqual(msg, { type: "revertFork", sessionId: "S", userMessageId: "m2" });
  // Forking discards nothing, so it must not ask about discarding edits.
  assert.strictEqual(h.posted.filter((m) => m.type === "revertPreview").length, 0);
  assert.strictEqual(h.errors().length, 0);
});

test("only the newest edit row for a file offers to keep or undo it", async () => {
  // Keeping and undoing are per file: the working set holds one original, from
  // before this chat first touched it. An older row's Undo therefore wound the file
  // back past every edit after it, from a button beside a diff showing only its own.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, showFileChanges: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "edit it twice" });
  h.post({ type: "fileChange", path: "/w/app.ts", added: 3, removed: 1, editId: "A#1#/w/app.ts" });
  await h.settle(20);
  const first = [...h.thread().querySelectorAll(".edit-pill")].pop();
  assert.ok(first && first.querySelector(".edit-pill-actions"), "the only row so far can be acted on");

  // The same file again, in a later turn.
  h.post({ type: "assistantEnd" });
  h.post({ type: "userMessage", text: "and again" });
  h.post({ type: "fileChange", path: "/w/app.ts", added: 2, removed: 0, editId: "A#2#/w/app.ts" });
  await h.settle(20);

  const rows = [...h.thread().querySelectorAll(".edit-pill")];
  const withActions = rows.filter((r) => r.querySelector(".edit-pill-actions"));
  assert.strictEqual(withActions.length, 1, "only one row still offers the decision");
  assert.strictEqual(withActions[0], rows[rows.length - 1], "and it is the newest one");
  assert.match(rows[0].title || "", /edited again later/i, "the older row says why it does not");
  assert.strictEqual(h.errors().length, 0);
});

test("a turn starting does not take the keyboard away from a control", async () => {
  // Every turn's controls are rebuilt when the busy state flips, which replaces the
  // elements. A keyboard user standing on one was dropped back to the top of the
  // panel each time a turn started or ended.
  const h = createHarness();
  h.replay([{ role: "user", text: "first", mid: "m1" }, { role: "assistant", text: "answer" }]);
  await h.settle(20);
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userChunk", text: "second", messageId: "m2" });
  h.post({ type: "assistantChunk", text: "answer 2" });
  h.post({ type: "assistantEnd", stopReason: "end_turn" });
  bindCheckpoints(h, "S", ["m1", "m2"]);
  await h.settle(20);

  // A Copy control on the request, not a checkpoint button: an ineligible
  // checkpoint row is hidden on the spot even while it holds focus, so it
  // cannot stand in for the chrome this test is about.
  const btn = h.document.querySelector("#thread .turn-request .msg-action");
  assert.ok(btn, "there is a control in the transcript to stand on");
  btn.focus();
  assert.strictEqual(h.document.activeElement, btn, "focus is on it");

  h.post({ type: "busy", value: true });
  await h.settle(10);
  assert.strictEqual(h.document.activeElement, btn, "and a turn starting leaves it there");
  h.post({ type: "busy", value: false });
  await h.settle(10);
  assert.strictEqual(h.document.activeElement, btn, "and so does a turn ending");
  assert.strictEqual(h.errors().length, 0);
});

test("a failed MCP server is not blamed on the next chat", async () => {
  // The card sits above the composer rather than in the transcript, so switching
  // chats does not take it with the thread, and it was left saying the chat now on
  // screen was missing tools it actually had.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "mcpProblems", servers: [{ name: "godot-ai", message: "did not start" }] });
  await h.settle(10);
  assert.ok(h.document.getElementById("mcp-problems"), "the chat that has the problem says so");

  // Back to the list, which has no chat and so no servers of its own.
  h.document.getElementById("history-btn").click();
  await h.settle(20);
  assert.strictEqual(h.document.getElementById("mcp-problems"), null,
    "and the warning does not follow the user into the list");

  // A second chat, which the host reports as having nothing wrong.
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "B" });
  h.post({ type: "mcpProblems", servers: [] });
  await h.settle(10);
  assert.strictEqual(h.document.getElementById("mcp-problems"), null, "nor into the next chat");
  assert.strictEqual(h.errors().length, 0);
});

test("committing a word in an IME does not send the message", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  await h.settle(10);
  const input = h.document.getElementById("input");
  input.value = "\u3053\u3093\u306b\u3061";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(5);

  // The Enter that commits the candidate. It belongs to the IME, not to us.
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true, isComposing: true, keyCode: 229
  }));
  await h.settle(10);
  assert.strictEqual(h.posted.filter((m) => m.type === "send").length, 0,
    "the reading must not be sent as the prompt");
  assert.strictEqual(input.value, "\u3053\u3093\u306b\u3061", "and the text is left alone");

  // Once the word is committed, Enter is ours again.
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);
  assert.strictEqual(h.posted.filter((m) => m.type === "send").length, 1, "a real Enter still sends");
  assert.strictEqual(h.errors().length, 0);
});

test("a file suggestion that arrives too late does not steal the next Enter", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  await h.settle(10);
  const input = h.document.getElementById("input");
  const menu = h.document.getElementById("autocomplete");

  input.value = "@Chat";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);
  const asked = h.posted.filter((m) => m.type === "queryFiles").pop();
  assert.ok(asked, "typing a mention asks the host for matches");

  // The user gives up on the mention before the workspace answers.
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await h.settle(5);
  assert.ok(menu.classList.contains("hidden"), "Escape closes it");

  // The reply lands now, for the query that was asked.
  h.post({ type: "fileSuggestions", query: asked.query, items: [{ path: "/w/chatViewProvider.ts", label: "chatViewProvider.ts", detail: "src/chat" }] });
  await h.settle(10);
  assert.ok(menu.classList.contains("hidden"), "and it stays closed rather than reopening over the composer");

  input.value = "what does this file do?";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);
  const sent = h.posted.filter((m) => m.type === "send").pop();
  assert.ok(sent && sent.text === "what does this file do?", "so Enter sends the message instead of picking a file");
  assert.strictEqual(h.errors().length, 0);
});

test("a prompt left half written comes back, and survives the panel settling", async () => {
  // The host restores the draft before it says `ready`, and says `ready` twice: on
  // open, and again once the CLI health check finishes. Handing the composer back
  // to the "new chat" box empties it, so doing that on every `ready` threw the
  // restored draft away, and with it anything typed while the check was running.
  const h = createHarness();
  const input = h.document.getElementById("input");

  h.post({ type: "draft", id: null, text: "half a prompt from last time" });
  await h.settle(10);
  assert.strictEqual(input.value, "half a prompt from last time", "the draft arrives");

  h.post({ type: "ready" });
  await h.settle(10);
  assert.strictEqual(input.value, "half a prompt from last time", "and is still there once the panel is ready");

  // Typing while the health check runs, then the second ready lands.
  input.value = "something I am typing now";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.post({ type: "ready" });
  await h.settle(10);
  assert.strictEqual(input.value, "something I am typing now", "and a second ready does not wipe it either");
  assert.strictEqual(h.errors().length, 0);
});

test("a new chat does not offer the last chat's message", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "delete all the generated tests" });
  await h.settle(20);

  // What starting a new chat posts: a thread body, then a reset clear.
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", reset: true });
  await h.settle(20);

  const input = h.document.getElementById("input");
  input.value = "";
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  await h.settle(10);
  assert.strictEqual(input.value, "",
    "Up recalls this chat's last message, and this chat has not had one");

  // And the same text must not be what a failed start offers to retry.
  h.post({ type: "error", text: "Couldn't start the agent." });
  await h.settle(10);
  const retry = h.thread().querySelector(".footer-retry, .error-retry");
  if (retry) {
    retry.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
    await h.settle(10);
    const sent = h.posted.filter((m) => m.type === "send").pop();
    assert.notStrictEqual(sent && sent.text, "delete all the generated tests",
      "Retry must not send the previous chat's message into this one");
  }
  assert.strictEqual(h.errors().length, 0);
});

test("a rewind says the file edits it cannot undo are staying", async () => {
  // Probed against a real agent: the revert plan is empty even for files it edited
  // through us, and its own rewind leaves the disk alone. So "Discard Edits" would
  // be a promise the rewind does not keep.
  const h = createHarness();
  h.replay([{ role: "user", text: "first", mid: "m1" }, { role: "assistant", text: "answer" }]);
  await h.settle(20);
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userChunk", text: "second", messageId: "m2" });
  h.post({ type: "assistantChunk", text: "answer 2" });
  h.post({ type: "assistantEnd", stopReason: "end_turn" });
  bindCheckpoints(h, "S", ["m1", "m2"]);
  await h.settle(20);

  // Every bound turn now offers a restore, so take the last one: it is the
  // second prompt's row, the turn this test rewinds.
  const btn = [...h.document.querySelectorAll(".checkpoint-restore")].pop();
  assert.ok(btn, "the turn offers a restore");
  btn.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(10);

  const asked = h.posted.filter((m) => m.type === "revertPreview").pop();
  assert.ok(asked, "it asks what the rewind would do before doing it");
  // What a real agent answers, plus the two files this chat changed itself.
  h.post({
    type: "revertPreview",
    token: asked.token,
    sessionId: asked.sessionId,
    userMessageId: asked.userMessageId,
    result: { fileActions: [], irreversibleWarnings: [], conflicts: [] },
    pendingFiles: 2
  });
  await h.settle(10);

  assert.strictEqual(h.posted.filter((m) => m.type === "revertExecute").length, 0,
    "nothing is rewound until the second click");
  const label = btn.querySelector("span").textContent;
  assert.strictEqual(label, "Rewind Chat", "so it does not offer to discard what it will leave behind");
  assert.match(btn.title, /2 file edits stay on disk/, "and says where those edits went: " + btn.title);

  btn.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "revertExecute" && m.userMessageId === "m2"), "confirming rewinds");
  assert.strictEqual(h.errors().length, 0);
});

test("the mode picker offers whatever modes the agent reports", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  // The five a real `devin acp` reports. The extension used to compile in four of
  // them, so `smart` was unreachable from the panel however new the CLI was.
  h.post({
    type: "options",
    currentMode: "smart",
    currentModel: "adaptive",
    models: [],
    modes: [
      { value: "accept-edits", name: "Code", icon: "codicon-code" },
      { value: "smart", name: "Smart", icon: "codicon-sparkle" },
      { value: "ask", name: "Ask", icon: "codicon-comment-discussion" },
      { value: "plan", name: "Plan", icon: "codicon-checklist" },
      { value: "bypass", name: "Bypass Permissions", icon: "codicon-unlock" }
    ]
  });
  await h.settle(20);
  const dd = h.document.querySelector("#mode-dd");
  // A mode the extension does not know the name of would show as its raw id.
  assert.match(dd.textContent, /Smart/, "the picker names the mode the session is actually in");

  dd.querySelector("button").dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(20);
  const rows = [...dd.querySelectorAll(".dd-item")].map((r) => r.textContent.trim());
  assert.deepStrictEqual(rows, ["Code", "Smart", "Ask", "Plan", "Bypass"]);
  assert.strictEqual(dd.querySelector(".dd-item.selected").textContent.trim(), "Smart");
  // Devin names its icons after its own set, so they arrive already mapped.
  assert.ok(dd.querySelector(".dd-item-icon.codicon-sparkle"), "the mapped icon is used");
  assert.strictEqual(h.errors().length, 0);
});

test("model picker lays out the Adaptive and Fusion cards above the models", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options",
    currentMode: "accept-edits",
    currentModel: "claude-medium",
    modes: [],
    models: [
      {
        id: "adaptive",
        name: "Adaptive",
        default: "adaptive",
        variants: [{ value: "adaptive", name: "Adaptive", description: "Automatically balances quality and cost" }]
      },
      {
        id: "fusion",
        name: "Fusion",
        default: "fusion-opus-sidekick-swe",
        variants: [{ value: "fusion-opus-sidekick-swe", name: "Opus + SWE" }]
      },
      {
        id: "claude",
        name: "Claude",
        default: "claude-medium",
        variants: [
          { value: "claude-medium", name: "Medium", isNew: true, promotion: "PROMO" },
          { value: "claude-low", name: "Low" }
        ]
      },
      {
        id: "terra",
        name: "Terra",
        default: "terra-medium",
        variants: [{ value: "terra-medium", name: "Medium" }]
      }
    ]
  });
  await h.settle(20);

  h.document.querySelector("#modelBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  const rows = [...popup.querySelectorAll(".dd-item")];
  assert.match(rows[0].textContent, /Adaptive/);
  assert.ok(rows[0].classList.contains("dd-item-card"), "Adaptive renders as a featured card");
  assert.match(rows[0].textContent, /Automatically balances quality and cost/);
  assert.ok(!rows[0].querySelector(".dd-item-action"), "the Adaptive card has no effort action");
  assert.match(rows[1].textContent, /Fusion/);
  assert.ok(rows[1].classList.contains("dd-item-card"), "Fusion renders as a featured card");
  assert.ok(rows[1].querySelector(".dd-item-action"), "the Fusion card routes to its settings page");
  const claude = rows.find((item) => /Claude/.test(item.textContent));
  assert.ok(claude, "the Claude family is listed");
  assert.match(claude.textContent, /New/);
  assert.match(claude.textContent, /Promotion/);
  assert.doesNotMatch(claude.textContent, /MTok/, "cost stays out of the model row");
  assert.ok(claude.querySelector(".dd-item-action"), "a configurable model has an effort action");

  const css = fs.readFileSync(path.join(ROOT, "media", "main.css"), "utf8");
  assert.match(css, /#model-picker-popup \.dd-item-card\s*\{/, "the featured card style exists");
  assert.match(css, /#model-picker-popup\s*\{/, "the tray is styled");
  assert.match(css, /#model-picker-popup \.dd-rows > \.dd-group\s*\{/, "group headings align with the row band");

  claude.querySelector(".dd-item-main").click();
  await h.settle(20);
  h.document.querySelector("#effortBtn").click();
  popup.querySelector("#pagePin").click();
  await h.settle(20);
  assert.ok(h.state().pinnedModels.includes("claude"), "the header pin records the model");
  h.document.querySelector("#modelBtn").click();
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".dd-group")].map((group) => group.textContent.trim()),
    ["Pinned", "Models"]
  );
  assert.strictEqual([...popup.querySelectorAll(".dd-item")].filter((item) => /Claude/.test(item.textContent)).length, 1);
  h.document.body.dispatchEvent(new h.window.MouseEvent("mousedown", { bubbles: true }));

  h.post({
    type: "options",
    currentMode: "accept-edits",
    currentModel: "other-medium",
    modes: [],
    models: [{
      id: "other",
      name: "Other",
      default: "other-medium",
      variants: [{ value: "other-medium", name: "Medium" }]
    }]
  });
  await h.settle(20);
  h.document.querySelector("#modelBtn").click();
  assert.doesNotMatch(h.document.querySelector("#model-picker-popup").textContent, /Claude/, "an unavailable pinned model is not shown");
  assert.strictEqual(h.errors().length, 0);
});

test("the details page links cost labels to prices and limits to values", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options",
    currentMode: "accept-edits",
    currentModel: "claude-medium",
    modes: [],
    models: [{
      id: "claude",
      name: "Claude",
      default: "claude-medium",
      variants: [
        {
          value: "claude-medium",
          name: "Medium",
          costTier: "Medium cost",
          costSummary: "$2 / MTok In \u00b7 $10 / MTok Out \u00b7 $0.2 / MTok Cache Read \u00b7 $2.5 / MTok Cache Write",
          longContextCostSummary: "$4 / MTok In \u00b7 $20 / MTok Out \u00b7 $0.4 / MTok Cache Read \u00b7 $5 / MTok Cache Write",
          maxContextTokens: 1048576,
          maxOutputTokens: 131072
        },
        { value: "claude-low", name: "Low", maxContextTokens: 200000, maxOutputTokens: 8192 }
      ]
    }]
  });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  const limits = popup.querySelector(".catalog-limits");
  const pairs = [...limits.querySelectorAll(".catalog-limit")].map((row) => [
    row.querySelector("dt").textContent,
    row.querySelector("dd").textContent
  ]);
  assert.deepStrictEqual(pairs, [["Max context", "1M tokens"], ["Max output", "131K tokens"]]);

  const pricing = popup.querySelector("details.catalog-pricing");
  assert.strictEqual(pricing.open, false, "pricing starts collapsed");
  assert.strictEqual(popup.querySelector(".catalog-unit").textContent, "USD per 1M tokens");
  assert.match(pricing.querySelector(".catalog-box-label").textContent, /Pricing details/);
  assert.match(pricing.querySelector(".catalog-tier").textContent, /Medium cost/);
  pricing.open = true;
  pricing.dispatchEvent(new h.window.Event("toggle"));
  const table = pricing.querySelector("table.catalog-prices");
  const header = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent);
  assert.deepStrictEqual(header, ["Token type", "Default", "Long context"], "long context rates get their own column");
  const rows = Object.fromEntries(
    [...table.querySelectorAll("tbody tr")].map((row) => [
      row.querySelector("th, td").textContent,
      [...row.querySelectorAll("td")].slice(-2).map((cell) => cell.textContent)
    ])
  );
  assert.deepStrictEqual(rows["Input"], ["$2", "$4"]);
  assert.deepStrictEqual(rows["Output"], ["$10", "$20"]);
  assert.deepStrictEqual(rows["Cache Read"], ["$0.2", "$0.4"]);
  assert.deepStrictEqual(rows["Cache Write"], ["$2.5", "$5"]);
  assert.strictEqual(h.errors().length, 0);
});

test("Fusion role pages price each side with its own rates", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options",
    currentMode: "accept-edits",
    currentModel: "fusion-opus-high-sidekick-swe-medium",
    currentThoughtLevel: "high",
    modes: [],
    models: [
      {
        id: "fusion",
        name: "Fusion",
        default: "fusion-opus-high-sidekick-swe-medium",
        variants: [
          {
            value: "fusion-opus-high-sidekick-swe-medium",
            name: "Opus + SWE",
            costSummary: "$4 / MTok In \u00b7 $20 / MTok Out \u00b7 $1 / MTok Sidekick In \u00b7 $5 / MTok Sidekick Out",
            maxContextTokens: 1000000,
            maxOutputTokens: 128000
          }
        ]
      },
      { id: "opus", name: "Opus", default: "opus-high", variants: [{ value: "opus-high", name: "High", maxContextTokens: 1000000, maxOutputTokens: 128000 }] },
      { id: "swe", name: "SWE", default: "swe-medium", variants: [{ value: "swe-medium", name: "Medium", maxContextTokens: 262000, maxOutputTokens: 64000 }] }
    ]
  });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  popup.querySelector("#act-opus").click();
  let pricing = popup.querySelector("details.catalog-pricing");
  pricing.open = true;
  pricing.dispatchEvent(new h.window.Event("toggle"));
  assert.match(pricing.textContent, /\$4/);
  assert.doesNotMatch(pricing.textContent, /Sidekick/, "the Lead page never shows sidekick rates");
  popup.querySelector("#pageBack").click();
  popup.querySelector("#roleRadio-sub").checked = true;
  popup.querySelector("#roleRadio-sub").dispatchEvent(new h.window.Event("change", { bubbles: true }));
  popup.querySelector("#act-swe").click();
  pricing = popup.querySelector("details.catalog-pricing");
  pricing.open = true;
  pricing.dispatchEvent(new h.window.Event("toggle"));
  assert.match(pricing.textContent, /\$1/);
  assert.match(pricing.textContent, /\$5/, "the Sub page shows sidekick rates");
  const limits = [...popup.querySelectorAll(".catalog-limit")].map((row) => [
    row.querySelector("dt").textContent, row.querySelector("dd").textContent
  ]);
  assert.deepStrictEqual(limits, [["Max context", "262K tokens"], ["Max output", "64K tokens"]], "the Sub page shows its own model limits");
  assert.strictEqual(h.errors().length, 0);
});

test("Fusion keeps lead effort and sidekick in one picker", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options",
    currentMode: "accept-edits",
    currentModel: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
    currentThoughtLevel: "low",
    thoughtLevels: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    modelChoices: {},
    models: [{
      id: "fusion",
      name: "Fusion",
      default: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
      variants: [
        { value: "fusion-claude-opus-5-low-sidekick-swe-2-medium", name: "Opus 5 Low + SWE-2 Medium" },
        { value: "fusion-claude-opus-5-medium-sidekick-swe-2-medium", name: "Opus 5 Medium + SWE-2 Medium" },
        { value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Opus 5 High + SWE-2 Medium" },
        { value: "fusion-claude-opus-5-low-sidekick-swe-2-high", name: "Opus 5 Low + SWE-2 High" },
        { value: "fusion-claude-opus-5-medium-sidekick-swe-2-medium".replace("medium", "medium"), name: "" },
        { value: "fusion-claude-opus-5-medium-sidekick-swe-2-high", name: "Opus 5 Medium + SWE-2 High" },
        { value: "fusion-claude-opus-5-high-sidekick-swe-2-high", name: "Opus 5 High + SWE-2 High" },
        { value: "fusion-gpt-6-astra-low-sidekick-swe-2-medium", name: "Astra Low + SWE-2 Medium" },
        { value: "fusion-gpt-6-astra-high-sidekick-swe-2-medium", name: "Astra High + SWE-2 Medium" }
      ]
    },
    {
      id: "claude-opus-5", name: "Claude Opus 5", default: "claude-opus-5-high",
      variants: [{ value: "claude-opus-5-high", name: "High" }]
    },
    {
      id: "gpt-6-astra", name: "GPT-6 Astra", default: "gpt-6-astra-high",
      variants: [{ value: "gpt-6-astra-high", name: "High" }]
    },
    {
      id: "swe-2", name: "SWE-2", default: "swe-2-medium",
      variants: [{ value: "swe-2-medium", name: "Medium" }, { value: "swe-2-high", name: "High" }]
    }],
    modes: []
  });
  await h.settle(20);

  assert.strictEqual(h.document.querySelector("#modelBtn .dd-label").textContent, "Fusion");
  assert.match(h.document.querySelector("#effortBtnLabel").textContent, /Opus 5 Low/);
  assert.match(h.document.querySelector("#effortBtnLabel").textContent, /SWE-2 Medium/);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  assert.ok(!popup.classList.contains("hidden"));
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".role-radio")].map((radio) => radio.value),
    ["lead", "sub"],
    "Lead and Sub share the one tray"
  );
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".fusion-rows .dd-item-name")].map((el) => el.textContent),
    ["Claude Opus 5", "GPT-6 Astra"]
  );
  popup.querySelector("#act-claude-opus-5").click();
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".effort-seg")].map((seg) => seg.dataset.effort),
    ["low", "medium", "high"]
  );
  popup.querySelector('.effort-seg[data-effort="high"]').click();
  assert.ok(h.posted.some((message) => message.type === "setConfigOption" && message.configId === "thought_level" && message.value === "high"));
  popup.querySelector("#pageBack").click();
  popup.querySelector("#roleRadio-sub").checked = true;
  popup.querySelector("#roleRadio-sub").dispatchEvent(new h.window.Event("change", { bubbles: true }));
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".fusion-rows .dd-item-name")].map((el) => el.textContent),
    ["SWE-2"]
  );
  popup.querySelector("#act-swe-2").click();
  popup.querySelector('.effort-seg[data-effort="high"]').click();
  assert.ok(h.posted.some((message) => message.type === "setFusionModel" && /-sidekick-swe-2-high$/.test(message.model)), "a sub effort reposts the resolved pair");
  assert.strictEqual(h.errors().length, 0);
});

test("a normal model with no thought level hides the effort segment", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const allModels = [
    { id: "fusion", name: "Fusion", default: "fusion-claude-opus-5-high-sidekick-swe-2-medium", variants: [{ value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Fusion" }] },
    { id: "gpt", name: "GPT-5", default: "gpt-5-xhigh", variants: [{ value: "gpt-5-xhigh", name: "GPT-5 XHigh" }] }
  ];
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
    currentThoughtLevel: "low", thoughtLevels: [{ value: "low", name: "Low" }],
    modelChoices: {}, models: allModels, modes: []
  });
  await h.settle(20);
  const group = h.document.querySelector("#model-picker-group");
  assert.ok(!group.classList.contains("no-effort"), "Fusion keeps its effort segment");

  h.document.querySelector("#modelBtn").click();
  [...h.document.querySelectorAll(".dd-item-main")].find((el) => el.textContent.includes("GPT-5")).click();
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "gpt-5-xhigh", currentThoughtLevel: "",
    thoughtLevels: [], modelChoices: {}, models: allModels, modes: [], sessionConfig: true
  });
  await h.settle(20);

  assert.ok(group.classList.contains("no-effort"), "an unconfigurable model hides the effort half");
  const css = fs.readFileSync(path.join(ROOT, "media", "main.css"), "utf8");
  assert.match(css, /#model-picker-group\.no-effort #effortBtn,\s*\n#model-picker-group\.no-effort \.picker-div \{\s*display: none;/, "the no-effort rule hides the segment");
  assert.match(css, /#input-box\.cmp-no-models #model-picker-group/, "the deepest collapse stage hides the whole picker");
  assert.strictEqual(h.errors().length, 0);
});

test("each model family keeps its own effort levels", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const models = [
    { id: "claude", name: "Claude", default: "claude-medium", variants: [
      { value: "claude-medium", name: "Medium" }, { value: "claude-high", name: "High" }
    ] },
    { id: "gpt", name: "GPT", default: "gpt-medium", variants: [
      { value: "gpt-medium", name: "Medium" }, { value: "gpt-max", name: "Max" }
    ] }
  ];
  const options = (currentModel, currentThoughtLevel, thoughtLevels) => ({
    type: "options", currentMode: "accept-edits", currentModel, currentThoughtLevel,
    thoughtLevels, modelChoices: {}, models, modes: []
  });
  h.post(options("claude-medium", "medium", [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }]));
  h.post(options("gpt-medium", "medium", [{ value: "medium", name: "Medium" }, { value: "max", name: "Max" }]));
  h.post({ type: "model", model: "gpt-medium" });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".effort-seg")].map((seg) => seg.dataset.effort),
    ["medium", "max"],
    "GPT shows its own reported list"
  );
  assert.strictEqual(
    popup.querySelector(".effort-seg[aria-checked='true']").dataset.effort,
    "medium"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a model that reports no effort clears the previous model's effort", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const models = [
    { id: "claude", name: "Claude", default: "claude-medium", variants: [
      { value: "claude-medium", name: "Medium" }, { value: "claude-high", name: "High" }
    ] },
    { id: "gpt", name: "GPT", default: "gpt-medium", variants: [{ value: "gpt-medium", name: "Medium" }] }
  ];
  const options = (currentModel, currentThoughtLevel, thoughtLevels) => ({
    type: "options", currentMode: "accept-edits", currentModel, currentThoughtLevel,
    thoughtLevels, modelChoices: {}, models, modes: [], sessionConfig: true
  });
  h.post(options("claude-medium", "medium", [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }]));
  await h.settle(20);
  const group = h.document.querySelector("#model-picker-group");
  assert.ok(!group.classList.contains("no-effort"));

  h.post(options("gpt-medium", "", []));
  h.post({ type: "model", model: "gpt-medium" });
  await h.settle(20);
  assert.ok(group.classList.contains("no-effort"), "an authoritative empty report removes the effort half");
  assert.strictEqual(h.errors().length, 0);
});

test("Fusion is configurable before a session reports grouped choices", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
    thoughtLevels: [], modelChoices: {},
    models: [
      {
        id: "fusion", name: "Fusion",
        default: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
        variants: [
          { value: "fusion-claude-opus-5-low-sidekick-swe-2-medium", name: "Opus 5 Low + SWE-2 Medium" },
          { value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Opus 5 High + SWE-2 Medium" },
          { value: "fusion-claude-opus-5-low-sidekick-swe-2-high", name: "Opus 5 Low + SWE-2 High" }
        ]
      },
      { id: "claude-opus-5", name: "Claude Opus 5", default: "claude-opus-5-high", variants: [{ value: "claude-opus-5-high", name: "High" }] },
      { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }, { value: "swe-2-high", name: "High" }] }
    ],
    modes: []
  });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  assert.ok(!popup.classList.contains("hidden"), "the Fusion page opens without a report");
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".fusion-rows .dd-item-name")].map((el) => el.textContent),
    ["Claude Opus 5"]
  );
  popup.querySelector("#act-claude-opus-5").click();
  assert.deepStrictEqual(
    [...popup.querySelectorAll(".effort-seg")].map((seg) => seg.dataset.effort),
    ["low", "high"],
    "the rail falls back to catalogue lead efforts"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("only the latest model change acknowledgement can reconcile a rapid series of picks", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const models = [
    { id: "claude", name: "Claude", default: "claude-medium", variants: [
      { value: "claude-medium", name: "Medium" }, { value: "claude-high", name: "High" }
    ] },
    { id: "gpt", name: "GPT", default: "gpt-medium", variants: [
      { value: "gpt-medium", name: "Medium" }, { value: "gpt-max", name: "Max" }
    ] }
  ];
  const options = (currentModel, currentThoughtLevel, thoughtLevels) => ({
    type: "options", currentMode: "accept-edits", currentModel, currentThoughtLevel,
    thoughtLevels, modelChoices: {}, models, modes: []
  });
  h.post(options("claude-medium", "medium", [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }]));
  h.post(options("gpt-medium", "medium", [{ value: "medium", name: "Medium" }, { value: "max", name: "Max" }]));
  await h.settle(20);

  h.document.querySelector("#modelBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  const label = () => h.document.querySelector("#effortBtnLabel").textContent;
  popup.querySelector('.dd-item-main[data-id="gpt"]').click();
  popup.querySelector('.dd-item-main[data-id="claude"]') || h.document.querySelector("#modelBtn").click();
  h.document.querySelector("#modelBtn").click();
  h.document.querySelector('.dd-item-main[data-id="claude"]').click();
  const posts = h.posted.filter((message) => message.type === "setModel");
  assert.strictEqual(posts.length, 2);
  h.post({ type: "modelConfigApplied", requestId: posts[0].requestId, model: "gpt-medium", thoughtLevel: "medium" });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector("#modelBtn .dd-label").textContent, "Claude", "a stale acknowledgement cannot undo the newer pick");
  h.post({ type: "modelConfigApplied", requestId: posts[1].requestId, model: "claude-medium", thoughtLevel: "medium" });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector("#modelBtn .dd-label").textContent, "Claude");
  assert.strictEqual(label(), "Medium");
  assert.strictEqual(h.errors().length, 0);
});

test("unchanged options keep the open picker's selection and focus", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const options = () => ({
    type: "options", currentMode: "accept-edits",
    currentModel: "claude-medium", currentThoughtLevel: "medium",
    thoughtLevels: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
    modelChoices: {},
    models: [{ id: "claude", name: "Claude", default: "claude-medium", variants: [
      { value: "claude-medium", name: "Medium" }, { value: "claude-high", name: "High" }
    ] }],
    modes: []
  });
  h.post(options());
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  const checked = popup.querySelector(".effort-seg[aria-checked='true']");
  checked.focus();
  assert.strictEqual(h.document.activeElement, checked);

  h.post(options());
  await h.settle(20);
  const after = h.document.querySelector("#model-picker-popup .effort-seg[aria-checked='true']");
  assert.strictEqual(after.dataset.effort, "medium", "an identical reply keeps the checked effort");
  assert.strictEqual(h.document.activeElement.dataset.effort, "medium", "focus returns to the same segment");

  h.post({ ...options(), thoughtLevels: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "XHigh" }] });
  await h.settle(20);
  assert.deepStrictEqual(
    [...h.document.querySelectorAll("#model-picker-popup .effort-seg")].map((seg) => seg.dataset.effort),
    ["medium", "high", "xhigh"],
    "a late effort choice joins the rail"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a stale model change acknowledgement cannot paint a new session", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const allModels = [
    { id: "fusion", name: "Fusion", default: "fusion-claude-opus-5-low-sidekick-swe-2-medium", variants: [
      { value: "fusion-claude-opus-5-low-sidekick-swe-2-medium", name: "Opus 5 Low + SWE-2 Medium" },
      { value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Opus 5 High + SWE-2 Medium" }
    ] },
    { id: "claude-opus-5", name: "Claude Opus 5", default: "claude-opus-5-high", variants: [{ value: "claude-opus-5-high", name: "High" }] },
    { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }] },
    { id: "gpt", name: "GPT-5", default: "gpt-5-xhigh", variants: [{ value: "gpt-5-xhigh", name: "GPT-5 XHigh" }] }
  ];
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "fusion-claude-opus-5-low-sidekick-swe-2-medium",
    currentThoughtLevel: "low",
    thoughtLevels: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    modelChoices: {}, models: allModels, modes: []
  });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  const popup = h.document.querySelector("#model-picker-popup");
  popup.querySelector("#act-claude-opus-5").click();
  popup.querySelector('.effort-seg[data-effort="high"]').click();
  const effortPost = h.posted.slice().reverse().find((message) => message.type === "setConfigOption");
  assert.strictEqual(effortPost.requestId, 1, "the pick is tagged");
  assert.match(h.document.querySelector("#effortBtnLabel").textContent, /High/, "the optimistic pick is on the composer");

  h.post({ type: "clear", reset: true });
  h.post({ type: "sessionReady", sessionId: "session-two" });
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "gpt-5-xhigh", currentThoughtLevel: "", thoughtLevels: [],
    modelChoices: {}, models: allModels, modes: []
  });
  h.post({ type: "model", model: "gpt-5-xhigh" });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector("#modelBtn .dd-label").textContent, "GPT-5", "the new session's own model is on screen");

  h.post({ type: "modelConfigApplied", requestId: 1, model: "fusion-claude-opus-5-low-sidekick-swe-2-medium", thoughtLevel: "high" });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector("#modelBtn .dd-label").textContent, "GPT-5", "the stale acknowledgement cannot paint over it");
  assert.strictEqual(h.errors().length, 0);
});

test("a session arriving keeps a pending pick guarded", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const options = (thoughtLevel) => ({
    type: "options", currentMode: "accept-edits",
    currentModel: "claude-medium", currentThoughtLevel: thoughtLevel,
    thoughtLevels: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    modelChoices: {},
    models: [{ id: "claude", name: "Claude", default: "claude-medium", variants: [
      { value: "claude-medium", name: "Claude Medium" }, { value: "claude-high", name: "Claude High" }
    ] }],
    modes: []
  });
  h.post(options("low"));
  await h.settle(20);

  const label = () => h.document.querySelector("#effortBtnLabel").textContent;
  h.document.querySelector("#effortBtn").click();
  h.document.querySelector('.effort-seg[data-effort="high"]').click();
  assert.strictEqual(label(), "High", "the pick is optimistic");
  assert.strictEqual(h.posted.at(-1).requestId, 1, "the pick is tagged");

  h.post({ type: "sessionReady", sessionId: "s-new" });
  h.post(options("low"));
  await h.settle(20);
  assert.strictEqual(label(), "High", "a stale reply cannot undo the pick just because the session arrived");

  h.post({ type: "modelConfigApplied", requestId: 1, model: "claude-medium", thoughtLevel: "high" });
  await h.settle(20);
  assert.strictEqual(label(), "High", "the acknowledgement for the pending pick still applies");

  h.post(options("low"));
  await h.settle(20);
  assert.strictEqual(label(), "Low", "once acknowledged, authoritative replies apply again");
  assert.strictEqual(h.errors().length, 0);
});

test("catalogue lead names strip the effort suffix whatever level it carries", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({
    type: "options", currentMode: "accept-edits",
    currentModel: "fusion-gpt-6-astra-low-sidekick-swe-2-medium",
    currentThoughtLevel: "low",
    thoughtLevels: [{ value: "low", name: "Low" }],
    modelChoices: {},
    models: [
      {
        id: "fusion", name: "Fusion",
        default: "fusion-gpt-6-astra-low-sidekick-swe-2-medium",
        variants: [
          { value: "fusion-gpt-6-astra-low-sidekick-swe-2-medium", name: "Astra Low + SWE-2 Medium" },
          { value: "fusion-claude-opus-5-xhigh-sidekick-swe-2-medium", name: "Opus 5 XHigh + SWE-2 Medium" },
          { value: "fusion-gemini-max-sidekick-swe-2-medium", name: "Gemini Max + SWE-2 Medium" }
        ]
      },
      { id: "gpt-6-astra", name: "GPT-6 Astra", default: "gpt-6-astra-low", variants: [{ value: "gpt-6-astra-low", name: "Low" }] },
      { id: "claude-opus-5", name: "Claude Opus 5", default: "claude-opus-5-xhigh", variants: [{ value: "claude-opus-5-xhigh", name: "XHigh" }] },
      { id: "gemini", name: "Gemini", default: "gemini-max", variants: [{ value: "gemini-max", name: "Max" }] },
      { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }] }
    ],
    modes: []
  });
  await h.settle(20);

  h.document.querySelector("#effortBtn").click();
  assert.deepStrictEqual(
    [...h.document.querySelectorAll(".fusion-rows .dd-item-name")].map((el) => el.textContent),
    ["Claude Opus 5", "Gemini", "GPT-6 Astra"],
    "effort suffixes never leak into lead names"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("a reply about another Fusion lead cannot move the shown effort", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const models = [
    {
      id: "fusion", name: "Fusion",
      default: "fusion-claude-opus-5-high-sidekick-swe-2-medium",
      variants: [
        { value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Opus 5 High + SWE-2 Medium" },
        { value: "fusion-gpt-6-astra-low-sidekick-swe-2-medium", name: "Astra Low + SWE-2 Medium" }
      ]
    },
    { id: "claude-opus-5", name: "Claude Opus 5", default: "claude-opus-5-high", variants: [{ value: "claude-opus-5-high", name: "High" }] },
    { id: "gpt-6-astra", name: "GPT-6 Astra", default: "gpt-6-astra-low", variants: [{ value: "gpt-6-astra-low", name: "Low" }] },
    { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }] }
  ];
  const options = (currentModel, currentThoughtLevel, thoughtLevels) => ({
    type: "options", currentMode: "accept-edits", currentModel, currentThoughtLevel,
    thoughtLevels, modelChoices: {}, models, modes: []
  });
  h.post(options("fusion-claude-opus-5-high-sidekick-swe-2-medium", "high", [{ value: "high", name: "High" }]));
  h.document.querySelector("#effortBtn").click();
  h.document.querySelector("#act-claude-opus-5").click();
  await h.settle(20);

  h.post(options("fusion-gpt-6-astra-low-sidekick-swe-2-medium", "low", [{ value: "low", name: "Low" }, { value: "xhigh", name: "XHigh" }]));
  await h.settle(20);
  const popup = h.document.querySelector("#model-picker-popup");
  assert.strictEqual(
    popup.querySelector(".effort-seg[aria-checked='true']")?.dataset.effort || h.document.querySelector("#effortBtnLabel").textContent,
    popup.querySelector(".effort-seg[aria-checked='true']") ? "high" : "High",
    "the shown lead effort ignores a report about another lead"
  );
  assert.strictEqual(h.errors().length, 0);
});

test("tool output carries a copy action, and JSON is pretty printed", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  // A plain tool, not an MCP one: JSON is JSON whoever returned it.
  h.post({ type: "toolCall", id: "j1", title: "Read config", kind: "read", status: "pending" });
  h.post({ type: "toolCallUpdate", id: "j1", status: "completed",
    content: [{ type: "text", text: '{"name":"devin","nested":{"on":true}}' }] });
  await h.settle(20);
  const card = [...h.document.querySelectorAll("#thread .tool")].find((t) => /Read config/.test(t.textContent));
  const pre = card.querySelector(".tool-block .tool-pre");
  assert.ok(pre.classList.contains("hljs"), "highlighted");
  assert.match(pre.textContent, /^\{\n  "name": "devin",/, "and pretty printed");
  const copy = card.querySelector(".tool-block .tool-toolbar .dv-copy");
  assert.ok(copy, "with a copy action");
  copy.click();
  await h.settle(10);
  const posted = h.posted.filter((m) => m.type === "copyText").pop();
  assert.match(posted.text, /"nested": \{/, "which copies the formatted text");
  assert.strictEqual(h.errors().length, 0);
});

test("clearing the thread takes the permission menu with it", async () => {
  // The scope menu is anchored to a button in the permission tray but lives on the
  // body, so emptying the tray by hand left it floating over the new thread, still
  // offering to answer a request that had gone.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "userChunk", text: "run something" });
  h.post({
    type: "permission",
    requestId: "p9",
    command: "exit 42",
    options: [
      { optionId: "allow_once", name: "Allow", kind: "allow_once" },
      { optionId: "allow_always", name: "Yes, always allow `exit` commands here", kind: "allow_always" },
      { optionId: "allow_always_global", name: "Yes, always allow `exit` commands everywhere", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" }
    ]
  });
  await h.settle(20);
  h.document.querySelector("#permission-tray .cw-more").dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(20);
  assert.ok(h.document.querySelector(".dv-menu"), "the menu is open");

  // A new chat, or opening another one, clears the thread underneath it.
  h.post({ type: "clear" });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector(".dv-menu"), null, "and it goes with the thread");
  assert.strictEqual(h.errors().length, 0);
});

test("a file path with a space or an accent in it still opens", async () => {
  // The markdown renderer percent encodes every href, so the string on the anchor
  // is not a path any more. Sent as one, it opened nothing, and the only sign of
  // it was a line in the extension's output channel.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "assistantChunk", text: "see [docs/caf\u00e9.md](<docs/caf\u00e9 notes.md>)" });
  h.post({ type: "assistantEnd" });
  await h.settle(30);

  const link = [...h.thread().querySelectorAll("a[href]")].pop();
  assert.ok(link, "the link is rendered");
  link.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await h.settle(10);
  const opened = h.posted.filter((m) => m.type === "openFile").pop();
  assert.ok(opened, "the click asks the host to open it");
  assert.strictEqual(opened.path, "docs/caf\u00e9 notes.md", "as a path, not as a percent encoded url");
  assert.strictEqual(h.errors().length, 0);
});

test("turning the changed files summary off turns it off", async () => {
  // The setting was read by the host, sent to the page and stored, and then never
  // looked at, so it did nothing whichever way it was set.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "capabilities", revert: true, showFileChanges: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "workingSet", files: [{ path: "/w/app.ts", added: 2, removed: 1 }] });
  await h.settle(20);
  const ws = h.document.querySelector("#working-set");
  assert.ok(!ws.classList.contains("hidden"), "on by default, the summary is there");

  h.post({ type: "capabilities", revert: true, showFileChanges: false });
  await h.settle(20);
  assert.ok(ws.classList.contains("hidden"), "and turning it off takes it away now, not next turn");
  assert.strictEqual(h.errors().length, 0);
});

// --- ACP next integrations: prompt history, session search, shell stop --------

test("the showPromptHistory message asks the host once and a pick fills the draft", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "s1" });
  await h.settle(20);

  // History is on demand through the command, so no permanent control sits in
  // the composer toolbar.
  assert.strictEqual(h.document.getElementById("prompt-history"), null,
    "no permanent history button sits in the composer");

  const input = h.document.getElementById("input");
  input.value = "half typed";
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  const req = h.posted.filter((m) => m.type === "promptHistory").pop();
  assert.ok(req, "the command asked the host for history");
  assert.strictEqual(req.sessionId, "s1");
  assert.ok(req.requestId, "and carried a request id");

  // A second invocation while the picker is open does not duplicate the ask.
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  assert.strictEqual(h.posted.filter((m) => m.type === "promptHistory").length, 1,
    "the open picker is not asked twice");

  h.post({ type: "promptHistorySelected", requestId: req.requestId, sessionId: "s1", text: "earlier prompt" });
  await h.settle(20);
  assert.strictEqual(input.value, "earlier prompt", "the pick became the draft");
  assert.strictEqual(h.errors().length, 0);
});

test("a prompt history answer is dropped when the draft or session moved on", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "s1" });
  await h.settle(20);

  const input = h.document.getElementById("input");
  input.value = "draft at click";
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  const req = h.posted.filter((m) => m.type === "promptHistory").pop();

  // The user kept typing while the picker was open: the answer is stale.
  input.value = "user kept typing";
  h.post({ type: "promptHistorySelected", requestId: req.requestId, sessionId: "s1", text: "old prompt" });
  await h.settle(20);
  assert.strictEqual(input.value, "user kept typing", "a moved draft is never overwritten");

  // A completion that names no open request is ignored entirely.
  h.post({ type: "promptHistorySelected", requestId: "ph-again", sessionId: "s1" });
  await h.settle(10);

  // The completed request released the composer, so a fresh invocation asks again.
  input.value = "draft at click";
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  const req2 = h.posted.filter((m) => m.type === "promptHistory").pop();
  assert.notStrictEqual(req2.requestId, req.requestId, "a fresh request got a fresh id");
  h.post({ type: "promptHistorySelected", requestId: req2.requestId, sessionId: "other", text: "old prompt" });
  await h.settle(20);
  assert.strictEqual(input.value, "draft at click", "a foreign session's pick is ignored");

  h.post({ type: "promptHistorySelected", requestId: req2.requestId, sessionId: "s1" });
  await h.settle(20);
  assert.strictEqual(input.value, "draft at click", "an empty answer changes nothing");
  assert.strictEqual(h.errors().length, 0);
});

test("session search sends a query and renders server matches without title filtering", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);

  h.document.getElementById("list-search-btn").click();
  await h.settle(10);
  const inp = h.document.querySelector(".dv-floater input");
  assert.ok(inp, "the search box opened");
  inp.value = "needle";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));

  assert.ok(await h.until(() => h.posted.some((m) => m.type === "querySessions"), 2000),
    "the query reached the host");
  const req = h.posted.filter((m) => m.type === "querySessions").pop();
  assert.strictEqual(req.query, "needle");
  assert.strictEqual(req.orderBy, "updated_at");
  assert.strictEqual(req.sortDirection, "desc");

  // A content match whose title does not contain the query must still render:
  // the server already decided what matches.
  h.post({ type: "sessionSearchResults", requestId: req.requestId,
    sessions: [{ id: "b", short_id: "b", title: "Beta chat", working_directory: "/w",
      last_activity_at: 200, created_at: 50 }],
    capabilities: { contentSearch: true, orderBy: ["updated_at", "created_at"], sortDirection: true },
    contentSearch: true, serverSorted: true });
  await h.settle(30);
  const titles = () => [...h.document.querySelectorAll("#sessions-list .session-title")].map((e) => e.textContent);
  assert.deepStrictEqual(titles(), ["Beta chat"], "the server match rendered without a title filter");

  // Clearing the query restores the cached list immediately.
  inp.value = "";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(30);
  assert.deepStrictEqual(titles().sort(), ["Alpha chat", "Beta chat"], "the base list is back");
  assert.strictEqual(h.errors().length, 0);
});

test("a superseded search answer never paints under the new query", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200 },
    { id: "c", short_id: "c", title: "Gamma chat", working_directory: "/w", last_activity_at: 300 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);
  const titles = () => [...h.document.querySelectorAll("#sessions-list .session-title")].map((e) => e.textContent);

  h.document.getElementById("list-search-btn").click();
  await h.settle(10);
  const inp = h.document.querySelector(".dv-floater input");
  inp.value = "alpha";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  assert.ok(await h.until(() => h.posted.filter((m) => m.type === "querySessions").length === 1, 2000),
    "the first query reached the host");
  const reqA = h.posted.filter((m) => m.type === "querySessions").pop();

  // The user changes the query while A's answer is still in flight. A's reply
  // lands inside the new debounce window and must be ignored outright: the
  // list keeps filtering the cached rows by the new text until B answers.
  inp.value = "beta";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.post({ type: "sessionSearchResults", requestId: reqA.requestId,
    sessions: [{ id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 }],
    capabilities: { contentSearch: true, orderBy: ["updated_at"], sortDirection: true },
    contentSearch: true, serverSorted: false });
  await h.settle(30);
  assert.deepStrictEqual(titles(), ["Beta chat"], "the stale answer painted nothing");
  const searching = h.document.querySelector("#sessions-list [role=status]");
  assert.ok(searching && searching.textContent === "Searching sessions...",
    "the pending query says it is searching");

  assert.ok(await h.until(() => h.posted.filter((m) => m.type === "querySessions").length === 2, 3000),
    "the second query went out after the debounce");
  const reqB = h.posted.filter((m) => m.type === "querySessions").pop();
  assert.strictEqual(reqB.query, "beta");
  h.post({ type: "sessionSearchResults", requestId: reqB.requestId,
    sessions: [{ id: "c", short_id: "c", title: "Gamma chat", working_directory: "/w",
      last_activity_at: 300, created_at: 10, tracked: true }],
    capabilities: { contentSearch: true, orderBy: ["updated_at"], sortDirection: true },
    contentSearch: true, serverSorted: false });
  await h.settle(30);
  assert.deepStrictEqual(titles(), ["Gamma chat"], "the latest answer rendered, unfiltered by title");

  // A routine sessions push keeps the accepted matches: the base list is
  // refreshed underneath without discarding them.
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200 },
    { id: "c", short_id: "c", title: "Gamma chat", working_directory: "/w", last_activity_at: 350 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);
  assert.deepStrictEqual(titles(), ["Gamma chat"], "the refresh kept the valid match");

  // When the authoritative list drops the matched id, the remote row goes
  // with it: membership stays the host's call, not the search answer's.
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);
  const empty = h.document.querySelector("#sessions-list .sessions-empty-sm");
  assert.ok(empty && empty.textContent === "No matching sessions",
    "a pruned match leaves an honest empty state, not 'No chats yet'");
  assert.strictEqual(h.errors().length, 0);
});

test("a failed session search falls back to the local list and shows the error", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);

  h.document.getElementById("list-search-btn").click();
  await h.settle(10);
  const inp = h.document.querySelector(".dv-floater input");
  inp.value = "zzz-no-title-match";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  assert.ok(await h.until(() => h.posted.some((m) => m.type === "querySessions"), 2000));
  const req = h.posted.filter((m) => m.type === "querySessions").pop();

  h.post({ type: "sessionSearchResults", requestId: req.requestId,
    capabilities: { contentSearch: false, orderBy: [], sortDirection: false },
    contentSearch: false, serverSorted: false, error: "Could not search sessions." });
  await h.settle(30);
  const notes = [...h.document.querySelectorAll("#sessions-list .sessions-empty-sm")].map((e) => e.textContent);
  assert.ok(notes.includes("No matching sessions"), "no title match is an honest empty state");
  assert.ok(notes.includes("Could not search message content. Showing title and ID matches."),
    "the fallback is explained even when nothing matched");
  assert.ok(!h.document.getElementById("sessions-list").textContent.includes("zzz-no-title-match"),
    "the query text is never echoed into the list");
  assert.strictEqual(h.errors().length, 0);
});

test("an empty query can still ask the server for created order", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "capabilities", sessionList: { contentSearch: true, orderBy: ["updated_at", "created_at"], sortDirection: true } });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100, created_at: 300 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200, created_at: 100 },
    // "live" is a session the agent has not persisted yet: the sorted view
    // must keep it even though no server row will ever name it.
    { id: "live", short_id: "live", title: "Live chat", working_directory: "/w", last_activity_at: 50, created_at: 200 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);

  h.document.getElementById("list-filter-btn").click();
  await h.settle(10);
  const click = (text) => [...h.document.querySelectorAll(".session-filter-menu .dv-menu-item")]
    .find((r) => r.textContent.trim() === text).click();
  click("Created");
  await h.settle(10);
  click("Ascending");
  await h.settle(10);

  assert.ok(await h.until(() => h.posted.some((m) => m.type === "querySessions"), 2000),
    "an empty query still reached the host for the sort");
  const req = h.posted.filter((m) => m.type === "querySessions").pop();
  assert.strictEqual(req.query, "");
  assert.strictEqual(req.orderBy, "created_at");
  assert.strictEqual(req.sortDirection, "asc");

  // The agent only persisted a and b. live stays because the authoritative
  // list still knows it, and the merged rows order by creation ascending:
  // b(100), live(200), a(300).
  h.post({ type: "sessionSearchResults", requestId: req.requestId,
    sessions: [
      { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200, created_at: 100, tracked: true },
      { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100, created_at: 300, tracked: true }
    ],
    capabilities: { contentSearch: true, orderBy: ["updated_at", "created_at"], sortDirection: true },
    contentSearch: false, serverSorted: true });
  await h.settle(30);
  const titles = () => [...h.document.querySelectorAll("#sessions-list .session-title")].map((e) => e.textContent);
  assert.deepStrictEqual(titles(), ["Beta chat", "Live chat", "Alpha chat"],
    "merged rows sort by creation ascending and the live session is retained");

  // A later answer reporting reduced support resets the selections the menus
  // can no longer offer. The menu is still open from the picks above.
  click("Descending");
  await h.settle(10);
  assert.ok(await h.until(() => h.posted.filter((m) => m.type === "querySessions").length === 2, 2000),
    "the direction change asked again");
  const req2 = h.posted.filter((m) => m.type === "querySessions").pop();
  h.post({ type: "sessionSearchResults", requestId: req2.requestId,
    sessions: [
      { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100, created_at: 300, tracked: true },
      { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200, created_at: 100, tracked: true }
    ],
    capabilities: { contentSearch: true, orderBy: ["updated_at"], sortDirection: false },
    contentSearch: false, serverSorted: false });
  await h.settle(30);
  // Reopen the menu so it rebuilds against the reduced capabilities.
  h.document.getElementById("list-filter-btn").click();
  await h.settle(10);
  h.document.getElementById("list-filter-btn").click();
  await h.settle(10);
  const menuLabels = () => [...h.document.querySelectorAll(".session-filter-menu .dv-menu-item span")].map((s) => s.textContent);
  assert.ok(!menuLabels().includes("Created"), "Created is gone once unadvertised");
  assert.ok(!menuLabels().includes("Ascending") && !menuLabels().includes("Descending"),
    "and so is the direction group");
  const checked = [...h.document.querySelectorAll(".session-filter-menu .dv-menu-item.checked span")].map((s) => s.textContent);
  assert.ok(checked.includes("Last activity"), "the sort fell back to activity");
  assert.strictEqual(h.errors().length, 0);
});

test("a failed search with title matches still says it fell back", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 },
    { id: "b", short_id: "b", title: "Beta chat", working_directory: "/w", last_activity_at: 200 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);

  h.document.getElementById("list-search-btn").click();
  await h.settle(10);
  const inp = h.document.querySelector(".dv-floater input");
  inp.value = "alpha";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  assert.ok(await h.until(() => h.posted.some((m) => m.type === "querySessions"), 2000));
  const req = h.posted.filter((m) => m.type === "querySessions").pop();

  h.post({ type: "sessionSearchResults", requestId: req.requestId,
    capabilities: { contentSearch: false, orderBy: [], sortDirection: false },
    contentSearch: false, serverSorted: false, error: "Could not search sessions." });
  await h.settle(30);
  const titles = () => [...h.document.querySelectorAll("#sessions-list .session-title")].map((e) => e.textContent);
  assert.deepStrictEqual(titles(), ["Alpha chat"], "the title match still rendered");
  const notes = [...h.document.querySelectorAll("#sessions-list .sessions-empty-sm")].map((e) => e.textContent);
  assert.ok(notes.includes("Could not search message content. Showing title and ID matches."),
    "the fallback is explained beside the rows, not hidden by them");
  assert.strictEqual(h.errors().length, 0);
});

test("a content search with zero server hits says no matching sessions", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  h.post({ type: "sessions", sessions: [
    { id: "a", short_id: "a", title: "Alpha chat", working_directory: "/w", last_activity_at: 100 }
  ], activeId: null, folders: [{ path: "/w", name: "w" }] });
  await h.settle(30);

  h.document.getElementById("list-search-btn").click();
  await h.settle(10);
  const inp = h.document.querySelector(".dv-floater input");
  inp.value = "nothing-matches-this";
  inp.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  assert.ok(await h.until(() => h.posted.some((m) => m.type === "querySessions"), 2000));
  const req = h.posted.filter((m) => m.type === "querySessions").pop();

  h.post({ type: "sessionSearchResults", requestId: req.requestId,
    sessions: [],
    capabilities: { contentSearch: true, orderBy: ["updated_at"], sortDirection: true },
    contentSearch: true, serverSorted: false });
  await h.settle(30);
  const empty = h.document.querySelector("#sessions-list .sessions-empty-sm");
  assert.ok(empty && empty.textContent === "No matching sessions",
    "zero content hits is not 'No chats yet' while the base list is nonempty");
  assert.strictEqual(h.errors().length, 0);
});

test("only the matching prompt history reply releases the composer", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "s1" });
  await h.settle(20);

  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  const req = h.posted.filter((m) => m.type === "promptHistory").pop();
  assert.ok(req, "the command asked the host for history");

  // An unrelated completion must not unlock the picker that is still open.
  h.post({ type: "promptHistorySelected", requestId: "ph-unrelated", sessionId: "s1" });
  await h.settle(10);
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  assert.strictEqual(h.posted.filter((m) => m.type === "promptHistory").length, 1,
    "a stale reply leaves the picker locked");

  h.post({ type: "promptHistorySelected", requestId: req.requestId, sessionId: "s1" });
  await h.settle(10);
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  assert.strictEqual(h.posted.filter((m) => m.type === "promptHistory").length, 2,
    "the matching reply released it");
  assert.strictEqual(h.errors().length, 0);
});

test("a prompt history failure is announced, never auto-sent", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "s1" });
  await h.settle(20);

  const input = h.document.getElementById("input");
  input.value = "keep me";
  h.post({ type: "showPromptHistory" });
  await h.settle(10);
  const req = h.posted.filter((m) => m.type === "promptHistory").pop();

  h.post({ type: "promptHistorySelected", requestId: req.requestId, sessionId: "s1",
    error: "Could not load prompt history." });
  await h.settle(20);
  const said = h.document.querySelector("#announcer").textContent.replace(/\u200b/g, "");
  assert.strictEqual(said, "Could not load prompt history.", "the safe error was announced");
  assert.strictEqual(input.value, "keep me", "and the draft was untouched");
  assert.strictEqual(h.posted.filter((m) => m.type === "send" || m.type === "sendQueuedNow").length, 0,
    "a failed picker never sends anything by itself");
  assert.strictEqual(h.errors().length, 0);
});

test("a reported background shell gets a stop control only for the session on screen", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "s1" });
  h.post({ type: "toolCall", id: "tc1", title: "sleep 90", kind: "execute", status: "in_progress",
    rawInput: { command: "sleep 90" } });
  h.post({ type: "toolCallUpdate", id: "tc1", status: "in_progress" });
  await h.settle(30);

  // No authorization yet: transcript data alone never grows a stop button.
  assert.strictEqual(h.document.querySelector('button[title="Stop Background Command"]'), null,
    "a tool row without registry state has no stop control");

  // A publish for a different session does not authorize this one either.
  h.post({ type: "backgroundShells", sessionId: "other", items: [{ toolCallId: "tc1", stopping: false }] });
  await h.settle(20);
  assert.strictEqual(h.document.querySelector('button[title="Stop Background Command"]'), null,
    "another session's registry is not this session's");

  h.post({ type: "backgroundShells", sessionId: "s1", items: [{ toolCallId: "tc1", stopping: false }] });
  await h.settle(20);
  const stop = h.document.querySelector('button[title="Stop Background Command"]');
  assert.ok(stop, "the stop control appeared once authorized");
  stop.click();
  await h.settle(10);
  const req = h.posted.filter((m) => m.type === "stopBackgroundShell").pop();
  assert.deepStrictEqual(req, { type: "stopBackgroundShell", sessionId: "s1", toolCallId: "tc1" });

  // While the stop is in flight the control is disabled, and a failure offers
  // the inline error with a retry.
  h.post({ type: "backgroundShells", sessionId: "s1", items: [{ toolCallId: "tc1", stopping: true }] });
  await h.settle(20);
  const stopping = h.document.querySelector('button[title="Stopping…"]');
  assert.ok(stopping, "the in flight state is labelled");
  assert.strictEqual(stopping.disabled, true, "and cannot be double clicked");

  h.post({ type: "backgroundShells", sessionId: "s1",
    items: [{ toolCallId: "tc1", stopping: false, error: "Could not stop the background command." }] });
  await h.settle(20);
  const err = h.document.querySelector(".tool-bg-error");
  assert.ok(err, "the failure is shown beside the retry");
  assert.strictEqual(err.textContent, "Could not stop the background command.");
  assert.strictEqual(h.document.querySelector('button[title="Stop Background Command"]').disabled, false,
    "retry is available");

  // A successful stop clears the authorization and marks the row, which then
  // replays as plain history with no control.
  h.post({ type: "backgroundShells", sessionId: "s1", items: [] });
  h.post({ type: "toolCallUpdate", id: "tc1", status: "cancelled", stopped: true });
  await h.settle(30);
  assert.strictEqual(h.document.querySelector('button[title="Stop Background Command"]'), null,
    "the control is gone once the shell is stopped");
  assert.ok(h.thread().textContent.includes("Stopped"), "the row reads Stopped");
  assert.strictEqual(h.errors().length, 0);
});

test("session lifecycle: a send from the starter page hides the welcome before the host echoes", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome-chip").length, 4, "the starter prompts are up");

  const input = h.document.getElementById("input");
  input.value = "first message";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  // The welcome disappears synchronously before any host reply can land.
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "the welcome hid on send");
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "send").map((m) => ({ text: m.text, newSession: m.newSession })),
    [{ text: "first message", newSession: false }],
    "the starter page sends into the session being created, not a new one"
  );

  // The host's pending clear and a load completion land before the echo.
  h.post({ type: "clear", pendingSend: true });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "the pending clear must not restore the welcome");
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "loaded must not bring the welcome back");

  h.post({ type: "userMessage", text: "first message" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["first message"], "exactly one request bubble");
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0);
  // The turn finishes before the next fresh start, the way a real session's
  // does, so the welcome is not held down by a busy flag that never cleared.
  h.post({ type: "busy", value: false });
  await h.settle(10);

  // An explicit fresh start shows the starter prompts again.
  h.post({ type: "clear", reset: true });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome-chip").length, 4, "the starter prompts return on reset");
  assert.strictEqual(h.errors().length, 0);
});

test("session lifecycle: a sessionless pending send does not suppress the next empty session's prompts", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "list" });
  const input = h.document.getElementById("input");
  input.value = "from the list";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "send").map((m) => ({ text: m.text, newSession: m.newSession })),
    [{ text: "from the list", newSession: true }],
    "the list composer asks for a new session"
  );
  // No session is mounted yet (curSessionId is still null), so the pending
  // send must not leak into whatever view is selected next.
  h.post({ type: "clear", pendingSend: true });
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "the pending send holds the welcome down");

  // Before the echo lands, the user opens a different, still empty session
  // straight from a picker: its starter prompts are not the pending send's to
  // suppress.
  h.post({ type: "openSession", id: "empty-b" });
  h.post({ type: "clear", loading: true });
  h.post({ type: "loaded" });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome-chip").length, 4, "the empty session's starter prompts are not suppressed");
  assert.strictEqual(h.errors().length, 0);
});

test("session lifecycle: a partial replay snapshot asks for loading instead of restoring half a transcript", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "C", title: "C" });
  h.post({ type: "userMessage", text: "from C" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "answer C" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  // P only ever reports "idle" and Q reports "running", so the page's own
  // loading flag is the only thing that can mark their snapshots partial.
  h.post({ type: "sessionStatuses", statuses: { C: "idle", P: "idle", Q: "running" }, activeId: null });
  await h.settle(10);
  const switchTo = (id) => h.post({ type: "openSession", id });
  const loadsFor = (id) => h.posted.filter((m) => m.type === "loadSession" && m.id === id).length;
  const partialReplay = async (userText) => {
    // The load the page asked for starts replaying but never finishes: no
    // "loaded" ever arrives, which is exactly the snapshot being left behind.
    h.post({ type: "userMessage", text: userText });
    h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "partial answer" });
    await h.settle(10);
    assert.ok(h.thread().classList.contains("loading-replay"), "the replay freeze is up");
    assert.ok(h.document.querySelector("#thread .thread-loading"), "the spinner is up");
  };

  // P is alive but not running, so only the page's loading flag can mark the
  // snapshot partial.
  switchTo("P");
  assert.strictEqual(loadsFor("P"), 1, "an unseen session asks for a load");
  await partialReplay("partial p");
  switchTo("C");
  assert.ok(!h.thread().classList.contains("loading-replay"), "the restored session carries no replay freeze");
  assert.strictEqual(h.document.querySelector("#thread .thread-loading"), null, "and no leftover spinner");
  assert.deepStrictEqual(h.reqTexts(), ["from C"], "the cached transcript is whole");
  switchTo("P");
  assert.strictEqual(loadsFor("P"), 2, "the partial snapshot asks for a fresh load rather than restoring");
  assert.ok(h.thread().classList.contains("loading-replay"), "the new load shows its spinner");
  assert.ok(!h.thread().textContent.includes("partial p"), "the partial transcript is not restored");

  // Q is running, which previously allowed restoring its partial transcript.
  switchTo("Q");
  assert.strictEqual(loadsFor("Q"), 1);
  await partialReplay("partial q");
  switchTo("C");
  assert.ok(!h.thread().classList.contains("loading-replay"), "the restored session carries no replay freeze");
  switchTo("Q");
  assert.strictEqual(loadsFor("Q"), 2, "a running session with a partial snapshot reloads instead of re-attaching");
  assert.ok(!h.posted.some((m) => m.type === "activateSession" && m.id === "Q"), "no re-attach to a partial transcript");
  assert.ok(h.thread().classList.contains("loading-replay"), "the new load shows its spinner");
  assert.ok(!h.thread().textContent.includes("partial q"), "the partial transcript is not restored");
  assert.strictEqual(h.errors().length, 0);
});

test("session lifecycle: a first turn resend keeps the welcome down until its echo", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "original", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  // Editing the only turn rewinds to the checkpoint before it inside THIS
  // session: the page must hold the welcome down across the rewind and the
  // resend's echo.
  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  assert.ok(ta, "the editor is open");
  ta.value = "edited first turn";
  ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(10);
  const preview = h.posted.filter((m) => m.type === "revertPreview").pop();
  assert.ok(preview && preview.userMessageId === "m1" && preview.sessionId === "S", "the edit previews its checkpoint by prompt id");
  h.post({
    type: "revertPreview",
    token: preview.token,
    sessionId: preview.sessionId,
    userMessageId: preview.userMessageId,
    result: { fileActions: [], irreversibleWarnings: [], conflicts: [] },
    pendingFiles: 0
  });
  await h.settle(10);
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "revertExecute").pop(),
    { type: "revertExecute", sessionId: "S", userMessageId: "m1", resendText: "edited first turn" },
    "the first turn resend rewinds inside the same session"
  );

  // The host confirms the rewind and the resend is on its way: no clear, no new
  // session, and nothing may flash the welcome in the gap before the echo.
  h.post({ type: "reverted", sessionId: "S", userMessageId: "m1", resending: true });
  await h.settle(10);
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "no welcome flash while the resend is on its way");
  assert.strictEqual(h.reqTexts().length, 0, "the rewound turn is gone before the echo");
  h.post({ type: "userMessage", text: "edited first turn", clientMessageId: "m2" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["edited first turn"], "the resend is the only request");
  assert.strictEqual(h.errors().length, 0);
});

test("session lifecycle: restoring the first turn shows the welcome on the same session", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "original", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  // Restoring the only turn rewinds to the checkpoint before it in THIS
  // session: the prompt text goes back to the composer and the emptied chat
  // shows its starter prompts like any other empty session.
  const btn = h.document.querySelector("#thread .checkpoint-restore");
  assert.ok(btn, "the first turn offers a restore");
  btn.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await h.settle(10);
  const preview = h.posted.filter((m) => m.type === "revertPreview").pop();
  assert.ok(preview && preview.userMessageId === "m1" && preview.sessionId === "S", "the restore previews its checkpoint by prompt id");
  h.post({
    type: "revertPreview",
    token: preview.token,
    sessionId: preview.sessionId,
    userMessageId: preview.userMessageId,
    result: { fileActions: [], irreversibleWarnings: [], conflicts: [] },
    pendingFiles: 0
  });
  await h.settle(10);
  assert.deepStrictEqual(
    h.posted.filter((m) => m.type === "revertExecute").pop(),
    { type: "revertExecute", sessionId: "S", userMessageId: "m1" },
    "the first turn restore rewinds inside the same session without a resend"
  );

  // The host confirms on the same session: the turn is trimmed, the restored
  // divider shows, and the emptied thread gets its welcome back.
  h.post({ type: "reverted", sessionId: "S", userMessageId: "m1", resending: false });
  await h.settle(10);
  assert.strictEqual(h.reqTexts().length, 0, "the rewound turn is gone");
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome-chip").length, 4, "the emptied session shows its starter prompts");
  assert.strictEqual(h.document.getElementById("input").value, "original", "the prompt text returned to the composer");
  assert.strictEqual(h.errors().length, 0);
});

test("reported regressions: keys typed inside the inline editor do not fire the bubble shortcuts", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  assert.ok(ta, "the editor is open");

  // Every key typed into the editor bubbles up through the request bubble. The
  // bubble's own shortcuts (Space/Enter to edit, Delete/Backspace to restore)
  // must only answer for the bubble itself: jsdom has no native typing, so the
  // defaultPrevented flag is what proves the key was left alone.
  for (const init of [
    { key: " " },
    { key: "Backspace" },
    { key: "Delete" },
    { key: "ArrowLeft" },
    { key: "Enter", shiftKey: true }
  ]) {
    const e = new h.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    ta.dispatchEvent(e);
    assert.strictEqual(e.defaultPrevented, false, `${init.key} was swallowed by the bubble shortcut`);
  }
  assert.strictEqual(h.posted.filter((m) => m.type === "revertPreview" || m.type === "revertExecute" || m.type === "send" || m.type === "newSession").length, 0, "a typed key asked for a revert or a send");
  assert.ok(h.document.querySelector(".req-editor-input"), "the editor is still open");

  // Escape remains the editor's own cancel.
  const esc = new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  ta.dispatchEvent(esc);
  await h.settle(5);
  assert.ok(!h.document.querySelector(".req-editor-input"), "Escape closed the editor");
  assert.strictEqual(h.errors().length, 0);
});

test("reported regressions: submitting an unchanged inline edit is a no op", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  assert.ok(ta, "the editor is open");
  // The text is untouched: pressing Enter must close the editor without
  // rewinding the conversation or resending the same prompt.
  ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);

  assert.ok(!h.document.querySelector(".req-editor-input"), "the editor closed");
  assert.strictEqual(h.posted.filter((m) => m.type === "revertPreview" || m.type === "revertExecute" || m.type === "send" || m.type === "newSession").length, 0, "an unchanged edit still asked for a rewind");
  assert.deepStrictEqual(h.reqTexts(), ["first"], "the transcript is unchanged");
  assert.strictEqual(h.document.querySelectorAll("#thread .welcome").length, 0, "no welcome appeared");
  assert.strictEqual(h.errors().length, 0);
});

test("reported regressions: submitting unchanged text while editing in the composer is a no op", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "input", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  // editRequests:"input" loads the request into the composer with a banner.
  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  assert.strictEqual(h.document.getElementById("input").value, "first", "the request loaded into the composer");
  assert.ok(h.document.getElementById("input-editing-banner"), "the editing banner is shown");

  // Sending the untouched text cancels the edit instead of rewinding and
  // resending the same prompt into a different session.
  h.document.getElementById("input").dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);

  assert.ok(!h.document.getElementById("input-editing-banner"), "the editing banner cleared");
  assert.strictEqual(h.posted.filter((m) => m.type === "revertPreview" || m.type === "revertExecute" || m.type === "send" || m.type === "newSession").length, 0, "an unchanged edit still asked for a rewind");
  assert.deepStrictEqual(h.reqTexts(), ["first"], "the transcript is unchanged");
  assert.strictEqual(h.errors().length, 0);
});

test("reported regressions: optimistic and canonical echoes of one send render once", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "hello", clientMessageId: "m1" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["hello"]);

  // The canonical echo of the same send repeats the id: it must not paint a
  // second bubble for a message already on screen.
  h.post({ type: "userMessage", text: "hello", clientMessageId: "m1" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["hello"], "the canonical echo painted a second bubble");

  // The same text sent again is a different message: a new id renders normally.
  h.post({ type: "userMessage", text: "hello", clientMessageId: "m2" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["hello", "hello"], "an intentional repeat did not render");

  // An echo without an id keeps the old behavior: it always renders.
  h.post({ type: "userMessage", text: "hello" });
  await h.settle(10);
  assert.strictEqual(h.reqTexts().length, 3, "an idless echo was deduped");
  // Settle the turns so the snapshot taken on the way out is a clean one.
  h.post({ type: "busy", value: false });
  await h.settle(10);

  // Leave for the list and come back: the cached view keeps each turn's dedupe
  // key, so the host's replayed canonical copy still cannot double a bubble.
  h.post({ type: "sessions", sessions: [{ id: "S", short_id: "S", title: "S", working_directory: "/w" }], activeId: "S", statuses: { S: "idle" } });
  h.post({ type: "body", body: "list" });
  await h.settle(10);
  h.post({ type: "openSession", id: "S" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["hello", "hello", "hello"], "the restored view kept its turns");
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "replay", items: [
    { type: "userMessage", text: "hello", clientMessageId: "m1" },
    { type: "userMessage", text: "hello", clientMessageId: "m2" }
  ] });
  await h.settle(10);
  assert.strictEqual(h.reqTexts().length, 3, "a replayed canonical echo doubled a bubble");

  // A full reload replay dedupes the same way: the recorded copy carries the id.
  h.post({ type: "clear" });
  h.post({ type: "replay", items: [
    { type: "userMessage", text: "hello", clientMessageId: "m1" },
    { type: "userMessage", text: "hello", clientMessageId: "m1" }
  ] });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["hello"], "a replayed duplicate was not deduped");
  assert.strictEqual(h.errors().length, 0);
});

test("reported regressions: a sessionReady while browsing the list does not claim the transcript", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  await h.settle(10);

  // A chat that finishes starting while the user browses the list must not take
  // over the view state: only a real selection (which sets the thread body)
  // claims the mounted transcript.
  h.post({ type: "sessionReady", sessionId: "S", title: "Late chat" });
  await h.settle(10);
  assert.notStrictEqual(h.state()?.sessionId, "S", "the list view claimed the late session");
  assert.strictEqual(h.document.querySelectorAll("#thread .turn").length, 0, "a transcript was claimed while listing");

  // The same announcement lands once the view is actually showing a chat.
  h.post({ type: "body", body: "thread" });
  h.post({ type: "sessionReady", sessionId: "S", title: "Late chat" });
  await h.settle(10);
  assert.strictEqual(h.state()?.sessionId, "S", "the mounted chat did not take its ready announcement");
  assert.strictEqual(h.errors().length, 0);
});

test("review regressions: a failed checkpoint check keeps the edited message in its editor", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "original", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  assert.ok(ta, "the editor is open");
  ta.value = "edited first turn";
  ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(10);
  const preview = h.posted.filter((m) => m.type === "revertPreview").pop();
  assert.ok(preview && preview.userMessageId === "m1" && preview.sessionId === "S", "the edit asked for its checkpoint");

  // The host cannot answer the checkpoint check: the edit must not proceed as
  // if the rewind were safe, and the editor keeps the typed text.
  h.post({ type: "revertPreview", token: preview.token, sessionId: preview.sessionId, userMessageId: preview.userMessageId, error: "checkpoint unavailable" });
  await h.settle(10);

  const still = h.document.querySelector(".req-editor-input");
  assert.ok(still, "the editor stayed open");
  assert.strictEqual(still.value, "edited first turn", "the edited text was kept");
  assert.strictEqual(h.posted.filter((m) => m.type === "revertExecute" || m.type === "send" || m.type === "newSession").length, 0,
    "the failed check still rewound or sent");
  const card = h.document.querySelector(".error-card");
  assert.ok(card && card.textContent.includes("checkpoint unavailable"), "the failure was not shown");
  assert.strictEqual(h.errors().length, 0);
});

test("review regressions: a timed out checkpoint check keeps the composer edit and says so", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "input", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "original", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);

  // editRequests:"input" loads the request into the composer with a banner.
  h.document.querySelector("#thread .turn-request .req-body").click();
  await h.settle(5);
  const input = h.document.getElementById("input");
  assert.strictEqual(input.value, "original", "the request loaded into the composer");
  input.value = "edited in composer";
  input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await h.settle(10);
  const preview = h.posted.filter((m) => m.type === "revertPreview").pop();
  assert.ok(preview && preview.userMessageId === "m1" && preview.sessionId === "S", "the edit asked for its checkpoint");

  // No answer ever arrives: the check must time out into a visible error, not
  // into a rewind.
  assert.ok(await h.until(() => !!h.document.querySelector(".error-card"), 6000), "the timeout never surfaced");
  assert.ok(h.document.querySelector(".error-card").textContent.includes("timed out"), "the timeout was not explained");
  assert.ok(h.document.getElementById("input-editing-banner"), "the composer edit was cancelled");
  assert.strictEqual(input.value, "edited in composer", "the edited text was kept");
  assert.strictEqual(h.posted.filter((m) => m.type === "revertExecute" || m.type === "send" || m.type === "newSession").length, 0,
    "the timed out check still rewound or sent");
  assert.strictEqual(h.errors().length, 0);
});

test("checkpoint identity: bindings that land before the replay chunks still bind every turn", async () => {
  // The agent's step list can reach the page while the replay is still
  // streaming. It must be stored rather than dropped, and the chrome built
  // once loading ends has to pick it up without a second identical frame.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear", loading: true });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  bindCheckpoints(h, "S", ["m1", "m2", "m3"]);
  h.post({ type: "userChunk", text: "one", messageId: "m1" });
  h.post({ type: "assistantChunk", text: "a1" });
  h.post({ type: "userChunk", text: "two", messageId: "m2" });
  h.post({ type: "assistantChunk", text: "a2" });
  h.post({ type: "userChunk", text: "three", messageId: "m3" });
  h.post({ type: "assistantChunk", text: "a3" });
  h.post({ type: "loaded" });
  await h.settle(20);

  const rows = () => [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")];
  assert.strictEqual(rows().length, 3, "bindings stored during loading still produce rows");
  // The host republishes the same list once the load settles: an identical
  // frame must leave the correct rows alone.
  bindCheckpoints(h, "S", ["m1", "m2", "m3"]);
  await h.settle(20);
  assert.strictEqual(rows().length, 3, "an identical post-loaded frame keeps the rows");
  assert.strictEqual(rows()[0].querySelector(".checkpoint-fork"), null, "the first prompt has no fork");
  assert.ok(rows()[1].querySelector(".checkpoint-fork") && rows()[2].querySelector(".checkpoint-fork"),
    "later prompts offer fork");
  assert.strictEqual(h.errors().length, 0, "binding handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: three turns show no controls until the step list names them", async () => {
  // Two replayed prompts and one live send, none bound: the page must not
  // invent checkpoint targets from the transcript it happens to hold.
  const h = createHarness();
  h.replay([
    { role: "user", text: "one", mid: "m1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "two", mid: "m2" },
    { role: "assistant", text: "a2" }
  ]);
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "three", clientMessageId: "m3" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a3" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(20);

  const rows = () => [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")];
  const editable = () => [...h.document.querySelectorAll("#thread .turn-request.editable-inline .req-text")]
    .map((e) => e.textContent.trim());
  assert.strictEqual(rows().length, 0, "no restore rows before bindings arrive");
  assert.deepStrictEqual(editable(), [], "nothing is editable either");

  bindCheckpoints(h, "S", ["m1", "m2", "m3"]);
  await h.settle(20);
  assert.strictEqual(rows().length, 3, "all three named prompts bind");
  assert.deepStrictEqual(editable().sort(), ["one", "three", "two"], "every bound turn is editable");
  assert.strictEqual(rows()[0].querySelector(".checkpoint-fork"), null, "the first prompt cannot fork");
  assert.ok(rows()[1].querySelector(".checkpoint-fork") && rows()[2].querySelector(".checkpoint-fork"),
    "the later prompts fork");
  assert.strictEqual(h.errors().length, 0, "binding handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: busy, checkpointBusy and a pending send each hold the controls off", async () => {
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(20);
  const rows = () => [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")];
  assert.strictEqual(rows().length, 2, "bound turns show their rows");

  // A turn running on the agent.
  h.post({ type: "busy", value: true });
  await h.settle(10);
  assert.strictEqual(rows().length, 0, "busy hides the rows");
  h.post({ type: "busy", value: false });
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "the rows return when the turn ends");

  // A rewind in flight: same bindings, busy flag raised.
  bindCheckpoints(h, "S", ["m1", "m2"], true);
  await h.settle(10);
  assert.strictEqual(rows().length, 0, "a checkpoint rewind holds the rows off");
  bindCheckpoints(h, "S", ["m1", "m2"], false);
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "the rows return when the rewind ends");

  // A message on its way to the agent.
  const input = h.document.getElementById("input");
  input.value = "next";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  await h.settle(10);
  assert.strictEqual(rows().length, 0, "a pending send holds the rows off");
  h.post({ type: "userMessage", text: "next", clientMessageId: "m3" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a3" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "only the named turns bind; the new one waits for the list");
  assert.strictEqual(h.errors().length, 0, "gate handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: a focused turn's stale row disables and re-enables in place", async () => {
  // Focus inside a turn defers its chrome rebuild, but the checkpoint row must
  // still follow eligibility: a Restore that went stale while focused cannot
  // stay armed, and a button that came back must be the same element. The
  // checkpointBusy flag is used rather than a turn boundary because ending a
  // turn legitimately hands focus back to the composer.
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(20);
  const turnEls = () => [...h.document.querySelectorAll("#thread .turn")];
  const rowOf = (i) => turnEls()[i].querySelector(".checkpoint-row");
  const btnOf = (i) => rowOf(i).querySelector(".checkpoint-restore");

  const restoreBtn = btnOf(1);
  restoreBtn.focus();
  assert.strictEqual(h.document.activeElement, restoreBtn, "the restore button holds focus");

  bindCheckpoints(h, "S", ["m1", "m2"], true);
  await h.settle(10);
  assert.ok(restoreBtn.disabled, "the focused row's button disabled in place");
  assert.ok(rowOf(1).classList.contains("hidden"), "the focused row hid in place");
  assert.strictEqual(h.document.activeElement, restoreBtn, "focus was not dropped");

  bindCheckpoints(h, "S", ["m1", "m2"], false);
  await h.settle(10);
  assert.strictEqual(btnOf(1), restoreBtn, "the retained row kept its button element");
  assert.ok(!restoreBtn.disabled, "the button re-enabled in place");
  assert.ok(!rowOf(1).classList.contains("hidden"), "the row is visible again");
  assert.strictEqual(h.document.activeElement, restoreBtn, "focus stayed on the button");

  // Copy focus is preserved the same way: the deferred chrome rebuild never
  // replaces the button the keyboard user is standing on.
  const copyBtn = turnEls()[0].querySelector(".chat-footer .dv-copy");
  assert.ok(copyBtn, "the first turn has a Copy button");
  copyBtn.focus();
  bindCheckpoints(h, "S", ["m1", "m2"], true);
  await h.settle(10);
  bindCheckpoints(h, "S", ["m1", "m2"], false);
  await h.settle(10);
  assert.strictEqual(h.document.activeElement, copyBtn, "Copy kept focus through the toggle");
  assert.strictEqual(turnEls()[0].querySelector(".chat-footer .dv-copy"), copyBtn,
    "the deferred rebuild never replaced it");
  assert.strictEqual(h.errors().length, 0, "focused chrome handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: foreign and unscoped frames never touch the open chat", async () => {
  const h = createHarness();
  twoLiveTurns(h);
  await h.settle(20);
  const rows = () => [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")];
  assert.strictEqual(rows().length, 2);

  // A frame for another session is stale transport: bindings, busy and trims
  // all belong to the session they name.
  h.post({ type: "checkpoints", sessionId: "OTHER", checkpoints: [{ userMessageId: "x9", canFork: true }], busy: true });
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "a foreign checkpoints frame changed nothing");
  assert.deepStrictEqual(h.reqTexts(), ["first", "second"], "the transcript is untouched");

  h.post({ type: "reverted", sessionId: "OTHER", userMessageId: "m2" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["first", "second"], "a foreign reverted frame trimmed nothing");

  // A reverted frame with no session at all cannot prove it means this chat.
  h.post({ type: "reverted", userMessageId: "m2" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["first", "second"], "an unscoped reverted frame trimmed nothing");
  assert.strictEqual(rows().length, 2, "and no binding was dropped");

  // The scoped frame for this session works, and removes only that turn.
  h.post({ type: "reverted", sessionId: "S", userMessageId: "m2" });
  await h.settle(10);
  assert.deepStrictEqual(h.reqTexts(), ["first"], "the scoped reverted frame trimmed from m2");
  assert.strictEqual(rows().length, 1, "only the surviving turn keeps a row");
  assert.strictEqual(h.errors().length, 0, "scoped frame handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: a cached return keeps bindings while a wake clears them until ready", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "userMessage", text: "first", clientMessageId: "m1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  h.post({ type: "userMessage", text: "second", clientMessageId: "m2" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a2" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "A", ["m1", "m2"]);
  h.post({ type: "sessionStatuses", statuses: { A: "idle", B: "idle" }, activeId: "A" });
  await h.settle(20);
  const rows = () => [...h.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)")];
  assert.strictEqual(rows().length, 2, "the live session's rows are up");

  const open = (id) => h.post({ type: "openSession", id });
  // Leave for another chat and come back while A is still alive: the cached
  // bindings come back with the transcript, no fresh frame needed.
  open("B");
  await h.settle(10);
  const framesBefore = h.posted.filter((m) => m.type === "checkpoints" && m.sessionId === "A").length;
  open("A");
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "the cached bindings restored the rows");
  assert.ok(h.posted.some((m) => m.type === "activateSession" && m.id === "A"), "the live session re-attached");
  assert.strictEqual(
    h.posted.filter((m) => m.type === "checkpoints" && m.sessionId === "A").length,
    framesBefore,
    "no new binding frame was needed"
  );

  // A goes dead: the cached copy still restores, but its bindings are stale
  // until the wake's step list lands, so the controls stay off meanwhile.
  h.post({ type: "sessionStatuses", statuses: {}, activeId: null });
  open("B");
  await h.settle(10);
  open("A");
  await h.settle(10);
  assert.ok(h.posted.some((m) => m.type === "wakeSession" && m.id === "A"), "the dead session woke in the background");
  assert.strictEqual(rows().length, 0, "stale bindings do not survive the wake");
  assert.deepStrictEqual(h.reqTexts(), ["first", "second"], "the transcript itself stayed");

  // The host's authoritative frame after the wake republishes the controls.
  bindCheckpoints(h, "A", ["m1", "m2"]);
  await h.settle(10);
  assert.strictEqual(rows().length, 2, "the republished bindings restore the rows");
  assert.strictEqual(h.errors().length, 0, "cached/wake handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: an armed restore confirmation stands down when the state changes", async () => {
  // The two step restore: the preview reports files the rewind leaves behind,
  // so the button morphs into a confirmation. Anything that invalidates the
  // state it was raised for must stand it back down, even while the row holds
  // focus and keeps its elements.
  const h = createHarness();
  twoLiveTurns(h);
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: true });
  await h.settle(20);
  const rowOf = () => h.document.querySelectorAll("#thread .turn")[1].querySelector(".checkpoint-row");
  const btnOf = () => rowOf().querySelector(".checkpoint-restore");
  const label = () => btnOf().querySelector("span").textContent;

  const restoreBtn = btnOf();
  restoreBtn.focus();
  restoreBtn.click();
  await h.settle(5);
  const asked = h.posted.filter((m) => m.type === "revertPreview");
  assert.strictEqual(asked.length, 1, "one preview request went out");
  assert.deepStrictEqual(
    { sessionId: asked[0].sessionId, userMessageId: asked[0].userMessageId },
    { sessionId: "S", userMessageId: "m2" },
    "the preview is scoped to the restored turn"
  );
  h.post({
    type: "revertPreview", token: asked[0].token,
    sessionId: asked[0].sessionId, userMessageId: asked[0].userMessageId,
    result: { fileActions: [], irreversibleWarnings: [] }, pendingFiles: 2
  });
  await h.settle(10);
  assert.strictEqual(label(), "Rewind Chat", "the confirmation is armed");
  assert.ok(rowOf().classList.contains("confirming"), "the row shows the armed state");

  // A rewind starting elsewhere invalidates it while the focused row keeps its
  // elements: the confirmation stands down in place rather than surviving. The
  // checkpointBusy flag stands in for the rewind so the composer keeps focus.
  bindCheckpoints(h, "S", ["m1", "m2"], true);
  await h.settle(10);
  assert.strictEqual(label(), "Restore Checkpoint", "checkpointBusy stood the confirmation down");
  assert.ok(!rowOf().classList.contains("confirming"), "the armed class is gone");
  bindCheckpoints(h, "S", ["m1", "m2"], false);
  await h.settle(10);
  assert.strictEqual(btnOf(), restoreBtn, "the focused row kept its button element");
  assert.strictEqual(label(), "Restore Checkpoint", "the button did not stay armed");
  assert.ok(!restoreBtn.disabled, "the retained button re-enabled");

  // A fresh click asks the host again instead of reusing the stale answer.
  restoreBtn.click();
  await h.settle(5);
  assert.strictEqual(h.posted.filter((m) => m.type === "revertPreview").length, 2,
    "a fresh preview was requested");
  assert.strictEqual(h.errors().length, 0, "confirmation handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: a send while a preview is in flight voids the late answer", async () => {
  // Submitting an edit asks the host what the rewind would discard. A normal
  // send before that answer lands makes the question stale: the late reply
  // must not rewind, resend, or touch the editor's text.
  const h = createHarness();
  twoLiveTurns(h);
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: true });
  await h.settle(20);
  h.document.querySelectorAll("#thread .turn-request .req-body")[1].click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  ta.value = "second, revised";
  ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(5);
  const asked = h.posted.filter((m) => m.type === "revertPreview");
  assert.strictEqual(asked.length, 1, "one preview request went out");
  assert.deepStrictEqual(
    { sessionId: asked[0].sessionId, userMessageId: asked[0].userMessageId },
    { sessionId: "S", userMessageId: "m2" },
    "the preview is scoped to the edited turn"
  );

  const input = h.document.getElementById("input");
  input.value = "a newer message";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.getElementById("send").click();
  await h.settle(10);

  h.post({
    type: "revertPreview", token: asked[0].token,
    sessionId: asked[0].sessionId, userMessageId: asked[0].userMessageId,
    result: { fileActions: [], irreversibleWarnings: [] }, pendingFiles: 0
  });
  await h.settle(20);
  assert.strictEqual(h.posted.filter((m) => m.type === "revertExecute").length, 0,
    "the stale preview still rewound");
  const editor = h.document.querySelector(".req-editor-input");
  assert.ok(editor, "the editor stayed open");
  assert.strictEqual(editor.value, "second, revised", "the edited text was kept");
  assert.strictEqual(h.errors().length, 0, "stale preview handling threw: " + JSON.stringify(h.errors()));
});

test("checkpoint identity: changed bindings cancel an armed confirmation and pending previews", async () => {
  // A bindings frame that actually changes the list invalidates every open
  // checkpoint question: an armed Restore stands down and a preview still in
  // flight is dropped, so neither can act on a transcript that moved.
  const h = createHarness();
  twoLiveTurns(h);
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: true });
  await h.settle(20);
  const rowOf = () => h.document.querySelectorAll("#thread .turn")[1].querySelector(".checkpoint-row");
  const btnOf = () => rowOf().querySelector(".checkpoint-restore");
  const label = () => btnOf().querySelector("span").textContent;

  btnOf().click();
  await h.settle(5);
  const asked = h.posted.filter((m) => m.type === "revertPreview");
  assert.strictEqual(asked.length, 1);
  h.post({
    type: "revertPreview", token: asked[0].token,
    sessionId: asked[0].sessionId, userMessageId: asked[0].userMessageId,
    result: { fileActions: [], irreversibleWarnings: [] }, pendingFiles: 2
  });
  await h.settle(10);
  assert.strictEqual(label(), "Rewind Chat", "the confirmation is armed");

  // The step list drops m2 (a rewind elsewhere, or the prompt was never a
  // checkpoint after all): the armed confirmation cannot outlive its target.
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);
  assert.ok(rowOf().classList.contains("hidden"), "the unbound turn's row hid");
  assert.ok(!rowOf().classList.contains("confirming"), "the armed state is gone");
  assert.strictEqual(rowOf().querySelector(".checkpoint-restore"), null,
    "no stale button survived the rebuild");

  // A preview asked before the change, answered after it, does nothing.
  h.post({ type: "userMessage", text: "third", clientMessageId: "m3" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a3" }); h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
  bindCheckpoints(h, "S", ["m1", "m3"]);
  await h.settle(10);
  const turn3 = h.document.querySelectorAll("#thread .turn")[2];
  turn3.querySelector(".turn-request .req-body").click();
  await h.settle(5);
  const ta = h.document.querySelector(".req-editor-input");
  ta.value = "third, revised";
  ta.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await h.settle(5);
  const pending = h.posted.filter((m) => m.type === "revertPreview").at(-1);
  assert.ok(pending, "a fresh preview went out for the new edit");
  // The bindings move again while the answer is in flight.
  bindCheckpoints(h, "S", ["m1"]);
  await h.settle(10);
  h.post({
    type: "revertPreview", token: pending.token,
    sessionId: pending.sessionId, userMessageId: pending.userMessageId,
    result: { fileActions: [], irreversibleWarnings: [] }, pendingFiles: 0
  });
  await h.settle(20);
  assert.strictEqual(h.posted.filter((m) => m.type === "revertExecute").length, 0,
    "the preview answered after the bindings changed still executed");
  assert.ok(h.document.querySelector(".req-editor-input"), "the editor kept the text");
  assert.strictEqual(h.errors().length, 0, "binding-change handling threw: " + JSON.stringify(h.errors()));
});

test("message persistence replayed user chunks accumulate their attachments", async () => {
  // A replayed request can arrive as several chunks, each carrying the
  // attachments that came with it. They collect on the one user block rather
  // than each chunk's array replacing the one before it.
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userChunk", text: "look at ", messageId: "m1", attachments: [{ label: "a.png", type: "image", thumb: "data:image/png;base64,AAA" }] });
  h.post({ type: "userChunk", text: "these", messageId: "m1", attachments: [{ label: "b.txt", type: "file" }] });
  h.post({ type: "userChunk", text: " and ", messageId: "m1" });
  h.post({ type: "userChunk", text: "those", messageId: "m1", attachments: [{ label: "c.md", type: "file" }] });
  await h.settle(20);

  const pills = [...h.thread().querySelectorAll(".chat-attached-context-attachment")];
  assert.deepStrictEqual(pills.map((p) => p.textContent), ["a.png", "b.txt", "c.md"],
    "every chunk's attachments are on the one request");
  assert.ok(pills[0].querySelector("img.chat-attached-context-pill-image"), "the thumbnail survived");
  assert.strictEqual(h.reqTexts().join(""), "look at these and those");
  assert.strictEqual(h.errors().length, 0);
});

test("message persistence a paused queue shows its banner and resume control", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "saved one", attachments: [{ label: "a.png", type: "image", thumb: "data:image/png;base64,AAA" }] },
    { id: "q2", kind: "queue", text: "saved two" }
  ], paused: true });
  await h.settle(20);

  const banner = h.document.getElementById("queue-resume");
  assert.ok(!banner.classList.contains("hidden"), "the paused queue shows its composer row");
  assert.match(banner.textContent, /Saved messages are paused\./);
  const composer = h.document.getElementById("composer");
  assert.strictEqual(banner.parentElement, composer);
  assert.ok(!h.thread().contains(banner), "the resume control stays outside the scrolling transcript");
  const children = [...composer.children];
  assert.ok(children.indexOf(banner) < children.indexOf(h.document.getElementById("input-box")), "the resume row sits above the input");
  const button = h.document.getElementById("resume-queue");
  assert.ok(button.classList.contains("btn") && !button.classList.contains("secondary"), "resume is a primary action");
  button.click();
  assert.strictEqual(h.posted.filter((m) => m.type === "resumeQueue").length, 1);
  assert.ok(!banner.classList.contains("hidden"), "the action stays available until the host confirms resume");

  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "saved one" },
    { id: "q2", kind: "queue", text: "saved two" }
  ], paused: false });
  await h.settle(20);
  assert.ok(banner.classList.contains("hidden"), "the banner goes away when resumed");
  assert.deepStrictEqual([...h.thread().querySelectorAll(".queued-item")].map((r) => r.dataset.id), ["q1", "q2"]);
  assert.strictEqual(h.errors().length, 0);
});

test("message persistence a paused queue keeps its banner across a cached switch", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "A", title: "Paused chat" });
  h.post({ type: "capabilities", steering: true, sendWhileWorking: "steer" });
  h.post({ type: "sessionStatuses", statuses: { A: "idle", B: "idle" }, activeId: "A" });
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "saved one" },
    { id: "q2", kind: "queue", text: "saved two" }
  ], paused: true });
  await h.settle(20);
  assert.ok(!h.document.getElementById("queue-resume").classList.contains("hidden"), "the paused queue shows its composer row");

  // Away to another chat, then back: the cached view must still say paused.
  h.document.getElementById("history-btn").click();
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "sessionReady", sessionId: "B", title: "Other chat" });
  await h.settle(10);
  assert.ok(h.document.getElementById("queue-resume").classList.contains("hidden"), "the other chat has no such row");

  h.document.getElementById("history-btn").click();
  h.post({
    type: "sessions",
    sessions: [
      { id: "A", short_id: "A", title: "Paused chat", working_directory: "/w" },
      { id: "B", short_id: "B", title: "Other chat", working_directory: "/w" }
    ],
    activeId: null,
    statuses: { A: "idle", B: "idle" },
    folders: [{ path: "/w", name: "w" }]
  });
  const rowA = [...h.document.querySelectorAll("#sessions-list .session-main")]
    .find((el) => el.textContent.includes("Paused chat"));
  rowA.click();
  assert.ok(h.posted.some((m) => m.type === "activateSession" && m.id === "A"));
  assert.ok(!h.document.getElementById("queue-resume").classList.contains("hidden"),
    "the cached queue's resume row returns before the host refreshes it");
  h.post({ type: "sessionReady", sessionId: "A", title: "Paused chat" });
  await h.settle(20);

  assert.ok(!h.document.getElementById("queue-resume").classList.contains("hidden"), "the row is still there after the switch back");
  assert.deepStrictEqual([...h.thread().querySelectorAll(".queued-item")].map((r) => r.dataset.id), ["q1", "q2"]);
  assert.strictEqual(h.errors().length, 0);
});

test("message persistence clearing a paused queue hides its composer row", () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const row = h.document.getElementById("queue-resume");
  assert.ok(row.classList.contains("hidden"));
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "saved" }], paused: true });
  assert.ok(!row.classList.contains("hidden"));
  h.post({ type: "queued", items: [], paused: true });
  assert.ok(row.classList.contains("hidden"), "an empty queue never offers resume");
  h.post({ type: "queued", items: [{ id: "q2", kind: "queue", text: "saved again" }], paused: true });
  assert.ok(!row.classList.contains("hidden"));
  h.post({ type: "clear" });
  assert.ok(row.classList.contains("hidden"), "a new chat does not inherit the old resume row");
  assert.strictEqual(h.errors().length, 0);
});

test("message persistence queue refresh preserves focus on the resume action", () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "queued", items: [{ id: "q1", kind: "queue", text: "saved" }], paused: true });
  const button = h.document.getElementById("resume-queue");
  button.focus();
  h.post({ type: "queued", items: [
    { id: "q1", kind: "queue", text: "saved" },
    { id: "q2", kind: "queue", text: "another message" }
  ], paused: true });
  assert.strictEqual(h.document.activeElement, button);
  assert.strictEqual(h.document.getElementById("resume-queue"), button);
  assert.strictEqual(h.errors().length, 0);
});


for (const replayed of [false, true]) {
  test(`checkpoint boundary: ${replayed ? "replayed" : "live"} actions cut before the message and its attachments`, async () => {
    const h = createHarness();
    h.post({ type: "ready" });
    h.post({ type: "body", body: "thread" });
    h.post({ type: "clear" });
    h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, confirmRemoval: false });
    h.post({ type: "sessionReady", sessionId: "S" });
    for (let i = 1; i <= 3; i++) {
      const request = {
        type: replayed ? "userChunk" : "userMessage",
        text: "Do the next task.",
        attachments: [{ label: `context-${i}.txt`, type: "file" }]
      };
      request[replayed ? "messageId" : "clientMessageId"] = `m${i}`;
      h.post(request);
      h.post({ type: "assistantStart" });
      h.post({ type: "assistantChunk", text: `This is answer ${i}.` });
      h.post({ type: "toolCall", id: `tool-${i}`, title: `Read source-${i}.ts`, kind: "read", status: "completed",
        rawInput: { path: `/w/source-${i}.ts` }, content: [{ type: "text", text: `This is tool result ${i}.` }] });
      h.post({ type: "assistantEnd" });
    }
    if (replayed) h.post({ type: "loaded" });
    h.post({ type: "busy", value: false });
    bindCheckpoints(h, "S", ["m1", "m2", "m3"]);
    assert.ok(await h.until(() => h.respTexts().length === 3));

    const turns = [...h.thread().querySelectorAll(":scope > .turn")];
    assert.strictEqual(turns.length, 3);
    for (const turn of turns) {
      const row = turn.querySelector(".checkpoint-row");
      const request = turn.querySelector(".turn-request");
      assert.strictEqual(turn.firstElementChild, row, "the checkpoint precedes the complete request");
      assert.strictEqual(row.nextElementSibling, request);
      assert.ok(request.querySelector(".chat-attached-context"), "attachments stay below the boundary with their message");
    }
    assert.strictEqual(turns[0].querySelector(".checkpoint-fork"), null);
    turns[1].querySelector(".checkpoint-fork").click();
    assert.deepStrictEqual(h.posted.filter((m) => m.type === "revertFork"), [
      { type: "revertFork", sessionId: "S", userMessageId: "m2" }
    ]);
    assert.deepStrictEqual([...h.thread().querySelectorAll(":scope > .turn")], turns, "fork leaves the original transcript intact");

    turns[1].querySelector(".checkpoint-restore").click();
    assert.ok(await h.until(() => h.posted.some((m) => m.type === "revertExecute")));
    assert.deepStrictEqual(h.posted.filter((m) => m.type === "revertExecute"), [
      { type: "revertExecute", sessionId: "S", userMessageId: "m2" }
    ]);
    assert.strictEqual(h.reqTexts().length, 3, "the transcript waits for host confirmation before discarding anything");
    h.post({ type: "reverted", sessionId: "S", userMessageId: "m2", resending: false });
    assert.deepStrictEqual(h.reqTexts(), ["Do the next task."]);
    assert.deepStrictEqual(h.respTexts(), ["This is answer 1."]);
    assert.deepStrictEqual([...h.thread().querySelectorAll(".chat-attached-context-attachment")].map((p) => p.textContent), ["context-1.txt"]);
    assert.strictEqual(h.thread().querySelectorAll(".tool").length, 1);
    assert.ok(!/source-[23]\.ts|This is tool result [23]\./.test(h.thread().textContent), "later tool calls and results are discarded with their turns");
    assert.strictEqual(h.document.getElementById("input").value, "Do the next task.");
    assert.strictEqual(h.errors().length, 0);
  });
}

});
