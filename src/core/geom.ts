import earcut from 'earcut';

export interface Vec2 { x: number; y: number }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const DEG = Math.PI / 180;

export function rotate(p: Vec2, deg: number, about: Vec2 = { x: 0, y: 0 }): Vec2 {
  const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
  const dx = p.x - about.x, dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

export function emptyBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}
export function isEmpty(b: BBox): boolean { return !(b.minX <= b.maxX && b.minY <= b.maxY); }
export function extend(b: BBox, x: number, y: number, r = 0): BBox {
  if (x - r < b.minX) b.minX = x - r;
  if (y - r < b.minY) b.minY = y - r;
  if (x + r > b.maxX) b.maxX = x + r;
  if (y + r > b.maxY) b.maxY = y + r;
  return b;
}
export function union(a: BBox, b: BBox): BBox {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
export function boxOfPoints(pts: Vec2[], r = 0): BBox {
  const b = emptyBox();
  for (const p of pts) extend(b, p.x, p.y, r);
  return b;
}

/** Distance from p to segment ab. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Normalise an angle in degrees into [0, 360). */
export function normDeg(a: number): number { const r = a % 360; return r < 0 ? r + 360 : r; }

/** Is angle (deg) inside the CCW sweep from start to end? */
export function inSweep(a: number, start: number, end: number): boolean {
  // A whole circle (0 to 360, or start = end as arcPoints draws it) holds every angle
  if (normDeg(end - start) === 0) return true;
  const s = normDeg(start), e = normDeg(end), x = normDeg(a);
  return s <= e ? x >= s && x <= e : x >= s || x <= e;
}

/** Distance from p to a CCW arc (centre c, radius r, start/end deg). */
export function distToArc(p: Vec2, c: Vec2, r: number, start: number, end: number): number {
  const ang = Math.atan2(p.y - c.y, p.x - c.x) / DEG;
  if (inSweep(ang, start, end)) return Math.abs(dist(p, c) - r);
  const ps = { x: c.x + r * Math.cos(start * DEG), y: c.y + r * Math.sin(start * DEG) };
  const pe = { x: c.x + r * Math.cos(end * DEG), y: c.y + r * Math.sin(end * DEG) };
  return Math.min(dist(p, ps), dist(p, pe));
}

/**
 * Chords for an arc in checks of distance (DRC, the router): enough that none strays from the arc
 * by more than `tol` (0.05 mil), at most a 6° step.
 */
export function arcChords(r: number, sweepDeg: number, tol = 500): number {
  const step = r > tol ? Math.min(6, (2 * Math.acos(1 - tol / r) * 180) / Math.PI) : 6;
  return Math.min(720, Math.max(4, Math.ceil(sweepDeg / step)));
}

/** Points along a CCW arc, inclusive of both ends. */
export function arcPoints(c: Vec2, rx: number, ry: number, startDeg: number, endDeg: number, segs?: number): Vec2[] {
  let sweep = normDeg(endDeg) - normDeg(startDeg);
  if (sweep <= 0) sweep += 360;
  const n = segs ?? Math.max(8, Math.ceil(sweep / 6));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (startDeg + (sweep * i) / n) * DEG;
    out.push({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) });
  }
  return out;
}

/**
 * Outline of a rectangle with elliptical corners (rx across, ry up and down), CCW from the right edge's top;
 * radii past half the size are clamped, so a square with large radii is a circle [AD].
 */
export function roundRectPoints(a: Vec2, b: Vec2, rx: number, ry: number, segs = 8): Vec2[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const cx = Math.max(0, Math.min(rx, (x1 - x0) / 2)), cy = Math.max(0, Math.min(ry, (y1 - y0) / 2));
  if (!cx || !cy) return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const out: Vec2[] = [];
  const corner = (c: Vec2, from: number) => { for (const p of arcPoints(c, cx, cy, from, from + 90, segs)) if (!out.length || Math.hypot(p.x - out[out.length - 1]!.x, p.y - out[out.length - 1]!.y) > 1e-9) out.push(p); };
  corner({ x: x1 - cx, y: y1 - cy }, 0);
  corner({ x: x0 + cx, y: y1 - cy }, 90);
  corner({ x: x0 + cx, y: y0 + cy }, 180);
  corner({ x: x1 - cx, y: y0 + cy }, 270);
  const f = out[0]!, l = out[out.length - 1]!;
  if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) out.pop();
  return out;
}

export function snap(v: number, grid: number): number { return grid > 0 ? Math.round(v / grid) * grid : v; }
export function snapPt(p: Vec2, grid: number): Vec2 { return { x: snap(p.x, grid), y: snap(p.y, grid) }; }

/** Point-in-polygon (even-odd). */
export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Ear-clipping triangulation of a simple polygon. Returns index triples. */
export function triangulate(poly: Vec2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y;
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const out: number[] = [];
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length]!, i1 = idx[i]!, i2 = idx[(i + 1) % idx.length]!;
      const a = poly[i0]!, b = poly[i1]!, c = poly[i2]!;
      if (cross(a, b, c) <= 0) continue;
      let ear = true;
      for (const k of idx) {
        if (k === i0 || k === i1 || k === i2) continue;
        if (inTri(poly[k]!, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate; give up on remainder
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}


/** Triangulate an outline with holes. Returns the merged point list and triangle indices into it. */
export function triangulateWithHoles(outline: Vec2[], holes: Vec2[][] = []): { pts: Vec2[]; idx: number[] } {
  const pts = [...outline];
  const holeStarts: number[] = [];
  for (const h of holes) { if (h.length < 3) continue; holeStarts.push(pts.length); pts.push(...h); }
  const flat = new Float64Array(pts.length * 2);
  // Re-centre for float stability on large absolute coordinates
  const ox = outline[0]?.x ?? 0, oy = outline[0]?.y ?? 0;
  pts.forEach((p, i) => { flat[i * 2] = p.x - ox; flat[i * 2 + 1] = p.y - oy; });
  return { pts, idx: earcut(flat, holeStarts.length ? holeStarts : undefined) };
}

/** Outline of a round-ended track from a to b of half-width r (for hollow previews). */
export function capsule(a: Vec2, b: Vec2, r: number, steps = 8): Vec2[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) { const t = ang - Math.PI / 2 + (Math.PI * i) / steps; out.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) }); }
  for (let i = 0; i <= steps; i++) { const t = ang + Math.PI / 2 + (Math.PI * i) / steps; out.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) }); }
  return out;
}
