/**
 * SimView's state and arithmetic: each chart's visible X range (zoom and pan), how an AC chart
 * shows complex waves (magnitude, magnitude in dB, phase), the selected wave and the cursors A
 * and B on a wave, each wave's values (a signal or an expression of signals, worked out once),
 * axis ticks, and a chart as text (Tools › Copy to Clipboard as Text) or CSV (File › Export).
 * Wave › Clear Filter undoes a wave's highlight (the others dimmed); Edit › Cut, Paste and Insert
 * move a wave through SimView's own clipboard; the Vertical scroll commands move the plots.
 */
import { signal } from '@preact/signals';
import type { Plot, Vector } from '../sim/engine';
import type { ChartView, SimDataDocument, WaveRef } from '../sim/simData';
import { evalWave, waveSignals, type WaveValues } from '../sim/waveExpr';
import { engineering } from '../sim/num';
import { active, tick } from './state';

export type AcShow = 'Magnitude' | 'Magnitude (dB)' | 'Phase (°)';
export const AC_SHOW: AcShow[] = ['Magnitude', 'Magnitude (dB)', 'Phase (°)'];
export const WAVE_COLOURS = ['#d23c32', '#2e6fd1', '#1f9a4e', '#9a4fc4', '#e08a1e', '#1aa5b5', '#8a5a3c', '#d1489a', '#6b7f12', '#50607a'];

/** A wave on a chart: its plot and its place there. */
export interface WaveAt { plot: number; wave: number }
export interface Cursor extends WaveAt { x: number }

interface ViewState {
  ranges: Map<number, [number, number]>;
  ac: Map<number, AcShow>;
  selected: Map<number, WaveAt | null>;
  cursors: Map<number, { a?: Cursor; b?: Cursor }>;
  /** A wave picked by its name: drawn over the others, which are dimmed until Clear Filter. */
  filtered: Map<number, boolean>;
}
const states = new WeakMap<SimDataDocument, ViewState>();
export const simViewTick = signal(0);
const changed = () => { simViewTick.value++; };

export function viewOf(d: SimDataDocument): ViewState {
  let s = states.get(d);
  if (!s) { s = { ranges: new Map(), ac: new Map(), selected: new Map(), cursors: new Map(), filtered: new Map() }; states.set(d, s); }
  return s;
}
/**
 * Charts inserted or deleted at `at` (by +1 or −1): the view state kept for each chart (ranges,
 * AC display, selection, cursors, filter) moves with its chart; a deleted chart's goes.
 */
export function shiftCharts(d: SimDataDocument, at: number, by: 1 | -1): void {
  const v = viewOf(d);
  for (const m of [v.ranges, v.ac, v.selected, v.cursors, v.filtered] as Map<number, unknown>[]) {
    const moved = [...m].filter(([k]) => k >= at).sort(([x], [y]) => (by > 0 ? y - x : x - y));
    for (const [k] of moved) m.delete(k);
    for (const [k, val] of moved) if (!(by < 0 && k === at)) m.set(k + by, val);
  }
  changed();
}
/** Edit › Cut / Paste / Insert: a wave (its expression and look), kept for this session. */
export const waveClip = signal<WaveRef | null>(null);

/** The scroll box of the chart in view, and one plot's height (the Vertical commands' step). */
export const plotBoxes = new WeakMap<SimDataDocument, { el: HTMLElement; step: number }>();
export type VScroll = 'top' | 'bottom' | 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown';
/** Scroll View › Vertical Top, Bottom, Line Up / Down, Page Up / Down: the plots when there are more than fit. */
export function scrollPlots(d: SimDataDocument, how: VScroll): boolean {
  const b = plotBoxes.get(d);
  if (!b || !b.el.isConnected) return false;
  const { el, step } = b;
  const max = el.scrollHeight - el.clientHeight;
  const to = how === 'top' ? 0 : how === 'bottom' ? max : how === 'lineUp' ? el.scrollTop - step : how === 'lineDown' ? el.scrollTop + step
    : how === 'pageUp' ? el.scrollTop - el.clientHeight : el.scrollTop + el.clientHeight;
  el.scrollTop = Math.max(0, Math.min(max, to));
  return true;
}

export const activeSimData = (): SimDataDocument | null => (active.value?.doc.kind === 'SimData' ? active.value.doc : null);
/** The chart and the data it draws. */
export const chartOf = (d: SimDataDocument, k: number): { c: ChartView; p: Plot } | null => {
  const c = d.charts[k];
  const p = c ? d.plots[c.source] : undefined;
  return c && p ? { c, p } : null;
};
export const touch = (d: SimDataDocument) => { d.dirty = true; tick.value++; changed(); };

/** The plot's whole X extent. */
export function fullRange(p: Plot): [number, number] {
  const xs = p.x?.values ?? [];
  if (!xs.length) return [0, 1];
  let lo = Infinity, hi = -Infinity;
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}
export const isLogX = (p: Plot) => (p.analysis === 'ac' || p.analysis === 'noise') && (p.x?.values[0] ?? 0) > 0 && (p.x!.values.at(-1)! / p.x!.values[0]! > 50);

export function rangeOf(d: SimDataDocument, k: number): [number, number] {
  const cp = chartOf(d, k);
  return viewOf(d).ranges.get(k) ?? (cp ? fullRange(cp.p) : [0, 1]);
}
export function setRange(d: SimDataDocument, k: number, r: [number, number] | null): void {
  const v = viewOf(d), cp = chartOf(d, k);
  if (!cp) return;
  if (r) {
    const [a, b] = fullRange(cp.p);
    const log = isLogX(cp.p);
    const span = log ? Math.log(b / a) : b - a, min = span * 1e-6;
    let [x0, x1] = r;
    if (log ? Math.log(x1 / x0) < min : x1 - x0 < min) return;
    // Kept within the data (a little either side)
    if (log) { x0 = Math.max(a, x0); x1 = Math.min(b, x1); } else { const pad = span * 0.02; x0 = Math.max(a - pad, x0); x1 = Math.min(b + pad, x1); }
    if (!(x1 > x0)) return;
    v.ranges.set(k, [x0, x1]);
  } else v.ranges.delete(k);
  changed();
}

/** Zoom by a factor about an X (or the centre); pan by a part of the range. */
export function zoomAt(d: SimDataDocument, k: number, factor: number, at?: number): void {
  const cp = chartOf(d, k);
  if (!cp) return;
  const [x0, x1] = rangeOf(d, k);
  if (isLogX(cp.p)) {
    const c = Math.log(at ?? Math.sqrt(x0 * x1)), a = Math.log(x0), b = Math.log(x1);
    setRange(d, k, [Math.exp(c + (a - c) * factor), Math.exp(c + (b - c) * factor)]);
  } else {
    const c = at ?? (x0 + x1) / 2;
    setRange(d, k, [c + (x0 - c) * factor, c + (x1 - c) * factor]);
  }
}
export function panBy(d: SimDataDocument, k: number, part: number): void {
  const cp = chartOf(d, k);
  if (!cp) return;
  const [x0, x1] = rangeOf(d, k), [a, b] = fullRange(cp.p);
  if (isLogX(cp.p)) {
    let s = Math.log(x1 / x0) * part;
    s = Math.max(Math.log(a / x0), Math.min(Math.log(b / x1), s));
    setRange(d, k, [x0 * Math.exp(s), x1 * Math.exp(s)]);
  } else {
    let s = (x1 - x0) * part;
    s = Math.max(a - x0, Math.min(b - x1, s));
    setRange(d, k, [x0 + s, x1 + s]);
  }
}
export function panTo(d: SimDataDocument, k: number, end: boolean): void {
  const cp = chartOf(d, k);
  if (!cp) return;
  const [x0, x1] = rangeOf(d, k), [a, b] = fullRange(cp.p);
  if (isLogX(cp.p)) { const r = x1 / x0; setRange(d, k, end ? [b / r, b] : [a, a * r]); }
  else { const w = x1 - x0; setRange(d, k, end ? [b - w, b] : [a, a + w]); }
}

/* ─── Waves ─── */

const cache = new WeakMap<Plot, Map<string, WaveValues | Error>>();
/** A wave's values on its chart's data (a signal, or an expression of them); an Error when it can't be read. */
export function waveData(p: Plot, expr: string): WaveValues | Error {
  let m = cache.get(p);
  if (!m) { m = new Map(); cache.set(p, m); }
  let r = m.get(expr);
  if (!r) {
    const v = p.vectors.find((x) => x.name === expr);
    try { r = v ? { re: Float64Array.from(v.re), im: v.im ? Float64Array.from(v.im) : null } : evalWave(expr, p); } catch (e) { r = e as Error; }
    m.set(expr, r);
  }
  return r;
}
/** Forget worked-out waves of a plot (its data changed). */
export const forgetWaves = (p: Plot) => cache.delete(p);

/** A wave's values as the chart shows them (complex ones by the AC choice). */
export function shownValues(w: WaveValues, how: AcShow): ArrayLike<number> {
  if (!w.im) return w.re;
  const n = w.re.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const re = w.re[i]!, im = w.im[i]!;
    out[i] = how === 'Phase (°)' ? (Math.atan2(im, re) * 180) / Math.PI : how === 'Magnitude (dB)' ? 20 * Math.log10(Math.hypot(re, im) || 1e-300) : Math.hypot(re, im);
  }
  return out;
}

/** The unit a wave is in, as the chart shows it. */
export function waveUnit(p: Plot, expr: string, w: WaveValues | Error, how: AcShow): string {
  if (w instanceof Error) return '';
  if (w.im) return how === 'Magnitude (dB)' ? 'dB' : how === 'Phase (°)' ? '°' : unitOfExpr(p, expr);
  if (/^\s*db\s*\(/i.test(expr)) return 'dB';
  if (/^\s*(phase|ph)\s*\(/i.test(expr)) return '°';
  return unitOfExpr(p, expr);
}
const unitOfExpr = (p: Plot, expr: string): string => {
  const own = p.vectors.find((x) => x.name === expr);
  if (own) return own.unit;
  // V(a), MAG(a) …: a's unit; sums and differences of signals of one unit: that unit
  const one = /^\s*(?:mag|abs|v|real|re|avg|rms)\s*\(\s*([^,()]+)\s*\)\s*$/i.exec(expr);
  if (one) return p.vectors.find((x) => x.name.toLowerCase() === one[1]!.trim().toLowerCase())?.unit ?? '';
  if (/[*/^(]/.test(expr.replace(/\b[vi]\s*\(([^()]*)\)/gi, '$1'))) return '';
  const used = waveSignals(expr, p.vectors.map((v) => v.name)).map((n) => p.vectors.find((v) => v.name === n)!.unit);
  return used.length && used.every((u) => u === used[0]) ? used[0]! : '';
};

/** The waves of a chart in order (plot by plot), with their colours (their own, or by place). */
export function chartWaves(c: ChartView): (WaveRef & WaveAt & { colour: string; n: number })[] {
  const out: (WaveRef & WaveAt & { colour: string; n: number })[] = [];
  c.plots.forEach((pl, plot) => pl.forEach((w, wave) => { const n = out.length; out.push({ ...w, plot, wave, n, colour: w.colour ?? WAVE_COLOURS[n % WAVE_COLOURS.length]! }); }));
  return out;
}

/** A colour lightened (brightness above 0) or darkened (below), Document Options' Brightness. */
export function shade(hex: string, brightness = 0): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !brightness) return hex;
  const k = Math.max(-1, Math.min(1, brightness / 100));
  const ch = (i: number) => { const v = parseInt(m[1]!.slice(i, i + 2), 16); const out = k > 0 ? v + (255 - v) * k : v * (1 + k); return Math.round(out).toString(16).padStart(2, '0'); };
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}
/** The axis a wave is drawn against (within the plot's axes). */
export const axisOfWave = (c: ChartView, plot: number, wave: number): number => {
  const w = c.plots[plot]?.[wave];
  return Math.max(0, Math.min(axesOfPlot(c, plot) - 1, w?.axis ?? 0));
};
/** How many Y axes a plot has (its own, and those Add Y Axis gave it). */
export const axesOfPlot = (c: ChartView, plot: number): number =>
  Math.max(1, c.plotOpts?.[plot]?.axes?.length ?? 1, 1 + Math.max(0, ...(c.plots[plot] ?? []).map((w) => w.axis ?? 0)));

/** A wave's value at x (straight between its points); NaN outside it. */
export function valueAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number, log = false): number {
  const n = xs.length;
  if (!n || x < xs[0]! || x > xs[n - 1]!) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m]! <= x) lo = m; else hi = m; }
  const x0 = xs[lo]!, x1 = xs[hi]!;
  if (x1 === x0) return ys[lo]!;
  const f = log ? Math.log(x / x0) / Math.log(x1 / x0) : (x - x0) / (x1 - x0);
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

/** Ticks for a linear axis: 1, 2 or 5 × 10ⁿ apart, about `count` of them. */
export function niceTicks(a: number, b: number, count = 6): number[] {
  if (!(b > a)) return [a];
  const raw = (b - a) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}
/** Ticks for a log axis: the decades (and 2, 5 between when there are few). */
export function logTicks(a: number, b: number): { major: number[]; minor: number[] } {
  const major: number[] = [], minor: number[] = [];
  for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) {
    const d = 10 ** e;
    if (d >= a * (1 - 1e-9) && d <= b * (1 + 1e-9)) major.push(d);
    for (let m = 2; m < 10; m++) { const t = m * d; if (t > a && t < b) minor.push(t); }
  }
  if (major.length < 2) for (const t of minor) if ([2, 5].includes(Math.round(t / 10 ** Math.floor(Math.log10(t))))) major.push(t);
  return { major: major.sort((x, y) => x - y), minor };
}

/** Engineering text with a unit (5.000ms, 1.000kHz, 2.028V). */
export const eng = (v: number, unit = '', digits = 4): string => (Number.isFinite(v) ? `${engineering(v, digits).replace(/meg$/, 'M')}${unit}` : '—');

/** The chart's X and its waves as rows (header first). */
function chartRows(d: SimDataDocument, k: number, only?: WaveAt[]): (string | number)[][] {
  const cp = chartOf(d, k);
  if (!cp) return [];
  const { c, p } = cp;
  if (p.table) return [p.table.columns, ...p.table.rows];
  if (!p.x) return [['Signal', 'Value'], ...p.vectors.map((v) => [v.name, v.re[0]!])];
  const how = viewOf(d).ac.get(k) ?? 'Magnitude';
  const waves = chartWaves(c).filter((w) => !only || only.some((o) => o.plot === w.plot && (o.wave < 0 || o.wave === w.wave)));
  const cols = waves.map((w) => { const v = waveData(p, w.expr); return v instanceof Error ? [] : shownValues(v, how); });
  const rows: (string | number)[][] = [[p.x.name, ...waves.map((w) => w.expr)]];
  for (let i = 0; i < p.x.values.length; i++) rows.push([p.x.values[i]!, ...cols.map((col) => col[i] ?? '')]);
  return rows;
}
/** Tools › Copy to Clipboard as Text: tab-separated. */
export const chartText = (d: SimDataDocument, k: number): string => chartRows(d, k).map((r) => r.join('\t')).join('\n');
/** File › Export › Chart, Plot or Waveform: CSV. */
export function chartCsv(d: SimDataDocument, k: number, only?: WaveAt[]): string {
  const q = (v: string | number) => (typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${chartRows(d, k, only).map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}

/** File › Import: waves from CSV (an X column, then one per wave) as a chart's data. */
export function plotFromCsv(text: string, title: string): Plot {
  const rows = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')));
  const head = rows[0]!.some((c) => c && !Number.isFinite(Number(c))) ? rows.shift()! : rows[0]!.map((_, i) => (i ? `wave${i}` : 'x'));
  const cols = head.map((_, i) => rows.map((r) => Number(r[i])));
  const xName = head[0]!.toLowerCase();
  const analysis = /freq/.test(xName) ? 'ac' : /^v|source|sweep/.test(xName) ? 'dc' : 'tran';
  const vectors: Vector[] = head.slice(1).map((h, i) => ({ name: h, unit: '', re: cols[i + 1]! }));
  return { analysis, title, x: { name: head[0]!, unit: analysis === 'tran' ? 's' : analysis === 'ac' ? 'Hz' : '', values: cols[0]! }, vectors };
}
