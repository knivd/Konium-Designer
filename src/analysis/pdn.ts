/**
 * A supply's impedance over frequency: what a load sees looking into its supply, from the
 * regulator's reach at the bottom, through the capacitors each in its own band, to the planes
 * themselves and their resonances at the top.
 *
 * The supply's copper on its largest layer and the ground copper facing it are a pair of plates:
 * under a grid, each cell is a capacitance between them (ε·area/gap, with the laminate's loss),
 * and neighbouring cells are joined by the plates' inductance, μ0·gap for each square, in series
 * with the copper's resistance at that frequency (skin depth). Each capacitor is its
 * capacitance, series resistance and series inductance from the supply to ground where its pad
 * is; the regulator a resistance and an inductance. At each frequency the admittance equations
 * are solved (analysis/cband.ts) for a current put in at each place looked from.
 *
 * A supply with no copper area, or none over ground, is taken as one node: its capacitors and
 * regulator alone.
 */

import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import { NO_NET, type PcbDocument } from '../model/pcb';
import { readStack } from '../model/pcbStack';
import { COPPER_SIGMA_20, METRE, stackCopper } from './copperNet';
import { Raster, layerCopper } from './raster';
import { CBand } from './cband';

const MU0 = 4e-7 * Math.PI, EPS0 = 8.8541878128e-12;

export interface PdnCap { component: number; designator: string; /** Farads, ohms, henries. */ c: number; esr: number; esl: number }

export interface PdnSetup {
  supply: number; ground: number;
  caps: PdnCap[];
  /** The regulator (or whatever feeds the net): its output resistance and inductance, at this component's pads. */
  source: { component: number; r: number; l: number } | null;
  /** The components to look from (their supply pins). */
  ports: number[];
  /** Hertz; points to each decade. */
  fMin: number; fMax: number; perDecade?: number;
  /** The laminate's loss tangent (0.02). */
  tanD?: number;
  /** About how many cells the planes are cut into (1 200). */
  cells?: number;
}

export interface PdnModel {
  /** The plates: null when the supply is taken as one node. */
  plates: { supplyLayer: number; groundLayer: number; gap: number; er: number; area: number; capacitance: number; cell: number } | null;
  count: number; band: number;
  /** Links between nodes (pairs), each one square of the plates. */
  links: Int32Array;
  /** Each node's capacitance to ground, farads. */
  c: Float64Array;
  /** Where each capacitor, the source and each port sit (node), in the set-up's order (−1: has no pad on the supply). */
  capNode: Int32Array; sourceNode: number; portNode: Int32Array;
  /** The copper's thickness on the two plates, metres. */
  tSupply: number; tGround: number;
  why: string;
}

/** A capacitance from a part's comment or value: "100nF", "0.1uF", "4u7", "10 µF 16V" (farads; NaN when it gives none). */
export function parseCapacitance(text: string): number {
  const mult: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3 };
  const a = /(\d+)([pnuµμ])(\d+)/i.exec(text);
  if (a) return parseFloat(`${a[1]}.${a[3]}`) * mult[a[2]!.toLowerCase()]!;
  const b = /(\d+(?:[.,]\d+)?)\s*([pnuµμm])F?(?![a-z])/i.exec(text);
  return b ? parseFloat(b[1]!.replace(',', '.')) * mult[b[2]!.toLowerCase()]! : NaN;
}
/** A ceramic capacitor's series resistance, about, for its capacitance (ohms): 30 mΩ at 100 nF, less for more. */
export const typicalEsr = (c: number): number => Math.min(1, Math.max(0.003, 0.03 * Math.sqrt(100e-9 / c)));
/** A mounted chip capacitor's series inductance, about (henries): its body and its vias. */
export const TYPICAL_ESL = 1e-9;

/** The capacitors between a supply and a ground: two-pad parts with a pad on each, their values from their comments. */
export function capsBetween(doc: PcbDocument, supply: number, ground: number): (PdnCap & { comment: string })[] {
  const pads = new Map<number, number[]>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.component !== NO_NET) (pads.get(p.component) ?? pads.set(p.component, []).get(p.component)!).push(p.net);
  const comment = new Map<number, string>();
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment) comment.set(p.component, p.text);
  const out: (PdnCap & { comment: string })[] = [];
  for (const [c, nets] of pads) {
    if (nets.length !== 2 || !nets.includes(supply) || !nets.includes(ground)) continue;
    const text = comment.get(c) ?? '', v = parseCapacitance(text), d = doc.components[c]?.designator ?? '';
    // Parts named as capacitors, or whose value reads as one
    if (!/^C\d/i.test(d) && Number.isNaN(v)) continue;
    out.push({ component: c, designator: d, comment: text, c: v, esr: Number.isNaN(v) ? NaN : typicalEsr(v), esl: TYPICAL_ESL });
  }
  return out.sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
}

/** The plates and where everything sits on them. */
export function buildPdn(doc: PcbDocument, setup: PdnSetup): PdnModel {
  const layers = doc.board.copperStack, nL = layers.length, stack = stackCopper(doc);
  const padAt = (component: number, net: number): Vec2 | null => { for (const p of doc.prims) if (p.kind === 'pad' && p.component === component && p.net === net) return p.at; return null; };
  const lumped = (why: string): PdnModel => {
    const at = (c: number) => (padAt(c, setup.supply) ? 0 : -1);
    return { plates: null, count: 1, band: 0, links: new Int32Array(0), c: new Float64Array(1), capNode: Int32Array.from(setup.caps.map((k) => at(k.component))), sourceNode: setup.source ? at(setup.source.component) : -1,
      portNode: Int32Array.from(setup.ports.map(at)), tSupply: 35e-6, tGround: 35e-6, why };
  };
  // The box of the supply's copper
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (p: Vec2) => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
  for (let li = 0; li < nL; li++) layerCopper(doc, layers[li]!, { net: setup.supply, tracks: 'pour' }, (rings) => { for (const r of rings) for (const p of r) see(p); });
  if (!(maxX > minX) || !(maxY > minY)) return lumped('The supply has no copper area: its capacitors and source alone are taken.');
  const g = Math.min(mil(200), Math.max(mil(20), Math.sqrt(((maxX - minX) * (maxY - minY)) / (setup.cells ?? 1200))));
  const W = Math.max(1, Math.ceil((maxX - minX) / g)), H = Math.max(1, Math.ceil((maxY - minY) / g));
  const ras = new Raster(minX, minY, g, W, H);
  const picture = (li: number, net: number) => { ras.clear(); layerCopper(doc, layers[li]!, { net, tracks: 'pour' }, (rings) => ras.fill(rings)); return ras.cells.slice(); };
  // The supply's layer: the one with most of its copper area
  let sl = -1, best = 0, supply: Uint8Array | null = null;
  for (let li = 0; li < nL; li++) { const pic = picture(li, setup.supply); let n = 0; for (const v of pic) n += v; if (n > best) { best = n; sl = li; supply = pic; } }
  if (!supply || best * g * g * METRE * METRE < 25e-6) return lumped('The supply has too little copper area to make a plate: its capacitors and source alone are taken.');
  // The ground facing it: the nearest layer whose ground copper lies under a third of it or more
  let gl = -1, ground: Uint8Array | null = null;
  for (let step = 1; step < nL && gl < 0; step++) for (const li of [sl - step, sl + step]) {
    if (li < 0 || li >= nL || gl >= 0) continue;
    const pic = picture(li, setup.ground);
    let n = 0;
    for (let c = 0; c < W * H; c++) n += supply[c]! & pic[c]!;
    if (n >= best / 3) { gl = li; ground = pic; }
  }
  if (!ground) return lumped('No ground copper faces the supply\'s copper: its capacitors and source alone are taken.');
  let gap = 0;
  for (let li = Math.min(sl, gl); li < Math.max(sl, gl); li++) gap += stack[li]!.toNext;
  gap = Math.max(gap - (stack[sl]!.thickness + stack[gl]!.thickness) / 2, 20e-6);
  const rows = doc.board.bag ? readStack(doc.board.bag, layers) : [], er = rows.find((r) => r.kind === 'dielectric' && r.dielConst > 1)?.dielConst ?? 4.3;
  // Nodes numbered across the shorter way, so that neighbours' numbers are close
  const node = new Int32Array(W * H).fill(-1), across = H <= W;
  let count = 0;
  if (across) { for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (supply[y * W + x]) node[y * W + x] = count++; }
  else for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (supply[y * W + x]) node[y * W + x] = count++;
  const links: number[] = [], c = new Float64Array(count), cell = (g * METRE) ** 2, each = (EPS0 * er * cell) / gap;
  let band = 0, facing = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = node[y * W + x]!;
    if (a < 0) continue;
    if (ground[y * W + x]) { c[a] = each; facing++; }
    for (const b of [x + 1 < W ? node[y * W + x + 1]! : -1, y + 1 < H ? node[(y + 1) * W + x]! : -1]) if (b >= 0) { links.push(a, b); band = Math.max(band, Math.abs(a - b)); }
  }
  /** The node nearest a place (within a few cells of it, else the nearest of all). */
  const nearest = (at: Vec2 | null): number => {
    if (!at) return -1;
    const cx = Math.floor((at.x - minX) / g), cy = Math.floor((at.y - minY) / g);
    let bestN = -1, bd = Infinity;
    for (let r = 0; r <= Math.max(W, H) && bestN < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || node[y * W + x]! < 0) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bestN = node[y * W + x]!; }
    }
    return bestN;
  };
  return {
    plates: { supplyLayer: sl, groundLayer: gl, gap, er, area: best * cell, capacitance: facing * each, cell: g },
    count, band, links: Int32Array.from(links), c,
    capNode: Int32Array.from(setup.caps.map((k) => nearest(padAt(k.component, setup.supply)))),
    sourceNode: setup.source ? nearest(padAt(setup.source.component, setup.supply)) : -1,
    portNode: Int32Array.from(setup.ports.map((p) => nearest(padAt(p, setup.supply)))),
    tSupply: stack[sl]!.thickness, tGround: stack[gl]!.thickness, why: '',
  };
}

export interface PdnPeak { f: number; z: number }
export interface PdnResult {
  setup: PdnSetup; model: PdnModel;
  f: Float64Array;
  /** For each port: |Z| in ohms at each frequency, and its phase in degrees. */
  ports: { component: number; designator: string; z: Float64Array; phase: Float64Array; /** Its peaks, the highest first. */ peaks: PdnPeak[] }[];
  /** The plates' first resonance, about (the half wave along their longer side), hertz; NaN with no plates. */
  firstMode: number;
}

/** The equations at a frequency: the plates, the capacitors, and the source (or `sourceY`, an admittance in its place). */
function fill(m: PdnModel, setup: PdnSetup, f: number, a: CBand, source?: [number, number]): void {
  const w = 2 * Math.PI * f, tanD = setup.tanD ?? 0.02;
  a.clear();
  if (m.plates) {
    // One square of the two plates: their inductance, and the copper's resistance down to a skin depth
    const skin = Math.sqrt(2 / (w * MU0 * COPPER_SIGMA_20)), rs = 1 / (COPPER_SIGMA_20 * Math.min(m.tSupply, skin)) + 1 / (COPPER_SIGMA_20 * Math.min(m.tGround, skin));
    const xl = w * MU0 * m.plates.gap, mag = rs * rs + xl * xl, yr = rs / mag, yi = -xl / mag;
    for (let k = 0; k < m.links.length; k += 2) a.admittance(m.links[k]!, m.links[k + 1]!, yr, yi);
  }
  for (let i = 0; i < m.count; i++) a.admittance(i, -1, w * m.c[i]! * tanD + 1e-12, w * m.c[i]!);
  const series = (nodeAt: number, r: number, l: number, c: number) => {
    if (nodeAt < 0) return;
    const x = w * l - (c > 0 ? 1 / (w * c) : 0), mag = r * r + x * x;
    if (mag > 0) a.admittance(nodeAt, -1, r / mag, -x / mag);
  };
  setup.caps.forEach((k, i) => { if (k.c > 0 && Number.isFinite(k.c)) series(m.capNode[i]!, Math.max(k.esr, 1e-4), k.esl, k.c); });
  if (source) { if (m.sourceNode >= 0) a.admittance(m.sourceNode, -1, source[0], source[1]); }
  else if (setup.source) series(m.sourceNode, Math.max(setup.source.r, 1e-5), setup.source.l, 0);
}

export function frequencies(fMin: number, fMax: number, perDecade = 30): Float64Array {
  const lo = Math.max(fMin, 1), n = Math.max(2, Math.round(Math.log10(Math.max(fMax, lo * 1.01) / lo) * perDecade) + 1);
  return Float64Array.from({ length: n }, (_, k) => lo * (Math.max(fMax, lo * 1.01) / lo) ** (k / (n - 1)));
}

/** The impedance sweep, a frequency at a time (each value given is how far it has got, 0 to 1). */
export function* pdnSteps(doc: PcbDocument, setup: PdnSetup, model?: PdnModel): Generator<number, PdnResult, void> {
  const m = model ?? buildPdn(doc, setup), f = frequencies(setup.fMin, setup.fMax, setup.perDecade);
  const a = new CBand(m.count, m.band), re = new Float64Array(m.count), im = new Float64Array(m.count);
  const ports = setup.ports.map((component, k) => ({ component, designator: doc.components[component]?.designator ?? String(component), node: m.portNode[k]!, z: new Float64Array(f.length).fill(NaN), phase: new Float64Array(f.length).fill(NaN), peaks: [] as PdnPeak[] }));
  for (let k = 0; k < f.length; k++) {
    fill(m, setup, f[k]!, a);
    if (a.factor()) for (const p of ports) {
      if (p.node < 0) continue;
      re.fill(0); im.fill(0); re[p.node] = 1;
      a.solve(re, im);
      p.z[k] = Math.hypot(re[p.node]!, im[p.node]!); p.phase[k] = (Math.atan2(im[p.node]!, re[p.node]!) * 180) / Math.PI;
    }
    yield (k + 1) / f.length;
  }
  for (const p of ports) {
    for (let k = 1; k + 1 < f.length; k++) if (p.z[k]! > p.z[k - 1]! && p.z[k]! >= p.z[k + 1]!) p.peaks.push({ f: f[k]!, z: p.z[k]! });
    p.peaks.sort((x, y) => y.z - x.z);
  }
  // The half wave along the plates' longer side
  const side = m.plates ? Math.sqrt(m.plates.area) : NaN;
  return { setup, model: m, f, ports: ports.map((p) => ({ component: p.component, designator: p.designator, z: p.z, phase: p.phase, peaks: p.peaks })), firstMode: m.plates ? 299_792_458 / (2 * side * Math.sqrt(m.plates.er)) : NaN };
}

export function analysePdn(doc: PcbDocument, setup: PdnSetup, model?: PdnModel): PdnResult {
  const g = pdnSteps(doc, setup, model);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The impedance a supply must stay under: the ripple allowed (a share of its voltage) over the step of current. */
export const targetImpedance = (voltage: number, ripple: number, step: number): number => (Math.abs(voltage) * ripple) / Math.max(step, 1e-9);

/** Where a port's impedance is over a target: the bands (from, to, worst), lowest first. */
export function overTarget(r: PdnResult, port: number, target: number): { from: number; to: number; worst: PdnPeak }[] {
  const out: { from: number; to: number; worst: PdnPeak }[] = [], z = r.ports[port]!.z;
  let open: { from: number; to: number; worst: PdnPeak } | null = null;
  for (let k = 0; k < r.f.length; k++) {
    if (z[k]! > target) { if (!open) { open = { from: r.f[k]!, to: r.f[k]!, worst: { f: r.f[k]!, z: z[k]! } }; out.push(open); } open.to = r.f[k]!; if (z[k]! > open.worst.z) open.worst = { f: r.f[k]!, z: z[k]! }; }
    else open = null;
  }
  return out;
}

// ── Conducted emission, differential mode ───────────────────────────────────────────────

export interface NoiseSetup {
  /** The switching part: its supply pin is where the noise current is drawn. */
  component: number;
  /** Switching frequency (Hz), the pulsed current's height (A), its duty (0 to 1), its edges' rise time (s). */
  frequency: number; amplitude: number; duty: number; rise: number;
}
export interface ConductedResult {
  /** Each harmonic from 150 kHz to 30 MHz: its frequency, the level at the measuring network (dBµV), and the limits there. */
  f: number[]; level: number[]; classA: number[]; classB: number[];
  /** The least margin under the Class B limit, dB (negative: over it), and where. */
  margin: number; marginAt: number;
}

/** The quasi-peak limits for conducted emission at mains ports (CISPR 11 group 1 and CISPR 32), dBµV: Class A, and Class B (which falls with the logarithm of frequency from 66 at 150 kHz to 56 at 500 kHz). */
export function cisprLimit(f: number, cls: 'A' | 'B'): number {
  if (cls === 'A') return f < 0.5e6 ? 79 : 73;
  if (f < 0.5e6) return 66 - (10 * Math.log10(f / 0.15e6)) / Math.log10(0.5 / 0.15);
  return f < 5e6 ? 56 : 60;
}

/** The nth harmonic's peak of a train of pulses: height, duty, rise (and fall) time, at frequency f0. */
export function pulseHarmonic(n: number, amplitude: number, duty: number, rise: number, f0: number): number {
  const sinc = (x: number) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  return 2 * amplitude * duty * Math.abs(sinc(n * duty)) * Math.abs(sinc(n * f0 * rise));
}

/**
 * Differential-mode conducted emission, estimated: the switching part's pulsed current drawn
 * from the supply, through the capacitors and planes, to a measuring network (LISN) in place of
 * the source: 50 Ω beside 50 µH in each line, the two in series across the supply. Each harmonic's
 * level is its peak made rms. Common-mode noise, which depends on the wiring and the case, is
 * not in it.
 */
export function conducted(doc: PcbDocument, setup: PdnSetup, noise: NoiseSetup, model?: PdnModel): ConductedResult | null {
  // The plates with the switching part among the places looked from
  const known = !!model && setup.ports.includes(noise.component), ports = known ? setup.ports : [noise.component];
  const m = known ? model! : buildPdn(doc, { ...setup, ports }), at = m.portNode[ports.indexOf(noise.component)]!;
  if (at < 0 || m.sourceNode < 0 || !(noise.frequency > 0)) return null;
  const a = new CBand(m.count, m.band), re = new Float64Array(m.count), im = new Float64Array(m.count);
  const out: ConductedResult = { f: [], level: [], classA: [], classB: [], margin: Infinity, marginAt: NaN };
  for (let n = Math.max(1, Math.ceil(150e3 / noise.frequency)); n * noise.frequency <= 30e6 && out.f.length < 400; n++) {
    const f = n * noise.frequency, w = 2 * Math.PI * f;
    // Two networks in series, each 50 Ω beside 50 µH: twice 50·jωL / (50 + jωL), as an admittance
    const xl = w * 50e-6, d = 50 * 50 + xl * xl, zr = (2 * 50 * xl * xl) / d, zi = (2 * 50 * 50 * xl) / d, zm = zr * zr + zi * zi;
    fill(m, setup, f, a, [zr / zm, -zi / zm]);
    if (!a.factor()) continue;
    re.fill(0); im.fill(0); re[at] = 1;
    a.solve(re, im);
    // Half of what stands across the two networks is across each; peak to rms
    const v = (Math.hypot(re[m.sourceNode]!, im[m.sourceNode]!) * pulseHarmonic(n, noise.amplitude, noise.duty, noise.rise, noise.frequency)) / 2 / Math.SQRT2;
    const level = 20 * Math.log10(Math.max(v, 1e-12) / 1e-6), b = cisprLimit(f, 'B');
    out.f.push(f); out.level.push(level); out.classA.push(cisprLimit(f, 'A')); out.classB.push(b);
    if (b - level < out.margin) { out.margin = b - level; out.marginAt = f; }
  }
  return out.f.length ? out : null;
}
