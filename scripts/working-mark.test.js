// The working row's animated mark: the approved cog silhouette ported into
// webview/workingMark.js. These tests drive the real bundle through the
// jsdom harness with a deterministic clock, a manual rAF queue and fake
// media queries installed before the bundle evaluates, so the module epoch
// is zero and every phase lands exactly where the frozen preview put it.

const { after, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHarness: mountHarness } = require("./webview-harness");

const ROOT = path.resolve(__dirname, "..");
const CYCLE_MS = 2667;
// Frozen approved phases from working-mark-preview/cog-shape-evidence/
// observations-shape.json, plus the hold and rest states of the same clock.
const PHASE = {
  partialK0: 0.009760017460977056,
  partialK5: 0.16063660776456984,
  eraseK0: 0.7159653066732488,
  consumedK0: 0.55 + 0.4 * Math.cbrt(1.5 / 7),
  hold: 0.475,
  rest: 0.975
};
// Cog index to logo group, in the asset's document order.
const COG_LOGO = [0, 0, 2, 2, 1, 1, 1];
const COG_CENTER = [
  [12, 3.736], [4.884, 7.868], [4.884, 16.132], [12, 20.264],
  [19.116, 16.132], [12, 12], [19.116, 7.868]
];

const harnesses = [];
after(() => harnesses.forEach(({ window }) => window.close()));

// A controllable stand-in for the three environment seams the mark reads:
// the performance clock (epoch zero), requestAnimationFrame (manual queue)
// and the reduced motion / document visibility preferences.
function rig() {
  const clock = {
    t: 0,
    pending: new Map(),
    nextId: 1,
    scheduled: 0,
    install(win) {
      Object.defineProperty(win.performance, "now", { value: () => clock.t, configurable: true });
      win.requestAnimationFrame = (cb) => {
        clock.scheduled++;
        const id = clock.nextId++;
        clock.pending.set(id, cb);
        return id;
      };
      win.cancelAnimationFrame = (id) => clock.pending.delete(id);
    },
    set(t) { clock.t = t; },
    // One pump is one display frame: everything queued now runs, anything it
    // schedules waits for the next pump.
    pump(frames = 1) {
      for (let i = 0; i < frames; i++) {
        const cbs = [...clock.pending.values()];
        clock.pending.clear();
        for (const cb of cbs) cb(clock.t);
      }
    }
  };
  const motion = {
    mql: null,
    listeners: new Set(),
    install(win) {
      motion.mql = {
        matches: false,
        addEventListener: (ev, cb) => { if (ev === "change") motion.listeners.add(cb); },
        removeEventListener: (ev, cb) => motion.listeners.delete(cb)
      };
      win.matchMedia = (q) => (q === "(prefers-reduced-motion: reduce)" ? motion.mql : {
        matches: false, addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}
      });
    },
    set(v) {
      motion.mql.matches = v;
      for (const cb of [...motion.listeners]) cb({ matches: v });
    }
  };
  const hidden = {
    value: false,
    install(win) {
      Object.defineProperty(win.document, "hidden", { get: () => hidden.value, configurable: true });
    },
    set(v, win) {
      hidden.value = v;
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    }
  };
  return { clock, motion, hidden };
}

function createHarness(r) {
  const h = mountHarness({
    // Test-only seam for the negative proof: point this at a saved older
    // bundle and the same cases must fail against it.
    bundle: process.env.WORKING_MARK_BUNDLE || undefined,
    beforeLoad(win) {
      r.clock.install(win);
      r.motion.install(win);
      r.hidden.install(win);
    }
  });
  harnesses.push(h);
  return h;
}

function assetPaths(h) {
  const asset = fs.readFileSync(path.join(ROOT, "media", "devin-logo.svg"), "utf8");
  const doc = new h.window.DOMParser().parseFromString(asset, "image/svg+xml");
  return [...doc.querySelectorAll("path")].map((p) => ({
    d: p.getAttribute("d"), fill: p.getAttribute("fill")
  }));
}

// Drive the host messages that open a working turn, with the clock parked
// at the wanted phase so the mark's first render already lands there.
function showMark(h, r, phase) {
  r.clock.set(phase * CYCLE_MS);
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "clear" });
  h.post({ type: "userMessage", text: "go" });
  h.post({ type: "busy", value: true });
  h.post({ type: "assistantStart" });
  r.clock.pump(2);
  return h.thread().querySelector(".working .working-mark");
}

function hideMark(h) {
  h.post({ type: "assistantEnd" });
  h.post({ type: "busy", value: false });
}

function markOf(h) {
  return h.thread().querySelector(".working .working-mark");
}

function stencils(mark) {
  return [...mark.querySelectorAll(".shape-st")].map((el) => {
    const m = /scale\(([^)]+)\)/.exec(el.getAttribute("transform") || "");
    const inner = el.firstElementChild;
    return {
      cog: +el.dataset.cog,
      c: el.dataset.c,
      shown: el.style.display !== "none",
      scale: m ? parseFloat(m[1]) : null,
      transform: el.getAttribute("transform"),
      clip: inner.getAttribute("clip-path"),
      d: inner.firstElementChild.getAttribute("d"),
      fill: inner.firstElementChild.getAttribute("fill")
    };
  });
}

function fulls(mark) {
  return [...mark.querySelectorAll(".shape-full")].map((el) => ({
    logo: +el.dataset.logo,
    shown: el.style.display !== "none",
    subpaths: (el.getAttribute("d").match(/M/g) || []).length
  }));
}

const shownStencils = (mark) => stencils(mark).filter((s) => s.shown);
const groupDisplay = (mark, cls) => mark.querySelector(cls).style.display;

describe("working mark", () => {
  test("working mark draws each cog silhouette from the bundled asset under its own cell mask", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.hold);
    assert.ok(mark, "the working row has no mark");
    assert.ok(mark.classList.contains("working-mark"));
    assert.ok(!mark.classList.contains("hidden"), "the mark is hidden while the agent works");
    assert.equal(mark.localName, "svg");
    assert.equal(mark.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(mark.getAttribute("aria-hidden"), "true");
    assert.equal(mark.getAttribute("focusable"), "false");
    assert.equal(mark.querySelector("title"), null, "the decorative mark leaks a title");

    const src = assetPaths(h);
    assert.equal(src.length, 3);
    const colored = [...mark.querySelectorAll(".working-mark-dynamic .working-mark-color")];
    const stat = [...mark.querySelectorAll(".working-mark-static > path")];
    assert.equal(colored.length, 3, "the dynamic group lost a coloured path");
    assert.equal(stat.length, 3, "the static group lost a coloured path");
    for (let i = 0; i < 3; i++) {
      assert.equal(colored[i].getAttribute("d"), src[i].d, `dynamic path ${i} geometry drifted`);
      assert.equal(colored[i].getAttribute("fill"), src[i].fill, `dynamic path ${i} fill drifted`);
      assert.equal(stat[i].getAttribute("d"), src[i].d, `static path ${i} geometry drifted`);
      assert.equal(stat[i].getAttribute("fill"), src[i].fill, `static path ${i} fill drifted`);
      assert.ok(colored[i].getAttribute("mask"), `dynamic path ${i} lost its mask`);
    }

    // No grey base, no stroked or normalized copies anywhere in the mark.
    assert.equal(mark.querySelectorAll(".working-mark-base").length, 0, "a grey base came back");
    for (const p of mark.querySelectorAll("path")) {
      for (const attr of ["pathLength", "stroke", "stroke-width", "stroke-dasharray"]) {
        assert.equal(p.getAttribute(attr), null, `a mark path carries ${attr}`);
      }
      assert.notEqual(p.getAttribute("fill"), "currentColor", "a mark path went grey");
    }

    // Seven cell clips and three colour masks, every id unique, every mask
    // reference resolving to a real mask.
    const clips = [...mark.querySelectorAll("clipPath")];
    const masks = [...mark.querySelectorAll("mask")];
    assert.equal(clips.length, 7, "the seven cog cells lost a clip");
    assert.equal(masks.length, 3, "the three colour masks are missing");
    const ids = [...mark.querySelectorAll("[id]")].map((el) => el.id);
    assert.equal(new Set(ids).size, ids.length, "mask or clip ids collide inside the mark");
    const idSet = new Set(ids);
    for (const p of colored) {
      const ref = /url\(#([^)]+)\)/.exec(p.getAttribute("mask"));
      assert.ok(ref && idSet.has(ref[1]), `dynamic path mask ${p.getAttribute("mask")} resolves nowhere`);
    }

    // Every stencil clips the original path of its own colour group to its
    // own cog's cell, white reveals before black cutouts inside each mask.
    const sts = stencils(mark);
    assert.equal(sts.length, 14, "the seven cogs lost a reveal or erase stencil");
    for (const s of sts) {
      const logo = COG_LOGO[s.cog];
      assert.equal(s.d, src[logo].d, `stencil ${s.cog}${s.c} carries the wrong colour's geometry`);
      assert.equal(s.fill, s.c === "w" ? "#ffffff" : "#000000");
      assert.ok(s.clip.endsWith("c" + s.cog + ")"), `stencil ${s.cog}${s.c} clips the wrong cell`);
      const clipId = /url\(#([^)]+)\)/.exec(s.clip)[1];
      assert.ok(idSet.has(clipId), `stencil ${s.cog}${s.c} clip ${clipId} is missing`);
    }
    for (const m of masks) {
      const order = [...m.children].map((el) => el.classList.contains("shape-full") ? "f" : el.dataset.c);
      assert.ok(order.lastIndexOf("w") < order.indexOf("b"),
        "a mask paints black cutouts before white reveals");
    }

    // At the assembled hold the static faces carry the mark and the dynamic
    // group is out of the picture.
    assert.equal(groupDisplay(mark, ".working-mark-static"), "", "the assembled mark lost its static faces");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "none", "the dynamic group should rest at hold");

    // A rebuilt row gets fresh mask and clip ids, so two marks can never
    // cross reference each other's defs.
    hideMark(h);
    const mark2 = showMark(h, r, PHASE.hold);
    const ids2 = new Set([...mark2.querySelectorAll("[id]")].map((el) => el.id));
    for (const id of ids) assert.ok(!ids2.has(id), `rebuilt mark reused id ${id}`);
    assert.notEqual(mark2, mark, "the rebuilt row kept the old mark element");
  });

  test("working mark reveals the first cog halfway at the frozen partial phase", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK0);
    const src = assetPaths(h);
    const shown = shownStencils(mark);
    assert.equal(shown.length, 1, "only the first cog should be revealing");
    const s = shown[0];
    assert.equal(s.cog, 0);
    assert.equal(s.c, "w", "the reveal is the white stencil");
    assert.ok(Math.abs(s.scale - 0.5) < 1e-9, `first cog scale ${s.scale} is not one half`);
    const [cx, cy] = COG_CENTER[0];
    assert.equal(s.transform,
      `translate(${cx} ${cy}) scale(${s.scale}) translate(${-cx} ${-cy})`,
      "the stencil does not scale about the cog centre");
    assert.equal(s.d, src[0].d, "the first cog carries the wrong silhouette");
    assert.deepEqual(fulls(mark).map((f) => f.shown), [false, false, false],
      "no cog is fully revealed yet, so no cell polygon may show");
    assert.equal(groupDisplay(mark, ".working-mark-static"), "none");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "");
  });

  test("working mark reveals the middle cog halfway with earlier cells folded into the full paths", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK5);
    const shown = shownStencils(mark);
    assert.equal(shown.length, 1, "only the middle cog should still be revealing");
    assert.equal(shown[0].cog, 5);
    assert.equal(shown[0].c, "w");
    assert.ok(Math.abs(shown[0].scale - 0.5) < 1e-9, `middle cog scale ${shown[0].scale} is not one half`);
    // Cogs 0 to 4 are done: their cells sit in the shared white compound
    // paths, two for blue, one for green (cog 5 is partial, cog 6 empty) and
    // two for light blue.
    assert.deepEqual(fulls(mark).map((f) => [f.shown, f.subpaths]),
      [[true, 2], [true, 1], [true, 2]],
      "the full cell paths do not match the revealed cogs");
    const future = stencils(mark).filter((s) => s.cog === 6);
    assert.ok(future.every((s) => !s.shown), "the last cog must not show before its turn");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "");
  });

  test("working mark erases the first cog halfway as a shape matched hole", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.eraseK0);
    const shown = shownStencils(mark);
    assert.equal(shown.length, 1, "only the first cog should be erasing");
    assert.equal(shown[0].cog, 0);
    assert.equal(shown[0].c, "b", "the erase is the black cutout stencil");
    assert.ok(Math.abs(shown[0].scale - 0.5) < 1e-9, `erase scale ${shown[0].scale} is not one half`);
    // Every cog is still drawn, so all seven cells sit in the full paths and
    // the erasing cog's cell stays: two blue, three green, two light blue.
    assert.deepEqual(fulls(mark).map((f) => [f.shown, f.subpaths]),
      [[true, 2], [true, 3], [true, 2]],
      "the full cell paths lost a drawn cog");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "");
  });

  test("working mark drops a fully consumed cog with no residue", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.consumedK0);
    const sts = stencils(mark);
    const cog0 = sts.filter((s) => s.cog === 0);
    assert.ok(cog0.every((s) => !s.shown),
      "a consumed cog must hide both its reveal and its cutout, not just fade them");
    const shown = shownStencils(mark);
    assert.equal(shown.length, 1, "only the second cog should still be erasing");
    assert.equal(shown[0].cog, 1);
    assert.equal(shown[0].c, "b");
    assert.ok(Math.abs(shown[0].scale - 0.5) < 1e-9);
    // The consumed cog also leaves the shared cell path, so blue keeps only
    // the second cog's cell while green and light blue stay whole.
    assert.deepEqual(fulls(mark).map((f) => [f.shown, f.subpaths]),
      [[true, 1], [true, 3], [true, 2]],
      "the consumed cog's cell is still in the full path");
  });

  test("working mark is empty at rest, static at hold, and animates between", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, 0);
    for (const phase of [0, PHASE.rest]) {
      r.clock.set(phase * CYCLE_MS);
      r.clock.pump(1);
      assert.equal(groupDisplay(mark, ".working-mark-static"), "none", `static faces at phase ${phase}`);
      assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "none", `dynamic faces at phase ${phase}`);
      assert.equal(shownStencils(mark).length, 0, `stencils at phase ${phase}`);
      assert.ok(fulls(mark).every((f) => !f.shown), `cell paths at phase ${phase}`);
    }
    r.clock.set(PHASE.hold * CYCLE_MS);
    r.clock.pump(1);
    assert.equal(groupDisplay(mark, ".working-mark-static"), "", "the assembled mark lost its static faces");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "none");
    // And it is still animating, not frozen: mid draw the dynamic group is up.
    r.clock.set(PHASE.partialK5 * CYCLE_MS);
    r.clock.pump(1);
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "");
    assert.equal(shownStencils(mark).length, 1);
  });

  test("working mark shares one epoch across row rebuilds", async () => {
    const r = rig();
    const h = createHarness(r);
    const phase = 0.3;
    const first = showMark(h, r, phase);
    const state1 = JSON.stringify({
      fulls: fulls(first),
      stencils: stencils(first).map(({ cog, c, shown, scale }) => ({ cog, c, shown, scale }))
    });
    hideMark(h);
    // One full cycle later the phase is identical, so a controller built now
    // must render exactly what the first one did, not restart from zero.
    r.clock.set((phase + 1) * CYCLE_MS);
    const second = showMark(h, r, phase + 1);
    const state2 = JSON.stringify({
      fulls: fulls(second),
      stencils: stencils(second).map(({ cog, c, shown, scale }) => ({ cog, c, shown, scale }))
    });
    assert.equal(state2, state1, "a rebuilt row restarted the animation clock");
  });

  test("working mark holds the assembled logo under reduced motion and resumes when it lifts", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK0);
    assert.equal(shownStencils(mark).length, 1, "the mark should be animating");
    r.motion.set(true);
    assert.equal(groupDisplay(mark, ".working-mark-static"), "", "reduced motion lost the assembled logo");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "none", "reduced motion kept the dynamic group");
    r.clock.pump(3);
    const settled = r.clock.scheduled;
    r.clock.pump(3);
    assert.equal(r.clock.scheduled, settled, "a reduced mark still schedules frames");
    r.motion.set(false);
    r.clock.pump(1);
    assert.equal(shownStencils(mark).length, 1, "the mark did not resume animating");
    assert.equal(markOf(h), mark, "the row lost its mark across the toggle");
    hideMark(h);
    assert.equal(r.motion.listeners.size, 0, "dispose left a reduced motion listener behind");
  });

  test("working mark pauses while the document is hidden and catches up on return", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK0);
    assert.equal(shownStencils(mark).length, 1);
    r.hidden.set(true, h.window);
    r.clock.pump(3);
    const settled = r.clock.scheduled;
    r.clock.pump(3);
    assert.equal(r.clock.scheduled, settled, "a hidden document still schedules frames");
    // Time keeps moving on the shared epoch while paused.
    r.clock.set(PHASE.partialK5 * CYCLE_MS);
    r.clock.pump(1);
    assert.equal(shownStencils(mark).length, 1, "the paused mark should not animate");
    r.hidden.set(false, h.window);
    r.clock.pump(1);
    assert.equal(shownStencils(mark)[0].cog, 5, "the mark did not catch up to the shared phase");
    assert.equal(groupDisplay(mark, ".working-mark-dynamic"), "");
  });

  test("working mark hides and resumes its artwork while a confirmation is pending", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK0);
    assert.ok(!mark.classList.contains("hidden"), "the mark should show while the agent works");
    h.post({ type: "permission", requestId: "p1", title: "Devin wants to run a command",
      options: [{ optionId: "allow", name: "Allow", kind: "allow" }] });
    assert.ok(mark.classList.contains("hidden"), "waiting on the user must hide the mark");
    r.clock.pump(4);
    const settled = r.clock.scheduled;
    r.clock.pump(3);
    assert.equal(r.clock.scheduled, settled, "a hidden mark still schedules frames");
    h.post({ type: "cancelPrompts" });
    assert.ok(!mark.classList.contains("hidden"), "the mark did not come back after the answer");
    r.clock.pump(1);
    assert.equal(shownStencils(mark).length, 1, "the mark did not resume after the answer");
  });

  test("working mark disposes with the row on every teardown path", async () => {
    const scenarios = [
      ["assistant end", (h) => { hideMark(h); }],
      ["clear", (h) => h.post({ type: "clear" })],
      ["body list", (h) => h.post({ type: "body", body: "list" })],
      ["session ended", (h) => h.post({ type: "sessionEnded" })]
    ];
    for (const [name, teardown] of scenarios) {
      const r = rig();
      const h = createHarness(r);
      const mark = showMark(h, r, PHASE.partialK0);
      assert.ok(mark, `${name}: no mark to tear down`);
      teardown(h);
      assert.equal(h.thread().querySelector(".working"), null, `${name}: the working row survived`);
      assert.ok(!mark.isConnected, `${name}: the mark element is still attached`);
      r.clock.pump(8); // flush the scroll pins and any queued stragglers
      const settled = r.clock.scheduled;
      r.clock.pump(4);
      assert.equal(r.clock.scheduled, settled, `${name}: the dead mark still schedules frames`);
      assert.equal(r.motion.listeners.size, 0, `${name}: a listener outlived the mark`);
    }
  });

  test("working mark cannot restart from a stale queued frame", async () => {
    const r = rig();
    const h = createHarness(r);
    const mark = showMark(h, r, PHASE.partialK0);
    const row = mark.closest(".working");
    // The row can leave the document without hideWorking running (a retained
    // transcript swap, a stray sweep): the next frame must notice and stop,
    // not keep animating a detached element.
    row.remove();
    r.clock.pump(1);
    r.clock.pump(6); // flush whatever the orphan frame and scroll pins left
    const settled = r.clock.scheduled;
    r.clock.pump(4);
    assert.equal(r.clock.scheduled, settled, "an orphaned mark keeps scheduling frames");
    assert.equal(r.motion.listeners.size, 0, "the orphaned mark kept its media listener");
    // And a rebuild still works afterwards on the same shared epoch.
    const again = showMark(h, r, PHASE.partialK5);
    assert.equal(shownStencils(again)[0].cog, 5, "the mark did not rebuild after the orphan");
  });
});
