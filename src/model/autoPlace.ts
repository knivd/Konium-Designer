/**
 * Tools › Component Placement › Auto Placer [est: AD17's cluster / statistical placers aren't
 * documented closely]: the components to place, most connected first, each put where its
 * connections are shortest — on the grid, inside the board (or the room that holds it), clear of
 * what is already there by a gap, turned 90° too when Rotate Components is ticked. It yields
 * between components so it can be stopped.
 */
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import { NO_NET, type PcbDocument } from './pcb';
import { componentExtent, roomsOf } from './rooms';
import type { RouteJob } from './autoroute';
import { breathe } from '../core/breathe';

export interface PlaceMove { component: number; to: Vec2; rot: number }

const inside = (b: BBox, outline: Vec2[]) => [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]].every(([x, y]) => pointInPoly({ x: x!, y: y! }, outline));
const overlaps = (a: BBox, b: BBox, gap: number) => a.minX < b.maxX + gap && a.maxX + gap > b.minX && a.minY < b.maxY + gap && a.maxY + gap > b.minY;

export async function autoPlace(doc: PcbDocument, comps: number[], o: { grid: number; gap: number; rotate: boolean; job?: RouteJob; progress?: (i: number, n: number) => void; members?: (room: ReturnType<typeof roomsOf>[number]) => number[] }): Promise<PlaceMove[]> {
  const outline = doc.board.outline;
  if (outline.length < 3) return [];
  const moving = new Set(comps);
  // What stays: the other components' areas, and their pads by net
  const placed: BBox[] = [];
  const netPts = new Map<number, Vec2[]>();
  const addPads = (c: number, map: (v: Vec2) => Vec2) => {
    for (const p of doc.prims) if (p.kind === 'pad' && p.component === c && p.net !== NO_NET) netPts.set(p.net, [...(netPts.get(p.net) ?? []), map(p.at)]);
  };
  doc.components.forEach((_, c) => {
    if (moving.has(c)) return;
    const b = componentExtent(doc, c);
    if (b) placed.push(b);
    addPads(c, (v) => v);
  });
  // Free pads (not in components) count too
  for (const p of doc.prims) if (p.kind === 'pad' && p.component === NO_NET && p.net !== NO_NET) netPts.set(p.net, [...(netPts.get(p.net) ?? []), p.at]);
  const rooms = roomsOf(doc).filter((r) => r.enabled && r.confine === 'ConfineIn');
  const roomOf = new Map<number, Vec2[]>();
  if (o.members) for (const r of rooms) for (const c of o.members(r)) if (!roomOf.has(c)) roomOf.set(c, r.outline);
  // Most connected first
  const degree = (c: number) => doc.prims.filter((p) => p.kind === 'pad' && p.component === c && p.net !== NO_NET).length;
  const order = [...comps].sort((a, b) => degree(b) - degree(a));
  const bx = outline.map((p) => p.x), by = outline.map((p) => p.y);
  const out: PlaceMove[] = [];
  for (let i = 0; i < order.length; i++) {
    o.progress?.(i, order.length);
    await breathe();
    while (o.job?.paused && !o.job.cancelled) await new Promise((r) => setTimeout(r, 100));
    if (o.job?.cancelled) break;
    const c = order[i]!, comp = doc.components[c]!;
    const ext = componentExtent(doc, c);
    if (!ext) continue;
    const pads = doc.prims.filter((p) => p.kind === 'pad' && p.component === c && p.net !== NO_NET) as { at: Vec2; net: number }[];
    const area = roomOf.get(c) ?? outline;
    const ax = area.map((p) => p.x), ay = area.map((p) => p.y);
    const minX = Math.max(Math.min(...ax), Math.min(...bx)), maxX = Math.min(Math.max(...ax), Math.max(...bx));
    const minY = Math.max(Math.min(...ay), Math.min(...by)), maxY = Math.min(Math.max(...ay), Math.max(...by));
    const size = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY);
    const step = Math.max(o.grid, Math.round(size / 4 / o.grid) * o.grid || o.grid);
    let best: { to: Vec2; rot: number; score: number; box: BBox } | null = null;
    for (const rot of o.rotate ? [0, 90] : [0]) {
      const turn = (v: Vec2): Vec2 => { if (!rot) return v; const dx = v.x - comp.at.x, dy = v.y - comp.at.y; return { x: comp.at.x - dy, y: comp.at.y + dx }; };
      const corners = [turn({ x: ext.minX, y: ext.minY }), turn({ x: ext.maxX, y: ext.maxY })];
      const rel: BBox = { minX: Math.min(corners[0]!.x, corners[1]!.x) - comp.at.x, minY: Math.min(corners[0]!.y, corners[1]!.y) - comp.at.y, maxX: Math.max(corners[0]!.x, corners[1]!.x) - comp.at.x, maxY: Math.max(corners[0]!.y, corners[1]!.y) - comp.at.y };
      const relPads = pads.map((p) => { const q = turn(p.at); return { net: p.net, d: { x: q.x - comp.at.x, y: q.y - comp.at.y } }; });
      for (let x = Math.ceil((minX - rel.minX) / o.grid) * o.grid; x + rel.maxX <= maxX; x += step) {
        for (let y = Math.ceil((minY - rel.minY) / o.grid) * o.grid; y + rel.maxY <= maxY; y += step) {
          const box = { minX: x + rel.minX, minY: y + rel.minY, maxX: x + rel.maxX, maxY: y + rel.maxY };
          if (!inside(box, area) || !inside(box, outline) || placed.some((b) => overlaps(box, b, o.gap))) continue;
          let score = 0;
          for (const p of relPads) {
            const others = netPts.get(p.net);
            if (!others?.length) continue;
            let d = Infinity;
            for (const q of others) d = Math.min(d, Math.hypot(q.x - (x + p.d.x), q.y - (y + p.d.y)));
            score += d;
          }
          if (!best || score < best.score) best = { to: { x, y }, rot, score, box };
        }
      }
    }
    if (!best) continue;
    placed.push(best.box);
    out.push({ component: c, to: best.to, rot: best.rot });
    const d = { x: best.to.x - comp.at.x, y: best.to.y - comp.at.y }, r = best.rot;
    addPads(c, (v) => { const dx = v.x - comp.at.x, dy = v.y - comp.at.y; const q = r ? { x: -dy, y: dx } : { x: dx, y: dy }; return { x: comp.at.x + q.x + d.x, y: comp.at.y + q.y + d.y }; });
  }
  return out;
}
