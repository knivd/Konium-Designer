import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { updateSettings } from '../../core/settings';
import { DRAW_KIND_NAMES, DRAW_ORDER, drawOrder, type DrawKind } from '../../model/layers';

/**
 * Preferences › PCB Editor › Display › Layer Drawing Order, as AD's: the kinds of layer, the first
 * drawn on top; Promote and Demote move the one selected up and down (or ↑ and ↓), Default puts
 * back AD's order.
 */
export function LayerDrawingOrderDialog() {
  const [list, setList] = useState<DrawKind[]>(() => drawOrder());
  const [sel, setSel] = useState(0);
  const move = (d: -1 | 1) => {
    const j = sel + d;
    if (j < 0 || j >= list.length) return;
    const n = [...list];
    [n[sel], n[j]] = [n[j]!, n[sel]!];
    setList(n); setSel(j);
  };
  const ok = () => { updateSettings({ pcbLayerDrawOrder: [...list] }); closeDialog(); };
  return (
    <Dialog title="Layer Drawing Order" width={300} height={490} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="layer-order"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="as-tree lo-list" role="listbox" aria-label="Layer drawing order" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((i) => Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))); } }}>
        {list.map((k, i) => <div key={k} role="option" aria-selected={i === sel} class={`as-item${i === sel ? ' on' : ''}`} onMouseDown={() => setSel(i)}>{DRAW_KIND_NAMES[k]}</div>)}
      </div>
      <div class="sync-buttons lo-buttons">
        <button class="btn" disabled={sel === 0} onClick={() => move(-1)}>Promote</button>
        <button class="btn" disabled={sel === list.length - 1} onClick={() => move(1)}>Demote</button>
        <button class="btn" onClick={() => { setList([...DRAW_ORDER]); setSel(0); }}>Default</button>
      </div>
    </Dialog>
  );
}
