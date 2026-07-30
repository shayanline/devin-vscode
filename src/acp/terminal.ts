import { spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

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

    // The agent sends either a program + args (run it directly) or, more often,
    // a full shell command line as `command` with no args (e.g. `cd x && ls`).
    // Running that string directly fails with ENOENT — there is no program by
    // that name — so a compound command surfaces as "Command failed". Run the
    // no-args form through a shell, the way a real terminal does, so cd, &&,
    // pipes, globs and quoting all work.
    const win = process.platform === "win32";
    const hasArgs = Array.isArray(params.args) && params.args.length > 0;
    let file: string;
    let args: string[];
    if (hasArgs) {
      file = params.command;
      args = params.args as string[];
    } else if (win) {
      file = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", params.command];
    } else {
      file = this.baseEnv.SHELL || "/bin/bash";
      args = ["-c", params.command];
    }

    const child = spawn(file, args, {
      cwd: params.cwd || this.defaultCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group (POSIX) so we can signal the shell and everything it
      // spawns on kill/release, rather than orphaning children.
      detached: !win
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

    const append = (text: string) => {
      term.output += text;
      while (Buffer.byteLength(term.output, "utf8") > term.limit) {
        term.truncated = true;
        term.output = term.output.slice(Math.ceil(term.output.length * 0.1) || 1);
      }
      this.onOutput?.(terminalId, term.output, term.exitStatus);
    };

    // Decode each stream through its own StringDecoder so a multi-byte UTF-8
    // sequence split across chunk boundaries is not corrupted.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => append(outDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => append(errDecoder.write(chunk)));
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
    if (!term || term.exitStatus) {
      return;
    }
    const pid = term.child.pid;
    try {
      // Signal the whole group (negative pid) so the shell and its children go
      // down together; fall back to the direct child if that is not possible.
      if (process.platform !== "win32" && pid) {
        process.kill(-pid, "SIGTERM");
      } else {
        term.child.kill();
      }
    } catch {
      try {
        term.child.kill();
      } catch {
        // already gone
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
