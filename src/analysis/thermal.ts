/**
 * The board's temperature. The whole board under a square grid, a node for each cell on each
 * copper layer. Heat spreads along a layer through its copper (as much of it as crosses from cell
 * to cell, every net's) and through the laminate; from layer to layer through the laminate and
 * down the plated walls of vias and holes; and leaves from the two faces to the air, by
 * convection and by radiation. The parts' dissipation goes in at their pads, the copper's own
 * loss (analysis/power.ts) where it arises. The network is solved by analysis/pcg.ts, in degrees
 * above the air's temperature.
 *
 * Still air is worked out, not assumed: the faces' coefficients depend on how hot they are
 * (the simplified laminar relations for air, h = C·(ΔT/L)^¼ with C 1.32 for a face up, 0.59 for
 * a face down and 1.42 for an upright one; radiation ε·σ·(Ts² + Ta²)·(Ts + Ta)), so the sum is
 * repeated until they settle.
 */

import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import { NO_NET, type PcbDocument } from '../model/pcb';
import { L, type LayerId } from '../model/layers';
import { circle16, padOutline } from '../model/drcCopper';
import { METRE, stackCopper, type Grid, type StackCopper } from './copperNet';
import { Raster, inPoly, layerCopper } from './raster';
import { link, newLinks, solver, type Links } from './pcg';
import type { PowerResult } from './power';

/** Copper's thermal conductivity, W/m·K, and its heat capacity by volume, J/m³·K; the laminate's (FR-4, typical). */
export const K_COPPER = 390, C_COPPER = 3.45e6, C_LAMINATE = 2.0e6;
const STEFAN = 5.670374e-8;

export type Air = 'flat' | 'upright' | { top: number; bottom: number };

export interface ThermalSetup {
  /** The air's temperature, °C. */
  ambient: number;
  /** Still air about a board lying flat or standing upright (worked out), or a coefficient given for each face, W/m²·K (radiation included in it). */
  air: Air;
  /** How well the faces radiate (solder mask: 0.9). */
  emissivity?: number;
  /** What each part dissipates, watts; and, to tell its junction's temperature, its junction-to-board resistance, K/W. */
  sources: { component: number; power: number; theta?: number }[];
  /** Power analyses whose copper loss is heat on the board. */
  copper?: PowerResult[];
  /** The laminate's conductivity along the board and through it, W/m·K (0.8 and 0.3). */
  kInPlane?: number; kThrough?: number;
  /** The plating on the walls of holes, metres (25 µm). */
  plating?: number;
  /** About how many grid cells (40 000). */
  cells?: number;
}

export interface ThermalModel {
  grid: Grid; stack: StackCopper[];
  /** By cell: in the board (1) or not. */
  inside: Uint8Array;
  /** By layer and cell: its node, −1 outside the board. */
  nodeOf: Int32Array; count: number;
  links: Links;
  /** The nodes of the top and the bottom face; a cell's area, m². */
  top: Int32Array; bottom: Int32Array; area: number;
  /** Each node's heat capacity, J/K. */
  capacity: Float64Array;
  /** The board's area (m²), the length its still-air convection goes by when flat (4A/p) and when upright (its longer side). */
  boardArea: number; flatLength: number; uprightLength: number;
}

export interface PartTemperature {
  component: number; designator: string; power: number;
  /** The board under its pads: the mean and the hottest, °C. */
  board: number; boardMax: number;
  /** Its junction, where a junction-to-board resistance was given. */
  junction?: number;
}

export interface FaceLoss { /** W/m²·K: in all, by convection, by radiation. */ h: number; convection: number; radiation: number; /** Watts leaving by it, and its mean temperature, °C. */ loss: number; mean: number }

export interface ThermalResult {
  setup: ThermalSetup; model: ThermalModel;
  /** By layer and cell, °C (NaN outside the board). */
  t: Float32Array;
  /** The hottest place, and the board's mean over its top face. */
  max: number; maxAt: { layer: number; at: Vec2 }; mean: number;
  /** Heat put in, watts: by the parts, by the copper. */
  power: number; copperPower: number;
  top: FaceLoss; bottom: FaceLoss;
  /** The parts given a dissipation, and every component by the board's temperature at its pads (the hottest first). */
  parts: PartTemperature[]; components: { component: number; designator: string; t: number }[];
  /** Times the sum was done over for the air's coefficients, and the solver's steps in all. */
  rounds: number; steps: number;
}

/** The board's box and shape: its outline, or failing one the box of its copper. */
function boardShape(doc: PcbDocument): { outline: Vec2[]; cutouts: Vec2[][] } | null {
  let outline = doc.board.outline;
  if (outline.length < 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const see = (p: Vec2) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    for (const p of doc.prims) { if (p.kind === 'track') { see(p.a); see(p.b); } else if (p.kind === 'pad' || p.kind === 'via') see(p.at); }
    if (!(maxX > minX) || !(maxY > minY)) return null;
    outline = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
  }
  const cutouts: Vec2[][] = [];
  for (const p of doc.prims) if (p.kind === 'region' && p.boardCutout && p.outline.length >= 3) cutouts.push(p.outline);
  return { outline, cutouts };
}

/** The board as a network of thermal conductances (its faces' losses are added when it is solved). */
export function buildThermal(doc: PcbDocument, setup: Pick<ThermalSetup, 'kInPlane' | 'kThrough' | 'plating' | 'cells'> = {}): ThermalModel | null {
  const shape = boardShape(doc);
  if (!shape) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, twice = 0, round = 0;
  shape.outline.forEach((p, i) => {
    const q = shape.outline[(i + 1) % shape.outline.length]!;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    twice += p.x * q.y - q.x * p.y; round += Math.hypot(q.x - p.x, q.y - p.y);
  });
  let boardArea = Math.abs(twice) / 2;
  for (const c of shape.cutouts) { let a = 0; c.forEach((p, i) => { const q = c[(i + 1) % c.length]!; a += p.x * q.y - q.x * p.y; }); boardArea -= Math.abs(a) / 2; }
  const h = Math.min(mil(200), Math.max(mil(8), Math.sqrt(((maxX - minX) * (maxY - minY)) / (setup.cells ?? 40_000))));
  const W = Math.max(1, Math.ceil((maxX - minX) / h)), H = Math.max(1, Math.ceil((maxY - minY) / h));
  const layers = [...doc.board.copperStack], nL = layers.length, grid: Grid = { minX, minY, h, w: W, hgt: H, layers };
  const stack = stackCopper(doc), kIn = setup.kInPlane ?? 0.8, kZ = setup.kThrough ?? 0.3, plating = setup.plating ?? 25e-6;
  // The cells of the board
  const inside = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const x = minX + (cx + 0.5) * h, y = minY + (cy + 0.5) * h;
    if (inPoly(shape.outline, x, y) && !shape.cutouts.some((c) => inPoly(c, x, y))) inside[cy * W + cx] = 1;
  }
  const nodeOf = new Int32Array(nL * W * H).fill(-1);
  let count = 0;
  for (let li = 0; li < nL; li++) for (let c = 0; c < W * H; c++) if (inside[c]) nodeOf[li * W * H + c] = count++;
  if (!count) return null;
  const links = newLinks(count * 3), area = (h * METRE) ** 2, capacity = new Float64Array(count);
  const ras = new Raster(minX, minY, h / 3, W * 3, H * 3), sub = ras.cells, W3 = W * 3;
  /** The laminate that goes with each layer: half of what lies between it and its neighbours (a single layer: a 1.5 mm board). */
  const slab = (li: number) => (nL === 1 ? 1.5e-3 : (li > 0 ? stack[li - 1]!.toNext / 2 : 0) + (li < nL - 1 ? stack[li]!.toNext / 2 : 0));
  for (let li = 0; li < nL; li++) {
    ras.clear();
    layerCopper(doc, layers[li]!, { tracks: 'all' }, (rings) => ras.fill(rings));
    const base = li * W * H, cu = K_COPPER * stack[li]!.thickness, lam = kIn * slab(li);
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      const a = nodeOf[base + cy * W + cx]!;
      if (a < 0) continue;
      let cover = 0;
      for (let k = 0; k < 9; k++) cover += sub[(cy * 3 + ((k / 3) | 0)) * W3 + cx * 3 + (k % 3)]!;
      capacity[a] = area * (C_COPPER * stack[li]!.thickness * (cover / 9) + C_LAMINATE * slab(li));
      // East and north: the copper that crosses the shared side, and the laminate
      const e = cx + 1 < W ? nodeOf[base + cy * W + cx + 1]! : -1, n = cy + 1 < H ? nodeOf[base + (cy + 1) * W + cx]! : -1;
      if (e >= 0) { let c = 0; for (let k = 0; k < 3; k++) c += sub[(cy * 3 + k) * W3 + cx * 3 + 2]! & sub[(cy * 3 + k) * W3 + cx * 3 + 3]!; link(links, a, e, (cu * c) / 3 + lam); }
      if (n >= 0) { let c = 0; for (let k = 0; k < 3; k++) c += sub[(cy * 3 + 2) * W3 + cx * 3 + k]! & sub[(cy * 3 + 3) * W3 + cx * 3 + k]!; link(links, a, n, (cu * c) / 3 + lam); }
    }
  }
  // From layer to layer: the laminate, and the walls of the holes that pass
  const barrels = new Float64Array(Math.max(0, nL - 1) * W * H);
  for (const p of doc.prims) {
    if (p.kind !== 'via' && !(p.kind === 'pad' && p.layer === L.MULTI && p.plated && p.hole > 0)) continue;
    const cx = Math.floor((p.at.x - minX) / h), cy = Math.floor((p.at.y - minY) / h);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H || !inside[cy * W + cx]) continue;
    let from = 0, to = nL - 1;
    if (p.kind === 'via') { const a = layers.indexOf(p.layerStart), b = layers.indexOf(p.layerEnd); if (a >= 0 && b >= 0) { from = Math.min(a, b); to = Math.max(a, b); } }
    const wall = K_COPPER * Math.PI * (p.hole * METRE + plating) * plating;
    for (let li = from; li < to; li++) if (stack[li]!.toNext > 0) barrels[li * W * H + cy * W + cx]! += wall / stack[li]!.toNext;
  }
  for (let li = 0; li + 1 < nL; li++) for (let c = 0; c < W * H; c++) {
    const a = nodeOf[li * W * H + c]!;
    if (a >= 0) link(links, a, nodeOf[(li + 1) * W * H + c]!, (stack[li]!.toNext > 0 ? (kZ * area) / stack[li]!.toNext : 0) + barrels[li * W * H + c]!);
  }
  const face = (li: number) => { const out = new Int32Array(count / nL); let k = 0; for (let c = 0; c < W * H; c++) { const n = nodeOf[li * W * H + c]!; if (n >= 0) out[k++] = n; } return out; };
  return { grid, stack, inside, nodeOf, count, links, top: face(0), bottom: face(nL - 1), area, capacity,
    boardArea: boardArea * METRE * METRE, flatLength: (4 * boardArea * METRE) / Math.max(round, 1), uprightLength: Math.max(maxX - minX, maxY - minY) * METRE };
}

/** The node at a place on a layer (−1 off the board). */
export function nodeAt(m: ThermalModel, li: number, x: number, y: number): number {
  const { minX, minY, h, w: W, hgt: H } = m.grid, cx = Math.floor((x - minX) / h), cy = Math.floor((y - minY) / h);
  return cx < 0 || cy < 0 || cx >= W || cy >= H || li < 0 || li >= m.grid.layers.length ? -1 : m.nodeOf[li * W * H + cy * W + cx]!;
}

/** The nodes under a component's pads, each with its share of the component (by pad area); a part with no pads: the node where it stands. */
export function partNodes(doc: PcbDocument, m: ThermalModel, component: number): { node: number; share: number }[] {
  const { minX, minY, h, w: W, hgt: H, layers } = m.grid, got = new Map<number, number>();
  let total = 0;
  for (const p of doc.prims) {
    if (p.kind !== 'pad' || p.component !== component) continue;
    const li = p.layer === L.MULTI ? 0 : layers.indexOf(p.layer);
    if (li < 0) continue;
    const g = padOutline(p, p.top), ring = g?.t === 'poly' ? g.pts : g?.t === 'circle' ? circle16(g.c, g.r) : null, size = Math.max(1, p.top.w * p.top.h), under: number[] = [];
    if (ring) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      for (let cy = Math.max(0, Math.floor((y0 - minY) / h)); cy <= Math.min(H - 1, Math.floor((y1 - minY) / h)); cy++) for (let cx = Math.max(0, Math.floor((x0 - minX) / h)); cx <= Math.min(W - 1, Math.floor((x1 - minX) / h)); cx++) {
        const n = m.nodeOf[li * W * H + cy * W + cx]!;
        if (n >= 0 && inPoly(ring, minX + (cx + 0.5) * h, minY + (cy + 0.5) * h)) under.push(n);
      }
    }
    if (!under.length) { const n = nodeAt(m, li, p.at.x, p.at.y); if (n >= 0) under.push(n); }
    for (const n of under) got.set(n, (got.get(n) ?? 0) + size / under.length);
    if (under.length) total += size;
  }
  if (!total) {
    const c = doc.components[component], n = c ? nodeAt(m, Math.max(0, layers.indexOf(c.layer)), c.at.x, c.at.y) : -1;
    return n >= 0 ? [{ node: n, share: 1 }] : [];
  }
  return [...got].map(([node, s]) => ({ node, share: s / total }));
}

/** A power analysis's copper loss as heat at the model's nodes (watts added to `flow`); what it comes to. */
export function copperHeat(m: ThermalModel, res: PowerResult, flow: Float64Array): number {
  const cn = res.cn, l = cn.links;
  let sum = 0;
  for (let k = 0; k < l.count; k++) {
    const a = l.a[k]!, b = l.b[k]!, d = res.v[a]! - res.v[b]!;
    if (!Number.isFinite(d)) continue;
    const w = res.current[k]! * d;
    if (!(w > 0)) continue;
    for (const i of [a, b]) { const n = nodeAt(m, cn.nodeLayer[i]!, cn.nodeX[i]!, cn.nodeY[i]!); if (n >= 0) { flow[n]! += w / 2; sum += w / 2; } }
  }
  return sum;
}

/** A face's coefficient in still air: convection by the simplified laminar relation, and radiation. */
export function stillAir(c: number, rise: number, length: number, emissivity: number, ambient: number): { h: number; convection: number; radiation: number } {
  const ts = ambient + rise + 273.15, ta = ambient + 273.15;
  const convection = c * (Math.max(rise, 0.01) / Math.max(length, 1e-3)) ** 0.25, radiation = emissivity * STEFAN * (ts * ts + ta * ta) * (ts + ta);
  return { h: convection + radiation, convection, radiation };
}

/**
 * The board's temperature with the heat settled. A generator, so that the window can be kept
 * alive: each value it gives is a word on how far it has got, and its return is the answer.
 */
export function* steadySteps(doc: PcbDocument, setup: ThermalSetup, model?: ThermalModel | null): Generator<string, ThermalResult | null, void> {
  const m = model ?? buildThermal(doc, setup);
  if (!m) return null;
  const { w: W, hgt: H, h, minX, minY } = m.grid, nL = m.grid.layers.length, n = m.count, flow = new Float64Array(n), held = new Float64Array(n).fill(NaN);
  let power = 0, copperPower = 0;
  const placed = setup.sources.filter((s) => s.power > 0).map((s) => ({ s, at: partNodes(doc, m, s.component) }));
  for (const { s, at } of placed) { if (!at.length) continue; power += s.power; for (const { node, share } of at) flow[node]! += s.power * share; }
  for (const res of setup.copper ?? []) copperPower += copperHeat(m, res, flow);
  const given = typeof setup.air === 'object' ? setup.air : null, eps = setup.emissivity ?? 0.9;
  const still = (top: boolean, rise: number) => stillAir(setup.air === 'upright' ? 1.42 : top ? 1.32 : 0.59, rise, setup.air === 'upright' ? m.uprightLength : m.flatLength, eps, setup.ambient);
  let ft = given ? { h: given.top, convection: given.top, radiation: 0 } : still(true, 20), fb = given ? { h: given.bottom, convection: given.bottom, radiation: 0 } : still(false, 20);
  let x: Float64Array | undefined, rounds = 0, steps = 0, meanTop = 0, meanBot = 0;
  for (;;) {
    rounds++;
    const shunt = new Float64Array(n);
    for (const i of m.top) shunt[i]! += ft.h * m.area;
    for (const i of m.bottom) shunt[i]! += fb.h * m.area;
    const sv = solver(n, m.links, held, flow, { shunt, start: x, tolerance: 1e-8 });
    while (!sv.step(3)) yield `${n.toLocaleString('en')} nodes, round ${rounds}, step ${sv.iterations}`;
    steps += sv.iterations;
    x = sv.result().x;
    meanTop = 0; meanBot = 0;
    for (const i of m.top) meanTop += x[i]!;
    for (const i of m.bottom) meanBot += x[i]!;
    meanTop /= m.top.length; meanBot /= m.bottom.length;
    if (given || rounds >= 12) break;
    const nt = still(true, meanTop), nb = still(false, meanBot), change = Math.max(Math.abs(nt.h - ft.h) / ft.h, Math.abs(nb.h - fb.h) / fb.h);
    // (settled: the coefficients the last sum was done with are the answer's)
    if (change < 0.005) break;
    ft = nt; fb = nb;
  }
  const t = new Float32Array(nL * W * H).fill(NaN);
  let max = -Infinity, maxAt = { layer: 0, at: { x: minX, y: minY } };
  for (let li = 0; li < nL; li++) for (let c = 0; c < W * H; c++) {
    const i = m.nodeOf[li * W * H + c]!;
    if (i < 0) continue;
    const v = x[i]! + setup.ambient;
    t[li * W * H + c] = v;
    if (v > max) { max = v; maxAt = { layer: li, at: { x: minX + ((c % W) + 0.5) * h, y: minY + (Math.floor(c / W) + 0.5) * h } }; }
  }
  const parts: PartTemperature[] = placed.filter(({ at }) => at.length).map(({ s, at }) => {
    let board = 0, boardMax = -Infinity;
    for (const { node, share } of at) { board += x![node]! * share; boardMax = Math.max(boardMax, x![node]!); }
    board += setup.ambient; boardMax += setup.ambient;
    return { component: s.component, designator: doc.components[s.component]?.designator ?? String(s.component), power: s.power, board, boardMax, ...(s.theta !== undefined && s.theta > 0 ? { junction: board + s.power * s.theta } : {}) };
  });
  // Every component by the board's temperature at its pads
  const sum = new Map<number, [number, number]>();
  for (const p of doc.prims) {
    if (p.kind !== 'pad' || p.component === NO_NET) continue;
    const i = nodeAt(m, p.layer === L.MULTI ? 0 : m.grid.layers.indexOf(p.layer as LayerId), p.at.x, p.at.y);
    if (i < 0) continue;
    const e = sum.get(p.component) ?? [0, 0];
    e[0] += x[i]!; e[1]++; sum.set(p.component, e);
  }
  const components = [...sum].map(([component, [s, k]]) => ({ component, designator: doc.components[component]?.designator ?? String(component), t: s / k + setup.ambient })).sort((a, b) => b.t - a.t);
  const lossTop = ft.h * m.area * meanTop * m.top.length, lossBot = fb.h * m.area * meanBot * m.bottom.length;
  return {
    setup, model: m, t, max, maxAt, mean: meanTop + setup.ambient, power, copperPower,
    top: { ...ft, loss: lossTop, mean: meanTop + setup.ambient }, bottom: { ...fb, loss: lossBot, mean: meanBot + setup.ambient },
    parts, components, rounds, steps,
  };
}

/** The board's temperature with the heat settled, in one go. */
export function analyseThermal(doc: PcbDocument, setup: ThermalSetup, model?: ThermalModel | null): ThermalResult | null {
  const g = steadySteps(doc, setup, model);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The temperature at a place on a layer, °C (NaN off the board). */
export function temperatureAt(r: ThermalResult, li: number, x: number, y: number): number {
  const { minX, minY, h, w: W, hgt: H } = r.model.grid, cx = Math.floor((x - minX) / h), cy = Math.floor((y - minY) / h);
  return cx < 0 || cy < 0 || cx >= W || cy >= H || li < 0 || li >= r.model.grid.layers.length ? NaN : r.t[li * W * H + cy * W + cx]!;
}

export interface WarmUp {
  /** Seconds from switching on, and at each: the hottest place's temperature and each heated part's board temperature, °C. */
  times: number[]; max: number[]; parts: { component: number; designator: string; t: number[] }[];
  /** The board's time constant taken as one lump (its heat capacity over what its faces lose), seconds. */
  lump: number;
  /** When the hottest place has made half, and nine tenths, of its final rise, seconds (NaN: not within the time worked). */
  half: number; most: number;
}

/**
 * The board warming up from the air's temperature, the heat switched on at time 0: the settled
 * analysis's heat and face coefficients, the board's own heat capacity (its copper and laminate;
 * the parts' own mass is not counted, so a board with heavy parts warms more slowly than this).
 * Steps in time that lengthen as the change slows, each an implicit one.
 */
export function* warmUpSteps(doc: PcbDocument, steady: ThermalResult): Generator<string, WarmUp, void> {
  const m = steady.model, setup = steady.setup, n = m.count, held = new Float64Array(n).fill(NaN), flow = new Float64Array(n);
  const placed = setup.sources.filter((s) => s.power > 0).map((s) => ({ s, at: partNodes(doc, m, s.component) })).filter(({ at }) => at.length);
  for (const { s, at } of placed) for (const { node, share } of at) flow[node]! += s.power * share;
  for (const res of setup.copper ?? []) copperHeat(m, res, flow);
  const faces = new Float64Array(n);
  for (const i of m.top) faces[i]! += steady.top.h * m.area;
  for (const i of m.bottom) faces[i]! += steady.bottom.h * m.area;
  let cap = 0, loss = 0;
  for (let i = 0; i < n; i++) { cap += m.capacity[i]!; loss += faces[i]!; }
  const lump = cap / Math.max(loss, 1e-12), finalRise = steady.max - setup.ambient;
  const hot = nodeAt(m, steady.maxAt.layer, steady.maxAt.at.x, steady.maxAt.at.y);
  const times = [0], max = [setup.ambient], parts = placed.map(({ s }) => ({ component: s.component, designator: doc.components[s.component]?.designator ?? String(s.component), t: [setup.ambient] }));
  let x: Float64Array = new Float64Array(n), t = 0, dt = lump / 200;
  const shunt = new Float64Array(n), rhs = new Float64Array(n);
  for (let k = 0; k < 60; k++) {
    for (let i = 0; i < n; i++) { const c = m.capacity[i]! / dt; shunt[i] = faces[i]! + c; rhs[i] = flow[i]! + c * x[i]!; }
    const sv = solver(n, m.links, held, rhs, { shunt, start: x, tolerance: 1e-7 });
    while (!sv.step(4)) yield `${Math.round(t)} s`;
    x = sv.result().x;
    t += dt; dt *= 1.2;
    times.push(t); max.push(x[hot]! + setup.ambient);
    placed.forEach(({ at }, p) => { let b = 0; for (const { node, share } of at) b += x[node]! * share; parts[p]!.t.push(b + setup.ambient); });
    yield `${Math.round(t)} s`;
    if (x[hot]! >= finalRise * 0.99 || t > lump * 12) break;
  }
  /** When the hottest place passes a share of its final rise (between the two steps either side of it). */
  const when = (share: number): number => {
    const level = setup.ambient + finalRise * share;
    for (let k = 1; k < max.length; k++) if (max[k]! >= level) return times[k - 1]! + ((times[k]! - times[k - 1]!) * (level - max[k - 1]!)) / Math.max(max[k]! - max[k - 1]!, 1e-12);
    return NaN;
  };
  return { times, max, parts, lump, half: when(0.5), most: when(0.9) };
}

/** The warm-up in one go. */
export function warmUp(doc: PcbDocument, steady: ThermalResult): WarmUp {
  const g = warmUpSteps(doc, steady);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
