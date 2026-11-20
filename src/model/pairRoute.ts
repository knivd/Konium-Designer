/**
 * A differential pair routed as one by the autorouter (26.194). The two tracks are found as one
 * wide track down the middle (as wide as both with their gap), from a place clear of the pads at
 * one end to such a place at the other; each net's track then runs beside that centre line at its
 * offset, so the two keep the pair's gap all the way, and joins its pads at 45° at the ends
 * (busRoute.ts, as Route › Interactive Differential Pair Routing lays them). The pair stays on
 * one layer. A pair that cannot be laid so (its ends are not on one layer, the two would have to
 * cross, or there is no room for both side by side) is not routed here: its nets are then routed
 * one by one, and the pair's rule reports what is uncoupled.
 */
import type { Vec2 } from '../core/geom';
import { lanePath, lateral } from './busRoute';
import { gridSearch, pull, simplify, tighten, type Look, type RouteWorld } from './router';

/** The pair's ends: pa and na at one end, pb and nb at the other. */
export interface PairEnds { pa: Vec2; na: Vec2; pb: Vec2; nb: Vec2 }

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (a: Vec2): Vec2 => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * The two nets' paths on the world's layer, or null. `reach`: how far the pads at each end
 * extend from their centres (the pair gathers beyond them).
 */
export function routePair(w: RouteWorld, netP: number, netN: number, width: number, gap: number, e: PairEnds, reach: { a: number; b: number }): { p: Vec2[]; n: Vec2[]; centre: Vec2[] } | null {
  const fat = 2 * width + gap, off = (width + gap) / 2;
  // The centre line is neither net's: both nets' copper lets it by
  const both: Look = { skip: (it) => it.net === netP || it.net === netN };
  const MA = mid(e.pa, e.na), MB = mid(e.pb, e.nb);
  /** Where the pair can first run side by side at an end: out from between its pads, across their line first, with where it leaves them. */
  const gather = (M: Vec2, p: Vec2, n: Vec2, toward: Vec2, r: number): { g: Vec2; from: Vec2 }[] => {
    const ax = unit(sub(n, p)), v = { x: -ax.y, y: ax.x }, t = unit(sub(toward, M));
    const s = v.x * t.x + v.y * t.y >= 0 ? 1 : -1;
    const dirs = [{ x: v.x * s, y: v.y * s }, { x: -v.x * s, y: -v.y * s }];
    const d0 = r + fat / 2 + w.maxGap;
    const out: { g: Vec2; from: Vec2 }[] = [];
    for (const d of dirs) for (const k of [1, 1.5, 2.2, 3.2]) {
      const g = rnd({ x: M.x + d.x * d0 * k, y: M.y + d.y * d0 * k });
      if (!w.segHit(netP, fat, g, { x: g.x + 1, y: g.y }, both)) { out.push({ g, from: rnd({ x: M.x + d.x * r, y: M.y + d.y * r }) }); break; }
    }
    return out;
  };
  for (const A of gather(MA, e.pa, e.na, MB, reach.a)) for (const B of gather(MB, e.pb, e.nb, MA, reach.b)) {
    const f = gridSearch(w, netP, fat, A.g, B.g, { dirs: 8, ...both });
    if (!f || !f.reached || f.complete === false) continue;
    let c = pull(w, netP, fat, f.pts, 8, both);
    c = tighten(w, netP, fat, c, both);
    c = simplify([A.from, ...pull(w, netP, fat, c, 8, both), B.from]);
    if (c.length < 2) continue;
    // The side each net runs on (P left of the way the line goes, or right): the same at both ends, or the two would have to cross
    const d0 = unit(sub(c[1]!, c[0]!)), dn = unit(sub(c.at(-1)!, c.at(-2)!));
    const sA = Math.sign(lateral(c[0]!, d0, e.pa) - lateral(c[0]!, d0, e.na)), sB = Math.sign(lateral(c.at(-1)!, dn, e.pb) - lateral(c.at(-1)!, dn, e.nb));
    if (!sA || sA !== sB) continue;
    const P = lanePath(e.pa, c, sA * off, e.pb), N = lanePath(e.na, c, -sA * off, e.nb);
    if (P.length < 2 || N.length < 2 || !w.clear(netP, width, P)) continue;
    const laid = P.slice(1).map((b, i) => w.virtual({ layer: w.layer, a: P[i]!, b, width, net: netP }));
    if (!w.clear(netN, width, N, { extra: laid })) continue;
    return { p: P, n: N, centre: c };
  }
  return null;
}
