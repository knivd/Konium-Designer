import { describe, expect, it } from 'vitest';
import { inflateRawSync, unzipSync } from '../src/formats/inflate';
import { zip } from '../src/formats/zip';
import {
  addBoardPart, addModule, applyM, crossBoardLinks, mbsChecks, newMbaDoc, newMbsDoc, readMbaDoc, readMbsDoc, redoChange, setPartMatrix, shifted, turned, undoChange,
  writeMbaDoc, writeMbsDoc, type MbsDocument,
} from '../src/formats/altium/multiboard';
import { detect, load } from '../src/formats/registry';
import { PROJECT_FILE } from '../src/formats/altium/prjpcb';

async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('DEFLATE and ZIP, read at once', () => {
  it('inflates what a deflater made: text, noise, nothing', async () => {
    const text = new TextEncoder().encode(JSON.stringify({ modules: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Module ${i}`, pins: [1, 2, 3] })) }, null, 2));
    expect(same(inflateRawSync(await deflate(text)), text)).toBe(true);
    let seed = 3;
    const noise = Uint8Array.from({ length: 50_000 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; });
    expect(same(inflateRawSync(await deflate(noise)), noise)).toBe(true);
    expect(inflateRawSync(await deflate(new Uint8Array()))).toHaveLength(0);
  });
  it('a ZIP of stored entries, names with backslashes kept', () => {
    const z = zip([{ name: 'logical.json', bytes: new TextEncoder().encode('{}') }, { name: 'Pages\\page_1.json', bytes: new TextEncoder().encode('{"items":[]}') }]);
    expect(unzipSync(z).map((e) => e.name)).toEqual(['logical.json', 'Pages\\page_1.json']);
  });
});

/** Two boards, a connector each (pins 1–3 on GND, SDA, SCL; the second's SCL named differently), joined directly. */
function twoBoards(): MbsDocument {
  const d = newMbsDoc('MB.MbsDoc');
  const a = addModule(d, '..\\Main\\Main.PrjPcb', 60, 80), b = addModule(d, '..\\Sensor\\Sensor.PrjPcb', 400, 80);
  const pins = (nets: string[], base: number) => nets.map((n, i) => ({ pinId: String(i + 1), name: String(i + 1), number: String(i + 1), parameters: [{ name: 'ExternalNetName', value: n, id: base + 100 + i }], id: base + i }));
  a.components = [{ designator: 'J1', pins: pins(['GND', 'SDA', 'SCL'], 1000), id: 990 }];
  b.components = [{ designator: 'J7', pins: pins(['GND', 'SDA', 'I2C_CLK'], 2000), id: 991 }];
  a.entries = [{ calculatedDesignator: 'J1', id: 501 }, { calculatedDesignator: 'J2', id: 503 }];
  b.entries = [{ calculatedDesignator: 'J7', id: 502 }];
  a.entryPinMap = { map: a.components[0]!.pins.map((p) => ({ key: p.id, value: 501 })) };
  b.entryPinMap = { map: b.components[0]!.pins.map((p) => ({ key: p.id, value: 502 })) };
  d.logical.connections.push({ $type: '__logicalDirectConnection', entriesConnection: { entry1: 501, entry2: 502, id: 600 }, designator: 'C_1', parameters: [], id: 601 });
  return d;
}

describe('Multi-board schematics (.MbsDoc)', () => {
  it('modules placed; pins joined across the boards, pin to pin, with their nets; what doesn\'t meet', () => {
    const d = twoBoards();
    expect(d.logical.modules.map((m) => [m.designator, m.title])).toEqual([['1', 'Main'], ['2', 'Sensor']]);
    expect(d.pages[0]!.data.items.filter((i) => i.$type === '__drawingModule')).toHaveLength(2);
    expect(crossBoardLinks(d)).toEqual([
      { connection: 'C_1', kind: 'Direct', a: '1:J1-1', b: '2:J7-1', netA: 'GND', netB: 'GND' },
      { connection: 'C_1', kind: 'Direct', a: '1:J1-2', b: '2:J7-2', netA: 'SDA', netB: 'SDA' },
      { connection: 'C_1', kind: 'Direct', a: '1:J1-3', b: '2:J7-3', netA: 'SCL', netB: 'I2C_CLK' },
    ]);
    expect(mbsChecks(d)).toEqual(['Module 1: entry J2 isn\'t connected', 'C_1: 1:J1-3 (SCL) meets 2:J7-3 (I2C_CLK)']);
  });
  it('kept as AD keeps it: a ZIP of JSON, read back the same; undo and redo', () => {
    const d = twoBoards();
    const bytes = writeMbsDoc(d);
    expect(detect(bytes, 'MB.MbsDoc')).toBe('MbsDoc');
    const back = load(bytes, 'MB.MbsDoc') as MbsDocument;
    expect(back.logical).toEqual(d.logical);
    expect(back.pages[0]!.data.items).toEqual(d.pages[0]!.data.items);
    const names = unzipSync(bytes).map((e) => e.name);
    expect(names).toContain('Pages\\page_1.json');
    expect(new TextDecoder().decode(unzipSync(bytes).find((e) => e.name === 'logical.json')!.bytes)).toMatch(/^\{\r\n {2}"uniqueId"/);
    const e = readMbsDoc(bytes, 'MB.MbsDoc');
    addModule(e, '..\\Third\\Third.PrjPcb', 100, 400);
    expect(e.logical.modules).toHaveLength(3);
    expect(undoChange(e)).toBe('Place Module');
    expect(e.logical.modules).toHaveLength(2);
    expect(redoChange(e)).toBe('Place Module');
    expect(e.logical.modules.map((m) => m.designator)).toEqual(['1', '2', '3']);
  });
});

describe('Multi-board assemblies (.MbaDoc)', () => {
  it('boards placed by a 4×4 matrix (row vectors), turned and moved, written with AD\'s derived members', () => {
    const d = newMbaDoc('A.MbaDoc');
    const p = addBoardPart(d, { name: 'Main.PcbDoc', path: '..\\Main\\Main.PcbDoc', offset: { x: 10_000_000, y: 10_000_000 }, designator: '1', title: 'Main', sourceId: 'abc-1' }, [0, 0, 0]);
    setPartMatrix(d, p, turned(p.m, 'z', 90), 'Rotate');
    setPartMatrix(d, p, shifted(p.m, 5, 0, 2));
    const q = applyM(p.m, [1, 0, 0]);
    expect(q[0]).toBeCloseTo(5, 9); expect(q[1]).toBeCloseTo(1, 9); expect(q[2]).toBeCloseTo(2, 9);
    const bytes = writeMbaDoc(d);
    expect(detect(bytes, 'A.MbaDoc')).toBe('MbaDoc');
    const back = readMbaDoc(bytes, 'A.MbaDoc');
    expect(back.parts.map((x) => x.name)).toEqual(['Main']);
    expect(back.parts[0]!.m.map((x) => +x.toFixed(9))).toEqual(p.m.map((x) => +x.toFixed(9)));
    const t = back.parts[0]!.json.Transform as Record<string, { X: number }>;
    expect(t.TranslationVector!.X).toBe(5);
    expect(t.Right!.X).toBeCloseTo(0, 9);
    // Undone back to where it was placed
    undoChange(d); undoChange(d);
    expect(d.parts[0]!.m.slice(12, 15)).toEqual([0, 0, 0]);
  });
  it('a multi-board project is a project', () => {
    expect(PROJECT_FILE.test('Robot.PrjMbd')).toBe(true);
  });
});
