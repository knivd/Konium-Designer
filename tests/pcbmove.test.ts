import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { bytesEqual } from '../src/formats/bin';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PcbGripTool, EDGE_GRIP, moveVertex, tidyVertices } from '../src/editors/pcb/PcbGripTool';
import { PlacePolygonTool } from '../src/editors/pcb/PlacePolygonTool';
import { PcbPasteTool } from '../src/editors/pcb/PcbPasteTool';
import { newPolygonBag } from '../src/app/dialogs/Polygon';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import { NO_NET, type PcbTrack } from '../src/model/pcb';
import type { ToolPointer } from '../src/core/tools';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const at = (x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer => ({ world: P(x, y), raw: P(x, y), button: 0, shift: false, ctrl: false, alt: false, ...extra });
const GND = 0;

function setup() {
  const bytes = demoPcbDoc();
  const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
  const ed = new PcbEditor(doc);
  ed.scene();
  return { bytes, doc, ed };
}
const copperOf = (ed: PcbEditor, i: number) => ed.doc.prims.filter((p) => 'polygon' in p && p.polygon === i);

describe('PCB selection and delete', () => {
  it('a click on pour copper selects the pour; Delete removes it and its copper, undo restores the file', () => {
    const { ed, bytes } = setup();
    ed.setCurrentLayer(L.BOTTOM);
    ed.pointerDown(at(10, 18));             // inside the bottom GND pour, clear of everything else
    ed.pointerUp(at(10, 18), false);
    expect([...ed.selection]).toEqual(['poly:0']);
    expect(ed.properties()[0]!.title).toBe('Polygon Pour');
    expect(copperOf(ed, 0).length).toBeGreaterThan(0);
    ed.deleteSelection();
    expect(ed.doc.polygons).toHaveLength(0);
    expect(copperOf(ed, 0)).toHaveLength(0);
    const again = readPcbDoc(writePcbDoc(ed.doc), 'x.PcbDoc');
    expect(again.polygons).toHaveLength(0);
    expect(again.prims.some((p) => 'polygon' in p && p.polygon !== NO_NET)).toBe(false);
    ed.undo.undo();
    expect(ed.doc.polygons).toHaveLength(1);
    expect(bytesEqual(writePcbDoc(ed.doc), bytes)).toBe(true);
  });

  it('a click on a pad selects its whole component; Delete removes it and renumbers the others', () => {
    const { ed } = setup();
    ed.pointerDown(at(13.05, 15));          // C1 pad 1
    ed.pointerUp(at(13.05, 15), false);
    const set = ed.moveSet();
    expect(set.components).toEqual([1]);
    ed.deleteSelection();
    expect(ed.doc.components.map((c) => c.designator)).toEqual(['J1', 'U1', 'C2']);
    // U1's pads now point at component 1
    const u1 = ed.doc.prims.filter((p) => p.kind === 'pad' && p.component === 1);
    expect(u1).toHaveLength(4);
    const again = readPcbDoc(writePcbDoc(ed.doc), 'x.PcbDoc');
    expect(again.components.map((c) => c.designator)).toEqual(['J1', 'U1', 'C2']);
  });

  it('a click on a designator selects only it; dragging moves only it', () => {
    const { ed } = setup();
    ed.pointerDown(at(12.3, 16.8));          // the C1 designator
    const sel = [...ed.selection];
    expect(sel).toHaveLength(1);
    const before = ed.doc.components[1]!.at;
    ed.pointerMove(at(14, 19));
    expect(ed.tool.id).toBe('pcb-move');
    ed.pointerMove(at(15.3, 19.8));
    ed.pointerUp(at(15.3, 19.8), true);
    expect(ed.doc.components[1]!.at).toEqual(before);
    const text = ed.doc.prims.find((p) => p.kind === 'text' && p.isDesignator && p.component === 1)!;
    expect(text.kind === 'text' && text.at.x).not.toBe(P(12.1, 16.4).x);
  });
});

describe('PCB move', () => {
  it('dragging a via drags the tracks ending on it', () => {
    const { ed } = setup();
    ed.setCurrentLayer(L.TOP);
    ed.pointerDown(at(16.6, 15));            // GND via
    expect(ed.moveSet().prims.map((p) => p.kind)).toEqual(['via']);
    ed.pointerMove(at(16.6, 16));
    ed.pointerMove(at(16.6 + 1.27, 15));
    ed.pointerUp(at(16.6 + 1.27, 15), true);
    const v = ed.doc.prims.find((p) => p.kind === 'via' && p.net === GND && p.at.y === P(0, 15).y && p.at.x !== P(16.6, 0).x);
    expect(v).toBeDefined();
    const to = v!.kind === 'via' ? v!.at : P(0, 0);
    const ends = ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.net === GND && p.polygon === NO_NET && ((p.a.x === to.x && p.a.y === to.y) || (p.b.x === to.x && p.b.y === to.y)));
    expect(ends.length).toBe(2);              // the top stub and the bottom track both follow
  });

  it('Ctrl+arrow nudges a component by the grid; a pour moves with its outline and repours', () => {
    const { ed } = setup();
    ed.selectComponent(3);                    // C2
    const c0 = ed.doc.components[3]!.at;
    ed.nudge(0, 1);
    expect(ed.doc.components[3]!.at).toEqual({ x: c0.x, y: c0.y + ed.gridSize() });
    ed.select(['poly:0']);
    const v0 = ed.doc.polygons[0]!.vertices[0]!.p;
    ed.nudge(-2, 0);
    expect(ed.doc.polygons[0]!.vertices[0]!.p).toEqual({ x: v0.x - 2 * ed.gridSize(), y: v0.y });
    expect(copperOf(ed, 0).length).toBeGreaterThan(0);
    ed.undo.undo(); ed.undo.undo();
    expect(ed.doc.components[3]!.at).toEqual(c0);
  });

  it('Rotate Selection turns a component about the selection centre', () => {
    const { ed } = setup();
    ed.selectComponent(2);                    // U1
    const r0 = ed.doc.components[2]!.rotation;
    ed.rotateSelection(1);
    expect(ed.doc.components[2]!.rotation).toBe((r0 + 90) % 360);
  });
});

describe('polygon editing', () => {
  it('vertex grips move a vertex, mid-edge grips add one, tidy drops collinear and doubled ones', () => {
    const sq = [{ p: { x: 0, y: 0 } }, { p: { x: 10, y: 0 } }, { p: { x: 10, y: 10 } }, { p: { x: 0, y: 10 } }];
    expect(moveVertex(sq, 2, { x: 12, y: 12 })[2]!.p).toEqual({ x: 12, y: 12 });
    const added = moveVertex(sq, EDGE_GRIP + 1, { x: 14, y: 5 });
    expect(added.map((v) => v.p)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 14, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(tidyVertices(moveVertex(sq, EDGE_GRIP + 1, { x: 10, y: 5 }))).toHaveLength(4);
    expect(tidyVertices(moveVertex(sq, 1, { x: 10, y: 10 }))).toHaveLength(3);
  });

  it('dragging a corner grip of the selected pour reshapes and repours it', () => {
    const { ed } = setup();
    ed.select(['poly:0']);
    const g = ed.grips();
    expect(g.filter((x) => x.index < EDGE_GRIP)).toHaveLength(4);
    expect(g.filter((x) => x.index >= EDGE_GRIP)).toHaveLength(4);
    const corner = g.find((x) => x.index === 2)!;
    ed.pointerDown({ world: corner.at, raw: corner.at, button: 0, shift: false, ctrl: false, alt: false });
    expect(ed.tool).toBeInstanceOf(PcbGripTool);
    const to = P(30, 15);
    ed.pointerMove({ world: to, raw: to, button: 0, shift: false, ctrl: false, alt: false });
    ed.pointerUp({ world: to, raw: to, button: 0, shift: false, ctrl: false, alt: false }, true);
    const vs = ed.doc.polygons[0]!.vertices.map((v) => v.p);
    expect(vs).toContainEqual(ed.snap(to));
    // The copper now stays inside the new outline
    const maxX = Math.max(...copperOf(ed, 0).flatMap((p) => (p.kind === 'region' ? p.outline.map((q) => q.x) : [])));
    expect(maxX).toBeLessThanOrEqual(P(39, 0).x);
  });

  it('Place › Polygon Pour: click vertices, right-click closes and pours; Polygon properties edit and repour', () => {
    const { ed } = setup();
    const bag = newPolygonBag(ed.doc, L.TOP, 1);        // VIN on top
    const tool = new PlacePolygonTool(ed, bag);
    ed.setTool(tool);
    for (const [x, y] of [[10, 5], [20, 5], [20, 9], [10, 9]] as const) { tool.pointerMove!(at(x, y)); tool.pointerDown!(at(x, y)); }
    expect(tool.cancel!()).toBe(true);
    expect(ed.doc.polygons).toHaveLength(2);
    const p1 = ed.doc.polygons[1]!;
    expect(p1.name).toBe('VIN_L1_P001');
    expect(p1.vertices).toHaveLength(4);
    expect(copperOf(ed, 1).length).toBeGreaterThan(0);
    // Round trip through the file
    const again = readPcbDoc(writePcbDoc(ed.doc), 'x.PcbDoc');
    expect(again.polygons.map((p) => p.name)).toEqual(['GND_L2_P000', 'VIN_L1_P001']);
    // Fill mode None from the Properties panel: outline tracks instead of a region
    ed.select(['poly:1']);
    const row = ed.properties()[0]!.rows.find((r) => r.label === 'Fill Mode')!;
    row.edit!('None');
    expect(ed.doc.polygons[1]!.hatch).toBe('None');
    expect(copperOf(ed, 1).every((p) => p.kind === 'track')).toBe(true);
  });
});

describe('PCB clipboard', () => {
  it('copy with a reference point, paste a component and a pour elsewhere; nets kept, pour repoured, one undo step', () => {
    const { ed } = setup();
    ed.selectComponent(3);                                  // C2
    ed.select(['poly:0'], true);
    ed.copy();
    expect(ed.tool.id).toBe('pick');
    ed.pointerDown(at(33, 15));                             // reference point
    expect(ed.tool.id).toBe('select');
    ed.cursor = P(33, 25);
    ed.paste();
    expect(ed.tool).toBeInstanceOf(PcbPasteTool);
    ed.tool.pointerMove!(at(33, 25));
    ed.tool.pointerDown!(at(33, 25));
    expect(ed.doc.components).toHaveLength(5);
    const c = ed.doc.components[4]!;
    expect(c.designator).toBe('C2');
    expect(c.at.y).toBe(ed.snap(P(33, 25)).y);
    const pads = ed.doc.prims.filter((p) => p.kind === 'pad' && p.component === 4);
    expect(pads.map((p) => p.kind === 'pad' && ed.doc.nets[p.net]?.name)).toEqual(['+3V3', 'GND']);
    expect(ed.doc.polygons).toHaveLength(2);
    expect(ed.doc.polygons[1]!.net).toBe(GND);
    expect(ed.undo.undoLabel).toBe('Paste 2 objects');
    const again = readPcbDoc(writePcbDoc(ed.doc), 'x.PcbDoc');
    expect(again.components).toHaveLength(5);
    expect(again.polygons).toHaveLength(2);
    ed.undo.undo();
    expect(ed.doc.components).toHaveLength(4);
    expect(ed.doc.polygons).toHaveLength(1);
  });
});
