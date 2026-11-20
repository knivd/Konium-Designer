import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR } from '../src/model/sch';
import { roundRectPoints } from '../src/core/geom';
import { mil } from '../src/core/units';
import { noErcGlyph } from '../src/editors/sch/symbols';
import { identity, transformBag } from '../src/model/schTransform';

/** A user's report (26.065): round rectangles with radii past half their size, Thin Cross No ERCs, colours AD left out. */
function sheet() {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', AREACOLOR: 16317695 });
  const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Dot', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1, COLOR: 128 }, { LOCATION: { x: 300, y: 397 } });
  // 6 × 6 with radii 20: AD clamps them to 3, a circle; no COLOR (AD leaves 0 out) → black
  b.add({ RECORD: SR.ROUND_RECTANGLE, OWNERINDEX: ci, OWNERPARTID: 1, LINEWIDTH: 1, AREACOLOR: 16777215, ISSOLID: true, CORNERXRADIUS: 20, CORNERYRADIUS: 20 },
    { LOCATION: { x: 297, y: 397 }, CORNER: { x: 303, y: 403 } });
  // 40 × 10 with radii 8 and 3: x clamped to nothing past 8, y to 3 (≤ 5)
  b.add({ RECORD: SR.ROUND_RECTANGLE, OWNERPARTID: -1, COLOR: 255, CORNERXRADIUS: 8, CORNERYRADIUS: 30 }, { LOCATION: { x: 100, y: 100 }, CORNER: { x: 140, y: 110 } });
  b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 35, PINLENGTH: 2, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x: 300, y: 397 } });
  b.add({ RECORD: SR.NO_ERC, OWNERPARTID: -1, COLOR: 255, ORIENTATION: 1, SYMBOL: 'Thin Cross', ISACTIVE: true, SUPPRESSALL: true }, { LOCATION: { x: 300, y: 395 } });
  b.add({ RECORD: SR.NO_ERC, OWNERPARTID: -1, SYMBOL: 'Triangle', ISACTIVE: true, SUPPRESSALL: true }, { LOCATION: { x: 340, y: 395 } });
  b.add({ RECORD: SR.WIRE, OWNERPARTID: -1, LOCATIONCOUNT: 2, X1: 0, Y1: 0, X2: 10, Y2: 0 });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return readSchDoc(writeCfb(root), 'Report.SchDoc');
}

describe('26.067: round rectangles, No ERC symbols, colours AD leaves out', () => {
  const doc = sheet();
  const rects = doc.objects.filter((o) => o.kind === 'rect');
  const noercs = doc.objects.filter((o) => o.kind === 'noerc');

  it('round rectangle radii are clamped to half the size, each way', () => {
    const [dot, wide] = rects;
    expect(dot?.kind === 'rect' && [dot.r, dot.ry]).toEqual([mil(30), mil(30)]);
    expect(wide?.kind === 'rect' && [wide.r, wide.ry]).toEqual([mil(80), mil(50)]);
    // the dot's outline is a circle of 30 mil about its centre
    if (dot?.kind !== 'rect') throw new Error('no rect');
    const c = { x: (dot.a.x + dot.b.x) / 2, y: (dot.a.y + dot.b.y) / 2 };
    const pts = roundRectPoints(dot.a, dot.b, dot.r, dot.ry);
    expect(pts.length).toBeGreaterThan(16);
    for (const p of pts) expect(Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - mil(30))).toBeLessThan(1);
    // no repeated points where the corners meet
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length]!;
      expect(Math.hypot(pts[i]!.x - q.x, pts[i]!.y - q.y)).toBeGreaterThan(0);
    }
  });

  it('a plain rectangle outline is its four corners', () => {
    expect(roundRectPoints({ x: 0, y: 0 }, { x: 10, y: 5 }, 0, 0)).toHaveLength(4);
  });

  it('a colour AD leaves out is black', () => {
    const [dot, wide] = rects;
    expect(dot?.kind === 'rect' && dot.color).toBe(0);
    expect(dot?.kind === 'rect' && dot.fill).toBe(0xffffff);
    expect(wide?.kind === 'rect' && wide.color).toBe(0xff0000);
    expect(wide?.kind === 'rect' && wide.fill).toBe(0);
    const pin = doc.objects.find((o) => o.kind === 'pin');
    expect(pin?.kind === 'pin' && pin.color).toBe(0);
    const wire = doc.objects.find((o) => o.kind === 'wire');
    expect(wire?.kind === 'wire' && wire.color).toBe(0);
    expect(noercs[1]?.kind === 'noerc' && noercs[1].color).toBe(0);
    expect(doc.sheet.background).toBe(0xfffcf8);
  });

  it('No ERC: the symbol style and its orientation are read', () => {
    expect(noercs.map((o) => o.kind === 'noerc' && [o.symbol, o.orient, o.color])).toEqual([['Thin Cross', 1, 0xff0000], ['Triangle', 0, 0]]);
  });

  it('No ERC symbols: five shapes, Thin Cross for an older record', () => {
    const size = (s?: string) => { const g = noErcGlyph(s); const xs = g.lines.flat().map((p) => Math.abs(p[0])); return [Math.max(...xs), g.w, g.lines.length]; };
    expect(size(undefined)).toEqual([40, 6, 2]);
    expect(size('Thin Cross')).toEqual([40, 6, 2]);
    expect(size('Thick Cross')).toEqual([40, 20, 2]);
    expect(size('Small Cross')).toEqual([20, 6, 2]);
    expect(size('Checkbox')).toEqual([30, 6, 2]);
    expect(size('Triangle')).toEqual([32, 6, 1]);
  });

  it('turning a No ERC turns its ORIENTATION', () => {
    const rec = doc.records.find((r) => r.bag?.int('RECORD') === SR.NO_ERC && r.bag?.get('SYMBOL') === 'Triangle');
    if (!rec?.bag) throw new Error('no No ERC');
    const bag = transformBag(rec.bag.clone(), { ...identity(), quarter: 1 });
    expect(bag.int('ORIENTATION')).toBe(1);
  });
});
