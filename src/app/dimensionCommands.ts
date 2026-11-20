/**
 * Place › Dimension (Linear, Angular, Radial, Leader, Datum, Baseline, Center, Linear Diameter,
 * Radial Diameter, Dimension) and Tools › Convert › Explode Dimension to Free Primitives.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify } from './state';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PlaceDimensionTool } from '../editors/pcb/PlaceDimensionTool';
import { dimensionEdges, dimensionGeometry, removeDimensions } from '../model/dimensions';
import { addPrimRecords } from '../model/pcbEdit';
import { encodeArc, encodeText, encodeTrack } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';

// (boards only: a library footprint keeps no dimensions yet)
const BOTH: Scope[] = ['pcb'];
const ed = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };

export function dimensionCommands(): Command[] {
  const place = (id: string, label: string, kind: number): Command =>
    ({ id, label, scopes: BOTH, enabled: () => !!ed(), run: () => { const e = ed(); if (e) e.setTool(new PlaceDimensionTool(e, kind)); } });
  return [
    place('ad:PCB:PlaceDimensionLinear', 'Linear', 1),
    place('ad:PCB:PlaceDimensionAngular', 'Angular', 2),
    place('ad:PCB:PlaceDimensionRadial', 'Radial', 3),
    place('ad:PCB:PlaceDimensionLeader', 'Leader', 4),
    place('ad:PCB:PlaceDimensionDatum', 'Datum', 5),
    place('ad:PCB:PlaceDimensionBaseline', 'Baseline', 6),
    place('ad:PCB:PlaceDimensionCenter', 'Centre', 7),
    place('ad:PCB:PlaceDimensionLinearDiameter', 'Linear Diameter', 9),
    place('ad:PCB:PlaceDimensionRadialDiameter', 'Radial Diameter', 10),
    place('ad:PCB:PlaceDimension', 'Dimension', 8),
    // The selected dimensions become tracks, arcs and a text on their layer
    { id: 'ad:PCB:ExplodeDimensionToFreePrimitives', label: 'Explode Dimension to Free Primitives', scopes: BOTH, enabled: () => !!ed()?.selectedDimensions().length, run: () => {
      const e = ed();
      if (!e) return;
      const sel = e.selectedDimensions();
      if (!sel.length) { notify('Select dimensions to explode', 'error'); return; }
      const recs: { storage: string; rec: PcbRawRecord }[] = [];
      for (const i of sel) {
        const d = e.doc.dimensions[i]!, g = dimensionGeometry(d, false, dimensionEdges(e.doc.prims));
        for (const l of g.lines) recs.push({ storage: 'Tracks6', rec: encodeTrack({ layer: d.layer, a: { x: Math.round(l.a.x), y: Math.round(l.a.y) }, b: { x: Math.round(l.b.x), y: Math.round(l.b.y) }, width: Math.round(l.w) }) });
        for (const a of g.arcs) recs.push({ storage: 'Arcs6', rec: encodeArc({ layer: d.layer, c: { x: Math.round(a.c.x), y: Math.round(a.c.y) }, r: Math.round(a.r), start: a.start, end: a.end, width: Math.round(a.w) }) });
        for (const t of g.texts) recs.push({ storage: 'Texts6', rec: encodeText({ layer: d.layer, at: { x: Math.round(t.at.x), y: Math.round(t.at.y) }, height: Math.round(t.height), text: t.text, rotation: t.rotation, strokeWidth: Math.round(t.w), mirrored: t.mirrored }) });
      }
      e.undo.transact(`Explode ${sel.length} dimension${sel.length === 1 ? '' : 's'}`, (tx) => { tx.add(addPrimRecords(e.doc, recs)); tx.add(removeDimensions(e.doc, sel)); });
      e.selection.clear();
      e.invalidate();
    } },
  ];
}
