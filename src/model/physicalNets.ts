/**
 * Design › Netlist › Configure Physical Nets (AD17: "Configure Connected Copper Netlists"): the
 * board's copper as it physically joins — each piece of connected copper with the pads on it and
 * the nets its objects carry now — so that each piece can be given one net: the net most of it
 * already has, or a new one named after its first pad (NetU1_2). Pieces with no net or several
 * are the ones to look at [est: AD's dialog].
 */
import type { Change } from '../core/undo';
import { natural } from './compile';
import { connectedCopper } from './drc';
import { NO_NET, type PcbDocument, type PcbPad } from './pcb';
import { addNet, replaceRecords, retarget } from './pcbEdit';

export interface PhysicalNet { prims: number[]; pads: string[]; nets: string[]; suggested: string; conflict: boolean }

export function physicalNets(doc: PcbDocument): PhysicalNet[] {
  const seen = new Set<number>();
  const out: PhysicalNet[] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || seen.has(i)) return;
    const island = [...connectedCopper(doc, i)].filter((k) => { const q = doc.prims[k]; return !!q && !('polygon' in q && q.polygon !== NO_NET); });
    for (const k of island) seen.add(k);
    const pads = island.map((k) => doc.prims[k]!).filter((q): q is PcbPad => q.kind === 'pad');
    const label = (q: PcbPad) => `${q.component !== NO_NET ? doc.components[q.component]?.designator ?? '' : 'Free'}-${q.name}`;
    const count = new Map<string, number>();
    for (const k of island) { const q = doc.prims[k]!; if ('net' in q) { const n = q.net === NO_NET ? '' : doc.nets[q.net]?.name ?? ''; count.set(n, (count.get(n) ?? 0) + 1); } }
    const nets = [...count.keys()].sort(natural);
    const named = [...count].filter(([n]) => n).sort((a, b) => b[1] - a[1]);
    const first = [...pads].sort((a, b) => natural(label(a), label(b)))[0]!;
    const des = first.component !== NO_NET ? doc.components[first.component]?.designator ?? '' : '';
    out.push({ prims: island, pads: pads.map(label).sort(natural), nets, suggested: named[0]?.[0] ?? `Net${des}_${first.name}`, conflict: nets.length !== 1 || nets[0] === '' });
  });
  return out;
}

/** Each piece put on its chosen net (made when new); one undo step. */
export function applyPhysicalNets(doc: PcbDocument, choices: { prims: number[]; net: string }[], add: (c: Change) => void): number {
  let changed = 0;
  for (const ch of choices) {
    const name = ch.net.trim();
    if (!name) continue;
    let index = doc.nets.findIndex((n) => n.name === name);
    if (index < 0) { index = doc.nets.length; add(addNet(doc, name)); }
    const edits = ch.prims.map((k) => doc.prims[k]!).filter((q) => 'net' in q && q.net !== index).flatMap((q) => {
      const r = doc.streams.get(q.src.storage)?.records[q.src.index];
      return r ? [{ storage: q.src.storage, index: q.src.index, after: retarget(r, { net: () => index }) }] : [];
    });
    if (edits.length) { add(replaceRecords(doc, edits)); changed += edits.length; }
  }
  return changed;
}
