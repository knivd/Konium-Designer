import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc, schStorage, storedFile } from '../src/formats/altium/schdoc';
import { readPrjPcb } from '../src/formats/altium/prjpcb';
import { cfbPut } from '../src/formats/cfb/cfb';
import { PropertyBag } from '../src/formats/altium/props';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { addRecords } from '../src/model/schEdit';
import { deriveObject, partLetter, rederive, SR } from '../src/model/sch';
import { Scene } from '../src/render/Scene';
import { specialResolver, specialTerms } from '../src/model/schSpecial';
import { sheetHierarchy } from '../src/model/schHierarchy';
import { sheetEntryOutline, SHEET_ENTRY_TEXT_AT } from '../src/editors/sch/symbols';
import { directiveItems } from '../src/model/schPlace';
import { inflate } from '../src/editors/sch/schImages';

const load = () => readSchDoc(demoSchDoc(), 'Demo.SchDoc');

describe('schematic view details (26.014)', () => {
  it('part letters go on past Z as Altium does: X1AF is part 32', () => {
    expect([1, 2, 26, 27, 28, 32, 52, 53].map(partLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AF', 'AZ', 'BA']);
  });

  it('sheet entries: 150 mil long, 80 tall, points 40 deep, name 200 in', () => {
    expect(sheetEntryOutline(2)).toEqual([[0, -40], [110, -40], [150, 0], [110, 40], [0, 40]]);
    expect(sheetEntryOutline(1)[0]).toEqual([0, 0]);
    expect(Math.max(...sheetEntryOutline(3).map((p) => p[0]))).toBe(150);
    expect(SHEET_ENTRY_TEXT_AT).toBe(200);
  });

  it('special strings: document, part and project parameters, the document itself, literals', () => {
    expect(specialTerms("='Rev '+Revision")).toEqual([{ literal: 'Rev ' }, { name: 'Revision' }]);
    expect(specialTerms('=Title')).toEqual([{ name: 'Title' }]);
    const doc = load();
    const sheet = doc.objects.findIndex((o) => o.record === SR.SHEET);
    const u1 = doc.objects.find((o) => o.kind === 'component')!;
    addRecords(doc, [
      PropertyBag.from({ RECORD: 41, OWNERINDEX: sheet, NAME: 'Title', TEXT: 'Amplifier Overview', ISHIDDEN: 'T' }),
      PropertyBag.from({ RECORD: 41, NAME: 'SheetNumber', TEXT: '1', ISHIDDEN: 'T' }),
      PropertyBag.from({ RECORD: 41, OWNERINDEX: u1.index, NAME: 'Value', TEXT: 'GT7-42DP-DS', ISHIDDEN: 'T' }),
    ]).apply();
    rederive(doc);
    const r = specialResolver(doc, { docName: 'Overview.SchDoc', path: 'Hardware\\Overview.SchDoc', projectName: 'Amplifier.PrjPcb', projectParams: new Map([['ENGINEER', 'A Designer']]) }, false);
    expect(r('=title', -1)).toBe('Amplifier Overview');
    expect(r("='Sheet '+SheetNumber", -1)).toBe('Sheet 1');
    expect(r('=Value', u1.index)).toBe('GT7-42DP-DS');
    expect(r('=Value', -1)).toBe('');
    expect(r('=Engineer', -1)).toBe('A Designer');
    expect(r('=DocumentName', -1)).toBe('Overview.SchDoc');
    expect(r('=DocumentFullPathAndName', -1)).toBe('Hardware\\Overview.SchDoc');
    expect(r('=ProjectName', -1)).toBe('Amplifier');
    expect(r('=SheetSize', -1)).toBe('A4');
    expect(r('plain =text', -1)).toBe('plain =text');
    // Display Names of Special Strings that have No Value Set
    expect(specialResolver(doc, { docName: 'x' }, true)('=Nobody', -1)).toBe('=Nobody');
  });

  it('project parameters are read from [ParameterN]', () => {
    const p = readPrjPcb(new TextEncoder().encode('[Design]\r\nVersion=1.0\r\n[Parameter1]\r\nName=Engineer\r\nValue=A Designer\r\n[Parameter2]\r\nName=Revision\r\nValue=1.0\r\n[Document1]\r\nDocumentPath=A.SchDoc\r\n'), 'P.PrjPcb');
    expect([...p.parameters]).toEqual([['ENGINEER', 'A Designer'], ['REVISION', '1.0']]);
    expect(p.documents).toEqual(['A.SchDoc']);
  });

  it('embedded pictures: the Storage stream is read and the zlib data inflates', async () => {
    const doc = readSchDoc(writeSchDoc(load()), 'Demo.SchDoc');
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const z = new Uint8Array(await new Response(new Blob([png]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const head = PropertyBag.from({ HEADER: 'Icon storage', WEIGHT: 1 }).toBytes();
    const name = new TextEncoder().encode('C:\\logos\\mark.png');
    const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
    // Each entry: 5 bytes (a length and a marker), the name, its size, the data
    const st = Uint8Array.from([...u32(head.length), ...head, ...u32(1 + name.length + 4 + z.length), 0xd0, name.length, ...name, ...u32(z.length), ...z]);
    cfbPut(doc.cfb!.root, 'Storage', st);
    const files = schStorage(doc);
    expect(files.map((f) => f.name)).toEqual(['C:\\logos\\mark.png']);
    expect(storedFile(files, 'mark.png')?.name).toBe('C:\\logos\\mark.png');
    expect(storedFile(files, 'D:\\other\\MARK.PNG')?.name).toBe('C:\\logos\\mark.png');
    expect([...(await inflate(files[0]!.data))]).toEqual([...png]);
  });

  it('the Projects tree lists child sheets in the project\u2019s document order', () => {
    const top = load();
    const kids = ['B.SchDoc', 'A.SchDoc'];
    let y = 5000;
    for (const k of kids) {
      const sym = top.objects.length;
      addRecords(top, [
        PropertyBag.from({ RECORD: SR.SHEET_SYMBOL, 'LOCATION.X': 100, 'LOCATION.Y': (y -= 100), XSIZE: 50, YSIZE: 50 }),
        PropertyBag.from({ RECORD: SR.SHEET_NAME, OWNERINDEX: sym, TEXT: `U_${k}` }),
        PropertyBag.from({ RECORD: SR.FILE_NAME, OWNERINDEX: sym, TEXT: k }),
      ]).apply();
    }
    rederive(top);
    const sheets = [{ name: 'Top.SchDoc', doc: top }, { name: 'A.SchDoc', doc: load() }, { name: 'B.SchDoc', doc: load() }];
    expect(sheetHierarchy(sheets, 'documents').roots[0]!.children.map((c) => c.sheet)).toEqual(['A.SchDoc', 'B.SchDoc']);
  });

  it('a Transparent fill darkens what is beneath (D2: diodes drawn before the body)', () => {
    const rect = deriveObject(PropertyBag.from({ RECORD: 14, 'LOCATION.X': 790, 'LOCATION.Y': 645, 'CORNER.X': 840, 'CORNER.Y': 695, ISSOLID: 'T', TRANSPARENT: 'T', AREACOLOR: 11599871 }), 0);
    expect(rect.kind === 'rect' && rect.transparent && rect.solid).toBe(true);
    const s = new Scene({ x: 0, y: 0 });
    s.inOrder = true;
    const g = s.group('objects');
    s.segment(g, { x: 0, y: 0 }, { x: 10, y: 0 }, 1, 0xff);
    s.darken(g, () => s.rectFromCorners(g, { x: 0, y: 0 }, { x: 5, y: 5 }, 0xff));
    s.polygon(g, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [0, 1, 2], 0xff);
    // One plain instance, the darkening fill, then plain again (a triangle in order)
    expect(g.prims.runs).toEqual([{ start: 1, min: true }, { start: 2, min: false }]);
    expect(g.prims.count).toBe(3);
  });

  it('Parameter Set directives: a differential pair is drawn where it was placed', () => {
    const d = deriveObject(PropertyBag.from({ RECORD: 43, 'LOCATION.X': 465, 'LOCATION.Y': 395, COLOR: 255, NAME: 'DIFFPAIR' }), 0);
    expect(d.kind === 'directive' && d.name === 'DIFFPAIR' && d.color === 0xff0000 && d.at.x === 465 * 100000).toBe(true);
  });

  it('Place › Directives writes what AD17 writes', () => {
    const bags = (k: Parameters<typeof directiveItems>[0]) => directiveItems(k).map(({ bag, owner }) => [owner, bag.get('RECORD'), bag.get('NAME'), bag.get('TEXT') ?? null, bag.get('DESCRIPTION') ?? null, bag.get('COLOR')]);
    expect(bags('diffpair')).toEqual([[-1, '43', 'DIFFPAIR', null, null, '255'], [0, '41', 'DifferentialPair', 'True', null, '8388608']]);
    expect(bags('pcblayout')).toEqual([[-1, '43', 'PCB Rule', null, null, '255'], [0, '41', 'Rule', 'PcbType=ProtelPcb', 'Undefined', '8388608']]);
    // AD17 (user's file): a plain set starts with an unnamed hidden "*" parameter 160 mil below
    expect(bags('parameterset')).toEqual([[-1, '43', 'Parameter Set', null, null, '255'], [0, '41', undefined, '*', null, '8388608']]);
    const [set, blank] = directiveItems('parameterset', { x: 3_800_000, y: 5_000_000 });
    expect([set!.bag.get('LOCATION.Y'), blank!.bag.get('LOCATION.Y'), blank!.bag.get('ISHIDDEN')]).toEqual(['50', '34', 'T']);
  });
});
