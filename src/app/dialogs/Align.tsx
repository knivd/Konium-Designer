import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { AlignKind } from '../../editors/align';

/**
 * Edit › Align › Align… : Altium's Align Objects dialog — a horizontal and a vertical choice
 * (No Change, an edge, the centre, or Distribute equally) and Move primitives to grid.
 */
const H: [AlignKind | '', string][] = [['', 'No Change'], ['left', 'Left'], ['hCentre', 'Centre'], ['right', 'Right'], ['distributeH', 'Distribute equally']];
const V: [AlignKind | '', string][] = [['', 'No Change'], ['top', 'Top'], ['vCentre', 'Centre'], ['bottom', 'Bottom'], ['distributeV', 'Distribute equally']];
let last = { h: '' as AlignKind | '', v: '' as AlignKind | '', grid: false };

export function AlignDialog({ onOk }: { onOk: (h: AlignKind | null, v: AlignKind | null, grid: boolean) => void }) {
  const [st, setSt] = useState(last);
  const ok = () => { last = st; closeDialog(); onOk(st.h || null, st.v || null, st.grid); };
  const group = (title: string, name: 'h' | 'v', opts: [AlignKind | '', string][]) => (
    <fieldset><legend>{title}</legend>
      {opts.map(([v, l]) => <label key={l} class="al-opt"><input type="radio" name={`align-${name}`} checked={st[name] === v} onChange={() => setSt({ ...st, [name]: v })} />{l}</label>)}
    </fieldset>
  );
  return (
    <Dialog title="Align Objects" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="aligndlg"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="align-cols">{group('Horizontal Alignment', 'h', H)}{group('Vertical Alignment', 'v', V)}</div>
      <label class="al-grid"><input type="checkbox" checked={st.grid} onChange={(e) => setSt({ ...st, grid: (e.target as HTMLInputElement).checked })} />Move primitives to grid</label>
    </Dialog>
  );
}
