#!/usr/bin/env node

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Releases must run from main.");
}
if (git("rev-parse", "HEAD") !== process.env.GITHUB_SHA) {
  throw new Error("The checkout does not match the main push commit.");
}

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const previous = JSON.parse(git("show", `${process.env.BEFORE_SHA}:package.json`)).version;
if (version === previous) {
  console.log("The package version is unchanged. Skipping release.");
  process.exit(0);
}
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("The release version must use the format X.Y.Z.");
}

const tag = `v${version}`;
if (git("tag", "--list", tag) && git("rev-parse", `refs/tags/${tag}^{commit}`) !== process.env.GITHUB_SHA) {
  throw new Error(`Tag ${tag} already points to a different commit. Refusing to publish.`);
}
fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nvsix=devin-vscode-${version}.vsix\n`);
