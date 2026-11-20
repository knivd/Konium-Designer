/**
 * The editor's geometry: a shape's connection points, alignment guides while moving, turning a
 * point about a centre, resizing a turned shape by one of its handles, and which shapes take
 * others in (containers) or hold them together (groups).
 */
import { portPoint, type Cell, type P, type Rect } from '../../formats/drawio';
import { look } from './render';
import { readStencil } from '../../formats/stencil';

/** How far a clone (a hover arrow's click) or a shape added beside the selected one goes [est: the format editors' default connector length]. */
export const EDGE_LENGTH = 80;

/** A connection point: fractions of the shape's box; perimeter: a connector's end goes onto the shape's outline there (as the format's points do unless they say otherwise). */
export type Port = P & { perimeter: boolean };
const onOutline = (q: P): Port => ({ ...q, perimeter: true });
/** A shape's connection points, as fractions of its box: its style's points=[[x,y,perimeter],…], else its kind's own (a stencil's: exactly where it puts them). */
export function connectionPoints(c: Pick<Cell, 'style'>): Port[] {
  const own = look(c.style, 'points');
  if (own !== undefined) {
    try {
      const pts = JSON.parse(own) as number[][];
      return pts.filter((q) => q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1])).map((q) => ({ x: q[0]!, y: q[1]!, perimeter: q.length < 3 || Number(q[2]) !== 0 }));
    } catch { /* the kind's own */ }
  }
  return builtInPoints(c);
}
function builtInPoints(c: Pick<Cell, 'style'>): Port[] {
  const shape = c.style.shape();
  if (shape.startsWith('stencil(')) { const st = readStencil(shape); if (st?.points.length) return st.points.map((q) => ({ x: q.x, y: q.y, perimeter: !!q.perimeter })); }
  return kindPoints(shape).map(onOutline);
}
function kindPoints(shape: string): P[] {
  if (shape === 'ellipse' || shape === 'doubleEllipse' || shape === 'cloud') return Array.from({ length: 8 }, (_, i) => ({ x: 0.5 + 0.5 * Math.cos((i * Math.PI) / 4), y: 0.5 + 0.5 * Math.sin((i * Math.PI) / 4) })).map((q) => ({ x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 }));
  if (shape === 'rhombus') return [{ x: 0.5, y: 0 }, { x: 0.75, y: 0.25 }, { x: 1, y: 0.5 }, { x: 0.75, y: 0.75 }, { x: 0.5, y: 1 }, { x: 0.25, y: 0.75 }, { x: 0, y: 0.5 }, { x: 0.25, y: 0.25 }];
  if (shape === 'triangle') return [{ x: 0, y: 0 }, { x: 0, y: 0.25 }, { x: 0, y: 0.5 }, { x: 0, y: 0.75 }, { x: 0, y: 1 }, { x: 0.5, y: 0.25 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.75 }];
  if (shape === 'text' || shape === 'edgeLabel' || shape === 'line') return [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }];
  const out: P[] = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) out.push({ x: f, y: 0 }, { x: f, y: 1 });
  for (const f of [0.25, 0.5, 0.75]) out.push({ x: 0, y: f }, { x: 1, y: f });
  return out;
}

/** Where a shape's connection point is on the page (turned, flipped and on its outline as the shape is). */
export const portAt = (r: Rect, c: Pick<Cell, 'style'>, f: Port): P => portPoint(r, c.style, f, { x: 0, y: 0 }, f.perimeter);
/** The connection point nearest to q within tol (page units). */
export function nearestPoint(r: Rect, c: Pick<Cell, 'style'>, pts: Port[], q: P, tol: number): Port | null {
  let best: Port | null = null, bd = tol;
  for (const f of pts) {
    const at = portAt(r, c, f);
    const d = Math.hypot(at.x - q.x, at.y - q.y);
    if (d <= bd) { bd = d; best = f; }
  }
  return best;
}

export interface Guide { x1: number; y1: number; x2: number; y2: number }
/**
 * Guides while shapes move: the moving box's left side, centre or right side (top, middle or
 * bottom) lined up with another shape's within tol; the move adjusted to it, and the lines to draw.
 */
export function guideSnap(moving: Rect, others: Rect[], tol: number): { dx: number | null; dy: number | null; lines: Guide[] } {
  let dx: number | null = null, dy: number | null = null, bx = tol + 1, by = tol + 1;
  let gx: { at: number; o: Rect } | null = null, gy: { at: number; o: Rect } | null = null;
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w], my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w], oy = [o.y, o.y + o.h / 2, o.y + o.h];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      // Like with like (sides with sides, centre with centre) first, as the editors do
      const ex = Math.abs(ox[j]! - mx[i]!) + ((i === 1) !== (j === 1) ? 0.01 : 0);
      if (ex < bx) { bx = ex; dx = ox[j]! - mx[i]!; gx = { at: ox[j]!, o }; }
      const ey = Math.abs(oy[j]! - my[i]!) + ((i === 1) !== (j === 1) ? 0.01 : 0);
      if (ey < by) { by = ey; dy = oy[j]! - my[i]!; gy = { at: oy[j]!, o }; }
    }
  }
  const lines: Guide[] = [];
  if (gx && dx !== null) { const y0 = Math.min(moving.y + (dy ?? 0), gx.o.y), y1 = Math.max(moving.y + (dy ?? 0) + moving.h, gx.o.y + gx.o.h); lines.push({ x1: gx.at, y1: y0, x2: gx.at, y2: y1 }); }
  if (gy && dy !== null) { const x0 = Math.min(moving.x + (dx ?? 0), gy.o.x), x1 = Math.max(moving.x + (dx ?? 0) + moving.w, gy.o.x + gy.o.w); lines.push({ x1: x0, y1: gy.at, x2: x1, y2: gy.at }); }
  return { dx, dy, lines };
}

/** q turned by deg (clockwise on the page) about c. */
export function turn(q: P, c: P, deg: number): P {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return { x: c.x + (q.x - c.x) * cos - (q.y - c.y) * sin, y: c.y + (q.x - c.x) * sin + (q.y - c.y) * cos };
}

/**
 * A shape (turned by rot) resized by the handle at h (0, 0.5 or 1 across and down its box) moved
 * by d on the page: its new box, the side or corner across from the handle staying where it is.
 * keep: the box keeps its proportions.
 */
export function resizeBy(r0: Rect, rot: number, h: [number, number], d: P, keep: boolean, min = 10): Rect {
  const l = turn(d, { x: 0, y: 0 }, -rot);
  let w = r0.w + (h[0] === 1 ? l.x : h[0] === 0 ? -l.x : 0), hh = r0.h + (h[1] === 1 ? l.y : h[1] === 0 ? -l.y : 0);
  if (keep && r0.w && r0.h) {
    const k = h[0] === 0.5 ? hh / r0.h : h[1] === 0.5 ? w / r0.w : Math.max(w / r0.w, hh / r0.h);
    w = r0.w * k; hh = r0.h * k;
  }
  w = Math.max(min, w); hh = Math.max(min, hh);
  // The anchor: across from the handle, in the shape's frame, then on the page
  const ax = 1 - h[0], ay = 1 - h[1];
  const c0 = { x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 };
  const anchor = turn({ x: r0.x + ax * r0.w, y: r0.y + ay * r0.h }, c0, rot);
  // The new box's centre: the anchor plus the half-diagonal towards the handle, turned
  const off = turn({ x: (0.5 - ax) * w, y: (0.5 - ay) * hh }, { x: 0, y: 0 }, rot);
  const c = { x: anchor.x + off.x, y: anchor.y + off.y };
  return { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
}

/** A container: a shape that takes in the shapes dropped on it (a swimlane, or container=1). */
export const isContainer = (c: Pick<Cell, 'style'>) => c.style.shape() === 'swimlane' || look(c.style, 'container') === '1';
/** A group: picked as one until it is picked again (a group, or a shape whose cells are its children without being a container). */
export const isGroup = (c: Pick<Cell, 'style'>) => c.style.shape() === 'group' || c.style.has('group');

/** Where a route crosses the routes drawn before it (not at their ends): the points its line jumps over. */
export function crossings(route: P[], earlier: P[][]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!, b = route[i + 1]!;
    for (const r of earlier) for (let j = 0; j + 1 < r.length; j++) {
      const c = r[j]!, d = r[j + 1]!;
      const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}
