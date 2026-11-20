import { describe, expect, it } from 'vitest';
import { PropertyBag } from '../src/formats/altium/props';
import { cfbFind, cfbPut, newEntry, readCfb, writeCfb } from '../src/formats/cfb/cfb';
import { readSchLib, symbolLoaded, symbolRecordCount, writeSchLib } from '../src/formats/altium/schlib';
import { readPcbLib, writePcbLib, storageFor } from '../src/formats/altium/pcblib';
import { decodePrim } from '../src/formats/altium/pcbdoc';
import { newSchDoc, NEW_SHEET_PARAMETERS } from '../src/formats/altium/schdoc';
import { demoSchLib } from '../src/formats/synthetic/demoLib';
import { demoFootprints } from '../src/formats/synthetic/demo';
import { openSchLib, writeSchLibDoc } from '../src/model/schLib';
import { footprintCounts, openPcbLib, writePcbLibDoc } from '../src/model/pcbLib';
import { SchLibEditor } from '../src/editors/sch/SchLibEditor';
import { PcbLibEditor } from '../src/editors/pcb/PcbLibEditor';
import { addFootprintChange, currentModelChanges, editModelChange, footprintModelBag, removeModelChange, symbolModels, withModelLibrary } from '../src/model/libModels';
import { isModelLibrary } from '../src/model/pcbEco';
import { splitPcbLib, splitSchLib } from '../src/model/libSplit';
import { ballRow, wizardDefaults, wizardName, wizardRecords } from '../src/model/footprintWizard';
import { lineClip } from '../src/model/smartPaste';
import { partRecords } from '../src/model/schPlace';
import { PCB_TAG } from '../src/formats/altium/framing';
import { L } from '../src/model/layers';
import { SR } from '../src/model/sch';
import { mil } from '../src/core/units';
import type { PcbPrim } from '../src/model/pcb';

const sym = (i: number, pins = 4) => ({
  libRef: `PART_${i}`, description: `Part ${i}`,
  bags: [PropertyBag.from({ RECORD: 1, LIBREFERENCE: `PART_${i}`, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, CURRENTPARTID: 1, OWNERPARTID: -1 }),
    ...Array.from({ length: pins }, (_, p) => PropertyBag.from({ RECORD: 2, OWNERPARTID: 1, PINLENGTH: 30, PINCONGLOMERATE: 0x18 | 2, DESIGNATOR: String(p + 1), NAME: `IO${p}`, ELECTRICAL: 4, 'LOCATION.X': 0, 'LOCATION.Y': -10 * p })),
    PropertyBag.from({ RECORD: 34, OWNERPARTID: -1, NAME: 'Designator', TEXT: 'U?' })],
});

describe('large libraries', () => {
  it('a property record of thousands of keys builds in linear time', () => {
    const t = performance.now();
    const b = new PropertyBag();
    for (let i = 0; i < 20_000; i++) { b.set(`LIBREF${i}`, `P${i}`); b.set(`COMPDESCR${i}`, 'x'); }
    expect(b.get('LIBREF19999')).toBe('P19999');
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it('compound files of thousands of storages find and put by name at once (renames too)', () => {
    const root = newEntry('Root Entry', 'root');
    for (let i = 0; i < 3000; i++) cfbPut(root, `S${i}/Data`, new Uint8Array([i & 255]));
    expect(cfbFind(root, 's2999/data')?.data[0]).toBe(2999 & 255);
    const s = cfbFind(root, 'S10')!;
    s.name = 'Renamed';
    expect(cfbFind(root, 'Renamed')).toBe(s);
    expect(readCfb(writeCfb(root)).root.children.length).toBe(3000);
  });

  it('a schematic library opens with only the component records parsed', () => {
    const bytes = writeSchLib(Array.from({ length: 300 }, (_, i) => sym(i)));
    const lib = readSchLib(bytes, 'big.SchLib');
    expect(lib.symbols).toHaveLength(300);
    const s = lib.symbols[123]!;
    expect([s.libRef, s.description, symbolLoaded(s), symbolRecordCount(s)]).toEqual(['PART_123', 'Part 123', false, 6]);
    expect(s.bags).toHaveLength(6);
    expect(symbolLoaded(s)).toBe(true);
    // Saving touches only what was shown: untouched symbols keep their streams
    const doc = openSchLib(bytes, 'big.SchLib');
    const back = readSchLib(writeSchLibDoc(doc), 'x');
    expect(back.symbols.map((x) => x.libRef)).toEqual(lib.symbols.map((x) => x.libRef));
    expect(doc.symbols.every((x) => !symbolLoaded(x))).toBe(true);
  });

  it('a PCB library opens without decoding footprints; counts come from the records', () => {
    const doc = openPcbLib(writePcbLib(demoFootprints()), 'Demo.PcbLib');
    expect(doc.footprints.every((f) => f.loaded === false)).toBe(true);
    const c = footprintCounts(doc.footprints[0]!);
    expect(c.pads).toBeGreaterThan(0);
    expect(doc.footprints[0]!.loaded).toBe(false);
    const bytes = writePcbLibDoc(doc);
    expect(doc.footprints.every((f) => f.loaded === false)).toBe(true);
    expect(readPcbLib(bytes, 'x').footprints.map((f) => f.name)).toEqual(doc.footprints.map((f) => f.name));
    expect(doc.footprints[0]!.doc.prims.filter((p) => p.kind === 'pad')).toHaveLength(c.pads);
  });
});

describe('model PCB Library', () => {
  it('MODELDATAFILE0 holds a Library name or path, just before the entity, as AD17 writes it', () => {
    const keys = (b: PropertyBag) => b.keys().filter((k) => /^(DATAFILECOUNT|MODELDATAFILE)/.test(k));
    const any = footprintModelBag(3, { name: '_0805_CAP', current: true });
    expect(any.has('MODELDATAFILE0')).toBe(false);
    expect(any.has('USECOMPONENTLIBRARY')).toBe(false);
    const named = footprintModelBag(3, { name: '_0805_CAP', library: 'Test.PcbLib' });
    expect(keys(named)).toEqual(['DATAFILECOUNT', 'MODELDATAFILE0', 'MODELDATAFILEENTITY0', 'MODELDATAFILEKIND0']);
    const path = withModelLibrary(any, 'D:\\Libraries\\Shared\\Footprints.PcbLib');
    expect(keys(path)).toEqual(['DATAFILECOUNT', 'MODELDATAFILE0', 'MODELDATAFILEENTITY0', 'MODELDATAFILEKIND0']);
    expect(withModelLibrary(path, '').has('MODELDATAFILE0')).toBe(false);
    // The component library wins over a name
    expect(footprintModelBag(3, { name: 'X', useComponentLibrary: true, library: 'Test.PcbLib' }).has('MODELDATAFILE0')).toBe(false);
    expect(isModelLibrary('Footprints.PcbLib', 'D:\\Libraries\\Footprints.PcbLib')).toBe(true);
    expect(isModelLibrary('footprints.pcblib', 'Footprints.PcbLib')).toBe(true);
    expect(isModelLibrary('Other.PcbLib', 'D:\\Libraries\\Footprints.PcbLib')).toBe(false);
  });
  it('Model Manager edit sets and clears the library', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    const ed = new SchLibEditor(lib);
    const s = lib.symbols[0]!;
    ed.editSymbols('Add', [{ sym: s, build: (v) => [addFootprintChange(v, 'SOIC8', '', 'Test.PcbLib')] }]);
    let m = symbolModels(ed.viewFor(s)).find((q) => q.name === 'SOIC8')!;
    expect(m.library).toBe('Test.PcbLib');
    ed.editSymbols('Edit', [{ sym: s, build: (v) => [editModelChange(v, m.index, 'SOIC8', '', '')] }]);
    m = symbolModels(ed.viewFor(s)).find((q) => q.name === 'SOIC8')!;
    expect(m.library).toBe('');
  });
});

describe('library tools', () => {
  it('Model Manager: add, make current and remove footprints on a symbol', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    const ed = new SchLibEditor(lib);
    const s = lib.symbols[0]!;
    const before = symbolModels(ed.peek(s)).filter((m) => m.footprint).length;
    ed.editSymbols('Add', [{ sym: s, build: (v) => [addFootprintChange(v, 'SOIC8', 'small outline')] }]);
    let ms = symbolModels(ed.viewFor(s)).filter((m) => m.footprint);
    expect(ms.length).toBe(before + 1);
    const added = ms.find((m) => m.name === 'SOIC8')!;
    expect(added.current).toBe(before === 0);
    ed.editSymbols('Current', [{ sym: s, build: (v) => currentModelChanges(v, added.index) }]);
    ms = symbolModels(ed.viewFor(s)).filter((m) => m.footprint);
    expect(ms.filter((m) => m.current).map((m) => m.name)).toEqual(['SOIC8']);
    // The same name again is refused
    expect(addFootprintChange(ed.viewFor(s), 'soic8')).toBeNull();
    ed.editSymbols('Remove', [{ sym: s, build: (v) => [removeModelChange(v, added.index)] }]);
    expect(symbolModels(ed.viewFor(s)).filter((m) => m.footprint).length).toBe(before);
    ed.undo.undo();
    expect(symbolModels(ed.viewFor(s)).some((m) => m.name === 'SOIC8')).toBe(true);
  });

  it('Library Splitter: one readable library per component', () => {
    const lib = openSchLib(writeSchLib([sym(1), sym(2), sym(3, 8)]), 'Three.SchLib');
    const files = splitSchLib(lib);
    expect(files.map((f) => f.name)).toEqual(['PART_1.SchLib', 'PART_2.SchLib', 'PART_3.SchLib']);
    const third = readSchLib(files[2]!.bytes, files[2]!.name);
    expect(third.symbols.map((s) => [s.libRef, s.bags.length])).toEqual([['PART_3', 10]]);
    const pcb = openPcbLib(writePcbLib(demoFootprints()), 'Demo.PcbLib');
    const parts = splitPcbLib(pcb);
    expect(parts).toHaveLength(pcb.footprints.length);
    for (const [i, f] of parts.entries()) expect(readPcbLib(f.bytes, f.name).footprints.map((x) => x.name)).toEqual([pcb.footprints[i]!.name]);
    // Splitting doesn't touch the library itself
    expect(pcb.footprints.every((f) => f.loaded === false)).toBe(true);
  });

  it('Set Reference: Pin 1 and Center move the footprint origin', () => {
    const doc = openPcbLib(writePcbLib(demoFootprints()), 'Demo.PcbLib');
    const ed = new PcbLibEditor(doc);
    const p1 = ed.pin1()!;
    expect(ed.setReference(p1)).toBe(true);
    expect(ed.pin1()).toEqual({ x: 0, y: 0 });
    ed.undo.undo();
    expect(ed.pin1()).toEqual(p1);
  });

  it('Component Wizard: DIP14, SOP8, QUAD44, BGA and two-pin parts', () => {
    const decode = (s: Parameters<typeof wizardRecords>[0]) => wizardRecords(s).map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).filter((p): p is PcbPrim => !!p);
    const dip = decode(wizardDefaults('dip'));
    const pads = dip.filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    expect(pads.map((p) => p.name)).toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1)));
    expect([pads[0]!.at, pads[0]!.top.shape, pads[1]!.top.shape, pads[0]!.layer, pads[0]!.hole]).toEqual([{ x: 0, y: 0 }, 'rect', 'round', L.MULTI, mil(32)]);
    expect(pads[13]!.at).toEqual({ x: mil(300), y: 0 });
    expect(dip.some((p) => p.kind === 'track' && p.layer === L.TOP_OVERLAY)).toBe(true);
    expect(wizardName(wizardDefaults('dip'))).toBe('DIP14');
    const sop = decode(wizardDefaults('sop')).filter((p) => p.kind === 'pad');
    expect(sop.every((p) => p.kind === 'pad' && p.layer === L.TOP && p.hole === 0)).toBe(true);
    const quad = decode(wizardDefaults('quad')).filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    expect(quad).toHaveLength(44);
    expect(quad[11]!.top.w).toBe(mil(14));            // bottom side: turned
    const bga = decode({ ...wizardDefaults('bga'), rows: 10, cols: 2 }).filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    expect(bga.map((p) => p.name).filter((n) => n.endsWith('1'))).toEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'J1', 'K1']);
    expect([ballRow(19), ballRow(20)]).toEqual(['Y', 'AA']);
    const chip = decode({ ...wizardDefaults('res'), smd: true, hole: 0 }).filter((p): p is Extract<PcbPrim, { kind: 'pad' }> => p.kind === 'pad');
    expect(chip.map((p) => [p.name, p.at.x, p.layer])).toEqual([['1', -mil(200), L.TOP], ['2', mil(200), L.TOP]]);
    // The records are footprint records: pads, then the overlay
    expect(wizardRecords(wizardDefaults('cap')).map((r) => r.tag)).toEqual([PCB_TAG.PAD, PCB_TAG.PAD, PCB_TAG.ARC]);
  });

  it('Paste Array: copies along, designators by the primary step, pin names by the secondary', () => {
    const pin = PropertyBag.from({ RECORD: SR.PIN, DESIGNATOR: '1', NAME: 'D0', 'LOCATION.X': 0, 'LOCATION.Y': 0, PINLENGTH: 30 });
    const out = lineClip({ kind: 'sch', ref: { x: 0, y: 0 }, items: [{ bag: pin, owner: -1 }] }, 4, { x: 0, y: -1_000_000 }, 1, 2);
    expect(out.items.map((it) => [it.bag.get('DESIGNATOR'), it.bag.get('NAME'), it.bag.get('LOCATION.Y')])).toEqual([['1', 'D0', '0'], ['2', 'D2', '-10'], ['3', 'D4', '-20'], ['4', 'D6', '-30']]);
  });

  it('a library pin swap group becomes SWAPIDPIN on the sheet', () => {
    const s = sym(1, 1);
    s.bags[1]!.set('SWAPIDGROUP', 'G1');
    const items = partRecords(s, 'X.SchLib');
    const pin = items.find((it) => it.bag.int('RECORD') === SR.PIN)!.bag;
    expect([pin.get('SWAPIDPIN'), pin.has('SWAPIDGROUP')]).toEqual(['G1', false]);
  });
});

describe('a new sheet is AD17’s', () => {
  it('Dxp units, A4 without SHEETSTYLE, and the 27 document parameters', () => {
    const d = newSchDoc('Sheet1.SchDoc');
    const sheet = d.records[1]!.bag!;
    expect([sheet.get('DISPLAY_UNIT'), sheet.has('SHEETSTYLE'), sheet.get('CUSTOMX'), sheet.get('SHEETNUMBERSPACESIZE')]).toEqual(['4', false, '1500', '4']);
    const params = d.records.slice(2).map((r) => r.bag!);
    expect(params.map((b) => b.get('NAME'))).toEqual(NEW_SHEET_PARAMETERS);
    expect(params.every((b) => b.get('TEXT') === '*' && b.bool('ISHIDDEN') && b.get('READONLYSTATE') === '1')).toBe(true);
    expect([params[0]!.has('INDEXINSHEET'), params[26]!.get('INDEXINSHEET')]).toEqual([false, '26']);
    expect(d.records[0]!.bag!.get('WEIGHT')).toBe('28');
    expect(newSchDoc('A3.SchDoc', 1).records[1]!.bag!.get('SHEETSTYLE')).toBe('1');
  });
});
