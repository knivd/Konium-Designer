/**
 * Interactive routing geometry: the obstacles a route meets on one copper layer and the conflict
 * resolution modes of Route › Interactive Routing (AD17's Routing Conflict Resolution):
 * - Walkaround Obstacles: a path from the route's head to the cursor that goes round everything
 *   of another net at the clearance the rules ask for. A search on a grid (8 directions for the
 *   45° corner modes, 4 for 90°) finds the way; the path is then pulled tight with exact checks
 *   (connectors of one or two 45° / 90° segments) and its segments slid against the obstacles
 *   until they touch the clearance, so the route hugs what it passes.
 * - Push Obstacles / Hug And Push Obstacles: free tracks of other nets (not locked, not part of a
 *   component or pour) are movable. Each line a route runs into (a chain of tracks between pads,
 *   vias or branches) has the stretch that collides walked round the route at clearance, its
 *   ends kept; a pushed line that runs into another pushes that one in turn.
 * - The obstacles: pads (each layer's shape), vias, holes, tracks, arcs, fills and regions of
 *   other nets, keep-outs on this layer or the Keep-Out layer, and the board's edge (Board
 *   Outline Clearance when the board has one). Polygon pours are left out: they pour round new
 *   copper. Each gap comes from the Clearance rule between the route and that object.
 */
import RBush from 'rbush';
import * as ClipperNS from 'clipper-lib';
import { arcChords, arcPoints, distToSegment, rotate, type BBox, type Vec2 } from '../core/geom';
import { boardIndex, clearanceGap, distance, type Geom } from './drc';
import { L, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim, type PcbTrack } from './pcb';
import { ruleEnabled, ruleKind, ruleLength } from '../formats/altium/rules';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;

/** Kept clear of the clearance by this much (a hundredth of a mil), so rounding never violates it. */
const EPS = 100;

export type ItemKind = 'track' | 'arc' | 'pad' | 'via' | 'fill' | 'region' | 'hole' | 'edge' | 'keepout' | 'route' | 'barrier';
export interface RItem extends BBox {
  id: number;
  g: Geom;
  net: number;
  kind: ItemKind;
  /** Index in doc.prims, or -1 for copper the routing session added. */
  prim: number;
  /** A free track of its net that Push may move. */
  movable: boolean;
  /** Tracks: the centre line and width. */
  seg?: { a: Vec2; b: Vec2; width: number };
  /** Pending tracks (pushed earlier in this route): their index in the pending list. */
  vid?: number;
}

/** A track the session holds before it reaches the board (a pushed line's new segments, the route so far). */
export interface VTrack { layer: LayerId; a: Vec2; b: Vec2; width: number; net: number }
export interface VVia { at: Vec2; diameter: number; hole: number; net: number }
/** What routing has changed so far: board tracks moved away, and the tracks that replace them. */
/**
 * What a routing session has moved before it reaches the board: tracks taken away (pushed lines'
 * old segments), their new segments, vias pushed (their prim and new place) and the ends of the
 * tracks a pushed via drags with it (on every layer).
 */
export interface Pending { removed: Set<number>; tracks: VTrack[]; vias: Map<number, Vec2>; ends: Map<number, { a: Vec2; b: Vec2 }> }
export const noPending = (): Pending => ({ removed: new Set(), tracks: [], vias: new Map(), ends: new Map() });
export const clonePending = (p: Pending): Pending => ({ removed: new Set(p.removed), tracks: [...p.tracks], vias: new Map(p.vias), ends: new Map(p.ends) });

const boxOf = (g: Geom): BBox => {
  if (g.t === 'circle') return { minX: g.c.x - g.r, minY: g.c.y - g.r, maxX: g.c.x + g.r, maxY: g.c.y + g.r };
  if (g.t === 'seg') return { minX: Math.min(g.a.x, g.b.x) - g.r, minY: Math.min(g.a.y, g.b.y) - g.r, maxX: Math.max(g.a.x, g.b.x) + g.r, maxY: Math.max(g.a.y, g.b.y) + g.r };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of g.pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
};
const grow = (b: BBox, d: number): BBox => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d });
const boxPts = (pts: Vec2[], d = 0): BBox => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return grow({ minX, minY, maxX, maxY }, d);
};
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

const probeTrack = (net: number, layer: LayerId, width = 0): PcbTrack => ({
  kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, width, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false,
});

/** The obstacles on one copper layer, for one routing session. */
export class RouteWorld {
  readonly items: RItem[] = [];
  readonly tree = new RBush<RItem>();
  /** The largest gap any rule asks for (how far to look round a segment). */
  readonly maxGap: number;
  readonly boardGap: number;
  /** The Hole To Hole Clearance rule's gap (between any two holes, whatever their nets). */
  readonly holeGap: number;
  readonly outline: Vec2[] | null;
  private gaps = new Map<string, number>();
  private probes = new Map<number, PcbTrack>();
  private nextId = 0;

  constructor(readonly doc: PcbDocument, readonly layer: LayerId, readonly pending: Pending = noPending(), fixed: { tracks?: VTrack[]; vias?: VVia[] } = {}) {
    const rules = doc.rules.filter((r) => ruleEnabled(r));
    const gapsOf = (kind: string) => rules.filter((r) => ruleKind(r) === kind).map((r) => ruleLength(r, 'GAP', '10mil'));
    const outlineGaps = gapsOf('BoardOutlineClearance');
    this.boardGap = outlineGaps.length ? Math.max(...outlineGaps) : 0;
    this.maxGap = Math.max(mil(10), ...gapsOf('Clearance'), this.boardGap);
    const h2h = gapsOf('HoleToHoleClearance');
    this.holeGap = h2h.length ? Math.max(...h2h) : 0;
    const add = (it: Omit<RItem, 'id' | keyof BBox>) => { const full = { ...it, id: this.nextId++, ...boxOf(it.g) } as RItem; this.items.push(full); };
    for (const s of boardIndex(doc).all()) {
      if (s.layer !== layer || pending.removed.has(s.prim) || pending.vias.has(s.prim) || pending.ends.has(s.prim)) continue;
      const p = doc.prims[s.prim]!;
      if ('polygon' in p && p.polygon !== NO_NET) continue;
      const movable = p.kind === 'track' && !p.locked && p.component === NO_NET && !p.keepout;
      add({ g: s.g, net: s.net, kind: p.kind as ItemKind, prim: s.prim, movable, seg: p.kind === 'track' ? { a: p.a, b: p.b, width: p.width } : undefined });
    }
    doc.prims.forEach((p, i) => {
      if (pending.removed.has(i)) return;
      // Holes: an obstacle on every layer, whether or not the layer has copper round them
      if ((p.kind === 'pad' || p.kind === 'via') && p.hole > 0) add({ g: { t: 'circle', c: pending.vias.get(i) ?? p.at, r: p.hole / 2 }, net: p.net, kind: 'hole', prim: i, movable: false });
      // A via the session pushed, at its new place; a track it dragged, with its new ends
      if (p.kind === 'via' && pending.vias.has(i)) add({ g: { t: 'circle', c: pending.vias.get(i)!, r: p.diameter / 2 }, net: p.net, kind: 'via', prim: i, movable: false });
      if (p.kind === 'track' && p.layer === layer && pending.ends.has(i)) {
        const e = pending.ends.get(i)!;
        add({ g: { t: 'seg', a: e.a, b: e.b, r: p.width / 2 }, net: p.net, kind: 'track', prim: i, movable: false, seg: { a: e.a, b: e.b, width: p.width } });
      }
      // Keep-outs on this layer or the Keep-Out layer
      if (!(p.kind === 'track' || p.kind === 'arc' || p.kind === 'fill' || p.kind === 'region')) return;
      const on = p.layer === L.KEEPOUT || (p.layer === layer && p.keepout);
      if (!on) return;
      for (const g of keepoutGeoms(p)) add({ g, net: NO_NET, kind: 'keepout', prim: i, movable: false });
    });
    pending.tracks.forEach((t, vid) => {
      if (t.layer !== layer) return;
      add({ g: { t: 'seg', a: t.a, b: t.b, r: t.width / 2 }, net: t.net, kind: 'track', prim: -1, movable: true, seg: { a: t.a, b: t.b, width: t.width }, vid });
    });
    for (const t of fixed.tracks ?? []) if (t.layer === layer) add({ g: { t: 'seg', a: t.a, b: t.b, r: t.width / 2 }, net: t.net, kind: 'route', prim: -1, movable: false, seg: { a: t.a, b: t.b, width: t.width } });
    for (const v of fixed.vias ?? []) add({ g: { t: 'circle', c: v.at, r: v.diameter / 2 }, net: v.net, kind: 'route', prim: -1, movable: false });
    // The board's edge (and cut-outs)
    const o = doc.board.outline;
    this.outline = o && o.length >= 3 ? o : null;
    if (this.outline) for (let i = 0; i < this.outline.length; i++) add({ g: { t: 'seg', a: this.outline[i]!, b: this.outline[(i + 1) % this.outline.length]!, r: 0 }, net: NO_NET, kind: 'edge', prim: -1, movable: false });
    doc.prims.forEach((p, i) => {
      if (p.kind !== 'region' || !p.boardCutout || p.outline.length < 3) return;
      add({ g: { t: 'poly', pts: p.outline, holes: [] }, net: NO_NET, kind: 'edge', prim: i, movable: false });
    });
    this.tree.load(this.items);
  }

  /** An item made for this session only (a pusher, a pushed line's new segment). */
  virtual(t: VTrack, kind: ItemKind = 'route', movable = false): RItem {
    const g: Geom = { t: 'seg', a: t.a, b: t.b, r: t.width / 2 };
    return { id: this.nextId++, g, net: t.net, kind, prim: -1, movable, seg: { a: t.a, b: t.b, width: t.width }, ...boxOf(g) };
  }

  /** A wall a pushed line may not cross (the far side of what pushes it). */
  barrier(pts: Vec2[]): RItem {
    const g: Geom = { t: 'poly', pts, holes: [] };
    return { id: this.nextId++, g, net: NO_NET, kind: 'barrier', prim: -1, movable: false, ...boxOf(g) };
  }

  /** Whether an item stands in the way of copper of `net`. Copper with no net is in the way of every net's copper, and every
   *  net's copper in its way; among itself it is not (as copper of one net is not): a route with no net goes on from what it
   *  has laid, starts from a pad or a track with no net and ends on one, which is how a board with no netlist is drawn. */
  blocks(net: number, it: RItem): boolean {
    return it.kind === 'edge' || it.kind === 'keepout' || it.kind === 'barrier' || it.net !== net;
  }

  /** The Clearance rule's gap between copper of `net` and the item. */
  gap(net: number, it: RItem): number {
    if (it.kind === 'edge') return this.boardGap;
    if (it.kind === 'barrier') return 0;
    const k = `${net}:${it.prim >= 0 ? `p${it.prim}` : `v${it.net}`}`;
    let g = this.gaps.get(k);
    if (g === undefined) {
      let probe = this.probes.get(net);
      if (!probe) { probe = probeTrack(net, this.layer); this.probes.set(net, probe); }
      const other: PcbPrim = it.prim >= 0 ? this.doc.prims[it.prim]! : probeTrack(it.net, this.layer, it.seg?.width ?? 0);
      g = clearanceGap(this.doc, probe, other);
      this.gaps.set(k, g);
    }
    return g;
  }

  /** The first item a segment of `net` and `width` comes too close to, or null. */
  segHit(net: number, width: number, a: Vec2, b: Vec2, o: Look = {}): RItem | null {
    const g: Geom = { t: 'seg', a, b, r: width / 2 };
    const box = grow(boxPts([a, b]), width / 2 + this.maxGap + EPS);
    for (const it of this.tree.search(box)) {
      if (!this.blocks(net, it) || o.skip?.(it)) continue;
      if (distance(g, it.g) < this.gap(net, it) + EPS) return it;
    }
    for (const it of o.extra ?? []) {
      if (!this.blocks(net, it) || it.maxX < box.minX || it.minX > box.maxX || it.maxY < box.minY || it.minY > box.maxY) continue;
      if (distance(g, it.g) < this.gap(net, it) + EPS) return it;
    }
    return null;
  }
  /**
   * Everything a segment of `net` comes nearer to than its gap, with how near (below nothing where
   * they overlap). For copper that is being moved: what it already lies too near to, or at exactly
   * its gap from, where it is now is no obstacle to moving it, as long as it comes no nearer.
   */
  segNear(net: number, width: number, a: Vec2, b: Vec2, o: Look = {}): { it: RItem; d: number }[] {
    const g: Geom = { t: 'seg', a, b, r: width / 2 };
    const box = grow(boxPts([a, b]), width / 2 + this.maxGap + EPS);
    const out: { it: RItem; d: number }[] = [];
    const see = (it: RItem) => {
      if (!this.blocks(net, it) || o.skip?.(it)) return;
      const d = distance(g, it.g);
      if (d < this.gap(net, it) + EPS) out.push({ it, d });
    };
    for (const it of this.tree.search(box)) see(it);
    for (const it of o.extra ?? []) if (!(it.maxX < box.minX || it.minX > box.maxX || it.maxY < box.minY || it.minY > box.maxY)) see(it);
    return out;
  }
  /** Every segment of a polyline clear. */
  clear(net: number, width: number, pts: Vec2[], o: Look = {}): boolean {
    for (let i = 1; i < pts.length; i++) if (this.segHit(net, width, pts[i - 1]!, pts[i]!, o)) return false;
    return true;
  }
  /** A via of `net` clear. */
  viaHit(net: number, at: Vec2, diameter: number, o: Look = {}): RItem | null {
    return this.segHit(net, diameter, at, at, o);
  }

  /** Items in the way within a box (for the clearance boundaries). */
  near(net: number, box: BBox, o: Look = {}): RItem[] {
    return [...this.tree.search(box), ...(o.extra ?? [])].filter((it) => this.blocks(net, it) && !o.skip?.(it));
  }
}

const mil = (n: number) => Math.round(n * 10_000);

function keepoutGeoms(p: PcbPrim): Geom[] {
  if (p.kind === 'track') return [{ t: 'seg', a: p.a, b: p.b, r: p.width / 2 }];
  if (p.kind === 'arc') {
    const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
    const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, arcChords(p.r, sweep));
    return pts.slice(1).map((b, i) => ({ t: 'seg' as const, a: pts[i]!, b, r: p.width / 2 }));
  }
  if (p.kind === 'fill') {
    const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, w = Math.abs(p.b.x - p.a.x), h = Math.abs(p.b.y - p.a.y);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => rotate({ x: c.x + x!, y: c.y + y! }, p.rotation, c));
    return [{ t: 'poly', pts, holes: [] }];
  }
  if (p.kind === 'region' && p.outline.length >= 3) return [{ t: 'poly', pts: p.outline, holes: p.holes }];
  return [];
}

/** What a search or check leaves out (`skip`) or adds (`extra`: pushers, pushed lines). */
export interface Look { skip?: (it: RItem) => boolean; extra?: RItem[] }

/* ─── Paths ─────────────────────────────────────────────────────────────────────────────── */

/** 8: 45° corners; 4: 90°; 0: any angle. */
export type Dirs = 8 | 4 | 0;

/** One- or two-segment connectors from p to q in the corner style (each list ends at q). */
function connectors(p: Vec2, q: Vec2, dirs: Dirs): Vec2[][] {
  const dx = q.x - p.x, dy = q.y - p.y;
  if (dirs === 0 || dx === 0 || dy === 0 || (dirs === 8 && Math.abs(Math.abs(dx) - Math.abs(dy)) < 1)) return [[q]];
  if (dirs === 4) return [[{ x: q.x, y: p.y }, q], [{ x: p.x, y: q.y }, q]];
  const d = Math.min(Math.abs(dx), Math.abs(dy)), diag = { x: Math.sign(dx) * d, y: Math.sign(dy) * d };
  return [[{ x: p.x + diag.x, y: p.y + diag.y }, q], [{ x: q.x - diag.x, y: q.y - diag.y }, q]];
}

/** Drop repeated and collinear points. */
export function simplify(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length && same(out.at(-1)!, p)) continue;
    if (out.length >= 2) {
      const a = out.at(-2)!, b = out.at(-1)!;
      const cr = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dt = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cr) <= 1e-6 * Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(p.x - b.x, p.y - b.y) + 1 && dt > 0) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

export const pathLength = (pts: Vec2[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);

/**
 * Pull a clear path tight: from each point, the furthest later point a clear connector reaches.
 * Points the connectors can't get past stay.
 */
export function pull(w: RouteWorld, net: number, width: number, pts: Vec2[], dirs: Dirs, o: Look = {}): Vec2[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]!];
  let i = 0;
  while (i < pts.length - 1) {
    let done = false;
    for (let j = pts.length - 1; j > i && !done; j--) {
      for (const c of connectors(pts[i]!, pts[j]!, dirs)) {
        const run = [pts[i]!, ...c.map(rnd)];
        if (j === i + 1 || w.clear(net, width, run, o)) {
          // A one-step move keeps the path's own segment when no connector is clear
          if (j === i + 1 && !w.clear(net, width, run, o)) { out.push(pts[j]!); i = j; done = true; break; }
          out.push(...run.slice(1));
          i = j; done = true; break;
        }
      }
    }
  }
  return simplify(out);
}

const DIR8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].map(([x, y]) => { const l = Math.hypot(x!, y!); return { x: x! / l, y: y! / l }; });
/** The 45° direction nearest a vector. */
function dirOf(a: Vec2, b: Vec2): Vec2 {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  return DIR8[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8]!;
}
/** Where the line through p along u meets the line through q along v (null when parallel). */
function meet(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return { x: p.x + u.x * t, y: p.y + u.y * t };
}

/**
 * Slide each inner segment of a 45° / 90° path sideways, keeping its direction and its
 * neighbours', as far as the clearance lets it go the way that shortens the path: segments come
 * to rest touching the clearance of what they pass, as a hugging route does.
 */
export function tighten(w: RouteWorld, net: number, width: number, pts0: Vec2[], o: Look = {}): Vec2[] {
  let pts = simplify(pts0.map(rnd));
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let k = 1; k + 2 < pts.length; k++) {
      const p0 = pts[k - 1]!, a = pts[k]!, b = pts[k + 1]!, p3 = pts[k + 2]!;
      const d0 = dirOf(p0, a), d1 = dirOf(a, b), d2 = dirOf(b, p3);
      const n = { x: -d1.y, y: d1.x };
      const at = (delta: number): [Vec2, Vec2] | null => {
        const base = { x: a.x + n.x * delta, y: a.y + n.y * delta };
        const na = meet(p0, d0, base, d1), nb = meet(p3, d2, base, d1);
        if (!na || !nb) return null;
        // Each of the three segments keeps its direction (no folding back)
        const fwd = (s: Vec2, e: Vec2, d: Vec2) => (e.x - s.x) * d.x + (e.y - s.y) * d.y >= -0.5;
        if (!fwd(p0, na, d0) || !fwd(na, nb, d1) || !fwd(nb, p3, d2)) return null;
        return [na, nb];
      };
      const lenAt = (delta: number) => { const r = at(delta); return r ? pathLength([p0, r[0], r[1], p3]) : Infinity; };
      const base = pathLength([p0, a, b, p3]);
      const sign = lenAt(1000) < base - 1 ? 1 : lenAt(-1000) < base - 1 ? -1 : 0;
      if (!sign) continue;
      const ok = (delta: number) => { const r = at(sign * delta); return !!r && w.clear(net, width, [p0, rnd(r[0]), rnd(r[1]), p3], o); };
      // How far it can go before a neighbour vanishes
      let hi = 1000;
      while (at(sign * hi * 2) && hi < 1e9) hi *= 2;
      hi *= 2;
      let lo = 0;
      if (!ok(1)) continue;
      lo = 1;
      for (let it = 0; it < 40 && hi - lo > 2; it++) {
        const mid = (lo + hi) / 2;
        if (at(sign * mid) && ok(mid)) lo = mid; else hi = mid;
      }
      const r = at(sign * lo);
      if (!r) continue;
      const next = simplify([...pts.slice(0, k), rnd(r[0]), rnd(r[1]), ...pts.slice(k + 2)]);
      if (pathLength(next) < pathLength(pts) - 1 && w.clear(net, width, next.slice(Math.max(0, k - 1), k + 3), o)) { pts = next; moved = true; }
    }
    if (!moved) break;
  }
  return pts;
}

/* ─── Grid search ───────────────────────────────────────────────────────────────────────── */

export interface Found {
  pts: Vec2[];
  /** The path ends at the target (not just near it). */
  reached: boolean;
  /** The search got to its goal (the target, or the free place nearest it); false: as far as it could. */
  complete?: boolean;
}
export interface SearchOptions extends Look {
  dirs: Dirs;
  /** Where the search may go (by default round the two ends with room to detour). */
  window?: BBox;
  /** At most this many cells. */
  cells?: number;
}

/** The search's arrays, kept between searches (one search runs at a time). */
let bufs: { n: number; blocked: Uint8Array; g: Float64Array; came: Int32Array; dirAt: Int8Array; closed: Uint8Array; f: Float64Array } | null = null;
function buffers(n: number) {
  if (!bufs || bufs.n < n) {
    const m = Math.max(n, 1 << 16);
    bufs = { n: m, blocked: new Uint8Array(m), g: new Float64Array(m), came: new Int32Array(m), dirAt: new Int8Array(m), closed: new Uint8Array(m), f: new Float64Array(m) };
  }
  bufs.blocked.fill(0, 0, n); bufs.g.fill(Infinity, 0, n); bufs.came.fill(-1, 0, n); bufs.dirAt.fill(-1, 0, n); bufs.closed.fill(0, 0, n);
  return bufs;
}

/** Distance from a point to a shape's edge (negative inside). */
const pointDist = (g: Geom, p: Vec2) => distance({ t: 'circle', c: p, r: 0 }, g);

/** A search grid: cell (i, j) is centred on (x0 + i·s, y0 + j·s). */
export interface Grid { x0: number; y0: number; nx: number; ny: number; s: number; win: BBox }

/**
 * Mark the cells of a grid a track of `width` and `net` can't have its centre on (2: outside the
 * board, or nearer anything than its gap) or only just (1: within the grid's own slack, passable
 * at a cost), into `blocked` from `base`.
 */
export function rasterize(w: RouteWorld, net: number, width: number, grid: Grid, o: Look, blocked: Uint8Array, base: number): void {
  const { x0, y0, nx, ny, s, win } = grid;
  const cx = (i: number) => x0 + i * s, cy = (j: number) => y0 + j * s;
  // The board's outside, row by row
  if (w.outline) {
    const o2 = w.outline;
    for (let j = 0; j < ny; j++) {
      const y = cy(j), xs: number[] = [];
      for (let k = 0; k < o2.length; k++) {
        const a = o2[k]!, b = o2[(k + 1) % o2.length]!;
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      let inside = false, k = 0;
      for (let i = 0; i < nx; i++) {
        const x = cx(i);
        while (k < xs.length && xs[k]! <= x) { inside = !inside; k++; }
        if (!inside) blocked[base + j * nx + i] = 2;
      }
    }
  }
  // Cells whose centre a track can't reach are hard; those clear only by less than the grid's own
  // slack are soft (passable at a cost: a line at minimum spacing runs through them)
  const slack = 0.75 * s;
  for (const it of w.near(net, grow(win, w.maxGap + width / 2 + s), o)) {
    const Rh = w.gap(net, it) + width / 2 + EPS, R = Rh + slack;
    const b = grow(it, R);
    const i0 = Math.max(0, Math.floor((b.minX - x0) / s)), i1 = Math.min(nx - 1, Math.ceil((b.maxX - x0) / s));
    const j0 = Math.max(0, Math.floor((b.minY - y0) / s)), j1 = Math.min(ny - 1, Math.ceil((b.maxY - y0) / s));
    const g = it.g;
    if (g.t === 'poly') {
      // Polygons: inside by scanline, then the band along each edge (cost goes with the outline, not the area)
      const rings = [g.pts, ...g.holes];
      for (let j = j0; j <= j1; j++) {
        const y = cy(j), xs: number[] = [];
        for (const r of rings) for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
          const p = r[k]!, q = r[m]!;
          if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
        }
        xs.sort((u, v) => u - v);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a0 = Math.max(i0, Math.ceil((xs[k]! - x0) / s)), a1 = Math.min(i1, Math.floor((xs[k + 1]! - x0) / s));
          for (let i = a0; i <= a1; i++) blocked[base + j * nx + i] = 2;
        }
      }
      for (const r of rings) for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
        const p = r[k]!, q = r[m]!;
        const e0 = Math.max(i0, Math.floor((Math.min(p.x, q.x) - R - x0) / s)), e1 = Math.min(i1, Math.ceil((Math.max(p.x, q.x) + R - x0) / s));
        const f0 = Math.max(j0, Math.floor((Math.min(p.y, q.y) - R - y0) / s)), f1 = Math.min(j1, Math.ceil((Math.max(p.y, q.y) + R - y0) / s));
        const vx = q.x - p.x, vy = q.y - p.y, l2 = vx * vx + vy * vy;
        for (let j = f0; j <= f1; j++) {
          const y = cy(j);
          for (let i = e0; i <= e1; i++) {
            const idx = j * nx + i;
            if (blocked[base + idx] === 2) continue;
            const x = cx(i);
            const t = l2 ? Math.max(0, Math.min(1, ((x - p.x) * vx + (y - p.y) * vy) / l2)) : 0;
            const d = Math.hypot(x - p.x - vx * t, y - p.y - vy * t);
            if (d < Rh) blocked[base + idx] = 2; else if (d < R) blocked[base + idx] = 1;
          }
        }
      }
      continue;
    }
    for (let j = j0; j <= j1; j++) {
      const y = cy(j);
      for (let i = i0; i <= i1; i++) {
        const idx = j * nx + i;
        if (blocked[base + idx] === 2) continue;
        const x = cx(i);
        let d: number;
        if (g.t === 'circle') d = Math.hypot(x - g.c.x, y - g.c.y) - g.r;
        else if (g.t === 'seg') {
          const vx = g.b.x - g.a.x, vy = g.b.y - g.a.y, l2 = vx * vx + vy * vy;
          const t = l2 ? Math.max(0, Math.min(1, ((x - g.a.x) * vx + (y - g.a.y) * vy) / l2)) : 0;
          d = Math.hypot(x - g.a.x - vx * t, y - g.a.y - vy * t) - g.r;
        } else continue;
        if (d < Rh) blocked[base + idx] = 2; else if (d < R) blocked[base + idx] = 1;
      }
    }
  }
}

/**
 * The shortest way round the obstacles from `from` towards `to` on a grid (A*), as cell centres
 * where it turns. When `to` is in the way of something, the free cell nearest it is the goal.
 */
export function gridSearch(w: RouteWorld, net: number, width: number, from: Vec2, to: Vec2, o: SearchOptions): Found | null {
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const win = o.window ?? grow(boxPts([from, to]), Math.max(span * 0.3, 20 * (width + w.maxGap), mil(120)));
  const area = (win.maxX - win.minX) * (win.maxY - win.minY);
  const cap = o.cells ?? 150_000;
  const s = Math.max(mil(1), Math.ceil(Math.sqrt(area / cap)));
  const x0 = from.x - Math.ceil((from.x - win.minX) / s) * s, y0 = from.y - Math.ceil((from.y - win.minY) / s) * s;
  const nx = Math.ceil((win.maxX - x0) / s) + 1, ny = Math.ceil((win.maxY - y0) / s) + 1;
  if (nx < 2 || ny < 2 || nx * ny > cap * 1.3) return null;
  const N = nx * ny;
  const { blocked, g, came, dirAt, closed, f } = buffers(N);
  const cx = (i: number) => x0 + i * s, cy = (j: number) => y0 + j * s;
  rasterize(w, net, width, { x0, y0, nx, ny, s, win }, o, blocked, 0);
  const si = Math.round((from.y - y0) / s) * nx + Math.round((from.x - x0) / s);
  blocked[si] = 0;
  // The goal: the cell at `to`, or the free cell nearest it
  const ti = Math.round((to.x - x0) / s), tj = Math.round((to.y - y0) / s);
  let goal = -1, reached = false;
  if (ti >= 0 && tj >= 0 && ti < nx && tj < ny && blocked[tj * nx + ti] !== 2) { goal = tj * nx + ti; reached = true; }
  else {
    let best = Infinity;
    for (let r = 1; r < 60 && goal < 0; r++) {
      for (let j = tj - r; j <= tj + r; j++) for (let i = ti - r; i <= ti + r; i++) {
        if (Math.max(Math.abs(i - ti), Math.abs(j - tj)) !== r || i < 0 || j < 0 || i >= nx || j >= ny || blocked[j * nx + i] === 2) continue;
        const d = Math.hypot(cx(i) - to.x, cy(j) - to.y);
        if (d < best) { best = d; goal = j * nx + i; }
      }
    }
    if (goal < 0) return null;
  }
  const gx = goal % nx, gy = Math.floor(goal / nx);
  const dirs = o.dirs === 4 ? 4 : 8;
  const step = dirs === 4 ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const heap: number[] = [];
  const h = (i: number) => { const dx = Math.abs(i % nx - gx), dy = Math.abs(Math.floor(i / nx) - gy); return dirs === 4 ? (dx + dy) * s : (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * s; };
  const push = (i: number) => { heap.push(i); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (f[heap[p]!]! <= f[i]!) break; heap[c] = heap[p]!; c = p; } heap[c] = i; };
  const pop = (): number => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; const fv = f[last]!; let mv = fv; if (l < heap.length && f[heap[l]!]! < mv) { m = l; mv = f[heap[l]!]!; } if (r < heap.length && f[heap[r]!]! < mv) m = r; if (m === c) break; heap[c] = heap[m]!; c = m; } heap[c] = last; } return top; };
  g[si] = 0; f[si] = h(si); push(si);
  let found = false;
  // The cell nearest the target the search got to (where an unreachable target leaves the route)
  let nearest = si, nearD = Math.hypot(cx(si % nx) - to.x, cy(Math.floor(si / nx)) - to.y);
  while (heap.length) {
    const c = pop();
    if (closed[c]) continue;
    closed[c] = 1;
    if (c === goal) { found = true; break; }
    const dc = Math.hypot(cx(c % nx) - to.x, cy(Math.floor(c / nx)) - to.y);
    if (dc < nearD) { nearD = dc; nearest = c; }
    const ci = c % nx, cj = Math.floor(c / nx);
    for (let d = 0; d < step.length; d++) {
      const [ddx, ddy] = step[d]!;
      const ni = ci + ddx!, nj = cj + ddy!;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const n = nj * nx + ni;
      if (blocked[n] === 2 || closed[n]) continue;
      if (ddx && ddy && (blocked[cj * nx + ni] === 2 || blocked[nj * nx + ci] === 2)) continue;
      const turn = dirAt[c] < 0 ? 0 : Math.min((d - dirAt[c] + 8) % (dirs === 4 ? 4 : 8), (dirAt[c] - d + 8) % (dirs === 4 ? 4 : 8));
      const cost = g[c]! + (ddx && ddy ? Math.SQRT2 * s : s) * (blocked[n] ? 3 : 1) + turn * 0.3 * s;
      if (cost < g[n]!) { g[n] = cost; came[n] = c; dirAt[n] = d; f[n] = cost + h(n); push(n); }
    }
  }
  if (!found) {
    if (nearest === si) return null;
    goal = nearest; reached = false;
  }
  const cells: number[] = [];
  for (let c = goal; c >= 0; c = came[c]!) cells.push(c);
  cells.reverse();
  const pts = simplify(cells.map((c) => ({ x: cx(c % nx), y: cy(Math.floor(c / nx)) })));
  pts[0] = from;
  if (reached && !same(pts.at(-1)!, to)) pts.push(to);
  return { pts: simplify(pts), reached, complete: found };
}

/**
 * Walkaround: the way from `from` to `to` (or as near as it can get) round the obstacles, pulled
 * tight and hugging them. Null when nothing gets out of `from`.
 */
export function walkaround(w: RouteWorld, net: number, width: number, from: Vec2, to: Vec2, o: SearchOptions): Found | null {
  let f = gridSearch(w, net, width, from, to, o);
  if (!f?.complete && !o.window) {
    // Room to go further round: a wider window, then the whole board
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const wider: BBox[] = [grow(boxPts([from, to]), Math.max(span * 2, mil(600)))];
    if (w.outline) wider.push(grow(boxPts(w.outline), mil(20)));
    const gap = (x: Found) => Math.hypot(x.pts.at(-1)!.x - to.x, x.pts.at(-1)!.y - to.y);
    for (const window of wider) {
      const g = gridSearch(w, net, width, from, to, { ...o, window, cells: Math.max(o.cells ?? 0, 300_000) });
      if (g && (!f || g.complete || gap(g) < gap(f))) f = g;
      if (f?.complete) break;
    }
  }
  if (!f) return null;
  let pts = pull(w, net, width, f.pts, o.dirs, o);
  if (o.dirs !== 0) { pts = tighten(w, net, width, pts, o); pts = pull(w, net, width, pts, o.dirs, o); }
  if (!f.reached) {
    // As near the target as it can get: the last leg slides towards it while clear
    const last = pts.at(-1)!, prev = pts.at(-2);
    if (prev) {
      const d = dirOf(prev, last), t = (to.x - last.x) * d.x + (to.y - last.y) * d.y;
      if (t > 0) {
        let lo = 0, hi = t;
        for (let k = 0; k < 20 && hi - lo > 10; k++) { const m = (lo + hi) / 2; if (w.clear(net, width, [prev, rnd({ x: last.x + d.x * m, y: last.y + d.y * m })], o)) lo = m; else hi = m; }
        pts[pts.length - 1] = rnd({ x: last.x + d.x * lo, y: last.y + d.y * lo });
      }
    }
  }
  return { pts: simplify(pts), reached: f.reached };
}

/* ─── AutoRoute On Multiple Layers ──────────────────────────────────────────────────────── */

export interface LayerRun { layer: LayerId; pts: Vec2[] }
export interface MultiFound { runs: LayerRun[]; vias: Vec2[]; reached: boolean; complete: boolean }

/**
 * AutoRoute On Multiple Layers: the cheapest way from `from` on layer `worlds[start]` to `to`
 * over every signal layer, changing layer by a via where one clears everything (on every layer)
 * at its gap. A via costs about three of its diameters of track, so the route keeps to one layer
 * where it can. Each layer's stretch is then pulled tight and slid against what it passes, as
 * Walkaround does; the vias stay where the search put them. `endLayers` limits where it may
 * finish (an SMD pad's layer).
 */
export function multiLayerRoute(worlds: RouteWorld[], start: number, net: number, width: number, via: { diameter: number; hole?: number }, from: Vec2, to: Vec2,
  o: { dirs: Dirs; window?: BBox; cells?: number; endLayers?: number[]; guide?: RouteGuide; noVias?: boolean;
    /** What a step costs on each layer (1 where none is given: a layer the net should keep off costs more), and what a via costs beside the usual. */
    layerCost?: number[]; viaFactor?: number }): MultiFound | null {
  const attempt = (window: BBox | undefined, cells: number) => layeredSearch(worlds, start, net, width, via, from, to, o, window, cells);
  let f = attempt(o.window, o.cells ?? 300_000);
  if (!f?.complete && !o.window) {
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const wider: BBox[] = [grow(boxPts([from, to]), Math.max(span * 2, mil(600)))];
    const ol = worlds[0]?.outline;
    if (ol) wider.push(grow(boxPts(ol), mil(20)));
    const gap = (x: Raw) => Math.hypot(x.cells.at(-1)!.p.x - to.x, x.cells.at(-1)!.p.y - to.y);
    for (const window of wider) {
      const g = attempt(window, 400_000);
      if (g && (!f || g.complete || gap(g) < gap(f))) f = g;
      if (f?.complete) break;
    }
  }
  if (!f) return null;
  // Runs by layer, a via at each change
  const runs: LayerRun[] = [], vias: Vec2[] = [];
  for (const c of f.cells) {
    const last = runs.at(-1);
    if (!last || last.layer !== worlds[c.l]!.layer) {
      if (last) vias.push(last.pts.at(-1)!);
      runs.push({ layer: worlds[c.l]!.layer, pts: last ? [last.pts.at(-1)!] : [] });
      if (last) continue;
    }
    runs.at(-1)!.pts.push(c.p);
  }
  runs[0]!.pts[0] = from;
  if (f.reached) { const lr = runs.at(-1)!; if (!same(lr.pts.at(-1)!, to)) lr.pts.push(to); }
  for (const r of runs) {
    const w = worlds.find((x) => x.layer === r.layer)!;
    let pts = simplify(r.pts);
    // Along a route guide: kept as found (pulling it tight would take it off the guide)
    if (pts.length > 2 && !o.guide) {
      pts = pull(w, net, width, pts, o.dirs);
      if (o.dirs !== 0) { pts = tighten(w, net, width, pts); pts = pull(w, net, width, pts, o.dirs); }
    }
    r.pts = simplify(pts);
  }
  return { runs: runs.filter((r) => r.pts.length >= 2 || runs.length === 1), vias, reached: f.reached, complete: f.complete };
}

interface Raw { cells: { l: number; p: Vec2 }[]; reached: boolean; complete: boolean }

/**
 * ActiveRoute's route guide: a path and its width; routes keep within it where they can — or,
 * hard, only within it (and within its escapes: discs round the connection's pads, where the
 * route comes off its pads to the guide). A lane: the route keeps to that offset from the guide's
 * middle (left of the way it runs, positive), so a bundle of routes runs side by side in order.
 */
export interface RouteGuide { pts: Vec2[]; width: number; hard?: boolean; escape?: { c: Vec2; r: number }[]; lane?: number }
/** What being off its lane costs a step, per half guide width away from it. */
const LANE = 1.5;
/** What a step outside the guide costs, against one inside it. */
const OFF_GUIDE = 6;

function layeredSearch(worlds: RouteWorld[], start: number, net: number, width: number, via: { diameter: number; hole?: number }, from: Vec2, to: Vec2,
  o: { dirs: Dirs; endLayers?: number[]; guide?: RouteGuide; noVias?: boolean; layerCost?: number[]; viaFactor?: number }, window: BBox | undefined, cells: number): Raw | null {
  const L = worlds.length;
  const w0 = worlds[start]!;
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  let win = window ?? grow(boxPts([from, to]), Math.max(span * 0.3, 20 * (width + w0.maxGap), mil(120)));
  // A guide: the search takes it all in
  if (o.guide && o.guide.pts.length > 1) {
    const gb = grow(boxPts(o.guide.pts), o.guide.width);
    win = { minX: Math.min(win.minX, gb.minX), minY: Math.min(win.minY, gb.minY), maxX: Math.max(win.maxX, gb.maxX), maxY: Math.max(win.maxY, gb.maxY) };
  }
  const area = (win.maxX - win.minX) * (win.maxY - win.minY);
  const cap = Math.floor(cells / Math.max(1, L));
  const s = Math.max(mil(1), Math.ceil(Math.sqrt(area / cap)));
  const x0 = from.x - Math.ceil((from.x - win.minX) / s) * s, y0 = from.y - Math.ceil((from.y - win.minY) / s) * s;
  const nx = Math.ceil((win.maxX - x0) / s) + 1, ny = Math.ceil((win.maxY - y0) / s) + 1;
  if (nx < 2 || ny < 2 || nx * ny > cap * 1.3) return null;
  const N = nx * ny, grid: Grid = { x0, y0, nx, ny, s, win };
  const blocked = new Uint8Array(L * N);
  worlds.forEach((w, l) => rasterize(w, net, width, grid, {}, blocked, l * N));
  // Where a via fits: clear on every layer at its own size
  const viaOk = new Uint8Array(N).fill(1);
  const scratch = new Uint8Array(N);
  for (const w of worlds) {
    scratch.fill(0);
    rasterize(w, net, via.diameter, grid, {}, scratch, 0);
    for (let i = 0; i < N; i++) if (scratch[i]) viaOk[i] = 0;
    // …and not in a pad, even one of the net (no via in pad)
    for (const it of w.tree.search(grow(win, via.diameter))) {
      if (it.kind !== 'pad' || it.net !== net) continue;
      const R = via.diameter / 2, b = grow(it, R);
      for (let j = Math.max(0, Math.floor((b.minY - y0) / s)); j <= Math.min(ny - 1, Math.ceil((b.maxY - y0) / s)); j++)
        for (let i = Math.max(0, Math.floor((b.minX - x0) / s)); i <= Math.min(nx - 1, Math.ceil((b.maxX - x0) / s)); i++)
          if (pointDist(it.g, { x: x0 + i * s, y: y0 + j * s }) < R) viaOk[j * nx + i] = 0;
    }
  }
  // …and its hole clear of every other hole (any net) by the Hole To Hole Clearance rule. A via
  // of the net already there (on the board or routed this run) is where the route changes layer
  // instead: its cell takes a layer change at a track step's cost, and no second via goes beside it.
  const cellsNear = (c: Vec2, r: number, f: (k: number, d: number) => void) => {
    for (let j = Math.max(0, Math.floor((c.y - r - y0) / s)); j <= Math.min(ny - 1, Math.ceil((c.y + r - y0) / s)); j++)
      for (let i = Math.max(0, Math.floor((c.x - r - x0) / s)); i <= Math.min(nx - 1, Math.ceil((c.x + r - x0) / s)); i++) {
        const d = Math.hypot(x0 + i * s - c.x, y0 + j * s - c.y);
        if (d < r) f(j * nx + i, d);
      }
  };
  const ownHole = (via.hole ?? via.diameter / 2) / 2;
  const throughVia = new Uint8Array(N);
  const holes: { c: Vec2; r: number; own: boolean }[] = [];
  for (const it of w0.tree.search(grow(win, via.diameter + w0.holeGap))) {
    if (it.g.t !== 'circle') continue;
    if (it.kind === 'hole') holes.push({ c: it.g.c, r: it.g.r, own: false });
    else if (it.kind === 'route') holes.push({ c: it.g.c, r: ownHole, own: it.net === net });
    if ((it.kind === 'via' || it.kind === 'route') && it.net === net) {
      // The cell nearest its centre
      const i = Math.round((it.g.c.x - x0) / s), j = Math.round((it.g.c.y - y0) / s);
      if (i >= 0 && j >= 0 && i < nx && j < ny && Math.hypot(x0 + i * s - it.g.c.x, y0 + j * s - it.g.c.y) < it.g.r) throughVia[j * nx + i] = 1;
    }
  }
  if (w0.holeGap > 0 || holes.length) for (const hl of holes) cellsNear(hl.c, hl.r + ownHole + w0.holeGap, (k) => { viaOk[k] = 0; });
  for (let k = 0; k < N; k++) if (throughVia[k]) viaOk[k] = 1;
  const cx = (i: number) => x0 + i * s, cy = (j: number) => y0 + j * s;
  const si = Math.round((from.y - y0) / s) * nx + Math.round((from.x - x0) / s);
  blocked[start * N + si] = 0;
  // Goals: the target's cell on the layers it may end on (else the free cell nearest it)
  const ends = o.endLayers?.length ? o.endLayers : worlds.map((_, l) => l);
  const ti = Math.round((to.x - x0) / s), tj = Math.round((to.y - y0) / s);
  const goals = new Set<number>();
  let reached = false;
  if (ti >= 0 && tj >= 0 && ti < nx && tj < ny) for (const l of ends) if (blocked[l * N + tj * nx + ti] !== 2) { goals.add(l * N + tj * nx + ti); reached = true; }
  if (!goals.size) {
    for (let r = 1; r < 60 && !goals.size; r++) {
      let best = Infinity, bestK = -1;
      for (let j = tj - r; j <= tj + r; j++) for (let i = ti - r; i <= ti + r; i++) {
        if (Math.max(Math.abs(i - ti), Math.abs(j - tj)) !== r || i < 0 || j < 0 || i >= nx || j >= ny) continue;
        for (const l of ends) {
          if (blocked[l * N + j * nx + i] === 2) continue;
          const d = Math.hypot(cx(i) - to.x, cy(j) - to.y);
          if (d < best) { best = d; bestK = l * N + j * nx + i; }
        }
      }
      if (bestK >= 0) goals.add(bestK);
    }
    if (!goals.size) return null;
  }
  const gx = ti, gy = tj;
  const dirs = o.dirs === 4 ? 4 : 8;
  const step = dirs === 4 ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const M = L * N;
  const g = new Float64Array(M).fill(Infinity), f = new Float64Array(M), came = new Int32Array(M).fill(-1), dirAt = new Int8Array(M).fill(-1), closed = new Uint8Array(M);
  const viaCost = Math.max(20 * s, 3 * via.diameter) * (o.viaFactor ?? 1);
  // Off the guide: each step there costs more, or (a hard guide) none is taken outside it and its escapes;
  // on it, off its lane costs more
  const off = new Uint8Array(N);
  const laneCost = new Float32Array(N).fill(1);
  if (o.guide && o.guide.pts.length > 1) {
    const gp = o.guide.pts, half = o.guide.width / 2, lane = o.guide.lane;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = { x: cx(i), y: cy(j) };
      let d = Infinity, side = 0;
      for (let k = 1; k < gp.length; k++) {
        const a = gp[k - 1]!, b = gp[k]!, dk = distToSegment(p, a, b);
        if (dk < d) { d = dk; side = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) || 1; }
      }
      const kk = j * nx + i;
      if (d > half) { off[kk] = o.guide.escape?.some((e) => Math.hypot(p.x - e.c.x, p.y - e.c.y) <= e.r) ? 1 : o.guide.hard ? 2 : 1; continue; }
      if (lane !== undefined) laneCost[kk] = 1 + LANE * Math.abs(side * d - lane) / Math.max(half, 1);
    }
  }
  const h = (k: number) => { const c = k % N, dx = Math.abs(c % nx - gx), dy = Math.abs(Math.floor(c / nx) - gy); return dirs === 4 ? (dx + dy) * s : (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * s; };
  const heap: number[] = [];
  const push = (i: number) => { heap.push(i); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (f[heap[p]!]! <= f[i]!) break; heap[c] = heap[p]!; c = p; } heap[c] = i; };
  const pop = (): number => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; let mv = f[last]!; if (l < heap.length && f[heap[l]!]! < mv) { m = l; mv = f[heap[l]!]!; } if (r < heap.length && f[heap[r]!]! < mv) m = r; if (m === c) break; heap[c] = heap[m]!; c = m; } heap[c] = last; } return top; };
  const s0 = start * N + si;
  g[s0] = 0; f[s0] = h(s0); push(s0);
  let goal = -1, nearest = s0, nearD = Infinity;
  while (heap.length) {
    const k = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (goals.has(k)) { goal = k; break; }
    const l = Math.floor(k / N), c = k % N, ci = c % nx, cj = Math.floor(c / nx);
    const dc = Math.hypot(cx(ci) - to.x, cy(cj) - to.y);
    if (dc < nearD && ends.includes(l)) { nearD = dc; nearest = k; }
    for (let d = 0; d < step.length; d++) {
      const [ddx, ddy] = step[d]!;
      const ni = ci + ddx!, nj = cj + ddy!;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const n = l * N + nj * nx + ni;
      if (blocked[n] === 2 || closed[n] || off[nj * nx + ni] === 2) continue;
      if (ddx && ddy && (blocked[l * N + cj * nx + ni] === 2 || blocked[l * N + nj * nx + ci] === 2)) continue;
      const turn = dirAt[k] < 0 ? 0 : Math.min((d - dirAt[k] + 8) % dirs, (dirAt[k] - d + 8) % dirs);
      const cost = g[k]! + (ddx && ddy ? Math.SQRT2 * s : s) * (blocked[n] ? 3 : 1) * (off[nj * nx + ni] ? OFF_GUIDE : laneCost[nj * nx + ni]!) * (o.layerCost?.[l] ?? 1) + turn * 0.3 * s;
      if (cost < g[n]!) { g[n] = cost; came[n] = k; dirAt[n] = d; f[n] = cost + h(n); push(n); }
    }
    // A via here to another layer (none for ActiveRoute, which keeps each route on one layer)
    if (viaOk[c] && !o.noVias) for (let l2 = 0; l2 < L; l2++) {
      if (l2 === l) continue;
      const n = l2 * N + c;
      if (blocked[n] === 2 || closed[n]) continue;
      const cost = g[k]! + (throughVia[c] ? s : viaCost);
      if (cost < g[n]!) { g[n] = cost; came[n] = k; dirAt[n] = -1; f[n] = cost + h(n); push(n); }
    }
  }
  const complete = goal >= 0;
  if (!complete) { if (nearest === s0) return null; goal = nearest; reached = false; }
  else if (goal % N !== tj * nx + ti) reached = false;
  const chain: number[] = [];
  for (let k = goal; k >= 0; k = came[k]!) chain.push(k);
  chain.reverse();
  return { cells: chain.map((k) => ({ l: Math.floor(k / N), p: { x: cx((k % N) % nx), y: cy(Math.floor((k % N) / nx)) } })), reached, complete };
}

/* ─── Push ──────────────────────────────────────────────────────────────────────────────── */

/** A chain of movable tracks of one net and width, between pads, vias, branches or a free end. */
export interface Line { items: RItem[]; pts: Vec2[]; net: number; width: number }

/** The line a movable track belongs to. */
export function lineOf(w: RouteWorld, start: RItem, extraSkip?: (it: RItem) => boolean): Line {
  const byEnd = (p: Vec2) => w.tree.search(grow({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }, 2)).filter((it) => it.net === start.net && !extraSkip?.(it));
  /** The other track a free joint leads on to, or null where the line ends. */
  const next = (it: RItem, at: Vec2): RItem | null => {
    const here = byEnd(at);
    const tracks = here.filter((x) => x.movable && x.seg && (same(x.seg.a, at) || same(x.seg.b, at)));
    // Anything else of the net there (pad, via, arc, a fixed track) holds the joint
    if (here.some((x) => !x.movable && x.kind !== 'hole' && pointDist(x.g, at) <= 1)) return null;
    if (tracks.length !== 2) return null;
    const o = tracks.find((x) => x.id !== it.id)!;
    return o.seg!.width === start.seg!.width ? o : null;
  };
  const items = [start];
  const seen = new Set([start.id]);
  const s0 = start.seg!;
  let pts = [s0.a, s0.b];
  // Forwards from b, then backwards from a
  for (const forward of [true, false]) {
    let cur = start, at = forward ? s0.b : s0.a;
    for (let n = 0; n < 500; n++) {
      const o = next(cur, at);
      if (!o || seen.has(o.id)) break;
      seen.add(o.id);
      const far = same(o.seg!.a, at) ? o.seg!.b : o.seg!.a;
      if (forward) { items.push(o); pts.push(far); } else { items.unshift(o); pts = [far, ...pts]; }
      cur = o; at = far;
    }
  }
  return { items, pts, net: start.net, width: s0.width };
}

export interface Shoved { line: Line; pts: Vec2[] }
/** A via pushed out of the way: where it goes, and the tracks ending on it (every layer) with their new ends. */
export interface PushedVia { prim: number; at: Vec2; to: Vec2; diameter: number; net: number; dragged: { prim: number; layer: LayerId; a: Vec2; b: Vec2; width: number }[] }
export interface ShoveResult { ok: boolean; shoved: Shoved[]; vias: PushedVia[]; why?: string }

/**
 * Push a via out of the pushers' way: away from them (the sum of the directions from each to it),
 * the least distance that leaves it, and the tracks it drags with it on this layer, clear here and
 * of other nets' copper on the other layers. Null when it is fixed (locked, in a component, a
 * dragged track locked) or has nowhere to go.
 */
function pushVia(w: RouteWorld, it: RItem, pushers: RItem[], skip?: (it: RItem) => boolean): PushedVia | null {
  const doc = w.doc, v = doc.prims[it.prim];
  if (!v || v.kind !== 'via' || v.locked) return null;
  const at = w.pending.vias.get(it.prim) ?? v.at;
  // The tracks ending on it, on every layer: they come along
  const dragged: PushedVia['dragged'] = [];
  for (let i = 0; i < doc.prims.length; i++) {
    const t = doc.prims[i]!;
    if (t.kind !== 'track' || t.net !== v.net || w.pending.removed.has(i)) continue;
    const e = w.pending.ends.get(i) ?? { a: t.a, b: t.b };
    const ea = same(e.a, at), eb = same(e.b, at);
    if (!ea && !eb) continue;
    if (t.locked || t.component !== NO_NET) return null;
    dragged.push({ prim: i, layer: t.layer, a: e.a, b: e.b, width: t.width });
  }
  const ownPrims = new Set([it.prim, ...dragged.map((d) => d.prim)]);
  // Away from what pushes it
  let dx = 0, dy = 0;
  for (const p of pushers) {
    if (!p.seg) continue;
    const { a, b } = p.seg, len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / len2)) : 0;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    let nx = at.x - q.x, ny = at.y - q.y, l = Math.hypot(nx, ny);
    if (l < 1) { nx = -(b.y - a.y); ny = b.x - a.x; l = Math.hypot(nx, ny) || 1; }
    const reach = p.seg.width / 2 + v.diameter / 2 + w.gap(p.net, it);
    if (Math.hypot(at.x - q.x, at.y - q.y) >= reach) continue;
    dx += (nx / l) * (reach - Math.hypot(at.x - q.x, at.y - q.y));
    dy += (ny / l) * (reach - Math.hypot(at.x - q.x, at.y - q.y));
  }
  const dl = Math.hypot(dx, dy);
  if (dl < 1) return null;
  const ux = dx / dl, uy = dy / dl;
  const others = boardIndex(doc);
  const look: Look = { skip: (x) => ownPrims.has(x.prim) || x.movable || !!skip?.(x), extra: pushers };
  const fits = (d: number): Vec2 | null => {
    const to = rnd({ x: at.x + ux * d, y: at.y + uy * d });
    if (w.viaHit(v.net, to, v.diameter, look)) return null;
    for (const t of dragged) {
      if (t.layer !== w.layer) continue;
      const a = same(t.a, at) ? to : t.a, b = same(t.b, at) ? to : t.b;
      if (w.segHit(v.net, t.width, a, b, look)) return null;
    }
    // The other layers: the via's copper there clear of other nets' (at the largest gap, to be safe)
    const r = v.diameter / 2 + w.maxGap;
    for (const sh of others.search({ minX: to.x - r, minY: to.y - r, maxX: to.x + r, maxY: to.y + r })) {
      if (sh.layer === w.layer || ownPrims.has(sh.prim) || sh.net === v.net || w.pending.removed.has(sh.prim)) continue;
      if (distance({ t: 'circle', c: to, r: v.diameter / 2 }, sh.g) < w.maxGap) return null;
    }
    return to;
  };
  // The least move that clears: stepping out, then halving back
  const step = Math.max(mil(1), v.diameter / 8), most = 4 * (v.diameter + w.maxGap) + dl;
  let lo = 0, hi = -1;
  for (let d = Math.max(dl, step); d <= most; d += step) { if (fits(d)) { hi = d; break; } lo = d; }
  if (hi < 0) return null;
  for (let k = 0; k < 12 && hi - lo > mil(0.2); k++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  const to = fits(hi)!;
  return { prim: it.prim, at, to, diameter: v.diameter, net: v.net,
    dragged: dragged.map((t) => ({ ...t, a: same(t.a, at) ? to : t.a, b: same(t.b, at) ? to : t.b })) };
}

/**
 * Push the movable lines `pushers` run into out of their way, each by walking the stretch that
 * collides round them at clearance, and on through any line that one then runs into.
 */
export function shove(w: RouteWorld, pushers0: RItem[], o: { dirs: Dirs; budgetMs?: number; skip?: (it: RItem) => boolean; vias?: boolean } = { dirs: 8 }): ShoveResult {
  const t0 = Date.now(), budget = o.budgetMs ?? 120;
  // Vias first (Push and Hug And Push move free vias, with the tracks ending on them): they then push like the route
  const vias: PushedVia[] = [];
  if (o.vias) {
    for (const p of pushers0) {
      for (const it of w.tree.search(grow(p, w.maxGap + 1))) {
        if (it.kind !== 'via' || it.prim < 0 || vias.some((x) => x.prim === it.prim) || !w.blocks(p.net, it) || o.skip?.(it)) continue;
        if (distance(p.g, it.g) >= w.gap(p.net, it) + EPS) continue;
        const pv = pushVia(w, it, pushers0, o.skip);
        if (pv) vias.push(pv);
      }
    }
  }
  const viaPrims = new Set(vias.flatMap((v) => [v.prim, ...v.dragged.map((d) => d.prim)]));
  const viaItems = vias.flatMap((v) => [
    { ...w.virtual({ layer: w.layer, a: v.to, b: v.to, width: v.diameter, net: v.net }), kind: 'via' as ItemKind },
    ...v.dragged.filter((d) => d.layer === w.layer).map((d) => w.virtual({ layer: w.layer, a: d.a, b: d.b, width: d.width, net: v.net })),
  ]);
  const pushers = [...pushers0, ...viaItems];
  const skip0 = o.skip;
  o = { ...o, skip: (it) => viaPrims.has(it.prim) || !!skip0?.(it) };
  const lines = new Map<string, Line>();
  const fresh = new Map<string, Vec2[]>();
  const owner = new Map<number, string>();
  const lineKey = (l: Line) => l.items.map((x) => x.id).sort((a, b) => a - b).join(',');
  const lineFor = (it: RItem): string => {
    const k0 = owner.get(it.id);
    if (k0) return k0;
    const l = lineOf(w, it, o.skip);
    const k = lineKey(l);
    lines.set(k, l);
    for (const x of l.items) owner.set(x.id, k);
    return k;
  };
  // A moved line's new segments push like the route does (fixed while the others move)
  const newItems = (k: string, pts: Vec2[]) => { const l = lines.get(k)!; return pts.slice(1).map((b, i) => w.virtual({ layer: w.layer, a: pts[i]!, b, width: l.width, net: l.net }, 'track', false)); };
  // Everything that pushes a line: the route, and the lines already moved (their new places)
  const pushersFor = (except: string): RItem[] => [...pushers, ...[...fresh].filter(([k]) => k !== except).flatMap(([k, pts]) => newItems(k, pts))];
  const oldOfMoved = () => new Set([...fresh.keys()].flatMap((k) => lines.get(k)!.items.map((x) => x.id)));
  /** Movable items (not of lines already moved) that copper runs into. */
  const hitBy = (items: RItem[], skipIds: Set<number>): RItem[] => {
    const out: RItem[] = [];
    for (const p of items) {
      const box = grow(p, w.maxGap + 1);
      for (const it of w.tree.search(box)) {
        if (!it.movable || skipIds.has(it.id) || !w.blocks(p.net, it) || o.skip?.(it) || out.includes(it)) continue;
        if (distance(p.g, it.g) < w.gap(p.net, it) + EPS) out.push(it);
      }
    }
    return out;
  };
  const queue: string[] = [];
  for (const it of hitBy(pushers, new Set())) { const k = lineFor(it); if (!queue.includes(k)) queue.push(k); }
  // Fixed copper in the pushers' way can't be pushed
  for (const p of pushers) if (p.seg && w.segHit(p.net, p.seg.width, p.seg.a, p.seg.b, { skip: (it) => it.movable || !!o.skip?.(it) })) return { ok: false, shoved: [], vias: [], why: 'a fixed object is in the way' };
  let rounds = 0;
  while (queue.length) {
    if (++rounds > 40 || Date.now() - t0 > budget) return { ok: false, shoved: [], vias: [], why: 'too much to push' };
    const k = queue.shift()!;
    const l = lines.get(k)!;
    const cur = fresh.get(k) ?? l.pts;
    const by = pushersFor(k);
    const moved = oldOfMoved();
    const own = new Set(l.items.map((x) => x.id));
    // The stretch that collides, cut out of its segments with room either side for the bump
    const near = (q: Vec2, p: RItem) => distance({ t: 'circle', c: q, r: l.width / 2 }, p.g) < w.gap(l.net, p) + EPS;
    const hit = (i: number) => by.some((p) => distance({ t: 'seg', a: cur[i]!, b: cur[i + 1]!, r: l.width / 2 }, p.g) < w.gap(l.net, p) + EPS);
    let i0 = -1, i1 = -1;
    for (let i = 0; i + 1 < cur.length; i++) if (hit(i)) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0) continue;
    const room = 2 * (l.width + w.maxGap) + Math.max(0, ...by.map((p) => p.seg?.width ?? 0));
    /** Where along segment i (from its start) copper comes too close: first and last. */
    const zone = (i: number): [number, number] => {
      const a0 = cur[i]!, b0 = cur[i + 1]!, len = Math.hypot(b0.x - a0.x, b0.y - a0.y);
      const st = Math.max(mil(2), (l.width + w.maxGap) / 3), n2 = Math.max(1, Math.ceil(len / st));
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k <= n2; k++) {
        const t = (k / n2) * len, q = { x: a0.x + ((b0.x - a0.x) * t) / (len || 1), y: a0.y + ((b0.y - a0.y) * t) / (len || 1) };
        if (by.some((p) => near(q, p))) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
      }
      return [lo, hi];
    };
    const along = (i: number, t: number) => { const a0 = cur[i]!, b0 = cur[i + 1]!, len = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1; return rnd({ x: a0.x + ((b0.x - a0.x) * t) / len, y: a0.y + ((b0.y - a0.y) * t) / len }); };
    const segLen = (i: number) => Math.hypot(cur[i + 1]!.x - cur[i]!.x, cur[i + 1]!.y - cur[i]!.y);
    let a: Vec2, b: Vec2, before: Vec2[], after: Vec2[];
    {
      // From `room` before the collision to `room` after it, into the segments either side when it comes to that
      const [lo] = zone(i0), [, hi] = zone(i1);
      let s0 = i0, tA = (Number.isFinite(lo) ? lo : 0) - room;
      while (tA < 0 && s0 > 0) { s0--; tA += segLen(s0); }
      tA = Math.max(0, tA);
      let s1 = i1, tB = (Number.isFinite(hi) ? hi : segLen(i1)) + room;
      while (tB > segLen(s1) && s1 < cur.length - 2) { tB -= segLen(s1); s1++; }
      tB = Math.min(segLen(s1), tB);
      i0 = s0; i1 = s1;
      a = tA > mil(1) ? along(i0, tA) : cur[i0]!;
      b = segLen(i1) - tB > mil(1) ? along(i1, tB) : cur[i1 + 1]!;
      before = [...cur.slice(0, i0 + 1), ...(tA > mil(1) ? [a] : [])];
      after = [...(segLen(i1) - tB > mil(1) ? [b] : []), ...cur.slice(i1 + 1)];
    }
    // A pushed line keeps to its side of each pusher: a wall on the far side of each pushing segment
    const sub = [a, ...cur.slice(i0 + 1, i1 + 1), b];
    const reach = Math.hypot(b.x - a.x, b.y - a.y) + mil(400);
    const walls: RItem[] = [];
    for (const p of by) {
      if (!p.seg) continue;
      const pa = p.seg.a, pb = p.seg.b, len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if (len < 1) continue;
      let q: Vec2 | null = null, best = Infinity;
      for (let k = 1; k < sub.length; k++) {
        const s0 = sub[k - 1]!, s1 = sub[k]!, m = Math.max(1, Math.ceil(Math.hypot(s1.x - s0.x, s1.y - s0.y) / mil(5)));
        for (let j = 0; j <= m; j++) {
          const c = { x: s0.x + ((s1.x - s0.x) * j) / m, y: s0.y + ((s1.y - s0.y) * j) / m };
          const d = distance({ t: 'circle', c, r: 0 }, { t: 'seg', a: pa, b: pb, r: 0 });
          if (d < best) { best = d; q = c; }
        }
      }
      if (!q) continue;
      // A line the pusher crosses (its head poking through) may go round either way
      const crosses = sub.slice(1).some((s1, k) => distance({ t: 'seg', a: sub[k]!, b: s1, r: 0 }, { t: 'seg', a: pa, b: pb, r: 0 }) < mil(1));
      if (crosses) continue;
      const side = ((pb.x - pa.x) * (q.y - pa.y) - (pb.y - pa.y) * (q.x - pa.x)) / len;
      if (Math.abs(side) < mil(0.5)) continue;
      const nrm = { x: (-(pb.y - pa.y) / len) * -Math.sign(side), y: ((pb.x - pa.x) / len) * -Math.sign(side) };
      walls.push(w.barrier([pa, pb, { x: pb.x + nrm.x * reach, y: pb.y + nrm.y * reach }, { x: pa.x + nrm.x * reach, y: pa.y + nrm.y * reach }]));
    }
    // Round fixed copper and the pushers, keeping near where the line was (a corridor along it, wider
    // if it has to be, then none); first clear of the other movable lines, then pushing them
    const disp = Math.max(0, ...by.map((p) => (p.seg?.width ?? 0) / 2)) + w.maxGap + l.width;
    // Round the stretch, with room to go round a pusher's head that pokes through it
    const win = grow(boxPts(sub), Math.max(4 * disp, 4 * (l.width + w.maxGap) + mil(20)));
    let found: Found | null = null;
    for (const lane of [disp + mil(5), 3 * disp + mil(15), 0]) {
      const fence = lane ? corridor(w, sub, lane, win) : null;
      for (const soft of [false, true]) {
        const look: SearchOptions = {
          dirs: o.dirs, extra: [...by, ...walls, ...(fence ? [fence] : [])],
          skip: (it) => own.has(it.id) || moved.has(it.id) || !!o.skip?.(it) || (soft && it.movable),
        };
        found = walkaround(w, l.net, l.width, a, b, { ...look, window: win, cells: 40_000 });
        if (found?.reached && w.clear(l.net, l.width, found.pts, look)) break;
        found = null;
      }
      if (found) break;
    }
    if (!found) return { ok: false, shoved: [], vias: [], why: 'no room to push' };
    // As little moved as it can be: each stretch slid back towards where the line was
    const back = relax(w, l.net, l.width, found.pts, sub, { extra: [...by, ...walls], skip: (it) => own.has(it.id) || moved.has(it.id) || !!o.skip?.(it) || it.movable });
    const pts = simplify([...before.slice(0, -1), ...back, ...after.slice(1)]);
    fresh.set(k, pts);
    // Lines the moved one now runs into: pushed in turn (lines already moved, again)
    const mine = newItems(k, pts);
    for (const it of hitBy(mine, new Set([...own]))) { const k2 = lineFor(it); if (!queue.includes(k2)) queue.push(k2); }
    for (const [k2, pts2] of fresh) {
      if (k2 === k || queue.includes(k2)) continue;
      const l2 = lines.get(k2)!;
      if (mine.some((p) => pts2.slice(1).some((q, i) => distance({ t: 'seg', a: pts2[i]!, b: q, r: l2.width / 2 }, p.g) < w.gap(l2.net, p) + EPS))) queue.push(k2);
    }
  }
  const shoved = [...fresh].map(([k, pts]) => ({ line: lines.get(k)!, pts }));
  // The route itself clear of what it pushed
  const moved = oldOfMoved();
  const extra = shoved.flatMap((s) => newItems(lineKey(s.line), s.pts));
  for (const p of pushers0) if (p.seg && w.segHit(p.net, p.seg.width, p.seg.a, p.seg.b, { skip: (it) => moved.has(it.id) || !!o.skip?.(it), extra: [...extra, ...viaItems] })) return { ok: false, shoved: [], vias: [], why: 'pushed copper still in the way' };
  return { ok: true, shoved, vias };
}

/** Distance from a point to a polyline. */
const toLine = (p: Vec2, line: Vec2[]) => Math.min(...line.slice(1).map((b, i) => distance({ t: 'circle', c: p, r: 0 }, { t: 'seg', a: line[i]!, b, r: 0 })));

/**
 * The opposite of tighten for a pushed line: each inner segment slid back towards where the line
 * was (keeping its direction and its neighbours'), as far as the clearance lets it, so a push
 * moves copper no further than it must.
 */
export function relax(w: RouteWorld, net: number, width: number, pts0: Vec2[], orig: Vec2[], o: Look = {}): Vec2[] {
  let pts = simplify(pts0.map(rnd));
  const away = (s0: Vec2, s1: Vec2) => toLine({ x: (s0.x + s1.x) / 2, y: (s0.y + s1.y) / 2 }, orig) + toLine(s0, orig) + toLine(s1, orig);
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let k = 1; k + 2 < pts.length; k++) {
      const p0 = pts[k - 1]!, a = pts[k]!, b = pts[k + 1]!, p3 = pts[k + 2]!;
      const d0 = dirOf(p0, a), d1 = dirOf(a, b), d2 = dirOf(b, p3);
      const n = { x: -d1.y, y: d1.x };
      const at = (delta: number): [Vec2, Vec2] | null => {
        const base = { x: a.x + n.x * delta, y: a.y + n.y * delta };
        const na = meet(p0, d0, base, d1), nb = meet(p3, d2, base, d1);
        if (!na || !nb) return null;
        const fwd = (s: Vec2, e: Vec2, d: Vec2) => (e.x - s.x) * d.x + (e.y - s.y) * d.y >= -0.5;
        return fwd(p0, na, d0) && fwd(na, nb, d1) && fwd(nb, p3, d2) ? [na, nb] : null;
      };
      const now = away(a, b);
      if (now < mil(0.5)) continue;
      const probe = (sg: number) => { const r = at(sg * mil(1)); return r ? away(r[0], r[1]) : Infinity; };
      const sign = probe(1) < now - 1 ? 1 : probe(-1) < now - 1 ? -1 : 0;
      if (!sign) continue;
      const ok = (delta: number) => { const r = at(sign * delta); return !!r && away(r[0], r[1]) <= now + 1 && w.clear(net, width, [p0, rnd(r[0]), rnd(r[1]), p3], o); };
      let lo = 0, hi = now;
      if (!ok(Math.min(hi, mil(0.5)))) continue;
      for (let it = 0; it < 30 && hi - lo > 2; it++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
      const r = at(sign * lo);
      if (!r || lo < 2) continue;
      const next = simplify([...pts.slice(0, k), rnd(r[0]), rnd(r[1]), ...pts.slice(k + 2)]);
      if (w.clear(net, width, next.slice(Math.max(0, k - 1), k + 3), o)) { pts = next; moved = true; }
    }
    if (!moved) break;
  }
  return pts;
}

/** Everything in `win` further than `dist` from a polyline: a wall that keeps a pushed line near where it was. */
function corridor(w: RouteWorld, pts: Vec2[], dist: number, win: BBox): RItem | null {
  // Square ends and mitred joins: few edges, so the wall costs little to test
  const co = new C.ClipperOffset(2, 2_500);
  co.AddPath(pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) })), C.JoinType.jtMiter, C.EndType.etOpenSquare);
  const out: ClipperNS.IntPoint[][] = [];
  co.Execute(out, dist);
  if (out.length !== 1) return null;
  const big = grow(win, mil(50));
  const it = w.barrier([{ x: big.minX, y: big.minY }, { x: big.maxX, y: big.minY }, { x: big.maxX, y: big.maxY }, { x: big.minX, y: big.maxY }]);
  (it.g as { holes: Vec2[][] }).holes = [out[0]!.map((q) => ({ x: q.X, y: q.Y }))];
  return it;
}

/* ─── Clearance boundaries ──────────────────────────────────────────────────────────────── */

/**
 * Where the centre of a track of `width` may not go near `around` (Display Clearance Boundaries):
 * each obstacle grown by its gap and half the width, merged.
 */
export function clearanceBoundaries(w: RouteWorld, net: number, width: number, around: BBox, o: Look = {}): { outline: Vec2[]; holes: Vec2[][] }[] {
  const paths: ClipperNS.IntPoint[][] = [];
  const tol = 2_500;
  const co = new C.ClipperOffset(2, tol);
  for (const it of w.near(net, around, o)) {
    if (it.kind === 'hole' || (it.kind === 'edge' && it.prim < 0)) continue;
    const d = w.gap(net, it) + width / 2;
    const g = it.g;
    if (g.t === 'circle') co.AddPath([{ X: Math.round(g.c.x), Y: Math.round(g.c.y) }], C.JoinType.jtRound, C.EndType.etOpenRound);
    else if (g.t === 'seg') co.AddPath([{ X: Math.round(g.a.x), Y: Math.round(g.a.y) }, { X: Math.round(g.b.x), Y: Math.round(g.b.y) }], C.JoinType.jtRound, C.EndType.etOpenRound);
    else co.AddPath(g.pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) })), C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const out: ClipperNS.IntPoint[][] = [];
    co.Execute(out, (g.t === 'poly' ? 0 : g.r) + d);
    co.Clear();
    paths.push(...out);
  }
  if (!paths.length) return [];
  const c = new C.Clipper();
  c.AddPaths(paths, C.PolyType.ptSubject, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const out: { outline: Vec2[]; holes: Vec2[][] }[] = [];
  const pts = (n: ClipperNS.PolyNode) => n.Contour().map((q) => ({ x: q.X, y: q.Y }));
  const walk = (n: ClipperNS.PolyNode) => {
    for (const ch of n.Childs()) {
      if (ch.IsHole()) continue;
      out.push({ outline: pts(ch), holes: ch.Childs().filter((h) => h.IsHole()).map(pts) });
      for (const h of ch.Childs()) walk(h);
    }
  };
  walk(tree);
  return out;
}
