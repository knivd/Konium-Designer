/**
 * Route › Auto Route and Route › Fanout. The autorouter takes the connections asked for,
 * shortest first, and routes each over every signal layer at once (AutoRoute On Multiple Layers:
 * a grid search that changes layer by a via where one clears every layer), at the net's Width
 * rule and Routing Via Style; what it has routed blocks what comes after, until a connection
 * can't get through: then the routes in its way are ripped up and routed again after it (rip-up
 * and retry). Copper already on the board is never ripped up. Connections it can't complete are
 * reported. It yields between connections, so it can be paused and stopped.
 *
 * Fanout: each surface-mount pad that has a net and nothing on it gets a short track out to a
 * via, diagonally away from its component's centre (the other diagonals, then straight out, then
 * further, when that is blocked).
 */
import { pointInPoly, type Vec2 } from '../core/geom';
import { L, isSignal, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from './pcb';
import { checkCopper, clearanceGap, connections, ruleFor, type Connection } from './drc';
import { ruleEnabled, ruleKind, ruleLength } from '../formats/altium/rules';
import { RouteWorld, multiLayerRoute, noPending, type Dirs, type RouteGuide, type VTrack, type VVia } from './router';
import type { TrackFields } from '../formats/altium/pcbdoc';
import type { ViaFields } from './pcbEdit';
import { breathe } from '../core/breathe';
import { routePair } from './pairRoute';

export const probeTrack = (net: number, layer: LayerId = L.TOP): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, width: 0, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
const probeVia = (net: number, at: Vec2 = { x: 0, y: 0 }, diameter = 0, hole = 0): PcbVia => ({ kind: 'via', src: { storage: 'Vias6', index: -1 }, at, diameter, hole, layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false });

/** The width and via a net routes with (the rules' preferred). */
export function netRouting(doc: PcbDocument, net: number): { width: number; via: { diameter: number; hole: number } } {
  const w = ruleFor(doc, 'Width', probeTrack(net)), v = ruleFor(doc, 'RoutingVias', probeVia(net));
  return { width: w ? ruleLength(w, 'PREFEREDWIDTH', '10mil') : 100_000, via: { diameter: v ? ruleLength(v, 'WIDTH', '50mil') : 500_000, hole: v ? ruleLength(v, 'HOLEWIDTH', '28mil') : 280_000 } };
}

export interface RouteJob { cancelled: boolean; paused: boolean }
export interface AutorouteResult {
  tracks: TrackFields[]; vias: ViaFields[]; routed: number; failed: Connection[]; ms: number; ripped: number; passes: number;
  /** Connections necked down at a pad (with `verify`). */
  necked: number;
  /** Differential pairs routed as one, their two tracks side by side at the pair's gap (with `pairs`). */
  coupled: number;
}

const padAt = (doc: PcbDocument, at: Vec2, net: number): PcbPad | undefined =>
  doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.net === net && Math.abs(p.at.x - at.x) < 2 && Math.abs(p.at.y - at.y) < 2);

interface Routed { tracks: VTrack[]; vias: VVia[]; via: { diameter: number; hole: number }; layerSpan: [LayerId, LayerId]; necked?: boolean; /** Routed with its pair's other net: the two go and are ripped up together. */ mate?: number }

/** The first (or, from the end, the last) stretch of a run made narrower: so far along it, split where that falls within a segment. */
function narrowed(segs: { a: Vec2; b: Vec2; w: number }[], neck: { w: number; len: number }, fromEnd: boolean): { a: Vec2; b: Vec2; w: number }[] {
  const list = fromEnd ? [...segs].reverse().map((s) => ({ a: s.b, b: s.a, w: s.w })) : segs.map((s) => ({ ...s }));
  const out: { a: Vec2; b: Vec2; w: number }[] = [];
  let left = neck.len;
  for (const s of list) {
    const d = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (left <= 0) { out.push(s); continue; }
    if (d <= left + 1) { out.push({ ...s, w: Math.min(s.w, neck.w) }); left -= d; continue; }
    const m = { x: Math.round(s.a.x + ((s.b.x - s.a.x) * left) / d), y: Math.round(s.a.y + ((s.b.y - s.a.y) * left) / d) };
    out.push({ a: s.a, b: m, w: Math.min(s.w, neck.w) }, { a: m, b: s.b, w: s.w });
    left = 0;
  }
  return fromEnd ? out.reverse().map((s) => ({ a: s.b, b: s.a, w: s.w })) : out;
}

/** Each connection is ripped up at most this often (so the router can't go round in circles). */
const MAX_RIPS = 3;
/** Passes over what is still unrouted. */
const MAX_PASSES = 4;

/**
 * Route these connections (all the board's when none are given), shortest first. A connection
 * that can't get through is tried again ignoring what this run has routed: the routes in its way
 * are ripped up, it takes its way, and they go back in the queue to be routed again (each at most
 * a few times, over a few passes) — rip-up and retry [est: AD17's Situs router does it its own way].
 * Copper that was on the board stays where it is.
 */
export async function autoroute(doc: PcbDocument, conns: Connection[] = connections(doc), o: {
  dirs?: Dirs; job?: RouteJob; progress?: (done: number, of: number) => void; ripUp?: boolean; layers?: LayerId[]; guide?: RouteGuide;
  /** ActiveRoute's: each connection on one layer, no vias; its guide (lane and escapes) and the layers it tries first. */
  noVias?: boolean; guideFor?: (c: Connection) => RouteGuide | undefined; layersFor?: (c: Connection) => LayerId[];
  /**
   * A routing plan's (model/planRoute): the order the connections go in (lower first, the shorter first among equals),
   * and how each is to be routed: the layers its net should keep to (the others cost more), its vias free, few (dear) or none,
   * and a width other than its rule's preferred one (a second try at the narrowest the rule allows).
   */
  rank?: (c: Connection) => number; how?: (c: Connection) => { layers?: LayerId[]; vias?: 'free' | 'few' | 'none'; width?: number } | undefined;
  /**
   * A route is taken only when it keeps its clearances as it is drawn. The search lets a track leave the pad it starts on
   * and reach the one it ends on whatever stands beside them, so a track wider than its pad can come too near the pad's
   * neighbours: such a route is tried necked down at that pad (as wide as the pad is narrow, not below the Width rule's
   * minimum, for the pad's length and a little more), and failing that counts as not routed.
   */
  verify?: boolean;
  /**
   * Differential pairs to route as one (pairRoute.ts): the two nets and the space between their tracks. A pair whose
   * nets each have one connection to make is laid side by side on one layer; where that cannot be done its nets
   * are routed like any other.
   */
  pairs?: { p: number; n: number; gap: number }[];
} = {}): Promise<AutorouteResult> {
  const t0 = Date.now();
  // Only the layers asked for (ActiveRoute's), in stack order
  const allLayers = doc.board.copperStack.filter(isSignal);
  const layers = allLayers.filter((l) => !o.layers?.length || o.layers.includes(l));
  const order = [...conns].sort((a, b) => (o.rank ? o.rank(a) - o.rank(b) : 0) || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) - Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y));
  const out: AutorouteResult = { tracks: [], vias: [], routed: 0, failed: [], ms: 0, ripped: 0, passes: 0, necked: 0, coupled: 0 };
  const routed = new Map<number, Routed>();
  const rips = new Map<number, number>();
  const fixedNow = () => ({ tracks: [...routed.values()].flatMap((r) => r.tracks), vias: [...routed.values()].flatMap((r) => r.vias) });
  /** The way for connection k, round the board's copper and (unless ignored) what this run has routed. */
  const routeOne = (k: number, ignoreOwn: boolean) => {
    const c = order[k]!;
    const how = o.how?.(c);
    const nr = netRouting(doc, c.net), via = nr.via, width = how?.width ?? nr.width;
    const worlds = layers.map((l) => new RouteWorld(doc, l, noPending(), ignoreOwn ? {} : fixedNow()));
    const pa = padAt(doc, c.a, c.net), pb = padAt(doc, c.b, c.net);
    const guide = o.guideFor?.(c) ?? o.guide;
    let m: ReturnType<typeof multiLayerRoute> = null;
    // The layers its net should keep to: a step on another costs two and a half times as much
    const layerCost = how?.layers?.length ? layers.map((l) => (how.layers!.includes(l) ? 1 : 2.5)) : undefined;
    if (o.noVias || how?.vias === 'none') {
      // One layer both its pads are on, those preferred first
      const on = (p: PcbPad | undefined, l: LayerId) => !p || p.layer === L.MULTI || p.layer === l;
      const tries = [...(o.layersFor?.(c) ?? how?.layers ?? []), ...layers].filter((l, i, a) => layers.includes(l) && a.indexOf(l) === i && on(pa, l) && on(pb, l));
      for (const l of tries) {
        const li = layers.indexOf(l);
        m = multiLayerRoute(worlds, li, c.net, width, via, c.a, c.b, { dirs: o.dirs ?? 8, endLayers: [li], guide, noVias: true });
        if (m?.reached && m.complete) break;
        m = null;
      }
    } else {
      const startLayer = pa && pa.layer !== L.MULTI ? pa.layer : layers[0]!;
      const start = Math.max(0, layers.indexOf(startLayer));
      const endLayers = pb && pb.layer !== L.MULTI ? [layers.indexOf(pb.layer)].filter((x) => x >= 0) : undefined;
      m = multiLayerRoute(worlds, start, c.net, width, via, c.a, c.b, { dirs: o.dirs ?? 8, endLayers, guide, layerCost, viaFactor: how?.vias === 'few' ? 4 : 1 });
    }
    if (!m || !m.reached || !m.complete) return null;
    // Through vias (the whole stack), whatever layers it routes on
    const r: Routed = { tracks: [], vias: [], via, layerSpan: [allLayers[0]!, allLayers.at(-1)!] };
    const runs = m.runs;
    const build = (neckA: { w: number; len: number } | null, neckB: { w: number; len: number } | null): VTrack[] => {
      const ts: VTrack[] = [];
      runs.forEach((run, ri) => {
        let segs: { a: Vec2; b: Vec2; w: number }[] = [];
        for (let i = 1; i < run.pts.length; i++) { const a = run.pts[i - 1]!, b = run.pts[i]!; if (a.x !== b.x || a.y !== b.y) segs.push({ a, b, w: width }); }
        if (ri === 0 && neckA) segs = narrowed(segs, neckA, false);
        if (ri === runs.length - 1 && neckB) segs = narrowed(segs, neckB, true);
        for (const s of segs) ts.push({ layer: run.layer, a: s.a, b: s.b, width: s.w, net: c.net });
      });
      return ts;
    };
    r.tracks = build(null, null);
    if (o.verify) {
      const bad = (ts: VTrack[]) => ts.some((t) => !!worlds[layers.indexOf(t.layer)]?.segHit(c.net, t.width, t.a, t.b));
      if (bad(r.tracks)) {
        // Necked down at the pads it is wider than
        const min = Math.min(width, ((w) => (w ? ruleLength(w, 'MINLIMIT', '10mil') : width))(ruleFor(doc, 'Width', probeTrack(c.net))));
        const gap = clearanceGap(doc, probeTrack(c.net), probeTrack(NO_NET)) || 100_000;
        const neck = (p: PcbPad | undefined) => {
          if (!p) return null;
          const narrow = Math.min(p.top.w, p.top.h);
          return narrow < width - 1 ? { w: Math.max(min, Math.min(narrow, width)), len: Math.max(p.top.w, p.top.h) / 2 + width / 2 + gap } : null;
        };
        const na = neck(pa), nb = neck(pb);
        if (!na && !nb) return null;
        const ts = build(na, nb);
        if (bad(ts)) return null;
        r.tracks = ts; r.necked = true;
      }
    }
    // A layer change through a via of the net already there (on the board, or routed this run) adds none
    const there = [...doc.prims.filter((p): p is PcbVia => p.kind === 'via' && p.net === c.net), ...(ignoreOwn ? [] : fixedNow().vias.filter((x) => x.net === c.net))];
    for (const v of m.vias) if (!there.some((x) => Math.hypot(x.at.x - v.x, x.at.y - v.y) < x.diameter / 2)) r.vias.push({ at: v, diameter: via.diameter, hole: via.hole, net: c.net });
    return r;
  };
  /** This run's routes a new one runs into (by clearance, layer by layer; vias on every layer). */
  const victims = (r: Routed, net: number): number[] => {
    const hit: number[] = [];
    const worlds = new Map(layers.map((l) => [l, new RouteWorld(doc, l, noPending(), {})]));
    for (const [k, q] of routed) {
      if (order[k]!.net === net) continue;
      const clash = layers.some((l) => {
        const w = worlds.get(l)!;
        const mine = [...r.tracks.filter((t) => t.layer === l).map((t) => w.virtual(t)), ...r.vias.map((v) => w.virtual({ layer: l, a: v.at, b: v.at, width: v.diameter, net }))];
        if (!mine.length) return false;
        const look = { skip: () => true, extra: mine };
        return q.tracks.some((t) => t.layer === l && w.segHit(t.net, t.width, t.a, t.b, look)) || q.vias.some((v) => w.viaHit(v.net, v.at, v.diameter, look));
      });
      if (clash) hit.push(k);
    }
    return hit;
  };

  // Pairs: each net's one connection, by net; a pair is tried as one when its first connection comes up
  const pairOf = new Map<number, { other: number; gap: number }>();
  for (const p of o.pairs ?? []) { pairOf.set(p.p, { other: p.n, gap: p.gap }); pairOf.set(p.n, { other: p.p, gap: p.gap }); }
  const only = (net: number) => { const ks = order.map((c, k) => (c.net === net ? k : -1)).filter((k) => k >= 0); return ks.length === 1 ? ks[0]! : -1; };
  const tried = new Set<number>();
  /** Connection k and its pair's other one, side by side on one layer both their ends are on (the layers their class keeps to first). */
  const routeBoth = (k: number, kn: number, gap: number): [Routed, Routed] | null => {
    const cp = order[k]!, cn = order[kn]!;
    const { width, via } = netRouting(doc, cp.net);
    if (Math.abs(netRouting(doc, cn.net).width - width) > 1) return null;
    const far = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
    const swap = far(cp.a, cn.b) + far(cp.b, cn.a) < far(cp.a, cn.a) + far(cp.b, cn.b);
    const na = swap ? cn.b : cn.a, nb = swap ? cn.a : cn.b;
    const ends = [padAt(doc, cp.a, cp.net), padAt(doc, na, cn.net), padAt(doc, cp.b, cp.net), padAt(doc, nb, cn.net)];
    const reachOf = (ps: (PcbPad | undefined)[]) => Math.max(0, ...ps.map((p) => (p ? Math.max(p.top.w, p.top.h) / 2 : 0)));
    const on = (l: LayerId) => ends.every((p) => !p || p.layer === L.MULTI || p.layer === l);
    const tries = [...(o.how?.(cp)?.layers ?? []), ...layers].filter((l, i, a) => layers.includes(l) && a.indexOf(l) === i && on(l));
    for (const l of tries) {
      const w = new RouteWorld(doc, l, noPending(), fixedNow());
      const f = routePair(w, cp.net, cn.net, width, gap, { pa: cp.a, na, pb: cp.b, nb }, { a: reachOf(ends.slice(0, 2)), b: reachOf(ends.slice(2)) });
      if (!f) continue;
      const made = (pts: Vec2[], net: number, mate: number): Routed => ({ tracks: pts.slice(1).map((b, i) => ({ layer: l, a: pts[i]!, b, width, net })).filter((t) => t.a.x !== t.b.x || t.a.y !== t.b.y), vias: [], via, layerSpan: [allLayers[0]!, allLayers.at(-1)!], mate });
      return [made(f.p, cp.net, kn), made(f.n, cn.net, k)];
    }
    return null;
  };
  let queue = order.map((_, k) => k);
  const failed = new Set<number>();
  for (let pass = 0; pass < MAX_PASSES && queue.length; pass++) {
    out.passes = pass + 1;
    const next: number[] = [];
    for (let qi = 0; qi < queue.length; qi++) {
      o.progress?.(routed.size, order.length);
      await breathe();
      while (o.job?.paused && !o.job.cancelled) await new Promise((r) => setTimeout(r, 120));
      if (o.job?.cancelled) break;
      const k = queue[qi]!;
      if (routed.has(k)) continue;
      // A pair, once: both its connections as one
      const pr = pairOf.get(order[k]!.net);
      if (pr && !tried.has(k)) {
        const kn = only(pr.other);
        if (kn >= 0 && only(order[k]!.net) === k && !routed.has(kn)) {
          tried.add(k); tried.add(kn);
          const both = routeBoth(k, kn, pr.gap);
          if (both) { routed.set(k, both[0]); routed.set(kn, both[1]); failed.delete(k); failed.delete(kn); continue; }
        }
      }
      const r = routeOne(k, false);
      if (r) { routed.set(k, r); failed.delete(k); continue; }
      // Rip-up and retry: its way ignoring this run's routes, those in it ripped up and queued again
      if (o.ripUp === false || pass === MAX_PASSES - 1) { failed.add(k); continue; }
      const free = routeOne(k, true);
      if (!free) { failed.add(k); continue; }
      const vs = victims(free, order[k]!.net);
      if (!vs.length) { routed.set(k, free); failed.delete(k); continue; }
      if (vs.some((v) => (rips.get(v) ?? 0) >= MAX_RIPS)) { failed.add(k); next.push(k); continue; }
      // One of a pair ripped up takes the other with it: they are routed again one by one
      for (const v of [...vs]) { const m = routed.get(v)?.mate; if (m !== undefined && routed.has(m) && !vs.includes(m)) vs.push(m); }
      for (const v of vs) { routed.delete(v); rips.set(v, (rips.get(v) ?? 0) + 1); out.ripped++; next.push(v); }
      routed.set(k, free);
      failed.delete(k);
    }
    if (o.job?.cancelled) break;
    queue = [...new Set(next.filter((k) => !routed.has(k)))];
  }
  for (const k of queue) if (!routed.has(k)) failed.add(k);
  for (const [k, r] of [...routed].sort((a, b) => a[0] - b[0])) {
    const c = order[k]!;
    for (const t of r.tracks) out.tracks.push({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: c.net });
    for (const v of r.vias) out.vias.push({ at: v.at, diameter: v.diameter, hole: v.hole, net: c.net, layerStart: r.layerSpan[0], layerEnd: r.layerSpan[1] });
  }
  out.routed = routed.size;
  out.necked = [...routed.values()].filter((r) => r.necked).length;
  out.coupled = [...routed].filter(([k, r]) => r.mate !== undefined && r.mate > k && routed.get(r.mate)?.mate === k).length;
  out.failed = [...failed].filter((k) => !routed.has(k)).sort((a, b) => a - b).map((k) => order[k]!);
  out.ms = Date.now() - t0;
  return out;
}

export interface FanoutResult { tracks: TrackFields[]; vias: ViaFields[]; done: number; failed: PcbPad[]; /** Fanouts given an escape route. */ escaped: number }

/** Whether something of the pad's net already ends on it. */
function hasCopperOn(doc: PcbDocument, p: PcbPad): boolean {
  const on = (q: Vec2) => Math.abs(q.x - p.at.x) < 2 && Math.abs(q.y - p.at.y) < 2;
  return doc.prims.some((q) => 'net' in q && q.net === p.net && ((q.kind === 'track' && (on(q.a) || on(q.b))) || (q.kind === 'via' && on(q.at))));
}

/**
 * Fan out these pads (SMD pads with a net, or any when withoutNets, and nothing on them). With
 * escape, each fanout's via is then routed out from under its component: a straight track on
 * another signal layer (inner ones first) to just past the component's pads, on the side nearest
 * the via, where it keeps its clearances [est: AD's escape routing].
 */
export function fanout(doc: PcbDocument, pads: PcbPad[], o: { withoutNets?: boolean; escape?: boolean } = {}): FanoutResult {
  const out: FanoutResult = { tracks: [], vias: [], done: 0, failed: [], escaped: 0 };
  // Each component's pads' extent (escapes end past it)
  const boxes = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  if (o.escape) for (const q of doc.prims) {
    if (q.kind !== 'pad' || q.component === NO_NET) continue;
    const r = Math.max(q.top.w, q.top.h) / 2, b = boxes.get(q.component) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    boxes.set(q.component, { minX: Math.min(b.minX, q.at.x - r), minY: Math.min(b.minY, q.at.y - r), maxX: Math.max(b.maxX, q.at.x + r), maxY: Math.max(b.maxY, q.at.y + r) });
  }
  const layers = doc.board.copperStack.filter(isSignal);
  const added: PcbPrim[] = [];
  // A via's hole keeps the Hole To Hole Clearance rule's distance from every other hole, whatever their nets (and never overlaps one)
  const h2h = doc.rules.filter((r) => ruleEnabled(r) && ruleKind(r) === 'HoleToHoleClearance').map((r) => ruleLength(r, 'GAP', '10mil'));
  const holeGap = h2h.length ? Math.max(...h2h) : 0;
  const holes = doc.prims.filter((q): q is PcbPad | PcbVia => (q.kind === 'pad' || q.kind === 'via') && q.hole > 0).map((q) => ({ at: q.at, r: q.hole / 2 }));
  for (const p of pads) {
    if (p.layer === L.MULTI || (p.net === NO_NET && !o.withoutNets) || hasCopperOn(doc, p)) continue;
    const comp = p.component !== NO_NET ? doc.components[p.component] : undefined;
    const c = comp?.at ?? p.at;
    const { width, via } = netRouting(doc, p.net);
    const gap = clearanceGap(doc, probeTrack(p.net, p.layer), probeTrack(NO_NET, p.layer)) || 100_000;
    // Out from the centre: the diagonal first
    const ox = Math.sign(p.at.x - c.x) || 1, oy = Math.sign(p.at.y - c.y) || 1;
    const dirs: Vec2[] = [{ x: ox, y: oy }, { x: ox, y: -oy }, { x: -ox, y: oy }, { x: ox, y: 0 }, { x: 0, y: oy }];
    const half = Math.hypot(p.top.w, p.top.h) / 2;
    let placed = false;
    for (const k of [1, 1.5, 2.2]) {
      for (const d0 of dirs) {
        const n = Math.hypot(d0.x, d0.y), d = { x: d0.x / n, y: d0.y / n };
        const dist = (half + gap + via.diameter / 2) * k;
        const at = { x: Math.round(p.at.x + d.x * dist), y: Math.round(p.at.y + d.y * dist) };
        const t: PcbTrack = { ...probeTrack(p.net, p.layer), a: p.at, b: at, width };
        const v: PcbVia = probeVia(p.net, at, via.diameter, via.hole);
        if (holes.some((h) => Math.hypot(h.at.x - at.x, h.at.y - at.y) < h.r + via.hole / 2 + holeGap)) continue;
        const view = added.length ? { ...doc, prims: [...doc.prims, ...added] } : doc;
        if (checkCopper(view, [t, v], { ignorePours: true, clearanceOnly: true }).length) continue;
        added.push(t, v);
        holes.push({ at, r: via.hole / 2 });
        const net = p.net === NO_NET ? undefined : p.net;
        out.tracks.push({ layer: p.layer, a: p.at, b: at, width, net });
        out.vias.push({ at, diameter: via.diameter, hole: via.hole, net, layerStart: layers[0], layerEnd: layers.at(-1) });
        placed = true;
        const box = o.escape ? boxes.get(p.component) : undefined;
        if (box) {
          // Out the nearest side, then the others; inner layers first, then the far outer one
          const sides = [{ d: at.x - box.minX, e: { x: box.minX - gap - width, y: at.y } }, { d: box.maxX - at.x, e: { x: box.maxX + gap + width, y: at.y } },
            { d: at.y - box.minY, e: { x: at.x, y: box.minY - gap - width } }, { d: box.maxY - at.y, e: { x: at.x, y: box.maxY + gap + width } }].sort((s1, s2) => s1.d - s2.d);
          const order = [...layers.filter((l) => l !== L.TOP && l !== L.BOTTOM), ...layers.filter((l) => (l === L.TOP || l === L.BOTTOM) && l !== p.layer)];
          escape: for (const side of sides) for (const l of order) {
            const e = { x: Math.round(side.e.x), y: Math.round(side.e.y) };
            const et: PcbTrack = { ...probeTrack(p.net, l), a: at, b: e, width };
            if (checkCopper({ ...doc, prims: [...doc.prims, ...added] }, [et], { ignorePours: true, clearanceOnly: true }).length) continue;
            added.push(et);
            out.tracks.push({ layer: l, a: at, b: e, width, net });
            out.escaped++;
            break escape;
          }
        }
        break;
      }
      if (placed) break;
    }
    if (placed) out.done++; else out.failed.push(p);
  }
  return out;
}

export const smdPads = (doc: PcbDocument, keep: (p: PcbPad) => boolean = () => true, withoutNets = false) => doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.layer !== L.MULTI && (withoutNets || p.net !== NO_NET) && keep(p));

/** Fanout Outer 2 Rows of Pads: of each component's pads, those in its two outermost rows or columns. */
export function outerRows(pads: PcbPad[], rows = 2): PcbPad[] {
  const by = new Map<number, PcbPad[]>();
  for (const p of pads) by.set(p.component, [...(by.get(p.component) ?? []), p]);
  const out: PcbPad[] = [];
  for (const [c, ps] of by) {
    if (c === NO_NET) { out.push(...ps); continue; }
    const xs = [...new Set(ps.map((p) => Math.round(p.at.x / 100)))].sort((a, b) => a - b), ys = [...new Set(ps.map((p) => Math.round(p.at.y / 100)))].sort((a, b) => a - b);
    const edge = (v: number, all: number[]) => all.indexOf(v) < rows || all.indexOf(v) >= all.length - rows;
    out.push(...ps.filter((p) => edge(Math.round(p.at.x / 100), xs) || edge(Math.round(p.at.y / 100), ys)));
  }
  return out;
}

/** Pours to repour after automatic copper (they were left out of the search and pour round it). */
export function poursAround(doc: PcbDocument, r: { tracks: TrackFields[]; vias: ViaFields[]; arcs?: { c: Vec2 }[] }): number[] {
  const pts: Vec2[] = [...r.tracks.flatMap((t) => [t.a, t.b]), ...r.vias.map((v) => v.at), ...(r.arcs ?? []).map((a) => a.c)];
  return doc.polygons.filter((pg) => !pg.bag.bool('SHELVED') && pts.some((q) => pointInPoly(q, pg.outline))).map((pg) => pg.index);
}
