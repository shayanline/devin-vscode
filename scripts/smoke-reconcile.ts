import { resolveCliPath, loginShellEnv, checkHealth } from "../src/cli/locate";
import { listSessions } from "../src/session/sessionList";
import * as os from "os";
import * as path from "path";

// Exercises the membership + liveness reconciliation in listSessions: tracked
// ids are looked up in their recorded cwd, ids Devin no longer knows about come
// back in `prunedIds`. Pass a real session id in this directory as argv[2] to
// see it kept alongside the bogus one being pruned.
async function main() {
  const env = await loginShellEnv();
  const resolved = await resolveCliPath("devin");
  const cli = resolved || "devin";
  const health = await checkHealth(cli);
  console.log("health =>", JSON.stringify(health));

  const proj = path.join(os.homedir(), "VSCode", "devin-vscode");
  const realId = process.argv[2] || "";
  const bogusId = "definitely-not-a-real-session-xyz";

  const trackedIds = [bogusId, ...(realId ? [realId] : [])];
  const cwdById: Record<string, string> = { [bogusId]: proj };
  if (realId) cwdById[realId] = proj;

  const { sessions, prunedIds } = await listSessions({ cliPath: cli, env, folders: [proj], trackedIds, cwdById });
  console.log(`\nkept (still exist) count=${sessions.length}`);
  sessions.slice(0, 5).forEach((s) => console.log("  -", s.id, "|", s.working_directory, "tracked=", s.tracked));
  console.log("pruned (gone in Devin):", prunedIds);
  console.log("bogus id pruned as expected:", prunedIds.includes(bogusId));

  process.exit(0);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
