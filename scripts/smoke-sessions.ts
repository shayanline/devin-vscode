import { AcpClient } from "../src/acp/client";
import { listSessions } from "../src/session/sessionList";
import { loginShellEnv, resolveCliPath } from "../src/cli/locate";
import * as os from "os";
import * as path from "path";

async function main() {
  const env = await loginShellEnv();
  const cli = (await resolveCliPath("devin")) || "devin";
  const cwd = path.join(os.homedir(), "VSCode", "devin-vscode");
  const client = new AcpClient({ cliPath: cli, cwd, env });
  client.setHost({
    async requestPermission() {
      return { outcome: { outcome: "cancelled" } };
    },
    async readTextFile() {
      return { content: "" };
    },
    async writeTextFile() {
      return null;
    }
  });
  client.on("log", () => {});
  client.start();
  await client.initialize();
  const s = await client.newSession(cwd, []);
  console.log("created:", s.sessionId);

  await client.renameSession(s.sessionId, "smoke rename OK");
  console.log("renamed without error");

  const tracked = [s.sessionId];
  const cwdById = { [s.sessionId]: cwd };
  const listed = await listSessions({ cliPath: cli, env, folders: [cwd], trackedIds: tracked, cwdById });
  const found = listed.sessions.find((x) => x.id === s.sessionId);
  console.log("title after rename:", found ? found.title : "(not in list yet)");

  await client.deleteSession(s.sessionId);
  console.log("deleted without error");

  const after = await listSessions({ cliPath: cli, env, folders: [cwd], trackedIds: tracked, cwdById });
  console.log("still present after delete:", after.sessions.some((x) => x.id === s.sessionId));
  console.log("reconcile pruned it:", after.prunedIds.includes(s.sessionId));

  client.dispose();
  process.exit(0);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
