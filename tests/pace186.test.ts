/**
 * Oscillators that no source paces, at any speed (26.186).
 *
 * The two-transistor astable read 21 Hz to 28 Hz by the length of step it was run at, and at some lengths its
 * saturated transistor's collector stood at 0.04 V and 3.6 V by turns from one step to the next: the trapezoidal rule
 * on the transistors' own charges, which settle in nanoseconds, at steps of microseconds. A live run now takes
 * junctions' charges by Gear's rule and leaves capacitors and inductors to the trapezoidal one.
 *
 * And a circuit with no source was stepped by the frame alone, half of what the frame covers at the longest: the
 * comparator's relaxation oscillator turned over within a step or two at a raised speed. The record's own count of
 * each signal's rises now gives the circuit's pace, and no step is longer than a fortieth of it.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { LiveRecord, liveStepLimit, measure } from '../src/sim/liveRecord';

function make(id: string) {
  const ex = LIVE_EXAMPLES.find((e) => e.id === id)!;
  const name = liveExampleFile(ex), sheets = [{ name, doc: readSchDoc(liveExampleBytes(ex), name) }], compiled = compileProject(sheets);
  const map: LiveMap = { nets: new Map(), pins: new Map() };
  const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
  const sim = new Simulator(readNetlist(net.text));
  sim.liveStart(ex.zero ? { uic: true } : {});
  return { sim, node: map.pins.get('TP1|1')!.node, nets: [...new Set(map.nets.values())].filter((n) => n !== '0') };
}
/** TP1 over `span` seconds in steps of no more than `hmax`, the first third left to settle: every step's value. */
function trace(id: string, hmax: number, span: number) {
  const { sim, node } = make(id);
  sim.liveAdvance(span * 0.3, hmax);
  const ts: number[] = [], ys: number[] = [];
  sim.liveAdvance(span, hmax, Infinity, (t) => { ts.push(t); ys.push(sim.valueOf(node)!); });
  return { t: Float64Array.from(ts), y: Float64Array.from(ys), forced: sim.forcedSteps };
}

describe('oscillators that no source paces (26.186)', () => {
  it('the astable multivibrator runs at one rate whatever the length of step, and its collector does not ring', { timeout: 60000 }, () => {
    // 47 k with 1 uF and with 470 nF: each side off for RC ln((5 + 4.3) / (5 - 0.65)), 20 Hz or so in all
    const T = 1 / 20, rates: number[] = [];
    for (const div of [8, 40, 400, 2000]) {
      const r = trace('astable', T / div, T * 30), m = measure(r.t, r.y)!;
      rates.push(m.freq);
      expect(r.forced, `T/${div}`).toBe(0);
      // Low (saturated) it stays low: from under 0.2 V it is never over 1 V at the next step and back under 0.2 V at the one after
      let rings = 0;
      for (let k = 2; k < r.y.length; k++) if (r.y[k - 2]! < 0.2 && r.y[k - 1]! > 1 && r.y[k]! < 0.2) rings++;
      expect(rings, `T/${div}`).toBe(0);
    }
    for (const f of rates) { expect(f, `${rates}`).toBeGreaterThan(19.6); expect(f, `${rates}`).toBeLessThan(20.6); }
    expect(Math.max(...rates) / Math.min(...rates)).toBeLessThan(1.005);
  });

  it('the longest step of a frame: half the frame, a fortieth of the fastest source\'s period and of the circuit\'s own', () => {
    expect(liveStepLimit(16e-3, 0, 0)).toBe(8e-3);
    expect(liveStepLimit(16e-3, 1000, 0)).toBe(25e-6);
    expect(liveStepLimit(16e-3, 0, 14e-3)).toBeCloseTo(0.35e-3, 9);
    expect(liveStepLimit(16e-3, 1000, 14e-3)).toBe(25e-6);
    // (the circuit's own pace asks for no more than 4,000 steps of a frame)
    expect(liveStepLimit(16e-3, 0, 1e-6)).toBe(4e-6);
    expect(liveStepLimit(1e-6, 0, 14e-3)).toBe(0.5e-6);
  });

  it('the record gives the circuit\'s pace: the fastest signal that swings by something, and none once it has stopped', () => {
    const r = new LiveRecord(['a', 'b', 'supply', 'v1#branch']);
    r.spacing = 1e-3;
    const push = (t: number, on: boolean) => r.push(t, (i) => (i === 0 ? (on && (t * 100) % 1 < 0.5 ? 5 : 0) : i === 1 ? (on ? Math.sin(2 * Math.PI * 25 * t) : 0)
      // a supply whose last digits tremble at every step, and a current that turns over ten times as fast as anything but by a thousandth of the largest
      : i === 2 ? 5 + 1e-4 * (Math.round(t / 20e-6) % 2) : 1e-3 * (1 + 1e-3 * Math.sin(2 * Math.PI * 1000 * t))));
    expect(r.fastest(0)).toBe(0);
    for (let k = 0; k <= 25000; k++) push(k * 20e-6, true);
    expect(r.fastest(0.5)).toBeGreaterThan(9.9e-3); expect(r.fastest(0.5)).toBeLessThan(10.1e-3);
    // They stop: three of its periods on, a signal is no longer followed
    for (let k = 25001; k <= 27500; k++) push(k * 20e-6, false);
    expect(r.fastest(0.55)).toBeCloseTo(0.04, 3);
    for (let k = 27501; k <= 35000; k++) push(k * 20e-6, false);
    expect(r.fastest(0.7)).toBe(0);
  });

  it('the relaxation oscillator at real time, a frame at a time: 72 Hz with its steps bound by its own pace', { timeout: 60000 }, () => {
    const frames = (bound: boolean) => {
      const { sim, node, nets } = make('relaxation'), rec = new LiveRecord(nets);
      rec.spacing = 5 / 3125;
      const at = nets.map((n) => sim.unknownAt(n)!), want = 1 / 60;
      const ts: number[] = [], ys: number[] = [];
      let longest = 0, last = 0;
      for (let f = 1; f <= 90; f++) {
        const hmax = liveStepLimit(want, 0, bound ? rec.fastest(sim.liveTime) : 0);
        sim.liveAdvance(f * want, hmax, Infinity, (t) => { rec.push(t, (i) => sim.valueAt(at[i]!)); if (f > 30) { ts.push(t); ys.push(sim.valueOf(node)!); longest = Math.max(longest, t - last); } last = t; });
      }
      return { freq: measure(Float64Array.from(ts), Float64Array.from(ys))!.freq, longest };
    };
    const fine = measure(...((r) => [r.t, r.y] as const)(trace('relaxation', 1 / 72 / 2000, 0.3)))!.freq;
    expect(fine).toBeGreaterThan(71.8); expect(fine).toBeLessThan(72.6);
    const paced = frames(true), free = frames(false);
    expect(paced.longest).toBeLessThan(1 / 72 / 39);
    expect(Math.abs(paced.freq / fine - 1)).toBeLessThan(0.006);
    // (left to the frame it was some hundredths out)
    expect(free.longest).toBeGreaterThan(1 / 72 / 10);
    expect(Math.abs(free.freq / fine - 1)).toBeGreaterThan(Math.abs(paced.freq / fine - 1));
  });
});
