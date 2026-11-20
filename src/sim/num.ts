/**
 * SPICE numbers: a mantissa with an optional exponent and scale factor — T, G, MEG, K, MIL, M,
 * U (and µ), N, P, F, any case — and any letters after it ignored (10uF, 4.7kΩ, 1MEGohm); AD's
 * fields take the same. Formatted back in engineering notation the way AD shows values (1.000k).
 */

const SCALE: [RegExp, number][] = [
  [/^meg/i, 1e6], [/^mil/i, 25.4e-6], [/^t/i, 1e12], [/^g/i, 1e9], [/^k/i, 1e3], [/^m/i, 1e-3],
  [/^[uµμ]/i, 1e-6], [/^n/i, 1e-9], [/^p/i, 1e-12], [/^f/i, 1e-15],
];

/** A SPICE number (NaN when the text doesn't start with one). */
export function spiceNumber(text: string): number {
  const s = text.trim();
  const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s);
  if (!m) return NaN;
  let v = Number(m[0]);
  const rest = s.slice(m[0].length);
  // 4k7 (a scale letter as the decimal point) is AD's and many libraries' way too
  const mid = /^(meg|[tgkmuµμnpf])(\d+)$/i.exec(rest);
  if (mid) {
    const sc = SCALE.find(([re]) => re.test(mid[1]!))![1];
    return (v + Number(`0.${mid[2]}`)) * sc;
  }
  for (const [re, f] of SCALE) if (re.test(rest)) { v *= f; break; }
  return v;
}

export const isSpiceNumber = (text: string): boolean => !Number.isNaN(spiceNumber(text));

const PREFIX: [number, string][] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];

/** A value in engineering notation with four figures, as AD's fields show it: 5.000m, 1.000meg, 20.00u. */
export function engineering(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return (0).toFixed(digits - 1);
  const a = Math.abs(v);
  const [f, p] = PREFIX.find(([f]) => a >= f * 0.99995) ?? PREFIX.at(-1)!;
  const m = v / f;
  const whole = Math.floor(Math.log10(Math.abs(m)) + 1e-9) + 1;
  return `${m.toFixed(Math.max(0, digits - whole))}${p}`;
}

/** A value with its unit, as a wave's readout shows it: 1.234 mV, 56.0 µA. */
export function withUnit(v: number, unit: string, digits = 4): string {
  if (!Number.isFinite(v)) return `${v} ${unit}`;
  if (v === 0) return `0 ${unit}`;
  const a = Math.abs(v);
  const UNITS: [number, string][] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const [f, p] = UNITS.find(([f]) => a >= f * 0.99995) ?? UNITS.at(-1)!;
  return `${Number((v / f).toPrecision(digits))} ${p}${unit}`;
}
