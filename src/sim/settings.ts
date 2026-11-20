/**
 * Analyses Setup: what Design › Simulate › Mixed Sim runs, as AD17's dialog has it (General
 * Setup, the analyses each with its Enabled box, Advanced Options), and the analysis lines it
 * writes into the netlist. Kept in the project with the Mixed Sim output of its Simulator
 * Outputs group, as an output configuration (Configuration1_Item1=Name=Value|…) [est: the key
 * names AD uses there].
 */
import { iniGet, iniSections, iniSet, type PrjPcb } from '../formats/altium/prjpcb';
import { engineering, spiceNumber } from './num';
import type { Collect } from './engine';

export const COLLECT_OPTIONS = [
  'Node Voltage and Supply Current',
  'Node Voltage, Supply and Device Current',
  'Node Voltage, Supply Current, Device Current and Power',
  'Node Voltage, Supply Current and Subcircuit VARs',
  'Active Signals',
] as const;
export const SHEETS_OPTIONS = ['Active sheet', 'Active project'] as const;
export const SIMVIEW_OPTIONS = ['Keep last setup', 'Show active signals'] as const;
export const SWEEP_TYPES = ['Linear', 'Decade', 'Octave'] as const;
export const PZ_TRANSFER = ['V(output)/V(input)', 'V(output)/I(input)'] as const;
export const PZ_TYPES = ['Poles and Zeros', 'Poles Only', 'Zeros Only'] as const;
export const PARAM_SWEEP_TYPES = ['Absolute Values', 'Relative Values'] as const;
export const MC_DISTRIBUTIONS = ['Uniform', 'Gaussian', 'Worst Case'] as const;

export interface SimSettings {
  collect: (typeof COLLECT_OPTIONS)[number];
  sheets: (typeof SHEETS_OPTIONS)[number];
  simview: (typeof SIMVIEW_OPTIONS)[number];
  /** Signals shown when the results open (net names, device currents such as R1[i]). Empty: the named nets. */
  activeSignals: string[];
  op: boolean;
  tran: { on: boolean; start: string; stop: string; step: string; maxStep: string; uic: boolean; useDefaults: boolean; cycles: string; points: string; fourier: boolean; fourierFreq: string; harmonics: string };
  dc: { on: boolean; source: string; start: string; stop: string; step: string; secondary: boolean; source2: string; start2: string; stop2: string; step2: string };
  ac: { on: boolean; start: string; stop: string; sweep: (typeof SWEEP_TYPES)[number]; points: string };
  tf: { on: boolean; source: string; reference: string };
  noise: { on: boolean; source: string; start: string; stop: string; sweep: (typeof SWEEP_TYPES)[number]; points: string; summary: string; output: string; reference: string };
  pz: { on: boolean; input: string; inputRef: string; output: string; outputRef: string; transfer: (typeof PZ_TRANSFER)[number]; type: (typeof PZ_TYPES)[number] };
  temp: { on: boolean; start: string; stop: string; step: string };
  param: {
    on: boolean; variable: string; start: string; stop: string; step: string; type: (typeof PARAM_SWEEP_TYPES)[number];
    secondary: boolean; variable2: string; start2: string; stop2: string; step2: string; type2: (typeof PARAM_SWEEP_TYPES)[number];
  };
  /** Monte Carlo: tolerances as AD writes them (10%), Specific Tolerances as "R1=5%, C2=1%" [est]. */
  mc: { on: boolean; seed: string; distribution: (typeof MC_DISTRIBUTIONS)[number]; runs: string; res: string; cap: string; ind: string; tran: string; dcsrc: string; specific: string };
  /** Advanced Options: SPICE options, the reference net, the integration method. */
  options: Record<string, string>;
  reference: string;
  method: 'Trapezoidal' | 'Gear';
}

/** AD17's defaults for the options it lists (SPICE's own). */
export const OPTION_DEFAULTS: [name: string, value: string, what: string][] = [
  ['ABSTOL', '1.000p', 'Absolute current error tolerance'],
  ['CHGTOL', '10.00f', 'Charge error tolerance'],
  ['GMIN', '1.000p', 'Minimum conductance of a branch'],
  ['ITL1', '100', 'DC iteration limit'],
  ['ITL2', '50', 'DC transfer curve iteration limit'],
  ['ITL4', '10', 'Transient analysis iteration limit per time point'],
  ['RELTOL', '1.000m', 'Relative error tolerance'],
  ['TEMP', '27.00', 'Operating temperature (°C)'],
  ['TNOM', '27.00', 'Nominal temperature of models (°C)'],
  ['TRTOL', '7.000', 'Truncation error overestimation factor'],
  ['VNTOL', '1.000u', 'Absolute voltage error tolerance'],
  ['ACCT', '0', 'Report the run\'s statistics in Messages (1)'],
  ['DEFAD', '0.000', 'Default MOSFET drain area (m²)'],
  ['DEFAS', '0.000', 'Default MOSFET source area (m²)'],
  ['DEFL', '100.0u', 'Default MOSFET channel length (m)'],
  ['DEFW', '100.0u', 'Default MOSFET channel width (m)'],
  ['ITL5', '0', 'Transient analysis total iteration limit (0: none)'],
  ['PIVREL', '1.000m', 'Relative ratio between the largest column entry and an acceptable pivot'],
  ['RAMPTIME', '0.000', 'Time over which the sources ramp up at the start of a transient'],
  ['SRCSTEPS', '10', 'Source stepping: steps to bring the sources up'],
];

export function defaultSettings(): SimSettings {
  return {
    collect: 'Node Voltage, Supply Current, Device Current and Power', sheets: 'Active project', simview: 'Keep last setup', activeSignals: [],
    op: true,
    tran: { on: false, start: '0.000', stop: '5.000m', step: '20.00u', maxStep: '20.00u', uic: false, useDefaults: true, cycles: '5', points: '50', fourier: false, fourierFreq: '1.000k', harmonics: '10' },
    dc: { on: false, source: '', start: '0.000', stop: '1.000', step: '20.00m', secondary: false, source2: '', start2: '0.000', stop2: '1.000', step2: '100.0m' },
    ac: { on: false, start: '1.000', stop: '1.000meg', sweep: 'Decade', points: '100' },
    tf: { on: false, source: '', reference: '0' },
    noise: { on: false, source: '', start: '1.000', stop: '1.000meg', sweep: 'Decade', points: '100', summary: '0', output: '', reference: '0' },
    pz: { on: false, input: '', inputRef: '0', output: '', outputRef: '0', transfer: 'V(output)/V(input)', type: 'Poles and Zeros' },
    temp: { on: false, start: '0.000', stop: '100.0', step: '10.00' },
    param: { on: false, variable: '', start: '1.000k', stop: '10.00k', step: '1.000k', type: 'Absolute Values', secondary: false, variable2: '', start2: '1.000k', stop2: '10.00k', step2: '1.000k', type2: 'Absolute Values' },
    mc: { on: false, seed: '-1', distribution: 'Uniform', runs: '5', res: '10%', cap: '10%', ind: '10%', tran: '10%', dcsrc: '10%', specific: '' },
    options: Object.fromEntries(OPTION_DEFAULTS.map(([k, v]) => [k, v])),
    reference: 'GND',
    method: 'Trapezoidal',
  };
}

/* ─── In the project ─────────────────────────────────────────────────────────────────── */

const isSimGroup = (p: PrjPcb, s: string) => /^OutputGroup\d+$/i.test(s) && /^Simulator Outputs$/i.test(iniGet(p, s, 'Name') ?? '');

/** The Simulator Outputs group and the index of its Mixed Sim output (created when asked). */
function simOutput(p: PrjPcb, create: boolean): { section: string; index: number } | null {
  const sections = iniSections(p).map((s) => s.name);
  let section = sections.find((s) => isSimGroup(p, s));
  if (!section) {
    if (!create) return null;
    const n = Math.max(0, ...sections.map((s) => /^OutputGroup(\d+)$/i.exec(s)?.[1]).filter(Boolean).map(Number)) + 1;
    section = `OutputGroup${n}`;
    for (const [k, v] of [['Name', 'Simulator Outputs'], ['Description', ''], ['OutputType1', 'AdvSimNetlist'], ['OutputName1', 'Mixed Sim'], ['OutputDocumentPath1', ''], ['OutputVariantName1', ''], ['OutputDefault1', '0']] as const) iniSet(p, section, k, v);
  }
  for (let i = 1; i < 100; i++) {
    const t = iniGet(p, section, `OutputType${i}`);
    if (t === undefined) break;
    if (/^AdvSimNetlist$/i.test(t)) return { section, index: i };
  }
  if (!create) return null;
  let i = 1;
  while (iniGet(p, section, `OutputType${i}`) !== undefined) i++;
  for (const [k, v] of [['OutputType', 'AdvSimNetlist'], ['OutputName', 'Mixed Sim'], ['OutputDocumentPath', ''], ['OutputVariantName', ''], ['OutputDefault', '0']] as const) iniSet(p, section, `${k}${i}`, v);
  return { section, index: i };
}

const esc = (s: string) => s.replace(/[|=]/g, ' ');
const flag = (b: boolean) => (b ? 'True' : 'False');

/** The settings as one Name=Value|… item. */
export function settingsItem(s: SimSettings): string {
  const kv: [string, string][] = [
    ['Record', 'AdvSimSettings'], ['CollectDataFor', s.collect], ['SheetsToNetlist', s.sheets], ['SimViewSetup', s.simview], ['ActiveSignals', s.activeSignals.join(',')],
    ['OP', flag(s.op)],
    ['Tran', flag(s.tran.on)], ['TranStart', s.tran.start], ['TranStop', s.tran.stop], ['TranStep', s.tran.step], ['TranMaxStep', s.tran.maxStep], ['TranUIC', flag(s.tran.uic)],
    ['TranUseDefaults', flag(s.tran.useDefaults)], ['TranCycles', s.tran.cycles], ['TranPoints', s.tran.points], ['Fourier', flag(s.tran.fourier)], ['FourierFreq', s.tran.fourierFreq], ['FourierHarmonics', s.tran.harmonics],
    ['DC', flag(s.dc.on)], ['DCSource', s.dc.source], ['DCStart', s.dc.start], ['DCStop', s.dc.stop], ['DCStep', s.dc.step],
    ['DCSecondary', flag(s.dc.secondary)], ['DCSource2', s.dc.source2], ['DCStart2', s.dc.start2], ['DCStop2', s.dc.stop2], ['DCStep2', s.dc.step2],
    ['AC', flag(s.ac.on)], ['ACStart', s.ac.start], ['ACStop', s.ac.stop], ['ACSweep', s.ac.sweep], ['ACPoints', s.ac.points],
    ['TF', flag(s.tf.on)], ['TFSource', s.tf.source], ['TFReference', s.tf.reference],
    ['Noise', flag(s.noise.on)], ['NoiseSource', s.noise.source], ['NoiseStart', s.noise.start], ['NoiseStop', s.noise.stop], ['NoiseSweep', s.noise.sweep], ['NoisePoints', s.noise.points],
    ['NoiseSummary', s.noise.summary], ['NoiseOutput', s.noise.output], ['NoiseReference', s.noise.reference],
    ['PZ', flag(s.pz.on)], ['PZInput', s.pz.input], ['PZInputRef', s.pz.inputRef], ['PZOutput', s.pz.output], ['PZOutputRef', s.pz.outputRef], ['PZTransfer', s.pz.transfer], ['PZType', s.pz.type],
    ['TempSweep', flag(s.temp.on)], ['TempStart', s.temp.start], ['TempStop', s.temp.stop], ['TempStep', s.temp.step],
    ['ParamSweep', flag(s.param.on)], ['ParamVariable', s.param.variable], ['ParamStart', s.param.start], ['ParamStop', s.param.stop], ['ParamStep', s.param.step], ['ParamType', s.param.type],
    ['ParamSecondary', flag(s.param.secondary)], ['ParamVariable2', s.param.variable2], ['ParamStart2', s.param.start2], ['ParamStop2', s.param.stop2], ['ParamStep2', s.param.step2], ['ParamType2', s.param.type2],
    ['MonteCarlo', flag(s.mc.on)], ['MCSeed', s.mc.seed], ['MCDistribution', s.mc.distribution], ['MCRuns', s.mc.runs], ['MCResistor', s.mc.res], ['MCCapacitor', s.mc.cap],
    ['MCInductor', s.mc.ind], ['MCTransistor', s.mc.tran], ['MCDCSource', s.mc.dcsrc], ['MCSpecific', s.mc.specific.replace(/,/g, ';').replace(/=/g, ':')],
    ['ReferenceNet', s.reference], ['Method', s.method],
    ...Object.entries(s.options).map(([k, v]) => [`Option_${k}`, v] as [string, string]),
  ];
  return kv.map(([k, v]) => `${k}=${esc(v)}`).join('|');
}

export function parseSettingsItem(item: string): SimSettings {
  const s = defaultSettings();
  const m = new Map<string, string>();
  for (const part of item.split('|')) { const eq = part.indexOf('='); if (eq > 0) m.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim()); }
  const str = (k: string, d: string) => m.get(k.toLowerCase()) ?? d;
  const bool = (k: string, d: boolean) => { const v = m.get(k.toLowerCase()); return v === undefined ? d : /^true$/i.test(v); };
  const pick = <T extends string>(k: string, list: readonly T[], d: T): T => list.find((x) => x.toLowerCase() === str(k, '').toLowerCase()) ?? d;
  s.collect = pick('CollectDataFor', COLLECT_OPTIONS, s.collect);
  s.sheets = pick('SheetsToNetlist', SHEETS_OPTIONS, s.sheets);
  s.simview = pick('SimViewSetup', SIMVIEW_OPTIONS, s.simview);
  s.activeSignals = str('ActiveSignals', '').split(',').map((x) => x.trim()).filter(Boolean);
  s.op = bool('OP', s.op);
  const t = s.tran;
  Object.assign(t, { on: bool('Tran', t.on), start: str('TranStart', t.start), stop: str('TranStop', t.stop), step: str('TranStep', t.step), maxStep: str('TranMaxStep', t.maxStep), uic: bool('TranUIC', t.uic),
    useDefaults: bool('TranUseDefaults', t.useDefaults), cycles: str('TranCycles', t.cycles), points: str('TranPoints', t.points), fourier: bool('Fourier', t.fourier), fourierFreq: str('FourierFreq', t.fourierFreq), harmonics: str('FourierHarmonics', t.harmonics) });
  const d = s.dc;
  Object.assign(d, { on: bool('DC', d.on), source: str('DCSource', d.source), start: str('DCStart', d.start), stop: str('DCStop', d.stop), step: str('DCStep', d.step),
    secondary: bool('DCSecondary', d.secondary), source2: str('DCSource2', d.source2), start2: str('DCStart2', d.start2), stop2: str('DCStop2', d.stop2), step2: str('DCStep2', d.step2) });
  Object.assign(s.ac, { on: bool('AC', s.ac.on), start: str('ACStart', s.ac.start), stop: str('ACStop', s.ac.stop), sweep: pick('ACSweep', SWEEP_TYPES, s.ac.sweep), points: str('ACPoints', s.ac.points) });
  Object.assign(s.tf, { on: bool('TF', s.tf.on), source: str('TFSource', s.tf.source), reference: str('TFReference', s.tf.reference) });
  const nz = s.noise;
  Object.assign(nz, { on: bool('Noise', nz.on), source: str('NoiseSource', nz.source), start: str('NoiseStart', nz.start), stop: str('NoiseStop', nz.stop), sweep: pick('NoiseSweep', SWEEP_TYPES, nz.sweep),
    points: str('NoisePoints', nz.points), summary: str('NoiseSummary', nz.summary), output: str('NoiseOutput', nz.output), reference: str('NoiseReference', nz.reference) });
  const pz = s.pz;
  Object.assign(pz, { on: bool('PZ', pz.on), input: str('PZInput', pz.input), inputRef: str('PZInputRef', pz.inputRef), output: str('PZOutput', pz.output), outputRef: str('PZOutputRef', pz.outputRef),
    transfer: pick('PZTransfer', PZ_TRANSFER, pz.transfer), type: pick('PZType', PZ_TYPES, pz.type) });
  Object.assign(s.temp, { on: bool('TempSweep', s.temp.on), start: str('TempStart', s.temp.start), stop: str('TempStop', s.temp.stop), step: str('TempStep', s.temp.step) });
  const ps = s.param;
  Object.assign(ps, { on: bool('ParamSweep', ps.on), variable: str('ParamVariable', ps.variable), start: str('ParamStart', ps.start), stop: str('ParamStop', ps.stop), step: str('ParamStep', ps.step), type: pick('ParamType', PARAM_SWEEP_TYPES, ps.type),
    secondary: bool('ParamSecondary', ps.secondary), variable2: str('ParamVariable2', ps.variable2), start2: str('ParamStart2', ps.start2), stop2: str('ParamStop2', ps.stop2), step2: str('ParamStep2', ps.step2), type2: pick('ParamType2', PARAM_SWEEP_TYPES, ps.type2) });
  const mc = s.mc;
  Object.assign(mc, { on: bool('MonteCarlo', mc.on), seed: str('MCSeed', mc.seed), distribution: pick('MCDistribution', MC_DISTRIBUTIONS, mc.distribution), runs: str('MCRuns', mc.runs),
    res: str('MCResistor', mc.res), cap: str('MCCapacitor', mc.cap), ind: str('MCInductor', mc.ind), tran: str('MCTransistor', mc.tran), dcsrc: str('MCDCSource', mc.dcsrc), specific: str('MCSpecific', mc.specific).replace(/;/g, ',').replace(/:/g, '=') });
  s.reference = str('ReferenceNet', s.reference);
  s.method = /gear/i.test(str('Method', '')) ? 'Gear' : 'Trapezoidal';
  for (const [k, v] of m) if (k.startsWith('option_')) s.options[k.slice(7).toUpperCase()] = v;
  return s;
}

export function readSimSettings(p: PrjPcb | null | undefined): SimSettings {
  const at = p ? simOutput(p, false) : null;
  const item = at ? iniGet(p!, at.section, `Configuration${at.index}_Item1`) : undefined;
  return item ? parseSettingsItem(item) : defaultSettings();
}

export function writeSimSettings(p: PrjPcb, s: SimSettings): void {
  const at = simOutput(p, true)!;
  iniSet(p, at.section, `Configuration${at.index}_Name1`, 'OutputConfigurationParameter1');
  iniSet(p, at.section, `Configuration${at.index}_Item1`, settingsItem(s));
}

/* ─── Into the netlist ───────────────────────────────────────────────────────────────── */

const n = (v: string) => spiceNumber(v);
const SWEEP_CARD: Record<SimSettings['ac']['sweep'], string> = { Linear: 'LIN', Decade: 'DEC', Octave: 'OCT' };

/** Transient Analysis with Use Transient Defaults: the slowest periodic source sets the window. */
export function transientWindow(s: SimSettings, sourceFrequencies: number[]): { start: number; stop: number; step: number; maxStep: number } {
  const t = s.tran;
  if (t.useDefaults) {
    const f = Math.min(...sourceFrequencies.filter((x) => x > 0));
    const cycles = n(t.cycles) || 5, points = n(t.points) || 50;
    if (Number.isFinite(f)) { const step = 1 / (f * points); return { start: 0, stop: cycles / f, step, maxStep: step }; }
    return { start: 0, stop: 5e-3, step: 20e-6, maxStep: 20e-6 };
  }
  return { start: n(t.start) || 0, stop: n(t.stop), step: n(t.step), maxStep: n(t.maxStep) || n(t.step) };
}

/** The analysis and option cards (in the netlist's order: options, then analyses). */
export function analysisCards(s: SimSettings, o: { sourceFrequencies: number[]; signals: string[] }): { lines: string[]; errors: string[] } {
  const lines: string[] = [], errors: string[] = [];
  const opts = Object.entries(s.options).filter(([k, v]) => { const d = OPTION_DEFAULTS.find(([dk]) => dk === k); return !d || spiceNumber(d[1]) !== spiceNumber(v); });
  const optText = [...opts.map(([k, v]) => `${k}=${v}`), ...(s.method === 'Gear' ? ['METHOD=GEAR'] : [])];
  if (optText.length) lines.push(`.OPTIONS ${optText.join(' ')}`);
  const bad = (what: string, v: string) => { if (!Number.isFinite(spiceNumber(v))) errors.push(`${what}: "${v}" is not a number`); };
  if (s.tran.on) {
    const w = transientWindow(s, o.sourceFrequencies);
    if (!s.tran.useDefaults) { bad('Transient Stop Time', s.tran.stop); bad('Transient Step Time', s.tran.step); }
    if (!(w.stop > w.start)) errors.push('Transient Stop Time must be after its Start Time');
    else lines.push(`.TRAN ${engineering(w.step)} ${engineering(w.stop)} ${engineering(w.start)} ${engineering(w.maxStep)}${s.tran.uic ? ' UIC' : ''}`);
    if (s.tran.fourier && o.signals.length) lines.push(`.FOUR ${s.tran.fourierFreq} ${o.signals.map((x) => (/\[|#/.test(x) ? x : `V(${x})`)).join(' ')}`);
  }
  if (s.dc.on) {
    if (!s.dc.source) errors.push('DC Sweep Analysis: choose a Primary Source');
    else {
      [s.dc.start, s.dc.stop, s.dc.step].forEach((v) => bad('DC Sweep', v));
      lines.push(`.DC ${s.dc.source} ${s.dc.start} ${s.dc.stop} ${s.dc.step}${s.dc.secondary && s.dc.source2 ? ` ${s.dc.source2} ${s.dc.start2} ${s.dc.stop2} ${s.dc.step2}` : ''}`);
    }
  }
  if (s.ac.on) {
    [s.ac.start, s.ac.stop, s.ac.points].forEach((v) => bad('AC Small Signal Analysis', v));
    lines.push(`.AC ${SWEEP_CARD[s.ac.sweep]} ${s.ac.points} ${s.ac.start} ${s.ac.stop}`);
  }
  if (s.tf.on) {
    if (!s.tf.source) errors.push('Transfer Function Analysis: choose a Source Name');
    else for (const sig of o.signals.filter((x) => !/\[|#/.test(x))) lines.push(`.TF V(${sig}${s.tf.reference && s.tf.reference !== '0' ? `,${s.tf.reference}` : ''}) ${s.tf.source}`);
  }
  if (s.noise.on) {
    const z = s.noise;
    if (!z.source) errors.push('Noise Analysis: choose a Noise Source');
    else if (!z.output) errors.push('Noise Analysis: choose an Output Node');
    else {
      [z.start, z.stop, z.points].forEach((v) => bad('Noise Analysis', v));
      lines.push(`.NOISE V(${z.output}${z.reference && z.reference !== '0' ? `,${z.reference}` : ''}) ${z.source} ${SWEEP_CARD[z.sweep]} ${z.points} ${z.start} ${z.stop} ${Math.max(0, Math.round(n(z.summary) || 0))}`);
    }
  }
  if (s.pz.on) {
    const z = s.pz;
    if (!z.input || !z.output) errors.push('Pole-Zero Analysis: choose the Input and Output Nodes');
    else lines.push(`.PZ ${z.input} ${z.inputRef || '0'} ${z.output} ${z.outputRef || '0'} ${z.transfer === 'V(output)/V(input)' ? 'VOL' : 'CUR'} ${z.type === 'Poles Only' ? 'POL' : z.type === 'Zeros Only' ? 'ZER' : 'PZ'}`);
  }
  // Sweeps: every analysis above run again for each value [est: Konium's .STEP and .MC cards]
  if (s.temp.on) {
    [s.temp.start, s.temp.stop, s.temp.step].forEach((v) => bad('Temperature Sweep', v));
    lines.push(`.STEP TEMP ${s.temp.start} ${s.temp.stop} ${s.temp.step}`);
  }
  if (s.param.on) {
    const q = s.param;
    if (!q.variable) errors.push('Parameter Sweep: choose a Primary Sweep Variable');
    else {
      [q.start, q.stop, q.step].forEach((v) => bad('Parameter Sweep', v));
      lines.push(`.STEP ${q.variable} ${q.start} ${q.stop} ${q.step}${q.type === 'Relative Values' ? ' REL' : ''}`);
      if (q.secondary && q.variable2) lines.push(`.STEP ${q.variable2} ${q.start2} ${q.stop2} ${q.step2}${q.type2 === 'Relative Values' ? ' REL' : ''}`);
    }
  }
  if (s.mc.on) {
    const m = s.mc;
    const spec = m.specific.split(/[,;]/).map((x) => x.trim()).filter((x) => /^\S+\s*=\s*\S+$/.test(x)).map((x) => x.replace(/\s+/g, ''));
    lines.push(`.MC ${Math.max(1, Math.round(n(m.runs) || 1))} SEED=${m.seed || '-1'} DIST=${m.distribution === 'Gaussian' ? 'GAUSS' : m.distribution === 'Worst Case' ? 'WCASE' : 'UNIFORM'} RES=${m.res} CAP=${m.cap} IND=${m.ind} TRAN=${m.tran} DCSRC=${m.dcsrc}${spec.length ? ` ${spec.join(' ')}` : ''}`);
  }
  if (s.op) lines.push('.OP');
  return { lines, errors };
}

/** Total test points of a frequency sweep (AC, noise), as the dialog shows them. */
export function sweepPoints(a: { start: string; stop: string; sweep: SimSettings['ac']['sweep']; points: string }): number {
  const f1 = n(a.start), f2 = n(a.stop), p = Math.round(n(a.points));
  if (!(f1 > 0 && f2 > f1 && p > 0)) return 0;
  if (a.sweep === 'Linear') return p;
  const per = a.sweep === 'Decade' ? Math.log10(f2 / f1) : Math.log2(f2 / f1);
  return Math.floor(per * p + 1e-9) + 1;
}
export const acTotalPoints = (s: SimSettings): number => sweepPoints(s.ac);

/** Runs a setup's sweeps make (Temperature Sweep × Parameter Sweep × Monte Carlo). */
export function sweepRunCount(s: SimSettings): number {
  const count = (a: string, b: string, st: string) => { const x = n(a), y = n(b), d = n(st); return Number.isFinite(x) && Number.isFinite(y) && d ? Math.max(0, Math.floor((y - x) / d + 1e-9) + 1) : 0; };
  let runs = 1;
  if (s.temp.on) runs *= count(s.temp.start, s.temp.stop, s.temp.step);
  if (s.param.on && s.param.variable) {
    runs *= count(s.param.start, s.param.stop, s.param.step);
    if (s.param.secondary && s.param.variable2) runs *= count(s.param.start2, s.param.stop2, s.param.step2);
  }
  if (s.mc.on) runs *= Math.max(1, Math.round(n(s.mc.runs) || 1));
  return runs;
}

/** What Parameter Sweep can vary, from a netlist: parts' values (R1, C1, V1 …) and transistors' and diodes' model parameters (Q1[BF] …). */
export function sweepables(netlist: string): string[] {
  const PARAMS: Record<string, string[]> = { D: ['IS', 'N', 'RS', 'BV', 'CJO'], Q: ['BF', 'IS', 'VAF', 'RB'], M: ['KP', 'VTO', 'LAMBDA', 'W', 'L'], J: ['BETA', 'VTO', 'LAMBDA'] };
  const out: string[] = [];
  for (const line of netlist.split('\n')) {
    const name = line.trim().split(/\s+/)[0] ?? '';
    const k = name[0]?.toUpperCase() ?? '';
    if (!/^[A-Za-z]\w*$/.test(name)) continue;
    if ('RCLVI'.includes(k)) out.push(name);
    else if (PARAMS[k]) for (const p of PARAMS[k]!) out.push(`${name}[${p}]`);
  }
  return out;
}

/** What a run keeps, by Collect Data For (Active Signals: those alone). */
export function collectFor(s: SimSettings, active: string[]): Collect {
  switch (s.collect) {
    case 'Node Voltage and Supply Current': return { deviceCurrents: false, powers: false, subcircuitNodes: false };
    case 'Node Voltage, Supply and Device Current': return { deviceCurrents: true, powers: false, subcircuitNodes: false };
    case 'Node Voltage, Supply Current and Subcircuit VARs': return { deviceCurrents: false, powers: false, subcircuitNodes: true };
    case 'Active Signals': return { deviceCurrents: true, powers: true, subcircuitNodes: true, only: new Set(active.map((a) => a.toLowerCase())) };
    default: return { deviceCurrents: true, powers: true, subcircuitNodes: false };
  }
}
