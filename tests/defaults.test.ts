import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeVia, encodePad } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { readRegionParts, writeRegionParts } from '../src/formats/altium/regionRecord';
import { bytesEqual } from '../src/formats/bin';
import { placedRecord } from '../src/model/pcbEdit';
import { resetDefaults, setSavedDefault, setTabDefault, primDefault } from '../src/model/pcbDefaults';
import { FLAG, PAD, VIA, get, put } from '../src/formats/altium/pcbLayouts';
import { masksOf, setMasks } from '../src/formats/altium/primInfo';

describe('region records', () => {
  it('come apart and go back together byte for byte (Regions6 and ShapeBasedRegions6)', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    let n = 0;
    for (const st of ['Regions6', 'ShapeBasedRegions6']) {
      for (const r of doc.streams.get(st)?.records ?? []) {
        const s = r.subs[0]!;
        expect(bytesEqual(writeRegionParts(readRegionParts(st, s)), s)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1);
  });
  it('a vertex moved and the kind changed are written back', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const s = doc.streams.get('Regions6')!.records[0]!.subs[0]!;
    const p = readRegionParts('Regions6', s);
    p.verts[0]!.x += 10_000;
    p.props.set('KIND', '1');
    const q = readRegionParts('Regions6', writeRegionParts(p));
    expect(q.verts[0]!.x).toBe(p.verts[0]!.x);
    expect(q.props.get('KIND')).toBe('1');
    expect(q.verts.length).toBe(p.verts.length);
  });
});

describe('primitive defaults', () => {
  it('a via placed after Tab keeps the default\'s tenting and per-layer stack, and its mask expansions go with it', () => {
    resetDefaults();
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const def = encodeVia({ at: { x: 0, y: 0 }, diameter: 300_000, hole: 150_000 });
    const s = def.subs[0]!;
    put(s, VIA.flags1, (get(s, VIA.flags1) ?? 0) | FLAG.tentTop);
    setTabDefault('Vias6', def, false);
    const rec = placedRecord(doc, 'Vias6', (t) => encodeVia({ at: { x: 5, y: 6 }, diameter: 300_000, hole: 150_000 }, t));
    expect((get(rec.subs[0]!, VIA.flags1)! & FLAG.tentTop) !== 0).toBe(true);
    expect(get(rec.subs[0]!, VIA.x)).toBe(5);
    resetDefaults();
    expect(primDefault('Vias6')).toBeUndefined();
  });
  it('a pad default of the same size keeps its stack and mask settings; a new size starts plain', () => {
    resetDefaults();
    const def = encodePad({ name: '1', layer: 74, at: { x: 0, y: 0 }, w: 600_000, h: 600_000, shape: 'rect', hole: 300_000 });
    put(def.subs[4]!, PAD.solderMode, 2); put(def.subs[4]!, PAD.solderManual, 40_000);
    setMasks(def, 'Pads6', { solder: { mode: 'Manual', value: '4mil' }, paste: { mode: 'None', value: '0mil' } });
    setSavedDefault('Pads6', def);
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const same = placedRecord(doc, 'Pads6', (t) => encodePad({ name: '7', layer: 74, at: { x: 1, y: 1 }, w: 600_000, h: 600_000, shape: 'rect', hole: 300_000 }, t));
    expect(get(same.subs[4]!, PAD.solderMode)).toBe(2);
    expect(get(same.subs[4]!, PAD.solderManual)).toBe(40_000);
    expect(masksOf(same).solder.mode).toBe('Manual');
    resetDefaults();
  });
});
