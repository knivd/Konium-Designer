/**
 * An enclosure document in its tab, laid out as a small CAD workspace: the tools down the left
 * (pick, and what can be put on a face: holes, cut-outs, slots, pockets, vents, protrusions, text,
 * logos) over the list of the box's features (those found from the board, the template, and the
 * user's own); the box in 3D in the middle with the board in it, and under it a face drawn flat
 * to place and size features exactly; the Properties on the right (the box's settings, or the
 * picked feature's). A tool puts its feature where a face is clicked, in 3D or in the face view.
 * The solids are made by enclosureSolid.ts a moment after each change; the exports are an STL or a
 * 3MF ready to print (the 3MF in the parts' colours, text in its own colour a part of its part),
 * a STEP assembly with the board in place, and a picture to show (studio lighting, a shadow).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { activeId, docKeys, docs, notify, projects, tick, type OpenDoc, type Project } from './state';
import { EnclosureFace, pickLogo, labelStrokes } from './EnclosureFace';
import { BoxPanel, ItemPanel } from './EnclosureProps';
import { TOOLS, features, kindOf, makeItem, nameOf, placeOf, type Item, type ItemList, type Pick, type ToolId } from './EnclosureTools';
import { Icon } from './icons';
import { openMenuAt } from './MenuBar';
import type { EnclosureDocument } from '../formats/enclosureDoc';
import { autoOpenings, fromCutouts, layoutOf, rgbOf, ventPatch, type Add, type EnclosureSpec, type Face, type Label, type Layout, type Looks, type Opening, type Paint, type Scene, type Side } from '../model/enclosure';
import { buildEnclosure, printPlate, sectionMesh, type Built, type Inlay, type SolidMesh } from '../model/enclosureSolid';
import { finishMaterial, type Lighting, type Material } from '../render/gl3d/studio';
import { showDialog } from './dialogs';
import { EnclosurePictureDialog } from './dialogs/EnclosurePicture';
import { write3mf } from '../formats/threeMf';
import { boardFacts } from '../model/enclosureBoard';
import type { PcbDocument } from '../model/pcb';
import { readPcbDoc } from '../formats/altium/pcbdoc';
import { buildBoardModel, bodyMesh, type Mesh, type RGBA } from '../render/gl3d/boardModel';
import { ModelView, type ModelHit, type ModelViewKind, type PartMesh } from '../render/gl3d/ModelView';
import { UNITS_PER_MM } from '../core/units';
import { writeStl, stlToStep } from '../formats/stl';
import { exportAssembly, exportStep, leftOutWords } from '../formats/step/write';
import { IDENT } from '../formats/step/tessellate';
import { embeddedModels } from '../render/gl3d/stepBodies';
import { saveFileAs } from '../platform/fs';
import { manifold } from '../platform/manifold';
export { DENSITY } from './EnclosureProps';

const projectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);
const read = new WeakMap<Uint8Array, PcbDocument | null>();
/** Each document's undo and redo: its settings as they were. */
const history = new WeakMap<EnclosureDocument, { undo: string[]; redo: string[] }>();
/** The board the enclosure is for: open, else from its project's files; else the project's (or any) open board. */
export function enclosureBoard(od: OpenDoc): PcbDocument | null {
  const d = od.doc as EnclosureDocument;
  const name = d.spec.board.toLowerCase();
  const p = projectOf(od);
  const open = (n?: string) => docs.value.find((x) => x.doc.kind === 'PcbDoc' && (!p || x.projectId === p.id) && (!n || x.name.toLowerCase() === n))?.doc as PcbDocument | undefined;
  const f = name ? p?.files.get(name) : undefined;
  const fromFile = () => { if (!f) return null; let b = read.get(f.bytes); if (b === undefined) { try { b = readPcbDoc(f.bytes, f.name); } catch { b = null; } read.set(f.bytes, b); } return b; };
  return (name ? open(name) ?? fromFile() : null) ?? open() ?? (docs.value.find((x) => x.doc.kind === 'PcbDoc')?.doc as PcbDocument | undefined) ?? null;
}

/**
 * A solid for the view: each triangle's corners with their own normals — smooth across edges
 * gentler than 40° (round posts and holes), sharp at the others (the box's edges).
 */
export function solidMesh(m: SolidMesh, colour: RGBA, dz = 0): Mesh {
  const { pos: p, idx } = m;
  const nt = idx.length / 3;
  const fn = new Float32Array(nt * 3);
  const around: number[][] = Array.from({ length: p.length / 3 }, () => []);
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!, vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
    for (let k = 0; k < 3; k++) around[idx[t * 3 + k]!]!.push(t);
  }
  const cos = Math.cos((40 * Math.PI) / 180);
  const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]!;
      let x = 0, y = 0, z = 0;
      for (const u of around[v]!) if (fn[u * 3]! * fn[t * 3]! + fn[u * 3 + 1]! * fn[t * 3 + 1]! + fn[u * 3 + 2]! * fn[t * 3 + 2]! >= cos) { x += fn[u * 3]!; y += fn[u * 3 + 1]!; z += fn[u * 3 + 2]!; }
      const l = Math.hypot(x, y, z) || 1, o = t * 9 + k * 3;
      pos[o] = p[v * 3]!; pos[o + 1] = p[v * 3 + 1]!; pos[o + 2] = p[v * 3 + 2]! + dz;
      nrm[o] = x / l; nrm[o + 1] = y / l; nrm[o + 2] = z / l;
    }
  }
  return { pos, nrm, uv: null, idx: Uint32Array.from({ length: nt * 3 }, (_, i) => i), colour };
}
/** A solid's triangles as nine numbers each (for STL and STEP), moved by f. */
export function soup(m: SolidMesh, f: (x: number, y: number, z: number) => [number, number, number] = (x, y, z) => [x, y, z]): Float32Array {
  const out = new Float32Array(m.idx.length * 3);
  for (let i = 0; i < m.idx.length; i++) { const v = m.idx[i]! * 3; const q = f(m.pos[v]!, m.pos[v + 1]!, m.pos[v + 2]!); out[i * 3] = q[0]; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2]; }
  return out;
}

const lifted = (m: Mesh, dz: number): Mesh => { const pos = m.pos.slice(); for (let i = 2; i < pos.length; i += 3) pos[i] = pos[i]! + dz; return { ...m, pos }; };
const BOARD: RGBA = [0.11, 0.42, 0.22, 1], MARK: RGBA = [1, 0.55, 0.1, 0.6];
/** A part's look in the view: its colour (see-through when clear) and how it takes the light. */
function paintOf(p: Paint): { colour: RGBA; material: Material } { const f = finishMaterial(p.finish); const [r, g, b] = rgbOf(p.colour); return { colour: [r, g, b, f.alpha], material: f.material }; }
/** A part's paint by its name (Base, Top, Gasket, a button). */
const lookOf = (looks: Looks, name: string): Paint => (name === 'Base' ? looks.base : name === 'Top' ? looks.top : name === 'Gasket' ? looks.gasket : looks.buttons);
/** Text in its own colour: the finish of its part (opaque on a clear one). */
const inlayPaint = (colour: string, host: Paint): Paint => ({ colour, finish: host.finish === 'clear' ? 'satin' : host.finish });
/** The scene's light for the view and pictures. */
const lightingOf = (sc: Scene): Lighting => ({ env: rgbOf(sc.env), azimuth: sc.azimuth, elevation: sc.elevation, key: sc.key, ambient: sc.ambient });
const part = (m: SolidMesh, p: Paint, key: string, dz = 0): PartMesh => { const q = paintOf(p); return { ...solidMesh(m, q.colour, dz), key, material: q.material }; };
const VIEWS: [ModelViewKind, string][] = [['iso', 'Isometric'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']];
type Look = 'assembled' | 'open' | 'plate';

/**
 * A flat mark over a feature on its face, just off its outside (or its inside, for one inside), to
 * show it picked in 3D: its outline (every shape here is convex) filled from its middle.
 */
function markMesh(g: Layout, s: EnclosureSpec, face: Face, shape: Opening['shape'], x: number, y: number, w: number, h: number, inside: boolean): SolidMesh {
  const pts: [number, number][] = [];
  const W = Math.max(0.4, w), Hh = Math.max(0.4, shape === 'circle' ? w : h);
  if (shape === 'circle') for (let k = 0; k < 40; k++) pts.push([(W / 2) * Math.cos((2 * Math.PI * k) / 40), (W / 2) * Math.sin((2 * Math.PI * k) / 40)]);
  else {
    const r = shape === 'slot' ? Math.min(W, Hh) / 2 : shape === 'rounded' ? Math.min(2, Math.min(W, Hh) / 2) : 0;
    const corner = (cx: number, cy: number, a0: number) => { if (!r) { pts.push([cx, cy]); return; } for (let k = 0; k <= 8; k++) { const a = a0 + (k / 8) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
    const hx = W / 2 - r, hy = Hh / 2 - r;
    corner(hx, -hy, -Math.PI / 2); corner(hx, hy, 0); corner(-hx, hy, Math.PI / 2); corner(-hx, -hy, Math.PI);
  }
  const off = 0.25;
  const at = (u: number, v: number): [number, number, number] => {
    if (face === 'top') return [x + u, y + v, inside ? g.height - s.top - off : g.height + off];
    if (face === 'bottom') return [x + u, y + v, inside ? g.floorTop + off : -off];
    const f = g.sides[face as Side], out = inside ? -off : s.wall + off, a = x + u;
    return [f.m.x + a * f.d.x + out * f.n.x, f.m.y + a * f.d.y + out * f.n.y, g.boardTop + y + v];
  };
  const pos: number[] = [...at(0, 0), ...pts.flatMap(([u, v]) => at(u, v))], idx: number[] = [];
  for (let k = 0; k < pts.length; k++) idx.push(0, 1 + k, 1 + ((k + 1) % pts.length));
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), volume: 0 };
}

export function EnclosureView({ od }: { od: OpenDoc }) {
  void tick.value;
  const d = od.doc as EnclosureDocument;
  const s = d.spec;
  const [rev, setRev] = useState(0);
  const [show, setShow] = useState({ board: true, top: true, faces: true, section: '' as '' | 'x' | 'y' });
  const [look, setLook] = useState<Look>('open');
  const [cut, setCut] = useState<{ base: SolidMesh; top: SolidMesh; extras: SolidMesh[]; inlays: Inlay[] } | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [err, setErr] = useState('');
  const [face, setFace] = useState<Face>('S');
  const [pick, setPick] = useState<Pick>(null);
  const [tool, setTool] = useState<ToolId>('select');
  /** Said for a moment when a click with a tool missed the box. */
  const [miss, setMiss] = useState('');
  const missTimer = useRef(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const fitted = useRef(false);
  let h = history.get(d);
  if (!h) { h = { undo: [], redo: [] }; history.set(d, h); }
  const hist = h;
  /** A change starts: the settings as they are, for undo. */
  const begin = () => { hist.undo.push(JSON.stringify(d.spec)); if (hist.undo.length > 200) hist.undo.shift(); hist.redo = []; };
  const changed = () => { d.dirty = true; setRev((r) => r + 1); tick.value++; };
  /** A change (quiet: part of one already begun, or made by the designer itself). */
  const set = (patch: Partial<EnclosureSpec>, quiet = false) => { if (!quiet) begin(); Object.assign(d.spec, patch); changed(); };
  const restore = (from: string[], to: string[]) => {
    const was = from.pop();
    if (!was) return;
    to.push(JSON.stringify(d.spec));
    for (const key of Object.keys(d.spec)) delete (d.spec as unknown as Record<string, unknown>)[key];
    Object.assign(d.spec, JSON.parse(was));
    setPick(null); changed();
  };
  const board = enclosureBoard(od);
  const facts = useMemo(() => (board ? boardFacts(board) : null), [board, docs.value.find((x) => x.doc === board)?.editor?.undo.revision]);
  // The first version's openings and vent slots, turned over once the board is known; the parts' openings looked for once
  useEffect(() => {
    if (!facts) return;
    const g0 = layoutOf(s, facts);
    if (s.cutouts?.length) set({ openings: [...s.openings, ...fromCutouts(s.cutouts, g0)], cutouts: undefined }, true);
    if (s.vents.some((v) => v.w <= 0 || v.h <= 0)) set({ vents: s.vents.map((v) => (v.w > 0 && v.h > 0 ? v : { ...v, ...ventPatch(s, g0) })) }, true);
    if (!s.detected) set({ openings: [...s.openings.filter((o) => !o.auto), ...autoOpenings(s, facts)], detected: true, board: s.board || docs.value.find((x) => x.doc === board)?.name || '' }, true);
  }, [facts]);
  // The solids, made again a moment after the settings stop changing
  useEffect(() => {
    if (!facts) { setBuilt(null); return; }
    let gone = false;
    const t = setTimeout(() => {
      void manifold().then((M) => { if (gone) return; try { setBuilt(buildEnclosure(M, s, facts)); setErr(''); } catch (e) { setErr((e as Error).message); } }, (e) => setErr(`The solids couldn't be made: ${(e as Error).message}`));
    }, built ? 120 : 0);
    return () => { gone = true; clearTimeout(t); };
  }, [facts, rev]);
  const g = built?.g;
  const lifting = look === 'open' && show.top;
  const lift = g ? Math.max(10, (g.height - g.joint) + g.height * 0.4) : 0;

  /* Features: changed, added, taken away */
  const listOf = (l: ItemList) => s[l] as Item[];
  const setItem = (list: ItemList, i: number, patch: Partial<Item>) => {
    if ('face' in patch && patch.face) setFace(patch.face as Face);
    const moved = list === 'openings' && ['face', 'x', 'y', 'w', 'h', 'shape'].some((f) => f in patch);
    set({ [list]: listOf(list).map((o, k) => (k === i ? { ...o, ...patch, ...(moved ? { auto: false } : {}) } : o)) } as Partial<EnclosureSpec>);
  };
  const remove = (list: ItemList, i: number) => { set({ [list]: listOf(list).filter((_, k) => k !== i) } as Partial<EnclosureSpec>); setPick(null); };
  const append = (list: ItemList, items: Item[]) => {
    if (!items.length) return;
    set({ [list]: [...listOf(list), ...items] } as Partial<EnclosureSpec>);
    setPick({ list, i: listOf(list).length - items.length }); setFace(items[0]!.face);
  };
  /** A tool's feature put where a face was clicked (a logo asks for its drawing first). */
  const place = (f: Face, p: { x: number; y: number }, side?: 'out' | 'in') => {
    if (!g) return;
    setFace(f);
    if (tool === 'logo') {
      const wall = f !== 'top' && f !== 'bottom';
      void pickLogo((l) => append('labels', [{ ...l, face: f, x: p.x, y: p.y, size: Math.min(l.size, wall ? Math.max(3, g.rim - g.boardTop - 2) : 2 * g.oy - 8) } as Label]));
      setTool('select');
      return;
    }
    const m = makeItem(tool, s, g, f, p.x, p.y, side);
    if (m) append(m.list, [m.item]);
  };
  const toolRef = useRef<ToolId>('select');
  toolRef.current = tool;

  // A click on the box: with a tool, its feature put there; else the face shown and what is there picked
  const onPick = useRef<(hit: ModelHit | null) => void>(() => {});
  onPick.current = (hit) => {
    const gg = built?.g;
    if (!hit || !gg || !['base', 'top', 'extra'].includes(hit.key)) {
      if (toolRef.current !== 'select') {
        setMiss(hit?.key === 'plate' ? 'Nothing is placed on the print plate: show the box assembled or with its top lifted' : 'That missed the box: click one of its walls, its floor or its top');
        clearTimeout(missTimer.current); missTimer.current = window.setTimeout(() => setMiss(''), 3000);
      }
      return;
    }
    setMiss('');
    const up = hit.key !== 'base' && lifting ? lift : 0;
    const p = { x: hit.p[0], y: hit.p[1], z: hit.p[2] - up };
    let f: Face, inside = false;
    if (Math.abs(hit.n[2]) > 0.7) {
      // The floor's or the top's inside faces the other way
      f = hit.key === 'base' ? 'bottom' : 'top';
      inside = hit.key === 'base' ? hit.n[2] > 0 : hit.n[2] < 0;
    } else {
      f = Math.abs(p.x) / gg.ox > Math.abs(p.y) / gg.oy ? (p.x > 0 ? 'E' : 'W') : (p.y > 0 ? 'N' : 'S');
      const fr = gg.sides[f as Side];
      inside = hit.n[0] * fr.n.x + hit.n[1] * fr.n.y < 0;
    }
    const fr = f === 'top' || f === 'bottom' ? null : gg.sides[f];
    const q = fr ? { x: Math.round((p.x * fr.d.x + p.y * fr.d.y) * 10) / 10, y: Math.round((p.z - gg.boardTop) * 10) / 10 } : { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
    if (toolRef.current !== 'select') { place(f, q, inside ? 'in' : 'out'); return; }
    setFace(f);
    const within = (o: { face: Face; x: number; y: number; w: number; h: number }) => o.face === f && Math.abs(q.x - o.x) <= o.w / 2 + 0.5 && Math.abs(q.y - o.y) <= o.h / 2 + 0.5;
    const hitOf = (list: ItemList) => listOf(list).findIndex((o) => {
      if (list === 'labels') { const st = labelStrokes(o as Label, s.print.nozzle); return within({ ...o, w: st.w, h: st.h }); }
      const b = o as Opening | Add;
      return within({ ...b, h: b.shape === 'circle' ? b.w : b.h });
    });
    for (const list of ['adds', 'openings', 'vents', 'labels'] as ItemList[]) { const i = hitOf(list); if (i >= 0) { setPick({ list, i }); return; } }
    setPick(null);
  };
  useEffect(() => {
    if (!host.current) return;
    // No origin axes: the box's middle means nothing to its maker
    // The picked feature's mark is drawn over the box, not part of it: clicks go through it
    const v = new ModelView(host.current, { click: (hit) => onPick.current(hit) }, { axes: false, pickable: (key) => key !== 'mark', studio: true });
    view.current = v;
    return () => { v.dispose(); view.current = null; };
  }, []);
  const pickRef = useRef<Pick>(null);
  pickRef.current = pick;
  // Undo and redo; Esc: the tool put down, else the pick dropped; what is picked deleted or nudged (Shift: a tenth of a millimetre)
  useEffect(() => {
    docKeys.set(od.id, (key) => {
      if (activeId.value !== od.id) return false;
      if (key === 'Ctrl+Z') { restore(hist.undo, hist.redo); return true; }
      if (key === 'Ctrl+Y' || key === 'Ctrl+Shift+Z') { restore(hist.redo, hist.undo); return true; }
      if (key === 'Escape') { if (toolRef.current !== 'select') setTool('select'); else setPick(null); return true; }
      const pk = pickRef.current;
      const list = pk ? (d.spec[pk.list] as { x: number; y: number; face: Face }[]) : null;
      if (!pk || !list?.[pk.i]) return false;
      if (key === 'Delete') { set({ [pk.list]: list.filter((_, k) => k !== pk.i) } as Partial<EnclosureSpec>); setPick(null); return true; }
      const m = /^(Shift\+)?Arrow(Left|Right|Up|Down)$/.exec(key);
      if (m) {
        const o = list[pk.i]!, st = m[1] ? 0.1 : 0.5, mir = o.face === 'bottom' ? -1 : 1;
        const dx = (m[2] === 'Left' ? -st : m[2] === 'Right' ? st : 0) * mir, dy = m[2] === 'Up' ? st : m[2] === 'Down' ? -st : 0;
        set({ [pk.list]: list.map((x, k) => (k === pk.i ? { ...x, x: Math.round((x.x + dx) * 100) / 100, y: Math.round((x.y + dy) * 100) / 100, ...(pk.list === 'openings' ? { auto: false } : {}) } : x)) } as Partial<EnclosureSpec>);
        return true;
      }
      return false;
    });
    return () => docKeys.delete(od.id);
  }, [od.id, d]);
  // A section through the middle, to look inside: the front (or the left) half taken away
  useEffect(() => {
    if (!built || !show.section) { setCut(null); return; }
    let gone = false;
    void manifold().then((M) => { if (gone) return; const ax = show.section as 'x' | 'y'; setCut({ base: sectionMesh(M, built.base, ax, 0), top: sectionMesh(M, built.top, ax, 0), extras: built.extras.map((x) => sectionMesh(M, x.mesh, ax, 0)), inlays: built.inlays.map((x) => ({ ...x, mesh: sectionMesh(M, x.mesh, ax, 0) })) }); });
    return () => { gone = true; };
  }, [built, show.section]);
  const wasPlate = useRef(false);
  useEffect(() => {
    const v = view.current;
    if (!v || !built || !board) return;
    v.setLighting(lightingOf(s.scene));
    if (look === 'plate') {
      const plate = printPlate(built);
      const meshes: PartMesh[] = plate.flatMap((p) => [part(p.mesh, lookOf(s.looks, p.name), 'plate'), ...p.inlays.map((x) => part(x.mesh, inlayPaint(x.colour, lookOf(s.looks, p.name)), 'plate'))]);
      let x1 = 0;
      for (const p of plate) for (let i = 0; i < p.mesh.pos.length; i += 3) x1 = Math.max(x1, p.mesh.pos[i]!);
      v.setMeshes(meshes, { min: [-built.g.ox, -built.g.oy, 0], max: [x1, built.g.oy, built.g.height] });
      v.view('iso');
      wasPlate.current = true;
      return;
    }
    if (show.section && !cut) return;
    const parts = show.section && cut ? cut : { base: built.base, top: built.top, extras: built.extras.map((x) => x.mesh), inlays: built.inlays };
    const up = lifting ? lift : 0;
    const L = s.looks;
    const meshes: PartMesh[] = [part(parts.base, L.base, 'base'), ...parts.inlays.filter((x) => x.on === 'base').map((x) => part(x.mesh, inlayPaint(x.colour, L.base), 'base'))];
    // A gasket stays in the base's groove; buttons go with the top
    const gasket = (i: number) => built.extras[i]?.name === 'Gasket';
    parts.extras.forEach((x, i) => { if (gasket(i)) meshes.push(part(x, L.gasket, 'extra')); });
    if (show.top) {
      meshes.push(part(parts.top, L.top, 'top', up), ...parts.inlays.filter((x) => x.on === 'top').map((x) => part(x.mesh, inlayPaint(x.colour, L.top), 'top', up)));
      parts.extras.forEach((x, i) => { if (!gasket(i)) meshes.push(part(x, L.buttons, 'extra', up)); });
    }
    if (show.board) {
      const bm = buildBoardModel(board);
      // The board's faces green (the view has no layer pictures for them)
      for (const m of bm.meshes) meshes.push({ ...lifted(m.texture ? { ...m, colour: BOARD, texture: undefined } : m, built.g.boardBottom), key: 'board' });
      for (const b of bm.bodies) meshes.push({ ...lifted(bodyMesh(b), built.g.boardBottom), key: 'board' });
      for (const m of bm.wires ?? []) meshes.push({ ...lifted(m, built.g.boardBottom), key: 'board' });
    }
    // The picked feature marked on its face (lifted with the top when it is on it)
    const pk = pick ? (s[pick.list] as Item[])[pick.i] : undefined;
    if (pick && pk) {
      const gg = built.g;
      const lb = pick.list === 'labels' ? labelStrokes(pk as Label, s.print.nozzle) : null;
      const shp = pick.list === 'openings' || pick.list === 'adds' ? (pk as Opening).shape : 'rect';
      const w = lb ? lb.w : (pk as Opening).w, hh = lb ? lb.h : (pk as Opening).h;
      const onTop = pk.face === 'top' || (pk.face !== 'bottom' && pk.y > gg.joint - gg.boardTop);
      if (!onTop || show.top) meshes.push({ ...solidMesh(markMesh(gg, s, pk.face, shp, pk.x, pk.y, w, hh, pick.list === 'adds' && (pk as Add).side === 'in'), MARK, onTop ? up : 0), key: 'mark' });
    }
    const top = built.g.height + (show.top ? up + 1.5 : 0);
    v.setMeshes(meshes, { min: [-built.g.ox, -built.g.oy, 0], max: [built.g.ox, built.g.oy, top] });
    if (!fitted.current || wasPlate.current) { fitted.current = true; v.view('iso'); }
    wasPlate.current = false;
  }, [built, show, look, board, cut, pick, rev]);

  const stem = d.name.replace(/\.[^.]+$/, '');
  const save = async (name: string, bytes: Uint8Array, what: string) => {
    try { const r = await saveFileAs(name, bytes); if (r !== null) notify(`${what} saved as ${name}`); } catch (e) { notify(`Couldn't save: ${(e as Error).message}`, 'error'); }
  };
  const exportStl = () => {
    if (!built) return;
    // One colour: what stands out in its own colour printed with its part; a cut filled with one stays a cut
    void save(`${stem}.stl`, writeStl(stem, printPlate(built).flatMap((p) => [p.mesh, ...p.inlays.filter((x) => x.raised).map((x) => x.mesh)])), 'Enclosure (STL)');
  };
  const export3mf = () => {
    if (!built) return;
    void save(`${stem}.3mf`, write3mf(printPlate(built).map((p) => ({
      name: `${stem} ${p.name}`, pos: p.mesh.pos, idx: p.mesh.idx, colour: rgbOf(lookOf(s.looks, p.name).colour),
      parts: p.inlays.map((x) => ({ name: `${stem} ${p.name} ${x.name}`, pos: x.mesh.pos, idx: x.mesh.idx, colour: rgbOf(x.colour) })),
    }))), 'Enclosure (3MF)');
  };
  const exportPicture = () => {
    if (!built || !view.current) return;
    const v = view.current;
    showDialog(EnclosurePictureDialog, {
      picture: (o: Parameters<ModelView['picture']>[0]) => { v.setLighting(lightingOf(d.spec.scene)); return v.picture({ ...o, hide: ['mark'] }); },
      save: (bytes: Uint8Array) => save(`${stem}.png`, bytes, 'Enclosure (picture)'),
      scene: { ...s.scene },
      // The light and the room kept with the enclosure (not undone: they change nothing that prints)
      setScene: (sc: Scene) => { d.spec.scene = sc; d.dirty = true; v.setLighting(lightingOf(sc)); tick.value++; },
    });
  };
  const exportStepFile = async () => {
    if (!built || !board) return;
    const piece = (name: string, t: Float32Array, c: string) => { const colour: RGBA = [...rgbOf(c), 1]; return { name, text: stlToStep({ name, tris: t }, colour), xf: IDENT, colour }; };
    const bm = buildBoardModel(board);
    const o = board.board.origin;
    const leftOut: string[] = [];
    const boardText = await exportStep(board, { models: embeddedModels(board.cfb.root), leftOut });
    const L = s.looks;
    const text = exportAssembly(stem, [piece(`${stem} Base`, soup(built.base), L.base.colour), piece(`${stem} Top`, soup(built.top), L.top.colour), ...built.extras.map((x) => piece(`${stem} ${x.name}`, soup(x.mesh), lookOf(L, x.name).colour)),
      ...built.inlays.map((x) => piece(`${stem} ${x.name} (${x.on === 'top' ? 'top' : 'base'})`, soup(x.mesh), x.colour)),
      { name: board.name.replace(/\.[^.]+$/, ''), text: boardText, xf: { ...IDENT, o: [(o.x - bm.centre.x) / UNITS_PER_MM, (o.y - bm.centre.y) / UNITS_PER_MM, built.g.boardBottom] }, colour: null }]);
    await save(`${stem}.step`, Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff), 'Enclosure (STEP)');
    if (leftOut.length) notify(`${stem}.step: ${leftOutWords(leftOut)}`, 'error');
  };
  const menuAt = (e: MouseEvent, items: { label: string; disabled?: boolean; separatorBefore?: boolean; action: () => void }[]) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: '', children: items.map((c) => ({ key: '', ...c })) }, b.left, b.bottom + 1);
  };
  const exportMenu = (e: MouseEvent) => menuAt(e, [
    { label: 'STL (the parts as they print)...', disabled: !built, action: exportStl },
    { label: '3MF (each part an object)...', disabled: !built, action: export3mf },
    { label: 'STEP (with the board in place)...', disabled: !built, separatorBefore: true, action: () => void exportStepFile() },
    { label: 'Picture (PNG)...', disabled: !built, separatorBefore: true, action: exportPicture },
  ]);
  const viewMenu = (e: MouseEvent) => menuAt(e, VIEWS.map(([v, t]) => ({ label: t, action: () => view.current?.view(v) })));
  const tb = (name: string, label: string, act: () => void, on?: boolean, off?: boolean) => (
    <button type="button" class={`tbtn${on ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={on === undefined ? undefined : on} disabled={off} onClick={act}><Icon name={name} /></button>
  );
  const feats = features(s);
  const boardFeats = feats.filter((f) => f.board), ownFeats = feats.filter((f) => !f.board);
  const isPicked = (list: ItemList, i: number) => pick?.list === list && pick.i === i;
  const row = (f: (typeof feats)[number]) => {
    const k = kindOf(f.list, f.item);
    return (
      <li key={`${f.list}${f.i}`} class={`ex-feat${isPicked(f.list, f.i) ? ' sel' : ''}${f.item.on ? '' : ' off'}`} onClick={() => { setPick({ list: f.list, i: f.i }); setFace(f.item.face); setTool('select'); }}>
        <Icon name={k.icon} />
        <span class="ex-feat-name">{f.list === 'labels' && (f.item as Label).colour && !(f.item as Label).through && <span class="ex-swatch" style={{ background: (f.item as Label).colour }} title="In its own colour" />}{nameOf(f.list, f.item, f.i)}</span>
        <span class="ex-feat-face">{placeOf(f.list, f.item)}</span>
        <button type="button" class="ex-icon-btn" title={f.item.on ? 'Leave it out of the box' : 'Put it back in the box'} aria-label={`${f.item.on ? 'Hide' : 'Show'} ${nameOf(f.list, f.item, f.i)}`} onClick={(e) => { e.stopPropagation(); setItem(f.list, f.i, { on: !f.item.on }); }}><Icon name={f.item.on ? 'encEye' : 'encEyeOff'} /></button>
        <button type="button" class="ex-icon-btn ex-del" title="Delete" aria-label={`Delete ${nameOf(f.list, f.item, f.i)}`} onClick={(e) => { e.stopPropagation(); remove(f.list, f.i); }}><Icon name="encDelete" /></button>
      </li>
    );
  };
  const groups = ['pick', 'cut', 'add', 'mark'] as const;
  const toolLabel = TOOLS.find((x) => x.id === tool)?.label ?? '';
  const nChecks = built ? built.notes.length : 0;

  return (
    <div class="enclosure" aria-label={`Enclosure ${d.name}`}>
      <div class="dd-bar enc-bar ex-toolbar" role="toolbar" aria-label="Enclosure">
        {tb('undo', 'Undo (Ctrl+Z)', () => restore(hist.undo, hist.redo), undefined, !hist.undo.length)}
        {tb('redo', 'Redo (Ctrl+Y)', () => restore(hist.redo, hist.undo), undefined, !hist.redo.length)}
        <span class="ex-tsep" />
        {tb('encAssembled', 'Assembled', () => { setLook('assembled'); setShow({ ...show, top: true }); }, look === 'assembled')}
        {tb('encExploded', 'Top lifted off', () => { setLook('open'); setShow({ ...show, top: true }); }, look === 'open')}
        {tb('encPlate', 'Print plate: the parts as they print', () => setLook('plate'), look === 'plate')}
        <span class="ex-tsep" />
        {tb('encSectionFB', 'Section front to back', () => setShow({ ...show, section: show.section === 'y' ? '' : 'y' }), show.section === 'y', look === 'plate')}
        {tb('encSectionLR', 'Section side to side', () => setShow({ ...show, section: show.section === 'x' ? '' : 'x' }), show.section === 'x', look === 'plate')}
        <span class="ex-tsep" />
        {tb('encShowBoard', 'Show the board', () => setShow({ ...show, board: !show.board }), show.board, look === 'plate')}
        {tb('encShowTop', 'Show the top', () => setShow({ ...show, top: !show.top }), show.top, look === 'plate')}
        <span class="ex-tsep" />
        <button type="button" class="tbtn tbtn-drop" title="View from" aria-label="View from" aria-haspopup="menu" onClick={(e) => viewMenu(e as unknown as MouseEvent)}><Icon name="encViews" /><span class="tbtn-arrow" aria-hidden="true" /></button>
        {tb('encFit', 'Fit the view', () => view.current?.view('iso'))}
        {tb('encFaceView', 'The face view: a face drawn flat to place and size features', () => setShow({ ...show, faces: !show.faces }), show.faces)}
        <span class="spacer" />
        <button type="button" class="ex-export" aria-haspopup="menu" disabled={!built} onClick={(e) => exportMenu(e as unknown as MouseEvent)}><Icon name="encExport" />Export<span class="tbtn-arrow" aria-hidden="true" /></button>
      </div>
      <div class="ex-main">
        <aside class="ex-left" aria-label="Tools and features">
          <div class="ex-tools" role="toolbar" aria-label="Tools">
            {groups.map((gr) => (
              <div key={gr} class="ex-tool-group" data-label={{ pick: '', cut: 'Cut', add: 'Add', mark: 'Mark' }[gr]}>
                {TOOLS.filter((x) => x.group === gr).map((x) => (
                  <button key={x.id} type="button" class={`ex-tool${tool === x.id ? ' on' : ''}`} aria-pressed={tool === x.id} title={x.title} onClick={() => { setTool(x.id); setMiss(''); if (x.id !== 'select') { setPick(null); if (look === 'plate') setLook('open'); } }}>
                    <Icon name={x.icon} size={18} /><span>{x.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div class="ex-feats" aria-label="Features">
            <div class="ex-feats-head"><b>Features</b><span class="muted small">{feats.length}</span>
              <button type="button" class="ex-icon-btn" disabled={!facts} title="Find the openings for the board's edge parts, LEDs, switches and displays again" aria-label="Find openings from the board" onClick={() => facts && set({ openings: [...s.openings.filter((o) => !o.auto), ...autoOpenings(s, facts)] })}><Icon name="encFind" /></button>
            </div>
            <div class="ex-feat-group">From the board</div>
            <ul class="ex-feat-list">
              {g && g.standoffs.length > 0 && <li class="ex-feat fixed" onClick={() => setPick(null)} title="Set in the Properties: Board"><Icon name="encStandoff" /><span class="ex-feat-name">Standoffs</span><span class="ex-feat-face">{g.standoffs.length}</span></li>}
              {g && g.ledges.length > 0 && <li class="ex-feat fixed" onClick={() => setPick(null)} title="Set in the Properties: Board"><Icon name="encStandoff" /><span class="ex-feat-name">Ledges</span><span class="ex-feat-face">{g.ledges.length}</span></li>}
              {g?.screws && <li class="ex-feat fixed" onClick={() => setPick(null)} title="Set in the Properties: Closing"><Icon name="encScrew" /><span class="ex-feat-name">Screws M{g.screws.size}</span><span class="ex-feat-face">{g.screws.at.length}</span></li>}
              {boardFeats.map(row)}
              {!boardFeats.length && <li class="ex-feat-empty">No openings found for its parts</li>}
            </ul>
            <div class="ex-feat-group">Added</div>
            <ul class="ex-feat-list">
              {ownFeats.map(row)}
              {!ownFeats.length && <li class="ex-feat-empty">Pick a tool above and click a face</li>}
            </ul>
          </div>
        </aside>
        <div class={`ex-centre${show.faces ? '' : ' no-faces'}`}>
          <div class={`enc-3d${tool !== 'select' ? ' placing' : ''}`} ref={host}>
            {!board && <p class="panel-empty">An enclosure is made round a board: open the project's PCB.</p>}
            {tool !== 'select' && <div class={`ex-hint${miss ? ' miss' : ''}`} role="status">{miss || `${toolLabel}: click a face of the box${show.faces && look !== 'plate' ? ' here or in the face view' : ''} to place it · Esc when done`}</div>}
            {nChecks > 0 && !pick && <button type="button" class="ex-checks-chip" onClick={() => setPick(null)} title="The checks are in the Properties"><Icon name="encWarn" />{nChecks} {nChecks === 1 ? 'check' : 'checks'}</button>}
          </div>
          {built && facts && show.faces && look !== 'plate' && <EnclosureFace s={s} g={built.g} facts={facts} face={face} setFace={setFace} pick={pick} setPick={setPick} begin={begin} change={(list, items) => set({ [list]: items } as Partial<EnclosureSpec>, true)} tool={tool} place={(f, p) => place(f, p)} />}
        </div>
        <aside class="dd-props ex-right enc-side" aria-label="Properties">
          {pick && (s[pick.list] as Item[])[pick.i]
            ? <ItemPanel key={`${pick.list}${pick.i}`} s={s} pick={pick} facts={facts} g={g ?? null} setItem={setItem} remove={remove} append={append} done={() => setPick(null)} />
            : <BoxPanel s={s} set={(p) => set(p)} facts={facts} built={built} err={err} />}
        </aside>
      </div>
    </div>
  );
}
