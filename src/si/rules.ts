/**
 * Signal Integrity's design rules, as AD keeps them in a board's Rules6: the stimulus, overshoot
 * and undershoot of each edge (volts), impedance (Ω), the signal's top and base values (volts),
 * flight time and slope of each edge (seconds) and the supply nets' voltages — their constraint
 * keys, their defaults when a rule is made, how values are written, and a net's limits taken
 * from the rules that apply to it (the panel's tolerances when none does).
 */
import type { Edge, EdgeMeasures } from './screen';

export type SiUnit = 'V' | 'Ω' | 's';
export interface SiField { key: string; label: string; def: string; unit: SiUnit }
/** The limits a net is screened against (absent: not checked). */
export interface SiLimits {
  overshootFalling?: number; overshootRising?: number; undershootFalling?: number; undershootRising?: number;
  zMin?: number; zMax?: number; top?: number; base?: number;
  flightRising?: number; flightFalling?: number; slopeRising?: number; slopeFalling?: number;
}
export type SiLimit = keyof SiLimits;

/**
 * AD's Signal Integrity rule kinds in its tree order, their constraints and the limit each sets
 * (defaults as AD's rule dialog fills them [est]).
 */
export const SI_RULES: { kind: string; label: string; fields: (SiField & { limit?: SiLimit })[] }[] = [
  { kind: 'SignalStimulus', label: 'Signal Stimulus', fields: [] },
  { kind: 'OvershootFalling', label: 'Overshoot - Falling Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (Volts)', def: ' 1.000', unit: 'V', limit: 'overshootFalling' }] },
  { kind: 'OvershootRising', label: 'Overshoot - Rising Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (Volts)', def: ' 1.000', unit: 'V', limit: 'overshootRising' }] },
  { kind: 'UndershootFalling', label: 'Undershoot - Falling Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (Volts)', def: ' 1.000', unit: 'V', limit: 'undershootFalling' }] },
  { kind: 'UndershootRising', label: 'Undershoot - Rising Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (Volts)', def: ' 1.000', unit: 'V', limit: 'undershootRising' }] },
  { kind: 'MaxMinImpedance', label: 'Impedance', fields: [{ key: 'MINIMUM', label: 'Minimum (Ohms)', def: ' 1.000', unit: 'Ω', limit: 'zMin' }, { key: 'MAXIMUM', label: 'Maximum (Ohms)', def: ' 10.00K', unit: 'Ω', limit: 'zMax' }] },
  { kind: 'SignalTopValue', label: 'Signal Top Value', fields: [{ key: 'MINIMUM', label: 'Minimum (Volts)', def: ' 5.000', unit: 'V', limit: 'top' }] },
  { kind: 'SignalBaseValue', label: 'Signal Base Value', fields: [{ key: 'MAXIMUM', label: 'Maximum (Volts)', def: ' 0.000', unit: 'V', limit: 'base' }] },
  { kind: 'FlightTimeRising', label: 'Flight Time - Rising Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (seconds)', def: ' 1.000n', unit: 's', limit: 'flightRising' }] },
  { kind: 'FlightTimeFalling', label: 'Flight Time - Falling Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (seconds)', def: ' 1.000n', unit: 's', limit: 'flightFalling' }] },
  { kind: 'MaxSlopeRising', label: 'Slope - Rising Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (seconds)', def: ' 1.000n', unit: 's', limit: 'slopeRising' }] },
  { kind: 'MaxSlopeFalling', label: 'Slope - Falling Edge', fields: [{ key: 'MAXIMUM', label: 'Maximum (seconds)', def: ' 1.000n', unit: 's', limit: 'slopeFalling' }] },
  { kind: 'SupplyNets', label: 'Supply Nets', fields: [{ key: 'VOLTAGE', label: 'Voltage', def: ' 0.000', unit: 'V' }] },
];
export const SI_KINDS = SI_RULES.map((r) => r.kind);
/** The kinds DRC checks (by screening each net they take). */
export const SI_CHECKED = SI_KINDS.filter((k) => k !== 'SignalStimulus' && k !== 'SupplyNets');

const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** A rule's value: plain (4.000, 1E-9) or with a multiplier (1.000n, 10.00K, 2meg); NaN when not a number. */
export function siNum(s: string | undefined): number {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(meg|[fpnuµmkKMG])?/i.exec(s ?? '');
  if (!m) return NaN;
  const v = Number(m[1]);
  const p = m[2];
  if (!p) return v;
  // m is milli, M mega (as AD writes them); 12 figures, so 60n is 6e-8
  const x = /^meg$/i.test(p) ? v * 1e6 : v * (PREFIX[p] ?? PREFIX[p.toLowerCase()] ?? 1);
  return Number(x.toPrecision(12));
}

/** A value as AD writes it in a rule: four figures, a multiplier, a space for the sign (" 4.000", " 32.00", " 1.000n", " 10.00K"). */
export function siText(v: number): string {
  if (!Number.isFinite(v)) return ' 0.000';
  const a = Math.abs(v);
  const steps: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'K'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  const [k, p] = a === 0 ? [1, ''] : (steps.find(([s]) => a >= s * 0.99995) ?? steps[steps.length - 1]!);
  const x = v / k, ax = Math.abs(x);
  const digits = ax >= 99.995 ? 1 : ax >= 9.9995 ? 2 : 3;
  return `${v < 0 ? '-' : ' '}${ax.toFixed(digits)}${p}`;
}

/** A value for people: 0.42 V, 1.25 ns, 48.2 Ω. */
export function siShow(v: number | undefined, unit: SiUnit | string): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return `${siText(v).trim()}${unit}`.replace(/^(-?[\d.]+)([a-zA-Zµ]?)(.+)$/, '$1 $2$3').replace(/K(Ω)/, 'k$1').replace(/ u(?=\S)/, ' µ');
}

/** The stimulus a net's reflections are simulated with (AD's Signal Stimulus rule). */
export interface Stimulus { kind: 'Single Pulse' | 'Constant Level' | 'Periodic Pulse'; startHigh: boolean; start: number; stop: number; period: number }
export const DEFAULT_STIMULUS: Stimulus = { kind: 'Single Pulse', startHigh: false, start: 10e-9, stop: 60e-9, period: 100e-9 };
/** A Signal Stimulus rule's keys [est: AD's names for them]. */
export function stimulusOf(get: (key: string) => string | undefined): Stimulus {
  const kind = (get('STIMULUSKIND') ?? '').toLowerCase();
  const n = (k: string, d: number) => { const v = siNum(get(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    kind: /constant/.test(kind) ? 'Constant Level' : /period/.test(kind) ? 'Periodic Pulse' : 'Single Pulse',
    startHigh: /high/i.test(get('STARTLEVEL') ?? ''),
    start: n('STARTTIME', DEFAULT_STIMULUS.start), stop: n('STOPTIME', DEFAULT_STIMULUS.stop), period: n('PERIODTIME', DEFAULT_STIMULUS.period),
  };
}
export const stimulusProps = (s: Stimulus): Record<string, string> => ({
  STIMULUSKIND: s.kind.replace(/ /g, ''), STARTLEVEL: s.startHigh ? 'HighLevel' : 'LowLevel', STARTTIME: siText(s.start), STOPTIME: siText(s.stop), PERIODTIME: siText(s.period),
});

/** A rule's limits (its kind's fields, read as numbers; overshoot and undershoot as sizes). */
export function ruleLimits(kind: string, get: (key: string) => string | undefined): SiLimits {
  const out: SiLimits = {};
  for (const f of SI_RULES.find((r) => r.kind === kind)?.fields ?? []) {
    if (!f.limit) continue;
    const v = siNum(get(f.key) ?? f.def);
    if (Number.isFinite(v)) out[f.limit] = /shoot/i.test(kind) ? Math.abs(v) : v;
  }
  return out;
}

export interface SiFailure { limit: SiLimit; kind: string; value: number; bound: number; text: string }
/** Where a net's measures break its limits. */
export function failures(m: { rising: EdgeMeasures; falling: EdgeMeasures; zMin: number; zMax: number }, l: SiLimits): SiFailure[] {
  const out: SiFailure[] = [];
  const over = (limit: SiLimit, kind: string, value: number, unit: SiUnit, label: string) => {
    const b = l[limit];
    if (b !== undefined && Number.isFinite(value) && value > b + 1e-12) out.push({ limit, kind, value, bound: b, text: `${label} ${siShow(value, unit)} > ${siShow(b, unit)}` });
  };
  const under = (limit: SiLimit, kind: string, value: number, unit: SiUnit, label: string) => {
    const b = l[limit];
    if (b !== undefined && Number.isFinite(value) && value < b - 1e-12) out.push({ limit, kind, value, bound: b, text: `${label} ${siShow(value, unit)} < ${siShow(b, unit)}` });
  };
  over('overshootFalling', 'OvershootFalling', m.falling.overshoot, 'V', 'Falling edge overshoot');
  over('overshootRising', 'OvershootRising', m.rising.overshoot, 'V', 'Rising edge overshoot');
  over('undershootFalling', 'UndershootFalling', m.falling.undershoot, 'V', 'Falling edge undershoot');
  over('undershootRising', 'UndershootRising', m.rising.undershoot, 'V', 'Rising edge undershoot');
  under('zMin', 'MaxMinImpedance', m.zMin, 'Ω', 'Impedance');
  over('zMax', 'MaxMinImpedance', m.zMax, 'Ω', 'Impedance');
  under('top', 'SignalTopValue', m.rising.level, 'V', 'Top value');
  over('base', 'SignalBaseValue', m.falling.level, 'V', 'Base value');
  over('flightRising', 'FlightTimeRising', m.rising.flight, 's', 'Rising edge flight time');
  over('flightFalling', 'FlightTimeFalling', m.falling.flight, 's', 'Falling edge flight time');
  over('slopeRising', 'MaxSlopeRising', m.rising.slope, 's', 'Rising edge slope');
  over('slopeFalling', 'MaxSlopeFalling', m.falling.slope, 's', 'Falling edge slope');
  return out;
}

export const edgeLabel = (e: Edge) => (e === 'rising' ? 'Rising Edge' : 'Falling Edge');
