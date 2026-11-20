/**
 * Small browser-storage values under Konium Designer's names ("konium.<name>"). Values saved
 * under the app's earlier names are read once and carried over; those of the names just before
 * (settings, the AI connection, column widths, recent sessions …) are all moved over the first
 * time this module loads, before anything reads them: each copied to the present name, then the
 * earlier one removed.
 */
import { FORMERS } from './former';

const OLDER = [...FORMERS, 'vibium', 'designerium'];

/** Every value kept under the names just before, moved to the present name (where it has one already, that one is kept; the most recent name's first). */
export function adoptFormer(): void {
  for (const st of ['localStorage', 'sessionStorage'] as const) {
    try {
      const s = (globalThis as unknown as Record<string, Storage | undefined>)[st];
      if (!s) continue;
      for (const f of FORMERS) {
        const pre = `${f}.`, keys: string[] = [];
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(pre)) keys.push(k); }
        for (const k of keys) {
          const now = `konium.${k.slice(pre.length)}`;
          if (s.getItem(now) === null) s.setItem(now, s.getItem(k) ?? '');
          s.removeItem(k);
        }
      }
    } catch { /* storage blocked or full: kept where it was, for the next time */ }
  }
}
adoptFormer();

export function readLocal(name: string): string | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const v = ls.getItem(`konium.${name}`);
    if (v !== null) return v;
    for (const p of OLDER) {
      const o = ls.getItem(`${p}.${name}`);
      if (o !== null) { try { ls.setItem(`konium.${name}`, o); } catch { /* full or private */ } return o; }
    }
  } catch { /* storage blocked */ }
  return null;
}

export function writeLocal(name: string, value: string): void {
  try { globalThis.localStorage?.setItem(`konium.${name}`, value); } catch { /* private mode */ }
}
