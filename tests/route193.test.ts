/**
 * The Smart Router (26.193): a routing plan as a model writes one, checked, put on the board as
 * its own classes, rules, pairs and pours, and carried out by the autorouter, on Konium's own
 * example board with its parts placed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUTING, type RoutingPlan } from '../src/ai/jobs';
import { routeBrief } from '../src/ai/routeBrief';
import { LAYOUT_SAMPLE, layoutSampleBytes } from '../src/formats/synthetic/layoutSample';
import { ROUTING_SAMPLE, routingSampleBytes } from '../src/formats/synthetic/routingSample';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { ruleKind, ruleName, rulePriority, ruleScope1 } from '../src/formats/altium/rules';
import { PLAN_COMMENT, applyRoutingPlan, baseRules, copperViolations, routeByPlan, routeOutcome, routeResultText, routingOnBoard, routingText, type Commit } from '../src/model/planRoute';
import { netRouting, probeTrack } from '../src/model/autoroute';
import { clearanceGap, connections, runDrc } from '../src/model/drc';
import { diffPairsOf, pairRule } from '../src/model/diffPairs';
import { toUnits } from '../src/model/layoutPlan';
import { UndoStack } from '../src/core/undo';
import { L } from '../src/model/layers';
import type { PcbDocument, PcbPad, PcbTrack, PcbVia } from '../src/model/pcb';

let placed: Uint8Array;
beforeAll(async () => { placed = await routingSampleBytes(); });
const board = () => readPcbDoc(placed, ROUTING_SAMPLE.name);
const MM = toUnits(1);

const ANSWER = {
  summary: 'A two-layer USB sensor node: signals on the top, ground poured over the bottom.',
  classes: [
    { name: 'Crystal', why: 'Short and on one layer.', nets: ['XTAL1', 'XTAL2'], width: 0.25, clearance: 0, layers: ['Top Layer'], vias: 'none', order: 1 },
    { name: 'USB', why: 'Full speed data.', nets: ['USB_DP', 'USB_DM'], width: 0.25, clearance: 0, layers: ['top'], vias: 'few', order: 2 },
    { name: 'Power', why: '5 V in and the 3.3 V rail.', nets: ['VBUS', '+3V3'], width: '0.5 mm', clearance: 0, layers: [], vias: 'free', order: 3 },
    { name: 'Ground', why: 'To the pour.', nets: ['GND'], width: 0.4, order: 4 },
    { name: 'Signals', why: 'The rest.', nets: ['NRST', 'TX', 'RX', 'LED', 'LED_A', 'SWDIO', 'SWCLK', 'SCL', 'SDA'], width: 0, vias: 'free', order: 5 },
  ],
  via: { diameter: 0.6, hole: 0.3, why: 'The board\'s via is too large beside 0402 parts.' },
  pours: [{ net: 'GND', layer: 'Bottom Layer', why: 'One return path under everything.' }],
  pairs: [{ name: 'USB', p: 'USB_DP', n: 'USB_DM', gap: 0.2, why: 'USB data.' }],
  notes: ['The 3.3 V rail was taken as 0.3 A.'],
};
const planFor = (doc: PcbDocument, answer: unknown = ANSWER): RoutingPlan => {
  const b = routeBrief(doc)!;
  return ROUTING.check(answer, { board: '', brief: '', nets: b.nets, layers: b.layers, previous: '', result: '', remarks: '' });
};
/** A run as the panel makes it: each change a step of one undo stack, the steps made one at the end. */
async function routed(doc: PcbDocument, plan: RoutingPlan) {
  const u = new UndoStack(), at = u.checkpoint();
  const commit: Commit = (fn) => { u.transact('Route by the routing plan', (tx) => fn((c) => tx.add(c))); return true; };
  const run = await routeByPlan(doc, plan, { commit });
  u.mergeSince(at, 'Route by the routing plan');
  return { run: run!, u };
}
const tracksOf = (doc: PcbDocument, net: string) => doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.polygon === 0xffff && p.net === doc.nets.findIndex((n) => n.name === net));

describe('Smart Router: the plan (26.193)', () => {
  it('the job: high effort, text only, and what it is asked', () => {
    expect(ROUTING).toMatchObject({ kind: 'routing', role: 'text', effort: 'high' });
    const m = ROUTING.messages({ board: 'BOARD', brief: 'The 5 V rail carries 2 A.', nets: [], layers: [], previous: '', result: '', remarks: '' });
    expect(m[0]!.content).toContain('you give no coordinates');
    expect(m[1]!.content).toContain('What the designer says the routing must do:\nThe 5 V rail carries 2 A.');
    expect(m[1]!.content).toContain('BOARD');
    const again = ROUTING.messages({ board: 'BOARD', brief: '', nets: [], layers: [], previous: 'PLAN', result: '2 left.', remarks: 'Wider.' });
    expect(again[1]!.content).toContain('The plan made before:\nPLAN');
    expect(again[1]!.content).toContain('What the router made of that plan:\n2 left.');
    expect(again[1]!.content).toContain('What the designer wants changed in it:\nWider.');
  });

  it('the board as it is sent: its size, layers, rules, parts where they are and nets with what is left to route', () => {
    const doc = board(), b = routeBrief(doc)!;
    expect(b.text).toContain('50 × 30 mm');
    expect(b.text).toContain('Top Layer (signal), Bottom Layer (signal)');
    expect(b.text).toContain('tracks 0.254 mm wide');
    expect(b.text).toContain('0.254 mm between different nets');
    expect(b.text).toMatch(/U2: MCU 32-pin; TQFP-32; 32 pads; top; \(\d+(\.\d)?, \d+(\.\d)?\)/);
    expect(b.text).toMatch(/XTAL1 \(3 pins; 2 to route, \d+(\.\d)? mm\): C7-1, U2-2, Y1-1/);
    expect(b.text).toContain('Nothing is routed yet.');
    expect(b).toMatchObject({ layers: ['Top Layer', 'Bottom Layer'], unplaced: 0 });
    expect(b.nets).toHaveLength(16);
    expect(b.toRoute).toBe(connections(doc).length);
    // The planner's example, its parts still beside the outline: said, so that it is placed first
    const raw = routeBrief(readPcbDoc(layoutSampleBytes(), LAYOUT_SAMPLE.name))!;
    expect(raw.unplaced).toBe(20);
    expect(raw.text).toContain('20 parts are not on the board yet');
  });

  it('the answer checked: the board\'s nets and layers only, each net in one class, the order as 1, 2, 3', () => {
    const doc = board();
    const plan = planFor(doc, {
      ...ANSWER,
      classes: [
        { name: 'Fast', nets: ['usb_dp', 'USB_DM', 'NOPE'], width: 0.2, layers: ['Top', 'Mid 7'], vias: 'sometimes', order: 20 },
        { name: 'Fast', nets: ['USB_DP', 'SCL'], width: 99, clearance: '0.3mm', layers: ['bottom'], order: 3 },
        { name: 'Empty', nets: ['GHOST'] },
        { name: "It's \"odd\"", nets: ['SDA'] },
      ],
      via: { diameter: 0.6, hole: 0.6 },
      pours: [{ net: 'GND', layer: 'Bottom Layer' }, { net: '+3V3', layer: 'bottom' }, { net: 'GND', layer: 'Inner 1' }],
      pairs: [{ p: 'USB_DP', n: 'USB_DM' }, { name: 'Again', p: 'USB_DM', n: 'SCL' }, { p: 'SDA', n: 'SDA' }],
    });
    expect(plan.classes.map((c) => [c.name, c.nets, c.order])).toEqual([['Fast', ['USB_DP', 'USB_DM'], 2], ['Fast 2', ['SCL'], 1], ['It s odd', ['SDA'], 3]]);
    expect(plan.classes[0]).toMatchObject({ width: 0.2, clearance: 0, layers: ['Top Layer'], vias: 'free' });
    expect(plan.classes[1]).toMatchObject({ width: 10, clearance: 0.3, layers: ['Bottom Layer'] });
    expect(plan.via).toBeNull();
    expect(plan.pours).toEqual([{ net: 'GND', layer: 'Bottom Layer', why: '' }]);
    expect(plan.pairs).toEqual([{ name: 'Pair 1', p: 'USB_DP', n: 'USB_DM', gap: 0, why: '' }]);
    expect(plan.unknown).toEqual(expect.arrayContaining(['NOPE', 'Mid 7', 'GHOST', 'Inner 1']));
    expect(plan.unclassed).toHaveLength(12);
    expect(() => planFor(doc, { classes: [{ name: 'X', nets: ['NOPE'] }] })).toThrow('No plan came back');
    // As text, for the clipboard and the second round
    const text = routingText(planFor(doc));
    expect(text).toContain('1. Crystal (0.25 mm wide; on Top Layer; vias: none): XTAL1, XTAL2. Short and on one layer.');
    expect(text).toContain('Via: 0.6 mm across with a 0.3 mm hole');
    expect(text).toContain('- GND over Bottom Layer');
    expect(text).toContain('- USB: USB_DP and USB_DM, 0.2 mm apart. USB data.');
  });
});

describe('Smart Router: the plan on the board (26.193)', () => {
  it('becomes net classes, rules above the board\'s own, a via rule, a pair and a pour, in one undo step', () => {
    const doc = board(), plan = planFor(doc), u = new UndoStack();
    const before = { rules: doc.rules.length, classes: doc.classes.length, polygons: doc.polygons.length, prims: doc.prims.length };
    const base = baseRules(doc);
    expect(base).toMatchObject({ width: 100_000, gap: 100_000, via: { diameter: 500_000, hole: 280_000 } });
    let made = { classes: 0, rules: 0, pairs: 0, pours: 0, changed: false, skipped: [] as string[] };
    u.transact('Rules from the routing plan', (tx) => { made = applyRoutingPlan(doc, plan, (c) => tx.add(c)); });
    expect(made).toMatchObject({ classes: 5, rules: 7, pairs: 1, pours: 1, changed: true, skipped: [] });
    // Classes
    const power = doc.classes.find((c) => c.kind === 0 && c.name === 'Power')!;
    expect(power.members).toEqual(['VBUS', '+3V3']);
    // Rules: the plan's first, the board's own after them and as they were
    const widths = doc.rules.filter((r) => ruleKind(r) === 'Width').sort((a, b) => rulePriority(a) - rulePriority(b));
    expect(widths.map((r) => [ruleName(r), rulePriority(r), ruleScope1(r)])).toEqual([
      ['Width_Crystal', 1, "InNetClass('Crystal')"], ['Width_USB', 2, "InNetClass('USB')"], ['Width_Power', 3, "InNetClass('Power')"], ['Width_Ground', 4, "InNetClass('Ground')"], ['Width', 5, 'All']]);
    expect(widths.slice(0, 4).every((r) => r.bag.get('COMMENT') === PLAN_COMMENT)).toBe(true);
    const net = (n: string) => doc.nets.findIndex((x) => x.name === n);
    expect(netRouting(doc, net('+3V3')).width).toBe(Math.round(0.5 * MM));
    expect(netRouting(doc, net('XTAL1')).width).toBe(Math.round(0.25 * MM));
    expect(netRouting(doc, net('SCL'))).toMatchObject({ width: 100_000, via: { diameter: Math.round(0.6 * MM), hole: Math.round(0.3 * MM) } });
    expect(baseRules(doc)).toEqual(base);
    // The pair, with its rule: the class's width and the gap asked for
    expect(diffPairsOf(doc).map((p) => [p.name, p.pos, p.neg])).toEqual([['USB', 'USB_DP', 'USB_DM']]);
    const dp = doc.rules.find((r) => ruleName(r) === 'DiffPairsRouting_USB')!;
    expect([ruleKind(dp), ruleScope1(dp), dp.bag.get('COMMENT')]).toEqual(['DiffPairsRouting', "InDifferentialPair('USB')", PLAN_COMMENT]);
    expect(pairRule(doc, L.TOP, diffPairsOf(doc)[0])).toMatchObject({ width: Math.round(0.25 * MM), gap: Math.round(0.2 * MM), minGap: Math.round(0.2 * MM), maxGap: Math.round(0.2 * MM) });
    // The gap is under the board's 0.254 mm clearance: the pair's own two nets may come within 0.19 mm of each other, nothing else may
    const within = doc.rules.find((r) => ruleName(r) === 'ClearanceInPair_USB')!;
    expect([ruleKind(within), ruleScope1(within), within.bag.get('SCOPE2EXPRESSION'), rulePriority(within)]).toEqual(['Clearance', "InDifferentialPair('USB')", "InDifferentialPair('USB')", 1]);
    expect(clearanceGap(doc, probeTrack(net('USB_DP')), probeTrack(net('USB_DM')))).toBe(Math.round(0.2 * MM) - Math.round(0.01 * MM));
    expect(clearanceGap(doc, probeTrack(net('USB_DP')), probeTrack(net('SCL')))).toBe(100_000);
    expect(doc.polygons).toHaveLength(before.polygons + 1);
    const pour = doc.polygons.at(-1)!;
    expect(pour).toMatchObject({ layer: L.BOTTOM, net: net('GND') });
    expect(doc.prims.some((p) => p.kind === 'region' && p.polygon === pour.index && p.layer === L.BOTTOM)).toBe(true);
    // 0.3 mm inside the 50 × 30 mm outline
    const xs = pour.outline.map((p) => p.x), ys = pour.outline.map((p) => p.y);
    expect((Math.max(...xs) - Math.min(...xs)) / MM).toBeCloseTo(49.4, 1);
    expect((Math.max(...ys) - Math.min(...ys)) / MM).toBeCloseTo(29.4, 1);
    // The through-hole ground pads are joined by the pour: fewer connections left
    const on = routingOnBoard(doc, plan);
    expect(on.applied).toBe(true);
    expect(on.pours[0]!.index).toBe(pour.index);
    expect(on.pairs[0]!.there).toBe(true);
    expect(on.classes.find((c) => c.cls.name === 'Signals')).toMatchObject({ width: 0, narrow: false, tight: false });
    // Applied again: nothing to do
    let again = made;
    u.transact('Rules from the routing plan', (tx) => { again = applyRoutingPlan(doc, plan, (c) => tx.add(c)); });
    expect(again.changed).toBe(false);
    // It saves and reads back with its rules and classes
    const back = readPcbDoc(writePcbDoc(doc), ROUTING_SAMPLE.name);
    expect(back.rules.filter((r) => r.bag.get('COMMENT') === PLAN_COMMENT)).toHaveLength(7);
    expect(back.classes.filter((c) => c.kind === 0 && !c.superClass).map((c) => c.name)).toEqual(expect.arrayContaining(['Crystal', 'USB', 'Power', 'Ground', 'Signals']));
    // One undo: the board as it was
    expect(u.undo()).toBe('Rules from the routing plan');
    expect({ rules: doc.rules.length, classes: doc.classes.length, polygons: doc.polygons.length, prims: doc.prims.length }).toEqual(before);
    expect(diffPairsOf(doc)).toHaveLength(0);
  });

  it('a plan that follows another: its rules brought up to date, those it has no use for gone with their classes', () => {
    const doc = board(), first = planFor(doc);
    applyRoutingPlan(doc, first, (c) => c.apply());
    const second = planFor(doc, {
      ...ANSWER,
      classes: [
        { name: 'Power', nets: ['VBUS', '+3V3', 'GND'], width: 0.6, clearance: 0.3, order: 1 },
        { name: 'Everything else', nets: ['XTAL1', 'XTAL2', 'USB_DP', 'USB_DM', 'NRST', 'TX', 'RX', 'LED', 'LED_A', 'SWDIO', 'SWCLK', 'SCL', 'SDA'], width: 0.15, order: 2 },
      ],
      via: null, pours: [], pairs: [],
    });
    const on = routingOnBoard(doc, second);
    expect(on.applied).toBe(false);
    expect(on.classes[1]).toMatchObject({ narrow: true });
    applyRoutingPlan(doc, second, (c) => c.apply());
    const mine = doc.rules.filter((r) => r.bag.get('COMMENT') === PLAN_COMMENT).map((r) => ruleName(r)).sort();
    expect(mine).toEqual(['Clearance_Power', 'Width_Everything_else', 'Width_Power']);
    const names = doc.classes.filter((c) => c.kind === 0 && !c.superClass).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Power', 'Everything else']));
    for (const gone of ['Crystal', 'USB', 'Ground']) expect(names).not.toContain(gone);
    expect(doc.classes.find((c) => c.kind === 0 && c.name === 'Power')!.members).toEqual(['VBUS', '+3V3', 'GND']);
    const net = (n: string) => doc.nets.findIndex((x) => x.name === n);
    expect(netRouting(doc, net('GND')).width).toBe(Math.round(0.6 * MM));
    // The via rule of the first plan went; the board's own is back in force
    expect(netRouting(doc, net('SCL')).via.diameter).toBe(500_000);
    // The pour and the pair of the first plan stay: copper and pairs are the designer's to remove
    expect(doc.polygons).toHaveLength(1);
    expect(routingOnBoard(doc, second).applied).toBe(true);
  });
});

describe('Smart Router: routing by the plan (26.193)', () => {
  it('routes the example board: every connection, each class at its width, no rule broken, one undo step', async () => {
    const doc = board(), plan = planFor(doc);
    const before = { conns: connections(doc).length, prims: doc.prims.length, rules: doc.rules.length };
    const { run, u } = await routed(doc, plan);
    expect(run.before).toBe(before.conns);
    expect(run.stopped).toBe(false);
    expect(run.left).toBe(connections(doc).length);
    expect(run.left).toBe(0);
    expect(run.fanned).toBeGreaterThanOrEqual(8);
    // The example board breaks none of its copper, hole and pair rules before the run, and none after it
    expect(run.drcBefore).toEqual({});
    const out = routeOutcome(doc, plan, run.drcBefore);
    expect(out).toMatchObject({ drc: [], violations: 0, standing: 0, left: [] });
    expect(copperViolations(doc)).toEqual({});
    // The USB pair is laid as one: its two tracks side by side, 0.2 mm between them, on the top layer, with no via
    expect(run).toMatchObject({ pairs: 1, coupled: 1 });
    const dp = tracksOf(doc, 'USB_DP'), dm = tracksOf(doc, 'USB_DM');
    expect(dp.every((t) => t.layer === L.TOP) && dm.every((t) => t.layer === L.TOP)).toBe(true);
    const long = (ts: PcbTrack[]) => [...ts].sort((a, b) => Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y) - Math.hypot(a.a.x - a.b.x, a.a.y - a.b.y))[0]!;
    const lp = long(dp), ln = long(dm);
    expect(Math.hypot(lp.a.x - lp.b.x, lp.a.y - lp.b.y) / MM).toBeGreaterThan(10);
    // The longest stretch of each: parallel, their centre lines a width and a gap apart
    const ux = (lp.b.x - lp.a.x) / Math.hypot(lp.b.x - lp.a.x, lp.b.y - lp.a.y), uy = (lp.b.y - lp.a.y) / Math.hypot(lp.b.x - lp.a.x, lp.b.y - lp.a.y);
    expect(Math.abs((ln.a.x - lp.a.x) * -uy + (ln.a.y - lp.a.y) * ux) / MM).toBeCloseTo(0.45, 2);
    expect(Math.abs((ln.b.x - lp.a.x) * -uy + (ln.b.y - lp.a.y) * ux) / MM).toBeCloseTo(0.45, 2);
    expect(runDrc(doc, new Set(['DiffPairsRouting', 'Clearance'])).violations).toEqual([]);
    // Widths by class; the via of the plan
    const w = (n: string) => [...new Set(tracksOf(doc, n).map((t) => Math.round((t.width / MM) * 1000) / 1000))];
    expect(w('XTAL1')).toEqual([0.25]);
    expect(w('SCL')).toEqual([0.254]);
    expect(w('+3V3')).toEqual([0.5]);
    // The 5 V track is wider than the USB socket's 0.38 mm pad: necked down there, so that it keeps clear of the pad beside it
    expect(run.necked).toBeGreaterThanOrEqual(1);
    expect(w('VBUS').sort()).toEqual([0.38, 0.5]);
    const j1 = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.name === '1' && doc.components[p.component]?.designator === 'J1')!;
    const neck = tracksOf(doc, 'VBUS').filter((t) => Math.round((t.width / MM) * 1000) === 380);
    expect(neck.some((t) => Math.hypot(t.a.x - j1.at.x, t.a.y - j1.at.y) < 2 || Math.hypot(t.b.x - j1.at.x, t.b.y - j1.at.y) < 2)).toBe(true);
    expect(run.narrowed).toEqual([]);
    const vias = doc.prims.filter((p): p is PcbVia => p.kind === 'via');
    expect(vias.length).toBeGreaterThanOrEqual(run.fanned);
    expect(vias.every((v) => Math.abs(v.diameter - 0.6 * MM) < 2 && Math.abs(v.hole - 0.3 * MM) < 2)).toBe(true);
    // The crystal stays on the top layer, as its class says: no vias on it
    const x1 = doc.nets.findIndex((n) => n.name === 'XTAL1'), x2 = doc.nets.findIndex((n) => n.name === 'XTAL2');
    expect(tracksOf(doc, 'XTAL1').every((t) => t.layer === L.TOP) && tracksOf(doc, 'XTAL2').every((t) => t.layer === L.TOP)).toBe(true);
    expect(vias.some((v) => v.net === x1 || v.net === x2)).toBe(false);
    // What came of it, in words
    const text = routeResultText(doc, plan, run, out);
    expect(text).toContain(`${before.conns} connections to make before the run; none left.`);
    expect(text).toMatch(/Pads given a via into their pour or plane: \d+\./);
    expect(text).toContain('Differential pairs laid side by side at their gap: 1 of 1.');
    expect(text).toContain('The design rule check finds no violation of the copper, hole and pair rules that was not there before the run.');
    // One step takes it all back
    expect(u.undo()).toBe('Route by the routing plan');
    expect(u.canUndo).toBe(false);
    expect({ conns: connections(doc).length, prims: doc.prims.length, rules: doc.rules.length }).toEqual(before);
  }, 120_000);

  it('a class too wide for its pads: tried again at the narrowest its rule allows, and said', async () => {
    const doc = board();
    const plan = planFor(doc, { ...ANSWER, classes: ANSWER.classes.map((c) => (c.name === 'Power' ? { ...c, width: 1.5 } : c)) });
    const { run } = await routed(doc, plan);
    const out = routeOutcome(doc, plan, run.drcBefore);
    // 1.5 mm cannot reach a 0.8 mm pitch pin: those connections are routed at the board's 0.254 mm instead, or left
    expect(run.narrowed.length + run.left).toBeGreaterThan(0);
    const text = routeResultText(doc, plan, run, out);
    if (run.narrowed.length) expect(text).toContain(`Routed narrower than their class's width, at the narrowest their rule allows, where the planned width could not get through: ${run.narrowed.join(', ')}.`);
    if (run.left) expect(text).toContain('Left unrouted:');
    expect(out.drc.filter((d) => d.kind === 'Width')).toEqual([]);
  }, 120_000);
});

describe('Undo: steps made one (26.193)', () => {
  it('mergeSince joins what was done since a checkpoint; undo and redo take it as one', () => {
    const u = new UndoStack(), log: string[] = [];
    const step = (s: string) => ({ apply: () => { log.push(s); }, revert: () => { log.push(`-${s}`); } });
    u.transact('Before', (tx) => tx.add(step('a')));
    const at = u.checkpoint();
    u.transact('One', (tx) => tx.add(step('b')));
    u.transact('Two', (tx) => { tx.add(step('c')); tx.add(step('d')); });
    u.mergeSince(at, 'Both');
    expect(u.undoLabel).toBe('Both');
    expect(u.undo()).toBe('Both');
    expect(log).toEqual(['a', 'b', 'c', 'd', '-d', '-c', '-b']);
    expect(u.undoLabel).toBe('Before');
    expect(u.redo()).toBe('Both');
    expect(log.slice(-3)).toEqual(['b', 'c', 'd']);
    // From the start of the stack, and nothing to merge
    const v = new UndoStack(), start = v.checkpoint();
    v.mergeSince(start, 'None');
    expect(v.canUndo).toBe(false);
    v.transact('One', (tx) => tx.add(step('x')));
    v.transact('Two', (tx) => tx.add(step('y')));
    v.mergeSince(start, 'All');
    expect(v.undo()).toBe('All');
    expect(v.canUndo).toBe(false);
  });
});
