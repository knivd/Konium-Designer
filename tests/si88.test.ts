import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PropertyBag } from '../src/formats/altium/props';
import { RULE_KIND_IDS, kindCategory, kindLabel, newRule, ruleDescription, ruleKind } from '../src/formats/altium/rules';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack } from '../src/model/pcb';
import { runDrc, CHECKED_KINDS } from '../src/model/drc';
import { siBoardRules } from '../src/model/drcMore';
import { addNode, newCircuit, transient } from '../src/si/circuit';
import { readIbis, ibisToIc, modelLine, parseModelLine, technology } from '../src/si/models';
import { DEFAULT_STIMULUS, SI_CHECKED, failures, siNum, siShow, siText, stimulusOf, stimulusProps } from '../src/si/rules';
import { runEdge, runStimulus, termValues } from '../src/si/screen';
import { boardNetwork, starNetwork, supplyVoltage, typeByDesignator, type SiContext } from '../src/si/topology';
import { screenNet, setSiProvider, defaultSiContext } from '../src/si/analyse';
import { coupledNets, couplings, crosstalkWaves } from '../src/si/crosstalk';
import { readSection, writeSection, defaultSiSetup } from '../src/app/siProject';
import { readPrjPcb } from '../src/formats/altium/prjpcb';

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });
const src = (storage: string) => ({ storage, index: -1 });
const track = (a: [number, number], b: [number, number], net: number, width = 0.2): PcbTrack => ({ kind: 'track', src: src('Tracks6'), layer: L.TOP, a: P(...a), b: P(...b), width: mm(width), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
const stack = (w: number) => ({ w: mm(w), h: mm(w), shape: 'round' as const, cornerPct: 0 });
const pad = (at: [number, number], net: number, component: number, name: string): PcbPad => ({ kind: 'pad', src: src('Pads6'), name, layer: L.TOP, at: P(...at), rotation: 0, top: stack(0.6), mid: stack(0.6), bot: stack(0.6), hole: 0, plated: true, net, component, locked: false });

/** The demo board with a clock line: U10 pin 1 driving U11 pin 1 over 150 mm, and a data line beside it (U10-2 → U11-2). */
function siBoard(): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const net = (name: string) => { const index = doc.nets.length; doc.nets = [...doc.nets, { index, name, bag: PropertyBag.from({ NAME: name }) }]; return index; };
  const comp = (designator: string) => { const index = doc.components.length + 100; doc.components = [...doc.components, { index, designator, pattern: 'SOIC8', at: P(0, 0), rotation: 0, layer: L.TOP, bag: PropertyBag.from({}), nameOn: true, commentOn: false }]; return index; };
  const clk = net('CLK'), dat = net('DATA');
  const u10 = comp('U10'), u11 = comp('U11');
  const prims: PcbPrim[] = [
    pad([0, 0], clk, u10, '1'), pad([150, 0], clk, u11, '1'), track([0, 0], [150, 0], clk),
    pad([0, 0.5], dat, u10, '2'), pad([150, 0.5], dat, u11, '2'), track([0, 0.5], [150, 0.5], dat),
  ];
  doc.prims = [...doc.prims, ...prims];
  return doc;
}
const ctx = (): SiContext => ({ ...defaultSiContext(), pinTypes: new Map([['U10-1', 2], ['U11-1', 0], ['U10-2', 2], ['U11-2', 0]]) });
const netIndex = (doc: PcbDocument, name: string) => doc.nets.findIndex((n) => n.name === name);

describe('Signal Integrity: the circuit', () => {
  it('a line matched at its driver steps to half, then the full level at the open end, and stays', () => {
    const c = newCircuit();
    const a = addNode(c, 'a'), b = addNode(c, 'b');
    c.srcs.push({ a, r: 50, v: (t) => (t > 1e-9 ? 3.3 : 0) });
    c.tls.push({ a, b, z: 50, td: 2e-9 });
    c.res.push({ a: b, b: 0, r: 1e6 });
    const r = transient(c, { dt: 20e-12, tEnd: 12e-9, probe: [a, b] });
    const at = (k: number, t: number) => r.v[k]![r.t.findIndex((x) => x >= t)]!;
    expect(at(0, 2e-9)).toBeCloseTo(1.65, 1);
    expect(at(1, 2.5e-9)).toBeCloseTo(0, 1);
    expect(at(1, 4e-9)).toBeCloseTo(3.3, 1);
    expect(at(0, 6e-9)).toBeCloseTo(3.3, 1);
  });
  it('a low driver on an open line rings: more than half the step again', () => {
    const c = newCircuit();
    const a = addNode(c, 'a'), b = addNode(c, 'b');
    c.srcs.push({ a, r: 25, v: (t) => (t > 1e-9 ? 3.3 : 0) });
    c.tls.push({ a, b, z: 50, td: 2e-9 });
    const r = transient(c, { dt: 20e-12, tEnd: 30e-9, probe: [b] });
    expect(Math.max(...r.v[0]!)).toBeGreaterThan(4.3);
    expect(r.v[0]![r.v[0]!.length - 1]).toBeCloseTo(3.3, 1);
  });
  it('a driver switching between its pull-up and pull-down resistances', () => {
    const c = newCircuit();
    const a = addNode(c, 'a');
    c.srcs.push({ a, r: 10, v: (t) => (t > 1e-9 ? 1 : 0), rt: (t) => (t > 1e-9 ? 10 : 1000) });
    c.res.push({ a, b: 0, r: 10 });
    const r = transient(c, { dt: 10e-12, tEnd: 3e-9, probe: [a] });
    expect(r.v[0]![r.v[0]!.length - 1]).toBeCloseTo(0.5, 2);
  });
});

describe('Signal Integrity: rules', () => {
  it('values as AD writes them', () => {
    expect(siNum(' 4.000')).toBe(4);
    expect(siNum('-1.000')).toBe(-1);
    expect(siNum(' 1.000n')).toBeCloseTo(1e-9, 15);
    expect(siNum(' 10.00K')).toBe(10_000);
    expect(siNum('2meg')).toBe(2e6);
    expect(siNum('5m')).toBeCloseTo(0.005, 9);
    expect(siText(32)).toBe(' 32.00');
    expect(siText(4)).toBe(' 4.000');
    expect(siText(1e-9)).toBe(' 1.000n');
    expect(siText(10_000)).toBe(' 10.00K');
    expect(siText(-1)).toBe('-1.000');
    expect(siShow(0.42, 'V')).toBe('420.0 mV');
    expect(siShow(3.3, 'V')).toBe('3.300 V');
    expect(siShow(1.25e-9, 's')).toBe('1.250 ns');
  });
  it('the kinds: numbers, tree, DRC', () => {
    expect(RULE_KIND_IDS.OvershootFalling).toBe(29);
    expect(RULE_KIND_IDS.SupplyNets).toBe(41);
    expect(kindLabel('OvershootRising')).toBe('Overshoot - Rising Edge');
    expect(kindLabel('MaxMinImpedance')).toBe('Impedance');
    expect(kindCategory('FlightTimeFalling')).toBe('Signal Integrity');
    for (const k of SI_CHECKED) expect(CHECKED_KINDS).toContain(k);
    const r = newRule('OvershootRising', 'OvershootRising', 1);
    expect(r.bag.get('MAXIMUM')).toBe(' 1.000');
    expect(ruleDescription(r)).toBe('Overshoot - Rising Edge Constraint (Max=1.000V) (All)');
    const z = newRule('MaxMinImpedance', 'Impedance', 1);
    expect(ruleDescription(z)).toBe('Impedance Constraint (Min=1.000Ω) (Max=10.00KΩ) (All)');
  });
  it('the stimulus: read, written', () => {
    const s = newRule('SignalStimulus', 'SignalStimulus', 1);
    expect(stimulusOf((k) => s.bag.get(k))).toEqual(DEFAULT_STIMULUS);
    const p = stimulusProps({ kind: 'Periodic Pulse', startHigh: true, start: 5e-9, stop: 20e-9, period: 40e-9 });
    expect(stimulusOf((k) => p[k])).toEqual({ kind: 'Periodic Pulse', startHigh: true, start: 5e-9, stop: 20e-9, period: 40e-9 });
  });
  it('failures against limits', () => {
    const m = { overshoot: 1.2, undershoot: 0.3, level: 3.3, flight: 1e-9, slope: 0.5e-9 };
    const f = failures({ rising: m, falling: { ...m, level: 0 }, zMin: 48, zMax: 52 }, { overshootRising: 1, undershootRising: 0.5, zMin: 50, flightRising: 2e-9 });
    expect(f.map((x) => x.kind)).toEqual(['OvershootRising', 'MaxMinImpedance']);
    expect(f[0]!.text).toBe('Rising edge overshoot 1.200 V > 1.000 V');
  });
});

describe('Signal Integrity: models and topology', () => {
  it('supplies by name; parts by designator', () => {
    const s = defaultSiContext().setup;
    expect(supplyVoltage('+3V3', s)).toBe(3.3);
    expect(supplyVoltage('5V', s)).toBe(5);
    expect(supplyVoltage('GND', s)).toBe(0);
    expect(supplyVoltage('VDDIO', s)).toBe(3.3);
    expect(supplyVoltage('CLK', s)).toBeNull();
    expect(typeByDesignator('R12')).toBe('Resistor');
    expect(typeByDesignator('U3')).toBe('IC');
    expect(typeByDesignator('J1')).toBe('Connector');
    expect(typeByDesignator('TP1')).toBe('None');
  });
  it('a model kept as a line', () => {
    const m = technology('CMOS-5V');
    expect(parseModelLine(modelLine(m))).toMatchObject({ name: 'CMOS-5V', vcc: 5, rup: 30, rdown: 25 });
    expect(parseModelLine('LVTTL')?.name).toBe('LVTTL');
  });
  it('an IBIS file read and summed up', () => {
    const ibs = `[IBIS Ver] 3.2
[Component] TEST
[Pin] signal_name model_name
1 OUT buf
[Model] buf
Model_type Output
C_comp 2pF 1pF 3pF
Vinl = 0.8V
Vinh = 2.0V
[Voltage Range] 3.3V 3.0V 3.6V
[Pulldown]
-1.0 -0.05 -0.04 -0.06
0.0 0.0 0.0 0.0
1.0 0.05 0.04 0.06
[Pullup]
-1.0 0.05 0.04 0.06
0.0 0.0 0.0 0.0
1.0 -0.05 -0.04 -0.06
[Ramp]
dV/dt_r 1.98/1.0n 1.8/1.2n 2.1/0.8n
dV/dt_f 1.98/1.2n 1.8/1.4n 2.1/1.0n
[End]
`;
    const f = readIbis(ibs, 'test.ibs');
    const m = f.models.get('buf')!;
    expect(m.cComp).toBeCloseTo(2e-12, 15);
    const ic = ibisToIc(m, 'test.ibs: buf');
    expect(ic.rdown).toBeCloseTo(20, 0);
    expect(ic.rup).toBeCloseTo(20, 0);
    expect(ic.tr).toBeCloseTo((1e-9 * 0.8) / 0.6, 12);
    expect(ic.vcc).toBe(3.3);
  });
  it('a board net: its driver, receiver, length and line', () => {
    const doc = siBoard();
    const nw = boardNetwork(doc, netIndex(doc, 'CLK'), ctx());
    if (typeof nw === 'string') throw new Error(nw);
    expect(nw.driver.designator).toBe('U10');
    expect(nw.receivers.map((r) => `${r.designator}-${r.pin}`)).toEqual(['U11-1']);
    expect(nw.length / mm(1)).toBeCloseTo(150, 0);
    expect(nw.estimated).toBe(false);
    // Supplies and lone pins aren't analysed
    expect(boardNetwork(doc, netIndex(doc, 'GND'), ctx())).toBe('a supply net');
  });
  it('a schematic net: a star of the setup\'s average lines', () => {
    const nw = starNetwork('A', [{ designator: 'U1', pin: '3' }, { designator: 'U2', pin: '4' }, { designator: 'U3', pin: '5' }], { ...defaultSiContext(), pinTypes: new Map([['U1-3', 2], ['U2-4', 0], ['U3-5', 0]]) });
    if (typeof nw === 'string') throw new Error(nw);
    expect(nw.driver.designator).toBe('U1');
    expect(nw.receivers).toHaveLength(2);
    expect(nw.estimated).toBe(true);
    expect(starNetwork('B', [{ designator: 'U1', pin: '3' }], defaultSiContext())).toBe('no receiver on it');
  });
});

describe('Signal Integrity: screening', () => {
  it('an unterminated long line rings; a series resistor tames it', () => {
    const doc = siBoard();
    const nw = boardNetwork(doc, netIndex(doc, 'CLK'), ctx());
    if (typeof nw === 'string') throw new Error(nw);
    const bare = runEdge(nw, 'rising');
    expect(bare.worst.overshoot).toBeGreaterThan(0.5);
    expect(bare.worst.level).toBeCloseTo(3.3, 1);
    expect(bare.worst.flight).toBeGreaterThan(0.5e-9);
    const sv = termValues(nw, 'series');
    expect(sv.r).toBeGreaterThan(10);
    const series = runEdge(nw, 'rising', 'series');
    expect(series.worst.overshoot).toBeLessThan(bare.worst.overshoot / 2);
    const fall = runEdge(nw, 'falling');
    expect(fall.worst.level).toBeCloseTo(0, 1);
    const res = screenNet('CLK', nw, { overshootRising: 0.3 });
    expect(res.status).toBe('Failed');
    expect(screenNet('X', 'no receiver on it', {})).toMatchObject({ status: 'Not analysed', reason: 'no receiver on it' });
  });
  it('the stimulus: a pulse up and back down', () => {
    const doc = siBoard();
    const nw = boardNetwork(doc, netIndex(doc, 'CLK'), ctx());
    if (typeof nw === 'string') throw new Error(nw);
    const w = runStimulus(nw, DEFAULT_STIMULUS, 'series');
    const at = (t: number) => w.v[1]![w.t.findIndex((x) => x >= t)]!;
    expect(at(5e-9)).toBeCloseTo(0, 1);
    expect(at(50e-9)).toBeCloseTo(3.3, 1);
    expect(at(95e-9)).toBeCloseTo(0, 1);
    expect(w.names).toEqual(['U10-1', 'U11-1']);
  });
});

describe('Signal Integrity: crosstalk', () => {
  it('two tracks side by side: coupled along their run', () => {
    const doc = siBoard();
    const clk = netIndex(doc, 'CLK'), dat = netIndex(doc, 'DATA');
    const c = couplings(doc, clk, [dat]);
    expect(c).toHaveLength(1);
    expect(c[0]!.length / mm(1)).toBeCloseTo(150, 0);
    expect(c[0]!.kb).toBeGreaterThan(0.01);
    expect(c[0]!.kf).toBeLessThan(0);
    expect(coupledNets(doc, clk)[0]!.net).toBe(dat);
    // A step through it: backward noise Kb × step while the edge travels, forward a pulse
    const t = Float64Array.from({ length: 2000 }, (_, i) => i * 10e-12);
    const v = Float64Array.from(t, (x) => (x < 2e-9 ? 0 : x > 3e-9 ? 3.3 : (x - 2e-9) * 3.3e9));
    const x = crosstalkWaves(t, v, c);
    expect(Math.max(...x.near)).toBeCloseTo(c[0]!.kb * 3.3, 2);
    expect(Math.min(...x.far)).toBeLessThan(0);
  });
});

describe('Signal Integrity: DRC and the project', () => {
  it('Overshoot rules checked by DRC: the nets they take', () => {
    const doc = siBoard();
    const r = newRule('OvershootRising', 'OvershootRising', 1);
    r.bag.set('MAXIMUM', ' 0.300');
    r.bag.set('SCOPE1EXPRESSION', "InNet('CLK')");
    doc.rules = [...doc.rules, r];
    setSiProvider(() => ({ ctx: ctx(), tolerances: {}, stimulus: DEFAULT_STIMULUS }));
    const rep = runDrc(doc, new Set(['OvershootRising']));
    const v = rep.violations.filter((x) => x.kind === 'OvershootRising');
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Overshoot - Rising Edge Constraint \(Max=300\.0mV\) \(InNet\('CLK'\)\): Net CLK Rising edge overshoot [\d.]+ mV > 300\.0 mV$/);
    expect(rep.notes.some((n) => /Signal Integrity: 1 net screened/.test(n))).toBe(true);
    // Supply Nets rules: a net's voltage
    const s = newRule('SupplyNets', 'SupplyNets', 1);
    s.bag.set('VOLTAGE', ' 1.800'); s.bag.set('SCOPE1EXPRESSION', "InNet('DATA')");
    doc.rules = [...doc.rules, s];
    expect(siBoardRules(doc).supplies.get('DATA')).toBe(1.8);
    expect(ruleKind(s)).toBe('SupplyNets');
  });
  it('the setup kept in the project file', () => {
    const prj = readPrjPcb(new TextEncoder().encode('[Design]\r\nVersion=1.0\r\n'), 'T.PrjPcb');
    const s = defaultSiSetup();
    s.trackZ = 55; s.tech = 'CMOS-2.5V'; s.supplies = [['VREF', 1.2]];
    s.models.set('U1', technology('LVTTL')); s.types.set('J3', 'Connector');
    s.tolerances = { overshootRising: 0.5, flightRising: 2e-9 };
    s.stimulus = { kind: 'Periodic Pulse', startHigh: false, start: 5e-9, stop: 25e-9, period: 50e-9 };
    s.terms.set('series', { on: true, values: { r: 33 } });
    writeSection(prj, s);
    const back = readSection(prj);
    expect(back.trackZ).toBe(55);
    expect(back.tech).toBe('CMOS-2.5V');
    expect(back.supplies).toEqual([['VREF', 1.2]]);
    expect(back.models.get('U1')?.name).toBe('LVTTL');
    expect(back.types.get('J3')).toBe('Connector');
    expect(back.tolerances.overshootRising).toBe(0.5);
    expect(back.tolerances.flightRising).toBeCloseTo(2e-9, 15);
    expect(back.stimulus).toEqual(s.stimulus);
    expect(back.terms.get('series')).toEqual({ on: true, values: { r: 33 } });
  });
});
