/**
 * The free-flowing routing style (26.194): routes pulled tight at any angle with their bends made
 * arcs, after the routing; for the Smart Router's classes, the autorouter by preference, and
 * routes that are there. On Konium's own example board.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ROUTING, type RoutingPlan } from '../src/ai/jobs';
import { routeBrief } from '../src/ai/routeBrief';
import { ROUTING_SAMPLE, routingSampleBytes } from '../src/formats/synthetic/routingSample';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { copperViolations, routeByPlan, routeResultText, routingText, type Commit } from '../src/model/planRoute';
import { flowSegments, reflow } from '../src/model/reflow';
import { arcPoints, fillet, flowLength, flowPath, taut } from '../src/model/flowStyle';
import { RouteWorld } from '../src/model/router';
import { routePair } from '../src/model/pairRoute';
import { addArcs, addTracks, removePrims, repour } from '../src/model/pcbEdit';
import { connections } from '../src/model/drc';
import { toUnits } from '../src/model/layoutPlan';
import { UndoStack } from '../src/core/undo';
import { L } from '../src/model/layers';
import { NO_NET, type PcbArc, type PcbDocument, type PcbPad, type PcbTrack } from '../src/model/pcb';

let placed: Uint8Array;
beforeAll(async () => { placed = await routingSampleBytes(); });
const board = () => readPcbDoc(placed, ROUTING_SAMPLE.name);
const MM = toUnits(1);

const classes = (style: Record<string, string> = {}) => [
  { name: 'Crystal', nets: ['XTAL1', 'XTAL2'], width: 0.25, layers: ['Top Layer'], vias: 'none', order: 1, style: style.Crystal },
  { name: 'USB', nets: ['USB_DP', 'USB_DM'], width: 0.25, layers: ['top'], vias: 'few', order: 2, style: style.USB },
  { name: 'Power', nets: ['VBUS', '+3V3'], width: 0.5, order: 3, style: style.Power },
  { name: 'Ground', nets: ['GND'], width: 0.4, order: 4, style: style.Ground },
  { name: 'Signals', nets: ['NRST', 'TX', 'RX', 'LED', 'LED_A', 'SWDIO', 'SWCLK', 'SCL', 'SDA'], width: 0, layers: ['Top Layer'], order: 5, style: style.Signals },
];
const answer = (style: Record<string, string> = {}) => ({ summary: 'A two-layer USB sensor node.', classes: classes(style), via: { diameter: 0.6, hole: 0.3 }, pours: [{ net: 'GND', layer: 'Bottom Layer' }], pairs: [], notes: [] });
const planFor = (doc: PcbDocument, a: unknown): RoutingPlan => { const b = routeBrief(doc)!; return ROUTING.check(a, { board: '', brief: '', nets: b.nets, layers: b.layers, previous: '', result: '', remarks: '' }); };
async function routed(doc: PcbDocument, plan: RoutingPlan, flowing = false) {
  const u = new UndoStack(), at = u.checkpoint();
  const commit: Commit = (fn) => { u.transact('Route by the routing plan', (tx) => fn((c) => tx.add(c))); return true; };
  const run = await routeByPlan(doc, plan, { commit, flowing });
  u.mergeSince(at, 'Route by the routing plan');
  return { run: run!, u };
}
const free = (doc: PcbDocument) => ({
  tracks: doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.polygon === NO_NET && p.component === NO_NET && (p.layer === L.TOP || p.layer === L.BOTTOM)),
  arcs: doc.prims.filter((p): p is PcbArc => p.kind === 'arc' && p.polygon === NO_NET && p.component === NO_NET && (p.layer === L.TOP || p.layer === L.BOTTOM)),
});
const copperLength = (doc: PcbDocument) => { const f = free(doc); return (f.tracks.reduce((s, t) => s + Math.hypot(t.a.x - t.b.x, t.a.y - t.b.y), 0) + f.arcs.reduce((s, a) => s + ((((a.end - a.start) % 360) + 360) % 360) * (Math.PI / 180) * a.r, 0)) / MM; };
const netOf = (doc: PcbDocument, n: string) => doc.nets.findIndex((x) => x.name === n);

describe('Free-flowing routes: the shape (26.194)', () => {
  it('a path round a pad is pulled tight and its bend made an arc that keeps the clearance', () => {
    const doc = board();
    const w = new RouteWorld(doc, L.TOP);
    // Round the lower mounting hole (2.5 mm, of no net, in the board's corner) from below it to above it: three sides of a square
    const hole = doc.prims.filter((p) => p.kind === 'pad' && p.component === NO_NET).sort((p, q) => (p as PcbPad).at.y - (q as PcbPad).at.y)[0] as PcbPad;
    const c = hole.at, net = netOf(doc, 'SCL'), width = Math.round(0.254 * MM), d = Math.round(2.2 * MM);
    const square = [{ x: c.x + d * 0.4, y: c.y - d }, { x: c.x - d, y: c.y - d }, { x: c.x - d, y: c.y + d }, { x: c.x + d * 0.4, y: c.y + d }].map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    expect(w.clear(net, width, square)).toBe(true);
    const tight = taut(w, net, width, square);
    expect(tight[0]).toEqual(square[0]);
    expect(tight.at(-1)).toEqual(square[3]);
    expect(w.clear(net, width, tight)).toBe(true);
    const pieces = fillet(w, net, width, tight);
    expect(flowPath(w, net, width, square)).toEqual(pieces);
    const arcs = pieces.filter((p) => p.kind === 'arc');
    expect(arcs.length).toBeGreaterThanOrEqual(1);
    // Shorter than the square way, each arc at least as wide a turn as the track, every piece clear, the pieces end to end
    expect(flowLength(pieces)).toBeLessThan(flowLength(square.slice(1).map((b, i) => ({ kind: 'line' as const, a: square[i]!, b }))) * 0.9);
    for (const p of pieces) {
      if (p.kind === 'arc') { expect(p.r).toBeGreaterThanOrEqual(width - 2); expect(w.clear(net, width, arcPoints(p))).toBe(true); }
      else expect(w.segHit(net, width, p.a, p.b)).toBeNull();
    }
    for (let i = 1; i < pieces.length; i++) expect(Math.hypot(pieces[i]!.a.x - pieces[i - 1]!.b.x, pieces[i]!.a.y - pieces[i - 1]!.b.y)).toBeLessThan(3);
    // A straight path stays as it is
    expect(flowPath(w, net, width, [square[1]!, square[2]!])).toEqual([{ kind: 'line', a: square[1], b: square[2] }]);
  });

  it('the plan says a class\'s style; the check reads it', () => {
    const doc = board();
    const plan = planFor(doc, answer({ Crystal: 'flowing', USB: 'Free-flowing', Power: 'corners', Ground: '45 degrees', Signals: 'whatever' }));
    expect(plan.classes.map((c) => c.style)).toEqual(['flowing', 'flowing', 'corners', 'corners', '']);
    expect(routingText(plan)).toContain('1. Crystal (0.25 mm wide; on Top Layer; vias: none; free-flowing): XTAL1, XTAL2');
    expect(routingText(plan)).toContain('3. Power (0.5 mm wide; any layer; vias: free; with corners): VBUS, +3V3');
    expect(ROUTING.messages({ board: '', brief: '', nets: [], layers: [], previous: '', result: '', remarks: '' })[0]!.content).toContain('style: "flowing"');
  });
});

describe('Free-flowing routes: on the board (26.194)', () => {
  it('routed by the plan with the style on: everything routed, curved, no shorter of clearance, no longer than with corners; one undo step', async () => {
    const cornered = board(), doc = board(), plan = planFor(doc, answer());
    const before = { conns: connections(doc).length, prims: doc.prims.length };
    await routed(cornered, planFor(cornered, answer()));
    const { run, u } = await routed(doc, plan, true);
    expect(run).toMatchObject({ left: 0, stopped: false, narrowed: [] });
    expect(connections(doc)).toHaveLength(0);
    expect(run.flowed).toBeGreaterThanOrEqual(20);
    expect(run.arcs).toBeGreaterThanOrEqual(20);
    const f = free(doc);
    expect(f.arcs).toHaveLength(run.arcs);
    expect(copperViolations(doc)).toEqual({});
    // Each arc belongs to a net and is as wide as a track of that net, and turns no tighter than its own width
    for (const a of f.arcs) {
      expect(a.net).not.toBe(NO_NET);
      expect(f.tracks.some((t) => t.net === a.net && t.width === a.width)).toBe(true);
      expect(a.r).toBeGreaterThanOrEqual(a.width - 2);
    }
    // Tracks at any angle: some neither along an axis nor at 45°
    const odd = f.tracks.filter((t) => { const dx = Math.abs(t.a.x - t.b.x), dy = Math.abs(t.a.y - t.b.y); return dx > 2000 && dy > 2000 && Math.abs(dx - dy) > 2000; });
    expect(odd.length).toBeGreaterThan(10);
    expect(copperLength(doc)).toBeLessThan(copperLength(cornered));
    expect(routeResultText(doc, plan, run)).toMatch(/Made free-flowing: \d+ routes, with \d+ arcs\./);
    // It saves and reads back with its arcs; one undo takes it all
    expect(free(readPcbDoc(writePcbDoc(doc), ROUTING_SAMPLE.name)).arcs).toHaveLength(run.arcs);
    expect(u.undo()).toBe('Route by the routing plan');
    expect({ conns: connections(doc).length, prims: doc.prims.length }).toEqual(before);
  }, 120_000);

  it('a class that asks for it is free-flowing, the others keep their corners', async () => {
    const doc = board(), plan = planFor(doc, answer({ Signals: 'flowing', Crystal: 'corners' }));
    const { run } = await routed(doc, plan, false);
    expect(run.left).toBe(0);
    expect(run.flowed).toBeGreaterThan(0);
    const f = free(doc), signals = new Set(plan.classes.find((c) => c.name === 'Signals')!.nets.map((n) => netOf(doc, n)));
    expect(f.arcs.length).toBeGreaterThan(0);
    expect(f.arcs.every((a) => signals.has(a.net))).toBe(true);
    expect(copperViolations(doc)).toEqual({});
  }, 120_000);

  it('a differential pair is laid as one and keeps its corners and its gap when the rest is made free-flowing', async () => {
    const doc = board(), plan = planFor(doc, { ...answer(), pairs: [{ name: 'USB', p: 'USB_DP', n: 'USB_DM', gap: 0.2 }] });
    const { run } = await routed(doc, plan, true);
    expect(run).toMatchObject({ left: 0, pairs: 1, coupled: 1 });
    expect(run.flowed).toBeGreaterThanOrEqual(15);
    const usb = new Set([netOf(doc, 'USB_DP'), netOf(doc, 'USB_DM')]);
    const f = free(doc);
    expect(f.arcs.some((a) => usb.has(a.net))).toBe(false);
    expect(f.tracks.filter((t) => usb.has(t.net)).every((t) => { const dx = Math.abs(t.a.x - t.b.x), dy = Math.abs(t.a.y - t.b.y); return dx < 3 || dy < 3 || Math.abs(dx - dy) < 3; })).toBe(true);
    expect(copperViolations(doc)).toEqual({});
    expect(routeResultText(doc, plan, run)).toContain('Differential pairs laid side by side at their gap: 1 of 1.');
    // The same pair with no room to lie side by side (3 mm asked between its tracks) is routed one net at a time, and that is said
    const wide = board(), plan2 = planFor(wide, { ...answer(), pairs: [{ name: 'USB', p: 'USB_DP', n: 'USB_DM', gap: 3 }] });
    const second = await routed(wide, plan2);
    expect(second.run).toMatchObject({ left: 0, pairs: 1, coupled: 0 });
    expect(routeResultText(wide, plan2, second.run)).toContain('Differential pairs laid side by side at their gap: 0 of 1.');
    // …and one whose two tracks would have to cross (each net's far end is beside the other's near end) is not laid as one
    const fresh = board(), w = new RouteWorld(fresh, L.TOP);
    const P = netOf(fresh, 'USB_DP'), N = netOf(fresh, 'USB_DM');
    const cp = connections(fresh).find((c) => c.net === P)!, cn = connections(fresh).find((c) => c.net === N)!;
    const width = Math.round(0.25 * MM), gap = Math.round(0.3 * MM), reach = { a: Math.round(0.7 * MM), b: Math.round(0.75 * MM) };
    const straight = routePair(w, P, N, width, gap, { pa: cp.a, na: cn.a, pb: cp.b, nb: cn.b }, reach)!;
    expect(straight).not.toBeNull();
    expect(straight.p[0]).toEqual(cp.a);
    expect(straight.p.at(-1)).toEqual(cp.b);
    expect(straight.n.at(-1)).toEqual(cn.b);
    expect(routePair(w, P, N, width, gap, { pa: cp.a, na: cn.a, pb: cn.b, nb: cp.b }, reach)).toBeNull();
  }, 120_000);

  it('a route laid by hand is shaped run by run', () => {
    const doc = board(), net = netOf(doc, 'SCL'), width = Math.round(0.254 * MM);
    const hole = doc.prims.filter((p) => p.kind === 'pad' && p.component === NO_NET).sort((p, q) => (p as PcbPad).at.y - (q as PcbPad).at.y)[0] as PcbPad;
    const c = hole.at, d = Math.round(2.2 * MM);
    const pts = [{ x: Math.round(c.x + d * 0.4), y: c.y - d }, { x: c.x - d, y: c.y - d }, { x: c.x - d, y: c.y + d }, { x: Math.round(c.x + d * 0.4), y: c.y + d }];
    const segs = pts.slice(1).map((b, i) => ({ layer: L.TOP, a: pts[i]!, b, width, net }));
    // …and a second run on the bottom layer, a single straight segment: as it is
    const far = { layer: L.BOTTOM, a: pts[3]!, b: { x: pts[3]!.x + d, y: pts[3]!.y }, width, net };
    const out = flowSegments([...segs, far], (l) => new RouteWorld(doc, l));
    expect(out.arcs.length).toBeGreaterThanOrEqual(1);
    expect(out.arcs.every((a) => a.layer === L.TOP && a.net === net && a.width === width)).toBe(true);
    expect(out.tracks.filter((t) => t.layer === L.BOTTOM)).toEqual([far]);
    expect(out.tracks[0]!.a).toEqual(pts[0]);
    expect(out.tracks.filter((t) => t.layer === L.TOP).at(-1)!.b).toEqual(pts[3]);
  });

  it('routes that are there are reshaped: all of them, or those picked; a second time changes nothing', async () => {
    const doc = board(), plan = planFor(doc, answer());
    await routed(doc, plan);
    expect(free(doc).arcs).toHaveLength(0);
    const was = copperLength(doc);
    // One net's routes only
    const scl = netOf(doc, 'SCL');
    const pick = new Set<number>();
    doc.prims.forEach((p, i) => { if (p.kind === 'track' && p.net === scl && p.polygon === NO_NET) pick.add(i); });
    const one = await reflow(doc, pick);
    expect(one.reshaped).toBeGreaterThan(0);
    expect(one.remove.every((p) => (p as PcbTrack).net === scl)).toBe(true);
    expect([...one.tracks, ...one.arcs].every((t) => t.net === scl)).toBe(true);
    // Every route
    const all = await reflow(doc);
    expect(all.reshaped).toBeGreaterThan(one.reshaped);
    expect(all.after).toBeLessThan(all.before);
    removePrims(doc, all.remove).apply(); addTracks(doc, all.tracks).apply(); addArcs(doc, all.arcs).apply();
    // The pour round them again, as the command does
    for (const g of doc.polygons) repour(doc, g.index).apply();
    expect(connections(doc)).toHaveLength(0);
    expect(copperViolations(doc)).toEqual({});
    expect(free(doc).arcs).toHaveLength(all.arcs.length);
    expect(copperLength(doc)).toBeLessThan(was);
    expect(copperLength(doc)).toBeCloseTo(was - (all.before - all.after) / MM, 1);
    const again = await reflow(doc);
    expect(again.reshaped).toBe(0);
  }, 120_000);
});
