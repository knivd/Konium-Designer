/**
 * Live Simulation's stress flags (26.186): a part that takes more than it is rated for says so
 * while the sheet runs. A resistor, a Zener diode and a transistor are rated for a power, a
 * capacitor for a voltage across it, a diode and an LED for a current. The rating is the part's
 * own (a parameter: Power Rating, Voltage Rating, Maximum Current), or what parts of its kind
 * commonly stand where it has none.
 *
 * A power or a current is the mean over the last second or so of the watcher's time, as the
 * sheet shows it: a resistor is not flagged for the instant a capacitor charges through it at real
 * time, nor a diode for the spike as it turns off, and each is for what it takes over and over.
 * A voltage is the most reached lately: a capacitor fails at the peak, not at the mean.
 */

export type StressKind = 'power' | 'voltage' | 'current';
export interface Rating { kind: StressKind; value: number }

/** The parameter a part's rating is kept in, by its kind. */
export const RATING_PARAMS: Record<StressKind, string> = { power: 'Power Rating', voltage: 'Voltage Rating', current: 'Maximum Current' };
export const RATING_UNITS: Record<StressKind, string> = { power: 'W', voltage: 'V', current: 'A' };
/** What the palette's parts are rated for until told otherwise (as a netlist writes a number), by their library names. */
export const RATINGS: Record<string, { kind: StressKind; text: string }> = {
  RES: { kind: 'power', text: '0.25' }, POT: { kind: 'power', text: '0.5' },
  CAP: { kind: 'voltage', text: '50' }, CAP_POL: { kind: 'voltage', text: '25' },
  DIODE_VF: { kind: 'current', text: '1' }, SCHOTTKY: { kind: 'current', text: '1' }, LED_VF: { kind: 'current', text: '30m' }, ZENER: { kind: 'power', text: '0.5' },
  NPN_BETA: { kind: 'power', text: '0.5' }, PNP_BETA: { kind: 'power', text: '0.5' }, DARLINGTON: { kind: 'power', text: '2' },
  NMOS_VT: { kind: 'power', text: '1' }, PMOS_VT: { kind: 'power', text: '1' }, NJFET: { kind: 'power', text: '0.35' }, PJFET: { kind: 'power', text: '0.35' },
  // The parts by their type numbers [est: the common packages' figures]: 1N4148, 1N4001, a 5 mm LED, 2N3904, 2N3906, 2N7002, BSS84
  DIODE: { kind: 'current', text: '0.2' }, RECTIFIER: { kind: 'current', text: '1' }, LED: { kind: 'current', text: '30m' },
  NPN: { kind: 'power', text: '0.6' }, PNP: { kind: 'power', text: '0.6' }, NMOS: { kind: 'power', text: '0.3' }, PMOS: { kind: 'power', text: '0.35' },
};

/**
 * A part's rating: its own parameter where it has one that reads as a number above nothing (`read` gives a
 * parameter's text and `number` what it comes to), else its kind's; null for a part that has neither.
 */
export function ratingOf(libRef: string, read: (param: string) => string, number: (text: string) => number): Rating | null {
  const kind = RATINGS[libRef.toUpperCase()];
  for (const k of kind ? [kind.kind] : (Object.keys(RATING_PARAMS) as StressKind[])) {
    const v = number(read(RATING_PARAMS[k]));
    if (v > 0 && Number.isFinite(v)) return { kind: k, value: v };
  }
  return kind ? { kind: kind.kind, value: number(kind.text) } : null;
}

/** One part's stress followed step by step: `pins` are where each pin's voltage and the current into it are kept (−1: 0 V). */
export class Stress {
  /** What is shown: the mean power or current lately, or the most voltage lately. */
  shown = 0;
  /** That is over the rating (it comes back under at nine tenths of it). */
  over = false;
  private at = NaN; private last = 0; private area = 0; private span = 0; private peak = 0;
  constructor(readonly designator: string, readonly rating: Rating, private readonly pins: readonly (readonly [node: number, meter: number])[]) {}
  private now(valueAt: (i: number) => number): number {
    const p = this.pins;
    if (this.rating.kind === 'voltage') return Math.abs(valueAt(p[0]![0]) - valueAt(p[1]![0]));
    if (this.rating.kind === 'current') return Math.abs(valueAt(p[0]![1]));
    let w = 0;
    for (const [n, m] of p) w += valueAt(n) * valueAt(m);
    return w;
  }
  /** An accepted step of the run. */
  step(time: number, valueAt: (i: number) => number): void {
    const x = this.now(valueAt);
    if (time > this.at) { const dt = time - this.at; this.area += (x + this.last) * 0.5 * dt; this.span += dt; }
    if (x > this.peak) this.peak = x;
    this.at = time; this.last = x;
  }
  /** A frame's steps are taken and `seconds` of the watcher's time have passed. True where it has gone over its rating, or come back under. */
  frame(seconds: number): boolean {
    const was = this.over;
    if (this.rating.kind === 'voltage') this.shown = Math.max(this.peak, this.shown * Math.exp(-seconds));
    else if (this.span > 0) this.shown += (this.area / this.span - this.shown) * (1 - Math.exp(-seconds));
    this.area = 0; this.span = 0; this.peak = 0;
    this.over = this.shown > this.rating.value * (was ? 0.9 : 1);
    return this.over !== was;
  }
  /** A run begun again: nothing has been taken yet. */
  clear(): void { this.shown = 0; this.over = false; this.at = NaN; this.last = 0; this.area = 0; this.span = 0; this.peak = 0; }
}
