import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { boardThickness, bodyMesh, buildBoardModel, colorRef } from '../src/render/gl3d/boardModel';
import { PropertyBag } from '../src/formats/altium/props';

describe('3D Layout Mode model', () => {
  it('builds the demo board: faces, edges, barrels and the parts’ 3D bodies', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const m = buildBoardModel(doc);
    expect(m.thickness).toBeCloseTo(1.6, 2);
    expect(m.meshes.filter((x) => x.texture).map((x) => x.texture)).toEqual(['top', 'bottom']);
    // the board is 40 × 25 mm, centred on the origin
    const top = m.meshes[0]!;
    const xs = [...top.pos].filter((_, i) => i % 3 === 0), ys = [...top.pos].filter((_, i) => i % 3 === 1);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v * 100) / 100)).toEqual([-20, 20, -12.5, 12.5]);
    expect(m.bodies).toHaveLength(14);
    const j1 = m.bodies.filter((b) => b.component === 0);
    expect(j1.map((b) => [b.z0, b.z1].map((z) => Math.round(z * 100) / 100))).toEqual([[1.6, 4.1], [4.1, 10.1], [4.1, 10.1]]);
    const mesh = bodyMesh(m.bodies[0]!);
    expect(mesh.idx.length).toBe(4 * 6 + 2 * 2 * 3); // four walls, two caps
  });

  it('reads the layer stack thickness and Altium colours', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const b = doc.board.bag!;
    b.set('V9_STACK_LAYER2_DIELTYPE', '3'); b.set('V9_STACK_LAYER2_DIELHEIGHT', '0.5mil');
    b.set('V9_STACK_LAYER3_COPTHICK', '1.4mil'); b.set('V9_STACK_LAYER4_DIELTYPE', '1'); b.set('V9_STACK_LAYER4_DIELHEIGHT', '58.2mil'); b.set('V9_STACK_LAYER5_COPTHICK', '1.4mil');
    expect(Math.round(boardThickness(doc) * 1000) / 1000).toBe(1.549);
    expect(colorRef(0x2010ff)).toEqual([1, 16 / 255, 32 / 255, 1]);
    void PropertyBag;
  });
});
