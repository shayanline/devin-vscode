import { renderMarkdown } from "./markdown.js";

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    setup: $("setup"),
    chat: $("chat"),
    chatTitle: $("chat-title"),
    historyBtn: $("history-btn"),
    newchatBtn: $("newchat-btn"),
    status: $("status"),
    usage: $("usage"),
    sessionsList: $("sessions-list"),
    thread: $("thread"),
    input: $("input"),
    send: $("send"),
    stop: $("stop"),
    attach: $("attach"),
    modeDD: $("mode-dd"),
    modelDD: $("model-dd"),
    permissionTray: $("permission-tray"),
    elicitationTray: $("elicitation-tray"),
    workingSet: $("working-set"),
    attachments: $("attachments"),
    autocomplete: $("autocomplete")
  };

  let body = "list"; // "list" | "thread"
  // The thread is a flat sequence of blocks rendered in stream order. `block`
  // is the currently open block; a new block starts on a role change, a
  // messageId change, or after a tool/plan/error interrupts the flow.
  let block = null; // { kind: "user"|"assistant"|"thinking", mid, bubble|body, buffer, start?, label? }
  const toolEls = new Map();
  const terminalCache = new Map();

  let commands = [];
  let ac = null;
  let fileQueryToken = "";
  let currentTitle = "Chat";
  let lastUserText = "";

  const modeDropdown = createDropdown(el.modeDD, (v) => vscode.postMessage({ type: "setMode", mode: v }));
  const modelDropdown = createDropdown(el.modelDD, (v) => vscode.postMessage({ type: "setModel", model: v }), { staticIcon: "codicon-sparkle" });

  // --- View state ----------------------------------------------------------

  function setView(v) {
    el.setup.classList.toggle("hidden", v !== "setup");
    el.chat.classList.toggle("hidden", v !== "chat");
  }

  function setBody(b) {
    body = b;
    const list = b === "list";
    el.sessionsList.classList.toggle("hidden", !list);
    el.thread.classList.toggle("hidden", list);
    el.chatTitle.textContent = list ? "Sessions" : currentTitle;
    el.input.placeholder = list ? "Start a new chat\u2026" : "Ask Devin, or type @ to add a file";
  }

  el.historyBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "refreshSessions" });
    setBody("list");
  });
  el.newchatBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
    currentTitle = "Chat";
    setBody("thread");
    el.input.focus();
  });

  // --- Composer ------------------------------------------------------------

  function send() {
    const text = el.input.value.trim();
    if (!text) return;
    const startNew = body === "list";
    if (startNew) {
      currentTitle = "Chat";
      setBody("thread");
    }
    vscode.postMessage({ type: "send", text, newSession: startNew });
    el.input.value = "";
    closeAutocomplete();
    autosize();
  }

  el.send.addEventListener("click", send);
  el.stop.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.attach.addEventListener("click", () => vscode.postMessage({ type: "addContext" }));

  el.input.addEventListener("keydown", (e) => {
    if (ac) {
      if (e.key === "ArrowDown") { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; renderAutocomplete(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; renderAutocomplete(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && ac.items.length) { e.preventDefault(); acceptAutocomplete(ac.items[ac.index]); return; }
      if (e.key === "Escape") { e.preventDefault(); closeAutocomplete(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  el.input.addEventListener("input", () => { autosize(); updateAutocomplete(); });

  el.input.addEventListener("paste", (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          const base64 = result.slice(result.indexOf(",") + 1);
          vscode.postMessage({ type: "attachImage", name: file.name || "pasted-image", mime: it.type, data: base64 });
        };
        reader.readAsDataURL(file);
      }
    }
  });

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  }

  function scrollToBottom() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // Clickable anchors in assistant/user text: external links open in the
  // browser, everything else is treated as a file path and opened in the editor.
  el.thread.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) {
      vscode.postMessage({ type: "openExternal", url: href });
    } else {
      vscode.postMessage({ type: "openFile", path: href.replace(/^file:\/\//, "") });
    }
  });

  // --- Dropdown component (VS Code style) ----------------------------------

  function createDropdown(container, onSelect, opts) {
    opts = opts || {};
    const btn = document.createElement("button");
    btn.className = "dd-btn";
    const btnIcon = document.createElement("i");
    btnIcon.className = "codicon dd-icon";
    const label = document.createElement("span");
    label.className = "dd-label";
    const chev = document.createElement("i");
    chev.className = "codicon codicon-chevron-down";
    btn.appendChild(btnIcon);
    btn.appendChild(label);
    btn.appendChild(chev);

    function iconFor(v) {
      if (opts.staticIcon) return opts.staticIcon;
      const it = items.find((x) => x.value === v);
      return it && it.icon ? it.icon : "";
    }
    function updateBtnIcon() {
      const ic = iconFor(current);
      btnIcon.className = "codicon dd-icon " + ic;
      btnIcon.classList.toggle("hidden", !ic);
    }
    const menu = document.createElement("div");
    menu.className = "dd-menu hidden";
    container.appendChild(btn);
    container.appendChild(menu);

    let items = [];
    let current = "";
    let filterText = "";

    function close() { menu.classList.add("hidden"); }
    function labelFor(v) {
      const it = items.find((x) => x.value === v);
      return it ? it.name : v || "";
    }
    function makeRow(it) {
      const row = document.createElement("div");
      row.className = "dd-item" + (it.value === current ? " selected" : "");
      const check = document.createElement("span");
      check.className = "dd-check";
      if (it.value === current) check.innerHTML = '<i class="codicon codicon-check"></i>';
      row.appendChild(check);
      if (it.icon) {
        const ic = document.createElement("i");
        ic.className = "codicon dd-item-icon " + it.icon;
        row.appendChild(ic);
      }
      const txt = document.createElement("span");
      txt.textContent = it.name;
      row.appendChild(txt);
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        current = it.value;
        label.textContent = labelFor(current);
        updateBtnIcon();
        close();
        onSelect(it.value);
      });
      return row;
    }
    function renderMenu() {
      menu.innerHTML = "";
      const showFilter = items.length > 10;
      const rows = document.createElement("div");
      rows.className = "dd-rows";
      const renderRows = () => {
        rows.innerHTML = "";
        const q = filterText.trim().toLowerCase();
        let lastGroup = null;
        let shown = 0;
        items.forEach((it) => {
          if (q && !it.name.toLowerCase().includes(q) && !(it.group || "").toLowerCase().includes(q)) return;
          if (it.group && it.group !== lastGroup) {
            const h = document.createElement("div");
            h.className = "dd-group";
            h.textContent = it.group;
            rows.appendChild(h);
          }
          lastGroup = it.group || null;
          rows.appendChild(makeRow(it));
          shown++;
        });
        if (!shown) {
          const empty = document.createElement("div");
          empty.className = "dd-empty";
          empty.textContent = "No matches";
          rows.appendChild(empty);
        }
      };
      if (showFilter) {
        const f = document.createElement("input");
        f.className = "dd-filter";
        f.type = "text";
        f.placeholder = "Filter\u2026";
        f.value = filterText;
        f.addEventListener("click", (e) => e.stopPropagation());
        f.addEventListener("keydown", (e) => e.stopPropagation());
        f.addEventListener("input", () => { filterText = f.value; renderRows(); });
        menu.appendChild(f);
        setTimeout(() => f.focus(), 0);
      }
      menu.appendChild(rows);
      renderRows();
    }
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      document.querySelectorAll(".dd-menu").forEach((m) => { if (m !== menu) m.classList.add("hidden"); });
      filterText = "";
      renderMenu();
      menu.classList.toggle("hidden");
    });

    return {
      set(newItems, newCurrent) {
        items = newItems || [];
        current = newCurrent || (items[0] && items[0].value) || "";
        label.textContent = labelFor(current);
        updateBtnIcon();
        container.classList.toggle("hidden", items.length === 0);
      },
      setCurrent(v) { current = v; label.textContent = labelFor(v); updateBtnIcon(); }
    };
  }

  document.addEventListener("click", () => {
    document.querySelectorAll(".dd-menu").forEach((m) => m.classList.add("hidden"));
  });

  // --- Autocomplete --------------------------------------------------------

  function updateAutocomplete() {
    const value = el.input.value;
    const caret = el.input.selectionStart || value.length;
    if (value.startsWith("/") && value.indexOf(" ") === -1) {
      const q = value.slice(1).toLowerCase();
      const items = commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 40)
        .map((c) => ({ kind: "slash", name: c.name, description: c.description || "" }));
      openAutocomplete(items);
      return;
    }
    const before = value.slice(0, caret);
    const at = before.match(/@([^\s@]*)$/);
    if (at) {
      fileQueryToken = at[1];
      vscode.postMessage({ type: "queryFiles", query: fileQueryToken });
      return;
    }
    closeAutocomplete();
  }

  function openAutocomplete(items) {
    if (!items.length) { closeAutocomplete(); return; }
    ac = { items, index: 0 };
    renderAutocomplete();
  }

  function renderAutocomplete() {
    if (!ac) return;
    el.autocomplete.innerHTML = "";
    el.autocomplete.classList.remove("hidden");
    ac.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "ac-item" + (i === ac.index ? " active" : "");
      const icon = document.createElement("i");
      icon.className = "codicon " + (it.kind === "slash" ? "codicon-terminal" : "codicon-file");
      const primary = document.createElement("span");
      primary.className = "ac-primary";
      primary.textContent = it.kind === "slash" ? "/" + it.name : it.label;
      const secondary = document.createElement("span");
      secondary.className = "ac-secondary";
      secondary.textContent = it.description || it.detail || "";
      row.appendChild(icon);
      row.appendChild(primary);
      row.appendChild(secondary);
      row.addEventListener("mousedown", (ev) => { ev.preventDefault(); acceptAutocomplete(it); });
      el.autocomplete.appendChild(row);
    });
  }

  function closeAutocomplete() {
    ac = null;
    el.autocomplete.classList.add("hidden");
    el.autocomplete.innerHTML = "";
  }

  function acceptAutocomplete(item) {
    if (item.kind === "slash") {
      el.input.value = "/" + item.name + " ";
      el.input.focus();
      closeAutocomplete();
      autosize();
      return;
    }
    const value = el.input.value;
    const caret = el.input.selectionStart || value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, "");
    el.input.value = before + value.slice(caret);
    vscode.postMessage({ type: "addMention", path: item.path });
    el.input.focus();
    closeAutocomplete();
    autosize();
  }

  // --- Thread --------------------------------------------------------------

  function addMessage(role, text) {
    const msg = document.createElement("div");
    msg.className = "msg " + role;
    const roleEl = document.createElement("div");
    roleEl.className = "role";
    roleEl.textContent = role === "user" ? "You" : "Devin";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (text !== undefined) {
      bubble.innerHTML = renderMarkdown(text);
      enhanceCodeBlocks(bubble);
    }
    msg.appendChild(roleEl);
    msg.appendChild(bubble);
    msg.appendChild(messageActions(role, bubble, text));
    el.thread.appendChild(msg);
    scrollToBottom();
    return bubble;
  }

  function actionBtn(icon, title, onClick) {
    const b = document.createElement("button");
    b.className = "msg-action";
    b.title = title;
    b.innerHTML = `<i class="codicon ${icon}"></i>`;
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  function flashCheck(b) {
    const i = b.querySelector("i");
    const prev = i.className;
    i.className = "codicon codicon-check";
    setTimeout(() => { i.className = prev; }, 1200);
  }

  function messageActions(role, bubble, rawText) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    bar.appendChild(actionBtn("codicon-copy", "Copy", (b) => {
      vscode.postMessage({ type: "copyText", text: rawText || bubble.textContent || "" });
      flashCheck(b);
    }));
    if (role === "user") {
      bar.appendChild(actionBtn("codicon-edit", "Edit & resend", () => {
        el.input.value = rawText || bubble.textContent || "";
        el.input.focus();
        el.input.setSelectionRange(el.input.value.length, el.input.value.length);
        autosize();
      }));
    } else {
      bar.appendChild(actionBtn("codicon-refresh", "Retry", () => {
        if (lastUserText) vscode.postMessage({ type: "send", text: lastUserText, newSession: false });
      }));
    }
    return bar;
  }

  const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps", "ps1", "bat", "cmd"]);

  function codeBtn(icon, title, onClick) {
    const b = document.createElement("button");
    b.className = "code-btn";
    b.title = title;
    b.innerHTML = `<i class="codicon ${icon}"></i>`;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    return b;
  }

  function enhanceCodeBlocks(container) {
    if (!container) return;
    container.querySelectorAll("pre.code-block").forEach((pre) => {
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = "1";
      const code = pre.querySelector("code");
      const getText = () => (code ? code.textContent : pre.textContent) || "";
      const lang = (pre.getAttribute("data-lang") || "").toLowerCase();
      const bar = document.createElement("div");
      bar.className = "code-toolbar";
      bar.appendChild(codeBtn("codicon-copy", "Copy", (b) => {
        vscode.postMessage({ type: "copyText", text: getText() });
        const i = b.querySelector("i");
        i.className = "codicon codicon-check";
        setTimeout(() => { i.className = "codicon codicon-copy"; }, 1200);
      }));
      bar.appendChild(codeBtn("codicon-insert", "Insert at cursor", () => vscode.postMessage({ type: "insertAtCursor", text: getText() })));
      bar.appendChild(codeBtn("codicon-go-to-file", "Apply to file", () => vscode.postMessage({ type: "applyToFile", text: getText() })));
      if (SHELL_LANGS.has(lang)) {
        bar.appendChild(codeBtn("codicon-terminal", "Run in terminal", () => vscode.postMessage({ type: "runInTerminal", text: getText() })));
      }
      pre.appendChild(bar);
    });
  }
  function sameMid(a, b) { return (a || null) === (b || null); }

  // Rendering is throttled to animation frames so a fast stream doesn't
  // re-parse the whole buffer on every chunk (which is O(n^2) for long turns).
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; renderOpenBlock(); });
  }
  function renderOpenBlock() {
    if (!block) return;
    const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 60;
    if (block.kind === "thinking") {
      block.body.innerHTML = renderMarkdown(block.buffer);
    } else {
      block.bubble.innerHTML = renderMarkdown(block.buffer);
      if (block.kind === "assistant") enhanceCodeBlocks(block.bubble);
    }
    if (atBottom) scrollToBottom();
  }

  // Close the current block, running any finalisation it needs.
  function finalizeBlock() {
    if (!block) return;
    renderOpenBlock();
    if (block.kind === "thinking") {
      const secs = Math.max(1, Math.round((Date.now() - block.start) / 1000));
      if (block.label) block.label.textContent = `Thought for ${secs}s`;
    }
    block = null;
  }

  function appendAssistant(text, mid) {
    if (!(block && block.kind === "assistant" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      block = { kind: "assistant", mid, bubble: addMessage("assistant"), buffer: "" };
    }
    block.buffer += text;
    scheduleRender();
  }

  function appendThought(text, mid) {
    if (!(block && block.kind === "thinking" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      const details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right thinking-chevron";
      const label = document.createElement("span");
      label.className = "thinking-label";
      label.textContent = "Thinking\u2026";
      summary.appendChild(chev);
      summary.appendChild(label);
      const bodyEl = document.createElement("div");
      bodyEl.className = "thinking-body";
      details.appendChild(summary);
      details.appendChild(bodyEl);
      el.thread.appendChild(details);
      block = { kind: "thinking", mid, body: bodyEl, label, buffer: "", start: Date.now() };
    }
    block.buffer += text;
    scheduleRender();
  }

  // A user turn streamed during history replay (user_message_chunk).
  function appendUserChunk(text, mid) {
    if (!(block && block.kind === "user" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      block = { kind: "user", mid, bubble: addMessage("user"), buffer: "" };
    }
    block.buffer += text;
    lastUserText = block.buffer;
    scheduleRender();
  }

  // A user turn we already have in full (live echo from the host).
  function addUserMessage(text) {
    finalizeBlock();
    hideWelcome();
    lastUserText = text;
    addMessage("user", text);
  }
  function renderPlan(entries) {
    finalizeBlock();
    hideWelcome();
    const box = document.createElement("div");
    box.className = "plan";
    const title = document.createElement("div");
    title.className = "role";
    title.textContent = "Plan";
    box.appendChild(title);
    (entries || []).forEach((entry) => {
      const row = document.createElement("div");
      row.className = "plan-entry" + (entry.status === "completed" ? " done" : "");
      const mark = document.createElement("i");
      mark.className = "codicon " + (entry.status === "completed" ? "codicon-pass-filled" : entry.status === "in_progress" ? "codicon-sync" : "codicon-circle-large-outline");
      const txt = document.createElement("span");
      txt.textContent = entry.content;
      row.appendChild(mark);
      row.appendChild(txt);
      box.appendChild(row);
    });
    el.thread.appendChild(box);
    scrollToBottom();
  }
  const TOOL_KIND_ICONS = {
    read: "codicon-file",
    edit: "codicon-edit",
    delete: "codicon-trash",
    move: "codicon-arrow-right",
    search: "codicon-search",
    execute: "codicon-terminal",
    think: "codicon-lightbulb",
    fetch: "codicon-cloud-download",
    other: "codicon-tools"
  };

  function statusIcon(status) {
    switch (status) {
      case "in_progress": return "codicon-loading codicon-modifier-spin";
      case "completed": return "codicon-check";
      case "failed": return "codicon-error";
      case "cancelled": return "codicon-circle-slash";
      default: return "codicon-circle-large-outline";
    }
  }

  function upsertTool(m) {
    let entry = toolEls.get(m.id);
    if (!entry) {
      finalizeBlock();
      hideWelcome();
      const node = document.createElement("details");
      node.className = "tool";
      const summary = document.createElement("summary");
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right tool-chevron";
      const kindIcon = document.createElement("i");
      kindIcon.className = "codicon tool-kind";
      const label = document.createElement("span");
      label.className = "label";
      const statEl = document.createElement("i");
      statEl.className = "codicon tool-status";
      summary.appendChild(chev);
      summary.appendChild(kindIcon);
      summary.appendChild(label);
      summary.appendChild(statEl);
      const bodyEl = document.createElement("div");
      bodyEl.className = "tool-body";
      node.appendChild(summary);
      node.appendChild(bodyEl);
      el.thread.appendChild(node);
      entry = { node, kindIcon, label, statEl, bodyEl, data: {} };
      toolEls.set(m.id, entry);
    }
    // Merge incrementally: updates may carry only some fields.
    const d = entry.data;
    if (m.title) d.title = m.title;
    if (m.kind) d.kind = m.kind;
    if (m.status) d.status = m.status;
    if (m.rawInput !== undefined) d.rawInput = m.rawInput;
    if (Array.isArray(m.content) && m.content.length) d.content = m.content;
    if (Array.isArray(m.locations) && m.locations.length) d.locations = m.locations;

    entry.node.className = "tool " + (d.status || "pending");
    entry.kindIcon.className = "codicon tool-kind " + (TOOL_KIND_ICONS[d.kind] || TOOL_KIND_ICONS.other);
    entry.statEl.className = "codicon tool-status " + statusIcon(d.status);
    entry.label.textContent = d.title || "Tool";
    renderToolBody(entry);
    // Inline progress: reflect the running tool in the header status.
    if (d.status === "in_progress" && d.title) {
      el.status.textContent = d.title;
    } else if (d.status === "completed" || d.status === "failed") {
      el.status.textContent = "Working\u2026";
    }
    scrollToBottom();
  }

  function renderToolBody(entry) {
    const d = entry.data;
    const body = entry.bodyEl;
    body.innerHTML = "";
    let hasContent = false;

    if (d.rawInput && Object.keys(d.rawInput).length) {
      hasContent = true;
      const sec = document.createElement("div");
      sec.className = "tool-section";
      const h = document.createElement("div");
      h.className = "tool-section-title";
      h.textContent = "Input";
      const pre = document.createElement("pre");
      pre.className = "tool-pre";
      pre.textContent = safeJson(d.rawInput);
      sec.appendChild(h);
      sec.appendChild(pre);
      body.appendChild(sec);
    }

    const textItems = (d.content || []).filter((c) => c.type === "text" && c.text);
    if (textItems.length) {
      hasContent = true;
      const sec = document.createElement("div");
      sec.className = "tool-section";
      const h = document.createElement("div");
      h.className = "tool-section-title";
      h.textContent = "Result";
      const pre = document.createElement("pre");
      pre.className = "tool-pre";
      pre.textContent = textItems.map((c) => c.text).join("\n");
      sec.appendChild(h);
      sec.appendChild(pre);
      body.appendChild(sec);
    }

    const termItems = (d.content || []).filter((c) => c.type === "terminal" && c.terminalId);
    if (termItems.length) {
      hasContent = true;
      termItems.forEach((c) => {
        const sec = document.createElement("div");
        sec.className = "tool-section";
        const pre = document.createElement("pre");
        pre.className = "tool-pre terminal-pre";
        pre.setAttribute("data-terminal", c.terminalId);
        const cached = terminalCache.get(c.terminalId);
        pre.textContent = (cached && cached.output) || "\u2026";
        sec.appendChild(pre);
        body.appendChild(sec);
      });
      // Terminal cards are worth showing open by default.
      if (!entry.node.dataset.autoOpened) { entry.node.open = true; entry.node.dataset.autoOpened = "1"; }
    }

    const diffItems = (d.content || []).filter((c) => c.type === "diff" && c.path);
    const locs = (d.locations || []).slice();
    const fileRows = [
      ...diffItems.map((c) => ({ path: c.path, diff: true })),
      ...locs.map((l) => ({ path: l.path, line: l.line, diff: false }))
    ];
    if (fileRows.length) {
      hasContent = true;
      const sec = document.createElement("div");
      sec.className = "tool-section";
      fileRows.forEach((f) => {
        const link = document.createElement("a");
        link.className = "file-change tool-file";
        link.textContent = shorten(f.path) + (f.line ? ":" + f.line : "");
        link.title = f.path;
        link.addEventListener("click", () => {
          if (f.diff) vscode.postMessage({ type: "openDiff", path: f.path });
          else vscode.postMessage({ type: "openFile", path: f.path, line: f.line });
        });
        sec.appendChild(link);
      });
      body.appendChild(sec);
    }

    entry.node.classList.toggle("tool-empty", !hasContent);
  }

  function safeJson(v) {
    try {
      const s = JSON.stringify(v, null, 2);
      return s && s.length > 4000 ? s.slice(0, 4000) + "\n…" : s;
    } catch {
      return String(v);
    }
  }
  function addFileChange(path) {
    finalizeBlock();
    hideWelcome();
    const node = document.createElement("div");
    node.className = "tool-line completed";
    const icon = document.createElement("i");
    icon.className = "codicon codicon-edit";
    const link = document.createElement("a");
    link.className = "file-change";
    link.textContent = shorten(path);
    link.title = path;
    link.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path }));
    node.appendChild(icon);
    node.appendChild(link);
    el.thread.appendChild(node);
    scrollToBottom();
  }

  // --- Permissions & elicitation -------------------------------------------

  function showPermission(data) {
    const box = document.createElement("div");
    box.className = "tray-card";
    const title = document.createElement("div");
    title.textContent = data.title || "Devin wants to run a tool";
    const options = document.createElement("div");
    options.className = "options";
    (data.options || []).forEach((opt) => {
      const reject = /reject/.test(opt.kind || "");
      options.appendChild(btn(opt.name || opt.optionId, reject ? "secondary" : "primary", () => {
        vscode.postMessage({ type: "permission", requestId: data.requestId, optionId: opt.optionId });
        box.remove();
      }));
    });
    box.appendChild(title);
    box.appendChild(options);
    el.permissionTray.appendChild(box);
  }

  function showElicitation(data) {
    const box = document.createElement("div");
    box.className = "tray-card";
    const msg = document.createElement("div");
    msg.textContent = data.message || "Devin has a question";
    box.appendChild(msg);
    const respond = (action, content) => {
      vscode.postMessage({ type: "elicitationResponse", requestId: data.requestId, action, content });
      box.remove();
    };
    if (data.mode === "url" && data.url) {
      const url = document.createElement("div");
      url.className = "muted";
      url.textContent = data.url;
      box.appendChild(url);
      const row = document.createElement("div");
      row.className = "options";
      row.appendChild(btn("Open", "primary", () => respond("accept")));
      row.appendChild(btn("Decline", "secondary", () => respond("decline")));
      box.appendChild(row);
      el.elicitationTray.appendChild(box);
      return;
    }
    const props = (data.schema && data.schema.properties) || {};
    const names = Object.keys(props);
    if (names.length === 1 && Array.isArray(props[names[0]].enum)) {
      const key = names[0];
      const row = document.createElement("div");
      row.className = "options";
      props[key].enum.forEach((v) => row.appendChild(btn(String(v), "primary", () => respond("accept", { [key]: v }))));
      row.appendChild(btn("Cancel", "secondary", () => respond("cancel")));
      box.appendChild(row);
      el.elicitationTray.appendChild(box);
      return;
    }
    const controls = {};
    names.forEach((key) => {
      const spec = props[key];
      const field = document.createElement("div");
      field.className = "elicit-field";
      const lab = document.createElement("label");
      lab.textContent = spec.description || key;
      field.appendChild(lab);
      let input;
      if (Array.isArray(spec.enum)) {
        input = document.createElement("select");
        spec.enum.forEach((v) => { const o = document.createElement("option"); o.value = String(v); o.textContent = String(v); input.appendChild(o); });
      } else if (spec.type === "boolean") { input = document.createElement("input"); input.type = "checkbox"; }
      else if (spec.type === "number" || spec.type === "integer") { input = document.createElement("input"); input.type = "number"; }
      else { input = document.createElement("input"); input.type = "text"; }
      if (spec.default !== undefined && input.type !== "checkbox") input.value = String(spec.default);
      controls[key] = input;
      field.appendChild(input);
      box.appendChild(field);
    });
    const row = document.createElement("div");
    row.className = "options";
    row.appendChild(btn("Submit", "primary", () => {
      const content = {};
      Object.entries(controls).forEach(([k, input]) => {
        if (input.type === "checkbox") content[k] = input.checked;
        else if (input.type === "number") content[k] = Number(input.value);
        else content[k] = input.value;
      });
      respond("accept", content);
    }));
    row.appendChild(btn("Decline", "secondary", () => respond("decline")));
    box.appendChild(row);
    el.elicitationTray.appendChild(box);
  }

  // --- Working set ---------------------------------------------------------

  function renderWorkingSet(files) {
    el.workingSet.innerHTML = "";
    if (!files || files.length === 0) { el.workingSet.classList.add("hidden"); return; }
    el.workingSet.classList.remove("hidden");
    const header = document.createElement("div");
    header.className = "ws-header";
    const label = document.createElement("span");
    label.textContent = `${files.length} changed file${files.length > 1 ? "s" : ""}`;
    const actions = document.createElement("div");
    actions.className = "ws-actions";
    actions.appendChild(btn("Open all", "secondary", () => vscode.postMessage({ type: "openAllDiffs" })));
    actions.appendChild(btn("Keep all", "primary", () => vscode.postMessage({ type: "acceptAll" })));
    actions.appendChild(btn("Undo all", "secondary", () => vscode.postMessage({ type: "rejectAll" })));
    header.appendChild(label);
    header.appendChild(actions);
    el.workingSet.appendChild(header);
    files.forEach((f) => {
      const row = document.createElement("div");
      row.className = "ws-file";
      const link = document.createElement("a");
      link.className = "file-change";
      link.textContent = f.name;
      link.title = f.path;
      link.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path: f.path }));
      const grp = document.createElement("div");
      grp.className = "ws-file-actions";
      grp.appendChild(iconBtn("codicon-check", "Keep", () => vscode.postMessage({ type: "acceptFile", path: f.path })));
      grp.appendChild(iconBtn("codicon-discard", "Undo", () => vscode.postMessage({ type: "rejectFile", path: f.path })));
      row.appendChild(link);
      row.appendChild(grp);
      el.workingSet.appendChild(row);
    });
  }

  // --- Attachments ---------------------------------------------------------

  function renderAttachments(items) {
    el.attachments.innerHTML = "";
    if (!items || items.length === 0) { el.attachments.classList.add("hidden"); return; }
    el.attachments.classList.remove("hidden");
    items.forEach((a) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const icon = document.createElement("i");
      icon.className = "codicon " + (a.type === "image" ? "codicon-file-media" : a.type === "selection" ? "codicon-selection" : "codicon-file");
      const label = document.createElement("span");
      label.textContent = a.label;
      const x = document.createElement("button");
      x.className = "chip-x";
      x.innerHTML = '<i class="codicon codicon-close"></i>';
      x.addEventListener("click", () => vscode.postMessage({ type: "removeAttachment", id: a.id }));
      chip.appendChild(icon);
      chip.appendChild(label);
      chip.appendChild(x);
      el.attachments.appendChild(chip);
    });
  }

  // --- Sessions list -------------------------------------------------------

  function renderSessions(sessions, activeId, folders) {
    el.sessionsList.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sessions-empty";
      empty.innerHTML = '<i class="codicon codicon-comment-discussion"></i><div>No chats yet.</div><div class="muted">Type below to start a new chat.</div>';
      el.sessionsList.appendChild(empty);
      return;
    }
    const folderNames = new Map((folders || []).map((f) => [f.path, f.name]));
    const groups = new Map();
    const orderedKeys = [];
    const keyFor = (s) => {
      const wd = s.working_directory || "";
      for (const f of folders || []) {
        if (wd === f.path || wd.startsWith(f.path + "/") || wd.startsWith(f.path + "\\")) return f.path;
      }
      return wd || "__workspace__";
    };
    sessions.forEach((s) => {
      const key = keyFor(s);
      if (!groups.has(key)) { groups.set(key, []); orderedKeys.push(key); }
      groups.get(key).push(s);
    });
    const showGroups = (folders || []).length > 1 || orderedKeys.length > 1;
    orderedKeys.forEach((key) => {
      if (showGroups) {
        const header = document.createElement("div");
        header.className = "group-header";
        header.textContent = folderNames.get(key) || (key === "__workspace__" ? "This workspace" : baseName(key));
        el.sessionsList.appendChild(header);
      }
      groups.get(key).forEach((s) => el.sessionsList.appendChild(sessionRow(s, activeId)));
    });
  }

  function sessionRow(s, activeId) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === activeId ? " active" : "");
    const main = document.createElement("div");
    main.className = "session-main";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.title || s.short_id || s.id;
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = s.last_activity_ago || "";
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener("click", () => {
      currentTitle = s.title || "Chat";
      vscode.postMessage({ type: "loadSession", id: s.id });
      setBody("thread");
    });
    const actions = document.createElement("div");
    actions.className = "session-actions";
    const rename = iconBtn("codicon-edit", "Rename", (e) => { e.stopPropagation(); vscode.postMessage({ type: "renameSession", id: s.id, title: s.title || "" }); });
    const del = iconBtn("codicon-trash", "Delete", (e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteSession", id: s.id, title: s.title || s.id }); });
    actions.appendChild(rename);
    actions.appendChild(del);
    item.appendChild(main);
    item.appendChild(actions);
    return item;
  }

  // --- Setup panel ---------------------------------------------------------

  function renderSetup(health) {
    setView("setup");
    el.setup.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = "Set up Devin";
    el.setup.appendChild(h);
    const cliOk = !!health.found;
    el.setup.appendChild(stepBlock(
      cliOk ? "Devin CLI found" : "Devin CLI not found",
      cliOk ? `${health.path || ""}${health.version ? " (" + health.version + ")" : ""}` : "Set the path to the devin executable, or install the Devin CLI first.",
      cliOk,
      [btn("Browse...", "secondary", () => vscode.postMessage({ type: "browseCli" })), btn("Re-check", "secondary", () => vscode.postMessage({ type: "recheck" }))]
    ));
    if (cliOk) {
      const authed = health.loggedIn !== false;
      el.setup.appendChild(stepBlock(
        authed ? "Authenticated" : "Not logged in",
        authed ? "You are logged in to Devin." : "Log in to Devin, then re-check.",
        authed,
        authed ? [] : [btn("Log in", "primary", () => vscode.postMessage({ type: "authenticate" })), btn("Re-check", "secondary", () => vscode.postMessage({ type: "recheck" }))]
      ));
    }
    if (cliOk && health.loggedIn !== false) {
      el.setup.appendChild(btn("Start chatting", "primary", () => vscode.postMessage({ type: "finishSetup" })));
    }
    if (health.error && !cliOk) {
      const p = document.createElement("p");
      p.className = "setup-error";
      p.textContent = health.error;
      el.setup.appendChild(p);
    }
  }

  function stepBlock(title, desc, ok, controls) {
    const box = document.createElement("div");
    box.className = "setup-step";
    const t = document.createElement("div");
    t.className = "setup-title";
    const icon = document.createElement("i");
    icon.className = "codicon " + (ok ? "codicon-pass-filled" : "codicon-error");
    const tt = document.createElement("span");
    tt.textContent = title;
    t.appendChild(icon);
    t.appendChild(tt);
    box.appendChild(t);
    if (desc) { const d = document.createElement("div"); d.className = "setup-desc"; d.textContent = desc; box.appendChild(d); }
    if (controls && controls.length) { const row = document.createElement("div"); row.className = "setup-controls"; controls.forEach((c) => row.appendChild(c)); box.appendChild(row); }
    return box;
  }

  // --- Helpers -------------------------------------------------------------

  function btn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = "btn " + (cls || "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  function iconBtn(codicon, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn small";
    b.title = title;
    b.innerHTML = `<i class="codicon ${codicon}"></i>`;
    b.addEventListener("click", onClick);
    return b;
  }
  function setBusy(busy) {
    el.send.classList.toggle("hidden", busy);
    el.stop.classList.toggle("hidden", !busy);
    el.status.textContent = busy ? "Working\u2026" : "";
  }

  // --- Welcome / empty state ----------------------------------------------

  const STARTER_PROMPTS = [
    "Explain how this codebase is structured",
    "Find and fix a bug in the current file",
    "Write tests for the file I have open",
    "Review my recent changes"
  ];

  function renderWelcome() {
    if (el.thread.querySelector(".welcome")) return;
    if (el.thread.querySelector(".msg")) return;
    const box = document.createElement("div");
    box.className = "welcome";
    const icon = document.createElement("i");
    icon.className = "codicon codicon-comment-discussion welcome-icon";
    const title = document.createElement("div");
    title.className = "welcome-title";
    title.textContent = "Ask Devin anything";
    const sub = document.createElement("div");
    sub.className = "welcome-sub muted";
    sub.textContent = "Devin can read your workspace, run tools, and edit files. Try one of these:";
    box.appendChild(icon);
    box.appendChild(title);
    box.appendChild(sub);
    const chips = document.createElement("div");
    chips.className = "welcome-prompts";
    STARTER_PROMPTS.forEach((p) => {
      const chip = document.createElement("button");
      chip.className = "welcome-chip";
      chip.textContent = p;
      chip.addEventListener("click", () => { el.input.value = p; el.input.focus(); autosize(); send(); });
      chips.appendChild(chip);
    });
    box.appendChild(chips);
    el.thread.appendChild(box);
  }

  function hideWelcome() {
    const w = el.thread.querySelector(".welcome");
    if (w) w.remove();
  }

  // --- Error rendering -----------------------------------------------------

  function renderError(text) {
    finalizeBlock();
    hideWelcome();
    const box = document.createElement("div");
    box.className = "tray-card error-card";
    const head = document.createElement("div");
    head.className = "error-head";
    const icon = document.createElement("i");
    icon.className = "codicon codicon-error";
    const msg = document.createElement("span");
    const low = (text || "").toLowerCase();
    const loggedOut = /not logged in|log ?in|authenticat|unauthori[sz]ed|401/.test(low);
    const rateLimited = /rate limit|429|too many requests|quota/.test(low);
    msg.textContent = loggedOut
      ? "You're not logged in to Devin."
      : rateLimited
        ? "Devin is rate limited right now."
        : (text || "Something went wrong.");
    head.appendChild(icon);
    head.appendChild(msg);
    box.appendChild(head);
    const row = document.createElement("div");
    row.className = "options";
    if (loggedOut) {
      row.appendChild(btn("Log in", "primary", () => vscode.postMessage({ type: "authenticate" })));
      row.appendChild(btn("Re-check", "secondary", () => vscode.postMessage({ type: "recheck" })));
    } else {
      row.appendChild(btn("Retry", "primary", () => { if (lastUserText) vscode.postMessage({ type: "send", text: lastUserText, newSession: false }); }));
    }
    box.appendChild(row);
    el.thread.appendChild(box);
    scrollToBottom();
  }

  // --- Usage / cost --------------------------------------------------------

  function fmtTokens(n) {
    if (!n && n !== 0) return "";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
  }

  function renderUsage(m) {
    if (!m.used || !m.size) { el.usage.textContent = ""; el.usage.title = ""; return; }
    const pct = Math.round((m.used / m.size) * 100);
    let label = pct + "%";
    let title = `${fmtTokens(m.used)} / ${fmtTokens(m.size)} tokens (${pct}% of context)`;
    if (m.cost && typeof m.cost.amount === "number") {
      const cost = m.cost.amount < 1 ? "$" + m.cost.amount.toFixed(3) : "$" + m.cost.amount.toFixed(2);
      label += " \u00b7 " + cost;
      title += ` \u00b7 ${cost} ${m.cost.currency || ""}`.trimEnd();
    }
    el.usage.textContent = label;
    el.usage.title = title;
  }

  // Live terminal output streamed from the extension host.
  function updateTerminal(m) {
    if (!m.terminalId) return;
    let text = m.output || "";
    if (m.exitStatus) {
      const code = m.exitStatus.exitCode;
      const sig = m.exitStatus.signal;
      text += `\n[exited ${sig ? "signal " + sig : "code " + (code == null ? "?" : code)}]`;
    }
    terminalCache.set(m.terminalId, { output: text, exitStatus: m.exitStatus });
    el.thread.querySelectorAll(`pre[data-terminal="${m.terminalId}"]`).forEach((pre) => {
      const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 40;
      pre.textContent = text || "\u2026";
      if (atBottom) scrollToBottom();
    });
  }
  function shorten(p) { return p.split(/[\\/]/).slice(-2).join("/"); }
  function baseName(p) { return p.split(/[\\/]/).filter(Boolean).pop() || p; }

  // --- Inbound messages ----------------------------------------------------

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "setup": renderSetup(m.health || {}); break;
      case "ready": setView("chat"); setBody("list"); break;
      case "body": setView("chat"); setBody(m.body === "list" ? "list" : "thread"); break;
      case "workspace": break;
      case "options":
        modeDropdown.set(m.modes, m.currentMode);
        modelDropdown.set(m.models, m.currentModel);
        break;
      case "commands": commands = Array.isArray(m.commands) ? m.commands : []; break;
      case "fileSuggestions":
        if (m.query === fileQueryToken) {
          openAutocomplete((m.items || []).map((f) => ({ kind: "file", path: f.path, label: f.label, detail: f.detail })));
        }
        break;
      case "sessions": renderSessions(m.sessions, m.activeId, m.folders); break;
      case "sessionReady": el.status.textContent = ""; break;
      case "status": el.status.textContent = m.text || ""; break;
      case "clear":
        el.thread.innerHTML = "";
        el.permissionTray.innerHTML = "";
        el.elicitationTray.innerHTML = "";
        renderWorkingSet([]);
        renderAttachments([]);
        toolEls.clear();
        block = null;
        el.usage.textContent = "";
        el.usage.title = "";
        if (body === "thread") renderWelcome();
        break;
      case "userMessage":
        if (currentTitle === "Chat") { currentTitle = m.text.slice(0, 40); el.chatTitle.textContent = currentTitle; }
        addUserMessage(m.text);
        break;
      case "userChunk": appendUserChunk(m.text, m.messageId); break;
      case "assistantStart": finalizeBlock(); break;
      case "assistantChunk": appendAssistant(m.text, m.messageId); break;
      case "thoughtChunk": appendThought(m.text, m.messageId); break;
      case "assistantEnd": finalizeBlock(); break;
      case "plan": renderPlan(m.entries); break;
      case "toolCall":
      case "toolCallUpdate": upsertTool(m); break;
      case "fileChange": addFileChange(m.path); break;
      case "workingSet": renderWorkingSet(m.files); break;
      case "attachments": renderAttachments(m.items); break;
      case "permission": showPermission(m); break;
      case "elicitation": showElicitation(m); break;
      case "busy": setBusy(m.value); break;
      case "mode": if (m.mode) modeDropdown.setCurrent(m.mode); break;
      case "model": if (m.model) modelDropdown.setCurrent(m.model); break;
      case "terminalOutput": updateTerminal(m); break;
      case "usage": renderUsage(m); break;
      case "error": renderError(m.text); break;
      default: break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
