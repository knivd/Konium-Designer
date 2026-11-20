import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import type { SchEditor } from '../../editors/sch/SchEditor';
import { natural } from '../../model/compile';
import { setProps } from '../../model/schEdit';
import { libPinSwapGroup } from '../../formats/altium/schlib';

/**
 * Tools › Configure Pin Swapping: per part, which pins may swap with one another (same Pin
 * Swap Group) and the part's swap group (with other parts of the package). Kept on the pins as
 * SWAPIDPIN and on the part's pins as SWAPIDPART (as AD17 writes them on a sheet; in a library the pin's
 * group is its binary swap-group string, SWAPIDGROUP here). Applied as one undo step.
 */
export function PinSwapDialog({ ed, pinKey = 'SWAPIDPIN' }: { ed: SchEditor; pinKey?: 'SWAPIDPIN' | 'SWAPIDGROUP' }) {
  const doc = ed.doc;
  const parts = useMemo(() => doc.objects.filter((o) => o.kind === 'component').map((o) => o as typeof o & { kind: 'component' }).sort((a, b) => natural(a.designator, b.designator)), [doc]);
  const [ci, setCi] = useState(parts[0]?.index ?? -1);
  const [edits, setEdits] = useState<Map<number, { pin?: string; part?: string }>>(new Map());
  const pins = doc.objects.filter((o) => o.kind === 'pin' && o.owner === ci).map((o) => o as typeof o & { kind: 'pin' }).sort((a, b) => natural(a.designator, b.designator));
  const stored = (i: number, k: 'pin' | 'part') => { const b = doc.records[i + 1]?.bag; return !b ? '' : k === 'part' ? b.get('SWAPIDPART') ?? '' : pinKey === 'SWAPIDGROUP' ? libPinSwapGroup(b) : b.get(pinKey) ?? ''; };
  const val = (i: number, k: 'pin' | 'part') => edits.get(i)?.[k] ?? stored(i, k);
  const set = (i: number, k: 'pin' | 'part', v: string) => { const m = new Map(edits); m.set(i, { ...m.get(i), [k]: v }); setEdits(m); };
  const ok = () => {
    closeDialog();
    if (!edits.size) return;
    ed.undo.transact('Configure pin swapping', (tx) => {
      for (const [i, e] of edits) tx.add(setProps(doc, i, { ...(e.pin !== undefined ? { [pinKey]: e.pin || null, ...(pinKey === 'SWAPIDGROUP' ? { SWAPIDPIN: null } : {}) } : {}), ...(e.part !== undefined ? { SWAPIDPART: e.part || null } : {}) }));
    });
    ed.invalidate();
  };
  return (
    <Dialog title="Configure Pin Swapping" width={820} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="pinswap"
      footer={<><span class="muted small">Pins with the same Pin Swap Group may swap on the board</span><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="ps-split">
        <Grid cols={[{ label: 'Designator', get: (c: (typeof parts)[number]) => c.designator }, { label: 'Library Ref', get: (c) => c.libRef }]} rows={parts} sel={parts.findIndex((p) => p.index === ci)} onSel={(i) => setCi(parts[i]?.index ?? -1)} empty="No parts" />
        <Grid cols={[{ label: 'Pin', width: '60px', get: (p: (typeof pins)[number]) => p.designator }, { label: 'Name', get: (p) => p.name },
          { label: 'Pin Swap Group', width: '130px', get: (p) => <input type="text" class="cell-edit" value={val(p.index, 'pin')} aria-label={`Pin ${p.designator} swap group`} onInput={(e) => set(p.index, 'pin', (e.target as HTMLInputElement).value)} /> },
          { label: 'Part Swap Group', width: '130px', get: (p) => <input type="text" class="cell-edit" value={val(p.index, 'part')} aria-label={`Pin ${p.designator} part swap group`} onInput={(e) => set(p.index, 'part', (e.target as HTMLInputElement).value)} /> }]}
          rows={pins} empty="The part has no pins" />
      </div>
    </Dialog>
  );
}
