const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/cli/accountUsage.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error"
});
const compiled = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0].text)(compiled, compiled.exports, require);
const { parseAccountUsage, fetchAccountUsage, fetchAccountStatus } = compiled.exports;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devin-account-usage-"));
let sequence = 0;

function credentials(raw = 'windsurf_api_key = "test-key"\napi_server_url = "https://quota.invalid"\n') {
  const home = path.join(tmp, String(++sequence));
  const data = path.join(home, "data");
  const dir = path.join(data, "devin");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "credentials.toml");
  fs.writeFileSync(file, raw);
  return { env: { HOME: home, XDG_DATA_HOME: data }, file };
}

const status = {
  userId: "account-user", teamId: "account-team", name: "Account user", email: "user@example.invalid",
  planStatus: { acuConsumed: 139.5, acuLimit: 3000 }
};
const reply = (json, code = 200) => new Response(JSON.stringify(json), { status: code });

test("account usage projects the reported ACU budget and account identity", () => {
  const result = parseAccountUsage({ userStatus: status }, 1000);
  assert.deepEqual(result, {
    usage: { used: 139.5, limit: 3000, remaining: 2860.5, overage: 0 },
    fetchedAt: 1000,
    account: { id: "account-user", teamId: "account-team", name: "Account user", email: "user@example.invalid" }
  });
  const snake = parseAccountUsage({ user_status: {
    user_id: "snake-user", team_id: "snake-team",
    plan_status: { acu_consumed: 0, acu_limit: 0 }
  } }, 1000);
  assert.deepEqual(snake.usage, { used: 0, limit: 0, remaining: 0, overage: 0 });
  assert.equal(snake.account.id, "snake-user");
  assert.equal(snake.account.teamId, "snake-team");
});

test("unreported account fields cannot become zero, unlimited or a dollar quota", () => {
  for (const value of [undefined, {}, { planStatus: {} }, { planStatus: { acuLimit: 3000 } }]) {
    assert.equal(parseAccountUsage(value).usage, undefined);
  }
  assert.deepEqual(parseAccountUsage({ planStatus: { acuConsumed: 4 } }).usage, { used: 4 });
  assert.deepEqual(parseAccountUsage({ planStatus: { acuConsumed: 4, dollarsLimit: 100 } }).usage, { used: 4 });
  assert.equal(parseAccountUsage({ planStatus: { acuConsumed: "4", acuLimit: 3000 } }).usage, undefined);
  assert.equal(parseAccountUsage({ planStatus: { acuConsumed: -1, acuLimit: 3000 } }).usage, undefined);
});

test("the usage read uses the CLI credential and exact GetUserStatus request without exposing the key", async () => {
  const { env } = credentials();
  const calls = [];
  const result = await fetchAccountUsage(env, async (url, init) => {
    calls.push({ url, init });
    return reply({ userStatus: status, apiKey: "test-key" });
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://quota.invalid/exa.seat_management_pb.SeatManagementService/GetUserStatus");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["Connect-Protocol-Version"], "1");
  assert.deepEqual(JSON.parse(init.body), {
    metadata: {
      apiKey: "test-key",
      ideName: "devin",
      ideVersion: "0.0.0",
      extensionName: "devin-vscode",
      extensionVersion: "0.0.0",
      locale: "en"
    }
  });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(result.usage, { used: 139.5, limit: 3000, remaining: 2860.5, overage: 0 });
  assert.ok(Number.isFinite(result.fetchedAt));
  assert.ok(!JSON.stringify(result).includes("test-key"));
});

test("environment credentials and server override the stored account", async () => {
  const { env } = credentials();
  env.WINDSURF_API_KEY = "environment-key";
  env.WINDSURF_API_SERVER_URL = "https://environment.invalid/api/";
  const result = await fetchAccountUsage(env, async (url, init) => {
    assert.equal(url, "https://environment.invalid/api/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    assert.equal(init.headers.Authorization, "Bearer environment-key");
    return reply({ planStatus: { acuConsumed: 0, acuLimit: 3000 } });
  });
  assert.equal(result.usage.used, 0);
  assert.equal(result.usage.remaining, 3000);
});

test("unrelated Cloud and lowercase keys cannot replace the CLI account credential", async () => {
  const { env } = credentials();
  env.DEVIN_API_KEY = "cloud-key";
  env.windsurf_api_key = "lowercase-key";
  await fetchAccountUsage(env, async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(JSON.parse(init.body).metadata.apiKey, "test-key");
    return reply({ userStatus: status });
  });

  const signedOut = credentials("# No CLI credential is stored.\n").env;
  signedOut.DEVIN_API_KEY = "cloud-key";
  let requested = false;
  const result = await fetchAccountUsage(signedOut, async () => {
    requested = true;
    throw new Error("An unrelated credential must not be sent.");
  });
  assert.equal(requested, false);
  assert.equal(result.usage, undefined);
});

test("literal TOML credentials and comments are accepted without broad TOML parsing", async () => {
  const { env } = credentials("windsurf_api_key = 'literal-key' # private\napi_server_url = 'https://literal.invalid'\n[ignored]\nwindsurf_api_key = 'wrong-key'\n");
  await fetchAccountUsage(env, async (url, init) => {
    assert.equal(url, "https://literal.invalid/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    assert.equal(init.headers.Authorization, "Bearer literal-key");
    return reply({ userStatus: status });
  });
});

test("signed out accounts do not make a request or return an old quota", async () => {
  const { env } = credentials("# No key is stored.\n");
  let requested = false;
  const result = await fetchAccountUsage(env, async () => { requested = true; throw new Error("Unexpected request"); });
  assert.equal(requested, false);
  assert.equal(result.usage, undefined);
});

test("unsafe account endpoints are rejected before any credential is sent", async () => {
  for (const server of ["http://external.invalid", "https://user:password@quota.invalid", "https://quota.invalid?key=bad", "https://quota.invalid#fragment", "file:///tmp/status"]) {
    const { env } = credentials();
    env.DEVIN_API_SERVER_URL = server;
    let requested = false;
    await assert.rejects(fetchAccountUsage(env, async () => { requested = true; }), /Could not refresh account ACU usage/);
    assert.equal(requested, false);
  }
});

test("explicit local loopback account services remain usable", async () => {
  const { env } = credentials();
  env.DEVIN_API_SERVER_URL = "http://127.0.0.1:1234";
  await fetchAccountUsage(env, async (url) => {
    assert.equal(url, "http://127.0.0.1:1234/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    return reply({ userStatus: status });
  });
});

test("account changes while the response is in flight cannot publish another account's quota", async () => {
  const { env, file } = credentials();
  await assert.rejects(fetchAccountUsage(env, async () => {
    fs.writeFileSync(file, 'windsurf_api_key = "different-account-key"\napi_server_url = "https://quota.invalid"\n');
    return reply({ userStatus: status });
  }), /Could not refresh account ACU usage/);
});

test("HTTP and transport failures expose only a sanitized usage error", async () => {
  const { env } = credentials();
  await assert.rejects(fetchAccountUsage(env, async () => reply({ message: "test-key" }, 401)), {
    message: "Could not refresh account ACU usage."
  });
  await assert.rejects(fetchAccountUsage(env, async () => { throw new Error("transport test-key"); }), {
    message: "Could not refresh account ACU usage."
  });
});

test("the raw status reader returns the unprojected response through the same authenticated request", async () => {
  const { env } = credentials();
  const calls = [];
  const raw = {
    userStatus: {
      ...status,
      cascadeModelConfigData: { clientModelConfigs: [{ modelUid: "swe-2-high", promoStatus: { isActive: true, label: "83% off" } }] }
    },
    apiKey: "test-key"
  };
  const result = await fetchAccountStatus(env, async (url, init) => {
    calls.push({ url, init });
    return reply(raw);
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://quota.invalid/exa.seat_management_pb.SeatManagementService/GetUserStatus");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.Authorization, "Bearer test-key");
  assert.equal(init.headers["Connect-Protocol-Version"], "1");
  assert.deepEqual(JSON.parse(init.body).metadata, {
    apiKey: "test-key",
    ideName: "devin",
    ideVersion: "0.0.0",
    extensionName: "devin-vscode",
    extensionVersion: "0.0.0",
    locale: "en"
  });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(result, raw, "the raw catalogue reaches the host unprojected");
});

test("the raw status reader signs out cleanly and sanitises failures", async () => {
  const signedOut = credentials("# No CLI credential is stored.\n").env;
  let requested = false;
  assert.equal(await fetchAccountStatus(signedOut, async () => { requested = true; return reply({}); }), undefined);
  assert.equal(requested, false);
  const { env } = credentials();
  await assert.rejects(fetchAccountStatus(env, async () => reply({ message: "test-key" }, 401)), {
    message: "Could not refresh account status."
  });
  await assert.rejects(fetchAccountStatus(env, async () => { throw new Error("transport test-key"); }), {
    message: "Could not refresh account status."
  });
});

test("the raw status reader rejects a response for a changed account", async () => {
  const { env, file } = credentials();
  await assert.rejects(fetchAccountStatus(env, async () => {
    fs.writeFileSync(file, 'windsurf_api_key = "different-account-key"\napi_server_url = "https://quota.invalid"\n');
    return reply({ userStatus: status });
  }), { message: "Could not refresh account status." });
});

test("credential and endpoint failures reject with only the safe status error", async () => {
  const malformed = credentials('windsurf_api_key = "dummy-secret-\\q"\napi_server_url = "https://quota.invalid"\n');
  const { env } = credentials();
  env.WINDSURF_API_SERVER_URL = "https://dummy-secret:pw@[";
  for (const bad of [malformed.env, env]) {
    let requested = false;
    const fetcher = async () => { requested = true; return reply({}); };
    await assert.rejects(fetchAccountStatus(bad, fetcher), {
      message: "Could not refresh account status."
    });
    await assert.rejects(fetchAccountUsage(bad, fetcher), {
      message: "Could not refresh account ACU usage."
    });
    assert.equal(requested, false);
  }
});

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
