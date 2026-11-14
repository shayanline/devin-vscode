const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./webview-harness");
const { createChat, cleanup } = require("./chat-harness");
const fixture = require("./model-fixture");
const pricingFixture = require("./model-picker-pricing-fixture.json");

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
function openFusionPage(h) {
  const tray = openTray(h, "effort");
  return tray;
}
function rowMain(tray, id) {
  return tray.querySelector(`.dd-item-main[data-id="${id}"]`);
}
function rowAction(tray, id) {
  return tray.querySelector(`#act-${id}`);
}
function rowNames(tray, selector = ".dd-rows .dd-item") {
  return [...tray.querySelectorAll(selector)].map((el) => el.querySelector(".dd-item-name")?.textContent);
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
function fusionPosts(h) {
  return h.posted.filter((m) => m.type === "setFusionModel");
}
function effortLabel(h) {
  return h.document.querySelector("#effortBtnLabel").textContent;
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

test("Fusion groups its Lead and Sub role lists behind the composer effort segment", () => {
  const h = mount({ currentModel: "fusion-claude-opus-5-5-max-fast-sidekick-swe-2-medium", currentSpeed: "fast" });
  const group = h.document.querySelector("#model-picker-group");
  assert.equal(h.document.querySelector("#modelBtn .dd-label").textContent, "Fusion");
  assert.match(effortLabel(h), /Opus 5\.5 Max/);
  assert.match(effortLabel(h), /\+ SWE-2 Medium/);
  assert.ok(effortLabel(h).includes("Max"), "the lead effort is on the segment");
  const tray = openFusionPage(h);
  assert.deepEqual([...tray.querySelectorAll(".role-radio")].map((r) => r.value), ["lead", "sub"]);
  assert.equal(tray.querySelector("#roleRadio-lead").checked, true);
  assert.deepEqual(rowNames(tray, ".fusion-rows .dd-item"), ["Claude Opus 5.5", "GPT-6 Astra"], "Lead rows compatible with the current sub");
  assert.ok(rowMain(tray, "claude-opus-5-5").closest(".dd-item").classList.contains("selected"));
  assert.match(rowAction(tray, "claude-opus-5-5").title, /lead effort/i);
  pickRole(tray, "sub");
  assert.deepEqual(rowNames(tray, ".fusion-rows .dd-item"), ["GPT-6 Luna", "SWE-2", "SWE-2 Flash"], "sub models collapse their effort variants");
  assert.equal(h.errors().length, 0);
});

test("Fusion sub effort and speed select supported pairs without changing Lead settings", () => {
  const h = mount({ currentSpeed: "fast" });
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(tray, "swe-2").click();
  assert.equal(tray.querySelector(".tray-sub").textContent, "Fusion - Sub model");
  assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["medium", "high"]);
  assert.ok(!tray.querySelector("#fast-thinking"), "SWE-2 has no fast sub variant");
  seg(tray, "high").click();
  const last = () => fusionPosts(h).at(-1);
  assert.match(last().model, /-sidekick-swe-2-high$/);
  assert.equal(last().thoughtLevel, "max");
  assert.equal(last().speed, "fast", "the lead speed rides along");
  tray.querySelector("#pageBack").click();
  rowMain(tray, "gpt-6-luna").click();
  assert.match(last().model, /-sidekick-gpt-6-luna-high$/, "the row applies its own default");
  tray.querySelector("#roleRadio-sub") && pickRole(tray, "sub");
  rowAction(tray, "gpt-6-luna").click();
  assert.ok(tray.querySelector("#fast-thinking"), "GPT-6 Luna has a fast sub variant at High");
  tray.querySelector("#fast-thinking").click();
  assert.match(last().model, /-sidekick-gpt-6-luna-high-priority$/);
  assert.equal(last().speed, "fast");
  assert.equal(h.errors().length, 0);
});

for (const model of ["claude-opus-5-5-max", "claude-opus-5-5-high"]) {
  test(`fast thinking is independent of effort for ${model}`, () => {
    const h = mount({ currentModel: model });
    const tray = openTray(h, "effort");
    const button = tray.querySelector("#fast-thinking");
    assert.ok(button, "Fast is offered on the details page");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    button.click();
    assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "true");
    const request = h.posted.filter((m) => m.type === "setConfigOption").at(-1);
    assert.equal(request.configId, "speed");
    assert.equal(request.value, "fast");
    assert.equal(request.model, model);
    assert.equal(request.thoughtLevel, "max");
    h.post(fixture.options({ currentModel: model, currentSpeed: "standard" }));
    assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "true", "an intermediate reply cannot undo the toggle");
    h.post({ type: "modelConfigApplied", requestId: request.requestId, model, thoughtLevel: "max", speed: "standard" });
    assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "false", "a rejected toggle restores the confirmed speed");
    assert.equal(h.errors().length, 0);
  });
}

test("catalogue effort choices exclude duplicate Fast variants", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high", thoughtLevels: [], currentThoughtLevel: "", speedOptions: [] });
  const tray = openTray(h, "effort");
  assert.deepEqual(segs(tray).map((s) => s.textContent), ["Low", "High", "Max"]);
  assert.equal(checkedSeg(tray).dataset.effort, "high");
  assert.equal(h.errors().length, 0);
});

test("changing the Lead offers only compatible sub models", () => {
  const h = mount({ currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-medium", currentSpeed: "fast" });
  const tray = openFusionPage(h);
  rowMain(tray, "gpt-6-astra").click();
  const last = () => fusionPosts(h).at(-1);
  assert.ok(fixture.models[0].variants.some((v) => v.value === last().model), "the posted pair is a real variant");
  assert.equal(last().speed, "standard");
  pickRole(tray, "sub");
  assert.deepEqual(rowNames(tray, ".fusion-rows .dd-item"), ["GPT-6 Luna", "SWE-2"], "GPT-6 Astra cannot pair with Flash");
  pickRole(tray, "lead");
  rowAction(tray, "gpt-6-astra").click();
  assert.ok(!tray.querySelector("#fast-thinking"), "Fast stays hidden when the Lead has none");
  assert.equal(h.errors().length, 0);
});

test("Fusion sub effort falls back to a supported speed instead of dropping the effort", () => {
  const lunaSubs = ["low", "medium", "high", "high-priority"].map((suffix) => ({
    value: `fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-${suffix}`,
    name: `Fusion (Claude Opus 5.5 High + GPT-6 Luna ${suffix === "high-priority" ? "High Fast" : suffix[0].toUpperCase() + suffix.slice(1)})`
  }));
  const models = fixture.models.map((fam) => fam.id === "fusion" ? { ...fam, variants: lunaSubs } : fam);
  const h = mount({
    currentModel: "fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-high-priority",
    models,
    modelChoices: { fusion: lunaSubs },
    thoughtLevels: [{ value: "high", name: "High" }],
    currentThoughtLevel: "high"
  });
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(tray, "gpt-6-luna").click();
  assert.equal(checkedSeg(tray).dataset.effort, "high", "the sub starts on High Fast");
  seg(tray, "medium").click();
  const last = fusionPosts(h).at(-1);
  assert.equal(last.model, "fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-medium", "the medium standard pair wins over the low pair");
  assert.equal(last.thoughtLevel, "high", "the Lead effort is unchanged");
  assert.equal(last.speed, "standard");
  assert.equal(checkedSeg(tray).dataset.effort, "medium", "the requested sub effort is kept");
  assert.ok(!tray.querySelector("#fast-thinking"), "Medium has no fast sub variant");
  assert.equal(h.errors().length, 0);
});

test("Escape closes the picker and an outside click dismisses it", () => {
  const h = mount();
  const tray = openTray(h);
  const search = tray.querySelector("#pageSearch");
  search.focus();
  tray.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(popup(h).classList.contains("hidden"), "Escape closes the tray");
  assert.equal(h.document.activeElement, h.document.querySelector("#modelBtn"), "focus returns to the trigger");
  openTray(h);
  h.document.body.dispatchEvent(new h.window.MouseEvent("mousedown", { bubbles: true }));
  assert.ok(popup(h).classList.contains("hidden"), "an outside pointer press closes the tray");
  assert.equal(h.errors().length, 0);
});

test("changing the Lead speed keeps Fusion configuration open", () => {
  const h = mount();
  const tray = openTray(h, "effort");
  pickRole(tray, "lead");
  rowAction(tray, "claude-opus-5-5").click();
  const fast = tray.querySelector("#fast-thinking");
  assert.ok(fast, "the Lead effort page offers Fast");
  fast.click();
  assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "true");
  assert.ok(!tray.classList.contains("hidden"), "the tray stays open while configuring");
  assert.equal(h.errors().length, 0);
});

test("an open picker stays inside the viewport after resizing", () => {
  const h = mount();
  const tray = openTray(h);
  const group = h.document.querySelector("#model-picker-group");
  group.getBoundingClientRect = () => ({ left: 100, right: 404, width: 304, top: 400, bottom: 420, height: 20 });
  h.window.innerWidth = 320;
  h.window.innerHeight = 768;
  h.window.dispatchEvent(new h.window.Event("resize"));
  assert.equal(tray.style.left, "8px", "the popup clamps to the viewport inset");
  assert.equal(tray.style.width, "304px");
  assert.ok(!tray.classList.contains("hidden"));
  assert.equal(h.errors().length, 0);
});

test("a session model notification restores that model's reported speed", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high", currentSpeed: "fast" });
  h.post(fixture.options({ currentModel: "gpt-6-astra-high", currentSpeed: "standard" }));
  h.post({ type: "model", model: "gpt-6-astra-high" });
  const tray = openTray(h, "effort");
  assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "false");
  h.post(fixture.options({ currentModel: "gpt-6-astra-high", currentSpeed: "", speedOptions: [], sessionConfig: true }));
  assert.ok(!tray.querySelector("#fast-thinking"), "an authoritative empty report leaves no Fast toggle");
  assert.equal(h.errors().length, 0);
});

test("only the latest fast thinking acknowledgement changes the toggle", () => {
  const h = mount();
  const tray = openTray(h, "effort");
  pickRole(tray, "lead");
  rowAction(tray, "claude-opus-5-5").click();
  const fast = () => tray.querySelector("#fast-thinking");
  fast().click();
  fast().click();
  const requests = h.posted.filter((m) => m.configId === "speed");
  h.post({ type: "modelConfigApplied", requestId: requests[0].requestId, model: fixture.models[0].default, speed: "fast" });
  assert.equal(fast().getAttribute("aria-pressed"), "false");
  h.post({ type: "modelConfigApplied", requestId: requests[1].requestId, model: fixture.models[0].default, speed: "fast" });
  assert.equal(fast().getAttribute("aria-pressed"), "true", "the final confirmed value wins");
  assert.equal(h.errors().length, 0);
});

test("Fusion context reports each model window and preserves zero usage", () => {
  const h = mount();
  const contexts = [
    { modelId: "claude-opus-5-5-max", totalTokens: 200000, maxTokens: 1000000, sections: [{ kind: "messages", tokens: 200000 }] },
    { modelId: "swe-2-medium", totalTokens: 196500, maxTokens: 262000, sections: [] }
  ];
  h.post({ type: "usage", used: 0, size: 0, contexts });
  const ring = h.document.querySelector("#usage");
  assert.ok(!ring.classList.contains("hidden"));
  assert.deepEqual([...ring.querySelectorAll(".usage-role-letter")].map((n) => n.textContent), ["L", "S"], "Fusion shows role letters, not a combined percentage");
  assert.match(ring.querySelector('[data-role="lead"]').getAttribute("aria-label"), /20%/);
  assert.match(ring.querySelector('[data-role="sub"]').getAttribute("aria-label"), /75%/);
  ring.click();
  const usagePopup = h.document.querySelector("#usage-popup");
  assert.match(usagePopup.textContent, /Lead.*Claude Opus 5\.5/);
  assert.match(usagePopup.textContent, /Sub model.*SWE-2/);
  assert.match(usagePopup.textContent, /200k \/ 1000k/);
  openTray(h);
  assert.equal(h.document.querySelector("#usage-popup"), null, "opening the picker closes the overlapping context popup");
  h.post({ type: "usage", used: 0, size: 1000000 });
  assert.ok(!ring.classList.contains("hidden"));
  assert.deepEqual([...ring.querySelectorAll(".usage-role-letter")].map((n) => n.textContent), ["L", "S"], "an aggregate update keeps the last structured report");
  h.post({ type: "usage", contexts: contexts.map((c) => ({ ...c, totalTokens: 0 })) });
  assert.match(ring.querySelector('[data-role="sub"]').getAttribute("aria-label"), /0%/, "a reported zero stays a known window");
  assert.equal(ring.querySelector('[data-role="sub"]').querySelectorAll("circle").length, 2);
  assert.equal(h.errors().length, 0);
});

test("six Fusion effort options fit one rail", () => {
  const six = ["none", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) }));
  const h = mount({ thoughtLevels: six });
  const tray = openTray(h, "effort");
  pickRole(tray, "lead");
  rowAction(tray, "claude-opus-5-5").click();
  assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(checkedSeg(tray).dataset.effort, "max");
  assert.equal(h.errors().length, 0);
});

test("Fusion leads with different reported efforts reconcile before posting", () => {
  const h = mount();
  h.post(fixture.options({
    currentModel: "fusion-gpt-6-astra-high-sidekick-swe-2-medium",
    currentThoughtLevel: "xhigh",
    thoughtLevels: [{ value: "medium", name: "Medium" }, { value: "xhigh", name: "XHigh" }]
  }));
  const tray = openFusionPage(h);
  const last = () => fusionPosts(h).at(-1);
  rowMain(tray, "gpt-6-astra").click();
  assert.equal(last().thoughtLevel, "medium", "the astra reported default is its own, not Opus max");
  assert.ok(fixture.models[0].variants.some((v) => v.value === last().model), "the posted pair is a real variant");
  assert.equal(h.errors().length, 0);
});

test("a normal model never displays or posts an unsupported old effort", () => {
  const allModels = [
    { id: "claude", name: "Claude", default: "claude-high", variants: [
      { value: "claude-low", name: "Low" }, { value: "claude-high", name: "High" }
    ] },
    { id: "gpt", name: "GPT", default: "gpt-medium", variants: [
      { value: "gpt-low", name: "Low" }, { value: "gpt-medium", name: "Medium" }
    ] }
  ];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const options = (currentModel, currentThoughtLevel, thoughtLevels) => ({
    type: "options", currentMode: "accept-edits", currentModel, currentThoughtLevel,
    thoughtLevels, modelChoices: {}, models: allModels, modes: []
  });
  h.post(options("claude-high", "high", [{ value: "low", name: "Low" }, { value: "high", name: "High" }]));
  // The target family's reported effort list is already known before the pick.
  h.post(options("gpt-medium", "medium", [{ value: "medium", name: "Medium" }]));
  assert.equal(effortLabel(h), "High");

  openTray(h);
  rowMain(popup(h), "gpt").click();
  const setModel = h.posted.filter((m) => m.type === "setModel").at(-1);
  assert.equal(setModel.thoughtLevel, "medium", "the unsupported effort is reconciled before the post");
  assert.equal(effortLabel(h), "Medium", "the new label shows before any reply");
  h.post(options("gpt-medium", "medium", [{ value: "medium", name: "Medium" }]));
  assert.equal(effortLabel(h), "Medium", "the picker never shows the old effort");
  assert.equal(h.errors().length, 0);
});

test("switching models posts the reconciled effort and normalized speed", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high-fast", currentSpeed: "fast" });
  const tray = openTray(h, "effort");
  assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "true", "Fast starts active on the fast variant");
  openTray(h);
  rowMain(popup(h), "gpt-6-astra").click();
  const setModel = h.posted.filter((m) => m.type === "setModel").at(-1);
  assert.equal(setModel.model, "gpt-6-astra-high");
  assert.equal(setModel.speed, "standard", "the unsupported Fast state is normalized before the post");
  assert.equal(setModel.thoughtLevel, "high", "a supported effort is posted");
  assert.equal(effortLabel(h), "High", "the new label shows before any reply");
  assert.equal(h.errors().length, 0);
});

test("cached Fast choices enable the toggle before any fresh options report", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  const tray = openTray(h, "effort");
  assert.ok(tray.querySelector("#fast-thinking"), "the report taught Fast for a model with no fast catalogue UID");
  openTray(h);
  rowMain(popup(h), "gpt-6-astra").click();
  assert.ok(!openTray(h, "effort").querySelector("#fast-thinking"), "the new family has no learned or catalogue Fast support");
  openTray(h);
  rowMain(popup(h), "swe-2").click();
  const swe2Tray = openTray(h, "effort");
  const fast = swe2Tray.querySelector("#fast-thinking");
  assert.ok(fast, "cached choices enable Fast before any fresh options reply");
  assert.equal(fast.getAttribute("aria-pressed"), "false");
  fast.click();
  const last = h.posted.filter((m) => m.type === "setConfigOption" && m.configId === "speed").at(-1);
  assert.equal(last.value, "fast");
  assert.equal(h.errors().length, 0);
});

test("capability choices survive a reload while the selected speed does not", () => {
  const h = mount({ currentModel: "swe-2-medium", currentSpeed: "fast" });
  const tray = openTray(h, "effort");
  assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "true", "Fast starts active");
  h.post({ type: "sessionReady", sessionId: "session-one" });
  openTray(h);
  rowMain(popup(h), "gpt-6-luna").click();
  openTray(h, "effort");
  popup(h).querySelector("#pagePin").click();
  const saved = h.state();
  const persisted = saved.modelCapabilities?.speedsByModel?.["swe-2"];
  assert.ok(persisted?.choices?.some((c) => c.value === "fast"), "choices were persisted");
  assert.ok(!("value" in persisted), "only choices persist, never the selected speed");
  assert.equal(saved.sessionId, "session-one");
  assert.ok(saved.pinnedModels?.includes("gpt-6-luna"), "the pin survived the capability save");

  const h2 = createHarness({ state: saved });
  h2.post({ type: "ready" });
  h2.post({ type: "body", body: "thread" });
  h2.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "fast", speedOptions: [], thoughtLevels: [], sessionConfig: false }));
  const tray2 = openTray(h2, "effort");
  const restored = tray2.querySelector("#fast-thinking");
  assert.ok(restored, "restored choices enable Fast without fresh options");
  assert.equal(restored.getAttribute("aria-pressed"), "true", "the newly reported active speed is obeyed");
  h2.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", speedOptions: [], thoughtLevels: [], sessionConfig: false }));
  assert.equal(openTray(h2, "effort").querySelector("#fast-thinking").getAttribute("aria-pressed"), "false", "a newer report still governs the toggle");
  assert.equal(h2.state().sessionId, "session-one");
  assert.ok(h2.state().pinnedModels?.includes("gpt-6-luna"));
  assert.equal(h2.errors().length, 0);
});

test("bootstrap empty options keep cached support while live empty options persist the negative", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"));
  h.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", speedOptions: [], thoughtLevels: [], sessionConfig: false }));
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"), "a non live empty reply cannot erase learned support");
  h.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", speedOptions: [], thoughtLevels: [], sessionConfig: true }));
  assert.ok(!openTray(h, "effort").querySelector("#fast-thinking"), "an authoritative empty reply removes Fast");
  assert.deepEqual(h.state().modelCapabilities.speedsByModel["swe-2"].choices, [], "the negative result is persisted");
  assert.equal(h.errors().length, 0);
});

test("a genuinely different catalogue invalidates cached capability choices", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"));
  const grown = [...fixture.models, { id: "new-family", name: "New", default: "new-1", variants: [{ value: "new-1", name: "New" }] }];
  h.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", models: grown, speedOptions: [], thoughtLevels: [] }));
  assert.ok(!openTray(h, "effort").querySelector("#fast-thinking"), "stale cached support is dropped with the old catalogue");
  assert.ok(h.state().modelCapabilities.catalogKey.includes("new-family"));
  assert.equal(h.errors().length, 0);
});

test("a reordered catalogue keeps learned capability choices", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"), "SWE-2 Fast support was learned from the report");
  const keyBefore = h.state().modelCapabilities?.catalogKey;
  assert.ok(keyBefore, "the catalogue key was persisted");
  const reordered = [...fixture.models].reverse().map((fam) => ({
    ...fam, variants: [...(fam.variants || [])].reverse()
  }));
  h.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", models: reordered, speedOptions: [], thoughtLevels: [] }));
  assert.equal(h.state().modelCapabilities?.catalogKey, keyBefore, "reordering families and variants is not a new catalogue");
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"), "Fast stays enabled on the same catalogue");
  assert.equal(h.errors().length, 0);
});

test("an empty model bootstrap keeps the painted composer and learned Fast", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"));
  const modelLabel = h.document.querySelector("#modelBtn .dd-label").textContent;
  const effort = effortLabel(h);
  h.post(fixture.options({ currentModel: "swe-2-medium", currentSpeed: "standard", models: [], speedOptions: [], thoughtLevels: [] }));
  assert.equal(h.document.querySelector("#modelBtn .dd-label").textContent, modelLabel, "the model selection survives an empty bootstrap");
  assert.equal(effortLabel(h), effort, "the effort selection survives");
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"), "Fast does not fall back to Checking");
  assert.equal(h.errors().length, 0);
});

test("Fast support never leaks across models", () => {
  const h = mount({ currentModel: "swe-2-medium" });
  assert.ok(openTray(h, "effort").querySelector("#fast-thinking"));
  h.post(fixture.options({ currentModel: "swe-2-flash-max", currentSpeed: "standard", speedOptions: [], thoughtLevels: [] }));
  h.post({ type: "model", model: "swe-2-flash-max" });
  assert.ok(!openTray(h, "effort").querySelector("#fast-thinking"), "an unreported model is unknown, not supported");
  assert.equal(h.errors().length, 0);
});

test("the Lead effort rail shows Loading, then real options, then Not configurable", () => {
  const fusionOnly = [{
    id: "fusion", name: "Fusion", default: "fusion-plain-sidekick-sub",
    variants: [
      { value: "fusion-plain-sidekick-sub", name: "Fusion (Plain + Sub)" },
      { value: "fusion-plain-fast-sidekick-sub", name: "Fusion (Plain Fast + Sub)" }
    ]
  }];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  const options = (overrides = {}) => ({
    type: "options", currentMode: "accept-edits",
    currentModel: "fusion-plain-sidekick-sub", currentThoughtLevel: "",
    thoughtLevels: [], modelChoices: {}, models: fusionOnly, modes: [], ...overrides
  });
  h.post(options());
  const tray = openTray(h, "effort");
  pickRole(tray, "lead");
  rowAction(tray, "plain").click();
  assert.equal(tray.querySelector(".controls-empty").textContent, "Loading...", "no effort evidence yet");
  h.post(options({
    currentThoughtLevel: "high",
    thoughtLevels: [{ value: "low", name: "Low" }, { value: "high", name: "High" }]
  }));
  assert.deepEqual(segs(tray).map((s) => s.dataset.effort), ["low", "high"]);
  assert.equal(checkedSeg(tray).dataset.effort, "high");
  h.post(options({ sessionConfig: true }));
  assert.equal(tray.querySelector(".controls-empty").textContent, "Not configurable", "an authoritative empty report is known empty");
  assert.equal(h.errors().length, 0);
});

test("each model keeps its own effort and Fast when switching between them", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h, "effort");
  seg(tray, "low").click();
  tray.querySelector("#fast-thinking").click();
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].effort, "low");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "fast");
  const labels = () => Object.fromEntries([...popup(h).querySelectorAll(".dd-item-effort .dd-effort-label")]
    .map((el) => [el.closest(".dd-item").dataset.id, el.textContent.trim()]));
  openTray(h);
  assert.equal(labels()["claude-opus-5-5"], "Low", "the row previews the saved effort");
  assert.ok(rowAction(popup(h), "claude-opus-5-5").querySelector(".zap-fill"), "the row previews saved Fast");
  const before = { ...labels() };
  rowMain(popup(h), "gpt-6-astra").click();
  assert.equal(effortLabel(h), "High", "GPT-6 Astra uses its own default, not Opus Low");
  seg(openTray(h, "effort"), "max").click();
  openTray(h);
  assert.deepEqual(labels()["claude-opus-5-5"], before["claude-opus-5-5"], "a pick on one model does not move another row");
  assert.equal(labels()["gpt-6-astra"], "Max");
  rowMain(popup(h), "claude-opus-5-5").click();
  const setModel = h.posted.filter((m) => m.type === "setModel").at(-1);
  assert.equal(setModel.model, "claude-opus-5-5-low-fast", "the saved effort and speed restore on reselect");
  assert.equal(effortLabel(h), "Low");
  assert.equal(h.errors().length, 0);
});

test("Single, Lead and Sub preferences stay independent for the same model", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  seg(openTray(h, "effort"), "low").click();
  openTray(h);
  rowMain(popup(h), "fusion").click();
  const tray = popup(h);
  assert.ok(tray.querySelector("#roleRadio-lead"), "the Fusion card opens the role page");
  rowAction(tray, "claude-opus-5-5").click();
  seg(tray, "max").click();
  const prefs = h.state().modelPreferences;
  assert.equal(prefs.single["claude-opus-5-5"].effort, "low", "the single preference is untouched by the Lead pick");
  assert.equal(prefs.lead["claude-opus-5-5"].effort, "max");
  tray.querySelector("#pageBack").click();
  pickRole(tray, "sub");
  rowAction(tray, "gpt-6-luna").click();
  tray.querySelector("#fast-thinking").click();
  assert.equal(h.state().modelPreferences.sub["gpt-6-luna"].speed, "fast");
  assert.equal(h.state().modelPreferences.single["gpt-6-luna"] || "", "", "a Sub pick does not write the Single scope");
  assert.equal(h.errors().length, 0);
});

test("saved preferences restore on a fresh webview mount", () => {
  const state = {
    modelPreferences: {
      version: 1,
      single: { "claude-opus-5-5": { effort: "low", speed: "fast" } },
      lead: { "claude-opus-5-5": { effort: "max", speed: "fast" } },
      sub: { "swe-2": { effort: "high", speed: "standard" } },
      fusion: { lead: "claude-opus-5-5", subModel: "swe-2" }
    }
  };
  const h = createHarness({ state });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ currentModel: "swe-2-medium" }));
  const tray = openTray(h);
  const action = rowAction(tray, "claude-opus-5-5");
  assert.equal(action.querySelector(".dd-effort-label").textContent.trim(), "Low");
  assert.ok(action.querySelector(".zap-fill"), "the saved Fast survives the reload");
  assert.match(tray.querySelector(".dd-item-card .dd-card-sub").textContent, /Opus 5\.5 Max/, "the saved Fusion pairing previews on the card");
  assert.equal(h.errors().length, 0);
});

test("a session model notification overrides saved preferences without posting", () => {
  const state = {
    modelPreferences: {
      version: 1,
      single: { "claude-opus-5-5": { effort: "low", speed: "standard" } },
      lead: {}, sub: {}, fusion: null
    }
  };
  const h = createHarness({ state });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ currentModel: "claude-opus-5-5-high", currentThoughtLevel: "max", sessionConfig: true }));
  const sentBefore = h.posted.length;
  h.post({ type: "model", model: "claude-opus-5-5-high" });
  assert.equal(effortLabel(h), "Max", "the session report wins over the saved preference");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].effort, "max", "the reported value becomes the saved one");
  assert.equal(h.posted.length, sentBefore, "no automatic model change was posted");
  assert.equal(h.errors().length, 0);
});

test("a stale reply cannot corrupt another model's saved preference", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  seg(openTray(h, "effort"), "low").click();
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].effort, "low");
  const request = h.posted.filter((m) => m.type === "setConfigOption").at(-1);
  // A reply about a different model while the pick is pending must not move the
  // shown effort or the saved preference of the model being configured.
  h.post(fixture.options({ currentModel: "gpt-6-astra-high", currentThoughtLevel: "max", sessionConfig: true }));
  assert.equal(effortLabel(h), "Low", "the optimistic pick survives an unrelated reply");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].effort, "low");
  h.post({ type: "modelConfigApplied", requestId: request.requestId, model: "claude-opus-5-5-high", thoughtLevel: "low" });
  assert.equal(effortLabel(h), "Low");
  assert.equal(h.errors().length, 0);
});

test("a rejected Fast change restores the confirmed preference", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h, "effort");
  tray.querySelector("#fast-thinking").click();
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "fast");
  const request = h.posted.filter((m) => m.configId === "speed").at(-1);
  h.post({ type: "modelConfigApplied", requestId: request.requestId, model: "claude-opus-5-5-high", speed: "standard" });
  assert.equal(tray.querySelector("#fast-thinking").getAttribute("aria-pressed"), "false");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "standard", "the saved preference reverts with the confirmed speed");
  assert.equal(h.errors().length, 0);
});

test("Adaptive renders its own card and has no effort route", () => {
  const models = [
    { id: "adaptive", name: "Adaptive", default: "adaptive", variants: [{ value: "adaptive", name: "Adaptive", description: "Automatically balances quality and cost" }] },
    ...fixture.models
  ];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ currentModel: "adaptive", models, modelChoices: {}, thoughtLevels: [], sessionConfig: true }));
  const group = h.document.querySelector("#model-picker-group");
  assert.ok(group.classList.contains("no-effort"), "Adaptive hides the effort half");
  const tray = openTray(h);
  const card = rowMain(tray, "adaptive").closest(".dd-item");
  assert.ok(card.classList.contains("dd-item-card"), "Adaptive is a featured card");
  assert.match(card.textContent, /Automatically balances quality and cost/);
  assert.ok(!rowAction(tray, "adaptive"), "the Adaptive card has no effort action");
  rowMain(tray, "adaptive").click();
  assert.ok(popup(h).classList.contains("hidden"), "selecting Adaptive closes the tray");
  assert.equal(h.posted.filter((m) => m.type === "setModel").at(-1).model, "adaptive");
  assert.equal(h.errors().length, 0);
});

test("rows without effort or Fast drop the trailing action like Adaptive", () => {
  const models = [
    { id: "gpt-6-mini", name: "GPT-6 Mini", default: "gpt-6-mini", variants: [{ value: "gpt-6-mini", name: "Mini" }] },
    { id: "gpt-6-bolt", name: "GPT-6 Bolt", default: "gpt-6-bolt", variants: [{ value: "gpt-6-bolt", name: "Bolt" }, { value: "gpt-6-bolt-fast", name: "Bolt Fast" }] },
    { id: "swe-2-flash", name: "SWE-2 Flash", default: "swe-2-flash-max", variants: [{ value: "swe-2-flash-max", name: "Max" }] }
  ];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ currentModel: "swe-2-flash-max", models, thoughtLevels: [], modelChoices: {} }));
  const tray = openTray(h);
  assert.ok(!rowAction(tray, "gpt-6-mini"), "no effort and no Fast drops the action entirely");
  const bolt = rowAction(tray, "gpt-6-bolt");
  assert.ok(bolt, "Fast alone keeps the action so its toggle stays reachable");
  assert.equal(bolt.querySelector(".dd-effort-label").textContent.trim(), "", "a Fast only row shows no Auto label");
  assert.equal(rowAction(tray, "swe-2-flash").querySelector(".dd-effort-label").textContent.trim(), "Max", "a single effort stays selected");
  assert.equal(h.errors().length, 0);
});

test("a Fusion role row without effort or Fast drops the trailing action", () => {
  const models = [
    {
      id: "fusion", name: "Fusion",
      default: "fusion-gpt-6-astra-high-sidekick-plain-sub",
      variants: [
        { value: "fusion-gpt-6-astra-high-sidekick-plain-sub", name: "Fusion (Astra High + Plain Sub)" },
        { value: "fusion-gpt-6-astra-high-sidekick-swe-2-medium", name: "Fusion (Astra High + SWE-2 Medium)" }
      ]
    },
    { id: "gpt-6-astra", name: "GPT-6 Astra", default: "gpt-6-astra-high", variants: [{ value: "gpt-6-astra-high", name: "High" }] },
    { id: "plain-sub", name: "Plain Sub", default: "plain-sub", variants: [{ value: "plain-sub", name: "Plain Sub" }] },
    { id: "swe-2", name: "SWE-2", default: "swe-2-medium", variants: [{ value: "swe-2-medium", name: "Medium" }] }
  ];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ currentModel: "fusion-gpt-6-astra-high-sidekick-plain-sub", models, thoughtLevels: [], modelChoices: {} }));
  const tray = openTray(h, "effort");
  pickRole(tray, "sub");
  assert.ok(!rowAction(tray, "plain-sub"), "a sub with no effort and no Fast drops the action");
  assert.equal(rowAction(tray, "swe-2").querySelector(".dd-effort-label").textContent.trim(), "Medium");
  assert.equal(h.errors().length, 0);
});

test("the model list has an always visible search with a decorative icon", () => {
  const h = mount();
  const tray = openTray(h);
  const wrap = tray.querySelector(".dd-filter-wrap");
  assert.ok(wrap, "the search field sits in its icon wrapper");
  assert.ok(wrap.querySelector(".codicon-search"), "a decorative magnifier is rendered");
  const search = wrap.querySelector("#pageSearch");
  assert.equal(search.getAttribute("aria-label"), "Search models");
  search.value = "luna";
  search.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  assert.deepEqual(rowNames(tray, ".dd-rows .dd-item"), ["GPT-6 Luna"], "the list filters to the query");
  tray.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.deepEqual(rowNames(tray, ".dd-rows .dd-item").length, 6, "Escape clears the query instead of closing");
  assert.equal(h.errors().length, 0);
});

test("row actions navigate to the effort page and Back restores the row", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h);
  rowAction(tray, "gpt-6-luna").click();
  assert.equal(tray.querySelector(".tray-title-text").textContent, "GPT-6 Luna");
  assert.equal(h.document.querySelector("#modelBtn .dd-label").textContent, "GPT-6 Luna", "the action selects its model");
  const back = tray.querySelector("#pageBack");
  assert.ok(back, "the details page has a Back button");
  back.click();
  assert.ok(rowMain(tray, "gpt-6-luna"), "Back returns to the model list");
  assert.equal(h.document.activeElement, rowAction(tray, "gpt-6-luna"), "focus returns to the row action");
  assert.equal(h.errors().length, 0);
});

test("the header pin moves a model into the Pinned group", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h, "effort");
  tray.querySelector("#pagePin").click();
  assert.ok(h.state().pinnedModels.includes("claude-opus-5-5"));
  openTray(h);
  assert.deepEqual([...popup(h).querySelectorAll(".dd-group")].map((g) => g.textContent.trim()), ["Pinned", "Models"]);
  tray.querySelector("#pagePin") || openTray(h, "effort").querySelector("#pagePin").click();
  assert.ok(!h.state().pinnedModels.includes("claude-opus-5-5"), "the header pin unpins");
  assert.equal(h.errors().length, 0);
});

test("the Fast badge is an outline bolt while enabled Fast is a filled bolt", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h);
  const opusBadge = rowMain(tray, "claude-opus-5-5").querySelector(".dd-item-badge");
  assert.ok(opusBadge && opusBadge.querySelector(".codicon-zap"), "availability uses the outline codicon bolt");
  assert.ok(!opusBadge.querySelector(".zap-fill"), "the outline badge is not filled");
  assert.ok(!rowMain(tray, "gpt-6-astra").querySelector(".dd-item-badge .codicon-zap"), "GPT-6 Astra has no Fast badge");
  rowMain(tray, "claude-opus-5-5").click();
  const detailTray = openTray(h, "effort");
  const offToggle = detailTray.querySelector("#fast-thinking");
  assert.ok(offToggle.querySelector(".codicon-zap"), "an off Fast toggle uses the outline bolt");
  assert.ok(!offToggle.querySelector(".zap-fill"));
  offToggle.click();
  assert.ok(detailTray.querySelector("#fast-thinking .zap-fill"), "an enabled Fast toggle uses the filled bolt");
  assert.equal(h.errors().length, 0);
});

test("the Fast availability badge appears only where a Fast path exists", () => {
  const h = mount();
  const tray = openFusionPage(h);
  assert.ok(rowMain(tray, "claude-opus-5-5").querySelector(".dd-item-badge"), "the Fast lead advertises Fast");
  assert.ok(!rowMain(tray, "gpt-6-astra").querySelector(".dd-item-badge"), "GPT-6 Astra lead has no Fast");
  pickRole(tray, "sub");
  assert.ok(rowMain(tray, "gpt-6-luna").querySelector(".dd-item-badge"), "GPT-6 Luna has a fast sub pair");
  assert.ok(!rowMain(tray, "swe-2").querySelector(".dd-item-badge"), "SWE-2 has no fast sub pair");
  assert.equal(h.errors().length, 0);
});

test("pricing details keep the unit caption inside the expanded body and remember their open state", () => {
  const priced = [{
    id: "opus-priced", name: "Opus Priced", default: "opus-priced-high",
    variants: [
      { value: "opus-priced-high", name: "High", costTier: "High cost", maxContextTokens: 1000000, maxOutputTokens: 128000, costSummary: "$4/MTok In \u00b7 $20/MTok Out" },
      { value: "opus-priced-low", name: "Low", costTier: "High cost", maxContextTokens: 1000000, maxOutputTokens: 128000 }
    ]
  }, ...fixture.models];
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ models: priced, currentModel: "opus-priced-high", thoughtLevels: [] }));
  const tray = openTray(h, "effort");
  const pricing = tray.querySelector("details.catalog-pricing");
  assert.ok(pricing, "the details page has a pricing box");
  assert.equal(pricing.open, false, "pricing starts collapsed");
  const summary = pricing.querySelector("summary");
  assert.ok(!summary.querySelector(".catalog-unit"), "the summary has no unit caption");
  assert.equal(pricing.querySelector(".catalog-pricing-body .catalog-unit").textContent, "USD per 1M tokens");
  assert.ok(summary.lastElementChild.classList.contains("catalog-chevron"), "the chevron is the last summary element");
  pricing.open = true;
  pricing.dispatchEvent(new h.window.Event("toggle"));
  seg(tray, "low").click();
  assert.equal(tray.querySelector("details.catalog-pricing").open, true, "an edit re-render keeps the expanded pricing");
  assert.equal(h.errors().length, 0);
});

test("the pricing header shows one Promotion tag beside the cost badge, collapsed or expanded", () => {
  const promoModel = {
    id: "opus-promo", name: "Opus Promo", default: "opus-promo-high",
    variants: [{
      value: "opus-promo-high", name: "High", costTier: "High cost",
      promotion: "20% off", isNew: true, isBeta: true,
      maxContextTokens: 1000000, maxOutputTokens: 128000,
      costSummary: "$4/MTok In · $20/MTok Out"
    }]
  };
  const h = mount({ ...pricingFixture, models: [...pricingFixture.models, promoModel], currentModel: "opus-promo-high" });
  const tray = openTray(h, "effort");
  const pricing = tray.querySelector("details.catalog-pricing");
  const head = pricing.querySelector(".catalog-pricing-head");
  const cluster = head.querySelector(".catalog-pricing-badges");
  assert.ok(cluster, "the pricing head has a badge cluster before the chevron");
  const tags = cluster.querySelectorAll(".dd-model-tag");
  assert.equal(tags.length, 1, "only the Promotion tag renders");
  const tag = tags[0];
  assert.ok(tag.classList.contains("dd-item-badge") && tag.classList.contains("dd-model-tag-promotion"));
  assert.equal(tag.textContent, "Promotion");
  assert.equal(tag.title, "Promotion: 20% off");
  const tier = cluster.querySelector(".catalog-tier");
  assert.equal(tag.nextElementSibling, tier, "Promotion sits beside the cost badge in the cluster");
  assert.equal(head.querySelectorAll(".dd-model-tag-new, .dd-model-tag-beta").length, 0, "New and Beta stay out of the pricing header");
  assert.ok(head.lastElementChild.classList.contains("catalog-chevron"), "the chevron is still last");
  assert.equal(pricing.open, false, "the tag is present while collapsed");
  pricing.open = true;
  pricing.dispatchEvent(new h.window.Event("toggle"));
  assert.equal(pricing.querySelector(".catalog-pricing-head .dd-model-tag-promotion").title, "Promotion: 20% off", "the tag stays when expanded");
  assert.equal(h.errors().length, 0);
});

test("standalone pricing shows estimated originals and the promotion expiry", () => {
  const swePromo = fixture.models.map((fam) => fam.id === "swe-2"
    ? {
      ...fam,
      variants: [
        { value: "swe-2-medium", name: "Medium" },
        {
          value: "swe-2-high", name: "High",
          promotion: "83% off",
          promotionEndDate: "2027-01-01T07:59:59.999999999Z",
          costTier: "High cost",
          costSummary: "$0.5/MTok In · $3/MTok Out · $0.05/MTok Cache Read",
          longContextCostSummary: "$1/MTok In · $6/MTok Out"
        }
      ]
    }
    : fam);
  const h = mount({ models: swePromo, currentModel: "swe-2-high", currentThoughtLevel: "high", thoughtLevels: [] });
  openTray(h, "effort");
  const openPricing = () => {
    const d = popup(h).querySelector("details.catalog-pricing");
    d.open = true;
    d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));
  };
  openPricing();
  const body = popup(h).querySelector(".catalog-pricing-body");
  const cells = [...body.querySelectorAll(".catalog-prices tbody td")].map((td) => ({
    original: td.querySelector(".catalog-price-original")?.textContent ?? null,
    current: td.querySelector(".catalog-price-value")?.textContent ?? td.textContent
  }));
  assert.deepEqual(cells, [
    { original: "$3", current: "$0.5" },
    { original: "$5.9", current: "$1" },
    { original: "$17.7", current: "$3" },
    { original: "$35.3", current: "$6" },
    { original: "$0.3", current: "$0.05" },
    { original: null, current: "Not provided" }
  ], "each USD cell pairs its estimate with the reported rate");
  const pair = body.querySelector(".catalog-price-pair");
  assert.deepEqual([...pair.querySelectorAll(".sr-only")].map((s) => s.textContent), ["Estimated original price ", " Current price "], "screen readers hear both labels before the values");
  const notes = [...body.querySelectorAll(".catalog-promo-note")];
  assert.equal(notes.length, 1, "only the expiry note renders");
  assert.equal(notes[0].textContent, "Promotion ends on 1 Jan 2027 (UTC).");
  const time = notes[0].querySelector("time");
  assert.equal(time.getAttribute("datetime"), "2027-01-01T07:59:59.999999999Z", "the reported timestamp survives verbatim");
  assert.equal(time.textContent, "1 Jan 2027", "the display stays date only in UTC");
  assert.ok(!body.textContent.includes("estimates based on"), "the estimate disclaimer is gone");
  const head = popup(h).querySelector(".catalog-pricing-head");
  assert.equal(head.querySelectorAll(".dd-model-tag-promotion").length, 1, "the header keeps its single Promotion badge");
  assert.equal(head.querySelector(".dd-model-tag-promotion").title, "Promotion: 83% off");
  seg(popup(h), "medium").click();
  const clean = popup(h).querySelector(".catalog-pricing-body");
  assert.equal(clean.querySelectorAll(".catalog-price-original").length, 0, "a non promotional effort drops the estimates");
  assert.equal(clean.querySelectorAll(".catalog-promo-note").length, 0, "both notes disappear with the offer");
  assert.equal(popup(h).querySelector(".catalog-pricing-head .dd-model-tag-promotion"), null, "the badge clears too");
  assert.equal(h.errors().length, 0);
});

test("Fusion role pricing shows the component's own estimated originals and expiry", () => {
  const options = JSON.parse(JSON.stringify(pricingFixture));
  options.models.find((m) => m.id === "gpt-5-6-sol").variants.forEach((v) => {
    v.promotion = "20% off";
    v.promotionEndDate = "2026-11-18T18:00:00Z";
  });
  // A promotional pair must never leak its offer or expiry into a role.
  options.models.find((m) => m.id === "fusion").variants.forEach((v) => {
    v.promotion = "PROMO";
    v.promotionEndDate = "2030-01-01T00:00:00Z";
  });
  const h = mount(options);
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(popup(h), "gpt-5-6-sol").click();
  const openPricing = () => {
    const d = popup(h).querySelector("details.catalog-pricing");
    d.open = true;
    d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));
  };
  const cells = () => [...popup(h).querySelectorAll(".catalog-pricing-body .catalog-prices tbody td")].map((td) => ({
    original: td.querySelector(".catalog-price-original")?.textContent ?? null,
    current: td.querySelector(".catalog-price-value")?.textContent ?? td.textContent
  }));
  openPricing();
  assert.deepEqual(cells(), [
    { original: "$5", current: "$4" },
    { original: "$25", current: "$20" },
    { original: "$0.5", current: "$0.4" }
  ], "the Sub's own offer estimates beside its reported rates");
  const body = popup(h).querySelector(".catalog-pricing-body");
  const notes = [...body.querySelectorAll(".catalog-promo-note")];
  assert.equal(notes.length, 1);
  assert.equal(notes[0].textContent, "Promotion ends on 18 Nov 2026 (UTC).");
  assert.equal(notes[0].querySelector("time").getAttribute("datetime"), "2026-11-18T18:00:00Z");
  assert.ok(!body.textContent.includes("2030"), "the pair's expiry never reaches the role");
  assert.ok(!body.textContent.includes("estimates based on"), "the estimate disclaimer is gone");
  popup(h).querySelector("#fast-thinking").click();
  openPricing();
  assert.deepEqual(cells().map((c) => c.original), ["$10", "$50", "$1"], "Fast rates get their own estimates");
  assert.deepEqual(cells().map((c) => c.current), ["$8", "$40", "$0.8"], "reported Fast rates stay unchanged");
  popup(h).querySelector("#pageBack").click();
  pickRole(popup(h), "lead");
  rowAction(popup(h), "claude-opus-5-5").click();
  openPricing();
  const leadBody = popup(h).querySelector(".catalog-pricing-body");
  assert.equal(leadBody.querySelectorAll(".catalog-price-original").length, 0, "the non promotional Lead shows no estimates");
  assert.equal(leadBody.querySelectorAll(".catalog-promo-note").length, 0, "no notes leak from the pair or the Sub");
  assert.equal(h.errors().length, 0);
});

test("promotion pricing notes handle non numeric offers, bad dates and missing rates", () => {
  const edge = (id, variant) => [{ id, name: id, default: `${id}-high`, variants: [variant] }];
  const openDetails = (h) => {
    openTray(h, "effort");
    const d = popup(h).querySelector("details.catalog-pricing");
    d.open = true;
    d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle"));
    return popup(h).querySelector(".catalog-pricing-body");
  };
  const mountEdge = (id, variant) => mount({
    models: edge(id, variant), currentModel: `${id}-high`, currentThoughtLevel: "high", thoughtLevels: []
  });

  let h = mountEdge("edge-offer", {
    value: "edge-offer-high", name: "High", promotion: "Launch offer",
    promotionEndDate: "2026-12-01T00:00:00Z", costSummary: "$4/MTok In · $20/MTok Out"
  });
  let body = openDetails(h);
  assert.equal(body.querySelectorAll(".catalog-price-original").length, 0, "a non numeric offer has no estimate");
  assert.equal(body.querySelectorAll(".catalog-promo-note").length, 1, "only the expiry note renders");
  assert.equal(body.querySelector(".catalog-promo-note").textContent, "Promotion ends on 1 Dec 2026 (UTC).");
  assert.equal(body.querySelector("time").getAttribute("datetime"), "2026-12-01T00:00:00Z");

  h = mountEdge("edge-baddate", {
    value: "edge-baddate-high", name: "High", promotion: "20% off",
    promotionEndDate: "soon", costSummary: "$4/MTok In · $20/MTok Out"
  });
  body = openDetails(h);
  const baddateOriginals = [...body.querySelectorAll(".catalog-price-original")].map((d) => d.textContent);
  assert.deepEqual(baddateOriginals, ["$5", "$25"], "the numeric offer still estimates");
  assert.equal(body.querySelectorAll(".catalog-promo-note").length, 0, "a malformed date leaves no notes");
  assert.equal(body.querySelector("time"), null, "a malformed date never renders");

  h = mountEdge("edge-norates", {
    value: "edge-norates-high", name: "High", promotion: "20% off",
    promotionEndDate: "2027-01-01T07:59:59.999999999Z"
  });
  body = openDetails(h);
  assert.ok(body.querySelector(".catalog-empty"), "missing rates keep the empty message");
  assert.equal(body.querySelectorAll(".catalog-price-original").length, 0);
  assert.equal(body.querySelectorAll(".catalog-promo-note").length, 1, "the expiry still shows without rates");
  assert.equal(body.querySelector("time").getAttribute("datetime"), "2027-01-01T07:59:59.999999999Z");

  h = mountEdge("edge-low", {
    value: "edge-low-high", name: "High", promotion: "25% off",
    promotionEndDate: "2026-11-18T18:00:00Z", costSummary: "$0.03/MTok In · $0.1/MTok Out"
  });
  body = openDetails(h);
  const lowOriginals = [...body.querySelectorAll(".catalog-price-original")].map((d) => d.textContent);
  assert.deepEqual(lowOriginals, ["$0.1", "$0.2"], "upward rounding never lands at or below the current rate");
  const lowCurrents = [...body.querySelectorAll(".catalog-price-value")].map((s) => s.textContent);
  assert.deepEqual(lowCurrents, ["$0.03", "$0.1"], "reported rates stay unchanged");
  const lowNotes = [...body.querySelectorAll(".catalog-promo-note")];
  assert.equal(lowNotes.length, 1, "only the expiry note renders");
  assert.equal(lowNotes[0].textContent, "Promotion ends on 18 Nov 2026 (UTC).");
  assert.equal(h.errors().length, 0);
});

test("host exposes speed and serializes it with Fusion effort", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "", defaultSpeed: "" } });
  const config = recordConfigWrites();
  try {
    await h.ready();
    await h.startChat("configure model speed");
    assert.deepEqual(h.last("options").speedOptions.map((o) => o.value), ["standard", "fast"]);
    h.send({
      type: "setConfigOption", configId: "speed", value: "fast", speed: "fast",
      model: "fusion-claude-opus-5-high-sidekick-swe-2-medium", thoughtLevel: "low", requestId: 1
    });
    await h.until(() => h.last("modelConfigApplied")?.requestId === 1);
    assert.equal(h.last("options").currentThoughtLevel, "low");
    assert.equal(h.last("options").currentSpeed, "fast");
    assert.equal(h.last("modelConfigApplied").speed, "fast");
    assert.ok(config.writes.some(([key, value]) => key === "defaultSpeed" && value === "fast"));
  } finally {
    config.restore();
    await h.dispose();
  }
});

test("host forwards per model context metadata for Fusion", { skip: process.platform === "win32" }, async () => {
  const h = createChat();
  try {
    const id = await h.startChat("report context");
    const contexts = [{ modelId: "claude-opus-5-max", totalTokens: 1000, maxTokens: 1000000, sections: [] }];
    h.controller.runtimes.get(id).client.emit("update", {
      sessionId: id,
      update: { sessionUpdate: "usage_update", used: 0, size: 0, _meta: { "cognition.ai/contextUsage": contexts } }
    });
    assert.deepEqual(h.last("usage").contexts, contexts);
    h.controller.runtimes.get(id).client.emit("update", {
      sessionId: id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: { "cognition.ai/contextUsage": contexts } }
    });
    assert.deepEqual(h.last("usage").contexts, contexts, "context metadata can arrive on a message update");
  } finally {
    await h.dispose();
  }
});

test("catalogue Max Fast and priority models map to ACP effort and speed", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "", defaultSpeed: "" } });
  try {
    const id = await h.startChat("translate speed variants");
    const rt = h.controller.runtimes.get(id);
    const widen = (options) => {
      options.find((o) => o.id === "model").options.push({ group: "gpt-6-luna", options: [{ value: "gpt-6-luna-medium", name: "GPT-6 Luna" }] });
      options.find((o) => o.id === "thought_level").options.push({ value: "max", name: "Max" });
      return options;
    };
    widen(rt.configOptions);
    const original = rt.client.setConfigOption.bind(rt.client);
    rt.client.setConfigOption = async (...args) => {
      const result = await original(...args);
      widen(result.configOptions);
      return result;
    };
    h.send({ type: "setModel", model: "fusion-claude-opus-5-max-fast-sidekick-swe-2-medium", requestId: 1 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 1));
    assert.deepEqual(h.agentSaw("session/set_config_option").map((r) => [r.params.configId, r.params.value]), [
      ["thought_level", "max"], ["speed", "fast"]
    ]);
    const before = h.agentSaw("session/set_config_option").length;
    h.send({ type: "setModel", model: "gpt-6-luna-max-priority", requestId: 2 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 2));
    assert.deepEqual(h.agentSaw("session/set_config_option").slice(before).map((r) => [r.params.configId, r.params.value]), [
      ["model", "gpt-6-luna-medium"], ["thought_level", "max"], ["speed", "fast"]
    ]);
  } finally {
    await h.dispose();
  }
});

test("a rejected speed restores confirmed state without persisting Fast", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "", defaultThoughtLevel: "", defaultSpeed: "" } });
  const config = recordConfigWrites();
  try {
    const id = await h.startChat("reject speed");
    const rt = h.controller.runtimes.get(id);
    const original = rt.client.setConfigOption.bind(rt.client);
    rt.client.setConfigOption = async (sessionId, configId, value) => {
      if (configId === "speed") throw new Error("Fast is unavailable");
      return original(sessionId, configId, value);
    };
    h.send({ type: "setConfigOption", configId: "speed", value: "fast", thoughtLevel: "low", requestId: 3 });
    assert.ok(await h.until(() => h.last("modelConfigApplied")?.requestId === 3));
    assert.equal(h.last("modelConfigApplied").speed, "standard");
    assert.equal(h.last("modelConfigApplied").thoughtLevel, "low");
    assert.ok(!config.writes.some(([key, value]) => key === "defaultSpeed" && value === "fast"));
  } finally {
    config.restore();
    await h.dispose();
  }
});

test("new sessions restore the remembered effort and fast thinking", { skip: process.platform === "win32" }, async () => {
  const h = createChat({ config: { defaultMode: "", defaultModel: "fusion-claude-opus-5-high-sidekick-swe-2-medium", defaultThoughtLevel: "low", defaultSpeed: "fast" } });
  try {
    await h.startChat("restore fast thinking");
    assert.equal(h.last("options").currentThoughtLevel, "low");
    assert.equal(h.last("options").currentSpeed, "fast");
  } finally {
    await h.dispose();
  }
});


// --- Consolidated rework regressions ----------------------------------------

const MAX_LEVELS = ["low", "medium", "high", "max"].map((v) => ({ value: v, name: v[0].toUpperCase() + v.slice(1) }));
const BOTH_SPEEDS = [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }];

test("a reported Max Fast choice survives leaving the model before any edit (A)", () => {
  const h = mount({ currentModel: "claude-opus-5-5-max-fast", currentThoughtLevel: "max", currentSpeed: "fast", thoughtLevels: MAX_LEVELS, speedOptions: BOTH_SPEEDS, sessionConfig: true });
  rowMain(openTray(h), "gpt-6-astra").click();
  rowMain(openTray(h), "claude-opus-5-5").click();
  const sent = h.posted.filter((m) => m.type === "setModel").at(-1);
  assert.equal(sent.thoughtLevel, "max");
  assert.equal(sent.speed, "fast");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].effort, "max");
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "fast");
  assert.equal(h.errors().length, 0);
});

test("a reported Fusion Max Fast pairing survives leaving before any edit (A)", () => {
  const pair = "fusion-claude-opus-5-5-max-fast-sidekick-gpt-6-luna-high-priority";
  const h = mount({ currentModel: pair, currentThoughtLevel: "max", currentSpeed: "fast", thoughtLevels: MAX_LEVELS, speedOptions: BOTH_SPEEDS, sessionConfig: true });
  rowMain(openTray(h), "gpt-6-astra").click();
  rowMain(openTray(h), "fusion").click();
  const sent = fusionPosts(h).at(-1);
  // The lead speed posts separately from the pair uid, so the representative
  // standard pair carries the restored Max and Fast choices.
  assert.equal(sent.model, "fusion-claude-opus-5-5-max-sidekick-gpt-6-luna-high-priority");
  assert.equal(sent.speed, "fast");
  const prefs = h.state().modelPreferences;
  assert.equal(prefs.lead["claude-opus-5-5"].effort, "max");
  assert.equal(prefs.lead["claude-opus-5-5"].speed, "fast");
  assert.equal(prefs.sub["gpt-6-luna"].speed, "fast");
  assert.equal(h.errors().length, 0);
});

test("a passive Sub Fast fallback restores on returning to a compatible Lead (B)", () => {
  const pairs = [
    "fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-high",
    "fusion-claude-opus-5-5-high-sidekick-gpt-6-luna-high-priority",
    "fusion-gpt-6-astra-high-sidekick-gpt-6-luna-high"
  ].map((value) => ({ value, name: value }));
  const models = fixture.models.map((fam) => fam.id === "fusion" ? { ...fam, variants: pairs } : fam);
  const h = mount({ currentModel: pairs[1].value, currentThoughtLevel: "high", currentSpeed: "fast", models, thoughtLevels: [{ value: "high", name: "High" }], speedOptions: BOTH_SPEEDS, sessionConfig: true });
  h.post({ type: "model", model: pairs[1].value });
  assert.equal(h.state().modelPreferences.sub["gpt-6-luna"].speed, "fast", "the session report saves the active Sub Fast");
  const tray = openFusionPage(h);
  rowMain(tray, "gpt-6-astra").click();
  h.post({ type: "modelConfigApplied", requestId: h.posted.at(-1).requestId, model: pairs[2].value, thoughtLevel: "high", speed: "standard" });
  assert.equal(h.state().modelPreferences.sub["gpt-6-luna"].speed, "fast", "the passive standard fallback is never saved");
  rowMain(popup(h), "claude-opus-5-5").click();
  const sent = fusionPosts(h).at(-1);
  assert.equal(sent.model, pairs[1].value, "the saved Sub Fast pair is posted again");
  assert.equal(sent.speed, "fast", "the saved Lead Fast is posted again");
  assert.equal(h.errors().length, 0);
});

test("a base uid report applies its cached values to the family (C)", () => {
  const h = mount({ currentModel: "swe-2", currentThoughtLevel: "high", currentSpeed: "fast", thoughtLevels: [{ value: "high", name: "High" }], speedOptions: BOTH_SPEEDS, sessionConfig: true });
  assert.equal(effortLabel(h), "High");
  rowMain(openTray(h), "gpt-6-astra").click();
  rowMain(openTray(h), "swe-2").click();
  const sent = h.posted.filter((m) => m.type === "setModel").at(-1);
  assert.ok(fixture.models.find((f) => f.id === "swe-2").variants.some((v) => v.value === sent.model), "a real swe-2 variant is posted");
  assert.equal(sent.speed, "fast");
});

test("a cross family report reconciles to the target's own effort (C)", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high", currentThoughtLevel: "high", currentSpeed: "standard", thoughtLevels: MAX_LEVELS, speedOptions: BOTH_SPEEDS, sessionConfig: true });
  h.post(fixture.options({ currentModel: "gpt-6-astra-high", currentThoughtLevel: "medium", thoughtLevels: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }], speedOptions: [], sessionConfig: true }));
  assert.equal(effortLabel(h), "High", "the old composer still shows its own effort");
  h.post({ type: "model", model: "gpt-6-astra-high" });
  assert.equal(effortLabel(h), "Medium");
  assert.equal(h.state().modelPreferences.single["gpt-6-astra"].effort, "medium");
  assert.ok(!h.posted.some((m) => m.type === "setModel"), "a session report never posts");
  assert.equal(h.errors().length, 0);
});

test("authoritative empty efforts keep a learned Fast and a real uid (D)", () => {
  const h = mount({ currentModel: "gpt-6-astra-high", currentThoughtLevel: "", currentSpeed: "fast", thoughtLevels: [], speedOptions: BOTH_SPEEDS, sessionConfig: true });
  const tray = openTray(h, "effort");
  assert.equal(segs(tray).length, 0, "no effort segments render");
  const fast = tray.querySelector("#fast-thinking");
  assert.ok(fast, "Fast stays available on the details page");
  fast.click();
  assert.equal(h.posted.at(-1).configId, "speed");
  assert.equal(h.posted.at(-1).value, "standard");
  assert.equal(h.errors().length, 0);
});

test("an incompatible Sub still offers every Lead (E)", () => {
  const h = mount({ currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-flash-max", currentThoughtLevel: "high", speedOptions: [] });
  const tray = openFusionPage(h);
  assert.ok(rowMain(tray, "gpt-6-astra"), "Astra stays listed though Flash cannot pair with it");
  rowMain(tray, "gpt-6-astra").click();
  const sent = fusionPosts(h).at(-1);
  assert.equal(sent.model, "fusion-gpt-6-astra-high-sidekick-swe-2-medium", "the silent fallback pairs Astra with SWE-2 Medium");
  assert.equal(h.errors().length, 0);
});

test("newer provider versions sort first in main, Fusion and pinned lists (F)", () => {
  const pair = (lead, sub) => `fusion-${lead}-high-sidekick-${sub === "swe-2" ? "swe-2-medium" : sub}`;
  const variants = [
    pair("claude-opus-5-5", "swe-2"),
    pair("gpt-6-1", "swe-2"),
    pair("gpt-5-6", "swe-2"),
    pair("claude-opus-5-5", "gpt-6-1"),
    pair("claude-opus-5-5", "gpt-5-6")
  ].map((value) => ({ value, name: value }));
  const grown = [
    { id: "fusion", name: "Fusion", default: variants[0].value, variants },
    { id: "zzz-alpha", name: "Equal Two", default: "zzz-alpha-1", variants: [{ value: "zzz-alpha-1", name: "Equal Two" }] },
    { id: "aaa-beta", name: "Equal Two B", default: "aaa-beta-1", variants: [{ value: "aaa-beta-1", name: "Equal Two B" }] },
    ...fixture.models.filter((fam) => fam.id !== "fusion"),
    { id: "gpt-6-1", name: "GPT-6.1", default: "gpt-6-1-high", variants: [{ value: "gpt-6-1-high", name: "GPT-6.1 High" }] },
    { id: "gpt-5-6", name: "GPT-5.6", default: "gpt-5-6-high", variants: [{ value: "gpt-5-6-high", name: "GPT-5.6 High" }] }
  ];
  const h = mount({ currentModel: variants[0].value, currentThoughtLevel: "high", models: grown });
  const check = (names, what) => {
    const i61 = names.indexOf("GPT-6.1"), i56 = names.indexOf("GPT-5.6");
    assert.ok(i61 > -1 && i56 > -1 && i61 < i56, `${what}: GPT-6.1 (${i61}) precedes GPT-5.6 (${i56})`);
  };
  const tray = openFusionPage(h);
  check(rowNames(tray, ".fusion-rows .dd-item"), "lead list");
  pickRole(tray, "sub");
  check(rowNames(tray, ".fusion-rows .dd-item"), "sub list");
  tray.querySelector("#pageBack").click();
  check(rowNames(popup(h)), "main list");
  // Pinned group keeps the same ordering and equal versions stay in catalog order.
  const h3 = createHarness({ state: { pinnedModels: ["gpt-6-1", "gpt-5-6"] } });
  h3.post({ type: "ready" });
  h3.post({ type: "body", body: "thread" });
  h3.post(fixture.options({ currentModel: "claude-opus-5-5-high", models: grown }));
  const groups = [...openTray(h3).querySelectorAll(".dd-group")].map((g) => g.textContent);
  assert.ok(groups.includes("Pinned"), "a Pinned group exists");
  const pinnedSection = [...popup(h3).querySelectorAll(".dd-group")].find((g) => g.textContent === "Pinned");
  const pinnedNames = [];
  for (let el = pinnedSection.nextElementSibling; el && el.classList.contains("dd-item"); el = el.nextElementSibling) {
    pinnedNames.push(el.querySelector(".dd-item-name")?.textContent);
  }
  assert.deepEqual(pinnedNames, ["GPT-6.1", "GPT-5.6"], "pinned rows keep version order");
  const eq = rowNames(popup(h3)).filter((n) => n === "Equal Two" || n === "Equal Two B");
  assert.deepEqual(eq, ["Equal Two", "Equal Two B"], "equal versions keep catalog order");
  assert.equal(h3.errors().length, 0);
});

test("a model notification that changes the family closes an open role page (G)", () => {
  const h = mount({ currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-medium", currentThoughtLevel: "high", speedOptions: [] });
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(tray, "swe-2").click();
  assert.equal(popup(h).querySelector(".role-page, #pageBack") !== null, true);
  h.post({ type: "model", model: "claude-opus-5-5-high" });
  assert.ok(!popup(h) || popup(h).classList.contains("hidden"), "the stale Fusion page closes");
  assert.ok(!h.posted.some((m) => m.type === "setModel"), "no setting message is posted");
  assert.equal(h.errors().length, 0);
});

test("the search caret survives rerenders in the middle of the query (H)", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h);
  const input = tray.querySelector("#pageSearch");
  input.value = "claude";
  input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
  const again = popup(h).querySelector("#pageSearch");
  again.setSelectionRange(2, 4);
  again.value = "clXaude";
  again.setSelectionRange(3, 3);
  again.dispatchEvent(new again.ownerDocument.defaultView.Event("input", { bubbles: true }));
  const next = popup(h).querySelector("#pageSearch");
  assert.equal(next.value, "clXaude");
  assert.equal(next.selectionStart, 3, "the caret stays mid query");
  assert.equal(h.errors().length, 0);
});


test("a rejected Fast after the first sessionReady restores the saved standard", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high", currentThoughtLevel: "high", currentSpeed: "standard", thoughtLevels: MAX_LEVELS, speedOptions: BOTH_SPEEDS, sessionConfig: true });
  openTray(h, "effort").querySelector("#fast-thinking").click();
  const req = h.posted.at(-1).requestId;
  h.post({ type: "sessionReady", sessionId: "first-session" });
  h.post({ type: "modelConfigApplied", requestId: req, model: "claude-opus-5-5-high", thoughtLevel: "high", speed: "standard" });
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "standard", "the saved speed reverts with the rejected change");
  openTray(h, "effort");
  assert.equal(popup(h).querySelector("#fast-thinking").getAttribute("aria-pressed"), "false");
  assert.equal(h.errors().length, 0);
});

test("a rejected Fast after a non reset clear restores the saved standard", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high", currentThoughtLevel: "high", currentSpeed: "standard", thoughtLevels: MAX_LEVELS, speedOptions: BOTH_SPEEDS, sessionConfig: true });
  openTray(h, "effort").querySelector("#fast-thinking").click();
  const req = h.posted.at(-1).requestId;
  h.post({ type: "clear" });
  h.post({ type: "modelConfigApplied", requestId: req, model: "claude-opus-5-5-high", thoughtLevel: "high", speed: "standard" });
  assert.equal(h.state().modelPreferences.single["claude-opus-5-5"].speed, "standard", "a clear without reset keeps intent");
  assert.equal(h.errors().length, 0);
});

test("unchanged options preserve the search selection range and direction", () => {
  const h = mount({ currentModel: "claude-opus-5-5-high" });
  const tray = openTray(h);
  const input = tray.querySelector("#pageSearch");
  input.value = "claude";
  input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
  const rebuilt = popup(h).querySelector("#pageSearch");
  rebuilt.focus();
  rebuilt.setSelectionRange(1, 4, "backward");
  h.post(fixture.options({ currentModel: "claude-opus-5-5-high" }));
  const next = popup(h).querySelector("#pageSearch");
  assert.equal(h.document.activeElement, next, "focus stays on the rebuilt search");
  assert.equal(next.selectionStart, 1);
  assert.equal(next.selectionEnd, 4);
  assert.equal(next.selectionDirection, "backward");
  assert.equal(h.errors().length, 0);
});

test("featured cards keep New Promotion and Beta tags inline with the title", () => {
  const grown = [
    { id: "adaptive", name: "Adaptive", default: "adaptive",
      variants: [{ value: "adaptive", name: "Adaptive", isNew: true, promotion: "Discount" }] },
    ...fixture.models.map((fam) => fam.id === "fusion"
      ? { ...fam, variants: fam.variants.map((v) => ({ ...v, isNew: true, isBeta: true, promotion: "PROMO" })) }
      : fam)
  ];
  const h = mount({ currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-medium", currentThoughtLevel: "high", models: grown });
  const [adaptiveCard, fusionCard] = [...openTray(h).querySelectorAll(".dd-item-card")];
  const tags = (card) => [...card.querySelectorAll(".dd-card-title .dd-model-tag")];
  assert.ok(tags(adaptiveCard).length, "the Adaptive card carries its own tags");
  assert.deepEqual(tags(adaptiveCard).map((t) => t.textContent), ["New", "Promotion"], "a generic Discount label folds into Promotion");
  assert.equal(tags(adaptiveCard)[1].title, "Promotion");
  assert.equal(adaptiveCard.querySelector(".dd-item-main").getAttribute("aria-description"), "New, Promotion");
  const title = fusionCard.querySelector(".dd-card-title");
  assert.ok(title, "featured cards have a title row");
  assert.ok(title.querySelector(".dd-item-name"), "the name sits on the title row");
  assert.ok(title.classList.contains("dd-tagged-content"), "the tagged title can wrap its tags");
  assert.deepEqual(tags(fusionCard).map((t) => t.textContent), ["New", "Promotion", "Beta"]);
  assert.ok(tags(fusionCard)[0].classList.contains("dd-model-tag-new"));
  assert.ok(tags(fusionCard)[1].classList.contains("dd-model-tag-promotion"));
  assert.equal(tags(fusionCard)[1].title, "Promotion", "a generic PROMO label keeps the plain title");
  assert.ok(tags(fusionCard)[2].classList.contains("dd-model-tag-beta"));
  assert.equal(fusionCard.querySelector(".dd-item-main").getAttribute("aria-description"), "New, Promotion, Beta");
  assert.ok(fusionCard.querySelector(".dd-card-sub"), "the subtitle sits beneath the title row");
  assert.equal(h.errors().length, 0);
});

test("model rows show status tags with the offer tooltip beside a separate Fast badge", () => {
  const grown = fixture.models.map((fam) => fam.id === "gpt-6-luna"
    ? { ...fam, variants: fam.variants.map((v) => ({ ...v, isNew: true, promotion: "20% off", isBeta: true })) }
    : fam);
  const h = createHarness({ state: { pinnedModels: ["gpt-6-luna"] } });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ models: grown }));
  const tray = openTray(h);
  const row = rowMain(tray, "gpt-6-luna");
  const content = row.querySelector(".dd-item-content");
  const kids = [...tray.querySelectorAll(".dd-rows > *")];
  const pinnedAt = kids.findIndex((el) => el.textContent === "Pinned");
  const modelsAt = kids.findIndex((el) => el.textContent === "Models");
  const rowAt = kids.findIndex((el) => el.contains(row));
  assert.ok(pinnedAt >= 0 && rowAt > pinnedAt && rowAt < modelsAt, "the pinned model lands in the Pinned group");
  assert.ok(content.classList.contains("dd-tagged-content"), "tagged rows can wrap their metadata");
  const tags = [...content.querySelectorAll(".dd-model-tag")];
  assert.deepEqual(tags.map((t) => t.textContent), ["New", "Promotion", "Beta"], "one tag per status in display order");
  assert.deepEqual(
    tags.map((t) => ["new", "promotion", "beta"].find((k) => t.classList.contains(`dd-model-tag-${k}`))),
    ["new", "promotion", "beta"]
  );
  assert.equal(tags[1].title, "Promotion: 20% off", "the offer text survives on the Promotion tooltip");
  assert.equal(row.getAttribute("aria-description"), "New, Promotion: 20% off, Beta", "the row exposes every tag to assistive tech");
  const fast = content.querySelector(".dd-fast-badge");
  assert.ok(fast, "Fast availability stays a separate neutral badge");
  assert.ok(fast.querySelector(".codicon-zap"), "the Fast badge keeps its outline bolt");
  assert.ok(!fast.classList.contains("dd-model-tag"));
  assert.equal(h.errors().length, 0);
});

test("fusion lead and sub rows show each model's own status tags", () => {
  const grown = fixture.models.map((fam) => {
    if (fam.id === "claude-opus-5-5") return { ...fam, variants: fam.variants.map((v) => ({ ...v, isNew: true })) };
    if (fam.id === "swe-2") return { ...fam, variants: fam.variants.map((v) => ({ ...v, isBeta: true, promotion: "PROMO" })) };
    return fam;
  });
  const h = mount({ models: grown, currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-medium" });
  const tray = openFusionPage(h);
  pickRole(tray, "lead");
  const leadTags = [...rowMain(tray, "claude-opus-5-5").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(leadTags.map((t) => t.textContent), ["New"], "the Lead list shows the Lead model's tags");
  assert.equal(rowMain(tray, "claude-opus-5-5").getAttribute("aria-description"), "New");
  pickRole(tray, "sub");
  const subTags = [...rowMain(tray, "swe-2").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(subTags.map((t) => t.textContent), ["Promotion", "Beta"], "the Sub list shows the Sub model's tags");
  assert.ok(subTags[0].classList.contains("dd-model-tag-promotion"));
  assert.ok(subTags[1].classList.contains("dd-model-tag-beta"));
  assert.equal(rowMain(tray, "swe-2").getAttribute("aria-description"), "Promotion, Beta");
  assert.equal(h.errors().length, 0);
});

test("absent flags and offer markup produce no tags and no elements", () => {
  const grown = fixture.models.map((fam) => {
    if (fam.id === "swe-2") return { ...fam, variants: fam.variants.map((v) => ({ ...v, isNew: false, isBeta: false, promotion: " " })) };
    if (fam.id === "swe-2-flash") return { ...fam, variants: fam.variants.map((v) => ({ ...v, promotion: "<img src=x>" })) };
    if (fam.id === "gpt-6-astra") return { ...fam, variants: fam.variants.map((v) => ({ ...v, promotion: "PROMO" })) };
    return fam;
  });
  const h = mount({ models: grown });
  const tray = openTray(h);
  const plain = rowMain(tray, "swe-2");
  assert.ok(!plain.querySelector(".dd-model-tag"), "false flags and a blank promotion render no tags");
  assert.ok(!plain.querySelector(".dd-item-content").classList.contains("dd-tagged-content"), "untagged rows keep their layout");
  assert.ok(!plain.hasAttribute("aria-description"), "an untagged row keeps its plain accessible name only");
  const astra = [...rowMain(tray, "gpt-6-astra").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(astra.map((t) => t.textContent), ["Promotion"], "a generic PROMO renders one Promotion tag");
  assert.equal(astra[0].title, "Promotion");
  assert.equal(rowMain(tray, "gpt-6-astra").getAttribute("aria-description"), "Promotion");
  const flash = rowMain(tray, "swe-2-flash");
  const tag = flash.querySelector(".dd-model-tag");
  assert.ok(tag && tag.classList.contains("dd-model-tag-promotion"), "custom offer text still folds into Promotion");
  assert.equal(tag.textContent, "Promotion");
  assert.equal(tag.title, "Promotion: <img src=x>", "the offer text stays verbatim in the tooltip");
  assert.equal(flash.getAttribute("aria-description"), "Promotion: <img src=x>", "the description keeps the offer as plain text");
  assert.ok(!flash.querySelector("img"), "markup in catalog metadata never creates elements");
  assert.equal(h.errors().length, 0);
});

test("pricing UI shows each role's own rates and keeps the cost badge with Fast (I)", () => {
  const h = mount(pricingFixture);
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(tray, "gpt-5-6-sol").click();
  const rows = () => [...popup(h).querySelectorAll(".catalog-prices tbody tr")].map((r) => [r.querySelector("th").textContent, r.querySelector("td").textContent]);
  const tier = () => popup(h).querySelector(".catalog-tier")?.textContent;
  const limits = () => [...popup(h).querySelectorAll(".catalog-limit")].map((r) => [r.querySelector("dt").textContent, r.querySelector("dd").textContent]);
  const openPricing = () => { const d = popup(h).querySelector("details.catalog-pricing"); d.open = true; d.dispatchEvent(new d.ownerDocument.defaultView.Event("toggle")); };
  assert.equal(segs(popup(h)).filter((sg) => sg.getAttribute("aria-checked") === "true").length, 1, "one effort segment is checked");
  openPricing();
  assert.equal(tier(), "High cost");
  assert.deepEqual(rows(), [["Input", "$4"], ["Output", "$20"], ["Cache Read", "$0.4"]]);
  assert.deepEqual(limits(), [["Max context", "1M tokens"], ["Max output", "128K tokens"]]);
  popup(h).querySelector("#fast-thinking").click();
  openPricing();
  assert.equal(tier(), "High cost");
  assert.deepEqual(rows(), [["Input", "$8"], ["Output", "$40"], ["Cache Read", "$0.8"]]);
  assert.deepEqual(limits(), [["Max context", "1M tokens"], ["Max output", "128K tokens"]]);
  popup(h).querySelector("#pageBack").click();
  pickRole(popup(h), "lead");
  rowAction(popup(h), "claude-opus-5-5").click();
  openPricing();
  assert.equal(tier(), "High cost");
  assert.deepEqual(rows(), [["Input", "$4"], ["Output", "$20"], ["Cache Read", "$0.2"]]);
  popup(h).querySelector("#fast-thinking").click();
  openPricing();
  assert.equal(tier(), "High cost");
  assert.deepEqual(rows(), [["Input", "$8"], ["Output", "$40"], ["Cache Read", "$0.4"]]);
  popup(h).querySelector("#pageBack").click();
  pickRole(popup(h), "sub");
  assert.ok(rowAction(popup(h), "gpt-5-6-sol").querySelector(".zap-fill"), "the Sub stays Fast");
  assert.equal(h.errors().length, 0);
});

test("Fusion role pricing headers show only the role model's own promotion", () => {
  const options = JSON.parse(JSON.stringify(pricingFixture));
  const subFam = options.models.find((m) => m.id === "gpt-5-6-sol");
  subFam.variants.forEach((v) => { v.promotion = "Launch offer"; });
  // A promotional Fusion pair must never leak into either role's header.
  options.models.find((m) => m.id === "fusion").variants.forEach((v) => { v.promotion = "PROMO"; });
  const h = mount(options);
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  rowAction(popup(h), "gpt-5-6-sol").click();
  const subHead = popup(h).querySelector(".catalog-pricing-head");
  const subTags = subHead.querySelectorAll(".dd-model-tag-promotion");
  assert.equal(subTags.length, 1, "the Sub header shows its own offer");
  assert.equal(subTags[0].title, "Promotion: Launch offer");
  popup(h).querySelector("#pageBack").click();
  pickRole(popup(h), "lead");
  rowAction(popup(h), "claude-opus-5-5").click();
  const leadHead = popup(h).querySelector(".catalog-pricing-head");
  assert.equal(leadHead.querySelectorAll(".dd-model-tag").length, 0, "the non promotional Lead shows no status tag");
  assert.equal(h.errors().length, 0);
});

test("model rows badge the displayed effort rather than the family default", () => {
  const grown = fixture.models.map((fam) => fam.id === "swe-2"
    ? {
      ...fam,
      variants: [
        { value: "swe-2-medium", name: "Medium" },
        { value: "swe-2-high", name: "High", isNew: true, promotion: "83% off", isBeta: true }
      ]
    }
    : fam);
  // The uid still names Medium while the session reports High effort.
  const h = mount({ models: grown, currentModel: "swe-2-medium", currentThoughtLevel: "high" });
  const tray = openTray(h);
  const row = rowMain(tray, "swe-2");
  const tags = [...row.querySelectorAll(".dd-model-tag")];
  assert.deepEqual(tags.map((t) => t.textContent), ["New", "Promotion", "Beta"], "the row badges the displayed High effort");
  assert.equal(tags[1].title, "Promotion: 83% off", "the offer tooltip comes from the displayed variant");
  assert.equal(row.getAttribute("aria-description"), "New, Promotion: 83% off, Beta");
  const clean = fixture.models.map((fam) => fam.id === "swe-2"
    ? { ...fam, variants: fam.variants.map((v) => ({ value: v.value, name: v.name })) }
    : fam);
  h.post(fixture.options({ models: clean, currentModel: "swe-2-medium", currentThoughtLevel: "high" }));
  assert.ok(!rowMain(popup(h), "swe-2").querySelector(".dd-model-tag"), "refreshed options without signals drop the badges");
  assert.equal(h.errors().length, 0);
});

test("fusion role rows badge the effort and speed each role displays", () => {
  const grown = fixture.models.map((fam) => {
    if (fam.id === "swe-2") {
      return {
        ...fam,
        variants: [
          { value: "swe-2-medium", name: "Medium" },
          { value: "swe-2-high", name: "High", isNew: true, promotion: "83% off", isBeta: true }
        ]
      };
    }
    if (fam.id === "claude-opus-5-5") {
      return { ...fam, variants: fam.variants.map((v) => (v.value === "claude-opus-5-5-max" ? { ...v, isNew: true } : v)) };
    }
    return fam;
  });
  // The pair uid names High Lead effort while the session reports Max, and
  // the Sub pair names swe-2-high, so each row's badges must follow the
  // effort and speed it displays rather than the family default.
  const h = mount({
    models: grown,
    currentModel: "fusion-claude-opus-5-5-high-sidekick-swe-2-high",
    currentThoughtLevel: "max"
  });
  const tray = openFusionPage(h);
  pickRole(tray, "lead");
  const leadTags = [...rowMain(tray, "claude-opus-5-5").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(leadTags.map((t) => t.textContent), ["New"], "the lead row badges its own displayed Max effort");
  pickRole(tray, "sub");
  const subTags = [...rowMain(tray, "swe-2").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(subTags.map((t) => t.textContent), ["New", "Promotion", "Beta"], "the sub row badges its own displayed High effort");
  assert.equal(subTags[1].title, "Promotion: 83% off");
  assert.equal(rowMain(tray, "swe-2").getAttribute("aria-description"), "New, Promotion: 83% off, Beta");
  assert.equal(h.errors().length, 0);
});

test("a Fast selection never borrows the standard variant's badges", () => {
  const grown = fixture.models.map((fam) => fam.id === "gpt-6-luna"
    ? {
      ...fam,
      variants: [
        { value: "gpt-6-luna-high", name: "High", promotion: "20% off" },
        { value: "gpt-6-luna-high-priority", name: "High Fast" }
      ]
    }
    : fam);
  // The uid still names the standard variant while Fast is reported separately.
  const h = mount({ models: grown, currentModel: "gpt-6-luna-high", currentSpeed: "fast", currentThoughtLevel: "high" });
  const tray = openTray(h);
  assert.ok(!rowMain(tray, "gpt-6-luna").querySelector(".dd-model-tag"), "the Fast row shows no standard offer");
  h.post(fixture.options({ models: grown, currentModel: "gpt-6-luna-high", currentSpeed: "standard", currentThoughtLevel: "high" }));
  const tags = [...rowMain(popup(h), "gpt-6-luna").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(tags.map((t) => t.textContent), ["Promotion"], "the standard row keeps its own offer");
  assert.equal(tags[0].title, "Promotion: 20% off");
  assert.equal(h.errors().length, 0);
});

test("fusion sub rows at Fast speed keep their own variant's badges", () => {
  const grown = fixture.models.map((fam) => fam.id === "gpt-6-luna"
    ? {
      ...fam,
      variants: [
        { value: "gpt-6-luna-high", name: "High", promotion: "20% off" },
        { value: "gpt-6-luna-high-priority", name: "High Fast", isNew: true }
      ]
    }
    : fam);
  const state = {
    modelPreferences: {
      version: 1, single: {}, fusion: { lead: "claude-opus-5-5", subModel: "gpt-6-luna" },
      lead: {},
      sub: { "gpt-6-luna": { effort: "high", speed: "fast" } }
    }
  };
  const h = createHarness({ state });
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(fixture.options({ models: grown }));
  const tray = openFusionPage(h);
  pickRole(tray, "sub");
  const tags = [...rowMain(tray, "gpt-6-luna").querySelectorAll(".dd-model-tag")];
  assert.deepEqual(tags.map((t) => t.textContent), ["New"], "the Fast sub shows its own variant's New tag, not the standard offer");
  assert.equal(h.errors().length, 0);
});

test.after(async () => { await cleanup(); });
