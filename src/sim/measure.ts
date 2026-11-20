/**
 * SimView's measurements: what the Sim Data panel shows for the cursors (A, B, B − A, and the
 * Minimum, Maximum, Average, RMS and Frequency of the wave between them) and for a whole wave
 * (Rise Time, Fall Time, Minimum, Maximum, Base, Top); the cursor moves of the Wave menu (Select
 * Minimum / Maximum Point, next Peak or Trough left or right); Chart › Create FFT Chart.
 */
import type { Plot, Vector } from './engine';

type Arr = ArrayLike<number>;

/** y at x, straight between points. */
export function yAt(xs: Arr, ys: Arr, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m]! <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]!) / (xs[hi]! - xs[lo]! || 1);
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

/** The wave between two X values: its points with the ends interpolated. */
function between(xs: Arr, ys: Arr, a: number, b: number): { x: number[]; y: number[] } {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const x = [lo], y = [yAt(xs, ys, lo)];
  for (let i = 0; i < xs.length; i++) if (xs[i]! > lo && xs[i]! < hi) { x.push(xs[i]!); y.push(ys[i]!); }
  x.push(hi); y.push(yAt(xs, ys, hi));
  return { x, y };
}

export interface CursorStats { ax: number; ay: number; bx: number; by: number; dx: number; dy: number; min: number; max: number; avg: number; rms: number; freq: number }

/** Measurement Cursors: the two cursors on a wave and the wave between them. */
export function cursorStats(xs: Arr, ys: Arr, ax: number, bx: number): CursorStats {
  const ay = yAt(xs, ys, ax), by = yAt(xs, ys, bx);
  const { x, y } = between(xs, ys, ax, bx);
  let min = Infinity, max = -Infinity, area = 0, sq = 0;
  for (let i = 0; i < x.length; i++) {
    if (y[i]! < min) min = y[i]!;
    if (y[i]! > max) max = y[i]!;
    if (i) { const h = x[i]! - x[i - 1]!; area += ((y[i]! + y[i - 1]!) / 2) * h; sq += ((y[i]! ** 2 + y[i - 1]! ** 2) / 2) * h; }
  }
  const span = x[x.length - 1]! - x[0]!;
  const avg = span > 0 ? area / span : ay, rms = span > 0 ? Math.sqrt(sq / span) : Math.abs(ay);
  return { ax, ay, bx, by, dx: bx - ax, dy: by - ay, min, max, avg, rms, freq: frequency(x, y, avg) };
}

/** Rising crossings of a level: their X values (interpolated). */
function crossings(x: Arr, y: Arr, level: number, rising: boolean): number[] {
  const out: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = y[i - 1]! - level, b = y[i]! - level;
    if (rising ? a < 0 && b >= 0 : a > 0 && b <= 0) out.push(x[i - 1]! + (a / (a - b)) * (x[i]! - x[i - 1]!));
  }
  return out;
}

/** The frequency of a periodic wave: rising crossings of its mean, a whole number of periods apart. */
export function frequency(x: Arr, y: Arr, mean: number): number {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < y.length; i++) { if (y[i]! < min) min = y[i]!; if (y[i]! > max) max = y[i]!; }
  // A little hysteresis: ignore crossings of noise on a flat wave
  if (!(max - min > 1e-12 * Math.max(1, Math.abs(max)))) return NaN;
  const c = crossings(x, y, mean, true);
  return c.length >= 2 ? (c.length - 1) / (c[c.length - 1]! - c[0]!) : NaN;
}

export interface WaveMeasures { rise: number; fall: number; min: number; max: number; base: number; top: number }

/** Waveform Measurements: base and top (the commonest levels of the lower and upper halves), the first 10–90 % rise and 90–10 % fall. */
export function waveMeasures(xs: Arr, ys: Arr): WaveMeasures {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < ys.length; i++) { if (ys[i]! < min) min = ys[i]!; if (ys[i]! > max) max = ys[i]!; }
  // Time-weighted histograms of the lower and upper halves; base and top are the mean level of each one's commonest bin
  const bins = 64, span = max - min || 1, w = new Array(bins).fill(0), wy = new Array(bins).fill(0);
  for (let i = 1; i < xs.length; i++) {
    const dt = xs[i]! - xs[i - 1]!, y = (ys[i]! + ys[i - 1]!) / 2, b = Math.min(bins - 1, Math.max(0, Math.floor(((y - min) / span) * bins)));
    w[b] += dt; wy[b] += dt * y;
  }
  const level = (from: number, to: number, d: number) => { let k = from; for (let b = from; b < to; b++) if (w[b] > w[k]) k = b; return w[k] > 0 ? wy[k] / w[k] : d; };
  const base = max > min ? level(0, bins / 2, min) : min, top = max > min ? level(bins / 2, bins, max) : max;
  const lo = base + 0.1 * (top - base), hi = base + 0.9 * (top - base);
  const edge = (rising: boolean) => {
    const from = crossings(xs, ys, rising ? lo : hi, rising), to = crossings(xs, ys, rising ? hi : lo, rising);
    for (const a of from) { const b = to.find((t) => t >= a); if (b !== undefined) return b - a; }
    return NaN;
  };
  return { rise: edge(true), fall: edge(false), min, max, base, top };
}

export type CursorMove = 'min' | 'max' | 'peakRight' | 'peakLeft' | 'troughRight' | 'troughLeft';

/** Where a cursor goes (an X value): the wave's lowest or highest point, or its next peak or trough from x. */
export function moveCursor(xs: Arr, ys: Arr, x: number, how: CursorMove): number {
  const n = xs.length;
  if (!n) return x;
  if (how === 'min' || how === 'max') {
    let k = 0;
    for (let i = 1; i < n; i++) if (how === 'min' ? ys[i]! < ys[k]! : ys[i]! > ys[k]!) k = i;
    return xs[k]!;
  }
  const peak = how.startsWith('peak'), right = how.endsWith('Right');
  const isExt = (i: number) => (peak ? ys[i]! > ys[i - 1]! && ys[i]! >= ys[i + 1]! : ys[i]! < ys[i - 1]! && ys[i]! <= ys[i + 1]!);
  if (right) { for (let k = 1; k < n - 1; k++) if (xs[k]! > x && isExt(k)) return xs[k]!; }
  else { for (let k = n - 2; k >= 1; k--) if (xs[k]! < x && isExt(k)) return xs[k]!; }
  return x;
}

/** Chart › Create FFT Chart: each wave's spectrum (its magnitude, as an AC chart shows it), sampled evenly over the range. */
export function fftPlot(p: Plot, names: string[], range?: [number, number]): Plot {
  const xs = p.x!.values;
  const t0 = range?.[0] ?? xs[0]!, t1 = range?.[1] ?? xs[xs.length - 1]!;
  let N = 1;
  const pts = xs.filter((x) => x >= t0 && x <= t1).length;
  while (N < Math.max(64, pts)) N *= 2;
  N = Math.min(N, 1 << 16);
  const dt = (t1 - t0) / N;
  const freqs = Array.from({ length: N / 2 }, (_, k) => k / (N * dt));
  const vectors: Vector[] = [];
  for (const name of names) {
    const v = p.vectors.find((x) => x.name === name);
    if (!v) continue;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = yAt(xs, v.re, t0 + i * dt);
    fft(re, im);
    const outR = new Float64Array(N / 2), outI = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) { const s = (k ? 2 : 1) / N; outR[k] = re[k]! * s; outI[k] = im[k]! * s; }
    vectors.push({ name, unit: v.unit, re: outR, im: outI });
  }
  // The DC point would sit at frequency 0 on a log axis: the chart starts at the first harmonic
  return { analysis: 'ac', title: `FFT of ${p.title}`, x: { name: 'frequency', unit: 'Hz', values: freqs.slice(1) },
    vectors: vectors.map((v) => ({ ...v, re: (v.re as Float64Array).slice(1), im: (v.im as Float64Array).slice(1) })), complex: true };
}

/** In-place radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j]!, ai = im[i + j]!, br = re[i + j + len / 2]! * cr - im[i + j + len / 2]! * ci, bi = re[i + j + len / 2]! * ci + im[i + j + len / 2]! * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
