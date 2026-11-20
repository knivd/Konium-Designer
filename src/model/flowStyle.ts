/**
 * The free-flowing routing style (26.194): a route as a rubber band would lie. It takes the
 * direct way at any angle from end to end, leaning on what it passes at its clearance, and each
 * bend is an arc as large as the room allows, so tracks curve round pads and vias instead of
 * turning corners beside them. What it is good for: the route is as short as its way allows, no
 * two tracks run parallel for long unless they must (less crosstalk), there is no corner to
 * disturb a microwave line's impedance, a track crosses the glass weave at many angles (less
 * fibre-weave skew), and a flexible board has no corner for a crack to start at.
 *
 * One stretch of a route on one layer, given as a clear polyline (the tracks of a route that is
 * there, or one the autorouter has just made), is shaped in two steps:
 *  - `taut`: pulled tight at any angle (router.ts `pull`), then each bend moved in towards the
 *    straight line between its neighbours as far as the clearance lets it, over and over, until
 *    the path rests against what it passes;
 *  - `fillet`: each bend that is left becomes the largest arc that keeps the clearance (a bend
 *    round a pad's corner, a via or a round pad becomes the arc about it).
 * The ends stay where they are, and the stretch keeps its layer and width. A route is reshaped
 * after the routing, not while it is searched for: a track that takes the direct way while others
 * are still to come walls them in, and one shaped once they are all there costs none of them
 * its way (reflow.ts).
 */
import type { Vec2 } from '../core/geom';
import type { LayerId } from './layers';
import { pull, simplify, type Look, type RouteWorld } from './router';
import type { ArcOut } from './hugStyle';

/** A piece of a shaped path, in the order the path runs: a straight line, or an arc about c from a to b. */
export type FlowPiece = { kind: 'line'; a: Vec2; b: Vec2 } | { kind: 'arc'; a: Vec2; b: Vec2; c: Vec2; r: number; ccw: boolean };

const DEG = 180 / Math.PI;
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** How far inside the arc its chords may lie (document units): well within what the design rule check allows a measure. */
const SAG = 40;
/** Points along an arc piece (for the clearance check, and as the arc's stand-in among the obstacles): chords that cut inside the arc by no more than `sag`. */
export function arcPoints(p: Extract<FlowPiece, { kind: 'arc' }>, sag = SAG): Vec2[] {
  let a0 = Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x), a1 = Math.atan2(p.b.y - p.c.y, p.b.x - p.c.x);
  if (p.ccw) { while (a1 < a0) a1 += 2 * Math.PI; } else { while (a1 > a0) a1 -= 2 * Math.PI; }
  const step = Math.min(0.1, 2 * Math.acos(Math.max(0, 1 - sag / Math.max(p.r, sag))));
  const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) / step));
  return Array.from({ length: n + 1 }, (_, k) => { const t = a0 + ((a1 - a0) * k) / n; return { x: p.c.x + p.r * Math.cos(t), y: p.c.y + p.r * Math.sin(t) }; });
}

/** An arc piece as the board stores an arc: anticlockwise from start to end, in degrees. */
export function arcOut(p: Extract<FlowPiece, { kind: 'arc' }>, layer: LayerId, width: number, net?: number): ArcOut {
  let a0 = Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x) * DEG, a1 = Math.atan2(p.b.y - p.c.y, p.b.x - p.c.x) * DEG;
  if (!p.ccw) [a0, a1] = [a1, a0];
  return { layer, c: rnd(p.c), r: Math.round(p.r), start: ((a0 % 360) + 360) % 360, end: ((a1 % 360) + 360) % 360, width, net };
}

/** How much of a leg a bend's arc may take: half of one it shares with the next bend, three quarters of one that ends the path (the track leaves its pad straight). */
const SHARE_INNER = 0.5, SHARE_END = 0.75;

/** A clear polyline pulled tight at any angle and rested against what it passes: its ends stay, every step keeps the clearance. */
export function taut(w: RouteWorld, net: number, width: number, pts0: Vec2[], o: Look = {}): Vec2[] {
  let pts = simplify(pts0.map(rnd));
  const clear = (run: Vec2[]) => w.clear(net, width, run, o);
  if (pts.length > 2) {
    pts = pull(w, net, width, pts, 0, o);
    // Each bend in towards the line between its neighbours, as far as it stays clear
    for (let pass = 0; pass < 8; pass++) {
      let moved = 0;
      for (let k = 1; k + 1 < pts.length; k++) {
        const a = pts[k - 1]!, v = pts[k]!, b = pts[k + 1]!;
        if (!clear([a, v, b])) continue;
        const ab = sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y;
        if (l2 < 4) continue;
        const t = Math.max(0, Math.min(1, ((v.x - a.x) * ab.x + (v.y - a.y) * ab.y) / l2));
        const m = { x: a.x + ab.x * t, y: a.y + ab.y * t }, d = len(sub(m, v));
        if (d < 200) continue;
        const at = (s: number) => rnd({ x: v.x + (m.x - v.x) * s, y: v.y + (m.y - v.y) * s });
        let lo = 0, hi = 1;
        if (clear([a, at(1), b])) lo = 1;
        else for (let it = 0; it < 14 && (hi - lo) * d > 100; it++) { const mid = (lo + hi) / 2; if (clear([a, at(mid), b])) lo = mid; else hi = mid; }
        if (lo * d < 100) continue;
        pts[k] = at(lo); moved = Math.max(moved, lo * d);
      }
      pts = simplify(pts);
      if (pts.length > 2) pts = pull(w, net, width, pts, 0, o);
      if (moved < 1000) break;
    }
  }
  return pts;
}

/** A polyline's bends made arcs: each the largest, tangent to its two legs, that keeps the clearance. */
export function fillet(w: RouteWorld, net: number, width: number, pts: Vec2[], o: Look = {}): FlowPiece[] {
  if (pts.length < 2) return [];
  if (pts.length < 3) return [{ kind: 'line', a: pts[0]!, b: pts.at(-1)! }];
  const clear = (run: Vec2[]) => w.clear(net, width, run, o);
  const n = pts.length;
  const fillets: (Extract<FlowPiece, { kind: 'arc' }> | null)[] = pts.map(() => null);
  for (let k = 1; k + 1 < n; k++) {
    const p0 = pts[k - 1]!, p = pts[k]!, p1 = pts[k + 1]!;
    const l0 = len(sub(p, p0)), l1 = len(sub(p1, p));
    if (l0 < 2 || l1 < 2) continue;
    const d0 = { x: (p.x - p0.x) / l0, y: (p.y - p0.y) / l0 }, d1 = { x: (p1.x - p.x) / l1, y: (p1.y - p.y) / l1 };
    const turn = Math.acos(Math.max(-1, Math.min(1, d0.x * d1.x + d0.y * d1.y)));
    if (turn < 0.02 || turn > Math.PI - 0.02) continue;
    const tan = Math.tan(turn / 2), side = Math.sign(d0.x * d1.y - d0.y * d1.x) || 1;
    const legMax = Math.min(l0 * (k === 1 ? SHARE_END : SHARE_INNER), l1 * (k === n - 2 ? SHARE_END : SHARE_INNER));
    // Not smaller than the track is wide: an arc of less is a corner
    const legMin = width * tan;
    if (legMax < legMin) continue;
    const make = (leg: number): Extract<FlowPiece, { kind: 'arc' }> => {
      const R = leg / tan, t0 = { x: p.x - d0.x * leg, y: p.y - d0.y * leg }, t1 = { x: p.x + d1.x * leg, y: p.y + d1.y * leg };
      return { kind: 'arc', a: rnd(t0), b: rnd(t1), c: { x: t0.x - d0.y * R * side, y: t0.y + d0.x * R * side }, r: R, ccw: side > 0 };
    };
    const ok = (leg: number) => clear(arcPoints(make(leg)));
    if (ok(legMax)) { fillets[k] = make(legMax); continue; }
    if (!ok(legMin)) continue;
    let lo = legMin, hi = legMax;
    for (let it = 0; it < 12 && hi - lo > 500; it++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
    fillets[k] = make(lo);
  }
  const out: FlowPiece[] = [];
  let from = pts[0]!;
  for (let k = 1; k + 1 < n; k++) {
    const f = fillets[k];
    const to = f ? f.a : pts[k]!;
    if (len(sub(to, from)) > 2) out.push({ kind: 'line', a: from, b: to });
    if (f) { out.push(f); from = f.b; } else from = pts[k]!;
  }
  if (len(sub(pts[n - 1]!, from)) > 2) out.push({ kind: 'line', a: from, b: pts[n - 1]! });
  return out;
}

/** The whole shaping of one stretch: pulled tight, rested, its bends made arcs. */
export const flowPath = (w: RouteWorld, net: number, width: number, pts: Vec2[], o: Look = {}): FlowPiece[] => fillet(w, net, width, taut(w, net, width, pts, o), o);

/** The pieces' length. */
export function flowLength(pieces: FlowPiece[]): number {
  let s = 0;
  for (const p of pieces) {
    if (p.kind === 'line') { s += len(sub(p.b, p.a)); continue; }
    let sweep = Math.atan2(p.b.y - p.c.y, p.b.x - p.c.x) - Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x);
    if (p.ccw) { while (sweep < 0) sweep += 2 * Math.PI; } else { while (sweep > 0) sweep -= 2 * Math.PI; }
    s += Math.abs(sweep) * p.r;
  }
  return s;
}
