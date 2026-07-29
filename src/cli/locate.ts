import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CliHealth {
  path: string;
  found: boolean;
  version?: string;
  loggedIn?: boolean;
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

function which(binary: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const bin = isWin ? "where" : env.SHELL || "/bin/zsh";
    const args = isWin ? [binary] : ["-lic", `command -v ${binary}`];
    execFile(bin, args, { timeout: 5000, env, windowsHide: true }, (_err, stdout) => {
      const line = String(stdout || "")
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0);
      resolve(line && line.trim() ? line.trim() : undefined);
    });
  });
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
  const version = await run(resolved, ["--version"], env);
  if (!version.ok) {
    return { path: resolved, found: false, error: version.out || "Failed to run devin --version" };
  }
  const auth = await run(resolved, ["auth", "status"], env);
  const loggedIn = /logged in/i.test(auth.out);
  return { path: resolved, found: true, version: version.out, loggedIn };
}
