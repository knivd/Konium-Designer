import { afterEach, describe, expect, it } from 'vitest';
import boardOptionsSrc from '../src/app/dialogs/BoardOptions.tsx?raw';
import layerStackSrc from '../src/app/dialogs/LayerStack.tsx?raw';
import componentToolsSrc from '../src/app/dialogs/PcbComponentTools.tsx?raw';
import autoToolsSrc from '../src/app/dialogs/AutoTools.tsx?raw';
import viewConfigSrc from '../src/app/dialogs/ViewConfig.tsx?raw';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings } from '../src/core/settings';
import { mechLayer } from '../src/model/layers';
import { addTracks } from '../src/model/pcbEdit';
import { editBoard, setBoardProps } from '../src/model/pcbBoard';
import { setSheetLinked, sheetOf } from '../src/model/sheet';
import { writeGuides } from '../src/model/gridGuides';
import { STACK_PRESETS, presetStack, readStack, readStackFile, stackFile } from '../src/model/pcbStack';
import { reannotation } from '../src/model/pcbPlacement';
import { fanout, smdPads } from '../src/model/autoroute';
import { mil, mm } from '../src/core/units';
import type { PcbArc, PcbPad } from '../src/model/pcb';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const board = () => { const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc')); ed.scene(); return ed; };
const M2 = mechLayer(2);

describe('Board Options, Layer Stack Manager, Re-Annotate and Fanout once greyed (26.109)', () => {
  it('no dialog has anything marked as not built', () => {
    for (const src of [boardOptionsSrc, layerStackSrc, componentToolsSrc, autoToolsSrc, viewConfigSrc]) expect(src).not.toMatch(/Not in Konium yet|Always on in Konium/);
  });

  it('Snap To Grids, Linear and Point Guides, Arc Centres and Object Axis, as the board keeps them', () => {
    const ed = board();
    const p = { x: mil(1003), y: mil(1007) };
    expect(ed.snap(p)).not.toEqual(p);
    ed.undo.transact('t', (tx) => tx.add(setBoardProps(ed.doc, { GRIDSNAPENABLED: 'FALSE' })));
    ed.readSnapOptions();
    expect(ed.snap(p)).toEqual(p);
    // A vertical guide pulls the point onto it once Snap To Linear Guides is on (a new board has it off, as AD writes it)
    ed.undo.transact('g', (tx) => tx.add(editBoard(ed.doc, (b) => writeGuides(b, [{ kind: 'v', at: { x: mil(1004), y: 0 }, enabled: true }]))));
    expect(ed.snapLinearGuides).toBe(false);
    expect(ed.snap(p)).toEqual(p);
    ed.undo.transact('t', (tx) => tx.add(setBoardProps(ed.doc, { MGSNAPENABLED: 'TRUE' })));
    ed.readSnapOptions();
    expect(ed.snap(p).x).toBe(mil(1004));
    ed.undo.transact('g', (tx) => tx.add(editBoard(ed.doc, (b) => writeGuides(b, []))));
    // Arc centres: a hot spot while placing
    const arc = ed.doc.prims.find((q): q is PcbArc => q.kind === 'arc');
    (ed as unknown as { tool: { id: string } }).tool = { id: 'place-test' } as never;
    if (arc) {
      ed.currentLayer = arc.layer; ed.hotspotRange = mil(30);
      const near = { x: arc.c.x + mil(3), y: arc.c.y - mil(2) };
      expect(ed.snapPointer(near)).not.toEqual(arc.c);
      ed.undo.transact('t', (tx) => tx.add(setBoardProps(ed.doc, { EGSNAPTOARCCENTERS: 'TRUE' })));
      ed.readSnapOptions(); ed.hotspotRange = mil(30);
      expect(ed.snapPointer(near)).toEqual(arc.c);
    }
    // Object axis: lined up with a pad across, a line drawn from it
    ed.hotspotSnap = false;
    const pad = ed.doc.prims.find((q): q is PcbPad => q.kind === 'pad')!;
    const off = { x: pad.at.x + mil(300), y: pad.at.y + mil(5) };
    expect(ed.snapPointer(off).y).toBe(off.y);
    ed.undo.transact('t', (tx) => tx.add(setBoardProps(ed.doc, { OGSNAPENABLED: 'TRUE', KONIUMAXISSNAPRANGE: '10mil' })));
    ed.readSnapOptions(); ed.hotspotSnap = false;
    expect(ed.axisRange).toBe(mil(10));
    const lined = ed.snapPointer(off);
    expect(Math.abs(lined.y - pad.at.y)).toBeLessThanOrEqual(mil(5));
    expect((ed as unknown as { alignLines(): unknown[] | null }).alignLines()?.length).toBeGreaterThan(0);
  });

  it('Auto-size to linked layers: the sheet round what lies on them', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    addTracks(doc, [{ layer: M2, a: { x: mil(100), y: mil(200) }, b: { x: mil(900), y: mil(200) }, width: mil(10), net: 0xffff }]).apply();
    setSheetLinked(doc, new Set([M2])).apply();
    const before = sheetOf(doc).rect;
    setBoardProps(doc, { KONIUMSHEETAUTOSIZE: 'TRUE' }).apply();
    expect(sheetOf(doc)).toMatchObject({ auto: true, rect: { minX: mil(95), maxX: mil(905) } });
    expect(sheetOf(doc).rect).not.toEqual(before);
    addTracks(doc, [{ layer: M2, a: { x: mil(100), y: mil(200) }, b: { x: mil(100), y: mil(1200) }, width: mil(10), net: 0xffff }]).apply();
    expect(sheetOf(doc).rect.maxY).toBe(mil(1205));
  });

  it('a library\'s sheet (Library Options): shown, and auto-sized round the footprint', () => {
    const ed = board();
    expect(ed.sheet().show).toBe(false);
    ed.sheetOverride = { show: true, auto: true, lock: false, rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
    const r = ed.sheet().rect;
    expect(r.maxX - r.minX).toBeGreaterThan(mil(200));
    ed.invalidate();
    expect(ed.scene().groups.get('sheet')!.tris.count).toBeGreaterThan(0);
  });

  it('Layer Stack Manager: presets put in their inner layers; a stack saved loads back', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const rows = readStack(doc.board.bag!, doc.board.copperStack);
    const six = presetStack(rows, STACK_PRESETS.find(([n]) => n.startsWith('Six'))![1]);
    expect(typeof six).not.toBe('string');
    const copper = (six as typeof rows).filter((r) => r.kind === 'signal' || r.kind === 'plane').map((r) => r.kind);
    expect(copper).toEqual(['signal', 'plane', 'signal', 'signal', 'plane', 'signal']);
    expect((presetStack(six as typeof rows, '') as typeof rows).filter((r) => r.kind === 'signal' || r.kind === 'plane').length).toBe(2);
    const back = readStackFile(stackFile(six as typeof rows, 1));
    expect(typeof back).not.toBe('string');
    expect((back as { rows: typeof rows; style: number }).style).toBe(1);
    expect((back as { rows: typeof rows }).rows.map((r) => r.name)).toEqual((six as typeof rows).map((r) => r.name));
    expect(readStackFile('{"x":1}')).toBe('not a layer stack file');
  });

  it('Re-Annotate › Name from Position: the prefix and where each component is', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ren = reannotation(doc, 'position', () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }));
    expect(ren.length).toBe(doc.components.filter((c) => c.designator).length);
    const c = doc.components[ren[0]!.index]!;
    const unit = doc.board.bag?.int('DISPLAYUNIT') === 0 ? mm(1) : mil(1);
    expect(ren[0]!.to).toBe(`${c.designator.replace(/\d+$/, '') || c.designator}${Math.round(c.at.x / unit)}_${Math.round(c.at.y / unit)}`);
    expect(new Set(ren.map((r) => r.to)).size).toBe(ren.length);
  });

  it('Fanout with escape routes: each fanout\'s via led out from under its component on another layer', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const comp = doc.components.find((c) => smdPads(doc, (p) => p.component === c.index).length >= 4);
    if (!comp) return;
    const pads = smdPads(doc, (p) => p.component === comp.index);
    const plain = fanout(doc, pads);
    const esc = fanout(doc, pads, { escape: true });
    expect(plain.escaped).toBe(0);
    expect(esc.done).toBe(plain.done);
    if (!esc.done) return;
    expect(esc.escaped).toBeGreaterThan(0);
    expect(esc.tracks.length).toBe(plain.tracks.length + esc.escaped);
    expect(esc.tracks.filter((t) => t.layer !== pads[0]!.layer).length).toBe(esc.escaped);
  });
});
