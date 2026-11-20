import { describe, expect, it } from 'vitest';
import { isStl, readStl, stlBytesToStep, stlToStep, writeStl } from '../src/formats/stl';
import { parseStep } from '../src/formats/step/parse';
import { tessellateStep } from '../src/formats/step/tessellate';
import { exportStep } from '../src/formats/step/write';
import { readStepDoc } from '../src/model/stepDoc';
import { load } from '../src/formats/registry';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';

/** A unit cube's twelve triangles (outward, anticlockwise). */
const cube = (): { pos: number[]; idx: number[] } => {
  const pos = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { pos, idx };
};

describe('STL', () => {
  it('binary: written, recognised and read back, normals out of the corners', () => {
    const b = writeStl('cube', [cube()]);
    expect(b.length).toBe(84 + 12 * 50);
    expect(String.fromCharCode(...b.subarray(0, 5))).not.toBe('solid');
    expect(isStl(b, 'x.bin')).toBe(true);
    const m = readStl(b, 'cube.stl');
    expect(m.tris.length).toBe(12 * 9);
    // The first triangle's normal points down (z = 0 face)
    expect(new DataView(b.buffer).getFloat32(84 + 8, true)).toBeCloseTo(-1);
  });
  it('ASCII: read; triangles with no area left out', () => {
    const text = `solid part\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 2 0 0\n  endloop\n endfacet\nendsolid part\n`;
    const m = readStl(new TextEncoder().encode(text), 'p.stl');
    expect(m.name).toBe('part');
    expect(m.tris.length).toBe(9);
  });
  it('as a STEP model: a faceted solid Konium reads back, triangle for triangle', () => {
    const m = readStl(writeStl('cube', [cube()]), 'cube.stl');
    const step = stlToStep(m);
    expect(step).toMatch(/FACETED_BREP\('cube'/);
    // Eight corners written once each (the origin is one of them)
    expect(step.match(/CARTESIAN_POINT/g)!.length).toBe(8);
    const t = tessellateStep(parseStep(step));
    expect(t.faces).toBe(12);
    expect(t.meshes.reduce((s, x) => s + x.idx.length / 3, 0)).toBe(12);
    expect(t.max).toEqual([1, 1, 1]);
  });
  it('opens in the 3D model editor as a new (unsaved) STEP model', () => {
    const bytes = writeStl('cube', [cube()]);
    const d = readStepDoc(bytes, 'cube.stl');
    expect(d.name).toBe('cube.step');
    expect(d.dirty).toBe(true);
    expect(d.original).toBeNull();
    expect(load(bytes, 'cube.stl').kind).toBe('StepDoc');
    expect(stlBytesToStep(bytes, 'cube.stl').triangles).toBe(12);
  });
  it('a board as STL: the STEP export\'s assembly as triangles', async () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const t = tessellateStep(parseStep(await exportStep(doc)));
    const stl = writeStl('Demo', t.meshes);
    const back = readStl(stl, 'Demo.stl');
    expect(back.tris.length / 9).toBeGreaterThan(100);
    // From the board's origin, the board's thickness tall
    const zs = Array.from(back.tris.filter((_, i) => i % 3 === 2));
    expect(Math.min(...zs)).toBeCloseTo(0, 1);
  });
});

import { ipc2581 } from '../src/formats/ipc2581';
import { convertIpc2581 } from '../src/formats/ipc2581read';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { OTHER_TOOL_EXTS } from '../src/platform/fs';
import { connections } from '../src/model/drc';

describe('IPC-2581 import', () => {
  const src = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const xml = ipc2581(src);
  const r = convertIpc2581(xml, 'Demo.xml');
  const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
  const count = (d: typeof doc, k: string) => d.prims.filter((p) => p.kind === k).length;
  it('Konium\'s own IPC-2581 back: components, pads, vias, nets, copper', () => {
    expect(doc.components.map((c) => c.designator).sort()).toEqual(src.components.map((c) => c.designator).sort());
    expect(count(doc, 'pad')).toBe(count(src, 'pad'));
    expect(count(doc, 'via')).toBe(count(src, 'via'));
    expect(new Set(doc.nets.map((n) => n.name))).toEqual(new Set(src.nets.filter((n) => src.prims.some((p) => 'net' in p && p.net === n.index && p.kind === 'pad')).map((n) => n.name)));
    expect(connections(doc).length).toBe(connections(src).length);
    // Through-hole pads keep their holes and the components their side
    const holes = (d: typeof doc) => d.prims.filter((p) => p.kind === 'pad' && p.hole > 0).length;
    expect(holes(doc)).toBe(holes(src));
    expect(r.footprints.length).toBeGreaterThan(0);
  });
  it('the board shape and the stack come back', () => {
    expect(doc.board.copperStack.length).toBe(src.board.copperStack.length);
    const w = (d: typeof doc) => Math.max(...d.board.outline.map((p) => p.x)) - Math.min(...d.board.outline.map((p) => p.x));
    expect(Math.abs(w(doc) - w(src))).toBeLessThan(100);
  });
  it('the importers take their files: by extension, an .xml by its first element', () => {
    const enc = new TextEncoder();
    expect(importerFor('a.xml', enc.encode(xml))?.id).toBe('ipc2581');
    expect(importerFor('a.xml', enc.encode('<?xml version="1.0"?><foo/>'))).toBeUndefined();
    expect(importerFor('b.kicad_pcb', enc.encode('(kicad_pcb)'))?.id).toBe('kicad');
    for (const e of IMPORTERS.flatMap((i) => i.exts)) expect(OTHER_TOOL_EXTS).toContain(e);
  });
});
