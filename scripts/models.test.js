const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "devin-models-"));
const outfile = path.join(TMP, "models.js");
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/cli/models.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error"
});
const { listModelFamilies } = require(outfile);

function fakeCli(stdout) {
  const js = path.join(TMP, "devin.js");
  const sh = path.join(TMP, "devin.sh");
  fs.writeFileSync(js, `process.stdout.write(${JSON.stringify(stdout)});`);
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)}\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

test("model listing preserves cost and status metadata", async () => {
  const families = await listModelFamilies(fakeCli(JSON.stringify({
    families: [{
      family_label: "Claude",
      slug: "claude",
      variants: [{
        model_uid: "claude-medium",
        label: "Claude Medium",
        cost_tier: "Med cost",
        cost_summary: "$2 / MTok In · $10 / MTok Out",
        is_new: true,
        is_beta: false
      }]
    }]
  })));

  assert.deepStrictEqual(families[0].variants[0], {
    value: "claude-medium",
    name: "Medium",
    costTier: "Med cost",
    costSummary: "$2 / MTok In · $10 / MTok Out",
    isNew: true,
    isBeta: false
  });
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
