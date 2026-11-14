const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/cli/modelId.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error"
});
const compiled = { exports: {} };
new Function("module", "exports", bundle.outputFiles[0].text)(compiled, compiled.exports);
const { modelIdentity, fusionIdentity, fusionModelKey, EFFORT_ORDER } = compiled.exports;

test("model identities separate every effort from Fast and priority speed", () => {
  for (const effort of EFFORT_ORDER) {
    for (const suffix of ["", "-fast", "-priority"]) {
      assert.deepEqual(modelIdentity(`gpt-6-1-sol-${effort}${suffix}`), {
        id: "gpt-6-1-sol", effort, speed: suffix ? "fast" : "standard"
      });
    }
  }
  assert.deepEqual(modelIdentity("swe-1-7"), { id: "swe-1-7", effort: "", speed: "standard" });
  assert.equal(modelIdentity("swe-2-flash-max").id, "swe-2-flash");
});

test("Fusion identities retain the complete sub model uid", () => {
  assert.deepEqual(fusionIdentity("fusion-claude-opus-5-5-max-fast-sidekick-gpt-6-luna-high-priority"), {
    lead: "claude-opus-5-5", effort: "max", speed: "fast",
    sidekick: "gpt-6-luna-high-priority", subModel: "gpt-6-luna", subEffort: "high", subSpeed: "fast"
  });
});

test("Fusion model keys normalize the Lead but keep the complete Sub uid", () => {
  const prioritySub = "sidekick-gpt-6-luna-high-priority";
  assert.equal(
    fusionModelKey(`fusion-gpt-6-1-sol-high-${prioritySub}`),
    fusionModelKey(`fusion-gpt-6-1-sol-max-fast-${prioritySub}`),
    "Lead high and Lead max-fast share the key for the same complete Sub uid"
  );
  assert.notEqual(
    fusionModelKey("fusion-gpt-6-1-sol-high-sidekick-gpt-6-luna-high"),
    fusionModelKey(`fusion-gpt-6-1-sol-high-${prioritySub}`),
    "a standard Luna sub and a priority Luna sub are different pairs"
  );
  assert.equal(fusionModelKey("gpt-6-luna-high-priority"), undefined, "non-Fusion uids have no key");
});
