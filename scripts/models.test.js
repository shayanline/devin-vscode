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
  }
  for (const uid of ["swe-2-flash-medium", "swe-2-flash-high", "swe-2-flash-max"]) {
    assert.equal(variantOf(families, "swe-2-flash", uid).promotion, "25% off", uid);
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

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
