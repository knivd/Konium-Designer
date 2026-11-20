import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PropertyBag } from '../src/formats/altium/props';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { BusRouteTool } from '../src/editors/pcb/BusRouteTool';
import { LengthTuneTool } from '../src/editors/pcb/LengthTuneTool';
import { UndoStack } from '../src/core/undo';
import { mil, mm } from '../src/core/units';
import { updateSettings } from '../src/core/settings';
import { L } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbTrack } from '../src/model/pcb';
import { addPads, addTracks, replaceRecords, replaceRules } from '../src/model/pcbEdit';
import { diffPairBag, diffPairsOf, pairOfNet, pairRule, pairWizardRules, pairsFromNets, setDiffPairs } from '../src/model/diffPairs';
import { classBag, setClasses } from '../src/model/pcbClasses';
import { runPcbQuery } from '../src/model/pcbQuery';
import { netLength } from '../src/model/lengthTune';
import { cleanNets, gloss, moveTracks, replaceTracks, retrace, strayCopper, chamferedPaths } from '../src/model/trackOps';
import { findTeardrops, planTeardrops } from '../src/model/teardrops';
import { planStitching, stitchGroup } from '../src/model/viaStitch';
import { combinePolygons, slicePolygon } from '../src/model/polygonOps';
import { computePour } from '../src/model/pour';
import { canSwapPins, optimisePins, setPadNets, swapInfo, withSwapInfo } from '../src/model/pinSwap';
import { checkCopper } from '../src/model/drc';
import { ruleKind } from '../src/formats/altium/rules';
import type { ToolPointer } from '../src/core/tools';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const at = (x: number, y: number): ToolPointer => ({ world: P(x, y), raw: P(x, y), button: 0, shift: false, ctrl: false, alt: false });
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const tx = (_doc: PcbDocument, ...cs: Parameters<UndoStack['transact']>[1][]) => { const u = new UndoStack(); for (const f of cs) u.transact('t', f); return u; };

/** The demo board with a pair D_P / D_N: two pads each end, 0.6 mm apart, in clear board above the routes. */
function withPair() {
  const doc = demo();
  for (const n of ['D_P', 'D_N']) doc.nets.push({ index: doc.nets.length, name: n, bag: PropertyBag.from({ NAME: n, VISIBLE: 'TRUE' }) });
  doc.dirty.add('Nets6');
  const dp = doc.nets.length - 2, dn = doc.nets.length - 1;
  const pad = (name: string, x: number, y: number, net: number) => ({ name, layer: L.TOP, at: P(x, y), w: mm(0.3), h: mm(0.3), shape: 'round' as const, net });
  tx(doc, (t) => t.add(addPads(doc, [pad('1', 8, 23, dp), pad('2', 8, 22.4, dn), pad('3', 30, 23, dp), pad('4', 30, 22.4, dn)])));
  tx(doc, (t) => t.add(setDiffPairs(doc, [diffPairBag('D', 'D_P', 'D_N')])));
  return { doc, dp, dn };
}

describe('differential pairs', () => {
  it('pairs are saved in DifferentialPairs6, found from net names, and answer the queries', () => {
    const { doc, dp } = withPair();
    expect(pairsFromNets(doc, '_P', '_N')).toEqual([]);
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(diffPairsOf(back).map((p) => [p.name, p.pos, p.neg])).toEqual([['D', 'D_P', 'D_N']]);
    expect(pairOfNet(back, dp)).toEqual(expect.objectContaining({ positive: true }));
    tx(doc, (t) => t.add(setDiffPairs(doc, [])));
    expect(pairsFromNets(doc, '_P', '_N')).toEqual([{ name: 'D', pos: 'D_P', neg: 'D_N' }]);
    tx(doc, (t) => t.add(setDiffPairs(doc, [diffPairBag('D', 'D_P', 'D_N')])));
    tx(doc, (t) => t.add(setClasses(doc, [...doc.classes.map((c) => c.bag), classBag('Fast', 6, ['D'])])));
    const x = { doc, units: 'mil' as const, origin: doc.board.origin };
    expect(runPcbQuery("InDifferentialPairClass('Fast')", x).length).toBe(4);
    expect(runPcbQuery("InDifferentialPair('D')", x).length).toBe(4);
  });
  it('the Rule Wizard makes the routing and matched lengths rules for the class, first of their kind', () => {
    const { doc } = withPair();
    const { rules, made } = pairWizardRules(doc, { cls: 'Fast', prefix: 'DP', minW: mil(5), prefW: mil(6), maxW: mil(8), minG: mil(5), prefG: mil(7), maxG: mil(10), uncoupled: mil(300), tol: mil(5) });
    tx(doc, (t) => t.add(replaceRules(doc, rules)));
    const dp = doc.rules.find((r) => r.bag.get('NAME') === made[0])!;
    expect(ruleKind(dp)).toBe('DiffPairsRouting');
    expect(dp.bag.get('SCOPE1EXPRESSION')).toBe("InDifferentialPairClass('Fast')");
    expect(dp.bag.get('TOPLAYER_PREFGAP')).toBe('7mil');
    expect(doc.rules.find((r) => r.bag.get('NAME') === made[1])!.bag.get('CHECKNETSINDIFFPAIR')).toBe('TRUE');
    tx(doc, (t) => t.add(setClasses(doc, [...doc.classes.map((c) => c.bag), classBag('Fast', 6, ['D'])])));
    expect(pairRule(doc, L.TOP, diffPairsOf(doc)[0])).toEqual(expect.objectContaining({ width: mil(6), gap: mil(7) }));
  });
  it('Interactive Differential Pair Routing: both nets from their pads to the far pads, side by side at the gap', () => {
    const { doc, dp, dn } = withPair();
    const ed = new PcbEditor(doc);
    ed.scene();
    updateSettings({ pcbRoutingMode: 'walkaround' });
    const tool = new BusRouteTool(ed, 'pair');
    ed.setTool(tool);
    tool.pointerMove(at(8, 23));
    tool.pointerDown(at(8, 23));
    expect(tool.active).toBe(true);
    tool.pointerMove(at(30, 23));
    tool.pointerDown(at(30, 23));
    expect(tool.active).toBe(false);
    const P_ = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === dp), N_ = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === dn);
    expect(P_.length).toBeGreaterThan(0);
    expect(N_.length).toBeGreaterThan(0);
    // Each net joined end to end, pad to pad
    const ends = (ts: PcbTrack[]) => ts.flatMap((t) => [t.a, t.b]);
    expect(ends(P_)).toContainEqual(P(8, 23)); expect(ends(P_)).toContainEqual(P(30, 23));
    expect(ends(N_)).toContainEqual(P(8, 22.4)); expect(ends(N_)).toContainEqual(P(30, 22.4));
    // The long stretches run at the rule's pitch (width + gap, 10 + 10 mil by default)
    const longP = P_.reduce((a, b) => (Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) > Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) ? b : a));
    const longN = N_.reduce((a, b) => (Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) > Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) ? b : a));
    expect(Math.abs(longP.a.y - longN.a.y)).toBe(mil(20));
    expect(checkCopper({ ...doc, prims: doc.prims.filter((p) => p !== longP && p !== longN) }, [longP, longN], { clearanceOnly: true, ignorePours: true })).toEqual([]);
    ed.undo.undo();
    expect(doc.prims.some((p) => p.kind === 'track' && (p.net === dp || p.net === dn))).toBe(false);
  });
  it('Multi-Routing takes the selected pads and routes them as a bus', () => {
    const { doc, dp, dn } = withPair();
    const ed = new PcbEditor(doc);
    ed.scene();
    updateSettings({ pcbRoutingMode: 'ignore' });
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && (p.net === dp || p.net === dn) && p.at.x === P(8, 0).x);
    ed.select(pads.map((p) => `${p.src.storage}:${p.src.index}`));
    const tool = new BusRouteTool(ed, 'multi');
    ed.setTool(tool);
    tool.pointerDown(at(8, 23));
    expect(tool.active).toBe(true);
    tool.pointerMove(at(20, 23));
    tool.pointerDown(at(20, 23));
    tool.cancel();
    expect(doc.prims.filter((p) => p.kind === 'track' && (p.net === dp || p.net === dn)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('length tuning', () => {
  it('accordions on the clicked track bring the net to the typed target, one undo step', () => {
    const doc = demo();
    const ed = new PcbEditor(doc);
    ed.scene();
    const VIN = 1;
    const before = netLength(doc, VIN);
    updateSettings({ pcbTuneTarget: 'manual', pcbTuneManual: (before + mm(1.5)) / 10_000, pcbTuneStyle: 'mitered', pcbTuneAmplitude: 40, pcbTuneSpace: 20, pcbTuneMiter: 50 });
    const tool = new LengthTuneTool(ed, false);
    ed.setTool(tool);
    tool.pointerMove(at(15, 7.2));
    tool.pointerDown(at(15, 7.2));
    tool.pointerMove(at(25, 6.5));
    tool.pointerDown(at(25, 6.5));
    expect(Math.abs(netLength(doc, VIN) - (before + mm(1.5)))).toBeLessThan(mil(1));
    // Still joined: the tuned track's old ends are there
    const ends = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === VIN).flatMap((t) => [t.a, t.b]);
    expect(ends).toContainEqual(P(13.05, 7.2)); expect(ends).toContainEqual(P(26.3, 7.2));
    ed.undo.undo();
    expect(netLength(doc, VIN)).toBeCloseTo(before, 0);
  });
});

describe('track edits', () => {
  it('Gloss pulls a detour tight; Retrace takes the rule width; Clean Nets frees stray copper', () => {
    const doc = demo();
    const GND = 0;
    // A detour on the bottom layer from the GND via at (16.6, 15) out and back to (16.6, 9)
    tx(doc, (t) => t.add(addTracks(doc, [
      { layer: L.BOTTOM, a: P(16.6, 9), b: P(19, 9), width: mm(0.3), net: GND }, { layer: L.BOTTOM, a: P(19, 9), b: P(19, 6), width: mm(0.3), net: GND },
      { layer: L.BOTTOM, a: P(19, 6), b: P(16.6, 6), width: mm(0.3), net: GND }])));
    const run = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.width === mm(0.3));
    const g = gloss(doc, run);
    expect(g.changed).toBe(1);
    const len = (ts: { a: { x: number; y: number }; b: { x: number; y: number } }[]) => ts.reduce((s, t) => s + Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y), 0);
    expect(len(g.add)).toBeLessThan(len(run));
    tx(doc, (t) => replaceTracks(doc, g.remove, g.add, [], (c) => t.add(c)));
    expect(doc.prims.filter((p) => p.kind === 'track' && p.width === mm(0.3)).length).toBe(g.add.length);
    const r = retrace(doc, doc.prims.filter((p) => p.kind === 'track' && p.width === mm(0.3)));
    expect(r.edits.length).toBeGreaterThan(0);
    // A stray track of GND nowhere near its pads loses its net
    tx(doc, (t) => t.add(addTracks(doc, [{ layer: L.TOP, a: P(36, 20), b: P(38, 20), width: mm(0.3), net: GND }])));
    expect(strayCopper(doc).filter((p) => p.kind === 'track').map((p) => (p as PcbTrack).a)).toEqual([P(36, 20)]);
    tx(doc, (t) => t.add(replaceRecords(doc, cleanNets(doc))));
    expect(doc.prims.find((p) => p.kind === 'track' && p.a.x === P(36, 0).x)!).toEqual(expect.objectContaining({ net: NO_NET }));
  });
  it('Move / Resize Tracks: the neighbours keep their directions; Chamfered Path makes a region', () => {
    const doc = demo();
    const mid = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.a.y === P(0, 7.2).y && p.b.y === P(0, 7.2).y)!;
    const r = moveTracks(doc, [mid], { x: 0, y: mm(1) });
    tx(doc, (t) => t.add(replaceRecords(doc, r.edits)));
    const ys = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === 1).flatMap((t) => [t.a, t.b]).filter((q) => q.x === P(13.05, 0).x || q.x === P(26.3, 0).x).map((q) => q.y);
    expect(ys.some((y) => Math.abs(y - P(0, 8.2).y) <= 1)).toBe(true);
    expect(ys.filter((y) => Math.abs(y - P(0, 7.2).y) <= 1)).toEqual([]);
    const vin = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === 1);
    const c = chamferedPaths(doc, vin, 0.5);
    expect(c.regions.length).toBeGreaterThan(0);
    expect(c.remove.length).toBe(vin.length);
  });
});

describe('teardrops, stitching, pours', () => {
  it('teardrops go on where tracks meet pads and vias, are found again, and come off', () => {
    const doc = demo();
    const plan = planTeardrops(doc, { pads: true, vias: true, selectedOnly: false, force: true, style: 'arc' });
    expect(plan.joints).toBeGreaterThan(3);
    expect(plan.arcs.length).toBe(plan.joints * 2);
    const n0 = doc.prims.length;
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(back.prims.length).toBe(n0);
    const t2 = planTeardrops(doc, { pads: true, vias: true, selectedOnly: false, force: true, style: 'track' });
    tx(doc, (t) => t.add(addTracks(doc, t2.tracks.map((x) => ({ ...x })))));
    expect(findTeardrops(doc).length).toBe(t2.tracks.length);
    // A second pass finds nothing new to add on joints that have them
    expect(planTeardrops(doc, { pads: true, vias: true, selectedOnly: false, force: true, style: 'track' }).joints).toBe(0);
  });
  it('stitching vias land in the net\'s pour, clear of the rest; a group is found from one', () => {
    const doc = demo();
    const vias = planStitching(doc, { net: 0, grid: mm(2), diameter: mm(0.6), hole: mm(0.3) });
    expect(vias.length).toBeGreaterThan(5);
    const probe = vias.map((v) => ({ kind: 'via' as const, src: { storage: 'Vias6', index: -1 }, at: v.at, diameter: v.diameter, hole: v.hole, layerStart: L.TOP, layerEnd: L.BOTTOM, net: 0, locked: false }));
    expect(checkCopper(doc, probe, { ignorePours: true, clearanceOnly: true })).toEqual([]);
    expect(stitchGroup({ ...doc, prims: [...doc.prims, ...probe] }, probe[0]!).length).toBeGreaterThan(1);
  });
  it('a pour sliced in two, combined again; necks narrower than the threshold are removed', () => {
    const doc = demo();
    const poly = doc.polygons[0]!;
    const xs = poly.outline.map((p) => p.x), ys = poly.outline.map((p) => p.y);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const pieces = slicePolygon(poly, { x: mx, y: Math.min(...ys) - mm(5) }, { x: mx, y: Math.max(...ys) + mm(5) });
    expect(pieces.length).toBe(2);
    const fake = pieces.map((o, i) => ({ ...poly, index: i, outline: o.map((p) => (Math.abs(p.x - mx) <= 1 ? { x: mx, y: p.y } : p)), vertices: [] }));
    expect(combinePolygons(fake).length).toBe(1);
    const b = poly.bag.clone(); b.set('REMOVENECKS', 'TRUE'); b.set('NECKWIDTHTHRESHOLD', '100000mil');
    const area = (r: ReturnType<typeof computePour>) => r.regions.reduce((s, x) => s + Math.abs(x.outline.reduce((a, p, i) => { const q = x.outline[(i + 1) % x.outline.length]!; return a + p.x * q.y - q.x * p.y; }, 0) / 2), 0);
    // Only the relief spokes to its pads are left
    expect(area(computePour(doc, { ...poly, bag: b }))).toBeLessThan(area(computePour(doc, poly)) * 0.05);
  });
});

describe('pin swapping', () => {
  it('swap groups kept in the pad record; pads of a group swap nets; the optimiser shortens connections', () => {
    const doc = demo();
    const c1 = doc.components.findIndex((c) => c.designator === 'C1');
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === c1);
    expect(swapInfo(doc, pads[0]!)).toEqual({ pin: '', part: '' });
    expect(canSwapPins(doc, pads[0]!, pads[1]!)).toMatch(/pin swapping is off/);
    doc.components[c1]!.bag.set('ENABLEPINSWAPPING', 'TRUE');
    const edits = pads.map((p) => ({ storage: p.src.storage, index: p.src.index, after: withSwapInfo(doc.streams.get(p.src.storage)!.records[p.src.index]!, { pin: '1', part: '' }) }));
    tx(doc, (t) => t.add(replaceRecords(doc, edits)));
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    const bp = back.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === c1);
    expect(swapInfo(back, bp[0]!)).toEqual({ pin: '1', part: '' });
    const now = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === c1);
    expect(canSwapPins(doc, now[0]!, now[1]!)).toBeNull();
    const [n0, n1] = [now[0]!.net, now[1]!.net];
    tx(doc, (t) => t.add(replaceRecords(doc, setPadNets(doc, [{ pad: now[0]!, net: n1 }, { pad: now[1]!, net: n0 }]))));
    const after = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === c1);
    expect([after[0]!.net, after[1]!.net]).toEqual([n1, n0]);
    // Swapped back by the optimiser: the original nets sit nearer their connections
    const o = optimisePins(doc);
    expect(o.moves.length).toBe(2);
    expect(o.gain).toBeGreaterThan(0);
  });
});
