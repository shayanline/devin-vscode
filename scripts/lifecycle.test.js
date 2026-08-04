// Shutdown tests for the agent lifecycle, run against the real AcpClient and
// TerminalManager compiled out of src/. These guard the safeguard that matters
// most: when the extension host goes away, nothing it spawned is left running.
//
// A `devin acp` agent cannot be handed to the next extension host (it runs its
// commands, file writes and permission prompts through us, over our stdio), so
// `shutdown()` has to actually finish the job, including against an agent that
// ignores a polite request to stop.
//
// The fake agents are shell wrappers so the client can invoke them the way it
// invokes the real CLI (`<cliPath> acp`), with the extra argument ignored.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-lifecycle-"));

// Bundle the vscode-free host modules so they can be required from a plain test.
function load(rel, name) {
  const outfile = path.join(TMP, name + ".js");
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "error"
  });
  return require(outfile);
}
const { AcpClient } = load("src/acp/client.ts", "client");
const { TerminalManager } = load("src/acp/terminal.ts", "terminal");

const PID_FILE = path.join(TMP, "agent.pid");

// A fake agent, wrapped in a shell script so `<script> acp` runs it. `body` is
// the node source. It records its pid so the test can check it really died.
function fakeAgent(name, body) {
  const js = path.join(TMP, name + ".js");
  const sh = path.join(TMP, name + ".sh");
  fs.writeFileSync(js, `require("fs").writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid));\n${body}\n`);
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

// Exits as soon as its stdin closes, like a well-behaved stdio agent.
const POLITE = () => fakeAgent("polite", `
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
`);

// Ignores both stdin EOF and SIGTERM: only SIGKILL ends it. This is the docker
// backed MCP case that used to survive as an orphan.
const STUBBORN = () => fakeAgent("stubborn", `
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
`);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function waitGone(pid, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

function startAgent(cliPath) {
  const client = new AcpClient({ cliPath, cwd: TMP, env: process.env });
  client.start();
  return client;
}

async function agentPid() {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(PID_FILE)) {
      const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
      if (pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the fake agent never started");
}

test.beforeEach(() => {
  fs.rmSync(PID_FILE, { force: true });
});

test("shutdown lets a well-behaved agent exit on its own", { skip: process.platform === "win32" }, async () => {
  const client = startAgent(POLITE());
  const pid = await agentPid();
  assert.ok(alive(pid));

  const started = Date.now();
  await client.shutdown();
  // Closing stdin is enough, so this returns well inside the budget.
  assert.ok(Date.now() - started < 700, "a clean exit should not wait for the escalation");
  assert.ok(await waitGone(pid), "the agent should be gone");
});

test("shutdown kills an agent that ignores stdin EOF and SIGTERM", { skip: process.platform === "win32" }, async () => {
  const client = startAgent(STUBBORN());
  const pid = await agentPid();
  assert.ok(alive(pid));

  const started = Date.now();
  await client.shutdown(400);
  const took = Date.now() - started;
  // It must escalate all the way to SIGKILL, and still finish rather than waiting
  // on the agent forever, since VS Code only awaits deactivate for so long. The
  // ceiling is loose on purpose: this asserts boundedness, not a timing, and a
  // loaded CI runner is allowed to be slow.
  assert.ok(took >= 400, "expected the full escalation, took " + took + "ms");
  assert.ok(took < 4000, "shutdown must stay bounded, took " + took + "ms");
  assert.ok(await waitGone(pid), "a stubborn agent must not survive shutdown");
});

test("shutdown is safe to call twice, and after the agent has already gone", { skip: process.platform === "win32" }, async () => {
  const client = startAgent(POLITE());
  const pid = await agentPid();
  await client.shutdown();
  assert.ok(await waitGone(pid));
  // The second call must resolve rather than wait out the whole budget.
  const started = Date.now();
  await client.shutdown();
  assert.ok(Date.now() - started < 100);
});

test("an exiting host leaves no running command behind", { skip: process.platform === "win32" }, async () => {
  const terms = new TerminalManager(process.env, TMP);
  // A shell that traps SIGTERM, standing in for a build or test run that will
  // not stop when asked. These are children of the extension host, and the agent
  // reaper only looks for `devin acp`, so nothing else would ever collect them.
  // It reports the pid of a child it spawned, so the test can prove the whole
  // tree went down rather than just the shell.
  // The inner shell announces itself only once its trap is installed, so the
  // test can never signal it before it is actually ignoring SIGTERM.
  const { terminalId } = terms.create({
    sessionId: "s1",
    command: "trap '' TERM; sh -c 'trap \"\" TERM; echo ready; while true; do sleep 1; done' & echo child=$!; wait"
  });
  assert.ok(terminalId);
  let child = 0;
  for (let i = 0; i < 250; i++) {
    const out = terms.output(terminalId).output;
    const m = /child=(\d+)/.exec(out);
    if (m && out.includes("ready")) {
      child = Number(m[1]);
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(child > 0, "the fake command never reported a trapping child");
  assert.ok(alive(child), "the child should be running before we stop it");

  terms.requestStopAll();
  await new Promise((r) => setTimeout(r, 200));
  // Everything here traps SIGTERM, so the polite pass cannot win. This is what
  // makes the forced second pass load bearing rather than belt and braces.
  assert.ok(alive(child), "the fixture must survive SIGTERM, or this proves nothing");
  terms.forceStopAll();
  assert.ok(await waitGone(child), "a stubborn command's children must not be left running");
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
