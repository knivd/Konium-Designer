/**
 * The placer that carries a layout plan out (26.192): on Konium's own example board, with a plan
 * as a model writes one.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT, type LayoutPlan } from '../src/ai/jobs';
import { layoutBrief } from '../src/ai/layoutBrief';
import { LAYOUT_SAMPLE, layoutSampleBytes } from '../src/formats/synthetic/layoutSample';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { boardFrame, boxGap, connectionLength, partFacts, planOnBoard, planRooms, resultText, toUnits } from '../src/model/layoutPlan';
import { placeByPlan } from '../src/model/planPlace';
import { moveComponentsEach } from '../src/model/pcbEdit';
import { editRooms, roomsOf, withOutline } from '../src/model/rooms';
import { UndoStack } from '../src/core/undo';
import { pointInPoly } from '../src/core/geom';
import { L } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad } from '../src/model/pcb';
import { mm } from '../src/core/units';

const board = () => readPcbDoc(layoutSampleBytes(), LAYOUT_SAMPLE.name);
const ANSWER = {
  summary: 'A small USB sensor node.',
  groups: [
    { name: 'USB input and regulator', why: '', parts: ['J1', 'U1', 'C1', 'C2'], main: 'J1', x: 0.12, y: 0.5, side: 'top' },
    { name: 'Microcontroller', why: '', parts: ['U2', 'C3', 'C4', 'C5', 'C6', 'Y1', 'C7', 'C8', 'R1'], main: 'U2', x: 0.5, y: 0.5, side: 'top' },
    { name: 'Sensor', why: '', parts: ['U3', 'C9', 'R2', 'R3'], main: 'U3', x: 0.78, y: 0.82, side: 'top' },
    { name: 'Debug and indicator', why: '', parts: ['J3', 'D1', 'R4'], main: 'J3', x: 0.62, y: 0.1, side: 'top' },
    { name: 'UART header', why: '', parts: ['J2'], main: 'J2', x: 0.94, y: 0.5, side: 'top' },
  ],
  edges: [{ part: 'J1', edge: 'left', along: 0.5, why: '' }, { part: 'J3', edge: 'bottom', along: 0.6, why: '' }],
  near: [
    { part: 'C1', to: 'U1-3', mm: 3 }, { part: 'C2', to: 'U1-2', mm: 3 }, { part: 'C3', to: 'U2-1', mm: 2 }, { part: 'C4', to: 'U2-17', mm: 2 }, { part: 'C5', to: 'U2-32', mm: 2 },
    { part: 'C6', to: 'U2-5', mm: 2 }, { part: 'Y1', to: 'U2-2', mm: 5 }, { part: 'C7', to: 'Y1', mm: 3 }, { part: 'C8', to: 'Y1', mm: 3 }, { part: 'R1', to: 'U2-4', mm: 5 },
    { part: 'C9', to: 'U3-1', mm: 2 }, { part: 'R4', to: 'D1', mm: 4 },
  ],
  apart: [{ a: 'U1', b: 'U3', mm: 15 }],
  clear: [{ part: 'J1', mm: 1 }],
  notes: [],
};
const planFor = (doc: PcbDocument, answer: unknown = ANSWER): LayoutPlan => LAYOUT.check(answer, { board: '', brief: '', parts: layoutBrief(doc)!.parts, previous: '', result: '', remarks: '' });
const comp = (doc: PcbDocument, d: string) => doc.components.findIndex((c) => c.designator === d);
const boxOf = (doc: PcbDocument, d: string) => partFacts(doc)[comp(doc, d)]!.box!;
const padsOf = (doc: PcbDocument, d: string) => doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === comp(doc, d));

/** Place by the plan and apply the moves, as the panel does. */
async function placed(doc: PcbDocument, plan: LayoutPlan, scope: 'unlocked' | 'outside' = 'unlocked') {
  const u = new UndoStack();
  const r = await placeByPlan(doc, plan, planOnBoard(doc, plan, scope)!, scope);
  if (r.moves.length) u.transact('Place by the layout plan', (tx) => tx.add(moveComponentsEach(doc, r.moves)));
  return { r, u };
}

describe('Layout Planner: the placer (26.192)', () => {
  it('places every part: on the board, nothing overlapping, half a millimetre between parts, the locked one left alone', async () => {
    const doc = board(), plan = planFor(doc), f = boardFrame(doc)!;
    const j2 = { ...doc.components[comp(doc, 'J2')]!.at };
    const before = connectionLength(doc);
    const { r } = await placed(doc, plan);
    expect(r).toMatchObject({ left: [], crowded: [], stopped: false });
    expect(r.moves).toHaveLength(20);
    const facts = partFacts(doc);
    for (const x of facts) {
      expect([x.designator, x.onBoard]).toEqual([x.designator, true]);
      for (const [px, py] of [[x.box!.minX, x.box!.minY], [x.box!.maxX, x.box!.maxY], [x.box!.minX, x.box!.maxY], [x.box!.maxX, x.box!.minY]]) expect(pointInPoly({ x: px! + (px! < (f.minX + f.maxX) / 2 ? 3000 : -3000), y: py! + (py! < (f.minY + f.maxY) / 2 ? 3000 : -3000) }, doc.board.outline)).toBe(true);
    }
    for (const [i, a] of facts.entries()) for (const b of facts.slice(i + 1)) expect([a.designator, b.designator, boxGap(a.box!, b.box!) >= mm(0.5) - 2]).toEqual([a.designator, b.designator, true]);
    // Clear of the two mounting holes
    for (const h of doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === NO_NET)) for (const x of facts) expect(boxGap(x.box!, { minX: h.at.x - h.hole / 2, minY: h.at.y - h.hole / 2, maxX: h.at.x + h.hole / 2, maxY: h.at.y + h.hole / 2 })).toBeGreaterThanOrEqual(mm(0.5) - 2);
    expect(doc.components[comp(doc, 'J2')]!.at).toEqual(j2);
    // The connections are shorter than with the parts stacked beside the board, though those stood close together
    expect(connectionLength(doc)).toBeLessThan(before * 0.85);
  });

  it('at the edges: against the edge the plan names, as far along it as asked, the pads inward', async () => {
    const doc = board(), plan = planFor(doc), f = boardFrame(doc)!;
    await placed(doc, plan);
    const j1 = boxOf(doc, 'J1'), j3 = boxOf(doc, 'J3');
    expect(Math.abs(j1.minX - f.minX)).toBeLessThan(mm(0.05));
    expect(Math.abs((j1.minY + j1.maxY) / 2 - (f.minY + f.maxY) / 2)).toBeLessThan(mm(0.6));
    // Its long side along the edge, and its five signal pads further in than its middle (its mouth is at the edge)
    expect(j1.maxY - j1.minY).toBeGreaterThan(j1.maxX - j1.minX);
    const signal = padsOf(doc, 'J1').filter((p) => !/^S/.test(p.name));
    expect(Math.min(...signal.map((p) => p.at.x))).toBeGreaterThan((j1.minX + j1.maxX) / 2);
    expect(Math.abs(j3.minY - f.minY)).toBeLessThan(mm(0.05));
    expect(Math.abs((j3.minX + j3.maxX) / 2 - (f.minX + 0.6 * (f.maxX - f.minX)))).toBeLessThan(mm(0.6));
    expect(j3.maxX - j3.minX).toBeGreaterThan(j3.maxY - j3.minY);
    const on = planOnBoard(doc, plan)!;
    expect(on.edges.map((e) => [e.designator, e.placed, e.ok])).toEqual([['J1', true, true], ['J3', true, true]]);
  });

  it('what must be close is: each capacitor beside its pin with the pad that joins it nearest, the crystal at its pins, and all of it measured', async () => {
    const doc = board(), plan = planFor(doc);
    await placed(doc, plan);
    const on = planOnBoard(doc, plan)!;
    expect(on.near.filter((n) => !n.ok).map((n) => `${n.designator} ${Math.round(n.now / mm(0.1)) / 10} of ${n.mm}`)).toEqual([]);
    expect(on.near).toHaveLength(12);
    // C3's +3V3 pad is the one towards U2-1, not its ground pad
    const pin = padsOf(doc, 'U2').find((p) => p.name === '1')!, c3 = padsOf(doc, 'C3');
    const d = (p: PcbPad) => Math.hypot(p.at.x - pin.at.x, p.at.y - pin.at.y);
    expect(d(c3.find((p) => p.net === pin.net)!)).toBeLessThan(d(c3.find((p) => p.net !== pin.net)!));
    // The crystal's other pad is by the other oscillator pin
    const y1 = padsOf(doc, 'Y1'), x2 = padsOf(doc, 'U2').find((p) => p.name === '3')!;
    expect(Math.hypot(y1.find((p) => p.net === x2.net)!.at.x - x2.at.x, y1.find((p) => p.net === x2.net)!.at.y - x2.at.y)).toBeLessThan(mm(6));
    expect(on.apart.map((a) => [a.a, a.b, a.ok])).toEqual([['U1', 'U3', true]]);
    // J1 has its millimetre clear all round (and the gap between parts)
    for (const x of partFacts(doc)) if (x.designator !== 'J1') expect(boxGap(x.box!, boxOf(doc, 'J1'))).toBeGreaterThanOrEqual(mm(1.5) - 2);
    expect(resultText(on, { length: connectionLength(doc) })).toMatch(/^Every part is placed\.\nAt their edges: 2 of 2\.\nClose enough: 12 of 12\.\nFar enough apart: 1 of 1\.\nThe connections' total length is \d+ mm\.$/);
  });

  it('each group is where the plan put it: its parts in or by its zone', async () => {
    const doc = board(), plan = planFor(doc);
    const zones = planOnBoard(doc, plan)!.zones;
    await placed(doc, plan);
    const facts = partFacts(doc);
    for (const z of zones.filter((x) => x.placing.length)) {
      const mids = z.placing.map((i) => facts[i]!.box!).map((b) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }));
      const inside = mids.filter((m) => m.x >= z.box.minX - mm(2) && m.x <= z.box.maxX + mm(2) && m.y >= z.box.minY - mm(2) && m.y <= z.box.maxY + mm(2)).length;
      expect([z.name, inside >= mids.length - 1]).toEqual([z.name, true]);
    }
    // The microcontroller is at the middle of its zone
    const z = zones[1]!, u2 = boxOf(doc, 'U2');
    expect(Math.hypot((u2.minX + u2.maxX) / 2 - (z.box.minX + z.box.maxX) / 2, (u2.minY + u2.maxY) / 2 - (z.box.minY + z.box.maxY) / 2)).toBeLessThan(mm(1));
  });

  it('one undo takes the placing back; the saved board keeps it; only the parts not yet on the board when that is the choice', async () => {
    const doc = board(), plan = planFor(doc);
    const was = doc.components.map((c) => ({ ...c.at }));
    const { u } = await placed(doc, plan);
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(partFacts(back).every((f) => f.onBoard)).toBe(true);
    expect(back.components.map((c) => c.rotation)).toEqual(doc.components.map((c) => c.rotation));
    u.undo();
    expect(doc.components.map((c) => c.at)).toEqual(was);
    // Placed again, a second pass over the parts outside finds none, and moves nothing
    await placed(doc, plan);
    const at = doc.components.map((c) => ({ ...c.at }));
    const { r } = await placed(doc, plan, 'outside');
    expect(r.moves).toEqual([]);
    expect(doc.components.map((c) => c.at)).toEqual(at);
  });

  it('a room moved by the designer is where its group goes', async () => {
    const doc = board(), plan = planFor(doc), u = new UndoStack(), f = boardFrame(doc)!;
    const made = planRooms(doc, planOnBoard(doc, plan)!);
    u.transact('Rooms', (tx) => { for (const c of made.changes) tx.add(c); });
    // The Sensor's room dragged to the top left corner
    const room = roomsOf(doc).find((r) => r.name === 'Sensor')!;
    const x0 = f.minX + mm(8), y1 = f.maxY - mm(1), w = mm(8), h = mm(8);
    u.transact('Move room', (tx) => tx.add(editRooms(doc, { set: new Map([[room.rule, withOutline(doc.rules[room.rule]!, [{ x: x0, y: y1 - h }, { x: x0 + w, y: y1 - h }, { x: x0 + w, y: y1 }, { x: x0, y: y1 - 0 }])]]), add: [] })));
    const on = planOnBoard(doc, plan, 'unlocked', { rooms: true })!;
    expect(on.zones.find((z) => z.name === 'Sensor')).toMatchObject({ held: 'room', box: { minX: x0, maxX: x0 + w } });
    // (rooms of an earlier plan are not this plan's zones)
    expect(planOnBoard(doc, plan)!.zones.find((z) => z.name === 'Sensor')!.held).toBe(null);
    const r = await placeByPlan(doc, plan, on, 'unlocked');
    u.transact('Place by the layout plan', (tx) => tx.add(moveComponentsEach(doc, r.moves)));
    const u3 = boxOf(doc, 'U3');
    expect((u3.minX + u3.maxX) / 2).toBeLessThan(f.minX + mm(18));
    expect((u3.minY + u3.maxY) / 2).toBeGreaterThan(f.maxY - mm(10));
  });

  it('a group planned for the bottom side has its parts flipped onto it, under the parts on top if that is where they belong', async () => {
    const doc = board();
    const under = { ...ANSWER, groups: ANSWER.groups.map((g) => (g.name === 'Sensor' ? { ...g, side: 'bottom', x: 0.5, y: 0.5 } : g)), apart: [] };
    const plan = planFor(doc, under);
    const { r } = await placed(doc, plan);
    expect(r.left).toEqual([]);
    for (const d of ['U3', 'C9', 'R2', 'R3']) expect([d, doc.components[comp(doc, d)]!.layer]).toEqual([d, L.BOTTOM]);
    expect(doc.components[comp(doc, 'U2')]!.layer).toBe(L.TOP);
    expect(padsOf(doc, 'U3').every((p) => p.layer === L.BOTTOM)).toBe(true);
    // The sensor is under the microcontroller's zone: the two sides do not get in each other's way
    const u2 = boxOf(doc, 'U2'), u3 = boxOf(doc, 'U3');
    expect(boxGap(u2, u3)).toBeLessThan(mm(3));
    // …but nothing on the bottom overlaps a part with holes, which takes room on both sides
    for (const t of ['J2', 'J3']) for (const d of ['U3', 'C9', 'R2', 'R3']) expect(boxGap(boxOf(doc, t), boxOf(doc, d))).toBeGreaterThanOrEqual(mm(0.5) - 2);
  });

  it('a board with no room for all: what fits is placed properly, the rest is left and named', async () => {
    const doc = board();
    const o = doc.board.outline, x0 = Math.min(...o.map((p) => p.x)), y0 = Math.min(...o.map((p) => p.y));
    doc.board.outline = [{ x: x0, y: y0 }, { x: x0 + mm(16), y: y0 }, { x: x0 + mm(16), y: y0 + mm(14) }, { x: x0, y: y0 + mm(14) }];
    const plan = planFor(doc);
    const { r } = await placed(doc, plan);
    expect(r.left.length).toBeGreaterThan(2);
    expect(r.moves.length).toBeGreaterThan(3);
    const facts = partFacts(doc).filter((f) => f.onBoard);
    for (const [i, a] of facts.entries()) for (const b of facts.slice(i + 1)) expect(boxGap(a.box!, b.box!)).toBeGreaterThanOrEqual(mm(0.5) - 2);
    const on = planOnBoard(doc, plan)!;
    expect(on.waiting.sort()).toEqual([...r.left].sort());
    expect(resultText(on)).toMatch(/^Not placed, for want of room: /);
  });

  it('a second round tells the model what the placer made of the plan', () => {
    const m = LAYOUT.messages({ board: 'Board', brief: '', parts: [], previous: '{"groups":[]}', result: 'Every part is placed.\nNot met:\n- C4 is 3.1 mm from U2-17 (2 mm asked)', remarks: '' });
    expect(m[1]!.content).toMatch(/The plan made before:\n\{"groups":\[\]\}\n\nWhat the placer made of that plan:\nEvery part is placed\.\nNot met:\n- C4 is 3\.1 mm from U2-17 \(2 mm asked\)\n\nGive the whole plan again, changed so that what was not met can be/);
    const both = LAYOUT.messages({ board: 'Board', brief: '', parts: [], previous: '{}', result: 'Every part is placed.', remarks: 'the LED at the top' });
    expect(both[1]!.content).toMatch(/What the designer wants changed in it:\nthe LED at the top\n\nGive the whole plan again with that changed, and changed so that what was not met can be/);
    expect(LAYOUT.version).toBe(2);
    expect(toUnits(1)).toBeCloseTo(393700.787, 2);
  });
});
