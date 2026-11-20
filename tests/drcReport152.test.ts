import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { removePolygons, removePrims } from '../src/model/pcbEdit';
import { drcRules, runDrc } from '../src/model/drc';
import { drcSettings } from '../src/model/drcOptions';
import { reportHtml } from '../src/app/dialogs/Drc';
import { L, type LayerId } from '../src/model/layers';
import { addStackLayer, readStack, setStack } from '../src/model/pcbStack';
import type { PcbDocument } from '../src/model/pcb';

/**
 * 26.152: the report as the desktop suite gives it for the same boards (checked in the suite on
 * the demo board and on a 6-layer copy of it with GND and +3V3 planes).
 */

/** Top, GND plane, two signal layers, +3V3 plane, Bottom (as the showcase board's stack). */
function sixLayers(doc: PcbDocument): void {
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const step = (layer: number, plane: boolean) => { const r = addStackLayer(rows, layer, plane)!; rows = r.rows; return r.index; };
  const p1 = step(rows.findIndex((x) => x.layer === L.TOP), true);
  step(step(step(p1, false), false), true);
  setStack(doc, rows).apply();
  const names = new Map<LayerId, string>([[L.PLANE1, 'GND'], [(L.PLANE1 + 1) as LayerId, '+3V3']]);
  rows = readStack(doc.board.bag!, doc.board.copperStack).map((x) => (x.layer !== null && names.has(x.layer) ? { ...x, name: names.get(x.layer)! } : x));
  setStack(doc, rows).apply();
  doc.board.bag!.set('PLANE1NETNAME', 'GND');
  doc.board.bag!.set('PLANE2NETNAME', '+3V3');
  doc.dirty.add('Board6');
}

const summary = (html: string) => [...html.matchAll(/<tr><td><a href="#[^"]*">([^<]*)<\/a><\/td><td class="n">(\d+)<\/td><\/tr>/g)].map((m) => m[1]!.replace(/&#39;|&apos;/g, "'"));

describe('the Design Rule Verification Report (26.152)', () => {
  it('heads the demo board\'s rules as the suite does, in its order', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const kinds = drcSettings(doc).batch;
    const html = reportHtml(doc.name, drcRules(doc), kinds, runDrc(doc, kinds), 10, new Date('2026-11-09T12:00:00Z'));
    // The suite's own list for this board, less Power Plane Connect (which Konium doesn't check)
    expect(summary(html)).toEqual([
      'Clearance Constraint (Gap=10mil) (All),(All)',
      "Clearance Constraint (Gap=12mil) (InNetClass('Power')),(All)",
      'Short-Circuit Constraint (Allowed=No) (All),(All)',
      'Un-Routed Net Constraint ( (All) )',
      'Modified Polygon (Allow modified: No), (Allow shelved: No)',
      'Width Constraint (Min=10mil) (Max=40mil) (Preferred=20mil) (All)',
      'Hole Size Constraint (Min=1mil) (Max=100mil) (All)',
      'Hole To Hole Clearance (Gap=10mil) (All),(All)',
      'Minimum Solder Mask Sliver (Gap=10mil) (All),(All)',
      'Silk To Solder Mask (Clearance=5mil) (IsPad),(All)',
      'Silk to Silk (Clearance=10mil) (All),(All)',
      'Net Antennae (Tolerance=0mil) (All)',
      'Height Constraint (Min=0mil) (Max=1000mil) (Prefered=500mil) (All)',
    ]);
  });
  it('a plane none of its net reaches is no dead copper', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'PlaneTest.PcbDoc');
    sixLayers(doc);
    // The bottom GND pour taken away (GND stays joined by its top tracks); nothing of +3V3 reaches its plane
    removePrims(doc, doc.prims.filter((p) => 'polygon' in p && p.polygon !== undefined && p.polygon !== 65535)).apply();
    removePolygons(doc, doc.polygons.map((_, i) => i)).apply();
    const back = readPcbDoc(writePcbDoc(doc), 'PlaneTest.PcbDoc');
    const r = runDrc(back, drcSettings(back).batch);
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });
});
