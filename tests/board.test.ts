import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc, encodeRegion } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { setBoardShape, setOrigin, shapeFromLoop, shapePrimitives, movedShape, mechEnabled, setMechEnabled } from '../src/model/pcbBoard';
import { addPrimRecords } from '../src/model/pcbEdit';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbArc, PcbTrack } from '../src/model/pcb';

const P = (x: number, y: number) => ({ x: mil(x), y: mil(y) });
const load = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

describe('the board: origin and shape', () => {
  it('Set Origin writes Board6 and reads back; undo puts it back', () => {
    const doc = load();
    const was = doc.board.origin;
    const ch = setOrigin(doc, P(1500, 1200));
    ch.apply();
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    expect(again.board.origin).toEqual(P(1500, 1200));
    ch.revert();
    expect(doc.board.origin).toEqual(was);
    expect(doc.dirty.has('Board6')).toBe(false);
  });

  it('a new shape with an arc corner is saved in place of the old vertices', () => {
    const doc = load();
    const keys = doc.board.bag!.keys();
    const at = keys.indexOf('KIND0');
    const verts = [
      { p: P(1000, 1000) }, { p: P(2000, 1000) },
      { p: P(2000, 1500), arc: { c: P(1900, 1500), r: mil(100), sa: 0, ea: 90 } },
      { p: P(1900, 1600) }, { p: P(1000, 1600) },
    ];
    setBoardShape(doc, verts).apply();
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    expect(again.board.vertices.map((v) => [v.p, !!v.arc])).toEqual(verts.map((v) => [v.p, !!v.arc]));
    expect(again.board.vertices[2]!.arc).toEqual(verts[2]!.arc);
    expect(again.board.bag!.keys().indexOf('KIND0')).toBe(at);
    expect(again.board.outline.length).toBeGreaterThan(5);
    // moved as a whole
    expect(movedShape(verts, P(10, 0))[2]!.arc!.c).toEqual(P(1910, 1500));
  });

  it('defines the shape from a closed loop of tracks and an arc, and back to primitives', () => {
    const t = (a: [number, number], b: [number, number]) => ({ kind: 'track', a: P(...a), b: P(...b) }) as PcbTrack;
    const arc = { kind: 'arc', c: P(1900, 1500), r: mil(100), start: 0, end: 90 } as PcbArc;
    const loop = [t([1000, 1000], [2000, 1000]), t([1000, 1600], [1000, 1000]), t([2000, 1000], [2000, 1500]), arc, t([1900, 1600], [1000, 1600])];
    const r = shapeFromLoop(loop);
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') return;
    expect(r).toHaveLength(5);
    expect(r.filter((v) => v.arc)).toHaveLength(1);
    expect(shapePrimitives(r).map((p) => p.kind).sort()).toEqual(['arc', 'track', 'track', 'track', 'track']);
    expect(shapeFromLoop(loop.slice(0, 3))).toMatch(/closed/);
  });

  it('a board cutout region reads back as a cutout', () => {
    const doc = load();
    addPrimRecords(doc, [{ storage: 'Regions6', rec: encodeRegion({ layer: L.MULTI, outline: [P(1100, 1100), P(1200, 1100), P(1200, 1200)], boardCutout: true }) }]).apply();
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    expect(again.prims.filter((p) => p.kind === 'region' && p.boardCutout)).toHaveLength(1);
  });

  it('mechanical layers: Enable reads and writes LAYERnMECHENABLED and the V8 entries', () => {
    const doc = load();
    // The demo board enables Mechanical 1 and 13 (its 3D bodies); its V8 entries run to Mechanical 32
    expect([...mechEnabled(doc)!]).toEqual([L.MECH1, L.MECH1 + 12]);
    expect(doc.board.bag!.get('LAYER_V8_43NAME')).toBe('Mechanical 20');
    const ch = setMechEnabled(doc, new Map([[L.MECH1, false], [L.MECH1 + 12, true], [1020, true]]));
    ch.apply();
    const again = readPcbDoc(writePcbDoc(doc), 'x.PcbDoc');
    expect([...mechEnabled(again)!].sort((a, b) => a - b)).toEqual([L.MECH1 + 12, 1020]);
    expect(again.board.bag!.get('LAYER57MECHENABLED')).toBe('FALSE');
    expect(again.board.bag!.get('LAYER_V8_43MECHENABLED')).toBe('TRUE');
    // …and in the V9 cache and the legacy LAYERV7 entries (Mechanical 20 is LAYERV7_3; Mechanical 1 is cache entry 69)
    expect([again.board.bag!.get('LAYERV7_3MECHENABLED'), again.board.bag!.get('V9_CACHE_LAYER89_NAME'), again.board.bag!.get('V9_CACHE_LAYER89_MECHENABLED'),
      again.board.bag!.get('V9_CACHE_LAYER69_MECHENABLED')]).toEqual(['TRUE', 'Mechanical 20', 'TRUE', 'FALSE']);
    ch.revert();
    expect([...mechEnabled(doc)!]).toEqual([L.MECH1, L.MECH1 + 12]);
    expect(doc.dirty.has('Board6')).toBe(false);
  });
});
