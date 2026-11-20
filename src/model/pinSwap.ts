/**
 * Tools › Pin/Part Swapping. A pad's swap groups are kept in its second string subrecord as
 * "<pin group>|&|<part group>" [est: AD17 writes "|&|0" for a pad with none]; a component takes
 * part in swapping when its Components6 record has ENABLEPINSWAPPING / ENABLEPARTSWAPPING [est].
 * Swapping exchanges the nets of pads (routing on them is left as it is); the Automatic Net/Pin
 * Optimiser swaps pads of a group while that shortens the connections.
 */
import type { Vec2 } from '../core/geom';
import { NO_NET, type PcbDocument, type PcbPad } from './pcb';
import type { PcbRawRecord } from '../formats/altium/framing';
import { retarget } from './pcbEdit';
import { pairOfNet } from './diffPairs';

export interface SwapInfo { pin: string; part: string }
const SEP = '|&|';

const recOf = (doc: PcbDocument, p: PcbPad): PcbRawRecord | undefined => doc.streams.get(p.src.storage)?.records[p.src.index];
const pascal = (b: Uint8Array | undefined): string => (b && b.length ? String.fromCharCode(...b.slice(1, 1 + b[0]!)) : '');
const toPascal = (s: string): Uint8Array => { const b = new Uint8Array(Math.min(255, s.length) + 1); b[0] = b.length - 1; for (let i = 1; i < b.length; i++) b[i] = s.charCodeAt(i - 1) & 0xff; return b; };

export function swapInfo(doc: PcbDocument, p: PcbPad): SwapInfo {
  const s = pascal(recOf(doc, p)?.subs[2]);
  const [pin = '', part = ''] = s.split(SEP);
  return { pin, part: part === '0' ? '' : part };
}
export function withSwapInfo(rec: PcbRawRecord, info: SwapInfo): PcbRawRecord {
  const subs = rec.subs.map((x) => x.slice()) as Uint8Array[];
  while (subs.length < 3) subs.push(new Uint8Array([0]));
  subs[2] = toPascal(`${info.pin}${SEP}${info.part || '0'}`);
  return { tag: rec.tag, subs };
}

export const pinSwapOn = (doc: PcbDocument, comp: number) => doc.components[comp]?.bag.bool('ENABLEPINSWAPPING') ?? false;
export const partSwapOn = (doc: PcbDocument, comp: number) => doc.components[comp]?.bag.bool('ENABLEPARTSWAPPING') ?? false;

export const padsOf = (doc: PcbDocument, comp: number) => doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === comp);

/** Whether two pads may swap nets: one component with pin swapping on, the same pin group. */
export function canSwapPins(doc: PcbDocument, a: PcbPad, b: PcbPad): string | null {
  if (a === b) return 'pick another pad';
  if (a.component === NO_NET || a.component !== b.component) return 'the pads must be of one component';
  if (!pinSwapOn(doc, a.component)) return `pin swapping is off for ${doc.components[a.component]?.designator}`;
  const ga = swapInfo(doc, a).pin, gb = swapInfo(doc, b).pin;
  if (!ga || ga !== gb) return 'the pads are not in one pin swap group';
  return null;
}

/** Record edits that put each pad on a new net. */
export function setPadNets(doc: PcbDocument, moves: { pad: PcbPad; net: number }[]): { storage: string; index: number; after: PcbRawRecord }[] {
  return moves.flatMap(({ pad, net }) => { const r = recOf(doc, pad); return r ? [{ storage: pad.src.storage, index: pad.src.index, after: retarget(r, { net: () => net }) }] : []; });
}

/** Interactive Part Swapping: the pads of a's part and b's part exchange nets, matched by pin group. */
export function partSwap(doc: PcbDocument, a: PcbPad, b: PcbPad): { moves: { pad: PcbPad; net: number }[]; why?: string } {
  if (a.component === NO_NET || a.component !== b.component) return { moves: [], why: 'the pads must be of one component' };
  if (!partSwapOn(doc, a.component)) return { moves: [], why: `part swapping is off for ${doc.components[a.component]?.designator}` };
  const pa = swapInfo(doc, a).part, pb = swapInfo(doc, b).part;
  if (!pa || !pb || pa === pb) return { moves: [], why: 'pick pads of two parts' };
  const pads = padsOf(doc, a.component);
  const of = (part: string) => pads.filter((p) => swapInfo(doc, p).part === part);
  const A = of(pa), B = of(pb);
  const moves: { pad: PcbPad; net: number }[] = [];
  for (const x of A) {
    const g = swapInfo(doc, x).pin;
    const y = B.find((q) => swapInfo(doc, q).pin === g && !moves.some((m) => m.pad === q));
    if (!y) return { moves: [], why: `${x.name} has no match in the other part` };
    moves.push({ pad: x, net: y.net }, { pad: y, net: x.net });
  }
  return { moves };
}

/** Interactive Differential-Pair Swapping: two pairs on one component's pads exchange places. */
export function pairSwap(doc: PcbDocument, a: PcbPad, b: PcbPad): { moves: { pad: PcbPad; net: number }[]; why?: string } {
  const A = pairOfNet(doc, a.net), B = pairOfNet(doc, b.net);
  if (!A || !B) return { moves: [], why: 'both pads must be of differential pairs' };
  if (A.pair.name === B.pair.name) return { moves: [], why: 'pick a pad of another pair' };
  if (a.component === NO_NET || a.component !== b.component) return { moves: [], why: 'the pads must be of one component' };
  const pads = padsOf(doc, a.component);
  const pad = (net: number) => pads.find((p) => p.net === net);
  const net = (name: string) => doc.nets.findIndex((n) => n.name.toLowerCase() === name.toLowerCase());
  const [ap, an, bp, bn] = [net(A.pair.pos), net(A.pair.neg), net(B.pair.pos), net(B.pair.neg)];
  const [Pap, Pan, Pbp, Pbn] = [pad(ap), pad(an), pad(bp), pad(bn)];
  if (!Pap || !Pan || !Pbp || !Pbn) return { moves: [], why: 'both nets of each pair must be on the component' };
  return { moves: [{ pad: Pap, net: bp }, { pad: Pbp, net: ap }, { pad: Pan, net: bn }, { pad: Pbn, net: an }] };
}

/** How far a pad is from the nearest other pad of its net (its connection's length, roughly). */
function reach(at: Vec2, net: number, except: PcbPad, pads: PcbPad[]): number {
  if (net === NO_NET) return 0;
  let best = Infinity;
  for (const p of pads) if (p !== except && p.net === net) best = Math.min(best, Math.hypot(p.at.x - at.x, p.at.y - at.y));
  return Number.isFinite(best) ? best : 0;
}

/** The Automatic Net/Pin Optimiser: swaps in pin groups that shorten connections, a few passes. */
export function optimisePins(doc: PcbDocument, passes = 4, only?: Set<number>): { moves: { pad: PcbPad; net: number }[]; gain: number } {
  const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad');
  const net = new Map<PcbPad, number>(pads.map((p) => [p, p.net]));
  const view = () => pads.map((p) => ({ ...p, net: net.get(p)! }));
  let gain = 0;
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    const cur = view();
    const byPad = new Map(pads.map((p, i) => [p, cur[i]!]));
    for (const c of new Set(pads.map((p) => p.component))) {
      if (c === NO_NET || !pinSwapOn(doc, c) || (only && !only.has(c))) continue;
      const mine = pads.filter((p) => p.component === c && swapInfo(doc, p).pin);
      for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]!, b = mine[j]!;
        if (swapInfo(doc, a).pin !== swapInfo(doc, b).pin) continue;
        const na = net.get(a)!, nb = net.get(b)!;
        if (na === nb) continue;
        const all = [...byPad.values()];
        const before = reach(a.at, na, byPad.get(a)!, all) + reach(b.at, nb, byPad.get(b)!, all);
        const after = reach(a.at, nb, byPad.get(a)!, all.filter((p) => p !== byPad.get(b))) + reach(b.at, na, byPad.get(b)!, all.filter((p) => p !== byPad.get(a)));
        if (after < before - 1) {
          net.set(a, nb); net.set(b, na);
          byPad.set(a, { ...byPad.get(a)!, net: nb }); byPad.set(b, { ...byPad.get(b)!, net: na });
          gain += before - after; improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { moves: pads.filter((p) => net.get(p) !== p.net).map((p) => ({ pad: p, net: net.get(p)! })), gain };
}
