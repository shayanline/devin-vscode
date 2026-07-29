import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";

// Real markdown rendering for assistant messages. HTML is disabled so model
// output cannot inject markup; only the tags markdown-it emits are produced.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : "";
    let body;
    if (language) {
      try {
        body = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch {
        body = md.utils.escapeHtml(code);
      }
    } else {
      body = md.utils.escapeHtml(code);
    }
    const attr = language ? ` data-lang="${language}"` : "";
    return `<pre class="code-block hljs"${attr}><code>${body}</code></pre>`;
  }
});

export function renderMarkdown(src) {
  return md.render(src || "");
}

export function renderMarkdownInline(src) {
  return md.renderInline(src || "");
}
