import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoFiles, demoOutJob, demoPcbDoc, demoPrjPcb } from '../src/formats/synthetic/demo';
import { readPrjPcb } from '../src/formats/altium/prjpcb';
import type { Project } from '../src/app/state';
import { PropertyBag } from '../src/formats/altium/props';
import { binToBytes, bytesToBin } from '../src/formats/text';
import { L, type LayerId } from '../src/model/layers';
import { mil, mm } from '../src/core/units';
import { compileProject } from '../src/model/compile';
import { protelNetlist } from '../src/formats/netlist';
import { ipc356, testFeatures } from '../src/formats/gerber/testpoints';
import { drillGroups, legendStrings } from '../src/formats/gerber/drillDrawing';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { defaultDrillSetup } from '../src/formats/gerber/drill';
import { defaultPnpSetup } from '../src/formats/gerber/pnp';
import { defaultJob, type PrintJob } from '../src/model/printouts';
import { printJobPages } from '../src/render/pcbPrint';
import {
  dimensionEdges, dimensionFromBag, dimensionGeometry, joinDimensions, layoutDimension, newDimension, readDimensions, transformDimension,
} from '../src/model/dimensions';
import type { PcbPrim } from '../src/model/pcb';
import { strokeText, strokeTextExtent } from '../src/formats/gerber/stroke';
import { ercReportHtml, statusReport } from '../src/formats/reports';
import { newOutJob, newOutput, outJobMedia, outJobOutputs, outputConfig, readOutJob, setOutJobKey, setOutJobOutputs, writeOutJob } from '../src/formats/altium/outjob';
import { drillFromConfig, drillToConfig, gerberFromConfig, gerberToConfig, pnpFromConfig, pnpToConfig, printJobFromConfig, printJobToConfig } from '../src/formats/altium/outjobConfig';
import { containerOutputs, outputFiles, outputPages } from '../src/app/outjobRun';

const board = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

/** A real board's first linear dimension (AD17 era), as Dimensions6 keeps it. */
const DIM_RECORD = '|SELECTION=FALSE|LAYER=MECHANICAL2|LOCKED=FALSE|POLYGONOUTLINE=FALSE|USERROUTED=TRUE|KEEPOUT=FALSE|UNIONINDEX=0|PRIMITIVELOCK=TRUE|DIMENSIONLAYER=MECHANICAL2|DIMENSIONLOCKED=FALSE|OBJECTID=13|DIMENSIONKIND=1|DRCERROR=FALSE|VINDEXFORSAVE=0|LX=3615mil|LY=2385mil|HX=4369.9613mil|HY=2695mil|X1=4220mil|Y1=2490mil|X2=4080mil|Y2=2979.9831mil|TEXTX=4220mil|TEXTY=2380mil|HEIGHT=10mil|LINEWIDTH=10mil|TEXTHEIGHT=60mil|TEXTWIDTH=6mil|FONT=DEFAULT|STYLE=None|TEXTLINEWIDTH=6mil|TEXTPOSITION=Bottom|TEXTGAP=10mil|TEXTFORMAT=10|TEXTDIMENSIONUNIT=Inches|TEXTPRECISION=2|TEXTPREFIX=|TEXTSUFFIX=|ARROWSIZE=60mil|ARROWLINEWIDTH=10mil|ARROWLENGTH=100mil|ARROWPOSITION=Outside|EXTENSIONOFFSET=10mil|EXTENSIONLINEWIDTH=10mil|EXTENSIONPICKGAP=10mil|REFERENCES_COUNT=2|REFERENCE0PRIM=1838|REFERENCE0OBJECTID=4|REFERENCE0OBJECTSTRING=Track|REFERENCE0POINTX=3700mil|REFERENCE0POINTY=2490mil|REFERENCE0ANCHOR=2|REFERENCE1PRIM=1840|REFERENCE1OBJECTID=4|REFERENCE1OBJECTSTRING=Track|REFERENCE1POINTX=3600mil|REFERENCE1POINTY=2590mil|REFERENCE1ANCHOR=1|TEXT1X=4363.9612mil|TEXT1Y=2424.0323mil|TEXT1ANGLE= 9.00000000000000E+0001|TEXT1MIRROR=FALSE|USETTFONTS=FALSE|BOLD=FALSE|ITALIC=FALSE|FONTNAME=Arial|ANGLE= 9.00000000000000E+0001';

describe('dimensions (Dimensions6)', () => {
  it('reads an AD dimension: the value from its points, the text where AD put it; written back byte for byte', () => {
    const bag = PropertyBag.parse(binToBytes(DIM_RECORD));
    const d = dimensionFromBag(bag, 0);
    expect([d.kind, d.layer, d.angle, d.refs.length]).toEqual([1, L.MECH1 + 1, 90, 2]);
    const g = dimensionGeometry(d);
    // 100 mil measured along 90° in inches, two decimals; the text at TEXT1X / Y, turned 90°
    expect(g.texts.map((t) => [t.text, Math.round(t.at.x / 1e4), t.rotation])).toEqual([['0.10', 4364, 90]]);
    const b = bag.toBytes(), framed = new Uint8Array(6 + b.length);
    framed.set([1, 0, b.length & 0xff, (b.length >> 8) & 0xff, 0, 0]); framed.set(b, 6);
    const back = readDimensions(framed);
    expect(bytesToBin(joinDimensions(back))).toBe(bytesToBin(framed));
  });
  it('a new dimension has the keys AD17 writes, laid out; moves carry its text; the board saves it', () => {
    const ad = new Set(PropertyBag.parse(binToBytes(DIM_RECORD)).keys());
    const d = newDimension({ kind: 1, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mm(40), y: 0 }], at: { x: 0, y: -mm(3) }, angle: 0, metric: true }, 0);
    expect([...ad].filter((k) => !d.bag.has(k))).toEqual([]);
    const g = dimensionGeometry(d);
    expect(g.texts[0]!.text).toBe('40.00');
    expect(d.bag.get('LX')).not.toBe('0mil');
    const moved = transformDimension(d, (v) => ({ x: v.x + mil(100), y: v.y }), 0);
    expect(moved.refs[0]!.x).toBe(mil(100));
    expect(parseFloat(moved.bag.get('TEXT1X')!) - parseFloat(d.bag.get('TEXT1X')!)).toBeCloseTo(100, 3);
    const doc = board();
    expect(doc.dimensions.length).toBe(2);
    doc.dimensions = [...doc.dimensions, moved]; doc.dirty.add('Dimensions6');
    expect(readPcbDoc(writePcbDoc(doc), 'x.PcbDoc').dimensions.map((x) => x.bag.get('VINDEXFORSAVE'))).toEqual(['0', '1', '2']);
  });
  it('radial, center and leader dimensions draw; a line under its text is broken', () => {
    const r = newDimension({ kind: 3, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mil(500), y: mil(400) }], at: { x: mil(212), y: mil(212) }, angle: 0, metric: false }, 0);
    expect(dimensionGeometry(r).texts[0]!.text).toBe('R299.81');
    const c = newDimension({ kind: 7, layer: L.MECH1, refs: [], at: { x: 0, y: 0 }, angle: 0, metric: false, height: mil(100) }, 0);
    expect(dimensionGeometry(c).lines.length).toBe(2);
    const l = newDimension({ kind: 4, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mil(100), y: mil(100) }], at: { x: 0, y: 0 }, angle: 0, metric: false, text: 'Note' }, 0);
    expect(dimensionGeometry(l).texts[0]!.text).toBe('Note');
    // Text placed on the line: the line splits round it
    const d = newDimension({ kind: 1, layer: L.MECH1, refs: [{ x: 0, y: 0 }, { x: mm(40), y: 0 }], at: { x: 0, y: -mm(3) }, angle: 0, metric: true }, 0);
    d.bag.set('TEXT1Y', `${(-mm(3) - mil(30)) / 1e4}mil`);
    const g = dimensionGeometry(dimensionFromBag(d.bag, 0));
    expect(g.lines.filter((x) => x.a.y === -mm(3) && x.b.y === -mm(3)).length).toBe(2);
    void layoutDimension;
  });
});

/**
 * An AD17 print of a 55 × 30 mm board (outline tracks 0.35 mm wide, a 10 mm hole at 3740.16,
 * 3149.61 mil) with a linear, a datum and an angular dimension: the numbers each test pins are
 * AD's own, read off the print and the record.
 */
describe('dimensions as AD17 prints them', () => {
  const P = (x: number, y: number) => ({ x: Math.round(x * 1e4), y: Math.round(y * 1e4) });
  const track = (i: number, a: [number, number], b: [number, number]) => ({ kind: 'track', src: { storage: 'Tracks6', index: i }, layer: L.MECH1, a: P(...a), b: P(...b), width: 137795 });
  const prims = [
    track(0, [2952.7559, 2559.0551], [2952.7559, 3740.1575]), track(1, [2952.7559, 2559.0551], [5118.1102, 2559.0551]),
    track(2, [5118.1102, 2559.0551], [5118.1102, 3740.1575]), track(3, [2952.7559, 3740.1575], [5118.1102, 3740.1575]),
    { kind: 'pad', src: { storage: 'Pads6', index: 0 }, at: P(3740.1575, 3149.6063), rotation: 0, hole: 3937008, top: { w: 0, h: 0, shape: 'round', cornerPct: 0 } },
  ] as unknown as PcbPrim[];
  const edge = dimensionEdges(prims);
  const close = (v: string | undefined, want: number, tol = 0.1) => expect(Math.abs(parseFloat(v!) - want)).toBeLessThan(tol);
  it('stroke text: ink from the position, digits a height apart, ° drawn', () => {
    const xs = (t: string) => strokeText(t, { x: 0, y: 0 }, mil(60)).flat().map((p) => p.x / 1e4);
    expect(Math.min(...xs('55.00'))).toBeCloseTo(0, 6);
    expect(strokeTextExtent('55.00', mil(60)) / 1e4).toBeCloseTo(270, 0);
    expect(strokeTextExtent('0.00', mil(60)) / 1e4).toBeCloseTo(210, 0);
    expect(strokeText('°', { x: 0, y: 0 }, mil(60)).length).toBe(1);
  });
  it('linear: arrows 60 along and 20 across, the pick gap off the track edge, the value centred as Auto puts it', () => {
    const d = newDimension({ kind: 1, layer: (L.MECH1 + 2) as LayerId, refs: [P(2952.7559, 2559.0551), P(5118.1102, 2559.0551)], at: P(4000, 2401.5748), angle: 0, metric: true,
      objects: [{ prim: 0, id: 4, name: 'Track', anchor: 1 }, { prim: 2, id: 4, name: 'Track', anchor: 1 }] }, 0, edge);
    expect(d.bag.get('X1')).toBe('2952.7559mil');
    close(d.bag.get('TEXT1X'), 3884.4767); close(d.bag.get('TEXT1Y'), 2365.5845);
    close(d.bag.get('HY'), 2547.1654);
    const g = dimensionGeometry(d, false, edge);
    const ext = g.lines[0]!;
    expect(ext.a.y / 1e4).toBeCloseTo(2542.1654, 2);
    expect(ext.b.y / 1e4).toBeCloseTo(2391.5748, 2);
    const wing = g.lines.find((l) => l.a.x === g.lines[2]!.a.x && l.a.y === g.lines[2]!.a.y && l.b.y > l.a.y)!;
    expect((wing.b.x - wing.a.x) / 1e4).toBeCloseTo(60, 3);
    expect((wing.b.y - wing.a.y) / 1e4).toBeCloseTo(20, 3);
    // The line breaks 16 mil (text gap and stroke) either side of the ink
    const parts = g.lines.filter((l) => l.a.y === l.b.y && Math.abs(l.a.y / 1e4 - 2401.5748) < 0.01);
    expect(parts.length).toBe(2);
    expect(parts[0]!.b.x / 1e4).toBeCloseTo(3884.43 - 16, 0);
  });
  it('datum: lines from each point (its edge plus the gap) to the text line, values past their ends', () => {
    const d = newDimension({ kind: 5, layer: (L.MECH1 + 2) as LayerId, refs: [P(3740.1575, 3149.6063), P(5118.1102, 3740.1575), P(5118.1102, 2559.0551)], at: P(4566.9291, 2795.2756), angle: 0, metric: false,
      objects: [{ prim: 0, id: 2, name: 'Pad', anchor: 1 }, { prim: 2, id: 4, name: 'Track', anchor: 2 }, { prim: 1, id: 4, name: 'Track', anchor: 2 }] }, 0, edge);
    close(d.bag.get('X1'), 3740.1575); close(d.bag.get('Y1'), 3139.6063);
    close(d.bag.get('TEXT1X'), 3629.1914); close(d.bag.get('TEXT1Y'), 2713.295);
    close(d.bag.get('TEXT3X'), 4922.1716, 2); close(d.bag.get('TEXT3Y'), 2805.2756);
    const g = dimensionGeometry(d, false, edge);
    expect(g.texts.map((t) => t.text)).toEqual(['0.00', '1377.95', '1377.95']);
    // The pad's line starts 10 mil off its 10 mm hole and ends on the text line
    expect(g.lines[0]!.a.y / 1e4).toBeCloseTo(2942.7559, 2);
    expect(g.lines[0]!.b.y / 1e4).toBeCloseTo(2795.2756, 2);
  });
  it('angular: an arm picked as one point twice shows 180°, the arc kept where its text is', () => {
    const b = PropertyBag.fromEntries([
      ['DIMENSIONKIND', '2'], ['LAYER', 'MECHANICAL3'], ['X1', '3307.0866mil'], ['Y1', '2992.126mil'], ['TEXTX', '3976.378mil'], ['TEXTY', '2755.9055mil'],
      ['LINEWIDTH', '10mil'], ['TEXTHEIGHT', '60mil'], ['TEXTLINEWIDTH', '6mil'], ['TEXTGAP', '10mil'], ['TEXTFORMAT', '%d°'], ['TEXTDIMENSIONUNIT', 'Degrees'], ['TEXTPRECISION', '2'],
      ['ARROWSIZE', '60mil'], ['EXTENSIONOFFSET', '10mil'], ['EXTENSIONPICKGAP', '10mil'], ['REFERENCES_COUNT', '4'],
      ['REFERENCE0PRIM', '0'], ['REFERENCE0OBJECTID', '4'], ['REFERENCE0POINTX', '2952.7559mil'], ['REFERENCE0POINTY', '2559.0551mil'],
      ['REFERENCE1PRIM', '1'], ['REFERENCE1OBJECTID', '4'], ['REFERENCE1POINTX', '2952.7559mil'], ['REFERENCE1POINTY', '2559.0551mil'],
      ['REFERENCE2PRIM', '0'], ['REFERENCE2OBJECTID', '2'], ['REFERENCE2POINTX', '3740.1575mil'], ['REFERENCE2POINTY', '3149.6063mil'],
      ['REFERENCE3PRIM', '0'], ['REFERENCE3OBJECTID', '2'], ['REFERENCE3POINTX', '3740.1575mil'], ['REFERENCE3POINTY', '3149.6063mil'],
      ['TEXT1X', '3528.2915mil'], ['TEXT1Y', '3632.0734mil'], ['TEXT1ANGLE', ' 3.31927539219895E+0002'], ['TEXT1MIRROR', 'FALSE'], ['RADIUS', '709.7543mil'], ['SECTOR', '2'],
    ]);
    const g = dimensionGeometry(dimensionFromBag(b, 0), false, edge);
    expect(g.texts[0]!.text).toBe('180°');
    // The arc from -28.07° to 151.93°, broken under the text
    expect(g.arcs.length).toBe(2);
    expect(g.arcs[0]!.start).toBeCloseTo(331.93, 1);
    expect(g.arcs[1]!.end).toBeCloseTo(151.93, 1);
    // The pad's extension line starts 10 mil off its hole
    const ext = g.lines.find((l) => Math.hypot(l.a.x - 37401575, l.a.y - 31496063) < 2.1e6)!;
    expect(Math.hypot(ext.a.x - 37401575, ext.a.y - 31496063) / 1e4).toBeCloseTo(206.85, 1);
  });
});

describe('output reports', () => {
  it("Status Report.Txt as AD writes it (an AD17-era NC Drill run)", () => {
    const t = statusReport([{ name: 'NC Drill Files', type: 'NC Drill', from: 'Project [Amplifier.PrjPcb]', files: ['pcb.TXT', 'pcb.LDP', 'pcb.DRR'] }], 0, new Date(2026, 0, 5, 9, 30, 15));
    expect(t).toBe(['Output: NC Drill Files', 'Type  : NC Drill', 'From  : Project [Amplifier.PrjPcb]', '   Generated File[pcb.TXT]', '   Generated File[pcb.LDP]', '   Generated File[pcb.DRR]',
      '', '', 'Files Generated   : 3', 'Documents Printed : 0', '', 'Finished Output Generation At 09:30:15 On 05/01/2026', ''].join('\r\n'));
  });
  it('Electrical Rules Check report: Class, Document, Message, worst first', () => {
    const h = ercReportHtml('Demo.PrjPcb', [
      { level: 'warn', sheet: 'A.SchDoc', message: 'Unconnected Pin U1-3', refs: [] },
      { level: 'error', fatal: true, sheet: 'B.SchDoc', message: 'Duplicate Component Designators R1', refs: [] },
      { level: 'info', sheet: 'A.SchDoc', message: 'Compile successful', refs: [] },
    ], 0);
    expect(h).toContain('<th>Class</th><th>Document</th><th>Message</th>');
    expect(h.indexOf('Fatal Error</td><td>B.SchDoc')).toBeLessThan(h.indexOf('Warning</td><td>A.SchDoc'));
    expect(h).not.toContain('Compile successful');
  });
});

describe('fabrication and assembly outputs', () => {
  it('drill drawing: a symbol per hole size, the table at .Legend, the .GD1 / .GG1 plots', () => {
    const doc = board();
    expect(drillGroups(doc).map((g) => [Math.round(g.size / 1e4), g.holes.length, g.symbol])).toEqual([[16, 3, 0], [39, 2, 1]]);
    expect(legendStrings(doc).length).toBe(1);
    const { files } = gerberFiles(doc, { ...defaultGerberSetup(doc), drillDrawing: true, drillGuide: true });
    const gd1 = files.find((f) => f.name === 'Demo.GD1')!.text, gg1 = files.find((f) => f.name === 'Demo.GG1')!.text;
    expect(gd1.split('D01*').length).toBeGreaterThan(200); // symbols, frame, rules and stroke text
    // The guide: a cross per hole (two strokes), half the hole across
    expect(gg1).not.toContain('G03');
    expect(gg1.split('D01*').length - 1).toBe(2 * 5);
    expect(files.find((f) => f.name === 'Demo.EXTREP')!.text).toContain('Drill Drawing (Top Layer - Bottom Layer)');
  });
  it('print jobs: AD default printouts, every page over the same area', () => {
    const doc = board();
    const final = printJobPages(doc, defaultJob(doc, 'final'));
    expect(final.map((p) => p.name)).toEqual(['Top Layer', 'Bottom Layer', 'Top Overlay', 'Bottom Overlay', 'Top Solder Mask Print', 'Bottom Solder Mask Print',
      'Drill Drawing (Top Layer,Bottom Layer)', 'Drill Guide (Top Layer,Bottom Layer)']);
    expect(new Set(final.map((p) => JSON.stringify(p.box))).size).toBe(1);
    const asm = defaultJob(doc, 'assembly');
    expect(asm.printouts.map((p) => [p.name, p.mirror, p.top, p.bottom])).toEqual([['Top Layer Assembly Drawing', false, true, false], ['Bottom Layer Assembly Drawing', true, false, true]]);
    // Holes shown white, mono prints black
    const [pcb] = printJobPages(doc, defaultJob(doc, 'pcb'), 'mono');
    expect(pcb!.svg).toContain('fill="#ffffff"');
    expect(pcb!.svg).not.toMatch(/#(?!000000|ffffff)[0-9a-f]{6}/);
  });
  it('test point report: IPC-D-356A records in the standard columns', () => {
    const doc = board();
    expect(testFeatures(doc).length).toBe(13);
    const lines = ipc356(doc, { ipc: true, text: false, csv: false, units: 'in', relative: true }).split('\r\n');
    const j1 = lines.find((l) => l.startsWith('317') && l.slice(20, 26) === 'J1    ' && l.slice(27, 31) === '1   ')!;
    expect([j1.length, j1.slice(3, 17).trim(), j1[26], j1.slice(32, 38), j1.slice(38, 41), j1[41], j1[49], j1.slice(72, 74)]).toEqual([80, 'VIN', '-', 'D0394P', 'A00', 'X', 'Y', 'S3']);
    expect(lines.filter((l) => l.startsWith('327')).length).toBe(8);
    expect(lines.at(-2)).toBe('999');
  });
  it('Protel netlist: components in brackets, nets in parentheses', () => {
    const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: readSchDoc(f.bytes, f.name) }));
    const net = protelNetlist(compileProject(sheets));
    expect(net).toMatch(/^\[\r\n/);
    expect(net).toContain('(\r\nVIN\r\n');
    expect(net.split('\r\n').filter((l) => l === '[').length).toBe(compileProject(sheets).components.length);
  });
});

describe('Output Jobs (.OutJob)', () => {
  const AD = ['[OutputJobFile]', 'Version=1.0', 'Caption=', '', '[OutputGroup1]', 'Name=Job1.OutJob', 'TargetOutputMedium=Folder Structure', 'VariantName=[No Variations]',
    'OutputMedium1=PDF', 'OutputMedium1_Type=Publish', 'OutputMedium2=Folder Structure', 'OutputMedium2_Type=GeneratedFiles',
    'OutputType1=Gerber', 'OutputName1=Gerber Files', 'OutputCategory1=Fabrication', 'OutputDocumentPath1=', 'OutputVariantName1=', 'OutputEnabled1=1',
    'OutputEnabled1_OutputMedium1=0', 'OutputEnabled1_OutputMedium2=1', 'OutputDefault1=0',
    'Configuration1_Name1=OutputConfigurationParameter1', 'Configuration1_Item1=GerberUnit=Metric|NumberOfDecimals=4|LeadingAndTrailingZeroesMode=SuppressLeadingZeroes|OriginPosition=Relative|Plot.Set=SerializeLayerHash.Version~2,ClassName~TLayerToBoolean,16777217~1,16842751~1|Mirror.Set=SerializeLayerHash.Version~2,ClassName~TLayerToBoolean|Record=GerberView',
    'OutputType2=Assembly', 'OutputName2=Assembly Drawings', 'OutputCategory2=Assembly', 'OutputDocumentPath2=', 'OutputVariantName2=', 'OutputEnabled2=0',
    'OutputEnabled2_OutputMedium1=1', 'OutputEnabled2_OutputMedium2=0', 'OutputDefault2=0', 'PageOptions2=Record=PageOptions|PaperKind=A4',
    'Configuration2_Name1=OutputConfigurationParameter1', 'Configuration2_Item1=PrintArea=DesignExtent|Record=PcbPrintView',
    'Configuration2_Name2=OutputConfigurationParameter2', 'Configuration2_Item2=IncludeBottomLayerComponents=False|IncludeMultiLayerComponents=True|IncludeTopLayerComponents=True|Index=0|Mirror=False|Name=Top|Record=PcbPrintOut|ShowHoles=True',
    'Configuration2_Name3=OutputConfigurationParameter3', 'Configuration2_Item3=Layer=TopOverlay|PrintOutIndex=0|Record=PcbPrintLayer',
    '', '[GeneratedFilesSettings]', 'RelativeOutputPath2=', '', ''].join('\r\n');
  it('reads outputs and containers; an unchanged job saves identical, and the text it writes is AD\'s', () => {
    const j = readOutJob(binToBytes(AD), 'Job1.OutJob');
    expect(outJobMedia(j).map((m) => `${m.m}:${m.name}:${m.type}`)).toEqual(['1:PDF:Publish', '2:Folder Structure:GeneratedFiles']);
    expect(outJobOutputs(j).map((o) => [o.type, o.name, o.enabled, [...o.media]])).toEqual([['Gerber', 'Gerber Files', true, [[1, 0], [2, 1]]], ['Assembly', 'Assembly Drawings', false, [[1, 1], [2, 0]]]]);
    expect(bytesToBin(writeOutJob(j))).toBe(AD);
    j.dirty = true;
    expect(bytesToBin(writeOutJob(j))).toBe(AD);
  });
  it('deleting renumbers the rest with their configuration; the target container drives OutputEnabled', () => {
    const j = readOutJob(binToBytes(AD), 'Job1.OutJob');
    setOutJobOutputs(j, outJobOutputs(j).filter((o) => o.type !== 'Gerber'));
    const text = bytesToBin(writeOutJob(j));
    expect(text).toContain('OutputType1=Assembly');
    expect(text).toContain('Configuration1_Item3=Layer=TopOverlay|PrintOutIndex=0|Record=PcbPrintLayer');
    expect(text).toContain('PageOptions1=Record=PageOptions|PaperKind=A4');
    expect(text).not.toContain('OutputType2=');
    setOutJobKey(j, 'OutputGroup1', 'TargetOutputMedium', 'PDF');
    setOutJobOutputs(j, outJobOutputs(j));
    expect(bytesToBin(writeOutJob(j))).toContain('OutputEnabled1=1');
  });
  it('configurations map both ways: Gerber, NC Drill, pick and place, printouts', () => {
    const doc = board();
    const j = readOutJob(binToBytes(AD), 'Job1.OutJob');
    const [g, a] = outJobOutputs(j);
    const gs = gerberFromConfig(doc, outputConfig(g!));
    expect([gs.units, gs.decDigits, gs.layers.filter((l) => l.plot).map((l) => l.layer)]).toEqual(['mm', 4, [L.TOP, L.BOTTOM]]);
    expect(gerberFromConfig(doc, gerberToConfig(gs))).toEqual(gs);
    const ds = { ...defaultDrillSetup(), units: 'mm' as const, intDigits: 4, decDigits: 4, separatePlated: true };
    expect(drillFromConfig(drillToConfig(ds))).toEqual(ds);
    const ps = { ...defaultPnpSetup(), units: 'mil' as const, format: 'txt' as const };
    expect(pnpFromConfig(pnpToConfig(ps))).toEqual(ps);
    const pj = printJobFromConfig('assembly', 'Assembly Drawings', outputConfig(a!), defaultJob(doc, 'assembly'));
    expect(pj.printouts.map((p) => [p.name, p.layers, p.bottom, p.holes])).toEqual([['Top', [L.TOP_OVERLAY], false, true]]);
    const back: PrintJob = printJobFromConfig('drill', 'x', printJobToConfig(defaultJob(doc, 'drill'), [L.TOP, L.BOTTOM]), defaultJob(doc, 'drill'));
    expect(back.printouts).toEqual(defaultJob(doc, 'drill').printouts);
  });
  it('Demo.OutJob generates: files for the Folder Structure, pages for the PDF', async () => {
    const j = readOutJob(demoOutJob(), 'Demo.OutJob');
    expect(outJobOutputs(j).map((o) => o.name)).toEqual(['Gerber Files', 'NC Drill Files', 'Generates pick and place files', 'Bill of Materials', 'Assembly Drawings', 'Drill Drawing/Guides']);
    const notes: string[] = [];
    const all = async <T>(f: (o: ReturnType<typeof containerOutputs>[number]) => Promise<T[]>, m: number) => (await Promise.all(containerOutputs(j, m).map(f))).flat();
    expect(await all((o) => outputFiles(null, o, notes), 3)).toEqual([]);
    expect(notes.join()).toMatch(/no PCB document/); // no project here
    // In the demo project: the board and sheets come from its files
    const prj = readPrjPcb(demoPrjPcb(), 'Demo.PrjPcb');
    const p = { id: 'p1', name: 'Demo.PrjPcb', prj, files: new Map(demoFiles().map((f) => [f.name.toLowerCase(), f])) } as unknown as Project;
    const out: string[] = [];
    const names = (await all((o) => outputFiles(p, o, out), 3)).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Demo.GTL', 'Demo.GD1', 'Demo.TXT', 'Demo.DRR', 'Pick Place for Demo.csv', 'Demo.xlsx']));
    expect((await all((o) => outputPages(p, o, out), 2)).map((pg) => pg.name)).toEqual([
      'Assembly Drawings - Top Layer Assembly Drawing', 'Assembly Drawings - Bottom Layer Assembly Drawing',
      'Drill Drawing/Guides - Drill Drawing For (Top Layer,Bottom Layer)', 'Drill Drawing/Guides - Drill Guide For (Top Layer,Bottom Layer)']);
    const fresh = newOutJob('Job1.OutJob');
    const o = newOutput('Final', 'Final Artwork Prints', 'Fabrication', '', true);
    o.media.set(2, 1);
    setOutJobOutputs(fresh, [o]);
    expect(bytesToBin(writeOutJob(fresh))).toMatch(/OutputType1=Final\r\n[\s\S]*PageOptions1=Record=PageOptions/);
    expect(await outputPages(null, outJobOutputs(fresh)[0]!, notes)).toEqual([]);
  });
});
