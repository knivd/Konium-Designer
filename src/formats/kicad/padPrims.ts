/**
 * KiCad's custom pads and pads with no copper, kept for the way back (R9). A custom pad comes in
 * as Konium's polygon pad: the anchor pad and regions marked as its shape, each region holding the
 * KiCad primitive it was drawn from (KICADPRIM, KiCad's own numbers: the pad's millimetres, Y
 * down, unturned) so the export writes that primitive again while the region is still what it
 * drew. A pad on no copper (a paste or mask opening alone) comes in as regions on those layers
 * with the pad itself (KICADAPERTURE: its number among the footprint's, KICADPAD: the pad), and
 * goes back as that pad.
 */
import type { Vec2 } from '../../core/geom';
import { mm } from '../../core/units';
import { clipPieces, offsetOutline, strokeOutlines } from '../../model/outlineOps';
import { L, bare, isList, kid, num, type SList, type WNode } from './sexpr';

type XY = [number, number];
/** A custom pad's primitive as KiCad has it. */
export type Prim =
  | { k: 'poly'; pts: XY[]; w: number; fill: boolean }
  | { k: 'circle'; c: XY; e: XY; w: number; fill: boolean }
  | { k: 'rect'; s: XY; e: XY; w: number; fill: boolean }
  | { k: 'arc'; s: XY; m: XY; e: XY; w: number }
  | { k: 'line'; s: XY; e: XY; w: number };

const xy = (n: SList | undefined): XY => [num(n, 0), num(n, 1)];
const filled = (g: SList, def: boolean) => { const f = kid(g, 'fill'); return f ? !/^(no|none)$/i.test(String(f.items[0] ?? 'yes')) : def; };
const width = (g: SList) => num(kid(g, 'width') ?? kid(kid(g, 'stroke'), 'width'), 0, 0);

/** A primitive of the file (gr_poly, gr_circle, gr_rect, gr_arc, gr_line), or null for one this doesn't know. */
export function primOf(g: SList): Prim | null {
  switch (g.k) {
    case 'gr_poly': {
      const list = kid(g, 'pts')?.items.filter(isList) ?? [];
      if (list.some((p) => p.k !== 'xy')) return null;
      return { k: 'poly', pts: list.map(xy), w: width(g), fill: filled(g, true) };
    }
    case 'gr_circle': return { k: 'circle', c: xy(kid(g, 'center')), e: xy(kid(g, 'end')), w: width(g), fill: filled(g, width(g) === 0) };
    case 'gr_rect': return { k: 'rect', s: xy(kid(g, 'start')), e: xy(kid(g, 'end')), w: width(g), fill: filled(g, width(g) === 0) };
    case 'gr_arc': return { k: 'arc', s: xy(kid(g, 'start')), m: xy(kid(g, 'mid')), e: xy(kid(g, 'end')), w: width(g) };
    case 'gr_line': return { k: 'line', s: xy(kid(g, 'start')), e: xy(kid(g, 'end')), w: width(g) };
    default: return null;
  }
}

/** The primitive as the file writes it. */
export function primNode(p: Prim): WNode {
  const yes = (f: boolean) => L('fill', bare(f ? 'yes' : 'no'));
  switch (p.k) {
    case 'poly': return L('gr_poly', L('pts', ...p.pts.map(([x, y]) => L('xy', x, y))), L('width', p.w), yes(p.fill));
    case 'circle': return L('gr_circle', L('center', ...p.c), L('end', ...p.e), L('width', p.w), yes(p.fill));
    case 'rect': return L('gr_rect', L('start', ...p.s), L('end', ...p.e), L('width', p.w), yes(p.fill));
    case 'arc': return L('gr_arc', L('start', ...p.s), L('mid', ...p.m), L('end', ...p.e), L('width', p.w));
    case 'line': return L('gr_line', L('start', ...p.s), L('end', ...p.e), L('width', p.w));
  }
}

/** A value kept in a record's properties: JSON with nothing a property list would split on. */
export const keepJson = (v: unknown): string => JSON.stringify(v).replace(/[|=\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export const readJson = <T>(s: string | undefined): T | null => { if (!s) return null; try { return JSON.parse(s) as T; } catch { return null; } };

/** Pad millimetres (Y down, unturned) → the board, about the pad's centre turned by its angle. */
export function padToBoard(c: Vec2, angle: number): (p: XY) => Vec2 {
  const r = (angle * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return ([x, y]) => ({ x: c.x + Math.round(mm(x * cos + y * sin)), y: c.y - Math.round(mm(-x * sin + y * cos)) });
}

const N = 24;
function arcThrough(s: XY, m: XY, e: XY): XY[] {
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [s, e];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // The way round that passes the middle point
  let sweep = norm(a1 - a0);
  if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 48));
  return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (sweep * i) / n; return [ux + r * Math.cos(a), uy + r * Math.sin(a)] as XY; });
}
const ring = (c: XY, r: number): XY[] => Array.from({ length: N }, (_, i) => [c[0] + r * Math.cos((i / N) * 2 * Math.PI), c[1] + r * Math.sin((i / N) * 2 * Math.PI)]);

/** The copper (or opening) a primitive covers on the board: outlines with their holes. */
export function primShapes(p: Prim, to: (p: XY) => Vec2): { outline: Vec2[]; holes: Vec2[][] }[] {
  const w = mm(p.w);
  const solid = (pts: XY[]) => { const o = pts.map(to); return (w > 0 ? offsetOutline(o, w / 2) : [o]).filter((x) => x.length >= 3).map((outline) => ({ outline, holes: [] as Vec2[][] })); };
  // Strokes joined, a closed one a ring (its hole kept)
  const strokes = (lines: XY[][]) => clipPieces('union', strokeOutlines(lines.map((l) => ({ pts: l.map(to), width: Math.max(1, w) }))));
  switch (p.k) {
    case 'poly': return p.fill || !w ? solid(p.pts) : strokes([[...p.pts, p.pts[0]!]]);
    case 'circle': {
      const r = Math.hypot(p.e[0] - p.c[0], p.e[1] - p.c[1]);
      if (p.fill || !w) return [{ outline: ring(p.c, r + p.w / 2).map(to), holes: [] }];
      return [{ outline: ring(p.c, r + p.w / 2).map(to), holes: r - p.w / 2 > 0 ? [ring(p.c, r - p.w / 2).map(to).reverse()] : [] }];
    }
    case 'rect': {
      const pts: XY[] = [p.s, [p.e[0], p.s[1]], p.e, [p.s[0], p.e[1]]];
      return p.fill || !w ? solid(pts) : strokes([[...pts, pts[0]!]]);
    }
    case 'arc': return strokes([arcThrough(p.s, p.m, p.e)]);
    case 'line': return strokes([[p.s, p.e]]);
  }
}

/** Whether a region still is what a primitive drew (each corner within 5 µm, as many). */
export function sameShape(a: Vec2[], b: Vec2[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.x - b[i]!.x) <= 50 && Math.abs(p.y - b[i]!.y) <= 50);
}

/** A pad on no copper, kept whole: what the export writes back. */
export interface ApertureKept {
  name: string; type: string; shape: string;
  /** Its place in the footprint (unturned) and its own turn (the footprint's taken off). */
  at: XY; angle: number; size: XY; layers: string[];
  rratio?: number; anchor?: string; clearance?: string; prims?: Prim[];
  /** Its settings Konium makes nothing of (kept.ts extrasOf). */
  x?: SList[];
  /** Its uuid. */
  id?: string;
}
