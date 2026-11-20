import { describe, expect, it } from 'vitest';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPrjPcb, writePrjPcb } from '../src/formats/altium/prjpcb';
import { compileProject } from '../src/model/compile';
import { SR } from '../src/model/sch';
import { partRecords } from '../src/model/schPlace';
import { DEFAULT_TEMPLATES, expandTemplate, setSimParam, simModelOf } from '../src/model/simModels';
import { projectNetlist } from '../src/sim/adNetlist';
import { BUILTIN_MODELS, builtinModel } from '../src/sim/library';
import { readNetlist } from '../src/sim/netlist';
import { Simulator, type Plot } from '../src/sim/engine';
import { acTotalPoints, analysisCards, defaultSettings, parseSettingsItem, readSimSettings, settingsItem, transientWindow, writeSimSettings } from '../src/sim/settings';
import { readSimData, writeSimData, type SimDataDocument } from '../src/sim/simData';
import { readSimText, writeSimText } from '../src/sim/simText';
import { detect, load } from '../src/formats/registry';
import { SIM_DEMO, simDemoFiles } from '../src/formats/synthetic/simDemo';
import { simPartSymbols, simSourceSymbols } from '../src/formats/synthetic/simLib';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { binToBytes } from '../src/formats/text';

const vec = (p: Plot, name: string) => p.vectors.find((v) => v.name.toLowerCase() === name.toLowerCase())!;
const run = (text: string) => { const s = new Simulator(readNetlist(text)); const plots = s.run(); return { plots, msgs: s.messages }; };

function demo() {
  const files = simDemoFiles();
  const prj = readPrjPcb(files.find((f) => f.name === SIM_DEMO.project)!.bytes, SIM_DEMO.project);
  const sheet = files.find((f) => f.name === SIM_DEMO.sheet)!;
  const sheets = [{ name: sheet.name, doc: readSchDoc(sheet.bytes, sheet.name) }];
  return { prj, sheets, compiled: compileProject(sheets) };
}

/** A sheet of library parts (each placed with its values) and wires, for netlisting. */
function sheetOf(place: (b: SchBuilder) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
  place(b);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  const doc = readSchDoc(writeCfb(root), 'T.SchDoc');
  return [{ name: 'T.SchDoc', doc }];
}
const put = (b: SchBuilder, libRef: string, des: string, at: [number, number], values: Record<string, string> = {}) => {
  const sym = [...simPartSymbols(), ...simSourceSymbols()].find((s) => s.libRef === libRef)!;
  const items = partRecords({ libRef, bags: sym.bags }, 'Simulation Parts.SchLib', 1);
  for (const [k, v] of Object.entries(values)) setSimParam(items, k, v);
  b.placePart(items, at, { designator: des });
};

describe('SIM models on parts and their netlist templates', () => {
  it('expands @, &, ?…|…|, %n, @MODEL and quoted names; lists what is missing', () => {
    const params: Record<string, string> = { VALUE: '4k7', 'INITIAL VOLTAGE': '2', AREA: '' };
    const ctx = { designator: 'C1', model: 'CAP', net: (i: number) => (i <= 2 ? ['', 'A', 'B'][i] : undefined), param: (n: string) => params[n] };
    expect(expandTemplate(DEFAULT_TEMPLATES.capacitor!, ctx)).toEqual({ line: 'C1 A B 4k7 IC=2', missing: [] });
    expect(expandTemplate('@DESIGNATOR %1 %2 %3 @MODEL ?AREA|@AREA| &OFF @GAIN', ctx)).toEqual({ line: 'C1 A B CAP', missing: ['pin 3', 'GAIN'] });
    // As AD stores them (¦ for the bar), PARAMS: only when a value follows, ~ when a parameter has none
    const xtal = '@DESIGNATOR %1 %2 @MODEL #¦PARAMS:¦ ?FREQ¦FREQ=@FREQ¦ ?RS¦RS=@RS¦ ~Q¦Q=50¦';
    expect(expandTemplate(xtal, { ...ctx, designator: 'XY1', model: 'XTAL', param: (n: string) => ({ FREQ: '16MEG' } as Record<string, string>)[n] }).line).toBe('XY1 A B XTAL PARAMS: FREQ=16MEG Q=50');
    expect(expandTemplate(xtal, { ...ctx, designator: 'XY1', model: 'XTAL', param: (n: string) => ({ Q: '80' } as Record<string, string>)[n] }).line).toBe('XY1 A B XTAL');
  });
  it('a placed part keeps its SIM model: Kind, SubKind, prefix, template, port map, values (by the model or, where it says *, the part)', () => {
    const { sheets } = demo();
    const doc = sheets[0]!.doc;
    const at = (des: string) => doc.objects.find((o) => o.kind === 'component' && doc.objects.some((t) => t.owner === o.index && t.kind === 'text' && t.role === 'designator' && t.text === des))!.index;
    const q = simModelOf(doc, at('Q1'))!;
    expect([q.name, q.kind, q.subKind, q.prefix, q.fileKind, q.fileName]).toEqual(['2N3904', 'Transistor', 'BJT', 'Q', 'MDL', '2N3904']);
    const r = simModelOf(doc, at('R1'))!;
    expect([r.subKind, r.netlist, r.params.get('VALUE')]).toEqual(['Resistor', '@DESIGNATOR %1 %2 @VALUE', '*']);
    const v2 = simModelOf(doc, at('V2'))!;
    expect([v2.subKind, v2.params.get('AMPLITUDE'), v2.params.get('FREQUENCY')]).toEqual(['Sinusoidal', '5m', '1k']);
    // The model's parameters stay under its parameter list (not the part's own parameters)
    const comp = doc.objects[at('Q1')]!;
    expect(doc.objects.filter((o) => o.owner === comp.index && o.kind === 'text' && o.role === 'parameter').map((o) => (o as { text: string }).text)).toEqual(['2N3904', '0.6']);   // (its Comment, and what it is rated for: 26.186)
  });
});

describe('Design › Simulate › Mixed Sim: the project as a netlist, simulated', () => {
  it('netlists the demo amplifier: each part by its template, GND as 0, the analyses, the model file', () => {
    const { prj, sheets, compiled } = demo();
    const s = readSimSettings(prj);
    expect([s.op, s.tran.on, s.ac.on, s.activeSignals]).toEqual([true, true, true, ['IN', 'OUT']]);
    const n = projectNetlist(compiled, sheets, s);
    expect(n.messages).toEqual([]);
    const lines = n.text.split('\n');
    for (const l of ['Q1 NetC3_1 BASE NetC2_1 2N3904', 'R1 VCC BASE 47k', 'C2 NetC2_1 0 100u', 'V1 VCC 0 DC 12', 'V2 IN 0 DC 0 SIN(0 5m 1k 0 0 0) AC 1 0',
      '.TRAN 20.00u 5.000m 0.000 20.00u', '.AC DEC 100 1.000 1.000meg', '.OP']) expect(lines).toContain(l);
    expect(n.text).toMatch(/^\*Models and Subcircuits:\n\.MODEL 2N3904 NPN\(/m);
    expect(n.namedNets.sort()).toEqual(['BASE', 'IN', 'OUT', 'VCC']);
    expect(n.signals).toEqual(expect.arrayContaining(['OUT', 'Q1[ic]', 'R1[p]', 'V1#branch']));
    expect(n.sourceFrequencies).toEqual([1000]);
  });
  it('simulates it: the bias, the gain at 1 kHz (transient and AC agree)', () => {
    const { prj, sheets, compiled } = demo();
    const { plots, msgs } = run(projectNetlist(compiled, sheets, readSimSettings(prj)).text);
    expect(msgs.filter((m) => m.level === 'error')).toEqual([]);
    const op = plots.find((p) => p.analysis === 'op')!;
    expect(vec(op, 'BASE').re[0]).toBeCloseTo(2.03, 1);
    expect(vec(op, 'C1[i]').re[0]).toBe(0);
    const ic = vec(op, 'Q1[ic]').re[0]!;
    expect(ic).toBeGreaterThan(1.2e-3); expect(ic).toBeLessThan(1.5e-3);
    const ac = plots.find((p) => p.analysis === 'ac')!;
    const k = ac.x!.values.findIndex((f) => f >= 1000);
    const g = Math.hypot(vec(ac, 'OUT').re[k]!, vec(ac, 'OUT').im![k]!);
    expect(g).toBeGreaterThan(180); expect(g).toBeLessThan(240);
    const tr = plots.find((p) => p.analysis === 'tran')!;
    const out = Array.from(vec(tr, 'OUT').re).slice(-100);
    const swing = (Math.max(...out) - Math.min(...out)) / 2;
    expect(swing / (g * 5e-3)).toBeCloseTo(1, 1);
  });
  it('a part without a SIM model: a resistor by its value (a warning), anything else left out; a missing model file is an error', () => {
    const sheets = sheetOf((b) => {
      put(b, 'VSRC', 'V1', [100, 100], { Value: '10' });
      put(b, 'DIODE', 'D1', [200, 100]);
      b.wire([100, 120], [100, 140], [200, 140], [200, 120]);
      b.wire([100, 80], [100, 60], [200, 60], [200, 80]);
    });
    const c = compileProject(sheets);
    const n = projectNetlist(c, sheets, defaultSettings());
    // The diode's pins are A and K: the port map puts the anode first
    expect(n.text).toMatch(/^D1 (\S+) (\S+) 1N4148$/m);
    const [, a, k] = /^D1 (\S+) (\S+) 1N4148$/m.exec(n.text)!;
    expect(n.text).toMatch(new RegExp(`^V1 ${a} ${k} DC 10$`, 'm'));
    const { plots } = run(n.text);
    expect(-vec(plots[0]!, 'V1#branch').re[0]!).toBeGreaterThan(1e-3);
    // Without a model file anywhere: an error naming it
    const none = projectNetlist(c, sheets, defaultSettings(), () => null);
    expect(none.messages).toEqual([]);
    const sheets2 = sheetOf((b) => { put(b, 'NPN', 'Q9', [100, 100]); });
    const doc = sheets2[0]!.doc;
    const impl = doc.objects.find((o) => o.record === SR.IMPLEMENTATION)!;
    doc.records[impl.index + 1]!.bag!.set('MODELDATAFILEENTITY0', 'NOSUCH');
    const bad = projectNetlist(compileProject(sheets2), sheets2, defaultSettings());
    expect(bad.messages.some((m) => m.level === 'error' && /NOSUCH\.mdl not found/.test(m.text))).toBe(true);
  });
});

describe('Analyses Setup', () => {
  it('keeps its settings in the project (the Simulator Outputs group) and reads them back', () => {
    const prj = readPrjPcb(binToBytes('[Design]\r\nVersion=1.0\r\n\r\n[Document1]\r\nDocumentPath=A.SchDoc\r\n'), 'A.PrjPcb');
    expect(readSimSettings(prj)).toEqual(defaultSettings());
    const s = defaultSettings();
    Object.assign(s.tran, { on: true, useDefaults: false, stop: '10m', step: '1u', fourier: true });
    Object.assign(s.dc, { on: true, source: 'V1', start: '-1', stop: '1', step: '10m' });
    s.activeSignals = ['OUT', 'Q1[ic]'];
    s.options.RELTOL = '100.0u';
    s.method = 'Gear';
    writeSimSettings(prj, s);
    const back = readPrjPcb(writePrjPcb(prj), 'A.PrjPcb');
    expect(readSimSettings(back)).toEqual(s);
    const text = new TextDecoder().decode(writePrjPcb(prj));
    expect(text).toMatch(/\[OutputGroup1\]\r\nName=Simulator Outputs\r\n[\s\S]*OutputType1=AdvSimNetlist\r\nOutputName1=Mixed Sim/);
    expect(parseSettingsItem(settingsItem(s))).toEqual(s);
    // The cards: changed options, the method, the analyses (operating point last)
    const cards = analysisCards(s, { sourceFrequencies: [], signals: ['OUT'] }).lines;
    expect(cards).toEqual(['.OPTIONS RELTOL=100.0u METHOD=GEAR', '.TRAN 1.000u 10.00m 0.000 20.00u', '.FOUR 1.000k V(OUT)', '.DC V1 -1 1 10m', '.OP']);
  });
  it('Use Transient Defaults: the slowest periodic source sets the window; AC Total Test Points', () => {
    const s = defaultSettings();
    expect(transientWindow(s, [1000, 50e3])).toEqual({ start: 0, stop: 5e-3, step: 2e-5, maxStep: 2e-5 });
    expect(transientWindow(s, [])).toEqual({ start: 0, stop: 5e-3, step: 20e-6, maxStep: 20e-6 });
    expect(acTotalPoints(s)).toBe(601);
    s.ac.sweep = 'Linear';
    expect(acTotalPoints(s)).toBe(100);
  });
});

describe('Konium\'s built-in models and simulation files', () => {
  it('every built-in model reads, and each device behaves as its datasheet says (roughly)', () => {
    for (const [name, text] of Object.entries(BUILTIN_MODELS)) {
      const c = readNetlist(`*\n${text}\n.END`);
      expect(c.errors, name).toEqual([]);
    }
    expect(builtinModel('1n4148')?.name).toBe('1N4148.mdl');
    const net = (body: string) => `*\n${body}\n${['1N4148', '1N4001', 'LED_RED', '2N7002', 'OPAMP'].map((m) => builtinModel(m)!.text).join('\n')}\n.OP\n.END`;
    const { plots, msgs } = run(net(`V1 a 0 5
R1 a d 430
D1 d 0 1N4148
V2 b 0 5
R2 b l 320
D2 l 0 LED_RED
V3 g 0 5
V4 dd 0 5
R4 dd dr 100
M1 dr g 0 0 2N7002
VP vp 0 12
VN vn 0 -12
VI in 0 0.1
R5 in inv 10k
R6 inv out 100k
X1 0 inv vp vn out OPAMP`));
    expect(msgs.filter((m) => m.level === 'error')).toEqual([]);
    const op = plots[0]!;
    expect(vec(op, 'd').re[0]).toBeGreaterThan(0.6); expect(vec(op, 'd').re[0]).toBeLessThan(0.8);
    expect(vec(op, 'l').re[0]).toBeGreaterThan(1.7); expect(vec(op, 'l').re[0]).toBeLessThan(2.0);
    expect(vec(op, 'dr').re[0]).toBeLessThan(0.5);
    expect(vec(op, 'out').re[0]).toBeCloseTo(-1, 2);
  });
  it('results (.sdf) as SPICE raw text, read back whole: waves, complex waves, tables, what each chart shows', () => {
    const { plots } = run(`*\nV1 in 0 SIN(0 1 1k) AC 1\nR1 in out 1k\nC1 out 0 100n\n.TRAN 20u 2m\n.FOUR 1k V(out)\n.AC DEC 5 10 100k\n.TF V(out) V1\n.OP\n.END`);
    const d: SimDataDocument = { kind: 'SimData', name: 'X.sdf', title: 'X', date: 'today', plots, messages: [{ level: 'warn', text: 'a note' }], charts: plots.map((p, k) => ({ title: p.title, source: k, plots: [[{ expr: 'out' }, { expr: 'db(out)', colour: '#2e6fd1' }]] })), active: 2, netlist: 'X.nsx', dirty: false };
    const text = writeSimData(d);
    expect(text.startsWith('Title: X\nDate: today\nPlotname: Transient Analysis\nFlags: real\n')).toBe(true);
    const back = readSimData(text, 'X.sdf');
    expect(back.plots.map((p) => [p.analysis, p.title, p.complex ?? false, p.vectors.length, p.x?.values.length ?? 0])).toEqual(plots.map((p) => [p.analysis, p.title, p.complex ?? false, p.vectors.length, p.x?.values.length ?? 0]));
    const ac = back.plots.find((p) => p.analysis === 'ac')!, ac0 = plots.find((p) => p.analysis === 'ac')!;
    expect(vec(ac, 'out').im![3]).toBeCloseTo(vec(ac0, 'out').im![3]!, 12);
    expect(back.plots.find((p) => p.analysis === 'four')!.table).toEqual(plots.find((p) => p.analysis === 'four')!.table);
    expect([back.charts, back.messages, back.active, back.netlist]).toEqual([d.charts, d.messages, 2, 'X.nsx']);
    expect(detect(new TextEncoder().encode(text), 'Y.raw')).toBe('SimData');
    expect(load(new TextEncoder().encode(text), 'X.sdf').kind).toBe('SimData');
  });
  it('netlists, models and subcircuits open as text and save as they were', () => {
    const bytes = new TextEncoder().encode('*x\r\nR1 a 0 1k\r\n.END\r\n');
    expect(detect(bytes, 'a.nsx')).toBe('SimText');
    expect(detect(bytes, 'a.CKT')).toBe('SimText');
    const d = readSimText(bytes, 'a.nsx');
    expect(d.text).toBe('*x\nR1 a 0 1k\n.END\n');
    expect(writeSimText(d)).toEqual(bytes);
  });
});
