import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeBody } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PropertyBag } from '../src/formats/altium/props';
import { UndoStack } from '../src/core/undo';
import { mm, UNITS_PER_MM } from '../src/core/units';
import { L } from '../src/model/layers';
import { addPrimRecords } from '../src/model/pcbEdit';
import type { PcbBody } from '../src/model/pcb';
import type { StepModel, V3 } from '../src/formats/step/tessellate';
import { bodyTransform, stepBodies } from '../src/render/gl3d/stepBodies';
import { anglesOf, bodyBag, editBodyRecord, footprintOf, hull, placeBody, placementOf, placePoint, rotationBetween, rotationOf, setSnapPoints, snapPoints, turned } from '../src/model/body3d';
import { stackupChecks, stackupReport } from '../src/model/stackupReport';

const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);
const apply = (m: V3[], v: V3): V3 => [m[0]![0] * v[0] + m[1]![0] * v[1] + m[2]![0] * v[2], m[0]![1] * v[0] + m[1]![1] * v[1] + m[2]![1] * v[2], m[0]![2] * v[0] + m[1]![2] * v[1] + m[2]![2] * v[2]];

/** A 2 × 1 × 0.5 mm box model, its corner at the origin. */
const box: StepModel = (() => {
  const v: V3[] = [];
  for (const x of [0, 2]) for (const y of [0, 1]) for (const z of [0, 0.5]) v.push([x, y, z]);
  return { meshes: [{ colour: [1, 1, 1, 1], pos: new Float32Array(v.flat()), nrm: new Float32Array(v.length * 3), idx: new Uint32Array([0, 1, 2]) }], min: [0, 0, 0], max: [2, 1, 0.5], faces: 6, failed: 0 };
})();

function withStepBody() {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const at = { x: doc.board.origin.x + mm(10), y: doc.board.origin.y + mm(10) };
  const rec = encodeBody({ component: 0xffff, outline: [at, { x: at.x + mm(2), y: at.y }, { x: at.x + mm(2), y: at.y + mm(1) }, { x: at.x, y: at.y + mm(1) }], standoff: 0, overall: mm(0.5), colour: 0x808080, layer: L.MECH1, at, id: '{BOX}', modelType: 1 });
  new UndoStack().transact('body', (t) => t.add(addPrimRecords(doc, [{ storage: 'ComponentBodies6', rec }])));
  const b = doc.prims.filter((p): p is PcbBody => p.kind === 'body').at(-1)!;
  return { doc, b };
}

describe('3D body placement', () => {
  it('angles and rotations go both ways (X, then Y, then Z)', () => {
    for (const r of [[0, 0, 0], [90, 0, 0], [30, 40, 50], [270, 10, 180], [0, 90, 0]] as V3[]) {
      const back = anglesOf(rotationOf(...r));
      expect(close(rotationOf(...back).flat(), rotationOf(...r).flat(), 1e-6)).toBe(true);
    }
    const m = rotationBetween([1, 0, 0], [0, 0, -1]);
    expect(close(apply(m, [1, 0, 0]), [0, 0, -1])).toBe(true);
    expect(close(apply(rotationBetween([0, 0, 1], [0, 0, -1]), [0, 0, 1]), [0, 0, -1])).toBe(true);
  });
  it('a model point lands where the 3D view puts it, top and bottom', () => {
    for (const bottom of [false, true]) {
      const pl = { rot: [10, 20, 30] as V3, dz: 0.3, at: { x: 1_000_000, y: 2_000_000 }, bottom };
      const centre = { x: 0, y: 0 }, t = 1.6;
      const xf = bodyTransform({ component: 0, modelId: '', name: '', at: pl.at, rot: pl.rot, dz: pl.dz, bottom, standoff: 0, overall: 0, outline: [], opacity: 1 }, box, centre, t);
      const p: V3 = [1.5, 0.25, 0.4];
      const v = [xf.o[0] + xf.x[0] * p[0] + xf.y[0] * p[1] + xf.z[0] * p[2], xf.o[1] + xf.x[1] * p[0] + xf.y[1] * p[1] + xf.z[1] * p[2], xf.o[2] + xf.x[2] * p[0] + xf.y[2] * p[1] + xf.z[2] * p[2]];
      const q = placePoint(pl, p);
      expect(close([q.x / UNITS_PER_MM, q.y / UNITS_PER_MM], [v[0]!, v[1]!], 1e-6)).toBe(true);
      expect(q.z).toBeCloseTo(bottom ? -v[2]! : v[2]! - t, 6);
    }
  });
  it('snap points are kept on the body in the model\'s axes', () => {
    const bag = new PropertyBag();
    setSnapPoints(bag, [[1, 2, 3], [0.5, 0, -0.25]]);
    expect(bag.get('MODEL.SNAPCOUNT')).toBe('2');
    expect(snapPoints(bag).map((p) => p.map((x) => +x.toFixed(4)))).toEqual([[1, 2, 3], [0.5, 0, -0.25]]);
    setSnapPoints(bag, []);
    expect(bag.get('MODEL.SNAPCOUNT')).toBe('0');
    expect(bag.has('MODEL.SNAP0X')).toBe(false);
  });
  it('a body record takes new properties and a new outline; STEP bodies read their snap points', () => {
    const { doc, b } = withStepBody();
    const u = new UndoStack();
    u.transact('snap', (t) => t.add(editBodyRecord(doc, b, (bag) => setSnapPoints(bag, [[2, 1, 0.5]]), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])!));
    const b2 = doc.prims.filter((p): p is PcbBody => p.kind === 'body').at(-1)!;
    expect(b2.outline).toHaveLength(3);
    expect(snapPoints(bodyBag(doc, b2)!)).toHaveLength(1);
    expect(stepBodies(doc).at(-1)!.snaps!.map((p) => +p[0].toFixed(3))).toEqual([2]);
    u.undo();
    expect(doc.prims.filter((p): p is PcbBody => p.kind === 'body').at(-1)!.outline).toHaveLength(4);
  });
  it('placing a model works out its outline, standoff and height; a face turned onto the board', () => {
    const { doc, b } = withStepBody();
    const pl = placementOf(bodyBag(doc, b)!);
    // Stood on its 1 × 0.5 end: X turned so +x points down
    const up = turned(pl, rotationBetween([1, 0, 0], [0, 0, -1]));
    const f = footprintOf({ ...up, dz: 0 }, box);
    expect(f.zMax - f.zMin).toBeCloseTo(2, 6);
    const placed = { ...up, dz: -f.zMin };
    new UndoStack().transact('place', (t) => t.add(placeBody(doc, b, box, placed)!));
    const after = doc.prims.filter((p): p is PcbBody => p.kind === 'body').at(-1)!;
    expect(after.standoff).toBe(0);
    expect(after.overall).toBe(Math.round(2 * UNITS_PER_MM));
    // Seen from above it is 1 × 0.5 mm now
    const xs = after.outline.map((p) => p.x), ys = after.outline.map((p) => p.y);
    expect([(Math.max(...xs) - Math.min(...xs)) / UNITS_PER_MM, (Math.max(...ys) - Math.min(...ys)) / UNITS_PER_MM].sort().map((v) => +v.toFixed(3))).toEqual([0.5, 1]);
    const bag = bodyBag(doc, after)!;
    expect(rotationOf(bag.float('MODEL.3D.ROTX'), bag.float('MODEL.3D.ROTY'), bag.float('MODEL.3D.ROTZ')).flat().map((v) => +v.toFixed(6))).toEqual(rotationOf(...up.rot).flat().map((v) => +v.toFixed(6)));
  });
  it('hull: the outline around points', () => {
    expect(hull([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 2 }])).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]);
  });
});

describe('Stackup Compatibility Report', () => {
  it('lists the stack and checks it', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const r = stackupChecks(doc);
    expect(r.rows.some((x) => x.kind === 'signal')).toBe(true);
    expect(r.checks.find((c) => c.text.includes('copper layers'))?.level).toBe('ok');
    expect(r.checks.some((c) => c.text === 'Every object lies on a layer of the stack')).toBe(true);
    const text = stackupReport(doc);
    expect(text).toMatch(/^Stackup Compatibility Report for Demo\.PcbDoc/);
    expect(text).toMatch(/Top Layer\s+Signal\s+Copper\s+0\.0\d+/);
    expect(text).toMatch(/Total thickness \(copper to copper\): [\d.]+ mm/);
  });
});
