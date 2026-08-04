import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Reads and writes the Devin CLI config files that back the settings surface.
// Config files are JSON with comments (JSONC). We parse comment-tolerantly for
// display and, for direct edits, write back a normalised JSON file (comments in
// that file are lost, so the UI warns and offers an "open file" escape hatch).
// MCP writes go through the CLI verbs instead (see devinConfigCli).

// Two scopes only: user (global) and project (this workspace, .devin/config.json).
// We deliberately do not expose a separate gitignored "local" scope; the user
// gitignores whatever they want.
export type ConfigScope = "user" | "project";

export interface ConfigFile {
  scope: ConfigScope;
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
}

// The user config directory: XDG on macOS/Linux, %APPDATA% on Windows.
export function userConfigDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "devin");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "devin");
}

export function userConfigPath(): string {
  return path.join(userConfigDir(), "config.json");
}

// MCP servers are stored separately from config.json: globally in
// ~/.config/devin/mcp_config.json, and per project under .devin/.
export function userMcpConfigPath(): string {
  return path.join(userConfigDir(), "mcp_config.json");
}

// MCP OAuth tokens are stored per server under the data dir; their presence
// tells us a server is logged in.
export function mcpOauthDir(): string {
  const dataHome = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
  return path.join(dataHome, "devin", "mcp", "oauth");
}

export function projectConfigPath(root: string): string {
  return path.join(root, ".devin", "config.json");
}

// Strip // line comments and /* block */ comments and trailing commas so a
// JSONC config file parses with JSON.parse. String-aware so it does not touch
// `//` or `/*` inside string values.
export function stripJsonComments(input: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === quote) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function readConfig(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadConfigFile(scope: ConfigScope, root?: string): ConfigFile {
  const p = scope === "user" ? userConfigPath() : projectConfigPath(root || process.cwd());
  return { scope, path: p, exists: fs.existsSync(p), data: readConfig(p) };
}

// Set a dotted path (e.g. "agent.model", "proxy.mode") in a config file. An
// undefined value removes the key, along with any parent object it leaves empty,
// so a removed setting does not linger as `"proxy": {}`.
export function setConfigPath(scope: ConfigScope, dotted: string, value: unknown, root?: string): string {
  const p = scope === "user" ? userConfigPath() : projectConfigPath(root || process.cwd());
  const current = readConfig(p);
  const keys = dotted.split(".");
  const chain: Record<string, unknown>[] = [current];
  let node: Record<string, unknown> = current;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!node[k] || typeof node[k] !== "object") node[k] = {};
    node = node[k] as Record<string, unknown>;
    chain.push(node);
  }
  if (value === undefined) {
    delete node[keys[keys.length - 1]];
    for (let i = chain.length - 1; i > 0; i--) {
      if (Object.keys(chain[i]).length) break;
      delete chain[i - 1][keys[i - 1]];
    }
  } else {
    node[keys[keys.length - 1]] = value;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(current, null, 2) + "\n", "utf8");
  return p;
}
