// Host tests for the session usage refresh: the controller's triggers, its
// emit routing, and the usage/usageState messages the webview consumes. The
// fake agent advertises the two instant commands and answers them with the
// settled fixture, so what is asserted is the host's plumbing, not the wire.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChat, cleanup } = require("./chat-harness");

const chunk = (meta) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "" },
  _meta: meta
});

const usage = {
  contextChunks: [
    chunk({
      "cognition.ai/subagent_context": { parentAgentId: "sidekick" },
      "cognition.ai/contextUsage": { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144 }
    }),
    chunk({
      "cognition.ai/contextUsage": { modelId: "gpt-6-1-sol-max", totalTokens: 90745, maxTokens: 1000000 }
    })
  ],
  statsChunks: [
    chunk({ "cognition.ai/instant": true }),
    chunk({
      "cognition.ai/sessionStats": {
        requests: [
          { requestId: "lead-r", responseDimensions: [{ uid: "acu", kind: { type: "cumulativeMetric", value: 1.5 } }] },
          { requestId: "sub-r", responseDimensions: [{ uid: "acu", kind: { type: "cumulativeMetric", value: 0.4281 } }] }
        ]
      }
    })
  ]
};

const readPrompts = (h) => h.agentSaw("session/prompt")
  .map((m) => (m.params.prompt || []).map((b) => b.text || "").join(" "))
  .filter((t) => /^\/(?:context|session-stats)/.test(t));

const usagePosts = (h) => h.postsOf("usage");

test("opening a session reads usage once and emits only what the report supplies", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ usage });
  try {
    await h.ready();
    await h.startChat("hello");
    const opened = await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
    assert.ok(opened, "the usage snapshot never arrived. Posts: " + JSON.stringify(h.posted.map((m) => m.type)));
    const report = usagePosts(h).find((m) => m.sessionAcus === 1.9281);
    assert.equal(report.contextModel, "fusion-claude-opus-5-high-sidekick-swe-2-medium");
    assert.deepEqual(report.contexts, [
      { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144, role: "sub" },
      { modelId: "gpt-6-1-sol-max", totalTokens: 90745, maxTokens: 1000000, role: "lead" }
    ]);
    // The reads ran before the user's prompt reached the wire.
    assert.deepEqual(
      h.agentSaw("session/prompt").map((m) => (m.params.prompt || []).map((b) => b.text || "").join(" ")),
      ["/context", "/session-stats", "hello"]
    );
    // Nothing about the reads appears as a transcript message.
    assert.deepEqual(h.postsOf("userMessage").map((m) => m.text), ["hello"]);
    assert.equal(h.postsOf("assistantChunk").length, 0);
    // The popup state finished loading without an error.
    const states = h.postsOf("usageState");
    assert.deepEqual(states.map((s) => s.loading), [true, false]);
    assert.equal(states.at(-1).error, undefined);
  } finally {
    await h.dispose();
  }
});

test("the popup's refresh asks for a new read on the active session only", { skip: process.platform === "win32" }, async () => {
  // A short turn: the forced popup refresh still cannot run while it is busy.
  const h = createChat({ usage, promptDelay: 300 });
  try {
    await h.ready();
    await h.startChat("hello");
    await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
    await h.until(() => h.postsOf("busy").at(-1)?.value === false);
    const reads = readPrompts(h).length;
    h.send({ type: "refreshUsage" });
    const again = await h.until(() => readPrompts(h).length > reads);
    assert.ok(again, "the forced refresh never reached the agent");
    await h.until(() => usagePosts(h).filter((m) => m.sessionAcus === 1.9281).length >= 2);
    assert.deepEqual(readPrompts(h).slice(reads), ["/context", "/session-stats"]);
  } finally {
    await h.dispose();
  }
});

test("a refresh on an empty panel and a running turn both stay off the wire", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ usage });
  try {
    await h.ready();
    // No session at all: the popup message must be a no-op, not a crash.
    h.send({ type: "refreshUsage" });
    await h.settle(100);
    assert.deepEqual(readPrompts(h), []);

    // While a real turn owns the channel a refresh is refused, and the turn's
    // own finish is what retries the read.
    h.setDelays({ promptDelay: 5600 });
    await h.startChat("hello");
    await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
    const reads = readPrompts(h).length;
    h.send({ type: "refreshUsage" });
    await h.settle(200);
    assert.equal(readPrompts(h).length, reads, "a read ran while the turn was busy");
    const finished = await h.until(() => readPrompts(h).length > reads, 9000);
    assert.ok(finished, "the turn end never retried the usage read");
    assert.deepEqual(readPrompts(h).slice(reads), ["/context", "/session-stats"]);
  } finally {
    await h.dispose();
  }
});

test("a short turn inside the startup window still earns a fresh read", { skip: process.platform === "win32" }, async () => {
  // The turn ends well inside the five-second throttle window. Without the
  // forced refresh on the real busy transition the second pair never goes out.
  const h = createChat({ usage, promptDelay: 150 });
  try {
    await h.ready();
    await h.startChat("hello");
    const done = await h.until(() => readPrompts(h).length >= 4);
    assert.ok(done, "the finished turn never re-read usage");
    assert.deepEqual(
      h.agentSaw("session/prompt").map((m) => (m.params.prompt || []).map((b) => b.text || "").join(" ")),
      ["/context", "/session-stats", "hello", "/context", "/session-stats"]
    );
    const busy = h.postsOf("busy").map((m) => m.value);
    assert.ok(busy.includes(true) && busy.at(-1) === false, "a real busy transition drove the refresh");
    await h.until(() => usagePosts(h).filter((m) => m.sessionAcus === 1.9281).length >= 2);
  } finally {
    await h.dispose();
  }
});

test("commands advertised late start the first read without a turn or popup", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ usage, usageLate: 800, promptDelay: 100 });
  try {
    await h.ready();
    await h.startChat("hello");
    // The turn ends before the advertisement lands, and even its forced
    // refresh could not read: the commands were not advertised yet.
    const idle = await h.until(() => h.postsOf("busy").at(-1)?.value === false);
    assert.ok(idle, "the turn never ended");
    assert.deepEqual(readPrompts(h), [], "a read ran before the commands existed");
    const advertised = await h.until(() => h.postsOf("commands").length > 0);
    assert.ok(advertised, "the late advertisement never arrived");
    const read = await h.until(() => readPrompts(h).length >= 2);
    assert.ok(read, "the advertisement never triggered the read");
    assert.deepEqual(readPrompts(h).slice(0, 2), ["/context", "/session-stats"]);
    await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
  } finally {
    await h.dispose();
  }
});

test("a read answered after a model change keeps the ACUs but drops the stale windows", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ usage, promptDelay: 100, usageContextDelay: 500 });
  try {
    await h.ready();
    const id = await h.startChat("hello");
    // The open-time read lands, the short turn ends, and its forced re-read is
    // the one held open by the slow /context reply.
    await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
    const held = await h.until(() => readPrompts(h).length >= 3);
    assert.ok(held, "the post-turn read never started");
    // The session moves to another model while the read is still unanswered.
    const rt = h.controller.runtimes.get(id);
    rt.client.emit("update", {
      sessionId: id,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", category: "model", type: "select", currentValue: "gpt-6-luna-high", options: [] }]
      }
    });
    const landed = await h.until(() => usagePosts(h).filter((m) => m.sessionAcus === 1.9281).length >= 2);
    assert.ok(landed, "the held read never reported");
    const latest = usagePosts(h).at(-1);
    assert.equal(latest.sessionAcus, 1.9281, "session ACUs are not model scoped");
    assert.equal(latest.contexts, undefined, "stale windows must not paint under the new model");
    assert.equal(latest.contextModel, undefined, "a billing-only result carries no old model scope");
  } finally {
    await h.dispose();
  }
});

test("a pending read crosses a surface transfer and lands on the receiver only", { skip: process.platform === "win32" }, async () => {
  const from = createChat({ usage, promptDelay: 100, usageContextDelay: 400 });
  let to;
  try {
    await from.ready();
    const id = await from.startChat("hello");
    // The open-time read and the turn-end forced read both complete first, so
    // the only read in flight during the handover is the popup's own.
    await from.until(() => usagePosts(from).filter((m) => m.sessionAcus === 1.9281).length >= 2);
    const wireBefore = readPrompts(from).length;
    from.send({ type: "refreshUsage" });
    await from.until(() => readPrompts(from).length > wireBefore);
    const usageCount = from.postsOf("usage").length;
    const stateCount = from.postsOf("usageState").length;
    // The second surface is built only now: it owns no agent of its own, and
    // its config must not be what the transferred agent was spawned with.
    to = createChat();
    await to.ready();
    const transfer = from.controller.exportRuntime(id);
    assert.ok(transfer, "the runtime could not be handed over");
    await to.controller.importRuntime(transfer);
    // The held /context answers once, into the receiving surface.
    const landed = await to.until(() => to.postsOf("usage").some((m) => m.sessionAcus === 1.9281 && Array.isArray(m.contexts)));
    assert.ok(landed, "the transferred read never reached the new surface");
    assert.ok(to.postsOf("usageState").some((s) => s.loading === false), "the receiver settles the loading note");
    // The old surface hears nothing more about it.
    await from.settle(150);
    assert.equal(from.postsOf("usage").length, usageCount, "the source surface got a late usage post");
    assert.equal(from.postsOf("usageState").length, stateCount, "the source surface got a late loading post");
    // The agent was asked once, never re-polled by the receiving surface.
    assert.deepEqual(readPrompts(from).slice(wireBefore), ["/context", "/session-stats"]);
  } finally {
    await from.dispose();
    await to?.dispose();
  }
});

test("an owned empty snapshot clears, a worker's is ignored, and a sidekick report is lifted", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ usage, promptDelay: 100 });
  try {
    await h.ready();
    const id = await h.startChat("hello");
    await h.until(() => usagePosts(h).some((m) => m.sessionAcus === 1.9281));
    const rt = h.controller.runtimes.get(id);
    const push = (update) => rt.client.emit("update", { sessionId: id, update });
    const chunk = (meta) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: meta });

    // A snapshot owned by the session itself replaces wholesale, even empty.
    push(chunk({ "cognition.ai/contextUsage": [] }));
    assert.deepEqual(usagePosts(h).at(-1).contexts, [], "the owned empty snapshot clears every window");

    // Another worker's metadata, even an empty snapshot, never reaches the view.
    const count = usagePosts(h).length;
    push(chunk({ "cognition.ai/subagent_context": { parentAgentId: "worker-9" }, "cognition.ai/contextUsage": [] }));
    push(chunk({ "cognition.ai/subagent_context": { parentAgentId: "worker-9" }, "cognition.ai/contextUsage": { modelId: "unrelated-1", totalTokens: 5, maxTokens: 100 } }));
    assert.equal(usagePosts(h).length, count, "worker metadata leaked into the view");

    // The delegated Sub report riding a usage_update is lifted with its scope.
    push({
      sessionUpdate: "usage_update", used: 1, size: 2,
      _meta: {
        "cognition.ai/subagent_context": { parentAgentId: "sidekick" },
        "cognition.ai/contextUsage": { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144 }
      }
    });
    const lifted = usagePosts(h).at(-1);
    assert.deepEqual(lifted.contexts, { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144, role: "sub" },
      "the Sub report is lifted as a scoped object fragment");
    assert.equal(lifted.contextModel, undefined);
  } finally {
    await h.dispose();
  }
});

test("sessions that never advertise the reads report nothing and show no figures", { skip: process.platform === "win32" }, async () => {
  const h = createChat();
  try {
    await h.ready();
    await h.startChat("hello");
    await h.settle(300);
    assert.deepEqual(readPrompts(h), []);
    assert.equal(usagePosts(h).length, 0, "no usage message without a report");
  } finally {
    await h.dispose();
  }
});

test.after(async () => { await cleanup(); });
