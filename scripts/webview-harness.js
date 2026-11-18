// Headless harness for the chat webview (webview/main.js, bundled to
// dist/webview.js). It mounts the real panel DOM (media/webview-body.html) in
// jsdom, loads the bundle, and lets you drive the same host->webview messages
// the extension sends, then inspect the resulting DOM.
//
// Use it two ways:
//   - as a module in tests: const { createHarness } = require("./webview-harness")
//   - directly for a quick look:  npm run harness   (or: node scripts/webview-harness.js)
//
// Requires a current bundle, so run `npm run compile` first (the test script
// does this automatically).

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

// `surface` mounts the page as the extension does: "view" is the side panel,
// "editor" is a chat tab, which is one chat with no session list. `bundle`
// overrides the webview bundle path, for focused runs against an older build.
// `beforeLoad` runs against the window after the VSCode mocks are installed
// and before the bundle evaluates, for deterministic clocks and media stubs.
function createHarness({ surface = "view", state: initialState, bundle: bundlePath, beforeLoad } = {}) {
  bundlePath = bundlePath || path.join(ROOT, "dist", "webview.js");
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`${bundlePath} not found. Run npm run compile first.`);
  }
  const body = fs.readFileSync(path.join(ROOT, "media", "webview-body.html"), "utf8");
  const bundle = fs.readFileSync(bundlePath, "utf8");

  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", (...args) => consoleErrors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => consoleErrors.push(String(err)));

  const html =
    `<!DOCTYPE html><html><head></head>` +
    `<body data-logo="logo.svg" data-model-icons="{}" data-surface="${surface}">${body}</body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;

  const posted = [];
  // What the page has recorded for a reload (the chat a tab is holding). An
  // initial value stands in for state saved by an earlier webview instance.
  let state = initialState;
  window.acquireVsCodeApi = () => ({
    // The real postMessage structured-clones to the host, which also strips the
    // jsdom realm's prototypes. JSON round-trip mirrors that so assertions with
    // deepStrictEqual see plain objects/arrays.
    postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),
    getState: () => state,
    setState: (s) => { state = s; }
  });

  if (beforeLoad) beforeLoad(window);

  // The bundle is an IIFE; running it via the window's own Function constructor
  // gives it the jsdom realm as its global (so `document`, `window` and
  // `requestAnimationFrame` resolve to the mounted page).
  new window.Function(bundle).call(window);

  const thread = () => window.document.getElementById("thread");
  const post = (msg) => window.dispatchEvent(new window.MessageEvent("message", { data: msg }));
  // Let queued rAF renders (assistant streaming is throttled) flush.
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (predicate, timeout = 1000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await settle(5);
    }
    return false;
  };

  return {
    window,
    document: window.document,
    dom,
    posted,
    consoleErrors,
    post,
    settle,
    until,
    thread,
    state: () => state,
    reqTexts: () => [...thread().querySelectorAll(".req-text")].map((e) => e.textContent.trim()),
    respTexts: () => [...thread().querySelectorAll(".resp-text")].map((e) => e.textContent.trim()),
    // The webview posts { type: "webviewError" } whenever a message handler throws.
    errors: () => posted.filter((m) => m && m.type === "webviewError"),

    // Drive a session load the way loadSession() does: clear, capabilities,
    // then the recorded turns as user/assistant chunks, then "loaded".
    // `turns` is [{ role: "user"|"assistant", text, mid? }]: `mid` is the stable
    // prompt id a replayed user turn carries in messageId, which is what the
    // checkpoint bindings key on.
    replay(turns) {
      post({ type: "ready" });
      post({ type: "body", body: "thread" });
      post({ type: "clear", loading: true });
      post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
      for (const t of turns) {
        post({ type: t.role === "user" ? "userChunk" : "assistantChunk", text: t.text, messageId: t.mid });
      }
      post({ type: "loaded" });
    }
  };
}

module.exports = { createHarness };

// Quick manual look when run directly.
if (require.main === module) {
  const h = createHarness();
  h.replay([
    { role: "user", text: "first user question about the repo" },
    { role: "assistant", text: "first assistant answer" },
    { role: "user", text: "a second follow up question" },
    { role: "assistant", text: "second assistant answer" }
  ]);
  h.settle().then(() => {
    console.log("requests :", h.reqTexts());
    console.log("responses:", h.respTexts());
    console.log("handler errors:", h.errors().length);
    process.exit(0);
  });
}
