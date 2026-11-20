/**
 * The PCB panel (AD17's): browse the board by Nets, Components, Polygons, the Hole Size Editor,
 * 3D Models, Differential Pairs or Layer Stack Regions (rigid-flex: the stacks, the regions on them,
 * the bending lines, and the Fold State slider that folds the board in 3D). Pick a class, then objects in it; what they are made of is
 * listed below. Picking highlights them on the board as the options say — Normal, Mask (the rest
 * faded, out of reach) or Dim (faded) — and selects and zooms to them; Clear takes it back.
 * Right-click a net for the net class commands; double-click one to edit the nets.
 */
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { active, notify, tick } from '../state';
import { openMenuAt } from '../MenuBar';
import { showDialog } from '../dialogs';
import { commands } from '../../core/commands';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { NetlistManagerDialog } from '../dialogs/NetlistManager';
import { PcbComponentDialog } from '../dialogs/PcbComponentDialog';
import { editObject } from '../actions';
import { pcbObjects, type PcbObj } from '../../model/pcbProps';
import { membersOf } from '../../model/pcbClasses';
import { diffPairsOf, setDiffPairs } from '../../model/diffPairs';
import { CreatePairsFromNetsDialog, DiffPairDialog, DiffPairRuleWizardDialog } from '../dialogs/DiffPairDialogs';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { formatCoord, parseLength } from '../../core/units';
import { replaceRecords, setNetProps } from '../../model/pcbEdit';
import { ColourDialog } from '../dialogs/Pickers';
import { PAD, VIA, put } from '../../formats/altium/pcbLayouts';
import { affectedWidth, boardRegions, polyArea, substacks } from '../../model/rigidFlex';
import { BendingLineDialog, BoardRegionDialog } from '../dialogs/RigidFlex';
import { UNITS_PER_MM, trimNum } from '../../core/units';

type Mode = 'nets' | 'components' | 'polygons' | 'holes' | 'models' | 'diffpairs' | 'regions';
const MODES: [Mode, string][] = [['nets', 'Nets'], ['components', 'Components'], ['polygons', 'Polygons'], ['holes', 'Hole Size Editor'], ['models', '3D Models'], ['diffpairs', 'Differential Pairs Editor'], ['regions', 'Layer Stack Regions']];
const mode = signal<Mode>('nets');
/** Board Planning Mode shows the panel's Layer Stack Regions, as AD17 does. */
export const showRegionsMode = () => { mode.value = 'regions'; };
const highlight = signal<'normal' | 'mask' | 'dim'>('mask');
const opts = signal({ select: true, zoom: true, clear: true });

const ALL = '<All>';
/** COLORREF (0x00BBGGRR) as CSS. */
const refHex = (c: number) => `#${(((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)).toString(16).padStart(6, '0')}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Show these objects on the board as the panel's options say. */
function show(e: PcbEditor, objs: PcbObj[]): void {
  const keys = objs.flatMap((o) => o.keys);
  const h = highlight.value, o = opts.value;
  if (h === 'normal') e.setMask(null); else e.setMask(keys, h === 'dim');
  if (o.select) e.select(keys, !o.clear);
  if (o.zoom && keys.length) e.zoomToBox(e.boundsOf(keys), 2_000_000);
  e.invalidateOverlay();
  tick.value++;
}

/** A list with columns: click picks one, Ctrl+click adds or takes one away, Shift+click a run. */
function SelTable<T>({ cols, rows, sel, onSel, onOpen, onMenu, label }: {
  cols: { label: string; get: (r: T) => ComponentChildren; width?: string; right?: boolean }[]; rows: T[]; sel: Set<number>; onSel: (s: Set<number>) => void;
  onOpen?: (i: number) => void; onMenu?: (ev: MouseEvent, i: number) => void; label: string;
}) {
  const [anchor, setAnchor] = useState(0);
  const template = cols.map((c) => c.width ?? 'minmax(50px, 1fr)').join(' ');
  return (
    <div class="pcbp-table" role="grid" aria-label={label} aria-multiselectable="true" style={{ '--cols': template } as Record<string, string>}>
      <div class="pcbp-row head">{cols.map((c) => <span key={c.label} class={c.right ? 'r' : ''}>{c.label}</span>)}</div>
      <div class="pcbp-body">
        {rows.map((r, i) => (
          <div key={i} role="row" aria-selected={sel.has(i)} class={`pcbp-row${sel.has(i) ? ' on' : ''}`}
            onMouseDown={(ev) => {
              if (ev.button === 2 && sel.has(i)) return;
              const n = new Set<number>(ev.ctrlKey || ev.metaKey ? sel : []);
              if (ev.shiftKey) { for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) n.add(k); }
              else if ((ev.ctrlKey || ev.metaKey) && n.has(i)) n.delete(i); else { n.add(i); setAnchor(i); }
              onSel(n);
            }}
            onDblClick={() => onOpen?.(i)} onContextMenu={(ev) => { ev.preventDefault(); onMenu?.(ev as unknown as MouseEvent, i); }}>
            {cols.map((c) => <span key={c.label} class={c.right ? 'r' : ''}>{c.get(r)}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PcbPanel() {
  void tick.value;
  const e = active.value?.editor instanceof PcbEditor ? active.value.editor : null;
  if (!e) return <section class="panel pcbpanel"><p class="panel-empty">Open a board.</p></section>;
  const o = opts.value;
  return (
    <section class="panel pcbpanel" aria-label="PCB">
      <div class="panel-body pcbp-body-wrap">
        <select class="pcbp-mode" aria-label="Browse" value={mode.value} onChange={(ev) => { mode.value = (ev.target as HTMLSelectElement).value as Mode; }}>
          {MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
        </select>
        <div class="pcbp-opts">
          <button class="btn" onClick={() => { e.setMask(null); e.select([]); e.invalidateOverlay(); tick.value++; }}>Clear</button>
          <select aria-label="Highlight" value={highlight.value} onChange={(ev) => { highlight.value = (ev.target as HTMLSelectElement).value as 'normal' | 'mask' | 'dim'; }}>
            <option value="normal">Normal</option><option value="mask">Mask</option><option value="dim">Dim</option>
          </select>
          <label><input type="checkbox" checked={o.select} onChange={(ev) => { opts.value = { ...o, select: (ev.target as HTMLInputElement).checked }; }} />Select</label>
          <label><input type="checkbox" checked={o.zoom} onChange={(ev) => { opts.value = { ...o, zoom: (ev.target as HTMLInputElement).checked }; }} />Zoom</label>
          <label><input type="checkbox" checked={o.clear} onChange={(ev) => { opts.value = { ...o, clear: (ev.target as HTMLInputElement).checked }; }} />Clear Existing</label>
        </div>
        {mode.value === 'nets' && <NetsView e={e} />}
        {mode.value === 'components' && <ComponentsView e={e} />}
        {mode.value === 'polygons' && <PolygonsView e={e} />}
        {mode.value === 'holes' && <HolesView e={e} />}
        {mode.value === 'models' && <ModelsView e={e} />}
        {mode.value === 'diffpairs' && <DiffPairsView e={e} />}
        {mode.value === 'regions' && <RegionsView e={e} />}
      </div>
    </section>
  );
}

/** The primitives below a pick: their kind, name and layer. */
function Primitives({ e, prims }: { e: PcbEditor; prims: PcbPrim[] }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const [sel, setSel] = useState<Set<number>>(new Set());
  const u = e.units();
  const name = (p: PcbPrim) => p.kind === 'pad' ? `${p.component !== NO_NET ? `${e.doc.components[p.component]?.designator ?? ''}-` : ''}${p.name}` : p.kind === 'text' ? p.text : p.kind === 'track' ? formatCoord(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y), u) : '';
  return <SelTable label="Primitives" rows={prims} sel={sel} onSel={(s) => { setSel(s); const objs = pcbObjects(e.doc).filter((x) => x.prim && [...s].some((i) => prims[i] === x.prim)); show(e, objs); }}
    cols={[{ label: 'Type', get: (p) => p.kind[0]!.toUpperCase() + p.kind.slice(1), width: '70px' }, { label: 'Name', get: name }, { label: 'Layer', get: (p) => ('layer' in p ? e.layerLabel(p.layer) : 'Multi-Layer') }]} />;
}

function classList(doc: PcbDocument, kind: number): { name: string; members: Set<string> | null }[] {
  return [{ name: ALL, members: null }, ...doc.classes.filter((c) => c.kind === kind && !c.superClass).map((c) => ({ name: c.name, members: new Set(membersOf(doc, c).map((m) => m.toLowerCase())) }))];
}

function NetsView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const [cls, setCls] = useState<Set<number>>(new Set([0]));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const classes = classList(doc, 0);
  const pickClass = (s: Set<number>) => { setCls(s); setSel(new Set()); };
  const allowed = [...cls].map((i) => classes[i]).filter(Boolean);
  const nets = doc.nets.filter((n) => allowed.some((c) => !c!.members || c!.members.has(n.name.toLowerCase()))).sort((a, b) => natural(a.name, b.name));
  const stats = new Map<number, { nodes: number; routed: number }>();
  for (const p of doc.prims) {
    if (!('net' in p) || p.net === NO_NET) continue;
    const st = stats.get(p.net) ?? { nodes: 0, routed: 0 };
    if (p.kind === 'pad') st.nodes++;
    if (p.kind === 'track' && p.polygon === NO_NET) st.routed += Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    if (p.kind === 'arc' && p.polygon === NO_NET) st.routed += (Math.PI * p.r * (((p.end - p.start) % 360 + 360) % 360 || 360)) / 180;
    stats.set(p.net, st);
  }
  const u = e.units();
  const picked = [...sel].map((i) => nets[i]).filter((n): n is NonNullable<typeof n> => !!n);
  const onNets = (s: Set<number>) => {
    setSel(s);
    const want = new Set([...s].map((i) => nets[i]?.index));
    show(e, pcbObjects(doc).filter((x) => (x.prim && 'net' in x.prim && want.has(x.prim.net)) || (x.polygon !== undefined && want.has(doc.polygons[x.polygon]!.net))));
  };
  const menu = (ev: MouseEvent) => openMenuAt({ key: '', label: '', children: [
    { key: 'E', label: 'Edit Nets...', accelAt: 0, action: () => showDialog(NetlistManagerDialog, { ed: e }) },
    { key: 'C', label: 'Create NetClass from Selected Nets', accelAt: 0, separatorBefore: true, action: () => void commands.get('ad:PCB:CreateNetClassFromSelectedNets')?.run() },
    { key: 'A', label: 'Add Selected Nets to NetClass', accelAt: 0, action: () => void commands.get('ad:PCB:AddSelectedNetsToNetClass')?.run() },
    { key: 'R', label: 'Remove Selected Nets from NetClass', accelAt: 0, action: () => void commands.get('ad:PCB:RemoveSelectedNetsFromNetClass')?.run() },
    { key: 'L', label: 'Classes...', accelAt: 1, separatorBefore: true, action: () => void commands.get('ad:PCB:Classes')?.run() },
    { key: 'N', label: 'Change Net Colour', accelAt: 7, separatorBefore: true, disabled: !picked.length, action: () => {
      const c0 = picked[0]!.bag.int('COLOR');
      const hex = `#${(((c0 & 0xff) << 16) | (c0 & 0xff00) | ((c0 >> 16) & 0xff)).toString(16).padStart(6, '0')}`;
      showDialog(ColourDialog, { value: hex, onOk: (v: string) => {
        const rgb = parseInt(v.slice(1), 16), ref = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
        e.undo.transact('Change net colour', (tx) => tx.add(setNetProps(doc, picked.map((n) => ({ index: n.index, props: { COLOR: String(ref), OVERRIDECOLORFORDRAW: 'TRUE' } })))));
        e.invalidate(); tick.value++;
      } });
    } },
    { key: 'D', label: 'Display Override', accelAt: 0, children: [
      { key: 'S', label: 'Selected On', accelAt: 0, disabled: !picked.length, action: () => override(picked.map((n) => n.index), true) },
      { key: 'E', label: 'Selected Off', accelAt: 1, disabled: !picked.length, action: () => override(picked.map((n) => n.index), false) },
      { key: 'A', label: 'All On', accelAt: 0, action: () => override(doc.nets.map((n) => n.index), true) },
      { key: 'L', label: 'All Off', accelAt: 1, action: () => override(doc.nets.map((n) => n.index), false) },
    ] },
  ] }, ev.clientX, ev.clientY);
  const override = (nets: number[], on: boolean) => {
    e.undo.transact(`Net colour override ${on ? 'on' : 'off'}`, (tx) => tx.add(setNetProps(doc, nets.map((index) => ({ index, props: { OVERRIDECOLORFORDRAW: on ? 'TRUE' : 'FALSE' } })))));
    e.invalidate(); tick.value++;
  };
  return <>
    <SelTable label="Net Classes" rows={classes} sel={cls} onSel={pickClass} onOpen={() => void commands.get('ad:PCB:Classes')?.run()}
      cols={[{ label: `Net Classes (${classes.length})`, get: (c) => (c.name === ALL ? '<All Nets>' : c.name) }]} />
    <SelTable label="Nets" rows={nets} sel={sel} onSel={onNets} onOpen={() => showDialog(NetlistManagerDialog, { ed: e })} onMenu={menu}
      cols={[{ label: `Nets (${nets.length})`, get: (n) => <>{n.bag.bool('OVERRIDECOLORFORDRAW') && <span class="pcbp-swatch" style={{ background: refHex(n.bag.int('COLOR')) }} />}{n.name}</> }, { label: 'Node Count', get: (n) => stats.get(n.index)?.nodes ?? 0, width: '80px', right: true },
        { label: `Routed (${u})`, get: (n) => formatCoord(stats.get(n.index)?.routed ?? 0, u, 2).replace(/[a-z]+$/, ''), width: '90px', right: true }]} />
    <Primitives e={e} prims={doc.prims.filter((p) => 'net' in p && picked.some((n) => n.index === p.net))} />
  </>;
}

function ComponentsView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const [cls, setCls] = useState<Set<number>>(new Set([0]));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const classes = classList(doc, 1);
  const allowed = [...cls].map((i) => classes[i]).filter(Boolean);
  const comps = doc.components.filter((c) => allowed.some((k) => !k!.members || k!.members.has(c.designator.toLowerCase()))).sort((a, b) => natural(a.designator, b.designator));
  const picked = [...sel].map((i) => comps[i]).filter((c): c is NonNullable<typeof c> => !!c);
  const onComps = (s: Set<number>) => {
    setSel(s);
    const want = new Set([...s].map((i) => comps[i]?.index));
    show(e, pcbObjects(doc).filter((x) => x.component !== undefined && want.has(x.component)));
  };
  return <>
    <SelTable label="Component Classes" rows={classes} sel={cls} onSel={(s) => { setCls(s); setSel(new Set()); }}
      cols={[{ label: `Component Classes (${classes.length})`, get: (c) => (c.name === ALL ? '<All Components>' : c.name) }]} />
    <SelTable label="Components" rows={comps} sel={sel} onSel={onComps} onOpen={(i) => { const c = comps[i]; if (c) showDialog(PcbComponentDialog, { ed: e, index: c.index }); }}
      cols={[{ label: `Components (${comps.length})`, get: (c) => c.designator, width: '90px' }, { label: 'Footprint', get: (c) => c.pattern },
        { label: 'Rotation', get: (c) => +c.rotation.toFixed(2), width: '64px', right: true }, { label: 'Layer', get: (c) => e.layerLabel(c.layer), width: '90px' }]} />
    <Primitives e={e} prims={doc.prims.filter((p) => 'component' in p && picked.some((c) => c.index === p.component))} />
  </>;
}

function PolygonsView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const [sel, setSel] = useState<Set<number>>(new Set());
  const u = e.units();
  const area = (o: { x: number; y: number }[]) => Math.abs(o.reduce((a, v, k) => { const n = o[(k + 1) % o.length]!; return a + v.x * n.y - n.x * v.y; }, 0) / 2);
  const areaText = (a: number) => (u === 'mil' ? `${(a / 1e8).toFixed(0)} sq mils` : `${((a / 1e8) * 0.00064516).toFixed(3)} sq mm`);
  return <>
    <SelTable label="Polygons" rows={doc.polygons} sel={sel} onSel={(s) => { setSel(s); show(e, pcbObjects(doc).filter((x) => x.polygon !== undefined && s.has(doc.polygons.findIndex((p) => p.index === x.polygon)))); }}
      onOpen={(i) => { const p = doc.polygons[i]; if (p) editObject(e, `poly:${p.index}`); }}
      cols={[{ label: `Polygons (${doc.polygons.length})`, get: (p) => p.name }, { label: 'Type', get: (p) => (p.hatch === 'Solid' ? 'Solid' : p.hatch === 'None' ? 'None' : 'Hatched'), width: '70px' },
        { label: 'Net', get: (p) => (p.net === NO_NET ? 'No Net' : doc.nets[p.net]?.name ?? ''), width: '90px' }, { label: 'Layer', get: (p) => e.layerLabel(p.layer), width: '90px' },
        { label: 'Area', get: (p) => areaText(area(p.outline)), width: '110px', right: true }]} />
    <p class="muted small">Double-click a pour for its Polygon Pour dialog.</p>
  </>;
}

/** Hole Size Editor: the board's holes by size, kind and plating; a size typed changes every one of them (one undo step). */
function HolesView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const u = e.units();
  const groups = new Map<string, { size: number; plated: boolean; kind: string; prims: PcbPrim[] }>();
  for (const p of doc.prims) {
    if (p.kind !== 'pad' && p.kind !== 'via') continue;
    if (!p.hole) continue;
    const plated = p.kind === 'via' ? true : p.plated, kind = p.kind === 'via' ? 'Via' : 'Pad';
    const k = `${p.hole}|${plated}|${kind}`;
    const g = groups.get(k) ?? { size: p.hole, plated, kind, prims: [] };
    g.prims.push(p);
    groups.set(k, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.size - b.size || a.kind.localeCompare(b.kind));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const resize = (g: typeof rows[number], v: string) => {
    setEditing(null);
    const t = v.trim(), c = parseLength(/^-?[0-9.]+$/.test(t) ? `${t}${u}` : t);
    if (!c || c <= 0 || c === g.size) return;
    const edits = g.prims.flatMap((p) => {
      const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
      if (!rec) return [];
      const subs = rec.subs.map((s) => s.slice());
      if (p.kind === 'via') { if (c >= p.diameter) return []; put(subs[0]!, VIA.hole, Math.round(c)); }
      else if (p.kind === 'pad') put(subs[4]!, PAD.hole, Math.round(c));
      return [{ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } }];
    });
    if (!edits.length) { notify('No hole was changed: each must stay inside its via', 'error'); return; }
    e.undo.transact(`Hole size ${formatCoord(c, u)}`, (tx) => tx.add(replaceRecords(doc, edits)));
    e.invalidate();
    notify(`${plural(edits.length, 'hole')} now ${formatCoord(c, u)}`);
  };
  return <>
    <SelTable label="Holes" rows={rows} sel={sel} onSel={(s) => { setSel(s); show(e, pcbObjects(doc).filter((x) => x.prim && [...s].some((i) => rows[i]?.prims.includes(x.prim!)))); }}
      onOpen={(i) => setEditing(i)}
      cols={[{ label: 'Count', get: (g) => g.prims.length, width: '60px', right: true },
        { label: `Hole Size (${u})`, get: (g) => (editing !== null && rows[editing] === g
          ? <input type="text" autoFocus aria-label="Hole size" defaultValue={formatCoord(g.size, u, 4)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') resize(g, (ev.target as HTMLInputElement).value); if (ev.key === 'Escape') setEditing(null); }} onBlur={(ev) => resize(g, (ev.target as HTMLInputElement).value)} />
          : formatCoord(g.size, u, 3)), width: '1fr' },
        { label: 'Hole Type', get: () => 'Round', width: '80px' }, { label: 'Plated', get: (g) => (g.plated ? '✓' : ''), width: '60px' }, { label: 'Object', get: (g) => g.kind, width: '60px' }]} />
    <p class="muted small">Double-click a hole size to change every hole of it.</p>
  </>;
}

function ModelsView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const bodies = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'body' }> => p.kind === 'body');
  const [sel, setSel] = useState<Set<number>>(new Set());
  return (
    <SelTable label="3D Models" rows={bodies} sel={sel} onSel={(s) => { setSel(s); show(e, pcbObjects(doc).filter((x) => x.prim && [...s].some((i) => bodies[i] === x.prim))); }}
      cols={[{ label: `3D Models (${bodies.length})`, get: (b) => b.modelName || b.identifier || '(extruded)' }, { label: 'Component', get: (b) => (b.component !== NO_NET ? doc.components[b.component]?.designator ?? '' : 'Free'), width: '90px' },
        { label: 'Type', get: (b) => ['Extruded', 'Generic', 'Cylinder', 'Sphere'][b.modelType] ?? '', width: '80px' }, { label: 'Side', get: (b) => (b.bottom ? 'Bottom' : 'Top'), width: '64px' }]} />
  );
}

function DiffPairsView({ e }: { e: PcbEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const doc = e.doc;
  const [cls, setCls] = useState<Set<number>>(new Set([0]));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const classes = classList(doc, 6);
  const allowed = [...cls].map((i) => classes[i]).filter(Boolean);
  const all = diffPairsOf(doc);
  const pairs = all.filter((p) => allowed.some((c) => !c!.members || c!.members.has(p.name.toLowerCase())));
  const picked = [...sel].map((i) => pairs[i]).filter((p): p is NonNullable<typeof p> => !!p);
  const netIdx = (n: string) => doc.nets.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
  const onPairs = (s: Set<number>) => {
    setSel(s);
    const want = new Set([...s].flatMap((i) => { const p = pairs[i]; return p ? [netIdx(p.pos), netIdx(p.neg)] : []; }));
    show(e, pcbObjects(doc).filter((x) => x.prim && 'net' in x.prim && want.has(x.prim.net)));
  };
  const del = () => {
    const names = new Set(picked.map((p) => p.name));
    e.undo.transact(`Delete ${plural(names.size, 'differential pair')}`, (tx) => tx.add(setDiffPairs(doc, (doc.diffPairs ?? []).filter((b) => !names.has(b.get('NAME') ?? '')))));
    setSel(new Set()); tick.value++;
  };
  return <>
    <SelTable label="Differential Pair Classes" rows={classes} sel={cls} onSel={(s) => { setCls(s); setSel(new Set()); }}
      cols={[{ label: `Differential Pair Classes (${classes.length})`, get: (c) => (c.name === ALL ? '<All Differential Pairs>' : c.name) }]} />
    <SelTable label="Differential Pairs" rows={pairs} sel={sel} onSel={onPairs} onOpen={(i) => { const p = pairs[i]; if (p) showDialog(DiffPairDialog, { ed: e, index: all.indexOf(p) }); }}
      cols={[{ label: `Differential Pairs (${pairs.length})`, get: (p) => p.name }, { label: 'Positive', get: (p) => p.pos }, { label: 'Negative', get: (p) => p.neg }]} />
    <div class="pcbp-buttons">
      <button class="btn" onClick={() => showDialog(DiffPairDialog, { ed: e, index: null })}>Add</button>
      <button class="btn" disabled={!picked.length} onClick={del}>Delete</button>
      <button class="btn" disabled={picked.length !== 1} onClick={() => showDialog(DiffPairDialog, { ed: e, index: all.indexOf(picked[0]!) })}>Edit</button>
      <button class="btn" onClick={() => showDialog(CreatePairsFromNetsDialog, { ed: e })}>Create From Nets</button>
      <button class="btn" onClick={() => showDialog(DiffPairRuleWizardDialog, { ed: e })}>Rule Wizard</button>
    </div>
    <Primitives e={e} prims={doc.prims.filter((p) => 'net' in p && picked.some((q) => [netIdx(q.pos), netIdx(q.neg)].includes(p.net)))} />
  </>;
}

/**
 * Layer Stack Regions (rigid-flex): the board's layer stacks, its regions (pick one: the regions
 * on a stack), the bending lines; double-click a region or a line for its dialog. Fold State
 * folds the board in 3D (View › Fold/Unfold folds it all the way).
 */
function RegionsView({ e }: { e: PcbEditor }) {
  void tick.value;
  const doc = e.doc, subs = substacks(doc), regs = boardRegions(doc);
  const [stack, setStack] = useState<Set<number>>(new Set());
  const [rsel, setRsel] = useState<Set<number>>(new Set());
  const [bsel, setBsel] = useState<Set<number>>(new Set());
  const shown = stack.size ? regs.filter((r) => [...stack].some((i) => subs[i]?.id === r.stackId)) : regs;
  const bends = shown.flatMap((r) => r.bends.map((l, j) => ({ r, l, j })));
  const u = e.units();
  const pick = (keys: string[]) => { if (!e.planning) e.setPlanning(true); e.select(keys); e.invalidate(); tick.value++; };
  const fold = Math.round((e.view3d?.foldState ?? (e.folded ? 1 : 0)) * 100);
  return (
    <div class="pcbp-regions">
      <SelTable label="Layer stacks" rows={subs} sel={stack} onSel={(s) => { setStack(s); setRsel(new Set()); }}
        cols={[{ label: 'Layer Stack', get: (x) => x.name }, { label: 'Flex', get: (x) => (x.isFlex ? 'Yes' : ''), width: '45px' },
          { label: 'Regions', get: (x) => String(regs.filter((r) => r.stackId === x.id || (!x.id && !r.stackId)).length), width: '60px', right: true }]} />
      <SelTable label="Regions" rows={shown} sel={rsel} onSel={(s) => { setRsel(s); pick([...s].map((i) => `region:${shown[i]!.index}`)); }}
        onOpen={(i) => showDialog(BoardRegionDialog, { ed: e, index: shown[i]!.index })}
        cols={[{ label: 'Region', get: (r) => r.name }, { label: 'Layer Stack', get: (r) => subs.find((x) => x.id === r.stackId)?.name ?? subs[0]?.name ?? '' },
          { label: 'Area (mm²)', get: (r) => trimNum((Math.abs(polyArea(r.outline)) / UNITS_PER_MM ** 2).toFixed(1)), width: '80px', right: true },
          { label: '3D Locked', get: (r) => (r.locked3d ? 'Yes' : ''), width: '70px' }]} />
      <SelTable label="Bending lines" rows={bends} sel={bsel} onSel={(s) => { setBsel(s); pick([...s].map((i) => `bend:${bends[i]!.r.index}:${bends[i]!.j}`)); }}
        onOpen={(i) => showDialog(BendingLineDialog, { ed: e, region: bends[i]!.r.index, index: bends[i]!.j })}
        cols={[{ label: 'Region', get: (b) => b.r.name }, { label: 'Angle', get: (b) => `${b.l.angle}°`, width: '55px', right: true },
          { label: 'Radius', get: (b) => formatCoord(b.l.radius, u), width: '70px', right: true }, { label: 'Width', get: (b) => formatCoord(affectedWidth(b.l), u), width: '70px', right: true },
          { label: 'Fold Index', get: (b) => String(b.l.foldIndex), width: '70px', right: true }]} />
      <label class="pcbp-fold">Fold State
        <input type="range" min={0} max={100} value={fold} aria-label="Fold State" disabled={!regs.some((r) => r.bends.length)}
          onInput={(ev) => { const v = Number((ev.target as HTMLInputElement).value) / 100; if (!e.mode3d) e.set3d(true); e.setFold(v); tick.value++; }} />
        <span>{fold}%</span></label>
    </div>
  );
}
