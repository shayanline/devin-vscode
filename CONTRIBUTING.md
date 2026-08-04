# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Building and running

- `npm install` to install dependencies.
- `npm run watch` (or `npm run compile`), then press F5 in VS Code to launch an Extension Development Host with the extension loaded.
- `npm run check-types` type checks and `npm test` runs the webview unit tests.
- `npm run package` builds a `.vsix` you can install with `code --install-extension`.
- `npm run preview -- --scenario full` opens a mock chat in a browser for fast UI iteration without the CLI. See [the screenshots guide](docs/screenshots.md) for the scenarios behind the README images and how to regenerate them.
- `npm run preview:settings` does the same for the settings panel. It takes `--section <id>`, `--multi-root` (two workspace folders, so the scope tabs show both), and `--empty` (nothing configured, for the empty states). The mock payload lives in `scripts/settings-fixture.js` and is shared with the tests.

## Releasing

Releases are automated. To cut one:

1. Bump the version and create the tag: `npm version patch` (or `minor` / `major`).
2. Push it: `git push --follow-tags`.

The [release workflow](.github/workflows/release.yml) then type checks, tests, builds the extension, creates a GitHub Release with the `.vsix` attached, and publishes to the VS Code Marketplace (and Open VSX). The [CI workflow](.github/workflows/ci.yml) runs the same checks on every push and pull request.

One time setup for Marketplace publishing:

- Create the `shayanline` publisher on the [Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
- Generate an Azure DevOps personal access token scoped to Marketplace, Manage.
- Add it as a repository Actions secret named `VSCE_PAT` (and optionally `OVSX_PAT` for Open VSX).

While `"preview": true` is set in `package.json`, the Marketplace listing keeps the preview badge.
