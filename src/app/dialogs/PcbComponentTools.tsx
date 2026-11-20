import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import type { ApplicableRule } from '../../model/drc';
import type { ReannotateOrder } from '../../model/pcbPlacement';

/** Altium's text autoposition codes: 0 manual, then top / centre / bottom down each column, left to right. */
export const AUTOPOS: { code: number; label: string }[] = [
  { code: 1, label: 'Top-Left' }, { code: 4, label: 'Top-Centre' }, { code: 7, label: 'Top-Right' },
  { code: 2, label: 'Centre-Left' }, { code: 5, label: 'Centre' }, { code: 8, label: 'Centre-Right' },
  { code: 3, label: 'Bottom-Left' }, { code: 6, label: 'Bottom-Centre' }, { code: 9, label: 'Bottom-Right' },
];

function PosGrid({ name, value, set }: { name: string; value: number; set: (v: number) => void }) {
  return (
    <fieldset class="ctp-grid"><legend>{name}</legend>
      <div class="ctp-cells" role="radiogroup" aria-label={name}>
        {AUTOPOS.map((p) => <label key={p.code} title={p.label} class="ctp-cell"><input type="radio" name={`ctp-${name}`} checked={value === p.code} aria-label={`${name} ${p.label}`} onChange={() => set(p.code)} /></label>)}
      </div>
      <label class="do-check"><input type="radio" name={`ctp-${name}`} checked={value === 0} onChange={() => set(0)} />Manual</label>
    </fieldset>
  );
}

/**
 * Tools › Component Placement › Position Component Text: where the designator and the comment
 * sit round each selected component (Manual leaves them be).
 */
export function ComponentTextPositionDialog({ designator, comment, onOk }: { designator: number; comment: number; onOk: (d: number, c: number) => void }) {
  const [d, setD] = useState(designator);
  const [c, setC] = useState(comment);
  const ok = () => { closeDialog(); onOk(d, c); return false; };
  return (
    <Dialog title="Component Text Position" width={460} onClose={closeDialog} onAccept={ok} class="ctp"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="ctp-cols"><PosGrid name="Designator" value={d} set={setD} /><PosGrid name="Comment" value={c} set={setC} /></div>
    </Dialog>
  );
}

const ORDERS: [ReannotateOrder, string][] = [
  ['xy', 'By Ascending X Then Ascending Y'], ['x-y', 'By Ascending X Then Descending Y'],
  ['yx', 'By Ascending Y Then Ascending X'], ['-yx', 'By Descending Y Then Ascending X'], ['position', 'Name from Position'],
];

/** Tools › Re-Annotate: the order to number components in, the renames it gives, OK applies them (one undo step). */
export function ReannotateDialog({ preview, onOk }: { preview: (o: ReannotateOrder) => { from: string; to: string }[]; onOk: (o: ReannotateOrder) => void }) {
  const [order, setOrder] = useState<ReannotateOrder>('xy');
  const rows = useMemo(() => preview(order).filter((r) => r.from !== r.to), [order]);
  const ok = () => { closeDialog(); onOk(order); return false; };
  return (
    <Dialog title="Positional Re-Annotate" width={640} height={520} onClose={closeDialog} onAccept={ok} class="reannotate"
      footer={<><span class="muted small">{rows.length} designator{rows.length === 1 ? '' : 's'} change</span><span class="spacer" /><button class="btn default" onClick={ok} disabled={!rows.length}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="ra-cols">
        <fieldset><legend>Annotation Order</legend>
          {ORDERS.map(([k, l], i) => <label key={k} class="do-check"><input type="radio" name="ra-order" checked={order === k} onChange={() => setOrder(k)} />{i + 1}  {l}</label>)}
        </fieldset>
        <div class="ra-list"><Grid rows={rows} empty="Nothing to rename: the designators already follow this order."
          cols={[{ label: 'Current', width: '1fr', get: (r: { from: string; to: string }) => r.from }, { label: 'New', width: '1fr', get: (r) => r.to }]} /></div>
      </div>
    </Dialog>
  );
}

/** Right-click › Applicable Unary / Binary Rules: the rules that take the object(s), the winner of each kind marked. */
export function ApplicableRulesDialog({ title, subject, rules }: { title: string; subject: string; rules: ApplicableRule[] }) {
  return (
    <Dialog title={title} width={760} height={460} onClose={closeDialog} class="applicable"
      footer={<><span class="muted small">{subject}</span><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <Grid rows={rules} empty="No rule applies." rowClass={(r) => (r.wins ? 'ar-wins' : 'muted')}
        cols={[{ label: 'Rule Kind', width: '160px', get: (r: ApplicableRule) => r.kind },
          { label: 'Name', width: 'minmax(120px, 1fr)', get: (r) => r.name },
          { label: 'Priority', width: '60px', align: 'right', get: (r) => r.priority },
          { label: 'Scope', width: 'minmax(160px, 1.4fr)', get: (r) => r.scope },
          { label: 'Applies', width: '70px', get: (r) => (r.wins ? 'Yes' : 'Overridden') }]} />
    </Dialog>
  );
}
