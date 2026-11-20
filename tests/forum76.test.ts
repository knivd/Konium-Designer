import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { footprintDoc } from '../src/model/pcbLib';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PlaceTrackTool } from '../src/editors/pcb/PlaceTrackTool';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { PCB_CORNER_MODES, arcKey, arcRadius, cornerArc, cornerLabel, cornerPath } from '../src/editors/corner';
import { styleCorners } from '../src/model/hugStyle';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { updateSettings, settings } from '../src/core/settings';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbArc, PcbTrack } from '../src/model/pcb';

const pt = (x: number, y: number, button = 0) => ({ world: { x: mil(x), y: mil(y) }, raw: { x: mil(x), y: mil(y) }, button, shift: false, ctrl: false, alt: false });
afterEach(() => { cornerArc.r = 0; });

describe('corner modes as AD: 45°, 45° with arc, 90°, 90° with arc, any angle', () => {
  it('Shift+Space cycles the five for tracks and lines; an arc mode corners as its own mode, the arc on top', () => {
    expect(PCB_CORNER_MODES).toEqual(['45', '45arc', '90', '90arc', 'any']);
    const s = { x: 0, y: 0 }, c = { x: mil(100), y: mil(40) };
    expect(cornerPath(s, c, '45arc', false)).toEqual(cornerPath(s, c, '45', false));
    expect(cornerPath(s, c, '90arc', true)).toEqual(cornerPath(s, c, '90', true));
    expect(cornerLabel('90arc', false)).toBe('90° with arc start');
  });
  it(', and . shrink and grow the arcs (Shift faster), never below half the width', () => {
    expect(arcRadius(mil(10))).toBe(mil(40));
    arcKey('.', mil(10));
    expect(cornerArc.r).toBe(Math.round(mil(40) * 1.1));
    arcKey('<', mil(10));
    expect(cornerArc.r).toBeLessThan(mil(40));
    for (let i = 0; i < 60; i++) arcKey(',', mil(10));
    expect(cornerArc.r).toBe(mil(5));
    expect(arcKey('x', mil(10))).toBe(false);
  });
  it('a corner rounded by an arc of the radius asked for, tangent to both legs (lines: no clearance to keep)', () => {
    const t = (a: [number, number], b: [number, number]) => ({ layer: L.TOP, a: { x: mil(a[0]), y: mil(a[1]) }, b: { x: mil(b[0]), y: mil(b[1]) }, width: mil(10) });
    const r = styleCorners([t([0, 0], [100, 0]), t([100, 0], [100, 100])], 'arcs', () => null, { radius: mil(30) });
    expect(r.arcs).toHaveLength(1);
    expect(r.arcs[0]).toMatchObject({ r: mil(30), c: { x: mil(70), y: mil(30) } });
    expect(r.tracks.map((x) => [x.a, x.b])).toEqual([[{ x: 0, y: 0 }, { x: mil(70), y: 0 }], [{ x: mil(100), y: mil(30) }, { x: mil(100), y: mil(100) }]]);
    // A radius the legs can't take: as large as they allow (half the shorter leg)
    const big = styleCorners([t([0, 0], [40, 0]), t([40, 0], [40, 100])], 'arcs', () => null, { radius: mil(500) });
    expect(big.arcs[0]!.r).toBe(mil(20));
  });
  it('Place Track in 90° with arc: the corner placed as tracks and an arc', () => {
    const doc = footprintDoc('X', []);
    const ed = new PcbEditor(doc);
    ed.scene();
    const tool = new PlaceTrackTool(ed);
    ed.setTool(tool);
    while (cornerLabel((tool as unknown as { mode: '45' }).mode, false) !== '90° with arc start') tool.key('Shift+Space');
    tool.pointerDown(pt(0, 0)); tool.pointerMove(pt(200, 200)); tool.pointerDown(pt(200, 200));
    expect(tool.hint()).toMatch(/radius 40mil: , \. smaller, larger/);
    tool.cancel();
    const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track'), arcs = doc.prims.filter((p): p is PcbArc => p.kind === 'arc');
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.r).toBe(mil(40));
    expect(tracks).toHaveLength(2);
    expect(tracks.map((x) => x.layer)).toEqual([ed.currentLayer, ed.currentLayer]);
  });
  it('Interactive Routing cycles the five (any angle left out with Restrict To 90/45) and , . change the arc only in the arc modes', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const tool = new RouteTool(ed);
    const seen: string[] = [];
    const was = settings.pcbRestrict9045;
    updateSettings({ pcbRestrict9045: true });
    for (let i = 0; i < 5; i++) { tool.key('Shift+Space'); seen.push((tool as unknown as { corner: string }).corner); }
    expect(new Set(seen)).toEqual(new Set(['45', '45arc', '90', '90arc']));
    updateSettings({ pcbRestrict9045: false });
    seen.length = 0;
    for (let i = 0; i < 5; i++) { tool.key('Shift+Space'); seen.push((tool as unknown as { corner: string }).corner); }
    expect(new Set(seen)).toEqual(new Set(PCB_CORNER_MODES));
    while ((tool as unknown as { corner: string }).corner !== '45') tool.key('Shift+Space');
    expect(tool.key('.')).toBe(false);
    tool.key('Shift+Space');
    expect(tool.key('.')).toBe(true);
    expect(cornerArc.r).toBeGreaterThan(0);
    updateSettings({ pcbRestrict9045: was });
  });
  it('Interactive Routing in 45° with arc: the route placed with its corners as arcs', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    ed.scene();
    const was = settings.pcbRoutingMode;
    updateSettings({ pcbRoutingMode: 'ignore' });
    const pad = doc.prims.find((p) => p.kind === 'pad' && p.net >= 0 && p.layer === L.TOP)! as { at: { x: number; y: number } };
    const tool = new RouteTool(ed);
    ed.setTool(tool);
    while ((tool as unknown as { corner: string }).corner !== '45arc') tool.key('Shift+Space');
    tool.key('1'); // both segments placed on a click (no look-ahead)
    const go = (dx: number, dy: number) => ({ world: { x: pad.at.x + mil(dx), y: pad.at.y + mil(dy) }, raw: { x: pad.at.x + mil(dx), y: pad.at.y + mil(dy) }, button: 0, shift: false, ctrl: false, alt: false });
    const arcsBefore = doc.prims.filter((p) => p.kind === 'arc').length;
    tool.pointerMove(go(0, 0)); tool.pointerDown(go(0, 0));
    tool.pointerMove(go(400, 150)); tool.pointerDown(go(400, 150));
    tool.cancel();
    const arcs = doc.prims.filter((p): p is PcbArc => p.kind === 'arc');
    expect(arcs.length).toBe(arcsBefore + 1);
    expect(arcs.at(-1)!.r).toBe(arcRadius(ed.trackWidth));
    updateSettings({ pcbRoutingMode: was });
  });
});
