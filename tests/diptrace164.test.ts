import { describe, expect, it } from 'vitest';
import { importDipTrace, takesDipTrace } from '../src/formats/diptrace/import';
import { exportDipTrace } from '../src/formats/diptrace/write';
import { readDipTrace, isDipTraceXml } from '../src/formats/diptrace/read';
import { convertDipTracePcb } from '../src/formats/diptrace/pcb';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { EXPORTERS } from '../src/formats/exporters';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { demoFiles, demoPcbDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { moveComponent } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { UNITS_PER_MM } from '../src/core/units';
import type { PcbDocument, PcbPad } from '../src/model/pcb';

/**
 * R12 (26.164), DipTrace both ways: DipTrace's XML boards, schematics and libraries read as AD's
 * documents; projects written as DipTrace's XML; a file read and still unchanged written back as it
 * was. The files here are made up for the tests from DipTrace's published XML description.
 */

const enc = new TextEncoder();
const LIB = `<Library Type="DipTrace-ComponentLibrary" Units="mm">
<Library Type="DipTrace-PatternLibrary" Units="mm">
<PadStyles>
<PadStyle Name="S0" Type="Surface"><MainStack Shape="Rectangle" Width="1.2" Height="0.8" Corner="25" /></PadStyle>
<PadStyle Name="S1" Type="Through" HoleType="Obround" Hole="1.6" HoleH="0.8"><MainStack Shape="Obround" Width="2.4" Height="1.6" XOff="0" YOff="0" /></PadStyle>
<PadStyle Name="S2" Type="Through" HoleType="Round" Hole="0.9"><MainStack Shape="Ellipse" Width="1.7" Height="1.7" XOff="0" YOff="0" /></PadStyle>
</PadStyles>
<Patterns>
<Pattern PatternStyle="PatType0" Id="0" RefDes="R" Mounting="SMD" Width="3" Height="1.2" Orientation="0" Type="Free">
<Name>RES_TEST</Name><Origin X="0" Y="0" />
<Pads><Pad Id="1" Style="S0" X="-1" Y="0" Angle="0" Locked="N" Side="Top"><Number>1</Number></Pad><Pad Id="2" Style="S0" X="1" Y="0" Angle="0" Locked="N" Side="Top"><Number>2</Number></Pad></Pads>
<Shapes><Shape Id="0" Type="Rectangle" Locked="N" Layer="Top Silk" LineWidth="0.15"><Points><Point X="-1.8" Y="-0.7" /><Point X="1.8" Y="0.7" /></Points></Shape>
<Shape Id="1" Type="Rectangle" Locked="N" Layer="Top Courtyard" LineWidth="0.05"><Points><Point X="-2" Y="-0.9" /><Point X="2" Y="0.9" /></Points></Shape></Shapes>
</Pattern>
<Pattern PatternStyle="PatType1" Id="1" RefDes="J" Mounting="Through" Width="6" Height="3" Orientation="0" Type="Free">
<Name>CONN_TEST</Name><Origin X="0" Y="0" />
<Pads><Pad Id="1" Style="S1" X="-1.5" Y="0" Angle="0" Locked="N" Side="Top"><Number>1</Number></Pad><Pad Id="2" Style="S2" X="1.5" Y="0" Angle="0" Locked="N" Side="Top"><Number>2</Number></Pad></Pads>
<Holes><Hole Id="0" Locked="N" X="0" Y="2" Diam="3" HoleDiam="2" /></Holes>
</Pattern>
</Patterns>
</Library>
<Components>
<Component ComponentStyle="CompType0" Id="0">
<Part Id="0" RefDes="R" PartType="Normal" Type="Free" Int1="0" Int2="0" Width="5.08" Height="2.54" LockTypeChange="N">
<Pattern Style="PatType0" /><Name>RES_TEST</Name><PartName>Part 1</PartName><Value>10k</Value><Origin X="0" Y="0" />
<Pins>
<Pin Id="0" X="-2.54" Y="0" Locked="N" Type="Default" ElectricType="Passive" Orientation="0" PadId="0" Length="2.54" ShowName="N"><Name>A</Name><PadNumber>1</PadNumber></Pin>
<Pin Id="1" X="2.54" Y="0" Locked="N" Type="Default" ElectricType="Passive" Orientation="180" PadId="1" Length="2.54" ShowName="N"><Name>B</Name><PadNumber>2</PadNumber></Pin>
</Pins>
<Shapes><Shape Id="0" Type="Rectangle" LineWidth="0.25"><Points><Point X="-2.54" Y="-1" /><Point X="2.54" Y="1" /></Points></Shape></Shapes>
</Part>
</Component>
<Component ComponentStyle="CompType1" Id="1">
<Part Id="0" RefDes="PS" PartType="Net Port" ShowNumbers="Hide" Type="Free" Int1="0" Int2="0" Width="2.54" Height="2.54" LockTypeChange="Y">
<Name>SUPPLY</Name><PartName>Part 1</PartName><Value /><Origin X="0" Y="0" />
<Pins><Pin Id="0" X="0" Y="0" Locked="N" Type="Default" ElectricType="Passive" Orientation="270" PadId="-1" Length="2.54" ShowName="N"><Name>1</Name><PadNumber>1</PadNumber></Pin></Pins>
<Shapes><Shape Id="0" Type="Line" LineWidth="0.25"><Points><Point X="-1.27" Y="0" /><Point X="1.27" Y="0" /></Points></Shape></Shapes>
</Part>
</Component>
</Components>
</Library>`;

/** A board: two layers, a resistor turned a quarter, a connector on the bottom, a trace with a via, a pour, a static via, text. */
const BOARD = `<?xml version="1.0" encoding="utf-8"?>
<Source Type="DipTrace-PCB" Version="4.3.0.3" Units="mm">
${LIB}
<Board>
<BoardOutline><Points><Point X="0" Y="0" Arc="N" /><Point X="40" Y="0" Arc="N" /><Point X="40" Y="25" Arc="N" /><Point X="0" Y="25" Arc="N" /></Points></BoardOutline>
<CopperLayers><Lay Id="0" Type="Signal" PlanePad="By Pads" PlaneRing="0.2" Color="255"><Name>Top</Name></Lay><Lay Id="1" Type="Signal" PlanePad="By Pads" PlaneRing="0.2" Color="16711680"><Name>Bottom</Name></Lay></CopperLayers>
<LayerStackItems>
<LayerStackItem Lay="0"><Material Type="Conductor" VariableThickness="N" Thickness="0.035" Constant="0" TraceWidth="0"><Name>Copper</Name></Material></LayerStackItem>
<LayerStackItem Lay="-1"><Material Type="Dielectric" VariableThickness="N" Thickness="1.5" Constant="4.4" TraceWidth="0"><Name>Core</Name></Material></LayerStackItem>
<LayerStackItem Lay="1"><Material Type="Conductor" VariableThickness="N" Thickness="0.035" Constant="0" TraceWidth="0"><Name>Copper</Name></Material></LayerStackItem>
</LayerStackItems>
<ViaStyles><ViaStyle Id="0" Size="0.7" HoleSize="0.35"><Name>Default</Name></ViaStyle></ViaStyles>
<NetClasses><NetClass Id="0" UpdateId="0" Type="Normal"><Name>Default</Name><LayProperties><LayProperty Width="0.3" MinWidth="0.15" MaxWidth="2" Clearance="0.25" /></LayProperties></NetClass></NetClasses>
<Components>
<Component Id="0" UpdateId="100" PatternStyle="PatType0" X="10" Y="12" Angle="1.570796" Side="Top" MarkingFontSize="5" MarkingFontSizeFloat="5">
<RefDes>R1</RefDes><Name>RES_TEST</Name><Value>10k</Value>
<RefDesMarking><Silk Show="Show" Align="Position" Horz="Center" Vert="Center" X="2.5" Y="0" Angle="0" /></RefDesMarking>
<Pads><Pad Id="1" NetId="0" InternalConnection="-1" /><Pad Id="2" NetId="1" InternalConnection="-1" /></Pads>
</Component>
<Component Id="1" UpdateId="101" PatternStyle="PatType1" X="30" Y="12" Side="Bottom" MarkingFontSize="5" MarkingFontSizeFloat="5">
<RefDes>J1</RefDes><Name>CONN_TEST</Name><Value />
<Pads><Pad Id="1" NetId="1" InternalConnection="-1" /><Pad Id="2" NetId="0" InternalConnection="-1" /></Pads>
</Component>
<Component Id="2" UpdateId="-1" Type="Via" ViaStyle="0" X="5" Y="5"><RefDes>V1</RefDes><Name>Via</Name><Value /><Pads><Pad Id="1" NetId="0" /></Pads></Component>
</Components>
<Nets>
<Net Id="0" HiddenId="0" NetClass="0"><Name>VIN</Name><Pads><Item Comp="0" Pad="1" /><Item Comp="1" Pad="2" /></Pads>
<Traces><Trace Id="0" Connected1="Pad" Object1="0" SubObject1="1" Point1="-1" Connected2="Pad" Object2="1" SubObject2="2" Point2="-1" PairSeparateTrace="-1"><Points>
<Point Id="0" X="10" Y="11" Lay="0" Width="0" ShieldGroup="-1" />
<Point Id="1" X="20" Y="11" Lay="0" Width="0.5" ShieldGroup="-1" ViaStyle="0" />
<Point Id="2" X="28.5" Y="11" Lay="1" Width="0.4" ShieldGroup="-1" />
<Point Id="3" X="28.5" Y="12" Lay="1" Width="0.4" ShieldGroup="-1" />
</Points></Trace></Traces></Net>
<Net Id="1" HiddenId="1" NetClass="0"><Name>GND</Name><Pads><Item Comp="0" Pad="2" /><Item Comp="1" Pad="1" /></Pads></Net>
</Nets>
<CopperPours><CopperPour Id="0" NetId="1" Lay="1" Priority="0" Poured="Y" Type="Solid" Clearance="0.4" LineWidth="0.3" LineSpacing="0.3" Spoke="4 spoke" SpokeWidth="0.3">
<Points><Point X="1" Y="1" /><Point X="39" Y="1" /><Point X="39" Y="24" /><Point X="1" Y="24" /></Points></CopperPour></CopperPours>
<Shapes>
<Shape Id="0" Type="Text" AllLayers="N" Layer="Top Silk" Angle="0" HorzAlign="Left" VertAlign="Bottom" FontVector="Y" FontSize="8" FontSizeFloat="8" FontWidth="-2" LineSpacing="1.2"><Points><Point X="2" Y="20" /></Points><TextLines><TextLine>REV A</TextLine></TextLines></Shape>
<Shape Id="1" Type="Polygon" AllLayers="N" Layer="Board Cutout"><Points><Point X="18" Y="18" /><Point X="22" Y="18" /><Point X="22" Y="22" /><Point X="18" Y="22" /></Points></Shape>
</Shapes>
</Board>
</Source>
`;

/** A schematic: the resistor turned a quarter, a supply net port, a wire, a net label, a pin marked not connected. */
const SCHEMATIC = `<?xml version="1.0" encoding="utf-8"?>
<Source Type="DipTrace-Schematic" Version="4.3.0.3" Units="mm">
${LIB}
<Schematic>
<SheetSettings><Sheets><Sheet><Id>0</Id><Name>Main</Name><Type>Normal</Type><SheetWidth>297</SheetWidth><SheetHeight>210</SheetHeight></Sheet></Sheets></SheetSettings>
<Components>
<Part Id="0" UpdateId="100" ComponentStyle="CompType0" ComponentPart="0" PartNumber="0" Sheet="0" X="50" Y="50" Angle="1.570796" MarkingFontSize="6" MarkingFontSizeFloat="6">
<RefDes>R1</RefDes><PartRefDes>1</PartRefDes><PartName>Part 1</PartName><Value>10k</Value><Name>RES_TEST</Name>
<Pins><Pin NetId="0" /><Pin NetId="1" /></Pins></Part>
<Part Id="1" UpdateId="101" ComponentStyle="CompType0" ComponentPart="0" PartNumber="0" Sheet="0" X="80" Y="50" MarkingFontSize="6" MarkingFontSizeFloat="6">
<RefDes>R2</RefDes><PartRefDes>1</PartRefDes><PartName>Part 1</PartName><Value>1k</Value><Name>RES_TEST</Name>
<Pins><Pin NetId="1" /><Pin NetId="-1" NotConnected="Y" /></Pins></Part>
<Part Id="2" UpdateId="-1" ComponentStyle="CompType1" ComponentPart="0" PartNumber="0" Sheet="0" X="50" Y="47.46">
<RefDes>PS1</RefDes><PartRefDes>1</PartRefDes><PartName>Part 1</PartName><Value>VIN</Value><Name>VIN</Name>
<Pins><Pin NetId="0" /></Pins></Part>
</Components>
<Nets>
<Net Id="0" NetClass="0"><Name>VIN</Name><Pins><Item Part="0" Pin="0" /><Item Part="2" Pin="0" /></Pins></Net>
<Net Id="1" NetClass="0"><Name>Net 3</Name><Pins><Item Part="0" Pin="1" /><Item Part="1" Pin="0" /></Pins>
<Wires><Wire Id="0" Sheet="0" Connected1="Pin" Bus1="-1" Object1="0" SubObject1="1" Connected2="Pin" Bus2="-1" Object2="1" SubObject2="0" HiddenPower="N" CanUnhide="N">
<Points><Point X="50" Y="55.08" Dir="-1" /><Point X="74.92" Y="55.08" Dir="0" /><Point X="74.92" Y="50" Dir="1" /></Points></Wire></Wires></Net>
</Nets>
<Shapes><Shape Id="0" Type="Text" Sheet="0" Angle="0" HorzAlign="Left" VertAlign="Bottom" FontVector="Y" FontSize="8" FontSizeFloat="8"><Points><Point X="40" Y="80" /></Points><TextLines><TextLine>Test sheet</TextLine></TextLines></Shape></Shapes>
</Schematic>
</Source>
`;

const mmOf = (d: PcbDocument, v: { x: number; y: number }) => ({ x: Math.round(((v.x - d.board.origin.x) / UNITS_PER_MM) * 1000) / 1000, y: Math.round(((v.y - d.board.origin.y) / UNITS_PER_MM) * 1000) / 1000 });
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

describe('DipTrace XML read (R12)', () => {
  it('knows its files by their first bytes, binary ones by name', () => {
    expect(isDipTraceXml(BOARD)).toBe(true);
    expect(takesDipTrace('b.dipxml', BOARD)).toBe(true);
    expect(takesDipTrace('b.xml', '<?xml version="1.0"?><IPC-2581/>')).toBe(false);
    expect(takesDipTrace('old.dip', '\u0000\u0001')).toBe(true);
    expect(importerFor('b.dipxml', enc.encode(BOARD))?.id).toBe('diptrace');
    expect(IMPORTERS.some((i) => i.id === 'diptrace')).toBe(true);
    expect(EXPORTERS.some((e) => e.id === 'diptrace')).toBe(true);
    const d = readDipTrace(BOARD);
    expect([d.kind, d.k, d.patterns.size, d.padStyles.size, d.components.size]).toEqual(['pcb', 1, 2, 3, 2]);
    expect(readDipTrace(BOARD.replace('Units="mm">', 'Units="inch">')).k).toBe(25.4);
  });

  it('a board: pads placed and turned anticlockwise, the bottom side mirrored, traces, vias, pours, cut-outs', () => {
    const r = convertDipTracePcb(readDipTrace(BOARD), 'B');
    const doc = readPcbDoc(r.bytes, 'B.PcbDoc');
    expect(r.stats).toMatchObject({ components: 2, nets: 2, layers: 2, pours: 1 });
    const pad = (des: string, n: string) => doc.prims.find((q): q is PcbPad => q.kind === 'pad' && q.name === n && doc.components[q.component]?.designator === des)!;
    // R1 at (10, 12) turned 90°: its pad 1 (−1, 0) lands at (10, 11), rounded corners twice DipTrace's per cent
    expect(mmOf(doc, pad('R1', '1').at)).toEqual({ x: 10, y: 11 });
    expect(pad('R1', '1').top.shape).toBe('roundrect');
    expect(pad('R1', '1').top.cornerPct).toBe(50);
    expect(doc.nets[pad('R1', '1').net]?.name).toBe('VIN');
    // J1 on the bottom: pad 1 (−1.5, 0) mirrored to (31.5, 12); its slotted hole; the pattern's mounting hole unplated
    expect(mmOf(doc, pad('J1', '1').at)).toEqual({ x: 31.5, y: 12 });
    expect(pad('J1', '1').slot?.length).toBeGreaterThan(pad('J1', '1').hole);
    expect(doc.components.find((c) => c.designator === 'J1')!.layer).toBe(L.BOTTOM);
    expect(doc.prims.some((q) => q.kind === 'pad' && q.hole > 0 && !q.plated)).toBe(true);
    // The trace: a top segment, a via, two bottom ones; the static via; the pour; the cut-out; the text
    const tracks = doc.prims.filter((q): q is Extract<typeof q, { kind: 'track' }> => q.kind === 'track' && q.net === pad('R1', '1').net);
    expect(tracks.filter((q) => q.layer === L.TOP).length).toBe(1);
    expect(tracks.filter((q) => q.layer === L.BOTTOM).length).toBe(2);
    expect(doc.prims.filter((q) => q.kind === 'via').map((v) => mmOf(doc, (v as { at: { x: number; y: number } }).at))).toEqual(expect.arrayContaining([{ x: 20, y: 11 }, { x: 5, y: 5 }]));
    expect(doc.polygons.length).toBe(1);
    expect(doc.prims.some((q) => q.kind === 'region' && q.boardCutout)).toBe(true);
    expect(doc.prims.some((q) => q.kind === 'text' && q.text === 'REV A')).toBe(true);
    expect(r.footprints.map((f) => f.name).sort()).toEqual(['CONN_TEST', 'RES_TEST']);
  });

  it('a schematic with its board: one project, nets as DipTrace has them, a net port a power port', async () => {
    const r = await importDipTrace([{ path: 'p/test.dchxml', bytes: enc.encode(SCHEMATIC) }, { path: 'p/test.dipxml', bytes: enc.encode(BOARD) }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(r.projects.length).toBe(1);
    const docs = r.projects[0]!.documents.map((d) => d.name).sort();
    expect(docs).toEqual(['test.PcbDoc', 'test.PcbLib', 'test.SchDoc', 'test.SchLib']);
    expect(iniGet(readPrjPcb(r.projects[0]!.prj.bytes, 'test.PrjPcb'), 'Design', 'HierarchyMode')).toBe('3');
    const sh = r.projects[0]!.documents.filter((d) => /SchDoc$/.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    const c = compileProject(sh, { scope: 3 });
    const pins = (n: string) => c.nets.find((x) => x.name === n)?.pins.map((p) => `${p.designator}.${p.pin}`).sort();
    expect(pins('VIN')).toEqual(['R1.1']);
    const other = c.nets.find((n) => n.pins.some((p) => p.designator === 'R2' && p.pin === '1'))!;
    expect(other.pins.map((p) => `${p.designator}.${p.pin}`).sort()).toEqual(['R1.2', 'R2.1']);
    const objs = sh[0]!.doc.objects;
    expect(objs.some((o) => o.kind === 'power' && o.text === 'VIN')).toBe(true);
    expect(objs.some((o) => o.kind === 'noerc')).toBe(true);
    expect(objs.filter((o) => o.kind === 'component').length).toBe(2);
    // The board's automatic net takes the schematic's name for it
    const b = readPcbDoc(r.projects[0]!.documents.find((d) => /PcbDoc$/.test(d.name))!.bytes, 'test.PcbDoc');
    expect(b.nets.map((n) => n.name)).toContain('VIN');
    expect(b.nets.map((n) => n.name)).toContain('GND');
  });

  it('a component library: its symbols and the patterns they use', async () => {
    const r = await importDipTrace([{ path: 'lib.elixml', bytes: enc.encode(`<?xml version="1.0"?>\n${LIB.replace('<Library Type="DipTrace-ComponentLibrary" Units="mm">', '<Library Type="DipTrace-ComponentLibrary" Version="4.3.0.3" Units="mm">')}`) }]);
    expect(r.libraries.map((l) => l.name).sort()).toEqual(['lib.PcbLib', 'lib.SchLib']);
    expect(r.messages.some((m) => /2 components, 2 patterns/.test(m.message))).toBe(true);
  });

  it('DipTrace\'s binary files: named, with how to export them', async () => {
    const r = await importDipTrace([{ path: 'old.dch', bytes: new Uint8Array([0, 1, 2, 3]) }]);
    expect(r.messages[0]?.message).toMatch(/DipTrace XML/);
  });
});

describe('DipTrace XML written (R12)', () => {
  const board = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const sheets = () => demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) }));

  it('a project and back: the same nets, pads in their places on their nets, routing kept', async () => {
    const b0 = board(), s0 = sheets();
    const r = exportDipTrace({ name: 'Demo', sheets: s0, board: b0, schLibs: [], pcbLibs: [], hierarchyMode: 2, variables: [] });
    expect(r.files.map((f) => f.path).sort()).toEqual(['Demo/Demo.dchxml', 'Demo/Demo.dipxml', 'Demo/Demo.elixml']);
    const text = new TextDecoder().decode(r.files.find((f) => f.path.endsWith('.dipxml'))!.bytes);
    expect(text).toMatch(/<Source Type="DipTrace-PCB" Version="[\d.]+" Units="mm">/);
    // Lists dense from 0, as DipTrace resolves them by place
    for (const tag of ['Component', 'Net', 'CopperPour']) {
      const ids = [...text.matchAll(new RegExp(`<${tag} Id="(\\d+)"`, 'g'))].map((m) => Number(m[1]));
      expect(ids).toEqual(ids.map((_, i) => i));
    }
    const back = await importDipTrace(r.files.filter((f) => /\.(dchxml|dipxml)$/.test(f.path)));
    const pr = back.projects[0]!;
    const key = (pins: { designator: string; pin: string }[]) => pins.map((p) => `${p.designator}.${p.pin}`).sort().join(',');
    const c0 = compileProject(s0, { scope: 2 });
    const c1 = compileProject(pr.documents.filter((d) => /SchDoc$/.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) })), { scope: 3 });
    expect(new Set(c1.nets.map((n) => key(n.pins)))).toEqual(new Set(c0.nets.map((n) => key(n.pins))));
    const b1 = readPcbDoc(pr.documents.find((d) => /PcbDoc$/.test(d.name))!.bytes, 'B.PcbDoc');
    const pads = (d: PcbDocument) => new Map(d.prims.filter((q): q is PcbPad => q.kind === 'pad' && q.component >= 0 && q.component < d.components.length)
      .map((q) => [`${d.components[q.component]!.designator}.${q.name}`, { ...mmOf(d, q.at), net: d.nets[q.net]?.name ?? '' }]));
    const p0 = pads(b0), p1 = pads(b1);
    expect(p1.size).toBe(p0.size);
    for (const [k, v] of p0) { expect(p1.get(k)?.x).toBeCloseTo(v.x, 3); expect(p1.get(k)?.y).toBeCloseTo(v.y, 3); expect(p1.get(k)?.net).toBe(v.net); }
    expect(b1.prims.filter((q) => q.kind === 'via').length).toBe(b0.prims.filter((q) => q.kind === 'via').length);
    expect(b1.polygons.length).toBe(b0.polygons.length);
  });

  it('a board and schematic read from DipTrace and unchanged: the files as DipTrace wrote them; changed, written anew', async () => {
    const r = await importDipTrace([{ path: 'p/test.dchxml', bytes: enc.encode(SCHEMATIC) }, { path: 'p/test.dipxml', bytes: enc.encode(BOARD) }]);
    const pr = r.projects[0]!;
    const pcb = pr.documents.find((d) => /PcbDoc$/.test(d.name))!;
    const sh = pr.documents.filter((d) => /SchDoc$/.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    const out = exportDipTrace({ name: 'test', sheets: sh, board: readPcbDoc(pcb.bytes, pcb.name), schLibs: [], pcbLibs: [], hierarchyMode: 3, variables: [] });
    expect(same(out.files.find((f) => f.path === 'test/test.dipxml')?.bytes, enc.encode(BOARD))).toBe(true);
    expect(same(out.files.find((f) => f.path === 'test/test.dchxml')?.bytes, enc.encode(SCHEMATIC))).toBe(true);
    expect(out.messages.some((m) => /unchanged/.test(m.message))).toBe(true);
    const moved = readPcbDoc(pcb.bytes, pcb.name);
    moveComponent(moved, 0, { x: UNITS_PER_MM, y: 0 }, 0).apply();
    const out2 = exportDipTrace({ name: 'test', sheets: sh, board: readPcbDoc(writePcbDoc(moved), pcb.name), schLibs: [], pcbLibs: [], hierarchyMode: 3, variables: [] });
    const written = out2.files.find((f) => f.path === 'test/test.dipxml')!;
    expect(same(written.bytes, enc.encode(BOARD))).toBe(false);
    expect(same(out2.files.find((f) => f.path === 'test/test.dchxml')?.bytes, enc.encode(SCHEMATIC))).toBe(true);
    // Written anew, it reads back with R1 a millimetre along
    const again = convertDipTracePcb(readDipTrace(written.bytes), 'A');
    const d2 = readPcbDoc(again.bytes, 'A.PcbDoc');
    const r1 = d2.components.find((c) => c.designator === 'R1')!;
    expect(mmOf(d2, r1.at)).toEqual({ x: 11, y: 12 });
  });
});
