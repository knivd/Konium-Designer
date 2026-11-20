/**
 * Preferences › PCB Editor › General › Remove Duplicates: the board as its outputs see it — an
 * object that is the same as another (same kind, place, size, layer, net), left over from a
 * paste or an import, goes out once.
 */
import { settings } from '../core/settings';
import type { PcbDocument, PcbPrim } from './pcb';

/** The primitives, each one once (the first of a duplicated one). */
export function uniquePrims(prims: readonly PcbPrim[]): PcbPrim[] {
  const seen = new Set<string>();
  return prims.filter((p) => {
    const { src: _src, ...rest } = p;
    const k = JSON.stringify(rest);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The board for an output: without duplicates when Remove Duplicates is on (the board itself is not changed). */
export function forOutput(doc: PcbDocument): PcbDocument {
  if (!settings.pcbRemoveDuplicates) return doc;
  const prims = uniquePrims(doc.prims);
  return prims.length === doc.prims.length ? doc : { ...doc, prims };
}
