import devinLogoSvg from "../media/devin-logo.svg";

// The working row's mark: each of the logo's seven cogs reveals its own
// original silhouette, clipped to its exact share of the logo, growing from
// the cog centre on a shared 2.667 second cycle and clearing the same way.
// Ported from the approved preview (cog-shape-draw); only the shape mode
// comes across, the flow segments and circle renderer stay behind.
//
// One epoch for the whole module, taken once at import, so a row rebuilt
// mid turn drops into the phase the row it replaced was already in. The
// shimmer keeps its own clock in main.js. This one only ever moves forward.
const epoch = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
const CYCLE_MS = 2667;

// The seven visible cogs in animation order: the two blue cogs, then the two
// light blue cogs, then the lower right green cog, the centre green cog and
// the upper right green cog last.
const COGS = [
  { logo: 0, cx: 12, cy: 3.736 },
  { logo: 0, cx: 4.884, cy: 7.868 },
  { logo: 2, cx: 4.884, cy: 16.132 },
  { logo: 2, cx: 12, cy: 20.264 },
  { logo: 1, cx: 19.116, cy: 16.132 },
  { logo: 1, cx: 12, cy: 12 },
  { logo: 1, cx: 19.116, cy: 7.868 }
];

// Each colour group's cogs are separated by the perpendicular bisectors of
// their own centres, so every fill pixel, including the necks between cogs,
// belongs to exactly one cog's cell and is revealed by that cog's sweep.
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    const ain = da <= 0;
    const bin = db <= 0;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const CELL_RECT = [[-8, -8], [32, -8], [32, 32], [-8, 32]];
function makeCells() {
  return COGS.map((cog) => {
    let poly = CELL_RECT.map((p) => p.slice());
    for (const peer of COGS) {
      if (peer.logo !== cog.logo || peer === cog) continue;
      const nx = peer.cx - cog.cx;
      const ny = peer.cy - cog.cy;
      const rhs = (peer.cx * peer.cx + peer.cy * peer.cy -
        cog.cx * cog.cx - cog.cy * cog.cy) / 2;
      poly = clipHalfPlane(poly, nx, ny, rhs);
    }
    return poly;
  });
}
const cells = makeCells();

function polyD(poly) {
  return "M" + poly.map((p) => p[0].toFixed(4) + " " + p[1].toFixed(4)).join("L") + "Z";
}
function clipD(poly) {
  return "M" + poly.map((p) => p[0].toFixed(3) + " " + p[1].toFixed(3)).join("L") + "Z";
}

// The Copilot phase model: the phase wraps into [0, 1), a global cubic ease
// out head covers the draw span and a global cubic ease in tail covers the
// erase span. Cog k is active while head or tail times seven passes its index.
function copilotTiming(p) {
  const w = p >= 0 && p < 1 ? p : ((p % 1) + 1) % 1;
  const hd = Math.min(Math.max(w / 0.4, 0), 1);
  const tl = Math.min(Math.max((w - 0.55) / 0.4, 0), 1);
  return {
    head: 1 - (1 - hd) * (1 - hd) * (1 - hd),
    tail: tl * tl * tl
  };
}
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

// The bundled asset is the source of truth for the visible paths: parsed
// once, in document order, with the original fills. The title is dropped and
// the clones below are decorative.
let assetLogo = null;
function logoPaths() {
  if (assetLogo === null) {
    const tpl = document.createElement("template");
    tpl.innerHTML = devinLogoSvg;
    const svg = tpl.content.querySelector("svg");
    assetLogo = [...svg.querySelectorAll("path")].map((p) => ({
      d: p.getAttribute("d"),
      fill: p.getAttribute("fill")
    }));
  }
  return assetLogo;
}

let uid = 0;

// One cog silhouette stencil: the colour group's own filled path clipped to
// that cog's exact cell, inside a wrapper that scales about the cog centre.
// Clip and source scale together so other cogs cannot appear.
function shapeStencil(cid, k, logo, cls, fill) {
  const cog = COGS[k];
  return '<g class="shape-st" data-cog="' + k + '" data-c="' + cls + '" style="display:none"' +
    ' transform="translate(' + cog.cx + " " + cog.cy + ") scale(0) translate(" + -cog.cx + " " + -cog.cy + ')">' +
    '<g clip-path="url(#' + cid + "c" + k + ')"><path d="' + logoPaths()[logo].d + '" fill="' + fill + '"/></g></g>';
}

// Three colour masks, one per logo group in document order. Each holds one
// white compound path of fully revealed cell polygons first, then every
// partial white reveal stencil, then every partial black erase stencil, so a
// consumed cog contributes nothing at all. The visible dynamic paths sit on
// top of a static group that carries the assembled mark.
function buildMark() {
  const logo = logoPaths();
  const id = "wm" + (++uid);
  const cid = "wc" + uid;
  let defs = "";
  for (let k = 0; k < COGS.length; k++) {
    defs += '<clipPath id="' + cid + "c" + k + '"><path d="' + clipD(cells[k]) + '"/></clipPath>';
  }
  for (let g = 0; g < 3; g++) {
    const ks = COGS.map((c, k) => (c.logo === g ? k : -1)).filter((k) => k >= 0);
    let inner = '<path class="shape-full" data-logo="' + g + '" d="" fill="#ffffff" fill-rule="nonzero" style="display:none"/>';
    for (const k of ks) inner += shapeStencil(cid, k, g, "w", "#ffffff");
    for (const k of ks) inner += shapeStencil(cid, k, g, "b", "#000000");
    defs += '<mask id="' + id + "g" + g + '" maskUnits="userSpaceOnUse" x="-8" y="-8" width="40" height="40">' + inner + "</mask>";
  }
  const stat = logo.map((l) => '<path d="' + l.d + '" fill="' + l.fill + '"/>').join("");
  const dyn = [0, 1, 2].map((i) =>
    '<path class="working-mark-color" d="' + logo[i].d + '" fill="' + logo[i].fill + '" mask="url(#' + id + "g" + i + ')"/>').join("");
  const tpl = document.createElement("template");
  tpl.innerHTML = '<svg class="working-mark hidden" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    "<defs>" + defs + "</defs>" +
    '<g class="working-mark-static">' + stat + "</g>" +
    '<g class="working-mark-dynamic">' + dyn + "</g></svg>";
  return tpl.content.querySelector("svg");
}

// One controller per working row. The element is built hidden and only
// animates while it is asked to be visible, attached to the document, the
// document itself is visible and the reader has not asked for reduced
// motion. Everything else renders once and stops, so a paused or reduced
// mark still shows the right frame without a loop running behind it.
export function createWorkingMark() {
  const element = buildMark();
  const fulls = [...element.querySelectorAll(".shape-full")]
    .sort((a, b) => +a.dataset.logo - +b.dataset.logo);
  const stencils = [...element.querySelectorAll(".shape-st")]
    .map((el) => ({ el, cog: +el.dataset.cog, c: el.dataset.c }))
    .sort((a, b) => a.cog - b.cog || a.c.localeCompare(b.c));
  const stat = element.querySelector(".working-mark-static");
  const dyn = element.querySelector(".working-mark-dynamic");
  // jsdom has no matchMedia: a missing preference reads as no preference.
  const motion = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  let visible = false;
  let frame = null;
  let disposed = false;

  function reduced() { return motion ? motion.matches : false; }

  function render() {
    const { head, tail } = copilotTiming((performance.now() - epoch) / CYCLE_MS);
    const rm = reduced();
    const dw = COGS.map((_, k) => (rm ? 1 : clamp01(head * 7 - k)));
    const er = COGS.map((_, k) => (rm ? 0 : clamp01(tail * 7 - k)));
    const blank = head <= 0 || tail >= 1;
    const assembled = head >= 1 && tail <= 0;
    stat.style.display = rm || assembled ? "" : "none";
    dyn.style.display = !rm && !assembled && !blank ? "" : "none";
    // Fully revealed cogs contribute their whole cell to one compound white
    // path per colour, computed once and shared by every mask that needs it.
    const fullD = ["", "", ""];
    COGS.forEach((cog, k) => {
      if (dw[k] > er[k] && dw[k] >= 1) fullD[cog.logo] += polyD(cells[k]);
    });
    for (let i = 0; i < 3; i++) {
      const el = fulls[i];
      const d = fullD[i];
      el.setAttribute("d", d);
      el.style.display = d ? "" : "none";
    }
    for (const st of stencils) {
      const k = st.cog;
      const cog = COGS[k];
      const isWhite = st.c === "w";
      const active = dw[k] > er[k];
      const show = active && (isWhite ? dw[k] < 1 : er[k] > 0);
      if (show) {
        st.el.style.display = "";
        st.el.setAttribute("transform",
          "translate(" + cog.cx + " " + cog.cy + ") scale(" + (isWhite ? dw[k] : er[k]) +
          ") translate(" + -cog.cx + " " + -cog.cy + ")");
      } else {
        st.el.style.display = "none";
      }
    }
  }

  function canAnimate() {
    return visible && element.isConnected && !document.hidden && !reduced();
  }

  function tick() {
    frame = null;
    if (disposed) return;
    // A row removed without going through dispose would otherwise keep a
    // loop alive on a detached element, so the first frame notices.
    if (!element.isConnected) { dispose(); return; }
    render();
    if (canAnimate()) frame = requestAnimationFrame(tick);
  }

  function sync() {
    if (disposed) return;
    render();
    if (canAnimate()) {
      if (frame === null) frame = requestAnimationFrame(tick);
    } else if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  }

  const onMotion = () => sync();
  const onVisibility = () => sync();
  if (motion) motion.addEventListener("change", onMotion);
  document.addEventListener("visibilitychange", onVisibility);

  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    element.classList.toggle("hidden", !v);
    sync();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (motion) motion.removeEventListener("change", onMotion);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  return { element, setVisible, dispose };
}
