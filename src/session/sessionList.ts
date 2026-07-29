import { execFile } from "child_process";
import * as path from "path";

export interface DevinSession {
  id: string;
  short_id: string;
  working_directory: string;
  working_directory_display?: string;
  last_activity_at?: number;
  last_activity_ago?: string;
  title?: string;
  tracked?: boolean;
}

export type SessionScope = "both" | "workspace" | "directory";

interface ListOptions {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  folders: string[];
  trackedIds: string[];
  scope: SessionScope;
}

// `devin list --format json` scopes to the given cwd, so we run it once per
// workspace folder and union the results. Sessions are then filtered by scope:
//  - directory: any session whose working_directory is inside a workspace folder
//  - workspace: only sessions tracked for this VS Code workspace
//  - both:      the union of the two
export async function listSessions(opts: ListOptions): Promise<DevinSession[]> {
  const folders = opts.folders.length ? opts.folders : [process.cwd()];
  const perFolder = await Promise.all(folders.map((f) => runList(opts.cliPath, f, opts.env)));

  const byId = new Map<string, DevinSession>();
  for (const list of perFolder) {
    for (const s of list) {
      if (s && s.id && !byId.has(s.id)) {
        byId.set(s.id, s);
      }
    }
  }

  const tracked = new Set(opts.trackedIds);
  const inWorkspace = (s: DevinSession) => folders.some((f) => within(f, s.working_directory));

  const result: DevinSession[] = [];
  for (const s of byId.values()) {
    const isTracked = tracked.has(s.id);
    const isDir = inWorkspace(s);
    const include =
      opts.scope === "workspace" ? isTracked : opts.scope === "directory" ? isDir : isTracked || isDir;
    if (include) {
      result.push({ ...s, tracked: isTracked });
    }
  }

  // Tracked ids that did not appear in any listing (e.g. deleted dir) still show.
  for (const id of opts.trackedIds) {
    if (!byId.has(id) && opts.scope !== "directory") {
      result.push({ id, short_id: id, working_directory: "", title: id, tracked: true });
    }
  }

  result.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
  return result;
}

function runList(cliPath: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<DevinSession[]> {
  return new Promise((resolve) => {
    execFile(
      cliPath,
      ["list", "--format", "json"],
      { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as DevinSession[];
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

// True when `child` is the same directory as `parent` or nested inside it.
function within(parent: string, child: string | undefined): boolean {
  if (!parent || !child) {
    return false;
  }
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, "");
}
