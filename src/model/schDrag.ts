/**
 * Drag (as opposed to Move): wires attached to what moves stay attached. Altium stretches the
 * attached end, keeping the last segment horizontal or vertical where it was; a two-point
 * wire gets a bend.
 */
import type { Vec2 } from '../core/geom';
import { PropertyBag } from '../formats/altium/props';
import { DIR_VECTORS, SR, schCoord, setSchCoord, type SchDocument } from './sch';
import { mapPoint, type SchXform } from './schTransform';

const key = (p: Vec2) => `${p.x},${p.y}`;

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if ((b.x - a.x) * (p.y - a.y) !== (b.y - a.y) * (p.x - a.x)) return false;
  return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** Points where wires connect to the moving objects (before the move). */
export function connectionPoints(doc: SchDocument, moving: Set<number>): { pts: Map<string, Vec2>; segs: [Vec2, Vec2][] } {
  const pts = new Map<string, Vec2>();
  const segs: [Vec2, Vec2][] = [];
  const add = (p: Vec2) => pts.set(key(p), p);
  for (const i of moving) {
    const o = doc.objects[i];
    if (!o) continue;
    switch (o.kind) {
      case 'pin': { const d = DIR_VECTORS[o.orient]!; add({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length }); break; }
      case 'power': case 'junction': case 'splice': add(o.at); break;
      case 'text': if (o.role === 'netlabel') add(o.at); break;
      case 'port': add(o.at); add(o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }); break;
      case 'busentry': add(o.a); add(o.b); break;
      case 'wire': case 'bus':
        add(o.pts[0]!); add(o.pts.at(-1)!);
        for (let k = 1; k < o.pts.length; k++) segs.push([o.pts[k - 1]!, o.pts[k]!]);
        break;
    }
  }
  return { pts, segs };
}

function wirePts(bag: PropertyBag): Vec2[] {
  const n = bag.int('LOCATIONCOUNT');
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) out.push({ x: schCoord(bag, `X${i}`), y: schCoord(bag, `Y${i}`) });
  return out;
}

export function setWirePts(bag: PropertyBag, pts: Vec2[]): void {
  const old = bag.int('LOCATIONCOUNT');
  for (let i = pts.length + 1; i <= old; i++) { bag.delete(`X${i}`); bag.delete(`Y${i}`); bag.delete(`X${i}_FRAC`); bag.delete(`Y${i}_FRAC`); }
  bag.set('LOCATIONCOUNT', String(pts.length));
  pts.forEach((p, i) => { setSchCoord(bag, `X${i + 1}`, p.x); setSchCoord(bag, `Y${i + 1}`, p.y); });
}

/** Move one end of a polyline to `to`, keeping the end segment's direction where possible. */
export function stretchEnd(pts: Vec2[], end: 'start' | 'end', to: Vec2): Vec2[] {
  const p = end === 'start' ? pts.slice() : pts.slice().reverse();
  const from = p[0]!, q = p[1]!;
  if (p.length >= 3) {
    if (from.y === q.y) p[1] = { x: q.x, y: to.y };          // horizontal end segment stays horizontal
    else if (from.x === q.x) p[1] = { x: to.x, y: q.y };     // vertical stays vertical
    p[0] = to;
  } else if (from.y === q.y && to.y !== q.y) {
    p.splice(0, 1, to, { x: to.x, y: q.y });                 // bend: vertical into the old horizontal
  } else if (from.x === q.x && to.x !== q.x) {
    p.splice(0, 1, to, { x: q.x, y: to.y });
  } else p[0] = to;
  // drop zero-length segments
  const out: Vec2[] = [];
  for (const v of p) { const last = out.at(-1); if (!last || last.x !== v.x || last.y !== v.y) out.push(v); }
  return end === 'start' ? out : out.reverse();
}

/**
 * New bags for the wires (and manual junctions) attached to what moves. `orthogonal`
 * (Preferences › Drag Orthogonal): the attached end keeps its segment horizontal or vertical,
 * with a bend where needed; off, the end just goes where the hot spot went.
 */
export function dragAttached(doc: SchDocument, moving: Set<number>, x: SchXform, orig: (i: number) => PropertyBag | undefined, orthogonal = true): Map<number, PropertyBag> {
  const stretch = (p: Vec2[], end: 'start' | 'end', to: Vec2) => {
    if (orthogonal) return stretchEnd(p, end, to);
    const q = p.slice();
    q[end === 'start' ? 0 : q.length - 1] = to;
    return q;
  };
  const { pts, segs } = connectionPoints(doc, moving);
  const out = new Map<number, PropertyBag>();
  const hit = (p: Vec2) => pts.has(key(p)) || segs.some(([a, b]) => onSegment(p, a, b));
  for (const o of doc.objects) {
    if (moving.has(o.index)) continue;
    const src = orig(o.index);
    if (!src) continue;
    if ((o.kind === 'wire' || o.kind === 'bus') && src.int('RECORD') !== SR.POLYLINE) {
      let p = wirePts(src);
      if (p.length < 2) continue;
      const s = hit(p[0]!), e = hit(p.at(-1)!);
      if (!s && !e) continue;
      if (s && e) p = p.map((v, k) => (k === 0 || k === p.length - 1 ? mapPoint(x, v) : v));
      if (s && !e) p = stretch(p, 'start', mapPoint(x, p[0]!));
      if (e && !s) p = stretch(p, 'end', mapPoint(x, p.at(-1)!));
      const bag = src.clone();
      setWirePts(bag, p);
      out.set(o.index, bag);
    } else if (o.kind === 'junction' && pts.has(key(o.at)) && !midStanding(doc, moving, o.at)) {
      // A junction on a T that stays (the wire runs on through it) stays with the wire
      const bag = src.clone();
      const q = mapPoint(x, o.at);
      setSchCoord(bag, 'LOCATION.X', q.x); setSchCoord(bag, 'LOCATION.Y', q.y);
      out.set(o.index, bag);
    }
  }
  return out;
}

/** p lies part-way along a wire that isn't moving (not at one of its ends). */
function midStanding(doc: SchDocument, moving: Set<number>, p: Vec2): boolean {
  return doc.objects.some((o) => {
    if (o.kind !== 'wire' || moving.has(o.index)) return false;
    const w = o as unknown as { pts: Vec2[] };
    if (w.pts.some((v, k) => (k === 0 || k === w.pts.length - 1) && v.x === p.x && v.y === p.y)) return false;
    for (let k = 1; k < w.pts.length; k++) if (onSegment(p, w.pts[k - 1]!, w.pts[k]!)) return true;
    return false;
  });
}

/**
 * Hot spots of what moves that touch a standing wire part-way along it (a T): dragging away
 * leaves a new wire from that point to where the hot spot went, so the connection holds.
 */
export function linkWires(doc: SchDocument, moving: Set<number>, x: SchXform): Vec2[][] {
  const { pts } = connectionPoints(doc, moving);
  const standing = doc.objects.filter((o) => (o.kind === 'wire') && !moving.has(o.index)) as { pts: Vec2[] }[];
  const out: Vec2[][] = [];
  for (const p of pts.values()) {
    const q = mapPoint(x, p);
    if (q.x === p.x && q.y === p.y) continue;
    const midWire = standing.some((w) => {
      if (w.pts.some((v, k) => (k === 0 || k === w.pts.length - 1) && v.x === p.x && v.y === p.y)) return false;
      for (let k = 1; k < w.pts.length; k++) if (onSegment(p, w.pts[k - 1]!, w.pts[k]!)) return true;
      return false;
    });
    if (!midWire) continue;
    out.push(p.x === q.x || p.y === q.y ? [p, q] : [p, { x: p.x, y: q.y }, q]);
  }
  return out;
}
