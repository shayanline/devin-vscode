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

function createHarness() {
  const bundlePath = path.join(ROOT, "dist", "webview.js");
  if (!fs.existsSync(bundlePath)) {
    throw new Error("dist/webview.js not found. Run `npm run compile` first.");
  }
  const body = fs.readFileSync(path.join(ROOT, "media", "webview-body.html"), "utf8");
  const bundle = fs.readFileSync(bundlePath, "utf8");

  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("error", (...args) => consoleErrors.push(args.join(" ")));
  virtualConsole.on("jsdomError", (err) => consoleErrors.push(String(err)));

  const html =
    `<!DOCTYPE html><html><head></head>` +
    `<body data-logo="logo.svg" data-model-icons="{}">${body}</body></html>`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;

  const posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    getState: () => undefined,
    setState: () => {}
  });

  // The bundle is an IIFE; running it via the window's own Function constructor
  // gives it the jsdom realm as its global (so `document`, `window` and
  // `requestAnimationFrame` resolve to the mounted page).
  new window.Function(bundle).call(window);

  const thread = () => window.document.getElementById("thread");
  const post = (msg) => window.dispatchEvent(new window.MessageEvent("message", { data: msg }));
  // Let queued rAF renders (assistant streaming is throttled) flush.
  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    window,
    document: window.document,
    dom,
    posted,
    consoleErrors,
    post,
    settle,
    thread,
    reqTexts: () => [...thread().querySelectorAll(".req-text")].map((e) => e.textContent.trim()),
    respTexts: () => [...thread().querySelectorAll(".resp-text")].map((e) => e.textContent.trim()),
    // The webview posts { type: "webviewError" } whenever a message handler throws.
    errors: () => posted.filter((m) => m && m.type === "webviewError"),

    // Drive a session load the way loadSession() does: clear, capabilities,
    // then the recorded turns as user/assistant chunks, then "loaded".
    // `turns` is [{ role: "user"|"assistant", text }].
    replay(turns) {
      post({ type: "ready" });
      post({ type: "body", body: "thread" });
      post({ type: "clear", loading: true });
      post({ type: "capabilities", revert: true, editRequests: "inline", checkpoints: true });
      for (const t of turns) {
        post({ type: t.role === "user" ? "userChunk" : "assistantChunk", text: t.text });
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
