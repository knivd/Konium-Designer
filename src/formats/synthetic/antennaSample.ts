/**
 * A board with an antenna on it, to try Tools › Antenna Analysis on: an inverted F for 2.45 GHz at
 * the end of a two-layer board of 30 × 50 mm. Konium's own, drawn here: ground copper on both
 * layers up to 8 mm short of the end, stitched along its edge; in the clear end, on the top layer,
 * the antenna's arm along the edge with a stub down to the ground at one end and a stub to the feed
 * pad a little along from it. The antenna's copper has no net (it joins the feed to ground, as an
 * inverted F does); the feed pad is on RF.
 */
import { mm } from '../../core/units';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { addNet, addPads, addPrimRecords, addTracks, addVias } from '../../model/pcbEdit';
import { readStack, setStack } from '../../model/pcbStack';
import { newPcbDocBytes } from '../altium/newBoard';
import { encodeRegion, readPcbDoc, writePcbDoc } from '../altium/pcbdoc';

export const ANTENNA_SAMPLE = {
  name: 'Antenna Example.PcbDoc',
  /** Millimetres, from the board's lower left corner. */
  width: 30, height: 50, ground: 42,
  /** The shorting stub's x, the feed's, where the arm ends, and the arm's height; the copper's width. */
  short: 4, feed: 7.5, end: 23.8, arm: 48, track: 1,
  f0: 2.45e9,
};

export function antennaSampleDoc(o: Partial<typeof ANTENNA_SAMPLE> = {}): PcbDocument {
  const g = { ...ANTENNA_SAMPLE, ...o }, O = 25;
  const P = (x: number, y: number) => ({ x: mm(O + x), y: mm(O + y) });
  const doc = readPcbDoc(newPcbDocBytes(g.name, new Date(Date.UTC(2026, 0, 1)), [P(0, 0), P(g.width, 0), P(g.width, g.height), P(0, g.height)].map((p) => ({ p }))), g.name);
  // 1.6 mm of FR-4 between the two layers
  setStack(doc, readStack(doc.board.bag!, doc.board.copperStack).map((r) => (r.kind === 'dielectric' ? { ...r, height: mm(1.53), dielConst: 4.4 } : r))).apply();
  addNet(doc, 'GND').apply(); addNet(doc, 'RF').apply();
  const gnd = doc.nets.findIndex((n) => n.name === 'GND'), rf = doc.nets.findIndex((n) => n.name === 'RF');
  const plane = [P(0, 0), P(g.width, 0), P(g.width, g.ground), P(0, g.ground)];
  addPrimRecords(doc, [L.TOP, L.BOTTOM].map((layer) => ({ storage: 'Regions6', rec: encodeRegion({ layer, outline: plane, net: gnd }) }))).apply();
  // The ground's two layers joined along the edge the antenna stands on, and down the board's sides
  const vias: { x: number; y: number }[] = [];
  for (let x = 1.5; x <= g.width - 1.5; x += 3) if (Math.abs(x - g.feed) > 1.2) vias.push({ x, y: g.ground - 1 });
  for (let y = g.ground - 5; y > 2; y -= 6) vias.push({ x: 1.5, y }, { x: g.width - 1.5, y });
  addVias(doc, vias.map((v) => ({ at: P(v.x, v.y), diameter: mm(0.6), hole: mm(0.3), net: gnd, layerStart: L.TOP, layerEnd: L.BOTTOM }))).apply();
  // The inverted F: the stub to ground, the arm, the stub to the feed
  const w = mm(g.track);
  addTracks(doc, [
    { layer: L.TOP, a: P(g.short, g.ground - 0.5), b: P(g.short, g.arm), width: w },
    { layer: L.TOP, a: P(g.short, g.arm), b: P(g.end, g.arm), width: w },
    { layer: L.TOP, a: P(g.feed, g.ground + 1), b: P(g.feed, g.arm), width: w },
  ]).apply();
  addPads(doc, [{ name: 'FEED', layer: L.TOP, at: P(g.feed, g.ground + 1), w, h: w, shape: 'rect', net: rf }]).apply();
  return doc;
}

export const antennaSampleBytes = (): Uint8Array => writePcbDoc(antennaSampleDoc());
