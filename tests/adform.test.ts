import { describe, expect, it } from 'vitest';
import { cfbStream, readCfb } from '../src/formats/cfb/cfb';
import { readPcbDoc, parseWideStrings, encodeVia, encodeTrack } from '../src/formats/altium/pcbdoc';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { splitBinaryRecords, splitTextRecords } from '../src/formats/altium/framing';
import { RULE_KIND_IDS, splitRuleRecords } from '../src/formats/altium/rules';
import { adPolygonBag, fromCharCodes, islandAreaOf, pourOverOf, toCharCodes } from '../src/formats/altium/polygonProps';
import { PropertyBag } from '../src/formats/altium/props';
import { TEXT, VIA, get } from '../src/formats/altium/pcbLayouts';
import { demoPcbDoc, demoPcbLib } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import { isThinRecord, newBoardRecord, newLibraryRecord } from '../src/formats/altium/board6';
import { addStackLayer, deleteStackLayer, readStack, settleIds, writeStack } from '../src/model/pcbStack';
import { writePcbLib } from '../src/formats/altium/pcblib';
import { openPcbLib, writePcbLibDoc } from '../src/model/pcbLib';
import { cfbPut, writeCfb } from '../src/formats/cfb/cfb';
import { BinWriter } from '../src/formats/bin';

/** What AD17 needs to open a board or library Konium wrote (found with AD17 itself, 26.025–26.026). */
describe('files AD17 opens', () => {
  const board = demoPcbDoc();
  const root = readCfb(board).root;
  it('PcbDoc: FileHeader and FileHeaderSix byte for byte as AD17 writes them', () => {
    expect([...cfbStream(root, 'FileHeader')!]).toEqual([0x13, 0, 0, 0, ...[...'PCB 5.0 Bi'].flatMap((c) => [c.charCodeAt(0), 0])]);
    const six = cfbStream(root, 'FileHeaderSix')!;
    expect(new TextDecoder('latin1').decode(six.subarray(5, 24))).toBe('PCB 6.0 Binary File');
    expect(new DataView(six.buffer, six.byteOffset).getFloat64(24, true)).toBe(5.01);
  });
  it('PcbLib: FileHeader with the Pascal string, version 5.01 and an 8-letter id; footprints listed in ComponentParamsTOC', () => {
    const lib = readCfb(demoPcbLib()).root;
    const fh = cfbStream(lib, 'FileHeader')!;
    expect([fh[0], fh[4]]).toEqual([27, 27]);
    expect(new DataView(fh.buffer, fh.byteOffset).getFloat64(32, true)).toBe(5.01);
    expect(new TextDecoder('latin1').decode(fh.subarray(45))).toMatch(/^[A-Z]{8}$/);
    const toc = new TextDecoder('latin1').decode(cfbStream(lib, 'Library/ComponentParamsTOC/Data')!.subarray(4));
    expect(toc.split('\r\n').filter(Boolean).map((l) => l.split('|')[0])).toEqual(readPcbLib(demoPcbLib(), 'Demo.PcbLib').footprints.map((f) => `Name=${f.name}`));
  });
  it('Polygons6: NAME as character codes, POUROVER TRUE with POUROVERSTYLE, AREATHRESHOLD in units²', () => {
    const bag = splitTextRecords(cfbStream(root, 'Polygons6/Data')!)[0]!;
    expect(bag.get('NAME')).toBe(toCharCodes('GND_L2_P000'));
    expect([bag.get('POUROVER'), bag.get('POUROVERSTYLE'), bag.get('AREATHRESHOLD')]).toEqual(['TRUE', '1', '250000000000.000000']);
    expect(readPcbDoc(board, 'Demo.PcbDoc').polygons[0]!.name).toBe('GND_L2_P000');
    expect(fromCharCodes('103,110,100')).toBe('gnd');
    // A pour an earlier Konium wrote is put right on the next save
    const old = PropertyBag.from({ NAME: 'GND_L2_P000', POUROVER: 'SameNetPolygon', ISLANDAREATHRESHOLD: '2500', AUTOGENERATENAME: 'TRUE' });
    const fixed = adPolygonBag(old);
    expect([fixed.get('NAME'), fixed.get('POUROVER'), fixed.get('POUROVERSTYLE'), fixed.has('ISLANDAREATHRESHOLD'), fixed.has('AUTOGENERATENAME')])
      .toEqual([toCharCodes('GND_L2_P000'), 'TRUE', '2', false, false]);
    expect([pourOverOf(fixed), islandAreaOf(fixed)]).toEqual(['SameNetPolygon', 2500]);
    expect(pourOverOf(PropertyBag.from({ POUROVER: 'TRUE', POUROVERSTYLE: '1' }))).toBe('SameNet');
  });
  it('Rules6: each record starts with its rule kind number; booleans are TRUE / FALSE', () => {
    for (const r of splitRuleRecords(cfbStream(root, 'Rules6/Data')!)) expect(r.prefix[0]).toBe(RULE_KIND_IDS[r.bag.get('RULEKIND')!]);
    expect(splitTextRecords(cfbStream(root, 'Nets6/Data')!).map((b) => b.get('VISIBLE'))).toEqual(['TRUE', 'TRUE', 'TRUE']);
  });
  it('new primitives: flags 0x0c, bytes 9–12 0xFF, a via on the multi-layer; every text has its WideStrings6 entry', () => {
    for (const st of ['Tracks6', 'Arcs6', 'Vias6', 'Fills6', 'Texts6', 'Regions6']) {
      for (const r of splitBinaryRecords(cfbStream(root, `${st}/Data`)!)) {
        const s = r.subs[0]!;
        expect([st, s[1], [...s.subarray(9, 13)]]).toEqual([st, 0x0c, [0xff, 0xff, 0xff, 0xff]]);
      }
    }
    expect(splitBinaryRecords(cfbStream(root, 'Vias6/Data')!)[0]!.subs[0]![0]).toBe(L.MULTI);
    const wide = parseWideStrings(cfbStream(root, 'WideStrings6/Data'));
    const texts = splitBinaryRecords(cfbStream(root, 'Texts6/Data')!);
    const idx = texts.map((t) => get(t.subs[0]!, TEXT.wideIndex)!);
    expect(new Set(idx).size).toBe(texts.length);
    expect(idx.every((i) => (wide.get(i) ?? '') !== '')).toBe(true);
    expect(get(encodeTrack({ layer: L.TOP, a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, width: 1 }).subs[0]!, { off: 33, t: 'u16' })).toBe(0);
  });
  it('a via longer than AD14 keeps its per-layer diameters in step with its diameter', () => {
    const long = { tag: 3, subs: [new Uint8Array(300)] };
    const v = encodeVia({ at: { x: 0, y: 0 }, diameter: mil(24), hole: mil(12) }, long).subs[0]!;
    expect(get(v, VIA.diameter)).toBe(mil(24));
    expect(get(v, { off: VIA.layerDiameters + 4 * 31, t: 'i32' })).toBe(mil(24));
  });
});

/** Board6 and the library header as AD17 writes them (26.027: a thin Board6 crashed AD17; a thin library header left one layer tab and pads without copper). */
describe('Board6 and the library header', () => {
  const outline = [[1000, 1000], [7000, 1000], [7000, 5000], [1000, 5000]].map(([x, y]) => ({ p: { x: mil(x!), y: mil(y!) } }));
  const entries = (b: PropertyBag, re: RegExp) => [...new Set(b.keys().map((k) => re.exec(k)?.[1]).filter((x): x is string => x !== undefined))];
  it('a new board: the layer system in all three forms, the outline, drill pair and layer visibility', () => {
    const b = newBoardRecord({ fileName: 'PCB1.PcbDoc', origin: { x: 0, y: 0 }, outline });
    expect(entries(b, /^V9_STACK_LAYER(\d+)_/).length).toBe(9);
    expect(entries(b, /^V9_CACHE_LAYER(\d+)_/).length).toBe(102);
    expect(entries(b, /^LAYER_V8_(\d+)/).length).toBe(56);
    expect([b.get('V9_CACHE_LAYER0_NAME'), b.get('V9_CACHE_LAYER8_NAME'), b.get('LAYER_V8_28NAME'), b.get('LAYER_V8_35NAME')]).toEqual(['Multi-Layer', 'Pad Holes', 'Multi-Layer', 'Pad Holes']);
    expect(Array.from({ length: 82 }, (_, i) => b.get(`LAYER${i + 1}NAME`)).filter(Boolean).length).toBe(82);
    expect([b.get('LAYER74NAME'), b.get('LAYER81NAME'), b.get('LAYER1NEXT'), b.get('LAYER32PREV'), b.get('LAYER33NEXT'), b.get('LAYER38PREV')]).toEqual(['Multi-Layer', 'Pad Holes', '32', '1', '1', '32']);
    expect(b.get('TOGGLELAYERS')).toBe('1'.repeat(82));
    expect(b.get('LAYERPAIR0SUBSTACK_0')!.trim()).toBe(b.get('V9_SUBSTACK0_ID'));
    // The outline as a polygon with its closing vertex; AD's CR before each RECORD=Board
    expect([b.get('VX4'), b.get('VY4'), b.get('LAYER5DIELMATERIAL'), b.get('PLANE16NETNAME')]).toEqual(['1000mil', '1000mil', 'FR-4\r', '(No Net)\r']);
    expect(b.rawEntries().filter((e) => e.k === 'RECORD').length).toBe(22); // AD17's 26 less the four around the view configurations
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(isThinRecord(doc.board.bag!)).toBe(false);
    expect(doc.board.copperStack).toEqual([L.TOP, L.BOTTOM]);
  });
  it('Add Layer twice under Top Layer gives what AD17 saved: cache, V8, legacy and layer sets', () => {
    let b = newBoardRecord({ fileName: 'PCB1.PcbDoc', origin: { x: 0, y: 0 }, outline });
    let rows = readStack(b);
    for (let k = 0; k < 2; k++) rows = addStackLayer(rows, rows.findIndex((r) => r.layer === L.TOP), false, 0)!.rows;
    b = writeStack(b, settleIds(rows));
    const cache = entries(b, /^V9_CACHE_LAYER(\d+)_/);
    expect(cache.length).toBe(104);
    // Mid-Layer 1 and 2 left the spare list and came last, in stack order, with the stack's keys
    expect([21, 100, 101, 102, 103].map((i) => `${b.get(`V9_CACHE_LAYER${i}_NAME`)}=${b.get(`V9_CACHE_LAYER${i}_LAYERID`)}`))
      .toEqual(['Mid-Layer 3=16777220', 'Signal Layer 2=16777218', 'Dielectric 3=17039362', 'Signal Layer 1=16777219', 'Dielectric 2=17039363']);
    expect([b.get('V9_CACHE_LAYER100_COPTHICK'), b.get('V9_CACHE_LAYER101_DIELTYPE'), b.has(`V9_CACHE_LAYER100_${b.get('V9_SUBSTACK0_ID')}CONTEXT`)]).toEqual(['1.417mil', '2', true]);
    expect(entries(b, /^LAYER_V8_(\d+)/).length).toBe(60);
    expect(b.get('LAYERSET1LAYERS')).toMatch(/,DrillDrawing,MidLayer1,MidLayer2$/);
    expect(b.get('LAYERSET2LAYERS')).toBe('MultiLayer,TopLayer,BottomLayer,MidLayer1,MidLayer2');
    // Deleting one again: its dielectric leaves the cache, its copper goes back to a spare entry [est]
    const s = settleIds(rows), del = deleteStackLayer(s, s.findIndex((r) => r.layer === 3), 0) as typeof rows;
    const c = writeStack(b, del);
    expect(entries(c, /^V9_CACHE_LAYER(\d+)_/).length).toBe(103);
    expect(c.keys().filter((k) => /^V9_CACHE_LAYER\d+_NAME$/.test(k)).map((k) => c.get(k)).filter((n) => n === 'Mid-Layer 2')).toHaveLength(1);
    expect(c.get('LAYERSET2LAYERS')).toBe('MultiLayer,TopLayer,BottomLayer,MidLayer1');
  });
  it('a library header has the layer system too; a thin one from an earlier Konium is replaced on saving', () => {
    const h = newLibraryRecord('Demo.PcbLib');
    expect([h.get('KIND'), h.get('TOGGLELAYERS'), h.get('LAYER_V8_28NAME'), h.get('LAYER74NAME'), isThinRecord(h)]).toEqual(['Protel_Advanced_PCB_Library', '1'.repeat(82), 'Multi-Layer', 'Multi-Layer', false]);
    const lib = readCfb(demoPcbLib()).root;
    const data = cfbStream(lib, 'Library/Data')!;
    const n = new DataView(data.buffer, data.byteOffset).getUint32(0, true) & 0xffffff;
    expect(PropertyBag.parse(data.subarray(4, 4 + n)).has('V9_CACHE_LAYER101_NAME')).toBe(true);
    const thin = PropertyBag.from({ KIND: 'Protel_Advanced_PCB_Library', VERSION: '3.00', LAYER1NAME: 'Top Layer' });
    expect(isThinRecord(thin)).toBe(true);
    // An old library re-saved
    const old = writePcbLib([{ name: 'X', records: [] }]);
    const root = readCfb(old).root, w = new BinWriter(64), tb = thin.toBytes();
    w.u32(tb.length).bytes(tb).u32(1).u32(2).u8(1).bytes(new Uint8Array([88]));
    cfbPut(root, 'Library/Data', w.finish());
    const doc = openPcbLib(writeCfb(root), 'Old.PcbLib');
    doc.footprints[0]!.description = 'changed';
    const saved = cfbStream(readCfb(writePcbLibDoc(doc)).root, 'Library/Data')!;
    const m = new DataView(saved.buffer, saved.byteOffset).getUint32(0, true) & 0xffffff;
    expect(PropertyBag.parse(saved.subarray(4, 4 + m)).get('TOGGLELAYERS')).toBe('1'.repeat(82));
  });
});
