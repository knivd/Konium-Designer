/**
 * Boards of the older Protel programs (26.188), read as a board of this program's.
 *
 * `PCB FILE 6` is the text format Protel for Windows wrote and its successors (Advanced PCB 2 and
 * 3, Protel 98, 99 and 99 SE) could still save as "Protel PCB 2.8 ASCII": two header lines, then
 * records until ENDPCB, each a tag on a line of its own followed by its operand lines.
 *
 *   PCB FILE 6 VERSION 2.80
 *   2 9 3 2 2 1 4 1 4 3                       counts
 *   COMP                                       a component: its pattern's name, then a line of numbers
 *   RES0805
 *   0 0 1500000 1200000 1 0 0 0 0 0 0 90.000 1 1 1
 *   CS … CP … CT … CA … CF …                   its strings, pads, tracks, arcs and fills
 *   ENDCOMP
 *   FT … FV … FP … FS … FA … FF …              free tracks, vias, pads, strings, arcs and fills
 *   NETDEF                                     a net: its name; objects name their net by its place in this list, from 1
 *   ENDPCB
 *
 * Lengths are thousandths of a mil in versions 2.70 and 2.80 and whole mils in version 1. A
 * track, arc or fill has a second line of numbers in 2.70 and 2.80 (a fill's turn is the third
 * of them). A pad has its size and shape for the top, the middle and the bottom in 2.70 and
 * 2.80, and one size in version 1. Of a component's strings the first is its designator and the
 * second its comment; its line of numbers says whether each is shown (the fifth and sixth) and
 * the side it is on (the last: 1 the top, 16 the bottom). Layers are numbered as those programs
 * numbered them: 1 the top, 2 to 15 the mid layers, 16 the bottom, 17 and 18 the overlays, 19 and
 * 20 the paste masks, 21 and 22 the solder masks, 23 to 26 the planes, 27 the drill guide, 28 the
 * keep-out layer, 29 to 32 the mechanical layers, 33 the drill drawing, 34 every layer.
 *
 * [est] The grammar is from public descriptions of the format and from boards published in
 * version 2.80, two of them published beside the same board in a later binary format, against
 * which the reading here was set object by object: every track, pad, arc, via and fill with its
 * layer, size, net and component, and the components' places, turns and sides. Version 1 is read
 * by the descriptions alone (no board in it has been seen). Fields not named above are not read:
 * among them an arc's and a fill's net, which no board seen says (theirs are all drawing), so
 * copper arcs and fills take the net of what they touch (convert).
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';

export interface ProtelText { at: Vec2; height: number; rotation: number; mirrored: boolean; layer: LayerId; stroke: number; text: string }
export interface ProtelPad { at: Vec2; name: string; layer: LayerId; hole: number; rotation: number; net: number; top: PadFace; mid: PadFace; bot: PadFace }
export interface PadFace { w: number; h: number; shape: 'round' | 'rect' | 'octagon' }
export interface ProtelTrack { a: Vec2; b: Vec2; width: number; layer: LayerId; net: number }
export interface ProtelArc { c: Vec2; r: number; start: number; end: number; width: number; layer: LayerId; net: number }
export interface ProtelFill { a: Vec2; b: Vec2; rotation: number; layer: LayerId; net: number }
export interface ProtelVia { at: Vec2; diameter: number; hole: number; net: number }
export interface ProtelPrims { tracks: ProtelTrack[]; pads: ProtelPad[]; arcs: ProtelArc[]; fills: ProtelFill[]; texts: ProtelText[] }
export interface ProtelComp extends ProtelPrims { pattern: string; at: Vec2; rotation: number; designator: ProtelText | null; comment: ProtelText | null; bottom: boolean; nameOn: boolean; commentOn: boolean }
export interface ProtelBoard extends ProtelPrims {
  /** The header's version ('2.80'). */
  version: string;
  comps: ProtelComp[];
  vias: ProtelVia[];
  /** The nets by name: an object's net is its place here, from 1 (0: none). */
  nets: string[];
  /** Records that could not be read, each by its line and tag. */
  lost: string[];
}

/** A file of this format by its first line. */
export const isProtelAscii = (head: string): boolean => /^\s*PCB FILE 6 VERSION \d/.test(head);

/** The layer of this program for one of those programs' numbers (null: none known). */
export function protelLayer(n: number): LayerId | null {
  if (n === 1) return L.TOP;
  if (n >= 2 && n <= 15) return (L.MID1 + n - 2) as LayerId;
  if (n === 16) return L.BOTTOM;
  if (n >= 17 && n <= 22) return ([L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER] as LayerId[])[n - 17]!;
  if (n >= 23 && n <= 26) return (L.PLANE1 + n - 23) as LayerId;
  if (n === 27) return L.DRILL_GUIDE;
  if (n === 28) return L.KEEPOUT;
  if (n >= 29 && n <= 32) return mechLayer(n - 28);
  if (n === 33) return L.DRILL_DRAWING;
  if (n === 34) return L.MULTI;
  return null;
}

const TAGS = new Set(['COMP', 'ENDCOMP', 'CT', 'FT', 'CP', 'FP', 'CS', 'FS', 'CF', 'FF', 'CA', 'FA', 'CV', 'FV', 'NETDEF', 'ENDPCB']);
const SHAPES: PadFace['shape'][] = ['round', 'round', 'rect', 'octagon'];

export function parseProtelAscii(text: string): ProtelBoard {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const version = /VERSION\s+([\d.]+)/.exec(lines[0] ?? '')?.[1] ?? '';
  // Thousandths of a mil in 2.70 and 2.80; whole mils in version 1
  const unit = Number(version) >= 2 ? mil(1) / 1000 : mil(1);
  const len = (s: string | undefined): number => Math.round(Number(s) * unit);
  const board: ProtelBoard = { version, comps: [], vias: [], nets: [], lost: [], tracks: [], pads: [], arcs: [], fills: [], texts: [] };
  let i = 2, comp: ProtelComp | null = null, strings = 0;
  const next = (): string => lines[i++] ?? '';
  const nums = (): string[] => next().trim().split(/\s+/);
  /** The second line of numbers a track, arc or fill has in 2.70 and 2.80: taken where the next line is not a record's tag. */
  const second = (): string[] => (i < lines.length && !TAGS.has((lines[i] ?? '').trim()) ? nums() : []);
  const layer = (s: string | undefined): LayerId | null => protelLayer(Number(s));
  while (i < lines.length) {
    const at = i, tag = next().trim();
    if (!tag) continue;
    if (tag === 'ENDPCB') break;
    const into: ProtelPrims = tag[0] === 'C' && comp ? comp : board;
    try {
      if (tag === 'COMP') {
        const pattern = next().trim(), f = nums();
        comp = { pattern, at: { x: len(f[2]), y: len(f[3]) }, rotation: Number(f[11] ?? 0) || 0, designator: null, comment: null, bottom: Number(f[14]) === 16, nameOn: f[4] !== '0', commentOn: f[5] === '1', tracks: [], pads: [], arcs: [], fills: [], texts: [] };
        board.comps.push(comp); strings = 0;
      } else if (tag === 'ENDCOMP') {
        comp = null;
      } else if (tag === 'CT' || tag === 'FT') {
        const f = nums(); second();
        const l = layer(f[7]);
        if (l === null || f.length < 8) throw new Error('layer');
        into.tracks.push({ a: { x: len(f[2]), y: len(f[3]) }, b: { x: len(f[4]), y: len(f[5]) }, width: len(f[6]), layer: l, net: Number(f[9] ?? 0) || 0 });
      } else if (tag === 'CP' || tag === 'FP') {
        const f = nums(), name = next().trim();
        const face = (k: number): PadFace => ({ w: len(f[k]), h: len(f[k + 1]), shape: SHAPES[Number(f[k + 2])] ?? 'round' });
        if (f.length >= 19) {
          const l = layer(f[15]);
          if (l === null) throw new Error('layer');
          into.pads.push({ at: { x: len(f[2]), y: len(f[3]) }, name, layer: l, hole: len(f[13]), rotation: Number(f[18]) || 0, net: Number(f[16]) || 0, top: face(4), mid: face(7), bot: face(10) });
        } else {
          // Before 2.70: one size for the whole pad
          const l = layer(f[9]);
          if (l === null || f.length < 10) throw new Error('layer');
          const one = face(4);
          into.pads.push({ at: { x: len(f[2]), y: len(f[3]) }, name, layer: l, hole: len(f[7]), rotation: 0, net: 0, top: one, mid: one, bot: one });
        }
      } else if (tag === 'CS' || tag === 'FS') {
        const f = nums(), body = next().replace(/\r$/, '');
        const l = layer(f[8]);
        if (l === null) throw new Error('layer');
        const t: ProtelText = { at: { x: len(f[2]), y: len(f[3]) }, height: len(f[4]), rotation: Number(f[5]) || 0, mirrored: Number(f[6]) === 1, layer: l, stroke: len(f[13]), text: body };
        if (tag === 'CS' && comp && strings < 2) { if (strings++ === 0) comp.designator = t; else comp.comment = t; }
        else into.texts.push(t);
      } else if (tag === 'CF' || tag === 'FF') {
        const f = nums(), g = second();
        const l = layer(f[6]);
        if (l === null) throw new Error('layer');
        into.fills.push({ a: { x: len(f[2]), y: len(f[3]) }, b: { x: len(f[4]), y: len(f[5]) }, rotation: Number(g[2] ?? 0) || 0, layer: l, net: 0 });
      } else if (tag === 'CA' || tag === 'FA') {
        const f = nums(); second();
        const l = layer(f[8]);
        if (l === null) throw new Error('layer');
        into.arcs.push({ c: { x: len(f[2]), y: len(f[3]) }, r: len(f[4]), start: Number(f[5]) || 0, end: Number(f[6]) || 0, width: len(f[7]), layer: l, net: 0 });
      } else if (tag === 'CV' || tag === 'FV') {
        const f = nums();
        board.vias.push({ at: { x: len(f[2]), y: len(f[3]) }, diameter: len(f[4]), hole: len(f[5]), net: Number(f[8] ?? 0) || 0 });
      } else if (tag === 'NETDEF') {
        board.nets.push(next().replace(/\r$/, '').trim());
        // (its figures, its members in round brackets and its connections in curly ones are passed over to the next tag)
        while (i < lines.length && !TAGS.has((lines[i] ?? '').trim())) i++;
      }
      // (anything else between the records and ENDPCB is the board's setup: not read)
    } catch (e) {
      board.lost.push(`line ${at + 1}: ${tag}`);
      while (i < lines.length && !TAGS.has((lines[i] ?? '').trim())) i++;
    }
  }
  return board;
}
