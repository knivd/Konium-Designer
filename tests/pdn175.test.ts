import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeFill } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addNet, addPads, addPrimRecords } from '../src/model/pcbEdit';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';
import { CBand } from '../src/analysis/cband';
import { hertz, ohms, farads, pdnReport, verdict } from '../src/analysis/pdnReport';
import { formCaps, formNoise, formPdn, formPorts, formTarget, readPdnForm } from '../src/app/pdnRun';
import { analysePdn, buildPdn, capsBetween, cisprLimit, conducted, frequencies, overTarget, parseCapacitance, pulseHarmonic, targetImpedance, typicalEsr, type PdnSetup } from '../src/analysis/pdn';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });

/** A board with VCC and GND; part 0 a capacitor between them, part 1 a load on VCC, part 2 the source on VCC (pads only: no bodies). */
function board(): { doc: PcbDocument; vcc: number; gnd: number } {
  const doc = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
  addNet(doc, 'VCC').apply(); const vcc = doc.nets.length - 1;
  addNet(doc, 'GND').apply(); const gnd = doc.nets.length - 1;
  const pad = (name: string, x: number, y: number, net: number, component: number) => ({ name, layer: L.TOP, at: P(x, y), w: mm(0.6), h: mm(0.6), shape: 'rect' as const, net, component });
  addPads(doc, [pad('1', 25, 20, vcc, 0), pad('2', 26, 20, gnd, 0), pad('1', 1.5, 1.5, vcc, 1), pad('1', 48, 38, vcc, 2)]).apply();
  return { doc, vcc, gnd };
}
const setupOf = (b: { vcc: number; gnd: number }, o: Partial<PdnSetup> = {}): PdnSetup => ({ supply: b.vcc, ground: b.gnd, caps: [], source: null, ports: [1], fMin: 1e5, fMax: 1e9, ...o });
const at = (r: ReturnType<typeof analysePdn>, f: number) => { let k = 0; for (let i = 0; i < r.f.length; i++) if (Math.abs(Math.log(r.f[i]! / f)) < Math.abs(Math.log(r.f[k]! / f))) k = i; return { f: r.f[k]!, z: r.ports[0]!.z[k]! }; };

describe('complex banded equations', () => {
  it('a ladder of admittances solved: the answer put back gives the right-hand side', () => {
    const n = 40, band = 3, a = new CBand(n, band), ref: [number, number, number, number][] = [];
    const put = (i: number, j: number, re: number, im: number) => { a.admittance(i, j, re, im); ref.push([i, j, re, im]); };
    for (let i = 0; i < n; i++) { put(i, -1, 0.01, 0.2 + i * 0.01); if (i + 1 < n) put(i, i + 1, 0.5, -1.5); if (i + 3 < n) put(i, i + 3, 0.1, 0.4); }
    const bRe = Float64Array.from({ length: n }, (_, i) => Math.sin(i)), bIm = Float64Array.from({ length: n }, (_, i) => Math.cos(2 * i));
    const xRe = bRe.slice(), xIm = bIm.slice();
    expect(a.factor()).toBe(true);
    a.solve(xRe, xIm);
    // Kirchhoff at every node with the answer
    const rRe = new Float64Array(n), rIm = new Float64Array(n);
    for (const [i, j, re, im] of ref) {
      const vr = xRe[i]! - (j < 0 ? 0 : xRe[j]!), vi = xIm[i]! - (j < 0 ? 0 : xIm[j]!), cr = re * vr - im * vi, ci = re * vi + im * vr;
      rRe[i]! += cr; rIm[i]! += ci; if (j >= 0) { rRe[j]! -= cr; rIm[j]! -= ci; }
    }
    for (let i = 0; i < n; i++) { expect(rRe[i]).toBeCloseTo(bRe[i]!, 9); expect(rIm[i]).toBeCloseTo(bIm[i]!, 9); }
  });
});

describe('a supply\'s impedance (26.175)', () => {
  it('capacitances read from parts\' values; a ceramic\'s series resistance by its size', () => {
    expect(parseCapacitance('100nF')).toBeCloseTo(100e-9, 15);
    expect(parseCapacitance('0.1uF 16V X7R')).toBeCloseTo(100e-9, 15);
    expect(parseCapacitance('4u7')).toBeCloseTo(4.7e-6, 15);
    expect(parseCapacitance('10 µF')).toBeCloseTo(10e-6, 15);
    expect(parseCapacitance('22p')).toBeCloseTo(22e-12, 18);
    expect(parseCapacitance('1,5nF')).toBeCloseTo(1.5e-9, 16);
    expect(Number.isNaN(parseCapacitance('LDO 3V3'))).toBe(true);
    expect(Number.isNaN(parseCapacitance('X7R'))).toBe(true);
    expect(typicalEsr(100e-9)).toBeCloseTo(0.03, 9);
    expect(typicalEsr(10e-6)).toBeCloseTo(0.003, 9);
    expect(typicalEsr(1e-12)).toBe(1);
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), net = (n: string) => doc.nets.findIndex((x) => x.name === n);
    const caps = capsBetween(doc, net('VIN'), net('GND'));
    expect(caps.map((c) => c.designator)).toEqual(['C1']);
    expect(capsBetween(doc, net('+3V3'), net('GND')).map((c) => c.designator)).toEqual(['C2']);
    expect(caps[0]!.esl).toBe(1e-9);
  });

  it('with no copper area the supply is one node: a capacitor at its own resonance is its series resistance, and it rings with the source below that', () => {
    const b = board();
    const s = setupOf(b, { caps: [{ component: 0, designator: 'C1', c: 100e-9, esr: 0.03, esl: 1e-9 }], source: { component: 2, r: 0.01, l: 20e-9 }, fMin: 1e5, fMax: 1e8, perDecade: 200 });
    const m = buildPdn(b.doc, s);
    expect(m.plates).toBeNull(); expect(m.count).toBe(1); expect(m.why).toMatch(/copper area/);
    const r = analysePdn(b.doc, s, m);
    // 100 nF with 1 nH: 15.9 MHz
    const own = at(r, 1 / (2 * Math.PI * Math.sqrt(1e-9 * 100e-9)));
    expect(own.z).toBeGreaterThan(0.0295); expect(own.z).toBeLessThan(0.0315);
    // It rings with the source's 20 nH (and its own 1 nH) at 3.47 MHz
    const ring = 1 / (2 * Math.PI * Math.sqrt(21e-9 * 100e-9));
    expect(r.ports[0]!.peaks[0]!.f / ring).toBeGreaterThan(0.97); expect(r.ports[0]!.peaks[0]!.f / ring).toBeLessThan(1.03);
    // Far below, the source's own resistance
    const low = analysePdn(b.doc, { ...s, fMin: 10, fMax: 100 });
    expect(low.ports[0]!.z[0]).toBeCloseTo(0.01, 4);
    // A part with no pad on the supply is looked from nowhere
    expect(analysePdn(b.doc, { ...s, ports: [7] }).ports[0]!.z.every((z) => Number.isNaN(z))).toBe(true);
  });

  it('a supply plate over a ground plate: its capacitance, and its first resonance at the half wave along it', () => {
    const b = board();
    addPrimRecords(b.doc, [
      { storage: 'Fills6', rec: encodeFill({ layer: L.TOP, a: P(0, 0), b: P(50, 40), net: b.vcc }) },
      { storage: 'Fills6', rec: encodeFill({ layer: L.BOTTOM, a: P(-2, -2), b: P(52, 42), net: b.gnd }) },
    ]).apply();
    const s = setupOf(b, { fMin: 5e8, fMax: 3e9, perDecade: 100, tanD: 0.02 });
    const m = buildPdn(b.doc, s);
    expect(m.plates).not.toBeNull();
    expect([m.plates!.supplyLayer, m.plates!.groundLayer]).toEqual([0, 1]);
    const want = (8.8541878128e-12 * m.plates!.er * 0.05 * 0.04) / m.plates!.gap;
    expect(m.plates!.capacitance / want).toBeGreaterThan(0.96); expect(m.plates!.capacitance / want).toBeLessThan(1.04);
    expect(m.count).toBeGreaterThan(800); expect(m.count).toBeLessThan(1500);
    // At 1 MHz the plates are a capacitor
    const low = at(analysePdn(b.doc, { ...s, fMin: 1e6, fMax: 1.2e6, perDecade: 20 }, m), 1e6);
    expect((low.z * 2 * Math.PI * low.f * m.plates!.capacitance)).toBeGreaterThan(0.97);
    expect((low.z * 2 * Math.PI * low.f * m.plates!.capacitance)).toBeLessThan(1.03);
    // Looked at from a corner, the first peak is the half wave along the 50 mm side
    const r = analysePdn(b.doc, s, m);
    const f10 = 299_792_458 / (2 * 0.05 * Math.sqrt(m.plates!.er));
    const first = [...r.ports[0]!.peaks].sort((p, q) => p.f - q.f)[0]!;
    expect(first.f / f10).toBeGreaterThan(0.94); expect(first.f / f10).toBeLessThan(1.05);
    expect(r.firstMode / f10).toBeGreaterThan(0.9); expect(r.firstMode / f10).toBeLessThan(1.2);
    // A capacitor on the plate brings the impedance down where it works, and not above its own inductance
    const withCap = { ...s, caps: [{ component: 0, designator: 'C1', c: 100e-9, esr: 0.03, esl: 1e-9 }] }, mc = buildPdn(b.doc, withCap);
    expect(at(analysePdn(b.doc, { ...withCap, fMin: 1e6, fMax: 1.2e6, perDecade: 20 }, mc), 1e6).z).toBeLessThan(low.z / 20);
    expect(at(analysePdn(b.doc, { ...withCap, fMin: 2e9, fMax: 2.2e9, perDecade: 20 }, mc), 2e9).z / at(r, 2e9).z).toBeGreaterThan(0.5);
  }, 30000);

  it('the target and where the impedance is over it', () => {
    expect(targetImpedance(3.3, 0.05, 2)).toBeCloseTo(0.0825, 9);
    const b = board();
    const r = analysePdn(b.doc, setupOf(b, { caps: [{ component: 0, designator: 'C1', c: 100e-9, esr: 0.03, esl: 1e-9 }], source: { component: 2, r: 0.01, l: 20e-9 }, fMin: 1e3, fMax: 1e9 }));
    const bands = overTarget(r, 0, 0.1);
    // Over 0.1 Ω where it rings with the source, and again where the capacitor has become an inductor
    expect(bands.length).toBe(2);
    expect(bands[0]!.worst.f).toBeGreaterThan(2e6); expect(bands[0]!.worst.f).toBeLessThan(5e6);
    expect(bands[1]!.from).toBeGreaterThan(1e7); expect(bands[1]!.to).toBeCloseTo(1e9, -3);
    expect(overTarget(r, 0, 1e6)).toEqual([]);
    const f = frequencies(1e3, 1e6, 10);
    expect(f.length).toBe(31); expect(f[0]).toBeCloseTo(1e3, 6); expect(f[30]).toBeCloseTo(1e6, 3); expect(f[10]).toBeCloseTo(1e4, 3);
  });

  it('conducted emission: the limits, a pulse train\'s harmonics, and the level at the measuring network', () => {
    expect(cisprLimit(150e3, 'B')).toBeCloseTo(66, 9); expect(cisprLimit(499.9e3, 'B')).toBeCloseTo(56, 1);
    expect([cisprLimit(1e6, 'B'), cisprLimit(10e6, 'B'), cisprLimit(200e3, 'A'), cisprLimit(1e6, 'A'), cisprLimit(20e6, 'A')]).toEqual([56, 60, 79, 73, 73]);
    // A square wave between 0 and 1: its fundamental 2/π, no even harmonics, the third a third of the first
    expect(pulseHarmonic(1, 1, 0.5, 0, 1e5)).toBeCloseTo(2 / Math.PI, 9);
    expect(pulseHarmonic(2, 1, 0.5, 0, 1e5)).toBeCloseTo(0, 9);
    expect(pulseHarmonic(3, 1, 0.5, 0, 1e5)).toBeCloseTo(2 / (3 * Math.PI), 9);
    // Slower edges take the high harmonics down
    expect(pulseHarmonic(51, 1, 0.5, 50e-9, 3e5)).toBeLessThan(pulseHarmonic(51, 1, 0.5, 1e-9, 3e5) * 0.7);
    const b = board(), s = setupOf(b, { source: { component: 2, r: 0.01, l: 20e-9 } });
    const bare = conducted(b.doc, s, { component: 1, frequency: 300e3, amplitude: 1, duty: 0.5, rise: 0 })!;
    // With nothing but the network to take it: 0.637 A through twice 50 Ω beside 50 µH, half of it measured, as rms
    const x = 2 * Math.PI * 300e3 * 50e-6, each = (50 * x) / Math.hypot(50, x);
    expect(bare.f[0]).toBe(300e3);
    expect(bare.level[0]).toBeCloseTo(20 * Math.log10(((2 / Math.PI) * each) / Math.SQRT2 / 1e-6), 2);
    expect(bare.f[bare.f.length - 1]).toBeLessThanOrEqual(30e6);
    expect(bare.margin).toBeLessThan(-50);
    // An input capacitor takes it down, most where the capacitor is best
    const capped = conducted(b.doc, { ...s, caps: [{ component: 0, designator: 'C1', c: 10e-6, esr: 0.005, esl: 1e-9 }] }, { component: 1, frequency: 300e3, amplitude: 1, duty: 0.5, rise: 0 })!;
    expect(capped.level[0]).toBeLessThan(bare.level[0]! - 40);
    expect(capped.margin).toBeGreaterThan(bare.margin + 20);
    expect(conducted(b.doc, s, { component: 9, frequency: 300e3, amplitude: 1, duty: 0.5, rise: 0 })).toBeNull();
  });
});

describe('the Supply Impedance panel\'s part (26.175)', () => {
  const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

  it('the form starts from the supply of Power Analysis; capacitors as read or as typed; the places to look from', () => {
    const doc = demo(), f = readPdnForm(doc, 'Demo.PcbDoc');
    expect([f.supply, f.ground, f.source]).toEqual(['VIN', 'GND', 'J1']);
    // The demo's capacitor says nothing of its value: left out until one is typed
    expect(formCaps(doc, f).map((c) => [c.designator, c.known])).toEqual([['C1', false]]);
    const typed = formCaps(doc, { ...f, caps: { C1: { c: '10u', esr: '8' } } })[0]!;
    expect(typed.known).toBe(true); expect(typed.c).toBeCloseTo(10e-6, 12); expect(typed.esr).toBeCloseTo(0.008, 9); expect(typed.esl).toBe(1e-9);
    // A bare number is microfarads
    expect(formCaps(doc, { ...f, caps: { C1: { c: '4.7' } } })[0]!.c).toBeCloseTo(4.7e-6, 12);
    expect(formCaps(doc, { ...f, caps: { C1: { c: '100n', esl: '0.6' } } })[0]).toMatchObject({ esl: 0.6e-9 });
    expect(formPorts(doc, f).map((p) => p.designator)).toEqual(['U1']);
    const s = formPdn(doc, { ...f, caps: { C1: { c: '10u' } } }) as PdnSetup;
    expect(s.caps.map((c) => c.designator)).toEqual(['C1']);
    expect(s.source).toMatchObject({ r: 0.005, l: 20e-9 });
    expect([s.fMin, s.fMax]).toEqual([1e4, 2e9]);
    expect(formPdn(doc, { ...f, supply: '' })).toBe('Pick the supply net.');
    expect(formPdn(doc, { ...f, ground: 'VIN' })).toBe('Pick the ground net.');
    expect(formPdn(doc, { ...f, from: '5000', to: '100' })).toBe('Give a range of frequencies.');
    expect(formTarget({ ...f, voltage: '5', ripple: '5', step: '1' })).toBeCloseTo(0.25, 9);
    expect(formNoise(doc, f)).toBeNull();
    expect(formNoise(doc, { ...f, noisePart: 'U1', noiseF: '400', noiseI: '2', noiseDuty: '30', noiseRise: '20' })).toEqual({ component: doc.components.findIndex((c) => c.designator === 'U1'), frequency: 400e3, amplitude: 2, duty: 0.3, rise: 20e-9 });
  });

  it('figures with their units, the verdict against a target, the report', () => {
    expect([hertz(150e3), hertz(1.37e9), hertz(31e6), hertz(500), hertz(2e9)]).toEqual(['150 kHz', '1.37 GHz', '31 MHz', '500 Hz', '2 GHz']);
    expect([ohms(0.0825), ohms(4.2), ohms(0.25), ohms(120)]).toEqual(['82.5 mΩ', '4.20 Ω', '250 mΩ', '120 Ω']);
    expect([farads(100e-9), farads(4.7e-6), farads(22e-12)]).toEqual(['100 nF', '4.7 µF', '22 pF']);
    const doc = demo(), f = { ...readPdnForm(doc, 'Demo.PcbDoc'), caps: { C1: { c: '10u' } }, voltage: '5' };
    const s = formPdn(doc, f) as PdnSetup, r = analysePdn(doc, s);
    expect(verdict(r, 0, 1e6)).toBe('Under the target of 1000000 Ω from 10 kHz to 2 GHz.');
    expect(verdict(r, 0, 0.25)).toMatch(/^Over the target of 250 mΩ from \d+(\.\d+)? MHz to 2 GHz; the worst \d+(\.\d+)? Ω at 2 GHz\.$/);
    const noise = conducted(doc, s, { component: s.ports[0]!, frequency: 500e3, amplitude: 1, duty: 0.5, rise: 10e-9 }, r.model);
    const text = pdnReport(doc, r, 'Demo.PcbDoc', 0.25, () => 'Top Layer', noise);
    expect(text.split('\n')[0]).toBe('Supply Impedance: Demo.PcbDoc');
    expect(text).toMatch(/Supply net {6}VIN/);
    expect(text).toMatch(/C1 {9}10 µF {6}3\.00 mΩ {4}1\.0 nH {3}1\.59 MHz/);
    expect(text).toMatch(/Looked at from U1: Over the target of 250 mΩ/);
    expect(text).toMatch(/Conducted emission, differential mode \(estimated\): \d+\.\d dB (under|over) the Class B limit at /);
    expect(text).not.toMatch(/NaN|undefined/);
  });
});
