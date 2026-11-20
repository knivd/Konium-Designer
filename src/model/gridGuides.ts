/**
 * The Grid Manager's grids and the Guide Manager's work guides. The Global Board Snap Grid is
 * the board's own (SNAPGRIDSIZE…); the others — Cartesian grids over a region, Polar grids
 * round a centre — and the guides (horizontal, vertical, ±45° lines, points) are kept in Board6
 * under KONIUMGRIDn / KONIUMGUIDEn [est: AD17's own keys for them aren't known]. Snapping takes
 * a guide within reach first, then the first enabled grid whose area holds the point, then the
 * global grid.
 */
import type { BBox, Vec2 } from '../core/geom';
import type { PropertyBag } from '../formats/altium/props';

export interface CartesianGrid { kind: 'cartesian'; name: string; enabled: boolean; area: BBox; stepX: number; stepY: number; dots: boolean }
export interface PolarGrid { kind: 'polar'; name: string; enabled: boolean; centre: Vec2; radialStep: number; angleStep: number; r0: number; r1: number; a0: number; a1: number; dots: boolean }
export type LocalGrid = CartesianGrid | PolarGrid;
export type GuideKind = 'h' | 'v' | 'p45' | 'm45' | 'point';
export interface Guide { kind: GuideKind; at: Vec2; enabled: boolean }

const enc = (o: Record<string, string | number | boolean>) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'T' : 'F') : String(v).replace(/[;=]/g, '_')}`).join(';');
const dec = (s: string): Record<string, string> => Object.fromEntries(s.split(';').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const num = (v: string | undefined, d = 0) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

export function readGrids(bag: PropertyBag | undefined): LocalGrid[] {
  const out: LocalGrid[] = [];
  for (let i = 0; bag?.has(`KONIUMGRID${i}`); i++) {
    const o = dec(bag.get(`KONIUMGRID${i}`) ?? '');
    const enabled = o.on !== 'F', dots = o.dots === 'T', name = o.name ?? `Grid ${i + 1}`;
    if (o.kind === 'polar') out.push({ kind: 'polar', name, enabled, dots, centre: { x: num(o.cx), y: num(o.cy) }, radialStep: num(o.rs, 100_000), angleStep: num(o.as, 15), r0: num(o.r0), r1: num(o.r1, 10_000_000), a0: num(o.a0), a1: num(o.a1, 360) });
    else out.push({ kind: 'cartesian', name, enabled, dots, area: { minX: num(o.x1), minY: num(o.y1), maxX: num(o.x2), maxY: num(o.y2) }, stepX: num(o.sx, 100_000), stepY: num(o.sy, 100_000) });
  }
  return out;
}
export function writeGrids(bag: PropertyBag, grids: LocalGrid[]): void {
  for (let i = 0; bag.has(`KONIUMGRID${i}`); i++) bag.delete(`KONIUMGRID${i}`);
  grids.forEach((g, i) => bag.set(`KONIUMGRID${i}`, g.kind === 'polar'
    ? enc({ kind: 'polar', name: g.name, on: g.enabled, dots: g.dots, cx: g.centre.x, cy: g.centre.y, rs: g.radialStep, as: g.angleStep, r0: g.r0, r1: g.r1, a0: g.a0, a1: g.a1 })
    : enc({ kind: 'cartesian', name: g.name, on: g.enabled, dots: g.dots, x1: g.area.minX, y1: g.area.minY, x2: g.area.maxX, y2: g.area.maxY, sx: g.stepX, sy: g.stepY })));
}
export function readGuides(bag: PropertyBag | undefined): Guide[] {
  const out: Guide[] = [];
  for (let i = 0; bag?.has(`KONIUMGUIDE${i}`); i++) {
    const o = dec(bag.get(`KONIUMGUIDE${i}`) ?? '');
    out.push({ kind: (['h', 'v', 'p45', 'm45', 'point'].includes(o.kind ?? '') ? o.kind : 'h') as GuideKind, at: { x: num(o.x), y: num(o.y) }, enabled: o.on !== 'F' });
  }
  return out;
}
export function writeGuides(bag: PropertyBag, guides: Guide[]): void {
  for (let i = 0; bag.has(`KONIUMGUIDE${i}`); i++) bag.delete(`KONIUMGUIDE${i}`);
  guides.forEach((g, i) => bag.set(`KONIUMGUIDE${i}`, enc({ kind: g.kind, x: g.at.x, y: g.at.y, on: g.enabled })));
}

/** Where a guide pulls a point within `reach` (null when none does). */
export function snapToGuide(guides: Guide[], p: Vec2, reach: number): Vec2 | null {
  let best: { q: Vec2; d: number } | null = null;
  const take = (q: Vec2) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= reach && (!best || d < best.d)) best = { q, d }; };
  for (const g of guides) {
    if (!g.enabled) continue;
    switch (g.kind) {
      case 'h': take({ x: p.x, y: g.at.y }); break;
      case 'v': take({ x: g.at.x, y: p.y }); break;
      case 'point': take(g.at); break;
      case 'p45': case 'm45': {
        // The line through g.at at ±45°: project onto it
        const u = g.kind === 'p45' ? { x: Math.SQRT1_2, y: Math.SQRT1_2 } : { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
        const t = (p.x - g.at.x) * u.x + (p.y - g.at.y) * u.y;
        take({ x: Math.round(g.at.x + u.x * t), y: Math.round(g.at.y + u.y * t) });
        break;
      }
    }
  }
  return (best as { q: Vec2 } | null)?.q ?? null;
}

/** The first enabled local grid whose area holds the point, snapped to it. */
export function snapToLocalGrid(grids: LocalGrid[], p: Vec2): Vec2 | null {
  for (const g of grids) {
    if (!g.enabled) continue;
    if (g.kind === 'cartesian') {
      const a = g.area;
      if (p.x < a.minX || p.x > a.maxX || p.y < a.minY || p.y > a.maxY) continue;
      return { x: Math.round(a.minX + Math.round((p.x - a.minX) / g.stepX) * g.stepX), y: Math.round(a.minY + Math.round((p.y - a.minY) / g.stepY) * g.stepY) };
    }
    const dx = p.x - g.centre.x, dy = p.y - g.centre.y, r = Math.hypot(dx, dy);
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    if (r < g.r0 || r > g.r1 || ang < g.a0 || ang > g.a1) continue;
    const rr = Math.max(g.r0, Math.min(g.r1, g.r0 + Math.round((r - g.r0) / g.radialStep) * g.radialStep));
    const aa = (Math.max(g.a0, Math.min(g.a1, g.a0 + Math.round((ang - g.a0) / g.angleStep) * g.angleStep)) * Math.PI) / 180;
    return { x: Math.round(g.centre.x + rr * Math.cos(aa)), y: Math.round(g.centre.y + rr * Math.sin(aa)) };
  }
  return null;
}
