// Headless harness for the host side of a chat (src/chat/chatViewProvider.ts).
//
// This is the piece the test suite was missing. Everything the chat controller does
// happens across an await: spawning an agent, opening a session, replaying history,
// waking a chat that had exited. The bugs that keep being found in it are all the
// same shape, a chat finishing that work into a panel that has moved on, and none of
// them could be tested, so each was found by someone noticing a symptom and each fix
// was made by reading. This runs the real controller, against a real `devin acp`
// conversation, with the timing under the test's control.
//
// It is the real thing on both sides of the seam:
//   - the real ChatController, ChangeTracker, SessionStore, AcpClient and
//     TerminalManager, compiled out of src/ with `vscode` aliased to vscode-stub.js
//   - a fake agent that is a genuine ACP peer over stdio, and answers the CLI's
//     `--version` and `auth status` too, so even the health check is the real path
//
// The agent's delays are what makes the interleavings reachable: `newDelay` and
// `loadDelay` hold session/new and session/load open for as long as a test needs to
// do something else, which is the window every one of these bugs lives in.

const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-chat-"));

// One bundle for the whole run: esbuild is the slow part, and every harness shares
// the same module instances, which is also what makes `globalThis.__dvVscode` the
// stub the controller is really using.
let loaded;
function load() {
  if (loaded) {
    return loaded;
  }
  const outfile = path.join(TMP, "host.js");
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "chat-entry.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    alias: { vscode: path.join(__dirname, "vscode-stub.js") }
  });
  loaded = require(outfile);
  return loaded;
}

// A fake agent, wrapped so `<script> acp` starts it and `<script> --version` and
// `<script> auth status` answer the health check the way the real CLI does.
function writeAgent() {
  const js = path.join(TMP, "agent.js");
  const sh = path.join(TMP, "agent.sh");
  fs.writeFileSync(js, AGENT_SOURCE);
  fs.writeFileSync(
    sh,
    `#!/bin/sh
case "$1" in
  --version) echo "devin 3000.0.0-fake"; exit 0 ;;
  auth) echo "Logged in (via Devin)."; echo "  Name: Test User"; exit 0 ;;
  # Returning to the sessions list falls back to the CLI when no agent is live. Left to
  # reach the ACP loop below, it would sit on a stdin nobody writes to until the CLI's
  # own timeout killed it, tracked by nothing that could stop it.
  list) echo '[]'; exit 0 ;;
  models) echo '{"families":[]}'; exit 0 ;;
esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}
`
  );
  fs.chmodSync(sh, 0o755);
  return sh;
}

const AGENT_SOURCE = `
// A minimal but honest ACP agent. Line delimited JSON-RPC on stdio, the same as the
// real one, with its delays read from the environment so a test can hold a call open.
const fs = require("fs");
const path = require("path");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (k) => Number(process.env[k] || 0);
// Every chat gets its own agent process, so the id has to be unique across them:
// counting from one in each made every chat "s-1", which silently makes two chats
// look like the same chat to anything keyed on the id.
let seq = 0;
const idBase = "s" + process.pid;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let currentModel = "fusion-claude-opus-5-high-sidekick-swe-2-medium";
let currentThoughtLevel = "high";
let currentSpeed = "standard";
// Sessions this agent process created, so session/list can answer the way the
// real CLI does for the sessions it knows.
const knownSessions = new Map();
const configOptions = () => [
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: process.env.DV_MODE || "default",
    options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }]
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModel,
    options: process.env.DV_MODEL_OPTIONS ? JSON.parse(process.env.DV_MODEL_OPTIONS) : [{
      group: "fusion",
      name: "Fusion",
      options: [
        { value: "fusion-claude-opus-5-high-sidekick-swe-2-medium", name: "Fusion (Claude Opus 5 High + SWE-2 Medium)" },
        { value: "fusion-gpt-6-astra-high-sidekick-swe-2-high", name: "Fusion (GPT-6 Astra High Thinking + SWE-2 High)" }
      ]
    }]
  },
  {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: currentThoughtLevel,
    options: process.env.DV_THOUGHT_LEVELS ? JSON.parse(process.env.DV_THOUGHT_LEVELS) : [{ value: "low", name: "Low" }, { value: "high", name: "High" }]
  },
  {
    id: "speed",
    name: "Speed",
    category: "model_config",
    type: "select",
    currentValue: currentSpeed,
    options: [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }]
  }
];
let buf = "";
// In flight prompts, so a session/cancel can settle them the way the real agent
// does (both replies of a shared turn end together). Keyed by session id, valued
// by a per agent prompt sequence number.
const pendingPrompts = new Map();
const cancelledPrompts = new Set();
let promptSeq = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // Every request, in order, so a test can assert what the agent was really asked:
    // which prompt carried which attachment, and how many prompts arrived at all.
    if (process.env.DV_LOG) {
      try { fs.appendFileSync(process.env.DV_LOG, JSON.stringify({ ...msg, _agent: process.pid }) + "\\n"); } catch {}
    }
    // session/cancel is a notification: it carries no id and gets no reply, but
    // the prompts it names still have to end. DV_CANCEL_DELAY models the agent
    // taking a moment to actually stop the turn.
    if (msg.method === "session/cancel") {
      const sid = msg.params && msg.params.sessionId;
      const fire = () => { (pendingPrompts.get(sid) || []).forEach((s) => cancelledPrompts.add(s)); };
      const hold = num("DV_CANCEL_DELAY");
      if (hold) setTimeout(fire, hold); else fire();
      continue;
    }
    if (msg.id === undefined) continue;
    void handleRequest(msg);
  }
});
// Requests are answered off the read loop: a long prompt must not strand
// configuration requests already buffered in the same chunk behind its delay.
async function handleRequest(msg) {
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      // DV_INIT_DELAY holds the handshake open, which is the window where a
      // runtime exists but its capabilities are not yet known.
      await delay(num("DV_INIT_DELAY"));
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          _meta: { "cognition.ai/revert": true, "cognition.ai/sessionShare": true, ...(process.env.DV_NO_REVERT_BY_ID ? {} : { "cognition.ai/revertByUserMessageId": true }), ...(process.env.DV_DOCUMENT_LIFECYCLE === "1" ? { "cognition.ai/documentLifecycle": true } : {}), ...(process.env.DV_MID_TURN === "1" ? { "cognition.ai/midTurnPrompts": true } : {}), ...(process.env.DV_TERMINAL_LIFECYCLE === "1" ? { "cognition.ai/terminalLifecycle": true } : {}), ...(process.env.DV_LIST_CAPS ? JSON.parse(process.env.DV_LIST_CAPS) : {}) }
        }
      });
      break;
    case "session/new": {
      const newId = idBase + "-" + ++seq;
      knownSessions.set(newId, { sessionId: newId, cwd: (msg.params && msg.params.cwd) || "", title: "Chat " + newId, updatedAt: new Date().toISOString() });
      // The real agent announces the session's mode before it answers, so this
      // update arrives while its runtime is not yet in the pool to be found by
      // id. Anything that answers such an update with "whatever is on screen"
      // paints one chat's settings into another's.
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: newId, update: { sessionUpdate: "current_mode_update", currentModeId: process.env.DV_MODE || "default" } } });
      if (process.env.DV_USAGE) {
        // Advertise only the two instant read commands the host may use. The
        // announcement has to precede the reply so the first refresh finds them,
        // unless the test holds it back to model commands announced late.
        const advertise = () => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: newId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "context" }, { name: "session-stats" }] } } });
        const late = num("DV_USAGE_LATE");
        if (late) setTimeout(advertise, late); else advertise();
      }
      await delay(num("DV_NEW_DELAY"));
      reply({ sessionId: newId, modes: { currentModeId: process.env.DV_MODE || "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] }, configOptions: configOptions() });
      break;
    }
    case "session/set_config_option":
      if (msg.params.configId === "model") {
        currentModel = msg.params.value;
        currentThoughtLevel = "high";
        currentSpeed = "standard";
      }
      if (msg.params.configId === "thought_level") currentThoughtLevel = msg.params.value;
      if (msg.params.configId === "speed") currentSpeed = msg.params.value;
      reply({ configOptions: configOptions() });
      break;
    case "session/load":
      await delay(num("DV_LOAD_DELAY"));
      // The real CLI replays a loaded session's history as session/update
      // traffic before answering. Tests configure that replay through
      // DV_LOAD_UPDATES; absent or empty, the load replays nothing.
      try {
        for (const update of JSON.parse(process.env.DV_LOAD_UPDATES || "[]")) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update } });
        }
      } catch {}
      if (process.env.DV_USAGE) {
        // A woken session advertises its instant read commands again, the same
        // as a new one, so the first refresh after the load can find them.
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "context" }, { name: "session-stats" }] } } });
      }
      reply({});
      break;
    case "session/prompt": {
      const ptext = (msg.params.prompt || []).map((block) => block.text || "").join(" ");
      const usageChunks = (name) => {
        try { return JSON.parse(process.env[name] || "[]"); } catch { return []; }
      };
      const emit = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update } });
      // Live tool updates a test scripts, standing in for what a running turn
      // reports (background shells and friends). They arrive mid turn, never
      // through the load replay path.
      if (process.env.DV_BG_UPDATES) {
        try {
          for (const u of JSON.parse(process.env.DV_BG_UPDATES)) {
            // \${sessionId} lets one scripted update give each session its own
            // shell id, the way two chats can report the same toolCallId.
            emit(JSON.parse(JSON.stringify(u).replaceAll("\${sessionId}", msg.params.sessionId)));
          }
        } catch {}
      }
      if (process.env.DV_USAGE && ptext.startsWith("/context")) {
        const answer = () => { usageChunks("DV_CONTEXT_CHUNKS").forEach(emit); reply({ stopReason: "end_turn" }); };
        const hold = num("DV_CONTEXT_DELAY");
        if (hold) setTimeout(answer, hold); else answer();
        break;
      }
      if (process.env.DV_USAGE && ptext.startsWith("/session-stats")) {
        usageChunks("DV_STATS_CHUNKS").forEach(emit);
        reply({ stopReason: "end_turn" });
        break;
      }
      // Long by default: a turn is running until the test says otherwise, which is
      // what makes "busy" states reachable. With DV_PROMPT_GATE set, each prompt
      // instead waits for its own release file (prompt-<seq>.release in that
      // directory) or for a session/cancel, so a test can settle two prompts of
      // one shared turn in either order. DV_PROMPT_FAIL maps a seq to "error"
      // (a JSON-RPC error reply) or "cancelled" (an early cancelled result).
      const seq = ++promptSeq;
      const sid = msg.params.sessionId;
      let failures = {};
      try { failures = JSON.parse(process.env.DV_PROMPT_FAIL || "{}"); } catch {}
      const gateDir = process.env.DV_PROMPT_GATE || "";
      if (!pendingPrompts.has(sid)) pendingPrompts.set(sid, new Set());
      pendingPrompts.get(sid).add(seq);
      const finish = (result) => {
        pendingPrompts.get(sid).delete(seq);
        cancelledPrompts.delete(seq);
        reply(result);
      };
      const failNow = () => {
        pendingPrompts.get(sid).delete(seq);
        cancelledPrompts.delete(seq);
        const fail = failures[seq];
        if (fail === "error") {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "prompt failed" } });
        } else {
          reply({ stopReason: fail === "cancelled" ? "cancelled" : "end_turn" });
        }
      };
      if (gateDir) {
        // Keyed by session as well as sequence: every chat is its own agent
        // process with its own numbering, and they share the gate directory.
        const release = path.join(gateDir, sid + "-" + seq + ".release");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          if (cancelledPrompts.has(seq)) { finish({ stopReason: "cancelled" }); return; }
          if (fs.existsSync(release)) break;
          await delay(20);
        }
        failNow();
        return;
      }
      await delay(num("DV_PROMPT_DELAY") || 60000);
      failNow();
      break;
    }
    case "_cognition.ai/revert/preview": {
      // The fake enforces the extension's chosen stable-ID request contract:
      // exactly {sessionId,userMessageId}, with no execute flags. Anything
      // else is an invalid-params error, which is what the strict regression
      // tests assert against.
      const p = msg.params || {};
      const keys = Object.keys(p).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["sessionId", "userMessageId"])
        || typeof p.sessionId !== "string" || typeof p.userMessageId !== "string") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
        break;
      }
      if (process.env.DV_PREVIEW_FAIL === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "preview failed" } });
        break;
      }
      reply(JSON.parse(process.env.DV_PREVIEW || '{"fileActions":[],"irreversibleWarnings":[],"conflicts":[]}'));
      break;
    }
    case "_cognition.ai/revert/execute": {
      const p = msg.params || {};
      if (typeof p.sessionId !== "string" || typeof p.userMessageId !== "string") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
        break;
      }
      if (process.env.DV_EXECUTE_FAIL === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "execute failed" } });
        break;
      }
      reply({});
      break;
    }
    case "_cognition.ai/revert/forkFromStep": {
      const p = msg.params || {};
      if (typeof p.sessionId !== "string" || typeof p.targetNodeId !== "number") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
        break;
      }
      reply({ forkedSessionId: process.env.DV_FORK_ID || (idBase + "-fork" + ++seq) });
      break;
    }
    case "_cognition.ai/revert/listSteps": {
      await delay(num("DV_STEPS_DELAY"));
      // DV_STEPS is the exact step list JSON; absent means the agent reports no
      // revertible history, the way a session with no prompts does.
      reply({ steps: JSON.parse(process.env.DV_STEPS || "[]") });
      break;
    }
    case "_cognition.ai/reads/promptHistory": {
      // DV_HISTORY holds the entries array. Absent means the agent does not
      // serve the read at all, the way an older CLI answers. The extension
      // must never call this: the entries are global across directories.
      const entries = JSON.parse(process.env.DV_HISTORY || "null");
      if (entries === null) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      } else {
        reply({ entries });
      }
      break;
    }
    case "_cognition.ai/terminal/killBackgroundShell": {
      if (process.env.DV_KILL_UNSUPPORTED === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      } else if (process.env.DV_KILL_FAIL_ONCE === "1" && !globalThis.__dvKillFailed) {
        globalThis.__dvKillFailed = true;
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "kill failed" } });
      } else {
        await delay(num("DV_KILL_DELAY"));
        reply({});
      }
      break;
    }
    case "session/list": {
      await delay(num("DV_LIST_DELAY"));
      // DV_LIST_LIVE answers with the sessions this agent created. Otherwise
      // DV_LIST_SESSIONS is the exact row set, for tests that need a session
      // the agent does not know about.
      if (process.env.DV_LIST_LIVE === "1") {
        // DV_LIST_EXTRA adds rows this agent does not own, standing in for the
        // global hits a real session/list returns across every directory.
        const extra = JSON.parse(process.env.DV_LIST_EXTRA || "[]");
        reply({ sessions: [...knownSessions.values(), ...extra] });
      } else {
        reply({ sessions: JSON.parse(process.env.DV_LIST_SESSIONS || "[]") });
      }
      break;
    }
    default: reply({});
  }
}
process.stdin.on("end", () => process.exit(0));
`;

let agentPath;
let harnessSeq = 0;

// A Memento over a plain object, which is all SessionStore asks for.
function memento(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get: (k, fallback) => (map.has(k) ? map.get(k) : fallback),
    update: async (k, v) => { map.set(k, v); },
    keys: () => [...map.keys()],
    __map: map
  };
}

// The page, as far as the host can tell: it records what it was told, and lets the
// test say what the user did. Each double keeps its own message handler on `_handler`
// so a manager's several surfaces can be driven independently. `last` still points at
// the most recent one for the single surface harnesses.
function webviewDouble(posted) {
  const wv = {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (uri) => uri,
    postMessage: (m) => { posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
    onDidReceiveMessage: (fn) => { wv._handler = fn; webviewDouble.last = fn; return { dispose() {} }; }
  };
  return wv;
}

/**
 * Build a chat surface with an agent behind it.
 *
 * `opts.newDelay` / `opts.loadDelay` / `opts.promptDelay` are the agent's delays in ms,
 * which is how a test gets inside the window between asking for something and it
 * arriving. `opts.storage` and `opts.cwd` reuse another harness's directories, which is
 * how a reload is written. `opts.config` overrides the settings the controller reads.
 */
function createChat(opts = {}) {
  const { ChatController, SessionStore, ChangeTracker, AcpRequestNotSentError } = load();
  const vscode = globalThis.__dvVscode;
  agentPath = agentPath || writeAgent();

  const dir = opts.cwd || fs.mkdtempSync(path.join(TMP, "ws-"));
  // Pass another harness's `storage` to stand in for a window reload, or for a second
  // surface: the extension's storage directory is per workspace, not per window, and it
  // is where anything that outlives an agent is kept.
  const storage = opts.storage || fs.mkdtempSync(path.join(TMP, "store-"));
  // Per harness, not per directory: two harnesses can share a workspace now (that is
  // what a reload is), and a shared log would mix one controller's requests into the
  // other's, which is silent and would make `agentSaw` quietly wrong.
  const agentLog = path.join(storage, `agent-requests.${++harnessSeq}.jsonl`);
  globalThis.__dvFolders = [{ name: path.basename(dir), uri: vscode.Uri.file(dir), index: 0 }];
  // How the agent is told what to do. It goes through the `devin.env` setting rather
  // than this process's environment because the controller reads that on every spawn,
  // while the environment it inherits is read from a login shell once and cached for
  // the run: a delay set through that would only ever reach the first agent.
  // `opts.promptGate` (true, or a directory) switches prompts to per sequence
  // release files instead of one flat delay, so two prompts of a shared turn can
  // be settled in either order.
  const gateDir = opts.promptGate === true ? path.join(storage, "prompt-gate") : (opts.promptGate || "");
  if (gateDir) fs.mkdirSync(gateDir, { recursive: true });
  const agentEnv = {
    DV_LOG: agentLog,
    DV_NEW_DELAY: String(opts.newDelay || 0),
    DV_LOAD_DELAY: String(opts.loadDelay || 0),
    DV_INIT_DELAY: String(opts.initDelay || 0),
    DV_PROMPT_DELAY: String(opts.promptDelay || 0),
    // Steering support and per prompt release gates, for the mid turn prompt
    // tests: the gate directory holds one release file per prompt sequence.
    DV_MID_TURN: opts.midTurnPrompts ? "1" : "",
    DV_PROMPT_GATE: opts.promptGate ? gateDir : "",
    DV_CANCEL_DELAY: String(opts.cancelDelay || 0),
    DV_PROMPT_FAIL: opts.promptFail ? JSON.stringify(opts.promptFail) : "",
    DV_STEPS_DELAY: String(opts.stepsDelay || 0),
    DV_STEPS: opts.steps ? JSON.stringify(opts.steps) : "",
    // Checkpoint action scripting: the preview answer, forced preview/execute
    // failures, a forked session id, and opting out of the stable id capability.
    DV_NO_REVERT_BY_ID: opts.noRevertByUserMessageId ? "1" : "",
    DV_PREVIEW: opts.preview ? JSON.stringify(opts.preview) : "",
    DV_PREVIEW_FAIL: opts.previewFail ? "1" : "",
    DV_EXECUTE_FAIL: opts.executeFail ? "1" : "",
    DV_FORK_ID: opts.forkId || "",
    DV_DOCUMENT_LIFECYCLE: opts.documentLifecycle ? "1" : "",
    // The instant usage reads the host may send: advertised only when the test
    // supplies reports for them to answer with.
    DV_USAGE: opts.usage ? "1" : "",
    DV_USAGE_LATE: String(opts.usageLate || 0),
    DV_CONTEXT_DELAY: String(opts.usageContextDelay || 0),
    DV_CONTEXT_CHUNKS: opts.usage?.contextChunks ? JSON.stringify(opts.usage.contextChunks) : "",
    DV_STATS_CHUNKS: opts.usage?.statsChunks ? JSON.stringify(opts.usage.statsChunks) : "",
    // Session config choices a test needs the agent to advertise, serialized
    // because the agent is a separate process. Absent values keep the defaults.
    DV_MODEL_OPTIONS: opts.modelOptions ? JSON.stringify(opts.modelOptions) : "",
    DV_THOUGHT_LEVELS: opts.thoughtLevels ? JSON.stringify(opts.thoughtLevels) : "",
    // Exact ACP update objects the agent emits during session/load, standing in
    // for the history the real CLI replays. Absent means no replay at all.
    DV_LOAD_UPDATES: opts.loadUpdates ? JSON.stringify(opts.loadUpdates) : "",
    // The optional integrations under test: advertised capabilities, scripted
    // history, scripted background shell updates, and the kill endpoint's
    // supported/unsupported answers.
    DV_TERMINAL_LIFECYCLE: opts.terminalLifecycle ? "1" : "",
    DV_LIST_CAPS: opts.listCaps ? JSON.stringify(opts.listCaps) : "",
    DV_LIST_LIVE: opts.listLive ? "1" : "",
    DV_LIST_SESSIONS: opts.listSessions ? JSON.stringify(opts.listSessions) : "",
    DV_LIST_EXTRA: opts.listExtra ? JSON.stringify(opts.listExtra) : "",
    DV_LIST_DELAY: String(opts.listDelay || 0),
    DV_HISTORY: opts.history !== undefined ? JSON.stringify(opts.history) : "",
    DV_BG_UPDATES: opts.bgUpdates ? JSON.stringify(opts.bgUpdates) : "",
    DV_KILL_UNSUPPORTED: opts.killUnsupported ? "1" : "",
    DV_KILL_DELAY: String(opts.killDelay || 0),
    DV_KILL_FAIL_ONCE: opts.killFailOnce ? "1" : ""
  };
  globalThis.__dvConfig = Object.assign(
    {
      cliPath: agentPath,
      env: agentEnv,
      // Turned off rather than defaulted: the editor context and a real terminal are
      // their own subjects, and an idle exit firing mid test would look like a bug in
      // whatever was being tested. The key has to be the one the code reads.
      "implicitContext.enabled": false,
      useIntegratedTerminal: false,
      idleSessionKeepAliveMinutes: 0
    },
    opts.config
  );

  const posted = [];
  const logs = [];
  const state = memento(opts.state);
  const store = new SessionStore(state, () =>
    !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile);
  const changes = new ChangeTracker();
  const context = {
    extensionUri: vscode.Uri.file(ROOT),
    storageUri: vscode.Uri.file(storage),
    globalStorageUri: vscode.Uri.file(storage),
    subscriptions: [],
    workspaceState: state,
    globalState: state
  };
  const output = { appendLine: (l) => logs.push(l), dispose() {} };
  const controller = new ChatController(context, store, changes, undefined, output, opts.kind || "view", opts.surfaceHost);
  const webview = webviewDouble(posted);
  controller.bind(webview, () => {});
  const toHost = webviewDouble.last;

  const api = {
    controller,
    store,
    changes,
    state,
    // The class the bundled controller's `instanceof` checks against, for tests
    // that stub a client's prompt to fail before it reaches the wire.
    AcpRequestNotSentError,
    posted,
    logs,
    webview,
    cwd: dir,
    // Where anything that outlives the agent is kept. Hand it to another `createChat` to
    // write what a window reload does.
    storage,
    // What the user did. The real page posts these, and the host cannot tell the
    // difference: this is the same handler VS Code would call.
    send: (msg) => { void toHost(msg); return api; },
    // Wait, in the same units the agent's delays are in.
    settle: (ms = 50) => new Promise((r) => setTimeout(r, ms)),
    // Wait for something to become true rather than for a guessed number of
    // milliseconds: the first chat of a run also pays for the health check and a login
    // shell read, so a fixed wait is either flaky or slow.
    async until(predicate, timeout = 10000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) {
          return true;
        }
        await api.settle(25);
      }
      return false;
    },
    // The delays the NEXT agent starts with. Each chat spawns its own, so a test can
    // let the first one open instantly and hold the second one open.
    // The mode the NEXT chat's agent reports itself to be in, so a test can tell one
    // chat's mode from another's and catch a background chat setting the panel's.
    setAgentMode(mode) {
      agentEnv.DV_MODE = String(mode);
      return api;
    },
    setDelays({ newDelay, loadDelay, promptDelay }) {
      if (newDelay !== undefined) agentEnv.DV_NEW_DELAY = String(newDelay);
      if (loadDelay !== undefined) agentEnv.DV_LOAD_DELAY = String(loadDelay);
      if (promptDelay !== undefined) agentEnv.DV_PROMPT_DELAY = String(promptDelay);
      return api;
    },
    // Everything of one type the host posted, oldest first.
    postsOf: (type) => posted.filter((m) => m && m.type === type),
    // What the agent was really asked, in order. `method` filters it.
    agentSaw: (method) => {
      const lines = fs.existsSync(agentLog) ? fs.readFileSync(agentLog, "utf8").trim().split("\n") : [];
      return lines.filter(Boolean).map((l) => JSON.parse(l)).filter((m) => !method || m.method === method);
    },
    last: (type) => [...posted].reverse().find((m) => !type || m.type === type),
    // The chat the panel is showing, which is the thing most of these bugs get wrong.
    activeId: () => controller.activeId,
    // How many chats are really open. A chat is only in the pool once its session/new
    // has been answered, so this is the signal that a chat started in the background has
    // finished starting, which a test has to wait for or it asserts nothing.
    liveChats: () => controller.runtimes.size,
    // What the user picks in a modal (Terminate, Discard). The controller asks through
    // window.showWarningMessage, so this is the answer it gets.
    answerWith: (choice) => { vscode.window.answer = choice; return api; },
    // The prompts the agent has been sent, in order across every chat this
    // harness owns (each chat is its own agent process, so sequence numbers are
    // per process: filter by sessionId when a test shares the log).
    promptCount: () => api.agentSaw("session/prompt").length,
    // Release prompt number `seq` (1 based, the order session/prompt arrived on
    // that chat's agent) for session `id`. Only meaningful with `promptGate`.
    releasePrompt(id, seq) {
      if (gateDir) fs.writeFileSync(path.join(gateDir, id + "-" + seq + ".release"), "");
      return api;
    },
    // Announce the page is listening, which is what unblocks anything waiting on it.
    async ready() {
      await toHost({ type: "ready" });
      return api;
    },
    // Wait until the new session's user prompt reaches the agent.
    async startChat(text = "hello") {
      const before = controller.activeId;
      const promptsBefore = api.agentSaw("session/prompt").length;
      api.send({ type: "send", text, newSession: true });
      const opened = await api.until(() => controller.activeId && controller.activeId !== before);
      if (!opened) {
        throw new Error("the chat never opened. Agent log: " + logs.join(" | "));
      }
      const sessionId = controller.activeId;
      const prompted = await api.until(() => api.agentSaw("session/prompt").slice(promptsBefore).some(
        (request) => request.params.sessionId === sessionId && request.params.prompt.at(-1)?.text === text
      ));
      if (!prompted) {
        throw new Error("the chat opened without sending its prompt. Agent log: " + logs.join(" | "));
      }
      return sessionId;
    },
    async dispose() {
      built.delete(api);
      // An answer outlives the harness otherwise, and the stub hands it to every dialog,
      // so a later test's rename prompt would be answered "Terminate".
      vscode.window.answer = undefined;
      await controller.shutdown().catch(() => {});
      changes.dispose?.();
    }
  };
  built.add(api);
  return api;
}

/**
 * Build a whole ChatManager: the sidebar surface plus any editor panels it
 * opens, sharing one SessionStore and ChangeTracker the way the extension does.
 * Used for the routing tests, where which surface a command lands on is the
 * thing under test. No agent is needed unless a test starts a chat: the fake
 * agent path is the same `devin.env` config createChat installs.
 */
function createManager(opts = {}) {
  const { ChatManager, SessionStore, ChangeTracker } = load();
  const vscode = globalThis.__dvVscode;
  agentPath = agentPath || writeAgent();

  const dir = opts.cwd || fs.mkdtempSync(path.join(TMP, "ws-"));
  const storage = opts.storage || fs.mkdtempSync(path.join(TMP, "store-"));
  const agentLog = path.join(storage, `agent-requests.${++harnessSeq}.jsonl`);
  globalThis.__dvFolders = [{ name: path.basename(dir), uri: vscode.Uri.file(dir), index: 0 }];
  globalThis.__dvConfig = {
    cliPath: agentPath,
    env: { DV_LOG: agentLog },
    "implicitContext.enabled": false,
    useIntegratedTerminal: false,
    idleSessionKeepAliveMinutes: 0
  };

  const state = memento(opts.state);
  const store = new SessionStore(state, () =>
    !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile);
  const changes = new ChangeTracker();
  const context = {
    extensionUri: vscode.Uri.file(ROOT),
    storageUri: vscode.Uri.file(storage),
    globalStorageUri: vscode.Uri.file(storage),
    subscriptions: [],
    workspaceState: state,
    globalState: state
  };
  const output = { appendLine: () => {}, dispose() {} };
  const manager = new ChatManager(context, store, changes, undefined, output);

  const api = {
    manager,
    store,
    state,
    changes,
    cwd: dir,
    storage,
    // Resolve the sidebar view the way VS Code does, and keep its webview so a
    // test can post into it and read what it was told.
    resolveSidebar() {
      const posted = [];
      const view = {
        webview: webviewDouble(posted),
        visible: true,
        onDidChangeVisibility: () => ({ dispose() {} })
      };
      manager.resolveWebviewView(view);
      api.sidebarWebview = view.webview;
      api.sidebarPosted = posted;
      return api;
    },
    sidebarController: () => manager.sidebar,
    // The controllers behind the manager's editor panels, in open order.
    panelControllers: () => [...manager.panels.keys()],
    // A panel controller's page, for posting into and reading what it was told.
    panelWebview: (controller) => {
      for (const [c, panel] of manager.panels) {
        if (c === controller) {
          return panel.webview;
        }
      }
      return undefined;
    },
    // What a panel's page was told, oldest first.
    panelPosted: (controller) => {
      for (const [c, panel] of manager.panels) {
        if (c === controller) {
          return panel.posted;
        }
      }
      return [];
    },
    // Deliver a webview message to a specific surface's page.
    sendTo(webview, msg) { void webview._handler(msg); return api; },
    // Announce the page is listening, which unblocks whenReady.
    async ready(webview) {
      await webview._handler({ type: "ready" });
      return api;
    },
    async dispose() {
      built.delete(api);
      vscode.window.answer = undefined;
      await manager.shutdown().catch(() => {});
      changes.dispose?.();
    }
  };
  built.add(api);
  return api;
}

// Every harness built in this run. A test that fails throws before its own dispose,
// and an agent left alive keeps the test runner's event loop alive with it, which
// shows up as the whole suite hanging with no output rather than as a failure. So the
// teardown is not the test's responsibility.
const built = new Set();

async function cleanup() {
  await Promise.all([...built].map((h) => h.dispose().catch(() => {})));
  built.clear();
  fs.rmSync(TMP, { recursive: true, force: true });
}

module.exports = { createChat, createManager, cleanup };
