/**
 * Live Simulation's kit, the parts added in 26.184: flip-flops, a counter, a seven-segment decoder
 * and display, a fuse, a thyristor and a TRIAC, a noise source and a speaker. Each on a bench:
 * what it is asked, and what it answers.
 */
import { describe, expect, it } from 'vitest';
import { simPartSymbols, simSourceSymbols } from '../src/formats/synthetic/simLib';
import { kitPartSymbols, kitSourceSymbols } from '../src/formats/synthetic/simKit';
import { evalExpr, parseExpr } from '../src/sim/expr';
import { alone as onSheet, rest as bench } from './kitBench';

describe('the kit (26.184): flip-flops, counter, display, fuse, thyristors, noise, speaker', () => {
  const all = [...kitPartSymbols(), ...kitSourceSymbols()];
  const rest = (libRef: string, values: Record<string, string>, lines: string[], discharged = false) => bench(all.find((s) => s.libRef === libRef)!, values, lines, discharged);
  const CLOCK = 'PULSE(0 5 1m 1u 1u 1m 2m)';   // rises at 1 ms, 3 ms, 5 ms and so on
  const high = (v: number) => (v > 2.5 ? 1 : 0);

  it('they are in the simulation libraries', () => {
    const libs = [...simPartSymbols(), ...simSourceSymbols()].map((s) => s.libRef);
    for (const r of ['DFF', 'JKFF', 'TFF', 'COUNTER', 'DECODER7', 'DISPLAY7', 'FUSE', 'SCR', 'TRIAC', 'SPEAKER', 'VNOISE']) expect(libs.filter((x) => x === r), r).toHaveLength(1);
  });

  it('a D flip-flop takes D as the clock rises and at no other time', () => {
    // D high until 2.5 ms, then low: Q goes high at 1 ms, is still high at 2.7 ms (D has gone low, the clock has not risen), low from 3 ms
    const d = rest('DFF', {}, ['VD p1 0 PWL(0 5 2.4m 5 2.5m 0)', `VC p2 0 ${CLOCK}`, 'RQ p3 0 100k', 'RN p4 0 100k']);
    const seen: number[][] = [];
    for (const t of [0.5e-3, 1.5e-3, 2.7e-3, 3.5e-3, 5.5e-3]) { d.to(t); seen.push([high(d.v('p3')), high(d.v('p4'))]); }
    expect(seen).toEqual([[0, 1], [1, 0], [1, 0], [0, 1], [0, 1]]);
    expect(rest('DFF', { 'High Level': '3.3' }, ['VD p1 0 DC 3.3', 'VC p2 0 PULSE(0 3.3 1m 1u 1u 1m 2m)', 'RQ p3 0 100k']).v('p4')).toBeCloseTo(3.3, 1);
  });

  it('a JK flip-flop sets, clears, turns over and holds; a T flip-flop turns over while T is high', () => {
    const run = (ref: string, lines: string[], q: string) => {
      const f = rest(ref, {}, [...lines, `VC p2 0 ${CLOCK}`, `RQ ${q} 0 100k`]), seen: number[] = [];
      for (const t of [0.5e-3, 1.5e-3, 3.5e-3, 5.5e-3]) { f.to(t); seen.push(high(f.v(q))); }
      return seen;
    };
    expect(run('JKFF', ['VJ p1 0 DC 5', 'VK p3 0 DC 5'], 'p4')).toEqual([0, 1, 0, 1]);
    expect(run('JKFF', ['VJ p1 0 DC 5', 'VK p3 0 DC 0'], 'p4')).toEqual([0, 1, 1, 1]);
    expect(run('JKFF', ['VJ p1 0 DC 0', 'VK p3 0 DC 0'], 'p4')).toEqual([0, 0, 0, 0]);
    // Set by the first rise, then J low and K high: cleared by the second
    expect(run('JKFF', ['VJ p1 0 PWL(0 5 2m 5 2.1m 0)', 'VK p3 0 PWL(0 0 2m 0 2.1m 5)'], 'p4')).toEqual([0, 1, 0, 0]);
    expect(run('TFF', ['VT p1 0 DC 5'], 'p3')).toEqual([0, 1, 0, 1]);
    expect(run('TFF', ['VT p1 0 PWL(0 5 2m 5 2.1m 0)'], 'p3')).toEqual([0, 1, 1, 1]);
  });

  it('the counter counts the clock\'s rises to its modulus and round again; RST clears it', () => {
    const count = (c: ReturnType<typeof rest>) => high(c.v('p3')) + 2 * high(c.v('p4')) + 4 * high(c.v('p5')) + 8 * high(c.v('p6'));
    const FAST = 'PULSE(0 5 0.5m 1u 1u 0.5m 1m)';   // rises at 0.5 ms, 1.5 ms and so on: n rises by n ms
    const LOADS = ['R0 p3 0 100k', 'R1 p4 0 100k', 'R2 p5 0 100k', 'R3 p6 0 100k'];
    const c16 = rest('COUNTER', {}, [`VC p1 0 ${FAST}`, 'VR p2 0 DC 0', ...LOADS]), seen16: number[] = [];
    for (let n = 0; n <= 18; n++) { c16.to(n * 1e-3 + 0.2e-3); seen16.push(count(c16)); }
    expect(seen16).toEqual(Array.from({ length: 19 }, (_, n) => n % 16));
    const c10 = rest('COUNTER', { Modulus: '10' }, [`VC p1 0 ${FAST}`, 'VR p2 0 DC 0', ...LOADS]), seen10: number[] = [];
    for (let n = 0; n <= 12; n++) { c10.to(n * 1e-3 + 0.2e-3); seen10.push(count(c10)); }
    expect(seen10).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
    // RST high from 5.6 ms to 5.8 ms: five counted, cleared, and counting again from nothing
    const cr = rest('COUNTER', {}, [`VC p1 0 ${FAST}`, 'VR p2 0 PULSE(0 5 5.6m 1u 1u 0.2m 1)', ...LOADS]), seenR: number[] = [];
    for (const t of [5.2e-3, 5.7e-3, 6.2e-3, 7.7e-3]) { cr.to(t); seenR.push(count(cr)); }
    expect(seenR).toEqual([5, 0, 0, 2]);
  });

  it('the decoder lights the segments of each digit; the display\'s segments take their current through their own resistors', () => {
    const DIGITS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg', 'abcefg', 'cdefg', 'adef', 'bcdeg', 'adefg', 'aefg'];
    for (let n = 0; n < 16; n++) {
      const d = rest('DECODER7', {}, [0, 1, 2, 3].map((b) => `V${b} p${b + 1} 0 DC ${(n >> b) & 1 ? 5 : 0}`).concat([...'abcdefg'].map((s, i) => `R${s} p${5 + i} 0 100k`)));
      expect([...'abcdefg'].filter((_, i) => high(d.v(`p${5 + i}`))).join(''), `digit ${n}`).toBe(DIGITS[n]);
    }
    // Segments a and d driven from 5 V through 1 ohm (what that drops is the current); the rest at 0 V; the cathode at 0 V
    const lines = [...'abcdefg'].map((s, i) => (s === 'a' || s === 'd' ? `V${s} n${s} 0 DC 5\nRS${s} n${s} p${i + 1} 1` : `V${s} p${i + 1} 0 DC 0`));
    const disp = rest('DISPLAY7', {}, [...lines, 'VK p8 0 0']);
    for (const [s, i] of [['a', 1], ['d', 4]] as const) { const ma = (5 - disp.v(`p${i}`)) * 1000; expect(ma, s).toBeGreaterThan(13); expect(ma, s).toBeLessThan(15.5); }
    // A segment at its forward voltage through its resistor: next to nothing through it below that
    const dim = rest('DISPLAY7', { 'Series Resistance': '1k' }, ['Va na 0 DC 5', 'RSa na p1 1', ...[...'bcdefg'].map((s, i) => `V${s} p${i + 2} 0 DC 0`), 'VK p8 0 0']);
    expect((5 - dim.v('p1')) * 1000).toBeGreaterThan(2.9); expect((5 - dim.v('p1')) * 1000).toBeLessThan(3.3);
  });

  it('a fuse carries its current until it passes the rating, and is open from then on; a carried-on run keeps it blown, and it can be made good', () => {
    // 0 V to 12 V in 10 ms across the fuse and 6 ohms: 1 A at 5 ms. Then down to 0.5 V, where an unblown fuse would carry 83 mA
    const LINES = ['VB p1 0 PWL(0 0 10m 12 20m 12 30m 0.5)', 'RL p2 0 6'];
    const f = rest('FUSE', {}, LINES);
    f.to(2.5e-3); expect(f.v('p2')).toBeCloseTo(3, 1);
    f.to(4.8e-3); expect(f.v('p2')).toBeGreaterThan(5.6);
    f.to(5.3e-3); expect(Math.abs(f.v('p2'))).toBeLessThan(1e-3);
    f.to(35e-3); expect(Math.abs(f.v('p2'))).toBeLessThan(1e-3);
    const half = rest('FUSE', { Rating: '0.5' }, LINES);
    half.to(2.3e-3); expect(half.v('p2')).toBeGreaterThan(2.6);
    half.to(2.8e-3); expect(Math.abs(half.v('p2'))).toBeLessThan(1e-3);
    // The state is carried by name to a run that takes over, and a blown fuse is made good by name
    const state = f.sim.unknownsNow(), switches = [...state.keys()].filter((k) => k.startsWith('@switch:'));
    expect(switches.map((k) => state.get(k))).toEqual([1, 1]);
    const again = rest('FUSE', {}, ['VB p1 0 DC 3', 'RL p2 0 6']);
    expect(again.v('p2')).toBeCloseTo(3, 1);
    again.sim.liveStart({ carry: state, time: 0 });
    again.to(1e-3); expect(Math.abs(again.v('p2'))).toBeLessThan(1e-3);
    for (const k of switches) expect(again.sim.liveSetSwitch(k.slice(8), false)).toBe(true);
    again.to(2e-3); expect(again.v('p2')).toBeCloseTo(3, 1);
    expect(again.sim.liveSetSwitch('nosuch', false)).toBe(false);
  });

  it('a thyristor turns on by its gate, stays on without it and turns off when its current stops; it blocks the other way', () => {
    // 12 V and 100 ohms; the gate pulsed at 1 ms for 0.5 ms; the supply taken away at 3 ms and back at 3.5 ms
    const s = rest('SCR', {}, ['VB b 0 PWL(0 12 3m 12 3.1m 0 3.4m 0 3.5m 12)', 'RL b p1 100', 'VK p2 0 0', 'VT g 0 PULSE(0 5 1m 1u 1u 0.5m 1)', 'RG g p3 470']);
    s.to(0.8e-3); expect(s.v('p1')).toBeGreaterThan(11.9);
    s.to(1.3e-3); expect(s.v('p1')).toBeGreaterThan(0.5); expect(s.v('p1')).toBeLessThan(1.3);
    s.to(2.5e-3); expect(s.v('p1')).toBeLessThan(1.3);
    s.to(4.5e-3); expect(s.v('p1')).toBeGreaterThan(11.9);
    // Too little gate current (a tenth of the trigger current): it stays off. The supply the other way: off, gate or no gate
    const weak = rest('SCR', {}, ['VB b 0 DC 12', 'RL b p1 100', 'VK p2 0 0', 'IG 0 p3 PULSE(0 0.5m 1m 1u 1u 0.5m 1)']);
    weak.to(2e-3); expect(weak.v('p1')).toBeGreaterThan(11.9);
    const back = rest('SCR', {}, ['VB b 0 DC -12', 'RL b p1 100', 'VK p2 0 0', 'VT g 0 PULSE(0 5 1m 1u 1u 0.5m 1)', 'RG g p3 470']);
    back.to(1.3e-3); expect(back.v('p1')).toBeLessThan(-11.9);
    // A lower holding current keeps it on with less: 20 mA of load holds at 5 mA, not at 50 mA
    const hold = (ih: string) => { const h = rest('SCR', { 'Holding Current': ih }, ['VB b 0 DC 12', 'RL b p1 560', 'VK p2 0 0', 'VT g 0 PULSE(0 5 1m 1u 1u 0.5m 1)', 'RG g p3 470']); h.to(2.5e-3); return h.v('p1'); };
    expect(hold('5m')).toBeLessThan(1.3); expect(hold('50m')).toBeGreaterThan(11.9);
  });

  it('a TRIAC does the same either way round', () => {
    for (const sign of [1, -1]) {
      const t = rest('TRIAC', {}, [`VB b 0 PWL(0 ${12 * sign} 3m ${12 * sign} 3.1m 0 3.4m 0 3.5m ${12 * sign})`, 'RL b p1 100', 'VK p2 0 0', `VT g 0 PULSE(0 ${5 * sign} 1m 1u 1u 0.5m 1)`, 'RG g p3 470']);
      t.to(0.8e-3); expect(sign * t.v('p1'), `${sign}`).toBeGreaterThan(11.9);
      t.to(2.5e-3); expect(sign * t.v('p1'), `${sign}`).toBeGreaterThan(0.5); expect(sign * t.v('p1'), `${sign}`).toBeLessThan(1.3);
      t.to(4.5e-3); expect(sign * t.v('p1'), `${sign}`).toBeGreaterThan(11.9);
    }
    // A sine through it: turned on by the gate each half cycle (through 1 kilohm from MT2), off at each crossing
    const ac = rest('TRIAC', {}, ['VB b 0 SIN(0 24 50)', 'RL b p1 100', 'VK p2 0 0', 'RG p1 p3 1k']);
    let on = 0, n = 0;
    for (let k = 1; k <= 400; k++) { ac.to(k * 1e-4, 1e-5); const vs = 24 * Math.sin(2 * Math.PI * 50 * k * 1e-4); if (Math.abs(vs) > 12) { n++; if (Math.abs(ac.v('p1')) < 2) on++; } }
    expect(on).toBe(n);
  });

  it('noise is the same every time, keeps to its amplitude about its offset, and has little above its bandwidth', () => {
    const f = (x: number) => evalExpr(parseExpr(`noise(${x})`));
    const at = Array.from({ length: 2000 }, (_, i) => f(i));
    expect(Math.max(...at)).toBeLessThanOrEqual(1); expect(Math.min(...at)).toBeGreaterThanOrEqual(-1);
    const mean = at.reduce((a, b) => a + b, 0) / at.length, rms = Math.sqrt(at.reduce((a, b) => a + b * b, 0) / at.length);
    expect(Math.abs(mean)).toBeLessThan(0.05); expect(rms).toBeGreaterThan(0.5); expect(rms).toBeLessThan(0.65);
    expect(f(12.25)).toBe(f(12.25)); expect(Math.abs(f(7.0001) - f(7))).toBeLessThan(1e-6);
    // The source: 2 V of it about 1 V, below 10 kHz
    const read = () => { const s = rest('VNOISE', { Amplitude: '2', Offset: '1', Bandwidth: '10k' }, ['RL p1 0 1k', 'VG p2 0 0']), y: number[] = []; for (let k = 1; k <= 2000; k++) { s.to(k * 1e-5, 5e-6); y.push(s.v('p1')); } return y; };
    const y = read(), y2 = read();
    expect(y.slice(0, 200)).toEqual(y2.slice(0, 200));
    expect(Math.max(...y)).toBeLessThanOrEqual(3.0001); expect(Math.min(...y)).toBeGreaterThanOrEqual(-1.0001);
    const m = y.reduce((a, b) => a + b, 0) / y.length;
    expect(m).toBeGreaterThan(0.7); expect(m).toBeLessThan(1.3);
    // From one 10 us sample to the next it moves by a fraction of its swing: nothing much faster than its bandwidth
    const steps = y.slice(1).map((v, i) => Math.abs(v - y[i]!));
    expect(Math.max(...steps)).toBeLessThan(0.9);
    expect(Math.max(...y) - Math.min(...y)).toBeGreaterThan(3);
  });

  it('the speaker has two terminals and its impedance between them', () => {
    const a = onSheet(all.find((x) => x.libRef === 'SPEAKER')!);
    expect(a.errors).toEqual([]); expect(a.pins).toHaveLength(2);
    // 8 ohms as it comes, fed through 8 ohms: half the 5 V across it, wherever it stands above 0 V
    const r = rest('SPEAKER', {}, ['VB b 0 DC 5', 'RB b p1 8', 'VL p2 0 DC 1']);
    expect(r.v('p1') - r.v('p2')).toBeCloseTo(2, 6);
    const r32 = rest('SPEAKER', { Impedance: '32' }, ['VB b 0 DC 5', 'RB b p1 8', 'VL p2 0 DC 0']);
    expect(r32.v('p1')).toBeCloseTo(4, 6);
  });
});
