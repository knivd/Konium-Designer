/**
 * Routing several nets as one: a differential pair (Route › Interactive Differential Pair
 * Routing) or a bus of connections (Route › Interactive Multi-Routing). The route is one centre
 * line; each net's track runs beside it at its offset, joining from where it starts at 45° and
 * leaving for where it ends at 45°. Offsets come from the widths and the gap between neighbours.
 */
import type { Vec2 } from '../core/geom';

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const unit = (a: Vec2): Vec2 => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const left = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const at = (o: Vec2, d: Vec2, n: Vec2, along: number, lat: number): Vec2 => round({ x: o.x + d.x * along + n.x * lat, y: o.y + d.y * along + n.y * lat });

/** A polyline moved sideways by `d` (to the left of its direction), corners mitred. */
export function offsetPolyline(pts: Vec2[], d: number): Vec2[] {
  if (pts.length < 2 || d === 0) return pts.map(round);
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const din = i > 0 ? unit(sub(p, pts[i - 1]!)) : null;
    const dout = i < pts.length - 1 ? unit(sub(pts[i + 1]!, p)) : null;
    if (!din || !dout) { const n = left((din ?? dout)!); out.push(round({ x: p.x + n.x * d, y: p.y + n.y * d })); continue; }
    const n1 = left(din), n2 = left(dout);
    const m = { x: n1.x + n2.x, y: n1.y + n2.y };
    const k = dot(m, n1);
    // A turn back on itself: no mitre, the corner keeps its offset on the incoming side
    if (Math.abs(k) < 1e-9) { out.push(round({ x: p.x + n1.x * d, y: p.y + n1.y * d })); continue; }
    out.push(round({ x: p.x + (m.x * d) / k, y: p.y + (m.y * d) / k }));
  }
  return out;
}

/** Offsets of the lanes across the route, centred on it: neighbours apart by their half widths and the gap. */
export function laneOffsets(widths: number[], gap: number): number[] {
  const pos: number[] = [0];
  for (let i = 1; i < widths.length; i++) pos.push(pos[i - 1]! + widths[i - 1]! / 2 + gap + widths[i]! / 2);
  const mid = (pos[0]! + pos.at(-1)!) / 2;
  return pos.map((p) => p - mid);
}

/** How far a point lies to the left of the line from `o` in direction `d`. */
export const lateral = (o: Vec2, d: Vec2, p: Vec2) => dot(sub(p, o), left(d));

/**
 * One lane's track points: from `start`, at 45° onto its offset of the centre line, along it,
 * and (with `end`) off it at 45° to the end.
 */
export function lanePath(start: Vec2, centre: Vec2[], offset: number, end?: Vec2): Vec2[] {
  if (centre.length < 2) return end ? [start, end] : [start];
  const off = offsetPolyline(centre, offset);
  const c0 = centre[0]!, d0 = unit(sub(centre[1]!, c0)), n0 = left(d0);
  const seg0 = Math.hypot(centre[1]!.x - c0.x, centre[1]!.y - c0.y);
  const out: Vec2[] = [round(start)];
  const l = dot(sub(start, c0), n0), a = dot(sub(start, c0), d0), delta = offset - l;
  if (Math.abs(delta) < 2) out.push(...off.slice(1));
  else if (a + Math.abs(delta) < seg0 - 1) out.push(at(c0, d0, n0, a + Math.abs(delta), offset), ...off.slice(1));
  else out.push(...off.slice(1));
  if (end) {
    const cn = centre.at(-1)!, dn = unit(sub(cn, centre.at(-2)!)), nn = left(dn);
    const segN = Math.hypot(cn.x - centre.at(-2)!.x, cn.y - centre.at(-2)!.y);
    const le = dot(sub(end, cn), nn), ae = dot(sub(end, cn), dn), de = le - offset;
    const t = ae - Math.abs(de);
    if (Math.abs(de) >= 2) {
      // Straight on past the centre line's end, or off its last segment early, then 45° to the end
      if (t > 1) out.push(at(cn, dn, nn, t, offset));
      else if (t > -segN + 1 && out.length > 2) { out.pop(); out.push(at(cn, dn, nn, t, offset)); }
    }
    out.push(round(end));
  }
  // Drop repeats
  return out.filter((p, i) => i === 0 || p.x !== out[i - 1]!.x || p.y !== out[i - 1]!.y);
}

/** The order the lanes take across the route: the one starting furthest to the right gets the rightmost offset. */
export function laneOrder(starts: Vec2[], c0: Vec2, dir: Vec2): number[] {
  const d = unit(dir);
  return starts.map((s, i) => ({ i, l: lateral(c0, d, s) })).sort((x, y) => x.l - y.l || x.i - y.i).map((x) => x.i);
}
