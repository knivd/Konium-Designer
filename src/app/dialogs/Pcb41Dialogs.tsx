/**
 * Dialogs of 26.041 [est: laid out from AD17's]: Update From PCB Libraries, Add Subnet Jumpers,
 * Configure Physical Nets and the Draftsman sheet.
 */
import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick } from '../state';
import { Check, LenInput, Row } from './pcbFields';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { PcbDocument } from '../../model/pcb';
import type { FootprintFinder } from '../../model/pcbEco';
import { swapFootprint } from '../../model/pcbEco';
import { libSyncRows, type LibSyncRow } from '../../model/libSync';
import { physicalNets, applyPhysicalNets } from '../../model/physicalNets';
import { mm, parseLength } from '../../core/units';
import { settings, updateSettings } from '../../core/settings';

const footer = (ok: () => void, label = 'OK', disabled = false) => <><span class="spacer" /><button class="btn default" disabled={disabled} onClick={ok}>{label}</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

/** Tools › Update From PCB Libraries: the board's footprints against the libraries'; the ticked ones taken from the library. */
export function LibSyncDialog({ ed, find }: { ed: PcbEditor; find: FootprintFinder }) {
  const rows = useMemo(() => libSyncRows(ed.doc, find), [ed, find]);
  const [on, setOn] = useState<Set<number>>(() => new Set(rows.filter((r) => r.status === 'Different').map((r) => r.component)));
  const [showAll, setShowAll] = useState(false);
  const shown = rows.filter((r) => showAll || r.status === 'Different');
  const ok = () => {
    const todo = rows.filter((r) => on.has(r.component) && r.status === 'Different');
    closeDialog();
    if (!todo.length) { notify('Every footprint matches its library'); return; }
    let n = 0;
    ed.undo.transact('Update from PCB libraries', (tx) => {
      for (const r of todo) { const f = find(r.footprint, ed.doc.components[r.component]!.bag.get('SOURCEFOOTPRINTLIBRARY') || undefined) ?? find(r.footprint); if (f) { tx.add(swapFootprint(ed.doc, r.component, f)); n++; } }
    });
    ed.invalidate(); tick.value++;
    notify(`${n} footprint${n === 1 ? '' : 's'} updated from the libraries`);
  };
  const tickRow = (r: LibSyncRow) => { const s = new Set(on); if (s.has(r.component)) s.delete(r.component); else s.add(r.component); setOn(s); };
  return (
    <Dialog title="Update From PCB Libraries" width={760} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, 'Update')}>
      <p class="muted small">{rows.filter((r) => r.status === 'Different').length} of {rows.length} components differ from their library footprint; {rows.filter((r) => r.status === 'Not Found').length} not found. Placement, designators, comments and pad nets are kept.</p>
      <label class="out-check"><input type="checkbox" checked={showAll} onChange={() => setShowAll(!showAll)} />Show every component</label>
      <div class="grid libsync" style={{ '--cols': '40px 90px 1fr 1fr 90px 1.4fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Update</span><span>Designator</span><span>Footprint</span><span>Library</span><span>Status</span><span>Difference</span></div>
        <div class="grid-body" style={{ maxHeight: '330px' }}>
          {shown.map((r) => <div key={r.component} class="grid-row"><span><input type="checkbox" aria-label={`Update ${r.designator}`} disabled={r.status !== 'Different'} checked={on.has(r.component) && r.status === 'Different'} onChange={() => tickRow(r)} /></span>
            <span>{r.designator}</span><span>{r.footprint}</span><span>{r.library}</span><span class={r.status === 'Different' ? 'warn' : 'muted'}>{r.status}</span><span class="muted">{r.why}</span></div>)}
        </div>
      </div>
    </Dialog>
  );
}

/** Route › Add Subnet Jumpers: the longest jumper allowed (the layer is the current one). */
export function SubnetJumpersDialog({ ed, onOk }: { ed: PcbEditor; onOk: (maxLength: number) => void }) {
  // (it starts from Preferred Subnet Jumper Length, Interactive Routing's, and the length used is kept there for the next time)
  const [max, setMax] = useState(parseLength(settings.pcbSubnetJumperLength) ?? mm(10));
  const ok = () => { closeDialog(); updateSettings({ pcbSubnetJumperLength: `${+(max / 10_000).toFixed(4)}mil` }); onOk(max); };
  return (
    <Dialog title="Subnet Jumpers" width={380} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <Row label="Maximum Jumper Length"><LenInput ed={ed} label="Maximum Jumper Length" value={max} min={1} onChange={setMax} /></Row>
      <p class="muted small">Jumpers go on {ed.layerLabel(ed.currentLayer)}, joining the nearest points of each net's pieces.</p>
    </Dialog>
  );
}

/** Design › Netlist › Configure Physical Nets: each piece of connected copper and the net it takes. */
export function PhysicalNetsDialog({ ed }: { ed: PcbEditor }) {
  const doc: PcbDocument = ed.doc;
  const rows = useMemo(() => physicalNets(doc), [doc]);
  const [names, setNames] = useState<string[]>(() => rows.map((r) => r.suggested));
  const [all, setAll] = useState(false);
  const ok = () => {
    closeDialog();
    const choices = rows.map((r, i) => ({ prims: r.prims, net: names[i]! })).filter((c, i) => rows[i]!.conflict || c.net !== rows[i]!.suggested || rows[i]!.nets.join() !== c.net);
    let n = 0;
    ed.undo.transact('Configure physical nets', (tx) => { n = applyPhysicalNets(doc, choices, (c) => tx.add(c)); });
    ed.invalidate(); tick.value++;
    notify(n ? `${n} objects put on their physical nets` : 'Every piece of copper already has its net');
  };
  const list = rows.map((r, i) => ({ r, i })).filter(({ r }) => all || r.conflict);
  return (
    <Dialog title="Configure Physical Nets" width={760} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <p class="muted small">{rows.length} pieces of connected copper; {rows.filter((r) => r.conflict).length} with no net or more than one.</p>
      <Check label="Show every piece" checked={all} onChange={setAll} />
      <div class="grid" style={{ '--cols': '1.4fr 1fr 1fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Pads</span><span>Nets now</span><span>Physical net</span></div>
        <div class="grid-body" style={{ maxHeight: '330px' }}>
          {list.map(({ r, i }) => <div key={i} class="grid-row"><span title={r.pads.join(', ')}>{r.pads.slice(0, 6).join(', ')}{r.pads.length > 6 ? ` … (${r.pads.length})` : ''}</span>
            <span class={r.conflict ? 'warn' : 'muted'}>{r.nets.map((n) => n || 'No Net').join(', ')}</span>
            <span><input type="text" aria-label={`Physical net ${i + 1}`} value={names[i]} onInput={(e) => { const v = [...names]; v[i] = (e.target as HTMLInputElement).value; setNames(v); }} onKeyDown={(e) => e.stopPropagation()} /></span></div>)}
        </div>
      </div>
    </Dialog>
  );
}

/** File › New › Draftsman Document: the drawing's contents chosen, the sheet previewed, printed (or saved as PDF). */
