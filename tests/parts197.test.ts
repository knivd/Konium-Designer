/**
 * R21, step 1 (26.197): a part as the parts library keeps one (an exact part number with its
 * symbol, its footprint and what it was read from), the part file, the checks, the shelf's two
 * libraries, and the feature's place in the release stages.
 */
import { describe, expect, it } from 'vitest';
import { FEATURES, FEATURE_COMMANDS, STAGE, featureOn } from '../src/core/release';
import { PANELS } from '../src/app/dock/panels';
import { EXAMPLE_PART, examplePart } from '../src/model/partExample';
import { PART_EXT, PART_FORMAT, SHELF_PCB, SHELF_SCH, linkedFootprints, makePart, padNames, partChecks, partFile, partFootprint, partIntLib, partKey, partName, partSymbol, readPartFile, shelfLibraries } from '../src/model/partPackage';
import { readSchLib } from '../src/formats/altium/schlib';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { unpackIntLib } from '../src/formats/altium/intlib';
import { ipcDefaults, ipcFootprint, ipcRecords } from '../src/model/ipcFootprint';
import { zip } from '../src/formats/zip';

const part = () => examplePart('26.197');
const param = (bags: { get(k: string): string | undefined }[], name: string) => bags.find((b) => b.get('NAME') === name)?.get('TEXT');

describe('a part (R21, 26.197)', () => {
  it('is one exact part number with its record, its symbol and its footprint', () => {
    const p = part();
    expect(p.record).toMatchObject({
      format: PART_FORMAT, mpn: 'KD-EX1833-SO8', maker: 'Konium (example)', device: 'KD-EX1833', symbol: 'KD-EX1833-SO8',
      package: { name: 'SO-8', pins: 8, footprint: 'SOIC127P600X175-8N', from: 'ipc' },
      made: { at: '2026-11-19T00:00:00.000Z', app: '26.197', by: 'Konium\'s example' },
    });
    expect(p.record.pins.map((x) => `${x.number} ${x.name} ${x.type}`)).toEqual(['1 OUT power', '2 SENSE input', '3 NC nc', '4 GND ground', '5 EN input', '6 NC nc', '7 PG oc', '8 IN power']);
    // The symbol: named after the part, linked to the footprint, carrying what a bill of materials reads
    const sym = partSymbol(p)!;
    expect(sym.libRef).toBe('KD-EX1833-SO8');
    expect(linkedFootprints(sym.bags)).toEqual(['SOIC127P600X175-8N']);
    expect(param(sym.bags, 'Manufacturer Part Number')).toBe('KD-EX1833-SO8');
    expect(param(sym.bags, 'Manufacturer')).toBe('Konium (example)');
    expect(param(sym.bags, 'Package')).toBe('SO-8');
    expect(param(sym.bags, 'ComponentLink1URL')).toBeUndefined();
    // The footprint: its eight pads, and its 3D body with it
    const fp = partFootprint(p)!;
    expect(fp.name).toBe('SOIC127P600X175-8N');
    expect(padNames(fp.records).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(readPcbLib(p.pcblib, 'x.PcbLib').footprints[0]!.prims.some((x) => x.kind === 'body')).toBe(true);
    expect(readSchLib(p.schlib, 'x.SchLib').symbols).toHaveLength(1);
  });

  it('a part with a datasheet link carries it as its first component link', () => {
    const base = part();
    const p = makePart({
      mpn: ' AB123D ', maker: 'Maker', device: 'AB123', description: 'A thing', packageName: 'SO8', from: 'datasheet',
      symbol: partSymbol(base)!, footprint: partFootprint(base)!, pins: base.record.pins,
      datasheet: { url: 'https://maker.example/ab123.pdf', title: 'AB123 datasheet', sha256: 'a'.repeat(64), pages: 12, pinPages: [3], packagePages: [10, 11] },
      app: '26.197', by: 'the Component Builder', at: new Date(Date.UTC(2026, 10, 19, 12)),
    });
    expect(p.record.mpn).toBe('AB123D');
    expect(p.record.datasheet).toEqual({ url: 'https://maker.example/ab123.pdf', title: 'AB123 datasheet', sha256: 'a'.repeat(64), pages: 12, pinPages: [3], packagePages: [10, 11] });
    const sym = partSymbol(p)!;
    expect([param(sym.bags, 'ComponentLink1Description'), param(sym.bags, 'ComponentLink1URL')]).toEqual(['Datasheet', 'https://maker.example/ab123.pdf']);
    // What was there keeps its place: the footprint's link still reads
    expect(linkedFootprints(sym.bags)).toEqual(['SOIC127P600X175-8N']);
    expect(partChecks(p).map((c) => c.level)).toEqual(['note']);
  });

  it('part numbers as compared and as names', () => {
    expect([partKey('PIC18F06Q41-E/ST'), partKey(' pic18f06q41 e-st '), partKey('—')]).toEqual(['PIC18F06Q41EST', 'PIC18F06Q41EST', '']);
    expect([partName('PIC18F06Q41-E/ST'), partName('  '), PART_EXT]).toEqual(['PIC18F06Q41-E_ST', 'Part', '.kpart']);
  });
});

describe('what can be checked of a part without its datasheet (26.197)', () => {
  it('every pin its pad and every pad its pin; where it was read from', () => {
    const c = partChecks(part());
    expect(c[0]).toEqual({ level: 'note', text: 'Every one of its 8 pins has its pad, and every pad its pin' });
    expect(c[1]).toEqual({ level: 'warning', text: 'It doesn\'t say which datasheet it was read from' });
    expect(c).toHaveLength(2);
  });
  it('a pin without a pad, a pad without a pin, a symbol that links another footprint', () => {
    const base = part();
    const sym = partSymbol(base)!;
    // A footprint of six pads for a symbol of eight pins
    const spec = { ...ipcDefaults('SOIC'), pins: 6 };
    const six = ipcFootprint(spec);
    const p = makePart({ ...EXAMPLE_PART, packageName: 'SO-6', from: 'ipc', symbol: sym, footprint: { name: six.name, records: ipcRecords(six, spec) }, pins: base.record.pins, datasheet: base.record.datasheet, app: 'x', by: 'y' });
    const texts = partChecks(p).map((c) => `${c.level}: ${c.text}`);
    expect(texts).toContain('error: Pins with no pad in the footprint: 7, 8');
    expect(texts).toContain(`error: The symbol links the footprint SOIC127P600X175-8N, not ${six.name}`);
    expect(p.record.package.pins).toBe(6);
  });
});

describe('the part file (26.197)', () => {
  it('goes out and comes back as it was', () => {
    const p = part();
    const back = readPartFile(partFile(p));
    expect(back.record).toEqual(p.record);
    expect(partSymbol(back)!.libRef).toBe('KD-EX1833-SO8');
    expect(padNames(partFootprint(back)!.records)).toHaveLength(8);
    expect(partChecks(back)).toEqual(partChecks(p));
  });
  it('what isn\'t a part file is refused, and a record is put in order', () => {
    const p = part();
    expect(() => readPartFile(new Uint8Array([1, 2, 3]))).toThrow('Not a part file');
    expect(() => readPartFile(zip([{ name: 'part.json', bytes: new TextEncoder().encode('{}') }]))).toThrow(/holds no part\.json with a symbol and a footprint/);
    const file = (record: object) => zip([{ name: 'part.json', bytes: new TextEncoder().encode(JSON.stringify(record)) }, { name: 'symbol.SchLib', bytes: p.schlib }, { name: 'footprint.PcbLib', bytes: p.pcblib }]);
    expect(() => readPartFile(file({ ...p.record, format: PART_FORMAT + 1 }))).toThrow('This part file is from a later Konium Designer');
    expect(() => readPartFile(file({ ...p.record, mpn: ' - ' }))).toThrow('This part file names no part number');
    expect(() => readPartFile(zip([{ name: 'part.json', bytes: new TextEncoder().encode(JSON.stringify(p.record)) }, { name: 'symbol.SchLib', bytes: new Uint8Array(20) }, { name: 'footprint.PcbLib', bytes: p.pcblib }]))).toThrow(/symbol or footprint can't be read/);
    // A link that isn't one, a fingerprint that isn't one, pages that aren't numbers: left out
    const odd = readPartFile(file({ ...p.record, datasheet: { url: 'javascript:alert(1)', title: 7, sha256: 'xyz', pages: 'many', pinPages: [1, 'two', -3, 4], packagePages: null }, package: { name: 'SO-8', pins: 8, footprint: 'F', from: 'elsewhere' } }));
    expect(odd.record.datasheet).toEqual({ url: '', title: '', sha256: '', pages: 0, pinPages: [1, 4], packagePages: [] });
    expect(odd.record.package.from).toBe('drawn');
  });
  it('a part is also an integrated library: its two libraries packed as Make Integrated Library packs them', async () => {
    const libs = await unpackIntLib(await partIntLib(part()), 'KD-EX1833-SO8.IntLib');
    expect(libs.map((l) => l.name.split('.').pop()!.toLowerCase()).sort()).toEqual(['pcblib', 'schlib']);
    expect(readSchLib(libs.find((l) => /schlib$/i.test(l.name))!.bytes, 'a.SchLib').symbols[0]!.libRef).toBe('KD-EX1833-SO8');
  });
});

describe('the shelf as two libraries (26.197)', () => {
  it('parts of one package share its footprint; a footprint of that name that differs stays under its own', () => {
    const a = part();
    const again = (mpn: string, footprint = partFootprint(a)!) => makePart({ ...EXAMPLE_PART, mpn, packageName: 'SO-8', from: 'ipc', symbol: { ...partSymbol(a)!, libRef: mpn }, footprint, pins: a.record.pins, datasheet: a.record.datasheet, app: 'x', by: 'y' });
    const b = again('KD-EX1850-SO8');
    // The same name, other pads (the package as another datasheet draws it)
    const wide = { ...ipcDefaults('SOIC'), density: 'M' as const };
    const c = again('KD-EX1812-SO8', { name: 'SOIC127P600X175-8N', records: ipcRecords(ipcFootprint(wide), wide) });
    const libs = shelfLibraries([a, b, c]);
    expect([libs.symbols, libs.footprints]).toEqual([3, 2]);
    const sch = readSchLib(libs.schlib, SHELF_SCH), pcb = readPcbLib(libs.pcblib, SHELF_PCB);
    expect(sch.symbols.map((s) => s.libRef)).toEqual(['KD-EX1833-SO8', 'KD-EX1850-SO8', 'KD-EX1812-SO8']);
    expect(pcb.footprints.map((f) => f.name)).toEqual(['SOIC127P600X175-8N', 'SOIC127P600X175-8N (KD-EX1812-SO8)']);
    expect(sch.symbols.map((s) => linkedFootprints(s.bags)[0])).toEqual(['SOIC127P600X175-8N', 'SOIC127P600X175-8N', 'SOIC127P600X175-8N (KD-EX1812-SO8)']);
    // An empty shelf: two empty libraries, still libraries
    const none = shelfLibraries([]);
    expect([none.symbols, none.footprints, readSchLib(none.schlib, SHELF_SCH).symbols.length]).toEqual([0, 0, 0]);
  });
});

describe('the parts library in the release stages (26.197)', () => {
  it('stage 21, planned until its release: the panel and its commands with it', () => {
    expect(FEATURES.partsLibrary).toEqual({ stage: 21, name: 'Parts library' });
    // (planned while the release's stage is below its own)
    expect(FEATURES.partsLibrary.stage > STAGE || featureOn('partsLibrary')).toBe(true);
    for (const c of ['parts.panel', 'parts.example']) expect(FEATURE_COMMANDS[c], c).toBe('partsLibrary');
    const p = PANELS.find((x) => x.id === 'parts')!;
    expect([p.title('sch'), p.category('sch'), p.category('pcb'), p.category('schlib')]).toEqual(['Parts', 'System', 'System', 'System']);
    const keys = PANELS.filter((x) => x.category('sch') === 'System').map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
