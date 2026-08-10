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
    const shell = process.env.SHELL || "/bin/sh";
    // In fish `$PATH` is a list, so quoting it yields space separated garbage.
    const script = /(^|\/)fish$/.test(shell)
      ? "printf '__PATH__=%s' (string join : $PATH)"
      : "printf '__PATH__=%s' \"$PATH\"";
    execFile(
      shell,
      ["-lic", script],
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
  const exts = isWin ? (env.PATHEXT || ".COM;.EXE;.CMD;.BAT").split(";") : [""];
  const dirs = String(env.PATH || process.env.PATH || "").split(isWin ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    // Windows PATH entries are often quoted, and the quotes are not part of the
    // directory name.
    for (const ext of exts) {
      const candidate = path.join(isWin ? dir.replace(/^"|"$/g, "") : dir, binary + ext);
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
    if (path.isAbsolute(configured)) {
      if (fs.existsSync(configured)) {
        return configured;
      }
    } else {
      // A bare/relative custom name (e.g. "devin-beta"): resolve it on PATH by
      // its basename rather than silently falling back to "devin".
      const viaCustom = await which(path.basename(configured), env);
      if (viaCustom && fs.existsSync(viaCustom)) {
        return viaCustom;
      }
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

// npm installs a CLI on Windows as a `.cmd` shim, and since Node 18.20 a shim
// cannot be spawned directly (CVE-2024-27980): it has to go through the command
// interpreter. Once a shell is in the way the quoting is ours to do, so every
// spawn of the CLI is built here and the quirk lives in one place.
export function cliCommand(bin: string, args: string[]): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) {
    return { file: bin, args, shell: false };
  }
  const quote = (s: string) => (/[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return { file: quote(bin), args: args.map(quote), shell: true };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const cmd = cliCommand(bin, args);
    execFile(cmd.file, cmd.args, { timeout: 8000, env, windowsHide: true, shell: cmd.shell }, (err, stdout, stderr) => {
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
  // `devin auth status` prints "Logged in (via Devin)." when authed and
  // "Not logged in." when not, so a bare /logged in/ match would treat a
  // signed-out user as signed in. Require a positive match and reject the
  // negative phrasings explicitly.
  const loggedIn = /logged in/i.test(auth.out) && !/not logged in|not authenticated|logged out/i.test(auth.out);
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
