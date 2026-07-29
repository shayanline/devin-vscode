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
    modelDropdown.set(items, fam ? fam.id : "");
    updateThinking(fam, currentModel);
  }
  function selectModelUid(uid) {
    const fam = familyOfUid(uid);
    if (!fam) return;
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

  // Responsive composer: progressively drop labels, then whole controls, as the
  // panel narrows, so the toolbar never overlaps. Worst case keeps just Send.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      el.inputBox.classList.toggle("cmp-sm", w < 380); // labels -> icons only
      el.inputBox.classList.toggle("cmp-xs", w < 280); // hide mode/model/context
      el.inputBox.classList.toggle("cmp-xxs", w < 190); // only Send remains
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
  let caps = { revert: false, editRequests: "inline", checkpoints: true, showFileChanges: true, confirmRemoval: true };
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

  function flashCheck(b) {
    const i = b.querySelector("i");
    const prev = i.className;
    i.className = "codicon codicon-check";
    setTimeout(() => { i.className = prev; }, 1200);
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
      text: text || "", headBefore: lastHead, headAfter: null, editing: false
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

  // Request hover toolbar (Edit) + response footer (Copy, Retry) + the
  // checkpoint row (Restore). Rebuilt whenever caps change.
  function buildTurnChrome(turn) {
    // Request toolbar (top-right, on hover): Edit.
    let reqActions = turn.req.querySelector(".msg-actions");
    if (reqActions) reqActions.remove();
    reqActions = document.createElement("div");
    reqActions.className = "msg-actions req-actions";
    reqActions.appendChild(actionBtn("codicon-copy", "Copy", (b) => {
      vscode.postMessage({ type: "copyText", text: turn.text });
      flashCheck(b);
    }));
    if (canEditTurn(turn)) {
      reqActions.appendChild(actionBtn("codicon-edit", "Edit Request", () => startEditing(turn)));
    }
    turn.req.appendChild(reqActions);

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
    el.input.value = turn.text;
    el.input.focus();
    autosize();
    updateSendState();
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
    if (needs && !window.confirm("This will remove this request and everything after it, and undo any edits those turns made. Continue?")) {
      return;
    }
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
    } else if (block.kind === "user") {
      if (block.turn) { block.turn.text = block.buffer; block.turn.reqText.innerHTML = renderMarkdown(block.buffer); }
    } else {
      block.bubble.innerHTML = renderMarkdown(block.buffer);
      if (block.kind === "assistant") enhanceCodeBlocks(block.bubble);
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
      const secs = Math.max(1, Math.round((Date.now() - block.start) / 1000));
      if (block.label) block.label.textContent = `Thought for ${secs}s`;
    }
    block = null;
  }

  function appendAssistant(text, mid) {
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
    if (!(block && block.kind === "thinking" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
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
      respTarget().appendChild(details);
      block = { kind: "thinking", mid, body: bodyEl, label, buffer: "", start: Date.now(), timer: null };
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
      ensureTurn();
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
      respTarget().appendChild(node);
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
      el.status.textContent = "";
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
    ensureTurn();
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
    respTarget().appendChild(node);
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
    const required = (data.schema && data.schema.required) || [];
    // Each control returns { value(), valid() } for its question.
    const controls = names.map((key) => buildElicitQuestion(key, props[key], {
      allowOther: data.allowOther,
      required: required.includes(key),
      hideTitle: names.length === 1 && props[key].title === data.message
    }));
    controls.forEach((c) => box.appendChild(c.el));

    const row = document.createElement("div");
    row.className = "options elicit-actions";
    const submit = btn("Submit", "primary", () => {
      if (!controls.every((c) => c.valid())) {
        box.classList.add("elicit-invalid");
        return;
      }
      const content = {};
      controls.forEach((c) => { content[c.key] = c.value(); });
      respond("accept", content);
    });
    row.appendChild(submit);
    row.appendChild(btn("Cancel", "secondary", () => respond("cancel")));
    box.appendChild(row);
    el.elicitationTray.appendChild(box);
  }

  // Builds one question block for an elicitation form. Handles single-select
  // (oneOf), multi-select (type array, items.anyOf), an "Other" free-text
  // choice, and a plain text/number/boolean fallback.
  function buildElicitQuestion(key, spec, opts) {
    const field = document.createElement("div");
    field.className = "elicit-field";
    if (!opts.hideTitle && (spec.title || spec.description)) {
      const lab = document.createElement("div");
      lab.className = "elicit-q";
      lab.textContent = spec.title || spec.description;
      field.appendChild(lab);
    }

    const isMulti = spec.type === "array";
    const optionDefs = isMulti ? (spec.items && spec.items.anyOf) || [] : spec.oneOf || [];

    // Free text / number / boolean when there are no discrete options.
    if (!optionDefs.length && !isMulti) {
      let input;
      if (spec.type === "boolean") { input = document.createElement("input"); input.type = "checkbox"; }
      else if (spec.type === "number" || spec.type === "integer") { input = document.createElement("input"); input.type = "number"; }
      else { input = document.createElement("input"); input.type = "text"; }
      input.className = "elicit-input";
      if (spec.default !== undefined && input.type !== "checkbox") input.value = String(spec.default);
      field.appendChild(input);
      return {
        key, el: field,
        value: () => (input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value),
        valid: () => (!opts.required || input.type === "checkbox" || String(input.value).trim() !== "")
      };
    }

    const name = "elicit-" + key + "-" + Math.random().toString(36).slice(2, 7);
    const inputs = [];
    let otherRadio = null;
    let otherText = null;

    const addOption = (label, val, isOther) => {
      const opt = document.createElement("label");
      opt.className = "elicit-option";
      const input = document.createElement("input");
      input.type = isMulti ? "checkbox" : "radio";
      input.name = name;
      if (!isOther) input.value = val;
      const span = document.createElement("span");
      span.textContent = label;
      opt.appendChild(input);
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
        inputs.push(input);
      }
      field.appendChild(opt);
    };

    optionDefs.forEach((o) => addOption(o.title || String(o.const), o.const, false));
    if (opts.allowOther) addOption("Other", null, true);

    const selectedValues = () => {
      const vals = inputs.filter((i) => i.checked).map((i) => i.value);
      if (otherRadio && otherRadio.checked && otherText.value.trim()) vals.push(otherText.value.trim());
      return vals;
    };
    const minItems = spec.minItems || (opts.required ? 1 : 0);
    return {
      key, el: field,
      value: () => (isMulti ? selectedValues() : selectedValues()[0]),
      valid: () => (isMulti ? selectedValues().length >= minItems : (!opts.required || selectedValues().length >= 1))
    };
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
    busy = value;
    el.send.classList.toggle("hidden", value);
    el.stop.classList.toggle("hidden", !value);
    // Copilot-style animated indicator on the input instead of a "Working…" label.
    el.inputBox.classList.toggle("busy", value);
    if (!value) el.status.textContent = "";
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
    return !!el.thread.querySelector(".turn, .tool, .tool-line, .plan, .thinking");
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
    respTarget().appendChild(box);
    scrollToBottom();
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
    const warn = pct >= 85 ? "var(--vscode-charts-red, #f14c4c)" : "var(--vscode-progressBar-background)";
    return (
      `<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">` +
      `<circle cx="9" cy="9" r="7" fill="none" stroke="var(--vscode-panel-border)" stroke-width="2.5"/>` +
      `<circle cx="9" cy="9" r="7" fill="none" stroke="${warn}" stroke-width="2.5" stroke-linecap="round"` +
      ` stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`
    );
  }

  function renderUsage(m) {
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
          confirmRemoval: m.confirmRemoval !== undefined ? !!m.confirmRemoval : caps.confirmRemoval
        });
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
