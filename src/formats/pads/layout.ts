/**
 * PADS Layout (PowerPCB) ASCII files (.asc) as AD boards. The file's version decides its details
 * (PowerPCB 5 writes two-line texts and labels; PADS 9.0 and later a corner radius in square and
 * finger pads; 9.4 and later a line style in pieces; PADS 2007 and later flags in line items).
 *
 * The layers: copper by MAXIMUMLAYER (CAM planes as AD's planes with their nets), the others by
 * their types and names in *MISC*'s layer data (silkscreens, masks, pastes, assembly drawings on
 * mechanical 13 and 14, the drill drawing, the rest on mechanical layers with their names).
 * Decals are footprints: their pads by their stacks (round, square with rounded or chamfered
 * corners, oval and rectangular fingers with their offset, top/inner/bottom sizes, the mask and
 * paste rows as expansions, drills, slots, plated or not), outlines (on the top copper level:
 * the silkscreen), copper, keep-outs, text and labels. Parts are placed (a mirrored part on the
 * bottom: AD's angle is 180° less PADS's), their designator and comment where their labels are
 * (the comment: the part's Value, else its part type). Routes are tracks, arcs and vias; pours
 * are polygon pours with their copper (the hatch outlines grown by half their line width, less
 * their voids), thermals; copper and keep-outs from *LINES*, the board outline (more loops:
 * cut-outs), drafting, dimensions' lines and text, free text; the default design rules.
 */
import * as ClipperNS from 'clipper-lib';
import { applyStackLayers, assemblePcbDoc } from '../altium/assemble';
import { newBoardRecord } from '../altium/board6';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, flattenVertices, layerToName, readPcbDoc, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import { keepPadsSource, sealPads, tagPads } from './kept';
import { newPolygonProps } from '../altium/polygonProps';
import { formatAltiumLength, mil } from '../../core/units';
import { pointInPoly, type Vec2 } from '../../core/geom';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PolyVertex } from '../../model/pcb';
import { footprintsFromBoard } from '../../model/pcbLib';
import { repour } from '../../model/pcbEdit';
import { altiumFloat } from '../altium/pcbTransform';
import { strokeTextWidth } from '../gerber/stroke';
import type { FootprintDef } from '../altium/pcblib';
import { arc3, boardRules, type KicadRules } from '../kicad/board';
import { UNIT_FACTOR, isFontLine, num, padsHeader, tokens, type PadsUnits } from './ascii';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;

/* ── the file's model ── */

type Pt = { x: number; y: number };
/** A corner; an arc from it (its centre, radius, start angle and sweep in degrees, anticlockwise positive) when `arc` is set. */
export interface Corner { p: Pt; arc?: { c: Pt; r: number; a0: number; sweep: number } }
export interface Piece { type: string; width: number; level: number; corners: Corner[]; pinnum?: number; restrictions?: string }
export interface PadsText { x: number; y: number; ori: number; level: number; height: number; width: number; mirrored: boolean; hjust: string; vjust: string; text: string; visible: boolean; /** A free text's line in the file. */ line?: number }
export interface StackLine { level: number; size: number; shape: string; ori: number; length: number; offset: number; corner: number; drill: number; plated: boolean; slotOri: number; slotLen: number }
export interface PadsDecal { name: string; units: string; pieces: Piece[]; texts: PadsText[]; labels: PadsText[]; terms: { x: number; y: number; name: string }[]; stacks: Map<number, StackLine[]> }
export interface PadsPartType { name: string; decals: string[]; pinNames: string[]; sigPins: { pin: string; net: string }[]; attrs: Map<string, string> }
export interface PadsPart { ref: string; type: string; decal?: string; x: number; y: number; ori: number; bottom: boolean; alt: number; labels: PadsText[]; /** Its line in the file (0: the header's). */ line?: number }
export interface RoutePoint { x: number; y: number; layer: number; width: number; flags: number; via?: string; arc?: 'CW' | 'CCW' }
export interface PadsRoute { net: string; pins: string[]; conns: RoutePoint[][]; /** Its *SIGNAL* line in the file. */ line?: number }
export interface PadsVia { name: string; drill: number; stack: StackLine[]; start: number; end: number; /** Its line in the file. */ line?: number }
export interface PadsPour { name: string; type: string; x: number; y: number; flags: number; owner: string; net: string; priority: number; pieces: Piece[]; /** Its line in the file. */ line?: number }
export interface PadsLine { name: string; type: string; x: number; y: number; flags: number; net: string; pieces: Piece[]; texts: PadsText[]; /** Its line in the file. */ line?: number }
export interface PadsLayerDef { n: number; name: string; type: string; plane: string; net: string; thickness: number; copper: number; er: number }
export interface MiscNode { key: string; value: string; kids: MiscNode[] }
export interface PadsBoard {
  units: PadsUnits; version: string; copperCount: number; defaultVia: string; origin: Pt;
  decals: Map<string, PadsDecal>; partTypes: Map<string, PadsPartType>; parts: PadsPart[]; routes: PadsRoute[]; nets: Map<string, string[]>; vias: Map<string, PadsVia>;
  pours: PadsPour[]; lines: PadsLine[]; texts: PadsText[]; layers: Map<number, PadsLayerDef>; misc: MiscNode[];
  /** Each section as it comes in the file: its name and its header's line. */
  sections?: { name: string; line: number }[];
}

/** What the file's version writes (see the header). */
export interface PadsFormat { font: boolean; lineStyle: boolean; corner: boolean; lineFlags: boolean }
export function padsFormat(version: string, remarks: string[] = []): PadsFormat {
  const v = parseFloat(version) || 0, known = v > 0, year = v >= 2000;
  const pieces = remarks.find((r) => /PIECETYPE\s+CORNERS\s+WIDTH/.test(r));
  return {
    font: !known || year || v >= 6,
    lineStyle: pieces ? /LINESTYLE/.test(pieces) : !known || (!year && v >= 9.4),
    corner: !known || (!year && v >= 9),
    lineFlags: !known || v >= 2007 || (!year && v >= 6),
  };
}

export const isPadsLayout = (head: string): boolean => /^!PADS-(POWERPCB|LAYOUT|PCB)/i.test(head.trimStart());

const isNum = (s: string | undefined): boolean => s !== undefined && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s);
const isSection = (l: string): boolean => l.charCodeAt(0) === 42 /* * */ && /^\*[A-Z][A-Z_ ]*\*/.test(l) && !l.startsWith('*SIGNAL*');

/** The file's lines (trimmed, without blanks and remarks) with a cursor that stops at the next section. */
class Cursor {
  i = 0;
  /** `at`: each line's place in the file (0: the header's). */
  constructor(readonly ls: string[], readonly at: number[] = []) {}
  /** The file's line of the next line. */
  get line(): number { return this.at[this.i] ?? -1; }
  get done(): boolean { return this.i >= this.ls.length; }
  get atEnd(): boolean { return this.done || isSection(this.ls[this.i]!); }
  peek(): string { return this.atEnd ? '' : this.ls[this.i]!; }
  next(): string { return this.atEnd ? '' : this.ls[this.i++]!; }
  /** The next line whatever it holds (a text's string). */
  raw(): string { return this.ls[this.i++] ?? ''; }
}

/** Corners: "x y", an arc "x1 y1 ab aa ax1 ay1 ax2 ay2" (from x1 y1 about the box's centre, angles in tenths), or in pours "cx cy ab aa" between the arc's ends. */
function readCorners(cur: Cursor, n: number, pour = false): Corner[] {
  const out: Corner[] = [];
  for (let k = 0; k < n && !cur.atEnd; k++) {
    const t = tokens(cur.next());
    if (t.length < 2) continue;
    const x = num(t[0]), y = num(t[1]);
    if (!pour && t.length >= 8) {
      const ax1 = num(t[4]), ay1 = num(t[5]), ax2 = num(t[6]), ay2 = num(t[7]);
      out.push({ p: { x, y }, arc: { c: { x: (ax1 + ax2) / 2, y: (ay1 + ay2) / 2 }, r: Math.abs(ax2 - ax1) / 2, a0: num(t[2]) / 10, sweep: num(t[3]) / 10 } });
    } else if (pour && t.length >= 4) {
      const prev = out[out.length - 1];
      if (prev) prev.arc = { c: { x, y }, r: Math.hypot(prev.p.x - x, prev.p.y - y), a0: num(t[2]) / 10, sweep: num(t[3]) / 10 };
    } else out.push({ p: { x, y } });
  }
  return out;
}

/** A piece: TYPE CORNERS WIDTH [LINESTYLE] LEVEL [PINNUM | RESTRICTIONS], then its corners; in pours TYPE CORNERS ARCS WIDTH LEVEL. */
function readPiece(cur: Cursor, fmt: PadsFormat, pour = false): Piece | null {
  const t = tokens(cur.next());
  if (!t.length) return null;
  const type = t[0]!.toUpperCase();
  if (pour) return { type, width: num(t[3]), level: num(t[4]), corners: readCorners(cur, num(t[1]) + num(t[2]), true) };
  const rest = t.slice(3);
  const ints = rest.filter(isNum).map(Number);
  const piece: Piece = { type, width: num(t[2]), level: 0, corners: [] };
  const k = fmt.lineStyle && ints.length >= 2 ? 1 : 0;
  piece.level = ints[k] ?? 0;
  if (ints.length > k + 1) piece.pinnum = ints[k + 1];
  piece.restrictions = rest.find((x) => /^[A-Z]+$/.test(x));
  if (type !== 'TAG') piece.corners = readCorners(cur, num(t[1]));
  return piece;
}

/** A text or label: [VISIBLE] X Y ORI LEVEL HEIGHT WIDTH [M|N] HJUST VJUST …, its font (PADS 2005 and later), its string. */
function readText(cur: Cursor, fmt: PadsFormat, label: boolean): PadsText | null {
  const t = tokens(cur.next());
  if (!t.length) return null;
  let k = 0, visible = true;
  if (label || !isNum(t[0])) { visible = !/^NONE$/i.test(t[0]!); k = 1; }
  const v = (i: number) => num(t[k + i]);
  let j = k + 6;
  const mirrored = t[j] === 'M';
  if (t[j] === 'M' || t[j] === 'N') j++;
  const out: PadsText = { visible, x: v(0), y: v(1), ori: v(2), level: v(3), height: v(4), width: v(5), mirrored, hjust: (t[j] ?? 'LEFT').toUpperCase(), vjust: (t[j + 1] ?? 'DOWN').toUpperCase(), text: '' };
  const f = cur.peek();
  if (isFontLine(f) || (fmt.font && /<[^>]*>\s*$/.test(f))) cur.next();
  out.text = cur.raw();
  return out;
}

/** A pad stack's row: LEVEL SIZE SHAPE and the shape's values, then [DRILL [P|N] [SLOT ORI LENGTH OFFSET]]. */
function readStackLine(t: string[], fmt: PadsFormat): StackLine {
  const s: StackLine = { level: num(t[0]), size: num(t[1]), shape: (t[2] ?? 'R').toUpperCase(), ori: 0, length: 0, offset: 0, corner: 0, drill: 0, plated: true, slotOri: 0, slotLen: 0 };
  let rest = t.slice(3);
  switch (s.shape) {
    case 'OF': case 'RF': case 'RC':
      s.ori = num(rest[0]); s.length = num(rest[1]); s.offset = num(rest[2]); rest = rest.slice(3);
      if (s.shape !== 'OF' && fmt.corner && isNum(rest[0])) { s.corner = num(rest[0]); rest = rest.slice(1); }
      break;
    case 'S': if (fmt.corner && isNum(rest[0])) { s.corner = num(rest[0]); rest = rest.slice(1); } break;
    case 'A': rest = rest.slice(1); break;
    case 'RT': case 'ST': s.ori = num(rest[0]); rest = rest.slice(4); break;
  }
  // A "corner" bigger than half the pad is the drill of a file that leaves the corner out
  if (Math.abs(s.corner) > Math.min(s.size, s.length || s.size) / 2 + 1e-9 && !isNum(rest[0])) { s.drill = Math.abs(s.corner); s.corner = 0; }
  if (isNum(rest[0])) { s.drill = num(rest[0]); rest = rest.slice(1); }
  if (/^[PYN]$/.test(rest[0] ?? '')) { s.plated = rest[0] !== 'N'; rest = rest.slice(1); }
  if (rest.length >= 2 && isNum(rest[0]) && isNum(rest[1])) { s.slotOri = num(rest[0]); s.slotLen = num(rest[1]); }
  return s;
}

/** *MISC*'s nested blocks: a line, then its children in braces. */
function readMisc(cur: Cursor): MiscNode[] {
  const root: MiscNode = { key: '', value: '', kids: [] };
  const stack: MiscNode[] = [root];
  let last: MiscNode | null = null;
  while (!cur.atEnd) {
    const l = cur.next();
    if (l === '{' || l.startsWith('{ ')) { if (last) stack.push(last); continue; }
    if (l === '}' || l.startsWith('} ')) { if (stack.length > 1) stack.pop(); continue; }
    const m = /^("[^"]*"|\S+)\s*(.*)$/.exec(l);
    if (!m) continue;
    last = { key: m[1]!.replace(/^"|"$/g, ''), value: m[2]!.trim().replace(/^"(.*)"$/, '$1'), kids: [] };
    stack[stack.length - 1]!.kids.push(last);
  }
  return root.kids;
}

/** "C{2-20}"-style shortcuts as their names. */
export function expandShortcut(s: string): string[] {
  const m = /^(.*?)\{(\d+)-(\d+)\}(.*)$/.exec(s);
  if (!m) return [s];
  const a = Number(m[2]), b = Number(m[3]), out: string[] = [];
  if (Math.abs(b - a) > 10000) return [s];
  for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) for (const rest of expandShortcut(m[4]!)) out.push(`${m[1]}${i}${rest}`);
  return out;
}

export function parsePadsLayout(text: string): PadsBoard {
  const all = text.split(/\r?\n/);
  const h = padsHeader(all[0] ?? '');
  if (!h) throw new Error('Not a PADS ASCII file');
  const remarks = all.filter((l) => l.startsWith('*REMARK*'));
  const fmt = padsFormat(h.version, remarks);
  const b: PadsBoard = { units: h.units, version: h.version, copperCount: 2, defaultVia: '', origin: { x: 0, y: 0 }, decals: new Map(), partTypes: new Map(), parts: [], routes: [], nets: new Map(), vias: new Map(), pours: [], lines: [], texts: [], layers: new Map(), misc: [] };
  const kept: string[] = [], at: number[] = [];
  all.forEach((l, i) => { if (i === 0) return; const t = l.trim(); if (t && !t.startsWith('*REMARK*')) { kept.push(t); at.push(i); } });
  const cur = new Cursor(kept, at);
  // Where each section starts in the file (its header's line)
  b.sections = [];
  let pcbUnits: number | null = null;
  while (!cur.done) {
    const headAt = cur.line;
    const head = cur.raw();
    const sec = /^\*([A-Z][A-Z_ ]*?)\*/.exec(head)?.[1] ?? '';
    b.sections!.push({ name: sec, line: headAt });
    if (sec === 'END') break;
    switch (sec) {
      case 'PCB':
        while (!cur.atEnd) {
          const t = tokens(cur.next());
          if (t[0] === 'MAXIMUMLAYER') b.copperCount = Math.max(1, num(t[1], 2));
          else if (t[0] === 'UNITS') pcbUnits = num(t[1], 0);
          else if (t[0] === 'VIAPSHVIA') b.defaultVia = t[1] ?? '';
          else if (t[0] === 'ORIGIN') b.origin = { x: num(t[1]), y: num(t[2]) };
        }
        break;
      case 'TEXT':
        while (!cur.atEnd) { const at = cur.line; const t = readText(cur, fmt, false); if (t) b.texts.push({ ...t, line: at }); }
        break;
      case 'LINES':
        while (!cur.atEnd) {
          const at = cur.line;
          const t = tokens(cur.next());
          if (t.length < 5) continue;
          const item: PadsLine = { name: t[0]!, type: t[1]!.toUpperCase(), x: num(t[2]), y: num(t[3]), flags: 0, net: '', pieces: [], texts: [], line: at };
          const rest = t.slice(5);
          if (fmt.lineFlags && rest.length) item.flags = num(rest.shift());
          let ntext = 0;
          if (rest.length >= 2) { ntext = num(rest[0]); item.net = rest[1]!; }
          else if (rest.length === 1) { if (/^\d+$/.test(rest[0]!)) ntext = num(rest[0]); else item.net = rest[0]!; }
          if (cur.peek().startsWith('.REUSE.')) cur.next();
          for (let k = 0, n = num(t[4]); k < n && !cur.atEnd; k++) { const p = readPiece(cur, fmt); if (p) item.pieces.push(p); }
          for (let k = 0; k < ntext && !cur.atEnd; k++) { const tx = readText(cur, fmt, false); if (tx) item.texts.push(tx); }
          b.lines.push(item);
        }
        break;
      case 'VIA':
        while (!cur.atEnd) {
          const t = tokens(cur.next());
          if (t.length < 3 || !isNum(t[1])) continue;
          const v: PadsVia = { name: t[0]!, drill: num(t[1]), stack: [], start: num(t[3], 0), end: num(t[4], 0), line: cur.at[cur.i - 1] };
          for (let k = 0, n = num(t[2]); k < n && !cur.atEnd; k++) v.stack.push(readStackLine(tokens(cur.next()), fmt));
          b.vias.set(v.name, v);
        }
        break;
      case 'POUR':
        while (!cur.atEnd) {
          const at = cur.line;
          const t = tokens(cur.next());
          if (t.length < 6 || !isNum(t[4])) continue;
          const p: PadsPour = { name: t[0]!, type: t[1]!.toUpperCase(), x: num(t[2]), y: num(t[3]), flags: num(t[5]), owner: t[6] ?? t[0]!, net: t[7] ?? '', priority: num(t[10], 0), pieces: [], line: at };
          if (cur.peek().startsWith('.REUSE.')) cur.next();
          for (let k = 0, n = num(t[4]); k < n && !cur.atEnd; k++) { const pc = readPiece(cur, fmt, true); if (pc) p.pieces.push(pc); }
          b.pours.push(p);
        }
        break;
      case 'PARTDECAL':
        while (!cur.atEnd) {
          const t = tokens(cur.next());
          if (t.length < 9 || !isNum(t[4])) continue;
          const d: PadsDecal = { name: t[0]!, units: (t[1] ?? 'I').toUpperCase(), pieces: [], texts: [], labels: [], terms: [], stacks: new Map() };
          const [pieces, terms, stacks, ntext, nlab] = [4, 5, 6, 7, 8].map((i) => num(t[i])) as [number, number, number, number, number];
          if (cur.peek().startsWith('TIMESTAMP')) cur.next();
          for (let k = 0; k < pieces && !cur.atEnd; k++) { const p = readPiece(cur, fmt); if (p) d.pieces.push(p); }
          for (let k = 0; k < ntext && !cur.atEnd; k++) { const tx = readText(cur, fmt, false); if (tx) d.texts.push(tx); }
          for (let k = 0; k < nlab && !cur.atEnd; k++) { const lb = readText(cur, fmt, true); if (lb) d.labels.push(lb); }
          for (let k = 0; k < terms && !cur.atEnd; k++) {
            const tt = tokens(cur.next().replace(/^T/, ''));
            d.terms.push({ x: num(tt[0]), y: num(tt[1]), name: tt[4] ?? String(k + 1) });
          }
          for (let k = 0; k < stacks && !cur.atEnd; k++) {
            const ph = tokens(cur.next());
            if (ph[0] !== 'PAD') continue;
            const rows: StackLine[] = [];
            for (let j = 0, n = num(ph[2]); j < n && !cur.atEnd; j++) rows.push(readStackLine(tokens(cur.next()), fmt));
            // A drill and its plating on the PAD line (older files)
            const hd = isNum(ph[3]) ? num(ph[3]) : 0;
            for (const r of rows) { if (!r.drill && hd) r.drill = hd; if (ph[3] === 'N' || ph[4] === 'N') r.plated = false; }
            d.stacks.set(num(ph[1]), rows);
          }
          b.decals.set(d.name, d);
        }
        break;
      case 'PARTTYPE': {
        // A record has no end: its counts say where it ends
        let pt: PadsPartType | null = null, gates = 0, gatePins = 0, names = 0, depth = 0;
        while (!cur.atEnd) {
          const l = cur.next();
          if (l.startsWith('{')) { depth++; continue; }
          if (l.startsWith('}')) { depth = Math.max(0, depth - 1); continue; }
          if (depth > 0) {
            const m = /^("[^"]*"|\S+)\s*(.*)$/.exec(l);
            if (pt && m) pt.attrs.set(m[1]!.replace(/^"|"$/g, ''), m[2]!.trim());
            continue;
          }
          const t = tokens(l);
          if (pt && gatePins > 0) { gatePins -= Math.min(gatePins, t.length); continue; }
          if (pt && gates > 0 && t[0] === 'G' && isNum(t[1]) && isNum(t[2])) { gates--; gatePins = num(t[2]); continue; }
          if (pt && t[0] === 'SIGPIN') { pt.sigPins.push({ pin: t[1] ?? '', net: t[3] ?? t[2] ?? '' }); continue; }
          if (pt && gates === 0 && names > 0) { const take = t.slice(0, names); pt.pinNames.push(...take); names -= take.length; continue; }
          // NAME DECALS [UNITS] TYPE GATES SIGPINS PINNAMES FLAGS ECO (PowerPCB 5 and PADS 2005 add the units)
          pt = { name: t[0]!, decals: (t[1] ?? '').split(':'), pinNames: [], sigPins: [], attrs: new Map() };
          const first = t.findIndex((x, i) => i >= 2 && /^\d+$/.test(x));
          gates = first > 0 ? num(t[first]) : 0; names = first > 0 ? num(t[first + 2]) : 0; gatePins = 0;
          b.partTypes.set(pt.name, pt);
        }
        break;
      }
      case 'PART': case 'PARTS': {
        let depth = 0;
        while (!cur.atEnd) {
          const lineAt = cur.line;
          const l = cur.next();
          if (l.startsWith('{')) { depth++; continue; }
          if (l.startsWith('}')) { depth = Math.max(0, depth - 1); continue; }
          if (depth > 0) continue;
          const t = tokens(l);
          if (t.length < 5 || !isNum(t[2]) || !isNum(t[3])) continue;
          const [type, decal] = t[1]!.includes('@') ? t[1]!.split('@', 2) as [string, string] : [t[1]!, undefined];
          const last = t[t.length - 1]!;
          const nlab = t.length >= 8 && /^\d+$/.test(last) ? num(last) : 0;
          if (cur.peek().startsWith('.REUSE.')) cur.next();
          const labels: PadsText[] = [];
          for (let k = 0; k < nlab && !cur.atEnd; k++) { const lb = readText(cur, fmt, true); if (lb) labels.push(lb); }
          for (const ref of expandShortcut(t[0]!)) b.parts.push({ ref, type, decal, x: num(t[2]), y: num(t[3]), ori: num(t[4]), bottom: t[6] === 'M' || t[5] === 'M', alt: num(t[7], 0), labels, line: lineAt });
        }
        break;
      }
      case 'NET': case 'NETLIST': case 'NETS': {
        let net = '';
        while (!cur.atEnd) {
          const t = tokens(cur.next());
          let pins = t;
          if (t[0] === '*SIGNAL*' || t[0] === 'SIGNAL') { net = t[1] ?? ''; if (!b.nets.has(net)) b.nets.set(net, []); pins = t.slice(2); }
          if (net) b.nets.get(net)!.push(...pins.filter((x) => x.includes('.') && x !== '.REUSE.').flatMap(expandShortcut));
        }
        break;
      }
      case 'ROUTE': {
        let route: PadsRoute | null = null;
        while (!cur.atEnd) {
          const lineAt = cur.line;
          const t = tokens(cur.next());
          if (t[0] === '*SIGNAL*') { route = { net: t[1] ?? '', pins: [], conns: [], line: lineAt }; b.routes.push(route); continue; }
          if (!route) continue;
          if (isNum(t[0]) && isNum(t[1])) {
            const pt: RoutePoint = { x: num(t[0]), y: num(t[1]), layer: num(t[2]), width: num(t[3]), flags: num(t[4]) };
            for (const x of t.slice(5)) {
              if (x === 'CW' || x === 'CCW') pt.arc = x;
              else if (b.vias.has(x)) pt.via ??= x;
              else if (x === 'TEARDROP') break;
            }
            if (!route.conns.length) route.conns.push([]);
            route.conns[route.conns.length - 1]!.push(pt);
          } else {
            // A pin pair: a connection follows
            for (const p of t) if (p.includes('.') && p !== '.REUSE.' && !route.pins.includes(p)) route.pins.push(p);
            route.conns.push([]);
          }
        }
        break;
      }
      case 'MISC': b.misc.push(...readMisc(cur)); break;
      default: while (!cur.atEnd) cur.next();
    }
  }
  if (b.units !== 'BASIC' && pcbUnits !== null) b.units = pcbUnits === 1 ? 'METRIC' : pcbUnits === 2 ? 'INCHES' : 'MILS';
  const layerData = b.misc.find((n) => n.key === 'LAYER' && /^DATA$/i.test(n.value));
  for (const n of layerData?.kids ?? []) {
    if (n.key !== 'LAYER' || !isNum(n.value)) continue;
    const get = (k: string) => n.kids.find((x) => x.key.toUpperCase() === k)?.value ?? '';
    b.layers.set(num(n.value), { n: num(n.value), name: get('LAYER_NAME'), type: get('LAYER_TYPE').toUpperCase(), plane: get('PLANE').toUpperCase(), net: get('NET'),
      thickness: num(get('LAYER_THICKNESS')), copper: num(get('COPPER_THICKNESS')), er: num(get('DIELECTRIC')) });
  }
  return b;
}

/* ── to AD ── */

export interface PadsResult { bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[]; stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number } }

const norm = (a: number) => ((a % 360) + 360) % 360;
const rad = (d: number) => (d * Math.PI) / 180;
const dir = (c: Pt, r: number, a: number): Pt => ({ x: c.x + r * Math.cos(rad(a)), y: c.y + r * Math.sin(rad(a)) });
const THERMAL = /^(RT|ST|RA|SA)$/;
/**
 * AD's text height for PADS's: PADS's height is its characters' cell, about twice AD's stroke
 * height for the same width of text [est: issue 23856's texts written on both sides, each pair's
 * ends level].
 */
export const PADS_TEXT_SCALE = 0.52;

/** The default design rules (*MISC*'s rule set for everything, on all layers) and the nets' own, as KiCad's rules (mm) for AD's. */
function padsRules(b: PadsBoard, f: number): KicadRules {
  const mm = (v: number) => ((v * f) / 1e7) * 25.4;
  const sets = b.misc.find((n) => n.key === 'RULES_SECTION')?.kids.find((n) => n.key === 'DESIGN' && /^RULES/.test(n.value))?.kids.filter((n) => n.key === 'RULE_SET') ?? [];
  const out: KicadRules = { classes: [] };
  const vals = (s: MiscNode) => new Map((s.kids.find((k) => k.key === 'CLEARANCE_RULE')?.kids ?? []).map((k) => [k.key, num(k.value)]));
  sets.forEach((s, i) => {
    const forK = s.kids.find((k) => k.key === 'FOR')?.kids ?? [], against = s.kids.find((k) => k.key === 'AGAINST')?.kids ?? [];
    if ((s.kids.find((k) => k.key === 'LAYER')?.value ?? '0') !== '0') return;
    const v = vals(s);
    if (!v.size) return;
    const clearance = v.get('TRACK_TO_TRACK'), width = v.get('REC_TRACK_WIDTH');
    if (forK.some((k) => k.key === 'DEFAULT') && against.some((k) => k.key === 'DEFAULT')) {
      if (clearance) out.clearance = mm(clearance);
      if (width) out.trackWidth = mm(width);
      const mn = v.get('MIN_TRACK_WIDTH'), hh = v.get('DRILL_TO_DRILL'), edge = v.get('OUTLINE_TO_TRACK');
      if (mn) out.minTrack = mm(mn);
      if (hh) out.holeToHole = mm(hh);
      if (edge) out.copperEdge = mm(edge);
    } else if (against.some((k) => k.key === 'DEFAULT')) {
      const nets = forK.filter((k) => k.key === 'NET').map((k) => k.value);
      if (nets.length) out.classes!.push({ name: `PADS_Rule_${i + 1}`, nets, clearance: clearance ? mm(clearance) : undefined, trackWidth: width ? mm(width) : undefined });
    }
  });
  const via = b.vias.get(b.defaultVia) ?? [...b.vias.values()][0];
  if (via) { const sz = Math.max(0, ...via.stack.filter((r) => r.level === -2 || r.level === 1).map((r) => r.size)); if (sz && via.drill) { out.viaDiameter = mm(sz); out.viaDrill = mm(via.drill); } }
  return out;
}

export function convertPadsLayout(text: string, fileName: string, source?: Uint8Array): PadsResult {
  const b = parsePadsLayout(text);
  const warnings: string[] = [];
  const name = fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  const f = UNIT_FACTOR[b.units];
  const decalFactor = (d: PadsDecal | undefined) => (b.units === 'BASIC' || !d ? f : d.units === 'M' ? UNIT_FACTOR.METRIC : UNIT_FACTOR.MILS);

  /* Layers */
  const N = Math.max(1, Math.min(32, b.copperCount));
  const def = (n: number) => b.layers.get(n);
  const camPlane = (n: number) => n > 1 && n < N && /CAM/.test(def(n)?.plane ?? '');
  const copperIds: LayerId[] = [];
  let mids = 0, planes = 0;
  for (let n = 1; n <= N; n++) {
    if (n === 1) copperIds.push(L.TOP);
    else if (n === N) copperIds.push(L.BOTTOM);
    else if (camPlane(n) && planes < 16) copperIds.push((L.PLANE1 + planes++) as LayerId);
    else copperIds.push((L.MID1 + mids++) as LayerId);
  }
  const mechOf = new Map<number, number>(), mechNames = new Map<number, string>();
  let nextMech = 2;
  const mech = (key: number, nm: string): LayerId => {
    let m = mechOf.get(key);
    if (m === undefined) {
      // AD's own mechanical layers (as Konium writes them) back where they were
      const own = /^Mechanical\s*(\d+)$/i.exec(nm.trim());
      const k = own ? Number(own[1]) : 0;
      if (k >= 1 && k <= 32 && ![...mechOf.values()].includes(k)) m = k;
      else {
        while (nextMech === 13 || nextMech === 14 || [...mechOf.values()].includes(nextMech)) nextMech++;
        if (nextMech > 32) return mechLayer(32);
        m = nextMech++;
      }
      mechOf.set(key, m);
      mechNames.set(m, nm || `Layer ${key}`);
    }
    return mechLayer(m);
  };
  /** Each layer's PADS number and type, the first it was read from (PADSLEVELS: for the way back). */
  const levelBack = new Map<LayerId, string>();
  const layerOf = (n: number): LayerId | null => {
    const l = layerOf0(n);
    if (l !== null && n > N && !levelBack.has(l)) levelBack.set(l, `${n}:${def(n)?.type ?? ''}`);
    return l;
  };
  /** A PADS layer number as AD's (null: nothing goes there). */
  const layerOf0 = (n: number): LayerId | null => {
    if (n >= 1 && n <= N) return copperIds[n - 1]!;
    const d = def(n);
    const nm = d?.name ?? '', bot = /bot/i.test(nm);
    switch (d?.type) {
      case 'SILK_SCREEN': if (/silk/i.test(nm) || !nm) return bot ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY; break;
      case 'SOLDER_MASK': return bot ? L.BOTTOM_SOLDER : L.TOP_SOLDER;
      case 'PASTE_MASK': return bot ? L.BOTTOM_PASTE : L.TOP_PASTE;
      case 'ASSEMBLY': if (/assembly/i.test(nm)) return mechLayer(bot ? 14 : 13); break;
      case 'DRILL': if (/drill/i.test(nm)) return L.DRILL_DRAWING; break;
      case 'ROUTING': case 'PLANE': case 'MIXED': return null;
    }
    if (!d) {
      // No layer data (older files): PADS's own numbers
      const fixed: Record<number, LayerId> = { 21: L.TOP_SOLDER, 22: L.BOTTOM_PASTE, 23: L.TOP_PASTE, 24: L.DRILL_DRAWING, 26: L.TOP_OVERLAY, 27: mechLayer(13), 28: L.BOTTOM_SOLDER, 29: L.BOTTOM_OVERLAY, 30: mechLayer(14) };
      if (fixed[n]) return fixed[n]!;
      if (n <= 0) return null;
    }
    return mech(n, nm);
  };
  const FLIP: Record<number, LayerId> = { [L.TOP]: L.BOTTOM, [L.BOTTOM]: L.TOP, [L.TOP_OVERLAY]: L.BOTTOM_OVERLAY, [L.BOTTOM_OVERLAY]: L.TOP_OVERLAY, [L.TOP_SOLDER]: L.BOTTOM_SOLDER,
    [L.BOTTOM_SOLDER]: L.TOP_SOLDER, [L.TOP_PASTE]: L.BOTTOM_PASTE, [L.BOTTOM_PASTE]: L.TOP_PASTE, [mechLayer(13)]: mechLayer(14), [mechLayer(14)]: mechLayer(13) };

  /* Placement on AD's sheet: the board's corner (or PADS's origin, when that lies further down or left) 1000 mil from the sheet's */
  const outlinePts: Pt[] = [];
  for (const l of b.lines) if (l.type === 'BOARD') for (const pc of l.pieces) for (const c of pc.corners) outlinePts.push({ x: l.x + c.p.x, y: l.y + c.p.y });
  if (!outlinePts.length) for (const p of b.parts) outlinePts.push({ x: p.x, y: p.y });
  let bx = Infinity, by = Infinity;
  for (const p of outlinePts) { if (p.x < bx) bx = p.x; if (p.y < by) by = p.y; }
  if (!outlinePts.length) bx = by = 0;
  else { bx = Math.min(bx, b.origin.x); by = Math.min(by, b.origin.y); }
  const P = (p: Pt): Vec2 => ({ x: Math.round(mil(1000) + (p.x - bx) * f), y: Math.round(mil(1000) + (p.y - by) * f) });
  const len = (v: number, k = f) => Math.max(0, Math.round(v * k));

  /* Nets */
  const nets: string[] = [];
  const netIdx = new Map<string, number>();
  const netOf = (n: string | undefined): number | undefined => {
    if (!n) return undefined;
    let i = netIdx.get(n);
    if (i === undefined) { i = nets.length; nets.push(n); netIdx.set(n, i); }
    return i;
  };
  const pinNet = new Map<string, number>();
  for (const r of b.routes) { const n = netOf(r.net)!; for (const p of r.pins) pinNet.set(p, n); }
  for (const [nm, pins] of b.nets) { const n = netOf(nm)!; for (const p of pins) if (!pinNet.has(p)) pinNet.set(p, n); }

  /* Attributes from *MISC* */
  const attrs = b.misc.find((n) => n.key === 'ATTRIBUTE' && /^VALUES$/i.test(n.value));
  const attrMap = new Map<string, Map<string, string>>();
  for (const n of attrs?.kids ?? []) attrMap.set(`${n.key.toUpperCase()} ${n.value}`, new Map(n.kids.map((k) => [k.key.toLowerCase(), k.value])));
  const attrOf = (part: PadsPart, key: string): string | undefined =>
    attrMap.get(`PART ${part.ref}`)?.get(key.toLowerCase()) ?? attrMap.get(`PARTTYPE ${part.type}`)?.get(key.toLowerCase()) ?? [...(b.partTypes.get(part.type)?.attrs ?? [])].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

  const comps: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], texts: PcbRawRecord[] = [], regions: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  let nTracks = 0;

  /** A piece's corners as AD's vertices through `map` (a point in its frame → the board's), an arc by its three points. */
  const vertices = (pc: Piece, map: (p: Pt) => Vec2): PolyVertex[] => {
    const out: PolyVertex[] = [];
    pc.corners.forEach((c, i) => {
      if (!c.arc) { out.push({ p: map(c.p) }); return; }
      const { c: cc, r, a0, sweep } = c.arc;
      const end = dir(cc, r, a0 + sweep), a = map(c.p), e = map(end);
      const g = arc3(a, map(dir(cc, r, a0 + sweep / 2)), e);
      out.push(g ? { p: a, arc: { c: g.c, r: g.r, sa: g.start, ea: g.end } } : { p: a });
      const nx = pc.corners[i + 1];
      // An arc whose end isn't the next corner (or the last corner's): its end as a corner
      if (!nx || Math.hypot(nx.p.x - end.x, nx.p.y - end.y) > Math.max(1, r * 1e-3)) out.push({ p: e });
    });
    return out;
  };
  const circleOf = (pc: Piece, map: (p: Pt) => Vec2): { c: Vec2; r: number } | null => {
    if (pc.corners.length < 2) return null;
    const a = map(pc.corners[0]!.p), e = map(pc.corners[1]!.p);
    return { c: { x: Math.round((a.x + e.x) / 2), y: Math.round((a.y + e.y) / 2) }, r: Math.round(Math.hypot(e.x - a.x, e.y - a.y) / 2) };
  };
  const ringOfCircle = (c: Vec2, r: number, n = 32): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: Math.round(c.x + r * Math.cos((i / n) * 2 * Math.PI)), y: Math.round(c.y + r * Math.sin((i / n) * 2 * Math.PI)) }));
  const isCircle = (t: string) => /CIRCLE|CIR$|CCO$/.test(t);
  /** A closed piece's outline (a circle's as a polygon). */
  const ringOf = (pc: Piece, map: (p: Pt) => Vec2): Vec2[] => {
    if (isCircle(pc.type)) { const c = circleOf(pc, map); return c ? ringOfCircle(c.c, c.r) : []; }
    const fl = flattenVertices(vertices(pc, map));
    const l = fl[fl.length - 1], f0 = fl[0];
    if (fl.length > 1 && l && f0 && Math.abs(l.x - f0.x) <= 1 && Math.abs(l.y - f0.y) <= 1) fl.pop();
    return fl;
  };
  const keepout = (rec: PcbRawRecord) => { rec.subs[0]![2] = 2; return rec; };
  /** One item's or decal's filled shapes, the cut-outs inside them their holes (the others polygon cut-outs). */
  type Fill = { layer: LayerId; ring: Vec2[]; holes: Vec2[][]; net?: number; component?: number; keep?: boolean };
  const fillGroup = () => {
    const fills: Fill[] = [], cuts: { layer: LayerId; ring: Vec2[] }[] = [];
    return {
      fill(f: Omit<Fill, 'holes'>) { if (f.ring.length >= 3) fills.push({ ...f, holes: [] }); },
      cut(layer: LayerId, ring: Vec2[]) { if (ring.length >= 3) cuts.push({ layer, ring }); },
      flush() {
        for (const c of cuts) { const host = fills.find((x) => x.layer === c.layer && pointInPoly(c.ring[0]!, x.ring)); if (host) host.holes.push(c.ring); else regions.push(encodeRegion({ layer: c.layer, outline: c.ring, kind: 1 })); }
        for (const x of fills) { const rec = encodeRegion({ layer: x.layer, outline: x.ring, holes: x.holes, net: x.net, component: x.component }); regions.push(x.keep ? keepout(rec) : rec); }
      },
    };
  };
  type FillGroup = ReturnType<typeof fillGroup>;
  /** A piece drawn: lines and arcs, a region (closed copper, a keep-out), a circle. */
  const drawPiece = (pc: Piece, layer: LayerId, map: (p: Pt) => Vec2, scale: number, o: { net?: number; component?: number; filled?: boolean; keep?: boolean; group?: FillGroup } = {}) => {
    const w = Math.max(1, len(pc.width, scale));
    const fill = (ring: Vec2[]) => {
      if (o.group) o.group.fill({ layer, ring, net: o.net, component: o.component, keep: o.keep });
      else if (ring.length >= 3) { const rec = encodeRegion({ layer, outline: ring, net: o.net, component: o.component }); regions.push(o.keep ? keepout(rec) : rec); }
    };
    if (isCircle(pc.type)) {
      const c = circleOf(pc, map);
      if (!c || c.r <= 0) return;
      if (o.filled) fill(ringOfCircle(c.c, c.r));
      else arcs.push(encodeArc({ layer, c: c.c, r: c.r, start: 0, end: 360, width: w, net: o.net, component: o.component }));
      return;
    }
    if (o.filled) { fill(ringOf(pc, map)); return; }
    const vs = vertices(pc, map);
    if (/CLOSED|CLS$/.test(pc.type) && vs.length > 2) { const l = vs[vs.length - 1]!, f0 = vs[0]!; if (l.p.x !== f0.p.x || l.p.y !== f0.p.y) vs.push({ p: f0.p }); }
    for (let i = 0; i + 1 < vs.length; i++) {
      const v = vs[i]!, n = vs[i + 1]!;
      if (v.arc) arcs.push(encodeArc({ layer, c: v.arc.c, r: v.arc.r, start: v.arc.sa, end: v.arc.ea, width: w, net: o.net, component: o.component }));
      else if (v.p.x !== n.p.x || v.p.y !== n.p.y) tracks.push(encodeTrack({ layer, a: v.p, b: n.p, width: w, net: o.net, component: o.component }));
    }
    const last = vs[vs.length - 1];
    if (last?.arc) arcs.push(encodeArc({ layer, c: last.arc.c, r: last.arc.r, start: last.arc.sa, end: last.arc.ea, width: w, net: o.net, component: o.component }));
  };
  /**
   * A text as AD's: its anchor moved to AD's (the start of its baseline) by PADS's justification
   * (DOWN: the anchor under the text, UP: over it) [est: PADS's default labels, Ref.Des. DOWN
   * over Part Type UP at a decal's origin]. Mirrored text reads the other way from its anchor.
   */
  const drawText = (t: PadsText, layer: LayerId, at: Vec2, rot: number, mirrored: boolean, scale: number, content: string, o: { component?: number; isDesignator?: boolean; isComment?: boolean } = {}) => {
    if (!content.trim()) return;
    const H = Math.max(mil(5), Math.round(len(t.height, scale) * PADS_TEXT_SCALE));
    const w = strokeTextWidth(content, H);
    const hx = t.hjust === 'RIGHT' ? -w : t.hjust === 'CENTER' ? -w / 2 : 0;
    const vy = t.vjust === 'UP' ? -H : t.vjust === 'CENTER' ? -H / 2 : 0;
    const r = rad(rot), ox = mirrored ? -hx : hx;
    texts.push(encodeText({ layer, at: { x: Math.round(at.x + ox * Math.cos(r) - vy * Math.sin(r)), y: Math.round(at.y + ox * Math.sin(r) + vy * Math.cos(r)) }, height: H,
      strokeWidth: Math.max(1, len(t.width, scale)), text: content, rotation: norm(rot), mirrored, ...o }));
  };

  /* Parts */
  let nPads = 0;
  const maskOf = (n: number): 'solder' | 'paste' | null => { if (n >= -2 && n <= N) return null; const l = layerOf(n); return l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER ? 'solder' : l === L.TOP_PASTE || l === L.BOTTOM_PASTE ? 'paste' : null; };
  b.parts.forEach((part) => {
    const pt = b.partTypes.get(part.type);
    const decalName = part.decal ?? pt?.decals[Math.max(0, Math.min(part.alt, (pt?.decals.length ?? 1) - 1))] ?? part.type;
    const d = b.decals.get(decalName) ?? b.decals.get(part.type);
    if (!d) { warnings.push(`${part.ref}: its decal ${decalName} isn't in the file`); return; }
    const ci = comps.length;
    const k = decalFactor(d);
    const bottom = part.bottom;
    const rp = rad(part.ori), c = Math.cos(rp), s = Math.sin(rp);
    // The decal's frame → the board's: turned by the part's angle, mirrored left to right on the bottom
    const frame = (scale: number) => (p: Pt): Vec2 => {
      const x = (p.x * scale) / f, y = (p.y * scale) / f;
      let qx = x * c - y * s;
      const qy = x * s + y * c;
      if (bottom) qx = -qx;
      return P({ x: part.x + qx, y: part.y + qy });
    };
    const map = frame(k);
    const adRot = norm(bottom ? 180 - part.ori : part.ori);
    const angle = (a: number) => norm(bottom ? adRot - a : adRot + a);
    const textRot = (a: number) => norm(bottom ? -part.ori - a : part.ori + a);
    const side = (l: LayerId) => (bottom ? FLIP[l] ?? l : l);
    // Outlines on a copper level are the silkscreen's (as PADS makes it)
    const drawLayer = (n: number): LayerId | null => { const l = n === 0 || n === 1 ? L.TOP_OVERLAY : n === N ? L.BOTTOM_OVERLAY : layerOf(n); return l === null ? null : side(l); };
    const value = attrOf(part, 'Value') ?? part.type;
    const pos = P(part);
    comps.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: decalName, SOURCEDESIGNATOR: part.ref, SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`, FOOTPRINTDESCRIPTION: '',
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(adRot), HEIGHT: '0mil', NAMEON: 'TRUE', COMMENTON: 'FALSE', LOCKED: 'FALSE',
      SOURCELIBREFERENCE: part.type, SOURCEDESCRIPTION: attrOf(part, 'Description') ?? '',
    }));
    const pinName = (i: number): string => pt?.pinNames[i - 1] ?? d.terms[i - 1]?.name ?? String(i);
    const netOfPin = (nm: string): number | undefined => pinNet.get(`${part.ref}.${nm}`) ?? netOf(pt?.sigPins.find((sp) => sp.pin === nm)?.net);
    // Graphics and copper
    const group = fillGroup();
    for (const pc of d.pieces) {
      if (pc.type === 'TAG') continue;
      const cop = pc.type.startsWith('COP'), kpt = pc.type.startsWith('KPT');
      let l: LayerId | null;
      if (cop) { const x = pc.level === 0 ? L.TOP : layerOf(pc.level); l = x === null ? null : side(x); }
      else if (kpt) { const x = pc.level === 0 ? L.KEEPOUT : layerOf(pc.level); l = x === null ? null : side(x); }
      else l = drawLayer(pc.level);
      if (l === null) continue;
      const net = cop && pc.pinnum !== undefined && pc.pinnum >= 0 ? netOfPin(pinName(pc.pinnum + 1)) : undefined;
      if (/CUT$|CCO$/.test(pc.type)) { group.cut(l, ringOf(pc, map)); continue; }
      drawPiece(pc, l, map, k, { component: ci, net, filled: (cop && /CLS$|CIR$/.test(pc.type)) || kpt, keep: kpt && l !== L.KEEPOUT, group });
    }
    group.flush();
    // Pads
    d.terms.forEach((term, ti) => {
      const rows = d.stacks.get(ti + 1) ?? d.stacks.get(0);
      if (!rows) return;
      const cu = rows.filter((r) => !THERMAL.test(r.shape) && r.level >= -2 && r.level <= N);
      const row = (lv: number, n: number) => cu.find((r) => r.level === lv) ?? cu.find((r) => r.level === n);
      const top = row(-2, 1), inner = cu.find((r) => r.level === -1), bot = row(0, N);
      const drill = Math.max(0, ...rows.map((r) => r.drill));
      const thru = drill > 0;
      const has = (r: StackLine | undefined) => !!r && r.size > 0;
      const main = (has(top) ? top : has(bot) ? bot : has(inner) ? inner : cu.find((r) => r.level > 1 && r.level < N && r.size > 0) ?? top ?? bot ?? rows[0])!;
      const smdBottom = !thru && !has(top) && has(bot);
      const nm = pinName(ti + 1);
      const finger = (r: StackLine) => r.shape === 'OF' || r.shape === 'RF' || r.shape === 'RC';
      const geom = (r: StackLine) => {
        let w = len(finger(r) ? r.length : r.size, k);
        const hh = len(r.size, k);
        if (w <= 0) w = hh;
        const shape: PadFields['shape'] = r.shape === 'S' || r.shape === 'RF' || r.shape === 'RC' ? (r.corner > 0 ? 'roundrect' : r.corner < 0 ? 'octagon' : 'rect') : 'round';
        return { w: Math.max(1, w), h: Math.max(1, hh), shape, cornerPct: r.corner > 0 ? Math.min(100, (r.corner / (Math.min(r.size, finger(r) ? r.length : r.size) / 2)) * 100) : undefined };
      };
      // A finger's offset: along its turn from the terminal
      const fo = rad(main.ori);
      const centre = finger(main) && main.offset ? { x: term.x + Math.cos(fo) * main.offset, y: term.y + Math.sin(fo) * main.offset } : { x: term.x, y: term.y };
      // A pad on an inner layer only (an embedded part's): that layer (a bottom part's levels the other way up)
      const onlyInner = !thru && !has(top) && !has(bot) ? cu.find((r) => r.level > 1 && r.level < N && r.size > 0) : undefined;
      const layer: LayerId = thru ? L.MULTI : onlyInner ? layerOf(bottom ? N + 1 - onlyInner.level : onlyInner.level) ?? L.TOP : smdBottom !== bottom ? L.BOTTOM : L.TOP;
      const slot = thru && main.slotLen > drill ? { length: len(main.slotLen, k), rotation: norm(main.slotOri - (finger(main) ? main.ori : 0)) } : undefined;
      // A through-hole pad's sizes on the board's top, inner layers and bottom (a mirrored part's the other way up)
      const sized = (r: StackLine | undefined) => (r && r.size > 0 ? geom(r) : undefined);
      const g = geom(main);
      const topG = thru ? sized(bottom ? bot : top) ?? g : g, botG0 = thru ? sized(bottom ? top : bot) : undefined, midG0 = thru ? sized(inner) : undefined;
      const same = (x?: { w: number; h: number; shape: string }) => !x || (x.w === topG.w && x.h === topG.h && x.shape === topG.shape);
      const midG = same(midG0) ? undefined : midG0, botG = same(botG0) ? undefined : botG0;
      // Mask and paste rows: their sizes less the pad's
      const exp = (kind: 'solder' | 'paste') => { const r = rows.find((x) => maskOf(x.level) === kind); return r ? Math.round((len(r.size, k) - topG.h) / 2) : undefined; };
      pads.push(encodePad({ name: nm, layer, at: map(centre), ...topG, hole: thru ? len(drill, k) : undefined, rotation: angle(finger(main) ? main.ori : 0),
        net: netOfPin(nm), component: ci, slot, plated: thru ? rows.every((x) => x.plated) : undefined,
        ...(midG || botG ? { mid: midG ?? topG, bot: botG ?? topG } : {}), solderExpansion: exp('solder'), pasteExpansion: thru ? undefined : exp('paste') }));
      nPads++;
    });
    // Designator and comment where the part's labels put them (else the decal's)
    const fromPart = part.labels.length > 0;
    const labels = fromPart ? part.labels : d.labels;
    const placeLabel = frame(fromPart ? f : k);
    let gotRef = false, gotVal = false;
    for (const lb of labels) {
      const key = lb.text.trim().toUpperCase().replace(/\s+/g, ' ');
      const isRef = key === 'REF.DES.' || key === 'REF-DES' || key === 'REFDES', isType = key === 'PART TYPE' || key === 'PART-TYPE', isVal = key === 'VALUE';
      const l0 = lb.level === 0 || lb.level === 1 ? L.TOP_OVERLAY : layerOf(lb.level) ?? L.TOP_OVERLAY;
      const l = side(l0);
      const at = placeLabel(lb), rot = textRot(lb.ori), mir = bottom !== lb.mirrored;
      if (isRef && !gotRef) {
        drawText(lb, l, at, rot, mir, fromPart ? f : k, part.ref, { component: ci, isDesignator: true });
        gotRef = true;
        if (!lb.visible) comps[ci]!.set('NAMEON', 'FALSE');
      } else if ((isVal || isType) && !gotVal) {
        drawText(lb, l, at, rot, mir, fromPart ? f : k, value, { component: ci, isComment: true });
        gotVal = true;
        // Shown when its label is on a silkscreen (PADS's labels on the copper levels are for the screen)
        comps[ci]!.set('COMMENTON', lb.visible && def(lb.level)?.type === 'SILK_SCREEN' ? 'TRUE' : 'FALSE');
      } else if (!isRef && !isVal && !isType && lb.visible) {
        const v = attrOf(part, lb.text.trim());
        if (v) drawText(lb, l, at, rot, mir, fromPart ? f : k, v, { component: ci });
      }
    }
    const silk = bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    if (!gotRef) { texts.push(encodeText({ layer: silk, at: pos, height: mil(40), text: part.ref, component: ci, isDesignator: true, mirrored: bottom })); comps[ci]!.set('NAMEON', 'FALSE'); }
    if (!gotVal) texts.push(encodeText({ layer: silk, at: pos, height: mil(40), text: value, component: ci, isComment: true, mirrored: bottom }));
    for (const t of d.texts) {
      const l0 = t.level === 0 || t.level === 1 ? L.TOP_OVERLAY : layerOf(t.level);
      if (l0 === null) continue;
      drawText(t, side(l0), map(t), textRot(t.ori), bottom !== t.mirrored, k, t.text, { component: ci });
    }
  });

  /* Routes (a junction's shared stretch comes once for each pin past it: written once) */
  let nVias = 0;
  const seenCopper = new Set<string>();
  const once = (key: string) => (seenCopper.has(key) ? false : (seenCopper.add(key), true));
  const segKey = (layer: number, a: Vec2, b: Vec2, w: number) => { const [p, q] = a.x < b.x || (a.x === b.x && a.y <= b.y) ? [a, b] : [b, a]; return `${layer}:${p.x},${p.y}:${q.x},${q.y}:${w}`; };
  const viaSpan = (v: PadsVia | undefined): [number, number] => {
    if (v && v.start > 0 && v.end > 0) return [Math.min(v.start, v.end), Math.max(v.start, v.end)];
    const ls = (v?.stack ?? []).filter((r) => r.level >= 1 && r.level <= N && r.size > 0).map((r) => r.level);
    if (ls.length && !(v?.stack ?? []).some((r) => r.level === -2 || r.level === 0)) return [Math.min(...ls), Math.max(...ls)];
    return [1, N];
  };
  // (the routes' copper marked as theirs, for the way back: kept.ts)
  const routeStart = [tracks.length, arcs.length, vias.length];
  for (const r of b.routes) {
    const net = netOf(r.net);
    for (const conn of r.conns) {
      for (let i = 0; i < conn.length; i++) {
        const p = conn[i]!;
        if (p.via && !p.arc && once(`via:${P(p).x},${P(p).y}`)) {
          const v = b.vias.get(p.via);
          const [s0, s1] = viaSpan(v);
          const size = Math.max(0, ...(v?.stack ?? []).filter((x) => !THERMAL.test(x.shape) && x.level >= -2 && x.level <= N).map((x) => x.size));
          vias.push(encodeVia({ at: P(p), diameter: Math.max(len(size), len(v?.drill ?? 0) + 1), hole: len(v?.drill ?? 0), net, layerStart: copperIds[s0 - 1] ?? L.TOP, layerEnd: copperIds[s1 - 1] ?? L.BOTTOM }));
          nVias++;
        }
        const n = conn[i + 1];
        if (!n || p.arc || p.layer <= 0 || p.layer > N) continue;
        const layer = copperIds[p.layer - 1]!;
        const w = Math.max(1, len(p.width));
        if (n.arc && conn[i + 2]) {
          // An arc: from this corner about the next (its centre) to the one after
          const e = conn[i + 2]!, cc = { x: n.x, y: n.y };
          const ra = Math.hypot(p.x - cc.x, p.y - cc.y);
          const a0 = Math.atan2(p.y - cc.y, p.x - cc.x), a1 = Math.atan2(e.y - cc.y, e.x - cc.x);
          let sweep = a1 - a0;
          if (n.arc === 'CCW' && sweep <= 0) sweep += 2 * Math.PI;
          if (n.arc === 'CW' && sweep >= 0) sweep -= 2 * Math.PI;
          const g = arc3(P(p), P({ x: cc.x + ra * Math.cos(a0 + sweep / 2), y: cc.y + ra * Math.sin(a0 + sweep / 2) }), P(e));
          if (g && once(`arc:${layer}:${g.c.x},${g.c.y}:${g.r}:${Math.min(g.start, g.end)},${Math.max(g.start, g.end)}:${w}`)) { arcs.push(encodeArc({ layer, c: g.c, r: g.r, start: g.start, end: g.end, width: w, net })); nTracks++; }
          continue;
        }
        if (n.arc) continue;
        const a = P(p), bb = P(n);
        if ((a.x !== bb.x || a.y !== bb.y) && once(segKey(layer, a, bb, w))) { tracks.push(encodeTrack({ layer, a, b: bb, width: w, net })); nTracks++; }
      }
    }
  }

  for (const rec of [...tracks.slice(routeStart[0]), ...arcs.slice(routeStart[1]), ...vias.slice(routeStart[2])]) tagPads(rec, 'R');

  /* Lines: the board, drafting, copper, keep-outs */
  const outlineLoops: PolyVertex[][] = [];
  const openEdges: PolyVertex[][] = [];
  const near = (a: Vec2, c: Vec2) => Math.abs(a.x - c.x) <= mil(0.1) && Math.abs(a.y - c.y) <= mil(0.1);
  // (each free text, line item and pour's records marked as that object's, for the way back: splice.ts)
  const objAt = () => [tracks.length, arcs.length, texts.length, regions.length];
  const tagObj = (m: number[], key: string) => [tracks, arcs, texts, regions].forEach((arr, i) => { for (let k = m[i]!; k < arr.length; k++) tagPads(arr[k]!, 'I', key); });
  b.lines.forEach((it, li) => {
    const m0 = objAt();
    lineItem(it, li);
    if (it.type !== 'BOARD') tagObj(m0, `L${li}`);
  });
  function lineItem(it: PadsLine, li: number): void {
    // (each piece's own records marked with its place in the item too, L<n>.<k>: written again as that piece)
    const piece = (k: number, draw: () => void) => { const m = objAt(); draw(); if (it.type !== 'BOARD') tagObj(m, `L${li}.${k}`); };
    const map = (p: Pt) => P({ x: it.x + p.x, y: it.y + p.y });
    if (it.type === 'BOARD') {
      for (const pc of it.pieces) {
        if (isCircle(pc.type)) {
          const c = circleOf(pc, map);
          if (c && c.r > 0) outlineLoops.push([{ p: { x: c.c.x + c.r, y: c.c.y }, arc: { c: c.c, r: c.r, sa: 0, ea: 180 } }, { p: { x: c.c.x - c.r, y: c.c.y }, arc: { c: c.c, r: c.r, sa: 180, ea: 360 } }]);
          continue;
        }
        const vs = vertices(pc, map);
        if (vs.length < 2) continue;
        const l = vs[vs.length - 1]!, f0 = vs[0]!;
        const shut = !l.arc && near(l.p, f0.p);
        if (/CLOSED|CLS$/.test(pc.type) || shut) { if (shut) vs.pop(); if (vs.length >= 2) outlineLoops.push(vs); }
        else openEdges.push(vs);
      }
      return;
    }
    if (it.type === 'COPPER' || it.type === 'COPCUT') {
      const net = netOf(it.net || undefined);
      const group = fillGroup();
      for (const pc of it.pieces) {
        const l = pc.level >= 1 && pc.level <= N ? copperIds[pc.level - 1]! : layerOf(pc.level);
        if (l === null) continue;
        if (it.type === 'COPCUT' || /CUT$|CCO$/.test(pc.type)) { group.cut(l, ringOf(pc, map)); continue; }
        piece(it.pieces.indexOf(pc), () => drawPiece(pc, l, map, f, { net, filled: /CLS$|CIR$/.test(pc.type), group }));
      }
      group.flush();
      return;
    }
    if (/KEEPOUT|^RESTRICT/.test(it.type)) {
      for (const pc of it.pieces) {
        const l = pc.level <= 0 ? L.KEEPOUT : layerOf(pc.level) ?? L.KEEPOUT;
        piece(it.pieces.indexOf(pc), () => drawPiece(pc, l, map, f, { keep: l !== L.KEEPOUT, filled: true }));
      }
      return;
    }
    // Drafting on all layers (level 0): Mechanical 1
    const lgroup = fillGroup();
    for (const pc of it.pieces) {
      if (pc.type === 'BASPNT') continue;
      const l = pc.level === 0 ? L.MECH1 : layerOf(pc.level);
      if (l === null) continue;
      if (/CUT$|CCO$/.test(pc.type)) { lgroup.cut(l, ringOf(pc, map)); continue; }
      piece(it.pieces.indexOf(pc), () => drawPiece(pc, l, map, f, { filled: /^COP(CLS|CIR)$/.test(pc.type), group: lgroup }));
    }
    lgroup.flush();
    for (const t of it.texts) { const l = t.level === 0 ? L.MECH1 : layerOf(t.level); if (l !== null) drawText(t, l, map(t), t.ori, t.mirrored, f, t.text); }
  }
  b.texts.forEach((t, ti) => { const m0 = objAt(); const l = t.level === 0 ? L.MECH1 : layerOf(t.level); if (l !== null) drawText(t, l, P(t), t.ori, t.mirrored, f, t.text); tagObj(m0, `T${ti}`); });
  // Open board lines joined end to end into loops (the last vertex of each line is its end, an arc's end its own)
  const endOf = (vs: PolyVertex[]): Vec2 => vs[vs.length - 1]!.p;
  while (openEdges.length) {
    const loop = openEdges.shift()!;
    for (let grew = true; grew && !near(endOf(loop), loop[0]!.p);) {
      grew = false;
      const end = endOf(loop);
      let i = openEdges.findIndex((e) => near(e[0]!.p, end));
      if (i < 0) { i = openEdges.findIndex((e) => near(endOf(e), end) && !e.some((v) => v.arc)); if (i >= 0) openEdges[i]!.reverse(); }
      if (i >= 0) { const e = openEdges.splice(i, 1)[0]!; loop.pop(); loop.push(...e); grew = true; }
    }
    if (near(endOf(loop), loop[0]!.p)) loop.pop();
    if (loop.length >= 3 || (loop.length >= 2 && loop.some((v) => v.arc))) outlineLoops.push(loop);
  }

  /* Pours: outlines as polygon pours, their copper the pours' */
  const pourIndex = new Map<string, number>();
  const ownerPour = new Map<string, PadsPour>();
  const outlines = b.pours.filter((p) => p.type === 'POUROUT');
  const order = [...outlines].sort((a, c) => a.priority - c.priority);
  /** Each pour's own: its outline's, hatch's and thermals' records (the pour's place in the list: P<n>). */
  const pourKey = (po: PadsPour | undefined) => (po ? `P${b.pours.indexOf(po)}` : '');
  for (const po of outlines) {
    const m0 = objAt();
    ownerPour.set(po.name, po);
    const map = (p: Pt) => P({ x: po.x + p.x, y: po.y + p.y });
    const net = netOf(po.net || undefined);
    let index: number | undefined;
    for (const pc of po.pieces) {
      const layer = pc.level >= 1 && pc.level <= N ? copperIds[pc.level - 1]! : null;
      if (layer === null) continue;
      if (/CUT/.test(pc.type)) { const ring = ringOf(pc, map); if (ring.length >= 3) regions.push(encodeRegion({ layer, outline: ring, kind: 1 })); continue; }
      if (index !== undefined) continue;
      let vs: PolyVertex[];
      if (isCircle(pc.type)) { const c = circleOf(pc, map); if (!c) continue; vs = [{ p: { x: c.c.x + c.r, y: c.c.y }, arc: { c: c.c, r: c.r, sa: 0, ea: 180 } }, { p: { x: c.c.x - c.r, y: c.c.y }, arc: { c: c.c, r: c.r, sa: 180, ea: 360 } }]; }
      else {
        vs = vertices(pc, map);
        const l = vs[vs.length - 1], f0 = vs[0];
        if (vs.length > 1 && l && f0 && !l.arc && near(l.p, f0.p)) vs.pop();
      }
      if (vs.length < 2) continue;
      index = polygons.length;
      const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, po.name, index);
      writeVertices(bag, vs);
      bag.set('POURINDEX', String(order.indexOf(po)));
      bag.set('TRACKWIDTH', formatAltiumLength(Math.max(mil(1), len(pc.width))));
      bag.set('PADSPOUR', String(b.pours.indexOf(po)));
      polygons.push(bag);
      pourIndex.set(po.name, index);
    }
    tagObj(m0, pourKey(po));
  }
  // Copper: each hatch outline (a line of its width round the copper) grown by half the width, less its voids shrunk by as much
  const toPath = (pts: Vec2[]) => pts.map((p) => ({ X: p.x, Y: p.y }));
  const grow = (paths: ClipperNS.IntPoint[][], d: number) => { const co = new C.ClipperOffset(2, 250); co.AddPaths(paths, C.JoinType.jtRound, C.EndType.etClosedPolygon); const out: ClipperNS.IntPoint[][] = []; co.Execute(out, d); return out; };
  const hatOwner = new Map<string, string>();
  for (const ho of b.pours) if (ho.type === 'HATOUT') hatOwner.set(ho.name, ho.owner);
  const voids = new Map<string, { layer: number; ring: Vec2[]; w: number }[]>();
  for (const v of b.pours) {
    if (v.type !== 'VOIDOUT') continue;
    const map = (p: Pt) => P({ x: v.x + p.x, y: v.y + p.y });
    for (const pc of v.pieces) { const ring = ringOf(pc, map); if (ring.length >= 3) voids.set(v.owner, [...(voids.get(v.owner) ?? []), { layer: pc.level, ring, w: len(pc.width) }]); }
  }
  for (const ho of b.pours) {
    if (ho.type !== 'HATOUT') continue;
    const m0 = objAt();
    const po = ownerPour.get(ho.owner);
    const owner = pourIndex.get(ho.owner);
    const net = netOf(po?.net || undefined);
    const map = (p: Pt) => P({ x: ho.x + p.x, y: ho.y + p.y });
    for (const pc of ho.pieces) {
      const layer = pc.level >= 1 && pc.level <= N ? copperIds[pc.level - 1]! : null;
      if (layer === null) continue;
      const ring = ringOf(pc, map);
      if (ring.length < 3) continue;
      const subj = grow([toPath(ring)], len(pc.width) / 2);
      const holes = (voids.get(ho.name) ?? []).filter((x) => x.layer === pc.level).flatMap((x) => grow([toPath(x.ring)], -x.w / 2));
      const cl = new C.Clipper();
      cl.AddPaths(subj, C.PolyType.ptSubject, true);
      if (holes.length) cl.AddPaths(holes, C.PolyType.ptClip, true);
      const tree = new C.PolyTree();
      cl.Execute(C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
      const emit = (node: ClipperNS.PolyNode) => {
        for (const outer of node.Childs()) {
          const pts = outer.Contour().map((q) => ({ x: q.X, y: q.Y }));
          if (pts.length >= 3) regions.push(encodeRegion({ layer, outline: pts, holes: outer.Childs().map((hn) => hn.Contour().map((q) => ({ x: q.X, y: q.Y }))).filter((hh) => hh.length >= 3), net, polygon: owner }));
          for (const hn of outer.Childs()) emit(hn);
        }
      };
      emit(tree);
    }
    if (po) tagObj(m0, pourKey(po));
  }
  for (const th of b.pours) {
    if (th.type !== 'PADTHERM' && th.type !== 'VIATHERM') continue;
    const m0 = objAt();
    const po = ownerPour.get(hatOwner.get(th.owner) ?? th.owner);
    const owner = po ? pourIndex.get(po.name) : undefined;
    const net = netOf(po?.net || undefined);
    const map = (p: Pt) => P({ x: th.x + p.x, y: th.y + p.y });
    for (const pc of th.pieces) {
      const layer = pc.level >= 1 && pc.level <= N ? copperIds[pc.level - 1]! : null;
      if (layer === null || pc.corners.length < 2 || pc.width <= 0) continue;
      const a = map(pc.corners[0]!.p), e = map(pc.corners[1]!.p);
      if (a.x === e.x && a.y === e.y) continue;
      tracks.push(encodeTrack({ layer, a, b: e, width: Math.max(1, len(pc.width)), net, polygon: owner }));
    }
    if (po) tagObj(m0, pourKey(po));
  }

  /* The board's shape */
  let outline: PolyVertex[];
  if (outlineLoops.length) {
    const area = (vs: PolyVertex[]) => { const fl = flattenVertices(vs); return Math.abs(fl.reduce((sum, v, i) => { const n = fl[(i + 1) % fl.length]!; return sum + v.x * n.y - n.x * v.y; }, 0)); };
    outlineLoops.sort((a, c) => area(c) - area(a));
    outline = outlineLoops[0]!;
    for (const cut of outlineLoops.slice(1)) regions.push(encodeRegion({ layer: L.MULTI, outline: flattenVertices(cut), boardCutout: true }));
  } else {
    warnings.push('No board outline: the board shape is drawn round the parts');
    const pts = b.parts.map((p) => P(p));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), m = mil(200);
    outline = xs.length ? [{ p: { x: Math.min(...xs) - m, y: Math.min(...ys) - m } }, { p: { x: Math.max(...xs) + m, y: Math.min(...ys) - m } }, { p: { x: Math.max(...xs) + m, y: Math.max(...ys) + m } }, { p: { x: Math.min(...xs) - m, y: Math.max(...ys) + m } }]
      : [{ p: { x: mil(1000), y: mil(1000) } }, { p: { x: mil(3000), y: mil(1000) } }, { p: { x: mil(3000), y: mil(3000) } }, { p: { x: mil(1000), y: mil(3000) } }];
  }
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  // AD's origin at PADS's (its user origin), when that is on the sheet; else the board's corner
  const o = P(b.origin), sheetW = Math.max(...xs) + mil(2000), sheetH = Math.max(...ys) + mil(2000);
  const origin = o.x >= 0 && o.y >= 0 && o.x <= sheetW && o.y <= sheetH ? o : { x: Math.min(...xs), y: Math.min(...ys) };
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin, outline,
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [1, 13, 14, ...mechNames.keys()] });
  for (const [m, nm] of mechNames) board.set(`LAYER${mechLayer(m)}NAME`, nm);

  // Planes' nets
  const planeNets = copperIds.map((id, i) => (id >= L.PLANE1 && id <= L.PLANE16 ? def(i + 1)?.net || undefined : undefined));
  for (const n of planeNets) netOf(n);
  const { rules, classes } = boardRules(padsRules(b, f), nets, nets);

  // (everything else the import made marked as the file's, for the way back: what Konium adds is its own)
  for (const rec of [...pads, ...tracks, ...arcs, ...vias, ...texts, ...regions]) tagPads(rec, 'I');
  board.set('PADSBASE', `${b.units} ${bx} ${by}`);
  if (levelBack.size) board.set('PADSLEVELS', [...levelBack].map(([l, v]) => `${l}:${v}`).join(','));
  const pcb = assemblePcbDoc({ board, nets, comps, polygons, pads, tracks, vias, arcs, texts, regions, rules, classes }, `${name}.PcbDoc`);
  applyStackLayers(pcb, copperIds.map((id, i) => {
    const d = def(i + 1);
    return { name: d?.name || undefined, thickness: d?.copper ? d.copper * f : undefined, plane: id >= L.PLANE1 && id <= L.PLANE16, net: planeNets[i] };
  }), Array.from({ length: Math.max(0, N - 1) }, (_, i) => { const d = def(i + 1); return { thickness: d?.thickness ? d.thickness * f : undefined, er: d?.er || undefined }; }));
  for (const [m, nm] of mechNames) pcb.board.layerNames.set(mechLayer(m), nm);
  // Pours the file keeps no copper for (not flooded, or planes' areas PADS floods for its outputs): poured by the board's rules
  const flooded = new Set(b.pours.filter((p) => p.type === 'HATOUT').map((p) => p.owner));
  const unpoured = order.filter((po) => pourIndex.has(po.name) && !flooded.has(po.name));
  for (const po of unpoured) repour(pcb, pourIndex.get(po.name)!).apply();
  if (unpoured.length) warnings.push(`${unpoured.length} pour${unpoured.length === 1 ? '' : 's'} had no copper in the file (not flooded, or a plane's areas): poured with the board's rules`);
  const footprints = footprintsFromBoard(pcb);
  let bytes = writePcbDoc(pcb);
  // The file as PADS wrote it, for the way back while the board is what this import made (kept.ts)
  if (source) {
    const back = readPcbDoc(bytes, `${name}.PcbDoc`);
    sealPads(back, b);
    keepPadsSource(back, source);
    back.dirty.add('Board6');
    bytes = writePcbDoc(back);
  }
  return { bytes, name, footprints, warnings, stats: { components: comps.length, pads: nPads, vias: nVias, tracks: nTracks, nets: nets.length, layers: N } };
}
