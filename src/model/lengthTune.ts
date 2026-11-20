/**
 * Length tuning (Route › Interactive Length Tuning, Interactive Diff Pair Length Tuning, Tools ›
 * Equalise Net Lengths): accordions on a straight track, bump by bump, until the net reaches its
 * target. The legs of a bump are a pitch apart (Space plus the track's width); the corners are
 * chamfered (Mitered Lines), or arcs of the Miter's size (Mitered Arcs), or half the pitch
 * (Rounded). The last bump is lower so the net lands on its target. A bump that would break
 * clearance is tried lower, then the next place along is tried.
 */
import type { Vec2 } from '../core/geom';
import { NO_NET, type PcbDocument, type PcbPrim, type PcbTrack } from './pcb';
import { ruleFor } from './drc';
import { ruleEnabled, ruleKind, ruleLength, type PcbRule } from '../formats/altium/rules';
import { offsetPolyline } from './busRoute';

export type TuneStyle = 'mitered' | 'arcs' | 'rounded';
export interface TunePattern { style: TuneStyle; amplitude: number; space: number; miter: number }

/** A piece of the tuned path: a line, or an arc (centre, radius, start angle of travel, signed sweep in degrees). */
export type Piece = { t: 'line'; a: Vec2; b: Vec2 } | { t: 'arc'; c: Vec2; r: number; from: number; sweep: number };

const DEG = Math.PI / 180;
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
export const pieceLength = (p: Piece) => (p.t === 'line' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : Math.abs(p.sweep) * DEG * p.r);
export const piecesLength = (ps: Piece[]) => ps.reduce((s, p) => s + pieceLength(p), 0);

/** The points a piece passes through (arcs every 15°), for clearance checks and offsetting. */
export function piecePoints(p: Piece): Vec2[] {
  if (p.t === 'line') return [p.a, p.b];
  const n = Math.max(2, Math.ceil(Math.abs(p.sweep) / 15));
  return Array.from({ length: n + 1 }, (_, i) => { const a = (p.from + (p.sweep * i) / n) * DEG; return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }; });
}
export function piecesPoints(ps: Piece[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ps) for (const q of piecePoints(p)) if (!out.length || Math.hypot(out.at(-1)!.x - q.x, out.at(-1)!.y - q.y) > 1) out.push(q);
  return out;
}

/** The net's routed length: its tracks and arcs (pours and keep-outs left out). */
export function netLength(doc: PcbDocument, net: number, without?: Set<number>): number {
  let s = 0;
  doc.prims.forEach((p, i) => {
    if (without?.has(i) || !('net' in p) || p.net !== net) return;
    if (p.kind === 'track' && p.polygon === NO_NET && !p.keepout) s += Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    else if (p.kind === 'arc' && p.polygon === NO_NET && !p.keepout) s += ((((p.end - p.start) % 360) + 360) % 360 || 360) * DEG * p.r;
  });
  return s;
}

const probe = (net: number): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: 1, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, width: 0, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });

/** The nets a Matched Lengths rule covers, by first scope. */
export function matchedNets(doc: PcbDocument, rule: PcbRule): number[] {
  return doc.nets.map((_, i) => i).filter((i) => ruleFor(doc, 'MatchedLengths', probe(i)) === rule);
}

/** The target length From Rules: the longest net matched with this one, capped by its Length rule. */
export function ruleTarget(doc: PcbDocument, net: number): { target: number; why: string } | null {
  let target = Infinity, why = '';
  const m = ruleFor(doc, 'MatchedLengths', probe(net));
  if (m) {
    const nets = matchedNets(doc, m);
    const longest = Math.max(0, ...nets.map((n) => netLength(doc, n)));
    if (longest > 0) { target = longest; why = m.bag.get('NAME') ?? 'MatchedLengths'; }
  }
  const l = ruleFor(doc, 'Length', probe(net));
  if (l) {
    const max = ruleLength(l, 'MAXLIMIT', '100000mil');
    if (max < target) { target = max; why = l.bag.get('NAME') ?? 'Length'; }
  }
  return Number.isFinite(target) ? { target, why } : null;
}

/** Matched Lengths rules that are on. */
export const matchedRules = (doc: PcbDocument) => doc.rules.filter((r) => ruleKind(r) === 'MatchedLengths' && ruleEnabled(r));

/* ── one bump ── */

const K_MITRE = -8 + 4 * Math.SQRT2, K_ARC = -8 + 2 * Math.PI;

interface Frame { o: Vec2; d: Vec2; n: Vec2; det: 1 | -1 }
const P = (f: Frame, u: number, v: number): Vec2 => ({ x: f.o.x + f.d.x * u + f.n.x * v, y: f.o.y + f.d.y * u + f.n.y * v });
/** A local angle (0 along the track, 90 towards the bump side) in board degrees. */
const ang = (f: Frame, phi: number): number => {
  const c = Math.cos(phi * DEG), s = Math.sin(phi * DEG);
  return Math.atan2(c * f.d.y + s * f.n.y, c * f.d.x + s * f.n.x) / DEG;
};

/** The corner size a bump of height h gets. */
function cornerOf(pat: TunePattern, pitch: number, h: number): number {
  const c0 = pat.style === 'rounded' ? pitch / 2 : Math.min(pitch / 2, ((pat.miter / 100) * pitch) / 2);
  return Math.max(0, Math.min(c0, h / 2));
}
/** What a bump of height h adds to the length of the straight track it replaces. */
function bumpAdds(pat: TunePattern, pitch: number, h: number): number {
  const c = cornerOf(pat, pitch, h);
  return 2 * h + (pat.style === 'mitered' ? K_MITRE : K_ARC) * c;
}
/** The height a bump needs to add `want`. */
function heightFor(pat: TunePattern, pitch: number, want: number): number {
  const k = pat.style === 'mitered' ? K_MITRE : K_ARC;
  const c0 = cornerOf(pat, pitch, Infinity);
  const h = (want - k * c0) / 2;
  return h >= 2 * c0 ? h : want / (2 + k / 2);
}

/** A bump with its up leg at u = x and down leg at x + pitch, height h; from (x - c, 0) to (x + pitch + c, 0). */
function bump(f: Frame, pat: TunePattern, pitch: number, x: number, h: number): Piece[] {
  const c = cornerOf(pat, pitch, h), p = pitch;
  const L = (u1: number, v1: number, u2: number, v2: number): Piece[] => (Math.abs(u1 - u2) + Math.abs(v1 - v2) < 1 ? [] : [{ t: 'line', a: round(P(f, u1, v1)), b: round(P(f, u2, v2)) }]);
  if (pat.style === 'mitered' || c < 1) {
    return [...L(x - c, 0, x, c), ...L(x, c, x, h - c), ...L(x, h - c, x + c, h), ...L(x + c, h, x + p - c, h),
      ...L(x + p - c, h, x + p, h - c), ...L(x + p, h - c, x + p, c), ...L(x + p, c, x + p + c, 0)];
  }
  const A = (uc: number, vc: number, phi: number, sweep: number): Piece => ({ t: 'arc', c: round(P(f, uc, vc)), r: Math.round(c), from: ang(f, phi), sweep: sweep * f.det });
  return [A(x - c, c, -90, 90), ...L(x, c, x, h - c), A(x + c, h - c, 180, -90), ...L(x + c, h, x + p - c, h),
    A(x + p - c, h - c, 90, -90), ...L(x + p, h - c, x + p, c), A(x + p + c, c, 180, 90)];
}

export interface AccordionResult { pieces: Piece[]; added: number; bumps: number }

/**
 * Accordions on the straight track A→B between `u0` and `u1` along it, on the `side` (1: left of
 * A→B), adding up to `need`. `pitch` is the distance between legs; `clear` says whether a bump's
 * points keep their clearance (it may be asked again lower). The pieces run from A to B.
 */
export function accordion(A: Vec2, B: Vec2, u0: number, u1: number, side: 1 | -1, need: number, pat: TunePattern, pitch: number, minH: number,
  clear: (pts: Vec2[], pieces: Piece[]) => boolean = () => true): AccordionResult {
  const len = Math.hypot(B.x - A.x, B.y - A.y);
  const d = { x: (B.x - A.x) / (len || 1), y: (B.y - A.y) / (len || 1) };
  const n = { x: -d.y * side, y: d.x * side };
  const f: Frame = { o: A, d, n, det: side };
  const lo = Math.max(0, Math.min(u0, u1)), hi = Math.min(len, Math.max(u0, u1));
  const out: Piece[] = [];
  let at = 0, added = 0, bumps = 0;
  const c0 = cornerOf(pat, pitch, pat.amplitude);
  let x = lo + c0;
  while (added < need - 1 && x + pitch + c0 <= hi) {
    // What is left, shared evenly over as few bumps as it takes (so no last bump is too low to make)
    const left = need - added, full = bumpAdds(pat, pitch, pat.amplitude);
    const m = Number.isFinite(left) ? Math.max(1, Math.ceil(left / full - 1e-9)) : 1;
    let h = left / m >= full ? pat.amplitude : heightFor(pat, pitch, left / m);
    if (h < minH) { if (bumpAdds(pat, pitch, minH) / 2 > need - added) break; h = minH; }
    let placed: Piece[] | null = null;
    const heights = [h, h * 0.75, h * 0.5, h * 0.35].filter((v) => v >= minH);
    for (const tryH of heights.length ? heights : [minH]) {
      const b = bump(f, pat, pitch, x, tryH);
      if (clear(piecesPoints(b), b)) { placed = b; h = tryH; break; }
    }
    if (!placed) { x += pitch / 2; continue; }
    const c = cornerOf(pat, pitch, h);
    if (x - c > at + 1) out.push({ t: 'line', a: round(P(f, at, 0)), b: round(P(f, x - c, 0)) });
    out.push(...placed);
    added += bumpAdds(pat, pitch, h);
    bumps++;
    at = x + pitch + c;
    x += 2 * pitch;
  }
  if (len > at + 1 || !out.length) out.push({ t: 'line', a: round(P(f, at, 0)), b: { ...B } });
  return { pieces: out, added, bumps };
}

/** Pieces moved sideways by `d` (left of travel): lines in their direction, arcs by radius. Mitred joins where lines meet at an angle. */
export function offsetPieces(ps: Piece[], d: number): Piece[] {
  if (!d) return ps;
  if (ps.every((p) => p.t === 'line')) {
    const lines = ps as Extract<Piece, { t: 'line' }>[];
    const pts = [lines[0]!.a, ...lines.map((p) => p.b)];
    const off = offsetPolyline(pts, d);
    return off.slice(1).map((b, i) => ({ t: 'line' as const, a: off[i]!, b }));
  }
  return ps.map((p): Piece => {
    if (p.t === 'arc') return { ...p, r: Math.max(1, Math.round(p.r - Math.sign(p.sweep) * d)) };
    const l = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) || 1, nx = -(p.b.y - p.a.y) / l, ny = (p.b.x - p.a.x) / l;
    return { t: 'line', a: round({ x: p.a.x + nx * d, y: p.a.y + ny * d }), b: round({ x: p.b.x + nx * d, y: p.b.y + ny * d }) };
  });
}

/** Board arcs as Altium keeps them: counter-clockwise from start to end, in [0, 360). */
export function arcAngles(p: Extract<Piece, { t: 'arc' }>): { start: number; end: number } {
  const norm = (a: number) => ((a % 360) + 360) % 360;
  const s = p.sweep >= 0 ? p.from : p.from + p.sweep;
  return { start: Math.round(norm(s) * 1000) / 1000, end: Math.round(norm(s + Math.abs(p.sweep)) * 1000) / 1000 };
}

/** The partner of a pair track: the nearest parallel track of the other net beside it. */
export function partnerTrack(doc: PcbDocument, t: PcbTrack, partner: number, within: number): PcbTrack | null {
  const dx = t.b.x - t.a.x, dy = t.b.y - t.a.y, l = Math.hypot(dx, dy) || 1;
  let best: { p: PcbTrack; d: number } | null = null;
  for (const p of doc.prims as PcbPrim[]) {
    if (p.kind !== 'track' || p.net !== partner || p.layer !== t.layer) continue;
    const ex = p.b.x - p.a.x, ey = p.b.y - p.a.y, m = Math.hypot(ex, ey) || 1;
    if (Math.abs((dx * ey - dy * ex) / (l * m)) > 0.02) continue;
    const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    const lat = Math.abs(((mid.x - t.a.x) * -dy + (mid.y - t.a.y) * dx) / l);
    if (lat > within) continue;
    if (!best || lat < best.d) best = { p, d: lat };
  }
  return best?.p ?? null;
}
