// Regressions for messages and transcript restoration across an idle wake.
// These bridge the real controller and webview to a fake ACP agent.

const test = require("node:test");
const assert = require("node:assert");
const { createChat, cleanup } = require("./chat-harness");
const { createHarness } = require("./webview-harness");

// The fake agent is a `/bin/sh` wrapper, so the CLI resolver cannot run it on Windows.
const posixOnly = { skip: process.platform === "win32" };

// What the agent replays when the woken session answers session/load, standing
// in for the history the real CLI sends before replying.
const LOAD_UPDATES = [
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "diagnostic initial request" }, messageId: "initial-user" },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "initial response" }, messageId: "initial-assistant" }
];

// Bridge the host controller and the jsdom page the way the extension does:
// host posts land in the page, page posts go back to the host.
function bridge(host, page) {
  const originalPost = host.webview.postMessage.bind(host.webview);
  host.webview.postMessage = (message) => {
    const result = originalPost(message);
    page.post(message);
    return result;
  };
  const originalPush = page.posted.push.bind(page.posted);
  page.posted.push = (...messages) => {
    const result = originalPush(...messages);
    for (const message of messages) queueMicrotask(() => host.send(message));
    return result;
  };
}

function send(page, text) {
  const input = page.document.getElementById("input");
  input.value = text;
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  page.document.getElementById("send").click();
}

async function leaveToList(host, page) {
  page.document.getElementById("history-btn").click();
  assert.ok(await host.until(() => !host.activeId(), 5000), "the panel never left the session");
}

// Re-open the session from the list the way a row click does: the page needs the
// row rendered first, which is what the sessions message does.
async function openSessionRow(host, page, id, status) {
  page.post({
    type: "sessions",
    sessions: [{ id, short_id: id, title: "Diagnostic session", working_directory: host.cwd }],
    activeId: null,
    statuses: { [id]: status },
    folders: [{ path: host.cwd, name: "diagnostic" }]
  });
  assert.ok(await page.until(() => !!page.document.querySelector("#sessions-list .session-main"), 5000), "the session row never rendered");
  page.document.querySelector("#sessions-list .session-main").click();
}

function settled(page) {
  return !page.document.querySelector(".thread-loading") && !page.thread().classList.contains("loading-replay");
}

// Start a chat, stop its turn, age the session past the idle reap window and
// reap it, leaving a dead session with a transcript on screen. Returns the
// session id once the follow-up send has put the wake in flight.
async function reapThenSend(host, page, followUp) {
  await host.ready();
  send(page, "diagnostic initial request");
  assert.ok(await host.until(() => host.agentSaw("session/prompt").length === 1, 10000), "the initial prompt was never sent");
  page.document.getElementById("stop").click();
  const id = host.activeId();
  assert.ok(await host.until(() => !host.controller.runtimes.get(id)?.busy, 10000), "the initial turn never settled");
  const runtime = host.controller.runtimes.get(id);
  runtime.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
  host.controller.reapIdleRuntimes();
  assert.ok(await host.until(() => !host.controller.runtimes.has(id), 5000), "the idle runtime was not reaped");
  host.setDelays({ loadDelay: 1000, promptDelay: 5000 });
  send(page, followUp);
  assert.ok(await host.until(() => host.controller.runtimes.get(id)?.replaying, 10000), "the wake never started");
  return id;
}

test("a send that finishes while the panel is away still shows on return", posixOnly, async () => {
  const host = createChat({ promptDelay: 200, loadUpdates: LOAD_UPDATES, config: { idleSessionKeepAliveMinutes: 60 } });
  const page = createHarness();
  bridge(host, page);
  try {
    const id = await reapThenSend(host, page, "diagnostic request after idle");
    await leaveToList(host, page);
    // The wake finishes and the queued follow-up goes out while the list is up.
    assert.ok(await host.until(() => host.agentSaw("session/prompt").length === 2, 15000), "the follow-up prompt was never sent");
    const readyBefore = host.postsOf("sessionReady").length;
    // Returning finds the session running with its view still cached.
    await openSessionRow(host, page, id, "running");
    assert.ok(await host.until(() => host.postsOf("sessionReady").length > readyBefore, 10000), "the session never re-activated");
    assert.ok(await page.until(() => page.reqTexts().length === 2, 5000), "the follow-up bubble never rendered");
    assert.deepStrictEqual(page.reqTexts(), ["diagnostic initial request", "diagnostic request after idle"], "both requests show once, in order");
    assert.ok(settled(page), "a loader was left behind");
    const prompts = host.agentSaw("session/prompt");
    assert.strictEqual(prompts.length, 2, "the follow-up was sent more than once");
    assert.strictEqual(prompts[1].params.sessionId, id, "the follow-up went to a different session");
    assert.strictEqual(
      prompts[1].params.prompt.filter((b) => b.type === "text").map((b) => b.text).join(""),
      "diagnostic request after idle"
    );
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    page.window.close();
    await host.dispose();
  }
});

test("returning during the wake rebuilds the transcript instead of stranding the loader", posixOnly, async () => {
  const host = createChat({ promptDelay: 200, loadUpdates: LOAD_UPDATES, config: { idleSessionKeepAliveMinutes: 60 } });
  const page = createHarness();
  bridge(host, page);
  try {
    const id = await reapThenSend(host, page, "diagnostic request after idle");
    await leaveToList(host, page);
    // Re-select while the session still reports "starting": the load the row
    // asks for shares the wake already in flight rather than starting another.
    await openSessionRow(host, page, id, "starting");
    assert.ok(await host.until(() => host.agentSaw("session/prompt").length === 2, 15000), "the follow-up prompt was never sent");
    assert.ok(await page.until(() => settled(page), 10000), "the loader never cleared");
    assert.ok(await page.until(() => page.reqTexts().length === 2, 5000), "the transcript never rebuilt");
    assert.deepStrictEqual(page.reqTexts(), ["diagnostic initial request", "diagnostic request after idle"], "both requests show once, in order");
    assert.strictEqual(host.agentSaw("session/prompt").length, 2, "the follow-up was sent more than once");
    assert.strictEqual(host.controller.runtimes.get(id)?.busy, true, "the follow-up turn is not running");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    page.window.close();
    await host.dispose();
  }
});

test("a fresh view loading a busy session replays local history without touching the agent", posixOnly, async () => {
  const host = createChat({ promptDelay: 60000, loadUpdates: LOAD_UPDATES, config: { defaultMode: "", defaultModel: "" } });
  const page = createHarness();
  try {
    await host.ready();
    const id = await host.startChat("busy session request");
    // The page never saw this session (the bridge goes up only now), so its row
    // click is a full load. The turn is still running (promptDelay holds it),
    // which is exactly the case a session/load over the live channel would abort.
    assert.ok(await host.until(() => host.controller.runtimes.get(id)?.busy, 10000), "the turn never started");
    bridge(host, page);
    page.post({ type: "ready" });
    await openSessionRow(host, page, id, "running");
    assert.ok(await page.until(() => settled(page), 10000), "the loader never cleared");
    assert.ok(await page.until(() => page.reqTexts().includes("busy session request"), 5000), "the recorded request never replayed");
    assert.strictEqual(host.controller.runtimes.get(id)?.busy, true, "the turn was interrupted");
    assert.strictEqual(host.agentSaw("session/load").length, 0, "a session/load went over the live channel");
    assert.strictEqual(host.agentSaw("session/prompt").length, 1, "the prompt was sent again");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    page.window.close();
    await host.dispose();
  }
});

test.after(() => cleanup());
