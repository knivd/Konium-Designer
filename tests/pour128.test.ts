import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { computePour } from '../src/model/pour';
import { mm } from '../src/core/units';
import { NO_NET, inPour, type PcbArc } from '../src/model/pcb';

/** A pour flows round a keep-out arc on its layer (it poured over them before 26.128). */
describe('Pours round keep-out arcs', () => {
  it('no poured copper over a keep-out circle on the pour\'s layer', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.prims = doc.prims.filter((p) => !inPour(p));
    const poly = doc.polygons[0]!;
    const xs = poly.outline.map((p) => p.x), ys = poly.outline.map((p) => p.y);
    const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const area = (r: ReturnType<typeof computePour>) => r.regions.reduce((s, x) => s + Math.abs(x.outline.reduce((a, p, i) => { const q = x.outline[(i + 1) % x.outline.length]!; return a + p.x * q.y - q.x * p.y; }, 0) / 2) - x.holes.reduce((h, o) => h + Math.abs(o.reduce((a, p, i) => { const q = o[(i + 1) % o.length]!; return a + p.x * q.y - q.x * p.y; }, 0) / 2), 0), 0);
    const before = area(computePour(doc, poly));
    const arc: PcbArc = { kind: 'arc', src: { storage: 'Arcs6', index: -1 }, layer: poly.layer, c, r: mm(2), start: 0, end: 360, width: mm(0.5), net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: true };
    doc.prims = [...doc.prims, arc];
    const after = area(computePour(doc, poly));
    // At least the ring itself (2π r × width) is left bare
    expect(before - after).toBeGreaterThan(2 * Math.PI * mm(2) * mm(0.5) * 0.9);
  });
});
