// Protocol tests for AcpClient.readUsage: the internal /context and
// /session-stats reads that keep usage figures current without touching the
// transcript. They run the real client against a scripted fake agent over
// stdio, the same way acp.test.js does.
//
// The settled fixture: a Fusion session whose Lead reports a 1M window and
// whose Sub (a real "sidekick" subagent) reports its own window, plus the
// session-stats requests whose ACU dimensions sum to 1.9281.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-acp-usage-"));

const outfile = path.join(TMP, "client.js");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/acp/client.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error",
  alias: { vscode: path.join(__dirname, "vscode-stub.js") }
});
const { AcpClient } = require(outfile);

const SUB_CONTEXT = { modelId: "swe-2-flash-max", totalTokens: 27342, maxTokens: 262144 };
const LEAD_CONTEXT = { modelId: "gpt-6-1-sol-max", totalTokens: 90745, maxTokens: 1000000 };
const SESSION_STATS = {
  requests: [
    { requestId: "lead-r", responseDimensions: [{ uid: "acu", kind: { type: "cumulativeMetric", value: 1.5 } }] },
    { requestId: "sub-r", responseDimensions: [{ uid: "acu", kind: { type: "cumulativeMetric", value: 0.4281 } }] }
  ]
};

// A scripted peer: answers initialize/session/new, advertises the two instant
// commands when `commands` is set, and replies to read prompts by pushing their
// report chunks as ordinary session/update notifications first. `contextDelay`
// holds the /context reply open so a test can act while the read is in flight,
// and `slowPrompt` holds a real turn open for the same reason.
function fakeAgent(name, { commands = true, contextDelay = 0, statsError = false, slowPrompt = false, emptyContext = false } = {}) {
  const log = path.join(TMP, name + ".log");
  const js = path.join(TMP, name + ".js");
  const shim = path.join(TMP, name + (process.platform === "win32" ? ".cmd" : ".sh"));
  fs.writeFileSync(js, `
    const fs = require("fs");
    const LOG = ${JSON.stringify(log)};
    const SUB_CONTEXT = ${JSON.stringify(SUB_CONTEXT)};
    const LEAD_CONTEXT = ${JSON.stringify(LEAD_CONTEXT)};
    const SESSION_STATS = ${JSON.stringify(SESSION_STATS)};
    let buf = "";
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    const update = (sessionId, update) => notify("session/update", { sessionId, update });
    const record = (m) => fs.appendFileSync(LOG, JSON.stringify(m) + "\\n");
    const promptText = (params) => (params.prompt || []).map((b) => b.text || "").join(" ");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        record(msg);
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          continue;
        }
        if (msg.method === "session/new") {
          ${commands ? `
          update("usage-s", {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "context" }, { name: "session-stats" }]
          });` : ""}
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "usage-s" } });
          continue;
        }
        if (msg.method === "session/prompt") {
          const text = promptText(msg.params);
          const sessionId = msg.params.sessionId;
          if (/^\\/context(?:\\s|$)/.test(text)) {
            const answer = () => {
              ${emptyContext ? `
              // A valid object window followed by the authoritative empty
              // snapshot: the array replaces, it does not merge.
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                "cognition.ai/contextUsage": LEAD_CONTEXT
              } });
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                "cognition.ai/contextUsage": []
              } });` : `
              // The Sub's report is tagged as delegated work; a real worker's
              // (a different parentAgentId) must never be collected.
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                "cognition.ai/subagent_context": { parentAgentId: "sidekick" },
                "cognition.ai/contextUsage": SUB_CONTEXT
              } });
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                "cognition.ai/subagent_context": { parentAgentId: "worker-9" },
                "cognition.ai/contextUsage": { modelId: "unrelated-1", totalTokens: 5, maxTokens: 100 }
              } });
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                "cognition.ai/contextUsage": LEAD_CONTEXT
              } });
              // An ordinary chunk inside the read window still reaches listeners.
              update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "context header" } });`}
              send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            };
            ${contextDelay ? `setTimeout(answer, ${contextDelay});` : "answer();"}
            continue;
          }
          if (/^\\/session-stats(?:\\s|$)/.test(text)) {
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: { "cognition.ai/instant": true } });
            ${statsError
              ? `send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "stats offline" } });
                 // A report reply can arrive after the request already failed.
                 // The sentinel right behind it gives the test an observable
                 // "the late chunk was processed" point instead of a sleep.
                 setTimeout(() => {
                   update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: {
                     "cognition.ai/sessionStats": SESSION_STATS
                   } });
                   update(sessionId, { sessionUpdate: "session_info_update", title: "read settled" });
                 }, 120);`
              : `update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, _meta: { "cognition.ai/sessionStats": SESSION_STATS } });
                 send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });`}
            continue;
          }
          if (/^\\/help(?:\\s|$)/.test(text)) {
            // An ordinary command whose reply is marked instant, the same
            // shape a report chunk has: it must reach listeners once no read
            // is in flight.
            update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "help output" }, _meta: { "cognition.ai/instant": true } });
            send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
            continue;
          }
          ${slowPrompt ? `
          setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }), 60000);
          continue;` : ""}
          send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
          continue;
        }
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    });
    process.stdin.on("end", () => process.exit(0));
  `);
  if (process.platform === "win32") {
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${js}"\r\n`);
  } else {
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`);
    fs.chmodSync(shim, 0o755);
  }
  return { cli: shim, log };
}

function seen(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function promptTexts(msg) {
  return (msg.params.prompt || []).map((b) => b.text || "").join(" ");
}

const prompts = (log) => seen(log).filter((m) => m.method === "session/prompt").map(promptTexts);

async function waitFor(log, match, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = seen(log).find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

// The in-memory counterpart of waitFor, for things the client saw rather than
// what the agent was asked.
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const clients = new Set();
function start(cli) {
  const client = new AcpClient({ cliPath: cli, cwd: TMP, env: process.env });
  client.on("log", () => {});
  clients.add(client);
  client.start();
  return client;
}

async function openSession(client) {
  await client.initialize();
  // The command advertisement travels the ordered pipe ahead of the reply, so
  // a resolved session/new means the commands are already known.
  await client.newSession(TMP);
}

test("readUsage returns the scoped role windows and the session ACU sum", async () => {
  const { cli, log } = fakeAgent("usage-read");
  const client = start(cli);
  const updates = [];
  client.on("update", (n) => updates.push(n));
  try {
    await openSession(client);
    const report = await client.readUsage("usage-s");
    assert.deepEqual(prompts(log), ["/context", "/session-stats"]);
    assert.deepEqual(report.contexts, [
      { ...SUB_CONTEXT, role: "sub" },
      { ...LEAD_CONTEXT, role: "lead" }
    ]);
    assert.equal(report.sessionAcus, 1.9281);
    assert.equal(report.error, undefined);
    // The report chunks stay out of the ordinary update stream; a normal chunk
    // inside the same window still arrives.
    const metas = updates.map((n) => n.update?._meta || {});
    assert.equal(metas.filter((m) => m["cognition.ai/contextUsage"] !== undefined).length, 0);
    assert.equal(metas.filter((m) => m["cognition.ai/sessionStats"] !== undefined).length, 0);
    assert.ok(updates.some((n) => n.update?.content?.text === "context header"));
  } finally {
    client.dispose();
  }
});

test("a user prompt waits behind the read, and cancel keeps it off the wire", async () => {
  const { cli, log } = fakeAgent("usage-order", { contextDelay: 250 });
  const client = start(cli);
  try {
    await openSession(client);
    const reading = client.readUsage("usage-s");
    const prompting = client.prompt("usage-s", [{ type: "text", text: "hello" }]);
    await waitFor(log, (m) => m.method === "session/prompt" && promptTexts(m).includes("/context"));
    client.cancel("usage-s");
    const [report, result] = await Promise.all([reading, prompting]);
    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(report.contexts?.length, 2);
    // The wire saw only the two reads, never the cancelled user prompt.
    assert.deepEqual(prompts(log), ["/context", "/session-stats"]);
  } finally {
    client.dispose();
  }

  const second = fakeAgent("usage-queue", { contextDelay: 200 });
  const client2 = start(second.cli);
  try {
    await openSession(client2);
    const reading = client2.readUsage("usage-s");
    const prompted = client2.prompt("usage-s", [{ type: "text", text: "hello" }]);
    const [report, result] = await Promise.all([reading, prompted]);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(report.sessionAcus, 1.9281);
    // The user prompt followed the reads on the wire, never overtaking them.
    assert.deepEqual(prompts(second.log), ["/context", "/session-stats", "hello"]);
  } finally {
    client2.dispose();
  }
});

test("a real turn blocks a new read, while a manual /context stays visible", async () => {
  const { cli, log } = fakeAgent("usage-busy", { slowPrompt: true });
  const client = start(cli);
  const updates = [];
  client.on("update", (n) => updates.push(n));
  try {
    await openSession(client);
    const prompting = client.prompt("usage-s", [{ type: "text", text: "hello" }]);
    prompting.catch(() => {});
    await waitFor(log, (m) => m.method === "session/prompt" && promptTexts(m).includes("hello"));
    // A read cannot jump a running turn.
    assert.deepEqual(await client.readUsage("usage-s"), {});
    const manual = await client.prompt("usage-s", [{ type: "text", text: "/context" }]);
    assert.deepEqual(manual, { stopReason: "end_turn" });
    assert.ok(updates.some((n) => n.update?._meta?.["cognition.ai/contextUsage"] !== undefined),
      "a manual /context keeps its report visible");
    client.cancel("usage-s");
  } finally {
    client.dispose();
  }
});

test("an agent without the advertised commands gets no probe prompts", async () => {
  const { cli, log } = fakeAgent("usage-none", { commands: false });
  const client = start(cli);
  try {
    await openSession(client);
    assert.deepEqual(await client.readUsage("usage-s"), {});
    assert.deepEqual(prompts(log), []);
  } finally {
    client.dispose();
  }
});

test("a failed read keeps its capture for late replies and reports the error", async () => {
  const { cli } = fakeAgent("usage-error", { statsError: true });
  const client = start(cli);
  const updates = [];
  client.on("update", (n) => updates.push(n));
  try {
    await openSession(client);
    const report = await client.readUsage("usage-s");
    assert.deepEqual(report.contexts?.length, 2);
    assert.equal(report.sessionAcus, undefined);
    assert.equal(report.error, "Could not refresh usage.");
    // The capture is retained for the reply that lands after the failure, so
    // the late report never reaches the update stream as if it were chat. The
    // agent emits a session_info_update sentinel right behind the late chunk:
    // once it is seen, the late chunk has definitely been processed.
    const settled = await until(() => updates.some((n) => n.update?.sessionUpdate === "session_info_update" && n.update?.title === "read settled"));
    assert.ok(settled, "the late reply sentinel never arrived");
    assert.equal(updates.filter((n) => n.update?._meta?.["cognition.ai/sessionStats"] !== undefined).length, 0);
  } finally {
    client.dispose();
  }
});

test("a settled read stops suppressing ordinary instant replies", async () => {
  const { cli } = fakeAgent("usage-after", { statsError: true });
  const client = start(cli);
  const updates = [];
  client.on("update", (n) => updates.push(n));
  try {
    await openSession(client);
    const report = await client.readUsage("usage-s");
    assert.equal(report.error, "Could not refresh usage.");
    // The read has settled, so an ordinary command whose reply is marked
    // instant is transcript output again rather than a suppressed report.
    const helped = await client.prompt("usage-s", [{ type: "text", text: "/help" }]);
    assert.deepEqual(helped, { stopReason: "end_turn" });
    assert.ok(updates.some((n) => n.update?.content?.text === "help output"),
      "the instant reply after the read never reached the update stream");
    // The retained capture still holds back the late structured stats reply.
    // The sentinel right behind it proves that chunk was processed.
    const settled = await until(() => updates.some((n) => n.update?.sessionUpdate === "session_info_update" && n.update?.title === "read settled"));
    assert.ok(settled, "the late reply sentinel never arrived");
    assert.equal(updates.filter((n) => n.update?._meta?.["cognition.ai/sessionStats"] !== undefined).length, 0);
  } finally {
    client.dispose();
  }
});

test("an authoritative empty snapshot replaces an earlier object report", async () => {
  const { cli, log } = fakeAgent("usage-empty", { emptyContext: true });
  const client = start(cli);
  const updates = [];
  client.on("update", (n) => updates.push(n));
  try {
    await openSession(client);
    const report = await client.readUsage("usage-s");
    assert.deepEqual(report.contexts, [], "the empty array replaces the object, it does not merge");
    assert.equal(report.sessionAcus, 1.9281);
    assert.equal(report.error, undefined);
    // Both report chunks stayed out of the ordinary update stream.
    assert.equal(updates.filter((n) => n.update?._meta?.["cognition.ai/contextUsage"] !== undefined).length, 0);
    assert.deepEqual(prompts(log), ["/context", "/session-stats"]);
  } finally {
    client.dispose();
  }
});

test("an in flight read is shared by session, never across sessions", async () => {
  const { cli } = fakeAgent("usage-shared", { contextDelay: 150 });
  const client = start(cli);
  try {
    await openSession(client);
    const a = client.readUsage("usage-s");
    const b = client.readUsage("usage-s");
    const other = client.readUsage("other-s");
    assert.deepEqual(await other, {}, "a different session does not wait on this read");
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb, "the same session shares one in flight read");
    assert.equal(ra.sessionAcus, 1.9281);
  } finally {
    client.dispose();
  }
});

test.after(async () => {
  await Promise.all([...clients].map((c) => Promise.resolve(c.dispose()).catch(() => {})));
  fs.rmSync(TMP, { recursive: true, force: true });
});
