// Minimal stand-in for the `vscode` module, enough to load src/diff/changeTracker.ts
// outside VS Code so its keep/undo semantics can be tested. Only the API the
// tracker actually touches is implemented.

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== fn); } };
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners = [];
  }
}

const nodeFs = require("fs");
const nodePath = require("path");

const Uri = {
  file: (p) => ({ scheme: "file", path: p, fsPath: p, query: "", toString: () => "file://" + p }),
  from: ({ scheme, path: p, query }) => ({ scheme, path: p, fsPath: p, query: query || "", toString: () => `${scheme}://${p}?${query}` }),
  joinPath: (base, ...parts) => Uri.file(nodePath.join(base.fsPath, ...parts))
};

const Disposable = { from: (...items) => ({ dispose: () => items.forEach((i) => i.dispose && i.dispose()) }) };

const commands = {
  registered: new Map(),
  registerCommand(id, fn) {
    commands.registered.set(id, fn);
    return { dispose: () => commands.registered.delete(id) };
  },
  executeCommand: async () => undefined
};

// Enough of `workspace.fs` for the working set to be written and read back, which
// is how it survives a window reload.
const workspace = {
  registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
  // Every resolution of a virtual document is recorded, so a test can prove the
  // original is only ever created once however many times it is asked for. The
  // record lives on the global because this stub is bundled into the module under
  // test, so the test file holds a different copy of it.
  openTextDocument: async (uri) => {
    (globalThis.__dvOpened = globalThis.__dvOpened || []).push(uri.toString());
    return { uri };
  },
  fs: {
    readFile: async (uri) => nodeFs.promises.readFile(uri.fsPath),
    writeFile: async (uri, body) => nodeFs.promises.writeFile(uri.fsPath, body),
    createDirectory: async (uri) => nodeFs.promises.mkdir(uri.fsPath, { recursive: true }),
    delete: async (uri) => nodeFs.promises.rm(uri.fsPath)
  }
};

const scm = {
  createSourceControl: () => ({
    quickDiffProvider: undefined,
    createResourceGroup: () => ({ resourceStates: [], dispose: () => {} }),
    dispose: () => {}
  })
};

// Enough of the terminal API to drive src/acp/vscodeTerminal.ts: a test builds a
// fake terminal, decides whether it reports shell integration, and pushes chunks
// into the execution's stream. `window.terminals` is what a test inspects.
const shellIntegrationChanged = new EventEmitter();
const shellExecutionEnded = new EventEmitter();
const terminalClosed = new EventEmitter();

const window = {
  terminals: [],
  createTerminal(options) {
    const terminal = {
      options,
      shown: 0,
      sent: [],
      shellIntegration: undefined,
      exitStatus: undefined,
      show: () => { terminal.shown++; },
      sendText: (t) => terminal.sent.push(t),
      dispose: () => { terminal.exitStatus = { code: 0 }; terminalClosed.fire(terminal); }
    };
    window.terminals.push(terminal);
    return terminal;
  },
  onDidChangeTerminalShellIntegration: shellIntegrationChanged.event,
  onDidEndTerminalShellExecution: shellExecutionEnded.event,
  onDidCloseTerminal: terminalClosed.event,
  // Test-side helpers, not part of the real API.
  __fire: { shellIntegrationChanged, shellExecutionEnded, terminalClosed }
};

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

// Same numbering as VS Code, which the diagnostics mapper compares against.
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

const languages = {
  diagnostics: new Map(),
  getDiagnostics: (uri) => (uri ? languages.diagnostics.get(uri.fsPath) || [] : [...languages.diagnostics])
};

workspace.getConfiguration = () => ({
  get: (_key, fallback) => (globalThis.__dvConfig && _key in globalThis.__dvConfig ? globalThis.__dvConfig[_key] : fallback),
  update: async () => undefined
});

module.exports = { EventEmitter, Uri, Disposable, commands, workspace, scm, window, ThemeIcon, DiagnosticSeverity, languages };

// The module under test is bundled with its own copy of this stub, so a test
// that requires it directly would be holding a different one. The copy the
// bundle loaded is published here, and that is the one to drive.
globalThis.__dvVscode = module.exports;
