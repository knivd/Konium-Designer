/**
 * Routing by net and by physical connection: Route › Un-Route (All, Net, Connection,
 * Component), Edit › Select › Physical Connection, Component Connections and Nets, and the
 * View › Connections show / hide sets.
 */
import { connectedCopper } from './drc';
import { NO_NET, type PcbDocument, type PcbPrim } from './pcb';

/** Free routing: tracks, arcs and vias owned by no component and no pour. */
export const isRouting = (p: PcbPrim): boolean =>
  (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via') && !('component' in p && p.component !== NO_NET) && !('polygon' in p && p.polygon !== NO_NET) && !('keepout' in p && p.keepout);

/** Un-Route › All: every routing primitive on a net. */
export const allRouting = (doc: PcbDocument): PcbPrim[] => doc.prims.filter((p) => isRouting(p) && 'net' in p && p.net !== NO_NET);

/** Un-Route › Net: the net's tracks, arcs and vias. */
export const netRouting = (doc: PcbDocument, net: number): PcbPrim[] => doc.prims.filter((p) => isRouting(p) && 'net' in p && p.net === net);

/**
 * The routing physically joined to primitive `start` without passing through a pad (Altium's
 * Physical Connection: from pad to pad). `layer`: on that layer only, no vias.
 */
export function physicalConnection(doc: PcbDocument, start: number, layer?: number): PcbPrim[] {
  const prims = doc.prims;
  const ok = (i: number) => { const p = prims[i]; return !!p && isRouting(p) && (layer === undefined || (p.kind !== 'via' && 'layer' in p && p.layer === layer)); };
  return [...connectedCopper(doc, start, ok)].filter(ok).map((i) => prims[i]!);
}

/** The routing on a component's pads, up to the next pad (Un-Route › Component, Select › Component Connections). */
export function componentRouting(doc: PcbDocument, component: number): PcbPrim[] {
  const out = new Set<PcbPrim>();
  doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.component === component) for (const q of physicalConnection(doc, i)) out.add(q); });
  return [...out];
}

/** The nets a component's pads are on. */
export const componentNets = (doc: PcbDocument, component: number): Set<number> =>
  new Set(doc.prims.filter((p) => p.kind === 'pad' && p.component === component && p.net !== NO_NET).map((p) => (p as { net: number }).net));

/**
 * Design › Netlist › Update Free Primitives From Component Pads: free tracks, arcs, vias, fills
 * and regions joined to a pad take its net (copper reached from two nets is left alone). Returns
 * each primitive to change and its net, and the number left alone.
 */
export function netsFromPads(doc: PcbDocument): { changes: { prim: PcbPrim; net: number }[]; conflicts: number } {
  const free = (p: PcbPrim) => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via' || p.kind === 'fill' || p.kind === 'region')
    && !('component' in p && p.component !== NO_NET) && !('polygon' in p && p.polygon !== NO_NET) && !('keepout' in p && p.keepout);
  const reach = new Map<number, Set<number>>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net === NO_NET) return;
    for (const j of connectedCopper(doc, i, (k) => free(doc.prims[k]!))) if (j !== i && free(doc.prims[j]!)) { const s = reach.get(j) ?? new Set(); s.add(p.net); reach.set(j, s); }
  });
  const changes: { prim: PcbPrim; net: number }[] = [];
  let conflicts = 0;
  for (const [j, nets] of reach) {
    const p = doc.prims[j]!;
    if (nets.size > 1) { conflicts++; continue; }
    const net = [...nets][0]!;
    if ('net' in p && p.net !== net) changes.push({ prim: p, net });
  }
  return { changes, conflicts };
}
