/**
 * Design Rule Check against the board's own rules (Rules6): Clearance, Short-Circuit,
 * Un-Routed Net, Width, Hole Size, Hole To Hole Clearance, Minimum Annular Ring and Board
 * Outline Clearance. Copper is modelled as circles, capsules and polygons (with holes, so
 * pour cut-outs are respected); neighbours come from an R-tree, so cost grows with what is
 * near each object, not with the square of the board.
 *
 * checkCopper() runs only the copper rules for a few new primitives against their
 * neighbours — interactive routing uses it on every commit.
 */
import RBush from 'rbush';
import { roomViolations } from './rooms';
import { arcChords, arcPoints, distToSegment, pointInPoly, rotate, type BBox, type Vec2 } from '../core/geom';
import { L, layerName, type LayerId } from './layers';
import { NO_NET, copperNet, inPour, type PcbDocument, type PcbPad, type PcbPrim, type PolyVertex } from './pcb';
import { drcSettings, waiverOf, type Waiver } from './drcOptions';
import { MORE_KINDS, padReports, reportOptions, runMore, textSlack, textStrokes } from './drcMore';
import { SI_CHECKED } from '../si/rules';
import { featureOn } from '../core/release';
import {
  mils, newRule, ruleEnabled, ruleKind, ruleLength, ruleName, rulePriority, ruleScope1, ruleScope2, type PcbRule,
} from '../formats/altium/rules';
import { queryContext, scopeTest, unsupportedIn } from './query';
import { padLayer } from './padStack';
import { splitPlanes } from './planes';
import { UNITS_PER_MIL, UNITS_PER_MM, parseLength, trimNum, type Coord } from '../core/units';

/* ─── Units ──────────────────────────────────────────────────────────────────────────── */

export type DrcUnits = 'mm' | 'mil';
/** The board's units (Board Options: Board6 DISPLAYUNIT 0 metric, 1 imperial): what DRC messages give lengths in, as AD's do. */
export function drcUnits(doc: PcbDocument): DrcUnits {
  return doc.board.bag?.int('DISPLAYUNIT', 1) === 0 ? 'mm' : 'mil';
}
/** A length as AD's DRC writes it, three places at most: 7.874mil, 0.2mm. */
export function lengthIn(u: DrcUnits, c: Coord): string {
  return `${trimNum((c / (u === 'mm' ? UNITS_PER_MM : UNITS_PER_MIL)).toFixed(3))}${u}`;
}
/** A length in the board's units. */
export const boardLength = (doc: PcbDocument, c: Coord): string => lengthIn(drcUnits(doc), c);
/** An area (internal units squared) in the board's units: 12.5 sq mil, 0.25 sq mm. */
export function boardArea(doc: PcbDocument, a: number, digits = 1): string {
  const u = drcUnits(doc), per = u === 'mm' ? UNITS_PER_MM : UNITS_PER_MIL;
  return `${(a / (per * per)).toFixed(u === 'mm' ? Math.max(digits, 3) : digits)} sq ${u}`;
}

/* ─── Geometry ───────────────────────────────────────────────────────────────────────── */

export type Geom =
  | { t: 'circle'; c: Vec2; r: number }
  | { t: 'seg'; a: Vec2; b: Vec2; r: number }
  | { t: 'poly'; pts: Vec2[]; holes: Vec2[][] };

/**
 * A primitive's copper on one layer. `ot`: its kind for the clearance rule's object table (AD's
 * ClearanceObj_…); `tol`: how far its drawn shape may lie inside the true one (an arc's chords).
 */
export interface Shape extends BBox {
  prim: number; layer: LayerId; net: number; g: Geom; ot: ObjType; tol: number;
  /**
   * 'removed': a pad's or via's shape where Remove Unused Pad Shapes took it off (it still joins
   * its net's copper that reaches it, but clears nothing); 'hole': its bare hole there, which other
   * nets' copper keeps the rule's hole clearance from (rules with AD's object table only).
   */
  role?: 'removed' | 'hole' | 'keepout';
  /** A keep-out's restrictions (what it keeps out: 0x01 vias, 0x02 tracks, 0x04 copper, 0x08 SMD pads, 0x10 through pads). */
  ko?: number;
}
export type ObjType = 'Track' | 'Arc' | 'SMDPad' | 'THPad' | 'Via' | 'Fill' | 'Poly' | 'Region' | 'Hole' | 'Text';

function boxOf(g: Geom): BBox {
  if (g.t === 'circle') return { minX: g.c.x - g.r, minY: g.c.y - g.r, maxX: g.c.x + g.r, maxY: g.c.y + g.r };
  if (g.t === 'seg') return { minX: Math.min(g.a.x, g.b.x) - g.r, minY: Math.min(g.a.y, g.b.y) - g.r, maxX: Math.max(g.a.x, g.b.x) + g.r, maxY: Math.max(g.a.y, g.b.y) + g.r };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of g.pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

const polyBoxes = new WeakMap<object, BBox>();
/** A polygon's box, worked out once. */
function polyBox(g: Extract<Geom, { t: 'poly' }>): BBox {
  let b = polyBoxes.get(g);
  if (!b) { b = boxOf(g); polyBoxes.set(g, b); }
  return b;
}

function segSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) > 1e-9) {
    const q = { x: c.x - a.x, y: c.y - a.y };
    const t = (q.x * s.y - q.y * s.x) / den, u = (q.x * r.y - q.y * r.x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

/**
 * A big polygon's edges in horizontal strips (each edge in every strip its y-span crosses), so a
 * point-in-polygon test reads one strip and a distance search only the strips near what it
 * measures from, nearest first.
 */
interface EdgeIndex { minY: number; h: number; k: number; es: [Vec2, Vec2][]; strips: number[][]; seen: Uint32Array; stamp: number }
const edgeIndex = new WeakMap<object, EdgeIndex>();
const INDEXED = 24;
function indexOf(g: { pts: Vec2[]; holes: Vec2[][] }): EdgeIndex {
  let ix = edgeIndex.get(g);
  if (ix) return ix;
  const es = edges(g);
  let minY = Infinity, maxY = -Infinity;
  for (const [a] of es) { if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y; }
  const k = Math.max(1, Math.min(2048, Math.ceil(es.length / 4)));
  const h = Math.max(1, (maxY - minY) / k);
  const strips: number[][] = Array.from({ length: k }, () => []);
  const at = (y: number) => Math.max(0, Math.min(k - 1, Math.floor((y - minY) / h)));
  es.forEach(([a, b], i) => { for (let j = at(Math.min(a.y, b.y)), e = at(Math.max(a.y, b.y)); j <= e; j++) strips[j]!.push(i); });
  ix = { minY, h, k, es, strips, seen: new Uint32Array(es.length), stamp: 0 };
  edgeIndex.set(g, ix);
  return ix;
}

/** Inside a polygon with holes. */
function insidePoly(p: Vec2, g: { pts: Vec2[]; holes: Vec2[][] }): boolean {
  if (g.pts.length + g.holes.reduce((n, h) => n + h.length, 0) < INDEXED) return pointInPoly(p, g.pts) && !g.holes.some((h) => pointInPoly(p, h));
  // Crossings to the right over the outline and its holes (even-odd, as the outline less its holes)
  const ix = indexOf(g);
  const j = Math.floor((p.y - ix.minY) / ix.h);
  if (j < 0 || j >= ix.k) return false;
  let inside = false;
  for (const e of ix.strips[j]!) {
    const [a, b] = ix.es[e]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function edges(g: { pts: Vec2[]; holes: Vec2[][] }): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const ring of [g.pts, ...g.holes]) for (let i = 0; i < ring.length; i++) out.push([ring[i]!, ring[(i + 1) % ring.length]!]);
  return out;
}

/**
 * The least of `fn` over a polygon's edges, for something in the box `q`: a big polygon's nearest
 * strips first, edges no nearer than the best so far passed over. `start`: a bound already known
 * (what's no nearer isn't measured; the result is then only known to be no less than it).
 */
function edgeMin(g: { pts: Vec2[]; holes: Vec2[][] }, q: BBox, fn: (p: Vec2, r: Vec2) => number, start = Infinity): number {
  let best = start;
  if (g.pts.length + g.holes.reduce((n, h) => n + h.length, 0) < INDEXED) { for (const [p, r] of edges(g)) best = Math.min(best, fn(p, r)); return best; }
  const ix = indexOf(g);
  if (++ix.stamp === 0xffffffff) { ix.seen.fill(0); ix.stamp = 1; }
  const at = (y: number) => Math.max(0, Math.min(ix.k - 1, Math.floor((y - ix.minY) / ix.h)));
  const scan = (j: number) => {
    for (const e of ix.strips[j]!) {
      if (ix.seen[e] === ix.stamp) continue;
      ix.seen[e] = ix.stamp;
      const [a, b] = ix.es[e]!;
      const dx = Math.max(0, Math.min(a.x, b.x) - q.maxX, q.minX - Math.max(a.x, b.x)), dy = Math.max(0, Math.min(a.y, b.y) - q.maxY, q.minY - Math.max(a.y, b.y));
      if (dx >= best || dy >= best) continue;
      best = Math.min(best, fn(a, b));
    }
  };
  const s0 = at(q.minY), s1 = at(q.maxY);
  for (let j = s0; j <= s1; j++) scan(j);
  for (let d = 1; ; d++) {
    const lo = s0 - d, hi = s1 + d;
    if (lo < 0 && hi >= ix.k) break;
    const gapLo = q.minY - (ix.minY + (lo + 1) * ix.h), gapHi = ix.minY + hi * ix.h - q.maxY;
    const goLo = lo >= 0 && gapLo < best, goHi = hi < ix.k && gapHi < best;
    if (!goLo && !goHi) break;
    if (goLo) scan(lo);
    if (goHi) scan(hi);
  }
  return best;
}

/** Whether any corner of a polygon (outline or holes) in the box `q` passes `test`: a big polygon's read from its edge strips. */
function cornersIn(g: { pts: Vec2[]; holes: Vec2[][] }, q: BBox, test: (p: Vec2) => boolean): boolean {
  const inq = (p: Vec2) => p.x >= q.minX && p.x <= q.maxX && p.y >= q.minY && p.y <= q.maxY;
  if (g.pts.length + g.holes.reduce((n, h) => n + h.length, 0) < INDEXED) return g.pts.some((p) => inq(p) && test(p)) || g.holes.some((h) => h.some((p) => inq(p) && test(p)));
  const ix = indexOf(g);
  const at = (y: number) => Math.floor((y - ix.minY) / ix.h);
  for (let j = Math.max(0, at(q.minY)), e = Math.min(ix.k - 1, at(q.maxY)); j <= e; j++) {
    for (const k of ix.strips[j]!) { const p = ix.es[k]![0]; if (inq(p) && test(p)) return true; }
  }
  return false;
}

/**
 * Edge-to-edge distance; ≤ 0 means touching or overlapping. `cap`: only distances below it are
 * wanted — one at or past it may come back as anything no less than it (big pours measured
 * against each other stop looking once nothing nearer than the cap is left).
 */
export function distance(a: Geom, b: Geom, cap = Infinity): number {
  if (a.t === 'poly' && b.t !== 'poly') return distance(b, a, cap);
  if (a.t === 'circle' && b.t === 'circle') return Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) - a.r - b.r;
  if (a.t === 'circle' && b.t === 'seg') return distToSegment(a.c, b.a, b.b) - a.r - b.r;
  if (a.t === 'seg' && b.t === 'circle') return distToSegment(b.c, a.a, a.b) - a.r - b.r;
  if (a.t === 'seg' && b.t === 'seg') return segSeg(a.a, a.b, b.a, b.b) - a.r - b.r;
  if (b.t === 'poly') {
    if (a.t === 'circle') {
      if (insidePoly(a.c, b)) return -a.r;
      return edgeMin(b, { minX: a.c.x, minY: a.c.y, maxX: a.c.x, maxY: a.c.y }, (p, q) => distToSegment(a.c, p, q), cap + a.r) - a.r;
    }
    if (a.t === 'seg') {
      if (insidePoly(a.a, b) || insidePoly(a.b, b)) return -a.r;
      const box = { minX: Math.min(a.a.x, a.b.x), minY: Math.min(a.a.y, a.b.y), maxX: Math.max(a.a.x, a.b.x), maxY: Math.max(a.a.y, a.b.y) };
      return edgeMin(b, box, (p, q) => segSeg(a.a, a.b, p, q), cap + a.r) - a.r;
    }
    // poly–poly, from the one with fewer corners: boxes no nearer than the cap need nothing more;
    // only corners in the other's box can be inside it (a big pour's found through its edge strips)
    const [sm, lg] = a.pts.length <= b.pts.length ? [a, b] : [b, a];
    const bs = polyBox(sm), bl = polyBox(lg);
    if (Math.max(bs.minX - bl.maxX, bl.minX - bs.maxX, bs.minY - bl.maxY, bl.minY - bs.maxY) >= cap) return cap;
    const inBox = (p: Vec2, q: BBox) => p.x >= q.minX && p.x <= q.maxX && p.y >= q.minY && p.y <= q.maxY;
    if (sm.pts.some((p) => inBox(p, bl) && insidePoly(p, lg)) || cornersIn(lg, bs, (p) => insidePoly(p, sm))) return 0;
    let d = cap;
    for (const [p, q] of edges(sm)) {
      const box = { minX: Math.min(p.x, q.x), minY: Math.min(p.y, q.y), maxX: Math.max(p.x, q.x), maxY: Math.max(p.y, q.y) };
      // An edge no nearer to the other's box than the best so far can't do better
      if (Math.max(0, box.minX - bl.maxX, bl.minX - box.maxX) >= d || Math.max(0, box.minY - bl.maxY, bl.minY - box.maxY) >= d) continue;
      d = Math.min(d, edgeMin(lg, box, (r, t) => segSeg(p, q, r, t), d));
      if (d <= 0) return 0;
    }
    return d;
  }
  return Infinity;
}

export function rectPoly(at: Vec2, w: number, h: number, rot: number): Vec2[] {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => rotate({ x: at.x + x!, y: at.y + y! }, rot, at));
}

export function padGeom(p: PcbPad, st: PcbPad['top']): Geom | null {
  const { w, h } = st;
  if (w <= 0 || h <= 0) return null;
  if (st.shape === 'round') {
    if (Math.abs(w - h) < 1) return { t: 'circle', c: p.at, r: w / 2 };
    const r = Math.min(w, h) / 2, half = (Math.max(w, h) - Math.min(w, h)) / 2;
    const dir = w > h ? { x: half, y: 0 } : { x: 0, y: half };
    const a = rotate({ x: p.at.x - dir.x, y: p.at.y - dir.y }, p.rotation, p.at), b = rotate({ x: p.at.x + dir.x, y: p.at.y + dir.y }, p.rotation, p.at);
    return { t: 'seg', a, b, r };
  }
  if (st.shape === 'octagon') {
    const c = Math.min(w, h) / 4;
    const pts = [[-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c], [w / 2, h / 2 - c], [w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c], [-w / 2, -h / 2 + c]]
      .map(([x, y]) => rotate({ x: p.at.x + x!, y: p.at.y + y! }, p.rotation, p.at));
    return { t: 'poly', pts, holes: [] };
  }
  if (st.shape === 'roundrect' && st.cornerPct > 0) {
    const r = (Math.min(w, h) / 2) * Math.min(1, st.cornerPct / 100);
    const pts: Vec2[] = [];
    const corners: [number, number, number][] = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
    for (const [cx, cy, a0] of corners) for (let k = 0; k <= 4; k++) {
      const a = ((a0 + k * 22.5) * Math.PI) / 180;
      pts.push(rotate({ x: p.at.x + cx + r * Math.cos(a), y: p.at.y + cy + r * Math.sin(a) }, p.rotation, p.at));
    }
    return { t: 'poly', pts, holes: [] };
  }
  return { t: 'poly', pts: rectPoly(p.at, w, h, p.rotation), holes: [] };
}

const isCopper = (l: LayerId) => l >= L.TOP && l <= L.BOTTOM;

/** A hole as copper-free ground: a circle, or a slot's capsule. */
function holeGeom(p: PcbPad | Extract<PcbPrim, { kind: 'via' }>): Geom {
  if (p.kind === 'pad' && p.slot && p.slot.length > p.hole) {
    const a = ((p.rotation + p.slot.rotation) * Math.PI) / 180, h = (p.slot.length - p.hole) / 2;
    return { t: 'seg', a: { x: p.at.x - h * Math.cos(a), y: p.at.y - h * Math.sin(a) }, b: { x: p.at.x + h * Math.cos(a), y: p.at.y + h * Math.sin(a) }, r: p.hole / 2 };
  }
  return { t: 'circle', c: p.at, r: p.hole / 2 };
}


/** Copper shapes of the given primitives (all when omitted), one per copper layer. */
export function copperShapes(doc: PcbDocument, prims: readonly PcbPrim[] = doc.prims, base = 0): Shape[] {
  const stack = doc.board.copperStack.filter(isCopper);
  const out: Shape[] = [];
  // Pour copper without a net of its own takes its polygon's
  const add = (prim: number, layer: LayerId, net: number, g: Geom | null, ot: ObjType, tol = 0, role?: Shape['role']) => { if (g) out.push({ prim, layer, net: net === NO_NET ? copperNet(doc, prims[prim - base]!) : net, g, ot, tol, ...boxOf(g), ...(role ? { role } : {}) }); };
  /** A bare hole on a layer (a removed shape's, or a hole with no copper round it). */
  const hole = (i: number, l: LayerId, p: PcbPad | Extract<PcbPrim, { kind: 'via' }>) => add(i, l, p.net, holeGeom(p), 'Hole', 0, 'hole');
  const poured = inPour;
  // A pour's region without an arc approximation of its own is its polygon's (Polygons6 ARCRESOLUTION, as older boards keep it)
  const pourArcRes = new Map<number, number>();
  for (const g of doc.polygons) { const r = parseLength(g.bag.getRaw('ARCRESOLUTION')); if (r !== undefined) pourArcRes.set(g.index, r); }
  const arcResOf = (p: Extract<PcbPrim, { kind: 'region' }>) => Math.min(p.arcRes ?? (inPour(p) ? pourArcRes.get(p.polygon) : undefined) ?? 0, 10000);
  // Keep-outs: on the Keep-Out layer for every copper layer, else for their own
  const keepout = (p: PcbPrim, i: number) => {
    if (p.kind !== 'track' && p.kind !== 'arc' && p.kind !== 'fill' && p.kind !== 'region') return false;
    if (p.layer !== L.KEEPOUT && !(p.keepout && isCopper(p.layer))) return false;
    // Only a copper-kind region keeps things out: a polygon pour cutout (kind 1) shapes pours only, a dashed outline or cavity nothing
    if (p.kind === 'region' && (p.boardCutout || p.outline.length < 3 || p.regionKind !== 0)) return true;
    const layers = p.layer === L.KEEPOUT ? stack : [p.layer];
    const ko = p.keepout ? p.keepoutRestrictions ?? 0x1f : 0x1f;
    const put = (g: Geom, ot: ObjType, tol = 0) => { for (const l of layers) out.push({ prim: i, layer: l, net: NO_NET, g, ot, tol, ...boxOf(g), role: 'keepout', ko }); };
    if (p.kind === 'track') put({ t: 'seg', a: p.a, b: p.b, r: p.width / 2 }, 'Track');
    else if (p.kind === 'arc') {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360, n = arcChords(p.r, sweep);
      const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, n), sag = p.r * (1 - Math.cos((sweep * Math.PI) / 180 / n / 2));
      for (let s = 1; s < pts.length; s++) put({ t: 'seg', a: pts[s - 1]!, b: pts[s]!, r: p.width / 2 }, 'Arc', sag);
    } else if (p.kind === 'fill') put({ t: 'poly', pts: rectPoly({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation), holes: [] }, 'Fill');
    else put({ t: 'poly', pts: p.outline, holes: p.holes }, 'Region');
    return true;
  };
  // A shelved polygon's copper is out of the design until it is restored (AD leaves it out too)
  const shelved = new Set(doc.polygons.filter((g) => g.bag.bool('SHELVED')).map((g) => g.index));
  prims.forEach((p, k) => {
    const i = base + k;
    if (shelved.size && inPour(p) && shelved.has((p as { polygon: number }).polygon)) return;
    if (keepout(p, i)) return;
    switch (p.kind) {
      case 'track': if (isCopper(p.layer) && !p.keepout) add(i, p.layer, p.net, { t: 'seg', a: p.a, b: p.b, r: p.width / 2 }, poured(p) ? 'Poly' : 'Track'); break;
      case 'arc': {
        if (!isCopper(p.layer) || p.keepout) break;
        const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
        const n = arcChords(p.r, sweep);
        const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, n);
        // The chords lie inside the arc by up to their sagitta
        const sag = p.r * (1 - Math.cos((sweep * Math.PI) / 180 / n / 2));
        for (let s = 1; s < pts.length; s++) add(i, p.layer, p.net, { t: 'seg', a: pts[s - 1]!, b: pts[s]!, r: p.width / 2 }, poured(p) ? 'Poly' : 'Arc', sag);
        break;
      }
      case 'via': {
        const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd);
        const lo = a < 0 ? 0 : Math.min(a, b < 0 ? stack.length - 1 : b), hi = b < 0 ? stack.length - 1 : Math.max(a < 0 ? 0 : a, b);
        for (let s = lo; s <= hi; s++) {
          const l = stack[s]!;
          // A Full Stack via's own diameter on the layer; down to the hole, or removed, it clears only its hole
          const d = p.layerDiameters?.[l - 1] ?? p.diameter;
          const gone = !!p.removed && (p.removed >>> (l - 1)) % 2 === 1 && l !== L.TOP && l !== L.BOTTOM;
          if ((d || p.diameter) <= p.hole + 1 || gone) {
            if (gone) add(i, l, p.net, { t: 'circle', c: p.at, r: p.diameter / 2 }, 'Via', 0, 'removed');
            hole(i, l, p);
            continue;
          }
          add(i, l, p.net, { t: 'circle', c: p.at, r: (d || p.diameter) / 2 }, 'Via');
        }
        break;
      }
      case 'pad': {
        const ot: ObjType = p.hole > 0 ? 'THPad' : 'SMDPad';
        if (p.layer === L.MULTI) for (const l of stack) {
          const st = padLayer(p, l);
          const gone = !!p.removed && (p.removed >>> (l - 1)) % 2 === 1 && l !== L.TOP && l !== L.BOTTOM;
          // No copper where the shape is no bigger than the hole, or was removed: the bare hole clears
          if (gone || (p.hole > 0 && st.w <= p.hole + 1 && st.h <= p.hole + 1)) {
            if (gone) add(i, l, p.net, padGeom(p, st), ot, 0, 'removed');
            if (p.hole > 0) hole(i, l, p);
            continue;
          }
          add(i, l, p.net, padGeom(p, st), ot);
        }
        // A single-layer pad's shape is its top's on whichever layer it is (as it is drawn and plotted)
        else if (isCopper(p.layer)) add(i, p.layer, p.net, padGeom(p, p.top), ot);
        break;
      }
      case 'fill':
        if (isCopper(p.layer) && !p.keepout) {
          const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
          add(i, p.layer, p.net, { t: 'poly', pts: rectPoly(c, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation), holes: [] }, 'Fill');
        }
        break;
      case 'text': {
        // Copper text, by its strokes (a barcode by its box), within how far they may lie off AD's (textSlack: none in its
        // Default stroke font's grid glyphs)
        if (!isCopper(p.layer)) break;
        const g = textStrokes(p, doc);
        if (g) { const slack = textSlack(p, doc); for (const x of g) add(i, p.layer, NO_NET, x, 'Text', slack); }
        break;
      }
      case 'region':
        // Its outline's chords may lie off its true arcs by its arc resolution
        if (isCopper(p.layer) && p.regionKind === 0 && !p.boardCutout && !p.keepout && p.outline.length >= 3) add(i, p.layer, p.net, { t: 'poly', pts: p.outline, holes: p.holes }, poured(p) ? 'Poly' : 'Region', arcResOf(p));
        break;
    }
  });
  return out;
}

/* ─── Rules ──────────────────────────────────────────────────────────────────────────── */

/** A rule with its scopes as three-valued tests (null: rests on what Konium can't evaluate). */
export interface Scoped { rule: PcbRule; s1: (p: PcbPrim) => boolean | null; s2: (p: PcbPrim) => boolean | null }
/** The rule that applies, or HELD: a rule above it might apply but its scope can't be evaluated (nothing is reported). */
export const HELD = 'held' as const;
export type Pick = Scoped | typeof HELD | undefined;
export const and3 = (a: boolean | null, b: boolean | null) => (a === false || b === false ? false : a === null || b === null ? null : true);
export const or3 = (a: boolean | null, b: boolean | null) => (a === true || b === true ? true : a === null || b === null ? null : false);

export interface DrcViolation {
  kind: string;          // RULEKIND
  rule: string;          // rule name
  message: string;       // Altium-style text
  prims: number[];
  at: Vec2;
  error: boolean;
  /** An un-routed net's sub-nets (the pieces of copper its pads are in), for the report's Sub-Net Details. */
  details?: string[];
}

export interface DrcReport {
  violations: DrcViolation[];
  /** Violations waived in AD (left out of violations), each with its waiver. */
  waived?: { v: DrcViolation; w: Waiver }[];
  /** What wasn't checked, and why. */
  notes: string[];
  stats: { shapes: number; pairs: number; rules: number; ms: number };
  /** The units the messages give lengths in (the board's), for the report's rule headings. */
  units?: DrcUnits;
}

export const CHECKED_KINDS = ['Clearance', 'ShortCircuit', 'UnRoutedNet', 'Width', 'HoleSize', 'HoleToHoleClearance', 'MinimumAnnularRing', 'BoardOutlineClearance', 'RoomDefinition', ...MORE_KINDS, ...(featureOn('si') ? SI_CHECKED : [])];

const scopedCache = new WeakMap<object, { polygons: unknown; byKind: Map<string, { list: Scoped[]; notes: string[] }> }>();
/** Scopes asked once per object for one check (the same pad meets many neighbours). */
export function memo(list: Scoped[]): Scoped[] {
  const once = (f: (p: PcbPrim) => boolean | null) => {
    const m = new Map<PcbPrim, boolean | null>();
    return (p: PcbPrim) => { let v = m.get(p); if (v === undefined) { v = f(p); m.set(p, v); } return v; };
  };
  return list.map((r) => ({ rule: r.rule, s1: once(r.s1), s2: once(r.s2) }));
}

/**
 * Kinds the suite's DRC checks by its own default rule when a board has no rule of the kind (its
 * reports of boards without them list these processed, with these values): Modified Polygon,
 * Net Antennae, Routing Layers (every layer), and the Fabrication and Assembly Testpoint styles
 * and usages (one testpoint required on each net). Its Power Plane Connect and Differential Pairs
 * defaults aren't here: Konium's DRC doesn't check the first, and the second's report only
 * measures uncoupled lengths, where Konium's check would hold the pairs to its widths too.
 */
const IMPLICIT_RULES: [string, Record<string, string>][] = [
  ['UnpouredPolygon', { ALLOWSHELVED: 'FALSE', ALLOWMODIFIED: 'FALSE' }], ['RoutingLayers', {}],
  ['FabricationTestpoint', {}], ['FabricationTestPointUsage', {}], ['AssemblyTestpoint', {}], ['AssemblyTestPointUsage', {}],
  ['NetAntennae', { NETANTENNAETOLERANCE: '0mil' }],
];
const implicitCache = new WeakMap<PcbRule[], PcbRule[]>();
/** The rules the DRC goes by: the board's, then the suite's default for each kind of IMPLICIT_RULES it has no rule of. */
export function drcRules(doc: PcbDocument): PcbRule[] {
  let hit = implicitCache.get(doc.rules);
  if (!hit) {
    const have = new Set(doc.rules.map(ruleKind));
    const extra = IMPLICIT_RULES.filter(([k]) => !have.has(k)).map(([k, props]) => {
      const r = newRule(k, k, 1);
      for (const [key, v] of Object.entries(props)) r.bag.set(key, v);
      return r;
    });
    hit = extra.length ? [...doc.rules, ...extra] : doc.rules;
    implicitCache.set(doc.rules, hit);
  }
  return hit;
}

export function scoped(doc: PcbDocument, kind: string, notes: string[], asComponent = false): Scoped[] {
  // Once per rule list and polygons (the scopes read the board's nets and classes as they are)
  let c = scopedCache.get(doc.rules);
  if (!c || c.polygons !== doc.polygons) { c = { polygons: doc.polygons, byKind: new Map() }; scopedCache.set(doc.rules, c); }
  let hit = c.byKind.get(`${kind}${asComponent ? ':c' : ''}`);
  if (!hit) {
    const ctx = queryContext(doc, asComponent);
    const list: Scoped[] = [], own: string[] = [];
    for (const rule of drcRules(doc).filter((r) => ruleKind(r) === kind && ruleEnabled(r)).sort((a, b) => rulePriority(a) - rulePriority(b))) {
      const test = (src: string) => {
        try {
          const bad = unsupportedIn(src);
          if (bad.length) own.push(`${kind} rule "${ruleName(rule)}": its scope uses ${bad.join(', ')}, which Konium Designer can't evaluate yet — what it might cover isn't reported under the rules below it`);
          return scopeTest(src, ctx);
        } catch (e) {
          own.push(`${kind} rule "${ruleName(rule)}": its scope "${src}" can't be read (${(e as Error).message}) — what it might cover isn't reported`);
          return () => null;
        }
      };
      list.push({ rule, s1: test(ruleScope1(rule)), s2: test(ruleScope2(rule)) });
    }
    hit = { list, notes: own };
    c.byKind.set(`${kind}${asComponent ? ':c' : ''}`, hit);
  }
  notes.push(...hit.notes);
  return hit.list;
}

/** The highest-priority rule taking one object. */
export function unaryRule(rules: Scoped[], p: PcbPrim): Pick {
  for (const r of rules) { const m = r.s1(p); if (m === true) return r; if (m === null) return HELD; }
  return undefined;
}

/** Tolerance: 0.01 mil (what's in the files is rounded: a rule of 0.15 mm is 5.9055 mil, a coordinate to 0.0001 mil). */
export const T = 100;

export function describe(doc: PcbDocument, i: number, layer?: LayerId): string {
  const p = doc.prims[i]!;
  const o = doc.board.origin;
  const u = drcUnits(doc), f = (c: Coord) => lengthIn(u, c);
  const pt = (v: Vec2) => `(${f(v.x - o.x)},${f(v.y - o.y)})`;
  const ln = (l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);
  const on = layer !== undefined ? ` on ${ln(layer)}` : '';
  switch (p.kind) {
    case 'track': return `Track ${pt(p.a)}${pt(p.b)}${on || ` on ${ln(p.layer)}`}`;
    case 'arc': return `Arc ${pt(p.c)}${on || ` on ${ln(p.layer)}`}`;
    case 'via': return `Via ${pt(p.at)} from ${ln(p.layerStart)} to ${ln(p.layerEnd)}`;
    case 'pad': {
      const c = p.component !== NO_NET ? doc.components[p.component]?.designator : '';
      return `Pad ${c ? `${c}-` : 'Free-'}${p.name}${pt(p.at)}${on || ` on ${ln(p.layer)}`}`;
    }
    case 'fill': return `Fill ${pt(p.a)}${pt(p.b)}${on || ` on ${ln(p.layer)}`}`;
    // A pour's poured copper is its polygon's region, as AD names it
    case 'region': return `${inPour(p) ? 'Polygon Region' : 'Region'} (${p.holes.length} hole(s)) ${ln(p.layer)}`;
    case 'text': return `Text "${p.text}" ${pt(p.at)} on ${ln(p.layer)}`;
    case 'body': return `ComponentBody ${doc.components[p.component]?.designator ?? ''} on ${ln(p.layer)}`;
  }
}

export { mils };

function centre(g: Geom): Vec2 {
  if (g.t === 'circle') return g.c;
  if (g.t === 'seg') return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
  const b = boxOf(g);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
/** The point of a shape's skeleton nearest to p (polygons: p itself when inside). */
function nearestOn(g: Geom, p: Vec2): Vec2 {
  if (g.t === 'circle') return g.c;
  if (g.t === 'seg') return closestOnSeg(p, g.a, g.b);
  if (insidePoly(p, g)) return p;
  let best = g.pts[0]!, bd = Infinity;
  for (const [a, b] of edges(g)) { const q = closestOnSeg(p, a, b); const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = q; } }
  return best;
}
/** Where two shapes meet or come closest: the DRC marker goes there. */
export function contact(a: Geom, b: Geom): Vec2 {
  let p = nearestOn(a, centre(b)), q = nearestOn(b, p);
  p = nearestOn(a, q); q = nearestOn(b, p);
  return { x: Math.round((p.x + q.x) / 2), y: Math.round((p.y + q.y) / 2) };
}

/** Same net for clearance purposes: as in AD, objects on no net are all on one (No Net), so Different Nets rules pass them over. */
const sameNet = (a: Shape, b: Shape) => a.net === b.net;

/** The highest-priority rule whose scopes match the pair (either way round). */
export function pairRule(rules: Scoped[], a: PcbPrim, b: PcbPrim, skip?: (r: Scoped) => boolean): Pick {
  for (const r of rules) {
    if (skip?.(r)) continue;
    const m = or3(and3(r.s1(a), r.s2(b)), and3(r.s1(b), r.s2(a)));
    if (m === true) return r;
    if (m === null) return HELD;
  }
  return undefined;
}
/** Each net's differential pair (by name), for the Different / Same Differential Pairs net scopes. */
const pairNames = new WeakMap<PcbDocument, Map<number, string>>();
function pairOf(doc: PcbDocument, net: number): string | undefined {
  let m = pairNames.get(doc);
  if (!m) {
    m = new Map();
    const byName = new Map(doc.nets.map((n) => [n.name.toUpperCase(), n.index]));
    for (const b of doc.diffPairs ?? []) for (const k of ['POSITIVENETNAME', 'NEGATIVENETNAME']) {
      const n = byName.get((b.get(k) ?? '').toUpperCase());
      if (n !== undefined) m.set(n, b.get('NAME') ?? '');
    }
    pairNames.set(doc, m);
  }
  return m.get(net);
}
/**
 * Whether a Clearance rule's net scope takes a pair of objects on two different nets: Different
 * Nets and Any Net do; Same Net Only doesn't; Different Differential Pairs only when both are in
 * pairs and the pairs differ; Same Differential Pair only between the two nets of one pair.
 */
const netScopes = new WeakMap<PcbRule, string>();
export function netScopeTakes(doc: PcbDocument, r: PcbRule, a: number, b: number): boolean {
  let s = netScopes.get(r);
  if (s === undefined) { s = (r.bag.get('NETSCOPE') ?? 'DifferentNets').toLowerCase(); netScopes.set(r, s); }
  if (s === 'differentnets' || s === 'anynet') return true;
  if (s.startsWith('samenet')) return false;
  if (s === 'differentpairs' || s === 'samediffpairs') {
    const pa = pairOf(doc, a), pb = pairOf(doc, b);
    if (pa === undefined || pb === undefined) return false;
    return s === 'differentpairs' ? pa !== pb : pa === pb;
  }
  return true;
}
/** The top Clearance rule between objects of two nets: one whose net scope doesn't take them is passed over. */
function otherNetRule(doc: PcbDocument, rules: Scoped[], a: PcbPrim, b: PcbPrim, na: number, nb: number): Pick {
  return pairRule(rules, a, b, (r) => !netScopeTakes(doc, r.rule, na, nb));
}

/**
 * A Clearance rule's gaps: its generic clearance, and AD's object table (OBJECTCLEARANCES: track to
 * SMD pad, via to via …, in internal units) where it sets its own for a pair of kinds.
 */
interface ClearanceTable { generic: number; table: Map<string, number>; max: number; ignorePadsInFootprint: boolean }
const tables = new WeakMap<PcbRule, ClearanceTable>();
function clearanceTable(r: PcbRule): ClearanceTable {
  let t = tables.get(r);
  if (t) return t;
  const generic = r.bag.has('GENERICCLEARANCE') ? ruleLength(r, 'GENERICCLEARANCE', '10mil') : ruleLength(r, 'GAP', '10mil');
  const table = new Map<string, number>();
  for (const e of (r.bag.get('OBJECTCLEARANCES') ?? '').split(';')) {
    const m = /^ClearanceObj_(\w+)-ClearanceObj_(\w+):(-?\d+)$/.exec(e.trim());
    if (!m) continue;
    table.set(`${m[1]}-${m[2]}`, Number(m[3]));
    table.set(`${m[2]}-${m[1]}`, Number(m[3]));
  }
  t = { generic, table, max: Math.max(generic, ...table.values()), ignorePadsInFootprint: r.bag.bool('IGNOREPADTOPADCLEARANCEINFOOTPRINT') };
  tables.set(r, t);
  return t;
}
/** The gap a Clearance rule asks between two kinds of copper. */
export function ruleGap(r: PcbRule, a: ObjType, b: ObjType): number {
  const t = clearanceTable(r);
  return t.table.get(`${a}-${b}`) ?? t.generic;
}

/** Net ties: a component of kind Net Tie joins its nets in its own copper, which isn't a short or a clash. */
function netTieOf(doc: PcbDocument, p: PcbPrim): number {
  if (!('component' in p) || p.component === NO_NET) return -1;
  const k = doc.components[p.component]?.bag.int('COMPONENTKIND') ?? 0;
  return k === 3 || k === 4 ? p.component : -1;
}
const tieNetCache = new WeakMap<readonly PcbPrim[], Map<number, Set<number>>>();
/** The nets a net tie's pads are on. */
function tieNets(doc: PcbDocument, comp: number): Set<number> {
  let m = tieNetCache.get(doc.prims);
  if (!m) { m = new Map(); tieNetCache.set(doc.prims, m); }
  let s = m.get(comp);
  if (!s) { s = new Set(doc.prims.flatMap((p) => (p.kind === 'pad' && p.component === comp && p.net !== NO_NET ? [p.net] : []))); m.set(comp, s); }
  return s;
}
/** A net tie's copper against itself, or against copper of the nets it ties: not a violation. */
function tieExempt(doc: PcbDocument, pa: PcbPrim, na: number, pb: PcbPrim, nb: number): boolean {
  const ta = netTieOf(doc, pa), tb = netTieOf(doc, pb);
  if (ta < 0 && tb < 0) return false;
  return (ta >= 0 && (ta === tb || tieNets(doc, ta).has(nb))) || (tb >= 0 && tieNets(doc, tb).has(na));
}

/** Pairs a scope Konium can't evaluate kept from being reported (counted per run). */
export interface Held { n: number }

/** What each keep-out restriction bit keeps out. */
const KEEPOUT_BIT: Partial<Record<ObjType, number>> = { Via: 0x01, Track: 0x02, Arc: 0x02, Fill: 0x04, Region: 0x04, Poly: 0x04, Text: 0x04, SMDPad: 0x08, THPad: 0x10 };
/** A keep-out against other copper: kept clear by the clearance rule that applies, for what its restrictions keep out (true: reported). */
function keepoutPair(doc: PcbDocument, a: Shape, b: Shape, clearances: Scoped[], out: DrcViolation[], held: Held): boolean {
  if (a.role === 'keepout' && b.role === 'keepout') return false;
  const [k, o] = a.role === 'keepout' ? [a, b] : [b, a];
  if (o.role) return false;
  const bit = KEEPOUT_BIT[o.ot];
  if (!bit || !((k.ko ?? 0x1f) & bit)) return false;
  const pk = doc.prims[k.prim]!, po = doc.prims[o.prim]!;
  // A footprint's own keep-out doesn't keep out its own copper
  if ('component' in pk && pk.component !== NO_NET && 'component' in po && po.component === pk.component) return false;
  // A keep-out is on no net: rules for one net, or between differential pairs, don't take it
  const pick = pairRule(clearances, pk, po, (r) => /^(samenet|differentpairs|samediffpairs)/i.test(r.rule.bag.get('NETSCOPE') ?? ''));
  if (pick === HELD) { held.n++; return false; }
  if (!pick) return false;
  // No Net copper is one net with the keep-out under a Different Nets rule (AD reports nothing there)
  if (o.net === NO_NET && (pick.rule.bag.get('NETSCOPE') ?? 'DifferentNets') === 'DifferentNets') return false;
  const gap = ruleGap(pick.rule, k.ot, o.ot), slack = k.tol + o.tol;
  // A pour is poured round the keep-outs (AD pours it so, by its own engine and arc approximation): its pieces
  // nearer than the gap are no violation, and AD reports none. Only its copper over a keep-out is (a pour not
  // repoured since the keep-out came), as a collision.
  let d = 0;
  if (inPour(po)) {
    if (!overlapsBy(k.g, o.g, slack)) return false;
  } else {
    d = distance(k.g, o.g, Math.max(gap, 2 * T) + slack) + slack;
    if (d >= gap - T) return false;
  }
  out.push({ kind: 'Clearance', rule: ruleName(pick.rule), error: true, prims: [k.prim, o.prim], at: contact(k.g, o.g),
    message: `Clearance Constraint: (${d <= T ? 'Collision' : boardLength(doc, d)} < ${boardLength(doc, gap)}) Between ${describe(doc, k.prim)} And ${describe(doc, o.prim)}` });
  return true;
}

/**
 * Whether two shapes overlap by more than `slack` (not just touch): a seg or circle by how far the
 * other reaches into it; two polygons by a corner or an edge's middle of one inside the other, further
 * than the slack from its edges [est: two polygons crossing with no corner in either aren't seen].
 */
function overlapsBy(a: Geom, b: Geom, slack: number): boolean {
  if (a.t !== 'poly' || b.t !== 'poly') return distance(a, b, 2 * T + slack) + slack < -T;
  const deep = (p: Vec2, g: Extract<Geom, { t: 'poly' }>) => insidePoly(p, g) && edgeMin(g, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }, (q, r) => distToSegment(p, q, r), slack + 2 * T) > slack + T;
  const probes = (g: Extract<Geom, { t: 'poly' }>) => g.pts.flatMap((p, k) => { const q = g.pts[(k + 1) % g.pts.length]!; return [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }]; });
  const ba = polyBox(a), bb = polyBox(b);
  const inBox = (p: Vec2, q: BBox) => p.x >= q.minX && p.x <= q.maxX && p.y >= q.minY && p.y <= q.maxY;
  return probes(a).some((p) => inBox(p, bb) && deep(p, b)) || probes(b).some((p) => inBox(p, ba) && deep(p, a));
}

function clearancePairs(doc: PcbDocument, subject: Shape[], tree: RBush<Shape>, clearances: Scoped[], shorts: Scoped[],
  out: DrcViolation[], onSameNetTouch?: (a: Shape, b: Shape) => void, held: Held = { n: 0 }): number {
  const maxGap = Math.max(0, ...clearances.map((r) => clearanceTable(r.rule).max));
  const seen = new Set<string>();
  let pairs = 0;
  for (const a of subject) {
    const near = tree.search({ minX: a.minX - maxGap, minY: a.minY - maxGap, maxX: a.maxX + maxGap, maxY: a.maxY + maxGap });
    for (const b of near) {
      if (b.prim === a.prim || b.layer !== a.layer) continue;
      // One violation per pair of objects, as AD (pads, vias and keep-outs meet on several layers)
      const key = a.prim < b.prim ? `${a.prim}:${b.prim}` : `${b.prim}:${a.prim}`;
      if (seen.has(key)) continue;
      pairs++;
      const pa = doc.prims[a.prim]!, pb = doc.prims[b.prim]!;
      if (sameNet(a, b) && a.role !== 'keepout' && b.role !== 'keepout') {
        if (onSameNetTouch && a.net !== NO_NET && a.role !== 'hole' && b.role !== 'hole' && distance(a.g, b.g, 2 * T) <= T + a.tol + b.tol) onSameNetTouch(a, b);
        continue;
      }
      // A removed shape clears nothing; holes against holes are the Hole To Hole rule's
      if (a.role === 'removed' || b.role === 'removed' || (a.role === 'hole' && b.role === 'hole')) continue;
      if (a.role === 'keepout' || b.role === 'keepout') { if (keepoutPair(doc, a, b, clearances, out, held)) seen.add(key); continue; }
      // Two primitives of one pour don't clash with each other; a net tie's own copper joins its nets
      if (inPour(pa) && inPour(pb) && (pa as { polygon: number }).polygon === (pb as { polygon: number }).polygon) continue;
      if (tieExempt(doc, pa, a.net, pb, b.net)) continue;
      // A pour was poured around AD's own glyphs at its clearance: against Konium's font it would only show the fonts' difference [est]
      if ((pa.kind === 'text' && inPour(pb)) || (pb.kind === 'text' && inPour(pa))) continue;
      // The top rule for objects of two nets: a Same Net Only rule above it doesn't hide it
      const pick = otherNetRule(doc, clearances, pa, pb, a.net, b.net);
      let rule = pick === HELD ? undefined : pick;
      // A hole is measured only by rules with AD's object table (AD 18 and later); it never shorts
      const isHole = a.role === 'hole' || b.role === 'hole';
      if (isHole && rule && !rule.rule.bag.has('OBJECTCLEARANCES')) rule = undefined;
      const shortable = !isHole && shorts.length > 0 && a.net !== NO_NET && b.net !== NO_NET;
      if (!rule && !shortable) { if (pick === HELD) held.n++; continue; }
      const gap = rule ? ruleGap(rule.rule, a.ot, b.ot) : 0;
      // Measured only as near as either rule looks; arcs' chords may sit inside the arc by up to their sagitta
      const slack = a.tol + b.tol;
      const d = distance(a.g, b.g, Math.max(gap, 2 * T) + slack) + slack;
      if (d <= T && shortable) {
        const sp = pairRule(shorts, pa, pb);
        if (sp === HELD) held.n++;
        else if (sp && !sp.rule.bag.bool('ALLOWED')) {
          seen.add(key);
          out.push({ kind: 'ShortCircuit', rule: ruleName(sp.rule), error: true, prims: [a.prim, b.prim], at: contact(a.g, b.g),
            message: `Short-Circuit Constraint: Between ${describe(doc, a.prim)} And ${describe(doc, b.prim)}` });
          // and, as in AD, the overlap is a clearance collision too (below)
        }
      }
      if (!rule) { if (pick === HELD && d < maxGap - T) held.n++; continue; }
      // Pads of one footprint when the rule says to ignore them
      if (pa.kind === 'pad' && pb.kind === 'pad' && pa.component !== NO_NET && pa.component === pb.component && clearanceTable(rule.rule).ignorePadsInFootprint) continue;
      if (d < gap - T) {
        seen.add(key);
        out.push({ kind: 'Clearance', rule: ruleName(rule.rule), error: true, prims: [a.prim, b.prim], at: contact(a.g, b.g),
          message: `Clearance Constraint: (${d <= T ? 'Collision' : boardLength(doc, d)} < ${boardLength(doc, gap)}) Between ${describe(doc, a.prim)} And ${describe(doc, b.prim)}` });
      }
    }
  }
  return pairs;
}

/**
 * Check the board. With `subject`, only those primitives (indices into doc.prims) are checked —
 * against everything else — which is how online DRC stays fast on large boards; Un-Routed Net
 * needs the whole board and is skipped then.
 */
export function runDrc(doc: PcbDocument, asked: Set<string> = drcSettings(doc).batch, subject?: Set<number>): DrcReport {
  const t0 = performance.now();
  const notes: string[] = [];
  let kinds = new Set([...asked].filter((k) => CHECKED_KINDS.includes(k)));
  const out: DrcViolation[] = [];
  const held: Held = { n: 0 };
  // Lengths in the messages in the board's units, as AD gives them
  const units = drcUnits(doc), lenOf = (c: Coord) => lengthIn(units, c);
  const tree = boardIndex(doc);
  const all = tree.all();
  const shapes = subject ? all.filter((s) => subject.has(s.prim)) : all;
  const inSubject = (i: number) => !subject || subject.has(i);
  if (subject) kinds = new Set([...kinds].filter((k) => k !== 'UnRoutedNet'));
  const clearances = kinds.has('Clearance') ? memo(scoped(doc, 'Clearance', notes)) : [];
  const shorts = kinds.has('ShortCircuit') ? memo(scoped(doc, 'ShortCircuit', notes)) : [];
  const pairs = clearancePairs(doc, shapes, tree, clearances, shorts, out, undefined, held);

  if (kinds.has('UnRoutedNet')) {
    const rules = memo(scoped(doc, 'UnRoutedNet', notes));
    if (rules.length) out.push(...unroutedNets(doc, rules, held));
  }

  if (kinds.has('Width')) {
    const rules = memo(scoped(doc, 'Width', notes));
    doc.prims.forEach((p, i) => {
      if (!inSubject(i)) return;
      if ((p.kind !== 'track' && p.kind !== 'arc') || !isCopper(p.layer) || inPour(p)) return;
      const r = unaryRule(rules, p);
      if (r === HELD) { held.n++; return; }
      if (!r) return;
      const { min, max } = widthLimits(r.rule, p.layer);
      if (p.width < min - T || p.width > max + T) {
        out.push({ kind: 'Width', rule: ruleName(r.rule), error: true, prims: [i], at: p.kind === 'track' ? p.a : p.c,
          message: `Width Constraint (Min=${lenOf(min)}) (Max=${lenOf(max)}): ${describe(doc, i)} Actual Width = ${lenOf(p.width)}` });
      }
    });
  }

  const holes = doc.prims.map((p, i) => ({ p, i })).filter(({ p }) => (p.kind === 'pad' || p.kind === 'via') && p.hole > 0) as { p: PcbPad | Extract<PcbPrim, { kind: 'via' }>; i: number }[];
  if (kinds.has('HoleSize')) {
    const rules = memo(scoped(doc, 'HoleSize', notes));
    for (const { p, i } of holes) {
      if (!inSubject(i)) continue;
      const r = unaryRule(rules, p);
      if (r === HELD) { held.n++; continue; }
      if (!r) continue;
      if (r.rule.bag.has('ABSOLUTEVALUES') && !r.rule.bag.bool('ABSOLUTEVALUES')) {
        // As a share of the pad's (or via's) size
        const size = p.kind === 'via' ? p.diameter : Math.min(p.top.w, p.top.h);
        const pct = size > 0 ? (100 * p.hole) / size : 0, lo = Number(r.rule.bag.get('MINPERCENT') ?? 0), hi = Number(r.rule.bag.get('MAXPERCENT') ?? 100);
        if (pct < lo - 1e-6 || pct > hi + 1e-6) out.push({ kind: 'HoleSize', rule: ruleName(r.rule), error: true, prims: [i], at: p.at,
          message: `Hole Size Constraint (Min=${lo}%) (Max=${hi}%): ${describe(doc, i)} Actual Hole Size = ${pct.toFixed(2)}%` });
        continue;
      }
      const min = ruleLength(r.rule, 'MINLIMIT', '1mil'), max = ruleLength(r.rule, 'MAXLIMIT', '100mil');
      if (p.hole < min - T || p.hole > max + T) {
        out.push({ kind: 'HoleSize', rule: ruleName(r.rule), error: true, prims: [i], at: p.at,
          message: `Hole Size Constraint (Min=${lenOf(min)}) (Max=${lenOf(max)}): ${describe(doc, i)} Actual Hole Size = ${lenOf(p.hole)}` });
      }
    }
  }
  if (kinds.has('HoleToHoleClearance')) {
    const rules = memo(scoped(doc, 'HoleToHoleClearance', notes));
    if (rules.length) {
      const gapMax = Math.max(...rules.map((r) => ruleLength(r.rule, 'GAP', '10mil')));
      const ht = new RBush<BBox & { k: number }>();
      ht.load(holes.map(({ p }, k) => ({ k, minX: p.at.x - p.hole / 2, minY: p.at.y - p.hole / 2, maxX: p.at.x + p.hole / 2, maxY: p.at.y + p.hole / 2 })));
      holes.forEach(({ p, i }, k) => {
        if (!inSubject(i)) return;
        for (const n of ht.search({ minX: p.at.x - p.hole / 2 - gapMax, minY: p.at.y - p.hole / 2 - gapMax, maxX: p.at.x + p.hole / 2 + gapMax, maxY: p.at.y + p.hole / 2 + gapMax })) {
          const q = holes[n.k]!;
          if (n.k === k || (n.k < k && inSubject(q.i))) continue;
          const r = pairRule(rules, p, q.p);
          if (r === HELD) { held.n++; continue; }
          if (!r) continue;
          const gap = ruleLength(r.rule, 'GAP', '10mil');
          const d = Math.hypot(p.at.x - q.p.at.x, p.at.y - q.p.at.y) - p.hole / 2 - q.p.hole / 2;
          // Stacked micro-vias, where the rule allows them
          if (d < 0 && p.kind === 'via' && q.p.kind === 'via' && r.rule.bag.bool('ALLOWSTACKEDMICROVIAS')) continue;
          if (d < gap - T) out.push({ kind: 'HoleToHoleClearance', rule: ruleName(r.rule), error: true, prims: [i, q.i], at: p.at,
            message: `Hole To Hole Clearance Constraint: (${d <= T ? 'Collision' : lenOf(d)} < ${lenOf(gap)}) Between ${describe(doc, i)} And ${describe(doc, q.i)}` });
        }
      });
    }
  }
  if (kinds.has('MinimumAnnularRing')) {
    const rules = memo(scoped(doc, 'MinimumAnnularRing', notes));
    for (const { p, i } of holes) {
      if (!inSubject(i)) continue;
      const r = unaryRule(rules, p);
      if (r === HELD) { held.n++; continue; }
      if (!r) continue;
      const min = ruleLength(r.rule, 'MINIMUMRING', '10mil');
      // The ring on the outer layers that have copper (a bare hole has none to measure)
      const dias = p.kind === 'via' ? [p.layerDiameters?.[L.TOP - 1] ?? p.diameter, p.layerDiameters?.[L.BOTTOM - 1] ?? p.diameter]
        : [p.top, p.bot].filter((st) => st.w > p.hole + 1 || st.h > p.hole + 1).map((st) => Math.min(st.w, st.h));
      if (!dias.length || (p.kind === 'pad' && !p.plated)) continue;
      const ring = (Math.min(...dias) - p.hole) / 2;
      if (ring < min - T) out.push({ kind: 'MinimumAnnularRing', rule: ruleName(r.rule), error: true, prims: [i], at: p.at,
        message: `Minimum Annular Ring (Minimum=${lenOf(min)}): ${describe(doc, i)} Actual Annular Ring = ${lenOf(ring)}` });
    }
  }
  if (kinds.has('BoardOutlineClearance')) {
    const rules = memo(scoped(doc, 'BoardOutlineClearance', notes));
    const outline = doc.board.outline;
    if (rules.length && outline.length >= 3) {
      // The board shape's edges and its cutouts' (copper keeps clear of a cutout too)
      const cutouts = doc.prims.flatMap((q) => (q.kind === 'region' && q.boardCutout && q.outline.length >= 3 ? [q.outline] : []));
      // The board shape's arcs finely (chords within 0.005 mil), so copper near a rounded corner isn't flagged by the chords
      const fine = outlineEdges(doc.board.vertices.length >= 3 ? doc.board.vertices : outline.map((p) => ({ p })));
      // Each edge with its kind for the rule's object table (Outline Edge, Cutout Edge)
      const sides = new RBush<BBox & { a: Vec2; b: Vec2; edge: string }>();
      const side = (edge: string) => ([a, b]: [Vec2, Vec2]) => ({ a, b, edge, minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
      sides.load([...fine.map(side('OutlineEdge')), ...edges({ pts: [], holes: cutouts }).map(side('CutoutEdge'))]);
      // Copper, and silkscreen too, as the suite checks it (its reports flag overlay lines on and over the edge)
      const silk: (BBox & { prim: number; g: Geom; ot: ObjType; tol: number })[] = [];
      doc.prims.forEach((p, i) => {
        if (!inSubject(i) || !('layer' in p) || (p.layer !== L.TOP_OVERLAY && p.layer !== L.BOTTOM_OVERLAY) || p.kind === 'body' || p.kind === 'pad') return;
        const gs: Geom[] = p.kind === 'track' ? [{ t: 'seg', a: p.a, b: p.b, r: p.width / 2 }]
          : p.kind === 'arc' ? (() => { const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360; const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, arcChords(p.r, sweep)); return pts.slice(1).map((b, k): Geom => ({ t: 'seg', a: pts[k]!, b, r: p.width / 2 })); })()
          : p.kind === 'text' ? textStrokes(p) ?? []
          : p.kind === 'fill' ? [{ t: 'poly', pts: rectPoly({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation), holes: [] }]
          : p.kind === 'region' && p.outline.length >= 3 ? [{ t: 'poly', pts: p.outline, holes: p.holes }] : [];
        const ot: ObjType = p.kind === 'track' ? 'Track' : p.kind === 'arc' ? 'Arc' : p.kind === 'text' ? 'Text' : p.kind === 'fill' ? 'Fill' : 'Region';
        for (const g of gs) silk.push({ prim: i, g, ot, tol: 0, ...boxOf(g) });
      });
      // Per object, its nearest edge against the gap for that kind of object and edge, or its middle off the board
      const worst = new Map<number, { d: number; gap: number; edge: string; c: Vec2; rule: Scoped }>();
      for (const s of [...shapes.filter((x) => !x.role), ...silk]) {
        const p = doc.prims[s.prim]!;
        const r = unaryRule(rules, p);
        if (r === HELD) { held.n++; continue; }
        if (!r) continue;
        const reach = clearanceTable(r.rule).max;
        const c = centre(s.g);
        let w = worst.get(s.prim);
        for (const e of sides.search({ minX: s.minX - reach, minY: s.minY - reach, maxX: s.maxX + reach, maxY: s.maxY + reach })) {
          const gap = ruleGap(r.rule, s.ot, e.edge as ObjType);
          const d = distance(s.g, { t: 'seg', a: e.a, b: e.b, r: 0 }, gap + s.tol) + s.tol;
          if (d < gap - T && (!w || d - gap < w.d - w.gap)) { w = { d, gap, edge: e.edge, c, rule: r }; worst.set(s.prim, w); }
        }
        if (!w && (!pointInPoly(c, outline) || cutouts.some((h) => pointInPoly(c, h)))) worst.set(s.prim, { d: 0, gap: clearanceTable(r.rule).generic, edge: 'OutlineEdge', c, rule: r });
      }
      // Arcs, pads, vias, tracks, then the rest, the latest placed first in each [est: the suite's order]
      const rank: Record<string, number> = { arc: 0, pad: 1, via: 2, track: 3 };
      const order = [...worst.keys()].sort((a, b) => (rank[doc.prims[a]!.kind] ?? 4) - (rank[doc.prims[b]!.kind] ?? 4) || b - a);
      for (const i of order) {
        const w = worst.get(i)!;
        out.push({ kind: 'BoardOutlineClearance', rule: ruleName(w.rule.rule), error: true, prims: [i], at: w.c,
          message: `Board Outline Clearance(${w.edge === 'CutoutEdge' ? 'Cutout Edge' : 'Outline Edge'}): (${w.d <= T ? 'Collision' : lenOf(w.d)} < ${lenOf(w.gap)}) Between ${describe(doc, i)} And Board Edge` });
      }
    }
  }
  // Room Definition: what a room's scope holds stays inside it (ConfineIn) or out of it (ConfineOut); the whole board only
  if (kinds.has('RoomDefinition') && !subject) {
    const rules = memo(scoped(doc, 'RoomDefinition', notes));
    const byName = new Map(rules.map((r) => [ruleName(r.rule), r]));
    const primsOf = new Map<number, number[]>();
    doc.prims.forEach((p, i) => { if ('component' in p && p.component !== NO_NET) primsOf.set(p.component, [...(primsOf.get(p.component) ?? []), i]); });
    const o = doc.board.origin, f = (v: number, z: number) => lenOf(v - z);
    for (const { room, component } of roomViolations(doc, (room) => {
      const sc = byName.get(room.name);
      // A component the room's scope can't be decided for isn't reported
      return sc ? doc.components.map((_, c) => c).filter((c) => representatives(doc, primsOf.get(c) ?? []).some((i) => sc.s1(doc.prims[i]!) === true)) : [];
    })) {
      const xs = room.outline.map((q) => q.x), ys = room.outline.map((q) => q.y), comp = doc.components[component]!;
      out.push({ kind: 'RoomDefinition', rule: room.name, error: true, prims: (primsOf.get(component) ?? []).slice(0, 1), at: comp.at,
        message: `Room Definition: Between Room ${room.name} (Bounding Region = (${f(Math.min(...xs), o.x)}, ${f(Math.min(...ys), o.y)}, ${f(Math.max(...xs), o.x)}, ${f(Math.max(...ys), o.y)}) (${room.scope}) And Component ${comp.designator}` });
    }
  }
  runMore(doc, kinds, notes, held, out, subject);
  if (!subject) { padReports(doc, out); reportOptions(doc, kinds, out); }
  if (held.n) notes.push(`${held.n} possible violation${held.n === 1 ? '' : 's'} not reported: a rule above the one that would report ${held.n === 1 ? 'it' : 'them'} has a scope Konium Designer can't evaluate yet`);
  for (const k of new Set(doc.rules.filter(ruleEnabled).map(ruleKind))) {
    if (asked.has(k) && !CHECKED_KINDS.includes(k) && !NOT_CHECKED_BY_DRC.has(k)) notes.push(`${k} rules are not checked yet`);
  }
  const of = waiverOf(doc);
  const violations: DrcViolation[] = [], waived: { v: DrcViolation; w: Waiver }[] = [];
  for (const v of out) { const w = of(v); if (w) waived.push({ v, w }); else violations.push(v); }
  if (waived.length) notes.push(`${waived.length} waived violation${waived.length === 1 ? '' : 's'} not reported`);
  return { violations, waived, notes: [...new Set(notes)], stats: { shapes: shapes.length, pairs, rules: doc.rules.length, ms: Math.round(performance.now() - t0) }, units };
}

/** Rule kinds that guide design but that AD's DRC doesn't report on. */
const NOT_CHECKED_BY_DRC = new Set(['RoutingTopology', 'RoutingPriority', 'RoutingCorners', 'FanoutControl', 'SolderMaskExpansion', 'PasteMaskExpansion', 'PlaneClearance', 'PolygonConnect', 'SupplyNets', 'SignalStimulus', 'UnpouredPolygon']);

/** A Width rule's limits on a layer: its own for the layer when it sets them (TOPLAYER_MINWIDTH, MIDLAYERn_…), else the rule's. */
export function widthLimits(r: PcbRule, layer: LayerId): { min: number; max: number } {
  const prefix = layer === L.TOP ? 'TOPLAYER' : layer === L.BOTTOM ? 'BOTTOMLAYER' : layer > L.TOP && layer < L.BOTTOM ? `MIDLAYER${layer - L.TOP}` : '';
  const get = (k: string, def: string) => (prefix && r.bag.has(`${prefix}_${k}`) ? ruleLength(r, `${prefix}_${k}`, def) : null);
  return { min: get('MINWIDTH', '10mil') ?? ruleLength(r, 'MINLIMIT', '10mil'), max: get('MAXWIDTH', '10mil') ?? ruleLength(r, 'MAXLIMIT', '10mil') };
}

/** The board shape's edges, its arcs as chords no more than 0.005 mil inside them. */
export function outlineEdges(verts: PolyVertex[]): [Vec2, Vec2][] {
  const pts: Vec2[] = [];
  for (const v of verts) {
    pts.push(v.p);
    if (!v.arc || v.arc.r <= 0) continue;
    const sweep = ((v.arc.ea - v.arc.sa) % 360 + 360) % 360 || 360;
    const step = 2 * Math.acos(Math.max(0, 1 - 50 / v.arc.r)) * 180 / Math.PI;
    const n = Math.min(4096, Math.max(2, Math.ceil(sweep / Math.max(step, 0.01))));
    let arc = arcPoints(v.arc.c, v.arc.r, v.arc.r, v.arc.sa, v.arc.ea, n);
    const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
    if (near(arc[0]!, v.p) > near(arc.at(-1)!, v.p)) arc = arc.reverse();
    pts.push(...arc.slice(1, -1));
  }
  return pts.map((a, i) => [a, pts[(i + 1) % pts.length]!]);
}

/* ─── Interactive use: a cached index of the board and rule lookup ────────────────────── */

/** doc.prims is replaced on every edit, so one R-tree per primitive list stays valid. */
const indexCache = new WeakMap<readonly PcbPrim[], RBush<Shape>>();
export function boardIndex(doc: PcbDocument): RBush<Shape> {
  let t = indexCache.get(doc.prims);
  if (!t) { t = new RBush<Shape>(); t.load(copperShapes(doc)); indexCache.set(doc.prims, t); }
  return t;
}

/**
 * The primitives a component- or net-level scope is asked of: the first, and a few pads (which
 * carry the component's side and the net); enough for the component and net queries such rules
 * use, without asking every primitive of a big part.
 */
export function representatives(doc: PcbDocument, idx: number[]): number[] {
  const out = idx.slice(0, 1);
  for (const i of idx) { if (out.length >= 5) break; if (doc.prims[i]!.kind === 'pad' && i !== out[0]) out.push(i); }
  return out;
}

/** The highest-priority enabled rule of a kind whose first scope matches (unsupported scopes are skipped). */
export function ruleFor(doc: PcbDocument, kind: string, prim: PcbPrim): PcbRule | undefined {
  return scoped(doc, kind, []).find((r) => r.s1(prim) === true)?.rule;
}

export interface CopperCheckOptions {
  /** Polygon pours are repoured around new copper, so the router doesn't treat them as obstacles. */
  ignorePours?: boolean;
  /** Clearance and Short-Circuit only (skip Width). */
  clearanceOnly?: boolean;
}

/**
 * Copper rules (Clearance, Short-Circuit, Width) for new primitives only, against the board.
 * `prims` are not in doc.prims yet; their indices in messages start at doc.prims.length.
 */
export function checkCopper(doc: PcbDocument, prims: PcbPrim[], opt: CopperCheckOptions = {}): DrcViolation[] {
  const notes: string[] = [];
  const base = doc.prims.length;
  const lenOf = (c: Coord) => boardLength(doc, c);
  const view: PcbDocument = { ...doc, prims: [...doc.prims, ...prims] };
  const fresh = copperShapes(view, prims, base);
  if (!fresh.length) return [];
  let tree = boardIndex(doc);
  if (opt.ignorePours) {
    const box = fresh.reduce((b, s) => ({ minX: Math.min(b.minX, s.minX), minY: Math.min(b.minY, s.minY), maxX: Math.max(b.maxX, s.maxX), maxY: Math.max(b.maxY, s.maxY) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const pad = 1_000_000; // 100 mil around the new copper covers any clearance rule
    const near = tree.search({ minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad })
      .filter((s) => { const p = doc.prims[s.prim]!; return !inPour(p); });
    tree = new RBush<Shape>();
    tree.load(near);
  }
  const out: DrcViolation[] = [];
  clearancePairs(view, fresh, tree, memo(scoped(view, 'Clearance', notes)), memo(scoped(view, 'ShortCircuit', notes)), out);
  if (opt.clearanceOnly) return out;
  const widths = memo(scoped(view, 'Width', notes));
  prims.forEach((p, k) => {
    if (p.kind !== 'track' && p.kind !== 'arc') return;
    const r = unaryRule(widths, p);
    if (!r || r === HELD) return;
    const { min, max } = widthLimits(r.rule, p.layer);
    if (p.width < min - T || p.width > max + T) out.push({ kind: 'Width', rule: ruleName(r.rule), error: true, prims: [base + k], at: p.kind === 'track' ? p.a : p.c,
      message: `Width Constraint (Min=${lenOf(min)}) (Max=${lenOf(max)}): Actual Width = ${lenOf(p.width)}` });
  });
  return out;
}

/* ─── Connections (ratsnest) ─────────────────────────────────────────────────────────── */

export interface Connection { net: number; a: Vec2; b: Vec2 }

/**
 * Unrouted connections, as Altium draws connection lines: per net, copper that touches forms
 * islands; islands holding pads are joined by the shortest pad-to-pad lines (a minimum
 * spanning tree), so routing a connection removes its line.
 */
const connCache = new WeakMap<readonly PcbPrim[], Connection[]>();

const islandCache = new WeakMap<readonly PcbPrim[], (i: number) => number>();
/**
 * Which piece of copper each primitive is part of (by index): copper of a net that touches on a
 * layer, or meets through an internal plane, is one island. Islands of a net's pads are what the
 * connection lines join.
 */
export function copperIslands(doc: PcbDocument): (i: number) => number {
  const hit = islandCache.get(doc.prims);
  if (hit) return hit;
  const tree = boardIndex(doc);
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; let y = x; while (y !== r) { const n = parent.get(y) ?? r; parent.set(y, r); y = n; } return r; };
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const s of tree.all()) {
    if (s.net === NO_NET || s.role === 'hole' || s.role === 'keepout') continue;
    for (const o of tree.search({ minX: s.minX - T, minY: s.minY - T, maxX: s.maxX + T, maxY: s.maxY + T })) {
      if (o.prim === s.prim || o.net !== s.net || o.layer !== s.layer || o.role === 'hole' || o.role === 'keepout' || find(o.prim) === find(s.prim)) continue;
      if (distance(s.g, o.g) <= T) join(s.prim, o.prim);
    }
  }
  joinThroughPlanes(doc, join);
  joinThroughJumpers(doc, join);
  islandCache.set(doc.prims, find);
  return find;
}

export function connections(doc: PcbDocument): Connection[] {
  const hit = connCache.get(doc.prims);
  if (hit) return hit;
  const find = copperIslands(doc);
  const byNet = new Map<number, { at: Vec2; island: number }[]>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net === NO_NET) return;
    if (!byNet.has(p.net)) byNet.set(p.net, []);
    byNet.get(p.net)!.push({ at: p.at, island: find(i) });
  });
  const out: Connection[] = [];
  for (const [net, pads] of byNet) {
    if (new Set(pads.map((p) => p.island)).size < 2) continue;
    // Prim's algorithm over pads; reaching any pad of an island brings in the whole island
    const n = pads.length;
    const inTree = new Uint8Array(n);
    const dist = new Float64Array(n).fill(Infinity);
    const from = new Int32Array(n).fill(-1);
    const addIsland = (island: number) => {
      const fresh: number[] = [];
      pads.forEach((p, k) => { if (!inTree[k] && p.island === island) { inTree[k] = 1; fresh.push(k); } });
      for (let k = 0; k < n; k++) {
        if (inTree[k]) continue;
        for (const f of fresh) {
          const d = Math.hypot(pads[k]!.at.x - pads[f]!.at.x, pads[k]!.at.y - pads[f]!.at.y);
          if (d < dist[k]!) { dist[k] = d; from[k] = f; }
        }
      }
    };
    addIsland(pads[0]!.island);
    for (;;) {
      let best = -1;
      for (let k = 0; k < n; k++) if (!inTree[k] && (best < 0 || dist[k]! < dist[best]!)) best = k;
      if (best < 0) break;
      out.push({ net, a: pads[from[best]!]!.at, b: pads[best]!.at });
      addIsland(pads[best]!.island);
    }
  }
  connCache.set(doc.prims, out);
  return out;
}

const lineCache = new WeakMap<PcbPrim[], Connection[]>();
/**
 * The connection lines drawn (Preferences › PCB Editor › General › Smart Track Ends): on, from
 * wherever a partly routed net's copper ends nearest — a track's end, a via — not only its pads;
 * off, pad to pad (connections()). Islands join as connections() joins them, by the nearest points.
 */
export function connectionLines(doc: PcbDocument, smart: boolean): Connection[] {
  if (!smart) return connections(doc);
  const hit = lineCache.get(doc.prims);
  if (hit) return hit;
  const pads = connections(doc);
  const nets = new Set(pads.map((c) => c.net));
  const find = copperIslands(doc);
  const byNet = new Map<number, Map<number, Vec2[]>>();
  doc.prims.forEach((p, i) => {
    if (!('net' in p) || !nets.has(p.net)) return;
    const pts = p.kind === 'pad' || p.kind === 'via' ? [p.at] : p.kind === 'track' ? [p.a, p.b]
      : p.kind === 'arc' ? [{ x: p.c.x + p.r * Math.cos(p.start * Math.PI / 180), y: p.c.y + p.r * Math.sin(p.start * Math.PI / 180) }, { x: p.c.x + p.r * Math.cos(p.end * Math.PI / 180), y: p.c.y + p.r * Math.sin(p.end * Math.PI / 180) }] : [];
    if (!pts.length || ('polygon' in p && p.polygon !== NO_NET)) return;
    const islands = byNet.get(p.net) ?? new Map<number, Vec2[]>();
    byNet.set(p.net, islands);
    const k = find(i);
    const l = islands.get(k) ?? [];
    l.push(...pts);
    islands.set(k, l);
  });
  const out: Connection[] = [];
  for (const [net, islands] of byNet) {
    const groups = [...islands.values()];
    // A net too big to search point by point keeps its pad-to-pad lines
    if (groups.reduce((n, g) => n + g.length, 0) > 4000 || groups.length < 2) { out.push(...pads.filter((c) => c.net === net)); continue; }
    // Prim's algorithm over the islands: each step the nearest pair of points between the tree and an island outside it
    const n = groups.length, inTree = new Uint8Array(n);
    const near = groups.map(() => ({ d: Infinity, a: null as Vec2 | null, b: null as Vec2 | null }));
    const add = (gi: number) => {
      inTree[gi] = 1;
      for (let h = 0; h < n; h++) {
        if (inTree[h]) continue;
        const nh = near[h]!;
        for (const a of groups[gi]!) for (const b of groups[h]!) { const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2; if (d < nh.d) { nh.d = d; nh.a = a; nh.b = b; } }
      }
    };
    add(0);
    for (;;) {
      let pick = -1;
      for (let h = 0; h < n; h++) if (!inTree[h] && (pick < 0 || near[h]!.d < near[pick]!.d)) pick = h;
      if (pick < 0 || !near[pick]!.a) break;
      out.push({ net, a: near[pick]!.a!, b: near[pick]!.b! });
      add(pick);
    }
  }
  lineCache.set(doc.prims, out);
  return out;
}

/**
 * Internal planes connect what reaches them: through-hole pads and vias that span a plane layer
 * and carry its net (the layer's net from Board6 PLANEnNETNAME, or the split plane they stand in)
 * are joined through it, as AD connects them [est: Plane Connect Style No Connect not applied].
 */
function joinThroughPlanes(doc: PcbDocument, join: (a: number, b: number) => void): void {
  const stack = doc.board.copperStack;
  for (const pl of stack.filter((l) => l >= L.PLANE1 && l <= L.PLANE16)) {
    const splits = splitPlanes(doc, pl);
    const mainName = doc.board.bag?.get(`PLANE${pl - L.PLANE1 + 1}NETNAME`);
    const mainNet = mainName ? doc.nets.findIndex((n) => n.name === mainName) : -1;
    const at = stack.indexOf(pl);
    const first = new Map<string, number>();
    doc.prims.forEach((p, i) => {
      if (p.kind === 'pad') { if (p.layer !== L.MULTI || p.hole <= 0) return; }
      else if (p.kind === 'via') {
        const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd);
        if (a >= 0 && b >= 0 && (at < Math.min(a, b) || at > Math.max(a, b))) return;
      } else return;
      const sp = splits.find((s) => pointInPoly(p.at, s.outline));
      const net = sp ? sp.net : mainNet;
      if (net < 0 || net === NO_NET || p.net !== net) return;
      const k = sp ? `s${sp.index}` : 'main';
      const f = first.get(k);
      if (f === undefined) first.set(k, i); else join(i, f);
    });
  }
}

/**
 * A jumper, as the desktop software has it: a component of type Jumper whose pads share a Jumper
 * ID that is not 0. Both are needed: pads with one ID in a component of any other type are not
 * joined (a footprint can carry IDs it was drawn with), nor are a Jumper's pads without an ID.
 * Each group of such pads, by their indices.
 */
export function jumperGroups(doc: PcbDocument): { comp: number; net: number; pads: number[] }[] {
  const groups = new Map<string, { comp: number; net: number; pads: number[] }>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || !p.jumper || p.component === NO_NET) return;
    if (doc.components[p.component]?.bag.int('COMPONENTKIND') !== 6) return;
    const k = `${p.component}:${p.jumper}`, g = groups.get(k);
    if (g) g.pads.push(i); else groups.set(k, { comp: p.component, net: p.net, pads: [i] });
  });
  return [...groups.values()].filter((g) => g.pads.length > 1);
}

/** A jumper's pads are joined inside it (a wire link). */
function joinThroughJumpers(doc: PcbDocument, join: (a: number, b: number) => void): void {
  for (const g of jumperGroups(doc)) for (const i of g.pads.slice(1)) join(i, g.pads[0]!);
}

/** The jumpers to draw: pairs of a jumper's pads (each to the first). */
export function jumperLinks(doc: PcbDocument): { a: Vec2; b: Vec2; net: number; comp: number }[] {
  const out: { a: Vec2; b: Vec2; net: number; comp: number }[] = [];
  for (const g of jumperGroups(doc)) {
    const first = (doc.prims[g.pads[0]!] as PcbPad).at;
    for (const i of g.pads.slice(1)) out.push({ a: first, b: (doc.prims[i] as PcbPad).at, net: g.net, comp: g.comp });
  }
  return out;
}

/* ─── Un-Routed Net ──────────────────────────────────────────────────────────────────── */

/**
 * Un-Routed Net, as the suite reports it (its reports of boards with gaps cut in their routing and
 * copper islands): a net's copper that touches (joined through internal planes and jumpers, as the
 * connection lines are) makes its pieces, every piece counting, a pad-less one of tracks, arcs or a
 * lone via too. The pieces are joined by a minimum spanning tree, one violation per join, between
 * the nearest of each piece's vias, through-hole pads and tracks or arcs with an open end (a gap
 * left in the routing), or of its other pads when it has none, or of any of its objects when it has
 * no pad either; pad and via centres measured along x and y, anything else edge to edge [est: which
 * objects the suite names, from its reports: where a via faces a track or arc, it names a track at
 * the via, which Konium doesn't follow]. A pad without a plated hole is "[Unplated]" in the wording.
 */
export function unroutedNets(doc: PcbDocument, rules: Scoped[], held: Held): DrcViolation[] {
  const out: DrcViolation[] = [];
  const find = copperIslands(doc);
  const tree = boardIndex(doc);
  const shapes = new Map<number, Shape[]>();
  for (const s of tree.all()) { if (s.role) continue; const a = shapes.get(s.prim); if (a) a.push(s); else shapes.set(s.prim, [s]); }
  // A net's pieces: what each primitive with copper of its own belongs to (pour copper joins them, it isn't a piece)
  const byNet = new Map<number, Map<number, number[]>>();
  doc.prims.forEach((p, i) => {
    if (!('net' in p) || p.net === NO_NET || inPour(p) || !shapes.has(i)) return;
    if (p.kind !== 'pad' && p.kind !== 'via' && p.kind !== 'track' && p.kind !== 'arc' && p.kind !== 'fill' && p.kind !== 'region') return;
    let m = byNet.get(p.net);
    if (!m) { m = new Map(); byNet.set(p.net, m); }
    const r = find(i), g = m.get(r);
    if (g) g.push(i); else m.set(r, [i]);
  });
  // A track or arc end that meets nothing else of its net (where a gap was left in the routing)
  const meets = (i: number, layer: LayerId, net: number, q: Vec2, r: number) => {
    const g: Geom = { t: 'circle', c: q, r };
    return tree.search({ minX: q.x - r - T, minY: q.y - r - T, maxX: q.x + r + T, maxY: q.y + r + T }).some((o) => o.prim !== i && o.layer === layer && o.net === net && !o.role && distance(g, o.g, 2 * T) <= T);
  };
  const openEnded = (i: number) => {
    const p = doc.prims[i]!;
    if (p.kind !== 'track' && p.kind !== 'arc') return false;
    const ends = p.kind === 'track' ? [p.a, p.b] : [p.start, p.end].map((d) => ({ x: p.c.x + p.r * Math.cos((d * Math.PI) / 180), y: p.c.y + p.r * Math.sin((d * Math.PI) / 180) }));
    return ends.some((q) => !meets(i, p.layer, p.net, q, p.width / 2));
  };
  const isNode = (i: number) => { const p = doc.prims[i]!; return p.kind === 'via' || (p.kind === 'pad' && p.hole > 0) || openEnded(i); };
  const at = (i: number): Vec2 => { const p = doc.prims[i]!; return 'at' in p ? p.at : p.kind === 'track' || p.kind === 'fill' ? p.a : p.kind === 'arc' ? p.c : p.kind === 'region' ? p.outline[0] ?? doc.board.origin : doc.board.origin; };
  const gap = (a: number, b: number): number => {
    const pa = doc.prims[a]!, pb = doc.prims[b]!;
    // Pad or via centre to centre, along x and y [est: the suite's joins follow this better than straight across]
    if ((pa.kind === 'pad' || pa.kind === 'via') && (pb.kind === 'pad' || pb.kind === 'via')) return Math.abs(pa.at.x - pb.at.x) + Math.abs(pa.at.y - pb.at.y);
    let d = Infinity;
    for (const x of shapes.get(a)!) for (const y of shapes.get(b)!) d = Math.min(d, distance(x.g, y.g, d));
    return d;
  };
  const said = (i: number) => { const p = doc.prims[i]!; return `${describe(doc, i)}${p.kind === 'pad' && (p.hole === 0 || !p.plated) ? ' [Unplated]' : ''}`; };
  const short = (i: number) => { const p = doc.prims[i] as PcbPad; return `${doc.components[p.component]?.designator ?? 'Free'}-${p.name}`; };
  for (const [net, m] of byNet) {
    if (m.size < 2) continue;
    // The pieces with pads first (Sub-Net 1 is the net's own)
    const hasPad = (g: number[]) => g.some((i) => doc.prims[i]!.kind === 'pad');
    const list = [...m.values()].sort((a, b) => Number(hasPad(b)) - Number(hasPad(a)));
    const all = list.flat();
    const pick = unaryRule(rules, doc.prims[all.find((i) => doc.prims[i]!.kind === 'pad') ?? all[0]!]!);
    if (pick === HELD) { held.n++; continue; }
    if (!pick) continue;
    // Each piece's candidates: its vias and through-hole pads, else its pads, else all of it
    const cand = list.map((g) => { const n = g.filter(isNode); if (n.length) return n; const pads = g.filter((i) => doc.prims[i]!.kind === 'pad'); return pads.length ? pads : g; });
    const nearest = (x: number, y: number) => { let best = { d: Infinity, a: cand[x]![0]!, b: cand[y]![0]! }; for (const a of cand[x]!) for (const b of cand[y]!) { const d = gap(a, b); if (d < best.d) best = { d, a, b }; } return best; };
    // Sub-Net Details: each piece and its pads [est: the suite's wording]
    const details = list.map((g, k) => {
      const pads = g.filter((i) => doc.prims[i]!.kind === 'pad');
      return pads.length ? `Sub-Net ${k + 1}: ${pads.length} pad${pads.length === 1 ? '' : 's'} (${pads.slice(0, 12).map(short).join(', ')}${pads.length > 12 ? ', …' : ''})`
        : `Sub-Net ${k + 1}: no pads (${describe(doc, g[0]!)}${g.length > 1 ? ', …' : ''})`;
    });
    // Prim's algorithm over the pieces from the first
    const near = new Map<number, { d: number; a: number; b: number }>();
    for (let y = 1; y < list.length; y++) near.set(y, nearest(y, 0));
    let first = true;
    while (near.size) {
      let pickY = -1;
      for (const [y, e] of near) if (pickY < 0 || e.d < near.get(pickY)!.d) pickY = y;
      const e = near.get(pickY)!;
      near.delete(pickY);
      // A join to a region is worded by the other object alone, as the suite words it ("Un-Routed Net Constraint: Pad W1-1(…) on Top Layer")
      const region = [e.a, e.b].find((k) => doc.prims[k]!.kind === 'region'), other = region === e.a ? e.b : e.a;
      out.push({ kind: 'UnRoutedNet', rule: ruleName(pick.rule), error: true, prims: [e.a, e.b], at: at(e.a),
        message: region !== undefined ? `Un-Routed Net Constraint: ${describe(doc, other)}` : `Un-Routed Net Constraint: Net ${doc.nets[net]?.name ?? net} Between ${said(e.a)} And ${said(e.b)}`, ...(first ? { details } : {}) });
      first = false;
      for (const [y, f] of near) { const g = nearest(y, pickY); if (g.d < f.d) near.set(y, g); }
    }
  }
  return out;
}

/* ─── Clearance lookups for polygon pours ────────────────────────────────────────────── */

const clearanceCache = new WeakMap<PcbRule[], Scoped[]>();
/** The Clearance rule's gap between two objects (highest priority match; 0 if none applies). */
export function clearanceGap(doc: PcbDocument, a: PcbPrim, b: PcbPrim): number {
  let rules = clearanceCache.get(doc.rules);
  if (!rules) { rules = scoped(doc, 'Clearance', []); clearanceCache.set(doc.rules, rules); }
  // A rule whose scope can't be decided might be the one: the larger of it and the one that applies
  let gap = 0;
  for (const r of rules) {
    if (!netScopeTakes(doc, r.rule, copperNet(doc, a), copperNet(doc, b))) continue;
    const m = or3(and3(r.s1(a), r.s2(b)), and3(r.s1(b), r.s2(a)));
    if (m === false) continue;
    gap = Math.max(gap, ruleGap(r.rule, objType(a), objType(b)));
    if (m === true) break;
  }
  return gap;
}

/** A primitive's kind as the clearance rule's object table has it. */
export function objType(p: PcbPrim): ObjType {
  if (inPour(p)) return 'Poly';
  switch (p.kind) {
    case 'track': return 'Track';
    case 'arc': return 'Arc';
    case 'via': return 'Via';
    case 'pad': return p.hole > 0 ? 'THPad' : 'SMDPad';
    case 'fill': return 'Fill';
    case 'text': return 'Text';
    default: return 'Region';
  }
}

/**
 * Copper physically connected to primitive `start` (Altium's Select › Connected Copper), by
 * index. `through` limits what the search passes on to (Physical Connection stops at pads).
 */
const shapesByPrim = new WeakMap<readonly PcbPrim[], Map<number, Shape[]>>();
export function connectedCopper(doc: PcbDocument, start: number, through?: (i: number) => boolean): Set<number> {
  const tree = boardIndex(doc);
  // Each primitive's shapes, once per state of the board (Select › Net and the like ask many times)
  let byPrim = shapesByPrim.get(doc.prims);
  if (!byPrim) {
    byPrim = new Map<number, Shape[]>();
    for (const s of tree.all()) { const a = byPrim.get(s.prim); if (a) a.push(s); else byPrim.set(s.prim, [s]); }
    shapesByPrim.set(doc.prims, byPrim);
  }
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const i = queue.pop()!;
    for (const s of byPrim.get(i) ?? []) {
      if (s.role === 'hole' || s.role === 'keepout') continue;
      for (const o of tree.search({ minX: s.minX - T, minY: s.minY - T, maxX: s.maxX + T, maxY: s.maxY + T })) {
        if (seen.has(o.prim) || o.layer !== s.layer || o.role === 'hole' || o.role === 'keepout' || (through && !through(o.prim)) || distance(s.g, o.g) > T) continue;
        seen.add(o.prim);
        queue.push(o.prim);
      }
    }
  }
  return seen;
}

/** Rule kinds that apply between two objects (the rest apply to one). */
export const BINARY_KINDS = new Set(['Clearance', 'ShortCircuit', 'ComponentClearance', 'HoleToHoleClearance', 'SilkToSolderMaskClearance', 'SilkToSilkClearance', 'PolygonConnect']);

export interface ApplicableRule { rule: PcbRule; kind: string; name: string; priority: number; scope: string; wins: boolean }

/**
 * Right-click › Applicable Unary Rules (one object) or Applicable Binary Rules (two): every
 * enabled rule whose scopes take the object(s), by kind, highest priority first; the one that
 * wins for its kind is marked. Scopes Konium can't evaluate are left out.
 */
export function applicableRules(doc: PcbDocument, a: PcbPrim, b?: PcbPrim): ApplicableRule[] {
  const ctx = queryContext(doc);
  const out: ApplicableRule[] = [];
  const seen = new Set<string>();
  for (const rule of doc.rules.filter(ruleEnabled).sort((x, y) => ruleKind(x).localeCompare(ruleKind(y)) || rulePriority(x) - rulePriority(y))) {
    const kind = ruleKind(rule), binary = BINARY_KINDS.has(kind);
    if (binary !== !!b) continue;
    let ok: boolean | null = false;
    try {
      const s1 = scopeTest(ruleScope1(rule), ctx);
      if (!b) ok = s1(a);
      else { const s2 = scopeTest(ruleScope2(rule), ctx); ok = or3(and3(s1(a), s2(b)), and3(s1(b), s2(a))); }
    } catch { ok = false; }
    if (ok !== true) continue;
    out.push({ rule, kind, name: ruleName(rule), priority: rulePriority(rule), scope: b ? `${ruleScope1(rule)} / ${ruleScope2(rule)}` : ruleScope1(rule), wins: !seen.has(kind) });
    seen.add(kind);
  }
  return out;
}
