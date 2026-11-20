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
import { zip } from '../src/formats/zip';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { EXPORTERS } from '../src/formats/exporters';
import { convertEasyedaPcb } from '../src/formats/easyeda/stdPcb';
import { convertEasyedaSch } from '../src/formats/easyeda/stdSch';
import { exportEasyedaPcb } from '../src/formats/easyeda/writeStdPcb';
import { exportEasyedaSch } from '../src/formats/easyeda/writeStdSch';
import { readEasyedaPro, v3Docs } from '../src/formats/easyeda/proRead';
import { arcOf, pathSegs } from '../src/formats/easyeda/proPcb';

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
const netlist = (c: ReturnType<typeof compileProject>) => new Set(c.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.designator}.${p.pin}`).sort().join(' ')));
const padNets = (d: PcbDocument) => new Map(d.prims.filter((x) => x.kind === 'pad' && x.component !== 0xffff).map((x) => x.kind === 'pad' ? [`${d.components[x.component]?.designator}.${x.name}`, d.nets[x.net]?.name ?? ''] : ['', '']));
const enc = new TextEncoder();
const lines = (recs: unknown[][]) => enc.encode(recs.map((r) => JSON.stringify(r)).join('\n'));

/** EasyEDA Standard: two resistors on a board (10 mil units, Y down), joined by a track; one's other pad on a via under a pour. */
const STD_PCB = {
  head: { docType: '3', editorVersion: '6.5.34', x: '4000', y: '3000', c_para: {} },
  canvas: 'CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mil~1~45~visible~0.5~4000~3000~0~yes',
  layers: ['1~TopLayer~#FF0000~true~true~true~', '2~BottomLayer~#0000FF~true~false~true~', '3~TopSilkLayer~#FFCC00~true~false~true~', '10~BoardOutLine~#FF00FF~true~false~true~'],
  shape: [
    'TRACK~1~10~~4000 3000 4100 3000 4100 3050 4000 3050 4000 3000~gge1~0',
    'LIB~4020~3025~package`R0603`spicePre`R`spiceSymbolName`RES`~0~~gge1a2b3c4d5e6f7a8b~1~~~0~~yes~~#@$PAD~RECT~4017~3025~3~3~1~N1~1~0~4015.5 3023.5 4018.5 3023.5 4018.5 3026.5 4015.5 3026.5~0~gge2~0~~~0~0~0.2~#@$PAD~RECT~4023~3025~3~3~1~MID~2~0~4021.5 3023.5 4024.5 3023.5 4024.5 3026.5 4021.5 3026.5~0~gge3~0~~~0~0~0.2~#@$TEXT~P~4018~3020~0.6~0~0~3~~4.5~R1~~~gge4~~0~pinpart',
    'LIB~4060~3025~package`R0603`spicePre`R`spiceSymbolName`RES`~0~~gge9a2b3c4d5e6f7a8b~1~~~0~~yes~~#@$PAD~RECT~4057~3025~3~3~1~MID~1~0~4055.5 3023.5 4058.5 3023.5 4058.5 3026.5 4055.5 3026.5~0~gge5~0~~~0~0~0.2~#@$PAD~ELLIPSE~4063~3025~3~3~11~GND~2~0.6~~0~gge6~0~~Y~0~0~0.2~#@$TEXT~P~4058~3020~0.6~0~0~3~~4.5~R2~~~gge7~~0~pinpart',
    'TRACK~1~1~MID~4023 3025 4057 3025~gge8~0',
    'COPPERAREA~1~2~GND~M 4005 3005 L 4095 3005 L 4095 3045 L 4005 3045 Z~1~solid~gge9~spoke~none~[[]]~0~gge9~1',
  ],
  DRCRULE: { Default: { trackWidth: 1, clearance: 0.6, viaHoleDiameter: 2.4, viaHoleD: 1.2 } },
};

/** EasyEDA Standard: a dual part placed as its two parts (U1.1, U1.2), each pin wired to a labelled net. */
const STD_SCH = {
  docType: '5', title: 'Dual', schematics: [{ docType: '1', title: 'Sheet_1', dataStr: { head: { docType: '1' }, shape: [
    'LIB~100~-100~package`SOIC8`spicePre`U`name`LM358`~0~0~ggeaaaa000000000001~~~0~~yes~yes#@$T~P~100~-120~0~#000080~Arial~~~~~comment~U1.1~1~start~gge2~0~#@$R~95~-110~~~10~20~#880000~1~0~none~gge3~0#@$P~show~0~1~90~-100~180~gge4~0^^90~-100^^M 90 -100 h 5~#880000^^1~97~-100~0~A~start~~~#0000FF^^1~92~-101~0~1~end~~~#0000FF^^0~~^^0~',
    'LIB~200~-100~package`SOIC8`spicePre`U`name`LM358`~0~0~ggeaaaa000000000002~~~0~~yes~yes#@$T~P~200~-120~0~#000080~Arial~~~~~comment~U1.2~1~start~gge6~0~#@$R~195~-110~~~10~20~#880000~1~0~none~gge7~0#@$P~show~0~7~190~-100~180~gge8~0^^190~-100^^M 190 -100 h 5~#880000^^1~197~-100~0~B~start~~~#0000FF^^1~192~-101~0~7~end~~~#0000FF^^0~~^^0~',
    'W~90 -100 70 -100~#008800~1~0~none~gge10~0', 'N~70~-100~0~#000080~IN~gge11~start~72~-102~Times New Roman~7pt~0',
    'W~190 -100 170 -100~#008800~1~0~none~gge12~0', 'N~170~-100~0~#000080~IN~gge13~start~172~-102~Times New Roman~7pt~0',
  ] } }],
};

/** EasyEDA Pro (v2): a board of two resistors and a ground flag — project.json, a page, symbols, a footprint, the PCB. */
function proProject(): Uint8Array {
  const sym = lines([['DOCTYPE', 'SYMBOL', '1.1'], ['HEAD', { symbolType: 2 }], ['LINESTYLE', 'st1', null, null, null, null], ['FONTSTYLE', 'st2', null, null, null, null, null, null, null, null, null, 0],
    ['PART', 'RES.1', { BBOX: [-10, -4, 10, 4] }], ['ATTR', 'e1', '', 'Symbol', 'RES', 0, 0, null, null, 0, 'st2', 0], ['ATTR', 'e2', '', 'Designator', 'R?', 0, 0, null, null, 0, 'st2', 0],
    ['RECT', 'e3', -6, 3, 6, -3, 0, 0, 0, 'st1', 0],
    ['PIN', 'e4', 1, 0, -10, 0, 4, 0, null, 0, 0], ['ATTR', 'e5', 'e4', 'NAME', '1', 0, 0, null, null, 0, 'st2', 0], ['ATTR', 'e6', 'e4', 'NUMBER', '1', 0, 0, null, null, 0, 'st2', 0],
    ['PIN', 'e7', 1, 0, 10, 0, 4, 180, null, 0, 0], ['ATTR', 'e8', 'e7', 'NAME', '2', 0, 0, null, null, 0, 'st2', 0], ['ATTR', 'e9', 'e7', 'NUMBER', '2', 0, 0, null, null, 0, 'st2', 0]]);
  const gnd = lines([['DOCTYPE', 'SYMBOL', '1.1'], ['HEAD', { symbolType: 18 }], ['LINESTYLE', 'st1', null, null, null, null], ['FONTSTYLE', 'st2', null, null, null, null, null, null, null, null, null, 0],
    ['PART', '', { BBOX: [-5, -10, 5, 0] }], ['ATTR', 'e1', '', 'Global Net Name', 'GND', 0, 1, 0, -15, 0, 'st2', 0],
    ['PIN', 'e2', 1, 0, 0, 0, 0, 270, null, 0, 0], ['POLY', 'e3', [0, 0, 0, -6], false, 'st1', 0], ['POLY', 'e4', [-5, -6, 5, -6], false, 'st1', 0]]);
  const page = lines([['DOCTYPE', 'SCH', '1.1'], ['HEAD', { originX: 0, originY: 0 }], ['FONTSTYLE', 'st1', null, null, null, null, null, null, null, null, null, 0], ['LINESTYLE', 'st2', null, null, 'none', null],
    ['COMPONENT', 'e1', 'RES.1', 100, 100, 0, 0, {}, 0], ['ATTR', 'e2', 'e1', 'Symbol', 'sym1', 0, 0, null, null, 0, 'st1', 0], ['ATTR', 'e3', 'e1', 'Device', 'dev1', 0, 0, null, null, 0, 'st1', 0],
    ['ATTR', 'e4', 'e1', 'Designator', 'R1', 0, 1, 95, 106, 0, 'st1', 0], ['ATTR', 'e5', 'e1', 'Unique ID', 'gge1', 0, 0, null, null, 0, 'st1', 0], ['ATTR', 'e6', 'e1', 'Name', '={Value}', 0, 1, 95, 92, 0, 'st1', 0],
    ['COMPONENT', 'e7', 'RES.1', 200, 100, 0, 0, {}, 0], ['ATTR', 'e8', 'e7', 'Symbol', 'sym1', 0, 0, null, null, 0, 'st1', 0], ['ATTR', 'e9', 'e7', 'Device', 'dev1', 0, 0, null, null, 0, 'st1', 0],
    ['ATTR', 'e10', 'e7', 'Designator', 'R2', 0, 1, 195, 106, 0, 'st1', 0], ['ATTR', 'e11', 'e7', 'Unique ID', 'gge2', 0, 0, null, null, 0, 'st1', 0],
    ['COMPONENT', 'e12', '', 210, 100, 0, 0, {}, 0], ['ATTR', 'e13', 'e12', 'Symbol', 'gnd1', 0, 0, null, null, 0, 'st1', 0], ['ATTR', 'e14', 'e12', 'Device', 'devg', 0, 0, null, null, 0, 'st1', 0],
    ['WIRE', 'e15', [[110, 100, 190, 100]], 'st2', 0], ['ATTR', 'e16', 'e15', 'NET', 'MID', 0, 1, 150, 100, 0, 'st1', 0],
    ['WIRE', 'e17', [[90, 100, 70, 100]], 'st2', 0], ['ATTR', 'e18', 'e17', 'NET', '$1N5', 0, 0, null, null, 0, 'st1', 0]]);
  const fp = lines([['DOCTYPE', 'FOOTPRINT', '1.8'], ['PAD', 'e1', 0, '', 1, '1', -30, 0, 0, null, ['RECT', 20, 20], [], 0, 0, 0, 1, 0, null, null, null, null, 0],
    ['PAD', 'e2', 0, '', 1, '2', 30, 0, 0, null, ['RECT', 20, 20], [], 0, 0, 0, 1, 0, null, null, null, null, 0], ['POLY', 'e3', 0, '', 3, 6, [-50, 20, 'L', 50, 20], 0],
    ['ATTR', 'e4', 0, '', 3, null, null, 'Footprint', 'R0603', 0, 0, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0]]);
  const pcb = lines([['DOCTYPE', 'PCB', '1.7'], ['LAYER', 1, 'TOP', 'Top Layer', 3], ['LAYER', 2, 'BOTTOM', 'Bottom Layer', 3],
    ['POLY', 'e1', 0, '', 11, 10, ['R', -100, 100, 400, 200, 0, 0], 0],
    ['COMPONENT', 'e2', 0, 1, 0, 0, 0, { 'Unique ID': 'gge1' }, 0], ['ATTR', 'e3', 0, 'e2', 3, null, null, 'Device', 'dev1', 0, 0], ['ATTR', 'e4', 0, 'e2', 3, null, null, 'Footprint', 'fp1', 0, 0],
    ['ATTR', 'e5', 0, 'e2', 3, -20, 30, 'Designator', 'R1', 0, 1, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0],
    ['COMPONENT', 'e6', 0, 2, 200, 0, 90, { 'Unique ID': 'gge2' }, 0], ['ATTR', 'e7', 0, 'e6', 4, null, null, 'Device', 'dev1', 0, 0], ['ATTR', 'e8', 0, 'e6', 4, null, null, 'Footprint', 'fp1', 0, 0],
    ['ATTR', 'e9', 0, 'e6', 4, 180, 30, 'Designator', 'R2', 0, 1, 'default', 45, 6, 0, 0, 3, 0, 0, 0, 0, 0],
    ['PAD_NET', 'e2', '2', 'MID'], ['PAD_NET', 'e6', '1', 'MID'], ['PAD_NET', 'e6', '2', 'GND'],
    ['LINE', 'e10', 0, 'MID', 1, 30, 0, 200, -30, 10, 0], ['VIA', 'e11', 0, 'MID', '', 200, -30, 10, 20, 0, null, null, 0]]);
  const project = { schematics: { s1: { name: 'Main', sheets: [{ id: 1, name: 'P1' }] } }, pcbs: { p1: 'Board' }, boards: { Demo: { schematic: 's1', pcb: 'p1' } },
    symbols: { sym1: { title: 'RES', type: 2 }, gnd1: { title: 'Ground-GND', type: 18 } }, footprints: { fp1: { title: 'R0603' } },
    devices: { dev1: { title: 'RES', attributes: { Symbol: 'sym1', Footprint: 'fp1', Designator: 'R?', Value: '10k', Name: '={Value}' } }, devg: { title: 'GND', attributes: { Symbol: 'gnd1', 'Global Net Name': 'GND' } } },
    panels: {}, config: { title: 'Demo' } };
  return zip([{ name: 'project.json', bytes: enc.encode(JSON.stringify(project)) }, { name: 'SHEET/s1/1.esch', bytes: page }, { name: 'SYMBOL/sym1.esym', bytes: sym }, { name: 'SYMBOL/gnd1.esym', bytes: gnd },
    { name: 'FOOTPRINT/fp1.efoo', bytes: fp }, { name: 'PCB/p1.epcb', bytes: pcb }]);
}

describe('EasyEDA (26.052)', () => {
  it('reads an EasyEDA Standard board: footprints, pads on their nets, tracks, pours, the outline, the rules', () => {
    const r = convertEasyedaPcb(STD_PCB as Record<string, unknown>, 'PCB_Two.json');
    const b = readPcbDoc(r.bytes, 'Two.PcbDoc');
    expect(b.components.map((c) => c.designator).sort()).toEqual(['R1', 'R2']);
    const nets = padNets(b);
    expect(nets.get('R1.2')).toBe('MID');
    expect(nets.get('R2.1')).toBe('MID');
    expect(nets.get('R2.2')).toBe('GND');
    expect(b.polygons).toHaveLength(1);
    expect(connections(b).filter((c) => b.nets[c.net]?.name === 'MID')).toHaveLength(0);
    // The outline: 1000 × 500 mil
    const xs = b.board.outline.map((p) => p.x), ys = b.board.outline.map((p) => p.y);
    expect(Math.round((Math.max(...xs) - Math.min(...xs)) / 10000)).toBe(1000);
    expect(Math.round((Math.max(...ys) - Math.min(...ys)) / 10000)).toBe(500);
  });

  it('reads parts named U1.1, U1.2 … as the parts of one multi-part part', () => {
    const r = convertEasyedaSch(STD_SCH as Record<string, unknown>, 'SCH_Dual.json');
    const c = compileProject(r.sheets.map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) })), { scope: 3 });
    expect(c.components.map((x) => x.designator)).toEqual(['U1']);
    expect(c.components[0]!.parts).toBe(2);
    expect(c.nets.find((n) => n.name === 'IN')!.pins.map((p) => `${p.designator}.${p.pin}`).sort()).toEqual(['U1.1', 'U1.7']);
  });

  it('writes AD schematics as EasyEDA Standard and reads them back with the same parts and nets', () => {
    const { sheets, mode } = demo();
    const e = exportEasyedaSch({ name: 'Demo', sheets, hierarchyMode: mode });
    const json = JSON.parse(new TextDecoder().decode(e.bytes)) as { docType: string; schematics: { dataStr: { shape: string[] } }[] };
    expect(json.docType).toBe('5');
    expect(json.schematics).toHaveLength(sheets.length);
    const back = convertEasyedaSch(json as unknown as Record<string, unknown>, 'Demo.json');
    const a = compileProject(sheets, { scope: mode });
    const b = compileProject(back.sheets.map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) })), { scope: 3 });
    expect(b.components.map((x) => x.designator).sort()).toEqual(a.components.map((x) => x.designator).sort());
    expect([...netlist(b)].sort()).toEqual([...netlist(a)].sort());
    for (const n of a.nets.filter((x) => !x.auto && x.pins.length > 1)) expect(b.nets.some((m) => m.name === n.name)).toBe(true);
  });

  it('writes an AD board as EasyEDA Standard and reads it back: parts, pads on their nets, routed as before', () => {
    const { board } = demo();
    const e = exportEasyedaPcb(board, 'Demo');
    const json = JSON.parse(new TextDecoder().decode(e.bytes)) as { head: { docType: string }; shape: string[] };
    expect(json.head.docType).toBe('3');
    // Every footprint carries its pads and its designator
    expect(json.shape.filter((s) => s.startsWith('LIB~'))).toHaveLength(board.components.length);
    const r = convertEasyedaPcb(json as unknown as Record<string, unknown>, 'Demo.json');
    const b2 = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    expect(b2.components.length).toBe(board.components.length);
    expect(connections(b2).length).toBe(connections(board).length);
    const a = padNets(board), b = padNets(b2);
    for (const [k, v] of a) expect(b.get(k)).toBe(v);
    // Placed where they were, turned as they were
    for (const c of board.components) {
      const d = b2.components.find((x) => x.designator === c.designator)!;
      expect(d.layer).toBe(c.layer);
      expect(((c.rotation - d.rotation) % 360 + 360) % 360).toBeCloseTo(0, 3);
      expect(Math.hypot(c.at.x - board.board.origin.x - (d.at.x - b2.board.origin.x), c.at.y - board.board.origin.y - (d.at.y - b2.board.origin.y))).toBeLessThan(200);
    }
  });

  it('EasyEDA Pro: geometry — paths (lines, arcs, rectangles, circles) and arcs by their sweep', () => {
    const segs = pathSegs([0, 0, 'L', 10, 0, 'ARC', 90, 20, 10]);
    expect(segs).toHaveLength(2);
    const arc = arcOf(segs[1]!.a, segs[1]!.b, segs[1]!.sweep!)!;
    expect(arc.c.x).toBeCloseTo(10, 6);
    expect(arc.c.y).toBeCloseTo(10, 6);
    expect(arc.r).toBeCloseTo(10, 6);
    expect(arc.start).toBeCloseTo(270, 6);
    expect(arc.end).toBeCloseTo(0, 6);
    expect(pathSegs(['R', 0, 10, 20, 10, 0, 0])).toHaveLength(4);
    expect(pathSegs(['CIRCLE', 0, 0, 5]).every((s) => s.sweep === 180)).toBe(true);
  });

  it('EasyEDA Pro v3: the log keeps each row\'s last revision and drops deleted rows', () => {
    const log = [
      '{"type":"DOCHEAD","ticket":1}||{"docType":"PCB","uuid":"p1"}|',
      '{"type":"META","ticket":2,"id":"META"}||{"title":"Board","board":"b1"}|',
      '{"type":"VIA","ticket":3,"id":"e1"}||{"netName":"A","centerX":0,"centerY":0,"holeDiameter":10,"viaDiameter":20}|',
      '{"type":"VIA","ticket":5,"id":"e1"}||{"netName":"B","centerX":0,"centerY":0,"holeDiameter":10,"viaDiameter":20}|',
      '{"type":"VIA","ticket":4,"id":"e1"}||{"netName":"C","centerX":0,"centerY":0,"holeDiameter":10,"viaDiameter":20}|',
      '{"type":"VIA","ticket":6,"id":"e2"}||{"netName":"D","centerX":1,"centerY":1,"holeDiameter":10,"viaDiameter":20}|',
      '{"type":"VIA","ticket":7,"id":"e2"}|||',
    ].join('\n');
    const [d] = v3Docs(log);
    const vias = [...d!.rows.values()].filter((r) => r.type === 'VIA' && r.inner);
    expect(vias).toHaveLength(1);
    expect((vias[0]!.inner as { netName: string }).netName).toBe('B');
  });

  it('imports an EasyEDA Pro project: each board a project — its pages, symbols, PCB and footprints — nets as EasyEDA joins them', async () => {
    const bytes = proProject();
    expect(importerFor('Demo.epro', bytes)?.id).toBe('easyeda');
    const p = await readEasyedaPro('Demo.epro', bytes);
    expect(p.boards).toEqual([{ name: 'Demo', schematic: 's1', pcb: 'p1' }]);
    const ee = IMPORTERS.find((i) => i.id === 'easyeda')!;
    const r = await ee.run([{ path: 'Demo.epro', bytes }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(r.projects).toHaveLength(1);
    const docs = r.projects[0]!.documents;
    expect(docs.map((d) => d.name).sort()).toEqual(['Demo.PcbDoc', 'Demo.PcbLib', 'Demo.SchDoc', 'Demo.SchLib']);
    expect(iniGet(readPrjPcb(r.projects[0]!.prj.bytes, 'Demo.PrjPcb'), 'Design', 'HierarchyMode')).toBe('3');
    const sheet = docs.find((d) => d.name === 'Demo.SchDoc')!;
    const c = compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(sheet.bytes, 'Demo.SchDoc') }], { scope: 3 });
    expect(c.components.map((x) => x.designator).sort()).toEqual(['R1', 'R2']);
    expect(c.components.find((x) => x.designator === 'R1')!.comment).toBe('10k');
    expect(c.components.find((x) => x.designator === 'R1')!.footprint).toBe('R0603');
    expect(c.nets.find((n) => n.name === 'MID')!.pins.map((q) => `${q.designator}.${q.pin}`).sort()).toEqual(['R1.2', 'R2.1']);
    expect(c.nets.find((n) => n.name === 'GND')!.pins.map((q) => `${q.designator}.${q.pin}`)).toEqual(['R2.2']);
    const b = readPcbDoc(docs.find((d) => d.name === 'Demo.PcbDoc')!.bytes, 'Demo.PcbDoc');
    expect(b.components.map((x) => x.designator).sort()).toEqual(['R1', 'R2']);
    const pn = padNets(b);
    expect([pn.get('R1.2'), pn.get('R2.1'), pn.get('R2.2')]).toEqual(['MID', 'MID', 'GND']);
    expect(connections(b).filter((x) => b.nets[x.net]?.name === 'MID')).toHaveLength(0);
    // A bottom part: reflected top to bottom, then turned (R2's pad 1 at its local (−30, 0), turned 90°: (200, −30))
    const r2 = b.prims.find((x) => x.kind === 'pad' && x.name === '1' && b.components[x.component]?.designator === 'R2')!;
    const r1 = b.prims.find((x) => x.kind === 'pad' && x.name === '1' && b.components[x.component]?.designator === 'R1')!;
    expect(r2.kind === 'pad' && r1.kind === 'pad' && Math.round((r2.at.x - r1.at.x) / 10000)).toBe(230);
    expect(r2.kind === 'pad' && r1.kind === 'pad' && Math.round((r2.at.y - r1.at.y) / 10000)).toBe(-30);
  });

  it('the importer takes EasyEDA files by their content, and the Export Wizard writes EasyEDA source files', () => {
    expect(importerFor('PCB_Two.json', enc.encode(JSON.stringify(STD_PCB)))?.id).toBe('easyeda');
    expect(importerFor('SCH_Dual.json', enc.encode(JSON.stringify(STD_SCH)))?.id).toBe('easyeda');
    expect(importerFor('package.json', enc.encode('{"name":"x","version":"1.0.0"}'))).toBeUndefined();
    const { board, sheets, mode } = demo();
    const ex = EXPORTERS.find((e) => e.id === 'easyeda')!;
    const r = ex.run({ name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: mode, variables: [] });
    expect(r.files.map((f) => f.path).sort()).toEqual(['Demo/PCB_Demo.json', 'Demo/SCH_Demo.json']);
    expect(r.messages.some((m) => m.level === 'error')).toBe(false);
    // The schematic's parts and the board's footprints share their ids (EasyEDA's link between them)
    const sch = JSON.parse(new TextDecoder().decode(r.files.find((f) => f.path.endsWith('SCH_Demo.json'))!.bytes)) as { schematics: { dataStr: { shape: string[] } }[] };
    const pcb = JSON.parse(new TextDecoder().decode(r.files.find((f) => f.path.endsWith('PCB_Demo.json'))!.bytes)) as { shape: string[] };
    const schIds = new Set(sch.schematics.flatMap((s) => s.dataStr.shape.filter((x) => x.startsWith('LIB~')).map((x) => x.split('~')[6])));
    const pcbIds = pcb.shape.filter((x) => x.startsWith('LIB~')).map((x) => x.split('~')[6]);
    expect(pcbIds.filter((id) => schIds.has(id)).length).toBeGreaterThan(0);
  });
});
