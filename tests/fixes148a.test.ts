import { afterEach, describe, expect, it } from 'vitest';
import { settings } from '../src/core/settings';
import { SCH_UNIT, isMetricUnit, mil, mm } from '../src/core/units';
import type { ToolPointer } from '../src/core/tools';
import { PropertyBag } from '../src/formats/altium/props';
import { decodeBinaryPin, encodeBinaryPin, libPinSwapGroup, readSchLib } from '../src/formats/altium/schlib';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { demoPcbDoc, demoPcbLib } from '../src/formats/synthetic/demo';
import { openSchLib, newSchLib, writeSchLibDoc } from '../src/model/schLib';
import { SR, bagOf, componentKind } from '../src/model/sch';
import { addRecords, setProps } from '../src/model/schEdit';
import { schProps, type SchCtx } from '../src/model/schProps';
import { pcbLibRuleCheck, PCB_CHECK_ALL, type PcbCheckOptions } from '../src/model/libCheck';
import { runDrc, CHECKED_KINDS } from '../src/model/drc';
import { L } from '../src/model/layers';
import { NO_NET, type PcbPrim, type PcbTrack } from '../src/model/pcb';
import { SchLibEditor } from '../src/editors/sch/SchLibEditor';
import { SchEditor } from '../src/editors/sch/SchEditor';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
// The app's command modules load in their own order first (they import one another)
import '../src/app/commands';
import { activeId, docs, type OpenDoc } from '../src/app/state';
import { schlibCommands } from '../src/app/schlibCommands';
import { newSheet, sheetUnit } from '../src/app/newSheet';
import { activeRouteConnections } from '../src/app/pcbAutoCommands';
import { activeRouteStatus } from '../src/app/panels/ActiveRoutePanel';
import { libComponentProps } from '../src/app/dialogs/LibComponent';
import drcSrc from '../src/app/dialogs/Drc.tsx?raw';
import libCompSrc from '../src/app/dialogs/LibComponent.tsx?raw';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); docs.value = []; activeId.value = null; });

const ptr = (x: number, y: number, button = 0): ToolPointer => ({ world: { x, y }, raw: { x, y }, button, shift: false, ctrl: false, alt: false });
const ctxOf = (ed: SchEditor, index: number): SchCtx => ({ doc: ed.doc, index, units: 'mil', docName: ed.doc.name, libraryMode: ed.libraryMode });
const prop = (x: SchCtx, name: string) => schProps(x.doc, x.doc.objects[x.index]!, x.libraryMode).find((p) => p.name === name)!;
const pinDesignators = (ed: SchEditor) => ed.doc.objects.filter((o) => o.kind === 'pin').map((o) => bagOf(ed.doc, o)!.get('DESIGNATOR'));

describe('Place › Pin numbering across runs (1)', () => {
  it('pins 1 to 3, Esc, Place › Pin again: the next is 4; Tab keeps the pin being edited as it is', () => {
    const lib = newSchLib('Pins.SchLib');
    const ed = new SchLibEditor(lib);
    docs.value = [{ id: 'lib1', name: lib.name, doc: lib, editor: ed } as unknown as OpenDoc];
    activeId.value = 'lib1';
    const place = schlibCommands().find((c) => c.id === 'place.pin')!;
    place.run();
    const g = 10 * SCH_UNIT;
    // The pin following the cursor (the last record while placing)
    const preview = () => { const b = ed.doc.records.at(-1)!.bag!; return [b.get('DESIGNATOR'), b.get('NAME')]; };
    expect(preview()).toEqual(['1', '1']);
    for (let k = 0; k < 3; k++) ed.tool.pointerDown!(ptr(0, -k * g));
    expect(preview()).toEqual(['4', '4']);
    ed.tool.key?.('Escape');
    expect(pinDesignators(ed)).toEqual(['1', '2', '3']);
    // Again: carries on at 4 (it started at 5)
    place.run();
    expect(preview()).toEqual(['4', '4']);
    ed.tool.pointerDown!(ptr(0, -3 * g));
    expect(preview()).toEqual(['5', '5']);
    // Tab on pin 5: edited to 10 / CLK and kept as it is (it kept 11 / CLK); Esc without placing it
    ed.placeProps = (b, apply) => { const n = b.clone(); n.set('DESIGNATOR', '10'); n.set('NAME', 'CLK'); apply(n); };
    expect(ed.tool.key?.('Tab')).toBe(true);
    expect(preview()).toEqual(['10', 'CLK']);
    ed.tool.key?.('Escape');
    expect(pinDesignators(ed)).toEqual(['1', '2', '3', '4']);
    place.run();
    expect(preview()).toEqual(['10', 'CLK']);
    ed.tool.pointerDown!(ptr(0, -5 * g));
    ed.tool.key?.('Escape');
    expect(pinDesignators(ed)).toEqual(['1', '2', '3', '4', '10']);
  });
});

describe('Swap ID Pin in a schematic library (2)', () => {
  it('Pin Properties edits the binary pin\'s swap group: it survives a save and shows in Configure Pin Swapping', () => {
    const lib = newSchLib('Swap.SchLib');
    const ed = new SchLibEditor(lib);
    const pin = PropertyBag.from({ RECORD: SR.PIN, ELECTRICAL: 4, PINCONGLOMERATE: 0x18, PINLENGTH: 30, NAME: 'A', DESIGNATOR: '1', 'LOCATION.X': 0, 'LOCATION.Y': 0 });
    ed.undo.transact('Place pin', (tx) => tx.add(addRecords(ed.doc, [pin])));
    const i = ed.doc.objects.findIndex((o) => o.kind === 'pin');
    const x = ctxOf(ed, i);
    ed.undo.transact('Swap ID Pin', (tx) => tx.add(prop(x, 'Swap ID Pin').set!(x, 'G7')!));
    const b = bagOf(ed.doc, ed.doc.objects[i]!)!;
    expect([b.get('SWAPIDGROUP'), b.has('SWAPIDPIN')]).toEqual(['G7', false]);
    expect(prop(x, 'Swap ID Pin').get(x)).toBe('G7');
    // Saved and read back: the binary record's swap group, shown in Pin Properties and the swapping dialog alike
    const again = openSchLib(writeSchLibDoc(lib), 'Swap.SchLib');
    const ed2 = new SchLibEditor(again);
    const j = ed2.doc.objects.findIndex((o) => o.kind === 'pin');
    const pb = bagOf(ed2.doc, ed2.doc.objects[j]!)!;
    expect(pb.get('SWAPIDGROUP')).toBe('G7');
    expect(libPinSwapGroup(pb)).toBe('G7');
    expect(prop(ctxOf(ed2, j), 'Swap ID Pin').get(ctxOf(ed2, j))).toBe('G7');
    // Clearing it clears the group
    const x2 = ctxOf(ed2, j);
    ed2.undo.transact('Swap ID Pin', (tx) => tx.add(prop(x2, 'Swap ID Pin').set!(x2, '')!));
    expect(bagOf(ed2.doc, ed2.doc.objects[j]!)!.has('SWAPIDGROUP')).toBe(false);
  });

  it('a pin still carrying a sheet\'s SWAPIDPIN keeps its group when saved; on a sheet the property stays SWAPIDPIN', () => {
    const b = PropertyBag.from({ RECORD: SR.PIN, OWNERPARTID: 1, NAME: 'A', DESIGNATOR: '1', SWAPIDPIN: 'G2', SWAPIDPART: 'P1', SWAPIDSEQUENCE: '3' });
    const back = decodeBinaryPin(encodeBinaryPin(b))!;
    expect([back.get('SWAPIDGROUP'), back.get('SWAPIDPART'), back.get('SWAPIDSEQUENCE')]).toEqual(['G2', 'P1', '3']);
    const sheet = newSheet('S.SchDoc');
    const ed = new SchEditor(sheet);
    ed.undo.transact('Pin', (tx) => tx.add(addRecords(sheet, [PropertyBag.from({ RECORD: SR.PIN, NAME: 'A', DESIGNATOR: '1' })])));
    const i = sheet.objects.findIndex((o) => o.kind === 'pin');
    const x = ctxOf(ed, i);
    ed.undo.transact('Swap ID Pin', (tx) => tx.add(prop(x, 'Swap ID Pin').set!(x, 'G5')!));
    expect([bagOf(sheet, sheet.objects[i]!)!.get('SWAPIDPIN'), bagOf(sheet, sheet.objects[i]!)!.has('SWAPIDGROUP')]).toEqual(['G5', false]);
  });
});

describe('PCB library Component Rule Check: Mirrored Component (3)', () => {
  const NONE: PcbCheckOptions = { duplicatePads: false, duplicatePrimitives: false, duplicateFootprints: false, missingPadNames: false, offsetReference: false, mirrored: false, shortedCopper: false, unconnectedCopper: false };
  const text = (layer: number, mirrored: boolean): PcbPrim => ({ kind: 'text', src: { storage: 'Texts', index: -1 }, layer, at: { x: 0, y: 0 }, height: mil(60), rotation: 0, mirrored,
    strokeWidth: mil(10), text: 'REF', component: NO_NET, isComment: false, isDesignator: false, fontType: 0, fontName: 'Arial', bold: false, italic: false } as PcbPrim);

  it('text drawn mirrored on a top-side layer is reported; bottom-side mirrored text and the demo footprints are not', () => {
    const fp = readPcbLib(demoPcbLib(), 'Demo.PcbLib').footprints[0]!;
    const withText = (t: PcbPrim) => [{ name: fp.name, prims: [...fp.prims, t] }];
    expect(pcbLibRuleCheck(withText(text(L.TOP_OVERLAY, true)), { ...NONE, mirrored: true })).toEqual([{ name: fp.name, errors: ['Mirrored Component'] }]);
    expect(pcbLibRuleCheck(withText(text(L.TOP, true)), { ...NONE, mirrored: true })[0]!.errors).toEqual(['Mirrored Component']);
    // The box off: not checked
    expect(pcbLibRuleCheck(withText(text(L.TOP_OVERLAY, true)), NONE)).toEqual([]);
    // Bottom-side text is meant to be mirrored; unmirrored top text is fine
    expect(pcbLibRuleCheck(withText(text(L.BOTTOM_OVERLAY, true)), { ...NONE, mirrored: true })).toEqual([]);
    expect(pcbLibRuleCheck(withText(text(L.TOP_OVERLAY, false)), { ...NONE, mirrored: true })).toEqual([]);
    expect(pcbLibRuleCheck(readPcbLib(demoPcbLib(), 'Demo.PcbLib').footprints, { ...PCB_CHECK_ALL, mirrored: true })).toEqual([]);
  });
});

describe('Document Options › Show Template Graphics (4)', () => {
  function sheetWithTemplate(show: boolean) {
    const b = new SchBuilder();
    b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0, TEMPLATEFILENAME: 'A4.SchDot', ...(show ? { SHOWTEMPLATEGRAPHICS: 'T' } : {}) });
    const t = b.add({ RECORD: SR.TEMPLATE, ISNOTACCESIBLE: 'T', OWNERPARTID: -1, FILENAME: 'A4.SchDot' });
    b.add({ RECORD: SR.LABEL, OWNERINDEX: t, OWNERPARTID: 1, TEXT: 'TEMPLATE TITLE', FONTID: 1 }, { LOCATION: { x: 900, y: 50 } });
    b.add({ RECORD: SR.LINE, OWNERINDEX: t, OWNERPARTID: 1, LINEWIDTH: 1 }, { LOCATION: { x: 800, y: 20 }, CORNER: { x: 1100, y: 20 } });
    b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'MY NOTE', FONTID: 1 }, { LOCATION: { x: 100, y: 100 } });
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', b.bytes());
    return readSchDoc(writeCfb(root), 'T.SchDoc');
  }
  const texts = (ed: SchEditor) => ed.scene().ordered().flatMap((g) => g.texts).map((t) => t.text);

  it('on draws the template\'s title block; off hides it and leaves the sheet\'s own objects', () => {
    const on = new SchEditor(sheetWithTemplate(true));
    expect(on.doc.sheet.showTemplate).toBe(true);
    expect(texts(on)).toEqual(expect.arrayContaining(['TEMPLATE TITLE', 'MY NOTE']));
    const off = new SchEditor(sheetWithTemplate(false));
    expect(off.doc.sheet.showTemplate).toBe(false);
    expect(texts(off)).toContain('MY NOTE');
    expect(texts(off)).not.toContain('TEMPLATE TITLE');
    const segs = (ed: SchEditor) => ed.scene().ordered().reduce((n, g) => n + g.prims.count, 0);
    expect(segs(off)).toBeLessThan(segs(on));
    // Turning it on in Document Options shows it again
    const sheet = off.doc.objects.find((o) => o.record === SR.SHEET)!;
    off.undo.transact('Document Options', (tx) => tx.add(setProps(off.doc, sheet.index, { SHOWTEMPLATEGRAPHICS: 'T' })));
    expect(texts(off)).toContain('TEMPLATE TITLE');
  });
});

describe('New sheets in the Default Units system (5)', () => {
  it('metric in Preferences › Schematic › Default Units gives a metric sheet in its metric unit; imperial an imperial one', () => {
    Object.assign(settings, { defaultUnits: 'mm', schMetricUnit: 'mm' });
    const m = newSheet('M.SchDoc');
    expect(isMetricUnit(sheetUnit(m))).toBe(true);
    expect(sheetUnit(m)).toBe(1);
    Object.assign(settings, { schMetricUnit: 'cm' });
    expect(sheetUnit(newSheet('C.SchDoc'))).toBe(3);
    Object.assign(settings, { defaultUnits: 'mil', schImperialUnit: 'dxp' });
    expect(sheetUnit(newSheet('I.SchDoc'))).toBe(4);
    Object.assign(settings, { schImperialUnit: 'mil' });
    expect(sheetUnit(newSheet('I2.SchDoc'))).toBe(0);
  });
});

describe('DRC Stop When N Violations Found (6)', () => {
  const O = { x: mil(1000), y: mil(1000) };
  const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });
  const track = (a: [number, number], b: [number, number], net: number): PcbTrack =>
    ({ kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: L.TOP, a: P(...a), b: P(...b), width: mm(0.25), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });

  it('the board markers keep only the violations reported', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // Three crossing tracks of different nets: shorts between each pair
    doc.prims = [...doc.prims, track([2, 2], [6, 6], 1), track([2, 6], [6, 2], 2), track([2, 4], [6, 4], 3)];
    const kinds = new Set(CHECKED_KINDS);
    const all = runDrc(doc, kinds).violations;
    expect(all.length).toBeGreaterThan(2);
    const ed = new PcbEditor(doc);
    const r = ed.runBatchDrc(kinds, 2);
    expect(r.violations.length).toBe(2);
    expect(ed.violations.map((v) => v.message)).toEqual(r.violations.map((v) => v.message));
    expect(ed.violations.map((v) => v.message)).toEqual(all.slice(0, 2).map((v) => v.message));
    // Without a limit every violation is marked, as before
    expect(ed.runBatchDrc(kinds).violations.length).toBe(all.length);
    expect(ed.violations.length).toBe(all.length);
    // The dialog hands its limit to the markers (Create Violations) as well as to Messages and the report
    expect(drcSrc).toMatch(/ed\.runBatchDrc\(chosen, limit\)/);
  });
});

describe('ActiveRoute panel: a selection with nothing to route (7)', () => {
  it('says so, apart from an empty selection', () => {
    expect(activeRouteStatus([], false)).toBe('Select components, pads or routing whose connections to route.');
    expect(activeRouteStatus([], true)).toBe('Nothing to route: the selection has no unrouted connections.');
    expect(activeRouteStatus([{ net: 1 }, { net: 1 }, { net: 2 }], true)).toBe('3 connections of 2 nets selected');
    expect(activeRouteStatus([{ net: 1 }], true)).toBe('1 connection of 1 net selected');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const t: PcbTrack = { kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: L.MECH1, a: { x: 0, y: 0 }, b: { x: mil(500), y: 0 }, width: mil(10), net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false };
    doc.prims = [...doc.prims, t];
    const ed = new PcbEditor(doc);
    expect(activeRouteStatus(activeRouteConnections(ed), ed.selection.size > 0)).toMatch(/^Select components/);
    ed.select([ed.keyOf(doc.prims.length - 1)!]);
    expect(ed.selection.size).toBe(1);
    expect(activeRouteConnections(ed)).toEqual([]);
    expect(activeRouteStatus(activeRouteConnections(ed), ed.selection.size > 0)).toMatch(/^Nothing to route/);
  });
});

describe('Library Component Properties › Type Standard (No BOM) (8)', () => {
  it('is written as COMPONENTKINDVERSION2=5, as the Inspector writes it and the readers read it, and survives a save', () => {
    expect(libComponentProps({ libRef: 'R', description: '', kind: '5' })).toMatchObject({ COMPONENTKIND: null, COMPONENTKINDVERSION2: '5' });
    expect(libComponentProps({ libRef: 'R', description: '', kind: '1' })).toMatchObject({ COMPONENTKIND: '1', COMPONENTKINDVERSION2: null });
    expect(libComponentProps({ libRef: 'R', description: '', kind: '0' })).toMatchObject({ COMPONENTKIND: null, COMPONENTKINDVERSION2: null });
    const lib = newSchLib('Kind.SchLib');
    const ed = new SchLibEditor(lib);
    const comp = ed.component!;
    ed.undo.transact('Component properties', (tx) => tx.add(setProps(ed.doc, comp.index, libComponentProps({ libRef: 'Component_1', description: 'No BOM', kind: '5' }))));
    const cb = bagOf(ed.doc, ed.doc.objects[comp.index]!)!;
    expect([cb.get('COMPONENTKINDVERSION2'), cb.has('COMPONENTKIND'), componentKind(cb)]).toEqual(['5', false, 5]);
    const x = ctxOf(ed, comp.index);
    expect(prop(x, 'Component Type').get(x)).toBe('Standard (No BOM)');
    const back = readSchLib(writeSchLibDoc(lib), 'Kind.SchLib').symbols[0]!.bags[0]!;
    expect(componentKind(back)).toBe(5);
    expect(back.get('COMPONENTKINDVERSION2')).toBe('5');
    // The dialog shows the kind the record holds (VERSION2 included)
    expect(libCompSrc).toMatch(/kind: String\(componentKind\(cbag\)\)/);
    expect(libCompSrc).not.toMatch(/COMPONENTKIND: f\.kind/);
  });
});
