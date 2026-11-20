/**
 * Copper as the suite's SMD and Acute Angle rules see it [est, from its reports on boards Konium
 * Designer wrote]: tracks cut into pieces at their junctions on nets that own a pour, round shapes
 * as the 16-sided polygons round them, and each net's copper on a layer merged into one outline
 * whose sharp inward corners are the acute angles (acid traps).
 */
import * as ClipperNS from 'clipper-lib';
import RBush from 'rbush';
import { T, boardLength, describe, distance, padGeom, rectPoly, type Geom } from './drc';
import { NO_NET, inPour, type PcbDocument, type PcbPad, type PcbPrim } from './pcb';
import { L, isSignal, layerName, type LayerId } from './layers';
import { padShapeOn } from './padStack';
import { pointInPoly, type BBox, type Vec2 } from '../core/geom';
import { mil } from '../core/units';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;

/** A stretch of a track, between the points the suite cuts it at (the whole track where it isn't cut). */
export interface TrackPiece { i: number; a: Vec2; b: Vec2 }

export const boxOfSeg = (a: Vec2, b: Vec2, r = 0): BBox => ({ minX: Math.min(a.x, b.x) - r, minY: Math.min(a.y, b.y) - r, maxX: Math.max(a.x, b.x) + r, maxY: Math.max(a.y, b.y) + r });

type Track = Extract<PcbPrim, { kind: 'track' }>;
type Via = Extract<PcbPrim, { kind: 'via' }>;

/**
 * The tracks as the suite's SMD and Acute Angle rules take them: a net that owns a polygon pour (on
 * any layer) has its tracks cut where another of its tracks on the layer ends on one or crosses it,
 * and at the foot of the perpendicular from the centre of each of its pads and vias the track's
 * centre line passes through; the other nets' tracks are kept whole.
 */
export function trackPieces(doc: PcbDocument): TrackPiece[] {
  const poured = new Set(doc.polygons.map((g) => g.net));
  const out: TrackPiece[] = [];
  const cut: { i: number; t: Track }[] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'track' || p.net === NO_NET || inPour(p) || p.keepout || !isSignal(p.layer)) return;
    if (poured.has(p.net) && Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) > 2 * T) cut.push({ i, t: p }); else out.push({ i, a: p.a, b: p.b });
  });
  if (!cut.length) return out;
  const tracks = new RBush<BBox & { i: number; t: Track }>();
  tracks.load(cut.map((x) => ({ ...boxOfSeg(x.t.a, x.t.b), ...x })));
  // The pour nets' pads and vias, by their copper's extent
  const stops = new RBush<BBox & { at: Vec2; layer: LayerId | null; net: number; g: Geom }>();
  stops.load(doc.prims.flatMap((p) => {
    if (!('net' in p) || !poured.has(p.net)) return [];
    if (p.kind === 'via') return [{ ...boxOfSeg(p.at, p.at, p.diameter / 2), at: p.at, layer: null, net: p.net, g: { t: 'circle' as const, c: p.at, r: p.diameter / 2 } }];
    if (p.kind !== 'pad' || (p.layer !== L.MULTI && !isSignal(p.layer))) return [];
    const g = padGeom(p, p.layer === L.BOTTOM ? p.bot : p.top);
    const r = Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h, p.mid.w, p.mid.h);
    return g ? [{ ...boxOfSeg(p.at, p.at, r), at: p.at, layer: p.layer === L.MULTI ? null : p.layer, net: p.net, g }] : [];
  }));
  for (const { i, t } of cut) {
    const { a, b } = t, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const along = (q: Vec2) => ((q.x - a.x) * dx + (q.y - a.y) * dy) / (len * len);
    const inner = (s: number) => s * len > T && (1 - s) * len > T;
    const ts: number[] = [];
    for (const o of tracks.search(boxOfSeg(a, b, T))) {
      if (o.i === i || o.t.layer !== t.layer || o.t.net !== t.net) continue;
      // Another's end on this one's centre line
      for (const e of [o.t.a, o.t.b]) {
        const s = along(e);
        if (inner(s) && Math.hypot(a.x + dx * s - e.x, a.y + dy * s - e.y) <= T) ts.push(s);
      }
      // The two centre lines crossing inside both
      const ex = o.t.b.x - o.t.a.x, ey = o.t.b.y - o.t.a.y, den = dx * ey - dy * ex, ol = Math.hypot(ex, ey);
      if (Math.abs(den) < 1e-9 * len * ol) continue;
      const px = o.t.a.x - a.x, py = o.t.a.y - a.y;
      const s = (px * ey - py * ex) / den, u = (px * dy - py * dx) / den;
      if (inner(s) && u * ol > T && (1 - u) * ol > T) ts.push(s);
    }
    // The feet of the perpendiculars from the centres of the pads and vias it runs through
    for (const o of stops.search(boxOfSeg(a, b))) {
      if (o.net !== t.net || (o.layer !== null && o.layer !== t.layer)) continue;
      if (distance({ t: 'seg', a, b, r: 0 }, o.g) > 0) continue;
      const s = along(o.at);
      if (inner(s)) ts.push(s);
    }
    ts.sort((x, y) => x - y);
    let from = 0;
    for (const s of [...ts, 1]) {
      if ((s - from) * len <= T) continue;
      out.push({ i, a: from === 0 ? a : { x: a.x + dx * from, y: a.y + dy * from }, b: s === 1 ? b : { x: a.x + dx * s, y: a.y + dy * s } });
      from = s;
    }
  }
  return out;
}

/** A piece as the suite names it: the track's own words when it is the whole track. */
export function describePiece(doc: PcbDocument, q: TrackPiece): string {
  const t = doc.prims[q.i]!;
  if (t.kind === 'track' && q.a === t.a && q.b === t.b) return describe(doc, q.i);
  const o = doc.board.origin, pt = (v: Vec2) => `(${boardLength(doc, v.x - o.x)},${boardLength(doc, v.y - o.y)})`;
  const l = (t as { layer: LayerId }).layer;
  return `Track ${pt(q.a)}${pt(q.b)} on ${doc.board.layerNames.get(l) ?? layerName(l)}`;
}

/** A circle as the suite's checks take it: the 16-sided polygon round it, a corner every 22.5° from `phase` (degrees). */
export function circle16(c: Vec2, r: number, phase = 0): Vec2[] {
  const R = r / Math.cos(Math.PI / 16);
  return Array.from({ length: 16 }, (_, k) => { const a = ((phase + k * 22.5) * Math.PI) / 180; return { x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }; });
}

/** The convex hull of points (counter-clockwise). */
function hull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Vec2[] = [], up: Vec2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (let k = p.length - 1; k >= 0; k--) { const q = p[k]!; while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
/** A stroke (track, or a chord of an arc) with round ends, as a polygon. */
const stroke = (a: Vec2, b: Vec2, r: number): Vec2[] => hull([...circle16(a, r), ...circle16(b, r)]);

/** A pad's copper on a layer as the suite's checks take it: rectangles as they are, round ends as 16-sided polygons. */
export function padOutline(p: PcbPad, st: PcbPad['top']): Geom | null {
  if (st.w <= 0 || st.h <= 0) return null;
  if (st.shape === 'round') {
    if (Math.abs(st.w - st.h) < 1) return { t: 'poly', pts: circle16(p.at, st.w / 2, p.rotation), holes: [] };
    const g = padGeom(p, st);
    if (g?.t === 'seg') return { t: 'poly', pts: hull([...circle16(g.a, g.r, p.rotation), ...circle16(g.b, g.r, p.rotation)]), holes: [] };
    return g;
  }
  return padGeom(p, st);
}

/** How far a point is inside a shape (negative outside). */
export function depthIn(g: Geom, v: Vec2): number {
  if (g.t !== 'poly') return -distance({ t: 'circle', c: v, r: 0 }, g);
  let m = Infinity;
  for (const ring of [g.pts, ...g.holes]) for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!, b = ring[(k + 1) % ring.length]!, dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const s = l2 ? Math.max(0, Math.min(1, ((v.x - a.x) * dx + (v.y - a.y) * dy) / l2)) : 0;
    m = Math.min(m, Math.hypot(v.x - a.x - dx * s, v.y - a.y - dy * s));
  }
  return pointInPoly(v, g.pts) && !g.holes.some((h) => pointInPoly(v, h)) ? m : -m;
}

/* ─── Acute Angle: the merged copper's sharp inward corners ─────────────────────────────── */

/** An object's copper on a layer, as polygons (a region's holes as their own rings). */
export interface CopperPart { prim: number; piece?: TrackPiece; rings: Vec2[][]; holes: Vec2[][] }
/** A corner of a net's merged copper where the bare board between its two edges is narrower than a right angle. */
export interface AcuteCorner { at: Vec2; angle: number; layer: LayerId; net: number; parts: [CopperPart, CopperPart] }

const viaSpans = (doc: PcbDocument, v: Via, l: LayerId) => {
  const s = doc.board.copperStack, a = s.indexOf(v.layerStart), b = s.indexOf(v.layerEnd), at = s.indexOf(l);
  return a < 0 || b < 0 || at < 0 || (at >= Math.min(a, b) && at <= Math.max(a, b));
};

/** Each net's copper parts on a copper layer (pieces for its tracks). */
export function copperParts(doc: PcbDocument, layer: LayerId, pieces: TrackPiece[], nets?: Set<number>): Map<number, CopperPart[]> {
  const by = new Map<number, CopperPart[]>();
  const add = (net: number, part: CopperPart) => {
    if (net === NO_NET || (nets && !nets.has(net)) || !part.rings.length) return;
    const l = by.get(net); if (l) l.push(part); else by.set(net, [part]);
  };
  for (const q of pieces) {
    const t = doc.prims[q.i] as Track;
    if (t.layer === layer) add(t.net, { prim: q.i, piece: q, rings: [stroke(q.a, q.b, t.width / 2)], holes: [] });
  }
  doc.prims.forEach((p, i) => {
    switch (p.kind) {
      case 'track':
        // A hatched pour's tracks (the routing's come as pieces)
        if (p.layer === layer && !p.keepout && inPour(p)) add(p.net, { prim: i, rings: [stroke(p.a, p.b, p.width / 2)], holes: [] });
        return;
      case 'arc': {
        if (p.layer !== layer || p.keepout) return;
        const sweep = (((p.end - p.start) % 360) + 360) % 360 || 360, n = Math.max(2, Math.ceil(sweep / 11.25));
        const pts = Array.from({ length: n + 1 }, (_, k) => { const a = ((p.start + (sweep * k) / n) * Math.PI) / 180; return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }; });
        add(p.net, { prim: i, rings: pts.slice(1).map((v, k) => stroke(pts[k]!, v, p.width / 2)), holes: [] });
        return;
      }
      case 'via': {
        if (!viaSpans(doc, p, layer)) return;
        const d = p.layerDiameters?.[layer - 1] ?? p.diameter;
        if (d > p.hole) add(p.net, { prim: i, rings: [circle16(p.at, d / 2)], holes: [] });
        return;
      }
      case 'pad': {
        if (p.layer !== layer && p.layer !== L.MULTI) return;
        const st = p.layer === L.MULTI ? padShapeOn(p, layer) : p.top;
        const g = st && padOutline(p, st);
        if (g?.t === 'poly') add(p.net, { prim: i, rings: [g.pts], holes: [] });
        else if (g?.t === 'circle') add(p.net, { prim: i, rings: [circle16(g.c, g.r, p.rotation)], holes: [] });
        return;
      }
      case 'fill':
        if (p.layer !== layer || p.keepout) return;
        add(p.net, { prim: i, rings: [rectPoly({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation)], holes: [] });
        return;
      case 'region':
        if (p.layer !== layer || p.keepout || p.boardCutout || p.regionKind !== 0 || p.outline.length < 3) return;
        add(p.net, { prim: i, rings: [p.outline], holes: p.holes });
        return;
    }
  });
  return by;
}

const MIN_SIDE = mil(1);

const toPath = (pts: Vec2[], positive: boolean) => {
  const path = pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) }));
  if (C.Clipper.Orientation(path) !== positive) path.reverse();
  return path;
};

/**
 * The acute corners of a net's merged copper on a layer: corners of its outline (not of bare board
 * it encloses) where the bare board between the two edges is narrower than `below` degrees and both
 * edges are 1 mil long or more, each with the two parts whose edges meet there (the same part twice
 * for a region's own corner).
 * `window`: only the copper in it is merged (big parts cut to it) and only corners inside it kept.
 */
export function acuteCorners(parts: CopperPart[], layer: LayerId, net: number, below: number, window?: BBox): AcuteCorner[] {
  const c = new C.Clipper();
  if (window) {
    const rect = toPath([{ x: window.minX, y: window.minY }, { x: window.maxX, y: window.minY }, { x: window.maxX, y: window.maxY }, { x: window.minX, y: window.maxY }], true);
    parts = parts.filter((p) => {
      let b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const r of p.rings) for (const v of r) b = { minX: Math.min(b.minX, v.x), minY: Math.min(b.minY, v.y), maxX: Math.max(b.maxX, v.x), maxY: Math.max(b.maxY, v.y) };
      if (b.maxX < window.minX || b.minX > window.maxX || b.maxY < window.minY || b.minY > window.maxY) return false;
      if (b.minX >= window.minX && b.maxX <= window.maxX && b.minY >= window.minY && b.maxY <= window.maxY) {
        for (const r of p.rings) if (r.length >= 3) c.AddPath(toPath(r, true), C.PolyType.ptSubject, true);
        for (const h of p.holes) if (h.length >= 3) c.AddPath(toPath(h, false), C.PolyType.ptSubject, true);
        return true;
      }
      // A big part (a pour's region) cut to the window
      const k = new C.Clipper();
      for (const r of p.rings) if (r.length >= 3) k.AddPath(toPath(r, true), C.PolyType.ptSubject, true);
      for (const h of p.holes) if (h.length >= 3) k.AddPath(toPath(h, false), C.PolyType.ptSubject, true);
      k.AddPath(rect, C.PolyType.ptClip, true);
      const cut: ClipperNS.Paths = [];
      k.Execute(C.ClipType.ctIntersection, cut, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
      c.AddPaths(cut, C.PolyType.ptSubject, true);
      return true;
    });
  } else {
    for (const p of parts) {
      for (const r of p.rings) if (r.length >= 3) c.AddPath(toPath(r, true), C.PolyType.ptSubject, true);
      for (const h of p.holes) if (h.length >= 3) c.AddPath(toPath(h, false), C.PolyType.ptSubject, true);
    }
  }
  if (!parts.length) return [];
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const outlines: Vec2[][] = [];
  const walk = (n: ClipperNS.PolyNode) => { for (const ch of n.Childs()) { if (!ch.IsHole()) outlines.push(ch.Contour().map((q) => ({ x: q.X, y: q.Y }))); walk(ch); } };
  walk(tree);
  // The parts' edges, to name the objects a corner's edges come from
  let edgeIdx: RBush<BBox & { part: CopperPart; a: Vec2; b: Vec2 }> | null = null;
  const owner = (a: Vec2, b: Vec2): CopperPart => {
    if (!edgeIdx) {
      edgeIdx = new RBush();
      edgeIdx.load(parts.flatMap((part) => [...part.rings, ...part.holes].flatMap((r) => r.map((v, k) => { const w = r[(k + 1) % r.length]!; return { ...boxOfSeg(v, w), part, a: v, b: w }; }))));
    }
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let reach = 4; ; reach *= 16) {
      const near = edgeIdx.search({ minX: m.x - reach, minY: m.y - reach, maxX: m.x + reach, maxY: m.y + reach });
      if (!near.length && reach < 1e8) continue;
      let best = parts[0]!, bd = Infinity;
      for (const e of near) {
        const d = distance({ t: 'circle', c: m, r: 0 }, { t: 'seg', a: e.a, b: e.b, r: 0 });
        if (d < bd) { bd = d; best = e.part; }
      }
      return best;
    }
  };
  const out: AcuteCorner[] = [];
  for (const ring of outlines) {
    const n = ring.length;
    if (n < 3) continue;
    let area2 = 0;
    for (let k = 0; k < n; k++) { const p = ring[k]!, q = ring[(k + 1) % n]!; area2 += p.x * q.y - q.x * p.y; }
    const ccw = area2 > 0;
    for (let k = 0; k < n; k++) {
      const P = ring[(k + n - 1) % n]!, Q = ring[k]!, R = ring[(k + 1) % n]!;
      const ux = P.x - Q.x, uy = P.y - Q.y, vx = R.x - Q.x, vy = R.y - Q.y, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      // A notch with a side under 1 mil is left be [est: the suite reports few such]
      if (Math.min(lu, lv) < MIN_SIDE) continue;
      // Copper on the left of a counter-clockwise outline: a right turn is a corner into it
      const turn = (Q.x - P.x) * (R.y - Q.y) - (Q.y - P.y) * (R.x - Q.x);
      if (ccw ? turn >= 0 : turn <= 0) continue;
      const angle = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) * 180) / Math.PI;
      if (angle >= below - 1e-9) continue;
      if (window && !(Q.x > window.minX + 1 && Q.x < window.maxX - 1 && Q.y > window.minY + 1 && Q.y < window.maxY - 1)) continue;
      out.push({ at: Q, angle, layer, net, parts: [owner(P, Q), owner(Q, R)] });
    }
  }
  return out;
}

/** Copper layers with signals on them, in the stack's order. */
export const signalLayers = (doc: PcbDocument): LayerId[] => doc.board.copperStack.filter(isSignal);
