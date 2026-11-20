/**
 * Recent projects. Chromium can keep folder handles in IndexedDB, so reopening a project later
 * costs one "Allow" click instead of picking files again.
 */
import { FORMERS } from '../core/former';
import { deleteOld } from './formerDb';

export interface RecentProject {
  key: string;               // folder name + project path
  name: string;              // Amplifier.PrjPcb
  folder: string;            // folder display name
  prjPath: string;           // path of the .PrjPcb inside the folder
  dir: FileSystemDirectoryHandle;
  at: number;
}

const DB = 'konium', STORE = 'recentProjects', DOCS = 'recentDocuments', MAX = 10;

/** A document opened on its own from disk (Chromium keeps its handle, so it reopens with one click). */
export interface RecentDocument { key: string; name: string; handle: FileSystemFileHandle; at: number }
/** The lists kept under the app's earlier names: the newest one is copied over the first time (the name just before's moved). */
const OLD_DBS = [...FORMERS, 'vibium', 'designerium'];

/** One connection for the session, given up when another tab needs a newer version of the store. */
let conn: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  conn ??= openDb().then((db) => { db.onversionchange = () => { db.close(); conn = null; }; return db; }, (e) => { conn = null; throw e; });
  return conn;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onblocked = () => reject(new Error('the recent list is busy in another Konium Designer tab'));
    let created = false;
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) { db.createObjectStore(STORE, { keyPath: 'key' }); created = e.oldVersion === 0; }
      if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'key' });
    };
    req.onsuccess = () => { const db = req.result; if (created) void adoptOld(db).finally(() => resolve(db)); else resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

async function adoptOld(db: IDBDatabase): Promise<void> {
  try {
    const known = await indexedDB.databases?.();
    const name = OLD_DBS.find((n) => known?.some((d) => d.name === n));
    if (!name) return;
    const old = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!old.objectStoreNames.contains(STORE)) { old.close(); return; }
    const rows = await new Promise<RecentProject[]>((res, rej) => { const r = old.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result as RecentProject[]); r.onerror = () => rej(r.error); });
    // The recent documents too, where it kept them
    const docs = old.objectStoreNames.contains(DOCS) ? await new Promise<unknown[]>((res, rej) => { const r = old.transaction(DOCS).objectStore(DOCS).getAll(); r.onsuccess = () => res(r.result as unknown[]); r.onerror = () => rej(r.error); }) : [];
    const only = Array.from(old.objectStoreNames).every((st) => st === STORE || st === DOCS);
    old.close();
    await new Promise<void>((res, rej) => { const t = db.transaction([STORE, DOCS], 'readwrite'); for (const row of rows) t.objectStore(STORE).put(row); for (const row of docs) t.objectStore(DOCS).put(row); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
    // The name just before: moved, its database deleted once the lists are in (the older names' are left as they were)
    if (FORMERS.includes(name) && only) await deleteOld(name);
  } catch { /* nothing to carry over */ }
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const recentSupported = (): boolean => typeof indexedDB !== 'undefined' && typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** The same project reached twice: the same folder (not merely one of the same name: two clones are two projects) and the same path to the .PrjPcb. */
async function sameProject(a: { dir: FileSystemDirectoryHandle; prjPath: string }, b: { dir: FileSystemDirectoryHandle; prjPath: string }): Promise<boolean> {
  if (a.prjPath.toLowerCase() !== b.prjPath.toLowerCase()) return false;
  return a.dir.isSameEntry(b.dir).catch(() => false);
}

export async function listRecent(): Promise<RecentProject[]> {
  if (!recentSupported()) return [];
  try {
    const all = (await tx<RecentProject[]>('readonly', (s) => s.getAll() as IDBRequest<RecentProject[]>)).sort((a, b) => b.at - a.at);
    const out: RecentProject[] = [];
    for (const r of all) {
      let dup = false;
      for (const k of out) if (await sameProject(k, r)) { dup = true; break; }
      if (!dup) out.push(r);
    }
    return out.slice(0, MAX);
  } catch { return []; }
}

/**
 * A remembered folder that holds this file (a .PrjPcb picked on its own): its project then opens
 * without asking for the folder again. Null when the file isn't in any of them.
 */
export async function knownFolderOf(file: FileSystemFileHandle): Promise<{ dir: FileSystemDirectoryHandle; path: string } | null> {
  for (const r of await listRecent()) {
    try {
      const parts = await r.dir.resolve(file);
      if (parts?.length) return { dir: r.dir, path: parts.join('/') };
    } catch { /* gone or not reachable */ }
  }
  return null;
}

export async function rememberProject(dir: FileSystemDirectoryHandle, prjPath: string): Promise<void> {
  if (!recentSupported()) return;
  const name = prjPath.split('/').pop() ?? prjPath;
  const rec: RecentProject = { key: `${dir.name}/${prjPath}#${Date.now()}`, name, folder: dir.name, prjPath, dir, at: Date.now() };
  try {
    const before = await tx<RecentProject[]>('readonly', (s) => s.getAll() as IDBRequest<RecentProject[]>);
    for (const old of before) if (old.key !== rec.key && (await sameProject(old, rec))) await tx('readwrite', (s) => s.delete(old.key));
    await tx('readwrite', (s) => s.put(rec));
    const all = (await tx<RecentProject[]>('readonly', (s) => s.getAll() as IDBRequest<RecentProject[]>)).sort((a, b) => b.at - a.at);
    for (const old of all.slice(MAX)) await tx('readwrite', (s) => s.delete(old.key));
  } catch { /* storage unavailable: recent list is a convenience */ }
}

export async function forgetProject(key: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}

export async function listRecentDocuments(): Promise<RecentDocument[]> {
  if (!recentSupported()) return [];
  try {
    const all = await tx<RecentDocument[]>('readonly', (s) => s.getAll() as IDBRequest<RecentDocument[]>, DOCS);
    return all.sort((a, b) => b.at - a.at).slice(0, MAX);
  } catch { return []; }
}

/** Remember a document opened from disk; the same file opened again moves to the top. */
export async function rememberDocument(handle: FileSystemFileHandle): Promise<void> {
  if (!recentSupported()) return;
  try {
    const all = await tx<RecentDocument[]>('readonly', (s) => s.getAll() as IDBRequest<RecentDocument[]>, DOCS);
    for (const old of all) if (await handle.isSameEntry(old.handle).catch(() => false)) await tx('readwrite', (s) => s.delete(old.key), DOCS);
    const rec: RecentDocument = { key: `${handle.name}#${Date.now()}`, name: handle.name, handle, at: Date.now() };
    await tx('readwrite', (s) => s.put(rec), DOCS);
    const kept = (await tx<RecentDocument[]>('readonly', (s) => s.getAll() as IDBRequest<RecentDocument[]>, DOCS)).sort((a, b) => b.at - a.at);
    for (const old of kept.slice(MAX)) await tx('readwrite', (s) => s.delete(old.key), DOCS);
  } catch { /* storage unavailable: the list is a convenience */ }
}

export async function forgetDocument(key: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(key), DOCS); } catch { /* ignore */ }
}
