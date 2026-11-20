import { describe, expect, it } from 'vitest';
import { encodeTrack, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { moveComponent } from '../src/model/pcbEdit';
import { mechKinds, mechPairs, setMechLayout } from '../src/model/pcbBoard';
import { UndoStack } from '../src/core/undo';
import { mil } from '../src/core/units';
import { L, mechLayer } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';

/**
 * Mechanical layer types and component layer pairs (Board6 MECHKIND, MECHPAIRiL1 / L2, as the
 * desktop software keeps them): set in View Configurations, saved with the board; a part flipped
 * to the other side moves its objects on one layer of a pair to the other (and back).
 */

const M13 = mechLayer(13), M15 = mechLayer(15), M20 = mechLayer(20), M21 = mechLayer(21);
function demo(): PcbDocument { return readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'); }
/** A track of component c on a layer, added to the board. */
function addTrack(doc: PcbDocument, c: number, layer: number) {
  const comp = doc.components[c]!;
  const rec = encodeTrack({ layer, a: comp.at, b: { x: comp.at.x + mil(50), y: comp.at.y }, width: mil(5), component: c });
  doc.streams.get('Tracks6')!.records.push(rec);
  doc.dirty.add('Tracks6');
  return readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
}

describe('Component layer pairs and mechanical layer types', () => {
  it('saved in the board as the desktop software keeps them, and read back', () => {
    const doc = demo();
    const u = new UndoStack();
    u.transact('pairs', (tx) => tx.add(setMechLayout(doc, new Map([[M13, '3DBodyTop'], [M15, '3DBodyBottom'], [M20, 'CourtyardTop'], [M21, 'CourtyardBottom']]), [[M13, M15], [M20, M21]])));
    expect(doc.board.bag!.get('MECHPAIR0L1')).toBe('MECHANICAL13');
    expect(doc.board.bag!.get('MECHPAIR1L2')).toBe('MECHANICAL21');
    const back = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(mechPairs(back)).toEqual([[M13, M15], [M20, M21]]);
    const k = mechKinds(back);
    expect([k.get(M13), k.get(M15)]).toEqual(['3DBodyTop', '3DBodyBottom']);
    // Undone: none again
    u.undo();
    expect(mechPairs(doc)).toEqual([]);
  });

  it('a part flipped: its track on Mechanical 13 goes to 15 and back, one on 20 to 21 (past 16: its V7 id); unpaired ones stay', () => {
    let doc = demo();
    const u = new UndoStack();
    u.transact('pairs', (tx) => tx.add(setMechLayout(doc, new Map(), [[M13, M15], [M20, M21]])));
    doc = addTrack(doc, 0, M13);
    doc = addTrack(doc, 0, M20);
    doc = addTrack(doc, 0, mechLayer(4));
    const layersOf = (d: PcbDocument) => d.prims.filter((p) => p.kind === 'track' && p.component === 0 && p.width === mil(5)).map((p) => (p as { layer: number }).layer).sort((a, b) => a - b);
    expect(layersOf(doc)).toEqual([mechLayer(4), M13, M20].sort((a, b) => a - b));
    const flip = moveComponent(doc, 0, { x: 0, y: 0 }, 0, { flip: true });
    flip.apply();
    const after = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(layersOf(after)).toEqual([mechLayer(4), M15, M21].sort((a, b) => a - b));
    expect(after.components[0]!.layer).toBe(doc.components[0]!.layer);
    flip.revert();
    expect(layersOf(doc)).toEqual([mechLayer(4), M13, M20].sort((a, b) => a - b));
    // Without pairs the mechanical layers stay where they are
    const plain = demo();
    const d2 = addTrack(plain, 0, M13);
    moveComponent(d2, 0, { x: 0, y: 0 }, 0, { flip: true }).apply();
    expect(layersOf(d2)).toEqual([M13]);
    expect(L.MECH16).toBe(72);
  });
});
