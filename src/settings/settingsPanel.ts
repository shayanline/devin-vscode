import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  ConfigScope,
  loadConfigFile,
  mcpOauthDir,
  refuseIfUnparseable,
  windsurfDir,
  windsurfMcpConfigPath,
  writeMcpServer,
  readConfig,
  setConfigPath,
  stripJsonComments,
  userConfigDir,
  userConfigPath,
  userMcpConfigPath
} from "./configService";
import { CliContext, listPlugins, listSkills, mcpAdd, mcpVerb, McpAddOptions, pluginVerb } from "./devinConfigCli";
import { withQuerySession } from "../acp/queryClient";
import { LoadedHook, LoadedRule } from "../acp/types";
import { checkHealth, loginShellEnv } from "../cli/locate";
import { listModelFamilies } from "../cli/models";

// This extension's id, used to filter VS Code's Settings editor when linking out
// to the settings that control the extension rather than the Devin CLI.
const EXTENSION_ID = "shayanline.devin-vscode";

// Every value row the settings surface renders, with the default Devin applies
// when the key is absent from the config. This one table drives the controls,
// the "set here" markers, the override comparison, and Reset to defaults, so
// those four can never disagree about what a default is.
const ROW_DEFAULTS: Record<string, unknown> = {
  "agent.model": "",
  "agent.show_history_on_continue": true,
  attribution: true,
  auto_update: true,
  notify: "smart",
  respect_gitignore: false,
  include_gitignored_files: false,
  show_hints: true,
  "proxy.mode": "system",
  "proxy.url": "",
  "proxy.no_proxy": "",
  "sandbox.network_mode": "full",
  "sandbox.allowed_domains": [],
  "sandbox.denied_domains": [],
  theme_mode: "",
  unicode_mode: "auto",
  pty_for_noninteractive_exec: false,
  disable_osc: false,
  "read_config_from.agents_standard": true,
  "read_config_from.cursor": true,
  "read_config_from.windsurf": true,
  "read_config_from.claude": true
};
const ROW_KEYS = Object.keys(ROW_DEFAULTS);

// Messages that write to disk. Each one refreshes the panel itself, so the file
// watcher can ignore the change it just caused.
const MUTATING = new Set([
  "settings:setPath", "settings:resetSection", "settings:addHook", "settings:permission",
  "settings:createFile", "settings:deletePath", "settings:removeHook", "settings:createSkill",
  "settings:mcpAdd", "settings:mcpVerb", "settings:pluginVerb", "settings:clearExtensionModel"
]);

// The Devin customizations / settings surface: a webview editor panel with a
// section sidebar (General, Instructions, Skills, Plugins, MCP, Hooks,
// Permissions, Advanced) and a scope picker (Global, plus each workspace folder),
// exposing the full Devin CLI config surface. Settings that control this
// extension live in VS Code settings and are only linked to from here.
export class SettingsPanel {
  private static current?: SettingsPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: fs.FSWatcher[] = [];
  private watchedDirs = "";
  private watchTimer?: NodeJS.Timeout;
  private cli: CliContext = { cliPath: "devin" };
  private disposed = false;
  // When the config changes while the panel is hidden, refresh on reveal instead.
  private stale = false;
  private selfWriteAt = 0;

  static show(context: vscode.ExtensionContext): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "devin.settings",
      "Devin Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");
    SettingsPanel.current = new SettingsPanel(context, panel);
  }

  constructor(private readonly context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
    // The panel mirrors files on disk, so keep it live: watch the config
    // directories, and pick up changes to the extension settings it discloses.
    this.disposables.push(
      panel.onDidChangeViewState(() => {
        if (this.panel.visible && this.stale) {
          this.stale = false;
          void this.sendData();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("devin")) this.queueRefresh();
      }),
      // A folder added or removed changes the scope tabs, so never skip it.
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.queueRefresh(true))
    );
    panel.onDidDispose(() => {
      this.disposed = true;
      this.stopWatching();
      for (const d of this.disposables) d.dispose();
      this.disposables.length = 0;
      if (SettingsPanel.current === this) {
        SettingsPanel.current = undefined;
      }
    });
  }

  // The active workspace folder for project-scoped reads/writes, following the
  // scope tab. Defaults to the first folder.
  private selectedRoot?: string;

  private folders(): { name: string; path: string }[] {
    return (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  private root(): string | undefined {
    const all = this.folders();
    if (this.selectedRoot && all.some((f) => f.path === this.selectedRoot)) {
      return this.selectedRoot;
    }
    return all[0]?.path;
  }

  private async ensureCli(): Promise<void> {
    const setting = vscode.workspace.getConfiguration("devin").get<string>("cliPath", "devin") || "devin";
    const [health, env] = await Promise.all([checkHealth(setting), loginShellEnv()]);
    const extra = vscode.workspace.getConfiguration("devin").get<Record<string, string>>("env", {}) || {};
    this.cli = { cliPath: health.path || "devin", env: { ...env, ...extra }, cwd: this.root() };
  }

  private post(message: unknown): void {
    this.panel.webview.postMessage(message).then(undefined, () => {});
  }

  // --- Live refresh ---------------------------------------------------------

  // Watch the directories holding the config files this panel edits, so an edit
  // made in a text editor or terminal shows up without pressing Refresh. Called
  // on every refresh, and re-attaches only when the set of directories that
  // exist has changed (a .devin folder may be created while the panel is open).
  private startWatching(): void {
    const dirs = [userConfigDir(), windsurfDir(), ...this.folders().map((f) => path.join(f.path, ".devin"))]
      .filter((d) => {
        try { return fs.existsSync(d); } catch { return false; }
      });
    const signature = dirs.join("\n");
    if (signature === this.watchedDirs && this.watchers.length) return;
    this.stopWatching();
    this.watchedDirs = signature;
    for (const dir of dirs) {
      try {
        this.watchers.push(fs.watch(dir, () => this.queueRefresh()));
      } catch {
        // Watching is a nicety. A platform that refuses is not an error.
      }
    }
  }

  private stopWatching(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    for (const w of this.watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers = [];
    this.watchedDirs = "";
  }

  private queueRefresh(force?: boolean): void {
    if (this.disposed) return;
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    // Every write from this panel already re-renders, so drop the file watcher's
    // echo of it: rendering twice would steal focus from whatever the user
    // clicked next. Only our own writes are dropped, never an outside edit,
    // because there is no manual Refresh to fall back on.
    if (!force && Date.now() - this.selfWriteAt < 1500) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      // A config file changed underneath us, which is the one thing that can make
      // the agent's answer about rules and hooks wrong.
      this.loaded = undefined;
      void this.sendData();
    }, 300);
  }

  private async onMessage(msg: any): Promise<void> {
    const mutating = MUTATING.has(String(msg?.type));
    try {
      if (mutating) this.selfWriteAt = Date.now();
      // A write can change which rules and hooks are in force, so it drops the
      // cached answer. Moving between sections does not: asking the agent means
      // starting one, and no section click should wait on that.
      if (mutating) {
        this.loaded = undefined;
      }
      switch (msg?.type) {
        case "settings:load":
          await this.ensureCli();
          await this.sendData();
          return;
        case "settings:reload":
          // Sent when moving between sections, so arriving at one always reflects
          // what is on disk now rather than what was there when the panel opened.
          await this.sendData();
          return;
        case "settings:setPath":
          await this.setValue(scopeOf(msg.scope), String(msg.path), msg.value, msg.root ? String(msg.root) : this.root());
          return;
        case "settings:setRoot":
          // Follows the scope tab, so project-scoped CLI verbs run in that folder.
          this.selectedRoot = String(msg.path || "") || undefined;
          this.cli.cwd = this.root();
          await this.sendData();
          return;
        case "settings:resetSection":
          await this.resetSection(scopeOf(msg.scope), Array.isArray(msg.keys) ? msg.keys.map(String) : [], String(msg.label || "this section"), msg.root ? String(msg.root) : this.root());
          return;
        case "settings:openExtensionSettings":
          await this.openExtensionSettings(msg.query ? String(msg.query) : "");
          return;
        case "settings:clearExtensionModel":
          await this.clearExtensionModel();
          return;
        case "settings:openFile":
          await this.openFile(String(msg.path || ""));
          return;
        case "settings:createFile":
          await this.createFile(String(msg.path || ""), String(msg.template || ""));
          return;
        case "settings:deletePath":
          await this.deletePath(String(msg.path || ""), !!msg.isDir, String(msg.label || ""));
          return;
        case "settings:removeHook":
          await this.removeHook(msg);
          return;
        case "settings:createSkill":
          await this.createSkill(String(msg.name || ""), scopeOf(msg.scope), msg.root ? String(msg.root) : undefined);
          return;
        case "settings:addHook":
          this.addHook(msg);
          await this.sendData();
          return;
        case "settings:pluginVerb": {
          const r = await pluginVerb(this.cli, msg.verb, msg.arg ? String(msg.arg) : undefined);
          if (!r.ok) {
            void vscode.window.showErrorMessage(`Plugin ${msg.verb} failed: ` + (r.err || "unknown error"));
          }
          await this.sendData();
          return;
        }
        case "settings:permission":
          this.editPermission(scopeOf(msg.scope), String(msg.bucket), String(msg.value || ""), !!msg.remove, msg.root ? String(msg.root) : undefined);
          await this.sendData();
          return;
        case "settings:mcpAdd": {
          // A server that belongs to another tool is written straight into that
          // tool's file: `devin mcp` only ever edits Devin's own.
          if (msg.source === "windsurf") {
            this.writeWindsurf(msg.options as McpAddOptions);
            await this.sendData();
            return;
          }
          const r = await mcpAdd(this.ctxFor(msg.root), msg.options as McpAddOptions);
          if (!r.ok) {
            void vscode.window.showErrorMessage("Add MCP server failed: " + (r.err || "unknown error"));
          }
          await this.sendData();
          return;
        }
        case "settings:mcpVerb": {
          if (msg.source === "windsurf" && msg.verb !== "login" && msg.verb !== "logout") {
            this.windsurfVerb(String(msg.verb), String(msg.name));
            await this.sendData();
            return;
          }
          const r = await mcpVerb(this.ctxFor(msg.root), msg.verb, String(msg.name), msg.scope ? scopeOf(msg.scope) : undefined);
          if (!r.ok) {
            void vscode.window.showErrorMessage(`MCP ${msg.verb} failed: ` + (r.err || "unknown error"));
          }
          await this.sendData();
          return;
        }
        case "settings:mcpLogin":
          // OAuth login is interactive (it prints a code and waits for the
          // browser), so run it in a terminal the user can see and complete.
          this.mcpLoginTerminal(String(msg.name || ""), msg.root ? String(msg.root) : undefined);
          return;
        default:
          return;
      }
    } catch (err) {
      this.post({ type: "settings:error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      // Every mutating message is answered, so the control that started it always
      // stops showing itself as running. Most paths already answered with fresh
      // data; this covers the ones that changed nothing, such as a confirmation
      // the user declined.
      if (mutating) this.post({ type: "settings:idle" });
    }
  }

  // A CLI context whose cwd is a specific folder (for project-scoped verbs), or
  // the active folder by default.
  private ctxFor(root?: unknown): CliContext {
    return { ...this.cli, cwd: (typeof root === "string" && root) ? root : this.root() };
  }

  // The value a key would have in a scope if that scope did not set it: Devin's
  // documented default at Global scope, and whatever Global resolves to for a
  // workspace folder.
  private fallbackValue(scope: ConfigScope, root: string | undefined, key: string): unknown {
    if (scope === "user" || !root) return ROW_DEFAULTS[key];
    return defaulted(loadConfigFile("user").data, key);
  }

  // Write a value setting. Writing the value that already applies would only add
  // a redundant key and leave the row looking changed, so the key is removed
  // instead, the way VS Code drops a setting you return to its default.
  private async setValue(scope: ConfigScope, key: string, value: unknown, root?: string): Promise<void> {
    let next = value;
    if (next !== undefined && key in ROW_DEFAULTS &&
        JSON.stringify(next) === JSON.stringify(this.fallbackValue(scope, root, key))) {
      next = undefined;
    }
    setConfigPath(scope, key, next, root);
    await this.sendData();
  }

  // Open VS Code's Settings editor filtered to this extension, optionally
  // narrowed further so a link lands on the settings it names.
  private async openExtensionSettings(query: string): Promise<void> {
    const filter = `@ext:${EXTENSION_ID}` + (query ? ` ${query}` : "");
    await vscode.commands.executeCommand("workbench.action.openSettings", filter);
  }

  // Clear the extension's model override so chats started here fall back to the
  // Devin CLI's own `agent.model`. Both targets are cleared, since the chat
  // panel's model picker writes the Workspace one.
  private async clearExtensionModel(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("devin");
    for (const target of [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]) {
      try {
        await cfg.update("defaultModel", undefined, target);
      } catch {
        // Workspace target throws with no workspace open. Global still applies.
      }
    }
    await this.sendData();
  }

  // Reset a section: remove its keys from the given scope (and folder, for
  // project scope) so they fall back to Devin's defaults. Confirmed first.
  private async resetSection(scope: ConfigScope, keys: string[], label: string, root?: string): Promise<void> {
    if (!keys.length) return;
    const where = scope === "user" ? "Global" : "Workspace";
    const choice = await vscode.window.showWarningMessage(
      `Reset ${label} to defaults in ${where}? This removes those settings from the config.`,
      { modal: true },
      "Reset"
    );
    if (choice !== "Reset") return;
    for (const k of keys) setConfigPath(scope, k, undefined, root || this.root());
    await this.sendData();
  }

  // Remove, or turn off without losing, a server in Windsurf's config. Windsurf
  // and the CLI both read `disabled`, so turning one off here turns it off in
  // both, which is the point: it is one list of servers, not two.
  private windsurfVerb(verb: string, name: string): void {
    const file = windsurfMcpConfigPath();
    const servers = readConfig(file).mcpServers as Record<string, unknown> | undefined;
    const def = servers && typeof servers === "object" ? servers[name] : undefined;
    if (!def || typeof def !== "object") {
      return;
    }
    if (verb === "remove") {
      writeMcpServer(file, name, null);
      return;
    }
    const next = { ...(def as Record<string, unknown>) };
    if (verb === "disable") {
      next.disabled = true;
    } else {
      delete next.disabled;
      delete next.enabled;
    }
    writeMcpServer(file, name, next);
  }

  // Add a server to Windsurf's config, in the shape Windsurf itself writes.
  private writeWindsurf(o: McpAddOptions): void {
    const def: Record<string, unknown> = o.url
      ? { serverUrl: o.url }
      : { command: o.command || "", args: o.args || [] };
    if (o.env && Object.keys(o.env).length) {
      def.env = o.env;
    }
    writeMcpServer(windsurfMcpConfigPath(), o.name, def);
  }

  private mcpLoginTerminal(name: string, root?: string): void {
    if (!name) return;
    const term = vscode.window.createTerminal({ name: "Devin MCP login", env: this.cli.env, cwd: root || this.root() });
    term.show(true);
    term.sendText(`${quoteArg(this.cli.cliPath)} mcp login ${quoteArg(name)}`);
  }

  private async openFile(p: string): Promise<void> {
    if (!p) return;
    if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
    try {
      // Open the file as a tab in the settings panel's own editor group (next to
      // the settings tab), not as a split pane or a separate window.
      const col = this.panel.viewColumn ?? vscode.ViewColumn.Active;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
      await vscode.window.showTextDocument(doc, { viewColumn: col, preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage("Could not open " + p + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Delete a file or directory after a modal confirmation, then refresh.
  private async deletePath(p: string, isDir: boolean, label: string): Promise<void> {
    if (!p || !fs.existsSync(p)) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete ${label || p}? This cannot be undone.`,
      { modal: true, detail: p },
      "Delete"
    );
    if (choice !== "Delete") return;
    try {
      fs.rmSync(p, { recursive: isDir, force: true });
    } catch (err) {
      void vscode.window.showErrorMessage("Could not delete " + p + ": " + (err instanceof Error ? err.message : String(err)));
    }
    await this.sendData();
  }

  // Remove a single hook entry from its source JSON file (matched by event,
  // matcher, and command/prompt), pruning now-empty groups.
  private async removeHook(msg: any): Promise<void> {
    const src = String(msg.source || "");
    if (!src || !fs.existsSync(src)) return;
    const choice = await vscode.window.showWarningMessage(
      "Remove this hook?",
      { modal: true, detail: `${msg.event || ""} ${msg.command || msg.prompt || ""}`.trim() },
      "Remove"
    );
    if (choice !== "Remove") return;
    try {
      // Same hazard as every other write: an unparseable file reads as {}, and
      // writing that back would replace it with just this hook's leftovers.
      refuseIfUnparseable(src);
      const root = readConfig(src);
      const hooksObj = (src.endsWith("hooks.v1.json") ? root : (root.hooks as Record<string, unknown>)) || {};
      const groups = (hooksObj as Record<string, unknown>)[String(msg.event)] as any[];
      if (Array.isArray(groups)) {
        for (const g of groups) {
          if (!g || !Array.isArray(g.hooks)) continue;
          if (msg.matcher !== undefined && (g.matcher || "") !== msg.matcher) continue;
          g.hooks = g.hooks.filter((h: any) => (h?.command ?? h?.prompt) !== (msg.command ?? msg.prompt));
        }
        (hooksObj as Record<string, unknown>)[String(msg.event)] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length);
        if (!(hooksObj as Record<string, unknown>)[String(msg.event)] || (groups.length === 0)) {
          delete (hooksObj as Record<string, unknown>)[String(msg.event)];
        }
      }
      fs.writeFileSync(src, JSON.stringify(root, null, 2) + "\n", "utf8");
    } catch (err) {
      void vscode.window.showErrorMessage("Could not remove hook: " + (err instanceof Error ? err.message : String(err)));
    }
    await this.sendData();
  }

  // Scaffold a new skill (a directory with a SKILL.md front-matter template) at
  // user or project scope, then open it for editing.
  private async createSkill(name: string, scope: ConfigScope, root?: string): Promise<void> {
    const safe = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    if (!safe) return;
    const folder = root || this.root();
    const base = scope !== "user" && folder
      ? path.join(folder, ".devin", "skills")
      : path.join(userConfigDir(), "skills");
    const file = path.join(base, safe, "SKILL.md");
    if (!fs.existsSync(file)) {
      const template = `---\nname: ${safe}\ndescription: One line on what this skill does and when Devin should use it.\n---\n\n# ${safe}\n\nDescribe the skill here. Explain when to use it and how it behaves.\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, template, "utf8");
    }
    await this.openFile(file);
    await this.sendData();
  }

  // Append a hook to a scope's config.json under hooks.<event>, grouped by
  // matcher (Devin reads hooks from config.json).
  private addHook(msg: any): void {
    const scope = scopeOf(msg.scope);
    const event = String(msg.event || "").trim();
    const value = String(msg.value || "").trim();
    if (!event || !value) return;
    const type = msg.hookType === "prompt" ? "prompt" : "command";
    const hook: Record<string, unknown> = { type };
    hook[type] = value;
    if (msg.timeout && Number(msg.timeout) > 0) hook.timeout = Number(msg.timeout);
    const matcher = String(msg.matcher || "");
    const root = msg.root ? String(msg.root) : this.root();
    const file = loadConfigFile(scope, root);
    const hooks = (file.data.hooks && typeof file.data.hooks === "object" ? file.data.hooks : {}) as Record<string, unknown[]>;
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as any[]) : [];
    let group = groups.find((g) => (g.matcher || "") === matcher);
    if (!group) { group = { matcher, hooks: [] }; groups.push(group); }
    group.hooks = Array.isArray(group.hooks) ? group.hooks : [];
    group.hooks.push(hook);
    hooks[event] = groups;
    setConfigPath(scope, "hooks", hooks, root);
  }

  private async createFile(p: string, template: string): Promise<void> {
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, template, "utf8");
      }
      await this.openFile(p);
      await this.sendData();
    } catch (err) {
      void vscode.window.showErrorMessage("Could not create " + p + ": " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Add or remove a value from a permissions bucket (allow/deny/ask) in a scope
  // (and folder, for project scope).
  private editPermission(scope: ConfigScope, bucket: string, value: string, remove: boolean, root?: string): void {
    if (!["allow", "deny", "ask"].includes(bucket) || (!value && !remove)) return;
    const target = root || this.root();
    const file = loadConfigFile(scope, target);
    const perms = (file.data.permissions && typeof file.data.permissions === "object"
      ? (file.data.permissions as Record<string, unknown>)
      : {}) as Record<string, string[]>;
    const list = Array.isArray(perms[bucket]) ? (perms[bucket] as string[]).slice() : [];
    const idx = list.indexOf(value);
    if (remove) {
      if (idx >= 0) list.splice(idx, 1);
    } else if (idx < 0) {
      list.push(value);
    }
    perms[bucket] = list;
    setConfigPath(scope, "permissions", perms, target);
  }

  // --- Gather section data --------------------------------------------------

  private async sendData(): Promise<void> {
    if (this.disposed) return;
    this.startWatching();
    const [skills, plugins, loaded] = await Promise.all([
      listSkills(this.cli).catch(() => []),
      listPlugins(this.cli).catch(() => []),
      // Asking the agent means starting one, which costs about as much as the two
      // listings above, so it runs alongside them rather than after them.
      this.loadFromAgent()
    ]);
    let families: unknown[] = [];
    try { families = await listModelFamilies(this.cli.cliPath, this.cli.env); } catch { /* ignore */ }

    const groups = this.scopeGroups();
    // User skills come from the CLI list (filtered to user scope); project skills
    // per folder are scanned from that folder's .devin/skills directory.
    const userSkills = this.resolveSkills(skills.filter((s) => !(s.source || "").includes("project")));

    const data = {
      folders: this.folders(),
      models: { families },
      // One entry per scope: its config file, the effective value of every row
      // (the User value shows through on a folder scope), and which keys that
      // scope sets explicitly, so the UI can mark set, inherited and overridden.
      valuesByScope: groups.map((g) => this.valueGroup(g)),
      // Per folder: keys whose effective value genuinely overrides the User value.
      folderOverrides: Object.fromEntries(this.folders().map((f) => [f.path, this.overriddenKeys(f.path)])),
      // Settings owned by this extension, disclosed here but edited in VS Code.
      extension: {
        defaultModel: vscode.workspace.getConfiguration("devin").get<string>("defaultModel", "") || ""
      },
      instructions: {
        byScope: groups.map((g) => ({ ...g, file: this.ruleFileForDir(g.scope === "user" ? userConfigDir() : g.root!) })),
        // What the agent has really loaded, which is more than the one file per
        // scope this panel lets you edit: rules also come from Cursor and Windsurf
        // files, from another tool's config, and from plugins. Undefined when the
        // CLI could not be asked, and the section then says only what it can.
        loaded: loaded?.rules
      },
      skills: {
        byScope: groups.map((g) => ({ ...g, list: g.scope === "user" ? userSkills : this.scanProjectSkills(g.root!) }))
      },
      mcp: { byScope: groups.map((g) => ({ ...g, servers: this.mcpServersForScope(g.scope, g.root) })) },
      hooks: {
        byScope: groups.map((g) => ({ ...g, entries: this.hooksForScope(g.scope, g.root) })),
        loaded: loaded?.hooks
      },
      plugins: { list: plugins },
      permissions: { byScope: groups.map((g) => ({ ...g, ...this.permissionsForScope(g.scope, g.root) })) }
    };
    this.post({ type: "settings:data", data });
  }

  // Rules and hooks as the agent reports them. Both need a session, so one query
  // agent answers both and is then closed. Cached until a file changes, which is
  // the only thing that can change the answer: a write here, or an outside edit
  // the watcher picks up.
  private loaded?: { rules: LoadedRule[]; hooks: LoadedHook[] };

  private async loadFromAgent(): Promise<{ rules: LoadedRule[]; hooks: LoadedHook[] } | undefined> {
    if (this.loaded) {
      return this.loaded;
    }
    const root = this.folders()[0]?.path || userConfigDir();
    const result = await withQuerySession(this.cli.cliPath, root, this.cli.env, async (client, sessionId) => ({
      rules: await client.listRules(sessionId),
      hooks: await client.listHooks(sessionId)
    }));
    this.loaded = result;
    return result;
  }

  // The scope groups every section renders: Global plus one per workspace folder.
  private scopeGroups(): { scope: ConfigScope; root?: string; title: string }[] {
    const folders = this.folders();
    const single = folders.length === 1;
    const groups: { scope: ConfigScope; root?: string; title: string }[] = [{ scope: "user", title: "Global" }];
    for (const f of folders) {
      groups.push({ scope: "project", root: f.path, title: single ? "Workspace" : "Workspace · " + f.name });
    }
    return groups;
  }

  // The effective config for a scope: the User file, or the User file with this
  // folder's file layered on top (objects merged one level, the way Devin merges
  // them), so a folder tab shows the value that actually applies.
  private effectiveData(scope: ConfigScope, root?: string): Record<string, unknown> {
    const user = loadConfigFile("user").data;
    if (scope === "user" || !root) return user;
    return mergeConfig(user, loadConfigFile("project", root).data);
  }

  // One scope's rows: the effective value of every key, plus the keys this scope
  // sets itself (which is what separates "unset" from "set to the default").
  private valueGroup(g: { scope: ConfigScope; root?: string; title: string }): unknown {
    const file = loadConfigFile(g.scope, g.root);
    const eff = this.effectiveData(g.scope, g.root);
    const values: Record<string, unknown> = {};
    for (const k of ROW_KEYS) {
      values[k] = defaulted(eff, k);
    }
    return {
      scope: g.scope,
      root: g.root,
      title: g.title,
      path: file.path,
      exists: file.exists,
      values,
      setKeys: ROW_KEYS.filter((k) => pick(file.data, k) !== undefined)
    };
  }

  // Keys the Workspace genuinely overrides: it must EXPLICITLY set the key (not
  // just inherit the default) AND its value must differ from the User value.
  private overriddenKeys(root?: string): string[] {
    if (!root) return [];
    const user = loadConfigFile("user").data;
    const project = loadConfigFile("project", root).data;
    return ROW_KEYS.filter((k) => {
      if (pick(project, k) === undefined) return false;
      return JSON.stringify(defaulted(project, k)) !== JSON.stringify(defaulted(user, k));
    });
  }

  // The instruction entry for a directory. Devin reads AGENTS.md; CLAUDE.md is
  // only a fallback (used when AGENTS.md is absent), so we never offer creating
  // it, and "Create" always creates AGENTS.md.
  private ruleFileForDir(dir: string): { path: string; exists: boolean; kind: string } {
    const agents = path.join(dir, "AGENTS.md");
    const claude = path.join(dir, "CLAUDE.md");
    if (fs.existsSync(agents)) return { path: agents, exists: true, kind: "AGENTS.md" };
    if (fs.existsSync(claude)) return { path: claude, exists: true, kind: "CLAUDE.md" };
    return { path: agents, exists: false, kind: "AGENTS.md" };
  }

  // Project skills for a folder, scanned from its .devin/skills directory.
  private scanProjectSkills(folder: string): unknown[] {
    const base = path.join(folder, ".devin", "skills");
    if (!fs.existsSync(base)) return [];
    const out: unknown[] = [];
    for (const name of fs.readdirSync(base)) {
      const skillMd = path.join(base, name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      out.push({ name, description: this.skillDescription(skillMd), dir: path.join(base, name), path: skillMd, scope: "project" });
    }
    return out;
  }

  // The `description:` from a SKILL.md front-matter block (first line only).
  private skillDescription(file: string): string {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const fm = raw.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
      const m = (fm ? fm[1] : raw).match(/^description:\s*(.+)$/m);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    } catch {
      return "";
    }
  }

  // Resolve each skill's SKILL.md path and directory (for open/remove). The CLI
  // list gives a directory relative to home (user skills) or the project root
  // (.devin/skills); resolve both.
  private resolveSkills(skills: { name: string; description?: string; path?: string; source?: string }[], root?: string): unknown[] {
    const home = os.homedir();
    return skills.map((s) => {
      let dir = s.path || "";
      if (dir === "~") {
        dir = home;
      } else if (dir.startsWith("~/") || dir.startsWith("~\\")) {
        dir = path.join(home, dir.slice(2));
      } else if (dir && !path.isAbsolute(dir)) {
        // Windows separators first, so the test below reads one kind of path.
        const rel = dir.replace(/\\/g, "/").replace(/^\.\//, "");
        // .devin/skills is project-relative; .config/devin/skills and
        // .agents/skills are home-relative.
        dir = rel.startsWith(".devin/") && root ? path.join(root, rel) : path.join(home, rel);
      }
      const scope = (s.source || "").includes("project") ? "project" : "user";
      return { name: s.name, description: s.description, trigger: s.source, dir, path: dir ? path.join(dir, "SKILL.md") : "", scope };
    });
  }

  // The set of MCP servers with a stored OAuth token (logged in), keyed by both
  // server name and url so we can match either.
  private mcpLoggedIn(): { names: Set<string>; urls: Set<string> } {
    const names = new Set<string>();
    const urls = new Set<string>();
    try {
      const dir = mcpOauthDir();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (t && t.access_token) {
            if (t.server_name) names.add(String(t.server_name));
            if (t.url) urls.add(String(t.url));
          }
        } catch { /* ignore a bad token file */ }
      }
    } catch { /* no oauth dir yet */ }
    return { names, urls };
  }

  // MCP servers for one scope: the global files for User, or a folder's
  // .devin/mcp_config.json for a project folder.
  private mcpServersForScope(scope: ConfigScope, root?: string): unknown[] {
    const out: unknown[] = [];
    const seen = new Set<string>();
    const auth = this.mcpLoggedIn();
    const addFrom = (file: string, source = "devin") => {
      if (!fs.existsSync(file)) return;
      const servers = readConfig(file).mcpServers;
      if (!servers || typeof servers !== "object") return;
      for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const d = (def || {}) as Record<string, unknown>;
        // Windsurf writes an http server's address as `serverUrl`, so a server
        // imported from it is not stdio just because it has no `url`.
        const url = typeof d.url === "string" ? d.url : (typeof d.serverUrl === "string" ? d.serverUrl : "");
        const transport = typeof d.type === "string" ? String(d.type) : (url ? "http" : "stdio");
        const loggedIn = (url && auth.urls.has(url)) || auth.names.has(name);
        out.push({
          name, scope, transport, file, source,
          // A safe, secret-free summary. Never expose command args or headers:
          // stdio args and tokens can contain secrets (see mcp get).
          detail: safeMcpDetail(url, d.command),
          disabled: d.disabled === true || d.enabled === false,
          loggedIn: !!loggedIn,
          oauthCapable: transport !== "stdio",
          envKeys: d.env && typeof d.env === "object" ? Object.keys(d.env as object) : [],
          headerKeys: d.headers && typeof d.headers === "object" ? Object.keys(d.headers as object) : []
        });
      }
    };
    if (scope === "user") {
      addFrom(userMcpConfigPath());
      addFrom(userConfigPath());
      // The CLI imports these, so this agent has them whether or not Devin was
      // told about them. Showing them is the only way to know what is loaded.
      addFrom(windsurfMcpConfigPath(), "windsurf");
    } else if (root) {
      addFrom(path.join(root, ".devin", "mcp_config.json"));
    }
    return out;
  }

  // Hooks for one scope: the User config, or a folder's .devin config + hooks.v1.
  private hooksForScope(scope: ConfigScope, root?: string): unknown[] {
    const out: unknown[] = [];
    const addFrom = (hooksObj: unknown, source: string) => {
      if (!hooksObj || typeof hooksObj !== "object") return;
      for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const matcher = (g && typeof g === "object" ? (g as Record<string, unknown>).matcher : "") || "";
          const hooks = (g && typeof g === "object" ? (g as Record<string, unknown>).hooks : []) as unknown[];
          for (const h of Array.isArray(hooks) ? hooks : []) {
            const ho = (h || {}) as Record<string, unknown>;
            out.push({ event, matcher, type: ho.type, command: ho.command, prompt: ho.prompt, timeout: ho.timeout, source });
          }
        }
      }
    };
    const file = loadConfigFile(scope, root);
    addFrom(file.data.hooks, file.path);
    if (scope !== "user" && root) {
      const p = path.join(root, ".devin", "hooks.v1.json");
      if (fs.existsSync(p)) {
        try { addFrom(JSON.parse(stripJsonComments(fs.readFileSync(p, "utf8"))), p); } catch { /* ignore */ }
      }
    }
    return out;
  }

  private permissionsForScope(scope: ConfigScope, root?: string): { allow: unknown[]; deny: unknown[]; ask: unknown[] } {
    const p = (loadConfigFile(scope, root).data.permissions || {}) as Record<string, unknown>;
    return {
      allow: Array.isArray(p.allow) ? p.allow : [],
      deny: Array.isArray(p.deny) ? p.deny : [],
      ask: Array.isArray(p.ask) ? p.ask : []
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "settings.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "codicon", "codicon.css"));
    const body = fs.readFileSync(vscode.Uri.joinPath(this.context.extensionUri, "media", "settings-body.html").fsPath, "utf8");
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Devin Settings</title>
</head>
<body class="settings-body" data-nonce="${nonce}">
  ${body}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function scopeOf(s: unknown): ConfigScope {
  return s === "project" ? "project" : "user";
}

// A safe, secret-free one-line summary of an MCP server for display: the URL
// (host + path, query stripped) for remote servers, or just the command binary
// name for stdio servers (never its args, which can contain tokens).
function safeMcpDetail(url: string, command: unknown): string {
  if (url) {
    try { const u = new URL(url); return u.origin + u.pathname; } catch { return url.split("?")[0]; }
  }
  if (typeof command === "string" && command) {
    return "stdio · " + (path.basename(command) || command);
  }
  return "";
}

function quoteArg(p: string): string {
  if (process.platform === "win32") return /\s/.test(p) ? `"${p}"` : p;
  return /[^A-Za-z0-9_./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Layer one config file over another the way Devin merges them: later keys win,
// and object values (agent, proxy, sandbox, read_config_from) merge one level so
// a folder can override a single sub-key.
function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? { ...b, ...v } : v;
  }
  return out;
}

// A row's value in a config object, falling back to Devin's documented default.
function defaulted(d: Record<string, unknown>, key: string): unknown {
  const v = pick(d, key);
  return v === undefined ? ROW_DEFAULTS[key] : v;
}

// Read a dotted path from a config object.
function pick(obj: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = obj;
  for (const k of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
