import { describe, expect, it } from 'vitest';
import { barcodeModules, barcodeShape, code39Text, type BarcodeSpec } from '../src/model/barcode';
import { barcodeOf, encodeText, longText, readPcbDoc, writePcbDoc, decodePrim } from '../src/formats/altium/pcbdoc';
import { TEXT, get, put } from '../src/formats/altium/pcbLayouts';
import { L } from '../src/model/layers';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { addPrimRecords } from '../src/model/pcbEdit';
import type { PcbText } from '../src/model/pcb';

const spec: BarcodeSpec = { type: 'code39', render: 'full', fullWidth: 10_500_000, height: 2_100_000, minWidth: 100_000, marginX: 200_000, marginY: 200_000, inverted: false, showText: false, font: 'Arial' };

describe('barcodes', () => {
  it('Code 39: start and stop *, 13 modules a character (wide twice narrow, as AD17 draws it)', () => {
    const m = barcodeModules('A1', 'code39');
    expect(m.length).toBe(4 * 13 - 1);
    // * is n w n n W n W n n (bar, space, …): bar, then a wide space
    expect(m.slice(0, 5)).toEqual([true, false, false, true, false]);
    expect(code39Text('ab-1*?\u00e9')).toBe('ab-1*?');
  });

  it('Code 39 Full ASCII: AD17\'s "Test 123" is 13 symbols, 65 bars (lower case as +E, +S, +T)', () => {
    const m = barcodeModules('Test 123', 'code39');
    const bars = m.filter((v, i) => v && !m[i - 1]).length;
    expect(bars).toBe(65);
    expect(m.length).toBe(13 * 13 - 1);
  });

  it('Code 128 B: start, the characters, the check symbol, stop (11 modules each, the stop 13)', () => {
    const m = barcodeModules('Hi', 'code128');
    expect(m.length).toBe(11 * 4 + 13);
    // Start B is 211214: two bar modules first; the stop ends in two bars
    expect(m.slice(0, 3)).toEqual([true, true, false]);
    expect(m.slice(-2)).toEqual([true, true]);
  });

  it('by full width the bars fill the box inside the margins; by min width the box grows to the bars', () => {
    const full = barcodeShape('KONIUM', { x: 0, y: 0 }, 0, false, 600_000, spec);
    const xs = full.rects.flatMap((r) => r.map((p) => p.x));
    expect(Math.min(...xs)).toBe(200_000);
    expect(Math.max(...xs)).toBeCloseTo(10_300_000, -1);
    expect(full.box[2]).toEqual({ x: 10_500_000, y: 2_100_000 });
    const min = barcodeShape('KONIUM', { x: 0, y: 0 }, 0, false, 600_000, { ...spec, render: 'min' });
    const n = barcodeModules('KONIUM', 'code39').length;
    expect(min.box[1]!.x).toBe(n * 100_000 + 400_000);
  });

  it('inverted: the box filled less the bars; turned with the text; the words under the bars', () => {
    const plain = barcodeShape('12', { x: 0, y: 0 }, 0, false, 600_000, spec);
    const inv = barcodeShape('12', { x: 0, y: 0 }, 0, false, 600_000, { ...spec, inverted: true });
    const area = (rs: { x: number; y: number }[][]) => rs.reduce((a, r) => a + Math.abs((r[1]!.x - r[0]!.x) * (r[2]!.y - r[1]!.y)), 0);
    expect(area(plain.rects) + area(inv.rects)).toBeCloseTo(10_500_000 * 2_100_000, -6);
    const turned = barcodeShape('12', { x: 0, y: 0 }, 90, false, 600_000, spec);
    expect(turned.box[1]).toEqual({ x: 0, y: 10_500_000 });
  });

  it('Show Text, as AD17 draws it: the box grows by the String\'s height, each character centred in its share, bars down to the capitals', () => {
    // AD17's "Test 123": 1050 × 210 mil, margins 20, text 2 mm; its box is 289 mil tall, bars stop 67 mil above the bottom
    const h = 787_402;
    const shown = barcodeShape('Test 123', { x: 0, y: 0 }, 0, false, h, { ...spec, showText: true, inverted: true });
    expect(shown.box[2]!.y).toBe(2_100_000 + h);
    expect(shown.label?.text).toBe('Test 123');
    expect(shown.label?.chars.map((c) => c.text).join('')).toBe('Test123');
    const slot = 10_100_000 / 8;
    expect(shown.label!.chars[0]!.at.x).toBe(Math.round(200_000 + slot / 2));
    expect(shown.label!.chars[4]!.at.x).toBe(Math.round(200_000 + 5.5 * slot));
    const barLo = Math.min(...shown.rects.filter((r) => r[0]!.y > 0).map((r) => r[0]!.y));
    expect(barLo / 10_000).toBeGreaterThan(64); expect(barLo / 10_000).toBeLessThan(69);
    expect(shown.label!.height / 10_000).toBeCloseTo(50.5, 0);
  });

  it('a text record made long carries AD17\'s barcode defaults and the V7 layer; a barcode is read back', () => {
    const short = encodeText({ layer: L.TOP_OVERLAY, at: { x: 0, y: 0 }, height: 600_000, text: 'X' }).subs[0]!;
    const long = longText(short);
    expect(long.length).toBe(252);
    expect(get(long, TEXT.bcFullWidth)).toBe(10_500_000);
    expect(get(long, TEXT.layerV7)).toBe(0x01030006);
    put(long, TEXT.fontType, 2); put(long, TEXT.kind, 2); put(long, TEXT.bcType, 1); put(long, TEXT.bcInverted, 0);
    const b = barcodeOf(long);
    expect(b).toMatchObject({ type: 'code128', render: 'full', fullWidth: 10_500_000, height: 2_100_000, marginX: 200_000, inverted: false, showText: true, font: 'Arial' });
    const doc = readPcbDoc(newPcbDocBytes('B.PcbDoc'), 'B.PcbDoc');
    addPrimRecords(doc, [{ storage: 'Texts6', rec: { ...encodeText({ layer: L.TOP_OVERLAY, at: { x: 1000, y: 2000 }, height: 600_000, text: 'ABC' }), subs: [long, new Uint8Array([3, 65, 66, 67])], wide: 'ABC' } }]).apply();
    const back = readPcbDoc(writePcbDoc(doc), 'B.PcbDoc');
    const t = back.prims.find((p): p is PcbText => p.kind === 'text' && p.text === 'ABC')!;
    expect(t.barcode?.type).toBe('code128');
    expect(t.layer).toBe(L.TOP_OVERLAY);
    expect(decodePrim).toBeTypeOf('function');
  });
});

describe('jumper IDs', async () => {
  const { demoPcbDoc } = await import('../src/formats/synthetic/demo');
  const { connections, jumperLinks } = await import('../src/model/drc');
  const { replaceRecords, removePrims, setComponentProps } = await import('../src/model/pcbEdit');
  const { PAD } = await import('../src/formats/altium/pcbLayouts');
  it('a Jumper component\'s pads with the same Jumper ID are joined: no connection line between them, a jumper drawn; in a component of another type the IDs join nothing', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // Unrouted: every pad stands alone
    removePrims(doc, doc.prims.filter((p) => p.kind === 'track' || p.kind === 'arc' || p.kind === 'via' || p.kind === 'region' || p.kind === 'fill')).apply();
    const pads = doc.prims.filter((p) => p.kind === 'pad' && p.component === 2 && p.net === 2);
    expect(pads.length).toBe(2);
    const before = connections(doc).filter((c) => c.net === 2).length;
    replaceRecords(doc, pads.map((p) => {
      const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
      const subs = rec.subs.map((s) => s.slice());
      put(subs[4]!, PAD.jumperId, 1);
      return { storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } };
    })).apply();
    expect(doc.prims.filter((p) => p.kind === 'pad' && p.jumper === 1).length).toBe(2);
    // The component is of the Standard type: its pads' IDs make no jumper (26.181: they did, and an arc was drawn
    // between two pads of a part that the copper already joined)
    expect(connections(doc).filter((c) => c.net === 2).length).toBe(before);
    expect(jumperLinks(doc).length).toBe(0);
    setComponentProps(doc, 2, { COMPONENTKIND: '6' }).apply();
    const after = connections(doc).filter((c) => c.net === 2).length;
    expect(after).toBe(before - 1);
    expect(jumperLinks(doc).length).toBe(1);
    // A Jumper whose pads have no ID: none either
    replaceRecords(doc, doc.prims.filter((p) => p.kind === 'pad' && p.jumper === 1).map((p) => {
      const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
      const subs = rec.subs.map((s) => s.slice());
      put(subs[4]!, PAD.jumperId, 0);
      return { storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } };
    })).apply();
    expect(jumperLinks(doc).length).toBe(0);
    expect(connections(doc).filter((c) => c.net === 2).length).toBe(before);
  });
});
