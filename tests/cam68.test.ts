/** 26.068: CAMtastic editing — placing, editing, selecting, composites, steps, views — driven as a user would: commands, clicks, the dialogs' answers. */
import { beforeEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { defaultDrillSetup, drillFiles } from '../src/formats/gerber/drill';
import { camLayerFrom, newCamDocument, readCam, writeCam, type CamDocument, type CamLayer } from '../src/formats/cam/camDoc';
import { writeCamLayer } from '../src/formats/cam/camWrite';
import { readDrill, readGerber, type DrillLayer, type GerberLayer, type GerberObject } from '../src/formats/gerber/gerberRead';
import { CamEditor } from '../src/editors/cam/CamEditor';
import { commands } from '../src/core/commands';
import '../src/app/commands';
import { activeId, docs, type OpenDoc } from '../src/app/state';
import { closeDialog, dialogStack } from '../src/app/dialogs';
import type { CamField, CamValues } from '../src/app/dialogs/CamForm';
import { mil } from '../src/core/units';
import { liveObjects } from '../src/formats/cam/camModel';
import { setClipboard } from '../src/editors/clipboard';

const pcb = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const files = [...gerberFiles(pcb, defaultGerberSetup(pcb)).files.filter((f) => /\.(GTL|GBL|GTO)$/.test(f.name)), drillFiles(pcb, defaultDrillSetup())[0]!];

let ed: CamEditor, d: CamDocument;
const run = (name: string) => { expect(commands.run(`ad:CAMTASTIC:${name}`, 'cam')).toBe(true); };
const click = (x: number, y: number, button = 0) => { const p = { world: ed.snap({ x, y }), raw: { x, y }, button, shift: false, ctrl: false, alt: false }; if (button === 2) ed.rightClick(p); else { ed.pointerMove(p); ed.pointerDown(p); } };
/** The dialog on top answered: its fields' values with these changed. */
function answer(over: Record<string, unknown> = {}): void {
  const top = dialogStack.value.at(-1);
  expect(top, 'a dialog is open').toBeTruthy();
  const props = top!.props as { fields: CamField[]; onOk: (v: CamValues) => void | string };
  const v: CamValues = {};
  for (const f of props.fields) if (f.kind !== 'note') v[f.key] = f.value as CamValues[string];
  Object.assign(v, over);
  const r = props.onOk(v);
  expect(r, `the dialog took the answer (${String(r)})`).toBeUndefined();
  closeDialog();
}
const layer = (ext: string) => d.layers.find((l) => l.name.endsWith(ext))!;
const gerber = (l: CamLayer) => l.data as GerberLayer;
const live = (l: CamLayer) => liveObjects(l).map(({ o }) => o);
const current = (l: CamLayer) => { d.current = d.layers.indexOf(l); };

beforeEach(() => {
  d = newCamDocument('T.Cam', files.map((f) => camLayerFrom(f.name, f.text)!));
  ed = new CamEditor(d);
  docs.value = [{ id: 'cam1', name: d.name, doc: d, editor: ed } as unknown as OpenDoc];
  activeId.value = 'cam1';
  while (dialogStack.value.length) closeDialog();
  setClipboard(null);
  ed.setGrid(mil(10));
});

describe('Place', () => {
  it('Line, Polyline, Rectangle, Polygon, Void, Flash: on the current layer with its D-code, one undo each', () => {
    const top = layer('.GTL'); current(top);
    const n0 = gerber(top).objects.length;
    run('DrawLine'); click(0, 0); click(mil(100), 0); click(0, 0, 2);
    run('DrawPolyline'); click(0, mil(200)); click(mil(100), mil(200)); click(mil(100), mil(300)); click(0, 0, 2);
    run('DrawRect'); click(mil(500), mil(500)); click(mil(700), mil(600)); click(0, 0, 2);
    run('DrawPolygon'); click(mil(1000), 0); click(mil(1100), 0); click(mil(1100), mil(100)); click(0, 0, 2);
    run('DrawVoid'); click(mil(1020), mil(20)); click(mil(1080), mil(20)); click(mil(1080), mil(80)); click(0, 0, 2);
    run('DrawFlash'); click(mil(2000), mil(2000)); click(0, 0, 2);
    const added = gerber(top).objects.slice(n0);
    expect(added.map((o) => o.kind)).toEqual(['draw', 'draw', 'draw', 'draw', 'draw', 'draw', 'draw', 'region', 'region', 'flash']);
    expect(added[7]!.dark && !added[8]!.dark).toBe(true);
    // The polyline and rectangle are groups (they pick together)
    expect(new Set(added.slice(1, 3).map((o) => o.grp)).size).toBe(1);
    expect(top.groups?.get(added[3]!.grp!)).toEqual({ kind: 'polyline', closed: true });
    expect(top.edited).toBe(true);
    // Each placement one undo step
    for (let k = 0; k < 6; k++) ed.undo.undo();
    expect(gerber(top).objects.length).toBe(n0);
    ed.undo.redo();
    expect(gerber(top).objects.length).toBe(n0 + 1);
  });

  it('Arcs and circles: centre/start/end, 2 and 3 points, centre and radius, tangent to two lines', () => {
    const top = layer('.GTL'); current(top);
    const n0 = gerber(top).objects.length;
    run('DrawArcCsed'); click(0, 0); click(mil(100), 0); click(0, mil(100)); click(0, 0, 2);
    run('DrawArc2pt'); click(0, 0); click(mil(200), 0); click(0, 0, 2);
    run('DrawCircle3P'); click(mil(100), 0); click(0, mil(100)); click(mil(-100), 0); click(0, 0, 2);
    run('DrawCircleCenRad2'); click(mil(500), mil(500)); answer({ r: mil(40) }); click(0, 0, 2);
    run('DrawArcCsa'); click(0, 0); click(mil(50), 0); answer({ deg: -90 }); click(0, 0, 2);
    const arcs = gerber(top).objects.slice(n0) as Extract<GerberObject, { kind: 'arc' }>[];
    expect(arcs.every((o) => o.kind === 'arc')).toBe(true);
    expect(arcs[0]!.c).toEqual({ x: 0, y: 0 });
    expect(Math.round(arcs[0]!.b.y)).toBe(mil(100));
    expect(arcs[1]!.c).toEqual({ x: mil(100), y: 0 });
    expect(Math.round(Math.hypot(arcs[2]!.a.x - arcs[2]!.c.x, arcs[2]!.a.y - arcs[2]!.c.y))).toBe(mil(100));
    expect(arcs[3]!.a).toEqual(arcs[3]!.b); // a full circle
    expect(arcs[4]!.cw).toBe(true);
    // Tangent, Tangent, Radius: two lines at a right angle, a circle of 30 mil in their corner
    run('DrawLine'); click(mil(3000), mil(3000)); click(mil(3500), mil(3000)); click(0, 0, 2);
    run('DrawLine'); click(mil(3000), mil(3000)); click(mil(3000), mil(3500)); click(0, 0, 2);
    const n1 = gerber(top).objects.length;
    run('DrawCircleTtr'); click(mil(3200), mil(3000)); click(mil(3000), mil(3200)); answer({ r: mil(30) });
    const c = gerber(top).objects[n1] as Extract<GerberObject, { kind: 'arc' }>;
    expect(c.kind).toBe('arc');
    expect([Math.round(c.c.x), Math.round(c.c.y)]).toEqual([mil(3030), mil(3030)]);
  });

  it('Text and dimensions: stroke draws in a group that remembers what they say', () => {
    const top = layer('.GTO'); current(top);
    run('DrawText'); click(0, 0); answer({ text: 'KD', h: mil(80) }); click(0, 0, 2);
    const grp = [...top.groups!].find(([, g]) => g.kind === 'text')!;
    expect(grp[1]).toMatchObject({ kind: 'text', text: 'KD', height: mil(80) });
    const strokes = live(top).filter((o) => o.grp === grp[0]);
    expect(strokes.length).toBeGreaterThan(3);
    run('DrawDimHorz'); click(0, 0); click(mil(1000), 0); click(mil(500), mil(200)); click(0, 0, 2);
    const dim = [...top.groups!].find(([, g]) => g.kind === 'dimension')!;
    expect(dim[1]).toMatchObject({ dim: 'horizontal', text: '1000.000mil' });
    // Edit › Objects › Text changes it in place (a click on one of its strokes)
    // (in the middle of the stroke furthest from the origin: the dimension's extension line runs up from there)
    const mid = (o: (typeof strokes)[number]) => (o.kind === 'draw' ? { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 } : { x: 0, y: 0 });
    const s0 = strokes.reduce((m, o) => (mid(o).x > mid(m).x ? o : m));
    run('EditText'); click(mid(s0).x, mid(s0).y); answer({ text: 'KDX' });
    expect(top.groups!.get(grp[0])).toMatchObject({ text: 'KDX' });
    expect(live(top).filter((o) => o.grp === grp[0]).length).toBeGreaterThan(strokes.length);
  });

  it('Drills: point, slot, G84 circle, drilled text, routed circle; Modify Drill(s); written and read back', () => {
    const drl = d.layers.find((l) => l.data.kind === 'drill')!; current(drl);
    const dd = drl.data as DrillLayer;
    const n0 = dd.hits.length;
    run('DrillAdd'); click(0, 0); click(0, 0, 2);
    run('DrillSlot'); click(mil(100), 0); click(mil(300), 0); click(0, 0, 2);
    run('DrillCircle'); click(mil(1000), 0); click(mil(1100), 0); click(0, 0, 2);
    run('DrillHorText'); click(0, mil(1000)); answer({ text: 'AB' }); click(0, 0, 2);
    run('ToolsMillG32'); click(mil(2000), 0); click(mil(2100), 0); click(0, 0, 2);
    expect(dd.hits[n0]!.at).toEqual({ x: 0, y: 0 });
    expect(dd.hits[n0 + 1]!.slot).toEqual({ x: mil(300), y: 0 });
    expect(dd.hits[n0 + 2]!.circle).toBe(mil(200));
    const textHits = dd.hits.filter((h) => h.grp);
    expect(textHits.length).toBeGreaterThan(5);
    expect(dd.routes.at(-1)!.circle).toMatchObject({ r: mil(100), cw: true });
    const back = readDrill(writeCamLayer(drl));
    expect(back.hits.some((h) => h.slot) && back.hits.some((h) => Math.round(h.circle ?? 0) === mil(200))).toBe(true);
    expect(back.texts?.[0]?.text).toBe('AB');
    expect(back.routes.some((r) => r.circle && Math.abs(r.circle.r - mil(100)) < 10)).toBe(true);
    // Modify Drill(s): the selected hit to 1 mm
    ed.select([ed.keyOf(drl, n0)]);
    run('DrillModify'); answer({ dia: 393701 });
    expect(Math.abs(dd.tools.get(dd.hits[n0]!.tool)! - 393701)).toBeLessThanOrEqual(100);
  });
});

describe('Edit', () => {
  it('Move, Rotate, Mirror, Scale, Copy on Field, Array: the selection placed again, undoable', () => {
    const top = layer('.GTL'); current(top);
    run('DrawLine'); click(0, 0); click(mil(100), 0); click(0, 0, 2);
    const i = gerber(top).objects.length - 1;
    const line = () => gerber(top).objects[i] as Extract<GerberObject, { kind: 'draw' }>;
    ed.select([ed.keyOf(top, i)]);
    run('EditMove'); click(0, 0); click(mil(50), mil(50));
    expect(line().a).toEqual({ x: mil(50), y: mil(50) });
    run('EditRotate'); click(mil(50), mil(50)); answer({ a: 90 });
    expect([Math.round(line().b.x), Math.round(line().b.y)]).toEqual([mil(50), mil(150)]);
    run('EditMirror'); click(mil(100), 0); answer({ axis: 'Left to right (about a vertical line)' });
    expect(Math.round(line().a.x)).toBe(mil(150));
    run('EditScale'); click(mil(150), mil(50)); answer({ x: 2, y: 2 });
    expect(Math.round(line().b.y)).toBe(mil(250));
    for (let k = 0; k < 4; k++) ed.undo.undo();
    expect(line().a).toEqual({ x: 0, y: 0 });
    const n = gerber(top).objects.length;
    run('EditCopyMult'); click(0, 0); click(mil(1000), 0); click(mil(2000), 0); click(0, 0, 2);
    expect(gerber(top).objects.length).toBe(n + 2);
    ed.select([ed.keyOf(top, i)]);
    run('EditArray'); answer({ nx: 3, ny: 2, dx: mil(200), dy: mil(300) });
    expect(gerber(top).objects.length).toBe(n + 2 + 5);
  });

  it('Copy and Paste by a reference point, onto the layer they came from; Cut', () => {
    const top = layer('.GTL'), bot = layer('.GBL'); current(top);
    run('DrawFlash'); click(0, 0); click(0, 0, 2);
    const i = gerber(top).objects.length - 1;
    ed.select([ed.keyOf(top, i)]);
    run('EditCopy'); click(0, 0);
    current(bot);
    run('EditPaste'); click(mil(500), mil(500));
    const pasted = gerber(top).objects.at(-1)!;
    expect(pasted.kind === 'flash' && pasted.at).toEqual({ x: mil(500), y: mil(500) });
    const nb = gerber(bot).objects.length;
    ed.select([ed.keyOf(top, i)]);
    run('EditCut'); click(0, 0);
    expect(liveObjects(top).some(({ i: k }) => k === i)).toBe(false);
    expect(gerber(bot).objects.length).toBe(nb);
  });

  it('Break, Chamfer, Fillet, Extend, Join, Offset', () => {
    const top = layer('.GTO'); current(top);
    const n0 = gerber(top).objects.length;
    run('DrawLine'); click(0, 0); click(mil(400), 0); click(0, 0, 2);
    run('EditBreak'); click(mil(200), 0); click(0, 0, 2);
    expect(live(top).slice(-2).map((o) => o.kind === 'draw' && [o.a.x, o.b.x])).toEqual([[0, mil(200)], [mil(200), mil(400)]]);
    // A corner: chamfer it 50 mil back
    run('DrawLine'); click(mil(1000), 0); click(mil(1400), 0); click(0, 0, 2);
    run('DrawLine'); click(mil(1000), 0); click(mil(1000), mil(400)); click(0, 0, 2);
    run('EditChamfer'); click(mil(1200), 0); click(mil(1000), mil(200)); answer({ d: mil(50) });
    const cut = gerber(top).objects.at(-1)!;
    expect(cut.kind === 'draw' && [Math.round(cut.a.x), Math.round(cut.b.y)]).toEqual([mil(1050), mil(50)]);
    // Another corner: a fillet of 100 mil
    run('DrawLine'); click(mil(2000), 0); click(mil(2400), 0); click(0, 0, 2);
    run('DrawLine'); click(mil(2000), 0); click(mil(2000), mil(400)); click(0, 0, 2);
    run('EditFillet'); click(mil(2200), 0); click(mil(2000), mil(200)); answer({ d: mil(100) });
    const arc = gerber(top).objects.at(-1)!;
    expect(arc.kind === 'arc' && [Math.round(arc.c.x), Math.round(arc.c.y)]).toEqual([mil(2100), mil(100)]);
    // Extend a short line to a boundary
    run('DrawLine'); click(mil(3000), 0); click(mil(3000), mil(500)); click(0, 0, 2);
    run('DrawLine'); click(mil(2500), mil(200)); click(mil(2800), mil(200)); click(0, 0, 2);
    const k = gerber(top).objects.length - 1;
    run('EditExtend'); click(mil(3000), mil(300)); click(mil(2790), mil(200)); click(0, 0, 2);
    expect((gerber(top).objects[k] as Extract<GerberObject, { kind: 'draw' }>).b.x).toBe(mil(3000));
    // Join the two broken halves into a polyline; offset it
    ed.select([ed.keyOf(top, n0), ed.keyOf(top, gerber(top).objects.findIndex((o, j) => j > n0 && o.kind === 'draw' && o.a.x === mil(200)))]);
    run('EditJoin');
    expect(gerber(top).objects[n0]!.grp).toBeTruthy();
    const before = gerber(top).objects.length;
    run('EditOffset'); click(mil(100), mil(100)); answer({ d: mil(30) });
    const off = gerber(top).objects.slice(before);
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((o) => o.kind === 'draw' && Math.round(o.a.y) === mil(30))).toBe(true);
  });

  it('Modify/Change, Explode (polygons, text, custom apertures), Draw to Flash, vertices', () => {
    const top = layer('.GTL'); current(top);
    run('DrawPolygon'); click(0, 0); click(mil(100), 0); click(mil(100), mil(100)); click(0, mil(100)); click(0, 0, 2);
    const p = gerber(top).objects.length - 1;
    ed.select([ed.keyOf(top, p)]);
    run('EditModify'); answer({ pol: 'Clear' });
    expect(gerber(top).objects[p]!.dark).toBe(false);
    // Vertex: move a corner, add one, delete one
    run('EditVertexMove'); click(mil(100), mil(100)); click(mil(150), mil(150)); click(0, 0, 2);
    const reg = () => gerber(top).objects[p] as Extract<GerberObject, { kind: 'region' }>;
    expect(reg().contours[0]![2]).toEqual({ x: mil(150), y: mil(150) });
    run('EditVertexAdd'); click(mil(50), 0); click(0, 0, 2);
    expect(reg().contours[0]!.length).toBe(5);
    run('EditVertexDelete'); click(mil(50), 0); click(0, 0, 2);
    expect(reg().contours[0]!.length).toBe(4);
    ed.select([ed.keyOf(top, p)]);
    run('EditExplodePoly');
    expect(live(top).slice(-4).every((o) => o.kind === 'draw')).toBe(true);
    // A painted pad: four overlapping draws filling a square → one rectangular flash
    const n = gerber(top).objects.length;
    for (let y = 0; y <= 60; y += 20) { run('DrawLine'); click(mil(5000), mil(5000 + y)); click(mil(5060), mil(5000 + y)); click(0, 0, 2); }
    ed.select(Array.from({ length: 4 }, (_, k) => ed.keyOf(top, n + k)));
    run('ToolsDraw2FlashSel');
    const f = gerber(top).objects.at(-1)!;
    expect(f.kind).toBe('flash');
    // Draw to Custom Aperture then explode it back into polygons
    ed.select([ed.keyOf(top, gerber(top).objects.length - 1)]);
    run('ToolsDraw2Cust');
    const cf = gerber(top).objects.at(-1)!;
    expect(cf.kind === 'flash' && gerber(top).apertures.get(cf.ap)?.shape).toBe('M');
    ed.select([ed.keyOf(top, gerber(top).objects.length - 1)]);
    run('EditExplodeCustom');
    expect(gerber(top).objects.at(-1)!.kind).toBe('region');
  });

  it('Layers: Add, Copy to Layers, Swap, Scale, Align Selective', () => {
    run('DrawAddLayer'); answer({ name: 'NOTES.GBR', type: 'Mechanical' });
    const notes = layer('NOTES.GBR');
    expect(notes.data.kind).toBe('gerber');
    current(layer('.GTL'));
    run('DrawFlash'); click(0, 0); click(0, 0, 2);
    const top = layer('.GTL');
    ed.select([ed.keyOf(top, gerber(top).objects.length - 1)]);
    run('EditCopyLayer'); answer({ to: ['NOTES.GBR'] });
    expect(gerber(notes).objects.length).toBe(1);
    run('EditSwapLayers'); answer({ a: 'NOTES.GBR', b: layer('.GTO').name });
    expect(gerber(layer('.GTO')).objects.length).toBe(1);
    current(layer('.GTO'));
    run('EditScaleLayer'); answer({ x: 2, y: 2 });
    run('EditAlign'); click(0, 0); click(mil(100), mil(100));
    const fl = gerber(layer('.GTO')).objects[0]!;
    expect(fl.kind === 'flash' && fl.at).toEqual({ x: mil(100), y: mil(100) });
  });

  it('Composites: Build, Modify, Open (placing on a sub-layer), Explode', () => {
    const top = layer('.GTL'), bot = layer('.GBL');
    const nt = live(top).length, nb = live(bot).length;
    run('BuildComposite'); answer({ name: 'PLANE', dark: [top.name], clear: [bot.name] });
    const comp = layer('PLANE');
    expect(comp.composite).toEqual([{ name: top.name, dark: true }, { name: bot.name, dark: false }]);
    expect(d.layers.includes(top) || d.layers.includes(bot)).toBe(false);
    expect(live(comp).length).toBe(nt + nb);
    current(comp);
    run('EditCompositeOpen'); answer({ sub: bot.name });
    run('DrawFlash'); click(0, 0); click(0, 0, 2);
    expect(gerber(comp).objects.at(-1)!.sub).toBe(1);
    // Saved and opened again: the sub-layers kept
    const back = readCam(writeCam(d), 'T.Cam');
    const bc = back.layers.find((l) => l.name === 'PLANE')!;
    expect(bc.composite?.length).toBe(2);
    expect((bc.data as GerberLayer).objects.filter((o) => (o.sub ?? 0) === 1).length).toBe(nb + 1);
    run('EditExplodeComposite');
    expect(d.layers.filter((l) => l.name === top.name || l.name === bot.name).length).toBe(2);
    expect((d.layers.find((l) => l.name === bot.name)!.data as GerberLayer).negative).toBe(true);
  });

  it('Step/Repeat: Add Objects makes a block, Modify regenerates its repeats, written as %SR%, Explode', () => {
    const top = layer('.GTO'); current(top);
    run('DrawFlash'); click(0, 0); click(0, 0, 2);
    const i = gerber(top).objects.length - 1;
    ed.select([ed.keyOf(top, i)]);
    run('EditOpenStep'); answer({ blk: 'New block', nx: 3, ny: 2, dx: mil(500), dy: mil(400) });
    const g = gerber(top);
    expect(liveObjects(top).filter(({ o }) => o.sr).length).toBe(6);
    const text = writeCamLayer(top);
    expect(text).toContain('%SRX3Y2I');
    const back = readGerber(text);
    expect(back.objects.filter((o) => o.kind === 'flash' && o.sr).length).toBe(6);
    ed.select([ed.keyOf(top, i)]);
    run('EditModifyStep'); answer({ nx: 2, ny: 1 });
    expect(liveObjects(top).filter(({ o }) => o.sr).length).toBe(2);
    ed.select([ed.keyOf(top, i)]);
    run('EditExplode');
    expect(g.steps).toBeUndefined();
    expect(liveObjects(top).filter(({ o }) => o.kind === 'flash' && o.at.y === 0 && (o.at.x === 0 || o.at.x === mil(500))).length).toBe(2);
  });
});

describe('Select and view', () => {
  it('Filter by D-code, Flash, Trace, Previous; snap grids; Next layer; views toggle', () => {
    const top = layer('.GTL'); current(top);
    run('SelmenuFlash');
    const flashes = live(top).filter((o) => o.kind === 'flash').length;
    expect(ed.selectedObjects().length).toBe(flashes);
    run('SelmenuFilter'); answer({ layers: [top.name], kind: 'Lines' });
    expect(ed.selectedObjects().every((s) => (s.layer.data as GerberLayer).objects[s.i]!.kind === 'draw')).toBe(true);
    run('SelmenuPrev');
    expect(ed.selectedObjects().length).toBe(flashes);
    run('PopupSnapGrid25Mil');
    expect(ed.gridSize()).toBe(mil(25));
    run('SnapChange');
    expect(ed.snap({ x: 3, y: 7 })).toEqual({ x: 3, y: 7 });
    const was = d.current;
    run('NextLayer');
    expect(d.current).toBe((was + 1) % d.layers.length);
    run('ViewFill'); run('ViewTranslucent'); run('ViewOrigin');
    expect([ed.view.fill, ed.view.translucent, ed.view.origin]).toEqual([false, true, true]);
    expect(() => ed.scene()).not.toThrow();
    run('EditOriginUser'); click(mil(100), mil(100));
    expect(ed.origin()).toEqual({ x: mil(100), y: mil(100) });
  });

  it('a saved document keeps text groups, the origin and the film box', () => {
    const top = layer('.GTO'); current(top);
    run('DrawText'); click(0, 0); answer({ text: 'REV A' }); click(0, 0, 2);
    run('EditBoundBox'); answer({});
    run('EditOriginUser'); click(mil(10), mil(10));
    const back = readCam(writeCam(d), 'T.Cam');
    const bt = back.layers.find((l) => l.name === top.name)!;
    const g = [...(bt.groups ?? [])].find(([, x]) => x.kind === 'text');
    expect(g?.[1]).toMatchObject({ text: 'REV A' });
    expect((bt.data as GerberLayer).objects.filter((o) => o.grp === g![0]).length).toBeGreaterThan(5);
    expect(back.origin).toEqual({ x: mil(10), y: mil(10) });
    expect(back.filmBox).toBeTruthy();
  });
});
