# Screenshots guide

The documentation images are generated from mock conversations defined in [`scripts/preview.js`](../scripts/preview.js). The mock data is deliberately generic (no real project or personal data) so the screenshots are safe to publish. The README displays all four screenshots, and the [usage guide](usage.md#interface-examples) includes the session browser, code change and connected tools examples. Keep these scenarios so the images can be regenerated without rebuilding the sample data.

## What each image shows

| Image | Scenario | Captures |
|-------|----------|----------|
| `01-session-list.png` | `sessions` | The session browser groups illustrative chats by workspace folder, with session status indicators and a new chat composer. |
| `02-refactor-and-tests.png` | `marketplace` | A refactoring request shows Fusion, a plan, file review controls and an approval request before running auth tests. |
| `03-fix-with-diff.png` | `diff` | A code change uses Claude Opus 5.5, with grouped tool calls, file review controls and a sample test result. |
| `04-research-and-diagram.png` | `tools` | A research conversation uses GPT-6 Astra, with web and MCP tools and a Mermaid flowchart. |

The scenarios illustrate chat controls and different task types. The conversations and any results shown are sample data.

`scripts/preview.js` also carries a `subagent` scenario for working on the subagent block. It shows two subagents in parallel, with one finished and folded down to its report while the other is still running. It has no documentation screenshot of its own.

## Size

Every image is **620 by 860** pixels. Keep the same dimensions when regenerating a screenshot so the framing stays consistent. The documentation displays each image individually.

Set `--width 620` to align the chat panel with the capture viewport. The flag controls the panel's `#app` element.

Capture the **viewport** at 620 by 860. Keep the composer in frame while scrolling the conversation pane to show the relevant controls.

## Regenerating an image

1. Build the webview and serve a scenario:

   ```bash
   npm run compile
   node scripts/preview.js --scenario marketplace --width 620
   npx http-server -p 8787 .          # or: python3 -m http.server 8787
   ```

2. Open [local preview](http://localhost:8787/scripts/.preview/index.html), size the viewport, scroll the transcript to the bottom, and capture the whole viewport:

   ```bash
   playwright-cli goto "http://localhost:8787/scripts/.preview/index.html"
   playwright-cli resize 620 860
   playwright-cli eval "(() => { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; })()"
   playwright-cli screenshot --filename=docs/screenshots/02-refactor-and-tests.png
   ```

   Allow a moment before capturing so streaming settles, and about two seconds for the `tools` scenario, whose Mermaid diagram is upgraded lazily.

3. For `03-fix-with-diff.png` and `04-research-and-diagram.png`, expand the completed steps to show tool activity before capturing. Wait for the tools scenario's Mermaid diagram to render, then keep both the connected tool names and the diagram in frame.

4. Check every image is still 620 by 860 before committing:

   ```bash
   file docs/screenshots/*.png     # all four must report 620 x 860
   ```

## Adding or changing sample data

Edit the relevant scenario array in `scripts/preview.js`. Use only invented project names, file paths, and titles. Never paste real repository names, work context, absolute home paths, tokens, or anything else that should not be public.
