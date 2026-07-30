# Screenshots guide

The README images are generated from mock conversations defined in
[`scripts/preview.js`](../scripts/preview.js). The mock data is deliberately
generic (no real project or personal data) so the screenshots are safe to
publish. Keep these scenarios so the images can be regenerated on any later
change without rebuilding the sample data from scratch.

## What each image shows

| Image | Scenario | Captures |
|-------|----------|----------|
| `01-session-list.png` | `sessions` | The session browser: two workspace folders (web-app, api-service), six sessions with liveness dots, and the new chat composer. |
| `02-refactor-and-tests.png` | `full` | A full turn on the Adaptive model: a plan, a collapsed group of tool calls (read, edit, run), an edit with line counts, inline file references, an interactive question, and a permission prompt. |
| `03-fix-with-diff.png` | `diff` | A focused bug fix on Claude Sonnet 4.5: reasoning, grouped tools, an edit with a plus and minus diff, a benchmark run, and the completion footer with the model name. |
| `04-research-and-diagram.png` | `tools` | A research turn on GPT-5: web search, fetch, and MCP tool cards, followed by a Mermaid flowchart rendered inline. |

Each scenario uses a different model and task type on purpose, so the set shows
the extension across a range of real work.

## Regenerating an image

1. Build the webview and serve a scenario:

   ```bash
   npm run compile
   node scripts/preview.js --scenario full
   npx http-server -p 8787 .          # or: python3 -m http.server 8787
   ```

2. Open `http://localhost:8787/scripts/.preview/index.html` in a browser sized
   to roughly 460 pixels wide (the panel width the images use).

3. Capture the panel. For the session list capture the `#chat` element, for a
   turn capture the `#thread` element, and save over the matching file in
   `docs/screenshots/`. Playwright makes this repeatable:

   ```bash
   playwright-cli resize 460 900
   playwright-cli screenshot "#thread" --filename=docs/screenshots/02-refactor-and-tests.png
   ```

## Adding or changing sample data

Edit the relevant scenario array in `scripts/preview.js`. Use only invented
project names, file paths, and titles. Never paste real repository names, work
context, absolute home paths, tokens, or anything else that should not be
public.
