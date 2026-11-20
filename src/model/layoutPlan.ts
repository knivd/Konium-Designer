/**
 * A layout plan on its board (26.191, the Layout Planner's first step). The plan (src/ai/jobs.ts,
 * LayoutPlan) says what belongs together and roughly where, in words and fractions of the board;
 * here it meets the board's own measures: each part's size, the outline, what is fixed. Each group
 * becomes a zone, a rectangle big enough for its parts (about twice their area) with its middle
 * where the plan put it, at its edge when one of its parts must sit there, round its main part
 * when that is fixed; zones that pile up are moved apart, and all are kept on the board. Nothing
 * is moved by this: the zones are drawn over the board, and can be made rooms (a component class
 * and a Room Definition for each group), which the designer can drag and reshape as any room.
 */
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import type { Change } from '../core/undo';
import type { BoardEdge, LayoutPlan } from '../ai/jobs';
import { L } from './layers';
import { NO_NET, type PcbDocument, type PcbPad } from './pcb';
import { connections } from './drc';
import { classBag, setClasses, withMembers } from './pcbClasses';
import { editRooms, newRoom, roomsOf, withOutline } from './rooms';

/** Document units in a millimetre (1 mil = 10,000 units). */
const MM = 10_000 / 0.0254;
export const toUnits = (mm: number) => mm * MM;

/** What the planner and the zones need to know of a part. */
export interface PartFacts {
  index: number;
  designator: string;
  /** What it covers now (pads, outlines, bodies); null for a part with nothing drawn. */
  box: BBox | null;
  /** Its size at rotation 0: across and up. */
  w: number; h: number;
  pads: number;
  /** Pads with holes. */
  holes: number;
  bottom: boolean;
  locked: boolean;
  /** Its middle is inside the board's outline. */
  onBoard: boolean;
}

/** Every part's facts, in one pass over the board's primitives. */
export function partFacts(doc: PcbDocument): PartFacts[] {
  const boxes = new Map<number, BBox>(), pads = new Map<number, number>(), holes = new Map<number, number>();
  const add = (c: number, x: number, y: number, r = 0) => {
    const b = boxes.get(c);
    if (!b) boxes.set(c, { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r });
    else { b.minX = Math.min(b.minX, x - r); b.minY = Math.min(b.minY, y - r); b.maxX = Math.max(b.maxX, x + r); b.maxY = Math.max(b.maxY, y + r); }
  };
  for (const p of doc.prims) {
    if (!('component' in p) || p.component === NO_NET) continue;
    const c = p.component;
    switch (p.kind) {
      case 'pad':
        add(c, p.at.x, p.at.y, Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2);
        pads.set(c, (pads.get(c) ?? 0) + 1);
        if (p.hole > 0) holes.set(c, (holes.get(c) ?? 0) + 1);
        break;
      case 'track': add(c, p.a.x, p.a.y, p.width / 2); add(c, p.b.x, p.b.y, p.width / 2); break;
      case 'arc': add(c, p.c.x, p.c.y, p.r + p.width / 2); break;
      case 'fill': add(c, p.a.x, p.a.y); add(c, p.b.x, p.b.y); break;
      case 'region': case 'body': for (const q of p.outline) add(c, q.x, q.y); break;
      default: break;
    }
  }
  const outline = doc.board.outline;
  return doc.components.map((comp, i) => {
    const box = boxes.get(i) ?? null;
    const across = box ? box.maxX - box.minX : 0, up = box ? box.maxY - box.minY : 0;
    // Turned a quarter: its size at rotation 0 is the other way round
    const quarter = Math.abs((((comp.rotation % 180) + 180) % 180) - 90) < 1;
    const mid = box ? { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 } : comp.at;
    return {
      index: i, designator: comp.designator, box, w: quarter ? up : across, h: quarter ? across : up,
      pads: pads.get(i) ?? 0, holes: holes.get(i) ?? 0, bottom: comp.layer === L.BOTTOM, locked: comp.bag.bool('LOCKED'),
      onBoard: outline.length >= 3 && pointInPoly(mid, outline),
    };
  });
}

/** The parts a plan is to place: those not locked, or only those not yet on the board. */
export type PlanScope = 'unlocked' | 'outside';
export const toPlace = (f: PartFacts, scope: PlanScope) => !f.locked && (scope === 'unlocked' || !f.onBoard);

/** The outline's bounding box: what a plan's fractions are fractions of. */
export function boardFrame(doc: PcbDocument): BBox | null {
  const o = doc.board.outline;
  if (o.length < 3) return null;
  const xs = o.map((p) => p.x), ys = o.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
/** The outline's area (the shoelace sum). */
export function outlineArea(o: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < o.length; i++) { const p = o[i]!, q = o[(i + 1) % o.length]!; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}
/** A rectangle, to within a mil: four corners on the frame. */
export const isRectangle = (o: Vec2[], f: BBox) => o.length === 4 && o.every((p) => (Math.abs(p.x - f.minX) < 10_000 || Math.abs(p.x - f.maxX) < 10_000) && (Math.abs(p.y - f.minY) < 10_000 || Math.abs(p.y - f.maxY) < 10_000));

/** Room round a part when sizing a zone, and how much of a zone its parts fill. */
const GAP = toUnits(0.5), PACK = 2;
/** The most of the board the zones together may take: above it they are all made smaller. */
const FULL = 0.85;

export interface Zone {
  /** Index in the plan's groups. */
  group: number;
  name: string;
  box: BBox;
  bottom: boolean;
  /** The group's parts on the board (component indices), and those among them the plan is to place. */
  parts: number[];
  placing: number[];
  /** Where it is held: at an edge (it slides along it only), round a fixed main part (it stays), or where the designer put its room. */
  held: 'edge' | 'fixed' | 'room' | null;
  edge?: BoardEdge;
}
/** A part the plan puts at an edge: where along it, and whether it stands against that edge now. */
export interface EdgeMark { part: number; designator: string; edge: BoardEdge; at: Vec2; why: string; placed: boolean; ok: boolean }
/** Two parts to be kept apart: how far apart their areas are as the board stands. */
export interface ApartMark { a: string; b: string; mm: number; why: string; now: number; placed: boolean; ok: boolean }
/**
 * A near constraint found on the board: the part, and the pad or part it is to be near. `now` is
 * the distance as the board stands: to a pin, from the part's nearest pad on that pin's net (from
 * its area when it has none); to a part, between the two parts' areas.
 */
export interface NearMark { part: number; designator: string; to: string; target: Vec2; pad: boolean; mm: number; why: string; now: number; /** The part is on the board (its distance means something). */ placed: boolean; ok: boolean }
export interface PlanOnBoard {
  frame: BBox;
  zones: Zone[];
  edges: EdgeMark[];
  near: NearMark[];
  apart: ApartMark[];
  /** The parts the plan is to place that are not on the board (yet, or for want of room). */
  waiting: string[];
  /** The share of the board's area (one side) the parts to place need with room to route, 0 to 1 and above. */
  fill: number;
  /** The zones were made smaller to fit the board. */
  shrunk: boolean;
  /** Pins a near constraint names that the board doesn't have. */
  missing: string[];
}

const centre = (b: BBox): Vec2 => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
/** How far apart two areas are (0 when they touch or overlap). */
export const boxGap = (a: BBox, b: BBox): number => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
/** How far a point is from an area (0 inside it). */
export const boxDist = (b: BBox, p: Vec2): number => Math.hypot(Math.max(0, b.minX - p.x, p.x - b.maxX), Math.max(0, b.minY - p.y, p.y - b.maxY));
/** Whether a part's area lies against that edge of the board (within half a millimetre of the outline's frame there). */
export function atEdge(box: BBox | null, frame: BBox, edge: BoardEdge): boolean {
  if (!box) return false;
  const tol = toUnits(0.5);
  return edge === 'left' ? Math.abs(box.minX - frame.minX) <= tol : edge === 'right' ? Math.abs(box.maxX - frame.maxX) <= tol
    : edge === 'bottom' ? Math.abs(box.minY - frame.minY) <= tol : Math.abs(box.maxY - frame.maxY) <= tol;
}
const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

/** Where a point so far along an edge is. */
export function edgePoint(f: BBox, edge: BoardEdge, along: number): Vec2 {
  const t = clamp(along, 0, 1);
  if (edge === 'left' || edge === 'right') return { x: edge === 'left' ? f.minX : f.maxX, y: f.minY + t * (f.maxY - f.minY) };
  return { x: f.minX + t * (f.maxX - f.minX), y: edge === 'bottom' ? f.minY : f.maxY };
}

/**
 * The plan on this board: its zones, its edge marks and its near constraints with the distances
 * as the board stands. `scope` says which parts the plan places (the others are fixed). With
 * `rooms`, a group whose room is on the board (Make Rooms made it of this plan, and the designer
 * may have moved or reshaped it since) has that room for its zone.
 */
export function planOnBoard(doc: PcbDocument, plan: LayoutPlan, scope: PlanScope = 'unlocked', o: { rooms?: boolean } = {}): PlanOnBoard | null {
  const frame = boardFrame(doc);
  if (!frame) return null;
  const W = frame.maxX - frame.minX, H = frame.maxY - frame.minY;
  const facts = partFacts(doc);
  const byName = new Map(facts.map((f) => [f.designator.toUpperCase(), f]));
  const find = (d: string) => byName.get(d.toUpperCase());
  const edgeOf = new Map(plan.edges.map((e) => [e.part.toUpperCase(), e]));

  // Each group's zone: its size from its parts, its middle from the plan
  const boardArea = outlineArea(doc.board.outline);
  let need = 0;
  const raw = plan.groups.map((g, k) => {
    const members = g.parts.map(find).filter((f): f is PartFacts => !!f);
    const placing = members.filter((f) => toPlace(f, scope));
    const area = placing.reduce((s, f) => s + (f.w + GAP) * (f.h + GAP), 0) * PACK;
    need += area;
    const main = find(g.main);
    const e = [g.main, ...g.parts].map((d) => edgeOf.get(d.toUpperCase())).find((x) => !!x);
    const fixedMain = main && !toPlace(main, scope) && main.onBoard && main.box ? centre(main.box) : null;
    return { g, k, members, placing, area, e, fixedMain };
  });
  const fill = boardArea > 0 ? need / boardArea : 0;
  const scale = fill > FULL ? FULL / fill : 1;
  // (the rooms count only when they were made of this plan: `rooms`)
  const rooms = new Map((o.rooms ? roomsOf(doc) : []).filter((r) => r.enabled && r.outline.length >= 3).map((r) => [r.name.toLowerCase(), r]));
  const zones: (Zone & { want: Vec2; w: number; h: number })[] = [];
  for (const r of raw) {
    if (!r.members.length) continue;
    // A room of the group's name (Make Rooms made it, and the designer may have moved or reshaped it since): the zone is the room
    const room = rooms.get(roomName(r.g.name).toLowerCase());
    if (room && r.placing.length) {
      const xs = room.outline.map((q) => q.x), ys = room.outline.map((q) => q.y);
      const box = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      zones.push({ group: r.k, name: r.g.name, bottom: r.g.side === 'bottom', parts: r.members.map((f) => f.index), placing: r.placing.map((f) => f.index), held: 'room', box, want: centre(box), w: box.maxX - box.minX, h: box.maxY - box.minY });
      continue;
    }
    // Nothing of it to place: its zone is what its parts on the board cover, where they are
    const stay = r.placing.length ? [] : r.members.filter((f) => f.onBoard && f.box).map((f) => f.box!);
    if (!r.placing.length) {
      if (!stay.length) continue;
      const box = { minX: Math.min(...stay.map((b) => b.minX)) - GAP, minY: Math.min(...stay.map((b) => b.minY)) - GAP, maxX: Math.max(...stay.map((b) => b.maxX)) + GAP, maxY: Math.max(...stay.map((b) => b.maxY)) + GAP };
      zones.push({ group: r.k, name: r.g.name, bottom: r.g.side === 'bottom', parts: r.members.map((f) => f.index), placing: [], held: 'fixed', box, want: centre(box), w: box.maxX - box.minX, h: box.maxY - box.minY });
      continue;
    }
    const area = Math.max(r.area * scale, toUnits(2) * toUnits(2));
    // Square, or wider along its edge; never wider or taller than the board
    let w = Math.sqrt(area), h = w;
    if (r.e) { const along = Math.sqrt(area * 1.6), deep = area / along; if (r.e.edge === 'left' || r.e.edge === 'right') { h = along; w = deep; } else { w = along; h = deep; } }
    if (w > W) { w = W; h = Math.min(H, area / w); }
    if (h > H) { h = H; w = Math.min(W, area / h); }
    let want: Vec2, held: Zone['held'] = null;
    if (r.fixedMain) { want = r.fixedMain; held = 'fixed'; }
    else if (r.e) {
      const p = edgePoint(frame, r.e.edge, r.e.along);
      want = { x: r.e.edge === 'left' ? p.x + w / 2 : r.e.edge === 'right' ? p.x - w / 2 : p.x, y: r.e.edge === 'bottom' ? p.y + h / 2 : r.e.edge === 'top' ? p.y - h / 2 : p.y };
      held = 'edge';
    } else want = { x: frame.minX + r.g.x * W, y: frame.minY + r.g.y * H };
    const c = { x: clamp(want.x, frame.minX + w / 2, frame.maxX - w / 2), y: clamp(want.y, frame.minY + h / 2, frame.maxY - h / 2) };
    zones.push({
      group: r.k, name: r.g.name, bottom: r.g.side === 'bottom', parts: r.members.map((f) => f.index), placing: r.placing.map((f) => f.index), held, ...(r.e && held === 'edge' ? { edge: r.e.edge } : {}),
      box: { minX: c.x - w / 2, minY: c.y - h / 2, maxX: c.x + w / 2, maxY: c.y + h / 2 }, want: c, w, h,
    });
  }
  spread(zones, frame);

  // The parts at the edges, and the near and apart constraints as the board stands
  const edges: EdgeMark[] = [];
  for (const e of plan.edges) { const f = find(e.part); if (f) edges.push({ part: f.index, designator: f.designator, edge: e.edge, at: edgePoint(frame, e.edge, e.along), why: e.why, placed: f.onBoard, ok: f.onBoard && atEdge(f.box, frame, e.edge) }); }
  const padsOf = new Map<number, PcbPad[]>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.component !== NO_NET) padsOf.set(p.component, [...(padsOf.get(p.component) ?? []), p]);
  const boxOf = (f: PartFacts): BBox => f.box ?? { minX: doc.components[f.index]!.at.x, minY: doc.components[f.index]!.at.y, maxX: doc.components[f.index]!.at.x, maxY: doc.components[f.index]!.at.y };
  const near: NearMark[] = [], missing: string[] = [];
  for (const n of plan.near) {
    const f = find(n.part);
    if (!f) continue;
    const whole = find(n.to);
    let now: number, target: Vec2, pad: PcbPad | undefined, there = true;
    if (whole) { target = centre(boxOf(whole)); now = boxGap(boxOf(f), boxOf(whole)); there = whole.onBoard; }
    else {
      const dash = n.to.lastIndexOf('-'), owner = dash > 0 ? find(n.to.slice(0, dash)) : undefined;
      pad = owner ? (padsOf.get(owner.index) ?? []).find((p) => p.name.toUpperCase() === n.to.slice(dash + 1).toUpperCase()) : undefined;
      if (!pad || !owner) { missing.push(n.to); continue; }
      target = pad.at; there = owner.onBoard;
      const own = (padsOf.get(f.index) ?? []).filter((p) => pad!.net !== NO_NET && p.net === pad!.net);
      now = own.length ? Math.min(...own.map((p) => Math.hypot(p.at.x - target.x, p.at.y - target.y))) : boxDist(boxOf(f), target);
    }
    const placed = f.onBoard && there;
    near.push({ part: f.index, designator: f.designator, to: n.to, target, pad: !!pad, mm: n.mm, why: n.why, now, placed, ok: placed && now <= toUnits(n.mm) + 1000 });
  }
  const apart: ApartMark[] = [];
  for (const a of plan.apart) {
    const p = find(a.a), q = find(a.b);
    if (!p || !q) continue;
    const now = boxGap(boxOf(p), boxOf(q)), placed = p.onBoard && q.onBoard;
    apart.push({ a: p.designator, b: q.designator, mm: a.mm, why: a.why, now, placed, ok: placed && now >= toUnits(a.mm) - 1000 });
  }
  const grouped = new Set(plan.groups.flatMap((g) => g.parts.map((d) => d.toUpperCase())));
  const waiting = facts.filter((f) => f.designator && toPlace(f, 'unlocked') && !f.onBoard && (scope === 'unlocked' || scope === 'outside') && (grouped.has(f.designator.toUpperCase()) || plan.ungrouped.includes(f.designator))).map((f) => f.designator);
  return {
    frame, edges, near, apart, waiting, fill, shrunk: scale < 1, missing: [...new Set(missing)],
    zones: zones.map(({ want: _w, w: _a, h: _b, ...z }) => z),
  };
}

/**
 * Zones that overlap are moved apart, a little at a time: each pair along the way they overlap
 * least, each drawn back to where the plan put it, all kept on the board. A zone at an edge slides
 * along it; one round a fixed part stays.
 */
function spread(zones: (Zone & { want: Vec2; w: number; h: number })[], f: BBox): void {
  const at = zones.map((z) => ({ ...z.want }));
  for (let pass = 0; pass < 400; pass++) {
    let moved = 0;
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i]!, b = zones[j]!;
        if (a.bottom !== b.bottom) continue;
        const dx = at[j]!.x - at[i]!.x, dy = at[j]!.y - at[i]!.y;
        const ox = (a.w + b.w) / 2 - Math.abs(dx), oy = (a.h + b.h) / 2 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // Along the way they overlap least; two on one spot go apart across the board's longer side
        const alongX = ox < oy || (ox === oy && f.maxX - f.minX >= f.maxY - f.minY);
        const free = (z: Zone, x: boolean) => z.held === null || (z.held === 'edge' && (x ? z.edge === 'top' || z.edge === 'bottom' : z.edge === 'left' || z.edge === 'right'));
        const fa = free(a, alongX), fb = free(b, alongX);
        if (!fa && !fb) continue;
        const push = (alongX ? ox : oy) * 0.5, sign = (alongX ? dx : dy) >= 0 ? 1 : -1;
        const sa = fa && fb ? 0.5 : fa ? 1 : 0, sb = fa && fb ? 0.5 : fb ? 1 : 0;
        if (alongX) { at[i]!.x -= sign * push * sa; at[j]!.x += sign * push * sb; } else { at[i]!.y -= sign * push * sa; at[j]!.y += sign * push * sb; }
        moved += push;
      }
    }
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]!;
      if (z.held === 'fixed' || z.held === 'room') { at[i] = { ...z.want }; continue; }
      // Drawn back a little to where the plan put it
      const pull = 0.02;
      at[i]!.x += (z.want.x - at[i]!.x) * pull; at[i]!.y += (z.want.y - at[i]!.y) * pull;
      if (z.held === 'edge') { if (z.edge === 'left' || z.edge === 'right') at[i]!.x = z.want.x; else at[i]!.y = z.want.y; }
      at[i]!.x = clamp(at[i]!.x, f.minX + z.w / 2, f.maxX - z.w / 2); at[i]!.y = clamp(at[i]!.y, f.minY + z.h / 2, f.maxY - z.h / 2);
    }
    if (moved < 1000 && pass > 20) break;
  }
  zones.forEach((z, i) => { const c = at[i]!; z.box = { minX: Math.round(c.x - z.w / 2), minY: Math.round(c.y - z.h / 2), maxX: Math.round(c.x + z.w / 2), maxY: Math.round(c.y + z.h / 2) }; });
}

/** A name for a class and a room: no quotes (a scope expression holds it in them), no line breaks, 60 characters. */
export const roomName = (name: string) => name.replace(/['"\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Group';

/**
 * The plan's groups as rooms: for each zone a component class of its parts and a Room Definition
 * over it, scoped to the class, on the group's side. A class or a room of that name already there
 * (an earlier plan's) is brought up to date, not made twice. One change, for one undo step.
 */
export function planRooms(doc: PcbDocument, on: PlanOnBoard): { changes: Change[]; rooms: number; fresh: number } {
  const bags = doc.classes.map((c) => c.bag.clone());
  const rooms = roomsOf(doc);
  const set = new Map<number, ReturnType<typeof newRoom>>(), add: ReturnType<typeof newRoom>[] = [];
  let fresh = 0;
  const rules = [...doc.rules];
  for (const z of on.zones) {
    const name = roomName(z.name);
    const members = z.parts.map((i) => doc.components[i]!.designator).filter(Boolean);
    const had = doc.classes.findIndex((c) => c.kind === 1 && !c.superClass && c.name.toLowerCase() === name.toLowerCase());
    if (had >= 0) bags[had] = withMembers(bags[had]!, members); else bags.push(classBag(name, 1, members));
    const outline: Vec2[] = [{ x: z.box.minX, y: z.box.minY }, { x: z.box.maxX, y: z.box.minY }, { x: z.box.maxX, y: z.box.maxY }, { x: z.box.minX, y: z.box.maxY }];
    const old = rooms.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (old) {
      const r = withOutline(doc.rules[old.rule]!, outline);
      r.bag.set('LAYER', z.bottom ? 'BOTTOM' : 'TOP'); r.bag.set('SCOPE1EXPRESSION', `InComponentClass('${name}')`);
      set.set(old.rule, r);
    } else {
      const r = newRoom(rules, { name, layer: z.bottom ? L.BOTTOM : L.TOP, outline, scope: `InComponentClass('${name}')` });
      rules.push(r); add.push(r); fresh++;
    }
  }
  return { changes: [setClasses(doc, bags), editRooms(doc, { set, add })], rooms: on.zones.length, fresh };
}

/** The plan as text: for the clipboard, and for a second round (what the model is shown of the plan made before). */
export function planText(plan: LayoutPlan): string {
  const lines: string[] = [];
  if (plan.summary) lines.push(plan.summary, '');
  lines.push('Groups:');
  for (const g of plan.groups) lines.push(`- ${g.name} (${g.side}, middle at ${Math.round(g.x * 100)}% across, ${Math.round(g.y * 100)}% up; round ${g.main}): ${g.parts.join(', ')}${g.why ? `. ${g.why}` : ''}`);
  const edgeWords = (e: { edge: BoardEdge; along: number }) => `${e.edge} edge, ${Math.round(e.along * 100)}% along`;
  if (plan.edges.length) lines.push('', 'At the edges:', ...plan.edges.map((e) => `- ${e.part}: ${edgeWords(e)}${e.why ? `. ${e.why}` : ''}`));
  if (plan.near.length) lines.push('', 'Close together:', ...plan.near.map((n) => `- ${n.part} within ${n.mm} mm of ${n.to}${n.why ? `. ${n.why}` : ''}`));
  if (plan.apart.length) lines.push('', 'Kept apart:', ...plan.apart.map((a) => `- ${a.a} and ${a.b} at least ${a.mm} mm${a.why ? `. ${a.why}` : ''}`));
  if (plan.clear.length) lines.push('', 'Kept clear:', ...plan.clear.map((c) => `- ${c.part}: ${c.mm} mm round it${c.why ? `. ${c.why}` : ''}`));
  if (plan.notes.length) lines.push('', 'Notes:', ...plan.notes.map((n) => `- ${n}`));
  return lines.join('\n');
}

/** The total of the board's connection lines, in millimetres (what is not yet routed, as the crow flies). */
export function connectionLength(doc: PcbDocument): number {
  return connections(doc).reduce((s, c) => s + Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y), 0) / MM;
}

/**
 * What came of a plan on the board, as text: for the model on a second round (and the clipboard).
 * What was met is counted; what was not is listed with its measure.
 */
export function resultText(on: PlanOnBoard, o: { left?: string[]; crowded?: string[]; length?: number } = {}): string {
  const mm1 = (v: number) => Math.round((v / MM) * 10) / 10;
  const lines: string[] = [];
  const waiting = o.left?.length ? o.left : on.waiting;
  lines.push(waiting.length ? `Not placed, for want of room: ${waiting.join(', ')}.` : 'Every part is placed.');
  const edges = on.edges.filter((e) => e.placed), near = on.near.filter((n) => n.placed), apart = on.apart.filter((a) => a.placed);
  if (edges.length) lines.push(`At their edges: ${edges.filter((e) => e.ok).length} of ${edges.length}.`);
  if (near.length) lines.push(`Close enough: ${near.filter((n) => n.ok).length} of ${near.length}.`);
  if (apart.length) lines.push(`Far enough apart: ${apart.filter((a) => a.ok).length} of ${apart.length}.`);
  const not = [
    ...edges.filter((e) => !e.ok).map((e) => `- ${e.designator} is not against the ${e.edge} edge`),
    ...near.filter((n) => !n.ok).map((n) => `- ${n.designator} is ${mm1(n.now)} mm from ${n.to} (${n.mm} mm asked)`),
    ...apart.filter((a) => !a.ok).map((a) => `- ${a.a} and ${a.b} are ${mm1(a.now)} mm apart (${a.mm} mm asked)`),
    ...on.missing.map((m) => `- ${m}: the board has no such pin`),
  ];
  if (not.length) lines.push('Not met:', ...not);
  if (on.shrunk) lines.push(`With room to route, the parts need about ${Math.round(on.fill * 100)}% of the board's area on one side.`);
  if (o.length !== undefined) lines.push(`The connections' total length is ${Math.round(o.length)} mm.`);
  return lines.join('\n');
}
