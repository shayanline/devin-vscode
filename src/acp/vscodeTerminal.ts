import * as vscode from "vscode";
import { TerminalExitStatus, TerminalRun, TerminalRunner } from "./terminal";

// Runs the agent's commands in a real VS Code terminal, the way Copilot's own
// terminal tool does, rather than in a hidden child process: the same shell the
// user has, with their profile, their environment and their history, and a
// window they can open and take over.
//
// It only works through shell integration, which is what tells us where a
// command started, what it printed, and what it exited with
// (window.onDidStartTerminalShellExecution and friends, finalised in 1.93).
// Shell integration is not always there: an unsupported shell, a profile that
// blocks the injection, or it simply has not activated yet. Everything here is
// therefore allowed to answer "not me", and the caller runs the command itself.

// How long a fresh terminal is given to report shell integration. VS Code waits
// the same 5s when it is injecting it (terminalEnvironment.ts).
const INTEGRATION_MS = 5000;

// A pager turns `git diff` into a command that never returns, and the agent has
// no way to press q.
const PAGERS = { GIT_PAGER: "cat", PAGER: "cat" };

export class VsCodeTerminalRunner implements TerminalRunner {
  private terminal?: vscode.Terminal;
  private ready?: Promise<boolean>;
  // Set once a terminal has come up without shell integration: waiting the full
  // 5s again for every command after that is just a slow way to fail.
  private unsupported = false;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly log?: (line: string) => void
  ) {}

  // Whether the user asked for this at all. Read per command so turning it off
  // takes effect on the next one rather than the next window.
  private enabled(): boolean {
    return vscode.workspace.getConfiguration("devin").get<boolean>("useIntegratedTerminal", true);
  }

  async run(command: string, cwd: string | undefined, onData: (text: string) => void): Promise<TerminalRun | undefined> {
    // A command with its own working directory is not this terminal's command:
    // the session terminal keeps its own cwd across calls, as VS Code's does.
    if (!this.enabled() || this.unsupported || (cwd && cwd !== this.cwd)) {
      return undefined;
    }
    // Shell integration reports one command per line, so a script fed in as a
    // single string never reports its end (microsoft/vscode#250764).
    if (/[\r\n]/.test(command)) {
      return undefined;
    }
    const terminal = await this.terminalWithIntegration();
    const integration = terminal?.shellIntegration;
    if (!terminal || !integration) {
      this.unsupported = !!terminal;
      this.log?.("[terminal] no shell integration, running the command directly instead");
      return undefined;
    }

    const execution = integration.executeCommand(command);
    // read() only yields what arrives after the first call, so it has to be the
    // very next thing that happens.
    const stream = execution.read();
    const clean = new OutputCleaner(onData);
    let settle: (status: TerminalExitStatus) => void = () => {};
    const exit = new Promise<TerminalExitStatus>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const finish = (status: TerminalExitStatus) => {
      if (done) {
        return;
      }
      done = true;
      clean.flush();
      listeners.forEach((l) => l.dispose());
      settle(status);
    };
    const listeners = [
      vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          finish({ exitCode: e.exitCode ?? null, signal: null });
        }
      }),
      // The terminal being closed under a running command is that command's end,
      // and without this the agent waits on it for ever.
      vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          this.terminal = undefined;
          this.ready = undefined;
          finish({ exitCode: null, signal: "SIGHUP" });
        }
      })
    ];
    void (async () => {
      try {
        for await (const chunk of stream) {
          clean.write(chunk);
        }
      } catch {
        // The stream ends with the terminal; the exit is settled either way.
      }
    })();

    return {
      exit,
      show: () => terminal.show(false),
      // Ctrl+C into the real terminal, which is what a user would press. The
      // terminal itself stays, since it is the session's.
      kill: () => terminal.sendText("\u0003", false)
    };
  }

  private async terminalWithIntegration(): Promise<vscode.Terminal | undefined> {
    if (!this.terminal || this.terminal.exitStatus) {
      this.terminal = vscode.window.createTerminal({
        name: "Devin",
        iconPath: new vscode.ThemeIcon("sparkle"),
        cwd: this.cwd,
        env: { ...PAGERS },
        // Out of the way until it is wanted: the chat shows the output, and the
        // Show Terminal action is what brings this one up.
        hideFromUser: true,
        isTransient: true
      });
      this.ready = undefined;
    }
    const terminal = this.terminal;
    if (terminal.shellIntegration) {
      return terminal;
    }
    this.ready = this.ready || waitForIntegration(terminal);
    await this.ready;
    return terminal;
  }

  dispose(): void {
    this.terminal?.dispose();
    this.terminal = undefined;
  }
}

function waitForIntegration(terminal: vscode.Terminal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, INTEGRATION_MS);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      }
    });
  });
}

// A terminal writes for a screen, not for a transcript: escape sequences that
// colour and move the cursor, and carriage returns that redraw a line in place
// (every progress bar). Reading the stream rather than the screen means undoing
// that here, line by line, so a download that redrew itself two thousand times
// is the one line it ended on.
export class OutputCleaner {
  private pending = "";

  constructor(private readonly emit: (text: string) => void) {}

  write(chunk: string): void {
    this.pending += stripAnsi(chunk).replace(/\r\n/g, "\n");
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    if (lines.length) {
      this.emit(lines.map(lastDraw).join("\n") + "\n");
    }
  }

  // Whatever is left when the command ends, which is a prompt line with no
  // newline after it more often than not.
  flush(): void {
    const left = lastDraw(this.pending);
    this.pending = "";
    if (left) {
      this.emit(left + "\n");
    }
  }
}

// What a line looked like after the last time it was drawn.
function lastDraw(line: string): string {
  if (line.indexOf("\r") === -1) {
    return line;
  }
  const draws = line.split("\r").filter((d) => d.length);
  return draws.length ? draws[draws.length - 1] : "";
}

// VS Code's own removeAnsiEscapeCodes (base/common/strings.ts), which is the
// list of sequences a shell really emits.
const CSI = /(?:\x1b\[|\x9b)[=?>!]?[\d;:]*["$#'* ]?[a-zA-Z@^`{}|~]/;
const OSC = /(?:\x1b\]|\x9d).*?(?:\x1b\\|\x07|\x9c)/;
const ESC = /\x1b(?:[ #%()*+\-./]?[a-zA-Z0-9|}~@])/;
const CONTROL = new RegExp(`(?:${CSI.source}|${OSC.source}|${ESC.source})`, "g");

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(CONTROL, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
