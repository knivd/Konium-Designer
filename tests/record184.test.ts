/**
 * The live record and what is faster than its samples (26.184). A scope that shows five seconds keeps
 * a sample every two milliseconds or so; a 480 Hz tone then turns over between one sample and the
 * next, and read from the samples alone it was drawn with gaps and said to repeat at a rate it does
 * not have. Each sample now carries the least and most its signal reached since the one before and
 * the rises through its middle counted at every step.
 */
import { describe, expect, it } from 'vitest';
import { LiveRecord, measure } from '../src/sim/liveRecord';

describe('the record and what is faster than its samples (26.184)', () => {
  const SPAN = 5, SPACING = SPAN / 3125;
  /** A record of signal a (and b = `second` of it) over `time` seconds in steps of `h`. */
  const run = (wave: (t: number) => number, time = SPAN, h = 20e-6, second: (v: number, t: number) => number = (v) => v) => {
    const r = new LiveRecord(['a', 'b']);
    r.spacing = SPACING;
    for (let k = 0, n = Math.round(time / h); k <= n; k++) { const t = k * h, v = wave(t); r.push(t, (i) => (i === 0 ? v : second(v, t))); }
    return r;
  };
  const A = { label: 'a', unit: 'V' as const, terms: [['a', 1]] as [string, number][] };
  const square = (f: number, top: number) => (t: number) => ((t * f) % 1 < 0.5 ? top : 0);

  it('samples are kept at uneven gaps, between the spacing and half as much again', () => {
    const d = run((t) => Math.sin(2 * Math.PI * 10 * t)).series(A)!;
    const gaps = Array.from(d.t.subarray(1), (t, i) => t - d.t[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(SPACING - 1e-12);
    expect(Math.max(...gaps)).toBeLessThan(1.5 * SPACING + 21e-6);
    // About 2,500 across the span, and not all one length
    expect(d.t.length).toBeGreaterThan(2300); expect(d.t.length).toBeLessThan(2700);
    expect(new Set(gaps.map((g) => Math.round(g / 20e-6))).size).toBeGreaterThan(20);
  });

  it('a 480 Hz square wave on a five-second scope: its band between the samples, its rate from every step', () => {
    const d = run(square(480, 7.4)).series(A)!;
    expect(d.single).toBe(true);
    // More than a cycle between the samples: they alone cannot tell
    expect(d.cycles).toBeGreaterThan(d.y.length / 4);
    const m = measure(d.t, d.y, d)!;
    expect(m.freq).toBeGreaterThan(475); expect(m.freq).toBeLessThan(485);
    expect(m.min).toBe(0); expect(m.max).toBeCloseTo(7.4, 5);
    // Every sample after the first carries the whole swing reached since the one before
    let full = 0;
    for (let i = 1; i < d.y.length; i++) if (d.lo![i]! === 0 && d.hi![i]! > 7.39) full++;
    expect(full).toBe(d.y.length - 1);
    expect([d.lo![0], d.hi![0]]).toEqual([d.y[0], d.y[0]]);
    // The samples alone give some other rate, or none: what was shown before
    const alone = measure(d.t, d.y)!;
    expect(Math.abs(alone.freq - 480)).toBeGreaterThan(100);
  });

  it('a 1 kHz sine in even steps is not caught at one point of its cycle', () => {
    const d = run((t) => 2 * Math.sin(2 * Math.PI * 1000 * t), SPAN, 25e-6).series(A)!;
    const mean = d.y.reduce((a, v) => a + v, 0) / d.y.length, sd = Math.sqrt(d.y.reduce((a, v) => a + (v - mean) ** 2, 0) / d.y.length);
    expect(sd).toBeGreaterThan(1.2); expect(Math.abs(mean)).toBeLessThan(0.15);
    const m = measure(d.t, d.y, d)!;
    expect(m.freq).toBeGreaterThan(990); expect(m.freq).toBeLessThan(1010);
    expect(m.min).toBeCloseTo(-2, 3); expect(m.max).toBeCloseTo(2, 3);
    // Its mean and RMS are of every step: 0 and 2 / √2, not what samples a cycle or two apart would average to
    expect(m.rms).toBeCloseTo(Math.SQRT2, 2); expect(Math.abs(m.mean)).toBeLessThan(0.005);
    const alone = measure(d.t, d.y)!;
    expect(alone.rms).toBeLessThan(1.3);
  });

  it('a slow signal is read from its samples as before', () => {
    const d = run((t) => 3 + Math.sin(2 * Math.PI * 10 * t)).series(A)!;
    expect(d.cycles).toBeLessThan(55); expect(d.cycles).toBeLessThan(d.y.length / 4);
    const m = measure(d.t, d.y, d)!;
    expect(m.freq).toBeCloseTo(10, 2); expect(m.min).toBeCloseTo(2, 3); expect(m.max).toBeCloseTo(4, 3); expect(m.mean).toBeCloseTo(3, 2);
    // From a time on: the rises of that stretch alone
    const part = run((t) => 3 + Math.sin(2 * Math.PI * 10 * t)).series(A, 4)!;
    expect(part.cycles).toBeGreaterThanOrEqual(9); expect(part.cycles).toBeLessThanOrEqual(10);
  });

  it('of a sum of fast signals no rate is given and no band is drawn; a negative factor turns the band over', () => {
    const r = run(square(480, 7.4), SPAN, 20e-6, (v, t) => v + Math.sin(2 * Math.PI * 300 * t));
    const d = r.series({ label: 'a-b', unit: 'V', terms: [['a', 1], ['b', -1]] })!;
    expect(d.single).toBe(false); expect(d.lo).toBeUndefined(); expect(d.cycles).toBeGreaterThan(d.y.length / 4);
    expect(measure(d.t, d.y, d)!.freq).toBe(0);
    // a - b is the 300 Hz sine turned over: its mean (the sum of the two signals' means) is nothing, its RMS, from the samples' own squares, 1 / √2 or near it
    const dm = measure(d.t, d.y, d)!;
    expect(Math.abs(dm.mean)).toBeLessThan(0.005); expect(dm.rms).toBeGreaterThan(0.68); expect(dm.rms).toBeLessThan(0.74);
    const neg = r.series({ label: '-a', unit: 'V', terms: [['a', -1]] })!, last = neg.y.length - 1;
    expect(neg.lo![last]).toBeCloseTo(-7.4, 5); expect(neg.hi![last]).toBeCloseTo(0, 12);
    const m = measure(neg.t, neg.y, neg)!;
    expect(m.min).toBeCloseTo(-7.4, 5); expect(m.max).toBeCloseTo(0, 12); expect(m.freq).toBeGreaterThan(475); expect(m.freq).toBeLessThan(485);
    // Half the time at -7.4 V: a mean of -3.7 V and an RMS of 7.4 / √2
    expect(m.mean).toBeCloseTo(-3.7, 1); expect(m.rms).toBeCloseTo(7.4 / Math.SQRT2, 1);
  });

  it('a level that only trembles in its last digits is not said to repeat, however often', () => {
    let k = 0;
    const d = run(() => 5 + ((k++ % 2) ? 1e-13 : -1e-13)).series(A)!;
    expect(d.cycles).toBe(0);
    expect(measure(d.t, d.y, d)!.freq).toBe(0);
    let j = 0;
    const z = run(() => ((j++ % 2) ? 1e-15 : -1e-15)).series(A)!;
    expect(z.cycles).toBe(0);
    expect(measure(z.t, z.y, z)!.freq).toBe(0);
  });

  it('a run begun again starts the record, its bands and its counts afresh', () => {
    const r = run(square(480, 7.4), 1);
    r.push(0, (i) => (i === 0 ? 1 : 2));
    expect(r.count).toBe(1);
    const d = r.series(A)!;
    expect([d.y[0], d.lo![0], d.hi![0], d.cycles]).toEqual([1, 1, 1, 0]);
    r.push(SPACING * 2, (i) => (i === 0 ? 1.5 : 2));
    const e = r.series(A)!;
    expect([e.lo![1], e.hi![1]]).toEqual([1, 1.5]);
  });
});
