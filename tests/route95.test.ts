import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { RouteWorld, multiLayerRoute, type MultiFound } from '../src/model/router';
import type { Vec2 } from '../src/core/geom';

const O = 10_000_000;
const MM = 1e7 / 25.4;
const P = (x: number, y: number): Vec2 => ({ x: Math.round(O + x * MM), y: Math.round(O + y * MM) });
const W = 100_000;

describe('ActiveRoute: a route guide', () => {
  it('without one the route goes straight; along one it keeps within the guide drawn', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.prims = [];
    const worlds = [new RouteWorld(doc, L.TOP), new RouteWorld(doc, L.BOTTOM)];
    const a = P(5, 10), b = P(35, 10);
    const dev = (m: MultiFound) => Math.max(...m.runs.flatMap((r) => r.pts.map((p) => Math.abs(p.y - a.y)))) / MM;
    const plain = multiLayerRoute(worlds, 0, 0, W, { diameter: 240_000 }, a, b, { dirs: 8 })!;
    expect(plain.complete).toBe(true);
    expect(dev(plain)).toBeLessThan(0.5);
    // A guide dipping 10 mm below: the route follows it, on one layer, with no via
    const guide = { pts: [P(5, 10), P(10, 20), P(30, 20), P(35, 10)], width: 3 * MM };
    const g = multiLayerRoute(worlds, 0, 0, W, { diameter: 240_000 }, a, b, { dirs: 8, guide })!;
    expect(g.complete).toBe(true);
    expect(dev(g)).toBeGreaterThan(8);
    expect(g.vias).toHaveLength(0);
    // Every point of it within the guide (half its width, and a grid step)
    const seg = (p: Vec2, s: Vec2, e: Vec2) => { const dx = e.x - s.x, dy = e.y - s.y, t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy))); return Math.hypot(p.x - s.x - t * dx, p.y - s.y - t * dy); };
    const off = (p: Vec2) => Math.min(...guide.pts.slice(1).map((q, i) => seg(p, guide.pts[i]!, q))) / MM;
    expect(Math.max(...g.runs.flatMap((r) => r.pts.map(off)))).toBeLessThan(1.6);
  });
});

describe('ActiveRoute: a bundle along a hard guide (R5)', () => {
  it('three connections, each on its lane, side by side in order, inside the guide, on one layer with no vias', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.prims = [];
    // From three pads stacked on the left to three on the right, the guide bending down 8 mm in the middle
    const from = [P(4, 8), P(4, 10), P(4, 12)], to = [P(36, 8), P(36, 10), P(36, 12)];
    const pitch = W + 200_000;
    const guide = { pts: [P(8, 10), P(14, 18), P(26, 18), P(32, 10)], width: Math.round(3 * pitch * 1.3) };
    const toGuide = (p: Vec2) => Math.min(...guide.pts.slice(1).map((q, i) => seg(p, guide.pts[i]!, q)));
    const seg = (p: Vec2, s: Vec2, e: Vec2) => { const dx = e.x - s.x, dy = e.y - s.y, t = Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / (dx * dx + dy * dy))); return Math.hypot(p.x - s.x - t * dx, p.y - s.y - t * dy); };
    const fixed: { layer: number; a: Vec2; b: Vec2; width: number; net: number }[] = [];
    const lanes = [-pitch, 0, pitch];
    const mids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const worlds = [new RouteWorld(doc, L.TOP, undefined, { tracks: fixed as never })];
      const g = { ...guide, hard: true, lane: lanes[i]!, escape: [from[i]!, to[i]!].map((c) => ({ c, r: Math.max(2 * pitch, toGuide(c) - guide.width / 2 + 2 * pitch) })) };
      const m = multiLayerRoute(worlds, 0, i + 1, W, { diameter: 240_000 }, from[i]!, to[i]!, { dirs: 8, guide: g, noVias: true, endLayers: [0] })!;
      expect(m.complete, `connection ${i}`).toBe(true);
      expect(m.vias).toHaveLength(0);
      const pts = m.runs.flatMap((r) => r.pts);
      for (let k = 1; k < pts.length; k++) fixed.push({ layer: L.TOP, a: pts[k - 1]!, b: pts[k]!, width: W, net: i + 1 });
      // Where it crosses the middle (x = 20 mm): on the bend's flat run, its lane below or above the others
      const across = pts.slice(1).map((q, k) => [pts[k]!, q] as const).find(([a, b]) => (a.x - P(20, 0).x) * (b.x - P(20, 0).x) <= 0)!;
      const t = (P(20, 0).x - across[0].x) / ((across[1].x - across[0].x) || 1);
      mids.push((across[0].y + (across[1].y - across[0].y) * t - O) / MM);
      // Inside the guide wherever it is outside its escapes round its pads (and their edges, a grid step)
      for (const p of pts) if (g.escape.every((e) => Math.hypot(p.x - e.c.x, p.y - e.c.y) > e.r + 0.3 * MM)) expect(toGuide(p) / MM).toBeLessThan(guide.width / 2 / MM + 0.3);
    }
    // The lanes in the order of their pads: the lowest pad's route lowest
    expect(mids[0]).toBeLessThan(mids[1]!);
    expect(mids[1]).toBeLessThan(mids[2]!);
    for (const y of mids) expect(Math.abs(y - 18)).toBeLessThan(guide.width / 2 / MM);
  });
});

describe('ActiveRoute: the guide\'s width and lanes, as AD works them out', () => {
  it('width: the tracks and gaps over the layers, 30% more; lanes in the order the connections meet the guide\'s start, alternate layers', async () => {
    const { guideWidth, guideLanes, lanePitch } = await import('../src/model/routeGuide');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const conns = [10, 6, 8].map((y, i) => ({ net: i + 1, a: P(4, y), b: P(36, y) })) as never[];
    const pitches = conns.map((c) => lanePitch(doc, c)), pitch = Math.max(...pitches);
    expect(guideWidth(doc, conns, [L.TOP, L.BOTTOM])).toBe(Math.max(20 * 10_000, Math.round((pitches.reduce((t, x) => t + x, 0) / 2) * 1.3)));
    const g = guideLanes(doc, conns, { pts: [P(8, 8), P(32, 8)], width: 3 * pitch }, [L.TOP, L.BOTTOM]);
    // Seen along the guide (left is up the board): y = 6 rightmost, then 8, then 10
    expect([conns[1], conns[2], conns[0]].map((c) => g.guideFor(c!).lane)).toEqual([-pitch / 2, 0, pitch / 2]);
    expect([conns[1], conns[2], conns[0]].map((c) => g.layersFor(c!)[0])).toEqual([L.TOP, L.BOTTOM, L.TOP]);
    expect(g.guideFor(conns[0]!).hard).toBe(true);
  }, 60_000);

  it('connections whose pads are on the top only: all on the top, a whole pitch apart; the width for one layer', async () => {
    const { guideWidth, guideLanes, lanePitch } = await import('../src/model/routeGuide');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const smd = doc.prims.find((p) => p.kind === 'pad' && p.layer === L.TOP)!;
    const conns = [6, 8, 10].map((y, i) => ({ net: i + 1, a: P(4, y), b: P(36, y) })) as { net: number; a: ReturnType<typeof P>; b: ReturnType<typeof P> }[];
    doc.prims = conns.flatMap((c) => [{ ...smd, at: c.a, net: c.net }, { ...smd, at: c.b, net: c.net }]) as never;
    const pitch = Math.max(...conns.map((c) => lanePitch(doc, c as never)));
    const g = guideLanes(doc, conns as never, { pts: [P(8, 8), P(32, 8)], width: 3 * pitch }, [L.TOP, L.BOTTOM]);
    expect(conns.map((c) => g.layersFor(c as never)[0])).toEqual([L.TOP, L.TOP, L.TOP]);
    const lanes = conns.map((c) => g.guideFor(c as never).lane!).sort((a, b) => a - b);
    expect(lanes[1]! - lanes[0]!).toBeCloseTo(pitch, 6);
    expect(guideWidth(doc, conns as never, [L.TOP, L.BOTTOM])).toBe(Math.max(20 * 10_000, Math.round(conns.reduce((t, c) => t + lanePitch(doc, c as never), 0) * 1.3)));
  }, 60_000);
});
