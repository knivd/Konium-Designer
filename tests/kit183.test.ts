/**
 * Live Simulation's kit (26.183): every part and source of the palette netlists and runs on a
 * small bench, and the ones set by a value of their own answer to it.
 */
import { describe, expect, it } from 'vitest';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SIM_PARTS_LIB, simPartSymbols, simSourceSymbols, type SimSymbolBuilder } from '../src/formats/synthetic/simLib';
import { kitPartSymbols, kitSourceSymbols } from '../src/formats/synthetic/simKit';
import { partRecords } from '../src/model/schPlace';
import { setSimParam } from '../src/model/simModels';
import { SR } from '../src/model/sch';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { binToBytes } from '../src/formats/text';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { measure } from '../src/sim/liveRecord';

/** A sheet with one part on it and nothing joined to it: its netlist line names a node of its own for each pin. */
function alone(sym: SimSymbolBuilder, values: Record<string, string> = {}): { line: string; text: string; pins: string[]; errors: string[] } {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0, AREACOLOR: 0xffffff, SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
  const items = partRecords({ libRef: sym.libRef, bags: sym.bags }, SIM_PARTS_LIB, 1);
  for (const [k, v] of Object.entries(values)) expect(setSimParam(items, k, v), `${sym.libRef} ${k}`).toBe(true);
  b.placePart(items, [300, 400], { designator: 'X1' });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  const sheets = [{ name: 'One.SchDoc', doc: readSchDoc(writeCfb(root), 'One.SchDoc') }];
  const net = projectNetlist(compileProject(sheets), sheets, defaultSettings());
  const body = net.text.split('*Schematic Netlist:')[1] ?? '';
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('*')) ?? '';
  const pins = [...new Set([...line.matchAll(/NC_X1_(\w+)/g)].map((m) => m[0]))];
  return { line, text: net.text, pins, errors: net.messages.filter((m) => m.level === 'error').map((m) => m.text) };
}
/** The part's netlist with a bench added: a source through 1 kΩ to its first pin, 1 kΩ from each other pin to 0 V. */
function bench(a: ReturnType<typeof alone>, drive = 'SIN(0 5 1k)', extra = ''): Simulator {
  const lines = [`VBENCH bsrc 0 ${drive}`, ...a.pins.map((p, i) => (i === 0 ? `RBENCH0 bsrc ${p} 1k` : `RBENCH${i} ${p} 0 1k`)), extra];
  const s = new Simulator(readNetlist(a.text.replace(/^\.END\s*$/m, `${lines.join('\n')}\n.END`)));
  s.liveStart();
  return s;
}

describe('the kit (26.183): every part of the palette', () => {
  const parts = kitPartSymbols(), sources = kitSourceSymbols();

  it('is in the simulation libraries, each under a name of its own', () => {
    const all = [...simPartSymbols(), ...simSourceSymbols()].map((s) => s.libRef);
    expect(new Set(all).size).toBe(all.length);
    for (const s of [...parts, ...sources]) expect(all, s.libRef).toContain(s.libRef);
    expect(parts.map((s) => s.libRef)).toEqual(['CAP_POL', 'POT', 'SWITCH_SPDT', 'TRANSFORMER', 'RELAY', 'XTAL', 'DIODE_VF', 'SCHOTTKY', 'ZENER', 'LED_VF', 'NPN_BETA', 'PNP_BETA', 'DARLINGTON', 'NMOS_VT', 'PMOS_VT',
      'NJFET', 'PJFET', 'OPAMP_IDEAL', 'COMPARATOR', 'VCVS', 'VCCS', 'CCVS', 'CCCS', 'ANALOG_SWITCH', 'VOLTMETER', 'AMMETER', 'TESTPOINT', 'LAMP',
      'LOGIC_IN', 'NOT', 'AND', 'NAND', 'OR', 'NOR', 'XOR', 'SCHMITT_NOT', 'NE555', 'REGULATOR', 'OPTO',
      'DFF', 'JKFF', 'TFF', 'COUNTER', 'DECODER7', 'SHIFT', 'RING', 'MUX4', 'DAC4', 'ADC4', 'DISPLAY7', 'FUSE', 'FUSE_SLOW', 'DIAC', 'SCR', 'TRIAC', 'SPEAKER']);
    expect(sources.map((s) => s.libRef)).toEqual(['VSQUARE', 'VTRIANGLE', 'VSAW', 'VAM', 'VSWEEP', 'VNOISE', 'RAIL_DC', 'RAIL_SIN', 'RAIL_CLOCK']);
  });

  it('each part netlists without a fault and runs two periods of a 1 kHz bench', () => {
    for (const sym of parts) {
      const a = alone(sym);
      expect(a.errors, sym.libRef).toEqual([]);
      expect(a.line, sym.libRef).not.toBe('');
      const s = bench(a);
      for (let k = 1; k <= 80; k++) s.liveAdvance(k * 2.5e-5, 2.5e-5);
      expect(s.liveTime, sym.libRef).toBeGreaterThanOrEqual(2e-3);
      for (const p of a.pins) expect(Number.isFinite(s.valueOf(p)), `${sym.libRef} ${p}`).toBe(true);
    }
  });

  it('each source netlists and drives a load; a rail has one pin, its other end the reference', () => {
    for (const sym of sources) {
      const a = alone(sym);
      expect(a.errors, sym.libRef).toEqual([]);
      expect(a.pins.length, sym.libRef).toBe(/^RAIL_/.test(sym.libRef) ? 1 : 2);
      const s = new Simulator(readNetlist(a.text.replace(/^\.END\s*$/m, `${a.pins.map((p, i) => (i === 0 ? `RL ${p} 0 1k` : `VG ${p} 0 0`)).join('\n')}\n.END`)));
      s.liveStart();
      let top = -Infinity, low = Infinity;
      for (let k = 1; k <= 400; k++) { s.liveAdvance(k * 5e-6, 5e-6); const v = s.valueOf(a.pins[0]!)!; if (v > top) top = v; if (v < low) low = v; }
      expect(Number.isFinite(top) && Number.isFinite(low), sym.libRef).toBe(true);
      if (sym.libRef === 'RAIL_DC') expect([top, low]).toEqual([5, 5]);
      else if (sym.libRef === 'RAIL_CLOCK') { expect(top).toBeCloseTo(5, 2); expect(low).toBeCloseTo(0, 2); }
      else { expect(top, sym.libRef).toBeGreaterThan(0.9); expect(top, sym.libRef).toBeLessThan(1.6); expect(low, sym.libRef).toBeLessThan(-0.9); }
    }
  });

  /** A part alone with these values and `lines` added to its netlist (p1, p2 and so on stand for its pins), at rest (or, where there is no rest to find, discharged). */
  const rest = (libRef: string, values: Record<string, string>, lines: string[], discharged = false) => {
    const a = alone([...parts, ...sources].find((x) => x.libRef === libRef)!, values);
    expect(a.errors, libRef).toEqual([]);
    const pin = (n: string) => a.pins[+n - 1]!;
    const sim = new Simulator(readNetlist(a.text.replace(/^\.END\s*$/m, `${lines.map((l) => l.replace(/\bp(\d)\b/g, (_, n: string) => pin(n))).join('\n')}\n.END`)));
    sim.liveStart(discharged ? { uic: true } : {});
    return { sim, v: (n: string) => sim.valueOf(/^p\d$/.test(n) ? pin(n[1]!) : n)! };
  };

  it('a diode drops its forward voltage at its current, a Zener holds its Zener voltage', () => {
    for (const [ref, vf, at] of [['DIODE_VF', 0.7, '10m'], ['DIODE_VF', 0.45, '10m'], ['SCHOTTKY', 0.25, '10m'], ['LED_VF', 3.1, '20m'], ['ZENER', 0.6, '10m']] as const) {
      const d = rest(ref, { 'Forward Voltage': String(vf) }, [`IB 0 p1 DC ${at}`, 'VG p2 0 0']);
      expect(d.v('p1'), `${ref} ${vf}`).toBeCloseTo(vf, 2);
    }
    // Twice the current through twice the series resistance: more across it
    expect(rest('DIODE_VF', { 'Series Resistance': '10' }, ['IB 0 p1 DC 20m', 'VG p2 0 0']).v('p1')).toBeGreaterThan(0.75);
    for (const vz of [3.3, 5.1, 12]) {
      const z = rest('ZENER', { 'Zener Voltage': String(vz) }, ['IB 0 p2 DC 5m', 'VG p1 0 0']).v('p2');
      expect(z, `Zener ${vz}`).toBeGreaterThan(vz - 0.05); expect(z, `Zener ${vz}`).toBeLessThan(vz + 0.3);
    }
    // A diode's breakdown voltage the same way
    const bv = rest('DIODE_VF', { 'Breakdown Voltage': '30' }, ['IB 0 p2 DC 5m', 'VG p1 0 0']).v('p2');
    expect(bv).toBeGreaterThan(29.9); expect(bv).toBeLessThan(30.5);
  });

  it('a transistor amplifies by its beta, a MOSFET turns on at its threshold, a JFET passes its saturation current', () => {
    // 10 uA into the base, the collector through 100 ohms from 10 V: the collector current is what the 100 ohms drops
    const ic = (ref: string, beta: string, ib = '10u') => (10 - rest(ref, { Beta: beta }, [`IB 0 p2 DC ${ib}`, 'VC c 0 DC 10', 'RC c p1 100', 'VG p3 0 0']).v('p1')) / 100;
    expect(ic('NPN_BETA', '50')).toBeGreaterThan(0.5e-3); expect(ic('NPN_BETA', '50')).toBeLessThan(0.56e-3);
    expect(ic('NPN_BETA', '200') / ic('NPN_BETA', '50')).toBeGreaterThan(3.9); expect(ic('NPN_BETA', '200') / ic('NPN_BETA', '50')).toBeLessThan(4.1);
    const pnp = (-10 - rest('PNP_BETA', { Beta: '100' }, ['IB p2 0 DC 10u', 'VC c 0 DC -10', 'RC c p1 100', 'VG p3 0 0']).v('p1')) / 100;
    expect(-pnp).toBeGreaterThan(1e-3); expect(-pnp).toBeLessThan(1.12e-3);
    const dar = ic('DARLINGTON', '10k', '1u');
    expect(dar).toBeGreaterThan(9e-3); expect(dar).toBeLessThan(12e-3);
    // 2.5 V on the gate: on with a threshold of 1.5 V, off with one of 3 V
    const vd = (ref: string, vt: string, sign = 1) => sign * rest(ref, { 'Threshold Voltage': vt }, [`VGG p2 0 DC ${2.5 * sign}`, `VD d 0 DC ${10 * sign}`, 'RD d p1 1k', 'VG p3 0 0']).v('p1');
    expect(vd('NMOS_VT', '1.5')).toBeLessThan(0.1); expect(vd('NMOS_VT', '3')).toBeGreaterThan(9.99);
    expect(vd('PMOS_VT', '1.5', -1)).toBeLessThan(0.1); expect(vd('PMOS_VT', '3', -1)).toBeGreaterThan(9.99);
    // The gate at the source: the saturation current through 1 kilohm from 10 V
    const idss = (ref: string, i: string, sign = 1) => (10 - sign * rest(ref, { 'Saturation Current': i }, ['VGG p2 0 DC 0', `VD d 0 DC ${10 * sign}`, 'RD d p1 1k', 'VG p3 0 0']).v('p1')) / 1000;
    expect(idss('NJFET', '5m')).toBeGreaterThan(4.9e-3); expect(idss('NJFET', '5m')).toBeLessThan(5.2e-3);
    expect(idss('NJFET', '2m')).toBeGreaterThan(1.95e-3); expect(idss('NJFET', '2m')).toBeLessThan(2.1e-3);
    expect(idss('PJFET', '2m', -1)).toBeGreaterThan(1.95e-3); expect(idss('PJFET', '2m', -1)).toBeLessThan(2.1e-3);
  });

  it('a potentiometer divides by its position, an op-amp stops at its limits, the blocks multiply by their gain', () => {
    for (const pos of [0, 30, 80, 100]) expect(rest('POT', { Position: String(pos) }, ['VB p1 0 DC 10', 'VG p2 0 0']).v('p3'), `at ${pos} %`).toBeCloseTo(pos / 10, 3);
    const amp = (values: Record<string, string>, plus: number) => rest('OPAMP_IDEAL', values, [`V1 p1 0 DC ${plus}`, 'V2 p2 0 DC 0', 'RL p3 0 10k']).v('p3');
    expect(amp({ 'Max Output': '3' }, 1)).toBeCloseTo(3, 2);
    expect(amp({ 'Min Output': '-2' }, -1)).toBeCloseTo(-2, 2);
    expect(amp({ Gain: '100' }, 0.01)).toBeCloseTo(1, 2);
    expect(rest('COMPARATOR', { 'High Output': '3.3' }, ['V1 p1 0 DC 1', 'V2 p2 0 DC 0.5', 'RL p3 0 100k']).v('p3')).toBeCloseTo(3.3, 2);
    expect(rest('COMPARATOR', { 'Low Output': '-5' }, ['V1 p1 0 DC 0.5', 'V2 p2 0 DC 1', 'RL p3 0 100k']).v('p3')).toBeCloseTo(-5, 2);
    // The four controlled sources: 1 V (or 1 mA through the sensing pins) in, the gain out
    // (these two are written output first: their line's first two nodes are pins 3 and 4)
    expect(rest('VCVS', { Gain: '4' }, ['V1 p3 0 DC 1', 'V2 p4 0 0', 'RL p1 0 1k', 'VG p2 0 0']).v('p1')).toBeCloseTo(4, 6);
    expect(Math.abs(rest('VCCS', { Gain: '2m' }, ['V1 p3 0 DC 1', 'V2 p4 0 0', 'RL p1 0 1k', 'VG p2 0 0']).v('p1'))).toBeCloseTo(2, 6);
    expect(rest('CCVS', { Gain: '3k' }, ['I1 0 p1 DC 1m', 'RS p2 0 1', 'RL p3 0 1k', 'VG p4 0 0']).v('p3')).toBeCloseTo(3, 6);
    expect(Math.abs(rest('CCCS', { Gain: '5' }, ['I1 0 p1 DC 1m', 'RS p2 0 1', 'RL p3 0 1k', 'VG p4 0 0']).v('p3'))).toBeCloseTo(5, 6);
    // The analogue switch: closed with its control above the threshold
    const sw = (ctl: number, vt: string) => rest('ANALOG_SWITCH', { Threshold: vt }, ['VB b 0 DC 10', 'RB b p1 1k', 'RL p2 0 1k', `VC p3 0 DC ${ctl}`]).v('p2');
    expect(sw(3, '2.5')).toBeGreaterThan(4.9); expect(sw(3, '4')).toBeLessThan(0.01);
    // The lamp: its nominal voltage squared over its nominal power (12 V, 5 W: 28.8 ohms)
    expect(rest('LAMP', {}, ['VB b 0 DC 12', 'RB b p1 28.8', 'VG p2 0 0']).v('p1')).toBeCloseTo(6, 6);
    expect(rest('LAMP', { 'Nominal Power': '10' }, ['VB b 0 DC 12', 'RB b p1 14.4', 'VG p2 0 0']).v('p1')).toBeCloseTo(6, 6);
    // The meters take next to nothing: 10 megohms across, no voltage along, a test point no current to speak of
    expect(rest('VOLTMETER', {}, ['VB b 0 DC 10', 'RB b p1 10Meg', 'VG p2 0 0']).v('p1')).toBeCloseTo(5, 3);
    const am = rest('AMMETER', {}, ['VB b 0 DC 10', 'RB b p1 1k', 'RL p2 0 1k']);
    expect(am.v('p1')).toBeCloseTo(5, 6); expect(am.v('p2')).toBeCloseTo(5, 6);
    expect(rest('TESTPOINT', {}, ['VB b 0 DC 10', 'RB b p1 1k']).v('p1')).toBeCloseTo(10, 6);
  });

  it('a relay pulls in at its current, a transformer steps by its ratio', () => {
    // 12 V on a 200 ohm coil is 60 mA; the contact switches 10 V onto 1 kilohm
    const relay = (pull: string, coil = 12) => {
      const r = rest('RELAY', { 'Pull-In Current': pull, 'Drop-Out Current': '5m' }, [`VK p1 0 DC ${coil}`, 'VG p2 0 0', 'VB b 0 DC 10', 'RB b p3 1', 'RL p4 0 1k']);
      for (let k = 1; k <= 50; k++) r.sim.liveAdvance(k * 1e-4, 1e-4);
      return r.v('p4');
    };
    expect(relay('20m')).toBeGreaterThan(9.9);
    expect(relay('80m')).toBeLessThan(0.01);
    const sec = (ratio: string) => {
      const r = rest('TRANSFORMER', { Ratio: ratio }, ['VB p1 0 SIN(0 10 1k)', 'VG p2 0 0', 'RL p3 0 1k', 'VH p4 0 0']);
      let top = 0;
      for (let k = 1; k <= 400; k++) { r.sim.liveAdvance(k * 1e-5, 1e-5); if (k > 200) top = Math.max(top, Math.abs(r.v('p3'))); }
      return top;
    };
    expect(sec('5')).toBeGreaterThan(1.9); expect(sec('5')).toBeLessThan(2.05);
    expect(sec('0.5')).toBeGreaterThan(19); expect(sec('0.5')).toBeLessThan(20.5);
  });

  it('every source answers to its amplitude, offset, frequency and duty cycle', () => {
    /** The source across 1 kilohm for `time`: what a scope would read of it. */
    const read = (libRef: string, values: Record<string, string>, time = 4e-3) => {
      const r = rest(libRef, values, /^RAIL_/.test(libRef) ? ['RL p1 0 1k'] : ['RL p1 0 1k', 'VG p2 0 0']);
      const n = 2000, t = new Float64Array(n), y = new Float64Array(n);
      for (let k = 0; k < n; k++) { r.sim.liveAdvance((k + 1) * time / n, time / n); t[k] = r.sim.liveTime; y[k] = r.v('p1'); }
      return measure(t, y)!;
    };
    for (const ref of ['VSQUARE', 'VTRIANGLE', 'VSAW', 'RAIL_SIN']) {
      const m = read(ref, { Amplitude: '0.5', Offset: '2', Frequency: '2k' });
      expect(m.min, ref).toBeCloseTo(1.5, 1); expect(m.max, ref).toBeCloseTo(2.5, 1);
      expect(m.freq, ref).toBeGreaterThan(1960); expect(m.freq, ref).toBeLessThan(2040);
      expect(m.mean, ref).toBeGreaterThan(1.9); expect(m.mean, ref).toBeLessThan(2.1);
    }
    // A quarter of the time high: the mean halfway between the low level and the middle
    expect(read('VSQUARE', { 'Duty Cycle': '25' }).mean).toBeCloseTo(-0.5, 1);
    expect(read('VSQUARE', { 'Duty Cycle': '75' }).mean).toBeCloseTo(0.5, 1);
    const clock = read('RAIL_CLOCK', { Voltage: '3.3', Frequency: '500', 'Duty Cycle': '25' }, 8e-3);
    expect(clock.max).toBeCloseTo(3.3, 2); expect(clock.min).toBeCloseTo(0, 2); expect(clock.mean).toBeCloseTo(3.3 / 4, 1); expect(clock.freq).toBeCloseTo(500, -1);
    expect(read('RAIL_DC', { Value: '9' }).min).toBe(9);
    // The modulated source: its peak the amplitude and as much again by its depth; the sweep within its amplitude
    const am = read('VAM', { Amplitude: '2', Depth: '50' });
    expect(am.max).toBeGreaterThan(2.8); expect(am.max).toBeLessThan(3.05);
    const sweep = read('VSWEEP', { Amplitude: '3', 'Sweep Time': '4m' });
    expect(sweep.max).toBeGreaterThan(2.9); expect(sweep.max).toBeLessThan(3.001); expect(sweep.min).toBeLessThan(-2.9);
  });

  it('the gates answer as their names say, at the high level they are given; a logic input is low or high by its picture', () => {
    const out = (ref: string, a: number, b: number) => (rest(ref, {}, [`VA p1 0 DC ${a * 5}`, `VB p2 0 DC ${b * 5}`, 'RL p3 0 100k']).v('p3') > 2.5 ? 1 : 0);
    const table = (ref: string) => [out(ref, 0, 0), out(ref, 0, 1), out(ref, 1, 0), out(ref, 1, 1)];
    expect(table('AND')).toEqual([0, 0, 0, 1]);
    expect(table('NAND')).toEqual([1, 1, 1, 0]);
    expect(table('OR')).toEqual([0, 1, 1, 1]);
    expect(table('NOR')).toEqual([1, 0, 0, 0]);
    expect(table('XOR')).toEqual([0, 1, 1, 0]);
    expect(rest('NOT', {}, ['VA p1 0 DC 5', 'RL p2 0 100k']).v('p2')).toBeCloseTo(0, 2);
    expect(rest('NOT', {}, ['VA p1 0 DC 0', 'RL p2 0 100k']).v('p2')).toBeCloseTo(5, 1);
    expect(rest('AND', { 'High Level': '3.3' }, ['VA p1 0 DC 3.3', 'VB p2 0 DC 3.3', 'RL p3 0 100k']).v('p3')).toBeCloseTo(3.3, 1);
    // An input left open counts as low
    expect(rest('NOT', {}, ['RL p2 0 100k']).v('p2')).toBeCloseTo(5, 1);
    // The logic input as it is placed (its low picture): 0 V; its netlist line gives the two resistances the other way for high
    const low = alone(parts.find((x) => x.libRef === 'LOGIC_IN')!);
    expect(low.line).toMatch(/LOGIC_IN PARAMS: RA=1G RB=1 VH=5$/);
    expect(rest('LOGIC_IN', { 'High Level': '3.3' }, ['RL p1 0 10k']).v('p1')).toBeCloseTo(0, 3);
  });

  it('the Schmitt trigger turns over at its two thresholds, the 555 times a pulse, the regulator and the optocoupler do as they are set', () => {
    // A slow triangle on the input: where the input is as the output goes low, and as it goes high again
    const turns = (values: Record<string, string>) => {
      const r = rest('SCHMITT_NOT', values, ['VA p1 0 PULSE(0 5 0 5m 5m 1u 10m)', 'RL p2 0 100k']);
      let was = r.v('p2') > 2.5, down = NaN, up = NaN;
      for (let k = 1; k <= 2000; k++) { r.sim.liveAdvance(k * 5e-6, 5e-6); const high = r.v('p2') > 2.5; if (was && !high) down = r.v('p1'); if (!was && high) up = r.v('p1'); was = high; }
      return [down, up];
    };
    const [d1, u1] = turns({});
    expect(d1).toBeGreaterThan(2.98); expect(d1).toBeLessThan(3.06); expect(u1).toBeLessThan(2.02); expect(u1).toBeGreaterThan(1.94);
    const [d2, u2] = turns({ 'Upper Threshold': '4', 'Lower Threshold': '1' });
    expect(d2).toBeGreaterThan(3.98); expect(d2).toBeLessThan(4.06); expect(u2).toBeLessThan(1.02); expect(u2).toBeGreaterThan(0.94);
    // The 555 as a one-shot: 100 k and 1 uF, triggered at 10 ms for 1 ms: the output is high for 1.1 RC = 110 ms
    const t = rest('NE555', {}, ['VCC p8 0 DC 9', 'VG p1 0 0', 'RR p4 p8 1', 'C2 p5 0 10n', 'R1 p8 p6 100k', 'C1 p6 0 1u', 'RJ p7 p6 1m', 'VT p2 0 PULSE(9 0 10m 1u 1u 1m 1)', 'RL p3 0 10k']);
    let rose = NaN, fell = NaN, high = false;
    for (let k = 1; k <= 4000; k++) { t.sim.liveAdvance(k * 5e-5, 5e-5); const now = t.v('p3') > 4; if (now && !high) rose = t.sim.liveTime; if (!now && high) fell = t.sim.liveTime; high = now; }
    expect(rose).toBeGreaterThan(0.0099); expect(rose).toBeLessThan(0.0103);
    expect(fell - rose).toBeGreaterThan(0.105); expect(fell - rose).toBeLessThan(0.116);
    // The regulator: its output as set; what the load takes comes in at IN (0.1 A through the 1 ohm before it)
    const rg = rest('REGULATOR', { 'Output Voltage': '3.3' }, ['VB b 0 DC 9', 'RB b p1 1', 'VG p2 0 0', 'RL p3 0 33']);
    expect(rg.v('p3')).toBeCloseTo(3.3, 1); expect(9 - rg.v('p1')).toBeGreaterThan(0.099); expect(9 - rg.v('p1')).toBeLessThan(0.104);
    expect(rest('REGULATOR', {}, ['VB p1 0 DC 6', 'VG p2 0 0', 'RL p3 0 1k']).v('p3')).toBeCloseTo(4, 2);
    // The optocoupler: 10 mA through its LED (1.2 V across it), and that times its transfer ratio through the 100 ohms on the other side
    const op = (ctr: string) => rest('OPTO', { 'Transfer Ratio': ctr }, ['VB b 0 DC 5', 'RB b p1 380', 'VG p2 0 0', 'VC c 0 DC 12', 'RC c p3 100', 'VE p4 0 0']);
    expect(op('100').v('p1')).toBeCloseTo(1.2, 1);
    expect(12 - op('100').v('p3')).toBeCloseTo(1, 1); expect(12 - op('50').v('p3')).toBeCloseTo(0.5, 1);
  });

  it('what changes all at once is stepped through: a switch thrown onto an LED, the 555 turning its LED on, at any length of step', () => {
    // 5 V switched onto 330 ohms and an LED at 1 ms: the LED's 0 V to 1.8 V takes the solver more than a time step's ten iterations
    const text = `switched
V1 a 0 DC 5
VC c 0 PULSE(0 5 1m 1n 1n 1 2)
S1 a b c 0 SM
.MODEL SM SW(VT=2.5 VH=0.1 RON=1m ROFF=1G)
R1 b d 330
D1 d 0 LED
.MODEL LED D(IS=2.3e-17 N=2 RS=1 CJO=2p TT=5n)
.END`;
    for (const hmax of [1e-3, 1e-4, 1e-5]) {
      const sim = new Simulator(readNetlist(text));
      sim.liveStart();
      for (let k = 1; k <= 40; k++) sim.liveAdvance(k * 1e-4, hmax);
      expect(sim.valueOf('d'), `step ${hmax}`).toBeGreaterThan(1.7); expect(sim.valueOf('d'), `step ${hmax}`).toBeLessThan(1.9);
    }
    // The 555 flashing its LED (as the example wires it), four seconds in slices of two steps at each of three lengths of step
    // (the longest is a slow frame's): the same rate at each
    for (const hmax of [1.25e-2, 4e-3, 5e-4]) {
      const r = rest('NE555', {}, ['VCC p8 0 DC 9', 'VG p1 0 0', 'RR p4 p8 1', 'C2 p5 0 10n', 'R1 p8 p7 10k', 'R2 p7 p6 47k', 'C1 p6 0 10u', 'RJ p2 p6 1m', 'R3 p3 led 330', 'D1 led 0 LED', '.MODEL LED D(IS=2.3e-17 N=2 RS=1 CJO=2p TT=5n)'], true);
      const n = Math.round(4 / (2 * hmax)), t = new Float64Array(n), y = new Float64Array(n);
      for (let k = 0; k < n; k++) { r.sim.liveAdvance((k + 1) * 2 * hmax, hmax); t[k] = r.sim.liveTime; y[k] = r.v('p3'); }
      const m = measure(t.slice(n >> 2), y.slice(n >> 2))!;
      expect(m.freq, `step ${hmax}`).toBeGreaterThan(1.3); expect(m.freq, `step ${hmax}`).toBeLessThan(1.47);
      expect(m.max, `step ${hmax}`).toBeGreaterThan(7.2); expect(m.min, `step ${hmax}`).toBeLessThan(0.1);
    }
  });
});
