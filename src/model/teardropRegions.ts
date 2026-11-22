/**
 * Tools › Teardrops as the desktop software makes them: each teardrop a
 * copper region on the track's layer, marked as a teardrop, where a track runs into a via or a
 * pad, where a track changes width, and where a track ends on another (a T-junction).
 *
 * The geometry of the first two is taken from a board saved by the desktop software with its
 * default settings [checked: one board; vias of 0.6 mm and SMD pads of 0.65 × 1.75 mm on 10 mil
 * tracks; the numbers agree to 0.01 mil]:
 *  - Via or through-hole pad (round, diameter d): the wide end lies on the pad's edge, a chord of
 *    `width` % of d; the narrow end is the track's own width, `length` % of d along the track from
 *    where the track's edge leaves the pad. Each side is a quadratic curve from the narrow end,
 *    tangent to the track's edge there, to the wide end, tangent to the pad's edge there (its
 *    control point is where the track's edge line meets the pad's tangent), drawn as 11 points.
 *  - SMD pad (track width w): the wide end lies on the pad's edge, `width` % of w wide; the narrow
 *    end is `length` % of w along the track; the same curve, whose control point is then the
 *    corner between the track's edge and the pad's.
 * A track's change of width and a T-junction follow the settings window's own drawings [est: no
 * board of the desktop software's was at hand for them].
 */
import type { Vec2 } from '../core/geom';
import { distToSegment, pointInPoly } from '../core/geom';
import { L, isSignal, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbRegion, type PcbTrack, type PcbVia } from './pcb';
import { checkCopper, padGeom } from './drc';
import type { TeardropSettings } from '../core/teardropSettings';

export { TEARDROP_DEFAULTS, cleanTeardropSettings, type TeardropSettings } from '../core/teardropSettings';

export type TeardropKind = 'via' | 'pad' | 'smd' | 'tracks' | 'tJunction';
export interface PlannedTeardrop { layer: LayerId; net: number; outline: Vec2[]; kind: TeardropKind; at: Vec2 }
export interface TeardropFailure { at: Vec2; kind: TeardropKind; why: 'clearance' | 'room' }
export interface TeardropRegionPlan { made: PlannedTeardrop[]; failed: TeardropFailure[]; smaller: number }

/** How many points a curved side is drawn with (the desktop software's own count). */
export const TEARDROP_POINTS = 11;
/** The wide end at an SMD pad lies this far inside the pad's edge, so that the two always join (0.12 mil, as on the board read). */
const INSIDE = 1200;

export type V2 = { u: number; v: number };
/** A side: from the narrow end `p0` to the wide end `q`, curved by the control point `c` or straight. */
function side(p0: V2, c: V2, q: V2, style: TeardropSettings['style']): V2[] {
  if (style === 'line') return [p0, q];
  const out: V2[] = [];
  for (let i = 0; i < TEARDROP_POINTS; i++) {
    const t = i / (TEARDROP_POINTS - 1), a = (1 - t) * (1 - t), b = 2 * t * (1 - t), d = t * t;
    out.push({ u: a * p0.u + b * c.u + d * q.u, v: a * p0.v + b * c.v + d * q.v });
  }
  return out;
}
/** The two sides as one outline: up one side to the wide end, back down the other. */
const outlineOf = (plus: V2[], minus: V2[], at: (p: V2) => Vec2): Vec2[] => [...plus.map(at), ...[...minus].reverse().map(at)];

/**
 * A teardrop at a round pad in the track's own frame (u along the track away from the pad, v
 * across it; the pad's centre at the origin, the track's centre line at v = `o`).
 * Null where the track is not narrower than the chord asked for, or lies off the pad.
 */
export function roundTeardrop(r: number, w: number, o: number, widthPct: number, lengthPct: number, style: TeardropSettings['style']): { plus: V2[]; minus: V2[]; reach: number } | null {
  const d = 2 * r, W = Math.min((widthPct / 100) * d, d * 0.99), Len = (lengthPct / 100) * d;
  if (W <= w * 1.02) return null;
  const sides: V2[][] = [];
  let reach = 0;
  for (const s of [1, -1] as const) {
    const ve = o + (s * w) / 2, vq = Math.max(-r * 0.995, Math.min(r * 0.995, o + (s * W) / 2));
    if (Math.abs(ve) >= r * 0.995) return null;
    const ue = Math.sqrt(r * r - ve * ve), uq = Math.sqrt(r * r - vq * vq);
    const p0 = { u: ue + Len, v: ve }, q = { u: uq, v: vq };
    // (the pad's tangent at q is u·uq + v·vq = r²: where it meets the track's edge line v = ve)
    const c = { u: (r * r - vq * ve) / uq, v: ve };
    // (a track well off the pad's centre, or a chord nearly the pad's whole width, puts that point beyond the narrow end: then the side is straight)
    sides.push(c.u > p0.u ? [p0, q] : side(p0, c, q, style));
    reach = Math.max(reach, p0.u);
  }
  return { plus: sides[0]!, minus: sides[1]!, reach };
}

/**
 * A teardrop where the track leaves a pad of any other shape (`pts`: the pad's outline in the
 * track's frame, the track's centre line at v = `o`): the wide end `W` across on the pad's edge,
 * the narrow end `Len` along the track. Null where the pad's edge is too short for it.
 */
export function edgeTeardrop(pts: V2[], w: number, o: number, W: number, Len: number, style: TeardropSettings['style'], inside = INSIDE): { plus: V2[]; minus: V2[]; reach: number } | null {
  /** Where the line v = const leaves the outline, farthest along the track, and the edge's direction there. */
  const exit = (v: number): { u: number; du: number; dv: number } | null => {
    let best: { u: number; du: number; dv: number } | null = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if ((a.v - v) * (b.v - v) > 0 || a.v === b.v) continue;
      const t = (v - a.v) / (b.v - a.v), u = a.u + (b.u - a.u) * t;
      if (!best || u > best.u) best = { u, du: b.u - a.u, dv: b.v - a.v };
    }
    return best;
  };
  if (W <= w * 1.02) return null;
  const sides: V2[][] = [];
  let reach = 0;
  for (const s of [1, -1] as const) {
    const ve = o + (s * w) / 2, e = exit(ve);
    if (!e) return null;
    // (no wider than the pad's edge reaches on this side)
    let half = W / 2, x = exit(o + s * half);
    for (let k = 0; k < 12 && !x; k++) { half = w / 2 + (half - w / 2) * 0.8; x = exit(o + s * half); }
    if (!x || half <= (w / 2) * 1.02) return null;
    const q = { u: x.u - inside, v: o + s * half }, p0 = { u: e.u - inside + Len, v: ve };
    // (the edge's own line through q: where it meets the track's edge line; an edge along the track has no such point)
    const c = Math.abs(x.dv) > 1e-6 * Math.hypot(x.du, x.dv) ? { u: q.u + (x.du * (ve - q.v)) / x.dv, v: ve } : { u: (p0.u + q.u) / 2, v: ve };
    // (a slanted edge may put that point beyond the narrow end: then the side is straight)
    sides.push(c.u > p0.u ? [p0, q] : side(p0, c, q, style));
    reach = Math.max(reach, p0.u);
  }
  return { plus: sides[0]!, minus: sides[1]!, reach };
}

/**
 * A teardrop where a track of width `w` runs on from a wider one of width `wide` (the join at the
 * origin, the narrower track along u): `Len` along the narrower track, its wide end `W` across.
 */
export function stepTeardrop(w: number, W: number, Len: number, style: TeardropSettings['style']): { plus: V2[]; minus: V2[]; reach: number } {
  const sides = ([1, -1] as const).map((sg) => side({ u: Len, v: (sg * w) / 2 }, { u: 0, v: (sg * w) / 2 }, { u: 0, v: (sg * W) / 2 }, style));
  return { plus: sides[0]!, minus: sides[1]!, reach: Len };
}

/**
 * The fillet where a track of width `wb` ends square on one of width `wa` (u along the track it
 * ends on, v up the track that ends, the join at the origin): `half` either side along the one,
 * `H` up the other from the one's edge. Null where it would be no wider than the track itself.
 */
export function teeTeardrop(wa: number, wb: number, half: number, H: number, style: TeardropSettings['style'], inside = INSIDE): { plus: V2[]; minus: V2[] } | null {
  if (half <= (wb / 2) * 1.05 || H <= 0) return null;
  const base = wa / 2 - Math.min(inside, wa / 4);
  const sides = ([1, -1] as const).map((sg) => side({ u: (sg * wb) / 2, v: wa / 2 + H }, { u: (sg * wb) / 2, v: base }, { u: sg * half, v: base }, style));
  return { plus: sides[0]!, minus: sides[1]! };
}

/** A hair outside the copper at a joint (0.05 mil): where a joint's teardrop is looked for. */
const NEAR = 500;
/** Where the line v = const leaves an outline, farthest along the track. */
function leaves(pts: V2[], v: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    if ((a.v - v) * (b.v - v) > 0 || a.v === b.v) continue;
    const u = a.u + ((b.u - a.u) * (v - a.v)) / (b.v - a.v);
    if (best === null || u > best) best = u;
  }
  return best;
}

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3;
const region = (t: PlannedTeardrop): PcbRegion => ({ kind: 'region', src: { storage: 'Regions6', index: -1 }, layer: t.layer, outline: t.outline, holes: [], regionKind: 0, boardCutout: false, net: t.net, polygon: NO_NET, component: NO_NET, locked: false, keepout: false, teardrop: true });

/** The teardrops on the board: the regions marked as such. */
export const teardropRegions = (doc: PcbDocument): PcbRegion[] => doc.prims.filter((p): p is PcbRegion => p.kind === 'region' && !!p.teardrop);

/** A pad's shape on a layer, and whether a pad or via has copper there. */
const padLayer = (p: PcbPad, layer: LayerId) => { const st = layer === L.TOP || p.layer === L.TOP ? p.top : layer === L.BOTTOM || p.layer === L.BOTTOM ? p.bot : p.mid; return st.w > 0 && st.h > 0 ? st : p.top; };
const onLayer = (h: PcbPad | PcbVia, layer: LayerId) => (h.kind === 'via' ? Math.min(h.layerStart, h.layerEnd) <= layer && layer <= Math.max(h.layerStart, h.layerEnd) : h.layer === L.MULTI || h.layer === layer);

/**
 * The teardrops that belong to the objects given: those among them, and those that touch a pad,
 * a via or a track among them (a teardrop's wide end lies on the pad it widens to, its narrow
 * end on the track).
 */
export function teardropsAt(doc: PcbDocument, among: Set<PcbPrim>): PcbRegion[] {
  const tol = 2000, objs = [...among];
  const touches = (r: PcbRegion, p: PcbPrim): boolean => {
    if (p.kind === 'via') return onLayer(p, r.layer) && r.outline.some((v) => Math.hypot(v.x - p.at.x, v.y - p.at.y) <= p.diameter / 2 + tol);
    if (p.kind === 'track') return p.layer === r.layer && r.outline.some((v) => distToSegment(v, p.a, p.b) <= p.width / 2 + tol);
    if (p.kind !== 'pad' || !onLayer(p, r.layer)) return false;
    const g = padGeom(p, padLayer(p, r.layer));
    if (!g) return false;
    return r.outline.some((v) => (g.t === 'poly' ? pointInPoly(v, g.pts) : g.t === 'circle' ? Math.hypot(v.x - g.c.x, v.y - g.c.y) <= g.r + tol : distToSegment(v, g.a, g.b) <= g.r + tol));
  };
  return teardropRegions(doc).filter((r) => among.has(r) || objs.some((p) => touches(r, p)));
}

/** The teardrops to add. `selected`: with Selected only, the pads, vias and tracks whose joints get them. */
export function planTeardropRegions(doc: PcbDocument, s: TeardropSettings, selected?: Set<PcbPrim>): TeardropRegionPlan {
  const plan: TeardropRegionPlan = { made: [], failed: [], smaller: 0 };
  const there = teardropRegions(doc);
  /**
   * Whether a joint has its teardrop already: a teardrop on the layer that holds one of the points given. The points
   * are taken a hair (`NEAR`) outside the copper at the joint itself, where a teardrop of any size lies.
   */
  const has = (layer: LayerId, ...ps: Vec2[]) => ps.some((p) => there.some((r) => r.layer === layer && pointInPoly(p, r.outline)) || plan.made.some((r) => r.layer === layer && pointInPoly(p, r.outline)));
  const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && isSignal(p.layer) && p.polygon === NO_NET && p.component === NO_NET && !p.keepout && p.width > 0);
  const holders = doc.prims.filter((p): p is PcbPad | PcbVia => p.kind === 'pad' || p.kind === 'via');
  const want = (...ps: PcbPrim[]) => !selected || ps.some((p) => selected.has(p));
  /**
   * A teardrop tried at its full size, then (Adjust teardrop size) at smaller ones, for the first that has room on its
   * track and keeps its clearances. Where none keeps them, Force teardrops makes the largest that has room all the same.
   */
  const settle = (kind: TeardropKind, at: Vec2, layer: LayerId, net: number, room: number, make: (scale: number) => { outline: Vec2[]; reach: number } | null): void => {
    let why: TeardropFailure['why'] = 'room', forced: { t: PlannedTeardrop; scale: number } | null = null;
    for (const scale of s.adjust ? [1, 0.8, 0.6, 0.45, 0.3] : [1]) {
      const m = make(scale);
      // (a track as wide as the pad it runs into, or wider, has no joint to widen: nothing made, nothing failed)
      if (!m) { if (scale === 1 && kind !== 'tJunction') return; continue; }
      if (m.reach > room) { why = 'room'; continue; }
      const t: PlannedTeardrop = { layer, net, outline: m.outline.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })), kind, at };
      // (copper of no net has no clearance to its own pad to keep: it is made as the desktop software makes it)
      if (net !== NO_NET && checkCopper(doc, [region(t)], { ignorePours: true, clearanceOnly: true }).length) { why = 'clearance'; forced ??= { t, scale }; continue; }
      plan.made.push(t);
      if (scale < 1) plan.smaller++;
      return;
    }
    if (s.force && forced) { plan.made.push(forced.t); if (forced.scale < 1) plan.smaller++; return; }
    plan.failed.push({ at, kind, why });
  };

  // Where a track runs into a via or a pad
  const jointed = new Set<string>();
  for (const t of tracks) {
    for (const [end, far] of [[t.a, t.b], [t.b, t.a]] as const) {
      const len = Math.hypot(far.x - end.x, far.y - end.y);
      if (len < 1) continue;
      const d = { x: (far.x - end.x) / len, y: (far.y - end.y) / len }, n = { x: -d.y, y: d.x };
      const h = holders.find((p) => p.net === t.net && onLayer(p, t.layer) && Math.hypot(p.at.x - end.x, p.at.y - end.y) <= (p.kind === 'via' ? p.diameter / 2 : Math.max(padLayer(p, t.layer).w, padLayer(p, t.layer).h) / 2)
        && (p.kind === 'via' || (() => { const g = padGeom(p, padLayer(p, t.layer)); return !!g && (g.t === 'poly' ? pointInPoly(end, g.pts) : g.t === 'circle' ? Math.hypot(end.x - g.c.x, end.y - g.c.y) <= g.r : distToSegment(end, g.a, g.b) <= g.r); })()));
      if (!h) continue;
      jointed.add(`${t.layer}:${Math.round(end.x)}:${Math.round(end.y)}`);
      // (a track that never leaves the pad has no joint to widen)
      if (!want(h, t) || Math.hypot(far.x - h.at.x, far.y - h.at.y) <= (h.kind === 'via' ? h.diameter / 2 : Math.min(padLayer(h, t.layer).w, padLayer(h, t.layer).h) / 2)) continue;
      // The track's frame: its centre line through the pad's centre, or beside it by `o`
      const o = (end.x - h.at.x) * n.x + (end.y - h.at.y) * n.y, u0 = (end.x - h.at.x) * d.x + (end.y - h.at.y) * d.y;
      const at = (p: V2): Vec2 => ({ x: h.at.x + d.x * p.u + n.x * p.v, y: h.at.y + d.y * p.u + n.y * p.v });
      const room = u0 + len;
      const st = h.kind === 'pad' ? padLayer(h, t.layer) : null;
      const g = h.kind === 'pad' ? padGeom(h, st!) : null;
      const round = h.kind === 'via' || (g?.t === 'circle');
      const through = h.kind === 'via' || h.hole > 0;
      const kind: TeardropKind = h.kind === 'via' ? 'via' : through ? 'pad' : 'smd';
      if (through ? !s.viaPad.on : !s.smd.on) continue;
      const r = h.kind === 'via' ? h.diameter / 2 : g?.t === 'circle' ? g.r : 0;
      // (looked for where the track's centre line leaves the pad)
      if (round && has(t.layer, at({ u: Math.sqrt(Math.max(0, r * r - o * o)) + NEAR, v: o }))) continue;
      if (round) {
        settle(kind, h.at, t.layer, t.net, room, (k) => {
          const m = roundTeardrop(r, t.width, o, t.width / (2 * r) * 100 + (s.viaPad.width - t.width / (2 * r) * 100) * k, s.viaPad.length * k, s.style);
          return m && { outline: outlineOf(m.plus, m.minus, at), reach: m.reach };
        });
        continue;
      }
      if (!g) continue;
      // Any other shape: its outline in the track's frame
      const world = g.t === 'poly' ? g.pts : capsule(g.a, g.b, g.r);
      const pts = world.map((p) => ({ u: (p.x - h.at.x) * d.x + (p.y - h.at.y) * d.y, v: (p.x - h.at.x) * n.x + (p.y - h.at.y) * n.y }));
      const across = Math.max(...pts.map((p) => p.v)) - Math.min(...pts.map((p) => p.v));
      const edge = Math.max(...pts.map((p) => p.u));
      if (has(t.layer, at({ u: (leaves(pts, o) ?? edge) + NEAR, v: o }))) continue;
      // (a through-hole pad that is not round takes its per cents of the pad's own size, as a round one does of its diameter)
      const [W, Len] = through ? [(s.viaPad.width / 100) * across, (s.viaPad.length / 100) * Math.min(st!.w, st!.h)] : [(s.smd.width / 100) * t.width, (s.smd.length / 100) * t.width];
      settle(kind, h.at, t.layer, t.net, room, (k) => {
        const m = edgeTeardrop(pts, t.width, o, t.width + (W - t.width) * k, Len * k, s.style);
        return m && { outline: outlineOf(m.plus, m.minus, at), reach: m.reach };
      });
    }
  }

  // Where a track changes width: the narrower one widens to the wider one's width
  if (s.tracks.on) {
    for (const a of tracks) {
      for (const [end, far] of [[a.a, a.b], [a.b, a.a]] as const) {
        if (jointed.has(`${a.layer}:${Math.round(end.x)}:${Math.round(end.y)}`)) continue;
        const meets = tracks.filter((b) => b !== a && b.layer === a.layer && b.net === a.net && (same(b.a, end) || same(b.b, end)));
        if (meets.length !== 1) continue;
        const b = meets[0]!;
        if (b.width <= a.width * 1.05 || !want(a, b)) continue;
        const len = Math.hypot(far.x - end.x, far.y - end.y);
        if (len < 1) continue;
        const d = { x: (far.x - end.x) / len, y: (far.y - end.y) / len }, n = { x: -d.y, y: d.x };
        // (the two run on in a line, or nearly: a corner between two widths is left as it is)
        const bf = same(b.a, end) ? b.b : b.a, bl = Math.hypot(bf.x - end.x, bf.y - end.y) || 1;
        if (((bf.x - end.x) / bl) * d.x + ((bf.y - end.y) / bl) * d.y > -0.7) continue;
        const at = (p: V2): Vec2 => ({ x: end.x + d.x * p.u + n.x * p.v, y: end.y + d.y * p.u + n.y * p.v });
        // (looked for on the narrower track right at the joint, and just off its edge there)
        if (has(a.layer, at({ u: NEAR, v: 0 }), at({ u: NEAR, v: a.width / 2 + NEAR }))) continue;
        settle('tracks', end, a.layer, a.net, len, (k) => {
          const m = stepTeardrop(a.width, a.width + (b.width - a.width) * k, (s.tracks.length / 100) * b.width * k, s.style);
          return { outline: outlineOf(m.plus, m.minus, at), reach: m.reach };
        });
      }
    }
  }

  // Where a track ends on another: a fillet either side of it
  if (s.tJunction.on) {
    for (const b of tracks) {
      for (const [end, far] of [[b.a, b.b], [b.b, b.a]] as const) {
        if (jointed.has(`${b.layer}:${Math.round(end.x)}:${Math.round(end.y)}`)) continue;
        const len = Math.hypot(far.x - end.x, far.y - end.y);
        if (len < 1) continue;
        // The track it ends on: one it meets in the middle, or two that run on in a line through the point
        const mid = tracks.filter((a) => a !== b && a.layer === b.layer && a.net === b.net && !same(a.a, end) && !same(a.b, end) && distToSegment(end, a.a, a.b) < 3);
        const at2 = tracks.filter((a) => a !== b && a.layer === b.layer && a.net === b.net && (same(a.a, end) || same(a.b, end)));
        let dirA: Vec2 | null = null, wa = 0, left = 0, right = 0, parts: PcbTrack[] = [];
        if (mid.length === 1 && !at2.length) {
          const a = mid[0]!, al = Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) || 1;
          dirA = { x: (a.b.x - a.a.x) / al, y: (a.b.y - a.a.y) / al }; wa = a.width; parts = [a];
          right = Math.hypot(a.b.x - end.x, a.b.y - end.y); left = Math.hypot(a.a.x - end.x, a.a.y - end.y);
        } else if (at2.length === 2 && !mid.length && Math.abs(at2[0]!.width - at2[1]!.width) < 2) {
          const [p, q] = at2 as [PcbTrack, PcbTrack];
          const pf = same(p.a, end) ? p.b : p.a, qf = same(q.a, end) ? q.b : q.a;
          const pl = Math.hypot(pf.x - end.x, pf.y - end.y) || 1, ql = Math.hypot(qf.x - end.x, qf.y - end.y) || 1;
          if (((pf.x - end.x) / pl) * ((qf.x - end.x) / ql) + ((pf.y - end.y) / pl) * ((qf.y - end.y) / ql) > -0.98) continue;
          dirA = { x: (pf.x - end.x) / pl, y: (pf.y - end.y) / pl }; wa = p.width; right = pl; left = ql; parts = [p, q];
        }
        if (!dirA || !want(b, ...parts)) continue;
        const d = { x: (far.x - end.x) / len, y: (far.y - end.y) / len };
        // (square on, or nearly: a track that joins at a slant is left as it is)
        if (Math.abs(d.x * dirA.x + d.y * dirA.y) > 0.26) continue;
        // The frame: x along the track it ends on, y up the track that ends
        const y = { x: -dirA.y, y: dirA.x }, up = d.x * y.x + d.y * y.y > 0 ? 1 : -1;
        const at = (p: V2): Vec2 => ({ x: end.x + dirA!.x * p.u + y.x * p.v * up, y: end.y + dirA!.y * p.u + y.y * p.v * up });
        // (looked for in the corner between the two tracks, either side, and on the ending track where it leaves the other)
        if (has(b.layer, at({ u: b.width / 2 + NEAR, v: wa / 2 + NEAR }), at({ u: -b.width / 2 - NEAR, v: wa / 2 + NEAR }), at({ u: 0, v: wa / 2 + NEAR }))) continue;
        settle('tJunction', end, b.layer, b.net, Infinity, (k) => {
          const half = Math.min(((s.tJunction.span / 100) * wa * k) / 2, right * 0.98, left * 0.98), H = Math.min((s.tJunction.height / 100) * wa * k, len * 0.98 - wa / 2);
          const m = teeTeardrop(wa, b.width, half, H, s.style);
          return m && { outline: outlineOf(m.plus, m.minus, at), reach: 0 };
        });
      }
    }
  }
  return plan;
}

/** A pad with round ends as an outline (its ends in 24 steps each). */
function capsule(a: Vec2, b: Vec2, r: number): Vec2[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), out: Vec2[] = [];
  for (let i = 0; i <= 24; i++) { const t = ang - Math.PI / 2 + (Math.PI * i) / 24; out.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) }); }
  for (let i = 0; i <= 24; i++) { const t = ang + Math.PI / 2 + (Math.PI * i) / 24; out.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) }); }
  return out;
}

/** The plan's regions as board primitives (for a look before they are added, and for the checks). */
export const plannedRegions = (plan: TeardropRegionPlan): PcbRegion[] => plan.made.map(region);
