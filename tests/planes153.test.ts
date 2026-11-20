import { describe, expect, it } from 'vitest';
import { encodePad, encodeVia, flattenVertices, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { addStackLayer, readStack, setStack } from '../src/model/pcbStack';
import { splitPlanes } from '../src/model/planes';
import { runDrc } from '../src/model/drc';
import { drcSettings } from '../src/model/drcOptions';
import type { LayerId } from '../src/model/layers';
import type { Vec2 } from '../src/core/geom';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PAD, VIA, get, put } from '../src/formats/altium/pcbLayouts';
import { L } from '../src/model/layers';
import { mil, mm } from '../src/core/units';
import type { PcbDocument } from '../src/model/pcb';

/**
 * 26.153: a plane's net goes out as AD keeps it, a Split Plane over the board (AD loads a plane
 * named only in Board6 with no net); pad and via records carry their plane connection as AD's do.
 */

/** The demo board on 6 layers: Top, GND plane, two signal layers, +3V3 plane, Bottom. */
function sixLayers(doc: PcbDocument, second = '+3V3'): void {
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const step = (layer: number, plane: boolean) => { const r = addStackLayer(rows, layer, plane)!; rows = r.rows; return r.index; };
  step(step(step(step(rows.findIndex((x) => x.layer === L.TOP), true), false), false), true);
  setStack(doc, rows).apply();
  doc.board.bag!.set('PLANE1NETNAME', 'GND');
  doc.board.bag!.set('PLANE2NETNAME', second);
  doc.dirty.add('Board6');
}
const area = (pts: Vec2[]) => Math.abs(pts.reduce((a, p, k) => { const q = pts[(k + 1) % pts.length]!; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;

const relief = (s: Uint8Array, at: typeof VIA.relief | typeof PAD.relief) =>
  [get(s, at.gap), get(s, at.entries), get(s, at.width), get(s, at.expansion), get(s, at.clearance)];
const AD = [mil(10), 4, mil(10), mil(20), mil(20)];
const subs = (doc: PcbDocument, storage: 'Vias6' | 'Pads6') => doc.streams.get(storage)!.records.map((r) => r.subs[storage === 'Vias6' ? 0 : 4]!);

describe('internal planes\' nets as split planes (26.153)', () => {
  it('a plane with a net goes out with a Split Plane over the board, once', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Planes.PcbDoc');
    sixLayers(doc);
    const back = readPcbDoc(writePcbDoc(readPcbDoc(writePcbDoc(doc), 'Planes.PcbDoc')), 'Planes.PcbDoc');
    const splits = back.polygons.filter((p) => /split/i.test(p.type));
    expect(splits.map((p) => [p.bag.get('LAYER'), back.nets[p.net]?.name])).toEqual([['PLANE1', 'GND'], ['PLANE2', '+3V3']]);
    for (const p of splits) expect(Math.abs(area(p.outline) / area(back.board.outline) - 1)).toBeLessThan(1e-6);
    expect(splitPlanes(back, L.PLANE1 as LayerId).length).toBe(1);
    // The board's edge on each plane as AD draws it: of its "board" (0xFFFE), twice the 20 mil pullback wide, once
    for (const layer of [L.PLANE1, L.PLANE1 + 1]) {
      const edges = back.prims.filter((p) => p.kind === 'track' && p.layer === layer);
      expect(edges.length).toBe(back.board.vertices.length);
      expect(edges.every((p) => p.kind === 'track' && p.polygon === 0xfffe && p.width === mil(40) && p.net === 0xffff)).toBe(true);
    }
    // Konium's view of the board is as before
    const kinds = drcSettings(back).batch;
    expect(runDrc(back, kinds).violations.map((v) => v.message)).toEqual(runDrc(readPcbDoc(writePcbDoc(doc), 'x'), kinds).violations.map((v) => v.message));
  });

  it('a plane with no net gets none; a board shape with an arc keeps its shape, turned', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Planes.PcbDoc');
    sixLayers(doc, '(No Net)');
    // An arc for the top edge: from (W, H) round to (0, H) over a centre at (W/2, H)
    const xs = doc.board.vertices.map((v) => v.p.x), ys = doc.board.vertices.map((v) => v.p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const r = (x1 - x0) / 2;
    doc.board.vertices = [{ p: { x: x0, y: y0 } }, { p: { x: x1, y: y0 } }, { p: { x: x1, y: y1 }, arc: { c: { x: x0 + r, y: y1 }, r, sa: 0, ea: 180 } }, { p: { x: x0, y: y1 } }];
    writePcbDoc(doc);
    const splits = doc.polygons.filter((p) => /split/i.test(p.type));
    expect(splits.map((p) => p.bag.get('LAYER'))).toEqual(['PLANE1']);
    expect(Math.abs(area(splits[0]!.outline) / area(flattenVertices(doc.board.vertices)) - 1)).toBeLessThan(1e-6);
  });
});

describe('plane connect style in vias and holed pads (26.155)', () => {
  it('a new via and a pad with a hole take relief (1); a pad without a hole none', () => {
    expect(get(encodeVia({ at: { x: 0, y: 0 }, diameter: mm(0.8), hole: mm(0.4) }).subs[0]!, VIA.relief.style)).toBe(1);
    const pad = (hole?: number) => encodePad({ name: '1', layer: hole ? L.MULTI : L.TOP, at: { x: 0, y: 0 }, w: mm(1.6), h: mm(1.6), shape: 'round', hole }).subs[4]!;
    expect(get(pad(mm(0.9)), PAD.relief.style)).toBe(1);
    expect(get(pad(), PAD.relief.style)).toBe(0);
  });

  it('a board with a netted plane gets the style in every via and holed pad on saving (an earlier Konium wrote 0); a board without one is left alone', () => {
    const zeroed = (doc: PcbDocument) => { subs(doc, 'Vias6').forEach((s) => put(s, VIA.relief.style, 0)); subs(doc, 'Pads6').forEach((s) => put(s, PAD.relief.style, 0)); return doc; };
    const planes = zeroed(readPcbDoc(demoPcbDoc(), 'Planes.PcbDoc'));
    sixLayers(planes);
    const back = readPcbDoc(writePcbDoc(planes), 'Planes.PcbDoc');
    expect(subs(back, 'Vias6').map((s) => get(s, VIA.relief.style))).toEqual(subs(back, 'Vias6').map(() => 1));
    const holed = subs(back, 'Pads6').filter((s) => (get(s, PAD.hole) ?? 0) > 0);
    expect(holed.length).toBeGreaterThan(0);
    expect(holed.map((s) => get(s, PAD.relief.style))).toEqual(holed.map(() => 1));
    expect(subs(back, 'Pads6').filter((s) => !get(s, PAD.hole)).every((s) => get(s, PAD.relief.style) === 0)).toBe(true);
    const flat = zeroed(readPcbDoc(demoPcbDoc(), 'Flat.PcbDoc'));
    const again = readPcbDoc(writePcbDoc(flat), 'Flat.PcbDoc');
    expect(subs(again, 'Vias6').every((s) => get(s, VIA.relief.style) === 0)).toBe(true);
  });
});

describe('the Power Plane Connect rule (26.155)', () => {
  it('a board with a netted plane and no such rule gets the suite\'s default one on saving; a board without planes doesn\'t', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Planes.PcbDoc');
    expect(doc.rules.some((r) => r.bag.get('RULEKIND') === 'PlaneConnect')).toBe(false);
    sixLayers(doc);
    const back = readPcbDoc(writePcbDoc(doc), 'Planes.PcbDoc');
    const pc = back.rules.filter((r) => r.bag.get('RULEKIND') === 'PlaneConnect');
    expect(pc.map((r) => [r.bag.get('PLANECONNECTSTYLE'), r.bag.get('RELIEFEXPANSION'), r.bag.get('RELIEFENTRIES'), r.bag.get('RELIEFCONDUCTORWIDTH'), r.bag.get('RELIEFAIRGAP'), r.bag.get('SCOPE1EXPRESSION')]))
      .toEqual([['Relief', '20mil', '4', '10mil', '10mil', 'All']]);
    const flat = readPcbDoc(writePcbDoc(readPcbDoc(demoPcbDoc(), 'Flat.PcbDoc')), 'Flat.PcbDoc');
    expect(flat.rules.some((r) => r.bag.get('RULEKIND') === 'PlaneConnect')).toBe(false);
  });
});

describe('plane connection in pad and via records (26.153)', () => {
  it('a new via or pad has AD\'s default relief and plane clearance', () => {
    expect(relief(encodeVia({ at: { x: 0, y: 0 }, diameter: mm(0.8), hole: mm(0.4) }).subs[0]!, VIA.relief)).toEqual(AD);
    const pad = encodePad({ name: '1', layer: L.MULTI, at: { x: 0, y: 0 }, w: mm(1.6), h: mm(1.6), shape: 'round', hole: mm(0.9) });
    expect(relief(pad.subs[4]!, PAD.relief)).toEqual(AD);
  });

  it('the demo board\'s pads and vias carry it', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    for (const s of subs(doc, 'Vias6')) expect(relief(s, VIA.relief)).toEqual(AD);
    for (const s of subs(doc, 'Pads6')) expect(relief(s, PAD.relief)).toEqual(AD);
  });

  it('records an earlier Konium wrote without it get the board\'s rule values on saving; others are left alone', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Old.PcbDoc');
    const zero = (s: Uint8Array, at: typeof VIA.relief | typeof PAD.relief) => { for (const k of ['gap', 'entries', 'width', 'expansion', 'clearance'] as const) put(s, at[k], 0); };
    subs(doc, 'Vias6').forEach((s) => zero(s, VIA.relief));
    subs(doc, 'Pads6').forEach((s, i) => (i === 0 ? put(s, PAD.relief.entries, 2) : zero(s, PAD.relief)));
    doc.rules.find((r) => r.bag.get('RULEKIND') === 'PlaneClearance')!.bag.set('CLEARANCE', '15mil');
    const back = readPcbDoc(writePcbDoc(doc), 'Old.PcbDoc');
    const ours = [mil(10), 4, mil(10), mil(20), mil(15)];
    for (const s of subs(back, 'Vias6')) expect(relief(s, VIA.relief)).toEqual(ours);
    const pads = subs(back, 'Pads6');
    expect(relief(pads[0]!, PAD.relief)).toEqual([mil(10), 2, mil(10), mil(20), mil(20)]);
    for (const s of pads.slice(1)) expect(relief(s, PAD.relief)).toEqual(ours);
  });

  it('a board whose records all carry it saves its pads and vias as they were', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    writePcbDoc(doc);
    expect(doc.dirty.has('Vias6') || doc.dirty.has('Pads6')).toBe(false);
  });
});
