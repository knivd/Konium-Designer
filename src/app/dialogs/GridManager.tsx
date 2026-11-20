/**
 * Options › Grid Manager, Grid Properties and Guide Manager [est: laid out from AD17's]. The
 * Global Board Snap Grid first, then Cartesian and Polar grids over their areas (the first
 * enabled one under the cursor snaps); the work guides with their kind, place and Enabled.
 * OK writes them to the board in one undo step.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { tick } from '../state';
import { settings, updateSettings } from '../../core/settings';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { editBoard } from '../../model/pcbBoard';
import { writeGrids, writeGuides, type Guide, type GuideKind, type LocalGrid } from '../../model/gridGuides';
import { formatCoord } from '../../core/units';
import { Check, LenInput, Row } from './pcbFields';
import { numIn } from './numIn';

const mil = (n: number) => Math.round(n * 10_000);
const footer = (ok: () => void) => <><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

export function saveGrids(ed: PcbEditor, grids: LocalGrid[], label = 'Grid Manager'): void {
  ed.undo.transact(label, (tx) => tx.add(editBoard(ed.doc, (b) => writeGrids(b, grids))));
  ed.invalidate(); tick.value++;
}
export function saveGuides(ed: PcbEditor, guides: Guide[], label = 'Guide Manager'): void {
  ed.undo.transact(label, (tx) => tx.add(editBoard(ed.doc, (b) => writeGuides(b, guides))));
  ed.invalidate(); tick.value++;
}

/** A new Cartesian grid over the board's area, or a Polar one round its centre. */
export function newGrid(ed: PcbEditor, kind: 'cartesian' | 'polar', n: number): LocalGrid {
  const o = ed.doc.board.outline.length ? ed.doc.board.outline : [{ x: 0, y: 0 }, { x: mil(1000), y: mil(1000) }];
  const xs = o.map((p) => p.x), ys = o.map((p) => p.y);
  const area = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  if (kind === 'cartesian') return { kind, name: `New Cartesian Grid ${n}`, enabled: true, area, stepX: mil(25), stepY: mil(25), dots: false };
  return { kind, name: `New Polar Grid ${n}`, enabled: true, dots: false, centre: { x: Math.round((area.minX + area.maxX) / 2), y: Math.round((area.minY + area.maxY) / 2) },
    radialStep: mil(100), angleStep: 15, r0: 0, r1: Math.round(Math.min(area.maxX - area.minX, area.maxY - area.minY) / 2), a0: 0, a1: 360 };
}

export function GridManagerDialog({ ed }: { ed: PcbEditor }) {
  const [grids, setGrids] = useState<LocalGrid[]>(() => ed.gridsAndGuides().grids.map((g) => ({ ...g })));
  const [sel, setSel] = useState(-1);
  const u = ed.units();
  const ok = () => { saveGrids(ed, grids); closeDialog(); };
  const edit = (i: number) => {
    if (i < 0) { showDialog(GridPropertiesDialog, { ed, grid: null, onOk: () => {} }); return; }
    showDialog(GridPropertiesDialog, { ed, grid: grids[i]!, onOk: (g: LocalGrid) => setGrids(grids.map((x, k) => (k === i ? g : x))) });
  };
  return (
    <Dialog title="Grid Manager" width={640} height={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <div class="grid" style={{ '--cols': '50px 1fr 80px 110px 60px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Priority</span><span>Name</span><span>Type</span><span>Step</span><span>Enabled</span></div>
        <div class="grid-body">
          <div class={`grid-row${sel === -1 ? ' on' : ''}`} onClick={() => setSel(-1)} onDblClick={() => edit(-1)}>
            <span>{grids.length + 1}</span><span>Global Board Snap Grid</span><span>Cartesian</span><span>{formatCoord(ed.gridSize(), u)}</span><span><input type="checkbox" checked disabled aria-label="Global enabled" /></span>
          </div>
          {grids.map((g, i) => (
            <div key={i} class={`grid-row${sel === i ? ' on' : ''}`} onClick={() => setSel(i)} onDblClick={() => edit(i)}>
              <span>{i + 1}</span><span>{g.name}</span><span>{g.kind === 'polar' ? 'Polar' : 'Cartesian'}</span>
              <span>{g.kind === 'polar' ? `${formatCoord(g.radialStep, u)}, ${g.angleStep}°` : formatCoord(g.stepX, u)}</span>
              <span><input type="checkbox" aria-label={`Enabled ${g.name}`} checked={g.enabled} onChange={(e) => setGrids(grids.map((x, k) => (k === i ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x)))} /></span>
            </div>
          ))}
        </div>
      </div>
      <div class="gm-buttons">
        <button class="btn" onClick={() => { setGrids([...grids, newGrid(ed, 'cartesian', grids.length + 1)]); setSel(grids.length); }}>Add Cartesian Grid</button>
        <button class="btn" onClick={() => { setGrids([...grids, newGrid(ed, 'polar', grids.length + 1)]); setSel(grids.length); }}>Add Polar Grid</button>
        <button class="btn" disabled={sel < 0} onClick={() => { setGrids(grids.filter((_, k) => k !== sel)); setSel(-1); }}>Delete</button>
        <button class="btn" onClick={() => edit(sel)}>Properties</button>
        <button class="btn" disabled={sel <= 0} onClick={() => { const n = [...grids]; [n[sel - 1], n[sel]] = [n[sel]!, n[sel - 1]!]; setGrids(n); setSel(sel - 1); }}>Increase Priority</button>
      </div>
    </Dialog>
  );
}

/** Grid Properties: one grid (null: the Global Board Snap Grid, its step and look). */
export function GridPropertiesDialog({ ed, grid, onOk }: { ed: PcbEditor; grid: LocalGrid | null; onOk: (g: LocalGrid) => void }) {
  const [g, setG] = useState<LocalGrid | null>(grid ? { ...grid } : null);
  const [step, setStep] = useState(ed.gridSize());
  const [dots, setDots] = useState(settings.pcbGridStyle === 'dots');
  const ok = () => { if (g) onOk(g); else { ed.setGrid(step); updateSettings({ pcbGridStyle: dots ? 'dots' : 'lines' }); ed.invalidate(); } closeDialog(); };
  const len = (label: string, v: number, set: (c: number) => void) => <Row label={label}><LenInput ed={ed} label={label} value={v} min={1} onChange={set} /></Row>;
  const o = ed.origin();
  const coord = (label: string, v: number, axis: 'x' | 'y', set: (c: number) => void) => <Row label={label}><LenInput ed={ed} label={label} value={v - o[axis]} onChange={(c) => set(c + o[axis])} /></Row>;
  const title = !g ? 'Cartesian Grid Editor [Global Board Snap Grid]' : g.kind === 'polar' ? `Polar Grid Editor [${g.name}]` : `Cartesian Grid Editor [${g.name}]`;
  return (
    <Dialog title={title} width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      {g && <Row label="Name"><input type="text" aria-label="Name" value={g.name} onInput={(e) => setG({ ...g, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></Row>}
      {!g && <fieldset class="pd-group"><legend>Steps</legend>{len('Step X', step, setStep)}<Check label="Dots" checked={dots} onChange={setDots} /></fieldset>}
      {g?.kind === 'cartesian' && <>
        <fieldset class="pd-group"><legend>Steps</legend>{len('Step X', g.stepX, (c) => setG({ ...g, stepX: c }))}{len('Step Y', g.stepY, (c) => setG({ ...g, stepY: c }))}</fieldset>
        <fieldset class="pd-group"><legend>Area</legend>
          {coord('X1', g.area.minX, 'x', (c) => setG({ ...g, area: { ...g.area, minX: c } }))}{coord('Y1', g.area.minY, 'y', (c) => setG({ ...g, area: { ...g.area, minY: c } }))}
          {coord('X2', g.area.maxX, 'x', (c) => setG({ ...g, area: { ...g.area, maxX: c } }))}{coord('Y2', g.area.maxY, 'y', (c) => setG({ ...g, area: { ...g.area, maxY: c } }))}
        </fieldset>
      </>}
      {g?.kind === 'polar' && <>
        <fieldset class="pd-group"><legend>Steps</legend>
          <Row label="Angular Step"><input type="number" class="pd-val" aria-label="Angular Step" value={g.angleStep} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setG({ ...g, angleStep: Math.max(0.1, Number((e.target as HTMLInputElement).value) || 15) })} /> °</Row>
          {len('Radial Step', g.radialStep, (c) => setG({ ...g, radialStep: c }))}
        </fieldset>
        <fieldset class="pd-group"><legend>Setup</legend>
          {coord('Origin X', g.centre.x, 'x', (c) => setG({ ...g, centre: { ...g.centre, x: c } }))}{coord('Origin Y', g.centre.y, 'y', (c) => setG({ ...g, centre: { ...g.centre, y: c } }))}
          <Row label="Start Angle"><input type="number" class="pd-val" aria-label="Start Angle" value={g.a0} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setG({ ...g, a0: numIn(e, g.a0) })} /></Row>
          <Row label="End Angle"><input type="number" class="pd-val" aria-label="End Angle" value={g.a1} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setG({ ...g, a1: Number((e.target as HTMLInputElement).value) || 360 })} /></Row>
          {len('Min Radius', Math.max(1, g.r0), (c) => setG({ ...g, r0: c }))}{len('Max Radius', g.r1, (c) => setG({ ...g, r1: c }))}
        </fieldset>
      </>}
      {g && <Check label="Enabled" checked={g.enabled} onChange={(v) => setG({ ...g, enabled: v })} />}
    </Dialog>
  );
}

const KINDS: [GuideKind, string][] = [['h', 'Horizontal'], ['v', 'Vertical'], ['p45', '+45 Degree'], ['m45', '-45 Degree'], ['point', 'Point']];

export function GuideManagerDialog({ ed }: { ed: PcbEditor }) {
  const [guides, setGuides] = useState<Guide[]>(() => ed.gridsAndGuides().guides.map((g) => ({ ...g, at: { ...g.at } })));
  const [sel, setSel] = useState(-1);
  const ok = () => { saveGuides(ed, guides); closeDialog(); };
  const o = ed.origin(), cur = ed.cursor;
  const set = (i: number, g: Partial<Guide>) => setGuides(guides.map((x, k) => (k === i ? { ...x, ...g } : x)));
  return (
    <Dialog title="Guide Manager" width={620} height={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <div class="grid" style={{ '--cols': '120px 1fr 1fr 60px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Type</span><span>X</span><span>Y</span><span>Enabled</span></div>
        <div class="grid-body">
          {guides.map((g, i) => (
            <div key={i} class={`grid-row${sel === i ? ' on' : ''}`} onClick={() => setSel(i)}>
              <span>{KINDS.find(([k]) => k === g.kind)?.[1]}</span>
              <span><LenInput ed={ed} label={`Guide ${i + 1} X`} value={g.at.x - o.x} onChange={(c) => set(i, { at: { ...g.at, x: c + o.x } })} /></span>
              <span><LenInput ed={ed} label={`Guide ${i + 1} Y`} value={g.at.y - o.y} onChange={(c) => set(i, { at: { ...g.at, y: c + o.y } })} /></span>
              <span><input type="checkbox" aria-label={`Guide ${i + 1} enabled`} checked={g.enabled} onChange={(e) => set(i, { enabled: (e.target as HTMLInputElement).checked })} /></span>
            </div>
          ))}
          {!guides.length && <div class="grid-row muted"><span>No guides</span><span /><span /><span /></div>}
        </div>
      </div>
      <div class="gm-buttons">
        {KINDS.map(([k, label]) => <button key={k} class="btn" onClick={() => { setGuides([...guides, { kind: k, at: { x: Math.round(cur.x), y: Math.round(cur.y) }, enabled: true }]); setSel(guides.length); }}>Add {label}</button>)}
        <button class="btn" disabled={sel < 0} onClick={() => { setGuides(guides.filter((_, k) => k !== sel)); setSel(-1); }}>Delete</button>
      </div>
    </Dialog>
  );
}
