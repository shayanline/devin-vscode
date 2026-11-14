// StatusBar account-usage tests: the injected reader is the seam, so no test
// ever touches a real account or the credential file. What is asserted is how
// snapshots become bar text and tooltip lines, how errors degrade, and how the
// polling loop is owned. The bar text is the icon alone. The figures live in
// the tooltip and the info menu row.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-statusbar-"));
const outfile = path.join(TMP, "statusbar.js");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/ui/statusBar.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error",
  alias: { vscode: path.join(__dirname, "vscode-stub.js") }
});
// STATUSBAR_TEST_BUNDLE swaps in a previous bundle for the bare icon negative proof. Normal runs load the bundle compiled just above.
const { StatusBar } = require(process.env.STATUSBAR_TEST_BUNDLE || outfile);
const vscode = globalThis.__dvVscode;

const items = vscode.window.statusBarItems;
const bars = [];

function makeBar(reader) {
  const bar = new StatusBar(reader);
  bars.push(bar);
  return { bar, item: items[items.length - 1] };
}

// A reader a test can steer: each call queues a resolver so the test decides
// when the answer lands.
function manual() {
  const pending = [];
  const calls = [];
  const reader = (env) => {
    calls.push(env);
    return new Promise((resolve) => pending.push(resolve));
  };
  return { pending, calls, reader };
}

// Answer the read currently in flight (starting one if none is) and wait for
// the bar to apply it. `refreshUsage` coalesces, so the shared promise is the
// read the snapshot lands in.
async function answer(bar, pending, value) {
  const read = bar.refreshUsage();
  pending[pending.length - 1](value);
  await read;
}

const ENV_A = { HOME: "/accounts/a" };
const ENV_B = { HOME: "/accounts/b" };
const snapshot = (usage, extra = {}) => ({ usage, fetchedAt: 1700000000000, ...extra });
const usage = (used, limit, remaining, overage) => ({ used, limit, remaining, overage });

test("the bar is the icon alone, with the quota cycle in tooltip and menu row", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ version: "1.0", env: ENV_A });
  assert.equal(pending.length, 1, "the environment starts one read");
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0), { account: { id: "a1", name: "Account user", email: "u@example.invalid" } }));
  bar.set({ connected: true });
  assert.equal(item.text, "$(chat-sparkle)", "the icon carries no figures");
  assert.equal(item.name, "Devin");
  assert.equal(item.accessibilityInformation.label, "Devin connected. Open account usage and shortcuts.");
  const tip = item.tooltip.value;
  assert.ok(tip.includes("**$(chat-sparkle) Devin**"), "the header names the bar. Tip: " + tip);
  assert.ok(tip.includes("$(graph) **Cycle usage**"), "the usage section leads. Tip: " + tip);
  assert.ok(tip.includes("**139.50 / 3,000.00 ACU**"), "the figures are bold and compact. Tip: " + tip);
  assert.ok(tip.includes("Usage for u@example.invalid"), "the API account owns the figures. Tip: " + tip);
  assert.ok(tip.includes("2,860.50 ACU left"), "the remainder is a detail line. Tip: " + tip);
  assert.match(tip, /_Last reported /, "the report time closes the block in italic. Tip: " + tip);
  assert.doesNotMatch(tip, /unlimited/i);
  assert.equal(tip.split("Open Devin Cloud").length - 1, 1, "the cloud link appears once. Tip: " + tip);
  assert.ok(tip.includes("command:devin.focusChat"), "the chat command link remains. Tip: " + tip);
  assert.deepEqual(item.tooltip.isTrusted, { enabledCommands: ["devin.focusChat"] }, "only the chat command is trusted");
  const row = bar.getUsageItem();
  assert.equal(row.label, "$(graph) Cycle usage");
  assert.equal(row.description, "139.50 / 3,000.00 ACU", "the description is compact, no remainder");
  const parts = row.detail.split(" | ");
  assert.equal(parts.length, 3, "owner, remainder and time on one line. Detail: " + row.detail);
  assert.equal(parts[0], "Usage for u@example.invalid");
  assert.equal(parts[1], "2,860.50 ACU left");
  assert.match(parts[2], /^Last reported /);
});

test("the icon stays bare in every usage state", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  assert.equal(item.text, "$(debug-disconnect)", "no environment yet is the bare disconnected icon");
  bar.setInfo({ env: ENV_A });
  assert.equal(item.text, "$(debug-disconnect)", "a pending first read adds nothing");
  await answer(bar, pending, snapshot(usage(0, 10, 10, 0)));
  bar.set({ connected: true });
  assert.equal(item.text, "$(chat-sparkle)", "cached figures stay out of the text");
  const failing = bar.refreshUsage();
  pending[pending.length - 1](Promise.reject(new Error("down")));
  await failing;
  assert.equal(item.text, "$(chat-sparkle)", "a failed refresh adds nothing either");
  await answer(bar, pending, snapshot(undefined, { account: { id: "a1" } }));
  assert.equal(item.text, "$(chat-sparkle)", "a quota-less reply is still the bare icon");
});

test("a quota with only a used figure says used, and zero values are real", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot({ used: 42 }));
  bar.set({ connected: true });
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "42.00 ACU used");
  assert.ok(item.tooltip.value.includes("**42.00 ACU used**"), "the used-only figure is bold. Tip: " + item.tooltip.value);
  await answer(bar, pending, snapshot(usage(0, 3000, 3000, 0)));
  assert.equal(bar.getUsageItem().description, "0.00 / 3,000.00 ACU");
  assert.ok(bar.getUsageItem().detail.includes("3,000.00 ACU left"), "the remainder still shows beside the zero used figure. Detail: " + bar.getUsageItem().detail);
});

test("a signed-out or quota-less reply clears the figures instead of pretending", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0)));
  bar.set({ connected: true });
  assert.equal(item.text, "$(chat-sparkle)");
  await answer(bar, pending, snapshot(undefined, { account: { id: "a1" } }));
  assert.equal(item.text, "$(chat-sparkle)", "no quota is still the bare icon, never zeros or unlimited");
  assert.equal(bar.getUsageItem().description, "No ACU quota reported");
  const tip = item.tooltip.value;
  assert.ok(tip.includes("No ACU quota reported"), "the empty state is shown plainly. Tip: " + tip);
  assert.match(bar.getUsageItem().detail, /^Last reported /, "the snapshot time still shows. Detail: " + bar.getUsageItem().detail);
});

test("a failed refresh keeps the last good snapshot and says it is stale", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0)));
  bar.set({ connected: true });
  const failing = bar.refreshUsage();
  pending[pending.length - 1](Promise.reject(new Error("down")));
  await failing;
  assert.equal(item.text, "$(chat-sparkle)");
  const tip = item.tooltip.value;
  assert.ok(tip.includes("**139.50 / 3,000.00 ACU**"), "the last figures stay. Tip: " + tip);
  assert.match(tip, /Refresh failed\. Showing the last report from /, "and the tooltip says they are stale. Tip: " + tip);
  const row = bar.getUsageItem();
  assert.equal(row.description, "139.50 / 3,000.00 ACU");
  assert.match(row.detail, /Refresh failed\. Showing the last report from /, "the menu row says it too. Detail: " + row.detail);
});

test("a changed environment drops the old quota and a late answer cannot restore it", async () => {
  const { pending, calls, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  const oldRead = bar.refreshUsage();
  bar.set({ connected: true });
  // The environment (and so possibly the account) changed mid read: the old
  // figures are dropped before the next answer lands.
  bar.setInfo({ env: ENV_B });
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "Refreshing account usage.", "the dropped figures read as pending");
  assert.equal(pending.length, 2, "a new environment starts a new read");
  assert.equal(calls[1], ENV_B);
  const newRead = bar.refreshUsage();
  // The superseded environment's answer arrives too late to be shown.
  pending[0](snapshot(usage(999, 1000, 1, 0), { account: { id: "old" } }));
  await oldRead;
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "Refreshing account usage.", "the superseded answer cannot restore the old quota");
  pending[1](snapshot(usage(5, 10, 5, 0), { account: { id: "new" } }));
  await newRead;
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "5.00 / 10.00 ACU");
  assert.ok(item.tooltip.value.includes("**5.00 / 10.00 ACU**"), "the new figures reach the hover. Tip: " + item.tooltip.value);
});

test("a changed account under the same environment clears the old figures", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A, account: { name: "Old user", email: "old@example.invalid" } });
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0)));
  bar.set({ connected: true });
  assert.equal(bar.getUsageItem().description, "139.50 / 3,000.00 ACU");
  const staleRead = bar.refreshUsage();
  // Same variables, different sign-in: the figures drop right away and a new
  // guarded read starts, while the superseded one is ignored when it lands.
  bar.setInfo({ env: ENV_A, account: { name: "New user", email: "new@example.invalid" } });
  assert.equal(item.text, "$(chat-sparkle)", "the old account's figures did not drop");
  assert.equal(bar.getUsageItem().description, "Refreshing account usage.", "the cleared quota reads as pending, not the old figures");
  assert.equal(pending.length, 3, "the identity change starts a fresh read");
  const newRead = bar.refreshUsage();
  pending[1](snapshot(usage(999, 1000, 1, 0), { account: { id: "old" } }));
  await staleRead;
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "Refreshing account usage.", "the superseded answer cannot restore the old quota");
  pending[2](snapshot(usage(5, 10, 5, 0), { account: { id: "new" } }));
  await newRead;
  assert.equal(item.text, "$(chat-sparkle)");
  assert.equal(bar.getUsageItem().description, "5.00 / 10.00 ACU");
  // An identical identity under an identical environment still shares one loop.
  bar.setInfo({ env: ENV_A, account: { name: "New user", email: "new@example.invalid" } });
  assert.equal(pending.length, 3, "an unchanged identity restarts nothing");
});

test("the quota tooltip stands on its own while disconnected", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0)));
  // Never connected: the quota section still renders, with its timestamp.
  assert.equal(item.text, "$(debug-disconnect)");
  assert.equal(item.accessibilityInformation.label, "Devin disconnected. Open account usage and shortcuts.");
  const tip = item.tooltip.value;
  assert.match(tip, /Not connected/);
  assert.ok(tip.includes("**139.50 / 3,000.00 ACU**"), "the cached figures still show. Tip: " + tip);
  assert.match(tip, /_Last reported /);
  const failing = bar.refreshUsage();
  pending[pending.length - 1](Promise.reject(new Error("down")));
  await failing;
  const stale = item.tooltip.value;
  assert.match(stale, /Not connected/);
  assert.match(stale, /Refresh failed\. Showing the last report from/);
});

test("the same account is named once across the hover and the menu row", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  const account = { name: "Account user", email: "u@example.invalid", plan: "Pro" };
  bar.setInfo({ env: ENV_A, account });
  // The API answers for the same account with different casing: proven same.
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0), { account: { name: "Account user", email: "U@Example.Invalid" } }));
  bar.set({ connected: true });
  const tip = item.tooltip.value;
  assert.ok(!tip.includes("Usage for"), "the same account is not repeated as usage owner. Tip: " + tip);
  assert.equal(tip.split("u@example.invalid").length - 1, 1, "the email shows once, in the account row. Tip: " + tip);
  assert.equal(tip.split("Account user").length - 1, 1, "the name shows once too. Tip: " + tip);
  assert.ok(tip.includes("$(organization) Pro"), "the plan still shows once. Tip: " + tip);
  const shown = bar.getUsageItem(account);
  assert.ok(!shown.detail.includes("Usage for"), "the menu row drops the owner against the shown account. Detail: " + shown.detail);
  assert.equal(shown.detail.split(" | ")[0], "2,860.50 ACU left", "the remainder leads the detail. Detail: " + shown.detail);
  const unshown = bar.getUsageItem();
  assert.ok(unshown.detail.startsWith("Usage for U@Example.Invalid"), "with no displayed account the owner is kept. Detail: " + unshown.detail);
  assert.ok(tip.includes("u@example.invalid  \n$(organization) Pro"), "the plan follows the email on a hard break. Tip: " + tip);
});

test("an account named by its own email shows the address once", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  const account = { name: "U@Example.Invalid", email: "u@example.invalid", plan: "Pro" };
  bar.setInfo({ env: ENV_A, account });
  await answer(bar, pending, snapshot(usage(1, 2, 1, 0), { account: { name: "U@Example.Invalid", email: "u@example.invalid" } }));
  bar.set({ connected: true });
  const tip = item.tooltip.value;
  const hits = tip.match(/[Uu]@[Ee]xample\.[Ii]nvalid/g) || [];
  assert.equal(hits.length, 1, "the address shows once, never as name and email. Tip: " + tip);
  assert.ok(tip.includes("**U@Example.Invalid**"), "the account row keeps the reported casing. Tip: " + tip);
  assert.ok(tip.includes("$(organization) Pro"), "the plan still shows. Tip: " + tip);
});

test("different emails keep the usage owner even when the names match", async () => {
  const { pending, reader } = manual();
  const { bar } = makeBar(reader);
  bar.setInfo({ env: ENV_A, account: { name: "Same name", email: "first@example.invalid" } });
  await answer(bar, pending, snapshot(usage(10, 100, 90, 0), { account: { name: "Same name", email: "second@example.invalid" } }));
  const row = bar.getUsageItem({ name: "Same name", email: "first@example.invalid" });
  assert.ok(row.detail.startsWith("Usage for second@example.invalid"), "the owner is kept. Detail: " + row.detail);
});

test("a name only match suppresses the owner while an unknown identity keeps it", async () => {
  const { pending, reader } = manual();
  const { bar } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot(usage(10, 100, 90, 0), { account: { name: "Only Name" } }));
  assert.ok(bar.getUsageItem().detail.startsWith("Usage for Only Name"), "no displayed account keeps the owner. Detail: " + bar.getUsageItem().detail);
  assert.ok(!bar.getUsageItem({ name: "Only Name" }).detail.includes("Usage for"), "the same name with no emails proves the same account. Detail: " + bar.getUsageItem({ name: "Only Name" }).detail);
  assert.ok(bar.getUsageItem({ name: "Other" }).detail.startsWith("Usage for Only Name"), "a different name keeps the owner. Detail: " + bar.getUsageItem({ name: "Other" }).detail);
  assert.ok(bar.getUsageItem({ name: "Only Name", email: "x@example.invalid" }).detail.startsWith("Usage for Only Name"), "an email on one side only cannot prove the same account. Detail: " + bar.getUsageItem({ name: "Only Name", email: "x@example.invalid" }).detail);
});

test("overage replaces the remainder in the detail lines", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  await answer(bar, pending, snapshot(usage(3100, 3000, 0, 100)));
  bar.set({ connected: true });
  const row = bar.getUsageItem();
  assert.equal(row.description, "3,100.00 / 3,000.00 ACU");
  assert.ok(row.detail.includes("Over the limit by 100.00 ACU"), "the overage is shown. Detail: " + row.detail);
  assert.ok(!row.detail.includes("ACU left"), "the remainder is not repeated. Detail: " + row.detail);
  assert.ok(item.tooltip.value.includes("Over the limit by 100.00 ACU"), "the hover shows it too. Tip: " + item.tooltip.value);
  assert.ok(!item.tooltip.value.includes("ACU left"), "and not the remainder. Tip: " + item.tooltip.value);
});

test("the hover leaves model, mode and CLI version to the connection details", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ version: "9.9.9", env: ENV_A, account: { name: "Account user", email: "u@example.invalid" } });
  bar.set({ connected: true, model: "MODEL-X", mode: "MODE-Y" });
  await answer(bar, pending, snapshot(usage(1, 2, 1, 0), { account: { name: "Account user", email: "u@example.invalid" } }));
  const tip = item.tooltip.value;
  assert.ok(!tip.includes("MODEL-X") && !tip.includes("MODE-Y") && !tip.includes("9.9.9"), "the technical strings moved to the menu. Tip: " + tip);
  assert.ok(tip.includes("u@example.invalid"), "the account still shows. Tip: " + tip);
  assert.ok(tip.includes("**1.00 / 2.00 ACU**"), "the usage still leads. Tip: " + tip);
});

test("account and plan metadata are escaped in the hover", async () => {
  const { pending, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A, account: { name: "A *name*", email: "a@example.invalid", plan: "Pro [x](https://evil.invalid)" } });
  await answer(bar, pending, snapshot(usage(1, 2, 1, 0), { account: { name: "Team *x* [link](https://example.invalid)" } }));
  bar.set({ connected: true });
  const tip = item.tooltip.value;
  assert.ok(tip.includes("A \\*name\\*"), "the name is escaped. Tip: " + tip);
  assert.ok(tip.includes("Pro \\[x\\]\\(https://evil.invalid\\)"), "the plan is escaped. Tip: " + tip);
  assert.ok(tip.includes("Usage for Team \\*x\\* \\[link\\]\\(https://example.invalid\\)"), "the API name owner is escaped too. Tip: " + tip);
  assert.deepEqual(item.tooltip.isTrusted, { enabledCommands: ["devin.focusChat"] }, "only the chat command is trusted");
});

test("dispose ends the loop and swallows every late trigger", async () => {
  const { pending, calls, reader } = manual();
  const { bar, item } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  const inFlight = bar.refreshUsage();
  assert.equal(pending.length, 1);
  bar.dispose();
  bar.dispose();
  // Nothing asked of a disposed bar starts work or repaints it.
  bar.setInfo({ env: ENV_B, account: { email: "x@example.invalid" } });
  bar.set({ connected: true });
  await bar.refreshUsage();
  assert.equal(calls.length, 1, "a disposed bar starts no new reads");
  pending[0](snapshot(usage(139.5, 3000, 2860.5, 0)));
  await inFlight;
  assert.equal(item.text, "$(debug-disconnect)", "a late answer cannot paint a disposed bar");
});

test("one polling loop survives repeated identical environments, and dispose ends it", async () => {
  const { pending, reader } = manual();
  const { bar } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  const first = pending.length;
  // Every chat surface hands the same environment over after its health check;
  // the shared bar must not start a loop per surface.
  bar.setInfo({ env: { ...ENV_A } });
  bar.setInfo({ env: { ...ENV_A } });
  assert.equal(pending.length, first, "identical environments start no extra reads");
  assert.ok(bar.usageTimer, "the interval exists while the bar lives");
  await answer(bar, pending, snapshot({ used: 1 }));
  const reads = pending.length;
  bar.dispose();
  assert.equal(pending.length, reads, "dispose starts nothing new");
});

test("in flight reads coalesce into one account request", async () => {
  const { pending, calls, reader } = manual();
  const { bar } = makeBar(reader);
  bar.setInfo({ env: ENV_A });
  const a = bar.refreshUsage();
  const b = bar.refreshUsage();
  assert.equal(a, b, "overlapping triggers share one read");
  assert.equal(calls.length, 1);
  pending[0](snapshot({ used: 1 }));
  await a;
});

test("the usage item mirrors each cached read state for the info menu", async () => {
  const { pending, reader } = manual();
  const { bar } = makeBar(reader);
  // Nothing has ever been asked: the row says so instead of guessing.
  assert.equal(bar.getUsageItem().description, "Usage has not been reported.");
  bar.setInfo({ env: ENV_A });
  // The first read the environment started is still in flight.
  assert.equal(bar.getUsageItem().description, "Refreshing account usage.");
  await answer(bar, pending, snapshot(undefined, { account: { id: "a1" } }));
  assert.equal(bar.getUsageItem().description, "No ACU quota reported");
  await answer(bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0), { account: { name: "Account user", email: "u@example.invalid" } }));
  const item = bar.getUsageItem();
  assert.equal(item.label, "$(graph) Cycle usage");
  assert.equal(item.description, "139.50 / 3,000.00 ACU");
  const parts = item.detail.split(" | ");
  assert.equal(parts[0], "Usage for u@example.invalid");
  assert.equal(parts[1], "2,860.50 ACU left");
  assert.match(parts[2], /^Last reported /);
  assert.ok(!item.detail.includes("\n"), "the detail is one rendered line. Detail: " + item.detail);
  const failing = bar.refreshUsage();
  pending[pending.length - 1](Promise.reject(new Error("down")));
  await failing;
  const stale = bar.getUsageItem();
  assert.equal(stale.description, "139.50 / 3,000.00 ACU", "a stale read keeps the figures");
  assert.match(stale.detail, /Refresh failed\. Showing the last report from/, "and says they are stale. Detail: " + stale.detail);
});

test("the usage item distinguishes a failed first read and an account switch", async () => {
  const { pending, reader } = manual();
  const { bar } = makeBar(reader);
  bar.setInfo({ env: ENV_A, account: { name: "Old user", email: "old@example.invalid" } });
  const failing = bar.refreshUsage();
  pending[pending.length - 1](Promise.reject(new Error("down")));
  await failing;
  const failed = bar.getUsageItem();
  assert.equal(failed.description, "Could not refresh account usage.");
  assert.equal(failed.detail, undefined, "no snapshot means no account or timestamp to show");
  // A successful read under the old account, then the sign-in changes: the
  // old figures drop out of the row the moment the identity does.
  const second = makeBar(reader);
  second.bar.setInfo({ env: ENV_A, account: { name: "Old user", email: "old@example.invalid" } });
  await answer(second.bar, pending, snapshot(usage(139.5, 3000, 2860.5, 0)));
  assert.match(second.bar.getUsageItem().description, /139\.50/);
  second.bar.setInfo({ env: ENV_A, account: { name: "New user", email: "new@example.invalid" } });
  assert.equal(second.bar.getUsageItem().description, "Refreshing account usage.", "the cleared quota reads as pending, not the old figures");
});

test.after(() => {
  for (const bar of bars) bar.dispose();
  fs.rmSync(TMP, { recursive: true, force: true });
});
