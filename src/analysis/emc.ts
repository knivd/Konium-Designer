/**
 * An EMC check of the board's layout: the places where a signal's return current has no easy way
 * back. Nothing is simulated; each rule is geometry, and each finding a place to look at.
 *
 * - A track over a gap in the copper under it (a slot, a split, the plane's edge): the return
 *   current, which runs in the nearest copper beneath a track, must go round the gap, and the
 *   loop it makes radiates. What counts is how long the gap is, not how wide: a narrow slot is as
 *   bad as a wide one, a via's own clearance hole is not.
 * - A track that passes from over one net's copper to over another's.
 * - A track that runs along the very edge of the copper under it.
 * - A via that takes a signal between layers whose reference copper differs, with no via of the
 *   reference net close by (the same net on two layers), or no capacitor close by (two nets).
 * - An IC's supply pin with no capacitor to ground close by.
 * - Ground copper on a signal layer far from any via to the rest of the ground: beyond a
 *   twentieth of a wavelength at the highest frequency of concern it is an aerial, not a shield.
 */

import type { BBox, Vec2 } from '../core/geom';
import { mil, UNITS_PER_MM } from '../core/units';
import { NO_NET, copperNet, inPour, type PcbDocument } from '../model/pcb';
import { L, isSignal, type LayerId } from '../model/layers';
import { planeCopper } from '../model/planes';
import { readStack } from '../model/pcbStack';
import { METRE, stackCopper } from './copperNet';
import { Raster, chords } from './raster';
import { groundName } from './rail';

export interface EmcSetup {
  /** The nets to check, by name (`*` for any run of characters); none given: every net that is neither a supply nor a ground. */
  nets: string[];
  /** Tracks over gaps: a gap counts from this length (board units). */
  gaps: boolean; minGap: number;
  /** Tracks along the edge of their reference: within this many times the height above it, for at least this length. */
  edge: boolean; edgeFactor: number; minEdgeRun: number;
  /** Layer changes: a via of the reference net within this distance, or a capacitor between the two reference nets within that. */
  layerChange: boolean; returnVia: number; capDistance: number;
  /** Decoupling: a capacitor to ground within this distance of each IC supply pin. */
  decoupling: boolean; decouplingDistance: number;
  /** Stitching: ground copper within a twentieth of a wavelength of a via, at this frequency (Hz). */
  stitching: boolean; frequency: number;
}
export const DEFAULT_EMC: EmcSetup = {
  nets: [], gaps: true, minGap: mil(100), edge: true, edgeFactor: 3, minEdgeRun: mil(200),
  layerChange: true, returnVia: mil(120), capDistance: mil(200), decoupling: true, decouplingDistance: mil(200), stitching: true, frequency: 1e9,
};

export type EmcKind = 'gap' | 'split' | 'edge' | 'layerChange' | 'decoupling' | 'stitching' | 'noReference';
export interface EmcFinding {
  kind: EmcKind; message: string;
  net?: number; layer?: LayerId; box?: BBox; prims?: number[];
  /** How bad, for putting the worst first within a kind (a length, in board units). */
  size: number;
}
export interface EmcResult {
  findings: EmcFinding[];
  /** What was looked at. */
  nets: number; tracks: number; vias: number; ics: number;
  /** A twentieth of a wavelength in the board at the frequency given (board units), and the dielectric constant it was taken with. */
  lambda20: number; er: number;
}

export const EMC_KINDS: { kind: EmcKind; title: string }[] = [
  { kind: 'gap', title: 'Tracks over a gap in the copper under them' },
  { kind: 'split', title: 'Tracks crossing from one net\'s copper to another\'s' },
  { kind: 'edge', title: 'Tracks along the edge of the copper under them' },
  { kind: 'layerChange', title: 'Layer changes with no return path close by' },
  { kind: 'decoupling', title: 'Supply pins with no capacitor close by' },
  { kind: 'stitching', title: 'Ground copper far from a via' },
  { kind: 'noReference', title: 'Layers with no copper under their tracks' },
];

const mmOf = (u: number): string => `${(u / UNITS_PER_MM).toFixed(u / UNITS_PER_MM >= 10 ? 0 : 1)} mm`;
/** A supply by its name (a ground is told by rail.ts's groundName). */
export const supplyName = (name: string): boolean => /^(\+|-)?\d+(\.\d+)?V\d*|^\+|^V(CC|DD|EE|SS|BAT|BUS|IN|OUT|REF|PP|DDA|DDIO|CORE|SYS|M)\w*$|^[AD]?V(CC|DD)\w*$|^(VIN|VOUT|VBAT|VBUS|PWR|POWER)\w*$/i.test(name);

/** Clusters of points (each with a weight and what it belongs to) that lie within `reach` of one another. */
function clusters<T extends { x: number; y: number }>(pts: T[], reach: number): T[][] {
  const cell = (v: number) => Math.floor(v / reach), grid = new Map<string, number[]>(), up = pts.map((_, i) => i);
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  pts.forEach((p, i) => { const k = `${cell(p.x)},${cell(p.y)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  pts.forEach((p, i) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${cell(p.x) + dx},${cell(p.y) + dy}`) ?? []) {
      if (j <= i || Math.hypot(pts[j]!.x - p.x, pts[j]!.y - p.y) > reach) continue;
      const a = find(i), b = find(j);
      if (a !== b) up[a] = b;
    }
  });
  const by = new Map<number, T[]>();
  pts.forEach((p, i) => { const r = find(i); (by.get(r) ?? by.set(r, []).get(r)!).push(p); });
  return [...by.values()];
}
const boxOf = (pts: { x: number; y: number }[], pad: number): BBox => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
};

/** The EMC check of a board. */
export function emcCheck(doc: PcbDocument, setup: EmcSetup = DEFAULT_EMC, layerName: (l: LayerId) => string = (l) => `layer ${l}`): EmcResult {
  const layers = doc.board.copperStack, nL = layers.length, stack = stackCopper(doc), findings: EmcFinding[] = [];
  const netName = (n: number) => (n === NO_NET ? 'copper of no net' : doc.nets[n]?.name ?? `Net ${n}`);
  // The dielectric constant: the first dielectric of the stack that gives one
  const rows = doc.board.bag ? readStack(doc.board.bag, layers) : [], er = rows.find((r) => r.kind === 'dielectric' && r.dielConst > 1)?.dielConst ?? 4.3;
  const lambda20 = 299_792_458 / (Math.max(setup.frequency, 1e6) * Math.sqrt(er)) / 20 / METRE;
  // The board's box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (p: Vec2) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (const p of doc.board.outline) see(p);
  for (const p of doc.prims) { if (p.kind === 'track') { see(p.a); see(p.b); } else if (p.kind === 'pad' || p.kind === 'via') see(p.at); }
  const empty: EmcResult = { findings, nets: 0, tracks: 0, vias: 0, ics: 0, lambda20, er };
  if (!(maxX > minX) || !(maxY > minY) || !nL) return empty;
  const g = Math.min(mil(20), Math.max(mil(4), Math.sqrt(((maxX - minX) * (maxY - minY)) / 250_000)));
  minX -= 2 * g; minY -= 2 * g;
  const W = Math.ceil((maxX + 2 * g - minX) / g), H = Math.ceil((maxY + 2 * g - minY) / g);
  const cx = (x: number) => Math.floor((x - minX) / g), cy = (y: number) => Math.floor((y - minY) / g);
  // Each layer's copper areas (planes; pours, regions and fills), by net: 0 none, else the net + 1
  const ras = new Raster(minX, minY, g, W, H), area: Int32Array[] = [];
  const shelved = new Set(doc.polygons.filter((q) => q.bag.bool('SHELVED')).map((q) => q.index));
  const reference = new Set<number>(), layersOf = new Map<number, Set<number>>();
  for (let li = 0; li < nL; li++) {
    const layer = layers[li]!, a = new Int32Array(W * H), paint = (rings: Vec2[][], net: number) => { ras.spans(rings, (r, from, to) => a.fill(net + 1, r * W + from, r * W + to + 1)); if (net !== NO_NET) { reference.add(net); (layersOf.get(net) ?? layersOf.set(net, new Set()).get(net)!).add(li); } };
    if (!isSignal(layer)) { for (const pl of planeCopper(doc, layer)) for (const r of pl.regions) paint([r.outline, ...r.holes], pl.net < 0 ? NO_NET : pl.net); }
    else for (const p of doc.prims) {
      if (p.kind === 'region') { if (p.layer === layer && !p.keepout && !p.boardCutout && p.regionKind === 0 && p.outline.length >= 3 && !(inPour(p) && shelved.has(p.polygon))) paint([p.outline, ...p.holes], copperNet(doc, p)); }
      else if (p.kind === 'fill' && p.layer === layer && !p.keepout && p.rotation % 180 === 0) paint([[{ x: p.a.x, y: p.a.y }, { x: p.b.x, y: p.a.y }, { x: p.b.x, y: p.b.y }, { x: p.a.x, y: p.b.y }]], p.net);
    }
    area.push(a);
  }
  // The gaps in each layer's copper, each with how long it is (the longer side of its box; the open space off the copper's edge is one gap, the longest)
  const voidOf: Int32Array[] = [], voidSize: number[][] = [];
  for (let li = 0; li < nL; li++) {
    const a = area[li]!, lab = new Int32Array(W * H).fill(-1), sizes: number[] = [], todo: number[] = [];
    for (let c = 0; c < W * H; c++) {
      if (a[c] || lab[c]! >= 0) continue;
      const id = sizes.length;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, edge = false;
      lab[c] = id; todo.push(c);
      while (todo.length) {
        const q = todo.pop()!, x = q % W, y = (q / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && !a[q - 1] && lab[q - 1]! < 0) { lab[q - 1] = id; todo.push(q - 1); }
        if (x < W - 1 && !a[q + 1] && lab[q + 1]! < 0) { lab[q + 1] = id; todo.push(q + 1); }
        if (y > 0 && !a[q - W] && lab[q - W]! < 0) { lab[q - W] = id; todo.push(q - W); }
        if (y < H - 1 && !a[q + W] && lab[q + W]! < 0) { lab[q + W] = id; todo.push(q + W); }
      }
      sizes.push(edge ? Infinity : Math.max(x1 - x0 + 1, y1 - y0 + 1) * g);
    }
    voidOf.push(lab); voidSize.push(sizes);
  }
  // The nets to check
  const wanted = setup.nets.map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
  const isReference = (n: number) => reference.has(n) || groundName(doc.nets[n]?.name ?? '') || supplyName(doc.nets[n]?.name ?? '');
  const checked = (n: number) => n !== NO_NET && !!doc.nets[n] && (wanted.length ? wanted.some((w) => w.test(doc.nets[n]!.name)) : !isReference(n));
  const netsChecked = new Set<number>();
  // What lies under a place on a layer: the copper of the layer above and of the layer below (0 none), or of whichever there are
  const under = (li: number, x: number, y: number): [number, number] => {
    const X = cx(x), Y = cy(y);
    if (X < 0 || Y < 0 || X >= W || Y >= H) return [0, 0];
    return [li > 0 ? area[li - 1]![Y * W + X]! : 0, li < nL - 1 ? area[li + 1]![Y * W + X]! : 0];
  };
  /** The gap under an unreferenced place: the shorter of the gaps in the layers either side (its length, and which gap it is). */
  const gapAt = (li: number, x: number, y: number): { size: number; gap: string } => {
    const X = cx(x), Y = cy(y);
    let size = Infinity, gap = '';
    if (X < 0 || Y < 0 || X >= W || Y >= H) return { size, gap };
    for (const lj of [li - 1, li + 1]) if (lj >= 0 && lj < nL) { const id = voidOf[lj]![Y * W + X]!; if (id >= 0 && voidSize[lj]![id]! < size) { size = voidSize[lj]![id]!; gap = `${lj}:${id}`; } }
    return { size, gap };
  };

  // ── Tracks: gaps, splits and edges ────────────────────────────────────────────────────
  type Sample = { x: number; y: number; prim: number; net: number; size: number; gap?: string; from?: number; to?: number };
  let tracks = 0;
  for (let li = 0; li < nL; li++) {
    const layer = layers[li]!;
    if (!isSignal(layer) || nL < 2) continue;
    const gaps: Sample[] = [], splits: Sample[] = [], edges: Sample[] = [];
    let length = 0, bare = 0;
    const margin = setup.edgeFactor * (((li > 0 ? stack[li - 1]!.toNext : stack[li]!.toNext) || 2e-4) / METRE);
    doc.prims.forEach((p, i) => {
      if ((p.kind !== 'track' && p.kind !== 'arc') || p.layer !== layer || p.keepout || inPour(p) || !checked(p.net)) return;
      tracks++; netsChecked.add(p.net);
      const pts = p.kind === 'track' ? [p.a, p.b] : chords(p);
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s]!, b = pts[s + 1]!, len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        const steps = Math.max(1, Math.ceil(len / g)), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        let last: [number, number] | null = null;
        for (let k = 0; k <= steps; k++) {
          const x = a.x + ((b.x - a.x) * k) / steps, y = a.y + ((b.y - a.y) * k) / steps, u = under(li, x, y);
          length += len / steps;
          if (!u[0] && !u[1]) { bare += len / steps; const q = gapAt(li, x, y); if (q.size >= setup.minGap) gaps.push({ x, y, prim: i, net: p.net, size: q.size, gap: q.gap }); last = null; continue; }
          // From over one net's copper to over another's, with nothing the same under both places
          if (last && !((u[0] && u[0] === last[0]) || (u[1] && u[1] === last[1]))) splits.push({ x, y, prim: i, net: p.net, size: 0, from: (last[0] || last[1]) - 1, to: (u[0] || u[1]) - 1 });
          last = u;
          // Along the edge: the copper that is under the track is not under a place a little to one side of it
          if (setup.edge) {
            const off = p.width / 2 + margin;
            for (const sgn of [1, -1]) { const v = under(li, x - uy * off * sgn, y + ux * off * sgn); if (!((u[0] && v[0] === u[0]) || (u[1] && v[1] === u[1]))) { edges.push({ x, y, prim: i, net: p.net, size: 0 }); break; } }
          }
        }
      }
    });
    // A layer most of whose tracks have nothing under them: said once, its gaps not listed
    if (length > 0 && bare / length > 0.5) {
      findings.push({ kind: 'noReference', layer, size: bare, message: `${layerName(layer)}: ${Math.round((100 * bare) / length)} % of the checked tracks' length has no copper under it on the next layer; its gaps are not listed` });
      continue;
    }
    const reach = g * 1.6;
    if (setup.gaps) {
      // The open edge: each stretch of track off it. A gap within the copper: once, with every net that crosses it
      for (const c of clusters(gaps.filter((s) => !Number.isFinite(s.size)), reach)) findings.push({ kind: 'gap', net: c[0]!.net, layer, box: boxOf(c, mil(40)), prims: [...new Set(c.map((s) => s.prim))], size: 1e12 + c.length,
        message: `${netName(c[0]!.net)} on ${layerName(layer)} runs ${mmOf(c.length * g)} over the open edge in the copper under it` });
      const byGap = new Map<string, Sample[]>();
      for (const s of gaps) if (Number.isFinite(s.size)) (byGap.get(s.gap!) ?? byGap.set(s.gap!, []).get(s.gap!)!).push(s);
      for (const c of byGap.values()) {
        const nets = [...new Set(c.map((s) => s.net))], size = c[0]!.size;
        findings.push({ kind: 'gap', net: nets[0]!, layer, box: boxOf(c, mil(40)), prims: [...new Set(c.map((s) => s.prim))], size: size + nets.length,
          message: nets.length === 1 ? `${netName(nets[0]!)} on ${layerName(layer)} runs ${mmOf(c.length * g)} over a gap ${mmOf(size)} long in the copper under it`
            : `${nets.length} nets on ${layerName(layer)} (${nets.slice(0, 5).map(netName).join(', ')}${nets.length > 5 ? ', and more' : ''}) cross a gap ${mmOf(size)} long in the copper under them` });
      }
      for (const c of clusters(splits, Math.max(reach, mil(40)))) {
        const s = c[0]!;
        findings.push({ kind: 'split', net: s.net, layer, box: boxOf(c, mil(40)), prims: [...new Set(c.map((q) => q.prim))], size: c.length,
          message: `${netName(s.net)} on ${layerName(layer)} crosses from over ${netName(s.from!)} to over ${netName(s.to!)}` });
      }
    }
    if (setup.edge) for (const c of clusters(edges, reach)) {
      const run = c.length * g;
      if (run < setup.minEdgeRun) continue;
      findings.push({ kind: 'edge', net: c[0]!.net, layer, box: boxOf(c, mil(40)), prims: [...new Set(c.map((s) => s.prim))], size: run,
        message: `${netName(c[0]!.net)} on ${layerName(layer)} runs ${mmOf(run)} within ${mmOf(margin)} of the edge of the copper under it` });
    }
  }

  // ── Layer changes ─────────────────────────────────────────────────────────────────────
  const holesOf = new Map<number, Vec2[]>();
  doc.prims.forEach((p) => { if ((p.kind === 'via' || (p.kind === 'pad' && p.layer === L.MULTI && p.hole > 0)) && p.net !== NO_NET) (holesOf.get(p.net) ?? holesOf.set(p.net, []).get(p.net)!).push(p.at); });
  // Capacitors: two-pad parts named C…, with their nets and where they are
  const caps: { component: number; designator: string; nets: number[]; pads: { net: number; at: Vec2 }[] }[] = [];
  {
    const pads = new Map<number, { net: number; at: Vec2 }[]>();
    for (const p of doc.prims) if (p.kind === 'pad' && p.component !== NO_NET) (pads.get(p.component) ?? pads.set(p.component, []).get(p.component)!).push({ net: p.net, at: p.at });
    for (const [c, ps] of pads) { const d = doc.components[c]?.designator ?? ''; if (/^C\d/i.test(d) && ps.length === 2) caps.push({ component: c, designator: d, nets: ps.map((q) => q.net), pads: ps }); }
  }
  let vias = 0;
  if (setup.layerChange && nL >= 3) {
    const ends: { at: Vec2; li: number; net: number }[] = [];
    doc.prims.forEach((p) => { if (p.kind === 'track' && !p.keepout && !inPour(p) && checked(p.net)) { const li = layers.indexOf(p.layer); if (li >= 0) { ends.push({ at: p.a, li, net: p.net }, { at: p.b, li, net: p.net }); } } });
    const endGrid = new Map<string, number[]>(), key = (v: Vec2) => `${Math.floor(v.x / mil(50))},${Math.floor(v.y / mil(50))}`;
    ends.forEach((e, i) => (endGrid.get(key(e.at)) ?? endGrid.set(key(e.at), []).get(key(e.at))!).push(i));
    /** The copper about a hole on a layer: the net most of a ring of places round it lie on (0: none to speak of). */
    const about = (lj: number, at: Vec2, r: number): number => {
      if (lj < 0 || lj >= nL) return 0;
      const count = new Map<number, number>();
      for (let k = 0; k < 12; k++) { const X = cx(at.x + r * Math.cos((k * Math.PI) / 6)), Y = cy(at.y + r * Math.sin((k * Math.PI) / 6)); const v = X < 0 || Y < 0 || X >= W || Y >= H ? 0 : area[lj]![Y * W + X]!; if (v) count.set(v, (count.get(v) ?? 0) + 1); }
      let best = 0, n = 0;
      for (const [v, c] of count) if (c > n) { best = v; n = c; }
      return n >= 4 ? best : 0;
    };
    doc.prims.forEach((p, i) => {
      if (p.kind !== 'via' || !checked(p.net)) return;
      vias++;
      const on = new Set<number>();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of endGrid.get(`${Math.floor(p.at.x / mil(50)) + dx},${Math.floor(p.at.y / mil(50)) + dy}`) ?? []) {
        const e = ends[j]!;
        if (e.net === p.net && Math.hypot(e.at.x - p.at.x, e.at.y - p.at.y) <= p.diameter / 2) on.add(e.li);
      }
      if (on.size < 2) return;
      const la = Math.min(...on), lb = Math.max(...on), r = p.diameter / 2 + Math.max(mil(35), 4 * g);
      const refs = (li: number) => [li - 1, li + 1].map((lj) => ({ lj, net: about(lj, p.at, r) })).filter((q) => q.net > 0);
      const ra = refs(la), rb = refs(lb);
      if (!ra.length || !rb.length || ra.some((x) => rb.some((y) => x.lj === y.lj && x.net === y.net))) return;
      const layer = layers[la]!, box = boxOf([p.at], mil(120)), where = `${netName(p.net)} goes from ${layerName(layers[la]!)} to ${layerName(layers[lb]!)}`;
      const same = ra.find((x) => rb.some((y) => y.net === x.net));
      if (same) {
        const net = same.net - 1, near = (holesOf.get(net) ?? []).reduce((m, h) => Math.min(m, Math.hypot(h.x - p.at.x, h.y - p.at.y)), Infinity);
        if (near > setup.returnVia) findings.push({ kind: 'layerChange', net: p.net, layer, box, prims: [i], size: Number.isFinite(near) ? near : 1e12,
          message: `${where}, its return passing between two layers of ${netName(net)}: ${Number.isFinite(near) ? `the nearest via of ${netName(net)} is ${mmOf(near)} away` : `${netName(net)} has no via`} (within ${mmOf(setup.returnVia)} is wanted)` });
        return;
      }
      const na = ra[0]!.net - 1, nb = rb[0]!.net - 1;
      let near = Infinity, name = '';
      for (const c of caps) if (c.nets.includes(na) && c.nets.includes(nb)) { const d = Math.min(...c.pads.map((q) => Math.hypot(q.at.x - p.at.x, q.at.y - p.at.y))); if (d < near) { near = d; name = c.designator; } }
      if (near > setup.capDistance) findings.push({ kind: 'layerChange', net: p.net, layer, box, prims: [i], size: Number.isFinite(near) ? near : 1e12,
        message: `${where}, its return passing from ${netName(na)} to ${netName(nb)}: ${name ? `the nearest capacitor between them, ${name}, is ${mmOf(near)} away` : 'there is no capacitor between them'} (within ${mmOf(setup.capDistance)} is wanted)` });
    });
  }

  // ── Decoupling ────────────────────────────────────────────────────────────────────────
  let ics = 0;
  if (setup.decoupling) {
    const isGround = (n: number) => n !== NO_NET && groundName(doc.nets[n]?.name ?? '');
    const isSupply = (n: number) => n !== NO_NET && !isGround(n) && (supplyName(doc.nets[n]?.name ?? '') || (reference.has(n) && caps.some((c) => c.nets.includes(n) && c.nets.some(isGround))));
    const byPart = new Map<number, number[]>();
    doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.component !== NO_NET) (byPart.get(p.component) ?? byPart.set(p.component, []).get(p.component)!).push(i); });
    for (const [c, padIdx] of byPart) {
      const d = doc.components[c]?.designator ?? '';
      if (!/^(U|IC)\d/i.test(d) || padIdx.length < 4) continue;
      ics++;
      const missed: { pin: string; net: number; near: number; cap: string; prim: number }[] = [];
      for (const i of padIdx) {
        const p = doc.prims[i]!;
        if (p.kind !== 'pad' || !isSupply(p.net)) continue;
        let near = Infinity, cap = '';
        for (const k of caps) { if (!k.nets.includes(p.net) || !k.nets.some(isGround)) continue; const q = k.pads.find((x) => x.net === p.net)!, dist = Math.hypot(q.at.x - p.at.x, q.at.y - p.at.y); if (dist < near) { near = dist; cap = k.designator; } }
        if (near > setup.decouplingDistance) missed.push({ pin: p.name, net: p.net, near, cap, prim: i });
      }
      if (!missed.length) continue;
      missed.sort((a, b) => b.near - a.near);
      const m = missed[0]!, pts = missed.map((x) => (doc.prims[x.prim] as { at: Vec2 }).at);
      findings.push({ kind: 'decoupling', net: m.net, box: boxOf(pts, mil(80)), prims: missed.map((x) => x.prim), size: Number.isFinite(m.near) ? m.near : 1e12,
        message: `${d}: ${missed.length === 1 ? `supply pin ${m.pin} (${netName(m.net)}) has` : `${missed.length} supply pins (${missed.slice(0, 4).map((x) => `${x.pin} ${netName(x.net)}`).join(', ')}${missed.length > 4 ? ', and more' : ''}) have`} no capacitor to ground within ${mmOf(setup.decouplingDistance)}: ${m.cap ? `the nearest${missed.length === 1 ? '' : ` to pin ${m.pin}`}, ${m.cap}, is ${mmOf(m.near)} away` : `${netName(m.net)} has none`}` });
    }
  }

  // ── Stitching ─────────────────────────────────────────────────────────────────────────
  if (setup.stitching) {
    for (const net of reference) {
      if (!groundName(doc.nets[net]?.name ?? '') || (layersOf.get(net)?.size ?? 0) < 2) continue;
      const holes = holesOf.get(net) ?? [];
      for (const li of layersOf.get(net)!) {
        const layer = layers[li]!;
        if (!isSignal(layer)) continue;
        // How far each cell of the net's copper is from the nearest of its vias (two sweeps, by steps to the eight neighbours)
        const a = area[li]!, dist = new Float32Array(W * H).fill(1e9), D = Math.SQRT2;
        for (const h of holes) { const X = cx(h.x), Y = cy(h.y); if (X >= 0 && Y >= 0 && X < W && Y < H) dist[Y * W + X] = 0; }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const c = y * W + x; let v = dist[c]!;
          if (x > 0) v = Math.min(v, dist[c - 1]! + 1);
          if (y > 0) { v = Math.min(v, dist[c - W]! + 1); if (x > 0) v = Math.min(v, dist[c - W - 1]! + D); if (x < W - 1) v = Math.min(v, dist[c - W + 1]! + D); }
          dist[c] = v;
        }
        for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
          const c = y * W + x; let v = dist[c]!;
          if (x < W - 1) v = Math.min(v, dist[c + 1]! + 1);
          if (y < H - 1) { v = Math.min(v, dist[c + W]! + 1); if (x > 0) v = Math.min(v, dist[c + W - 1]! + D); if (x < W - 1) v = Math.min(v, dist[c + W + 1]! + D); }
          dist[c] = v;
        }
        // The copper beyond the limit, in pieces
        const far: { x: number; y: number; d: number }[] = [];
        for (let c = 0; c < W * H; c++) if (a[c] === net + 1 && dist[c]! * g > lambda20) far.push({ x: minX + ((c % W) + 0.5) * g, y: minY + (Math.floor(c / W) + 0.5) * g, d: dist[c]! * g });
        const pieces = clusters(far, g * 1.5).map((c) => ({ c, worst: c.reduce((m, q) => (q.d > m.d ? q : m), c[0]!) })).filter((q) => q.c.length * g * g >= (lambda20 / 4) ** 2).sort((p, q) => q.worst.d - p.worst.d).slice(0, 12);
        for (const { c, worst } of pieces) findings.push({ kind: 'stitching', net, layer, box: boxOf(c, mil(20)), size: worst.d,
          message: `${netName(net)} copper on ${layerName(layer)} reaches ${worst.d > 5e8 * g ? 'no via at all' : `${mmOf(worst.d)} from its nearest via`}: a twentieth of a wavelength at ${setup.frequency >= 1e9 ? `${setup.frequency / 1e9} GHz` : `${setup.frequency / 1e6} MHz`} is ${mmOf(lambda20)}` });
      }
    }
  }
  const order = new Map(EMC_KINDS.map((k, i) => [k.kind, i]));
  findings.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || b.size - a.size);
  return { findings, nets: netsChecked.size, tracks, vias, ics, lambda20, er };
}

/** The check as a text report. */
export function emcReport(r: EmcResult, setup: EmcSetup, title: string): string {
  const out: string[] = [`EMC Check: ${title}`, ''];
  out.push(`Looked at       ${r.tracks} tracks of ${r.nets} nets, ${r.vias} of their vias, ${r.ics} ICs`);
  out.push(`Nets            ${setup.nets.length ? setup.nets.join(', ') : 'every net that is neither a supply nor a ground'}`);
  out.push(`Frequency       ${setup.frequency >= 1e9 ? `${setup.frequency / 1e9} GHz` : `${setup.frequency / 1e6} MHz`}: a twentieth of a wavelength in the board (dielectric constant ${r.er}) is ${mmOf(r.lambda20)}`, '');
  for (const k of EMC_KINDS) {
    const list = r.findings.filter((f) => f.kind === k.kind);
    if (!list.length) continue;
    out.push(`${k.title} (${list.length})`);
    for (const f of list) out.push(`  ${f.message}`);
    out.push('');
  }
  if (!r.findings.length) out.push('Nothing found.');
  return out.join('\n');
}
