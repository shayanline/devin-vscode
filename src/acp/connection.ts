import { ChildProcessWithoutNullStreams } from "child_process";

// A minimal JSON-RPC 2.0 connection over a child process' stdio, using
// newline-delimited JSON framing (as spoken by `devin acp`).

type RpcId = number;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcConnection {
  private nextId: RpcId = 1;
  private readonly pending = new Map<RpcId, PendingCall>();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onRequest: RequestHandler,
    private readonly onNotification: NotificationHandler,
    private readonly onLog?: (line: string) => void
  ) {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.onLog?.(chunk.toString()));
    this.child.on("close", () => this.handleClose());
    // Without listeners, a stream `error` (e.g. EPIPE on stdin after the agent
    // dies) is thrown as an unhandled error and can crash the extension host.
    this.child.stdin.on("error", (err) => this.onLog?.(`[stdin-error] ${err.message}`));
    this.child.stdout.on("error", (err) => {
      this.onLog?.(`[stdout-error] ${err.message}`);
      this.handleClose();
    });
    this.child.stderr.on("error", (err) => this.onLog?.(`[stderr-error] ${err.message}`));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) {
        continue;
      }
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onLog?.(`[non-json] ${line}`);
      return;
    }

    if (msg.id !== undefined && msg.method !== undefined) {
      // Request from the agent to us.
      this.handleIncomingRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      // Response to a call we made.
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || "RPC error") as Error & { code?: number; data?: unknown };
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method !== undefined) {
      // Notification from the agent.
      this.onNotification(msg.method, msg.params);
    }
  }

  private async handleIncomingRequest(msg: any): Promise<void> {
    try {
      const result = await this.onRequest(msg.method, msg.params);
      this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) }
      });
    }
  }

  // `timeoutMs` bounds the wait. Every call the client makes passes one except a prompt,
  // and a test reads that rule off its source. A reply is otherwise only settled by the
  // agent answering or its process closing, so an agent that is alive and silent (a
  // blocking MCP server, a token refresh) leaves the caller waiting for the rest of the
  // window. It is not the default here because a prompt is a whole turn and can
  // legitimately run for many minutes.
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("ACP connection is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const clear = (): void => {
        if (timer) {
          clearTimeout(timer);
        }
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (v: unknown) => { clear(); resolve(v as T); },
        reject: (e: unknown) => { clear(); reject(e); }
      });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.onLog?.(`[rpc-timeout] ${method} after ${timeoutMs}ms`);
          clear();
          reject(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref?.();
      }
      // If the write fails the response can never arrive, so settle the call
      // now rather than leaving it pending forever.
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        clear();
        reject(new Error("Failed to write to ACP process"));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): boolean {
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
      return true;
    } catch (err) {
      this.onLog?.(`[send-failed] ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("ACP process exited"));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
  }
}
