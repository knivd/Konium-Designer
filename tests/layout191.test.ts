import { describe, expect, it } from 'vitest';
import { LAYOUT, JOBS, type LayoutPlan } from '../src/ai/jobs';
import { layoutBrief } from '../src/ai/layoutBrief';
import type { DesignDigest } from '../src/ai/advise';
import { LAYOUT_SAMPLE, layoutSampleBytes, layoutSampleDoc } from '../src/formats/synthetic/layoutSample';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { boardFrame, partFacts, planOnBoard, planRooms, planText, roomName, toUnits } from '../src/model/layoutPlan';
import { roomsOf } from '../src/model/rooms';
import { roomMembers } from '../src/model/roomScope';
import { connections } from '../src/model/drc';
import { UndoStack } from '../src/core/undo';
import { FEATURES, FEATURE_COMMANDS, STAGE } from '../src/core/release';
import { mm } from '../src/core/units';
import handler from '../cloudflare/ai/src/handler.ts?raw';

const board = () => readPcbDoc(layoutSampleBytes(), LAYOUT_SAMPLE.name);
const des = (doc: ReturnType<typeof board>, list: number[]) => list.map((i) => doc.components[i]!.designator).sort();

/** A plan as a model writes one for the example board, with what models get wrong: a part the board doesn't have, a part in two groups, a percentage, a capital letter, a pin that isn't there. */
const ANSWER = {
  summary: 'A small USB sensor node: USB comes in at the left with the regulator behind it, the microcontroller in the middle, the sensor top right.',
  groups: [
    { name: 'USB input and regulator', why: 'Power and USB data enter here.', parts: ['J1', 'U1', 'C1', 'C2', 'U9'], main: 'J1', x: 0.12, y: 0.5, side: 'top' },
    { name: 'Microcontroller', why: 'Decoupling at its supply pins, the crystal at pins 2 and 3.', parts: ['U2', 'C3', 'C4', 'C5', 'C6', 'Y1', 'C7', 'C8', 'R1'], main: 'U2', x: '50%', y: 0.45, side: 'top' },
    { name: 'Sensor', why: 'Away from the regulator\'s heat.', parts: ['U3', 'C9', 'R2', 'R3', 'c3'], main: 'U3', x: 0.78, y: 0.82, side: 'Top' },
    { name: 'Debug and indicator', why: 'Reached and seen at the bottom edge.', parts: ['J3', 'D1'], main: 'J3', x: 0.62, y: 0.1 },
    { name: 'UART header', why: 'Fixed at the right edge.', parts: ['J2'], main: 'J2', x: 0.94, y: 0.5, side: 'top' },
  ],
  edges: [{ part: 'J1', edge: 'Left', along: 0.5, why: 'The USB cable plugs in from the left.' }, { part: 'J3', edge: 'bottom', along: 0.6, why: 'The debug probe reaches it.' }, { part: 'D1', edge: 'inside', along: 0.2 }],
  near: [
    { part: 'C1', to: 'U1-3', mm: 3, why: 'Input capacitor.' }, { part: 'C3', to: 'U2 pin 1', mm: '2', why: 'Decouples VDD at pin 1.' }, { part: 'C4', to: 'U2.17', mm: 2, why: '' },
    { part: 'Y1', to: 'U2-2', mm: 5, why: 'The crystal at the oscillator pins.' }, { part: 'C7', to: 'Y1', mm: 3, why: 'Load capacitor.' }, { part: 'C12', to: 'U2-1', mm: 2 },
    { part: 'C5', to: 'U2-40', mm: 2, why: '' }, { part: 'C9', to: 'C9', mm: 2 },
  ],
  apart: [{ a: 'U1', b: 'U3', mm: 15, why: 'Heat away from the sensor.' }, { a: 'U1', b: 'U1', mm: 5 }],
  clear: [{ part: 'J1', mm: 1.5, why: 'Room for the plug.' }],
  notes: ['Pour ground on the bottom layer.', ''],
};

describe('Layout Planner: the plan (26.191)', () => {
  it('writes the board for the planner: outline, holes, each part to place with its size, the fixed part with its place, the nets with their pins', () => {
    const doc = board();
    const b = layoutBrief(doc)!;
    const lines = b.text.split('\n');
    expect(lines[0]).toBe('Board "Layout Example.PcbDoc": 50 × 30 mm, a rectangle. 2 copper layers (Top Layer, Bottom Layer). Positions in mm from the outline\'s lower left corner, x to the right and y up, seen from the top side.');
    expect(lines).toContain('Holes that belong to no part: (3, 3) 2.5 mm; (3, 27) 2.5 mm');
    expect(lines).toContain('Parts to place: 20. Their bodies and pads cover 285 mm² together, 19% of the board\'s 1500 mm².');
    expect(lines).toContain('U2: MCU 32-pin; TQFP-32; 10.3 × 10.3 mm; 32 pads; SMD');
    expect(lines).toContain('J1: USB Micro-B; USB-MICRO-B; 8.8 × 6.2 mm; 7 pads; SMD with through-hole pads');
    expect(lines).toContain('J2: UART; HDR-1x4; 2.7 × 10.3 mm; 4 pads; through-hole; at (47, 15), covering (45.7, 9.8) to (48.3, 20.2), top side, turned 0°');
    expect(lines).toContain('XTAL1: C7-1, U2-2, Y1-1');
    expect(lines.find((l) => l.startsWith('GND'))).toMatch(/^GND \(21 pins\): C1-2, .*U3-6$/);
    expect(b).toMatchObject({ placing: 20, fixed: 1, nets: 16 });
    expect(b.parts).toHaveLength(21);
    // No part's place off the board is said: the plan starts from nothing but what is fixed
    expect(b.text).not.toMatch(/\((5[6-9]|[6-9]\d)(\.\d)?, /);
    // Only the parts not yet on the board: the same here, as the one on it is locked; with it unlocked it is planned or kept by the scope
    const loose = board();
    loose.components.find((c) => c.designator === 'J2')!.bag.set('LOCKED', 'FALSE');
    expect(layoutBrief(loose, { scope: 'unlocked' })).toMatchObject({ placing: 21, fixed: 0 });
    expect(layoutBrief(loose, { scope: 'outside' })).toMatchObject({ placing: 20, fixed: 1 });
  });

  it('with the project\'s schematic each part has its description and sheet, and each pin its name', () => {
    const design = {
      list: [{ designator: 'U2', value: 'KD32F0', description: 'Microcontroller, 32 pins', pins: [{ number: '1', name: 'VDD', electrical: 7, net: '+3V3' }, { number: '2', name: 'OSC_IN', electrical: 0, net: 'XTAL1' }, { number: '9', name: '9', electrical: 4, net: 'TX' }] },
        { designator: 'Y1', value: '8MHz', description: 'Crystal', pins: [] }],
      partRefs: new Map([['U2', [{ sheet: 'MCU.SchDoc', index: 1 }]], ['Y1', [{ sheet: 'Clock.SchDoc', index: 2 }]]]),
    } as unknown as DesignDigest;
    const lines = layoutBrief(board(), { design })!.text.split('\n');
    expect(lines).toContain('U2: KD32F0; TQFP-32; 10.3 × 10.3 mm; 32 pads; SMD; "Microcontroller, 32 pins"; sheet MCU');
    expect(lines).toContain('Y1: 8MHz; XTAL-3225; 4.1 × 2.6 mm; 2 pads; SMD; "Crystal"; sheet Clock');
    expect(lines).toContain('XTAL1: C7-1, U2-2 OSC_IN, Y1-1');
    expect(lines.find((l) => l.startsWith('TX:'))).toBe('TX: J2-2, U2-9');
    expect(lines.find((l) => l.startsWith('Parts (designator'))).toMatch(/mounting; description; schematic sheet\):$/);
  });

  it('asks for a plan: the board, what the designer says, and for a second round the plan made before with what to change', () => {
    const b = layoutBrief(board())!;
    const first = LAYOUT.messages({ board: b.text, brief: ' USB at the left edge ', parts: b.parts, previous: '', result: '', remarks: 'ignored without a plan' });
    expect(first[0]!.role).toBe('system');
    expect(first[0]!.content).toMatch(/You do not give positions for single parts/);
    expect(first[0]!.content).not.toMatch(/[—–]/);
    expect(first[1]!.content).toMatch(/^What the designer says the layout must do:\nUSB at the left edge\n\nBoard "Layout Example\.PcbDoc"/);
    expect(first[1]!.content).not.toMatch(/The plan made before|ignored without a plan/);
    const second = LAYOUT.messages({ board: b.text, brief: '', parts: b.parts, previous: '{"groups": []}', result: '', remarks: 'the sensor lower' });
    expect(second[1]!.content).toMatch(/The plan made before:\n\{"groups": \[\]\}\n\nWhat the designer wants changed in it:\nthe sensor lower\n\nGive the whole plan again/);
    expect(LAYOUT).toMatchObject({ kind: 'layout', role: 'text', effort: 'high' });
    expect(JOBS.layout).toBe(LAYOUT);
    // The Konium service counts it as a job of its own kind
    expect(handler).toMatch(/layout: 'jobs'/);
  });

  it('checks a model\'s answer: only the board\'s parts, each in one group, edges and fractions read, what was left out said', () => {
    const b = layoutBrief(board())!;
    const p = LAYOUT.check(ANSWER, { board: b.text, brief: '', parts: b.parts, previous: '', result: '', remarks: '' });
    expect(p.groups.map((g) => [g.name, g.parts.join(' '), g.main, g.side])).toEqual([
      ['USB input and regulator', 'J1 U1 C1 C2', 'J1', 'top'], ['Microcontroller', 'U2 C3 C4 C5 C6 Y1 C7 C8 R1', 'U2', 'top'],
      ['Sensor', 'U3 C9 R2 R3', 'U3', 'top'], ['Debug and indicator', 'J3 D1', 'J3', 'top'], ['UART header', 'J2', 'J2', 'top']]);
    expect(p.groups[1]!.x).toBe(0.5);
    expect(p.edges).toEqual([{ part: 'J1', edge: 'left', along: 0.5, why: 'The USB cable plugs in from the left.' }, { part: 'J3', edge: 'bottom', along: 0.6, why: 'The debug probe reaches it.' }]);
    expect(p.near.map((n) => `${n.part}>${n.to}@${n.mm}`)).toEqual(['C1>U1-3@3', 'C3>U2-1@2', 'C4>U2-17@2', 'Y1>U2-2@5', 'C7>Y1@3', 'C5>U2-40@2']);
    expect(p.apart).toEqual([{ a: 'U1', b: 'U3', mm: 15, why: 'Heat away from the sensor.' }]);
    expect(p.clear).toEqual([{ part: 'J1', mm: 1.5, why: 'Room for the plug.' }]);
    expect(p.notes).toEqual(['Pour ground on the bottom layer.']);
    expect(p.unknown.sort()).toEqual(['C12', 'U9']);
    expect(p.ungrouped).toEqual(['R4']);
    // Nothing usable: said, not passed on
    expect(() => LAYOUT.check({ groups: [{ name: 'x', parts: ['Q77'] }] }, { board: '', brief: '', parts: b.parts, previous: '', result: '', remarks: '' })).toThrow(/No plan came back/);
    expect(() => LAYOUT.check('sorry', { board: '', brief: '', parts: b.parts, previous: '', result: '', remarks: '' })).toThrow(/No plan came back/);
    // Two groups of one name are told apart
    const twins = LAYOUT.check({ groups: [{ name: 'Power', parts: ['U1'] }, { name: 'power', parts: ['C1'] }] }, { board: '', brief: '', parts: b.parts, previous: '', result: '', remarks: '' });
    expect(twins.groups.map((g) => g.name)).toEqual(['Power', 'power 2']);
  });

  const planned = (): LayoutPlan => { const b = layoutBrief(board())!; return LAYOUT.check(ANSWER, { board: b.text, brief: '', parts: b.parts, previous: '', result: '', remarks: '' }); };

  it('puts the plan on the board: a zone for each group, sized to its parts, on the board, clear of each other, at its edge or round its fixed part', () => {
    const doc = board(), f = boardFrame(doc)!;
    const on = planOnBoard(doc, planned())!;
    expect(on.zones.map((z) => [z.name, z.held, z.placing.length])).toEqual([['USB input and regulator', 'edge', 4], ['Microcontroller', null, 9], ['Sensor', null, 4], ['Debug and indicator', 'edge', 2], ['UART header', 'fixed', 0]]);
    for (const z of on.zones) {
      expect(z.box.minX).toBeGreaterThanOrEqual(f.minX - 1); expect(z.box.maxX).toBeLessThanOrEqual(f.maxX + 1);
      expect(z.box.minY).toBeGreaterThanOrEqual(f.minY - 1); expect(z.box.maxY).toBeLessThanOrEqual(f.maxY + 1);
    }
    // Each zone holds about twice its parts' area (with half a millimetre round each)
    const facts = partFacts(doc);
    for (const z of on.zones.filter((x) => x.placing.length)) {
      const need = z.placing.reduce((s, i) => s + (facts[i]!.w + toUnits(0.5)) * (facts[i]!.h + toUnits(0.5)), 0) * 2;
      expect((z.box.maxX - z.box.minX) * (z.box.maxY - z.box.minY) / need).toBeCloseTo(1, 1);
    }
    // No two overlap by more than a tenth of a millimetre
    for (const [i, a] of on.zones.entries()) for (const b of on.zones.slice(i + 1)) {
      const ox = Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX), oy = Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY);
      expect([a.name, b.name, Math.min(ox, oy) < mm(0.1)]).toEqual([a.name, b.name, true]);
    }
    // The USB group against the left edge at its middle, the debug group against the bottom edge, the UART group round J2 where it is
    const usb = on.zones[0]!, dbg = on.zones[3]!, uart = on.zones[4]!;
    expect(Math.abs(usb.box.minX - f.minX)).toBeLessThan(2);
    expect((usb.box.minY + usb.box.maxY) / 2).toBeCloseTo((f.minY + f.maxY) / 2, -4);
    expect(Math.abs(dbg.box.minY - f.minY)).toBeLessThan(2);
    const j2 = doc.components.findIndex((c) => c.designator === 'J2');
    expect(des(doc, uart.parts)).toEqual(['J2']);
    expect((uart.box.minX + uart.box.maxX) / 2).toBeLessThanOrEqual(doc.components[j2]!.at.x + mm(1.5));
    // (nothing of it to place: its zone is what J2 covers, with half a millimetre round it)
    const j2box = partFacts(doc)[j2]!.box!;
    expect([uart.box.minX, uart.box.maxY].map((v) => Math.round(v))).toEqual([Math.round(j2box.minX - toUnits(0.5)), Math.round(j2box.maxY + toUnits(0.5))]);
    expect(on.fill).toBeGreaterThan(0.3); expect(on.fill).toBeLessThan(0.85); expect(on.shrunk).toBe(false);
    // The marks at the edges, and what must be close with its distance as the board stands
    expect(on.edges.map((e) => [e.designator, e.edge, Math.round((e.at.x - f.minX) / mm(1)), Math.round((e.at.y - f.minY) / mm(1))])).toEqual([['J1', 'left', 0, 15], ['J3', 'bottom', 30, 0]]);
    expect(on.near.map((n) => [n.designator, n.to, n.pad, n.placed])).toEqual([['C1', 'U1-3', true, false], ['C3', 'U2-1', true, false], ['C4', 'U2-17', true, false], ['Y1', 'U2-2', true, false], ['C7', 'Y1', false, false]]);
    expect(on.missing).toEqual(['U2-40']);
    const u2 = doc.components.findIndex((c) => c.designator === 'U2');
    const pin1 = doc.prims.find((q) => q.kind === 'pad' && q.component === u2 && q.name === '1')!;
    expect(on.near[1]!.target).toEqual((pin1 as { at: unknown }).at);
  });

  it('a board too small for its parts: the zones made smaller to fit, and said', () => {
    const doc = board();
    const o = doc.board.outline, x0 = Math.min(...o.map((p) => p.x)), y0 = Math.min(...o.map((p) => p.y));
    doc.board.outline = [{ x: x0, y: y0 }, { x: x0 + mm(22), y: y0 }, { x: x0 + mm(22), y: y0 + mm(16) }, { x: x0, y: y0 + mm(16) }];
    const on = planOnBoard(doc, planned())!;
    expect(on.shrunk).toBe(true);
    expect(on.fill).toBeGreaterThan(1);
    const area = on.zones.filter((z) => z.placing.length).reduce((s, z) => s + (z.box.maxX - z.box.minX) * (z.box.maxY - z.box.minY), 0);
    expect(area / (mm(22) * mm(16))).toBeLessThan(0.9);
    for (const z of on.zones) expect(z.box.maxX - z.box.minX).toBeLessThanOrEqual(mm(22) + 1);
  });

  it('Make Rooms: a component class and a room for each group, saved with the board, brought up to date by a second plan, one undo step', () => {
    const doc = board(), plan = planned();
    const classes0 = doc.classes.length, rules0 = doc.rules.length;
    const u = new UndoStack();
    const r = planRooms(doc, planOnBoard(doc, plan)!);
    u.transact('Rooms from the layout plan', (tx) => { for (const c of r.changes) tx.add(c); });
    expect(r).toMatchObject({ rooms: 5, fresh: 5 });
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    const rooms = roomsOf(back);
    expect(rooms.map((x) => [x.name, x.scope])).toEqual(plan.groups.map((g) => [g.name, `InComponentClass('${g.name}')`]));
    for (const [k, room] of rooms.entries()) expect(des(back, roomMembers(back, room))).toEqual([...plan.groups[k]!.parts].sort());
    expect(back.classes.filter((c) => c.kind === 1 && !c.superClass && plan.groups.some((g) => g.name === c.name)).map((c) => c.members.length)).toEqual([4, 9, 4, 2, 1]);
    // A second plan moves a group and takes a part out of it: the same room and class, changed
    const again: LayoutPlan = { ...plan, groups: plan.groups.map((g, k) => (k === 2 ? { ...g, parts: ['U3', 'C9'], x: 0.3, y: 0.85 } : g)) };
    const r2 = planRooms(doc, planOnBoard(doc, again)!);
    u.transact('Rooms from the layout plan', (tx) => { for (const c of r2.changes) tx.add(c); });
    expect(r2).toMatchObject({ rooms: 5, fresh: 0 });
    expect(roomsOf(doc)).toHaveLength(5);
    const sensor = roomsOf(doc).find((x) => x.name === 'Sensor')!;
    expect(des(doc, roomMembers(doc, sensor))).toEqual(['C9', 'U3']);
    expect(Math.min(...sensor.outline.map((p) => p.x))).toBeLessThan(Math.min(...rooms[2]!.outline.map((p) => p.x)));
    u.undo(); u.undo();
    expect([doc.classes.length, doc.rules.length]).toEqual([classes0, rules0]);
    // A name with quotes can't break the scope it is written into
    expect(roomName('The "MCU\'s" group\nand more')).toBe('The MCU s group and more');
  });

  it('the plan as text, for the clipboard', () => {
    const t = planText(planned());
    expect(t).toMatch(/^A small USB sensor node/);
    expect(t).toContain('- Microcontroller (top, middle at 50% across, 45% up; round U2): U2, C3, C4, C5, C6, Y1, C7, C8, R1. Decoupling at its supply pins, the crystal at pins 2 and 3.');
    expect(t).toContain('- J1: left edge, 50% along. The USB cable plugs in from the left.');
    expect(t).toContain('- C3 within 2 mm of U2-1. Decouples VDD at pin 1.');
    expect(t).toContain('- U1 and U3 at least 15 mm. Heat away from the sensor.');
    expect(t).not.toMatch(/[—–]/);
  });

  it('the example board: Konium\'s own, every part to place beside the outline with its nets, one header locked on it', () => {
    const doc = layoutSampleDoc(), f = boardFrame(doc)!;
    expect([doc.components.length, doc.nets.length]).toEqual([21, 16]);
    const facts = partFacts(doc);
    expect(facts.filter((x) => x.onBoard).map((x) => x.designator)).toEqual(['J2']);
    expect(facts.filter((x) => x.locked).map((x) => x.designator)).toEqual(['J2']);
    for (const x of facts.filter((p) => !p.onBoard)) expect(x.box!.minX).toBeGreaterThan(f.maxX);
    // No two of the waiting parts stand on each other
    const out = facts.filter((p) => !p.onBoard);
    for (const [i, a] of out.entries()) for (const b of out.slice(i + 1)) expect(a.box!.minX < b.box!.maxX && a.box!.maxX > b.box!.minX && a.box!.minY < b.box!.maxY && a.box!.maxY > b.box!.minY).toBe(false);
    expect(connections(doc).length).toBeGreaterThan(40);
  });

  it('planned until its release: stage 20, its commands with it', () => {
    expect(FEATURES.aiLayout.stage).toBe(20);
    expect(STAGE).toBeGreaterThanOrEqual(FEATURES.aiLayout.stage);
    expect([FEATURE_COMMANDS['ai.layoutPlanner'], FEATURE_COMMANDS['ai.layoutExample']]).toEqual(['aiLayout', 'aiLayout']);
  });
});
