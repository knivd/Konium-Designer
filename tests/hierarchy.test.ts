import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { demoFiles } from '../src/formats/synthetic/demo';
import { SR } from '../src/model/sch';
import { compileProject } from '../src/model/compile';
import { edgeSlot, entryPoint, hierarchyReport, isSymbol, resolveSheet, sheetHierarchy, symbolNames } from '../src/model/schHierarchy';
import { sheetEntryBag, sheetSymbolItems, symbolForPorts } from '../src/model/schPlace';

import { mil } from '../src/core/units';

type B = SchBuilder;
function sheet(name: string, build: (b: B, part: (des: string, x: number, y: number) => void) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  // A resistor: pin 1 ends at x-10, pin 2 at x+50
  const part = (des: string, x: number, y: number) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name, doc: readSchDoc(writeCfb(root), name) };
}

/** Symbol at (300, 500), 200 × 100 (DXP units), entries on the left at 100 and 300 mil from the top. */
function withSymbol(b: B, file: string, entries: [string, number][]) {
  const s = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, COLOR: 128, AREACOLOR: 8454016, ISSOLID: true }, { LOCATION: { x: 300, y: 500 } });
  b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: 'U_Child' }, { LOCATION: { x: 300, y: 502 } });
  b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: file }, { LOCATION: { x: 300, y: 390 } });
  entries.forEach(([name, d]) => b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: s, OWNERPARTID: -1, DISTANCEFROMTOP: d, NAME: name, IOTYPE: 2 }));
  return s;
}

describe('hierarchy', () => {
  const parent = sheet('Top.SchDoc', (b, part) => {
    withSymbol(b, 'Child.SchDoc', [['A', 1], ['B', 3]]);
    part('R1', 100, 490);                 // pin 2 ends at (150, 490)
    b.wire([150, 490], [300, 490]);       // to entry A at (300, 500 - 10)
  });
  const child = sheet('Child.SchDoc', (b, part) => {
    part('R2', 400, 300);                 // pin 1 ends at (390, 300)
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 300, y: 300 } });
    b.wire([350, 300], [390, 300]);       // port's right end to R2-1
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'C', STYLE: 3, IOTYPE: 1, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 300, y: 200 } });
  });

  it('a sheet entry meets the port of the same name on the child sheet', () => {
    const r = compileProject([parent, child]);
    expect(r.scope).toBe('hierarchical');
    const net = r.nets.find((n) => n.pins.some((p) => p.designator === 'R1' && p.pin === '2'));
    expect(net?.pins.map((p) => `${p.designator}-${p.pin}`)).toEqual(['R1-2', 'R2-1']);
    expect(net?.sheets).toEqual(['Child.SchDoc', 'Top.SchDoc']);
    const msgs = r.messages.map((m) => m.message);
    expect(msgs).toContain('Sheet Entry B not linked to child sheet Child.SchDoc');
    expect(msgs).toContain('Port C not linked to parent sheet symbol');
    expect(msgs.some((m) => /not linked to parent sheet symbol/.test(m) && /\bA\b/.test(m))).toBe(false);
  });

  it('a symbol whose sheet is missing is an error; the tree puts children under parents', () => {
    const r = compileProject([parent]);
    expect(r.messages.map((m) => m.message)).toContain('Missing child sheet for sheet symbol U_Child (Child.SchDoc)');
    const h = sheetHierarchy([parent, child]);
    expect(h.roots.map((n) => n.sheet)).toEqual(['Top.SchDoc']);
    expect(h.roots[0]!.children.map((n) => [n.sheet, n.via?.designator])).toEqual([['Child.SchDoc', 'U_Child']]);
    expect(resolveSheet(['Top.SchDoc', 'Child.SchDoc'], 'sub\\child')).toBe('Child.SchDoc');
    expect(hierarchyReport('P.PrjPcb', h.roots, new Date(2026, 9, 23, 9, 30)).split('\r\n').slice(3, 6).map((l) => l.trimEnd())).toEqual([
      'P.PrjPcb',
      `   Top.SchDoc${' '.repeat(68 - 13)}SCH (Top.SchDoc)`,
      `      U_Child${' '.repeat(40 - 13)}Child.SchDoc${' '.repeat(16)}SCH (Child.SchDoc)`,
    ]);
  });

  it('entries sit on the edge; a new one snaps to the nearest edge, clear of the corners', () => {
    const doc = parent.doc;
    const sym = doc.objects.find(isSymbol)!;
    const a = doc.objects.find((o) => o.kind === 'sheetentry' && o.name === 'A')!;
    expect(entryPoint(doc, a)).toEqual({ x: mil(3000), y: mil(4900) });
    expect(edgeSlot(sym, { x: mil(4950), y: mil(4630) }, mil(100))).toEqual({ side: 1, distance: mil(400) });
    expect(edgeSlot(sym, { x: mil(3500), y: mil(5050) }, mil(100))).toEqual({ side: 2, distance: mil(500) });
    expect(edgeSlot(sym, { x: mil(3010), y: mil(5100) }, mil(100))).toEqual({ side: 0, distance: mil(100) });
    expect(symbolNames(doc, sym.index)).toEqual({ designator: 'U_Child', fileName: 'Child.SchDoc' });
  });

  it('records as Altium writes them: symbol, designator, file name; entries in 100 mil steps', () => {
    const items = sheetSymbolItems({ x: mil(1000), y: mil(3000) }, { x: mil(2000), y: mil(2200) });
    expect(items.map((i) => [i.bag.int('RECORD'), i.owner])).toEqual([[SR.SHEET_SYMBOL, -1], [SR.SHEET_NAME, 0], [SR.FILE_NAME, 0]]);
    expect(items[0]!.bag.toObject()).toMatchObject({ 'LOCATION.X': '100', 'LOCATION.Y': '300', XSIZE: '100', YSIZE: '80', COLOR: '128', AREACOLOR: '8454016', ISSOLID: 'T' });
    expect(items[1]!.bag.get('TEXT')).toBe('Designator');
    expect(items[2]!.bag.get('TEXT')).toBe('File Name');
    expect(sheetEntryBag('X', 1, mil(250), 1).toObject()).toMatchObject({ SIDE: '1', DISTANCEFROMTOP: '2', DISTANCEFROMTOP_FRAC1: '500000', IOTYPE: '1', NAME: 'X' });
    const sym = symbolForPorts('Power.SchDoc', [{ name: 'VIN', io: 2 }, { name: 'VOUT', io: 1 }, { name: 'EN', io: 2 }]);
    expect(sym[1]!.bag.get('TEXT')).toBe('U_Power');
    expect(sym.slice(3).map((i) => [i.bag.get('NAME'), i.bag.int('SIDE'), i.bag.int('DISTANCEFROMTOP')])).toEqual([['VIN', 0, 1], ['EN', 0, 2], ['VOUT', 1, 1]]);
  });

  it('the demo project: Symbols.SchDoc stands for Child.SchDoc, every entry linked', () => {
    const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: readSchDoc(f.bytes, f.name) }));
    const r = compileProject(sheets);
    expect(r.messages.filter((m) => /not linked|Missing child/.test(m.message))).toEqual([]);
    expect(r.hierarchy.roots.map((n) => [n.sheet, n.children.map((c) => c.sheet)])).toEqual([['Demo.SchDoc', []], ['Symbols.SchDoc', ['Child.SchDoc']]]);
  });
});
