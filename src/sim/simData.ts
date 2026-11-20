/**
 * Simulation results (.sdf): each analysis's plot as SPICE's ASCII raw file has it (Title,
 * Date, Plotname, Flags, No. Variables, No. Points, Variables, Values — the plots one after
 * another), so other waveform viewers read the waves too. Konium keeps what the raw format has
 * no place for — a plot's table (Fourier, Transfer Function), the charts (each on one analysis's
 * data: its plots, each plot's waves as expressions with their colours), the run's messages — on
 * "Konium:" lines (JSON) [est: AD's own .sdf is its own format].
 */
import type { Plot, SimMessage, Unit, Vector } from './engine';

/**
 * A wave on a plot: a signal or an expression of signals (OUT, OUT-IN, DB(OUT)), its colour, the
 * Y axis it is drawn against (0 the plot's own; Plot › Add Y Axis gives more), and Wave Options'
 * line width, style and data points.
 */
export interface WaveRef { expr: string; colour?: string; axis?: number; width?: number; style?: 'solid' | 'dash' | 'dot'; points?: boolean }
/** A Y axis (Format Y Axis): its label, a logarithmic scale, a fixed range (absent: fitted to the waves). */
export interface AxisOpts { label?: string; log?: boolean; min?: number; max?: number }
/** Plot Options: the plot's title, its grid, and its Y axes (the first its own). */
export interface PlotOpts { title?: string; grid?: boolean; axes?: AxisOpts[] }
/** A chart (a tab of SimView): the analysis data it draws (an index into plots), its plots top to bottom. */
export interface ChartView { title: string; source: number; plots: WaveRef[][]; plotOpts?: (PlotOpts | null)[] }
/** Document Options: SimView's colours (absent: the theme's) and the waves' brightness (−100 to 100). */
export interface SimLook { background?: string; area?: string; grid?: string; text?: string; brightness?: number }

export interface SimDataDocument {
  kind: 'SimData';
  name: string;
  title: string;
  date: string;
  /** The data: one per analysis (and the FFTs made from them). */
  plots: Plot[];
  messages: SimMessage[];
  /** The charts, as the tabs show them. */
  charts: ChartView[];
  /** The chart tab in front. */
  active: number;
  /** Waveforms stored (Tools › Store Waveform), recalled into a chart of the same analysis kind. */
  stored?: { name: string; analysis: Plot['analysis']; x: number[]; re: number[]; im?: number[]; unit: Vector['unit'] }[];
  /** The netlist it came from. */
  netlist?: string;
  /** Document Options. */
  look?: SimLook;
  dirty: boolean;
}

const TYPE_OF: Record<Unit, string> = { V: 'voltage', A: 'current', W: 'power', s: 'time', Hz: 'frequency', 'V/√Hz': 'voltage-density', 'A/√Hz': 'current-density', '': 'notype' };
const UNIT_OF: Record<string, Unit> = { voltage: 'V', current: 'A', power: 'W', time: 's', frequency: 'Hz', 'voltage-density': 'V/√Hz', 'current-density': 'A/√Hz' };

const num = (v: number) => (Number.isFinite(v) ? v.toExponential(15) : String(v));

export function writeSimData(d: SimDataDocument): string {
  const out: string[] = [];
  d.plots.forEach((p, k) => {
    const cols: { name: string; unit: Unit; re: ArrayLike<number>; im?: ArrayLike<number> }[] = [];
    if (p.x) cols.push({ name: p.x.name, unit: p.x.unit, re: p.x.values, ...(p.complex ? { im: new Array(p.x.values.length).fill(0) } : {}) });
    for (const v of p.vectors) cols.push(v);
    const points = Math.max(1, ...cols.map((c) => c.re.length));
    out.push(`Title: ${d.title}`, `Date: ${d.date}`, `Plotname: ${p.title}`, `Flags: ${p.complex ? 'complex' : 'real'}`, `No. Variables: ${cols.length}`, `No. Points: ${points}`);
    const extra: Record<string, unknown> = { analysis: p.analysis, x: !!p.x };
    if (p.table) extra.table = p.table;
    if (p.segments) extra.segments = p.segments;
    if (p.runs) extra.runs = p.runs;
    if (k === 0) { extra.charts = d.charts; extra.messages = d.messages; extra.active = d.active; if (d.netlist) extra.netlist = d.netlist; if (d.stored?.length) extra.stored = d.stored; if (d.look && Object.keys(d.look).length) extra.look = d.look; }
    out.push(`Konium: ${JSON.stringify(extra)}`);
    out.push('Variables:');
    cols.forEach((c, i) => out.push(`\t${i}\t${c.name}\t${TYPE_OF[c.unit] ?? 'notype'}`));
    out.push('Values:');
    for (let j = 0; j < points; j++) {
      cols.forEach((c, i) => {
        const re = c.re[j] ?? NaN;
        const val = p.complex ? `${num(re)},${num(c.im?.[j] ?? 0)}` : num(re);
        out.push(i === 0 ? ` ${j}\t${val}` : `\t${val}`);
      });
    }
  });
  return `${out.join('\n')}\n`;
}

export function readSimData(text: string, name: string): SimDataDocument {
  const lines = text.replace(/\r/g, '').split('\n');
  const doc: SimDataDocument = { kind: 'SimData', name, title: '', date: '', plots: [], messages: [], charts: [], active: 0, dirty: false };
  const legacy: string[][] = [];
  let charts: ChartView[] | null = null;
  let i = 0;
  while (i < lines.length) {
    const head: Record<string, string> = {};
    let extra: Record<string, unknown> = {};
    while (i < lines.length && !/^Variables:/i.test(lines[i]!)) {
      const l = lines[i++]!;
      const m = /^([^:]+):\s?(.*)$/.exec(l);
      if (!m) continue;
      if (m[1] === 'Konium') { try { extra = JSON.parse(m[2]!); } catch { /* not ours */ } } else head[m[1]!.toLowerCase()] = m[2]!;
    }
    if (i >= lines.length) break;
    i++;
    const nv = Number(head['no. variables'] ?? 0), np = Number(head['no. points'] ?? 0);
    const complex = /complex/i.test(head.flags ?? '');
    const vars: { name: string; unit: Unit }[] = [];
    for (let k = 0; k < nv && i < lines.length; k++, i++) {
      const f = lines[i]!.trim().split(/\s+/);
      vars.push({ name: f[1] ?? `v${k}`, unit: UNIT_OF[(f[2] ?? '').toLowerCase()] ?? '' });
    }
    while (i < lines.length && !/^Values:/i.test(lines[i]!)) i++;
    i++;
    const re = vars.map(() => new Array<number>(np)), im = vars.map(() => new Array<number>(np));
    for (let j = 0; j < np; j++) {
      for (let k = 0; k < nv && i < lines.length; k++, i++) {
        const f = lines[i]!.trim().split(/\s+/);
        const v = (k === 0 ? f[1] : f[0]) ?? 'NaN';
        const [a, b] = v.split(',');
        re[k]![j] = Number(a);
        im[k]![j] = Number(b ?? 0);
      }
    }
    const analysis = (extra.analysis as Plot['analysis']) ?? guessAnalysis(head.plotname ?? '');
    const hasX = typeof extra.x === 'boolean' ? extra.x : analysis === 'tran' || analysis === 'ac' || analysis === 'dc';
    const vectors: Vector[] = vars.slice(hasX ? 1 : 0).map((v, k) => ({ name: v.name, unit: v.unit, re: re[k + (hasX ? 1 : 0)]!, ...(complex ? { im: im[k + (hasX ? 1 : 0)]! } : {}) }));
    const plot: Plot = { analysis, title: head.plotname ?? analysis, vectors, ...(complex ? { complex } : {}) };
    if (hasX && vars[0]) plot.x = { name: vars[0].name, unit: vars[0].unit, values: re[0]! };
    if (extra.table) plot.table = extra.table as Plot['table'];
    if (extra.segments) plot.segments = extra.segments as Plot['segments'];
    if (Array.isArray(extra.runs)) plot.runs = extra.runs as Plot['runs'];
    doc.plots.push(plot);
    legacy.push(Array.isArray(extra.shown) ? (extra.shown as string[]) : []);
    if (Array.isArray(extra.charts)) charts = extra.charts as ChartView[];
    if (Array.isArray(extra.stored)) doc.stored = extra.stored as SimDataDocument['stored'];
    if (!doc.title) { doc.title = head.title ?? ''; doc.date = head.date ?? ''; }
    if (Array.isArray(extra.messages)) doc.messages = extra.messages as SimMessage[];
    if (typeof extra.active === 'number') doc.active = extra.active;
    if (typeof extra.netlist === 'string') doc.netlist = extra.netlist;
    if (extra.look && typeof extra.look === 'object') doc.look = extra.look as SimLook;
  }
  // Charts as saved (26.059's files: a chart per analysis, its waves each in a plot of its own)
  doc.charts = (charts ?? doc.plots.map((p, k) => defaultChart(p, k, legacy[k] ?? []))).filter((c) => c.source >= 0 && c.source < doc.plots.length);
  doc.active = Math.min(Math.max(0, doc.active), Math.max(0, doc.charts.length - 1));
  return doc;
}

function guessAnalysis(name: string): Plot['analysis'] {
  if (/transient/i.test(name)) return 'tran';
  if (/ac /i.test(`${name} `)) return 'ac';
  if (/dc /i.test(`${name} `)) return 'dc';
  if (/transfer/i.test(name)) return 'tf';
  if (/fourier/i.test(name)) return 'four';
  return 'op';
}

export const isSimData = (text: string): boolean => /^Title:.*\n(Date:.*\n)?Plotname:/i.test(text.slice(0, 2000).replace(/\r/g, ''));

/** A chart of an analysis with these waves, each in a plot of its own (as SimView opens the Active Signals). */
export function defaultChart(p: Plot, source: number, waves: string[]): ChartView {
  return { title: p.title, source, plots: waves.map((w) => [{ expr: w }]) };
}
