import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR } from '../src/model/sch';
import { compileProject } from '../src/model/compile';
import { channelDesignator } from '../src/model/channels';
import { readPrjPcb, writePrjPcb } from '../src/formats/altium/prjpcb';
import { binToBytes } from '../src/formats/text';
import { alternateOf, isFitted, readVariants, variantComponents, variationOf, writeVariants } from '../src/model/variants';
import { parseCsv, readTables, toTable } from '../src/formats/table';
import { xlsx } from '../src/formats/xlsx';
import { readXlsx } from '../src/formats/xlsxRead';
import { dataSource, defaultTable, newDbLink, readDbLink, writeDbLink } from '../src/formats/altium/dblink';
import { effectiveMaps } from '../src/formats/altium/dbFile';
import { dbParamChanges, type DbPart } from '../src/model/dbParams';
import { newBomDoc, readBomDoc, writeBomDoc } from '../src/formats/altium/bomdoc';
import { planPcbUpdate } from '../src/model/pcbEco';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import type { CompiledComponent } from '../src/model/compile';

/* ─── Variants as AD writes them (a real project's lines) ─── */

const KASLI = ['[Design]', 'Version=1.0', '[ProjectVariant1]', 'UniqueId=122F0B6E-98FC-43EC-BEA1-DC404694ABC3', 'Description=Si549 CMOS', 'AllowFabrication=0', 'ParameterCount=0', 'VariationCount=2',
  'Variation1=Designator=R80|UniqueId=\\TDSAQFBN|Kind=1|AlternatePart==Value', 'ParamVariation1=ParameterName=Comment|VariantValue==Value', 'ParamDesignator1=R80',
  'Variation2=Designator=R37|UniqueId=\\OIMUOFHT\\NBBXXSML|Kind=2|AlternatePart==Value|AltLibLink_LibIdentifierKind=Library Name And Type|AltLibLink_LibraryIdentifier=Resistors.DbLib/Resistors SMD|AltLibLink_SymbolReference=Resistor - 1%|AltLibLink_DesignItemID=R0402_0R_JUMPER|AltLibLink_UseLibraryName=True|AltLibLink_SourceLibraryName=Resistors.DbLib|AltLibLink_Footprint=RESC1005X40N|AltLibLink_IsSameFootprint=True',
  'ParamVariation2=ParameterName=Value|VariantValue=0R', 'ParamDesignator2=R37', 'ParamVariationCount=2', ''].join('\r\n');

const comp = (designator: string, uniqueId: string, extra: Partial<CompiledComponent> = {}): CompiledComponent => ({
  designator, comment: '10k', libRef: 'Res', footprint: 'R0402', description: '', sheet: 'A.SchDoc', parts: 1, refs: [], params: { Comment: '=Value', Value: '10k' }, uniqueId, kind: 0, ...extra,
});

describe('variants', () => {
  const p = readPrjPcb(binToBytes(KASLI), 'K.PrjPcb');
  const [v] = readVariants(p);
  it('reads AD\'s variations: alternate links, parameter variations, hierarchical unique IDs', () => {
    expect(v!.name).toBe('Si549 CMOS');
    expect(v!.variations.map((x) => [x.designator, x.uniqueId, x.kind])).toEqual([['R80', 'TDSAQFBN', 1], ['R37', 'OIMUOFHT\\NBBXXSML', 2]]);
    expect(alternateOf(v!.variations[1]!)).toEqual({ libRef: 'R0402_0R_JUMPER', footprint: 'RESC1005X40N', library: 'Resistors.DbLib', sameFootprint: true });
    expect(v!.params).toEqual([{ designator: 'R80', name: 'Comment', value: '=Value' }, { designator: 'R37', name: 'Value', value: '0R' }]);
    // A part on a child sheet: its own ID is the last part of the path
    expect(variationOf(v, 'R37', 'NBBXXSML')?.kind).toBe(2);
    expect(isFitted(v, 'R80', 'TDSAQFBN')).toBe(false);
  });
  it('writes them back with nothing lost, each part\'s parameter changes after it', () => {
    writeVariants(p, readVariants(p));
    const text = new TextDecoder().decode(writePrjPcb(p));
    expect(text).toContain('UniqueId=122F0B6E-98FC-43EC-BEA1-DC404694ABC3\r\nDescription=Si549 CMOS');
    expect(text).toContain('AltLibLink_DesignItemID=R0402_0R_JUMPER|AltLibLink_UseLibraryName=True');
    expect(text).toMatch(/Variation2=Designator=R37\|UniqueId=\\OIMUOFHT\\NBBXXSML\|Kind=2[^\r]*\r\nParamVariation2=ParameterName=Value\|VariantValue=0R\r\nParamDesignator2=R37/);
    expect(text).toContain('ParamVariationCount=2');
    expect(readVariants(p)).toEqual([v]);
  });
  it('a variant\'s parts: not fitted left out, the alternate fitted, parameters as varied', () => {
    const parts = variantComponents([comp('R80', 'TDSAQFBN'), comp('R37', 'NBBXXSML'), comp('R1', 'ZZZZZZZZ')], v);
    expect(parts.map((c) => c.designator)).toEqual(['R37', 'R1']);
    expect(parts[0]).toMatchObject({ libRef: 'R0402_0R_JUMPER', footprint: 'RESC1005X40N', comment: '0R' });
    expect(parts[1]).toMatchObject({ libRef: 'Res', comment: '10k' });
    expect(variantComponents([comp('R80', 'TDSAQFBN')], v, true)[0]!.fitted).toBe(false);
  });
});

/* ─── Data files and database links ─── */

describe('database links', () => {
  it('reads CSV (quotes, separators) and a workbook\'s sheets', async () => {
    expect(parseCsv('Part Number;Value\r\n"R-1;x";"say ""hi"""\n\nC-2;100n\n')).toEqual([['Part Number', 'Value'], ['R-1;x', 'say "hi"'], ['C-2', '100n']]);
    const wb = xlsx('Parts', ['Part Number', 'Value', 'Qty'], [['R-1', '10k', '5'], ['C-2', '100n', '12']]);
    const back = await readXlsx(wb);
    expect(back.sheets).toEqual(['Parts']);
    expect(back.rows).toEqual([['Part Number', 'Value', 'Qty'], ['R-1', '10k', '5'], ['C-2', '100n', '12']]);
    const [t] = await readTables('Parts.xlsx', wb);
    expect(t!.name).toBe('Parts$');
    expect(t!.rows[1]).toEqual({ 'Part Number': 'C-2', Value: '100n', Qty: '12' });
  });
  it('a .DbLink round-trips: data file, tables, key, field mappings', () => {
    const d = newDbLink('Parts.DbLink', 'Data/Parts.xlsx');
    d.tables.push(defaultTable('Parts$', ['Part Number', 'Value', 'Manufacturer']));
    d.tables[0]!.maps[2]!.update = 'Do not update';
    const back = readDbLink(writeDbLink(d), 'Parts.DbLink');
    expect(back.source).toBe('Data/Parts.xlsx');
    // As AD writes them: the key's mapping and those that aren't the default; the rest the default again
    const cols = ['Part Number', 'Value', 'Manufacturer'];
    expect(back.tables[0]!.maps.map((m) => m.field)).toEqual(['Part Number', 'Manufacturer']);
    expect(effectiveMaps(back.tables[0]!, cols)).toEqual(effectiveMaps(d.tables[0]!, cols));
    expect(back.tables[0]!.keyField).toBe('Part Number');
    expect(dataSource('Provider=Microsoft.ACE.OLEDB.12.0;Data Source="..\\db\\Parts.xlsx";Extended Properties="Excel 12.0"')).toBe('../db/Parts.xlsx');
  });
  it('Update Parameters From Database: by the key, changed values modified, missing ones added', () => {
    const link = newDbLink('L.DbLink', 'P.csv');
    link.tables.push(defaultTable('P.csv', ['Part Number', 'Value', 'Manufacturer', 'Note']));
    link.tables[0]!.maps[2]!.update = 'Do not update';
    const table = toTable('P.csv', [['Part Number', 'Value', 'Manufacturer', 'Note'], ['r-1', '10k', 'Yageo', ''], ['C-2', '100n', 'Murata', 'X7R']]);
    const part = (designator: string, params: Record<string, string>): DbPart => ({ sheet: 'A.SchDoc', index: 1, designator, params: new Map(Object.entries(params).map(([k, v]) => [k.toUpperCase(), { name: k, value: v }])) });
    const r = dbParamChanges([part('R1', { 'Part Number': 'R-1', Value: '1k', Manufacturer: 'Other' }), part('C1', { 'Part Number': 'C-2' }), part('U1', { 'Part Number': 'X' })], link, [table]);
    expect(r.matched).toBe(2);
    expect(r.unmatched).toEqual(['U1']);
    expect(r.changes.map((c) => `${c.designator}.${c.parameter}: ${c.from ?? '(new)'} → ${c.to}`)).toEqual([
      'R1.Value: 1k → 10k', 'C1.Value: (new) → 100n', 'C1.Manufacturer: (new) → Murata', 'C1.Note: (new) → X7R',
    ]);
  });
});

describe('BOM documents', () => {
  it('keep their columns, grouping, sort and variant', () => {
    const d = newBomDoc('Board.BomDoc');
    d.variant = 'Lite'; d.includeDb = true; d.setup = { columns: ['Comment', 'Designator', 'Quantity', 'Manufacturer, Part'], group: ['Comment'], sort: { column: 'Quantity', descending: true } };
    const back = readBomDoc(writeBomDoc(d), 'Board.BomDoc');
    expect([back.variant, back.includeDb, back.setup]).toEqual([d.variant, d.includeDb, d.setup]);
  });
});

/* ─── Multi-channel ─── */

function sheet(name: string, build: (b: SchBuilder, part: (des: string, x: number, y: number, uid: string) => void) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  const part = (des: string, x: number, y: number, uid: string) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1, UNIQUEID: uid }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name, doc: readSchDoc(writeCfb(root), name) };
}
function symbol(b: SchBuilder, designator: string, file: string, x: number, uid: string, entries: string[]) {
  const s = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, UNIQUEID: uid }, { LOCATION: { x, y: 500 } });
  b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: designator }, { LOCATION: { x, y: 502 } });
  b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: file }, { LOCATION: { x, y: 390 } });
  entries.forEach((name, i) => b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: s, OWNERPARTID: -1, DISTANCEFROMTOP: 1 + i * 2, NAME: name, IOTYPE: 2 }));
}
// The channel: R2 pin 1 to port A, R2 pin 2 to R3 pin 1 (a net of its own)
const channel = sheet('Chan.SchDoc', (b, part) => {
  part('R2', 400, 300, 'RTWOUIDX');
  part('R3', 500, 300, 'RTHREEID');
  b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 300, y: 300 } });
  b.wire([350, 300], [390, 300]);
  b.wire([440, 300], [490, 300]);
});

describe('multi-channel designs', () => {
  it('Repeat(CH, 1, 2): the channel\'s parts and nets once per channel, shared nets through the sheet entry', () => {
    const top = sheet('Top.SchDoc', (b, part) => {
      symbol(b, 'Repeat(CH,1,2)', 'Chan.SchDoc', 300, 'SYMBOLAA', ['A']);
      part('R1', 100, 490, 'RONEUIDX');
      b.wire([150, 490], [300, 490]);
    });
    const r = compileProject([top, channel]);
    expect(r.components.map((c) => [c.designator, c.channel ?? '', c.uniqueId])).toEqual([
      ['R1', '', 'RONEUIDX'], ['R2_CH1', 'CH1', 'SYMBOLAA1\\RTWOUIDX'], ['R2_CH2', 'CH2', 'SYMBOLAA2\\RTWOUIDX'], ['R3_CH1', 'CH1', 'SYMBOLAA1\\RTHREEID'], ['R3_CH2', 'CH2', 'SYMBOLAA2\\RTHREEID'],
    ]);
    const pins = (n: { pins: { designator: string; pin: string }[] }) => n.pins.map((p) => `${p.designator}-${p.pin}`);
    const shared = r.nets.find((n) => n.pins.some((p) => p.designator === 'R1'))!;
    expect(pins(shared)).toEqual(['R1-2', 'R2_CH1-1', 'R2_CH2-1']);
    expect(r.nets.filter((n) => n.pins.some((p) => p.designator.startsWith('R3'))).map((n) => [n.name, pins(n).join(' ')])).toEqual([
      ['NetR2_CH1_2', 'R2_CH1-2 R3_CH1-1'], ['NetR2_CH2_2', 'R2_CH2-2 R3_CH2-1'],
    ]);
    expect(r.messages.filter((m) => /Duplicate|not linked/.test(m.message))).toEqual([]);
  });
  it('two sheet symbols on one sheet: a channel each, named after its symbol', () => {
    const top = sheet('Top.SchDoc', (b) => {
      symbol(b, 'LEFT', 'Chan.SchDoc', 300, 'SYMLEFTX', []);
      symbol(b, 'RIGHT', 'Chan.SchDoc', 700, 'SYMRIGHT', []);
    });
    const r = compileProject([top, channel], { channelFormat: '$ComponentPrefix$ComponentIndex$ChannelAlpha' });
    expect(r.components.map((c) => [c.designator, c.channel])).toEqual([['R2A', 'LEFT'], ['R2B', 'RIGHT'], ['R3A', 'LEFT'], ['R3B', 'RIGHT']]);
    expect(channelDesignator('$Component_$RoomName', 'C12', { rooms: ['CH3', 'SUB1'], uids: [], index: 1 })).toBe('C12_CH3_SUB1');
  });
  it('Update PCB: a component class and a room for each channel', () => {
    const top = sheet('Top.SchDoc', (b) => { symbol(b, 'Repeat(CH,1,2)', 'Chan.SchDoc', 300, 'SYMBOLAA', []); });
    const r = compileProject([top, channel]);
    const board = readPcbDoc(newPcbDocBytes('B.PcbDoc'), 'B.PcbDoc');
    const plan = planPcbUpdate(r, board, () => undefined);
    expect(plan.filter((x) => x.kind === 'addClass' || x.kind === 'addRoom').map((x) => [x.group, x.object])).toEqual([
      ['Add Component Classes', 'CH1'], ['Add Component Classes', 'CH2'], ['Add Rooms', "CH1 (Scope=InComponentClass('CH1'))"], ['Add Rooms', "CH2 (Scope=InComponentClass('CH2'))"],
    ]);
  });
});

describe('Output Job variants', async () => {
  const { outputVariantName } = await import('../src/app/outjobRun');
  const { readOutJob, outJobOutputs } = await import('../src/formats/altium/outjob');
  const job = (scope: number) => readOutJob(binToBytes(['[OutputJobFile]', 'Version=1.0', '[OutputGroup1]', 'Name=Output Group 1', 'Description=', 'TargetPrinter=Virtual Printer',
    'PrinterOptions=Record=PrinterOptions|Copies=1|Duplex=1|TrueTypeOptions=3|Collate=1|PrintJobKind=1|PrintWhat=1', 'OutputMedium1=Folder Structure', 'OutputMedium1_Type=GeneratedFiles',
    'OutputType1=BOM_PartType', 'OutputName1=Bill of Materials', 'OutputCategory1=Report', 'OutputDocumentPath1=', 'OutputVariantName1=Full', 'OutputDefault1=0',
    `VariantName=Lite`, `VariantScope=${scope}`, ''].join('\r\n')), 'X.OutJob');
  it('an output builds the job\'s variant, or its own when each output chooses', () => {
    const a = job(0), b = job(1);
    expect(outputVariantName(a, outJobOutputs(a)[0]!)).toBe('Lite');
    expect(outputVariantName(b, outJobOutputs(b)[0]!)).toBe('Full');
  });
});
