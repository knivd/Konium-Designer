import { afterEach, describe, expect, it } from 'vitest';
import viewConfigSrc from '../src/app/dialogs/ViewConfig.tsx?raw';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS, hexToRgb } from '../src/core/settings';
import { VIEW3D_DEFAULT } from '../src/core/view3d';
import { L, mechLayer } from '../src/model/layers';
import { addNet, addTracks } from '../src/model/pcbEdit';
import { setBoardProps } from '../src/model/pcbBoard';
import { sheetOf, setSheetLinked, linkedExtent } from '../src/model/sheet';
import { routeCuts, routeToolLayer } from '../src/model/routeToolPath';
import { buildBoardModel } from '../src/render/gl3d/boardModel';
import { putDrawn } from '../src/app/pcbGridCommands';
import { coordinateMarker } from '../src/model/boardTables';
import { MeasureTool } from '../src/editors/MeasureTool';
import { connectionLines } from '../src/model/drc';
import { mil } from '../src/core/units';
import type { Scene } from '../src/render/Scene';
import type { PcbPad, PcbText, PcbTrack } from '../src/model/pcb';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const board = () => { const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc')); ed.scene(); return ed; };
const fresh = (ed: PcbEditor): Scene => { ed.invalidate(); return ed.scene(); };
const M2 = mechLayer(2);

describe('View Configurations once greyed (26.108)', () => {
  it('nothing in the dialog is marked as not built; the new settings have AD\'s defaults', () => {
    expect(viewConfigSrc).not.toMatch(/Not in Konium yet|not in Konium yet/);
    expect(DEFAULTS).toMatchObject({ pcbMechSingleLayer: [], pcbDraftKinds: [], pcbConvertSpecial: true, pcbConnectionLayerColours: false, pcbShowRefPoint: false, pcbShowTestPoints: false,
      pcbShowStatusInfo: true, pcbAllConnectionsSingle: false, pcbPlaneDrawing: 'outlined', pcbNewNetColour: '#9ea175', pcbSheetLineColour: '#000000', pcbSheetAreaColour: '#ffffff' });
    expect(VIEW3D_DEFAULT).toMatchObject({ showRooms: false, showRoutePath: true });
  });

  it('Draft draws a kind as outlines; Coordinates are the objects Place › Coordinate makes', () => {
    const ed = board();
    const top = () => fresh(ed).groups.get(`L${L.TOP}`)!;
    const final = { tris: top().tris.count, prims: top().prims.count };
    settings.pcbDraftKinds = ['track', 'arc', 'pad', 'fill', 'region', 'polygon'];
    const draft = { tris: top().tris.count, prims: top().prims.count };
    expect(draft.prims).toBeGreaterThan(final.prims);
    expect(draft.tris).toBeLessThanOrEqual(final.tris);
    // A coordinate: hidden as its own kind, the rest stays
    putDrawn(ed, coordinateMarker(ed.doc, { x: mil(500), y: mil(500) }, 'mil'), L.TOP_OVERLAY, 'Coordinates', 'Place coordinate', mil(10), mil(40));
    fresh(ed);
    const n = ed.doc.prims.length;
    const shown = () => { fresh(ed); return new Set((ed as unknown as { items: { key: string }[] }).items.map((i) => i.key)).size; };
    const all = shown();
    settings.pcbHiddenKinds = ['coordinate'];
    expect(shown()).toBe(all - 3);
    expect(ed.doc.prims.length).toBe(n);
  });

  it('a mechanical layer kept in single layer mode; one linked to the sheet shows with it and, locked, can\'t be picked', () => {
    const ed = board();
    addTracks(ed.doc, [{ layer: M2, a: { x: mil(100), y: mil(100) }, b: { x: mil(400), y: mil(100) }, width: mil(10), net: 0xffff }]).apply();
    const at = { x: mil(250), y: mil(100) };
    const picks = () => { fresh(ed); return ed.hits(at).some((h) => h.layer === M2); };
    expect(picks()).toBe(true);
    ed.currentLayer = L.TOP; ed.singleLayer = 'hide';
    expect(picks()).toBe(false);
    settings.pcbMechSingleLayer = [M2];
    expect(picks()).toBe(true);
    ed.singleLayer = 'off';
    // Linked to the sheet: shown only with it
    expect(sheetOf(ed.doc)).toMatchObject({ show: false, linked: new Set() });
    setSheetLinked(ed.doc, new Set([M2])).apply();
    expect(sheetOf(ed.doc).linked.has(M2)).toBe(true);
    expect(picks()).toBe(false);
    setBoardProps(ed.doc, { SHOWSHEET: 'TRUE', LOCKSHEET: 'FALSE' }).apply();
    expect(picks()).toBe(true);
    expect(fresh(ed).groups.get('sheet')!.tris.count).toBeGreaterThan(0);
    setBoardProps(ed.doc, { LOCKSHEET: 'TRUE' }).apply();
    expect(picks()).toBe(false);
    expect(linkedExtent(ed.doc)).toMatchObject({ minX: mil(95), maxX: mil(405) });
  });

  it('connections: only the current layer\'s in single layer mode (unless all are asked for), and in their ends\' layer colours', () => {
    const ed = board();
    const lines = connectionLines(ed.doc, settings.pcbSmartTrackEnds);
    if (!lines.length) {
      // The demo is routed: take a net's tracks up so it has connection lines
      const net = ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net !== 0xffff)!.net;
      ed.doc.prims = ed.doc.prims.filter((p) => !((p.kind === 'track' || p.kind === 'arc' || p.kind === 'via') && p.net === net));
    }
    const count = () => fresh(ed).groups.get('connections')!.prims.count;
    const all = count();
    expect(all).toBeGreaterThan(0);
    settings.pcbConnectionLayerColours = true;
    expect(count()).toBe(all * 2);
    settings.pcbConnectionLayerColours = false;
    // A mechanical layer current: nothing ends on it, so only lines with an end on every layer stay
    ed.currentLayer = M2; ed.singleLayer = 'grey';
    const smd = connectionLines(ed.doc, settings.pcbSmartTrackEnds).length;
    expect(count()).toBeLessThanOrEqual(smd);
    settings.pcbAllConnectionsSingle = true;
    expect(count()).toBe(all);
  });

  it('special strings converted; the status bar names what is under the cursor; a new net takes the default colour', () => {
    const ed = board();
    const t = ed.doc.prims.find((p): p is PcbText => p.kind === 'text' && !p.hidden && !p.barcode)!;
    t.text = '.Layer_Name';
    const texts = () => [...fresh(ed).groups.values()].flatMap((g) => g.texts.map((x) => x.text));
    expect(texts()).not.toContain('.Layer_Name');
    settings.pcbConvertSpecial = false;
    expect(texts()).toContain('.Layer_Name');
    const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.net !== 0xffff)!;
    ed.cursor = pad.at;
    expect(ed.statusInfo()).toMatch(/^Pad .*, net /);
    settings.pcbShowStatusInfo = false;
    expect(ed.statusInfo()).toBe('');
    settings.pcbNewNetColour = '#123456';
    addNet(ed.doc, 'NEWNET').apply();
    const c = ed.doc.nets.at(-1)!.bag.int('COLOR');
    expect(((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)).toBe(0x123456);
  });

  it('system colours: DRC markers, highlight, grid, board line, sheet; the workspace a gradient; Measure Distance in the dimension line colours', () => {
    const ed = board();
    settings.pcbDrcMarkerColour = '#ff0000'; settings.pcbDrcDetailColour = '#0000ff'; settings.pcbWorkspaceEnd = '#202020'; settings.pcbGridColourLarge = '#ff00ff';
    const m = (ed as unknown as { marks(): unknown }).marks.bind(ed);
    (ed as unknown as { violations: unknown[] }).violations = [{ kind: 'Clearance', message: 'm', at: { x: 0, y: 0 }, prims: [0] }];
    expect(m()).toMatchObject({ colour: 0xff0000, pointColour: 0x0000ff });
    expect((ed as unknown as { highlightColour(): number }).highlightColour()).toBe(hexToRgb(settings.pcbHighlightColour));
    expect(fresh(ed).backgroundEnd).toBe(0x202020);
    expect(ed.grid().major).toEqual([1, 0, 1, expect.any(Number)]);
    settings.pcbDimLine1 = '#00ff00'; settings.pcbDimLine2 = '#ff8800';
    const tool = new MeasureTool(ed, () => 'mil', () => {}, undefined, () => ({ first: hexToRgb(settings.pcbDimLine1), second: hexToRgb(settings.pcbDimLine2) }));
    const p = (x: number) => ({ world: { x, y: 0 }, raw: { x, y: 0 }, button: 0, shift: false, ctrl: false, alt: false });
    tool.pointerDown(p(0)); tool.pointerMove(p(mil(100)));
    expect(tool.overlay()!.segments!.map((s) => s.color)).toEqual([0x00ff00, 0xff8800, 0xff8800]);
  });

  it('3D: the board milled along the Route Tool Path layer', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(routeToolLayer(doc)).toBeNull();
    const o = doc.board.outline, xs = o.map((v) => v.x), ys = o.map((v) => v.y);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2, y0 = Math.min(...ys), y1 = Math.max(...ys);
    // A slot right across the board: two pieces
    addTracks(doc, [{ layer: M2, a: { x: mx, y: y0 - mil(100) }, b: { x: mx, y: y1 + mil(100) }, width: mil(80), net: 0xffff }]).apply();
    setBoardProps(doc, { KONIUMROUTETOOLLAYER: String(M2) }).apply();
    expect(routeToolLayer(doc)).toBe(M2);
    const cuts = routeCuts(doc);
    expect(cuts.length).toBe(1);
    const plain = buildBoardModel(doc), milled = buildBoardModel(doc, { routeCuts: cuts });
    // The cut's two new edges: more wall
    expect(milled.meshes[2]!.idx.length).toBeGreaterThan(plain.meshes[2]!.idx.length);
  });
});
