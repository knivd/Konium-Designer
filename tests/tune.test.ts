import { describe, expect, it } from 'vitest';
import { accordion, arcAngles, offsetPieces, piecesLength, type TunePattern } from '../src/model/lengthTune';
import { lanePath, laneOffsets, offsetPolyline } from '../src/model/busRoute';

const mil = (n: number) => n * 10_000;
const A = { x: 0, y: 0 }, B = { x: mil(1000), y: 0 };

describe('length tuning accordions', () => {
  for (const style of ['mitered', 'arcs', 'rounded'] as const) {
    it(`${style}: adds what is asked, the last bump lower, and the path stays joined`, () => {
      const pat: TunePattern = { style, amplitude: mil(100), space: mil(20), miter: 50 };
      const pitch = mil(20) + mil(8);
      const r = accordion(A, B, mil(100), mil(900), 1, mil(700), pat, pitch, mil(8));
      expect(Math.abs(piecesLength(r.pieces) - mil(1000) - mil(700))).toBeLessThan(mil(1));
      expect(Math.abs(r.added - mil(700))).toBeLessThan(mil(1));
      expect(r.bumps).toBe(4);
      // Joined end to end: each piece starts where the last one ended
      const ends = r.pieces.map((p) => (p.t === 'line' ? [p.a, p.b] : (() => { const a = p.from * Math.PI / 180, b = (p.from + p.sweep) * Math.PI / 180; return [{ x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }, { x: p.c.x + p.r * Math.cos(b), y: p.c.y + p.r * Math.sin(b) }]; })()));
      for (let i = 1; i < ends.length; i++) expect(Math.hypot(ends[i]![0]!.x - ends[i - 1]![1]!.x, ends[i]![0]!.y - ends[i - 1]![1]!.y)).toBeLessThan(3);
      expect(ends[0]![0]).toEqual(A); expect(ends.at(-1)![1]).toEqual(B);
    });
  }
  it('as much as fits when the target is out of reach; a bump that would clash is left out', () => {
    const pat: TunePattern = { style: 'mitered', amplitude: mil(50), space: mil(20), miter: 50 };
    const all = accordion(A, B, 0, mil(1000), -1, Infinity, pat, mil(28), mil(8));
    expect(all.bumps).toBe(Math.floor((mil(1000) - mil(14) * 2 / 2 + mil(28)) / (2 * mil(28))));
    const some = accordion(A, B, 0, mil(1000), -1, Infinity, pat, mil(28), mil(8), (pts) => !pts.some((p) => p.x > mil(400) && p.x < mil(600)));
    expect(some.bumps).toBeLessThan(all.bumps);
    expect(some.pieces.every((p) => p.t !== 'line' || p.a.y <= 0)).toBe(true);
  });
  it('pieces offset for a pair, arcs kept counter-clockwise', () => {
    const pat: TunePattern = { style: 'arcs', amplitude: mil(60), space: mil(20), miter: 100 };
    const r = accordion(A, B, 0, mil(500), 1, mil(200), pat, mil(40), mil(8));
    const inner = offsetPieces(r.pieces, mil(6)), outer = offsetPieces(r.pieces, -mil(6));
    expect(Math.abs(piecesLength(inner) - piecesLength(outer))).toBeLessThan(mil(2));
    for (const p of r.pieces) if (p.t === 'arc') { const { start, end } = arcAngles(p); expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeLessThan(360); }
  });
});

describe('routing several nets as one', () => {
  it('lanes beside the centre line, joining from their pads at 45°', () => {
    expect(laneOffsets([mil(8), mil(8)], mil(6))).toEqual([-mil(7), mil(7)]);
    const off = offsetPolyline([{ x: 0, y: 0 }, { x: mil(100), y: 0 }, { x: mil(200), y: mil(100) }], mil(10));
    expect(off[0]).toEqual({ x: 0, y: mil(10) });
    expect(off[1]!.y).toBe(mil(10));
    const centre = [{ x: 0, y: 0 }, { x: mil(200), y: 0 }];
    const lane = lanePath({ x: 0, y: mil(25) }, centre, mil(7));
    expect(lane[0]).toEqual({ x: 0, y: mil(25) });
    expect(lane[1]).toEqual({ x: mil(18), y: mil(7) });
    expect(lane.at(-1)).toEqual({ x: mil(200), y: mil(7) });
    const ended = lanePath({ x: 0, y: mil(25) }, centre, mil(7), { x: mil(260), y: mil(30) });
    expect(ended.at(-2)).toEqual({ x: mil(237), y: mil(7) });
    expect(ended.at(-1)).toEqual({ x: mil(260), y: mil(30) });
  });
});
