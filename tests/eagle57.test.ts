import { describe, expect, it } from 'vitest';
import { importEagle, takesEagle } from '../src/formats/eagle/import';
import { exportEagle, eagleName } from '../src/formats/eagle/write';
import { placer, textLook, labelOrient } from '../src/formats/eagle/sch';
import { readEagle, rotOf, overbar } from '../src/formats/eagle/read';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { EXPORTERS } from '../src/formats/exporters';
import { load } from '../src/formats/registry';
import { compileProject } from '../src/model/compile';
import { compareProject } from '../src/model/comparator';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { demoFiles } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { UNITS_PER_MM } from '../src/core/units';
import type { SchDocument } from '../src/model/sch';
import type { PcbDocument, PcbPad } from '../src/model/pcb';

const enc = new TextEncoder();
const LAYERS = `<layers>${[[1, 'Top'], [16, 'Bottom'], [20, 'Dimension'], [21, 'tPlace'], [25, 'tNames'], [27, 'tValues'], [46, 'Milling'], [91, 'Nets'], [94, 'Symbols'], [95, 'Names'], [96, 'Values']]
  .map(([n, s]) => `<layer number="${n}" name="${s}" color="1" fill="1" visible="yes" active="yes"/>`).join('')}</layers>`;
/** A small library: a resistor, a header (its pin 2 on pads 2 and 3, pad 3 slotted by a milling outline), a dual gate with a power gate added on request, a ground supply. */
const LIB = `<library name="test">
<packages>
<package name="R0603"><smd name="1" x="-0.75" y="0" dx="0.8" dy="0.9" layer="1"/><smd name="2" x="0.75" y="0" dx="0.8" dy="0.9" layer="1" roundness="50"/>
<wire x1="-1.4" y1="0.7" x2="1.4" y2="0.7" width="0.127" layer="21"/><text x="-1" y="1" size="0.8" layer="25">&gt;NAME</text></package>
<package name="HDR3"><pad name="1" x="0" y="0" drill="1" diameter="1.8" shape="square"/><pad name="2" x="2.54" y="0" drill="1"/><pad name="3" x="5.08" y="0" drill="0.6" diameter="1.2" shape="long" rot="R90"/>
<wire x1="4.78" y1="-0.8" x2="5.38" y2="-0.8" width="0" layer="46"/><wire x1="5.38" y1="-0.8" x2="5.38" y2="0.8" width="0" layer="46"/><wire x1="5.38" y1="0.8" x2="4.78" y2="0.8" width="0" layer="46"/><wire x1="4.78" y1="0.8" x2="4.78" y2="-0.8" width="0" layer="46"/></package>
<package name="Q6">${[1, 2, 3, 4, 5, 6].map((i) => `<smd name="${i}" x="${(i - 3.5) * 0.65}" y="-1" dx="0.4" dy="1" layer="1"/>`).join('')}</package>
</packages>
<symbols>
<symbol name="R"><wire x1="-2.54" y1="0.889" x2="2.54" y2="0.889" width="0.254" layer="94"/><wire x1="-2.54" y1="-0.889" x2="2.54" y2="-0.889" width="0.254" layer="94"/>
<text x="-2.54" y="1.27" size="1.778" layer="95">&gt;NAME</text><text x="-2.54" y="-3.81" size="1.778" layer="96">&gt;VALUE</text>
<pin name="1" x="-5.08" y="0" visible="off" length="short" direction="pas"/><pin name="2" x="5.08" y="0" visible="off" length="short" direction="pas" rot="R180"/></symbol>
<symbol name="HDR"><wire x1="0" y1="2.54" x2="0" y2="-5.08" width="0.254" layer="94"/><text x="0" y="3.81" size="1.778" layer="95">&gt;NAME</text>
<pin name="1" x="5.08" y="0" length="short" rot="R180"/><pin name="2" x="5.08" y="-2.54" length="short" rot="R180"/></symbol>
<symbol name="GATE"><wire x1="-2.54" y1="2.54" x2="2.54" y2="0" width="0.254" layer="94"/><wire x1="2.54" y1="0" x2="-2.54" y2="-2.54" width="0.254" layer="94"/><wire x1="-2.54" y1="-2.54" x2="-2.54" y2="2.54" width="0.254" layer="94"/>
<text x="-2.54" y="3.81" size="1.778" layer="95">&gt;NAME</text><pin name="IN" x="-7.62" y="0" length="middle" direction="in"/><pin name="OUT" x="7.62" y="0" length="middle" direction="out" rot="R180" function="dot"/></symbol>
<symbol name="PWRN"><pin name="VCC" x="0" y="5.08" length="middle" direction="pwr" rot="R270"/><pin name="GND" x="0" y="-5.08" length="middle" direction="pwr" rot="R90"/></symbol>
<symbol name="GND"><wire x1="-1.905" y1="0" x2="1.905" y2="0" width="0.254" layer="94"/><text x="-1.905" y="-2.54" size="1.778" layer="96">&gt;VALUE</text>
<pin name="GND" x="0" y="2.54" visible="off" length="short" direction="sup" rot="R270"/></symbol>
</symbols>
<devicesets>
<deviceset name="R-" prefix="R" uservalue="yes"><gates><gate name="G$1" symbol="R" x="0" y="0"/></gates><devices><device name="0603" package="R0603"><connects><connect gate="G$1" pin="1" pad="1"/><connect gate="G$1" pin="2" pad="2"/></connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="HEADER" prefix="J"><gates><gate name="G$1" symbol="HDR" x="0" y="0"/></gates><devices><device name="" package="HDR3"><connects><connect gate="G$1" pin="1" pad="1"/><connect gate="G$1" pin="2" pad="2 3"/></connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="DUAL" prefix="U"><gates><gate name="A" symbol="GATE" x="0" y="0"/><gate name="B" symbol="GATE" x="0" y="10"/><gate name="P" symbol="PWRN" x="20" y="0" addlevel="request"/></gates>
<devices><device name="" package="Q6"><connects><connect gate="A" pin="IN" pad="1"/><connect gate="A" pin="OUT" pad="2"/><connect gate="B" pin="IN" pad="3"/><connect gate="B" pin="OUT" pad="4"/><connect gate="P" pin="VCC" pad="5"/><connect gate="P" pin="GND" pad="6"/></connects><technologies><technology name=""/></technologies></device></devices></deviceset>
<deviceset name="GND" prefix="GND"><gates><gate name="1" symbol="GND" x="0" y="0"/></gates><devices><device name=""><technologies><technology name=""/></technologies></device></devices></deviceset>
</devicesets>
</library>`;
const head = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE eagle SYSTEM "eagle.dtd">\n<eagle version="9.6.2"><drawing>${LAYERS}${inner}</drawing></eagle>`;
/** Two sheets: VIN by its labels on both, a net no label names, grounds by supply symbols, a part mirrored and turned (MR90), a dual gate's two gates on two sheets, its power gate not placed. */
const SCH = head(`<schematic><libraries>${LIB}</libraries><parts>
<part name="R1" library="test" deviceset="R-" device="0603" value="10k"/><part name="R2" library="test" deviceset="R-" device="0603" value="4k7"/>
<part name="J1" library="test" deviceset="HEADER" device=""/><part name="U1" library="test" deviceset="DUAL" device=""/>
<part name="GND1" library="test" deviceset="GND" device=""/><part name="GND2" library="test" deviceset="GND" device=""/></parts>
<sheets>
<sheet><plain><text x="10" y="70" size="2.54" layer="97">Sheet one</text></plain><instances>
<instance part="R1" gate="G$1" x="20.32" y="50.8" smashed="yes"><attribute name="NAME" x="17.78" y="53.34" size="1.778" layer="95"/><attribute name="VALUE" x="17.78" y="46.99" size="1.778" layer="96"/></instance>
<instance part="U1" gate="A" x="40.64" y="50.8"/></instances>
<nets><net name="VIN" class="0"><segment><wire x1="10.16" y1="50.8" x2="15.24" y2="50.8" width="0.1524" layer="91"/><label x="10.16" y="50.8" size="1.778" layer="95"/><pinref part="R1" gate="G$1" pin="1"/></segment></net>
<net name="N$1" class="0"><segment><wire x1="25.4" y1="50.8" x2="33.02" y2="50.8" width="0.1524" layer="91"/><pinref part="R1" gate="G$1" pin="2"/><pinref part="U1" gate="A" pin="IN"/></segment></net></nets></sheet>
<sheet><plain/><instances>
<instance part="R2" gate="G$1" x="30.48" y="40.64" rot="MR90"/>
<instance part="J1" gate="G$1" x="10.16" y="30.48"/>
<instance part="GND1" gate="1" x="30.48" y="48.26" rot="R180"/>
<instance part="GND2" gate="1" x="17.78" y="25.4"/>
<instance part="U1" gate="B" x="50.8" y="30.48"/></instances>
<nets><net name="VIN" class="0"><segment><wire x1="15.24" y1="30.48" x2="20.32" y2="30.48" width="0.1524" layer="91"/><wire x1="20.32" y1="30.48" x2="30.48" y2="30.48" width="0.1524" layer="91"/>
<wire x1="30.48" y1="30.48" x2="30.48" y2="35.56" width="0.1524" layer="91"/><label x="20.32" y="31" size="1.778" layer="95"/><pinref part="J1" gate="G$1" pin="1"/><pinref part="R2" gate="G$1" pin="1"/></segment></net>
<net name="GND" class="0"><segment><wire x1="30.48" y1="45.72" x2="30.48" y2="45.72" width="0.1524" layer="91"/><pinref part="R2" gate="G$1" pin="2"/><pinref part="GND1" gate="1" pin="GND"/></segment>
<segment><wire x1="15.24" y1="27.94" x2="17.78" y2="27.94" width="0.1524" layer="91"/><pinref part="J1" gate="G$1" pin="2"/><pinref part="GND2" gate="1" pin="GND"/></segment></net></nets></sheet>
</sheets></schematic>`);
const BRD = head(`<board><plain><wire x1="0" y1="0" x2="40" y2="0" width="0" layer="20"/><wire x1="40" y1="0" x2="40" y2="25" width="0" layer="20"/><wire x1="40" y1="25" x2="0" y2="25" width="0" layer="20" curve="-20"/><wire x1="0" y1="25" x2="0" y2="0" width="0" layer="20"/>
<text x="2" y="2" size="1.27" layer="21">TEST</text></plain>
<libraries>${LIB}</libraries>
<classes><class number="0" name="default" width="0" drill="0"/><class number="1" name="power" width="0.4" drill="0"><clearance class="1" value="0.3"/></class></classes>
<designrules name="t"><param name="mdWireWire" value="8mil"/><param name="msWidth" value="6mil"/><param name="msDrill" value="0.3mm"/><param name="rvPadTop" value="0.25"/><param name="rlMinPadTop" value="10mil"/><param name="rlMaxPadTop" value="20mil"/>
<param name="rvPadInner" value="0.25"/><param name="rlMinPadInner" value="10mil"/><param name="rlMaxPadInner" value="20mil"/><param name="rvPadBottom" value="0.25"/><param name="rlMinPadBottom" value="10mil"/><param name="rlMaxPadBottom" value="20mil"/>
<param name="rvViaOuter" value="0.25"/><param name="rlMinViaOuter" value="8mil"/><param name="rlMaxViaOuter" value="20mil"/><param name="mlMinStopFrame" value="2mil"/><param name="mlMaxStopFrame" value="2mil"/><param name="useDiameter" value="13"/></designrules>
<elements>
<element name="R1" library="test" package="R0603" value="10k" x="10" y="10" smashed="yes"><attribute name="NAME" x="9" y="11" size="0.8" layer="25"/></element>
<element name="R2" library="test" package="R0603" value="4k7" x="20" y="10" rot="R90"/>
<element name="U1" library="test" package="Q6" value="DUAL" x="30" y="12"/>
<element name="J1" library="test" package="HDR3" value="HEADER" x="15" y="20" rot="MR0"/>
</elements>
<signals>
<signal name="VIN" class="1"><contactref element="R1" pad="1"/><contactref element="R2" pad="1"/><contactref element="J1" pad="1"/>
<wire x1="9.25" y1="10" x2="9.25" y2="20" width="0.4" layer="1"/><wire x1="9.25" y1="20" x2="15" y2="20" width="0.4" layer="1"/><wire x1="20" y1="9.25" x2="20" y2="5" width="0.4" layer="1" curve="45"/></signal>
<signal name="GND"><contactref element="R2" pad="2"/><contactref element="J1" pad="2"/><contactref element="J1" pad="3"/><contactref element="U1" pad="6"/>
<via x="25" y="15" extent="1-16" drill="0.3"/>
<polygon width="0.254" layer="16" rank="1"><vertex x="1" y="1"/><vertex x="39" y="1"/><vertex x="39" y="24"/><vertex x="1" y="24"/></polygon></signal>
<signal name="N$1"><contactref element="R1" pad="2"/><contactref element="U1" pad="1"/></signal>
<signal name="VCC"><contactref element="U1" pad="5"/></signal>
</signals></board>`);
const LBR = head(LIB);

const files = [{ path: 'demo/T.sch', bytes: enc.encode(SCH) }, { path: 'demo/T.brd', bytes: enc.encode(BRD) }];
const netlist = (sheets: { name: string; doc: SchDocument }[]) =>
  new Map(compileProject(sheets, { scope: 3 }).nets.map((n) => [n.name, n.pins.map((q) => `${q.designator}.${q.pin}`).sort().join(' ')]));
const docsOf = (p: { documents: { name: string; bytes: Uint8Array }[] }) => ({
  sheets: p.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: load(d.bytes, d.name) as SchDocument })),
  board: load(p.documents.find((d) => /\.pcbdoc$/i.test(d.name))!.bytes, 'T.PcbDoc') as PcbDocument,
});
const mm = (c: number) => Math.round((c / UNITS_PER_MM) * 1000) / 1000;

describe('EAGLE import and export (26.057)', () => {
  it('EAGLE\'s placement: turned, then mirrored (MR90 maps x, y to y, x); text kept readable, mirrored text from its other end', () => {
    const pl = placer(0, 0, rotOf('MR90'));
    expect(pl.pt({ x: 1, y: 2 })).toEqual({ x: 2, y: 1 });
    expect(placer(0, 0, rotOf('MR270')).pt({ x: 1, y: 2 })).toEqual({ x: -2, y: -1 });
    // R180: drawn at 0° from the other corner; MR0: at 0°, from its right end
    expect(textLook(rotOf('R180'), undefined)).toEqual({ ORIENTATION: 0, JUSTIFICATION: 8 });
    expect(textLook(rotOf('MR0'), undefined)).toEqual({ ORIENTATION: 0, JUSTIFICATION: 2 });
    expect(textLook(rotOf('SR180'), undefined).ORIENTATION).toBe(2);
    expect(labelOrient(rotOf('MR0'))).toBe(2);
    expect(overbar('!RESET!')).toBe('R\\E\\S\\E\\T\\');
    expect(eagleName('R\\E\\S\\E\\T\\')).toBe('!RESET!');
    expect(eagleName('my net, 2')).toBe('MY_NET__2');
  });

  it('takes EAGLE\'s XML by its bytes (not PADS\' or Allegro\'s files of the same extensions), names EAGLE 5\'s binary files', async () => {
    expect(IMPORTERS.some((i) => i.id === 'eagle')).toBe(true);
    expect(importerFor('T.sch', enc.encode(SCH))?.id).toBe('eagle');
    expect(importerFor('T.brd', enc.encode(BRD))?.id).toBe('eagle');
    expect(importerFor('L.lbr', enc.encode(LBR))?.id).toBe('eagle');
    expect(takesEagle('x.sch', '*PADS-LOGIC-V9.0*')).toBe(false);
    const old = new Uint8Array([0x10, 0x00, 0x25, 0x00, 1, 2, 3]);
    expect(takesEagle('old.brd', new TextDecoder().decode(old))).toBe(true);
    const r = await importEagle([{ path: 'old.brd', bytes: old }]);
    expect(r.projects).toEqual([]);
    expect(r.messages[0]!.message).toMatch(/EAGLE 5 or earlier/);
  });

  it('imports a schematic and board of one name as one project: EAGLE\'s nets kept (labels, supply symbols, a power gate never placed), the board as EAGLE\'s rules size it', async () => {
    const r = await importEagle(files);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(r.projects.length).toBe(1);
    const p = r.projects[0]!;
    expect(p.documents.map((d) => d.name)).toEqual(['T_1.SchDoc', 'T_2.SchDoc', 'T.SchLib', 'T.PcbDoc', 'T.PcbLib']);
    expect(iniGet(readPrjPcb(p.prj.bytes, p.prj.name), 'Design', 'HierarchyMode')).toBe('3');
    const { sheets, board } = docsOf(p);
    const nets = netlist(sheets);
    expect(nets.get('VIN')).toBe('J1.1 R1.1 R2.1');
    expect(nets.get('GND')).toBe('J1.2 J1.3 R2.2 U1.6');
    expect(nets.get('VCC')).toBe('U1.5');
    expect([...nets.values()]).toContain('R1.2 U1.1');
    // The board: the automatic net takes the schematic's name; pads by the restring rules; the slot; the bottom part
    const padNet = new Map(board.prims.filter((q): q is PcbPad => q.kind === 'pad').map((q) => [`${board.components[q.component]?.designator}.${q.name}`, board.nets[q.net]?.name]));
    expect(padNet.get('R1.2')).toBe(padNet.get('U1.1'));
    expect(padNet.get('R1.2')).toBe([...nets].find(([, v]) => v === 'R1.2 U1.1')![0]);
    const pad = (des: string, name: string) => board.prims.find((q): q is PcbPad => q.kind === 'pad' && board.components[q.component]?.designator === des && q.name === name)!;
    expect(mm(pad('J1', '1').top.w)).toBe(1.8);
    expect(pad('J1', '1').top.shape).toBe('rect');
    expect(mm(pad('J1', '2').top.w)).toBe(1.508);
    expect(pad('J1', '3').slot).toBeTruthy();
    expect(mm(pad('J1', '3').hole)).toBe(0.6);
    expect(pad('R1', '2').top.shape).toBe('roundrect');
    expect(board.components.find((c) => c.designator === 'J1')!.layer).toBe(L.BOTTOM);
    expect(pad('J1', '1').layer).toBe(L.MULTI);
    expect(board.components.find((c) => c.designator === 'R2')!.rotation).toBe(90);
    const via = board.prims.find((q) => q.kind === 'via')!;
    expect(via.kind === 'via' && mm(via.diameter)).toBe(0.706);
    expect(board.polygons.length).toBe(1);
    expect(board.prims.some((q) => q.kind === 'arc' && q.net >= 0)).toBe(true);
    expect(board.classes.some((c) => c.name === 'power' && c.members.includes('VIN'))).toBe(true);
    // Schematic and board agree
    expect(compareProject(compileProject(sheets, { scope: 3 }), board, () => undefined)).toEqual([]);
  });

  it('imports a library: its devices as a SchLib, its packages as a PcbLib', async () => {
    const r = await importEagle([{ path: 'parts.lbr', bytes: enc.encode(LBR) }]);
    expect(r.libraries.map((l) => l.name)).toEqual(['parts.SchLib', 'parts.PcbLib']);
    expect(r.messages[0]!.message).toBe('Library: 4 devices, 3 packages');
  });

  it('exports EAGLE\'s files that come back the same: nets, parts, pads and their nets', async () => {
    expect(EXPORTERS.some((e) => e.id === 'eagle')).toBe(true);
    const first = docsOf((await importEagle(files)).projects[0]!);
    // Changed in Konium (a sheet's grid, the board's), so written from Konium's, not kept as EAGLE wrote them (R13)
    first.sheets.forEach((sh) => sh.doc.records.find((r) => r.bag?.int('RECORD', -1) === 31)?.bag?.set('SNAPGRIDSIZE', '7'));
    first.board.board.bag!.set('SNAPGRIDSIZE', '70000');
    const ex = exportEagle({ name: 'T', sheets: first.sheets, board: first.board, schLibs: [], pcbLibs: [], hierarchyMode: 3, variables: [] });
    expect(ex.messages.some((m) => /unchanged since|as EAGLE wrote it but for/.test(m.message))).toBe(false);
    expect(ex.files.map((f) => f.path)).toEqual(['T/T.sch', 'T/T.brd', 'T/t.lbr']);
    expect(ex.messages.filter((m) => m.level === 'error')).toEqual([]);
    const sch = readEagle(ex.files[0]!.bytes);
    expect(sch.kind).toBe('sch');
    expect(readEagle(ex.files[1]!.bytes).kind).toBe('brd');
    expect(readEagle(ex.files[2]!.bytes).kind).toBe('lbr');
    const back = await importEagle(ex.files.filter((f) => /\.(sch|brd)$/.test(f.path)));
    const again = docsOf(back.projects[0]!);
    const part = (m: Map<string, string>) => new Set([...m.values()].filter((v) => v.includes(' ')));
    expect(part(netlist(again.sheets))).toEqual(part(netlist(first.sheets)));
    const pads = (b: PcbDocument) => b.prims.filter((q): q is PcbPad => q.kind === 'pad').map((q) => `${b.components[q.component]?.designator}.${q.name}:${(b.nets[q.net]?.name ?? '').toUpperCase()}:${mm(q.top.w)}x${mm(q.top.h)}`).sort();
    expect(pads(again.board)).toEqual(pads(first.board));
    expect(again.board.components.map((c) => [c.designator, c.layer, c.rotation])).toEqual(first.board.components.map((c) => [c.designator, c.layer, c.rotation]));
    expect(compareProject(compileProject(again.sheets, { scope: 3 }), again.board, () => undefined)).toEqual([]);
  });

  it('exports the demo project: its sheets, the board\'s elements and signals, a library of every device and package', () => {
    const fs = demoFiles();
    const docs = fs.filter((f) => /\.(schdoc|pcbdoc)$/i.test(f.name)).map((f) => load(f.bytes, f.name));
    const sheets = docs.filter((d): d is SchDocument => d.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d }));
    const board = docs.find((d): d is PcbDocument => d.kind === 'PcbDoc')!;
    const r = exportEagle({ name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: 0, variables: [] });
    const brd = readEagle(r.files[1]!.bytes);
    const elements = brd.board!.children.find((c) => c.name === 'elements')!.children;
    expect(elements.map((e) => e.attrs.name).sort()).toEqual(board.components.map((c) => c.designator.toUpperCase()).sort());
    const sch = readEagle(r.files[0]!.bytes);
    expect(sch.schematic!.children.find((c) => c.name === 'sheets')!.children.length).toBe(sheets.length);
    expect(sch.libraries[0]!.packages.size).toBe(new Set(board.components.map((c) => c.pattern)).size);
  });
});

/** A module (a divider: IN, OUT; its own ground) placed twice — DIV1 by name, DIV2 with an offset of 100 — beside a header. */
const W = (x1: number, y1: number, x2: number, y2: number) => `<wire x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" width="0.1524" layer="91"/>`;
const MODSCH = head(`<schematic><libraries>${LIB}</libraries>
<modules><module name="DIV" prefix="" dx="20.32" dy="15.24"><ports><port name="IN" side="left" coord="2.54" direction="io"/><port name="OUT" side="right" coord="0" direction="io"/></ports>
<parts><part name="R1" library="test" deviceset="R-" device="0603" value="1k"/><part name="R2" library="test" deviceset="R-" device="0603" value="1k"/><part name="GND1" library="test" deviceset="GND" device=""/></parts>
<sheets><sheet><instances><instance part="R1" gate="G$1" x="20.32" y="50.8"/><instance part="R2" gate="G$1" x="40.64" y="50.8"/><instance part="GND1" gate="1" x="50.8" y="45.72"/></instances>
<nets><net name="IN"><segment>${W(10.16, 50.8, 15.24, 50.8)}<pinref part="R1" gate="G$1" pin="1"/></segment></net>
<net name="OUT"><segment>${W(25.4, 50.8, 35.56, 50.8)}<pinref part="R1" gate="G$1" pin="2"/><pinref part="R2" gate="G$1" pin="1"/></segment></net>
<net name="GND"><segment>${W(45.72, 50.8, 50.8, 50.8)}${W(50.8, 50.8, 50.8, 48.26)}<pinref part="R2" gate="G$1" pin="2"/><pinref part="GND1" gate="1" pin="GND"/></segment></net></nets></sheet></sheets></module></modules>
<parts><part name="J1" library="test" deviceset="HEADER" device=""/></parts>
<sheets><sheet><moduleinsts><moduleinst name="DIV1" module="DIV" x="60.96" y="50.8"/><moduleinst name="DIV2" module="DIV" x="60.96" y="20.32" offset="100"/></moduleinsts>
<instances><instance part="J1" gate="G$1" x="10.16" y="50.8"/></instances>
<nets><net name="VIN"><segment>${W(15.24, 50.8, 50.8, 53.34)}<pinref part="J1" gate="G$1" pin="1"/><portref moduleinst="DIV1" port="IN"/><portref moduleinst="DIV2" port="IN"/></segment></net>
<net name="MID"><segment>${W(15.24, 48.26, 71.12, 50.8)}<pinref part="J1" gate="G$1" pin="2"/><portref moduleinst="DIV1" port="OUT"/></segment></net></nets></sheet></sheets></schematic>`);

describe('EAGLE modules (26.063)', () => {
  it('each instance\'s sheets of its own, its parts named as on the board, port nets joined to the nets outside, supplies global, the instance a sheet symbol', async () => {
    const r = await importEagle([{ path: 'm/M.sch', bytes: enc.encode(MODSCH) }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    const p = r.projects[0]!;
    expect(p.documents.map((d) => d.name).filter((n) => n.endsWith('.SchDoc'))).toEqual(['M.SchDoc', 'M DIV1.SchDoc', 'M DIV2.SchDoc']);
    const sheets = p.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: load(d.bytes, d.name) as SchDocument }));
    const nets = netlist(sheets);
    expect(nets.get('VIN')).toBe('DIV1:R1.1 J1.1 R101.1');
    expect(nets.get('MID')).toBe('DIV1:R1.2 DIV1:R2.1 J1.2 J1.3'); // the header's pin 2 is on pads 2 and 3
    expect(nets.get('DIV2:OUT')).toBe('R101.2 R102.1');
    expect(nets.get('GND')).toBe('DIV1:R2.2 R102.2');
    const symbols = sheets[0]!.doc.objects.filter((o) => o.kind === 'sheetsymbol');
    expect(symbols.length).toBe(2);
    const files = sheets[0]!.doc.objects.filter((o) => o.kind === 'text' && o.role === 'filename').map((o) => (o as { text: string }).text);
    expect(files).toEqual(['M DIV1.SchDoc', 'M DIV2.SchDoc']);
    expect(r.messages.some((m) => /Modules \(EAGLE 8's hierarchy\)/.test(m.message))).toBe(true);
  });
});
