// Generates a self-contained HTML page that renders the real chat webview
// (media/main.css + dist/webview.js + media/webview-body.html) outside VS Code,
// driven by a mock host scenario. Open it in a browser (or Playwright) to see
// and iterate on the UI without a build-install-reload loop.
//
//   npm run compile && node scripts/preview.js
//   # then: playwright-cli open "file://.../scripts/.preview/index.html"
//
// A --scenario flag selects which mock conversation to render (default: full).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "scripts", ".preview");
const MEDIA = path.join(ROOT, "media");

// VS Code "Dark Modern"-ish tokens, enough for the chat panel to look right.
const VARS = {
  "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  "font-size": "13px",
  "editor-font-family": "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  foreground: "#cccccc",
  "editor-background": "#1f1f1f",
  "sideBar-background": "#181818",
  "panel-border": "#2b2b2b",
  "editorWidget-background": "#202020",
  "list-hoverBackground": "#2a2d2e",
  "toolbar-hoverBackground": "#2a2d2e",
  "input-foreground": "#cccccc",
  "input-background": "#313131",
  "input-border": "#3c3c3c",
  "dropdown-background": "#313131",
  "textLink-foreground": "#4daafc",
  "textCodeBlock-background": "#2b2b2b",
  "progressBar-background": "#0078d4",
  "testing-iconPassed": "#3fb950",
  "testing-iconFailed": "#f85149",
  "errorForeground": "#f85149",
  "chat-requestBubbleBackground": "#2b2b2b",
  "focusBorder": "#0078d4",
  "descriptionForeground": "#9d9d9d",
  "button-background": "#0078d4",
  "button-foreground": "#ffffff",
  "button-hoverBackground": "#026ec1",
  "button-secondaryBackground": "#313131",
  "button-secondaryForeground": "#cccccc",
  "button-secondaryHoverBackground": "#3c3c3c",
  "chat-requestBorder": "#3c3c3c",
  "chat-requestBackground": "#1a1a1a",
  "chat-thinkingShimmer": "#e6e6e6",
  "textPreformat-foreground": "#d4d4d4",
  "textPreformat-background": "rgba(127,127,127,0.18)",
  "textPreformat-border": "rgba(127,127,127,0.22)",
  "textBlockQuote-background": "rgba(127,127,127,0.08)",
  "textBlockQuote-border": "#3c3c3c",
  "badge-background": "rgba(127,127,127,0.22)",
  "list-hoverBackground": "#2a2d2e",
  "list-inactiveSelectionBackground": "#37373d",
  "list-inactiveSelectionForeground": "#cccccc",
  "list-activeSelectionBackground": "#04395e",
  "list-activeSelectionForeground": "#ffffff",
  "input-placeholderForeground": "#8b8b8b",
  "panel-background": "#181818",
  "editorWarning-foreground": "#cca700",
  "icon-foreground": "#c5c5c5"
};

const rootVars = Object.entries(VARS)
  .map(([k, v]) => `  --vscode-${k}: ${v};`)
  .join("\n");

// A rich conversation exercising text, thinking, plan, tool cards, file rows,
// a follow-up message, plus a permission prompt and an interactive question.
const SCENARIOS = {
  full: [
    { type: "ready" },
    { type: "body", body: "thread" },
    { type: "capabilities", revert: true, editRequests: "inline", checkpoints: true, showFileChanges: true },
    { type: "userMessage", text: "Refactor the auth module to centralise token handling, then run the tests." },
    { type: "busy", value: true },
    { type: "assistantStart" },
    { type: "thoughtChunk", text: "They want a refactor plus a test run, so I should start by understanding the current shape of the auth module.\n\nToken creation and refresh look tangled together in `token.ts`, so pulling them into a dedicated `TokenService` would isolate the logic and make it testable.\n\nOnce the callers are updated I can run the suite to confirm nothing regressed." },
    { type: "assistantChunk", text: "Sure. Here's the plan, then I'll get started." },
    { type: "plan", entries: [
      { content: "Read the current auth module", status: "completed" },
      { content: "Extract token handling into TokenService", status: "in_progress" },
      { content: "Run the test suite", status: "pending" }
    ] },
    { type: "toolCall", id: "t1", title: "Read src/auth/token.ts", kind: "read", status: "completed", locations: [{ path: "src/auth/token.ts", line: 42 }] },
    { type: "toolCall", id: "t2", title: "Edit src/auth/token-service.ts", kind: "edit", status: "completed", rawInput: { path: "src/auth/token-service.ts" }, content: [{ type: "diff", path: "src/auth/token-service.ts", added: 34, removed: 6 }] },
    { type: "toolCall", id: "t3", title: "Run npm test", kind: "execute", status: "completed", rawInput: { command: "npm test" }, content: [{ type: "text", text: "PASS  auth.test.ts\n  \u2713 issues a token (12 ms)\n  \u2713 rejects an expired token (4 ms)\n\nTests: 2 passed, 2 total" }] },
    { type: "fileChange", path: "src/auth/token-service.ts", added: 34, removed: 6 },
    { type: "assistantChunk", text: "All tests pass. Token handling now lives in [src/auth/token-service.ts](src/auth/token-service.ts), and the callers were updated to use it. Anything else you'd like adjusted?" },
    { type: "assistantEnd" },
    { type: "busy", value: false },
    { type: "permission", requestId: "p1", title: "Devin wants to run: `git push origin main`", options: [
      { optionId: "allow", name: "Allow", kind: "allow" },
      { optionId: "reject", name: "Reject", kind: "reject" }
    ] },
    { type: "elicitation", requestId: "e1", mode: "form", message: "A couple of quick questions", allowOther: true, schema: {
      type: "object", required: ["q0", "q1"], properties: {
        q0: { type: "string", title: "Next step", description: "What should I do next?", oneOf: [
          { const: "docs", title: "Update the docs" },
          { const: "pr", title: "Open a pull request" },
          { const: "nothing", title: "Nothing for now" }
        ] },
        q1: { type: "string", title: "Target branch", description: "Where should the change land?", oneOf: [
          { const: "main", title: "main" },
          { const: "develop", title: "develop" }
        ] }
      }
    } }
  ],
  // Pending state: after send, before the first token arrives.
  working: [
    { type: "ready" },
    { type: "body", body: "thread" },
    { type: "capabilities", revert: true, editRequests: "inline", checkpoints: true },
    { type: "userMessage", text: "Refactor the auth module and run the tests." },
    { type: "assistantStart" }
  ],
  // Exercises the newer rendering: web search / fetch / MCP tools, a grouped
  // tool run, and a mermaid diagram.
  tools: [
    { type: "ready" },
    { type: "body", body: "thread" },
    { type: "capabilities", revert: true },
    { type: "userMessage", text: "Research the release process and draw the flow." },
    { type: "assistantStart" },
    { type: "toolCall", id: "s1", title: "Searched web for release checklist", kind: "fetch", meta: { inferenceToolName: "web_search" }, status: "completed", rawInput: { query: "software release checklist best practices" }, content: [{ type: "text", text: 'Found 5 result(s) for "software release checklist best practices"' }] },
    { type: "toolCall", id: "f1", title: "Fetched https://semver.org", kind: "fetch", meta: { inferenceToolName: "webfetch" }, status: "completed", rawInput: { url: "https://semver.org" }, content: [{ type: "text", text: "Fetched 4210 characters from https://semver.org" }] },
    { type: "toolCall", id: "m1", title: "Calling get_current_time from time", meta: { eventType: "mcp_tool_call", toolName: "mcp__time__get_current_time", inferenceToolName: "mcp__time__get_current_time" }, status: "completed", rawInput: { timezone: "UTC" }, content: [{ type: "text", text: '{\n  "timezone": "UTC",\n  "datetime": "2026-07-30T13:35:18+00:00",\n  "is_dst": false\n}' }] },
    { type: "assistantChunk", text: "Now let me look at the code." },
    { type: "toolCall", id: "r1", title: "Read src/release/plan.ts", kind: "read", status: "completed" },
    { type: "toolCall", id: "r2", title: "Read src/release/tag.ts", kind: "read", status: "completed" },
    { type: "toolCall", id: "r3", title: "Grep for version bump", kind: "search", status: "completed", rawInput: { query: "bumpVersion" } },
    { type: "assistantChunk", text: "Here is the release flow:\n\n```mermaid\nflowchart TD\n  A[Merge to main] --> B{Tests pass?}\n  B -- yes --> C[Bump version]\n  B -- no --> D[Fix and retry]\n  C --> E[Tag release]\n  E --> F[Publish]\n```\n\nThat covers the full path from merge to publish." },
    { type: "assistantEnd" }
  ]
};

function build(scenarioName) {
  const scenario = SCENARIOS[scenarioName] || SCENARIOS.full;
  const body = fs.readFileSync(path.join(MEDIA, "webview-body.html"), "utf8");
  const cssMain = path.relative(OUT_DIR, path.join(MEDIA, "main.css"));
  const cssCodicon = path.relative(OUT_DIR, path.join(MEDIA, "codicon", "codicon.css"));
  const bundle = path.relative(OUT_DIR, path.join(ROOT, "dist", "webview.js"));
  const mermaid = path.relative(OUT_DIR, path.join(ROOT, "dist", "mermaid.js"));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
:root {
${rootVars}
}
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
/* Emulate the narrow sidebar panel width. */
#app { max-width: 460px; }
</style>
<link rel="stylesheet" href="${cssCodicon}" />
<link rel="stylesheet" href="${cssMain}" />
</head>
<body data-logo="" data-model-icons="{}" data-mermaid-src="${mermaid}" class="vscode-dark">
${body}
<script>
  // Mock the VS Code webview API before the bundle loads.
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
</script>
<script src="${bundle}"></script>
<script>
  const SCENARIO = ${JSON.stringify(scenario)};
  for (const msg of SCENARIO) {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  }
  // Scenarios do not send a "sessions" message, so dismiss the boot overlay
  // directly rather than waiting out its 15s fallback timeout.
  const boot = document.getElementById("boot");
  if (boot) boot.classList.add("hidden");
</script>
</body>
</html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "index.html");
  fs.writeFileSync(outFile, html, "utf8");
  return outFile;
}

const flagIdx = process.argv.indexOf("--scenario");
const scenarioName = flagIdx >= 0 ? process.argv[flagIdx + 1] : "full";
const out = build(scenarioName);
console.log("Preview written to:", out);
console.log("Open with: playwright-cli open \"file://" + out + "\"");
