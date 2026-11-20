import { describe, expect, it } from 'vitest';
import { readNetlist } from '../src/sim/netlist';
import { Simulator, type Plot } from '../src/sim/engine';
import { evalWave, waveSignals } from '../src/sim/waveExpr';
import { cursorStats, fftPlot, moveCursor, waveMeasures } from '../src/sim/measure';
import { readSimData, writeSimData, type SimDataDocument } from '../src/sim/simData';
import { DEFAULT_TEMPLATES, expandTemplate, simModelAt, simModelBags, simModelOf } from '../src/model/simModels';
import { builtinModel } from '../src/sim/library';
import { MODEL_KINDS } from '../src/model/simKinds';
import { SR } from '../src/model/sch';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { PropertyBag } from '../src/formats/altium/props';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { binToBytes } from '../src/formats/text';
import { chartCsv, plotFromCsv } from '../src/app/simView';

const runOf = (text: string) => new Simulator(readNetlist(text)).run();
const [tran, ac] = runOf(`*
V1 in 0 SIN(0 1 1k) AC 1
R1 in out 1k
C1 out 0 100n
V2 p 0 PULSE(0 5 0.1m 1u 1u 0.4m 1m)
R2 p 3V3-dig 1k
R3 3V3-dig 0 1k
.TRAN 5u 5m
.AC DEC 10 10 100k
.END`) as [Plot, Plot];
const y = (p: Plot, n: string) => p.vectors.find((v) => v.name === n)!.re;

describe('SimView: wave expressions', () => {
  it('combines signals point by point; names as they are (3V3-dig, R1[i], V1#branch); complex on an AC chart', () => {
    const d = evalWave('OUT-IN', tran);
    expect(d.re[200]).toBeCloseTo(y(tran, 'out')[200]! - y(tran, 'in')[200]!, 12);
    expect(evalWave('3V3-dig*2', tran).re[400]).toBeCloseTo(y(tran, '3V3-dig')[400]! * 2, 12);
    expect(evalWave('R1[i]*1k', tran).re[300]).toBeCloseTo(y(tran, 'R1[i]')[300]! * 1000, 9);
    expect(waveSignals('V(3V3-dig)/I(V2)', tran.vectors.map((v) => v.name))).toEqual(['3V3-dig']);
    // RC low pass (1.59 kHz): DB and PHASE of the complex ratio as its equation gives them
    const db = evalWave('DB(V(out)/V(in))', ac), ph = evalWave('PHASE(out)', ac), f = ac.x!.values;
    const k = f.findIndex((x) => x >= 1591);
    expect(db.im).toBeNull();
    const r = f[k]! * 2 * Math.PI * 1e3 * 100e-9;
    expect(db.re[k]).toBeCloseTo(-10 * Math.log10(1 + r * r), 3);
    expect(ph.re[k]).toBeCloseTo((-Math.atan(r) * 180) / Math.PI, 2);
    expect(evalWave('RMS(in)', tran).re.at(-1)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(evalWave('AVG(p)', tran).re.at(-1)).toBeCloseTo(2, 1);
    expect(() => evalWave('NOSUCH+1', tran)).toThrow(/no signal/);
  });
});

describe('SimView: cursors and measurements', () => {
  it('Measurement Cursors and Waveform Measurements as the Sim Data panel shows them', () => {
    const xs = tran.x!.values;
    const s = cursorStats(xs, y(tran, 'in'), 1e-3, 3e-3);
    expect(s.dx).toBeCloseTo(2e-3, 12);
    expect(s.rms).toBeCloseTo(Math.SQRT1_2, 3);
    expect(s.freq).toBeCloseTo(1000, 0);
    expect(s.max).toBeCloseTo(1, 3);
    const m = waveMeasures(xs, y(tran, 'p'));
    expect([m.base, m.top, m.min, m.max].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 5, 0, 5]);
    expect(m.rise).toBeCloseTo(0.8e-6, 7);
    expect(m.fall).toBeCloseTo(0.8e-6, 7);
    expect(moveCursor(xs, y(tran, 'in'), 0, 'max')).toBeCloseTo(0.25e-3, 4);
    expect(moveCursor(xs, y(tran, 'in'), 1e-3, 'peakRight')).toBeCloseTo(1.25e-3, 4);
    expect(moveCursor(xs, y(tran, 'in'), 3e-3, 'troughLeft')).toBeCloseTo(2.75e-3, 4);
  });
  it('Create FFT Chart: the spectrum of a transient wave, the sine at its frequency and amplitude', () => {
    const f = fftPlot(tran, ['in', 'p'], [1e-3, 5e-3]);
    expect(f.complex).toBe(true);
    const v = f.vectors[0]!;
    let k = 0;
    for (let i = 0; i < v.re.length; i++) if (Math.hypot(v.re[i]!, v.im![i]!) > Math.hypot(v.re[k]!, v.im![k]!)) k = i;
    expect(f.x!.values[k]).toBeCloseTo(1000, 3);
    expect(Math.hypot(v.re[k]!, v.im![k]!)).toBeCloseTo(1, 2);
  });
});

describe('SimView: charts in the results file, export and import', () => {
  it('charts (plots of waves, colours), stored waves and the chart in front survive the .sdf; 26.059 files open with a plot per wave', () => {
    const d: SimDataDocument = { kind: 'SimData', name: 'R.sdf', title: 'R', date: 'd', plots: [tran, ac], messages: [], active: 1, dirty: false,
      charts: [{ title: 'Transient Analysis', source: 0, plots: [[{ expr: 'in' }, { expr: 'out', colour: '#1f9a4e' }], [{ expr: 'OUT-IN' }]] }, { title: 'Bode', source: 1, plots: [[{ expr: 'DB(out)' }]] }],
      stored: [{ name: 'out (stored 1)', analysis: 'tran', x: [0, 1], re: [0, 1], unit: 'V' }] };
    const back = readSimData(writeSimData(d), 'R.sdf');
    expect([back.charts, back.stored, back.active]).toEqual([d.charts, d.stored, 1]);
    const old = writeSimData(d).replace(/"charts":\[.*?\]\]\}\],/, '').replace('"analysis":"tran"', '"analysis":"tran","shown":["in","out"]');
    expect(readSimData(old, 'R.sdf').charts[0]).toEqual({ title: 'Transient Analysis', source: 0, plots: [[{ expr: 'in' }], [{ expr: 'out' }]] });
  });
  it('File › Export (CSV) and Import read each other', () => {
    const d: SimDataDocument = { kind: 'SimData', name: 'R.sdf', title: 'R', date: 'd', plots: [tran], messages: [], active: 0, dirty: false,
      charts: [{ title: 'Transient Analysis', source: 0, plots: [[{ expr: 'in' }], [{ expr: 'OUT-IN' }]] }] };
    const csv = chartCsv(d, 0);
    expect(csv.split('\r\n')[0]).toBe('time,in,OUT-IN');
    const p = plotFromCsv(csv, 'Imported');
    expect([p.analysis, p.vectors.map((v) => v.name), p.x!.values.length]).toEqual(['tran', ['in', 'OUT-IN'], tran.x!.values.length]);
    expect(p.vectors[1]!.re[100]).toBeCloseTo(y(tran, 'out')[100]! - y(tran, 'in')[100]!, 12);
  });
});

describe('Sim Model: a part\'s SIM model written as AD keeps it', () => {
  it('the records read back (kind, sub-kind, prefix, template, file, parameters in order, port map); every sub-kind has a template', () => {
    const b = new SchBuilder();
    b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial' });
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'D', CURRENTPARTID: 1, PARTCOUNT: 2, OWNERPARTID: -1 }, { LOCATION: { x: 100, y: 100 } });
    const list = b.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci });
    const bags = simModelBags(list, b.bags.length - 1, { name: '1N4148', description: 'Signal diode', kind: 'General', subKind: 'Diode', prefix: 'D', netlist: MODEL_KINDS.General!.find((s) => s.name === 'Diode')!.template, current: true,
      file: { entity: '1N4148', kind: 'MDL' }, params: [['Area', ''], ['Temperature', '27']], portMap: [['1', 'A'], ['2', 'K']] });
    for (const x of bags) b.bags.push(x);
    b.bags[0]!.setRaw('WEIGHT', String(b.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', b.bytes());
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const doc = readSchDoc(writeCfb(root), 'T.SchDoc');
    const m = simModelOf(doc, ci)!;
    expect([m.name, m.kind, m.subKind, m.prefix, m.fileKind, m.fileName, m.description, m.names, [...m.portMap]]).toEqual(
      ['1N4148', 'General', 'Diode', 'D', 'MDL', '1N4148', 'Signal diode', ['Area', 'Temperature'], [['1', 'A'], ['2', 'K']]]);
    expect(m.params.get('TEMPERATURE')).toBe('27');
    expect(simModelAt(doc, doc.objects.find((o) => o.record === SR.IMPLEMENTATION)!.index)!.netlist).toContain('@DESIGNATOR %1 %2 @MODEL');
    expect(PropertyBag).toBeDefined();
    for (const [kind, subs] of Object.entries(MODEL_KINDS)) for (const s of subs) expect(s.template, `${kind}/${s.name}`).toMatch(/@DESIGNATOR|%1/);
  });
});

describe('Initial conditions and more built-in models', () => {
  it('.IC from its part sets a node at the start of a transient (Use Initial Conditions); .NS guesses', () => {
    const line = expandTemplate(DEFAULT_TEMPLATES['set initial condition']!, { designator: 'IC1', model: '.IC', net: () => 'OUT', param: (n) => (n === 'INITIAL VOLTAGE' ? '2' : undefined) }).line;
    expect(line).toBe('.IC V(OUT)=2');
    expect(expandTemplate(DEFAULT_TEMPLATES['initial node voltage guess']!, { designator: 'NS1', model: '.NS', net: () => 'A', param: () => '1' }).line).toBe('.NODESET V(A)=1');
    const [tr] = runOf(`*\nR1 OUT 0 1k\nC1 OUT 0 1u\n${line}\n.TRAN 10u 3m UIC\n.END`) as [Plot];
    const v = tr.vectors.find((x) => x.name === 'OUT')!.re, t = tr.x!.values;
    expect(v[0]).toBeCloseTo(2, 6);
    const k = t.findIndex((x) => x >= 1e-3);
    expect(v[k]! / (2 * Math.exp(-t[k]! / 1e-3))).toBeCloseTo(1, 2);
  });
  it('the new models read and switch as their datasheets say', () => {
    for (const m of ['2N2222A', 'BC557B', 'BAT54', 'IRF540']) expect(readNetlist(`*\n${builtinModel(m)!.text}\n.END`).errors, m).toEqual([]);
    const [op] = runOf(`*\nV1 d 0 12\nR1 d dr 1\nV2 g 0 10\nM1 dr g 0 0 IRF540\nV3 a 0 5\nR3 a k 470\nD1 k 0 BAT54\n.OP\n${builtinModel('IRF540')!.text}\n${builtinModel('BAT54')!.text}\n.END`) as [Plot];
    const at = (n: string) => op.vectors.find((x) => x.name === n)!.re[0]!;
    expect(at('dr')).toBeLessThan(0.6);
    expect(at('k')).toBeGreaterThan(0.2); expect(at('k')).toBeLessThan(0.45);
  });
});
