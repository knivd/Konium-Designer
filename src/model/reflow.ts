/**
 * Routes made free-flowing (26.194): Route › Make Free-Flowing for routes that are there, and what
 * the autorouter and the Smart Router do after routing where the style is asked for. Each chain of
 * free tracks between pads, vias and branches is pulled tight at any angle and rested against
 * what it passes, twice over (the second time against its neighbours as they then lie), and then
 * its bends are made arcs (flowStyle.ts). A route keeps its ends, its layer, its width and its
 * clearances, and never gets longer; every other route stands as an obstacle in the shape it has
 * at that moment, so routes side by side do not end up in each other's way.
 *
 * Left as they are: locked tracks, tracks of components, pours' copper, routes of a single
 * straight track, and the nets of differential pairs (reshaped one by one they would lose their
 * gap). A route tuned to a length loses its tuning: that is the designer's to leave
 * unselected.
 */
import type { Vec2 } from '../core/geom';
import { breathe } from '../core/breathe';
import type { TrackFields } from '../formats/altium/pcbdoc';
import { isSignal, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim, type PcbTrack } from './pcb';
import { RouteWorld, lineOf, noPending, pathLength, type RItem, type VTrack } from './router';
import type { ArcOut } from './hugStyle';
import { arcOut, arcPoints, fillet, flowLength, flowPath, taut, type FlowPiece } from './flowStyle';
import type { RouteJob } from './autoroute';
import { diffPairsOf } from './diffPairs';

export interface Reflowed {
  /** The tracks taken away, and what goes in their place. */
  remove: PcbPrim[]; tracks: TrackFields[]; arcs: ArcOut[];
  /** Routes (chains of tracks) reshaped, and those left as they were (straight already, or with no better shape). */
  reshaped: number; kept: number;
  /** The reshaped routes' length before and after, in document units. */
  before: number; after: number;
  stopped: boolean;
}

/** A shaped path as tracks and arcs of one layer, width and net. */
export function flowCopper(pieces: FlowPiece[], layer: LayerId, width: number, net: number | undefined): { tracks: TrackFields[]; arcs: ArcOut[] } {
  const tracks: TrackFields[] = [], arcs: ArcOut[] = [];
  for (const p of pieces) {
    if (p.kind === 'line') tracks.push({ layer, a: p.a, b: p.b, width, net });
    else arcs.push(arcOut(p, layer, width, net));
  }
  return { tracks, arcs };
}
/** The same as obstacles for the other routes: the lines, and each arc as chords. */
function shadow(pieces: FlowPiece[], layer: LayerId, width: number, net: number): VTrack[] {
  const out: VTrack[] = [];
  for (const p of pieces) {
    const pts = p.kind === 'line' ? [p.a, p.b] : arcPoints(p);
    for (let i = 1; i < pts.length; i++) out.push({ layer, a: pts[i - 1]!, b: pts[i]!, width, net });
  }
  return out;
}
const linesOf = (pts: Vec2[]): FlowPiece[] => pts.slice(1).map((b, i) => ({ kind: 'line' as const, a: pts[i]!, b }));
const samePath = (pieces: FlowPiece[], pts: Vec2[]) => pieces.length === pts.length - 1 && pieces.every((p, i) => p.kind === 'line' && Math.abs(p.a.x - pts[i]!.x) < 2 && Math.abs(p.a.y - pts[i]!.y) < 2 && Math.abs(p.b.x - pts[i + 1]!.x) < 2 && Math.abs(p.b.y - pts[i + 1]!.y) < 2);

interface Chain { net: number; width: number; prims: number[]; orig: Vec2[]; pieces: FlowPiece[] }
/** Worlds are built anew every so many routes; in between, what changed since is carried beside them. */
const BATCH = 12;

/**
 * Reshape the routes these tracks belong to (their indices in doc.prims), or every free route on
 * the board's signal layers when none are given.
 */
export async function reflow(doc: PcbDocument, pick?: Set<number>, o: { job?: RouteJob; progress?: (done: number, of: number) => void } = {}): Promise<Reflowed> {
  const out: Reflowed = { remove: [], tracks: [], arcs: [], reshaped: 0, kept: 0, before: 0, after: 0, stopped: false };
  const paired = new Set<number>();
  for (const d of diffPairsOf(doc)) for (const name of [d.pos, d.neg]) { const i = doc.nets.findIndex((n) => n.name.toLowerCase() === name.toLowerCase()); if (i >= 0) paired.add(i); }
  for (const layer of doc.board.copperStack.filter(isSignal)) {
    // The layer's routes, from the board as it is
    const base = new RouteWorld(doc, layer);
    const chains: Chain[] = [], seen = new Set<number>();
    for (const it of base.items) {
      if (it.kind !== 'track' || !it.movable || it.prim < 0 || it.net === NO_NET || seen.has(it.prim) || paired.has(it.net)) continue;
      const line = lineOf(base, it);
      for (const x of line.items) seen.add(x.prim);
      if (line.pts.length < 3 || (pick && !line.items.some((x) => pick.has(x.prim)))) continue;
      chains.push({ net: line.net, width: line.width, prims: line.items.map((x) => x.prim), orig: line.pts, pieces: linesOf(line.pts) });
    }
    if (!chains.length) continue;
    const removed = new Set(chains.flatMap((c) => c.prims));
    // The world with every chain in the shape it has now; ids[k]: chain k's items in it
    let w = base, ids: Set<number>[] = [], stale = new Set<number>(), extra: RItem[] = [], since = BATCH;
    const rebuild = () => {
      const counts: number[] = [], flat: VTrack[] = [];
      for (const c of chains) { const s = shadow(c.pieces, layer, c.width, c.net); counts.push(s.length); flat.push(...s); }
      w = new RouteWorld(doc, layer, { ...noPending(), removed }, { tracks: flat });
      const routes = w.items.filter((it) => it.kind === 'route');
      ids = []; let at = 0;
      for (const n of counts) { ids.push(new Set(routes.slice(at, at + n).map((it) => it.id))); at += n; }
      stale = new Set(); extra = []; since = 0;
    };
    /** Chain k given a new shape: its old one no longer counts, the new one does. */
    const update = (k: number, pieces: FlowPiece[]) => {
      const c = chains[k]!;
      c.pieces = pieces;
      for (const id of ids[k] ?? []) stale.add(id);
      const own = new Set<number>();
      for (const t of shadow(pieces, layer, c.width, c.net)) { const it = w.virtual(t); own.add(it.id); extra.push(it); }
      ids[k] = own;
      since++;
    };
    const lookFor = (k: number) => { const own = ids[k] ?? new Set<number>(); return { skip: (it: RItem) => stale.has(it.id) || own.has(it.id), extra: extra.filter((it) => !own.has(it.id) && !stale.has(it.id)) }; };
    const step = async (k: number, shape: (c: Chain, look: ReturnType<typeof lookFor>) => FlowPiece[]): Promise<boolean> => {
      if (since >= BATCH) rebuild();
      await breathe();
      if (o.job?.cancelled) { out.stopped = true; return false; }
      const c = chains[k]!;
      const pieces = shape(c, lookFor(k));
      if (pieces.length && flowLength(pieces) <= flowLength(c.pieces) + 2) update(k, pieces);
      return true;
    };
    // Twice pulled tight (the second time against the neighbours as they then lie), then the bends made arcs
    const corners = (c: Chain) => [c.pieces[0]!.a, ...c.pieces.map((p) => p.b)];
    let done = 0;
    const total = chains.length * 3;
    run: {
      for (let pass = 0; pass < 2; pass++) for (let k = 0; k < chains.length; k++) {
        if (!(await step(k, (c, look) => linesOf(taut(w, c.net, c.width, corners(c), look))))) break run;
        o.progress?.(++done, total);
      }
      for (let k = 0; k < chains.length; k++) {
        if (!(await step(k, (c, look) => fillet(w, c.net, c.width, corners(c), look)))) break run;
        o.progress?.(++done, total);
      }
    }
    for (const c of chains) {
      const was = pathLength(c.orig), now = flowLength(c.pieces);
      if (samePath(c.pieces, c.orig) || now > was + 2) { out.kept++; continue; }
      const made = flowCopper(c.pieces, layer, c.width, c.net);
      out.tracks.push(...made.tracks); out.arcs.push(...made.arcs);
      for (const i of c.prims) out.remove.push(doc.prims[i]!);
      out.reshaped++; out.before += was; out.after += now;
    }
    if (out.stopped) break;
  }
  return out;
}

/**
 * A route just laid by hand (its segments in order), made free-flowing run by run, as the Hugging
 * Style's corners are: each run of joined segments of one layer and width pulled tight with its
 * bends made arcs. `worldOf` gives a layer's obstacles.
 */
export function flowSegments(segs: TrackFields[], worldOf: (l: LayerId) => RouteWorld | null): { tracks: TrackFields[]; arcs: ArcOut[] } {
  const tracks: TrackFields[] = [], arcs: ArcOut[] = [];
  const joined = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
  let i = 0;
  while (i < segs.length) {
    let j = i;
    while (j + 1 < segs.length && segs[j + 1]!.layer === segs[i]!.layer && segs[j + 1]!.width === segs[i]!.width && joined(segs[j + 1]!.a, segs[j]!.b)) j++;
    const run = segs.slice(i, j + 1), w = run.length > 1 ? worldOf(run[0]!.layer) : null;
    const pieces = w ? flowPath(w, run[0]!.net ?? NO_NET, run[0]!.width, [run[0]!.a, ...run.map((s) => s.b)]) : [];
    if (pieces.length) { const made = flowCopper(pieces, run[0]!.layer, run[0]!.width, run[0]!.net); tracks.push(...made.tracks); arcs.push(...made.arcs); } else tracks.push(...run);
    i = j + 1;
  }
  return { tracks, arcs };
}

/** A track's place as a key (its layer and ends): how the tracks a run has added are found again on the board. */
export const trackKey = (t: { layer: LayerId; a: Vec2; b: Vec2 }) => `${t.layer}:${Math.round(t.a.x)},${Math.round(t.a.y)}:${Math.round(t.b.x)},${Math.round(t.b.y)}`;
/** The free tracks on the board with these keys, by their indices. */
export function tracksByKey(doc: PcbDocument, keys: Set<string>): Set<number> {
  const pick = new Set<number>();
  doc.prims.forEach((p, i) => { if (p.kind === 'track' && (p as PcbTrack).polygon === NO_NET && p.component === NO_NET && keys.has(trackKey(p))) pick.add(i); });
  return pick;
}
