import { AcpClient } from "../src/acp/client";
import { SessionUpdateNotification } from "../src/acp/types";

async function main() {
  const cwd = process.env.HOME + "/VSCode/devin-vscode";
  const client = new AcpClient({ cliPath: "devin", cwd });
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

  let streamed = "";
  client.on("update", (n: SessionUpdateNotification) => {
    const u = n.update as any;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      streamed += u.content.text;
      process.stdout.write(u.content.text);
    }
  });
  client.on("log", () => {});

  client.start();
  await client.initialize();
  const s = await client.newSession();
  console.log("\n[session] " + s.sessionId);
  const res = await client.prompt(s.sessionId, [
    { type: "text", text: "Reply with exactly one word: PONG. Do not use any tools." }
  ]);
  console.log("\n[stopReason] " + res.stopReason);
  console.log("[streamedChars] " + streamed.length);
  client.dispose();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
