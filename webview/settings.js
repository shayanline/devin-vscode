// Devin customizations / settings surface. Renders the full Devin CLI config
// surface (models, rules, skills, MCP, hooks, permissions, behaviour, network,
// advanced) from data supplied by the extension host, and posts edits back.
// All untrusted values are written via textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const nav = $("settings-nav");
  const content = $("settings-content");
  const loading = $("settings-loading");

  const SECTIONS = [
    { id: "models", label: "Models & Mode", icon: "sparkle" },
    { id: "rules", label: "Rules & Instructions", icon: "book" },
    { id: "skills", label: "Skills", icon: "lightbulb" },
    { id: "mcp", label: "MCP Servers", icon: "server-environment" },
    { id: "hooks", label: "Hooks", icon: "plug" },
    { id: "plugins", label: "Plugins", icon: "extensions" },
    { id: "permissions", label: "Permissions", icon: "shield" },
    { id: "behaviour", label: "Behaviour", icon: "settings-gear" },
    { id: "network", label: "Network & Sandbox", icon: "globe" },
    { id: "advanced", label: "Advanced (Terminal)", icon: "terminal" }
  ];

  let data = null;
  let active = "models";
  // Value sections render a collapsible group per scope (User + each folder).
  const VALUE_SECTIONS = new Set(["models", "behaviour", "network", "advanced"]);

  // --- Tiny DOM helpers ----------------------------------------------------
  function h(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "html") e.innerHTML = v; // only used with our own static markup
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null) e.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }
  function icon(name) { return h("i", { class: "codicon codicon-" + name }); }
  function post(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }

  function card(title, desc, body) {
    return h("div", { class: "settings-card" }, [
      h("div", { class: "settings-card-head" }, [
        h("div", { class: "settings-card-title", text: title }),
        desc ? h("div", { class: "settings-card-desc", text: desc }) : null
      ]),
      h("div", { class: "settings-card-body" }, body)
    ]);
  }
  function fieldRow(label, control, hint, overrideEl) {
    return h("div", { class: "settings-field" }, [
      h("div", { class: "settings-field-main" }, [
        h("label", { class: "settings-field-label", text: label }),
        hint ? h("div", { class: "settings-field-hint", text: hint }) : null,
        overrideEl || null
      ]),
      h("div", { class: "settings-field-control" }, control)
    ]);
  }
  function scopeName(s) {
    return s === "user" ? "User" : "Workspace";
  }
  // On the User group, flag a key that a folder genuinely overrides, naming the
  // folder(s).
  function userOverrideNote(key) {
    const fo = (data && data.folderOverrides) || {};
    const folders = (data && data.folders) || [];
    const names = folders.filter((f) => (fo[f.path] || []).indexOf(key) >= 0).map((f) => f.name);
    if (!names.length) return null;
    return h("div", { class: "settings-field-override" }, ["Overridden in " + names.join(", ")]);
  }
  // A collapsible group (used for the per-scope / per-folder value groups).
  function collapsible(title, open, bodyEls, headerAction) {
    const container = h("div", { class: "settings-collapse" + (open ? " open" : "") });
    const toggle = h("button", { class: "settings-collapse-toggle", onclick: () => container.classList.toggle("open") }, [
      icon("chevron-right"), h("span", { text: title })
    ]);
    container.append(
      h("div", { class: "settings-collapse-head" }, [toggle, headerAction || null]),
      h("div", { class: "settings-collapse-body" }, bodyEls)
    );
    return container;
  }
  function toggle(checked, onChange) {
    const input = h("input", { type: "checkbox" });
    input.checked = !!checked;
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "settings-toggle" }, [input, h("span", { class: "settings-toggle-track" })]);
  }
  function select(options, value, onChange) {
    const sel = h("select", { class: "settings-select" });
    for (const o of options) {
      const opt = h("option", { value: o.value, text: o.label });
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }
  function textInput(value, placeholder, onCommit) {
    const inp = h("input", { class: "settings-input", type: "text", placeholder: placeholder || "" });
    inp.value = value || "";
    const commit = () => onCommit(inp.value.trim());
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
    inp.addEventListener("blur", commit);
    return inp;
  }
  function btn(label, iconName, onClick, cls) {
    return h("button", { class: "settings-btn " + (cls || ""), onclick: onClick }, [iconName ? icon(iconName) : null, label]);
  }
  // Icon-only action button (edit/remove/etc.) with a tooltip.
  function iconBtn(iconName, title, onClick, cls) {
    return h("button", { class: "settings-icon-btn " + (cls || ""), title, "aria-label": title, onclick: onClick }, [icon(iconName)]);
  }
  function tag(text, cls) { return h("span", { class: "settings-tag " + (cls || ""), text }); }
  function empty(text) { return h("div", { class: "settings-empty", text }); }

  // A section header with the title on the left and an "Add" button on the right.
  function sectionHeader(title, addTitle, onAdd) {
    return h("div", { class: "settings-section-head" }, [
      h("div", { class: "settings-section-title", text: title }),
      onAdd ? btn("Add", "add", onAdd, "primary") : null
    ]);
  }

  // A centered modal dialog. `build(close)` returns the body element and may call
  // close() after a successful submit.
  function openModal(title, build) {
    const overlay = h("div", { class: "settings-modal-overlay" });
    const dialog = h("div", { class: "settings-modal" });
    const close = () => { document.removeEventListener("keydown", onKey, true); overlay.remove(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const head = h("div", { class: "settings-modal-head" }, [
      h("div", { class: "settings-modal-title", text: title }),
      h("button", { class: "settings-icon-btn", title: "Close", onclick: close }, [icon("close")])
    ]);
    dialog.append(head, h("div", { class: "settings-modal-body" }, build(close)));
    overlay.appendChild(dialog);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    setTimeout(() => document.addEventListener("keydown", onKey, true), 0);
    document.body.appendChild(overlay);
    return close;
  }
  // A modal footer row with a right-aligned primary action.
  function modalActions(children) {
    return h("div", { class: "settings-modal-actions" }, children);
  }

  // --- Navigation ----------------------------------------------------------
  function renderNav() {
    nav.innerHTML = "";
    for (const s of SECTIONS) {
      const item = h("button", {
        class: "settings-nav-item" + (s.id === active ? " active" : ""),
        onclick: () => { active = s.id; renderNav(); renderContent(); }
      }, [icon(s.icon), h("span", { text: s.label })]);
      nav.appendChild(item);
    }
    const refresh = h("button", { class: "settings-nav-item settings-nav-refresh", onclick: () => post("settings:refresh") }, [icon("refresh"), h("span", { text: "Refresh" })]);
    nav.appendChild(refresh);
  }

  const scopeBar = $("settings-scope-bar");
  if (scopeBar) scopeBar.classList.add("hidden");

  // --- Section renderers ---------------------------------------------------
  function renderContent() {
    content.innerHTML = "";
    if (!data) return;
    const fn = renderers[active];
    if (fn) content.appendChild(fn());
  }

  // Groups are expanded by default in every section.
  function groupOpen() {
    return true;
  }
  // Render a project-scoped list section as one collapsible group per scope, each
  // with its own Add button (targeting that scope/folder) and body rows.
  function scopeListSection(byScope, addTitle, addModal, bodyFor) {
    const wrap = h("div");
    (byScope || []).forEach((g) => {
      const add = addModal ? btn("Add", "add", () => openModal(addTitle + " · " + g.title, (close) => addModal(close, g)), "primary") : null;
      wrap.appendChild(collapsible(g.title, groupOpen(g, byScope), bodyFor(g), add));
    });
    return wrap;
  }

  // The scope/folder groups a value section renders: User plus one per folder.
  function valueGroups() {
    const folders = (data && data.folders) || [];
    const single = folders.length === 1;
    const groups = [{ scope: "user", root: null, title: "User", values: (data && data.userValues) || {}, open: true }];
    for (const f of folders) {
      groups.push({
        scope: "project", root: f.path,
        title: single ? "Workspace" : "Workspace · " + f.name,
        values: ((data && data.folderValues) || {})[f.path] || {},
        open: true
      });
    }
    return groups;
  }
  // Write a value setting for a group (targets the group's scope and folder).
  function setVal(g, path, value) {
    post("settings:setPath", { scope: g.scope, root: g.root, path, value });
  }
  // Override note for a field: only the User group flags folder overrides.
  function ovr(g, key) {
    return g.scope === "user" ? userOverrideNote(key) : null;
  }
  // Reset button for one group (targets its scope and folder).
  function groupReset(g, label, keys) {
    return btn("Reset to defaults", "discard", () => post("settings:resetSection", { scope: g.scope, root: g.root, keys, label }), "subtle");
  }
  // Render a value section: a collapsible group per scope/folder, each built by
  // `cards(g)` and reset via `keys`.
  function valueSection(label, keys, cards) {
    const wrap = h("div");
    for (const g of valueGroups()) {
      wrap.appendChild(collapsible(g.title, g.open, cards(g), groupReset(g, label, keys)));
    }
    return wrap;
  }

  const renderers = {
    models() {
      const familyOpts = [{ value: "", label: "CLI default (Adaptive)" }].concat(
        ((data.models.families) || []).map((f) => ({ value: f.default || f.id, label: f.name || f.id }))
      );
      const wrap = valueSection("Models & Mode", ["agent.model", "agent.show_history_on_continue"], (g) => {
        const v = g.values;
        return [
          card("Default model", "The model the Devin CLI uses by default (agent.model).", [
            fieldRow("Model", select(familyOpts, v.agentModel || "", (val) => setVal(g, "agent.model", val || undefined)), null, ovr(g, "agent.model"))
          ]),
          card("Session", "Devin CLI session behaviour.", [
            fieldRow("Show history on resume", toggle(v.showHistoryOnContinue, (val) => setVal(g, "agent.show_history_on_continue", val)), "Show previous messages when resuming a session.", ovr(g, "agent.show_history_on_continue"))
          ])
        ];
      });
      wrap.appendChild(card("Extension settings", "Options for this VS Code extension (session mode, default model, thinking display, and more) live in VS Code settings.", [
        h("div", { class: "settings-field" }, [h("span"), btn("Open VS Code settings", "gear", () => post("settings:openExtensionSettings"), "primary")])
      ]));
      return wrap;
    },

    rules() {
      const r = data.rules;
      const wrap = scopeListSection(r.byScope, null, null, (g) => {
        const f = g.file || {};
        return [h("div", { class: "settings-list-row" }, [
          h("div", { class: "settings-list-main" }, [
            h("div", { class: "settings-list-title" }, ["Instructions", f.kind ? tag(f.kind, "muted") : null]),
            h("div", { class: "settings-list-sub oneline", text: f.path, title: f.path })
          ]),
          f.exists
            ? h("div", { class: "settings-row-actions" }, [
                iconBtn("edit", "Edit", () => post("settings:openFile", { path: f.path })),
                iconBtn("trash", "Remove", () => post("settings:deletePath", { path: f.path, isDir: false, label: "instructions" }), "danger")
              ])
            : btn("Create AGENTS.md", "add", () => post("settings:createFile", { path: f.path, template: "# Instructions\n\n- \n" }))
        ])];
      });
      const rc = r.readConfigFrom || {};
      wrap.appendChild(card("Import rules from other tools", "Read rules written for Cursor, Windsurf, and Claude Code (applies globally).", [
        fieldRow("Standard (AGENTS.md, .windsurfrules)", toggle(rc.agents_standard !== false, (v) => post("settings:setPath", { scope: "user", path: "read_config_from.agents_standard", value: v }))),
        fieldRow("Cursor (.cursor/rules)", toggle(rc.cursor !== false, (v) => post("settings:setPath", { scope: "user", path: "read_config_from.cursor", value: v }))),
        fieldRow("Windsurf (.windsurf/rules)", toggle(rc.windsurf !== false, (v) => post("settings:setPath", { scope: "user", path: "read_config_from.windsurf", value: v }))),
        fieldRow("Claude Code (.claude)", toggle(rc.claude !== false, (v) => post("settings:setPath", { scope: "user", path: "read_config_from.claude", value: v })))
      ]));
      return wrap;
    },

    skills() {
      const wrap = scopeListSection(data.skills.byScope, "New skill", skillModalBody, (g) => {
        const rows = (g.list || []).map((it) => {
          const actions = [];
          if (it.path) actions.push(iconBtn("edit", "Edit SKILL.md", () => post("settings:openFile", { path: it.path })));
          if (it.dir) actions.push(iconBtn("trash", "Remove skill", () => post("settings:deletePath", { path: it.dir, isDir: true, label: "skill /" + it.name }), "danger"));
          return h("div", { class: "settings-list-row" }, [
            h("div", { class: "settings-list-main" }, [
              h("div", { class: "settings-list-title" }, ["/" + it.name]),
              it.description ? h("div", { class: "settings-list-sub oneline", text: it.description, title: it.description }) : null
            ]),
            h("div", { class: "settings-row-actions" }, actions)
          ]);
        });
        return rows.length ? rows : [empty("No skills here. Add one, or use /skill-creator.")];
      });
      return wrap;
    },

    plugins() {
      const wrap = h("div");
      const list = (data.plugins && data.plugins.list) || [];
      wrap.appendChild(sectionHeader("Plugins", "Install plugin", () => openModal("Install a plugin", pluginModalBody)));
      const rows = list.map((p) =>
        h("div", { class: "settings-list-row" }, [
          h("div", { class: "settings-list-main" }, [
            h("div", { class: "settings-list-title", text: p.name }),
            p.description ? h("div", { class: "settings-list-sub oneline", text: p.description, title: p.description }) : null
          ]),
          h("div", { class: "settings-row-actions" }, [
            iconBtn("sync", "Update plugin", () => post("settings:pluginVerb", { verb: "update", arg: p.name })),
            iconBtn("trash", "Remove plugin", () => post("settings:pluginVerb", { verb: "remove", arg: p.name }), "danger")
          ])
        ])
      );
      wrap.appendChild(card("Installed plugins", "Plugins bundle skills, hooks, and rules. Managed through the Devin CLI.", rows.length ? rows : [empty("No plugins installed.")]));
      return wrap;
    },

    mcp() {
      return scopeListSection(data.mcp.byScope, "Add MCP server", mcpModalBody, (g) => {
        const rows = (g.servers || []).map((sv) => {
          const meta = [tag(sv.transport, "muted")];
          if (sv.disabled) meta.push(tag("disabled", "muted"));
          if (sv.loggedIn) meta.push(tag("signed in", "scope"));
          if ((sv.envKeys || []).length) meta.push(tag(sv.envKeys.length + " env", "muted"));
          const actions = [];
          if (sv.loggedIn) {
            actions.push(iconBtn("sign-out", "Log out", () => post("settings:mcpVerb", { verb: "logout", name: sv.name, root: g.root })));
          } else if (sv.oauthCapable) {
            actions.push(iconBtn("key", "Log in (OAuth)", () => post("settings:mcpLogin", { name: sv.name, root: g.root })));
          }
          actions.push(sv.disabled
            ? iconBtn("check", "Enable", () => post("settings:mcpVerb", { verb: "enable", name: sv.name, scope: sv.scope, root: g.root }))
            : iconBtn("circle-slash", "Disable", () => post("settings:mcpVerb", { verb: "disable", name: sv.name, scope: sv.scope, root: g.root })));
          if (sv.file) actions.push(iconBtn("edit", "Edit config", () => post("settings:openFile", { path: sv.file })));
          actions.push(iconBtn("trash", "Remove", () => post("settings:mcpVerb", { verb: "remove", name: sv.name, scope: sv.scope, root: g.root }), "danger"));
          return h("div", { class: "settings-list-row" }, [
            h("div", { class: "settings-list-main" }, [
              h("div", { class: "settings-list-title" }, [sv.name, ...meta]),
              sv.detail ? h("div", { class: "settings-list-sub oneline", text: sv.detail, title: sv.detail }) : null
            ]),
            h("div", { class: "settings-row-actions" }, actions)
          ]);
        });
        return rows.length ? rows : [empty("No MCP servers here.")];
      });
    },

    hooks() {
      return scopeListSection(data.hooks.byScope, "Add hook", hookModalBody, (g) => {
        const entries = g.entries || [];
        if (!entries.length) return [empty("No hooks here.")];
        const byEvent = {};
        for (const e of entries) { (byEvent[e.event] = byEvent[e.event] || []).push(e); }
        const out = [];
        Object.keys(byEvent).forEach((ev) => {
          out.push(h("div", { class: "settings-subhead", text: ev }));
          byEvent[ev].forEach((e) => out.push(h("div", { class: "settings-list-row" }, [
            h("div", { class: "settings-list-main" }, [
              h("div", { class: "settings-list-title" }, [e.type || "command", e.matcher ? tag("match: " + e.matcher, "muted") : null]),
              h("div", { class: "settings-list-sub oneline", text: e.command || e.prompt || "", title: e.command || e.prompt || "" })
            ]),
            h("div", { class: "settings-row-actions" }, [
              e.source ? iconBtn("edit", "Edit source", () => post("settings:openFile", { path: e.source })) : null,
              e.source ? iconBtn("trash", "Remove hook", () => post("settings:removeHook", { source: e.source, event: e.event, matcher: e.matcher, command: e.command, prompt: e.prompt }), "danger") : null
            ])
          ])));
        });
        return out;
      });
    },

    permissions() {
      return scopeListSection(data.permissions.byScope, null, null, (g) => {
        return ["allow", "deny", "ask"].map((bucket) => {
          const chips = (g[bucket] || []).map((v) =>
            h("span", { class: "settings-perm-chip" }, [
              h("span", { text: v }),
              h("button", { class: "settings-perm-x", title: "Remove", onclick: () => post("settings:permission", { scope: g.scope, root: g.root, bucket, value: v, remove: true }) }, [icon("close")])
            ])
          );
          const adder = textInput("", bucket + " rule, e.g. Exec(git)", (v) => { if (v) post("settings:permission", { scope: g.scope, root: g.root, bucket, value: v }); });
          return h("div", { class: "settings-perm-bucket" }, [
            h("div", { class: "settings-perm-bucket-label", text: bucket }),
            h("div", { class: "settings-perm-chips" }, chips.length ? chips : [h("span", { class: "settings-empty-inline", text: "none" })]),
            adder
          ]);
        });
      });
    },

    behaviour() {
      return valueSection("Behaviour", ["attribution", "auto_update", "notify", "respect_gitignore", "include_gitignored_files", "show_hints"], (g) => {
        const b = g.values.behaviour || {};
        return [card("Behaviour", "General agent behaviour.", [
          fieldRow("Attribution on commits/PRs", toggle(b.attribution, (v) => setVal(g, "attribution", v)), "Add the Generated with Devin line and Co-Authored-By trailer.", ovr(g, "attribution")),
          fieldRow("Auto update", toggle(b.auto_update, (v) => setVal(g, "auto_update", v)), null, ovr(g, "auto_update")),
          fieldRow("Notifications", select([
            { value: "never", label: "Never" },
            { value: "smart", label: "Smart (when unfocused)" },
            { value: "always", label: "Always" }
          ], b.notify || "smart", (v) => setVal(g, "notify", v)), null, ovr(g, "notify")),
          fieldRow("Respect .gitignore for tool access", toggle(b.respect_gitignore, (v) => setVal(g, "respect_gitignore", v)), null, ovr(g, "respect_gitignore")),
          fieldRow("Include gitignored files in @ completions", toggle(b.include_gitignored_files, (v) => setVal(g, "include_gitignored_files", v)), null, ovr(g, "include_gitignored_files")),
          fieldRow("Show hints between turns", toggle(b.show_hints, (v) => setVal(g, "show_hints", v)), null, ovr(g, "show_hints"))
        ])];
      });
    },

    network() {
      return valueSection("Network & Sandbox", ["proxy", "sandbox"], (g) => {
        const n = g.values.network || {};
        const proxy = n.proxy || {};
        const sandbox = n.sandbox || {};
        return [
          card("Proxy", "How the CLI routes its own outbound traffic.", [
            fieldRow("Mode", select([
              { value: "system", label: "System" },
              { value: "manual", label: "Manual" },
              { value: "off", label: "Off" }
            ], proxy.mode || "system", (v) => setVal(g, "proxy.mode", v)), null, ovr(g, "proxy")),
            fieldRow("URL", textInput(proxy.url || "", "http://proxy.example.com:8080", (v) => setVal(g, "proxy.url", v || undefined))),
            fieldRow("No proxy", textInput(proxy.no_proxy || "", "localhost,127.0.0.1,.corp", (v) => setVal(g, "proxy.no_proxy", v || undefined)))
          ]),
          card("Sandbox", "Domain filtering when running with --sandbox (marked unstable by the CLI).", [
            fieldRow("Network mode", select([
              { value: "full", label: "Full" },
              { value: "limited", label: "Limited (GET/HEAD/OPTIONS)" }
            ], sandbox.network_mode || "full", (v) => setVal(g, "sandbox.network_mode", v)), null, ovr(g, "sandbox")),
            fieldRow("Allowed domains", textInput((sandbox.allowed_domains || []).join(", "), "github.com, **.npmjs.org", (v) => setVal(g, "sandbox.allowed_domains", splitList(v)))),
            fieldRow("Denied domains", textInput((sandbox.denied_domains || []).join(", "), "evil.example.com", (v) => setVal(g, "sandbox.denied_domains", splitList(v))))
          ])
        ];
      });
    },

    advanced() {
      const wrap = valueSection("Advanced", ["theme_mode", "unicode_mode", "pty_for_noninteractive_exec", "disable_osc"], (g) => {
        const a = g.values.advanced || {};
        return [
          card("Terminal display", "These affect the devin terminal TUI, not this extension's chat panel.", [
            fieldRow("Theme", select([
              { value: "", label: "Auto" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "terminal-dark", label: "Terminal dark" },
              { value: "terminal-light", label: "Terminal light" },
              { value: "nocolor", label: "No color" }
            ], a.theme_mode || "", (v) => setVal(g, "theme_mode", v || null)), null, ovr(g, "theme_mode")),
            fieldRow("Unicode", select([
              { value: "auto", label: "Auto" },
              { value: "unicode", label: "Unicode" },
              { value: "ascii", label: "ASCII" }
            ], a.unicode_mode || "auto", (v) => setVal(g, "unicode_mode", v)), null, ovr(g, "unicode_mode")),
            fieldRow("Disable OSC escape sequences", toggle(a.disable_osc, (v) => setVal(g, "disable_osc", v)), "Turn off terminal title / hyperlink escape codes if your terminal mishandles them.", ovr(g, "disable_osc"))
          ]),
          card("Execution", "How the exec tool runs commands.", [
            fieldRow("Use a PTY for non-interactive exec", toggle(a.pty_for_noninteractive_exec, (v) => setVal(g, "pty_for_noninteractive_exec", v)), "Run non-interactive commands under a pseudo-terminal (helps tools that need a TTY).", ovr(g, "pty_for_noninteractive_exec"))
          ])
        ];
      });
      wrap.appendChild(card("Config files", null, (data.scopes || []).map((sc) =>
        h("div", { class: "settings-list-row" }, [
          h("div", { class: "settings-list-main" }, [
            h("div", { class: "settings-list-title" }, [scopeLabel(sc.scope), sc.exists ? null : tag("not created", "muted")]),
            h("div", { class: "settings-list-sub", text: sc.path })
          ]),
          sc.exists ? btn("Open", "go-to-file", () => post("settings:openFile", { path: sc.path })) : btn("Create", "add", () => post("settings:createFile", { path: sc.path, template: "{\n}\n" }))
        ])
      )));
      return wrap;
    }
  };

  // Create forms are opened from a scope/folder group, so they target that
  // group directly (scope + root) instead of asking for a scope.
  function skillModalBody(close, g) {
    const name = textInput("", "skill-name", () => {});
    const create = btn("Create skill", "add", () => {
      const v = (name.value || "").trim();
      if (!v) return;
      post("settings:createSkill", { name: v, scope: g.scope, root: g.root });
      close();
    }, "primary");
    return h("div", null, [
      h("div", { class: "settings-modal-desc", text: "Adds a skill under " + g.title + ". Scaffolds a SKILL.md; the name becomes the slash command (/name)." }),
      fieldRow("Name", name),
      modalActions([btn("Cancel", null, close), create])
    ]);
  }

  function hookModalBody(close, g) {
    const eventSel = select([
      { value: "PreToolUse", label: "PreToolUse" },
      { value: "PostToolUse", label: "PostToolUse" },
      { value: "PermissionRequest", label: "PermissionRequest" },
      { value: "UserPromptSubmit", label: "UserPromptSubmit" },
      { value: "Stop", label: "Stop" },
      { value: "SessionStart", label: "SessionStart" },
      { value: "SessionEnd", label: "SessionEnd" }
    ], "PreToolUse", () => {});
    const typeSel = select([{ value: "command", label: "Command" }, { value: "prompt", label: "Prompt" }], "command", () => {});
    const matcher = textInput("", "matcher (optional), e.g. exec", () => {});
    const value = textInput("", "shell command, or prompt text", () => {});
    const timeout = textInput("", "timeout seconds (optional)", () => {});
    const add = btn("Add hook", "add", () => {
      const v = (value.value || "").trim();
      if (!v) return;
      post("settings:addHook", {
        scope: g.scope, root: g.root, event: eventSel.value, hookType: typeSel.value,
        matcher: (matcher.value || "").trim(), value: v, timeout: (timeout.value || "").trim()
      });
      close();
    }, "primary");
    return h("div", null, [
      h("div", { class: "settings-modal-desc", text: "Adds a hook under " + g.title + ". Run a command or inject a prompt on a lifecycle event." }),
      fieldRow("Event", eventSel),
      fieldRow("Type", typeSel),
      fieldRow("Matcher", matcher),
      fieldRow("Command / prompt", value),
      fieldRow("Timeout", timeout),
      modalActions([btn("Cancel", null, close), add])
    ]);
  }

  function mcpModalBody(close, g) {
    const name = textInput("", "server name", () => {});
    const cmd = textInput("", "https://mcp.example.com/mcp  OR  npx -y @scope/server", () => {});
    const envIn = textInput("", "KEY=value, KEY2=value2", () => {});
    const add = btn("Add server", "add", () => {
      const nameVal = (name.value || "").trim();
      const cmdVal = (cmd.value || "").trim();
      if (!nameVal || !cmdVal) return;
      const options = { name: nameVal, scope: g.scope };
      if (/^https?:\/\//i.test(cmdVal)) {
        options.transport = "http";
        options.url = cmdVal;
      } else {
        options.transport = "stdio";
        const parts = cmdVal.split(/\s+/);
        options.command = parts[0];
        options.args = parts.slice(1);
      }
      const env = {};
      for (const pair of (envIn.value || "").split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      if (Object.keys(env).length) options.env = env;
      post("settings:mcpAdd", { options, root: g.root });
      close();
    }, "primary");
    return h("div", null, [
      h("div", { class: "settings-modal-desc", text: "Adds a server under " + g.title + ". Enter a URL (HTTP transport) or a command line (stdio)." }),
      fieldRow("Name", name),
      fieldRow("URL or command", cmd),
      fieldRow("Env (optional)", envIn),
      modalActions([btn("Cancel", null, close), add])
    ]);
  }

  function pluginModalBody(close) {
    const src = textInput("", "github.com/org/repo  or  a local path", () => {});
    const install = btn("Install", "cloud-download", () => {
      const v = (src.value || "").trim();
      if (!v) return;
      post("settings:pluginVerb", { verb: "install", arg: v });
      close();
    }, "primary");
    return h("div", null, [
      h("div", { class: "settings-modal-desc", text: "Install from a Git source or local path (its required plugins are installed too)." }),
      fieldRow("Source", src),
      modalActions([btn("Cancel", null, close), install])
    ]);
  }

  function rowItem(title, sub, openPath) {
    return h("div", { class: "settings-list-row" }, [
      h("div", { class: "settings-list-main" }, [
        h("div", { class: "settings-list-title", text: title }),
        sub ? h("div", { class: "settings-list-sub", text: sub }) : null
      ]),
      openPath ? btn("Open", "go-to-file", () => post("settings:openFile", { path: openPath })) : null
    ]);
  }

  function scopeLabel(s) { return scopeName(s); }
  function splitList(v) { return (v || "").split(",").map((s) => s.trim()).filter(Boolean); }

  // --- Messages ------------------------------------------------------------
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m) return;
    if (m.type === "settings:data") {
      data = m.data;
      loading.classList.add("hidden");
      content.classList.remove("hidden");
      renderContent();
    } else if (m.type === "settings:error") {
      loading.classList.add("hidden");
      content.classList.remove("hidden");
      content.prepend(h("div", { class: "settings-error", text: m.text || "Something went wrong." }));
    } else if (m.type === "settings:busy") {
      document.body.classList.toggle("settings-working", !!m.value);
    }
  });

  renderNav();
  post("settings:load");
})();
