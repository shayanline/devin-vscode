# AGENTS.md

Guidance for anyone (human or agent) working in this repository. This is also
read by the Devin CLI as the workspace instructions, so keep it accurate.

## What this project is

**Devin for VS Code** is a VS Code extension that brings the
[Devin CLI](https://docs.devin.ai/cli) into a native chat panel. Instead of
running Devin in a terminal, you chat with it in a side panel: streaming replies,
tool calls you can approve, and file edits shown as diffs you keep or undo. Each
chat is a real Devin CLI session, driven over the Agent Client Protocol (ACP),
and saved per workspace.

It is a personal, open source project published on the VS Code Marketplace and
Open VSX under the `shayanline` publisher.

## How it fits together

- **`src/`** is the extension host (TypeScript, runs in Node inside VS Code).
  - `extension.ts` activates the extension, wires up commands, and shuts every
    agent down cleanly on the way out.
  - `acp/` speaks the Agent Client Protocol to a `devin acp` process: the
    connection, the client, terminal handling, and the shared types.
  - `chat/` holds the `ChatManager` (one controller per chat surface: sidebar,
    editor tab, or window) and the webview provider that renders each chat.
  - `session/` stores sessions per workspace and lists them.
  - `diff/` tracks the working set of edits and exposes keep and undo.
  - `settings/` is the Devin customisations editor and the config read and write
    services that back it.
  - `cli/` locates the `devin` binary, lists models, reaps orphaned agents, and
    manages session locks.
  - `ui/` is the status bar.
- **`webview/`** is the browser side that runs inside the chat panel: `main.js`,
  markdown rendering, the Mermaid entry point, and the settings panel script.
- **`scripts/`** holds the test harnesses, the browser previews, and the ACP
  probe (see the commands below).
- **`media/`, `resources/`** are icons and static assets. **`docs/`** holds the
  README screenshots and the guide for regenerating them.
- Build output goes to **`dist/`** (bundled by esbuild, do not edit by hand).

## Commands

Everything runs through npm scripts. Prefer these over ad hoc commands.

| Task | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Build once (dev) | `npm run compile` |
| Rebuild on change | `npm run watch` |
| Production build | `npm run build` |
| Type check | `npm run check-types` |
| Run the tests | `npm test` |
| Package a `.vsix` | `npm run package` |
| Preview the chat UI in a browser | `npm run preview -- --scenario full` |
| Preview the settings panel | `npm run preview:settings` |

To run the extension itself, `npm run watch` and then press F5 in VS Code to
launch an Extension Development Host with the extension loaded.

The two preview commands render the UI in a plain browser from mock data, with no
Devin CLI needed, which is the fastest way to iterate on the webview. The
screenshots in the README come from `npm run preview`. See
[docs/screenshots.md](docs/screenshots.md) for the scenarios and how to
regenerate them, and [CONTRIBUTING.md](CONTRIBUTING.md) for the full build and
release notes.

## Releasing

Releases are automated. Bump the version and push the tag:

```
npm version patch   # or minor / major
git push --follow-tags
```

The tag push triggers the release workflow, which type checks, tests, builds,
creates a GitHub Release with the `.vsix` attached, and publishes to the
Marketplace and Open VSX.

The release body is taken from the matching `CHANGELOG.md` section by
`scripts/changelog-notes.js`, with GitHub's own "Full Changelog" link appended.
So add the `CHANGELOG.md` entry for the new version before you tag, or the
release notes fall back to a link to the changelog.

## Code philosophy

Write the simplest code that solves the problem. Every line should earn its
place.

- **Minimal over clever.** Keep logic flat and linear. Reduce nesting, collapse
  duplicate branches, and only extract an abstraction when reuse is real.
- **No dead code.** Remove unused imports, variables, functions, types, files,
  and commented out blocks. This project has had several cleanup passes for a
  reason.
- **No overengineering.** No abstractions or extensibility for hypothetical
  future needs. No defensive checks scattered everywhere: handle errors at the
  right boundary, not on every line.
- **Follow what is here.** Match the existing style and reuse the existing
  helpers, tokens, and patterns before adding new ones. Study a neighbouring file
  before writing a new one.
- **Never assume a library exists.** Check `package.json` first. The runtime
  dependencies are `markdown-it`, `highlight.js`, and `mermaid`, nothing else.
- **Readable names over comments.** Add a comment only when the code breaks a
  pattern or the data path is not obvious. Do not add or remove comments
  otherwise.

## UI work

- Match VS Code's own look. Use its theme tokens and codicons, and mirror the
  Settings editor and Copilot Chat layouts the extension is modelled on, rather
  than inventing controls.
- Handle the empty, loading, and error states, not just the happy path.

## Writing style for docs and text

These rules apply to the README, the changelog, commit messages, PR
descriptions, code comments, and any other prose in the repo.

- Never use an em dash or en dash. Use a comma, a colon, brackets, or a full
  stop, and rewrite the sentence if needed.
- Do not hyphenate compound modifiers. Write "read only", "full width", "icon
  only", "follow up". Genuine identifiers keep their form: package names, CLI
  flags, config keys, and code symbols (`markdown-it`, `--width`,
  `read_config_from`).
- No semicolons in prose. Use a full stop or a comma. This does not apply to
  code.
- No bare URLs in prose. Link a short descriptive phrase instead.

## Changelog

`CHANGELOG.md` is a list you can scan, not a write up. One entry per released
version, newest first, and a new entry for every release.

- **One line per change.** Each bullet is a single line of at most 80 columns,
  including the `- `. If it does not fit, cut words until it does. Never wrap a
  bullet onto a second line and never write a paragraph.
- **Say what changed, from the reader's side.** No cause, no mechanism, no
  before and after story, no reasoning, no measurements. The commit message is
  where to be thorough, and it is the place for all of that.
- **Highlights** is what a user notices. **Under the hood** is optional, at most
  four lines, only for what they cannot see but should know: shutdown, security,
  the protocol, test infrastructure.
- An optional one line summary may sit under the version heading, and only when
  the release has a single theme worth naming.
- Add the release link at the bottom only when the git tag actually exists.

A good bullet: `- Drag the panel by its header to move it to the other side.`
Not: three lines on what the panel used to do and why that was wrong.

## Git and commits

- This is a personal project, so commits are authored by Shayan only, with no
  Devin or bot co author trailer.
- Never commit or push unless explicitly asked.
- Keep commit messages about the "why", and follow the writing style rules above.

## Before you call it done

1. `npm run check-types` passes.
2. `npm test` passes.
3. Review your own diff for dead code and style drift.
4. Clean up any temporary files or scratch scripts.
