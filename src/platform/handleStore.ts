/**
 * Folders and files Konium was given to keep using (the backup folder, …): their handles kept in
 * the browser (IndexedDB), so a later session needs one "Allow" instead of choosing them again.
 */
import { adoptFormerDb } from './formerDb';
const DB = 'konium-handles', STORE = 'handles';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    let fresh = false;
    r.onupgradeneeded = (e) => { fresh = e.oldVersion === 0; if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    // Made just now: what the app kept under its earlier name copied in first
    r.onsuccess = () => { if (fresh) void adoptFormerDb(r.result).finally(() => resolve(r.result)); else resolve(r.result); };
    r.onerror = () => reject(r.error);
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => { const q = fn(db.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
  } finally { db.close(); }
}

export const handlesAvailable = (): boolean => typeof indexedDB !== 'undefined';
export async function putHandle(key: string, h: FileSystemHandle): Promise<void> { try { await run('readwrite', (s) => s.put(h, key)); } catch { /* not kept */ } }
export async function getHandle<T extends FileSystemHandle>(key: string): Promise<T | null> { try { return ((await run('readonly', (s) => s.get(key))) as T | undefined) ?? null; } catch { return null; } }
export async function dropHandle(key: string): Promise<void> { try { await run('readwrite', (s) => s.delete(key)); } catch { /* gone already */ } }
