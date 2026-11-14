const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-models-"));
function loadModels(name) {
  const outfile = path.join(TMP, name + ".js");
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "src/cli/models.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "error"
  });
  return require(outfile);
}

const { listModelFamilies } = loadModels("models");
const noStatus = async () => undefined;

function fakeCli(stdout) {
  const js = path.join(TMP, "devin.js");
  const shim = path.join(TMP, process.platform === "win32" ? "devin.cmd" : "devin.sh");
  fs.writeFileSync(js, `process.stdout.write(${JSON.stringify(stdout)});`);
  if (process.platform === "win32") {
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${js}"\r\n`);
  } else {
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`);
    fs.chmodSync(shim, 0o755);
  }
  return shim;
}

test("model listing preserves cost, limits, promotion, and status metadata", async () => {
  const families = await listModelFamilies(fakeCli(JSON.stringify({
    families: [{
      family_label: "Claude",
      slug: "claude",
      variants: [{
        model_uid: "claude-medium",
        label: "Claude Medium",
        cost_tier: "Med cost",
        cost_summary: "$2 / MTok In · $10 / MTok Out",
        long_context_cost_summary: "$4 / MTok In · $20 / MTok Out",
        description: "Powerful",
        max_context_tokens: 1000000,
        max_output_tokens: 128000,
        is_promo: true,
        is_new: true,
        is_beta: false
      }]
    }]
  })), undefined, noStatus);

  assert.deepStrictEqual(families[0].variants[0], {
    value: "claude-medium",
    name: "Medium",
    costTier: "Med cost",
    costSummary: "$2 / MTok In · $10 / MTok Out",
    longContextCostSummary: "$4 / MTok In · $20 / MTok Out",
    description: "Powerful",
    maxContextTokens: 1000000,
    maxOutputTokens: 128000,
    promotion: "PROMO",
    isNew: true,
    isBeta: false
  });
});

test("concurrent model listings share one CLI process", { skip: process.platform === "win32" }, async () => {
  const { listModelFamilies: list } = loadModels("models-concurrent");
  const log = path.join(TMP, "models.log");
  const js = path.join(TMP, "slow-models.js");
  const cli = path.join(TMP, "slow-models.sh");
  fs.writeFileSync(js, `require("fs").appendFileSync(process.env.MODELS_LOG, "x"); setTimeout(() => process.stdout.write('{"families":[]}'), 100);`);
  fs.writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`);
  fs.chmodSync(cli, 0o755);

  await Promise.all([
    list(cli, { ...process.env, MODELS_LOG: log }, noStatus),
    list(cli, { ...process.env, MODELS_LOG: log }, noStatus)
  ]);

  assert.strictEqual(fs.readFileSync(log, "utf8"), "x");
});

const sweCatalog = {
  families: [
    {
      family_label: "SWE-2", slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", is_new: false, is_beta: false },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium", is_new: false, is_beta: false },
        { model_uid: "swe-2-max", label: "SWE-2 Max", is_new: false, is_beta: false }
      ]
    },
    {
      family_label: "SWE-2 Flash", slug: "swe-2-flash",
      variants: [
        { model_uid: "swe-2-flash-medium", label: "SWE-2 Flash Medium" },
        { model_uid: "swe-2-flash-high", label: "SWE-2 Flash High" },
        { model_uid: "swe-2-flash-max", label: "SWE-2 Flash Max" }
      ]
    },
    {
      family_label: "Claude", slug: "claude",
      variants: [{ model_uid: "claude-medium", label: "Claude Medium", is_new: true, promotion: "CLI OFFER" }]
    }
  ]
};

const sweStatus = {
  userStatus: {
    cascadeModelConfigData: {
      clientModelConfigs: [
        { modelUid: "swe-2-high", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "83% off" } },
        { modelUid: "swe-2-medium", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "83% off" } },
        { modelUid: "swe-2-max", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "83% off" } },
        { modelUid: "swe-2-flash-medium", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "25% off" } },
        { modelUid: "swe-2-flash-high", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "25% off" } },
        { modelUid: "swe-2-flash-max", isNew: false, isBeta: false, promoStatus: { isActive: true, label: "25% off" } }
      ]
    }
  }
};

function variantOf(families, familyId, uid) {
  return families.find((f) => f.id === familyId).variants.find((v) => v.value === uid);
}

test("account status promotions enrich exact model uids the CLI omits", async () => {
  const { listModelFamilies: list } = loadModels("models-status-promo");
  const families = await list(fakeCli(JSON.stringify(sweCatalog)), undefined, async () => sweStatus);
  for (const uid of ["swe-2-high", "swe-2-medium", "swe-2-max"]) {
    assert.equal(variantOf(families, "swe-2", uid).promotion, "83% off", uid);
    assert.equal(variantOf(families, "swe-2", uid).promotionEndDate, undefined, `${uid} has no reported end date`);
  }
  for (const uid of ["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"]) {
    assert.equal(variantOf(families, "swe-2-flash", uid).promotion, "25% off", uid);
    assert.equal(variantOf(families, "swe-2-flash", uid).promotionEndDate, undefined, `${uid} has no reported end date`);
  }
  const claude = variantOf(families, "claude", "claude-medium");
  assert.equal(claude.promotion, "CLI OFFER", "a variant with no status row keeps its CLI offer");
  assert.equal(claude.isNew, true, "a variant with no status row keeps its CLI flags");
});

test("snake case status fields carry the same badge signals", async () => {
  const { listModelFamilies: list } = loadModels("models-status-snake");
  const cli = fakeCli(JSON.stringify({
    families: [{
      family_label: "SWE-2", slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", is_new: false, is_beta: false },
        { model_uid: "swe-2-high-fast", label: "SWE-2 High Fast" }
      ]
    }]
  }));
  const status = {
    user_status: {
      cascade_model_config_data: {
        client_model_configs: [
          { model_uid: "swe-2-high", is_new: true, is_beta: true, promo_status: { is_active: true, label: "  " } }
        ]
      }
    }
  };
  const families = await list(cli, undefined, async () => status);
  const high = variantOf(families, "swe-2", "swe-2-high");
  assert.equal(high.isNew, true, "status true overrides CLI false");
  assert.equal(high.isBeta, true);
  assert.equal(high.promotion, "PROMO", "a blank active label falls back to PROMO");
  const fast = variantOf(families, "swe-2", "swe-2-high-fast");
  assert.equal(fast.isNew, undefined, "a Fast uid never borrows the standard row's flags");
  assert.equal(fast.promotion, undefined);
  assert.equal(fast.promotionEndDate, undefined);
});

test("account status promotion end dates reach exact model variants", async () => {
  const { listModelFamilies: list } = loadModels("models-status-enddate");
  const sweEnd = "2027-01-01T07:59:59.999999999Z";
  const flashEnd = "2026-11-18T18:00:00Z";
  const status = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { modelUid: "swe-2-high", promoStatus: { isActive: true, label: "83% off", endDate: sweEnd } },
          { modelUid: "swe-2-medium", promoStatus: { isActive: true, label: "83% off", endDate: sweEnd } },
          { modelUid: "swe-2-max", promoStatus: { isActive: true, label: "83% off", endDate: sweEnd } },
          { modelUid: "swe-2-flash-medium", promoStatus: { isActive: true, label: "25% off", endDate: flashEnd } },
          { modelUid: "swe-2-flash-high", promoStatus: { isActive: true, label: "25% off", endDate: flashEnd } },
          { modelUid: "swe-2-flash-max", promoStatus: { isActive: true, label: "25% off", endDate: flashEnd } },
          { modelUid: "claude-medium", promoStatus: { isActive: false, label: "OLD OFFER", endDate: sweEnd } }
        ]
      }
    }
  };
  const families = await list(fakeCli(JSON.stringify(sweCatalog)), undefined, async () => status);
  for (const uid of ["swe-2-high", "swe-2-medium", "swe-2-max"]) {
    const variant = variantOf(families, "swe-2", uid);
    assert.equal(variant.promotion, "83% off", uid);
    assert.equal(variant.promotionEndDate, sweEnd, `${uid} keeps the nine digit timestamp verbatim`);
  }
  for (const uid of ["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"]) {
    const variant = variantOf(families, "swe-2-flash", uid);
    assert.equal(variant.promotion, "25% off", uid);
    assert.equal(variant.promotionEndDate, flashEnd, uid);
  }
  const claude = variantOf(families, "claude", "claude-medium");
  assert.equal(claude.promotion, undefined, "an inactive promo clears the stale CLI offer");
  assert.equal(claude.promotionEndDate, undefined, "an inactive promo carries no end date");
});

test("snake case status promo fields carry the end date", async () => {
  const { listModelFamilies: list } = loadModels("models-status-enddate-snake");
  const cli = fakeCli(JSON.stringify({
    families: [{
      family_label: "SWE-2 Flash", slug: "swe-2-flash",
      variants: [
        { model_uid: "swe-2-flash-high", label: "SWE-2 Flash High" },
        { model_uid: "swe-2-flash-max", label: "SWE-2 Flash Max" }
      ]
    }]
  }));
  const status = {
    user_status: {
      cascade_model_config_data: {
        client_model_configs: [
          { model_uid: "swe-2-flash-high", promo_status: { is_active: true, label: "25% off", end_date: "2026-11-18T18:00:00Z" } },
          { model_uid: "swe-2-flash-max", promo_status: { is_active: true, label: "25% off", end_date: "   " } }
        ]
      }
    }
  };
  const families = await list(cli, undefined, async () => status);
  assert.equal(variantOf(families, "swe-2-flash", "swe-2-flash-high").promotionEndDate, "2026-11-18T18:00:00Z");
  assert.equal(variantOf(families, "swe-2-flash", "swe-2-flash-max").promotionEndDate, undefined, "a blank end date stays absent");
});

test("reported status rows clear stale CLI badge fields", async () => {
  const { listModelFamilies: list } = loadModels("models-status-clear");
  const cli = fakeCli(JSON.stringify({
    families: [{
      family_label: "SWE-2", slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High", is_new: false, is_beta: true, promotion: "CLI OFFER" },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium", is_new: true, is_beta: false, promotion: "OLD OFFER" }
      ]
    }]
  }));
  const status = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { modelUid: "swe-2-high", isNew: true },
          { modelUid: "swe-2-medium", isNew: false, promoStatus: { isActive: false, label: "OLD OFFER" } }
        ]
      }
    }
  };
  const families = await list(cli, undefined, async () => status);
  const high = variantOf(families, "swe-2", "swe-2-high");
  assert.equal(high.isNew, true);
  assert.equal(high.isBeta, false, "an omitted flag on a reported row means false");
  assert.equal(high.promotion, undefined, "an absent promoStatus clears the stale CLI offer");
  const medium = variantOf(families, "swe-2", "swe-2-medium");
  assert.equal(medium.isNew, false, "explicit false overrides CLI true");
  assert.equal(medium.isBeta, false);
  assert.equal(medium.promotion, undefined, "an inactive labelled promotion clears the stale offer");
});

test("unavailable or malformed status keeps the CLI listing usable", async () => {
  const cli = fakeCli(JSON.stringify(sweCatalog));
  const readers = [
    ["models-status-reject", async () => { throw new Error("status down"); }],
    ["models-status-undefined", async () => undefined],
    ["models-status-garbage", async () => "not json at all"],
    ["models-status-shape", async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: "nope" } } })]
  ];
  for (const [name, reader] of readers) {
    const { listModelFamilies: list } = loadModels(name);
    const families = await list(cli, undefined, reader);
    const swe2 = families.find((f) => f.id === "swe-2");
    assert.equal(swe2.variants.length, 3, name);
    assert.ok(swe2.variants.every((v) => v.promotion === undefined), name);
    assert.equal(variantOf(families, "claude", "claude-medium").promotion, "CLI OFFER", name);
  }
});

test("an empty CLI listing never reads account status", async () => {
  const { listModelFamilies: list } = loadModels("models-status-empty");
  let reads = 0;
  const families = await list(fakeCli('{"families":[]}'), undefined, async () => { reads++; return sweStatus; });
  assert.equal(reads, 0);
  assert.deepEqual(families, []);
});

test("cached and concurrent listings share one status read", { skip: process.platform === "win32" }, async () => {
  const { listModelFamilies: list } = loadModels("models-status-shared");
  let reads = 0;
  const cli = fakeCli(JSON.stringify(sweCatalog));
  const reader = async () => { reads++; return sweStatus; };
  const [a, b] = await Promise.all([list(cli, undefined, reader), list(cli, undefined, reader)]);
  assert.equal(reads, 1, "concurrent callers share the pending listing and its status read");
  assert.equal(a, b);
  await list(cli, undefined, reader);
  assert.equal(reads, 1, "a cache hit does not read status again");
});

test("default model listing reads promotion signals with the native CLI client metadata", async () => {
  const { listModelFamilies: list } = loadModels("models-status-native");
  const cli = fakeCli(JSON.stringify(sweCatalog));
  const env = {
    ...process.env,
    HOME: TMP,
    XDG_DATA_HOME: TMP,
    APPDATA: TMP,
    WINDSURF_API_KEY: "dummy-status-key",
    WINDSURF_API_SERVER_URL: "https://models.invalid"
  };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const metadata = JSON.parse(init.body).metadata;
    const native = metadata.ideName === "chisel"
      && metadata.ideVersion === "0.0.0-dev"
      && metadata.extensionName === "chisel"
      && metadata.extensionVersion === "0.0.0-dev";
    return {
      ok: true,
      json: async () => (native ? sweStatus : { userStatus: { cascadeModelConfigData: {} } })
    };
  };
  let families;
  try {
    families = await list(cli, env);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1, "one GetUserStatus read per listing");
  assert.equal(calls[0].url, "https://models.invalid/exa.seat_management_pb.SeatManagementService/GetUserStatus");
  assert.equal(calls[0].init.method, "POST");
  for (const uid of ["swe-2-high", "swe-2-medium", "swe-2-max"]) {
    assert.equal(variantOf(families, "swe-2", uid).promotion, "83% off", uid);
  }
  for (const uid of ["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"]) {
    assert.equal(variantOf(families, "swe-2-flash", uid).promotion, "25% off", uid);
  }
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
