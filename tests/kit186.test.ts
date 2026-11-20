/**
 * Live Simulation's kit, the parts added in 26.186: a shift register, a ring counter, a multiplexer,
 * a digital-to-analogue and an analogue-to-digital converter, a DIAC and a slow-blow fuse. Each on
 * a bench: what it is asked, and what it answers.
 */
import { describe, expect, it } from 'vitest';
import { simPartSymbols, simSourceSymbols } from '../src/formats/synthetic/simLib';
import { kitPartSymbols, kitSourceSymbols } from '../src/formats/synthetic/simKit';
import { KIT, KIT_GROUPS } from '../src/app/liveKit';
import { alone as onSheet, rest as bench } from './kitBench';

describe('the kit (26.186): shift register, ring counter, multiplexer, converters, DIAC, slow-blow fuse', () => {
  const all = [...kitPartSymbols(), ...kitSourceSymbols()];
  const rest = (libRef: string, values: Record<string, string>, lines: string[], discharged = false) => bench(all.find((s) => s.libRef === libRef)!, values, lines, discharged);
  const FAST = 'PULSE(0 5 0.5m 1u 1u 0.5m 1m)';   // rises at 0.5 ms, 1.5 ms and so on: n rises by n ms
  const high = (v: number) => (v > 2.5 ? 1 : 0);
  const NEW = ['SHIFT', 'RING', 'MUX4', 'DAC4', 'ADC4', 'DIAC', 'FUSE_SLOW'];

  it('they are in the simulation libraries and the palette, and stand on a sheet with every pin joined', () => {
    const libs = [...simPartSymbols(), ...simSourceSymbols()].map((s) => s.libRef);
    for (const r of NEW) {
      expect(libs.filter((x) => x === r), r).toHaveLength(1);
      expect(KIT.filter((k) => k.libRef === r), r).toHaveLength(1);
      const a = onSheet(all.find((s) => s.libRef === r)!);
      expect(a.errors, r).toEqual([]);
    }
    expect(KIT).toHaveLength(77);
    expect(KIT_GROUPS.map((g) => KIT.filter((k) => k.group === g).length)).toEqual([13, 7, 7, 8, 21, 15, 6]);
    // Each field the panel offers is a parameter the part has
    // (the bench's sheet takes a value for each, and says so of a name the part has not)
    for (const k of KIT.filter((x) => NEW.includes(x.libRef))) expect(onSheet(all.find((s) => s.libRef === k.libRef)!, Object.fromEntries(k.fields.map((f) => [f.param, '3']))).errors, k.libRef).toEqual([]);
  });

  it('the shift register takes D into Q0 as the clock rises and passes each bit on; RST clears it', () => {
    const bits = (c: ReturnType<typeof rest>) => [3, 2, 1, 0].map((i) => high(c.v(`p${4 + i}`))).join('');   // Q3 Q2 Q1 Q0
    const LOADS = ['R0 p4 0 100k', 'R1 p5 0 100k', 'R2 p6 0 100k', 'R3 p7 0 100k'];
    // D high for the first two rises, low after: a 1, a 1, then noughts go in at Q0
    const s = rest('SHIFT', {}, ['VD p1 0 PWL(0 5 1.9m 5 2m 0)', `VC p2 0 ${FAST}`, 'VR p3 0 DC 0', ...LOADS]), seen: string[] = [];
    for (let n = 0; n <= 6; n++) { s.to(n * 1e-3 + 0.2e-3); seen.push(bits(s)); }
    expect(seen).toEqual(['0000', '0001', '0011', '0110', '1100', '1000', '0000']);
    // RST high from 2.6 ms to 2.8 ms with D held high: three taken in, cleared, and filling again
    const r = rest('SHIFT', {}, ['VD p1 0 DC 5', `VC p2 0 ${FAST}`, 'VR p3 0 PULSE(0 5 2.6m 1u 1u 0.2m 1)', ...LOADS]), seenR: string[] = [];
    for (const t of [2.2e-3, 2.7e-3, 3.2e-3, 4.2e-3]) { r.to(t); seenR.push(bits(r)); }
    expect(seenR).toEqual(['0011', '0000', '0000', '0001']);
  });

  it('the ring counter has one output high at a time, the next as the clock rises, round again after its stages', () => {
    const which = (c: ReturnType<typeof rest>) => Array.from({ length: 10 }, (_, i) => high(c.v(`p${3 + i}`))).join('');
    const LOADS = Array.from({ length: 10 }, (_, i) => `R${i} p${3 + i} 0 100k`);
    const one = (i: number) => '0'.repeat(i) + '1' + '0'.repeat(9 - i);
    const ten = rest('RING', {}, [`VC p1 0 ${FAST}`, 'VR p2 0 DC 0', ...LOADS]), seen: string[] = [];
    for (let n = 0; n <= 11; n++) { ten.to(n * 1e-3 + 0.2e-3); seen.push(which(ten)); }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1].map(one));
    const four = rest('RING', { Stages: '4' }, [`VC p1 0 ${FAST}`, 'VR p2 0 PULSE(0 5 5.6m 1u 1u 0.2m 1)', ...LOADS]), seen4: string[] = [];
    for (const t of [0.2e-3, 3.2e-3, 4.2e-3, 5.2e-3, 5.7e-3, 6.7e-3]) { four.to(t); seen4.push(which(four)); }
    // (five rises by 5.2 ms: 5 mod 4; RST at 5.6 ms: back to Q0; one more rise by 6.7 ms)
    expect(seen4).toEqual([0, 3, 0, 1, 0, 1].map(one));
    expect(high(four.v('p3')) + high(four.v('p4'))).toBe(1);
    // An output drives a load as a logic output does: 5 V behind 50 ohms
    expect(ten.v('p4')).toBeCloseTo(5 * 100e3 / 100050, 2);
  });

  it('the multiplexer gives the input its two select lines name', () => {
    // Inputs 1, 0, 0, 1 (I0 to I3): the output for each of the four names
    const out = (s0: number, s1: number) => high(rest('MUX4', {}, ['V0 p1 0 DC 5', 'V1 p2 0 DC 0', 'V2 p3 0 DC 0', 'V3 p4 0 DC 5', `VS0 p5 0 DC ${s0}`, `VS1 p6 0 DC ${s1}`, 'RQ p7 0 100k']).v('p7'));
    expect([out(0, 0), out(5, 0), out(0, 5), out(5, 5)]).toEqual([1, 0, 0, 1]);
    const other = (s0: number, s1: number) => rest('MUX4', { 'High Level': '3.3' }, ['V0 p1 0 DC 0', 'V1 p2 0 DC 3.3', 'V2 p3 0 DC 3.3', 'V3 p4 0 DC 0', `VS0 p5 0 DC ${s0}`, `VS1 p6 0 DC ${s1}`, 'RQ p7 0 100k']).v('p7');
    expect(other(0, 0)).toBeLessThan(0.05); expect(other(3.3, 0)).toBeCloseTo(3.3, 1); expect(other(0, 3.3)).toBeCloseTo(3.3, 1); expect(other(3.3, 3.3)).toBeLessThan(0.05);
  });

  it('the converters: four bits to sixteenths of the reference, and a voltage to its number of sixteenths', () => {
    const dac = (n: number, values: Record<string, string> = {}) => rest('DAC4', values, [0, 1, 2, 3].map((b) => `V${b} p${1 + b} 0 DC ${(n >> b) & 1 ? 5 : 0}`).concat('RL p5 0 1Meg')).v('p5');
    for (const n of [0, 1, 5, 8, 15]) expect(dac(n), String(n)).toBeCloseTo((5 * n) / 16, 2);
    expect(dac(8, { Reference: '2' })).toBeCloseTo(1, 3);
    const adc = (v: number, values: Record<string, string> = {}) => { const a = rest('ADC4', values, [`VI p1 0 DC ${v}`, 'R0 p2 0 100k', 'R1 p3 0 100k', 'R2 p4 0 100k', 'R3 p5 0 100k']); return [0, 1, 2, 3].reduce((s, b) => s + (high(a.v(`p${2 + b}`)) << b), 0); };
    // 5 V over 16 is 0.3125 V a step: 1 V is three steps and a bit, 2.5 V eight, 4.9 V fifteen; under nothing and over the reference it stops at its ends
    expect([0, 0.2, 0.32, 1, 2.5, 4.9, 5, 7, -1].map((v) => adc(v))).toEqual([0, 0, 1, 3, 8, 15, 15, 15, 0]);
    expect(adc(1, { Reference: '2' })).toBe(8);
    // One after the other gives the voltage back to the step below it
    const both = rest('ADC4', {}, ['VI p1 0 DC 3.3', 'R0 p2 0 100k', 'R1 p3 0 100k', 'R2 p4 0 100k', 'R3 p5 0 100k']);
    const code = [0, 1, 2, 3].reduce((s, b) => s + (high(both.v(`p${2 + b}`)) << b), 0);
    expect(dac(code)).toBeCloseTo(Math.floor(3.3 / 0.3125) * 0.3125, 2);
  });

  it('a DIAC blocks until its breakover voltage, then conducts with less across it, either way round, and blocks again when the current stops', () => {
    // 0 V to 40 V in 10 ms through 1 kΩ: it breaks over at 32 V (8 ms) and falls back to 24 V across it
    const d = rest('DIAC', {}, ['VB b 0 PWL(0 0 10m 40 20m 40 30m 0)', 'RS b p1 1k', 'VL p2 0 DC 0']);
    d.to(7e-3); expect(d.v('p1')).toBeCloseTo(28, 0);
    d.to(9e-3); expect(d.v('p1')).toBeGreaterThan(23); expect(d.v('p1')).toBeLessThan(26.5);
    d.to(20e-3); expect(d.v('p1')).toBeGreaterThan(23.5); expect(d.v('p1')).toBeLessThan(27);
    // The supply falls: under the voltage it keeps, no current, and it blocks again (20 V stands across it whole)
    d.to(25.5e-3); expect(d.v('p1')).toBeCloseTo(18, 0);
    // The other way round the same
    const n = rest('DIAC', {}, ['VB b 0 PWL(0 0 10m -40)', 'RS b p1 1k', 'VL p2 0 DC 0']);
    n.to(7e-3); expect(n.v('p1')).toBeCloseTo(-28, 0);
    n.to(9.5e-3); expect(n.v('p1')).toBeLessThan(-23); expect(n.v('p1')).toBeGreaterThan(-27);
    // Its values: a breakover of 20 V and a fall of 5 V
    const v = rest('DIAC', { 'Breakover Voltage': '20', 'Breakback Voltage': '5' }, ['VB b 0 PWL(0 0 10m 40)', 'RS b p1 1k', 'VL p2 0 DC 0']);
    v.to(4.5e-3); expect(v.v('p1')).toBeCloseTo(18, 0);
    v.to(6e-3); expect(v.v('p1')).toBeGreaterThan(14.5); expect(v.v('p1')).toBeLessThan(17);
  });

  it('a slow-blow fuse carries an overload for a time that falls with its square, and its rating for ever', () => {
    // Twice its rating (2 A through 1 A): it blows after 0.288 of its time constant (here 10 ms: 2.88 ms)
    const two = rest('FUSE_SLOW', { 'Heats In': '10m' }, ['VB p1 0 DC 12', 'RL p2 0 6'], true);
    two.to(2.3e-3); expect(two.v('p2')).toBeGreaterThan(11.5);
    two.to(3.4e-3); expect(Math.abs(two.v('p2'))).toBeLessThan(1e-3);
    two.to(30e-3); expect(Math.abs(two.v('p2'))).toBeLessThan(1e-3);
    // Ten times: a hundredth of the time constant (0.1 ms)
    const ten = rest('FUSE_SLOW', { 'Heats In': '10m' }, ['VB p1 0 DC 12', 'RL p2 0 1.2'], true);
    ten.to(0.06e-3); expect(ten.v('p2')).toBeGreaterThan(11);
    ten.to(0.16e-3); expect(Math.abs(ten.v('p2'))).toBeLessThan(1e-2);
    // Nine tenths of the rating, for ten time constants: whole
    const under = rest('FUSE_SLOW', { 'Heats In': '10m' }, ['VB p1 0 DC 5.4', 'RL p2 0 6'], true);
    under.to(100e-3); expect(under.v('p2')).toBeGreaterThan(5.3);
    // A short overload that stops in time leaves it whole: 2 A for 1.5 ms, then 0.5 A
    const brief = rest('FUSE_SLOW', { 'Heats In': '10m' }, ['VB p1 0 PWL(0 12 1.5m 12 1.6m 3)', 'RL p2 0 6'], true);
    brief.to(50e-3); expect(brief.v('p2')).toBeGreaterThan(2.9);
    // Its state is the fuse's: two switches, carried by name and made good by name
    const state = two.sim.unknownsNow(), switches = [...state.keys()].filter((k) => k.startsWith('@switch:'));
    expect(switches.map((k) => state.get(k))).toEqual([1, 1]);
    for (const k of switches) expect(two.sim.liveSetSwitch(k.slice(8), false)).toBe(true);
  });
});
