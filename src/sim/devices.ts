/**
 * The devices a circuit is made of, each stamping its linearised self into the matrix:
 * resistors, capacitors, inductors (and their coupling), independent sources (DC, AC, SIN,
 * PULSE, PWL, EXP, SFFM), the four controlled sources, behavioural sources, switches, and the
 * semiconductors — diodes (SPICE level 1 with breakdown and junction and transit-time charge),
 * bipolar transistors (Gummel–Poon), MOSFETs (level 1, Shichman–Hodges with Meyer capacitances)
 * and JFETs. Model parameter names and defaults are SPICE's.
 */
import { CHARGE, BOLTZ, Ctx, State, depletion, fetlim, limvds, pnjlim } from './ctx';
import { compileExpr, exprProbes, type ExprAt } from './expr';
import type { Element, ModelCard, SourceSpec } from './netlist';

export interface Alloc {
  /** A circuit node ('0' is ground: −1). */
  node(name: string): number;
  /** A node inside a device (series resistances). */
  internal(owner: string, name: string): number;
  /** A branch current unknown. */
  branch(owner: string): number;
  /** The branch of a voltage source or inductor by name (for F, H, W, K and I()); −1 if none. */
  branchOf(name: string): number;
  /** The device of a name (for K). */
  device(name: string): Device | undefined;
}

/** The small-signal (AC) system: G + jωC. */
export class AcCtx {
  n = 0;
  gr = new Float64Array(0); gi = new Float64Array(0); br = new Float64Array(0); bi = new Float64Array(0);
  omega = 0;
  /** The positions ever stamped (the solver's pattern). */
  pat: number[] = [];
  patVersion = 0;
  private mark = new Uint8Array(0);
  get re(): Float64Array { return this.gr; }
  get im(): Float64Array { return this.gi; }
  size(n: number): void {
    this.n = n; this.gr = new Float64Array(n * n); this.gi = new Float64Array(n * n); this.br = new Float64Array(n); this.bi = new Float64Array(n);
    this.mark = new Uint8Array(n * n); this.pat = []; this.patVersion++;
  }
  clear(): void {
    if (this.pat.length * 8 < this.gr.length) for (const f of this.pat) { this.gr[f] = 0; this.gi[f] = 0; } else { this.gr.fill(0); this.gi.fill(0); }
    this.br.fill(0); this.bi.fill(0);
  }
  add(i: number, j: number, re: number, im = 0): void {
    if (i < 0 || j < 0) return;
    const f = i * this.n + j;
    if (!this.mark[f]) { this.mark[f] = 1; this.pat.push(f); this.patVersion++; }
    this.gr[f] += re; this.gi[f] += im;
  }
  g(a: number, b: number, re: number, im = 0): void { this.add(a, a, re, im); this.add(b, b, re, im); this.add(a, b, -re, -im); this.add(b, a, -re, -im); }
  /** A capacitance between two nodes: admittance jωC. */
  c(a: number, b: number, c: number): void { if (c) this.g(a, b, 0, this.omega * c); }
  vccs(a: number, b: number, cp: number, cn: number, g: number): void { if (!g) return; this.add(a, cp, g); this.add(a, cn, -g); this.add(b, cp, -g); this.add(b, cn, g); }
  rhs(i: number, re: number, im = 0): void { if (i >= 0) { this.br[i] += re; this.bi[i] += im; } }
}

export interface Device {
  name: string;
  /** R, C, D, Q … */
  kind: string;
  setup(a: Alloc): void;
  load(c: Ctx): void;
  /** Charges and fluxes (integrated in time, their history kept). */
  states: State[];
  /** At the operating point (or the initial conditions): the states start there. */
  initStates?(c: Ctx): void;
  ac?(a: AcCtx): void;
  breaks?(tstop: number, tstep: number): number[];
  /** The first corner of its value after time t (a run with no end steps onto it). */
  nextBreak?(t: number): number;
  /** Currents and powers to record: [suffix, value] (R1[i], Q1[ic] …). */
  probe?(c: Ctx): [string, number][];
  /** Initial-condition values given on the device (IC=). */
  ic?: number;
  /** A time point was accepted (switch states, Meyer charges' reference voltages). */
  accepted?(): void;
  /** (A live run) With the equations solved: a discrete state changed by the solution (a switch), so that they are to be solved again. */
  settle?(c: Ctx): boolean;
  /** (A live run) The step just tried is not taken: a state changed in trying it goes back to what it was. */
  rejected?(): void;
  /** (A live run) With the step solved and not yet taken: whether a discrete state stands otherwise than at the last time point (a switch turned over in the step). */
  changed?(): boolean;
  /** (A live run) Of a state that changed in the step just solved: how far through the step it did (0 to 1; NaN: not known). */
  turnedAt?(): number;
  /** Noise analysis: the device's noise currents at the operating point, at frequency f. */
  noise?(c: Ctx, f: number): NoiseSrc[];
}

/** A noise current between two nodes: its power spectral density (A²/Hz) and what makes it. */
export interface NoiseSrc { what: string; a: number; b: number; psd: number }
const fourKT = (c: Ctx) => 4 * BOLTZ * c.tempK;
/** Oxide capacitance per area when the model gives no TOX (SPICE's 100 nm). */
const COX_DEFAULT = (3.9 * 8.854214871e-12) / 1e-7;

const P = (m: ModelCard | undefined, k: string, d: number): number => { const v = m?.params[k]; return v === undefined || Number.isNaN(v) ? d : v; };

/* ─── Passive ────────────────────────────────────────────────────────────────────── */

export class Resistor implements Device {
  kind = 'R'; states: State[] = [];
  a = -1; b = -1; g = 0;
  constructor(readonly name: string, private el: Element, private m?: ModelCard) {}
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    let r = this.el.value ?? NaN;
    if (Number.isNaN(r) && this.m) {
      const l = this.el.params.l ?? P(this.m, 'l', 0), w = this.el.params.w ?? P(this.m, 'w', 1e-6), rsh = P(this.m, 'rsh', 0);
      r = rsh * (l - P(this.m, 'narrow', 0)) / (w - P(this.m, 'narrow', 0)) || P(this.m, 'r', 1e3);
    }
    const dt = (this.el.params.temp ?? 27) - 27;
    const tc1 = this.el.params.tc1 ?? P(this.m, 'tc1', 0), tc2 = this.el.params.tc2 ?? P(this.m, 'tc2', 0);
    r *= 1 + tc1 * dt + tc2 * dt * dt;
    if (this.el.params.m) r /= this.el.params.m;
    this.g = 1 / (Math.abs(r) < 1e-12 ? 1e-12 : r);
  }
  load(c: Ctx): void { c.g(this.a, this.b, this.g); }
  ac(a: AcCtx): void { a.g(this.a, this.b, this.g); }
  probe(c: Ctx): [string, number][] { const v = c.v(this.a) - c.v(this.b), i = v * this.g; return [['i', i], ['p', v * i]]; }
  noise(c: Ctx): NoiseSrc[] { return this.el.flags.includes('NOISELESS') ? [] : [{ what: 'thermal', a: this.a, b: this.b, psd: fourKT(c) * Math.abs(this.g) }]; }
}

export class Capacitor implements Device {
  kind = 'C';
  a = -1; b = -1; cap = 0; s = new State(); states = [this.s];
  ic?: number;
  constructor(readonly name: string, private el: Element, private m?: ModelCard) { this.ic = el.params.ic; }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    let c = this.el.value ?? NaN;
    if (Number.isNaN(c) && this.m) {
      const l = this.el.params.l ?? 0, w = this.el.params.w ?? P(this.m, 'defw', 1e-6);
      c = P(this.m, 'cj', 0) * l * w + 2 * P(this.m, 'cjsw', 0) * (l + w) || P(this.m, 'c', 0);
    }
    this.cap = c * (this.el.params.m ?? 1);
  }
  initStates(c: Ctx): void {
    const v = c.uic && this.ic !== undefined ? this.ic : c.v(this.a) - c.v(this.b);
    this.s.reset(this.cap * v);
  }
  load(c: Ctx): void {
    if (c.mode !== 'tran') return;
    const v = c.v(this.a) - c.v(this.b);
    const i = this.s.integrate(c, this.cap * v);
    const geq = this.cap * c.a0;
    c.g(this.a, this.b, geq);
    c.i(this.a, this.b, i - geq * v);
  }
  ac(a: AcCtx): void { a.c(this.a, this.b, this.cap); }
  probe(c: Ctx): [string, number][] { const i = c.mode === 'tran' ? this.s.d[0]! : 0; return [['i', i], ['p', (c.v(this.a) - c.v(this.b)) * i]]; }
}

export class Inductor implements Device {
  kind = 'L';
  a = -1; b = -1; k = -1; ind = 0; s = new State(); states = [this.s];
  /** Mutual inductances to other inductors (K). */
  mutual: { other: Inductor; m: number }[] = [];
  ic?: number;
  constructor(readonly name: string, private el: Element) { this.ic = el.params.ic; }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    this.k = al.branch(this.name);
    this.ind = (this.el.value ?? 0) / (this.el.params.m ?? 1);
  }
  flux(c: Ctx): number { return this.ind * c.v(this.k) + this.mutual.reduce((s, { other, m }) => s + m * c.v(other.k), 0); }
  initStates(c: Ctx): void {
    if (c.uic && this.ic !== undefined) c.x[this.k] = this.ic;
    this.s.reset(this.flux(c));
  }
  load(c: Ctx): void {
    c.add(this.a, this.k, 1); c.add(this.b, this.k, -1);
    c.add(this.k, this.a, 1); c.add(this.k, this.b, -1);
    if (c.mode !== 'tran') return;
    const phi = this.flux(c);
    const vl = this.s.integrate(c, phi);
    c.add(this.k, this.k, -c.a0 * this.ind);
    for (const { other, m } of this.mutual) c.add(this.k, other.k, -c.a0 * m);
    c.rhs(this.k, vl - c.a0 * phi);
  }
  ac(a: AcCtx): void {
    a.add(this.a, this.k, 1); a.add(this.b, this.k, -1); a.add(this.k, this.a, 1); a.add(this.k, this.b, -1);
    a.add(this.k, this.k, 0, -a.omega * this.ind);
    for (const { other, m } of this.mutual) a.add(this.k, other.k, 0, -a.omega * m);
  }
  probe(c: Ctx): [string, number][] { const i = c.v(this.k); return [['i', i], ['p', (c.v(this.a) - c.v(this.b)) * i]]; }
}

/** K: couples two inductors (M = k·√(L1·L2)); does nothing of its own. */
export class Coupling implements Device {
  kind = 'K'; states: State[] = [];
  constructor(readonly name: string, private el: Element) {}
  setup(al: Alloc): void {
    const [n1, n2] = this.el.ctrl ?? [];
    const l1 = al.device(n1 ?? ''), l2 = al.device(n2 ?? '');
    if (!(l1 instanceof Inductor) || !(l2 instanceof Inductor)) throw new Error(`${this.name}: couples ${n1} and ${n2}, which aren't both inductors`);
    const m = (this.el.value ?? 0) * Math.sqrt(l1.ind * l2.ind);
    l1.mutual.push({ other: l2, m }); l2.mutual.push({ other: l1, m });
  }
  load(): void { /* the inductors stamp it */ }
}

/* ─── Sources ────────────────────────────────────────────────────────────────────── */

/** Advanced Options' RAMPTIME: the sources brought up from zero over the start of a transient. */
const ramp = (c: Ctx) => (c.tol.ramptime > 0 && c.time < c.tol.ramptime ? c.time / c.tol.ramptime : 1);

/** A source's value at a time (transient), or its DC value. */
export function sourceValue(s: SourceSpec, t: number | null, tstep: number, tstop: number): number {
  const f = s.fn;
  if (t === null || !f) return s.dcGiven || !f ? s.dc : sourceValue(s, 0, tstep, tstop);
  const a = f.args;
  const arg = (i: number, d: number) => (a[i] === undefined || Number.isNaN(a[i]!) ? d : a[i]!);
  switch (f.kind) {
    case 'SIN': {
      const vo = arg(0, 0), va = arg(1, 0), fr = arg(2, 1 / tstop), td = arg(3, 0), th = arg(4, 0), ph = (arg(5, 0) * Math.PI) / 180;
      if (t <= td) return vo + va * Math.sin(ph);
      return vo + va * Math.exp(-(t - td) * th) * Math.sin(2 * Math.PI * fr * (t - td) + ph);
    }
    case 'PULSE': {
      const v1 = arg(0, 0), v2 = arg(1, 0), td = arg(2, 0), tr = arg(3, tstep) || tstep, tf = arg(4, tstep) || tstep, pw = arg(5, tstop), per = arg(6, tstop) || Infinity;
      if (t < td) return v1;
      let tt = t - td;
      if (Number.isFinite(per) && per > 0) tt %= per;
      if (tt < tr) return v1 + ((v2 - v1) * tt) / tr;
      if (tt < tr + pw) return v2;
      if (tt < tr + pw + tf) return v2 + ((v1 - v2) * (tt - tr - pw)) / tf;
      return v1;
    }
    case 'PWL': {
      if (a.length < 2) return a[0] ?? 0;
      if (t <= a[0]!) return a[1]!;
      for (let i = 2; i + 1 < a.length; i += 2) {
        if (t <= a[i]!) { const t0 = a[i - 2]!, v0 = a[i - 1]!, t1 = a[i]!, v1 = a[i + 1]!; return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
      }
      return a[a.length - 1]!;
    }
    case 'EXP': {
      const v1 = arg(0, 0), v2 = arg(1, 0), td1 = arg(2, 0), tau1 = arg(3, tstep), td2 = arg(4, td1 + tstep), tau2 = arg(5, tstep);
      if (t <= td1) return v1;
      if (t <= td2) return v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
      return v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1)) + (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2));
    }
    case 'SFFM': {
      const vo = arg(0, 0), va = arg(1, 0), fc = arg(2, 1 / tstop), mdi = arg(3, 0), fs = arg(4, 1 / tstop);
      return vo + va * Math.sin(2 * Math.PI * fc * t + mdi * Math.sin(2 * Math.PI * fs * t));
    }
    case 'AM': {
      const sa = arg(0, 0), oc = arg(1, 0), fm = arg(2, 1 / tstop), fc = arg(3, 1 / tstop), td = arg(4, 0);
      if (t <= td) return 0;
      return sa * (oc + Math.sin(2 * Math.PI * fm * (t - td))) * Math.sin(2 * Math.PI * fc * (t - td));
    }
  }
}

/** Where a source's value turns a corner (the transient steps onto them). */
export function sourceBreaks(s: SourceSpec, tstop: number, tstep: number): number[] {
  const f = s.fn;
  if (!f) return [];
  const a = f.args, out: number[] = [];
  if (f.kind === 'PULSE') {
    const td = a[2] ?? 0, tr = a[3] || tstep, tf = a[4] || tstep, pw = a[5] ?? tstop, per = a[6] || Infinity;
    for (let k = 0, base = td; base < tstop && k < 100000; k++, base += per) {
      out.push(base, base + tr, base + tr + pw, base + tr + pw + tf);
      if (!Number.isFinite(per)) break;
    }
  } else if (f.kind === 'PWL') for (let i = 0; i < a.length; i += 2) out.push(a[i]!);
  else if (f.kind === 'EXP') out.push(a[2] ?? 0, a[4] ?? (a[2] ?? 0) + tstep);
  else if (f.kind === 'SIN' && a[3]) out.push(a[3]);
  return out.filter((t) => t > 0 && t < tstop);
}

/** A source's first corner after time t (Infinity: none): a run with no end (Live Simulation) steps onto each as it comes. */
export function nextSourceBreak(s: SourceSpec, t: number, tstep: number): number {
  const f = s.fn;
  if (!f) return Infinity;
  const a = f.args, eps = 1e-15 + Math.abs(t) * 1e-12;
  const after = (xs: number[]) => { let m = Infinity; for (const x of xs) if (x > t + eps && x < m) m = x; return m; };
  if (f.kind === 'PULSE') {
    const td = a[2] ?? 0, tr = a[3] || tstep, tf = a[4] || tstep, pw = a[5] ?? Infinity, per = a[6] || Infinity;
    const corners = (base: number) => [base, base + tr, base + tr + pw, base + tr + pw + tf].filter(Number.isFinite);
    if (!Number.isFinite(per)) return after(corners(td));
    const k = Math.max(0, Math.floor((t - td) / per));
    return after([...corners(td + k * per), ...corners(td + (k + 1) * per)]);
  }
  if (f.kind === 'PWL') return after(a.filter((_, i) => i % 2 === 0));
  if (f.kind === 'EXP') return after([a[2] ?? 0, a[4] ?? (a[2] ?? 0) + tstep]);
  if (f.kind === 'SIN') return after([a[3] ?? 0]);
  if (f.kind === 'AM') return after([a[4] ?? 0]);
  return Infinity;
}

export class VSource implements Device {
  kind = 'V'; states: State[] = [];
  a = -1; b = -1; k = -1;
  tstep = 1; tstop = 1;
  constructor(readonly name: string, readonly el: Element) {}
  setup(al: Alloc): void { this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!); this.k = al.branch(this.name); }
  value(c: Ctx): number { return sourceValue(this.el.src!, c.mode === 'tran' ? c.time : null, this.tstep, this.tstop) * (c.mode === 'tran' ? ramp(c) : c.srcFactor); }
  load(c: Ctx): void {
    c.add(this.a, this.k, 1); c.add(this.b, this.k, -1);
    c.add(this.k, this.a, 1); c.add(this.k, this.b, -1);
    c.rhs(this.k, this.value(c));
  }
  ac(a: AcCtx): void {
    a.add(this.a, this.k, 1); a.add(this.b, this.k, -1); a.add(this.k, this.a, 1); a.add(this.k, this.b, -1);
    const s = this.el.src!, ph = (s.acPhase * Math.PI) / 180;
    a.rhs(this.k, s.acMag * Math.cos(ph), s.acMag * Math.sin(ph));
  }
  breaks(tstop: number, tstep: number): number[] { return sourceBreaks(this.el.src!, tstop, tstep); }
  nextBreak(t: number): number { return nextSourceBreak(this.el.src!, t, this.tstep); }
  probe(c: Ctx): [string, number][] { const i = c.v(this.k); return [['p', -(c.v(this.a) - c.v(this.b)) * i]]; }
}

export class ISource implements Device {
  kind = 'I'; states: State[] = [];
  a = -1; b = -1; tstep = 1; tstop = 1;
  constructor(readonly name: string, readonly el: Element) {}
  setup(al: Alloc): void { this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!); }
  value(c: Ctx): number { return sourceValue(this.el.src!, c.mode === 'tran' ? c.time : null, this.tstep, this.tstop) * (c.mode === 'tran' ? ramp(c) : c.srcFactor); }
  load(c: Ctx): void { c.i(this.a, this.b, this.value(c)); }
  ac(a: AcCtx): void {
    const s = this.el.src!, ph = (s.acPhase * Math.PI) / 180;
    a.rhs(this.a, -s.acMag * Math.cos(ph), -s.acMag * Math.sin(ph)); a.rhs(this.b, s.acMag * Math.cos(ph), s.acMag * Math.sin(ph));
  }
  breaks(tstop: number, tstep: number): number[] { return sourceBreaks(this.el.src!, tstop, tstep); }
  nextBreak(t: number): number { return nextSourceBreak(this.el.src!, t, this.tstep); }
  probe(c: Ctx): [string, number][] { const i = this.value(c); return [['i', i], ['p', (c.v(this.a) - c.v(this.b)) * i]]; }
}

/** E (voltage-controlled voltage) and H (current-controlled voltage). */
export class VControlled implements Device {
  kind: string; states: State[] = [];
  a = -1; b = -1; cp = -1; cn = -1; kc = -1; k = -1;
  constructor(readonly name: string, readonly el: Element) { this.kind = el.kind; }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    if (this.el.kind === 'E') { this.cp = al.node(this.el.nodes[2]!); this.cn = al.node(this.el.nodes[3]!); }
    else { this.kc = al.branchOf(this.el.ctrl![0]!); if (this.kc < 0) throw new Error(`${this.name}: controlling source ${this.el.ctrl![0]} not found`); }
    this.k = al.branch(this.name);
  }
  stamp(add: (i: number, j: number, v: number) => void): void {
    const g = this.el.value ?? 0;
    add(this.a, this.k, 1); add(this.b, this.k, -1); add(this.k, this.a, 1); add(this.k, this.b, -1);
    if (this.el.kind === 'E') { add(this.k, this.cp, -g); add(this.k, this.cn, g); } else add(this.k, this.kc, -g);
  }
  load(c: Ctx): void { this.stamp((i, j, v) => c.add(i, j, v)); }
  ac(a: AcCtx): void { this.stamp((i, j, v) => a.add(i, j, v)); }
}

/** G (voltage-controlled current) and F (current-controlled current). */
export class IControlled implements Device {
  kind: string; states: State[] = [];
  a = -1; b = -1; cp = -1; cn = -1; kc = -1;
  constructor(readonly name: string, readonly el: Element) { this.kind = el.kind; }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    if (this.el.kind === 'G') { this.cp = al.node(this.el.nodes[2]!); this.cn = al.node(this.el.nodes[3]!); }
    else { this.kc = al.branchOf(this.el.ctrl![0]!); if (this.kc < 0) throw new Error(`${this.name}: controlling source ${this.el.ctrl![0]} not found`); }
  }
  load(c: Ctx): void {
    const g = this.el.value ?? 0;
    if (this.el.kind === 'G') c.vccs(this.a, this.b, this.cp, this.cn, g);
    else { c.add(this.a, this.kc, g); c.add(this.b, this.kc, -g); }
  }
  ac(a: AcCtx): void {
    const g = this.el.value ?? 0;
    if (this.el.kind === 'G') a.vccs(this.a, this.b, this.cp, this.cn, g);
    else { a.add(this.a, this.kc, g); a.add(this.b, this.kc, -g); }
  }
}

/** B: a voltage or current given by an expression of node voltages, source currents and time. */
export class Behavioural implements Device {
  kind = 'B'; states: State[] = [];
  a = -1; b = -1; k = -1;
  vs: [number, number][] = []; is: number[] = [];
  /** Linearisation at the operating point: d/dV per probe, d/dI per probe. */
  dv: number[] = []; di: number[] = [];
  private nodeIdx = new Map<string, number>();
  private brIdx = new Map<string, number>();
  /** The expression as a function of the unknowns (made once: it is asked many times a step), where it reads from, and the unknowns it reads: voltages, then currents. */
  private fn: (at: ExprAt) => number = () => 0;
  private at: ExprAt = { x: [], time: 0, temper: 0 };
  private unknowns: number[] = [];
  private brs: number[] = [];
  constructor(readonly name: string, readonly el: Element) {}
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    const pr = exprProbes(this.el.expr!);
    for (const [p, n] of pr.v) { this.nodeIdx.set(p.toLowerCase(), al.node(p)); if (n) this.nodeIdx.set(n.toLowerCase(), al.node(n)); }
    for (const n of pr.i) { const k = al.branchOf(n); if (k < 0) throw new Error(`${this.name}: I(${n}): no such source`); this.brIdx.set(n.toLowerCase(), k); }
    if (this.el.exprKind === 'V') this.k = al.branch(this.name);
    this.fn = compileExpr(this.el.expr!, { node: (n) => this.nodeIdx.get(n.toLowerCase()) ?? -1, branch: (n) => this.brIdx.get(n.toLowerCase()) ?? -1 });
    this.unknowns = [...new Set([...this.nodeIdx.values()].filter((i) => i >= 0))];
    this.brs = [...new Set(this.brIdx.values())];
  }
  load(c: Ctx): void {
    const at = this.at, fn = this.fn, x = c.x;
    at.x = x; at.time = c.mode === 'tran' ? c.time : 0; at.temper = c.tempK - 273.15;
    const f0 = fn(at);
    // Its slope along each unknown it reads: the unknown moved a little either way, where it stands in the vector, and put back
    const derivs: [number, number][] = [];
    const slope = (u: number, rel: number) => {
      const x0 = x[u]!, h = rel * Math.max(1, Math.abs(x0));
      x[u] = x0 + h; const up = fn(at);
      x[u] = x0 + -h; const down = fn(at);
      x[u] = x0;
      derivs.push([u, (up - down) / (2 * h)]);
    };
    for (const u of this.unknowns) slope(u, 1e-6);
    for (const u of this.brs) slope(u, 1e-9);
    this.dv = derivs.map((d) => d[1]); this.di = derivs.map((d) => d[0]);
    let rest = Number.isFinite(f0) ? f0 : 0;
    for (const [u, d] of derivs) rest -= d * c.x[u]!;
    if (this.el.exprKind === 'V') {
      c.add(this.a, this.k, 1); c.add(this.b, this.k, -1); c.add(this.k, this.a, 1); c.add(this.k, this.b, -1);
      for (const [u, d] of derivs) c.add(this.k, u, -d);
      c.rhs(this.k, rest);
    } else {
      for (const [u, d] of derivs) { c.add(this.a, u, d); c.add(this.b, u, -d); }
      c.i(this.a, this.b, rest);
    }
  }
  ac(a: AcCtx): void {
    if (this.el.exprKind === 'V') {
      a.add(this.a, this.k, 1); a.add(this.b, this.k, -1); a.add(this.k, this.a, 1); a.add(this.k, this.b, -1);
      this.di.forEach((u, i) => a.add(this.k, u, -this.dv[i]!));
    } else this.di.forEach((u, i) => { a.add(this.a, u, this.dv[i]!); a.add(this.b, u, -this.dv[i]!); });
  }
}

/** S (voltage-controlled) and W (current-controlled) switches: RON or ROFF, with hysteresis. */
export class Switch implements Device {
  kind: string; states: State[] = [];
  a = -1; b = -1; cp = -1; cn = -1; kc = -1;
  on = false; was = false;
  /** The time point being solved, and how often the switch has changed in its iterations. */
  private at = NaN; private flips = 0;
  constructor(readonly name: string, readonly el: Element, private m?: ModelCard) { this.kind = el.kind; this.on = this.was = el.flags.includes('ON'); }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.b = al.node(this.el.nodes[1]!);
    if (this.el.kind === 'S') { this.cp = al.node(this.el.nodes[2]!); this.cn = al.node(this.el.nodes[3]!); }
    else { this.kc = al.branchOf(this.el.ctrl![0]!); if (this.kc < 0) throw new Error(`${this.name}: controlling source not found`); }
  }
  private control(c: Ctx): { ctrl: number; vt: number; vh: number } {
    return { ctrl: this.el.kind === 'S' ? c.v(this.cp) - c.v(this.cn) : c.v(this.kc), vt: P(this.m, this.el.kind === 'S' ? 'vt' : 'it', 0), vh: Math.abs(P(this.m, this.el.kind === 'S' ? 'vh' : 'ih', 0)) };
  }
  load(c: Ctx): void {
    // An analysis decides the switch at every iteration, from where it was at the last time point (SPICE's way). A live
    // run leaves it as it is while the equations are solved and decides it from the solution (settle, below)
    if (!c.settle) {
      const { ctrl, vt, vh } = this.control(c);
      let on = this.was;
      if (ctrl > vt + vh) on = true; else if (ctrl < vt - vh) on = false;
      if (on !== this.on) c.noncon = true;
      this.on = on;
    }
    c.g(this.a, this.b, 1 / (this.on ? P(this.m, 'ron', 1) : P(this.m, 'roff', 1e12)));
  }
  /**
   * With the equations solved as the switch stands: does its control now say otherwise? It turns on above the upper
   * threshold, off below the lower, and between them stays as it is; true when it changed, and the equations are to be
   * solved again. Deciding it from a solution and not from an iterate on the way to one is what lets a part that latches
   * through its own current (a thyristor whose gate is fed from its own anode, a timer whose discharge turns its
   * capacitor round) settle within a step. One that still goes back and forth has no state to settle in at this step:
   * after six changes it is left as it is.
   */
  settle(c: Ctx): boolean {
    const { ctrl, vt, vh } = this.control(c);
    const on = ctrl > vt + vh ? true : ctrl < vt - vh ? false : this.on;
    if (on === this.on) { this.ctl = ctrl; return false; }
    if (c.time !== this.at) { this.at = c.time; this.flips = 0; }
    if (++this.flips > 6) { this.ctl = ctrl; return false; }
    // (its first turn at this time point: what its control had come to, and the level it passed)
    if (this.flips === 1) { this.ctlTurn = ctrl; this.thr = on ? vt + vh : vt - vh; }
    this.on = on;
    return true;
  }
  /** Its control at the solution in hand, at the last time point taken, and at the solution that turned it, with the level passed. */
  private ctl = NaN; private ctlWas = NaN; private ctlTurn = NaN; private thr = NaN;
  /** How far through the step in hand the switch turned (0 to 1), its control taken to have gone evenly from the last time point to where it stood when it turned; NaN where that cannot be said. */
  turnedAt(): number {
    const f = (this.thr - this.ctlWas) / (this.ctlTurn - this.ctlWas);
    return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : NaN;
  }
  initStates(): void { this.was = this.on; this.flips = 0; }
  ac(a: AcCtx): void { a.g(this.a, this.b, 1 / (this.on ? P(this.m, 'ron', 1) : P(this.m, 'roff', 1e12))); }
  accepted(): void { this.was = this.on; this.flips = 0; this.ctlWas = this.ctl; }
  rejected(): void { this.on = this.was; this.flips = 0; }
  changed(): boolean { return this.on !== this.was; }
  noise(c: Ctx): NoiseSrc[] { return [{ what: 'thermal', a: this.a, b: this.b, psd: fourKT(c) / (this.on ? P(this.m, 'ron', 1) : P(this.m, 'roff', 1e12)) }]; }
}

/* ─── Semiconductors ─────────────────────────────────────────────────────────────── */

/** A pn junction's current and conductance (with gmin), SPICE's three regions plus breakdown. */
function junction(vd: number, is: number, nvt: number, gmin: number, bv = Infinity, ibv = 1e-3): [number, number] {
  // The breakdown voltage moved so the current at −BV is IBV (as SPICE matches them)
  const xbv = Number.isFinite(bv) && ibv > is ? bv - nvt * Math.log(ibv / is) : bv;
  if (vd >= -3 * nvt) {
    const e = Math.exp(Math.min(vd / nvt, 700));
    return [is * (e - 1) + gmin * vd, (is * e) / nvt + gmin];
  }
  if (!Number.isFinite(xbv) || vd >= -xbv) {
    let arg = (3 * nvt) / (vd * Math.E);
    arg = arg * arg * arg;
    return [-is * (1 + arg) + gmin * vd, (is * 3 * arg) / vd + gmin];
  }
  const e = Math.exp(Math.min(-(xbv + vd) / nvt, 700));
  return [-is * e + gmin * vd, (is * e) / nvt + gmin];
}

/** Saturation current at temperature (SPICE's XTI / EG law). */
function isAt(is: number, n: number, xti: number, eg: number, tK: number, tnomK: number): number {
  const ratio = tK / tnomK;
  const vt = (BOLTZ * tK) / CHARGE;
  return is * Math.exp(((ratio - 1) * eg) / (n * vt) + (xti / n) * Math.log(ratio));
}

export class Diode implements Device {
  kind = 'D';
  a = -1; k = -1; ai = -1;
  vd = 0; gd = 0; cd = 0; id = 0;
  s = new State(true); states = [this.s];
  private n = 1; private rs = 0; private vcrit = 0.6;
  ic?: number;
  constructor(readonly name: string, readonly el: Element, private m: ModelCard | undefined) { this.ic = el.params.ic; }
  setup(al: Alloc): void {
    this.a = al.node(this.el.nodes[0]!); this.k = al.node(this.el.nodes[1]!);
    const area = (this.el.params.area ?? 1) * (this.el.params.m ?? 1);
    this.rs = P(this.m, 'rs', 0) / area;
    this.ai = this.rs > 0 ? al.internal(this.name, 'a') : this.a;
    this.n = P(this.m, 'n', 1);
    this.area = area;
  }
  private area = 1;
  load(c: Ctx): void {
    const m = this.m, area = this.area;
    const is = isAt(P(m, 'is', 1e-14), this.n, P(m, 'xti', 3), P(m, 'eg', 1.11), c.tempK, c.tol.tnom + 273.15) * area;
    const nvt = this.n * c.vt;
    this.vcrit = nvt * Math.log(nvt / (Math.SQRT2 * is));
    if (this.rs > 0) c.g(this.a, this.ai, 1 / this.rs);
    let vd = c.v(this.ai) - c.v(this.k);
    const bv = P(m, 'bv', Infinity), ibv = P(m, 'ibv', 1e-3);
    if (c.initJunctions) vd = this.el.flags.includes('OFF') ? 0 : this.vcrit;
    else {
      // Past breakdown the junction is an exponential the other way up: its steps are limited as a forward one's are
      // (SPICE's own way), or one iterate far into it leaves the next ones a thermal voltage at a time to come back by
      const xbv = bv > 0 && Number.isFinite(bv) ? (ibv > is ? bv - nvt * Math.log(ibv / is) : bv) : Infinity;
      if (Number.isFinite(xbv) && vd < Math.min(0, -xbv + 10 * nvt)) vd = -(pnjlim(-(vd + xbv), -(this.vd + xbv), nvt, this.vcrit, c) + xbv);
      else vd = pnjlim(vd, this.vd, nvt, this.vcrit, c);
    }
    this.vd = vd;
    const [id, gd] = junction(vd, is, nvt, c.tol.gmin + c.gminExtra, bv > 0 ? bv : Infinity, ibv);
    this.id = id; this.gd = gd;
    c.nonlinear(this.ai, this.k, id, [[this.ai, this.k, gd, vd]]);
    // Junction (depletion) and transit-time charge
    const [qj, cj] = depletion(vd, P(m, 'cjo', P(m, 'cj0', 0)) * area, P(m, 'vj', 1), P(m, 'm', 0.5), P(m, 'fc', 0.5));
    const tt = P(m, 'tt', 0);
    this.cd = cj + tt * gd;
    if (c.mode === 'tran') {
      const q = qj + tt * id;
      const i = this.s.integrate(c, q);
      const geq = this.cd * c.a0j;
      c.nonlinear(this.ai, this.k, i, [[this.ai, this.k, geq, vd]]);
    } else this.s.q[0] = qj + tt * id;
  }
  initStates(c: Ctx): void {
    if (c.uic && this.ic !== undefined) this.vd = this.ic;
    const m = this.m;
    const [qj] = depletion(this.vd, P(m, 'cjo', P(m, 'cj0', 0)) * this.area, P(m, 'vj', 1), P(m, 'm', 0.5), P(m, 'fc', 0.5));
    this.s.reset(qj + P(m, 'tt', 0) * this.id);
  }
  ac(a: AcCtx): void {
    if (this.rs > 0) a.g(this.a, this.ai, 1 / this.rs);
    a.g(this.ai, this.k, this.gd, a.omega * this.cd);
  }
  probe(): [string, number][] { return [['id', this.id], ['p', this.id * this.vd]]; }
  noise(c: Ctx, f: number): NoiseSrc[] {
    const out: NoiseSrc[] = [];
    if (this.rs > 0) out.push({ what: 'rs', a: this.a, b: this.ai, psd: fourKT(c) / this.rs });
    out.push({ what: 'shot', a: this.ai, b: this.k, psd: 2 * CHARGE * Math.abs(this.id) });
    const kf = P(this.m, 'kf', 0);
    if (kf > 0) out.push({ what: 'flicker', a: this.ai, b: this.k, psd: (kf * Math.abs(this.id) ** P(this.m, 'af', 1)) / f });
    return out;
  }
}

export class BJT implements Device {
  kind = 'Q';
  c = -1; b = -1; e = -1; sub = -1; ci = -1; bi = -1; ei = -1;
  vbe = 0; vbc = 0; type = 1;
  // small-signal at the last point
  gm = 0; go = 0; gpi = 0; gmu = 0; cbe = 0; cbc = 0; ccs = 0; ic = 0; ib = 0;
  sbe = new State(true); sbc = new State(true); scs = new State(true); states = [this.sbe, this.sbc, this.scs];
  private area = 1;
  constructor(readonly name: string, readonly el: Element, private m: ModelCard | undefined) { this.type = m?.type === 'PNP' ? -1 : 1; }
  setup(al: Alloc): void {
    const [nc, nb, ne, ns] = this.el.nodes;
    this.c = al.node(nc!); this.b = al.node(nb!); this.e = al.node(ne!); this.sub = ns ? al.node(ns) : -1;
    this.area = (this.el.params.area ?? 1) * (this.el.params.m ?? 1);
    this.ci = P(this.m, 'rc', 0) > 0 ? al.internal(this.name, 'c') : this.c;
    this.bi = P(this.m, 'rb', 0) > 0 ? al.internal(this.name, 'b') : this.b;
    this.ei = P(this.m, 're', 0) > 0 ? al.internal(this.name, 'e') : this.e;
  }
  load(c: Ctx): void {
    const m = this.m, t = this.type, area = this.area, vt = c.vt;
    const nf = P(m, 'nf', 1), nr = P(m, 'nr', 1);
    const is = isAt(P(m, 'is', 1e-16), 1, P(m, 'xti', 3), P(m, 'eg', 1.11), c.tempK, c.tol.tnom + 273.15) * area;
    const bf = P(m, 'bf', 100), br = P(m, 'br', 1);
    const ise = P(m, 'ise', 0) * area, ne = P(m, 'ne', 1.5), isc = P(m, 'isc', 0) * area, nc = P(m, 'nc', 2);
    const vaf = P(m, 'vaf', P(m, 'va', 0)), varr = P(m, 'var', P(m, 'vb', 0));
    const ikf = P(m, 'ikf', P(m, 'ik', 0)) * area, ikr = P(m, 'ikr', 0) * area;
    const rc = P(m, 'rc', 0) / area, rb = P(m, 'rb', 0) / area, re = P(m, 're', 0) / area;
    if (rc > 0) c.g(this.c, this.ci, 1 / rc);
    if (rb > 0) c.g(this.b, this.bi, 1 / rb);
    if (re > 0) c.g(this.e, this.ei, 1 / re);
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
    let vbe = t * (c.v(this.bi) - c.v(this.ei)), vbc = t * (c.v(this.bi) - c.v(this.ci));
    if (c.initJunctions) { vbe = this.el.flags.includes('OFF') ? 0 : vcrit; vbc = 0; }
    else { vbe = pnjlim(vbe, this.vbe, vt, vcrit, c); vbc = pnjlim(vbc, this.vbc, vt, vcrit, c); }
    this.vbe = vbe; this.vbc = vbc;
    const gmin = c.tol.gmin + c.gminExtra;
    const [cbe, gbe] = junction(vbe, is, nf * vt, gmin);
    const [cben, gben] = ise > 0 ? junction(vbe, ise, ne * vt, 0) : [0, 0];
    const [cbc, gbc] = junction(vbc, is, nr * vt, gmin);
    const [cbcn, gbcn] = isc > 0 ? junction(vbc, isc, nc * vt, 0) : [0, 0];
    const ivaf = vaf > 0 ? 1 / vaf : 0, ivar = varr > 0 ? 1 / varr : 0, iikf = ikf > 0 ? 1 / ikf : 0, iikr = ikr > 0 ? 1 / ikr : 0;
    const q1 = 1 / (1 - ivaf * vbc - ivar * vbe);
    let qb: number, dqbdve: number, dqbdvc: number;
    if (iikf === 0 && iikr === 0) { qb = q1; dqbdve = q1 * qb * ivar; dqbdvc = q1 * qb * ivaf; }
    else {
      const q2 = iikf * cbe + iikr * cbc;
      const arg = Math.max(0, 1 + 4 * q2), sqarg = Math.sqrt(arg);
      qb = (q1 * (1 + sqarg)) / 2;
      dqbdve = q1 * (qb * ivar + (iikf * gbe) / sqarg);
      dqbdvc = q1 * (qb * ivaf + (iikr * gbc) / sqarg);
    }
    const cc = (cbe - cbc) / qb - cbc / br - cbcn;
    const cb = cbe / bf + cben + cbc / br + cbcn;
    const go = (gbc + ((cbe - cbc) * dqbdvc) / qb) / qb;
    const gm = (gbe - ((cbe - cbc) * dqbdve) / qb) / qb - go;
    const gpi = gbe / bf + gben, gmu = gbc / br + gbcn;
    this.gm = gm; this.go = go; this.gpi = gpi; this.gmu = gmu; this.ic = t * cc; this.ib = t * cb;
    // In node terms (type folded in): Ic from c' to e', Ib from b' to e'
    // Linearised where the (limited) junction voltages put it
    const vBE = t * vbe, vBC = t * vbc;
    c.nonlinear(this.ci, this.ei, t * cc, [[this.bi, this.ei, gm + go, vBE], [this.bi, this.ci, -go - gmu, vBC]]);
    c.nonlinear(this.bi, this.ei, t * cb, [[this.bi, this.ei, gpi, vBE], [this.bi, this.ci, gmu, vBC]]);
    // Charges: B–E depletion and forward transit time, B–C depletion and reverse transit time, C–S depletion
    const fc = P(m, 'fc', 0.5);
    const [qde, cde] = depletion(vbe, P(m, 'cje', 0) * area, P(m, 'vje', P(m, 'pe', 0.75)), P(m, 'mje', P(m, 'me', 0.33)), fc);
    const [qdc, cdc] = depletion(vbc, P(m, 'cjc', 0) * area, P(m, 'vjc', P(m, 'pc', 0.75)), P(m, 'mjc', P(m, 'mc', 0.33)), fc);
    const vsub = this.sub >= 0 ? t * (c.v(this.sub) - c.v(this.ci)) : 0;
    const [qds, cds] = this.sub >= 0 ? depletion(vsub, P(m, 'cjs', P(m, 'csub', 0)) * area, P(m, 'vjs', P(m, 'ps', 0.75)), P(m, 'mjs', P(m, 'ms', 0)), fc) : [0, 0];
    const tf = P(m, 'tf', 0), tr = P(m, 'tr', 0);
    const qbe = qde + (tf * cbe) / qb, qbc = qdc + tr * cbc;
    this.cbe = cde + (tf * gbe) / qb; this.cbc = cdc + tr * gbc; this.ccs = cds;
    if (c.mode === 'tran') {
      const ibe = this.sbe.integrate(c, qbe), ibc = this.sbc.integrate(c, qbc);
      c.nonlinear(this.bi, this.ei, t * ibe, [[this.bi, this.ei, this.cbe * c.a0j, vBE]]);
      c.nonlinear(this.bi, this.ci, t * ibc, [[this.bi, this.ci, this.cbc * c.a0j, vBC]]);
      if (this.sub >= 0) {
        const ics = this.scs.integrate(c, qds);
        const vS = c.v(this.sub) - c.v(this.ci);
        c.nonlinear(this.sub, this.ci, t * ics, [[this.sub, this.ci, this.ccs * c.a0j, vS]]);
      }
    } else { this.sbe.q[0] = qbe; this.sbc.q[0] = qbc; this.scs.q[0] = qds; }
  }
  initStates(): void { this.sbe.reset(this.sbe.q[0]!); this.sbc.reset(this.sbc.q[0]!); this.scs.reset(this.scs.q[0]!); }
  ac(a: AcCtx): void {
    const m = this.m, area = this.area;
    const rc = P(m, 'rc', 0) / area, rb = P(m, 'rb', 0) / area, re = P(m, 're', 0) / area;
    if (rc > 0) a.g(this.c, this.ci, 1 / rc);
    if (rb > 0) a.g(this.b, this.bi, 1 / rb);
    if (re > 0) a.g(this.e, this.ei, 1 / re);
    a.vccs(this.ci, this.ei, this.bi, this.ei, this.gm + this.go);
    a.vccs(this.ci, this.ei, this.bi, this.ci, -this.go - this.gmu);
    a.vccs(this.bi, this.ei, this.bi, this.ei, this.gpi);
    a.vccs(this.bi, this.ei, this.bi, this.ci, this.gmu);
    a.c(this.bi, this.ei, this.cbe); a.c(this.bi, this.ci, this.cbc);
    if (this.sub >= 0) a.c(this.sub, this.ci, this.ccs);
  }
  probe(c: Ctx): [string, number][] {
    const ie = -(this.ic + this.ib);
    const p = this.ic * (c.v(this.c) - c.v(this.e)) + this.ib * (c.v(this.b) - c.v(this.e));
    return [['ic', this.ic], ['ib', this.ib], ['ie', ie], ['p', p]];
  }
  noise(c: Ctx, f: number): NoiseSrc[] {
    const m = this.m, area = this.area, out: NoiseSrc[] = [];
    const rc = P(m, 'rc', 0) / area, rb = P(m, 'rb', 0) / area, re = P(m, 're', 0) / area;
    if (rc > 0) out.push({ what: 'rc', a: this.c, b: this.ci, psd: fourKT(c) / rc });
    if (rb > 0) out.push({ what: 'rb', a: this.b, b: this.bi, psd: fourKT(c) / rb });
    if (re > 0) out.push({ what: 're', a: this.e, b: this.ei, psd: fourKT(c) / re });
    out.push({ what: 'ic', a: this.ci, b: this.ei, psd: 2 * CHARGE * Math.abs(this.ic) });
    out.push({ what: 'ib', a: this.bi, b: this.ei, psd: 2 * CHARGE * Math.abs(this.ib) });
    const kf = P(m, 'kf', 0);
    if (kf > 0) out.push({ what: 'flicker', a: this.bi, b: this.ei, psd: (kf * Math.abs(this.ib) ** P(m, 'af', 1)) / f });
    return out;
  }
}

export class MOSFET implements Device {
  kind = 'M';
  d = -1; g = -1; s = -1; bulk = -1; di = -1; si = -1;
  type = 1; vgs = 0; vds = 0; vbs = 0; mode = 1;
  gm = 0; gds = 0; gmbs = 0; gbd = 0; gbs = 0; cgs = 0; cgd = 0; cgb = 0; cbd = 0; cbs = 0; ids = 0;
  sgs = new State(true); sgd = new State(true); sgb = new State(true); sbd = new State(true); sbs = new State(true);
  states = [this.sgs, this.sgd, this.sgb, this.sbd, this.sbs];
  private w = 1e-4; private l = 1e-4; private leff = 1e-4; private cox = 0;
  constructor(readonly name: string, readonly el: Element, private m: ModelCard | undefined) { this.type = m?.type === 'PMOS' ? -1 : 1; }
  setup(al: Alloc): void {
    const [nd, ng, ns, nb] = this.el.nodes;
    this.d = al.node(nd!); this.g = al.node(ng!); this.s = al.node(ns!); this.bulk = al.node(nb!);
    this.w = this.el.params.w ?? P(this.m, 'w', 100e-6);
    this.l = this.el.params.l ?? P(this.m, 'l', 100e-6);
    this.di = P(this.m, 'rd', 0) > 0 ? al.internal(this.name, 'd') : this.d;
    this.si = P(this.m, 'rs', 0) > 0 ? al.internal(this.name, 's') : this.s;
  }
  load(c: Ctx): void {
    const m = this.m, t = this.type, vt = c.vt;
    const mult = this.el.params.m ?? 1;
    const leff = Math.max(this.l - 2 * P(m, 'ld', 0), 1e-9);
    const tox = P(m, 'tox', 0);
    const cox = tox > 0 ? (3.9 * 8.854214871e-12) / tox : 0;
    const kp = P(m, 'kp', tox > 0 ? P(m, 'uo', P(m, 'u0', 600)) * 1e-4 * cox : 2e-5);
    const beta = (kp * this.w * mult) / leff;
    const vto = t * P(m, 'vto', P(m, 'vt0', 0));
    const gamma = P(m, 'gamma', 0), phi = Math.max(P(m, 'phi', 0.6), 0.1), lambda = P(m, 'lambda', 0);
    if (P(m, 'rd', 0) > 0) c.g(this.d, this.di, mult / P(m, 'rd', 0));
    if (P(m, 'rs', 0) > 0) c.g(this.s, this.si, mult / P(m, 'rs', 0));
    const vgs0 = t * (c.v(this.g) - c.v(this.si)), vds0 = t * (c.v(this.di) - c.v(this.si)), vbs0 = t * (c.v(this.bulk) - c.v(this.si));
    let vgs = vgs0, vds = vds0, vbs = vbs0;
    if (c.initJunctions) {
      if (this.el.flags.includes('OFF')) { vgs = vds = vbs = 0; } else { vgs = vto; vds = 0; vbs = -1; }
    } else {
      // Limiting, as SPICE does, in the forward or the reverse direction
      const von = vto;
      if (this.vds >= 0) { vgs = fetlim(vgs, this.vgs, von); vds = limvds(vds, this.vds); }
      else { const vgd = fetlim(vgs - vds, this.vgs - this.vds, von); vds = -limvds(-vds, -this.vds); vgs = vgd + vds; }
      if (vds >= 0) vbs = pnjlim(vbs, this.vbs, vt, 0.6, c); else { const vbd = pnjlim(vbs - vds, this.vbs - this.vds, vt, 0.6, c); vbs = vbd + vds; }
      if (Math.abs(vgs - vgs0) > 1e-12 || Math.abs(vds - vds0) > 1e-12) c.noncon = true;
    }
    this.vgs = vgs; this.vds = vds; this.vbs = vbs;
    const vbd = vbs - vds, vgd = vgs - vds;
    // Bulk junctions
    const isj = P(m, 'is', 1e-14);
    const gmin = c.tol.gmin + c.gminExtra;
    const [cbs, gbs] = junction(vbs, isj, vt, gmin);
    const [cbd, gbd] = junction(vbd, isj, vt, gmin);
    this.gbs = gbs; this.gbd = gbd;
    // Drain current, forward (vds ≥ 0) or with drain and source swapped
    this.mode = vds >= 0 ? 1 : -1;
    const vgsx = this.mode > 0 ? vgs : vgd, vdsx = this.mode * vds, vbsx = this.mode > 0 ? vbs : vbd;
    const sarg = vbsx <= 0 ? Math.sqrt(phi - vbsx) : Math.max(0, Math.sqrt(phi) - vbsx / (2 * Math.sqrt(phi)));
    const von = vto + gamma * (sarg - Math.sqrt(phi));
    const vgst = vgsx - von;
    let ids = 0, gm = 0, gds = 0, gmbs = 0;
    if (vgst > 0) {
      const lam = 1 + lambda * vdsx;
      if (vgst <= vdsx) { ids = 0.5 * beta * vgst * vgst * lam; gm = beta * vgst * lam; gds = 0.5 * lambda * beta * vgst * vgst; }
      else { ids = beta * vdsx * (vgst - 0.5 * vdsx) * lam; gm = beta * vdsx * lam; gds = beta * (vgst - vdsx) * lam + lambda * beta * vdsx * (vgst - 0.5 * vdsx); }
      gmbs = gamma > 0 && sarg > 0 ? (gm * gamma) / (2 * sarg) : 0;
    }
    this.gm = gm; this.gds = gds; this.gmbs = gmbs; this.ids = this.mode * ids;
    const vG = c.v(this.g), vD = c.v(this.di), vS = c.v(this.si), vB = c.v(this.bulk);
    // Linearised where the (limited) voltages put it
    if (this.mode > 0) c.nonlinear(this.di, this.si, t * ids, [[this.g, this.si, gm, t * vgs], [this.di, this.si, gds, t * vds], [this.bulk, this.si, gmbs, t * vbs]]);
    else c.nonlinear(this.si, this.di, t * ids, [[this.g, this.di, gm, t * vgd], [this.si, this.di, gds, -t * vds], [this.bulk, this.di, gmbs, t * vbd]]);
    c.nonlinear(this.bulk, this.si, t * cbs, [[this.bulk, this.si, gbs, t * vbs]]);
    c.nonlinear(this.bulk, this.di, t * cbd, [[this.bulk, this.di, gbd, t * vbd]]);
    // Capacitances: overlaps, Meyer's gate charge, the bulk junctions
    const cgso = P(m, 'cgso', 0) * this.w * mult, cgdo = P(m, 'cgdo', 0) * this.w * mult, cgbo = P(m, 'cgbo', 0) * leff * mult;
    const coxwl = cox * this.w * leff * mult;
    this.leff = leff; this.cox = cox;
    let cgs = 0, cgd = 0, cgb = 0;
    if (coxwl > 0) {
      if (vgst <= -phi) cgb = coxwl;
      else if (vgst <= -phi / 2) cgb = (-vgst * coxwl) / phi;
      else if (vgst <= 0) { cgb = (-vgst * coxwl) / phi; cgs = (vgst * coxwl * 4) / (3 * phi) + (2 * coxwl) / 3; }
      else if (vdsx >= vgst) cgs = (2 * coxwl) / 3;
      else { const d2 = (2 * vgst - vdsx) ** 2; cgd = (2 * coxwl * (1 - (vgst * vgst) / d2)) / 3; cgs = (2 * coxwl * (1 - ((vgst - vdsx) ** 2) / d2)) / 3; }
      if (this.mode < 0) [cgs, cgd] = [cgd, cgs];
    }
    this.cgs = cgs + cgso; this.cgd = cgd + cgdo; this.cgb = cgb + cgbo;
    const pb = P(m, 'pb', 0.8), mj = P(m, 'mj', 0.5), fc = P(m, 'fc', 0.5);
    const ad = this.el.params.ad ?? 0, as = this.el.params.as ?? 0;
    const cbd0 = P(m, 'cbd', P(m, 'cj', 0) * ad) * mult, cbs0 = P(m, 'cbs', P(m, 'cj', 0) * as) * mult;
    const [qbdj, cbdj] = depletion(vbd, cbd0, pb, mj, fc);
    const [qbsj, cbsj] = depletion(vbs, cbs0, pb, mj, fc);
    this.cbd = cbdj; this.cbs = cbsj;
    if (c.mode === 'tran') {
      // Gate charges as capacitances held over the step (as SPICE's Meyer model integrates them)
      const vGS = vG - vS, vGD = vG - vD, vGB = vG - vB;
      const lin = (st: State, cap: number, v: number, a: number, b: number) => {
        const q = st.q[1]! + cap * (v - this.prevV(st));
        const i = st.integrate(c, q);
        c.nonlinear(a, b, i, [[a, b, cap * c.a0j, v]]);
      };
      lin(this.sgs, this.cgs, vGS, this.g, this.si);
      lin(this.sgd, this.cgd, vGD, this.g, this.di);
      lin(this.sgb, this.cgb, vGB, this.g, this.bulk);
      const ibd = this.sbd.integrate(c, qbdj), ibs = this.sbs.integrate(c, qbsj);
      c.nonlinear(this.bulk, this.di, t * ibd, [[this.bulk, this.di, cbdj * c.a0j, t * vbd]]);
      c.nonlinear(this.bulk, this.si, t * ibs, [[this.bulk, this.si, cbsj * c.a0j, t * vbs]]);
      this.vNow.set(this.sgs, vGS); this.vNow.set(this.sgd, vGD); this.vNow.set(this.sgb, vGB);
    } else {
      this.sbd.q[0] = qbdj; this.sbs.q[0] = qbsj;
      this.vNow.set(this.sgs, vG - vS); this.vNow.set(this.sgd, vG - vD); this.vNow.set(this.sgb, vG - vB);
    }
  }
  /** Gate voltages at the last accepted point (Meyer charges are built from them). */
  private vPrev = new Map<State, number>();
  private vNow = new Map<State, number>();
  private prevV(st: State): number { return this.vPrev.get(st) ?? 0; }
  initStates(): void {
    for (const st of [this.sgs, this.sgd, this.sgb]) { st.reset(0); this.vPrev.set(st, this.vNow.get(st) ?? 0); }
    this.sbd.reset(this.sbd.q[0]!); this.sbs.reset(this.sbs.q[0]!);
  }
  accepted(): void { for (const [st, v] of this.vNow) this.vPrev.set(st, v); }
  ac(a: AcCtx): void {
    const m = this.m, mult = this.el.params.m ?? 1;
    if (P(m, 'rd', 0) > 0) a.g(this.d, this.di, mult / P(m, 'rd', 0));
    if (P(m, 'rs', 0) > 0) a.g(this.s, this.si, mult / P(m, 'rs', 0));
    if (this.mode > 0) { a.vccs(this.di, this.si, this.g, this.si, this.gm); a.vccs(this.di, this.si, this.di, this.si, this.gds); a.vccs(this.di, this.si, this.bulk, this.si, this.gmbs); }
    else { a.vccs(this.si, this.di, this.g, this.di, this.gm); a.vccs(this.si, this.di, this.si, this.di, this.gds); a.vccs(this.si, this.di, this.bulk, this.di, this.gmbs); }
    a.g(this.bulk, this.si, this.gbs); a.g(this.bulk, this.di, this.gbd);
    a.c(this.g, this.si, this.cgs); a.c(this.g, this.di, this.cgd); a.c(this.g, this.bulk, this.cgb);
    a.c(this.bulk, this.di, this.cbd); a.c(this.bulk, this.si, this.cbs);
  }
  probe(c: Ctx): [string, number][] {
    const id = this.type * this.ids;
    return [['id', id], ['is', -id], ['p', id * (c.v(this.d) - c.v(this.s))]];
  }
  noise(c: Ctx, f: number): NoiseSrc[] {
    const m = this.m, mult = this.el.params.m ?? 1, out: NoiseSrc[] = [];
    if (P(m, 'rd', 0) > 0) out.push({ what: 'rd', a: this.d, b: this.di, psd: (fourKT(c) * mult) / P(m, 'rd', 0) });
    if (P(m, 'rs', 0) > 0) out.push({ what: 'rs', a: this.s, b: this.si, psd: (fourKT(c) * mult) / P(m, 'rs', 0) });
    out.push({ what: 'channel', a: this.di, b: this.si, psd: (2 / 3) * fourKT(c) * Math.abs(this.gm) });
    const kf = P(m, 'kf', 0), cox = this.cox || COX_DEFAULT;
    if (kf > 0) out.push({ what: 'flicker', a: this.di, b: this.si, psd: (kf * Math.abs(this.ids) ** P(m, 'af', 1)) / (f * this.w * this.leff * cox * cox) });
    return out;
  }
}

export class JFET implements Device {
  kind = 'J';
  d = -1; g = -1; s = -1; di = -1; si = -1;
  type = 1; vgs = 0; vgd = 0;
  gm = 0; gds = 0; ggs = 0; ggd = 0; cgs = 0; cgd = 0; id = 0;
  sgs = new State(true); sgd = new State(true); states = [this.sgs, this.sgd];
  private area = 1;
  constructor(readonly name: string, readonly el: Element, private m: ModelCard | undefined) { this.type = m?.type === 'PJF' ? -1 : 1; }
  setup(al: Alloc): void {
    const [nd, ng, ns] = this.el.nodes;
    this.d = al.node(nd!); this.g = al.node(ng!); this.s = al.node(ns!);
    this.area = (this.el.params.area ?? 1) * (this.el.params.m ?? 1);
    this.di = P(this.m, 'rd', 0) > 0 ? al.internal(this.name, 'd') : this.d;
    this.si = P(this.m, 'rs', 0) > 0 ? al.internal(this.name, 's') : this.s;
  }
  load(c: Ctx): void {
    const m = this.m, t = this.type, area = this.area, vt = c.vt;
    const beta = P(m, 'beta', 1e-4) * area, vto = P(m, 'vto', -2), lambda = P(m, 'lambda', 0), is = P(m, 'is', 1e-14) * area;
    if (P(m, 'rd', 0) > 0) c.g(this.d, this.di, area / P(m, 'rd', 0));
    if (P(m, 'rs', 0) > 0) c.g(this.s, this.si, area / P(m, 'rs', 0));
    let vgs = t * (c.v(this.g) - c.v(this.si)), vgd = t * (c.v(this.g) - c.v(this.di));
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
    if (c.initJunctions) { vgs = -1; vgd = -1; }
    else { vgs = pnjlim(vgs, this.vgs, vt, vcrit, c); vgd = pnjlim(vgd, this.vgd, vt, vcrit, c); }
    this.vgs = vgs; this.vgd = vgd;
    const vds = vgs - vgd;
    const gmin = c.tol.gmin + c.gminExtra;
    const [cg, ggs] = junction(vgs, is, vt, gmin), [cgdj, ggd] = junction(vgd, is, vt, gmin);
    this.ggs = ggs; this.ggd = ggd;
    let id = 0, gm = 0, gds = 0;
    const fwd = vds >= 0;
    const vgst = (fwd ? vgs : vgd) - vto, vdsx = Math.abs(vds);
    if (vgst > 0) {
      const lam = 1 + lambda * vdsx;
      if (vgst <= vdsx) { id = beta * vgst * vgst * lam; gm = 2 * beta * vgst * lam; gds = lambda * beta * vgst * vgst; }
      else { id = beta * vdsx * (2 * vgst - vdsx) * lam; gm = 2 * beta * vdsx * lam; gds = 2 * beta * (vgst - vdsx) * lam + beta * lambda * vdsx * (2 * vgst - vdsx); }
    }
    this.gm = gm; this.gds = gds; this.id = (fwd ? 1 : -1) * id * t;
    // Linearised where the (limited) voltages put it
    if (fwd) c.nonlinear(this.di, this.si, t * id, [[this.g, this.si, gm, t * vgs], [this.di, this.si, gds, t * vds]]);
    else c.nonlinear(this.si, this.di, t * id, [[this.g, this.di, gm, t * vgd], [this.si, this.di, gds, -t * vds]]);
    c.nonlinear(this.g, this.si, t * cg, [[this.g, this.si, ggs, t * vgs]]);
    c.nonlinear(this.g, this.di, t * cgdj, [[this.g, this.di, ggd, t * vgd]]);
    const pb = P(m, 'pb', 1), fc = P(m, 'fc', 0.5);
    const [qgs, cgs] = depletion(vgs, P(m, 'cgs', 0) * area, pb, 0.5, fc);
    const [qgd, cgd] = depletion(vgd, P(m, 'cgd', 0) * area, pb, 0.5, fc);
    this.cgs = cgs; this.cgd = cgd;
    if (c.mode === 'tran') {
      const igs = this.sgs.integrate(c, qgs), igd = this.sgd.integrate(c, qgd);
      c.nonlinear(this.g, this.si, t * igs, [[this.g, this.si, cgs * c.a0j, t * vgs]]);
      c.nonlinear(this.g, this.di, t * igd, [[this.g, this.di, cgd * c.a0j, t * vgd]]);
    } else { this.sgs.q[0] = qgs; this.sgd.q[0] = qgd; }
  }
  initStates(): void { this.sgs.reset(this.sgs.q[0]!); this.sgd.reset(this.sgd.q[0]!); }
  ac(a: AcCtx): void {
    const m = this.m, area = this.area;
    if (P(m, 'rd', 0) > 0) a.g(this.d, this.di, area / P(m, 'rd', 0));
    if (P(m, 'rs', 0) > 0) a.g(this.s, this.si, area / P(m, 'rs', 0));
    const fwd = this.vgs - this.vgd >= 0;
    if (fwd) { a.vccs(this.di, this.si, this.g, this.si, this.gm); a.vccs(this.di, this.si, this.di, this.si, this.gds); }
    else { a.vccs(this.si, this.di, this.g, this.di, this.gm); a.vccs(this.si, this.di, this.si, this.di, this.gds); }
    a.g(this.g, this.si, this.ggs, a.omega * this.cgs); a.g(this.g, this.di, this.ggd, a.omega * this.cgd);
  }
  probe(c: Ctx): [string, number][] { return [['id', this.id], ['p', this.id * (c.v(this.d) - c.v(this.s))]]; }
  noise(c: Ctx, f: number): NoiseSrc[] {
    const m = this.m, area = this.area, out: NoiseSrc[] = [];
    if (P(m, 'rd', 0) > 0) out.push({ what: 'rd', a: this.d, b: this.di, psd: (fourKT(c) * area) / P(m, 'rd', 0) });
    if (P(m, 'rs', 0) > 0) out.push({ what: 'rs', a: this.s, b: this.si, psd: (fourKT(c) * area) / P(m, 'rs', 0) });
    out.push({ what: 'channel', a: this.di, b: this.si, psd: (2 / 3) * fourKT(c) * Math.abs(this.gm) });
    const kf = P(m, 'kf', 0);
    if (kf > 0) out.push({ what: 'flicker', a: this.di, b: this.si, psd: (kf * Math.abs(this.id) ** P(m, 'af', 1)) / f });
    return out;
  }
}

/** The device for an element (with its model card, when it takes one). */
export function makeDevice(el: Element, models: Map<string, ModelCard>): Device {
  const model = el.model ? models.get(el.model.toLowerCase()) : undefined;
  const need = (types: string[]) => {
    if (!model) throw new Error(`${el.name}: model ${el.model ?? '(none)'} not found`);
    if (!types.includes(model.type)) throw new Error(`${el.name}: model ${el.model} is a ${model.type}, not a ${types.join(' or ')}`);
    return model;
  };
  switch (el.kind) {
    case 'R': return new Resistor(el.name, el, model);
    case 'C': return new Capacitor(el.name, el, model);
    case 'L': return new Inductor(el.name, el);
    case 'K': return new Coupling(el.name, el);
    case 'V': return new VSource(el.name, el);
    case 'I': return new ISource(el.name, el);
    case 'E': case 'H': return new VControlled(el.name, el);
    case 'G': case 'F': return new IControlled(el.name, el);
    case 'B': return new Behavioural(el.name, el);
    case 'S': return new Switch(el.name, el, need(['SW']));
    case 'W': return new Switch(el.name, el, need(['CSW']));
    case 'D': return new Diode(el.name, el, need(['D']));
    case 'Q': return new BJT(el.name, el, need(['NPN', 'PNP']));
    case 'M': return new MOSFET(el.name, el, need(['NMOS', 'PMOS']));
    case 'J': return new JFET(el.name, el, need(['NJF', 'PJF']));
  }
}

