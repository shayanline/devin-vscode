import * as vscode from "vscode";

// Tracks which Devin session ids belong to the current VS Code window.
// `workspaceState` is automatically scoped per `.code-workspace` file and per
// folder, so CRM and Outreach workspaces keep separate lists for free.
export class SessionStore {
  private static readonly IDS_KEY = "devin.sessionIds.v1";
  private static readonly ACTIVE_KEY = "devin.activeSession.v1";
  private static readonly TITLES_KEY = "devin.sessionTitles.v1";
  private static readonly OPTIONS_KEY = "devin.options.v1";

  constructor(private readonly state: vscode.Memento) {}

  // Cache the last-known mode/model options so the composer dropdowns are
  // populated immediately on open, before any session exists.
  options(): unknown | undefined {
    return this.state.get<unknown>(SessionStore.OPTIONS_KEY, undefined);
  }

  cacheOptions(payload: unknown): void {
    void this.state.update(SessionStore.OPTIONS_KEY, payload);
  }

  titles(): Record<string, string> {
    return this.state.get<Record<string, string>>(SessionStore.TITLES_KEY, {});
  }

  // Remember titles so names show instantly on reopen, before `devin list`
  // has returned (or for sessions no longer in a listed directory).
  cacheTitles(map: Record<string, string>): void {
    const current = this.titles();
    let changed = false;
    for (const [id, title] of Object.entries(map)) {
      if (title && current[id] !== title) {
        current[id] = title;
        changed = true;
      }
    }
    if (changed) {
      void this.state.update(SessionStore.TITLES_KEY, current);
    }
  }

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
