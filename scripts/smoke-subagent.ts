// Manual smoke test for subagent rendering: drives a real `devin acp` session
// through the extension's own AcpClient, spawns a foreground and a background
// subagent, exercises the foreground/background control methods, and prints the
// subagent lifecycle the host has to translate.
//
//   npx tsx scripts/smoke-subagent.ts
import { AcpClient } from "../src/acp/client";
import { SessionUpdateNotification, SubagentCompleted, SubagentStarted } from "../src/acp/types";

async function main() {
  const cwd = process.env.HOME + "/VSCode/devin-vscode";
  const client = new AcpClient({ cliPath: "devin", cwd });
  client.setHost({
    async requestPermission(params) {
      const allow = params.options.find((o) => (o.kind || "").startsWith("allow")) || params.options[0];
      return allow
        ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    },
    async readTextFile() {
      return { content: "" };
    },
    async writeTextFile() {
      return null;
    }
  });

  let sessionId = "";
  let switched = false;
  const seen = new Map<string, { title?: string; tools: number; chunks: number; done?: boolean }>();

  client.on("update", (n: SessionUpdateNotification) => {
    const u = n.update as any;
    const meta = u._meta || {};
    const started: SubagentStarted | undefined = meta["cognition.ai/subagent_started"];
    const completed: SubagentCompleted | undefined = meta["cognition.ai/subagent_completed"];
    const parent = meta["cognition.ai/subagent_context"]?.parentAgentId;
    if (started) {
      seen.set(started.agentId, { title: started.title, tools: 0, chunks: 0 });
      console.log(`\n[started] ${started.agentId} profile=${started.profile} background=${started.isBackground} ${started.title}`);
      // Exercise the control methods once, on the first foreground subagent.
      if (!switched && started.isBackground === false) {
        switched = true;
        setTimeout(async () => {
          await client.subagentBackground(sessionId, started.agentId);
          console.log(`[control] ${started.agentId} -> background`);
          await client.subagentForeground(sessionId, started.agentId);
          console.log(`[control] ${started.agentId} -> foreground`);
        }, 2500);
      }
      return;
    }
    if (completed) {
      const e = seen.get(completed.agentId);
      if (e) e.done = true;
      console.log(`[completed] ${completed.agentId} success=${completed.success} report=${(completed.summary || "").length} chars`);
      return;
    }
    if (!parent) {
      return;
    }
    const e = seen.get(parent) || { tools: 0, chunks: 0 };
    if (u.sessionUpdate === "tool_call") e.tools++;
    if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") e.chunks++;
    seen.set(parent, e);
  });
  client.on("log", () => {});

  client.start();
  const init = await client.initialize();
  console.log("subagent control:", client.supportsSubagentControl());
  console.log("agent capabilities:", Object.keys((init.agentCapabilities?._meta as object) || {}).length, "flags");

  const session = await client.newSession(cwd);
  sessionId = session.sessionId;
  const bypass = session.modes?.availableModes?.find((m) => /bypass/i.test(m.id + " " + (m.name || "")));
  if (bypass) await client.setConfigOption(sessionId, "mode", bypass.id);

  const result = await client.prompt(sessionId, [
    {
      type: "text",
      text: "Launch one background explore subagent to list the files in media/ and one foreground explore subagent to summarise src/ui/. Wait for both, then summarise in one sentence."
    }
  ]);
  console.log("\nstop reason:", result.stopReason);
  console.log("\nsubagents seen:");
  for (const [id, e] of seen) {
    console.log(`  ${id} "${e.title}" tools=${e.tools} chunks=${e.chunks} reported=${!!e.done}`);
  }
  client.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
