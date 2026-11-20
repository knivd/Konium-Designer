/**
 * Live Simulation's examples (26.183): every one is a sheet whose parts are all joined up, that
 * netlists without a fault and runs; a few are checked for what they are there to show.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile, type LiveExample } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { liveGeometry } from '../src/model/liveWires';
import { measure } from '../src/sim/liveRecord';

function run(ex: LiveExample) {
  const name = liveExampleFile(ex), sheets = [{ name, doc: readSchDoc(liveExampleBytes(ex), name) }], compiled = compileProject(sheets);
  const map: LiveMap = { nets: new Map(), pins: new Map() };
  const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
  const sim = new Simulator(readNetlist(net.text));
  sim.liveStart(ex.zero ? { uic: true } : {});   // each has an operating point to start from, but the two that are told to start discharged
  const fmax = net.sourceFrequencies.length ? Math.max(...net.sourceFrequencies) : 1000;
  /** The voltage of a test point's net over `periods` of the fastest source: its least and most. */
  const swing = (tp: string, periods = 3) => {
    const node = map.pins.get(`${tp}|1`)!.node, t0 = sim.liveTime, span = periods / fmax;
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k <= 400; k++) { sim.liveAdvance(t0 + span * k / 400, 1 / (40 * fmax)); const v = sim.valueOf(node)!; if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi] as const;
  };
  return { sheets, compiled, map, net, sim, swing, fmax };
}

const r2 = (got: number, want: number): void => { expect(got).toBeGreaterThan(want * 0.98); expect(got).toBeLessThan(want * 1.02); };

describe('the examples (26.183)', () => {
  it('there are 55, in eight groups, each with a name of its own and a line on what to try', () => {
    expect(LIVE_EXAMPLES.length).toBe(55);
    expect([...new Set(LIVE_EXAMPLES.map((e) => e.group))]).toEqual(['Basics', 'Filters and AC', 'Diodes and thyristors', 'Transistors', 'MOSFETs and relays', 'Op-amps', 'Logic and chips', 'Sources']);
    expect(new Set(LIVE_EXAMPLES.map((e) => e.id)).size).toBe(55);
    expect(new Set(LIVE_EXAMPLES.map((e) => e.title)).size).toBe(55);
    for (const e of LIVE_EXAMPLES) { expect(e.about.length, e.id).toBeGreaterThan(40); expect(e.about, e.id).not.toMatch(/[—–]/); }
  });

  it('every part of every one is joined up, the netlist has no fault, and it runs', () => {
    for (const ex of LIVE_EXAMPLES) {
      const r = run(ex);
      expect(r.net.messages.filter((m) => m.level !== 'info').map((m) => m.text), ex.id).toEqual([]);
      // (the flip-flops that halve a clock leave their inverse outputs open: nothing else is left unjoined)
      expect([...new Set(r.net.text.match(/NC_\w+/g) ?? [])], ex.id).toEqual(ex.id === 'halving' ? ['NC_U1_4', 'NC_U2_4'] : []);
      // 0 V is a net of the sheet (a GND port), or comes with the parts (a logic input, a gate)
      expect([...r.map.nets.values()].includes('0') || readNetlist(r.net.text).elements.some((e) => e.nodes.includes('0') && e.kind !== 'R'), ex.id).toBe(true);
      // Each pin has its run on the sheet, and the run goes on for two periods of its fastest source
      expect(liveGeometry(r.sheets[0]!.doc, r.compiled).runs.filter((x) => x.pin).length, ex.id).toBe(r.map.pins.size - (ex.id === 'halving' ? 2 : 0));
      const t0 = r.sim.liveTime;
      for (let k = 1; k <= 100; k++) r.sim.liveAdvance(t0 + 2 / r.fmax * k / 100, 1 / (40 * r.fmax));
      for (const node of r.map.nets.values()) expect(Number.isFinite(r.sim.valueOf(node)), `${ex.id} ${node}`).toBe(true);
    }
  });

  const of = (id: string) => run(LIVE_EXAMPLES.find((e) => e.id === id)!);
  it('they show what they say', () => {
    // The divider halves 10 V; the potentiometer at 30 % gives 3 V
    expect(of('divider').swing('TP1')[0]).toBeCloseTo(5, 3);
    expect(of('pot').swing('TP1')[0]).toBeCloseTo(3, 2);
    // The low-pass at its corner passes about 0.7 of the input
    const lp = of('lowpass'); lp.swing('TP2', 5); const [lo, hi] = lp.swing('TP2', 3);
    expect((hi - lo) / 2).toBeGreaterThan(0.6); expect((hi - lo) / 2).toBeLessThan(0.8);
    // The half-wave rectifier: nothing below zero, the peak a diode's drop under 10 V
    const hw = of('halfwave').swing('TP2');
    expect(hw[0]).toBeGreaterThan(-0.05); expect(hw[1]).toBeGreaterThan(8.9); expect(hw[1]).toBeLessThan(9.6);
    // The bridge: both halves the same way up (two drops under the peak), never below zero
    const br = of('bridge').swing('TP1');
    expect(br[0]).toBeGreaterThan(-0.05); expect(br[1]).toBeGreaterThan(8); expect(br[1]).toBeLessThan(9.2);
    // The Zener holds about 5.1 V
    const z = of('zener').swing('TP1');
    expect(z[0]).toBeGreaterThan(4.8); expect(z[1]).toBeLessThan(5.4);
    // The clipper: within a forward voltage of 0 V either way
    const cl = of('clipper').swing('TP2');
    expect(cl[0]).toBeGreaterThan(-0.85); expect(cl[0]).toBeLessThan(-0.5); expect(cl[1]).toBeLessThan(0.85); expect(cl[1]).toBeGreaterThan(0.5);
    // The transformer: a fifth of 10 V on the secondary
    const tr = of('transformer'); tr.swing('TP2', 4); const t2 = tr.swing('TP2', 2);
    expect((t2[1] - t2[0]) / 2).toBeGreaterThan(1.7); expect((t2[1] - t2[0]) / 2).toBeLessThan(2.1);
    // The amplifiers: ten times and turned over; eleven times; once
    const inv = of('inverting').swing('TP2'); expect((inv[1] - inv[0]) / 2).toBeCloseTo(5, 1);
    const non = of('noninverting').swing('TP2'); expect((non[1] - non[0]) / 2).toBeCloseTo(2.2, 1);
    const buf = of('buffer').swing('TP2'); expect((buf[1] - buf[0]) / 2).toBeCloseTo(2, 1);
    // The common-emitter stage amplifies a 5 mV sine by more than a hundred
    const ce = of('ce'); ce.swing('TP2', 10); const out = ce.swing('TP2', 3);
    expect((out[1] - out[0]) / 2).toBeGreaterThan(0.5);
    // The CMOS inverter's output swings rail to rail
    const cm = of('cmos').swing('TP2'); expect(cm[0]).toBeLessThan(0.1); expect(cm[1]).toBeGreaterThan(4.9);
    // The four waveforms each swing a volt either way
    const wf = of('waveforms');
    for (const tp of ['TP1', 'TP2', 'TP3', 'TP4']) { const s = wf.swing(tp, 2); expect(s[0], tp).toBeLessThan(-0.95); expect(s[1], tp).toBeGreaterThan(0.95); expect(s[1], tp).toBeLessThan(1.05); }
  });

  it('the oscillators, started with everything discharged, oscillate', () => {
    for (const id of ['relaxation', 'astable']) {
      const r = of(id);
      // A good while first (they have no source to pace them), then a look at the swing
      const t0 = r.sim.liveTime;
      for (let k = 1; k <= 3000; k++) r.sim.liveAdvance(t0 + 0.3 * k / 3000, 1e-4);
      const node = r.map.pins.get('TP1|1')!.node;
      let lo = Infinity, hi = -Infinity;
      const t1 = r.sim.liveTime;
      for (let k = 1; k <= 3000; k++) { r.sim.liveAdvance(t1 + 0.3 * k / 3000, 1e-4); const v = r.sim.valueOf(node)!; if (v < lo) lo = v; if (v > hi) hi = v; }
      expect(hi - lo, id).toBeGreaterThan(2);
    }
  });

  it('logic and chips: the gates answer their inputs, the latch holds, the Schmitt trigger and the 555 run at their rates, the regulator holds its output', () => {
    const at = (r: ReturnType<typeof run>, tp: string) => r.sim.valueOf(r.map.pins.get(`${tp}|1`)!.node)!;
    // IN1 low, IN2 high: AND low, OR and exclusive-OR high
    const g = of('gates');
    expect([at(g, 'TP1'), at(g, 'TP2'), at(g, 'TP3')].map((v) => Math.round(v))).toEqual([0, 5, 5]);
    // IN1 low sets the latch: one output high, the other low
    const l = of('latch');
    expect([at(l, 'TP1'), at(l, 'TP2')].map((v) => Math.round(v))).toEqual([5, 0]);
    /** A test point's reading over `time` after `skip`: its least, most and how often it repeats. */
    const read = (r: ReturnType<typeof run>, tp: string, skip: number, time: number, n = 4000) => {
      const node = r.map.pins.get(`${tp}|1`)!.node, t = new Float64Array(n), y = new Float64Array(n);
      r.sim.liveAdvance(r.sim.liveTime + skip, time / n);
      const t0 = r.sim.liveTime;
      for (let k = 0; k < n; k++) { r.sim.liveAdvance(t0 + time * (k + 1) / n, time / n); t[k] = r.sim.liveTime; y[k] = r.sim.valueOf(node)!; }
      return measure(t, y)!;
    };
    // The Schmitt trigger: its input between its thresholds (2 V and 3 V), at 1/(0.81 RC) = 1.23 kHz
    const sc = read(of('schmitt'), 'TP1', 2e-3, 8e-3);
    expect(sc.min).toBeGreaterThan(1.95); expect(sc.min).toBeLessThan(2.05); expect(sc.max).toBeGreaterThan(2.95); expect(sc.max).toBeLessThan(3.05);
    expect(sc.freq).toBeGreaterThan(1170); expect(sc.freq).toBeLessThan(1290);
    // The 555: C1 between a third and two thirds of 9 V, at 1.44 / ((R1 + 2 R2) C1) = 1.38 Hz; the output from 0 V to 1.4 V under the supply
    const tm = of('timer'), cap = read(tm, 'TP2', 1, 3);
    expect(cap.min).toBeGreaterThan(2.9); expect(cap.min).toBeLessThan(3.1); expect(cap.max).toBeGreaterThan(5.9); expect(cap.max).toBeLessThan(6.1);
    expect(cap.freq).toBeGreaterThan(1.3); expect(cap.freq).toBeLessThan(1.47);
    const out = read(tm, 'TP1', 0, 1.5);
    expect(out.min).toBeLessThan(0.1); expect(out.max).toBeGreaterThan(7.2); expect(out.max).toBeLessThan(7.7);
    // The one-shot waits with its output low and C1 held empty
    const os = of('oneshot');
    expect(at(os, 'TP1')).toBeLessThan(0.05); expect(at(os, 'TP2')).toBeLessThan(0.05);
    // The regulator: 5 V out while the input is 7 V or more, 2 V under the input below that (the input goes down to 6 V)
    const rg = read(of('regulator'), 'TP2', 0, 0.02);
    expect(rg.max).toBeGreaterThan(4.95); expect(rg.max).toBeLessThan(5.01); expect(rg.min).toBeGreaterThan(3.95); expect(rg.min).toBeLessThan(4.02);
  });

  it('the 555 examples run through their switching at a slow frame\'s length of step (the LED turned on all at once)', () => {
    // 25 ms of the circuit's time a frame, in steps of up to 12.5 ms: the step at which the output turns the LED on takes
    // the solver more iterations than a time step is allowed, however short it is made
    const r = of('timer');
    for (let t = 2.5e-2; t < 3; t += 2.5e-2) r.sim.liveAdvance(t, 1.25e-2);
    expect(r.sim.liveTime).toBeGreaterThan(2.97);
    const s = of('timer');
    for (let t = 1.6e-2; t < 3; t += 1.6e-2) s.sim.liveAdvance(t, 8e-3);
    expect(s.sim.liveTime).toBeGreaterThan(2.97);
    // The other circuits that switch by themselves, each through 400 slices at a coarse and at a fine length of step
    for (const [id, slice] of [['astable', 2e-3], ['astable', 2e-4], ['relaxation', 1e-3], ['relaxation', 1e-4], ['schmitt', 1e-4], ['schmitt', 1e-5], ['oneshot', 2.5e-2]] as const) {
      const x = of(id);
      for (let k = 1; k <= 400; k++) x.sim.liveAdvance(k * slice, slice / 2);
      expect(x.sim.liveTime, `${id} at ${slice}`).toBeGreaterThan(399 * slice);
      // (a step taken without a settled solution, to get past an instant no step would, is the rare exception)
      expect(x.sim.forcedSteps, `${id} at ${slice}`).toBeLessThan(20);
    }
  });

  it('the examples of 26.184: flip-flops, the counter and its display, the 555\'s tone, the fuse, the thyristors, noise and beats', { timeout: 60000 }, () => {
    const node = (r: ReturnType<typeof run>, pin: string) => r.map.pins.get(pin)!.node;
    const at = (r: ReturnType<typeof run>, tp: string) => r.sim.valueOf(node(r, `${tp}|1`))!;
    /** A test point over `time` in n samples: its measures and the samples themselves. */
    const read = (r: ReturnType<typeof run>, tp: string, time: number, n = 4000) => {
      const t = new Float64Array(n), y = new Float64Array(n), t0 = r.sim.liveTime, name = node(r, `${tp}|1`), fmax = Math.max(0, ...r.net.sourceFrequencies);
      for (let k = 0; k < n; k++) { r.sim.liveAdvance(t0 + time * (k + 1) / n, Math.min(time / n, fmax ? 1 / (40 * fmax) : Infinity)); t[k] = r.sim.liveTime; y[k] = r.sim.valueOf(name)!; }
      return { m: measure(t, y)!, y };
    };
    // The D flip-flop at rest: Q low, its opposite high
    const d = of('dff');
    expect([at(d, 'TP1'), at(d, 'TP2')].map((v) => Math.round(v))).toEqual([0, 5]);
    // The clock at 1 kHz, the first flip-flop at half of it, the second at a quarter
    const h = of('halving');
    r2(read(h, 'TP1', 20e-3).m.freq, 1000); r2(read(h, 'TP2', 20e-3).m.freq, 500); r2(read(h, 'TP3', 20e-3).m.freq, 250);
    // The counter: one more every half second, 9 followed by 0; the display's lit segments are those of the count's digit
    const c = of('counter'), DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'], seen: number[] = [];
    for (let k = 0; k < 12; k++) {
      c.sim.liveAdvance(0.1 + 0.5 * k, 12.5e-3);
      const count = [3, 4, 5, 6].reduce((a, p, i) => a + (c.sim.valueOf(node(c, `U1|${p}`))! > 2.5 ? 1 << i : 0), 0);
      const lit = [...'abcdefg'].filter((_, i) => c.sim.valueOf(`${c.map.pins.get(`DS1|${i + 1}`)!.meter}#branch`)! > 5e-3).join('');
      expect(lit, `count ${count}`).toBe(DIGITS[count]);
      seen.push(count);
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k], `${seen}`).toBe((seen[k - 1]! + 1) % 10);
    // The 555 with 10 k, 10 k and 220 nF: 1.44 / (30 k x 220 n) = 218 Hz at its output
    const tone = of('tone'); tone.sim.liveAdvance(20e-3, 2e-5);
    const f = read(tone, 'TP1', 50e-3).m;
    expect(f.freq).toBeGreaterThan(210); expect(f.freq).toBeLessThan(226); expect(f.max).toBeGreaterThan(7); expect(f.min).toBeLessThan(0.6);
    // The speaker: the square wave across it through C3 and R3, about nothing: up for two thirds of the time, twice as far down for one third
    const ls = (pin: string) => tone.sim.valueOf(node(tone, `LS1|${pin}`)) ?? 0;
    let top = -Infinity, low = Infinity, sum = 0;
    for (let k = 0; k < 2000; k++) { tone.sim.liveAdvance(tone.sim.liveTime + 4e-5, 4e-5); const v = ls('1') - ls('2'); top = Math.max(top, v); low = Math.min(low, v); sum += v; }
    expect(top).toBeGreaterThan(0.1); expect(top).toBeLessThan(0.3); expect(low).toBeLessThan(-0.2); expect(low).toBeGreaterThan(-0.4); expect(Math.abs(sum / 2000)).toBeLessThan(0.03);
    // The fuse whole and the lamp across the supply; the thyristor off with the supply across it
    expect(at(of('fuse'), 'TP1')).toBeGreaterThan(11.9);
    expect(at(of('scr'), 'TP1')).toBeGreaterThan(11.9);
    // The TRIAC: each half cycle it blocks until the source is some volts up (the gate's current through RV1 and R1), then conducts
    const tr = of('triac');
    const n = 2000, vs = new Float64Array(n), vt = new Float64Array(n);
    for (let k = 0; k < n; k++) { tr.sim.liveAdvance(0.02 + 0.04 * (k + 1) / n, 2e-5); vs[k] = at(tr, 'TP1'); vt[k] = at(tr, 'TP2'); }
    let on = 0, off = 0, high = 0;
    for (let k = 0; k < n; k++) { if (Math.abs(vs[k]!) > 22) { high++; if (Math.abs(vt[k]!) < 2) on++; } if (Math.abs(vs[k]!) < 3 && Math.abs(vs[k]!) > 1.5 && Math.abs(vt[k]! - vs[k]!) < 0.6) off++; }
    expect(on).toBe(high); expect(high).toBeGreaterThan(100); expect(off).toBeGreaterThan(20);
    // Noise: the filter leaves less than what went in
    const nz = of('noise'), rms = (y: Float64Array) => Math.sqrt(y.reduce((a, v) => a + v * v, 0) / y.length);
    const before = rms(read(nz, 'TP1', 5e-3).y), after = rms(read(nz, 'TP2', 5e-3).y);
    expect(before).toBeGreaterThan(0.4); expect(after / before).toBeLessThan(0.6); expect(after / before).toBeGreaterThan(0.1);
    // Two tones: together they reach nearly 2 V, and between the swells nearly nothing
    const beats = of('beats'), b = read(beats, 'TP1', 0.3, 12000).y;
    expect(Math.max(...b)).toBeGreaterThan(1.9);
    expect(node(beats, 'LS1|1')).toBe(node(beats, 'TP1|1')); expect(node(beats, 'LS1|2')).toBe('0');
    const quiet = Array.from({ length: 12000 / 200 }, (_, k) => Math.max(...b.subarray(k * 200, k * 200 + 200).map(Math.abs)));
    expect(Math.min(...quiet)).toBeLessThan(0.25);
  });
});
