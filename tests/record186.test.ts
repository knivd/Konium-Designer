/**
 * How often a trace repeats, of one that swells and fades (26.186). Two tones beating, 440 Hz and 444 Hz, were said
 * to repeat at 416 Hz: the rises through the middle were counted against a band a twentieth of the whole swing wide,
 * and near each of the beat's quiet instants the trace no longer left the band. The band now follows the swing
 * cycle by cycle.
 */
import { describe, expect, it } from 'vitest';
import { LiveRecord, measure } from '../src/sim/liveRecord';

describe('the rate of a trace that swells and fades (26.186)', () => {
  const A = { label: 'a', unit: 'V' as const, terms: [['a', 1]] as [string, number][] };
  const record = (wave: (t: number) => number, time: number, h: number, spacing: number) => {
    const r = new LiveRecord(['a']);
    r.spacing = spacing;
    for (let k = 0, n = Math.round(time / h); k <= n; k++) { const t = k * h; r.push(t, () => wave(t)); }
    return r.series(A)!;
  };
  const beats = (t: number) => Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 444 * t);

  it('two tones beating, on a five-second scope: 442 Hz from the count made at every step', () => {
    const d = record(beats, 5, 20e-6, 5 / 3125), m = measure(d.t, d.y, d)!;
    expect(d.cycles).toBeGreaterThan(d.y.length / 4);
    expect(m.freq).toBeGreaterThan(442 * 0.995); expect(m.freq).toBeLessThan(442 * 1.005);
    expect(m.max).toBeGreaterThan(1.99); expect(m.min).toBeLessThan(-1.99);
  });

  it('the same seen closely, half a second of it with every cycle drawn: 442 Hz from the samples', () => {
    const d = record(beats, 0.5, 20e-6, 0), m = measure(d.t, d.y, d)!;
    expect(d.cycles).toBeLessThan(d.y.length / 4);
    expect(m.freq).toBeGreaterThan(442 * 0.995); expect(m.freq).toBeLessThan(442 * 1.005);
    // (and with no record behind them)
    const plain = measure(d.t, d.y)!;
    expect(plain.freq).toBeGreaterThan(442 * 0.995); expect(plain.freq).toBeLessThan(442 * 1.005);
  });

  it('a tone that dies away to a hundredth is counted all the way down, and one that stops is said not to repeat', () => {
    const decay = (t: number) => Math.exp(-t / 0.2) * Math.sin(2 * Math.PI * 300 * t);
    const d = record(decay, 0.92, 20e-6, 0), m = measure(d.t, d.y, d)!;
    expect(m.freq).toBeGreaterThan(299); expect(m.freq).toBeLessThan(301);
    const kept = record(decay, 0.92, 20e-6, 2e-3), k = measure(kept.t, kept.y, kept)!;
    expect(k.freq).toBeGreaterThan(297); expect(k.freq).toBeLessThan(303);
    // A burst and then nothing: over the stretch after it, no rate
    const burst = (t: number) => (t < 0.2 ? Math.sin(2 * Math.PI * 300 * t) : 0);
    const r = new LiveRecord(['a']); r.spacing = 2e-3;
    for (let k = 0; k <= 50000; k++) { const t = k * 20e-6; r.push(t, () => burst(t)); }
    const late = r.series(A, 0.5)!;
    expect(measure(late.t, late.y, late)!.freq).toBe(0);
  });

  it('a square wave with a short low part, five samples to a cycle: its rate is the count at every step, not what the samples catch of it', () => {
    // 218 Hz, low for a third of its cycle (1.5 ms). The record keeps a sample every 1.6 ms to 2.4 ms at first, as a scope at
    // real time does, and then, the run having fallen behind, every 0.5 ms to 0.75 ms: about five samples to a cycle in all
    const wave = (t: number) => ((t * 218) % 1 < 1 / 3 ? 0 : 7.4);
    const r = new LiveRecord(['a']);
    for (let k = 0; k <= 100000; k++) { const t = k * 10e-6; r.spacing = t < 0.4 ? 1.6e-3 : 0.5e-3; r.push(t, () => wave(t)); }
    const d = r.series(A)!, m = measure(d.t, d.y, d)!;
    expect(d.cycles).toBeLessThan(d.y.length / 4); expect(d.cycles).toBeGreaterThan(d.y.length / 16);
    expect(m.freq).toBeGreaterThan(216); expect(m.freq).toBeLessThan(220);
    // (the samples alone miss some of the low parts)
    expect(measure(d.t, d.y)!.freq).toBeLessThan(214);
  });

  it('noise on a slow sine is still not counted: a ripple of a fiftieth of the swing on 5 Hz reads 5 Hz', () => {
    const noisy = (t: number) => Math.sin(2 * Math.PI * 5 * t) + 0.02 * Math.sin(2 * Math.PI * 997 * t);
    const d = record(noisy, 2, 20e-6, 2e-4), m = measure(d.t, d.y, d)!;
    expect(m.freq).toBeGreaterThan(4.95); expect(m.freq).toBeLessThan(5.05);
    // (the count made at every step, which a scope of this span does not go by, is of the slow sine as well once it has seen a cycle of it)
    const late = record(noisy, 4, 20e-6, 2e-4);
    expect(late.cycles).toBeGreaterThan(17); expect(late.cycles).toBeLessThan(23);
  });
});
