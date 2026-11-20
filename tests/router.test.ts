import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { NO_NET, type PcbPrim } from '../src/model/pcb';
import { RouteWorld, clearanceBoundaries, lineOf, multiLayerRoute, shove, walkaround, type RItem } from '../src/model/router';
import { distance } from '../src/model/drc';
import type { Vec2 } from '../src/core/geom';

const O = 10_000_000; // the demo board's origin (1000 mil)
const P = (x: number, y: number): Vec2 => ({ x: Math.round(O + (x / 25.4) * 1e7), y: Math.round(O + (y / 25.4) * 1e7) });
const mil = (n: number) => n * 10_000;
let n = 0;
const track = (a: Vec2, b: Vec2, net: number, width = mil(10), extra: Partial<PcbPrim> = {}): PcbPrim =>
  ({ kind: 'track', src: { storage: 'Tracks6', index: n++ }, layer: L.TOP, a, b, width, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false, ...extra }) as PcbPrim;
const via = (at: Vec2, net: number): PcbPrim => ({ kind: 'via', src: { storage: 'Vias6', index: n++ }, at, diameter: mil(24), hole: mil(12), layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false }) as PcbPrim;
const pad = (at: Vec2, net: number, w = mil(60)): PcbPrim => ({
  kind: 'pad', src: { storage: 'Pads6', index: n++ }, name: '1', layer: L.TOP, at, rotation: 0,
  top: { w, h: w, shape: 'rect', cornerPct: 0 }, mid: { w, h: w, shape: 'rect', cornerPct: 0 }, bot: { w, h: w, shape: 'rect', cornerPct: 0 },
  hole: 0, plated: false, net, component: NO_NET, locked: false,
}) as PcbPrim;

function board(prims: PcbPrim[]) {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  doc.prims = prims;
  return doc;
}
const octilinear = (pts: Vec2[]) => pts.slice(1).every((b, i) => {
  const a = pts[i]!, dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  return dx < 2 || dy < 2 || Math.abs(dx - dy) < 3;
});
const W = mil(10);

describe('interactive router', () => {
  it('walkaround: round a via of another net, 45° segments hugging it at clearance', () => {
    const doc = board([via(P(12, 10), 2)]);
    const w = new RouteWorld(doc, L.TOP);
    const f = walkaround(w, 0, W, P(4, 10), P(20, 10), { dirs: 8 })!;
    expect(f.reached).toBe(true);
    expect(f.pts[0]).toEqual(P(4, 10));
    expect(f.pts.at(-1)).toEqual(P(20, 10));
    expect(w.clear(0, W, f.pts)).toBe(true);
    expect(octilinear(f.pts)).toBe(true);
    // It hugs: the nearest segment comes within a mil of the clearance
    const v = w.items.find((it) => it.kind === 'via')!;
    const near = Math.min(...f.pts.slice(1).map((b, i) => distance({ t: 'seg', a: f.pts[i]!, b, r: W / 2 }, v.g)));
    expect(near - w.gap(0, v)).toBeGreaterThanOrEqual(0);
    expect(near - w.gap(0, v)).toBeLessThan(mil(1));
    // Short: barely longer than the straight run
    const len = f.pts.slice(1).reduce((s, b, i) => s + Math.hypot(b.x - f.pts[i]!.x, b.y - f.pts[i]!.y), 0);
    expect(len / (P(20, 10).x - P(4, 10).x)).toBeLessThan(1.12);
  });
  it('walkaround: 90° corners in the 90° modes; through a gap between two pads', () => {
    const doc = board([pad(P(12, 6), 2, mil(200)), pad(P(12, 14.5), 1, mil(200))]);
    const w = new RouteWorld(doc, L.TOP);
    const f = walkaround(w, 0, W, P(4, 9), P(20, 11), { dirs: 4 })!;
    expect(f.reached).toBe(true);
    expect(w.clear(0, W, f.pts)).toBe(true);
    expect(f.pts.slice(1).every((b, i) => b.x === f.pts[i]!.x || b.y === f.pts[i]!.y)).toBe(true);
  });
  it('walkaround: a target inside an obstacle stops as near as it can', () => {
    const doc = board([pad(P(15, 10), 2, mil(120))]);
    const w = new RouteWorld(doc, L.TOP);
    const f = walkaround(w, 0, W, P(4, 10), P(15, 10), { dirs: 8 })!;
    expect(f.reached).toBe(false);
    expect(w.clear(0, W, f.pts)).toBe(true);
    const end = f.pts.at(-1)!;
    expect(P(15, 10).x - end.x).toBeLessThan(mil(60 + 10 + 5 + 4));
  });
  it('lines: a chain of tracks between pads, ending at the pad and at a branch', () => {
    const doc = board([pad(P(2, 10), 2), track(P(2, 10), P(10, 10), 2), track(P(10, 10), P(12, 12), 2), track(P(12, 12), P(18, 12), 2), track(P(18, 12), P(18, 16), 2), track(P(18, 12), P(22, 12), 2)]);
    const w = new RouteWorld(doc, L.TOP);
    const first = w.items.find((it) => it.kind === 'track' && it.seg!.b.x === P(10, 10).x)!;
    const l = lineOf(w, first);
    expect(l.items.length).toBe(3);
    expect(l.pts[0]).toEqual(P(2, 10));
    expect(l.pts.at(-1)).toEqual(P(18, 12));
  });
  it('push: a parallel track of another net moves aside, its ends kept', () => {
    const doc = board([pad(P(3, 11), 2), pad(P(30, 11), 2), track(P(3, 11), P(30, 11), 2)]);
    const w = new RouteWorld(doc, L.TOP);
    const route = [w.virtual({ layer: L.TOP, a: P(8, 10.5), b: P(22, 10.5), width: W, net: 0 })];
    const r = shove(w, route, { dirs: 8 });
    expect(r.ok).toBe(true);
    expect(r.shoved.length).toBe(1);
    const pts = r.shoved[0]!.pts;
    expect(pts[0]).toEqual(P(3, 11));
    expect(pts.at(-1)).toEqual(P(30, 11));
    expect(octilinear(pts)).toBe(true);
    // Clear of the route and of everything else
    const moved = new Set(r.shoved[0]!.line.items.map((x) => x.id));
    expect(w.clear(2, W, pts, { extra: route, skip: (it: RItem) => moved.has(it.id) })).toBe(true);
  });
  it('push: a line pushed into another pushes that one too', () => {
    const doc = board([
      pad(P(3, 11), 2, mil(20)), pad(P(30, 11), 2, mil(20)), track(P(3, 11), P(30, 11), 2),
      pad(P(2, 11.6), 1, mil(20)), pad(P(31, 11.6), 1, mil(20)), track(P(2, 11.6), P(31, 11.6), 1),
    ]);
    const w = new RouteWorld(doc, L.TOP);
    const route = [w.virtual({ layer: L.TOP, a: P(8, 10.6), b: P(22, 10.6), width: W, net: 0 })];
    const r = shove(w, route, { dirs: 8 });
    expect(r.ok).toBe(true);
    expect(r.shoved.length).toBe(2);
  });
  it("push: fixed copper can't be pushed", () => {
    const doc = board([pad(P(15, 10.4), 2)]);
    const w = new RouteWorld(doc, L.TOP);
    const r = shove(w, [w.virtual({ layer: L.TOP, a: P(8, 10), b: P(22, 10), width: W, net: 0 })], { dirs: 8 });
    expect(r.ok).toBe(false);
  });
  it('clearance boundaries: each obstacle grown by its gap and half the width, merged', () => {
    const doc = board([via(P(12, 10), 2), via(P(12.6, 10), 2)]);
    const w = new RouteWorld(doc, L.TOP);
    const b = clearanceBoundaries(w, 0, W, { minX: P(10, 8).x, minY: P(10, 8).y, maxX: P(15, 12).x, maxY: P(15, 12).y });
    expect(b.length).toBe(1);
  });

  it('AutoRoute On Multiple Layers: under a wall on the top layer by two vias, back up to an SMD pad', () => {
    // A wall of another net across the board on the top layer only
    const wall = track(P(15, -5), P(15, 40), 2, mil(20));
    const doc = board([wall, pad(P(4, 12), 0), pad(P(26, 12), 0)]);
    const worlds = [new RouteWorld(doc, L.TOP), new RouteWorld(doc, L.BOTTOM)];
    const m = multiLayerRoute(worlds, 0, 0, W, { diameter: mil(24) }, P(4, 12), P(26, 12), { dirs: 8, endLayers: [0] })!;
    expect(m.reached).toBe(true);
    expect(m.vias.length).toBe(2);
    expect(m.runs.map((r) => r.layer)).toEqual([L.TOP, L.BOTTOM, L.TOP]);
    for (const r of m.runs) expect(worlds.find((w) => w.layer === r.layer)!.clear(0, W, r.pts)).toBe(true);
    // The vias clear the wall and stay out of the pads
    for (const v of m.vias) {
      expect(worlds[0]!.viaHit(0, v, mil(24))).toBeNull();
      expect(Math.abs(v.x - P(4, 12).x) + Math.abs(v.y - P(4, 12).y)).toBeGreaterThan(mil(42));
    }
    // With no wall it keeps to the top layer
    const free = multiLayerRoute([new RouteWorld(board([]), L.TOP), new RouteWorld(board([]), L.BOTTOM)], 0, 0, W, { diameter: mil(24) }, P(4, 12), P(26, 12), { dirs: 8 })!;
    expect(free.vias).toEqual([]);
  });
});
