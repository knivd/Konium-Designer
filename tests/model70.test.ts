/** 26.070: the 3D model editor's modelling — filleted and chamfered boxes and cylinders, cones, domes (exact B-rep) — and Split (an assembly into its parts). */
import { describe, expect, it } from 'vitest';
import { primitiveStep, exportAssembly, type Primitive } from '../src/formats/step/write';
import { parseStep } from '../src/formats/step/parse';
import { apply, tessellateStep, type RGBA, type StepModel, type Xf } from '../src/formats/step/tessellate';
import { andThen, primitivePart, shift, splitPart, turn, writeStepDoc, type StepPart } from '../src/model/stepDoc';

const grey: RGBA = [0.5, 0.5, 0.5, 1];
const model = (text: string) => tessellateStep(parseStep(text));
/** The mesh's volume (its triangles' signed tetrahedra) and the share of its normals pointing away from the middle. */
function measure(m: StepModel) {
  const c = [0, 1, 2].map((k) => (m.min[k]! + m.max[k]!) / 2);
  let vol = 0, out = 0, all = 0;
  for (const s of m.meshes) {
    const P = s.pos;
    for (let i = 0; i < P.length; i += 3) { all++; if ((P[i]! - c[0]!) * s.nrm[i]! + (P[i + 1]! - c[1]!) * s.nrm[i + 1]! + (P[i + 2]! - c[2]!) * s.nrm[i + 2]! > -1e-6) out++; }
    for (let t = 0; t < s.idx.length; t += 3) {
      const a = s.idx[t]! * 3, b = s.idx[t + 1]! * 3, q = s.idx[t + 2]! * 3;
      vol += (P[a]! * (P[b + 1]! * P[q + 2]! - P[b + 2]! * P[q + 1]!) - P[a + 1]! * (P[b]! * P[q + 2]! - P[b + 2]! * P[q]!) + P[a + 2]! * (P[b]! * P[q + 1]! - P[b + 1]! * P[q]!)) / 6;
    }
  }
  return { vol, outward: out / all };
}
/** Where a part's model lies once placed. */
function placed(p: StepPart) {
  const m = model(p.text);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [m.min[0], m.max[0]]) for (const y of [m.min[1], m.max[1]]) for (const z of [m.min[2], m.max[2]]) {
    const q = apply(p.xf, [x, y, z]);
    lo = lo.map((v, k) => Math.min(v, q[k]!)); hi = hi.map((v, k) => Math.max(v, q[k]!));
  }
  return [...lo, ...hi].map((v) => Math.round(v * 1000) / 1000);
}

describe('modelling (exact B-rep)', () => {
  const PI = Math.PI;
  const cases: [string, Primitive, number, number][] = [
    ['box, corners filleted', { kind: 'box', w: 5, d: 3, h: 2, corner: 0.5 }, 10, 2 * (15 - (4 - PI) * 0.25)],
    ['box, corners chamfered', { kind: 'box', w: 5, d: 3, h: 2, corner: 0.5, corners: 'chamfer' }, 10, 29],
    ['box, ends rounded right round', { kind: 'box', w: 5, d: 3, h: 2, corner: 1.5 }, 8, 2 * (6 + PI * 2.25)],
    ['cylinder, top rim filleted', { kind: 'cylinder', r: 1, h: 3, edge: 0.3 }, 4, PI * 3 - 0.09 * (1 - PI / 4) * 2 * PI * (0.7 + (0.3 * 2) / (3 * (4 - PI)))],
    ['cylinder, both rims chamfered', { kind: 'cylinder', r: 1, h: 3, edge: 0.3, edges: 'chamfer', rims: 'both' }, 5, PI * 3 - 2 * (PI * 0.045 * (2 - 0.2))],
    ['frustum', { kind: 'cone', r1: 1, r2: 0.5, h: 2 }, 3, (PI * 2 / 3) * (1 + 0.5 + 0.25)],
    ['cone to a point', { kind: 'cone', r1: 1, r2: 0, h: 2 }, 2, (PI * 2) / 3],
    ['dome', { kind: 'dome', r: 1.5 }, 2, (2 / 3) * PI * 1.5 ** 3],
  ];
  for (const [what, p, faces, vol] of cases) {
    it(`${what}: its faces, all read, facing out, its volume`, () => {
      const text = primitiveStep(p, 'X', grey, new Date(0));
      const m = model(text);
      expect([m.faces, m.failed]).toEqual([faces, 0]);
      const r = measure(m);
      expect(r.outward).toBe(1);
      // Triangles a little inside the true curves: within 4 %
      expect(Math.abs(r.vol - vol) / vol).toBeLessThan(0.04);
      if (p.kind !== 'box') expect(text).toMatch(p.kind === 'dome' ? /SPHERICAL_SURFACE/ : p.kind === 'cone' ? /CONICAL_SURFACE/ : p.edges === 'chamfer' ? /CONICAL_SURFACE/ : /TOROIDAL_SURFACE/);
      else expect(text).toMatch(p.corners === 'chamfer' ? /PLANE/ : /CYLINDRICAL_SURFACE/);
    });
  }
  it('a box and cylinder without rounding are written as before', () => {
    expect(model(primitiveStep({ kind: 'box', w: 1, d: 1, h: 1 }, 'B', grey, new Date(0))).faces).toBe(6);
    expect(model(primitiveStep({ kind: 'cylinder', r: 1, h: 1, edge: 0 }, 'C', grey, new Date(0))).faces).toBe(3);
  });
});

describe('Split', () => {
  const box = primitivePart({ kind: 'box', w: 4, d: 2, h: 1, corner: 0.3 }, [0.2, 0.2, 0.2, 1], 'Body');
  const pin: StepPart = { ...primitivePart({ kind: 'cylinder', r: 0.3, h: 2, edge: 0.1 }, [0.9, 0.8, 0.3, 1], 'Pin'), xf: shift([1.5, 0, 1]) };
  const dome = { ...primitivePart({ kind: 'dome', r: 0.8 }, [0.9, 0.1, 0.1, 1], 'Lens'), xf: andThen(turn('x', 90), shift([-1, 0.5, 1])) };
  const asText = (name: string, parts: StepPart[]) => exportAssembly(name, parts.map((p) => ({ name: p.name, text: p.text, xf: p.xf, colour: p.colour })), new Date(0));

  it('an assembly: a part for each solid, where the assembly places it, named and coloured as it was', () => {
    const asm: StepPart = { id: 'a', name: 'LED', text: asText('LED', [box, pin, dome]), xf: shift([10, 0, 0]), colour: null, hidden: false };
    const parts = splitPart(asm)!;
    expect(parts.map((p) => p.name)).toEqual(['Body', 'Pin', 'Lens']);
    const moved = (p: StepPart): StepPart => ({ ...p, xf: andThen(p.xf, shift([10, 0, 0])) });
    expect(parts.map(placed)).toEqual([box, pin, dome].map(moved).map(placed));
    // Each its own file, its colour carried (the pin's gold), every face read
    for (const p of parts) expect(model(p.text).failed).toBe(0);
    expect(model(parts[1]!.text).meshes[0]!.colour.slice(0, 3).map((v) => Math.round(v * 10) / 10)).toEqual([0.9, 0.8, 0.3]);
    // Saved again: an assembly of the three
    const doc = { kind: 'StepDoc' as const, name: 'LED.step', parts, dirty: true, original: null, undo: [], redo: [] };
    const again = model(new TextDecoder('latin1').decode(writeStepDoc(doc)));
    expect(again.faces).toBe(parts.reduce((t, p) => t + model(p.text).faces, 0));
  });

  it('an assembly in an assembly: every solid at its place; the same solid twice, numbered', () => {
    const inner: StepPart = { id: 'i', name: 'Pins', text: asText('Pins', [pin, { ...pin, xf: shift([-1.5, 0, 1]) }]), xf: shift([0, 0, 0.5]), colour: null, hidden: false };
    const outer: StepPart = { id: 'o', name: 'Top', text: asText('Top', [box, inner]), xf: turn('z', 90) as Xf, colour: null, hidden: false };
    const parts = splitPart(outer)!;
    expect(parts.map((p) => p.name)).toEqual(['Body', 'Pin', 'Pin (2)']);
    const turned = (p: StepPart): StepPart => ({ ...p, xf: andThen(p.xf, turn('z', 90)) });
    expect(parts.map(placed)).toEqual([box, { ...pin, xf: andThen(pin.xf, shift([0, 0, 0.5])) }, { ...pin, xf: shift([-1.5, 0, 1.5]) }].map(turned).map(placed));
  });

  it('one solid: nothing to split', () => {
    expect(splitPart(box)).toBeNull();
  });
});
