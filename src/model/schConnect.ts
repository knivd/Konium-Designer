/**
 * Schematic connectivity helpers.
 *
 * Altium doesn't store automatic junctions: it draws a dot wherever three or more connections
 * meet at a wire end or an electrical hot spot (T-junctions, a pin landing mid-wire). Plain
 * crossings get no dot. Manual junctions (record 29) are stored and drawn on their own.
 */
import type { Vec2 } from '../core/geom';
import { DIR_VECTORS, type SchDocument, type SchObject, isShown } from './sch';
import { entryPoint } from './schHierarchy';

type Wire = SchObject & { kind: 'wire'; pts: Vec2[]; color: number };

export interface AutoJunction { at: Vec2; color: number }

const key = (p: Vec2) => `${p.x},${p.y}`;

/** Hot spots of pins, power ports and ports — the points wires connect to. */
export function hotSpots(doc: SchDocument): Vec2[] {
  const out: Vec2[] = [];
  for (const o of doc.objects) {
    if (!isShown(doc, o)) continue;
    if (o.kind === 'pin') {
      const d = DIR_VECTORS[o.orient]!;
      out.push({ x: o.at.x + d.x * o.length, y: o.at.y + d.y * o.length });
    } else if (o.kind === 'power') out.push(o.at);
    else if (o.kind === 'port') {
      out.push(o.at);
      out.push(o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y });
    }
  }
  return out;
}

/**
 * What the electrical grid snaps to: pin ends, power ports, port ends, sheet entries, junctions,
 * wire and bus vertices, bus entry ends — each point once.
 */
export function electricalSpots(doc: SchDocument): Vec2[] {
  const out = new Map<string, Vec2>();
  const add = (p: Vec2 | null) => { if (p) out.set(key(p), p); };
  for (const p of hotSpots(doc)) add(p);
  for (const o of doc.objects) {
    if (!isShown(doc, o)) continue;
    if (o.kind === 'wire' || o.kind === 'bus') for (const p of o.pts) add(p);
    else if (o.kind === 'junction') add(o.at);
    else if (o.kind === 'busentry') { add(o.a); add(o.b); }
    else if (o.kind === 'sheetentry') add(entryPoint(doc, o));
  }
  return [...out.values()];
}

/** Where Altium would draw an automatic junction on wires. */
export function autoJunctions(doc: SchDocument, kind: 'wire' | 'bus' = 'wire'): AutoJunction[] {
  const wires = doc.objects.filter((o): o is Wire => o.kind === kind && isShown(doc, o) && (o as Wire).pts.length >= 2);
  if (!wires.length) return [];

  // Segment index on a coarse grid
  const CELL = 2_000_000; // 200 mil
  const grid = new Map<string, { w: number; a: Vec2; b: Vec2 }[]>();
  wires.forEach((w, wi) => {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1]!, b = w.pts[i]!;
      const x0 = Math.floor(Math.min(a.x, b.x) / CELL), x1 = Math.floor(Math.max(a.x, b.x) / CELL);
      const y0 = Math.floor(Math.min(a.y, b.y) / CELL), y1 = Math.floor(Math.max(a.y, b.y) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx},${gy}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push({ w: wi, a, b });
      }
    }
  });

  // Pins and ports join wires; nothing but buses joins a bus here
  const spots = kind === 'wire' ? hotSpots(doc) : [];
  const devices = new Map<string, number>();
  for (const p of spots) devices.set(key(p), (devices.get(key(p)) ?? 0) + 1);
  const manual = new Set(doc.objects.filter((o) => o.kind === 'junction' && isShown(doc, o)).map((o) => key((o as { at: Vec2 }).at)));

  const candidates = new Map<string, Vec2>();
  for (const w of wires) { candidates.set(key(w.pts[0]!), w.pts[0]!); candidates.set(key(w.pts[w.pts.length - 1]!), w.pts[w.pts.length - 1]!); }
  for (const p of spots) candidates.set(key(p), p);

  const out: AutoJunction[] = [];
  for (const [k, p] of candidates) {
    if (manual.has(k)) continue;
    const segs = grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`);
    if (!segs) continue;
    // Per wire: 1 if p is one of its ends, 2 if the wire passes through p
    const perWire = new Map<number, number>();
    for (const s of segs) {
      if (!onSegment(p, s.a, s.b)) continue;
      const w = wires[s.w]!;
      const first = w.pts[0]!, last = w.pts[w.pts.length - 1]!;
      const isEnd = (p.x === first.x && p.y === first.y) || (p.x === last.x && p.y === last.y);
      perWire.set(s.w, isEnd ? 1 : 2);
    }
    let n = devices.get(k) ?? 0;
    let color = -1;
    for (const [wi, c] of perWire) { n += c; if (color < 0) color = wires[wi]!.color; }
    if (n >= 3 && perWire.size) out.push({ at: p, color });
  }
  return out;
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) return false;
  if (a.x === b.x || a.y === b.y) return true; // orthogonal: the box test is exact
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return Math.abs(cross) <= Math.hypot(b.x - a.x, b.y - a.y) * 50; // within 0.005 mil
}

/**
 * Junction records that would sit on fewer than three connections once `removed` objects are
 * gone. Locked junctions (LOCKED=T, Altium's manual junctions) always stay.
 */
export function orphanJunctions(doc: SchDocument, removed: Set<number>): number[] {
  const goneWires = doc.objects.filter((o): o is Wire => o.kind === 'wire' && removed.has(o.index));
  if (!goneWires.length) return [];
  const wires = doc.objects.filter((o): o is Wire => o.kind === 'wire' && !removed.has(o.index) && isShown(doc, o));
  const devices = new Map<string, number>();
  for (const p of hotSpots(doc)) devices.set(key(p), (devices.get(key(p)) ?? 0) + 1);
  const out: number[] = [];
  for (const j of doc.objects) {
    if (j.kind !== 'junction' || removed.has(j.index)) continue;
    if (doc.records[j.index + 1]?.bag?.bool('LOCKED')) continue;
    if (!goneWires.some((w) => onWire(j.at, w))) continue;
    let n = devices.get(key(j.at)) ?? 0;
    for (const w of wires) {
      if (!onWire(j.at, w)) continue;
      const first = w.pts[0]!, last = w.pts[w.pts.length - 1]!;
      n += (j.at.x === first.x && j.at.y === first.y) || (j.at.x === last.x && j.at.y === last.y) ? 1 : 2;
    }
    if (n < 3) out.push(j.index);
  }
  return out;
}

function onWire(p: Vec2, w: Wire): boolean {
  for (let i = 1; i < w.pts.length; i++) if (onSegment(p, w.pts[i - 1]!, w.pts[i]!)) return true;
  return false;
}

const onPts = (p: Vec2, pts: Vec2[]) => pts.some((q, i) => i > 0 && onSegment(p, pts[i - 1]!, q));

/**
 * Edit › Select › Connection: the wires (or buses) joined to this one — an end or a vertex on
 * another, not a plain crossing — and the junctions, net labels, power ports, ports and sheet
 * entries on them. Starting from a label or port, the wires at its hot spot.
 */
export function wireConnection(doc: SchDocument, start: number): number[] {
  const o0 = doc.objects[start];
  if (!o0) return [];
  const bus = o0.kind === 'bus';
  const wires = doc.objects.filter((o): o is Wire => (o.kind === (bus ? 'bus' : 'wire')) && isShown(doc, o) && (o as Wire).pts.length >= 2) as Wire[];
  const pointOf = (o: SchObject): Vec2 | null => (o.kind === 'junction' || o.kind === 'power' || (o.kind === 'text' && o.role === 'netlabel') ? o.at
    : o.kind === 'port' ? o.at : o.kind === 'sheetentry' ? entryPoint(doc, o) : null);
  const seen = new Set<number>();
  const queue: Wire[] = [];
  if (o0.kind === 'wire' || o0.kind === 'bus') queue.push(o0 as Wire);
  else {
    const p = pointOf(o0);
    const ends = o0.kind === 'port' ? [o0.at, o0.style >= 4 ? { x: o0.at.x, y: o0.at.y + o0.width } : { x: o0.at.x + o0.width, y: o0.at.y }] : p ? [p] : [];
    for (const w of wires) if (ends.some((e) => onPts(e, w.pts))) queue.push(w);
  }
  for (const w of queue) seen.add(w.index);
  while (queue.length) {
    const w = queue.shift()!;
    const ends = [w.pts[0]!, w.pts.at(-1)!];
    for (const o of wires) {
      if (seen.has(o.index)) continue;
      const oe = [o.pts[0]!, o.pts.at(-1)!];
      if (oe.some((p) => onPts(p, w.pts)) || ends.some((p) => onPts(p, o.pts))) { seen.add(o.index); queue.push(o); }
    }
  }
  const lines = wires.filter((w) => seen.has(w.index));
  const out = [...seen];
  for (const o of doc.objects) {
    if (seen.has(o.index) || !isShown(doc, o)) continue;
    const pts = o.kind === 'port' ? [o.at, o.style >= 4 ? { x: o.at.x, y: o.at.y + o.width } : { x: o.at.x + o.width, y: o.at.y }] : [pointOf(o)].filter((p): p is Vec2 => !!p);
    if (pts.some((p) => lines.some((w) => onPts(p, w.pts)))) out.push(o.index);
  }
  return out.sort((a, b) => a - b);
}
