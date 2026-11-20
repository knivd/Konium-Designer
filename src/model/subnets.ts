/**
 * Route › Add Subnet Jumpers / Remove Subnet Jumpers: a net whose copper is in pieces (its
 * subnets: pads, tracks, arcs and vias that touch, or meet through a plane) gets a jumper track
 * between the nearest points of the pieces, shortest first as a spanning tree, where the jumper
 * is no longer than the limit and both its ends lie on the layer it runs on (through-hole pads
 * and vias are on every layer). Jumpers go into a union named "Subnet Jumpers", so Remove
 * finds them [est: how AD marks its jumpers].
 */
import type { Vec2 } from '../core/geom';
import { L, isSignal, type LayerId } from './layers';
import { NO_NET, type PcbDocument } from './pcb';
import { copperIslands } from './drc';
import { netRouting } from './autoroute';

export interface SubnetPoint { at: Vec2; layers: LayerId[] | 'all' }
export interface Jumper { net: number; a: Vec2; b: Vec2; layer: LayerId; width: number; length: number }

/** Each net's pieces of copper, with the points a jumper can start from. */
export function subnets(doc: PcbDocument): Map<number, SubnetPoint[][]> {
  const find = copperIslands(doc);
  const byNet = new Map<number, Map<number, SubnetPoint[]>>();
  doc.prims.forEach((p, i) => {
    if (!('net' in p) || p.net === NO_NET) return;
    const pts: SubnetPoint[] = [];
    if (p.kind === 'pad') pts.push({ at: p.at, layers: p.layer === L.MULTI ? 'all' : [p.layer] });
    else if (p.kind === 'via') pts.push({ at: p.at, layers: 'all' });
    else if (p.kind === 'track' && isSignal(p.layer)) pts.push({ at: p.a, layers: [p.layer] }, { at: p.b, layers: [p.layer] });
    else if (p.kind === 'arc' && isSignal(p.layer)) {
      const e = (d: number) => ({ x: p.c.x + p.r * Math.cos((d * Math.PI) / 180), y: p.c.y + p.r * Math.sin((d * Math.PI) / 180) });
      pts.push({ at: e(p.start), layers: [p.layer] }, { at: e(p.end), layers: [p.layer] });
    } else return;
    const isl = find(i);
    const m = byNet.get(p.net) ?? byNet.set(p.net, new Map()).get(p.net)!;
    m.set(isl, [...(m.get(isl) ?? []), ...pts]);
  });
  const out = new Map<number, SubnetPoint[][]>();
  for (const [net, m] of byNet) if (m.size > 1) out.set(net, [...m.values()]);
  return out;
}

const onLayer = (p: SubnetPoint, l: LayerId) => p.layers === 'all' || p.layers.includes(l);

/** The jumpers that join each net's pieces (no longer than `maxLength`), on `layer`. */
export function planJumpers(doc: PcbDocument, layer: LayerId, maxLength: number): { jumpers: Jumper[]; left: number } {
  const jumpers: Jumper[] = [];
  let left = 0;
  for (const [net, pieces] of subnets(doc)) {
    // Prim's algorithm over the pieces, by the nearest pair of points that can carry a jumper on the layer
    const joined = new Set<number>([0]);
    const width = netRouting(doc, net).width;
    while (joined.size < pieces.length) {
      let best: { i: number; a: Vec2; b: Vec2; d: number } | null = null;
      for (const i of joined) for (let j = 0; j < pieces.length; j++) {
        if (joined.has(j)) continue;
        for (const p of pieces[i]!) { if (!onLayer(p, layer)) continue; for (const q of pieces[j]!) {
          if (!onLayer(q, layer)) continue;
          const d = Math.hypot(p.at.x - q.at.x, p.at.y - q.at.y);
          if (!best || d < best.d) best = { i: j, a: p.at, b: q.at, d };
        } }
      }
      if (!best || best.d > maxLength) { left += pieces.length - joined.size; break; }
      joined.add(best.i);
      if (best.d > 0) jumpers.push({ net, a: best.a, b: best.b, layer, width, length: best.d });
    }
  }
  return { jumpers, left };
}

export const JUMPER_UNION = 'Subnet Jumpers';
