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
  assert.ok(mcp && mcp.querySelector(".tool-kind.codicon-plug"), "mcp uses the plug icon");
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
  assert.ok(/Used 3 tools/.test(groups[0].textContent), "the group summarises the count");
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

test("per-turn edit/restore chrome builds while busy (no throw)", async () => {
  const h = createHarness();
  h.replay([{ role: "user", text: "q" }, { role: "assistant", text: "a" }]);
  // Toggling busy rebuilds every turn's chrome (canEditTurn/canRestoreTurn read `busy`).
  h.post({ type: "busy", value: true });
  h.post({ type: "busy", value: false });
  await h.settle();

  assert.strictEqual(h.errors().length, 0, "toggling busy threw: " + JSON.stringify(h.errors()));
});
