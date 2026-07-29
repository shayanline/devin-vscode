(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    setup: document.getElementById("setup"),
    chat: document.getElementById("chat"),
    sessionsBar: document.getElementById("sessions-bar"),
    thread: document.getElementById("thread"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    stop: document.getElementById("stop"),
    mode: document.getElementById("mode"),
    model: document.getElementById("model"),
    status: document.getElementById("status"),
    permissionTray: document.getElementById("permission-tray")
  };

  let assistantEl = null; // current assistant bubble
  let assistantBuffer = "";
  let thinkingEl = null;
  const toolEls = new Map();

  // --- Sending -------------------------------------------------------------

  function send() {
    const text = el.input.value.trim();
    if (!text) {
      return;
    }
    vscode.postMessage({ type: "send", text });
    el.input.value = "";
    autosize();
  }

  el.send.addEventListener("click", send);
  el.stop.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  el.input.addEventListener("input", autosize);
  el.mode.addEventListener("change", () =>
    vscode.postMessage({ type: "setMode", mode: el.mode.value })
  );
  el.model.addEventListener("change", () =>
    vscode.postMessage({ type: "setModel", model: el.model.value })
  );

  function fillSelect(select, items, current) {
    select.innerHTML = "";
    (items || []).forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.value;
      opt.textContent = it.name;
      select.appendChild(opt);
    });
    if (current) {
      select.value = current;
    }
    select.classList.toggle("hidden", !items || items.length === 0);
  }

  function autosize() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
  }

  function scrollToBottom() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // --- Rendering helpers ---------------------------------------------------

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
    if (!assistantEl) {
      startAssistant();
    }
    assistantBuffer += text;
    assistantEl.innerHTML = renderMarkdown(assistantBuffer);
    scrollToBottom();
  }

  function appendThought(text) {
    if (!assistantEl) {
      startAssistant();
    }
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
    if (title) {
      node.querySelector(".label").textContent = title;
    }
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

  function showPermission(data) {
    const box = document.createElement("div");
    box.className = "permission";
    const title = document.createElement("div");
    title.textContent = data.title || "Devin wants to run a tool";
    const options = document.createElement("div");
    options.className = "options";
    (data.options || []).forEach((opt) => {
      const btn = document.createElement("button");
      const reject = /reject/.test(opt.kind || "");
      btn.className = reject ? "secondary" : "";
      btn.textContent = opt.name || opt.optionId;
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "permission", requestId: data.requestId, optionId: opt.optionId });
        box.remove();
      });
      options.appendChild(btn);
    });
    box.appendChild(title);
    box.appendChild(options);
    el.permissionTray.appendChild(box);
  }

  function showSetup(show) {
    el.setup.classList.toggle("hidden", !show);
    el.chat.classList.toggle("hidden", show);
  }

  function renderSetup(health) {
    showSetup(true);
    el.setup.innerHTML = "";

    const h = document.createElement("h2");
    h.textContent = "Set up Devin";
    el.setup.appendChild(h);

    // Step 1: CLI
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

    // Step 2: Auth (only meaningful once the CLI is found)
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

    // Step 3: default mode
    if (cliOk && health.loggedIn !== false) {
      const modes = [
        { value: "accept-edits", name: "Code" },
        { value: "ask", name: "Ask" },
        { value: "plan", name: "Plan" },
        { value: "bypass", name: "Bypass" }
      ];
      const sel = document.createElement("select");
      modes.forEach((mo) => {
        const o = document.createElement("option");
        o.value = mo.value;
        o.textContent = mo.name;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () =>
        vscode.postMessage({ type: "saveDefaults", mode: sel.value })
      );
      el.setup.appendChild(stepBlock("Default mode", "", [sel]));
      el.setup.appendChild(
        btn("Start chatting", "", () => vscode.postMessage({ type: "finishSetup" }))
      );
    }

    const err = health.error;
    if (err && !cliOk) {
      const p = document.createElement("p");
      p.className = "setup-error";
      p.textContent = err;
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

  function btn(label, cls, onClick) {
    const b = document.createElement("button");
    if (cls) {
      b.className = cls;
    }
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderSessions(sessions, activeId) {
    el.sessionsBar.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      el.sessionsBar.classList.add("hidden");
      return;
    }
    el.sessionsBar.classList.remove("hidden");
    sessions.forEach((s) => {
      const item = document.createElement("div");
      item.className = "session-item" + (s.id === activeId ? " active" : "");
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = s.title || s.short_id || s.id;
      const meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = s.last_activity_ago || "";
      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener("click", () => vscode.postMessage({ type: "loadSession", id: s.id }));
      el.sessionsBar.appendChild(item);
    });
  }

  function setBusy(busy) {
    el.send.classList.toggle("hidden", busy);
    el.stop.classList.toggle("hidden", !busy);
    el.status.textContent = busy ? "Devin is working..." : "";
  }

  // --- Minimal, safe markdown ----------------------------------------------

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMarkdown(src) {
    const parts = src.split(/```/);
    let html = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // Drop an optional leading language tag line (e.g. ```ts).
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
    return withBold
      .split(/\n{2,}/)
      .map((p) => "<p>" + p.replace(/\n/g, "<br/>") + "</p>")
      .join("");
  }

  function shorten(p) {
    const parts = p.split(/[\\/]/);
    return parts.slice(-2).join("/");
  }

  // --- Inbound messages ----------------------------------------------------

  window.addEventListener("message", (event) => {
    const m = event.data;
    switch (m.type) {
      case "config":
        break;
      case "setup":
        renderSetup(m.health || {});
        break;
      case "ready":
        showSetup(false);
        break;
      case "workspace":
        document.title = m.name || "Devin";
        break;
      case "authStarted":
        break;
      case "options":
        fillSelect(el.mode, m.modes, m.currentMode);
        fillSelect(el.model, m.models, m.currentModel);
        break;
      case "sessions":
        renderSessions(m.sessions, m.activeId);
        break;
      case "sessionReady":
        el.status.textContent = "";
        break;
      case "clear":
        el.thread.innerHTML = "";
        el.permissionTray.innerHTML = "";
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
        upsertTool(m.id, m.title, m.status);
        break;
      case "toolCallUpdate":
        upsertTool(m.id, m.title, m.status);
        break;
      case "fileChange":
        addFileChange(m.path);
        break;
      case "permission":
        showPermission(m);
        break;
      case "busy":
        setBusy(m.value);
        break;
      case "mode":
        if (m.mode) {
          el.mode.value = m.mode;
        }
        break;
      case "model":
        if (m.model) {
          el.model.value = m.model;
        }
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
