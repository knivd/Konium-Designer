import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc, splitForWrite, writeSchDoc } from '../src/formats/altium/schdoc';
import { readSchLib, writeSchLib } from '../src/formats/altium/schlib';
import { joinSchRecords } from '../src/formats/altium/framing';
import { PropertyBag } from '../src/formats/altium/props';
import { addDocument, newPrjPcb, reorderDocuments } from '../src/formats/altium/prjpcb';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR, deriveSheet } from '../src/model/sch';
import { sheetFrame } from '../src/editors/sch/sheetFrame';
import { arrayClip, convertClip, stepName, DEFAULT_ARRAY } from '../src/model/smartPaste';
import { symbolFromPorts, symbolsFromSheets } from '../src/model/makeLib';
import { partToPortsChanges, partToSheetSymbolChanges, pushPartToSheet } from '../src/model/convertPart';
import { applyTemplateChanges, removeTemplateChanges, templateOf } from '../src/model/schTemplate';
import { docParam, docParamChange, partParamChange, partParams } from '../src/model/schParams';
import { netLabelBag } from '../src/model/schPlace';
import { roundBag, singlePinNetsReport } from '../src/model/schReports';
import { compileProject } from '../src/model/compile';
import { crossJunctionChanges } from '../src/model/crossJunctions';
import { portReferences, zoneOf } from '../src/model/portRefs';
import { isFitted, readVariants, writeVariants } from '../src/model/variants';
import { intLibMembers, packIntLib, unpackIntLib } from '../src/formats/altium/intlib';
import type { Change } from '../src/core/undo';

const U = 100_000;
const doc = (build: (b: SchBuilder) => void, extra?: (root: ReturnType<typeof newEntry>) => void) => {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: true });
  build(b);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  extra?.(root);
  return readSchDoc(writeCfb(root), 'T.SchDoc');
};
const run = (cs: Change[]) => { for (const c of cs) c.apply(); };
function resistor(b: SchBuilder, des: string, x: number, y: number) {
  const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1, UNIQUEID: 'AAAAAAAA' }, { LOCATION: { x, y } });
  b.add({ RECORD: SR.RECTANGLE, OWNERINDEX: ci, OWNERPARTID: 1, LINEWIDTH: 1 }, { LOCATION: { x, y: y - 5 }, CORNER: { x: x + 40, y: y + 5 } });
  b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: 'A', DESIGNATOR: '1', ELECTRICAL: 0 }, { LOCATION: { x, y } });
  b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: 'B', DESIGNATOR: '2', ELECTRICAL: 2 }, { LOCATION: { x: x + 40, y } });
  b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: '10k' }, { LOCATION: { x, y: y - 10 } });
  return ci;
}

describe('sheet border, zones and title block', () => {
  it('A4: 4 × 4 zones numbered across and lettered down, the title block in the corner', () => {
    const sh = deriveSheet(PropertyBag.from({ RECORD: 31, SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: true }));
    const fr = sheetFrame(sh, false, { date: '25/10/2026', file: 'T.SchDoc' });
    const zones = fr.texts.filter((t) => t.role === 'zone').map((t) => t.text);
    expect(zones.filter((z) => /^\d$/.test(z)).sort()).toEqual(['1', '1', '2', '2', '3', '3', '4', '4']);
    expect(zones.filter((z) => /^[A-Z]$/.test(z)).sort()).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D']);
    // A at the top
    const a = fr.texts.find((t) => t.text === 'A')!, d = fr.texts.find((t) => t.text === 'D')!;
    expect(a.at.y).toBeGreaterThan(d.at.y);
    expect(fr.texts.find((t) => t.role === 'value' && t.text === 'A4')).toBeTruthy();
    expect(fr.texts.map((t) => t.text)).toContain('Drawn By:');
  });
  it('booleans are written only when true: no BORDERON or TITLEBLOCKON means neither', () => {
    const sh = deriveSheet(PropertyBag.from({ RECORD: 31, SHEETSTYLE: 1 }));
    expect([sh.border, sh.titleBlock]).toEqual([false, false]);
    expect(sheetFrame(sh, false, { date: '', file: '' }).lines).toEqual([]);
  });
});

describe('harnesses (Additional stream)', () => {
  const withHarness = (owner: number) => doc(() => {}, (root) => {
    const recs = [PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 3 }),
      PropertyBag.from({ RECORD: 215, OWNERPARTID: -1, 'LOCATION.X': 100, 'LOCATION.Y': 200, XSIZE: 40, YSIZE: 60, SIDE: 1, PRIMARYCONNECTIONPOSITION: 30 }),
      PropertyBag.from({ RECORD: 216, OWNERINDEX: owner, OWNERINDEXADDITIONALLIST: 'T', OWNERPARTID: -1, NAME: 'D+', DISTANCEFROMTOP: 2 }),
      PropertyBag.from({ RECORD: 217, OWNERINDEX: owner, OWNERINDEXADDITIONALLIST: 'T', OWNERPARTID: -1, TEXT: 'USB', 'LOCATION.X': 100, 'LOCATION.Y': 130 })];
    cfbPut(root, 'Additional', joinSchRecords(recs.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
  });
  it('the Additional stream joins the document after FileHeader; children find their connector', () => {
    // FileHeader holds the sheet (object 0): the connector is object 1, whichever way owners count
    for (const [owner, mode] of [[1, 'continued'], [0, 'local']] as const) {
      const d = withHarness(owner);
      expect(d.additionalOwners).toBe(mode);
      expect(d.objects.map((o) => o.kind)).toEqual(['meta', 'harness', 'harnessentry', 'text']);
      expect(d.objects[2]!.owner).toBe(1);
      const h = d.objects[1]!;
      expect(h.kind === 'harness' && h.w).toBe(40 * U);
      // Saved as read: same streams
      const back = readSchDoc(writeSchDoc(d), 'T.SchDoc');
      expect(back.objects.map((o) => o.kind)).toEqual(['meta', 'harness', 'harnessentry', 'text']);
      expect(splitForWrite(back).extra.at(-1)!.bag!.int('OWNERINDEX')).toBe(owner);
    }
  });
  it('a record added later goes to FileHeader; owners renumbered on save', () => {
    const d = withHarness(1);
    d.records.push({ kind: 0, data: new Uint8Array(), bag: PropertyBag.from({ RECORD: SR.JUNCTION, OWNERPARTID: -1 }) });
    const back = readSchDoc(writeSchDoc(d), 'T.SchDoc');
    // FileHeader now has sheet + junction, so the connector is object 2 and its entry points there
    expect(back.objects.map((o) => o.kind)).toEqual(['meta', 'junction', 'harness', 'harnessentry', 'text']);
    expect(back.objects[3]!.owner).toBe(2);
  });
});

describe('Smart Paste', () => {
  it('names step on: Horizontal First along a row, then the next row', () => {
    expect(stepName('D0', 3)).toBe('D3');
    expect(stepName('NetLabel09', 1)).toBe('NetLabel10');
    expect(stepName('A', 2)).toBe('A');
    const clip = { kind: 'sch' as const, ref: { x: 0, y: 0 }, items: [{ bag: netLabelBag('D0'), owner: -1 }] };
    const out = arrayClip(clip, { ...DEFAULT_ARRAY, on: true, cols: 2, colSpacing: 100 * U, rows: 3, rowSpacing: -10 * U });
    expect(out.items.map((i) => i.bag.get('TEXT'))).toEqual(['D0', 'D1', 'D2', 'D3', 'D4', 'D5']);
    expect(out.items[3]!.bag.int('LOCATION.X')).toBe(100);
    expect(out.items[3]!.bag.int('LOCATION.Y')).toBe(-10);
    const v = arrayClip(clip, { ...DEFAULT_ARRAY, on: true, cols: 2, colSpacing: 100 * U, rows: 2, rowSpacing: -10 * U, direction: 'vertical' });
    expect(v.items.map((i) => i.bag.get('TEXT'))).toEqual(['D0', 'D2', 'D1', 'D3']);
  });
  it('net labels paste as ports', () => {
    const clip = { kind: 'sch' as const, ref: { x: 0, y: 0 }, items: [{ bag: netLabelBag('SDA'), owner: -1 }] };
    const out = convertClip(clip, new Map([['Net Labels', 'ports']]));
    expect([out.items[0]!.bag.int('RECORD'), out.items[0]!.bag.get('NAME')]).toEqual([SR.PORT, 'SDA']);
    expect(convertClip(clip, new Map([['Net Labels', null]])).items).toEqual([]);
  });
});

describe('Convert, Push Part to Sheet, Make Schematic Library', () => {
  it('Part To Ports: a port on each pin end, the part gone', () => {
    let ci = 0;
    const d = doc((b) => { ci = resistor(b, 'R1', 100, 100); });
    run(partToPortsChanges(d, ci));
    const ports = d.objects.filter((o) => o.kind === 'port');
    expect(ports.map((p) => p.kind === 'port' && [p.name, p.io])).toEqual([['A', 2], ['B', 1]]);
    expect(d.objects.some((o) => o.kind === 'component')).toBe(false);
    // Port A ends on pin 1's end (90,100): left of it
    const pa = ports[0]!;
    expect(pa.kind === 'port' && pa.at.x + pa.width).toBe(90 * U);
  });
  it('Part To Sheet Symbol: entries on the sides the pins point to', () => {
    let ci = 0;
    const d = doc((b) => { ci = resistor(b, 'R1', 100, 100); });
    run(partToSheetSymbolChanges(d, ci));
    const ent = d.objects.filter((o) => o.kind === 'sheetentry').map((o) => o.kind === 'sheetentry' && [o.name, o.side]);
    expect(ent).toEqual([['A', 0], ['B', 1]]);
    expect(d.objects.find((o) => o.record === SR.SHEET_NAME)?.kind === 'text' && (d.objects.find((o) => o.record === SR.SHEET_NAME) as { text: string }).text).toBe('R1');
  });
  it('Push Part to Sheet: the part and a port per pin for the child', () => {
    let ci = 0;
    const d = doc((b) => { ci = resistor(b, 'R1', 100, 100); });
    const r = pushPartToSheet(d, ci, 'R1.SchDoc')!;
    expect(r.child.filter((b) => b.int('RECORD') === SR.PORT).map((b) => b.get('NAME'))).toEqual(['A', 'B']);
    expect(r.child[0]!.int('RECORD')).toBe(SR.COMPONENT);
    expect(r.child.filter((b) => b.int('RECORD') === SR.PIN).every((b) => b.int('OWNERINDEX') === 1)).toBe(true);
  });
  it('Make Schematic Library: one symbol per library reference, back at the origin', () => {
    const sheets = [{ name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') }];
    const syms = symbolsFromSheets(sheets);
    const lib = readSchLib(writeSchLib(syms), 'Demo.SchLib');
    expect(lib.symbols.map((s) => s.libRef).sort()).toEqual([...new Set(sheets[0]!.doc.objects.filter((o) => o.kind === 'component').map((o) => (o as { libRef: string }).libRef))].sort());
    const comp = syms[0]!.bags[0]!;
    expect(comp.has('LOCATION.X')).toBe(false);
    expect(syms[0]!.bags.find((b) => b.int('RECORD') === SR.DESIGNATOR)?.get('TEXT')).toMatch(/\?$/);
  });
  it('Create Component From Sheet: a pin per port', () => {
    const s = symbolFromPorts('Power.SchDoc', [{ name: 'VIN', io: 2 }, { name: 'VOUT', io: 1 }]);
    expect(s.libRef).toBe('Power');
    expect(s.bags.filter((b) => b.int('RECORD') === SR.PIN).map((b) => [b.get('NAME'), b.int('ELECTRICAL')])).toEqual([['VIN', 0], ['VOUT', 2]]);
    expect(readSchLib(writeSchLib([s]), 'P.SchLib').symbols[0]!.libRef).toBe('Power');
  });
});

describe('templates, parameters, rounding, project order', () => {
  it('apply a template under one record, then remove it', () => {
    const d = doc(() => {});
    const tpl = doc((b) => { b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: '=Title' }, { LOCATION: { x: 900, y: 50 } }); b.add({ RECORD: SR.LINE, OWNERPARTID: -1 }, { LOCATION: { x: 800, y: 20 }, CORNER: { x: 1100, y: 20 } }); });
    run(applyTemplateChanges(d, tpl, 'A4.SchDot'));
    const t = templateOf(d)!;
    expect(d.objects.filter((o) => o.owner === t.index).length).toBe(2);
    expect(d.records.find((r) => r.bag?.int('RECORD') === SR.SHEET)!.bag!.get('TEMPLATEFILENAME')).toBe('A4.SchDot');
    run(removeTemplateChanges(d));
    expect(templateOf(d)).toBeUndefined();
    expect(d.objects.some((o) => o.kind === 'text' && o.text === '=Title')).toBe(false);
  });
  it('document and part parameters set, added when missing', () => {
    let ci = 0;
    const d = doc((b) => { ci = resistor(b, 'R1', 100, 100); });
    run([docParamChange(d, 'SheetNumber', '3')!]);
    expect(docParam(d, 'sheetnumber')?.value).toBe('3');
    expect(docParamChange(d, 'SheetNumber', '3')).toBeNull();
    run([partParamChange(d, ci, 'Comment', '4k7')!, partParamChange(d, ci, 'Tolerance', '1%')!]);
    const p = partParams(d)[0]!;
    expect([p.params.get('COMMENT')?.value, p.params.get('TOLERANCE')?.value]).toEqual(['4k7', '1%']);
  });
  it('round coordinates: fractions gone', () => {
    const b = PropertyBag.from({ RECORD: 25, 'LOCATION.X': 100, 'LOCATION.X_FRAC': 60000, 'LOCATION.Y': 50 });
    const r = roundBag(b)!;
    expect([r.get('LOCATION.X'), r.has('LOCATION.X_FRAC'), r.get('LOCATION.Y')]).toEqual(['101', false, '50']);
    expect(roundBag(PropertyBag.from({ RECORD: 25, 'LOCATION.X': 100 }))).toBeNull();
  });
  it('project documents reorder in place', () => {
    const p = newPrjPcb('P.PrjPcb');
    addDocument(p, 'A.SchDoc'); addDocument(p, 'B.SchDoc'); addDocument(p, 'C.PcbDoc');
    expect(reorderDocuments(p, ['B.SchDoc', 'A.SchDoc', 'C.PcbDoc'])).toBe(true);
    expect(p.documents).toEqual(['B.SchDoc', 'A.SchDoc', 'C.PcbDoc']);
  });
  it('Single Pin Nets report', () => {
    const d = doc((b) => { resistor(b, 'R1', 100, 100); b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'LONE' }, { LOCATION: { x: 90, y: 100 } }); });
    const text = singlePinNetsReport('T', [{ name: 'T.SchDoc', doc: d }]);
    expect(text).toMatch(/LONE\s+R1-1/);
  });
});

describe('harness connectivity', () => {
  it('two connectors on a signal harness: the same entry name is one net, named Type.Entry', () => {
    let r1 = 0, r2 = 0;
    const d = doc((b) => {
      r1 = resistor(b, 'R1', 100, 300); r2 = resistor(b, 'R2', 600, 300);
      // Connector A at (200,320), 60 × 40, harness on the right at 20 down: tip (266,300); entries on the left
      const a = b.add({ RECORD: SR.HARNESS_CONNECTOR, OWNERPARTID: -1, XSIZE: 60, YSIZE: 40, SIDE: 1, PRIMARYCONNECTIONPOSITION: 20 }, { LOCATION: { x: 200, y: 320 } });
      b.add({ RECORD: SR.HARNESS_TYPE, OWNERINDEX: a, OWNERPARTID: -1, TEXT: 'USB' }, { LOCATION: { x: 200, y: 270 } });
      b.add({ RECORD: SR.HARNESS_ENTRY, OWNERINDEX: a, OWNERPARTID: -1, NAME: 'DP', DISTANCEFROMTOP: 2 });
      // Connector B mirrored: harness on the left of (400,320): tip (395,300); entries on the right edge x=460
      const c = b.add({ RECORD: SR.HARNESS_CONNECTOR, OWNERPARTID: -1, XSIZE: 60, YSIZE: 40, PRIMARYCONNECTIONPOSITION: 20 }, { LOCATION: { x: 400, y: 320 } });
      b.add({ RECORD: SR.HARNESS_ENTRY, OWNERINDEX: c, OWNERPARTID: -1, NAME: 'DP', SIDE: 1, DISTANCEFROMTOP: 2 });
      b.add({ RECORD: SR.SIGNAL_HARNESS, OWNERPARTID: -1, LINEWIDTH: 2, LOCATIONCOUNT: 2, X1: 265, Y1: 300, X2: 395, Y2: 300 });
      b.wire([150, 300], [200, 300]);   // R1 pin 2 → connector A's DP (left edge, 20 down)
      b.wire([460, 300], [590, 300]);   // connector B's DP (right edge) → R2 pin 1
    });
    void r1; void r2;
    const res = compileProject([{ name: 'T.SchDoc', doc: d }]);
    const net = res.nets.find((n) => n.pins.some((p) => p.designator === 'R1' && p.pin === '2'));
    expect(net?.pins.map((p) => `${p.designator}-${p.pin}`)).toEqual(['R1-2', 'R2-1']);
    expect(net?.name).toBe('USB.DP');
  });
});

describe('Convert Cross Junctions, port cross references', () => {
  it('a four-way junction becomes two T-junctions a step apart, nets unchanged', () => {
    const d = doc((b) => {
      resistor(b, 'R1', 100, 300); resistor(b, 'R2', 400, 300); resistor(b, 'R3', 250, 500); resistor(b, 'R4', 250, 100);
      b.wire([150, 300], [390, 300]);                 // horizontal through (270,300)
      b.wire([240, 500], [240, 100]);                 // vertical through, R3 pin 1 at (240,500)… R4 pin 1 at (240,100)
      b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1 }, { LOCATION: { x: 240, y: 300 } });
    });
    const before = compileProject([{ name: 'T.SchDoc', doc: d }]).nets.map((n) => n.pins.map((p) => `${p.designator}-${p.pin}`).join(' ')).sort();
    const { changes, count } = crossJunctionChanges(d, 10 * U);
    expect(count).toBe(1);
    run(changes);
    expect(d.objects.filter((o) => o.kind === 'junction').map((o) => o.kind === 'junction' && `${o.at.x / U},${o.at.y / U}`).sort()).toEqual(['240,300', '250,300']);
    const after = compileProject([{ name: 'T.SchDoc', doc: d }]).nets.map((n) => n.pins.map((p) => `${p.designator}-${p.pin}`).join(' ')).sort();
    expect(after).toEqual(before);
    expect(crossJunctionChanges(d, 10 * U).count).toBe(0);
  });
  it('zones and references: flat ports point at each other', () => {
    const sh = deriveSheet(PropertyBag.from({ RECORD: 31, SHEETSTYLE: 0, BORDERON: true }));
    expect(zoneOf(sh, { x: 30 * U, y: 740 * U })).toBe('1A');
    expect(zoneOf(sh, { x: 1120 * U, y: 30 * U })).toBe('4D');
    const a = doc((b) => { b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'SDA', WIDTH: 50 }, { LOCATION: { x: 100, y: 700 } }); });
    const c = doc((b) => { b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'SDA', WIDTH: 50 }, { LOCATION: { x: 1000, y: 100 } }); });
    const refs = portReferences([{ name: 'A.SchDoc', doc: a }, { name: 'B.SchDoc', doc: c }], { sheetStyle: 'name', location: 'zone' });
    expect([...refs.get('A.SchDoc')!.values()]).toEqual(['B[4D]']);
    expect([...refs.get('B.SchDoc')!.values()]).toEqual(['A[1A]']);
  });
});

describe('variants', () => {
  it('[ProjectVariantN] sections round-trip; not fitted by unique ID or designator', () => {
    const p = newPrjPcb('P.PrjPcb');
    writeVariants(p, [{ name: 'Lite', allowFabrication: false, variations: [{ designator: 'R1', uniqueId: 'ABCDEFGH', kind: 1, alternate: '', fields: [] }], params: [], extra: [] }]);
    expect(p.lines.join('\n')).toContain('Variation1=Designator=R1|UniqueId=\\ABCDEFGH|Kind=1|AlternatePart=');
    const back = readVariants(p)[0]!;
    expect(back.name).toBe('Lite');
    expect(isFitted(back, 'R9', 'ABCDEFGH')).toBe(false);
    expect(isFitted(back, 'R1', 'ZZZZZZZZ')).toBe(true);
    writeVariants(p, []);
    expect(readVariants(p)).toEqual([]);
  });
});

describe('integrated libraries', () => {
  it('pack and unpack: the libraries come back as they went in', async () => {
    const sch = writeSchLib([symbolFromPorts('Power.SchDoc', [{ name: 'VIN', io: 2 }])]);
    const packed = await packIntLib([{ kind: 'SchLib', bytes: sch }]);
    expect(intLibMembers(packed).map((m) => m.kind)).toEqual(['SchLib']);
    const back = await unpackIntLib(packed, 'Power.IntLib');
    expect(back.map((b) => b.name)).toEqual(['Power.SchLib']);
    expect(readSchLib(back[0]!.bytes, 'Power.SchLib').symbols[0]!.libRef).toBe('Power');
  });
});
