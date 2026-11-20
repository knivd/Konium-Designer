import { stlBytesToStep } from '../../formats/stl';
import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick, units } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { addPrimRecords, removePrims } from '../../model/pcbEdit';
import { bodyCandidates, bodyDescription, bodyRecord, defaultBody, editBody, hexOfColorRef, outlineKey, polygonArea, type BodySpec, type BodyType } from '../../model/bodies';
import { L, type LayerId } from '../../model/layers';
import { formatCoord, mil, mm, parseLength, trimNum } from '../../core/units';
import type { Change } from '../../core/undo';
import type { Vec2 } from '../../core/geom';
import type { PcbBody, PcbDocument, PcbPrim } from '../../model/pcb';
import { FootprintPreview } from './FootprintPreview';
import { pickFile } from '../../platform/fs';
import { rememberModel } from '../../platform/modelFolders';

const len = (v: string, u: string) => parseLength(/^\s*-?[\d.]+\s*$/.test(v) ? `${v.trim()}${u}` : v);
const MECH = Array.from({ length: 16 }, (_, i) => L.MECH1 + i);

/** The 3D body settings, shared by Place › 3D Body and the body managers. */
function BodyFields({ ed, spec, set, types = true }: { ed: PcbEditor; spec: BodySpec; set: (s: BodySpec) => void; types?: boolean }) {
  const u = units.value;
  const f = (c: number) => formatCoord(c, u).replace(/[a-z]+$/, '');
  const lenField = (label: string, key: 'overall' | 'standoff' | 'radius' | 'height') => (
    <label class="do-row"><span>{label} ({u})</span><input type="text" value={f(spec[key])}
      onChange={(e) => { const v = len((e.target as HTMLInputElement).value, u); if (v !== undefined && v >= 0) set({ ...spec, [key]: Math.round(v) }); }} /></label>
  );
  return (
    <>
      {types && <fieldset><legend>3D Model Type</legend>
        {(['extruded', 'cylinder', 'sphere'] as BodyType[]).map((t) => (
          <label class="do-check" key={t}><input type="radio" name="body-type" checked={spec.type === t} onChange={() => set({ ...spec, type: t })} />{t[0]!.toUpperCase() + t.slice(1)}</label>
        ))}
        <label class="do-check"><input type="radio" name="body-type" checked={spec.type === 'generic'} onChange={() => set({ ...spec, type: 'generic', rot: spec.rot ?? [0, 0, 0] })} />Generic</label>
      </fieldset>}
      {spec.type === 'generic' && <GenericFields spec={spec} set={set} />}
      <fieldset><legend>Properties</legend>
        <label class="do-row"><span>Identifier</span><input type="text" value={spec.identifier} onInput={(e) => set({ ...spec, identifier: (e.target as HTMLInputElement).value })} /></label>
        <label class="do-row"><span>Body Side</span><select value={spec.bottom ? 'b' : 't'} onChange={(e) => set({ ...spec, bottom: (e.target as HTMLSelectElement).value === 'b' })}>
          <option value="t">Top Side</option><option value="b">Bottom Side</option></select></label>
        <label class="do-row"><span>Layer</span><select value={String(spec.layer)} onChange={(e) => set({ ...spec, layer: Number((e.target as HTMLSelectElement).value) })}>
          {MECH.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}</select></label>
      </fieldset>
      <fieldset><legend>{spec.type === 'extruded' ? 'Extruded' : spec.type === 'cylinder' ? 'Cylinder' : spec.type === 'generic' ? 'Placement' : 'Sphere'}</legend>
        {spec.type === 'extruded' && lenField('Overall Height', 'overall')}
        {spec.type === 'cylinder' && <>{lenField('Radius', 'radius')}{lenField('Height', 'height')}</>}
        {spec.type === 'sphere' && lenField('Radius', 'radius')}
        {lenField('Standoff Height', 'standoff')}
      </fieldset>
      <fieldset><legend>Display</legend>
        <label class="do-row" title={spec.type === 'generic' ? 'A STEP model keeps its own colours' : undefined}><span>3D Colour</span><input type="color" value={spec.colour} disabled={spec.type === 'generic'} onInput={(e) => set({ ...spec, colour: (e.target as HTMLInputElement).value })} /></label>
        <label class="do-row"><span>3D Opacity</span><input type="range" min="0" max="1" step="0.05" value={String(spec.opacity)} onInput={(e) => set({ ...spec, opacity: Number((e.target as HTMLInputElement).value) })} /></label>
      </fieldset>
    </>
  );
}

/**
 * Generic STEP Model: Embed STEP Model (the file goes into the board) or Link to STEP Model (the
 * board names it; Konium finds it by name in the project's folder and the model folders), and
 * its turn about X, Y and Z.
 */
function GenericFields({ spec, set }: { spec: BodySpec; set: (s: BodySpec) => void }) {
  const rot = spec.rot ?? [0, 0, 0];
  const choose = async (link: boolean) => {
    const f = await pickFile('.step,.stp,.STEP,.STP,.stl,.STL');
    if (!f) return;
    let model = { name: f.name, bytes: f.bytes };
    if (/\.stl$/i.test(f.name)) {
      // An STL goes in as a STEP model of its triangles: embedded (there's no STEP file to link to)
      if (link) { notify(`${f.name}: an STL can be embedded (as a STEP model of its triangles), not linked`, 'error'); return; }
      try { const s = stlBytesToStep(f.bytes, f.name); model = { name: s.name, bytes: s.bytes }; } catch (e) { notify((e as Error).message, 'error'); return; }
    } else if (!/\.(step|stp)$/i.test(f.name)) { notify(`${f.name} isn't a STEP or STL model`, 'error'); return; }
    if (link) rememberModel(model.name, model.bytes);
    set({ ...spec, model: { ...model, link } });
  };
  return (
    <fieldset><legend>Generic STEP Model</legend>
      <div class="do-row"><span>Model</span><span class="body-model">{spec.model ? `${spec.model.name} (${spec.model.link ? 'linked' : 'embedded'}, ${Math.max(1, Math.round(spec.model.bytes.length / 1024))} KB)` : 'None chosen'}</span></div>
      <div class="body-model-buttons">
        <button class="btn" onClick={() => void choose(false)}>Embed STEP Model...</button>
        <button class="btn" onClick={() => void choose(true)}>Link to STEP Model...</button>
      </div>
      {(['X', 'Y', 'Z'] as const).map((a, i) => (
        <label key={a} class="do-row"><span>Rotation {a} (°)</span><input type="text" value={String(rot[i])}
          onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isFinite(v)) { const r = [...rot] as [number, number, number]; r[i] = ((v % 360) + 360) % 360; set({ ...spec, rot: r }); } }} /></label>
      ))}
    </fieldset>
  );
}

const valid = (s: BodySpec): string | null =>
  s.type === 'generic' ? (s.model ? null : 'Embed or link a STEP model first') :
  s.type === 'extruded' ? (s.overall > s.standoff ? null : 'The overall height can’t be below the standoff height')
    : s.radius > 0 && (s.type === 'sphere' || s.height > 0) ? null : 'Give the body a radius and height';

/** Place › 3D Body: the body's settings first; OK places its outline (cylinder and sphere: their centre). */
export function Body3DDialog({ ed, spec: start, onOk, onCancel }: { ed: PcbEditor; spec: BodySpec; onOk: (s: BodySpec) => void; onCancel?: () => void }) {
  const [spec, setSpec] = useState(start);
  const ok = () => { const e = valid(spec); if (e) { notify(e, 'error'); return false; } closeDialog(); onOk(spec); return false; };
  const cancel = () => { closeDialog(); onCancel?.(); };
  return (
    <Dialog title="3D Body" width={420} onClose={cancel} onAccept={ok} class="body3d"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={cancel}>Cancel</button></>}>
      <BodyFields ed={ed} spec={spec} set={setSpec} />
    </Dialog>
  );
}

/* ── Component Body Manager ─────────────────────────────────────────────────────────── */

/** A footprint (library) or placed component (board) the manager works on. */
interface Target {
  name: string; description: string; footprint: string; library: string; height: string; bottom: boolean; component: number;
  /** Its primitives without making a library footprint's document (lazy in big libraries). */
  peek: () => PcbPrim[];
  /** The document to change (made on first use). */
  doc: () => PcbDocument;
}
const footprintTarget = (lib: PcbLibEditor, i: number): Target => {
  const f = lib.lib.footprints[i]!;
  return { name: f.name, description: f.description, footprint: f.name, library: lib.lib.name, height: f.height, bottom: false, component: 0xffff,
    peek: () => (f.loaded === false && f.original ? f.original.prims : f.doc.prims), doc: () => f.doc };
};
const componentTarget = (ed: PcbEditor, i: number): Target => {
  const c = ed.doc.components[i]!;
  return { name: c.designator, description: c.bag.get('SOURCEDESCRIPTION') ?? '', footprint: c.pattern, library: c.bag.get('SOURCEFOOTPRINTLIBRARY') ?? '',
    height: c.bag.get('HEIGHT') ?? '', bottom: c.layer === L.BOTTOM, component: i,
    peek: () => ed.doc.prims.filter((p) => 'component' in p && p.component === i), doc: () => ed.doc };
};
const currentTarget = (ed: PcbEditor): Target => {
  if (ed instanceof PcbLibEditor) return footprintTarget(ed, ed.current);
  return { name: ed.doc.name, description: '', footprint: '', library: '', height: '', bottom: false, component: 0xffff, peek: () => ed.doc.prims, doc: () => ed.doc };
};
const heightOf = (t: Target) => { const h = parseLength(t.height); return h && h > 0 ? Math.round(h) : undefined; };

/** What a body would be made with (or is): the grid's editable columns. */
interface BodyLook { standoff: number; overall: number; bottom: boolean; layer: LayerId; colour: string; opacity: number }
/** A new body: standoff 0, the footprint's height (0 when it has none, as AD17), top side, Mechanical 1, grey, solid. */
const newLook = (t: Target): BodyLook => ({ standoff: 0, overall: heightOf(t) ?? 0, bottom: t.bottom, layer: L.MECH1, colour: '#808080', opacity: 1 });
const lookOf = (b: PcbBody): BodyLook => ({ standoff: b.standoff, overall: b.overall, bottom: b.bottom, layer: b.layer, colour: hexOfColorRef(b.colour), opacity: b.opacity });
const OPACITY = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
const opacityText = (o: number) => (o >= 0.995 ? 'Solid' : `${Math.round(o * 100)}%`);

/** A row of the grid: an existing body or an offered shape; `in` while the component has it. */
type BodyRow = { description: string; outline: Vec2[]; key: string; in: boolean; look: BodyLook; poly: boolean };

/** Existing bodies first ("Component Body on <layer>", In Component), then every shape offered (Not In Component). */
function bodyRows(t: Target): BodyRow[] {
  const prims = t.peek();
  const bodies = prims.filter((p): p is PcbBody => p.kind === 'body');
  return [
    ...bodies.map((b) => ({ description: bodyDescription(b), outline: b.outline, key: outlineKey(b.outline), in: true, look: lookOf(b), poly: true })),
    ...bodyCandidates(prims).map((c) => ({ description: c.description, outline: c.outline, key: outlineKey(c.outline), in: false, look: newLook(t), poly: c.kind === 'poly' })),
  ];
}

/** Each row that is in the component, matched to one of its bodies (same outline, in order). */
function bodiesOf(rows: BodyRow[], prims: PcbPrim[]): (PcbBody | undefined)[] {
  const free = prims.filter((p): p is PcbBody => p.kind === 'body');
  return rows.map((r) => {
    if (!r.in) return undefined;
    const i = free.findIndex((b) => outlineKey(b.outline) === r.key);
    return i < 0 ? undefined : free.splice(i, 1)[0];
  });
}

/**
 * The Interactive page: "Existing and Potential Component Bodies" of one footprint or component —
 * its bodies and the shapes it offers, Body State taking each in or out (the rows stay while the
 * dialog is open, so a body taken out can go back), the heights, projection, registration layer,
 * colour and opacity edited in the grid — and the two previews.
 */
function BodyInteractive({ ed, target, refresh }: { ed: PcbEditor; target: Target; refresh: () => void }) {
  const u = units.value;
  const [rows, setRows] = useState<BodyRow[]>(() => bodyRows(target));
  const [sel, setSel] = useState<number | null>(0);
  const prims = target.peek();
  const bodies = bodiesOf(rows, prims);
  const row = sel !== null ? rows[sel] : undefined;
  const area = (o: Vec2[]) => {
    const a = polygonArea(o);
    return u === 'mm' ? `${trimNum((a / (mm(1) * mm(1))).toFixed(3))} sq. mm` : `${trimNum((a / (mil(1) * mil(1))).toFixed(1))} sq. mils`;
  };
  const lookAt = (i: number): BodyLook => { const b = bodies[i]; return b ? lookOf(b) : rows[i]!.look; };
  const setRow = (i: number, r: Partial<BodyRow>) => setRows(rows.map((x, k) => (k === i ? { ...x, ...r } : x)));
  const change = (i: number, patch: Partial<BodyLook>, label: string) => {
    const next = { ...lookAt(i), ...patch };
    if (next.overall < next.standoff) { notify('The overall height can’t be below the standoff height', 'error'); return; }
    const b = bodies[i];
    if (b) { const c = editBody(target.doc(), b, patch); if (c) { ed.undo.transact(label, (tx) => tx.add(c)); refresh(); } }
    setRow(i, { look: next });
  };
  const toggle = (i: number) => {
    const r = rows[i]!, b = bodies[i], doc = target.doc();
    if (r.in) {
      const live = b && doc.prims.find((p) => p.kind === 'body' && p.src.storage === b.src.storage && p.src.index === b.src.index);
      if (live) { ed.undo.transact('Remove 3D body', (tx) => tx.add(removePrims(doc, [live]))); ed.selection.clear(); }
      setRow(i, { in: false, look: b ? lookOf(b) : r.look });
    } else {
      const k = r.look;
      if (k.overall < k.standoff) { notify('The overall height can’t be below the standoff height', 'error'); return; }
      ed.undo.transact('Add 3D body', (tx) => tx.add(addPrimRecords(doc, [{ storage: 'ComponentBodies6', rec: bodyRecord({ ...defaultBody(), ...k, type: 'extruded' }, r.outline, target.component) }])));
      setRow(i, { in: true });
    }
    refresh();
  };
  const lenCell = (i: number, key: 'standoff' | 'overall', label: string) => (
    <input type="text" class="bm-cell" aria-label={label} value={formatCoord(lookAt(i)[key], u)}
      onChange={(e) => { const v = len((e.target as HTMLInputElement).value, u); if (v !== undefined && (key === 'standoff' || v > 0)) change(i, { [key]: Math.round(v) }, label); }} />
  );
  const idx = (r: BodyRow) => rows.indexOf(r);
  const selected = row ? [{ kind: 'body', src: { storage: '', index: -1 }, layer: lookAt(sel!).layer, outline: row.outline, component: 0, locked: false, standoff: 0, overall: 0, colour: 0, opacity: 1, bottom: false, modelType: 0, identifier: '', modelName: '' } as PcbBody] : [];
  return (
    <div class="bm-interactive">
      <div class="bm-head"><b>Existing and Potential Component Bodies</b><span>Use the Body State Column to Add or Remove Bodies from the Current Component &amp; also to check if a body is in the Current Component or not</span></div>
      <div class="bm-grid">
        <Grid<BodyRow> rows={rows} sel={row ? sel : null} onSel={setSel} empty="No primitives to make a body from"
          cols={[
            { label: 'Description', width: 'minmax(260px, 2.4fr)', get: (r) => <span class="bm-desc" title={`${r.description} (${area(r.outline)})`}><span class={`bm-ico${r.poly ? ' poly' : ''}`} aria-hidden="true" />{r.description} ({area(r.outline)})</span> },
            { label: 'Body State', width: 'minmax(150px, 1.1fr)', get: (r) => <button class={`bm-state${r.in ? ' in' : ''}`} title={r.in ? 'Click to remove this body from the component' : 'Click to add this body to the component'} onClick={(e) => { e.stopPropagation(); toggle(idx(r)); }}>{r.in ? <><span class="bm-body-ico" aria-hidden="true" />In Component {target.name}</> : `Not In Component ${target.name}`}</button> },
            { label: 'Standoff Height', width: '92px', get: (r) => lenCell(idx(r), 'standoff', 'Standoff Height') },
            { label: 'Overall Height', width: '92px', get: (r) => lenCell(idx(r), 'overall', 'Overall Height') },
            { label: 'Body Projection', width: '96px', get: (r) => <select class="bm-cell" aria-label="Body Projection" value={lookAt(idx(r)).bottom ? 'b' : 't'} onChange={(e) => change(idx(r), { bottom: (e.target as HTMLSelectElement).value === 'b' }, 'Body projection')}><option value="t">Top Side</option><option value="b">Bottom Side</option></select> },
            { label: 'Registration Layer', width: '120px', get: (r) => <select class="bm-cell" aria-label="Registration Layer" value={String(lookAt(idx(r)).layer)} onChange={(e) => change(idx(r), { layer: Number((e.target as HTMLSelectElement).value) }, 'Body layer')}>{MECH.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}</select> },
            { label: 'Body 3-D Colour', width: '96px', get: (r) => <input type="color" class="bm-colour" aria-label="Body 3-D Colour" value={lookAt(idx(r)).colour} onChange={(e) => change(idx(r), { colour: (e.target as HTMLInputElement).value }, 'Body colour')} /> },
            { label: 'Body 3-D Opacity', width: '104px', get: (r) => { const o = lookAt(idx(r)).opacity; const opts = OPACITY.includes(o) ? OPACITY : [o, ...OPACITY];
              return <select class="bm-cell" aria-label="Body 3-D Opacity" value={String(o)} onChange={(e) => change(idx(r), { opacity: Number((e.target as HTMLSelectElement).value) }, 'Body opacity')}>{opts.map((v) => <option key={v} value={String(v)}>{opacityText(v)}</option>)}</select>; } },
          ]} />
      </div>
      <div class="bm-previews">
        <fieldset><legend>Component bodies in: {target.name}</legend><FootprintPreview prims={prims} size={300} /></fieldset>
        <fieldset><legend>Selected Body : {row?.description ?? ''}</legend>{row ? <FootprintPreview prims={selected} size={300} /> : <div class="fp-preview bm-none" />}</fieldset>
      </div>
    </div>
  );
}

const unitTag = () => `[${units.value === 'mm' ? 'mm' : 'mil'}]`;

/** Tools › Manage 3D Bodies for Current Component (or a placed component's): the Interactive page alone. */
export function BodyManagerDialog({ ed, component }: { ed: PcbEditor; component?: number }) {
  const [, setN] = useState(0);
  const refresh = () => { if (ed instanceof PcbLibEditor) ed.lib.version++; setN((n) => n + 1); ed.invalidate(); tick.value++; };
  const t = component === undefined ? currentTarget(ed) : componentTarget(ed, component);
  return (
    <Dialog title={`Component Body Manager for component: ${t.name} ${unitTag()}`} width={1180} height={760} onClose={closeDialog} class="bodymanager"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="dlg-tabs" role="tablist"><button role="tab" aria-selected>Interactive</button></div>
      <BodyInteractive ed={ed} target={t} refresh={refresh} />
    </Dialog>
  );
}

/**
 * Tools › Manage 3D Bodies for Library (or for Components on Board): the Components (designator —
 * a footprint's description —, footprint, height, library), then Interactive for the one picked,
 * or Batch Update: one shape and look added to every component without a body [est: AD's Batch
 * Update page is laid out differently].
 */
export function LibraryBodyManagerDialog({ ed }: { ed: PcbEditor }) {
  const lib = ed instanceof PcbLibEditor ? ed : null;
  const count = lib ? lib.lib.footprints.length : ed.doc.components.length;
  const target = (i: number) => (lib ? footprintTarget(lib, i) : componentTarget(ed, i));
  const all = Array.from({ length: count }, (_, i) => i);
  const [pick, setPick] = useState(() => (lib ? Math.min(lib.current, count - 1) : 0));
  const [tab, setTab] = useState<'interactive' | 'batch'>('interactive');
  const [, setN] = useState(0);
  const refresh = () => { if (lib) lib.lib.version++; setN((n) => n + 1); ed.invalidate(); tick.value++; };
  const u = units.value;
  const height = (t: Target) => { const h = heightOf(t); return h ? formatCoord(h, u) : ''; };
  return (
    <Dialog title={`Component Body Manager ${unitTag()}`} width={1180} height={820} onClose={closeDialog} class="bodymanager"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="dlg-tabs" role="tablist"><button role="tab" aria-selected>Components</button></div>
      <div class="bm-comps">
        <Grid<number> rows={all} sel={count ? pick : null} onSel={setPick} empty={lib ? 'The library has no footprints' : 'The board has no components'}
          cols={[
            { label: 'Designator', width: 'minmax(220px, 1.4fr)', get: (i) => { const t = target(i); return <span class="bm-desc"><span class="bm-comp-ico" aria-hidden="true" />{lib ? t.description || t.name : t.name}</span>; } },
            { label: 'Footprint', width: 'minmax(120px, 1fr)', get: (i) => target(i).footprint },
            { label: 'Height', width: 'minmax(80px, 0.8fr)', get: (i) => height(target(i)) },
            { label: 'Library', width: 'minmax(200px, 1.6fr)', get: (i) => target(i).library },
          ]} />
      </div>
      <div class="dlg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'interactive'} onClick={() => setTab('interactive')}>Interactive</button>
        <button role="tab" aria-selected={tab === 'batch'} onClick={() => setTab('batch')}>Batch Update</button>
      </div>
      {tab === 'interactive'
        ? (count ? <BodyInteractive key={pick} ed={ed} target={target(pick)} refresh={refresh} /> : null)
        : <BodyBatch ed={ed} targets={all.map(target)} refresh={refresh} />}
    </Dialog>
  );
}

const SHAPES: [string, string][] = [['rect:all', 'Shape created from bounding rectangle on All Layers'], ['overlay', 'Polygonal shape created from primitives on TopOverlay'],
  ['rect:overlay', 'Shape created from bounding rectangle on TopOverlay'], ['rect:pads', 'Shape created from bounding rectangle on the pad layers']];

/** Batch Update: the shape and look to give every component that has no body yet; or take all bodies off. */
function BodyBatch({ ed, targets, refresh }: { ed: PcbEditor; targets: Target[]; refresh: () => void }) {
  const [shape, setShape] = useState('rect:all');
  const [look, setLook] = useState<BodyLook & { useHeight: boolean }>({ ...newLook(targets[0] ?? currentTarget(ed)), bottom: false, useHeight: true });
  const u = units.value;
  const pickShape = (t: Target): Vec2[] | null => {
    const c = bodyCandidates(t.peek());
    const overlay = t.bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    const hit = shape === 'rect:all' ? c.find((x) => x.key === 'rect:all')
      : shape === 'overlay' ? c.find((x) => x.kind === 'poly' && x.layer === overlay)
      : shape === 'rect:overlay' ? c.find((x) => x.kind === 'rect' && x.layer === overlay)
      : undefined;
    if (hit) return hit.outline;
    if (shape === 'rect:pads') { const pads = t.peek().filter((p) => p.kind === 'pad'); return pads.length ? bodyCandidates(pads).find((x) => x.key === 'rect:all')?.outline ?? null : null; }
    return null;
  };
  const add = () => {
    const changes: Change[] = [];
    let skipped = 0;
    for (const t of targets) {
      if (t.peek().some((p) => p.kind === 'body')) continue;
      const o = pickShape(t);
      if (!o) { skipped++; continue; }
      const overall = look.useHeight ? heightOf(t) ?? look.overall : look.overall;
      if (overall < look.standoff) { skipped++; continue; }
      changes.push(addPrimRecords(t.doc(), [{ storage: 'ComponentBodies6', rec: bodyRecord({ ...defaultBody(), ...look, overall, bottom: t.bottom !== look.bottom, type: 'extruded' }, o, t.component) }]));
    }
    if (!changes.length) { notify(skipped ? `No body added: ${skipped} without that shape` : 'Every component already has a body'); return; }
    ed.undo.transact(`Add ${changes.length} 3D bod${changes.length === 1 ? 'y' : 'ies'}`, (tx) => { for (const c of changes) tx.add(c); });
    refresh();
    notify(`3D bodies added to ${changes.length} component${changes.length === 1 ? '' : 's'}${skipped ? ` (${skipped} without that shape)` : ''}`);
  };
  const removeAll = () => {
    const changes: Change[] = [];
    let n = 0;
    for (const t of targets) { if (!t.peek().some((p) => p.kind === 'body')) continue; const doc = t.doc(); const b = doc.prims.filter((p) => p.kind === 'body' && (t.component === 0xffff || ('component' in p && p.component === t.component))); if (b.length) { changes.push(removePrims(doc, b)); n += b.length; } }
    if (!n) { notify('No component has a body'); return; }
    ed.undo.transact(`Remove ${n} 3D bod${n === 1 ? 'y' : 'ies'}`, (tx) => { for (const c of changes) tx.add(c); });
    ed.selection.clear(); refresh();
  };
  const lenRow = (label: string, key: 'standoff' | 'overall') => (
    <label class="do-row"><span>{label}</span><input type="text" value={formatCoord(look[key], u)} onChange={(e) => { const v = len((e.target as HTMLInputElement).value, u); if (v !== undefined && v >= 0) setLook({ ...look, [key]: Math.round(v) }); }} /></label>
  );
  const without = targets.filter((t) => !t.peek().some((p) => p.kind === 'body')).length;
  return (
    <div class="bm-batch">
      <fieldset><legend>Body to add to the {without} component{without === 1 ? '' : 's'} without one</legend>
        <label class="do-row"><span>Shape</span><select value={shape} onChange={(e) => setShape((e.target as HTMLSelectElement).value)}>{SHAPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {lenRow('Standoff Height', 'standoff')}
        <label class="do-check"><input type="checkbox" checked={look.useHeight} onChange={(e) => setLook({ ...look, useHeight: (e.target as HTMLInputElement).checked })} />Overall Height from the footprint height, where it has one</label>
        {lenRow('Overall Height', 'overall')}
        <label class="do-row"><span>Body Projection</span><select value={look.bottom ? 'b' : 't'} onChange={(e) => setLook({ ...look, bottom: (e.target as HTMLSelectElement).value === 'b' })}><option value="t">Top Side</option><option value="b">Bottom Side</option></select></label>
        <label class="do-row"><span>Registration Layer</span><select value={String(look.layer)} onChange={(e) => setLook({ ...look, layer: Number((e.target as HTMLSelectElement).value) })}>{MECH.map((l) => <option key={l} value={String(l)}>{ed.layerLabel(l)}</option>)}</select></label>
        <label class="do-row"><span>Body 3-D Colour</span><input type="color" value={look.colour} onInput={(e) => setLook({ ...look, colour: (e.target as HTMLInputElement).value })} /></label>
        <label class="do-row"><span>Body 3-D Opacity</span><select value={String(look.opacity)} onChange={(e) => setLook({ ...look, opacity: Number((e.target as HTMLSelectElement).value) })}>{OPACITY.map((v) => <option key={v} value={String(v)}>{opacityText(v)}</option>)}</select></label>
      </fieldset>
      <div class="bm-batch-buttons"><button class="btn" onClick={add}>Add Bodies</button><button class="btn" onClick={removeAll}>Remove All Bodies</button></div>
    </div>
  );
}
