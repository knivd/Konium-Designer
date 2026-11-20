/**
 * 26.199: single layer mode (Shift+S) in the 3D view. The layer in front is shown alone: on the
 * face it belongs to (the top for the top side's layers and anything without a side, the bottom
 * for the bottom side's), or, for a copper layer inside the board, on a plane of its own at its
 * depth; the board is seen through and the components' bodies are left out.
 */
import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { buildBoardModel } from '../src/render/gl3d/boardModel';
import { singleFace } from '../src/render/gl3d/boardTexture';
import { L } from '../src/model/layers';

describe('single layer mode in the 3D view (26.199)', () => {
  it('each layer has its face: the top side\'s on the top, the bottom side\'s on the bottom, inner copper inside', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(singleFace(doc, L.TOP)).toBe('top');
    expect(singleFace(doc, L.TOP_OVERLAY)).toBe('top');
    expect(singleFace(doc, L.BOTTOM)).toBe('bottom');
    expect(singleFace(doc, L.BOTTOM_OVERLAY)).toBe('bottom');
    expect(singleFace(doc, L.BOTTOM_SOLDER)).toBe('bottom');
    expect(singleFace(doc, L.BOTTOM_PASTE)).toBe('bottom');
    // A mechanical layer has no side: it is drawn on the top
    expect(singleFace(doc, L.MECH1)).toBe('top');
    // An inner copper layer counts as inside only when the board's stack has it
    const inner = L.MID1;
    expect(doc.board.copperStack.includes(inner)).toBe(false);
    expect(singleFace(doc, inner)).toBe('top');
    doc.board.copperStack = [L.TOP, inner, L.BOTTOM];
    expect(singleFace(doc, inner)).toBe('inner');
  });

  it('the model in single layer mode: no bodies, and a plane for an inner layer at its depth', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const whole = buildBoardModel(doc);
    expect(whole.bodies.length).toBeGreaterThan(0);
    expect(whole.meshes.filter((m) => m.texture).map((m) => m.texture)).toEqual(['top', 'bottom']);

    const alone = buildBoardModel(doc, { noBodies: true });
    expect(alone.bodies).toEqual([]);
    expect(alone.meshes.filter((m) => m.texture).map((m) => m.texture)).toEqual(['top', 'bottom']);

    // A layer a third of the way down from the top: its plane is at that height, the board's own shape
    const inside = buildBoardModel(doc, { noBodies: true, inner: 2 / 3 });
    expect(inside.meshes.filter((m) => m.texture).map((m) => m.texture)).toEqual(['top', 'bottom', 'single']);
    const [top, bottom, plane] = inside.meshes.filter((m) => m.texture);
    const zs = (m: typeof top) => [...new Set([...m!.pos].filter((_, i) => i % 3 === 2).map((z) => Math.round(z * 1000) / 1000))];
    const zTop = zs(top)[0]!, zBottom = zs(bottom)[0]!;
    expect(zs(plane)).toEqual([Math.round((zBottom + (zTop - zBottom) * (2 / 3)) * 1000) / 1000]);
    expect(plane!.pos.length).toBe(top!.pos.length);
    expect(plane!.idx.length).toBe(top!.idx.length);
  });
});
