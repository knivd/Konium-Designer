/**
 * The simulator: modified nodal analysis of a flattened circuit, solved by Newton–Raphson with
 * SPICE's voltage limiting, gmin stepping and source stepping for the operating point; DC
 * sweeps (nested), transient analysis (trapezoidal or Gear, the step set by the truncation error
 * and landing on the sources' corners), AC small-signal sweeps, the DC transfer function and
 * Fourier analysis of a transient. Results are vectors by name: node voltages, sources' branch
 * currents (V1#branch), and devices' currents and powers (R1[i], Q1[ic], R1[p]).
 */
import { AcCtx, makeDevice, VSource, ISource, Switch, Capacitor, type Alloc, type Device } from './devices';
import { Ctx, DEFAULT_TOL, State, type Tolerances } from './ctx';
import { Solver } from './lu';
import { pencilRoots, type Complex } from './eig';
import type { Analysis, Circuit } from './netlist';

/** Units of a vector (noise densities per root hertz). */
export type Unit = 'V' | 'A' | 'W' | 's' | 'Hz' | 'V/√Hz' | 'A/√Hz' | '';
export interface Vector { name: string; unit: Unit; re: Float64Array | number[]; im?: Float64Array | number[] }
export interface Plot {
  analysis: Analysis['kind'];
  title: string;
  /** The sweep (time, frequency, a source's value); absent for an operating point. */
  x?: { name: string; unit: Unit; values: number[] };
  vectors: Vector[];
  /** Complex values (AC): re and im. */
  complex?: boolean;
  /** A nested DC sweep: where each curve starts, and its label. */
  segments?: { start: number; label: string }[];
  /** Tables (Fourier, transfer function): rows of text. */
  table?: { columns: string[]; rows: string[][] };
  /** A swept run (temperature, parameter, Monte Carlo): each signal once per run, under the run's suffix. */
  runs?: { suffix: string; label: string }[];
}
export interface SimMessage { level: 'error' | 'warn' | 'info'; text: string }

/** What to keep: node voltages and supply currents always; device currents, powers, subcircuit nodes as asked. */
export interface Collect { deviceCurrents: boolean; powers: boolean; subcircuitNodes: boolean; only?: Set<string> }
export const COLLECT_DEFAULT: Collect = { deviceCurrents: true, powers: false, subcircuitNodes: false };

export class SimError extends Error {}

/** The largest circuit simulated (node voltages and branch currents). */
export const MAX_UNKNOWNS = 4000;
/** Pole-zero analysis works on dense matrices: up to this many unknowns. */
export const PZ_MAX = 400;

export class Simulator {
  readonly c = new Ctx();
  readonly devices: Device[] = [];
  readonly messages: SimMessage[] = [];
  private nodes = new Map<string, number>();
  private branches = new Map<string, number>();
  private names: string[] = [];
  private states: State[] = [];
  private gshunt = 1e-12;

  constructor(readonly circuit: Circuit, tol: Partial<Tolerances> = {}, readonly collect: Collect = COLLECT_DEFAULT) {
    const o = circuit.options;
    const num = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
    this.c.tol = {
      ...DEFAULT_TOL, ...tol,
      ...Object.fromEntries((['reltol', 'abstol', 'vntol', 'chgtol', 'gmin', 'trtol', 'itl1', 'itl2', 'itl4', 'maxord', 'temp', 'tnom', 'pivrel', 'itl5', 'srcsteps', 'ramptime', 'acct'] as const)
        .filter((k) => num(k) !== undefined).map((k) => [k, num(k)])),
      ...(typeof o.method === 'string' ? { method: /gear/i.test(o.method) ? 'gear' as const : 'trap' as const } : {}),
    };
    if (num('rshunt')) this.gshunt = 1 / num('rshunt')!;
    this.solver = new Solver(this.c.tol.pivrel);
    // MOSFETs without their own L, W, AD, AS: Advanced Options' defaults
    for (const el of circuit.elements) {
      if (el.kind !== 'M') continue;
      for (const [k, opt] of [['l', 'defl'], ['w', 'defw'], ['ad', 'defad'], ['as', 'defas']] as const) if (el.params[k] === undefined && num(opt) !== undefined) el.params[k] = num(opt)!;
    }
    this.c.setTemp(this.c.tol.temp);
    for (const e of circuit.errors) this.messages.push({ level: 'warn', text: `line ${e.line}: ${e.message}` });
    // Devices: the ones others refer to first (sources, inductors), then controlled sources and couplings
    const late = new Set(['F', 'H', 'W', 'K', 'B']);
    const made: Device[] = [];
    for (const el of circuit.elements) {
      try { made.push(makeDevice(el, circuit.models)); } catch (e) { this.messages.push({ level: 'error', text: (e as Error).message }); }
    }
    const byName = new Map(made.map((d) => [d.name.toLowerCase(), d]));
    const alloc: Alloc = {
      node: (n) => this.node(n),
      internal: (owner, n) => this.unknown(`${owner}#${n}`, true),
      branch: (owner) => { const k = this.unknown(`${owner}#branch`, false); this.branches.set(owner.toLowerCase(), k); return k; },
      branchOf: (n) => this.branches.get(n.toLowerCase()) ?? -1,
      device: (n) => byName.get(n.toLowerCase()),
    };
    for (const pass of [false, true]) for (const d of made) {
      if (late.has(d.kind) !== pass) continue;
      try { d.setup(alloc); this.devices.push(d); } catch (e) { this.messages.push({ level: 'error', text: (e as Error).message }); }
    }
    this.states = this.devices.flatMap((d) => d.states);
    if (this.names.length > MAX_UNKNOWNS) throw new SimError(`the circuit has ${this.names.length} unknowns; Konium Designer's simulator takes up to ${MAX_UNKNOWNS}`);
    this.c.size(this.names.length);
    if (!this.devices.length) throw new SimError('the circuit has no devices to simulate');
    if (!this.nodes.size) throw new SimError('the circuit has no nodes');
  }

  private node(name: string): number {
    const k = name.toLowerCase();
    if (k === '0' || k === 'gnd') return -1;
    const have = this.nodes.get(k);
    if (have !== undefined) return have;
    const i = this.names.length;
    this.names.push(name);
    this.nodes.set(k, i);
    return i;
  }
  private unknown(name: string, isNode: boolean): number {
    const i = this.names.length;
    this.names.push(name);
    if (isNode) this.nodes.set(name.toLowerCase(), i);
    return i;
  }
  /** Whether unknown i is a voltage (else a branch current). */
  private isVoltage(i: number): boolean { return !this.names[i]!.endsWith('#branch'); }

  /* ─── Newton–Raphson ─── */

  /** The DC / transient matrix's factors (dense for small circuits, sparse for large). */
  readonly solver: Solver;
  private icForce = new Map<number, number>();
  /** Newton iterations, all told (Advanced Options' ITL5 caps a transient's), and the transient's time points. */
  iterations = 0;
  timepoints = 0;
  /** Steps a live run took without a settled solution, to get past an instant no step would (see liveAdvance). */
  forcedSteps = 0;

  /** Iterate to a solution at the present mode and time; false when it doesn't converge. */
  private newton(maxIter: number): boolean {
    const c = this.c, n = c.n;
    const xnew = new Float64Array(n);
    for (let it = 0, left = maxIter; left > 0; it++, left--) {
      this.iterations++;
      c.clear();
      c.noncon = false;
      for (const d of this.devices) d.load(c);
      for (let i = 0; i < n; i++) if (this.isVoltage(i)) c.add(i, i, this.gshunt);
      for (const [i, v] of this.icForce) { c.add(i, i, 1e10); c.rhs(i, 1e10 * v); }
      if (!this.solver.factor(c)) throw new SimError('singular matrix: a loop of voltage sources or inductors, or a source with nothing across it');
      xnew.set(c.b);
      // What the arithmetic itself can tell apart: a large capacitor at a very short step puts amperes by the hundred thousand
      // into the equations (C/h times its voltage), and a current of picoamperes beside them is lost in the last digits. A
      // current is not asked to settle closer than that, or a short step after a switching edge would never be accepted
      let big = 0;
      for (let i = 0; i < n; i++) { const v = Math.abs(c.b[i]!); if (v > big && Number.isFinite(v)) big = v; }
      const slack = 1e-14 * big;
      this.solver.solve(xnew);
      let conv = !c.noncon && it > 0;
      for (let i = 0; i < n && conv; i++) {
        const a = xnew[i]!, b = c.x[i]!;
        if (!Number.isFinite(a)) { conv = false; break; }
        const tol = c.tol.reltol * Math.max(Math.abs(a), Math.abs(b)) + (this.isVoltage(i) ? c.tol.vntol : c.tol.abstol + slack);
        if (Math.abs(a - b) > tol) conv = false;
      }
      if (xnew.some((v) => !Number.isFinite(v))) return false;
      c.x.set(xnew);
      c.initJunctions = false;
      if (conv) {
        // (A live run) The switches are decided from this solution; where one changed, the equations are solved afresh
        if (c.settle) { let changed = false; for (const d of this.devices) if (d.settle?.(c)) changed = true; if (changed) { it = -1; left = maxIter + 1; continue; } }
        return true;
      }
    }
    return false;
  }

  /** The DC operating point at the present sources, by Newton, then gmin stepping, then source stepping. */
  private operatingPoint(initial?: Float64Array): void {
    const c = this.c;
    c.mode = 'dc';
    c.srcFactor = 1; c.gminExtra = 0;
    const start = () => { if (initial) c.x.set(initial); else { c.x.fill(0); for (const [k, v] of this.circuit.nodeset) { const i = this.nodes.get(k.toLowerCase()); if (i !== undefined) c.x[i] = v; } } c.initJunctions = !initial; };
    start();
    if (this.newton(c.tol.itl1)) return;
    // gmin stepping: a conductance across every junction, taken away a decade at a time
    start();
    let ok = true;
    for (let g = 1e-2; g >= 1e-13; g /= 10) { c.gminExtra = g; if (!this.newton(c.tol.itl1)) { ok = false; break; } }
    c.gminExtra = 0;
    if (ok && this.newton(c.tol.itl1)) { this.messages.push({ level: 'info', text: 'operating point found by gmin stepping' }); return; }
    // Source stepping: the sources brought up from zero
    start();
    c.x.fill(0); c.initJunctions = true;
    let f = 0, step = 1 / Math.max(1, Math.round(c.tol.srcsteps) || 10);
    let last = new Float64Array(c.n);
    while (f < 1) {
      const next = Math.min(1, f + step);
      c.srcFactor = next;
      if (this.newton(c.tol.itl1)) { f = next; last = c.x.slice(); step = Math.min(step * 2, 0.5); }
      else { c.x.set(last); step /= 4; if (step < 1e-6) break; }
    }
    c.srcFactor = 1;
    if (f >= 1) { this.messages.push({ level: 'info', text: 'operating point found by source stepping' }); return; }
    throw new SimError('no convergence finding the operating point (try .NODESET, or check for floating nodes and impossible sources)');
  }

  /* ─── Recording ─── */

  /** The vectors kept at each point: [name, unit, getter]. */
  private probes(): [string, 'V' | 'A' | 'W', () => number][] {
    const c = this.c, col = this.collect;
    const out: [string, 'V' | 'A' | 'W', () => number][] = [];
    const want = (n: string) => !col.only || col.only.has(n.toLowerCase());
    for (const [i, name] of this.names.entries()) {
      if (name.endsWith('#branch')) continue;
      if (name.includes('#')) continue;
      if (name.includes('.') && !col.subcircuitNodes) continue;
      if (want(name)) out.push([name, 'V', () => c.x[i]!]);
    }
    for (const d of this.devices as Device[]) {
      const k = this.branches.get(d.name.toLowerCase());
      if (k !== undefined && (d instanceof VSource || col.deviceCurrents) && want(`${d.name}#branch`)) out.push([`${d.name}#branch`, 'A', () => c.x[k]!]);
      if (!d.probe || (!col.deviceCurrents && !col.powers)) continue;
      if (d.name.includes('.') && !col.subcircuitNodes) continue;
      const kinds = d.probe(c).map(([k]) => k);
      kinds.forEach((k, j) => {
        const isPower = k === 'p';
        if (isPower ? !col.powers : !col.deviceCurrents) return;
        const name = `${d.name}[${k}]`;
        if (want(name)) out.push([name, isPower ? 'W' : 'A', () => d.probe!(c)[j]![1]]);
      });
    }
    return out;
  }

  /** The signals a run keeps (node voltages, supply currents, then device currents and powers as collected). */
  signalNames(): string[] { return this.probes().map(([n]) => n); }

  /* ─── Analyses ─── */

  op(): Plot {
    this.operatingPoint();
    const vectors = this.probes().map(([name, unit, get]) => ({ name, unit, re: [get()] }));
    return { analysis: 'op', title: 'Operating Point', vectors };
  }

  dc(a: Extract<Analysis, { kind: 'dc' }>): Plot {
    const sweeps = a.sweeps.slice(0, 2);
    const setters = sweeps.map((s) => this.sweepSetter(s.src));
    const values = (s: { start: number; stop: number; step: number }) => {
      const out: number[] = [];
      const step = s.step === 0 || Number.isNaN(s.step) ? (s.stop - s.start) / 100 : Math.abs(s.step) * Math.sign(s.stop - s.start || 1);
      const n = Math.min(1_000_000, Math.floor((s.stop - s.start) / step + 1e-9));
      for (let i = 0; i <= n; i++) out.push(s.start + i * step);
      return out;
    };
    const outer = sweeps[1] ? values(sweeps[1]) : [NaN];
    const inner = values(sweeps[0]!);
    const probes = this.probes();
    const vecs = probes.map(([name, unit]) => ({ name, unit, re: [] as number[] }));
    const xs: number[] = [];
    const segments: { start: number; label: string }[] = [];
    let prev: Float64Array | undefined;
    // (the swept sources back to their own values however the sweep ends: the next analysis runs on them)
    try {
      for (const o of outer) {
        if (sweeps[1]) { setters[1]!(o); segments.push({ start: xs.length, label: `${sweeps[1].src}=${o}` }); }
        for (const v of inner) {
          setters[0]!(v);
          this.operatingPoint(prev);
          prev = this.c.x.slice();
          xs.push(v);
          probes.forEach(([, , get], i) => (vecs[i]!.re as number[]).push(get()));
        }
      }
    } finally { setters.forEach((s) => s(undefined)); }
    const src = sweeps[0]!.src;
    return { analysis: 'dc', title: 'DC Sweep', x: { name: src, unit: /^i/i.test(src) ? 'A' : /^temp$/i.test(src) ? '' : 'V', values: xs }, vectors: vecs, ...(segments.length ? { segments } : {}) };
  }

  /** Set a swept source's DC value (undefined: back to its own), or the temperature. */
  private sweepSetter(name: string): (v: number | undefined) => void {
    if (/^temp$/i.test(name)) { const t0 = this.c.tol.temp; return (v) => this.c.setTemp(v ?? t0); }
    const d = this.devices.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (d instanceof VSource || d instanceof ISource) {
      const src = d.el.src!, dc = src.dc, given = src.dcGiven;
      return (v) => { if (v === undefined) { src.dc = dc; src.dcGiven = given; } else { src.dc = v; src.dcGiven = true; } };
    }
    if (d && 'g' in d && d.kind === 'R') { const r = d as unknown as { g: number }; const g0 = r.g; return (v) => { r.g = v === undefined ? g0 : 1 / v; }; }
    throw new SimError(`DC sweep: ${name} isn't an independent source, a resistor or TEMP`);
  }

  tran(a: Extract<Analysis, { kind: 'tran' }>): Plot {
    const c = this.c;
    const { tstop, tstart } = a;
    const tstep = a.tstep > 0 ? a.tstep : tstop / 50;
    const tmax = Math.min(a.tmax > 0 ? a.tmax : Infinity, tstep, (tstop - tstart) / 50) || tstop / 50;
    for (const d of this.devices) if (d instanceof VSource || d instanceof ISource) { d.tstep = tstep; d.tstop = tstop; }
    // Breakpoints: the sources' corners, and the end
    const bps = [...new Set(this.devices.flatMap((d) => d.breaks?.(tstop, tstep) ?? []).concat([tstop]))].sort((x, y) => x - y);
    // Start: the operating point (its states from it), or the initial conditions as given
    c.uic = a.uic;
    if (a.uic) {
      c.x.fill(0);
      for (const [k, v] of this.circuit.ic) { const i = this.nodes.get(k.toLowerCase()); if (i !== undefined) c.x[i] = v; }
      c.mode = 'dc';
      // Device states from the IC values (and a load so devices know their voltages)
      for (const d of this.devices) d.initStates?.(c);
    } else {
      this.icForce.clear();
      for (const [k, v] of this.circuit.ic) { const i = this.nodes.get(k.toLowerCase()); if (i !== undefined) this.icForce.set(i, v); }
      this.operatingPoint();
      if (this.icForce.size) { this.icForce.clear(); }
      for (const d of this.devices) d.initStates?.(c);
    }
    for (const d of this.devices) d.accepted?.();
    const probes = this.probes();
    const vecs = probes.map(([name, unit]) => ({ name, unit, re: [] as number[] }));
    const times: number[] = [];
    const record = (t: number) => { times.push(t); probes.forEach(([, , get], i) => (vecs[i]!.re as number[]).push(get())); };
    c.mode = 'tran';
    c.time = 0;
    if (tstart <= 0) record(0);
    const hmin = Math.max(1e-18, tmax * 1e-11);
    let h = Math.min(tstep, tmax) / 10;
    let order = 1;
    let bp = 0;
    while (bps[bp]! <= 1e-15) bp++;
    let t = 0;
    let firstAfterBreak = true;
    const hist: number[] = [h, h, h];
    let steps = 0;
    const MAX_STEPS = 2_000_000;
    const iter0 = this.iterations;
    while (t < tstop * (1 - 1e-12) && steps++ < MAX_STEPS) {
      // Land on the next breakpoint
      const next = bps[bp] ?? tstop;
      if (t + h > next - hmin) h = next - t;
      if (h < hmin) h = hmin;
      c.hs = [h, ...hist];
      c.order = firstAfterBreak ? 1 : Math.min(order, c.tol.maxord, 2);
      c.time = t + h;
      c.coefficients();
      const save = c.x.slice();
      if (c.tol.itl5 > 0 && this.iterations - iter0 > c.tol.itl5) throw new SimError(`ITL5: the transient took more than ${c.tol.itl5} iterations (raise ITL5 in Advanced Options)`);
      const ok = this.newton(c.tol.itl4);
      if (!ok) {
        c.x.set(save);
        h /= 8;
        firstAfterBreak = true;
        if (h < hmin) throw new SimError(`timestep too small at ${t.toPrecision(6)} s: the transient can't continue`);
        continue;
      }
      // Truncation error: the step this one could have been
      let hNew = Infinity;
      if (c.order >= 1) for (const s of this.states) { const d = s.lte(c); if (d < hNew) hNew = d; }
      if (!firstAfterBreak && hNew < 0.9 * h) {
        c.x.set(save);
        h = Math.max(hNew, hmin);
        continue;
      }
      // Accepted
      t += h;
      for (const s of this.states) s.accept();
      for (const d of this.devices) d.accepted?.();
      hist.unshift(h); hist.length = 3;
      if (t >= tstart * (1 - 1e-12)) record(t);
      let hNext = Math.min(Number.isFinite(hNew) ? hNew : 2 * h, 2 * h, tmax);
      if (Math.abs(t - next) <= hmin * 2) {
        bp++;
        // After a corner: a small step, first order
        const gap = (bps[bp] ?? tstop) - t;
        hNext = Math.min(hNext, 0.1 * Math.min(h, gap), tmax);
        firstAfterBreak = true;
        order = 1;
      } else { firstAfterBreak = false; order = 2; }
      h = Math.max(hNext, hmin);
    }
    if (steps >= MAX_STEPS) this.messages.push({ level: 'warn', text: 'transient stopped: too many time points' });
    this.timepoints += times.length;
    return { analysis: 'tran', title: 'Transient Analysis', x: { name: 'time', unit: 's', values: times }, vectors: vecs };
  }

/* ─── Live: a transient with no end, taken a slice at a time (Live Simulation) ─── */

  private lv: { t: number; h: number; order: number; first: boolean; hist: number[]; /** Steps in a row that found no solution. */ fails: number; /** First-order steps still to take after a fresh start. */ calm: number;
    /** While a switch's turning over is being placed in time (see liveAdvance): the longest step allowed, the time it holds until, and the step short enough to take the turn in. */ cap: number; capUntil: number; fine: number;
    /** The time until which a further turn is taken as it comes (it follows one just placed too closely to be worth placing by itself). */ quietUntil: number } | null = null;
  /** The circuit time a live run has reached. */
  get liveTime(): number { return this.lv?.t ?? 0; }

  /**
   * Start a live run at `time`: from the operating point; or (`uic`) from the initial conditions as
   * given; or (`carry`) from what a run had before the circuit was changed, each node's voltage and
   * each source's and inductor's current taken over by name and whatever is new starting from zero.
   */
  liveStart(o: { uic?: boolean; carry?: ReadonlyMap<string, number>; time?: number } = {}): void {
    const c = this.c, t0 = o.time ?? 0;
    c.settle = true;
    for (const d of this.devices) if (d instanceof VSource || d instanceof ISource) { d.tstep = 1e-9; d.tstop = Infinity; }
    this.icForce.clear();
    c.uic = !!o.uic && !o.carry;
    c.time = t0;
    if (o.carry) {
      c.x.fill(0);
      this.names.forEach((n, i) => { const v = o.carry!.get(n.toLowerCase()); if (v !== undefined && Number.isFinite(v)) c.x[i] = v; });
      c.mode = 'dc'; c.srcFactor = 1; c.gminExtra = 0; c.initJunctions = false;
    } else if (o.uic) {
      c.x.fill(0);
      for (const [k, v] of this.circuit.ic) { const i = this.nodes.get(k.toLowerCase()); if (i !== undefined) c.x[i] = v; }
      c.mode = 'dc';
    } else {
      for (const [k, v] of this.circuit.ic) { const i = this.nodes.get(k.toLowerCase()); if (i !== undefined) this.icForce.set(i, v); }
      this.operatingPoint();
      this.icForce.clear();
    }
    // A switch that remembers (one with hysteresis: a latch, a flip-flop, a blown fuse) is as the run before left it
    if (o.carry) for (const d of this.devices) if (d instanceof Switch) { const v = o.carry.get(`@switch:${d.name.toLowerCase()}`); if (v !== undefined) d.on = d.was = v > 0.5; }
    for (const d of this.devices) d.initStates?.(c);
    for (const d of this.devices) d.accepted?.();
    // (a live run takes junctions' charges by Gear's rule: see Ctx.a0j)
    c.junctionGear = true;
    c.mode = 'tran';
    this.lv = { t: t0, h: 0, order: 1, first: true, hist: [], fails: 0, calm: 0, cap: Infinity, capUntil: 0, fine: 0, quietUntil: -Infinity };
  }

  /** A switch of the live run (by its name, a subcircuit's as X1.S1) put on or off as it stands: a blown fuse made good. False where there is none. */
  liveSetSwitch(name: string, on: boolean): boolean {
    const d = this.devices.find((x) => x instanceof Switch && x.name.toLowerCase() === name.toLowerCase()) as Switch | undefined;
    if (!d) return false;
    d.on = d.was = on;
    this.liveKick();
    return true;
  }

  /** A capacitor of the live run (by its name, a subcircuit's as X1.CH) emptied as it stands: a new fuse is a cold one. False where there is none. */
  liveDischarge(name: string): boolean {
    const d = this.devices.find((x) => x instanceof Capacitor && x.name.toLowerCase() === name.toLowerCase()) as Capacitor | undefined;
    if (!d) return false;
    d.s.reset(0);
    this.liveKick();
    return true;
  }

  /** Something was changed under the run (a value, a switch): the next step starts afresh, short and first order. */
  liveKick(): void { if (this.lv) { this.lv.first = true; this.lv.h = 0; } }

  /**
   * Carry the live run on until its time passes `until`, no step longer than `hmax`, giving up the
   * slice at `deadline` (performance.now()); the time reached. Steps land on the sources' corners
   * and are sized by the truncation error, as the transient analysis sizes them.
   */
  liveAdvance(until: number, hmax: number, deadline = Infinity, onStep?: (time: number) => void): number {
    const c = this.c, L = this.lv;
    if (!L) throw new SimError('the live run has not been started');
    const hmin = Math.max(1e-18, hmax * 1e-9);
    if (!(L.h > 0)) L.h = hmax / 20;
    for (let n = 1; L.t < until; n++) {
      if ((n & 7) === 0 && performance.now() >= deadline) break;
      let next = Infinity;
      for (const d of this.devices) { const b = d.nextBreak?.(L.t); if (b !== undefined && b < next) next = b; }
      if (L.t >= L.capUntil) L.cap = Infinity;
      let h = Math.min(L.h, hmax, L.cap);
      if (L.t + h > next - hmin) h = next - L.t;
      if (h < hmin) h = hmin;
      const hist = L.hist.length ? L.hist : [h, h, h];
      c.hs = [h, ...hist];
      c.order = L.first || L.calm > 0 ? 1 : Math.min(L.order, c.tol.maxord, 2);
      c.time = L.t + h;
      c.coefficients();
      const save = c.x.slice();
      // A step that finds no solution is tried again shorter. What changes all at once (a switch thrown, a source's step onto a
      // diode) is as hard however short the step, so from the second try on the solver has the operating point's allowance of
      // iterations in place of a time step's ten
      if (!this.newton(L.fails ? c.tol.itl1 : c.tol.itl4)) {
        c.x.set(save); for (const d of this.devices) d.rejected?.();
        L.fails++;
        L.h = h / 8; L.first = true;
        if (L.h >= hmin) continue;
        // No step, however short, gets past this instant (a regenerative edge the solver hunts over). An analysis would stop
        // here; a run that is being watched is better served by going on. One first-order step of a hundredth of the longest
        // is taken, with whatever the solver has at the end of it, and the run carries on from there: backward Euler lands on
        // the settled side of an edge. The count of these is kept (forcedSteps)
        const hj = hmax / 100;
        c.hs = [hj, hj, hj, hj]; c.order = 1; c.time = L.t + hj; c.coefficients();
        this.newton(c.tol.itl1);
        if (!c.x.every((v) => Number.isFinite(v))) { c.x.set(save); for (const d of this.devices) d.rejected?.(); throw new SimError(`no solution at ${L.t.toPrecision(6)} s, however short the step`); }
        L.t += hj;
        for (const st of this.states) st.accept();
        for (const d of this.devices) d.accepted?.();
        L.hist = [hj, hj, hj]; L.h = hj; L.first = true; L.order = 1; L.fails = 0;
        this.timepoints++; this.forcedSteps++;
        onStep?.(L.t);
        continue;
      }
      L.fails = 0;
      // A switch that turned over in this step did so somewhere within it, and the step was solved with the switch as it ended
      // from the step's start: an oscillator made of switches (a 555, a Schmitt trigger) so ran early by up to a step at every
      // turn, a third fast at the steps a slow scope allows. The step is not taken. The switch says how far through it it turned,
      // by its control's level at either end; a step nine tenths of that far is taken in its place, and the next one sees the
      // turn again from nearer, until the step it is seen in is a 256th of the first: that one is taken, turn and all.
      // A turn that follows one just placed, within an eighth of the step that one was first seen in, is taken as it comes (the
      // steps there are still short): a master and its slave, or switches that chatter, do not send the step shorter and shorter
      let turned = false, part = Infinity;
      for (const d of this.devices) if (d.changed?.()) { turned = true; const f = d.turnedAt?.() ?? NaN; if (f < part) part = f; }
      let placed = 0;
      if (turned && L.t >= L.quietUntil) {
        if (L.cap === Infinity) L.fine = Math.max(h / 256, hmin * 4);
        if (h > L.fine) {
          c.x.set(save); for (const d of this.devices) d.rejected?.();
          // (where the switch cannot say, a sixteenth of the step)
          L.cap = Math.max(part <= 1 ? part * h * 0.9 : h / 16, L.fine); L.capUntil = L.t + h; L.h = L.cap;
          continue;
        }
        placed = L.fine;
        L.quietUntil = L.t + h + L.fine * 32;
      }
      if (turned) { L.cap = Infinity; L.fine = 0; }
      let hNew = Infinity;
      for (const st of this.states) { const d = st.lte(c); if (d < hNew) hNew = d; }
      // (a step already as short as steps go is taken, whatever its error is reckoned at: there is none shorter to try)
      if (!L.first && hNew < 0.9 * h && h > hmin) { c.x.set(save); for (const d of this.devices) d.rejected?.(); L.h = Math.max(hNew, hmin); continue; }
      L.t += h;
      for (const st of this.states) st.accept();
      for (const d of this.devices) d.accepted?.();
      L.hist = [h, ...hist].slice(0, 3);
      this.timepoints++;
      onStep?.(L.t);
      let hNext = Math.min(Number.isFinite(hNew) ? hNew : 2 * h, 2 * h, hmax);
      // After a fresh start (a corner of a source, a change to the circuit, a failed step) two more steps are first order:
      // what one such step leaves of a fast settling would ring on, undamped, under the second-order rule at steps much
      // longer than the settling (a gate's output read 200 uV either side of 0 V for good after its input was clicked)
      if (L.first) L.calm = 2; else if (L.calm > 0) L.calm--;
      if (Math.abs(L.t - next) <= hmin * 2) { hNext = Math.min(hNext, 0.1 * h); L.first = true; L.order = 1; }
      // (a switch's turn is a fresh start too: what follows it is taken first order, from the short step it was placed with)
      else if (turned) { L.first = true; L.order = 1; }
      else { L.first = false; L.order = 2; }
      L.h = Math.max(hNext, hmin);
      // (from a turn placed in a step a 256th of the one it was seen in, the run goes on at a 32nd, not from the 256th up)
      if (placed > 0) L.h = Math.min(Math.max(L.h, placed * 8), hmax);
    }
    return L.t;
  }

  /** An unknown's present value by name: a node's voltage ('0' and gnd: 0), or a source's or inductor's current ("V1#branch"). */
  valueOf(name: string): number | undefined {
    const k = name.toLowerCase();
    if (k === '0' || k === 'gnd') return 0;
    const i = this.nodes.get(k) ?? this.branches.get(k.replace(/#branch$/, ''));
    return i === undefined ? undefined : this.c.x[i];
  }
  /** Where an unknown is kept, for reading many at every step: −1 for the reference, undefined for a name the circuit doesn't have. */
  unknownAt(name: string): number | undefined {
    const k = name.toLowerCase();
    if (k === '0' || k === 'gnd') return -1;
    return this.nodes.get(k) ?? this.branches.get(k.replace(/#branch$/, ''));
  }
  /** The unknown at `i` (see unknownAt) as it is now. */
  valueAt(i: number): number { return i < 0 ? 0 : this.c.x[i]!; }
  /** Every unknown's present value by its name (what a changed circuit's run starts from). */
  unknownsNow(): Map<string, number> {
    const m = new Map(this.names.map((n, i): [string, number] => [n.toLowerCase(), this.c.x[i]!]));
    for (const d of this.devices) if (d instanceof Switch) m.set(`@switch:${d.name.toLowerCase()}`, d.was ? 1 : 0);
    return m;
  }

  ac(a: Extract<Analysis, { kind: 'ac' }>): Plot {
    this.operatingPoint();
    const freqs = acFrequencies(a.sweep, a.points, a.fstart, a.fstop);
    const ac = new AcCtx();
    const n = this.c.n;
    ac.size(n);
    const solver = new Solver(this.c.tol.pivrel);
    const probes = this.acProbes();
    const vecs = probes.map(([name, unit]) => ({ name, unit, re: [] as number[], im: [] as number[] }));
    for (const f of freqs) {
      ac.clear();
      ac.omega = 2 * Math.PI * f;
      for (const d of this.devices) d.ac?.(ac);
      for (let i = 0; i < n; i++) if (this.isVoltage(i)) ac.add(i, i, this.gshunt + this.c.tol.gmin);
      if (!solver.factor(ac)) throw new SimError(`singular matrix in the AC analysis at ${f} Hz`);
      solver.solve(ac.br, ac.bi);
      probes.forEach(([, , k], i) => { (vecs[i]!.re as number[]).push(ac.br[k]!); (vecs[i]!.im as number[]).push(ac.bi[k]!); });
    }
    return { analysis: 'ac', title: 'AC Analysis', x: { name: 'frequency', unit: 'Hz', values: freqs }, vectors: vecs, complex: true };
  }

  /** AC results: node voltages and branch currents (unknowns). */
  private acProbes(): [string, Unit, number][] {
    const out: [string, Unit, number][] = [];
    const col = this.collect;
    for (const [i, name] of this.names.entries()) {
      if (name.includes('#') && !name.endsWith('#branch')) continue;
      if (name.includes('.') && !col.subcircuitNodes) continue;
      if (col.only && !col.only.has(name.toLowerCase())) continue;
      out.push([name, name.endsWith('#branch') ? 'A' : 'V', i]);
    }
    return out;
  }

  /** .TF: the DC gain from a source to an output, and the input and output resistances. */
  tf(a: Extract<Analysis, { kind: 'tf' }>): Plot {
    this.operatingPoint();
    const n = this.c.n;
    const ac = new AcCtx();
    ac.size(n);
    const src = this.devices.find((d) => d.name.toLowerCase() === a.src.toLowerCase());
    if (!(src instanceof VSource || src instanceof ISource)) throw new SimError(`.TF: ${a.src} isn't an independent source`);
    const out = this.nodes.get(a.out[0].toLowerCase()) ?? -1, ref = this.nodes.get(a.out[1].toLowerCase()) ?? -1;
    const solve = (excite: (ac: AcCtx) => void, zeroSrc: boolean): Float64Array => {
      ac.clear(); ac.omega = 0;
      for (const d of this.devices) {
        if ((d instanceof VSource || d instanceof ISource) && (d !== src || zeroSrc)) {
          const s = d.el.src!; const m = s.acMag, p = s.acPhase; s.acMag = 0; s.acPhase = 0; d.ac?.(ac); s.acMag = m; s.acPhase = p;
        } else if (d !== src) d.ac?.(ac);
      }
      if (!zeroSrc) { const s = src.el.src!; const m = s.acMag, p = s.acPhase; s.acMag = 1; s.acPhase = 0; src.ac(ac); s.acMag = m; s.acPhase = p; }
      excite(ac);
      for (let i = 0; i < n; i++) if (this.isVoltage(i)) ac.add(i, i, this.gshunt + this.c.tol.gmin);
      const solver = new Solver(this.c.tol.pivrel);
      if (!solver.factor(ac)) throw new SimError('.TF: singular matrix');
      solver.solve(ac.br, ac.bi);
      return ac.br.slice();
    };
    const vOut = (x: Float64Array) => (out >= 0 ? x[out]! : 0) - (ref >= 0 ? x[ref]! : 0);
    const x1 = solve(() => {}, false);
    const gain = vOut(x1);
    const rin = src instanceof VSource ? -1 / x1[src.k]! : vOut(x1) === 0 ? Infinity : (x1[src.a] ?? 0) - (x1[src.b] ?? 0);
    const x2 = solve((ac2) => { if (out >= 0) ac2.rhs(out, 1); if (ref >= 0) ac2.rhs(ref, -1); }, true);
    const rout = vOut(x2);
    const label = `V(${a.out[0]}${a.out[1] !== '0' ? `,${a.out[1]}` : ''})`;
    return {
      analysis: 'tf', title: 'Transfer Function', vectors: [
        { name: `transfer_function`, unit: '', re: [gain] }, { name: `${a.src}#input_impedance`, unit: '', re: [rin] }, { name: `output_impedance_at_${label}`, unit: '', re: [rout] },
      ],
      table: { columns: ['Quantity', 'Value'], rows: [[`${label}/${a.src}`, gain.toPrecision(6)], [`Input resistance at ${a.src}`, `${rin.toPrecision(6)} Ω`], [`Output resistance at ${label}`, `${rout.toPrecision(6)} Ω`]] },
    };
  }

  /** The node of a name (ground: −1); throws when there's none. */
  private nodeOf(name: string, what: string): number {
    if (/^(0|gnd)$/i.test(name)) return -1;
    const i = this.nodes.get(name.toLowerCase());
    if (i === undefined) throw new SimError(`${what}: node ${name} not found`);
    return i;
  }

  /**
   * .NOISE: the output noise density and the input-referred one over frequency, each device's part
   * in the output (Points Per Summary above 0), and the totals integrated over the sweep. One
   * adjoint solve per frequency gives every noise source's transfer to the output.
   */
  noise(a: Extract<Analysis, { kind: 'noise' }>): Plot[] {
    this.operatingPoint();
    const c = this.c, n = c.n;
    const src = this.devices.find((d) => d.name.toLowerCase() === a.src.toLowerCase());
    if (!(src instanceof VSource || src instanceof ISource)) throw new SimError(`.NOISE: ${a.src || '(no source)'} isn't an independent source`);
    const out = this.nodeOf(a.out[0], '.NOISE'), ref = this.nodeOf(a.out[1], '.NOISE');
    if (out < 0 && ref < 0) throw new SimError('.NOISE: the output node is ground');
    const freqs = acFrequencies(a.sweep, a.points, a.fstart, a.fstop);
    const ac = new AcCtx();
    ac.size(n);
    const solver = new Solver(this.c.tol.pivrel);
    const yr = new Float64Array(n), yi = new Float64Array(n);
    const noisy = this.devices.filter((d) => d.noise && !d.name.includes('.'));
    const inner = this.devices.filter((d) => d.noise && d.name.includes('.'));
    const onoise: number[] = [], inoise: number[] = [];
    const parts = new Map<string, number[]>(noisy.map((d) => [d.name, []]));
    const at = (v: Float64Array, i: number) => (i >= 0 ? v[i]! : 0);
    for (const f of freqs) {
      ac.clear();
      ac.omega = 2 * Math.PI * f;
      for (const d of this.devices) d.ac?.(ac);
      for (let i = 0; i < n; i++) if (this.isVoltage(i)) ac.add(i, i, this.gshunt + c.tol.gmin);
      if (!solver.factor(ac)) throw new SimError(`.NOISE: singular matrix at ${f} Hz`);
      yr.fill(0); yi.fill(0);
      if (out >= 0) yr[out] = 1;
      if (ref >= 0) yr[ref] = -1;
      solver.solveTransposed(yr, yi);
      const z2 = (p: number, q: number) => { const r = at(yr, p) - at(yr, q), i = at(yi, p) - at(yi, q); return r * r + i * i; };
      let total = 0;
      for (const d of noisy) {
        let s = 0;
        for (const ns of d.noise!(c, f)) s += z2(ns.a, ns.b) * ns.psd;
        total += s;
        parts.get(d.name)!.push(Math.sqrt(s));
      }
      for (const d of inner) for (const ns of d.noise!(c, f)) total += z2(ns.a, ns.b) * ns.psd;
      // The gain from the input source: its unit excitation's right-hand side, through the adjoint
      const hr = src instanceof VSource ? at(yr, src.k) : at(yr, src.b) - at(yr, src.a);
      const hi = src instanceof VSource ? at(yi, src.k) : at(yi, src.b) - at(yi, src.a);
      const h2 = hr * hr + hi * hi;
      onoise.push(Math.sqrt(total));
      inoise.push(h2 > 0 ? Math.sqrt(total / h2) : NaN);
    }
    const inUnit: Unit = src instanceof VSource ? 'V/√Hz' : 'A/√Hz';
    const vectors: Vector[] = [
      { name: 'onoise_spectrum', unit: 'V/√Hz', re: onoise },
      { name: 'inoise_spectrum', unit: inUnit, re: inoise },
    ];
    if (a.pts > 0) for (const [name, v] of parts) if (v.some((x) => x > 0)) vectors.push({ name: `onoise_${name}`, unit: 'V/√Hz', re: v });
    const totals: Vector[] = [
      { name: 'onoise_total', unit: 'V', re: [Math.sqrt(integratePower(freqs, onoise))] },
      { name: 'inoise_total', unit: src instanceof VSource ? 'V' : 'A', re: [Math.sqrt(integratePower(freqs, inoise))] },
    ];
    return [
      { analysis: 'noise', title: 'Noise Spectral Density', x: { name: 'frequency', unit: 'Hz', values: freqs }, vectors },
      { analysis: 'noise', title: 'Integrated Noise', vectors: totals },
    ];
  }

  /**
   * .PZ: the poles and zeros of the transfer function from the input port to the output port —
   * V(out)/V(in) or V(out)/I(in). The small-signal matrices G and C at the operating point give
   * the poles (where G + sC is singular, the input port open — or, for V(out)/V(in), the zeros of
   * the input impedance) and the zeros (the bordered system's roots). A voltage source across the
   * input port is taken out: the test input takes its place [est: as AD's input source]. Units: rad/s.
   */
  pz(a: Extract<Analysis, { kind: 'pz' }>): Plot {
    this.operatingPoint();
    const n = this.c.n;
    if (n > PZ_MAX) throw new SimError(`.PZ: the circuit has ${n} unknowns; the pole-zero analysis takes up to ${PZ_MAX}`);
    const ip = this.nodeOf(a.in[0], '.PZ'), im = this.nodeOf(a.in[1], '.PZ'), op = this.nodeOf(a.out[0], '.PZ'), om = this.nodeOf(a.out[1], '.PZ');
    if (ip === im) throw new SimError('.PZ: the input nodes are the same');
    const ac = new AcCtx();
    ac.size(n);
    ac.omega = 1;
    const across = (d: Device) => d instanceof VSource && ((d.a === ip && d.b === im) || (d.a === im && d.b === ip));
    for (const d of this.devices) {
      if (across(d)) ac.add((d as VSource).k, (d as VSource).k, 1);
      else d.ac?.(ac);
    }
    const G = Array.from({ length: n }, (_, i) => Array.from(ac.gr.subarray(i * n, i * n + n)));
    const C = Array.from({ length: n }, (_, i) => Array.from(ac.gi.subarray(i * n, i * n + n)));
    const port = (p: number, q: number) => { const e = new Array<number>(n).fill(0); if (p >= 0) e[p] = 1; if (q >= 0) e[q] = -1; return e; };
    const eIn = port(ip, im), eOut = port(op, om);
    /** [[G, col], [row, 0]] and [[C, 0], [0, 0]]. */
    const bordered = (col: number[], row: number[]): [number[][], number[][]] => [
      [...G.map((r, i) => [...r, col[i]!]), [...row, 0]],
      [...C.map((r) => [...r, 0]), new Array<number>(n + 1).fill(0)],
    ];
    const roots = (gc: [number[][], number[][]]) => {
      try { return pencilRoots(gc[0], gc[1]); } catch (e) {
        throw new SimError(/every shift/.test((e as Error).message) ? '.PZ: the transfer function is zero at every frequency (is the output connected to the input?)' : `.PZ: ${(e as Error).message}`);
      }
    };
    const poles = a.what === 'zer' ? [] : a.transfer === 'cur' ? roots([G, C]) : roots(bordered(eIn, eIn));
    const zeros = a.what === 'pol' ? [] : roots(bordered(eIn, eOut));
    const order = (z: Complex[]) => z.filter((v) => Number.isFinite(v.re) && Number.isFinite(v.im)).sort((x, y) => Math.hypot(x.re, x.im) - Math.hypot(y.re, y.im) || x.im - y.im);
    const p = order(poles), z = order(zeros);
    const vectors: Vector[] = [...p.map((v, i) => ({ name: `pole(${i + 1})`, unit: '' as Unit, re: [v.re], im: [v.im] })), ...z.map((v, i) => ({ name: `zero(${i + 1})`, unit: '' as Unit, re: [v.re], im: [v.im] }))];
    const row = (name: string, v: Complex) => [name, v.re.toPrecision(6), v.im.toPrecision(6), (Math.hypot(v.re, v.im) / (2 * Math.PI)).toPrecision(6)];
    const label = `V(${a.out[0]}${a.out[1] !== '0' ? `,${a.out[1]}` : ''})/${a.transfer === 'vol' ? 'V' : 'I'}(${a.in[0]}${a.in[1] !== '0' ? `,${a.in[1]}` : ''})`;
    const rows = [...p.map((v, i) => row(`Pole ${i + 1}`, v)), ...z.map((v, i) => row(`Zero ${i + 1}`, v))];
    if (!rows.length) rows.push([a.what === 'zer' ? 'No finite zeros' : a.what === 'pol' ? 'No finite poles' : 'No finite poles or zeros', '', '', '']);
    return {
      analysis: 'pz', title: 'Pole-Zero Analysis', vectors, complex: true,
      table: { columns: [label, 'Real (rad/s)', 'Imaginary (rad/s)', 'Frequency (Hz)'], rows },
    };
  }

  /** Every analysis the netlist asks for, in its order. */
  run(only?: Analysis['kind'][]): Plot[] {
    const plots: Plot[] = [];
    let lastTran: Plot | null = null;
    for (const a of this.circuit.analyses) {
      if (only && !only.includes(a.kind)) continue;
      try {
        switch (a.kind) {
          case 'op': plots.push(this.op()); break;
          case 'dc': plots.push(this.dc(a)); break;
          case 'tran': lastTran = this.tran(a); plots.push(lastTran); break;
          case 'ac': plots.push(this.ac(a)); break;
          case 'tf': plots.push(this.tf(a)); break;
          case 'noise': plots.push(...this.noise(a)); break;
          case 'pz': plots.push(this.pz(a)); break;
          case 'four': if (lastTran) plots.push(fourier(lastTran, a.freq, a.outs, a.harmonics)); else this.messages.push({ level: 'warn', text: '.FOUR needs a transient analysis before it' }); break;
          default: this.messages.push({ level: 'warn', text: `.${(a as Analysis).kind.toUpperCase()} analysis isn't supported yet` });
        }
      } catch (e) {
        this.messages.push({ level: 'error', text: `${a.kind.toUpperCase()}: ${(e as Error).message}` });
      }
    }
    if (this.c.tol.acct > 0) {
      const s = this.solver;
      this.messages.push({ level: 'info', text: `ACCT: ${this.c.n} unknowns (${s.sparse ? 'sparse' : 'dense'} matrix, ordered ${s.orderings}×), ${this.iterations} iterations, ${this.timepoints} transient time points` });
    }
    return plots;
  }
}

/**
 * ∫ S(f)² df over a sweep (S a noise density), each interval taken as a power law between its
 * ends (as SPICE integrates noise), so a log sweep's few points still give the right total.
 */
export function integratePower(f: number[], s: number[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < f.length; i++) {
    const f1 = f[i]!, f2 = f[i + 1]!, p1 = s[i]! ** 2, p2 = s[i + 1]! ** 2;
    if (!(f2 > f1) || !Number.isFinite(p1) || !Number.isFinite(p2)) continue;
    if (p1 <= 0 || p2 <= 0 || f1 <= 0) { sum += 0.5 * (p1 + p2) * (f2 - f1); continue; }
    const e = Math.log(p2 / p1) / Math.log(f2 / f1);
    sum += Math.abs(e + 1) < 1e-9 ? p1 * f1 * Math.log(f2 / f1) : ((p1 * f1) / (e + 1)) * ((f2 / f1) ** (e + 1) - 1);
  }
  return sum;
}

/** The frequencies of an AC sweep: points per decade or octave, or linear. */
export function acFrequencies(sweep: 'dec' | 'oct' | 'lin', points: number, fstart: number, fstop: number): number[] {
  const out: number[] = [];
  const np = Math.max(1, Math.round(points));
  if (sweep === 'lin') { for (let i = 0; i < np; i++) out.push(np === 1 ? fstart : fstart + ((fstop - fstart) * i) / (np - 1)); return out; }
  const base = sweep === 'dec' ? 10 : 2;
  const ratio = base ** (1 / np);
  for (let f = fstart; f <= fstop * (1 + 1e-9) && out.length < 100000; f *= ratio) out.push(f);
  if (out.at(-1)! < fstop * (1 - 1e-9)) out.push(fstop);
  return out;
}

/** Fourier analysis of a transient's last period: DC, each harmonic's magnitude and phase, and the THD. */
export function fourier(tran: Plot, f0: number, outs: string[], harmonics = 9): Plot {
  const t = tran.x!.values, T = 1 / f0, tEnd = t.at(-1)!, tStart = tEnd - T;
  const rows: string[][] = [];
  const vectors: Vector[] = [];
  const N = 1024;
  for (const name of outs) {
    const v = tran.vectors.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!v || tStart < t[0]!) continue;
    const ys: number[] = [];
    let j = 0;
    for (let i = 0; i < N; i++) {
      const ti = tStart + (i * T) / N;
      while (j < t.length - 2 && t[j + 1]! < ti) j++;
      const t0 = t[j]!, t1 = t[j + 1]!, y0 = v.re[j]!, y1 = v.re[j + 1]!;
      ys.push(t1 === t0 ? y0 : y0 + ((y1 - y0) * (ti - t0)) / (t1 - t0));
    }
    const mags: number[] = [], phases: number[] = [];
    for (let k = 0; k <= harmonics; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) { const a = (2 * Math.PI * k * i) / N; re += ys[i]! * Math.cos(a); im -= ys[i]! * Math.sin(a); }
      const scale = k === 0 ? 1 / N : 2 / N;
      mags.push(Math.hypot(re, im) * scale);
      phases.push((Math.atan2(im, re) * 180) / Math.PI + (k ? 90 : 0));
    }
    const thd = Math.sqrt(mags.slice(2).reduce((s, m) => s + m * m, 0)) / (mags[1] || 1) * 100;
    rows.push([v.name, 'DC', '0', mags[0]!.toPrecision(6), '', '', '']);
    for (let k = 1; k <= harmonics; k++) rows.push([v.name, String(k), (k * f0).toPrecision(6), mags[k]!.toPrecision(6), (mags[k]! / (mags[1] || 1)).toPrecision(6), phases[k]!.toFixed(3), (phases[k]! - phases[1]!).toFixed(3)]);
    rows.push([v.name, 'THD', '', `${thd.toPrecision(6)} %`, '', '', '']);
    vectors.push({ name: v.name, unit: 'V', re: mags });
  }
  return { analysis: 'four', title: 'Fourier Analysis', vectors, table: { columns: ['Signal', 'Harmonic', 'Frequency (Hz)', 'Magnitude', 'Normalised Magnitude', 'Phase (°)', 'Normalised Phase (°)'], rows } };
}
