/**
 * DipTrace schematics as AD's: a SchDoc per sheet, a SchLib of the components placed (each
 * component a symbol, its sections the symbol's parts, each pin's designator the pad it binds to),
 * parts placed as DipTrace turns and flips them with their reference, value and fields where
 * DipTrace shows them and their pattern as the footprint; power and net-port parts as power ports
 * named by their net; the nets' wires with their junctions; not-connected marks; net-name labels;
 * buses; the sheets' drawing and text. DipTrace's nets are design-wide: the project's Net
 * Identifier Scope is Global, and each piece of a net drawn apart gets a label of its name.
 * Hierarchy blocks are drawn as they look, their sheets flat [est]. DipTrace's units, Y up, as AD's
 * 10 mil units.
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
import { uniqueIdFor } from '../kicad/board';
import { kid, kidsOf, type XEl } from '../xml';
import { deg, dnum, dtext, dyes, live, textLines, type DtDoc } from './read';

type Pt = { x: number; y: number };
export interface DtSchResult {
  sheets: { name: string; bytes: Uint8Array }[];
  library: Uint8Array;
  symbols: number;
  warnings: string[];
  stats: { sheets: number; parts: number; nets: number; symbols: number };
  /** The pattern styles the parts use. */
  patterns: Set<string>;
  /** Each net's name by its pins ("R1.2"). */
  netOfPin: Map<string, string>;
}

/** mm → AD's schematic unit (10 mil). */
const U = (mm: number) => mm / 0.254;
const norm = (a: number) => ((a % 360) + 360) % 360;
const quarter = (a: number) => Math.round(norm(a) / 90) % 4;
const SHAPES = ['Undefined', 'Line', 'Arc', 'Arrow', 'Rectangle', 'FillRect', 'Obround', 'FillObround', 'Polyline', 'Polygon', 'Text', 'Picture'];
const kindOf = (e: XEl) => { const t = e.attrs.Type ?? ''; return /^\d+$/.test(t) ? SHAPES[Number(t)] ?? t : t; };
const SHOW = ['Any Text', 'Name', 'RefDes', 'Value', 'Part Name', 'Manufacturer', 'Datasheet'];
const ELECTRICAL: Record<string, number> = { Input: 0, Bidirectional: 1, Output: 2, 'Open Low': 3, Passive: 4, '3 State': 5, 'Open High': 6, Power: 7, 'Passive High': 4, 'Passive Low': 4, Undefined: 4 };
/** DipTrace's pin types as AD's pin symbols. */
const PIN_SYMBOL: Record<string, Props> = { Dot: { SYMBOL_OUTEREDGE: 1 }, Clock: { SYMBOL_INNEREDGE: 3 }, 'Polarity In': { SYMBOL_OUTEREDGE: 2 }, 'Polarity Out': { SYMBOL_OUTEREDGE: 4 },
  'Open': { SYMBOL_INNER: 6 }, 'Open High': { SYMBOL_INNER: 7 }, 'Open Low': { SYMBOL_INNER: 6 }, '3 State': { SYMBOL_INNER: 8 }, Hysteresis: { SYMBOL_INNER: 9 }, Postponed: { SYMBOL_INNER: 1 }, Shift: { SYMBOL_INNER: 4 }, 'Non Logic': { SYMBOL_OUTER: 31 } };
const PIN_TYPES = ['Default', 'Dot', 'Polarity In', 'Polarity Out', 'Non Logic', 'Open', 'Open High', 'Open Low', '3 State', 'Hysteresis', 'Amplifier', 'Postponed', 'Shift', 'Clock', 'Generator'];
const lineWidth = (mm: number) => (mm < 0.15 ? 0 : mm < 0.4 ? 1 : mm < 0.8 ? 2 : 3);
/** A DipTrace font size (points) as an AD font id's size: points as points (Konium's 1.27 mm is 10 pt). */
const fontMmOf = (pt: number) => Math.max(4, pt) * 0.127;
/** An automatic net name (DipTrace's "Net 12"). */
export const autoDtNet = (n: string) => /^Net ?\d+$/i.test(n.trim());

/** A part's placement: file units in its section's frame → mm on the sheet. */
interface Tf { pt: (q: Pt) => Pt; dir: (v: Pt) => Pt; angle: number; mirror: boolean }
function placer(K: number, x: number, y: number, angle: number, hflip: boolean, vflip: boolean, ox: number, oy: number): Tf {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const fx = hflip ? -1 : 1, fy = vflip ? -1 : 1;
  const rot = (v: Pt) => ({ x: v.x * c - v.y * s, y: v.x * s + v.y * c });
  return {
    pt: (q) => { const r = rot({ x: (q.x - ox) * K * fx, y: (q.y - oy) * K * fy }); return { x: x + r.x, y: y + r.y }; },
    dir: (v) => rot({ x: v.x * fx, y: v.y * fy }),
    angle, mirror: hflip !== vflip,
  };
}

interface DrawCtx { rr: Records; fonts: Fonts; lib?: boolean; P: (p: Pt) => Pt; warn: (w: string) => void; K: number }
const fontOf = (ctx: DrawCtx, pt: number) => (ctx.lib ? 1 : ctx.fonts.id(fontMmOf(pt)));
const alignH = (s: string | undefined) => (s === 'Left' ? 0 : s === 'Right' ? 2 : 1);
const alignV = (s: string | undefined) => (s === 'Bottom' ? 0 : s === 'Top' ? 2 : 1);

/** A section's (or a sheet's) shapes through `tf`, owned as `own`; texts showing fields through `resolve`. */
function drawShapes(ctx: DrawCtx, shapes: XEl[], tf: Tf, own: Props, colour: number, resolve?: (show: string) => string | undefined): void {
  const { rr, P, K } = ctx;
  for (const e of shapes) {
    if (!live(e)) continue;
    const pts = kidsOf(kid(e, 'Points'), 'Point').map((p) => P(tf.pt({ x: dnum(p, 'X'), y: dnum(p, 'Y') })));
    const w = lineWidth(dnum(e, 'LineWidth', 0.25 / K) * K);
    const col = e.attrs.Color !== undefined ? dnum(e, 'Color') : colour;
    const look = { COLOR: col, LINEWIDTH: w };
    switch (kindOf(e)) {
      case 'Line': if (pts.length >= 2) rr.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: pts[0]!, CORNER: pts[1]! }); break;
      case 'Polyline': case 'Arrow': if (pts.length >= 2) rr.points({ RECORD: SR.POLYLINE, ...own, ...look }, pts); break;
      case 'Arc': {
        if (pts.length < 3) break;
        const t = arcThrough(pts[0]!, pts[1]!, pts[2]!);
        if (t) rr.add({ RECORD: SR.ARC, ...own, ...look, ...radius('RADIUS', t.r), STARTANGLE: t.start.toFixed(3), ENDANGLE: t.end.toFixed(3) }, { LOCATION: t.c });
        else rr.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: pts[0]!, CORNER: pts[2]! });
        break;
      }
      case 'Rectangle': case 'FillRect': case 'Obround': case 'FillObround': {
        if (pts.length < 2) break;
        const solid = /^Fill/.test(kindOf(e));
        const a = pts[0]!, b = pts[1]!;
        const xa = Math.min(a.x, b.x), xb = Math.max(a.x, b.x), ya = Math.min(a.y, b.y), yb = Math.max(a.y, b.y);
        const fill = { AREACOLOR: solid ? col : COL.fill, ISSOLID: solid, TRANSPARENT: !solid || undefined };
        if (/Obround/.test(kindOf(e))) {
          const r = Math.min(xb - xa, yb - ya) / 2;
          rr.add({ RECORD: SR.ROUND_RECTANGLE, ...own, ...look, ...fill, ...radius('CORNERXRADIUS', r), ...radius('CORNERYRADIUS', r) }, { LOCATION: { x: xa, y: ya }, CORNER: { x: xb, y: yb } });
        } else if (tf.angle % 90 === 0) rr.add({ RECORD: SR.RECTANGLE, ...own, ...look, ...fill }, { LOCATION: { x: xa, y: ya }, CORNER: { x: xb, y: yb } });
        else {
          const raw = kidsOf(kid(e, 'Points'), 'Point').map((p) => ({ x: dnum(p, 'X'), y: dnum(p, 'Y') }));
          const q = [{ x: raw[0]!.x, y: raw[0]!.y }, { x: raw[1]!.x, y: raw[0]!.y }, { x: raw[1]!.x, y: raw[1]!.y }, { x: raw[0]!.x, y: raw[1]!.y }].map((v) => P(tf.pt(v)));
          if (solid) rr.points({ RECORD: SR.POLYGON, ...own, ...look, ...fill }, q); else rr.points({ RECORD: SR.POLYLINE, ...own, ...look }, [...q, q[0]!]);
        }
        break;
      }
      case 'Polygon': if (pts.length >= 3) rr.points({ RECORD: SR.POLYGON, ...own, ...look, AREACOLOR: col, ISSOLID: true }, pts); break;
      case 'Text': {
        if (!pts.length) break;
        const showRaw = e.attrs.TextShow ?? 'Any Text';
        const show = /^\d+$/.test(showRaw) ? SHOW[Number(showRaw)] ?? 'Any Text' : showRaw;
        const lines = show === 'Any Text' || !resolve ? textLines(e) : [resolve(show) ?? ''];
        textInto(ctx, own, lines, pts[0]!, tf.angle + deg(dnum(e, 'Angle')), e.attrs.HorzAlign, e.attrs.VertAlign, dnum(e, 'FontSizeFloat', dnum(e, 'FontSize', 10)), dnum(e, 'LineSpacing', 1.2),
          e.attrs.FontColor !== undefined ? dnum(e, 'FontColor') : COL.text);
        break;
      }
      case 'Picture': ctx.warn('Pictures left out'); break;
      default:
    }
  }
}

/** Lines of text as labels from their anchor (AD units), down the text's own way. */
function textInto(ctx: DrawCtx, own: Props, lines: string[], at: Pt, angle: number, horz: string | undefined, vert: string | undefined, sizePt: number, spacing: number, colour: number): void {
  const o = quarter(angle);
  const h = alignH(horz), v = alignV(vert);
  const pitch = U(fontMmOf(sizePt)) * 1.4 * spacing;
  const a = ((o * 90 - 90) * Math.PI) / 180;
  const down = { x: Math.round(Math.cos(a) * 1e6) / 1e6, y: Math.round(Math.sin(a) * 1e6) / 1e6 };
  const shift = v === 0 ? -(lines.length - 1) : v === 1 ? -(lines.length - 1) / 2 : 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const k = (i + shift) * pitch;
    ctx.rr.add({ RECORD: SR.LABEL, ...own, TEXT: line, FONTID: fontOf(ctx, sizePt), COLOR: colour, ORIENTATION: o, JUSTIFICATION: justification(h, v) }, { LOCATION: { x: at.x + down.x * k, y: at.y + down.y * k } });
  });
}

interface PinOut { index: number; tip: Pt; body: Pt; name: string; number: string; outward: number }
/** A section's pins: each at its body end pointing out to its tip, where it connects. */
function drawPins(ctx: DrawCtx, section: XEl, tf: Tf, own: Props, showNumbers: boolean): PinOut[] {
  const out: PinOut[] = [];
  kidsOf(kid(section, 'Pins'), 'Pin').forEach((p, index) => {
    if (!live(p)) return;
    const o = dnum(p, 'Orientation');
    const L = dnum(p, 'Length') * ctx.K;
    // The pin points out from its body end: orientation 0 to the left, 90 up [est for the vertical ones]
    const v = tf.dir({ x: -Math.cos((o * Math.PI) / 180), y: Math.sin((o * Math.PI) / 180) });
    const bodyMm = tf.pt({ x: dnum(p, 'X'), y: dnum(p, 'Y') });
    const tipMm = { x: bodyMm.x + v.x * L, y: bodyMm.y + v.y * L };
    const body = ctx.P(bodyMm), tip = ctx.P(tipMm);
    const outward = L > 0 ? orientOf(body, tip) : quarter((Math.atan2(v.y, v.x) * 180) / Math.PI);
    const name = dtext(p, 'Name'), number = dtext(p, 'PadNumber') || name || String(index + 1);
    const typeRaw = p.attrs.Type ?? 'Default';
    const type = /^\d+$/.test(typeRaw) ? PIN_TYPES[Number(typeRaw)] ?? 'Default' : typeRaw;
    const showName = dyes(p, 'ShowName', true);
    ctx.rr.add({ RECORD: SR.PIN, ...own, ELECTRICAL: ELECTRICAL[p.attrs.ElectricType ?? 'Undefined'] ?? 4,
      PINCONGLOMERATE: outward | (showName && name ? 0x08 : 0) | (showNumbers ? 0x10 : 0), ...lengthKeys(U(L)), NAME: name || number, DESIGNATOR: number, COLOR: COL.pin, ...(PIN_SYMBOL[type] ?? {}) }, { LOCATION: body });
    out.push({ index, tip, body, name, number, outward });
  });
  return out;
}

/** A component's sections. */
const sectionsOf = (comp: XEl | undefined) => kidsOf(comp, 'Part');
const first = (comp: XEl | undefined) => sectionsOf(comp)[0];
const origin = (section: XEl | undefined) => { const o = kid(section, 'Origin'); return { ox: dnum(o, 'X'), oy: dnum(o, 'Y') }; };
const partType = (section: XEl | undefined) => section?.attrs.PartType ?? 'Normal';
const showNumbersOf = (section: XEl | undefined, globalShow: boolean) => { const s = section?.attrs.ShowNumbers ?? 'Common'; return s === 'Show' || s === '1' ? true : s === 'Hide' || s === '2' ? false : globalShow; };

/* ── the library ── */

export interface DtSymbol { style: string; libRef: string; footprint: string }
/** Library references for components: their names, made unique. */
export function symbolNames(doc: DtDoc, styles: string[]): Map<string, string> {
  const out = new Map<string, string>(), taken = new Set<string>();
  for (const st of styles) {
    const base = (dtext(first(doc.components.get(st)), 'Name') || st).replace(/[\\/:*?"<>|]/g, '_');
    let n = base;
    for (let k = 2; taken.has(n.toUpperCase()); k++) n = `${base}_${k}`;
    taken.add(n.toUpperCase());
    out.set(st, n);
  }
  return out;
}

/** Components as a SchLib: each section a part, its pins numbered by the pads they bind to. */
export function dipTraceSymbolLibrary(doc: DtDoc, symbols: DtSymbol[], footprintLib = ''): { bytes: Uint8Array; count: number; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const out: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  for (const { style, libRef, footprint } of symbols) {
    const comp = doc.components.get(style);
    const secs = sectionsOf(comp);
    if (!secs.length) continue;
    const rr = new Records(), fonts = new Fonts();
    const f = secs[0]!;
    rr.add({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, COMPONENTDESCRIPTION: dtext(f, 'Name') || undefined, PARTCOUNT: secs.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, UNIQUEID: uniqueId() });
    const ctx: DrawCtx = { rr, fonts, lib: true, P: (p) => ({ x: U(p.x), y: U(p.y) }), warn, K: doc.k };
    secs.forEach((sec, i) => {
      const { ox, oy } = origin(sec);
      const tf = placer(doc.k, 0, 0, 0, false, false, ox, oy);
      drawShapes(ctx, kidsOf(kid(sec, 'Shapes'), 'Shape'), tf, { OWNERPARTID: i + 1 }, COL.body, (s) => (s === 'RefDes' ? `${f.attrs.RefDes ?? 'U'}?` : s === 'Name' ? dtext(f, 'Name') : s === 'Value' ? dtext(sec, 'Value') : s === 'Part Name' ? dtext(sec, 'PartName') : s === 'Manufacturer' ? dtext(f, 'Manufacturer') : dtext(f, 'Datasheet')));
      drawPins(ctx, sec, tf, { OWNERPARTID: i + 1 }, showNumbersOf(sec, true));
    });
    const h = dnum(f, 'Height') * doc.k;
    rr.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${f.attrs.RefDes || 'U'}?`, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: U(h / 2) + 3 } });
    rr.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: dtext(f, 'Value') || '*', FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: -U(h / 2) - 8 } });
    for (const [k, v] of [['Manufacturer', dtext(f, 'Manufacturer')], ['Datasheet', dtext(f, 'Datasheet')], ...kidsOf(kid(f, 'AddFields'), 'AddField').map((a) => [dtext(a, 'Name'), dtext(a, 'Text')])] as [string, string][]) {
      if (k && v) rr.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: k, TEXT: v, FONTID: 1, COLOR: COL.text, ISHIDDEN: true }, { LOCATION: { x: 0, y: 0 } });
    }
    if (footprint) implementation(rr, undefined, footprint, footprintLib);
    if (secs.some((s) => partType(s) === 'Hierarchy Block')) warn('Hierarchy blocks kept as symbols');
    out.push({ libRef, description: dtext(f, 'Name'), parts: secs.length, bags: rr.bags });
  }
  return { bytes: writeSchLib(out), count: out.length, warnings };
}

/** The footprint as the symbol's implementation (owned by the component at `sheetComp` on a sheet, else the library symbol's first record). */
function implementation(rr: Records, sheetComp: number | undefined, footprint: string, footprintLib: string): void {
  const shift = sheetComp === undefined ? 0 : 1;
  const list = rr.add({ RECORD: SR.IMPLEMENTATION_LIST, ...(sheetComp === undefined ? {} : { OWNERINDEX: sheetComp - 1 }), OWNERPARTID: -1 });
  const impl = rr.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - shift, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: footprint, MODELTYPE: 'PCBLIB',
    DATAFILECOUNT: 1, MODELDATAFILEENTITY0: footprint, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
  rr.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - shift, OWNERPARTID: -1 });
  rr.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - shift, OWNERPARTID: -1 });
}

/* ── the schematic ── */

export function convertDipTraceSch(doc: DtDoc, stem: string, footprintLib: string, footprintOf: (patternStyle: string) => string): DtSchResult {
  const sch = doc.body;
  const K = doc.k;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const settings = kid(sch, 'Settings');
  const marks = kid(settings, 'Markings');
  const globalSize = dnum(marks, 'FontSizeFloat', dnum(marks, 'FontSize', 10));
  const pinNumbersVisible = (kid(settings, 'PinNumbers')?.attrs.Visible ?? 'Y') !== 'N';
  const netFont = dnum(kid(settings, 'NetName'), 'FontSizeFloat', dnum(kid(settings, 'NetName'), 'FontSize', 8));

  const sheetEls = kidsOf(kid(kid(sch, 'SheetSettings'), 'Sheets'), 'Sheet');
  const fieldOf = (e: XEl, k: string) => e.attrs[k] ?? dtext(e, k);
  const sheets = (sheetEls.length ? sheetEls : [{ name: 'Sheet', attrs: { Id: '0', Name: 'Sheet1' }, children: [], text: '' } as XEl]).map((s, i) => ({
    id: Number(fieldOf(s, 'Id') || i), name: fieldOf(s, 'Name') || `Sheet${i + 1}`, w: Number(fieldOf(s, 'SheetWidth') || 0) * K, h: Number(fieldOf(s, 'SheetHeight') || 0) * K, block: /Hierarchy|^1$/.test(fieldOf(s, 'Type')),
  }));
  if (sheets.some((s) => s.block)) warnOnce('Hierarchy blocks drawn as they look and their sheets kept flat; their nets joined by name [est]');

  const parts = kidsOf(kid(sch, 'Components'), 'Part').filter(live);
  const partById = new Map(parts.map((p, i) => [dnum(p, 'Id', i), p]));
  const netEls = kidsOf(kid(sch, 'Nets'), 'Net').filter(live);
  const netName = new Map<number, string>();
  const taken = new Set<string>();
  netEls.forEach((n, i) => {
    let nm = dtext(n, 'Name') || `Net ${dnum(n, 'Id', i)}`;
    for (let k = 2; taken.has(nm.toUpperCase()); k++) nm = `${dtext(n, 'Name') || 'Net'}_${k}`;
    taken.add(nm.toUpperCase());
    netName.set(dnum(n, 'Id', i), nm);
  });
  // A pin's net: the part's own pin list (authoritative), else the nets' item lists
  const pinNet = new Map<string, number>();
  for (const n of netEls) for (const it of kidsOf(kid(n, 'Pins'), 'Item')) pinNet.set(`${it.attrs.Part}:${it.attrs.Pin}`, dnum(n, 'Id', -1));
  for (const p of parts) kidsOf(kid(p, 'Pins'), 'Pin').forEach((pin, j) => { const v = dnum(pin, 'NetId', -1); if (v >= 0) pinNet.set(`${p.attrs.Id}:${j}`, v); });

  /* The symbols the parts use */
  const usedStyles = [...new Set(parts.map((p) => p.attrs.ComponentStyle ?? '').filter((s) => doc.components.has(s) && partType(first(doc.components.get(s))) !== 'Net Port' && partType(first(doc.components.get(s))) !== 'Power'))];
  const libRefs = symbolNames(doc, usedStyles);
  const patterns = new Set<string>();
  const footprintFor = (style: string) => { const ps = kid(first(doc.components.get(style)), 'Pattern'); const st = ps?.attrs.Style ?? ps?.attrs.PatternType ?? ''; if (st && doc.patterns.has(st)) { patterns.add(st); return footprintOf(st); } return ''; };
  const symbols: DtSymbol[] = usedStyles.map((st) => ({ style: st, libRef: libRefs.get(st)!, footprint: footprintFor(st) }));

  /* Each part's placement and pins (sheet mm) */
  interface Placed { part: XEl; comp: XEl | undefined; section: XEl | undefined; tf: Tf; sheet: number; kind: string }
  const placedOf = new Map<XEl, Placed>();
  for (const p of parts) {
    const comp = doc.components.get(p.attrs.ComponentStyle ?? '');
    const secs = sectionsOf(comp);
    const section = secs[dnum(p, 'ComponentPart')] ?? secs[0];
    const { ox, oy } = origin(section);
    const tf = placer(K, dnum(p, 'X') * K, dnum(p, 'Y') * K, norm(deg(dnum(p, 'Angle'))), dyes(p, 'HorzFlip'), dyes(p, 'VertFlip'), ox, oy);
    placedOf.set(p, { part: p, comp, section, tf, sheet: dnum(p, 'Sheet'), kind: partType(first(comp)) });
  }
  const pinTipMm = (pl: Placed, j: number): Pt | undefined => {
    const pin = kidsOf(kid(pl.section, 'Pins'), 'Pin')[j];
    if (!pin) return undefined;
    const o = dnum(pin, 'Orientation'), L = dnum(pin, 'Length') * K;
    const v = pl.tf.dir({ x: -Math.cos((o * Math.PI) / 180), y: Math.sin((o * Math.PI) / 180) });
    const b = pl.tf.pt({ x: dnum(pin, 'X'), y: dnum(pin, 'Y') });
    return { x: b.x + v.x * L, y: b.y + v.y * L };
  };

  /* Each net's pieces design-wide (wires and pins joined by their ends and their links), and which carry what names */
  interface Piece { net: number; sheet: number; at: Pt; port: boolean; labelled: boolean; pins: string[] }
  const pieces: Piece[] = [];
  const pieceOfWire = new Map<XEl, Piece>();
  const pieceOfPin = new Map<string, Piece>();
  for (const n of netEls) {
    const nid = dnum(n, 'Id', -1);
    const wires = kidsOf(kid(n, 'Wires'), 'Wire').filter(live);
    const parent = new Map<string, string>();
    const find = (a: string): string => { let r = a; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(a, r); return r; };
    const add = (a: string) => { if (!parent.has(a)) parent.set(a, a); };
    const join = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const key = (sheet: number, q: Pt) => `${sheet}@${Math.round(q.x * 1000)},${Math.round(q.y * 1000)}`;
    const wireById = new Map<number, XEl>();
    wires.forEach((w, i) => { wireById.set(dnum(w, 'Id', i), w); add(`w${i}`); });
    wires.forEach((w, i) => {
      const sheet = dnum(w, 'Sheet');
      const pts = kidsOf(kid(w, 'Points'), 'Point').map((q) => ({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }));
      pts.forEach((q) => join(`w${i}`, key(sheet, q)));
      for (const end of ['1', '2']) {
        const c = w.attrs[`Connected${end}`] ?? '';
        const obj = dnum(w, `Object${end}`, -1), sub = dnum(w, `SubObject${end}`, -1);
        if ((c === 'Pin' || c === '0') && obj >= 0) join(`w${i}`, `p${obj}:${sub}`);
        if ((c === 'Wire' || c === '1') && wireById.has(obj)) join(`w${i}`, `w${wires.indexOf(wireById.get(obj)!)}`);
      }
    });
    // Pins of the net: by their own ids, and at their tips
    const pinKeys = [...pinNet].filter(([, v]) => v === nid).map(([k]) => k);
    for (const pk of pinKeys) {
      const [pid, j] = pk.split(':').map(Number) as [number, number];
      const pl = partById.get(pid) ? placedOf.get(partById.get(pid)!) : undefined;
      if (!pl) continue;
      add(`p${pk}`);
      const tip = pinTipMm(pl, j);
      if (tip) join(`p${pk}`, key(pl.sheet, tip));
    }
    const groups = new Map<string, Piece>();
    const pieceFor = (k: string, sheet: number, at: Pt): Piece => {
      const r = find(k);
      let g = groups.get(r);
      if (!g) { g = { net: nid, sheet, at, port: false, labelled: false, pins: [] }; groups.set(r, g); pieces.push(g); }
      return g;
    };
    wires.forEach((w, i) => { const q = kid(kid(w, 'Points'), 'Point'); pieceOfWire.set(w, pieceFor(`w${i}`, dnum(w, 'Sheet'), { x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K })); });
    for (const pk of pinKeys) {
      if (!parent.has(`p${pk}`)) continue;
      const [pid, j] = pk.split(':').map(Number) as [number, number];
      const pl = placedOf.get(partById.get(pid)!)!;
      const g = pieceFor(`p${pk}`, pl.sheet, pinTipMm(pl, j) ?? pl.tf.pt({ x: 0, y: 0 }));
      pieceOfPin.set(pk, g);
      if (pl.kind === 'Net Port' || pl.kind === 'Power') g.port = true;
      g.pins.push(pk);
    }
  }
  // Net-name texts name their pieces
  const shapes = kidsOf(kid(sch, 'Shapes'), 'Shape').filter(live);
  const labelShapes = shapes.filter((s) => kindOf(s) === 'Text' && dnum(s, 'NetId', -1) >= 0);
  const nearestPiece = (net: number, sheet: number, at: Pt) => {
    let best: Piece | undefined, bd = Infinity;
    for (const pc of pieces) if (pc.net === net && pc.sheet === sheet) { const d = Math.hypot(pc.at.x - at.x, pc.at.y - at.y); if (d < bd) { bd = d; best = pc; } }
    return best;
  };
  for (const s of labelShapes) { const q = kid(kid(s, 'Points'), 'Point'); const pc = nearestPiece(dnum(s, 'NetId'), dnum(s, 'Sheet'), { x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }); if (pc) pc.labelled = true; }
  const byNet = new Map<number, Piece[]>();
  for (const pc of pieces) byNet.set(pc.net, [...(byNet.get(pc.net) ?? []), pc]);
  const needsLabel = (pc: Piece) => {
    if (pc.labelled) return false;
    const all = byNet.get(pc.net)!;
    const nm = netName.get(pc.net) ?? '';
    if (all.length === 1) return !autoDtNet(nm) && !pc.port;
    if (!pc.port) return true;
    const mixed = all.some((x) => !x.port && !x.labelled) || all.some((x) => x.labelled);
    return mixed && all.find((x) => x.port) === pc;
  };

  /* ── each sheet ── */
  const out: { name: string; bytes: Uint8Array }[] = [];
  const placedParts = new Set<string>();
  const usedNets = new Set<string>();
  const netOfPin = new Map<string, string>();
  sheets.forEach((sh, si) => {
    const rr = new Records(), fonts = new Fonts();
    rr.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const sheetIndex = rr.bags.length;
    rr.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
    const top = (props: Props, coords?: Record<string, Pt>) => rr.add({ ...props, OWNERPARTID: -1 }, coords);
    const mine = [...placedOf.values()].filter((pl) => pl.sheet === sh.id);
    const myWires = netEls.flatMap((n) => kidsOf(kid(n, 'Wires'), 'Wire').filter((w) => live(w) && dnum(w, 'Sheet') === sh.id).map((w) => ({ n, w })));
    const myShapes = shapes.filter((s) => dnum(s, 'Sheet') === sh.id);
    const myBuses = kidsOf(kid(sch, 'Buses'), 'Bus').flatMap((b) => kidsOf(kid(b, 'Wires'), 'Wire').filter((w) => dnum(w, 'Sheet') === sh.id).map((w) => ({ b, w })));

    /* Where everything is (mm): the sheet half an inch round it, on a 2.54 mm grid */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (q: Pt) => { if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); };
    for (const pl of mine) {
      see(pl.tf.pt({ x: 0, y: 0 }));
      const w = dnum(pl.section, 'Width') / 2, h = dnum(pl.section, 'Height') / 2;
      const { ox, oy } = origin(pl.section);
      for (const q of [{ x: -w + ox, y: -h + oy }, { x: w + ox, y: h + oy }]) see(pl.tf.pt(q));
      kidsOf(kid(pl.section, 'Pins'), 'Pin').forEach((_, j) => { const t = pinTipMm(pl, j); if (t) see(t); });
    }
    for (const { w } of [...myWires, ...myBuses]) for (const q of kidsOf(kid(w, 'Points'), 'Point')) see({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K });
    for (const s of myShapes) for (const q of kidsOf(kid(s, 'Points'), 'Point')) see({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K });
    if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = 254; y1 = 203.2; }
    // DipTrace's sheet where the drawing lies on it (its centre at the origin, or a corner) [est]; else the drawing's own extent
    const frames = sh.w > 0 && sh.h > 0 ? [{ x: -sh.w / 2, y: -sh.h / 2 }, { x: 0, y: 0 }, { x: 0, y: -sh.h }] : [];
    const fits = frames.find((f) => x0 >= f.x && x1 <= f.x + sh.w && y0 >= f.y && y1 <= f.y + sh.h);
    const gx = fits ? fits.x : Math.floor(x0 / 2.54) * 2.54, gy = fits ? fits.y : Math.floor(y0 / 2.54) * 2.54;
    const M = fits ? 0 : 50, TB = fits ? 0 : 90;
    const P = (q: Pt): Pt => ({ x: Math.round((U(q.x - gx) + M) * 1000) / 1000, y: Math.round((U(q.y - gy) + M + TB) * 1000) / 1000 });
    const ctx: DrawCtx = { rr, fonts, P, warn: warnOnce, K };

    /* ── parts ── */
    for (const pl of mine) {
      const p = pl.part;
      const refdes = dtext(p, 'RefDes');
      if (pl.kind === 'Net Port' || pl.kind === 'Power') {
        // A power port at its pin, pointing the way its symbol lies, named by its net
        kidsOf(kid(pl.section, 'Pins'), 'Pin').forEach((pin, j) => {
          const tip = pinTipMm(pl, j);
          if (!tip) return;
          const nid = pinNet.get(`${p.attrs.Id}:${j}`);
          const nm = nid !== undefined ? netName.get(nid) ?? '' : dtext(p, 'Value') || dtext(p, 'Name');
          const b = pl.tf.pt({ x: dnum(pin, 'X'), y: dnum(pin, 'Y') });
          const at = P(tip), body = P(b);
          const orient = Math.hypot(body.x - at.x, body.y - at.y) > 0.01 ? orientOf(at, body) : 1;
          const ground = /gnd|ground|vss|earth/i.test(nm);
          const style = /earth|chassis|\bpe\b/i.test(nm) ? 6 : /agnd|signal/i.test(nm) ? 5 : ground ? 4 : pl.kind === 'Net Port' ? 2 : 2;
          top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: orient, TEXT: nm, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: at });
          if (nm) usedNets.add(nm);
        });
        continue;
      }
      const style = p.attrs.ComponentStyle ?? '';
      const libRef = libRefs.get(style);
      if (!pl.comp || !libRef) { warnOnce('Parts whose component is missing from the design cache left out'); continue; }
      const secs = sectionsOf(pl.comp);
      const f = secs[0]!;
      const ci = dnum(p, 'ComponentPart');
      const value = dtext(p, 'Value'), cname = dtext(p, 'Name') || dtext(f, 'Name');
      const comment = value || cname;
      const footprint = footprintFor(style);
      const angle = pl.tf.angle, hf = dyes(p, 'HorzFlip'), vf = dyes(p, 'VertFlip');
      if (angle % 90) warnOnce('Parts turned other than by quarter turns: drawn as turned, their pins to the nearest quarter');
      const adAngle = vf ? angle + 180 : angle;
      const comp = top({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: secs.length + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: Math.min(secs.length, ci + 1), ORIENTATION: quarter(adAngle), ISMIRRORED: hf !== vf || undefined,
        AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, COMPONENTDESCRIPTION: cname || undefined,
        UNIQUEID: uniqueIdFor(`diptrace:${stem}:${refdes}`) }, { LOCATION: P(pl.tf.pt({ x: origin(pl.section).ox, y: origin(pl.section).oy })) });
      const resolve = (s: string) => (s === 'RefDes' ? refdes : s === 'Name' ? cname : s === 'Value' ? value : s === 'Part Name' ? dtext(p, 'PartName') : s === 'Manufacturer' ? dtext(p, 'Manufacturer') : dtext(p, 'Datasheet'));
      // Every section of the component under it, as AD keeps them (only the current one shown)
      secs.forEach((sec, j) => {
        const { ox, oy } = origin(sec);
        const tf = placer(K, dnum(p, 'X') * K, dnum(p, 'Y') * K, angle, hf, vf, ox, oy);
        const own: Props = { OWNERINDEX: comp - 1, OWNERPARTID: j + 1 };
        drawShapes(ctx, kidsOf(kid(sec, 'Shapes'), 'Shape'), tf, own, COL.body, resolve);
        const pins = drawPins(ctx, sec, tf, own, showNumbersOf(sec, pinNumbersVisible) && (p.attrs.ShowNumbers ?? 'Common') !== 'Hide');
        if (j !== Math.min(secs.length - 1, ci)) return;
        for (const q of pins) {
          const pk = `${p.attrs.Id}:${q.index}`;
          const pinEl = kidsOf(kid(p, 'Pins'), 'Pin')[q.index];
          if (dyes(pinEl, 'NotConnected')) top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: q.tip });
          const nid = pinNet.get(pk);
          if (nid !== undefined && refdes) netOfPin.set(`${refdes}.${q.number}`, netName.get(nid) ?? '');
        }
      });
      // The fields where DipTrace shows them (its own placings round the body [est] unless placed)
      const field = (fieldName: string, rec: number, name: string, text: string) => {
        const m = kid(p, `${fieldName}Marking`);
        const g = kid(marks, `${fieldName}Global`);
        const showRaw = m?.attrs.Show ?? 'Common';
        const show = showRaw === 'Common' ? (g?.attrs.Show ?? (fieldName === 'RefDes' || fieldName === 'Value' ? 'Show' : 'Hide')) : showRaw;
        const shown = show === 'Show' && !!text;
        const align = m?.attrs.Align ?? 'Auto';
        const size = dyes(p, 'CustomMarkingFont') ? dnum(p, 'MarkingFontSizeFloat', dnum(p, 'MarkingFontSize', globalSize)) : globalSize;
        const w = (dnum(pl.section, 'Width') * K) / 2, h = (dnum(pl.section, 'Height') * K) / 2;
        const cx = dnum(p, 'X') * K, cy = dnum(p, 'Y') * K;
        const lift = U(fontMmOf(size)) * 1.4;
        let loc: Pt, just = 4, orient = 0;
        if (align === 'Position' || (align === 'Common' && m?.attrs.X !== undefined)) {
          loc = P({ x: cx + dnum(m, 'X') * K, y: cy + dnum(m, 'Y') * K });
          just = justification(alignH(m?.attrs.Horz), alignV(m?.attrs.Vert));
          orient = quarter(deg(dnum(m, 'Angle')));
        } else {
          const above = fieldName === 'RefDes', below = fieldName === 'Value';
          const ext = Math.abs(angle % 180 - 90) < 1 ? w : h;
          loc = P({ x: cx, y: cy + (above ? ext : below ? -ext : 0) });
          loc = { x: loc.x, y: loc.y + (above ? lift * 0.6 : below ? -lift * 0.6 : 0) };
          just = 4;
        }
        rr.add({ RECORD: rec, OWNERINDEX: comp - 1, OWNERPARTID: -1, NAME: name, TEXT: text, FONTID: fonts.id(fontMmOf(size)), COLOR: COL.text, ORIENTATION: orient, JUSTIFICATION: just, ISHIDDEN: shown ? undefined : true }, { LOCATION: loc });
      };
      field('RefDes', SR.DESIGNATOR, 'Designator', refdes);
      field('Value', SR.PARAMETER, 'Comment', comment);
      if (cname && value) field('Name', SR.PARAMETER, 'Name', cname);
      field('Manufacturer', SR.PARAMETER, 'Manufacturer', dtext(p, 'Manufacturer') || dtext(f, 'Manufacturer'));
      field('Datasheet', SR.PARAMETER, 'Datasheet', dtext(p, 'Datasheet') || dtext(f, 'Datasheet'));
      for (const a of kidsOf(kid(p, 'AddFields'), 'AddField')) {
        const k = dtext(a, 'Name'), v = dtext(a, 'Text');
        if (k && v && !/^(Comment|Designator)$/i.test(k)) rr.add({ RECORD: SR.PARAMETER, OWNERINDEX: comp - 1, OWNERPARTID: -1, NAME: k, TEXT: v, FONTID: 1, COLOR: COL.text, ISHIDDEN: true }, { LOCATION: P({ x: dnum(p, 'X') * K, y: dnum(p, 'Y') * K }) });
      }
      if (footprint) implementation(rr, comp, footprint, footprintLib);
      if (pl.kind === 'Hierarchy Block' || pl.kind === 'Hierarchy Connector') warnOnce('Hierarchy blocks and connectors placed as parts, their nets joined by name [est]');
      placedParts.add(refdes);
    }

    /* ── nets: wires, junctions, labels ── */
    const ends = new Map<string, { at: Pt; n: number }>();
    const seeEnd = (q: Pt, k = 1) => { const key = `${Math.round(q.x * 100)},${Math.round(q.y * 100)}`; const e = ends.get(key) ?? { at: q, n: 0 }; e.n += k; ends.set(key, e); };
    const segs: [Pt, Pt][] = [];
    const wireEnds: Pt[] = [];
    const draw = (pts: Pt[]) => {
      rr.points({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire, UNIQUEID: uniqueId() }, pts);
      for (let i = 1; i < pts.length; i++) { seeEnd(pts[i - 1]!); seeEnd(pts[i]!); segs.push([pts[i - 1]!, pts[i]!]); }
      wireEnds.push(pts[0]!, pts.at(-1)!);
    };
    for (const { n, w } of myWires) {
      const pts = kidsOf(kid(w, 'Points'), 'Point').map((q) => P({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }));
      if (pts.length < 2) continue;
      draw(pts);
      // An end DipTrace joins to a pin but drawn short of it: a wire on to the pin (AD joins by place)
      for (const [end, at] of [['1', pts[0]!], ['2', pts.at(-1)!]] as const) {
        const c = w.attrs[`Connected${end}`] ?? '';
        if (c !== 'Pin' && c !== '0') continue;
        const part = partById.get(dnum(w, `Object${end}`, -1));
        const pl = part ? placedOf.get(part) : undefined;
        const tip = pl ? pinTipMm(pl, dnum(w, `SubObject${end}`, -1)) : undefined;
        if (!tip) continue;
        const t = P(tip);
        if (Math.hypot(t.x - at.x, t.y - at.y) > 0.01) { draw([at, t]); warnOnce('Wires whose ends stop short of the pins DipTrace joins them to drawn on to the pins'); }
      }
      usedNets.add(netName.get(dnum(n, 'Id', -1)) ?? '');
    }
    // Junctions: three or more ends at a place, or an end on another wire's middle
    const onMiddle = (q: Pt) => segs.some(([a, b]) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) return false;
      const t = ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (len * len);
      if (t <= 0.001 || t >= 0.999) return false;
      return Math.hypot(a.x + t * (b.x - a.x) - q.x, a.y + t * (b.y - a.y) - q.y) < 0.01;
    });
    const dots = new Set<string>();
    const dot = (q: Pt) => { const k = `${Math.round(q.x * 100)},${Math.round(q.y * 100)}`; if (dots.has(k)) return; dots.add(k); top({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: q }); };
    for (const e of ends.values()) if (e.n >= 3) dot(e.at);
    for (const q of wireEnds) if (onMiddle(q)) dot(q);
    for (const pc of pieces) {
      if (pc.sheet !== sh.id || !needsLabel(pc)) continue;
      const nm = netName.get(pc.net) ?? '';
      top({ RECORD: SR.NET_LABEL, TEXT: nm, FONTID: fonts.id(fontMmOf(netFont)), COLOR: COL.wire, ORIENTATION: 0, UNIQUEID: uniqueId() }, { LOCATION: P(pc.at) });
      usedNets.add(nm);
    }
    for (const { w } of myBuses) {
      const pts = kidsOf(kid(w, 'Points'), 'Point').map((q) => P({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }));
      if (pts.length >= 2) rr.points({ RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: COL.bus }, pts);
    }
    if (myBuses.length) warnOnce('Buses drawn; their members joined by their nets\' names');

    /* ── the sheet's drawing; net-name texts as net labels ── */
    for (const s of myShapes) {
      if (kindOf(s) === 'Text' && (dnum(s, 'NetId', -1) >= 0 || dnum(s, 'BusId', -1) >= 0)) {
        const q = kid(kid(s, 'Points'), 'Point');
        const bus = dnum(s, 'BusId', -1) >= 0;
        const nm = bus ? dtext(kidsOf(kid(sch, 'Buses'), 'Bus').find((b) => dnum(b, 'Id', -1) === dnum(s, 'BusId')), 'Name') : netName.get(dnum(s, 'NetId')) ?? '';
        if (nm) top({ RECORD: SR.NET_LABEL, TEXT: nm, FONTID: fonts.id(fontMmOf(dnum(s, 'FontSizeFloat', dnum(s, 'FontSize', netFont)))), COLOR: COL.wire, ORIENTATION: quarter(deg(dnum(s, 'Angle'))), UNIQUEID: uniqueId() }, { LOCATION: P({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }) });
        continue;
      }
      drawShapes(ctx, [s], placer(K, 0, 0, 0, false, false, 0, 0), { OWNERPARTID: -1 }, COL.graphic);
    }

    /* ── the sheet record: DipTrace's size, or as large as what's on it ── */
    const W = Math.max(Math.ceil(U(sh.w) / 10) * 10, Math.ceil((U(x1 - gx) + 2 * M) / 10) * 10, 450), H = Math.max(Math.ceil(U(sh.h) / 10) * 10, Math.ceil((U(y1 - gy) + 2 * M + TB) / 10) * 10);
    rr.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
      CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: Math.max(4, Math.round(W / 250)), CUSTOMYZONES: Math.max(4, Math.round(H / 250)), CUSTOMMARGINWIDTH: 20,
      BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff),
      SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
    rr.bags[0]!.setRaw('WEIGHT', String(rr.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', joinSchRecords(rr.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const base = sh.name.replace(/[\\/:*?"<>|]/g, '_').trim() || `Sheet${si + 1}`;
    let file = sheets.length === 1 ? `${stem}.SchDoc` : `${base}.SchDoc`;
    for (let k = 2; out.some((o) => o.name.toUpperCase() === file.toUpperCase()); k++) file = `${base}_${k}.SchDoc`;
    out.push({ name: file, bytes: writeCfb(root) });
  });
  const lib = dipTraceSymbolLibrary(doc, symbols, footprintLib);
  usedNets.delete('');
  return { sheets: out, library: lib.bytes, symbols: lib.count, warnings: [...warnings, ...lib.warnings.filter((w) => !warned.has(w))],
    stats: { sheets: out.length, parts: placedParts.size, nets: [...netName.values()].filter((n) => !autoDtNet(n)).length, symbols: lib.count }, patterns, netOfPin };
}
