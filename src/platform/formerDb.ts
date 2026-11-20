/**
 * The browser's databases as the app kept them under its earlier names (autosaves and history,
 * installed libraries, folders it may open, model folders, reports waiting to go): the first time
 * a database is made under the present name, what the earlier ones of the same name hold is moved
 * into it, store by store, keys and all (the most recent name's first: a key it has isn't taken
 * again from an older one); each earlier one, once all of it is in, is deleted.
 */
import { FORMERS } from '../core/former';

const PRESENT = 'konium';

/** The earlier databases' names for a database of the present name, the most recent first (none: it had none). */
export const formerNames = (name: string): string[] => (name.startsWith(PRESENT) ? FORMERS.map((f) => f + name.slice(PRESENT.length)) : []);

function openOld(name: string): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    const r = indexedDB.open(name);
    // Opening one that isn't there would make it: given up on
    r.onupgradeneeded = () => { r.transaction?.abort(); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
}

function rows(db: IDBDatabase, store: string): Promise<{ key: IDBValidKey; value: unknown }[]> {
  return new Promise((res, rej) => {
    const out: { key: IDBValidKey; value: unknown }[] = [];
    const c = db.transaction(store).objectStore(store).openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) { res(out); return; } out.push({ key: cur.primaryKey, value: cur.value }); cur.continue(); };
    c.onerror = () => rej(c.error);
  });
}

/** What the earlier databases hold, moved into the newly made one (nothing when there were none). */
export async function adoptFormerDb(db: IDBDatabase): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  for (const old of formerNames(db.name)) {
    try {
      const known = await indexedDB.databases?.();
      if (known && !known.some((d) => d.name === old)) continue;
      const from = await openOld(old);
      if (!from) continue;
      // A store the present database hasn't got would be lost: then the earlier one is left as it is
      let whole = Array.from(from.objectStoreNames).every((st) => db.objectStoreNames.contains(st));
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          if (!from.objectStoreNames.contains(store)) continue;
          const list = await rows(from, store);
          if (!list.length) continue;
          await new Promise<void>((res, rej) => {
            const t = db.transaction(store, 'readwrite'), s = t.objectStore(store);
            const have = s.getAllKeys();
            have.onsuccess = () => {
              const got = new Set(have.result.map((k) => JSON.stringify(k)));
              for (const r of list) {
                if (got.has(JSON.stringify(r.key))) continue;
                if (s.keyPath === null) s.put(r.value, r.key); else s.put(r.value);
              }
            };
            t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
          });
        }
      } catch { whole = false; } finally { from.close(); }
      if (whole) await deleteOld(old);
    } catch { /* nothing to carry over from this one */ }
  }
}

/** An earlier database, all of it moved: deleted (a tab still running an earlier build may hold it open: deleted when it closes). */
export function deleteOld(name: string): Promise<void> {
  return new Promise((res) => {
    try {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = () => res();
      r.onblocked = () => res();
    } catch { res(); }
  });
}
