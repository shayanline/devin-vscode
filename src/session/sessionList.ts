import { execFile } from "child_process";
import { cliCommand } from "../cli/locate";

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

interface ListOptions {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  // Session ids this VS Code window owns (from workspaceState).
  trackedIds: string[];
  // Exact directory each tracked id was created in.
  cwdById: Record<string, string>;
  // Workspace folders, queried as a fallback for ids with no recorded cwd.
  folders: string[];
}

export interface ListResult {
  // Tracked sessions that still exist in Devin, with fresh metadata.
  sessions: DevinSession[];
  // Tracked ids Devin no longer knows about, safe to drop from the store.
  prunedIds: string[];
}

// Membership is workspaceState (tracked ids); the CLI is only the source of
// truth for existence and metadata. `devin list --format json` is exact-match
// on cwd, so we query each distinct directory a tracked session was created in,
// then keep only the tracked ids the CLI still returns. Ids whose directory was
// queried successfully but no longer contains them are pruned; ids whose query
// failed are left untouched so a transient CLI error never wipes the list.
export async function listSessions(opts: ListOptions): Promise<ListResult> {
  const dirs = new Set<string>();
  for (const id of opts.trackedIds) {
    const cwd = opts.cwdById[id];
    if (cwd) {
      dirs.add(cwd);
    }
  }
  for (const f of opts.folders) {
    dirs.add(f);
  }
  if (dirs.size === 0) {
    dirs.add(process.cwd());
  }

  const queried = await Promise.all([...dirs].map((d) => runList(opts.cliPath, d, opts.env)));

  const byId = new Map<string, DevinSession>();
  const okDirs = new Set<string>();
  queried.forEach((res, i) => {
    const dir = [...dirs][i];
    if (!res.ok) {
      return;
    }
    okDirs.add(dir);
    for (const s of res.sessions) {
      if (s && s.id && !byId.has(s.id)) {
        byId.set(s.id, s);
      }
    }
  });

  const sessions: DevinSession[] = [];
  const prunedIds: string[] = [];
  for (const id of opts.trackedIds) {
    const found = byId.get(id);
    if (found) {
      sessions.push({ ...found, tracked: true });
      continue;
    }
    // Absent: prune only if the directory we expected it in was queried
    // successfully (so we know it is genuinely gone, not a failed call).
    const cwd = opts.cwdById[id];
    const dirKnown = cwd ? okDirs.has(cwd) : okDirs.size === dirs.size;
    if (dirKnown) {
      prunedIds.push(id);
    }
  }

  sessions.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
  return { sessions, prunedIds };
}

interface RunResult {
  ok: boolean;
  sessions: DevinSession[];
}

function runList(cliPath: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const cmd = cliCommand(cliPath, ["list", "--format", "json"]);
    execFile(
      cmd.file,
      cmd.args,
      { cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, shell: cmd.shell },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, sessions: [] });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as DevinSession[];
          resolve({ ok: true, sessions: Array.isArray(parsed) ? parsed : [] });
        } catch {
          resolve({ ok: false, sessions: [] });
        }
      }
    );
  });
}
