import { describe, expect, it } from 'vitest';
import { detect, load, save } from '../src/formats/registry';
import { editParts, extent, primitivePart, readStepDoc, redoStep, shift, andThen, turn, undoStep, writeStepDoc, type StepDocument } from '../src/model/stepDoc';
import { primitiveStep, recolour } from '../src/formats/step/write';
import { parseStep } from '../src/formats/step/parse';
import { tessellateStep } from '../src/formats/step/tessellate';

const bytes = (s: string) => new TextEncoder().encode(s);
const box = primitiveStep({ kind: 'box', w: 10, d: 6, h: 2 }, 'Body', [0.2, 0.2, 0.2, 1], new Date(0));
const read = (b: Uint8Array) => tessellateStep(parseStep(new TextDecoder('latin1').decode(b)));

describe('3D model editor: STEP documents', () => {
  it('a .step or .stp file (or any ISO 10303-21 text) opens as a 3D model; unchanged, it saves as it was', () => {
    expect(detect(bytes(box), 'body.step')).toBe('StepDoc');
    expect(detect(bytes(box), 'BODY.STP')).toBe('StepDoc');
    expect(detect(bytes(box), 'body.txt')).toBe('StepDoc');
    const doc = load(bytes(box), 'Body.step') as StepDocument;
    expect(doc.kind).toBe('StepDoc');
    expect(doc.parts.map((p) => p.name)).toEqual(['Body']);
    expect(save(doc)).toBe(doc.original);
  });

  it('exact boxes and cylinders: Konium\'s reader gets their faces and sizes back', () => {
    const b = tessellateStep(parseStep(box));
    expect([b.faces, b.failed]).toEqual([6, 0]);
    expect([...b.min, ...b.max]).toEqual([-5, -3, 0, 5, 3, 2]);
    const c = tessellateStep(parseStep(primitiveStep({ kind: 'cylinder', r: 0.5, h: 3 }, 'Pin', [0.8, 0.8, 0.8, 1])));
    expect([c.faces, c.failed]).toEqual([3, 0]);
    expect(c.max[2]).toBeCloseTo(3, 6); expect(c.max[0]).toBeCloseTo(0.5, 3);
  });

  it('turned, moved, a part added, recoloured: saved as an assembly that reads back as placed', () => {
    const doc = readStepDoc(bytes(box), 'Body.step');
    // Stood on its end (90° about X), then up 1 mm
    editParts(doc, 'Turn', doc.parts.map((p) => ({ ...p, xf: andThen(andThen(p.xf, turn('x', 90)), shift([0, 0, 1])) })));
    editParts(doc, 'Add pin', [...doc.parts, primitivePart({ kind: 'cylinder', r: 0.5, h: 3 }, [0.8, 0.8, 0.8, 1], 'Pin1', shift([8, 0, 0]))]);
    editParts(doc, 'Colour', doc.parts.map((p, i) => (i === 0 ? { ...p, colour: [0.9, 0.1, 0.1, 1] } : p)));
    const out = writeStepDoc(doc, new Date(0));
    expect(out).not.toBe(doc.original);
    const m = read(out);
    expect(m.failed).toBe(0);
    // The box now 10 × 2 (its height along −Y) × 6 tall, from z 1; the pin at x 8
    expect(m.min.map((v) => Math.round(v * 1000) / 1000)).toEqual([-5, -2, -2]);
    expect(m.max.map((v) => Math.round(v * 1000) / 1000)).toEqual([8.5, 0.5, 4]);
    expect(m.meshes.some((x) => x.colour[0] > 0.85 && x.colour[1] < 0.15)).toBe(true);
    const e = extent(doc.parts.map((p) => ({ xf: p.xf, min: [-5, -3, 0] as [number, number, number], max: [5, 3, 2] as [number, number, number] })))!;
    expect(e.min[2]).toBe(-2);
  });

  it('undo and redo whole steps; a colour of its own replaces every colour the model names', () => {
    const doc = readStepDoc(bytes(box), 'Body.step');
    editParts(doc, 'Move', doc.parts.map((p) => ({ ...p, xf: shift([1, 2, 3]) })));
    expect(doc.dirty).toBe(true);
    expect(undoStep(doc)).toBe('Move');
    expect(doc.parts[0]!.xf.o).toEqual([0, 0, 0]);
    expect(writeStepDoc(doc)).toBe(doc.original);
    expect(redoStep(doc)).toBe('Move');
    expect(doc.parts[0]!.xf.o).toEqual([1, 2, 3]);
    const t = recolour("#5=COLOUR_RGB('',0.2,0.2,0.2);#6=DRAUGHTING_PRE_DEFINED_COLOUR('red');", [1, 0.5, 0, 1]);
    expect(t).toBe("#5=COLOUR_RGB('',1.,0.5,0.);#6=COLOUR_RGB('',1.,0.5,0.);");
  });
});
