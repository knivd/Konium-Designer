/**
 * Preferences › Interactive Routing › Hugging Style, applied to a route as it is placed:
 * Mitered With Lines (the corners as routed), Mitered With Arcs (each corner an arc of the radius
 * its shorter leg allows), Rounded (where the route hugs a round object — a via, a round pad, a
 * hole — the corners round it become one arc about its centre, at the clearance) [est: AD17 shows
 * them while routing; Konium on placing].
 */
import type { Vec2 } from '../core/geom';
import type { RouteWorld, RItem } from './router';
import type { TrackFields } from '../formats/altium/pcbdoc';
import type { LayerId } from './layers';

export type HugStyle = 'lines' | 'arcs' | 'rounded';
export interface ArcOut { layer: LayerId; c: Vec2; r: number; start: number; end: number; width: number; net?: number }

const DEG = 180 / Math.PI;
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const unit = (v: Vec2) => { const l = len(v) || 1; return { x: v.x / l, y: v.y / l }; };
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

/** The foot of the perpendicular from c to the line through a, b, and where it falls along a→b (0…1). */
function foot(c: Vec2, a: Vec2, b: Vec2): { p: Vec2; t: number; d: number } {
  const ab = sub(b, a), l2 = ab.x * ab.x + ab.y * ab.y || 1;
  const t = ((c.x - a.x) * ab.x + (c.y - a.y) * ab.y) / l2;
  const p = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { p, t, d: len(sub(c, p)) };
}

/** An arc about c from p0 to p1, turning anticlockwise (`ccw`) or clockwise, as Altium stores it (anticlockwise from start to end, degrees). */
function arcOf(c: Vec2, p0: Vec2, p1: Vec2, r: number, ccw: boolean, layer: LayerId, width: number, net?: number): ArcOut {
  let a0 = Math.atan2(p0.y - c.y, p0.x - c.x) * DEG, a1 = Math.atan2(p1.y - c.y, p1.x - c.x) * DEG;
  if (!ccw) [a0, a1] = [a1, a0];
  return { layer, c: rnd(c), r: Math.round(r), start: ((a0 % 360) + 360) % 360, end: ((a1 % 360) + 360) % 360, width, net };
}

/** Points along an arc (for the clearance check). */
function arcPts(a: ArcOut): Vec2[] {
  const sweep = ((a.end - a.start) % 360 + 360) % 360;
  // Chords of a degree or two: they cut inside the arc by next to nothing
  const n = Math.max(8, Math.ceil(sweep / 1.5));
  return Array.from({ length: n + 1 }, (_, k) => { const t = (a.start + (sweep * k) / n) / DEG; return { x: a.c.x + a.r * Math.cos(t), y: a.c.y + a.r * Math.sin(t) }; });
}

/** The round objects of other nets on the layer a route can hug. */
function roundThings(w: RouteWorld, net: number): RItem[] {
  return w.items.filter((it) => it.g.t === 'circle' && w.blocks(net, it) && it.kind !== 'route' && it.g.r > 0);
}

/**
 * A route's tracks (one net) with its corners styled: tracks shortened to the arcs' ends and the
 * arcs. `worldOf` gives the obstacles of a layer (for Rounded and the clearance checks).
 */
export function styleCorners(segs: TrackFields[], style: HugStyle, worldOf: (l: LayerId) => RouteWorld | null, opts: { radius?: number } = {}): { tracks: TrackFields[]; arcs: ArcOut[] } {
  if (style === 'lines' || segs.length < 2) return { tracks: segs, arcs: [] };
  const tracks: TrackFields[] = [], arcs: ArcOut[] = [];
  // Runs of joined segments on one layer, one width
  let i = 0;
  while (i < segs.length) {
    let j = i;
    while (j + 1 < segs.length && segs[j + 1]!.layer === segs[i]!.layer && segs[j + 1]!.width === segs[i]!.width && same(segs[j + 1]!.a, segs[j]!.b)) j++;
    const run = segs.slice(i, j + 1);
    const out = styleRun(run, style, worldOf(run[0]!.layer), opts.radius);
    tracks.push(...out.tracks); arcs.push(...out.arcs);
    i = j + 1;
  }
  return { tracks, arcs };
}

function styleRun(run: TrackFields[], style: HugStyle, w: RouteWorld | null, radius?: number): { tracks: TrackFields[]; arcs: ArcOut[] } {
  const { layer, width, net } = run[0]!;
  const n = net ?? -1;
  const pts = [run[0]!.a, ...run.map((s) => s.b)];
  if (pts.length < 3) return { tracks: run, arcs: [] };
  // No world (lines): no clearance to keep
  const clearArc = (a: ArcOut) => !w || w.clear(n, width, arcPts(a), {});
  // Each corner: its arc (tangent points on the legs either side) or none
  type Fillet = { t0: Vec2; t1: Vec2; arc: ArcOut; ccw: boolean; circle?: number };
  /** null: a sharp corner; 'merged': taken into the next corner's arc. */
  const fillets: (Fillet | null | 'merged')[] = pts.map(() => null);
  const things = style === 'rounded' && w ? roundThings(w, n) : [];
  for (let k = 1; k + 1 < pts.length; k++) {
    const p0 = pts[k - 1]!, p = pts[k]!, p1 = pts[k + 1]!;
    const d0 = unit(sub(p, p0)), d1 = unit(sub(p1, p));
    const turn = Math.acos(Math.max(-1, Math.min(1, d0.x * d1.x + d0.y * d1.y)));
    if (turn < 0.02 || turn > Math.PI - 0.02) continue;
    const ccw = d0.x * d1.y - d0.y * d1.x > 0;
    if (style === 'rounded') {
      // A round object both legs hug: the arc about its centre at the clearance radius
      let best: Fillet | null = null;
      for (const it of things) {
        if (it.g.t !== 'circle') continue;
        const c = it.g.c, R = it.g.r + w!.gap(n, it) + width / 2, tol = Math.max(30_000, R * 0.06);
        const f0 = foot(c, p0, p), f1 = foot(c, p, p1);
        if (Math.abs(f0.d - R) > tol || Math.abs(f1.d - R) > tol || f0.t < -0.01 || f0.t > 1.01 || f1.t < -0.01 || f1.t > 1.01) continue;
        if (len(sub(p, c)) <= R) continue;
        // Just outside the clearance (as the router keeps it)
        const arc = arcOf(c, f0.p, f1.p, Math.max(f0.d, f1.d, R + 150), ccw, layer, width, net);
        if (!best) best = { t0: rnd(f0.p), t1: rnd(f1.p), arc, ccw, circle: it.id };
      }
      if (best && clearArc(best.arc)) { fillets[k] = best; continue; }
    }
    // A fillet: Rounded as large as the legs allow (half the shorter), Mitered With Arcs a few widths,
    // a radius asked for (the arc corner modes) as it is; smaller where the larger one isn't clear
    const legMax = Math.min(len(sub(p, p0)), len(sub(p1, p))) / 2;
    const tan = Math.tan(turn / 2);
    const legs = radius ? [Math.min(legMax, radius * tan), Math.min(legMax, radius * tan) / 2] : style === 'rounded' ? [legMax, legMax / 2, legMax / 4] : [Math.min(legMax, 4 * width), Math.min(legMax, 2 * width)];
    for (const leg of legs) {
      if (leg < 5_000 || tan < 1e-6) break;
      const R = leg / tan;
      const t0 = { x: p.x - d0.x * leg, y: p.y - d0.y * leg }, t1 = { x: p.x + d1.x * leg, y: p.y + d1.y * leg };
      const nrm = { x: -d0.y, y: d0.x }, side = Math.sign(d0.x * d1.y - d0.y * d1.x) || 1;
      const c = { x: t0.x + nrm.x * R * side, y: t0.y + nrm.y * R * side };
      const arc = arcOf(c, t0, t1, R, ccw, layer, width, net);
      if (clearArc(arc)) { fillets[k] = { t0: rnd(t0), t1: rnd(t1), arc, ccw }; break; }
    }
  }
  // Rounded: neighbouring corners round the same object become one arc
  if (style === 'rounded') {
    for (let k = 1; k + 2 < pts.length; k++) {
      const a = fillets[k], b = fillets[k + 1];
      if (!a || a === 'merged' || !b || b === 'merged' || a.circle === undefined || a.circle !== b.circle || a.ccw !== b.ccw) continue;
      const merged: Fillet = { t0: a.t0, t1: b.t1, arc: arcOf(a.arc.c, a.t0, b.t1, a.arc.r, a.ccw, layer, width, net), ccw: a.ccw, circle: a.circle };
      const sweep = ((merged.arc.end - merged.arc.start) % 360 + 360) % 360;
      if (sweep > 300 || !clearArc(merged.arc)) continue;
      fillets[k] = 'merged'; fillets[k + 1] = merged;
    }
  }
  // The legs between the arcs
  const tracks: TrackFields[] = [], arcs: ArcOut[] = [];
  let from = pts[0]!;
  for (let k = 1; k + 1 < pts.length; k++) {
    const f = fillets[k];
    if (f === 'merged') continue;
    const to = f ? f.t0 : pts[k]!;
    if (len(sub(to, from)) > 2) tracks.push({ ...run[0]!, a: from, b: to });
    if (f) { arcs.push(f.arc); from = f.t1; } else from = pts[k]!;
  }
  const last = pts.at(-1)!;
  if (len(sub(last, from)) > 2) tracks.push({ ...run[0]!, a: from, b: last });
  return { tracks, arcs };
}
