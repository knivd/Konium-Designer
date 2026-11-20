/**
 * Boards in the binary format before the present one (26.188). A .PcbDoc whose FileHeader says
 * "PCB 5.0 Binary File" keeps what the present format keeps, in storages named without their 6
 * (Board, Nets, Components, Tracks, Pads…), and its primitives' records are the first bytes of
 * the present ones: a track's 36 of 46, an arc's 48 of 56, a fill's 38 of 46, a text's 43 of 123,
 * a pad's 106 of 120, a via's 70 of 74. It is read here as the present format: each storage
 * under its present name, each record made up to the present length with what a new record of
 * its kind has there (and its layer's 32-bit id beside the byte). The board is in the present
 * format from then on, and is saved in it.
 *
 * Its violation markers are not brought over (a design rule check makes them again).
 *
 * [est] Set against one board published in this format beside the same board in an older text
 * format (formats/protel/pcbAscii): every track, pad, arc, via and fill read this way is the text
 * one's, with its layer, size, net and component. Regions and dimensions in this format have not
 * been seen: what the reader cannot take is said and left out.
 */
import { BinWriter } from '../bin';
import { binToBytes, bytesToBin } from '../text';
import { cfbFind, cfbPut, cfbStream, cloneCfb, type CfbEntry, type CfbFile } from '../cfb/cfb';
import { L, type LayerId } from '../../model/layers';
import { PCB_TAG, countHeader, joinBinaryRecords, splitBinaryRecords, type PcbRawRecord } from './framing';
import { encodeArc, encodeFill, encodePad, encodeText, encodeTrack, encodeVia, putLayer } from './pcbdoc';

/** A board in that format, by its storages and its header. */
export function isPcb5(root: CfbEntry): boolean {
  if (cfbFind(root, 'Board6') || !cfbFind(root, 'Board')) return false;
  const fh = cfbStream(root, 'FileHeader');
  return !!fh && /PCB 5\.0 Binary File/.test(bytesToBin(fh.subarray(0, 64)));
}

/** The primitive storages, each with its records' tag and the subrecord that is made up (a pad's fifth). */
const PRIMS: [storage: string, tag: number, sub: number][] = [
  ['Tracks', PCB_TAG.TRACK, 0], ['Arcs', PCB_TAG.ARC, 0], ['Vias', PCB_TAG.VIA, 0], ['Fills', PCB_TAG.FILL, 0], ['Texts', PCB_TAG.TEXT, 0], ['Pads', PCB_TAG.PAD, 4],
];
/** Markers of a check made in the older program: made again by a check here. */
const DROPPED = new Set(['Violations']);

/** A new record of each kind, for the bytes the older records end before. */
function templates(): Map<number, Uint8Array> {
  const o = { x: 0, y: 0 };
  return new Map<number, Uint8Array>([
    [PCB_TAG.TRACK, encodeTrack({ layer: L.TOP, a: o, b: o, width: 1 }).subs[0]!],
    [PCB_TAG.ARC, encodeArc({ layer: L.TOP, c: o, r: 1, start: 0, end: 360, width: 1 }).subs[0]!],
    [PCB_TAG.VIA, encodeVia({ at: o, diameter: 2, hole: 1 }).subs[0]!],
    [PCB_TAG.FILL, encodeFill({ layer: L.TOP, a: o, b: o }).subs[0]!],
    [PCB_TAG.TEXT, encodeText({ layer: L.TOP, at: o, height: 1, text: '' }).subs[0]!],
    [PCB_TAG.PAD, encodePad({ name: '', layer: L.TOP, at: o, w: 1, h: 1, shape: 'round' }).subs[4]!],
  ]);
}

/** The same board as a file of the present format (its storages renamed, its records made up to length). */
export function pcb5To6(cfb: CfbFile): CfbFile {
  const root = cloneCfb(cfb.root), tails = templates();
  root.children = root.children.filter((c) => !(c.kind === 'storage' && DROPPED.has(c.name)));
  for (const [storage, tag, sub] of PRIMS) {
    const data = cfbStream(root, `${storage}/Data`);
    if (!data) continue;
    let records: PcbRawRecord[];
    try { records = splitBinaryRecords(data); } catch { continue; }
    const full = tails.get(tag)!;
    const out = records.map((r): PcbRawRecord => {
      const s = r.subs[sub];
      if (r.tag !== tag || !s || s.length >= full.length) return r;
      const made = new Uint8Array(full.length);
      made.set(full); made.set(s);
      putLayer(tag, made, s[0]! as LayerId);
      return { ...r, subs: r.subs.map((x, i) => (i === sub ? made : x)) };
    });
    cfbPut(root, `${storage}/Data`, joinBinaryRecords(out));
    cfbPut(root, `${storage}/Header`, countHeader(out.length));
  }
  for (const c of root.children) if (c.kind === 'storage' && !/6$/.test(c.name)) c.name = `${c.name}6`;
  // The headers of a file of the present format (formats/altium/assemble)
  const fh = new BinWriter(32).u32(19);
  for (const ch of 'PCB 5.0 Bi') fh.u8(ch.charCodeAt(0)).u8(0);
  cfbPut(root, 'FileHeader', fh.finish());
  const six = binToBytes('PCB 6.0 Binary File');
  cfbPut(root, 'FileHeaderSix', new BinWriter(32).u32(six.length).u8(six.length).bytes(six).f64(5.01).finish());
  return { ...cfb, root };
}
