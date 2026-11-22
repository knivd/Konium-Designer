/**
 * Teardrops as builds before 26.209 made them: where a track ends in a pad or via, two tracks or
 * arcs from the pad's edge either side back to the track widen the joint. Tools › Teardrops now
 * makes copper regions (teardropRegions.ts); this planner is kept for the boards the showcase
 * draws, and the finder so that Remove also takes such teardrops off a board that has them. It
 * finds them by their shape [est]: a track or arc of the net from inside a pad or via (off its
 * centre) to the middle of another track of the net.
 */
import type { Vec2 } from '../core/geom';
import { distToSegment } from '../core/geom';
import { L, isSignal, type LayerId } from './layers';
import { NO_NET, type PcbArc, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from './pcb';
import { checkCopper } from './drc';

export interface TeardropOptions { pads: boolean; vias: boolean; selectedOnly: boolean; force: boolean; style: 'track' | 'arc' }
export interface TeardropTrack { layer: LayerId; a: Vec2; b: Vec2; width: number; net: number }
export interface TeardropArc { layer: LayerId; c: Vec2; r: number; start: number; end: number; width: number; net: number }
export interface TeardropPlan { tracks: TeardropTrack[]; arcs: TeardropArc[]; joints: number; skipped: number }

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
const DEG = 180 / Math.PI;

/** The radius a teardrop may reach in a pad on a layer (its inscribed circle). */
function reach(p: PcbPad | PcbVia, layer: LayerId): number {
  if (p.kind === 'via') return p.diameter / 2;
  const s = layer === L.TOP || p.layer === L.TOP ? p.top : layer === L.BOTTOM || p.layer === L.BOTTOM ? p.bot : p.mid;
  return Math.min(s.w, s.h) / 2;
}
const onLayer = (p: PcbPad | PcbVia, layer: LayerId) => p.kind === 'via' || p.layer === L.MULTI || p.layer === layer;

/** Teardrops to add. `selected`: the objects ticked by Create Only On Selected Objects (pads, vias or tracks). */
export function planTeardrops(doc: PcbDocument, o: TeardropOptions, selected: Set<PcbPrim> = new Set()): TeardropPlan {
  const plan: TeardropPlan = { tracks: [], arcs: [], joints: 0, skipped: 0 };
  const holders = doc.prims.filter((p): p is PcbPad | PcbVia => ((p.kind === 'pad' && o.pads) || (p.kind === 'via' && o.vias)) && p.net !== NO_NET);
  const drops = findTeardrops(doc);
  const existing = new Set(drops.map((p) => doc.prims.indexOf(p)));
  const dropEnds = (p: PcbTrack | PcbArc): Vec2[] => (p.kind === 'track' ? [p.a, p.b] : [p.start, p.end].map((a) => ({ x: p.c.x + p.r * Math.cos(a / DEG), y: p.c.y + p.r * Math.sin(a / DEG) })));
  /** A joint that has its teardrops: one from inside the pad back onto the track. */
  const dropped = (h: PcbPad | PcbVia, t: PcbTrack) => drops.some((d) => d.net === t.net && d.layer === t.layer && dropEnds(d).some((e) => Math.hypot(e.x - h.at.x, e.y - h.at.y) <= reach(h, t.layer) + 2)
    && dropEnds(d).some((e) => distToSegment(e, t.a, t.b) < 3 && !same(e, t.a) && !same(e, t.b)));
  for (const t of doc.prims) {
    if (t.kind !== 'track' || t.net === NO_NET || !isSignal(t.layer) || t.polygon !== NO_NET || t.keepout || existing.has(doc.prims.indexOf(t))) continue;
    for (const [end, far] of [[t.a, t.b], [t.b, t.a]] as const) {
      const h = holders.find((p) => p.net === t.net && onLayer(p, t.layer) && same(p.at, end));
      if (!h) continue;
      if (o.selectedOnly && !selected.has(h) && !selected.has(t)) continue;
      if (dropped(h, t)) continue;
      const R = reach(h, t.layer);
      const len = Math.hypot(far.x - end.x, far.y - end.y);
      const q = R - t.width / 2;
      if (q < t.width / 4) continue;
      // Along the track by about the pad's size, kept on it
      const Lt = Math.min(R * 2, len - 1);
      if (Lt <= R * 0.5) continue;
      const d = { x: (far.x - end.x) / len, y: (far.y - end.y) / len }, n = { x: -d.y, y: d.x };
      const T = { x: Math.round(end.x + d.x * Lt), y: Math.round(end.y + d.y * Lt) };
      const tracks: TeardropTrack[] = [], arcs: TeardropArc[] = [];
      for (const s of [1, -1] as const) {
        const Q = { x: Math.round(end.x + n.x * q * s), y: Math.round(end.y + n.y * q * s) };
        if (o.style === 'track') { tracks.push({ layer: t.layer, a: Q, b: T, width: t.width, net: t.net }); continue; }
        // The arc through Q that leaves the track tangent at T: its centre on T's perpendicular, towards Q
        const rho = (Lt * Lt + q * q) / (2 * q);
        const C = { x: T.x + n.x * rho * s, y: T.y + n.y * rho * s };
        const aT = Math.atan2(T.y - C.y, T.x - C.x) * DEG, aQ = Math.atan2(Q.y - C.y, Q.x - C.x) * DEG;
        // The short way round, counter-clockwise from start to end
        let sweep = (((aQ - aT) % 360) + 540) % 360 - 180;
        const [start, end2] = sweep >= 0 ? [aT, aQ] : [aQ, aT];
        sweep = Math.abs(sweep);
        const norm = (a: number) => Math.round((((a % 360) + 360) % 360) * 1000) / 1000;
        arcs.push({ layer: t.layer, c: { x: Math.round(C.x), y: Math.round(C.y) }, r: Math.round(rho), start: norm(start), end: norm(end2), width: t.width, net: t.net });
      }
      if (!o.force) {
        const probe: PcbPrim[] = [
          ...tracks.map((x): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: x.layer, a: x.a, b: x.b, width: x.width, net: x.net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false })),
          ...arcs.map((x): PcbArc => ({ kind: 'arc', src: { storage: 'Arcs6', index: -1 }, layer: x.layer, c: x.c, r: x.r, start: x.start, end: x.end, width: x.width, net: x.net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false })),
        ];
        if (checkCopper(doc, probe, { ignorePours: true, clearanceOnly: true }).length) { plan.skipped++; continue; }
      }
      plan.tracks.push(...tracks); plan.arcs.push(...arcs); plan.joints++;
    }
  }
  return plan;
}

/** Teardrops already on the board (or among `among`): tracks and arcs from inside a pad or via to the middle of a track of the net. */
export function findTeardrops(doc: PcbDocument, among?: Set<PcbPrim>): (PcbTrack | PcbArc)[] {
  const holders = doc.prims.filter((p): p is PcbPad | PcbVia => (p.kind === 'pad' || p.kind === 'via') && p.net !== NO_NET);
  const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net !== NO_NET && p.polygon === NO_NET);
  const ends = (p: PcbTrack | PcbArc): [Vec2, Vec2] => (p.kind === 'track' ? [p.a, p.b] : [p.start, p.end].map((a) => ({ x: p.c.x + p.r * Math.cos(a / DEG), y: p.c.y + p.r * Math.sin(a / DEG) })) as [Vec2, Vec2]);
  // By net (and layer): each end is checked against its own net's copper only
  const holdersOf = new Map<number, (PcbPad | PcbVia)[]>(), tracksOf = new Map<string, PcbTrack[]>();
  for (const h of holders) { const l = holdersOf.get(h.net); if (l) l.push(h); else holdersOf.set(h.net, [h]); }
  for (const t of tracks) { const k = `${t.net}:${t.layer}`, l = tracksOf.get(k); if (l) l.push(t); else tracksOf.set(k, [t]); }
  const inside = (p: Vec2, net: number, layer: LayerId) => (holdersOf.get(net) ?? []).some((h) => onLayer(h, layer) && !same(h.at, p) && Math.hypot(p.x - h.at.x, p.y - h.at.y) <= reach(h, layer) + 2);
  const midTrack = (p: Vec2, self: PcbPrim, net: number, layer: LayerId) => (tracksOf.get(`${net}:${layer}`) ?? []).some((t) => t !== self && !same(t.a, p) && !same(t.b, p) && distToSegment(p, t.a, t.b) < 3);
  return doc.prims.filter((p): p is PcbTrack | PcbArc => {
    if ((p.kind !== 'track' && p.kind !== 'arc') || p.net === NO_NET || p.polygon !== NO_NET || (among && !among.has(p))) return false;
    const [a, b] = ends(p);
    return (inside(a, p.net, p.layer) && midTrack(b, p, p.net, p.layer)) || (inside(b, p.net, p.layer) && midTrack(a, p, p.net, p.layer));
  });
}
