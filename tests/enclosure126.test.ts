import { describe, expect, it } from 'vitest';
import { defaultSpec, layoutOf, screwOf, type BoardFacts, type EnclosureSpec } from '../src/model/enclosure';
import { buildEnclosure, printPlate, type SolidMesh } from '../src/model/enclosureSolid';
import { manifold } from '../src/platform/manifold';

/** A 50 × 30 mm board, four M3 holes 3.5 mm in, a 6 mm part on top. */
const BOARD: BoardFacts = {
  w: 50, h: 30, thickness: 1.6, top: 6, bottom: 0,
  holes: [[-21.5, -11.5], [21.5, -11.5], [21.5, 11.5], [-21.5, 11.5]].map(([x, y]) => ({ x: x!, y: y!, d: 3.2 })),
  parts: [{ name: 'U1', x0: -5, y0: -5, x1: 5, y1: 5, z1: 6 }],
};
const spec = (patch: Partial<EnclosureSpec> = {}): EnclosureSpec => ({ ...defaultSpec('B.PcbDoc'), ...patch });
const ext = (m: SolidMesh) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity; for (let i = 0; i < m.pos.length; i += 3) { x0 = Math.min(x0, m.pos[i]!); x1 = Math.max(x1, m.pos[i]!); z0 = Math.min(z0, m.pos[i + 2]!); } return { x0, x1, z0 }; };

describe('Enclosure designer: the release\'s fixes and keyholes', () => {
  it('locating pins: posts from the top over them, hollow round their tips; screwed standoffs get none', async () => {
    const M = await manifold();
    const g = layoutOf(spec({ mount: { into: 'pin', dia: null, ledges: true, clamp: true } }), BOARD);
    expect(g.clamps).toHaveLength(4);
    expect(g.clamps[0]!.r).toBeGreaterThan(2);
    expect(layoutOf(spec(), BOARD).clamps).toHaveLength(0);
    const r = buildEnclosure(M, spec({ mount: { into: 'pin', dia: null, ledges: true, clamp: true } }), BOARD);
    const of = (m: SolidMesh) => M.Manifold.ofMesh(new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(m.pos), triVerts: Uint32Array.from(m.idx) }));
    const a = of(r.base), b = of(r.top), both = a.intersect(b);
    expect(both.volume()).toBeLessThan(0.01);
    for (const x of [a, b, both]) x.delete();
  });

  it('screw lengths: into nuts, through the nut (set higher for it) without standing out underneath; into inserts, to the insert\'s hole', () => {
    const nut = layoutOf(spec({ above: 20, fix: 'screws', screw: { size: 3, into: 'nut', head: 'countersunk', at: 'corners' } }), BOARD);
    const k = screwOf(3), tip = nut.height - nut.screws!.length;
    expect(tip).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(nut.screws!.nutTop! - k.nutH).toBeGreaterThanOrEqual(tip - 1e-9);
    const ins = layoutOf(spec({ fix: 'screws', screw: { size: 3, into: 'insert', head: 'countersunk', at: 'corners' } }), BOARD);
    // The tip in the insert's hole: not below its bottom
    expect(ins.height - ins.screws!.length).toBeGreaterThanOrEqual(ins.joint - k.insertL - 0.5 - 1e-9);
  });

  it('the print plate: parts apart even with ears; each lowest point on the bed, a raised mark on the top included', async () => {
    const M = await manifold();
    const r = buildEnclosure(M, spec({ ears: { sides: 'EW', hole: 4.5 }, labels: [{ text: 'UP', face: 'top', x: 0, y: 0, size: 5, depth: 0.6, raised: true, on: true }] }), BOARD);
    const plate = printPlate(r).map((p) => ext(p.mesh));
    expect(plate[1]!.x0).toBeGreaterThan(plate[0]!.x1 + 5);
    for (const e of plate) expect(e.z0).toBeCloseTo(0, 6);
  });

  it('cut-in text on a wall across the joint: cut from both shells', async () => {
    const M = await manifold();
    const label = { text: 'HHHH', face: 'S' as const, x: 0, y: 3, size: 5, depth: 0.6, raised: false, on: true };
    const none = buildEnclosure(M, spec({ split: 3 }), BOARD), cut = buildEnclosure(M, spec({ split: 3, labels: [label] }), BOARD);
    expect(none.base.volume - cut.base.volume).toBeGreaterThan(1);
    expect(none.top.volume - cut.top.volume).toBeGreaterThan(1);
    const up = buildEnclosure(M, spec({ split: 3, labels: [{ ...label, raised: true }] }), BOARD);
    expect(up.base.volume - none.base.volume).toBeGreaterThan(1);
    expect(up.top.volume - none.top.volume).toBeGreaterThan(1);
  });

  it('keyholes: two in the floor with housings inside; the room for the heads under the board, or a note when there is too little', async () => {
    const M = await manifold();
    const none = buildEnclosure(M, spec({ standoff: 5 }), BOARD), kh = buildEnclosure(M, spec({ standoff: 5, keyholes: 8 }), BOARD);
    expect(kh.notes.join(' | ')).toMatch(/Keyholes: two for screw heads up to 8 mm across, [\d.]+ mm high; hang the box with its back wall up, the screws 26\.0 mm apart/);
    expect(kh.base.volume).not.toBeCloseTo(none.base.volume, 0);
    expect(kh.notes.filter((n) => /sound/.test(n))).toEqual([]);
    expect(buildEnclosure(M, spec({ standoff: 1.5, keyholes: 8 }), BOARD).notes.join(' | ')).toContain('No keyholes');
  });
});
