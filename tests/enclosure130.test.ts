import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOKS, DEFAULT_SCENE, defaultSpec, normaliseSpec, type BoardFacts, type EnclosureSpec, type Label } from '../src/model/enclosure';
import { buildEnclosure, printPlate } from '../src/model/enclosureSolid';
import { write3mf } from '../src/formats/threeMf';
import { envGradient, finishMaterial, lightUniforms } from '../src/render/gl3d/studio';
import { manifold } from '../src/platform/manifold';

/** A 50 × 30 mm board, four M3 holes 3.5 mm in, a 6 mm part on top. */
const BOARD: BoardFacts = {
  w: 50, h: 30, thickness: 1.6, top: 6, bottom: 0,
  holes: [[-21.5, -11.5], [21.5, -11.5], [21.5, 11.5], [-21.5, 11.5]].map(([x, y]) => ({ x: x!, y: y!, d: 3.2 })),
  parts: [{ name: 'U1', x0: -5, y0: -5, x1: 5, y1: 5, z1: 6 }],
};
const spec = (patch: Partial<EnclosureSpec> = {}): EnclosureSpec => ({ ...defaultSpec('B.PcbDoc'), ...patch });
const label = (p: Partial<Label>): Label => ({ text: 'AB', face: 'top', x: 0, y: 0, size: 6, depth: 0.8, raised: false, on: true, ...p });

describe('Enclosure designer: colours, finishes and the studio (26.130)', () => {
  it('keeps each part\'s colour and finish, text\'s own colour, and the scene; anything else falls back', () => {
    const s = normaliseSpec({ board: 'B.PcbDoc', looks: { base: { colour: '#AABBCC', finish: 'gloss' }, top: { colour: 'red', finish: 'shiny' } } as never,
      labels: [label({ colour: '#FF8800' }), label({ colour: 'orange' })], scene: { env: '#102030', azimuth: 400, elevation: -5, key: 3, ambient: 0.5, background: 'flat', shadow: false } as never });
    expect(s.looks.base).toEqual({ colour: '#aabbcc', finish: 'gloss' });
    expect(s.looks.top).toEqual(DEFAULT_LOOKS.top);
    expect(s.looks.gasket).toEqual(DEFAULT_LOOKS.gasket);
    expect(s.labels.map((l) => l.colour)).toEqual(['#ff8800', undefined]);
    expect(s.scene).toEqual({ env: '#102030', background: 'flat', azimuth: 180, elevation: 2, key: 2, ambient: 0.5, shadow: false });
    expect(normaliseSpec({ board: 'B' }).scene).toEqual(DEFAULT_SCENE);
  });

  it('text in its own colour is a part of its own: raised, what stands out; cut in, the cut filled flush', async () => {
    const M = await manifold();
    const plain = buildEnclosure(M, spec(), BOARD);
    const raised = buildEnclosure(M, spec({ labels: [label({ raised: true })] }), BOARD);
    const own = buildEnclosure(M, spec({ labels: [label({ raised: true, colour: '#f26b1d' })] }), BOARD);
    // The raised text left out of the top, and kept as an inlay of the top in its colour
    expect(own.inlays).toHaveLength(1);
    expect(own.inlays[0]).toMatchObject({ name: 'AB', on: 'top', colour: '#f26b1d', raised: true });
    expect(own.top.volume).toBeCloseTo(plain.top.volume, 1);
    expect(own.inlays[0]!.mesh.volume).toBeCloseTo(raised.top.volume - plain.top.volume, 0);
    // Cut in: the cut is made as before, and what it took out is the inlay
    const cut = buildEnclosure(M, spec({ labels: [label({})] }), BOARD);
    const fill = buildEnclosure(M, spec({ labels: [label({ colour: '#1d1e20' })] }), BOARD);
    expect(fill.top.volume).toBeCloseTo(cut.top.volume, 1);
    expect(fill.inlays[0]!.raised).toBe(false);
    expect(fill.inlays[0]!.mesh.volume).toBeCloseTo(plain.top.volume - cut.top.volume, 1);
    // Through: no colour (it is a hole)
    expect(buildEnclosure(M, spec({ labels: [label({ through: true, colour: '#1d1e20' })] }), BOARD).inlays).toHaveLength(0);
  });

  it('text on a wall across the joint is in both parts; on the print plate each goes with its part', async () => {
    const M = await manifold();
    const s = spec({ split: 4, labels: [label({ face: 'S', y: 4, size: 6, raised: true, colour: '#c8102e' })] });
    const b = buildEnclosure(M, s, BOARD);
    expect(b.inlays.map((x) => x.on).sort()).toEqual(['base', 'top']);
    const plate = printPlate(b);
    const top = plate.find((p) => p.name === 'Top')!;
    expect(top.inlays).toHaveLength(1);
    expect(plate.find((p) => p.name === 'Base')!.inlays).toHaveLength(1);
    // Nothing under the bed: the parts and their text on it or above
    for (const p of plate) for (const m of [p.mesh, ...p.inlays.map((x) => x.mesh)]) for (let i = 2; i < m.pos.length; i += 3) expect(m.pos[i]!).toBeGreaterThan(-1e-4);
  });

  it('a 3MF of a part with text in another colour: one object of components, each mesh in its colour', () => {
    const tri = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], idx: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
    const z = write3mf([{ name: 'Box Base', ...tri, colour: [0.2, 0.3, 0.4] }, { name: 'Box Top', ...tri, colour: [1, 1, 1], parts: [{ name: 'Box Top Logo', ...tri, colour: [1, 0.5, 0] }] }], 'Konium Designer', new Date('2026-11-06'));
    // The package is stored, not compressed: the model reads as it is
    const model = new TextDecoder('latin1').decode(z);
    expect(model).toContain('<base name="Box Base" displaycolor="#334D66FF"/><base name="Box Top" displaycolor="#FFFFFFFF"/><base name="Box Top Logo" displaycolor="#FF8000FF"/>');
    expect(model).toContain('<object id="5" type="model" name="Box Top"><components><component objectid="3"/><component objectid="4"/></components></object>');
    expect(model).toContain('<build><item objectid="2"/><item objectid="5"/></build>');
    expect(model).toMatch(/<object id="4" type="model" name="Box Top Logo" pid="1" pindex="2">/);
  });

  it('finishes and the light: clear is see-through, metal mirrors; the key light from its direction, the room\'s hue', () => {
    expect(finishMaterial('clear').alpha).toBeLessThan(1);
    expect(finishMaterial('metal').material.metal).toBe(1);
    expect(finishMaterial('fuzzy').material.fuzz).toBeGreaterThan(0);
    expect(finishMaterial('nonsense')).toEqual(finishMaterial('satin'));
    // From the front (0°), 45° up: towards −Y and up
    const u = lightUniforms({ env: [1, 1, 1], azimuth: 0, elevation: 45, key: 1, ambient: 1 });
    expect(u.key[0]).toBeCloseTo(0, 6); expect(u.key[1]).toBeCloseTo(-Math.SQRT1_2, 6); expect(u.key[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(u.hue).toEqual([1, 1, 1]);
    // From the right: +X
    expect(lightUniforms({ env: [1, 1, 1], azimuth: 90, elevation: 0, key: 1, ambient: 1 }).key[0]).toBeCloseTo(1, 6);
    // A blue room tints blue (its hue at the brightness of white)
    const blue = lightUniforms({ env: [0.2, 0.3, 0.8], azimuth: 0, elevation: 45, key: 1, ambient: 1 }).hue;
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(envGradient([0.5, 0.5, 0.5], true)).toEqual([[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
    const [top, bottom] = envGradient([0.5, 0.5, 0.5], false);
    expect(top[0]).toBeGreaterThan(0.5); expect(bottom[0]).toBeLessThan(0.5);
  });
});
