/**
 * Auto Save and Local History as AD names and keeps them: an auto-saved copy is Name.~(n).Ext
 * (n from 1 to the number of versions kept, the oldest reused); a Local History version is the
 * file it replaced, zipped as Name.~(n).Ext.Zip in the project's History folder (n counting up,
 * the highest the newest), shown as "Version n", "Version n [label]" or
 * "Version n [AutoSave 2015-01-28 14~14~17-935]".
 */

const split = (name: string): [string, string] => { const i = name.lastIndexOf('.'); return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']; };

/** An auto-saved copy's name: Sheet1.~(3).SchDoc. */
export const backupName = (name: string, n: number): string => { const [s, e] = split(name); return `${s}.~(${n})${e}`; };

/** A Local History version's file: Sheet1.~(3).SchDoc.Zip. */
export const historyZipName = (name: string, n: number): string => `${backupName(name, n)}.Zip`;

/** A History folder's file read back: the document's name and the version's number (null: not a version). */
export function parseHistoryZip(file: string): { name: string; n: number } | null {
  const m = /^(.*)\.~\((\d+)\)(\.[^.]*)?\.zip$/i.exec(file);
  return m ? { name: `${m[1]}${m[3] ?? ''}`, n: Number(m[2]) } : null;
}

/** AD's label for an auto-saved version: AutoSave 2015-01-28 14~14~17-935. */
export function autoSaveLabel(d: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `AutoSave ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}~${p(d.getMinutes())}~${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** How a version shows in the time line. */
export const versionTitle = (n: number, label?: string): string => (label ? `Version ${n} [${label}]` : `Version ${n}`);

/** The slot the next auto-saved copy takes: a free one up to `keep`, else the oldest's. */
export function nextSlot(used: { slot: number; at: number }[], keep: number): number {
  for (let k = 1; k <= keep; k++) if (!used.some((u) => u.slot === k)) return k;
  return [...used].filter((u) => u.slot <= keep).sort((a, b) => a.at - b.at)[0]?.slot ?? 1;
}

/** The next version number: one past the highest. */
export const nextVersion = (ns: number[]): number => (ns.length ? Math.max(...ns) : 0) + 1;

/** Versions to go when the history keeps `days` days: older ones, unless labelled (AutoSave labels don't protect). */
export function expired<T extends { at: number; label?: string }>(versions: T[], days: number, now = Date.now()): T[] {
  const cut = now - days * 86_400_000;
  return versions.filter((v) => v.at < cut && !(v.label && !/^AutoSave /.test(v.label)));
}

/**
 * Storage Manager › Purge History: what goes — all versions, or those older than `days`; the
 * newest `keep` always stay (they take precedence), and labelled ones unless included.
 */
export function purgeSelection<T extends { n: number; at: number; label?: string }>(versions: T[], o: { days?: number; keep?: number; labelled?: boolean }, now = Date.now()): T[] {
  const newest = new Set([...versions].sort((a, b) => b.n - a.n).slice(0, Math.max(0, o.keep ?? 0)).map((v) => v.n));
  const cut = o.days !== undefined ? now - o.days * 86_400_000 : Infinity;
  return versions.filter((v) => !newest.has(v.n) && v.at < cut && (o.labelled || !v.label || /^AutoSave /.test(v.label)));
}

/** A document's identity across sessions: its project and its path there (or its name alone). */
export const docKeyOf = (project: string | undefined, path: string | undefined, name: string): string => `${(project ?? '').toLowerCase()}|${(path ?? name).replace(/\\/g, '/').toLowerCase()}`;

/** Sessions no longer running: no heartbeat for `maxAge` (or none at all). */
export const sessionGone = (beats: Record<string, number>, id: string, now = Date.now(), maxAge = 90_000): boolean => !(id in beats) || now - beats[id]! > maxAge;
