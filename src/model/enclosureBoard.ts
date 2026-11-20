/**
 * What the enclosure designer needs of a board: its extent and thickness, how tall its parts are
 * above and below it, its mounting holes (holes of 2–6 mm that aren't a connection's: no net, or a
 * free pad, or a pad named as a mounting hole), and its parts on top with their plan extents —
 * all in millimetres, the board's centre at the origin (as its 3D model).
 */
import { UNITS_PER_MM } from '../core/units';
import { buildBoardModel } from '../render/gl3d/boardModel';
import { NO_NET, type PcbDocument } from './pcb';
import { partKind, type BoardFacts } from './enclosure';
import { L } from './layers';
import { WIRE_LINK_HEIGHT, wireLinks } from './wireLink';

export function boardFacts(doc: PcbDocument): BoardFacts {
  const bm = buildBoardModel(doc);
  const t = bm.thickness;
  const w = (bm.rect.maxX - bm.rect.minX) / UNITS_PER_MM, h = (bm.rect.maxY - bm.rect.minY) / UNITS_PER_MM;
  let top = 0, bottom = 0;
  const parts = new Map<number, { x0: number; y0: number; x1: number; y1: number; z1: number }>();
  for (const b of bm.bodies) {
    const lo = Math.min(b.z0, b.z1), hi = Math.max(b.z0, b.z1);
    if (hi > t + 1e-3) top = Math.max(top, hi - t);
    if (lo < -1e-3) { bottom = Math.max(bottom, -lo); continue; }
    if (b.component === 0xffff) continue;
    const xs = b.outline.map((q) => q.x), ys = b.outline.map((q) => q.y);
    const was = parts.get(b.component);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), z1: hi - t };
    parts.set(b.component, was ? { x0: Math.min(was.x0, box.x0), y0: Math.min(was.y0, box.y0), x1: Math.max(was.x1, box.x1), y1: Math.max(was.y1, box.y1), z1: Math.max(was.z1, box.z1) } : box);
  }
  // Wire links stand off the board by their height and half the wire
  for (const wl of wireLinks(doc)) {
    const rise = (WIRE_LINK_HEIGHT + wl.width / 2) / UNITS_PER_MM;
    if (wl.side === L.BOTTOM) bottom = Math.max(bottom, rise); else top = Math.max(top, rise);
  }
  const mm = (v: number, c: number) => (v - c) / UNITS_PER_MM;
  const holes = doc.prims.flatMap((p) => {
    if (p.kind !== 'pad' || p.hole <= 0) return [];
    const d = p.hole / UNITS_PER_MM;
    if (d < 2 || d > 6) return [];
    const mounting = p.net === NO_NET || p.component === NO_NET || /^(MH|H|M|MTG|MOUNT)\d*$/i.test(p.name);
    return mounting ? [{ x: mm(p.at.x, bm.centre.x), y: mm(p.at.y, bm.centre.y), d }] : [];
  });
  return {
    w, h, thickness: t, top, bottom, holes,
    parts: [...parts].map(([c, b]) => { const k = doc.components[c]; return { name: k?.designator ?? `#${c}`, ...b, kind: k ? partKind(k.designator, k.pattern, k.bag.get('SOURCEDESCRIPTION') ?? '') : 'other' }; }),
  };
}
