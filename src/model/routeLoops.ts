/**
 * Automatically Remove Loops (Preferences › PCB Editor › Interactive Routing): when a new route
 * joins two places its net's tracks already join, the old way between them goes, as AD does when
 * a connection is re-routed. The old way is a chain of tracks from where the route starts to where
 * it ends (a pad or via there, a track end, or a point along a track, which is split there),
 * passing only joints where two tracks meet and nothing else of the net. Locked tracks and tracks
 * of components or pours are never removed.
 */
import { distToSegment, type Vec2 } from '../core/geom';
import { boardIndex, distance } from './drc';
import type { TrackFields } from '../formats/altium/pcbdoc';
import { NO_NET, type PcbDocument, type PcbTrack } from './pcb';
import type { LayerId } from './layers';

const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
const sameTrack = (t: PcbTrack, f: TrackFields) => t.layer === f.layer && t.width === f.width
  && ((near(t.a, f.a) && near(t.b, f.b)) || (near(t.a, f.b) && near(t.b, f.a)));

interface WTrack { a: Vec2; b: Vec2; width: number; layer: LayerId; orig: PcbTrack }

/** What to take away and put back so the loop the route made is gone, or null when there is none. */
export function loopToRemove(doc: PcbDocument, net: number, route: TrackFields[], start: Vec2, end: Vec2): { remove: PcbTrack[]; add: TrackFields[] } | null {
  if (net === NO_NET || !route.length || near(start, end)) return null;
  const startLayer = route[0]!.layer, endLayer = route.at(-1)!.layer;
  let work: WTrack[] = [];
  for (const p of doc.prims) {
    if (p.kind !== 'track' || p.net !== net || p.locked || p.keepout || p.component !== NO_NET || p.polygon !== NO_NET) continue;
    if (route.some((f) => sameTrack(p, f))) continue;
    work.push({ a: p.a, b: p.b, width: p.width, layer: p.layer, orig: p });
  }
  // Pads, vias and arcs of the net: where routes end, and what holds a joint
  const holders = boardIndex(doc).all().filter((s) => s.net === net && doc.prims[s.prim]!.kind !== 'track');
  const holderAt = (p: Vec2, layer: LayerId) => holders.find((s) => s.layer === layer && distance({ t: 'circle', c: p, r: 0 }, s.g) <= 0);
  // A route that starts or ends part-way along a track splits it there
  const split = (p: Vec2, layer: LayerId) => {
    if (holderAt(p, layer)) return;
    const t = work.find((x) => x.layer === layer && !near(x.a, p) && !near(x.b, p) && distToSegment(p, x.a, x.b) <= x.width / 2);
    if (!t) return;
    // The split point on the centre line
    const vx = t.b.x - t.a.x, vy = t.b.y - t.a.y, l2 = vx * vx + vy * vy;
    const k = Math.max(0, Math.min(1, ((p.x - t.a.x) * vx + (p.y - t.a.y) * vy) / l2));
    const q = { x: Math.round(t.a.x + vx * k), y: Math.round(t.a.y + vy * k) };
    work = work.filter((x) => x !== t);
    work.push({ ...t, b: q }, { ...t, a: q });
    return q;
  };
  const s = split(start, startLayer) ?? start, e = split(end, endLayer) ?? end;
  const sHolder = holderAt(start, startLayer), eHolder = holderAt(end, endLayer);
  if (sHolder && eHolder && sHolder.prim === eHolder.prim) return null;
  const atS = (p: Vec2, layer: LayerId) => (sHolder ? sHolder.layer === layer && distance({ t: 'circle', c: p, r: 0 }, sHolder.g) <= 0 : layer === startLayer && near(p, s));
  const atE = (p: Vec2, layer: LayerId) => (eHolder ? eHolder.layer === layer && distance({ t: 'circle', c: p, r: 0 }, eHolder.g) <= 0 : layer === endLayer && near(p, e));
  const ends = (p: Vec2, layer: LayerId) => work.filter((x) => x.layer === layer && (near(x.a, p) || near(x.b, p)));
  let best: WTrack[] | null = null, bestLen = Infinity;
  for (const first of work) {
    for (const [from, to] of [[first.a, first.b], [first.b, first.a]] as [Vec2, Vec2][]) {
      if (!atS(from, first.layer)) continue;
      const chain = [first];
      let cur = first, at = to, len = Math.hypot(to.x - from.x, to.y - from.y);
      for (let n = 0; n < 2000; n++) {
        if (atE(at, cur.layer)) { if (len < bestLen) { best = [...chain]; bestLen = len; } break; }
        // Only through a joint of exactly two tracks and nothing else of the net
        const here = ends(at, cur.layer);
        if (here.length !== 2 || holderAt(at, cur.layer) || atS(at, cur.layer)) break;
        const nx = here.find((x) => x !== cur)!;
        if (chain.includes(nx)) break;
        const far = near(nx.a, at) ? nx.b : nx.a;
        chain.push(nx);
        len += Math.hypot(far.x - at.x, far.y - at.y);
        cur = nx; at = far;
      }
    }
  }
  if (!best) return null;
  const gone = new Set(best);
  const remove = new Set([...gone].map((x) => x.orig));
  // The piece of a split track that stays is put back
  const add = work.filter((x) => !gone.has(x) && remove.has(x.orig)).map((x): TrackFields => ({ layer: x.layer, a: x.a, b: x.b, width: x.width, net }));
  return { remove: [...remove], add };
}

/**
 * Remove Net Antennas (with Automatically Remove Loops): the net's tracks that the old way's
 * removal left with an end meeting nothing of the net (a stub that met it part-way along, and
 * whatever dead-ends behind that stub) go too. Called once the old way is gone: `removed` is what
 * went, `route` the new route and what was put back (never taken). Locked tracks and tracks of
 * components or pours stay, as do tracks still joined at both ends.
 */
export function antennasLeft(doc: PcbDocument, net: number, removed: readonly { a: Vec2; b: Vec2; width: number; layer: LayerId }[], route: readonly TrackFields[] = []): PcbTrack[] {
  if (net === NO_NET || !removed.length) return [];
  const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === net && !p.keepout);
  const editable = (t: PcbTrack) => !t.locked && t.component === NO_NET && t.polygon === NO_NET && !route.some((f) => sameTrack(t, f));
  // Pads, vias, arcs, fills and regions of the net: an end on one of them is joined
  const holders = boardIndex(doc).all().filter((s) => s.net === net && s.role !== 'hole' && s.role !== 'keepout' && doc.prims[s.prim]!.kind !== 'track');
  const gone: { a: Vec2; b: Vec2; width: number; layer: LayerId }[] = [...removed];
  const out = new Set<PcbTrack>();
  const meets = (e: Vec2, t: PcbTrack, o: { a: Vec2; b: Vec2; width: number; layer: LayerId }) => o.layer === t.layer && distToSegment(e, o.a, o.b) <= (o.width + t.width) / 2 + 2;
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tracks) {
      if (out.has(t) || !editable(t)) continue;
      const dead = [t.a, t.b].some((e) => gone.some((g) => meets(e, t, g))
        && !tracks.some((u) => u !== t && !out.has(u) && meets(e, t, u))
        && !holders.some((s) => s.layer === t.layer && distance({ t: 'circle', c: e, r: t.width / 2 }, s.g) <= 0));
      if (!dead) continue;
      out.add(t); gone.push(t); changed = true;
    }
  }
  return [...out];
}
