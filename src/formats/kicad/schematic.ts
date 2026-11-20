/**
 * KiCad schematics (.kicad_sch, KiCad 6 and later) and symbol libraries (.kicad_sym) as AD
 * documents: sheets become SchDocs, a hierarchy's sheets each its own SchDoc (a sheet used twice
 * becomes two, each with its instance's designators), symbols components with their graphics
 * and pins, power symbols power ports, global labels power ports too (they join across every
 * sheet, as AD's power ports do), hierarchical labels ports, sheets sheet symbols with their
 * entries [est: AD's KiCad importer's own choices]. KiCad's millimetres with Y down become AD's
 * 10 mil units with Y up on a custom sheet the size of KiCad's page.
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords, joinTextRecords } from '../altium/framing';
import { readSchDoc, storageStream, writeSchDoc } from '../altium/schdoc';
import { readSchLib, writeSchLib } from '../altium/schlib';
import { SR, setSchCoord } from '../../model/sch';
import { toBgr } from '../../model/common';
import { SCH_UNIT } from '../../core/units';
import { uniqueId } from '../../model/schEdit';
import { uniqueIdFor } from './board';
import { keepJson } from './padPrims';
import { KEPT_SYMBOLS, bagsSig, extrasOf, partSymbolSig } from './kept';
import { symbolOf } from '../../model/makeLib';
/** A label's lists the import makes something of (the rest kept: its fields, such as Intersheetrefs). */
const LABEL_USED = new Set(['at', 'effects', 'shape', 'fields_autoplaced']);
/**
 * A label's font as KiCad had it where Konium's isn't the same (KICADFONT): its size where it isn't
 * a whole number of the desktop software's points (0.127 mm), its settings Konium makes nothing of
 * (its stroke's thickness, colour, face), for the way back.
 */
function fontX(n: SList): Record<string, string> {
  const f = kid(kid(n, 'effects'), 'font');
  const x = f?.items.filter((y): y is SList => isList(y) && y.k !== 'size' && y.k !== 'bold' && y.k !== 'italic') ?? [];
  const w = num(kid(f, 'size'), 0), h = num(kid(f, 'size'), 1);
  const whole = (v: number) => Math.abs(v / 0.127 - Math.round(v / 0.127)) < 1e-6;
  return x.length || !whole(w) || !whole(h) || w !== h ? { KICADFONT: keepJson({ size: w, h, x }) } : {};
}
/** A sheet symbol's lists the import makes something of (the rest kept: its fields as placed, stroke, fill, flags). */
const SHEET_USED = new Set(['at', 'pin', 'instances']);
/** A placed symbol's lists the import makes something of (the rest kept: extrasOf). */
const SYM_USED = new Set(['lib_id', 'lib_name', 'at', 'mirror', 'unit', 'in_bom', 'on_board', 'property', 'pin', 'instances', 'fields_autoplaced']);
import { at, flag, isList, kid, kids, num, parseSexpr, prop, pts, str, val, valNum, type SList } from './sexpr';

/* ── units and transforms ── */

const DXP = 0.254;                 // mm in AD's schematic unit (10 mil)
const toU = (mm: number) => mm / DXP;
type Xy = { x: number; y: number };
/** KiCad's symbol TRANSFORM (x1, y1, x2, y2): library (Y up) to sheet (Y down). */
type Tf = [number, number, number, number];
const apply = (t: Tf, p: Xy): Xy => ({ x: t[0] * p.x + t[1] * p.y, y: t[2] * p.x + t[3] * p.y });
const xy = (n: SList | undefined, k: string): Xy => { const l = kid(n, k); return { x: num(l, 0), y: num(l, 1) }; };

/** The placed symbol's transform, as KiCad's reader makes it: the rotation, then the mirror. */
export function symbolTransform(angle: number, mirror?: string): Tf {
  const a = ((Math.round(angle) % 360) + 360) % 360;
  let m: Tf = a === 90 ? [0, -1, -1, 0] : a === 180 ? [-1, 0, 0, 1] : a === 270 ? [0, 1, 1, 0] : [1, 0, 0, -1];
  const compose = (t: Tf) => { m = [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]]; };
  if (mirror === 'y') compose([-1, 0, 0, 1]);
  else if (mirror === 'x') compose([1, 0, 0, -1]);
  return m;
}

/** KiCad page sizes in mm (landscape). */
const PAPER: Record<string, [number, number]> = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
};
export function paperSize(root: SList): [number, number] {
  const p = kid(root, 'paper');
  const name = str(p) ?? 'A4';
  let size: [number, number] = name === 'User' ? [num(p, 1, 297), num(p, 2, 210)] : PAPER[name] ?? PAPER.A4!;
  if (flag(p, 'portrait')) size = [size[1], size[0]];
  return size;
}

/* ── colours, fonts ── */

export const COL = { wire: toBgr(0x1d4f91), bus: toBgr(0x1d4f91), body: toBgr(0x8b0000), fill: toBgr(0xfff7c2), pin: toBgr(0x000000), text: toBgr(0x00007f),
  port: toBgr(0x8b0000), portFill: toBgr(0xffffc8), power: toBgr(0x00007f), sheet: toBgr(0x8b0000), sheetFill: toBgr(0xfff8dc), noerc: toBgr(0xff0000), graphic: toBgr(0x00007f) };
/** KiCad's text height (mm) as an AD font size (points): a point is 5 mil of capital height, as Konium draws AD's fonts (1.27 mm is 10 pt). */
export const fontPts = (mm: number) => Math.max(4, Math.round(mm / 0.127));

export class Fonts {
  /** Font 1 is the system font (pins, power ports): KiCad's default text, 1.27 mm. */
  sizes: number[] = [fontPts(1.27) * 4];
  id(mm: number, bold = false, italic = false): number {
    const k = fontPts(mm) * 4 + (bold ? 1 : 0) + (italic ? 2 : 0);
    let i = this.sizes.indexOf(k);
    if (i < 0) { this.sizes.push(k); i = this.sizes.length - 1; }
    return i + 1;
  }
  keys(): Record<string, string | number | boolean> {
    const o: Record<string, string | number | boolean> = { FONTIDCOUNT: Math.max(1, this.sizes.length) };
    if (!this.sizes.length) { o.SIZE1 = 6; o.FONTNAME1 = 'Arial'; }
    this.sizes.forEach((k, i) => { o[`SIZE${i + 1}`] = k >> 2; o[`FONTNAME${i + 1}`] = 'Arial'; if (k & 1) o[`BOLD${i + 1}`] = true; if (k & 2) o[`ITALIC${i + 1}`] = true; });
    return o;
  }
}

/* ── pictures ── */

/** Base64 to bytes. */
export function base64Bytes(s: string): Uint8Array {
  try { const bin = atob(s.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; } catch { return new Uint8Array(); }
}
/** A PNG's size in pixels and its resolution (pHYs in pixels a metre, as pixels an inch; 300 when it has none, as KiCad takes it [est]). */
export function pngInfo(b: Uint8Array): { w: number; h: number; ppi: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  let ppi = 300;
  for (let o = 8; o + 12 <= b.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    if (type === 'pHYs' && len >= 9 && b[o + 16] === 1) { const ppm = dv.getUint32(o + 8); if (ppm > 0) ppi = ppm * 0.0254; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return w && h ? { w, h, ppi } : null;
}

/* ── records ── */

export type Props = Record<string, string | number | boolean | undefined>;
export class Records {
  bags: PropertyBag[] = [];
  /** Adds a record (coordinates in AD units); returns its index (what OWNERINDEX names). */
  add(props: Props, coords: Record<string, Xy> = {}): number {
    const b = PropertyBag.from(Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>);
    for (const [k, p] of Object.entries(coords)) { setSchCoord(b, `${k}.X`, Math.round(p.x * SCH_UNIT)); setSchCoord(b, `${k}.Y`, Math.round(p.y * SCH_UNIT)); }
    this.bags.push(b);
    return this.bags.length - 1;
  }
  points(props: Props, list: Xy[]): number {
    const b = PropertyBag.from(Object.fromEntries(Object.entries({ ...props, LOCATIONCOUNT: list.length }).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>);
    list.forEach((p, i) => { setSchCoord(b, `X${i + 1}`, Math.round(p.x * SCH_UNIT)); setSchCoord(b, `Y${i + 1}`, Math.round(p.y * SCH_UNIT)); });
    this.bags.push(b);
    return this.bags.length - 1;
  }
}

/* ── text ── */

interface TextLook { size: number; hidden: boolean; hJust: number; vJust: number; bold: boolean; italic: boolean; mirror: boolean }
function effects(n: SList | undefined): TextLook {
  const e = kid(n, 'effects');
  const font = kid(e, 'font');
  const sz = kid(font, 'size');
  const j = kid(e, 'justify');
  const js = j ? j.items.map(String) : [];
  return { size: num(sz, 1, num(sz, 0, 1.27)), hidden: flag(e, 'hide') || flag(n, 'hide'), hJust: js.includes('left') ? 0 : js.includes('right') ? 2 : 1,
    vJust: js.includes('bottom') ? 0 : js.includes('top') ? 2 : 1, bold: flag(font, 'bold'), italic: flag(font, 'italic'), mirror: js.includes('mirror') };
}
/** AD JUSTIFICATION: bottom-left 0 … top-right 8. */
export const justification = (h: number, v: number) => v * 3 + h;
/** KiCad's text markup out (~{OVERBAR} → AD's backslash form, sub/superscript braces dropped). */
/** A name's KiCad text where its markup (subscripts, overbars, escapes) isn't in Konium's, for the way back (KICADRAW). */
export const rawOf = (s: string): Record<string, string> => (plainText(s) !== s ? { KICADRAW: keepJson(s) } : {});
/**
 * A drawing's stroke and fill (KiCad's) in AD's terms: its width (Small, Medium, Large), line style,
 * colour, a fill solid in its colour (outline: the line's, background: the body's); and KiCad's own,
 * kept for the way back while these stay as they were (KICADX, KICADLOOKSIG: lookSig).
 */
export function lookOf(n: SList, line: number, area: number = COL.fill): Props {
  const st = kid(n, 'stroke'), w = valNum(st, 'width', valNum(n, 'width', 0)), type = val(st, 'type') ?? 'default';
  const rgb = (c: SList | undefined) => (c && (num(c, 0) || num(c, 1) || num(c, 2) || num(c, 3)) ? toBgr((num(c, 0) << 16) | (num(c, 1) << 8) | num(c, 2)) : null);
  const style = type === 'dash' ? 1 : type === 'dot' ? 2 : type === 'dash_dot' || type === 'dash_dot_dot' ? 3 : 0;
  const colour = rgb(kid(st, 'color')) ?? line;
  const f = kid(n, 'fill'), ft = val(f, 'type') ?? (str(f) === 'yes' || str(f) === 'solid' ? 'outline' : 'none');
  const fc = kid(f, 'color');
  const fill = ft === 'outline' ? { ISSOLID: true, AREACOLOR: colour, TRANSPARENT: false } : ft === 'background' ? { ISSOLID: true, AREACOLOR: area, TRANSPARENT: false }
    : ft === 'color' && rgb(fc) !== null ? { ISSOLID: true, AREACOLOR: rgb(fc)!, TRANSPARENT: num(fc, 3, 1) < 1 } : { ISSOLID: false, AREACOLOR: area, TRANSPARENT: true };
  const kept = [st, f].filter((x): x is SList => !!x);
  return { LINEWIDTH: w <= 0 || w < 0.5 ? 1 : w < 1 ? 2 : 3, COLOR: colour, LINESTYLE: Math.min(style, 2), ...(style === 3 ? { LINESTYLEEXT: 3 } : {}), ...fill,
    ...(kept.length ? { KICADX: keepJson(kept) } : {}) };
}
/** What a drawing looks like in Konium, to tell whether KiCad's stroke and fill kept with it still hold. */
export const lookSig = (b: PropertyBag): string => ['LINEWIDTH', 'COLOR', 'LINESTYLE', 'LINESTYLEEXT', 'ISSOLID', 'AREACOLOR', 'TRANSPARENT', 'SHOWBORDER', 'TEXTMARGIN'].map((k) => b.get(k) ?? '').join(';');
/** An object's settings the import makes nothing of (extrasOf), as a record's KICADX. */
const readKept = (v: unknown): SList[] => { try { return typeof v === 'string' ? JSON.parse(v) as SList[] : []; } catch { return []; } };
const keptX = (n: SList, used: ReadonlySet<string>, atoms = 0): Record<string, string> => { const x = extrasOf(n, used, atoms); return x.length ? { KICADX: keepJson(x) } : {}; };
export function plainText(s: string): string {
  return s.replace(/~\{([^}]*)\}/g, (_, t: string) => t.split('').map((c) => `${c}\\`).join('')).replace(/[_^]\{([^}]*)\}/g, '$1').replace(/\{slash\}/g, '/').replace(/\{dblquote\}/g, '"').replace(/\{brace\}/g, '{');
}

/* ── library symbols ── */

interface LibSym { node: SList; name: string; power: boolean; units: number; hideNames: boolean; hideNumbers: boolean; nameOffset: number }
/** A library symbol's units: unit 0 is common to all. */
function unitsOf(sym: SList): Map<number, SList[]> {
  const out = new Map<number, SList[]>();
  for (const s of kids(sym, 'symbol')) {
    const m = /_(\d+)_(\d+)$/.exec(str(s) ?? '');
    if (!m) continue;
    const unit = Number(m[1]), style = Number(m[2]);
    if (style > 1) continue; // De Morgan alternates left out
    if (!out.has(unit)) out.set(unit, []);
    out.get(unit)!.push(s);
  }
  return out;
}
function libSym(node: SList): LibSym {
  const units = unitsOf(node);
  const count = Math.max(1, ...[...units.keys()].filter((u) => u > 0));
  const pn = kid(node, 'pin_names');
  return { node, name: str(node) ?? '', power: flag(node, 'power') || !!kid(node, 'power'), units: count, hideNames: flag(pn, 'hide'), hideNumbers: flag(kid(node, 'pin_numbers'), 'hide'),
    nameOffset: valNum(pn, 'offset', 0.508) };
}

const ELECTRICAL: Record<string, number> = { input: 0, bidirectional: 1, output: 2, open_collector: 3, passive: 4, tri_state: 5, open_emitter: 6, power_in: 7, power_out: 7, unspecified: 4, free: 4, no_connect: 4 };
const DIRS: Xy[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

/**
 * The records of a symbol's unit: its graphics and pins placed by `place` (library point → AD
 * point). `own` carries OWNERINDEX / OWNERPARTID.
 */
function emitUnit(r: Records, sym: LibSym, unit: number, place: (p: Xy) => Xy, own: Props, fonts: Fonts, opts: { lineScale?: number } = {}): void {
  const units = unitsOf(sym.node);
  const parts = [...(units.get(0) ?? []), ...(units.get(unit) ?? [])];
  // Where the unit's shown pins connect: a hidden pin stacked on one is joined to it (as KiCad joins them)
  const shown = new Set(parts.flatMap((u) => kids(u, 'pin')).filter((p) => !flag(p, 'hide') && String(p.items[0]) !== 'no_connect').map((p) => `${num(kid(p, 'at'), 0)},${num(kid(p, 'at'), 1)}`));
  const P = (n: SList | undefined, k: string) => { const l = kid(n, k); return place({ x: num(l, 0), y: num(l, 1) }); };
  const width = (n: SList) => { const w = valNum(kid(n, 'stroke'), 'width', 0); return w > 0.3 ? 2 : w > 0.2 ? 1 : 1; };
  const fill = (n: SList) => { const t = val(kid(n, 'fill'), 'type') ?? 'none'; return { solid: t === 'background' || t === 'outline' || t === 'color', outline: t === 'outline' }; };
  for (const part of parts) {
    for (const g of part.items) {
      if (typeof g !== 'object' || !('k' in g)) continue;
      switch (g.k) {
        case 'rectangle': {
          const a = P(g, 'start'), b = P(g, 'end'), f = fill(g);
          r.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: width(g), COLOR: COL.body, AREACOLOR: f.outline ? COL.body : COL.fill, ISSOLID: f.solid, TRANSPARENT: !f.solid },
            { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } });
          break;
        }
        case 'polyline': {
          const list = pts(g).map(place), f = fill(g);
          if (list.length < 2) break;
          if (f.solid && list.length >= 3) r.points({ RECORD: SR.POLYGON, ...own, LINEWIDTH: width(g), COLOR: COL.body, AREACOLOR: f.outline ? COL.body : COL.fill, ISSOLID: true }, list);
          else if (list.length === 2) r.add({ RECORD: SR.LINE, ...own, LINEWIDTH: width(g), COLOR: COL.body }, { LOCATION: list[0]!, CORNER: list[1]! });
          else r.points({ RECORD: SR.POLYLINE, ...own, LINEWIDTH: width(g), COLOR: COL.body }, list);
          break;
        }
        case 'circle': {
          const c = P(g, 'center'), rad = toU(valNum(g, 'radius')) * (opts.lineScale ?? 1), f = fill(g);
          r.add({ RECORD: SR.ELLIPSE, ...own, LINEWIDTH: width(g), COLOR: COL.body, AREACOLOR: f.outline ? COL.body : COL.fill, ISSOLID: f.solid, TRANSPARENT: !f.solid, ...radius('RADIUS', rad), ...radius('SECONDARYRADIUS', rad) }, { LOCATION: c });
          break;
        }
        case 'arc': {
          const a = P(g, 'start'), m = P(g, 'mid'), b = P(g, 'end');
          const arc = arcThrough(a, m, b);
          if (arc) r.add({ RECORD: SR.ARC, ...own, LINEWIDTH: width(g), COLOR: COL.body, ...radius('RADIUS', arc.r), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: arc.c });
          else r.add({ RECORD: SR.LINE, ...own, LINEWIDTH: width(g), COLOR: COL.body }, { LOCATION: a, CORNER: b });
          break;
        }
        case 'bezier': {
          const list = pts(g).map(place);
          if (list.length === 4) r.points({ RECORD: SR.BEZIER, ...own, LINEWIDTH: width(g), COLOR: COL.body }, list);
          break;
        }
        case 'text': {
          const e = effects(g), p = P(g, 'at'), t = plainText(str(g) ?? '');
          if (e.hidden || !t) break;
          r.add({ RECORD: SR.LABEL, ...own, TEXT: t, FONTID: fonts.id(e.size, e.bold, e.italic), COLOR: COL.body, JUSTIFICATION: justification(e.hJust, e.vJust),
            // A symbol's text angle is in tenths of a degree (KiCad's own exception)
            ORIENTATION: Math.round(num(kid(g, 'at'), 2) / 900) % 2 ? 1 : 0 }, { LOCATION: p });
          break;
        }
        case 'pin': {
          const pa = kid(g, 'at');
          const hot = { x: num(pa, 0), y: num(pa, 1) }, ang = num(pa, 2), len = valNum(g, 'length', 2.54);
          const d = DIRS[(Math.round(ang / 90) % 4 + 4) % 4]!;
          const body = { x: hot.x + d.x * len, y: hot.y + d.y * len };
          const H = place(hot), B = place(body);
          // AD's orientation: from the body end out to the connection
          const orient = orientOf(place({ x: hot.x + d.x, y: hot.y + d.y }), H);
          const name = str(kid(g, 'name')) ?? '', number = str(kid(g, 'number')) ?? '';
          const type = String(g.items[0] ?? 'passive'), shape = String(g.items[1] ?? 'line');
          const hidden = flag(g, 'hide') && (String(g.items[0]) === 'no_connect' || !shown.has(`${hot.x},${hot.y}`));
          const showName = !sym.hideNames && name !== '~' && name !== '';
          const showNumber = !sym.hideNumbers;
          const sym4 = PIN_SHAPES[shape] ?? {};
          r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: ELECTRICAL[type] ?? 4, PINCONGLOMERATE: orient | (hidden ? 0x04 : 0) | (showName ? 0x08 : 0) | (showNumber ? 0x10 : 0),
            ...lengthKeys(toU(len)), NAME: name === '~' ? '' : plainText(name), DESIGNATOR: number, COLOR: COL.pin, ...sym4,
            HIDDENNETNAME: hidden && type === 'power_in' && name && name !== '~' ? name : undefined }, { LOCATION: B });
          break;
        }
      }
    }
  }
}
const PIN_SHAPES: Record<string, Props> = {
  inverted: { SYMBOL_OUTEREDGE: 1 }, clock: { SYMBOL_INNEREDGE: 3 }, inverted_clock: { SYMBOL_OUTEREDGE: 1, SYMBOL_INNEREDGE: 3 },
  input_low: { SYMBOL_OUTEREDGE: 4 }, clock_low: { SYMBOL_OUTEREDGE: 4, SYMBOL_INNEREDGE: 3 }, output_low: { SYMBOL_OUTEREDGE: 5 },
  edge_clock_high: { SYMBOL_INNEREDGE: 3 }, non_logic: { SYMBOL_OUTER: 1 },
};
export function orientOf(from: Xy, to: Xy): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
}
/** A length in AD units as its integer key and _FRAC remainder. */
export function lengthKeys(v: number): Props {
  const whole = Math.trunc(v), frac = Math.round((v - whole) * 100000);
  return frac ? { PINLENGTH: whole, PINLENGTH_FRAC: frac } : { PINLENGTH: whole };
}
export function radius(key: string, v: number): Props {
  const whole = Math.trunc(v), frac = Math.round((v - whole) * 100000);
  return frac ? { [key]: whole, [`${key}_FRAC`]: frac } : { [key]: whole };
}
/** The circle through three points (AD's arc: centre, radius, anticlockwise from start to end in degrees). */
export function arcThrough(a: Xy, m: Xy, b: Xy): { c: Xy; r: number; start: number; end: number } | null {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9) return null;
  const s = (p: Xy) => p.x * p.x + p.y * p.y;
  const c = { x: (s(a) * (m.y - b.y) + s(m) * (b.y - a.y) + s(b) * (a.y - m.y)) / d, y: (s(a) * (b.x - m.x) + s(m) * (a.x - b.x) + s(b) * (m.x - a.x)) / d };
  const ang = (p: Xy) => ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 360;
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  let sa = ang(a), ea = ang(b);
  const ma = ang(m);
  // Anticlockwise from start must pass the middle; else the other way round
  const ccw = (x: number) => ((x - sa) % 360 + 360) % 360;
  if (ccw(ma) > ccw(ea)) [sa, ea] = [ea, sa];
  return { c, r, start: sa, end: ea };
}

/* ── one sheet ── */

export interface KicadSheetFile { path: string; text: string }
export interface ConvertedSheet { name: string; bytes: Uint8Array; title: string; instance: string; children: { sheetName: string; file: string; instance: string }[] }

interface SheetContext { libs: Map<string, LibSym>; instance: string; project: string; /** The root sheet's UUID (left off the paths the board's footprints carry). */ root?: string; childName: (file: string, instance: string) => string; onSheet: (file: string, instance: string, name: string) => void;
  /** The KiCad file (kept in the sheet record: the sheets of one file used more than once go back as that one file). */ file?: string }

/** Designator and unit of a placed symbol in this instance of its sheet. */
function instanceOf(sym: SList, ctx: SheetContext): { ref: string; unit: number } {
  const def = { ref: val(sym, 'reference') ?? str(prop(sym, 'Reference'), 1) ?? '?', unit: valNum(sym, 'unit', 1) };
  for (const p of kids(kid(sym, 'instances'), 'project')) {
    for (const path of kids(p, 'path')) {
      if (str(path) === ctx.instance) return { ref: val(path, 'reference') ?? def.ref, unit: valNum(path, 'unit', def.unit) };
    }
  }
  // KiCad 6's sheet-level symbol_instances (in the root file) are applied by the caller
  return def;
}

export function convertSheet(root: SList, ctx: SheetContext & { refs?: Map<string, { ref: string; unit: number }> }): { bytes: Uint8Array; title: string } {
  const [W, H] = paperSize(root);
  const P = (p: Xy): Xy => ({ x: toU(p.x), y: toU(H - p.y) });
  const r = new Records();
  const fonts = new Fonts();
  r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
  const sheetIndex = r.bags.length;
  r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));   // filled in at the end (its fonts)
  const own = (i: number, part = 1): Props => ({ OWNERINDEX: i - 1, OWNERPARTID: part });
  // (OWNERINDEX counts records after the header, so record k of bags is index k − 1)
  const top = (props: Props, coords?: Record<string, Xy>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
  // The library symbols the parts are placed from, kept from KiCad (one copy each, by key), for the way back
  const symStore = new Map<string, string>();
  const keepSymbol = (node: SList): string => {
    const json = keepJson(node);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const key = `${h.toString(16).padStart(8, '0')}${json.length.toString(16)}`;
    symStore.set(key, json);
    return key;
  };

  const libs = new Map(ctx.libs);
  for (const s of kids(kid(root, 'lib_symbols'), 'symbol')) libs.set(str(s) ?? '', libSym(s));
  const title = val(kid(root, 'title_block'), 'title') ?? '';
  const localLabels = new Set(kids(root, 'label').map((l) => plainText(str(l) ?? '')));
  let textN = 0;
  // Pictures (KiCad's PNG data), embedded in the sheet's Storage
  const images: { name: string; bytes: Uint8Array }[] = [];
  // A drawing's look as the import made it, to tell later whether KiCad's kept stroke and fill still hold
  const sealLook = (i: number) => { const b = r.bags[i]; if (b?.has('KICADX')) b.set('KICADLOOKSIG', lookSig(b)); };

  for (const n of root.items) {
    if (typeof n !== 'object' || !('k' in n)) continue;
    // (KiCad's uuid kept on the first record each object makes, for the way back)
    const made = r.bags.length, uuid = val(n, 'uuid');
    switchItem(n);
    if (uuid && r.bags.length > made && !r.bags[made]!.has('KICADUUID')) r.bags[made]!.set('KICADUUID', uuid);
  }

  function switchItem(n: SList): void {
    switch (n.k) {
      case 'wire': case 'bus': {
        const list = pts(n).map(P);
        if (list.length >= 2) r.points({ RECORD: n.k === 'wire' ? SR.WIRE : SR.BUS, OWNERPARTID: -1, LINEWIDTH: n.k === 'bus' ? 2 : 1, COLOR: n.k === 'bus' ? COL.bus : COL.wire, UNIQUEID: uniqueId() }, list);
        break;
      }
      case 'bus_entry': {
        const a = at(n), sz = kid(n, 'size');
        const lk = lookOf(n, COL.wire);
        sealLook(top({ RECORD: SR.BUS_ENTRY, LINEWIDTH: lk.LINEWIDTH, COLOR: lk.COLOR, KICADX: lk.KICADX }, { LOCATION: P(a), CORNER: P({ x: a.x + num(sz, 0), y: a.y + num(sz, 1) }) }));
        break;
      }
      case 'junction': top({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: P(at(n)) }); break;
      case 'no_connect': top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: P(at(n)) }); break;
      case 'label': {
        const a = at(n), e = effects(n);
        top({ RECORD: SR.NET_LABEL, TEXT: plainText(str(n) ?? ''), FONTID: fonts.id(e.size, e.bold, e.italic), COLOR: COL.wire, ORIENTATION: Math.round(a.a / 90) % 4, UNIQUEID: uniqueId(), ...rawOf(str(n) ?? ''), ...keptX(n, LABEL_USED, 1), ...fontX(n) }, { LOCATION: P(a) });
        break;
      }
      case 'global_label': {
        // A global label joins its net on every sheet: an AD power port does that whatever the scope [est]
        const a = at(n);
        // (marked as KiCad's global label, with its shape and angle, for the way back)
        top({ RECORD: SR.POWER_PORT, STYLE: 1, ORIENTATION: Math.round(a.a / 90) % 4, TEXT: plainText(str(n) ?? ''), SHOWNETNAME: true, COLOR: COL.power, FONTID: fonts.id(effects(n).size),
          KICADGLOBAL: val(n, 'shape') ?? 'passive', KICADANGLE: Math.round(a.a), UNIQUEID: uniqueId(), ...rawOf(str(n) ?? ''), ...keptX(n, LABEL_USED, 1), ...fontX(n) }, { LOCATION: P(a) });
        break;
      }
      case 'hierarchical_label': {
        const a = at(n), e = effects(n), name = plainText(str(n) ?? '');
        const io = ({ input: 2, output: 1, bidirectional: 3, tri_state: 3, passive: 0 } as Record<string, number>)[val(n, 'shape') ?? ''] ?? 0;
        const w = Math.max(30, Math.ceil((name.length * fontPts(e.size) * 0.42 + 12) / 10) * 10);
        const o = Math.round(a.a / 90) % 4, p = P(a);
        // The port's other end from the label's point, along the way its text runs
        const loc = o === 2 ? { x: p.x - w, y: p.y } : o === 3 ? { x: p.x, y: p.y - w } : p;
        // (KiCad's angle kept: which end is the label's point, for the way back)
        top({ RECORD: SR.PORT, NAME: name, ...rawOf(str(n) ?? ''), ...keptX(n, LABEL_USED, 1), ...fontX(n), ...(val(n, 'shape') === 'tri_state' ? { KICADSHAPE: 'tri_state' } : {}), KICADANGLE: o * 90, STYLE: o % 2 ? 7 : 3, IOTYPE: io, WIDTH: w, HEIGHT: 10, ALIGNMENT: 0, COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port,
          FONTID: fonts.id(e.size), UNIQUEID: uniqueId() }, { LOCATION: loc });
        // KiCad joins a hierarchical label to the sheet's local labels of its name: a net label of that name at its point does it in AD
        // (marked, so that it doesn't go back to KiCad as a label of its own)
        if (localLabels.has(name)) top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: fonts.id(e.size), COLOR: COL.wire, ORIENTATION: o, KICADJOIN: true, UNIQUEID: uniqueId() }, { LOCATION: p });
        break;
      }
      case 'text': {
        const a = at(n), e = effects(n);
        const lines = plainText(str(n) ?? '').split('\n');
        // A text of several lines (or one and an empty one, or with KiCad's markup): a text a line, all told of the text they are
        // (KICADLINES: which, which line, how many, how far below KiCad's anchor), the first holding it as KiCad had it (KICADTEXT), for the way back
        const shown = lines.filter((t) => t.trim()).length, g = ++textN, anchor = P({ x: a.x, y: a.y });
        let first = true;
        lines.forEach((t, i) => {
          if (!t.trim()) return;
          const dy = i * e.size * 1.5;
          const p = P({ x: a.x, y: a.y + dy });
          const kept = { KICADLINES: `${g}:${i}:${shown}:${Math.round(anchor.y * SCH_UNIT) - Math.round(p.y * SCH_UNIT)}`, ...(first ? { KICADTEXT: keepJson(str(n) ?? ''), KICADTEXTN: keepJson(n), KICADTEXTF: String(fonts.id(e.size, e.bold, e.italic)) } : {}) };
          first = false;
          top({ RECORD: SR.LABEL, TEXT: t, FONTID: fonts.id(e.size, e.bold, e.italic), COLOR: COL.graphic, ORIENTATION: Math.round(a.a / 90) % 4, JUSTIFICATION: justification(e.hJust, e.vJust), ...kept },
            { LOCATION: p });
        });
        break;
      }
      case 'text_box': {
        const a = at(n), sz = kid(n, 'size'), e = effects(n);
        const p0 = P(a), p1 = P({ x: a.x + num(sz, 0), y: a.y + num(sz, 1) });
        // (its stroke and fill as AD's; KiCad's own kept, with its margins, text effects and exact size, for the way back)
        const lk = lookOf(n, COL.graphic, toBgr(0xffffff));
        const kx = [...readKept(lk.KICADX), ...['margins', 'effects', 'size'].map((k) => kid(n, k)).filter((x): x is SList => !!x)];
        const nostroke = (val(kid(n, 'stroke'), 'type') ?? '') === 'none' || valNum(kid(n, 'stroke'), 'width', 0) < 0;
        sealLook(top({ RECORD: SR.TEXT_FRAME, TEXT: plainText(str(n) ?? '').replace(/\n/g, '~1'), FONTID: fonts.id(e.size), COLOR: lk.COLOR, TEXTCOLOR: COL.graphic, AREACOLOR: lk.AREACOLOR,
          ISSOLID: lk.ISSOLID, SHOWBORDER: !nostroke, WORDWRAP: true, CLIPTORECT: true, TEXTMARGIN: 2, KICADX: keepJson(kx), KICADTEXT: keepJson(str(n) ?? '') },
          { LOCATION: { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) }, CORNER: { x: Math.max(p0.x, p1.x), y: Math.max(p0.y, p1.y) } }));
        break;
      }
      case 'polyline': {
        const list = pts(n).map(P);
        // (a closed one with a fill is a polygon)
        const lk = lookOf(n, COL.graphic);
        const closed = list.length > 3 && list[0]!.x === list[list.length - 1]!.x && list[0]!.y === list[list.length - 1]!.y && lk.ISSOLID === true;
        if (closed) sealLook(r.points({ RECORD: SR.POLYGON, OWNERPARTID: -1, ...lk }, list.slice(0, -1)));
        else if (list.length === 2) sealLook(top({ RECORD: SR.LINE, ...lk }, { LOCATION: list[0]!, CORNER: list[1]! }));
        else if (list.length > 2) sealLook(r.points({ RECORD: SR.POLYLINE, OWNERPARTID: -1, ...lk }, list));
        break;
      }
      case 'rectangle': {
        const a = P(xy(n, 'start')), b = P(xy(n, 'end'));
        // (drawn from another corner than the top left: which, for the way back)
        const s0 = xy(n, 'start'), e0 = xy(n, 'end'), from = `${s0.x > e0.x ? 'x' : ''}${s0.y > e0.y ? 'y' : ''}`;
        sealLook(top({ RECORD: SR.RECTANGLE, ...lookOf(n, COL.graphic), ...(from ? { KICADFROM: from } : {}) },
          { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } }));
        break;
      }
      case 'circle': {
        const c = kid(n, 'center'), rad = toU(valNum(n, 'radius'));
        sealLook(top({ RECORD: SR.ELLIPSE, ...lookOf(n, COL.graphic), ...radius('RADIUS', rad), ...radius('SECONDARYRADIUS', rad) }, { LOCATION: P({ x: num(c, 0), y: num(c, 1) }) }));
        break;
      }
      case 'arc': {
        const g = (k: string) => { const l = kid(n, k); return P({ x: num(l, 0), y: num(l, 1) }); };
        const arc = arcThrough(g('start'), g('mid'), g('end'));
        const lk = lookOf(n, COL.graphic);
        if (arc) sealLook(top({ RECORD: SR.ARC, LINEWIDTH: lk.LINEWIDTH, COLOR: lk.COLOR, KICADX: lk.KICADX, ...radius('RADIUS', arc.r), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: arc.c }));
        break;
      }
      case 'bezier': {
        const list = pts(n).map(P);
        const lk = lookOf(n, COL.graphic);
        if (list.length === 4) sealLook(r.points({ RECORD: SR.BEZIER, OWNERPARTID: -1, LINEWIDTH: lk.LINEWIDTH, COLOR: lk.COLOR, KICADX: lk.KICADX }, list));
        break;
      }
      case 'netclass_flag': case 'directive_label': {
        // KiCad's net class flag: a Parameter Set directive at its point, its fields the set's parameters (Netclass …), the flag kept whole for the way back
        const a = at(n), props = kids(n, 'property');
        const ps = top({ RECORD: SR.PARAMETER_SET, NAME: props.map((p) => str(p, 1) ?? '').filter(Boolean).join(', ') || 'Net Class', ORIENTATION: [3, 0, 1, 2][Math.round(a.a / 90) % 4] ?? 3, STYLE: 0, COLOR: COL.graphic,
          KICADNODE: keepJson(n), UNIQUEID: uniqueId() }, { LOCATION: P(a) });
        for (const p of props) {
          const pa = at(p), e = effects(p);
          r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ps - 1, OWNERPARTID: -1, NAME: str(p, 0) ?? '', TEXT: str(p, 1) ?? '', FONTID: fonts.id(e.size), COLOR: COL.text, ISHIDDEN: e.hidden || undefined }, { LOCATION: P(pa) });
        }
        break;
      }
      case 'image': {
        // A picture: its PNG embedded, as large as KiCad draws it (its pixels at its resolution, 300 ppi when it has none, times its scale)
        const bytes = base64Bytes(kids(n, 'data').flatMap((d) => d.items.map(String)).join(''));
        const png = pngInfo(bytes);
        if (!png) break;
        const sc = valNum(n, 'scale', 1), a = at(n);
        const w = (png.w / png.ppi) * 25.4 * sc, h = (png.h / png.ppi) * 25.4 * sc;
        const name = `${(ctx.file || 'sheet').replace(/^.*\//, '').replace(/\.kicad_sch$/i, '')}-picture${images.length + 1}.png`;
        images.push({ name, bytes });
        top({ RECORD: SR.IMAGE, FILENAME: name, EMBEDIMAGE: true, KEEPASPECT: true, ISSOLID: false, LINEWIDTH: 1, COLOR: COL.graphic, KICADSCALE: String(sc) },
          { LOCATION: P({ x: a.x - w / 2, y: a.y + h / 2 }), CORNER: P({ x: a.x + w / 2, y: a.y - h / 2 }) });
        break;
      }
      case 'symbol': placeSymbol(n); break;
      case 'sheet': placeSheet(n); break;
    }
  }

  /** A power symbol's pin's uuid, for the way back. */
  function pinUuid(n: SList): { KICADPINUUID?: string } {
    const v = val(kids(n, 'pin')[0], 'uuid');
    return v ? { KICADPINUUID: v } : {};
  }

  function placeSymbol(n: SList): void {
    // (a symbol with a lib_name uses the schematic's copy of that name: KiCad's changed copy of the library's)
    const lib = libs.get(val(n, 'lib_name') ?? '\u0000') ?? libs.get(val(n, 'lib_id') ?? '');
    if (!lib) return;
    const a = at(n), mirror = val(n, 'mirror');
    const t = symbolTransform(a.a, mirror);
    const place = (p: Xy) => { const s = apply(t, p); return P({ x: a.x + s.x, y: a.y + s.y }); };
    const inst = ctx.refs?.get(val(n, 'uuid') ?? '') ?? instanceOf(n, ctx);
    const value = str(prop(n, 'Value'), 1) ?? '';
    // A power symbol or flag as KiCad placed it, for the way back while the port or mark is what the import made (`sig`): its
    // library symbol, its fields, where and how it was turned, its reference; the KiCad place of its pin (`pin`: in the symbol)
    const powerKept = (sig: string, pin: Xy): Record<string, string> => {
      const s = apply(t, pin);
      return { KICADLIBID: lib.name, KICADLIBKEY: keepSymbol(lib.node), KICADPWRSIG: sig, KICADPROPS: keepJson(kids(n, 'property')), KICADSYMAT: `${a.x} ${a.y} ${a.a} ${mirror ?? ''}`,
        KICADHOT: `${a.x + s.x} ${a.y + s.y}`, KICADREF: inst.ref };
    };
    // A power flag only tells ERC a net is driven: no net of its own (a No ERC mark at its pin)
    if (/^PWR_FLAG$/i.test(value) || inst.ref.startsWith('#FLG')) {
      const pin = [...unitsOf(lib.node).values()].flat().flatMap((u) => kids(u, 'pin'))[0];
      // (marked as KiCad's flag, turned as it was, for the way back)
      if (pin) top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross', KICADPWRFLAG: true, KICADANGLE: Math.round(a.a), ...pinUuid(n),
        ...powerKept(`flag:${Math.round(a.a)}`, { x: num(kid(pin, 'at'), 0), y: num(kid(pin, 'at'), 1) }) },
        { LOCATION: place({ x: num(kid(pin, 'at'), 0), y: num(kid(pin, 'at'), 1) }) });
      return;
    }
    // A power symbol (also an old one without the flag: a #PWR part) is a port at its pin, pointing where its graphics lie
    if (lib.power || /^#PWR/i.test(inst.ref)) {
      const pin = kids(unitsOf(lib.node).get(1)?.[0] ?? lib.node, 'pin')[0] ?? unitsOf(lib.node).get(0)?.flatMap((u) => kids(u, 'pin'))[0];
      const hot = pin ? { x: num(kid(pin, 'at'), 0), y: num(kid(pin, 'at'), 1) } : { x: 0, y: 0 };
      const all = [...unitsOf(lib.node).values()].flat().flatMap((u) => u.items.filter((x): x is SList => typeof x === 'object' && 'k' in x && x.k !== 'pin'));
      const gp = all.flatMap((g) => [...pts(g), ...['start', 'end', 'center', 'mid'].map((k) => kid(g, k)).filter(Boolean).map((l) => ({ x: num(l, 0), y: num(l, 1) }))]);
      const cen = gp.length ? { x: gp.reduce((s, p) => s + p.x, 0) / gp.length, y: gp.reduce((s, p) => s + p.y, 0) / gp.length } : { x: hot.x, y: hot.y + 1 };
      const H0 = place(hot), C0 = place(cen);
      const ground = /^(GND|VSS|0V|DGND|GNDD|GNDREF|GNDPWR)/i.test(value) || /GND/i.test(lib.name) && !/A$/i.test(value);
      const style = /^(PE|Earth|EARTH)/.test(value) ? 6 : /^(AGND|GNDA|GNDS)/i.test(value) ? 5 : ground ? 4 : 2;
      top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: orientOf(H0, C0), TEXT: plainText(value), SHOWNETNAME: !effects(prop(n, 'Value')).hidden, COLOR: COL.power, UNIQUEID: uniqueId(), ...pinUuid(n),
        ...powerKept(`${style}:${orientOf(H0, C0)}:${plainText(value)}`, hot) }, { LOCATION: H0 });
      return;
    }
    const ad = adOrientation(t);
    const footprint = str(prop(n, 'Footprint'), 1) ?? '';
    const [fpLib, fpName] = footprint.includes(':') ? footprint.split(':', 2) as [string, string] : ['', footprint];
    const description = str(prop(n, 'Description'), 1) ?? '';
    const libRef = (lib.name.split(':').pop() ?? lib.name);
    const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: lib.units + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: inst.unit, ORIENTATION: ad.orient, ISMIRRORED: ad.mirrored || undefined,
      AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, COMPONENTDESCRIPTION: description || undefined, SOURCELIBRARYNAME: `${lib.name.includes(':') ? lib.name.split(':')[0] : 'Symbols'}.SchLib`,
      // KiCad's own IDs for the way back (kicadLibId)
      KICADLIBID: val(n, 'lib_id') || lib.name || undefined, KICADLIBKEY: keepSymbol(lib.node), KICADLIBNAME: val(n, 'lib_name') || undefined, KICADFOOTPRINT: footprint || undefined,
      // Not on the board: Graphical; on it but not in the BOM: Standard (No BOM)
      // (not on the board but in the BOM, which no kind of the desktop software's is: Graphical, KiCad's BOM flag kept for the way back)
      ...(flag(n, 'on_board') === false && kid(n, 'on_board') ? { COMPONENTKIND: 2, ...(flag(n, 'in_bom') !== false ? { KICADINBOM: true } : {}) } : kid(n, 'in_bom') && !flag(n, 'in_bom') ? { COMPONENTKINDVERSION2: 5 } : {}),
      UNIQUEID: uniqueIdFor(`${ctx.root && ctx.instance.startsWith(`/${ctx.root}`) ? ctx.instance.slice(ctx.root.length + 1) : ctx.instance}/${val(n, 'uuid') ?? ''}`), NOTUSEDBTABLENAME: undefined,
      // For the way back: its fields as KiCad had them (places, sizes, justification, hidden ones, empty ones), where and how it
      // was turned (KiCad's angle and mirror: 270° mirrored on x is 90° on y), its settings Konium makes nothing of (DNP …)
      KICADPROPS: keepJson(kids(n, 'property')), KICADSYMAT: `${a.x} ${a.y} ${a.a} ${mirror ?? ''}`,
      // (its pins as KiCad listed them: their uuids, an alternate function chosen)
      ...(kids(n, 'pin').length ? { KICADPINS: keepJson(kids(n, 'pin')) } : {}),
      ...((): { KICADSYMX?: string } => { const x = extrasOf(n, SYM_USED); return x.length ? { KICADSYMX: keepJson(x) } : {}; })() }, { LOCATION: P(a) });
    for (let u = 1; u <= lib.units; u++) emitUnit(r, lib, u, place, own(ci + 0, u), fonts);
    // Designator, comment and the other fields where KiCad shows them
    const field = (p: SList | undefined, name: string, text: string, record: number) => {
      if (!p) return;
      const e = effects(p), pa = at(p);
      // A field turns between horizontal and vertical with a symbol turned 90°, its justification with the symbol's turn and mirror (KiCad draws it in its turned box)
      const f = fieldFrame(t, pa.a);
      const h = e.hJust === 1 ? 1 : f.hFlip ? 2 - e.hJust : e.hJust, v = e.vJust === 1 ? 1 : f.vFlip ? 2 - e.vJust : e.vJust;
      r.add({ RECORD: record, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: name, TEXT: text, FONTID: fonts.id(e.size, e.bold, e.italic), COLOR: COL.text, ISHIDDEN: e.hidden || undefined,
        ORIENTATION: f.vertical ? 1 : 0, JUSTIFICATION: justification(h, v) }, { LOCATION: P(pa) });
    };
    field(prop(n, 'Reference'), 'Designator', inst.ref, SR.DESIGNATOR);
    field(prop(n, 'Value'), 'Comment', value, SR.PARAMETER);
    for (const p of kids(n, 'property')) {
      const k = str(p) ?? '';
      if (['Reference', 'Value', 'Footprint', 'Description', 'ki_fp_filters', 'ki_keywords', 'ki_description'].includes(k) || k.startsWith('Sim.')) continue;
      const v = str(p, 1) ?? '';
      if (!v) continue;
      field(p, k, v, SR.PARAMETER);
    }
    if (fpName) {
      const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
      const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: fpName, MODELTYPE: 'PCBLIB',
        DATAFILECOUNT: 1, MODELDATAFILEENTITY0: fpName, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: `${fpLib || 'Footprints'}.PcbLib`, ISCURRENT: true, UNIQUEID: uniqueId() });
      r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
      r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
    }
  }

  function placeSheet(n: SList): void {
    const a = at(n), sz = kid(n, 'size');
    const w = num(sz, 0), h = num(sz, 1);
    const sheetName = str(prop(n, 'Sheetname') ?? prop(n, 'Sheet name'), 1) ?? 'Sheet';
    const file = str(prop(n, 'Sheetfile') ?? prop(n, 'Sheet file'), 1) ?? '';
    const instance = `${ctx.instance}/${val(n, 'uuid') ?? ''}`;
    const child = ctx.childName(file, instance);
    ctx.onSheet(file, instance, sheetName);
    // (KiCad's settings for it kept: its exact size, its fields as placed, stroke, fill, flags; and where it was)
    const si = top({ RECORD: SR.SHEET_SYMBOL, XSIZE: Math.round(toU(w)), YSIZE: Math.round(toU(h)), LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true, UNIQUEID: uniqueId(),
      ...keptX(n, SHEET_USED), KICADSHEETAT: `${a.x} ${a.y} ${Math.round(toU(w))} ${Math.round(toU(h))}` }, { LOCATION: P(a) });
    const nameP = prop(n, 'Sheetname') ?? prop(n, 'Sheet name'), fileP = prop(n, 'Sheetfile') ?? prop(n, 'Sheet file');
    r.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: sheetName, FONTID: fonts.id(effects(nameP).size), COLOR: COL.text }, { LOCATION: P(nameP ? at(nameP) : { x: a.x, y: a.y - 1 }) });
    r.add({ RECORD: SR.FILE_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: child, FONTID: fonts.id(effects(fileP).size), COLOR: COL.text }, { LOCATION: P(fileP ? { ...at(fileP), y: at(fileP).y + 1.5 } : { x: a.x, y: a.y + h + 2 }) });
    for (const pin of kids(n, 'pin')) {
      const pa = at(pin), name = plainText(str(pin) ?? '');
      const io = ({ input: 2, output: 1, bidirectional: 3, tri_state: 3, passive: 0 } as Record<string, number>)[String(pin.items[1] ?? '')] ?? 0;
      const side = Math.abs(pa.x - a.x) < 0.01 ? 0 : Math.abs(pa.x - (a.x + w)) < 0.01 ? 1 : Math.abs(pa.y - a.y) < 0.01 ? 2 : 3;
      const dist = side < 2 ? pa.y - a.y : pa.x - a.x;    // mm from the top (or the left)
      const units = toU(dist) / 10;
      const whole = Math.floor(units + 1e-9), frac = Math.round((units - whole) * 10 * SCH_UNIT);
      r.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: si - 1, OWNERPARTID: -1, SIDE: side, DISTANCEFROMTOP: whole, DISTANCEFROMTOP_FRAC1: frac || undefined, NAME: name, ...rawOf(str(pin) ?? ''), IOTYPE: io, STYLE: side < 2 ? 3 : 7,
        COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, TEXTFONTID: fonts.id(effects(pin).size), UNIQUEID: uniqueId(),
        // (its uuid, KiCad's tri-state, for the way back)
        ...(val(pin, 'uuid') ? { KICADUUID: val(pin, 'uuid')! } : {}), ...(pin.items[1] === 'tri_state' ? { KICADSHAPE: 'tri_state' } : {}) });
    }
  }

  // The sheet record: KiCad's page as a custom sheet, its fonts
  r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
    CUSTOMX: Math.round(toU(W)), CUSTOMY: Math.round(toU(H)), CUSTOMXZONES: Math.max(4, Math.round(W / 50)), CUSTOMYZONES: Math.max(4, Math.round(H / 50)), CUSTOMMARGINWIDTH: 20,
    BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2,
    SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0, ...(ctx.file ? { KICADFILE: ctx.file } : {}),
    // KiCad's paper, for the way back (its size here is to the nearest 10 mil): its name and size in mm
    KICADPAPER: `${str(kid(root, 'paper')) ?? 'A4'} ${W} ${H}${flag(kid(root, 'paper'), 'portrait') ? ' portrait' : ''}`, ...(val(root, 'uuid') ? { KICADUUID: val(root, 'uuid')! } : {}) } as Record<string, string | number | boolean>);
  r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
  // Sheet parameters from the title block (as AD's special strings read them)
  const tb = kid(root, 'title_block');
  const params: [string, string | undefined][] = [['Title', val(tb, 'title')], ['Date', val(tb, 'date')], ['Revision', val(tb, 'rev')], ['CompanyName', val(tb, 'company')]];
  kids(tb, 'comment').forEach((c) => params.push([`Comment${num(c, 0)}`, str(c, 1)]));
  for (const [name, v] of params) if (v) r.add({ RECORD: SR.PARAMETER, OWNERINDEX: 0, OWNERPARTID: -1, NAME: name, TEXT: v, ISHIDDEN: true, LOCATION: undefined });
  r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));

  const rootEntry = newEntry('Root Entry', 'root');
  cfbPut(rootEntry, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
  cfbPut(rootEntry, 'Storage', storageStream(images));
  if (!symStore.size) return { bytes: writeCfb(rootEntry), title };
  // The library symbols its parts were placed from, one copy each; each part's symbol as the sheet holds it, read back: its fingerprint
  cfbPut(rootEntry, `${KEPT_SYMBOLS}/Data`, joinTextRecords([...symStore].map(([k, v]) => PropertyBag.fromEntries([['KEY', k], ['ITEMS', v]]))));
  const back = readSchDoc(writeCfb(rootEntry), 'kicad.SchDoc');
  for (const o of back.objects) {
    const b = o.kind === 'component' ? back.records[o.index + 1]?.bag : undefined;
    if (b?.has('KICADLIBKEY')) b.set('KICADLIBSIG', partSymbolSig(symbolOf(back, o.index).bags));
  }
  return { bytes: writeSchDoc(back), title };
}

/**
 * How KiCad shows a field of a symbol placed by `t` (the library-to-sheet transform) at `angle`:
 * KiCad turns the field's box with the symbol and draws the text in it, so a field may show
 * vertical, and its justification reversed along the text (hFlip) or across it (vFlip).
 */
export function fieldFrame(t: Tf, angle: number): { vertical: boolean; hFlip: boolean; vFlip: boolean } {
  const a90 = Math.round(angle / 90) % 2 !== 0;
  const vertical = a90 !== (t[1] !== 0);
  // The text's direction and its up, as shown (Y down): KiCad's own transform is t with Y the library's way up
  const d = a90 ? [t[1], t[3]] : [t[0], t[2]];
  const u = a90 ? [-t[0], -t[2]] : [t[1], t[3]];
  return { vertical, hFlip: vertical ? d[1]! > 0 : d[0]! < 0, vFlip: vertical ? u[0]! > 0 : u[1]! > 0 };
}

/** AD's ORIENTATION (90° steps anticlockwise) and ISMIRRORED for KiCad's transform (in AD's Y-up frame). */
export function adOrientation(t: Tf): { orient: number; mirrored: boolean } {
  const m = [t[0], t[1], -t[2], -t[3]];   // library → AD sheet
  for (const mirrored of [false, true]) {
    for (let k = 0; k < 4; k++) {
      const c = Math.round(Math.cos((k * Math.PI) / 2)), s = Math.round(Math.sin((k * Math.PI) / 2));
      const f = mirrored ? -1 : 1;
      // R(k) · diag(f, 1)
      const r = [c * f, -s, s * f, c];
      if (r.every((v, i) => v === m[i])) return { orient: k, mirrored };
    }
  }
  return { orient: 0, mirrored: false };
}

/* ── a whole schematic (hierarchy) ── */

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i + 1); };
/** a/b/../c → a/c */
export function normPath(p: string): string {
  const out: string[] = [];
  for (const s of p.replace(/\\/g, '/').split('/')) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
  return out.join('/');
}

/**
 * The project's schematics from its root sheet: each sheet instance a SchDoc. `files` holds the
 * .kicad_sch texts by path (relative paths as the sheets name them).
 */
export function convertSchematics(files: Map<string, string>, rootPath: string, project = ''): ConvertedSheet[] {
  const parsed = new Map<string, SList>();
  const get = (p: string) => { const k = normPath(p); if (!parsed.has(k)) { const t = files.get(k) ?? [...files.entries()].find(([q]) => normPath(q).toLowerCase() === k.toLowerCase())?.[1]; if (t === undefined) return null; parsed.set(k, parseSexpr(t)); } return parsed.get(k)!; };
  const rootTree = get(rootPath);
  if (!rootTree) throw new Error(`${baseName(rootPath)} wasn't among the files`);
  // KiCad 6: the root's symbol_instances list every symbol's designator by path
  const legacyRefs = new Map<string, { ref: string; unit: number }>();
  for (const p of kids(kid(rootTree, 'symbol_instances'), 'path')) legacyRefs.set(str(p) ?? '', { ref: val(p, 'reference') ?? '?', unit: valNum(p, 'unit', 1) });
  const used = new Map<string, number>();
  const nameFor = new Map<string, string>();
  const docName = (file: string, instance: string) => {
    const k = `${normPath(file)}|${instance}`;
    if (nameFor.has(k)) return nameFor.get(k)!;
    const stem = baseName(file).replace(/\.(kicad_sch|sch)$/i, '');
    const n = (used.get(stem.toLowerCase()) ?? 0) + 1;
    used.set(stem.toLowerCase(), n);
    const name = `${n > 1 ? `${stem}_${n}` : stem}.SchDoc`;
    nameFor.set(k, name);
    return name;
  };
  const out: ConvertedSheet[] = [];
  const rootUuid = val(rootTree, 'uuid') ?? '';
  const visit = (path: string, tree: SList, instance: string, depth: number) => {
    if (depth > 16) return;
    const children: ConvertedSheet['children'] = [];
    const here = dirOf(path);
    const refs = new Map<string, { ref: string; unit: number }>();
    if (legacyRefs.size) for (const s of kids(tree, 'symbol')) { const u = val(s, 'uuid') ?? ''; const hit = legacyRefs.get(`${instance}/${u}`) ?? legacyRefs.get(`${instance.replace(`/${rootUuid}`, '')}/${u}`); if (hit) refs.set(u, hit); }
    const name = docName(path, instance);
    const { bytes, title } = convertSheet(tree, {
      libs: new Map(), instance, project, refs, root: rootUuid, file: normPath(path),
      childName: (file, inst) => docName(here + file, inst),
      onSheet: (file, inst, sheetName) => children.push({ sheetName, file: here + file, instance: inst }),
    });
    out.push({ name, bytes, title, instance, children });
    for (const c of children) {
      const t = get(c.file);
      if (t) visit(c.file, t, c.instance, depth + 1);
    }
  };
  visit(rootPath, rootTree, `/${rootUuid}`, 0);
  return out;
}

/* ── symbol libraries ── */

/** A .kicad_sym library as an AD SchLib: each symbol a component (derived symbols with their parent's graphics). */
export function convertSymbolLibrary(text: string): { bytes: Uint8Array; count: number } {
  return convertSymbols(kids(parseSexpr(text), 'symbol'));
}

/**
 * The symbols the schematics carry (their lib_symbols, "Library:Name"), by library: each library's
 * SchLib, named as the components' Library Name gives it.
 */
export function schematicLibraries(trees: SList[]): Map<string, SList[]> {
  const out = new Map<string, Map<string, SList>>();
  for (const t of trees) for (const s of kids(kid(t, 'lib_symbols'), 'symbol')) {
    const full = str(s) ?? '';
    if (flag(s, 'power')) continue;
    const lib = full.includes(':') ? full.split(':')[0]! : 'Symbols';
    if (!out.has(lib)) out.set(lib, new Map());
    if (!out.get(lib)!.has(full)) out.get(lib)!.set(full, s);
  }
  return new Map([...out].map(([k, v]) => [k, [...v.values()]]));
}

/** Symbols as one SchLib (names after their library's prefix). */
export function convertSymbols(nodes: SList[]): { bytes: Uint8Array; count: number } {
  const all = new Map(nodes.map((s) => [str(s) ?? '', s]));
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  for (const [full, node] of all) {
    const name = full.includes(':') ? full.slice(full.indexOf(':') + 1) : full;
    // (extends "Parent"): the parent's units under this symbol's own fields
    const parent = val(node, 'extends');
    const pnode = parent ? all.get(parent) ?? all.get(full.includes(':') ? `${full.split(':')[0]}:${parent}` : parent) : undefined;
    const body = parent && pnode ? { k: 'symbol', items: [...node.items, ...pnode.items.filter((x) => typeof x === 'object' && 'k' in x && x.k === 'symbol').map((x) => ({ ...(x as SList), items: [String((x as SList).items[0]).replace(parent, name), ...(x as SList).items.slice(1)] }))] } as SList : node;
    const lib = libSym(body);
    const r = new Records();
    const fonts = new Fonts();
    const desc = str(prop(node, 'Description'), 1) ?? str(prop(node, 'ki_description'), 1) ?? '';
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: name, COMPONENTDESCRIPTION: desc || undefined, PARTCOUNT: lib.units + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: name, UNIQUEID: uniqueId(),
      // KiCad's symbol as it was, for the way back while the symbol is what the import made (KICADSIG, below)
      KICADSRC: keepJson(node) });
    const place = (p: Xy) => ({ x: toU(p.x), y: toU(p.y) });
    for (let u = 1; u <= lib.units; u++) emitUnit(r, lib, u, place, { OWNERPARTID: u }, fonts);
    const fld = (k: string, rec: number, nm: string, text: string) => {
      const p = prop(node, k);
      if (!p) return;
      const e = effects(p), pa = at(p);
      r.add({ RECORD: rec, OWNERPARTID: -1, NAME: nm, TEXT: text, FONTID: 1, COLOR: COL.text, ISHIDDEN: e.hidden || undefined, JUSTIFICATION: justification(e.hJust, e.vJust),
        ORIENTATION: Math.round(pa.a / 90) % 2 }, { LOCATION: place({ x: pa.x, y: pa.y }) });
    };
    fld('Reference', SR.DESIGNATOR, 'Designator', `${str(prop(node, 'Reference'), 1) ?? 'U'}?`);
    fld('Value', SR.PARAMETER, 'Comment', str(prop(node, 'Value'), 1) ?? name);
    // Its other fields as parameters (as a placed symbol's; KiCad's keywords and footprint filters aside)
    for (const p of kids(node, 'property')) {
      const k = str(p) ?? '', v = str(p, 1) ?? '';
      if (!v || ['Reference', 'Value', 'Footprint', 'Description', 'ki_fp_filters', 'ki_keywords', 'ki_description'].includes(k) || k.startsWith('Sim.')) continue;
      fld(k, SR.PARAMETER, k, v);
    }
    const fp = str(prop(node, 'Footprint'), 1) ?? '';
    if (fp) {
      const [fpLib, fpName] = fp.includes(':') ? fp.split(':', 2) as [string, string] : ['', fp];
      const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
      const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: fpName, MODELTYPE: 'PCBLIB',
        DATAFILECOUNT: 1, MODELDATAFILEENTITY0: fpName, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: `${fpLib || 'Footprints'}.PcbLib`, ISCURRENT: true, UNIQUEID: uniqueId() });
      r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
      r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
    }
    symbols.push({ libRef: name, description: desc, parts: lib.units, bags: r.bags });
  }
  // Each symbol's records as the library holds them, read back: their fingerprint, KiCad's symbol theirs while they are the same
  const back = readSchLib(writeSchLib(symbols), 'kicad.SchLib');
  symbols.forEach((sym, i) => { const b = back.symbols[i]; if (b && b.libRef === sym.libRef) sym.bags[0]!.set('KICADSIG', bagsSig(b.bags)); });
  return { bytes: writeSchLib(symbols), count: symbols.length };
}
