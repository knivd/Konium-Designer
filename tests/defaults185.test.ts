/**
 * PCB Editor › Defaults (26.185): the kinds the desktop software's list has and this one lacked.
 * Each kind of dimension a set of its own (from Dimension's, keeping what it has otherwise), a 3D
 * body, the drill and layer stack tables' text, and a keepout track's and arc's line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAG_FIELDS, BAG_KINDS, DIMENSION_KINDS, bagDefaults, changedBagDefaults, hasBagDefaults, reloadBagDefaults, resetBagDefaults, setBagDefaults } from '../src/model/bagDefaults';
import { DIM_KINDS, newDimension } from '../src/model/dimensions';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PlaceTrackTool } from '../src/editors/pcb/PlaceTrackTool';
import { placeArcCentreTool, placeCircleTool } from '../src/editors/pcb/PcbPlaceTools';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import type { ToolPointer } from '../src/core/tools';
import type { PcbArc, PcbTrack } from '../src/model/pcb';

const at = (x: number, y: number): ToolPointer => ({ world: { x: mil(x), y: mil(y) }, raw: { x: mil(x), y: mil(y) }, button: 0, shift: false, ctrl: false, alt: false });

describe('PCB Editor › Defaults: the kinds added (26.185)', () => {
  beforeEach(() => { resetBagDefaults(); reloadBagDefaults(); });
  afterEach(() => { resetBagDefaults(); reloadBagDefaults(); });

  it('eighteen sets of properties now: the four there were, nine kinds of dimension, a 3D body, two tables and two keepouts', () => {
    expect(BAG_KINDS).toHaveLength(18);
    expect(DIMENSION_KINDS.map((k) => k.replace(/ Dimension$/, '')).sort()).toEqual(DIM_KINDS.map(([, n]) => n).filter((n) => n !== 'Dimension').sort());
    for (const k of DIMENSION_KINDS) expect(BAG_FIELDS[k]).toBe(BAG_FIELDS.Dimension);
    expect(BAG_FIELDS['Component Body'].map((f) => f.key)).toEqual(['OVERALL', 'STANDOFF', 'SIDE', 'OPACITY']);
    expect(bagDefaults('Keepout Track')).toEqual({ LINEWIDTH: '0mil' }); expect(bagDefaults('Drill Table')).toEqual({ TEXTHEIGHT: '60mil' });
  });

  it('a kind of dimension starts from Dimension\'s and keeps only what it has otherwise', () => {
    expect(bagDefaults('Linear Dimension')).toEqual(bagDefaults('Dimension'));
    setBagDefaults('Dimension', { ...bagDefaults('Dimension'), TEXTHEIGHT: '80mil' });
    expect(bagDefaults('Linear Dimension').TEXTHEIGHT).toBe('80mil'); expect(hasBagDefaults('Linear Dimension')).toBe(false);
    setBagDefaults('Linear Dimension', { ...bagDefaults('Linear Dimension'), ARROWSIZE: '40mil' });
    expect(changedBagDefaults('Linear Dimension')).toEqual({ ARROWSIZE: '40mil' });
    expect(bagDefaults('Angular Dimension').ARROWSIZE).toBe('60mil');
    // Dimension changed again: the kind follows it in what it has not changed itself
    setBagDefaults('Dimension', { ...bagDefaults('Dimension'), TEXTHEIGHT: '50mil' });
    expect(bagDefaults('Linear Dimension')).toMatchObject({ TEXTHEIGHT: '50mil', ARROWSIZE: '40mil' });
  });

  it('a dimension placed takes Dimension\'s changes and then its own kind\'s', () => {
    setBagDefaults('Dimension', { ...bagDefaults('Dimension'), TEXTHEIGHT: '80mil' });
    setBagDefaults('Linear Dimension', { ...bagDefaults('Linear Dimension'), ARROWSIZE: '40mil', TEXTHEIGHT: '70mil' });
    const opts = (kind: number) => ({ kind, at: { x: mil(1000), y: mil(1000) }, refs: [{ x: mil(1000), y: mil(1000) }, { x: mil(2000), y: mil(1000) }], angle: 0, layer: L.MECH1, metric: false }) as Parameters<typeof newDimension>[0];
    const make = (kind: number) => newDimension(opts(kind), 0, undefined, true).bag;
    const linear = make(1), datum = make(5), standard = make(8), plain = newDimension(opts(1), 0).bag;
    expect([linear.get('TEXTHEIGHT'), linear.get('ARROWSIZE')]).toEqual(['70mil', '40mil']);
    expect([datum.get('TEXTHEIGHT'), datum.get('ARROWSIZE')]).toEqual(['80mil', '60mil']);
    expect([standard.get('TEXTHEIGHT'), standard.get('ARROWSIZE')]).toEqual(['80mil', '60mil']);
    // (one made without the user's defaults, as the demo board's are, keeps the usual ones)
    expect([plain.get('TEXTHEIGHT'), plain.get('ARROWSIZE')]).toEqual(['60mil', '60mil']);
  });

  it('a keepout track and a keepout arc take their line\'s width from their defaults; a track and an arc do not', () => {
    const ed = new PcbEditor(readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc'));
    ed.scene(); ed.currentLayer = L.TOP; ed.trackWidth = mil(12);
    let row = 0;
    const draw = (keepout: boolean): number => {
      const y = 2000 + 100 * row++, tool = new PlaceTrackTool(ed, keepout);
      ed.setTool(tool);
      tool.pointerMove(at(2000, y)); tool.pointerDown(at(2000, y)); tool.pointerMove(at(2400, y)); tool.pointerDown(at(2400, y));
      tool.cancel(); ed.setTool(null);
      const added = ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.a.y === mil(y) && p.b.y === mil(y));
      expect(added).toHaveLength(1); expect(!!added[0]!.keepout).toBe(keepout);
      return added[0]!.width;
    };
    const circle = (keepout: boolean): number => {
      const y = 3000 + 600 * row++, tool = placeCircleTool(ed, keepout);
      ed.setTool(tool);
      tool.pointerMove?.(at(3000, y)); tool.pointerDown?.(at(3000, y)); tool.pointerMove?.(at(3200, y)); tool.pointerDown?.(at(3200, y));
      ed.setTool(null);
      const added = ed.doc.prims.filter((p): p is PcbArc => p.kind === 'arc' && p.c.y === mil(y));
      expect(added).toHaveLength(1);
      return added[0]!.width;
    };
    // As they were: the routing width
    expect([draw(false), draw(true), circle(false), circle(true)]).toEqual([mil(12), mil(12), mil(12), mil(12)]);
    setBagDefaults('Keepout Track', { LINEWIDTH: '5mil' }); setBagDefaults('Keepout Arc', { LINEWIDTH: '7mil' });
    expect([draw(false), draw(true), circle(false), circle(true)]).toEqual([mil(12), mil(5), mil(12), mil(7)]);
    expect(placeArcCentreTool(ed, true).id).toBe('place-keepout-arc-centre');
  });
});
