// Tests for scripts/release-version.js, the release workflow's version gate.
// Each case builds a real throwaway git repository and runs the actual script
// as a child process, so the git decisions under test are the real ones: no
// mocks, no network remotes, and every fixture owns and removes its own
// directory. Git runs with signing and hooks off and an isolated author, so
// machine configuration cannot leak into the fixtures.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "release-version.js");
const EXPECTED_OUTPUT = "version=1.2.4\ntag=v1.2.4\nvsix=devin-vscode-1.2.4.vsix\n";

// A repository with a base commit at version 1.2.3 and a second commit moving
// to `current` (1.2.4 unless a case overrides it). The base manifest is compact
// and the bump pretty printed, so the second commit always has changes even
// when the version itself is unchanged.
function fixture(t, { current = "1.2.4" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release version test "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, "empty-hooks");
  const gitconfig = path.join(dir, "gitconfig");
  fs.mkdirSync(hooks);
  fs.writeFileSync(gitconfig, "");
  const out = path.join(dir, "github-output.txt");
  fs.writeFileSync(out, "");

  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release-test@example.com",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.com"
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c", "commit.gpgsign=false",
        "-c", "tag.gpgSign=false",
        "-c", `core.hooksPath=${hooks.split(path.sep).join("/")}`,
        ...args
      ],
      { cwd: dir, env, encoding: "utf8" }
    ).trim();

  const writePkg = (version, space) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version }, null, space) + "\n");
  writePkg("1.2.3");
  git("init", "-b", "main");
  git("add", "package.json");
  git("commit", "-m", "base");
  const before = git("rev-parse", "HEAD");
  writePkg(current, 2);
  git("add", "package.json");
  git("commit", "-m", "bump");
  const head = git("rev-parse", "HEAD");

  const run = (overrides = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      env: {
        ...env,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: head,
        BEFORE_SHA: before,
        GITHUB_OUTPUT: out,
        ...overrides
      },
      encoding: "utf8"
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: fs.readFileSync(out, "utf8") };
  };
  return { dir, before, head, git, run };
}

function assertCleanFailure(r, message) {
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes(message), `expected stderr to include ${JSON.stringify(message)}, got:\n${r.stderr}`);
  assert.strictEqual(r.output, "");
}

test("release version: emits the release outputs when the version changes on main", (t) => {
  const r = fixture(t).run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.output, EXPECTED_OUTPUT);
});

test("release version: skips publishing when the version is unchanged", (t) => {
  const r = fixture(t, { current: "1.2.3" }).run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.output, "");
  assert.match(r.stdout, /version is unchanged/);
});

test("release version: refuses a branch push", (t) => {
  const r = fixture(t).run({ GITHUB_REF: "refs/heads/feature" });
  assertCleanFailure(r, "Releases must run from main.");
});

test("release version: refuses a tag push", (t) => {
  const r = fixture(t).run({ GITHUB_REF: "refs/tags/v1.2.4" });
  assertCleanFailure(r, "Releases must run from main.");
});

test("release version: refuses a checkout that is not the push commit", (t) => {
  const fx = fixture(t);
  const r = fx.run({ GITHUB_SHA: fx.before });
  assertCleanFailure(r, "The checkout does not match the main push commit.");
});

test("release version: refuses a tag that points at an earlier commit", (t) => {
  const fx = fixture(t);
  fx.git("tag", "v1.2.4", fx.before);
  const r = fx.run();
  assertCleanFailure(r, "Tag v1.2.4 already points to a different commit. Refusing to publish.");
});

test("release version: accepts a retry when the tag already points at this commit", (t) => {
  const fx = fixture(t);
  fx.git("tag", "v1.2.4", fx.head);
  const r = fx.run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.output, EXPECTED_OUTPUT);
});

test("release version: dereferences an annotated tag on this commit", (t) => {
  const fx = fixture(t);
  fx.git("tag", "-a", "v1.2.4", "-m", "release", fx.head);
  const r = fx.run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.output, EXPECTED_OUTPUT);
});

test("release version: refuses a version that is not plain X.Y.Z", (t) => {
  const r = fixture(t, { current: "1.2.4\nother=unsafe" }).run();
  assertCleanFailure(r, "The release version must use the format X.Y.Z.");
});

test("release version: fails when the previous version cannot be read", (t) => {
  const r = fixture(t).run({ BEFORE_SHA: "f".repeat(40) });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.output, "");
});
