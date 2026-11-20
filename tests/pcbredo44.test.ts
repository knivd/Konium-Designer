import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addTracks, removePrims, moveComponent, removeComponents } from '../src/model/pcbEdit';
import { itemChange } from '../src/model/pcbEco';
import { UndoStack } from '../src/core/undo';
import { L } from '../src/model/layers';
import { NO_NET } from '../src/model/pcb';

const tracks = (d: ReturnType<typeof readPcbDoc>) => d.prims.filter((p) => p.kind === 'track').map((p) => p.kind === 'track' ? `${p.a.x},${p.a.y}-${p.b.x},${p.b.y}` : '').sort();

describe('PCB undo and redo', () => {
  it('a step after a delete redoes onto the records as they are then', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'd');
    const u = new UndoStack();
    const t0 = doc.prims.find((p) => p.kind === 'track' && p.polygon === NO_NET)!;
    u.transact('Delete', (tx) => tx.add(removePrims(doc, [t0])));
    u.transact('Route', (tx) => tx.add(addTracks(doc, [{ layer: L.TOP, a: { x: 0, y: 0 }, b: { x: 100000, y: 0 }, width: 10000 }])));
    const after = tracks(doc);
    u.undo(); u.undo(); u.redo(); u.redo();
    expect(tracks(doc)).toEqual(after);
    u.undo(); u.undo();
    u.transact('both', (tx) => { tx.add(removePrims(doc, [doc.prims.find((p) => p.kind === 'track' && p.polygon === NO_NET)!])); tx.add(addTracks(doc, [{ layer: L.TOP, a: { x: 0, y: 0 }, b: { x: 0, y: 100000 }, width: 10000 }])); });
    const both = tracks(doc);
    u.undo(); u.redo();
    expect(tracks(doc)).toEqual(both);
  });
  it('a component moved after another was deleted: redo moves the right one', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'd');
    const u = new UndoStack();
    u.transact('Delete', (tx) => tx.add(removeComponents(doc, [0])));
    const c = doc.components[0]!;
    u.transact('Move', (tx) => tx.add(moveComponent(doc, 0, { x: 1_000_000, y: 0 }, 0)));
    const pads = () => doc.prims.filter((p) => p.kind === 'pad' && p.component === 0).map((p) => p.kind === 'pad' ? p.at.x : 0);
    const moved = pads();
    u.undo(); u.undo(); u.redo(); u.redo();
    expect(doc.components[0]!.designator).toBe(c.designator);
    expect(pads()).toEqual(moved);
  });
  it('a pin\'s net changed after a delete keeps through undo and redo', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'd');
    const u = new UndoStack();
    const pad = doc.prims.find((p) => p.kind === 'pad' && p.component !== NO_NET && p.net !== NO_NET)!;
    if (pad.kind !== 'pad') throw new Error();
    const des = doc.components[pad.component]!.designator, other = doc.nets.find((n) => n.index !== pad.net)!;
    const t0 = doc.prims.find((p) => p.kind === 'track' && p.polygon === NO_NET)!;
    u.transact('Delete', (tx) => tx.add(removePrims(doc, [t0])));
    u.transact('ECO', (tx) => tx.add(itemChange(doc, { kind: 'addPin', designator: des, pad: pad.name, net: other.name } as never, () => undefined)));
    const net = () => doc.prims.find((p) => p.kind === 'pad' && p.src.storage === pad.src.storage && p.src.index === pad.src.index)!;
    expect((net() as typeof pad).net).toBe(other.index);
    u.undo(); expect((net() as typeof pad).net).toBe(pad.net);
    u.undo(); u.redo(); u.redo();
    expect((net() as typeof pad).net).toBe(other.index);
  });
});
