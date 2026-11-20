/**
 * Preferences › PCB Editor › Interactive Routing › Dragging › Component pushing: a component
 * moved onto others on its side of the board goes over them (Ignore), stops short of them
 * (Avoid), or pushes them aside along the way it moved (Push). A component's extent is the box
 * round its pads, outlines and bodies — not its designator and comment.
 */
import type { BBox, Vec2 } from '../core/geom';
import { L } from './layers';
import type { PcbDocument } from './pcb';

export type PointMap = (p: Vec2) => Vec2;

/** A component's box, where `map` puts it (as it is when absent). */
export function componentBox(doc: PcbDocument, c: number, map: PointMap = (v) => v): BBox | null {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (v: Vec2, r = 0) => { const q = map(v); b.minX = Math.min(b.minX, q.x - r); b.minY = Math.min(b.minY, q.y - r); b.maxX = Math.max(b.maxX, q.x + r); b.maxY = Math.max(b.maxY, q.y + r); };
  for (const p of doc.prims) {
    if (!('component' in p) || p.component !== c) continue;
    if (p.kind === 'text') continue;
    if (p.kind === 'pad') add(p.at, Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2);
    else if (p.kind === 'track') { add(p.a, p.width / 2); add(p.b, p.width / 2); }
    else if (p.kind === 'arc') add(p.c, p.r + p.width / 2);
    else if (p.kind === 'fill') { add(p.a); add(p.b); }
    else if (p.kind === 'region' || p.kind === 'body') for (const v of p.outline) add(v);
  }
  return b.minX <= b.maxX ? b : null;
}

const overlap = (a: BBox, b: BBox) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const side = (doc: PcbDocument, c: number) => doc.components[c]!.layer === L.BOTTOM;

/** The other components (on the same side) these boxes run into. */
export function collisions(doc: PcbDocument, moving: Set<number>, boxes: { c: number; box: BBox }[]): number[] {
  const out: number[] = [];
  for (const o of doc.components) {
    if (moving.has(o.index)) continue;
    const ob = componentBox(doc, o.index);
    if (ob && boxes.some((m) => side(doc, m.c) === side(doc, o.index) && overlap(m.box, ob))) out.push(o.index);
  }
  return out;
}

/**
 * Avoid: how far along the move (0…1) the components can go without running into another,
 * `mapAt(t)` placing them at that fraction of it. Already overlapping where they start counts as free.
 */
export function avoidFraction(doc: PcbDocument, comps: number[], mapAt: (t: number) => PointMap): number {
  const moving = new Set(comps);
  const hits = (t: number) => { const m = mapAt(t); return collisions(doc, moving, comps.map((c) => ({ c, box: componentBox(doc, c, m)! })).filter((x) => x.box)).length > 0; };
  if (!hits(1)) return 1;
  const start = new Set(collisions(doc, moving, comps.map((c) => ({ c, box: componentBox(doc, c)! })).filter((x) => x.box)));
  if (start.size) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (hits(mid)) hi = mid; else lo = mid; }
  return lo;
}

/**
 * Push: the components the moved ones now overlap are moved out of the way, along the move's
 * direction (or away from the moved one's centre), each just clear, and so on for what they
 * then run into. Locked components are not pushed. The shifts, by component.
 */
export function pushes(doc: PcbDocument, comps: number[], map: PointMap, dir: Vec2, gap = 0): Map<number, Vec2> {
  const moved = new Set(comps);
  const shift = new Map<number, Vec2>();
  const boxOf = (c: number): BBox | null => {
    if (moved.has(c)) return componentBox(doc, c, map);
    const s = shift.get(c), b = componentBox(doc, c);
    return b && s ? { minX: b.minX + s.x, minY: b.minY + s.y, maxX: b.maxX + s.x, maxY: b.maxY + s.y } : b;
  };
  const queue = [...comps];
  for (let guard = 0; queue.length && guard < 500; guard++) {
    const c = queue.shift()!, cb = boxOf(c);
    if (!cb) continue;
    for (const o of doc.components) {
      if (o.index === c || moved.has(o.index) || o.bag.bool('LOCKED') || side(doc, o.index) !== side(doc, c)) continue;
      const ob = boxOf(o.index);
      if (!ob || !overlap(cb, ob)) continue;
      // Along the move's main axis, or away from the pusher's centre when it only turned
      let u = dir;
      if (!u.x && !u.y) u = { x: (ob.minX + ob.maxX) / 2 - (cb.minX + cb.maxX) / 2, y: (ob.minY + ob.maxY) / 2 - (cb.minY + cb.maxY) / 2 };
      const alongX = Math.abs(u.x) >= Math.abs(u.y);
      const d = alongX ? (u.x >= 0 ? cb.maxX - ob.minX + gap : -(ob.maxX - cb.minX + gap)) : (u.y >= 0 ? cb.maxY - ob.minY + gap : -(ob.maxY - cb.minY + gap));
      const s = shift.get(o.index) ?? { x: 0, y: 0 };
      shift.set(o.index, alongX ? { x: s.x + d, y: s.y } : { x: s.x, y: s.y + d });
      queue.push(o.index);
    }
  }
  for (const [c, s] of shift) if (!s.x && !s.y) shift.delete(c); else shift.set(c, { x: Math.round(s.x), y: Math.round(s.y) });
  return shift;
}
