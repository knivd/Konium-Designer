import { describe, expect, it } from 'vitest';
import {
  addSplit, moveSplit, affectedWidth, boardRegions, centreBend, chordAcross, cutPolygon, foldOf, foldPoints, readSubstacks, regionShapes, removeSplit,
  setRigidFlex, splitLines, splitsFromRegions, stackRange, withRegion, writeSubstacks, polyArea,
} from '../src/model/rigidFlex';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { setBoardShape } from '../src/model/pcbBoard';
import { readStack, setStack } from '../src/model/pcbStack';
import { PropertyBag } from '../src/formats/altium/props';
import { mil, mm } from '../src/core/units';
import type { Vec2 } from '../src/core/geom';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const area = (p: Vec2[]) => Math.abs(polyArea(p));

/** A 3000 × 1000 mil board. */
function board() {
  const doc = readPcbDoc(newPcbDocBytes('F.PcbDoc'), 'F.PcbDoc');
  setBoardShape(doc, rect(0, 0, mil(3000), mil(1000)).map((p) => ({ p }))).apply();
  return doc;
}

describe('rigid-flex: regions and split lines', () => {
  it('a split line cuts a region in two along its chord; one that misses cuts nothing', () => {
    const r = rect(0, 0, 100_000, 50_000);
    const c = cutPolygon(r, { x: 40_000, y: 0 }, { x: 40_000, y: 50_000 })!;
    expect(c).not.toBeNull();
    expect(area(c[0]) + area(c[1])).toBeCloseTo(area(r), -2);
    expect([area(c[0]), area(c[1])].sort()).toEqual([2e9, 3e9]);
    expect(cutPolygon(r, { x: 40_000, y: 0 }, { x: 60_000, y: 0 })).toBeNull();
  });

  it('lines run edge to edge: from the first click to where the outline is met again', () => {
    const r = rect(0, 0, 100_000, 50_000);
    expect(chordAcross([r], { x: 40_000, y: 0 }, { x: 40_000, y: 30_000 })).toEqual({ x: 40_000, y: 50_000 });
  });

  it('regions from the board and its split lines (one ending on another); the split lines found again from the regions', () => {
    const o = rect(0, 0, 300, 100).map((p) => ({ x: p.x * 10_000, y: p.y * 10_000 }));
    const splits = [{ a: { x: 1_000_000, y: 0 }, b: { x: 1_000_000, y: 1_000_000 } }, { a: { x: 1_000_000, y: 500_000 }, b: { x: 3_000_000, y: 500_000 } }];
    const { shapes, applied } = regionShapes(o, splits);
    expect(applied).toEqual([true, true]);
    expect(shapes.length).toBe(3);
    const back = splitsFromRegions(o, shapes);
    expect(back.length).toBe(2);
    expect(regionShapes(o, back).shapes.length).toBe(3);
  });

  it('Define Split Line: a new region, named as AD names them, on the same stack; Delete Split Line joins them again', () => {
    const doc = board();
    expect(boardRegions(doc).map((r) => r.name)).toEqual(['Layer Stack Region 1']);
    const f = addSplit(doc, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(1000) })!;
    setRigidFlex(doc, f).apply();
    const regs = boardRegions(doc);
    expect(regs.length).toBe(2);
    expect(regs.map((r) => r.name).sort()).toEqual(['Layer Stack Region 1', 'Layer Stack Region 2']);
    expect(regs.filter((r) => r.locked3d).length).toBe(0);
    expect(new Set(regs.map((r) => r.stackId)).size).toBe(1);
    expect(splitLines(doc).length).toBe(1);
    // An end dragged along the edge: the regions follow; dragged where it cuts nothing, refused
    setRigidFlex(doc, moveSplit(doc, 0, { x: mil(1000), y: 0 }, { x: mil(1500), y: mil(1000) })!).apply();
    expect(Math.max(...boardRegions(doc).flatMap((r) => r.outline.map((p) => p.y === mil(1000) && p.x < mil(3000) ? p.x : 0)))).toBe(mil(1500));
    expect(moveSplit(doc, 0, { x: mil(1000), y: 0 }, { x: mil(1200), y: 0 })).toBeNull();
    setRigidFlex(doc, removeSplit(doc, 0)!).apply();
    expect(boardRegions(doc).length).toBe(1);
  });

  it('saved and read back: regions (AD17\'s records), names, 3D Locked, bending lines; the board shape changed, the regions follow', () => {
    const doc = board();
    setRigidFlex(doc, addSplit(doc, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(1000) })!).apply();
    setRigidFlex(doc, addSplit(doc, { x: mil(2000), y: 0 }, { x: mil(2000), y: mil(1000) })!).apply();
    const regs = boardRegions(doc);
    expect(regs.length).toBe(3);
    const middle = regs.findIndex((r) => r.outline.every((p) => p.x >= mil(1000) - 5 && p.x <= mil(2000) + 5));
    const bend = centreBend(regs[middle]!.outline)!;
    expect(Math.round(bend.a.x / 10_000)).toBe(1500);
    setRigidFlex(doc, withRegion(doc, middle, { name: 'Flex', bends: [bend] })).apply();
    const back = readPcbDoc(writePcbDoc(doc), 'F.PcbDoc');
    const r2 = boardRegions(back);
    expect(r2.length).toBe(3);
    const flex = r2.find((r) => r.name === 'Flex')!;
    expect(flex.bends.length).toBe(1);
    expect(flex.bends[0]).toMatchObject({ angle: 90, foldIndex: 1 });
    expect(Math.round(flex.bends[0]!.a.x / 10_000)).toBe(1500);
    expect(r2.filter((r) => r.locked3d).length).toBe(0);
    // A longer board: the end regions grow with it
    setBoardShape(back, rect(0, 0, mil(4000), mil(1000)).map((p) => ({ p }))).apply();
    const r3 = boardRegions(back);
    expect(Math.max(...r3.map((r) => Math.max(...r.outline.map((p) => p.x))))).toBe(mil(4000));
    expect(back.dirty.has('BoardRegions')).toBe(true);
  });

});

describe('rigid-flex: layer stacks', () => {
  it('substacks read and written in both forms; a layer left out of one keeps that ({ID}CONTEXT)', () => {
    const doc = board();
    const subs = readSubstacks(doc.board.bag);
    expect(subs.length).toBe(1);
    const flex = { ...subs[0]!, id: '{11111111-2222-4333-8444-555555555555}', name: 'Flex', isFlex: true, usedByPrims: false };
    const rows = readStack(doc.board.bag!, doc.board.copperStack);
    // Flex: only the bottom copper and the core
    const out = rows.map((r) => ({ ...r, subs: { ...r.subs, [flex.id]: r.kind === 'dielectric' || r.name === 'Bottom Layer' } }));
    setStack(doc, out, undefined, [subs[0]!, flex]).apply();
    const b = doc.board.bag!;
    expect(b.get('V9_SUBSTACK1_NAME')).toBe('Flex');
    expect(b.get('V9_SUBSTACK1_ISFLEX')).toBe('TRUE');
    expect(b.get('LAYERSUBSTACK_V8_1ISFLEX')).toBe('TRUE');
    const back = readStack(b, doc.board.copperStack);
    expect(back.find((r) => r.name === 'Top Layer')!.subs![flex.id]).toBe(false);
    expect(back.find((r) => r.name === 'Bottom Layer')!.subs![flex.id]).toBe(true);
    const all = stackRange(back, subs[0]!.id), fx = stackRange(back, flex.id);
    expect(fx.z1 - fx.z0).toBeLessThan(all.z1 - all.z0);
    expect(fx.z0).toBeGreaterThan(0);
    const bag = PropertyBag.from({ RECORD: 'Board' });
    writeSubstacks(bag, [flex]);
    expect(readSubstacks(bag)[0]).toMatchObject({ name: 'Flex', isFlex: true });
  });
});

describe('rigid-flex: folding', () => {
  it('a 90° bend: the strip as wide as its arc; beyond it the board stands up, turned whole; flat at 0', () => {
    const o = rect(0, 0, mm(30), mm(10));
    const line = { a: { x: mm(20), y: 0 }, b: { x: mm(20), y: mm(10) }, angle: 90, radius: mm(2), foldIndex: 1 };
    expect(affectedWidth(line) / mm(1)).toBeCloseTo(Math.PI, 3);
    const regs = [{ name: 'A', stackId: '', locked3d: true, bends: [line], outline: o, index: 0 }];
    const toMm = (p: Vec2) => ({ x: p.x / mm(1), y: p.y / mm(1) });
    const f = foldOf(regs, toMm, () => 0, mm(1))!;
    expect(f.bends.length).toBe(1);
    // The locked region's middle (x 15) is left of the line: the right end moves
    const pts = new Float32Array([0, 5, 0, 30, 5, 0, 20 + Math.PI / 2 + 5, 5, 0]);
    const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const flat = pts.slice();
    foldPoints(f, 0, flat);
    expect([...flat]).toEqual([...pts]);
    const p = pts.slice(), n = nrm.slice();
    foldPoints(f, 1, p, n);
    expect([p[0], p[1], p[2]]).toEqual([0, 5, 0]);
    // 5 mm past the strip: 5 mm up the standing part, above the arc's end (the radius up, the radius on)
    expect(p[6]).toBeCloseTo(20 - Math.PI / 2 + 2, 4);
    expect(p[8]).toBeCloseTo(2 + 5, 4);
    expect(p[5]).toBeCloseTo(2 + 30 - 20 - Math.PI / 2, 4);
    // Its face now looks back along −x
    expect(n[6]).toBeCloseTo(-1, 5); expect(n[8]).toBeCloseTo(0, 5);
  });

  it('a rigid-flex-rigid board: the locked rigid part stays, the flex bends, the far rigid part turns whole (whichever side of the line\'s extension it is on)', () => {
    const A = rect(0, 0, mm(10), mm(10)), F = rect(mm(10), 0, mm(14), mm(10)), B = rect(mm(14), 0, mm(30), mm(10));
    const line = { a: { x: mm(12), y: 0 }, b: { x: mm(12), y: mm(10) }, angle: 90, radius: mm(1), foldIndex: 1 };
    const regs = [
      { name: 'A', stackId: '', locked3d: true, bends: [], outline: A, index: 0 },
      { name: 'F', stackId: '', locked3d: false, bends: [line], outline: F, index: 1 },
      { name: 'B', stackId: '', locked3d: false, bends: [], outline: B, index: 2 },
    ];
    const f = foldOf(regs, (p) => ({ x: p.x / mm(1), y: p.y / mm(1) }), () => 0, mm(1))!;
    expect([...f.bends[0]!.moving]).toEqual([2]);
    // A point of A, of F before its strip, of B: tagged by region
    const p = new Float32Array([5, 5, 0, 10.2, 5, 0, 20, 5, 0]);
    foldPoints(f, 1, p, undefined, new Int32Array([0, 1, 2]));
    expect([p[0], p[2]]).toEqual([5, 0]);
    expect(p[5]).toBeCloseTo(0, 6);
    expect(p[8]).toBeGreaterThan(5);
    // Locked on the other side: B stays, A turns
    regs[0]!.locked3d = false; regs[2]!.locked3d = true;
    const g = foldOf(regs, (q) => ({ x: q.x / mm(1), y: q.y / mm(1) }), () => 0, mm(1))!;
    expect([...g.bends[0]!.moving]).toEqual([0]);
  });
});

describe('rigid-flex: 3D faces', () => {
  it('a region on a stack without a side\'s solder mask shows bare on that side (its overlay kept only if the stack has it)', async () => {
    const { bareRegions } = await import('../src/render/gl3d/boardTexture');
    const doc = board();
    const subs = readSubstacks(doc.board.bag);
    const flex = { ...subs[0]!, id: '{11111111-2222-4333-8444-555555555556}', name: 'Flex', isFlex: true, usedByPrims: false };
    const rows = readStack(doc.board.bag!, doc.board.copperStack);
    setStack(doc, rows.map((r) => ({ ...r, subs: { ...r.subs, [flex.id]: r.kind === 'dielectric' || r.name === 'Top Layer' || r.name === 'Top Overlay' } })), undefined, [subs[0]!, flex]).apply();
    expect(bareRegions(doc, 'top')).toEqual([]);   // no regions yet
    setRigidFlex(doc, addSplit(doc, { x: mil(1000), y: 0 }, { x: mil(1000), y: mil(1000) })!).apply();
    setRigidFlex(doc, addSplit(doc, { x: mil(2000), y: 0 }, { x: mil(2000), y: mil(1000) })!).apply();
    const middle = boardRegions(doc).findIndex((r) => r.outline.every((p) => p.x >= mil(1000) - 1 && p.x <= mil(2000) + 1));
    expect(bareRegions(doc, 'top')).toEqual([]);   // all on the board's stack
    setRigidFlex(doc, withRegion(doc, middle, { stackId: flex.id })).apply();
    for (const side of ['top', 'bottom'] as const) {
      const bare = bareRegions(doc, side);
      expect(bare.length).toBe(1);
      expect(area(bare[0]!.outline)).toBeCloseTo(mil(1000) * mil(1000), -6);
      expect(bare[0]!.silk).toBe(side === 'top');
    }
  });
});
