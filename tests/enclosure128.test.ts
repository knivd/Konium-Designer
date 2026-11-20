import { describe, expect, it } from 'vitest';
import { defaultSpec, newAdd, normaliseSpec, type Add, type BoardFacts, type EnclosureSpec } from '../src/model/enclosure';
import { buildEnclosure } from '../src/model/enclosureSolid';
import { manifold } from '../src/platform/manifold';
import { layoutOf } from '../src/model/enclosure';
import { duplicate, features, kindOf, makeItem, mirrored, repeat } from '../src/app/EnclosureTools';

/** A 50 × 30 mm board, four M3 holes 3.5 mm in, a 6 mm part on top. */
const BOARD: BoardFacts = {
  w: 50, h: 30, thickness: 1.6, top: 6, bottom: 0,
  holes: [[-21.5, -11.5], [21.5, -11.5], [21.5, 11.5], [-21.5, 11.5]].map(([x, y]) => ({ x: x!, y: y!, d: 3.2 })),
  parts: [{ name: 'U1', x0: -5, y0: -5, x1: 5, y1: 5, z1: 6 }],
};
const spec = (patch: Partial<EnclosureSpec> = {}): EnclosureSpec => ({ ...defaultSpec('B.PcbDoc'), ...patch });

describe('Enclosure designer: protrusions and screw heads (U2)', () => {
  it('protrusions outside and inside every face add their volume to the part that holds them; a boss\'s hole takes it away again', async () => {
    const M = await manifold();
    const none = buildEnclosure(M, spec(), BOARD);
    const vol = (a: Add) => { const r = buildEnclosure(M, spec({ adds: [a] }), BOARD); return { b: r.base.volume - none.base.volume, t: r.top.volume - none.top.volume, n: r.notes.join(' | ') }; };
    const block = (face: Add['face'], side: Add['side'], x = 0, y = 0) => ({ ...newAdd('block', face, x, y, side, 1), w: 8, h: 4, height: 3 });
    // 8 × 4 × 3 mm = 96 mm³ each
    expect(vol(block('bottom', 'out')).b).toBeCloseTo(96, 0);
    expect(vol(block('bottom', 'out')).n).toContain('Block 1 stands out of a face that lies on the print bed');
    expect(vol(block('top', 'out')).t).toBeCloseTo(96, 0);
    // Inside the top, clear of U1 (over the board's corner)
    expect(vol(block('top', 'in', 18, 9)).t).toBeCloseTo(96, 0);
    expect(vol(block('S', 'out', 0, 4)).b + vol(block('S', 'out', 0, 4)).t).toBeCloseTo(96, 0);
    // Inside a wall at the board's height it reaches the board's edge (1 mm away)
    expect(vol(block('E', 'in', 0, -1)).n).toContain("Block 1 runs into the board's edge");
    // Inside the floor, past the board's underside
    expect(vol({ ...block('bottom', 'in'), height: 5 }).n).toContain('Block 1 runs into the board or the parts under it');
    // Inside the top, down onto U1
    expect(vol({ ...block('top', 'in'), height: 6 }).n).toContain('Block 1 runs into U1');
    const boss = newAdd('boss', 'bottom', 30, 0, 'out', 2);
    const solid = Math.PI * 9 * 5, bore = Math.PI * (1.25 + 0.075) ** 2 * 5;
    expect(vol(boss).b).toBeCloseTo(solid - bore, -0.5);
  });

  it('countersinks and counterbores take a screw head\'s room round a hole', async () => {
    const M = await manifold();
    const hole = { name: 'H', face: 'top' as const, shape: 'circle' as const, x: 15, y: 8, w: 3.2, h: 3.2, on: true };
    const v = (o: object) => buildEnclosure(M, spec({ openings: [o as never] }), BOARD).top.volume;
    const plain = v(hole), cs = v({ ...hole, sink: { kind: 'cs', d: 6.4, depth: 0 } }), cb = v({ ...hole, sink: { kind: 'cb', d: 6, depth: 1 } });
    const r = 1.6 + 0.075, R = 3.2 + 0.075, d = 1.6;
    // The cone between the hole and the head: π d (R² + R r + r²) / 3 less the hole's own cylinder
    expect(plain - cs).toBeCloseTo((Math.PI * d * (R * R + R * r + r * r)) / 3 - Math.PI * r * r * d, -0.5);
    expect(plain - cb).toBeCloseTo(Math.PI * ((3 + 0.075) ** 2 - r * r) * 1, -0.5);
  });

  it('documents without protrusions read with none; a rib on a wall stands upright', () => {
    expect(normaliseSpec({ ...spec(), adds: undefined } as never).adds).toEqual([]);
    const r = newAdd('rib', 'N', 0, 5, 'in', 1);
    expect(r.h).toBeGreaterThan(r.w);
    expect(newAdd('rib', 'bottom', 0, 0, 'in', 1).w).toBeGreaterThan(newAdd('rib', 'bottom', 0, 0, 'in', 1).h);
  });

  it('the tools: each puts its feature where the face was clicked; duplicate, mirror and repeat copy it; the list puts the board\'s first', () => {
    const s = spec(), g = layoutOf(s, BOARD);
    const hole = makeItem('hole', s, g, 'S', 5.04, 3.96)!;
    expect(hole.list).toBe('openings');
    expect(hole.item).toMatchObject({ face: 'S', shape: 'circle', x: 5, y: 4, w: 3.2 });
    expect(makeItem('pocket', s, g, 'top', 0, 0)!.item).toMatchObject({ depth: 0.6 });
    expect(makeItem('boss', s, g, 'bottom', 1, 2)!.item).toMatchObject({ kind: 'boss', side: 'in', hole: 2.5 });
    expect(makeItem('block', s, g, 'E', 0, 3, 'in')!.item).toMatchObject({ kind: 'block', side: 'in' });
    expect(makeItem('vents', s, g, 'N', 0, 3)!.item).toMatchObject({ pattern: 'slots' });
    expect(makeItem('logo', s, g, 'top', 0, 0)).toBeNull();
    expect(kindOf('openings', hole.item).kind).toBe('Hole');
    const d = duplicate('openings', hole.item, 2), m = mirrored('openings', hole.item, 3), r = repeat('openings', hole.item, 3, 10, 0, 4);
    expect([d.x, m.x, r.map((x) => x.x)]).toEqual([10, -5, [15, 25, 35]]);
    expect((d as { name: string }).name).toBe('Hole 2');
    const withBoard = { ...s, openings: [hole.item as never, { ...(hole.item as object), name: 'J1', auto: true } as never] };
    expect(features(withBoard).map((f) => [f.list, f.i, f.board])).toEqual([['openings', 1, true], ['openings', 0, false]]);
  });
});
