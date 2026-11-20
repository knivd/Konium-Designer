/**
 * The sums behind Tools › Calculators: the everyday ones a designer reaches for with a sheet open.
 * A voltage divider (any one of its values from the others), resistors or capacitors together, an
 * LED's resistor, RC and LC, Ohm's law and power, a regulator's feedback pair, reactance, the 555,
 * and the standard values (E6 to E192) nearest to what the sums give.
 *
 * Everything here is in base units (volts, amperes, ohms, farads, henries, hertz, seconds, watts)
 * and knows nothing of the panel: `readQuantity` and `showQuantity` are how a box's text becomes a
 * number and a number text. The board's calculators (a track's current, a via, clearance, impedance)
 * are in src/analysis/boardCalc.ts, on the analysis code's own formulas.
 */

/**
 * A quantity as it is typed: 4.7k, 4k7, 4R7, 10R, 100n, 2.2Meg, 1M, 20mA, 3.3 V, 1,5k. The scale
 * letters are the engineer's, not SPICE's: M is mega and m milli, k or K kilo, u or µ micro, n,
 * p, G; "meg" in any case is mega. A unit after it (Ω, ohm, V, A, F, H, Hz, W, s) is passed over.
 * NaN where the text is not a number.
 */
export function readQuantity(text: string): number {
  const s = text.trim().replace(',', '.');
  const m = /^([+-]?)(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s);
  if (!m) return NaN;
  const sign = m[1] === '-' ? -1 : 1;
  let v = Number(m[2] + (m[3] ?? ''));
  // (a space may stand between the number and what follows it, and nowhere else)
  let rest = s.slice(m[0].length).replace(/^\s+/, '');
  if (!rest) return sign * v;
  if (/\s/.test(rest.replace(/\s+(?=(Ω|ohms?|[VAFHWs]|Hz)$)/i, ''))) return NaN;
  rest = rest.replace(/\s+/g, '');
  // A scale letter (or R) standing for the decimal point: 4k7, 4R7, 2M2
  const mid = /^(meg|[GMkKmuµμnpR])(\d+)(.*)$/i.exec(rest);
  if (mid && !m[2]!.includes('.') && !m[3] && scaleOf(mid[1]!) !== undefined) {
    v = Number(`${m[2]}.${mid[2]}`) * scaleOf(mid[1]!)!;
    rest = mid[3]!;
    return /^(Ω|ohms?|[VAFHWs]|Hz)?$/i.test(rest) ? sign * v : NaN;
  }
  const meg = /^meg/i.exec(rest);
  if (meg) { v *= 1e6; rest = rest.slice(3); }
  else {
    // (a lone letter that is a unit and no scale: 10F is ten farads, 5m five thousandths)
    const sc = /^[GMkKmuµμnpR]/.exec(rest);
    if (sc && !(rest.length === 1 && /[FHAVWs]/.test(rest))) { v *= scaleOf(sc[0])!; rest = rest.slice(1); }
  }
  return /^(Ω|ohms?|[VAFHWs]|Hz)?$/i.test(rest) ? sign * v : NaN;
}

function scaleOf(letter: string): number | undefined {
  if (/^meg$/i.test(letter)) return 1e6;
  switch (letter) {
    case 'G': return 1e9;
    case 'M': return 1e6;
    case 'k': case 'K': return 1e3;
    case 'R': return 1;
    case 'm': return 1e-3;
    case 'u': case 'µ': case 'μ': return 1e-6;
    case 'n': return 1e-9;
    case 'p': return 1e-12;
  }
  return undefined;
}

const STEPS: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];

/** A quantity with its unit and scale letter, to `digits` figures with no noughts left trailing: 4.7 kΩ, 330 Ω, 2.481 V, 159.2 Hz. */
export function showQuantity(v: number, unit: string, digits = 4): string {
  if (!Number.isFinite(v)) return '?';
  if (v === 0) return `0 ${unit}`;
  const a = Math.abs(v);
  const [k, p] = STEPS.find(([x]) => a >= x * (1 - 0.5 * 10 ** -digits)) ?? STEPS[STEPS.length - 1]!;
  return `${Number((v / k).toPrecision(digits))} ${p}${unit}`;
}

/** A quantity as it would be typed into a box: 4.7k, 330, 100n (what showQuantity gives without its unit or its space). */
export function typed(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const [k, p] = STEPS.find(([x]) => a >= x * (1 - 0.5 * 10 ** -digits)) ?? STEPS[STEPS.length - 1]!;
  return `${Number((v / k).toPrecision(digits))}${p === 'µ' ? 'u' : p}`;
}

// ---- Standard values ----

export type ESeries = 'E6' | 'E12' | 'E24' | 'E48' | 'E96' | 'E192';
export const E_SERIES: ESeries[] = ['E6', 'E12', 'E24', 'E48', 'E96', 'E192'];

const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];

/** A series' values over one decade, from 1 up to (not reaching) 10. E6 to E24 are the tables as they are (they are not their formula's values); E48 to E192 the formula's, to three figures, with E192's one exception (9.20). */
export function eSeries(s: ESeries): number[] {
  if (s === 'E24') return E24;
  if (s === 'E12') return E24.filter((_, i) => i % 2 === 0);
  if (s === 'E6') return E24.filter((_, i) => i % 4 === 0);
  const n = Number(s.slice(1)), out: number[] = [];
  for (let i = 0; i < n; i++) { const v = Math.round(10 ** (i / n) * 100) / 100; out.push(s === 'E192' && v === 9.19 ? 9.2 : v); }
  return out;
}

/** The series' values about v: the nearest (by ratio), the one below and the one above (v itself, where it is one). */
export function nearestE(v: number, s: ESeries): { value: number; error: number; below: number; above: number } {
  if (!(v > 0) || !Number.isFinite(v)) return { value: NaN, error: NaN, below: NaN, above: NaN };
  const vals = eSeries(s), d = Math.floor(Math.log10(v)), scale = 10 ** d, tidy = (x: number) => Number(x.toPrecision(6));
  // (the decade below's last and the one above's first stand at either end)
  const all = [vals[vals.length - 1]! / 10, ...vals, 10, vals[1]! * 10].map((x) => tidy(x * scale));
  let below = all[0]!, above = all[all.length - 1]!;
  for (const x of all) { if (x <= v * (1 + 1e-9) && x > below) below = x; if (x >= v * (1 - 1e-9) && x < above) above = x; }
  const value = v / below <= above / v ? below : above;
  return { value, error: value / v - 1, below, above };
}

/** The pair of the series' values whose ratio a / b is nearest to `ratio`, with b in the decade of `about`. */
export function bestPair(ratio: number, s: ESeries, about: number): { a: number; b: number; ratio: number; error: number } | null {
  if (!(ratio > 0) || !(about > 0) || !Number.isFinite(ratio) || !Number.isFinite(about)) return null;
  const scale = 10 ** Math.floor(Math.log10(about)), tidy = (x: number) => Number(x.toPrecision(6));
  let best: { a: number; b: number; ratio: number; error: number } | null = null;
  for (const m of eSeries(s)) {
    const b = tidy(m * scale), e = nearestE(b * ratio, s);
    for (const a of [e.below, e.above]) {
      const err = a / b / ratio - 1;
      if (!best || Math.abs(err) < Math.abs(best.error) - 1e-12) best = { a, b, ratio: a / b, error: err };
    }
  }
  return best;
}

// ---- The calculators ----

const par = (a: number, b: number) => (a * b) / (a + b);
const ok = (...v: number[]) => v.every((x) => Number.isFinite(x));

export interface Divider { vin: number; r1: number; r2: number; vout: number; /** With the load across R2, where there is one. */ current: number; p1: number; p2: number; rout: number }
/**
 * A voltage divider, R1 from the input to the output and R2 from there to 0 V, with a load across
 * R2 where one is given: the value named by `find` from the other three. Null where they do not
 * make a divider (an output that is not between 0 V and the input, say).
 */
export function divider(find: 'vout' | 'r1' | 'r2' | 'vin', given: { vin?: number; r1?: number; r2?: number; vout?: number; load?: number }): Divider | null {
  let { vin = NaN, r1 = NaN, r2 = NaN, vout = NaN } = given;
  const load = given.load !== undefined && given.load > 0 && Number.isFinite(given.load) ? given.load : Infinity;
  const lower = (r: number) => (load === Infinity ? r : par(r, load));
  if (find === 'vout') { if (!ok(vin, r1, r2) || r1 < 0 || r2 < 0 || r1 + r2 <= 0) return null; vout = vin * lower(r2) / (r1 + lower(r2)); }
  else if (find === 'vin') { if (!ok(vout, r1, r2) || r1 < 0 || !(r2 > 0)) return null; vin = vout * (r1 + lower(r2)) / lower(r2); }
  else if (find === 'r1') { if (!ok(vin, vout, r2) || !(r2 > 0) || !(vout / vin > 0 && vout / vin <= 1)) return null; r1 = lower(r2) * (vin - vout) / vout; }
  else {
    if (!ok(vin, vout, r1) || !(r1 > 0) || !(vout / vin > 0 && vout / vin < 1)) return null;
    const low = r1 * vout / (vin - vout);
    if (!(low < load)) return null;
    r2 = load === Infinity ? low : 1 / (1 / low - 1 / load);
  }
  const low = lower(r2), current = vin / (r1 + low);
  if (!ok(vin, r1, r2, vout, current)) return null;
  return { vin, r1, r2, vout, current, p1: current * current * r1, p2: r2 > 0 ? (vout * vout) / r2 : 0, rout: load === Infinity ? par(r1, r2) || 0 : par(par(r1, r2) || 0, load) };
}

/** Parts in a row and side by side: resistors and inductors add in series, capacitors in parallel. */
export function combine(values: number[], capacitors: boolean): { series: number; parallel: number } | null {
  if (!values.length || values.some((v) => !(v > 0) || !Number.isFinite(v))) return null;
  const sum = values.reduce((a, v) => a + v, 0), inverse = 1 / values.reduce((a, v) => a + 1 / v, 0);
  return capacitors ? { series: inverse, parallel: sum } : { series: sum, parallel: inverse };
}

/** What to put with `first` to make `target`: beside it or in a row with it, whichever can. */
export function partner(first: number, target: number, capacitors: boolean): { value: number; how: 'series' | 'parallel' } | null {
  if (!(first > 0) || !(target > 0) || !ok(first, target) || first === target) return null;
  const grows: 'series' | 'parallel' = capacitors ? 'parallel' : 'series', shrinks: 'series' | 'parallel' = capacitors ? 'series' : 'parallel';
  return target > first ? { value: target - first, how: grows } : { value: (first * target) / (first - target), how: shrinks };
}

export interface LedResult { r: number; standard: number; current: number; pResistor: number; pLed: number }
/** The resistor for `count` LEDs in a row on a supply: for the current asked, and the series' next value up with the current that gives. */
export function ledResistor(supply: number, forward: number, current: number, count: number, series: ESeries): LedResult | null {
  const over = supply - forward * count;
  if (!ok(supply, forward, current) || !(current > 0) || !(over > 0) || !(count >= 1)) return null;
  const r = over / current, standard = nearestE(r, series).above, i = over / standard;
  return { r, standard, current: i, pResistor: i * i * standard, pLed: forward * i };
}

/** R and C: the corner frequency 1 / (2πRC), any one of the three from the other two. */
export function rc(find: 'f' | 'r' | 'c', given: { r?: number; c?: number; f?: number }): { r: number; c: number; f: number; tau: number } | null {
  let { r = NaN, c = NaN, f = NaN } = given;
  const k = 2 * Math.PI;
  if (find === 'f') f = 1 / (k * r * c); else if (find === 'r') r = 1 / (k * f * c); else c = 1 / (k * f * r);
  return ok(r, c, f) && r > 0 && c > 0 && f > 0 ? { r, c, f, tau: r * c } : null;
}

/** L and C: resonance at 1 / (2π√(LC)), any one of the three from the other two, and the pair's characteristic impedance √(L / C). */
export function lc(find: 'f' | 'l' | 'c', given: { l?: number; c?: number; f?: number }): { l: number; c: number; f: number; z: number } | null {
  let { l = NaN, c = NaN, f = NaN } = given;
  const w = 2 * Math.PI * f;
  if (find === 'f') f = 1 / (2 * Math.PI * Math.sqrt(l * c)); else if (find === 'l') l = 1 / (w * w * c); else c = 1 / (w * w * l);
  return ok(l, c, f) && l > 0 && c > 0 && f > 0 ? { l, c, f, z: Math.sqrt(l / c) } : null;
}

export type OhmPair = 'vi' | 'vr' | 'vp' | 'ir' | 'ip' | 'rp';
/** Ohm's law and power: any two of voltage, current, resistance and power give the other two. */
export function ohm(known: OhmPair, a: number, b: number): { v: number; i: number; r: number; p: number } | null {
  if (!ok(a, b)) return null;
  let v = NaN, i = NaN, r = NaN, p = NaN;
  switch (known) {
    case 'vi': v = a; i = b; r = v / i; p = v * i; break;
    case 'vr': v = a; r = b; i = v / r; p = v * i; break;
    case 'vp': v = a; p = b; i = p / v; r = v / i; break;
    case 'ir': i = a; r = b; v = i * r; p = v * i; break;
    case 'ip': i = a; p = b; v = p / i; r = v / i; break;
    case 'rp': r = a; p = b; if (r < 0 || p < 0) return null; i = Math.sqrt(p / r); v = i * r; break;
  }
  return ok(v, i, r, p) ? { v, i, r, p } : null;
}

export interface Feedback { vout: number; upper: number; lower: number; current: number }
/**
 * A regulator's feedback pair. With a feedback pin the reference stands across the lower resistor
 * (pin to 0 V): Vout = Vref·(1 + upper / lower). With an adjust pin (the LM317 and its like) it
 * stands across the upper one (output to pin) and the pin's own current flows in the lower:
 * Vout = Vref·(1 + lower / upper) + Iadj·lower. The value named by `find` from the others.
 */
export function feedback(find: 'vout' | 'upper' | 'lower', kind: 'fb' | 'adj', given: { vref: number; vout?: number; upper?: number; lower?: number; iadj?: number }): Feedback | null {
  const vref = given.vref, iadj = kind === 'adj' ? given.iadj ?? 0 : 0;
  let { vout = NaN, upper = NaN, lower = NaN } = given;
  // across: the resistor the reference stands across; other: the one that sets the rest
  let across = kind === 'fb' ? lower : upper, other = kind === 'fb' ? upper : lower;
  const wants = find === 'vout' ? 'vout' : (find === 'upper') === (kind === 'fb') ? 'other' : 'across';
  if (wants === 'vout') vout = vref * (1 + other / across) + iadj * other;
  else if (wants === 'other') other = (vout - vref) / (vref / across + iadj);
  else across = (vref * other) / (vout - vref - iadj * other);
  if (!ok(vref, vout, across, other) || !(vref > 0) || !(across > 0) || other < 0) return null;
  upper = kind === 'fb' ? other : across; lower = kind === 'fb' ? across : other;
  return { vout, upper, lower, current: vref / across };
}

/** A capacitor's and an inductor's reactance at a frequency: 1 / (2πfC) and 2πfL. */
export function reactance(f: number, c?: number, l?: number): { xc?: number; xl?: number } | null {
  if (!(f > 0) || !Number.isFinite(f)) return null;
  const out: { xc?: number; xl?: number } = {};
  if (c !== undefined && c > 0 && Number.isFinite(c)) out.xc = 1 / (2 * Math.PI * f * c);
  if (l !== undefined && l > 0 && Number.isFinite(l)) out.xl = 2 * Math.PI * f * l;
  return out.xc === undefined && out.xl === undefined ? null : out;
}

/** The 555 running free: high for ln 2·(R1 + R2)·C, low for ln 2·R2·C. */
export function timerAstable(r1: number, r2: number, c: number): { f: number; period: number; high: number; low: number; duty: number } | null {
  if (!ok(r1, r2, c) || !(r1 >= 0) || !(r2 > 0) || !(c > 0)) return null;
  const high = Math.LN2 * (r1 + r2) * c, low = Math.LN2 * r2 * c;
  return { f: 1 / (high + low), period: high + low, high, low, duty: high / (high + low) };
}

/** The 555 as a one-shot: its pulse lasts ln 3·R·C. */
export function timerOneShot(r: number, c: number): number | null {
  return ok(r, c) && r > 0 && c > 0 ? Math.log(3) * r * c : null;
}
