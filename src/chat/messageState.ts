import * as crypto from "crypto";
import * as vscode from "vscode";
import type { ContentBlock } from "../acp/types";

export type PendingKind = "queue" | "steer";
export interface Staged {
  id: string;
  label: string;
  type: string;
  block: ContentBlock;
}
export interface PendingMessage {
  id: string;
  kind: PendingKind;
  text: string;
  implicit: ContentBlock[];
  attachments: Staged[];
}
export interface ShownAttachment {
  label: string;
  type: string;
  thumb?: string;
}
export interface SentAttachmentRecord {
  key: string;
  messageId?: string;
  text: string;
  attachments: ShownAttachment[];
}
export interface MessageState {
  queued: PendingMessage[];
  sent: SentAttachmentRecord[];
  paused: boolean;
}

// A digest of the exact wire blocks, so a replayed request matches its saved
// record only when every block, in order, is identical.
export function promptKey(blocks: ContentBlock[]): string {
  const content = blocks.map((block) => {
    switch (block.type) {
      case "text": return [block.type, block.text];
      case "image": return [block.type, block.mimeType, block.data];
      case "resource": return [block.type, block.resource.uri, block.resource.mimeType || "", block.resource.text || ""];
      case "resource_link": return [block.type, block.uri, block.name || ""];
    }
  });
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "ENOENT" || code === "FileNotFound";
}

// One ordered queue per file across every controller, so writes to the same
// path commit in call order. The serialized body is captured up front.
const writeTails = new Map<string, Promise<void>>();

function enqueueWrite(file: vscode.Uri, run: () => Promise<void>): Promise<void> {
  const key = file.toString();
  const prev = writeTails.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  writeTails.set(key, next);
  const cleanup = () => {
    if (writeTails.get(key) === next) {
      writeTails.delete(key);
    }
  };
  next.then(cleanup, cleanup);
  return next;
}

async function writeJsonNow(file: vscode.Uri, body: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, ".."));
  const temp = file.with({ path: `${file.path}.${crypto.randomUUID()}.tmp` });
  try {
    await vscode.workspace.fs.writeFile(temp, Buffer.from(body, "utf8"));
    await vscode.workspace.fs.rename(temp, file, { overwrite: true });
  } finally {
    // Only the temporary sibling is cleaned up: a failed write leaves the last
    // committed file in place.
    await vscode.workspace.fs.delete(temp).then(undefined, () => {});
  }
}

export function writeJson(file: vscode.Uri, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  return enqueueWrite(file, () => writeJsonNow(file, body));
}

export function deleteJson(file: vscode.Uri): Promise<void> {
  return enqueueWrite(file, async () => {
    await vscode.workspace.fs.delete(file).then(undefined, (err) => {
      if (!isNotFound(err)) {
        throw err;
      }
    });
  });
}

export async function readJson(file: vscode.Uri): Promise<unknown | undefined> {
  // A queued write commits before the read, so a taking over surface never
  // reads state its predecessor was halfway through replacing.
  const tail = writeTails.get(file.toString());
  if (tail) {
    await tail.then(undefined, () => {});
  }
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (isNotFound(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function flushJsonWrites(): Promise<void> {
  await Promise.allSettled([...writeTails.values()]);
}

// --- Disk shape validation -------------------------------------------------
// The file is a trust boundary: anything that is not exactly a version 1
// snapshot is rejected whole and left in place, never treated as empty.

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function validBlock(block: unknown): block is ContentBlock {
  if (!isRecord(block) || !isString(block.type)) {
    return false;
  }
  switch (block.type) {
    case "text":
      return isString(block.text);
    case "image":
      return isString(block.mimeType) && isString(block.data);
    case "resource": {
      const resource = block.resource;
      if (!isRecord(resource) || !isString(resource.uri)) {
        return false;
      }
      return (resource.mimeType === undefined || isString(resource.mimeType))
        && (resource.text === undefined || isString(resource.text));
    }
    case "resource_link":
      return isString(block.uri)
        && (block.name === undefined || isString(block.name));
    default:
      return false;
  }
}

function validStaged(item: unknown): item is Staged {
  return isRecord(item)
    && isString(item.id) && item.id.length > 0
    && isString(item.label) && item.label.length > 0
    && isString(item.type) && item.type.length > 0
    && validBlock(item.block);
}

function validPending(item: unknown): item is PendingMessage {
  return isRecord(item)
    && isString(item.id) && item.id.length > 0
    && (item.kind === "queue" || item.kind === "steer")
    && isString(item.text) && item.text.length > 0
    && Array.isArray(item.implicit) && item.implicit.every(validBlock)
    && Array.isArray(item.attachments) && item.attachments.every(validStaged);
}

function validShown(item: unknown): item is ShownAttachment {
  if (!isRecord(item)
    || !isString(item.label) || item.label.length === 0
    || !isString(item.type) || item.type.length === 0) {
    return false;
  }
  return item.thumb === undefined
    || (isString(item.thumb) && item.thumb.startsWith("data:image/"));
}

function validSent(item: unknown): item is SentAttachmentRecord {
  return isRecord(item)
    && isString(item.key) && /^[0-9a-f]{64}$/.test(item.key)
    && (item.messageId === undefined || (isString(item.messageId) && item.messageId.length > 0))
    && isString(item.text)
    && Array.isArray(item.attachments) && item.attachments.every(validShown);
}

function parseMessageState(raw: unknown): MessageState {
  if (!isRecord(raw) || raw.version !== 1
    || !Array.isArray(raw.queued) || !raw.queued.every(validPending)
    || !Array.isArray(raw.sent) || !raw.sent.every(validSent)) {
    throw new Error("Saved message state is not a readable version 1 snapshot");
  }
  return { queued: raw.queued, sent: raw.sent, paused: false };
}

// --- Per session store -----------------------------------------------------

interface Entry {
  state: MessageState;
  ready: Promise<MessageState>;
}

export class MessageStateStore {
  private readonly entries = new Map<string, Entry>();
  // Save and remove work per session id, chained so a delete can never be
  // overtaken by a save that was still waiting on the disk read.
  private readonly chains = new Map<string, Promise<void>>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly root: vscode.Uri) {}

  private fileFor(id: string): vscode.Uri {
    const digest = crypto.createHash("sha256").update(id).digest("hex");
    return vscode.Uri.joinPath(this.root, "messages", `${digest}.json`);
  }

  private ensure(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      const state: MessageState = { queued: [], sent: [], paused: false };
      const ready = this.hydrate(id, state);
      // The read may be awaited much later. This keeps its rejection handled
      // until then without swallowing it for the caller.
      ready.catch(() => {});
      entry = { state, ready };
      this.entries.set(id, entry);
    }
    return entry;
  }

  // The live state, hydrated in place once the file has been read, so writes
  // made while the read was in flight are never overwritten.
  get(id: string): MessageState {
    return this.ensure(id).state;
  }

  load(id: string): Promise<MessageState> {
    return this.ensure(id).ready;
  }

  queuedIds(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.state.queued.length > 0)
      .map(([id]) => id);
  }

  private async hydrate(id: string, state: MessageState): Promise<MessageState> {
    const raw = await readJson(this.fileFor(id));
    if (raw === undefined) {
      return state;
    }
    const saved = parseMessageState(raw);
    // Live rows captured during the read win their ids. Saved rows the live
    // state does not already hold come first, live ones after.
    const queuedIds = new Set(state.queued.map((q) => q.id));
    state.queued = [...saved.queued.filter((q) => !queuedIds.has(q.id)), ...state.queued];
    state.sent = [...saved.sent, ...state.sent];
    if (saved.queued.length) {
      // A queue found on disk waits paused until the user asks for it.
      state.paused = true;
    }
    return state;
  }

  // Adopt a state that already lives on a handed over runtime, so no disk
  // read lands on it.
  adopt(id: string, state: MessageState): void {
    this.entries.set(id, { state, ready: Promise.resolve(state) });
  }

  // Drop the entry only, file kept: the state moved to another surface, the
  // session itself is not gone.
  forget(id: string): void {
    this.entries.delete(id);
  }

  // Whether this store still holds the given state object: a late save from
  // a runtime whose state moved on must not write over the current owner's.
  owns(id: string, state: MessageState): boolean {
    return this.entries.get(id)?.state === state;
  }

  private track(id: string, work: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(id) || Promise.resolve();
    const next = prev.then(work, work);
    this.chains.set(id, next);
    this.inflight.add(next);
    const done = () => {
      this.inflight.delete(next);
      if (this.chains.get(id) === next) {
        this.chains.delete(id);
      }
    };
    next.then(done, done);
    // Callers that wait still see the rejection. This only keeps a caller
    // that never waits from tripping the unhandled rejection check.
    next.catch(() => {});
    return next;
  }

  save(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      return Promise.resolve();
    }
    return this.track(id, async () => {
      // A snapshot that failed to read must not be overwritten with the empty
      // state hydration left behind: the rejection propagates instead.
      await entry.ready;
      // The entry may have been forgotten, removed or adopted while the save
      // waited: only the still current entry may write.
      if (this.entries.get(id) !== entry) {
        return;
      }
      await writeJson(this.fileFor(id), { version: 1, queued: entry.state.queued, sent: entry.state.sent });
    });
  }

  remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return this.track(id, async () => {
      // A load still in flight finishes first, so its late hydration cannot
      // race the deletion.
      if (entry) {
        await entry.ready.then(undefined, () => {});
      }
      await deleteJson(this.fileFor(id));
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.ready));
    await Promise.allSettled([...this.inflight]);
    await flushJsonWrites();
  }
}
