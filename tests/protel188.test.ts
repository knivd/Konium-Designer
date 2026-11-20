import { describe, expect, it } from 'vitest';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { detect, load, save } from '../src/formats/registry';
import { cfbFind, cfbPut, cfbStream, readCfb, writeCfb } from '../src/formats/cfb/cfb';
import { joinBinaryRecords, splitBinaryRecords } from '../src/formats/altium/framing';
import { isPcb5 } from '../src/formats/altium/pcb5';
import { convertProtelAscii, touchNets } from '../src/formats/protel/convert';
import { isProtelAscii, parseProtelAscii, protelLayer } from '../src/formats/protel/pcbAscii';
import { olderFile } from '../src/formats/protel/older';
import { L, mechLayer } from '../src/model/layers';
import type { PcbDocument, PcbPrim } from '../src/model/pcb';

/**
 * A board of this test's own in the older text format (version 2.80: thousandths of a mil): a
 * resistor on the top and a two-pin header on the bottom, two nets, a route with an arc in it, a
 * via, a copper fill, a free string, and a keep-out rectangle with one rounded corner.
 */
const T = (x1: number, y1: number, x2: number, y2: number, w: number, layer: number, net: number, tag = 'FT') => `${tag}\r\n0 0 ${x1} ${y1} ${x2} ${y2} ${w} ${layer} 0 ${net} 0\r\n 0 0 1 0 0`;
const P = (x: number, y: number, w: number, h: number, shape: number, hole: number, layer: number, net: number, name: string, rot = 0, tag = 'CP') =>
  `${tag}\r\n0 0 ${x} ${y} ${w} ${h} ${shape} ${w} ${h} ${shape} ${w} ${h} ${shape} ${hole} 0 ${layer} ${net} 0 ${rot.toFixed(3)} 0 0\r\n${name}`;
const S = (x: number, y: number, h: number, rot: number, mirror: number, layer: number, stroke: number, text: string, tag = 'CS') => `${tag}\r\n0 0 ${x} ${y} ${h} ${rot.toFixed(3)} ${mirror} 1 ${layer} 0 0 0 0 ${stroke} 1 0 0\r\n${text}`;
const BOARD = [
  'PCB FILE 6 VERSION 2.80', '2 9 3 2 2 1 4 1 4 3',
  // R1: an 0805 on the top, turned a quarter, its comment hidden
  'COMP', 'RES0805', '0 0 1500000 1200000 1 0 0 0 0 0 0 90.000 1 1 1',
  S(1440000, 1290000, 40000, 0, 0, 17, 6000, 'R1'), S(1440000, 1100000, 40000, 0, 0, 17, 6000, '10k'),
  T(1470000, 1150000, 1470000, 1250000, 8000, 17, 0, 'CT'), T(1530000, 1150000, 1530000, 1250000, 8000, 17, 0, 'CT'),
  P(1500000, 1162000, 50000, 60000, 2, 0, 1, 1, '1', 90), P(1500000, 1238000, 50000, 60000, 2, 0, 1, 2, '2', 90),
  'ENDCOMP',
  // J1: a two-pin header on the bottom, its pin 1 square, its designator hidden and its comment shown
  'COMP', 'HDR1X2', '0 0 2500000 1200000 0 1 0 0 0 0 0 0.000 1 1 16',
  S(2440000, 1320000, 50000, 0, 1, 18, 8000, 'J1'), S(2440000, 1040000, 50000, 0, 1, 18, 8000, 'PWR'),
  'CA', '0 0 2500000 1150000 20000 0.000 360.000 8000 18 0 0', ' 0 1',
  'CF', '0 0 2440000 1080000 2460000 1100000 18 0', ' 0 1 45.000',
  P(2500000, 1150000, 65000, 65000, 2, 35000, 34, 2, '1'), P(2500000, 1250000, 65000, 65000, 1, 35000, 34, 1, '2'),
  'ENDCOMP',
  // The route of VIN: up from R1-1, round a corner in an arc, to a via and on along the bottom to J1-2
  T(1500000, 1162000, 1500000, 1000000, 12000, 1, 1), 'FA', '0 0 1600000 1000000 100000 180.000 270.000 12000 1 0 0', ' 0 1',
  T(1600000, 900000, 2000000, 900000, 12000, 1, 1), 'FV', '0 0 2000000 900000 50000 28000 0 0 1 0 0 0 1 0 0 1 16',
  T(2000000, 900000, 2500000, 1250000, 12000, 16, 1),
  // GND: R1-2 to J1-1 on the top, with a fill over the end of it
  T(1500000, 1238000, 2500000, 1150000, 12000, 1, 2), 'FF', '0 0 2400000 1100000 2600000 1200000 1 0', ' 0 1 0.000',
  S(1200000, 1700000, 60000, 0, 0, 17, 10000, 'Rev A', 'FS'),
  // The keep-out outline: a rectangle with its top right corner rounded
  T(1000000, 800000, 2800000, 800000, 10000, 28, 0), T(2800000, 800000, 2800000, 1700000, 10000, 28, 0),
  'FA', '0 0 2700000 1700000 100000 0.000 90.000 10000 28 0 0', ' 0 1',
  T(2700000, 1800000, 1000000, 1800000, 10000, 28, 0), T(1000000, 1800000, 1000000, 800000, 10000, 28, 0),
  'NETDEF', 'VIN', '0 0 0', '(', 'R1-1', 'J1-2', ')', '{', '}', '0 0', 'NETDEF', 'GND', '0 0 0', '(', 'R1-2', 'J1-1', ')', '{', '}', '0 0',
  'ENDPCB', '',
].join('\r\n');
const kinds = (d: PcbDocument) => { const n: Record<string, number> = {}; for (const p of d.prims) n[p.kind] = (n[p.kind] ?? 0) + 1; return n; };
const of = <K extends PcbPrim['kind']>(d: PcbDocument, kind: K) => d.prims.filter((p): p is Extract<PcbPrim, { kind: K }> => p.kind === kind);

describe('the older text boards (26.188)', () => {
  it('are known by their first line, and their layers by their numbers', () => {
    expect(isProtelAscii(BOARD)).toBe(true);
    expect(isProtelAscii('|RECORD=Board|')).toBe(false);
    expect(isProtelAscii('PCB FILE 9 VERSION 2.70')).toBe(false);
    expect([1, 2, 15, 16, 17, 18, 19, 22, 23, 26, 27, 28, 29, 32, 33, 34].map(protelLayer)).toEqual([L.TOP, L.MID1, L.MID1 + 13, L.BOTTOM, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_SOLDER,
      L.PLANE1, L.PLANE1 + 3, L.DRILL_GUIDE, L.KEEPOUT, mechLayer(1), mechLayer(4), L.DRILL_DRAWING, L.MULTI]);
    expect(protelLayer(0)).toBeNull();
    expect(protelLayer(35)).toBeNull();
  });

  it('are read record by record: thousandths of a mil, a component\'s side and what of it is shown, a fill\'s turn', () => {
    const b = parseProtelAscii(BOARD);
    expect(b.version).toBe('2.80');
    expect(b.lost).toEqual([]);
    expect(b.nets).toEqual(['VIN', 'GND']);
    expect(b.comps.map((c) => [c.pattern, c.at.x, c.at.y, c.rotation, c.bottom, c.nameOn, c.commentOn, c.designator?.text, c.comment?.text]))
      .toEqual([['RES0805', 15_000_000, 12_000_000, 90, false, true, false, 'R1', '10k'], ['HDR1X2', 25_000_000, 12_000_000, 0, true, false, true, 'J1', 'PWR']]);
    const r1 = b.comps[0]!, j1 = b.comps[1]!;
    expect(r1.pads.map((p) => [p.name, p.layer, p.top.w, p.top.h, p.top.shape, p.hole, p.rotation, p.net])).toEqual([['1', L.TOP, 500_000, 600_000, 'rect', 0, 90, 1], ['2', L.TOP, 500_000, 600_000, 'rect', 0, 90, 2]]);
    expect(j1.pads.map((p) => [p.name, p.layer, p.top.shape, p.hole, p.net])).toEqual([['1', L.MULTI, 'rect', 350_000, 2], ['2', L.MULTI, 'round', 350_000, 1]]);
    expect(j1.designator?.mirrored).toBe(true);
    expect(j1.fills).toEqual([{ a: { x: 24_400_000, y: 10_800_000 }, b: { x: 24_600_000, y: 11_000_000 }, rotation: 45, layer: L.BOTTOM_OVERLAY, net: 0 }]);
    expect(b.tracks).toHaveLength(8);
    expect(b.comps[0]!.tracks).toHaveLength(2);
    expect(b.tracks[0]).toEqual({ a: { x: 15_000_000, y: 11_620_000 }, b: { x: 15_000_000, y: 10_000_000 }, width: 120_000, layer: L.TOP, net: 1 });
    expect(b.vias).toEqual([{ at: { x: 20_000_000, y: 9_000_000 }, diameter: 500_000, hole: 280_000, net: 1 }]);
    expect(b.texts.map((t) => [t.text, t.layer, t.height, t.stroke])).toEqual([['Rev A', L.TOP_OVERLAY, 600_000, 100_000]]);
  });

  it('copper arcs and fills take the net of what they touch', () => {
    const b = parseProtelAscii(BOARD);
    expect(touchNets(b)).toBe(2);
    expect(b.arcs.filter((a) => a.layer === L.TOP).map((a) => a.net)).toEqual([1]);
    expect(b.fills.map((f) => f.net)).toEqual([2]);
    // (drawing is left alone)
    expect(b.arcs.filter((a) => a.layer === L.KEEPOUT)[0]!.net).toBe(0);
  });

  it('become a board: its parts, copper and nets, and its shape from the keep-out outline with its arc', () => {
    const r = convertProtelAscii(BOARD, 'Old.pcb');
    const d = load(r.bytes, 'Old.PcbDoc') as PcbDocument;
    expect(d.kind).toBe('PcbDoc');
    expect(kinds(d)).toEqual({ track: 10, arc: 3, via: 1, pad: 4, fill: 2, text: 5 });
    expect(d.nets.map((n) => n.name)).toEqual(['VIN', 'GND']);
    expect(d.components.map((c) => [c.designator, c.pattern, c.layer, c.rotation, c.nameOn, c.commentOn])).toEqual([['R1', 'RES0805', L.TOP, 90, true, false], ['J1', 'HDR1X2', L.BOTTOM, 0, false, true]]);
    const pads = of(d, 'pad');
    expect(pads.map((p) => `${d.components[p.component]!.designator}-${p.name}:${d.nets[p.net]!.name}:${p.layer}:${p.top.shape}:${p.hole}`))
      .toEqual(['R1-1:VIN:1:rect:0', 'R1-2:GND:1:rect:0', 'J1-1:GND:74:rect:350000', 'J1-2:VIN:74:round:350000']);
    // The route's arc and the fill carry their nets; the via joins the two sides
    expect(of(d, 'arc').filter((a) => a.layer === L.TOP).map((a) => [d.nets[a.net]?.name, a.r, a.start, a.end])).toEqual([['VIN', 1_000_000, 180, 270]]);
    expect(of(d, 'fill').filter((f) => f.layer === L.TOP).map((f) => d.nets[f.net]?.name)).toEqual(['GND']);
    expect(of(d, 'fill').find((f) => f.layer === L.BOTTOM_OVERLAY)!.rotation).toBe(45);
    expect(of(d, 'via').map((v) => [d.nets[v.net]?.name, v.diameter, v.hole])).toEqual([['VIN', 500_000, 280_000]]);
    // Designators and comments are their components' own; the hidden ones are hidden
    const texts = of(d, 'text');
    expect(texts.filter((t) => t.isDesignator).map((t) => [t.text, t.hidden, t.mirrored])).toEqual([['R1', false, false], ['J1', true, true]]);
    expect(texts.filter((t) => t.isComment).map((t) => [t.text, t.hidden])).toEqual([['10k', true], ['PWR', false]]);
    expect(texts.find((t) => t.text === 'Rev A')!.component).toBe(0xffff);
    // The shape: the keep-out outline, 1800 by 1000 mil, with its rounded corner
    const xs = d.board.outline.map((p) => p.x), ys = d.board.outline.map((p) => p.y);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([10_000_000, 8_000_000, 28_000_000, 18_000_000]);
    expect(d.board.outline.length).toBeGreaterThan(5);
    expect(d.board.outline.some((p) => p.x === 28_000_000 && p.y === 18_000_000)).toBe(false);
    expect(r.messages.map((m) => m.message)).toEqual(['2 copper arcs and fills were given the net of what they touch', 'PCB ASCII 2.80: 2 components, 2 nets, 10 tracks, 4 pads, 1 vias']);
  });

  it('with no outline drawn, the shape is the rectangle round everything, and that is said; inner layers are added to the stack', () => {
    const lines = BOARD.split('\r\n');
    const noKeep: string[] = [];
    for (let i = 0; i < lines.length; i++) { if ((lines[i] === 'FT' || lines[i] === 'FA') && / 28 0 /.test(`${lines[i + 1]} `)) { i += 2; continue; } noKeep.push(lines[i]!); }
    const inner = noKeep.join('\r\n').replace('ENDPCB', `${T(1600000, 1000000, 2000000, 1000000, 12000, 3, 1)}\r\n${T(1600000, 1100000, 2000000, 1100000, 12000, 23, 0)}\r\nENDPCB`);
    const r = convertProtelAscii(inner, 'Old.pcb');
    const d = load(r.bytes, 'Old.PcbDoc') as PcbDocument;
    expect(d.board.outline).toHaveLength(4);
    expect(r.messages.some((m) => /^3 inner layers \(2 mid, 1 plane\): the file says neither their order in the stack nor a plane's net/.test(m.message))).toBe(true);
    expect(r.messages.some((m) => /No closed outline is drawn on the keep-out layer or on Mechanical 1/.test(m.message))).toBe(true);
    expect(d.board.copperStack).toEqual([L.TOP, L.MID1, L.MID1 + 1, L.PLANE1, L.BOTTOM]);
    expect(of(d, 'track').filter((t) => t.layer === L.MID1 + 1)).toHaveLength(1);
  });

  it('version 1 is in whole mils with one size to a pad, and is said to be unchecked; a record that cannot be read is left out and counted', () => {
    const v1 = ['PCB FILE 6 VERSION 1.10', '0 0', 'FT', '100 200 300 200 12 1', 'FP', '0 0 500 600 62 62 1 28 0 34', '1', 'FT', '0 0 1 1 2 2 10 99', 'ENDPCB'].join('\n');
    const b = parseProtelAscii(v1);
    expect(b.version).toBe('1.10');
    expect(b.pads.map((p) => [p.at.x, p.at.y, p.top.w, p.hole, p.layer, p.name])).toEqual([[5_000_000, 6_000_000, 620_000, 280_000, L.MULTI, '1']]);
    expect(b.lost).toHaveLength(2);
    const r = convertProtelAscii(v1, 'v1.pcb');
    expect(r.messages.some((m) => m.level === 'warn' && /Version 1\.10 of this format is read by its published description only/.test(m.message))).toBe(true);
    expect(r.messages.some((m) => /2 records could not be read and were left out \(line 3: FT; line 8: FT\)/.test(m.message))).toBe(true);
  });

  it('File › Open and the Import Wizard take them: a project with the board', async () => {
    const bytes = new TextEncoder().encode(BOARD);
    const im = importerFor('Old.PCB', bytes)!;
    expect(im.label).toBe('PCB 2.8 ASCII Files');
    expect(IMPORTERS.map((i) => i.id)).toContain('pcb28');
    expect(im.list([{ path: 'Old.PCB', bytes }])).toEqual([{ path: 'Old.PCB', kind: 'PCB' }]);
    const r = await im.run([{ path: 'Old.PCB', bytes }]);
    expect(r.projects.map((p) => [p.name, p.prj.name, p.documents.map((x) => x.name)])).toEqual([['Old', 'Old.PrjPcb', ['Old.PcbDoc']]]);
    expect(r.messages.filter((m) => m.level !== 'info')).toEqual([]);
    expect((load(r.projects[0]!.documents[0]!.bytes, 'Old.PcbDoc') as PcbDocument).components).toHaveLength(2);
    // (the newer text format, a KiCad board and a PADS one are not this importer's)
    expect(importerFor('x.pcb', new TextEncoder().encode('|RECORD=Board|'))).toBeUndefined();
  });
});

describe('the binary boards of version 5.0 (26.188)', () => {
  /** A board of this test's own as that format keeps it: storages without their 6, records cut to its lengths, its own header. */
  const asFive = (bytes: Uint8Array): Uint8Array => {
    const cfb = readCfb(bytes);
    const cut: Record<string, [sub: number, length: number]> = { Tracks6: [0, 36], Arcs6: [0, 48], Vias6: [0, 70], Fills6: [0, 38], Texts6: [0, 43], Pads6: [4, 106] };
    for (const [storage, [sub, length]] of Object.entries(cut)) {
      const recs = splitBinaryRecords(cfbStream(cfb.root, `${storage}/Data`)!).map((r) => ({ ...r, subs: r.subs.map((s, i) => (i === sub ? s.slice(0, length) : i === 5 ? new Uint8Array(0) : s)) }));
      cfbPut(cfb.root, `${storage}/Data`, joinBinaryRecords(recs));
    }
    cfb.root.children = cfb.root.children.filter((c) => !/^(FileHeaderSix|WideStrings6|.*Unique.*|.*Extended.*|.*V9.*|Models.*|ShapeBased.*|EmbeddedFonts6|FileVersionInfo|Textures|ModelsNoEmbed|SmartUnions|UnionNames|BoardRegions|.*Mask.*)$/.test(c.name));
    for (const c of cfb.root.children) if (c.kind === 'storage') c.name = c.name.replace(/6$/, '');
    const five = 'PCB 5.0 Binary File', head = new Uint8Array(5 + five.length);
    head[0] = five.length; head[4] = five.length;
    for (let i = 0; i < five.length; i++) head[5 + i] = five.charCodeAt(i);
    cfbPut(cfb.root, 'FileHeader', head);
    return writeCfb(cfb);
  };
  const six = convertProtelAscii(BOARD, 'Old.pcb').bytes;

  it('are known by their header and storages', () => {
    const five = asFive(six);
    expect(isPcb5(readCfb(five).root)).toBe(true);
    expect(isPcb5(readCfb(six).root)).toBe(false);
    expect(detect(five, 'Old.PcbDoc')).toBe('PcbDoc');
    // (by content: under any name)
    expect(detect(five, 'Old.pcb')).toBe('PcbDoc');
  });

  it('open as the present format: every object as it was, and saved in the present format', () => {
    const want = load(six, 'Old.PcbDoc') as PcbDocument;
    const got = load(asFive(six), 'Old.PcbDoc') as PcbDocument;
    expect(kinds(got)).toEqual(kinds(want));
    expect(got.nets.map((n) => n.name)).toEqual(['VIN', 'GND']);
    expect(got.components.map((c) => [c.designator, c.pattern, c.layer, c.rotation])).toEqual(want.components.map((c) => [c.designator, c.pattern, c.layer, c.rotation]));
    const plain = (d: PcbDocument) => d.prims.map((p) => { const { src: _s, ...rest } = p as PcbPrim & { src: unknown }; return JSON.stringify(rest, (k, v) => (k === 'fontName' || k === 'wide' ? undefined : v)); }).sort();
    expect(plain(got)).toEqual(plain(want));
    expect(got.diags.items.some((m) => /A PCB 5\.0 binary board: read as the present format, and saved in it from now on/.test(m.message))).toBe(true);
    // Saved: the present format's storages, its records at their present lengths, each with its layer's 32-bit id
    const saved = readCfb(save(got));
    expect(cfbFind(saved.root, 'Board6')).toBeTruthy();
    expect(cfbFind(saved.root, 'Board')).toBeUndefined();
    expect(cfbStream(saved.root, 'FileHeaderSix')).toBeTruthy();
    const track = splitBinaryRecords(cfbStream(saved.root, 'Tracks6/Data')!)[0]!.subs[0]!;
    expect(track.length).toBeGreaterThanOrEqual(45);
    const again = load(save(got), 'Old.PcbDoc') as PcbDocument;
    expect(plain(again)).toEqual(plain(want));
  });
});

describe('files of the 1990s that are not read (26.188)', () => {
  const bytes = (s: string, lead: number[] = []) => new Uint8Array([...lead, ...[...s].map((c) => c.charCodeAt(0))]);
  it('are named for what they are, with the way in', () => {
    expect(olderFile('a.pcb', bytes('PCB 4.0 Binary File', [19, 0, 0, 0, 19]))).toEqual({ what: 'PCB 4.0 binary board', way: 'Open it in the desktop software and save it as a .PcbDoc (or as PCB ASCII, or PCB 2.8 ASCII), then open that' });
    expect(olderFile('a.pcb', bytes('PCB 3.0 Binary File'))?.what).toBe('PCB 3.0 binary board');
    expect(olderFile('a.pcb', bytes('PCB FILE 9 VERSION 2.70', [0x17, 0xa1]))?.what).toBe('board in an early format (PCB FILE 9)');
    expect(olderFile('a.sch', bytes('Protel for Windows - Schematic Capture Binary File Version 1.2 - 2.0', [66]))).toEqual({ what: 'schematic in the binary format of the 1990s (version 1.2)', way: 'Open it in the desktop software and save it as a .SchDoc, then open that' });
    expect(olderFile('a.lib', bytes('Protel for Windows - Schematic Library Editor Ascii File Version 1.2 - 2.0'))?.what).toBe('schematic library in the text format of the 1990s (version 1.2)');
    expect(olderFile('a.ddb', bytes('Standard Jet DB', [0, 1, 0, 0]))?.what).toBe('design database (.ddb)');
  });
  it('and nothing that is read is taken for one', () => {
    expect(olderFile('a.pcb', bytes(BOARD.slice(0, 60)))).toBeNull();
    expect(olderFile('a.SchDoc', bytes('|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0'))).toBeNull();
    expect(olderFile('a.PcbDoc', convertProtelAscii(BOARD, 'Old.pcb').bytes)).toBeNull();
    expect(olderFile('a.mdb', bytes('Standard Jet DB', [0, 1, 0, 0]))).toBeNull();
    expect(olderFile('a.txt', bytes('hello'))).toBeNull();
  });
});
