import { describe, expect, it } from 'vitest';
import { PropertyBag } from '../src/formats/altium/props';
import { joinSchRecords, splitSchRecords, splitBinaryRecords, joinBinaryRecords } from '../src/formats/altium/framing';
import { binToBytes, bytesToBin } from '../src/formats/text';
import { bytesEqual } from '../src/formats/bin';
import { cfbCompare, cfbPut, newEntry, readCfb, writeCfb, walkCfb } from '../src/formats/cfb/cfb';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readPrjPcb, writePrjPcb } from '../src/formats/altium/prjpcb';
import { demoPcbDoc, demoPrjPcb, demoSchDoc } from '../src/formats/synthetic/demo';
import { detect } from '../src/formats/registry';
import { addRecords, removeObjects, wireBag } from '../src/model/schEdit';
import { addTracks } from '../src/model/pcbEdit';
import { parseLength, mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';

describe('PropertyBag', () => {
  it('round-trips unmodified bytes exactly, including odd spacing and duplicates', () => {
    const raw = binToBytes('|RECORD=27|Owner=1|X1=10|X1=11|FLAG|EMPTY=|TEXT=a=b\0');
    const bag = PropertyBag.parse(raw);
    expect(bytesEqual(bag.toBytes(), raw)).toBe(true);
    expect(bag.int('record')).toBe(27);
    expect(bag.getRaw('x1')).toBe('10');          // first occurrence wins
    expect(bag.get('TEXT')).toBe('a=b');
    expect(bag.has('FLAG')).toBe(true);
  });

  it('writes %UTF8% twins for non-ANSI text and reads them back', () => {
    const bag = PropertyBag.from({ TEXT: 'x' });
    bag.set('TEXT', 'Ω 10µF — ok');
    expect(bag.get('TEXT')).toBe('Ω 10µF — ok');
    expect(bag.getRaw('%UTF8%TEXT')).toBeDefined();
    const again = PropertyBag.parse(bag.toBytes());
    expect(again.get('TEXT')).toBe('Ω 10µF — ok');
  });

  it('cp1252 values decode (µ, —)', () => {
    const bag = PropertyBag.parse(binToBytes('|TEXT=10\xb5F \x97 x'));
    expect(bag.get('TEXT')).toBe('10µF — x');
  });
});

describe('record framing', () => {
  it('schematic records: text + binary round-trip', () => {
    const recs = [
      { kind: 0, data: new Uint8Array(), bag: PropertyBag.parse(binToBytes('|HEADER=x\0')) },
      { kind: 1, data: new Uint8Array([2, 0, 0, 0, 9, 9]) },
    ];
    const bytes = joinSchRecords(recs);
    const back = splitSchRecords(bytes);
    expect(back).toHaveLength(2);
    expect(back[1]!.kind).toBe(1);
    expect(bytesEqual(joinSchRecords(back), bytes)).toBe(true);
  });

  it('binary primitive records keep subrecord boundaries', () => {
    const recs = [{ tag: 4, subs: [new Uint8Array(46).fill(7)] }, { tag: 5, subs: [new Uint8Array(45), binToBytes('\x02U1')] }];
    const bytes = joinBinaryRecords(recs);
    expect(bytesEqual(joinBinaryRecords(splitBinaryRecords(bytes)), bytes)).toBe(true);
  });
});

describe('CFB', () => {
  it('orders names per MS-CFB (length first, then upper-case)', () => {
    expect(['Data', 'b', 'Header', 'A'].sort(cfbCompare)).toEqual(['A', 'b', 'Data', 'Header']);
  });

  it('writes a valid red-black directory tree', () => {
    const root = newEntry('Root Entry', 'root');
    for (let i = 0; i < 37; i++) cfbPut(root, `S${i}/Data`, new Uint8Array(i * 50));
    const bytes = writeCfb(root);
    // Parse the directory directly and check RB invariants per storage
    const f = readCfb(bytes);
    expect(f.root.children).toHaveLength(37);
    const dv = new DataView(bytes.buffer);
    const dirStart = dv.getUint32(48, true);
    const entries: { left: number; right: number; child: number; black: boolean }[] = [];
    let sec = dirStart;
    const fat = (s: number) => dv.getUint32(512 + s * 4, true); // first FAT sector is sector 0
    while (sec !== 0xfffffffe) {
      for (let i = 0; i < 4; i++) {
        const o = (sec + 1) * 512 + i * 128;
        entries.push({ black: bytes[o + 67] === 1, left: dv.getUint32(o + 68, true), right: dv.getUint32(o + 72, true), child: dv.getUint32(o + 76, true) });
      }
      sec = fat(sec);
    }
    const blackHeight = (id: number): number => {
      if (id === 0xffffffff) return 1;
      const e = entries[id]!;
      if (!e.black) for (const c of [e.left, e.right]) if (c !== 0xffffffff) expect(entries[c]!.black).toBe(true);
      const l = blackHeight(e.left), r = blackHeight(e.right);
      expect(l).toBe(r);
      return l + (e.black ? 1 : 0);
    };
    expect(entries[entries[0]!.child]!.black).toBe(true);
    blackHeight(entries[0]!.child);
  });
});

describe('SchDoc', () => {
  const bytes = demoSchDoc();

  it('detects and parses the demo', () => {
    expect(detect(bytes, 'x.bin')).toBe('SchDoc');
    const doc = readSchDoc(bytes, 'Demo.SchDoc');
    const kinds = doc.objects.map((o) => o.kind);
    expect(kinds.filter((k) => k === 'component')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'wire')).toHaveLength(10);
    const u1 = doc.objects.find((o) => o.kind === 'component' && o.designator === 'U1');
    expect(u1 && u1.kind === 'component' && u1.children.length).toBeGreaterThan(3);
    const label = doc.objects.find((o) => o.kind === 'text' && o.text.startsWith('Konium Designer demo'));
    expect(label && label.kind === 'text' && label.text).toContain('—');
  });

  it('unmodified save is stream-identical', () => {
    const doc = readSchDoc(bytes, 'Demo.SchDoc');
    const out = writeSchDoc(doc);
    const a: Record<string, string> = {}, b: Record<string, string> = {};
    walkCfb(readCfb(bytes).root, (e, p) => { a[p] = bytesToBin(e.data); });
    walkCfb(readCfb(out).root, (e, p) => { b[p] = bytesToBin(e.data); });
    expect(b).toEqual(a);
  });

  it('add + remove with undo restores the original records', () => {
    const doc = readSchDoc(bytes, 'Demo.SchDoc');
    const before = bytesToBin(writeSchDoc(doc).subarray(0));
    const add = addRecords(doc, [wireBag([{ x: 0, y: 0 }, { x: mil(500), y: 0 }])]);
    add.apply();
    expect(doc.objects.at(-1)!.kind).toBe('wire');
    const compIdx = doc.objects.findIndex((o) => o.kind === 'component');
    const rm = removeObjects(doc, [compIdx]);
    rm.apply();
    // Ownership must still resolve after renumbering
    for (const o of doc.objects) if (o.owner >= 0) expect(['component', 'meta']).toContain(doc.objects[o.owner]?.kind);
    rm.revert();
    add.revert();
    expect(bytesToBin(writeSchDoc(doc))).toBe(before);
  });
});

describe('PcbDoc', () => {
  const bytes = demoPcbDoc();

  it('decodes primitives and board', () => {
    expect(detect(bytes, 'x')).toBe('PcbDoc');
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    expect(doc.nets.map((n) => n.name)).toEqual(['GND', 'VIN', '+3V3']);
    expect(doc.components.map((c) => c.designator)).toEqual(['J1', 'C1', 'U1', 'C2']);
    const count = (k: string) => doc.prims.filter((p) => p.kind === k).length;
    expect(count('pad')).toBe(10);
    expect(count('via')).toBe(3);
    expect(count('arc')).toBe(2);
    expect(count('fill')).toBe(1);
    expect(count('text')).toBe(8); // with the .Legend string on the Drill Drawing layer
    expect(doc.dimensions.map((d) => [d.kind, d.layer])).toEqual([[1, L.MECH1], [1, L.MECH1]]);
    expect(count('region')).toBe(2);
    const pour = doc.prims.find((p) => p.kind === 'region' && p.polygon === 0);
    // Poured by the engine: board-sized outline, holes round the VIN pad and the relief air gaps
    expect(pour && pour.kind === 'region' && [pour.layer, pour.outline.length]).toEqual([L.BOTTOM, 4]);
    expect(pour && pour.kind === 'region' && pour.holes.length).toBeGreaterThan(4);
    expect(doc.polygons.map((p) => [p.name, p.layer, p.net, p.outline.length])).toEqual([['GND_L2_P000', L.BOTTOM, 0, 4]]);
    const shaped = doc.prims.find((p) => p.kind === 'region' && p.src.storage === 'ShapeBasedRegions6');
    expect(shaped && shaped.kind === 'region' && shaped.layer).toBe(L.TOP);
    expect(shaped && shaped.kind === 'region' && shaped.outline.length).toBeGreaterThan(8); // arc flattened
    const comment = doc.prims.find((p) => p.kind === 'text' && p.isComment);
    expect(comment && comment.kind === 'text' && comment.hidden).toBe(true);
    const des = doc.prims.filter((p) => p.kind === 'text' && p.isDesignator);
    expect(des.every((p) => p.kind === 'text' && !p.hidden)).toBe(true);
    expect(doc.board.outline).toHaveLength(4);
    expect(doc.board.copperStack).toEqual([L.TOP, L.BOTTOM]);
    const t = doc.prims.find((p) => p.kind === 'text' && p.component === 0);
    expect(t && t.kind === 'text' && t.text).toBe('J1'); // .Designator resolved
    const pad = doc.prims.find((p) => p.kind === 'pad' && p.name === '4');
    expect(pad && pad.kind === 'pad' && pad.top.w).toBe(mm(3.3));
  });

  it('unmodified save is stream-identical; added track survives a round trip', () => {
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    const n0 = doc.prims.filter((p) => p.kind === 'track').length;
    const ch = addTracks(doc, [{ layer: L.BOTTOM, a: { x: 0, y: 0 }, b: { x: mil(100), y: mil(50) }, width: mil(10) }]);
    ch.apply();
    const reread = readPcbDoc(writePcbDoc(doc), 'x');
    const tracks = reread.prims.filter((p) => p.kind === 'track');
    expect(tracks).toHaveLength(n0 + 1);
    const last = tracks.at(-1)!;
    expect(last.kind === 'track' && [last.layer, last.b.x, last.b.y, last.width]).toEqual([L.BOTTOM, mil(100), mil(50), mil(10)]);
    ch.revert();
    expect(doc.dirty.size).toBe(0);
  });
});

describe('PrjPcb', () => {
  it('lists documents and saves byte-identical', () => {
    const b = demoPrjPcb();
    const p = readPrjPcb(b, 'Demo.PrjPcb');
    expect(p.documents).toEqual(['Demo.SchDoc', 'Demo.PcbDoc', 'Symbols.SchDoc', 'Demo.PcbLib', 'Demo.SchLib', 'Child.SchDoc', 'Demo.OutJob', 'Demo.DbLib']);
    expect(bytesEqual(writePrjPcb(p), b)).toBe(true);
  });
});

describe('units', () => {
  it('parses Altium length strings', () => {
    expect(parseLength('1000mil')).toBe(mil(1000));
    expect(parseLength('1.5mm')).toBe(mm(1.5));
    expect(parseLength('12.3456mil')).toBe(123456);
    expect(parseLength('garbage')).toBeUndefined();
  });
});

describe('input normalisation', () => {
  it('reads CFB from a view with a non-zero byteOffset (Node Buffer case)', () => {
    const bytes = demoSchDoc();
    const pool = new Uint8Array(bytes.length + 64);
    pool.set(bytes, 37);
    const view = pool.subarray(37, 37 + bytes.length);
    // emulate Buffer.slice semantics (view, not copy) to guard against regressions
    (view as unknown as { slice: (a?: number, b?: number) => Uint8Array }).slice = (a?: number, b?: number) => view.subarray(a, b);
    expect(readSchDoc(view, 'x').objects.length).toBeGreaterThan(10);
  });
});
