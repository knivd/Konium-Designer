/**
 * A switch's turn placed in time (26.184). In a live run a switch that turns over in a step is solved
 * as turned from the step's start, so an oscillator made of switches (the 555, the Schmitt trigger,
 * the flip-flops) ran early by up to a step at every turn: the 555 of the tone example (then 481 Hz
 * by its parts) ran at 670 Hz at the steps a run at real time takes, and was heard at that pitch. The
 * step a switch turns in is now not taken: the switch says how far through it it turned, and the turn
 * is closed in on until the step it falls in is a 256th of the first.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';

describe('a switch\'s turn is placed within the step it happens in (26.184)', () => {
  /** An example started with everything discharged, and the rises of a test point through `mid` (a band of `band` either side) as its steps go by. */
  const start = (id: string, tp: string, mid: number, band: number) => {
    const ex = LIVE_EXAMPLES.find((e) => e.id === id)!, name = liveExampleFile(ex), sheets = [{ name, doc: readSchDoc(liveExampleBytes(ex), name) }];
    const map: LiveMap = { nets: new Map(), pins: new Map() };
    const net = projectNetlist(compileProject(sheets), sheets, defaultSettings(), () => null, 'Live Simulation', map);
    const sim = new Simulator(readNetlist(net.text));
    sim.liveStart({ uic: true });
    const i = sim.unknownAt(map.pins.get(`${tp}|1`)!.node)!, rises: number[] = [];
    let under = true, steps = 0;
    const step = (time: number) => { steps++; const v = sim.valueAt(i); if (under && v > mid + band) { rises.push(time); under = false; } else if (!under && v < mid - band) under = true; };
    /** The run taken on by `frames` frames of `frame` seconds, its steps as long as `hmax`; the rate over them. */
    const rate = (frames: number, frame: number, hmax: number) => {
      rises.length = 0;
      const t0 = sim.liveTime, n0 = steps;
      for (let f = 1; f <= frames; f++) sim.liveAdvance(t0 + f * frame, hmax, undefined, step);
      return { hz: (rises.length - 1) / (rises[rises.length - 1]! - rises[0]!), rises: rises.length, steps: steps - n0 };
    };
    return { sim, rate };
  };

  it('the tone example\'s 555 runs at its rate whatever the length of step: at real time\'s 16 ms frames as at a 300th of its period', { timeout: 40000 }, () => {
    const fine = start('tone', 'TP1', 3.7, 1.5);
    fine.rate(10, 4e-3, 15e-6);
    const f = fine.rate(40, 4e-3, 15e-6).hz;
    // 1.44 / ((10 k + 2 x 10 k) x 220 nF) = 218 Hz
    expect(f).toBeGreaterThan(215); expect(f).toBeLessThan(222);
    for (const [frame, hmax] of [[16e-3, 8e-3], [50e-3, 25e-3], [1e-3, 0.5e-3]] as const) {
      const r = start('tone', 'TP1', 3.7, 1.5);
      r.rate(2, 16e-3, 15e-6);
      const got = r.rate(Math.round(0.4 / frame), frame, hmax);
      expect(Math.abs(got.hz / f - 1), `${frame} s frames: ${got.hz} Hz`).toBeLessThan(0.005);
      // Some thirty steps a cycle: two turns, each closed in on in three or four steps and gone on from at a 32nd of the step
      expect(got.steps / got.rises).toBeLessThan(50);
      expect(r.sim.forcedSteps).toBe(0);
    }
  });

  it('the LED flasher and the Schmitt-trigger oscillator likewise, at steps of four periods', { timeout: 40000 }, () => {
    for (const [id, tp, mid, band, period] of [['timer', 'TP1', 3.7, 1.5, 0.72], ['schmitt', 'TP1', 2.5, 0.3, 0.81e-3]] as const) {
      const fine = start(id, tp, mid, band);
      fine.rate(8, period, period / 300);
      const f = fine.rate(30, period, period / 300).hz;
      expect(Math.abs(f * period - 1), `${id} ${f} Hz`).toBeLessThan(0.05);
      const r = start(id, tp, mid, band);
      r.rate(8, period, period / 300);
      const got = r.rate(8, 8 * period, 4 * period);
      expect(Math.abs(got.hz / f - 1), `${id}: ${got.hz} Hz against ${f} Hz`).toBeLessThan(0.01);
      expect(got.steps / got.rises).toBeLessThan(120);
    }
  });

  it('a run is not held up where a step as short as steps go is asked to be shorter still', { timeout: 40000 }, () => {
    // The flasher at frames of eight periods: after its timing capacitor's turn the error reckoned for a step at the
    // shortest asked for a shorter one, again and again, and the run stood still
    const r = start('timer', 'TP1', 3.7, 1.5);
    const sim = r.sim as unknown as { newton: (n: number) => boolean };
    let solves = 0;
    const newton = sim.newton.bind(r.sim);
    sim.newton = (n: number) => { solves++; return newton(n); };
    const got = r.rate(1, 5.8, 2.9);
    expect(r.sim.liveTime).toBeGreaterThanOrEqual(5.8);
    expect(got.rises).toBeGreaterThanOrEqual(7);
    expect(solves).toBeLessThan(3000);
  });
});
