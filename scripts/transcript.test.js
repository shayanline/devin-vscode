// Tests for the transcript log (src/chat/transcriptLog.ts): the record that lets a
// chat keep its history when it moves between the side panel and an editor tab.
//
// The case that matters is a move while a turn is running. The agent cannot supply
// the history then (`session/load` over a live channel kills the running prompt),
// so the new surface has to rebuild it from what the old one was sent. The end to
// end test below proves that: one stream is fed to a first webview, then only the
// log's replay is fed to a second, and the two transcripts must match.

const { after, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");
const { createHarness: mountHarness } = require("./webview-harness");

const harnesses = [];
const createHarness = (...args) => {
  const harness = mountHarness(...args);
  harnesses.push(harness);
  return harness;
};
after(() => harnesses.forEach(({ window }) => window.close()));

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-transcript-"));
const outfile = path.join(TMP, "transcriptLog.js");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/chat/transcriptLog.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error"
});
const { recordPainted, paintedReplay, rewindPainted, LOG_MAX } = require(outfile);

// Record a whole stream the way the host does, one payload at a time.
function recordAll(payloads, max) {
  const log = [];
  let dropped = false;
  for (const p of payloads) {
    if (recordPainted(log, p, max)) dropped = true;
  }
  return { log, dropped };
}

test("streamed text is merged, so a long turn costs a few entries", () => {
  const chunks = [];
  for (let i = 0; i < 500; i++) chunks.push({ type: "assistantChunk", text: "word ", messageId: "m1" });
  const { log, dropped } = recordAll(chunks);
  assert.strictEqual(log.length, 1, "500 chunks of one message are one entry");
  assert.strictEqual(log[0].text.length, 2500, "with every character kept");
  assert.strictEqual(dropped, false);

  // A different message, and anything that is not streamed text, stands alone.
  const mixed = recordAll([
    { type: "assistantChunk", text: "a", messageId: "m1" },
    { type: "assistantChunk", text: "b", messageId: "m1" },
    { type: "assistantChunk", text: "c", messageId: "m2" },
    { type: "toolCall", id: "t1", title: "Read one.ts", kind: "read", status: "completed" },
    { type: "assistantChunk", text: "d", messageId: "m2" }
  ]).log;
  assert.deepStrictEqual(mixed.map((e) => e.type + ":" + (e.text || e.id)), [
    "assistantChunk:ab",
    "assistantChunk:c",
    "toolCall:t1",
    "assistantChunk:d"
  ], "a tool call between two chunks of one message breaks the merge");
});

test("the record never grows without bound, and says when it lost the start", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ type: "toolCall", id: "t" + i, title: "Tool " + i });
  const { log, dropped } = recordAll(many, 10);
  assert.strictEqual(log.length, 10, "capped");
  assert.strictEqual(dropped, true, "and it reports that a rebuild would be partial");
  assert.strictEqual(log[0].id, "t30", "keeping the most recent");
  assert.strictEqual(recordAll(many, 100).dropped, false, "under the cap nothing is dropped");
  assert.strictEqual(typeof LOG_MAX, "number");
});

test("the record is a copy, so a merge cannot rewrite what was already sent", () => {
  const sent = { type: "assistantChunk", text: "first", messageId: "m1" };
  const log = [];
  recordPainted(log, sent);
  recordPainted(log, { type: "assistantChunk", text: " and second", messageId: "m1" });
  assert.strictEqual(sent.text, "first", "the payload the webview received is untouched");
  assert.strictEqual(log[0].text, "first and second");
});

test("a replay settles the last block and does not re-time old reasoning", () => {
  const { log } = recordAll([
    { type: "thoughtChunk", text: "weighing it up", messageId: "m1", replayed: false },
    { type: "assistantChunk", text: "done", messageId: "m2" }
  ]);
  const replay = paintedReplay(log);
  assert.strictEqual(replay[0].replayed, true, "reasoning is not timed a second time");
  assert.strictEqual(log[0].replayed, false, "and the record itself is left alone");
  assert.deepStrictEqual(replay[replay.length - 1], { type: "assistantEnd" },
    "the last block is settled, since turn markers are per surface");
});

test("checkpoint identity: a rewind keeps the prefix and drops the target and later", () => {
  // The painted record mixes live echoes (userMessage + clientMessageId) and
  // replayed prompts (userChunk + messageId). Either spelling of the stable id
  // identifies the rewind target.
  const { log } = recordAll([
    { type: "userMessage", text: "first", clientMessageId: "m1" },
    { type: "assistantChunk", text: "a1", messageId: "a1" },
    { type: "userMessage", text: "second", clientMessageId: "m2" },
    { type: "assistantChunk", text: "a2", messageId: "a2" },
    { type: "toolCall", id: "t1", title: "Read x.ts" },
    { type: "userChunk", text: "third", messageId: "m3" },
    { type: "assistantChunk", text: "a3", messageId: "a3" }
  ]);

  const label = (e) => e.type + ":" + (e.clientMessageId || e.messageId || e.id || e.text);

  // Targeting the live echo drops it and everything after, prefix intact.
  assert.strictEqual(rewindPainted(log, "m2"), true);
  assert.deepStrictEqual(log.map(label), [
    "userMessage:m1",
    "assistantChunk:a1"
  ], "the earlier turn survives, the target and later are gone");

  // Rebuild and target the replayed chunk spelling instead.
  const replayed = recordAll([
    { type: "userChunk", text: "first", messageId: "r1" },
    { type: "assistantChunk", text: "a1", messageId: "a1" },
    { type: "userChunk", text: "second", messageId: "r2" },
    { type: "assistantChunk", text: "a2", messageId: "a2" }
  ]).log;
  assert.strictEqual(rewindPainted(replayed, "r2"), true);
  assert.deepStrictEqual(replayed.map(label), [
    "userChunk:r1",
    "assistantChunk:a1"
  ], "a replayed prompt id rewinds the same way");
});

test("checkpoint identity: a rewind never guesses at a prompt it cannot name", () => {
  const { log } = recordAll([
    { type: "userMessage", text: "same words", clientMessageId: "m1" },
    { type: "assistantChunk", text: "reply", messageId: "m2" },
    { type: "userMessage", text: "same words", clientMessageId: "m3" }
  ]);
  const before = JSON.stringify(log);

  // Identical text under a different id is a different prompt: no match.
  assert.strictEqual(rewindPainted(log, "m9"), false, "an unknown id must not match by text");
  // An assistant chunk's messageId is not a prompt id either.
  assert.strictEqual(rewindPainted(log, "m2"), false, "an assistant messageId is not a rewind target");
  assert.strictEqual(JSON.stringify(log), before, "a miss leaves the record untouched");
});

test("a chat moved mid turn rebuilds the same transcript on the new surface", async () => {
  // What the host sends a surface across two turns, the second still running: a
  // question, reasoning, tool calls, a plan, a file change and a partial reply.
  const stream = [
    { type: "userMessage", text: "Refactor the auth module" },
    { type: "thoughtChunk", text: "Reading the module first.", messageId: "t1" },
    { type: "toolCall", id: "c1", title: "Read src/auth/token.ts", kind: "read", status: "completed",
      locations: [{ path: "src/auth/token.ts" }] },
    { type: "assistantChunk", text: "Token handling ", messageId: "a1" },
    { type: "assistantChunk", text: "now lives in one place.", messageId: "a1" },
    { type: "plan", entries: [{ content: "Extract TokenService", status: "completed" },
      { content: "Update the callers", status: "in_progress" }] },
    { type: "userMessage", text: "Now run the tests" },
    { type: "toolCall", id: "c2", title: "Run npm test", kind: "execute", status: "in_progress",
      rawInput: { command: "npm test" } },
    { type: "fileChange", path: "src/auth/token-service.ts", added: 34, removed: 6 },
    { type: "assistantChunk", text: "Tests are running", messageId: "a2" }
  ];

  // The surface the chat started on.
  const before = createHarness();
  before.post({ type: "ready" });
  before.post({ type: "body", body: "thread" });
  before.post({ type: "clear" });
  before.post({ type: "capabilities", revert: true, surface: "view" });
  before.post({ type: "sessionReady", sessionId: "A" });
  const { log, dropped } = recordAll(stream);
  stream.forEach((m) => before.post(m));
  await before.settle(30);
  assert.strictEqual(dropped, false, "the whole conversation fits in the record");

  // The surface it is moved to: a fresh page that is only given the replay, which
  // is all `importRuntime` has to work with while the turn is still running.
  const after = createHarness();
  after.post({ type: "ready" });
  after.post({ type: "body", body: "thread" });
  after.post({ type: "capabilities", revert: true, surface: "editor" });
  after.post({ type: "sessionReady", sessionId: "A" });
  after.post({ type: "clear", loading: true });
  paintedReplay(log).forEach((m) => after.post(m));
  after.post({ type: "loaded" });
  after.post({ type: "busy", value: true });
  await after.settle(30);

  assert.deepStrictEqual(after.reqTexts(), before.reqTexts(), "both questions came across");
  assert.deepStrictEqual(after.reqTexts(), ["Refactor the auth module", "Now run the tests"]);
  assert.deepStrictEqual(after.respTexts(), before.respTexts(), "and every reply");
  const tools = (h) => [...h.thread().querySelectorAll(".tool")].map((t) =>
    [...t.querySelectorAll(".tool-verb, .tool-detail, .tool-label-code")].map((x) => x.textContent).join(""));
  // A file the agent read is one line naming that file, not a path to unfold, and
  // a command is titled by the command itself, still running here.
  assert.deepStrictEqual(tools(after), ["Read token.ts", "Runningnpm test"], "with the tool calls, in order");
  assert.deepStrictEqual(tools(after), tools(before));
  assert.match(after.thread().textContent, /Reading the module first/, "and the reasoning");
  const plan = (h) => [...h.document.querySelectorAll(".plan-docked .plan-entry-text")].map((s) => s.textContent.trim());
  assert.deepStrictEqual(plan(after), ["Extract TokenService", "Update the callers"],
    "the plan it is working through came too");
  assert.deepStrictEqual(plan(after), plan(before));
  assert.ok(!after.document.querySelector("#welcome:not(.hidden)"), "and no welcome screen over it");
  assert.strictEqual(after.errors().length, 0, "rebuild threw: " + JSON.stringify(after.errors()));
  assert.strictEqual(before.errors().length, 0);
});

test("message persistence streamed user chunks keep every attachment they carried", () => {
  // A user message can be painted as several chunks, each with the attachments
  // that came with it. Merging the text must not let the last chunk's array
  // replace the earlier ones.
  const { log } = recordAll([
    { type: "userChunk", text: "look at ", messageId: "u1", attachments: [{ label: "a.png", type: "image", thumb: "data:image/png;base64,AAA" }] },
    { type: "userChunk", text: "these", messageId: "u1", attachments: [{ label: "b.txt", type: "file" }] },
    { type: "userChunk", text: " and ", messageId: "u1" },
    { type: "userChunk", text: "those", messageId: "u1", attachments: [{ label: "c.md", type: "file" }] }
  ]);
  assert.strictEqual(log.length, 1, "the chunks merged into one entry");
  assert.strictEqual(log[0].text, "look at these and those");
  assert.deepStrictEqual(log[0].attachments.map((a) => a.label), ["a.png", "b.txt", "c.md"]);

  // A different message id, or a non streamed payload, stands alone.
  const separate = recordAll([
    { type: "userChunk", text: "one", messageId: "u1", attachments: [{ label: "a.png", type: "file" }] },
    { type: "userChunk", text: "two", messageId: "u2", attachments: [{ label: "b.png", type: "file" }] }
  ]).log;
  assert.strictEqual(separate.length, 2, "a new message id is a new entry");
  assert.deepStrictEqual(separate[0].attachments.map((a) => a.label), ["a.png"]);
  assert.deepStrictEqual(separate[1].attachments.map((a) => a.label), ["b.png"]);
});

test("a stopped background shell replays as history and never regrows its control", async () => {
  // The host records a stopped tool row so a moved chat still says Stopped. What
  // must NOT come back with it is the authorization: the shell registry is
  // ephemeral state the host publishes live, so a replayed row alone can never
  // grow a stop button on the new surface.
  const stream = [
    { type: "userMessage", text: "run it in the background" },
    { type: "toolCall", id: "tc-bg", title: "sleep 90", kind: "execute", status: "in_progress",
      rawInput: { command: "sleep 90" } },
    { type: "toolCallUpdate", id: "tc-bg", status: "cancelled", stopped: true }
  ];
  const { log, dropped } = recordAll(stream);
  assert.strictEqual(dropped, false);

  const h = createHarness();
  h.post({ type: "ready" });
  h.post({ type: "body", body: "thread" });
  h.post({ type: "capabilities", revert: true, surface: "view" });
  h.post({ type: "sessionReady", sessionId: "A" });
  h.post({ type: "clear", loading: true });
  paintedReplay(log).forEach((m) => h.post(m));
  h.post({ type: "loaded" });
  await h.settle(30);

  assert.ok(h.thread().textContent.includes("Stopped"), "the row reads Stopped after the move");
  assert.strictEqual(h.document.querySelector('button[title="Stop Background Command"]'), null,
    "and no stop control came back with the transcript");
  assert.strictEqual(h.errors().length, 0, "rebuild threw: " + JSON.stringify(h.errors()));
});
