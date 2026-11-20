import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { addRecords } from '../src/model/schEdit';
import { polylineBag } from '../src/model/schPlace';
import { schProps, type SchCtx } from '../src/model/schProps';
import { SchEditor, dashPattern, linePattern } from '../src/editors/sch/SchEditor';
import { INSTANCE_FLOATS, Kind } from '../src/render/Scene';
import { mil } from '../src/core/units';
import type { SchDocument } from '../src/model/sch';

const P = (x: number, y: number) => ({ x: mil(x), y: mil(y) });
const ctx = (doc: SchDocument, index: number): SchCtx => ({ doc, index, units: 'mil', docName: 'Demo.SchDoc', libraryMode: false });

describe('reported: dotted lines drawn solid', () => {
  it('a polyline keeps its Line Style (LINESTYLEEXT before LINESTYLE)', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const n = doc.objects.length;
    const dotted = polylineBag([P(0, 0), P(1000, 0)]); dotted.set('LINESTYLE', '2'); dotted.set('LINESTYLEEXT', '2');
    const dashDot = polylineBag([P(0, 100), P(1000, 100)]); dashDot.set('LINESTYLEEXT', '3');
    addRecords(doc, [dotted, dashDot]).apply();
    const again = readSchDoc(writeSchDoc(doc), 'Demo.SchDoc');
    expect(again.objects.slice(n).map((o) => (o.kind === 'polyline' ? o.style : -1))).toEqual([2, 3]);
  });
  it('dashes follow the pattern round corners; a solid line is one piece a side', () => {
    const d = dashPattern([P(0, 0), P(100, 0), P(100, 100)], [mil(30), mil(20)]);
    expect(d.length).toBe(4);
    expect(d[1]![0]).toEqual(P(50, 0));
    // The third dash turns the corner: it ends 10 mil up the second side
    expect(d[2]).toEqual([P(100, 0), P(100, 30)].map((p, i) => (i === 0 ? P(100, 0) : p)));
    expect(linePattern(0, 0)).toEqual([]);
    expect(dashPattern([P(0, 0), P(100, 0)], [])).toEqual([[P(0, 0), P(100, 0)]]);
  });
  it('drawn as dots and dashes, not one line', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const solidIdx = doc.objects.length;
    const solid = polylineBag([P(0, 5000), P(1000, 5000)]);
    const dotted = polylineBag([P(0, 5200), P(1000, 5200)]); dotted.set('LINESTYLE', '2');
    addRecords(doc, [solid, dotted]).apply();
    const ed = new SchEditor(doc);
    const scene = ed.scene();
    // Capsules along each line (y relative to the scene's origin)
    const along = (y: number) => {
      let n = 0;
      for (const g of scene.ordered()) {
        const f = g.prims.f32;
        for (let k = 0; k < g.prims.count; k++) {
          const o = k * INSTANCE_FLOATS;
          if (f[o + 8] === Kind.Capsule && Math.abs(f[o + 1]! - (mil(y) - scene.origin.y)) < 1 && Math.abs(f[o + 3]! - (mil(y) - scene.origin.y)) < 1) n++;
        }
      }
      return n;
    };
    expect(solidIdx).toBeGreaterThan(0);
    expect(along(5000)).toBe(1);
    expect(along(5200)).toBe(50);
  });
  it('the Inspector sets both keys', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const i = doc.objects.length;
    addRecords(doc, [polylineBag([P(0, 0), P(100, 0)])]).apply();
    const p = schProps(doc, doc.objects[i]!, false).find((x) => x.name === 'Line Style')!;
    expect(p.get(ctx(doc, i))).toBe('Solid');
    p.set!(ctx(doc, i), 'Dash Dotted')!.apply();
    const o = doc.objects[i]!;
    expect(o.kind === 'polyline' && o.style).toBe(3);
    expect(p.get(ctx(doc, i))).toBe('Dash Dotted');
  });
});
