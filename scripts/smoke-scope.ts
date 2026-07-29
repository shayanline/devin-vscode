import { resolveCliPath, loginShellEnv, checkHealth } from "../src/cli/locate";
import { listSessions } from "../src/session/sessionList";
import * as os from "os";
import * as path from "path";

async function main() {
  const env = await loginShellEnv();
  console.log("PATH has ~/.local/bin:", (env.PATH || "").includes(path.join(os.homedir(), ".local/bin")));

  const resolved = await resolveCliPath("devin");
  console.log("resolveCliPath('devin') =>", resolved);

  const health = await checkHealth("devin");
  console.log("health =>", JSON.stringify(health));

  const cli = resolved || "devin";
  const proj = path.join(os.homedir(), "VSCode", "devin-vscode");

  const dirScoped = await listSessions({ cliPath: cli, env, folders: [proj], trackedIds: [], scope: "directory" });
  console.log(`\n[directory scope @ ${proj}] count=${dirScoped.length}`);
  dirScoped.slice(0, 3).forEach((s) => console.log("  -", s.id, "|", s.working_directory));

  const parent = path.join(os.homedir(), "VSCode");
  const parentScoped = await listSessions({ cliPath: cli, env, folders: [parent], trackedIds: [], scope: "directory" });
  console.log(`\n[directory scope @ ${parent}] count=${parentScoped.length} (should include subdir sessions)`);

  const wsOnly = await listSessions({ cliPath: cli, env, folders: [proj], trackedIds: ["grape-chalk"], scope: "workspace" });
  console.log(`\n[workspace scope, tracked=grape-chalk] count=${wsOnly.length}`);
  wsOnly.slice(0, 3).forEach((s) => console.log("  -", s.id, "tracked=", s.tracked));

  process.exit(0);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
