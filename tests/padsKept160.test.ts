import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { padsText } from '../src/formats/pads/ascii';
import { convertPadsLayout, parsePadsLayout } from '../src/formats/pads/layout';
import { exportPadsLayout } from '../src/formats/pads/writeLayout';
import { addTracks, moveComponent, removePolygons, removePrims, replaceRecords } from '../src/model/pcbEdit';
import { demoFiles } from '../src/formats/synthetic/demo';
import { load } from '../src/formats/registry';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { convertPadsLogic } from '../src/formats/pads/logic';
import { exportPadsLogic } from '../src/formats/pads/writeLogic';
import type { SchDocument } from '../src/model/sch';
import { NO_NET, type PcbDocument, type PcbPrim } from '../src/model/pcb';
import { L } from '../src/model/layers';
import { transformRecord } from '../src/formats/altium/pcbTransform';
import { mil } from '../src/core/units';

/**
 * R10, PADS boards both ways: a PADS Layout file read into Konium and written back unchanged is the
 * file PADS wrote, every byte; with parts moved and nets rerouted it is that file but for those
 * parts' lines and those nets' signals; changed otherwise, it is written from Konium's.
 */

describe('PADS round trip: a board kept (R10)', () => {
  // A PADS file to read: the demo board as PADS Layout ASCII, a few bytes changed as PADS's own might be (a remark, spacing)
  const file = (() => {
    const t = padsText(exportPadsLayout(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), 'Demo').bytes);
    return new TextEncoder().encode(t.replace('*PCB*', '*REMARK* WRITTEN BY A TEST\r\n\r\n*PCB*'));
  })();

  it('unchanged: back byte for byte', () => {
    const r = convertPadsLayout(padsText(file), 'Demo.asc', file);
    const back = exportPadsLayout(readPcbDoc(r.bytes, 'Demo.PcbDoc'), 'Demo');
    expect(back.kept).toBe(true);
    expect(back.bytes.length === file.length && back.bytes.every((v, i) => v === file[i])).toBe(true);
  });

  it('a part moved: the file as PADS wrote it but for that part\'s line, its new place', () => {
    const r = convertPadsLayout(padsText(file), 'Demo.asc', file);
    const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    const ref = doc.components[0]!.designator;
    moveComponent(doc, 0, { x: mil(100), y: 0 }, 0).apply();
    const back = exportPadsLayout(doc, 'Demo');
    expect(back.spliced).toEqual({ moved: 1, rerouted: 0 });
    const text = padsText(back.bytes);
    expect(text).toContain('WRITTEN BY A TEST');
    const was = parsePadsLayout(padsText(file)).parts.find((p) => p.ref === ref)!, now = parsePadsLayout(text).parts.find((p) => p.ref === ref)!;
    // (BASIC units: 38,100 a mil)
    expect(Math.round((now.x - was.x) / 38100)).toBe(100);
    expect(now.y).toBe(was.y);
    // Every other line as it was
    const a = padsText(file).split(/\r?\n/), b = text.split(/\r?\n/);
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i]).length).toBe(1);
  });

  it('a track taken away: its net\'s signal as Konium has it, the rest as PADS wrote it', () => {
    const r = convertPadsLayout(padsText(file), 'Demo.asc', file);
    const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    const t = doc.prims.find((x) => x.kind === 'track' && x.component === NO_NET && x.net !== NO_NET)!;
    const net = t.kind === 'track' ? doc.nets[t.net]!.name : '';
    removePrims(doc, [t]).apply();
    const back = exportPadsLayout(readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc'), 'Demo');
    expect(back.spliced).toEqual({ moved: 0, rerouted: 1 });
    const was = parsePadsLayout(padsText(file)), now = parsePadsLayout(padsText(back.bytes));
    // The other nets' routes as they were
    const others = (b: typeof was) => JSON.stringify(b.routes.filter((x) => x.net !== net).map((x) => [x.net, x.conns]));
    expect(others(now)).toBe(others(was));
    expect(JSON.stringify(now.routes.filter((x) => x.net === net))).not.toBe(JSON.stringify(was.routes.filter((x) => x.net === net)));
  });

  it('a drawing taken away, one added, a pour taken away: those written from Konium\'s, the rest as PADS wrote it', () => {
    const r = convertPadsLayout(padsText(file), 'Demo.asc', file);
    const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    const was = parsePadsLayout(padsText(file));
    const g = doc.prims.find((x) => x.kind === 'track' && x.component === NO_NET && x.net === NO_NET && x.polygon === NO_NET)!;
    expect(g).toBeDefined();
    removePrims(doc, [g]).apply();
    addTracks(doc, [{ layer: L.TOP_OVERLAY, a: { x: mil(1500), y: mil(1500) }, b: { x: mil(1700), y: mil(1500) }, width: mil(8) }]).apply();
    const pourName = doc.polygons[0]!.name;
    removePolygons(doc, [0]).apply();
    const back = exportPadsLayout(readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc'), 'Demo');
    expect(back.spliced).toEqual({ moved: 0, rerouted: 0, objects: 3 });
    const text = padsText(back.bytes);
    expect(text).toContain('WRITTEN BY A TEST');
    const now = parsePadsLayout(text);
    // The parts, routes and other pours as they were; the pour gone with its hatches
    const parts = (x: typeof was) => JSON.stringify(x.parts.map((q) => ({ ...q, line: 0 })));
    expect(parts(now)).toBe(parts(was));
    expect(JSON.stringify(now.routes.map((x) => [x.net, x.conns]))).toBe(JSON.stringify(was.routes.map((x) => [x.net, x.conns])));
    expect(now.pours.some((p) => p.name === pourName)).toBe(false);
    expect(now.pours.filter((p) => p.type === 'POUROUT').length).toBe(was.pours.filter((p) => p.type === 'POUROUT').length - 1);
    // The drawing's piece gone from its item (the item one, its name the file's), the new one an item at the end (200 mil long)
    expect(now.lines.length).toBe(was.lines.length + 1);
    expect(now.lines.slice(0, -1).map((l) => l.name)).toEqual(was.lines.map((l) => l.name));
    // (as many stretches: one taken away, one added; those left of the drawing joined end to end where they meet)
    const stretches = (x: typeof was) => x.lines.reduce((n, l) => n + l.pieces.reduce((m, pc) => m + Math.max(1, pc.corners.length - 1), 0), 0);
    expect(stretches(now)).toBe(stretches(was));
    const added = now.lines[now.lines.length - 1]!;
    const c = added.pieces[0]!.corners;
    expect(Math.round(Math.abs(c[1]!.p.x - c[0]!.p.x) / 38100)).toBe(200);
    expect(new Set(now.lines.map((l) => l.name)).size).toBe(now.lines.length);
  });

  it('a text changed: written from Konium\'s in its place', () => {
    const t0 = padsText(file);
    const withText = new TextEncoder().encode(t0.replace('*LINES*', `${['1905000 1905000 0.000 26 3810000 381000 N LEFT DOWN', 'Regular <Romansim Stroke Font>', 'HELLO'].join('\r\n')}\r\n\r\n*LINES*`));
    const r = convertPadsLayout(padsText(withText), 'Demo.asc', withText);
    const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    const t = doc.prims.find((x) => x.kind === 'text' && x.component === NO_NET && x.text === 'HELLO')!;
    expect(t).toBeDefined();
    moveText(doc, t);
    const back = exportPadsLayout(readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc'), 'Demo');
    expect(back.spliced?.objects).toBe(1);
    const a = padsText(withText).split('\r\n'), b = padsText(back.bytes).split('\r\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    expect(diff.length).toBe(1);
    expect(diff[0]![0]).toMatch(/^1905000 1905000 /);
    expect(diff[0]![1]).toMatch(/^2286000 1905000 /);
  });

  it('changed otherwise (a part turned over, its footprint so changed): written from Konium\'s', () => {
    const r = convertPadsLayout(padsText(file), 'Demo.asc', file);
    const doc = readPcbDoc(r.bytes, 'Demo.PcbDoc');
    moveComponent(doc, 0, { x: 0, y: 0 }, 0, { flip: true }).apply();
    const back = exportPadsLayout(readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc'), 'Demo');
    expect(back.kept).toBeFalsy();
    expect(padsText(back.bytes)).not.toContain('WRITTEN BY A TEST');
  });
});

/** A primitive moved 10 mil to the right (its record, as the move tool moves it). */
function moveText(doc: PcbDocument, t: PcbPrim): void {
  const rec = doc.streams.get(t.src.storage)!.records[t.src.index]!;
  replaceRecords(doc, [{ storage: t.src.storage, index: t.src.index, after: transformRecord(rec, (p) => ({ x: p.x + mil(10), y: p.y })) }]).apply();
}

describe('PADS round trip: a board in mils (R10)', () => {
  // A small board of our own in PADS's mils: two parts, a net on the top and one through a via
  const file = new TextEncoder().encode([
    '!PADS-POWERPCB-V9.5-MILS! DESIGN DATABASE ASCII FILE 1.0', '*PCB*        GENERAL PARAMETERS OF THE PCB DESIGN', '',
    'UNITS        0', 'MAXIMUMLAYER 2', 'ORIGIN       0 0', '',
    '*LINES*      LINES ITEMS', '', 'BOARD BOARD 0 0 1 0', 'CLOSED 5 10 0 0', '0 0', '1000 0', '1000 600', '0 600', '0 0', '',
    '*VIA*        ITEMS', '', 'STANDARDVIA 12 3', '-2 24 R', '-1 24 R', '0 24 R', '',
    '*PARTDECAL*  ITEMS', '', 'R0603 I 0 0 0 2 1 0 0', 'T-30 0 -30 0 1', 'T30 0 30 0 2', 'PAD 0 3', '-2 25 S 0', '-1 0 R', '0 0 R', '',
    '*PARTTYPE*   ITEMS', '', 'RES R0603 UND 0 0 2 0 Y', '1 2', '',
    '*PART*       ITEMS', '', 'R1 RES 200.5 300.25 0.000 U N 0 -1 0 -1 0', 'R2 RES 700 300.25 0.000 U N 0 -1 0 -1 0', '',
    '*ROUTE*', '',
    '*SIGNAL* A 0 -2', 'R1.2 R2.1', '230.5 300.25 1 8 0', '500 300.25 1 8 0', '670 300.25 65 8 0',
    '*SIGNAL* B 0 -2', 'R1.1 R2.2', '170.5 300.25 2 10 0', '170.5 100 2 10 0 STANDARDVIA', '730 100 1 10 0', '730 300.25 65 10 0', '',
    '*END*     OF ASCII OUTPUT FILE', '',
  ].join('\r\n'));
  const read = () => readPcbDoc(convertPadsLayout(padsText(file), 'Small.asc', file).bytes, 'Small.PcbDoc');

  it('unchanged: back byte for byte', () => {
    const back = exportPadsLayout(read(), 'Small');
    expect(back.kept).toBe(true);
    expect(padsText(back.bytes)).toBe(padsText(file));
  });

  it('a part moved: its line in mils, the rest as written', () => {
    const doc = read();
    const ci = doc.components.findIndex((c) => c.designator === 'R1');
    moveComponent(doc, ci, { x: mil(100), y: mil(0.5) }, 0).apply();
    const back = exportPadsLayout(doc, 'Small');
    expect(back.spliced).toEqual({ moved: 1, rerouted: 0 });
    const a = padsText(file).split('\r\n'), b = padsText(back.bytes).split('\r\n');
    expect(b.filter((l, i) => l !== a[i])).toEqual(['R1 RES 300.5 300.75 0.000 U N 0 -1 0 -1 0']);
  });

  it('a track taken away: its net written anew in mils, the via the file\'s', () => {
    const doc = read();
    const t = doc.prims.find((x) => x.kind === 'track' && x.component === NO_NET && x.net !== NO_NET && doc.nets[x.net]?.name === 'B' && x.layer !== doc.prims.find((y) => y.kind === 'via')?.layerStart);
    expect(t).toBeDefined();
    removePrims(doc, [t!]).apply();
    const back = exportPadsLayout(readPcbDoc(writePcbDoc(doc), 'Small.PcbDoc'), 'Small');
    expect(back.spliced).toEqual({ moved: 0, rerouted: 1 });
    const text = padsText(back.bytes);
    // Signal A and the via section as they were; no via added
    expect(text).toContain('*SIGNAL* A 0 -2\r\nR1.2 R2.1\r\n230.5 300.25 1 8 0\r\n500 300.25 1 8 0\r\n670 300.25 65 8 0');
    expect(text).toContain('STANDARDVIA 12 3\r\n-2 24 R\r\n-1 24 R\r\n0 24 R\r\n\r\n*PARTDECAL*');
    expect(text).not.toContain('STANDARDVIA_2');
    // B's corners in the file's mils (on the board, the via's place as it was)
    const b = parsePadsLayout(text).routes.filter((r) => r.net === 'B');
    const corners = text.split('\r\n').slice(text.split('\r\n').indexOf('*SIGNAL* B 0 -2')).filter((l) => /^-?\d/.test(l)).map((l) => l.split(' '));
    expect(b.length).toBeGreaterThan(0);
    expect(corners.length).toBeGreaterThan(0);
    for (const c of corners) { expect(Number(c[0])).toBeGreaterThanOrEqual(0); expect(Number(c[0])).toBeLessThanOrEqual(1000); expect(Number(c[1])).toBeLessThanOrEqual(600); }
    expect(corners.some((c) => c[0] === '170.5' && c[1] === '100' && c[5] === 'STANDARDVIA')).toBe(true);
    expect(corners.every((c) => c[3] === '10')).toBe(true);
  });
});

describe('PADS round trip: a schematic design kept (R10)', () => {
  // A PADS Logic file to read: the demo project's sheets as PADS Logic, a remark added
  const file = (() => {
    const files = demoFiles();
    const sheets = files.filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: load(f.bytes, f.name) as SchDocument }));
    const t = padsText(exportPadsLogic({ name: 'Demo', sheets, hierarchyMode: 2 }).bytes);
    return new TextEncoder().encode(t.replace('*SCH*', '*REMARK* WRITTEN BY A TEST\r\n*SCH*'));
  })();
  const read = () => convertPadsLogic(padsText(file), 'Demo.txt', 'Footprints.PcbLib', file).sheets.map((x) => ({ name: x.name, doc: readSchDoc(x.bytes, x.name) }));

  it('unchanged: back byte for byte', () => {
    const back = exportPadsLogic({ name: 'Demo', sheets: read(), hierarchyMode: 3 });
    expect(back.kept).toBe(true);
    expect(back.bytes.length === file.length && back.bytes.every((v, i) => v === file[i])).toBe(true);
  });

  it('a sheet changed, or one of its sheets left out: written from Konium\'s', () => {
    const sheets = read();
    const b = sheets[0]!.doc.records.find((r) => r.bag?.get('RECORD') === '1')!.bag!;
    b.set('LOCATION.X', String(Number(b.get('LOCATION.X') ?? 0) + 100));
    expect(exportPadsLogic({ name: 'Demo', sheets, hierarchyMode: 3 }).kept).toBeFalsy();
    const all = read();
    if (all.length > 1) expect(exportPadsLogic({ name: 'Demo', sheets: all.slice(1), hierarchyMode: 3 }).kept).toBeFalsy();
  });
});
