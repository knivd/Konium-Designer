import { describe, expect, it } from 'vitest';
import { defaultSpec, logoOf, normaliseSpec, type BoardFacts, type EnclosureSpec, type Label } from '../src/model/enclosure';
import { buildEnclosure, printPlate } from '../src/model/enclosureSolid';
import { manifold } from '../src/platform/manifold';

/** A 50 × 30 mm board, four M3 holes 3.5 mm in, a 6 mm part on top. */
const BOARD: BoardFacts = {
  w: 50, h: 30, thickness: 1.6, top: 6, bottom: 0,
  holes: [[-21.5, -11.5], [21.5, -11.5], [21.5, 11.5], [-21.5, 11.5]].map(([x, y]) => ({ x: x!, y: y!, d: 3.2 })),
  parts: [{ name: 'U1', x0: -5, y0: -5, x1: 5, y1: 5, z1: 6 }],
};
const spec = (patch: Partial<EnclosureSpec> = {}): EnclosureSpec => ({ ...defaultSpec('B.PcbDoc'), ...patch });
/** A ring logo (a square with a square hole): 10 mm square, a 6 mm hole. */
const RING = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0H10V10H0Z M2 2H8V8H2Z"/></svg>';

describe('Enclosure designer: recesses, logos, seals (E5)', () => {
  it('a recess takes its depth from the face, not the whole face; one too deep is noted', async () => {
    const M = await manifold();
    const v = (o: EnclosureSpec['openings']) => { const r = buildEnclosure(M, spec({ openings: o }), BOARD); return { b: r.base.volume, t: r.top.volume, n: r.notes.join(' | ') }; };
    const none = v([]);
    const top = v([{ name: 'Sticker', face: 'top', shape: 'rect', x: 0, y: 0, w: 20, h: 10, on: true, depth: 0.6 }]);
    expect(none.t - top.t).toBeCloseTo(20 * 10 * 0.6, 1);
    const wall = v([{ name: 'Grip', face: 'S', shape: 'rect', x: 0, y: 2, w: 10, h: 4, on: true, depth: 1 }]);
    // On a flat wall: 10 × 4 × 1 mm out of whichever part holds it
    expect(none.b + none.t - wall.b - wall.t).toBeCloseTo(40, 0);
    const bottom = v([{ name: 'Label', face: 'bottom', shape: 'rect', x: 0, y: 0, w: 10, h: 10, on: true, depth: 0.4 }]);
    expect(none.b - bottom.b).toBeCloseTo(40, 0);
    expect(v([{ name: 'Deep', face: 'top', shape: 'rect', x: 0, y: 0, w: 10, h: 10, on: true, depth: 1.8 }]).n).toContain('Deep leaves 0.2 mm of the top');
  });

  it('a logo from a drawing: centred, 1 high, its hole kept; cut in, raised and cut through by its area', async () => {
    const r = logoOf(RING, 'Ring')!;
    expect(r.height).toBeCloseTo(10, 6);
    expect(r.logo.aspect).toBe(1);
    expect(r.logo.shapes[0]!.evenOdd).toBe(true);
    expect(r.logo.shapes[0]!.rings.flat().every(([x, y]) => Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5)).toBe(true);
    expect(logoOf('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5" fill="none" stroke="black"/></svg>', 'Line')).toBeNull();
    const M = await manifold();
    const label = (patch: Partial<Label>): Label => ({ text: 'Ring', face: 'top', x: 0, y: 0, size: 10, depth: 0.6, raised: false, on: true, logo: r.logo, ...patch });
    const t = (l: Label[]) => { const b = buildEnclosure(M, spec({ labels: l }), BOARD); return { t: b.top.volume, n: b.notes.join(' | ') }; };
    const none = t([]).t, area = 100 - 36;
    expect(none - t([label({})]).t).toBeCloseTo(area * 0.6, 0);
    const raised = t([label({ raised: true })]);
    expect(raised.t - none).toBeCloseTo(area * 0.6, 0);
    expect(raised.n).toContain('"Ring" stands out of a face that lies on the print bed');
    const through = t([label({ through: true })]);
    // Through the 2 mm top
    expect(none - through.t).toBeCloseTo(area * 2, 0);
    expect(through.n).toContain('"Ring" is cut through: the islands inside it fall out');
    // On a wall, read from outside: the same area
    const w = buildEnclosure(M, spec({ labels: [label({ face: 'E', y: 4, size: 6 })] }), BOARD), w0 = buildEnclosure(M, spec(), BOARD);
    expect(w0.base.volume + w0.top.volume - w.base.volume - w.top.volume).toBeCloseTo(area * 0.36 * 0.6, 0);
  });

  it('a seal: a groove round the rim, a gasket printed as a part of its own; walls too thin for it, or no screws, noted', async () => {
    const M = await manifold();
    const screws = { size: 3, into: 'insert' as const, head: 'countersunk' as const, at: 'board' as const };
    const thin = buildEnclosure(M, spec({ fix: 'screws', screw: screws, seal: { kind: 'cord', size: 2 } }), BOARD);
    expect(thin.notes.join(' | ')).toContain('No seal: its groove (2.6 mm wide) needs walls 4.4 mm thick');
    const plain = buildEnclosure(M, spec({ fix: 'screws', screw: screws, wall: 4.5 }), BOARD);
    const cord = buildEnclosure(M, spec({ fix: 'screws', screw: screws, wall: 4.5, seal: { kind: 'cord', size: 2 } }), BOARD);
    // The groove: 2.6 wide, 1.4 deep, along the walls' middle (a rounded rectangle 2.25 mm out from the cavity)
    const g = cord.g, c = 2.25, len = 2 * (2 * (g.ix + c - (g.ri + c)) + 2 * (g.iy + c - (g.ri + c))) + 2 * Math.PI * (g.ri + c);
    expect(plain.base.volume - cord.base.volume).toBeCloseTo(len * 2.6 * 1.4, -0.5);
    expect(cord.extras).toHaveLength(0);
    const gasket = buildEnclosure(M, spec({ fix: 'screws', screw: screws, wall: 4.5, seal: { kind: 'gasket', size: 2 } }), BOARD);
    expect(gasket.extras.map((x) => x.name)).toEqual(['Gasket']);
    expect(gasket.extras[0]!.mesh.volume).toBeCloseTo(len * 2 * 2, -0.5);
    expect(gasket.notes.join(' | ')).toContain('The gasket: print it in TPU; it stands 0.6 mm out of its groove');
    expect(printPlate(gasket).map((p) => p.name)).toEqual(['Base', 'Top', 'Gasket']);
    expect(buildEnclosure(M, spec({ wall: 4.5, seal: { kind: 'cord', size: 2 } }), BOARD).notes.join(' | ')).toContain('A seal needs screws');
    // Screws in the box's corners through the groove's line
    const corner = buildEnclosure(M, spec({ fix: 'screws', wall: 4.5, seal: { kind: 'cord', size: 2 } }), BOARD).notes.join(' | ');
    expect(corner).toMatch(/runs into the screws|No seal/);
  });

  it('documents of 26.124 read with no seal', () => {
    const s = normaliseSpec({ ...spec(), seal: undefined } as never);
    expect(s.seal).toEqual({ kind: 'none', size: 2 });
  });
});
