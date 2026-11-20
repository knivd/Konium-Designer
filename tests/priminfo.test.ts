import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { cfbPut, cfbStream, readCfb, writeCfb } from '../src/formats/cfb/cfb';
import { countHeader, joinTextRecords, splitTextRecords } from '../src/formats/altium/framing';
import { PropertyBag } from '../src/formats/altium/props';
import { masksOf, setMasks, carryPrimInfo } from '../src/formats/altium/primInfo';
import { removePrims, removeComponents, replaceRecords } from '../src/model/pcbEdit';
import { UndoStack } from '../src/core/undo';
import { VIA, get, put, setViaDiameter } from '../src/formats/altium/pcbLayouts';
import { bytesEqual } from '../src/formats/bin';

/** The demo board with AD's side streams: tracks 1 and 3 with mask expansions, every pad with a unique ID. */
function boardWithSideStreams() {
  const cfb = readCfb(demoPcbDoc());
  const doc0 = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const pads = doc0.streams.get('Pads6')!.records.length;
  const ext = [1, 3].map((i) => PropertyBag.fromEntries([['PRIMITIVEINDEX', String(i)], ['PRIMITIVEOBJECTID', 'Track'], ['TYPE', 'Mask'],
    ['SOLDERMASKEXPANSIONMODE', 'Manual'], ['SOLDERMASKEXPANSION_MANUAL', `${i}mil`], ['PASTEMASKEXPANSIONMODE', 'None']]));
  const uid = Array.from({ length: pads }, (_, i) => PropertyBag.fromEntries([['PRIMITIVEINDEX', String(i)], ['PRIMITIVEOBJECTID', 'Pad'], ['UNIQUEID', `PAD${String(i).padStart(5, 'X')}`]]));
  cfbPut(cfb.root, 'ExtendedPrimitiveInformation/Data', joinTextRecords(ext));
  cfbPut(cfb.root, 'ExtendedPrimitiveInformation/Header', countHeader(ext.length));
  cfbPut(cfb.root, 'UniqueIDPrimitiveInformation/Data', joinTextRecords(uid));
  cfbPut(cfb.root, 'UniqueIDPrimitiveInformation/Header', countHeader(uid.length));
  const bytes = writeCfb(cfb);
  return { bytes, doc: readPcbDoc(bytes, 'Demo.PcbDoc') };
}
const side = (bytes: Uint8Array, s: string) => splitTextRecords(cfbStream(readCfb(bytes).root, `${s}/Data`)!).map((b) => `${b.get('PRIMITIVEOBJECTID')}#${b.get('PRIMITIVEINDEX')} ${b.get('SOLDERMASKEXPANSION_MANUAL') ?? b.get('UNIQUEID')}`);

describe('mask expansions and pad unique IDs follow their primitives', () => {
  it('are read onto the primitives, and an untouched board keeps the streams byte for byte', () => {
    const { bytes, doc } = boardWithSideStreams();
    const tracks = doc.streams.get('Tracks6')!.records;
    expect(masksOf(tracks[3]!)).toEqual({ solder: { mode: 'Manual', value: '3mil' }, paste: { mode: 'None', value: '0mil' } });
    expect(masksOf(tracks[0]!).solder.mode).toBe('None');
    const out = readCfb(writePcbDoc(doc)).root, src = readCfb(bytes).root;
    for (const s of ['ExtendedPrimitiveInformation/Data', 'UniqueIDPrimitiveInformation/Data']) expect(bytesEqual(cfbStream(out, s)!, cfbStream(src, s)!)).toBe(true);
  });

  it('deleting a track renumbers the entries after it, and drops its own', () => {
    const { doc } = boardWithSideStreams();
    const t1 = doc.prims.find((p) => p.kind === 'track' && p.src.index === 1)!;
    new UndoStack().transact('delete', (tx) => tx.add(removePrims(doc, [t1])));
    expect(side(writePcbDoc(doc), 'ExtendedPrimitiveInformation')).toEqual(['Track#2 3mil']);
  });

  it('deleting a component keeps every other pad its own unique ID', () => {
    const { doc } = boardWithSideStreams();
    const before = side(writePcbDoc(doc), 'UniqueIDPrimitiveInformation');
    const pads = doc.streams.get('Pads6')!.records;
    const j1 = doc.components.findIndex((c) => c.designator === 'J1');
    const gone = new Set(doc.prims.filter((p) => p.kind === 'pad' && p.component === j1).map((p) => p.src.index));
    const kept = before.filter((_, i) => !gone.has(i)).map((s) => s.split(' ')[1]);
    expect(pads.length).toBeGreaterThan(gone.size);
    new UndoStack().transact('delete', (tx) => tx.add(removeComponents(doc, [j1])));
    const after = side(writePcbDoc(doc), 'UniqueIDPrimitiveInformation');
    expect(after.map((s) => s.split(' ')[1])).toEqual(kept);
    expect(after.map((s) => s.split(' ')[0])).toEqual(kept.map((_, i) => `Pad#${i}`));
  });

  it('a track edited in place keeps its expansion; a new one written by a dialog goes with it, and undo takes it back', () => {
    const { doc } = boardWithSideStreams();
    const recs = doc.streams.get('Tracks6')!.records;
    const before = recs[3]!;
    const after = { tag: before.tag, subs: before.subs.map((s) => s.slice()) };
    carryPrimInfo(before, after);
    setMasks(after, 'Tracks6', { solder: { mode: 'Rule', value: '0mil' }, paste: { mode: 'Manual', value: '-2mil' } });
    const u = new UndoStack();
    u.transact('edit', (tx) => tx.add(replaceRecords(doc, [{ storage: 'Tracks6', index: 3, after }])));
    const e = splitTextRecords(cfbStream(readCfb(writePcbDoc(doc)).root, 'ExtendedPrimitiveInformation/Data')!);
    expect(e.map((b) => `${b.get('PRIMITIVEINDEX')} ${b.get('SOLDERMASKEXPANSIONMODE')} ${b.get('PASTEMASKEXPANSIONMODE')} ${b.get('PASTEMASKEXPANSION_MANUAL')}`)).toEqual(['1 Manual None undefined', '3 Rule Manual -2mil']);
    u.undo();
    expect(masksOf(doc.streams.get('Tracks6')!.records[3]!).solder).toEqual({ mode: 'Manual', value: '3mil' });
  });
});

describe('vias', () => {
  it("AD17's per-layer diameters start after the diameter mode (byte 74)", () => {
    const s = new Uint8Array(321);
    put(s, VIA.diameter, 236220);
    for (let i = 0; i < 32; i++) put(s, { off: 75 + 4 * i, t: 'i32' }, 236220);
    s[74] = 0;
    setViaDiameter(s, 300000);
    expect(s[74]).toBe(0);
    expect(get(s, VIA.diameter)).toBe(300000);
    expect(get(s, { off: 75, t: 'i32' })).toBe(300000);
    expect(get(s, { off: 75 + 31 * 4, t: 'i32' })).toBe(300000);
    expect(get(s, { off: 75 + 32 * 4, t: 'i32' })).toBe(0);
  });
});
