const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./webview-harness");
const { createChat, cleanup } = require("./chat-harness");
const fixture = require("./model-fixture");

// Issue #2: a catalogue Max effort was silently dropped between the picker and
// the ACP wire because the effort suffix parsers did not know the max token.
// These tests cover the reported model ids in the webview and on the ACP wire.

const HIGH_MAX = [{ value: "high", name: "High" }, { value: "max", name: "Max" }];

// The literal families from the report, each carrying high and max uids.
const REPORTED = [
  { id: "swe-2", name: "SWE-2" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "glm-5-3", name: "GLM 5.3" }
];
const REPORTED_MODELS = REPORTED.map((fam) => ({
  ...fam,
  default: `${fam.id}-high`,
  variants: [
    { value: `${fam.id}-high`, name: `${fam.name} High` },
    { value: `${fam.id}-max`, name: `${fam.name} Max` }
  ]
}));

const FUSION_REPORTED = {
  id: "fusion", name: "Fusion",
  default: "fusion-claude-opus-5-high-sidekick-swe-2-high",
  variants: ["high", "max"].flatMap((lead) => ["high", "max"].map((sub) => ({
    value: `fusion-claude-opus-5-${lead}-sidekick-swe-2-${sub}`,
    name: `Fusion (Claude Opus 5 ${lead} + SWE-2 ${sub})`
  })))
};

function mount(overrides) {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options(overrides));
  return h;
}
function popup(h) {
  return h.document.querySelector("#model-picker-popup");
}
function openTray(h, trigger = "model") {
  h.document.querySelector(trigger === "effort" ? "#effortBtn" : "#modelBtn").click();
  return popup(h);
}
function rowAction(tray, id) {
  return tray.querySelector(`#act-${id}`);
}
function segs(tray) {
  return [...tray.querySelectorAll(".effort-seg")];
}
function seg(tray, effort) {
  return segs(tray).find((s) => s.dataset.effort === effort);
}
function checkedSeg(tray) {
  return segs(tray).find((s) => s.getAttribute("aria-checked") === "true");
}
function pickRole(tray, role) {
  const radio = tray.querySelector(`#roleRadio-${role}`);
  radio.checked = true;
  radio.dispatchEvent(new radio.ownerDocument.defaultView.Event("change", { bubbles: true }));
}
function effortLabel(h) {
  return h.document.querySelector("#effortBtnLabel").textContent;
}
function sendThroughComposer(h, text) {
  const input = h.document.querySelector("#input");
  input.value = text;
  input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  h.document.querySelector("#send").click();
}
// The wire calls the agent really saw, in order, reduced to [configId, value].
function configCalls(h) {
  return h.agentSaw("session/set_config_option").map((r) => [r.params.configId, r.params.value]);
}
function configCallsBefore(h, index) {
  return h.agentSaw().slice(0, index).filter((m) => m.method === "session/set_config_option")
    .map((r) => [r.params.configId, r.params.value]);
}

for (const fam of REPORTED) {
  test(`${fam.name} Max effort survives an accepted high uid through a sent turn`, () => {
    const options = (thoughtLevel) => fixture.options({
      models: REPORTED_MODELS, modelChoices: {},
      currentModel: `${fam.id}-high`, currentThoughtLevel: thoughtLevel,
      thoughtLevels: HIGH_MAX, speedOptions: [], sessionConfig: true
    });
    const h = mount({
      models: REPORTED_MODELS, modelChoices: {},
      currentModel: `${fam.id}-high`, currentThoughtLevel: "high",
      thoughtLevels: HIGH_MAX, speedOptions: [], sessionConfig: true
    });
    const tray = openTray(h, "effort");
    assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["high", "max"]);
    seg(tray, "max").click();
    const sent = h.posted.filter((m) => m.type === "setConfigOption" && m.configId === "thought_level").at(-1);
    assert.equal(sent.value, "max");
    assert.equal(sent.model, `${fam.id}-high`);
    assert.equal(checkedSeg(tray).dataset.effort, "max");
    assert.equal(effortLabel(h), "Max");
    // The agent's reply first echoes the reset High it applies on a model
    // change, then confirms the requested level against the high uid.
    h.post(options("high"));
    assert.equal(effortLabel(h), "Max", "an intermediate options echo never moves the pick");
    h.post({ type: "modelConfigApplied", requestId: sent.requestId, model: `${fam.id}-high`, thoughtLevel: "max", speed: "standard" });
    assert.equal(effortLabel(h), "Max");
    h.post(options("max"));
    h.post({ type: "model", model: `${fam.id}-high` });
    assert.equal(effortLabel(h), "Max", "a high uid echo must not reset the reported Max effort");
    sendThroughComposer(h, `keep ${fam.id} at max`);
    assert.ok(h.posted.some((m) => m.type === "send" && m.text === `keep ${fam.id} at max`));
    h.post({ type: "busy", value: true });
    h.post({ type: "userMessage", text: `keep ${fam.id} at max` });
    h.post({ type: "assistantEnd", stopReason: "end_turn" });
    h.post({ type: "busy", value: false });
    assert.equal(effortLabel(h), "Max");
    assert.equal(h.errors().length, 0);
  });

  test(`host maps a first message ${fam.id}-max to the accepted high uid with max effort`, { skip: process.platform === "win32" }, async () => {
    const h = createChat({
      modelOptions: [{ value: `${fam.id}-high`, name: `${fam.name} High` }],
      thoughtLevels: HIGH_MAX,
      promptDelay: 50,
      config: { defaultMode: "", defaultModel: `${fam.id}-max`, defaultThoughtLevel: "", defaultSpeed: "" }
    });
    try {
      await h.startChat(`first message on ${fam.id} max`);
      assert.ok(await h.until(() => h.controller.runtimes.get(h.activeId())?.busy === false), "first prompt reaches idle");
      const wire = h.agentSaw();
      const promptAt = wire.findIndex((m) => m.method === "session/prompt");
      assert.ok(promptAt > -1, "the prompt was sent");
      assert.deepEqual(configCallsBefore(h, promptAt), [
        ["model", `${fam.id}-high`],
        ["thought_level", "max"],
        ["speed", "standard"]
      ], "the inferred max lands before the first prompt");
      assert.ok(!configCalls(h).some(([id, value]) => id === "model" && value === `${fam.id}-max`),
        "the unsupported max uid is never requested as a model");
      assert.equal(h.last("options").currentThoughtLevel, "max");
      assert.equal(h.controller.currentThoughtLevel, "max");
    } finally {
      await h.dispose();
    }
  });
}

test("host keeps max on a later swe-2-max selection and the next prompt", { skip: process.platform === "win32" }, async () => {
  const h = createChat({
    modelOptions: [{ value: "swe-2-high", name: "SWE-2 High" }],
    thoughtLevels: HIGH_MAX,
    promptDelay: 50,
    config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "", defaultSpeed: "" }
  });
  try {
    await h.startChat("idle first prompt");
    assert.ok(await h.until(() => h.controller.runtimes.get(h.activeId())?.busy === false), "initial prompt reaches idle");
    assert.equal(h.agentSaw("session/set_config_option").length, 0, "the idle session takes its own defaults");
    h.send({ type: "setModel", model: "swe-2-max", requestId: 7 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 7));
    assert.equal(h.last("modelConfigApplied").thoughtLevel, "max", "effort inferred from the uid, not from a thoughtLevel field");
    h.send({ type: "send", text: "next real message" });
    assert.ok(await h.until(() => h.agentSaw("session/prompt").length === 2));
    assert.ok(await h.until(() => h.controller.runtimes.get(h.activeId())?.busy === false), "second prompt reaches idle");
    const wire = h.agentSaw();
    const secondPromptAt = wire.map((m) => m.method).lastIndexOf("session/prompt");
    const levels = configCallsBefore(h, secondPromptAt).filter(([id]) => id === "thought_level");
    assert.deepEqual(levels.at(-1), ["thought_level", "max"], "the last applied level before the prompt is still max");
    assert.ok(!levels.some(([, value]) => value === "high"), "no high reset is emitted");
    assert.equal(h.last("options").currentThoughtLevel, "max");
    assert.equal(h.controller.currentThoughtLevel, "max");
  } finally {
    await h.dispose();
  }
});

test("host maps a first message Fusion max pair to the accepted pair", { skip: process.platform === "win32" }, async () => {
  const accepted = "fusion-claude-opus-5-high-sidekick-swe-2-max";
  const h = createChat({
    modelOptions: [{ value: accepted, name: "Fusion (Claude Opus 5 High + SWE-2 Max)" }],
    thoughtLevels: HIGH_MAX,
    promptDelay: 50,
    config: {
      defaultMode: "", defaultThoughtLevel: "", defaultSpeed: "",
      defaultModel: "fusion-claude-opus-5-max-sidekick-swe-2-max"
    }
  });
  try {
    await h.startChat("first fusion message on max");
    assert.ok(await h.until(() => h.controller.runtimes.get(h.activeId())?.busy === false), "first Fusion prompt reaches idle");
    const wire = h.agentSaw();
    const promptAt = wire.findIndex((m) => m.method === "session/prompt");
    assert.ok(promptAt > -1, "the prompt was sent");
    assert.deepEqual(configCallsBefore(h, promptAt), [
      ["model", accepted],
      ["thought_level", "max"],
      ["speed", "standard"]
    ], "the accepted pair keeps the SWE-2 max suffix and the Lead max effort");
    assert.equal(h.last("options").currentThoughtLevel, "max");
    assert.equal(h.controller.currentThoughtLevel, "max");
  } finally {
    await h.dispose();
  }
});

test("a Fusion Sub Max pick posts the max pair and survives acknowledgement", () => {
  const h = mount({
    models: [FUSION_REPORTED, ...REPORTED_MODELS.filter((f) => f.id !== "glm-5-3")], modelChoices: {},
    currentModel: "fusion-claude-opus-5-high-sidekick-swe-2-high", currentThoughtLevel: "high",
    thoughtLevels: HIGH_MAX, speedOptions: [], sessionConfig: true
  });
  const tray = openTray(h, "effort");
  pickRole(tray, "sub");
  rowAction(tray, "swe-2").click();
  assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["high", "max"]);
  seg(tray, "max").click();
  const sent = h.posted.filter((m) => m.type === "setFusionModel").at(-1);
  assert.ok(sent.model.endsWith("-sidekick-swe-2-max"), `posted pair carries the max sub, got ${sent.model}`);
  assert.equal(sent.thoughtLevel, "high", "the Lead effort is untouched");
  assert.equal(checkedSeg(tray).dataset.effort, "max");
  h.post({
    type: "modelConfigApplied", requestId: sent.requestId,
    model: "fusion-claude-opus-5-high-sidekick-swe-2-max", thoughtLevel: "high", speed: "standard"
  });
  assert.equal(checkedSeg(tray).dataset.effort, "max", "Sub Max stays selected after the accepted ack");
  assert.equal(h.errors().length, 0);
});

test.after(() => cleanup());
