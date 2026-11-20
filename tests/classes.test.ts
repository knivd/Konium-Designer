import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { UndoStack } from '../src/core/undo';
import { classBag, membersOf, setClasses, withMembers, candidates } from '../src/model/pcbClasses';
import { runPcbQuery } from '../src/model/pcbQuery';
import { pcbObjects, pcbProps } from '../src/model/pcbProps';
import { readDrillPairs, readLayerSets, writeDrillPairs, writeLayerSets } from '../src/model/layerSets';
import { editBoard } from '../src/model/pcbBoard';
import { L } from '../src/model/layers';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const ctx = (doc: ReturnType<typeof demo>) => ({ doc, units: 'mil' as const, origin: doc.board.origin });

describe('object classes', () => {
  it('a class edited and a new one added are saved in Classes6, members before the unique ID, and undo takes them back', () => {
    const doc = demo();
    const power = doc.classes.find((c) => c.name === 'Power')!;
    const bags = [...doc.classes.map((c) => (c === power ? withMembers(c.bag, [...c.members, 'GND']) : c.bag)), classBag('Signals', 0, ['VIN'])];
    const u = new UndoStack();
    u.transact('Edit classes', (tx) => tx.add(setClasses(doc, bags)));
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(back.classes.find((c) => c.name === 'Power')!.members).toEqual(['VIN', '+3V3', 'GND']);
    expect(back.classes.find((c) => c.name === 'Signals')!.members).toEqual(['VIN']);
    const keys = Object.keys(back.classes.find((c) => c.name === 'Power')!.bag.toObject());
    expect(keys.indexOf('M2')).toBeLessThan(keys.indexOf('UNIQUEID'));
    u.undo();
    expect(doc.classes.find((c) => c.name === 'Power')!.members).toEqual(['VIN', '+3V3']);
    expect(doc.dirty.has('Classes6')).toBe(false);
  });
  it('what a class can hold, and the members AD17 works out (All Nets)', () => {
    const doc = demo();
    expect(candidates(doc, 0).sort()).toEqual(doc.nets.map((n) => n.name).sort());
    expect(candidates(doc, 1)).toContain('U1');
    const all = { ...doc.classes[0]!, superClass: true, kind: 0 };
    expect(membersOf(doc, all).length).toBe(doc.nets.length);
  });
});

describe('PCB queries', () => {
  it('keywords, comparisons on properties, classes and wildcards', () => {
    const doc = demo(), x = ctx(doc);
    const n = (q: string) => runPcbQuery(q, x).length;
    expect(n('IsVia')).toBe(doc.prims.filter((p) => p.kind === 'via').length);
    expect(n("IsPad And InComponent('U1')")).toBe(4);
    expect(n("IsComponent And (Footprint Like '*0805*')")).toBe(2);
    expect(n('IsTrack And (Width < 20mil)')).toBe(n('IsTrack And (Width < 20)'));
    expect(n("InNetClass('Power')")).toBeGreaterThan(0);
    expect(() => runPcbQuery("InNetClass('Nope')", x)).toThrow();
    expect(n('IsTrack And Not (Width < 20mil)') + n('IsTrack And (Width < 20mil)')).toBe(n('IsTrack'));
  });
  it('a property set from the list is one change', () => {
    const doc = demo(), x = ctx(doc);
    const t = pcbObjects(doc).find((o) => o.prim?.kind === 'track' && o.prim.component === 0xffff && o.prim.polygon === 0xffff)!;
    const w = pcbProps(t, x).find((p) => p.name === 'Width')!;
    const u = new UndoStack();
    u.transact('w', (tx) => tx.add(w.set!('33mil')!));
    expect(doc.prims.find((p) => p.src.storage === t.prim!.src.storage && p.src.index === t.prim!.src.index)!.kind === 'track'
      && (doc.prims.find((p) => p.src.storage === t.prim!.src.storage && p.src.index === t.prim!.src.index) as { width: number }).width).toBe(330000);
    u.undo();
  });
});

describe('Board6 drill pairs and layer sets', () => {
  it('read and written back as AD17 keeps them', () => {
    const doc = demo();
    const pairs = readDrillPairs(doc.board.bag);
    expect(pairs).toEqual([expect.objectContaining({ low: L.TOP, high: L.BOTTOM })]);
    const sets = readLayerSets(doc.board.bag);
    expect(sets.map((s) => s.name)).toContain('&Signal Layers');
    const u = new UndoStack();
    u.transact('b', (tx) => tx.add(editBoard(doc, (b) => {
      writeDrillPairs(b, [...pairs, { low: L.TOP, high: L.MID1, guide: true, drawing: false }]);
      writeLayerSets(b, [...sets, { name: 'Copper', layers: [L.TOP, L.BOTTOM], active: L.BOTTOM, current: false, locked: false, flip: true }]);
    })));
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(readDrillPairs(back.board.bag).map((p) => [p.low, p.high, p.guide])).toEqual([[L.TOP, L.BOTTOM, false], [L.TOP, L.MID1, true]]);
    const s2 = readLayerSets(back.board.bag);
    expect(s2.at(-1)).toEqual(expect.objectContaining({ name: 'Copper', layers: [L.TOP, L.BOTTOM], active: L.BOTTOM, flip: true }));
    expect(s2.length).toBe(sets.length + 1);
    u.undo();
    expect(readDrillPairs(doc.board.bag).length).toBe(1);
  });
});
