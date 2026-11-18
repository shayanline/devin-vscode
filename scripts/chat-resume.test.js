// Regressions for messages and transcript restoration across an idle wake.
// These bridge the real controller and webview to a fake ACP agent.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

// The chunk shape the real agent sends for a /context read on a session with no
// context yet: instant tagged, carrying only text, and no structured report.
const INSTANT_USAGE_TEXT = "No context usage available yet. Send a message first.";
const INSTANT_USAGE_CHUNKS = [{
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: INSTANT_USAGE_TEXT },
  _meta: { "cognition.ai/instant": true }
}];

test("session lifecycle: reopening an empty session never paints the internal usage reply", posixOnly, async () => {
  const host = createChat({
    usage: { contextChunks: INSTANT_USAGE_CHUNKS },
    config: { idleSessionKeepAliveMinutes: 60 }
  });
  const page = createHarness();
  bridge(host, page);
  try {
    await host.ready();
    host.send({ type: "newSession" });
    assert.ok(await page.until(() => page.document.querySelectorAll("#thread .welcome-chip").length === 4, 10000), "the starter prompts never rendered");
    // The chips render from the clear, before session/new claims the session,
    // so wait for the id and its sessionReady before capturing it.
    assert.ok(await host.until(() => !!host.activeId()
      && host.postsOf("sessionReady").some((m) => m.sessionId === host.activeId()), 15000), "the new session was never activated");
    const id = host.activeId();

    const contextReads = () => host.agentSaw("session/prompt").filter((m) =>
      (m.params.prompt || []).some((b) => (b.text || "").startsWith("/context"))).length;
    const usageSettled = () => {
      const rt = host.controller.runtimes.get(id);
      return !!rt && !rt.usagePending && (host.postsOf("usageState").at(-1) || {}).loading === false;
    };
    const assertEmptyWelcome = (round) => {
      assert.strictEqual(page.document.querySelectorAll("#thread .turn").length, 0, `round ${round}: a transcript turn appeared`);
      assert.ok(!page.thread().textContent.includes(INSTANT_USAGE_TEXT), `round ${round}: the internal usage reply reached the page`);
      assert.strictEqual(page.document.querySelectorAll("#thread .welcome-chip").length, 4, `round ${round}: the starter prompts went missing`);
      assert.ok(settled(page), `round ${round}: a loader was left behind`);
    };
    // One return to the list and back, with a forced fresh usage read once the
    // reopen's own read has settled, so every round proves a read went out and
    // came back without touching the transcript.
    const reopenAndRefresh = async (round, status) => {
      await leaveToList(host, page);
      await openSessionRow(host, page, id, status);
      assert.ok(await host.until(usageSettled, 15000), `round ${round}: the reopen's usage read never settled`);
      // Snapshot after the reopen's own read so the forced one is what the
      // counter proves went out.
      const readsBefore = contextReads();
      host.send({ type: "refreshUsage" });
      assert.ok(await host.until(() => contextReads() > readsBefore, 10000), `round ${round}: the forced usage read never went out`);
      assert.ok(await host.until(usageSettled, 10000), `round ${round}: the usage refresh never settled`);
      assert.ok(await page.until(() => settled(page) && page.document.querySelectorAll("#thread .welcome-chip").length === 4, 10000), `round ${round}: the starter prompts never came back`);
      assertEmptyWelcome(round);
    };

    await reopenAndRefresh("first", "idle");
    await reopenAndRefresh("second", "idle");

    // A cold wake of the same empty session: the runtime is reaped, so the row
    // click takes the wake path and the transcript still comes back empty.
    await leaveToList(host, page);
    const runtime = host.controller.runtimes.get(id);
    runtime.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000;
    host.controller.reapIdleRuntimes();
    assert.ok(await host.until(() => !host.controller.runtimes.has(id), 5000), "the idle runtime was not reaped");
    const readsBeforeWake = contextReads();
    await openSessionRow(host, page, id, undefined);
    assert.ok(await host.until(() => contextReads() > readsBeforeWake, 20000), "the wake never refreshed usage");
    assert.ok(await host.until(usageSettled, 15000), "the wake's usage read never settled");
    assert.ok(await page.until(() => settled(page) && page.document.querySelectorAll("#thread .welcome-chip").length === 4, 10000), "the starter prompts never came back after the wake");
    assertEmptyWelcome("wake");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    page.window.close();
    await host.dispose();
  }
});

test("reported regressions: a chat sent from the list keeps its first bubble when reopened mid creation and after it settles", posixOnly, async () => {
  const host = createChat({
    promptDelay: 200,
    bgUpdates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "assistant reply" } }],
    config: { idleSessionKeepAliveMinutes: 60 }
  });
  const page = createHarness();
  bridge(host, page);
  let releaseDefaults;
  const defaultsGate = new Promise((r) => { releaseDefaults = r; });
  try {
    await host.ready();
    // Hold the new session's defaults so its list row can be opened while the
    // creation is still in flight.
    const originalDefaults = host.controller.applyDefaults.bind(host.controller);
    host.controller.applyDefaults = async (rt, res) => {
      await defaultsGate;
      return originalDefaults(rt, res);
    };

    // A real send from the list composer, then straight back to the list before
    // the session exists on screen.
    send(page, "first list message");
    await leaveToList(host, page);

    // The host's own session list carries the live row: wait for the real post
    // to render it, never an injected one.
    assert.ok(await page.until(() => page.document.querySelector("#sessions-list .session-main"), 15000), "the new session's row never rendered");
    const id = [...host.controller.runtimes.keys()][0];
    assert.ok(id, "no runtime was created for the list send");

    // Open it while creation is still held: the transcript must come up whole.
    page.document.querySelector("#sessions-list .session-main").click();
    releaseDefaults();
    assert.ok(await host.until(() => host.activeId() === id, 15000), "the row never opened the new session");
    assert.ok(await page.until(() => settled(page) && page.reqTexts().includes("first list message"), 15000), "the first bubble never rendered");
    assert.ok(await page.until(() => page.respTexts().includes("assistant reply"), 15000), "the response never rendered");
    assert.strictEqual(page.reqTexts().filter((t) => t === "first list message").length, 1, "the first request rendered more than once");
    assert.strictEqual(page.respTexts().filter((t) => t === "assistant reply").length, 1, "the response rendered more than once");
    assert.strictEqual(host.agentSaw("session/prompt").filter((m) => m.params.sessionId === id).length, 1, "the first prompt went out more than once");
    assert.strictEqual(page.document.querySelectorAll("#thread .welcome").length, 0, "a welcome flashed over the transcript");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");

    // And once everything has settled, leaving and reopening still shows it once.
    await leaveToList(host, page);
    assert.ok(await page.until(() => page.document.querySelector("#sessions-list .session-main"), 10000), "the session row never rendered again");
    page.document.querySelector("#sessions-list .session-main").click();
    assert.ok(await page.until(() => settled(page) && page.reqTexts().includes("first list message") && page.respTexts().includes("assistant reply"), 15000),
      "the settled reopen never restored the transcript");
    assert.strictEqual(page.reqTexts().filter((t) => t === "first list message").length, 1, "the first request rendered twice after settling");
    assert.strictEqual(page.respTexts().filter((t) => t === "assistant reply").length, 1, "the response rendered twice after settling");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    releaseDefaults?.();
    page.window.close();
    await host.dispose();
  }
});

test("checkpoint identity: editing the middle message keeps the first turn end to end", posixOnly, async () => {
  // The whole path a user takes: three sends through the real page, the step
  // list binding their stable ids, an inline edit of the middle one, and the
  // rewind plus resend the host performs. The prompt gate holds each turn so
  // the ids, the trim and the in flight resend are all exact.
  const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dv-prompt-gate-"));
  const host = createChat({ promptGate: gateDir, config: { idleSessionKeepAliveMinutes: 60 } });
  const page = createHarness();
  bridge(host, page);
  try {
    await host.ready();
    page.post({ type: "ready" });
    const lastText = (m) => (m.params.prompt || []).filter((b) => b.type === "text").map((b) => b.text).at(-1) || "";
    const promptsFor = (id) => host.agentSaw("session/prompt").filter((m) => m.params.sessionId === id);
    const sendAndRelease = async (text, seq) => {
      send(page, text);
      assert.ok(await host.until(() => !!host.activeId(), 15000), "no session opened for " + text);
      const id = host.activeId();
      assert.ok(await host.until(() => promptsFor(id).some((m) => lastText(m) === text), 15000), text + " never reached the agent");
      host.releasePrompt(id, seq);
      assert.ok(await host.until(() => !host.controller.runtimes.get(id)?.busy, 20000), text + " never settled");
      return id;
    };

    const id = await sendAndRelease("FIRST", 1);
    await sendAndRelease("SECOND", 2);
    await sendAndRelease("THIRD", 3);
    assert.deepStrictEqual(page.reqTexts(), ["FIRST", "SECOND", "THIRD"], "the three requests rendered");

    // The stable ids the prompts declared, published as the step list the way
    // the agent's push would, so the page's controls can bind to them.
    const mids = promptsFor(id).map((m) => m.params._meta?.["cognition.ai/clientMessageId"]);
    assert.ok(mids.length === 3 && mids.every((x) => typeof x === "string"), "a prompt went out without a stable id");
    const rt = host.controller.runtimes.get(id);
    rt.client.emit("revertSteps", {
      sessionId: id,
      steps: mids.map((userMessageId, i) => ({
        stepNumber: i + 1, kind: "prompt", userMessageId,
        revertTargetNodeId: i * 10 + 1, forkTargetNodeId: i * 10 + 2
      }))
    });
    assert.ok(await page.until(() => page.document.querySelectorAll("#thread .checkpoint-row:not(.hidden)").length === 3, 10000),
      "the checkpoint rows never appeared");

    // Edit SECOND through the real inline editor. The preview answers empty,
    // so the rewind goes straight through and the resend waits at the gate.
    const reqBodies = [...page.document.querySelectorAll("#thread .turn-request .req-body")];
    assert.strictEqual(reqBodies.length, 3, "the three requests rendered");
    reqBodies[1].click();
    assert.ok(await page.until(() => !!page.document.querySelector(".req-editor-input"), 5000), "the editor never opened");
    const ta = page.document.querySelector(".req-editor-input");
    ta.value = "edited SECOND";
    ta.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.ok(await host.until(() => host.agentSaw("_cognition.ai/revert/execute").length === 1, 15000), "the rewind never reached the agent");
    assert.ok(await host.until(() => promptsFor(id).length === 4, 15000), "the resend never went out");
    const resendReq = promptsFor(id).at(-1);
    assert.strictEqual(lastText(resendReq), "edited SECOND", "the resend carried the wrong text");
    const resendId = resendReq.params._meta?.["cognition.ai/clientMessageId"];
    assert.ok(typeof resendId === "string" && !mids.includes(resendId), "the resend did not declare a fresh stable id");

    // While the resend turn is held open, leaving and reopening must still
    // show FIRST: the retained prefix survives the rewind and the resend.
    await leaveToList(host, page);
    await openSessionRow(host, page, id, "running");
    assert.ok(await page.until(() => settled(page) && page.reqTexts().includes("FIRST"), 15000), "FIRST did not survive the reopen");
    assert.deepStrictEqual(page.reqTexts(), ["FIRST", "edited SECOND"], "the transcript did not trim to the prefix plus resend");

    host.releasePrompt(id, 4);
    assert.ok(await host.until(() => !host.controller.runtimes.get(id)?.busy, 20000), "the resend never finished");
    await page.settle(200);

    const executeReq = host.agentSaw("_cognition.ai/revert/execute").at(-1);
    assert.deepStrictEqual(executeReq.params, { sessionId: id, userMessageId: mids[1], force: true, skipFileUndo: false },
      "the rewind did not carry exactly the scoped prompt id and execute flags");
    assert.strictEqual(promptsFor(id).filter((m) => lastText(m) === "edited SECOND").length, 1, "the resend went out twice");
    assert.strictEqual(promptsFor(id).filter((m) => lastText(m) === "THIRD").length, 1, "the discarded turn was prompted again");

    // The painted record kept FIRST and dropped SECOND and THIRD, still whole.
    const finished = host.controller.runtimes.get(id);
    assert.ok(finished.log.some((p) => p.type === "userMessage" && p.clientMessageId === mids[0]), "FIRST left the record");
    assert.ok(!finished.log.some((p) => p.clientMessageId === mids[1] || p.clientMessageId === mids[2]), "SECOND or THIRD stayed painted");
    assert.strictEqual(finished.logFull, true, "the retained prefix was marked partial");

    assert.deepStrictEqual(page.reqTexts(), ["FIRST", "edited SECOND"], "the final transcript is wrong");
    assert.strictEqual(page.errors().length, 0, "the page reported handler errors");
  } finally {
    page.window.close();
    await host.dispose();
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
});

test.after(() => cleanup());
