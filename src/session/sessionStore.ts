import * as vscode from "vscode";

// Tracks which Devin session ids belong to the current VS Code window.
// `workspaceState` is automatically scoped per `.code-workspace` file and per
// folder, so CRM and Outreach workspaces keep separate lists for free.
export class SessionStore {
  private static readonly IDS_KEY = "devin.sessionIds.v1";
  private static readonly ACTIVE_KEY = "devin.activeSession.v1";

  constructor(private readonly state: vscode.Memento) {}

  ids(): string[] {
    return this.state.get<string[]>(SessionStore.IDS_KEY, []);
  }

  add(id: string): void {
    if (!id) {
      return;
    }
    const ids = this.ids().filter((x) => x !== id);
    ids.unshift(id);
    void this.state.update(SessionStore.IDS_KEY, ids.slice(0, 200));
  }

  remove(id: string): void {
    void this.state.update(SessionStore.IDS_KEY, this.ids().filter((x) => x !== id));
    if (this.activeId() === id) {
      this.setActive(undefined);
    }
  }

  has(id: string): boolean {
    return this.ids().includes(id);
  }

  activeId(): string | undefined {
    return this.state.get<string | undefined>(SessionStore.ACTIVE_KEY, undefined);
  }

  setActive(id: string | undefined): void {
    void this.state.update(SessionStore.ACTIVE_KEY, id);
  }
}
