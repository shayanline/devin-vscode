# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Building and running

- `npm install` to install dependencies. Node 22 or newer (`npm test` leaves its
  glob to Node, which only expands one from Node 21).
- `npm run watch` (or `npm run compile`), then press F5 in VS Code to launch an Extension Development Host with the extension loaded.
- `npm run check-types` type checks and `npm test` runs every suite: the webview, the settings panel, the chat controller, the working set, the ACP client, and the CLI helpers.
- `npm run package` builds a `.vsix` you can install with `code --install-extension`.
- `npm run preview -- --scenario full` opens a mock chat in a browser for fast UI iteration without the CLI. See [the screenshots guide](docs/screenshots.md) for the scenarios behind the documentation screenshots and how to regenerate them.
- `npm run preview:settings` does the same for the settings panel. It takes `--section <id>`, `--multi-root` (two workspace folders, so the scope tabs show both), and `--empty` (nothing configured, for the empty states). The mock payload lives in `scripts/settings-fixture.js` and is shared with the tests.

## Releasing

Releases are automated after a version change reaches `main`:

1. On a feature branch, run `npm version patch --no-git-tag-version` (or `minor` / `major`) to update the manifest and lockfile without creating a tag.
2. Add the matching version entry to [`CHANGELOG.md`](CHANGELOG.md).
3. Open a pull request to `main` and wait for CI to pass.
4. Merge the pull request. The release workflow checks the merged commit, creates its version tag, and publishes the release.

The [release workflow](.github/workflows/release.yml) skips publishing when the package version is unchanged. It type checks, tests, builds the extension, creates a GitHub Release with the `.vsix` attached, and publishes to the VS Code Marketplace. When `OVSX_PAT` is configured, it also publishes to Open VSX as a best effort step. The release body is the matching `CHANGELOG.md` section (via `scripts/changelog-notes.js`) with GitHub's "Full Changelog" link appended. All merge methods are supported because the tag is created on the merged commit. Do not create or push a release tag from the pull request branch. If a release run fails, rerun that run after resolving the failure instead of moving its tag.

The [CI workflow](.github/workflows/ci.yml) runs the checks on every push to `main` and every pull request targeting `main`, including tests on Windows and macOS.

One time setup for Marketplace publishing:

- Create the `shayanline` publisher on the [Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
- Generate an Azure DevOps personal access token scoped to Marketplace, Manage.
- Add it as a repository Actions secret named `VSCE_PAT` (and optionally `OVSX_PAT` for Open VSX).

While `"preview": true` is set in `package.json`, the Marketplace listing keeps the preview badge.
