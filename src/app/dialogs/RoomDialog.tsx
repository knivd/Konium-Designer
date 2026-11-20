/**
 * Edit Room Definition [est: AD17's layout]: Name, Comment, Unique ID, Where The First Object
 * Matches (a query), the room's region (X1 Y1 X2 Y2 for a rectangle, its vertex count
 * otherwise), Layer (Top / Bottom), Keep Objects Inside / Outside, Lock components. OK is one
 * undo step.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { tick } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { cloneRule } from '../../formats/altium/rules';
import { editRooms, roomOutline, withOutline } from '../../model/rooms';
import { LenInput, Row, Check } from './pcbFields';

export function RoomDialog({ ed, rule }: { ed: PcbEditor; rule: number }) {
  const r0 = ed.doc.rules[rule]!;
  const outline = roomOutline(r0);
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  const rect = outline.length === 4 && new Set(xs).size === 2 && new Set(ys).size === 2;
  const [v, setV] = useState({
    name: r0.bag.get('NAME') ?? '', comment: r0.bag.get('COMMENT') ?? '', scope: r0.bag.get('SCOPE1EXPRESSION') ?? 'All',
    layer: /^bottom/i.test(r0.bag.get('LAYER') ?? '') ? 'BOTTOM' : 'TOP', confine: /out/i.test(r0.bag.get('CONFINEMENTSTYLE') ?? '') ? 'ConfineOut' : 'ConfineIn',
    lock: r0.bag.bool('LOCKCOMPONENTS'), x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys),
  });
  const o = ed.origin();
  const ok = () => {
    let r = cloneRule(r0);
    if (rect) r = withOutline(r, [{ x: v.x1, y: v.y1 }, { x: v.x2, y: v.y1 }, { x: v.x2, y: v.y2 }, { x: v.x1, y: v.y2 }]);
    r.bag.set('NAME', v.name.trim() || 'RoomDefinition'); r.bag.set('COMMENT', v.comment); r.bag.set('SCOPE1EXPRESSION', v.scope.trim() || 'All');
    r.bag.set('LAYER', v.layer); r.bag.set('CONFINEMENTSTYLE', v.confine); r.bag.set('LOCKCOMPONENTS', v.lock ? 'TRUE' : 'FALSE');
    ed.undo.transact(`Edit room ${v.name}`, (tx) => tx.add(editRooms(ed.doc, { set: new Map([[rule, r]]) })));
    tick.value++; ed.invalidate();
    closeDialog();
  };
  const unit = ed.units() === 'mm' ? 'mm' : 'mil';
  const coord = (label: string, k: 'x1' | 'y1' | 'x2' | 'y2') => (
    <Row label={label}><LenInput ed={ed} label={label} value={v[k] - (k[0] === 'x' ? o.x : o.y)} onChange={(c) => setV({ ...v, [k]: c + (k[0] === 'x' ? o.x : o.y) })} /></Row>
  );
  return (
    <Dialog title={`Edit Room Definition [${unit}]`} width={560} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="room-head">
        <Row label="Name"><input type="text" aria-label="Name" value={v.name} onInput={(e) => setV({ ...v, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
        <Row label="Comment"><input type="text" aria-label="Comment" value={v.comment} onInput={(e) => setV({ ...v, comment: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
        <Row label="Unique ID"><span class="muted">{r0.bag.get('UNIQUEID') ?? ''}</span></Row>
      </div>
      <fieldset class="pd-group"><legend>Where The First Object Matches</legend>
        <Row label="Full Query"><input type="text" aria-label="Full Query" value={v.scope} onInput={(e) => setV({ ...v, scope: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
      </fieldset>
      <fieldset class="pd-group"><legend>Constraints</legend>
        {rect ? <>{coord('X1', 'x1')}{coord('Y1', 'y1')}{coord('X2', 'x2')}{coord('Y2', 'y2')}</> : <p class="muted small">A polygonal room of {outline.length} vertices (Design › Rooms › Edit Polygonal Room Vertices).</p>}
        <Row label="Layer"><select aria-label="Layer" value={v.layer} onChange={(e) => setV({ ...v, layer: (e.target as HTMLSelectElement).value })}><option value="TOP">Top Layer</option><option value="BOTTOM">Bottom Layer</option></select></Row>
        <Row label="Confinement"><select aria-label="Confinement" value={v.confine} onChange={(e) => setV({ ...v, confine: (e.target as HTMLSelectElement).value })}>
          <option value="ConfineIn">Keep Objects Inside</option><option value="ConfineOut">Keep Objects Outside</option></select></Row>
        <Check label="Lock Components" checked={v.lock} onChange={(c) => setV({ ...v, lock: c })} />
      </fieldset>
    </Dialog>
  );
}
