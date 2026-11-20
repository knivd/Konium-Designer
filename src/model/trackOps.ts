/**
 * Edits on routed copper: Route › Retrace Selected (widths and via sizes back to the rules),
 * Route › Gloss Selected (each run of selected tracks pulled tight round what it passes),
 * Tools › Convert › Convert Selected Tracks to Chamfered Path (a run of tracks becomes one region
 * with its outside corners cut), Design › Netlist › Clean All Nets / Clean Single Nets (copper
 * not joined to any pad of its net loses the net [est]), and moving a run of tracks with its
 * neighbours' corners sliding along them (Edit › Move › Move / Resize Tracks).
 */
import type { Vec2 } from '../core/geom';
import { NO_NET, type PcbDocument, type PcbPrim, type PcbTrack } from './pcb';
import { checkCopper, connectedCopper, ruleFor } from './drc';
import { ruleLength } from '../formats/altium/rules';
import { encodeRegion, encodeTrack, encodeVia } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';
import { addPrimRecords, addTracks, removePrims, replaceRecords, retarget } from './pcbEdit';
import { trackWithEnds } from './pcbTrackEdit';
import { RouteWorld, noPending, pull, simplify, tighten } from './router';
import { offsetPolyline } from './busRoute';
import type { Change } from '../core/undo';

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
const recOf = (doc: PcbDocument, p: PcbPrim): PcbRawRecord | undefined => doc.streams.get(p.src.storage)?.records[p.src.index];
type Edit = { storage: string; index: number; after: PcbRawRecord };
const free = (p: PcbPrim): p is PcbTrack => p.kind === 'track' && p.component === NO_NET && p.polygon === NO_NET && !p.keepout;

/* ── Retrace ── */

/** Selected tracks to their Width rule's preferred width, vias to their Routing Via Style's preferred size; changes that would break clearance are left out. */
export function retrace(doc: PcbDocument, prims: PcbPrim[]): { edits: Edit[]; skipped: number } {
  const edits: Edit[] = [];
  let skipped = 0;
  for (const p of prims) {
    const rec = recOf(doc, p);
    if (!rec || ('locked' in p && p.locked)) continue;
    if (p.kind === 'track' && free(p)) {
      const r = ruleFor(doc, 'Width', p);
      if (!r) continue;
      const w = ruleLength(r, 'PREFEREDWIDTH', '10mil');
      if (w === p.width) continue;
      const t = { ...p, width: w };
      const others = { ...doc, prims: doc.prims.filter((q) => q !== p) };
      if (w > p.width && checkCopper(others, [t], { ignorePours: true, clearanceOnly: true }).length) { skipped++; continue; }
      edits.push({ storage: p.src.storage, index: p.src.index, after: encodeTrack({ layer: p.layer, a: p.a, b: p.b, width: w, net: p.net, component: p.component, polygon: p.polygon, keepout: p.keepout }, rec) });
    } else if (p.kind === 'via') {
      const r = ruleFor(doc, 'RoutingVias', p);
      if (!r) continue;
      const d = ruleLength(r, 'WIDTH', '50mil'), h = ruleLength(r, 'HOLEWIDTH', '28mil');
      if (d === p.diameter && h === p.hole) continue;
      const v = { ...p, diameter: d, hole: h };
      const others = { ...doc, prims: doc.prims.filter((q) => q !== p) };
      if (d > p.diameter && checkCopper(others, [v], { ignorePours: true, clearanceOnly: true }).length) { skipped++; continue; }
      edits.push({ storage: p.src.storage, index: p.src.index, after: encodeVia({ at: p.at, diameter: d, hole: h, net: p.net, layerStart: p.layerStart, layerEnd: p.layerEnd }, rec) });
    }
  }
  return { edits, skipped };
}

/* ── runs of tracks ── */

/** What else touches a point: pads, vias, arcs or tracks of the net other than `except`. */
function heldAt(doc: PcbDocument, at: Vec2, net: number, except: Set<PcbPrim>): boolean {
  return doc.prims.some((p) => !except.has(p) && 'net' in p && p.net === net && (
    ((p.kind === 'pad' || p.kind === 'via') && same(p.at, at)) || (p.kind === 'track' && (same(p.a, at) || same(p.b, at)))
    || (p.kind === 'arc' && [p.start, p.end].some((a) => same({ x: p.c.x + p.r * Math.cos((a * Math.PI) / 180), y: p.c.y + p.r * Math.sin((a * Math.PI) / 180) }, at)))));
}

/** Selected tracks as runs: chains on one layer, one net and width, joined end to end where nothing else meets them. */
export function trackRuns(doc: PcbDocument, tracks: PcbTrack[]): { tracks: PcbTrack[]; pts: Vec2[] }[] {
  const left = new Set(tracks);
  const runs: { tracks: PcbTrack[]; pts: Vec2[] }[] = [];
  const joinsAt = (t: PcbTrack, at: Vec2) => tracks.filter((o) => o !== t && left.has(o) && o.layer === t.layer && o.net === t.net && o.width === t.width && (same(o.a, at) || same(o.b, at)));
  const clean = (t: PcbTrack, at: Vec2, o: PcbTrack) => !heldAt(doc, at, t.net, new Set([t, o]));
  for (const t0 of tracks) {
    if (!left.has(t0)) continue;
    left.delete(t0);
    const run = [t0];
    let pts = [t0.a, t0.b];
    // Grow from both ends
    for (const end of ['b', 'a'] as const) {
      for (;;) {
        const at = end === 'b' ? pts.at(-1)! : pts[0]!;
        const last = end === 'b' ? run.at(-1)! : run[0]!;
        const next = joinsAt(last, at);
        if (next.length !== 1 || !clean(last, at, next[0]!)) break;
        const n = next[0]!;
        left.delete(n);
        const far = same(n.a, at) ? n.b : n.a;
        if (end === 'b') { run.push(n); pts = [...pts, far]; } else { run.unshift(n); pts = [far, ...pts]; }
      }
    }
    runs.push({ tracks: run, pts });
  }
  return runs;
}

/** Gloss Selected: each run pulled tight between its ends, round what it passes at clearance; a run that can't be glossed is kept. */
export function gloss(doc: PcbDocument, tracks: PcbTrack[]): { remove: PcbTrack[]; add: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[]; changed: number } {
  const remove: PcbTrack[] = [], add: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[] = [];
  let changed = 0;
  for (const run of trackRuns(doc, tracks.filter((t) => free(t) && !t.locked))) {
    const t = run.tracks[0]!;
    const w = new RouteWorld(doc, t.layer, { ...noPending(), removed: new Set(run.tracks.map((x) => doc.prims.indexOf(x))) });
    let g = pull(w, t.net, t.width, run.pts, 8);
    g = tighten(w, t.net, t.width, g);
    g = simplify(g);
    const len = (pts: Vec2[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
    if (!w.clear(t.net, t.width, g) || !same(g[0]!, run.pts[0]!) || !same(g.at(-1)!, run.pts.at(-1)!) || len(g) > len(run.pts) - 1 || (g.length === run.pts.length && g.every((p, i) => same(p, run.pts[i]!)))) continue;
    remove.push(...run.tracks);
    for (let i = 1; i < g.length; i++) add.push({ layer: t.layer, a: g[i - 1]!, b: g[i]!, width: t.width, net: t.net });
    changed++;
  }
  return { remove, add, changed };
}

/**
 * A run of tracks as a region: its outline both sides at half the width, the outside of each bend
 * cut back by `chamfer` (a fraction of the width) [est], the ends square.
 */
export function chamferedOutline(pts: Vec2[], width: number, chamfer: number): Vec2[] {
  const h = width / 2;
  const l = offsetPolyline(pts, h), r = offsetPolyline(pts, -h);
  const cut = (side: Vec2[], i: number, outer: boolean): Vec2[] => {
    const p = side[i]!;
    if (!outer || i === 0 || i === side.length - 1) return [p];
    const a = side[i - 1]!, b = side[i + 1]!;
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    const c = Math.min(chamfer * width, la * 0.9, lb * 0.9);
    if (c < 1) return [p];
    return [{ x: Math.round(p.x + ((a.x - p.x) / la) * c), y: Math.round(p.y + ((a.y - p.y) / la) * c) }, { x: Math.round(p.x + ((b.x - p.x) / lb) * c), y: Math.round(p.y + ((b.y - p.y) / lb) * c) }];
  };
  // A left turn has its outside on the right
  const turn = (i: number) => {
    const a = pts[i - 1]!, p = pts[i]!, b = pts[i + 1]!;
    return (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
  };
  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = i > 0 && i < pts.length - 1 ? turn(i) : 0;
    left.push(...cut(l, i, t < 0));
    right.push(...cut(r, i, t > 0));
  }
  return [...left, ...right.reverse()];
}

/** Convert Selected Tracks to Chamfered Path: each run becomes a region of its net on its layer. */
export function chamferedPaths(doc: PcbDocument, tracks: PcbTrack[], chamfer: number): { remove: PcbTrack[]; regions: PcbRawRecord[] } {
  const remove: PcbTrack[] = [], regions: PcbRawRecord[] = [];
  for (const run of trackRuns(doc, tracks.filter(free))) {
    const t = run.tracks[0]!;
    const outline = chamferedOutline(simplify(run.pts), t.width, chamfer);
    regions.push(encodeRegion({ layer: t.layer, outline, net: t.net === NO_NET ? undefined : t.net }));
    remove.push(...run.tracks);
  }
  return { remove, regions };
}

/* ── Clean nets ── */

/** Copper of a net (free tracks, arcs, vias, fills, regions) not joined to any of its pads. */
export function strayCopper(doc: PcbDocument, nets?: Set<number>): PcbPrim[] {
  const joined = new Set<number>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net === NO_NET || (nets && !nets.has(p.net)) || joined.has(i)) return;
    for (const j of connectedCopper(doc, i)) joined.add(j);
  });
  return doc.prims.filter((p, i) => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via' || p.kind === 'fill' || p.kind === 'region')
    && 'net' in p && p.net !== NO_NET && (!nets || nets.has(p.net)) && !joined.has(i)
    && !('polygon' in p && p.polygon !== NO_NET) && !('component' in p && p.component !== NO_NET) && !('keepout' in p && p.keepout));
}

/** The records of stray copper with no net. */
export function cleanNets(doc: PcbDocument, nets?: Set<number>): Edit[] {
  return strayCopper(doc, nets).flatMap((p) => {
    const rec = recOf(doc, p);
    return rec ? [{ storage: p.src.storage, index: p.src.index, after: retarget(rec, { net: () => NO_NET }) }] : [];
  });
}

/* ── Move / Resize Tracks ── */

function meet(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return { x: Math.round(p.x + u.x * t), y: Math.round(p.y + u.y * t) };
}
const dirOf = (t: PcbTrack): Vec2 => { const l = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) || 1; return { x: (t.b.x - t.a.x) / l, y: (t.b.y - t.a.y) / l }; };

/**
 * Tracks moved by `d`: where two moved tracks meet, their new lines meet; a free neighbour's end
 * slides along it to the moved line; an end held by a pad, via or branch gets a track back to
 * where it was. Returns the record edits and the tracks to add.
 */
export function moveTracks(doc: PcbDocument, tracks: PcbTrack[], d: Vec2): { edits: Edit[]; added: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[] } {
  const set = new Set(tracks);
  const moved = new Map<PcbTrack, { a: Vec2; b: Vec2 }>();
  const nbMoves = new Map<PcbTrack, { a: Vec2; b: Vec2 }>();
  const added: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[] = [];
  const shift = (p: Vec2): Vec2 => ({ x: Math.round(p.x + d.x), y: Math.round(p.y + d.y) });
  for (const t of tracks) {
    const u = dirOf(t);
    const endTo = (at: Vec2): Vec2 => {
      const there = doc.prims.filter((p) => p !== t && 'net' in p && p.net === t.net && (('layer' in p && p.layer === t.layer) || p.kind === 'via' || p.kind === 'pad')
        && ((p.kind === 'track' && (same(p.a, at) || same(p.b, at))) || ((p.kind === 'pad' || p.kind === 'via') && same(p.at, at))));
      const mates = there.filter((p): p is PcbTrack => p.kind === 'track' && set.has(p));
      // Both moved lines pass through the shifted joint
      if (mates.length === 1 && there.length === 1) return shift(at);
      const nbs = there.filter((p): p is PcbTrack => p.kind === 'track' && !set.has(p) && free(p) && !p.locked);
      if (there.length === 1 && nbs.length === 1) {
        const nb = nbs[0]!;
        const to = meet(shift(at), u, nb.a, dirOf(nb)) ?? shift(at);
        const cur = nbMoves.get(nb) ?? { a: nb.a, b: nb.b };
        nbMoves.set(nb, same(nb.a, at) ? { ...cur, a: to } : { ...cur, b: to });
        return to;
      }
      if (there.length) added.push({ layer: t.layer, a: at, b: shift(at), width: t.width, net: t.net });
      return shift(at);
    };
    moved.set(t, { a: endTo(t.a), b: endTo(t.b) });
  }
  const edits: Edit[] = [];
  for (const [t, e] of [...moved, ...nbMoves]) { const rec = recOf(doc, t); if (rec) edits.push({ storage: t.src.storage, index: t.src.index, after: trackWithEnds(rec, e.a, e.b) }); }
  return { edits, added };
}

/** A gloss or chamfer result on the board: each change made once the one before is applied. */
export function replaceTracks(doc: PcbDocument, remove: PcbTrack[], add: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[], regions: PcbRawRecord[], put: (c: Change) => void): void {
  put(removePrims(doc, remove));
  if (add.length) put(addTracks(doc, add.map((t) => ({ ...t, net: t.net === NO_NET ? undefined : t.net }))));
  if (regions.length) put(addPrimRecords(doc, regions.map((rec) => ({ storage: 'Regions6', rec }))));
}

export { replaceRecords };
