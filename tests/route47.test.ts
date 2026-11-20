import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { NO_NET, type PcbPrim } from '../src/model/pcb';
import { RouteWorld, noPending, shove } from '../src/model/router';
import { distance } from '../src/model/drc';
import type { Vec2 } from '../src/core/geom';

const O = 10_000_000;
const P = (x: number, y: number): Vec2 => ({ x: Math.round(O + (x / 25.4) * 1e7), y: Math.round(O + (y / 25.4) * 1e7) });
const mil = (n: number) => n * 10_000;
let n = 0;
const track = (a: Vec2, b: Vec2, net: number, layer: number = L.TOP, extra: Partial<PcbPrim> = {}): PcbPrim =>
  ({ kind: 'track', src: { storage: 'Tracks6', index: n++ }, layer, a, b, width: mil(10), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false, ...extra }) as PcbPrim;
const via = (at: Vec2, net: number, locked = false): PcbPrim => ({ kind: 'via', src: { storage: 'Vias6', index: n++ }, at, diameter: mil(24), hole: mil(12), layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked }) as PcbPrim;
function board(prims: PcbPrim[]) { const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'); doc.prims = prims; return doc; }

describe('via pushing', () => {
  it('a free via in the route\'s way moves aside at clearance, dragging its tracks (both layers) with it', () => {
    const v = P(15, 10.2);
    const doc = board([via(v, 1), track(v, P(15, 14), 1, L.TOP), track(v, P(19, 10.2), 1, L.BOTTOM)]);
    const w = new RouteWorld(doc, L.TOP);
    const route = [w.virtual({ layer: L.TOP, a: P(8, 10), b: P(22, 10), width: mil(10), net: 0 })];
    const r = shove(w, route, { dirs: 8, vias: true });
    expect(r.ok).toBe(true);
    expect(r.vias.length).toBe(1);
    const pv = r.vias[0]!;
    // Away (upwards, the side it stood on), just clear: route edge + gap + via radius
    expect(pv.to.y).toBeGreaterThan(v.y);
    const d = distance({ t: 'seg', a: P(8, 10), b: P(22, 10), r: mil(5) }, { t: 'circle', c: pv.to, r: mil(12) });
    expect(d).toBeGreaterThanOrEqual(w.gap(0, route[0]!) - 200);
    expect(d).toBeLessThan(w.gap(0, route[0]!) + mil(4));
    expect(pv.dragged.map((t) => t.layer).sort()).toEqual([L.TOP, L.BOTTOM].sort());
    expect(pv.dragged.every((t) => (t.a.x === pv.to.x && t.a.y === pv.to.y) || (t.b.x === pv.to.x && t.b.y === pv.to.y))).toBe(true);
  });

  it('a locked via stays: the push fails at it', () => {
    const v = P(15, 10.2);
    const doc = board([via(v, 1, true)]);
    const w = new RouteWorld(doc, L.TOP);
    const r = shove(w, [w.virtual({ layer: L.TOP, a: P(8, 10), b: P(22, 10), width: mil(10), net: 0 })], { dirs: 8, vias: true });
    expect(r.ok).toBe(false);
    expect(r.vias.length).toBe(0);
  });

  it('a pushed via stands at its new place for the rest of the route', () => {
    const v = P(15, 10.2);
    const doc = board([via(v, 1)]);
    const pending = noPending();
    pending.vias.set(0, P(15, 11));
    const w = new RouteWorld(doc, L.TOP, pending);
    const vi = w.items.find((it) => it.kind === 'via')!;
    expect(vi.g.t === 'circle' && vi.g.c.y).toBe(P(15, 11).y);
  });
});

describe('hugging style', async () => {
  const { walkaround } = await import('../src/model/router');
  const { styleCorners } = await import('../src/model/hugStyle');
  const route = () => {
    const doc = board([via(P(15, 10), 1)]);
    const w = new RouteWorld(doc, L.TOP);
    const f = walkaround(w, 0, mil(10), P(8, 10), P(22, 10), { dirs: 8 })!;
    const segs = f.pts.slice(1).map((b, i) => ({ layer: L.TOP, a: f.pts[i]!, b, width: mil(10), net: 0 }));
    return { w, segs };
  };
  it('Mitered With Lines leaves the route as it is', () => {
    const { w, segs } = route();
    expect(styleCorners(segs, 'lines', () => w)).toEqual({ tracks: segs, arcs: [] });
  });
  it('Rounded: a route hugging a via all round it bends about its centre in one arc at the clearance', () => {
    const doc = board([via(P(15, 10), 1)]);
    const w = new RouteWorld(doc, L.TOP);
    const c = P(15, 10), gap = w.gap(0, w.items.find((it) => it.kind === 'via')!), R = mil(12) + gap + mil(5) + 300;
    // An octagon's upper half round the via, each leg tangent to the clearance circle
    const k = R * Math.tan(Math.PI / 8);
    const oct = [[-R - mil(100), 0], [-R, 0], [-R, k], [-k, R], [k, R], [R, k], [R, 0], [R + mil(100), 0]].map(([x, y]) => ({ x: Math.round(c.x + x!), y: Math.round(c.y + y!) }));
    // Legs at R + a hair: clear by construction
    const segs = oct.slice(1).map((b, i) => ({ layer: L.TOP, a: oct[i]!, b, width: mil(10), net: 0 }));
    const r = styleCorners(segs, 'rounded', () => w);
    const about = r.arcs.filter((a) => Math.hypot(a.c.x - c.x, a.c.y - c.y) < 10);
    expect(about.length).toBe(1);
    expect(Math.abs(about[0]!.r - R)).toBeLessThan(mil(1));
    const sweep = ((about[0]!.end - about[0]!.start) % 360 + 360) % 360;
    expect(sweep).toBeGreaterThan(90);
  });
  it('Rounded elsewhere: the corners smoothed as far as the legs allow, the route still joined', () => {
    const { w, segs } = route();
    const r = styleCorners(segs, 'rounded', () => w);
    expect(r.arcs.length).toBeGreaterThanOrEqual(2);
    const ends = (a: (typeof r.arcs)[number], deg: number) => ({ x: a.c.x + a.r * Math.cos((deg * Math.PI) / 180), y: a.c.y + a.r * Math.sin((deg * Math.PI) / 180) });
    const touch = (p: { x: number; y: number }) => r.tracks.some((t) => Math.hypot(t.a.x - p.x, t.a.y - p.y) < mil(0.5) || Math.hypot(t.b.x - p.x, t.b.y - p.y) < mil(0.5));
    for (const a of r.arcs) expect(touch(ends(a, a.start)) && touch(ends(a, a.end))).toBe(true);
  });
  it('Mitered With Arcs: each corner an arc', () => {
    const { w, segs } = route();
    const r = styleCorners(segs, 'arcs', () => w);
    expect(r.arcs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...r.arcs.map((a) => a.r))).toBeLessThan(mil(60));
  });
});

describe('autorouter rip-up and retry', async () => {
  const { autoroute } = await import('../src/model/autoroute');
  const at = (x: number, y: number) => ({ x: O + mil(x), y: O + mil(y) });
  const wall = (x0: number, y0: number, x1: number, y1: number): PcbPrim => ({ kind: 'fill', src: { storage: 'Fills6', index: n++ }, layer: L.KEEPOUT, a: at(x0, y0), b: at(x1, y1), rotation: 0, net: NO_NET, component: NO_NET, locked: false, keepout: false }) as PcbPrim;
  const pad = (p: { x: number; y: number }, net: number): PcbPrim => ({
    kind: 'pad', src: { storage: 'Pads6', index: n++ }, name: '1', layer: L.TOP, at: p, rotation: 0,
    top: { w: mil(20), h: mil(20), shape: 'rect', cornerPct: 0 }, mid: { w: mil(20), h: mil(20), shape: 'rect', cornerPct: 0 }, bot: { w: mil(20), h: mil(20), shape: 'rect', cornerPct: 0 },
    hole: 0, plated: false, net, component: NO_NET, locked: false }) as PcbPrim;
  // Two corridors one track wide; A (shorter, routed first) could take either, B only the lower one
  const A1 = at(230, 372), A2 = at(770, 372), B1 = at(100, 325), B2 = at(900, 325);
  const make = () => {
    const doc = board([
      wall(0, 0, 1000, 300), wall(260, 350, 740, 400), wall(0, 350, 200, 400), wall(800, 350, 1000, 400), wall(0, 450, 1000, 700),
      pad(A1, 1), pad(A2, 1), pad(B1, 2), pad(B2, 2),
    ]);
    doc.board.outline = [at(0, 0), at(1000, 0), at(1000, 700), at(0, 700)];
    doc.board.copperStack = [L.TOP];
    return doc;
  };
  const conns = [{ net: 1, a: A1, b: A2 }, { net: 2, a: B1, b: B2 }];
  it('without rip-up the first route takes the lower corridor and the second fails', async () => {
    const r = await autoroute(make(), conns, { ripUp: false });
    expect(r.routed).toBe(1);
    expect(r.failed.map((c) => c.net)).toEqual([2]);
  }, 30_000);
  it('rip-up and retry: the first route is ripped up, the second takes the lower corridor, the first goes round by the upper', async () => {
    const r = await autoroute(make(), conns);
    expect(r.ripped).toBeGreaterThanOrEqual(1);
    expect(r.routed).toBe(2);
    expect(r.failed).toEqual([]);
    const aYs = r.tracks.filter((t) => t.net === 1).flatMap((t) => [t.a.y, t.b.y]);
    expect(Math.max(...aYs)).toBeGreaterThan(at(0, 400).y);
    const bYs = r.tracks.filter((t) => t.net === 2).flatMap((t) => [t.a.y, t.b.y]);
    expect(Math.max(...bYs)).toBeLessThan(at(0, 350).y);
  }, 30_000);
});
