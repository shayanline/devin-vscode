import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  ConfigScope,
  loadAllConfigs,
  loadConfigFile,
  mcpOauthDir,
  mergedValue,
  readConfig,
  setConfigPath,
  stripJsonComments,
  userConfigDir,
  userConfigPath,
  userMcpConfigPath
} from "./configService";
import { CliContext, listPlugins, listSkills, mcpAdd, mcpVerb, McpAddOptions, pluginVerb } from "./devinConfigCli";
import { checkHealth, loginShellEnv } from "../cli/locate";
import { listModelFamilies } from "../cli/models";

// The Devin customizations / settings surface: a webview editor panel with a
// section sidebar (Models, Rules, Skills, MCP, Hooks, Permissions, Behaviour,
// Network, Advanced) exposing the full Devin CLI config surface.
export class SettingsPanel {
  private static current?: SettingsPanel;
  private readonly panel: vscode.WebviewPanel;
  private cli: CliContext = { cliPath: "devin" };
  private disposed = false;

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
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    panel.onDidDispose(() => {
      this.disposed = true;
      if (SettingsPanel.current === this) {
        SettingsPanel.current = undefined;
      }
    });
  }

  // The active workspace folder for project-scoped reads/writes. Defaults to the
  // first folder; in a multi-root workspace the user picks which folder applies.
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

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case "settings:load":
          await this.ensureCli();
          await this.sendData();
          return;
        case "settings:refresh":
          await this.sendData();
          return;
        case "settings:setPath":
          setConfigPath(scopeOf(msg.scope), String(msg.path), msg.value, msg.root ? String(msg.root) : this.root());
          await this.sendData();
          return;
        case "settings:setRoot":
          this.selectedRoot = String(msg.path || "") || undefined;
          this.cli.cwd = this.root();
          await this.sendData();
          return;
        case "settings:resetSection":
          await this.resetSection(scopeOf(msg.scope), Array.isArray(msg.keys) ? msg.keys.map(String) : [], String(msg.label || "this section"), msg.root ? String(msg.root) : this.root());
          return;
        case "settings:openExtensionSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:shayanline.devin-vscode");
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
          this.post({ type: "settings:busy", value: true });
          const r = await pluginVerb(this.cli, msg.verb, msg.arg ? String(msg.arg) : undefined);
          if (!r.ok) {
            void vscode.window.showErrorMessage(`Plugin ${msg.verb} failed: ` + (r.err || "unknown error"));
          }
          await this.sendData();
          this.post({ type: "settings:busy", value: false });
          return;
        }
        case "settings:permission":
          this.editPermission(scopeOf(msg.scope), String(msg.bucket), String(msg.value || ""), !!msg.remove, msg.root ? String(msg.root) : undefined);
          await this.sendData();
          return;
        case "settings:mcpAdd": {
          this.post({ type: "settings:busy", value: true });
          const r = await mcpAdd(this.ctxFor(msg.root), msg.options as McpAddOptions);
          if (!r.ok) {
            void vscode.window.showErrorMessage("Add MCP server failed: " + (r.err || "unknown error"));
          }
          await this.sendData();
          this.post({ type: "settings:busy", value: false });
          return;
        }
        case "settings:mcpVerb": {
          this.post({ type: "settings:busy", value: true });
          const r = await mcpVerb(this.ctxFor(msg.root), msg.verb, String(msg.name), msg.scope ? scopeOf(msg.scope) : undefined);
          if (!r.ok) {
            void vscode.window.showErrorMessage(`MCP ${msg.verb} failed: ` + (r.err || "unknown error"));
          }
          await this.sendData();
          this.post({ type: "settings:busy", value: false });
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
    }
  }

  // A CLI context whose cwd is a specific folder (for project-scoped verbs), or
  // the active folder by default.
  private ctxFor(root?: unknown): CliContext {
    return { ...this.cli, cwd: (typeof root === "string" && root) ? root : this.root() };
  }

  // Reset a section: remove its keys from the given scope (and folder, for
  // project scope) so they fall back to Devin's defaults. Confirmed first.
  private async resetSection(scope: ConfigScope, keys: string[], label: string, root?: string): Promise<void> {
    if (!keys.length) return;
    const where = scope === "user" ? "User" : "Workspace";
    const choice = await vscode.window.showWarningMessage(
      `Reset ${label} to defaults in ${where}? This removes those settings from the config.`,
      { modal: true },
      "Reset"
    );
    if (choice !== "Reset") return;
    for (const k of keys) setConfigPath(scope, k, undefined, root || this.root());
    await this.sendData();
  }

  private mcpLoginTerminal(name: string, root?: string): void {
    if (!name) return;
    const term = vscode.window.createTerminal({ name: "Devin MCP login", env: this.cli.env, cwd: root || this.root() });
    term.show(true);
    term.sendText(`${quoteArg(this.cli.cliPath)} mcp login ${quoteArg(name)}`);
  }

  private async openFile(p: string): Promise<void> {
    if (!p) return;
    if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
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
    const root = this.root();
    const files = loadAllConfigs(root);
    const [skills, plugins] = await Promise.all([
      listSkills(this.cli).catch(() => []),
      listPlugins(this.cli).catch(() => [])
    ]);
    let families: unknown[] = [];
    try { families = await listModelFamilies(this.cli.cliPath, this.cli.env); } catch { /* ignore */ }

    const groups = this.scopeGroups();
    // User skills come from the CLI list (filtered to user scope); project skills
    // per folder are scanned from that folder's .devin/skills directory.
    const userSkills = this.resolveSkills(skills.filter((s) => !(s.source || "").includes("project")));

    const data = {
      root: root || null,
      userConfigPath: userConfigPath(),
      hasProject: !!root,
      folders: this.folders(),
      activeRoot: root || null,
      scopes: files.map((f) => ({ scope: f.scope, path: f.path, exists: f.exists })),
      models: { families },
      // Value settings for the User scope and for every workspace folder, so the
      // UI can show a collapsible group per scope/folder and edit each one.
      userValues: this.valueSettings("user"),
      folderValues: Object.fromEntries(this.folders().map((f) => [f.path, this.valueSettings("project", f.path)])),
      // Per folder: keys whose effective value genuinely overrides the User value.
      folderOverrides: Object.fromEntries(this.folders().map((f) => [f.path, this.overriddenKeys(f.path)])),
      // Every project-scoped section is grouped the same way: a User group plus
      // one group per workspace folder.
      rules: {
        byScope: groups.map((g) => ({ ...g, file: this.ruleFileForDir(g.scope === "user" ? userConfigDir() : g.root!) })),
        readConfigFrom: (mergedValue(files, "read_config_from") as Record<string, unknown>) || {}
      },
      skills: {
        byScope: groups.map((g) => ({ ...g, list: g.scope === "user" ? userSkills : this.scanProjectSkills(g.root!) })),
        dirs: [path.join(userConfigDir(), "skills"), root ? path.join(root, ".devin", "skills") : ""].filter(Boolean)
      },
      mcp: { byScope: groups.map((g) => ({ ...g, servers: this.mcpServersForScope(g.scope, g.root) })) },
      hooks: { byScope: groups.map((g) => ({ ...g, entries: this.hooksForScope(g.scope, g.root) })) },
      plugins: { list: plugins },
      permissions: { byScope: groups.map((g) => ({ ...g, ...this.permissionsForScope(g.scope, g.root) })) }
    };
    this.post({ type: "settings:data", data });
  }

  // The scope groups every section renders: User plus one per workspace folder.
  private scopeGroups(): { scope: ConfigScope; root?: string; title: string }[] {
    const folders = this.folders();
    const single = folders.length === 1;
    const groups: { scope: ConfigScope; root?: string; title: string }[] = [{ scope: "user", title: "User" }];
    for (const f of folders) {
      groups.push({ scope: "project", root: f.path, title: single ? "Workspace" : "Workspace · " + f.name });
    }
    return groups;
  }

  // Value-setting keys the Workspace genuinely overrides: it must EXPLICITLY set
  // the key (not just inherit the default) AND its value must differ from the
  // User value. This avoids flagging keys the user only ever set at User scope.
  private overriddenKeys(root?: string): string[] {
    if (!root) return [];
    const user = loadConfigFile("user").data;
    const project = loadConfigFile("project", root).data;
    return VALUE_KEYS.filter((k) => {
      if (pick(project, k) === undefined) return false;
      return JSON.stringify(keyValue(project, k)) !== JSON.stringify(keyValue(user, k));
    });
  }

  // The value-based settings, read raw from one scope's config (user, project,
  // or project-local). Booleans fall back to Devin's documented default when the
  // key is unset in that scope.
  private valueSettings(scope: ConfigScope, root?: string): unknown {
    const d = loadConfigFile(scope, root).data;
    return {
      agentModel: pick(d, "agent.model") ?? "",
      showHistoryOnContinue: pick(d, "agent.show_history_on_continue") !== false,
      behaviour: {
        attribution: pick(d, "attribution") !== false,
        auto_update: pick(d, "auto_update") !== false,
        notify: (pick(d, "notify") as string) || "smart",
        respect_gitignore: pick(d, "respect_gitignore") === true,
        include_gitignored_files: pick(d, "include_gitignored_files") === true,
        show_hints: pick(d, "show_hints") !== false
      },
      network: {
        proxy: (pick(d, "proxy") as Record<string, unknown>) || { mode: "system" },
        sandbox: (pick(d, "sandbox") as Record<string, unknown>) || { allowed_domains: [], denied_domains: [], network_mode: "full" }
      },
      advanced: {
        theme_mode: (pick(d, "theme_mode") as string) || "",
        unicode_mode: (pick(d, "unicode_mode") as string) || "auto",
        pty_for_noninteractive_exec: pick(d, "pty_for_noninteractive_exec") === true,
        disable_osc: pick(d, "disable_osc") === true
      }
    };
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
      } else if (dir.startsWith("~/")) {
        dir = path.join(home, dir.slice(2));
      } else if (dir && !path.isAbsolute(dir)) {
        const rel = dir.replace(/^\.\//, "");
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
    const addFrom = (file: string) => {
      if (!fs.existsSync(file)) return;
      const servers = readConfig(file).mcpServers;
      if (!servers || typeof servers !== "object") return;
      for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const d = (def || {}) as Record<string, unknown>;
        const transport = typeof d.type === "string" ? String(d.type) : (d.url ? "http" : "stdio");
        const url = typeof d.url === "string" ? d.url : "";
        const loggedIn = (url && auth.urls.has(url)) || auth.names.has(name);
        out.push({
          name, scope, transport, file,
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

// The value-setting keys the scope switcher edits.
const VALUE_KEYS = [
  "agent.model", "agent.show_history_on_continue", "attribution", "auto_update",
  "notify", "respect_gitignore", "include_gitignored_files", "show_hints",
  "proxy", "sandbox", "theme_mode", "unicode_mode",
  "pty_for_noninteractive_exec", "disable_osc"
];

// The effective value of a value-setting key in a config object, applying the
// same defaults the UI uses (so equal effective values compare equal).
function keyValue(d: Record<string, unknown>, key: string): unknown {
  const v = pick(d, key);
  switch (key) {
    case "agent.model": return v ?? "";
    case "notify": return v || "smart";
    case "theme_mode": return v || "";
    case "unicode_mode": return v || "auto";
    case "proxy": return v || { mode: "system" };
    case "sandbox": return v || { allowed_domains: [], denied_domains: [], network_mode: "full" };
    case "respect_gitignore":
    case "include_gitignored_files":
    case "pty_for_noninteractive_exec":
    case "disable_osc":
      return v === true;
    default:
      // attribution, auto_update, show_hints, agent.show_history_on_continue
      return v !== false;
  }
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
