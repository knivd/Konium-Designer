/**
 * The placer that carries a layout plan out (26.192, the Layout Planner's second step). The plan
 * says what belongs together, what sits at which edge and what must be close to which pin; here
 * every part gets its exact place, measured:
 *
 * 1. the parts the plan puts at an edge: against that edge, as far along it as asked (or as near
 *    to that as there is room), turned so their long side runs along the edge and their pads lie
 *    inward (a connector's mouth is on the other side from its pads);
 * 2. each group's main part: at the middle of its zone, or as near to it as there is room;
 * 3. what must be close to a pin or a part, the tightest first and as soon as its target stands:
 *    beside that pin, turned so the pad that joins it faces it; a part whose target is itself to
 *    be placed waits for it, and that target is placed before other parts;
 * 4. the rest of each group, the most connected first: where its connections are shortest, inside
 *    its zone when there is room there;
 * 5. parts in no group: where their connections are shortest, anywhere on the board.
 *
 * Nothing overlaps (half a millimetre between parts on one side, a part with holes takes room on
 * both), everything is inside the outline (0.3 mm from it, the parts at an edge against it) and
 * clear of holes, keepouts and the parts that stay; what must be kept clear has that room round
 * it, and what must be kept apart is, unless there is no place otherwise. Parts turn by quarter
 * turns; a group planned for the other side has its parts flipped onto it. The board is not
 * touched: what comes back are the moves, for one change (pcbEdit, moveComponentsEach).
 */
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import { breathe } from '../core/breathe';
import type { LayoutPlan } from '../ai/jobs';
import { NO_NET, type PcbDocument } from './pcb';
import type { RouteJob } from './autoroute';
import { boxDist, boxGap, edgePoint, partFacts, toPlace, toUnits, type PlanOnBoard, type PlanScope } from './layoutPlan';

export interface PlanMove { index: number; d: Vec2; rot: number; mirror: boolean; flip: boolean }
export interface PlaceResult {
  moves: PlanMove[];
  /** Parts that found no room (they stay where they are). */
  left: string[];
  /** Kept-apart constraints given up for want of room: "A and B". */
  crowded: string[];
  ms: number;
  stopped: boolean;
}
export interface PlaceOptions {
  /** The grid the parts' reference points go on (5 mil). */
  grid?: number;
  /** Room between two parts' areas (0.5 mm), and between a part and the board's edge (0.3 mm). */
  gap?: number; edgeGap?: number;
  job?: RouteJob;
  progress?: (done: number, of: number) => void;
}

interface RelPad { net: number; name: string; x: number; y: number }
/** A part as it could stand: turned by a quarter turn or more, flipped or not; all relative to its reference point. */
interface Pose { rot: number; flip: boolean; box: BBox; pads: RelPad[] }
interface Geo { index: number; name: string; at: Vec2; bottom: boolean; through: boolean; poses: Pose[]; margin: number; group: number }
/** Something that takes room: a placed part, a part that stays, a hole, a keepout. */
interface Taken { box: BBox; top: boolean; bot: boolean; margin: number; comp: number }
interface Stand { box: BBox; pads: { net: number; name: string; at: Vec2 }[] }

const mid = (b: BBox): Vec2 => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
const shift = (b: BBox, d: Vec2): BBox => ({ minX: b.minX + d.x, minY: b.minY + d.y, maxX: b.maxX + d.x, maxY: b.maxY + d.y });
export async function placeByPlan(doc: PcbDocument, plan: LayoutPlan, on: PlanOnBoard, scope: PlanScope, o: PlaceOptions = {}): Promise<PlaceResult> {
  const t0 = Date.now();
  const grid = o.grid ?? 50_000, gap = o.gap ?? toUnits(0.5), edgeGap = o.edgeGap ?? toUnits(0.3);
  const outline = doc.board.outline, frame = on.frame;
  const facts = partFacts(doc);
  const byName = new Map(facts.map((f) => [f.designator.toUpperCase(), f]));
  const find = (d: string) => byName.get(d.toUpperCase());
  const snap = (v: number) => Math.round(v / grid) * grid;

  // The board's pads by part, and how many pins each net has (a net of many pins pulls little: power and ground are everywhere)
  const padsOf = new Map<number, { net: number; name: string; at: Vec2; hole: boolean }[]>();
  const pins = new Map<number, number>();
  for (const p of doc.prims) {
    if (p.kind !== 'pad') continue;
    if (p.net !== NO_NET) pins.set(p.net, (pins.get(p.net) ?? 0) + 1);
    if (p.component !== NO_NET) padsOf.set(p.component, [...(padsOf.get(p.component) ?? []), { net: p.net, name: p.name, at: p.at, hole: p.hole > 0 }]);
  }
  const pull = (net: number) => { const n = pins.get(net) ?? 0; return n <= 1 ? 0 : n <= 4 ? 1 : n <= 10 ? 0.5 : 0.08; };

  // Which group each part is in, the side that group is planned for, and the room a part must have round it
  const groupOf = new Map<number, number>(), sideOf = new Map<number, boolean>();
  plan.groups.forEach((g, k) => { for (const d of g.parts) { const f = find(d); if (f && !groupOf.has(f.index)) { groupOf.set(f.index, k); sideOf.set(f.index, g.side === 'bottom'); } } });
  const clearOf = new Map<number, number>();
  for (const c of plan.clear) { const f = find(c.part); if (f) clearOf.set(f.index, toUnits(c.mm)); }
  const apartOf = new Map<number, { other: number; d: number; what: string }[]>();
  for (const a of plan.apart) {
    const p = find(a.a), q = find(a.b);
    if (!p || !q) continue;
    const what = `${p.designator} and ${q.designator}`;
    apartOf.set(p.index, [...(apartOf.get(p.index) ?? []), { other: q.index, d: toUnits(a.mm), what }]);
    apartOf.set(q.index, [...(apartOf.get(q.index) ?? []), { other: p.index, d: toUnits(a.mm), what }]);
  }

  // The parts to place, each with the ways it could stand
  const geos = new Map<number, Geo>();
  for (const f of facts) {
    if (!f.box || !f.designator || !toPlace(f, scope)) continue;
    const comp = doc.components[f.index]!, own = padsOf.get(f.index) ?? [];
    const rel: BBox = shift(f.box, { x: -comp.at.x, y: -comp.at.y });
    const pads: RelPad[] = own.map((p) => ({ net: p.net, name: p.name, x: p.at.x - comp.at.x, y: p.at.y - comp.at.y }));
    const flip = sideOf.has(f.index) && sideOf.get(f.index)! !== f.bottom;
    const poses: Pose[] = [0, 90, 180, 270].map((rot) => {
      const turn = (x: number, y: number): [number, number] => { const mx = flip ? -x : x; return rot === 0 ? [mx, y] : rot === 90 ? [-y, mx] : rot === 180 ? [-mx, -y] : [y, -mx]; };
      const cs = [turn(rel.minX, rel.minY), turn(rel.maxX, rel.maxY)];
      return {
        rot, flip,
        box: { minX: Math.min(cs[0]![0], cs[1]![0]), minY: Math.min(cs[0]![1], cs[1]![1]), maxX: Math.max(cs[0]![0], cs[1]![0]), maxY: Math.max(cs[0]![1], cs[1]![1]) },
        pads: pads.map((p) => { const [x, y] = turn(p.x, p.y); return { net: p.net, name: p.name, x, y }; }),
      };
    });
    geos.set(f.index, { index: f.index, name: f.designator, at: comp.at, bottom: flip ? !f.bottom : f.bottom, through: own.some((p) => p.hole), poses, margin: clearOf.get(f.index) ?? 0, group: groupOf.get(f.index) ?? -1 });
  }

  // What already takes room: the parts that stay, the holes that belong to no part, the keepouts
  const taken: Taken[] = [], stand = new Map<number, Stand>(), netPads = new Map<number, Vec2[]>();
  const settle = (comp: number, box: BBox, pads: Stand['pads'], top: boolean, bot: boolean, margin: number) => {
    taken.push({ box, top, bot, margin, comp });
    stand.set(comp, { box, pads });
    for (const p of pads) if (p.net !== NO_NET) netPads.set(p.net, [...(netPads.get(p.net) ?? []), p.at]);
  };
  for (const f of facts) {
    if (geos.has(f.index) || !f.box) continue;
    const own = padsOf.get(f.index) ?? [], through = own.some((p) => p.hole);
    settle(f.index, f.box, own.map((p) => ({ net: p.net, name: p.name, at: p.at })), through || !f.bottom, through || f.bottom, clearOf.get(f.index) ?? 0);
  }
  for (const p of doc.prims) {
    if (p.kind === 'pad' && p.component === NO_NET) {
      const r = Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h, p.hole) / 2;
      taken.push({ box: { minX: p.at.x - r, minY: p.at.y - r, maxX: p.at.x + r, maxY: p.at.y + r }, top: true, bot: true, margin: 0, comp: -1 });
      if (p.net !== NO_NET) netPads.set(p.net, [...(netPads.get(p.net) ?? []), p.at]);
    } else if ('keepout' in p && p.keepout && !('component' in p && p.component !== NO_NET)) {
      const pts = p.kind === 'fill' || p.kind === 'track' ? [p.a, p.b] : p.kind === 'region' ? p.outline : p.kind === 'arc' ? [{ x: p.c.x - p.r, y: p.c.y - p.r }, { x: p.c.x + p.r, y: p.c.y + p.r }] : [];
      if (pts.length < 2) continue;
      const box = { minX: Math.min(...pts.map((q) => q.x)), minY: Math.min(...pts.map((q) => q.y)), maxX: Math.max(...pts.map((q) => q.x)), maxY: Math.max(...pts.map((q) => q.y)) };
      // (a keepout that rings the board, as an outline drawn on the keepout layer does, is not an area to stay out of)
      if (box.maxX - box.minX > 0.9 * (frame.maxX - frame.minX) && box.maxY - box.minY > 0.9 * (frame.maxY - frame.minY)) continue;
      taken.push({ box, top: true, bot: true, margin: 0, comp: -1 });
    }
  }

  /** Inside the outline with `inset` to spare all round (its corners and the middles of its sides). */
  const onBoard = (b: BBox, inset: number) => {
    const x0 = b.minX - inset, y0 = b.minY - inset, x1 = b.maxX + inset, y1 = b.maxY + inset, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [xm, y0], [xm, y1], [x0, ym], [x1, ym]].every(([x, y]) => pointInPoly({ x: x!, y: y! }, outline));
  };
  const crowded = new Set<string>();
  /** Free of everything placed, and far enough from what it must be kept apart from (unless that is waived). */
  const free = (g: Geo, b: BBox, strict: boolean) => {
    const top = g.through || !g.bottom, bot = g.through || g.bottom;
    for (const t of taken) {
      if (!((t.top && top) || (t.bot && bot))) continue;
      const m = gap + Math.max(t.margin, g.margin);
      if (b.minX < t.box.maxX + m && b.maxX + m > t.box.minX && b.minY < t.box.maxY + m && b.maxY + m > t.box.minY) return false;
    }
    if (strict) for (const a of apartOf.get(g.index) ?? []) { const s = stand.get(a.other); if (s && boxGap(b, s.box) < a.d) return false; }
    return true;
  };
  /** What a part's connections come to where it would stand: each pad to the nearest placed pad of its net, weighed by the net. */
  const wires = (pose: Pose, at: Vec2) => {
    let sum = 0;
    for (const p of pose.pads) {
      const w = p.net === NO_NET ? 0 : pull(p.net), others = w ? netPads.get(p.net) : undefined;
      if (!others?.length) continue;
      let d = Infinity;
      for (const q of others) d = Math.min(d, Math.hypot(q.x - (at.x + p.x), q.y - (at.y + p.y)));
      sum += d * w;
    }
    return sum;
  };

  interface Found { at: Vec2; pose: Pose; box: BBox; score: number }
  /**
   * The best free place for a part round a point: rings of places further and further out, on a
   * lattice of half the part's lesser side, each way it could stand; the first ring that has a
   * free place gives the best of its places, tried again round it on the grid itself.
   * `cost` is what a place costs beyond its distance (lower is better).
   */
  const seek = (g: Geo, around: Vec2, cost: (pose: Pose, at: Vec2, box: BBox) => number, poses = g.poses, inset = edgeGap, reach = Infinity): Found | null => {
    const small = Math.min(...g.poses.map((p) => Math.min(p.box.maxX - p.box.minX, p.box.maxY - p.box.minY)));
    const step = Math.max(grid, Math.round(Math.min(toUnits(1), small / 2) / grid) * grid);
    const far = Math.min(reach, Math.hypot(frame.maxX - frame.minX, frame.maxY - frame.minY));
    for (const strict of [true, false]) {
      if (!strict && !(apartOf.get(g.index)?.length)) break;
      const hold: { best: Found | null } = { best: null };
      const tryAt = (pose: Pose, cx: number, cy: number) => {
        if (cx < frame.minX || cx > frame.maxX || cy < frame.minY || cy > frame.maxY) return;
        const c = mid(pose.box), at = { x: snap(cx - c.x), y: snap(cy - c.y) }, box = shift(pose.box, at);
        if (!onBoard(box, inset) || !free(g, box, strict)) return;
        const m = mid(box), score = Math.hypot(m.x - around.x, m.y - around.y) + cost(pose, at, box);
        if (!hold.best || score < hold.best.score) hold.best = { at, pose, box, score };
      };
      let found = -1;
      for (let ring = 0; ring * step <= far + step; ring++) {
        for (const pose of poses) {
          if (ring === 0) { tryAt(pose, around.x, around.y); continue; }
          const r = ring * step;
          for (let k = -ring; k <= ring; k++) { tryAt(pose, around.x + k * step, around.y - r); tryAt(pose, around.x + k * step, around.y + r); }
          for (let k = -ring + 1; k < ring; k++) { tryAt(pose, around.x - r, around.y + k * step); tryAt(pose, around.x + r, around.y + k * step); }
        }
        // Two rings more than the first that had room: a place a little further may still be the better one
        if (hold.best && found < 0) found = ring;
        if (found >= 0 && ring >= found + 2) break;
      }
      const got = hold.best;
      if (!got) continue;
      // Round the best, on the grid itself
      const c0 = mid(got.box), n = Math.round(step / grid);
      if (n > 1) for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) tryAt(got.pose, c0.x + i * grid, c0.y + j * grid);
      const best = hold.best!;
      if (!strict) for (const a of apartOf.get(g.index) ?? []) { const s = stand.get(a.other); if (s && boxGap(best.box, s.box) < a.d) crowded.add(a.what); }
      return best;
    }
    return null;
  };

  const moves: PlanMove[] = [], left: string[] = [];
  const todo = new Set(geos.keys());
  let done = 0, stopped = false;
  const total = todo.size;
  const put = (g: Geo, f: Found | null) => {
    todo.delete(g.index);
    done++;
    if (!f) { left.push(g.name); return; }
    moves.push({ index: g.index, d: { x: f.at.x - g.at.x, y: f.at.y - g.at.y }, rot: f.pose.rot, mirror: f.pose.flip, flip: f.pose.flip });
    settle(g.index, f.box, f.pose.pads.map((p) => ({ net: p.net, name: p.name, at: { x: f.at.x + p.x, y: f.at.y + p.y } })), g.through || !g.bottom, g.through || g.bottom, g.margin);
  };
  const pause = async () => {
    o.progress?.(done, total);
    await breathe();
    while (o.job?.paused && !o.job.cancelled) await new Promise((r) => setTimeout(r, 100));
    if (o.job?.cancelled) stopped = true;
    return stopped;
  };
  /** A little against turning a part from how it stands, so that equal places keep it as it is. */
  const turned = (pose: Pose) => (pose.rot ? grid / 10 : 0);
  const zoneOf = (g: Geo) => on.zones.find((z) => z.group === g.group);
  /** How far outside its group's zone a place is, counted double. */
  const astray = (g: Geo, box: BBox) => { const z = zoneOf(g); return z ? 2 * boxDist(z.box, mid(box)) : 0; };

  // 1. The parts at the edges
  for (const e of plan.edges) {
    const f = find(e.part), g = f ? geos.get(f.index) : undefined;
    if (!g || !todo.has(g.index)) continue;
    if (await pause()) break;
    const upright = e.edge === 'left' || e.edge === 'right';
    // Inward from that edge
    const nx = e.edge === 'left' ? 1 : e.edge === 'right' ? -1 : 0, ny = e.edge === 'bottom' ? 1 : e.edge === 'top' ? -1 : 0;
    const liking = (pose: Pose) => {
      const w = pose.box.maxX - pose.box.minX, h = pose.box.maxY - pose.box.minY, along = upright ? h : w, deep = upright ? w : h;
      const c = mid(pose.box), n = pose.pads.length || 1;
      const px = pose.pads.reduce((s, p) => s + p.x, 0) / n - c.x, py = pose.pads.reduce((s, p) => s + p.y, 0) / n - c.y;
      const inward = (px * nx + py * ny) / Math.max(1, deep);
      // Its long side along the edge (unless it is nearly square), its pads inward (unless they are in its middle)
      return (along < deep * 0.95 ? 1 : 0) + (inward < -0.08 ? 2 : 0);
    };
    const least = Math.min(...g.poses.map(liking));
    const poses = g.poses.filter((p) => liking(p) === least);
    const want = edgePoint(frame, e.edge, e.along);
    // Against the edge: slid along it from where the plan put it, and a little inward where the outline is not straight there
    const tol = 2000;
    let best: Found | null = null;
    const span = upright ? frame.maxY - frame.minY : frame.maxX - frame.minX;
    const slide = Math.max(grid, Math.round(toUnits(0.5) / grid) * grid);
    for (const strict of [true, false]) {
      for (let k = 0; k * slide <= span && !best; k++) {
        for (const sign of k ? [1, -1] : [1]) {
          for (const pose of poses) {
            for (let inn = 0; inn <= 12 && !best; inn++) {
              const c = mid(pose.box), w = pose.box.maxX - pose.box.minX, h = pose.box.maxY - pose.box.minY;
              const depth = inn * slide + tol;
              const cx = upright ? (e.edge === 'left' ? frame.minX + w / 2 + depth : frame.maxX - w / 2 - depth) : want.x + sign * k * slide;
              const cy = upright ? want.y + sign * k * slide : (e.edge === 'bottom' ? frame.minY + h / 2 + depth : frame.maxY - h / 2 - depth);
              // (against the edge exactly: its own coordinate is not put on the grid, the other is)
              const at = { x: upright ? cx - c.x : snap(cx - c.x), y: upright ? snap(cy - c.y) : cy - c.y }, box = shift(pose.box, at);
              if (!onBoard(box, -tol / 2) || !free(g, box, strict)) continue;
              best = { at, pose, box, score: 0 };
            }
          }
        }
      }
      if (best || !(apartOf.get(g.index)?.length)) break;
    }
    put(g, best);
  }

  // 2. Each group's main part, at the middle of its zone
  if (!stopped) for (const z of [...on.zones].sort((a, b) => (a.held ? 0 : 1) - (b.held ? 0 : 1) || b.placing.length - a.placing.length)) {
    const f = find(plan.groups[z.group]!.main), g = f ? geos.get(f.index) : undefined;
    if (!g || !todo.has(g.index)) continue;
    if (await pause()) break;
    put(g, seek(g, mid(z.box), (pose, at) => 0.25 * wires(pose, at) + turned(pose)));
  }

  // 3 to 5. What must be close to a pin or a part goes beside it as soon as its target stands, the tightest first;
  // between those, the rest: the most connected to what stands first, where its connections are shortest (in its
  // zone when there is room), a part that others must be close to before the others, the parts of no group last
  const nears = plan.near.map((n) => {
    const f = find(n.part), whole = find(n.to), dash = n.to.lastIndexOf('-'), owner = whole ?? (dash > 0 ? find(n.to.slice(0, dash)) : undefined);
    return { g: f ? geos.get(f.index) : undefined, owner: owner?.index ?? -1, pin: whole ? '' : n.to.slice(dash + 1).toUpperCase(), mm: n.mm };
  }).filter((n) => n.g && n.owner >= 0 && n.owner !== n.g.index).sort((a, b) => a.mm - b.mm);
  const ties = (g: Geo) => g.poses[0]!.pads.reduce((s, p) => s + (p.net !== NO_NET && netPads.has(p.net) ? pull(p.net) : 0), 0);
  while (todo.size && !stopped) {
    if (await pause()) break;
    const ready = nears.find((n) => todo.has(n.g!.index) && stand.has(n.owner));
    if (ready) {
      const g = ready.g!, s = stand.get(ready.owner)!;
      const pad = ready.pin ? s.pads.find((p) => p.name.toUpperCase() === ready.pin) : undefined;
      const target = pad ? pad.at : mid(s.box);
      // To its pad on the pin's net when it has one, else from its area to the pin or to the part's area
      const dist = (pose: Pose, at: Vec2, box: BBox) => {
        if (pad && pad.net !== NO_NET) { const own = pose.pads.filter((p) => p.net === pad.net); if (own.length) return Math.min(...own.map((p) => Math.hypot(at.x + p.x - pad.at.x, at.y + p.y - pad.at.y))); }
        return pad ? boxDist(box, pad.at) : boxGap(box, s.box);
      };
      put(g, seek(g, target, (pose, at, box) => 4 * dist(pose, at, box) + 0.5 * wires(pose, at) + turned(pose)));
      continue;
    }
    // A part that waits for its target (still to be placed) is not placed before it; a part others wait for goes first
    const waits = new Set(nears.filter((n) => todo.has(n.g!.index) && todo.has(n.owner)).map((n) => n.g!.index));
    const awaited = new Set(nears.filter((n) => todo.has(n.g!.index)).map((n) => n.owner));
    const all = [...todo].map((i) => geos.get(i)!), freeNow = all.filter((x) => !waits.has(x.index));
    const g = (freeNow.length ? freeNow : all).sort((a, b) => (awaited.has(b.index) ? 1 : 0) - (awaited.has(a.index) ? 1 : 0) || (a.group < 0 ? 1 : 0) - (b.group < 0 ? 1 : 0)
      || ties(b) - ties(a) || b.poses[0]!.pads.length - a.poses[0]!.pads.length || a.index - b.index)[0]!;
    // Round the middle of what it joins (the nets of few pins count most), kept inside its zone
    let sx = 0, sy = 0, sw = 0;
    for (const p of g.poses[0]!.pads) {
      const w = p.net === NO_NET ? 0 : pull(p.net), others = w ? netPads.get(p.net) : undefined;
      if (!others?.length) continue;
      for (const q of others) { sx += q.x * w / others.length; sy += q.y * w / others.length; }
      sw += w;
    }
    const z = zoneOf(g), main = z ? stand.get(byName.get(plan.groups[z.group]!.main.toUpperCase())?.index ?? -1) : undefined;
    let around = sw > 0 ? { x: sx / sw, y: sy / sw } : main ? mid(main.box) : z ? mid(z.box) : mid(frame);
    if (z) around = { x: Math.max(z.box.minX, Math.min(z.box.maxX, around.x)), y: Math.max(z.box.minY, Math.min(z.box.maxY, around.y)) };
    put(g, seek(g, around, (pose, at, box) => wires(pose, at) + astray(g, box) + turned(pose)));
  }
  o.progress?.(done, total);
  return { moves, left: [...left, ...[...todo].map((i) => geos.get(i)!.name)], crowded: [...crowded], ms: Date.now() - t0, stopped };
}
