import { describe, expect, it } from 'vitest';
import { demoPcbLib } from '../src/formats/synthetic/demo';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { cfbPut, cfbStream, readCfb, writeCfb } from '../src/formats/cfb/cfb';
import { bytesEqual } from '../src/formats/bin';
import { footprintDoc, newPcbLib, openPcbLib, writePcbLibDoc } from '../src/model/pcbLib';
import { addTracks } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';

describe('PCB library editing', () => {
  it('rewrites only what changed; other storages survive', () => {
    const cfb = readCfb(demoPcbLib());
    cfbPut(cfb.root, 'Models/Data', new Uint8Array([1, 2, 3, 4]));   // e.g. embedded 3D models
    const src = writeCfb(cfb);
    const d = openPcbLib(src, 'Demo.PcbLib');
    const hdr = cfbStream(readCfb(src).root, 'HDR1X2/Data')!;
    // edit 0805, rename SOT-223, delete LED0805, add a new footprint
    const f0805 = d.footprints.find((f) => f.name === '0805')!;
    addTracks(f0805.doc, [{ layer: L.TOP_OVERLAY, a: { x: 0, y: mm(1) }, b: { x: mm(1), y: mm(1) }, width: mm(0.2) }]).apply();
    d.footprints.find((f) => f.name === 'SOT-223')!.name = 'SOT223';
    const led = d.footprints.findIndex((f) => f.name === 'LED0805');
    d.removed.push(d.footprints[led]!.storage!);
    d.footprints.splice(led, 1);
    d.footprints.push({ name: 'TEST_1', description: 'Test', height: '10mil', doc: footprintDoc('TEST_1', []) });
    const out = writePcbLibDoc(d);
    const again = readPcbLib(out, 'Demo.PcbLib');
    expect(again.footprints.map((f) => f.name)).toEqual(['HDR1X2', '0805', 'SOT223', 'TEST_1']);
    expect(again.footprints.find((f) => f.name === '0805')!.prims.filter((p) => p.kind === 'track').length).toBe(5);
    expect(again.footprints.find((f) => f.name === 'SOT223')!.prims.filter((p) => p.kind === 'pad').length).toBe(4);
    expect(again.footprints.find((f) => f.name === 'TEST_1')!.description).toBe('Test');
    const root = readCfb(out).root;
    expect(bytesEqual(cfbStream(root, 'HDR1X2/Data')!, hdr)).toBe(true);
    expect([...cfbStream(root, 'Models/Data')!]).toEqual([1, 2, 3, 4]);
    expect(cfbStream(root, 'LED0805/Data')).toBeUndefined();
  });
  it('an untouched library saves byte-identically', () => {
    const src = demoPcbLib();
    expect(bytesEqual(writePcbLibDoc(openPcbLib(src, 'Demo.PcbLib')), src)).toBe(true);
  });
  it('a new library starts with PCBCOMPONENT_1', () => {
    expect(newPcbLib('PcbLib1.PcbLib').footprints.map((f) => f.name)).toEqual(['PCBCOMPONENT_1']);
  });
});
