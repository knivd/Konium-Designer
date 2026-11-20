/**
 * Installed libraries kept between sessions (Altium keeps its Installed list): each library's
 * bytes as a Blob in IndexedDB, and the list's order. Libraries of hundreds of megabytes are
 * fine here (unlike localStorage); a library is written once, when installed, and the order
 * alone is rewritten when it changes. Without IndexedDB (tests, private modes) nothing is kept.
 */
import { crc32 } from '../formats/zip';
import { adoptFormerDb } from './formerDb';
/** 'dblib': a database library; 'dbfile': a file kept with one (named "<library>|<path>"). */
export type StoredKind = 'sch' | 'pcb' | 'dblib' | 'dbfile';
export interface StoredLib { key: string; name: string; kind: StoredKind; bytes: Uint8Array }

const DB = 'konium-libraries', FILES = 'files', META = 'meta';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    let fresh = false;
    req.onupgradeneeded = (e) => { fresh = e.oldVersion === 0; req.result.createObjectStore(FILES, { keyPath: 'key' }); req.result.createObjectStore(META); };
    // Made just now: what the app kept under its earlier name copied in first
    req.onsuccess = () => { if (fresh) void adoptFormerDb(req.result).finally(() => resolve(req.result)); else resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}
const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const libStoreAvailable = (): boolean => typeof indexedDB !== 'undefined';
export const libKey = (kind: StoredKind, name: string) => `${kind}:${name.toLowerCase()}`;

/** The installed libraries, in their order. */
export async function loadLibs(): Promise<StoredLib[]> {
  if (!libStoreAvailable()) return [];
  try {
    const db = await open();
    const t = db.transaction([FILES, META], 'readonly');
    const [rows, order] = await Promise.all([
      req(t.objectStore(FILES).getAll() as IDBRequest<{ key: string; name: string; kind: StoredKind; blob: Blob }[]>),
      req(t.objectStore(META).get('order') as IDBRequest<string[] | undefined>),
    ]);
    db.close();
    const rank = new Map((order ?? []).map((k, i) => [k, i]));
    rows.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    return Promise.all(rows.map(async (r) => ({ key: r.key, name: r.name, kind: r.kind, bytes: new Uint8Array(await r.blob.arrayBuffer()) })));
  } catch { return []; }
}

/** Make the store hold exactly these (new ones written, gone ones deleted, the order kept). */
export async function syncLibs(libs: { name: string; kind: StoredKind; bytes: Uint8Array }[]): Promise<void> {
  if (!libStoreAvailable()) return;
  try {
    const db = await open();
    // What is stored, with each file's signature: a library installed again with new contents is written again
    const rows = await req(db.transaction(FILES).objectStore(FILES).getAll() as IDBRequest<{ key: string; sig?: string }[]>);
    const have = new Map(rows.map((r) => [r.key, r.sig ?? '']));
    const want = libs.map((l) => ({ ...l, key: libKey(l.kind, l.name), sig: `${l.bytes.length}:${crc32(l.bytes)}` }));
    const t = db.transaction([FILES, META], 'readwrite');
    const files = t.objectStore(FILES);
    for (const l of want) if (have.get(l.key) !== l.sig) files.put({ key: l.key, name: l.name, kind: l.kind, sig: l.sig, blob: new Blob([l.bytes as BlobPart]) });
    for (const k of have.keys()) if (!want.some((l) => l.key === k)) files.delete(k);
    t.objectStore(META).put(want.map((l) => l.key), 'order');
    await done(t);
    db.close();
  } catch { /* storage full or blocked: the list stays for this session */ }
}
