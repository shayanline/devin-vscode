import { spawn, execFile, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { JsonRpcConnection } from "./connection";
import {
  ContentBlock,
  CreateTerminalParams,
  InitializeResult,
  NewSessionResult,
  PromptResult,
  ReadTextFileParams,
  RequestPermissionParams,
  RequestPermissionResult,
  RevertPreviewResult,
  SessionUpdateNotification,
  TerminalExitStatus,
  TerminalRef,
  WriteTextFileParams
} from "./types";

export interface AcpClientOptions {
  cliPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}

// Callbacks the host (extension) provides so the client can serve the
// agent's client-side requests (permissions, file reads/writes, questions).
export interface AcpHost {
  requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
  readTextFile(params: ReadTextFileParams): Promise<{ content: string }>;
  writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>>;
  createElicitation(params: unknown): Promise<unknown>;
  createTerminal(params: CreateTerminalParams): { terminalId: string };
  terminalOutput(params: TerminalRef): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null };
  waitForTerminalExit(params: TerminalRef): Promise<TerminalExitStatus>;
  killTerminal(params: TerminalRef): Record<string, never>;
  releaseTerminal(params: TerminalRef): Record<string, never>;
}

// Emitted events:
//  "update"  -> SessionUpdateNotification
//  "log"     -> string
//  "exit"    -> void
export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private conn?: JsonRpcConnection;
  private host?: AcpHost;
  private exited = false;
  initializeResult?: InitializeResult;

  constructor(private readonly options: AcpClientOptions) {
    super();
  }

  setHost(host: AcpHost): void {
    this.host = host;
  }

  start(): void {
    const args = ["acp", ...(this.options.extraArgs || [])];
    const child = spawn(this.options.cliPath, args, {
      cwd: this.options.cwd,
      env: this.options.env ? { ...this.options.env } : { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so we can signal the whole tree (the agent spawns
      // MCP servers as children that do NOT die when only the agent is killed).
      detached: process.platform !== "win32"
    }) as ChildProcessWithoutNullStreams;

    child.on("error", (err) => this.emit("log", `[spawn-error] ${err.message}`));
    child.on("close", (code) => {
      this.exited = true;
      this.emit("log", `[acp-exit] code=${code}`);
      // Reap any MCP children that outlived the agent.
      this.killTree("SIGKILL");
      this.emit("exit");
    });

    this.child = child;
    this.conn = new JsonRpcConnection(
      child,
      (method, params) => this.handleRequest(method, params),
      (method, params) => this.handleNotification(method, params),
      (line) => this.emit("log", line)
    );
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.host) {
      throw new Error("No ACP host registered");
    }
    switch (method) {
      case "session/request_permission":
        return this.host.requestPermission(params as RequestPermissionParams);
      case "fs/read_text_file":
        return this.host.readTextFile(params as ReadTextFileParams);
      case "fs/write_text_file":
        return this.host.writeTextFile(params as WriteTextFileParams);
      // Devin sends the Cognition-custom `_session/elicitation`; keep the
      // standard MCP `elicitation/create` name working too.
      case "_session/elicitation":
      case "elicitation/create":
        return this.host.createElicitation(params);
      case "terminal/create":
        return this.host.createTerminal(params as CreateTerminalParams);
      case "terminal/output":
        return this.host.terminalOutput(params as TerminalRef);
      case "terminal/wait_for_exit":
        return this.host.waitForTerminalExit(params as TerminalRef);
      case "terminal/kill":
        return this.host.killTerminal(params as TerminalRef);
      case "terminal/release":
        return this.host.releaseTerminal(params as TerminalRef);
      default:
        // Unknown/custom client method: reply with an empty object to keep the
        // agent moving (a bare null can trip its response parser).
        this.emit("log", `[unhandled-request] ${method}`);
        return {};
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.emit("update", params as SessionUpdateNotification);
      return;
    }
    // Devin custom notifications (logs, mcp status) start with `_cognition.ai/`.
    // Log a small payload preview so their shape can be inspected in the Output
    // channel (used to decide what to surface in the UI, e.g. MCP start /
    // interaction lines).
    let preview = "";
    try {
      const s = JSON.stringify(params);
      if (s) {
        preview = " " + (s.length > 300 ? s.slice(0, 300) + "\u2026" : s);
      }
    } catch {
      // ignore non-serialisable payloads
    }
    this.emit("log", `[notify] ${method}${preview}`);
  }

  async initialize(): Promise<InitializeResult> {
    const result = await this.rpc<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        elicitation: { form: {}, url: {} },
        // Unlocks the _cognition.ai/revert/* methods (conversation rewind +
        // file undo). Verified against devin acp.
        _meta: {
          "cognition.ai/revert": true,
          // Streams a subagent's own tool calls, messages and thoughts tagged
          // with `subagent_context`, plus the `subagent_started` /
          // `subagent_completed` lifecycle. Without it only the subagent's
          // opening tool_call arrives, so its rows never leave pending.
          "cognition.ai/subagentSupport": true,
          // Unlocks _cognition.ai/subagent/{background,foreground}.
          "cognition.ai/subagentControl": true
        }
      }
    });
    this.initializeResult = result;
    return result;
  }

  // True when the agent acknowledged the revert capability.
  supportsRevert(): boolean {
    return this.agentCapability("cognition.ai/revert");
  }

  // True when the agent accepts _cognition.ai/subagent/{background,foreground}.
  supportsSubagentControl(): boolean {
    return this.agentCapability("cognition.ai/subagentControl");
  }

  private agentCapability(key: string): boolean {
    const meta = this.initializeResult?.agentCapabilities?._meta as Record<string, unknown> | undefined;
    return meta?.[key] === true;
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.rpc("authenticate", { methodId });
  }

  newSession(cwd: string, additionalDirectories: string[] = [], mcpServers: unknown[] = []): Promise<NewSessionResult> {
    return this.rpc<NewSessionResult>("session/new", {
      cwd: cwd || this.options.cwd,
      mcpServers,
      ...(additionalDirectories.length ? { additionalDirectories } : {})
    });
  }

  loadSession(
    sessionId: string,
    cwd: string,
    additionalDirectories: string[] = [],
    mcpServers: unknown[] = []
  ): Promise<unknown> {
    return this.rpc("session/load", {
      sessionId,
      cwd: cwd || this.options.cwd,
      mcpServers,
      ...(additionalDirectories.length ? { additionalDirectories } : {})
    });
  }

  prompt(sessionId: string, blocks: ContentBlock[]): Promise<PromptResult> {
    return this.rpc<PromptResult>("session/prompt", { sessionId, prompt: blocks });
  }

  cancel(sessionId: string): void {
    this.conn?.notify("session/cancel", { sessionId });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.rpc("session/set_mode", { sessionId, modeId });
  }

  renameSession(sessionId: string, title: string): Promise<unknown> {
    return this.rpc("_cognition.ai/session/rename", { sessionId, title });
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.rpc("session/delete", { sessionId });
  }

  // Devin exposes both `mode` and `model` as config options set through this
  // custom method: { sessionId, configId, value }.
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.rpc("session/set_config_option", { sessionId, configId, value });
  }

  // --- Subagents -----------------------------------------------------------
  // Move a running subagent between foreground (the parent waits, and tool
  // calls prompt for approval) and background (the parent carries on, and
  // unapproved tools are denied). There is no ACP method to cancel one.
  subagentBackground(sessionId: string, agentId: string): Promise<unknown> {
    return this.rpc("_cognition.ai/subagent/background", { sessionId, agentId });
  }

  subagentForeground(sessionId: string, agentId: string): Promise<unknown> {
    return this.rpc("_cognition.ai/subagent/foreground", { sessionId, agentId });
  }

  // --- Revert (conversation rewind + file undo) ---------------------------
  // Preview what reverting to `targetNodeId` would do, without mutating.
  revertPreview(sessionId: string, targetNodeId: number, opts?: { force?: boolean; skipFileUndo?: boolean }): Promise<RevertPreviewResult> {
    return this.rpc<RevertPreviewResult>("_cognition.ai/revert/preview", {
      sessionId,
      targetNodeId,
      force: opts?.force ?? false,
      skipFileUndo: opts?.skipFileUndo ?? false
    });
  }

  // Execute the rewind: truncate the conversation back to `targetNodeId` and
  // undo the file edits made from that node onward (unless skipFileUndo).
  revertExecute(sessionId: string, targetNodeId: number, opts?: { force?: boolean; skipFileUndo?: boolean }): Promise<unknown> {
    return this.rpc("_cognition.ai/revert/execute", {
      sessionId,
      targetNodeId,
      force: opts?.force ?? true,
      skipFileUndo: opts?.skipFileUndo ?? false
    });
  }

  // The agent does not surface node ids in the stream, so we read the current
  // head by probing preview with an out-of-range target and parsing the error
  // ("...from head H..."). Returns the head node id, or null when the session
  // has no revertible history yet.
  async currentHead(sessionId: string): Promise<number | null> {
    // Node 0 is always off the expanded chain (the chain starts at the session
    // prefix), so preview rejects with "...from head H...", which we parse.
    // A session with no revertible history yet reports no head -> null.
    try {
      await this.revertPreview(sessionId, 0);
      return null;
    } catch (err) {
      const data = (err as { data?: unknown }).data;
      const text = typeof data === "string" ? data : (err instanceof Error ? err.message : String(err));
      const m = /from head (\d+)/.exec(text);
      return m ? Number(m[1]) : null;
    }
  }

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.conn) {
      return Promise.reject(new Error("ACP connection not started"));
    }
    return this.conn.request<T>(method, params);
  }

  // Stop the agent while this extension host stays alive (terminating one
  // session, a failed start). Fire and forget: the follow-up SIGKILL runs on a
  // timer, which is only reliable because we are still here to fire it. Use
  // `shutdown()` on the way out instead.
  dispose(): void {
    this.conn?.dispose();
    // SIGTERM the whole group (lets the agent + docker-based MCP shut down
    // cleanly), then SIGKILL any stragglers shortly after.
    this.killTree("SIGTERM");
    const pid = this.child?.pid;
    if (pid) {
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }, 1500).unref?.();
    }
  }

  // Stop the agent for good and resolve only once it is really gone, so a caller
  // that is shutting the extension down can await it rather than racing the
  // host's exit (a `setTimeout` escalation never fires once the host is gone).
  //
  // Escalates within `timeoutMs`: closing stdin is a clean EOF most stdio agents
  // exit on, then SIGTERM the process group so docker-backed MCP servers get to
  // tidy up, then SIGKILL. Any turn should be cancelled by the caller first.
  async shutdown(timeoutMs = 800): Promise<void> {
    if (!this.child || this.exited) {
      this.conn?.dispose();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    this.conn?.dispose();
    if (await this.waitForExit(Math.round(timeoutMs * 0.5))) {
      return;
    }
    this.killTree("SIGTERM");
    if (await this.waitForExit(deadline - Date.now())) {
      return;
    }
    this.emit("log", "[acp-shutdown] agent ignored SIGTERM, killing");
    this.killTree("SIGKILL");
    await this.waitForExit(150);
  }

  // Resolves true once the process has closed, false if `ms` runs out first.
  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) {
      return Promise.resolve(true);
    }
    if (ms <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off("exit", done);
        resolve(this.exited);
      }, ms);
      this.once("exit", done);
    });
  }

  // Signal the agent's entire process tree: its process group on POSIX, or
  // taskkill on Windows, which has no groups (so a plain child.kill there would
  // strand the MCP servers the agent spawned).
  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) {
      return;
    }
    if (process.platform === "win32") {
      try {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
      } catch {
        // taskkill missing; fall through to the direct kill below
      }
      try {
        this.child?.kill();
      } catch {
        // already gone
      }
      return;
    }
    try {
      process.kill(-pid, signal); // negative pid => process group
    } catch {
      try {
        this.child?.kill(signal);
      } catch {
        // ignore
      }
    }
  }
}
