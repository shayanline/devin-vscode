// The status bar's click menu: the usage row and its refresh action come from
// the shared StatusBar's cache, so opening the menu never waits on a request,
// and picking refresh awaits the shared read before the menu reopens. The menu
// groups the account rows under one separator and the actions under another,
// with the technical readout one Connection details pick away.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChat, cleanup } = require("./chat-harness");

test.after(() => cleanup());

// A stand-in for the shared bar: the controller only ever asks it for the
// cached row and for one coalesced read, so those are the only members needed.
// The account the menu actually displays is recorded so a test can check the
// usage row's owner dedup got the right one.
function fakeBar(state, onRefresh) {
  return {
    getUsageItem: (displayedAccount) => {
      state.displayedAccount = displayedAccount;
      return { label: "$(graph) Cycle usage", description: state.usage };
    },
    refreshUsage: async () => {
      if (onRefresh) onRefresh();
      state.refreshes++;
      state.usage = "after refresh";
    },
    set() {},
    setInfo() {}
  };
}

// Drive showInfo with a scripted quick pick: `answer(items, opening)` decides
// what the user picks on each opening, and every opening's items are recorded.
async function menu(h, answer) {
  const vscode = globalThis.__dvVscode;
  const original = vscode.window.showQuickPick;
  const menus = [];
  vscode.window.showQuickPick = async (items) => {
    menus.push(items);
    return answer(items, menus.length);
  };
  try {
    await h.controller.showInfo();
  } finally {
    vscode.window.showQuickPick = original;
    h.controller.statusBar = undefined;
    await h.dispose();
  }
  return menus;
}

test("the info menu groups account and actions without fetching", async () => {
  const h = createChat();
  const vscode = globalThis.__dvVscode;
  const sep = vscode.QuickPickItemKind.Separator;
  const state = { usage: "139.50 / 3,000.00 ACU", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, () => undefined);
  assert.equal(menus.length, 1, "a dismissed pick opens the menu once");
  assert.equal(state.refreshes, 0, "opening the menu never refreshes");
  const items = menus[0];
  assert.equal(items[0].label, "Account");
  assert.equal(items[0].kind, sep, "the account group opens with a separator");
  const usage = items.find((i) => i.label === "$(graph) Cycle usage");
  assert.ok(usage, "the cached usage row is listed first in its group");
  assert.equal(usage.description, state.usage);
  const actionsAt = items.findIndex((i) => i.label === "Actions" && i.kind === sep);
  assert.ok(actionsAt > items.indexOf(usage), "the actions group follows the account rows");
  const actions = items.slice(actionsAt + 1);
  const labels = actions.map((i) => i.label);
  for (const label of ["$(comment-discussion) Open chat", "$(link-external) Open Devin Cloud", "$(info) Connection details"]) {
    assert.ok(labels.includes(label), label + " is an action");
  }
  const refresh = items.find((i) => i.action === "refreshUsage");
  assert.ok(refresh, "the refresh action is listed");
  assert.ok(labels.indexOf("$(refresh) Refresh account usage") > labels.indexOf("$(link-external) Open Devin Cloud"), "refresh sits with the other actions");
  // The entries that were already there are preserved: cloud always, and the
  // sign-in row while the health check has not reported a session.
  assert.ok(items.some((i) => i.action === "cloud"), "Open Devin Cloud is still listed");
  assert.ok(items.some((i) => i.action === "login"), "the sign-in row is still listed");
  // Nothing repeats what the hover or the details pick already says.
  assert.ok(!items.some((i) => (i.detail || "").includes("https://app.devin.ai")), "no raw URL detail");
  assert.ok(!items.some((i) => i.label.startsWith("$(versions)")), "no CLI version row in the root menu");
  assert.ok(!items.some((i) => i.label.startsWith("$(sparkle)")), "no raw model or mode row in the root menu");
});

test("a ready CLI shows one identity row with the plan in its detail", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: true, version: "1.2.3", account: { name: "Account user", email: "u@example.invalid", plan: "Pro" } };
  h.controller.currentModel = "MODEL-X";
  h.controller.currentMode = "MODE-Y";
  const state = { usage: "139.50 / 3,000.00 ACU", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, () => undefined);
  const items = menus[0];
  const identity = items.find((i) => i.label === "$(account) Account user");
  assert.ok(identity, "one identity row is listed");
  assert.equal(identity.description, "u@example.invalid", "the email describes the row once");
  assert.equal(identity.detail, "Pro", "the plan rides in the detail");
  assert.ok(!items.some((i) => i.label === "$(organization) Pro"), "no separate plan row");
  assert.ok(!items.some((i) => i.action === "login"), "the sign-in row is gone once ready");
  assert.deepEqual(state.displayedAccount, { name: "Account user", email: "u@example.invalid", plan: "Pro" }, "the usage row got the displayed account");
  assert.ok(!items.some((i) => (i.description || "").includes("MODEL-X") || (i.detail || "").includes("MODE-Y")), "the technical strings stay out of the root menu");
  assert.ok(!items.some((i) => (i.detail || "").includes("1.2.3")), "the CLI version stays out of the root menu");
});

test("an identity named by its own email does not repeat it in the description", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: true, version: "1.2.3", account: { name: "U@Example.Invalid", email: "u@example.invalid", plan: "Pro" } };
  const state = { usage: "x", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, () => undefined);
  const identity = menus[0].find((i) => i.label.startsWith("$(account)"));
  assert.ok(identity, "the identity row is listed");
  assert.equal(identity.description, undefined, "the address is not repeated under itself");
  assert.equal(identity.detail, "Pro", "the plan still rides in the detail");
});

test("the usage row gets no displayed account when no identity row exists", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: false, version: "1.2.3" };
  const state = { usage: "139.50 / 3,000.00 ACU", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, () => undefined);
  const items = menus[0];
  assert.equal(state.displayedAccount, undefined, "no identity row means no dedup context");
  assert.ok(items.some((i) => i.action === "login"), "the sign-in row is preserved while not ready");
  assert.ok(!items.some((i) => i.label.startsWith("$(account)")), "no identity row while not ready");
});

test("a ready CLI with a plan but no identity keeps one plan row", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: true, version: "1.2.3", account: { plan: "Pro" } };
  const state = { usage: "139.50 / 3,000.00 ACU", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, () => undefined);
  const items = menus[0];
  assert.ok(items.some((i) => i.label === "$(organization) Pro"), "the plan row is retained");
  assert.equal(state.displayedAccount, undefined, "a plan is not an identity, so no dedup context");
});

test("connection details opens a second menu and back returns without fetching", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: true, version: "1.2.3", account: { name: "Account user" } };
  h.controller.currentModel = "MODEL-X";
  h.controller.currentMode = "MODE-Y";
  const state = { usage: "139.50 / 3,000.00 ACU", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, (items, opening) => {
    if (opening === 1) {
      return items.find((i) => i.action === "details");
    }
    if (opening === 2) {
      return items.find((i) => i.action === "back");
    }
    return undefined;
  });
  assert.equal(menus.length, 3, "root, details, then back to the root");
  assert.equal(state.refreshes, 0, "details and back never fetch");
  const details = menus[1];
  assert.equal(details[0].label, "$(arrow-left) Back to Devin");
  assert.equal(details[0].action, "back");
  assert.equal(details.find((i) => i.label === "Model").description, "MODEL-X");
  assert.equal(details.find((i) => i.label === "Mode").description, "MODE-Y");
  assert.equal(details.find((i) => i.label === "Devin CLI").description, "1.2.3");
});

test("picking an informational details row closes without reopening", async () => {
  const h = createChat();
  h.controller.health = { path: "/fake/devin", found: true, loggedIn: true, version: "1.2.3" };
  const state = { usage: "x", refreshes: 0 };
  h.controller.statusBar = fakeBar(state);
  const menus = await menu(h, (items, opening) => {
    if (opening === 1) {
      return items.find((i) => i.action === "details");
    }
    // The second opening is the details pick: choose the Model row itself.
    return items.find((i) => i.label === "Model");
  });
  assert.equal(menus.length, 2, "root then details, nothing after the informational pick");
  assert.equal(state.refreshes, 0);
});

test("the chat action runs the focus command and cloud opens the site", async () => {
  const h1 = createChat();
  const h2 = createChat();
  const vscode = globalThis.__dvVscode;
  const calls = [];
  const originalExec = vscode.commands.executeCommand;
  const originalOpen = vscode.env.openExternal;
  vscode.commands.executeCommand = async (id) => { calls.push("cmd:" + id); };
  vscode.env.openExternal = async (uri) => { calls.push("uri:" + uri.toString()); };
  try {
    h1.controller.statusBar = fakeBar({ usage: "x", refreshes: 0 });
    await menu(h1, (items, opening) => (opening === 1 ? items.find((i) => i.action === "chat") : undefined));
    h2.controller.statusBar = fakeBar({ usage: "x", refreshes: 0 });
    await menu(h2, (items, opening) => (opening === 1 ? items.find((i) => i.action === "cloud") : undefined));
  } finally {
    vscode.commands.executeCommand = originalExec;
    vscode.env.openExternal = originalOpen;
  }
  assert.deepEqual(calls, ["cmd:devin.focusChat", "uri:https://app.devin.ai"]);
});

test("picking refresh awaits the shared read and reopens on the new cache", async () => {
  const h = createChat();
  const state = { usage: "before refresh", refreshes: 0 };
  const events = [];
  h.controller.statusBar = fakeBar(state, () => events.push("refresh"));
  const menus = await menu(h, (items, opening) => {
    events.push("menu");
    // First opening the user picks refresh, the reopened menu they dismiss.
    return opening === 1 ? items.find((i) => i.action === "refreshUsage") : undefined;
  });
  assert.equal(state.refreshes, 1, "the pick ran exactly one refresh");
  assert.deepEqual(events, ["menu", "refresh", "menu"], "open, awaited refresh, reopen");
  assert.equal(menus.length, 2, "the menu reopened after the refresh");
  const first = menus[0].find((i) => i.label === "$(graph) Cycle usage");
  const second = menus[1].find((i) => i.label === "$(graph) Cycle usage");
  assert.equal(first.description, "before refresh");
  assert.equal(second.description, "after refresh", "the reopened menu shows the updated cached row");
});
