/**
 * Edit › Selection Memory (schematic and board), as Altium keeps it: eight memories per
 * document. Store puts the selection in one, Store Plus adds it; Recall makes it the
 * selection, Recall Plus adds it; Apply selects it and zooms to it; Clear empties it.
 */
import type { AccelNode } from '../core/keymap';
import type { Editor } from '../editors/Editor';
import { notify } from './state';
import { settings } from '../core/settings';

const memories = new WeakMap<Editor, Map<number, Set<string>>>();
function mem(e: Editor): Map<number, Set<string>> {
  let m = memories.get(e);
  if (!m) { m = new Map(); memories.set(e, m); }
  return m;
}

export type MemoryAction = 'store' | 'recall' | 'storePlus' | 'recallPlus' | 'apply' | 'clear';

export function memoryAction(e: Editor, n: number, what: MemoryAction): void {
  const m = mem(e);
  const live = new Set(e.allKeys());
  const kept = () => [...(m.get(n) ?? [])].filter((k) => live.has(k));
  switch (what) {
    case 'store': m.set(n, new Set(e.selection)); notify(`Memory ${n}: ${e.selection.size} object${e.selection.size === 1 ? '' : 's'}`); return;
    case 'storePlus': m.set(n, new Set([...(m.get(n) ?? []), ...e.selection])); notify(`Memory ${n}: ${m.get(n)!.size} objects`); return;
    case 'recall': e.select(kept()); return;
    case 'recallPlus': e.select([...e.selection, ...kept()]); return;
    case 'apply': { const k = kept(); e.select(k); if (k.length) e.zoomToBox(e.boundsOf(k), 2_000_000); return; }
    case 'clear': {
      const clear = () => { m.delete(n); notify(`Memory ${n} cleared`); };
      // Preferences › Confirm Selection Memory Clear (the schematic's and the board's)
      const ask = e.scope === 'pcb' ? settings.pcbConfirmMemoryClear : settings.schConfirmMemoryClear;
      if (ask && m.get(n)?.size) e.confirm(`Clear selection memory ${n} (${m.get(n)!.size} object${m.get(n)!.size === 1 ? '' : 's'})?`, clear); else clear();
      return;
    }
  }
}

/** Memory 1 … Memory 8 for a Selection Memory submenu; empty memories grey out where they can't act. */
export function memoryItems(e: Editor | null, what: MemoryAction): AccelNode[] {
  return Array.from({ length: 8 }, (_, i) => {
    const n = i + 1, size = e ? mem(e).get(n)?.size ?? 0 : 0;
    const needs = what !== 'store' && what !== 'storePlus';
    return { key: String(n), label: `Memory ${n}${size ? ` (${size})` : ''}`, accelAt: 7, disabled: !e || (needs && !size) || (!needs && !e.selection.size),
      action: () => { if (e) memoryAction(e, n, what); } };
  });
}

/** How many objects a memory holds (that still exist). */
export function memorySize(e: Editor, n: number): number {
  const live = new Set(e.allKeys());
  return [...(mem(e).get(n) ?? [])].filter((k) => live.has(k)).length;
}
