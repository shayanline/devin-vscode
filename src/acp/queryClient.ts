import { AcpClient } from "./client";
import { RequestDiagnosticsResult, TerminalExitStatus, TerminalRef } from "./types";

// Ask a `devin acp` a question, outside any chat.
//
// Some of what the CLI knows is only available over the protocol and only with a
// session open: which rules and hooks are actually loaded, for instance, which the
// settings panel would otherwise have to guess by scanning for files it knows the
// names of (and get wrong, since a plugin or another tool can contribute them).
//
// The panel has no chat, so this opens an agent for the length of the question and
// then closes it. The session it needs is deleted on the way out, because a session
// is listed the moment it is created and leaving debris in the user's own session
// list to answer a settings panel would be its own bug.
//
// Prefer an already running agent where there is one (`ChatController` hands its
// client over): this exists for the cold case, not to be the normal path.
export async function withQuerySession<T>(
  cliPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  work: (client: AcpClient, sessionId: string) => Promise<T>
): Promise<T | undefined> {
  const client = new AcpClient({ cliPath, cwd, env });
  // The agent can ask things of a client mid session. Nothing here runs a tool, so
  // these only exist so an unexpected request cannot hang the call.
  client.setHost({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    requestDiagnostics: (): RequestDiagnosticsResult => ({ items: [] }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
    createElicitation: async () => ({ action: "cancel" }),
    createTerminal: () => ({ terminalId: "query-noop" }),
    terminalOutput: () => ({ output: "", truncated: false, exitStatus: null }),
    waitForTerminalExit: async (): Promise<TerminalExitStatus> => ({ exitCode: 0, signal: null }),
    killTerminal: (_: TerminalRef) => ({}),
    releaseTerminal: (_: TerminalRef) => ({})
  });
  let sessionId = "";
  try {
    client.start();
    await client.initialize();
    const session = await client.newSession(cwd);
    sessionId = session.sessionId;
    return await work(client, sessionId);
  } catch {
    // Every caller has a fallback for this (the file scan it used to do), so a
    // failure here is not worth a message of its own.
    return undefined;
  } finally {
    if (sessionId) {
      await client.deleteSession(sessionId).catch(() => undefined);
    }
    await client.shutdown().catch(() => undefined);
  }
}
