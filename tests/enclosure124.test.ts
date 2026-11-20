import { describe, expect, it } from 'vitest';
import { autoOpenings, defaultSpec, fromCutouts, layoutOf, normaliseSpec, screwLength, snapPlaces, type BoardFacts, type EnclosureSpec } from '../src/model/enclosure';
import { buildEnclosure, printPlate, sectionMesh } from '../src/model/enclosureSolid';
import { write3mf } from '../src/formats/threeMf';
import { readEnclosure, writeEnclosure } from '../src/formats/enclosureDoc';
import { manifold } from '../src/platform/manifold';

/** A 50 × 30 mm board, 1.6 mm thick, four M3 holes 3.5 mm in, a USB connector reaching past the south edge, a 6 mm part on top. */
const BOARD: BoardFacts = {
  w: 50, h: 30, thickness: 1.6, top: 6, bottom: 0,
  holes: [[-21.5, -11.5], [21.5, -11.5], [21.5, 11.5], [-21.5, 11.5]].map(([x, y]) => ({ x: x!, y: y!, d: 3.2 })),
  parts: [{ name: 'J1', x0: -4, y0: -16.6, x1: 4, y1: -10, z1: 3.2 }, { name: 'U1', x0: -5, y0: -5, x1: 5, y1: 5, z1: 6 }],
};
const spec = (patch: Partial<EnclosureSpec> = {}): EnclosureSpec => ({ ...defaultSpec('B.PcbDoc'), ...patch });

describe('Enclosure designer: the layout', () => {
  it('sized round the board: cavity, walls, heights from its parts; standoffs at its holes, joined to the wall if need be', () => {
    const g = layoutOf(spec(), BOARD);
    expect([g.ix, g.iy, g.ox, g.oy]).toEqual([26, 16, 28, 18]);
    // Floor 2, standoffs 3, board 1.6, then the tallest part (6) and 1.5 over it; a flat lid: the joint at the rim
    expect([g.floorTop, g.boardBottom, g.boardTop, g.rim, g.height, g.joint].map((v) => +v.toFixed(2))).toEqual([2, 5, 6.6, 14.1, 16.1, 14.1]);
    expect(g.standoffs.map((p) => p.size)).toEqual([3, 3, 3, 3]);
    // A hole whose screw would cut into the wall gets none; one whose standoff only meets the wall keeps it
    expect(layoutOf(spec(), { ...BOARD, holes: [{ x: 24.5, y: 0, d: 3.2 }] }).standoffs).toHaveLength(0);
    expect(layoutOf(spec(), { ...BOARD, holes: [{ x: 23, y: 0, d: 3.2 }] }).standoffs).toHaveLength(1);
    // No holes: ledges under its corners, and posts onto it beside them
    const bare = layoutOf(spec(), { ...BOARD, holes: [] });
    expect(bare.ledges).toHaveLength(4);
    expect(bare.clamps.map((p) => [p.x, p.y])).toEqual([[-22.8, -12.8], [-22.8, 12.8], [22.8, -12.8], [22.8, 12.8]]);
  });

  it('two shells: the joint where asked, kept 2 mm off the floor and the top', () => {
    expect(layoutOf(spec({ split: 1 }), BOARD).joint).toBeCloseTo(7.6);
    const g = layoutOf(spec({ split: -20 }), BOARD);
    expect(g.joint).toBe(4);
    expect(g.notes[0]).toMatch(/over the floor/);
  });

  it('screws in the corners: bosses beside the board\'s corners, the box grown to hold them; the length they can be', () => {
    const g = layoutOf(spec({ fix: 'screws' }), BOARD);
    expect(g.screws!.at).toHaveLength(4);
    for (const p of g.screws!.at) expect(Math.hypot(Math.abs(p.x) - 25, Math.abs(p.y) - 15)).toBeGreaterThanOrEqual(g.screws!.boss / 2 + 0.39);
    expect(g.ix).toBeGreaterThan(26);
    expect(g.notes[0]).toMatch(/longer and wider/);
    expect(g.screws!.length).toBe(screwLength(g.height - g.floorTop - 0.6));
    expect([screwLength(13.5), screwLength(16), screwLength(3)]).toEqual([12, 16, 0]);
    // Down through the board's holes: no growth
    const b = layoutOf(spec({ fix: 'screws', screw: { size: 3, into: 'pilot', head: 'pan', at: 'board' } }), BOARD);
    expect([b.ix, b.screws!.at.length, b.clamps.length]).toEqual([26, 4, 0]);
  });

  it('openings found for parts at the board\'s edge: on the wall they face, open to the joint when the part reaches into the wall', () => {
    const o = autoOpenings(spec(), BOARD);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ name: 'J1', face: 'S', shape: 'rect', on: true, auto: true, part: 'J1', open: true });
    expect([o[0]!.x, o[0]!.y, o[0]!.w, o[0]!.h].map((v) => +v.toFixed(2))).toEqual([0, 1.6, 9, 4.2]);
    // Short of the wall: closed
    expect(autoOpenings(spec(), { ...BOARD, parts: [{ ...BOARD.parts[0]!, y0: -15.5 }] })[0]!.open).toBeUndefined();
    // Snap catches step aside for it
    const s = spec({ fix: 'snaps', openings: o });
    const u = snapPlaces(s, layoutOf(s, BOARD), 'S');
    expect(u).toHaveLength(1);
    expect(Math.abs(u[0]!)).toBeGreaterThanOrEqual(4.5 + 1.5 + 5);
  });

  it('the first format: lid → top, the standoffs\' diameter, its openings turned over along the wall from its middle', () => {
    const s = normaliseSpec({ board: 'B.PcbDoc', lid: 3, standoffDia: 7, cutouts: [{ name: 'J1', side: 'S', u0: 20, u1: 30, z0: -0.5, z1: 4, on: true, auto: true }] } as never);
    expect([s.v, s.top, s.mount.dia, s.print.bedChamfer, s.cutouts!.length, 'lid' in s]).toEqual([2, 3, 7, 0, 1, false]);
    const o = fromCutouts(s.cutouts!, layoutOf(s, BOARD));
    // The south wall's straight part is 2 × (26 − 1) long: its middle 25 along
    expect(o[0]).toMatchObject({ face: 'S', x: 0, y: 1.75, w: 10, h: 4.5, auto: true, part: 'J1' });
    const back = readEnclosure(writeEnclosure({ kind: 'Enclosure', name: 'E.Enclosure', spec: s, dirty: false }), 'E.Enclosure');
    expect(back.spec).toEqual(s);
    expect(new TextDecoder().decode(writeEnclosure(back)).startsWith('{\n  "koniumEnclosure": 2,')).toBe(true);
  });
});

describe('Enclosure designer: the solids', () => {
  const variants: [string, Partial<EnclosureSpec>][] = [
    ['flat lid, press fit', {}],
    ['two shells', { split: 1 }],
    ['snap catches', { fix: 'snaps' }],
    ['two shells, snap catches', { fix: 'snaps', split: 1 }],
    ['corner screws into inserts', { fix: 'screws', screw: { size: 3, into: 'insert', head: 'countersunk', at: 'corners' } }],
    ['two shells, corner screws into nuts', { fix: 'screws', split: 2, screw: { size: 2.5, into: 'nut', head: 'pan', at: 'corners' } }],
    ['screws through the board into nuts', { fix: 'screws', screw: { size: 3, into: 'pilot', head: 'countersunk', at: 'board' }, mount: { into: 'nut', dia: null, ledges: true, clamp: true } }],
    ['rounded edges, vents and text', { edge: 'round', edgeSize: 2, vents: [{ name: 'V', face: 'top', pattern: 'honeycomb', x: 0, y: 0, w: 20, h: 12, size: 4, on: true }, { name: 'W', face: 'E', pattern: 'holes', x: 0, y: 4, w: 14, h: 5, size: 2, on: true }, { name: 'S', face: 'N', pattern: 'slots', x: 0, y: 4, w: 20, h: 6, size: 1.6, on: true }], labels: [{ text: 'JD', face: 'top', x: -15, y: 8, size: 5, depth: 0.6, raised: false, on: true }, { text: 'IN', face: 'W', x: 0, y: 4, size: 3, depth: 0.4, raised: true, on: true }], feet: 8, ears: { sides: 'EW', hole: 4.5 } }],
    ['chamfered edges, locating pins', { edge: 'chamfer', edgeSize: 1.5, mount: { into: 'pin', dia: null, ledges: true, clamp: true } }],
  ];
  it.each(variants)('%s: the base and the top are sound solids', async (_name, patch) => {
    const M = await manifold();
    const s = spec(patch);
    s.openings = [...autoOpenings(s, BOARD), { name: 'Hole', face: 'E', shape: 'circle', x: 0, y: 2, w: 4, h: 4, on: true }, { name: 'Window', face: 'top', shape: 'rounded', x: 10, y: 0, w: 10, h: 6, on: true }, { name: 'Slot', face: 'W', shape: 'slot', x: 0, y: 3, w: 10, h: 3, on: true }, { name: 'Drain', face: 'bottom', shape: 'circle', x: 0, y: 0, w: 3, h: 3, on: true }];
    const r = buildEnclosure(M, s, BOARD);
    expect(r.notes.filter((n) => /sound/.test(n))).toEqual([]);
    const box = 2 * r.g.ox * 2 * r.g.oy;
    // Each: less than its outside, more than a thin skin
    expect(r.base.volume).toBeLessThan(box * r.g.joint);
    expect(r.base.volume).toBeGreaterThan(box * 0.8);
    expect(r.top.volume).toBeGreaterThan(box * 1.2);
    expect(r.base.idx.length % 3).toBe(0);
  });

  it('features take or add what they should: holes for screws and nuts, a countersink, pins, a bed chamfer', async () => {
    const M = await manifold();
    const v = (patch: Partial<EnclosureSpec>) => { const r = buildEnclosure(M, spec(patch), BOARD); return [r.base.volume, r.top.volume] as const; };
    const [b0, t0] = v({ print: { ...defaultSpec('').print, bedChamfer: 0 } });
    const [b1, t1] = v({});
    // A 0.4 mm chamfer on the bed's edges: about its perimeter × 0.08 mm² less, on each part
    const per = 2 * (56 + 36);
    expect(b0 - b1).toBeCloseTo(per * 0.08, -0.5);
    expect(t0 - t1).toBeCloseTo(per * 0.08, -0.5);
    const [bn] = v({ mount: { into: 'nut', dia: null, ledges: true, clamp: true } }), [bp] = v({ mount: { into: 'pin', dia: null, ledges: true, clamp: true } });
    expect(bn).not.toBeCloseTo(b1, 0);
    expect(bp).toBeGreaterThan(b1);
    const [, tc] = v({ fix: 'screws', screw: { size: 3, into: 'pilot', head: 'countersunk', at: 'board' } }), [, tp] = v({ fix: 'screws', screw: { size: 3, into: 'pilot', head: 'pan', at: 'board' } });
    // Four countersinks: about π/3·h(R²+Rr+r²) − πr²h each, for M3 (its clearance hole 3.4 mm and the hole allowance)
    const h = (6 - 3.55) / 2 + 0.1, R = 3.1, r = 3.55 / 2, sink = (Math.PI / 3) * h * (R * R + R * r + r * r) - Math.PI * r * r * h;
    expect(tp - tc).toBeCloseTo(4 * sink, -0.5);
  });
});

describe('Enclosure designer: printing', () => {
  it('the print plate: the top and buttons turned over beside the base, each the same solid; a 3MF of them', async () => {
    const M = await manifold();
    const parts: BoardFacts['parts'] = [...BOARD.parts, { name: 'SW1', x0: 10, y0: 4, x1: 16, y1: 10, z1: 3.5, kind: 'switch' }, { name: 'LED1', x0: -15, y0: 6, x1: -12, y1: 9, z1: 1.5, kind: 'led' }];
    const facts = { ...BOARD, parts };
    const s = spec();
    s.openings = autoOpenings(s, facts).map((o) => (o.part === 'SW1' ? { ...o, extra: 'button' as const } : o.part === 'LED1' ? { ...o, extra: 'tube' as const } : o));
    expect(s.openings.filter((o) => o.face === 'top').map((o) => [o.part, o.shape, +o.w.toFixed(2)])).toEqual([['SW1', 'circle', 3.6], ['LED1', 'circle', 3.4]]);
    const r = buildEnclosure(M, s, facts);
    expect(r.extras.map((x) => x.name)).toEqual(['SW1 button']);
    const plate = printPlate(r);
    expect(plate.map((p) => p.name)).toEqual(['Base', 'Top', 'SW1 button']);
    // Each part lies on the bed (its lowest point at 0), none overlapping the next along x
    const ext = plate.map((p) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity; for (let i = 0; i < p.mesh.pos.length; i += 3) { x0 = Math.min(x0, p.mesh.pos[i]!); x1 = Math.max(x1, p.mesh.pos[i]!); z0 = Math.min(z0, p.mesh.pos[i + 2]!); } return { x0, x1, z0 }; });
    for (const e of ext) expect(e.z0).toBeCloseTo(0, 3);
    for (let i = 1; i < ext.length; i++) expect(ext[i]!.x0).toBeGreaterThan(ext[i - 1]!.x1 + 5);
    // Turned over, not mirrored: the same volume, still a closed solid facing out
    const back = M.Manifold.ofMesh(new M.Mesh({ numProp: 3, vertProperties: Float32Array.from(plate[1]!.mesh.pos), triVerts: Uint32Array.from(plate[1]!.mesh.idx) }));
    expect(back.volume()).toBeCloseTo(r.top.volume, 1);
    back.delete();
    const z = write3mf(plate.map((p) => ({ name: p.name, pos: p.mesh.pos, idx: p.mesh.idx, colour: [0.5, 0.5, 0.5] })), 'Konium Designer', new Date('2026-11-05'));
    const text = new TextDecoder('latin1').decode(z);
    for (const t of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) expect(text).toContain(t);
  });

  it('a section through the middle: the half beyond kept', async () => {
    const M = await manifold();
    const r = buildEnclosure(M, spec(), BOARD);
    const half = sectionMesh(M, r.base, 'y', 0);
    expect(half.volume).toBeGreaterThan(r.base.volume * 0.4);
    expect(half.volume).toBeLessThan(r.base.volume * 0.6);
  });

  it('checks: a part into the lid\'s lip, one taller than the room, a long bridge, shallow text, thin walls', async () => {
    const M = await manifold();
    const tall = { ...BOARD, parts: [...BOARD.parts, { name: 'C9', x0: 23, y0: 0, x1: 25, y1: 2, z1: 7 }] };
    const s = spec({ above: 4, wall: 0.8, labels: [{ text: 'A', face: 'top', x: 0, y: 0, size: 5, depth: 0.2, raised: false, on: true }] });
    s.openings = [{ name: 'Wide', face: 'S', shape: 'rect', x: 0, y: 2, w: 30, h: 3, on: true }];
    const n = buildEnclosure(M, s, tall).notes.join(' | ');
    for (const t of ['C9 runs into the lid\'s lip', 'C9 stands 3.0 mm taller than the room', 'Wide\'s top bridges 30 mm', '"A" is 0.2 mm deep', 'Walls 0.8 mm thick']) expect(n).toContain(t);
  });
});
