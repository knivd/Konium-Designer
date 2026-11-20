import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { rederive, type SchDocument } from '../src/model/sch';
import { identity, mapPoint, transformBag, withChildren } from '../src/model/schTransform';
import { dragAttached, linkWires, stretchEnd } from '../src/model/schDrag';
import { addRecords, replaceBags, wireBag } from '../src/model/schEdit';
import { compileProject } from '../src/model/compile';
import { UndoStack } from '../src/core/undo';
import { mil } from '../src/core/units';
import { bytesEqual } from '../src/formats/bin';

type Comp = Extract<SchDocument['objects'][number], { kind: 'component' }>;
const comp = (doc: SchDocument, des: string) => doc.objects.find((o) => o.kind === 'component' && o.designator === des) as Comp;
const pins = (doc: SchDocument, des: string) => doc.objects.filter((o) => o.kind === 'pin' && o.owner === comp(doc, des).index) as Extract<SchDocument['objects'][number], { kind: 'pin' }>[];

function apply(doc: SchDocument, idx: number[], x: ReturnType<typeof identity>, drag = false) {
  const set = withChildren(doc, idx);
  const entries = set.map((i) => ({ index: i, before: doc.records[i + 1]!.bag!.clone(), after: transformBag(doc.records[i + 1]!.bag!, x) }));
  const links = drag ? linkWires(doc, new Set(set), x) : [];
  if (drag) for (const [i, b] of dragAttached(doc, new Set(set), x, (k) => doc.records[k + 1]?.bag)) entries.push({ index: i, before: doc.records[i + 1]!.bag!.clone(), after: b });
  const u = new UndoStack();
  u.transact('t', (tx) => { tx.add(replaceBags(doc, entries)); if (links.length) tx.add(addRecords(doc, links.map((l) => wireBag(l)))); });
  return u;
}

describe('schematic move', () => {
  it('quarter turn: component, its pins and texts turn about the pivot', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const u1 = comp(doc, 'U1');
    const before = pins(doc, 'U1').map((p) => ({ at: p.at, orient: p.orient }));
    const x = { ...identity(u1.at), quarter: 1 };
    apply(doc, [u1.index], x);
    const after = pins(doc, 'U1');
    after.forEach((p, k) => {
      expect(p.at).toEqual(mapPoint(x, before[k]!.at));
      expect(p.orient).toBe((before[k]!.orient + 1) % 4);
    });
    expect(comp(doc, 'U1').orient).toBe(1);
  });

  it('mirror X flips pins left–right and marks the component mirrored', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const j1 = comp(doc, 'J1');
    apply(doc, [j1.index], { ...identity(j1.at), mirrorX: true });
    expect(pins(doc, 'J1').every((p) => p.orient === 2)).toBe(true);
    expect(comp(doc, 'J1').mirrored).toBe(true);
  });

  it('drag keeps the netlist; move breaks it; undo restores the file', () => {
    const bytes = demoSchDoc();
    const doc = readSchDoc(bytes, 'Demo.SchDoc');
    const nets = (d: SchDocument) => compileProject([{ name: 'Demo.SchDoc', doc: d }]).nets.map((n) => `${n.name}:${n.pins.map((p) => `${p.designator}-${p.pin}`).join(',')}`).sort();
    const ref = nets(doc);
    const c1 = comp(doc, 'C1');
    const u = apply(doc, [c1.index], { ...identity(), d: { x: mil(100), y: mil(-50) } }, true);
    expect(nets(doc)).toEqual(ref);
    u.undo();
    expect(bytesEqual(writeSchDoc(doc), bytes)).toBe(true);
    apply(doc, [comp(doc, 'C1').index], { ...identity(), d: { x: mil(100), y: mil(-50) } }, false);
    expect(nets(doc)).not.toEqual(ref);
  });

  it('stretching a wire end keeps its last segment orthogonal', () => {
    const p = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    // A two-point wire gets a bend so the moved end leaves at a right angle
    expect(stretchEnd(p, 'end', { x: 100, y: 50 })).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
    const q = stretchEnd([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 'start', { x: 0, y: 30 });
    expect(q).toEqual([{ x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 100 }]);
    void rederive;
  });

  it('dragging a pin off a T leaves the junction on the wire it sits on and links back to it', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const c1 = comp(doc, 'C1');
    const tip = { x: mil(2500), y: mil(4300) };       // C1 pin 1 on the VIN wire
    expect(doc.objects.some((o) => o.kind === 'junction' && o.at.x === tip.x && o.at.y === tip.y)).toBe(true);
    apply(doc, [c1.index], { ...identity(), d: { x: mil(100), y: mil(-100) } }, true);
    expect(doc.objects.some((o) => o.kind === 'junction' && o.at.x === tip.x && o.at.y === tip.y)).toBe(true);
    const link = doc.objects.find((o) => o.kind === 'wire' && o.pts[0]!.x === tip.x && o.pts[0]!.y === tip.y);
    expect(link && link.kind === 'wire' && link.pts.at(-1)).toEqual({ x: mil(2600), y: mil(4200) });
  });
});
