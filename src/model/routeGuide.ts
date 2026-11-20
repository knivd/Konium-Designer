/**
 * ActiveRoute's route guide, as AD lays connections along it: the space each takes across it, its
 * width when none is given, and each connection's lane, layer and escapes (see router.ts's
 * RouteGuide).
 */
import { settings } from '../core/settings';
import { mil } from '../core/units';
import { distToSegment, type Vec2 } from '../core/geom';
import { netRouting, probeTrack } from './autoroute';
import { clearanceGap, type Connection } from './drc';
import { NO_NET, type PcbDocument, type PcbPad } from './pcb';
import { L, type LayerId } from './layers';
import type { RouteGuide } from './router';

/** The space a connection takes across a route guide, centre to centre: its track and its gap (or the panel's Track-Track Space). */
export function lanePitch(doc: PcbDocument, c: Connection): number {
  const r = netRouting(doc, c.net), gap = clearanceGap(doc, probeTrack(c.net), probeTrack(NO_NET)) || mil(8);
  return Math.max(r.width + gap, settings.activeRouteGuideSpace || 0);
}
/** The layers a connection can be routed on with no via: those of the ones given that both its pads are on. */
export function connectionLayers(doc: PcbDocument, c: Connection, layers: LayerId[]): LayerId[] {
  const pad = (p: Vec2) => doc.prims.find((q): q is PcbPad => q.kind === 'pad' && q.net === c.net && Math.abs(q.at.x - p.x) < 2 && Math.abs(q.at.y - p.y) < 2);
  const pa = pad(c.a), pb = pad(c.b);
  const on = (p: PcbPad | undefined, l: LayerId) => !p || p.layer === L.MULTI || p.layer === l;
  return layers.filter((l) => on(pa, l) && on(pb, l));
}

/**
 * The connections laid across a guide: in the order they meet its start, each on a layer it can be
 * routed on — alternate ones on alternate layers where their pads allow — and its place across the
 * guide (lanes on one layer a pitch apart, on different layers half that); the layers they share
 * in effect (all of them when every connection may take any; else the connections over the most
 * on any one layer).
 */
export function laneLayout(doc: PcbDocument, conns: Connection[], layers: LayerId[], order = conns): { lanes: Map<Connection, { lane: number; layer: LayerId }>; pitch: number; layers: number } {
  const pitch = conns.reduce((m, c) => Math.max(m, lanePitch(doc, c)), 0);
  const nL = Math.max(1, layers.length), at = new Map<LayerId, number>(), count = new Map<LayerId, number>();
  const placed: { c: Connection; x: number; layer: LayerId }[] = [];
  let prev: LayerId | undefined, x = 0, free = true;
  for (const c of order) {
    const can = connectionLayers(doc, c, layers);
    if (can.length < layers.length) free = false;
    const choice = can.length ? can : layers.slice(0, 1);
    // Another layer than the last lane's, the least used first
    const layer = [...choice].sort((a, b) => (a === prev ? 1 : 0) - (b === prev ? 1 : 0) || (count.get(a) ?? 0) - (count.get(b) ?? 0))[0] ?? layers[0]!;
    if (placed.length) x = Math.max(x + pitch / nL, (at.get(layer) ?? -Infinity) + pitch);
    placed.push({ c, x, layer });
    at.set(layer, x); count.set(layer, (count.get(layer) ?? 0) + 1); prev = layer;
  }
  const mid = placed.length ? placed.at(-1)!.x / 2 : 0;
  const most = Math.max(1, ...count.values());
  // Every connection free to take any of the layers: all of them (AD's sum); else as they were shared out
  return { lanes: new Map(placed.map((p) => [p.c, { lane: p.x - mid, layer: p.layer }])), pitch, layers: free ? nL : Math.max(1, Math.min(nL, conns.length / most)) };
}

/** A route guide's width when none is given, as AD works it out: the connections' tracks and gaps over the layers (those they can share), and 30% more. */
export function guideWidth(doc: PcbDocument, conns: Connection[], layers: LayerId[]): number {
  const w = conns.reduce((t, c) => t + lanePitch(doc, c), 0);
  return Math.max(mil(20), Math.round((w / laneLayout(doc, conns, layers).layers) * 1.3));
}

/**
 * Each connection's way along a route guide: its lane (the connections in the order they meet the
 * guide's start, side by side, alternate ones on alternate layers), the guide as a hard edge, and
 * escapes round its pads where it comes off them to the guide.
 */
export function guideLanes(doc: PcbDocument, conns: Connection[], guide: RouteGuide, layers: LayerId[]): { guideFor: (c: Connection) => RouteGuide; layersFor: (c: Connection) => LayerId[] } {
  const g0 = guide.pts[0]!, g1 = guide.pts[1]!, len = Math.hypot(g1.x - g0.x, g1.y - g0.y) || 1;
  const across = (p: Vec2) => ((g1.x - g0.x) * (p.y - g0.y) - (g1.y - g0.y) * (p.x - g0.x)) / len;
  const entry = (c: Connection) => (Math.hypot(c.a.x - g0.x, c.a.y - g0.y) <= Math.hypot(c.b.x - g0.x, c.b.y - g0.y) ? c.a : c.b);
  const order = [...conns].sort((a, b) => across(entry(a)) - across(entry(b)));
  const { lanes, pitch } = laneLayout(doc, conns, layers, order);
  const toGuide = (p: Vec2) => Math.min(...guide.pts.slice(1).map((q, i) => distToSegment(p, guide.pts[i]!, q)));
  return {
    guideFor: (c) => ({ ...guide, hard: true, lane: lanes.get(c)?.lane ?? 0, escape: [c.a, c.b].map((p) => ({ c: p, r: Math.max(2 * pitch, toGuide(p) - guide.width / 2 + 2 * pitch) })) }),
    layersFor: (c) => { const l = lanes.get(c)?.layer; return l === undefined ? [] : [l]; },
  };
}
