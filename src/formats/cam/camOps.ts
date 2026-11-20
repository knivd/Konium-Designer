/**
 * The CAM editor's shape operations, apart from the tools that ask for them: an object broken at a
 * point, a corner chamfered or filleted, a line extended to another, draws joined into polylines and
 * found as closed loops (Tools › Convert), polylines offset, regions exploded into draws, drawn pads
 * turned into flashes (Edit › Groups) and custom apertures turned back into shapes; and the
 * geometry the Place › Arc and Circle commands are made of.
 */
import type { Vec2 } from '../../core/geom';
import type { Aperture, GerberLayer, GerberObject } from '../gerber/gerberRead';
import { customAperture, findOrAddAperture, shapesOf } from './camModel';
import { clipContours, offsetOutline } from '../../model/outlineOps';

type Draw = Extract<GerberObject, { kind: 'draw' }>;
type Arc = Extract<GerberObject, { kind: 'arc' }>;
const near = (a: Vec2, b: Vec2, tol = 100) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number) => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;

/* ─── Circles and arcs from points ─────────────────────────────────────────────────── */

/** The circle through three points (null when they're in a line). */
export function circle3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** An arc from a to b passing through m (clockwise when m is to the right of a → b). */
export function arcThrough(a: Vec2, m: Vec2, b: Vec2): { c: Vec2; cw: boolean } | null {
  const k = circle3(a, m, b);
  if (!k) return null;
  return { c: k.c, cw: cross(sub(m, a), sub(b, a)) > 0 };
}

/** Place › Arc › 3-Points (Start, End, Tangent): the arc from a to b whose tangent at a points at t [est: CAMtastic's third point]. */
export function arcTangent(a: Vec2, b: Vec2, t: Vec2): { c: Vec2; cw: boolean } | null {
  const dir = unit(sub(t, a));
  const n = { x: -dir.y, y: dir.x };
  // The centre is on the normal at a, equally far from a and b
  const ab = sub(b, a);
  const den = 2 * (n.x * ab.x + n.y * ab.y);
  if (Math.abs(den) < 1e-9) return null;
  const s = (ab.x * ab.x + ab.y * ab.y) / den;
  const c = add(a, mul(n, s));
  return { c, cw: cross(dir, sub(b, a)) < 0 };
}

/** A line's intersection with another (as infinite lines); null when parallel. */
export function lineX(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1 = sub(a2, a1), d2 = sub(b2, b1), den = cross(d1, d2);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(b1, a1), d2) / den;
  return add(a1, mul(d1, t));
}

/** The circle of radius r tangent to two lines (the one in the corner nearest `hint`). */
export function circleTangentTangent(l1: [Vec2, Vec2], l2: [Vec2, Vec2], r: number, hint: Vec2): { c: Vec2; t1: Vec2; t2: Vec2 } | null {
  const x = lineX(l1[0], l1[1], l2[0], l2[1]);
  if (!x) return null;
  let best: { c: Vec2; t1: Vec2; t2: Vec2 } | null = null, bd = Infinity;
  const n1 = unit({ x: -(l1[1].y - l1[0].y), y: l1[1].x - l1[0].x }), n2 = unit({ x: -(l2[1].y - l2[0].y), y: l2[1].x - l2[0].x });
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) {
    const c = lineX(add(l1[0], mul(n1, s1 * r)), add(l1[1], mul(n1, s1 * r)), add(l2[0], mul(n2, s2 * r)), add(l2[1], mul(n2, s2 * r)));
    if (!c) continue;
    const d = Math.hypot(c.x - hint.x, c.y - hint.y);
    if (d < bd) { bd = d; best = { c, t1: sub(c, mul(n1, s1 * r)), t2: sub(c, mul(n2, s2 * r)) }; }
  }
  return best;
}

/* ─── Break, chamfer, fillet, extend ───────────────────────────────────────────────── */

/** Edit › Objects › Break: a draw or arc in two at the point nearest `at` (null when that's an end). */
export function breakAt(o: GerberObject, at: Vec2): [GerberObject, GerberObject] | null {
  if (o.kind === 'draw') {
    const d = sub(o.b, o.a), l2 = d.x * d.x + d.y * d.y;
    if (!l2) return null;
    const t = Math.max(0, Math.min(1, ((at.x - o.a.x) * d.x + (at.y - o.a.y) * d.y) / l2));
    const p = add(o.a, mul(d, t));
    if (near(p, o.a) || near(p, o.b)) return null;
    return [{ ...o, b: p }, { ...o, a: p }];
  }
  if (o.kind === 'arc') {
    const r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
    const ang = Math.atan2(at.y - o.c.y, at.x - o.c.x);
    const p = { x: o.c.x + r * Math.cos(ang), y: o.c.y + r * Math.sin(ang) };
    if (near(p, o.a) || near(p, o.b)) return null;
    return [{ ...o, b: p }, { ...o, a: p }];
  }
  return null;
}

/** Two draws meeting at a corner: which ends meet (null when they don't). */
function corner(l1: Draw, l2: Draw): { p: Vec2; f1: 'a' | 'b'; f2: 'a' | 'b' } | null {
  for (const f1 of ['a', 'b'] as const) for (const f2 of ['a', 'b'] as const) if (near(l1[f1], l2[f2], 1000)) return { p: l1[f1], f1, f2 };
  // Not touching: where they would meet
  const x = lineX(l1.a, l1.b, l2.a, l2.b);
  if (!x) return null;
  const f1 = Math.hypot(l1.a.x - x.x, l1.a.y - x.y) < Math.hypot(l1.b.x - x.x, l1.b.y - x.y) ? 'a' : 'b';
  const f2 = Math.hypot(l2.a.x - x.x, l2.a.y - x.y) < Math.hypot(l2.b.x - x.x, l2.b.y - x.y) ? 'a' : 'b';
  return { p: x, f1, f2 };
}

/** Edit › Objects › Chamfer: the corner of two lines cut back `d` along each, joined by a new line. */
export function chamfer(l1: Draw, l2: Draw, d: number): { l1: Draw; l2: Draw; cut: Draw } | null {
  const k = corner(l1, l2);
  if (!k) return null;
  const o1 = k.f1 === 'a' ? l1.b : l1.a, o2 = k.f2 === 'a' ? l2.b : l2.a;
  if (Math.hypot(o1.x - k.p.x, o1.y - k.p.y) <= d || Math.hypot(o2.x - k.p.x, o2.y - k.p.y) <= d) return null;
  const p1 = add(k.p, mul(unit(sub(o1, k.p)), d)), p2 = add(k.p, mul(unit(sub(o2, k.p)), d));
  return { l1: { ...l1, [k.f1]: p1 }, l2: { ...l2, [k.f2]: p2 }, cut: { ...l1, a: p1, b: p2, grp: l1.grp } };
}

/** Edit › Objects › Fillet: the corner of two lines rounded with an arc of radius r. */
export function fillet(l1: Draw, l2: Draw, r: number): { l1: Draw; l2: Draw; arc: Arc } | null {
  const k = corner(l1, l2);
  if (!k) return null;
  const o1 = k.f1 === 'a' ? l1.b : l1.a, o2 = k.f2 === 'a' ? l2.b : l2.a;
  const u1 = unit(sub(o1, k.p)), u2 = unit(sub(o2, k.p));
  const half = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))) / 2;
  if (half < 1e-6 || half > Math.PI / 2 - 1e-6) return null;
  const t = r / Math.tan(half);
  if (t >= Math.hypot(o1.x - k.p.x, o1.y - k.p.y) || t >= Math.hypot(o2.x - k.p.x, o2.y - k.p.y)) return null;
  const p1 = add(k.p, mul(u1, t)), p2 = add(k.p, mul(u2, t));
  const bis = unit(add(u1, u2));
  const c = add(k.p, mul(bis, r / Math.sin(half)));
  return { l1: { ...l1, [k.f1]: p1 }, l2: { ...l2, [k.f2]: p2 }, arc: { kind: 'arc', a: p1, b: p2, c, cw: cross(sub(p1, c), sub(p2, c)) < 0, ap: l1.ap, dark: l1.dark, ...(l1.grp ? { grp: l1.grp } : {}) } };
}

/** Edit › Objects › Extend: a line's nearer end (to `pick`) moved to where it meets the boundary line or arc. */
export function extendTo(o: Draw, boundary: GerberObject, pick: Vec2): Draw | null {
  const end: 'a' | 'b' = Math.hypot(o.a.x - pick.x, o.a.y - pick.y) < Math.hypot(o.b.x - pick.x, o.b.y - pick.y) ? 'a' : 'b';
  const from = end === 'a' ? o.b : o.a;
  const dir = unit(sub(o[end], from));
  let hits: Vec2[] = [];
  if (boundary.kind === 'draw') { const x = lineX(o.a, o.b, boundary.a, boundary.b); if (x) hits = [x]; }
  else if (boundary.kind === 'arc') {
    const r = Math.hypot(boundary.a.x - boundary.c.x, boundary.a.y - boundary.c.y);
    const f = sub(from, boundary.c), b2 = 2 * (f.x * dir.x + f.y * dir.y), c2 = f.x * f.x + f.y * f.y - r * r, disc = b2 * b2 - 4 * c2;
    if (disc >= 0) for (const s of [1, -1]) { const t = (-b2 + s * Math.sqrt(disc)) / 2; hits.push(add(from, mul(dir, t))); }
  }
  // Ahead of the end being extended, the nearest
  const ahead = hits.filter((h) => (h.x - from.x) * dir.x + (h.y - from.y) * dir.y > 0).sort((p, q) => Math.hypot(p.x - from.x, p.y - from.y) - Math.hypot(q.x - from.x, q.y - from.y));
  return ahead[0] ? { ...o, [end]: ahead[0] } : null;
}

/* ─── Chains: join, closed loops, offset ───────────────────────────────────────────── */

/** Draws and arcs joined end to end into chains (each a list of object indices in order, and whether it closes). */
export function chains(objs: { o: GerberObject; i: number }[], tol = 1000): { items: { i: number; rev: boolean }[]; closed: boolean }[] {
  const segs = objs.filter((x) => x.o.kind === 'draw' || x.o.kind === 'arc') as { o: Draw | Arc; i: number }[];
  const used = new Set<number>();
  const out: { items: { i: number; rev: boolean }[]; closed: boolean }[] = [];
  const key = (p: Vec2) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
  const at = new Map<string, number[]>();
  segs.forEach((s, k) => { for (const p of [s.o.a, s.o.b]) { const kk = key(p); at.set(kk, [...(at.get(kk) ?? []), k]); } });
  const other = (k: number, p: Vec2) => (at.get(key(p)) ?? []).find((j) => j !== k && !used.has(j));
  for (let k = 0; k < segs.length; k++) {
    if (used.has(k)) continue;
    used.add(k);
    let items = [{ i: segs[k]!.i, rev: false }];
    let tail = segs[k]!.o.b, head = segs[k]!.o.a;
    for (let n = other(k, tail); n !== undefined; n = other(n, tail)) {
      used.add(n);
      const s = segs[n]!.o, rev = !near(s.a, tail, tol);
      items.push({ i: segs[n]!.i, rev });
      tail = rev ? s.a : s.b;
      if (near(tail, head, tol)) break;
    }
    if (!near(tail, head, tol)) {
      const front: { i: number; rev: boolean }[] = [];
      for (let n = other(k, head); n !== undefined; n = other(n, head)) {
        used.add(n);
        const s = segs[n]!.o, rev = near(s.a, head, tol);
        front.unshift({ i: segs[n]!.i, rev });
        head = rev ? s.b : s.a;
      }
      items = [...front, ...items];
    }
    out.push({ items, closed: items.length > 1 && near(tail, head, tol) });
  }
  return out;
}

/** A chain's points in order (its arcs walked). */
export function chainPoints(g: GerberLayer, items: { i: number; rev: boolean }[], arcStep = Math.PI / 24): Vec2[] {
  const pts: Vec2[] = [];
  for (const { i, rev } of items) {
    const o = g.objects[i]!;
    let seg: Vec2[] = [];
    if (o.kind === 'draw') seg = [o.a, o.b];
    else if (o.kind === 'arc') {
      const r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
      let s = Math.atan2(o.a.y - o.c.y, o.a.x - o.c.x), e = Math.atan2(o.b.y - o.c.y, o.b.x - o.c.x);
      if (o.cw) { while (e >= s) e -= 2 * Math.PI; } else { while (e <= s) e += 2 * Math.PI; }
      const n = Math.max(2, Math.ceil(Math.abs(e - s) / arcStep));
      seg = Array.from({ length: n + 1 }, (_, k) => ({ x: o.c.x + r * Math.cos(s + ((e - s) * k) / n), y: o.c.y + r * Math.sin(s + ((e - s) * k) / n) }));
    }
    if (rev) seg = seg.reverse();
    for (const p of pts.length ? seg.slice(1) : seg) pts.push(p);
  }
  return pts;
}

/** A polyline offset by d (positive: to its left), corners mitred; a closed one stays closed. */
export function offsetPolyline(pts: Vec2[], d: number, closed: boolean): Vec2[] {
  if (closed) {
    const area = pts.reduce((t, p, i) => t + cross(p, pts[(i + 1) % pts.length]!), 0);
    // Left of a counter-clockwise outline is inside: grow outwards when d is to the right
    const grow = area > 0 ? -d : d;
    return offsetOutline(pts, grow)[0] ?? [];
  }
  const n = pts.length, out: Vec2[] = [];
  const norm = (i: number) => { const u = unit(sub(pts[i + 1]!, pts[i]!)); return { x: -u.y, y: u.x }; };
  for (let i = 0; i < n; i++) {
    if (i === 0) { out.push(add(pts[0]!, mul(norm(0), d))); continue; }
    if (i === n - 1) { out.push(add(pts[i]!, mul(norm(i - 1), d))); continue; }
    const a = norm(i - 1), b = norm(i);
    const p1 = add(pts[i - 1]!, mul(a, d)), p2 = add(pts[i]!, mul(a, d)), q1 = add(pts[i]!, mul(b, d)), q2 = add(pts[i + 1]!, mul(b, d));
    out.push(lineX(p1, p2, q1, q2) ?? p2);
  }
  return out;
}

/** Explode › Polylines on a region: its contours as draws with the aperture given. */
export function regionDraws(o: Extract<GerberObject, { kind: 'region' }>, ap: number): GerberObject[] {
  const out: GerberObject[] = [];
  for (const c of o.contours) for (let k = 0; k < c.length; k++) out.push({ kind: 'draw', a: c[k]!, b: c[(k + 1) % c.length]!, ap, dark: o.dark });
  return out;
}

/** Explode › Custom Apertures: a macro flash as regions of its shapes (clear ones in clear polarity). */
export function flashRegions(o: Extract<GerberObject, { kind: 'flash' }>, ap: Aperture): GerberObject[] {
  const rot = o.rot ?? 0, m = o.mirror ?? '', k = o.scale ?? 1;
  const tf = (p: Vec2): Vec2 => {
    let x = p.x * k, y = p.y * k;
    if (m.includes('X')) x = -x;
    if (m.includes('Y')) y = -y;
    if (rot) { const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); [x, y] = [x * c - y * s, x * s + y * c]; }
    return { x: o.at.x + x, y: o.at.y + y };
  };
  return shapesOf(ap).map((s) => ({ kind: 'region' as const, contours: [s.poly.map(tf)], dark: s.dark ? o.dark : !o.dark }));
}

/* ─── Groups: draws to flashes ─────────────────────────────────────────────────────── */

/** An object's covered shape as polygons (for draws-to-flash and custom apertures). */
export function coverOf(o: GerberObject, g: GerberLayer): Vec2[][] {
  if (o.kind === 'region') return o.contours;
  const ap = g.apertures.get(o.ap);
  if (!ap) return [];
  const w = Math.min(ap.w, ap.h) || ap.w;
  if (o.kind === 'flash') {
    const rot = o.rot ?? 0;
    return shapesOf(ap).filter((s) => s.dark).map((s) => s.poly.map((p) => { const a = (rot * Math.PI) / 180; return { x: o.at.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: o.at.y + p.x * Math.sin(a) + p.y * Math.cos(a) }; }));
  }
  const pts = o.kind === 'draw' ? [o.a, o.b] : chainPoints({ ...g, objects: [o] } as GerberLayer, [{ i: 0, rev: false }]);
  if (ap.shape === 'R') {
    const out: Vec2[][] = [];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!, b = pts[k]!, hw = ap.w / 2, hh = ap.h / 2;
      out.push(...clipContours('union', [[{ x: a.x - hw, y: a.y - hh }, { x: a.x + hw, y: a.y - hh }, { x: a.x + hw, y: a.y + hh }, { x: a.x - hw, y: a.y + hh }],
        [{ x: b.x - hw, y: b.y - hh }, { x: b.x + hw, y: b.y - hh }, { x: b.x + hw, y: b.y + hh }, { x: b.x - hw, y: b.y + hh }],
        [{ x: a.x - hw, y: a.y - hh }, { x: b.x - hw, y: b.y - hh }, { x: b.x + hw, y: b.y + hh }, { x: a.x + hw, y: a.y + hh }]]));
    }
    return out;
  }
  const out: Vec2[][] = [];
  const r = w / 2;
  for (let k = 1; k < pts.length || k === 1; k++) {
    const a = pts[k - 1]!, b = pts[k] ?? a;
    const d = sub(b, a), l = len(d), a0 = Math.atan2(d.y, d.x), poly: Vec2[] = [];
    if (l < 1) { out.push(Array.from({ length: 24 }, (_, i) => ({ x: a.x + r * Math.cos((i * Math.PI) / 12), y: a.y + r * Math.sin((i * Math.PI) / 12) }))); continue; }
    for (let i = 0; i <= 12; i++) { const t = a0 - Math.PI / 2 - (i * Math.PI) / 12; poly.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) }); }
    for (let i = 0; i <= 12; i++) { const t = a0 + Math.PI / 2 - (i * Math.PI) / 12; poly.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) }); }
    out.push(poly);
    if (k >= pts.length - 1) break;
  }
  return out;
}

/** Objects that touch each other, in clusters (indices into `objs`). */
export function clusters(objs: { o: GerberObject; i: number }[], g: GerberLayer): number[][] {
  const boxes = objs.map(({ o }) => {
    const pts = coverOf(o, g).flat();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    return { minX, minY, maxX, maxY };
  });
  const parent = objs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let a = 0; a < objs.length; a++) for (let b = a + 1; b < objs.length; b++) {
    const A = boxes[a]!, B = boxes[b]!;
    if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) continue;
    parent[find(a)] = find(b);
  }
  const m = new Map<number, number[]>();
  objs.forEach((_, i) => { const r = find(i); m.set(r, [...(m.get(r) ?? []), i]); });
  return [...m.values()];
}

/**
 * Edit › Groups › Automatic / Selective (Draw to Flash): a cluster of draws that paints a pad becomes a flash.
 * A cluster whose covered shape is its bounding rectangle becomes a rectangular aperture; one that is round
 * a round aperture; anything else a custom aperture of its outline (Draw to Custom Aperture always is).
 */
export function padFromDraws(objs: GerberObject[], g: GerberLayer, custom = false): GerberObject | null {
  const shapes = clipContours('union', objs.flatMap((o) => coverOf(o, g)));
  if (!shapes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of shapes.flat()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const c = { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) }, w = maxX - minX, h = maxY - minY;
  const area = shapes.reduce((t, s) => t + Math.abs(s.reduce((u, p, i) => u + cross(p, s[(i + 1) % s.length]!), 0)) / 2, 0);
  const dark = objs[0]?.dark ?? true;
  if (!custom && shapes.length === 1) {
    if (area >= 0.985 * w * h) return { kind: 'flash', at: c, ap: findOrAddAperture(g, 'R', w, h), dark };
    if (Math.abs(w - h) <= Math.max(200, 0.02 * w) && area >= 0.97 * Math.PI * (w / 2) * (h / 2) && area <= 1.03 * Math.PI * (w / 2) * (h / 2)) return { kind: 'flash', at: c, ap: findOrAddAperture(g, 'C', (w + h) / 2), dark };
  }
  // A shape with a hole can't be a flash's outline alone: keep the drawn objects
  if (shapes.length > 1 && !custom) return null;
  // Contours in order, outer first: one inside an odd number of others is a hole (a clear primitive)
  const inside = (p: Vec2, poly: Vec2[]) => { let k = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i]!, b = poly[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) k = !k; } return k; };
  const depth = shapes.map((s, i) => shapes.filter((t, j) => j !== i && inside(s[0]!, t)).length);
  return { kind: 'flash', at: c, ap: customAperture(g, shapes.map((s, i) => ({ dark: depth[i]! % 2 === 0, poly: s.map((p) => ({ x: p.x - c.x, y: p.y - c.y })) }))), dark };
}
