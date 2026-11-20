/**
 * Board Planning Mode's dialogs, as AD17's: Board Region (double-click a region: its Name, Layer
 * Stack and 3D Locked — the region that stays put when the board folds) and Bending Line
 * (double-click one: Radius, Bending Angle and Affected Area Width, any two setting the third,
 * and Fold Index). OK is one undo step. A region put on a flex stack gets a bending line across
 * its middle, as AD adds one; put back on a rigid one, its bending lines go [est]. Custom Coverlays
 * (a flex region whose stack has a Coverlay layer): its coverlay drawn by hand; Advanced Rigid-Flex
 * adds Priority (which region shows where they overlap).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { LenInput, Row, Check } from './pcbFields';
import { UNITS_PER_MM, trimNum } from '../../core/units';
import { affectedWidth, boardRegions, centreBend, isAdvanced, polyArea, setRigidFlex, splitLines, substacks, withRegion, type BendingLine } from '../../model/rigidFlex';
import { coverlayLayers, customCoverlayShapes, regionHasCoverlay } from '../../model/coverlay';

export function BoardRegionDialog({ ed, index }: { ed: PcbEditor; index: number }) {
  const r = boardRegions(ed.doc)[index];
  const subs = substacks(ed.doc);
  const [v, setV] = useState({ name: r?.name ?? '', stackId: r?.stackId ?? subs[0]?.id ?? '', locked: !!r?.locked3d, priority: String(r?.priority ?? 0), custom: !!r?.customCoverlay });
  if (!r) return null;
  const adv = isAdvanced(ed.doc);
  const coverable = coverlayLayers(ed.doc).some((c) => regionHasCoverlay(ed.doc, { ...r, stackId: v.stackId }, c));
  const area = Math.abs(polyArea(r.outline)) / UNITS_PER_MM ** 2;
  const ok = () => {
    if (!v.name.trim()) { notify('The region needs a name', 'error'); return; }
    const priority = Number(v.priority);
    if (adv && !Number.isInteger(priority)) { notify('Priority: a whole number', 'error'); return; }
    const custom = v.custom && coverable;
    if (v.name.trim() === r.name && v.stackId === r.stackId && v.locked === r.locked3d && (!adv || priority === (r.priority ?? 0)) && custom === !!r.customCoverlay) { closeDialog(); return; }
    const flex = subs.find((s) => s.id === v.stackId)?.isFlex ?? false;
    const bends: BendingLine[] = !flex ? [] : r.bends.length ? r.bends : [centreBend(r.outline, splitLines(ed.doc))].filter((b): b is BendingLine => !!b);
    // Custom Coverlays on: the shapes start as the automatic coverlay; off: back to it
    const cover = custom === !!r.customCoverlay ? {} : custom ? { customCoverlay: true, coverlays: customCoverlayShapes(ed.doc, { ...r, stackId: v.stackId }) } : { customCoverlay: false, coverlays: [] };
    const next = withRegion(ed.doc, index, { name: v.name.trim(), stackId: v.stackId, locked3d: v.locked, bends, ...(adv ? { priority } : {}), ...cover });
    ed.undo.transact(`Board region ${v.name.trim()}`, (tx) => tx.add(setRigidFlex(ed.doc, next)));
    tick.value++; ed.invalidate();
    closeDialog();
  };
  return (
    <Dialog title="Board Region" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="board-region"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Row label="Name"><input type="text" aria-label="Name" value={v.name} onInput={(e) => setV({ ...v, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
      <Row label="Layer Stack"><select aria-label="Layer Stack" value={v.stackId} onChange={(e) => setV({ ...v, stackId: (e.target as HTMLSelectElement).value })}>
        {subs.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isFlex ? ' (flex)' : ''}</option>)}</select></Row>
      <Check label="3D Locked" checked={v.locked} onChange={(c) => setV({ ...v, locked: c })} />
      {adv && <Row label="Priority"><input type="text" aria-label="Priority" value={v.priority} onInput={(e) => setV({ ...v, priority: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>}
      <Check label="Custom Coverlays" checked={v.custom && coverable} disabled={!coverable} onChange={(c) => setV({ ...v, custom: c })} />
      <p class="small muted">3D Locked: the region that stays put when the board folds (View › Fold/Unfold).{adv ? ' Priority: drawn over regions of lower priority where they overlap.' : ''}{' '}
        Custom Coverlays: the coverlay is the polygons drawn for it (Design › Place Coverlay Polygon / Cutout){coverable ? '' : ' — its layer stack has no Coverlay layer'}. Area {trimNum(area.toFixed(2))} mm², {r.outline.length} vertices.</p>
    </Dialog>
  );
}

export function BendingLineDialog({ ed, region, index }: { ed: PcbEditor; region: number; index: number }) {
  const r = boardRegions(ed.doc)[region], l = r?.bends[index];
  const [v, setV] = useState({ radius: l?.radius ?? 0, angle: String(l?.angle ?? 90), fold: String(l?.foldIndex ?? 1) });
  if (!r || !l) return null;
  const angle = Number(v.angle);
  const width = Number.isFinite(angle) ? affectedWidth({ ...l, radius: v.radius, angle }) : 0;
  const ok = () => {
    const fold = Number(v.fold);
    if (!Number.isFinite(angle) || Math.abs(angle) > 180 || angle === 0) { notify('Bending Angle: a number of degrees, up to 180 either way', 'error'); return; }
    if (!Number.isInteger(fold)) { notify('Fold Index: a whole number', 'error'); return; }
    const bends = r.bends.map((b, j) => (j === index ? { ...b, radius: v.radius, angle, foldIndex: fold } : b));
    ed.undo.transact('Bending line', (tx) => tx.add(setRigidFlex(ed.doc, withRegion(ed.doc, region, { bends }))));
    tick.value++; ed.invalidate();
    closeDialog();
  };
  return (
    <Dialog title="Bending Line" width={400} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="bending-line"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Row label="Radius"><LenInput ed={ed} label="Radius" value={v.radius} min={0} onChange={(c) => setV({ ...v, radius: c })} /></Row>
      <Row label="Bending Angle"><input type="text" aria-label="Bending Angle" value={v.angle} onInput={(e) => setV({ ...v, angle: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
      <Row label="Affected Area Width"><LenInput ed={ed} label="Affected Area Width" value={Math.round(width)} min={0}
        onChange={(c) => { if (Number.isFinite(angle) && angle !== 0) setV({ ...v, radius: Math.round(c / (Math.abs(angle) * Math.PI / 180)) }); }} /></Row>
      <Row label="Fold Index"><input type="text" aria-label="Fold Index" value={v.fold} onInput={(e) => setV({ ...v, fold: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>
      <p class="small muted">Any two of Radius, Bending Angle and Affected Area Width set the third. Lower Fold Indexes fold first; a positive angle folds the far side up [est].</p>
    </Dialog>
  );
}
