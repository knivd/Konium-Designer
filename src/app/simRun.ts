/**
 * Mixed Sim: Design › Simulate › Mixed Sim compiles the project, writes its netlist
 * (<project>.nsx, opened with the project's generated files), runs it in a worker and opens the
 * results in SimView (<project>.sdf), the Active Signals on show. A netlist open on its own runs
 * as written (Simulate › Run Simulation). Messages go to the Messages panel as Mixed Sim's.
 */
import { signal } from '@preact/signals';
import SimWorker from '../sim/worker?worker&inline';
import { compileProject, type CompiledProject, type SheetInput } from '../model/compile';
import type { SchDocument } from '../model/sch';
import { projectNetlist, type ModelFinder, type SimNetlist } from '../sim/adNetlist';
import type { Collect, Plot, SimMessage } from '../sim/engine';
import { collectFor, readSimSettings, type SimSettings } from '../sim/settings';
import { defaultChart, type ChartView, type SimDataDocument } from '../sim/simData';
import { evalWave } from '../sim/waveExpr';
import type { SimTextDocument } from '../sim/simText';
import { active, activeId, docs, notify, projects, replaceMessages, tick, type OpenDoc, type Project } from './state';
import { showPanel } from './dock/store';
import { activeProject, compileOptions, crossProbe, projectSheets } from './project';
import { openDocument } from './actions';

export const simRunning = signal(false);

let worker: Worker | null = null;
let nextId = 1;
let pending: { id: number; resolve: (r: SimResult | null) => void } | null = null;

export interface SimResult { plots: Plot[]; messages: SimMessage[]; ms: number }

function getWorker(): Worker {
  if (worker) return worker;
  worker = new SimWorker();
  worker.onmessage = (e: MessageEvent<{ id: number } & SimResult>) => {
    if (!pending || e.data.id !== pending.id) return;
    const p = pending; pending = null; simRunning.value = false;
    p.resolve({ plots: e.data.plots, messages: e.data.messages, ms: e.data.ms });
  };
  worker.onerror = (e) => {
    const p = pending; pending = null; simRunning.value = false;
    worker?.terminate(); worker = null;
    p?.resolve({ plots: [], messages: [{ level: 'error', text: `The simulator stopped: ${e.message || 'an internal error'}` }], ms: 0 });
  };
  return worker;
}

/** Run a netlist; null when aborted (Abort Simulation) or another run took its place. */
export function runNetlist(text: string, files: Record<string, string> = {}, collect?: Collect): Promise<SimResult | null> {
  if (pending) abortSimulation();
  const id = nextId++;
  simRunning.value = true;
  return new Promise((resolve) => {
    pending = { id, resolve };
    getWorker().postMessage({ id, text, files, collect });
  });
}

/** SimView › Abort Simulation: the worker stops where it is. */
export function abortSimulation(): void {
  if (!pending) return;
  const p = pending; pending = null; simRunning.value = false;
  worker?.terminate(); worker = null;
  p.resolve(null);
  notify('Simulation aborted');
}

/* ─── Models ─────────────────────────────────────────────────────────────────────────── */

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Model files: the project's own (opened or not), then any open model document, then Konium's built-in ones. */
export function modelFinder(p: Project | null): ModelFinder {
  return (entity, kind) => {
    const want = `${entity}.${kind}`.toLowerCase();
    const open = docs.value.find((d) => d.doc.kind === 'SimText' && d.name.toLowerCase() === want && (!p || d.projectId === p.id || !d.projectId));
    if (open) return { text: (open.doc as SimTextDocument).text, from: open.name };
    if (p) for (const [k, f] of p.files) if (k.split('/').pop() === want) return { text: textOf(f.bytes), from: f.name };
    return null;
  };
}

/** Every model file the netlist could .include: the project's and the open ones, by name. */
export function includeFiles(p: Project | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (p) for (const [k, f] of p.files) if (/\.(mdl|ckt|lib|inc|sub|cir)$/i.test(k)) out[k.split('/').pop()!] = textOf(f.bytes);
  for (const d of docs.value) if (d.doc.kind === 'SimText' && (!p || d.projectId === p.id || !d.projectId)) out[d.name] = (d.doc as SimTextDocument).text;
  return out;
}

/* ─── Projects ───────────────────────────────────────────────────────────────────────── */

export const simStem = (p: Project | null, sheets: SheetInput[]) => (p?.name ?? sheets[0]?.name ?? 'Mixed Sim').replace(/\.(prjpcb|schdoc)$/i, '');

/** What a run of the project takes: its sheets (Sheets to Netlist), compiled, and its netlist. */
export function projectSimInput(p: Project | null, s: SimSettings = readSimSettings(p?.prj)): { sheets: SheetInput[]; compiled: CompiledProject; netlist: SimNetlist } | null {
  let sheets = projectSheets(p);
  if (s.sheets === 'Active sheet') {
    const d = active.value;
    if (d?.doc.kind === 'SchDoc') sheets = sheets.filter((x) => x.name.toLowerCase() === d.name.toLowerCase()).concat(sheets.some((x) => x.name.toLowerCase() === d.name.toLowerCase()) ? [] : [{ name: d.name, doc: d.doc as SchDocument }]);
  }
  if (!sheets.length) return null;
  const compiled = compileProject(sheets, compileOptions(p));
  return { sheets, compiled, netlist: projectNetlist(compiled, sheets, s, modelFinder(p), 'Mixed Sim') };
}

/** A generated document (the netlist, the results) in the project: replaced in its tab, or opened. */
function generated(p: Project | null, name: string, make: () => OpenDoc | null, update: (od: OpenDoc) => void): OpenDoc | null {
  const od = docs.value.find((d) => d.name.toLowerCase() === name.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null));
  if (od) { update(od); docs.value = [...docs.value]; tick.value++; return od; }
  return make();
}

function openNetlist(p: Project | null, name: string, text: string): void {
  generated(p, name,
    () => { const od = openDocument({ name, bytes: new TextEncoder().encode(text) }, p?.id, false); return od; },
    (od) => { if (od.doc.kind === 'SimText') { od.doc.text = text; od.doc.dirty = false; } });
}

/** Messages as the Messages panel shows them (a part's message cross-probes to it). */
function report(doc: string, items: { level: SimMessage['level']; text: string; designator?: string }[], compiled: CompiledProject | null, p: Project | null, summary: string, level: SimMessage['level']): void {
  replaceMessages('Mixed Sim', [
    ...items.map((m) => {
      const c = m.designator && compiled ? compiled.components.find((x) => x.designator === m.designator) : undefined;
      return { doc, level: m.level, message: m.text, locate: c?.refs.length ? () => crossProbe(c.refs, p) : undefined };
    }),
    { doc, level, message: summary },
  ]);
  if (items.some((m) => m.level !== 'info')) showPanel('messages');
}

/** Results into SimView: the Active Signals on show on each chart (or, Keep last setup, the waves shown before). */
function openResults(p: Project | null, name: string, r: SimResult, title: string, netlist: string, active: string[], keep: boolean): OpenDoc | null {
  const prev = docs.value.find((d) => d.name.toLowerCase() === name.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null))?.doc as SimDataDocument | undefined;
  /** A chart per analysis: as before (Keep last setup), else the Active Signals each in a plot of its own. */
  const chartFor = (plot: Plot, k: number): ChartView => {
    const names = plot.vectors.map((v) => v.name);
    const was = keep ? prev?.charts.find((c) => prev.plots[c.source]?.analysis === plot.analysis && prev.plots[c.source]?.title === plot.title) : undefined;
    if (was) {
      const plots = was.plots.map((pl) => pl.filter((w) => { try { return names.includes(w.expr) || !!evalWave(w.expr, plot); } catch { return false; } })).filter((pl) => pl.length);
      if (plots.length) return { title: plot.title, source: k, plots };
    }
    if (plot.analysis === 'noise' && plot.x) {
      // Output and input noise, then the parts' shares of the output noise (the six largest) together
      const parts = plot.vectors.filter((v) => /^onoise_(?!spectrum)/.test(v.name)).map((v) => ({ v, sum: Array.from(v.re).reduce((t, x) => t + x * x, 0) }))
        .sort((a, b) => b.sum - a.sum).slice(0, 6).map((x) => x.v.name);
      const plots = [names.filter((n) => /^onoise_spectrum/.test(n)), names.filter((n) => /^inoise_spectrum/.test(n)), parts].filter((pl) => pl.length).map((pl) => pl.map((expr) => ({ expr })));
      return { title: plot.title, source: k, plots };
    }
    // A swept run: each signal's runs drawn together (OUT_p1, OUT_p2 …)
    const runs = plot.runs;
    const bare = runs ? [...new Set(names.map((n) => n.replace(/_(?:p|t|mc|r)\d+$/, '')))] : names;
    const want = active.filter((a) => bare.some((n) => n.toLowerCase() === a.toLowerCase())).map((a) => bare.find((n) => n.toLowerCase() === a.toLowerCase())!);
    const pick = want.length ? want : bare.filter((n) => !/[[#]/.test(n)).slice(0, 4);
    if (runs) return { title: plot.title, source: k, plots: pick.map((b) => runs.map((r) => `${b}${r.suffix}`).filter((n) => names.includes(n)).map((expr) => ({ expr }))).filter((pl) => pl.length) };
    return defaultChart(plot, k, pick);
  };
  const date = new Date().toString();
  const doc: SimDataDocument = { kind: 'SimData', name, title, date, plots: r.plots, messages: r.messages, charts: r.plots.map(chartFor), active: 0, netlist, dirty: false, stored: prev?.stored };
  // The chart in front: the first transient, AC or DC sweep, else the operating point
  const front = r.plots.findIndex((x) => x.analysis === 'tran' || x.analysis === 'ac' || x.analysis === 'dc' || (x.analysis === 'noise' && !!x.x));
  doc.active = front >= 0 ? front : 0;
  const od = generated(p, name,
    () => { const o = openDocument({ name, bytes: new Uint8Array() }, p?.id, true); if (o) o.doc = doc; return o; },
    (o) => { o.doc = doc; });
  if (od) { activeId.value = od.id; docs.value = [...docs.value]; tick.value++; }
  return od;
}

/** Results made elsewhere (Signal Integrity's waveforms) into SimView: replaced in their tab, or opened. */
export function showSimData(p: Project | null, doc: SimDataDocument): OpenDoc | null {
  const prev = docs.value.find((d) => d.name.toLowerCase() === doc.name.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null))?.doc as SimDataDocument | undefined;
  if (prev?.kind === 'SimData' && prev.stored) doc.stored = prev.stored;
  const od = generated(p, doc.name,
    () => { const o = openDocument({ name: doc.name, bytes: new Uint8Array() }, p?.id, true); if (o) o.doc = doc; return o; },
    (o) => { o.doc = doc; });
  if (od) { activeId.value = od.id; docs.value = [...docs.value]; tick.value++; }
  return od;
}

/** Design › Simulate › Mixed Sim's run: netlist, simulate, results. */
export async function simulateProject(p: Project | null = activeProject(), s: SimSettings = readSimSettings(p?.prj)): Promise<boolean> {
  const input = projectSimInput(p, s);
  if (!input) { notify('Mixed Sim: open a schematic, or a project with schematics', 'error'); return false; }
  const { compiled, netlist, sheets } = input;
  const stem = simStem(p, sheets);
  const nsx = `${stem}.nsx`;
  openNetlist(p, nsx, netlist.text);
  const errors = netlist.messages.filter((m) => m.level === 'error');
  if (errors.length) {
    report(nsx, netlist.messages, compiled, p, `Mixed Sim: ${errors.length} error${errors.length > 1 ? 's' : ''} in the netlist — not simulated`, 'error');
    notify(`Mixed Sim: ${errors.length} netlist error${errors.length > 1 ? 's' : ''} (see Messages)`, 'error');
    return false;
  }
  const slow = setTimeout(() => { if (simRunning.value) notify('Mixed Sim: simulating…'); }, 400);
  const active = s.activeSignals.length ? s.activeSignals : netlist.namedNets;
  const r = await runNetlist(netlist.text, includeFiles(p), collectFor(s, active));
  clearTimeout(slow);
  if (!r) return false;
  const failed = r.messages.filter((m) => m.level === 'error').length;
  report(nsx, [...netlist.messages, ...r.messages], compiled, p,
    failed && !r.plots.length ? `Mixed Sim: the simulation failed (${failed} error${failed > 1 ? 's' : ''})` : `Mixed Sim: ${r.plots.length} analys${r.plots.length === 1 ? 'is' : 'es'} in ${(r.ms / 1000).toFixed(2)} s`,
    failed && !r.plots.length ? 'error' : 'info');
  if (!r.plots.length) { notify('Mixed Sim: the simulation failed (see Messages)', 'error'); return false; }
  openResults(p, `${stem}.sdf`, r, stem, nsx, active, s.simview === 'Keep last setup');
  return true;
}

/** Simulate › Run Simulation (a netlist document): the text as it stands. */
export async function simulateNetlistDoc(od: OpenDoc | null = active.value): Promise<boolean> {
  if (!od || od.doc.kind !== 'SimText') return false;
  const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) ?? null : null;
  const text = od.doc.text;
  const r = await runNetlist(text, includeFiles(p), { deviceCurrents: true, powers: true, subcircuitNodes: false });
  if (!r) return false;
  const failed = r.messages.filter((m) => m.level === 'error').length;
  report(od.name, r.messages, null, p, r.plots.length ? `Mixed Sim: ${r.plots.length} analys${r.plots.length === 1 ? 'is' : 'es'} in ${(r.ms / 1000).toFixed(2)} s` : `Mixed Sim: the simulation failed (${failed} error${failed === 1 ? '' : 's'})`, r.plots.length ? 'info' : 'error');
  if (!r.plots.length) { notify('Mixed Sim: the simulation failed (see Messages)', 'error'); return false; }
  const saves = [...text.matchAll(/^\s*\.(?:save|probe|plot\s+\w+)\s+(.+)$/gim)].flatMap((m) => m[1]!.split(/\s+/)).map((x) => x.replace(/^v\((.*)\)$/i, '$1'));
  openResults(p, od.name.replace(/\.[^.]+$/, '.sdf'), r, od.name.replace(/\.[^.]+$/, ''), od.name, saves, true);
  return true;
}
