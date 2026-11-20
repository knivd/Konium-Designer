import { describe, expect, it } from 'vitest';
import { anchorFor, grownShape, loopsOf, nextPadName, PAD_SHAPE_KEY, padShapeGroup, planPad, shapeOf, shapeRegions } from '../src/model/padShapes';
import { encodeArc, encodePad, encodeRegion, encodeTrack, readPcbDoc, rebuildPrims, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { addPrimRecords, removePrims } from '../src/model/pcbEdit';
import { defaultGerberSetup, pasteMask, plotLayer, solderMask } from '../src/formats/gerber/gerber';
import { REGION, PAD, get, put } from '../src/formats/altium/pcbLayouts';
import { L } from '../src/model/layers';
import { NO_NET, type PcbArc, type PcbDocument, type PcbPad, type PcbPrim, type PcbRegion, type PcbTrack } from '../src/model/pcb';

const MIL = 10_000;
const track = (ax: number, ay: number, bx: number, by: number): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: 0 }, layer: L.TOP, a: { x: ax * MIL, y: ay * MIL }, b: { x: bx * MIL, y: by * MIL }, width: MIL, net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false } as PcbTrack);
const circle = (r: number): PcbArc => ({ kind: 'arc', src: { storage: 'Arcs6', index: 0 }, layer: L.TOP, c: { x: 0, y: 0 }, r: r * MIL, start: 0, end: 360, width: MIL, net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false } as PcbArc);
/** A 100 mil square with a 20 by 20 mil notch out of its top edge, as tracks. */
const notched = () => [track(0, 0, 100, 0), track(100, 0, 100, 100), track(100, 100, 60, 100), track(60, 100, 60, 80), track(60, 80, 40, 80), track(40, 80, 40, 100), track(40, 100, 0, 100), track(0, 100, 0, 0)];

describe('polygon pads: the shape a selection makes', () => {
  it('tracks round a notched square close into one outline; two circles make a ring; an open outline is refused', () => {
    const loops = loopsOf(notched());
    expect(Array.isArray(loops) && loops.length).toBe(1);
    const ring = shapeOf([circle(50), circle(30)]);
    expect(typeof ring !== 'string' && ring.holes.length).toBe(1);
    expect(loopsOf(notched().slice(1))).toMatch(/don’t close/);
    expect(shapeOf([...notched(), ...notched().map((t) => ({ ...t, a: { x: t.a.x + 300 * MIL, y: t.a.y }, b: { x: t.b.x + 300 * MIL, y: t.b.y } }))])).toMatch(/2 separate shapes/);
  });
  it('the anchor goes where the copper is widest: in the ring itself, the notched square near its middle', () => {
    const ring = shapeOf([circle(50), circle(30)]) as Exclude<ReturnType<typeof shapeOf>, string>;
    const a = anchorFor(ring);
    expect(Math.hypot(a.at.x, a.at.y) / MIL).toBeGreaterThan(36);
    expect(Math.hypot(a.at.x, a.at.y) / MIL).toBeLessThan(44);
    expect(a.size / MIL).toBeGreaterThan(14);
    expect(a.size / MIL).toBeLessThanOrEqual(16.5);
    const sq = anchorFor(shapeOf(notched()) as Exclude<ReturnType<typeof shapeOf>, string>);
    expect(Math.abs(sq.at.x / MIL - 50)).toBeLessThan(6);
    expect(sq.at.y / MIL).toBeLessThan(55);
  });
  it('a mask opening grows the ring both ways: wider outside, the hole smaller', () => {
    const ring = shapeOf([circle(50), circle(30)]) as Exclude<ReturnType<typeof shapeOf>, string>;
    const g = grownShape(ring, 4 * MIL)!;
    const r = (pts: { x: number; y: number }[]) => Math.max(...pts.map((p) => Math.hypot(p.x, p.y))) / MIL;
    expect(r(g.outline)).toBeGreaterThan(53.5);
    expect(r(g.holes[0]!)).toBeLessThan(26.5);
  });
  it('a new pad is numbered after the highest; only one pad may be selected; other objects are refused', () => {
    expect(nextPadName([{ name: '1' }, { name: '7' }, { name: 'A2' }] as PcbPad[])).toBe('8');
    expect(nextPadName([])).toBe('1');
    const pad = { kind: 'pad', name: '1', hole: 0, layer: L.TOP } as PcbPad;
    expect(planPad([...notched(), pad, { ...pad, name: '2' }], [], L.TOP)).toMatch(/one pad at most/);
    expect(planPad([...notched(), { kind: 'via' } as PcbPrim], [], L.TOP)).toMatch(/1 other object/);
  });
});

/** A board with the shape's tracks (or two circles) on it, made into a pad as the command does. */
function makePad(prims: 'ring' | 'notch', withPad = false): PcbDocument {
  const doc = readPcbDoc(newPcbDocBytes('P.PcbDoc'), 'P.PcbDoc');
  doc.nets.push({ name: 'GND' } as PcbDocument['nets'][number]);
  const recs = prims === 'ring'
    ? [{ storage: 'Arcs6', rec: encodeArc({ layer: L.TOP, c: { x: 1000 * MIL, y: 1000 * MIL }, r: 50 * MIL, start: 0, end: 360, width: MIL }) }, { storage: 'Arcs6', rec: encodeArc({ layer: L.TOP, c: { x: 1000 * MIL, y: 1000 * MIL }, r: 30 * MIL, start: 0, end: 360, width: MIL }) }]
    : notched().map((t) => ({ storage: 'Tracks6', rec: encodeTrack({ layer: L.TOP, a: t.a, b: t.b, width: MIL }) }));
  addPrimRecords(doc, recs).apply();
  if (withPad) addPrimRecords(doc, [{ storage: 'Pads6', rec: encodePad({ name: 'G', layer: L.TOP, at: { x: 1040 * MIL, y: 1000 * MIL }, w: 10 * MIL, h: 10 * MIL, shape: 'round', net: 0 }) }]).apply();
  const sel = doc.prims.filter((p) => p.kind === 'arc' || p.kind === 'track' || p.kind === 'pad');
  const plan = planPad(sel, doc.prims.filter((p): p is PcbPad => p.kind === 'pad'), L.TOP);
  if (typeof plan === 'string') throw new Error(plan);
  removePrims(doc, plan.sources).apply();
  let pad = plan.anchor;
  if (plan.fresh) {
    const f = plan.fresh;
    addPrimRecords(doc, [{ storage: 'Pads6', rec: encodePad({ name: f.name, layer: f.layer, at: f.at, w: f.size, h: f.size, shape: 'round', net: f.net, component: f.component }) }]).apply();
    pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad')!;
  }
  const a = pad!;
  const regions = shapeRegions(plan, (top) => solderMask(doc, a, top), pasteMask(doc, a));
  addPrimRecords(doc, regions.map((r) => ({ storage: 'Regions6', rec: encodeRegion({ layer: r.layer, outline: r.shape.outline, holes: r.shape.holes, net: a.net, component: a.component, extra: { [PAD_SHAPE_KEY]: a.name } }) }))).apply();
  return doc;
}

describe('polygon pads on a board', () => {
  it('the outline becomes a pad with its copper, mask and paste, linked and selected together; the tracks go', () => {
    const doc = makePad('notch');
    const pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad')!;
    const regions = doc.prims.filter((p): p is PcbRegion => p.kind === 'region');
    expect(doc.prims.filter((p) => p.kind === 'track')).toHaveLength(0);
    expect(pad.name).toBe('1');
    expect(regions.map((r) => r.layer).sort((a, b) => a - b)).toEqual([L.TOP, L.TOP_PASTE, L.TOP_SOLDER]);
    expect(regions.every((r) => r.padShape === '1' && r.shapeOf === `Pads6:${pad.src.index}`)).toBe(true);
    expect(pad.shapeKeys).toHaveLength(3);
    expect(padShapeGroup(doc.prims, regions[0]!)).toHaveLength(4);
  });

  it('saved and read again (as Altium Designer would read it: a pad and three regions), it is the same polygon pad; the regions follow the pad\'s net and name', () => {
    const doc = makePad('ring', true);
    const pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad')!;
    expect(pad.name).toBe('G');
    expect(doc.prims.filter((p) => p.kind === 'region').every((r) => (r as PcbRegion).net === 0)).toBe(true);
    // The pad re-netted and renamed in its record: the regions follow when read, and in the file when saved
    const rec = doc.streams.get('Pads6')!.records[pad.src.index]!;
    put(rec.subs[4]!, PAD.net, NO_NET);
    rebuildPrims(doc);
    expect(doc.prims.filter((p) => p.kind === 'region').every((r) => (r as PcbRegion).net === NO_NET)).toBe(true);
    const back = readPcbDoc(writePcbDoc(doc), 'P.PcbDoc');
    const raw = back.streams.get('Regions6')!.records.map((r) => get(r.subs[0]!, REGION.net));
    expect(raw).toEqual([NO_NET, NO_NET, NO_NET]);
    const regions = back.prims.filter((p): p is PcbRegion => p.kind === 'region');
    expect(regions.map((r) => r.holes.length)).toEqual([1, 1, 1]);
    expect(back.prims.find((p): p is PcbPad => p.kind === 'pad')!.shapeKeys).toHaveLength(3);
  });

  it('the copper ring, its mask and its paste come out in the Gerbers', () => {
    const doc = makePad('ring');
    const setup = defaultGerberSetup(doc);
    for (const l of [L.TOP, L.TOP_SOLDER, L.TOP_PASTE]) {
      const g = plotLayer(doc, l, setup, false, new Set());
      expect(g).toMatch(/G36\*/);
    }
  });
});
