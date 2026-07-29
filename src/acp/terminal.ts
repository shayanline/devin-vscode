import { spawn, ChildProcess } from "child_process";

export interface EnvVariable {
  name: string;
  value: string;
}

export interface CreateTerminalParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: EnvVariable[];
  cwd?: string;
  outputByteLimit?: number;
}

export interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface Term {
  child: ChildProcess;
  output: string;
  limit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  waiters: ((status: TerminalExitStatus) => void)[];
}

// Runs shell commands on behalf of the agent and exposes the ACP terminal
// methods (create/output/wait_for_exit/kill/release). Output is buffered and
// trimmed to the requested byte limit; each change is streamed to a listener
// so the chat can render live output.
export class TerminalManager {
  private readonly terminals = new Map<string, Term>();
  private seq = 0;

  constructor(
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly defaultCwd: string,
    private readonly onOutput?: (terminalId: string, output: string, exitStatus: TerminalExitStatus | null) => void,
    private readonly log?: (line: string) => void
  ) {}

  create(params: CreateTerminalParams): { terminalId: string } {
    const terminalId = `term-${++this.seq}`;
    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    for (const e of params.env || []) {
      env[e.name] = e.value;
    }
    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || this.defaultCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const term: Term = {
      child,
      output: "",
      limit: params.outputByteLimit && params.outputByteLimit > 0 ? params.outputByteLimit : 1_048_576,
      truncated: false,
      exitStatus: null,
      waiters: []
    };
    this.terminals.set(terminalId, term);

    const append = (chunk: Buffer) => {
      term.output += chunk.toString("utf8");
      while (Buffer.byteLength(term.output, "utf8") > term.limit) {
        term.truncated = true;
        term.output = term.output.slice(Math.ceil(term.output.length * 0.1) || 1);
      }
      this.onOutput?.(terminalId, term.output, term.exitStatus);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      term.output += `\n[spawn error] ${err.message}\n`;
      this.onOutput?.(terminalId, term.output, term.exitStatus);
    });
    child.on("close", (code, signal) => {
      term.exitStatus = { exitCode: code, signal: signal ? String(signal) : null };
      for (const w of term.waiters.splice(0)) {
        w(term.exitStatus);
      }
      this.onOutput?.(terminalId, term.output, term.exitStatus);
      this.log?.(`[terminal] ${terminalId} exited code=${code} signal=${signal || ""}`);
    });

    this.log?.(`[terminal] ${terminalId} start: ${params.command} ${(params.args || []).join(" ")}`);
    return { terminalId };
  }

  output(terminalId: string): { output: string; truncated: boolean; exitStatus: TerminalExitStatus | null } {
    const term = this.terminals.get(terminalId);
    if (!term) {
      return { output: "", truncated: false, exitStatus: null };
    }
    return { output: term.output, truncated: term.truncated, exitStatus: term.exitStatus };
  }

  waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const term = this.terminals.get(terminalId);
    if (!term) {
      return Promise.resolve({ exitCode: null, signal: null });
    }
    if (term.exitStatus) {
      return Promise.resolve(term.exitStatus);
    }
    return new Promise((resolve) => term.waiters.push(resolve));
  }

  kill(terminalId: string): void {
    const term = this.terminals.get(terminalId);
    if (term && !term.exitStatus) {
      try {
        term.child.kill();
      } catch {
        // ignore
      }
    }
  }

  release(terminalId: string): void {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
  }

  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
  }
}
