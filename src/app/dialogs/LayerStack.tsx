import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ImpedanceDialog } from './Impedance';
import { DrillPairManagerDialog } from './BoardSets';
import { openMenuAt } from '../MenuBar';
import { notify, units } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { mil, mm, parseLength, trimNum } from '../../core/units';
import { L } from '../../model/layers';
import { DIEL_TYPES, STACK_PRESETS, STACK_STYLES, addCoverlay, addStackLayer, applyStyle, deleteStackLayer, moveStackLayer, presetStack, readStack, readStackFile, readStackStyle, setStack, stackFile, stackThickness, type StackLayer } from '../../model/pcbStack';
import { pickFile, saveFileAs } from '../../platform/fs';
import { boardRegions, inStack, isAdvanced, readSubstacks, setAdvancedMode, setRigidFlex, setRigidFlexMode, stackRange, withRegion, type SubStack } from '../../model/rigidFlex';
import { newGuid } from '../../formats/altium/board6';

const TYPE: Record<StackLayer['kind'], string> = { paste: 'Paste', overlay: 'Overlay', solder: 'Solder Mask/Coverlay', signal: 'Signal', plane: 'Internal Plane', dielectric: 'Dielectric', coverlay: 'Coverlay' };
const ORIENT: [number, string][] = [[1, 'Top'], [2, 'Bottom'], [0, 'Not Allowed']];

/** 3D: each layer as a slab seen from above and in front, its top lighter and its side darker. */
function RowPicture3D({ r }: { r: StackLayer }) {
  const copper = r.kind === 'signal' || r.kind === 'plane';
  const bar = copper ? { h: 6, fill: '#f0a020', stroke: '#a06000' } : r.kind === 'dielectric' ? (r.dielType === 1 ? { h: 7, fill: '#f2ea6a', stroke: '#a89d20' } : { h: 4, fill: '#dddddd', stroke: '#888888' })
    : r.kind === 'solder' ? { h: 3, fill: '#2f8a4e', stroke: '#1d5c33' } : r.kind === 'coverlay' ? { h: 4, fill: '#d08a2a', stroke: '#8a5212' } : { h: 3, fill: '#a8e6a0', stroke: '#5aa050' };
  const yb = 13, yt = yb - bar.h, dx = 16, dy = 4;
  return <svg class="lsm-glyph" viewBox="0 0 180 14" preserveAspectRatio="none" aria-hidden="true">
    <polygon points={`2,${yt} ${2 + dx},${yt - dy} ${178},${yt - dy} ${178 - dx},${yt}`} fill={bar.fill} stroke={bar.stroke} stroke-width="0.5" style={{ filter: 'brightness(1.25)' }} />
    <polygon points={`${178 - dx},${yt} ${178},${yt - dy} ${178},${yb - dy} ${178 - dx},${yb}`} fill={bar.fill} stroke={bar.stroke} stroke-width="0.5" style={{ filter: 'brightness(0.7)' }} />
    <rect x="2" y={yt} width={176 - dx} height={bar.h} fill={bar.fill} stroke={bar.stroke} stroke-width="0.5" />
    {r.kind === 'signal' && [0, 1, 2, 3].map((i) => <rect key={i} x={14 + i * 36} y={yt} width="14" height={bar.h} fill="#c07810" opacity="0.6" />)}
  </svg>;
}

/** The picture beside each row, as AD17 draws its stack: copper as a row of pads, a core as a solid bar, prepreg a thin one, mask and overlay lines. */
function RowPicture({ r }: { r: StackLayer }) {
  if (r.kind === 'signal' || r.kind === 'plane') {
    return <svg class="lsm-glyph" viewBox="0 0 180 14" preserveAspectRatio="none" aria-hidden="true">
      {r.kind === 'plane' ? <rect x="4" y="4" width="172" height="7" fill="#f0a020" stroke="#a06000" stroke-width="0.6" />
        : [0, 1, 2, 3, 4].map((i) => <rect key={i} x={16 + i * 34} y="3" width="16" height="9" fill="#f0a020" stroke="#a06000" stroke-width="0.6" />)}
    </svg>;
  }
  const bar = r.kind === 'dielectric' ? (r.dielType === 1 ? { h: 9, fill: '#f2ea6a', stroke: '#a89d20' } : { h: 3, fill: '#dddddd', stroke: '#888888' })
    : r.kind === 'solder' ? { h: 3, fill: '#2f8a4e', stroke: '#1d5c33' } : r.kind === 'coverlay' ? { h: 4, fill: '#d08a2a', stroke: '#8a5212' } : { h: 3, fill: '#a8e6a0', stroke: '#5aa050' };
  return <svg class="lsm-glyph" viewBox="0 0 180 14" preserveAspectRatio="none" aria-hidden="true"><rect x="2" y={7 - bar.h / 2} width="176" height={bar.h} fill={bar.fill} stroke={bar.stroke} stroke-width="0.6" /></svg>;
}

/**
 * Design › Layer Stack Manager, laid out as AD17's: Measurement Unit and the stack style (Layer
 * Pairs, Internal Layer Pairs, Build-up) above; each layer's picture beside Layer Name, Type,
 * Material, Thickness, Dielectric Material and Constant, Pullback, Orientation, Coverlay Expansion,
 * edited in place; Total Thickness, Add Layer / Add Internal Plane, Delete Layer, Move Up / Down
 * below. OK writes the stack to the board as one undo step. (Paste layers are kept, not listed.)
 * Advanced >> shows the board's layer stacks (rigid-flex): each with its name and Is Flex, and
 * which layers it has (a flex stack leaves the rigid layers out) — Add Stack, Delete Stack (its
 * regions go to the first stack) — and the Rigid-Flex mode (Standard: split lines; Advanced:
 * regions of their own). Board Planning Mode puts regions on them. Right-click a layer: Insert
 * layer above / below › Coverlay (in the flex stacks only). Save... and Load... keep a stack in a
 * file of its own; Presets puts in a standard stack's inner layers; 3D draws the stack's pictures
 * as slabs.
 */
export function LayerStackDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const [rows, setRows] = useState<StackLayer[]>(() => readStack(doc.board.bag!, doc.board.copperStack));
  const [style, setStyle] = useState(() => readStackStyle(doc.board.bag!));
  const [metric, setMetric] = useState(units.value === 'mm');
  const [sel, setSel] = useState(() => rows.findIndex((r) => r.layer === L.TOP));
  // Rigid-flex: the board's layer stacks, the one being looked at
  const [subs, setSubs] = useState<SubStack[]>(() => readSubstacks(doc.board.bag));
  const [adv, setAdv] = useState(false);
  const [cur, setCur] = useState(0);
  // Tools › Features › Rigid-Flex (Advanced) [est: as a choice beside the stacks]
  const [advanced, setAdvanced] = useState(() => isAdvanced(doc));
  const [threeD, setThreeD] = useState(false);
  /** A new stack (a preset or a file) takes the place of this one, unless a layer it leaves out has objects on it. */
  const take = (next: StackLayer[], nextStyle: number, what: string) => {
    const lost = rows.filter((r) => r.layer !== null && (r.kind === 'signal' || r.kind === 'plane') && used.has(r.layer) && !next.some((n) => n.layer === r.layer));
    if (lost.length) { notify(`${what}: ${lost.map((r) => r.name).join(', ')} ha${lost.length === 1 ? 's' : 've'} primitives on it; remove them first`, 'error'); return; }
    setRows(next); setStyle(nextStyle); setSel(Math.max(0, next.findIndex((r) => r.layer === L.TOP)));
  };
  const presets = (e: MouseEvent) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: 'Presets', children: STACK_PRESETS.map(([name, inner], k) => ({ key: String(k), label: name, action: () => {
      const out = presetStack(rows, inner, style);
      if (typeof out === 'string') notify(out, 'error'); else take(out, style, name);
    } })) }, b.left, b.bottom + 1);
  };
  const saveStack = () => { void saveFileAs(`${doc.name.replace(/\.[^.]+$/, '')}.stackup.json`, new TextEncoder().encode(stackFile(rows, style))); };
  const loadStack = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    const r = readStackFile(new TextDecoder().decode(f.bytes));
    if (typeof r === 'string') { notify(`Couldn't load ${f.name}: ${r}`, 'error'); return; }
    take(r.rows, r.style, f.name);
  };
  const st = subs[cur] ?? subs[0]!;
  const ensureIds = (list: SubStack[]) => list.map((x) => (x.id ? x : { ...x, id: newGuid() }));
  const addStack = () => {
    const base = ensureIds(subs);
    let n = 1;
    while (base.some((x) => x.name === `Layer Stack ${n}`)) n++;
    const next = [...base, { ...base[0]!, id: newGuid(), name: `Layer Stack ${n}`, isFlex: false, usedByPrims: false }];
    setSubs(next); setCur(next.length - 1);
  };
  const delStack = () => {
    if (subs.length < 2) { notify('The board keeps at least one layer stack', 'error'); return; }
    const next = subs.filter((_, i) => i !== cur);
    setSubs(next); setCur(0);
  };
  const setSub = (p: Partial<SubStack>) => setSubs(subs.map((x, i) => (i === cur ? { ...x, ...p } : x)));
  const setIn = (i: number, on: boolean) => { const id = (subs[cur]?.id) || ''; if (!id) return; set(i, { subs: { ...rows[i]!.subs, [id]: on } }); };
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.kind !== 'paste');
  const used = useMemo(() => new Set(doc.prims.map((p) => ('layer' in p ? p.layer : -1))), [doc.prims]);
  const set = (i: number, p: Partial<StackLayer>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const unit = metric ? 'mm' : 'mil';
  const num = (v: number) => trimNum((v / (metric ? mm(1) : mil(1))).toFixed(metric ? 4 : 3));
  const lenIn = (v: string) => parseLength(/^\s*-?[\d.]+\s*$/.test(v) ? `${v.trim()}${unit}` : v);
  const cell = (i: number, key: 'copper' | 'height' | 'pullback' | 'coverlay', label: string) => (
    <input type="text" class="lsm-cell" aria-label={label} value={num(rows[i]![key])}
      onChange={(e) => { const v = lenIn((e.target as HTMLInputElement).value); if (v !== undefined && v >= 0) set(i, { [key]: Math.round(v) }); else notify(`${label}: give a length`, 'error'); }} />
  );
  const add = (e: MouseEvent) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const run = (plane: boolean) => { const r = addStackLayer(rows, sel, plane, style); if (!r) { notify(plane ? 'All 16 internal planes are in use' : 'All 30 mid-layers are in use', 'error'); return; } setRows(r.rows); setSel(r.index); };
    openMenuAt({ key: '', label: 'Add Layer', children: [
      { key: 'L', label: 'Add Layer', accelAt: 4, action: () => run(false) },
      { key: 'I', label: 'Add Internal Plane', accelAt: 4, action: () => run(true) },
    ] }, b.left, b.bottom + 1);
  };
  const del = () => {
    const r = rows[sel];
    if (r?.layer != null && used.has(r.layer)) { notify(`${r.name} has primitives on it; remove them first`, 'error'); return; }
    const out = deleteStackLayer(rows, sel, style);
    if (typeof out === 'string') { notify(out, 'error'); return; }
    setRows(out); setSel(Math.min(sel, out.length - 1));
  };
  /** Right-click a layer: Insert layer above / below › Coverlay (a flex stack's polyimide over its outer copper). */
  const rowMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    setSel(i);
    const ids = ensureIds(subs);
    const flex = ids.some((x) => x.isFlex);
    const insert = (above: boolean) => {
      if (!flex) { notify('Coverlay goes in a flex layer stack: Advanced >>, a stack with Is Flex, first', 'error'); return; }
      if (ids !== subs) setSubs(ids);
      const out = addCoverlay(rows, i, above, ids);
      setRows(out.rows); setSel(out.index);
    };
    openMenuAt({ key: '', label: 'Layer', children: [
      { key: 'A', label: 'Insert layer above', children: [{ key: 'C', label: 'Coverlay', action: () => insert(true) }] },
      { key: 'B', label: 'Insert layer below', children: [{ key: 'C', label: 'Coverlay', action: () => insert(false) }] },
      ...(rows[i]?.kind === 'coverlay' ? [{ key: 'D', label: 'Delete Layer', action: () => { const out = deleteStackLayer(rows, i, style); if (typeof out !== 'string') { setRows(out); setSel(Math.min(i, out.length - 1)); } } }] : []),
    ] }, e.clientX, e.clientY);
  };
  const move = (d: -1 | 1) => { const out = moveStackLayer(rows, sel, d); if (typeof out === 'string') { notify(out, 'error'); return; } setRows(out.rows); setSel(out.index); };
  const restyle = (s: number) => { setStyle(s); setRows(applyStyle(rows, s)); };
  const ok = () => {
    for (const r of rows) if (!r.name.trim()) { notify('Every layer needs a name', 'error'); return false; }
    for (const x of subs) if (!x.name.trim()) { notify('Every layer stack needs a name', 'error'); return false; }
    const was = readSubstacks(doc.board.bag), before = readStack(doc.board.bag!, doc.board.copperStack);
    const member = (rs: StackLayer[]) => JSON.stringify(rs.map((r) => [r.v7, subs.map((x) => inStack(r, x.id))]));
    const changed = JSON.stringify(subs) !== JSON.stringify(was) || member(rows) !== member(before);
    // Rigid-Flex (Advanced) on or off: Standard mode only takes regions that meet edge to edge
    const mode = advanced !== isAdvanced(doc) ? setAdvancedMode(doc, advanced) : null;
    if (typeof mode === 'string') { notify(mode, 'error'); return false; }
    closeDialog();
    ed.undo.transact('Layer Stack Manager', (tx) => {
      tx.add(setStack(doc, rows, style, changed ? subs : undefined));
      // Regions on a stack that's gone (or on the board's stack before it had an ID) move to the first one
      if (changed) {
        const ids = new Set(subs.map((x) => x.id));
        const moved = boardRegions(doc).map((r, i) => ({ r, i })).filter(({ r }) => !ids.has(r.stackId));
        let f = doc.flex;
        for (const { i } of moved) f = withRegion({ ...doc, flex: f }, i, { stackId: subs[0]!.id });
        if (moved.length && f) tx.add(setRigidFlex(doc, f));
      }
      if (mode) tx.add(setRigidFlexMode(doc, { ...mode, regions: mode.regions.map((x) => (subs.some((y) => y.id === x.stackId) ? x : { ...x, stackId: subs[0]!.id })) }));
    });
    ed.invalidate();
    return false;
  };
  const r = rows[sel];
  const inner = !!r && (r.kind === 'signal' || r.kind === 'plane') && r.layer !== L.TOP && r.layer !== L.BOTTOM;
  const deletable = inner || r?.kind === 'coverlay';
  return (
    <Dialog title="Layer Stack Manager" width={1120} height={680} onClose={closeDialog} onAccept={ok} class="lsm"
      footer={<><button class="btn" aria-pressed={adv} onClick={() => setAdv(!adv)}>{adv ? '<< Simple' : 'Advanced >>'}</button><span class="spacer" />
        <button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="lsm-frame">
        <div class="lsm-bar">
          <button class="btn" onClick={saveStack} title="The stack to a file of its own">Save...</button><button class="btn" onClick={() => void loadStack()} title="A stack saved before">Load...</button>
          <button class="btn" onMouseDown={presets}>Presets ▾</button>
          <label class="do-check" title="The pictures as slabs"><input type="checkbox" checked={threeD} onChange={() => setThreeD(!threeD)} />3D</label>
          <span class="spacer" />
          <label class="lsm-unit">Measurement Unit <select value={metric ? 'm' : 'i'} onChange={(e) => setMetric((e.target as HTMLSelectElement).value === 'm')}><option value="i">Imperial</option><option value="m">Metric</option></select></label>
          <select aria-label="Stack style" value={String(style)} onChange={(e) => restyle(Number((e.target as HTMLSelectElement).value))}>
            {STACK_STYLES.map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}</select>
        </div>
        {adv && (
          <div class="lsm-stacks" role="group" aria-label="Layer stacks">
            <label>Layer Stack <select aria-label="Layer stack" value={String(cur)} onChange={(e) => setCur(Number((e.target as HTMLSelectElement).value))}>
              {subs.map((x, i) => <option key={i} value={String(i)}>{x.name}{x.isFlex ? ' (flex)' : ''}</option>)}</select></label>
            <label>Name <input type="text" aria-label="Stack name" value={st.name} onInput={(e) => setSub({ name: (e.target as HTMLInputElement).value })} onKeyDown={(e) => e.stopPropagation()} /></label>
            <label class="do-check"><input type="checkbox" aria-label="Is Flex" checked={st.isFlex} onChange={(e) => setSub({ isFlex: (e.target as HTMLInputElement).checked })} />Is Flex</label>
            <button class="btn" onClick={addStack}>Add Stack</button>
            <button class="btn" onClick={delStack} disabled={subs.length < 2}>Delete Stack</button>
            <label title="Advanced Rigid-Flex (rigid-flex 2.0): regions placed on their own, sliced and overlapping, no split lines">Rigid-Flex <select aria-label="Rigid-Flex mode" value={advanced ? 'a' : 's'} onChange={(e) => setAdvanced((e.target as HTMLSelectElement).value === 'a')}>
              <option value="s">Standard</option><option value="a">Advanced</option></select></label>
            <span class="lsm-stack-th">{(() => { const z = stackRange(rows, st.id); return `${num(z.z1 - z.z0)}${unit} of ${num(z.total)}${unit}`; })()}</span>
          </div>
        )}
        <div class={`lsm-table${adv ? ' adv' : ''}`} role="grid" aria-label="Layer stack">
          <div class="lsm-row lsm-head" role="row">
            {['', 'Layer Name', 'Type', 'Material', `Thickness (${unit})`, 'Dielectric Material', 'Dielectric Constant', `Pullback (${unit})`, 'Orientation', 'Coverlay Expansion', ...(adv ? [`In ${st.name}`] : [])].map((h, k) => <span key={k} role="columnheader">{h}</span>)}
          </div>
          {shown.map(({ r: x, i }) => {
            const copper = x.kind === 'signal' || x.kind === 'plane', diel = x.kind === 'dielectric' || x.kind === 'solder' || x.kind === 'coverlay';
            return (
              <div key={i} role="row" class={`lsm-row${sel === i ? ' on' : ''}`} onMouseDown={() => setSel(i)} onContextMenu={(e) => rowMenu(e, i)}>
                <span class="lsm-pic">{threeD ? <RowPicture3D r={x} /> : <RowPicture r={x} />}</span>
                <span><input type="text" class="lsm-cell" aria-label="Layer Name" value={x.name} onChange={(e) => set(i, { name: (e.target as HTMLInputElement).value })} /></span>
                <span>{TYPE[x.kind]}</span>
                <span>{copper ? 'Copper' : x.kind === 'dielectric'
                  ? <select class="lsm-cell" aria-label="Material" value={String(x.dielType)} onChange={(e) => set(i, { dielType: Number((e.target as HTMLSelectElement).value) })}>
                      {[1, 2, ...(x.dielType === 0 ? [0] : [])].map((t) => <option key={t} value={String(t)}>{DIEL_TYPES[t]}</option>)}</select>
                  : x.kind === 'solder' || x.kind === 'coverlay' ? DIEL_TYPES[3] : ''}</span>
                <span>{copper ? cell(i, 'copper', 'Thickness') : diel ? cell(i, 'height', 'Thickness') : ''}</span>
                <span>{diel ? <input type="text" class="lsm-cell" aria-label="Dielectric Material" value={x.dielMaterial} onChange={(e) => set(i, { dielMaterial: (e.target as HTMLInputElement).value })} /> : ''}</span>
                <span>{diel ? <input type="text" class="lsm-cell" aria-label="Dielectric Constant" value={String(x.dielConst)}
                  onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) set(i, { dielConst: v }); else notify('Dielectric Constant: give a number above 0', 'error'); }} /> : ''}</span>
                <span>{x.kind === 'plane' ? cell(i, 'pullback', 'Pullback') : ''}</span>
                <span>{x.kind === 'signal' ? <select class="lsm-cell" aria-label="Orientation" value={String(x.placement)} onChange={(e) => set(i, { placement: Number((e.target as HTMLSelectElement).value) })}>
                  {ORIENT.map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}</select> : ''}</span>
                <span>{x.kind === 'solder' || x.kind === 'coverlay' ? cell(i, 'coverlay', 'Coverlay Expansion') : ''}</span>
                {adv && <span><input type="checkbox" aria-label={`${x.name} in ${st.name}`} checked={inStack(x, st.id)} disabled={!st.id || cur === 0}
                  title={cur === 0 ? 'The board\'s first stack has every layer' : undefined} onChange={(e) => setIn(i, (e.target as HTMLInputElement).checked)} /></span>}
              </div>
            );
          })}
        </div>
        <div class="lsm-actions">
          <div class="lsm-total">Total Thickness:<br />{num(stackThickness(rows))}{unit}</div>
          <button class="btn" onMouseDown={add}>Add Layer ▾</button>
          <button class="btn" onClick={del} disabled={!deletable}>Delete Layer</button>
          <button class="btn" onClick={() => move(-1)} disabled={!inner}>Move Up</button>
          <button class="btn" onClick={() => move(1)} disabled={!inner}>Move Down</button>
          <span class="spacer" />
          <button class="btn" onClick={() => showDialog(DrillPairManagerDialog, { ed })}>Drill Pairs...</button>
          <button class="btn" onClick={() => showDialog(ImpedanceDialog, { ed, rows, metric })}>Impedance Calculation...</button>
        </div>
      </div>
    </Dialog>
  );
}
