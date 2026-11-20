/**
 * Preferences › PCB Editor › Models: the folders of STEP models. A 3D body that links its
 * model instead of carrying it in the board is shown from the first file of that name found in
 * the board's project folder or in these folders [est: AD finds a linked model by its path; on
 * another computer Konium goes by the file's name]. The folders are remembered in this browser
 * (IndexedDB); one from an earlier session is read again once the browser allows it.
 */
import { signal } from '@preact/signals';
import { Emitter } from '../core/events';
import { hasFolderAccess, listFolder, openFiles } from './fs';
import { adoptFormerDb } from './formerDb';

export interface ModelFolder {
  name: string;
  handle?: FileSystemDirectoryHandle;
  /** STEP files by lower-case name: a handle (read when wanted) or the bytes (picked files). */
  files: Map<string, FileSystemFileHandle | Uint8Array>;
  /** ask: remembered, the browser wants a click before it is read again. */
  state: 'ready' | 'ask' | 'reading';
}

export const modelFolders = signal<ModelFolder[]>([]);
/** The folders (or their contents) changed: 3D views look again for the models they missed. */
export const modelFoldersChanged = new Emitter<void>();

const STEP = /\.(step|stp)$/i;
/** "C:\Models\Part.STEP" → "part.step". */
export const modelFileName = (p: string): string => (p.split(/[\\/]/).pop() ?? '').trim().toLowerCase();

/** Every STEP file under a folder (a few levels down). */
export async function stepFilesIn(dir: FileSystemDirectoryHandle, depth = 6): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  const walk = async (d: FileSystemDirectoryHandle, level: number) => {
    for (const e of await listFolder(d)) {
      try {
        if (e.kind === 'file' && STEP.test(e.name)) { if (!out.has(e.name.toLowerCase())) out.set(e.name.toLowerCase(), e.handle as FileSystemFileHandle); }
        else if (e.kind === 'directory' && level < depth && !/^(History|__Previews|\.)/i.test(e.name)) await walk(e.handle as FileSystemDirectoryHandle, level + 1);
      } catch { /* unreadable: left out */ }
    }
  };
  await walk(dir, 0);
  return out;
}

/* ── remembered folders (IndexedDB) ── */
const DB = 'konium-models', STORE = 'folders';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    let fresh = false;
    r.onupgradeneeded = (e) => { fresh = e.oldVersion === 0; r.result.createObjectStore(STORE, { keyPath: 'name' }); };
    // Made just now: what the app kept under its earlier name copied in first
    r.onsuccess = () => { if (fresh) void adoptFormerDb(r.result).finally(() => ok(r.result)); else ok(r.result); };
    r.onerror = () => fail(r.error);
  });
}
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((ok, fail) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  } finally { d.close(); }
}

type Perm = FileSystemHandle & { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };

function put(f: ModelFolder): void {
  modelFolders.value = [...modelFolders.value.filter((x) => x.name !== f.name), f].sort((a, b) => a.name.localeCompare(b.name));
  modelFoldersChanged.emit();
}

async function read(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
  put({ name, handle, files: new Map(), state: 'reading' });
  const files = await stepFilesIn(handle).catch(() => new Map<string, FileSystemFileHandle>());
  put({ name, handle, files, state: 'ready' });
}

let restored = false;
/** The folders remembered from earlier sessions: read now where the browser still allows it. */
export async function restoreModelFolders(): Promise<void> {
  if (restored || typeof indexedDB === 'undefined') return;
  restored = true;
  try {
    const rows = await store<{ name: string; handle: FileSystemDirectoryHandle }[]>('readonly', (s) => s.getAll());
    for (const r of rows) {
      const ok = (await (r.handle as Perm).queryPermission?.({ mode: 'read' }).catch(() => 'denied')) === 'granted';
      if (ok) void read(r.name, r.handle);
      else put({ name: r.name, handle: r.handle, files: new Map(), state: 'ask' });
    }
  } catch { /* nothing remembered */ }
}

/** A remembered folder the browser wants a click for: ask, then read it. */
export async function allowModelFolder(name: string): Promise<boolean> {
  const f = modelFolders.value.find((x) => x.name === name);
  if (!f?.handle) return false;
  const ok = (await (f.handle as Perm).requestPermission?.({ mode: 'read' }).catch(() => 'denied')) === 'granted';
  if (ok) await read(f.name, f.handle);
  return ok;
}
/** Every remembered folder waiting for a click, asked for in turn (from one click). */
export async function allowModelFolders(): Promise<void> {
  for (const f of modelFolders.value.filter((x) => x.state === 'ask')) await allowModelFolder(f.name);
}

/** Add a folder (or, without folder access, some STEP files for this session). Returns its name. */
export async function addModelFolder(): Promise<string | null> {
  if (hasFolderAccess()) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'konium-models', mode: 'read' });
    } catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
    try { await store('readwrite', (s) => s.put({ name: dir.name, handle: dir })); } catch { /* kept for this session only */ }
    await read(dir.name, dir);
    return dir.name;
  }
  const picked = (await openFiles()).filter((f) => STEP.test(f.name));
  if (!picked.length) return null;
  const name = `${picked.length} model${picked.length === 1 ? '' : 's'} (this session)`;
  put({ name, files: new Map(picked.map((f) => [f.name.toLowerCase(), f.bytes])), state: 'ready' });
  return name;
}

export async function removeModelFolder(name: string): Promise<void> {
  modelFolders.value = modelFolders.value.filter((f) => f.name !== name);
  try { await store('readwrite', (s) => s.delete(name)); } catch { /* not remembered */ }
  modelFoldersChanged.emit();
}

/** Models linked this session (Place › 3D Body › Link to STEP Model), by lower-case name. */
const session = new Map<string, Uint8Array>();
export function rememberModel(name: string, bytes: Uint8Array): void { session.set(modelFileName(name), bytes); modelFoldersChanged.emit(); }

/** STEP files of project folders, read once each. */
const projectIndex = new WeakMap<FileSystemDirectoryHandle, Promise<Map<string, FileSystemFileHandle>>>();

/** A linked model's file: in the project's folder first, then the model folders. Null: not found. */
export async function findLinkedModel(path: string, projectDir?: FileSystemDirectoryHandle): Promise<Uint8Array | null> {
  const name = modelFileName(path);
  if (!name) return null;
  const take = async (h: FileSystemFileHandle | Uint8Array | undefined) => {
    if (!h) return null;
    if (h instanceof Uint8Array) return h;
    try { return new Uint8Array(await (await h.getFile()).arrayBuffer()); } catch { return null; }
  };
  if (projectDir) {
    let idx = projectIndex.get(projectDir);
    if (!idx) { idx = stepFilesIn(projectDir, 4).catch(() => new Map()); projectIndex.set(projectDir, idx); }
    const b = await take((await idx).get(name));
    if (b) return b;
  }
  for (const f of modelFolders.value) {
    if (f.state !== 'ready') continue;
    const b = await take(f.files.get(name));
    if (b) return b;
  }
  return session.get(name) ?? null;
}
