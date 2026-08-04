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

## Size

Every image is **460 by 820** pixels, with no exceptions. The README lays them
out two to a row, so images of different heights leave ragged gaps and each one
renders at a different scale. 460 wide is the sidebar panel width, so a capture
is life sized rather than a shrunken wide window.

That means capturing the **viewport**, not an element: an element capture is as
tall as its content, which is what made the earlier set range from 671 to 1197
pixels tall. Capture the viewport with the transcript scrolled to the bottom, as
the panel leaves it after a turn, so the cut falls at the top where a chat is
expected to continue, and the composer stays in frame.

## Regenerating an image

1. Build the webview and serve a scenario:

   ```bash
   npm run compile
   node scripts/preview.js --scenario full
   npx http-server -p 8787 .          # or: python3 -m http.server 8787
   ```

2. Open `http://localhost:8787/scripts/.preview/index.html`, size the viewport,
   scroll the transcript to the bottom, and capture the whole viewport:

   ```bash
   playwright-cli goto "http://localhost:8787/scripts/.preview/index.html"
   playwright-cli resize 460 820
   playwright-cli eval "(() => { const t = document.getElementById('thread'); t.scrollTop = t.scrollHeight; })()"
   playwright-cli screenshot --filename=docs/screenshots/02-refactor-and-tests.png
   ```

   Allow a moment before capturing so streaming settles, and about two seconds
   for the `tools` scenario, whose Mermaid diagram is upgraded lazily.

3. `04-research-and-diagram.png` is the one exception to scrolling to the bottom:
   the diagram is tall enough to fill the panel on its own and push the tool
   cards out of frame, so position it deliberately instead.

   ```bash
   playwright-cli eval "(() => { const t = document.getElementById('thread'); const svg = t.querySelector('svg'); t.scrollTop += svg.getBoundingClientRect().top - t.getBoundingClientRect().top - 210; })()"
   ```

4. Check the result is still 460 by 820 before committing:

   ```bash
   file docs/screenshots/*.png
   ```

## Adding or changing sample data

Edit the relevant scenario array in `scripts/preview.js`. Use only invented
project names, file paths, and titles. Never paste real repository names, work
context, absolute home paths, tokens, or anything else that should not be
public.
