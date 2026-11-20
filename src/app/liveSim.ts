/**
 * Live Simulation: the sheet in front runs as a circuit while it is drawn. Its wires and pins
 * take the colour of their voltage, dots move along them with the current, and the value under
 * the cursor is read out. The circuit is the sheet's own netlist (the simulator's, with every
 * pin metered), stepped a little at every frame; a change to the sheet carries the run on from
 * where it was.
 */
import { signal } from '@preact/signals';
import type { Vec2 } from '../core/geom';
import { css, rgba, type Scene } from '../render/Scene';
import { SchEditor } from '../editors/sch/SchEditor';
import { compileProject, type CompiledProject } from '../model/compile';
import { liveGeometry, runCurrents, type LiveGeometry } from '../model/liveWires';
import { bagOf, type SchDocument } from '../model/sch';
import { setProps } from '../model/schEdit';
import { partRecords } from '../model/schPlace';
import { simModelOf, simParamHolder } from '../model/simModels';
import { projectNetlist, type LiveMap } from '../sim/adNetlist';
import { Simulator } from '../sim/engine';
import { readNetlist, type Circuit } from '../sim/netlist';
import { readSimSettings } from '../sim/settings';
import { LiveRecord, liveStepLimit, measure, spectrum, type Measure, type Trace } from '../sim/liveRecord';
import { spiceNumber } from '../sim/num';
import type { ToolPointer } from '../core/tools';
import { SIM_PARTS_LIB, SIM_SOURCES_LIB, simPartSymbols, simSourceSymbols, type SimSymbolBuilder } from '../formats/synthetic/simLib';
import { active, activeScope, chain, docs, notify, projects } from './state';
import { commands } from '../core/commands';
import { KIT, KIT_GROUPS, KIT_KEYS, kitFields, type KitField, type KitPart } from './liveKit';
import { compileOptions, projectSheets } from './project';
import { includeFiles, modelFinder } from './simRun';
import { placePart } from './placeCommands';
import { SEG7_LINES } from '../formats/synthetic/simKit';
import { Listener, playStretch, soundReady, soundState, soundStop } from './liveSound';
import { docParam, docParamChange } from '../model/schParams';
import { RATING_UNITS, Stress, ratingOf } from '../sim/liveStress';
import { nearestE } from '../core/calc';
import { solveValue } from '../sim/liveSolve';
import { LIVE_SAVED, liveSavedText, readLiveSaved, sameWatch, type LiveSaved } from './liveSaved';

export interface LiveNote { level: 'error' | 'warn' | 'info'; text: string }
export interface LiveState {
  /** Stepping (false: held where it is). */
  running: boolean;
  /** Circuit time reached, s. */
  time: number;
  /** Circuit seconds a second: asked for, and kept up with. */
  speed: number; pace: number;
  /** The colours' full scale (V) and the dots' (A). */
  vmax: number; imax: number;
  notes: LiveNote[];
  /** Why the run stands still (no solution, nothing to simulate). */
  error: string | null;
  /** From the Start begins with everything discharged, not at the operating point. */
  zero: boolean;
  parts: number; nets: number;
  sheet: string;
  /** The parts over what they are rated for, each as a line: "R1: 0.61 W, rated for 0.25 W". */
  stress: string[];
}
export const live = signal<LiveState | null>(null);

/** Speeds offered: 1, 2, 5 through the decades, from a nanosecond of the circuit a second to ten seconds. */
export const LIVE_SPEEDS: number[] = (() => { const out: number[] = []; for (let e = -9; e <= 0; e++) for (const m of [1, 2, 5]) out.push(Number(`${m}e${e}`)); out.push(10); return out; })();
const nearestSpeed = (s: number) => LIVE_SPEEDS.reduce((a, b) => (Math.abs(Math.log(b / s)) < Math.abs(Math.log(a / s)) ? b : a));

/** A value with its unit and SI prefix: 3.30 V, 12.5 mA, 470 µs. */
export function si(v: number, unit: string): string {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return `? ${unit}`;
  if (a < 1e-15) return `0 ${unit}`;
  const steps: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const [k, p] = steps.find(([x]) => a >= x * 0.9995) ?? steps[steps.length - 1]!;
  const x = v / k, d = Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
  return `${x.toFixed(d)} ${p}${unit}`;
}

/** A reading as it is shown on the sheet: what is under the solver's own tolerances (a microvolt, a picoampere) reads as nothing. */
const reads = (v: number, unit: string): string => si(Math.abs(v) < (unit === 'A' ? 1e-12 : 1e-6) ? 0 : v, unit);

/* ─── The run ────────────────────────────────────────────────────────────────────────── */

interface Run {
  ed: SchEditor;
  sim: Simulator | null;
  map: LiveMap;
  geo: LiveGeometry;
  compiled: CompiledProject | null;
  revision: number;
  /** The fastest periodic source, Hz (0: none): the longest step follows it. */
  fmax: number;
  /** Each run's dots: how far along they have moved (document units). */
  phase: Float64Array;
  cur: Float64Array;
  volt: Map<string, number>;
  raf: number;
  last: number;
  told: number;
  /** The milliseconds of a frame the circuit may take: 8 while it keeps up with the speed asked, up to 24 while it does not (the picture then moves at half its rate, and the circuit gets on half as fast again). */
  budget: number;
  /** What the scope reads: every step's signals, and where the simulator keeps each of them. */
  record: LiveRecord | null;
  recordAt: Int32Array;
  /** The netlist as it was read, and its include files: the frequency response is taken of it afresh. */
  netlist: string;
  include: (name: string) => string | null;
  response: Response | string | null;
  /** A push button held down: its component (−1: none). */
  held: number;
  /** The sheet's meters and lights: parts that show something of their own while it runs. */
  gear: Gear[];
  /** The rated parts, each followed step by step, and where each is on the sheet. */
  stress: { s: Stress; at: Vec2 }[];
  /** The sheet keeps its monitors and scopes (it has, or has had in this run, the parameter they are written to): after a change undone they are as it says. */
  watchSaved: boolean;
}
/** A meter (it reads out beside itself, and can feed a scope) or a light (an LED by its current, a lamp by its power). */
interface Gear {
  index: number; designator: string; kind: 'voltmeter' | 'ammeter' | 'testpoint' | 'led' | 'lamp' | 'seg7' | 'fuse' | 'speaker';
  at: Vec2;
  /** How the part is turned: quarter turns anticlockwise, and whether it is mirrored first (a display's segments are drawn where they are). */
  orient: number; mirrored: boolean;
  /** A seven-segment display: the current into each segment's pin, a to g. */
  segs?: Trace[];
  /** A fuse: the node that is 1 once it has blown, and its switches by name (put off again to make it good). */
  blown?: string; switches?: string[];
  /** A speaker: what listens to the voltage across it. */
  listener?: Listener;
  /** Turned on its side (its pins left and right): a meter's reading goes under it, clear of its wires. */
  side: boolean;
  /** A meter: what it shows of its reading, and the scope it feeds (0: none). */
  shows: string; scope: number;
  /** A light: what is full brightness (an LED's current, a lamp's voltage) and its colour. */
  full: number; colour: number;
  v: Trace | null; i: Trace | null;
  /** A meter's text, worked out a few times a second where it is of a stretch of time. */
  text: string; textAt: number;
}
let run: Run | null = null;
/** The sheet the monitors were placed on. */
let watchedOn: SchEditor | null = null;

const sheetOf = (ed: SchEditor) => docsWith(ed);
function docsWith(ed: SchEditor): { project: (typeof projects.value)[number] | null; sheets: { name: string; doc: SchDocument }[] } {
  const od = active.value?.editor === ed ? active.value : null;
  const project = od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null;
  let sheets = project ? projectSheets(project) : [];
  // The sheet in front as it is being drawn, whether or not its project lists it
  sheets = sheets.filter((s) => s.name.toLowerCase() !== ed.doc.name.toLowerCase()).concat([{ name: ed.doc.name, doc: ed.doc }]);
  return { project, sheets };
}

/** A speed that shows the circuit at a pace the eye follows: its fastest source's period in two seconds, else its longest time constant a second. */
function paceFor(c: Circuit, freqs: number[]): number {
  if (freqs.length) return nearestSpeed(1 / (2 * Math.max(...freqs)));
  const val = (k: string) => c.elements.filter((e) => e.kind === k && typeof e.value === 'number' && e.value > 0).map((e) => e.value as number).sort((a, b) => a - b);
  const r = val('R'), rmid = r.length ? r[r.length >> 1]! : 1e3;
  const taus = [...val('C').map((x) => x * rmid), ...val('L').map((x) => x / rmid)];
  return nearestSpeed(taus.length ? Math.max(...taus) : 1e-3);
}

/** The sheet's circuit made (again): a first start from its operating point, a change carried on from where the run was. */
function build(first: boolean): void {
  const r = run!;
  const st = live.value!;
  const { project, sheets } = sheetOf(r.ed);
  const notes: LiveNote[] = [];
  let error: string | null = null;
  const before = r.sim && !st.error ? { state: r.sim.unknownsNow(), time: r.sim.liveTime } : null;
  r.revision = r.ed.undo.revision;
  r.sim = null;
  let speed = st.speed;
  try {
    const compiled = compileProject(sheets, compileOptions(project));
    const map: LiveMap = { nets: new Map(), pins: new Map() };
    const net = projectNetlist(compiled, sheets, readSimSettings(project?.prj), modelFinder(project), 'Live Simulation', map);
    for (const m of net.messages) if (m.level !== 'info') notes.push({ level: m.level, text: m.text });
    r.compiled = compiled; r.map = map;
    r.geo = liveGeometry(r.ed.doc, compiled);
    r.phase = new Float64Array(r.geo.runs.length);
    r.cur = new Float64Array(r.geo.runs.length);
    r.fmax = net.sourceFrequencies.length ? Math.max(...net.sourceFrequencies) : 0;
    if (!map.pins.size) error = 'Nothing to run yet: place parts that have a simulation model (the buttons below), wire them, and give the circuit a GND.';
    else {
      const files = includeFiles(project);
      const include = (n: string) => files[n] ?? files[n.split(/[\\/]/).pop()!] ?? null;
      const circuit = readNetlist(net.text, { include });
      // 0 V is where a GND port is, or what a part brings with it (a rail, a logic input, a gate: one end of each is 0 V)
      if (![...map.nets.values()].includes('0') && !circuit.elements.some((e) => e.nodes.includes('0') && !(e.kind === 'R' && (e.value ?? 0) >= 1e9))) notes.push({ level: 'info', text: 'No net is the reference: voltages are measured from GND, so place a GND power port where 0 V is to be.' });
      const sim = new Simulator(circuit, {}, { deviceCurrents: false, powers: false, subcircuitNodes: false });
      // A change carries on from what the run held; where that does not fit the changed circuit, from its operating point; and a
      // circuit with none (an inductor straight across a source, an oscillator's balance) starts with everything discharged
      const fresh = (time?: number) => {
        if (!st.zero) try { sim.liveStart(time === undefined ? {} : { time }); return; } catch { notes.push({ level: 'info', text: 'The circuit has no operating point to start from: it starts with everything discharged.' }); }
        sim.liveStart(time === undefined ? { uic: true } : { uic: true, time });
      };
      if (before) try { sim.liveStart({ carry: before.state, time: before.time }); } catch { fresh(before.time); }
      else fresh();
      for (const m of sim.messages) if (m.level !== 'info') notes.push({ level: m.level, text: m.text });
      r.sim = sim;
      r.netlist = net.text; r.include = include; r.response = null;
      if (first) speed = paceFor(circuit, net.sourceFrequencies);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  live.value = { ...st, speed, notes, error, parts: r.compiled?.components.length ?? 0, nets: r.map.nets.size, time: r.sim?.liveTime ?? st.time, sheet: r.ed.doc.name };
  // A change that was to what the sheet keeps of its monitors and scopes (one undone, or done again): they are as it says
  const kept = first ? null : savedOn(r.ed);
  if (!first && r.watchSaved && !sameWatch(kept, watchNow())) restoreWatch(r, kept ?? { views: [], zero: false, keep: [] });
  reprobe();
  gear();
  record();
}

const LED_COLOURS: Record<string, number> = { red: 0xff2a1a, green: 0x2fd04a, yellow: 0xf2c400, blue: 0x2a6cff, white: 0xfff6d8 };
/** The sheet's meters and lights, found by their models; a meter that feeds a scope the panel doesn't have yet gets it. */
function gear(): void {
  const r = run;
  if (!r) return;
  // (a speaker's listener carries on over a change to the circuit, with what it has heard of its stretch)
  const before = new Map(r.gear.filter((g) => g.listener).map((g): [string, Listener] => [g.designator, g.listener!]));
  r.gear = [];
  if (!r.sim) { r.stress = []; return; }
  const doc = r.ed.doc, meter = (k: string) => `${r.map.pins.get(k)?.meter ?? ''}#branch`, node = (k: string) => r.map.pins.get(k)?.node ?? '0';
  const across = (label: string, a: string, b: string): Trace => ({ label, unit: 'V', terms: ([[node(a), 1], [node(b), -1]] as [string, number][]).filter(([n]) => n !== '0') });
  const text = (index: number, name: string) => { const h = simParamHolder(doc, index, name); return h === null ? '' : bagOf(doc, doc.objects[h]!)?.get('TEXT') ?? ''; };
  for (const o of doc.objects) {
    if (o.kind !== 'component') continue;
    const m = simModelOf(doc, o.index);
    if (!m) continue;
    const sub = m.subKind.toLowerCase(), d = o.designator, has = (pin: string) => r.map.pins.has(`${d}|${pin}`);
    const kind: Gear['kind'] | null = sub === 'voltmeter' ? 'voltmeter' : sub === 'ammeter' ? 'ammeter' : sub === 'test point' ? 'testpoint' : sub === 'lamp' ? 'lamp'
      : sub === 'seven-segment display' ? 'seg7' : sub === 'fuse' ? 'fuse' : sub === 'speaker' ? 'speaker' : sub === 'light-emitting diode' || /^LED/i.test(o.libRef) ? 'led' : null;
    if (!kind) continue;
    const g: Gear = { index: o.index, designator: d, kind, at: o.at, orient: o.orient, mirrored: !!o.mirrored, side: kind !== 'testpoint' && o.orient % 2 === 1, shows: text(o.index, 'Shows') || 'Value', scope: Number(text(o.index, 'On Scope')) || 0, full: 0, colour: 0, v: null, i: null, text: '', textAt: -Infinity };
    if (kind === 'seg7') {
      if (!['1', '2', '3', '4', '5', '6', '7'].every(has)) continue;
      g.segs = ['1', '2', '3', '4', '5', '6', '7'].map((n) => ({ label: d, unit: 'A', terms: [[meter(`${d}|${n}`), 1]] }));
      g.full = spiceNumber(text(o.index, 'At Current')) || 10e-3;
      g.colour = LED_COLOURS[text(o.index, 'Colour').toLowerCase()] ?? LED_COLOURS.red!;
    } else if (kind === 'fuse') {
      // The fuse's subcircuit by its name in the netlist (X and the designator): its state node and its two switches
      const inst = [`x${d}`, d].map((n) => n.toLowerCase()).find((n) => r.sim!.unknownAt(`${n}.22`) !== undefined);
      if (!inst) continue;
      g.blown = `${inst}.22`; g.switches = [`${inst}.s1`, `${inst}.s2`];
    } else if (kind === 'speaker') {
      if (!has('1') || !has('2')) continue;
      g.v = across(d, `${d}|1`, `${d}|2`);
      const full = spiceNumber(text(o.index, 'Full Scale')) || 5, plays = spiceNumber(text(o.index, 'Plays')) || 0.5, was = before.get(d);
      g.listener = was && was.full === full && was.plays === plays ? was : new Listener(full, plays, (samples) => { if (sound.value) playStretch(samples); });
    } else if (kind === 'led') {
      if (!has('A')) continue;
      g.i = { label: d, unit: 'A', terms: [[meter(`${d}|A`), 1]] };
      g.full = spiceNumber(text(o.index, 'At Current')) || 20e-3;
      g.colour = LED_COLOURS[text(o.index, 'Colour').toLowerCase()] ?? LED_COLOURS.red!;
    } else if (kind === 'testpoint') {
      if (!has('1')) continue;
      g.v = { label: d, unit: 'V', terms: node(`${d}|1`) === '0' ? [] : [[node(`${d}|1`), 1]] };
    } else {
      if (!has('1') || !has('2')) continue;
      if (kind !== 'ammeter') g.v = across(d, `${d}|1`, `${d}|2`);
      if (kind === 'ammeter') g.i = { label: d, unit: 'A', terms: [[meter(`${d}|1`), 1]] };
      if (kind === 'lamp') { g.full = spiceNumber(text(o.index, 'Nominal Voltage')) || 12; g.colour = 0xffd84a; }
    }
    r.gear.push(g);
  }
  // The rated parts (see liveStress): one that was over its rating before a change to the sheet is still said to be until it is seen not to be
  const sim = r.sim, was = new Map(r.stress.map((x) => [x.s.designator, x.s]));
  r.stress = [];
  for (const o of doc.objects) {
    if (o.kind !== 'component' || !simModelOf(doc, o.index)) continue;
    const rating = ratingOf(o.libRef, (name) => text(o.index, name), spiceNumber);
    if (!rating) continue;
    const pins = [...r.map.pins].filter(([k]) => k.startsWith(`${o.designator}|`)).map(([, p]): [number, number] => [sim.unknownAt(p.node) ?? -1, sim.unknownAt(`${p.meter}#branch`) ?? -1]);
    if (pins.length < 2) continue;
    const st = new Stress(o.designator, rating, pins), old = was.get(o.designator);
    if (old && old.rating.kind === rating.kind) { st.shown = old.shown; st.over = old.over && old.shown > rating.value * 0.9; }
    r.stress.push({ s: st, at: o.at });
  }
  const most = Math.min(MAX_SCOPES, Math.max(0, ...r.gear.map((g) => g.scope))), sc = scope.value;
  if (most > sc.scopes.length) {
    const scopes = [...sc.scopes];
    while (scopes.length < most) scopes.push({ id: Math.max(0, ...scopes.map((s) => s.id)) + 1, view: 'time' });
    scope.value = { ...sc, scopes };
  }
}
/** A meter as a probe of the scope it feeds (its id is below zero: it is the part's, not one kept by hand). */
function gearProbe(g: Gear, k: number): Probe {
  return { id: -(g.index + 1), label: g.designator, colour: PROBE_COLOURS[(k + 4) % PROBE_COLOURS.length]!, from: { part: g.designator }, v: g.v, i: g.i, at: g.at, along: null, gone: false, scope: scope.value.scopes[g.scope - 1]?.id ?? 0 };
}
const isMeter = (g: Gear) => g.kind === 'voltmeter' || g.kind === 'ammeter' || g.kind === 'testpoint';
const isLight = (g: Gear) => g.kind === 'led' || g.kind === 'lamp';

/** The record the scope reads, for the circuit as it now is: the same signals as before carry their past on. */
function record(): void {
  const r = run, sim = r?.sim;
  if (!r || !sim) return;
  const names = signalNames(r);
  if (!r.record || !r.record.same(names)) r.record = new LiveRecord(names, Math.min(16384, Math.max(3200, Math.floor(1_500_000 / Math.max(1, names.length)))));
  const at = r.recordAt = Int32Array.from(names, (n) => sim.unknownAt(n) ?? -1);
  r.record.push(sim.liveTime, (i) => sim.valueAt(at[i]!));
}
/** What is recorded: every net's voltage and every pin's current; of a large circuit, only what the probes read. */
function signalNames(r: Run): string[] {
  const all = [...new Set([...r.map.nets.values()].filter((n) => n !== '0')), ...[...r.map.pins.values()].map((p) => `${p.meter}#branch`)];
  if (all.length <= 512) return all;
  const sc = scope.value, used = new Set<string>();
  for (const p of [...sc.kept, ...(sc.probe ? [sc.probe] : [])]) for (const tr of [p.v, p.i]) for (const [n] of tr?.terms ?? []) used.add(n);
  return all.filter((n) => used.has(n));
}

function frame(now: number): void {
  const r = run;
  if (!r) return;
  r.raf = requestAnimationFrame(frame);
  const st = live.value!;
  const dt = Math.min(0.05, Math.max(0, (now - r.last) / 1000));
  r.last = now;
  // Its sheet closed: the run ends with it. Another document in front: the run waits for its sheet
  if (!docs.value.some((d) => d.editor === r.ed)) { stopLive(); return; }
  if (active.value?.editor !== r.ed) return;
  if (r.ed.undo.revision !== r.revision) build(false);
  let error = live.value!.error, pace = st.pace, flagged = false;
  if (r.sim && st.running && !error && dt > 0) {
    const from = r.sim.liveTime, want = st.speed * dt;
    const sim = r.sim, rec = r.record, at = r.recordAt;
    const hmax = liveStepLimit(want, r.fmax, rec?.fastest(from) ?? 0);
    // (about 2,500 samples across a scope: the record keeps them at gaps of one to one and a half spacings)
    if (rec) rec.spacing = shownSpeed(st) * SCOPE_SPAN / 3125;
    // (each speaker hears the voltage across it: its two nodes, one of which may be 0 V)
    const ears = r.gear.filter((g) => g.listener).map((g): [Listener, [number, number][]] => [g.listener!, (g.v?.terms ?? []).map(([n, k]): [number, number] => [sim.unknownAt(n) ?? -1, k]).filter(([i]) => i >= 0)]);
    const rated = r.stress, valueAt = (i: number) => sim.valueAt(i);
    const step = rec || ears.length || rated.length ? (time: number) => {
      rec?.push(time, (i) => sim.valueAt(at[i]!));
      for (const [l, terms] of ears) { let v = 0; for (const [i, k] of terms) v += k * sim.valueAt(i); l.step(time, v); }
      for (let k = 0; k < rated.length; k++) rated[k]!.s.step(time, valueAt);
    } : undefined;
    const began = performance.now();
    try { sim.liveAdvance(from + want, hmax, began + r.budget, step); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    // A circuit that did not get as far as asked has more of the next frame; one that did in half its time gives some back
    const took = performance.now() - began;
    if (sim.liveTime < from + want * 0.999) r.budget = Math.min(24, r.budget + 2); else if (took < r.budget * 0.5) r.budget = Math.max(8, r.budget - 1);
    pace += ((r.sim.liveTime - from) / dt - pace) * 0.2;
    for (const x of rated) if (x.s.frame(dt)) flagged = true;
  }
  // What shows: each net's voltage, each run's current, the dots moved on
  let vmax = st.vmax, imax = st.imax;
  if (r.sim && !error) {
    const sim = r.sim;
    let vTop = 0, iTop = 0;
    for (const [net, node] of r.map.nets) { const v = sim.valueOf(node) ?? 0; r.volt.set(net, v); if (Math.abs(v) > vTop) vTop = Math.abs(v); }
    r.cur = runCurrents(r.geo, (k) => sim.valueOf(`${r.map.pins.get(k)?.meter ?? ''}#branch`) ?? 0);
    for (const i of r.cur) if (Math.abs(i) > iTop) iTop = Math.abs(i);
    // The scales follow the largest: up at once, down slowly
    vmax = vTop > vmax ? vTop : vmax + (Math.max(vTop, 1e-3) - vmax) * 0.02;
    imax = iTop > imax ? iTop : imax + (Math.max(iTop, 1e-9) - imax) * 0.02;
    if (st.running) for (let i = 0; i < r.cur.length; i++) {
      const c = r.cur[i]!;
      if (Math.abs(c) > imax * 1e-4) r.phase[i] = (r.phase[i]! + Math.sign(c) * DOT_SPEED * Math.sqrt(Math.abs(c) / imax) * dt) % 1;
    }
  }
  r.ed.refreshOverlay();
  // The panel is told a few times a second, and at once of an error
  if (now - r.told > 120 || error !== st.error || flagged) {
    r.told = now;
    live.value = { ...live.value!, time: r.sim?.liveTime ?? st.time, pace, vmax, imax, error, stress: stressLines(r) };
  } else { st.pace = pace; st.vmax = vmax; st.imax = imax; }
  for (const fn of frameListeners) fn();
}
const frameListeners = new Set<() => void>();
/** A rated part's reading against its rating: "0.61 W, rated for 0.25 W". */
const stressText = (x: Stress): string => `${reads(x.shown, RATING_UNITS[x.rating.kind])}, rated for ${reads(x.rating.value, RATING_UNITS[x.rating.kind])}`;
/** The parts over their ratings, as the panel lists them. */
const stressLines = (r: Run): string[] => r.stress.filter((x) => x.s.over).map((x) => `${x.s.designator}: ${stressText(x.s)}`);
/** For tests and scripts: every rated part, what it takes now and whether that is over its rating. */
export function liveStress(): { designator: string; kind: string; rating: number; shown: number; over: boolean }[] {
  return (run?.stress ?? []).map((x) => ({ designator: x.s.designator, kind: x.s.rating.kind, rating: x.s.rating.value, shown: x.s.shown, over: x.s.over }));
}
/** How brightly a light is lit now (0 to 1): an LED by its current against its full current, a lamp by its power against its nominal power. */
function brightness(r: Run, g: Gear): number {
  const sim = r.sim;
  if (!sim) return 0;
  const now = (tr: Trace | null) => (tr ? tr.terms.reduce((a, [n, f]) => a + f * (sim.valueOf(n) ?? 0), 0) : 0);
  return Math.max(0, Math.min(1, g.kind === 'led' ? now(g.i) / g.full : (now(g.v) / g.full) ** 2));
}
/** How brightly each segment of a display is lit now (0 to 1), a to g. */
function segments(r: Run, g: Gear): number[] {
  const sim = r.sim;
  return (g.segs ?? []).map((tr) => (sim ? Math.max(0, Math.min(1, tr.terms.reduce((a, [n, f]) => a + f * (sim.valueOf(n) ?? 0), 0) / g.full)) : 0));
}
/** Whether a fuse has blown. */
const blownNow = (r: Run, g: Gear): boolean => !!g.blown && (r.sim?.valueOf(g.blown) ?? 0) > 0.5;
/** A point of a part's symbol (in the symbol's own tenths of an inch) where it is on the sheet, the part turned and mirrored as it is. */
function place(g: Gear, [x, y]: readonly [number, number]): Vec2 {
  const mx = g.mirrored ? -x : x, k = ((g.orient % 4) + 4) % 4;
  const [rx, ry] = k === 0 ? [mx, y] : k === 1 ? [-y, mx] : k === 2 ? [-mx, -y] : [y, -mx];
  return { x: g.at.x + rx * 100_000, y: g.at.y + ry * 100_000 };
}
/** The running sheet's displays: each one's segments lit (a to g, 1 where more than half bright) and the digit they make ('' where they make none). */
export function liveDisplays(): { designator: string; lit: string; digit: string }[] {
  const r = run;
  if (!r) return [];
  const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg', 'abcefg', 'cdefg', 'adef', 'bcdeg', 'adefg', 'aefg'];
  return r.gear.filter((g) => g.kind === 'seg7').map((g) => { const lit = segments(r, g).map((b, i) => (b > 0.5 ? 'abcdefg'[i] : '')).join(''), n = DIGITS.indexOf(lit); return { designator: g.designator, lit, digit: n < 0 ? '' : n.toString(16).toUpperCase() }; });
}
/** The running sheet's fuses, and whether each has blown. */
export function liveFuses(): { designator: string; blown: boolean }[] {
  const r = run;
  return r ? r.gear.filter((g) => g.kind === 'fuse').map((g) => ({ designator: g.designator, blown: blownNow(r, g) })) : [];
}
/** The running sheet's speakers: the stretches each has given out and its loudest sample (1 is full volume); and what the sound is doing. */
export function liveSound(): { outputs: { designator: string; stretches: number; peak: number }[]; state: string; played: number; queued: number } {
  return { outputs: (run?.gear ?? []).filter((g) => g.listener).map((g) => ({ designator: g.designator, stretches: g.listener!.stretches, peak: g.listener!.peak })), ...soundState() };
}
/** Whether the running sheet has a speaker, and the longest stretch one plays at a time (seconds of the circuit's time). */
export function liveAudio(): number { return Math.max(0, ...(run?.gear ?? []).filter((g) => g.listener).map((g) => g.listener!.plays)); }

/** The running sheet's lights and how brightly each is lit (0 to 1). */
export function liveLights(): { designator: string; kind: 'led' | 'lamp'; brightness: number }[] {
  const r = run;
  return r ? r.gear.filter(isLight).map((g) => ({ designator: g.designator, kind: g.kind as 'led' | 'lamp', brightness: brightness(r, g) })) : [];
}

/** Called after every frame of the run (the scope draws then); the returned function ends it. */
export function onLiveFrame(fn: () => void): () => void { frameListeners.add(fn); return () => { frameListeners.delete(fn); }; }

/* ─── What is drawn over the sheet ───────────────────────────────────────────────────── */

/** The dots: 100 mil apart (further, zoomed out: see draw), the fastest of them three of those a second. A run's phase is in gaps. */
const DOT_GAP = 1_000_000, DOT_SPEED = 3;
/** A voltage's colour: red towards the most positive, blue towards the most negative, grey at 0 V. */
export function voltColour(v: number, vmax: number): number {
  const t = Math.max(-1, Math.min(1, vmax > 0 ? v / vmax : 0)), a = Math.sqrt(Math.abs(t));
  const mix = (x: number, y: number) => Math.round(x + (y - x) * a);
  const [r, g, b] = t >= 0 ? [mix(0x8a, 0xe0), mix(0x90, 0x2f), mix(0x98, 0x2f)] : [mix(0x8a, 0x1c), mix(0x90, 0x6e), mix(0x98, 0xd6)];
  return (r << 16) | (g << 8) | b;
}

function draw(s: Scene, px: number): void {
  const r = run, st = live.value;
  if (!r || !st || !r.sim || st.error) return;
  const wires = s.group('live-wires', 0.6), dots = s.group('live-dots', 0.7);
  // The wire in its voltage's colour, wide enough to read at any zoom; the dots smaller than it is wide and never closer
  // than a dozen pixels, so that the colour shows between them
  const width = Math.max(150_000, 3.2 * px), rad = Math.max(60_000, 1.5 * px), gap = Math.max(DOT_GAP, 14 * px);
  const dot = rgba(0x1b1f24, 0.95);
  r.geo.runs.forEach((run_, i) => {
    const { a, b } = run_;
    s.segment(wires, a, b, width, rgba(voltColour(r.volt.get(run_.net) ?? 0, st.vmax), 0.92));
    const c = r.cur[i]!, len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(Math.abs(c) > st.imax * 1e-4) || len <= 0) return;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    for (let d = (((r.phase[i]! % 1) + 1) % 1) * gap; d < len; d += gap) s.circle(dots, { x: a.x + ux * d, y: a.y + uy * d }, rad, dot);
  });
  // The lights: an LED by its current, a lamp by its power
  if (r.gear.some((g) => !isMeter(g) && g.kind !== 'speaker')) {
    const glow = s.group('live-lights', 0.5);
    for (const g of r.gear) {
      if (g.kind === 'seg7') { segments(r, g).forEach((b, i) => { if (b >= 0.02) { const [p, q] = SEG7_LINES[i]!; s.segment(glow, place(g, p), place(g, q), 420_000, rgba(g.colour, 0.35 + 0.65 * b)); } }); continue; }
      // A blown fuse: struck through
      if (g.kind === 'fuse') { if (blownNow(r, g)) { const d = 650_000; s.segment(glow, { x: g.at.x - d, y: g.at.y - d }, { x: g.at.x + d, y: g.at.y + d }, 260_000, rgba(0xd1242f, 0.95)); s.segment(glow, { x: g.at.x - d, y: g.at.y + d }, { x: g.at.x + d, y: g.at.y - d }, 260_000, rgba(0xd1242f, 0.95)); } continue; }
      if (!isLight(g)) continue;
      const b = brightness(r, g);
      if (b < 0.02) continue;
      s.circle(glow, g.at, 1_500_000, rgba(g.colour, 0.28 * b));
      s.circle(glow, g.at, 800_000, rgba(g.colour, 0.5 * b));
    }
  }
  // A part over its rating: ringed in red, with what it takes against what it is rated for
  if (r.stress.some((x) => x.s.over)) {
    const rings = s.group('live-stress', 2.2);
    for (const x of r.stress) {
      if (!x.s.over) continue;
      s.arc(rings, x.at, 1_450_000, 0, 360, 2.5 * px, rgba(0xd1242f, 0.95));
      const text = stressText(x.s), size = 11 * px, w = text.length * size * 0.56 + 12 * px, h = size * 1.6, c = { x: x.at.x, y: x.at.y - 1_450_000 - h / 2 - 3 * px };
      s.rect(rings, c, w, h, 0, 2 * px, rgba(0xd1242f, 0.95));
      s.text(rings, c, { text, size, rot: 0, color: css(0xffffff), h: 1, v: 1 });
    }
  }
  // What is watched: a ring in its colour where each was taken, a barb the way its current counts as positive, and its
  // voltage and current beside it as they are
  const watched = liveMonitors();
  if (watched.length) {
    const marks = s.group('live-probes', 0.8), notes = s.group('live-monitors', 2.5);
    for (const m of watched) {
      if (!m.at) continue;
      if (m.meter) {
        // A meter's reading: beside the part, large enough to read at a glance
        const size = 12 * px, w = m.text.length * size * 0.58 + 10 * px, h = size * 1.6;
        const c = m.under ? { x: m.at.x, y: m.at.y - 1_300_000 - h / 2 } : { x: m.at.x + (m.point ? 600_000 : 1_000_000) + w / 2, y: m.at.y + (m.point ? 300_000 : -700_000) };
        s.rect(notes, c, w, h, 0, 2 * px, rgba(0xfffdf0, 0.96));
        s.rect(notes, { x: c.x - w / 2 + 1.5 * px, y: c.y }, 3 * px, h, 0, 0, rgba(m.colour, 1));
        s.text(notes, { x: c.x + 2 * px, y: c.y }, { text: m.text, size, rot: 0, color: css(0x1b1f24), h: 1, v: 1 });
        continue;
      }
      s.circle(marks, m.at, 5.5 * px, rgba(0xffffff, 0.9));
      s.arc(marks, m.at, 5.5 * px, 0, 360, 2 * px, rgba(m.colour, 1));
      if (m.along) {
        const tip = { x: m.at.x + m.along.x * 11 * px, y: m.at.y + m.along.y * 11 * px }, n = { x: -m.along.y, y: m.along.x };
        const base = { x: m.at.x + m.along.x * 6 * px, y: m.at.y + m.along.y * 6 * px };
        s.polygon(marks, [tip, { x: base.x + n.x * 3.5 * px, y: base.y + n.y * 3.5 * px }, { x: base.x - n.x * 3.5 * px, y: base.y - n.y * 3.5 * px }], [0, 1, 2], rgba(m.colour, 1));
      }
      // The read-out: above the ring and to its right (to its left where that is the pin's part), an edge in the trace's colour
      const size = 11 * px, w = m.text.length * size * 0.56 + 12 * px, h = size * 1.6;
      const left = !!m.along && m.pin && m.along.x > 0.5, dir = left ? -1 : 1;
      const c = { x: m.at.x + dir * (10 * px + w / 2), y: m.at.y + 9 * px + h / 2 };
      s.rect(notes, c, w, h, 0, 2 * px, rgba(0xffffff, 0.94));
      s.rect(notes, { x: c.x - dir * (w / 2 - 1.5 * px), y: c.y }, 3 * px, h, 0, 0, rgba(m.colour, 1));
      s.text(notes, { x: c.x - dir * 2 * px, y: c.y }, { text: m.text, size, rot: 0, color: css(0x1b1f24), h: 1, v: 1 });
    }
  }
  // What the cursor is on: its net's voltage and its run's current
  const at = r.ed.cursor, tol = 6 * px;
  let best = -1, bd = tol;
  r.geo.runs.forEach((run_, i) => { const d = distToSeg(at, run_.a, run_.b); if (d < bd) { bd = d; best = i; } });
  // …unless a monitor already reads it there
  const what_ = best >= 0 ? (r.geo.runs[best]!.pin ? r.geo.runs[best]!.pin!.replace('|', ' pin ') : r.geo.runs[best]!.net) : '';
  if (best >= 0 && !watched.some((m) => m.label === what_ && m.at && Math.hypot(m.at.x - at.x, m.at.y - at.y) < 40 * px)) {
    const run_ = r.geo.runs[best]!, v = r.volt.get(run_.net) ?? 0;
    const what = what_;
    const text = `${what}: ${reads(v, 'V')}, ${reads(Math.abs(r.cur[best]!), 'A')}`;
    const g = s.group('live-readout', 3), size = 12 * px, w = text.length * size * 0.56 + 10 * px, h = size * 1.7;
    const c = { x: at.x + 14 * px + w / 2, y: at.y + 16 * px };
    s.rect(g, c, w, h, 0, 3 * px, rgba(0xfffdf0, 0.96));
    s.text(g, c, { text, size, rot: 0, color: css(0x1b1f24), h: 1, v: 1 });
  }
}
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ─── Start, stop, hold, again ───────────────────────────────────────────────────────── */

const sheetInFront = (): SchEditor | null => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
export const canLive = (): boolean => !!sheetInFront();

export function startLive(zero?: boolean): void {
  const ed = sheetInFront();
  if (!ed) { notify('Live Simulation runs a schematic sheet: bring one in front', 'error'); return; }
  // (how a run starts: as asked, as the run before on this sheet did, or as the sheet keeps it)
  const kept = savedOn(ed);
  zero ??= run?.ed === ed && live.value ? live.value.zero : kept?.zero ?? false;
  stopLive();
  // (a run is started by a click: the moment a browser lets sound be made ready)
  if (sound.value) soundReady();
  run = { ed, sim: null, map: { nets: new Map(), pins: new Map() }, geo: { runs: [], sums: [] }, compiled: null, revision: -1, fmax: 0, phase: new Float64Array(0), cur: new Float64Array(0), volt: new Map(), raf: 0, last: performance.now(), told: 0, budget: 8,
    record: null, recordAt: new Int32Array(0), netlist: '', include: () => null, response: null, held: -1, gear: [], stress: [], watchSaved: !!docParam(ed.doc, LIVE_SAVED) };
  // The monitors of a sheet stay for its next run; another sheet starts with none, or with those it keeps (see liveSaved)
  if (watchedOn !== ed) scope.value = { ...scope.value, probe: null, kept: [] };
  watchedOn = ed;
  live.value = { running: true, time: 0, speed: 1e-3, pace: 0, vmax: 1e-3, imax: 1e-9, notes: [], error: null, zero, parts: 0, nets: 0, sheet: ed.doc.name, stress: [] };
  build(true);
  if (kept && !sameWatch(kept, watchNow())) { restoreWatch(run, kept); gear(); record(); }
  ed.liveDraw = draw;
  ed.liveHit = hit;
  run.raf = requestAnimationFrame(frame);
}
export function stopLive(): void {
  if (!run) return;
  soundStop();
  cancelAnimationFrame(run.raf);
  if (run.held >= 0) press(run, run.held, false);
  run.ed.liveDraw = null;
  run.ed.liveHit = null;
  run.ed.refreshOverlay();
  run = null;
  live.value = null;
}
/** Whether a run begins with everything discharged (as a circuit just switched on) or at its operating point; it begins again. */
export function setLiveZero(zero: boolean): void { if (live.value) { live.value = { ...live.value, zero }; saveWatch(); againLive(); } }
/** Hold the run where it is, or let it go on. */
export function holdLive(hold = live.value?.running ?? false): void { if (live.value) live.value = { ...live.value, running: !hold }; if (hold) soundStop(); else if (sound.value) soundReady(); }
/** From the start again: time 0, the circuit at its operating point. */
export function againLive(): void {
  if (!run || !live.value) return;
  run.sim = null;
  run.record?.clear();
  for (const x of run.stress) x.s.clear();
  live.value = { ...live.value, time: 0, error: null, vmax: 1e-3, imax: 1e-9 };
  const speed = live.value.speed;
  build(false);
  live.value = { ...live.value!, speed };
}
export function setLiveSpeed(speed: number): void { if (live.value) live.value = { ...live.value, speed: nearestSpeed(speed) }; }
/** One step faster or slower through the speeds offered. */
export function stepLiveSpeed(by: number): void {
  const st = live.value;
  if (!st) return;
  const i = LIVE_SPEEDS.indexOf(nearestSpeed(st.speed));
  setLiveSpeed(LIVE_SPEEDS[Math.max(0, Math.min(LIVE_SPEEDS.length - 1, i + by))]!);
}

/** For tests and the panel: what the run reads at a net and at a pin now. */
export function liveReading(): { volt: Record<string, number>; pins: Record<string, number>; runs: number; time: number } | null {
  const r = run;
  if (!r?.sim) return null;
  const sim = r.sim;
  return {
    volt: Object.fromEntries([...r.map.nets].map(([n, node]) => [n, sim.valueOf(node) ?? 0])),
    pins: Object.fromEntries([...r.map.pins].map(([k, p]) => [k, sim.valueOf(`${p.meter}#branch`) ?? 0])),
    runs: r.geo.runs.length, time: sim.liveTime,
  };
}

/* ─── The parts a sketch is made of ──────────────────────────────────────────────────── */

/** The palette's parts and their kinds (src/app/liveKit.ts). */
export const LIVE_GROUPS = KIT_GROUPS;
export type LivePart = KitPart;
export const LIVE_PARTS: KitPart[] = KIT;
/** A palette part's symbol (the records its picture is drawn from and its placing uses). */
export function livePartSymbol(part: LivePart): { libRef: string; description: string; bags: SimSymbolBuilder['bags'] } | null {
  symbols ??= { parts: simPartSymbols(), sources: simSourceSymbols() };
  return symbols[part.lib].find((x) => x.libRef === part.libRef) ?? null;
}
let symbols: { parts: SimSymbolBuilder[]; sources: SimSymbolBuilder[] } | null = null;

/** The next designator free on the sheet for a prefix: R1, then R2 … */
export function nextDesignator(doc: SchDocument, prefix: string): string {
  let top = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  for (const o of doc.objects) if (o.kind === 'component') { const m = re.exec(o.designator); if (m) top = Math.max(top, Number(m[1])); }
  return `${prefix}${top + 1}`;
}

/** One of the sketch's parts on the cursor, with the next designator of its kind (it steps on as more are placed). */
export function placeLivePart(id: string): void {
  const ed = sheetInFront(), part = LIVE_PARTS.find((p) => p.id === id);
  if (!ed || !part) return;
  const sym = livePartSymbol(part);
  if (!sym) return;
  const lib = part.lib === 'parts' ? SIM_PARTS_LIB : SIM_SOURCES_LIB.replace(/\.SchLib$/, '.IntLib');
  const items = partRecords({ libRef: part.libRef, bags: sym.bags }, lib, 1);
  items.find((it) => it.bag.int('RECORD', -1) === 34)?.bag.set('TEXT', nextDesignator(ed.doc, part.prefix));
  placePart({ items, symbol: { libRef: part.libRef, description: sym.description, parts: 1, storage: '', bags: sym.bags }, library: lib });
}

/* ─── The scope's probes ─────────────────────────────────────────────────────────────── */

export type ScopeView = 'time' | 'spectrum' | 'response';
export const SCOPE_VIEWS: [ScopeView, string][] = [['time', 'Against time'], ['spectrum', 'Spectrum'], ['response', 'Frequency response']];
/** Your seconds across the scope: it shows as much of the circuit's time as passes in them at the speed set. */
export const SCOPE_SPAN = 5;
/** Monitors kept at once, on the sheet and the scopes together; and scopes side by side. */
export const MAX_KEPT = 24, MAX_SCOPES = 6;

export interface Probe {
  id: number;
  label: string;
  colour: number;
  /** Where it was taken: a point on a wire or a pin, or a two-pin part. Read again after every change to the sheet. */
  from: { at: Vec2 } | { part: string };
  v: Trace | null;
  i: Trace | null;
  /** Its mark on the sheet, and the way its current counts as positive. */
  at: Vec2 | null;
  along: Vec2 | null;
  /** What it was on is no longer on the sheet. */
  gone: boolean;
  /** The scope that draws it (its id); 0: a monitor on the sheet only. */
  scope: number;
}
export interface ScopeDef { id: number; view: ScopeView }
/**
 * What is watched: the probe (the last point clicked, drawn on the scope picked until the next click), the monitors kept
 * (each a read-out on the sheet, and a trace on its scope where it has one), and the scopes side by side.
 */
export interface ScopeState { probe: Probe | null; kept: Probe[]; scopes: ScopeDef[]; current: number }
export const scope = signal<ScopeState>({ probe: null, kept: [], scopes: [{ id: 1, view: 'time' }], current: 1 });
const PROBE_COLOURS = [0x2e86ab, 0xd1495b, 0x3f9a6a, 0xe3a72f, 0x7b5ea7, 0x4d5b66, 0x00a6a6, 0xb5651d, 0x8a9a1c, 0xc2478f];
let probeIds = 0;

type Reading = Pick<Probe, 'label' | 'from' | 'v' | 'i' | 'at' | 'along'>;
/** What a probe reads where it is: a wire's or pin's net and the current in that run, or the voltage across a two-pin part and the current through it. */
function readProbe(r: Run, from: Probe['from'], tol: number): Reading | null {
  const meter = (k: string) => `${r.map.pins.get(k)?.meter ?? ''}#branch`;
  const volts = (label: string, plus: string, minus = '0'): Trace => ({ label, unit: 'V', terms: [[plus, 1] as [string, number], [minus, -1] as [string, number]].filter(([n]) => n !== '0') });
  if ('part' in from) {
    const pins = [...r.map.pins].filter(([k]) => k.startsWith(`${from.part}|`));
    if (pins.length !== 2) return null;
    const [[ka, a], [, b]] = pins as [[string, { meter: string; node: string }], [string, { meter: string; node: string }]];
    const comp = r.ed.doc.objects.find((o) => o.kind === 'component' && o.designator === from.part);
    return { label: from.part, from, v: volts(from.part, a.node, b.node), i: { label: from.part, unit: 'A', terms: [[meter(ka), 1]] }, at: comp && comp.kind === 'component' ? comp.at : null, along: null };
  }
  let best = -1, bd = tol;
  r.geo.runs.forEach((run_, i) => { const d = distToSeg(from.at, run_.a, run_.b); if (d <= bd) { bd = d; best = i; } });
  if (best < 0) return null;
  const run_ = r.geo.runs[best]!, node = r.map.nets.get(run_.net) ?? '0';
  const label = run_.pin ? run_.pin.replace('|', ' pin ') : run_.net;
  const dx = run_.b.x - run_.a.x, dy = run_.b.y - run_.a.y, l2 = dx * dx + dy * dy, len = Math.sqrt(l2);
  const u = l2 ? Math.max(0, Math.min(1, ((from.at.x - run_.a.x) * dx + (from.at.y - run_.a.y) * dy) / l2)) : 0;
  const at = { x: run_.a.x + u * dx, y: run_.a.y + u * dy };
  const i: Trace = { label, unit: 'A', terms: run_.pin ? [[meter(run_.pin), 1]] : r.geo.sums[best]!.map(([p, sign]): [string, number] => [meter(p), sign]) };
  return { label, from: { at }, v: volts(label, node), i, at, along: len ? { x: dx / len, y: dy / len } : null };
}

/** What a point of the sheet reads: the wire or pin there, else the two-pin part an object's key names. */
function readAt(r: Run, raw: Vec2, key: string | null): Reading | null {
  const px = 1 / (r.ed.viewport?.cam.scale ?? 1);
  const got = readProbe(r, { at: raw }, 6 * px);
  if (got || !key) return got;
  const o = r.ed.doc.objects[parseInt(key.slice(1), 10)];
  return o?.kind === 'component' ? readProbe(r, { part: o.designator }, 0) : null;
}
/** Two probes of the same place read the same things. */
const sameReading = (a: Pick<Probe, 'label' | 'v' | 'i'>, b: Pick<Probe, 'label' | 'v' | 'i'>) => a.label === b.label && JSON.stringify([a.v?.terms, a.i?.terms]) === JSON.stringify([b.v?.terms, b.i?.terms]);

/**
 * A point of the running sheet taken: as the probe (a click: on the scope picked until the next click), as a monitor on the
 * sheet only, kept on the scope picked, or kept on a scope of its own.
 */
function take(raw: Vec2, key: string | null, how: 'probe' | 'monitor' | 'scope' | 'new'): boolean {
  const r = run;
  if (!r?.sim) return false;
  const got = readAt(r, raw, key);
  if (!got) return false;
  let sc = scope.value;
  // The same place has one colour, on the sheet and on every scope
  const twin = sc.kept.find((p) => sameReading(p, got));
  const colour = twin?.colour ?? PROBE_COLOURS.find((c) => !sc.kept.some((k) => k.colour === c)) ?? PROBE_COLOURS[sc.kept.length % PROBE_COLOURS.length]!;
  const make = (on: number): Probe => ({ id: ++probeIds, colour, gone: false, scope: on, ...got });
  if (how === 'probe') {
    // What the scope picked already keeps isn't taken twice
    scope.value = { ...sc, probe: sc.kept.some((p) => p.scope === sc.current && sameReading(p, got)) ? null : make(sc.current) };
  } else {
    let on = how === 'monitor' ? 0 : sc.current;
    if (how === 'new') {
      // The first scope while it is still empty will do for "a new scope"
      const free = sc.scopes.find((s) => !sc.kept.some((p) => p.scope === s.id) && sc.probe?.scope !== s.id);
      on = free ? free.id : addScope(false);
      if (!on) return false;
      sc = scope.value;
    }
    if (!sc.kept.some((p) => p.scope === on && sameReading(p, got))) {
      if (sc.kept.length >= MAX_KEPT) { notify(`No more than ${MAX_KEPT} monitors at once: take one off first`, 'error'); return false; }
      scope.value = { ...sc, current: on || sc.current, probe: sc.probe && sameReading(sc.probe, got) ? null : sc.probe, kept: [...sc.kept, make(on)] };
    }
    saveWatch();
  }
  if (r.record && [got.v, got.i].some((tr) => tr?.terms.some(([n]) => !r.record!.has(n)))) record();
  r.ed.refreshOverlay();
  return true;
}
/** After a change to the sheet: each probe read again where it was taken; one whose place is gone says so. */
function reprobe(): void {
  const r = run, sc = scope.value;
  if (!r || (!sc.probe && !sc.kept.length)) return;
  // (where it was taken stays as it was: it is what the sheet keeps of it)
  const again = (p: Probe): Probe => { const got = r.sim ? readProbe(r, p.from, 50_000) : null; return got ? { ...p, ...got, from: p.from, gone: false } : { ...p, gone: true }; };
  scope.value = { ...sc, probe: sc.probe ? again(sc.probe) : null, kept: sc.kept.map(again) };
}
/** The probe kept: it stays on the sheet as a monitor and on its scope while the next is taken. */
export function keepProbe(): void {
  const sc = scope.value;
  if (!sc.probe) return;
  if (sc.kept.length >= MAX_KEPT) { notify(`No more than ${MAX_KEPT} monitors at once: take one off first`, 'error'); return; }
  scope.value = { ...sc, probe: null, kept: [...sc.kept, sc.probe] };
  saveWatch();
}
export function dropProbe(id: number): void {
  // A meter's: it feeds no scope from now on (a change to the part, to be undone like any other)
  if (id < 0) { setLiveField(-id - 1, 'On Scope', 'None'); return; }
  const sc = scope.value; scope.value = { ...sc, probe: sc.probe?.id === id ? null : sc.probe, kept: sc.kept.filter((p) => p.id !== id) }; saveWatch(); run?.ed.refreshOverlay(); }
/** A scope's probes taken off (`on`: its id; 0: the monitors on the sheet only), or all of them. */
export function clearProbes(on?: number): void {
  const sc = scope.value;
  scope.value = on === undefined ? { ...sc, probe: null, kept: [] } : { ...sc, probe: sc.probe?.scope === on ? null : sc.probe, kept: sc.kept.filter((p) => p.scope !== on) };
  saveWatch();
  run?.ed.refreshOverlay();
}
/** The scope the next probe goes to. Moving on keeps what the probe was showing where it was. */
/** Every probe taken off and one scope left, against time: an example starts from this and adds the scopes its test points name. */
export function resetScopes(): void { scope.value = { probe: null, kept: [], scopes: [{ id: 1, view: 'time' }], current: 1 }; }
export function setCurrentScope(id: number): void {
  const sc = scope.value;
  if (id === sc.current || !sc.scopes.some((s) => s.id === id)) return;
  scope.value = { ...sc, current: id, probe: null, kept: sc.probe && sc.kept.length < MAX_KEPT ? [...sc.kept, sc.probe] : sc.kept };
  saveWatch();
}
/** Another scope beside the others, picked for the next probe; its id (0: there are as many as there may be). */
export function addScope(save = true): number {
  const sc = scope.value;
  if (sc.scopes.length >= MAX_SCOPES) { notify(`No more than ${MAX_SCOPES} scopes at once`, 'error'); return 0; }
  const id = Math.max(0, ...sc.scopes.map((s) => s.id)) + 1;
  scope.value = { ...sc, scopes: [...sc.scopes, { id, view: 'time' }], current: id, probe: null, kept: sc.probe && sc.kept.length < MAX_KEPT ? [...sc.kept, sc.probe] : sc.kept };
  if (save) saveWatch();
  return id;
}
/** A scope closed, with what it drew (the last one stays). */
export function removeScope(id: number): void {
  const sc = scope.value;
  if (sc.scopes.length < 2 || !sc.scopes.some((s) => s.id === id)) return;
  const scopes = sc.scopes.filter((s) => s.id !== id);
  scope.value = { ...sc, scopes, current: sc.current === id ? scopes[0]!.id : sc.current, probe: sc.probe?.scope === id ? null : sc.probe, kept: sc.kept.filter((p) => p.scope !== id) };
  saveWatch();
  run?.ed.refreshOverlay();
}
export function setScopeView(id: number, view: ScopeView): void { const sc = scope.value; scope.value = { ...sc, scopes: sc.scopes.map((s) => (s.id === id ? { ...s, view } : s)) }; saveWatch(); }

/* ─── Kept with the sheet (see liveSaved) ─── */
/** What a sheet keeps of its Live Simulation (null: nothing). */
function savedOn(ed: SchEditor): LiveSaved | null { const p = docParam(ed.doc, LIVE_SAVED); return p ? readLiveSaved(p.value) : null; }
/** The monitors and scopes as they are now, as a sheet keeps them. */
function watchNow(zero = false): LiveSaved {
  const sc = scope.value, place = new Map(sc.scopes.map((s, i) => [s.id, i + 1]));
  return { views: sc.scopes.map((s) => s.view), zero, keep: sc.kept.map((p) => ({ from: p.from, scope: place.get(p.scope) ?? 0 })) };
}
/**
 * The monitors and scopes written to their sheet (the one running, or the one they were last run on while it is open):
 * a change to the sheet, undone like any other and saved with it. A sheet that keeps nothing and has nothing to keep is left alone.
 */
function saveWatch(): void {
  const ed = run?.ed ?? (watchedOn && docs.value.some((d) => d.editor === watchedOn) ? watchedOn : null);
  if (!ed) return;
  const was = docParam(ed.doc, LIVE_SAVED);
  const text = liveSavedText(watchNow(run?.ed === ed && live.value ? live.value.zero : readLiveSaved(was?.value ?? '')?.zero ?? false));
  if ((was?.value ?? '') === text) return;
  const change = docParamChange(ed.doc, LIVE_SAVED, text);
  if (!change) return;
  const mine = run?.ed === ed && run.revision === ed.undo.revision;
  ed.undo.transact('Change what Live Simulation watches', (tx) => tx.add(change));
  // (the circuit is as it was: the run has nothing to build again)
  if (mine) run!.revision = ed.undo.revision;
  if (run?.ed === ed) run.watchSaved = true;
}
/** The scopes and monitors a sheet keeps, put back: each monitor read where it was taken (one whose place is gone says so). */
function restoreWatch(r: Run | null, kept: LiveSaved): void {
  const scopes: ScopeDef[] = (kept.views.length ? kept.views : ['time' as ScopeView]).map((view, i) => ({ id: i + 1, view }));
  // (a monitor on a scope past the last kept: the scopes go that far)
  for (const k of kept.keep) while (k.scope > scopes.length && scopes.length < MAX_SCOPES) scopes.push({ id: scopes.length + 1, view: 'time' });
  const probes: Probe[] = [];
  for (const k of kept.keep) {
    const got = r?.sim ? readProbe(r, k.from, 50_000) : null;
    const label = 'part' in k.from ? k.from.part : 'A point';
    const twin = got ? probes.find((p) => sameReading(p, got)) : undefined;
    const colour = twin?.colour ?? PROBE_COLOURS.find((c) => !probes.some((p) => p.colour === c)) ?? PROBE_COLOURS[probes.length % PROBE_COLOURS.length]!;
    probes.push({ id: ++probeIds, colour, scope: Math.min(k.scope, scopes.length), ...(got ?? { label, v: null, i: null, at: null, along: null }), from: k.from, gone: !got });
  }
  const sc = scope.value;
  scope.value = { probe: null, kept: probes, scopes, current: scopes.some((s) => s.id === sc.current) ? sc.current : 1 };
}

/** For tests and scripts: a point of the sheet (document units) taken as a click there takes it, or kept as the right-click menu keeps it. */
export function probeAt(at: Vec2, how: 'probe' | 'monitor' | 'scope' | 'new' = 'probe'): boolean { return take(at, null, how); }
/** The right-click menu's: what was right-clicked reads something; it is kept somewhere; keep it; take it off. */
export function contextReads(): boolean { const r = run; return !!r?.sim && active.value?.editor === r.ed && !!readAt(r, r.ed.contextAt, r.ed.contextKey); }
export function contextKept(): boolean { const r = run, got = r?.sim && active.value?.editor === r.ed ? readAt(r, r.ed.contextAt, r.ed.contextKey) : null; return !!got && scope.value.kept.some((p) => sameReading(p, got)); }
export function contextTake(how: 'monitor' | 'scope' | 'new'): boolean { const r = run; return !!r && take(r.ed.contextAt, r.ed.contextKey, how); }
export function contextDrop(): void {
  const r = run, got = r?.sim ? readAt(r, r.ed.contextAt, r.ed.contextKey) : null;
  if (!got) return;
  const sc = scope.value;
  scope.value = { ...sc, probe: sc.probe && sameReading(sc.probe, got) ? null : sc.probe, kept: sc.kept.filter((p) => !sameReading(p, got)) };
  saveWatch();
  r!.ed.refreshOverlay();
}

/** The read-outs on the sheet now: each place watched once, with its voltage and current as they are. */
export function liveMonitors(): { label: string; text: string; colour: number; at: Vec2 | null; along: Vec2 | null; /** On a pin (its `along` points to its part). */ pin: boolean; kept: boolean; scopes: number[]; /** A meter of the sheet's own (no ring: the part is its mark). */ meter?: boolean; /** Its reading goes under it (the meter is on its side). */ under?: boolean; /** A test point: its reading goes beside its head, clear of the wire it stands on. */ point?: boolean }[] {
  const r = run, sim = r?.sim, sc = scope.value;
  if (!r || !sim) return [];
  const now = (tr: Trace | null) => (tr ? tr.terms.reduce((s, [n, f]) => s + f * (sim.valueOf(n) ?? 0), 0) : 0);
  const out: ReturnType<typeof liveMonitors> = [], first: Probe[] = [];
  for (const p of [...sc.kept, ...(sc.probe ? [sc.probe] : [])]) {
    if (p.gone) continue;
    const kept = p !== sc.probe, k = first.findIndex((q) => sameReading(q, p));
    if (k >= 0) { const twin = out[k]!; if (p.scope && !twin.scopes.includes(p.scope)) twin.scopes.push(p.scope); twin.kept ||= kept; continue; }
    first.push(p);
    out.push({ label: p.label, text: `${p.label}: ${reads(now(p.v), 'V')}, ${reads(now(p.i), 'A')}`, colour: p.colour, at: p.at, along: p.along, pin: / pin /.test(p.label), kept, scopes: p.scope ? [p.scope] : [] });
  }
  // The sheet's meters: each reads out what it is set to show (of the stretch of time a scope draws, where that is asked for)
  const rec = r.record, st = live.value, clock = performance.now();
  r.gear.filter(isMeter).forEach((g, k) => {
    const tr = g.v ?? g.i, unit = g.v ? 'V' : 'A';
    if (g.shows === 'Value' || !rec || !st || !tr) g.text = reads(now(tr), unit);
    else if (clock - g.textAt > 250) {
      const d = rec.series(tr, rec.latest - shownSpeed(st) * SCOPE_SPAN), m = d ? measure(d.t, d.y, d) : null;
      g.textAt = clock;
      g.text = !m ? reads(now(tr), unit) : g.shows === 'Mean' ? `${reads(m.mean, unit)} mean` : g.shows === 'RMS' ? `${reads(m.rms, unit)} RMS` : `${reads(m.max - m.min, unit)} peak to peak`;
    }
    out.push({ label: g.designator, text: g.text, colour: gearProbe(g, k).colour, at: g.at, along: null, pin: false, kept: true, scopes: g.scope ? [g.scope] : [], meter: true, under: g.side, point: g.kind === 'testpoint' });
  });
  return out;
}

/** A probe's trace over the time a scope shows; `lo` and `hi`: what it reached between the samples (see LiveRecord). */
interface Series { t: Float64Array; y: Float64Array; lo?: Float64Array; hi?: Float64Array; m: Measure | null }
interface Shown { probe: Probe; kept: boolean; gone: boolean }
export type ScopeData =
  | { view: 'time'; from: number; to: number; probes: (Shown & { v: Series | null; i: Series | null })[] }
  | { view: 'spectrum'; f: Float64Array; note?: string; probes: (Shown & { unit: 'V' | 'A'; a: Float64Array })[] }
  | { view: 'response'; f: Float64Array; note?: string; probes: (Shown & { db: Float64Array; deg: Float64Array })[] };

/** The circuit's response to its AC sources, from 0.1 Hz to 100 MHz. */
interface Response { f: Float64Array; vec: Map<string, { re: ArrayLike<number>; im: ArrayLike<number> }> }
function responseOf(r: Run): Response | string {
  if (r.response) return r.response;
  try {
    const sim = new Simulator(readNetlist(r.netlist, { include: r.include }), {}, { deviceCurrents: false, powers: false, subcircuitNodes: false });
    const plot = sim.ac({ kind: 'ac', sweep: 'dec', points: 30, fstart: 0.1, fstop: 1e8 });
    r.response = { f: Float64Array.from(plot.x!.values), vec: new Map(plot.vectors.map((v) => [v.name.toLowerCase(), { re: v.re, im: v.im ?? [] }])) };
  } catch (e) { r.response = e instanceof Error ? e.message : String(e); }
  return r.response;
}

/** The pace the scope's time goes by: the speed asked for, or the pace kept where the circuit can't keep up with it. */
const shownSpeed = (st: LiveState): number => (st.pace > 0 && st.pace < st.speed * 0.8 ? st.pace : st.speed);

/** What a scope draws now (the one picked, unless another is named): each of its probes against time, as a spectrum, or the circuit's response at it. */
export function scopeData(id = scope.value.current): ScopeData | null {
  const r = run, st = live.value, sc = scope.value, def = sc.scopes.find((s) => s.id === id);
  if (!r || !st || !def) return null;
  const meters = r.gear.filter(isMeter).map(gearProbe).filter((p) => p.scope === id);
  const list: Shown[] = [...meters.map((probe) => ({ probe, kept: true, gone: false })), ...sc.kept.filter((p) => p.scope === id).map((probe) => ({ probe, kept: true, gone: probe.gone })),
    ...(sc.probe && sc.probe.scope === id ? [{ probe: sc.probe, kept: false, gone: sc.probe.gone }] : [])];
  const rec = r.record;
  if (def.view === 'response') {
    const res = r.netlist ? responseOf(r) : 'Nothing is running.';
    if (typeof res === 'string') return { view: 'response', f: new Float64Array(0), note: res, probes: [] };
    let top = 0;
    const probes = list.map((p) => {
      const tr = p.probe.v ?? p.probe.i, n = res.f.length, db = new Float64Array(n), deg = new Float64Array(n);
      let gone = p.gone || !tr;
      for (let k = 0; k < n && tr; k++) {
        let re = 0, im = 0;
        for (const [name, f] of tr.terms) { const v = res.vec.get(name.toLowerCase()); if (!v) { gone = true; continue; } re += f * (v.re[k] ?? 0); im += f * (v.im[k] ?? 0); }
        const mag = Math.hypot(re, im);
        if (mag > top) top = mag;
        db[k] = 20 * Math.log10(Math.max(mag, 1e-15)); deg[k] = Math.atan2(im, re) * 180 / Math.PI;
      }
      return { ...p, gone, db, deg };
    });
    return { view: 'response', f: res.f, probes, note: list.length && top < 1e-12 ? 'No source has an AC magnitude: give the source the response is taken from an AC Magnitude of 1 in its simulation model.' : undefined };
  }
  if (!rec) return { view: 'time', from: 0, to: 1, probes: [] };
  if (def.view === 'time') {
    const to = Math.max(r.sim?.liveTime ?? st.time, rec.latest), from = to - shownSpeed(st) * SCOPE_SPAN;
    const series = (tr: Trace | null): Series | null => { const d = tr ? rec.series(tr, from) : null; return d ? { t: d.t, y: d.y, lo: d.lo, hi: d.hi, m: measure(d.t, d.y, d) } : null; };
    return { view: 'time', from, to, probes: list.map((p) => { const v = p.gone ? null : series(p.probe.v), i = p.gone ? null : series(p.probe.i); return { ...p, gone: p.gone || (!v && !i), v, i }; }) };
  }
  // The spectrum is of all the record holds: the longer the run has been kept, the finer its lines
  // (of what turns over faster than the samples kept can follow there is no spectrum to take: its lines would stand where they are not)
  let f: Float64Array = new Float64Array(0), fast = false;
  const probes = list.map((p) => {
    const tr = p.probe.v?.terms.length ? p.probe.v : p.probe.i ?? p.probe.v, d = tr && !p.gone ? rec.series(tr) : null;
    const quick = !!d && d.cycles > (d.y.length - 1) / 4, sp = d && !quick ? spectrum(d.t, d.y) : null;
    if (quick) fast = true;
    if (sp && sp.f.length > f.length) f = sp.f;
    return { ...p, gone: p.gone || !d, unit: tr?.unit ?? 'V', a: sp?.a ?? new Float64Array(0) };
  });
  return { view: 'spectrum', f, probes, note: f.length ? undefined : fast ? 'Too fast for a spectrum at this speed: set a lower speed.' : 'Too little of the run has been kept yet for a spectrum.' };
}

/* ─── A switch thrown, a push button held, a value turned ────────────────────────────── */

/** The switch or push button an object's key names (its component's index), or null. */
function contactAt(ed: SchEditor, key: string): { index: number; push: boolean } | null {
  const o = ed.doc.objects[parseInt(key.slice(1), 10)];
  if (!o || o.kind !== 'component') return null;
  const sub = simModelOf(ed.doc, o.index)?.subKind.toLowerCase();
  return sub === 'switch' || sub === 'push button' ? { index: o.index, push: sub === 'push button' } : null;
}
/** A push button pressed or let go: its picture and its contact follow while it is held; the sheet's file is left as it was. */
function press(r: Run, index: number, on: boolean): void {
  const o = r.ed.doc.objects[index];
  if (o?.kind === 'component') o.displayMode = on ? 1 : 0;
  r.held = on ? index : -1;
  r.ed.invalidate();
  build(false);
}
/** A switch opened or closed: a change to the sheet like any other (its picture is its state). */
export function throwSwitch(ed: SchEditor, index: number): void {
  const o = ed.doc.objects[index];
  if (!o || o.kind !== 'component') return;
  const closed = o.displayMode === 1;
  ed.undo.transact(`${closed ? 'Open' : 'Close'} ${o.designator}`, (tx) => tx.add(setProps(ed.doc, index, { DISPLAYMODE: closed ? null : '1' })));
}
const hit: NonNullable<SchEditor['liveHit']> = {
  near(at: Vec2): string | null {
    const r = run;
    if (!r) return null;
    for (const o of r.ed.doc.objects) {
      if (o.kind !== 'component' || Math.abs(o.at.x - at.x) > 900_000 || Math.abs(o.at.y - at.y) > 900_000) continue;
      if (contactAt(r.ed, `o${o.index}`) || r.gear.some((g) => g.kind === 'fuse' && g.index === o.index && blownNow(r, g))) return `o${o.index}`;
    }
    return null;
  },
  down(key: string): void {
    const r = run;
    if (!r) return;
    const c = contactAt(r.ed, key);
    if (c?.push) press(r, c.index, true);
  },
  up(key: string | null, p: ToolPointer, clicked: boolean): void {
    const r = run;
    if (!r) return;
    if (r.held >= 0) press(r, r.held, false);
    if (!clicked) return;
    const c = key ? contactAt(r.ed, key) : null;
    if (c && !c.push) throwSwitch(r.ed, c.index);
    // A blown fuse clicked is a new fuse (the sheet is not changed by it: a fuse's state is the run's)
    const f = key ? r.gear.find((g) => g.kind === 'fuse' && `o${g.index}` === key) : undefined;
    if (f && r.sim && blownNow(r, f)) { for (const n of f.switches ?? []) r.sim.liveSetSwitch(n, false); r.sim.liveDischarge(f.blown!.replace(/22$/, 'ch')); r.ed.invalidateOverlay(); return; }
    take(p.raw, key, 'probe');
  },
};

/** A number as a netlist takes it, to three figures: 4.7k, 100n, 2.2Meg. */
export const spiceText = (v: number): string => spiceFigures(v, 3);
/** The same to as many figures as asked. */
export function spiceFigures(v: number, figures: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  const steps: [number, string][] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'Meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const a = Math.abs(v), [k, s] = steps.find(([x]) => a >= x * 0.9995) ?? steps[steps.length - 1]!;
  return `${Number((v / k).toPrecision(figures))}${s}`;
}

/* ─── Solve for a value ──────────────────────────────────────────────────────────────── */

/** What a value can be found for: each thing the running sheet reads (a meter, a monitor, the probe), its voltage and its current apart. */
export function liveReadables(): { key: string; label: string; unit: 'V' | 'A' }[] {
  return readables().map(({ key, label, unit }) => ({ key, label, unit }));
}
function readables(): { key: string; label: string; unit: 'V' | 'A'; trace: Trace }[] {
  const r = run, sc = scope.value, out: ReturnType<typeof readables> = [];
  if (!r?.sim) return out;
  const add = (label: string, tr: Trace | null | undefined) => { if (tr && tr.terms.length && !out.some((x) => x.key === `${label}|${tr.unit}`)) out.push({ key: `${label}|${tr.unit}`, label, unit: tr.unit, trace: tr }); };
  for (const g of r.gear) if (isMeter(g)) { add(g.designator, g.v); add(g.designator, g.i); }
  for (const p of [...sc.kept, ...(sc.probe ? [sc.probe] : [])]) if (!p.gone) { add(p.label, p.v); add(p.label, p.i); }
  return out;
}
export interface Solved { ok: boolean; text: string; value?: number; reads?: number }
/**
 * A part's value found: the one at which a reading of the running sheet (`key`, from liveReadables) is `target` with the
 * circuit at its operating point, its sources at their steady values. The value is looked for four decades either side
 * of what it is now (across its range where it has one, as a potentiometer's position), where the reading passes the
 * target nearest to it, and written to the part: a change to the sheet like any other.
 */
export function liveSolve(index: number, param: string, key: string, target: number): Solved {
  const r = run, o = r?.ed.doc.objects[index];
  if (!r?.sim || !o || o.kind !== 'component') return { ok: false, text: 'Start the sheet running first.' };
  const doc = r.ed.doc, holder = simParamHolder(doc, index, param), bag = holder === null ? undefined : bagOf(doc, doc.objects[holder]!);
  const reading = readables().find((x) => x.key === key);
  if (!bag || !reading) return { ok: false, text: 'Pick a value of the part and something the sheet reads.' };
  if (!Number.isFinite(target)) return { ok: false, text: 'Type what it is to read (3.3, 20m).' };
  const field = kitFields(o.libRef)?.find((f) => f.param.toLowerCase() === param.toLowerCase());
  const was = bag.get('TEXT') ?? '', x0 = spiceNumber(was), unit = field?.unit ?? '', name = (field?.label ?? param).toLowerCase();
  // The netlist once, with a number in the value's place that nothing else in it is: each try is that number replaced
  const MARK = '987654321.123456789';
  let text: string, include: (n: string) => string | null;
  const marked = setProps(doc, holder!, { TEXT: MARK });
  try {
    marked.apply();
    const { project, sheets } = sheetOf(r.ed);
    const net = projectNetlist(compileProject(sheets, compileOptions(project)), sheets, readSimSettings(project?.prj), modelFinder(project), 'Live Simulation', { nets: new Map(), pins: new Map() });
    const files = includeFiles(project);
    text = net.text; include = (n) => files[n] ?? files[n.split(/[\\/]/).pop()!] ?? null;
  } catch (e) { return { ok: false, text: e instanceof Error ? e.message : String(e) }; }
  finally { marked.revert(); }
  if (!text.includes(MARK)) return { ok: false, text: `${o.designator}'s ${name} does not reach the circuit: nothing changes with it.` };
  const at = (x: number): number => {
    try {
      const sim = new Simulator(readNetlist(text.split(MARK).join(String(x)), { include }), {}, { deviceCurrents: false, powers: false, subcircuitNodes: false });
      sim.liveStart({});
      return reading.trace.terms.reduce((a, [n, f]) => a + f * (sim.valueOf(n) ?? NaN), 0);
    } catch { return NaN; }
  };
  const show = (v: number) => reads(v, reading.unit), value = (x: number) => `${spiceFigures(x, 4)}${unit ? ` ${unit}` : ''}`;
  const got = solveValue(at, target, x0, field?.range);
  if (!got.found) {
    if (Number.isNaN(got.least)) return { ok: false, text: 'The circuit has no operating point to solve at.' };
    return { ok: false, text: `No ${name} of ${o.designator} from ${value(got.from)} to ${value(got.to)} makes ${reading.label} read ${show(target)}: it reads from ${show(got.least)} to ${show(got.most)}.` };
  }
  const x = got.value;
  setLiveField(index, param, spiceFigures(x, 4));
  // (a resistor, capacitor or inductor comes in standard values: the nearest of the E24 series is named, with what the sheet would read at it)
  let standard = '';
  if (!field?.range && x > 0 && /^[ΩFH]$/.test(unit)) { const e = nearestE(x, 'E24').value, ye = at(e); if (Number.isFinite(ye) && e !== x) standard = ` The nearest standard value, ${value(e)}, gives ${show(ye)}.`; }
  return { ok: true, value: x, reads: got.reads, text: `${o.designator}'s ${name} is now ${value(x)}: ${reading.label} reads ${show(got.reads)} at the operating point.${standard}` };
}

export interface LiveField extends KitField { text: string; value: number }
/**
 * The one part selected on the sheet in front, with the values the panel can change: the kit's own for a part of the
 * palette; of any other part with a simulation model, every parameter its model has. Null: none, or no such part.
 */
export function liveFields(): { designator: string; index: number; name: string; fields: LiveField[] } | null {
  const ed = sheetInFront();
  if (!ed || ed.selection.size !== 1) return null;
  const o = ed.doc.objects[parseInt([...ed.selection][0]!.slice(1), 10)];
  if (!o || o.kind !== 'component') return null;
  const m = simModelOf(ed.doc, o.index);
  if (!m) return null;
  const kit = kitFields(o.libRef);
  const own = /current/i.test(m.kind) ? 'A' : 'V';
  // A current source of the palette shares its fields with the voltage source of its waveform
  const specs: KitField[] = kit ? kit.map((f) => (f.unit === 'V' && own === 'A' ? { ...f, unit: 'A' } : f))
    : (m.names ?? []).filter((n) => !/^(model|netlist)$/i.test(n)).map((n) => ({ param: n, label: n, unit: '' }));
  const fields: LiveField[] = [];
  for (const f of specs) {
    const h = simParamHolder(ed.doc, o.index, f.param), rec = h === null ? undefined : ed.doc.objects[h];
    if (!rec) continue;
    const text = bagOf(ed.doc, rec)?.get('TEXT') ?? '';
    fields.push({ ...f, text, value: spiceNumber(text) });
  }
  return fields.length ? { designator: o.designator, index: o.index, name: KIT.find((k) => k.libRef === o.libRef.toUpperCase())?.label ?? m.description ?? o.libRef, fields } : null;
}
let dragging = '';
/** A value written to a part: a change to the sheet like any other. `drag`: one of a slider's many while it is held, all of them one step to undo. */
export function setLiveField(index: number, param: string, text: string, drag = false): void {
  const ed = sheetInFront(), o = ed?.doc.objects[index];
  if (!ed || !o || o.kind !== 'component') return;
  const h = simParamHolder(ed.doc, index, param);
  if (h === null) return;
  const label = `Change ${o.designator}'s ${param.toLowerCase()}`;
  if (drag && dragging === label && ed.undo.undoLabel === label) ed.undo.undo();
  ed.undo.transact(label, (tx) => tx.add(setProps(ed.doc, h, { TEXT: text })));
  dragging = drag ? label : '';
}
/** The slider let go: its next move is a step of its own. */
export function endLiveDrag(): void { dragging = ''; }

/* ─── Keys while sketching, and examples to start from ───────────────────────────────── */

const SOUND_STORE = 'live.sound.v1';
/** Whether speakers are played (remembered). */
export const sound = signal<boolean>((() => { try { return localStorage.getItem(SOUND_STORE) !== '0'; } catch { return true; } })());
export function setSound(on: boolean): void {
  sound.value = on;
  try { localStorage.setItem(SOUND_STORE, on ? '1' : '0'); } catch { /* not kept */ }
  if (on) soundReady(); else soundStop();
}
const KEYS_STORE = 'live.sketchKeys.v1';
const stored = (): boolean => { try { return localStorage.getItem(KEYS_STORE) !== '0'; } catch { return true; } };
/** While a sheet runs, single keys place the palette's parts (R a resistor, C a capacitor …) in place of the menus they open otherwise. */
export const sketchKeys = signal<boolean>(stored());
export function setSketchKeys(on: boolean): void { sketchKeys.value = on; try { localStorage.setItem(KEYS_STORE, on ? '1' : '0'); } catch { /* not kept */ } }
/** The keys of what a sketch is joined up with: the sheet's own placing commands. */
export const WIRING_KEYS: Record<string, string> = { W: 'place.wire', G: 'place.gnd', T: 'place.text' };
/** A key pressed with the running sheet in front and nothing in hand: the part or wire it places (true: taken). */
export function sketchKey(combo: string): boolean {
  const r = run;
  if (!r || !live.value || !sketchKeys.value || active.value?.editor !== r.ed || !r.ed.selecting || chain.value) return false;
  const id = KIT_KEYS.get(combo), command = WIRING_KEYS[combo];
  if (id) { placeLivePart(id); return true; }
  if (command) { void commands.run(command, activeScope.value); return true; }
  return false;
}

