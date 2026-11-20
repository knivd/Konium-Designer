/**
 * Putting length tuning on the board: the pattern and target from the settings (the Interactive
 * Length Tuning dialog), the changes that replace tracks by their tuned pieces, and Tools ›
 * Equalise Net Lengths (every net of each Matched Lengths rule tuned up to its longest).
 */
import { addPrimRecords, freshRecord, removePrims } from './pcbEdit';
import { freshUnionName, nextUnion, setUnionMeta } from './unions';
import { withRecordUnion } from '../formats/altium/unions';
import type { PcbRawRecord } from '../formats/altium/framing';
import { encodeArc, encodeTrack } from '../formats/altium/pcbdoc';
import { NO_NET, type PcbDocument, type PcbTrack } from './pcb';
import { settings } from '../core/settings';
import { RouteWorld, noPending } from './router';
import { accordion, arcAngles, matchedNets, matchedRules, netLength, ruleTarget, type Piece, type TunePattern } from './lengthTune';
import { ruleLength } from '../formats/altium/rules';
import type { Change } from '../core/undo';

const mil = (n: number) => Math.round(n * 10_000);

/** The board's tuning pattern from the settings (Tab dialog), in board units. */
export function tunePattern(): TunePattern {
  return { style: settings.pcbTuneStyle, amplitude: mil(settings.pcbTuneAmplitude), space: mil(settings.pcbTuneSpace), miter: settings.pcbTuneMiter };
}

/** The target length for a net (or pair): typed, another net's, or from the rules. */
export function tuneTarget(doc: PcbDocument, net: number): { target: number; why: string } | null {
  if (settings.pcbTuneTarget === 'manual') return { target: mil(settings.pcbTuneManual), why: 'Manual' };
  if (settings.pcbTuneTarget === 'net') {
    const n = doc.nets.findIndex((x) => x.name === settings.pcbTuneFromNet);
    return n >= 0 ? { target: netLength(doc, n), why: `net ${settings.pcbTuneFromNet}` } : null;
  }
  return ruleTarget(doc, net) ?? { target: mil(settings.pcbTuneManual), why: 'Manual (no Length or Matched Lengths rule)' };
}

/** A lane of the tuning: the track it replaces and its pieces. */
export interface Lane { track: PcbTrack; pieces: Piece[] }

/**
 * Put tuned pieces on the board in place of their tracks, as one union named "Interactive Length
 * Tunings" as AD17 names them (a plain union: AD's own tunings also carry a SmartUnions record
 * that rebuilds them, which Konium doesn't write [est]). Each change is made once the one
 * before is applied (stream lists are replaced as they go).
 */
export function tuneChanges(doc: PcbDocument, lanes: Lane[], add: (c: Change) => void): void {
  const u = nextUnion(doc), name = freshUnionName(doc, 'Interactive Length Tunings');
  const recs: { storage: string; rec: PcbRawRecord }[] = [];
  const inUnion = (storage: string, r: PcbRawRecord) => withRecordUnion(storage, r, u) ?? r;
  for (const { track: t, pieces } of lanes) {
    const net = t.net === NO_NET ? undefined : t.net;
    for (const p of pieces) {
      if (p.t === 'line') {
        if (p.a.x !== p.b.x || p.a.y !== p.b.y) recs.push({ storage: 'Tracks6', rec: inUnion('Tracks6', freshRecord(doc, 'Tracks6', (tpl) => encodeTrack({ layer: t.layer, a: p.a, b: p.b, width: t.width, net }, tpl))) });
        continue;
      }
      const { start, end } = arcAngles(p);
      recs.push({ storage: 'Arcs6', rec: inUnion('Arcs6', freshRecord(doc, 'Arcs6', (tpl) => encodeArc({ layer: t.layer, c: p.c, r: p.r, start, end, width: t.width, net }, tpl))) });
    }
  }
  add(removePrims(doc, lanes.map((l) => l.track)));
  if (recs.length) add(addPrimRecords(doc, recs));
  add(setUnionMeta(doc, [...(doc.unionNames ?? []), { index: u, name }], [...(doc.smartUnions ?? [])]));
}

export interface EqualiseReport { nets: { name: string; before: number; after: number; target: number }[]; short: number }

/**
 * Tools › Equalise Net Lengths: in each Matched Lengths rule, nets shorter than the longest by
 * more than the tolerance get accordions on their longest tracks (either side, the pattern of
 * the tuning dialog) until they reach it or run out of room. `apply` puts each change on the board
 * at once, so the next track sees the bumps already placed. `only`: just these nets (the longest
 * of each rule's nets is still the target).
 */
export function equaliseNetLengths(doc: PcbDocument, apply: (c: Change) => void, pat: TunePattern = tunePattern(), only?: Set<number>): EqualiseReport {
  const report: EqualiseReport = { nets: [], short: 0 };
  for (const rule of matchedRules(doc)) {
    const nets = matchedNets(doc, rule);
    if (nets.length < 2) continue;
    const tol = ruleLength(rule, 'TOLERANCE', '1000mil');
    const target = Math.max(...nets.map((n) => netLength(doc, n)));
    for (const net of nets) {
      // ActiveRoute's meander: only the nets it has just routed
      if (only && !only.has(net)) continue;
      const before = netLength(doc, net);
      if (target - before <= tol) continue;
      let now = before;
      const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === net && p.polygon === NO_NET && !p.keepout && p.component === NO_NET)
        .sort((a, b) => Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) - Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y));
      for (const t0 of tracks) {
        if (target - now <= 1) break;
        // The track as it is on the board now (earlier changes rebuilt the list)
        const t = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net === net && p.layer === t0.layer && p.a.x === t0.a.x && p.a.y === t0.a.y && p.b.x === t0.b.x && p.b.y === t0.b.y);
        if (!t) continue;
        const len = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
        const pitch = pat.space + t.width;
        if (len < pitch * 3) continue;
        const world = new RouteWorld(doc, t.layer, { ...noPending(), removed: new Set([doc.prims.indexOf(t)]) });
        const clear = (pts: { x: number; y: number }[]) => world.clear(net, t.width, pts);
        let best: ReturnType<typeof accordion> | null = null;
        for (const side of [1, -1] as const) {
          const r = accordion(t.a, t.b, pitch, len - pitch, side, target - now, pat, pitch, Math.max(t.width, mil(2)), clear);
          if (!best || r.added > best.added) best = r;
        }
        if (!best?.bumps) continue;
        tuneChanges(doc, [{ track: t, pieces: best.pieces }], apply);
        now += best.added;
      }
      const after = netLength(doc, net);
      report.nets.push({ name: doc.nets[net]?.name ?? '', before, after, target });
      if (target - after > tol) report.short++;
    }
  }
  return report;
}
