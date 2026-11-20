import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { SchEditor } from '../src/editors/sch/SchEditor';
import { SR, bagOf, schCoord, type SchDocument } from '../src/model/sch';
import { MIXED, componentKind, objectKind, schProps, sheetFonts, type SchCtx } from '../src/model/schProps';
import { QueryError, expressionFor, parseSchQuery, runSchQuery } from '../src/model/schQuery';
import { findText, replaceIn } from '../src/model/schFind';

const ctx = (doc: SchDocument, index: number): SchCtx => ({ doc, index, units: 'mil', docName: 'Demo.SchDoc', libraryMode: false });
const part = (doc: SchDocument, des: string) => doc.objects.find((o) => o.kind === 'component' && o.designator === des)!;
const prop = (doc: SchDocument, i: number, name: string) => schProps(doc, doc.objects[i]!, false).find((p) => p.name === name)!;

describe('schematic properties (SCH Inspector)', () => {
  it('a part reads as Altium lists it, and the kinds are Altium names', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const u1 = part(doc, 'U1');
    const x = ctx(doc, u1.index);
    const rows = Object.fromEntries(schProps(doc, u1, false).map((p) => [p.name, p.get(x)]));
    expect(rows['Object Kind']).toBe('Part');
    expect(rows['Owner Document']).toBe('Demo.SchDoc');
    expect(rows['Component Designator']).toBe('U1');
    expect(rows['Part Comment']).toBe('LDO 3V3');
    expect(rows['Current Footprint']).toBe('SOT-223');
    expect(rows.Orientation).toBe('0 Degrees');
    const kinds = new Set(doc.objects.filter((o) => o.kind !== 'meta').map((o) => objectKind(doc, o)));
    for (const k of ['Part', 'Wire', 'Net Label', 'Power Object', 'Designator', 'Parameter']) expect(kinds).toContain(k);
  });

  it('moving and turning a part carries its pins and texts; one undo puts them back', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const before = new Uint8Array(writeSchDoc(doc));
    const ed = new SchEditor(doc);
    const u1 = part(doc, 'U1');
    const pins0 = doc.objects.filter((o) => o.owner === u1.index && o.kind === 'pin').map((o) => (o.kind === 'pin' ? { ...o.at } : null));
    ed.undo.transact('Move', (tx) => { tx.add(prop(doc, u1.index, 'X1').set!(ctx(doc, u1.index), '5000mil')!); });
    const moved = part(doc, 'U1');
    expect(moved.kind === 'component' && moved.at.x).toBe(5000 * 10_000);
    const d = 5000 * 10_000 - (u1.kind === 'component' ? u1.at.x : 0);
    const pins1 = doc.objects.filter((o) => o.owner === u1.index && o.kind === 'pin').map((o) => (o.kind === 'pin' ? o.at : null));
    pins1.forEach((p, i) => expect(p!.x - pins0[i]!.x).toBe(d));
    ed.undo.transact('Turn', (tx) => { tx.add(prop(doc, u1.index, 'Orientation').set!(ctx(doc, u1.index), '90 Degrees')!); });
    expect(bagOf(doc, part(doc, 'U1'))!.int('ORIENTATION')).toBe(1);
    ed.undo.undo(); ed.undo.undo();
    expect(new Uint8Array(writeSchDoc(doc))).toEqual(before);
  });

  it('designator, comment, locks and component type write the keys Altium uses', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const c1 = part(doc, 'C1');
    const x = ctx(doc, c1.index);
    prop(doc, c1.index, 'Component Designator').set!(x, 'C9')!.apply();
    prop(doc, c1.index, 'Lock Designator').set!(x, 'true')!.apply();
    prop(doc, c1.index, 'Pins Locked').set!(x, 'false')!.apply();
    prop(doc, c1.index, 'Component Type').set!(x, 'Standard (No BOM)')!.apply();
    const b = bagOf(doc, part(doc, 'C9'))!;
    expect([b.get('DESIGNATORLOCKED'), b.get('PINSMOVEABLE'), b.get('COMPONENTKINDVERSION2'), b.has('COMPONENTKIND')]).toEqual(['T', 'T', '5', false]);
    expect(componentKind(b)).toBe(5);
  });

  it('a new font goes into the sheet font table once', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const nl = doc.objects.find((o) => o.record === SR.NET_LABEL)!;
    const n0 = sheetFonts(doc).length;
    const f = JSON.stringify({ name: 'Arial', size: 14, bold: true, italic: false, underline: false, strikeout: false });
    prop(doc, nl.index, 'Font').set!(ctx(doc, nl.index), f)!.apply();
    const nl2 = doc.objects.filter((o) => o.record === SR.NET_LABEL)[1]!;
    prop(doc, nl2.index, 'Font').set!(ctx(doc, nl2.index), f)!.apply();
    expect(sheetFonts(doc).length).toBe(n0 + 1);
    expect(bagOf(doc, nl)!.int('FONTID')).toBe(n0 + 1);
    expect(prop(doc, nl.index, 'Font').get(ctx(doc, nl.index))).toBe('Arial, 14, Bold');
    expect(MIXED).toBe('<...>');
  });
});

describe('query language (SCH Filter)', () => {
  const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
  const run = (q: string) => runSchQuery(q, doc, { units: 'mil', docName: 'Demo.SchDoc', libraryMode: false });
  const des = (idx: number[]) => idx.map((i) => doc.objects[i]!).filter((o) => o.kind === 'component').map((o) => (o.kind === 'component' ? o.designator : '')).sort();

  it('kind keywords, comparisons, Like and functions', () => {
    expect(des(run('IsPart'))).toEqual(['C1', 'C2', 'D1', 'J1', 'R1', 'U1']);
    expect(des(run("IsPart And (Designator Like 'C*')"))).toEqual(['C1', 'C2']);
    expect(des(run("IsPart && Not (Designator = 'U1')"))).toHaveLength(5);
    expect(des(run("ObjectKind = 'Part' And CurrentFootprint = '0805'"))).toEqual(['C1', 'C2', 'R1']);
    expect(des(run('IsPart And X1 > 4000mil'))).toEqual(des(run('IsPart')).filter((d) => {
      const o = part(doc, d); return o.kind === 'component' && o.at.x > 4000 * 10_000;
    }));
    expect(run("InComponent('U1')").length).toBeGreaterThan(3);
    expect(run('IsNetLabel').every((i) => doc.objects[i]!.record === SR.NET_LABEL)).toBe(true);
    expect(run('All').length).toBeGreaterThan(run('IsWire').length);
  });

  it('a bad query says where', () => {
    expect(() => parseSchQuery("IsPart And (Designator = 'U1'")).toThrow(QueryError);
    expect(() => run('NoSuchKeyword(1)')).toThrow(QueryError);
  });

  it('Create Expression writes a query that finds the same objects', () => {
    const q = expressionFor([{ name: 'Object Kind', value: 'Part', same: true }, { name: 'Current Footprint', value: '0805', same: true }]);
    expect(q).toBe("(ObjectKind = 'Part') && (CurrentFootprint = '0805')");
    expect(des(run(q))).toEqual(['C1', 'C2', 'R1']);
  });
});

describe('Find and Replace Text', () => {
  it('finds net identifiers or every text, with wildcards and whole words', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const all = findText(doc, { text: 'GND', caseSensitive: false, wholeWords: false, identifiers: 'all' });
    expect(all.length).toBeGreaterThan(2);
    const nets = findText(doc, { text: 'GND', caseSensitive: false, wholeWords: false, identifiers: 'nets' });
    expect(nets.every((h) => [SR.NET_LABEL, SR.POWER_PORT, SR.PORT, SR.SHEET_ENTRY].includes(doc.objects[h.index]!.record as never))).toBe(true);
    expect(findText(doc, { text: 'U?', caseSensitive: true, wholeWords: false, identifiers: 'designators' }).map((h) => h.value)).toEqual(['U1']);
    expect(replaceIn('VCC_IO VCC', { text: 'VCC', caseSensitive: true, wholeWords: true, identifiers: 'all' }, '3V3')).toBe('VCC_IO 3V3');
    expect(schCoord(bagOf(doc, doc.objects[all[0]!.index]!)!, 'LOCATION.X')).toBeGreaterThanOrEqual(0);
  });
});
