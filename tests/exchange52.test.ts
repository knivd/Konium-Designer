import { describe, expect, it } from 'vitest';
import { demoFiles } from '../src/formats/synthetic/demo';
import { load } from '../src/formats/registry';
import { compileProject } from '../src/model/compile';
import { connections } from '../src/model/drc';
import type { SchDocument } from '../src/model/sch';
import type { PcbDocument } from '../src/model/pcb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { padsBytes, padsHeader, padsText } from '../src/formats/pads/ascii';
import { convertPadsLogic, parsePadsLogic } from '../src/formats/pads/logic';
import { exportPadsLogic } from '../src/formats/pads/writeLogic';
import { exportPadsLayout } from '../src/formats/pads/writeLayout';
import { convertPadsLayout } from '../src/formats/pads/layout';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { EXPORTERS } from '../src/formats/exporters';

function demo() {
  const files = demoFiles();
  const docs = files.filter((f) => /\.(schdoc|pcbdoc)$/i.test(f.name)).map((f) => load(f.bytes, f.name));
  const prj = files.find((f) => /\.prjpcb$/i.test(f.name))!;
  return {
    sheets: docs.filter((d): d is SchDocument => d.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d })),
    board: docs.find((d): d is PcbDocument => d.kind === 'PcbDoc')!,
    mode: Number(iniGet(readPrjPcb(prj.bytes, prj.name), 'Design', 'HierarchyMode') ?? 0),
  };
}
/** A compiled project's nets of two or more pins, by their pins. */
const netlist = (c: ReturnType<typeof compileProject>) => new Set(c.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.designator}.${p.pin}`).sort().join(' ')));

/** A small PADS Logic file: a resistor and a capacitor in series from +5V to ground, the middle named OUT. */
const LOGIC = [
  '*PADS-LOGIC-V9.0* DESIGN EXPORT FILE FROM A TEST',
  '*SCH*        GENERAL PARAMETERS OF THE SCHEMATIC DESIGN',
  'SHEET SIZE   B',
  '',
  '*SHT*   1 MAIN -1 $$$NONE',
  '*TEXT*       FREE TEXT',
  '1000 9000 0 0 100 10 0 "Default Font"',
  'A NOTE',
  '',
  '*CAEDECAL*  ITEMS',
  'PIN              34000 34000 100 10 100 10 2 1 0 0 0 1',
  '"Default Font"', '"Default Font"',
  '140 20 0 1 100 10 "Default Font"', 'REF-DES',
  '230 0 0 8 100 10 "Default Font"', 'PART-TYPE',
  'OPEN   2   10  255', '0 0', '200 0',
  '',
  'PCLK             34000 34000 100 10 100 10 2 2 0 0 0 1',
  '"Default Font"', '"Default Font"',
  '140 20 0 1 100 10 "Default Font"', 'REF-DES',
  '280 0 0 8 100 10 "Default Font"', 'PART-TYPE',
  'OPEN   2   10  255', '0 0', '200 0',
  'OPEN   3   10  255', '200 30', '260 0', '200 -30',
  '',
  'BOX2             32000 32000 100 10 100 10 2 1 0 2 18 0',
  '"Default Font"', '"Default Font"',
  '0 200 0 0 100 10 "Default Font"', 'REF-DES',
  '0 -200 0 0 100 10 "Default Font"', 'PART-TYPE',
  'CLOSED 5   10  255', '0 -100', '400 -100', '400 100', '0 100', '0 -100',
  'T-200  0     0 0 140 20 0 1 230 0 0 8 PIN',
  'P-520 0 0 1 -80 0 0 1 0',
  'T600   0     0 1 140 20 0 1 230 0 0 8 PCLK',
  'P-520 0 0 1 -80 0 0 1 0',
  '',
  'PWRBAR           33500 33180 100 10 100 10 2 2 0 1 26 0',
  '"Default Font"', '"Default Font"',
  '0 150 0 0 100 10 "Default Font"', 'REF-DES',
  '0 100 0 0 100 10 "Default Font"', 'PART-TYPE',
  'OPEN   2   10  255', '0 0', '0 100', 'OPEN   2   10  255', '-100 100', '100 100',
  'T0     0     0 0 0 0 0 0 0 0 0 8 ', 'P0 0 0 0 0 0 0 0 128',
  '',
  'GND              33500 33180 100 10 100 10 2 2 0 1 26 0',
  '"Default Font"', '"Default Font"',
  '0 150 0 0 100 10 "Default Font"', 'REF-DES',
  '0 100 0 0 100 10 "Default Font"', 'PART-TYPE',
  'OPEN   2   10  255', '0 0', '0 -100', 'OPEN   2   10  255', '-100 -100', '100 -100',
  'T0     0     0 0 0 0 0 0 0 0 0 8 ', 'P0 0 0 0 0 0 0 0 128',
  '',
  '*PARTTYPE*   ITEMS',
  '$PWR_SYMS UND  0   0   2     0', 'PWR 1', 'PWRBAR P VCC', '',
  '$GND_SYMS UND  0   0   2     0', 'GND 1', 'GND G GND', '',
  'RES10K RES  1   0   0     0', 'GATE 1 2 0', 'BOX2', '1 0 U', '2 0 U', '',
  'CAP100N CAP  1   0   0     0', 'GATE 1 2 0', 'BOX2', '1 0 U', '2 0 U', '',
  '*PART*       ITEMS',
  'R1           RES10K           2000 5000 0 0 100 10 100 10 3 2 2 0 0 18',
  '"Default Font"', '"Default Font"',
  '0 200 0 0 100 10 0 "Default Font"', 'REF-DES',
  '0 -200 0 0 100 10 0 "Default Font"', 'PART-TYPE',
  '0 -200 0 0 100 10 0 "Default Font"', 'Value',
  '"Value" 10K', '"PCB DECAL" R0603',
  '',
  'C1           CAP100N          4000 5000 0 0 100 10 100 10 2 1 2 0 0 0',
  '"Default Font"', '"Default Font"',
  '0 200 0 0 100 10 0 "Default Font"', 'REF-DES',
  '0 -200 0 0 100 10 0 "Default Font"', 'PART-TYPE',
  '"PCB DECAL" C0603',
  '',
  '*OFFPAGE REFS*',
  '@@@O0    +5V $PWR_SYMS 1500 5600 0 0 0',
  '@@@O1    GND $GND_SYMS 4800 4400 0 0 0',
  '',
  '*TIEDOTS*',
  '@@@D0    3000 5000',
  '',
  '*CONNECTION*',
  '*SIGNAL* +5V 0 0',
  '@@@O0        R1.1         3 0', '1500 5600', '1500 5000', '1800 5000',
  '*SIGNAL* OUT 0 0',
  'R1.2         @@@D0        2 0', '2600 5000', '3000 5000',
  '@@@D0        C1.1         2 0', '3000 5000', '3800 5000',
  '*SIGNAL* GND 0 0',
  'C1.2         @@@O1        3 0', '4600 5000', '4800 5000', '4800 4400',
  '',
  '*END*     OF ASCII OUTPUT FILE',
].join('\r\n');

describe('PADS ASCII (26.052)', () => {
  it('reads a PADS Logic design: parts, their labels and flags, power and ground symbols, nets by name', () => {
    const d = parsePadsLogic(LOGIC);
    expect(d.sheets).toHaveLength(1);
    expect(d.sheets[0]!.parts.map((p) => [p.ref, p.flags])).toEqual([['R1', 18], ['C1', 0]]);
    const r = convertPadsLogic(LOGIC, 'test.txt');
    expect(r.sheets.map((s) => s.name)).toEqual(['test.SchDoc']);
    const doc = readSchDoc(r.sheets[0]!.bytes, 'test.SchDoc');
    const c = compileProject([{ name: 'test.SchDoc', doc }], { scope: 3 });
    const byName = new Map(c.nets.map((n) => [n.name, n.pins.map((p) => `${p.designator}.${p.pin}`).sort().join(' ')]));
    expect(byName.get('+5V')).toBe('R1.1');
    expect(byName.get('OUT')).toBe('C1.1 R1.2');
    expect(byName.get('GND')).toBe('C1.2');
    // R1's flags: its part type hidden (2), its pin numbers (16); the comment its Value
    const r1 = c.components.find((x) => x.designator === 'R1')!;
    expect(r1.comment).toBe('10K');
    expect(r1.footprint).toBe('R0603');
    const pins = doc.objects.filter((o) => o.kind === 'pin' && o.owner === r1.refs[0]!.index);
    expect(pins.every((p) => p.kind === 'pin' && !p.showDesignator)).toBe(true);
    const c1Pins = doc.objects.filter((o) => o.kind === 'pin' && o.owner === c.components.find((x) => x.designator === 'C1')!.refs[0]!.index);
    expect(c1Pins.every((p) => p.kind === 'pin' && p.showDesignator)).toBe(true);
    // The clock pin: 200 long (its wedge isn't the pin), a clock
    const clk = pins.find((p) => p.kind === 'pin' && p.designator === '2');
    expect(clk && clk.kind === 'pin' && Math.round(clk.length / 10000)).toBe(200);
    expect(clk && clk.kind === 'pin' && clk.symbols.innerEdge).toBe(3);
    // Power and ground symbols: power ports
    const ports = doc.objects.filter((o) => o.kind === 'power').map((o) => o.kind === 'power' && [o.text, o.style]);
    expect(ports).toEqual([['+5V', 2], ['GND', 4]]);
  });

  it('a signal\'s wires that lie apart are one net (each part named), clear of other nets\' wires', () => {
    // OUT twice, the two halves apart: labels on both join them
    const text = LOGIC.replace('@@@D0        C1.1         2 0\r\n3000 5000\r\n3800 5000', 'C1.1         @@@D1        2 0\r\n3800 5000\r\n3800 5300')
      .replace('*TIEDOTS*\r\n@@@D0    3000 5000', '*TIEDOTS*\r\n@@@D0    3000 5000\r\n@@@D1    3800 5300');
    const r = convertPadsLogic(text, 'apart.txt');
    const doc = readSchDoc(r.sheets[0]!.bytes, 'apart.SchDoc');
    expect(doc.objects.filter((o) => o.kind === 'text' && o.role === 'netlabel' && o.text === 'OUT')).toHaveLength(2);
    const c = compileProject([{ name: 'apart.SchDoc', doc }], { scope: 3 });
    expect(c.nets.find((n) => n.name === 'OUT')!.pins.map((p) => `${p.designator}.${p.pin}`).sort()).toEqual(['C1.1', 'R1.2']);
  });

  it('writes AD schematics as PADS Logic and reads them back with the same nets', () => {
    const { sheets, mode } = demo();
    const e = exportPadsLogic({ name: 'Demo', sheets, hierarchyMode: mode });
    const text = padsText(e.bytes);
    expect(padsHeader(text.split('\n')[0]!)?.product).toBe('LOGIC');
    for (const s of ['*SCH*', '*SHT*', '*CAEDECAL*', '*PARTTYPE*', '*PART*', '*OFFPAGE REFS*', '*TIEDOTS*', '*CONNECTION*', '*END*']) expect(text).toContain(s);
    const back = convertPadsLogic(text, 'Demo.txt');
    const a = compileProject(sheets, { scope: mode });
    const b = compileProject(back.sheets.map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) })), { scope: 3 });
    expect(b.components.map((x) => x.designator).sort()).toEqual(a.components.map((x) => x.designator).sort());
    expect([...netlist(b)].sort()).toEqual([...netlist(a)].sort());
    // Every named net keeps its name
    for (const n of a.nets.filter((x) => !x.auto && x.pins.length > 1)) expect(b.nets.some((m) => m.name === n.name.replace(/\s+/g, '_'))).toBe(true);
  });

  it('wires run between pins, off-page references and tie dots; parts placed turned and mirrored as AD places them', () => {
    const { sheets, mode } = demo();
    const d = parsePadsLogic(padsText(exportPadsLogic({ name: 'Demo', sheets, hierarchyMode: mode }).bytes));
    for (const sh of d.sheets) {
      const ids = new Set([...sh.opcs.map((o) => o.id), ...sh.dots.keys()]);
      for (const s of sh.signals) for (const w of s.wires) for (const end of [w.a, w.b]) expect(end.startsWith('@@@') ? ids.has(end) : /^[^.]+\.[^.]+$/.test(end)).toBe(true);
    }
    // A part turned 90° and mirrored round trips to the same pins' ends
    const { sheets: s2 } = demo();
    const sch = s2[0]!.doc;
    const before = new Set(sch.objects.filter((o) => o.kind === 'pin' && !o.hidden).map((o) => o.kind === 'pin' && `${Math.round(o.at.x / 1e5)},${Math.round(o.at.y / 1e5)}`));
    const back = convertPadsLogic(padsText(exportPadsLogic({ name: 'Demo', sheets: [s2[0]!], hierarchyMode: mode }).bytes), 'one.txt');
    const doc2 = readSchDoc(back.sheets[0]!.bytes, back.sheets[0]!.name);
    const after = new Set(doc2.objects.filter((o) => o.kind === 'pin' && !o.hidden).map((o) => o.kind === 'pin' && `${Math.round(o.at.x / 1e5)},${Math.round(o.at.y / 1e5)}`));
    for (const p of before) expect(after.has(p)).toBe(true);
  });

  it('writes in the code page its text needs, naming it in the header; reads it back', () => {
    const b = padsBytes('*PADS-LOGIC-V9.0* X\r\nZażółć gęślą jaźń\r\n');
    expect(new TextDecoder('latin1').decode(b.subarray(0, 25))).toBe('*PADS-LOGIC-V9.0-CP1250* ');
    expect(padsText(b)).toContain('Zażółć gęślą jaźń');
    expect(new TextDecoder('latin1').decode(padsBytes('*PADS-LOGIC-V9.0* X\r\nCafé\r\n').subarray(0, 18))).toBe('*PADS-LOGIC-V9.0* ');
  });

  it('writes an AD board as PADS Layout and reads it back: parts, pads on their nets, routed as before', () => {
    const { board } = demo();
    const e = exportPadsLayout(board, 'Demo');
    const r = convertPadsLayout(padsText(e.bytes), 'Demo.asc');
    const b2 = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    expect(b2.components.length).toBe(board.components.length);
    expect(connections(b2).length).toBe(connections(board).length);
    const padNets = (d: PcbDocument) => new Map(d.prims.filter((x) => x.kind === 'pad' && x.component !== 0xffff).map((x) => x.kind === 'pad' ? [`${d.components[x.component]?.designator}.${x.name}`, d.nets[x.net]?.name ?? ''] : ['', '']));
    const a = padNets(board), b = padNets(b2);
    for (const [k, v] of a) expect(b.get(k)).toBe(v.replace(/\s+/g, '_'));
  });

  it('the importer takes PADS files by their header and makes one project of a schematic and a board of one name', async () => {
    const enc = new TextEncoder();
    const { board, sheets, mode } = demo();
    const logic = exportPadsLogic({ name: 'Pair', sheets, hierarchyMode: mode }).bytes, layout = exportPadsLayout(board, 'Pair').bytes;
    expect(importerFor('a.txt', logic)?.id).toBe('pads');
    expect(importerFor('a.asc', layout)?.id).toBe('pads');
    expect(importerFor('notes.txt', enc.encode('just some notes'))).toBeUndefined();
    const pads = IMPORTERS.find((i) => i.id === 'pads')!;
    const files = [{ path: 'x/Pair.txt', bytes: logic }, { path: 'x/Pair.asc', bytes: layout }];
    expect(pads.list(files).map((i) => i.kind)).toEqual(['Schematic', 'PCB']);
    const r = await pads.run(files);
    expect(r.projects).toHaveLength(1);
    const names = r.projects[0]!.documents.map((d) => d.name);
    expect(names).toContain('Pair.SchLib');
    expect(names).toContain('Pair.PcbDoc');
    expect(names).toContain('Pair.PcbLib');
    expect(names.filter((n) => /\.schdoc$/i.test(n)).length).toBe(sheets.length);
    expect(iniGet(readPrjPcb(r.projects[0]!.prj.bytes, 'Pair.PrjPcb'), 'Design', 'HierarchyMode')).toBe('3');
  });

  it('the Export Wizard writes PADS ASCII: the design (.txt) and the board (.asc) in the project\'s folder', () => {
    const { board, sheets, mode } = demo();
    const ex = EXPORTERS.find((e) => e.id === 'pads')!;
    const r = ex.run({ name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: mode, variables: [] });
    expect(r.files.map((f) => f.path).sort()).toEqual(['Demo/Demo.asc', 'Demo/Demo.txt']);
    expect(r.messages.some((m) => m.level === 'error')).toBe(false);
  });
});
