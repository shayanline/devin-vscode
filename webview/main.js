import { renderMarkdown } from "./markdown.js";

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    setup: $("setup"),
    chat: $("chat"),
    chatTitle: $("chat-title"),
    historyBtn: $("history-btn"),
    titleBtn: $("title-btn"),
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
    thinkingDD: $("thinking-dd"),
    inputBox: $("input-box"),
    permissionTray: $("permission-tray"),
    elicitationTray: $("elicitation-tray"),
    workingSet: $("working-set"),
    attachments: $("attachments"),
    autocomplete: $("autocomplete")
  };

  let body = "list"; // "list" | "thread"
  let busy = false; // whether a turn is in flight; gates edit/restore chrome
  // The thread is a flat sequence of blocks rendered in stream order. `block`
  // is the currently open block; a new block starts on a role change, a
  // messageId change, or after a tool/plan/error interrupts the flow.
  let block = null; // { kind: "user"|"assistant"|"thinking", mid, bubble|body, buffer, start?, label? }
  const toolEls = new Map();
  const terminalCache = new Map();
  const collapsedGroups = new Set();
  let lastSessions = [];
  let lastActiveId = null;
  let lastFolders = [];
  let listCtrl = null; // full sessions-list controller
  let menuCtrl = null; // title-dropdown controller

  let commands = [];
  let ac = null;
  let fileQueryToken = "";
  let currentTitle = "Chat";
  let lastUserText = "";

  const modeDropdown = createDropdown(el.modeDD, (v) => vscode.postMessage({ type: "setMode", mode: v }));
  // Model picker lists families; a separate thinking picker holds the effort
  // variants of the selected family (Copilot-style).
  let modelFamilies = [];
  // The active model family's display name, stamped onto each turn when it is
  // sent so the response footer can show "{model} · {time}" (VS Code's footer
  // detail). ACP does not report a per-turn model, so this is the model
  // selected at send time.
  let currentModelLabel = "";
  const modelDropdown = createDropdown(el.modelDD, onModelSelect, { buttonIcon: modelButtonIcon });
  const thinkingDropdown = createDropdown(el.thinkingDD, onThinkingSelect);

  // Icon shown on the model button only (not in the dropdown rows): sparkle for
  // Adaptive, generic chip otherwise. Brand icons can slot in here once
  // provided as SVGs (keyed by family).
  function brandIconOf(fam) {
    let icons = {};
    try { icons = JSON.parse(document.body.dataset.modelIcons || "{}"); } catch { icons = {}; }
    const s = ((fam.name || "") + " " + (fam.id || "")).toLowerCase();
    if (/claude/.test(s) && icons.claude) return { key: "claude", url: icons.claude };
    if (/gpt|openai/.test(s) && icons.openai) return { key: "openai", url: icons.openai };
    if (/grok/.test(s) && icons.grok) return { key: "grok", url: icons.grok };
    return null;
  }
  function modelButtonIcon(familyId) {
    const fam = familyById(familyId);
    if (!fam || isAdaptive(fam)) return "codicon-sparkle";
    const b = brandIconOf(fam);
    return b ? `img:${b.key} ${b.url}` : "codicon-chip";
  }

  function familyById(id) { return modelFamilies.find((f) => f.id === id); }
  function familyOfUid(uid) { return modelFamilies.find((f) => (f.variants || []).some((v) => v.value === uid)); }

  function onModelSelect(familyId) {
    const fam = familyById(familyId);
    if (!fam) return;
    currentModelLabel = fam.name || "";
    vscode.postMessage({ type: "setModel", model: fam.default });
    updateThinking(fam, fam.default);
  }
  function onThinkingSelect(uid) {
    vscode.postMessage({ type: "setModel", model: uid });
  }
  function updateThinking(fam, currentUid) {
    if (fam && (fam.variants || []).length > 1) {
      thinkingDropdown.set(fam.variants, currentUid);
      el.thinkingDD.classList.remove("hidden");
    } else {
      el.thinkingDD.classList.add("hidden");
    }
  }
  function isAdaptive(f) { return f.id === "adaptive" || /adaptive/i.test(f.name || ""); }

  function applyModelOptions(families, currentModel) {
    const list = Array.isArray(families) ? families.slice() : [];
    const adaptive = list.filter(isAdaptive);
    const rest = list.filter((f) => !isAdaptive(f)).sort((a, b) => a.name.localeCompare(b.name));
    modelFamilies = [...adaptive, ...rest];
    const items = [];
    modelFamilies.forEach((f) => items.push({ value: f.id, name: f.name }));
    // Separator after Adaptive, before the alphabetical list.
    if (adaptive.length && rest.length) items.splice(adaptive.length, 0, { sep: true });
    const fam = familyOfUid(currentModel) || modelFamilies[0];
    currentModelLabel = fam ? fam.name || "" : currentModelLabel;
    modelDropdown.set(items, fam ? fam.id : "");
    updateThinking(fam, currentModel);
  }
  function selectModelUid(uid) {
    const fam = familyOfUid(uid);
    if (!fam) return;
    currentModelLabel = fam.name || "";
    modelDropdown.setCurrent(fam.id);
    updateThinking(fam, uid);
  }

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
    // Back arrow + title switcher only make sense inside a session (thread view).
    el.historyBtn.classList.toggle("hidden", list);
    el.titleBtn.classList.toggle("as-heading", list);
    if (list) closeTitleMenu();
  }

  el.historyBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "refreshSessions" });
    setBody("list");
  });
  el.titleBtn.addEventListener("click", (e) => {
    if (body === "list") return;
    e.stopPropagation();
    toggleTitleMenu();
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
    updateSendState();
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

  el.input.addEventListener("input", () => { autosize(); updateAutocomplete(); updateSendState(); });

  function updateSendState() {
    el.send.disabled = !el.input.value.trim();
  }

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
    el.input.style.height = Math.min(Math.max(el.input.scrollHeight, 52), 240) + "px";
  }

  function scrollToBottom() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // Match VS Code's dynamic working-border speed: the "comet" duration scales
  // with input width (clamped 1.4s-2.5s) so it travels at a consistent visual
  // pace at any panel width. Mirrors chatInputPart._updateWorkingProgressAnimationDuration.
  let workingDuration = 0;
  function updateWorkingDuration(width) {
    const safe = Math.max(50, width || el.inputBox.clientWidth || 300);
    const d = Math.min(2.5, Math.max(1.4, 0.55 + 0.075 * Math.sqrt(safe)));
    if (Math.abs(d - workingDuration) < 0.05) return;
    workingDuration = d;
    el.inputBox.style.setProperty("--dv-input-working-duration", d.toFixed(2) + "s");
    // Force a one-frame restart so a new duration takes effect mid-flight
    // (browsers otherwise keep the old duration until the current cycle ends).
    if (el.inputBox.classList.contains("busy")) {
      el.inputBox.classList.add("anim-restart");
      void el.inputBox.offsetWidth;
      requestAnimationFrame(() => el.inputBox.classList.remove("anim-restart"));
    }
  }

  // Responsive composer: progressively drop labels, then whole controls, as the
  // panel narrows, so the toolbar never overlaps. Worst case keeps just Send.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      el.inputBox.classList.toggle("cmp-sm", w < 380); // labels -> icons only
      el.inputBox.classList.toggle("cmp-xs", w < 280); // hide mode/model/context
      el.inputBox.classList.toggle("cmp-xxs", w < 190); // only Send remains
      updateWorkingDuration(w);
    });
    ro.observe(el.inputBox);
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
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    const btnIcon = document.createElement("span");
    btnIcon.className = "dd-icon";
    const label = document.createElement("span");
    label.className = "dd-label";
    const chev = document.createElement("i");
    chev.className = "codicon codicon-chevron-down";
    btn.appendChild(btnIcon);
    btn.appendChild(label);
    btn.appendChild(chev);

    function iconFor(v) {
      if (opts.buttonIcon) return opts.buttonIcon(v) || "";
      if (opts.staticIcon) return opts.staticIcon;
      const it = items.find((x) => x.value === v);
      return it && it.icon ? it.icon : "";
    }
    function updateBtnIcon() {
      const ic = iconFor(current);
      btnIcon.classList.toggle("hidden", !ic);
      if (!ic) { btnIcon.innerHTML = ""; return; }
      if (ic.indexOf("img:") === 0) {
        // Render brand SVGs as a currentColor mask so they are monochrome and
        // adapt to light/dark automatically (no separate variants needed).
        const rest = ic.slice(4);
        const sp = rest.indexOf(" ");
        const key = rest.slice(0, sp);
        const url = rest.slice(sp + 1).replace(/"/g, "%22");
        btnIcon.innerHTML = `<span class="dd-brand dd-brand--${key}" style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"></span>`;
      } else {
        btnIcon.innerHTML = `<i class="codicon ${ic}"></i>`;
      }
    }
    const menu = document.createElement("div");
    menu.className = "dd-menu hidden";
    container.appendChild(btn);
    container.appendChild(menu);

    let items = [];
    let current = "";
    let filterText = "";

    function close() {
      menu.classList.add("hidden");
      btn.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
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
          if (it.sep) {
            if (!q) rows.appendChild(Object.assign(document.createElement("div"), { className: "dd-sep" }));
            return;
          }
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
      document.querySelectorAll(".dd-btn.open").forEach((b) => {
        if (b !== btn) { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); }
      });
      filterText = "";
      renderMenu();
      menu.classList.toggle("hidden");
      const open = !menu.classList.contains("hidden");
      btn.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
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
    document.querySelectorAll(".dd-btn.open").forEach((b) => { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); });
    closeUsagePopup();
    closeTitleMenu();
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

  // --- Turns & thread ------------------------------------------------------
  // The thread is a list of turns. Each turn pairs a user request with the
  // assistant response that follows it (assistant text, thinking, tool cards,
  // plan). This request/response model mirrors VS Code's chat and is what makes
  // edit-in-place, checkpoints (restore), and undo possible.

  let turns = [];
  let currentTurn = null;
  let turnSeq = 0;
  // The head node id after the most recently completed turn. A turn's revert
  // target ("checkpoint") is the head captured before it ran (headBefore).
  let lastHead = null;
  // Feature gates from the host (revert capability + settings).
  let caps = { revert: false, editRequests: "inline", checkpoints: true, showFileChanges: true, confirmRemoval: true, verbose: true, progressBorder: true, contextUsage: true, inlineReferencesStyle: "box" };
  // Pending revert-preview requests keyed by token.
  const previewWaiters = new Map();
  let previewSeq = 0;

  function respTarget() {
    return currentTurn ? currentTurn.resp : el.thread;
  }

  function actionBtn(icon, title, onClick) {
    const b = document.createElement("button");
    b.className = "msg-action";
    b.title = title;
    b.innerHTML = `<i class="codicon ${icon}"></i>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
    return b;
  }

  // Copy button with VS Code's two-icon cross-fade (copy <-> check), mirroring
  // chat.css's .chat-copy-action-icon-copy/-copied layered swap. `cls` is the
  // base button class (msg-action in toolbars, code-btn in code blocks).
  function copyButton(title, cls, getText) {
    const b = document.createElement("button");
    b.className = cls + " dv-copy";
    b.title = title;
    b.innerHTML =
      '<span class="dv-copy-icons">' +
      '<i class="codicon codicon-copy dv-copy-i"></i>' +
      '<i class="codicon codicon-check dv-copy-i2"></i>' +
      "</span>";
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: "copyText", text: getText() });
      b.classList.add("copied");
      setTimeout(() => b.classList.remove("copied"), 1200);
    });
    return b;
  }

  // Shared collapsible, built div-first (not <details>) so the grid
  // 1fr<->0fr height + opacity collapse can animate, mirroring VS Code's
  // chatCollapsibleContentPart. Native <details> accessibility is preserved via
  // role=button + aria-expanded + Enter/Space toggling on the header. Returns
  // { root, header (fill with the summary row), body (fill with content),
  // setCollapsed, isCollapsed }. Add `dv-nocollapse` to the root to freeze it.
  function makeCollapsible(rootClass, opts) {
    opts = opts || {};
    const root = document.createElement("div");
    root.className = rootClass + (opts.startCollapsed === false ? "" : " dv-collapsed");
    const header = document.createElement("div");
    header.className = "dv-collapsible-header";
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    const anim = document.createElement("div");
    anim.className = "dv-collapsible-anim";
    const inner = document.createElement("div");
    inner.className = "dv-collapsible-anim-inner";
    anim.appendChild(inner);
    root.appendChild(header);
    root.appendChild(anim);
    const sync = () => header.setAttribute("aria-expanded", root.classList.contains("dv-collapsed") ? "false" : "true");
    const setCollapsed = (v) => { root.classList.toggle("dv-collapsed", !!v); sync(); };
    const toggle = () => { if (!root.classList.contains("dv-nocollapse")) setCollapsed(!root.classList.contains("dv-collapsed")); };
    header.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
    sync();
    return { root, header, body: inner, setCollapsed, isCollapsed: () => root.classList.contains("dv-collapsed") };
  }

  // Create a new turn shell (request container + checkpoint row + response
  // container) and make it current. `text` is the user's message.
  function newTurn(mid, text) {
    finalizeBlock();
    hideWelcome();
    const container = document.createElement("div");
    container.className = "turn";
    const req = document.createElement("div");
    req.className = "turn-request";
    const reqBody = document.createElement("div");
    reqBody.className = "req-body";
    const reqText = document.createElement("div");
    reqText.className = "req-text bubble";
    reqBody.appendChild(reqText);
    req.appendChild(reqBody);
    const resp = document.createElement("div");
    resp.className = "turn-response";
    const checkpoint = document.createElement("div");
    checkpoint.className = "checkpoint-row hidden";
    container.appendChild(req);
    container.appendChild(checkpoint);
    container.appendChild(resp);
    el.thread.appendChild(container);
    const turn = {
      id: "t" + (++turnSeq), mid, container, req, reqBody, reqText, resp, checkpoint,
      text: text || "", headBefore: lastHead, headAfter: null, editing: false,
      createdAt: Date.now(), completedAt: null, model: currentModelLabel
    };
    turns.push(turn);
    currentTurn = turn;
    if (text !== undefined) setTurnText(turn, text);
    buildTurnChrome(turn);
    scrollToBottom();
    return turn;
  }

  function setTurnText(turn, text) {
    turn.text = text;
    if (text) turn.reqText.innerHTML = renderMarkdown(text);
    lastUserText = text;
  }

  // Request hover toolbar (Copy, Edit) + a persistent response footer toolbar
  // (Copy, Retry) + a hover timestamp + the checkpoint row (Restore). Rebuilt
  // whenever caps or busy state change.
  function buildTurnChrome(turn) {
    // A turn is complete once it is no longer the one actively streaming.
    turn.container.classList.toggle("complete", turn !== currentTurn || !busy);

    // Request toolbar (top-right, on hover): Copy + Edit.
    let reqActions = turn.req.querySelector(".msg-actions");
    if (reqActions) reqActions.remove();
    reqActions = document.createElement("div");
    reqActions.className = "msg-actions req-actions";
    reqActions.appendChild(copyButton("Copy", "msg-action", () => turn.text));
    if (canEditTurn(turn)) {
      reqActions.appendChild(actionBtn("codicon-edit", "Edit Request", () => startEditing(turn)));
    }
    turn.req.appendChild(reqActions);

    // Request timestamp under the bubble, revealed with the turn hover chrome
    // (live turns only; replayed history has no known original time).
    let ts = turn.req.querySelector(".turn-ts");
    if (ts) ts.remove();
    if (caps.verbose && !turn.replayed && turn.createdAt) {
      ts = document.createElement("div");
      ts.className = "turn-ts";
      ts.textContent = "Sent " + fmtTime(turn.createdAt);
      turn.req.appendChild(ts);
    }

    // Inline (click-to-edit) affordance on the whole bubble.
    turn.reqBody.onclick = null;
    if (caps.editRequests === "inline" && canEditTurn(turn)) {
      turn.req.classList.add("editable-inline");
      turn.reqBody.onclick = () => startEditing(turn);
    } else {
      turn.req.classList.remove("editable-inline");
    }

    // Checkpoint row (Restore Checkpoint) between request and response.
    renderCheckpointRow(turn);

    // Response footer (Copy, Retry) + completion time, persistent under a
    // completed response, mirroring VS Code's ChatMessageFooter.
    buildTurnFooter(turn);
  }

  function buildTurnFooter(turn) {
    let footer = turn.footer;
    if (footer) footer.remove();
    footer = document.createElement("div");
    footer.className = "chat-footer";
    // VS Code's ChatMessageFooter order: Retry first, then Copy (thumbs/report
    // are telemetry we drop). Retry carries a class so it can be hidden on
    // headless (request-less) turns.
    const retry = actionBtn("codicon-refresh", "Retry", () => {
      if (turn.text) vscode.postMessage({ type: "send", text: turn.text, newSession: false });
    });
    retry.classList.add("footer-retry");
    footer.appendChild(retry);
    footer.appendChild(copyButton("Copy", "msg-action", () => turn.resp.innerText.trim()));
    if (caps.verbose && !turn.replayed && turn.completedAt) {
      const det = document.createElement("span");
      det.className = "chat-footer-details";
      det.textContent = [turn.model, fmtTime(turn.completedAt)].filter(Boolean).join("  \u00b7  ");
      footer.appendChild(det);
    }
    turn.footer = footer;
    turn.container.appendChild(footer);
  }

  function refreshTurnChrome() {
    turns.forEach((t) => { if (!t.editing) buildTurnChrome(t); });
  }

  // A turn is "mapped" (revertable) when we know a node to revert to: either a
  // captured head-before, or it was created live in this session (a live first
  // turn has headBefore null but can be reverted by starting fresh). Turns
  // replayed from a loaded session without a known head cannot be mapped.
  function turnMapped(turn) {
    return turn.headBefore != null || !turn.replayed;
  }
  function canEditTurn(turn) {
    return caps.revert && caps.editRequests !== "none" && !busy && turnMapped(turn);
  }
  function canRestoreTurn(turn) {
    return caps.revert && caps.checkpoints && !busy && turnMapped(turn);
  }

  function renderCheckpointRow(turn) {
    const row = turn.checkpoint;
    row.innerHTML = "";
    if (!canRestoreTurn(turn)) { row.classList.add("hidden"); return; }
    row.classList.remove("hidden");
    const left = document.createElement("span");
    left.className = "checkpoint-line-left";
    const btn = document.createElement("button");
    btn.className = "checkpoint-restore";
    btn.innerHTML = '<i class="codicon codicon-history"></i><span>Restore Checkpoint</span>';
    btn.title = "Restores workspace and chat to this point";
    const right = document.createElement("span");
    right.className = "checkpoint-line-right";
    // Inline two-state confirm ("Discard Edits"/Cancel), like VS Code.
    let confirming = false;
    const cancel = document.createElement("button");
    cancel.className = "checkpoint-cancel hidden";
    cancel.innerHTML = '<i class="codicon codicon-close"></i>';
    cancel.title = "Cancel";
    const setConfirming = (v) => {
      confirming = v;
      row.classList.toggle("confirming", v);
      cancel.classList.toggle("hidden", !v);
      btn.querySelector("span").textContent = v ? "Discard Edits" : "Restore Checkpoint";
    };
    cancel.addEventListener("click", (e) => { e.stopPropagation(); setConfirming(false); });
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirming) { setConfirming(false); doRestore(turn); return; }
      const needs = await revertNeedsConfirm(turn);
      if (needs) setConfirming(true);
      else doRestore(turn);
    });
    row.appendChild(left);
    row.appendChild(btn);
    row.appendChild(cancel);
    row.appendChild(right);
  }

  // Restore: rewind to before this turn and drop the prompt text back into the
  // composer (do not auto-run), matching VS Code.
  function doRestore(turn) {
    if (turn.headBefore == null) {
      vscode.postMessage({ type: "revertExecute", newSession: true });
    } else {
      vscode.postMessage({ type: "revertExecute", head: turn.headBefore });
    }
    trimTurnsFrom(turn);
    renderRestoredRow();
    el.input.value = turn.text;
    el.input.focus();
    autosize();
    updateSendState();
  }

  // A "Checkpoint restored" divider left at the rewind point, matching VS Code's
  // restored-checkpoint row (fading lines + label). Note: there is no redo, as
  // re-running from a rewind is non-deterministic and ACP exposes no fork.
  function renderRestoredRow() {
    const prev = el.thread.querySelector(".restored-row");
    if (prev) prev.remove();
    const row = document.createElement("div");
    row.className = "restored-row";
    const left = document.createElement("span");
    left.className = "restored-line";
    const label = document.createElement("span");
    label.className = "restored-label";
    label.textContent = "Checkpoint restored";
    const right = document.createElement("span");
    right.className = "restored-line";
    row.appendChild(left);
    row.appendChild(label);
    row.appendChild(right);
    el.thread.appendChild(row);
    scrollToBottom();
  }

  // Ask the host to preview the revert; returns true if it would discard edits
  // or has irreversible actions and confirmation is enabled.
  function revertNeedsConfirm(turn) {
    if (!caps.confirmRemoval || turn.headBefore == null) return Promise.resolve(false);
    const token = "pv" + (++previewSeq);
    return new Promise((resolve) => {
      previewWaiters.set(token, (msg) => {
        if (msg.error || !msg.result) { resolve(false); return; }
        const r = msg.result;
        const has = (r.fileActions && r.fileActions.length) || (r.irreversibleWarnings && r.irreversibleWarnings.length);
        resolve(!!has);
      });
      vscode.postMessage({ type: "revertPreview", head: turn.headBefore, token });
      setTimeout(() => { if (previewWaiters.has(token)) { previewWaiters.delete(token); resolve(false); } }, 4000);
    });
  }

  // Remove this turn and every turn after it from the DOM/model.
  function trimTurnsFrom(turn) {
    const idx = turns.indexOf(turn);
    if (idx < 0) return;
    for (let i = turns.length - 1; i >= idx; i--) {
      turns[i].container.remove();
      turns.splice(i, 1);
    }
    currentTurn = turns[turns.length - 1] || null;
    if (currentTurn) lastHead = currentTurn.headAfter;
    else lastHead = null;
  }

  // --- Edit a request in place --------------------------------------------

  function startEditing(turn) {
    if (turn.editing || !canEditTurn(turn)) return;
    turn.editing = true;
    turn.req.classList.add("editing");
    turn.reqText.classList.add("hidden");
    const box = document.createElement("div");
    box.className = "req-editor";
    const ta = document.createElement("textarea");
    ta.className = "req-editor-input";
    ta.value = turn.text;
    const row = document.createElement("div");
    row.className = "req-editor-actions";
    const cancelBtn = btn("Cancel", "secondary", () => finishEditing(turn));
    const sendBtn = btn("Send", "primary", () => submitEdit(turn, ta.value));
    row.appendChild(cancelBtn);
    row.appendChild(sendBtn);
    box.appendChild(ta);
    box.appendChild(row);
    turn.reqBody.appendChild(box);
    turn.editorEl = box;
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight, 32), 240) + "px"; };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finishEditing(turn); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(turn, ta.value); }
    });
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    // Dim the turns that a submit would discard.
    markDiscardable(turn, true);
  }

  function finishEditing(turn) {
    turn.editing = false;
    turn.req.classList.remove("editing");
    turn.reqText.classList.remove("hidden");
    if (turn.editorEl) { turn.editorEl.remove(); turn.editorEl = null; }
    markDiscardable(turn, false);
  }

  async function submitEdit(turn, text) {
    text = (text || "").trim();
    if (!text) return;
    const needs = await revertNeedsConfirm(turn);
    if (needs && !(await confirmDiscard())) return;
    finishEditing(turn);
    trimTurnsFrom(turn);
    if (turn.headBefore == null) {
      vscode.postMessage({ type: "revertExecute", newSession: true, resendText: text });
    } else {
      vscode.postMessage({ type: "revertExecute", head: turn.headBefore, resendText: text });
    }
  }

  function markDiscardable(fromTurn, on) {
    const idx = turns.indexOf(fromTurn);
    if (idx < 0) return;
    for (let i = idx; i < turns.length; i++) {
      turns[i].container.classList.toggle("discardable", on && i !== idx);
    }
  }

  // In-thread confirmation shown before an edit/restore discards later turns'
  // file edits, replacing the native confirm() dialog. Resolves true to proceed.
  // A "Don't ask again" checkbox persists the preference to the host setting.
  function confirmDiscard() {
    return new Promise((resolve) => {
      const box = cwShell();
      cwTitle(box, "Discard later edits?");
      const body = cwBody(box);
      const m = document.createElement("div");
      m.className = "cw-message";
      m.textContent = "This removes this request and everything after it, and undoes the file edits those turns made.";
      body.appendChild(m);
      const dont = document.createElement("label");
      dont.className = "cw-dontask";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const sp = document.createElement("span");
      sp.textContent = "Don't ask again";
      dont.appendChild(cb);
      dont.appendChild(sp);
      body.appendChild(dont);
      const row = cwButtons(box);
      const done = (ok) => {
        if (ok && cb.checked) {
          caps.confirmRemoval = false;
          vscode.postMessage({ type: "setConfig", key: "editing.confirmEditRequestRemoval", value: false });
        }
        box.remove();
        resolve(ok);
      };
      row.appendChild(btn("Discard and resend", "primary", () => done(true)));
      row.appendChild(btn("Cancel", "secondary", () => done(false)));
      el.permissionTray.appendChild(box);
    });
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
      bar.appendChild(copyButton("Copy", "code-btn", getText));
      bar.appendChild(codeBtn("codicon-insert", "Insert at cursor", () => vscode.postMessage({ type: "insertAtCursor", text: getText() })));
      bar.appendChild(codeBtn("codicon-go-to-file", "Apply to file", () => vscode.postMessage({ type: "applyToFile", text: getText() })));
      if (SHELL_LANGS.has(lang)) {
        bar.appendChild(codeBtn("codicon-terminal", "Run in terminal", () => vscode.postMessage({ type: "runInTerminal", text: getText() })));
      }
      pre.appendChild(bar);
    });
  }

  // File/symbol references in assistant text (non http links) render as VS Code
  // style inline anchor chips: a bordered pill with a file-type icon. External
  // links stay plain. With inlineReferences.style === "link" they stay as plain
  // links (VS Code's chat.inlineReferences.style). Clicks are handled by the
  // delegated thread listener.
  function enhanceAnchors(container) {
    if (!container || caps.inlineReferencesStyle === "link") return;
    container.querySelectorAll("a[href]").forEach((a) => {
      if (a.dataset.anchored) return;
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || /^(https?|mailto):/i.test(href)) return;
      a.dataset.anchored = "1";
      a.classList.add("anchor-chip");
      const icon = document.createElement("i");
      icon.className = "codicon " + fileIconFor(a.textContent || href) + " anchor-chip-icon";
      a.insertBefore(icon, a.firstChild);
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
  // Split the reasoning buffer into a chain of steps, one per blank-line
  // separated block, and render each as a node on the connector timeline. A
  // fenced code block can legally contain blank lines, so keep the whole
  // buffer as a single step when one is present rather than tearing it apart.
  function thinkingSteps(text) {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) return [];
    if (trimmed.includes("```")) return [trimmed];
    return trimmed.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  }
  function renderThinkingItems(b) {
    const steps = thinkingSteps(b.buffer);
    b.body.innerHTML = steps
      .map(
        (step) =>
          '<div class="thinking-item"><i class="codicon codicon-circle-small-filled thinking-icon"></i>' +
          '<div class="thinking-item-content">' + renderMarkdown(step) + "</div></div>"
      )
      .join("");
  }
  function renderOpenBlock() {
    if (!block) return;
    const atBottom = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 60;
    if (block.kind === "thinking") {
      renderThinkingItems(block);
    } else if (block.kind === "user") {
      if (block.turn) { block.turn.text = block.buffer; block.turn.reqText.innerHTML = renderMarkdown(block.buffer); }
    } else {
      block.bubble.innerHTML = renderMarkdown(block.buffer);
      if (block.kind === "assistant") { enhanceCodeBlocks(block.bubble); enhanceAnchors(block.bubble); }
    }
    if (atBottom) scrollToBottom();
  }

  // Assistant content (text, thinking, tools, plan) always belongs to a turn.
  // If none is open (e.g. an assistant-first history replay), start a headless
  // one with no request row.
  function ensureTurn() {
    if (!currentTurn) {
      newTurn(undefined, undefined);
      currentTurn.container.classList.add("headless");
    }
    return currentTurn;
  }

  // Close the current block, running any finalisation it needs.
  function finalizeBlock() {
    if (!block) return;
    renderOpenBlock();
    if (block.kind === "thinking") {
      if (block.timer) clearInterval(block.timer);
      if (block.details) block.details.classList.remove("thinking-active");
      const secs = Math.max(1, Math.round((Date.now() - block.start) / 1000));
      if (block.label) block.label.textContent = `Thought for ${secs}s`;
    }
    block = null;
  }

  // A subtle "Working…" placeholder shown after send, until the first token,
  // thought, tool or plan arrives (mirrors VS Code's pending indicator).
  let workingEl = null;
  function showWorking() {
    hideWorking();
    ensureTurn();
    const w = document.createElement("div");
    w.className = "working";
    w.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i><span class="dv-shimmer">Working\u2026</span>';
    respTarget().appendChild(w);
    workingEl = w;
    scrollToBottom();
  }
  function hideWorking() {
    if (workingEl) { workingEl.remove(); workingEl = null; }
  }

  function appendAssistant(text, mid) {
    hideWorking();
    if (!(block && block.kind === "assistant" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
      const bubble = document.createElement("div");
      bubble.className = "resp-text bubble";
      respTarget().appendChild(bubble);
      block = { kind: "assistant", mid, bubble, buffer: "" };
    }
    block.buffer += text;
    scheduleRender();
  }

  function appendThought(text, mid) {
    hideWorking();
    if (!(block && block.kind === "thinking" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
      const c = makeCollapsible("thinking thinking-active", { startCollapsed: true });
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right thinking-chevron";
      const label = document.createElement("span");
      label.className = "thinking-label";
      label.textContent = "Thinking\u2026";
      c.header.appendChild(chev);
      c.header.appendChild(label);
      const bodyEl = document.createElement("div");
      bodyEl.className = "thinking-body";
      c.body.appendChild(bodyEl);
      respTarget().appendChild(c.root);
      block = { kind: "thinking", mid, details: c.root, body: bodyEl, label, buffer: "", start: Date.now(), timer: null };
      const tb = block;
      tb.timer = setInterval(() => {
        if (!tb.label) return;
        const secs = Math.max(1, Math.round((Date.now() - tb.start) / 1000));
        tb.label.textContent = `Thinking\u2026 ${secs}s`;
      }, 1000);
    }
    block.buffer += text;
    scheduleRender();
  }

  // A user turn streamed during history replay (user_message_chunk): starts a
  // new turn and streams the request text into it.
  function appendUserChunk(text, mid) {
    if (!(block && block.kind === "user" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      const turn = newTurn(mid, "");
      turn.replayed = true; // from a loaded session; node id unknown
      buildTurnChrome(turn); // hide edit/restore until (if) a head is known
      block = { kind: "user", mid, turn, buffer: "" };
    }
    block.buffer += text;
    lastUserText = block.buffer;
    // Render the request text synchronously so a finalize between replayed
    // chunks can never leave the bubble as an empty placeholder.
    if (block.turn) {
      block.turn.text = block.buffer;
      block.turn.reqText.innerHTML = renderMarkdown(block.buffer);
    }
    scrollToBottom();
  }

  // A user turn we already have in full (live echo from the host).
  function addUserMessage(text) {
    finalizeBlock();
    hideWelcome();
    newTurn(undefined, text);
  }
  function renderPlan(entries) {
    hideWorking();
    finalizeBlock();
    hideWelcome();
    ensureTurn();
    // Reuse a single plan box per turn so live updates replace it.
    let box = currentTurn && currentTurn.planEl;
    if (!box) {
      box = document.createElement("div");
      box.className = "plan";
      respTarget().appendChild(box);
      if (currentTurn) currentTurn.planEl = box;
    }
    box.innerHTML = "";
    const title = document.createElement("div");
    title.className = "plan-title";
    title.textContent = "Plan";
    box.appendChild(title);
    (entries || []).forEach((entry) => {
      const st = entry.status === "completed" ? "done" : entry.status === "in_progress" ? "active" : "pending";
      const row = document.createElement("div");
      row.className = "plan-entry plan-" + st;
      const mark = document.createElement("i");
      mark.className = "codicon plan-mark " + (st === "done" ? "codicon-pass-filled" : st === "active" ? "codicon-loading codicon-modifier-spin" : "codicon-circle-large-outline");
      const txt = document.createElement("span");
      txt.textContent = entry.content;
      row.appendChild(mark);
      row.appendChild(txt);
      box.appendChild(row);
    });
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

  // VS Code shows a tool line as a normal-weight verb followed by a dimmed
  // detail (e.g. "Read" + " src/auth/token.ts"). Devin gives one title string,
  // so split on the first space.
  function setToolLabel(labelEl, title) {
    const t = String(title || "Tool");
    const sp = t.indexOf(" ");
    const verb = sp === -1 ? t : t.slice(0, sp);
    const rest = sp === -1 ? "" : t.slice(sp);
    labelEl.textContent = "";
    const v = document.createElement("span");
    v.className = "tool-verb";
    v.textContent = verb;
    labelEl.appendChild(v);
    if (rest) {
      const r = document.createElement("span");
      r.className = "tool-detail";
      r.textContent = rest;
      labelEl.appendChild(r);
    }
  }

  function upsertTool(m) {
    hideWorking();
    let entry = toolEls.get(m.id);
    if (!entry) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
      const c = makeCollapsible("tool", { startCollapsed: true });
      const node = c.root;
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right tool-chevron";
      const kindIcon = document.createElement("i");
      kindIcon.className = "codicon tool-kind";
      const label = document.createElement("span");
      label.className = "label";
      const statEl = document.createElement("i");
      statEl.className = "codicon tool-status";
      c.header.appendChild(chev);
      c.header.appendChild(kindIcon);
      c.header.appendChild(label);
      c.header.appendChild(statEl);
      const bodyEl = document.createElement("div");
      bodyEl.className = "tool-body";
      c.body.appendChild(bodyEl);
      respTarget().appendChild(node);
      entry = { node, kindIcon, label, statEl, bodyEl, data: {}, collapse: c };
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

    // Update only the status class (className overwrite would wipe the
    // dv-collapsed / tool-empty state the collapsible controller manages).
    ["pending", "in_progress", "completed", "failed", "cancelled"].forEach((s) => entry.node.classList.remove(s));
    entry.node.classList.add(d.status || "pending");
    entry.kindIcon.className = "codicon tool-kind " + (TOOL_KIND_ICONS[d.kind] || TOOL_KIND_ICONS.other);
    entry.statEl.className = "codicon tool-status " + statusIcon(d.status);
    setToolLabel(entry.label, d.title);
    renderToolBody(entry);
    // Track files this turn looked at for a "Used N references" summary.
    if (currentTurn && Array.isArray(d.locations) && ["read", "search", "fetch"].includes(d.kind)) {
      currentTurn.refs = currentTurn.refs || new Map();
      d.locations.forEach((l) => {
        if (l && l.path && !currentTurn.refs.has(l.path)) currentTurn.refs.set(l.path, { path: l.path, line: l.line });
      });
      renderUsedRefs(currentTurn);
    }
    // Inline progress: reflect the running tool in the header status.
    if (d.status === "in_progress" && d.title) {
      el.status.textContent = d.title;
    } else if (d.status === "completed" || d.status === "failed") {
      el.status.textContent = "";
    }
    scrollToBottom();
  }

  // A collapsed "Used N references" summary at the top of a turn's response,
  // aggregating the files the agent read or searched (VS Code's used-context).
  function renderUsedRefs(turn) {
    if (!turn.refs || !turn.refs.size) return;
    let box = turn.usedRefsEl;
    if (!box) {
      const c = makeCollapsible("used-refs", { startCollapsed: true });
      box = c.root;
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right used-refs-chevron";
      const label = document.createElement("span");
      label.className = "used-refs-label";
      c.header.appendChild(chev);
      c.header.appendChild(label);
      const body = document.createElement("div");
      body.className = "used-refs-body";
      c.body.appendChild(body);
      turn.resp.insertBefore(box, turn.resp.firstChild);
      turn.usedRefsEl = box;
      turn.usedRefsBody = body;
      turn.usedRefsLabel = label;
    }
    const n = turn.refs.size;
    turn.usedRefsLabel.textContent = "Used " + n + " reference" + (n === 1 ? "" : "s");
    turn.usedRefsBody.innerHTML = "";
    turn.refs.forEach((f) => turn.usedRefsBody.appendChild(filePill({ path: f.path, line: f.line, diff: false })));
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
      if (!entry.node.dataset.autoOpened) {
        if (entry.collapse) entry.collapse.setCollapsed(false);
        entry.node.dataset.autoOpened = "1";
      }
    }

    const diffItems = (d.content || []).filter((c) => c.type === "diff" && c.path);
    const locs = (d.locations || []).slice();
    const fileRows = [
      ...diffItems.map((c) => ({ path: c.path, diff: true, added: c.added, removed: c.removed })),
      ...locs.map((l) => ({ path: l.path, line: l.line, diff: false }))
    ];
    if (fileRows.length) {
      hasContent = true;
      const sec = document.createElement("div");
      sec.className = "tool-section tool-files";
      fileRows.forEach((f) => sec.appendChild(filePill(f)));
      body.appendChild(sec);
    }

    // An empty tool has nothing to reveal, so it must not collapse/expand.
    entry.node.classList.toggle("tool-empty", !hasContent);
    entry.node.classList.toggle("dv-nocollapse", !hasContent);

    // Auto-expand a failed tool so the error is visible without a click
    // (VS Code's chat.tools.autoExpandFailures).
    if (d.status === "failed" && hasContent && entry.collapse && !entry.node.dataset.autoOpened) {
      entry.collapse.setCollapsed(false);
      entry.node.dataset.autoOpened = "1";
    }
  }

  // A file reference rendered as a VS Code style pill: a file-type icon, the
  // name, and (for edits) +added / -removed line counts. Clicking opens a diff
  // for edited files or the file at a line otherwise.
  function filePill(f) {
    const link = document.createElement("a");
    link.className = "file-change";
    link.title = f.path;
    const icon = document.createElement("i");
    icon.className = "codicon " + fileIconFor(f.path) + " file-pill-icon";
    const name = document.createElement("span");
    name.className = "file-pill-name";
    name.textContent = baseName(f.path) + (f.line ? ":" + f.line : "");
    link.appendChild(icon);
    link.appendChild(name);
    if (f.added) {
      const a = document.createElement("span");
      a.className = "label-added";
      a.textContent = "+" + f.added;
      link.appendChild(a);
    }
    if (f.removed) {
      const r = document.createElement("span");
      r.className = "label-removed";
      r.textContent = "-" + f.removed;
      link.appendChild(r);
    }
    link.addEventListener("click", () => {
      if (f.diff) vscode.postMessage({ type: "openDiff", path: f.path });
      else vscode.postMessage({ type: "openFile", path: f.path, line: f.line });
    });
    return link;
  }

  function safeJson(v) {
    try {
      const s = JSON.stringify(v, null, 2);
      return s && s.length > 4000 ? s.slice(0, 4000) + "\n…" : s;
    } catch {
      return String(v);
    }
  }
  function addFileChange(m) {
    const path = typeof m === "string" ? m : m.path;
    const added = typeof m === "object" ? m.added : undefined;
    const removed = typeof m === "object" ? m.removed : undefined;
    const created = typeof m === "object" && m.created;
    finalizeBlock();
    hideWelcome();
    ensureTurn();
    const node = document.createElement("div");
    node.className = "edit-pill";
    const status = document.createElement("i");
    status.className = "codicon codicon-check edit-pill-status";
    // Text status next to the icon, like VS Code's edit-pill .status-label.
    const label = document.createElement("span");
    label.className = "edit-pill-label";
    label.textContent = created ? "Created" : "Edited";
    node.appendChild(status);
    node.appendChild(label);
    node.appendChild(filePill({ path, diff: true, added, removed }));
    respTarget().appendChild(node);
    scrollToBottom();
  }

  // --- Permissions & elicitation -------------------------------------------

  // VS Code chat-confirmation-widget2 shell: a bordered card with an optional
  // bold title row (border-bottom), a message/body section, and a right-aligned
  // primary/secondary button row. Used by the permission, elicitation, and
  // edit-discard confirmations so they all read as one widget.
  function cwShell() {
    const box = document.createElement("div");
    box.className = "cw";
    return box;
  }
  function cwTitle(box, text) {
    const t = document.createElement("div");
    t.className = "cw-title";
    t.textContent = text;
    box.appendChild(t);
    return t;
  }
  function cwBody(box) {
    const b = document.createElement("div");
    b.className = "cw-body";
    box.appendChild(b);
    return b;
  }
  function cwButtons(box) {
    const r = document.createElement("div");
    r.className = "cw-buttons";
    box.appendChild(r);
    return r;
  }

  function showPermission(data) {
    const box = cwShell();
    cwTitle(box, data.title || "Devin wants to run a tool");
    const row = cwButtons(box);
    (data.options || []).forEach((opt) => {
      const reject = /reject/.test(opt.kind || "");
      row.appendChild(btn(opt.name || opt.optionId, reject ? "secondary" : "primary", () => {
        vscode.postMessage({ type: "permission", requestId: data.requestId, optionId: opt.optionId });
        box.remove();
      }));
    });
    el.permissionTray.appendChild(box);
  }

  function showElicitation(data) {
    let widget;
    // Post the response, drop the widget, and leave a Q/A recap in the
    // transcript (like VS Code), so the exchange stays visible.
    const finish = (action, content, recap) => {
      vscode.postMessage({ type: "elicitationResponse", requestId: data.requestId, action, content });
      if (widget) widget.remove();
      if (recap && recap.length) renderQaRecap(recap);
    };

    // URL prompts are a simple confirmation, not a question carousel.
    if (data.mode === "url" && data.url) {
      const box = cwShell();
      widget = box;
      cwTitle(box, data.message || "Devin has a question");
      const body = cwBody(box);
      const url = document.createElement("div");
      url.className = "cw-message muted";
      url.textContent = data.url;
      body.appendChild(url);
      const row = cwButtons(box);
      row.appendChild(btn("Open", "primary", () => finish("accept")));
      row.appendChild(btn("Decline", "secondary", () => finish("decline")));
      el.elicitationTray.appendChild(box);
      return;
    }

    const props = (data.schema && data.schema.properties) || {};
    const names = Object.keys(props);
    const required = (data.schema && data.schema.required) || [];
    const controls = names.map((key) => buildElicitQuestion(key, props[key], {
      allowOther: data.allowOther,
      required: required.includes(key),
      hideTitle: names.length === 1 && props[key].title === data.message
    }));

    // A one-card-at-a-time carousel (VS Code's chat-question-carousel): the
    // header keeps the prompt + step, the body shows the current question, and
    // the footer navigates and submits all answers at once.
    const qc = document.createElement("div");
    qc.className = "qc";
    if (controls.length <= 1) qc.classList.add("qc-single");
    widget = qc;

    const header = document.createElement("div");
    header.className = "qc-header";
    const title = document.createElement("div");
    title.className = "qc-title";
    title.textContent = data.message || "Devin has a question";
    const close = actionBtn("codicon-close", "Cancel", () =>
      finish("cancel", undefined, controls.map((c) => ({ title: c.title, answer: "" })))
    );
    header.appendChild(title);
    header.appendChild(close);
    qc.appendChild(header);

    const body = document.createElement("div");
    body.className = "qc-body";
    controls.forEach((c) => body.appendChild(c.el));
    qc.appendChild(body);

    const validation = document.createElement("div");
    validation.className = "qc-validation hidden";
    validation.textContent = "Please answer this question.";
    qc.appendChild(validation);

    const footer = document.createElement("div");
    footer.className = "qc-footer";
    const prev = actionBtn("codicon-chevron-left", "Previous", () => show(idx - 1));
    const next = actionBtn("codicon-chevron-right", "Next", () => show(idx + 1));
    const nav = document.createElement("div");
    nav.className = "qc-nav";
    nav.appendChild(prev);
    nav.appendChild(next);
    const step = document.createElement("span");
    step.className = "qc-step";
    const spacer = document.createElement("span");
    spacer.className = "qc-spacer";
    const submit = btn("Submit", "primary", () => {
      controls.forEach((c) => c.el.classList.remove("elicit-invalid"));
      const bad = controls.findIndex((c) => !c.valid());
      if (bad >= 0) {
        show(bad);
        controls[bad].el.classList.add("elicit-invalid");
        validation.classList.remove("hidden");
        return;
      }
      const content = {};
      const recap = controls.map((c) => {
        content[c.key] = c.value();
        return { title: c.title, answer: c.answerText() };
      });
      finish("accept", content, recap);
    });
    footer.appendChild(nav);
    footer.appendChild(step);
    footer.appendChild(spacer);
    footer.appendChild(submit);
    qc.appendChild(footer);

    let idx = 0;
    function show(i) {
      idx = Math.max(0, Math.min(controls.length - 1, i));
      controls.forEach((c, j) => c.el.classList.toggle("hidden", j !== idx));
      const label = controls.length + " question" + (controls.length === 1 ? "" : "s");
      step.textContent = controls.length > 1 ? (idx + 1) + " / " + controls.length : label;
      prev.disabled = idx === 0;
      next.disabled = idx === controls.length - 1;
      validation.classList.add("hidden");
    }
    show(0);
    el.elicitationTray.appendChild(qc);
  }

  // Builds one question block for an elicitation form. Returns the element plus
  // value()/valid() for submission and title/answerText() for the recap.
  // Handles single-select (oneOf), multi-select (array, items.anyOf), an
  // "Other" free-text choice, and a plain text/number/boolean fallback.
  function buildElicitQuestion(key, spec, opts) {
    const title = spec.title || spec.description || key;
    const field = document.createElement("div");
    field.className = "elicit-field";
    if (!opts.hideTitle && (spec.title || spec.description)) {
      const lab = document.createElement("div");
      lab.className = "elicit-q";
      lab.textContent = title;
      field.appendChild(lab);
    }

    const isMulti = spec.type === "array";
    const optionDefs = isMulti ? (spec.items && spec.items.anyOf) || [] : spec.oneOf || [];

    // Free text / number / boolean when there are no discrete options. Free
    // text uses an auto-growing textarea (VS Code's chat-question-freeform).
    if (!optionDefs.length && !isMulti) {
      let input;
      if (spec.type === "boolean") { input = document.createElement("input"); input.type = "checkbox"; }
      else if (spec.type === "number" || spec.type === "integer") { input = document.createElement("input"); input.type = "number"; }
      else { input = document.createElement("textarea"); input.rows = 1; }
      const isCheckbox = input.type === "checkbox";
      const isNumber = input.type === "number";
      const isFreeform = input.tagName === "TEXTAREA";
      input.className = "elicit-input" + (isFreeform ? " elicit-freeform" : "");
      if (spec.default !== undefined && !isCheckbox) input.value = String(spec.default);
      if (isFreeform) {
        const grow = () => { input.style.height = "auto"; input.style.height = Math.min(Math.max(input.scrollHeight, 28), 160) + "px"; };
        input.addEventListener("input", grow);
        setTimeout(grow, 0);
      }
      field.appendChild(input);
      const val = () => (isCheckbox ? input.checked : isNumber ? Number(input.value) : input.value);
      return {
        key, el: field, title,
        value: val,
        valid: () => (!opts.required || isCheckbox || String(input.value).trim() !== ""),
        answerText: () => (isCheckbox ? (input.checked ? "Yes" : "No") : String(input.value))
      };
    }

    const name = "elicit-" + key + "-" + Math.random().toString(36).slice(2, 7);
    const choices = []; // { input, label, val } for the fixed options
    let otherRadio = null;
    let otherText = null;

    const addOption = (label, val, isOther) => {
      const opt = document.createElement("label");
      opt.className = "elicit-option";
      const input = document.createElement("input");
      input.type = isMulti ? "checkbox" : "radio";
      input.name = name;
      input.className = "elicit-native";
      if (!isOther) input.value = val;
      // VS Code's question-list rows show a check indicator (not a native
      // control); the native input is kept (visually hidden) for state + a11y.
      const indicator = document.createElement("i");
      indicator.className = "codicon codicon-check elicit-indicator";
      const span = document.createElement("span");
      span.className = "elicit-option-label";
      span.textContent = label;
      opt.appendChild(input);
      opt.appendChild(indicator);
      opt.appendChild(span);
      if (isOther) {
        otherRadio = input;
        otherText = document.createElement("input");
        otherText.type = "text";
        otherText.className = "elicit-input elicit-other";
        otherText.placeholder = "Type your answer";
        otherText.addEventListener("input", () => { if (otherText.value && !input.checked) input.checked = true; });
        opt.appendChild(otherText);
      } else {
        choices.push({ input, label, val });
      }
      field.appendChild(opt);
    };

    optionDefs.forEach((o) => addOption(o.title || String(o.const), o.const, false));
    if (opts.allowOther) addOption("Other", null, true);

    const otherValue = () => (otherRadio && otherRadio.checked && otherText.value.trim() ? otherText.value.trim() : null);
    const selectedValues = () => {
      const vals = choices.filter((c) => c.input.checked).map((c) => c.val);
      const o = otherValue();
      if (o) vals.push(o);
      return vals;
    };
    const selectedLabels = () => {
      const labels = choices.filter((c) => c.input.checked).map((c) => c.label);
      const o = otherValue();
      if (o) labels.push(o);
      return labels;
    };
    const minItems = spec.minItems || (opts.required ? 1 : 0);
    return {
      key, el: field, title,
      value: () => (isMulti ? selectedValues() : selectedValues()[0]),
      valid: () => (isMulti ? selectedValues().length >= minItems : (!opts.required || selectedValues().length >= 1)),
      answerText: () => selectedLabels().join(", ")
    };
  }

  // Persistent Q/A block left in the transcript after a question is answered,
  // one card per question (VS Code style): dimmed "Q:" and bold "A:", or an
  // italic "Skipped" when nothing was chosen.
  function renderQaRecap(items) {
    ensureTurn();
    items.forEach((it) => {
      const box = document.createElement("div");
      box.className = "qa-recap";
      const q = document.createElement("div");
      q.className = "qa-q";
      q.textContent = "Q: " + it.title;
      box.appendChild(q);
      const a = document.createElement("div");
      if (it.answer && String(it.answer).trim()) {
        a.className = "qa-a";
        a.textContent = "A: " + it.answer;
      } else {
        a.className = "qa-skipped";
        a.textContent = "Skipped";
      }
      box.appendChild(a);
      respTarget().appendChild(box);
    });
    scrollToBottom();
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

  // --- Attachments + implicit context -------------------------------------

  let lastAttachments = [];
  // The active-editor "current file" that VS Code shows as an implicit context
  // pill: { path, name, line1?, line2?, enabled } or null.
  let implicit = null;

  // Best-effort file-type codicon by extension. A webview cannot reach VS Code's
  // file icon theme, so this maps the common cases; unknown falls back to file.
  const FILE_ICONS = {
    js: "codicon-file-code", jsx: "codicon-file-code", ts: "codicon-file-code", tsx: "codicon-file-code",
    py: "codicon-file-code", rb: "codicon-file-code", go: "codicon-file-code", rs: "codicon-file-code",
    java: "codicon-file-code", c: "codicon-file-code", h: "codicon-file-code", cpp: "codicon-file-code",
    cs: "codicon-file-code", php: "codicon-file-code", sh: "codicon-terminal", bash: "codicon-terminal",
    zsh: "codicon-terminal", html: "codicon-file-code", css: "codicon-file-code", scss: "codicon-file-code",
    json: "codicon-json", md: "codicon-markdown", markdown: "codicon-markdown",
    png: "codicon-file-media", jpg: "codicon-file-media", jpeg: "codicon-file-media", gif: "codicon-file-media",
    svg: "codicon-file-media", webp: "codicon-file-media", pdf: "codicon-file-pdf",
    zip: "codicon-file-zip", tar: "codicon-file-zip", gz: "codicon-file-zip"
  };
  function fileIconFor(name) {
    const ext = (String(name || "").split(".").pop() || "").toLowerCase();
    return FILE_ICONS[ext] || "codicon-file";
  }

  function renderAttachments(items) {
    lastAttachments = Array.isArray(items) ? items : [];
    renderComposerContext();
  }

  // Renders the implicit "current file" pill (first) followed by the explicit
  // attachment pills, into the shared #attachments row.
  function renderComposerContext() {
    el.attachments.innerHTML = "";
    const hasImplicit = !!(implicit && implicit.path);
    if (!hasImplicit && lastAttachments.length === 0) { el.attachments.classList.add("hidden"); return; }
    el.attachments.classList.remove("hidden");
    if (hasImplicit) el.attachments.appendChild(implicitChip(implicit));
    lastAttachments.forEach((a) => el.attachments.appendChild(attachmentChip(a)));
  }

  function attachmentChip(a) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.dataset.id = a.id;
    if (a.type === "image" && a.thumb) {
      const img = document.createElement("img");
      img.className = "chip-thumb";
      img.src = a.thumb;
      img.alt = "";
      chip.appendChild(img);
    } else {
      const icon = document.createElement("i");
      icon.className = "codicon " + (a.type === "image" ? "codicon-file-media" : a.type === "selection" ? "codicon-selection" : fileIconFor(a.label));
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent = a.label;
    chip.appendChild(label);
    const x = document.createElement("button");
    x.className = "chip-x";
    x.tabIndex = -1;
    x.title = "Remove from context";
    x.innerHTML = '<i class="codicon codicon-close"></i>';
    x.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "removeAttachment", id: a.id }); });
    chip.appendChild(x);
    chip.addEventListener("keydown", (e) => onChipKey(e, chip));
    return chip;
  }

  function implicitChip(ic) {
    const chip = document.createElement("span");
    chip.className = "chip implicit" + (ic.enabled ? "" : " disabled");
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.title = ic.path;
    // VS Code renders the toggle (x when enabled, + when disabled) before the
    // label. Clicking it includes/excludes the current file.
    const toggle = document.createElement("button");
    toggle.className = "chip-x";
    toggle.tabIndex = -1;
    toggle.title = ic.enabled ? "Don't include the current file" : "Include the current file";
    toggle.innerHTML = '<i class="codicon ' + (ic.enabled ? "codicon-close" : "codicon-add") + '"></i>';
    toggle.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "setImplicit", enabled: !ic.enabled }); });
    const icon = document.createElement("i");
    icon.className = "codicon " + fileIconFor(ic.name);
    const label = document.createElement("span");
    label.className = "chip-label";
    const range = ic.line1 ? ":" + ic.line1 + (ic.line2 && ic.line2 !== ic.line1 ? "-" + ic.line2 : "") : "";
    label.textContent = ic.name + range;
    chip.appendChild(toggle);
    chip.appendChild(icon);
    chip.appendChild(label);
    chip.addEventListener("keydown", (e) => onChipKey(e, chip));
    return chip;
  }

  // Arrow keys move focus between pills; Delete/Backspace removes the focused
  // one (or disables the implicit pill).
  function onChipKey(e, chip) {
    const chips = [...el.attachments.querySelectorAll(".chip")];
    const i = chips.indexOf(chip);
    if (e.key === "ArrowRight") { e.preventDefault(); (chips[i + 1] || chips[0]).focus(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); (chips[i - 1] || chips[chips.length - 1]).focus(); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const next = chips[i + 1] || chips[i - 1];
      if (chip.classList.contains("implicit")) vscode.postMessage({ type: "setImplicit", enabled: false });
      else if (chip.dataset.id) vscode.postMessage({ type: "removeAttachment", id: chip.dataset.id });
      if (next) next.focus();
    }
  }

  // --- Reusable session list (shared by the full list and the title menu) --

  function filterSessions(sessions, q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      (s.title || "").toLowerCase().includes(q) || (s.short_id || s.id || "").toLowerCase().includes(q)
    );
  }

  // Groups sessions by workspace (workspace folders first) with collapsible
  // headers, appending session rows into `container`.
  function renderSessionGroups(container, sessions, activeId, folders) {
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
    const folderOrder = (folders || []).map((f) => f.path);
    const rank = (k) => { const i = folderOrder.indexOf(k); return i === -1 ? folderOrder.length + 1 : i; };
    orderedKeys.sort((a, b) => rank(a) - rank(b));

    const showGroups = (folders || []).length > 1 || orderedKeys.length > 1;
    orderedKeys.forEach((key) => {
      const rows = groups.get(key);
      if (showGroups) {
        const collapsed = collapsedGroups.has(key);
        const header = document.createElement("div");
        header.className = "group-header" + (collapsed ? " collapsed" : "");
        const chev = document.createElement("i");
        chev.className = "codicon codicon-chevron-down group-chevron";
        const txt = document.createElement("span");
        txt.className = "group-label";
        txt.textContent = folderNames.get(key) || (key === "__workspace__" ? "This workspace" : baseName(key));
        const count = document.createElement("span");
        count.className = "group-count";
        count.textContent = String(rows.length);
        header.appendChild(chev);
        header.appendChild(txt);
        header.appendChild(count);
        const box = document.createElement("div");
        box.className = "group-items" + (collapsed ? " hidden" : "");
        rows.forEach((s) => box.appendChild(sessionRow(s, activeId)));
        header.addEventListener("click", () => {
          const nowCollapsed = !collapsedGroups.has(key);
          if (nowCollapsed) collapsedGroups.add(key); else collapsedGroups.delete(key);
          box.classList.toggle("hidden", nowCollapsed);
          header.classList.toggle("collapsed", nowCollapsed);
        });
        container.appendChild(header);
        container.appendChild(box);
      } else {
        rows.forEach((s) => container.appendChild(sessionRow(s, activeId)));
      }
    });
  }

  // Mounts a search box + grouped rows into `container`; returns { refresh }.
  function mountSessionList(container, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const state = { q: "" };
    if (opts.withNewChat) {
      const nw = document.createElement("div");
      nw.className = "session-newchat";
      nw.innerHTML = '<i class="codicon codicon-add"></i><span>New chat</span>';
      nw.addEventListener("click", () => { closeTitleMenu(); vscode.postMessage({ type: "newSession" }); });
      container.appendChild(nw);
    }
    const search = document.createElement("input");
    search.className = "session-search";
    search.type = "text";
    search.placeholder = "Search by title or code\u2026";
    search.addEventListener("input", () => { state.q = search.value; renderBody(); });
    search.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("keydown", (e) => e.stopPropagation());
    const body = document.createElement("div");
    body.className = "session-list-body";
    container.appendChild(search);
    container.appendChild(body);
    function renderBody() {
      body.innerHTML = "";
      if (!lastSessions.length) {
        body.innerHTML = '<div class="sessions-empty"><i class="codicon codicon-comment-discussion"></i><div>No chats yet.</div></div>';
        return;
      }
      const filtered = filterSessions(lastSessions, state.q);
      if (!filtered.length) { body.innerHTML = '<div class="sessions-empty-sm">No matching sessions</div>'; return; }
      renderSessionGroups(body, filtered, lastActiveId, lastFolders);
    }
    renderBody();
    return { refresh: renderBody };
  }

  // --- Title session switcher (dropdown from the header title) -------------

  function toggleTitleMenu() {
    if (document.getElementById("title-menu")) { closeTitleMenu(); return; }
    vscode.postMessage({ type: "refreshSessions" });
    const menu = document.createElement("div");
    menu.id = "title-menu";
    menu.className = "title-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    el.titleBtn.parentElement.appendChild(menu);
    menuCtrl = mountSessionList(menu, { withNewChat: true });
  }

  function closeTitleMenu() {
    const m = document.getElementById("title-menu");
    if (m) m.remove();
    menuCtrl = null;
  }

  // --- Sessions list -------------------------------------------------------

  function renderSessions(sessions, activeId, folders) {
    lastSessions = sessions || [];
    lastActiveId = activeId;
    lastFolders = folders || [];
    if (!listCtrl) {
      listCtrl = mountSessionList(el.sessionsList, {});
    } else {
      listCtrl.refresh();
    }
    if (menuCtrl) {
      menuCtrl.refresh();
    }
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
    const time = document.createElement("span");
    time.className = "session-time";
    time.textContent = s.last_activity_ago || agoFrom(s.last_activity_at) || "";
    const code = document.createElement("span");
    code.className = "session-code";
    code.textContent = s.short_id || s.id;
    meta.appendChild(time);
    meta.appendChild(code);
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener("click", () => {
      closeTitleMenu();
      currentTitle = s.title || "Chat";
      el.chatTitle.textContent = currentTitle;
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
  function setBusy(value) {
    const wasBusy = busy;
    busy = value;
    el.send.classList.toggle("hidden", value);
    el.stop.classList.toggle("hidden", !value);
    // Copilot-style animated indicator on the input (gated by progressBorder).
    el.inputBox.classList.toggle("busy", value && caps.progressBorder);
    if (!value) {
      el.status.textContent = "";
      // Stamp the just-finished turn's completion time (live turns only).
      if (wasBusy && currentTurn && !currentTurn.replayed && !currentTurn.completedAt) {
        currentTurn.completedAt = Date.now();
      }
    }
  }

  // Apply UI preference gates (progress border, context usage) when the host
  // sends capabilities. Timestamps (verbose) are gated in buildTurnChrome.
  function applyCapPrefs() {
    el.inputBox.classList.toggle("busy", busy && caps.progressBorder);
    if (!caps.contextUsage) {
      el.usage.classList.add("hidden");
      closeUsagePopup();
    }
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
    if (el.thread.querySelector(".turn")) return;
    const box = document.createElement("div");
    box.className = "welcome";
    const logoSrc = document.body.dataset.logo;
    let icon;
    if (logoSrc) {
      icon = document.createElement("img");
      icon.className = "welcome-logo";
      icon.src = logoSrc;
      icon.alt = "Devin";
    } else {
      icon = document.createElement("i");
      icon.className = "codicon codicon-comment-discussion welcome-icon";
    }
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
    const l = el.thread.querySelector(".thread-loading");
    if (l) l.remove();
  }

  function showThreadLoading() {
    el.thread.innerHTML = "";
    const d = document.createElement("div");
    d.className = "thread-loading";
    d.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin"></i><span>Loading session\u2026</span>';
    el.thread.appendChild(d);
  }

  function threadHasContent() {
    return !!el.thread.querySelector(".turn, .tool, .edit-pill, .plan, .thinking");
  }

  // --- Error rendering -----------------------------------------------------

  function renderError(text) {
    hideWorking();
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
    respTarget().appendChild(box);
    scrollToBottom();
  }

  // Short local time (HH:MM) for turn timestamps.
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch { return ""; }
  }

  // --- Usage / cost --------------------------------------------------------

  function fmtTokens(n) {
    if (!n && n !== 0) return "";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
  }

  let lastUsage = null;

  function fmtCost(cost) {
    if (!cost || typeof cost.amount !== "number") return "";
    return (cost.amount < 1 ? "$" + cost.amount.toFixed(3) : "$" + cost.amount.toFixed(2));
  }

  function ringSvg(pct) {
    const r = 7, c = 2 * Math.PI * r;
    const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
    // Arc colour matches VS Code's context-usage widget: normal icon colour,
    // amber past 75%, red past 90%; track is the dimmed disabled foreground.
    const arc = pct >= 90
      ? "var(--vscode-editorError-foreground, #f14c4c)"
      : pct >= 75
        ? "var(--vscode-editorWarning-foreground, #cca700)"
        : "var(--vscode-icon-foreground, var(--vscode-foreground))";
    return (
      `<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">` +
      `<circle cx="9" cy="9" r="7" fill="none" stroke="var(--vscode-disabledForeground, var(--vscode-panel-border))" stroke-width="2.5" opacity="0.5"/>` +
      `<circle cx="9" cy="9" r="7" fill="none" stroke="${arc}" stroke-width="2.5" stroke-linecap="round"` +
      ` stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`
    );
  }

  function renderUsage(m) {
    if (!caps.contextUsage) { el.usage.classList.add("hidden"); lastUsage = null; return; }
    if (!m.used || !m.size) { el.usage.classList.add("hidden"); lastUsage = null; closeUsagePopup(); return; }
    lastUsage = m;
    const pct = Math.round((m.used / m.size) * 100);
    el.usage.innerHTML = ringSvg(pct) + `<span class="usage-pct">${pct}%</span>`;
    el.usage.title = "Context used \u2014 click for details";
    el.usage.classList.remove("hidden");
    refreshUsagePopup();
  }

  function closeUsagePopup() {
    const p = document.getElementById("usage-popup");
    if (p) p.remove();
  }

  function refreshUsagePopup() {
    const pop = document.getElementById("usage-popup");
    if (pop && lastUsage) pop.innerHTML = usagePopupHtml(lastUsage);
  }

  function usagePopupHtml(m) {
    const pct = Math.round((m.used / m.size) * 100);
    const cost = fmtCost(m.cost);
    return (
      `<div class="usage-row"><span>Context window</span><span>${pct}%</span></div>` +
      `<div class="usage-bar"><div style="width:${Math.min(100, pct)}%"></div></div>` +
      `<div class="usage-row muted"><span>Tokens</span><span>${fmtTokens(m.used)} / ${fmtTokens(m.size)}</span></div>` +
      (cost ? `<div class="usage-row muted"><span>Cost this turn</span><span>${cost}</span></div>` : "")
    );
  }

  el.usage.addEventListener("click", (e) => {
    e.stopPropagation();
    if (document.getElementById("usage-popup")) { closeUsagePopup(); return; }
    if (!lastUsage) return;
    const pop = document.createElement("div");
    pop.id = "usage-popup";
    pop.className = "usage-popup";
    pop.innerHTML = usagePopupHtml(lastUsage);
    pop.addEventListener("click", (ev) => ev.stopPropagation());
    el.usage.parentElement.appendChild(pop);
  });

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
  function agoFrom(ts) {
    if (!ts) return "";
    const d = Math.max(0, Date.now() / 1000 - ts);
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  }

  // --- Inbound messages ----------------------------------------------------

  window.addEventListener("message", (event) => {
    const m = event.data;
    try {
      handleMessage(m);
    } catch (err) {
      // A bug in one handler must never wedge the whole UI (e.g. leaving the
      // sessions list stuck on its loading spinner). Surface it and recover.
      try { console.error("[devin] message handler error", m && m.type, err); } catch {}
      try { vscode.postMessage({ type: "webviewError", where: m && m.type, message: String(err && err.stack || err) }); } catch {}
      // If the sessions list was mid-load, clear the spinner so it is usable.
      if (m && (m.type === "sessions" || m.type === "sessionsLoading") && el.sessionsList) {
        try { renderSessions(lastSessions, lastActiveId, lastFolders); } catch { el.sessionsList.innerHTML = '<div class="sessions-empty-sm">Could not load sessions.</div>'; }
      }
    }
  });

  function handleMessage(m) {
    switch (m.type) {
      case "setup": renderSetup(m.health || {}); break;
      case "ready": setView("chat"); setBody("list"); break;
      case "body": setView("chat"); setBody(m.body === "list" ? "list" : "thread"); break;
      case "workspace": break;
      case "options":
        modeDropdown.set(m.modes, m.currentMode);
        applyModelOptions(m.models, m.currentModel);
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
        workingEl = null;
        el.thread.innerHTML = "";
        turns = [];
        currentTurn = null;
        lastHead = null;
        previewWaiters.clear();
        el.permissionTray.innerHTML = "";
        el.elicitationTray.innerHTML = "";
        renderWorkingSet([]);
        renderAttachments([]);
        toolEls.clear();
        if (block && block.timer) clearInterval(block.timer);
        block = null;
        el.usage.classList.add("hidden");
        el.usage.innerHTML = "";
        lastUsage = null;
        closeUsagePopup();
        if (m.loading) showThreadLoading();
        else if (body === "thread") renderWelcome();
        break;
      case "loaded":
        { const l = el.thread.querySelector(".thread-loading"); if (l) l.remove(); }
        if (body === "thread" && !threadHasContent()) renderWelcome();
        break;
      case "sessionsLoading":
        el.sessionsList.innerHTML = '<div class="list-loading"><i class="codicon codicon-loading codicon-modifier-spin"></i></div>';
        listCtrl = null;
        break;
      case "userMessage":
        if (currentTitle === "Chat") { currentTitle = m.text.slice(0, 40); el.chatTitle.textContent = currentTitle; }
        addUserMessage(m.text);
        break;
      case "userChunk": appendUserChunk(m.text, m.messageId); break;
      case "assistantStart": finalizeBlock(); showWorking(); break;
      case "assistantChunk": appendAssistant(m.text, m.messageId); break;
      case "thoughtChunk": appendThought(m.text, m.messageId); break;
      case "assistantEnd": hideWorking(); finalizeBlock(); break;
      case "plan": renderPlan(m.entries); break;
      case "toolCall":
      case "toolCallUpdate": upsertTool(m); break;
      case "fileChange": addFileChange(m); break;
      case "workingSet": renderWorkingSet(m.files); break;
      case "attachments": renderAttachments(m.items); break;
      case "implicitContext":
        implicit = m.file ? { path: m.file.path, name: m.file.name, line1: m.file.line1, line2: m.file.line2, enabled: m.enabled !== false } : null;
        renderComposerContext();
        break;
      case "permission": showPermission(m); break;
      case "elicitation": showElicitation(m); break;
      case "busy": setBusy(m.value); refreshTurnChrome(); break;
      case "mode": if (m.mode) modeDropdown.setCurrent(m.mode); break;
      case "model": if (m.model) selectModelUid(m.model); break;
      case "terminalOutput": updateTerminal(m); break;
      case "usage": renderUsage(m); break;
      case "error": renderError(m.text); break;
      case "capabilities":
        caps = Object.assign(caps, {
          revert: !!m.revert,
          editRequests: m.editRequests || caps.editRequests,
          checkpoints: m.checkpoints !== undefined ? !!m.checkpoints : caps.checkpoints,
          showFileChanges: m.showFileChanges !== undefined ? !!m.showFileChanges : caps.showFileChanges,
          confirmRemoval: m.confirmRemoval !== undefined ? !!m.confirmRemoval : caps.confirmRemoval,
          verbose: m.verbose !== undefined ? !!m.verbose : caps.verbose,
          progressBorder: m.progressBorder !== undefined ? !!m.progressBorder : caps.progressBorder,
          contextUsage: m.contextUsage !== undefined ? !!m.contextUsage : caps.contextUsage,
          inlineReferencesStyle: m.inlineReferencesStyle || caps.inlineReferencesStyle
        });
        applyCapPrefs();
        refreshTurnChrome();
        break;
      case "turnHead":
        if (typeof m.head === "number") {
          lastHead = m.head;
          if (currentTurn) currentTurn.headAfter = m.head;
        }
        break;
      case "reverted": break; // UI already trimmed the turns; host did the rewind.
      case "revertPreview": {
        const w = previewWaiters.get(m.token);
        if (w) { previewWaiters.delete(m.token); w(m); }
        break;
      }
      default: break;
    }
  }

  vscode.postMessage({ type: "ready" });
})();
