/**
 * The board's right-click Options dialogs kept in Board6: the Drill-Pair Manager (LAYERPAIRn),
 * Drill Symbols (DRILLSYMBOLASENUM, DRILLSYMBOLSIZE) and Board Layer Sets (LAYERSETn) — each
 * edited as a copy, OK one undo step.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { isSignal, L, type LayerId } from '../../model/layers';
import { editBoard } from '../../model/pcbBoard';
import { readDrillPairs, readLayerSets, setLabel, writeDrillPairs, writeLayerSets, type DrillPair, type LayerSet } from '../../model/layerSets';
import { formatCoord, parseLength, mil } from '../../core/units';
import { notify } from '../state';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ─── Drill-Pair Manager ────────────────────────────────────────────────────────────── */

export function DrillPairManagerDialog({ ed }: { ed: PcbEditor }) {
  const [pairs, setPairs] = useState<DrillPair[]>(() => readDrillPairs(ed.doc.board.bag));
  const [sel, setSel] = useState<number | null>(pairs.length ? 0 : null);
  const copper = ed.doc.board.copperStack.filter(isSignal);
  const order = (l: LayerId) => copper.indexOf(l);
  const used = new Map<string, number>();
  for (const p of ed.doc.prims) if (p.kind === 'via') { const k = `${p.layerStart}-${p.layerEnd}`; used.set(k, (used.get(k) ?? 0) + 1); }
  const ok = () => {
    ed.undo.transact('Edit drill pairs', (tx) => tx.add(editBoard(ed.doc, (b) => writeDrillPairs(b, pairs))));
    closeDialog();
  };
  const edit = (i: number | null) => showDialog(DrillPairDialog, { ed, pair: i === null ? { low: copper[0] ?? L.TOP, high: copper.at(-1) ?? L.BOTTOM, guide: false, drawing: false } : pairs[i]!,
    onOk: (p: DrillPair) => {
      if (order(p.low) >= order(p.high)) { notify('The start layer must be above the stop layer', 'error'); return; }
      if (pairs.some((q, j) => j !== i && q.low === p.low && q.high === p.high)) { notify('That drill pair is there already', 'error'); return; }
      const n = i === null ? [...pairs, p] : pairs.map((q, j) => (j === i ? p : q));
      setPairs(n); setSel(i ?? n.length - 1);
    } });
  const missing = () => {
    const add: DrillPair[] = [];
    for (const k of used.keys()) {
      const [a, b] = k.split('-').map(Number) as [LayerId, LayerId];
      if (!pairs.some((p) => p.low === a && p.high === b) && !add.some((p) => p.low === a && p.high === b)) add.push({ low: a, high: b, guide: false, drawing: false });
    }
    if (!add.length) { notify('Every via span has its drill pair'); return; }
    setPairs([...pairs, ...add]);
    notify(`${plural(add.length, 'drill pair')} added`);
  };
  return (
    <Dialog title="Drill-Pair Manager" width={700} height={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="drillpairs"
      footer={<><button class="btn" onClick={() => edit(null)}>Add...</button><button class="btn" disabled={sel === null} onClick={() => { if (sel === null) return; setPairs(pairs.filter((_, j) => j !== sel)); setSel(null); }}>Delete</button>
        <button class="btn" disabled={sel === null} onClick={() => edit(sel)}>Properties...</button><button class="btn" onClick={missing}>Create Missing Drill Pairs</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="grid" style={{ '--cols': '1fr 1fr 90px 100px 70px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Start Layer</span><span>Stop Layer</span><span>Drill Guide</span><span>Drill Drawing</span><span>Vias</span></div>
        <div class="grid-body">
          {pairs.map((p, i) => (
            <div key={i} class={`grid-row${sel === i ? ' sel' : ''}`} onMouseDown={() => setSel(i)} onDblClick={() => edit(i)}>
              <span>{ed.layerLabel(p.low)}</span><span>{ed.layerLabel(p.high)}</span>
              <span><input type="checkbox" aria-label="Drill Guide" checked={p.guide} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, guide: (e.target as HTMLInputElement).checked } : q)))} /></span>
              <span><input type="checkbox" aria-label="Drill Drawing" checked={p.drawing} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, drawing: (e.target as HTMLInputElement).checked } : q)))} /></span>
              <span>{used.get(`${p.low}-${p.high}`) ?? 0}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function DrillPairDialog({ ed, pair, onOk }: { ed: PcbEditor; pair: DrillPair; onOk: (p: DrillPair) => void }) {
  const [p, setP] = useState(pair);
  const copper = ed.doc.board.copperStack.filter(isSignal);
  const ok = () => { closeDialog(); onOk(p); };
  const pick = (label: string, v: LayerId, set: (l: LayerId) => void) => (
    <label class="dlg-field"><span>{label}</span><select aria-label={label} value={String(v)} onChange={(e) => set(Number((e.target as HTMLSelectElement).value))}>
      {copper.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}</select></label>
  );
  return (
    <Dialog title="Drill-Pair Properties" width={360} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      {pick('Start Layer', p.low, (low) => setP({ ...p, low }))}
      {pick('Stop Layer', p.high, (high) => setP({ ...p, high }))}
      <label class="dlg-check"><input type="checkbox" checked={p.guide} onChange={(e) => setP({ ...p, guide: (e.target as HTMLInputElement).checked })} /> Drill Guide</label>
      <label class="dlg-check"><input type="checkbox" checked={p.drawing} onChange={(e) => setP({ ...p, drawing: (e.target as HTMLInputElement).checked })} /> Drill Drawing</label>
    </Dialog>
  );
}

/* ─── Drill Symbols ─────────────────────────────────────────────────────────────────── */

export function DrillSymbolsDialog({ ed }: { ed: PcbEditor }) {
  const b = ed.doc.board.bag;
  const [kind, setKind] = useState(b?.int('DRILLSYMBOLASENUM', 0) ?? 0);
  const [size, setSize] = useState(() => { const s = b?.int('DRILLSYMBOLSIZE', 0) ?? 0; return s > 0 ? s : mil(20); });
  const [text, setText] = useState<string | null>(null);
  const u = ed.units();
  const ok = () => {
    ed.undo.transact('Drill symbols', (tx) => tx.add(editBoard(ed.doc, (bb) => { bb.set('DRILLSYMBOLASENUM', String(kind)); bb.set('DRILLSYMBOLSIZE', String(size)); })));
    closeDialog();
  };
  return (
    <Dialog title="Drill Symbols" width={400} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <fieldset class="pd-group"><legend>Symbols</legend>
        {(['Graphic Symbols', 'Characters', 'Size Of Hole String'] as const).map((l, i) => (
          <label key={l} class="dlg-check"><input type="radio" name="dsym" checked={kind === i} onChange={() => setKind(i)} /> {l}</label>))}
      </fieldset>
      <label class="dlg-field"><span>Symbol Size</span>
        <input type="text" aria-label="Symbol Size" value={text ?? formatCoord(size, u, 3)} onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onBlur={(e) => { const t = (e.target as HTMLInputElement).value.trim(); const c = parseLength(/^[0-9.]+$/.test(t) ? `${t}${u}` : t); if (c && c > 0) setSize(Math.round(c)); setText(null); }}
          onKeyDown={(e) => e.stopPropagation()} /></label>
      <p class="muted small">Drill Drawings mark each hole size with these (prints and Gerber drill drawings).</p>
    </Dialog>
  );
}

/* ─── Board Layer Sets ──────────────────────────────────────────────────────────────── */

export function LayerSetsDialog({ ed }: { ed: PcbEditor }) {
  const [sets, setSets] = useState<LayerSet[]>(() => readLayerSets(ed.doc.board.bag));
  const [sel, setSel] = useState<number | null>(sets.length ? 0 : null);
  const ok = () => {
    ed.undo.transact('Board layer sets', (tx) => tx.add(editBoard(ed.doc, (b) => writeLayerSets(b, sets))));
    closeDialog();
  };
  const edit = (i: number | null) => showDialog(LayerSetDialog, { ed, set: i === null ? { name: 'New Layer Set', layers: [ed.currentLayer], active: ed.currentLayer, current: false, locked: false, flip: false } : sets[i]!,
    onOk: (s: LayerSet) => { const n = i === null ? [...sets, s] : sets.map((q, j) => (j === i ? s : q)); setSets(n); setSel(i ?? n.length - 1); } });
  const move = (d: -1 | 1) => { if (sel === null) return; const j = sel + d; if (j < 0 || j >= sets.length) return; const n = [...sets]; [n[sel], n[j]] = [n[j]!, n[sel]!]; setSets(n); setSel(j); };
  const cur = sel !== null ? sets[sel] : undefined;
  return (
    <Dialog title="Board Layer Sets" width={720} height={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="layersets"
      footer={<><button class="btn" onClick={() => edit(null)}>Add</button><button class="btn" disabled={!cur || cur.locked} onClick={() => { if (sel === null) return; setSets(sets.filter((_, j) => j !== sel)); setSel(null); }}>Delete</button>
        <button class="btn" disabled={!cur || cur.locked} onClick={() => edit(sel)}>Edit...</button><button class="btn" disabled={sel === null || sel === 0} onClick={() => move(-1)}>Move Up</button><button class="btn" disabled={sel === null || sel === sets.length - 1} onClick={() => move(1)}>Move Down</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="grid" style={{ '--cols': 'minmax(130px,1fr) minmax(200px,2fr) 110px 60px 70px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Name</span><span>Layers</span><span>Active Layer</span><span>Locked</span><span>Flip Board</span></div>
        <div class="grid-body">
          {sets.map((s, i) => (
            <div key={i} class={`grid-row${sel === i ? ' sel' : ''}`} onMouseDown={() => setSel(i)} onDblClick={() => { if (!s.locked) edit(i); }}>
              <span>{setLabel(s)}</span><span title={s.layers.map((l) => ed.layerLabel(l)).join(', ')}>{s.layers.map((l) => ed.layerLabel(l)).join(', ')}</span>
              <span>{s.active !== undefined ? ed.layerLabel(s.active) : ''}</span><span>{s.locked ? '✓' : ''}</span><span>{s.flip ? '✓' : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function LayerSetDialog({ ed, set, onOk }: { ed: PcbEditor; set: LayerSet; onOk: (s: LayerSet) => void }) {
  const [s, setS] = useState<LayerSet>({ ...set, layers: [...set.layers] });
  const all = ed.layers();
  const toggle = (l: LayerId, on: boolean) => setS({ ...s, layers: on ? [...s.layers, l].sort((a, b) => all.indexOf(a) - all.indexOf(b)) : s.layers.filter((x) => x !== l) });
  const ok = () => { if (!s.name.trim() || !s.layers.length) { notify('A layer set needs a name and a layer', 'error'); return; } closeDialog(); onOk({ ...s, active: s.layers.includes(s.active ?? -1) ? s.active : s.layers[0] }); };
  return (
    <Dialog title="Layer Set" width={460} height={560} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="dlg-field"><span>Name</span><input type="text" value={s.name} onInput={(e) => setS({ ...s, name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></label>
      <div class="ls-layers">
        {all.map((l) => <label key={l} class="dlg-check"><input type="checkbox" checked={s.layers.includes(l)} onChange={(e) => toggle(l, (e.target as HTMLInputElement).checked)} /> {ed.layerLabel(l)}</label>)}
      </div>
      <label class="dlg-field"><span>Active Layer</span><select value={String(s.active ?? '')} onChange={(e) => setS({ ...s, active: Number((e.target as HTMLSelectElement).value) })}>
        {s.layers.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}</select></label>
      <label class="dlg-check"><input type="checkbox" checked={s.flip} onChange={(e) => setS({ ...s, flip: (e.target as HTMLInputElement).checked })} /> Flip Board</label>
    </Dialog>
  );
}

/** A layer set made current: its layers shown, the rest hidden, its active layer current. */
export function applyLayerSet(ed: PcbEditor, s: LayerSet): void {
  const keep = new Set(s.layers);
  ed.hidden = new Set(ed.layers().filter((l) => !keep.has(l)));
  if (s.active !== undefined && keep.has(s.active)) ed.setCurrentLayer(s.active);
  else if (s.layers[0] !== undefined) ed.setCurrentLayer(s.layers[0]);
  ed.invalidate();
}
