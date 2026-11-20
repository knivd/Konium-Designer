/**
 * Tools › Signal Integrity's runs: the screening of every net of the board in front (or of the
 * project's schematic, its lines the setup's average length), the reflections of the nets picked
 * (the stimulus, unterminated and with each termination tried) and the crosstalk an aggressor
 * puts on its victims — the waveforms opened in SimView.
 */
import { signal } from '@preact/signals';
import type { PcbDocument } from '../model/pcb';
import { siBoardRules, type SiBoardRules } from '../model/drcMore';
import { screenNet, type SiNetResult } from '../si/analyse';
import { couplings, crosstalkWaves } from '../si/crosstalk';
import { DEFAULT_STIMULUS, type SiLimits, type Stimulus } from '../si/rules';
import { TERMINATIONS, runStimulus, type TermKind } from '../si/screen';
import { boardNetwork, starNetwork, type SiContext, type SiNetwork } from '../si/topology';
import type { Plot, Vector } from '../sim/engine';
import type { SimDataDocument } from '../sim/simData';
import { designFacts, projectOfBoard, readSiSetup, siContextOf, type DesignFacts, type SiProjectSetup } from './siProject';
import { activeProject } from './project';
import { showSimData } from './simRun';
import { active, notify, tick, type Project } from './state';
import { breathe } from '../core/breathe';

export interface SiTarget { key: string; name: string; project: Project | null; board: PcbDocument | null }
export interface SiRow extends SiNetResult { netIndex?: number }
export interface SiRun { key: string; name: string; rows: SiRow[]; ms: number; board: boolean }

export const siRun = signal<SiRun | null>(null);
export const siBusy = signal<{ done: number; total: number } | null>(null);
/** Nets marked for crosstalk (Set Aggressor / Set Victim), by name. */
export const siMarks = signal<Map<string, 'aggressor' | 'victim'>>(new Map());

/** What Signal Integrity looks at: the board in front, else the project (or the sheet) in front. */
export function siTarget(): SiTarget | null {
  const d = active.value;
  if (d?.doc.kind === 'PcbDoc') { const board = d.doc as PcbDocument; const p = projectOfBoard(board); return { key: `b:${d.name}`, name: d.name, project: p, board }; }
  if (d?.doc.kind === 'SchDoc') { const p = activeProject(); return { key: p ? `p:${p.name}` : `s:${d.name}`, name: p?.name ?? d.name, project: p, board: null }; }
  return null;
}

interface Prepared { setup: SiProjectSetup; facts: DesignFacts; rules: SiBoardRules | null; ctx: SiContext; nets: { name: string; netIndex?: number; network: () => SiNetwork | string }[] }

/** The setup, the schematic's facts, the board's rules and each net's network (made when asked). A free sheet is its own design. */
function prepare(t: SiTarget): Prepared {
  const setup = readSiSetup(t.project, t.name);
  const facts = designFacts(t.project);
  const rules = t.board ? siBoardRules(t.board) : null;
  const ctx = siContextOf(setup, facts, rules?.supplies);
  const nets: Prepared['nets'] = [];
  if (t.board) {
    const b = t.board;
    b.nets.forEach((n, i) => nets.push({ name: n.name, netIndex: i, network: () => boardNetwork(b, i, ctx) }));
  } else {
    for (const n of facts.compiled?.nets ?? []) nets.push({ name: n.name, network: () => starNetwork(n.name, n.pins.map((p) => ({ designator: p.designator, pin: p.pin })), ctx) });
  }
  nets.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return { setup, facts, rules, ctx, nets };
}

let cached: { key: string; p: Prepared } | null = null;
/** The last prepared design for this target (made again after a setup change or a new analysis). */
function prepared(t: SiTarget): Prepared {
  if (cached?.key === t.key) return cached.p;
  cached = { key: t.key, p: prepare(t) };
  return cached.p;
}
export function forgetPrepared(): void { cached = null; }

/** A net's network now (its pins and lines), or why it has none. */
export function netNetwork(name: string, t: SiTarget | null = siTarget()): SiNetwork | string | null {
  if (!t) return null;
  const n = prepared(t).nets.find((x) => x.name === name);
  return n ? n.network() : null;
}

/** A net's limits: the panel's tolerances, the board's rules over them. */
function limitsOf(p: Prepared, netIndex?: number): SiLimits {
  return { ...p.setup.tolerances, ...(p.rules && netIndex !== undefined ? p.rules.limits(netIndex).limits : {}) };
}

let runId = 0;
/** Screens every net (a few at a time, the panel showing how far it has got). */
export async function analyseDesign(t: SiTarget | null = siTarget()): Promise<SiRun | null> {
  if (!t) { notify('Signal Integrity: open a board, or a schematic of a project', 'error'); return null; }
  const id = ++runId;
  const t0 = performance.now();
  cached = null;
  const p = prepared(t);
  const rows: SiRow[] = [];
  siBusy.value = { done: 0, total: p.nets.length };
  let slice = performance.now();
  for (const [i, n] of p.nets.entries()) {
    rows.push({ ...screenNet(n.name, n.network(), limitsOf(p, n.netIndex)), netIndex: n.netIndex });
    if (performance.now() - slice > 40) {
      siBusy.value = { done: i + 1, total: p.nets.length };
      await breathe();
      if (id !== runId) return null;
      slice = performance.now();
    }
  }
  const run: SiRun = { key: t.key, name: t.name, rows, ms: performance.now() - t0, board: !!t.board };
  siBusy.value = null;
  siRun.value = run;
  tick.value++;
  return run;
}

const resample = (t: Float64Array, v: Float64Array, grid: Float64Array): Float64Array => {
  const out = new Float64Array(grid.length);
  let k = 0;
  for (let i = 0; i < grid.length; i++) {
    const x = grid[i]!;
    while (k < t.length - 2 && t[k + 1]! < x) k++;
    const f = (x - t[k]!) / ((t[k + 1] ?? t[k]!) - t[k]! || 1);
    out[i] = v[k]! + ((v[k + 1] ?? v[k]!) - v[k]!) * Math.max(0, Math.min(1, f));
  }
  return out;
};

const docBase = (name: string) => name.replace(/\.[^.]+$/, '');

/** Reflections: each net picked driven by the stimulus, unterminated and with each termination tried; one chart a net. */
export function reflections(names: string[], t: SiTarget | null = siTarget()): boolean {
  if (!t || !names.length) return false;
  const p = prepared(t);
  const tried = TERMINATIONS.filter((x) => x.kind !== 'none' && p.setup.terms.get(x.kind)?.on);
  const plots: Plot[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const n = p.nets.find((x) => x.name === name);
    const nw = n?.network();
    if (!n || !nw || typeof nw === 'string') { skipped.push(`${name}${typeof nw === 'string' ? ` (${nw})` : ''}`); continue; }
    const stim: Stimulus = (t.board && n.netIndex !== undefined ? p.rules?.stimulus(n.netIndex) : null) ?? p.setup.stimulus ?? DEFAULT_STIMULUS;
    const base = runStimulus(nw, stim);
    const vectors: Vector[] = base.names.map((nm, i) => ({ name: nm, unit: 'V', re: Array.from(base.v[i]!) }));
    for (const term of tried) {
      const w = runStimulus(nw, stim, term.kind as TermKind, p.setup.terms.get(term.kind)?.values);
      w.names.forEach((nm, i) => vectors.push({ name: `${nm} (${term.label})`, unit: 'V', re: Array.from(resample(w.t, w.v[i]!, base.t)) }));
    }
    plots.push({ analysis: 'tran', title: name, x: { name: 'time', unit: 's', values: Array.from(base.t) }, vectors });
  }
  if (!plots.length) { notify(`Signal Integrity: nothing to show (${skipped.join('; ')})`, 'error'); return false; }
  const doc: SimDataDocument = {
    kind: 'SimData', name: `${docBase(t.name)}_Reflections.sdf`, title: `Reflections — ${t.name}`, date: new Date().toString(), plots,
    messages: skipped.map((s) => ({ level: 'warn' as const, text: `Not analysed: ${s}` })),
    charts: plots.map((pl, k) => ({ title: pl.title, source: k, plots: [pl.vectors.map((v) => ({ expr: v.name }))] })), active: 0, dirty: false,
  };
  showSimData(t.project, doc);
  if (skipped.length) notify(`Signal Integrity: not analysed — ${skipped.join('; ')}`);
  return true;
}

/**
 * Crosstalk: the aggressor driven by the stimulus, the noise its coupled sections put on each
 * victim's near and far ends; the aggressor's driver on the top plot, the victims' noise below.
 */
export function crosstalk(aggressor: string, victims: string[], t: SiTarget | null = siTarget()): boolean {
  if (!t?.board) { notify('Signal Integrity: crosstalk needs a routed board', 'error'); return false; }
  const b = t.board;
  const p = prepared(t);
  const a = p.nets.find((x) => x.name === aggressor);
  const nw = a?.network();
  if (!a || a.netIndex === undefined || !nw || typeof nw === 'string') { notify(`Signal Integrity: the aggressor ${aggressor} can't be analysed${typeof nw === 'string' ? ` (${nw})` : ''}`, 'error'); return false; }
  const stim = p.rules?.stimulus(a.netIndex) ?? p.setup.stimulus;
  const w = runStimulus(nw, stim);
  const vIdx = victims.map((v) => b.nets.findIndex((n) => n.name === v)).filter((i) => i >= 0);
  const secs = couplings(b, a.netIndex, vIdx);
  const vectors: Vector[] = [{ name: `${aggressor} ${w.names[0]}`, unit: 'V', re: Array.from(w.v[0]!) }];
  const noise: string[] = [];
  const summary: string[] = [];
  for (const vi of vIdx) {
    const name = b.nets[vi]!.name;
    const mine = secs.filter((s) => s.victim === vi);
    if (!mine.length) { summary.push(`${name}: not beside ${aggressor}`); continue; }
    const x = crosstalkWaves(w.t, w.v[0]!, mine);
    vectors.push({ name: `${name} near end`, unit: 'V', re: Array.from(x.near) }, { name: `${name} far end`, unit: 'V', re: Array.from(x.far) });
    noise.push(`${name} near end`, `${name} far end`);
    const peak = (a: Float64Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const len = mine.reduce((s, c) => s + c.length, 0);
    summary.push(`${name}: ${(len / 10_000).toFixed(0)} mil beside it, near end ${(peak(x.near) * 1000).toFixed(0)} mV, far end ${(peak(x.far) * 1000).toFixed(0)} mV`);
  }
  if (!noise.length) { notify(`Signal Integrity: no victim runs beside ${aggressor}`, 'error'); return false; }
  const plot: Plot = { analysis: 'tran', title: `Crosstalk ${aggressor}`, x: { name: 'time', unit: 's', values: Array.from(w.t) }, vectors };
  const doc: SimDataDocument = {
    kind: 'SimData', name: `${docBase(t.name)}_Crosstalk.sdf`, title: `Crosstalk — ${t.name}`, date: new Date().toString(), plots: [plot],
    messages: summary.map((s) => ({ level: 'info' as const, text: s })),
    charts: [{ title: plot.title, source: 0, plots: [[{ expr: vectors[0]!.name }], noise.map((expr) => ({ expr }))] }], active: 0, dirty: false,
  };
  showSimData(t.project, doc);
  notify(`Crosstalk: ${summary.join('; ')}`);
  return true;
}
