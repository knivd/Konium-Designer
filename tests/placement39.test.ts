import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { UndoStack } from '../src/core/undo';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbDocument, PcbTrack } from '../src/model/pcb';
import { componentExtent, editRooms, newRoom, roomsOf, wrapOutline, withOutline } from '../src/model/rooms';
import { roomMembers } from '../src/model/roomScope';
import { runDrc } from '../src/model/drc';
import { replaceRecords } from '../src/model/pcbEdit';
import { freshUnionName, nextUnion, setUnionMeta, unionEdits, unionMembers, unionOf } from '../src/model/unions';
import { pointInPoly } from '../src/core/geom';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const tx = (_d: PcbDocument, f: Parameters<UndoStack['transact']>[1]) => { const u = new UndoStack(); u.transact('t', f); return u; };

describe('rooms', () => {
  it('a room round U1 is a Room Definition rule, saved, holding U1 by its scope; the DRC keeps U1 inside', () => {
    const doc = demo();
    const u1 = doc.components.findIndex((c) => c.designator === 'U1');
    const b = componentExtent(doc, u1)!;
    const room = newRoom(doc.rules, { outline: wrapOutline([b], 'rect', mil(10)), scope: "InComponent('U1')", layer: L.TOP });
    tx(doc, (t) => t.add(editRooms(doc, { add: [room] })));
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    const rooms = roomsOf(back);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toEqual(expect.objectContaining({ scope: "InComponent('U1')", confine: 'ConfineIn', layer: L.TOP }));
    expect(rooms[0]!.outline).toHaveLength(4);
    expect(roomMembers(back, rooms[0]!)).toEqual([u1]);
    expect(runDrc(back, new Set(['RoomDefinition'])).violations).toEqual([]);
    // The room moved off U1: a Room Definition violation
    const r = rooms[0]!;
    tx(back, (t) => t.add(editRooms(back, { set: new Map([[r.rule, withOutline(back.rules[r.rule]!, r.outline.map((p) => ({ x: p.x + mm(20), y: p.y })))]]) })));
    const v = runDrc(back, new Set(['RoomDefinition'])).violations;
    expect(v.map((x) => x.kind)).toEqual(['RoomDefinition']);
    expect(v[0]!.message).toMatch(/Room Definition: Between Room RoomDefinition_1 .* And Component U1/);
  });
  it('outlines round components: rectangle, orthogonal and convex, each holding them all', () => {
    const doc = demo();
    const boxes = ['C1', 'U1', 'C2'].map((d) => componentExtent(doc, doc.components.findIndex((c) => c.designator === d))!);
    for (const kind of ['rect', 'ortho', 'nonortho'] as const) {
      const o = wrapOutline(boxes, kind, mil(10));
      expect(o.length).toBeGreaterThanOrEqual(4);
      for (const b of boxes) for (const q of [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }]) expect(pointInPoly(q, o)).toBe(true);
    }
  });
  it('a selected room moves with what lies in it', () => {
    const doc = demo();
    const ed = new PcbEditor(doc);
    ed.scene();
    const u1 = doc.components.findIndex((c) => c.designator === 'U1');
    const room = newRoom(doc.rules, { outline: wrapOutline([componentExtent(doc, u1)!], 'rect', mil(20)) });
    ed.undo.transact('room', (t) => t.add(editRooms(doc, { add: [room] })));
    const set = ed.moveSet([`room:${doc.rules.length - 1}`]);
    expect(set.rooms).toEqual([doc.rules.length - 1]);
    expect(set.components).toEqual([u1]);
  });
});

describe('unions', () => {
  it('tracks put in a union are saved with its index and name, and select together', () => {
    const doc = demo();
    const ts = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === 1).slice(0, 2);
    const u = nextUnion(doc);
    tx(doc, (t) => { t.add(replaceRecords(doc, unionEdits(doc, ts, u))); t.add(setUnionMeta(doc, [{ index: u, name: freshUnionName(doc, 'Unions') }], [])); });
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(back.unionNames).toEqual([{ index: u, name: 'Unions' }]);
    expect(unionMembers(back, u).prims).toHaveLength(2);
    const ed = new PcbEditor(back);
    ed.scene();
    const m = unionMembers(back, u).prims[0]!;
    expect(ed.keysFor(`${m.src.storage}:${m.src.index}`)).toHaveLength(2);
    expect(freshUnionName(back, 'Unions')).toBe('Unions 1');
    // A new track from the board's template isn't in the union
    expect(unionOf(back, back.prims.find((p) => p.kind === 'track' && unionOf(back, p) === 0)!)).toBe(0);
  });
});
