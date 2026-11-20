/**
 * Live Simulation's record: a running circuit's signals kept as they go, for the scope. Every
 * accepted step adds the time and each signal's value to a ring; what is older than the ring
 * holds is forgotten. A trace is a sum of signals (a voltage across two nets, a wire run's
 * current as the pins beyond it take it), read back oldest first.
 *
 * A scope that shows seconds cannot keep every step of a circuit that turns over thousands of
 * times in each, so steps closer together than `spacing` are passed over. What is passed over
 * is still looked at: each sample kept carries the least and the most its signal reached since
 * the one before, its mean and mean square over that time, and how many times it had risen
 * through its middle by then. So a signal faster than the samples is drawn as the band it
 * fills, and its repeat rate, its mean and its RMS are taken from every step, not guessed from
 * samples that fall on it now here, now there. The samples are
 * kept at uneven gaps (between `spacing` and half as much again) so that such a signal is not
 * caught at the same point of its cycle each time.
 *
 * Beside it, what a scope shows of a trace: its least and most, how often it repeats, its
 * spectrum, and the round numbers its axis is marked in.
 */

/** What a scope draws: a sum of the record's signals, each by its name and a factor. */
export interface Trace { label: string; unit: 'V' | 'A'; terms: [signal: string, factor: number][] }
/**
 * A trace read back. `cycles`: how many times it rose through its middle over these samples, counted at every step
 * of the run (of a sum of signals, the most any one of them did: a sign of how fast it is, not a count). `lo` and `hi`,
 * of a trace that is one signal: the least and most it reached between each sample and the one before.
 *
 * `mean`: its mean between each sample and the one before (of a sum, the sum of the means); `sq`, of one signal: its mean square there.
 */
export interface Kept { t: Float64Array; y: Float64Array; lo?: Float64Array; hi?: Float64Array; mean?: Float64Array; sq?: Float64Array; cycles: number; /** The time the rises were counted over (the count starts once a signal has been watched a while). */ over: number; single: boolean }

/** How many samples kept the middle and swing of a signal are taken over, for counting its rises through the middle. */
const EPOCH = 32;

export class LiveRecord {
  private readonly index = new Map<string, number>();
  private readonly t: Float64Array;
  private readonly v: Float64Array[];
  /** Each sample kept: the least and the most its signal reached since the one before, and its rises through its middle by then. */
  private readonly lo: Float32Array[];
  private readonly hi: Float32Array[];
  private readonly cyc: Uint32Array[];
  /** Each sample kept: its signal's mean and mean square since the one before (by time, over every step). */
  private readonly avg: Float32Array[];
  private readonly msq: Float32Array[];
  /** Each signal's value at the last step, and its integral and its square's since the last sample kept. */
  private readonly was: Float64Array;
  private readonly area: Float64Array;
  private readonly square: Float64Array;
  /** The time of the last step (NaN: none yet). */
  private at = NaN;
  /** Each signal as the steps go by: its least and most since the last sample kept and over this epoch; the middle and band it is counted against; whether it is below them; its count. */
  private readonly curLo: Float64Array;
  private readonly curHi: Float64Array;
  private readonly envLo: Float64Array;
  private readonly envHi: Float64Array;
  private readonly mid: Float64Array;
  private readonly band: Float64Array;
  private readonly below: Uint8Array;
  private readonly rises: Uint32Array;
  /**
   * The middle and the band follow the signal cycle by cycle: each signal's least and most since its last rise counted (the
   * cycle that ends at the next one, whose middle the cycle after is counted against), the swing its band is a twentieth
   * of (that cycle's, or half the one before's where that is more: a signal that swells and fades, as two tones beating,
   * is counted through its quiet stretches), when it last rose and how long after the rise before, and its count at the
   * last epoch's end. Only a signal that has not risen for three such times, or never has, is set against what the last
   * epoch's samples saw of it: a ripple on a slow signal is not taken for the signal while the slow signal is being followed.
   */
  private readonly cycLo: Float64Array;
  private readonly cycHi: Float64Array;
  private readonly ref: Float64Array;
  private readonly rose: Float64Array;
  private readonly period: Float64Array;
  private readonly mark: Uint32Array;
  /** Which signals are currents (a source's or a meter's branch): their swings are weighed among themselves. */
  private readonly current: Uint8Array;
  /** The time each signal has been counted from (∞: it is not, having no swing to count against yet). */
  private readonly since: Float64Array;
  private epoch = 0;
  /** The samples the epoch in hand is to hold: few at first, so that the count starts soon. */
  private epochOf = 8;
  private head = 0;
  private n = 0;
  /** The gap to the next sample kept, in spacings (1 to 1.5, uneven). */
  private gap = 1;
  private seed = 0x2545f491;
  /** The least time between the samples kept (0: every step); the most is half as much again. */
  spacing = 0;

  constructor(readonly names: readonly string[], readonly size = 16384) {
    names.forEach((s, i) => this.index.set(s.toLowerCase(), i));
    const k = names.length;
    this.t = new Float64Array(size);
    this.v = names.map(() => new Float64Array(size));
    this.lo = names.map(() => new Float32Array(size));
    this.hi = names.map(() => new Float32Array(size));
    this.cyc = names.map(() => new Uint32Array(size));
    this.avg = names.map(() => new Float32Array(size));
    this.msq = names.map(() => new Float32Array(size));
    this.was = new Float64Array(k); this.area = new Float64Array(k); this.square = new Float64Array(k);
    this.curLo = new Float64Array(k).fill(Infinity); this.curHi = new Float64Array(k).fill(-Infinity);
    this.envLo = new Float64Array(k).fill(Infinity); this.envHi = new Float64Array(k).fill(-Infinity);
    this.mid = new Float64Array(k); this.band = new Float64Array(k); this.below = new Uint8Array(k); this.rises = new Uint32Array(k);
    this.since = new Float64Array(k).fill(Infinity);
    this.cycLo = new Float64Array(k).fill(Infinity); this.cycHi = new Float64Array(k).fill(-Infinity); this.ref = new Float64Array(k); this.mark = new Uint32Array(k);
    this.rose = new Float64Array(k).fill(-Infinity); this.period = new Float64Array(k);
    this.current = Uint8Array.from(names, (s) => (/#branch$/i.test(s) ? 1 : 0));
  }
  /** The same signals in the same order: the record carries on over a change that leaves them be. */
  same(names: readonly string[]): boolean { return names.length === this.names.length && names.every((s, i) => s === this.names[i]); }
  has(signal: string): boolean { return this.index.has(signal.toLowerCase()); }
  get count(): number { return this.n; }
  /** The time of the newest sample (−∞: none). */
  get latest(): number { return this.n ? this.t[(this.head + this.size - 1) % this.size]! : -Infinity; }
  /** The time of the oldest sample held (+∞: none). */
  get oldest(): number { return this.n ? this.t[(this.head + this.size - this.n) % this.size]! : Infinity; }
  clear(): void {
    this.head = 0; this.n = 0; this.epoch = 0; this.epochOf = 8; this.gap = 1; this.since.fill(Infinity); this.at = NaN; this.area.fill(0); this.square.fill(0);
    this.curLo.fill(Infinity); this.curHi.fill(-Infinity); this.envLo.fill(Infinity); this.envHi.fill(-Infinity);
    this.band.fill(0); this.below.fill(0); this.rises.fill(0);
    this.cycLo.fill(Infinity); this.cycHi.fill(-Infinity); this.ref.fill(0); this.mark.fill(0); this.rose.fill(-Infinity); this.period.fill(0);
  }

  /**
   * A step's values: `read(i)` gives signal i's. A step closer than `spacing` to the last one kept is passed over
   * as a sample, but counts towards the least, the most and the rises of the next one kept; a step before the last
   * starts the record again.
   */
  push(time: number, read: (i: number) => number): void {
    const last = this.latest;
    if (time < last) this.clear();
    const keep = !this.n || time - last >= this.spacing * this.gap, h = this.head;
    const { curLo, curHi, mid, band, below, rises, was, area, square, cycLo, cycHi, ref, rose, period } = this;
    // (the step from the last one: its part of each signal's integral, as a straight line between the two; and the time since the last sample kept)
    const dt = time > this.at ? time - this.at : 0, bin = this.n ? time - last : 0;
    this.at = time;
    for (let i = 0; i < this.v.length; i++) {
      const v = read(i);
      if (dt > 0) { const w = was[i]!; area[i]! += (v + w) * 0.5 * dt; square[i]! += (v * v + v * w + w * w) / 3 * dt; }
      was[i] = v;
      if (v < curLo[i]!) curLo[i] = v;
      if (v > curHi[i]!) curHi[i] = v;
      if (v < cycLo[i]!) cycLo[i] = v;
      if (v > cycHi[i]!) cycHi[i] = v;
      const b = band[i]!;
      if (b > 0) {
        const state = below[i]!;
        if (state === 1) {
          if (v > mid[i]! + b) {
            rises[i]!++;
            // The cycle that ends here is what the next is counted against (2: not yet over its middle, and not to be counted again for getting there)
            const least = cycLo[i]!, most = cycHi[i]!, sw = Math.max(most - least, ref[i]! * 0.5);
            mid[i] = (least + most) / 2; ref[i] = sw; band[i] = sw * 0.05; cycLo[i] = cycHi[i] = v;
            if (rose[i]! > -Infinity) period[i] = time - rose[i]!;
            rose[i] = time;
            below[i] = v > mid[i]! + band[i]! ? 0 : 2;
          }
        } else if (state === 2) { if (v > mid[i]! + b) below[i] = 0; }
        else if (v < mid[i]! - b) below[i] = 1;
      }
      if (!keep) continue;
      this.v[i]![h] = v; this.lo[i]![h] = curLo[i]!; this.hi[i]![h] = curHi[i]!; this.cyc[i]![h] = rises[i]!;
      this.avg[i]![h] = bin > 0 ? area[i]! / bin : v; this.msq[i]![h] = bin > 0 ? square[i]! / bin : v * v;
      area[i] = 0; square[i] = 0;
      if (curLo[i]! < this.envLo[i]!) this.envLo[i] = curLo[i]!;
      if (curHi[i]! > this.envHi[i]!) this.envHi[i] = curHi[i]!;
      curLo[i] = curHi[i] = v;
    }
    if (!keep) return;
    this.t[h] = time;
    this.head = (h + 1) % this.size;
    if (this.n < this.size) this.n++;
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    this.gap = 1 + this.seed / 8589934592;
    // Every so many samples: a signal that has not risen through its middle in them, nor for three times as long as it took
    // between its last two rises, is set against what these samples saw of it: their middle, and a twentieth of their swing
    // (a steady level's last digits are not a swing; nor is it counted before it has been watched this long)
    if (++this.epoch >= this.epochOf) {
      this.epoch = 0; this.epochOf = EPOCH;
      for (let i = 0; i < this.v.length; i++) {
        const lo = this.envLo[i]!, hi = this.envHi[i]!, swing = hi - lo, followed = rises[i] !== this.mark[i] || time - rose[i]! < 3 * period[i]!;
        this.mark[i] = rises[i]!;
        this.envLo[i] = Infinity; this.envHi[i] = -Infinity;
        if (followed) continue;
        mid[i] = (lo + hi) / 2;
        band[i] = swing > 1e-12 && swing > 1e-5 * Math.max(Math.abs(lo), Math.abs(hi)) ? swing * 0.05 : 0;
        ref[i] = swing;
        if (below[i] === 2) below[i] = 0;
        if (!(band[i]! > 0)) this.since[i] = Infinity; else if (this.since[i] === Infinity) this.since[i] = time;
      }
    }
  }

  /**
   * The circuit's own pace at the time `now`: the shortest time from one rise to the next among the signals that are being
   * followed (each rose within three such times) and whose swing counts for something, a hundredth of the largest value or
   * swing of its kind (voltages and currents apart): a supply's last digits trembling are not a pace. 0: nothing repeats.
   * An oscillator with no source to pace it is stepped by this (see liveStepLimit).
   */
  fastest(now: number): number {
    const { was, ref, band, rose, period, current } = this;
    let bigV = 0, bigA = 0;
    for (let i = 0; i < was.length; i++) { const s = Math.max(Math.abs(was[i]!), ref[i]!); if (current[i]) { if (s > bigA) bigA = s; } else if (s > bigV) bigV = s; }
    let best = Infinity;
    for (let i = 0; i < was.length; i++) {
      const p = period[i]!;
      if (!(p > 0) || p >= best || !(band[i]! > 0) || now - rose[i]! >= 3 * p) continue;
      if (ref[i]! >= 0.01 * (current[i] ? bigA : bigV)) best = p;
    }
    return best === Infinity ? 0 : best;
  }

  /** A trace from the time `from` on: its times and values, oldest first. A signal the record doesn't hold counts as none (null). */
  series(tr: Trace, from = -Infinity): Kept | null {
    const cols: [Float64Array, number][] = [], which: number[] = [];
    for (const [name, f] of tr.terms) {
      const k = name.toLowerCase();
      if (k === '0' || k === 'gnd') continue;
      const i = this.index.get(k);
      if (i === undefined) return null;
      cols.push([this.v[i]!, f]); which.push(i);
    }
    const start = (this.head + this.size - this.n) % this.size;
    // The first sample at or after `from` (times rise along the ring)
    let lo = 0, hi = this.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[(start + m) % this.size]! < from) lo = m + 1; else hi = m; }
    const len = this.n - lo, t = new Float64Array(len), y = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const at = (start + lo + j) % this.size;
      t[j] = this.t[at]!;
      let s = 0;
      for (const [col, f] of cols) s += f * col[at]!;
      y[j] = s;
    }
    // How fast it is: each signal's rises between the first sample and the last
    let cycles = 0, over = 0;
    if (len > 1) for (const i of which) {
      const c = (this.cyc[i]![(start + this.n - 1) % this.size]! - this.cyc[i]![(start + lo) % this.size]!) >>> 0;
      if (c >= cycles) { cycles = c; over = Math.max(0, t[len - 1]! - Math.max(t[0]!, this.since[i]!)); }
    }
    // Its mean between the samples: a sum's is the sum of its signals' (the first sample stands for itself)
    const mean = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      if (!j) { mean[0] = y[0]!; continue; }
      const at = (start + lo + j) % this.size;
      let m = 0;
      for (let c = 0; c < cols.length; c++) m += cols[c]![1] * this.avg[which[c]!]![at]!;
      mean[j] = m;
    }
    if (cols.length !== 1) return { t, y, mean, cycles, over, single: false };
    // One signal: what it reached between the samples too (the first sample stands for itself: what came before it is before `from`)
    const f = cols[0]![1], i = which[0]!, least = new Float64Array(len), most = new Float64Array(len), sq = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const at = (start + lo + j) % this.size, a = j ? f * this.lo[i]![at]! : y[j]!, b = j ? f * this.hi[i]![at]! : y[j]!;
      // (kept to fewer digits than the value: never inside it)
      least[j] = Math.min(a, b, y[j]!); most[j] = Math.max(a, b, y[j]!);
      sq[j] = j ? f * f * this.msq[i]![at]! : y[j]! * y[j]!;
    }
    return { t, y, lo: least, hi: most, mean, sq, cycles, over, single: true };
  }
}

/**
 * The longest step a frame of the live run may take: half of what the frame is to cover (`want`, seconds of the circuit's
 * time), a fortieth of the fastest source's period, and a fortieth of the circuit's own (`own`, LiveRecord.fastest: an
 * oscillator that is paced by no source turned over within steps of half its period at a raised speed, and read some
 * hundredths slow). The circuit's own pace never asks for more than 4,000 steps of a frame.
 */
export function liveStepLimit(want: number, fmax: number, own: number): number {
  return Math.min(want / 2, fmax > 0 ? 1 / (40 * fmax) : Infinity, own > 0 ? Math.max(own / 40, want / 4000) : Infinity);
}

export interface Measure { now: number; min: number; max: number; mean: number; /** Its root mean square (by time). */ rms: number; /** How often it repeats, Hz (0: it doesn't, or too little of it is seen to tell). */ freq: number }

/**
 * A trace's least, most and mean (by time), and how often it crosses its middle going up. `kept`, of a record's trace:
 * what it reached between the samples counts towards its least and most, and where it turns over within sixteen
 * samples, its rate is the count made at every step: a pulse a third of its cycle long falls between samples five to a
 * cycle now and then, and the rate read from them was some hundredths low. Of a sum of signals no such count is made:
 * it is read from its samples down to four to a cycle, and given no rate under that.
 */
export function measure(t: Float64Array, y: Float64Array, kept?: Pick<Kept, 'lo' | 'hi' | 'mean' | 'sq' | 'cycles' | 'over' | 'single'>): Measure | null {
  const n = y.length;
  if (!n) return null;
  // (of a sum of signals faster than the samples there is no mean square between them: the samples' own squares stand for it, which they do on the whole, falling as they do at uneven gaps)
  const fast = !!kept && kept.cycles > (n - 1) / 4;
  let min = Infinity, max = -Infinity, area = 0, square = 0;
  for (let i = 0; i < n; i++) {
    const v = y[i]!, least = kept?.lo ? kept.lo[i]! : v, most = kept?.hi ? kept.hi[i]! : v;
    if (least < min) min = least;
    if (most > max) max = most;
    if (!i) continue;
    const w = y[i - 1]!, dt = t[i]! - t[i - 1]!;
    area += (kept?.mean ? kept.mean[i]! : (v + w) * 0.5) * dt;
    square += (kept?.sq ? kept.sq[i]! : fast ? (v * v + w * w) * 0.5 : (v * v + v * w + w * w) / 3) * dt;
  }
  const span = t[n - 1]! - t[0]!, mean = span > 0 ? area / span : y[0]!, rms = span > 0 ? Math.sqrt(square / span) : Math.abs(y[0]!);
  // Rising crossings of the middle, with a band about it a tenth of the swing wide so that noise on the way isn't counted
  const mid = (min + max) / 2, band = (max - min) * 0.05;
  let freq = 0;
  // (a steady level's last digits are not a swing: it has to move by a hundred-thousandth of its own size, and by more than a picovolt or a picoamp, to be said to repeat)
  if (band > 0 && Number.isFinite(band) && max - min > 1e-12 && max - min > 1e-5 * Math.max(Math.abs(max), Math.abs(min))) {
    // (the band follows the swing cycle by cycle, never less than half the one before's: a trace that swells and fades is counted through its quiet stretches)
    let below = y[0]! < mid - band, first = NaN, lastAt = NaN, count = 0, width = band, ref = max - min, cLo = y[0]!, cHi = y[0]!;
    for (let i = 1; i < n; i++) {
      const v = y[i]!;
      if (v < cLo) cLo = v;
      if (v > cHi) cHi = v;
      if (below && v > mid + width) {
        // Where it went through the middle, between the samples
        let j = i; while (j > 0 && y[j - 1]! > mid) j--;
        const a = y[j - 1] ?? v, b = y[j]!, at = j > 0 && b !== a ? t[j - 1]! + (t[j]! - t[j - 1]!) * (mid - a) / (b - a) : t[i]!;
        if (!count) first = at;
        lastAt = at; count++; below = false;
        ref = Math.max(cHi - cLo, ref * 0.5); width = ref * 0.05; cLo = cHi = v;
      } else if (!below && v < mid - width) below = true;
    }
    if (count >= 2 && lastAt > first) freq = (count - 1) / (lastAt - first);
    // Fewer than sixteen samples to a cycle: the count made at every step; a sum faster than four to a cycle: nothing
    if (kept && kept.single && kept.over > 0 && kept.cycles > (n - 1) / 16) freq = kept.cycles / kept.over;
    else if (kept && fast) freq = 0;
  }
  return { now: y[n - 1]!, min, max, mean, rms, freq };
}

/** In-place radix-2 FFT (the length a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = re[i]!; re[i] = re[j]!; re[j] = a; const b = im[i]!; im[i] = im[j]!; im[j] = b; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * A trace's spectrum: taken at `n` even steps over what was kept (its mean off, a Hann window
 * over it), each frequency's amplitude as a sine of that size would read. The first frequency
 * is one cycle in the whole span; they go up to half the sampling rate.
 */
export function spectrum(t: Float64Array, y: Float64Array, n = 4096): { f: Float64Array; a: Float64Array } | null {
  const m = y.length;
  if (m < 8) return null;
  const span = t[m - 1]! - t[0]!;
  if (!(span > 0)) return null;
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let k = 0, j = 0; k < n; k++) {
    const at = t[0]! + span * k / n;
    while (j < m - 2 && t[j + 1]! < at) j++;
    const dt = t[j + 1]! - t[j]!;
    re[k] = dt > 0 ? y[j]! + (y[j + 1]! - y[j]!) * Math.min(1, Math.max(0, (at - t[j]!) / dt)) : y[j]!;
    mean += re[k]!;
  }
  mean /= n;
  for (let k = 0; k < n; k++) re[k] = (re[k]! - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / n));
  fft(re, im);
  const half = n >> 1, f = new Float64Array(half - 1), a = new Float64Array(half - 1);
  // The window passes half of a sine's size, and a sine is two lines of the transform: 4/n in all
  for (let k = 1; k < half; k++) { f[k - 1] = k / span; a[k - 1] = Math.hypot(re[k]!, im[k]!) * 4 / n; }
  return { f, a };
}

/** Round marks for an axis from lo to hi: about `about` steps of 1, 2 or 5 of a decade, the ends moved out to marks. */
export function niceAxis(lo: number, hi: number, about = 4): { lo: number; hi: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -1, hi: 1, step: 0.5 };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-15 * Math.max(1, Math.abs(lo), Math.abs(hi))) { const pad = Math.abs(lo) > 1e-12 ? Math.abs(lo) * 0.5 : 1; lo -= pad; hi += pad; }
  const raw = (hi - lo) / about, p = 10 ** Math.floor(Math.log10(raw)), r = raw / p;
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step };
}
