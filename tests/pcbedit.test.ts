import { describe, expect, it } from 'vitest';
import { decodePrim, encodeArc, encodeFill, encodePad, encodeRegion, encodeText, encodeTrack, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { placeRecord, placeable, storageFor } from '../src/formats/altium/pcblib';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { footprintDoc, newPcbLib, openPcbLib, writePcbLibDoc } from '../src/model/pcbLib';
import { addPrimRecords } from '../src/model/pcbEdit';
import { arrayClip, breakTrack, crossing, measurePrims, onLayer, padName, pointOnTrack, regionFromLoop, sliceTracks, stepPadName, trackEnds, withKeepout } from '../src/model/pcbTrackEdit';
import { bodyCandidates, bodyRecord, convexHull, defaultBody, editBody, layerWord, outlineKey, polygonArea, specOf } from '../src/model/bodies';
import { setBoardProps, setLayerNames } from '../src/model/pcbBoard';
import { PcbLibEditor } from '../src/editors/pcb/PcbLibEditor';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PCB_TAG, type PcbRawRecord } from '../src/formats/altium/framing';
import { L } from '../src/model/layers';
import { mil, mm } from '../src/core/units';
import type { PcbBody, PcbPrim, PcbText, PcbTrack } from '../src/model/pcb';
import type { PcbClip } from '../src/editors/clipboard';

const dec = (rec: PcbRawRecord, i = 0) => decodePrim(storageFor(rec.tag), rec, i, new Map())!;
const track = (x1: number, y1: number, x2: number, y2: number, layer: number = L.TOP) => encodeTrack({ layer, a: { x: mil(x1), y: mil(y1) }, b: { x: mil(x2), y: mil(y2) }, width: mil(10) });

describe('keepouts', () => {
  it('the keepout flag is byte 2 of the record, for tracks, arcs, fills and regions', () => {
    for (const rec of [track(0, 0, 100, 0), encodeArc({ layer: L.TOP, c: { x: 0, y: 0 }, r: mil(50), start: 0, end: 90, width: mil(10) }),
      encodeFill({ layer: L.TOP, a: { x: 0, y: 0 }, b: { x: mil(50), y: mil(50) } }), encodeRegion({ layer: L.TOP, outline: [{ x: 0, y: 0 }, { x: mil(50), y: 0 }, { x: 0, y: mil(50) }] })]) {
      const on = withKeepout(rec, true);
      expect((dec(on) as { keepout: boolean }).keepout).toBe(true);
      expect((dec(withKeepout(on, false)) as { keepout: boolean }).keepout).toBe(false);
      expect(rec.subs[0]![2]).toBe(0); // the original is left alone
    }
  });
});

describe('Break Track and Slice Tracks', () => {
  it('a track breaks into two meeting where it was clicked; not at an end', () => {
    const rec = track(0, 0, 200, 0), t = dec(rec) as PcbTrack;
    expect(pointOnTrack(t, { x: mil(80), y: mil(3) }, mil(1))).toEqual({ x: mil(80), y: 0 });
    expect(pointOnTrack(t, { x: mil(80), y: mil(30) }, mil(1))).toBeNull();
    const [a, b] = breakTrack(rec, t, { x: mil(80), y: 0 })!;
    expect(trackEnds(a)).toEqual([{ x: 0, y: 0 }, { x: mil(80), y: 0 }]);
    expect(trackEnds(b)).toEqual([{ x: mil(80), y: 0 }, { x: mil(200), y: 0 }]);
    expect(breakTrack(rec, t, { x: 0, y: 0 })).toBeNull();
  });
  it('the cutting line splits every free track it crosses, where it crosses', () => {
    const doc = footprintDoc('X', [track(0, 0, 200, 0), track(0, 100, 200, 100), track(0, 300, 200, 300)]);
    expect(crossing({ x: mil(50), y: -mil(50) }, { x: mil(50), y: mil(150) }, { x: 0, y: 0 }, { x: mil(200), y: 0 })).toEqual({ x: mil(50), y: 0 });
    const { edits, added } = sliceTracks(doc, { x: mil(50), y: -mil(50) }, { x: mil(50), y: mil(150) });
    expect(edits).toHaveLength(2);
    expect(added.map(trackEnds)).toEqual([[{ x: mil(50), y: 0 }, { x: mil(200), y: 0 }], [{ x: mil(50), y: mil(100) }, { x: mil(200), y: mil(100) }]]);
  });
});

describe('Measure Primitives and Create Region', () => {
  it('measures edge to edge, whatever the layers', () => {
    const doc = footprintDoc('X', [track(0, 0, 100, 0), track(0, 100, 100, 100, L.TOP_OVERLAY)]);
    const [a, b] = doc.prims as PcbTrack[];
    expect(measurePrims(doc, a!, b!)).toBeCloseTo(mil(90), -2);
    expect(measurePrims(doc, a!, a!)).toBe(0);
  });
  it('tracks closing a loop make a solid region on their layer; an open chain says why not', () => {
    const loop = footprintDoc('X', [track(0, 0, 100, 0), track(100, 0, 100, 100), track(100, 100, 0, 100), track(0, 100, 0, 0)]).prims as PcbTrack[];
    const r = regionFromLoop(loop);
    expect(typeof r).not.toBe('string');
    const p = dec(r as PcbRawRecord);
    expect(p.kind).toBe('region');
    expect((p as { outline: unknown[] }).outline).toHaveLength(4);
    expect(typeof regionFromLoop(loop.slice(0, 3))).toBe('string');
  });
});

describe('Paste Array and Paste Special', () => {
  const pad = (name: string, x: number) => encodePad({ name, layer: L.TOP, at: { x: mil(x), y: 0 }, w: mil(40), h: mil(40), shape: 'rect' });
  const clip = (): PcbClip => ({ kind: 'pcb', ref: { x: 0, y: 0 }, records: [{ storage: 'Pads6', rec: pad('1', 0) }], components: [], polygons: [], nets: new Map() });
  it('linear: copies a step apart, designators stepping by the increment', () => {
    const a = arrayClip(clip(), { count: 3, increment: 2, d: { x: mil(100), y: 0 } });
    expect(a.records.map((r) => padName(r.rec))).toEqual(['1', '3', '5']);
    expect(a.records.map((r) => (dec(r.rec) as { at: { x: number } }).at.x)).toEqual([0, mil(100), mil(200)]);
    expect(stepPadName('A9', 1)).toBe('A10');
    expect(stepPadName('GND', 1)).toBe('GND');
  });
  it('circular: each copy turned further about the centre', () => {
    const a = arrayClip({ ...clip(), records: [{ storage: 'Pads6', rec: pad('1', 100) }] }, { count: 4, increment: 1, centre: { x: 0, y: 0 }, angle: 90, rotateItems: true });
    const at = a.records.map((r) => (dec(r.rec) as { at: { x: number; y: number } }).at);
    expect(at.map((p) => [Math.round(p.x / mil(1)), Math.round(p.y / mil(1))])).toEqual([[100, 0], [0, 100], [-100, 0], [0, -100]]);
  });
  it('Paste on current layer moves free graphics, not pads', () => {
    const t = onLayer(track(0, 0, 10, 0), L.BOTTOM);
    expect((dec(t) as PcbTrack).layer).toBe(L.BOTTOM);
    const p = pad('1', 0);
    expect(onLayer(p, L.BOTTOM)).toBe(p);
  });
});

describe('3D bodies', () => {
  const square = [{ x: 0, y: 0 }, { x: mil(100), y: 0 }, { x: mil(100), y: mil(50) }, { x: 0, y: mil(50) }];
  it('a body record decodes as a body primitive with its heights, colour, side and layer', () => {
    const rec = bodyRecord({ ...defaultBody(mm(2)), standoff: mm(0.5), colour: '#336699', layer: L.MECH1 + 12, bottom: true, identifier: 'Case' }, square);
    const b = dec(rec) as PcbBody;
    expect(b.kind).toBe('body');
    expect(b).toMatchObject({ layer: L.MECH1 + 12, bottom: true, identifier: 'Case', modelType: 0, component: 0xffff });
    expect(b.overall).toBeCloseTo(mm(2), -2);
    expect(b.standoff).toBeCloseTo(mm(0.5), -2);
    expect(b.outline).toEqual(square);
    expect(specOf(b).colour).toBe('#336699');
  });
  it('cylinders and spheres keep their type and a round outline', () => {
    const c = dec(bodyRecord({ ...defaultBody(), type: 'cylinder', radius: mil(50), height: mm(3) }, square)) as PcbBody;
    expect(c.modelType).toBe(2);
    expect(c.overall).toBeCloseTo(mm(3), -2);
    const s = dec(bodyRecord({ ...defaultBody(), type: 'sphere', radius: mm(1) }, square)) as PcbBody;
    expect(s.modelType).toBe(3);
    expect(s.overall).toBeCloseTo(mm(2), -2);
  });
  it('the body manager offers, layer by layer, the bounding rectangle and each closed outline, then all layers', () => {
    const doc = footprintDoc('X', [
      // A closed overlay box (corners shared by two tracks each), drawn in any order
      track(-100, -60, 100, -60, L.TOP_OVERLAY), track(100, 60, 100, -60, L.TOP_OVERLAY), track(-100, 60, 100, 60, L.TOP_OVERLAY), track(-100, -60, -100, 60, L.TOP_OVERLAY),
      // a pin-1 dot (a full circle) and an open line, which is no shape
      encodeArc({ layer: L.TOP_OVERLAY, c: { x: -mil(80), y: mil(40) }, r: mil(5), start: 0, end: 360, width: mil(10) }), track(-100, -80, 100, -80, L.TOP_OVERLAY),
      encodePad({ name: '1', layer: L.TOP, at: { x: -mil(50), y: 0 }, w: mil(40), h: mil(40), shape: 'rect' }), encodePad({ name: '2', layer: L.TOP, at: { x: mil(50), y: 0 }, w: mil(40), h: mil(40), shape: 'rect' }),
      encodeText({ layer: L.TOP_OVERLAY, at: { x: mil(500), y: mil(500) }, height: mil(60), text: 'X' })]);
    const c = bodyCandidates(doc.prims);
    expect(c.map((x) => x.description)).toEqual([
      'Shape created from bounding rectangle on TopLayer',
      'Shape created from bounding rectangle on TopOverlay',
      'Polygonal shape created from primitives on TopOverlay',
      'Polygonal shape created from primitives on TopOverlay',
      'Shape created from bounding rectangle on All Layers',
    ]);
    expect(c[0]!.outline[0]).toEqual({ x: -mil(70), y: -mil(20) });         // round the pads
    const box = c.find((x) => x.kind === 'poly' && x.outline.length === 4)!;
    expect(polygonArea(box.outline)).toBe(mil(200) * mil(120));               // the centre lines of the box
    expect(Math.max(...c.at(-1)!.outline.map((p) => p.x))).toBe(mil(105));     // the text left out
    expect(layerWord(L.MECH1 + 12)).toBe('Mechanical13');
    expect(convexHull([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])).toHaveLength(4);
  });
  it('a body edited in place: heights, projection, layer, colour, opacity; undo restores it', () => {
    const lib = newPcbLib('L.PcbLib');
    const ed = new PcbLibEditor(lib);
    ed.undo.transact('Add body', (tx) => tx.add(addPrimRecords(ed.doc, [{ storage: 'ComponentBodies6', rec: bodyRecord(defaultBody(mm(1)), square) }])));
    const b = ed.doc.prims.find((p) => p.kind === 'body') as PcbBody;
    ed.undo.transact('Edit body', (tx) => tx.add(editBody(ed.doc, b, { standoff: mm(0.2), overall: mm(3), bottom: true, layer: L.MECH1 + 12, colour: '#336699', opacity: 0.5 })!));
    const e = ed.doc.prims.find((p) => p.kind === 'body') as PcbBody;
    expect([e.standoff, e.overall, e.bottom, e.layer, specOf(e).colour, e.opacity]).toEqual([mm(0.2), mm(3), true, L.MECH1 + 12, '#336699', 0.5]);
    expect(outlineKey(e.outline)).toBe(outlineKey([...square].reverse()));
    ed.undo.undo();
    expect((ed.doc.prims.find((p) => p.kind === 'body') as PcbBody).layer).toBe(L.MECH1);
  });
  it('bodies are selectable primitives in the footprint editor, edited from Properties, saved in the library', () => {
    const lib = newPcbLib('L.PcbLib');
    const ed = new PcbLibEditor(lib);
    ed.undo.transact('Add body', (tx) => tx.add(addPrimRecords(ed.doc, [{ storage: 'ComponentBodies6', rec: bodyRecord(defaultBody(mm(1)), square) }])));
    const body = ed.doc.prims.find((p) => p.kind === 'body') as PcbBody;
    expect(body).toBeTruthy();
    ed.scene();
    ed.selection = new Set(ed.keysFor(`ComponentBodies6:${body.src.index}`));
    const sec = ed.properties().find((s) => s.title === '3D Body')!;
    expect(sec).toBeTruthy();
    sec.rows.find((r) => r.label === 'Overall Height')!.edit!('3mm');
    expect((ed.doc.prims.find((p) => p.kind === 'body') as PcbBody).overall).toBeCloseTo(mm(3), -2);
    const back = openPcbLib(writePcbLibDoc(lib), 'L.PcbLib');
    expect(back.footprints[0]!.doc.prims.filter((p) => p.kind === 'body')).toHaveLength(1);
  });
  it('a footprint placed on a board takes its extruded bodies along (STEP bodies stay behind), moved and owned', () => {
    const rec = bodyRecord(defaultBody(), square);
    expect(placeable(rec)).toBe(true);
    const placed = dec(placeRecord(rec, mil(1000), mil(500), 3)) as PcbBody;
    expect(placed.outline[0]).toEqual({ x: mil(1000), y: mil(500) });
    expect(placed.component).toBe(3);
    expect(placeable(track(0, 0, 1, 1))).toBe(true);
  });
  it('board bodies decode alongside the rest, and Gerber layer use ignores them', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const bodies = doc.prims.filter((p) => p.kind === 'body') as PcbBody[];
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.component !== 0xffff)).toBe(true);
    expect(doc.diags.items.some((d) => /could not be read/.test(d.message))).toBe(false);
  });
});

describe('mechanical layer names', () => {
  it('renaming writes LAYERnNAME and keeps undo', () => {
    const bytes = demoPcbDoc();
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    ed.undo.transact('Rename', (tx) => tx.add(setLayerNames(doc, new Map([[L.MECH1, 'Assembly']]))));
    expect(doc.board.layerNames.get(L.MECH1)).toBe('Assembly');
    expect(readPcbDoc(writePcbDoc(doc), 'x').board.layerNames.get(L.MECH1)).toBe('Assembly');
    ed.undo.undo();
    expect(doc.board.bag!.get(`LAYER${L.MECH1}NAME`)).toBe('Mechanical 1');
  });
});

export type { PcbPrim };
void PCB_TAG;

describe('object hotspot snapping and Drag Track End', () => {
  it('placing snaps to a pad centre within range; Shift+E turns it off; selecting never snaps', async () => {
    const { PlaceTrackTool } = await import('../src/editors/pcb/PlaceTrackTool');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const pad = doc.prims.find((p) => p.kind === 'pad' && p.at.x % mil(5) !== 0) ?? doc.prims.find((p) => p.kind === 'pad')!;
    const at = (pad as { at: { x: number; y: number } }).at, near = { x: at.x + mil(3), y: at.y - mil(2) };
    expect(ed.snapPointer(near)).toEqual(ed.snap(near));            // the select tool: grid only
    ed.setTool(new PlaceTrackTool(ed));
    expect(ed.snapPointer(near)).toEqual(at);
    expect(ed.snapPointer({ x: at.x + mil(30), y: at.y })).toEqual(ed.snap({ x: at.x + mil(30), y: at.y }));
    ed.hotspotSnap = false;
    expect(ed.snapPointer(near)).toEqual(ed.snap(near));
  });
  it('Drag Track End: click near an end, click where it goes; the other end stays', async () => {
    const { DragTrackEndTool } = await import('../src/editors/pcb/PcbEditTools');
    const doc = footprintDoc('X', [track(0, 0, 200, 0)]);
    const ed = new PcbEditor(doc);
    ed.scene();
    const tool = new DragTrackEndTool(ed);
    ed.setTool(tool);
    const pt = (x: number, y: number) => ({ world: { x: mil(x), y: mil(y) }, raw: { x: mil(x), y: mil(y) }, button: 0, shift: false, ctrl: false, alt: false });
    tool.pointerDown(pt(190, 2));
    tool.pointerDown(pt(250, 100));
    expect((doc.prims[0] as PcbTrack).a).toEqual({ x: 0, y: 0 });
    expect((doc.prims[0] as PcbTrack).b).toEqual({ x: mil(250), y: mil(100) });
  });
});

describe('routing by net and connection; explode; lock', () => {
  const load = () => { const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'); return { doc, ed: new PcbEditor(doc) }; };
  it('a physical connection runs from pad to pad over tracks and vias; Un-Route takes it away, undo puts it back', async () => {
    const { physicalConnection, netRouting, componentRouting, componentNets } = await import('../src/model/pcbNets');
    const { removePrims } = await import('../src/model/pcbEdit');
    const { doc, ed } = load();
    const i = doc.prims.findIndex((p) => p.kind === 'track' && p.net !== 0xffff && p.polygon === 0xffff && p.component === 0xffff);
    const conn = physicalConnection(doc, i);
    expect(conn.length).toBeGreaterThan(0);
    expect(conn.every((p) => p.kind === 'track' || p.kind === 'arc' || p.kind === 'via')).toBe(true);
    const net = (doc.prims[i] as PcbTrack).net;
    expect(netRouting(doc, net).length).toBeGreaterThanOrEqual(conn.length);
    const n0 = doc.prims.length;
    ed.undo.transact('Un-Route', (tx) => tx.add(removePrims(doc, conn)));
    expect(doc.prims.length).toBe(n0 - conn.length);
    ed.undo.undo();
    expect(doc.prims.length).toBe(n0);
    const c = doc.components.findIndex((k) => componentRouting(doc, k.index).length > 0);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(componentNets(doc, c).size).toBeGreaterThan(0);
  });
  it('Explode Component: its primitives go free, the designator stays as a string, the component goes', async () => {
    const { explodeComponents } = await import('../src/model/pcbEdit');
    const { doc, ed } = load();
    const comp = doc.components[0]!, nComp = doc.components.length;
    const pads = doc.prims.filter((p) => p.kind === 'pad' && p.component === 0).length;
    ed.undo.transact('Explode', (tx) => tx.add(explodeComponents(doc, [0])));
    expect(doc.components).toHaveLength(nComp - 1);
    expect(doc.prims.filter((p) => p.kind === 'pad' && p.component === 0xffff).length).toBeGreaterThanOrEqual(pads);
    expect(doc.prims.some((p) => p.kind === 'text' && p.component === 0xffff && p.text === comp.designator && !p.isDesignator)).toBe(true);
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(back.components).toHaveLength(nComp - 1);
    ed.undo.undo();
    expect(doc.components).toHaveLength(nComp);
    expect(doc.components[0]!.designator).toBe(comp.designator);
  });
  it('Explode Polygon: the poured copper stays, free; the pour goes', async () => {
    const { explodePolygons } = await import('../src/model/pcbEdit');
    const { doc, ed } = load();
    const copper = doc.prims.filter((p) => 'polygon' in p && p.polygon === 0).length;
    expect(copper).toBeGreaterThan(0);
    const n = doc.polygons.length;
    ed.undo.transact('Explode', (tx) => tx.add(explodePolygons(doc, [0])));
    expect(doc.polygons).toHaveLength(n - 1);
    expect(doc.prims.filter((p) => 'polygon' in p && p.polygon === 0xffff && p.kind === 'region').length).toBeGreaterThanOrEqual(1);
  });
});

describe('3D body identifiers', () => {
  it('are kept as character codes, as Altium writes them', async () => {
    const { bodyIdentifier, bodyIdentifierValue } = await import('../src/formats/altium/pcbdoc');
    expect(bodyIdentifier('70,105,100,117,99,105,97,108')).toBe('Fiducial');
    expect(bodyIdentifierValue('Fiducial')).toBe('70,105,100,117,99,105,97,108');
    expect(bodyIdentifier('')).toBe('');
  });
});

describe('26.022 answers', () => {
  it('Clear All Nets: the nets go, everything is on No Net, the pours stay; undo brings it all back', async () => {
    const { clearAllNets } = await import('../src/model/pcbEdit');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const nets = doc.nets.length, pours = doc.polygons.length;
    ed.undo.transact('Clear', (tx) => tx.add(clearAllNets(doc)));
    expect(doc.nets).toHaveLength(0);
    expect(doc.prims.every((p) => !('net' in p) || p.net === 0xffff)).toBe(true);
    expect(doc.polygons).toHaveLength(pours);
    expect(doc.polygons.every((p) => p.net === 0xffff)).toBe(true);
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(back.nets).toHaveLength(0);
    ed.undo.undo();
    expect(doc.nets).toHaveLength(nets);
    expect(doc.prims.some((p) => 'net' in p && p.net !== 0xffff)).toBe(true);
  });
  it('object hotspot snapping is a board option: saved with the board, undone like any edit', async () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    expect(ed.hotspotSnap).toBe(true);
    expect(ed.hotspotRange).toBe(mil(8));
    ed.undo.transact('Off', (tx) => tx.add(setBoardProps(doc, { ELECTRICALGRIDENABLED: 'FALSE', ELECTRICALGRIDRANGE: '4mil' })));
    expect(ed.hotspotSnap).toBe(false);
    expect(ed.hotspotRange).toBe(mil(4));
    expect(readPcbDoc(writePcbDoc(doc), 'x').board.bag!.get('ELECTRICALGRIDENABLED')).toBe('FALSE');
    ed.undo.undo();
    expect(ed.hotspotSnap).toBe(true);
  });
});

describe('3D bodies in 2D', () => {
  it('are cross-hatched inside their outline', async () => {
    const { crossHatch } = await import('../src/model/bodies');
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const h = crossHatch(sq, 10);
    expect(h.length).toBeGreaterThan(20);
    for (const [a, b] of h) for (const p of [a, b]) { expect(p.x).toBeGreaterThanOrEqual(-1e-6); expect(p.x).toBeLessThanOrEqual(100 + 1e-6); expect(p.y).toBeGreaterThanOrEqual(-1e-6); expect(p.y).toBeLessThanOrEqual(100 + 1e-6); }
    const dirs = new Set(h.map(([a, b]) => Math.sign((b.x - a.x) * (b.y - a.y))));
    expect(dirs).toEqual(new Set([1, -1]));
  });
});

describe('component placement tools', () => {
  const load = () => { const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'); const ed = new PcbEditor(doc); ed.scene(); return { doc, ed }; };
  it('autoposition puts a text above, beside or below the part as Altium numbers the places', async () => {
    const { autoposition } = await import('../src/model/pcbPlacement');
    const box = { minX: 0, minY: 0, maxX: mil(100), maxY: mil(50) };
    const t = { kind: 'text', at: { x: 0, y: 0 }, height: mil(40), rotation: 0, mirrored: false, text: 'R1' } as PcbText;
    const top = autoposition(1, box, t)!, bottom = autoposition(3, box, t)!, right = autoposition(8, box, t)!, centre = autoposition(5, box, t)!;
    expect(top.x).toBe(0);
    expect(top.y).toBeGreaterThan(mil(50));
    expect(bottom.y + mil(40)).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(mil(100));
    expect(Math.abs(centre.y + mil(20) - mil(25))).toBeLessThan(2);
    expect(autoposition(0, box, t)).toBeNull();
  });
  it('positional re-annotation numbers each prefix in the order asked', async () => {
    const { reannotation } = await import('../src/model/pcbPlacement');
    const { ed } = load();
    const xy = reannotation(ed.doc, 'xy', (c) => ed.boundsOf(ed.componentKeys(c).filter((k) => ed.primByKey(k)?.kind !== 'text')));
    const byPrefix = new Map<string, string[]>();
    for (const r of xy) { const p = r.to.replace(/\d+$/, ''); byPrefix.set(p, [...(byPrefix.get(p) ?? []), r.to]); }
    for (const [p, names] of byPrefix) expect(names.sort()).toEqual(names.map((_, i) => `${p}${i + 1}`).sort());
    // Ascending X: the first of a prefix is the leftmost
    const first = xy.find((r) => r.to === 'C1');
    if (first) { const cs = ed.doc.components.filter((c) => c.designator.startsWith('C')); const left = Math.min(...cs.map((c) => c.at.x)); expect(Math.abs(ed.doc.components[first.index]!.at.x - left)).toBeLessThan(mil(400)); }
  });
  it('free primitives on pads take the pads\' nets', async () => {
    const { netsFromPads } = await import('../src/model/pcbNets');
    const { replaceRecords, retarget } = await import('../src/model/pcbEdit');
    const { doc, ed } = load();
    // Strip the net off a routed track: the update gives it back
    const t = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net !== 0xffff && p.polygon === 0xffff && p.component === 0xffff)!;
    const net = t.net;
    ed.undo.transact('Strip', (tx) => tx.add(replaceRecords(doc, [{ storage: t.src.storage, index: t.src.index, after: retarget(doc.streams.get(t.src.storage)!.records[t.src.index]!, { net: () => 0xffff }) }])));
    const { changes } = netsFromPads(doc);
    const mine = changes.find((c) => c.prim.src.index === t.src.index && c.prim.src.storage === t.src.storage);
    expect(mine?.net).toBe(net);
  });
  it('applicable rules: the clearance rule between two copper objects, the width rule of a track', async () => {
    const { applicableRules } = await import('../src/model/drc');
    const { doc } = load();
    const tracks = doc.prims.filter((p) => p.kind === 'track' && isCopper(p.layer));
    const unary = applicableRules(doc, tracks[0]!);
    expect(unary.some((r) => r.kind === 'Width' && r.wins)).toBe(true);
    expect(unary.some((r) => r.kind === 'Clearance')).toBe(false);
    const binary = applicableRules(doc, tracks[0]!, tracks[1]!);
    expect(binary.some((r) => r.kind === 'Clearance' && r.wins)).toBe(true);
  });
});
const isCopper = (l: number) => l >= 1 && l <= 32;

describe('Netlist Manager', () => {
  it('renames a net, deletes one (its objects to No Net, later indices down one), undo restores', async () => {
    const { removeNet, renameNet } = await import('../src/model/pcbEdit');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const n = doc.nets.length, last = doc.nets[n - 1]!.name;
    const onLast = doc.prims.filter((p) => 'net' in p && p.net === n - 1).length;
    ed.undo.transact('Rename', (tx) => tx.add(renameNet(doc, 0, 'RENAMED')));
    expect(readPcbDoc(writePcbDoc(doc), 'x').nets[0]!.name).toBe('RENAMED');
    const onFirst = doc.prims.filter((p) => 'net' in p && p.net === 0).length;
    ed.undo.transact('Delete', (tx) => tx.add(removeNet(doc, 0)));
    expect(doc.nets).toHaveLength(n - 1);
    expect(doc.nets[n - 2]!.name).toBe(last);
    expect(doc.prims.filter((p) => 'net' in p && p.net === n - 2).length).toBe(onLast);
    expect(doc.prims.filter((p) => 'net' in p && p.net === 0xffff).length).toBeGreaterThanOrEqual(onFirst);
    ed.undo.undo(); ed.undo.undo();
    expect(doc.nets).toHaveLength(n);
    expect(doc.nets[0]!.name).not.toBe('RENAMED');
  });
});
