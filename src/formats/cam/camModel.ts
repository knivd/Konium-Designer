/**
 * Editing a CAM document's layers (CAMtastic's Edit, Place and Tools menus): an object's place,
 * turn, mirror and scale; apertures found or added by shape and size; placed text as the stroke
 * font's draws; groups (text, polylines, dimensions) whose members pick and move together; and the
 * undo step every edit makes — each layer it touches as it was before and after, the document's
 * own state (its layers' order, the current layer, the origin, the film box, parts and nets) with it.
 *
 * Objects are only ever appended or replaced in place, and taken out by adding them to the
 * layer's erased list, so an object's index — and the selection keys made of it — stay valid
 * through every edit and its undo.
 */
import type { BBox, Vec2 } from '../../core/geom';
import { UNITS_PER_INCH, UNITS_PER_MM, type Aperture, type DrillHit, type DrillLayer, type DrillRoute, type GerberLayer, type GerberObject, type StepRepeat } from '../gerber/gerberRead';
import { strokeText } from '../gerber/stroke';
import type { CamDocument, CamLayer } from './camDoc';

/* ─── Groups ───────────────────────────────────────────────────────────────────────── */

export type DimKind = 'horizontal' | 'vertical' | 'radius' | 'ordinate';

/** What a group of a layer's objects is (they pick, move and erase together; Explode undoes the group). */
export type CamGroup =
  | { kind: 'text'; text: string; at: Vec2; height: number; rot: number; mirror: boolean; ap: number }
  | { kind: 'polyline'; closed?: boolean }
  | { kind: 'dimension'; dim: DimKind; text: string }
  | { kind: 'drilltext'; text: string; at: Vec2; height: number; vertical?: boolean };

/** A composite layer's sub-layer (Edit › Composite Layers): its objects carry its index as sub; drawn in order, each in its polarity. */
export interface CamSub { name: string; dark: boolean }

/** A part (Tools › Parts): its designator, where it sits, its side, and the flashes that are its pads (layer name → object indices). */
export interface CamPart { ref: string; at: Vec2; rot: number; side: 'top' | 'bottom'; pads: Record<string, number[]>; value?: string; footprint?: string }

/** A net of the extracted netlist (Tools › Netlist): its name and its members as layer name → object (or hit) indices. */
export interface CamNet { name: string; members: Record<string, number[]> }

/* ─── Units and apertures ──────────────────────────────────────────────────────────── */

export const mmOf = (c: number): number => c / UNITS_PER_MM;
export const inOf = (c: number): number => c / UNITS_PER_INCH;
const num = (v: number) => String(+v.toFixed(6));

/** The definition text of a standard aperture in the layer's units. */
export function apertureDefText(units: 'in' | 'mm', code: number, shape: 'C' | 'R' | 'O' | 'P', w: number, h = w, vertices = 0, rotation = 0, hole = 0): string {
  const u = (c: number) => num(units === 'mm' ? mmOf(c) : inOf(c));
  const args = shape === 'C' ? [u(w), ...(hole ? [u(hole)] : [])]
    : shape === 'P' ? [u(w), String(vertices || 4), num(rotation), ...(hole ? [u(hole)] : [])]
      : [u(w), u(h), ...(hole ? [u(hole)] : [])];
  return `ADD${code}${shape},${args.join('X')}`;
}

/** The next free D-code (10 and up). */
export function nextDCode(g: GerberLayer): number { let c = 10; for (const k of g.apertures.keys()) c = Math.max(c, k + 1); return c; }

/** An aperture of this shape and size on the layer: one it has (to within a hundredth of a mil), else a new D-code. */
export function findOrAddAperture(g: GerberLayer, shape: 'C' | 'R' | 'O' | 'P', w: number, h = w, vertices = 0, rotation = 0): number {
  const tol = 100;
  for (const a of g.apertures.values()) {
    if (a.shape !== shape || a.hole) continue;
    if (Math.abs(a.w - w) <= tol && Math.abs(a.h - h) <= tol && (shape !== 'P' || (a.vertices === vertices && (a.rotation ?? 0) === rotation))) return a.code;
  }
  const code = nextDCode(g);
  g.apertures.set(code, { code, shape, w, h, ...(shape === 'P' ? { vertices, rotation } : {}), def: apertureDefText(g.units, code, shape, w, h, vertices, rotation) });
  return code;
}

/** An aperture grown (or shrunk) by `by` all round, as a new D-code (or one of that size); a macro is scaled about its centre. */
export function grownAperture(g: GerberLayer, code: number, by: number): number {
  const a = g.apertures.get(code);
  if (!a) return code;
  if (a.shape === 'M') {
    const k = a.w > 0 ? Math.max(0.01, (a.w + 2 * by) / a.w) : 1;
    return scaledAperture(g, code, k);
  }
  const w = Math.max(1, a.w + 2 * by), h = Math.max(1, a.h + 2 * by);
  return findOrAddAperture(g, a.shape, w, a.shape === 'C' ? w : h, a.vertices ?? 0, a.rotation ?? 0);
}

/** An aperture scaled by k (a macro: its shapes scaled, kept as an outline macro of its own). */
export function scaledAperture(g: GerberLayer, code: number, k: number, ky = k): number {
  const a = g.apertures.get(code);
  if (!a || (k === 1 && ky === 1)) return code;
  if (a.shape !== 'M' && (k === ky || a.shape !== 'C')) return findOrAddAperture(g, a.shape, a.w * k, a.shape === 'C' ? a.w * k : a.h * ky, a.vertices ?? 0, a.rotation ?? 0);
  return customAperture(g, (a.shapes ?? shapesOf(a)).map((s) => ({ dark: s.dark, poly: s.poly.map((p) => ({ x: p.x * k, y: p.y * ky })) })));
}

/** A standard aperture's outline about its centre (for macros made of it, and for drawing). */
export function shapesOf(a: Aperture): { dark: boolean; poly: Vec2[] }[] {
  const circle = (r: number, n = 40) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }));
  if (a.shape === 'M') return a.shapes ?? [];
  const out: { dark: boolean; poly: Vec2[] }[] = [];
  if (a.shape === 'C') out.push({ dark: true, poly: circle(a.w / 2) });
  else if (a.shape === 'R') out.push({ dark: true, poly: [{ x: -a.w / 2, y: -a.h / 2 }, { x: a.w / 2, y: -a.h / 2 }, { x: a.w / 2, y: a.h / 2 }, { x: -a.w / 2, y: a.h / 2 }] });
  else if (a.shape === 'O') {
    const r = Math.min(a.w, a.h) / 2, dx = a.w / 2 - r, dy = a.h / 2 - r, pts: Vec2[] = [];
    for (let i = 0; i < 40; i++) { const t = (2 * Math.PI * i) / 40, cx = Math.cos(t) >= 0 ? dx : -dx, cy = Math.sin(t) >= 0 ? dy : -dy; pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }); }
    out.push({ dark: true, poly: pts });
  } else if (a.shape === 'P') {
    const n = Math.max(3, a.vertices ?? 3), a0 = ((a.rotation ?? 0) * Math.PI) / 180;
    out.push({ dark: true, poly: Array.from({ length: n }, (_, i) => ({ x: (a.w / 2) * Math.cos(a0 + (2 * Math.PI * i) / n), y: (a.w / 2) * Math.sin(a0 + (2 * Math.PI * i) / n) })) });
  }
  if (a.hole) out.push({ dark: false, poly: circle(a.hole / 2, 24) });
  return out;
}

/**
 * A custom aperture (CAMtastic's): an aperture macro of outline primitives (code 4), one per shape,
 * exposure on or off, in the layer's units; the macro and its D-code added to the layer.
 */
export function customAperture(g: GerberLayer, shapes: { dark: boolean; poly: Vec2[] }[]): number {
  const u = (c: number) => num(g.units === 'mm' ? mmOf(c) : inOf(c));
  const body = shapes.filter((s) => s.poly.length >= 3).map((s) => {
    const pts = [...s.poly, s.poly[0]!];
    return `4,${s.dark ? 1 : 0},${pts.length - 1},${pts.map((p) => `${u(p.x)},${u(p.y)}`).join(',')},0`;
  });
  // The same shape again: its aperture
  const same = [...g.apertures.values()].find((a) => a.shape === 'M' && a.macro && g.macros.get(a.macro)?.join('*') === body.join('*'));
  if (same) return same.code;
  let n = 1;
  while (g.macros.has(`CUSTOM${n}`)) n++;
  const name = `CUSTOM${n}`;
  g.macros.set(name, body);
  const code = nextDCode(g);
  const xs = shapes.flatMap((s) => s.poly.map((p) => Math.abs(p.x))), ys = shapes.flatMap((s) => s.poly.map((p) => Math.abs(p.y)));
  g.apertures.set(code, { code, shape: 'M', w: 2 * Math.max(0, ...xs), h: 2 * Math.max(0, ...ys), macro: name, params: [], shapes: shapes.map((s) => ({ dark: s.dark, poly: s.poly.map((p) => ({ ...p })) })), def: `ADD${code}${name}` });
  return code;
}

/** The smallest tool number not in use. */
export function nextTool(d: DrillLayer): number { let t = 1; while (d.tools.has(t)) t++; return t; }
/** A drill tool of this diameter (one the layer has, to within a hundredth of a mil, else a new one). */
export function findOrAddTool(d: DrillLayer, dia: number): number {
  for (const [t, v] of d.tools) if (Math.abs(v - dia) <= 100) return t;
  const t = nextTool(d);
  d.tools.set(t, dia);
  return t;
}

/* ─── Transforms ───────────────────────────────────────────────────────────────────── */

/**
 * A placement change: scaled (sx, sy) and mirrored about `about`, turned `rot` degrees counter-clockwise
 * about it, then moved by (dx, dy). Mirror X flips left and right (about the vertical line through `about`).
 */
export interface Xf { about: Vec2; dx: number; dy: number; rot: number; mirrorX: boolean; mirrorY: boolean; sx: number; sy: number }
export const moveXf = (dx: number, dy: number): Xf => ({ about: { x: 0, y: 0 }, dx, dy, rot: 0, mirrorX: false, mirrorY: false, sx: 1, sy: 1 });
export const xf = (p: Partial<Xf>): Xf => ({ ...moveXf(0, 0), ...p });

export function xfPoint(p: Vec2, t: Xf): Vec2 {
  let x = (p.x - t.about.x) * t.sx, y = (p.y - t.about.y) * t.sy;
  if (t.mirrorX) x = -x;
  if (t.mirrorY) y = -y;
  if (t.rot) { const a = (t.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); [x, y] = [x * c - y * s, x * s + y * c]; }
  return { x: x + t.about.x + t.dx, y: y + t.about.y + t.dy };
}
const flips = (t: Xf) => (t.mirrorX ? 1 : 0) + (t.mirrorY ? 1 : 0) + (t.sx < 0 ? 1 : 0) + (t.sy < 0 ? 1 : 0);
const scaled = (t: Xf) => Math.abs(Math.abs(t.sx) - 1) > 1e-9 || Math.abs(Math.abs(t.sy) - 1) > 1e-9;

/** An object placed again (a scale changes its aperture too, on `g`). */
export function xfObject(o: GerberObject, t: Xf, g?: GerberLayer): GerberObject {
  const P = (p: Vec2) => xfPoint(p, t);
  const odd = flips(t) % 2 === 1;
  const ap = (code: number) => (g && scaled(t) ? scaledAperture(g, code, Math.abs(t.sx), Math.abs(t.sy)) : code);
  switch (o.kind) {
    case 'draw': return { ...o, a: P(o.a), b: P(o.b), ap: ap(o.ap) };
    case 'arc': return { ...o, a: P(o.a), b: P(o.b), c: P(o.c), cw: odd ? !o.cw : o.cw, ap: ap(o.ap) };
    case 'flash': {
      // The flash's own transform: mirrored once more with the placement, turned with it
      const m = (o.mirror ?? '') as string;
      let mx = m.includes('X'), my = m.includes('Y');
      let rot = o.rot ?? 0;
      if (t.mirrorX !== (t.sx < 0)) { mx = !mx; rot = -rot; }
      if (t.mirrorY !== (t.sy < 0)) { my = !my; rot = -rot; }
      rot = (((rot + t.rot) % 360) + 360) % 360;
      const mirror = mx && my ? 'XY' : mx ? 'X' : my ? 'Y' : undefined;
      const { mirror: _m, rot: _r, ...rest } = o;
      return { ...rest, at: P(o.at), ap: ap(o.ap), ...(rot ? { rot: +rot.toFixed(6) } : {}), ...(mirror ? { mirror } : {}) };
    }
    case 'region': return { ...o, contours: o.contours.map((c) => (odd ? c.map(P).reverse() : c.map(P))) };
  }
}

export function xfHit(h: DrillHit, t: Xf): DrillHit { return { ...h, at: xfPoint(h.at, t), ...(h.slot ? { slot: xfPoint(h.slot, t) } : {}), ...(h.circle ? { circle: h.circle * Math.abs(t.sx) } : {}) }; }
export function xfRoute(r: DrillRoute, t: Xf): DrillRoute {
  const odd = flips(t) % 2 === 1;
  return {
    ...r, path: r.path.map((p) => xfPoint(p, t)),
    ...(r.arcs ? { arcs: r.arcs.map((a) => ({ ...a, c: xfPoint(a.c, t), cw: odd ? !a.cw : a.cw })) } : {}),
    ...(r.circle ? { circle: { c: xfPoint(r.circle.c, t), r: r.circle.r * Math.abs(t.sx), cw: odd ? !r.circle.cw : r.circle.cw } } : {}),
  };
}

/* ─── Objects ──────────────────────────────────────────────────────────────────────── */

/** The points an object is drawn through (ends, centre, flash point, region corners). */
export function objectPoints(o: GerberObject): Vec2[] {
  return o.kind === 'draw' ? [o.a, o.b] : o.kind === 'arc' ? [o.a, o.b] : o.kind === 'flash' ? [o.at] : o.contours.flat();
}

/** The order a layer's objects are drawn and written in: a composite's sub-layers one after another, else as they are. */
export function objectOrder(l: CamLayer): number[] {
  if (l.data.kind !== 'gerber') return [];
  const n = l.data.objects.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (!l.composite?.length) return idx;
  const objs = l.data.objects;
  return idx.sort((a, b) => (objs[a]!.sub ?? 0) - (objs[b]!.sub ?? 0) || a - b);
}

/** Indices of a layer's objects (or hits) that aren't erased. */
export function liveIndices(l: CamLayer): number[] {
  const erased = new Set(l.erased ?? []);
  const n = l.data.kind === 'gerber' ? l.data.objects.length : l.data.hits.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!erased.has(i)) out.push(i);
  return out;
}

/** A layer's objects that aren't erased, with their indices. */
export function liveObjects(l: CamLayer): { o: GerberObject; i: number }[] {
  if (l.data.kind !== 'gerber') return [];
  const erased = new Set(l.erased ?? []);
  const g = l.data;
  const out: { o: GerberObject; i: number }[] = [];
  g.objects.forEach((o, i) => { if (!erased.has(i)) out.push({ o, i }); });
  return out;
}

/** Text as the stroke font's draws with an aperture (Place › Text), grouped. */
export function textDraws(text: string, at: Vec2, height: number, rot: number, mirror: boolean, ap: number, dark: boolean, grp: number): GerberObject[] {
  const out: GerberObject[] = [];
  for (const s of strokeText(text, at, height, rot, mirror)) {
    if (s.length === 1) { out.push({ kind: 'draw', a: s[0]!, b: s[0]!, ap, dark, grp }); continue; }
    for (let k = 0; k + 1 < s.length; k++) out.push({ kind: 'draw', a: s[k]!, b: s[k + 1]!, ap, dark, grp });
  }
  return out;
}

/** Drilled text's hits (M97 / M98): along the strokes, a tool's diameter apart [est: the spacing]. */
export function drillTextHits(text: string, at: Vec2, height: number, vertical: boolean, tool: number, dia: number, grp: number): DrillHit[] {
  const step = Math.max(dia, height / 8);
  const out: DrillHit[] = [];
  const seen = new Set<string>();
  for (const s of strokeText(text, at, height, vertical ? 90 : 0)) {
    for (let k = 0; k < s.length; k++) {
      const a = s[k]!, b = s[k + 1];
      const pts = [a];
      if (b) { const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step)); for (let j = 1; j <= n; j++) pts.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n }); }
      for (const p of pts) { const key = `${Math.round(p.x / (step / 2))},${Math.round(p.y / (step / 2))}`; if (seen.has(key)) continue; seen.add(key); out.push({ tool, at: p, grp }); }
    }
  }
  return out;
}

/** The next group id on a layer. */
export function nextGroup(l: CamLayer): number { let n = 1; for (const k of l.groups?.keys() ?? []) n = Math.max(n, k + 1); return n; }

/** Members of a group (indices of objects / hits not erased). */
export function groupMembers(l: CamLayer, grp: number): number[] {
  const erased = new Set(l.erased ?? []);
  const list: { grp?: number }[] = l.data.kind === 'gerber' ? l.data.objects : l.data.hits;
  const out: number[] = [];
  list.forEach((o, i) => { if (o.grp === grp && !erased.has(i)) out.push(i); });
  return out;
}

/* ─── Extents ──────────────────────────────────────────────────────────────────────── */

export function hitBox(d: DrillLayer, h: DrillHit): BBox {
  const r = Math.max((d.tools.get(h.tool) ?? 0) / 2, (h.circle ?? 0) / 2);
  const pts = h.slot ? [h.at, h.slot] : [h.at];
  return { minX: Math.min(...pts.map((p) => p.x)) - r, minY: Math.min(...pts.map((p) => p.y)) - r, maxX: Math.max(...pts.map((p) => p.x)) + r, maxY: Math.max(...pts.map((p) => p.y)) + r };
}

/* ─── Undo: a layer's and the document's state ─────────────────────────────────────── */

interface LayerState {
  name: string; type: CamLayer['type']; colour: string; visible: boolean; erased?: number[]; edited?: boolean;
  groups?: Map<number, CamGroup>; composite?: CamSub[];
  g?: { objects: GerberObject[]; apertures: Map<number, Aperture>; macros: Map<string, string[]>; negative: boolean; steps?: StepRepeat[]; attributes: Record<string, string>; units: 'in' | 'mm' };
  d?: { hits: DrillHit[]; routes: DrillRoute[]; tools: Map<number, number>; plated?: boolean; texts?: DrillLayer['texts']; units: 'in' | 'mm' };
}

export function layerState(l: CamLayer): LayerState {
  const s: LayerState = { name: l.name, type: l.type, colour: l.colour, visible: l.visible, erased: l.erased ? [...l.erased] : undefined, edited: l.edited,
    groups: l.groups ? new Map(l.groups) : undefined, composite: l.composite ? l.composite.map((c) => ({ ...c })) : undefined };
  if (l.data.kind === 'gerber') {
    const g = l.data;
    s.g = { objects: [...g.objects], apertures: new Map(g.apertures), macros: new Map(g.macros), negative: g.negative, steps: g.steps ? g.steps.map((x) => ({ ...x })) : undefined, attributes: { ...g.attributes }, units: g.units };
  } else {
    const d = l.data;
    s.d = { hits: [...d.hits], routes: [...d.routes], tools: new Map(d.tools), plated: d.plated, texts: d.texts ? d.texts.map((t) => ({ ...t })) : undefined, units: d.units };
  }
  return s;
}

export function restoreLayer(l: CamLayer, s: LayerState): void {
  Object.assign(l, { name: s.name, type: s.type, colour: s.colour, visible: s.visible });
  if (s.erased?.length) l.erased = [...s.erased]; else delete l.erased;
  if (s.edited) l.edited = true; else delete l.edited;
  if (s.groups?.size) l.groups = new Map(s.groups); else delete l.groups;
  if (s.composite?.length) l.composite = s.composite.map((c) => ({ ...c })); else delete l.composite;
  if (s.g && l.data.kind === 'gerber') {
    const g = l.data;
    g.objects = [...s.g.objects]; g.apertures = new Map(s.g.apertures); g.macros = new Map(s.g.macros); g.negative = s.g.negative; g.attributes = { ...s.g.attributes }; g.units = s.g.units;
    if (s.g.steps?.length) g.steps = s.g.steps.map((x) => ({ ...x })); else delete g.steps;
  } else if (s.d && l.data.kind === 'drill') {
    const d = l.data;
    d.hits = [...s.d.hits]; d.routes = [...s.d.routes]; d.tools = new Map(s.d.tools); d.units = s.d.units;
    if (s.d.plated === undefined) delete d.plated; else d.plated = s.d.plated;
    if (s.d.texts?.length) d.texts = s.d.texts.map((t) => ({ ...t })); else delete d.texts;
  }
}

interface DocState {
  layers: CamLayer[]; current: number; origin?: Vec2; filmBox?: BBox; parts?: CamPart[]; nets?: CamNet[];
  layerSets?: { name: string; layers: string[] }[]; open?: CamDocument['openComposite'];
}
export function docState(d: CamDocument): DocState {
  return { layers: [...d.layers], current: d.current, origin: d.origin && { ...d.origin }, filmBox: d.filmBox && { ...d.filmBox },
    parts: d.parts?.map((p) => ({ ...p, pads: { ...p.pads } })), nets: d.nets?.map((n) => ({ ...n, members: { ...n.members } })),
    layerSets: d.layerSets?.map((s) => ({ ...s, layers: [...s.layers] })), open: d.openComposite && { ...d.openComposite } };
}
export function restoreDoc(d: CamDocument, s: DocState): void {
  d.layers = [...s.layers]; d.current = s.current;
  const opt = <K extends 'origin' | 'filmBox' | 'parts' | 'nets' | 'layerSets' | 'openComposite'>(k: K, v: CamDocument[K] | undefined) => { if (v === undefined) delete d[k]; else d[k] = v; };
  opt('origin', s.origin && { ...s.origin }); opt('filmBox', s.filmBox && { ...s.filmBox });
  opt('parts', s.parts?.map((p) => ({ ...p, pads: { ...p.pads } }))); opt('nets', s.nets?.map((n) => ({ ...n, members: { ...n.members } })));
  opt('layerSets', s.layerSets?.map((x) => ({ ...x, layers: [...x.layers] }))); opt('openComposite', s.open && { ...s.open });
}

/** What an edit captures to undo: the layers it touches (all of them with 'all') and the document's own state. */
export function captureEdit(d: CamDocument, layers: CamLayer[] | 'all'): () => { apply(): void; revert(): void } {
  const touched = layers === 'all' ? [...d.layers] : [...new Set(layers)];
  const before = touched.map((l) => [l, layerState(l)] as const), docBefore = docState(d);
  return () => {
    // Layers the edit added are part of the document's state; their contents are captured now
    const all = [...new Set([...touched, ...d.layers.filter((l) => !touched.includes(l))])];
    const changed = all.filter((l) => touched.includes(l));
    const after = changed.map((l) => [l, layerState(l)] as const), docAfter = docState(d);
    for (const [l, s] of after) {
      const b = before.find(([x]) => x === l)?.[1];
      if (b && (b.g?.objects.length !== s.g?.objects.length || b.d?.hits.length !== s.d?.hits.length || b.g?.objects.some((o, i) => o !== s.g!.objects[i])
        || b.d?.hits.some((h, i) => h !== s.d!.hits[i]) || b.d?.routes.length !== s.d?.routes.length || b.d?.routes.some((r, i) => r !== s.d!.routes[i])
        || b.g?.apertures.size !== s.g?.apertures.size || b.d?.tools.size !== s.d?.tools.size)) { l.edited = true; s.edited = true; }
    }
    return {
      apply: () => { restoreDoc(d, docAfter); for (const [l, s] of after) restoreLayer(l, s); },
      revert: () => { restoreDoc(d, docBefore); for (const [l, s] of before) restoreLayer(l, s); },
    };
  };
}
