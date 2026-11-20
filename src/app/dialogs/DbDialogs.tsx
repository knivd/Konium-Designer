/**
 * Select Parameter Changes (Tools › Update Parameters From Database) [est: laid out from AD17's]:
 * each change the database brings — the part, the parameter, its value now and the database's —
 * ticked to accept; OK makes them (one undo step per sheet).
 */
import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import type { ParamChange } from '../../model/dbParams';

export function SelectParamChangesDialog({ changes, matched, unmatched, onOk }: { changes: ParamChange[]; matched: number; unmatched: number; onOk: (chosen: ParamChange[]) => void }) {
  const [off, setOff] = useState<Set<number>>(new Set());
  const ok = () => { closeDialog(); onOk(changes.filter((_, i) => !off.has(i))); };
  const toggle = (i: number) => { const s = new Set(off); if (s.has(i)) s.delete(i); else s.add(i); setOff(s); };
  return (
    <Dialog title="Select Parameter Changes" width={860} height={540} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="dbchanges"
      footer={<><button class="btn" onClick={() => setOff(new Set())}>Accept All</button><button class="btn" onClick={() => setOff(new Set(changes.map((_, i) => i)))}>Decline All</button>
        <span class="spacer" /><button class="btn default" disabled={off.size === changes.length} onClick={ok}>Accept Changes ({changes.length - off.size})</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <p class="muted small">{matched} part{matched === 1 ? '' : 's'} found in the database, {unmatched} without a record. {changes.length} change{changes.length === 1 ? '' : 's'}.</p>
      <Grid cols={[
        { label: 'Accept', width: '56px', get: (c: ParamChange) => { const i = changes.indexOf(c); return <input type="checkbox" aria-label={`Accept ${c.designator} ${c.parameter}`} checked={!off.has(i)} onChange={() => toggle(i)} />; } },
        { label: 'Designator', width: '90px', get: (c) => c.designator },
        { label: 'Parameter', width: '140px', get: (c) => c.parameter },
        { label: 'Action', width: '70px', get: (c) => (c.from === null ? 'Add' : 'Modify') },
        { label: 'Current Value', width: 'minmax(120px, 1fr)', get: (c) => <span class="muted">{c.from ?? ''}</span> },
        { label: 'Database Value', width: 'minmax(120px, 1fr)', get: (c) => <span class="warn">{c.to}</span> },
        { label: 'Document', width: '130px', get: (c) => c.sheet },
      ]} rows={changes} empty="No changes" />
    </Dialog>
  );
}
