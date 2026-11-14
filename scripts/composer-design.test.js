// Composer design pass: the Cognition symbol as the SWE brand icon, the
// chevronless mode button, and the bundled Devin logo animated in the
// working row. The rework cases at the bottom drive the fit pass through a
// stubbed measurement seam over the real stylesheet's display cascade.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createHarness } = require("./webview-harness");
const fixture = require("./model-fixture");

const ROOT = path.resolve(__dirname, "..");
const MAIN_CSS = fs.readFileSync(path.join(ROOT, "media", "main.css"), "utf8");

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
function pickRole(tray, role) {
  const radio = tray.querySelector(`#roleRadio-${role}`);
  radio.checked = true;
  radio.dispatchEvent(new radio.ownerDocument.defaultView.Event("change", { bubbles: true }));
}
const cognitionMask = (el) => el && /data:image\/svg/.test(el.style.cssText || el.getAttribute("style") || "");

test("the SWE families use the Cognition symbol in the composer, the model list and the Fusion role list", async () => {
  const h = mount({ currentModel: "swe-2-medium" });
  try {
    await h.settle(10);
    // The selected Single model carries the masked symbol on its button.
    const btnIcon = h.document.querySelector("#modelBtn .dd-brand--cognition");
    assert.ok(btnIcon, "the SWE composer icon is missing");
    assert.ok(cognitionMask(btnIcon), "the symbol must be the encoded template data URI");

    // The shared template still carries the mask geometry the brand icons
    // encode, wordmark free.
    const tpl = h.document.getElementById("cognition-mark");
    const tplSvg = tpl && tpl.content ? tpl.content.querySelector("svg") : null;
    assert.ok(tplSvg, "the shared symbol template is missing");
    assert.equal(tplSvg.getAttribute("viewBox"), "0 0 35.25 40.377");
    assert.equal(tplSvg.getAttribute("fill"), "currentColor");
    assert.equal(tplSvg.querySelectorAll("path").length, 3);
    assert.equal(tplSvg.querySelectorAll("title, text").length, 0, "the symbol carries no wordmark");

    // The models page shows it on the SWE rows while other brands keep their
    // own glyphs.
    h.document.getElementById("modelBtn").click();
    await h.settle(10);
    let tray = popup(h);
    assert.ok(tray.querySelector('.dd-item-main[data-id="swe-2"] .dd-brand--cognition'), "the SWE-2 row lost its symbol");
    assert.ok(tray.querySelector('.dd-item-main[data-id="swe-2-flash"] .dd-brand--cognition'), "the SWE-2 Flash row lost its symbol");
    assert.ok(tray.querySelector('.dd-item-main[data-id="claude-opus-5-5"] .codicon-claude'), "Claude lost its own icon");
    assert.ok(tray.querySelector('.dd-item-main[data-id="gpt-6-luna"] .codicon-openai'), "OpenAI lost its own icon");

    // The Fusion card opens the role pages, which list role models with the
    // same brand icons.
    tray.querySelector('.dd-item-main[data-id="fusion"]').click();
    await h.settle(10);
    tray = popup(h);
    pickRole(tray, "sub");
    await h.settle(10);
    assert.ok(tray.querySelector('.fusion-rows .dd-item-main[data-id="swe-2"] .dd-brand--cognition'), "a SWE sub row lost its symbol");
    assert.ok(tray.querySelector('.fusion-rows .dd-item-main[data-id="gpt-6-luna"] .codicon-openai'), "a Luna sub row lost its OpenAI icon");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("the mode button drops its chevron while its menu and selection keep working", async () => {
  const h = mount();
  try {
    await h.settle(10);
    const dd = h.document.querySelector("#mode-dd");
    const btn = dd.querySelector(".dd-btn");
    assert.ok(btn, "the mode button is missing");
    assert.strictEqual(btn.querySelector(".codicon-chevron-down"), null, "the chat mode button still shows a chevron");
    assert.match(btn.textContent, /Code/);

    btn.click();
    await h.settle(10);
    const menu = dd.querySelector(".dd-menu");
    assert.ok(menu && !menu.classList.contains("hidden"), "the mode menu no longer opens");
    const rows = [...menu.querySelectorAll(".dd-item")];
    assert.deepEqual(rows.map((r) => r.textContent.trim()), ["Code", "Ask"]);
    rows[1].click();
    await h.settle(10);
    const last = h.posted.filter((m) => m.type === "setMode").at(-1);
    assert.equal(last.mode, "ask", "selecting a mode stopped posting");
    assert.match(btn.textContent, /Ask/);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("the bundled Devin logo feeds the working row's animated mark", async () => {
  const h = mount();
  try {
    await h.settle(10);
    // The shipped asset is the source of truth: parse it independently and
    // require the cloned mark to match its viewBox, path geometry and fills.
    const asset = fs.readFileSync(path.join(ROOT, "media", "devin-logo.svg"), "utf8");
    const srcDoc = new h.window.DOMParser().parseFromString(asset, "image/svg+xml");
    const src = srcDoc.documentElement;
    assert.equal(src.localName, "svg", "the bundled Devin logo did not parse");
    const srcPaths = [...src.querySelectorAll("path")];
    assert.equal(srcPaths.length, 3);

    h.post({ type: "userMessage", text: "go" });
    h.post({ type: "busy", value: true });
    h.post({ type: "assistantStart" });
    await h.settle(20);
    const row = h.thread().querySelector(".working");
    assert.ok(row, "the working row is missing");
    const mark = row.querySelector(".working-mark");
    assert.ok(mark, "the working mark is missing");
    assert.equal(mark.getAttribute("aria-hidden"), "true");
    assert.equal(mark.getAttribute("focusable"), "false");
    assert.equal(mark.getAttribute("viewBox"), src.getAttribute("viewBox"));
    assert.equal(mark.querySelector("title"), null, "the decorative mark leaks its title");

    // Three coloured overlays keep the asset's own fills under their masks,
    // and the static group mirrors the same geometry for the assembled mark.
    // There is no grey base: the mark is the cog silhouette itself.
    const dynGroup = mark.querySelector(".working-mark-dynamic");
    const colored = [...mark.querySelectorAll(".working-mark-color")];
    const stat = [...mark.querySelectorAll(".working-mark-static > path")];
    assert.equal(colored.length, 3, "the mark must keep the asset's three coloured paths");
    assert.equal(stat.length, 3, "the static group must mirror the same three paths");
    assert.equal(mark.querySelectorAll(".working-mark-base").length, 0, "the grey base is gone");
    for (const p of colored) assert.equal(p.parentElement, dynGroup, "a coloured path left the dynamic group");
    for (let i = 0; i < 3; i++) {
      assert.equal(colored[i].getAttribute("d"), srcPaths[i].getAttribute("d"), `coloured path ${i} geometry drifted`);
      assert.equal(colored[i].getAttribute("fill"), srcPaths[i].getAttribute("fill"), `coloured path ${i} fill drifted`);
      assert.equal(stat[i].getAttribute("d"), srcPaths[i].getAttribute("d"), `static path ${i} geometry drifted`);
      assert.equal(stat[i].getAttribute("fill"), srcPaths[i].getAttribute("fill"), `static path ${i} fill drifted`);
      assert.ok(colored[i].getAttribute("mask"), `coloured path ${i} lost its mask`);
      for (const attr of ["pathLength", "stroke", "stroke-width", "stroke-dasharray"]) {
        assert.equal(colored[i].getAttribute(attr), null, `coloured path ${i} carries ${attr}`);
        assert.equal(stat[i].getAttribute(attr), null, `static path ${i} carries ${attr}`);
      }
    }

    const label = row.querySelector(".working-label.dv-shimmer");
    assert.ok(label, "the working word lost its shimmer span");
    assert.strictEqual(mark.nextElementSibling, label, "the mark must sit left of the word");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

// --- Fit seam ---------------------------------------------------------------
// jsdom reports no layout, so the composer fit is exercised through stubbed
// dimension getters. Display decisions still come from the real stylesheet:
// the whole main.css is injected and getComputedStyle resolves the cmp-*/
// .hidden cascade exactly as the browser would. Only the geometry is fake.

const CHAR_W = 7; // one average glyph at the composer font size
const CONTROL_W = { attach: 22, send: 30, "send-more": 16, stop: 30 };
const LEAF_W = { "picker-div": 5 };
const PCT_TRAIL = 4; // trailing allowance inside a percentage's content width

// Mirrors composerHidden: the .hidden marker counts directly because jsdom's
// cascade lets later display rules outrank its !important, exactly the gap
// the production check papers over.
function shown(win, el) {
  if (el.classList && el.classList.contains("hidden")) return false;
  return win.getComputedStyle(el).display !== "none";
}

function clusterW(win, cluster) {
  if (!shown(win, cluster)) return 0;
  let w = 0;
  for (const child of cluster.children) {
    const cw = controlW(win, child);
    if (!cw) continue;
    if (w) w += 4; // the cluster's 4px flex gap
    w += cw;
  }
  return w;
}

function controlW(win, el) {
  if (!shown(win, el)) return 0;
  if (el.classList.contains("dd-menu")) return 0; // overlay, out of flow
  if (el.id === "usage") return usageW(win, el);
  if (el.classList.contains("dd-btn")) return btnW(win, el);
  if (el.classList.contains("send-btn") || el.classList.contains("tool-ctl")) return CONTROL_W[el.id] || 24;
  if (el.children.length === 0) return LEAF_W[el.id] || LEAF_W[el.className] || 8;
  return clusterW(win, el);
}

function btnW(win, el) {
  let w = 12; // .dd-btn horizontal padding
  const icon = el.querySelector(".dd-icon");
  if (icon && shown(win, icon)) w += 14;
  const label = el.querySelector(".dd-label");
  if (label && shown(win, label)) w += label.textContent.length * CHAR_W + 4;
  return Math.min(w, 150); // .dd-btn max-width
}

// The percentages sit at zero width at rest, so the ring's own width only
// covers its rings, padding and the fixed gaps. Each percentage still reports
// its full text width through scrollWidth while its border box stays
// collapsed, which is the pair of values the fit reserves arithmetically.
function usageW(win, el) {
  const groups = [...el.querySelectorAll(".usage-role-group")];
  const rings = groups.length || 1;
  const pcts = el.querySelectorAll(".usage-pct").length;
  return 8 + rings * 16 + Math.max(0, rings - 1) * 3 + pcts * 3;
}

// jsdom reports no layout, so each percentage gets the two values the fit
// reads directly: scrollWidth carries the full text width while the border
// box stays at its collapsed rest width. A hidden ring reports zero, exactly
// like a display:none element in a browser.
function stubPct(win, pct) {
  const ring = pct.closest("#usage");
  Object.defineProperty(pct, "scrollWidth", {
    get: () => (ring && shown(win, ring) ? pct.textContent.length * CHAR_W + PCT_TRAIL : 0),
    configurable: true
  });
  Object.defineProperty(pct, "getBoundingClientRect", {
    value: () => ({ width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }),
    configurable: true
  });
}

function installFitSeam(h) {
  const win = h.window;
  const doc = h.document;
  const style = doc.createElement("style");
  style.textContent = MAIN_CSS;
  doc.head.appendChild(style);
  const toolbar = doc.getElementById("toolbar");
  const left = toolbar.querySelector(".toolbar-left");
  const right = toolbar.querySelector(".toolbar-right");
  let width = 1200;
  Object.defineProperty(toolbar, "clientWidth", { get: () => width, configurable: true });
  const clusterRect = (cluster) => () => {
    const w = clusterW(win, cluster);
    return { width: w, height: 0, top: 0, right: w, bottom: 0, left: 0 };
  };
  Object.defineProperty(left, "getBoundingClientRect", { value: clusterRect(left), configurable: true });
  Object.defineProperty(right, "getBoundingClientRect", { value: clusterRect(right), configurable: true });
  // Usage must be painted before the seam goes in so its percentages exist
  // to stub; tests that need the ring post the usage message first.
  for (const pct of right.querySelectorAll(".usage-pct")) stubPct(win, pct);
  const gap = () => parseFloat(win.getComputedStyle(toolbar).columnGap) || 0;
  // Mirrors fits(): the right border box at rest plus each percentage's
  // hidden content reserve, with no measurement class involved.
  const rightNeed = () => {
    let w = clusterW(win, right);
    for (const pct of right.querySelectorAll(".usage-pct")) {
      w += Math.max(0, pct.scrollWidth - pct.getBoundingClientRect().width);
    }
    return w;
  };
  return {
    setWidth(w) { width = w; },
    // The need fits() sees with every control at natural size.
    need() { return clusterW(win, left) + rightNeed() + gap(); },
    // What remains once every left control is gone.
    needRight() { return rightNeed() + gap(); },
    refit(mode) { h.post({ type: "mode", mode }); }
  };
}

const LONG_FUSION = "fusion-claude-opus-5-5-max-fast-sidekick-gpt-6-luna-high-priority";
const USAGE_CONTEXTS = [
  { modelId: "claude-opus-5-5-max", totalTokens: 184000, maxTokens: 1000000 },
  { modelId: "gpt-6-luna-high", totalTokens: 96000, maxTokens: 200000 }
];
const MODE_ITEMS = [
  { value: "accept-edits", name: "Code", icon: "codicon-code" },
  { value: "ask", name: "Ask", icon: "codicon-comment-discussion" },
  { value: "plan", name: "Plan", icon: "codicon-checklist" },
  { value: "bypass", name: "Bypass", icon: "codicon-debug-step-over" }
];

test("a longer mode label refits the composer without a width change", async () => {
  const h = mount({
    currentModel: LONG_FUSION,
    modes: [...MODE_ITEMS, { value: "deep", name: "Deep review mode", icon: "codicon-checklist" }]
  });
  try {
    await h.settle(10);
    const seam = installFitSeam(h);
    const win = h.window;
    const doc = h.document;
    const modeDD = doc.getElementById("mode-dd");
    const btn = modeDD.querySelector(".dd-btn");
    const label = modeDD.querySelector(".dd-label");
    const labelShown = () => win.getComputedStyle(label).display !== "none";

    seam.setWidth(1400);
    seam.refit("accept-edits");
    await h.settle(5);
    // The narrowest width where the resting Code label still fits whole.
    seam.setWidth(seam.need());
    seam.refit("accept-edits");
    await h.settle(5);
    assert.equal(labelShown(), true, "precondition: the Code label fits at this width");

    // A real menu pick writes the longer label, then must refit at once.
    btn.click();
    await h.settle(5);
    const row = [...modeDD.querySelectorAll(".dd-item")].find((r) => r.textContent.includes("Deep review mode"));
    assert.ok(row, "the long mode row is missing");
    row.click();
    await h.settle(10);
    assert.equal(h.posted.filter((m) => m.type === "setMode").at(-1).mode, "deep");
    assert.equal(labelShown(), false, "the longer label left the mode word expanded at the same width");

    // The host echo of the same change refits the same way.
    seam.refit("accept-edits");
    await h.settle(5);
    assert.equal(labelShown(), true, "the shorter label did not come back");
    seam.refit("deep");
    await h.settle(5);
    assert.equal(labelShown(), false, "the host mode update left stale fit classes");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("mode menu and model picker close when their anchors collapse and stay closed on restore", async () => {
  const h = mount({ currentModel: LONG_FUSION, modes: MODE_ITEMS });
  try {
    await h.settle(10);
    const seam = installFitSeam(h);
    const win = h.window;
    const doc = h.document;
    const modeDD = doc.getElementById("mode-dd");
    const modeBtn = modeDD.querySelector(".dd-btn");
    const modeMenu = modeDD.querySelector(".dd-menu");
    const group = doc.getElementById("model-picker-group");
    const thinkingDD = doc.getElementById("thinking-dd");
    const modelBtn = doc.getElementById("modelBtn");
    const effortBtn = doc.getElementById("effortBtn");
    const popup = doc.getElementById("model-picker-popup");
    const input = doc.getElementById("input");
    const isShown = (el) => shown(win, el);
    const mode = "accept-edits";

    seam.setWidth(1400);
    seam.refit(mode);
    await h.settle(5);

    // --- Mode menu ---------------------------------------------------------
    modeBtn.focus();
    modeBtn.click();
    await h.settle(5);
    assert.equal(modeMenu.classList.contains("hidden"), false, "the mode menu did not open");
    assert.equal(modeBtn.getAttribute("aria-expanded"), "true");
    let wHidden = null;
    for (let w = 1396; w >= 40; w -= 4) {
      seam.setWidth(w);
      seam.refit(mode);
      await h.settle(2);
      if (!isShown(modeDD)) { wHidden = w; break; }
    }
    assert.ok(wHidden !== null, "the mode dropdown never collapsed");
    assert.equal(modeMenu.classList.contains("hidden"), true, "the mode menu outlived its anchor");
    assert.equal(modeBtn.getAttribute("aria-expanded"), "false", "aria-expanded stayed true");
    assert.equal(doc.activeElement, input, "focus did not land on the composer input");
    seam.setWidth(1400);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(modeMenu.classList.contains("hidden"), true, "the mode menu reopened on restore");
    assert.equal(modeBtn.getAttribute("aria-expanded"), "false");

    // --- Model picker via the model button ---------------------------------
    modelBtn.click();
    await h.settle(10);
    assert.equal(popup.classList.contains("hidden"), false, "the picker did not open");
    assert.ok(popup.contains(doc.activeElement), "precondition: focus sits inside the popup");
    let gHidden = null;
    for (let w = 1396; w >= 40; w -= 4) {
      seam.setWidth(w);
      seam.refit(mode);
      await h.settle(2);
      if (!isShown(group)) { gHidden = w; break; }
    }
    assert.ok(gHidden !== null, "the picker group never collapsed");
    assert.equal(popup.classList.contains("hidden"), true, "the picker outlived its anchor");
    assert.equal(modelBtn.getAttribute("aria-expanded"), "false");
    assert.equal(effortBtn.getAttribute("aria-expanded"), "false");
    assert.equal(doc.activeElement, input, "focus did not land on the composer input");
    seam.setWidth(1400);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(popup.classList.contains("hidden"), true, "the picker reopened on restore");

    // --- Picker via the effort button: its own section hides first ---------
    effortBtn.click();
    await h.settle(10);
    assert.equal(popup.classList.contains("hidden"), false, "the effort picker did not open");
    let band = null;
    for (let w = 1396; w >= 40; w -= 4) {
      seam.setWidth(w);
      seam.refit(mode);
      await h.settle(2);
      if (!isShown(thinkingDD) && isShown(group)) { band = w; break; }
    }
    assert.ok(band !== null, "no width hides the effort section while the group stays");
    assert.equal(isShown(modelBtn), true, "precondition: the model half is still visible");
    assert.equal(popup.classList.contains("hidden"), true, "an effort anchored picker outlived its section");
    assert.equal(effortBtn.getAttribute("aria-expanded"), "false");
    assert.equal(modelBtn.getAttribute("aria-expanded"), "false");
    assert.equal(doc.activeElement, input);
    seam.setWidth(1400);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(popup.classList.contains("hidden"), true, "the effort picker reopened on restore");
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});

test("usage reserves its expanded width at rest and outlives the left controls", async () => {
  const h = mount({ currentModel: LONG_FUSION, modes: MODE_ITEMS });
  try {
    await h.settle(10);
    h.post({ type: "sessionReady", sessionId: "s-1" });
    h.post({ type: "usage", contexts: USAGE_CONTEXTS });
    await h.settle(10);
    const seam = installFitSeam(h);
    const win = h.window;
    const doc = h.document;
    const modeDD = doc.getElementById("mode-dd");
    const attach = doc.getElementById("attach");
    const group = doc.getElementById("model-picker-group");
    const usage = doc.getElementById("usage");
    const send = doc.getElementById("send");
    const isShown = (el) => shown(win, el);
    const mode = "accept-edits";

    seam.setWidth(1400);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(isShown(usage), true, "precondition: usage is painted");

    // Once every optional left control is gone the usage ring keeps its
    // place: it is the last control the fit drops, measured at full width.
    seam.setWidth(seam.needRight() + 10);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(isShown(modeDD), false, "the mode control should be collapsed here");
    assert.equal(isShown(attach), false, "the attach control should be collapsed here");
    assert.equal(isShown(group), false, "the picker group should be collapsed here");
    assert.equal(isShown(usage), true, "usage hid while it still fit at full width");
    assert.equal(isShown(send), true, "the send control is never a fit casualty");

    // Just under that the expanded percentages no longer fit either, so the
    // ring hides at rest instead of flickering on hover.
    seam.setWidth(seam.needRight() - 1);
    seam.refit(mode);
    await h.settle(5);
    assert.equal(isShown(usage), false, "usage stayed at a width its expanded form cannot fit");
    assert.equal(isShown(send), true);
    assert.equal(h.errors().length, 0);
  } finally {
    h.dom.window.close();
  }
});
