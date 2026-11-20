/**
 * Temperature Sweep, Parameter Sweep and Monte Carlo: every analysis of the netlist run again for
 * each temperature (.STEP TEMP, or SPICE2's .TEMP with several values), each value of a part or
 * a model parameter (.STEP R1 …, .STEP Q1[BF] …), and each Monte Carlo run (.MC: resistors,
 * capacitors, inductors, transistors' gain and DC sources varied within their tolerances). The
 * runs' results are merged into one plot per analysis, each signal once per run with the run's
 * suffix (OUT_p1, OUT_p2 …; _t for a temperature sweep, _mc for Monte Carlo, _r when they are
 * combined) [est: AD's names], so SimView draws a signal's runs together.
 */
import { COLLECT_DEFAULT, SimError, Simulator, type Collect, type Plot, type SimMessage, type Vector } from './engine';
import type { Circuit, Element, McCard, StepCard } from './netlist';
import { engineering } from './num';

interface Dim { kind: 't' | 'p' | 'mc'; values: { label: string; apply: (c: Circuit, run: number) => void }[] }
export interface Run { suffix: string; label: string }

const findEl = (c: Circuit, name: string): Element | undefined => c.elements.find((e) => e.name.toLowerCase() === name.toLowerCase());

/** Set a part's value or a model parameter on a circuit (its own copy); `relative`: added to what it was. */
export function setTarget(c: Circuit, target: string, v: number, relative: boolean): void {
  if (/^temp$/i.test(target)) { c.options.temp = relative ? (typeof c.options.temp === 'number' ? c.options.temp : 27) + v : v; return; }
  const m = /^([^[\]]+)(?:\[([^\]]+)\])?$/.exec(target.trim());
  if (!m) throw new SimError(`sweep: "${target}" isn't a part or a part's parameter`);
  const el = findEl(c, m[1]!);
  if (!el) throw new SimError(`sweep: there's no part ${m[1]} in the netlist`);
  const p = m[2]?.toLowerCase();
  const own = !p || ['value', 'resistance', 'r', 'capacitance', 'c', 'inductance', 'l', 'dc'].includes(p);
  if (own && (el.kind === 'R' || el.kind === 'C' || el.kind === 'L' || el.kind === 'E' || el.kind === 'F' || el.kind === 'G' || el.kind === 'H')) {
    el.value = relative ? (el.value ?? 0) + v : v;
    return;
  }
  if (own && (el.kind === 'V' || el.kind === 'I') && el.src) {
    el.src.dc = relative ? el.src.dc + v : v;
    el.src.dcGiven = true;
    return;
  }
  if (!p) throw new SimError(`sweep: ${el.name} has no value of its own to sweep; name a model parameter (${el.name}[BF])`);
  if (p in el.params) { el.params[p] = relative ? el.params[p]! + v : v; return; }
  const model = el.model ? c.models.get(el.model.toLowerCase()) : undefined;
  if (!model) throw new SimError(`sweep: ${el.name} has no model with ${p.toUpperCase()}`);
  // The part's own copy of its model, so the others keep theirs
  const name = `${model.name}~${el.name}`;
  const mine = c.models.get(name.toLowerCase()) ?? { ...model, name, params: { ...model.params } };
  c.models.set(name.toLowerCase(), mine);
  el.model = name;
  mine.params[p] = relative ? (mine.params[p] ?? 0) + v : v;
}

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The transistor parameter Monte Carlo varies: BJT's BF, MOSFET's KP (or UO with TOX), JFET's BETA [est: AD's choice]. */
const GAIN: Record<string, [param: string, dflt: number]> = { Q: ['bf', 100], J: ['beta', 1e-4] };

/** One Monte Carlo run's variations: each top-level part's value a random step within its tolerance. */
function monteCarlo(c: Circuit, mc: McCard, run: number): void {
  const seed = mc.seed >= 0 ? mc.seed : MC_SESSION_SEED;
  const rand = rng(seed * 7919 + run * 104729 + 17);
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const step = () => (mc.dist === 'wcase' ? (rand() < 0.5 ? -1 : 1) : mc.dist === 'gauss' ? Math.max(-1, Math.min(1, gauss() / 3)) : 2 * rand() - 1);
  for (const el of c.elements) {
    if (el.name.includes('.')) continue;
    const own = mc.specific.get(el.name.toLowerCase());
    const tol = own ?? (el.kind === 'R' ? mc.res : el.kind === 'C' ? mc.cap : el.kind === 'L' ? mc.ind : el.kind === 'Q' || el.kind === 'M' || el.kind === 'J' ? mc.tran : el.kind === 'V' || el.kind === 'I' ? mc.dcsrc : 0);
    if (!tol) continue;
    const k = 1 + tol * step();
    if ((el.kind === 'R' || el.kind === 'C' || el.kind === 'L') && el.value !== undefined) el.value *= k;
    else if ((el.kind === 'V' || el.kind === 'I') && el.src && el.src.dc !== 0) el.src.dc *= k;
    else if (el.kind === 'Q' || el.kind === 'M' || el.kind === 'J') {
      const model = el.model ? c.models.get(el.model.toLowerCase()) : undefined;
      if (!model) continue;
      const [p, d] = el.kind === 'M' ? (model.params.kp === undefined && model.params.tox !== undefined ? ['uo', model.params.u0 ?? 600] as [string, number] : ['kp', 2e-5] as [string, number]) : GAIN[el.kind]!;
      setTarget(c, `${el.name}[${p}]`, (model.params[p] ?? d) * k, false);
    }
  }
}
/** Seed -1: a new seed each session (Monte Carlo varies from one run of the simulation to the next). */
const MC_SESSION_SEED = Math.floor(Math.random() * 1e6);

/** The sweeps a circuit asks for, as dimensions to run through (none: one plain run). */
export function sweepDims(c: Circuit): Dim[] {
  const dims: Dim[] = [];
  const fmt = (v: number) => engineering(v).replace(/\.?0+(?=[a-zA-Zµ]*$)/, '').replace(/^-?$/, '0');
  for (const s of c.steps as StepCard[]) {
    const temp = /^temp$/i.test(s.target);
    dims.push({ kind: temp ? 't' : 'p', values: s.values.map((v) => ({
      label: `${temp ? 'TEMP' : s.target}${s.relative ? '+' : '='}${fmt(v)}${temp ? '°C' : ''}`,
      apply: (cc: Circuit) => setTarget(cc, s.target, v, s.relative),
    })) });
  }
  if (c.temps.length > 1 && !c.steps.some((s) => /^temp$/i.test(s.target))) {
    dims.push({ kind: 't', values: c.temps.map((v) => ({ label: `TEMP=${fmt(v)}°C`, apply: (cc: Circuit) => { cc.options.temp = v; } })) });
  }
  if (c.mc) {
    const mc = c.mc;
    dims.push({ kind: 'mc', values: Array.from({ length: mc.runs }, (_, i) => ({ label: `Monte Carlo run ${i + 1}`, apply: (cc: Circuit) => monteCarlo(cc, mc, i) })) });
  }
  return dims;
}

/** Every combination of the dimensions (the first varying fastest), with their suffixes and labels. */
export function sweepRuns(dims: Dim[]): { run: Run; apply: (c: Circuit) => void }[] {
  if (!dims.length) return [];
  const kinds = new Set(dims.map((d) => d.kind));
  const letter = kinds.size > 1 ? 'r' : [...kinds][0]!;
  let combos: Dim['values'][number][][] = [[]];
  for (const d of dims) combos = d.values.flatMap((v) => combos.map((cmb) => [...cmb, v]));
  const MAX = 500;
  if (combos.length > MAX) throw new SimError(`the sweeps ask for ${combos.length} runs; Konium Designer runs up to ${MAX}`);
  return combos.map((cmb, i) => ({
    run: { suffix: `_${letter}${i + 1}`, label: cmb.map((v) => v.label).join(', ') },
    apply: (c: Circuit) => cmb.forEach((v) => v.apply(c, i)),
  }));
}

/** A run's values on the first run's X (straight between its points; complex parts each). */
function resample(xs: number[], from: number[], ys: ArrayLike<number>): number[] {
  const out = new Array<number>(xs.length);
  let j = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    while (j < from.length - 2 && from[j + 1]! < x) j++;
    const x0 = from[j]!, x1 = from[j + 1] ?? x0, y0 = ys[j]!, y1 = ys[j + 1] ?? y0;
    out[i] = x1 === x0 ? y0 : x <= x0 ? y0 : x >= x1 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return out;
}
const sameX = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= 1e-12 * Math.max(1, Math.abs(v)));

/** The runs' plots, one per analysis: each run's vectors under its suffix, tables with a Run column. */
export function mergeRuns(runs: Run[], results: (Plot[] | null)[]): Plot[] {
  const key = (p: Plot, seen: Map<string, number>) => { const k = `${p.analysis}|${p.title}`; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return `${k}|${n}`; };
  const order: string[] = [];
  const byKey = new Map<string, Plot>();
  results.forEach((plots, r) => {
    if (!plots) return;
    const seen = new Map<string, number>();
    for (const p of plots) {
      const k = key(p, seen);
      let m = byKey.get(k);
      if (!m) {
        m = { analysis: p.analysis, title: p.title, vectors: [], runs, ...(p.x ? { x: p.x } : {}), ...(p.complex ? { complex: true } : {}), ...(p.segments ? { segments: p.segments } : {}),
          ...(p.table ? { table: { columns: ['Run', ...p.table.columns], rows: [] } } : {}) };
        byKey.set(k, m);
        order.push(k);
      }
      const suffix = runs[r]!.suffix;
      const remap = m.x && p.x && !sameX(m.x.values, p.x.values);
      for (const v of p.vectors) {
        const nv: Vector = { name: `${v.name}${suffix}`, unit: v.unit, re: remap ? resample(m.x!.values, p.x!.values, v.re) : v.re };
        if (v.im) nv.im = remap ? resample(m.x!.values, p.x!.values, v.im) : v.im;
        m.vectors.push(nv);
      }
      if (p.table && m.table) for (const row of p.table.rows) m.table.rows.push([runs[r]!.label, ...row]);
    }
  });
  return order.map((k) => byKey.get(k)!);
}

/** The netlist's analyses, swept as it asks: the plots (merged across runs) and the messages. */
export function runAll(c: Circuit, collect: Collect = COLLECT_DEFAULT): { plots: Plot[]; messages: SimMessage[] } {
  if (c.temps.length === 1 && c.options.temp === undefined) c.options.temp = c.temps[0]!;
  const runs = sweepRuns(sweepDims(c));
  if (!runs.length) {
    const sim = new Simulator(c, {}, collect);
    const plots = sim.run();
    return { plots, messages: sim.messages };
  }
  const messages: SimMessage[] = [];
  const said = new Map<string, number>();
  const results = runs.map(({ run, apply }) => {
    const cc = structuredClone(c);
    try {
      apply(cc);
      const sim = new Simulator(cc, {}, collect);
      const plots = sim.run();
      for (const m of sim.messages) {
        const n = said.get(m.text) ?? 0;
        said.set(m.text, n + 1);
        if (m.level === 'info' ? n === 0 : n < 3) messages.push(m.level === 'info' ? m : { ...m, text: `${run.label}: ${m.text}` });
      }
      return plots;
    } catch (e) {
      messages.push({ level: 'error', text: `${run.label}: ${(e as Error).message}` });
      return null;
    }
  });
  messages.unshift({ level: 'info', text: `${runs.length} runs: ${runs[0]!.run.label} … ${runs.at(-1)!.run.label}` });
  return { plots: mergeRuns(runs.map((r) => r.run), results), messages };
}
