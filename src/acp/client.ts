import { spawn, ChildProcessWithoutNullStreams } from "child_process";
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
  writeTextFile(params: WriteTextFileParams): Promise<null>;
  createElicitation(params: unknown): Promise<unknown>;
  createTerminal(params: CreateTerminalParams): { terminalId: string };
  terminalOutput(params: TerminalRef): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null };
  waitForTerminalExit(params: TerminalRef): Promise<TerminalExitStatus>;
  killTerminal(params: TerminalRef): null;
  releaseTerminal(params: TerminalRef): null;
}

// Emitted events:
//  "update"  -> SessionUpdateNotification
//  "log"     -> string
//  "exit"    -> void
export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private conn?: JsonRpcConnection;
  private host?: AcpHost;
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
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    child.on("error", (err) => this.emit("log", `[spawn-error] ${err.message}`));
    child.on("close", (code) => {
      this.emit("log", `[acp-exit] code=${code}`);
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
        // Unknown/custom client method: reply with null to keep the agent moving.
        this.emit("log", `[unhandled-request] ${method}`);
        return null;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.emit("update", params as SessionUpdateNotification);
      return;
    }
    // Devin custom notifications (logs, mcp status) start with `_cognition.ai/`.
    this.emit("log", `[notify] ${method}`);
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
        _meta: { "cognition.ai/revert": true }
      }
    });
    this.initializeResult = result;
    return result;
  }

  // True when the agent acknowledged the revert capability.
  supportsRevert(): boolean {
    const meta = this.initializeResult?.agentCapabilities?._meta as Record<string, unknown> | undefined;
    return meta?.["cognition.ai/revert"] === true;
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.rpc("authenticate", { methodId });
  }

  newSession(additionalDirectories: string[] = [], mcpServers: unknown[] = []): Promise<NewSessionResult> {
    return this.rpc<NewSessionResult>("session/new", {
      cwd: this.options.cwd,
      mcpServers,
      ...(additionalDirectories.length ? { additionalDirectories } : {})
    });
  }

  loadSession(sessionId: string, additionalDirectories: string[] = [], mcpServers: unknown[] = []): Promise<unknown> {
    return this.rpc("session/load", {
      sessionId,
      cwd: this.options.cwd,
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
    try {
      await this.revertPreview(sessionId, Number.MAX_SAFE_INTEGER);
      return null; // unexpected success (no error to parse)
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

  dispose(): void {
    this.conn?.dispose();
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
  }
}
