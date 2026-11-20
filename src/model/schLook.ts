/**
 * How the sheet is drawn where Preferences › Schematic decides it, rather than the file:
 * Port Direction and Unconnected Left To Right, Sheet Entry Direction, Display Cross-Overs,
 * Manual Junctions Connection Status, and the AutoFocus set (what joins what's being worked on).
 */
import type { Vec2 } from '../core/geom';
import { DIR_VECTORS, isShown, type SchDocument, type SchObject } from './sch';
import { hotSpots, wireConnection } from './schConnect';
import { entryPoint } from './schHierarchy';

type Port = SchObject & { kind: 'port' };
type Line = SchObject & { kind: 'wire' | 'bus' };
const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
const onSeg = (p: Vec2, a: Vec2, b: Vec2) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
  && (b.x - a.x) * (p.y - a.y) === (b.y - a.y) * (p.x - a.x);
const strictly = (p: Vec2, a: Vec2, b: Vec2) => onSeg(p, a, b) && !same(p, a) && !same(p, b);
const lines = (doc: SchDocument, kind?: 'wire' | 'bus') => doc.objects.filter((o): o is Line => (kind ? o.kind === kind : o.kind === 'wire' || o.kind === 'bus') && isShown(doc, o) && (o as Line).pts.length >= 2);
const pinEnd = (p: SchObject & { kind: 'pin' }): Vec2 => { const d = DIR_VECTORS[p.orient & 3]!; return { x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length }; };

/** A point that something electrical meets: a wire on it, or a pin end. */
export function touchTest(doc: SchDocument): (p: Vec2) => boolean {
  const ws = lines(doc, 'wire');
  const pins = doc.objects.filter((o): o is SchObject & { kind: 'pin' } => o.kind === 'pin' && isShown(doc, o)).map(pinEnd);
  return (p) => ws.some((w) => w.pts.some((q, i) => i > 0 && onSeg(p, w.pts[i - 1]!, q))) || pins.some((q) => same(p, q));
}

/**
 * Port Direction: the STYLE drawn for a port from its I/O type and the end that's connected —
 * an output points away from what it's joined to, an input towards it, a bidirectional port
 * both ways. Unconnected Left To Right: a port joined to nothing reads as joined on its left
 * (bottom) end. Unspecified, joined at both ends, or unjoined without that option: the file's.
 * STYLE: 0 none, 1 left, 2 right, 3 both; 4–7 the same for vertical ports (5 top, 6 bottom).
 */
export function shownPortStyle(o: Port, touches: (p: Vec2) => boolean, unconnectedLtr: boolean): number {
  const vertical = o.style >= 4;
  if (o.io === 3) return vertical ? 7 : 3;
  if (o.io !== 1 && o.io !== 2) return o.style;
  const far = vertical ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y };
  let a = touches(o.at), b = touches(far);
  if (a && b) return o.style;
  if (!a && !b) { if (!unconnectedLtr) return o.style; a = true; }
  // Pointing at the far end (right / top) or at LOCATION (left / bottom)
  const toFar = (o.io === 1) === a;
  return vertical ? (toFar ? 5 : 6) : (toFar ? 2 : 1);
}

/**
 * The outline an entry takes (as an I/O type: 0 box, 1 points out, 2 points in, 3 both).
 * Sheet Entry Direction on: its I/O type. Off: its own STYLE (left / right as on a port,
 * pointing out of the symbol on the edge it names) [est].
 */
export function shownEntryShape(io: number, style: number, side: number, directional: boolean): number {
  if (directional) return io;
  const s = style % 4;
  if (s === 0 || s === 3) return s;
  const out = side === 0 || side === 2 ? s === 1 : s === 2;
  return out ? 1 : 2;
}

/**
 * Display Cross-Overs: where two wires cross (not at a junction) the newer one — the later record —
 * hops over the older: a vertical run bulges right, a horizontal one up. Keyed by the hopping wire.
 */
export function wireHops(doc: SchDocument): Map<number, Vec2[]> {
  const ws = lines(doc, 'wire');
  const junctions = doc.objects.filter((o) => o.kind === 'junction' && isShown(doc, o)).map((o) => (o as { at: Vec2 }).at);
  type Seg = { a: Vec2; b: Vec2; wire: number; order: number };
  const hor: Seg[] = [], vert: Seg[] = [];
  let order = 0;
  for (const w of ws) {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1]!, b = w.pts[i]!, seg = { a, b, wire: w.index, order: order++ };
      if (a.y === b.y && a.x !== b.x) hor.push(seg);
      else if (a.x === b.x && a.y !== b.y) vert.push(seg);
    }
  }
  const out = new Map<number, Vec2[]>();
  for (const h of hor) {
    for (const v of vert) {
      const p = { x: v.a.x, y: h.a.y };
      if (!strictly(p, h.a, h.b) || !strictly(p, v.a, v.b) || junctions.some((j) => same(j, p))) continue;
      const top = h.wire !== v.wire ? (h.wire > v.wire ? h : v) : (h.order > v.order ? h : v);
      const list = out.get(top.wire) ?? [];
      list.push(p);
      out.set(top.wire, list);
    }
  }
  return out;
}

/** A polyline with a half-circle hop of radius r over each crossing point: up on horizontal runs, right on vertical ones. */
export function hopped(pts: Vec2[], hops: Vec2[], r: number): Vec2[] {
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const flat = a.y === b.y, upright = a.x === b.x;
    if (flat !== upright) {
      // along: unit step a→b; the bulge goes +y (flat) or +x (upright)
      const along = flat ? { x: Math.sign(b.x - a.x), y: 0 } : { x: 0, y: Math.sign(b.y - a.y) };
      const bulge = flat ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const pos = (p: Vec2) => (flat ? p.x : p.y), from = pos(a), to = pos(b);
      const here = hops.filter((p) => (flat ? p.y === a.y : p.x === a.x) && strictly(p, a, b) && Math.abs(pos(p) - from) > r && Math.abs(to - pos(p)) > r)
        .sort((p, q) => (pos(p) - pos(q)) * (flat ? along.x : along.y));
      for (const p of here) {
        const n = 8;
        for (let k = 0; k <= n; k++) {
          const t = Math.PI * (1 - k / n);           // from the near side over the bulge to the far side
          const c = Math.cos(t), sn = Math.sin(t);
          out.push({ x: p.x + along.x * r * c + bulge.x * r * sn, y: p.y + along.y * r * c + bulge.y * r * sn });
        }
      }
    }
    out.push(b);
  }
  return out;
}

/** Manual Junctions Connection Status: how many wire ends, wire runs (two each), pins and power ports meet at each manual junction. */
export function junctionConnections(doc: SchDocument): Map<number, number> {
  const ws = lines(doc, 'wire');
  const pins = hotSpots(doc);   // pin ends, power ports, port ends
  const out = new Map<number, number>();
  for (const j of doc.objects) {
    if (j.kind !== 'junction' || !isShown(doc, j)) continue;
    let n = pins.filter((p) => same(p, j.at)).length;
    for (const w of ws) {
      if (same(w.pts[0]!, j.at) || same(w.pts.at(-1)!, j.at)) n += 1;
      else if (w.pts.some((q, i) => i > 0 && onSeg(j.at, w.pts[i - 1]!, q))) n += 2;
    }
    out.set(j.index, n);
  }
  return out;
}

/**
 * AutoFocus: what is joined to these objects — the wires, junctions, labels, ports and entries
 * on the nets at their hot spots, and the parts whose pins are on them.
 */
export function connectedTo(doc: SchDocument, indices: number[]): Set<number> {
  const set = new Set(indices);
  const spots: Vec2[] = [];
  for (const i of indices) {
    const o = doc.objects[i];
    if (!o) continue;
    for (const c of doc.objects) if (c.kind === 'pin' && (c.owner === i || c.index === i)) spots.push(pinEnd(c));
    if (o.kind === 'power' || o.kind === 'junction' || (o.kind === 'text' && o.role === 'netlabel')) spots.push(o.at);
    if (o.kind === 'port') spots.push(o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y });
    if (o.kind === 'sheetentry') { const p = entryPoint(doc, o); if (p) spots.push(p); }
    if (o.kind === 'wire' || o.kind === 'bus') for (const k of wireConnection(doc, i)) set.add(k);
  }
  const ws = lines(doc);
  for (const p of spots) {
    const w = ws.find((l) => l.pts.some((q, i) => i > 0 && onSeg(p, l.pts[i - 1]!, q)));
    if (w) for (const k of wireConnection(doc, w.index)) set.add(k);
  }
  // Parts with a pin on those wires
  const on = ws.filter((w) => set.has(w.index));
  for (const c of doc.objects) {
    if (c.kind !== 'pin' || !isShown(doc, c)) continue;
    const p = pinEnd(c);
    if (on.some((w) => w.pts.some((q, i) => i > 0 && onSeg(p, w.pts[i - 1]!, q)))) { set.add(c.index); if (c.owner >= 0) set.add(c.owner); }
  }
  return set;
}
