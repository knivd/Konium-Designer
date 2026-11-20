/**
 * Tools › Update From PCB Libraries: each component's footprint compared with the one of the
 * same name in the libraries in reach (the first library that has it, or the component's own
 * library when it names one) — pads by name, their places in the footprint's own frame, sizes,
 * shapes and holes; the other primitives by count. Those that differ can be taken from the
 * library (the board's swapFootprint: placement, designator, comment and pad nets kept).
 */
import { rotate } from '../core/geom';
import { L } from './layers';
import type { PcbDocument, PcbPad, PcbPrim } from './pcb';
import type { FootprintFinder } from './pcbEco';

export type LibSyncStatus = 'Different' | 'Same' | 'Not Found';
export interface LibSyncRow { component: number; designator: string; footprint: string; library: string; status: LibSyncStatus; why: string }

const near = (a: number, b: number) => Math.abs(a - b) < 100; // 0.01 mil
const key = (p: PcbPad) => p.name;

/** A component's pads as its footprint has them (undone placement: rotation, then the bottom side's reflection). */
function padsInFootprint(doc: PcbDocument, c: number): PcbPad[] {
  const comp = doc.components[c]!;
  const bottom = comp.layer === L.BOTTOM;
  return doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === c).map((p) => {
    let v = rotate(p.at, -comp.rotation, comp.at);
    v = { x: v.x - comp.at.x, y: v.y - comp.at.y };
    if (bottom) v = { x: -v.x, y: v.y };
    const rot = (((bottom ? -(p.rotation - comp.rotation) : p.rotation - comp.rotation) % 180) + 180) % 180;
    return { ...p, at: v, rotation: rot };
  });
}

/** What differs between the placed footprint and the library's ('' when nothing). */
export function footprintDifference(doc: PcbDocument, c: number, lib: PcbPrim[]): string {
  const mine = padsInFootprint(doc, c);
  const theirs = lib.filter((p): p is PcbPad => p.kind === 'pad');
  if (mine.length !== theirs.length) return `${mine.length} pads here, ${theirs.length} in the library`;
  const byName = new Map(theirs.map((p) => [key(p), p]));
  for (const p of mine) {
    const q = byName.get(key(p));
    if (!q) return `pad ${p.name} isn't in the library's footprint`;
    if (!near(p.at.x, q.at.x) || !near(p.at.y, q.at.y)) return `pad ${p.name} is elsewhere`;
    const qr = ((q.rotation % 180) + 180) % 180;
    const same = (near(p.top.w, q.top.w) && near(p.top.h, q.top.h) && Math.abs(p.rotation - qr) < 0.01) || (near(p.top.w, q.top.h) && near(p.top.h, q.top.w) && Math.abs(Math.abs(p.rotation - qr) - 90) < 0.01);
    if (!same) return `pad ${p.name} has another size`;
    if (p.top.shape !== q.top.shape) return `pad ${p.name} has another shape`;
    if (!near(p.hole, q.hole)) return `pad ${p.name} has another hole`;
  }
  const others = (prims: PcbPrim[]) => prims.filter((p) => p.kind !== 'pad' && p.kind !== 'body' && !(p.kind === 'text' && (p.isDesignator || p.isComment))).length;
  const here = others(doc.prims.filter((p) => 'component' in p && p.component === c)), there = others(lib);
  if (here !== there) return `${here} other primitives here, ${there} in the library`;
  return '';
}

export function libSyncRows(doc: PcbDocument, find: FootprintFinder): LibSyncRow[] {
  return doc.components.map((c, i) => {
    const lib = c.bag.get('SOURCEFOOTPRINTLIBRARY') || undefined;
    const f = find(c.pattern, lib) ?? (lib ? find(c.pattern) : undefined);
    if (!f) return { component: i, designator: c.designator, footprint: c.pattern, library: '', status: 'Not Found' as const, why: 'in none of the libraries in reach' };
    const why = footprintDifference(doc, i, f.footprint.prims);
    return { component: i, designator: c.designator, footprint: c.pattern, library: f.library, status: why ? 'Different' as const : 'Same' as const, why };
  });
}
