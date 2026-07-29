(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const el = {
    setup: $("setup"),
    sessionsView: $("sessions-view"),
    sessionsList: $("sessions-list"),
    chat: $("chat"),
    chatTitle: $("chat-title"),
    backToChat: $("back-to-chat"),
    newFromList: $("new-from-list"),
    historyBtn: $("history-btn"),
    newchatBtn: $("newchat-btn"),
    thread: $("thread"),
    input: $("input"),
    send: $("send"),
    stop: $("stop"),
    attach: $("attach"),
    mode: $("mode"),
    model: $("model"),
    status: $("status"),
    permissionTray: $("permission-tray"),
    elicitationTray: $("elicitation-tray"),
    workingSet: $("working-set"),
    attachments: $("attachments"),
    autocomplete: $("autocomplete")
  };

  let assistantEl = null;
  let assistantBuffer = "";
  let thinkingEl = null;
  const toolEls = new Map();

  let commands = []; // advertised slash commands / skills
  let ac = null; // active autocomplete: { kind, items, index, token }
  let fileQueryToken = "";

  // --- View switching ------------------------------------------------------

  function showView(view) {
    el.setup.classList.toggle("hidden", view !== "setup");
    el.sessionsView.classList.toggle("hidden", view !== "sessions");
    el.chat.classList.toggle("hidden", view !== "chat");
  }

  el.historyBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "refreshSessions" });
    showView("sessions");
  });
  el.backToChat.addEventListener("click", () => showView("chat"));
  el.newchatBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
    showView("chat");
  });
  el.newFromList.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
    showView("chat");
  });

  // --- Composer ------------------------------------------------------------

  function send() {
    const text = el.input.value.trim();
    if (!text) {
      return;
    }
    vscode.postMessage({ type: "send", text });
    el.input.value = "";
    closeAutocomplete();
    autosize();
  }

  el.send.addEventListener("click", send);
  el.stop.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.attach.addEventListener("click", () => vscode.postMessage({ type: "addContext" }));

  el.input.addEventListener("keydown", (e) => {
    if (ac) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        ac.index = (ac.index + 1) % ac.items.length;
        renderAutocomplete();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        ac.index = (ac.index - 1 + ac.items.length) % ac.items.length;
        renderAutocomplete();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (ac.items.length) {
          e.preventDefault();
          acceptAutocomplete(ac.items[ac.index]);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  el.input.addEventListener("input", () => {
    autosize();
    updateAutocomplete();
  });

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

  el.mode.addEventListener("change", () => vscode.postMessage({ type: "setMode", mode: el.mode.value }));
  el.model.addEventListener("change", () => vscode.postMessage({ type: "setModel", model: el.model.value }));

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
  }

  function scrollToBottom() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // --- Autocomplete (/ commands and @ files) -------------------------------

  function updateAutocomplete() {
    const value = el.input.value;
    const caret = el.input.selectionStart || value.length;

    if (value.startsWith("/") && value.indexOf(" ") === -1) {
      const q = value.slice(1).toLowerCase();
      const items = commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map((c) => ({ kind: "slash", name: c.name, description: c.description || "" }));
      openAutocomplete("slash", items);
      return;
    }

    const before = value.slice(0, caret);
    const at = before.match(/@([^\s@]*)$/);
    if (at) {
      fileQueryToken = at[1];
      vscode.postMessage({ type: "queryFiles", query: fileQueryToken });
      // Items arrive asynchronously via "fileSuggestions".
      return;
    }

    closeAutocomplete();
  }

  function openAutocomplete(kind, items) {
    if (!items.length) {
      closeAutocomplete();
      return;
    }
    ac = { kind, items, index: 0 };
    renderAutocomplete();
  }

  function renderAutocomplete() {
    if (!ac) {
      return;
    }
    el.autocomplete.innerHTML = "";
    el.autocomplete.classList.remove("hidden");
    ac.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "ac-item" + (i === ac.index ? " active" : "");
      const primary = document.createElement("span");
      primary.className = "ac-primary";
      primary.textContent = it.kind === "slash" ? "/" + it.name : it.label;
      const secondary = document.createElement("span");
      secondary.className = "ac-secondary";
      secondary.textContent = it.description || it.detail || "";
      row.appendChild(primary);
      row.appendChild(secondary);
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        acceptAutocomplete(it);
      });
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
    // file mention
    const value = el.input.value;
    const caret = el.input.selectionStart || value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]*)$/, "");
    el.input.value = before + value.slice(caret);
    vscode.postMessage({ type: "addMention", path: item.path });
    el.input.focus();
    closeAutocomplete();
    autosize();
  }

  // --- Markdown ------------------------------------------------------------

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderMarkdown(src) {
    const parts = src.split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const code = parts[i].replace(/^([a-zA-Z0-9_+-]+)\n/, "");
        html += "<pre><code>" + escapeHtml(code) + "</code></pre>";
      } else {
        html += renderInline(parts[i]);
      }
    }
    return html;
  }

  function renderInline(text) {
    const escaped = escapeHtml(text);
    const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
    const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return withBold.split(/\n{2,}/).map((p) => "<p>" + p.replace(/\n/g, "<br/>") + "</p>").join("");
  }

  // --- Thread rendering ----------------------------------------------------

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
    }
    msg.appendChild(roleEl);
    msg.appendChild(bubble);
    el.thread.appendChild(msg);
    scrollToBottom();
    return bubble;
  }

  function startAssistant() {
    assistantBuffer = "";
    thinkingEl = null;
    assistantEl = addMessage("assistant");
  }

  function endAssistant() {
    assistantEl = null;
    thinkingEl = null;
    assistantBuffer = "";
  }

  function appendAssistant(text) {
    if (!assistantEl) startAssistant();
    assistantBuffer += text;
    assistantEl.innerHTML = renderMarkdown(assistantBuffer);
    scrollToBottom();
  }

  function appendThought(text) {
    if (!assistantEl) startAssistant();
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking";
      assistantEl.parentElement.insertBefore(thinkingEl, assistantEl);
    }
    thinkingEl.textContent += text;
    scrollToBottom();
  }

  function renderPlan(entries) {
    const box = document.createElement("div");
    box.className = "plan";
    const title = document.createElement("div");
    title.className = "role";
    title.textContent = "Plan";
    box.appendChild(title);
    (entries || []).forEach((entry) => {
      const row = document.createElement("div");
      row.className = "plan-entry" + (entry.status === "completed" ? " done" : "");
      const mark = document.createElement("span");
      mark.textContent = entry.status === "completed" ? "\u2713" : entry.status === "in_progress" ? "\u2022" : "\u25cb";
      const txt = document.createElement("span");
      txt.textContent = entry.content;
      row.appendChild(mark);
      row.appendChild(txt);
      box.appendChild(row);
    });
    el.thread.appendChild(box);
    scrollToBottom();
  }

  function upsertTool(id, title, status) {
    let node = toolEls.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "tool " + (status || "pending");
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "label";
      node.appendChild(dot);
      node.appendChild(label);
      el.thread.appendChild(node);
      toolEls.set(id, node);
    }
    node.className = "tool " + (status || "pending");
    if (title) node.querySelector(".label").textContent = title;
    scrollToBottom();
  }

  function addFileChange(path) {
    const node = document.createElement("div");
    node.className = "tool completed";
    const dot = document.createElement("span");
    dot.className = "dot";
    const link = document.createElement("a");
    link.className = "file-change";
    link.textContent = "\u270e " + shorten(path);
    link.title = path;
    link.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path }));
    node.appendChild(dot);
    node.appendChild(link);
    el.thread.appendChild(node);
    scrollToBottom();
  }

  // --- Permissions ---------------------------------------------------------

  function showPermission(data) {
    const box = document.createElement("div");
    box.className = "permission";
    const title = document.createElement("div");
    title.textContent = data.title || "Devin wants to run a tool";
    const options = document.createElement("div");
    options.className = "options";
    (data.options || []).forEach((opt) => {
      const reject = /reject/.test(opt.kind || "");
      const b = btn(opt.name || opt.optionId, reject ? "secondary" : "", () => {
        vscode.postMessage({ type: "permission", requestId: data.requestId, optionId: opt.optionId });
        box.remove();
      });
      options.appendChild(b);
    });
    box.appendChild(title);
    box.appendChild(options);
    el.permissionTray.appendChild(box);
  }

  // --- Elicitation (the agent asks a question) -----------------------------

  function showElicitation(data) {
    const box = document.createElement("div");
    box.className = "permission elicitation";
    const msg = document.createElement("div");
    msg.textContent = data.message || "Devin has a question";
    box.appendChild(msg);

    const respond = (action, content) => {
      vscode.postMessage({ type: "elicitationResponse", requestId: data.requestId, action, content });
      box.remove();
    };

    if (data.mode === "url" && data.url) {
      const url = document.createElement("div");
      url.className = "setup-desc";
      url.textContent = data.url;
      box.appendChild(url);
      const row = document.createElement("div");
      row.className = "options";
      row.appendChild(btn("Open", "", () => respond("accept")));
      row.appendChild(btn("Decline", "secondary", () => respond("decline")));
      box.appendChild(row);
      el.elicitationTray.appendChild(box);
      return;
    }

    const props = (data.schema && data.schema.properties) || {};
    const names = Object.keys(props);

    // Single enum question -> one-click option buttons.
    if (names.length === 1 && Array.isArray(props[names[0]].enum)) {
      const key = names[0];
      const row = document.createElement("div");
      row.className = "options";
      props[key].enum.forEach((v) => {
        row.appendChild(btn(String(v), "", () => respond("accept", { [key]: v })));
      });
      box.appendChild(row);
      const cancelRow = document.createElement("div");
      cancelRow.className = "options";
      cancelRow.appendChild(btn("Cancel", "secondary", () => respond("cancel")));
      box.appendChild(cancelRow);
      el.elicitationTray.appendChild(box);
      return;
    }

    // General form.
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
        spec.enum.forEach((v) => {
          const o = document.createElement("option");
          o.value = String(v);
          o.textContent = String(v);
          input.appendChild(o);
        });
      } else if (spec.type === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
      } else if (spec.type === "number" || spec.type === "integer") {
        input = document.createElement("input");
        input.type = "number";
      } else {
        input = document.createElement("input");
        input.type = "text";
      }
      if (spec.default !== undefined && input.type !== "checkbox") {
        input.value = String(spec.default);
      }
      controls[key] = { input, spec };
      field.appendChild(input);
      box.appendChild(field);
    });

    const row = document.createElement("div");
    row.className = "options";
    row.appendChild(
      btn("Submit", "", () => {
        const content = {};
        Object.entries(controls).forEach(([k, c]) => {
          if (c.input.type === "checkbox") content[k] = c.input.checked;
          else if (c.input.type === "number") content[k] = Number(c.input.value);
          else content[k] = c.input.value;
        });
        respond("accept", content);
      })
    );
    row.appendChild(btn("Decline", "secondary", () => respond("decline")));
    box.appendChild(row);
    el.elicitationTray.appendChild(box);
  }

  // --- Working set ---------------------------------------------------------

  function renderWorkingSet(files) {
    el.workingSet.innerHTML = "";
    if (!files || files.length === 0) {
      el.workingSet.classList.add("hidden");
      return;
    }
    el.workingSet.classList.remove("hidden");
    const header = document.createElement("div");
    header.className = "ws-header";
    const label = document.createElement("span");
    label.textContent = `${files.length} changed file${files.length > 1 ? "s" : ""}`;
    const actions = document.createElement("div");
    actions.className = "ws-actions";
    actions.appendChild(btn("Keep all", "", () => vscode.postMessage({ type: "acceptAll" })));
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
      grp.appendChild(btn("Keep", "tiny", () => vscode.postMessage({ type: "acceptFile", path: f.path })));
      grp.appendChild(btn("Undo", "tiny secondary", () => vscode.postMessage({ type: "rejectFile", path: f.path })));
      row.appendChild(link);
      row.appendChild(grp);
      el.workingSet.appendChild(row);
    });
  }

  // --- Attachments ---------------------------------------------------------

  function renderAttachments(items) {
    el.attachments.innerHTML = "";
    if (!items || items.length === 0) {
      el.attachments.classList.add("hidden");
      return;
    }
    el.attachments.classList.remove("hidden");
    items.forEach((a) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const icon = a.type === "image" ? "\u{1F5BC}" : a.type === "selection" ? "\u2702" : "\u{1F4C4}";
      const label = document.createElement("span");
      label.textContent = `${icon} ${a.label}`;
      const x = document.createElement("button");
      x.className = "chip-x";
      x.textContent = "\u2715";
      x.addEventListener("click", () => vscode.postMessage({ type: "removeAttachment", id: a.id }));
      chip.appendChild(label);
      chip.appendChild(x);
      el.attachments.appendChild(chip);
    });
  }

  // --- Sessions list (grouped by directory) --------------------------------

  function renderSessions(sessions, activeId, folders) {
    el.sessionsList.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sessions-empty";
      empty.textContent = "No sessions yet in this workspace.";
      el.sessionsList.appendChild(empty);
      return;
    }

    const folderNames = new Map((folders || []).map((f) => [f.path, f.name]));
    const groups = new Map();
    const orderedKeys = [];
    const keyFor = (s) => {
      const wd = s.working_directory || "";
      for (const f of folders || []) {
        if (wd === f.path || wd.startsWith(f.path + "/") || wd.startsWith(f.path + "\\")) {
          return f.path;
        }
      }
      return wd || "__workspace__";
    };
    sessions.forEach((s) => {
      const key = keyFor(s);
      if (!groups.has(key)) {
        groups.set(key, []);
        orderedKeys.push(key);
      }
      groups.get(key).push(s);
    });

    const showGroups = (folders || []).length > 1 || orderedKeys.length > 1;

    orderedKeys.forEach((key) => {
      if (showGroups) {
        const header = document.createElement("div");
        header.className = "group-header";
        header.textContent =
          folderNames.get(key) || (key === "__workspace__" ? "This workspace" : baseName(key));
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
    meta.textContent = [s.last_activity_ago, s.tracked ? "" : "cli"].filter(Boolean).join("  \u00b7  ");
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener("click", () => {
      vscode.postMessage({ type: "loadSession", id: s.id });
      showView("chat");
    });
    const actions = document.createElement("div");
    actions.className = "session-actions";
    const rename = btn("\u270e", "tiny secondary", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "renameSession", id: s.id, title: s.title || "" });
    });
    rename.title = "Rename";
    const del = btn("\u2715", "tiny secondary", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", id: s.id, title: s.title || s.id });
    });
    del.title = "Delete";
    actions.appendChild(rename);
    actions.appendChild(del);
    item.appendChild(main);
    item.appendChild(actions);
    return item;
  }

  // --- Setup panel ---------------------------------------------------------

  function renderSetup(health) {
    showView("setup");
    el.setup.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = "Set up Devin";
    el.setup.appendChild(h);

    const cliOk = !!health.found;
    el.setup.appendChild(
      stepBlock(
        cliOk ? "\u2713 Devin CLI found" : "\u2717 Devin CLI not found",
        cliOk
          ? `${health.path || ""}${health.version ? " (" + health.version + ")" : ""}`
          : "Set the path to the devin executable, or install the Devin CLI first.",
        [
          btn("Browse...", "secondary", () => vscode.postMessage({ type: "browseCli" })),
          btn("Re-check", "secondary", () => vscode.postMessage({ type: "recheck" }))
        ]
      )
    );

    if (cliOk) {
      const authed = health.loggedIn !== false;
      el.setup.appendChild(
        stepBlock(
          authed ? "\u2713 Authenticated" : "\u2717 Not logged in",
          authed ? "You are logged in to Devin." : "Log in to Devin, then re-check.",
          authed
            ? []
            : [
                btn("Log in", "", () => vscode.postMessage({ type: "authenticate" })),
                btn("Re-check", "secondary", () => vscode.postMessage({ type: "recheck" }))
              ]
        )
      );
    }

    if (cliOk && health.loggedIn !== false) {
      el.setup.appendChild(btn("Start chatting", "", () => vscode.postMessage({ type: "finishSetup" })));
    }

    if (health.error && !cliOk) {
      const p = document.createElement("p");
      p.className = "setup-error";
      p.textContent = health.error;
      el.setup.appendChild(p);
    }
  }

  function stepBlock(title, desc, controls) {
    const box = document.createElement("div");
    box.className = "setup-step";
    const t = document.createElement("div");
    t.className = "setup-title";
    t.textContent = title;
    box.appendChild(t);
    if (desc) {
      const d = document.createElement("div");
      d.className = "setup-desc";
      d.textContent = desc;
      box.appendChild(d);
    }
    if (controls && controls.length) {
      const row = document.createElement("div");
      row.className = "setup-controls";
      controls.forEach((c) => row.appendChild(c));
      box.appendChild(row);
    }
    return box;
  }

  // --- Shared helpers ------------------------------------------------------

  function btn(label, cls, onClick) {
    const b = document.createElement("button");
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function fillSelect(select, items, current) {
    select.innerHTML = "";
    (items || []).forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.value;
      opt.textContent = it.name;
      select.appendChild(opt);
    });
    if (current) select.value = current;
    select.classList.toggle("hidden", !items || items.length === 0);
  }

  function setBusy(busy) {
    el.send.classList.toggle("hidden", busy);
    el.stop.classList.toggle("hidden", !busy);
    el.status.textContent = busy ? "Devin is working..." : "";
  }

  function shorten(p) {
    return p.split(/[\\/]/).slice(-2).join("/");
  }
  function baseName(p) {
    return p.split(/[\\/]/).filter(Boolean).pop() || p;
  }

  // --- Inbound messages ----------------------------------------------------

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "setup":
        renderSetup(m.health || {});
        break;
      case "ready":
        showView("chat");
        break;
      case "view":
        showView(m.view === "sessions" ? "sessions" : "chat");
        break;
      case "workspace":
        el.chatTitle.textContent = m.name || "Devin";
        break;
      case "options":
        fillSelect(el.mode, m.modes, m.currentMode);
        fillSelect(el.model, m.models, m.currentModel);
        break;
      case "commands":
        commands = Array.isArray(m.commands) ? m.commands : [];
        break;
      case "fileSuggestions":
        if (m.query === fileQueryToken) {
          openAutocomplete(
            "file",
            (m.items || []).map((f) => ({ kind: "file", path: f.path, label: f.label, detail: f.detail }))
          );
        }
        break;
      case "sessions":
        renderSessions(m.sessions, m.activeId, m.folders);
        break;
      case "sessionReady":
        el.status.textContent = "";
        break;
      case "clear":
        el.thread.innerHTML = "";
        el.permissionTray.innerHTML = "";
        el.elicitationTray.innerHTML = "";
        renderWorkingSet([]);
        renderAttachments([]);
        toolEls.clear();
        endAssistant();
        break;
      case "userMessage":
        addMessage("user", m.text);
        break;
      case "assistantStart":
        startAssistant();
        break;
      case "assistantChunk":
        appendAssistant(m.text);
        break;
      case "thoughtChunk":
        appendThought(m.text);
        break;
      case "assistantEnd":
        endAssistant();
        break;
      case "plan":
        renderPlan(m.entries);
        break;
      case "toolCall":
      case "toolCallUpdate":
        upsertTool(m.id, m.title, m.status);
        break;
      case "fileChange":
        addFileChange(m.path);
        break;
      case "workingSet":
        renderWorkingSet(m.files);
        break;
      case "attachments":
        renderAttachments(m.items);
        break;
      case "permission":
        showPermission(m);
        break;
      case "elicitation":
        showElicitation(m);
        break;
      case "busy":
        setBusy(m.value);
        break;
      case "mode":
        if (m.mode) el.mode.value = m.mode;
        break;
      case "model":
        if (m.model) el.model.value = m.model;
        break;
      case "usage":
        el.status.textContent = m.used && m.size ? `${Math.round((m.used / m.size) * 100)}% context` : "";
        break;
      case "error":
        addMessage("assistant", "**Error:** " + m.text);
        endAssistant();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
