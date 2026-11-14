const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./webview-harness");
const { createChat, cleanup } = require("./chat-harness");
const fixture = require("./model-fixture");

// Live ACP accepts only pairs it advertises. The session that owns the
// reported model list has a single speed control for the Lead, so a
// catalogue Fast Sub pair that is not advertised is rejected with -32602.
// These tests cover the scoped contract: a Fast Sub pair is offered only when
// the session's model choices contain that complete Sub uid, standard Sub
// pairs and Lead effort/speed are untouched, and the host refuses an
// unadvertised pair locally instead of sending an invalid model value.

const HIGH_MAX = [{ value: "high", name: "High" }, { value: "max", name: "Max" }];
const BOTH_SPEEDS = [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }];

const STANDARD_LUNA = "fusion-gpt-6-1-sol-high-sidekick-gpt-6-luna-high";
const PRIORITY_LUNA = "fusion-gpt-6-1-sol-high-sidekick-gpt-6-luna-high-priority";
const REJECTED = "fusion-gpt-6-1-sol-max-fast-sidekick-gpt-6-luna-high-priority";
const REJECTED_STANDARD_LEAD = "fusion-gpt-6-1-sol-high-sidekick-gpt-6-luna-high-priority";
const pair = (effort, speed, sub) => `fusion-gpt-6-1-sol-${effort}${speed}-sidekick-${sub}`;
const LEAD_SPEEDS = ["", "-fast"];
const SUB_UIDS = ["gpt-6-luna-high", "gpt-6-luna-high-priority", "swe-2-medium"];

const CATALOG_MODELS = [
  {
    id: "fusion", name: "Fusion", default: STANDARD_LUNA,
    variants: ["high", "max"].flatMap((e) => LEAD_SPEEDS.flatMap((s) => SUB_UIDS.map((sub) => ({
      value: pair(e, s, sub), name: pair(e, s, sub)
    }))))
  },
  {
    id: "gpt-6-1-sol", name: "GPT-6.1 Sol", default: "gpt-6-1-sol-high",
    variants: ["high", "max"].flatMap((e) => LEAD_SPEEDS.map((s) => ({
      value: `gpt-6-1-sol-${e}${s}`, name: `GPT-6.1 Sol ${e}${s || "-standard"}`
    })))
  },
  {
    id: "gpt-6-luna", name: "GPT-6 Luna", default: "gpt-6-luna-high",
    variants: [{ value: "gpt-6-luna-high", name: "High" }, { value: "gpt-6-luna-high-priority", name: "High Fast" }]
  },
  { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }] }
];

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
function rowMain(tray, id) {
  return tray.querySelector(`.dd-item-main[data-id="${id}"]`);
}
function rowAction(tray, id) {
  return tray.querySelector(`#act-${id}`);
}
function segs(tray) {
  return [...tray.querySelectorAll(".effort-seg")];
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
function fusionPosts(h) {
  return h.posted.filter((m) => m.type === "setFusionModel");
}
function configCallsBefore(h, index) {
  return h.agentSaw().slice(0, index).filter((m) => m.method === "session/set_config_option")
    .map((r) => [r.params.configId, r.params.value]);
}
function recordConfigWrites() {
  const workspace = globalThis.__dvVscode.workspace;
  const original = workspace.getConfiguration;
  const writes = [];
  workspace.getConfiguration = (...args) => ({
    ...original(...args),
    update: async (key, value) => { writes.push([key, value]); }
  });
  return { writes, restore: () => { workspace.getConfiguration = original; } };
}

test("a catalogue only Fast Sub is hidden while the Lead keeps Max and Fast", () => {
  const h = mount({
    models: CATALOG_MODELS,
    currentModel: pair("high", "", "swe-2-medium"), currentThoughtLevel: "max", currentSpeed: "fast",
    thoughtLevels: HIGH_MAX, speedOptions: BOTH_SPEEDS, sessionConfig: true,
    modelChoices: { fusion: [{ value: STANDARD_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High)" }] }
  });
  const tray = openTray(h, "effort");
  pickRole(tray, "sub");
  const lunaRow = rowMain(tray, "gpt-6-luna");
  assert.ok(lunaRow, "Luna stays selectable");
  assert.ok(!lunaRow.querySelector(".dd-fast-badge"), "no Fast badge without an advertised fast pair");
  lunaRow.click();
  const sent = fusionPosts(h).at(-1);
  assert.equal(sent.model, "fusion-gpt-6-1-sol-max-sidekick-gpt-6-luna-high", "selecting Luna posts a standard-Sub pair");
  assert.equal(sent.thoughtLevel, "max");
  assert.equal(sent.speed, "fast", "Lead effort and speed ride along unchanged");
  rowAction(tray, "gpt-6-luna").click();
  assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["high"], "only the standard Sub effort is offered");
  assert.ok(!tray.querySelector("#fast-thinking"), "no Sub Fast toggle without an advertised fast pair");
  tray.querySelector("#pageBack").click();
  pickRole(tray, "lead");
  rowAction(tray, "gpt-6-1-sol").click();
  assert.equal(checkedSeg(tray).dataset.effort, "max", "Lead Max stays selected");
  assert.equal(tray.querySelector("#fast-thinking")?.getAttribute("aria-pressed"), "true", "Lead Fast stays on");
  assert.match(effortLabel(h), /Sol Max/, "the composer keeps the Lead Max label");
  assert.ok(h.document.querySelector("#effortBtn .zap-fill"), "the composer keeps the Lead Fast bolt");
  assert.match(h.document.querySelector("#effortBtn").title, /Max Fast/, "the label title keeps Lead Max and Fast");
  const prefs = h.state().modelPreferences;
  assert.equal(prefs.sub["gpt-6-luna"].effort, "high");
  assert.equal(prefs.sub["gpt-6-luna"].speed, "standard");
  assert.equal(h.errors().length, 0);
});

test("a Fast Sub appears only after the session advertises the pair", () => {
  const advertised = {
    models: CATALOG_MODELS,
    currentModel: STANDARD_LUNA, currentThoughtLevel: "max", currentSpeed: "fast",
    thoughtLevels: HIGH_MAX, speedOptions: BOTH_SPEEDS, sessionConfig: true,
    modelChoices: { fusion: [
      { value: STANDARD_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High)" },
      { value: PRIORITY_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High Fast)" }
    ] }
  };
  const h = mount({ ...advertised, modelChoices: {} });
  const tray = openTray(h, "effort");
  pickRole(tray, "sub");
  rowAction(tray, "gpt-6-luna").click();
  assert.ok(!tray.querySelector("#fast-thinking"), "a bootstrap session cannot offer Sub Fast");
  h.post(fixture.options(advertised));
  tray.querySelector("#pageBack").click();
  assert.ok(rowMain(tray, "gpt-6-luna").querySelector(".dd-fast-badge"), "the advertised pair unlocks the badge");
  rowAction(tray, "gpt-6-luna").click();
  const toggle = tray.querySelector("#fast-thinking");
  assert.ok(toggle, "the advertised pair unlocks the toggle");
  toggle.click();
  const sent = fusionPosts(h).at(-1);
  assert.equal(sent.model, "fusion-gpt-6-1-sol-max-sidekick-gpt-6-luna-high-priority", "the toggle posts the priority Sub pair");
  assert.equal(sent.thoughtLevel, "max");
  assert.equal(sent.speed, "fast", "Lead effort and speed are retained");
  assert.equal(h.errors().length, 0);
});

test("a single model's own Fast controls are unchanged by the Fusion filter", () => {
  const h = mount({
    models: CATALOG_MODELS, modelChoices: {},
    currentModel: "gpt-6-luna-high", currentThoughtLevel: "high", currentSpeed: "standard",
    thoughtLevels: HIGH_MAX, speedOptions: BOTH_SPEEDS, sessionConfig: true
  });
  const tray = openTray(h);
  assert.ok(rowMain(tray, "gpt-6-luna").querySelector(".dd-fast-badge"), "single Luna keeps its Fast badge");
  const detail = openTray(h, "effort");
  const toggle = detail.querySelector("#fast-thinking");
  assert.ok(toggle, "single Luna keeps its Fast toggle");
  toggle.click();
  const sent = h.posted.filter((m) => m.type === "setConfigOption").at(-1);
  assert.equal(sent.configId, "speed");
  assert.equal(sent.value, "fast");
  assert.equal(h.errors().length, 0);
});

test("Fusion uses the interface icon in composer, card and setup header", () => {
  const models = [
    { id: "adaptive", name: "Adaptive", default: "adaptive", variants: [{ value: "adaptive", name: "Adaptive" }] },
    ...CATALOG_MODELS
  ];
  const h = mount({
    models, modelChoices: {},
    currentModel: STANDARD_LUNA, currentThoughtLevel: "high",
    thoughtLevels: HIGH_MAX, speedOptions: [], sessionConfig: true
  });
  assert.ok(h.document.querySelector("#modelBtn .dd-icon .codicon-symbol-interface"), "the composer uses the interface icon");
  const tray = openTray(h);
  assert.ok(rowMain(tray, "fusion").querySelector(".codicon-symbol-interface"), "the Fusion card uses the interface icon");
  assert.ok(!rowMain(tray, "adaptive").querySelector(".codicon-symbol-interface"), "Adaptive keeps its own icon");
  assert.ok(!rowMain(tray, "gpt-6-1-sol").querySelector(".codicon-symbol-interface"), "normal models keep their own icons");
  rowMain(tray, "fusion").click();
  assert.ok(tray.querySelector(".tray-head-left .codicon-symbol-interface"), "the Fusion setup header uses the interface icon");
  assert.equal(h.errors().length, 0);
});

test("the host refuses an unadvertised Fast Sub pair before any RPC", { skip: process.platform === "win32" }, async () => {
  const h = createChat({
    modelOptions: [{ value: STANDARD_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High)" }],
    thoughtLevels: HIGH_MAX,
    promptDelay: 50,
    config: { defaultMode: "", defaultModel: "fusion-gpt-6-1-sol-max-fast-sidekick-gpt-6-luna-high", defaultThoughtLevel: "", defaultSpeed: "" }
  });
  const config = recordConfigWrites();
  const vscode = globalThis.__dvVscode;
  try {
    await h.startChat("configure fusion");
    const promptAt = h.agentSaw().findIndex((m) => m.method === "session/prompt");
    assert.deepEqual(configCallsBefore(h, promptAt), [
      ["model", STANDARD_LUNA],
      ["thought_level", "max"],
      ["speed", "fast"]
    ], "the accepted standard pair is configured with Max and Lead Fast");
    const baselineCalls = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setModel", model: REJECTED, requestId: 9 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 9));
    assert.deepEqual(h.agentSaw("session/set_config_option").slice(baselineCalls), [],
      "the unadvertised pair never reaches the agent");
    const applied = h.last("modelConfigApplied");
    assert.equal(applied.model, STANDARD_LUNA, "the confirmed model is the accepted pair");
    assert.equal(applied.thoughtLevel, "max");
    assert.equal(applied.speed, "fast");
    assert.ok(vscode.window.shown.warning.some((w) => w.includes("not supported by the current ACP session")),
      "the user sees a clear local warning");
    assert.ok(!config.writes.some(([, value]) => String(value).includes("priority")),
      "the rejected pair is never persisted");
    h.send({ type: "setModel", model: STANDARD_LUNA, thoughtLevel: "max", speed: "fast", requestId: 10 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 10));
    assert.equal(h.last("modelConfigApplied").thoughtLevel, "max");
    assert.equal(h.last("modelConfigApplied").speed, "fast");
  } finally {
    config.restore();
    await h.dispose();
  }
});

test("the host applies an advertised Fast Sub pair through the model guard", { skip: process.platform === "win32" }, async () => {
  const h = createChat({
    modelOptions: [
      { value: STANDARD_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High)" },
      { value: PRIORITY_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High Fast)" }
    ],
    thoughtLevels: HIGH_MAX,
    promptDelay: 50,
    config: { defaultMode: "", defaultModel: STANDARD_LUNA, defaultThoughtLevel: "max", defaultSpeed: "fast" }
  });
  try {
    await h.startChat("configure fusion");
    assert.ok(await h.until(() => h.controller.runtimes.get(h.activeId())?.busy === false), "initial prompt reaches idle");
    const baselineCalls = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setModel", model: REJECTED, requestId: 12 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 12));
    assert.deepEqual(
      h.agentSaw("session/set_config_option").slice(baselineCalls).map((r) => [r.params.configId, r.params.value]),
      [["model", PRIORITY_LUNA], ["thought_level", "max"], ["speed", "fast"]],
      "the advertised pair passes the guard and applies Max and Lead Fast"
    );
    const applied = h.last("modelConfigApplied");
    assert.equal(applied.model, PRIORITY_LUNA);
    assert.equal(applied.thoughtLevel, "max");
    assert.equal(applied.speed, "fast");
  } finally {
    await h.dispose();
  }
});

test("the host still rejects an unadvertised pair when only the Sub speed differs", { skip: process.platform === "win32" }, async () => {
  const h = createChat({
    modelOptions: [{ value: STANDARD_LUNA, name: "Fusion (GPT-6.1 Sol High + GPT-6 Luna High)" }],
    thoughtLevels: HIGH_MAX,
    promptDelay: 50,
    config: { defaultMode: "", defaultModel: STANDARD_LUNA, defaultThoughtLevel: "max", defaultSpeed: "fast" }
  });
  const vscode = globalThis.__dvVscode;
  try {
    await h.startChat("configure fusion");
    const baselineCalls = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setModel", model: REJECTED_STANDARD_LEAD, requestId: 11 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 11));
    assert.deepEqual(h.agentSaw("session/set_config_option").slice(baselineCalls), [],
      "even with matching Lead suffixes the Sub fast pair is refused locally");
    assert.equal(h.last("modelConfigApplied").model, STANDARD_LUNA);
    assert.ok(vscode.window.shown.warning.some((w) => w.includes("not supported by the current ACP session")));
  } finally {
    await h.dispose();
  }
});

test.after(async () => { await cleanup(); });
