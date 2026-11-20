/**
 * The 3D model editor (a .step / .stp document, or File › New › 3D Model): the model's parts
 * in 3D, a list of them (shown or hidden, coloured), the selected part's properties (name,
 * position, sizes of a box, cylinder, cone or dome made here — a box's corners and a cylinder's
 * rims filleted or chamfered — a colour of its own), and the tools — Import STEP, Box, Cylinder,
 * Cone, Dome, Split (an assembly into its parts), Delete; Undo, Redo; turn by 90° about X, Y or Z (the selected part, else
 * the whole model) or by any angle; origin to the bottom centre or the centre; Measure (corners
 * snapped); standard views; Place on Footprint (the model as a 3D body of the open PCB
 * library's footprint). File › Save writes it: unchanged, the file as it was; changed, an AP214
 * assembly of its parts. Keys: Delete, Ctrl+Z, Ctrl+Y, Esc.
 */
import { locale } from '../core/locale';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activeId, docKeys, docs, notify, tick, units, type OpenDoc } from './state';
import { ModelView, type ModelHit, type PartMesh, type V3 } from '../render/gl3d/ModelView';
import { loadModel } from '../render/gl3d/stepBodies';
import { apply, applyDir, type RGBA, type StepModel } from '../formats/step/tessellate';
import { editParts, extent, importedPart, primitivePart, redoStep, shift, andThen, splitPart, turn, undoStep, writeStepDoc, type StepDocument, type StepPart } from '../model/stepDoc';
import type { Primitive } from '../formats/step/write';
import { pickFile, saveFileAs } from '../platform/fs';
import { writeStl } from '../formats/stl';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { placeModelOnFootprint } from './pcbEditCommands';
import { bar, marker } from '../render/gl3d/Viewer3D';
import { hexRgb } from '../core/view3d';
import { UNITS_PER_MM, parseLength } from '../core/units';

/* ── each part's model, read once (by its text) ── */
const models = new Map<string, StepModel | null>();
const reading = new Map<string, Promise<void>>();
function hash(s: string): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(s.length / 4096));
  for (let i = 0; i < s.length; i += step) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length.toString(36)}${h.toString(36)}`;
}
const keyOf = (p: StepPart) => `${p.id}:${hash(p.text)}`;
const bytesOf = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/** The parts as drawn: each model's meshes placed, in the part's own colour if it has one. */
function partMeshes(parts: StepPart[]): { meshes: PartMesh[]; bounds: { min: V3; max: V3 } | null; faces: number; tris: number } {
  const meshes: PartMesh[] = [], ext: { xf: StepPart['xf']; min: V3; max: V3 }[] = [];
  let faces = 0, tris = 0;
  for (const p of parts) {
    const m = models.get(keyOf(p));
    if (!m || p.hidden) continue;
    faces += m.faces;
    ext.push({ xf: p.xf, min: m.min, max: m.max });
    for (const s of m.meshes) {
      const pos = new Float32Array(s.pos.length), nrm = new Float32Array(s.nrm.length);
      for (let i = 0; i < s.pos.length; i += 3) {
        const q = apply(p.xf, [s.pos[i]!, s.pos[i + 1]!, s.pos[i + 2]!]), n = applyDir(p.xf, [s.nrm[i]!, s.nrm[i + 1]!, s.nrm[i + 2]!]);
        pos[i] = q[0]; pos[i + 1] = q[1]; pos[i + 2] = q[2]; nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];
      }
      tris += s.idx.length / 3;
      meshes.push({ pos, nrm, uv: null, idx: s.idx, colour: p.colour ? [p.colour[0], p.colour[1], p.colour[2], s.colour[3]] : s.colour, key: p.id });
    }
  }
  return { meshes, bounds: extent(ext), faces, tris };
}

const hexOf = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const rgbaOf = (hex: string, a = 1): RGBA => { const [r, g, b] = hexRgb(hex); return [r / 255, g / 255, b / 255, a]; };
const nextName = (parts: StepPart[], stem: string) => { let n = 1; while (parts.some((p) => p.name === `${stem}${n}`)) n++; return `${stem}${n}`; };

export function StepDocView({ od }: { od: OpenDoc }) {
  void tick.value;
  const doc = od.doc as StepDocument;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const [ver, setVer] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [measure, setMeasure] = useState<{ a: V3 | null } | null>(null);
  const [result, setResult] = useState('');
  const [turnBy, setTurnBy] = useState({ axis: 'z' as 'x' | 'y' | 'z', deg: '45' });
  const fitted = useRef(false);
  const u = units.value;
  const fmt = (v: number) => (u === 'mm' ? `${v.toFixed(3)} mm` : `${(v / 0.0254).toFixed(2)} mil`);
  const num = (v: number) => (u === 'mm' ? v.toFixed(3) : (v / 0.0254).toFixed(2));
  /** A length typed (in the current unit unless it says), in mm. */
  const lenIn = (s: string): number | null => { const c = parseLength(/^\s*-?[\d.]+\s*$/.test(s) ? `${s.trim()}${u}` : s); return c === undefined ? null : Math.round((c / UNITS_PER_MM) * 1e6) / 1e6; };

  // Read each part's model (in the background); redraw as they come
  useEffect(() => {
    for (const p of doc.parts) {
      const k = keyOf(p);
      if (models.has(k) || reading.has(k)) continue;
      reading.set(k, loadModel(`stepdoc:${k}`, bytesOf(p.text)).then((m) => { models.set(k, m); if (!m) notify(`${p.name}: no shapes Konium Designer could read in it`, 'error'); }).catch(() => { models.set(k, null); })
        .finally(() => { reading.delete(k); setVer((x) => x + 1); }));
    }
  }, [doc.parts]);
  const drawn = useMemo(() => partMeshes(doc.parts), [doc.parts, ver]);
  const busy = doc.parts.some((p) => !models.has(keyOf(p)));

  // The view: made once, given the meshes as they change
  useEffect(() => {
    if (!host.current) return;
    const v = new ModelView(host.current, { click: (h) => clickRef.current(h) });
    view.current = v;
    return () => { v.dispose(); view.current = null; };
  }, []);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.selected = new Set(sel ? [sel] : []);
    v.setMeshes(drawn.meshes, drawn.bounds);
    if (!fitted.current && drawn.meshes.length) { fitted.current = true; v.view('iso'); }
  }, [drawn, sel]);

  const change = (label: string, parts: StepPart[]) => { editParts(doc, label, parts); tick.value++; };
  const selPart = doc.parts.find((p) => p.id === sel) ?? null;
  const targets = () => (selPart ? [selPart.id] : doc.parts.map((p) => p.id));
  const placeAll = (label: string, xf: StepPart['xf']) => {
    const ids = new Set(targets());
    if (!ids.size) return;
    change(label, doc.parts.map((p) => (ids.has(p.id) ? { ...p, xf: andThen(p.xf, xf) } : p)));
  };
  const add = (p: StepPart) => { change(`Add ${p.name}`, [...doc.parts, p]); setSel(p.id); };
  const addPrim = (shape: Primitive) => add(primitivePart(shape, shape.kind === 'box' ? [0.22, 0.22, 0.24, 1] : [0.82, 0.82, 0.84, 1], nextName(doc.parts, { box: 'Box', cylinder: 'Cylinder', cone: 'Cone', dome: 'Dome' }[shape.kind])));
  /** Split: the selected part (else the only one) as a part for each of its solids, where its assembly places them. */
  const split = () => {
    const p = selPart ?? (doc.parts.length === 1 ? doc.parts[0]! : null);
    if (!p) { notify('Select the part to split', 'error'); return; }
    const parts = splitPart(p);
    if (!parts) { notify(`${p.name}: one solid, nothing to split`); return; }
    const i = doc.parts.indexOf(p);
    change(`Split ${p.name}`, [...doc.parts.slice(0, i), ...parts, ...doc.parts.slice(i + 1)]);
    setSel(null);
    notify(`${p.name} split into ${parts.length} parts`);
  };
  const importStep = async () => {
    const f = await pickFile('.step,.stp,.STEP,.STP,.stl,.STL');
    if (!f) return;
    try { add(importedPart(f.bytes, f.name)); } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
  };
  const exportStl = async () => {
    const name = `${od.name.replace(/\.(step|stp)$/i, '')}.stl`;
    try { const h = await saveFileAs(name, writeStl(name.replace(/\.stl$/i, ''), drawn.meshes)); if (h !== null) notify(`${name} written (${drawn.tris.toLocaleString(locale())} triangles)`); }
    catch (e) { notify(`Couldn't write ${name}: ${(e as Error).message}`, 'error'); }
  };
  const del = () => { if (!selPart) return false; change(`Delete ${selPart.name}`, doc.parts.filter((p) => p.id !== selPart.id)); setSel(null); return true; };
  const origin = (bottom: boolean) => {
    const b = drawn.bounds;
    if (!b) return;
    const c: V3 = [-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -(bottom ? b.min[2] : (b.min[2] + b.max[2]) / 2)];
    change(bottom ? 'Origin to bottom centre' : 'Origin to centre', doc.parts.map((p) => ({ ...p, xf: andThen(p.xf, shift(c)) })));
    fitted.current = false;
  };
  const setPart = (label: string, q: Partial<StepPart>) => { if (selPart) change(label, doc.parts.map((p) => (p.id === selPart.id ? { ...p, ...q } : p))); };
  const reshape = (shape: Primitive, colour?: RGBA) => {
    if (!selPart?.prim) return;
    const np = primitivePart(shape, colour ?? selPart.prim.colour, selPart.name, selPart.xf, selPart.id);
    change(`Change ${selPart.name}`, doc.parts.map((p) => (p.id === selPart.id ? { ...np, hidden: p.hidden } : p)));
  };
  const undo = () => { const l = undoStep(doc); if (l) { notify(`Undone: ${l}`); tick.value++; } return !!l; };
  const redo = () => { const l = redoStep(doc); if (l) { notify(`Redone: ${l}`); tick.value++; } return !!l; };

  // Measure: two clicks (snapped to a corner near the cursor), the distance between
  const clickRef = useRef<(h: ModelHit | null) => void>(() => {});
  clickRef.current = (h) => {
    const v = view.current;
    if (!measure) { setSel(h?.key ?? null); return; }
    if (!h || !v) return;
    const s = v.project(h.vertex), q = v.project(h.p);
    const p = Math.hypot(s.x - q.x, s.y - q.y) < 12 ? h.vertex : h.p;
    const r = Math.max(0.02, v.size() / 150);
    if (!measure.a) { setMeasure({ a: p }); v.setMarks([marker(p, r, [1, 0.85, 0.1, 1])]); setResult('Measure: click the second point'); return; }
    const a = measure.a, d: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    v.setMarks([marker(a, r, [1, 0.85, 0.1, 1]), marker(p, r, [1, 0.85, 0.1, 1]), bar(a, p, r / 3, [1, 0.85, 0.1, 1])]);
    setResult(`Distance ${fmt(Math.hypot(...d))} (ΔX ${fmt(d[0])}, ΔY ${fmt(d[1])}, ΔZ ${fmt(d[2])})`);
    setMeasure({ a: null });
  };
  const endMeasure = () => { setMeasure(null); setResult(''); view.current?.setMarks([]); };

  // Place on Footprint: the open PCB library's footprint takes the model as a 3D body
  const toFootprint = () => {
    const lib = [...docs.value].reverse().find((d) => d.editor instanceof PcbLibEditor);
    if (!lib || !(lib.editor instanceof PcbLibEditor)) { notify('Open a PCB library (the footprint to put the model on) first', 'error'); return; }
    if (!doc.parts.length) { notify('The model is empty: import a STEP model or add a box or cylinder', 'error'); return; }
    const bytes = writeStepDoc(doc);
    activeId.value = lib.id;
    placeModelOnFootprint(lib.editor, { name: /\.(step|stp)$/i.test(doc.name) ? doc.name : `${doc.name}.step`, bytes });
  };

  // Keys while this document is in front
  useEffect(() => {
    docKeys.set(od.id, (c) => {
      if (c === 'Delete') return del();
      if (c === 'Ctrl+Z') return undo();
      if (c === 'Ctrl+Y' || c === 'Ctrl+Shift+Z') return redo();
      if (c === 'Escape') { if (measure) endMeasure(); else setSel(null); return true; }
      return false;
    });
    return () => { docKeys.delete(od.id); };
  });

  const b = drawn.bounds;
  const size = b ? `${fmt(b.max[0] - b.min[0])} × ${fmt(b.max[1] - b.min[1])} × ${fmt(b.max[2] - b.min[2])}` : '—';
  const btn = (label: string, run: () => void, title?: string, on?: boolean, off?: boolean) => <button class={`btn${on ? ' on' : ''}`} title={title} aria-pressed={on} disabled={off} onClick={run}>{label}</button>;
  const prim = selPart?.prim?.shape;
  const choice = (label: string, value: string, opts: [string, string][], set: (v: string) => void) => (
    <label class="sd-field">{label}<select aria-label={label} value={value} onChange={(e) => set((e.target as HTMLSelectElement).value)}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
  );
  const lenBox = (label: string, value: number, set: (v: number) => void) => (
    <label class="sd-field">{label}<input type="text" aria-label={label} value={num(value)} onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => { const v = lenIn((e.target as HTMLInputElement).value); if (v === null) { notify(`${label}: give a length`, 'error'); return; } set(v); }} /></label>
  );
  return (
    <div class="stepdoc" aria-label="3D model editor">
      <aside class="sd-side">
        <h3>Parts</h3>
        <div class="sd-parts" role="listbox" aria-label="Parts">
          {doc.parts.map((p) => {
            const m = models.get(keyOf(p));
            const c = p.colour ?? m?.meshes[0]?.colour ?? [0.75, 0.75, 0.75, 1];
            return (
              <div key={p.id} role="option" aria-selected={p.id === sel} class={`sd-part${p.id === sel ? ' on' : ''}`} onMouseDown={() => setSel(p.id)}>
                <input type="checkbox" aria-label={`Show ${p.name}`} checked={!p.hidden} onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => change((e.target as HTMLInputElement).checked ? `Show ${p.name}` : `Hide ${p.name}`, doc.parts.map((x) => (x.id === p.id ? { ...x, hidden: !(e.target as HTMLInputElement).checked } : x)))} />
                <span class="sd-swatch" style={{ background: hexOf(c) }} />
                <span class="sd-name">{p.name}</span>
                {!models.has(keyOf(p)) && <span class="muted small">reading…</span>}
              </div>
            );
          })}
          {!doc.parts.length && <p class="muted small">No parts yet: Import STEP, Box, Cylinder, Cone or Dome.</p>}
        </div>
        {selPart && (
          <fieldset class="sd-props">
            <legend>{selPart.name}</legend>
            <label class="sd-field">Name<input type="text" aria-label="Part name" value={selPart.name} onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) setPart('Rename part', { name: v }); }} /></label>
            {(['X', 'Y', 'Z'] as const).map((ax, i) => lenBox(`Position ${ax}`, selPart.xf.o[i]!, (v) => { const o = [...selPart.xf.o] as V3; o[i] = v; setPart(`Move ${selPart.name}`, { xf: { ...selPart.xf, o } }); }))}
            {prim?.kind === 'box' && <>{lenBox('Width (X)', prim.w, (v) => v > 0 && reshape({ ...prim, w: v }))}{lenBox('Depth (Y)', prim.d, (v) => v > 0 && reshape({ ...prim, d: v }))}{lenBox('Height (Z)', prim.h, (v) => v > 0 && reshape({ ...prim, h: v }))}</>}
            {prim?.kind === 'box' && <>{lenBox('Corner radius', prim.corner ?? 0, (v) => v >= 0 && reshape({ ...prim, corner: v }))}
              {choice('Corners', prim.corners ?? 'fillet', [['fillet', 'Fillet'], ['chamfer', 'Chamfer']], (v) => reshape({ ...prim, corners: v as 'fillet' }))}</>}
            {prim?.kind === 'cylinder' && <>{lenBox('Radius', prim.r, (v) => v > 0 && reshape({ ...prim, r: v }))}{lenBox('Height (Z)', prim.h, (v) => v > 0 && reshape({ ...prim, h: v }))}
              {lenBox('Rim radius', prim.edge ?? 0, (v) => v >= 0 && reshape({ ...prim, edge: v }))}
              {choice('Rims', prim.edges ?? 'fillet', [['fillet', 'Fillet'], ['chamfer', 'Chamfer']], (v) => reshape({ ...prim, edges: v as 'fillet' }))}
              {choice('Which rims', prim.rims ?? 'top', [['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Both']], (v) => reshape({ ...prim, rims: v as 'top' }))}</>}
            {prim?.kind === 'cone' && <>{lenBox('Bottom radius', prim.r1, (v) => v >= 0 && (v > 0 || prim.r2 > 0) && reshape({ ...prim, r1: v }))}{lenBox('Top radius', prim.r2, (v) => v >= 0 && (v > 0 || prim.r1 > 0) && reshape({ ...prim, r2: v }))}{lenBox('Height (Z)', prim.h, (v) => v > 0 && reshape({ ...prim, h: v }))}</>}
            {prim?.kind === 'dome' && lenBox('Radius', prim.r, (v) => v > 0 && reshape({ ...prim, r: v }))}
            <label class="sd-field">Colour
              <input type="color" aria-label="Part colour" value={hexOf(selPart.prim ? selPart.prim.colour : selPart.colour ?? models.get(keyOf(selPart))?.meshes[0]?.colour ?? [0.75, 0.75, 0.75, 1])}
                onChange={(e) => { const c = rgbaOf((e.target as HTMLInputElement).value); if (selPart.prim) reshape(selPart.prim.shape, c); else setPart(`Colour ${selPart.name}`, { colour: c }); }} />
              {!selPart.prim && selPart.colour && <button class="btn" onClick={() => setPart(`Colour ${selPart.name}`, { colour: null })}>Model's Own</button>}
            </label>
            <button class="btn" onClick={() => del()}>Delete Part</button>
          </fieldset>
        )}
        <div class="sd-info small">
          <div>Size: {size}</div>
          <div>{doc.parts.length} part{doc.parts.length === 1 ? '' : 's'}, {drawn.faces.toLocaleString(locale())} faces, {drawn.tris.toLocaleString(locale())} triangles{busy ? ' (reading…)' : ''}</div>
          <div class="muted">Origin at the axes (X red, Y green, Z blue). Turns are about the origin.</div>
        </div>
      </aside>
      <div class="sd-main">
        <div class="sd-bar" role="toolbar" aria-label="3D model tools">
          {btn('Import STEP...', () => void importStep(), 'Add another STEP (or STL) model as a part')}
          {btn('Box', () => addPrim({ kind: 'box', w: 5, d: 5, h: 2 }), 'Add a box (5 × 5 × 2 mm) standing on the origin')}
          {btn('Cylinder', () => addPrim({ kind: 'cylinder', r: 0.5, h: 3 }), 'Add a cylinder (0.5 mm radius, 3 mm tall) standing on the origin')}
          {btn('Cone', () => addPrim({ kind: 'cone', r1: 1, r2: 0.5, h: 2 }), 'Add a cone (1 mm radius at the bottom, 0.5 mm at the top, 2 mm tall; a top radius of 0 makes a point)')}
          {btn('Dome', () => addPrim({ kind: 'dome', r: 1.5 }), 'Add a dome (half a sphere, 1.5 mm radius) standing on the origin')}
          {btn('Split', split, 'Split the selected part (an assembly, or several bodies) into a part for each solid, placed as its assembly places them')}
          <span class="sep" />
          {btn('Undo', () => void undo(), 'Ctrl+Z', false, !doc.undo.length)}
          {btn('Redo', () => void redo(), 'Ctrl+Y', false, !doc.redo.length)}
          <span class="sep" />
          {(['x', 'y', 'z'] as const).map((ax) => btn(`${ax.toUpperCase()} 90°`, () => placeAll(`Turn about ${ax.toUpperCase()}`, turn(ax, 90)), `Turn ${selPart ? selPart.name : 'the model'} 90° about ${ax.toUpperCase()}`))}
          <select aria-label="Turn axis" value={turnBy.axis} onChange={(e) => setTurnBy({ ...turnBy, axis: (e.target as HTMLSelectElement).value as 'x' })}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>
          <input type="text" class="sd-deg" aria-label="Turn angle" value={turnBy.deg} onKeyDown={(e) => e.stopPropagation()} onInput={(e) => setTurnBy({ ...turnBy, deg: (e.target as HTMLInputElement).value })} />
          {btn('Turn', () => { const d = Number(turnBy.deg); if (!Number.isFinite(d)) { notify('Turn: give an angle in degrees', 'error'); return; } placeAll(`Turn ${d}° about ${turnBy.axis.toUpperCase()}`, turn(turnBy.axis, d)); }, 'Turn by this angle about this axis')}
          <span class="sep" />
          {btn('Origin: Bottom Centre', () => origin(true), 'Move the model so its underside is centred on the origin (as a footprint wants it)')}
          {btn('Origin: Centre', () => origin(false), 'Move the model so its middle is on the origin')}
          <span class="sep" />
          {btn('Measure', () => (measure ? endMeasure() : (setMeasure({ a: null }), setResult('Measure: click the first point'))), 'Distance between two points (corners snap)', !!measure)}
          <span class="sep" />
          {(['iso', 'top', 'front', 'right', 'bottom'] as const).map((k) => btn(k === 'iso' ? 'Iso' : k[0]!.toUpperCase() + k.slice(1), () => view.current?.view(k), `${k === 'iso' ? 'Isometric' : k[0]!.toUpperCase() + k.slice(1)} view`))}
          {btn('Fit', () => view.current?.fit(), 'Fit the model in the view')}
          <span class="sep" />
          {btn('Place on Footprint', toFootprint, 'Put the model on the open PCB library\'s footprint as a 3D body (embedded)')}
          {btn('Export STL...', () => void exportStl(), 'Save the model\'s triangles as an STL file (millimetres)', false, !drawn.meshes.length)}
        </div>
        <div class="sd-canvas" ref={host}>{result && <div class="sd-result" role="status">{result}</div>}</div>
      </div>
    </div>
  );
}
