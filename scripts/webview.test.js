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
  h.post({ type: "toolCall", id: "sa1-t1", parentId: "sa1", title: "Read src/session/sessionStore.ts", kind: "read", status: "pending" });
  h.post({ type: "toolCallUpdate", id: "sa1-t1", parentId: "sa1", status: "in_progress" });
  await h.settle(15);

  const sub = h.document.querySelector("#thread .subagent");
  assert.ok(sub, "the subagent block renders");
  assert.ok(sub.classList.contains("subagent-active"), "a running subagent is marked active");
  assert.ok(sub.classList.contains("dv-collapsed"), "it starts collapsed, like VS Code");
  assert.strictEqual(sub.querySelector(".subagent-title").textContent, "Explore: Map session persistence",
    "the header is the capitalised profile then the task");
  assert.ok(sub.querySelector(".dv-collapsible-header > .subagent-glyph.codicon-agent"),
    "the row leads with the agent glyph");
  assert.strictEqual(sub.querySelector(".subagent-detail").textContent, " \u2014 Read src/session/sessionStore.ts",
    "the running tool is appended to the header");
  assert.ok(sub.querySelector(".subagent-item.subagent-prompt"), "the prompt opens the timeline");
  assert.ok(sub.querySelector(".subagent-item.subagent-thought"), "its reasoning is on the timeline");
  assert.ok(sub.querySelector(".subagent-item.subagent-tool > .tool"), "its tool call nests as a row");
  assert.ok(sub.querySelector(".subagent-item.subagent-spinner"), "a working row shows while it runs");
  assert.strictEqual(h.document.querySelectorAll("#thread > .turn .tool-group").length, 0,
    "a subagent's tools do not join the turn's tool run");

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

// Helper: two completed live turns with known heads.
function twoLiveTurns(h) {
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  h.post({ type: "sessionReady", sessionId: "S" });
  h.post({ type: "userMessage", text: "first" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "turnHead", head: 10, reliable: true });
  h.post({ type: "busy", value: false });
  h.post({ type: "userMessage", text: "second" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a2" }); h.post({ type: "assistantEnd" });
  h.post({ type: "turnHead", head: 20, reliable: true });
  h.post({ type: "busy", value: false });
}

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

test("reloaded turns are only revertable once a reliable (on-expansion) head is known", async () => {
  // The agent re-expands the conversation on load, orphaning any pre-load node
  // id. So historical turns and the FIRST new turn after a reload must NOT be
  // revertable (reverting would hit an orphaned node -> "Invalid params"); a
  // later turn, whose head-before was captured live, is revertable.
  const editableTexts = () =>
    [...h.document.querySelectorAll("#thread .turn-request.editable-inline .req-text")].map((e) => e.textContent.trim());

  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
  // Replay history, then the host reports the load head as NOT reliable.
  h.post({ type: "userChunk", text: "old q" });
  h.post({ type: "assistantChunk", text: "old a" });
  h.post({ type: "loaded" });
  h.post({ type: "turnHead", head: 27, reliable: false });
  await h.settle(20);
  assert.deepStrictEqual(editableTexts(), [], "historical turn is not editable");
  assert.strictEqual(h.document.querySelectorAll("#thread .footer-retry").length, 0, "no Retry on history");

  // First new turn: head-before is the unreliable load head -> not revertable.
  h.post({ type: "userMessage", text: "new q1" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a1" }); h.post({ type: "assistantEnd" });
  h.post({ type: "turnHead", head: 64, reliable: true });
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.deepStrictEqual(editableTexts(), [], "the first turn after a reload is not revertable");

  // Second new turn: head-before (64) was captured live -> revertable.
  h.post({ type: "userMessage", text: "new q2" });
  h.post({ type: "assistantStart" }); h.post({ type: "assistantChunk", text: "a2" }); h.post({ type: "assistantEnd" });
  h.post({ type: "turnHead", head: 67, reliable: true });
  h.post({ type: "busy", value: false });
  await h.settle(20);
  assert.deepStrictEqual(editableTexts(), ["new q2"], "only the second new turn (reliable head) is editable");
  assert.strictEqual(h.document.querySelectorAll("#thread .footer-retry").length, 1, "Retry only on the revertable last turn");
  assert.strictEqual(h.errors().length, 0, "reliability handling threw: " + JSON.stringify(h.errors()));
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

  // Send the second immediately: it jumps to the front of the queue.
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

  // Open A and leave it mid turn, with the "Working…" line on screen.
  openRow("aaa");
  h.post({ type: "sessionReady", sessionId: "aaa" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "assistantStart" });
  h.post({ type: "busy", value: true });
  await h.settle(20);
  assert.strictEqual(h.thread().querySelectorAll(".working").length, 1, "one Working line while it runs");

  // Switch away and back (the transcript is retained), then send again.
  openRow("bbb");
  h.post({ type: "sessionReady", sessionId: "bbb" });
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
  await h.settle(10);
  input.value = "draft for A";
  openRow("bbb");
  h.post({ type: "sessionReady", sessionId: "bbb" });
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

  // The chevron opens the menu with the other places to open one.
  more.click();
  await h.settle(10);
  const labels = [...h.document.querySelectorAll(".dv-menu .dv-menu-item span")].map((s) => s.textContent);
  assert.deepStrictEqual(labels, [
    "New Session",
    "New Session (Editor)",
    "New Session (Window)",
    "New Devin CLI Session (Terminal)"
  ]);
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
    h.posted.some((m) => m.type === "addMention" && m.path === "/Users/me/src/app one.ts"),
    "the dropped file is attached by its decoded path"
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
  assert.deepStrictEqual(added, ["/w/a.ts", "/w/b.ts", "/w/c.ts"], "all three dragged files are attached");
  assert.strictEqual(h.errors().length, 0);
});

test("while busy, typing turns Send into a Queue button next to Stop", async () => {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "capabilities", revert: true });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "assistantStart" });
  h.post({ type: "busy", value: true });
  await h.settle(10);

  const send = h.document.getElementById("send");
  const stop = h.document.getElementById("stop");
  assert.ok(!stop.classList.contains("hidden"), "Stop is shown while busy");
  assert.ok(send.classList.contains("hidden"), "Send is hidden while busy with an empty composer");

  const input = h.document.getElementById("input");
  input.value = "a follow up";
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await h.settle(10);
  assert.ok(!send.classList.contains("hidden"), "Send appears once there is text to queue");
  assert.ok(send.classList.contains("queueing"), "it is in Queue mode while busy");
  assert.ok(!stop.classList.contains("hidden"), "Stop stays available alongside it");
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
