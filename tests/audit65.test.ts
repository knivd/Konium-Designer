/**
 * 26.065's round-trip audit: what re-encoding a primitive over its own record keeps, and what a
 * new one leaves behind of the file's first record (its template).
 */
import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc, encodeTrack } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addTracks, explodeComponents } from '../src/model/pcbEdit';
import { TEXT, TRACK, get, put } from '../src/formats/altium/pcbLayouts';
import { L } from '../src/model/layers';
import { NO_NET, type PcbTrack } from '../src/model/pcb';
import { mil } from '../src/core/units';

const load = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

describe('round trips: re-encoding over a record', () => {
  it('a keepout track re-encoded from its fields (a new width, a union scaled) stays a keepout', () => {
    const doc = load();
    const rec = doc.streams.get('Tracks6')!.records[0]!;
    put(rec.subs[0]!, TRACK.flags2, 2);
    doc.dirty.add('Tracks6');
    const back = readPcbDoc(writePcbDoc(doc), 'x');
    const t = back.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === 0)!;
    expect(t.keepout).toBe(true);
    const again = encodeTrack({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net, component: t.component, polygon: t.polygon, keepout: t.keepout }, back.streams.get('Tracks6')!.records[0]!);
    expect([...again.subs[0]!]).toEqual([...back.streams.get('Tracks6')!.records[0]!.subs[0]!]);
  });

  it('a routed track takes nothing of a locked keepout pour track that happens to be the file\'s first', () => {
    const doc = load();
    const s = doc.streams.get('Tracks6')!.records[0]!.subs[0]!;
    put(s, TRACK.flags1, 0);   // locked
    put(s, TRACK.flags2, 2);   // keepout
    put(s, TRACK.polygon, 0);  // in pour 0
    const n = doc.streams.get('Tracks6')!.records.length;
    addTracks(doc, [{ layer: L.TOP, a: { x: 0, y: 0 }, b: { x: mil(100), y: 0 }, width: mil(10) }]).apply();
    const t = doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === n)!;
    expect([t.locked, t.keepout, t.polygon]).toEqual([false, false, NO_NET]);
    addTracks(doc, [{ layer: L.TOP, a: { x: 0, y: mil(50) }, b: { x: mil(100), y: mil(50) }, width: mil(10) }], true).apply();
    expect(doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === n + 1)!.keepout).toBe(true);
  });

  it('Explode Component: the designator string keeps its stroke font', () => {
    const doc = load();
    const des = doc.prims.find((p) => p.kind === 'text' && p.isDesignator && p.component === 0 && !p.hidden)!;
    const rec = doc.streams.get(des.src.storage)!.records[des.src.index]!;
    put(rec.subs[0]!, TEXT.font, 2);
    explodeComponents(doc, [0]).apply();
    const recs = doc.streams.get('Texts6')!.records;
    const freed = recs.filter((r) => get(r.subs[0]!, TEXT.component) === 0xffff && get(r.subs[0]!, TEXT.font) === 2);
    expect(freed.length).toBeGreaterThan(0);
  });
});
