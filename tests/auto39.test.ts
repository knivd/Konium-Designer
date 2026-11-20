import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { UndoStack } from '../src/core/undo';
import { mil } from '../src/core/units';
import { pointInPoly } from '../src/core/geom';
import { PropertyBag } from '../src/formats/altium/props';
import type { PcbDocument } from '../src/model/pcb';
import { connections, runDrc } from '../src/model/drc';
import { autoroute, fanout, poursAround, smdPads } from '../src/model/autoroute';
import { autoPlace } from '../src/model/autoPlace';
import { addTracks, addVias, moveComponent, removePrims, repour } from '../src/model/pcbEdit';
import { componentExtent } from '../src/model/rooms';
import { readGrids, readGuides, snapToGuide, snapToLocalGrid, writeGrids, writeGuides, type LocalGrid } from '../src/model/gridGuides';
import { drillRows, drillTable, layerStackTable } from '../src/model/boardTables';
import { defaultPnpSetup, pnpFile, readPnp } from '../src/formats/gerber/pnp';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
/** The demo with its signal copper (tracks, arcs, vias) taken off: every connection unrouted. */
function unrouted(): { doc: PcbDocument; u: UndoStack } {
  const doc = demo(), u = new UndoStack();
  u.transact('strip', (t) => t.add(removePrims(doc, doc.prims.filter((p) => ((p.kind === 'track' || p.kind === 'arc') && p.layer <= 32 && p.polygon === 0xffff) || p.kind === 'via'))));
  return { doc, u };
}
const copperErrors = (doc: PcbDocument) => runDrc(doc).violations.filter((v) => v.kind === 'Clearance' || v.kind === 'ShortCircuit').map((v) => v.message);

describe('Auto Route', () => {
  it('routes every connection of the demo, the pour repoured round it, with no clearance errors; it saves', async () => {
    const { doc, u } = unrouted();
    const conns = connections(doc);
    expect(conns.length).toBeGreaterThan(3);
    const r = await autoroute(doc, conns);
    expect(r.failed).toEqual([]);
    expect(r.routed).toBe(conns.length);
    u.transact('route', (t) => { t.add(addTracks(doc, r.tracks)); if (r.vias.length) t.add(addVias(doc, r.vias)); for (const i of poursAround(doc, r)) t.add(repour(doc, i)); });
    expect(connections(doc)).toEqual([]);
    expect(copperErrors(doc)).toEqual([]);
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    expect(connections(back)).toEqual([]);
    // Undo puts every connection back
    u.undo();
    expect(connections(doc).length).toBe(conns.length);
  });
  it('stops when asked, leaving what it had not routed', async () => {
    const { doc } = unrouted();
    const job = { cancelled: false, paused: false };
    const r = await autoroute(doc, connections(doc), { job, progress: (i) => { if (i === 2) job.cancelled = true; } });
    expect(r.routed).toBe(2);
  });
});

describe('Fanout', () => {
  it('each surface-mount pad gets a track out to a via, clear of everything', () => {
    const { doc, u } = unrouted();
    const pads = smdPads(doc);
    const f = fanout(doc, pads);
    expect(f.done).toBe(pads.length);
    expect(f.vias).toHaveLength(pads.length);
    u.transact('fanout', (t) => { t.add(addTracks(doc, f.tracks)); t.add(addVias(doc, f.vias)); for (const i of poursAround(doc, f)) t.add(repour(doc, i)); });
    expect(copperErrors(doc)).toEqual([]);
    // Fanned-out pads are left alone the second time
    expect(fanout(doc, smdPads(doc)).done).toBe(0);
  });
});

describe('Fanout, then Auto Route', () => {
  it('routes from the fanned-out vias: no second via beside one of its net, every hole clear of the others', async () => {
    const { doc, u } = unrouted();
    const f = fanout(doc, smdPads(doc));
    u.transact('fanout', (t) => { t.add(addTracks(doc, f.tracks)); t.add(addVias(doc, f.vias)); });
    const r = await autoroute(doc, connections(doc));
    expect(r.failed).toEqual([]);
    u.transact('route', (t) => { t.add(addTracks(doc, r.tracks)); if (r.vias.length) t.add(addVias(doc, r.vias)); for (const i of poursAround(doc, r)) t.add(repour(doc, i)); });
    expect(connections(doc)).toEqual([]);
    expect(copperErrors(doc)).toEqual([]);
    expect(runDrc(doc).violations.filter((v) => v.kind === 'HoleToHoleClearance').map((v) => v.message)).toEqual([]);
    const vias = doc.prims.filter((p) => p.kind === 'via');
    for (const [i, a] of vias.entries()) for (const b of vias.slice(i + 1)) if (a.kind === 'via' && b.kind === 'via' && a.net === b.net) expect(Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y)).toBeGreaterThan(a.diameter / 2);
  });
});

describe('Auto Placer', () => {
  it('puts the components inside the board, apart from each other', async () => {
    const doc = demo();
    const moves = await autoPlace(doc, doc.components.map((_, i) => i), { grid: mil(25), gap: mil(10), rotate: false });
    expect(moves).toHaveLength(doc.components.length);
    const u = new UndoStack();
    u.transact('place', (t) => { for (const m of moves) { const at = doc.components[m.component]!.at; t.add(moveComponent(doc, m.component, { x: m.to.x - at.x, y: m.to.y - at.y }, 0)); } });
    const boxes = doc.components.map((_, i) => componentExtent(doc, i)!);
    for (const b of boxes) for (const q of [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }]) expect(pointInPoly(q, doc.board.outline)).toBe(true);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY).toBe(true);
    }
  });
});

describe('grids and guides', () => {
  it('local grids and guides are kept on the board and snap the cursor', () => {
    const bag = new PropertyBag();
    const grids: LocalGrid[] = [
      { kind: 'cartesian', name: 'Fine', enabled: true, area: { minX: 0, minY: 0, maxX: mil(1000), maxY: mil(1000) }, stepX: mil(5), stepY: mil(5), dots: false },
      { kind: 'polar', name: 'Ring', enabled: true, centre: { x: mil(3000), y: mil(3000) }, radialStep: mil(100), angleStep: 15, r0: mil(100), r1: mil(1000), a0: 0, a1: 360, dots: true },
    ];
    writeGrids(bag, grids);
    writeGuides(bag, [{ kind: 'v', at: { x: mil(2000), y: 0 }, enabled: true }]);
    expect(readGrids(bag)).toEqual(grids);
    expect(readGuides(bag)).toHaveLength(1);
    expect(snapToLocalGrid(readGrids(bag), { x: mil(12), y: mil(13) })).toEqual({ x: mil(10), y: mil(15) });
    const polar = snapToLocalGrid(readGrids(bag), { x: mil(3000) + mil(203), y: mil(3000) + mil(2) })!;
    expect(Math.round(Math.hypot(polar.x - mil(3000), polar.y - mil(3000)))).toBe(mil(200));
    expect(snapToGuide(readGuides(bag), { x: mil(2004), y: mil(77) }, mil(10))).toEqual({ x: mil(2000), y: mil(77) });
    expect(snapToGuide(readGuides(bag), { x: mil(2400), y: mil(77) }, mil(10))).toBeNull();
  });
});

describe('board tables', () => {
  it('the drill table counts the holes by size; the layer stack table lists the layers', () => {
    const doc = demo();
    const rows = drillRows(doc);
    const holes = doc.prims.filter((p) => (p.kind === 'via' || p.kind === 'pad') && p.hole > 0).length;
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(holes);
    const t = drillTable(doc, { x: 0, y: 0 });
    expect(t.texts.map((x) => x.text)).toEqual(expect.arrayContaining(['Symbol', 'Count', rows[0]!.symbol, String(holes)]));
    expect(t.lines.length).toBeGreaterThan(4);
    expect(layerStackTable(doc, { x: 0, y: 0 }).texts.map((x) => x.text)).toEqual(expect.arrayContaining(['Top Layer', 'Bottom Layer']));
  });
});

describe('Place From File', () => {
  it('reads a pick and place report back, CSV and text, mil and mm', () => {
    const doc = demo(), o = doc.board.origin;
    for (const format of ['csv', 'txt'] as const) for (const units of ['mil', 'mm'] as const) {
      const s = { ...defaultPnpSetup(), format, units, columns: [...defaultPnpSetup().columns, 'Ref-X' as const, 'Ref-Y' as const] };
      const pos = readPnp(pnpFile(doc, s).text);
      expect(pos.size).toBe(doc.components.length);
      for (const c of doc.components) {
        const p = pos.get(c.designator)!;
        expect(p.centre).toBe(false);
        expect(Math.abs(p.x - (c.at.x - o.x))).toBeLessThan(200);
        expect(Math.abs(p.y - (c.at.y - o.y))).toBeLessThan(200);
        expect(p.rot).toBeCloseTo(c.rotation, 1);
      }
    }
    // Without Ref columns: Center-X/Y, the middle of the pads
    const centre = readPnp(pnpFile(doc, defaultPnpSetup()).text);
    expect([...centre.values()].every((p) => p.centre)).toBe(true);
  });
});
