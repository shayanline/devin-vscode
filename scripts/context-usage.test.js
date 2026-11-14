const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const { createHarness } = require("./webview-harness");

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../webview/contextUsage.js")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error"
});
const compiled = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(compiled, compiled.exports);
const { contextPercent, normalizeContextUsage, fusionUsageRoles } = compiled.exports;

const fusion = "fusion-gpt-6-1-sol-max-fast-sidekick-gpt-6-luna-high";
const lead = { modelId: "gpt-6-1-sol-max", totalTokens: 135000, maxTokens: 1000000 };
const sub = { modelId: "gpt-6-luna-high", totalTokens: 50000, maxTokens: 200000 };
const report = (contexts, model = fusion) => normalizeContextUsage({ contexts }, null, model);

test("context data: role mapping uses model identities instead of array order or the fullest window", () => {
  for (const contexts of [[lead, sub], [sub, lead]]) {
    const usage = report(contexts);
    const roles = fusionUsageRoles(usage, fusion);
    assert.deepEqual(roles.map((role) => [role.role, role.letter, role.context]), [
      ["lead", "L", lead], ["sub", "S", sub]
    ]);
    assert.equal(contextPercent(roles[0].context.totalTokens, roles[0].context.maxTokens), 14);
    assert.equal(contextPercent(roles[1].context.totalTokens, roles[1].context.maxTokens), 25);
  }
});

test("context data: aggregate updates retain the last structured snapshot for the same selection", () => {
  const previous = report([sub, lead]);
  const usage = normalizeContextUsage({ used: 100, size: 1000 }, previous, fusion);
  assert.deepEqual(usage.contexts, [sub, lead]);
  assert.deepEqual(fusionUsageRoles(usage, fusion).map((role) => role.context), [lead, sub]);
});

test("context data: separate ACP object reports merge without discarding the other Fusion role", () => {
  const first = normalizeContextUsage({ contexts: { ...sub, role: "sub" } }, null, fusion);
  const both = normalizeContextUsage({ contexts: { ...lead, role: "lead" } }, first, fusion);
  assert.equal(both.contexts.length, 2);
  assert.deepEqual(fusionUsageRoles(both, fusion).map((role) => role.context.modelId), [lead.modelId, sub.modelId]);
  const updated = normalizeContextUsage({ contexts: { ...sub, role: "sub", totalTokens: 0 } }, both, fusion);
  assert.deepEqual(fusionUsageRoles(updated, fusion).map((role) => role.context.totalTokens), [lead.totalTokens, 0]);
  const changed = normalizeContextUsage({ contexts: { ...sub, role: "sub", modelId: "gpt-6-luna-low", totalTokens: 40000 } }, both, fusion);
  assert.equal(changed.contexts.length, 2, "a new effort replaces the old window in the same role");
  assert.equal(fusionUsageRoles(changed, fusion)[1].context.totalTokens, 40000);
  const same = "fusion-gpt-6-luna-high-sidekick-gpt-6-luna-high";
  const scoped = normalizeContextUsage({ contexts: [{ ...sub, role: "sub" }, { ...sub, role: "lead", totalTokens: 10000 }] }, null, same);
  assert.deepEqual(fusionUsageRoles(scoped, same).map((role) => role.context.totalTokens), [10000, sub.totalTokens]);
});

test("context data: session ACUs survive window updates and remain available before a window report", () => {
  const billing = normalizeContextUsage({ sessionAcus: 1.9281 }, null, fusion);
  assert.equal(billing.sessionAcus, 1.9281);
  assert.deepEqual(billing.contexts, []);
  assert.equal(contextPercent(billing.used, billing.size), null);
  const usage = normalizeContextUsage({ contexts: sub }, billing, fusion);
  assert.equal(usage.sessionAcus, 1.9281);
  const updated = normalizeContextUsage({ sessionAcus: 2.5 }, usage, fusion);
  assert.equal(updated.used, sub.totalTokens);
  assert.equal(updated.size, sub.maxTokens);
  assert.equal(updated.sessionAcus, 2.5);
  assert.equal(normalizeContextUsage({ sessionAcus: null }, updated, fusion).sessionAcus, null);
  assert.equal(normalizeContextUsage({ sessionAcus: 0 }, null, fusion).sessionAcus, 0);
});

test("context data: explicit empty snapshots and different selections cannot reuse stale role counts", () => {
  const previous = report([lead, sub]);
  const cleared = normalizeContextUsage({ used: 100, size: 1000, contexts: [] }, previous, fusion);
  assert.deepEqual(fusionUsageRoles(cleared, fusion).map((role) => role.context), [null, null]);
  const other = "fusion-gpt-6-1-sol-max-fast-sidekick-swe-2-medium";
  assert.deepEqual(fusionUsageRoles(previous, other).map((role) => role.context), [null, null]);
  const changed = normalizeContextUsage({ used: 100, size: 1000 }, previous, other);
  assert.deepEqual(changed.contexts, []);
});

test("context data: missing and unrelated records never stand in for a missing role", () => {
  const unrelated = { modelId: "unrelated-high", totalTokens: 999, maxTokens: 1000 };
  assert.deepEqual(fusionUsageRoles(report([unrelated, lead]), fusion).map((role) => role.context), [lead, null]);
  assert.deepEqual(fusionUsageRoles(report([sub]), fusion).map((role) => role.context), [null, sub]);
});

test("context data: indistinguishable roles stay unknown while distinct exact variants can be resolved", () => {
  const same = "fusion-gpt-6-luna-high-sidekick-gpt-6-luna-high";
  assert.deepEqual(fusionUsageRoles(report([sub], same), same).map((role) => role.context), [null, null]);
  const distinct = "fusion-gpt-6-luna-low-sidekick-gpt-6-luna-high";
  const low = { ...sub, modelId: "gpt-6-luna-low", totalTokens: 10000 };
  assert.deepEqual(fusionUsageRoles(report([sub, low], distinct), distinct).map((role) => role.context), [low, sub]);
});

test("context data: invalid records are rejected at the boundary and valid zero usage remains zero", () => {
  const zero = { ...lead, totalTokens: 0 };
  const usage = report([null, {}, { ...lead, modelId: 4 }, { ...sub, maxTokens: 0 }, { ...sub, totalTokens: -1 }, { ...sub, totalTokens: NaN }, zero]);
  assert.deepEqual(usage.contexts, [zero]);
  assert.equal(contextPercent(usage.used, usage.size), 0);
  assert.equal(normalizeContextUsage({ used: 1, size: 0 }, null, fusion), null);
  assert.equal(contextPercent(10, 0), null);
  assert.equal(contextPercent(-1, 100), null);
  assert.equal(contextPercent(240, 200), 120);
});

test("context data: Single keeps its existing aggregate percentage and fullest metadata behavior", () => {
  const usage = normalizeContextUsage({ used: 45000, size: 200000 }, null, "gpt-6-luna-high");
  assert.equal(contextPercent(usage.used, usage.size), 23);
  assert.equal(fusionUsageRoles(usage, "gpt-6-luna-high"), null);
  const structured = report([lead, sub], "gpt-6-luna-high");
  assert.equal(structured.used, sub.totalTokens);
  assert.equal(structured.size, sub.maxTokens);
});

const models = [
  { id: "fusion", name: "Fusion", default: fusion, variants: [{ value: fusion, name: "Fusion" }] },
  {
    id: "gpt-6-1-sol", name: "GPT-6.1 Sol", default: "gpt-6-1-sol-max",
    variants: [{ value: "gpt-6-1-sol-max", name: "Max" }, { value: "gpt-6-1-sol-max-fast", name: "Max Fast" }]
  },
  { id: "gpt-6-luna", name: "GPT-6 Luna", default: "gpt-6-luna-high", variants: [{ value: "gpt-6-luna-high", name: "High" }] }
];

function options(currentModel = fusion) {
  return {
    type: "options", currentModel, currentThoughtLevel: currentModel === fusion ? "max" : "high",
    currentSpeed: currentModel === fusion ? "fast" : "standard",
    thoughtLevels: [{ value: "max", name: "Max" }, { value: "high", name: "High" }],
    models, modelChoices: {}, modes: []
  };
}

function mountUsage() {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post(options());
  return h;
}

test("context UI: Fusion shows independent labelled rings and detailed role counts after aggregate updates", async () => {
  const h = mountUsage();
  try {
    h.post({ type: "usage", used: 0, size: 0, contexts: [sub, lead] });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    assert.equal(meter.classList.contains("hidden"), false);
    assert.deepEqual(Array.from(meter.querySelectorAll(".usage-role-letter"), (item) => item.textContent), ["L", "S"]);
    assert.match(meter.querySelector('[data-role="lead"]').getAttribute("aria-label"), /14%/);
    assert.match(meter.querySelector('[data-role="sub"]').getAttribute("aria-label"), /25%/);
    // Each role keeps its own percentage next to its meter, the same hover
    // reveal a Single ring has, and the tooltip names both models.
    assert.equal(meter.querySelectorAll(".usage-role-group").length, 2);
    const leadGroup = meter.querySelector('[data-role="lead"]').closest(".usage-role-group");
    const subGroup = meter.querySelector('[data-role="sub"]').closest(".usage-role-group");
    assert.equal(leadGroup.querySelector(".usage-pct").textContent, "14%");
    assert.equal(subGroup.querySelector(".usage-pct").textContent, "25%");
    assert.match(meter.getAttribute("title"), /Lead · GPT-6\.1 Sol 14%/);
    assert.match(meter.getAttribute("title"), /Sub model · GPT-6 Luna 25%/);
    h.post({ type: "usage", used: 100, size: 1000 });
    meter.click();
    const leadPanel = h.document.querySelector('#usage-popup .usage-model[data-role="lead"]');
    const subPanel = h.document.querySelector('#usage-popup .usage-model[data-role="sub"]');
    assert.match(leadPanel.textContent, /Lead/);
    assert.match(leadPanel.textContent, /14%/);
    assert.match(leadPanel.textContent, /135k \/ 1000k/);
    assert.equal(leadPanel.querySelector(".usage-bar > div").style.width, "14%");
    assert.match(subPanel.textContent, /Sub model/);
    assert.match(subPanel.textContent, /25%/);
    assert.match(subPanel.textContent, /50k \/ 200k/);
    assert.equal(subPanel.querySelector(".usage-bar > div").style.width, "25%");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: missing usage is distinct from a reported zero", async () => {
  const h = mountUsage();
  try {
    h.post({ type: "usage", contexts: [lead] });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    const missing = meter.querySelector('[data-role="sub"]');
    assert.match(missing.getAttribute("aria-label"), /not reported/i);
    assert.equal(missing.querySelectorAll("circle").length, 1, "unknown has only a track, without a zero usage arc");
    assert.equal(missing.closest(".usage-role-group").querySelector(".usage-pct"), null, "an unreported role never shows a percentage");
    meter.click();
    assert.match(h.document.querySelector('#usage-popup .usage-model[data-role="sub"]').textContent, /Not reported/);
    h.post({ type: "usage", contexts: [{ ...lead, totalTokens: 0 }, { ...sub, totalTokens: 0 }] });
    const zero = meter.querySelector('[data-role="sub"]');
    assert.match(zero.getAttribute("aria-label"), /0%/);
    assert.equal(zero.querySelectorAll("circle").length, 2, "reported zero remains a known usage window");
    assert.equal(zero.closest(".usage-role-group").querySelector(".usage-pct").textContent, "0%", "a reported zero is a real percentage");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: context settings and session clearing remove both role indicators and stale details", async () => {
  const h = mountUsage();
  try {
    h.post({ type: "usage", contexts: [lead, sub] });
    await h.settle(10);
    h.document.querySelector("#usage").click();
    h.post({ type: "capabilities", contextUsage: false });
    assert.ok(h.document.querySelector("#usage").classList.contains("hidden"));
    assert.equal(h.document.querySelector("#usage-popup"), null);
    h.post({ type: "capabilities", contextUsage: true });
    h.post({ type: "clear" });
    assert.equal(h.document.querySelector("#usage").children.length, 0);
    h.post({ type: "usage", used: 100, size: 1000 });
    assert.match(h.document.querySelector('#usage [data-role="lead"]').getAttribute("aria-label"), /not reported/i);
    assert.match(h.document.querySelector('#usage [data-role="sub"]').getAttribute("aria-label"), /not reported/i);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: changing to Single restores the existing single ring and aggregate details", async () => {
  const h = mountUsage();
  try {
    h.post({ type: "usage", contexts: [lead, sub] });
    await h.settle(10);
    h.post(options("gpt-6-luna-high"));
    h.post({ type: "model", model: "gpt-6-luna-high" });
    assert.equal(h.document.querySelectorAll("#usage .usage-role").length, 0);
    h.post({ type: "usage", used: 45000, size: 200000 });
    const meter = h.document.querySelector("#usage");
    assert.equal(meter.querySelectorAll(".usage-role-group").length, 0, "a single model keeps its plain ring layout");
    const singlePct = meter.querySelector(".usage-pct");
    assert.equal(singlePct.textContent, "23%");
    assert.equal(singlePct.parentElement, meter, "the Single percentage stays a direct child of the meter");
    meter.click();
    assert.match(h.document.querySelector("#usage-popup").textContent, /Context window/);
    assert.match(h.document.querySelector("#usage-popup").textContent, /45k \/ 200k/);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: Escape dismisses the details and returns keyboard focus to the meter", async () => {
  const h = mountUsage();
  try {
    h.post({ type: "usage", contexts: [lead, sub] });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    meter.click();
    assert.ok(h.document.querySelector("#usage-popup"));
    h.document.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(h.document.querySelector("#usage-popup"), null);
    assert.equal(h.document.activeElement, meter);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

// The settled session fixture: a Fusion pair whose Lead reports a 1M window and
// whose Sub (the "sidekick" subagent) reports its own, plus the session ACUs
// the host read from /session-stats.
const sweFusion = "fusion-gpt-6-1-sol-max-sidekick-swe-2-flash-max";
const usageModels = [
  { id: "fusion", name: "Fusion", default: sweFusion, variants: [{ value: sweFusion, name: "Fusion" }] },
  models[1],
  models[2],
  { id: "swe-2-flash", name: "SWE-2 Flash", default: "swe-2-flash-max", variants: [{ value: "swe-2-flash-max", name: "Max" }] }
];
const roleContexts = [
  { modelId: "gpt-6-1-sol-max", totalTokens: 90745, maxTokens: 1000000, role: "lead" },
  { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144, role: "sub" }
];

function mountSessionUsage() {
  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ ...options(), currentModel: sweFusion, models: usageModels });
  return h;
}

test("context UI: the popup reports both Fusion windows, session ACUs, and asks to refresh", async () => {
  const h = mountSessionUsage();
  try {
    h.post({ type: "usage", contextModel: sweFusion, sessionAcus: 1.9281, contexts: roleContexts });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    assert.match(meter.querySelector('[data-role="lead"]').getAttribute("aria-label"), /9%/);
    assert.match(meter.querySelector('[data-role="sub"]').getAttribute("aria-label"), /10%/);
    meter.click();
    assert.ok(h.posted.some((m) => m.type === "refreshUsage"), "opening the popup asks the host for fresh figures");
    const pop = h.document.querySelector("#usage-popup");
    const leadPanel = pop.querySelector('[data-role="lead"]');
    const subPanel = pop.querySelector('[data-role="sub"]');
    assert.match(leadPanel.textContent, /Lead · GPT-6.1 Sol/);
    assert.match(leadPanel.textContent, /91k \/ 1000k/);
    assert.match(subPanel.textContent, /Sub model · SWE-2 Flash/);
    assert.match(subPanel.textContent, /27k \/ 262k/);
    const rows = [...pop.querySelectorAll(".usage-row")].map((r) => r.textContent);
    assert.ok(rows.some((r) => r === "Session usage1.9281 ACU"), "the session ACU row is shown. Rows: " + JSON.stringify(rows));
    // The billing block sits in its own section after every context group.
    const session = pop.querySelector(".usage-session");
    assert.ok(session, "the billing figures have their own section");
    assert.ok(session.previousElementSibling?.classList.contains("usage-model"), "the section follows the last context group");
    assert.ok(session.textContent.includes("Session usage"), "the session row lives inside the section");
    // A reported turn cost joins the same section rather than a context group.
    h.post({ type: "usage", cost: { amount: 0.0042 } });
    const sessionWithCost = h.document.querySelector("#usage-popup .usage-session");
    assert.match(sessionWithCost.textContent, /Cost this turn\$0\.004/, "the turn cost shows inside the section. Text: " + sessionWithCost.textContent);
    assert.match(sessionWithCost.textContent, /Session usage1\.9281 ACU/);
    // Refresh progress and failure are quiet notes, and the prior figures stay.
    h.post({ type: "usageState", loading: true });
    assert.match(pop.textContent, /Refreshing usage/);
    h.post({ type: "usageState", loading: false, error: "Could not refresh usage." });
    const after = h.document.querySelector("#usage-popup");
    assert.match(after.textContent, /Couldn't refresh usage\. Showing the last reported figures\./);
    assert.match(after.textContent, /1\.9281 ACU/);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: a billing only record and a reported zero never pretend a window", async () => {
  const h = createHarness();
  try {
    h.post({ type: "ready" });
    h.post({ type: "body", body: "thread" });
    h.post(options("gpt-6-luna-high"));
    h.post({ type: "usage", sessionAcus: 0 });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    assert.equal(meter.classList.contains("hidden"), false, "the meter stays for the ACU row");
    assert.equal(meter.querySelectorAll("circle").length, 1, "the ring is an empty track without an arc");
    assert.equal(meter.getAttribute("aria-label"), "Context not reported. Opens details");
    meter.click();
    const pop = h.document.querySelector("#usage-popup");
    assert.doesNotMatch(pop.textContent, /null|NaN|undefined/);
    assert.match(pop.textContent, /Context window/);
    assert.match(pop.textContent, /Not reported/);
    const rows = [...pop.querySelectorAll(".usage-row")].map((r) => r.textContent);
    assert.ok(rows.some((r) => r === "Session usage0.0000 ACU"), "a valid zero is a real total. Rows: " + JSON.stringify(rows));
    const session = pop.querySelector(".usage-session");
    assert.ok(session, "a billing only record still gets the session section");
    assert.ok(session.textContent.includes("Session usage"), "the section carries the ACU row. Text: " + session.textContent);
    // An unreported total with a real window reads as unknown, never zero.
    h.post({ type: "usage", used: 45000, size: 200000, sessionAcus: null });
    const rows2 = [...h.document.querySelectorAll("#usage-popup .usage-row")].map((r) => r.textContent);
    assert.ok(rows2.some((r) => r === "Session usageNot reported"), "an unreported total stays unknown. Rows: " + JSON.stringify(rows2));
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("context UI: a billing only update after a real Single window keeps the window", async () => {
  const h = createHarness();
  try {
    h.post({ type: "ready" });
    h.post({ type: "body", body: "thread" });
    h.post(options("gpt-6-luna-high"));
    h.post({ type: "usage", used: 45000, size: 200000 });
    await h.settle(10);
    const meter = h.document.querySelector("#usage");
    assert.equal(meter.getAttribute("aria-label"), "Context used: 23%");
    meter.click();
    // A billing-only fragment must not clear the reported window it rides on.
    h.post({ type: "usage", sessionAcus: 1.9281 });
    const pop = h.document.querySelector("#usage-popup");
    assert.match(pop.textContent, /45k \/ 200k/, "the window survives the billing fragment");
    const rows = [...pop.querySelectorAll(".usage-row")].map((r) => r.textContent);
    assert.ok(rows.some((r) => r === "Session usage1.9281 ACU"), "Rows: " + JSON.stringify(rows));
    assert.equal(meter.getAttribute("aria-label"), "Context used: 23%", "the ring keeps the reported percent");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});
