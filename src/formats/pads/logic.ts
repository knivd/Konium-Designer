/**
 * PADS Logic (PowerLogic) ASCII schematics (.txt) as AD's: each sheet a SchDoc, the part types a
 * SchLib (a symbol per part type, a part per gate, drawn as its CAE decal with the gate's pin
 * numbers, names and types; signal pins hidden pins on their nets), parts placed as components
 * (their gate from the letter after the reference, U1-B; turned and mirrored as PADS places them;
 * the designator, comment and attributes where their labels are: the comment is the Comment
 * attribute, else the Value, else the part type; PCB DECAL is the footprint; the part's display
 * flags hide its part type, pin names and pin numbers), the signals' wires as wires (wire ends
 * meeting at tie dots, joined as AD joins them), power and ground symbols power ports, off-page
 * references off sheet connectors, a net's name a net label on each group of its wires nothing
 * else names (PADS's nets join by name across sheets: the project's Net Identifier Scope is
 * Global), free text and lines, buses.
 *
 * PADS Logic's mils (Y up from the sheet's corner) are AD's 10 mil units. PADS's justification
 * is bits: 1 right, 4 centre (else left); 2 top, 8 middle (else bottom) [est: its pin decals'
 * number and name labels, its parts' labels round their bodies].
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords } from '../altium/framing';
import { binToBytes } from '../text';
import { writeSchLib } from '../altium/schlib';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { COL, Fonts, Records, arcThrough, justification, lengthKeys, orientOf, radius, type Props } from '../kicad/schematic';
import { padsHeader } from './ascii';
import { readSchDoc, writeSchDoc } from '../altium/schdoc';
import { keepPadsLogic } from './kept';

type Pt = { x: number; y: number };
export interface LPoint extends Pt { arc?: { c: Pt; r: number; a0: number; sweep: number } }
export interface LPiece { type: string; width: number; pts: LPoint[] }
export interface LText { x: number; y: number; angle: number; just: number; height: number; width: number; flags: number; text: string }
export interface LPin { x: number; y: number; angle: number; side: number; decal: string; flags: number }
export interface LDecal { name: string; attrs: LText[]; pieces: LPiece[]; texts: LText[]; pins: LPin[]; pinDecal: boolean }
export interface LGate { decals: string[]; pins: { num: string; type: string; name: string }[] }
export interface LPartType { name: string; category: string; gates: LGate[]; sigPins: { pin: string; net: string }[]; variants: { decal: string; type: string; net: string }[] }
/** `flags` (the part line's last field) [est]: 2 the part type's label hidden, 8 the pin names, 16 the pin numbers. */
export interface LPart { ref: string; type: string; x: number; y: number; angle: number; mirror: number; variant: number; flags: number; attrs: LText[]; values: Map<string, string>; power?: string }
export interface LWire { a: string; b: string; pts: Pt[] }
export interface LOpc { id: string; net: string; type: string; x: number; y: number; angle: number; mirror: number; variant: number }
export interface LSheet {
  num: number; name: string; texts: LText[]; lines: { x: number; y: number; pieces: LPiece[]; texts: LText[] }[]; parts: LPart[];
  signals: { name: string; wires: LWire[] }[]; opcs: LOpc[]; dots: Map<string, Pt>; buses: { name: string; pts: Pt[] }[];
}
export interface LogicDesign { version: string; sheetSize: string; job: string; decals: Map<string, LDecal>; partTypes: Map<string, LPartType>; sheets: LSheet[] }

export const isPadsLogic = (head: string): boolean => /^\*PADS-(POWER)?LOGIC/i.test(head.trimStart());

const isNum = (s: string | undefined) => s !== undefined && /^[-+]?\d+(\.\d+)?$/.test(s);
const num = (s: string | undefined, d = 0) => { const v = Number(s); return s !== undefined && Number.isFinite(v) ? v : d; };
const toks = (l: string) => l.trim().split(/\s+/).filter(Boolean);
/** A quoted name and what follows it: "Value" 10K → ['Value', '10K']. */
const quoted = (l: string): [string, string] | null => { const m = /^"([^"]*)"\s*(.*)$/.exec(l.trim()); return m ? [m[1]!, m[2]!] : null; };
const SECTION = /^\*([A-Z][A-Z ]*?)\*/;

class Cursor {
  i = 0;
  constructor(readonly ls: string[]) {}
  get done() { return this.i >= this.ls.length; }
  /** At the next section (or the end). */
  get atEnd() { if (this.done) return true; const l = this.ls[this.i]!; const m = SECTION.exec(l); return !!m && m[1] !== 'SIGNAL' && m[1] !== 'REMARK'; }
  peek() { return this.atEnd ? '' : this.ls[this.i]!; }
  next() { return this.atEnd ? '' : this.ls[this.i++]!; }
  /** The next line that isn't blank (or '' at the section's end). */
  nextData() { while (!this.atEnd && !this.ls[this.i]!.trim()) this.i++; return this.next(); }
  skipBlank() { while (!this.atEnd && !this.ls[this.i]!.trim()) this.i++; }
}

/** A text's (or label's) attribute line: X Y ANGLE JUST HEIGHT WIDTH [FLAGS] ["FONT"]. */
function textHead(l: string): Omit<LText, 'text'> {
  const t = toks(l.replace(/"[^"]*"/g, ''));
  return { x: num(t[0]), y: num(t[1]), angle: num(t[2]), just: num(t[3]), height: num(t[4], 100), width: num(t[5], 10), flags: num(t[6]) };
}

/** A piece: TYPE CORNERS WIDTH STYLE, then its corners (an arc's: X Y AB AA X1 Y1 X2 Y2, angles in tenths). */
function readPiece(cur: Cursor): LPiece | null {
  const t = toks(cur.nextData());
  if (!t.length || isNum(t[0])) return null;
  const piece: LPiece = { type: t[0]!.toUpperCase(), width: num(t[2], 10), pts: [] };
  for (let k = 0, n = num(t[1]); k < n && !cur.atEnd; k++) {
    const p = toks(cur.next());
    if (p.length < 2) { k--; if (!cur.peek().trim() && cur.atEnd) break; continue; }
    const pt: LPoint = { x: num(p[0]), y: num(p[1]) };
    if (p.length >= 8) { const x1 = num(p[4]), y1 = num(p[5]), x2 = num(p[6]), y2 = num(p[7]); pt.arc = { c: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, r: Math.abs(x2 - x1) / 2, a0: num(p[2]) / 10, sweep: num(p[3]) / 10 }; }
    piece.pts.push(pt);
  }
  return piece;
}

export function parsePadsLogic(text: string): LogicDesign {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const h = padsHeader(lines[0] ?? '');
  const d: LogicDesign = { version: h?.version ?? '', sheetSize: 'B', job: '', decals: new Map(), partTypes: new Map(), sheets: [] };
  const cur = new Cursor(lines.filter((l) => !l.startsWith('*REMARK*')));
  cur.i = 1;
  let sheet: LSheet | null = null;
  const sheetOf = (): LSheet => { if (!sheet) { sheet = { num: 1, name: 'Sheet1', texts: [], lines: [], parts: [], signals: [], opcs: [], dots: new Map(), buses: [] }; d.sheets.push(sheet); } return sheet; };
  while (!cur.done) {
    const head = cur.ls[cur.i++]!;
    const m = SECTION.exec(head);
    if (!m) continue;
    const sec = m[1]!;
    if (sec === 'END') break;
    switch (sec) {
      case 'SCH':
        while (!cur.atEnd) {
          const l = cur.next().trim();
          const sm = /^SHEET SIZE\s+(\S+)/.exec(l);
          if (sm) d.sheetSize = sm[1]!;
          const jm = /^JOBNAME\s+"?([^"]*)"?/.exec(l);
          if (jm) d.job = jm[1]!.trim();
        }
        break;
      case 'SHT': {
        const t = toks(head.slice(m[0].length));
        sheet = { num: num(t[0], d.sheets.length + 1), name: t[1] && t[1] !== '$$$NONE' ? t[1].replace(/^"|"$/g, '') : `Sheet${num(t[0], d.sheets.length + 1)}`, texts: [], lines: [], parts: [], signals: [], opcs: [], dots: new Map(), buses: [] };
        d.sheets.push(sheet);
        break;
      }
      case 'TEXT':
        while (!cur.atEnd) {
          const l = cur.nextData();
          if (!l) break;
          sheetOf().texts.push({ ...textHead(l), text: cur.next() });
        }
        break;
      case 'LINES':
        while (!cur.atEnd) {
          const t = toks(cur.nextData());
          if (t.length < 4 || t[1] !== 'LINES') continue;
          const item = { x: num(t[2]), y: num(t[3]), pieces: [] as LPiece[], texts: [] as LText[] };
          for (let k = 0, n = num(t[4]); k < n && !cur.atEnd; k++) { const p = readPiece(cur); if (p) item.pieces.push(p); }
          for (let k = 0, n = num(t[5]); k < n && !cur.atEnd; k++) { const l = cur.nextData(); if (!l) break; item.texts.push({ ...textHead(l), text: cur.next() }); }
          sheetOf().lines.push(item);
        }
        break;
      case 'CAEDECAL':
        while (!cur.atEnd) {
          const t = toks(cur.nextData());
          if (t.length < 13) continue;
          const dec: LDecal = { name: t[0]!, attrs: [], pieces: [], texts: [], pins: [], pinDecal: num(t[12]) === 1 };
          const [nattrs, npieces, , npins] = [num(t[7]), num(t[8]), num(t[9]), num(t[10])];
          if (cur.peek().trim().startsWith('TIMESTAMP')) cur.next();
          for (let k = 0; k < 2 && cur.peek().trim().startsWith('"'); k++) cur.next();
          for (let k = 0; k < nattrs && !cur.atEnd; k++) { const l = cur.nextData(); dec.attrs.push({ ...textHead(l), text: cur.next().trim() }); }
          for (let k = 0; k < npieces && !cur.atEnd; k++) { const p = readPiece(cur); if (p) dec.pieces.push(p); }
          // Its own texts (until the pins or the entry's end)
          while (!cur.atEnd) {
            const l = cur.peek();
            if (!l.trim() || /^T-?\d/.test(l.trim())) break;
            cur.next();
            dec.texts.push({ ...textHead(l), text: cur.next() });
          }
          for (let k = 0; k < npins && !cur.atEnd; k++) {
            const tl = cur.nextData().trim();
            if (!tl.startsWith('T')) break;
            const tt = toks(tl.slice(1));
            const pin: LPin = { x: num(tt[0]), y: num(tt[1]), angle: num(tt[2]), side: num(tt[3]), decal: tt[12] ?? '', flags: 0 };
            if (cur.peek().trim().startsWith('P')) pin.flags = num(toks(cur.next().trim().slice(1))[8]);
            dec.pins.push(pin);
          }
          d.decals.set(dec.name, dec);
        }
        break;
      case 'PARTTYPE':
        while (!cur.atEnd) {
          const t = toks(cur.nextData());
          if (t.length < 2) continue;
          const pt: LPartType = { name: t[0]!, category: t[1]!, gates: [], sigPins: [], variants: [] };
          if (cur.peek().trim().startsWith('TIMESTAMP')) cur.next();
          while (!cur.atEnd && cur.peek().trim()) {
            const g = toks(cur.next());
            const kw = g[0] ?? '';
            if (kw === 'GATE' || kw === 'CONN') {
              const gate: LGate = { decals: [], pins: [] };
              for (let k = 0, n = num(g[1]); k < n && !cur.atEnd && cur.peek().trim(); k++) gate.decals.push(toks(cur.next())[0]!);
              for (let k = 0, n = num(g[2]); k < n && !cur.atEnd && cur.peek().trim(); k++) { const p = toks(cur.next()); gate.pins.push({ num: p[0] ?? String(k + 1), type: (p[2] ?? 'U')[0]!, name: p[3] ?? '' }); }
              pt.gates.push(gate);
            } else if (kw.startsWith('G:')) {
              // Older files: G:decal[:decal…] swap pins, then pins num.swap.type.name packed on lines
              const gate: LGate = { decals: kw.slice(2).split(':').filter(Boolean), pins: [] };
              const n = num(g[2]);
              while (gate.pins.length < n && !cur.atEnd && cur.peek().trim() && !/^(G:|SIGPIN)/.test(cur.peek().trim())) {
                for (const tok of toks(cur.next())) { const f = tok.split('.'); if (gate.pins.length < n) gate.pins.push({ num: f[0] ?? '', type: (f[2] ?? 'U')[0] ?? 'U', name: f[3] ?? '' }); }
              }
              if (/^\$/.test(pt.name)) pt.variants.push({ decal: gate.decals[0] ?? '', type: gate.pins[0]?.type ?? '', net: gate.decals[0] ?? '' });
              pt.gates.push(gate);
            } else if (kw === 'SIGPIN') {
              const f = (g[1] ?? '').split('.');
              pt.sigPins.push(f.length >= 3 ? { pin: f[0]!, net: f[f.length - 1]! } : { pin: g[1] ?? '', net: g[2] ?? g[3] ?? '' });
            } else if (/^\$/.test(pt.name) && isNum(g[1])) {
              // Power, ground and off-page symbols: their variants (decal, pin type, net)
              for (let k = 0, n = num(g[1]); k < n && !cur.atEnd && cur.peek().trim(); k++) { const v = toks(cur.next()); pt.variants.push({ decal: v[0] ?? '', type: v[1] ?? '', net: v[2] ?? v[0] ?? '' }); }
            }
          }
          d.partTypes.set(pt.name, pt);
        }
        break;
      case 'PART':
        while (!cur.atEnd) {
          const l = cur.nextData();
          if (!l || !/^[A-Za-z_$#@]/.test(l.trim())) continue;
          const t = toks(l);
          if (t.length < 5) continue;
          const part: LPart = { ref: t[0]!, type: t[1]!, x: 0, y: 0, angle: 0, mirror: 0, variant: 0, flags: 0, attrs: [], values: new Map() };
          let nattrs = 0, ndisp = 0;
          if (!isNum(t[2])) {
            // A power or ground symbol: REF NET $TYPE X Y ANGLE MIRROR VARIANT
            part.power = t[1]; part.type = t[2]!; part.x = num(t[3]); part.y = num(t[4]); part.angle = num(t[5]); part.mirror = num(t[6]); part.variant = num(t[7]);
          } else {
            part.x = num(t[2]); part.y = num(t[3]); part.angle = num(t[4]); part.mirror = num(t[5]);
            nattrs = num(t[10]); ndisp = num(t[11]); part.variant = num(t[14]); part.flags = num(t[15]);
          }
          if (nattrs || ndisp) {
            for (let k = 0; k < 2 && cur.peek().trim().startsWith('"') && !/^"[^"]*"\s+\S/.test(cur.peek().trim()) && cur.peek().trim().split('"').length <= 3; k++) cur.next();
            for (let k = 0; k < nattrs && !cur.atEnd; k++) { const al = cur.nextData(); part.attrs.push({ ...textHead(al), text: cur.next().trim() }); }
            for (let k = 0; k < ndisp && !cur.atEnd; k++) { const q = quoted(cur.nextData()); if (q) part.values.set(q[0], q[1]); }
            // Pin overrides to the entry's end
            while (!cur.atEnd && cur.peek().trim() && /^-?\d/.test(cur.peek().trim())) cur.next();
          }
          sheetOf().parts.push(part);
        }
        break;
      case 'OFFPAGE REFS':
        while (!cur.atEnd) {
          const t = toks(cur.nextData());
          if (t.length < 5 || !t[0]!.startsWith('@@@')) continue;
          sheetOf().opcs.push({ id: t[0]!, net: t[1]!, type: t[2]!, x: num(t[3]), y: num(t[4]), angle: num(t[5]), mirror: num(t[6]), variant: num(t[7]) });
        }
        break;
      case 'TIEDOTS':
        while (!cur.atEnd) { const t = toks(cur.nextData()); if (t.length >= 3 && t[0]!.startsWith('@@@')) sheetOf().dots.set(t[0]!, { x: num(t[1]), y: num(t[2]) }); }
        break;
      case 'BUSSES':
        while (!cur.atEnd) {
          const t = toks(cur.nextData());
          if (t.length < 3 || !t[0]!.startsWith('@@@B')) continue;
          const bus = { name: t[1]!, pts: [] as Pt[] };
          for (let k = 0, n = num(t[2]); k < n && !cur.atEnd; k++) { const p = toks(cur.nextData()); if (p.length >= 2) bus.pts.push({ x: num(p[0]), y: num(p[1]) }); }
          sheetOf().buses.push(bus);
        }
        break;
      case 'CONNECTION': {
        let sig: { name: string; wires: LWire[] } | null = null;
        while (!cur.atEnd) {
          const l = cur.nextData();
          if (!l) break;
          const t = toks(l);
          if (t[0] === '*SIGNAL*') { sig = { name: t[1] ?? '', wires: [] }; sheetOf().signals.push(sig); continue; }
          if (!sig || t.length < 3 || isNum(t[0])) continue;
          const w: LWire = { a: t[0]!, b: t[1]!, pts: [] };
          for (let k = 0, n = num(t[2]); k < n && !cur.atEnd; k++) { const p = toks(cur.nextData()); if (p.length >= 2 && isNum(p[0])) w.pts.push({ x: num(p[0]), y: num(p[1]) }); }
          sig.wires.push(w);
        }
        break;
      }
      default:
        // *MISC*, *CAM*, *FIELDS*, *CAE*, *SHEETS*, *NETNAMES*: their contents (braced or not) passed over
        while (!cur.atEnd) cur.next();
    }
  }
  if (!d.sheets.length) d.sheets.push({ num: 1, name: 'Sheet1', texts: [], lines: [], parts: [], signals: [], opcs: [], dots: new Map(), buses: [] });
  return d;
}

/* ── to AD ── */

const U = (mils: number) => mils / 10;
const ELECTRICAL: Record<string, number> = { L: 0, I: 0, B: 1, S: 2, O: 2, C: 3, T: 5, Z: 4, P: 7, G: 7, U: 4 };
/** PADS's sheet sizes (mils): the paper, which AD's sheet styles are smaller than, so a custom sheet. */
const SHEET_SIZE: Record<string, [number, number]> = {
  A: [11000, 8500], B: [17000, 11000], C: [22000, 17000], D: [34000, 22000], E: [44000, 34000],
  A4: [11690, 8270], A3: [16540, 11690], A2: [23390, 16540], A1: [33110, 23390], A0: [46810, 33110],
};
/** PADS's justification bits as AD's. */
const just = (j: number) => justification(j & 1 ? 2 : j & 4 ? 1 : 0, j & 2 ? 2 : j & 8 ? 1 : 0);
/** PADS's text height (mils) as Konium's font size argument (mm: 10 pt is 1.27 mm): 100 mil, 10 pt [est]. */
const fontMm = (h: number) => (Math.max(40, h) / 10) * 0.127;
const lineWidth = (w: number) => (w > 20 ? 2 : 1);

/** A part's placement: turned anticlockwise, then mirrored (1: left to right, 2: top to bottom) [est: KiCad's reader]. */
function placement(x: number, y: number, angle: number, mirror: number) {
  const a = ((Math.round(angle / 90) % 4) + 4) % 4;
  const c = [1, 0, -1, 0][a]!, s = [0, 1, 0, -1][a]!;
  const mx = mirror & 1 ? -1 : 1, my = mirror & 2 ? -1 : 1;
  const local = (p: Pt): Pt => ({ x: mx * (p.x * c - p.y * s), y: my * (p.x * s + p.y * c) });
  const place = (p: Pt): Pt => { const q = local(p); return { x: U(x + q.x), y: U(y + q.y) }; };
  // AD's: turned by ORIENTATION after a left-to-right mirror (R(o)·Mx^m)
  const mirrored = (mx * my) < 0;
  const ux = local({ x: 1, y: 0 });
  const xm = mirrored ? { x: -ux.x, y: -ux.y } : ux;   // where AD's R(o) takes (1, 0): R(o)·Mx·(−1, 0) for a mirrored one
  const orient = orientOf({ x: 0, y: 0 }, xm);
  return { place, local, orient, mirrored, flip: mirrored };
}

export interface LogicResult { sheets: { name: string; bytes: Uint8Array }[]; library: Uint8Array; symbols: number; warnings: string[]; stats: { sheets: number; parts: number; nets: number; symbols: number } }

export function convertPadsLogic(text: string, fileName: string, footprintLib = 'Footprints.PcbLib', source?: Uint8Array): LogicResult {
  const d = parsePadsLogic(text);
  const warnings: string[] = [];
  const stem = fileName.replace(/\.[^.]+$/, '');

  /* Pin decals: their lengths and look */
  const pinLength = new Map<string, number>();
  for (const dec of d.decals.values()) {
    if (!dec.pinDecal) continue;
    // As far as its lines along its axis and its bubble reach (a clock's wedge isn't the pin)
    let ext = 0;
    for (const pc of dec.pieces) {
      if (pc.type === 'CIRCLE') { for (const p of pc.pts) ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y)); continue; }
      for (let i = 1; i < pc.pts.length; i++) {
        const a = pc.pts[i - 1]!, b = pc.pts[i]!;
        if (Math.abs(a.y) <= 1 && Math.abs(b.y) <= 1) ext = Math.max(ext, Math.abs(a.x), Math.abs(b.x));
        if (Math.abs(a.x) <= 1 && Math.abs(b.x) <= 1) ext = Math.max(ext, Math.abs(a.y), Math.abs(b.y));
      }
    }
    if (ext % 50 && ext % 50 >= 30) ext += 50 - (ext % 50);
    pinLength.set(dec.name, ext || 200);
  }
  const pinShape = (decal: string): Props => {
    const n = decal.toUpperCase();
    const inv = /B$/.test(n) && n !== 'PIN', clk = /CLK/.test(n);
    return { ...(inv ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(clk ? { SYMBOL_INNEREDGE: 3 } : {}) };
  };
  /** Which way a pin runs from its end into the body [est: KiCad's reader]. */
  const pinDir = (p: LPin): Pt => {
    const a = ((Math.round(p.angle) % 360) + 360) % 360;
    if (/VRT/i.test(p.decal)) return p.side === 2 ? { x: 0, y: 1 } : { x: 0, y: -1 };
    if (a >= 45 && a < 135) return p.side >= 2 ? { x: 0, y: -1 } : { x: 0, y: 1 };
    if (a >= 225 && a < 315) return p.side >= 2 ? { x: 0, y: 1 } : { x: 0, y: -1 };
    if (a >= 135 && a < 225) return p.side & 1 ? { x: 1, y: 0 } : { x: -1, y: 0 };
    return p.side & 1 ? { x: -1, y: 0 } : { x: 1, y: 0 };
  };

  /** A decal's graphics and pins as records, placed by `pl`; `own` their owner. */
  const emitDecal = (r: Records, fonts: Fonts, dec: LDecal, pins: LGate['pins'], pl: ReturnType<typeof placement>, own: Props, sigPins: LPartType['sigPins'] = [], show = { names: true, numbers: true }) => {
    const P = pl.place;
    for (const pc of dec.pieces) {
      const lw = lineWidth(pc.width);
      if (pc.type === 'CIRCLE' && pc.pts.length >= 2) {
        const a = P(pc.pts[0]!), b = P(pc.pts[1]!), rr = Math.hypot(b.x - a.x, b.y - a.y) / 2;
        r.add({ RECORD: SR.ELLIPSE, ...own, LINEWIDTH: lw, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false, TRANSPARENT: true, ...radius('RADIUS', rr), ...radius('SECONDARYRADIUS', rr) }, { LOCATION: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
        continue;
      }
      const line = (l: Pt[]) => {
        if (l.length === 2) r.add({ RECORD: SR.LINE, ...own, LINEWIDTH: lw, COLOR: COL.body }, { LOCATION: l[0]!, CORNER: l[1]! });
        else if (l.length > 2) r.points({ RECORD: SR.POLYLINE, ...own, LINEWIDTH: lw, COLOR: COL.body }, l);
      };
      if (pc.pts.some((p) => p.arc)) {
        // Lines between the arcs, each arc an arc
        let run: Pt[] = [];
        pc.pts.forEach((p) => {
          run.push(P(p));
          if (!p.arc) return;
          line(run);
          const at = (deg: number) => ({ x: p.arc!.c.x + p.arc!.r * Math.cos((deg * Math.PI) / 180), y: p.arc!.c.y + p.arc!.r * Math.sin((deg * Math.PI) / 180) });
          const arc = arcThrough(P(p), P(at(p.arc.a0 + p.arc.sweep / 2)), P(at(p.arc.a0 + p.arc.sweep)));
          if (arc) r.add({ RECORD: SR.ARC, ...own, LINEWIDTH: lw, COLOR: COL.body, ...radius('RADIUS', arc.r), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: arc.c });
          run = [P(at(p.arc.a0 + p.arc.sweep))];
        });
        line(run);
        continue;
      }
      const list = pc.pts.map(P);
      const filled = pc.type === 'COPCLS';
      if ((filled || pc.type === 'CLOSED') && list.length >= 3) {
        const xs = new Set(list.map((p) => p.x)), ys = new Set(list.map((p) => p.y));
        if (!filled && xs.size === 2 && ys.size === 2 && list.length <= 5) {
          const xa = [...xs], ya = [...ys];
          r.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: lw, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false, TRANSPARENT: true },
            { LOCATION: { x: Math.min(...xa), y: Math.min(...ya) }, CORNER: { x: Math.max(...xa), y: Math.max(...ya) } });
        } else r.points({ RECORD: SR.POLYGON, ...own, LINEWIDTH: lw, COLOR: COL.body, AREACOLOR: filled ? COL.body : COL.fill, ISSOLID: filled, TRANSPARENT: !filled || undefined }, list);
      } else line(list);
    }
    for (const t of dec.texts) {
      if (!t.text.trim()) continue;
      r.add({ RECORD: SR.LABEL, ...own, TEXT: t.text, FONTID: fonts.id(fontMm(t.height)), COLOR: COL.text, ORIENTATION: ((Math.round(t.angle / 90) % 4) + 4 + pl.orient) % 4, JUSTIFICATION: just(t.just) }, { LOCATION: P(t) });
    }
    dec.pins.forEach((p, i) => {
      const info = pins[i] ?? { num: String(i + 1), type: 'U', name: '' };
      const len = pinLength.get(p.decal) ?? (p.decal ? 200 : 0);
      const dir = pinDir(p);
      const hot = P(p), body = P({ x: p.x + dir.x * len, y: p.y + dir.y * len });
      const showName = show.names && !!info.name && !(p.flags & 128) && info.name !== info.num;
      r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: ELECTRICAL[info.type.toUpperCase()] ?? 4, PINCONGLOMERATE: orientOf(body, hot) | (showName ? 0x08 : 0) | (show.numbers ? 0x10 : 0),
        ...lengthKeys(U(len)), NAME: info.name, DESIGNATOR: info.num, COLOR: COL.pin, ...pinShape(p.decal) }, { LOCATION: len ? body : hot });
    });
    // Signal pins: hidden pins on their nets
    sigPins.forEach((sp) => r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: 7, PINCONGLOMERATE: 0x04 | 0x10, PINLENGTH: 0, NAME: sp.net, DESIGNATOR: sp.pin, COLOR: COL.pin, HIDDENNETNAME: sp.net }, { LOCATION: P({ x: 0, y: 0 }) }));
  };

  /* The library: a symbol per part type, a part per gate */
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  const gateDecal = (pt: LPartType, g: number, variant = 0): LDecal | undefined => { const gate = pt.gates[g]; return gate ? d.decals.get(gate.decals[Math.min(variant, gate.decals.length - 1)] ?? '') ?? d.decals.get(gate.decals[0] ?? '') : undefined; };
  for (const pt of d.partTypes.values()) {
    if (pt.name.startsWith('$') || !pt.gates.length) continue;
    const r = new Records(), fonts = new Fonts();
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: pt.name, PARTCOUNT: pt.gates.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1, LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*',
      AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: pt.name, UNIQUEID: uniqueId() });
    pt.gates.forEach((g, gi) => { const dec = gateDecal(pt, gi); if (dec) emitDecal(r, fonts, dec, g.pins, placement(0, 0, 0, 0), { OWNERPARTID: gi + 1 }, gi === 0 ? pt.sigPins : []); });
    const dec0 = gateDecal(pt, 0);
    const lab = (name: string) => dec0?.attrs.find((a) => a.text.toUpperCase() === name);
    const ref = lab('REF-DES'), typ = lab('PART-TYPE');
    r.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${refPrefix(pt)}?`, FONTID: 1, COLOR: COL.text, JUSTIFICATION: just(ref?.just ?? 0) }, { LOCATION: { x: U(ref?.x ?? 0), y: U(ref?.y ?? 0) } });
    r.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: pt.name, FONTID: 1, COLOR: COL.text, JUSTIFICATION: just(typ?.just ?? 0) }, { LOCATION: { x: U(typ?.x ?? 0), y: U(typ?.y ?? -100) } });
    symbols.push({ libRef: pt.name, parts: pt.gates.length, bags: r.bags });
  }
  function refPrefix(pt: LPartType): string {
    const c = pt.category.toUpperCase();
    return ({ RES: 'R', CAP: 'C', IND: 'L', DIO: 'D', TRX: 'Q', CON: 'J', CN: 'J', ICS: 'U', ANA: 'U', TTL: 'U', CMOS: 'U', ECL: 'U', MOS: 'Q' } as Record<string, string>)[c] ?? 'U';
  }

  /* The sheets */
  const out: { name: string; bytes: Uint8Array }[] = [];
  const netNames = new Set<string>();
  let nParts = 0;
  const taken = new Set<string>();
  // Each named signal's groups of wires (joined end to end) on each sheet, and what names each: an
  // off-page reference, a power symbol or nothing. PADS's signals are nets by name design-wide, so
  // a group gets a net label (labels being global here) unless every group of its signal is named
  // the same other way (off-sheet connectors join each other, power ports each other).
  type Group = { wires: LWire[]; by: 'offsheet' | 'power' | null };
  const groupsOf = (sh: LSheet): Map<string, Group[]> => {
    const opcType = new Map(sh.opcs.map((o) => [o.id, o.type]));
    const out = new Map<string, Group[]>();
    for (const sig of sh.signals) {
      if (!sig.name || sig.name.startsWith('$') || sig.name.startsWith('@')) continue;
      const parent = new Map<string, string>();
      const find = (a: string): string => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
      for (const w of sig.wires) { const ra = find(w.a), rb = find(w.b); if (ra !== rb) parent.set(ra, rb); }
      const byRoot = new Map<string, LWire[]>();
      for (const w of sig.wires) { const g = find(w.a); if (!byRoot.has(g)) byRoot.set(g, []); byRoot.get(g)!.push(w); }
      const powerPart = sh.parts.some((p) => p.power === sig.name);
      const list = out.get(sig.name) ?? [];
      for (const ws of byRoot.values()) {
        let by: Group['by'] = null;
        for (const w of ws) for (const e of [w.a, w.b]) { const t = opcType.get(e); if (t) by = /OSR/i.test(t) ? by ?? 'offsheet' : 'power'; }
        list.push({ wires: ws, by: by ?? (powerPart ? 'power' : null) });
      }
      out.set(sig.name, list);
    }
    return out;
  };
  const sheetGroups = d.sheets.map(groupsOf);
  const every = new Map<string, { offsheet: boolean; power: boolean }>();
  for (const m of sheetGroups) for (const [name, gs] of m) {
    const e = every.get(name) ?? { offsheet: true, power: true };
    for (const g of gs) { if (g.by !== 'offsheet') e.offsheet = false; if (g.by !== 'power') e.power = false; }
    every.set(name, e);
  }

  for (const sh of d.sheets) {
    const r = new Records(), fonts = new Fonts();
    r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const sheetIndex = r.bags.length;
    r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
    const top = (props: Props, coords?: Record<string, Pt>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
    const P = (p: Pt) => ({ x: U(p.x), y: U(p.y) });

    // Free text and drawings
    const label = (t: LText, at: Pt) => { if (t.text.trim()) top({ RECORD: SR.LABEL, TEXT: t.text, FONTID: fonts.id(fontMm(t.height)), COLOR: COL.graphic, ORIENTATION: Math.round(t.angle > 3 ? t.angle / 90 : t.angle) % 4, JUSTIFICATION: just(t.just) }, { LOCATION: at }); };
    for (const t of sh.texts) label(t, P(t));
    for (const item of sh.lines) {
      const dec: LDecal = { name: '', attrs: [], pieces: item.pieces, texts: [], pins: [], pinDecal: false };
      emitDecal(r, fonts, dec, [], placement(item.x, item.y, 0, 0), { OWNERPARTID: -1 });
      for (const t of item.texts) label(t, P({ x: item.x + t.x, y: item.y + t.y }));
    }
    // Wires and junctions
    for (const sig of sh.signals) {
      if (!sig.name.startsWith('$')) netNames.add(sig.name);
      for (const w of sig.wires) {
        const list = w.pts.map(P).filter((p, i, a) => i === 0 || p.x !== a[i - 1]!.x || p.y !== a[i - 1]!.y);
        if (list.length >= 2) r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire, UNIQUEID: uniqueId() }, list);
      }
    }
    // Tie dots: wires end at them, so they join as AD joins wire ends (AD draws its own dots where three meet)
    for (const b of sh.buses) if (b.pts.length >= 2) r.points({ RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: COL.bus }, b.pts.map(P));

    /** A power, ground or off-page symbol's look: its variant's decal, the way its body lies from its point. */
    const special = (type: string, variant: number, net: string, x: number, y: number, angle: number, mirror: number): { kind: 'power' | 'offsheet'; style: number; orient: number } => {
      const pt = d.partTypes.get(type);
      const v = pt?.variants[Math.max(0, Math.min(variant, (pt?.variants.length ?? 1) - 1))];
      const dec = d.decals.get(v?.decal ?? '') ?? d.decals.get(net);
      const pl = placement(x, y, angle, mirror);
      const pts = dec ? dec.pieces.flatMap((pc) => pc.pts) : [];
      const pin = dec?.pins[0] ?? { x: 0, y: 0 };
      const cen = pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : { x: pin.x, y: pin.y + 1 };
      const orient = orientOf(pl.local(pin), pl.local(cen));
      const name = (v?.decal ?? net).toUpperCase();
      if (/OSR/i.test(type)) return { kind: 'offsheet', style: 0, orient };
      const ground = /GND/i.test(type) || /GND|VSS/.test(name);
      const style = /CHGND|CHASSIS|EARTH/.test(name) ? 6 : /AGND|SGND/.test(name) ? 5 : ground ? 4 : /BUBBLE/.test(name) ? 0 : /^Y$/.test(name) ? 1 : 2;
      return { kind: 'power', style, orient };
    };
    for (const o of sh.opcs) {
      const s = special(o.type, o.variant, o.net, o.x, o.y, o.angle, o.mirror);
      if (s.kind === 'offsheet') top({ RECORD: SR.POWER_PORT, ISCROSSSHEETCONNECTOR: true, ORIENTATION: s.orient, TEXT: o.net, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: P(o) });
      else top({ RECORD: SR.POWER_PORT, STYLE: s.style, ORIENTATION: s.orient, TEXT: o.net, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: P(o) });
    }

    // Parts
    for (const part of sh.parts) {
      if (part.power || part.type.startsWith('$')) {
        const net = part.power ?? part.ref;
        const s = special(part.type, part.variant, net, part.x, part.y, part.angle, part.mirror);
        top({ RECORD: SR.POWER_PORT, ...(s.kind === 'offsheet' ? { ISCROSSSHEETCONNECTOR: true } : { STYLE: s.style }), ORIENTATION: s.orient, TEXT: net, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: P(part) });
        continue;
      }
      const pt = d.partTypes.get(part.type);
      if (!pt || !pt.gates.length) { warnings.push(`${part.ref}: its part type ${part.type} isn't in the file`); continue; }
      // The gate: from the letter after the reference (U1-B)
      const gm = /^(.*?)[-.]([A-Z]{1,2})$/.exec(part.ref);
      const gate = gm && pt.gates.length > 1 ? Math.min(pt.gates.length - 1, gm[2]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1) : 0;
      const designator = gm && pt.gates.length > 1 ? gm[1]! : part.ref;
      const dec = gateDecal(pt, gate, part.variant);
      if (!dec) { warnings.push(`${part.ref}: its decal isn't in the file`); continue; }
      const pl = placement(part.x, part.y, part.angle, part.mirror);
      const value = part.values.get('Value') ?? part.values.get('VALUE') ?? '';
      const footprint = part.values.get('PCB DECAL') ?? part.values.get('PCB_DECAL') ?? '';
      const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: pt.name, PARTCOUNT: pt.gates.length + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: gate + 1, ORIENTATION: pl.orient, ISMIRRORED: pl.mirrored || undefined,
        AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: pt.name, COMPONENTDESCRIPTION: part.values.get('Description') || undefined, SOURCELIBRARYNAME: `${stem}.SchLib`, UNIQUEID: uniqueId() }, { LOCATION: P(part) });
      emitDecal(r, fonts, dec, pt.gates[gate]!.pins, pl, { OWNERINDEX: ci - 1, OWNERPARTID: gate + 1 }, gate === 0 ? pt.sigPins : [], { names: !(part.flags & 8), numbers: !(part.flags & 16) });
      nParts++;
      if (gate === 0 || !taken.has(designator)) taken.add(designator);
      // Designator, comment and the attributes where their labels are (offsets from the part on the sheet [est: KiCad's reader])
      const labelAt = (a: LText) => P({ x: part.x + a.x, y: part.y + a.y });
      const look = (a: LText) => ({ FONTID: fonts.id(fontMm(a.height)), ORIENTATION: Math.round(a.angle / 90) % 2 ? 1 : 0, JUSTIFICATION: just(a.just) });
      const attrs = part.attrs.length ? part.attrs : dec.attrs.map((a) => ({ ...a, flags: 0 }));
      const find = (n: string) => attrs.find((a) => a.text.toUpperCase() === n);
      const refL = find('REF-DES'), typeL = find('PART-TYPE'), valL = attrs.find((a) => /^value$/i.test(a.text));
      const hidden = (a: LText | undefined) => !a || !!(a.flags & 8) || (a === typeL && !!(part.flags & 2));
      r.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Designator', TEXT: designator, COLOR: COL.text, ...(refL ? look(refL) : { FONTID: 1 }), ISHIDDEN: hidden(refL) || undefined }, { LOCATION: refL ? labelAt(refL) : P(part) });
      // The comment: a Comment attribute where there is one (the Value then a parameter), else the Value, else the part type
      const cmt = part.values.get('Comment') ?? part.values.get('COMMENT');
      const commentL = cmt !== undefined ? attrs.find((a) => /^comment$/i.test(a.text)) ?? valL ?? typeL : valL && value ? valL : typeL;
      r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Comment', TEXT: (cmt ?? value) || pt.name, COLOR: COL.text, ...(commentL ? look(commentL) : { FONTID: 1 }), ISHIDDEN: hidden(commentL) || undefined }, { LOCATION: commentL ? labelAt(commentL) : P(part) });
      if (commentL === valL && typeL && !hidden(typeL)) r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Part Type', TEXT: pt.name, COLOR: COL.text, ...look(typeL) }, { LOCATION: labelAt(typeL) });
      for (const [k, v] of part.values) {
        if (/^(Comment|PCB DECAL|PCB_DECAL)$/i.test(k) || (cmt === undefined && /^value$/i.test(k))) continue;
        const l = attrs.find((a) => a.text === k);
        r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: k, TEXT: v || '*', COLOR: COL.text, ...(l ? look(l) : { FONTID: 1 }), ISHIDDEN: !l || hidden(l) || undefined }, { LOCATION: l ? labelAt(l) : P(part) });
      }
      if (footprint) {
        const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
        const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: footprint, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: footprint, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
        r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
        r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
      }
    }

    // A net's name where nothing else names it design-wide: a net label on each group that needs
    // one, on its longest stretch of wire, clear of the other groups' wires (a label on a wire joins it)
    const mine = sheetGroups[d.sheets.indexOf(sh)]!;
    const segsOf = (g: Group) => g.wires.flatMap((w) => w.pts.slice(1).map((b, i) => ({ a: w.pts[i]!, b })));
    const allSegs: { a: Pt; b: Pt; g: Group }[] = [];
    for (const gs of mine.values()) for (const g of gs) for (const sg of segsOf(g)) allSegs.push({ ...sg, g });
    for (const sig of sh.signals) if (sig.name.startsWith('$') || sig.name.startsWith('@')) for (const w of sig.wires) for (let i = 1; i < w.pts.length; i++) allSegs.push({ a: w.pts[i - 1]!, b: w.pts[i]!, g: null as unknown as Group });
    const onSeg = (p: Pt, a: Pt, b: Pt) => p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
      && Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= Math.hypot(b.x - a.x, b.y - a.y) * 0.5;
    for (const [name, gs] of mine) {
      const e = every.get(name)!;
      for (const g of gs) {
        if ((g.by === 'offsheet' && e.offsheet) || (g.by === 'power' && e.power)) continue;
        const segs = segsOf(g).sort((x, y) => Math.hypot(y.b.x - y.a.x, y.b.y - y.a.y) - Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y));
        let pick: { at: Pt; horizontal: boolean } | null = null;
        for (const sg of segs) {
          const horizontal = Math.abs(sg.b.y - sg.a.y) <= Math.abs(sg.b.x - sg.a.x);
          for (const t of [0.5, 0.25, 0.75, 0.375, 0.625, 0.125, 0.875, 0, 1]) {
            const q = { x: sg.a.x + (sg.b.x - sg.a.x) * t, y: sg.a.y + (sg.b.y - sg.a.y) * t };
            const at = sg.a.x === sg.b.x && sg.a.y === sg.b.y ? sg.a : horizontal && sg.a.y === sg.b.y ? { x: Math.round(q.x / 10) * 10, y: sg.a.y } : !horizontal && sg.a.x === sg.b.x ? { x: sg.a.x, y: Math.round(q.y / 10) * 10 } : q;
            if (!onSeg(at, sg.a, sg.b) || allSegs.some((o) => o.g !== g && onSeg(at, o.a, o.b))) continue;
            pick = { at, horizontal };
            break;
          }
          if (pick) break;
        }
        if (!pick) continue;
        top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: 1, COLOR: COL.wire, ORIENTATION: pick.horizontal ? 0 : 1, UNIQUEID: uniqueId() }, { LOCATION: P(pick.at) });
      }
    }

    // The sheet: PADS's paper (grown to what's on it); a sheet with its own frame drawn (a drawing
    // item nearly the size of the paper) has AD's border and title block off [est]
    let [W, H] = SHEET_SIZE[d.sheetSize.toUpperCase()] ?? SHEET_SIZE.B!;
    let framed = false;
    const reach = (x: number, y: number) => { W = Math.max(W, x); H = Math.max(H, y); };
    for (const item of sh.lines) {
      const xs: number[] = [], ys: number[] = [];
      for (const pc of item.pieces) for (const q of pc.pts) { xs.push(item.x + q.x); ys.push(item.y + q.y); }
      if (!xs.length) continue;
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      reach(x1, y1);
      if (x1 - x0 >= 0.85 * W && y1 - y0 >= 0.85 * H) framed = true;
    }
    for (const pt of sh.parts) reach(pt.x, pt.y);
    W = Math.ceil(W / 100) * 10; H = Math.ceil(H / 100) * 10;
    r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
      CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: Math.max(4, Math.round(W / 250)), CUSTOMYZONES: Math.max(4, Math.round(H / 250)), CUSTOMMARGINWIDTH: 20,
      BORDERON: !framed, TITLEBLOCKON: !framed, AREACOLOR: toBgr(0xffffff),
      SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
    r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const base = (sh.name || `Sheet${sh.num}`).replace(/[\\/:*?"<>|]/g, '_');
    let name = d.sheets.length === 1 ? `${stem}.SchDoc` : `${base}.SchDoc`;
    for (let k = 2; out.some((o) => o.name.toLowerCase() === name.toLowerCase()); k++) name = `${base}_${k}.SchDoc`;
    out.push({ name, bytes: writeCfb(root) });
  }
  // The file as PADS wrote it, for the way back while the sheets are what this import made (kept.ts)
  if (source && out.length) {
    const docs = out.map((o) => readSchDoc(o.bytes, o.name));
    keepPadsLogic(docs, source);
    docs.forEach((d, i) => { out[i]!.bytes = writeSchDoc(d); });
  }
  return { sheets: out, library: writeSchLib(symbols), symbols: symbols.length, warnings, stats: { sheets: out.length, parts: nParts, nets: netNames.size, symbols: symbols.length } };
}
