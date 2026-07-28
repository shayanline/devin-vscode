import { execFile } from "child_process";

export interface DevinSession {
  id: string;
  short_id: string;
  working_directory: string;
  working_directory_display?: string;
  last_activity_at?: number;
  last_activity_ago?: string;
  title?: string;
}

// Lists Devin sessions via `devin list --format json`, filtered to the given
// working directory (the current VS Code workspace root).
export function listSessions(cliPath: string, cwd: string): Promise<DevinSession[]> {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ["list", "--format", "json"],
      { cwd, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as DevinSession[];
          const all = Array.isArray(parsed) ? parsed : [];
          const scoped = all.filter((s) => sameDir(s.working_directory, cwd));
          scoped.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
          resolve(scoped);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

function sameDir(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return normalize(a) === normalize(b);
}

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, "");
}
