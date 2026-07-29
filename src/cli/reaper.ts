import { execFile } from "child_process";

// Best-effort cleanup of stranded `devin acp` agents (and their MCP server
// children) left behind by a previously crashed or force-quit VS Code.
//
// Safety: we only ever touch ORPHANS, i.e. a `devin acp` whose parent has died
// so it was reparented to init (ppid == 1). A live window's agent has a live
// extension-host parent, a terminal `devin` TUI is not `devin acp`, and this
// (or any) session's MCP servers hang off a live agent, so none of those are
// ever matched. macOS/Linux only (no-op on Windows).
export function reapOrphanedAgents(log: (line: string) => void): void {
  if (process.platform === "win32") {
    return;
  }
  execFile("ps", ["-ax", "-o", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) {
      return;
    }
    const rows: { pid: number; ppid: number; cmd: string }[] = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) {
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
      }
    }
    const childrenOf = new Map<number, number[]>();
    for (const r of rows) {
      const arr = childrenOf.get(r.ppid);
      if (arr) {
        arr.push(r.pid);
      } else {
        childrenOf.set(r.ppid, [r.pid]);
      }
    }
    // An orphaned agent: reparented to init and the command is `.../devin acp`.
    const orphans = rows.filter(
      (r) => r.ppid === 1 && /(^|\/)devin acp(\s|$)/.test(r.cmd)
    );
    if (orphans.length === 0) {
      return;
    }
    // Collect each orphan plus its whole descendant tree (its MCP servers).
    const toKill = new Set<number>();
    const collect = (pid: number): void => {
      if (toKill.has(pid)) {
        return;
      }
      toKill.add(pid);
      for (const c of childrenOf.get(pid) ?? []) {
        collect(c);
      }
    };
    for (const o of orphans) {
      collect(o.pid);
    }
    log(`[reaper] cleaning ${orphans.length} stranded devin acp agent(s) (${toKill.size} process(es))`);
    for (const pid of toKill) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}
