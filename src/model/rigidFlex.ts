/**
 * Rigid-flex, as AD17's Board Planning Mode has it: split lines cut the board into regions; each
 * region is on a layer stack (a substack of the board's: a flex one leaves out the rigid layers),
 * names it and may be 3D Locked (the one that stays put when the board folds); a flex region's
 * bending lines fold it in 3D (View › Fold/Unfold), in Fold Index order.
 *
 * Kept as AD17 keeps them: BoardRegions/Data, one Regions6-layout record a region (tag 11, its
 * outline flattened as f64 pairs; NAME, LAYERSTACKID (a substack's ID), LOCKED3D,
 * BENDINGLINECOUNT …), the substacks in Board6 (V9_SUBSTACKn_… and LAYERSUBSTACK_V8_n…).
 * Not known, so marked [est]: a layer's place in a substack (its {ID}CONTEXT: 0 in, 1 out); AD17's
 * own keys for split and bending lines — split lines are read back as the edges two regions share
 * (Board6 SPLITLINECOUNT is left as it was), and Konium's bending lines go in the region's record
 * as BENDINGLINEn_… with AD17's BENDINGLINECOUNT left alone, so AD17 doesn't take them for broken
 * lines of its own.
 *
 * Geometry is in board units; the regions are always worked out from the board shape and the
 * split lines (so a board shape edit can't leave them behind).
 */
import type { Vec2 } from '../core/geom';
import { pointInPoly, triangulate } from '../core/geom';
import type { Change } from '../core/undo';
import { PropertyBag } from '../formats/altium/props';
import { formatAltiumLength, parseLength, mil, mm } from '../core/units';
import type { PcbDocument } from './pcb';
import type { StackLayer } from './pcbStack';
import { clipOutlines, outlineArea, sharedArea } from './outlineOps';

export interface BendingLine {
  a: Vec2; b: Vec2;
  /** Degrees; a positive angle folds the far side up (towards the top) [est]. */
  angle: number;
  /** To the bend's inside face (board units). */
  radius: number;
  /** Lower folds first. */
  foldIndex: number;
}
/** A coverlay polygon or cutout drawn for a region (Custom Coverlays): on one coverlay layer (its 32-bit id). */
export interface CoverlayShape { layer: number; outline: Vec2[]; cutout: boolean }
export interface RegionInfo {
  name: string;
  /** The substack's ID ('' on a board without substacks). */
  stackId: string;
  locked3d: boolean;
  bends: BendingLine[];
  /** Advanced Rigid-Flex: drawn over regions of lower priority where they overlap. */
  priority?: number;
  /** Custom Coverlays: the coverlay is the shapes drawn for it (else it covers the region, Coverlay Expansion past its edges). */
  customCoverlay?: boolean;
  coverlays?: CoverlayShape[];
  /** The region's record as read (its other properties and bytes kept). */
  props?: PropertyBag;
  head?: Uint8Array;
}
export interface SplitLine { a: Vec2; b: Vec2 }
export interface RigidFlex {
  /** In the order regionShapes gives the shapes. */
  regions: RegionInfo[];
  splits: SplitLine[];
  /** The file's region outlines, used while Konium can't work them out from its split lines (left once a split line changes); in Advanced mode the regions themselves. */
  fixed?: Vec2[][];
  /** Advanced Rigid-Flex (rigid-flex 2.0): regions placed on their own, sliced, overlapping; no split lines. */
  advanced?: boolean;
}
export interface BoardRegion extends RegionInfo { outline: Vec2[]; index: number }
export interface SubStack { id: string; name: string; isFlex: boolean; showTop: boolean; showBottom: boolean; service: boolean; usedByPrims: boolean; type: number }

/** A new board's region [est: AD17's name for it]. */
export const FIRST_REGION = 'Layer Stack Region 1';
export const BOARD_STACK = 'Board Layer Stack';
/** A new bending line [est: AD17's defaults]. */
export const BEND_DEFAULTS = { angle: 90, radius: mm(1), foldIndex: 1 };
const TOL = mil(0.5);

/* ── polygon helpers ── */

export const polyArea = (p: Vec2[]): number => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]!.x * p[i]!.y - p[i]!.x * p[j]!.y; return a / 2; };
const near = (a: Vec2, b: Vec2, tol = 2) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || !near(out.at(-1)!, p)) out.push(p);
  while (out.length > 1 && near(out[0]!, out.at(-1)!)) out.pop();
  return out;
}

export interface OnLoop { pt: Vec2; edge: number; t: number; d: number }
/** The nearest point of a closed outline: on edge `edge` (from vertex `edge` to the next) at `t`. */
export function nearestOnLoop(loop: Vec2[], p: Vec2): OnLoop {
  let best: OnLoop = { pt: loop[0] ?? p, edge: 0, t: 0, d: Infinity };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.d) best = { pt: q, edge: i, t, d };
  }
  return best;
}

/** The outline from one point on it to another, going forwards. */
function walk(loop: Vec2[], from: OnLoop, to: OnLoop): Vec2[] {
  const n = loop.length, out = [from.pt];
  if (to.edge === from.edge && to.t >= from.t) { out.push(to.pt); return out; }
  for (let i = (from.edge + 1) % n, k = 0; k <= n; i = (i + 1) % n, k++) { out.push(loop[i]!); if (i === to.edge) break; }
  out.push(to.pt);
  return out;
}

/** Whether segments ab and cd cross between their ends (in millimetres, so the products stay exact enough). */
function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const s = 1e-4;
  const o = (p: Vec2, q: Vec2, r: Vec2) => ((q.x - p.x) * s) * ((r.y - p.y) * s) - ((q.y - p.y) * s) * ((r.x - p.x) * s);
  const e = 1e-9;
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

/** A point inside a polygon: its centroid, or the middle of its largest triangle. */
export function interiorPoint(poly: Vec2[]): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j]!, q = poly[i]!, f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f; a += f;
  }
  const c = a ? { x: cx / (3 * a), y: cy / (3 * a) } : poly[0] ?? { x: 0, y: 0 };
  if (pointInPoly(c, poly)) return c;
  const t = triangulate(poly);
  let best = c, size = -1;
  for (let i = 0; i < t.length; i += 3) {
    const p = poly[t[i]!]!, q = poly[t[i + 1]!]!, r = poly[t[i + 2]!]!;
    const s = Math.abs((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    if (s > size) { size = s; best = { x: (p.x + q.x + r.x) / 3, y: (p.y + q.y + r.y) / 3 }; }
  }
  return best;
}

/** A polygon cut in two along the chord between two points on its outline; null when that chord doesn't cut it. */
export function cutPolygon(poly: Vec2[], a: Vec2, b: Vec2, tol = TOL): [Vec2[], Vec2[]] | null {
  const ra = nearestOnLoop(poly, a), rb = nearestOnLoop(poly, b);
  if (ra.d > tol || rb.d > tol || near(ra.pt, rb.pt, tol)) return null;
  if (!pointInPoly(mid(ra.pt, rb.pt), poly)) return null;
  for (let i = 0; i < poly.length; i++) if (crosses(ra.pt, rb.pt, poly[i]!, poly[(i + 1) % poly.length]!)) return null;
  const p1 = dedupe(walk(poly, ra, rb)), p2 = dedupe(walk(poly, rb, ra));
  const min = mil(1) ** 2;
  if (p1.length < 3 || p2.length < 3 || Math.abs(polyArea(p1)) < min || Math.abs(polyArea(p2)) < min) return null;
  return [p1, p2];
}

/** The board's regions: its shape cut by each split line in turn (`applied`: whether each one cut). */
export function regionShapes(outline: Vec2[], splits: SplitLine[]): { shapes: Vec2[][]; applied: boolean[] } {
  const shapes: Vec2[][] = outline.length >= 3 ? [outline] : [];
  const applied = splits.map((s) => {
    const m = mid(s.a, s.b);
    const k = shapes.findIndex((p) => pointInPoly(m, p));
    if (k < 0) return false;
    const r = cutPolygon(shapes[k]!, s.a, s.b);
    if (!r) return false;
    shapes.splice(k, 1, r[0], r[1]);
    return true;
  });
  return { shapes, applied };
}

/**
 * Where a line from `start` (on an outline) towards `toward` first meets an outline again: a
 * split or bending line runs from edge to edge, whatever its second click (AD: extended or trimmed).
 */
export function chordAcross(loops: Vec2[][], start: Vec2, toward: Vec2): Vec2 | null {
  const dx = toward.x - start.x, dy = toward.y - start.y, L = Math.hypot(dx, dy);
  if (L < mil(1)) return null;
  const ux = dx / L, uy = dy / L;
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const c = loop[i]!, d = loop[(i + 1) % loop.length]!;
      const ex = d.x - c.x, ey = d.y - c.y, wx = c.x - start.x, wy = c.y - start.y;
      const det = -ux * ey + ex * uy;
      if (Math.abs(det) < 1e-9) continue;
      const t = (-wx * ey + ex * wy) / det, s = (ux * wy - uy * wx) / det;
      if (t > TOL * 2 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t;
    }
  }
  return Number.isFinite(best) ? { x: Math.round(start.x + ux * best), y: Math.round(start.y + uy * best) } : null;
}

/** The nearest point on any of these outlines (a split or bending line's first end). */
export function snapToLoops(loops: Vec2[][], p: Vec2): OnLoop & { loop: number } {
  let best: OnLoop & { loop: number } = { pt: p, edge: 0, t: 0, d: Infinity, loop: -1 };
  loops.forEach((l, k) => { const r = nearestOnLoop(l, p); if (r.d < best.d) best = { ...r, loop: k }; });
  return { ...best, pt: { x: Math.round(best.pt.x), y: Math.round(best.pt.y) } };
}

/**
 * Split lines from regions as a file has them: the edges two regions share (not the board's),
 * collinear pieces joined, in an order they can be applied in (a line that ends on another after it).
 */
export function splitsFromRegions(outline: Vec2[], regions: Vec2[][]): SplitLine[] {
  const onLoop = (l: Vec2[], p: Vec2) => nearestOnLoop(l, p).d <= TOL;
  const segs: SplitLine[] = [];
  regions.forEach((r, i) => {
    for (let k = 0; k < r.length; k++) {
      const a = r[k]!, b = r[(k + 1) % r.length]!, m = mid(a, b);
      if (near(a, b, TOL)) continue;
      if (onLoop(outline, a) && onLoop(outline, b) && onLoop(outline, m)) continue;
      if (regions.some((o, j) => j > i && onLoop(o, a) && onLoop(o, b) && onLoop(o, m))) segs.push({ a, b });
    }
  });
  // Pieces of one line (cut by T-junctions or vertices) joined
  const coll = (s: SplitLine, t: SplitLine) => {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l = Math.hypot(dx, dy) || 1;
    const off = (p: Vec2) => Math.abs((p.x - s.a.x) * dy - (p.y - s.a.y) * dx) / l;
    return off(t.a) <= TOL && off(t.b) <= TOL;
  };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const s = segs[i]!, t = segs[j]!;
        const touch = [s.a, s.b].some((p) => [t.a, t.b].some((q) => near(p, q, TOL)));
        if (!touch || !coll(s, t)) continue;
        const pts = [s.a, s.b, t.a, t.b];
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
        const along = (p: Vec2) => (p.x - s.a.x) * dx + (p.y - s.a.y) * dy;
        pts.sort((p, q) => along(p) - along(q));
        segs[i] = { a: pts[0]!, b: pts[3]! };
        segs.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  // Applied in turn: each line's ends on the board or on a line before it
  const out: SplitLine[] = [], left = [...segs];
  const onLine = (p: Vec2) => onLoop(outline, p) || out.some((s) => nearestOnLoop([s.a, s.b], p).d <= TOL);
  while (left.length) {
    const k = left.findIndex((s) => onLine(s.a) && onLine(s.b));
    out.push(...left.splice(k < 0 ? 0 : k, 1));
  }
  return out;
}

/* ── the file ── */

/** AD17's region record's fixed part (layer Keep-Out, no net, polygon or component), as every board it writes has it. */
const REGION_HEAD = new Uint8Array([0x38, 0x0c, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0]);

const coordOf = (v: string | undefined) => parseLength(v) ?? (v !== undefined && /^-?[\d.]+$/.test(v.trim()) ? Math.round(Number(v) * 10000) : undefined);

function bendsOf(b: PropertyBag): BendingLine[] {
  const out: BendingLine[] = [];
  for (let i = 0; b.has(`BENDINGLINE${i}_X1`); i++) {
    const c = (k: string) => coordOf(b.get(`BENDINGLINE${i}_${k}`)) ?? 0;
    out.push({ a: { x: c('X1'), y: c('Y1') }, b: { x: c('X2'), y: c('Y2') }, angle: b.float(`BENDINGLINE${i}_ANGLE`, 90), radius: coordOf(b.get(`BENDINGLINE${i}_RADIUS`)) ?? BEND_DEFAULTS.radius, foldIndex: b.int(`BENDINGLINE${i}_FOLDINDEX`, 1) });
  }
  return out;
}

export interface RegionRecord { props: PropertyBag; outline: Vec2[]; head: Uint8Array }

/** A region's coverlay shapes as its record keeps them: COVERLAYn_LAYERID, _CUTOUT, _VERTEXCOUNT, _Xk, _Yk [est: Konium's keys]. */
function coverlaysOf(b: PropertyBag): CoverlayShape[] {
  const out: CoverlayShape[] = [];
  for (let i = 0; b.has(`COVERLAY${i}_LAYERID`); i++) {
    const n = b.int(`COVERLAY${i}_VERTEXCOUNT`, 0), pts: Vec2[] = [];
    for (let k = 0; k < n; k++) pts.push({ x: coordOf(b.get(`COVERLAY${i}_X${k}`)) ?? 0, y: coordOf(b.get(`COVERLAY${i}_Y${k}`)) ?? 0 });
    if (pts.length >= 3) out.push({ layer: b.int(`COVERLAY${i}_LAYERID`, 0), outline: pts, cutout: b.bool(`COVERLAY${i}_CUTOUT`, false) });
  }
  return out;
}

/** The regions the file keeps (BoardRegions), as Konium works with them. */
export function rigidFlexFrom(outline: Vec2[], records: RegionRecord[], defaultStack: string, advanced = false): RigidFlex {
  const info = (r: RegionRecord): RegionInfo => ({
    name: r.props.get('NAME') ?? FIRST_REGION, stackId: r.props.get('LAYERSTACKID') ?? defaultStack, locked3d: r.props.bool('LOCKED3D', false),
    bends: bendsOf(r.props), props: r.props, head: r.head,
    ...(r.props.has('PRIORITY') ? { priority: r.props.int('PRIORITY', 0) } : {}),
    ...(r.props.bool('CUSTOMCOVERLAY', false) ? { customCoverlay: true } : {}),
    ...(coverlaysOf(r.props).length ? { coverlays: coverlaysOf(r.props) } : {}),
  });
  if (advanced && records.length) return { regions: records.map(info), splits: [], fixed: records.map((r) => r.outline), advanced: true };
  if (advanced) return { regions: [{ name: FIRST_REGION, stackId: defaultStack, locked3d: false, bends: [] }], splits: [], fixed: outline.length >= 3 ? [outline] : undefined, advanced: true };
  // (AD17's new board: its one region not 3D Locked; folding then holds the first region still)
  if (!records.length) return { regions: [{ name: FIRST_REGION, stackId: defaultStack, locked3d: false, bends: [] }], splits: [] };
  if (records.length === 1) return { regions: [info(records[0]!)], splits: [] };
  const fileShapes = records.map((r) => r.outline);
  const splits = splitsFromRegions(outline, fileShapes);
  const { shapes } = regionShapes(outline, splits);
  if (shapes.length !== records.length) return { regions: records.map(info), splits, fixed: fileShapes };
  // Each worked-out region takes the file's region it lies in
  const used = new Set<number>();
  const regions = shapes.map((s) => {
    const p = interiorPoint(s);
    let k = fileShapes.findIndex((f, i) => !used.has(i) && pointInPoly(p, f));
    if (k < 0) k = fileShapes.findIndex((_, i) => !used.has(i));
    used.add(k);
    return info(records[k]!);
  });
  return { regions, splits };
}

/** The board's regions with their outlines. */
export function boardRegions(doc: PcbDocument): BoardRegion[] {
  const f = doc.flex ?? rigidFlexFrom(doc.board.outline, [], substacks(doc)[0]?.id ?? '');
  const shapes = f.fixed ?? regionShapes(doc.board.outline, f.splits).shapes;
  return shapes.map((outline, index) => ({ ...(f.regions[index] ?? { name: nextRegionName(f.regions), stackId: f.regions[0]?.stackId ?? '', locked3d: false, bends: [] }), outline, index }));
}

/** The next free "Layer Stack Region N". */
export function nextRegionName(regions: { name: string }[]): string {
  let n = 1;
  while (regions.some((r) => r.name === `Layer Stack Region ${n}`)) n++;
  return `Layer Stack Region ${n}`;
}

const L_ = (v: number) => formatAltiumLength(Math.round(v));

/** A region's record properties, in AD17's order, its bending lines after them [est: their keys]. */
export function regionProps(r: BoardRegion): PropertyBag {
  const b = r.props?.clone() ?? PropertyBag.fromEntries([
    ['V7_LAYER', 'MULTILAYER'], ['NAME', r.name], ['LAYER', 'KEEPOUT'], ['KEEPOUT', 'TRUE'], ['ISBOARDCUTOUT', 'TRUE'], ['KIND', '0'], ['SUBPOLYINDEX', '-1'],
    ['UNIONINDEX', '0'], ['ARCRESOLUTION', '0.5mil'], ['ISSHAPEBASED', 'FALSE'], ['CAVITYHEIGHT', '0mil'], ['OBJECTKIND', 'BoardRegion'], ['BENDINGLINECOUNT', '0'],
    ['LOCKED3D', 'FALSE'], ['LAYERSTACKID', r.stackId],
  ]);
  b.set('NAME', r.name);
  b.set('LOCKED3D', r.locked3d ? 'TRUE' : 'FALSE');
  if (r.stackId) b.set('LAYERSTACKID', r.stackId);
  if (r.priority !== undefined) b.set('PRIORITY', String(r.priority)); else b.delete('PRIORITY');
  if (r.customCoverlay) b.set('CUSTOMCOVERLAY', 'TRUE'); else b.delete('CUSTOMCOVERLAY');
  b.replaceGroup((k) => /^COVERLAY\d+_/.test(k), (r.coverlays ?? []).flatMap((c, i): [string, string][] => [
    [`COVERLAY${i}_LAYERID`, String(c.layer)], [`COVERLAY${i}_CUTOUT`, c.cutout ? 'TRUE' : 'FALSE'], [`COVERLAY${i}_VERTEXCOUNT`, String(c.outline.length)],
    ...c.outline.flatMap((p, k): [string, string][] => [[`COVERLAY${i}_X${k}`, L_(p.x)], [`COVERLAY${i}_Y${k}`, L_(p.y)]]),
  ]));
  b.replaceGroup((k) => /^BENDINGLINE\d+_/.test(k), r.bends.flatMap((l, i): [string, string][] => [
    [`BENDINGLINE${i}_X1`, L_(l.a.x)], [`BENDINGLINE${i}_Y1`, L_(l.a.y)], [`BENDINGLINE${i}_X2`, L_(l.b.x)], [`BENDINGLINE${i}_Y2`, L_(l.b.y)],
    [`BENDINGLINE${i}_ANGLE`, String(l.angle)], [`BENDINGLINE${i}_RADIUS`, L_(l.radius)], [`BENDINGLINE${i}_FOLDINDEX`, String(l.foldIndex)],
  ]));
  return b;
}
export const regionHead = (r: BoardRegion): Uint8Array => r.head?.slice() ?? REGION_HEAD.slice();

/** The rigid-flex state replaced (one undo step); the regions saved with the board. */
export function setRigidFlex(doc: PcbDocument, next: RigidFlex): Change {
  const before = doc.flex, was = doc.dirty.has('BoardRegions');
  return {
    apply() { doc.flex = next; doc.dirty.add('BoardRegions'); },
    revert() { doc.flex = before; if (!was) doc.dirty.delete('BoardRegions'); },
  };
}

/* ── editing ── */

const current = (doc: PcbDocument): RigidFlex => doc.flex ?? rigidFlexFrom(doc.board.outline, [], substacks(doc)[0]?.id ?? '');

/** The regions after the shapes changed: each new region takes the old one it lies in (the 3D Locked one first), its bending lines those inside it. */
function remap(doc: PcbDocument, given: SplitLine[], must = -1): RigidFlex | null {
  const old = boardRegions(doc);
  // A line that no longer cuts anything goes (after a board shape edit); the one being placed must cut
  const first = regionShapes(doc.board.outline, given);
  if (must >= 0 && !first.applied[must]) return null;
  const splits = given.filter((_, i) => first.applied[i]);
  const { shapes } = regionShapes(doc.board.outline, splits);
  const taken = new Set<number>();
  const order = shapes.map((s, i) => ({ s, i, area: Math.abs(polyArea(s)) })).sort((a, b) => b.area - a.area);
  const out: RegionInfo[] = new Array(shapes.length);
  for (const { s, i } of order) {
    const inside = old.filter((o) => pointInPoly(interiorPoint(o.outline), s) || pointInPoly(interiorPoint(s), o.outline));
    const pick = inside.find((o) => o.locked3d && !taken.has(o.index)) ?? inside.find((o) => !taken.has(o.index));
    const bends = old.flatMap((o) => o.bends).filter((l) => pointInPoly(mid(l.a, l.b), s));
    if (pick) { taken.add(pick.index); out[i] = { ...pick, bends }; continue; }
    const like = inside[0] ?? old[0];
    out[i] = { name: '', stackId: like?.stackId ?? '', locked3d: false, bends };
  }
  for (const r of out) if (!r.name) r.name = nextRegionName(out.filter((x) => x.name));
  return { regions: out, splits };
}

/** Design › Define Split Line: the board cut along a line; null when it cuts no region. */
export function addSplit(doc: PcbDocument, a: Vec2, b: Vec2): RigidFlex | null {
  const f = current(doc);
  const splits = [...(f.fixed ? splitsFromRegions(doc.board.outline, f.fixed) : f.splits), { a, b }];
  return remap(doc, splits, splits.length - 1);
}

/** A split line's ends dragged (its regions follow); null when it no longer cuts a region. */
export function moveSplit(doc: PcbDocument, i: number, a: Vec2, b: Vec2): RigidFlex | null {
  const all = splitLines(doc);
  if (!all[i]) return null;
  return remap(doc, all.map((s, k) => (k === i ? { a, b } : s)), i);
}

/** Design › Delete Split Line: the two regions it parted become one (the bigger one's name, stack). */
export function removeSplit(doc: PcbDocument, i: number): RigidFlex | null {
  const f = current(doc);
  const all = f.fixed ? splitsFromRegions(doc.board.outline, f.fixed) : f.splits;
  if (!all[i]) return null;
  // Lines that ended on it go too (they'd end in the middle of a region)
  const gone = all[i]!;
  const keep = all.filter((s, k) => k !== i && !([s.a, s.b].some((p) => nearestOnLoop([gone.a, gone.b], p).d <= TOL && nearestOnLoop(doc.board.outline, p).d > TOL)));
  return remap(doc, keep);
}

/** The split lines (from the file's regions while they're as read). */
export function splitLines(doc: PcbDocument): SplitLine[] {
  const f = current(doc);
  return f.fixed ? splitsFromRegions(doc.board.outline, f.fixed) : f.splits;
}

/** A region's properties changed (Board Region dialog); 3D Locked is one region's at a time. */
export function withRegion(doc: PcbDocument, index: number, p: Partial<RegionInfo>): RigidFlex {
  const f = current(doc), regs = boardRegions(doc);
  const regions = regs.map((r, i): RegionInfo => {
    const { outline: _o, index: _i, ...info } = r;
    if (i === index) return { ...info, ...p };
    return p.locked3d ? { ...info, locked3d: false } : info;
  });
  return { ...f, regions };
}

/* ── substacks ── */

/** The board's layer stacks (V9_SUBSTACKn_…, else V8's), never none: a board without them is one "Board Layer Stack". */
export function readSubstacks(b: PropertyBag | null | undefined): SubStack[] {
  const out: SubStack[] = [];
  for (const [pre, sep] of [['V9_SUBSTACK', '_'], ['LAYERSUBSTACK_V8_', '']] as const) {
    for (let i = 0; b?.has(`${pre}${i}${sep}ID`); i++) {
      const k = (s: string) => `${pre}${i}${sep}${s}`;
      out.push({
        id: b.get(k('ID'))!.trim(), name: b.get(k('NAME'))?.trim() || BOARD_STACK, isFlex: b.bool(k('ISFLEX')), showTop: b.bool(k('SHOWTOPDIELECTRIC')),
        showBottom: b.bool(k('SHOWBOTTOMDIELECTRIC')), service: b.bool(k('SERVICE')), usedByPrims: b.bool(k('USEDBYPRIMS')), type: b.int(k('TYPE'), 1),
      });
    }
    if (out.length) return out;
  }
  return [{ id: '', name: b?.get('LAYERSTACKNAME')?.trim() || BOARD_STACK, isFlex: false, showTop: false, showBottom: false, service: false, usedByPrims: true, type: 1 }];
}
export const substacks = (doc: PcbDocument): SubStack[] => readSubstacks(doc.board.bag);

/** The stacks into Board6 (V9 and V8 heads); none written for a board that had none. */
export function writeSubstacks(b: PropertyBag, subs: SubStack[]): void {
  const real = subs.filter((s) => s.id);
  if (!real.length) return;
  const heads = (pre: string, sep: string) => real.flatMap((s, i): [string, string][] => {
    const k = (x: string) => `${pre}${i}${sep}${x}`, tf = (v: boolean) => (v ? 'TRUE' : 'FALSE');
    return [[k('ID'), s.id], [k('NAME'), s.name], [k('SHOWTOPDIELECTRIC'), tf(s.showTop)], [k('SHOWBOTTOMDIELECTRIC'), tf(s.showBottom)], [k('ISFLEX'), tf(s.isFlex)],
      [k('SERVICE'), tf(s.service)], [k('USEDBYPRIMS'), tf(s.usedByPrims)], [k('TYPE'), String(s.type)]];
  });
  b.replaceGroup((k) => /^V9_SUBSTACK\d+_/.test(k), heads('V9_SUBSTACK', '_'));
  b.replaceGroup((k) => /^LAYERSUBSTACK_V8_\d+/.test(k), heads('LAYERSUBSTACK_V8_', ''));
}

/** Whether a stack row is in a substack (its {ID}CONTEXT; every layer is in a board's only stack) [est]. */
export const inStack = (r: StackLayer, id: string): boolean => !id || r.subs?.[id] !== false;

/** Where a substack's layers lie in the board's thickness: from the bottom face up (board units). */
export function stackRange(rows: StackLayer[], id: string): { z0: number; z1: number; total: number } {
  const th = (r: StackLayer) => (r.kind === 'signal' || r.kind === 'plane' ? r.copper : r.kind === 'dielectric' || r.kind === 'solder' || r.kind === 'coverlay' ? r.height : 0);
  const total = rows.reduce((t, r) => t + th(r), 0);
  let z = total, z0 = Infinity, z1 = -Infinity;
  for (const r of rows) {
    const t = th(r);
    if (t > 0 && inStack(r, id)) { z1 = Math.max(z1, z); z0 = Math.min(z0, z - t); }
    z -= t;
  }
  return Number.isFinite(z0) ? { z0, z1, total } : { z0: 0, z1: total, total };
}

/* ── bending lines and folding ── */

/** The width a bend takes (AD: Affected Area Width): the arc of its radius through its angle. */
export const affectedWidth = (l: BendingLine): number => l.radius * Math.abs(l.angle) * Math.PI / 180;

/**
 * A flex region's first bending line, as AD adds one when a region's stack turns flex: through
 * its middle, along the split lines it shares with the rest of the board (so what lies beyond
 * folds), or across its longer side when it has none.
 */
export function centreBend(outline: Vec2[], splits: SplitLine[] = []): BendingLine | null {
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const c = interiorPoint(outline);
  const own = splits.filter((s) => nearestOnLoop(outline, mid(s.a, s.b)).d <= TOL)
    .sort((p, q) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) - Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y))[0];
  let dir = w >= h ? { x: 0, y: 1 } : { x: 1, y: 0 };
  if (own) { const l = Math.hypot(own.b.x - own.a.x, own.b.y - own.a.y) || 1; dir = { x: (own.b.x - own.a.x) / l, y: (own.b.y - own.a.y) / l }; }
  const k = mil(100);
  const a = chordAcross([outline], c, { x: c.x - dir.x * k, y: c.y - dir.y * k }), b = chordAcross([outline], c, { x: c.x + dir.x * k, y: c.y + dir.y * k });
  return a && b ? { a, b, ...BEND_DEFAULTS } : null;
}

/** Which regions touch which (they share an edge: a split line). */
export function regionNeighbours(regs: { outline: Vec2[] }[]): { j: number; at: Vec2 }[][] {
  return regs.map((r, i) => {
    const out: { j: number; at: Vec2 }[] = [];
    regs.forEach((o, j) => {
      if (j === i) return;
      for (let k = 0; k < r.outline.length; k++) {
        const m = mid(r.outline[k]!, r.outline[(k + 1) % r.outline.length]!);
        if (nearestOnLoop(o.outline, m).d <= TOL) { out.push({ j, at: m }); return; }
      }
    });
    return out;
  });
}

export interface FoldBend {
  /** In the model's space (mm about the board's centre): a point on the line, its direction, the side that moves. */
  c: [number, number]; d: [number, number]; n: [number, number];
  /** Radians, signed; the strip's width (mm); the plane it bends about (mm up from the bottom face). */
  angle: number; w: number; zc: number;
  /** Fold Index group (0 first). */
  group: number;
  /** The region it bends (its points bend by where they lie), and the regions that turn whole with it. */
  region: number; moving: Set<number>;
}
export interface Fold { bends: FoldBend[]; groups: number; /** Region outlines in model space (bodies find theirs). */ regions: Vec2[][] }

/**
 * The folds of a board, in the 3D model's space (`toMm` maps board units there; `zOf` a region's
 * middle height). What a bending line moves: the regions joined to the 3D Locked one (the first
 * when none is) without going through the bend's region stay; of the bend's region, the side away
 * from them bends; the regions beyond turn whole. The bends further out come first (each is
 * carried by the ones nearer the locked region).
 */
export function foldOf(regs: BoardRegion[], toMm: (p: Vec2) => Vec2, zOf: (r: BoardRegion) => number, unitsPerMm: number): Fold | null {
  const lock = regs.findIndex((r) => r.locked3d);
  const L = lock < 0 ? 0 : lock;
  if (!regs[L]) return null;
  const nb = regionNeighbours(regs);
  const raw = regs.flatMap((r, ri) => r.bends.map((l) => ({ l, ri }))).filter(({ l }) => l.angle !== 0 && l.radius >= 0 && !near(l.a, l.b, TOL));
  if (!raw.length) return null;
  const spread = (seeds: number[], not: Set<number>) => {
    const seen = new Set<number>(), todo = seeds.filter((x) => !not.has(x));
    while (todo.length) { const x = todo.pop()!; if (seen.has(x) || not.has(x)) continue; seen.add(x); for (const { j } of nb[x]!) todo.push(j); }
    return seen;
  };
  const idx = [...new Set(raw.map(({ l }) => l.foldIndex))].sort((a, b) => a - b);
  const bends = raw.map(({ l, ri }): FoldBend & { mid: Vec2 } => {
    const a = toMm(l.a), b = toMm(l.b), len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d: [number, number] = [(b.x - a.x) / len, (b.y - a.y) / len];
    let n: [number, number] = [-d[1], d[0]];
    const sOf = (p: Vec2) => { const q = toMm(p); return (q.x - a.x) * n[0] + (q.y - a.y) * n[1]; };
    // The side that stays: towards the regions joined to the locked one, else the locked region's middle
    const fixed = ri === L ? new Set<number>() : spread([L], new Set([ri]));
    const anchor = ri === L ? interiorPoint(regs[L]!.outline) : nb[ri]!.find((x) => fixed.has(x.j))?.at ?? interiorPoint(regs[L]!.outline);
    if (sOf(anchor) > 0) n = [-n[0], -n[1]];
    const seeds = nb[ri]!.filter((x) => !fixed.has(x.j) && sOf(x.at) > 0).map((x) => x.j);
    const moving = spread(seeds, new Set([...fixed, ri]));
    return { c: [a.x, a.y], d, n, angle: (l.angle * Math.PI) / 180, w: Math.max(1e-6, affectedWidth(l) / unitsPerMm), zc: zOf(regs[ri]!), group: idx.indexOf(l.foldIndex), region: ri, moving, mid: toMm(mid(l.a, l.b)) };
  });
  // Deeper first: a bend in a region another moves, or beyond another in the same region
  const depth = (k: (typeof bends)[number]) => bends.filter((o) => o !== k && (o.moving.has(k.region) || (o.region === k.region && (k.mid.x - o.c[0]) * o.n[0] + (k.mid.y - o.c[1]) * o.n[1] > o.w / 2))).length;
  const sorted = bends.map((b) => ({ b, dep: depth(b) })).sort((x, y) => y.dep - x.dep).map(({ b: { mid: _m, ...rest } }) => rest);
  return { bends: sorted, groups: idx.length, regions: regs.map((r) => r.outline.map(toMm)) };
}

/** The region (model space) a point lies in, -1 for none. */
export function regionAt(f: Fold, x: number, y: number): number {
  return f.regions.findIndex((r) => pointInPoly({ x, y }, r));
}

/** A rotation about a horizontal axis (dx, dy, 0) by angle a (Rodrigues), applied to v. */
function rot(dx: number, dy: number, a: number, v: [number, number, number]): [number, number, number] {
  const c = Math.cos(a), s = Math.sin(a), k = (dx * v[0] + dy * v[1]) * (1 - c);
  // d × v with d = (dx, dy, 0)
  const cx = dy * v[2], cy = -dx * v[2], cz = dx * v[1] - dy * v[0];
  return [v[0] * c + cx * s + dx * k, v[1] * c + cy * s + dy * k, v[2] * c + cz * s];
}

/**
 * Folded positions (and normals) of points given flat, in place: `progress` 0 flat … 1 folded,
 * the bends folding in Fold Index order. Points in a bend's strip follow its arc; beyond it, they
 * turn with it as one piece.
 */
export function foldPoints(f: Fold, progress: number, pos: Float32Array, nrm?: Float32Array, regions?: Int32Array | number): void {
  const flat = pos.slice();
  const regionOf = (i: number) => (regions === undefined ? -2 : typeof regions === 'number' ? regions : regions[i / 3]!);
  for (const b of f.bends) {
    const p = Math.max(0, Math.min(1, progress * f.groups - b.group));
    const theta = b.angle * p;
    if (Math.abs(theta) < 1e-9) continue;
    const half = b.w / 2, phiMax = Math.abs(theta), sgn = Math.sign(theta), R = b.w / phiMax;
    // n × up = −d·(…): the turn about d that takes n towards up (σ > 0) or down
    const kz = b.d[0] * b.n[1] - b.d[1] * b.n[0];
    const spin = (phi: number) => sgn * phi * kz;
    const Bx = b.c[0] - b.n[0] * half, By = b.c[1] - b.n[1] * half;
    const Ex = b.c[0] + b.n[0] * half, Ey = b.c[1] + b.n[1] * half;
    // Where the strip's far edge ends up (on the bend plane)
    const Epx = Bx + b.n[0] * R * Math.sin(phiMax), Epy = By + b.n[1] * R * Math.sin(phiMax), Epz = b.zc + sgn * R * (1 - Math.cos(phiMax));
    for (let i = 0; i < pos.length; i += 3) {
      const qx = flat[i]!, qy = flat[i + 1]!, qz = flat[i + 2]!;
      // A region the bend turns whole, the bend's own (by where the point is), or one it leaves
      const r = regionOf(i), whole = r >= 0 && b.moving.has(r);
      if (r >= 0 && r !== b.region && !whole) continue;
      const s = whole ? Infinity : (qx - b.c[0]) * b.n[0] + (qy - b.c[1]) * b.n[1];
      if (s <= -half) continue;
      if (s < half) {
        // On the arc: a fraction of the turn, the point's height along the turned normal
        const phi = (phiMax * (s + half)) / b.w, along = (qx - b.c[0]) * b.d[0] + (qy - b.c[1]) * b.d[1], h = qz - b.zc;
        const up = rot(b.d[0], b.d[1], spin(phi), [0, 0, 1]);
        pos[i] = Bx + b.d[0] * along + b.n[0] * R * Math.sin(phi) + up[0] * h;
        pos[i + 1] = By + b.d[1] * along + b.n[1] * R * Math.sin(phi) + up[1] * h;
        pos[i + 2] = b.zc + sgn * R * (1 - Math.cos(phi)) + up[2] * h;
        if (nrm) { const r = rot(b.d[0], b.d[1], spin(phi), [nrm[i]!, nrm[i + 1]!, nrm[i + 2]!]); nrm[i] = r[0]; nrm[i + 1] = r[1]; nrm[i + 2] = r[2]; }
        continue;
      }
      // Beyond: turned whole about the strip's far edge, which moves to the arc's end
      const v = rot(b.d[0], b.d[1], spin(phiMax), [pos[i]! - Ex, pos[i + 1]! - Ey, pos[i + 2]! - b.zc]);
      pos[i] = Epx + v[0]; pos[i + 1] = Epy + v[1]; pos[i + 2] = Epz + v[2];
      if (nrm) { const r = rot(b.d[0], b.d[1], spin(phiMax), [nrm[i]!, nrm[i + 1]!, nrm[i + 2]!]); nrm[i] = r[0]; nrm[i + 1] = r[1]; nrm[i + 2] = r[2]; }
    }
  }
}

/** The lines across a bend's strip a mesh is cut along so the bend comes out round (model space). */
export function stripCuts(b: FoldBend): { o: [number, number]; n: [number, number] }[] {
  const k = Math.max(4, Math.ceil(Math.abs(b.angle) / (Math.PI / 18)));
  return Array.from({ length: k + 1 }, (_, i) => {
    const s = -b.w / 2 + (b.w * i) / k;
    return { o: [b.c[0] + b.n[0] * s, b.c[1] + b.n[1] * s] as [number, number], n: b.n };
  });
}

/* ── Advanced Rigid-Flex (rigid-flex 2.0): regions on their own ── */

export const isAdvanced = (doc: PcbDocument): boolean => !!doc.flex?.advanced;
const strip = (r: BoardRegion): RegionInfo => { const { outline: _o, index: _i, ...info } = r; return info; };

/**
 * Layer Stack Manager › Tools › Features › Rigid-Flex (Advanced) on or off: to Advanced, the regions
 * keep their shapes as regions of their own (the split lines go); back to Standard, regions that
 * meet edge to edge and fill the board become split lines again — else a message why not.
 */
export function setAdvancedMode(doc: PcbDocument, on: boolean): RigidFlex | string {
  const regs = boardRegions(doc);
  if (on) return { regions: regs.map(strip), splits: [], fixed: regs.map((r) => r.outline), advanced: true };
  if (!doc.flex?.advanced) return current(doc);
  const o = doc.board.outline;
  if (regs.length < 2) return { regions: regs.map(strip), splits: [] };
  for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) {
    if (sharedArea(regs[i]!.outline, regs[j]!.outline) > mil(10) ** 2) return `${regs[i]!.name} and ${regs[j]!.name} overlap: Standard mode cuts the board with split lines, so its regions meet edge to edge`;
  }
  const covered = clipOutlines('union', regs.map((r) => r.outline)).reduce((t, x) => t + outlineArea(x), 0);
  if (Math.abs(covered - outlineArea(o)) > Math.max(mil(20) ** 2, outlineArea(o) * 0.001)) return 'The regions don\'t fill the board shape: Standard mode\'s regions are the board cut by split lines';
  const splits = splitsFromRegions(o, regs.map((r) => r.outline));
  const { shapes } = regionShapes(o, splits);
  if (shapes.length !== regs.length) return 'The regions can\'t be made from split lines (each must cut the board, or a region, from edge to edge)';
  const used = new Set<number>();
  const regions = shapes.map((sh) => {
    const p = interiorPoint(sh);
    let k = regs.findIndex((r, i) => !used.has(i) && pointInPoly(p, r.outline));
    if (k < 0) k = regs.findIndex((_, i) => !used.has(i));
    used.add(k);
    return strip(regs[k]!);
  });
  return { regions, splits };
}

/** Place › Board Region (Advanced): a region of its own, on the board's first stack, above the others. */
export function addRegion(doc: PcbDocument, outline: Vec2[]): RigidFlex {
  const regs = boardRegions(doc);
  const top = Math.max(0, ...regs.map((r) => r.priority ?? 0));
  const info: RegionInfo = { name: nextRegionName(regs), stackId: substacks(doc)[0]?.id ?? regs[0]?.stackId ?? '', locked3d: false, bends: [], priority: top + 1 };
  return { regions: [...regs.map(strip), info], splits: [], fixed: [...regs.map((r) => r.outline), outline], advanced: true };
}

/** Design › Slice Board Region (Advanced): a region cut in two along the line between two points on its edge; the new piece a region of its own, on the same stack. */
export function sliceRegion(doc: PcbDocument, index: number, a: Vec2, b: Vec2): RigidFlex | null {
  const regs = boardRegions(doc), r = regs[index];
  if (!r) return null;
  const halves = cutPolygon(r.outline, a, b);
  if (!halves) return null;
  // The half with the larger area keeps the region (and its 3D lock); bending lines go with the half they're in
  const [keep, other] = Math.abs(polyArea(halves[0])) >= Math.abs(polyArea(halves[1])) ? halves : [halves[1], halves[0]];
  const bendsIn = (poly: Vec2[]) => r.bends.filter((l) => pointInPoly(mid(l.a, l.b), poly));
  const regions = regs.map(strip), fixed = regs.map((x) => x.outline);
  regions[index] = { ...strip(r), bends: bendsIn(keep), coverlays: undefined, customCoverlay: undefined };
  fixed[index] = keep;
  regions.push({ name: nextRegionName(regs), stackId: r.stackId, locked3d: false, bends: bendsIn(other), ...(r.priority !== undefined ? { priority: r.priority } : {}) });
  fixed.push(other);
  return { regions, splits: [], fixed, advanced: true };
}

/** Delete on a region (Advanced): it goes, unless it is the last. */
export function removeRegion(doc: PcbDocument, index: number): RigidFlex | string {
  const regs = boardRegions(doc);
  if (regs.length < 2) return 'The board keeps at least one region';
  return { regions: regs.filter((_, i) => i !== index).map(strip), splits: [], fixed: regs.filter((_, i) => i !== index).map((r) => r.outline), advanced: true };
}

/** A region's vertex moved (Advanced: dragging its handle). */
export function moveRegionVertex(doc: PcbDocument, index: number, vertex: number, to: Vec2): RigidFlex | null {
  const regs = boardRegions(doc), r = regs[index];
  if (!r || !r.outline[vertex]) return null;
  const outline = r.outline.map((p, k) => (k === vertex ? { x: Math.round(to.x), y: Math.round(to.y) } : p));
  if (Math.abs(polyArea(outline)) < mil(1) ** 2) return null;
  return { regions: regs.map(strip), splits: [], fixed: regs.map((x, i) => (i === index ? outline : x.outline)), advanced: true };
}

/** Where the board keeps its rigid-flex mode: Board6's RIGIDFLEXMODE=ADVANCED [est: AD's own key unknown]. */
export const MODE_KEY = 'RIGIDFLEXMODE';
export const advancedIn = (b: PropertyBag | null | undefined): boolean => (b?.get(MODE_KEY) ?? '').trim().toUpperCase() === 'ADVANCED';

/** The rigid-flex state and its mode replaced (one undo step): the regions and Board6's mode key. */
export function setRigidFlexMode(doc: PcbDocument, next: RigidFlex): Change {
  const regions = setRigidFlex(doc, next);
  const bag = doc.board.bag, before = bag?.clone(), was = doc.dirty.has('Board6');
  return {
    apply() {
      regions.apply();
      if (bag) { const b = bag.clone(); if (next.advanced) b.set(MODE_KEY, 'ADVANCED'); else b.delete(MODE_KEY); doc.board.bag = b; doc.dirty.add('Board6'); }
    },
    revert() { regions.revert(); if (before) { doc.board.bag = before.clone(); if (!was) doc.dirty.delete('Board6'); } },
  };
}
