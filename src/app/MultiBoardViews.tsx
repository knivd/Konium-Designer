/**
 * Multi-board documents in their tabs.
 *
 * The schematic (.MbsDoc): its sheet with the modules (one per child project, its title and
 * designator), their entries docked on their sides, and the connections between them (direct,
 * wire, cable, harness: their routes and connection points). Drag a module to move it (its
 * entries with it); Place Module adds one for a project; the side lists the modules, the
 * connections and every pin the boards share — pin to pin, with the nets on each board — and
 * what doesn't meet.
 *
 * The assembly (.MbaDoc): the boards in 3D where the assembly puts them (each from its child
 * project's board when it is open or in the project, else from its outline as AD last read it),
 * mechanical parts from their STEP models; pick a part to move it (mm) or turn it 90° about an
 * axis, Insert Board adds one from the project.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { docs, notify, projects, tick, type OpenDoc } from './state';
import type { PcbDocument } from '../model/pcb';
import { readPcbDoc } from '../formats/altium/pcbdoc';
import {
  addBoardPart, addModule, applyDirM, applyM, connectionKind, crossBoardLinks, entryName, mbsChecks, mbsColour, mbsLine, moduleProject, moveMbsItem, partBoardName, partOffset, partOutline, partSteps,
  redoChange, setPartMatrix, shifted, turned, undoChange, type MbaDocument, type MbaPart, type MbsDocument, type MbsItem, type Rgb,
} from '../formats/altium/multiboard';
import { UNITS_PER_MM } from '../core/units';
import { buildBoardModel, bodyMesh, type Mesh, type RGBA } from '../render/gl3d/boardModel';
import { ModelView, type PartMesh } from '../render/gl3d/ModelView';
import { loadModel } from '../render/gl3d/stepBodies';
import { triangulate } from '../core/geom';
import { Grid } from './Dialog';
import { importFromChildren } from './multiboardImport';
import { winOf } from './docWindows';

const projectOf = (od: OpenDoc) => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);
const f = (v: number) => (Math.round(v * 100) / 100).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ─── Multi-board schematic ────────────────────────────────────────────────────── */

const OUT = 20, ALONG = 16;
interface Box { x: number; y: number; w: number; h: number }
/** Where each drawn item is: modules by their rectangle, entries docked on a side, points where they are. */
function layout(items: MbsItem[]): Map<number, Box> {
  const by = new Map(items.map((i) => [i.id, i]));
  const out = new Map<number, Box>();
  for (const i of items) if (i.$type === '__drawingModule' && i.rect) out.set(i.id, { x: i.rect.x ?? 0, y: i.rect.y ?? 0, w: i.rect.width ?? 100, h: i.rect.height ?? 100 });
  for (const i of items) {
    if (i.$type !== '__drawingModuleEntry') continue;
    const m = out.get(i.parentId ?? -1);
    if (!m) continue;
    const o = i.offset ?? {}, dock = Number((i as { dockType?: number }).dockType ?? 0);
    // Offsets run clockwise round the module: the left side from its top, the right from its bottom, the bottom from its right, the top from its left [read from AD's files]
    const b = dock === 2 ? { x: m.x + m.w, y: m.y + m.h + (o.y ?? 0), w: OUT, h: ALONG }
      : dock === 3 ? { x: m.x + m.w + (o.x ?? 0), y: m.y + m.h, w: ALONG, h: OUT }
      : dock === 1 ? { x: m.x + (o.x ?? 0), y: m.y - OUT, w: ALONG, h: OUT }
      : { x: m.x + (o.x ?? -OUT), y: m.y + (o.y ?? 0), w: OUT, h: ALONG };
    out.set(i.id, b);
  }
  for (const i of items) if (i.$type === '__drawingConnectionPoint' && i.position) out.set(i.id, { x: i.position.x ?? 0, y: i.position.y ?? 0, w: 0, h: 0 });
  void by;
  return out;
}
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function MbsView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as unknown as MbsDocument;
  const [rev, setRev] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const [zoom, setZoom] = useState(0);
  const [tab, setTab] = useState<'pins' | 'checks'>('pins');
  const host = useRef<HTMLDivElement>(null);
  const page = d.pages[0];
  const changed = () => { d.dirty = true; setRev((r) => r + 1); tick.value++; };
  const W = page?.data.size?.width ?? 1122.52, H = page?.data.size?.height ?? 793.7;
  useEffect(() => { if (!zoom && host.current) setZoom(Math.max(0.3, Math.min(2, (host.current.clientWidth - 40) / W))); }, []);
  const z = zoom || 0.8;
  const items = page?.data.items ?? [];
  const boxes = useMemo(() => layout(items), [rev, items.length]);
  const links = useMemo(() => crossBoardLinks(d), [rev]);
  const checks = useMemo(() => mbsChecks(d), [rev]);
  const modOf = new Map(d.logical.modules.map((m) => [m.id, m]));
  const entryOf = new Map(d.logical.modules.flatMap((m) => (m.entries ?? []).map((e) => [e.id, e] as const)));
  // Colours, widths and dashes reach the markup below as numbers only (mbsColour, mbsLine): a file's styles are read as they come
  const fill = (id: unknown) => { const st = (d.styles.fillStyles ?? []).find((x) => x.id === id) as (Rgb & { color?: Rgb }) | undefined; return mbsColour(st?.color ?? (st && st.r !== undefined ? st : undefined), '#92cddc'); };
  const line = (id: unknown) => mbsLine((d.styles.lineStyles ?? []).find((x) => x.id === id));
  const svg: string[] = [`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="#fff"/>`, `<rect x="10" y="10" width="${f(W - 20)}" height="${f(H - 20)}" fill="none" stroke="#000" stroke-width="1.5"/>`];
  // A route made of segments is drawn by its segments (the route's own two ends would cut across)
  const routes = new Set(items.filter((i) => i.$type === '__drawingConnection').map((i) => i.parentId));
  for (const i of items) {
    if (i.$type !== '__drawingConnection' || routes.has(i.id)) continue;
    const a = boxes.get((i as { endItemId1?: number }).endItemId1 ?? -1), b = boxes.get((i as { endItemId2?: number }).endItemId2 ?? -1);
    if (!a || !b) continue;
    const s = line((i as { lineStyleId?: number }).lineStyleId), p = centre(a), q = centre(b);
    svg.push(`<line x1="${f(p.x)}" y1="${f(p.y)}" x2="${f(q.x)}" y2="${f(q.y)}" stroke="${s.colour}" stroke-width="${f(Math.max(1, s.w))}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`);
  }
  // Modules first, their entries and points over them
  const ordered = [...items.filter((i) => i.$type === '__drawingModule'), ...items.filter((i) => i.$type !== '__drawingModule')];
  for (const i of ordered) {
    if (i.$type === '__drawingModule') {
      const b = boxes.get(i.id)!, m = modOf.get(i.logicalObjectId ?? -1);
      const s = line((i as { lineStyleId?: number }).lineStyleId);
      svg.push(`<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="${fill((i as { fillStyleId?: number }).fillStyleId)}" stroke="${s.colour}" stroke-width="${f(s.w)}"/>`);
      if (m) {
        svg.push(`<text x="${f(b.x)}" y="${f(b.y - 5)}" font-size="13" fill="#000080">${esc(m.designator)}</text>`);
        svg.push(`<text x="${f(b.x + 4)}" y="${f(b.y + 15)}" font-size="12" fill="#000080">${esc(m.title || moduleProject(m).replace(/\.[^.]+$/, ''))}</text>`);
      }
    } else if (i.$type === '__drawingModuleEntry') {
      const b = boxes.get(i.id);
      const e = entryOf.get(i.logicalObjectId ?? -1);
      if (!b) continue;
      svg.push(`<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="#fff" stroke="#7030a0" stroke-width="0.8"/>`);
      if (e) {
        const dock = Number((i as { dockType?: number }).dockType ?? 0);
        const t = dock === 2 ? { x: b.x - 3, y: b.y + 12, a: 'end' } : dock === 3 ? { x: b.x + b.w / 2, y: b.y - 4, a: 'middle' } : dock === 1 ? { x: b.x + b.w / 2, y: b.y + b.h + 12, a: 'middle' } : { x: b.x + b.w + 3, y: b.y + 12, a: 'start' };
        svg.push(`<text x="${f(t.x)}" y="${f(t.y)}" font-size="10" text-anchor="${t.a}" fill="#800000">${esc(entryName(e))}</text>`);
      }
    } else if (i.$type === '__drawingConnectionPoint') {
      const b = boxes.get(i.id)!;
      if (i.logicalObjectId !== undefined) svg.push(`<circle cx="${f(b.x)}" cy="${f(b.y)}" r="3.5" fill="#2f5a8e"/>`);
    }
  }
  // Connections' names at their first point
  for (const c of d.logical.connections) {
    const grp = items.find((i) => (i as { logicalConnectionId?: number }).logicalConnectionId === c.id);
    const pt = grp ? boxes.get((grp as { designatorPointId?: number }).designatorPointId ?? -1) : undefined;
    if (pt) svg.push(`<text x="${f(pt.x + 6)}" y="${f(pt.y - 6)}" font-size="11" fill="#2f5a8e">${esc(c.designator ?? '')}</text>`);
  }
  const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${f(H)}" width="100%" height="100%" font-family="Arial, sans-serif">${svg.join('')}</svg>`;
  const startDrag = (e: PointerEvent, it: MbsItem) => {
    e.preventDefault(); e.stopPropagation();
    setSel(it.id);
    const x0 = e.clientX, y0 = e.clientY, el = e.currentTarget as HTMLElement;
    const window = winOf(e);
    let dx = 0, dy = 0;
    const grid = 9.6;
    const move = (ev: PointerEvent) => { dx = Math.round((ev.clientX - x0) / z / grid) * grid; dy = Math.round((ev.clientY - y0) / z / grid) * grid; el.style.transform = `translate(${dx * z}px, ${dy * z}px)`; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); el.style.transform = ''; if (dx || dy) { moveMbsItem(d, it, dx, dy); changed(); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const place = () => {
    const p = projectOf(od);
    const kids = (p?.prj.documents ?? []).filter((x) => /\.prjpcb$/i.test(x)).filter((x) => !d.logical.modules.some((m) => (m.source?.sourceProject ?? '').toLowerCase() === x.toLowerCase()));
    if (!kids.length) { notify('Place Module: every child project of the multi-board project has its module (add a .PrjPcb to the project first)', 'error'); return; }
    const n = d.logical.modules.length;
    addModule(d, kids[0]!, 60 + (n % 4) * 200, 80 + Math.floor(n / 4) * 220);
    changed();
  };
  const selItem = items.find((i) => i.id === sel);
  const selModule = selItem ? modOf.get(selItem.logicalObjectId ?? -1) : undefined;
  return (
    <div class="mbsdoc draftdoc" aria-label={`Multi-board schematic ${d.name}`}>
      <div class="dd-bar" role="toolbar" aria-label="Multi-board schematic">
        <button class="btn" onClick={place}>Place Module</button>
        <button class="btn" onClick={() => {
          const r = importFromChildren(d);
          changed();
          notify(`Import From Child Projects: ${r.connectors} connector${r.connectors === 1 ? '' : 's'} from ${r.modules} module${r.modules === 1 ? '' : 's'}, ${r.entries} new entr${r.entries === 1 ? 'y' : 'ies'}${r.missing.length ? `; not open: ${r.missing.join(', ')}` : ''}`, r.missing.length && !r.modules ? 'error' : undefined);
        }}>Import From Child Projects</button>
        <span class="dd-sep" />
        <button class="btn" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.1, z / 1.25))}>−</button>
        <button class="btn" onClick={() => host.current && setZoom((host.current.clientWidth - 40) / W)}>Fit</button>
        <button class="btn" aria-label="Zoom in" onClick={() => setZoom(Math.min(8, z * 1.25))}>+</button>
        <span class="spacer" />
        <button class="btn" disabled={!d.undo.length} onClick={() => { if (undoChange(d)) changed(); }}>Undo</button>
        <button class="btn" disabled={!d.redo.length} onClick={() => { if (redoChange(d)) changed(); }}>Redo</button>
      </div>
      <div class="dd-main">
        <div class="dd-pages" ref={host} tabIndex={0} onPointerDown={() => setSel(null)}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (undoChange(d)) changed(); } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); if (redoChange(d)) changed(); } }}>
          {!page && <p class="panel-empty">No sheet in this document.</p>}
          {page && (
            <div class="dd-page front" style={{ width: `${W * z}px`, height: `${H * z}px` }}>
              <div class="dd-art" dangerouslySetInnerHTML={{ __html: art }} />
              {items.filter((i) => i.$type === '__drawingModule').map((i) => {
                const b = boxes.get(i.id)!;
                const m = modOf.get(i.logicalObjectId ?? -1);
                return <div key={i.id} class={`dd-hit${sel === i.id ? ' on' : ''}`} role="button" aria-label={`Module ${m?.designator ?? ''}`} title={m ? `${m.designator}: ${m.source?.sourceProject ?? ''}` : ''}
                  style={{ left: `${b.x * z}px`, top: `${b.y * z}px`, width: `${b.w * z}px`, height: `${b.h * z}px` }} onPointerDown={(e) => startDrag(e as unknown as PointerEvent, i)} />;
              })}
            </div>
          )}
        </div>
        <aside class="dd-props mbs-side" aria-label="Multi-board">
          {selModule ? (
            <div class="dd-propform">
              <h3>Module {selModule.designator}{selModule.title ? ` — ${selModule.title}` : ''}</h3>
              <p class="small">Child project: <b>{selModule.source?.sourceProject ?? '(none)'}</b></p>
              <p class="small">Connectors: {(selModule.components ?? []).map((c) => `${c.designator} (${c.pins.length} pins)`).join(', ') || 'none imported'}</p>
              <p class="small">Entries: {(selModule.entries ?? []).map(entryName).join(', ') || 'none'}</p>
            </div>
          ) : (
            <div class="dd-propform">
              <h3>{d.logical.modules.length} module{d.logical.modules.length === 1 ? '' : 's'}, {d.logical.connections.length} connection{d.logical.connections.length === 1 ? '' : 's'}</h3>
              <ul class="mbs-list">{d.logical.connections.map((c) => <li key={c.id}>{c.designator ?? c.id}: {connectionKind(c)}</li>)}</ul>
            </div>
          )}
          <div class="mbs-tabs">
            <button class={`btn${tab === 'pins' ? ' on' : ''}`} onClick={() => setTab('pins')}>Connectivity ({links.length})</button>
            <button class={`btn${tab === 'checks' ? ' on' : ''}`} onClick={() => setTab('checks')}>Checks ({checks.length})</button>
          </div>
          {tab === 'pins'
            ? <Grid rows={links} empty="No pins shared between boards" cols={[
                { label: 'Conn.', width: '52px', get: (l) => l.connection }, { label: 'From', width: 'minmax(70px,1fr)', get: (l) => l.a },
                { label: 'To', width: 'minmax(70px,1fr)', get: (l) => l.b }, { label: 'Net', width: 'minmax(70px,1fr)', get: (l) => (l.netA === l.netB || !l.netB ? l.netA : `${l.netA} / ${l.netB}`) },
              ]} />
            : <ul class="mbs-list">{checks.length ? checks.map((c, i) => <li key={i} class="err">{c}</li>) : <li>Nothing to report.</li>}</ul>}
        </aside>
      </div>
    </div>
  );
}

/* ─── Multi-board assembly ─────────────────────────────────────────────────────── */

const boardsRead = new WeakMap<Uint8Array, PcbDocument | null>();
/** A board by its file's name: open in a tab, else read from a project's files. */
export function boardByName(name: string): PcbDocument | null {
  const n = name.toLowerCase();
  const open = docs.value.find((d) => d.doc.kind === 'PcbDoc' && d.name.toLowerCase() === n)?.doc as PcbDocument | undefined;
  if (open) return open;
  for (const p of projects.value) {
    const fl = p.files.get(n);
    if (!fl) continue;
    let b = boardsRead.get(fl.bytes);
    if (b === undefined) { try { b = readPcbDoc(fl.bytes, fl.name); } catch { b = null; } boardsRead.set(fl.bytes, b); }
    if (b) return b;
  }
  return null;
}

const GREEN: RGBA = [0.16, 0.42, 0.24, 1];
/** A mesh moved by a part's matrix (and first by a local shift). */
function placed(m: Mesh, M: number[], local: [number, number, number], key: string, colour?: RGBA): PartMesh {
  const pos = new Float32Array(m.pos.length), nrm = new Float32Array(m.nrm.length);
  for (let i = 0; i < m.pos.length; i += 3) {
    const p = applyM(M, [m.pos[i]! + local[0], m.pos[i + 1]! + local[1], m.pos[i + 2]! + local[2]]);
    pos[i] = p[0]; pos[i + 1] = p[1]; pos[i + 2] = p[2];
    const n = applyDirM(M, [m.nrm[i]!, m.nrm[i + 1]!, m.nrm[i + 2]!]);
    nrm[i] = n[0]; nrm[i + 1] = n[1]; nrm[i + 2] = n[2];
  }
  return { pos, nrm, uv: null, idx: m.idx, colour: colour ?? m.colour, key };
}
/** An outline (mm) as a slab, top at 0, t below. */
function slab(outline: { x: number; y: number }[], t: number): Mesh {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const tri = triangulate(outline);
  for (const [z, nz] of [[0, 1], [-t, -1]] as const) {
    const base = pos.length / 3;
    for (const v of outline) { pos.push(v.x, v.y, z); nrm.push(0, 0, nz); }
    for (let i = 0; i < tri.length; i += 3) idx.push(...(nz > 0 ? [base + tri[i]!, base + tri[i + 1]!, base + tri[i + 2]!] : [base + tri[i]!, base + tri[i + 2]!, base + tri[i + 1]!]));
  }
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    const nx = b.y - a.y, ny = a.x - b.x, l = Math.hypot(nx, ny) || 1, base = pos.length / 3;
    pos.push(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, -t, a.x, a.y, -t);
    for (let k = 0; k < 4; k++) nrm.push(nx / l, ny / l, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), uv: null, idx: Uint32Array.from(idx), colour: GREEN };
}

/** A part's meshes in the assembly (mm): its board as Konium builds it, else its outline as AD last read it. */
function partMeshes(d: MbaDocument, p: MbaPart, key: string, steps: Map<string, Mesh[]>): { meshes: PartMesh[]; live: boolean } {
  if (p.type !== 0) return { meshes: (steps.get(key) ?? []).map((m) => placed(m, p.m, [0, 0, 0], key)), live: true };
  const board = boardByName(partBoardName(p));
  const off = partOffset(p);
  if (board) {
    const bm = buildBoardModel(board);
    // The model is in mm from its centre, z up from its underside; the part's own frame from the offset, its top at 0 [est]
    const local: [number, number, number] = [(bm.centre.x - off.x) / UNITS_PER_MM, (bm.centre.y - off.y) / UNITS_PER_MM, -bm.thickness];
    const meshes = bm.meshes.map((m) => placed(m, p.m, local, key, m.texture ? GREEN : undefined));
    for (const b of bm.bodies) meshes.push(placed(bodyMesh(b), p.m, local, key));
    for (const m of bm.wires ?? []) meshes.push(placed(m, p.m, local, key));
    return { meshes, live: true };
  }
  const out = partOutline(p).map((q) => ({ x: q.x / UNITS_PER_MM, y: q.y / UNITS_PER_MM }));
  return { meshes: out.length >= 3 ? [placed(slab(out, 1.6), p.m, [0, 0, 0], key)] : [], live: false };
  void d;
}

export function MbaView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as unknown as MbaDocument;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const [rev, setRev] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [steps, setSteps] = useState(new Map<string, Mesh[]>());
  const [step, setStep] = useState('5');
  const fitted = useRef(false);
  const changed = () => { d.dirty = true; setRev((r) => r + 1); tick.value++; };
  const keyOf = (p: MbaPart) => p.folder;
  // Mechanical parts' STEP models, read once
  useEffect(() => {
    let live = true;
    for (const p of d.parts) {
      if (p.type === 0 || steps.has(keyOf(p))) continue;
      const s = partSteps(d, p)[0];
      if (!s) continue;
      void loadModel(`mba:${d.name}:${s.name}`, s.bytes).then((m) => {
        if (!live || !m) return;
        setSteps((was) => new Map([...was, [keyOf(p), m.meshes.map((x) => ({ pos: x.pos, nrm: x.nrm, uv: null, idx: x.idx, colour: x.colour as RGBA }))]]));
      });
    }
    return () => { live = false; };
  }, [d.parts.length]);
  const drawn = useMemo(() => {
    const meshes: PartMesh[] = [];
    const notes: string[] = [];
    for (const p of d.parts) {
      if (p.json.IsVisible === false) continue;
      const r = partMeshes(d, p, keyOf(p), steps);
      meshes.push(...r.meshes);
      if (!r.live) notes.push(`${p.name}: ${partBoardName(p)} isn't open: its outline as the assembly last saved it`);
    }
    let lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, m.pos[i + k]!); hi[k] = Math.max(hi[k]!, m.pos[i + k]!); }
    if (!Number.isFinite(lo[0])) { lo = [-10, -10, -10]; hi = [10, 10, 10]; }
    return { meshes, bounds: { min: lo, max: hi }, notes };
  }, [rev, steps, docs.value.length]);
  useEffect(() => {
    if (!host.current) return;
    const v = new ModelView(host.current, { click: (h) => setSel(h ? h.key : null) });
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
  const part = d.parts.find((p) => keyOf(p) === sel);
  const s = Number(step) || 0;
  const move = (dx: number, dy: number, dz: number) => { if (part) { setPartMatrix(d, part, shifted(part.m, dx, dy, dz)); changed(); } };
  const turn = (axis: 'x' | 'y' | 'z', deg: number) => { if (part) { setPartMatrix(d, part, turned(part.m, axis, deg), 'Rotate'); changed(); } };
  const insert = () => {
    const p = projectOf(od);
    const have = new Set(d.parts.map((x) => partBoardName(x).toLowerCase()));
    const kids = (p?.prj.documents ?? []).filter((x) => /\.prjpcb$/i.test(x));
    for (const k of kids) {
      const kp = projects.value.find((x) => x.name.toLowerCase() === k.split(/[\\/]/).pop()!.toLowerCase());
      const bn = kp?.prj.documents.map((x) => x.split(/[\\/]/).pop()!).find((x) => /\.pcbdoc$/i.test(x));
      if (!bn || have.has(bn.toLowerCase())) continue;
      const b = boardByName(bn);
      const xs = b?.board.outline.map((v) => v.x) ?? [0], ys = b?.board.outline.map((v) => v.y) ?? [0];
      const at = d.parts.length * 60;
      addBoardPart(d, { name: bn, path: `${k.replace(/[^\\/]+$/, '')}${bn}`, offset: { x: Math.min(...xs), y: Math.min(...ys) }, designator: String(d.parts.length + 1), title: bn.replace(/\.[^.]+$/, ''), sourceId: `${bn}-${d.parts.length + 1}` }, [at, 0, 0]);
      changed();
      return;
    }
    notify('Insert Board: every child project\'s board is in the assembly (or no child project has a board)', 'error');
  };
  const t = part ? part.m.slice(12, 15) : null;
  return (
    <div class="mbadoc draftdoc" aria-label={`Multi-board assembly ${d.name}`}>
      <div class="dd-bar" role="toolbar" aria-label="Multi-board assembly">
        <button class="btn" onClick={insert}>Insert Board</button>
        <span class="dd-sep" />
        {(['iso', 'top', 'front', 'right'] as const).map((k) => <button key={k} class="btn" onClick={() => view.current?.view(k)}>{k === 'iso' ? 'Isometric' : k[0]!.toUpperCase() + k.slice(1)}</button>)}
        <span class="spacer" />
        <button class="btn" disabled={!d.undo.length} onClick={() => { if (undoChange(d)) changed(); }}>Undo</button>
        <button class="btn" disabled={!d.redo.length} onClick={() => { if (redoChange(d)) changed(); }}>Redo</button>
      </div>
      <div class="dd-main">
        <div class="mba-view" ref={host} />
        <aside class="dd-props" aria-label="Parts">
          <h3>Parts</h3>
          <ul class="mbs-list mba-parts">
            {d.parts.map((p) => <li key={keyOf(p)} class={sel === keyOf(p) ? 'on' : ''}><button class="link" onClick={() => setSel(keyOf(p))}>{p.type === 0 ? '▭' : '◆'} {p.name}{p.type === 0 ? ` (${partBoardName(p)})` : ''}</button></li>)}
          </ul>
          {part && t && (
            <div class="dd-propform">
              <h3>{part.name}</h3>
              <p class="small">At X {f(t[0]!)}, Y {f(t[1]!)}, Z {f(t[2]!)} mm</p>
              <label class="dd-field">Step (mm)<input type="text" value={step} onInput={(e) => setStep((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
              <div class="mba-moves">
                {(['x', 'y', 'z'] as const).map((a, k) => (
                  <span key={a}><button class="btn" onClick={() => move(k === 0 ? -s : 0, k === 1 ? -s : 0, k === 2 ? -s : 0)}>−{a.toUpperCase()}</button><button class="btn" onClick={() => move(k === 0 ? s : 0, k === 1 ? s : 0, k === 2 ? s : 0)}>+{a.toUpperCase()}</button></span>
                ))}
              </div>
              <div class="mba-moves">
                {(['x', 'y', 'z'] as const).map((a) => <button key={a} class="btn" onClick={() => turn(a, 90)}>Turn 90° about {a.toUpperCase()}</button>)}
              </div>
            </div>
          )}
          {drawn.notes.length > 0 && <ul class="mbs-list muted small">{drawn.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </aside>
      </div>
    </div>
  );
}
