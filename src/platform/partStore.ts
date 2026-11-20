/**
 * The parts shelf in this browser (IndexedDB): each part kept under its part number as compared
 * (letters and digits, upper case), as it travels (its record and its two libraries). Nothing
 * here leaves the computer.
 */
import type { PartPackage } from '../model/partPackage';
import { partKey } from '../model/partPackage';

const DB = 'konium-parts', STORE = 'parts';
function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db();
  try {
    return await new Promise<T>((ok, fail) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
  } finally { d.close(); }
};

/** Every part kept, by part number. An empty list where the browser keeps nothing. */
export async function loadParts(): Promise<PartPackage[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const all = await tx<PartPackage[]>('readonly', (s) => s.getAll() as IDBRequest<PartPackage[]>);
    return all.filter((p) => p?.record?.mpn && p.schlib && p.pcblib).sort((a, b) => a.record.mpn.localeCompare(b.record.mpn, 'en', { numeric: true, sensitivity: 'base' }));
  } catch { return []; }
}
export async function storePart(p: PartPackage): Promise<void> { await tx('readwrite', (s) => s.put(p, partKey(p.record.mpn))); }
export async function dropPart(mpn: string): Promise<void> { await tx('readwrite', (s) => s.delete(partKey(mpn))); }
