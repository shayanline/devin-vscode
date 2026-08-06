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

const Uri = {
  file: (p) => ({ scheme: "file", path: p, fsPath: p, query: "", toString: () => "file://" + p }),
  from: ({ scheme, path: p, query }) => ({ scheme, path: p, fsPath: p, query: query || "", toString: () => `${scheme}://${p}?${query}` })
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

const workspace = {
  registerTextDocumentContentProvider: () => ({ dispose: () => {} })
};

const scm = {
  createSourceControl: () => ({
    quickDiffProvider: undefined,
    createResourceGroup: () => ({ resourceStates: [], dispose: () => {} }),
    dispose: () => {}
  })
};

module.exports = { EventEmitter, Uri, Disposable, commands, workspace, scm };
