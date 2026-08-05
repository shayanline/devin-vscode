import { renderMarkdown, renderShell, renderCode } from "./markdown.js";

(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // Power/shutdown glyph for the "terminate session" (kill) controls. Codicons
  // (@vscode/codicons) has no power symbol, so this ships as an inline SVG like
  // the send button, keeping the classic shutdown look independent of the font.
  const KILL_GLYPH =
    '<svg class="kill-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 2.2v5"/><path d="M5.1 4.5a4.3 4.3 0 1 0 5.8 0"/></svg>';

  const el = {
    boot: $("boot"),
    setup: $("setup"),
    chat: $("chat"),
    chatTitle: $("chat-title"),
    historyBtn: $("history-btn"),
    titleBtn: $("title-btn"),
    titleCode: $("title-code"),
    panelToggle: $("panel-toggle"),
    headerDivider: $("header-divider"),
    newSessionDd: $("new-session-dd"),
    sessionsResizer: $("sessions-resizer"),
    listSearchBtn: $("list-search-btn"),
    listFilterBtn: $("list-filter-btn"),
    listRefreshBtn: $("list-refresh-btn"),
    settingsBtn: $("settings-btn"),
    terminateBtn: $("terminate-btn"),
    status: $("status"),
    usage: $("usage"),
    sessionsList: $("sessions-list"),
    sessionsPanel: $("sessions-panel"),
    chatMain: $("chat-main"),
    bodyEl: $("body"),
    thread: $("thread"),
    input: $("input"),
    send: $("send"),
    stop: $("stop"),
    attach: $("attach"),
    modeDD: $("mode-dd"),
    modelDD: $("model-dd"),
    thinkingDD: $("thinking-dd"),
    inputBox: $("input-box"),
    composer: $("composer"),
    permissionTray: $("permission-tray"),
    elicitationTray: $("elicitation-tray"),
    workingSet: $("working-set"),
    todoWidget: $("todo-widget"),
    attachments: $("attachments"),
    autocomplete: $("autocomplete"),
    scrollDown: $("scroll-down")
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
  // Per-session liveness for the status dots: id -> "running" | "idle" |
  // "starting". Absent means dead (gray). Sent by the host.
  let sessionStatuses = {};
  // Retained transcripts so switching back to an idle session is instant (no
  // reload): id -> { frag, turns, ... }. A dirty id changed in the background
  // and must be reloaded instead of restored. curSessionId is the session whose
  // transcript is currently mounted in the thread.
  const views = new Map();
  const dirtyViews = new Set();
  let curSessionId = null;
  let listCtrl = null; // full sessions-list controller
  let menuCtrl = null; // title-dropdown controller
  let panelCtrl = null; // embedded side-panel controller (feature 2)
  let sessionsPanelOpen = false; // whether the embedded side panel is shown

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

  // Icon shown on the model button: sparkle for Adaptive, the brand codicon for
  // Claude / OpenAI, and a generic chip otherwise. Grok has no codicon, so it
  // still uses the bundled SVG mask (via brandIconOf).
  function brandIconOf(fam) {
    let icons = {};
    try { icons = JSON.parse(document.body.dataset.modelIcons || "{}"); } catch { icons = {}; }
    const s = ((fam.name || "") + " " + (fam.id || "")).toLowerCase();
    if (/grok/.test(s) && icons.grok) return { key: "grok", url: icons.grok };
    return null;
  }
  function modelButtonIcon(familyId) {
    const fam = familyById(familyId);
    if (!fam || isAdaptive(fam)) return "codicon-sparkle";
    const s = ((fam.name || "") + " " + (fam.id || "")).toLowerCase();
    if (/claude/.test(s)) return "codicon-claude";
    if (/gpt|openai/.test(s)) return "codicon-openai";
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
    const rest = list.filter((f) => !isAdaptive(f)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
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

  // Dismiss the boot overlay once there is real content to show (setup, the
  // session list, or an error). Idempotent.
  let booted = false;
  function hideBoot() {
    if (booted) return;
    booted = true;
    if (el.boot) el.boot.classList.add("hidden");
  }
  // Safety net: never let the overlay stick if the host is slow or silent.
  setTimeout(hideBoot, 15000);

  function setBody(b) {
    body = b;
    const list = b === "list";
    el.sessionsList.classList.toggle("hidden", !list);
    el.thread.classList.toggle("hidden", list);
    // The composer lives outside the body panels, so mark the list view so its
    // session-scoped widgets (working set, context ring) hide while browsing.
    el.composer.classList.toggle("list-mode", list);
    el.input.placeholder = list ? "Start a new chat\u2026" : "Ask Devin, or type @ to add a file";
    if (list) { closeTitleMenu(); detachComposerFromSession(); closeSessionsPanel(); stopThreadLoading(); }
    renderHeader();
    updateComposerDock();
    updateTerminateBtn();
    updateScrollDownButton();
  }

  // --- Custom webview title bar --------------------------------------------
  // We drive all controls from the webview header (VS Code's own view/title
  // buttons are removed): the Sessions list header (New/Search/Filter/Refresh/
  // Settings) and the in-session header (panel toggle, back, title + subtitle,
  // rename, terminate).
  function mkIcon(name) {
    const i = document.createElement("i");
    i.className = "codicon codicon-" + name;
    return i;
  }
  function setBtnIcon(btn, name) {
    btn.textContent = "";
    btn.appendChild(mkIcon(name));
  }

  function currentSessionMeta() {
    return curSessionId ? lastSessions.find((s) => s.id === curSessionId) : null;
  }

  function renderHeader() {
    const list = body === "list";
    // List-mode cluster: refresh sits in front of the title, the rest on the right.
    el.listRefreshBtn.classList.toggle("hidden", !list);
    el.newSessionDd.classList.toggle("hidden", !list);
    el.listSearchBtn.classList.toggle("hidden", !list);
    el.listFilterBtn.classList.toggle("hidden", !list);
    el.settingsBtn.classList.toggle("hidden", !list);
    // Thread-mode clusters.
    el.historyBtn.classList.toggle("hidden", list);
    el.headerDivider.classList.toggle("hidden", list);
    el.titleBtn.classList.toggle("as-heading", list);
    el.chatTitle.textContent = list ? "Sessions" : currentTitle;
    // In a session, the session code shows as a badge to the left of the title.
    const meta = list ? null : currentSessionMeta();
    if (!list && meta && meta.short_id) {
      el.titleCode.textContent = meta.short_id;
      el.titleCode.classList.remove("hidden");
    } else {
      el.titleCode.textContent = "";
      el.titleCode.classList.add("hidden");
    }
    if (list) {
      el.panelToggle.classList.add("hidden");
    } else {
      updatePanelToggle();
    }
  }

  // In-session: whether there is room for the docked sessions panel beside the
  // thread. Wide -> a sidebar toggle for the docked panel; narrow -> a
  // list-tree button that opens the session switcher dropdown instead.
  const SIDE_BY_SIDE_MIN = 600;
  function hasRoomForPanel() {
    return el.chat.clientWidth >= SIDE_BY_SIDE_MIN;
  }
  function updatePanelToggle() {
    if (body !== "thread") return;
    el.panelToggle.classList.remove("hidden");
    if (hasRoomForPanel()) {
      setBtnIcon(el.panelToggle, sessionsPanelOpen ? "layout-sidebar-left-off" : "layout-sidebar-left");
      el.panelToggle.title = sessionsPanelOpen ? "Hide sessions" : "Show sessions";
      el.panelToggle.classList.toggle("active", sessionsPanelOpen);
    } else {
      // No room for a docked panel: the list-tree button opens the switcher.
      if (sessionsPanelOpen) closeSessionsPanel();
      setBtnIcon(el.panelToggle, "list-tree");
      el.panelToggle.title = "Switch session";
      el.panelToggle.classList.remove("active");
    }
  }

  function openSessionsPanel() {
    if (!hasRoomForPanel()) { toggleTitleMenu(); return; }
    sessionsPanelOpen = true;
    el.sessionsPanel.classList.remove("hidden");
    el.sessionsResizer.classList.remove("hidden");
    el.chat.classList.add("panel-open");
    if (!panelCtrl) {
      panelCtrl = mountSessionList(el.sessionsPanel, { controls: "panel" });
    } else {
      panelCtrl.refresh();
    }
    vscode.postMessage({ type: "refreshSessions" });
    updatePanelToggle();
  }
  function closeSessionsPanel() {
    sessionsPanelOpen = false;
    el.sessionsPanel.classList.add("hidden");
    el.sessionsResizer.classList.add("hidden");
    el.chat.classList.remove("panel-open");
    if (body === "thread") updatePanelToggle();
  }
  function toggleSessionsPanel() {
    if (sessionsPanelOpen) closeSessionsPanel();
    else openSessionsPanel();
  }

  // The test harness (jsdom) has no ResizeObserver; guard it.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => { if (body === "thread") updatePanelToggle(); });
    ro.observe(el.chat);
  }

  // A small floating popover/menu anchored to a header button. `align` is
  // "center" | "left" | "right" relative to the anchor; the box is clamped to
  // the viewport so it never renders off-screen, and flips above the anchor if
  // it would overflow the bottom.
  function makeFloater(anchor, content, align, onClose) {
    const boxEl = document.createElement("div");
    boxEl.className = "dv-floater";
    boxEl.appendChild(content);
    document.body.appendChild(boxEl);
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = boxEl.offsetWidth;
    const bh = boxEl.offsetHeight;
    let left;
    if (align === "center") left = r.left + r.width / 2 - bw / 2;
    else if (align === "left") left = r.left;
    else left = r.right - bw;
    left = Math.max(4, Math.min(left, vw - bw - 4));
    let top = r.bottom + 4;
    if (top + bh > vh - 4 && r.top - bh - 4 >= 0) top = r.top - bh - 4;
    top = Math.max(4, top);
    boxEl.style.left = left + "px";
    boxEl.style.top = top + "px";
    boxEl.addEventListener("mousedown", (e) => e.stopPropagation());
    const onDown = (e) => { if (!boxEl.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    function close() {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      boxEl.remove();
      if (onClose) onClose();
    }
    return { el: boxEl, close };
  }

  // The New Session dropdown, shared by the labelled header button and the
  // icon-only button in the sessions panel / switcher.
  let newSessionFloater = null;
  function openNewSessionMenu(anchor) {
    if (newSessionFloater) { newSessionFloater.close(); return; }
    const menu = document.createElement("div");
    menu.className = "dv-menu";
    const items = [
      { icon: "new-session", label: "New Session", target: "view" },
      { icon: "split-horizontal", label: "New Session (Editor)", target: "editor" },
      { icon: "multiple-windows", label: "New Session (Window)", target: "window" },
      { icon: "terminal", label: "New Devin CLI Session (Terminal)", target: "terminal" }
    ];
    for (const it of items) {
      const row = document.createElement("button");
      row.className = "dv-menu-item";
      row.appendChild(mkIcon(it.icon));
      row.appendChild(Object.assign(document.createElement("span"), { textContent: it.label }));
      row.addEventListener("click", () => { vscode.postMessage({ type: "newSessionAt", target: it.target }); if (newSessionFloater) newSessionFloater.close(); });
      menu.appendChild(row);
    }
    newSessionFloater = makeFloater(anchor, menu, "center", () => { newSessionFloater = null; });
  }
  function buildNewSessionButton() {
    const b = document.createElement("button");
    b.className = "new-session-btn";
    b.title = "New session";
    b.appendChild(mkIcon("new-session"));
    b.appendChild(Object.assign(document.createElement("span"), { textContent: "New Session" }));
    b.appendChild(mkIcon("chevron-down"));
    b.addEventListener("click", (e) => { e.stopPropagation(); openNewSessionMenu(b); });
    return b;
  }
  el.newSessionDd.appendChild(buildNewSessionButton());

  // Drag the divider between the sessions sidebar and the chat content to
  // resize the panel freely.
  el.sessionsResizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.sessionsPanel.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("dv-resizing");
    const onMove = (ev) => {
      let w = startW + (ev.clientX - startX);
      const maxW = Math.max(240, el.chat.clientWidth - 320);
      w = Math.max(220, Math.min(w, maxW));
      el.sessionsPanel.style.width = w + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.classList.remove("dv-resizing");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Header button wiring.
  el.panelToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hasRoomForPanel()) toggleSessionsPanel();
    else toggleTitleMenu();
  });
  el.listSearchBtn.addEventListener("click", (e) => { e.stopPropagation(); if (listCtrl) listCtrl.toggleSearch(el.listSearchBtn); });
  el.listFilterBtn.addEventListener("click", (e) => { e.stopPropagation(); if (listCtrl) listCtrl.toggleFilter(el.listFilterBtn); });
  el.listRefreshBtn.addEventListener("click", () => { spinBtn(el.listRefreshBtn); vscode.postMessage({ type: "refreshSessions", force: true }); });
  el.settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));

  function spinBtn(btn) { btn.classList.add("spin"); setTimeout(() => btn.classList.remove("spin"), 600); }

  // Indeterminate loading bar along the top edge of the body, using the same
  // travelling accent as the composer's working border. Replaces the spinners
  // that used to sit inside the thread and the session list.
  const loadingBar = document.createElement("div");
  loadingBar.className = "dv-top-loading hidden";
  el.bodyEl.appendChild(loadingBar);
  function showLoadingBar() { loadingBar.classList.remove("hidden"); }
  function hideLoadingBar() { loadingBar.classList.add("hidden"); }

  // Entering the sessions list turns the composer into a clean "new chat" box:
  // the draft, attachments, request-edit binding, docked plan and busy state
  // all belonged to the session we just left. The in-flight turn is cancelled
  // host-side (leaveToList / showSessions). The working set and context ring
  // are only hidden by list-mode CSS, not cleared, so pending edits stay
  // reviewable and reappear when a thread is reopened.
  function detachComposerFromSession() {
    cancelInputEditing();
    el.input.value = "";
    closeAutocomplete();
    autosize();
    updateSendState();
    renderAttachments([]);
    // Drop any open question/permission widget: a still-pending one is re-posted
    // by the host when the session is reopened, so keeping it here would leave a
    // stale copy and double up on return.
    el.elicitationTray.innerHTML = "";
    el.permissionTray.innerHTML = "";
    planCollapsePref = null;
    wsCollapsePref = null;
    hideDockedPlan();
    closeUsagePopup();
    if (busy) setBusy(false);
  }

  function isAliveStatus(st) { return st === "running" || st === "idle" || st === "starting" || st === "attention"; }

  // The header terminate control is shown only inside a live session's thread.
  function updateTerminateBtn() {
    const show = body === "thread" && !!curSessionId && isAliveStatus(sessionStatuses[curSessionId]);
    el.terminateBtn.classList.toggle("hidden", !show);
  }
  el.terminateBtn.innerHTML = KILL_GLYPH;
  el.terminateBtn.addEventListener("click", () => {
    // Terminating from inside a session returns to the list once confirmed.
    if (curSessionId) vscode.postMessage({ type: "terminateSession", id: curSessionId, title: currentTitle, returnToList: true });
  });

  el.historyBtn.addEventListener("click", () => {
    // Keep the session alive in the background and retain its transcript so
    // returning to it is instant, then show the list.
    snapshotCurrent();
    curSessionId = null;
    vscode.postMessage({ type: "leaveToList" });
    vscode.postMessage({ type: "refreshSessions" });
    setBody("list");
  });
  el.titleBtn.addEventListener("click", (e) => {
    if (body === "list") return;
    e.stopPropagation();
    // Clicking the session title renames it.
    if (curSessionId) vscode.postMessage({ type: "renameSession", id: curSessionId, title: currentTitle });
  });

  // --- Composer ------------------------------------------------------------

  function send() {
    const text = el.input.value.trim();
    if (!text) return;
    // Editing a queued message updates it in place (keeps its position in the
    // queue) rather than dropping it and appending a new one at the end.
    if (editingQueuedId && body !== "list") {
      vscode.postMessage({ type: "editQueued", id: editingQueuedId, text });
      finishQueuedEdit();
      return;
    }
    // In editRequests:input mode, the composer is editing a past request:
    // submitting rewinds to it and resends instead of appending a new turn.
    // Never in the list view, where the composer is a fresh new-chat box.
    if (editingTurn && body !== "list") {
      submitInputEdit(editingTurn, text);
      return;
    }
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
  el.stop.addEventListener("click", () => { vscode.postMessage({ type: "cancel" }); cancelPrompts(); });
  const isMacLike = /Mac|iP(hone|ad|od)/.test((navigator.platform || navigator.userAgent || ""));
  el.stop.title = "Stop (" + (isMacLike ? "\u2318" : "Ctrl") + "+Esc)";

  // Close any open question/permission widgets (on Stop, or when the host says
  // the request was cancelled). They must not linger or be submittable after
  // the turn is stopped.
  function cancelPrompts() {
    el.elicitationTray.innerHTML = "";
    el.permissionTray.innerHTML = "";
  }
  el.attach.addEventListener("click", () => vscode.postMessage({ type: "addContext" }));

  el.input.addEventListener("keydown", (e) => {
    if (ac) {
      if (e.key === "ArrowDown") { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; renderAutocomplete(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; renderAutocomplete(); return; }
      if ((e.key === "Enter" || e.key === "Tab") && ac.items.length) { e.preventDefault(); acceptAutocomplete(ac.items[ac.index]); return; }
      if (e.key === "Escape") { e.preventDefault(); closeAutocomplete(); return; }
    }
    if (e.key === "Escape" && editingQueuedId) { e.preventDefault(); cancelQueuedEdit(); return; }
    if (e.key === "Escape" && editingTurn) { e.preventDefault(); cancelInputEditing(); return; }
    // ArrowUp on an empty composer recalls your last message (VS Code's input
    // history), so it is quick to resend or tweak it.
    if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !editingTurn && !editingQueuedId && el.input.value === "" && lastUserText) {
      e.preventDefault();
      el.input.value = lastUserText;
      el.input.setSelectionRange(lastUserText.length, lastUserText.length);
      autosize();
      updateSendState();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  el.input.addEventListener("input", () => { autosize(); updateAutocomplete(); updateSendState(); });

  // VS Code cancels an in-progress request edit when you click another row or
  // outside the editor (finishedEditing on onDidFocusOutside). Mirror that:
  // a pointer down anywhere outside the open inline editor closes it. Capture
  // phase so it runs before the row's own click-to-edit handler.
  document.addEventListener("mousedown", (e) => {
    if (!inlineEditTurn) return;
    const ed = inlineEditTurn.editorEl;
    if (ed && !ed.contains(e.target)) finishEditing(inlineEditTurn);
  }, true);
  // Escape cancels the inline edit even when focus has left the textarea.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inlineEditTurn) finishEditing(inlineEditTurn);
  });

  // Copilot-style chat shortcuts (active whenever the panel is focused):
  //  - Ctrl/Cmd+Esc stops the current turn,
  //  - Ctrl/Cmd+.       opens the mode picker,
  //  - Ctrl/Cmd+Alt+.   opens the model picker.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "Escape") {
      if (busy) { e.preventDefault(); vscode.postMessage({ type: "cancel" }); cancelPrompts(); }
      return;
    }
    if (e.code === "Period" && body === "thread") {
      e.preventDefault();
      openComposerDropdown(e.altKey ? el.modelDD : el.modeDD);
    }
  });

  // Open one of the composer's dropdown pickers (mode / model) by keyboard, by
  // triggering its button when its menu is not already open.
  function openComposerDropdown(container) {
    if (!container || container.classList.contains("hidden")) return;
    const btn = container.querySelector(".dd-btn");
    const menu = container.querySelector(".dd-menu");
    if (btn && (!menu || menu.classList.contains("hidden"))) btn.click();
  }

  function updateSendState() {
    updateComposerButtons();
  }

  // Show Send / Stop / Queue like Copilot: idle shows Send (disabled when empty);
  // while a turn runs, Stop is always available AND, as soon as you type, the
  // Send button turns into a Queue button (a click queues, same as Enter) so you
  // are not limited to the keyboard.
  function updateComposerButtons() {
    const hasText = !!el.input.value.trim();
    const queueing = busy && hasText;
    el.stop.classList.toggle("hidden", !busy);
    // Keep Send visible unless a turn is running with nothing typed (Stop only).
    el.send.classList.toggle("hidden", busy && !hasText);
    el.send.disabled = !hasText;
    el.send.classList.toggle("queueing", queueing);
    el.send.title = queueing ? "Queue message (Enter)" : "Send (Enter)";
    const icon = el.send.querySelector("i");
    if (icon) icon.className = "codicon " + (queueing ? "codicon-add" : "codicon-newline");
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

  // --- Scroll management ---------------------------------------------------
  // The transcript follows new content only while the user is pinned to the
  // bottom. Height changes from streaming text, expanding tool cards, loading
  // images, mermaid swap-in and collapse animations are followed via a
  // ResizeObserver, so the view never lags behind and does not yank the user
  // back when they have scrolled up to read.
  let stickToBottom = true;
  let pinning = false;
  let pinScheduled = false;
  // True while a session/load replay is streaming in. The transcript is hidden
  // behind the loading spinner and auto-scroll is frozen, so the user sees a
  // clean spinner instead of the whole history rendering and scroll-thrashing;
  // it is revealed and jumped to the bottom once, on `loaded`.
  let loadingSession = false;

  function distanceFromBottom() {
    return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
  }
  function pinNow() {
    if (loadingSession) return;
    pinning = true;
    el.thread.scrollTop = el.thread.scrollHeight;
    updateScrollDownButton();
    // Release the guard next frame; by then we are at the bottom so a genuine
    // user scroll re-evaluates stick correctly.
    requestAnimationFrame(() => { pinning = false; });
  }
  // The jump-to-bottom button shows only when the user is scrolled up in a
  // thread (VS Code's .chat-scroll-down / .show-scroll-down), and clicking it
  // snaps to the bottom and re-sticks.
  function updateScrollDownButton() {
    const show = body === "thread" && distanceFromBottom() > 60;
    el.scrollDown.classList.toggle("visible", show);
  }
  el.scrollDown.addEventListener("click", () => forceScrollToBottom());
  // Pin after layout so scrollHeight reflects the just-added content.
  function schedulePin() {
    if (pinScheduled) return;
    pinScheduled = true;
    requestAnimationFrame(() => {
      pinScheduled = false;
      if (stickToBottom) pinNow();
    });
  }
  // Content changed: follow the bottom only if the user is pinned there.
  function scrollToBottom() { schedulePin(); }

  // A user action (send, open/restore a session) must land at the bottom even
  // though the content keeps reflowing for a moment afterwards (the busy chrome
  // refresh, the "Working…" indicator, then the first tokens). Pinning once is
  // racy: a transient scroll during that reflow can flip stickToBottom off and
  // leave the new message just above the fold. So pin every frame for a short
  // window and refuse to un-stick during it.
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  let forcePinUntil = 0;
  function forcePinLoop() {
    pinNow();
    if (now() < forcePinUntil) requestAnimationFrame(forcePinLoop);
  }
  function forceScrollToBottom() {
    stickToBottom = true;
    // The test harness (jsdom) has no layout, so a timed loop adds nothing and
    // would just leave rAFs pending: a single pin is enough there.
    if (typeof ResizeObserver === "undefined") { schedulePin(); return; }
    const wasForcing = now() < forcePinUntil;
    forcePinUntil = now() + 450;
    if (!wasForcing) forcePinLoop();
  }

  // When the user expands/collapses a section in the transcript, keep that
  // section pinned where it was rather than following the stream to the bottom
  // (VS Code's getAnchoredScrollTop). Following is disabled so the growing
  // response can't fight what the user is reading; scrolling back to the bottom
  // (or the Stop/scroll-down button) re-engages it.
  let anchoring = false;
  function anchorAfterToggle(target, anchorTop) {
    stickToBottom = false;
    forcePinUntil = 0; // cancel any post-send force-pin so the expand wins
    if (anchorTop == null || typeof requestAnimationFrame === "undefined") return;
    anchoring = true;
    const until = now() + 340; // spans the collapse height animation
    const step = () => {
      if (!anchoring || !target.isConnected) { anchoring = false; return; }
      const cur = target.getBoundingClientRect().top;
      if (cur !== anchorTop) el.thread.scrollTop += cur - anchorTop;
      if (now() < until) requestAnimationFrame(step);
      else anchoring = false;
    };
    requestAnimationFrame(step);
  }
  // A genuine user scroll (wheel/touch) hands control back immediately.
  el.thread.addEventListener("wheel", () => { anchoring = false; }, { passive: true });
  el.thread.addEventListener("touchstart", () => { anchoring = false; }, { passive: true });

  // Detach only when the USER scrolls up (scrollTop decreases). Appended content
  // never moves scrollTop, so streaming can never accidentally detach us; a pin
  // only increases scrollTop. Re-attach whenever we are back at the bottom. This
  // fixes the response sometimes not following to the very end mid-stream.
  let lastScrollTop = 0;
  el.thread.addEventListener("scroll", () => {
    const st = el.thread.scrollTop;
    const movedUp = st < lastScrollTop - 2;
    lastScrollTop = st;
    updateScrollDownButton();
    // Ignore our own pins, the forced window, and the post-toggle anchor loop:
    // none of these are the user deciding to follow or leave the bottom.
    if (pinning || anchoring || now() < forcePinUntil) return;
    if (movedUp && distanceFromBottom() > 40) stickToBottom = false;
    else if (distanceFromBottom() <= 40) stickToBottom = true;
  }, { passive: true });

  // Follow height changes that fire no DOM mutation at scroll time (images
  // loading, mermaid swap-in, collapsible animations, font reflow). jsdom (the
  // test harness) has no ResizeObserver, so fall back to a no-op there.
  const contentRO = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => { if (stickToBottom) pinNow(); else updateScrollDownButton(); })
    : { observe() {}, unobserve() {} };
  // Auto-observe transcript children (turns, welcome, dividers) as they mount,
  // so their inner growth keeps us pinned.
  const contentMO = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) contentRO.observe(n); });
      m.removedNodes.forEach((n) => { if (n.nodeType === 1) { try { contentRO.unobserve(n); } catch { /* gone */ } } });
    }
    if (stickToBottom) schedulePin();
    else updateScrollDownButton();
  });
  contentMO.observe(el.thread, { childList: true });
  Array.prototype.forEach.call(el.thread.children, (n) => contentRO.observe(n));

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

  // Clickable anchors in assistant/user text. External links (http/mailto) are
  // opened by VS Code's own built-in webview link handling, so we must NOT also
  // open them here or the link opens twice. We only handle the rest: a workspace
  // path opened in the editor.
  el.thread.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return;
    if (/^(https?|mailto):/i.test(href)) return; // let VS Code open it (once)
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "openFile", path: href.replace(/^file:\/\//, "") });
  });

  // --- Drag and drop context (files, images), VS Code chat style -----------
  // Drop files/images onto the chat to attach them as context. Internal drags
  // (Explorer, editor tabs) arrive as a text/uri-list of file URIs; OS/app drops
  // arrive as real files (images inline as base64, other files as text). A full
  // cover overlay with a paperclip pill mirrors VS Code's .chat-dnd-overlay.
  const dndOverlay = document.createElement("div");
  dndOverlay.className = "chat-dnd-overlay";
  dndOverlay.innerHTML = '<span class="attach-context-overlay-text"><i class="codicon codicon-attach"></i><span class="overlay-text">Attach as Context</span></span>';
  el.chatMain.appendChild(dndOverlay);

  // The drag payloads we can turn into context. VS Code's internal drags carry
  // every dragged resource in `application/vnd.code.uri-list` (or ResourceURLs /
  // CodeFiles) and truncate the standard `text/uri-list` to the FIRST resource,
  // so all of them have to be read or a multi file drag attaches only one.
  const DND_URI_TYPES = ["application/vnd.code.uri-list", "ResourceURLs", "CodeFiles", "text/uri-list"];

  function dndSupported(e) {
    const t = (e.dataTransfer && e.dataTransfer.types) || [];
    const has = (x) => Array.prototype.indexOf.call(t, x) !== -1;
    return has("Files") || DND_URI_TYPES.some(has);
  }

  // Collect filesystem paths from whichever drag type is present, in the order
  // that preserves the full selection.
  function dropPaths(dt) {
    const out = [];
    const get = (t) => { try { return (dt.getData && dt.getData(t)) || ""; } catch { return ""; } };
    const addUri = (line) => {
      const s = String(line || "").trim();
      if (!s || s.charAt(0) === "#" || /^https?:/i.test(s)) return;
      let p = s;
      if (/^file:\/\//i.test(s)) {
        const stripped = s.replace(/^file:\/\//i, "");
        try { p = decodeURIComponent(stripped); } catch { p = stripped; }
      }
      if (p) out.push(p);
    };
    const internal = get("application/vnd.code.uri-list");
    if (internal) internal.split(/\r?\n/).forEach(addUri);
    if (!out.length) {
      const res = get("ResourceURLs"); // JSON array of URI strings
      if (res) { try { JSON.parse(res).forEach(addUri); } catch { /* not JSON */ } }
    }
    if (!out.length) {
      const files = get("CodeFiles"); // JSON array of plain fs paths
      if (files) { try { JSON.parse(files).forEach((p) => { if (p) out.push(String(p)); }); } catch { /* not JSON */ } }
    }
    if (!out.length) {
      const std = get("text/uri-list");
      if (std) std.split(/\r?\n/).forEach(addUri);
    }
    return out;
  }
  let dndDepth = 0;
  el.chatMain.addEventListener("dragenter", (e) => {
    if (!dndSupported(e)) return;
    e.preventDefault();
    dndDepth++;
    dndOverlay.classList.add("visible");
  });
  el.chatMain.addEventListener("dragover", (e) => {
    if (!dndSupported(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  el.chatMain.addEventListener("dragleave", () => {
    dndDepth = Math.max(0, dndDepth - 1);
    if (dndDepth === 0) dndOverlay.classList.remove("visible");
  });
  el.chatMain.addEventListener("drop", (e) => {
    hideDndOverlay();
    if (!e.dataTransfer || !dndSupported(e)) return;
    e.preventDefault();
    handleDrop(e.dataTransfer);
  });
  function hideDndOverlay() {
    dndDepth = 0;
    dndOverlay.classList.remove("visible");
  }
  // A drag that ends or is cancelled outside the panel never fires dragleave on
  // the container, which would otherwise leave the overlay stuck on screen.
  window.addEventListener("dragend", hideDndOverlay);
  window.addEventListener("drop", hideDndOverlay);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideDndOverlay(); });

  function handleDrop(dt) {
    // Prefer paths (internal Explorer / editor-tab drags, and OS drops that
    // expose file URLs): attach each by path, letting the host read it.
    const paths = dropPaths(dt);
    if (paths.length) {
      paths.forEach((p) => vscode.postMessage({ type: "addMention", path: p }));
      return;
    }
    // Otherwise we have raw files (an OS/app drop with no path): images inline,
    // everything else as its text content.
    const files = dt.files ? Array.prototype.slice.call(dt.files) : [];
    files.forEach((f) => {
      const reader = new FileReader();
      if (f.type && f.type.indexOf("image/") === 0) {
        reader.onload = () => {
          const result = String(reader.result || "");
          vscode.postMessage({ type: "attachImage", name: f.name || "image", mime: f.type, data: result.slice(result.indexOf(",") + 1) });
        };
        reader.readAsDataURL(f);
      } else {
        reader.onload = () => vscode.postMessage({ type: "attachDroppedText", name: f.name || "file", text: String(reader.result || "") });
        reader.readAsText(f);
      }
    });
  }

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
    const caret = el.input.selectionStart ?? value.length;
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
    let activeRow = null;
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
      if (i === ac.index) activeRow = row;
    });
    // Keep the keyboard-highlighted item visible as the selection moves past the
    // top or bottom edge of the scrollable menu.
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
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
    const caret = el.input.selectionStart ?? value.length;
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
  // Whether `lastHead` is a valid revert target on the current conversation
  // expansion. False right after a reload (the next prompt re-expands and
  // orphans it); true after a live turn completion or an instant restore.
  let lastHeadReliable = false;
  // Feature gates from the host (revert capability + settings).
  let caps = { revert: false, editRequests: "inline", checkpoints: true, showFileChanges: true, confirmRemoval: true, verbose: true, progressBorder: true, contextUsage: true, inlineReferencesStyle: "box", thinkingStyle: "fixedScrolling", streamAnim: "rise" };
  // Pending revert-preview requests keyed by token.
  const previewWaiters = new Map();
  let previewSeq = 0;
  // A revert we asked the host to perform but has not yet confirmed. We only
  // trim the transcript once the host replies "reverted", so a failed revert
  // (which leaves the conversation unchanged) does not desync the UI.
  let pendingRevert = null; // { head, showRestored } | null

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
    // `userToggled` records that the user opened/closed this section by hand, so
    // callers never auto-collapse or auto-expand it out from under them (VS
    // Code persists the manual state and gates auto-collapse on it).
    let userToggled = false;
    const userToggle = () => {
      if (root.classList.contains("dv-nocollapse")) return;
      userToggled = true;
      const willExpand = root.classList.contains("dv-collapsed");
      // Expanding a section in the transcript means the user wants to read it:
      // capture where it sits, stop following the stream, and pin it there
      // afterwards (VS Code's getAnchoredScrollTop) so the growing response can't
      // yank them to the bottom. Collapsing keeps the normal follow behaviour.
      const anchor = willExpand && el.thread.contains(root);
      const anchorTop = anchor ? root.getBoundingClientRect().top : null;
      setCollapsed(!willExpand);
      if (anchor) anchorAfterToggle(root, anchorTop);
      if (opts.onUserToggle) opts.onUserToggle();
    };
    header.addEventListener("click", (e) => { e.stopPropagation(); userToggle(); });
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); userToggle(); }
    });
    sync();
    return {
      root, header, body: inner, setCollapsed,
      isCollapsed: () => root.classList.contains("dv-collapsed"),
      userToggled: () => userToggled
    };
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
      text: text || "", headBefore: lastHead, headBeforeReliable: lastHeadReliable,
      headAfter: null, editing: false,
      createdAt: Date.now(), completedAt: null, model: currentModelLabel
    };
    turns.push(turn);
    currentTurn = turn;
    if (text !== undefined) setTurnText(turn, text);
    buildTurnChrome(turn);
    // The previous last turn is no longer last: move Retry to this one.
    refreshRetryButtons();
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
    // VS Code shows an explicit Edit pencil only in hover/input modes; in inline
    // mode you click the request text to edit (no pencil).
    if (canEditTurn(turn) && caps.editRequests !== "inline") {
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
      ts.appendChild(timeFlip("Sent ", turn.createdAt));
      turn.req.appendChild(ts);
    }

    // Click-to-edit on the whole bubble (inline and input modes both start on a
    // click; input mode routes the text into the composer).
    turn.reqBody.onclick = null;
    turn.reqBody.removeAttribute("title");
    if ((caps.editRequests === "inline" || caps.editRequests === "input") && canEditTurn(turn)) {
      turn.req.classList.add("editable-inline");
      turn.reqBody.onclick = () => startEditing(turn);
      // VS Code's inline mode shows a "Click to Edit" hover hint on the request.
      if (caps.editRequests === "inline") turn.reqBody.title = "Click to Edit";
    } else {
      turn.req.classList.remove("editable-inline");
    }

    // Keyboard affordances on the request bubble (VS Code makes request rows
    // focusable): Enter/Space edits, Delete/Backspace restores to this turn.
    turn.reqBody.tabIndex = 0;
    turn.reqBody.setAttribute("role", "button");
    turn.reqBody.onkeydown = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && canRestoreTurn(turn)) {
        e.preventDefault();
        doRestore(turn);
      } else if ((e.key === "Enter" || e.key === " ") && canEditTurn(turn)) {
        e.preventDefault();
        startEditing(turn);
      }
    };

    // Checkpoint row (Restore Checkpoint) between request and response.
    renderCheckpointRow(turn);

    // Response footer (Copy, Retry) + completion time, persistent under a
    // completed response, mirroring VS Code's ChatMessageFooter.
    buildTurnFooter(turn);
  }

  // True when the turn's response actually rendered something (text, tool card,
  // image, plan, ...), so we don't show a Copy button on an empty answer.
  function turnHasResponse(turn) {
    return !!turn.resp && (turn.resp.childElementCount > 0 || turn.resp.textContent.trim().length > 0);
  }

  function buildTurnFooter(turn) {
    let footer = turn.footer;
    if (footer) footer.remove();
    footer = document.createElement("div");
    footer.className = "chat-footer";
    // VS Code's ChatMessageFooter order: Copy first (order 1), then the rest.
    // Copy only when there is actually a response to copy (hidden on an empty
    // answer). The footer is rebuilt on completion, so the content is present.
    if (turnHasResponse(turn)) {
      footer.appendChild(copyButton("Copy", "msg-action", () => turn.resp.innerText.trim()));
    }
    // Retry regenerates the response IN PLACE (rewind + re-run the same request);
    // it never appends a duplicate. Only offer it when we have a revert target on
    // the current expansion (turnRevertable) and only on the LAST response (the
    // is-last class gates visibility, kept accurate by refreshRetryButtons).
    if (caps.revert && turnRevertable(turn)) {
      const retry = actionBtn("codicon-refresh", "Retry", () => {
        if (!turn.text || busy) return;
        revertAndResend(turn, turn.text);
      });
      retry.classList.add("footer-retry");
      footer.appendChild(retry);
    }
    footer.classList.toggle("is-last", turns[turns.length - 1] === turn);
    // Right-aligned "time • model" detail, matching VS Code's chat-footer-details.
    if (caps.verbose && !turn.replayed && turn.completedAt) {
      const det = document.createElement("span");
      det.className = "chat-footer-details";
      det.appendChild(timeFlip("", turn.completedAt));
      if (turn.model) det.appendChild(document.createTextNode("  \u2022  " + turn.model));
      footer.appendChild(det);
    }
    turn.footer = footer;
    turn.container.appendChild(footer);
  }

  // Keep Retry only on the last turn's footer as turns are added or trimmed.
  function refreshRetryButtons() {
    const last = turns[turns.length - 1];
    for (const t of turns) {
      if (t.footer) t.footer.classList.toggle("is-last", t === last);
    }
  }

  function refreshTurnChrome() {
    turns.forEach((t) => { if (!t.editing) buildTurnChrome(t); });
  }

  // A turn is revertable only when we hold a node id that is valid on the CURRENT
  // conversation expansion. The agent re-expands the conversation on session
  // load and assigns fresh node ids, orphaning any id captured before the load
  // (verified: reverting to a pre-load head fails with "Invalid params"). So:
  //  - the first live turn of a fresh session (headBefore null) reverts by
  //    starting a new session;
  //  - any later turn is revertable only if its head-before was captured live
  //    from a completed turn on this expansion (headBeforeReliable);
  //  - replayed/historical turns and the first turn after a reload are NOT
  //    revertable, because their "before" node is orphaned by re-expansion.
  function turnRevertable(turn) {
    if (turn.headBefore == null) {
      return !turn.replayed;
    }
    return !!turn.headBeforeReliable;
  }
  // After a wake/reload the agent re-expands the conversation with fresh node
  // ids, so every revert target captured for the (restored) turns is orphaned.
  // Downgrade them to non-revertable, exactly like a freshly replayed reload.
  function invalidateRevertHeads() {
    lastHeadReliable = false;
    turns.forEach((t) => { t.headBeforeReliable = false; t.headAfterReliable = false; });
    refreshTurnChrome();
  }
  function canEditTurn(turn) {
    return caps.revert && caps.editRequests !== "none" && !busy && turnRevertable(turn);
  }
  function canRestoreTurn(turn) {
    return caps.revert && caps.checkpoints && !busy && turnRevertable(turn);
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
    // VS Code renders this as a plain text label (no leading icon).
    btn.innerHTML = '<span>Restore Checkpoint</span>';
    btn.title = "Restores workspace and chat to this point";
    const right = document.createElement("span");
    right.className = "checkpoint-line-right";
    // Inline two-state confirm: the label morphs to a shimmering "Discard Edits"
    // and an X cancel appears, exactly like VS Code's ChatRestoreCheckpoint item.
    let confirming = false;
    const cancel = document.createElement("button");
    cancel.className = "checkpoint-cancel hidden";
    cancel.innerHTML = '<i class="codicon codicon-close"></i>';
    cancel.title = "Cancel restoring this checkpoint";
    const setConfirming = (v) => {
      confirming = v;
      row.classList.toggle("confirming", v);
      cancel.classList.toggle("hidden", !v);
      const span = btn.querySelector("span");
      span.textContent = v ? "Discard Edits" : "Restore Checkpoint";
      span.classList.toggle("dv-shimmer", v);
      btn.title = v ? "Confirm restoring this checkpoint and discarding later edits" : "Restores workspace and chat to this point";
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
      // No prior node: the host starts a fresh session and posts "clear",
      // which resets the transcript for us (no trim needed here).
      vscode.postMessage({ type: "revertExecute", newSession: true });
    } else {
      // Defer trimming + the "restored" divider until the host confirms.
      pendingRevert = { head: turn.headBefore, showRestored: true };
      vscode.postMessage({ type: "revertExecute", head: turn.headBefore });
    }
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
    if (currentTurn) {
      lastHead = currentTurn.headAfter;
      lastHeadReliable = !!currentTurn.headAfterReliable;
    } else {
      lastHead = null;
      lastHeadReliable = false;
    }
    refreshRetryButtons();
  }

  // --- Edit a request in place --------------------------------------------

  // The turn currently being edited in the bottom composer (editRequests:input).
  let editingTurn = null;

  // The turn whose request is being edited inline (VS Code allows only one at a
  // time). Kept module-level so a new edit, a click elsewhere or Escape can
  // close it.
  let inlineEditTurn = null;

  function startEditing(turn) {
    if (!canEditTurn(turn)) return;
    if (caps.editRequests === "input") { startInputEditing(turn); return; }
    if (turn.editing) return;
    // Only one request editable at a time: close any other open editor first.
    if (inlineEditTurn && inlineEditTurn !== turn) finishEditing(inlineEditTurn);
    inlineEditTurn = turn;
    document.body.classList.add("editing-request");
    turn.editing = true;
    turn.req.classList.add("editing");
    turn.reqText.classList.add("hidden");
    const box = document.createElement("div");
    box.className = "req-editor";
    // Clicks inside the editor must not bubble to reqBody.onclick (which would
    // immediately restart editing and make Cancel/Send look like no-ops).
    box.addEventListener("click", (e) => e.stopPropagation());
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
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finishEditing(turn); }
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
    if (inlineEditTurn === turn) inlineEditTurn = null;
    if (!inlineEditTurn) document.body.classList.remove("editing-request");
  }

  // Rewind to before `turn` and resend `text` (shared by inline + input edits).
  // Trimming is deferred to the host's "reverted" confirmation so a failed
  // revert does not remove turns that are, in fact, still there.
  function revertAndResend(turn, text) {
    if (turn.headBefore == null) {
      // Host starts a fresh session (posts "clear") then resends the text.
      vscode.postMessage({ type: "revertExecute", newSession: true, resendText: text });
    } else {
      pendingRevert = { head: turn.headBefore, showRestored: false };
      vscode.postMessage({ type: "revertExecute", head: turn.headBefore, resendText: text });
    }
  }

  async function submitEdit(turn, text) {
    text = (text || "").trim();
    if (!text) return;
    const needs = await revertNeedsConfirm(turn);
    if (needs && !(await confirmDiscard())) return;
    finishEditing(turn);
    revertAndResend(turn, text);
  }

  // --- Edit a request from the bottom composer (editRequests:input) ---------

  function startInputEditing(turn) {
    // Only one input edit at a time; re-target if already editing another.
    if (editingTurn && editingTurn !== turn) cancelInputEditing();
    if (editingQueuedId) cancelQueuedEdit();
    editingTurn = turn;
    el.input.value = turn.text;
    el.inputBox.classList.add("editing-request");
    showEditingBanner("Editing message", cancelInputEditing);
    markDiscardable(turn, true);
    el.input.focus();
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    autosize();
    updateSendState();
  }

  function cancelInputEditing() {
    if (!editingTurn) return;
    markDiscardable(editingTurn, false);
    editingTurn = null;
    el.inputBox.classList.remove("editing-request");
    removeEditingBanner();
    el.input.value = "";
    autosize();
    updateSendState();
  }

  async function submitInputEdit(turn, text) {
    const needs = await revertNeedsConfirm(turn);
    if (needs && !(await confirmDiscard())) return;
    cancelInputEditing();
    revertAndResend(turn, text);
  }

  function showEditingBanner(text, onCancel) {
    removeEditingBanner();
    const bar = document.createElement("div");
    bar.className = "input-editing-banner";
    bar.id = "input-editing-banner";
    const label = document.createElement("span");
    label.className = "input-editing-label";
    label.innerHTML = '<i class="codicon codicon-edit"></i><span></span>';
    label.querySelector("span").textContent = text || "Editing message";
    const cancel = document.createElement("button");
    cancel.className = "chip-x";
    cancel.title = "Cancel edit (Esc)";
    cancel.innerHTML = '<i class="codicon codicon-close"></i>';
    cancel.addEventListener("click", (e) => { e.stopPropagation(); (onCancel || cancelInputEditing)(); });
    bar.appendChild(label);
    bar.appendChild(cancel);
    el.inputBox.insertBefore(bar, el.inputBox.firstChild);
  }

  function removeEditingBanner() {
    const b = document.getElementById("input-editing-banner");
    if (b) b.remove();
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
    container.querySelectorAll("pre.code-block:not(.mermaid-src)").forEach((pre) => {
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

  // Mermaid is heavy (~MBs), so it ships as its own bundle and is fetched only
  // the first time a diagram actually appears. The promise is cached (even on
  // failure) so we never inject the script twice.
  let mermaidPromise = null;
  function loadMermaid() {
    if (mermaidPromise) return mermaidPromise;
    const src = document.body.dataset.mermaidSrc;
    if (!src) return (mermaidPromise = Promise.reject(new Error("mermaid unavailable")));
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      const nonce = document.body.dataset.nonce;
      if (nonce) s.setAttribute("nonce", nonce);
      s.onload = () => {
        const m = window.__mermaid;
        if (!m) { reject(new Error("mermaid failed to load")); return; }
        const dark = document.body.classList.contains("vscode-dark") ||
          document.body.classList.contains("vscode-high-contrast");
        try { m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" }); } catch (e) { /* keep going */ }
        resolve(m);
      };
      s.onerror = () => reject(new Error("mermaid script error"));
      document.head.appendChild(s);
    });
    return mermaidPromise;
  }
  // Upgrade any completed mermaid source blocks in `container` to rendered SVG.
  // Called on turn finalisation, so the fence is closed and the source stable.
  let mermaidSeq = 0;
  function renderMermaid(container) {
    if (!container) return;
    const blocks = [...container.querySelectorAll("pre.mermaid-src:not([data-mermaid-done])")];
    if (!blocks.length) return;
    loadMermaid().then((m) => {
      blocks.forEach((pre) => {
        if (pre.dataset.mermaidDone) return;
        pre.dataset.mermaidDone = "1";
        const codeEl = pre.querySelector("code");
        const src = (codeEl ? codeEl.textContent : pre.textContent) || "";
        const id = "mmd-" + (++mermaidSeq);
        Promise.resolve()
          .then(() => m.render(id, src))
          .then(({ svg }) => {
            const wrap = document.createElement("div");
            wrap.className = "mermaid-diagram";
            wrap.innerHTML = svg;
            pre.replaceWith(wrap);
          })
          .catch(() => { pre.classList.add("mermaid-error"); });
      });
    }).catch(() => { /* mermaid unavailable: leave the source blocks in place */ });
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

  // Rendering is throttled so a fast stream doesn't re-parse the whole buffer
  // on every chunk (which is O(n^2) for long turns). Normal turns render on the
  // next animation frame (snappy); once the open buffer is large, re-parsing it
  // 60x/second is wasteful, so it falls back to a coarser ~120ms cadence to cap
  // CPU. `finalizeBlock` always renders directly, so the final state is exact.
  let renderScheduled = false;
  let lastRenderAt = 0;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => { renderScheduled = false; lastRenderAt = now(); renderOpenBlock(); };
    if (block && block.buffer && block.buffer.length > 20000) {
      setTimeout(run, Math.max(0, 120 - (now() - lastRenderAt)));
    } else {
      requestAnimationFrame(run);
    }
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
    if (block.kind === "thinking") {
      renderThinkingItems(block);
      // Keep the fixed-height peek pinned to the latest reasoning, unless the
      // user has expanded it to read back through the chain of thought.
      if (block.peek && block.scrollEl && !block.collapse.userToggled()) block.scrollEl.scrollTop = block.scrollEl.scrollHeight;
    } else if (block.kind === "user") {
      if (block.turn) { block.turn.text = block.buffer; block.turn.reqText.innerHTML = renderMarkdown(block.buffer); }
    } else {
      block.bubble.innerHTML = renderMarkdown(block.buffer);
      if (block.kind === "assistant") { enhanceCodeBlocks(block.bubble); enhanceAnchors(block.bubble); }
    }
    // Follow the stream if the user is pinned to the bottom (scrollToBottom is a
    // no-op otherwise); the ResizeObserver also keeps us pinned as height grows.
    scrollToBottom();
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
    // The fence is now closed, so any mermaid source in a settled assistant
    // message can be upgraded to a rendered diagram.
    if (block.kind === "assistant" && block.bubble) renderMermaid(block.bubble);
    if (block.kind === "thinking") {
      if (block.timer) clearInterval(block.timer);
      if (block.details) {
        block.details.classList.remove("thinking-active");
        block.details.classList.remove("thinking-peek");
      }
      // A streaming peek collapses to the header when done (unless the user
      // expanded/collapsed it themselves).
      if (block.peek && block.collapse && !block.collapse.userToggled()) block.collapse.setCollapsed(true);
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
    // A retained transcript can bring back a "Working…" line this module no
    // longer tracks, so sweep any stray one: two must never show at once.
    el.thread.querySelectorAll(".working").forEach((n) => n.remove());
  }

  function appendAssistant(text, mid) {
    hideWorking();
    if (!(block && block.kind === "assistant" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
      breakToolGroup();
      const bubble = document.createElement("div");
      bubble.className = "resp-text bubble";
      respTarget().appendChild(bubble);
      block = { kind: "assistant", mid, bubble, buffer: "" };
    }
    block.buffer += text;
    scheduleRender();
  }

  // An image produced in an assistant response (e.g. a browser screenshot or a
  // chart). Rendered as its own block between any surrounding text.
  function appendAssistantImage(mime, data) {
    if (!data) return;
    hideWorking();
    finalizeBlock();
    hideWelcome();
    ensureTurn();
    breakToolGroup();
    const img = document.createElement("img");
    img.className = "resp-image";
    img.src = "data:" + (mime || "image/png") + ";base64," + data;
    img.alt = "image";
    respTarget().appendChild(img);
    scrollToBottom();
  }

  function appendThought(text, mid) {
    hideWorking();
    if (!(block && block.kind === "thinking" && sameMid(block.mid, mid))) {
      finalizeBlock();
      hideWelcome();
      ensureTurn();
      // fixedScrolling shows a live, fixed-height peek while streaming (VS
      // Code's chat.agent.thinkingStyle); collapsed starts folded.
      breakToolGroup();
      const peek = caps.thinkingStyle === "fixedScrolling";
      const c = makeCollapsible("thinking thinking-active" + (peek ? " thinking-peek" : ""), { startCollapsed: !peek });
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
      block = { kind: "thinking", mid, details: c.root, body: bodyEl, label, buffer: "", start: Date.now(), timer: null, peek, collapse: c, scrollEl: c.body };
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
    // A response is imminent, so enter the busy state BEFORE building the turn:
    // otherwise the new turn is briefly treated as "complete" and flashes its
    // Copy/Retry footer until the host's busy=true arrives. The host confirms
    // busy shortly, and clears it on completion/error.
    setBusy(true);
    newTurn(undefined, text);
    // A send is an explicit action: snap back to the bottom even if the user
    // had scrolled up while reading.
    forceScrollToBottom();
  }
  // The plan/todo list shows live in a docked widget above the composer (VS
  // Code's chat-todo-list-widget), then snapshots into the transcript when the
  // turn completes so history keeps it. `planCollapsePref` remembers a manual
  // expand/collapse (null = no preference, auto) so auto-collapse never fights
  // the user, and the choice is kept for the next plan raised this session (like
  // VS Code's per-widget userManuallyExpanded). Reset only on a session change.
  let planCollapsePref = null;
  // Same idea for the working-set (file changes) widget: remember a manual
  // collapse so it survives the widget hiding and reappearing within a session.
  let wsCollapsePref = null;

  function planRow(entry) {
    const raw = entry.status;
    const st = raw === "completed" ? "done"
      : raw === "in_progress" ? "active"
      : raw === "skipped" || raw === "cancelled" ? "skipped"
      : "pending";
    const row = document.createElement("div");
    row.className = "plan-entry plan-" + st;
    const mark = document.createElement("i");
    mark.className = "codicon plan-mark " + (
      st === "done" ? "codicon-pass-filled"
        : st === "active" ? "codicon-loading codicon-modifier-spin"
        : st === "skipped" ? "codicon-circle-slash"
        : "codicon-circle-large-outline");
    if (st === "skipped") mark.title = "Skipped";
    const txt = document.createElement("span");
    txt.className = "plan-entry-text";
    txt.textContent = entry.content;
    row.appendChild(mark);
    row.appendChild(txt);
    return row;
  }

  // A static plan card, used for the inline history snapshot left in a turn.
  function planCard(entries) {
    const box = document.createElement("div");
    box.className = "plan";
    const title = document.createElement("div");
    title.className = "plan-title";
    title.textContent = "Plan";
    box.appendChild(title);
    (entries || []).forEach((e) => box.appendChild(planRow(e)));
    return box;
  }

  function renderPlan(entries) {
    hideWorking();
    hideWelcome();
    ensureTurn();
    if (currentTurn) currentTurn.planEntries = entries || [];
    renderDockedPlan(entries || []);
    scrollToBottom();
  }

  // Builds/updates the docked todo widget above the composer. Auto-collapses
  // once work is under way (a task is active or done) unless the user toggled.
  function renderDockedPlan(entries) {
    if (!entries.length) { hideDockedPlan(); return; }
    const done = entries.filter((e) => e.status === "completed").length;
    let ctrl = el.todoWidget._ctrl;
    if (!ctrl) {
      el.todoWidget.innerHTML = "";
      ctrl = makeCollapsible("plan plan-docked", {
        startCollapsed: false,
        onUserToggle: () => { planCollapsePref = el.todoWidget._ctrl.isCollapsed(); }
      });
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right plan-chevron";
      const title = document.createElement("span");
      title.className = "plan-title plan-docked-title";
      title.textContent = "Plan";
      const count = document.createElement("span");
      count.className = "plan-count";
      ctrl.header.appendChild(chev);
      ctrl.header.appendChild(title);
      ctrl.header.appendChild(count);
      el.todoWidget.appendChild(ctrl.root);
      el.todoWidget._ctrl = ctrl;
      el.todoWidget._count = count;
    }
    el.todoWidget._count.textContent = done + "/" + entries.length;
    ctrl.body.innerHTML = "";
    entries.forEach((e) => ctrl.body.appendChild(planRow(e)));
    // Honour a remembered manual choice; otherwise auto-collapse once work is
    // under way (a task is active, done, or skipped).
    if (planCollapsePref !== null) {
      ctrl.setCollapsed(planCollapsePref);
    } else {
      ctrl.setCollapsed(entries.some((e) => e.status === "in_progress" || e.status === "completed" || e.status === "skipped"));
    }
    el.todoWidget.classList.remove("hidden");
    updateComposerDock();
  }

  function hideDockedPlan() {
    el.todoWidget.classList.add("hidden");
    el.todoWidget.innerHTML = "";
    el.todoWidget._ctrl = null;
    updateComposerDock();
  }

  // On turn completion, leave the final plan in the transcript as history and
  // clear the docked widget.
  function commitPlanSnapshot() {
    if (currentTurn && currentTurn.planEntries && currentTurn.planEntries.length && !currentTurn.planSnapped) {
      currentTurn.planSnapped = true;
      currentTurn.resp.appendChild(planCard(currentTurn.planEntries));
    }
    // Keep the user's collapse preference for the next plan this session; only a
    // session change clears it.
    hideDockedPlan();
  }

  // Square the input's top corners when a widget (plan / working set) is docked
  // flush on top of it, mirroring VS Code.
  function updateComposerDock() {
    // In the list view the docked widgets are hidden, so never square the input.
    const docked = body !== "list" &&
      (!el.todoWidget.classList.contains("hidden") || !el.workingSet.classList.contains("hidden"));
    el.inputBox.classList.toggle("docked-above", docked);
  }
  // Mirrors VS Code's getToolInvocationIcon() keyword map (chatThinkingContentPart):
  // read->book, edit->pencil, search->search, terminal->terminal, comment->comment,
  // everything else->tools. (VS Code uses `book` for reads, not a file icon.)
  const TOOL_KIND_ICONS = {
    read: "codicon-book",
    edit: "codicon-edit",
    delete: "codicon-trash",
    move: "codicon-arrow-right",
    search: "codicon-search",
    execute: "codicon-terminal",
    think: "codicon-lightbulb",
    fetch: "codicon-globe",
    other: "codicon-tools"
  };

  // Icons keyed by the resolved tool type (see toolInfo), which is derived from
  // Devin's `_meta` and is more specific than the coarse ACP `kind`. MCP tools use
  // VS Code's MCP glyph (codicon-mcp), the same icon VS Code brands MCP with.
  const TOOL_TYPE_ICONS = {
    web_search: "codicon-globe",
    webfetch: "codicon-globe",
    mcp: "codicon-mcp",
    mcp_list: "codicon-mcp"
  };

  // Resolve a tool's real identity from the `_meta` Devin attaches. Returns a
  // descriptor { type, server?, tool? } for web search / fetch / MCP tools, or
  // null when the coarse `kind` is all we have.
  function toolInfo(d) {
    const meta = d.meta || {};
    const name = meta.toolName || meta.inferenceToolName || "";
    if (meta.eventType === "mcp_tool_call" || /^mcp__/.test(name)) {
      const parts = name.split("__");
      const server = parts.length > 1 ? parts[1] : "";
      const tool = parts.length > 2 ? parts.slice(2).join("__") : "";
      return { type: "mcp", server, tool };
    }
    if (meta.inferenceToolName === "mcp_list_tools") return { type: "mcp_list" };
    if (meta.inferenceToolName === "web_search") return { type: "web_search" };
    if (meta.inferenceToolName === "webfetch") return { type: "webfetch" };
    return null;
  }

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

  // A run of consecutive tool calls collapses under one disclosure header
  // ("Used N tools"), mirroring VS Code's grouped tool card. The run is broken
  // by any non-tool response content (see breakToolGroup).
  function breakToolGroup() {
    if (currentTurn) currentTurn.toolRun = null;
  }
  function createToolGroup() {
    const c = makeCollapsible("tool-group", { startCollapsed: false });
    const chev = document.createElement("i");
    chev.className = "codicon codicon-chevron-right tool-group-chevron";
    const gicon = document.createElement("i");
    gicon.className = "codicon codicon-tools tool-group-icon";
    const label = document.createElement("span");
    label.className = "tool-group-label";
    const statEl = document.createElement("i");
    statEl.className = "codicon tool-group-status";
    c.header.appendChild(chev);
    c.header.appendChild(gicon);
    c.header.appendChild(label);
    c.header.appendChild(statEl);
    const body = document.createElement("div");
    body.className = "tool-group-body";
    c.body.appendChild(body);
    return { root: c.root, body, label, statEl, collapse: c, ids: new Set() };
  }
  function updateToolGroup(g) {
    const n = g.ids.size;
    g.label.textContent = "Used " + n + (n === 1 ? " tool" : " tools");
    const running = !!g.body.querySelector(".tool.in_progress, .tool.pending");
    g.statEl.className = "codicon tool-group-status " + (running ? "codicon-loading codicon-modifier-spin" : "codicon-check");
    g.root.classList.toggle("running", running);
  }
  // Place a freshly created tool node: the first tool of a run mounts inline,
  // the second wraps both into a group, and the rest join the group.
  function placeToolNode(node, id) {
    const turn = currentTurn;
    const run = turn.toolRun || (turn.toolRun = { first: null, group: null });
    if (run.group) {
      run.group.body.appendChild(node);
      run.group.ids.add(id);
      updateToolGroup(run.group);
      return run.group;
    }
    if (!run.first) {
      respTarget().appendChild(node);
      run.first = { id, node };
      return null;
    }
    const g = createToolGroup();
    respTarget().insertBefore(g.root, run.first.node);
    g.body.appendChild(run.first.node);
    g.body.appendChild(node);
    g.ids.add(run.first.id).add(id);
    const firstEntry = toolEls.get(run.first.id);
    if (firstEntry) firstEntry.group = g;
    run.group = g;
    updateToolGroup(g);
    return g;
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
      const group = placeToolNode(node, m.id);
      entry = { node, kindIcon, label, statEl, bodyEl, data: {}, collapse: c, group };
      toolEls.set(m.id, entry);
    }
    // Merge incrementally: updates may carry only some fields.
    const d = entry.data;
    if (m.title) d.title = m.title;
    if (m.kind) d.kind = m.kind;
    if (m.meta) d.meta = Object.assign(d.meta || {}, m.meta);
    if (m.status) d.status = m.status;
    if (m.rawInput !== undefined) d.rawInput = m.rawInput;
    if (Array.isArray(m.content) && m.content.length) d.content = m.content;
    if (Array.isArray(m.locations) && m.locations.length) d.locations = m.locations;

    // Update only the status class (className overwrite would wipe the
    // dv-collapsed / tool-empty state the collapsible controller manages).
    ["pending", "in_progress", "completed", "failed", "cancelled"].forEach((s) => entry.node.classList.remove(s));
    entry.node.classList.add(d.status || "pending");
    if (entry.group) updateToolGroup(entry.group);
    const info = toolInfo(d);
    const typeIcon = info && TOOL_TYPE_ICONS[info.type];
    entry.kindIcon.className = "codicon tool-kind " + (typeIcon || TOOL_KIND_ICONS[d.kind] || TOOL_KIND_ICONS.other);
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

  // First non-empty value among candidate keys of a rawInput object.
  function toolField(raw, keys) {
    if (!raw || typeof raw !== "object") return null;
    for (const k of keys) { if (raw[k] != null && raw[k] !== "") return raw[k]; }
    return null;
  }
  // Extract a runnable command string from a tool's rawInput (handles the
  // common argument shapes; ACP does not standardise the key).
  function toolCommandStr(raw) {
    if (typeof raw === "string") return raw.trim() || null;
    let c = toolField(raw, ["command", "cmd", "script", "commandLine", "shellCommand"]);
    if (c == null && raw && Array.isArray(raw.args)) c = raw.args.join(" ");
    else if (c == null && raw && typeof raw.args === "string") c = raw.args;
    return c != null ? String(c) : null;
  }
  function toolFilePath(raw) {
    const p = toolField(raw, ["path", "file", "filename", "filePath", "file_path", "target"]);
    return p != null ? String(p) : null;
  }

  // A shell command block (VS Code's terminal command style): a dim $ prompt,
  // the syntax-highlighted command, and a "Run in terminal" affordance, instead
  // of dumping the argument JSON.
  function toolCommandBlock(cmd) {
    const sec = document.createElement("div");
    sec.className = "tool-section";
    const box = document.createElement("div");
    box.className = "tool-command";
    const prompt = document.createElement("span");
    prompt.className = "tool-command-prompt";
    prompt.textContent = "$";
    const code = document.createElement("code");
    code.className = "hljs tool-command-code";
    code.innerHTML = renderShell(cmd);
    const run = codeBtn("codicon-terminal", "Run in terminal", () => vscode.postMessage({ type: "runInTerminal", text: cmd }));
    run.classList.add("tool-command-run");
    box.appendChild(prompt);
    box.appendChild(code);
    box.appendChild(run);
    sec.appendChild(box);
    return sec;
  }
  // A one-line "Label value" summary (e.g. Search / Fetch). When `href` is a URL
  // the value renders as a link that opens in the browser.
  function toolSummaryLine(label, value, href) {
    const sec = document.createElement("div");
    sec.className = "tool-section";
    const row = document.createElement("div");
    row.className = "tool-summary";
    const l = document.createElement("span");
    l.className = "tool-summary-label";
    l.textContent = label;
    let v;
    if (href && /^https?:\/\//i.test(href)) {
      v = document.createElement("a");
      v.href = href;
      // The click is handled by the delegated #thread listener; a second handler
      // here would post openExternal twice and open the link in two tabs.
    } else {
      v = document.createElement("span");
    }
    v.className = "tool-summary-value";
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    sec.appendChild(row);
    return sec;
  }
  // Pretty-print JSON text (objects/arrays only); returns null when the text is
  // not JSON, so callers can fall back to showing it verbatim.
  function tryPrettyJson(text) {
    const t = String(text || "").trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return null;
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
  }
  // MCP / custom tool arguments, shown as a labelled, highlighted JSON block.
  function toolArgsSection(raw) {
    const sec = document.createElement("div");
    sec.className = "tool-section";
    const h = document.createElement("div");
    h.className = "tool-section-title";
    h.textContent = "Arguments";
    const pre = document.createElement("pre");
    pre.className = "tool-pre hljs";
    if (typeof raw === "string") pre.textContent = raw;
    else pre.innerHTML = renderCode(safeJson(raw), "json");
    sec.appendChild(h);
    sec.appendChild(pre);
    return sec;
  }
  // Raw argument JSON, kept only as a last-resort fallback for tools we cannot
  // represent more nicely (mostly MCP / custom tools).
  function toolRawInputSection(raw) {
    const sec = document.createElement("div");
    sec.className = "tool-section";
    const h = document.createElement("div");
    h.className = "tool-section-title";
    h.textContent = "Input";
    const pre = document.createElement("pre");
    pre.className = "tool-pre";
    pre.textContent = typeof raw === "string" ? raw : safeJson(raw);
    sec.appendChild(h);
    sec.appendChild(pre);
    return sec;
  }

  // Kinds whose input is fully conveyed by the title + file pills / diff, so we
  // never dump their argument JSON.
  const FILE_TOOL_KINDS = ["read", "edit", "delete", "move"];
  const NO_RAW_KINDS = ["read", "edit", "delete", "move", "think"];

  function renderToolBody(entry) {
    const d = entry.data;
    const body = entry.bodyEl;
    body.innerHTML = "";
    let hasContent = false;
    const raw = d.rawInput;
    const isObj = raw && typeof raw === "object" && !Array.isArray(raw);

    // Prefer the resolved tool identity (from _meta) over the coarse ACP kind:
    // web search and web fetch both report kind "fetch", and MCP tools report no
    // kind at all. Fall back to kind-aware rendering for the built-in tools.
    const info = toolInfo(d);
    let inputShown = false;
    if (info && info.type === "web_search") {
      const q = toolField(isObj ? raw : null, ["query", "q", "search", "text"]);
      if (q != null) { body.appendChild(toolSummaryLine("Search", String(q))); inputShown = true; hasContent = true; }
    } else if (info && info.type === "webfetch") {
      const u = toolField(isObj ? raw : null, ["url", "uri", "href"]);
      if (u != null) { body.appendChild(toolSummaryLine("Fetch", String(u), String(u))); inputShown = true; hasContent = true; }
    } else if (info && (info.type === "mcp" || info.type === "mcp_list")) {
      if (isObj && Object.keys(raw).length) { body.appendChild(toolArgsSection(raw)); inputShown = true; hasContent = true; }
      else if (typeof raw === "string" && raw.trim()) { body.appendChild(toolArgsSection(raw)); inputShown = true; hasContent = true; }
    } else if (d.kind === "execute") {
      const cmd = toolCommandStr(raw);
      if (cmd) { body.appendChild(toolCommandBlock(cmd)); inputShown = true; hasContent = true; }
    } else if (d.kind === "search") {
      const q = toolField(isObj ? raw : null, ["query", "pattern", "search", "regex", "q", "text"]);
      if (q != null) { body.appendChild(toolSummaryLine("Search", String(q))); inputShown = true; hasContent = true; }
    } else if (d.kind === "fetch") {
      const u = toolField(isObj ? raw : null, ["url", "uri", "href"]);
      if (u != null) { body.appendChild(toolSummaryLine("Fetch", String(u), String(u))); inputShown = true; hasContent = true; }
    }

    const textItems = (d.content || []).filter((c) => c.type === "text" && c.text);
    if (textItems.length) {
      hasContent = true;
      const text = textItems.map((c) => c.text).join("\n");
      if (info && (info.type === "web_search" || info.type === "webfetch")) {
        // The result is a short summary ("Found 5 results", "Fetched N chars"),
        // so a dim caption reads better than a heavyweight Result block.
        const note = document.createElement("div");
        note.className = "tool-result-note";
        note.textContent = text;
        body.appendChild(note);
      } else {
        const sec = document.createElement("div");
        sec.className = "tool-section";
        const h = document.createElement("div");
        h.className = "tool-section-title";
        h.textContent = "Result";
        const pre = document.createElement("pre");
        pre.className = "tool-pre";
        // MCP tools usually return a JSON payload; pretty-print + highlight it.
        const json = info && (info.type === "mcp" || info.type === "mcp_list") ? tryPrettyJson(text) : null;
        if (json != null) { pre.classList.add("hljs"); pre.innerHTML = renderCode(json, "json"); }
        else pre.textContent = text;
        sec.appendChild(h);
        sec.appendChild(pre);
        body.appendChild(sec);
      }
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

    const imgItems = (d.content || []).filter((c) => c.type === "image" && c.data);
    if (imgItems.length) {
      hasContent = true;
      imgItems.forEach((c) => {
        const sec = document.createElement("div");
        sec.className = "tool-section";
        const img = document.createElement("img");
        img.className = "tool-image";
        img.src = "data:" + (c.mime || "image/png") + ";base64," + c.data;
        img.alt = "";
        sec.appendChild(img);
        body.appendChild(sec);
      });
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
    // For a file tool with no location/diff, surface the path from rawInput as a
    // pill rather than dumping the argument JSON.
    if (!fileRows.length && FILE_TOOL_KINDS.includes(d.kind) && isObj) {
      const p = toolFilePath(raw);
      if (p) fileRows.push({ path: p, diff: d.kind === "edit" });
    }
    if (fileRows.length) {
      hasContent = true;
      const sec = document.createElement("div");
      sec.className = "tool-section tool-files";
      fileRows.forEach((f) => sec.appendChild(filePill(f)));
      body.appendChild(sec);
    }

    // Raw argument JSON, only as a fallback: we did not show a friendly input
    // view, and it is not a file/think tool (whose input the title + pills
    // already convey). Covers MCP / custom tools where the args are the point.
    if (!inputShown && !NO_RAW_KINDS.includes(d.kind)) {
      if (isObj && Object.keys(raw).length) { body.insertBefore(toolRawInputSection(raw), body.firstChild); hasContent = true; }
      else if (typeof raw === "string" && raw.trim()) { body.insertBefore(toolRawInputSection(raw), body.firstChild); hasContent = true; }
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
    if (path) wsCounts.set(path, { added: added || 0, removed: removed || 0 });
    finalizeBlock();
    hideWelcome();
    ensureTurn();
    // The same file can report changes several times in a turn (the initial
    // tool_call plus repeated tool_call_update events all resend the diff), so
    // reuse one pill per path per turn and refresh it in place rather than
    // stacking duplicate rows.
    const turn = currentTurn;
    turn.editPills = turn.editPills || new Map();
    let node = path ? turn.editPills.get(path) : null;
    const isNew = !node;
    if (isNew) {
      node = document.createElement("div");
      node.className = "edit-pill";
      if (path) turn.editPills.set(path, node);
    } else {
      node.innerHTML = "";
    }
    const status = document.createElement("i");
    status.className = "codicon codicon-check edit-pill-status";
    // Text status next to the icon, like VS Code's edit-pill .status-label.
    const label = document.createElement("span");
    label.className = "edit-pill-label";
    // Once a file is shown as Created, keep that label even as later edits land.
    if (created) node.dataset.created = "1";
    label.textContent = node.dataset.created ? "Created" : "Edited";
    node.appendChild(status);
    node.appendChild(label);
    node.appendChild(filePill({ path, diff: true, added, removed }));
    // Inline Keep / Undo for this edit (VS Code shows accept/reject per edit),
    // in addition to the Keep all / Undo all in the docked working set.
    if (path) {
      const actions = document.createElement("div");
      actions.className = "edit-pill-actions";
      actions.appendChild(iconBtn("codicon-check", "Keep this change", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "acceptFile", path });
        markEditResolved(node, "Kept");
      }));
      actions.appendChild(iconBtn("codicon-discard", "Undo this change", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "rejectFile", path });
        markEditResolved(node, "Undone");
      }));
      node.appendChild(actions);
    }
    if (isNew) { breakToolGroup(); respTarget().appendChild(node); }
    scrollToBottom();
  }

  // After keeping/undoing a single edit, reflect the resolved state on its pill.
  function markEditResolved(node, label) {
    node.classList.add("resolved");
    const actions = node.querySelector(".edit-pill-actions");
    if (actions) actions.remove();
    const l = node.querySelector(".edit-pill-label");
    if (l) l.textContent = label;
    const st = node.querySelector(".edit-pill-status");
    if (st) st.className = "codicon " + (label === "Undone" ? "codicon-discard" : "codicon-check") + " edit-pill-status";
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
      // The carousel header shows the current question's text (and updates as you
      // navigate), so the per-card label would just duplicate it.
      hideTitle: true
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
      finish("cancel", undefined, controls.map((c) => ({ title: c.prompt || c.title, answer: "" })))
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
        return { title: c.prompt || c.title, answer: c.answerText() };
      });
      finish("accept", content, recap);
    });
    footer.appendChild(nav);
    footer.appendChild(step);
    footer.appendChild(spacer);
    footer.appendChild(submit);
    qc.appendChild(footer);

    // Submit stays disabled until EVERY question has an answer (no option is
    // selected by default, so the user must visit each question and pick one).
    // A tooltip explains why, so the disabled state does not feel broken.
    function updateSubmitState() {
      const unanswered = controls.filter((c) => !c.answered()).length;
      submit.disabled = unanswered > 0;
      submit.title = unanswered > 0
        ? (controls.length > 1 ? "Answer all questions to submit" : "Answer the question to submit")
        : "";
    }
    qc.addEventListener("change", updateSubmitState);
    qc.addEventListener("input", updateSubmitState);

    // Left/Right arrows step between questions (captured so a radio group does
    // not consume them), except while typing in a text field.
    qc.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target;
      const typing = t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t.type === "text" || t.type === "number")));
      if (typing) return;
      e.preventDefault();
      e.stopPropagation();
      show(e.key === "ArrowLeft" ? idx - 1 : idx + 1);
    }, true);

    let idx = 0;
    function show(i) {
      idx = Math.max(0, Math.min(controls.length - 1, i));
      controls.forEach((c, j) => c.el.classList.toggle("hidden", j !== idx));
      // Track the current question's text in the header so it changes with the
      // options, not just the choices below it.
      const cur = controls[idx];
      title.textContent = (cur && cur.prompt) || data.message || "Devin has a question";
      const label = controls.length + " question" + (controls.length === 1 ? "" : "s");
      step.textContent = controls.length > 1 ? (idx + 1) + " / " + controls.length : label;
      prev.disabled = idx === 0;
      next.disabled = idx === controls.length - 1;
      validation.classList.add("hidden");
      updateSubmitState();
    }
    show(0);
    updateSubmitState();
    el.elicitationTray.appendChild(qc);
  }

  // Builds one question block for an elicitation form. Returns the element plus
  // value()/valid() for submission and title/answerText() for the recap.
  // Handles single-select (oneOf), multi-select (array, items.anyOf), an
  // "Other" free-text choice, and a plain text/number/boolean fallback.
  function buildElicitQuestion(key, spec, opts) {
    const title = spec.title || spec.description || key;
    // The full question text (prefer the longer `description`), surfaced in the
    // carousel header so it updates as you step between questions.
    const prompt = spec.description || spec.title || "";
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
        key, el: field, title, prompt,
        value: val,
        valid: () => (!opts.required || isCheckbox || String(input.value).trim() !== ""),
        // "Answered" gates the Submit button: a boolean always has a state; text
        // and number need a value.
        answered: () => (isCheckbox ? true : String(input.value).trim() !== ""),
        answerText: () => (isCheckbox ? (input.checked ? "Yes" : "No") : String(input.value))
      };
    }

    const name = "elicit-" + key + "-" + Math.random().toString(36).slice(2, 7);
    const choices = []; // { input, label, val } for the fixed options
    let otherRadio = null;
    let otherText = null;

    // VS Code's question-list row: a leading 1-based number, the label, and a
    // trailing check that appears only when the row is selected. The native
    // radio/checkbox is kept (visually hidden) for state + a11y.
    let optNum = 0;
    const addOption = (label, val, isOther) => {
      const opt = document.createElement("label");
      opt.className = "elicit-option";
      const input = document.createElement("input");
      input.type = isMulti ? "checkbox" : "radio";
      input.name = name;
      input.className = "elicit-native";
      if (!isOther) input.value = val;
      const num = document.createElement("span");
      num.className = "elicit-number";
      num.textContent = String(++optNum);
      const span = document.createElement("span");
      span.className = "elicit-option-label";
      span.textContent = label;
      const indicator = document.createElement("i");
      indicator.className = "codicon codicon-check elicit-indicator";
      opt.appendChild(input);
      opt.appendChild(num);
      opt.appendChild(span);
      if (isOther) {
        otherRadio = input;
        // A textarea (not a single-line input) so a long answer wraps onto new
        // lines and grows in height, while sitting between the label and check.
        otherText = document.createElement("textarea");
        otherText.rows = 1;
        otherText.className = "elicit-input elicit-other";
        otherText.placeholder = "Type your answer";
        const grow = () => { otherText.style.height = "auto"; otherText.style.height = Math.min(Math.max(otherText.scrollHeight, 26), 160) + "px"; };
        otherText.addEventListener("input", () => { if (otherText.value && !input.checked) input.checked = true; grow(); });
        setTimeout(grow, 0);
        opt.appendChild(otherText);
      } else {
        choices.push({ input, label, val });
      }
      // Trailing check (VS Code's .chat-question-list-indicator, margin-left auto).
      opt.appendChild(indicator);
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
      key, el: field, title, prompt,
      value: () => (isMulti ? selectedValues() : selectedValues()[0]),
      valid: () => (isMulti ? selectedValues().length >= minItems : (!opts.required || selectedValues().length >= 1)),
      // Submit is gated on every question having at least one option selected.
      answered: () => selectedValues().length >= 1,
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

  // Latest per-file +added/-removed counts, accumulated from fileChange events,
  // so the working set can show per-file and total line deltas like VS Code.
  const wsCounts = new Map();

  function countBadges(target, added, removed) {
    if (added) {
      const a = document.createElement("span");
      a.className = "label-added";
      a.textContent = "+" + added;
      target.appendChild(a);
    }
    if (removed) {
      const r = document.createElement("span");
      r.className = "label-removed";
      r.textContent = "-" + removed;
      target.appendChild(r);
    }
  }

  // Docked working set above the composer. Collapsible (like the plan) with a
  // chevron, and the file list scrolls once it gets long. The collapsible is
  // cached so its collapsed state survives the frequent re-renders during a turn.
  function renderWorkingSet(files) {
    if (!files || files.length === 0) { hideWorkingSet(); return; }
    el.workingSet.classList.remove("hidden");
    let ctrl = el.workingSet._ctrl;
    if (!ctrl) {
      el.workingSet.innerHTML = "";
      ctrl = makeCollapsible("ws-collapsible", {
        startCollapsed: false,
        onUserToggle: () => { wsCollapsePref = el.workingSet._ctrl.isCollapsed(); }
      });
      ctrl.header.classList.add("ws-header");
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-right ws-chevron";
      const label = document.createElement("span");
      label.className = "ws-label";
      const main = document.createElement("div");
      main.className = "ws-header-main";
      main.appendChild(chev);
      main.appendChild(label);
      const actions = document.createElement("div");
      actions.className = "ws-actions";
      actions.appendChild(btn("Open all", "secondary", () => vscode.postMessage({ type: "openAllDiffs" })));
      actions.appendChild(btn("Keep all", "primary", () => vscode.postMessage({ type: "acceptAll" })));
      actions.appendChild(btn("Undo all", "secondary", () => vscode.postMessage({ type: "rejectAll" })));
      // Header toggles the collapse, so the action buttons must not bubble.
      actions.addEventListener("click", (e) => e.stopPropagation());
      ctrl.header.appendChild(main);
      ctrl.header.appendChild(actions);
      const list = document.createElement("div");
      list.className = "ws-list";
      ctrl.body.appendChild(list);
      el.workingSet.appendChild(ctrl.root);
      el.workingSet._ctrl = ctrl;
      el.workingSet._label = label;
      el.workingSet._list = list;
    }
    const label = el.workingSet._label;
    label.textContent = `${files.length} changed file${files.length > 1 ? "s" : ""}`;
    // Total +added / -removed across the working set (VS Code's line counts).
    let totAdded = 0, totRemoved = 0;
    files.forEach((f) => { const c = wsCounts.get(f.path); if (c) { totAdded += c.added || 0; totRemoved += c.removed || 0; } });
    const counts = document.createElement("span");
    counts.className = "ws-counts";
    countBadges(counts, totAdded, totRemoved);
    label.appendChild(counts);
    const list = el.workingSet._list;
    list.innerHTML = "";
    files.forEach((f) => {
      const row = document.createElement("div");
      row.className = "ws-file";
      const link = document.createElement("a");
      link.className = "file-change";
      const icon = document.createElement("i");
      icon.className = "codicon " + fileIconFor(f.name) + " file-pill-icon";
      const nm = document.createElement("span");
      nm.className = "file-pill-name";
      nm.textContent = f.name;
      link.appendChild(icon);
      link.appendChild(nm);
      const c = wsCounts.get(f.path);
      if (c) countBadges(link, c.added, c.removed);
      link.title = f.path;
      link.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path: f.path }));
      const grp = document.createElement("div");
      grp.className = "ws-file-actions";
      grp.appendChild(iconBtn("codicon-check", "Keep", () => vscode.postMessage({ type: "acceptFile", path: f.path })));
      grp.appendChild(iconBtn("codicon-discard", "Undo", () => vscode.postMessage({ type: "rejectFile", path: f.path })));
      row.appendChild(link);
      row.appendChild(grp);
      list.appendChild(row);
    });
    // Honour a remembered manual collapse (the widget is otherwise always shown
    // expanded), so it survives the working set hiding and reappearing.
    if (wsCollapsePref !== null) ctrl.setCollapsed(wsCollapsePref);
    updateComposerDock();
  }

  function hideWorkingSet() {
    el.workingSet.classList.add("hidden");
    el.workingSet.innerHTML = "";
    el.workingSet._ctrl = null;
    el.workingSet._label = null;
    el.workingSet._list = null;
    updateComposerDock();
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

  // --- Queued messages (sent after the current turn finishes) --------------

  // Messages submitted while a turn is in flight are queued by the host rather
  // than dropped (VS Code's chat queue). They render at the very bottom of the
  // transcript under a "Queued" divider, as dimmed request bubbles like VS Code's
  // pending rows, each editable in place (keeps its position) and removable, and
  // the host auto-sends them in order. A CSS `order` keeps the block pinned below
  // every turn even when a flush appends a new one.
  let queuedItems = [];
  // The queued message being edited in the composer (null = not editing one).
  let editingQueuedId = null;

  function renderQueued(items) {
    queuedItems = Array.isArray(items) ? items : [];
    // The item being edited may have flushed (its turn started) while editing;
    // drop the stale editing state so the banner does not dangle.
    if (editingQueuedId && !queuedItems.some((q) => q.id === editingQueuedId)) {
      clearQueuedEditState();
    }
    const existing = el.thread.querySelector(".queued-inline");
    if (existing) existing.remove();
    if (queuedItems.length === 0) return;
    const box = document.createElement("div");
    box.className = "queued-inline";
    const head = document.createElement("div");
    head.className = "queued-divider";
    // Show the depth so it is obvious the queue is draining as each one goes out.
    head.textContent = queuedItems.length > 1 ? "Queued (" + queuedItems.length + ")" : "Queued";
    head.title = "Sent in order once the current response finishes";
    box.appendChild(head);
    queuedItems.forEach((q) => box.appendChild(queuedRow(q)));
    el.thread.appendChild(box);
    scrollToBottom();
  }

  // One queued message, styled as a dimmed user request bubble (VS Code's pending
  // request row) with edit/remove actions that appear on hover.
  function queuedRow(q) {
    const item = document.createElement("div");
    item.className = "queued-item" + (q.id === editingQueuedId ? " editing" : "");
    item.dataset.id = q.id;
    const bubble = document.createElement("div");
    bubble.className = "queued-bubble bubble";
    bubble.textContent = q.text;
    const actions = document.createElement("div");
    actions.className = "queued-actions";
    actions.appendChild(iconBtn("codicon-edit", "Edit queued message", (e) => { e.stopPropagation(); startQueuedEdit(q); }));
    // VS Code's "Send Immediately" (Codicon.newLine): jump this one to the front.
    actions.appendChild(iconBtn("codicon-newline", "Send immediately", (e) => {
      e.stopPropagation();
      // Commit an in-progress edit of this same message first, so it is sent
      // with what is currently typed rather than the stale text.
      if (editingQueuedId === q.id) {
        const text = el.input.value.trim();
        if (text) vscode.postMessage({ type: "editQueued", id: q.id, text });
        finishQueuedEdit();
      }
      vscode.postMessage({ type: "sendQueuedNow", id: q.id });
    }));
    actions.appendChild(iconBtn("codicon-close", "Remove from queue", (e) => {
      e.stopPropagation();
      if (editingQueuedId === q.id) finishQueuedEdit();
      vscode.postMessage({ type: "removeQueued", id: q.id });
    }));
    item.appendChild(bubble);
    item.appendChild(actions);
    return item;
  }

  // Load a queued message into the composer to edit it in place. It stays in the
  // queue (its slot is reserved) and is updated on submit, so it never jumps to
  // the end.
  function startQueuedEdit(q) {
    if (editingTurn) cancelInputEditing();
    editingQueuedId = q.id;
    // Tell the host which message we are editing: the queue keeps draining past
    // it, but holds when this one reaches the head until we commit or cancel.
    vscode.postMessage({ type: "queueEditing", id: q.id });
    el.input.value = q.text;
    el.inputBox.classList.add("editing-request");
    showEditingBanner("Editing queued message", cancelQueuedEdit);
    el.input.focus();
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    autosize();
    updateSendState();
    markQueuedEditing(); // highlight the row being edited (no full re-render)
  }

  // Toggle the "editing" highlight on the queued bubble that matches the id being
  // edited, without rebuilding the list (which would detach the rows).
  function markQueuedEditing() {
    el.thread.querySelectorAll(".queued-item").forEach((it) => {
      it.classList.toggle("editing", !!editingQueuedId && it.dataset.id === editingQueuedId);
    });
  }

  // Reset the composer chrome after a queued edit ends (submit or cancel), and
  // release the host's hold on that message so it can be sent.
  function clearQueuedEditState() {
    if (!editingQueuedId) return;
    editingQueuedId = null;
    el.inputBox.classList.remove("editing-request");
    removeEditingBanner();
    markQueuedEditing();
    vscode.postMessage({ type: "queueEditing", id: null });
  }

  function finishQueuedEdit() {
    clearQueuedEditState();
    el.input.value = "";
    closeAutocomplete();
    autosize();
    updateSendState();
  }

  function cancelQueuedEdit() {
    if (!editingQueuedId) return;
    finishQueuedEdit();
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
      icon.className = "codicon " + (
        a.type === "image" ? "codicon-file-media"
          : a.type === "selection" ? "codicon-selection"
          : a.type === "directory" ? "codicon-folder"
          : fileIconFor(a.label));
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

  // `status` is a Set of the selected states; empty means no state filter, so
  // several can be combined (Running + Terminated, say).
  function filterSessions(sessions, q, status) {
    q = (q || "").trim().toLowerCase();
    const sel = status && status.size ? status : null;
    return sessions.filter((s) => {
      if (sel) {
        const st = sessionStatuses[s.id];
        const working = st === "running" || st === "starting" || st === "attention";
        const alive = working || st === "idle";
        const match =
          (sel.has("running") && working) ||
          (sel.has("idle") && st === "idle") ||
          (sel.has("terminated") && !alive);
        if (!match) return false;
      }
      if (!q) return true;
      return (s.title || "").toLowerCase().includes(q) || (s.short_id || s.id || "").toLowerCase().includes(q);
    });
  }

  // Rank for the "State" sort: working sessions first, then idle, then ended.
  function sessionStateRank(s) {
    const st = sessionStatuses[s.id];
    if (st === "running" || st === "starting" || st === "attention") return 0;
    if (st === "idle") return 1;
    return 2;
  }

  function sortSessions(sessions, sort) {
    const at = (s) => s.last_activity_at || 0;
    const out = sessions.slice();
    if (sort === "state") {
      out.sort((a, b) => sessionStateRank(a) - sessionStateRank(b) || at(b) - at(a));
    } else if (sort === "name") {
      out.sort((a, b) => (a.title || a.short_id || a.id || "").localeCompare(b.title || b.short_id || b.id || ""));
    } else {
      out.sort((a, b) => at(b) - at(a));
    }
    return out;
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

  // Buckets sessions by last-activity date, with collapsible headers.
  function renderDateGroups(container, sessions, activeId) {
    const now = Date.now() / 1000;
    const bucket = (ts) => {
      if (!ts) return "Older";
      const d = now - ts;
      if (d < 86400) return "Today";
      if (d < 172800) return "Yesterday";
      if (d < 604800) return "This week";
      if (d < 2592000) return "This month";
      return "Older";
    };
    const order = ["Today", "Yesterday", "This week", "This month", "Older"];
    const groups = new Map();
    sessions.forEach((s) => { const k = bucket(s.last_activity_at); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    order.forEach((label) => {
      const rows = groups.get(label);
      if (!rows) return;
      const key = "date:" + label;
      const collapsed = collapsedGroups.has(key);
      const header = document.createElement("div");
      header.className = "group-header" + (collapsed ? " collapsed" : "");
      const chev = document.createElement("i");
      chev.className = "codicon codicon-chevron-down group-chevron";
      const txt = document.createElement("span");
      txt.className = "group-label";
      txt.textContent = label;
      const count = document.createElement("span");
      count.className = "group-count";
      count.textContent = String(rows.length);
      header.append(chev, txt, count);
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
    });
  }

  function mountSessionList(container, opts) {
    opts = opts || {};
    container.innerHTML = "";
    const state = { q: "", status: new Set(), grouping: "workspace", sort: "activity" };
    let searchFloater = null;
    let filterFloater = null;
    let refreshBtn = null;
    let refreshTimer = null;

    // Optional in-list toolbar, used by the side panel and the title switcher.
    // The full-screen list is driven from the header instead (controls omitted).
    if (opts.controls === "panel") {
      const mkTool = (iconName, title, onClick) => {
        const b = document.createElement("button");
        b.className = "session-tool-btn";
        b.title = title;
        b.setAttribute("aria-label", title);
        b.appendChild(mkIcon(iconName));
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
        return b;
      };
      const toolbar = document.createElement("div");
      toolbar.className = "session-toolbar";
      // Spin until the refreshed list actually arrives (devin list can take a
      // few seconds), with a safety stop so it never spins forever.
      refreshBtn = mkTool("refresh", "Refresh sessions", () => {
        refreshBtn.classList.add("spin");
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refreshBtn.classList.remove("spin"), 15000);
        vscode.postMessage({ type: "refreshSessions" });
      });
      const titleLabel = document.createElement("span");
      titleLabel.className = "session-panel-title";
      titleLabel.textContent = "Sessions";
      const spacer = document.createElement("span");
      spacer.className = "session-tool-spacer";
      const newBtn = mkTool("new-session", "New session", (b) => openNewSessionMenu(b));
      const searchBtn = mkTool("search", "Search sessions", (b) => api.toggleSearch(b));
      const filterBtn = mkTool("list-filter", "Filter sessions", (b) => api.toggleFilter(b));
      toolbar.append(refreshBtn, titleLabel, spacer, newBtn, searchBtn, filterBtn);
      container.appendChild(toolbar);
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "session-list-body";
    container.appendChild(bodyEl);

    function renderBody() {
      // A refresh finished: stop the spinner.
      if (refreshBtn) { clearTimeout(refreshTimer); refreshBtn.classList.remove("spin"); }
      bodyEl.innerHTML = "";
      if (!lastSessions.length) {
        bodyEl.innerHTML = '<div class="sessions-empty"><i class="codicon codicon-comment-discussion"></i><div>No chats yet.</div></div>';
        return;
      }
      const filtered = sortSessions(filterSessions(lastSessions, state.q, state.status), state.sort);
      if (!filtered.length) { bodyEl.innerHTML = '<div class="sessions-empty-sm">No matching sessions</div>'; return; }
      if (state.grouping === "none") {
        filtered.forEach((s) => bodyEl.appendChild(sessionRow(s, lastActiveId)));
      } else if (state.grouping === "date") {
        renderDateGroups(bodyEl, filtered, lastActiveId);
      } else {
        renderSessionGroups(bodyEl, filtered, lastActiveId, lastFolders);
      }
    }

    function toggleSearch(anchor) {
      if (searchFloater) { searchFloater.close(); return; }
      const inp = document.createElement("input");
      inp.className = "session-search-pop";
      inp.type = "text";
      inp.placeholder = "Search sessions\u2026";
      inp.value = state.q;
      inp.addEventListener("input", () => { state.q = inp.value; renderBody(); });
      inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape" && searchFloater) searchFloater.close(); });
      searchFloater = makeFloater(anchor, inp, "right", () => { searchFloater = null; });
      inp.focus();
    }

    function toggleFilter(anchor) {
      if (filterFloater) { filterFloater.close(); return; }
      const menu = document.createElement("div");
      menu.className = "dv-menu session-filter-menu";
      const build = () => {
        menu.innerHTML = "";
        const group = (title, options, get, set) => {
          const label = document.createElement("div");
          label.className = "dv-menu-label";
          label.textContent = title;
          menu.appendChild(label);
          for (const [val, lab] of options) {
            const row = document.createElement("button");
            row.className = "dv-menu-item radio" + (get() === val ? " checked" : "");
            const chk = mkIcon(get() === val ? "check" : "blank");
            chk.classList.add("dv-menu-check");
            row.appendChild(chk);
            row.appendChild(Object.assign(document.createElement("span"), { textContent: lab }));
            row.addEventListener("click", (e) => { e.stopPropagation(); set(val); build(); renderBody(); });
            menu.appendChild(row);
          }
        };
        // Status is multi select: tick any combination, or All to clear them.
        const multi = (title, options) => {
          const label = document.createElement("div");
          label.className = "dv-menu-label";
          label.textContent = title;
          menu.appendChild(label);
          const none = state.status.size === 0;
          for (const [val, lab] of options) {
            const on = val === "all" ? none : state.status.has(val);
            const row = document.createElement("button");
            row.className = "dv-menu-item radio" + (on ? " checked" : "");
            const chk = mkIcon(on ? "check" : "blank");
            chk.classList.add("dv-menu-check");
            row.appendChild(chk);
            row.appendChild(Object.assign(document.createElement("span"), { textContent: lab }));
            row.addEventListener("click", (e) => {
              e.stopPropagation();
              if (val === "all") state.status.clear();
              else if (state.status.has(val)) state.status.delete(val);
              else state.status.add(val);
              build();
              renderBody();
            });
            menu.appendChild(row);
          }
        };
        const sep = () => {
          const s = document.createElement("div");
          s.className = "dv-menu-sep";
          menu.appendChild(s);
        };
        multi("Status", [["all", "All"], ["running", "Running"], ["idle", "Idle"], ["terminated", "Terminated"]]);
        sep();
        group("Sort by", [["activity", "Last activity"], ["state", "State"], ["name", "Name"]], () => state.sort, (v) => { state.sort = v; });
        sep();
        group("Group by", [["workspace", "Workspace"], ["date", "Date"], ["none", "None"]], () => state.grouping, (v) => { state.grouping = v; });
      };
      build();
      filterFloater = makeFloater(anchor, menu, "right", () => { filterFloater = null; });
    }

    const api = {
      refresh: renderBody,
      toggleSearch,
      toggleFilter,
      setQuery: (q) => { state.q = q; renderBody(); },
      setStatus: (s) => { state.status = s instanceof Set ? s : new Set(s && s !== "all" ? [s] : []); renderBody(); },
      setSort: (s) => { state.sort = s; renderBody(); },
      setGrouping: (g) => { state.grouping = g; renderBody(); }
    };
    renderBody();
    return api;
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
    menuCtrl = mountSessionList(menu, { controls: "panel" });
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
    if (panelCtrl && sessionsPanelOpen) {
      panelCtrl.refresh();
    }
    // Refresh the in-session header so the subtitle (session code) fills in once
    // this session's metadata arrives.
    if (body === "thread") renderHeader();
  }

  // Detach the currently mounted transcript into `views` so we can restore it
  // instantly later, and reset the live singletons for whatever renders next.
  function snapshotCurrent() {
    if (!curSessionId) return;
    // Abandon any in-progress queued-message edit (releases the host's queue
    // hold) so it does not carry over to the next session.
    cancelQueuedEdit();
    // Close the open block before snapshotting so a half-streamed thinking or
    // message settles ("Thinking…" -> "Thought for Xs") instead of being frozen
    // mid stream. The turn keeps running in the background; its continuation
    // replays into a fresh block when we return.
    finalizeBlock();
    // The "Working…" line is part of the DOM we are about to retain, so drop it
    // now (while it is still in the thread) rather than only untracking it.
    // Otherwise a frozen one comes back on return and the next turn adds a
    // second one beside it.
    hideWorking();
    const frag = document.createDocumentFragment();
    while (el.thread.firstChild) frag.appendChild(el.thread.firstChild);
    views.set(curSessionId, {
      frag, turns, currentTurn, turnSeq, lastHead, lastHeadReliable,
      toolEls: new Map(toolEls), terminalCache: new Map(terminalCache),
      commands: commands.slice(), title: currentTitle, lastUserText, draft: el.input.value
    });
    // Per session: the next session must not inherit this one's last message
    // (it backs ArrowUp recall and Retry) nor its unsent draft. Both are put
    // back by restoreView when this session is reopened.
    lastUserText = "";
    el.input.value = "";
    autosize();
    updateSendState();
    // A session that was mid-run when we left it will keep changing, so its
    // snapshot is stale: force a reload when we come back.
    if (sessionStatuses[curSessionId] === "running") dirtyViews.add(curSessionId);
    // Cap retained transcripts to bound DOM retention.
    if (views.size > 8) {
      const oldest = views.keys().next().value;
      if (oldest !== curSessionId) { views.delete(oldest); dirtyViews.delete(oldest); }
    }
    turns = [];
    currentTurn = null;
    toolEls.clear();
    terminalCache.clear();
    // Reset the transient per-session UI that is NOT part of the moved DOM, so
    // the previous session's working-set deltas, context-usage ring and docked
    // plan do not bleed into the next view. The host clears its change set on
    // every switch, so an empty start is correct here.
    wsCounts.clear();
    wsCounts.clear();
    renderWorkingSet([]);
    lastUsage = null;
    el.usage.classList.add("hidden");
    el.usage.innerHTML = "";
    closeUsagePopup();
    planCollapsePref = null;
    wsCollapsePref = null;
    hideDockedPlan();
    // The busy chrome (Stop button, working border) belongs to the session we
    // just left. Clear it so it never bleeds into the next one: the host posts
    // the real state for whichever session we open.
    if (busy) setBusy(false);
  }

  // Re-mount a retained transcript (real nodes, listeners intact) without a
  // reload.
  function restoreView(id) {
    const v = views.get(id);
    if (!v) return;
    el.thread.innerHTML = "";
    el.thread.appendChild(v.frag);
    turns = v.turns;
    currentTurn = v.currentTurn;
    turnSeq = v.turnSeq;
    lastHead = v.lastHead;
    lastHeadReliable = !!v.lastHeadReliable;
    toolEls.clear();
    v.toolEls.forEach((val, k) => toolEls.set(k, val));
    terminalCache.clear();
    v.terminalCache.forEach((val, k) => terminalCache.set(k, val));
    commands = v.commands || [];
    lastUserText = v.lastUserText || "";
    // Put this session's own unsent draft back in the composer.
    el.input.value = v.draft || "";
    autosize();
    updateSendState();
    currentTitle = v.title || currentTitle;
    el.chatTitle.textContent = currentTitle;
    views.delete(id);
    dirtyViews.delete(id);
    forceScrollToBottom();
  }

  // Open a session from the list: restore its transcript instantly when it is
  // idle and unchanged, otherwise ask the host to wake/reload it.
  function switchToSession(id, title) {
    if (id === curSessionId) { setBody("thread"); return; }
    currentTitle = title || "Chat";
    el.chatTitle.textContent = currentTitle;
    setBody("thread");
    // Restore the cached transcript instantly whenever we have a clean copy,
    // even for a dead (terminated / idle-exited) session. A live session just
    // needs re-pointing (activate); a dead one is spawned in the background
    // (wake) while its transcript stays on screen, so there is no "Waking…"
    // spinner. Only a session we have never displayed here needs a full load.
    const status = sessionStatuses[id];
    // "attention" means the session is alive with a turn in flight, blocked on a
    // permission/question, so treat it like running (re-attach, never wake).
    const running = status === "running" || status === "attention";
    const alive = running || status === "idle" || status === "starting";
    const haveView = views.has(id) && !dirtyViews.has(id);
    snapshotCurrent();
    curSessionId = id;
    if (running && views.has(id)) {
      // A turn is in flight. Reloading its transcript over the live channel
      // aborts the prompt ("channel closed"), so re-attach to the running
      // session instead and let it keep streaming into the restored thread.
      restoreView(id);
      dirtyViews.delete(id);
      vscode.postMessage({ type: "activateSession", id });
    } else if (haveView) {
      restoreView(id);
      if (alive) {
        vscode.postMessage({ type: "activateSession", id });
      } else {
        // A wake spawns a fresh acp, which re-expands the conversation and
        // orphans the cached revert node ids, so the restored turns are no
        // longer safe revert targets (same as a reload).
        invalidateRevertHeads();
        vscode.postMessage({ type: "wakeSession", id });
      }
    } else {
      views.delete(id);
      dirtyViews.delete(id);
      // Show the spinner immediately: a full load round-trips through the host
      // (health check, spawning a fresh acp, replaying history), which can take a
      // few seconds, and the host's own `clear{loading}` only lands after that.
      showThreadLoading(!alive);
      vscode.postMessage({ type: "loadSession", id });
    }
  }

  // A status-only update (no list change): refresh the dots. Status ticks can
  // be frequent and often carry no change, so skip the (full) list rebuild when
  // the statuses and active id are identical to the last render, to avoid
  // churning the DOM and dropping row focus. A genuine change always yields a
  // different signature, so no update is ever missed.
  let lastStatusSig = "";
  function applyStatuses(statuses, activeId) {
    const next = statuses || {};
    sessionStatuses = next;
    if (activeId !== undefined) lastActiveId = activeId;
    const sig = Object.keys(next).sort().map((k) => k + ":" + next[k]).join(",") + "|" + (lastActiveId || "");
    if (sig === lastStatusSig) return;
    lastStatusSig = sig;
    if (listCtrl) listCtrl.refresh();
    if (menuCtrl) menuCtrl.refresh();
    if (panelCtrl && sessionsPanelOpen) panelCtrl.refresh();
    updateTerminateBtn();
  }

  // A session is held by another live Devin process (item 5): offer take-over.
  function showLockConflict(m) {
    const box = cwShell();
    cwTitle(box, "Session is open elsewhere");
    const body = cwBody(box);
    const msg = document.createElement("div");
    msg.className = "cw-message";
    msg.textContent = "This session is currently running in another Devin process" +
      (m.pid ? " (PID " + m.pid + ")" : "") +
      ". You can take it over here, which may disrupt the other process, or cancel and close it there first.";
    body.appendChild(msg);
    const row = cwButtons(box);
    const done = (decision) => { box.remove(); vscode.postMessage({ type: "takeoverDecision", requestId: m.requestId, decision }); };
    row.appendChild(btn("Take over", "primary", () => done("takeover")));
    row.appendChild(btn("Cancel", "secondary", () => done("cancel")));
    el.permissionTray.appendChild(box);
  }

  function sessionRow(s, activeId) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === activeId ? " active" : "");
    const main = document.createElement("div");
    main.className = "session-main";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.title || s.short_id || s.id;
    // Liveness dot: green = running, amber = waiting for you, gray = not running.
    const st = sessionStatuses[s.id];
    const dot = document.createElement("span");
    dot.className = "session-dot " +
      (st === "running" ? "dot-running"
        : st === "attention" ? "dot-attention"
        : st === "starting" ? "dot-starting"
        : st === "idle" ? "dot-idle"
        : "dot-dead");
    dot.title = st === "running" ? "Running"
      : st === "attention" ? "Needs your input"
      : st === "starting" ? "Waking\u2026"
      : st === "idle" ? "Alive, waiting for you"
      : "Not running";
    title.insertBefore(dot, title.firstChild);
    if (st === "attention") item.classList.add("needs-attention");
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
      switchToSession(s.id, s.title);
    });
    const actions = document.createElement("div");
    actions.className = "session-actions";
    // Terminate is only offered for a live session (kills its process, keeps
    // the conversation). Delete removes the conversation entirely.
    if (isAliveStatus(sessionStatuses[s.id])) {
      const term = iconBtn(KILL_GLYPH, "Terminate (stop this session's process)", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "terminateSession", id: s.id, title: s.title || s.id });
      });
      actions.appendChild(term);
    }
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
  // `icon` is a codicon class (e.g. "codicon-edit") or, when it starts with "<",
  // raw inline SVG/HTML (e.g. KILL_GLYPH).
  function iconBtn(icon, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon-btn small";
    b.title = title;
    b.innerHTML = icon.charAt(0) === "<" ? icon : `<i class="codicon ${icon}"></i>`;
    b.addEventListener("click", onClick);
    return b;
  }
  function setBusy(value) {
    const wasBusy = busy;
    busy = value;
    updateComposerButtons();
    // Copilot-style animated indicator on the input (gated by progressBorder).
    el.inputBox.classList.toggle("busy", value && caps.progressBorder);
    if (!value) {
      el.status.textContent = "";
      // Stamp the just-finished turn's completion time (live turns only).
      if (wasBusy && currentTurn && !currentTurn.replayed && !currentTurn.completedAt) {
        currentTurn.completedAt = Date.now();
      }
      // Move the live plan into the transcript as history and undock it.
      if (wasBusy) commitPlanSnapshot();
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
    // Drive the streaming entrance animation from the setting.
    el.thread.dataset.anim = caps.streamAnim || "rise";
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

  function showThreadLoading(waking) {
    el.thread.innerHTML = "";
    // Freeze auto-scroll and hide the streaming transcript behind the spinner
    // until the replay settles (see `loadingSession`).
    loadingSession = true;
    el.thread.classList.add("loading-replay");
    showLoadingBar();
    const d = document.createElement("div");
    d.className = "thread-loading";
    d.innerHTML = "<span></span>";
    d.querySelector("span").textContent = waking ? "Waking session\u2026" : "Loading session\u2026";
    el.thread.appendChild(d);
  }

  // Reveal the transcript and re-enable auto-scroll after a load settles (or is
  // abandoned). Safe to call when no load is in progress.
  function stopThreadLoading() {
    loadingSession = false;
    el.thread.classList.remove("loading-replay");
    hideLoadingBar();
  }

  function threadHasContent() {
    return !!el.thread.querySelector(".turn, .tool, .edit-pill, .plan, .thinking");
  }

  // --- Error rendering -----------------------------------------------------

  function renderError(text) {
    // An error ends the in-flight turn. Clear busy defensively so a failed
    // send/new-session (where the host may not post busy=false) never leaves the
    // composer stuck on Stop.
    setBusy(false);
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

  // The window reloaded (or the extension restarted) while this session had a
  // turn in flight. The agent runs its commands and file edits through the
  // extension host, so it cannot survive that: say so plainly, and offer to send
  // the same message again.
  function renderInterrupted() {
    setBusy(false);
    hideWorking();
    finalizeBlock();
    hideWelcome();
    const box = document.createElement("div");
    box.className = "tray-card interrupted-card";
    const head = document.createElement("div");
    head.className = "error-head";
    const icon = document.createElement("i");
    icon.className = "codicon codicon-debug-disconnect";
    const msg = document.createElement("span");
    msg.textContent = "The last turn stopped when the window reloaded. Your files and the rest of this conversation are untouched.";
    head.appendChild(icon);
    head.appendChild(msg);
    box.appendChild(head);
    if (lastUserText) {
      const row = document.createElement("div");
      row.className = "options";
      row.appendChild(btn("Send it again", "primary", () => {
        box.remove();
        vscode.postMessage({ type: "send", text: lastUserText, newSession: false });
      }));
      box.appendChild(row);
    }
    respTarget().appendChild(box);
    scrollToBottom();
  }

  // Short local time (HH:MM) for turn timestamps.
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch { return ""; }
  }

  // Relative age of a millisecond timestamp ("2m ago"), for the timestamp flip.
  function agoMs(ms) {
    const d = Math.max(0, (Date.now() - ms) / 1000);
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  }

  // A timestamp that flips relative <-> absolute on hover, mirroring VS Code's
  // chat-response/request-timing micro-interaction. `prefix` e.g. "Sent ".
  function timeFlip(prefix, ts) {
    const wrap = document.createElement("span");
    wrap.className = "time-flip";
    const primary = document.createElement("span");
    primary.className = "time-primary";
    primary.textContent = prefix + agoMs(ts);
    const alt = document.createElement("span");
    alt.className = "time-alt";
    alt.textContent = prefix + fmtTime(ts);
    wrap.appendChild(primary);
    wrap.appendChild(alt);
    return wrap;
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
    const sel = window.CSS && CSS.escape ? CSS.escape(m.terminalId) : m.terminalId.replace(/["\\\]]/g, "\\$&");
    el.thread.querySelectorAll(`pre[data-terminal="${sel}"]`).forEach((pre) => {
      pre.textContent = text || "\u2026";
      scrollToBottom();
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
      case "setup": hideBoot(); renderSetup(m.health || {}); break;
      case "ready": setView("chat"); setBody("list"); break;
      case "body":
        setView("chat");
        if (m.body === "list") {
          // Host-driven return to the list (e.g. after terminate). Cache the
          // current transcript and drop curSessionId so reselecting the same
          // session is not short-circuited and can restore + wake seamlessly.
          snapshotCurrent();
          curSessionId = null;
          setBody("list");
        } else {
          setBody("thread");
        }
        break;
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
      case "sessions":
        hideBoot();
        hideLoadingBar();
        if (m.statuses) sessionStatuses = m.statuses;
        renderSessions(m.sessions, m.activeId, m.folders);
        updateTerminateBtn();
        break;
      case "sessionStatuses": applyStatuses(m.statuses, m.activeId); break;
      case "sessionActivity": if (m.id) dirtyViews.add(m.id); break;
      case "openSession":
        // Host-initiated open (e.g. the "needs your input" notification). Reuse
        // the same path as a click so view restore / wake / load all apply.
        if (m.id) {
          setView("chat");
          const s = (lastSessions || []).find((x) => x.id === m.id);
          switchToSession(m.id, s && s.title);
        }
        break;
      case "lockConflict": showLockConflict(m); break;
      case "sessionReady":
        el.status.textContent = "";
        // The thread now shows this session; retire any retained snapshot for it.
        if (m.sessionId) { curSessionId = m.sessionId; views.delete(m.sessionId); dirtyViews.delete(m.sessionId); }
        // Refresh the header so the title and code badge reflect the session now
        // shown (e.g. after starting a new session).
        renderHeader();
        updateTerminateBtn();
        break;
      case "status": el.status.textContent = m.text || ""; break;
      case "clear":
        workingEl = null;
        // Any prior load is over: drop the replay freeze before this clear
        // rebuilds the thread (a new clear{loading} re-arms it just below).
        stopThreadLoading();
        // A fresh session resets the header title and code badge instead of
        // keeping the previous session's.
        if (m.reset) {
          currentTitle = "Chat";
          curSessionId = null;
          closeTitleMenu();
          renderHeader();
        }
        // A freshly cleared thread starts pinned at the bottom.
        stickToBottom = true;
        // Drop any in-progress request edit so its banner/target don't dangle
        // over the freshly cleared thread.
        cancelInputEditing();
        el.thread.innerHTML = "";
        turns = [];
        currentTurn = null;
        lastHead = null;
        lastHeadReliable = false;
        pendingRevert = null;
        previewWaiters.clear();
        el.permissionTray.innerHTML = "";
        el.elicitationTray.innerHTML = "";
        planCollapsePref = null;
    wsCollapsePref = null;
        hideDockedPlan();
        wsCounts.clear();
        renderWorkingSet([]);
        renderQueued([]);
        renderAttachments([]);
        toolEls.clear();
        if (block && block.timer) clearInterval(block.timer);
        block = null;
        el.usage.classList.add("hidden");
        el.usage.innerHTML = "";
        lastUsage = null;
        closeUsagePopup();
        // `pendingSend` means a user message is about to render (new chat from
        // the list), so do not flash the welcome screen in the gap.
        if (m.loading) showThreadLoading(m.waking);
        else if (body === "thread" && !m.pendingSend) renderWelcome();
        break;
      case "loaded":
        // Settle the last replayed block so its mermaid diagrams render and no
        // block stays open to catch a later stray chunk.
        finalizeBlock();
        { const l = el.thread.querySelector(".thread-loading"); if (l) l.remove(); }
        // Reveal the transcript now the replay has settled, before we scroll.
        stopThreadLoading();
        if (body === "thread" && !threadHasContent()) renderWelcome();
        // A freshly loaded transcript starts pinned at the bottom.
        forceScrollToBottom();
        break;
      case "sessionsLoading":
        // Keep whatever is already listed on screen and just run the top loading
        // bar, so returning to the list never blanks it while it revalidates.
        showLoadingBar();
        if (!lastSessions.length) {
          el.sessionsList.innerHTML = "";
          listCtrl = null;
        }
        break;
      case "userMessage":
        if (currentTitle === "Chat") { currentTitle = m.text.slice(0, 40); el.chatTitle.textContent = currentTitle; }
        addUserMessage(m.text);
        break;
      case "userChunk": appendUserChunk(m.text, m.messageId); break;
      case "assistantStart": finalizeBlock(); showWorking(); break;
      case "assistantChunk": appendAssistant(m.text, m.messageId); break;
      case "assistantImage": appendAssistantImage(m.mime, m.data); break;
      case "thoughtChunk": appendThought(m.text, m.messageId); break;
      case "assistantEnd": hideWorking(); finalizeBlock(); break;
      case "plan": renderPlan(m.entries); break;
      case "toolCall":
      case "toolCallUpdate": upsertTool(m); break;
      case "fileChange": addFileChange(m); break;
      case "workingSet": renderWorkingSet(m.files); break;
      case "queued": renderQueued(m.items); break;
      case "attachments": renderAttachments(m.items); break;
      case "implicitContext":
        implicit = m.file ? { path: m.file.path, name: m.file.name, line1: m.file.line1, line2: m.file.line2, enabled: m.enabled !== false } : null;
        renderComposerContext();
        break;
      case "permission": showPermission(m); break;
      case "elicitation": showElicitation(m); break;
      // Every turn's edit/restore chrome depends on the busy state
      // (canEditTurn/canRestoreTurn gate on !busy), so rebuild them all.
      case "busy": setBusy(m.value); refreshTurnChrome(); break;
      case "cancelPrompts": cancelPrompts(); break;
      case "mode": if (m.mode) modeDropdown.setCurrent(m.mode); break;
      case "model": if (m.model) selectModelUid(m.model); break;
      case "terminalOutput": updateTerminal(m); break;
      case "usage": renderUsage(m); break;
      // A failed revert reports `error` rather than `reverted`, so abandon any
      // pending revert here to avoid a stale head trimming the wrong turn later.
      case "error": hideBoot(); pendingRevert = null; renderError(m.text); break;
      case "interrupted": hideBoot(); renderInterrupted(); break;
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
          inlineReferencesStyle: m.inlineReferencesStyle || caps.inlineReferencesStyle,
          thinkingStyle: m.thinkingStyle || caps.thinkingStyle,
          streamAnim: m.streamAnim || caps.streamAnim
        });
        applyCapPrefs();
        refreshTurnChrome();
        break;
      case "turnHead":
        if (typeof m.head === "number") {
          lastHead = m.head;
          // `reliable` heads are captured on the current expansion (a live turn
          // completion or an instant restore) and are safe revert targets. The
          // head read right after a reload is NOT reliable: the next prompt
          // re-expands the conversation and orphans it.
          lastHeadReliable = !!m.reliable;
          if (currentTurn) {
            currentTurn.headAfter = m.head;
            currentTurn.headAfterReliable = lastHeadReliable;
          }
        }
        break;

      case "reverted": {
        // The host has performed the rewind; now it is safe to trim the turns
        // from the reverted point onward (and drop the "restored" divider for a
        // checkpoint restore). A resend, if any, streams in as new turns after.
        const head = typeof m.head === "number" ? m.head : (pendingRevert && pendingRevert.head);
        const turn = turns.find((t) => t.headBefore === head);
        if (turn) trimTurnsFrom(turn);
        if (pendingRevert && pendingRevert.showRestored) renderRestoredRow();
        pendingRevert = null;
        break;
      }
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
