/**
 * Tools › Calculators (26.185): the everyday sums and the board's. The sums themselves
 * (src/core/calc.ts, src/analysis/boardCalc.ts) against figures worked by hand or known from the
 * books, and each calculator of the panel worked as its boxes first stand.
 */
import { describe, expect, it } from 'vitest';
import { bestPair, combine, divider, eSeries, feedback, lc, ledResistor, nearestE, ohm, partner, rc, reactance, readQuantity, showQuantity, timerAstable, timerOneShot, typed } from '../src/core/calc';
import { areaFor, copperResistance, riseFor, spacingFor, SPACING_COLUMNS, trackSums, viaSums, lineSums, lineWidth } from '../src/analysis/boardCalc';
import { ipc2221 } from '../src/analysis/rail';
import { CALCULATORS, workCalculator } from '../src/app/panels/CalculatorPanel';
import '../src/app/menus';
import { MENUBAR } from '../src/app/menus/ad17.gen';

describe('quantities as they are typed and shown (26.185)', () => {
  it('reads the engineer\'s scale letters, a letter for the decimal point, and a unit after', () => {
    const cases: [string, number][] = [
      ['4.7k', 4700], ['4k7', 4700], ['4K7', 4700], ['4R7', 4.7], ['10R', 10], ['2M2', 2.2e6], ['1M', 1e6], ['2.2Meg', 2.2e6], ['1meg', 1e6], ['5m', 5e-3], ['20mA', 0.02], ['100n', 1e-7], ['100nF', 1e-7],
      ['10pF', 1e-11], ['4u7', 4.7e-6], ['10µ', 1e-5], ['10uH', 1e-5], ['3.3 V', 3.3], ['1,5k', 1500], ['1e3', 1000], ['2.5e-3', 0.0025], ['10F', 10], ['10H', 10], ['50Hz', 50], ['1MHz', 1e6], ['10kHz', 1e4],
      ['10 kΩ', 1e4], ['10kohm', 1e4], ['5ms', 5e-3], ['2G', 2e9], ['-3.3', -3.3], ['.5', 0.5], ['0', 0],
    ];
    for (const [text, want] of cases) expect(readQuantity(text), text).toBeCloseTo(want, 12 - Math.round(Math.log10(Math.abs(want) || 1)));
    for (const bad of ['', 'k', 'ten', '4.7k7', '10mm', '5x', '1..2', '10 20', '10 k 5', '1 0k']) expect(readQuantity(bad), bad).toBeNaN();
    // (a space between the number and its scale or its unit, as people write it)
    expect(readQuantity('10 k')).toBe(1e4); expect(readQuantity('4.7 kΩ')).toBeCloseTo(4700, 9); expect(readQuantity('100 nF')).toBeCloseTo(1e-7, 18); expect(readQuantity('3.3 V')).toBe(3.3);
  });

  it('shows them with a scale letter and no noughts trailing', () => {
    expect(showQuantity(4700, 'Ω')).toBe('4.7 kΩ'); expect(showQuantity(330, 'Ω')).toBe('330 Ω'); expect(showQuantity(2.4812, 'V')).toBe('2.481 V');
    expect(showQuantity(1e-7, 'F')).toBe('100 nF'); expect(showQuantity(2.2e6, 'Ω')).toBe('2.2 MΩ'); expect(showQuantity(0.02, 'A')).toBe('20 mA');
    expect(showQuantity(999.96, 'Ω')).toBe('1 kΩ'); expect(showQuantity(0, 'V')).toBe('0 V'); expect(showQuantity(4.7e-6, 'F')).toBe('4.7 µF'); expect(showQuantity(-12, 'V')).toBe('-12 V');
    // …and as they would be typed: what readQuantity takes back
    for (const v of [4700, 330, 1e-7, 2.2e6, 0.02, 4.7e-6, 159.2]) expect(readQuantity(typed(v))).toBeCloseTo(v, 12 - Math.round(Math.log10(v)));
    expect(typed(4.7e-6)).toBe('4.7u');
  });
});

describe('standard values (26.185)', () => {
  it('the series are the tables: 6, 12, 24, 48, 96 and 192 values to a decade', () => {
    expect(eSeries('E6')).toEqual([1.0, 1.5, 2.2, 3.3, 4.7, 6.8]);
    expect(eSeries('E12')).toEqual([1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]);
    expect(eSeries('E24')).toHaveLength(24); expect(eSeries('E48')).toHaveLength(48); expect(eSeries('E96')).toHaveLength(96); expect(eSeries('E192')).toHaveLength(192);
    // Known values of the finer series, and E192's one that is not its formula's (9.20, not 9.19)
    for (const v of [1.0, 1.05, 1.21, 1.47, 2.15, 3.16, 4.64, 4.87, 6.81, 9.53]) expect(eSeries('E48'), String(v)).toContain(v);
    for (const v of [1.02, 1.13, 2.49, 3.32, 4.99, 6.98, 9.76]) expect(eSeries('E96'), String(v)).toContain(v);
    expect(eSeries('E192')).toContain(9.2); expect(eSeries('E192')).not.toContain(9.19); expect(eSeries('E192')).toContain(4.99); expect(eSeries('E192')).toContain(1.01);
    // Each series holds the one before it (E24 holds E12 and E6; E192 holds E96 and E48)
    for (const v of eSeries('E48')) expect(eSeries('E96')).toContain(v);
    for (const v of eSeries('E96')) expect(eSeries('E192')).toContain(v);
  });

  it('the nearest, the one below and the one above, in any decade', () => {
    expect(nearestE(4990, 'E24')).toMatchObject({ value: 5100, below: 4700, above: 5100 });
    expect(nearestE(4990, 'E96')).toMatchObject({ value: 4990, below: 4990, above: 4990, error: 0 });
    expect(nearestE(9.6e-9, 'E12').value).toBeCloseTo(1e-8, 18); expect(nearestE(9.6e-9, 'E12').below).toBeCloseTo(8.2e-9, 18);
    expect(nearestE(1.04, 'E6')).toMatchObject({ value: 1, below: 1, above: 1.5 });
    expect(nearestE(950, 'E6')).toMatchObject({ value: 1000, below: 680, above: 1000 });
    expect(nearestE(4990, 'E24').error).toBeCloseTo(5100 / 4990 - 1, 12);
    expect(nearestE(0, 'E24').value).toBeNaN();
  });

  it('the pair nearest a ratio', () => {
    // 3.3 V from 5 V: R1 / R2 = 0.5152; E24 has 5.1k over 10k (0.51) and better, 6.8k over 13k (0.5231) is worse: the best is found
    const p = bestPair(1.7 / 3.3, 'E24', 10e3)!;
    expect(Math.abs(p.error)).toBeLessThan(0.011); expect(p.b).toBeGreaterThanOrEqual(1e4); expect(p.b).toBeLessThan(1e5);
    for (const b of eSeries('E24')) for (const a of eSeries('E24')) for (const k of [0.1, 1, 10]) expect(Math.abs((a * k) / b / (1.7 / 3.3) - 1)).toBeGreaterThanOrEqual(Math.abs(p.error) - 1e-9);
    expect(bestPair(1, 'E12', 4700)).toMatchObject({ error: 0 });
    expect(bestPair(-1, 'E12', 4700)).toBeNull();
  });
});

describe('the everyday sums (26.185)', () => {
  it('a divider: any one of the four, with a load or without', () => {
    expect(divider('vout', { vin: 5, r1: 10e3, r2: 10e3 })).toMatchObject({ vout: 2.5, current: 2.5e-4, rout: 5000 });
    expect(divider('r2', { vin: 5, r1: 10e3, vout: 3.3 })!.r2).toBeCloseTo(10e3 * 3.3 / 1.7, 6);
    expect(divider('r1', { vin: 12, r2: 1e3, vout: 2 })!.r1).toBeCloseTo(5e3, 9);
    expect(divider('vin', { r1: 3e3, r2: 1e3, vout: 2 })!.vin).toBeCloseTo(8, 12);
    // A 10 k load across R2 = 10 k makes it 5 k: 5 V x 5 / 15
    expect(divider('vout', { vin: 5, r1: 10e3, r2: 10e3, load: 10e3 })!.vout).toBeCloseTo(5 / 3, 12);
    // …and the R2 that still gives 2.5 V with that load does not exist (the load alone is 10 k, R1 is 10 k), but with a 30 k load it is 15 k
    expect(divider('r2', { vin: 5, r1: 10e3, vout: 2.5, load: 10e3 })).toBeNull();
    expect(divider('r2', { vin: 5, r1: 10e3, vout: 2.5, load: 30e3 })!.r2).toBeCloseTo(15e3, 6);
    const d = divider('vout', { vin: 9, r1: 2e3, r2: 1e3 })!;
    expect(d.p1).toBeCloseTo(0.003 * 0.003 * 2e3, 12); expect(d.p2).toBeCloseTo(0.009, 12);
    expect(divider('r1', { vin: 5, r2: 1e3, vout: 6 })).toBeNull(); expect(divider('r2', { vin: 5, r1: 1e3, vout: 5 })).toBeNull(); expect(divider('vout', { vin: 5, r1: 1e3 })).toBeNull();
  });

  it('parts in a row and side by side, and the partner that makes a value', () => {
    expect(combine([10e3, 4.7e3], false)).toMatchObject({ series: 14700 }); expect(combine([10e3, 4.7e3], false)!.parallel).toBeCloseTo(3197.28, 2);
    expect(combine([100e-9, 100e-9], true)!.series).toBeCloseTo(50e-9, 18); expect(combine([100e-9, 100e-9], true)!.parallel).toBeCloseTo(200e-9, 18);
    expect(combine([], false)).toBeNull(); expect(combine([10, NaN], false)).toBeNull();
    expect(partner(10e3, 5e3, false)).toMatchObject({ value: 10e3, how: 'parallel' }); expect(partner(10e3, 12e3, false)).toMatchObject({ value: 2e3, how: 'series' });
    expect(partner(100e-9, 150e-9, true)!.how).toBe('parallel'); expect(partner(100e-9, 50e-9, true)).toMatchObject({ how: 'series' }); expect(partner(100e-9, 50e-9, true)!.value).toBeCloseTo(100e-9, 18);
    expect(partner(10, 10, false)).toBeNull();
  });

  it('an LED\'s resistor, and the next standard value up', () => {
    // 5 V, a 2 V LED at 10 mA: 300 Ω exactly, which E24 has; at 20 mA 150 Ω; two in a row at 10 mA from 5 V: 100 Ω
    expect(ledResistor(5, 2, 0.01, 1, 'E24')).toMatchObject({ r: 300, standard: 300 });
    const r = ledResistor(12, 3.2, 0.02, 2, 'E12')!;
    expect(r.r).toBeCloseTo(280, 9); expect(r.standard).toBe(330); expect(r.current).toBeCloseTo(5.6 / 330, 12); expect(r.pResistor).toBeCloseTo((5.6 * 5.6) / 330, 12); expect(r.pLed).toBeCloseTo(3.2 * 5.6 / 330, 12);
    expect(ledResistor(3, 3.2, 0.02, 1, 'E12')).toBeNull();
  });

  it('RC, LC, Ohm\'s law, reactance and the 555', () => {
    expect(rc('f', { r: 10e3, c: 100e-9 })!.f).toBeCloseTo(159.155, 3); expect(rc('r', { c: 100e-9, f: 159.155 })!.r).toBeCloseTo(10e3, 0); expect(rc('c', { r: 10e3, f: 1000 })!.c).toBeCloseTo(15.9155e-9, 12);
    expect(rc('f', { r: 10e3, c: 100e-9 })!.tau).toBeCloseTo(1e-3, 12); expect(rc('f', { r: 0, c: 1 })).toBeNull();
    expect(lc('f', { l: 10e-6, c: 100e-9 })!.f).toBeCloseTo(159154.9, 0); expect(lc('f', { l: 10e-6, c: 100e-9 })!.z).toBeCloseTo(10, 9); expect(lc('l', { c: 100e-9, f: 159154.94 })!.l).toBeCloseTo(10e-6, 10); expect(lc('c', { l: 1e-3, f: 1e3 })!.c).toBeCloseTo(25.33e-6, 8);
    expect(ohm('vr', 5, 1e3)).toMatchObject({ i: 0.005, p: 0.025 }); expect(ohm('vi', 12, 2)).toMatchObject({ r: 6, p: 24 }); expect(ohm('ir', 2, 6)).toMatchObject({ v: 12, p: 24 });
    expect(ohm('vp', 12, 24)).toMatchObject({ i: 2, r: 6 }); expect(ohm('ip', 2, 24)).toMatchObject({ v: 12, r: 6 }); expect(ohm('rp', 6, 24)!.v).toBeCloseTo(12, 12); expect(ohm('vr', 5, NaN)).toBeNull();
    expect(reactance(1e3, 100e-9)!.xc).toBeCloseTo(1591.55, 2); expect(reactance(1e3, undefined, 10e-3)!.xl).toBeCloseTo(62.832, 3); expect(reactance(1e3)).toBeNull(); expect(reactance(0, 1e-9)).toBeNull();
    // The 555 with 10 k, 47 k and 10 µF: 1.44 / (104 k x 10 µ) = 1.387 Hz, high for 0.395 s; a one-shot of 100 k and 10 µF lasts 1.1 s
    const a = timerAstable(10e3, 47e3, 10e-6)!;
    expect(a.f).toBeCloseTo(1.3872, 3); expect(a.high).toBeCloseTo(0.39509, 4); expect(a.low).toBeCloseTo(0.32578, 4); expect(a.duty).toBeCloseTo(57 / 104, 9);
    expect(timerOneShot(100e3, 10e-6)).toBeCloseTo(1.0986, 4); expect(timerOneShot(0, 1)).toBeNull();
  });

  it('a regulator\'s feedback pair, with a feedback pin and with an adjust pin', () => {
    // 0.8 V reference, 3.3 V out, 10 k below: 31.25 k above
    expect(feedback('upper', 'fb', { vref: 0.8, vout: 3.3, lower: 10e3 })!.upper).toBeCloseTo(31250, 6);
    expect(feedback('lower', 'fb', { vref: 0.8, vout: 3.3, upper: 31250 })!.lower).toBeCloseTo(10e3, 6);
    expect(feedback('vout', 'fb', { vref: 0.6, upper: 100e3, lower: 22e3 })!.vout).toBeCloseTo(0.6 * (1 + 100 / 22), 12);
    // An LM317 with 240 Ω above and 390 Ω below: 1.25 x (1 + 390 / 240) + 50 µA x 390 = 3.3008 V
    const lm = feedback('vout', 'adj', { vref: 1.25, upper: 240, lower: 390, iadj: 50e-6 })!;
    expect(lm.vout).toBeCloseTo(1.25 * (1 + 390 / 240) + 50e-6 * 390, 12); expect(lm.current).toBeCloseTo(1.25 / 240, 12);
    expect(feedback('lower', 'adj', { vref: 1.25, vout: lm.vout, upper: 240, iadj: 50e-6 })!.lower).toBeCloseTo(390, 6);
    expect(feedback('upper', 'adj', { vref: 1.25, vout: lm.vout, lower: 390, iadj: 50e-6 })!.upper).toBeCloseTo(240, 6);
    expect(feedback('upper', 'fb', { vref: 0.8, vout: 0.5, lower: 10e3 })).toBeNull();
  });
});

describe('the board\'s sums (26.185)', () => {
  const MIL = 25.4e-6;
  it('a track by IPC-2221, each of width, current and rise from the other two, as Power Analysis rates one', () => {
    // 10 mil of 1 oz copper (1.378 mil) on an outer layer for a 10 °C rise: 0.048 x 10^0.44 x 13.78^0.725 = 0.886 A
    const i = ipc2221(10 * MIL * 35e-6, 10, false);
    expect(i).toBeCloseTo(0.048 * 10 ** 0.44 * (10 * 1.378) ** 0.725, 2);
    const t = trackSums('current', { width: 10 * MIL, rise: 10, thickness: 35e-6, inner: false })!;
    expect(t.current).toBeCloseTo(i, 12); expect(t.outside).toEqual([]);
    expect(trackSums('width', { current: i, rise: 10, thickness: 35e-6, inner: false })!.width).toBeCloseTo(10 * MIL, 12);
    expect(trackSums('rise', { current: i, width: 10 * MIL, thickness: 35e-6, inner: false })!.rise).toBeCloseTo(10, 9);
    // Inside the board the same track carries half
    expect(trackSums('current', { width: 10 * MIL, rise: 10, thickness: 35e-6, inner: true })!.current).toBeCloseTo(i / 2, 12);
    expect(areaFor(i, 10, false)).toBeCloseTo(10 * MIL * 35e-6, 15); expect(riseFor(i, 10 * MIL * 35e-6, false)).toBeCloseTo(10, 9);
    // 100 mm of it: 1 / 58 MS/m over 0.254 mm x 35 µm = 0.194 Ω at 20 °C, 5.9 % more at 35 °C
    expect(copperResistance(0.1, 10 * MIL * 35e-6)).toBeCloseTo(0.1 / (5.8e7 * 10 * MIL * 35e-6), 12);
    const long = trackSums('current', { width: 10 * MIL, rise: 10, thickness: 35e-6, inner: false, length: 0.1, ambient: 25 })!;
    expect(long.resistance).toBeCloseTo(0.19395 * (1 + 0.00393 * 15), 4); expect(long.drop).toBeCloseTo(long.resistance! * i, 12); expect(long.loss).toBeCloseTo(long.drop! * i, 12);
    // Where the chart does not reach, it says so
    expect(trackSums('width', { current: 50, rise: 10, thickness: 35e-6, inner: false })!.outside.join()).toMatch(/35 A.*400 mil/);
    expect(trackSums('current', { width: 10 * MIL, rise: 5, thickness: 10e-6, inner: false })!.outside).toHaveLength(2);
    expect(trackSums('width', { rise: 10, thickness: 35e-6, inner: false })).toBeNull();
  });

  it('a via\'s barrel: its copper, what it carries, its resistance and inductance', () => {
    const v = viaSums({ hole: 0.3e-3, plating: 25e-6, length: 1.6e-3, rise: 10 })!;
    expect(v.area).toBeCloseTo(Math.PI * 0.325e-3 * 25e-6, 15);
    expect(v.current).toBeCloseTo(ipc2221(v.area, 10, true), 12);
    expect(v.resistance).toBeCloseTo((1.6e-3 / (5.8e7 * v.area)) * (1 + 0.00393 * 15), 9);
    // 5.08 h (ln(4h / d) + 1) nH with h = 0.063 in, d = 0.0118 in: 1.30 nH
    expect(v.inductance * 1e9).toBeCloseTo(5.08 * (1.6 / 25.4) * (Math.log((4 * 1.6) / 0.3) + 1), 6);
    expect(v.thermal).toBeCloseTo(1.6e-3 / (385 * v.area), 6);
    const four = viaSums({ hole: 0.3e-3, plating: 25e-6, length: 1.6e-3, rise: 10, current: 4, count: 4 })!;
    expect(four.each).toBe(1); expect(four.drop).toBeCloseTo(four.resistance, 12); expect(four.rise).toBeCloseTo(riseFor(1, v.area, true), 9);
    expect(viaSums({ hole: 0, plating: 25e-6, length: 1.6e-3, rise: 10 })).toBeNull();
  });

  it('IPC-2221B\'s spacings: the table\'s own figures, and its rule over 500 V', () => {
    expect(SPACING_COLUMNS.map((c) => c.id)).toEqual(['B1', 'B2', 'B3', 'B4', 'A5', 'A6', 'A7']);
    const mm = (v: number) => spacingFor(v)!.map((x) => Number((x * 1e3).toPrecision(6)));
    expect(mm(12)).toEqual([0.05, 0.1, 0.1, 0.05, 0.13, 0.13, 0.13]); expect(mm(15)).toEqual(mm(12)); expect(mm(16)).toEqual([0.05, 0.1, 0.1, 0.05, 0.13, 0.25, 0.13]);
    expect(mm(48)).toEqual([0.1, 0.6, 0.6, 0.13, 0.13, 0.4, 0.13]); expect(mm(100)).toEqual([0.1, 0.6, 1.5, 0.13, 0.13, 0.5, 0.13]);
    expect(mm(150)).toEqual([0.2, 0.6, 3.2, 0.4, 0.4, 0.8, 0.4]); expect(mm(170)).toEqual([0.2, 1.25, 3.2, 0.4, 0.4, 0.8, 0.4]); expect(mm(230)).toEqual([0.2, 1.25, 6.4, 0.4, 0.4, 0.8, 0.4]);
    expect(mm(300)).toEqual([0.2, 1.25, 12.5, 0.4, 0.4, 0.8, 0.8]); expect(mm(500)).toEqual([0.25, 2.5, 12.5, 0.8, 0.8, 1.5, 0.8]);
    // 1000 V: 500 V's figure and 500 times the figure for each volt over
    expect(mm(1000)).toEqual([1.5, 5, 25, 2.325, 2.325, 3.025, 2.325]);
    expect(mm(-48)).toEqual(mm(48)); expect(spacingFor(NaN)).toBeNull();
  });

  it('a track\'s impedance is the Field Solver\'s, and the width for an impedance gives that impedance', { timeout: 30000 }, () => {
    const r = lineSums({ kind: 'microstrip', width: 0.36e-3, thickness: 35e-6, height: 0.2e-3, er: 4.3 })!;
    expect(r.z0).toBeGreaterThan(48); expect(r.z0).toBeLessThan(52);
    const w = lineWidth(50, { kind: 'microstrip', thickness: 35e-6, height: 0.2e-3, er: 4.3 })!;
    expect(Math.abs(lineSums({ kind: 'microstrip', width: w, thickness: 35e-6, height: 0.2e-3, er: 4.3 })!.z0 - 50)).toBeLessThan(0.5);
    const s = lineSums({ kind: 'stripline', width: 0.15e-3, thickness: 17e-6, height: 0.2e-3, er: 4.3 })!;
    expect(s.z0).toBeGreaterThan(44); expect(s.z0).toBeLessThan(56); expect(s.eff).toBeCloseTo(4.3, 1);
    expect(lineSums({ kind: 'microstrip', width: 0, thickness: 35e-6, height: 0.2e-3, er: 4.3 })).toBeNull();
  });
});

describe('the panel\'s calculators (26.185)', () => {
  it('fourteen of them, ten everyday and four of the board; each gives results as its boxes first stand', () => {
    expect(CALCULATORS.map((c) => c.id)).toEqual(['divider', 'combine', 'led', 'rc', 'lc', 'ohm', 'feedback', 'reactance', 'timer', 'standard', 'track', 'via', 'spacing', 'impedance']);
    expect(CALCULATORS.filter((c) => c.group === 'Everyday')).toHaveLength(10); expect(CALCULATORS.filter((c) => c.group === 'Board')).toHaveLength(4);
    for (const c of CALCULATORS) {
      if (c.id === 'impedance') continue;
      const out = workCalculator(c.id);
      expect(out.rows.length, c.id).toBeGreaterThan(0); expect(out.say, c.id).toBeUndefined();
      for (const [name, value] of out.rows) { expect(name).not.toBe(''); expect(value, `${c.id} ${name}`).not.toMatch(/NaN|undefined|\?|Infinity/); }
    }
  });

  it('Find puts the answer in its own box, and the rows read as an engineer writes them', () => {
    const d = workCalculator('divider', { vin: '5', r1: '10k', vout: '3.3' }, { find: 'r2' });
    expect(d.found!.r2).toBe('19.41k');
    expect(Object.fromEntries(d.rows)).toMatchObject({ Output: '3.3 V', 'Current in R1': '170 µA', 'Output resistance': '6.6 kΩ' });
    expect(Object.fromEntries(d.rows)['Nearest E24 pair']).toMatch(/^R1 [\d.]+ kΩ, R2 [\d.]+ kΩ: 3\.\d+ V \([+-]\d\.\d\d %\)$/);
    expect(workCalculator('divider', { vin: '5', r1: '10k', vout: '6' }, { find: 'r2' })).toMatchObject({ rows: [], say: expect.stringMatching(/between 0 V and the input/) });
    expect(Object.fromEntries(workCalculator('combine', { values: '10k 4k7 220', target: '5k' }).rows)).toMatchObject({ 'In series': '14.92 kΩ', 'To make 5 kΩ': '10 kΩ in parallel with 10 kΩ' });
    expect(Object.fromEntries(workCalculator('combine', { values: '100n 100n' }, { pick: { kind: 'c' } }).rows)).toMatchObject({ 'In series': '50 nF', 'In parallel': '200 nF' });
    expect(Object.fromEntries(workCalculator('led', { vs: '12', vf: '3.2', i: '20m', n: '2' }, { pick: { series: 'E12' } }).rows)).toMatchObject({ Resistor: '280 Ω', 'Next E12 value up': '330 Ω', 'Current with it': '16.97 mA' });
    expect(workCalculator('rc', { r: '10k', c: '100n' }).found!.f).toBe('159.2');
    expect(workCalculator('ohm', { v: '12', r: '6' }).rows).toEqual([['Voltage', '12 V'], ['Current', '2 A'], ['Resistance', '6 Ω'], ['Power', '24 W']]);
    expect(workCalculator('feedback', { vref: '0.8', vout: '3.3', lower: '10k' }, { find: 'upper' }).found!.upper).toBe('31.25k');
    expect(workCalculator('standard', { v: '4.99k' }).rows[2]).toEqual(['E24', '5.1 k (+2.20 %), between 4.7 k and 5.1 k']);
    expect(workCalculator('standard', { v: '4.99k' }).rows[4]).toEqual(['E96', '4.99 k (+0.00 %)']);
    // The board's: lengths in the panel's unit
    const t = workCalculator('track', { current: '1', rise: '10', copper: '35' }, { find: 'width' });
    expect(Number(t.found!.width)).toBeCloseTo(0.3, 1);
    expect(Number(workCalculator('track', { current: '1', rise: '10', copper: '35' }, { find: 'width', unit: 'mil' }).found!.width)).toBeCloseTo(Number(t.found!.width) / 0.0254, 0);
    expect(workCalculator('track', { current: '60', rise: '10' }, { find: 'width' }).note).toMatch(/Beyond IPC-2221's chart \(over 35 A/);
    expect(workCalculator('spacing', { v: '230' }).rows[1]).toEqual(['Outer layer, bare, up to 3050 m', '1.25 mm (49.2 mil)']);
    expect(workCalculator('via').rows[0]![0]).toBe('One via carries');
  });

  it('Tools › Calculators is in every editor\'s Tools menu', () => {
    for (const scope of ['sch', 'schlib', 'pcb', 'pcblib']) {
      const tools = (MENUBAR[scope] ?? []).find((s) => Array.isArray(s) && s[0] === '&Tools') as [string, unknown[]];
      expect(tools[1].filter((s) => Array.isArray(s) && s[1] === 'tools.calculators'), scope).toHaveLength(1);
    }
  });
});
