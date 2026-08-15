// Tests for what this window remembers about its chats: the session list it
// builds from the agent's answer (src/session/sessionList.ts) and the store that
// outlives every agent (src/session/sessionStore.ts).
//
// Both hold things nothing else has a copy of. A pruned id takes its working
// directory and its unsent draft with it, and the interrupted list is the only
// record that a turn died with the window, so the risk in both is the same:
// forgetting something on the strength of an answer that was never a fact.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-sessions-"));

function build(rel) {
  const outfile = path.join(TMP, path.basename(rel).replace(/\.ts$/, ".js"));
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    alias: { vscode: path.join(__dirname, "vscode-stub.js") }
  });
  return require(outfile);
}

const { fromAcpRows } = build("src/session/sessionList.ts");
const { SessionStore } = build("src/session/sessionStore.ts");

// A Memento over a plain object, which is all SessionStore asks for.
function memento() {
  const map = new Map();
  return {
    get: (k, fallback) => (map.has(k) ? map.get(k) : fallback),
    update: async (k, v) => { map.set(k, v); },
    keys: () => [...map.keys()]
  };
}

test("a session the agent did not mention is pruned, unless it mentioned none at all", () => {
  const tracked = ["kept", "gone"];
  const rows = [{ sessionId: "kept", cwd: "/w", title: "Kept", updatedAt: "2026-08-15T10:00:00Z" }];

  const answered = fromAcpRows(rows, tracked);
  assert.deepStrictEqual(answered.sessions.map((s) => s.id), ["kept"]);
  assert.deepStrictEqual(answered.prunedIds, ["gone"], "an id the agent does not know is gone");
  assert.strictEqual(answered.sessions[0].last_activity_at, Math.floor(Date.parse("2026-08-15T10:00:00Z") / 1000));

  // An agent answering at all has its own session to report, so no rows is the
  // call not working: a renamed field after a CLI upgrade, a reset store. Pruning
  // on it emptied the whole workspace list, and every cwd and draft with it.
  const empty = fromAcpRows([], tracked);
  assert.deepStrictEqual(empty.prunedIds, [], "an empty answer prunes nothing");
});

test("the newest interrupted turns are the ones kept", async () => {
  const store = new SessionStore(memento());
  // More than the cap, so the oldest have to go: they are the ones nobody came
  // back to. Dropping the newest instead meant that once the list filled up with
  // chats the user never reopened, a reload mid turn stopped being reported at
  // all, which is the one thing this list exists to say.
  const old = Array.from({ length: 50 }, (_, i) => `old-${i}`);
  await store.markInterrupted(old);
  await store.markInterrupted(["the-one-that-just-died"]);

  const held = store.interrupted();
  assert.strictEqual(held.length, 50, "still capped");
  assert.ok(held.includes("the-one-that-just-died"), "and the newest is in it");
});

test("a session that is gone takes its interrupted mark and its title with it", async () => {
  const store = new SessionStore(memento());
  store.add("s1", "/w");
  store.setTitle("s1", "A chat");
  await store.markInterrupted(["s1"]);

  store.remove("s1");
  assert.deepStrictEqual(store.interrupted(), [], "nothing left pointing at a session that has gone");
  assert.deepStrictEqual(store.titles(), {}, "and no name kept for it for ever");
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
