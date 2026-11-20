/**
 * A supply net at DC: what voltage each load is left with, how hard the copper is worked and what
 * each via carries. Some pads are held at a voltage (a regulator's output, a connector's pin) and
 * the loads draw their currents from others; the net's copper (analysis/copperNet.ts) is the
 * network between them.
 *
 * A return net is the same sum the other way round: its source pads held at 0 V and the loads'
 * currents put in, so a load's potential there is how far its ground has risen.
 */

import type { Vec2 } from '../core/geom';
import type { PcbDocument } from '../model/pcb';
import { AREA_X, AREA_Y, COPPER_ALPHA, METRE, buildCopperNet, copperSigma, gridFor, type CopperNet, type Grid } from './copperNet';
import { solver, type Solver } from './pcg';

export interface PowerSetup {
  net: number;
  /** Pads held at a voltage, by index in doc.prims. */
  sources: { pads: number[]; voltage: number }[];
  /** Pads that draw a current (amperes, shared equally among them); negative: put in, as on a return net. */
  loads: { name: string; pads: number[]; current: number }[];
  /** The copper's temperature, °C (25). */
  temperature?: number;
  /** The plating on the walls of holes, metres (25 µm). */
  plating?: number;
  /** About how many grid cells a layer (120 000). */
  cells?: number;
  /** Keep the copper's picture, to draw a map of the answers on. */
  picture?: boolean;
  /** The copper's temperature from place to place, °C (by layer index and place), where a thermal analysis has found it: each piece of copper then has the resistance of its own temperature (NaN: `temperature`'s). */
  field?: (layer: number, x: number, y: number) => number;
}

export interface LoadResult {
  name: string; current: number;
  /** The potential at its pads (the mean over them, by copper), and at the worst of them; NaN when no copper joins it to a source. */
  voltage: number; worst: number;
  connected: boolean;
}

export interface PowerResult {
  setup: PowerSetup; cn: CopperNet;
  /** Each node's potential, volts (NaN: not joined to a source). */
  v: Float64Array;
  iterations: number; residual: number;
  loads: LoadResult[];
  /** What the sources give, amperes, and what the copper turns to heat, watts. */
  sourceCurrent: number; loss: number;
  /** Each link's current, amperes (from its first node to its second). */
  current: Float64Array;
  /** Current density by layer and cell, A/m² (NaN: no copper), and of each length of track. */
  density: Float32Array; trackDensity: Float32Array;
  /** The most any length of each barrel carries, amperes. */
  barrelCurrent: Float32Array;
  /** The lowest and highest potentials on the joined copper. */
  minV: number; maxV: number;
  /** Where the copper is worked hardest. */
  peak: { density: number; layer: number; at: Vec2 } | null;
  /** Pads asked for that have no copper of the net under them. */
  missing: number[];
}

export interface PowerJob { cn: CopperNet; solver: Solver; finish(): PowerResult }

/** Sets the sum up; `solver.step` works it, `finish` reads the answers off. */
export function startPower(doc: PcbDocument, setup: PowerSetup, grid?: Grid | null): PowerJob | null {
  grid ??= gridFor(doc, new Set([setup.net]), setup.cells);
  if (!grid) return null;
  const pads = [...setup.sources.flatMap((s) => s.pads), ...setup.loads.flatMap((l) => l.pads)];
  const cn = buildCopperNet(doc, setup.net, grid, { sigma: copperSigma(setup.temperature ?? 25), plating: setup.plating ?? 25e-6, pads, picture: setup.picture });
  const held = new Float64Array(cn.count).fill(NaN), flow = new Float64Array(cn.count), missing: number[] = [];
  // How much of a cell's side each area link's copper is (before any is made warmer or cooler)
  const l = cn.links, across = new Float32Array(l.count);
  for (let k = 0; k < l.count; k++) if (cn.kind[k] === AREA_X || cn.kind[k] === AREA_Y) across[k] = l.g[k]! / cn.sheet[cn.nodeLayer[l.a[k]!]!]!;
  if (setup.field) {
    const base = 1 + COPPER_ALPHA * ((setup.temperature ?? 25) - 20), at = (i: number) => { const t = setup.field!(cn.nodeLayer[i]!, cn.nodeX[i]!, cn.nodeY[i]!); return Number.isFinite(t) ? t : setup.temperature ?? 25; };
    for (let k = 0; k < l.count; k++) l.g[k]! *= base / (1 + COPPER_ALPHA * ((at(l.a[k]!) + at(l.b[k]!)) / 2 - 20));
  }
  for (const s of setup.sources) for (const p of s.pads) {
    const at = cn.pads.get(p);
    if (!at) { missing.push(p); continue; }
    for (const { node } of at) held[node] = s.voltage;
  }
  for (const l of setup.loads) {
    const there = l.pads.filter((p) => cn.pads.has(p));
    for (const p of l.pads) if (!cn.pads.has(p)) missing.push(p);
    for (const p of there) for (const { node, share } of cn.pads.get(p)!) flow[node]! -= (l.current / there.length) * share;
  }
  // A source's own pads take no current from themselves
  for (let i = 0; i < cn.count; i++) if (!Number.isNaN(held[i]!)) flow[i] = 0;
  const sv = solver(cn.count, cn.links, held, flow, { tolerance: 1e-8 });
  return { cn, solver: sv, finish: () => finish(setup, cn, sv, missing, across) };
}

function finish(setup: PowerSetup, cn: CopperNet, sv: Solver, missing: number[], across: Float32Array): PowerResult {
  const { x: v, iterations, residual } = sv.result(), l = cn.links, { w: W, hgt: H, h } = cn.grid, nL = cn.grid.layers.length;
  const current = new Float64Array(l.count);
  let loss = 0, minV = Infinity, maxV = -Infinity;
  // Each area node's current east-west and north-south, and how much copper carries it across its sides
  const ix = new Float32Array(cn.count), iy = new Float32Array(cn.count), wx = new Float32Array(cn.count), wy = new Float32Array(cn.count);
  for (let k = 0; k < l.count; k++) {
    const a = l.a[k]!, b = l.b[k]!, d = v[a]! - v[b]!;
    if (!Number.isFinite(d)) continue;
    const i = l.g[k]! * d;
    current[k] = i; loss += i * d;
    const kind = cn.kind[k]!;
    if (kind === AREA_X || kind === AREA_Y) {
      // A link's first node is the western or the southern of its two
      const s = i, part = across[k]!;
      if (kind === AREA_X) { ix[a]! += s / 2; ix[b]! += s / 2; wx[a]! += part / 2; wx[b]! += part / 2; }
      else { iy[a]! += s / 2; iy[b]! += s / 2; wy[a]! += part / 2; wy[b]! += part / 2; }
    }
  }
  for (let i = 0; i < cn.count; i++) { const p = v[i]!; if (Number.isFinite(p)) { if (p < minV) minV = p; if (p > maxV) maxV = p; } }
  const density = new Float32Array(nL * W * H).fill(NaN), hm = h * METRE;
  let peak: PowerResult['peak'] = null;
  for (let li = 0; li < nL; li++) {
    const t = cn.stack[li]!.thickness, base = li * W * H;
    for (let c = 0; c < W * H; c++) {
      const n = cn.cellNode[base + c]!;
      if (n < 0 || !Number.isFinite(v[n]!)) continue;
      const jx = wx[n]! > 0 ? ix[n]! / (wx[n]! * hm * t) : 0, jy = wy[n]! > 0 ? iy[n]! / (wy[n]! * hm * t) : 0, j = Math.hypot(jx, jy);
      density[base + c] = j;
      if (!peak || j > peak.density) peak = { density: j, layer: li, at: { x: cn.nodeX[n]!, y: cn.nodeY[n]! } };
    }
  }
  const trackDensity = new Float32Array(cn.tracks.length);
  cn.tracks.forEach((tp, k) => {
    const j = Math.abs(current[tp.link]!) / (tp.width * METRE * cn.stack[tp.layer]!.thickness);
    trackDensity[k] = j;
    if (!peak || j > peak.density) peak = { density: j, layer: tp.layer, at: { x: (tp.a.x + tp.b.x) / 2, y: (tp.a.y + tp.b.y) / 2 } };
  });
  const barrelCurrent = new Float32Array(cn.barrels.length);
  cn.barrels.forEach((b, k) => { let m = 0; for (const id of b.links) m = Math.max(m, Math.abs(current[id]!)); barrelCurrent[k] = m; });
  let sourceCurrent = 0;
  const loads: LoadResult[] = setup.loads.map((ld) => {
    const there = ld.pads.filter((p) => cn.pads.has(p));
    let sum = 0, worst = NaN, ok = there.length > 0;
    for (const p of there) {
      let pv = 0;
      for (const { node, share } of cn.pads.get(p)!) pv += v[node]! * share;
      if (!Number.isFinite(pv)) { ok = false; continue; }
      sum += pv / there.length;
      // The worst pad: the one furthest from where the current comes from
      if (Number.isNaN(worst) || (ld.current >= 0 ? pv < worst : pv > worst)) worst = pv;
    }
    if (ok) sourceCurrent += ld.current;
    return { name: ld.name, current: ld.current, voltage: ok ? sum : NaN, worst: ok ? worst : NaN, connected: ok };
  });
  return { setup, cn, v, iterations, residual, loads, sourceCurrent, loss, current, density, trackDensity, barrelCurrent, minV, maxV, peak, missing };
}

/** The whole sum at once. */
export function analysePower(doc: PcbDocument, setup: PowerSetup, grid?: Grid | null): PowerResult | null {
  const job = startPower(doc, setup, grid);
  if (!job) return null;
  while (!job.solver.step(500)) { /* until it settles */ }
  return job.finish();
}
