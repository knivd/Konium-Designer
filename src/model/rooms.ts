/**
 * Rooms: Room Definition rules (Rules6 RULEKIND=RoomDefinition) as AD17 keeps them — the
 * outline as vertices (KINDn, VXn, VYn … with the closing copy), LAYER TOP or BOTTOM, the
 * components it holds by its first scope (InComponentClass('…'), InComponent('…') …),
 * CONFINEMENTSTYLE ConfineIn / ConfineOut, LOCKCOMPONENTS, FORMATCOPY. Design › Rooms places,
 * moves, wraps, slices and arranges them; the DRC checks that what a room holds stays inside.
 */
import * as ClipperNS from 'clipper-lib';
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import { L, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim } from './pcb';
import { cloneRule, newRule, nextRuleName, ruleEnabled, ruleKind, type PcbRule } from '../formats/altium/rules';
import { flattenVertices, readVertices, writeVertices } from '../formats/altium/pcbdoc';
import type { Change } from '../core/undo';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;

export interface Room {
  /** Index in doc.rules. */
  rule: number;
  name: string;
  layer: LayerId;
  outline: Vec2[];
  scope: string;
  confine: 'ConfineIn' | 'ConfineOut';
  lockComponents: boolean;
  enabled: boolean;
}

export const isRoom = (r: PcbRule) => ruleKind(r) === 'RoomDefinition';

/** A rule's room outline (the closing vertex dropped). */
export function roomOutline(r: PcbRule): Vec2[] {
  let v = readVertices(r.bag);
  if (v.length > 2) { const a = v[0]!.p, b = v.at(-1)!.p; if (a.x === b.x && a.y === b.y) v = v.slice(0, -1); }
  return flattenVertices(v);
}

export function roomsOf(doc: PcbDocument): Room[] {
  const out: Room[] = [];
  doc.rules.forEach((r, i) => {
    if (!isRoom(r)) return;
    const outline = roomOutline(r);
    if (outline.length < 3) return;
    out.push({
      rule: i, name: r.bag.get('NAME') ?? '', layer: /^bottom/i.test(r.bag.get('LAYER') ?? '') ? L.BOTTOM : L.TOP, outline,
      scope: r.bag.get('SCOPE1EXPRESSION') ?? 'All', confine: /out/i.test(r.bag.get('CONFINEMENTSTYLE') ?? '') ? 'ConfineOut' : 'ConfineIn',
      lockComponents: r.bag.bool('LOCKCOMPONENTS'), enabled: ruleEnabled(r),
    });
  });
  return out;
}

/** A rule with a new outline (straight edges). */
export function withOutline(r: PcbRule, outline: Vec2[]): PcbRule {
  const n = cloneRule(r);
  writeVertices(n.bag, outline.map((p) => ({ p: { x: Math.round(p.x), y: Math.round(p.y) } })));
  return n;
}

/** A new room as AD17 writes one. */
export function newRoom(rules: PcbRule[], o: { name?: string; layer?: LayerId; outline: Vec2[]; scope?: string; confine?: Room['confine'] }): PcbRule {
  const name = o.name ?? nextRuleName(rules, 'RoomDefinition');
  const prio = rules.filter(isRoom).length + 1;
  const r = newRule('RoomDefinition', name, prio);
  r.bag.set('LAYER', o.layer === L.BOTTOM ? 'BOTTOM' : 'TOP');
  r.bag.set('NETSCOPE', 'AnyNet'); r.bag.set('LAYERKIND', 'SameLayer');
  r.bag.set('SCOPE1EXPRESSION', o.scope ?? 'All'); r.bag.set('SCOPE2EXPRESSION', 'All');
  writeVertices(r.bag, o.outline.map((p) => ({ p: { x: Math.round(p.x), y: Math.round(p.y) } })));
  r.bag.set('CONFINEMENTSTYLE', o.confine ?? 'ConfineIn'); r.bag.set('FORMATCOPY', 'TRUE'); r.bag.set('LOCKCOMPONENTS', 'FALSE');
  return r;
}

/** One undo step: rules replaced at the given indices, new rules added at the end, rules removed. */
export function editRooms(doc: PcbDocument, o: { set?: Map<number, PcbRule>; add?: PcbRule[]; remove?: Set<number> }): Change {
  const rules = [...doc.rules.map((r, i) => o.set?.get(i) ?? r).filter((_, i) => !o.remove?.has(i)), ...(o.add ?? [])];
  const before = doc.rules, inFile = doc.rulesInFile, wasDirty = doc.dirty.has('Rules6');
  return {
    apply() { doc.rules = rules; doc.rulesInFile = true; doc.dirty.add('Rules6'); },
    revert() { doc.rules = before; doc.rulesInFile = inFile; if (!wasDirty) doc.dirty.delete('Rules6'); },
  };
}

/* ── components and their extents ── */

/** The area a component covers (its copper, outlines and bodies; not its designator and comment). */
export function componentExtent(doc: PcbDocument, c: number): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number, r = 0) => { minX = Math.min(minX, x - r); minY = Math.min(minY, y - r); maxX = Math.max(maxX, x + r); maxY = Math.max(maxY, y + r); };
  for (const p of doc.prims) {
    if (!('component' in p) || p.component !== c) continue;
    switch (p.kind) {
      case 'pad': { const r = Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2; add(p.at.x, p.at.y, r); break; }
      case 'track': add(p.a.x, p.a.y, p.width / 2); add(p.b.x, p.b.y, p.width / 2); break;
      case 'arc': add(p.c.x, p.c.y, p.r + p.width / 2); break;
      case 'fill': add(p.a.x, p.a.y); add(p.b.x, p.b.y); break;
      case 'region': case 'body': for (const q of p.outline) add(q.x, q.y); break;
      default: break;
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}
const corners = (b: BBox): Vec2[] => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

/** Whether a component lies wholly inside an outline (touching the edge counts as inside). */
export function insideOutline(b: BBox, outline: Vec2[]): boolean {
  const shrink = 2;
  return corners({ minX: b.minX + shrink, minY: b.minY + shrink, maxX: b.maxX - shrink, maxY: b.maxY - shrink }).every((q) => pointInPoly(q, outline));
}
export function overlapsOutline(b: BBox, outline: Vec2[]): boolean {
  return corners(b).some((q) => pointInPoly(q, outline)) || outline.some((q) => q.x > b.minX && q.x < b.maxX && q.y > b.minY && q.y < b.maxY);
}

/** Components on the room's side wholly inside it. */
export function componentsIn(doc: PcbDocument, room: Room): number[] {
  return doc.components.map((comp, i) => ({ comp, i })).filter(({ comp, i }) => {
    if ((comp.layer === L.BOTTOM) !== (room.layer === L.BOTTOM)) return false;
    const b = componentExtent(doc, i);
    return !!b && insideOutline(b, room.outline);
  }).map(({ i }) => i);
}

/* ── outlines round components ── */

/** An outline round boxes: their bounding rectangle, an orthogonal outline round them, or their convex hull. */
export function wrapOutline(boxes: BBox[], kind: 'rect' | 'ortho' | 'nonortho', margin: number): Vec2[] {
  if (!boxes.length) return [];
  const g = boxes.map((b) => ({ minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin }));
  if (kind === 'rect') {
    const b = { minX: Math.min(...g.map((x) => x.minX)), minY: Math.min(...g.map((x) => x.minY)), maxX: Math.max(...g.map((x) => x.maxX)), maxY: Math.max(...g.map((x) => x.maxY)) };
    return corners(b);
  }
  if (kind === 'nonortho') return convexHull(g.flatMap(corners));
  // Orthogonal: the boxes joined into one outline of right angles
  const paths = g.map((b) => corners(b).map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) })));
  const grow = (ps: ClipperNS.IntPoint[][], d: number) => { const co = new C.ClipperOffset(2, 250); co.AddPaths(ps, C.JoinType.jtSquare, C.EndType.etClosedPolygon); const out: ClipperNS.IntPoint[][] = []; co.Execute(out, d); return out; };
  const union = (ps: ClipperNS.IntPoint[][]) => { const c = new C.Clipper(); c.AddPaths(ps, C.PolyType.ptSubject, true); const u: ClipperNS.IntPoint[][] = []; c.Execute(C.ClipType.ctUnion, u, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero); return u; };
  const all = { minX: Math.min(...g.map((x) => x.minX)), minY: Math.min(...g.map((x) => x.minY)), maxX: Math.max(...g.map((x) => x.maxX)), maxY: Math.max(...g.map((x) => x.maxY)) };
  const most = Math.hypot(all.maxX - all.minX, all.maxY - all.minY);
  // Gaps between neighbours closed (grown, joined, shrunk back) with as little as joins them all
  let outer: ClipperNS.IntPoint[] | undefined;
  for (let close = Math.max(margin * 4, 500_000); close <= most; close *= 1.5) {
    const back = union(grow(union(grow(paths, close)), -close)).filter((q) => C.Clipper.Orientation(q) && Math.abs(C.Clipper.Area(q)) > 1);
    if (back.length === 1) { outer = back[0]; break; }
  }
  if (!outer) return wrapOutline(boxes, 'rect', margin);
  return outer.map((p) => ({ x: p.X, y: p.Y }));
}

export function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Scope for a room made from components: each by its designator [est]. */
export const scopeFor = (doc: PcbDocument, comps: number[]) => comps.map((c) => `InComponent('${doc.components[c]!.designator}')`).join(' Or ') || 'All';

/** Copper wholly inside a room on its layer side (Un-Route › Room, Select Room Connections). */
export function routingIn(doc: PcbDocument, room: Room): PcbPrim[] {
  const inside = (q: Vec2) => pointInPoly(q, room.outline);
  return doc.prims.filter((p) => {
    if ((p.kind === 'track' || p.kind === 'arc') && p.component === NO_NET && p.polygon === NO_NET && p.net !== NO_NET) {
      const pts = p.kind === 'track' ? [p.a, p.b] : [p.c];
      return pts.every(inside);
    }
    return p.kind === 'via' && p.net !== NO_NET && inside(p.at);
  });
}

/** Room DRC: components of its scope outside a ConfineIn room, or inside a ConfineOut one. */
export function roomViolations(doc: PcbDocument, members: (room: Room) => number[]): { room: Room; component: number }[] {
  const out: { room: Room; component: number }[] = [];
  for (const room of roomsOf(doc)) {
    if (!room.enabled) continue;
    for (const c of members(room)) {
      const comp = doc.components[c];
      if (!comp || (comp.layer === L.BOTTOM) !== (room.layer === L.BOTTOM)) continue;
      const b = componentExtent(doc, c);
      if (!b) continue;
      const bad = room.confine === 'ConfineIn' ? !insideOutline(b, room.outline) : overlapsOutline(b, room.outline);
      if (bad) out.push({ room, component: c });
    }
  }
  return out;
}

