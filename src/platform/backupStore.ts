/**
 * The browser's side of Auto Save and Local History (IndexedDB): auto-saved copies of changed
 * documents, the history of documents that have no History folder to go to (no folder access,
 * or Use global repository), and the labels given to versions. Without IndexedDB (tests,
 * private modes) nothing is kept and every call is a quiet no-op.
 */
import { adoptFormerDb } from './formerDb';

export interface AutoCopy { key: string; docKey: string; slot: number; name: string; project?: string; path?: string; session: string; at: number; size: number }
export interface StoredVersion { key: string; docKey: string; n: number; name: string; at: number; size: number; label?: string }

const DB = 'konium-backup', AUTO = 'autosave', HIST = 'history', LABELS = 'labels';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    let fresh = false;
    r.onupgradeneeded = (e) => {
      const db = r.result;
      fresh = e.oldVersion === 0;
      db.createObjectStore(AUTO, { keyPath: 'key' }).createIndex('docKey', 'docKey');
      db.createObjectStore(HIST, { keyPath: 'key' }).createIndex('docKey', 'docKey');
      db.createObjectStore(LABELS);
    };
    // Made just now: what the app kept under its earlier name copied in first
    r.onsuccess = () => { if (fresh) void adoptFormerDb(r.result).finally(() => resolve(r.result)); else resolve(r.result); };
    r.onerror = () => reject(r.error);
  });
}
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const backupAvailable = (): boolean => typeof indexedDB !== 'undefined';

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  if (!backupAvailable()) return fallback;
  try { const db = await open(); try { return await fn(db); } finally { db.close(); } } catch { return fallback; }
}
const strip = <T extends { blob?: Blob }>(r: T): Omit<T, 'blob'> => { const { blob: _b, ...rest } = r; return rest; };

/* ── auto-saved copies ── */

export const listAutoCopies = (): Promise<AutoCopy[]> => withDb(async (db) => (await req(db.transaction(AUTO).objectStore(AUTO).getAll() as IDBRequest<(AutoCopy & { blob: Blob })[]>)).map(strip), []);

export const putAutoCopy = (c: AutoCopy, bytes: Uint8Array): Promise<boolean> => withDb(async (db) => {
  const t = db.transaction(AUTO, 'readwrite');
  t.objectStore(AUTO).put({ ...c, blob: new Blob([bytes as BlobPart]) });
  await done(t);
  return true;
}, false);

export const autoCopyBytes = (key: string): Promise<Uint8Array | null> => withDb(async (db) => {
  const r = await req(db.transaction(AUTO).objectStore(AUTO).get(key) as IDBRequest<{ blob: Blob } | undefined>);
  return r ? new Uint8Array(await r.blob.arrayBuffer()) : null;
}, null);

/**
 * Copies dropped: by their keys, or a document's copies made (or taken over) by one session.
 * Never a document's copies whatever the session: a document is known here by its project's
 * name and its own, so another window, or a session that crashed, may hold copies under the
 * same key that are the only ones left of its unsaved work.
 */
export const dropAutoCopies = (o: { keys?: string[]; docKey?: string; session?: string }): Promise<void> => withDb(async (db) => {
  const t = db.transaction(AUTO, 'readwrite'), s = t.objectStore(AUTO);
  for (const k of o.keys ?? []) s.delete(k);
  if (o.docKey !== undefined && o.session !== undefined) for (const r of await req(s.index('docKey').getAll(o.docKey) as IDBRequest<AutoCopy[]>)) if (r.session === o.session) s.delete(r.key);
  await done(t);
}, undefined);

/** Copies taken over by this session (opened again after a crash): they're this session's now. */
export const adoptAutoCopies = (keys: string[], session: string): Promise<void> => withDb(async (db) => {
  const t = db.transaction(AUTO, 'readwrite'), s = t.objectStore(AUTO);
  for (const k of keys) { const r = await req(s.get(k) as IDBRequest<(AutoCopy & { blob: Blob }) | undefined>); if (r) s.put({ ...r, session }); }
  await done(t);
}, undefined);

/* ── history kept in the browser ── */

export const listStoredVersions = (docKey: string): Promise<StoredVersion[]> => withDb(async (db) =>
  (await req(db.transaction(HIST).objectStore(HIST).index('docKey').getAll(docKey) as IDBRequest<(StoredVersion & { blob: Blob })[]>)).map(strip), []);

export const putStoredVersion = (v: StoredVersion, bytes: Uint8Array): Promise<boolean> => withDb(async (db) => {
  const t = db.transaction(HIST, 'readwrite');
  t.objectStore(HIST).put({ ...v, blob: new Blob([bytes as BlobPart]) });
  await done(t);
  return true;
}, false);

export const storedVersionBytes = (key: string): Promise<Uint8Array | null> => withDb(async (db) => {
  const r = await req(db.transaction(HIST).objectStore(HIST).get(key) as IDBRequest<{ blob: Blob } | undefined>);
  return r ? new Uint8Array(await r.blob.arrayBuffer()) : null;
}, null);

export const dropStoredVersions = (keys: string[]): Promise<void> => withDb(async (db) => {
  const t = db.transaction(HIST, 'readwrite');
  for (const k of keys) t.objectStore(HIST).delete(k);
  await done(t);
}, undefined);

export const setStoredLabel = (key: string, label: string | undefined): Promise<void> => withDb(async (db) => {
  const t = db.transaction(HIST, 'readwrite'), s = t.objectStore(HIST);
  const r = await req(s.get(key) as IDBRequest<(StoredVersion & { blob: Blob }) | undefined>);
  if (r) s.put({ ...r, label });
  await done(t);
}, undefined);

/* ── labels of versions kept in a History folder ── */

export const folderLabels = (docKey: string): Promise<Map<number, string>> => withDb(async (db) => {
  const all = await req(db.transaction(LABELS).objectStore(LABELS).get(docKey) as IDBRequest<Record<string, string> | undefined>);
  return new Map(Object.entries(all ?? {}).map(([n, l]) => [Number(n), l]));
}, new Map<number, string>());

export const setFolderLabel = (docKey: string, n: number, label: string | undefined): Promise<void> => withDb(async (db) => {
  const t = db.transaction(LABELS, 'readwrite'), s = t.objectStore(LABELS);
  const all = { ...((await req(s.get(docKey) as IDBRequest<Record<string, string> | undefined>)) ?? {}) };
  if (label) all[n] = label; else delete all[n];
  s.put(all, docKey);
  await done(t);
}, undefined);
