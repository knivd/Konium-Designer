import { describe, expect, it } from 'vitest';
import { newSchDoc } from '../src/formats/altium/schdoc';
import { addRecords, wireBag, junctionBag } from '../src/model/schEdit';
import { afterWire, partsCutWires, type WireOpts } from '../src/model/wireTidy';
import { portBag, sheetSymbolItems } from '../src/model/schPlace';
import { connectedTo, hopped, junctionConnections, shownEntryShape, shownPortStyle, touchTest, wireHops } from '../src/model/schLook';
import { autoJunctions } from '../src/model/schConnect';
import { dragAttached } from '../src/model/schDrag';
import { identity } from '../src/model/schTransform';
import { crossJunctionChanges } from '../src/model/crossJunctions';
import { formatSchLength, mil } from '../src/core/units';
import { UndoStack, type Change } from '../src/core/undo';
import { PropertyBag } from '../src/formats/altium/props';
import { SR, partSuffix, type SchDocument, type SchObject } from '../src/model/sch';
import type { Vec2 } from '../src/core/geom';

const M = (x: number, y: number): Vec2 => ({ x: mil(x), y: mil(y) });
const OPTS: WireOpts = { breakAtJunctions: true, optimize: true, autoEntries: true, convertCross: false, step: mil(100), grid: mil(100) };
const wires = (d: SchDocument) => d.objects.filter((o): o is SchObject & { kind: 'wire' } => o.kind === 'wire');
const ptsMil = (o: { pts: Vec2[] }) => o.pts.map((p) => [p.x / 10_000, p.y / 10_000]);
/** Place a wire as the tool does: add it, then tidy. */
function place(d: SchDocument, pts: Vec2[], o: Partial<WireOpts> = {}): void {
  const b = wireBag(pts);
  addRecords(d, [b]).apply();
  afterWire(d, b.get('UNIQUEID')!, { ...OPTS, ...o }, (c: Change) => c.apply());
}

describe('wire tidy on placement (Preferences › Schematic › General)', () => {
  it('Break Wires At Autojunctions: ending part-way along a wire splits it there', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(1000, 0)]);
    place(d, [M(500, 500), M(500, 0)]);
    const ws = wires(d).map(ptsMil);
    expect(ws).toContainEqual([[0, 0], [500, 0]]);
    expect(ws).toContainEqual([[500, 0], [1000, 0]]);
    expect(ws).toHaveLength(3);
  });

  it('off: the wire it ends on stays whole', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(1000, 0)], { breakAtJunctions: false });
    place(d, [M(500, 500), M(500, 0)], { breakAtJunctions: false });
    expect(wires(d)).toHaveLength(2);
  });

  it('Optimize Wires: an end-on, in-line wire joins the one it continues', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(500, 0)]);
    place(d, [M(500, 0), M(900, 0)]);
    expect(wires(d).map(ptsMil)).toEqual([[[0, 0], [900, 0]]]);
    // A corner isn't in line: two wires stay
    place(d, [M(900, 0), M(900, 300)]);
    expect(wires(d)).toHaveLength(2);
  });

  it('does not join where a third wire meets', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(500, 0)]);
    place(d, [M(500, 0), M(500, 400)]);
    place(d, [M(500, 0), M(900, 0)]);
    expect(wires(d)).toHaveLength(3);
  });

  it('Place Sheet Entries automatically: a wire ended on a sheet symbol edge gets an entry there', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, sheetSymbolItems(M(1000, 2000), M(2000, 1000)).map((it, k, all) => { if (it.owner >= 0) it.bag.set('OWNERINDEX', String(d.objects.length + it.owner)); void all; void k; return it.bag; })).apply();
    place(d, [M(0, 1500), M(1000, 1500)]);
    const e = d.objects.find((o) => o.kind === 'sheetentry') as (SchObject & { kind: 'sheetentry' }) | undefined;
    expect(e).toBeDefined();
    expect([e!.side, e!.distance / 10_000, e!.name]).toEqual([0, 500, 'Entry1']);
  });

  it('Convert Cross-Junctions: a wire through a junction that makes it a crossing becomes two T’s', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(1000, 0)]);
    place(d, [M(500, 0), M(500, 500)]);
    addRecords(d, [junctionBag(M(500, 0))]).apply();
    place(d, [M(500, -500), M(500, 0)], { convertCross: true });
    expect(d.objects.filter((o) => o.kind === 'junction').map((o) => [(o as { at: Vec2 }).at.x / 10_000, (o as { at: Vec2 }).at.y / 10_000])).toContainEqual([600, 0]);
  });

  it('crossJunctionChanges can look only at given points', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(1000, 0)], { breakAtJunctions: false });
    place(d, [M(500, -500), M(500, 500)], { breakAtJunctions: false });
    expect(crossJunctionChanges(d, mil(100), [M(500, 0)]).count).toBe(1);
    expect(crossJunctionChanges(d, mil(100), [M(200, 0)]).count).toBe(0);
  });
});

describe('Components Cut Wires', () => {
  it('a part dropped with both pin ends on a wire opens the wire between them', () => {
    const d = newSchDoc('T.SchDoc');
    place(d, [M(0, 0), M(2000, 0)]);
    const first = d.objects.length;
    const comp = PropertyBag.from({ RECORD: SR.COMPONENT, OWNERPARTID: -1, CURRENTPARTID: 1, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, LIBREFERENCE: 'Res' });
    const pin = (x: number, conglomerate: number) => PropertyBag.from({ RECORD: SR.PIN, OWNERINDEX: first, OWNERPARTID: 1, PINCONGLOMERATE: conglomerate | 0x18, PINLENGTH: 10, NAME: 'P', DESIGNATOR: '1', 'LOCATION.X': x, 'LOCATION.Y': 0 });
    // Pins 100 mil long pointing outwards: ends at 800 and 1200
    addRecords(d, [comp, pin(90, 2), pin(110, 0)]).apply();
    partsCutWires(d, [first], (c) => c.apply());
    expect(wires(d).map(ptsMil).sort()).toEqual([[[0, 0], [800, 0]], [[1200, 0], [2000, 0]]]);
  });
});

describe('drawing preferences', () => {
  const portDoc = (io: number, joinLeft: boolean, joinRight: boolean) => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [portBag('P', M(1000, 0), mil(500), 0, io)]).apply();
    if (joinLeft) addRecords(d, [wireBag([M(0, 0), M(1000, 0)])]).apply();
    if (joinRight) addRecords(d, [wireBag([M(1500, 0), M(2000, 0)])]).apply();
    return { d, port: d.objects.find((o) => o.kind === 'port') as SchObject & { kind: 'port' } };
  };
  it('Port Direction: outputs point away from the wire, inputs towards it, bidirectional both ways', () => {
    let t = portDoc(1, true, false); expect(shownPortStyle(t.port, touchTest(t.d), false)).toBe(2);
    t = portDoc(2, true, false); expect(shownPortStyle(t.port, touchTest(t.d), false)).toBe(1);
    t = portDoc(1, false, true); expect(shownPortStyle(t.port, touchTest(t.d), false)).toBe(1);
    t = portDoc(3, false, false); expect(shownPortStyle(t.port, touchTest(t.d), false)).toBe(3);
  });
  it('Unconnected Left To Right: a loose output points right; without it the file’s style stays', () => {
    const t = portDoc(1, false, false);
    expect(shownPortStyle(t.port, touchTest(t.d), true)).toBe(2);
    expect(shownPortStyle(t.port, touchTest(t.d), false)).toBe(0);
  });
  it('Sheet Entry Direction off: the entry’s own style decides', () => {
    expect(shownEntryShape(2, 0, 0, true)).toBe(2);
    expect(shownEntryShape(2, 0, 0, false)).toBe(0);
    expect(shownEntryShape(0, 1, 0, false)).toBe(1);
    expect(shownEntryShape(0, 1, 1, false)).toBe(2);
    expect(shownEntryShape(0, 3, 1, false)).toBe(3);
  });
  it('Display Cross-Overs: the newer wire hops (vertical bulges right, horizontal up), not at a junction', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(0, 0), M(1000, 0)]), wireBag([M(500, -500), M(500, 500)])]).apply();
    let hops = wireHops(d);
    expect([...hops.values()].flat()).toEqual([M(500, 0)]);
    const v = d.objects.find((o) => o.kind === 'wire' && hops.has(o.index)) as SchObject & { kind: 'wire' };
    expect(v.pts[0]!.x).toBe(v.pts[1]!.x);                       // the vertical one, drawn second
    let drawn = hopped(v.pts, hops.get(v.index)!, mil(10));
    expect(drawn.length).toBe(2 + 9);
    expect(Math.max(...drawn.map((p) => p.x))).toBe(mil(510));
    // Drawn the other way round: the horizontal one hops, bulging up
    const e = newSchDoc('U.SchDoc');
    addRecords(e, [wireBag([M(500, -500), M(500, 500)]), wireBag([M(0, 0), M(1000, 0)])]).apply();
    hops = wireHops(e);
    const h = e.objects.find((o) => o.kind === 'wire' && hops.has(o.index)) as SchObject & { kind: 'wire' };
    expect(h.pts[0]!.y).toBe(h.pts[1]!.y);
    drawn = hopped(h.pts, hops.get(h.index)!, mil(10));
    expect(Math.max(...drawn.map((p) => p.y))).toBeCloseTo(mil(10), 6);
    addRecords(d, [junctionBag(M(500, 0))]).apply();
    expect(wireHops(d).size).toBe(0);
  });
  it('Manual Junctions Connection Status counts what meets each junction', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(0, 0), M(1000, 0)]), wireBag([M(500, 0), M(500, 500)]), junctionBag(M(500, 0)), junctionBag(M(0, 0))]).apply();
    expect([...junctionConnections(d).values()]).toEqual([3, 1]);
  });
  it('auto-junctions on buses', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(0, 0), M(1000, 0)], { bus: true }), wireBag([M(500, 0), M(500, 500)], { bus: true })]).apply();
    expect(autoJunctions(d)).toHaveLength(0);
    expect(autoJunctions(d, 'bus').map((j) => j.at)).toEqual([M(500, 0)]);
  });
  it('Alpha Numeric Suffix', () => {
    expect([partSuffix(2), partSuffix(2, true)]).toEqual(['B', ':2']);
  });
  it('document units in the status bar', () => {
    expect(formatSchLength(mil(1250), 4)).toBe('125');
    expect(formatSchLength(mil(1250), 0)).toBe('1250mil');
    expect(formatSchLength(mil(1250), 2)).toBe('1.25in');
    expect(formatSchLength(mil(1250), 6)).toBe('1.25in');
    expect(formatSchLength(mil(500), 6)).toBe('500mil');
    expect(formatSchLength(mil(1000), 1)).toBe('25.4mm');
  });
});

describe('dragging and AutoFocus', () => {
  it('Drag Orthogonal off: the attached end goes straight to where the pin went', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(0, 0), M(500, 0)]), junctionBag(M(500, 0))]).apply();
    const j = d.objects.find((o) => o.kind === 'junction')!;
    const x = { ...identity(M(500, 0)), d: M(0, 200) };
    const orth = dragAttached(d, new Set([j.index]), x, (k) => d.records[k + 1]?.bag, true);
    const straight = dragAttached(d, new Set([j.index]), x, (k) => d.records[k + 1]?.bag, false);
    expect([...orth.values()][0]!.int('LOCATIONCOUNT')).toBe(3);
    expect([...straight.values()][0]!.int('LOCATIONCOUNT')).toBe(2);
  });
  it('connectedTo: the wires and parts on the nets an object joins', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(0, 0), M(500, 0)]), wireBag([M(500, 0), M(500, 500)]), wireBag([M(2000, 0), M(3000, 0)]), junctionBag(M(500, 0))]).apply();
    const j = d.objects.find((o) => o.kind === 'junction')!;
    const set = connectedTo(d, [j.index]);
    expect(wires(d).filter((w) => set.has(w.index))).toHaveLength(2);
  });
});

describe('Undo/Redo preferences', () => {
  const step = (log: number[], v: number): Change => ({ apply: () => log.push(v), revert: () => log.pop() });
  it('Stack Size keeps only the newest steps', () => {
    const u = new UndoStack(); u.limit = 3;
    const log: number[] = [];
    for (let i = 0; i < 5; i++) u.transact(`s${i}`, (tx) => tx.add(step(log, i)));
    let n = 0;
    while (u.undo()) n++;
    expect(n).toBe(3);
    expect(log).toEqual([0, 1]);
  });
  it('Group Undo: the same action again straight away joins the step before', () => {
    const u = new UndoStack(); u.groupWindow = 10_000;
    const log: number[] = [];
    u.transact('Nudge', (tx) => tx.add(step(log, 1)));
    u.transact('Nudge', (tx) => tx.add(step(log, 2)));
    u.transact('Other', (tx) => tx.add(step(log, 3)));
    expect(u.undo()).toBe('Other');
    expect(u.undo()).toBe('Nudge');
    expect(log).toEqual([]);
    expect(u.canUndo).toBe(false);
  });
  it('a guard refuses edits and says why', () => {
    const u = new UndoStack();
    let why = '';
    u.guard = () => 'read-only'; u.onRefused = (w) => { why = w; };
    const log: number[] = [];
    u.transact('Edit', (tx) => tx.add(step(log, 1)));
    expect([log.length, why, u.canUndo]).toEqual([0, 'read-only', false]);
  });
});
