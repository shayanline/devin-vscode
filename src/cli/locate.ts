import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CliAccount {
  name?: string;
  email?: string;
  tier?: string;
  plan?: string;
}

export interface CliHealth {
  path: string;
  found: boolean;
  version?: string;
  loggedIn?: boolean;
  account?: CliAccount;
  error?: string;
}

let cachedEnv: NodeJS.ProcessEnv | undefined;

// GUI apps on macOS/Linux do not inherit the shell PATH, so resolve it from a
// login shell once and reuse it. The Devin CLI also spawns MCP servers
// (npx, docker, uvx) that need this PATH.
export function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) {
    return Promise.resolve(cachedEnv);
  }
  if (process.platform === "win32") {
    cachedEnv = process.env;
    return Promise.resolve(cachedEnv);
  }
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-lic", "printf '__PATH__=%s' \"$PATH\""],
      { timeout: 5000, windowsHide: true },
      (_err, stdout) => {
        const match = /__PATH__=([^\n]*)/.exec(stdout || "");
        cachedEnv = match ? { ...process.env, PATH: match[1] } : { ...process.env };
        resolve(cachedEnv);
      }
    );
  });
}

export function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function commonLocations(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(local, "Programs", "devin", "devin.exe"),
      path.join(home, ".local", "bin", "devin.exe"),
      path.join(local, "devin", "devin.exe")
    ];
  }
  return [
    path.join(home, ".local", "bin", "devin"),
    "/usr/local/bin/devin",
    "/opt/homebrew/bin/devin",
    "/usr/bin/devin"
  ];
}

// Resolve a binary by scanning the (already login-shell-resolved) PATH
// directly, instead of spawning another interactive login shell, which on a
// heavy shell profile can add several seconds to startup.
function which(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const isWin = process.platform === "win32";
  const exts = isWin ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = String(env.PATH || process.env.PATH || "").split(isWin ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (fs.existsSync(candidate)) {
          return Promise.resolve(candidate);
        }
      } catch {
        // ignore unreadable dirs
      }
    }
  }
  return Promise.resolve(undefined);
}

// Resolves the devin binary using: explicit setting, login-shell PATH lookup,
// then common install locations. Returns an absolute path when possible.
export async function resolveCliPath(setting: string): Promise<string | undefined> {
  const env = await loginShellEnv();
  const configured = expandHome((setting || "").trim());
  if (configured && configured !== "devin") {
    if (path.isAbsolute(configured) && fs.existsSync(configured)) {
      return configured;
    }
  }
  const viaWhich = await which("devin", env);
  if (viaWhich && fs.existsSync(viaWhich)) {
    return viaWhich;
  }
  for (const candidate of commonLocations()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return configured && configured !== "devin" ? configured : undefined;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, env, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr || "").trim() });
    });
  });
}

export async function checkHealth(setting: string): Promise<CliHealth> {
  const env = await loginShellEnv();
  const resolved = await resolveCliPath(setting);
  if (!resolved) {
    return { path: setting || "devin", found: false, error: "Devin CLI not found" };
  }
  // Version and auth status are independent; run them together to save a
  // whole CLI round-trip on startup.
  const [version, auth] = await Promise.all([
    run(resolved, ["--version"], env),
    run(resolved, ["auth", "status"], env)
  ]);
  if (!version.ok) {
    return { path: resolved, found: false, error: version.out || "Failed to run devin --version" };
  }
  const loggedIn = /logged in/i.test(auth.out);
  const account = loggedIn ? parseAccount(auth.out) : undefined;
  return { path: resolved, found: true, version: cleanVersion(version.out), loggedIn, account };
}

function cleanVersion(out: string): string {
  const line = (out || "").split(/\r?\n/)[0].trim();
  return line.replace(/^devin\s+/i, "");
}

// Parses the human-readable `devin auth status` output.
function parseAccount(out: string): CliAccount {
  const pick = (label: string) => {
    const m = new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi").exec(out);
    return m ? m[1].trim() : undefined;
  };
  return { name: pick("Name"), email: pick("Email"), tier: pick("Tier"), plan: pick("Plan") };
}
