// Fusion role activity: which model is producing meaningful work during a
// running turn. The host reads the real ACP tags (the sidekick boolean and a
// "sidekick" parent id) and posts an ephemeral marker, which the composer
// turns into a highlight on that role's name. The first tests drive a real
// controller against the chat harness, pushing updates straight through the
// client's update emitter. The last drive the real webview bundle in jsdom.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChat, cleanup } = require("./chat-harness");
const { createHarness } = require("./webview-harness");

// The model the fake agent advertises.
const FUSION = "fusion-claude-opus-5-high-sidekick-swe-2-medium";

const thought = (text, _meta) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, _meta });
const message = (text, _meta) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta });
const toolCall = (_meta) => ({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "run_command", _meta });
const toolUpdate = (status, _meta) => ({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status, _meta });

const activity = (h, id) => h.postsOf("modelActivity").filter((m) => m.sessionId === id);
const pushRt = (rt, update) => rt.client.emit("update", { sessionId: rt.id, update });
const push = (h, id, update) => pushRt(h.controller.runtimes.get(id), update);
const roles = (h, id) => activity(h, id).map((m) => m.role);

test("live frames mark the working role in order, and a terminal update cannot steal it", { skip: process.platform === "win32" }, async () => {
  // Thinking is hidden, so the marker must come from the update itself rather
  // than the chrome that renders it.
  const h = createChat({ config: { showThinking: false } });
  try {
    await h.ready();
    const id = await h.startChat("hello");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => rt.busy), "the turn never started");

    push(h, id, thought("planning"));
    push(h, id, toolCall({ "cognition.ai/sidekick": true }));
    push(h, id, toolUpdate("completed"));
    push(h, id, message("all done"));

    assert.deepEqual(roles(h, id), ["lead", "sub", "lead"]);
    for (const m of activity(h, id)) {
      assert.equal(m.sessionId, id);
      assert.equal(m.model, FUSION);
    }
    assert.equal(rt.modelActivity.role, "lead");
  } finally {
    await h.dispose();
  }
});

test("the sidekick parent counts and other workers, reports and noise never switch the role", { skip: process.platform === "win32" }, async () => {
  const h = createChat();
  try {
    await h.ready();
    const id = await h.startChat("hello");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => rt.busy), "the turn never started");

    // The Sub model's own frames carry the parent id "sidekick".
    push(h, id, message("sub reply", { "cognition.ai/subagent_context": { parentAgentId: "sidekick" } }));
    assert.deepEqual(roles(h, id), ["sub"]);

    const before = activity(h, id).length;
    const noise = [
      // Another worker's frames, even carrying the sidekick flag, are not a role.
      message("worker text", { "cognition.ai/subagent_context": { parentAgentId: "worker-9" } }),
      toolCall({ "cognition.ai/subagent_context": { parentAgentId: "worker-9" }, "cognition.ai/sidekick": true }),
      // Report chunks and command replies never mark activity, even when
      // their text is nonempty and would otherwise qualify.
      message("context report", { "cognition.ai/contextUsage": { modelId: "x-high", totalTokens: 1, maxTokens: 10 } }),
      message("stats report", { "cognition.ai/sessionStats": { requests: [] } }),
      message("command reply", { "cognition.ai/instant": true }),
      // Empty text, config, plan and lifecycle noise.
      message(""),
      thought(""),
      { sessionUpdate: "config_option_update", configOptions: [] },
      { sessionUpdate: "plan", entries: [] },
      { sessionUpdate: "session_info_update", title: "renamed" },
      { sessionUpdate: "usage_update", used: 1, size: 10 },
      // A tool finishing or failing is not new work.
      toolUpdate("completed"),
      toolUpdate("failed")
    ];
    for (const update of noise) push(h, id, update);
    assert.equal(activity(h, id).length, before, "noise moved the role marker");
    assert.equal(rt.modelActivity.role, "sub");

    // A tool moving to in progress marks the role its tags identify, both on
    // a root frame and on the Sub model's own flagged frame.
    push(h, id, toolUpdate("in_progress"));
    push(h, id, toolUpdate("in_progress", { "cognition.ai/sidekick": true }));
    assert.deepEqual(roles(h, id), ["sub", "lead", "sub"]);
    assert.equal(rt.modelActivity.role, "sub");
  } finally {
    await h.dispose();
  }
});

test("idle, replay, silent wake, Single and a mid turn model change stay neutral", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ promptDelay: 80 });
  try {
    await h.ready();
    const id = await h.startChat("hello");
    const rt = h.controller.runtimes.get(id);
    assert.ok(await h.until(() => rt.busy), "the turn never started");
    assert.ok(await h.until(() => !rt.busy), "the short turn never ended");

    // Idle frames carry no marker.
    push(h, id, thought("late thought"));
    assert.equal(activity(h, id).length, 0);

    // A fresh turn snapshots the model. Replay and silent wake gates ignore it.
    h.send({ type: "send", text: "again" });
    assert.ok(await h.until(() => rt.busy), "the second turn never started");
    assert.equal(rt.modelActivity.model, FUSION);
    rt.replaying = true;
    push(h, id, thought("replayed"));
    rt.replaying = false;
    rt.silentReplay = true;
    push(h, id, thought("waking"));
    rt.silentReplay = false;
    assert.equal(activity(h, id).length, 0);
    assert.equal(rt.modelActivity.role, null);

    // A live frame marks the role, then a mid turn model change mutes it: the
    // old request cannot be attributed to its replacement.
    push(h, id, thought("working"));
    assert.deepEqual(roles(h, id), ["lead"]);
    rt.model = "swe-2-medium";
    push(h, id, message("after switch"));
    assert.equal(roles(h, id).length, 1, "a changed model still moved the marker");
    assert.equal(rt.modelActivity.role, "lead");

    // The turn ending clears the stored marker.
    assert.ok(await h.until(() => !rt.busy), "the second turn never ended");
    assert.equal(rt.modelActivity, undefined);

    // A Single turn has no roles to mark at all.
    const seen = activity(h, id).length;
    h.send({ type: "send", text: "third" });
    assert.ok(await h.until(() => rt.busy), "the single turn never started");
    assert.equal(rt.modelActivity, undefined);
    push(h, id, thought("single thinking"));
    push(h, id, toolCall({ "cognition.ai/sidekick": true }));
    assert.equal(activity(h, id).length, seen);
  } finally {
    await h.dispose();
  }
});

test("a background turn keeps its own marker, activation restores it, and a surface move carries it", { skip: process.platform === "win32" }, async () => {
  const h = createChat();
  let to;
  try {
    await h.ready();
    const first = await h.startChat("hello");
    const rt = h.controller.runtimes.get(first);
    assert.ok(await h.until(() => rt.busy), "the turn never started");

    // Open a second chat so the first keeps working in the background.
    h.send({ type: "send", text: "second chat", newSession: true });
    assert.ok(await h.until(() => h.activeId() && h.activeId() !== first), "the second chat never opened");
    const second = h.activeId();

    // Its own state advances, but nothing is posted to the chat on screen.
    push(h, first, toolCall({ "cognition.ai/sidekick": true }));
    assert.equal(rt.modelActivity.role, "sub");
    assert.equal(activity(h, first).length, 0, "a background turn posted to the visible chat");

    // Coming back restores exactly that role's snapshot.
    h.send({ type: "activateSession", id: first });
    assert.ok(await h.until(() => activity(h, first).length === 1), "the stored marker never restored");
    const restored = activity(h, first)[0];
    assert.equal(restored.model, FUSION);
    assert.equal(restored.role, "sub");

    // A live surface move carries the marker to the receiver, not the source.
    to = createChat();
    await to.ready();
    const transfer = h.controller.exportRuntime(first);
    assert.ok(transfer, "the runtime could not be handed over");
    await to.controller.importRuntime(transfer);
    assert.ok(
      await to.until(() => activity(to, first).some((m) => m.model === FUSION && m.role === "sub")),
      "the receiver never got the stored marker"
    );
    assert.equal(activity(h, first).length, 1, "the source posted again for the moved session");
    // And new work keeps reporting to the surface that holds the runtime now.
    pushRt(rt, message("back to the lead"));
    assert.equal(activity(to, first).at(-1).role, "lead");
    assert.equal(activity(h, first).length, 1);
    assert.notEqual(second, first);
  } finally {
    await h.dispose();
    await to?.dispose();
  }
});

// --- Webview: the highlight itself ---------------------------------------

const fusion = "fusion-gpt-6-1-sol-max-fast-sidekick-gpt-6-luna-high";
const fusionBothFast = "fusion-gpt-6-1-sol-max-fast-sidekick-gpt-6-luna-high-fast";

const models = [
  { id: "fusion", name: "Fusion", default: fusion, variants: [{ value: fusion, name: "Fusion" }, { value: fusionBothFast, name: "Fusion (Fast Sub)" }] },
  {
    id: "gpt-6-1-sol", name: "GPT-6.1 Sol", default: "gpt-6-1-sol-max",
    variants: [{ value: "gpt-6-1-sol-max", name: "Max" }, { value: "gpt-6-1-sol-max-fast", name: "Max Fast" }]
  },
  { id: "gpt-6-luna", name: "GPT-6 Luna", default: "gpt-6-luna-high", variants: [{ value: "gpt-6-luna-high", name: "High" }] }
];

function options(currentModel = fusion, currentSpeed = "fast") {
  return {
    type: "options", currentModel, currentThoughtLevel: currentModel.startsWith("fusion-") ? "max" : "high",
    currentSpeed,
    thoughtLevels: [{ value: "max", name: "Max" }, { value: "high", name: "High" }],
    models,
    // The session reports the Fast Sub pair it accepts. Without that report
    // the picker treats a Fast Sub that exists only in the catalogue as one
    // the session would reject.
    modelChoices: { fusion: [{ value: fusion, name: "Fusion" }, { value: fusionBothFast, name: "Fusion (Fast Sub)" }] },
    modes: []
  };
}

function mount(currentModel = fusion, currentSpeed) {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(options(currentModel, currentSpeed));
  h.post({ type: "sessionReady", sessionId: "s-1" });
  h.post({ type: "busy", value: true });
  return h;
}

const effortLabel = (h) => h.document.getElementById("effortBtnLabel");
const effortBtn = (h) => h.document.getElementById("effortBtn");
const name = (h, role) => effortLabel(h).querySelector(`.fusion-model-name[data-role="${role}"]`);
const isActive = (h, role) => name(h, role)?.classList.contains("is-active") === true;

test("webview: the active role's name is marked without changing the label, and stale or idle updates are ignored", async () => {
  const h = mount();
  try {
    await h.settle(10);
    const label = effortLabel(h);
    // Two role groups with the model name as the only marked text. The full
    // label, efforts and the Lead's Fast bolt read exactly as before.
    assert.equal(label.querySelectorAll(".fusion-role-group").length, 2);
    assert.equal(label.textContent, "GPT-6.1 Sol Max + GPT-6 Luna High");
    assert.equal(name(h, "lead").textContent, "GPT-6.1 Sol");
    assert.equal(name(h, "sub").textContent, "GPT-6 Luna");
    assert.ok(label.querySelector('.fusion-role-group .zap-fill'), "the Fast bolt is missing");
    assert.equal(effortBtn(h).getAttribute("aria-description"), null);

    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "sub"), true);
    assert.equal(isActive(h, "lead"), false);
    assert.equal(label.textContent, "GPT-6.1 Sol Max + GPT-6 Luna High");
    assert.match(effortBtn(h).getAttribute("aria-description"), /Sub model/);
    // The whole role group lights, so the effort text and a Fast bolt share
    // the active colour with the name while the other role stays normal.
    const subGroup = name(h, "sub").closest(".fusion-role-group");
    const leadGroup = name(h, "lead").closest(".fusion-role-group");
    assert.equal(subGroup.classList.contains("is-active"), true);
    assert.equal(leadGroup.classList.contains("is-active"), false);
    assert.match(subGroup.textContent, /High/, "the lit group's effort text is part of it");

    // The marker follows the role, not the position.
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "lead" });
    await h.settle(10);
    assert.equal(isActive(h, "lead"), true);
    assert.equal(isActive(h, "sub"), false);
    assert.equal(leadGroup.classList.contains("is-active"), true);
    assert.equal(subGroup.classList.contains("is-active"), false);
    assert.match(effortBtn(h).getAttribute("aria-description"), /Lead model/);

    // Messages for another session or another model must not clear it.
    h.post({ type: "modelActivity", sessionId: "s-2", model: fusion, role: "sub" });
    h.post({ type: "modelActivity", sessionId: "s-1", model: "gpt-6-luna-high", role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "lead"), true, "a stale message moved the highlight");

    // The turn ending removes it.
    h.post({ type: "busy", value: false });
    await h.settle(10);
    assert.equal(label.querySelectorAll(".is-active").length, 0);
    assert.equal(effortBtn(h).getAttribute("aria-description"), null);
    // A marker arriving while idle does not light anything.
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "sub"), false);

    // A new turn re-arms it, and a model change drops it again.
    h.post({ type: "busy", value: true });
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "sub"), true);
    h.post({ type: "model", model: "gpt-6-luna-high" });
    await h.settle(10);
    assert.equal(effortLabel(h).querySelectorAll(".fusion-model-name").length, 0, "a Single label has no role names");
    assert.equal(effortBtn(h).getAttribute("aria-description"), null);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("webview: both Fast states keep their bolts beside the right role", async () => {
  const h = mount(fusionBothFast);
  try {
    await h.settle(10);
    const groups = [...effortLabel(h).querySelectorAll(".fusion-role-group")];
    assert.equal(groups.length, 2);
    for (const group of groups) {
      assert.ok(group.querySelector(".zap-fill"), "a Fast role lost its bolt");
      // The bolt sits inside the role group, next to that role's own text.
      assert.ok(group.querySelector(".fusion-role-text .fusion-model-name"));
    }
    assert.equal(effortLabel(h).textContent, "GPT-6.1 Sol Max + GPT-6 Luna High");
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusionBothFast, role: "lead" });
    await h.settle(10);
    assert.equal(isActive(h, "lead"), true);
    assert.equal(effortLabel(h).querySelectorAll(".zap-fill").length, 2);
    const litGroup = name(h, "lead").closest(".fusion-role-group");
    assert.equal(litGroup.classList.contains("is-active"), true);
    assert.ok(litGroup.querySelector(".zap-fill"), "the lit group's bolt is inside it");
    assert.equal(name(h, "sub").closest(".fusion-role-group").classList.contains("is-active"), false);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("webview: an optimistic pick through the picker drops the marker, so returning cannot resurrect it", async () => {
  const h = mount();
  try {
    await h.settle(10);
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "sub"), true);

    // Pick Luna as a standalone model through real picker clicks. The shared
    // composer path must drop the stored marker because the uid no longer
    // matches the one it was reported under.
    const popup = () => h.document.getElementById("model-picker-popup");
    h.document.getElementById("modelBtn").click();
    await h.settle(10);
    popup().querySelector('.dd-item-main[data-id="gpt-6-luna"]').click();
    await h.settle(10);
    assert.equal(effortLabel(h).querySelectorAll(".fusion-model-name").length, 0);
    assert.equal(effortBtn(h).getAttribute("aria-description"), null);

    // Picking the Fusion card restores the exact pair the marker was
    // reported under. With no new modelActivity event both names must stay
    // neutral rather than lighting the stale role again.
    h.document.getElementById("modelBtn").click();
    await h.settle(10);
    popup().querySelector('.dd-item-main[data-id="fusion"]').click();
    await h.settle(10);
    assert.equal(effortLabel(h).textContent, "GPT-6.1 Sol Max + GPT-6 Luna High");
    assert.equal(effortLabel(h).querySelectorAll(".is-active").length, 0, "the stored marker came back with the model");
    assert.equal(effortBtn(h).getAttribute("aria-description"), null);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("webview: clearing the thread and leaving it remove the marker", async () => {
  const h = mount();
  try {
    await h.settle(10);
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(isActive(h, "sub"), true);

    // Another session takes the thread: its own neutral snapshot applies.
    h.post({ type: "sessionReady", sessionId: "s-2" });
    await h.settle(10);
    assert.equal(effortLabel(h).querySelectorAll(".is-active").length, 0);
    // The old session's stale marker cannot come back.
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "sub" });
    await h.settle(10);
    assert.equal(effortLabel(h).querySelectorAll(".is-active").length, 0);

    // Back on s-1 mid turn, then away to the list: the marker does not linger.
    h.post({ type: "sessionReady", sessionId: "s-1" });
    h.post({ type: "modelActivity", sessionId: "s-1", model: fusion, role: "lead" });
    await h.settle(10);
    assert.equal(isActive(h, "lead"), true);
    h.post({ type: "body", body: "list" });
    await h.settle(10);
    h.post({ type: "body", body: "thread" });
    h.post({ type: "sessionReady", sessionId: "s-1" });
    await h.settle(10);
    assert.equal(effortLabel(h).querySelectorAll(".is-active").length, 0, "the marker survived leaving the thread");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test.after(() => cleanup());
