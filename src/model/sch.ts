import type { Coord } from '../core/units';
import { SCH_UNIT, mil } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { CfbFile } from '../formats/cfb/cfb';
import type { SchRawRecord } from '../formats/altium/framing';
import type { PropertyBag } from '../formats/altium/props';
import { Diagnostics, fromBgr, type Rgb } from './common';

/** Schematic RECORD ids (Altium). */
export const SR = {
  HEADER: 0, COMPONENT: 1, PIN: 2, IEEE_SYMBOL: 3, LABEL: 4, BEZIER: 5, POLYLINE: 6, POLYGON: 7, ELLIPSE: 8,
  PIECHART: 9, ROUND_RECTANGLE: 10, ELLIPTICAL_ARC: 11, ARC: 12, LINE: 13, RECTANGLE: 14, SHEET_SYMBOL: 15,
  SHEET_ENTRY: 16, POWER_PORT: 17, PORT: 18, NO_ERC: 22, NET_LABEL: 25, BUS: 26, WIRE: 27, TEXT_FRAME: 28,
  JUNCTION: 29, IMAGE: 30, SHEET: 31, SHEET_NAME: 32, FILE_NAME: 33, DESIGNATOR: 34, BUS_ENTRY: 37,
  TEMPLATE: 39, PARAMETER: 41, PARAMETER_SET: 43, IMPLEMENTATION_LIST: 44, IMPLEMENTATION: 45,
  MAP_DEFINER_LIST: 46, MAP_DEFINER: 47, IMPL_PARAMS: 48, NOTE: 209, COMPILE_MASK: 211,
  HARNESS_CONNECTOR: 215, HARNESS_ENTRY: 216, HARNESS_TYPE: 217, SIGNAL_HARNESS: 218, BLANKET: 225, HYPERLINK: 226,
} as const;

/** ORIENTATION 0–3 → unit direction (right, up, left, down). */
export const DIR_VECTORS: Vec2[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

/** A multi-part package's part letter: A … Z, then AA, AB … (part 32 is AF, as Altium shows X1AF). */
/** The part suffix after a designator: U1A, or U1:1 with Preferences › Alpha Numeric Suffix › Numeric. */
export function partSuffix(n: number, numeric = false): string { return numeric ? `:${n}` : partLetter(n); }
export function partLetter(n: number): string {
  let s = '';
  for (let k = Math.floor(n); k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

export const SR_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(SR).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')]),
);

export type TextRole = 'label' | 'netlabel' | 'designator' | 'parameter' | 'sheetname' | 'filename' | 'harnesstype';

export type SchShape =
  | { kind: 'wire' | 'bus' | 'polyline' | 'bezier'; pts: Vec2[]; width: Coord; color: Rgb; /** Line Style (lines and polylines): 0 solid, 1 dashed, 2 dotted, 3 dash-dotted. */ style?: number }
  | { kind: 'polygon'; pts: Vec2[]; width: Coord; color: Rgb; fill: Rgb; solid: boolean; transparent: boolean }
  /** r / ry: corner radii across / up and down (Round Rectangle), clamped to half the size as AD draws them. */
  | { kind: 'rect'; a: Vec2; b: Vec2; width: Coord; color: Rgb; fill: Rgb; solid: boolean; r: Coord; ry: Coord; transparent: boolean }
  | { kind: 'ellipse'; c: Vec2; rx: Coord; ry: Coord; width: Coord; color: Rgb; fill: Rgb; solid: boolean; transparent: boolean }
  | { kind: 'arc'; c: Vec2; rx: Coord; ry: Coord; start: number; end: number; width: Coord; color: Rgb }
  | { kind: 'text'; role: TextRole; at: Vec2; text: string; font: number; orient: number; justify: number; color: Rgb; mirrored: boolean }
  | { kind: 'pin'; at: Vec2; length: Coord; orient: number; name: string; designator: string; showName: boolean; showDesignator: boolean; electrical: number; color: Rgb;
      symbols: { inner: number; innerEdge: number; outerEdge: number; outer: number } }
  | { kind: 'junction'; at: Vec2; color: Rgb; size: number }
  /** A harness splice (wires joined) or a layout's connection point (bundles joined): its name beside it. */
  | { kind: 'splice'; at: Vec2; name: string; showName: boolean; color: Rgb; fill: Rgb; border: Rgb; font: number; point: boolean }
  | { kind: 'power'; at: Vec2; text: string; style: number; orient: number; showText: boolean; color: Rgb; crossSheet: boolean; font: number }
  | { kind: 'port'; at: Vec2; width: Coord; height: Coord; name: string; style: number; io: number; align: number; color: Rgb; fill: Rgb; textColor: Rgb; font: number }
  | { kind: 'sheetentry'; side: number; distance: Coord; name: string; io: number; style: number; color: Rgb; fill: Rgb; textColor: Rgb; font: number }
  | { kind: 'noerc'; at: Vec2; color: Rgb; symbol?: string; orient: number }
  | { kind: 'busentry'; a: Vec2; b: Vec2; width: Coord; color: Rgb }
  | { kind: 'sheetsymbol'; at: Vec2; w: Coord; h: Coord; color: Rgb; fill: Rgb; width: Coord; device: boolean }
  | { kind: 'textframe'; a: Vec2; b: Vec2; text: string; color: Rgb; textColor: Rgb; fill: Rgb; solid: boolean; border: boolean; font: number;
      wrap: boolean; clip: boolean; margin: Coord; align: number; width: Coord }
  | { kind: 'image'; a: Vec2; b: Vec2; file: string; embedded: boolean }
  | { kind: 'ieee'; at: Vec2; symbol: number; orient: number; mirrored: boolean; scale: number; width: Coord; color: Rgb }
  | { kind: 'directive'; at: Vec2; name: string; orient: number; color: Rgb; style: number }
  | { kind: 'piechart'; c: Vec2; r: Coord; start: number; end: number; width: Coord; color: Rgb; fill: Rgb; solid: boolean }
  /** Place › Directives › Compile Mask: what lies inside is left out of the compile. */
  | { kind: 'compilemask'; a: Vec2; b: Vec2; color: Rgb; fill: Rgb; collapsed: boolean }
  /** Place › Directives › Blanket: a polygon whose directives apply to every net it covers. */
  | { kind: 'blanket'; pts: Vec2[]; color: Rgb; fill: Rgb; solid: boolean; dashed: boolean; collapsed: boolean }
  /** Harnesses (the Additional stream): connector, its entries, the signal harness line. */
  | { kind: 'harness'; at: Vec2; w: Coord; h: Coord; color: Rgb; fill: Rgb; width: Coord; primary: Coord; side: number }
  | { kind: 'harnessentry'; side: number; distance: Coord; name: string; color: Rgb; fill: Rgb; textColor: Rgb; font: number }
  | { kind: 'signalharness'; pts: Vec2[]; width: Coord; color: Rgb }
  | { kind: 'component'; at: Vec2; libRef: string; designator: string; partId: number; partCount: number; displayMode: number; orient: number; mirrored: boolean; children: number[] }
  | { kind: 'meta' };

export interface SchObjectBase {
  /** Index into SchDocument.objects — also the value OWNERINDEX refers to. */
  index: number;
  record: number;      // RECORD type
  owner: number;       // OWNERINDEX or -1
  ownerPartId: number; // -1 = all parts
  ownerDisplayMode: number;
  hidden: boolean;
}
export type SchObject = SchObjectBase & SchShape;

export interface SchFont { size: number; name: string; rotation: number; bold: boolean; italic: boolean }

export interface SchSheet {
  width: Coord;
  height: Coord;
  background: Rgb;
  border: boolean;
  titleBlock: boolean;
  fonts: SchFont[];     // 1-based in files; index 0 here = FONTID 1
  /** FONTID used for pins and other system text. */
  systemFont: number;
  snapGrid: Coord;
  visibleGrid: Coord;
  /** SHEETSTYLE (Standard Styles index). */
  style: number;
  /** DOCUMENTBORDERSTYLE: 0 Standard title block, 1 ANSI. */
  titleStyle: number;
  /** Reference zones along the border (REFERENCEZONESON; on unless written F). */
  referenceZones: boolean;
  zonesX: number;
  zonesY: number;
  /** Border margin (CUSTOMMARGINWIDTH; 20 units on standard sheets). */
  margin: Coord;
  /** REFERENCEZONESTYLE: 0 default (A… from top, 1… from left), 1 ASME Y14 (from bottom-right). */
  zoneStyle: number;
  template: string;
  showTemplate: boolean;
  /** DISPLAY_UNIT (Document Options › Units), -1 when the file doesn't say. */
  unit: number;
}

export interface SchDocument {
  kind: 'SchDoc';
  name: string;
  /** Original container, so streams we don't model (Storage, Additional …) survive a save. */
  cfb: CfbFile | null;
  /** ASCII variant line ending, or null for binary. */
  asciiEol: string | null;
  /** FileHeader records. records[0] is the HEADER; records[i + 1] ↔ objects[i]. */
  records: SchRawRecord[];
  objects: SchObject[];
  sheet: SchSheet;
  diags: Diagnostics;
  /**
   * The Additional stream's header record (harnesses live there). Its records follow the
   * FileHeader's in `records`, marked `additional`; their OWNERINDEX counts on from the
   * FileHeader's objects ('continued') or within the stream ('local'), as the file had it.
   */
  additionalHead?: PropertyBag;
  additionalOwners?: 'continued' | 'local';
  /** Library symbols: objects placed here join the component (OWNERINDEX, part, display mode). */
  adopt?: (bag: PropertyBag) => void;
  /** Library symbols: the sheet record (fonts) changed, so the library's header follows. */
  onSheetChange?: (sheet: PropertyBag) => void;
}

/* ─── Derivation: property bag → typed object ────────────────────────────────────────── */

/** Reference zones (columns × rows) per SHEETSTYLE. A4: 4 × 4 as Altium Designer 17 draws it; others scaled [est]. */
const SHEET_ZONES: [number, number][] = [
  [4, 4], [6, 4], [8, 6], [12, 8], [16, 12],
  [4, 4], [6, 4], [8, 6], [12, 8], [16, 12],
  [4, 4], [4, 4], [6, 4],
  [4, 4], [6, 4], [8, 6], [12, 8], [16, 12],
];

// Sheet sizes in DXP units (10 mil), indexed by SHEETSTYLE (cross-checked with KiCad's importer: docs/FORMATS.md).
const SHEET_STYLES: [number, number][] = [
  [1150, 760], [1550, 1110], [2230, 1570], [3150, 2230], [4460, 3150], // A4 A3 A2 A1 A0
  [950, 750], [1500, 950], [2000, 1500], [3200, 2000], [4200, 3200],   // A B C D E
  [1100, 850], [1400, 850], [1700, 1100],                              // Letter Legal Tabloid
  [990, 790], [1540, 990], [2060, 1560], [3260, 2060], [4280, 3280],   // OrCAD A–E
];

/** Schematic coordinate: X (10 mil steps) + X_FRAC (1/10000 mil) → internal units. */
export function schCoord(bag: PropertyBag, key: string): Coord {
  return bag.int(key) * SCH_UNIT + bag.int(`${key}_FRAC`);
}
export function schPoint(bag: PropertyBag, xk: string, yk: string): Vec2 {
  return { x: schCoord(bag, xk), y: schCoord(bag, yk) };
}
export function setSchCoord(bag: PropertyBag, key: string, v: Coord): void {
  const whole = Math.trunc(v / SCH_UNIT);
  const frac = v - whole * SCH_UNIT;
  bag.setRaw(key, String(whole));
  if (frac) bag.setRaw(`${key}_FRAC`, String(frac)); else bag.delete(`${key}_FRAC`);
}

/** LINEWIDTH enum → world width. 0 renders as a 1 px hairline. */
export const SCH_LINE_WIDTHS: Coord[] = [0, mil(10), mil(30), mil(50)];
const lw = (bag: PropertyBag): Coord => SCH_LINE_WIDTHS[bag.int('LINEWIDTH')] ?? 0;
/** Line Style: LINESTYLEEXT where AD writes it (it has Dash Dotted), else LINESTYLE. */
const lineStyle = (bag: PropertyBag): number => Math.max(0, Math.min(3, bag.has('LINESTYLEEXT') ? bag.int('LINESTYLEEXT') : bag.int('LINESTYLE')));
/** AD leaves out keys whose value is 0, so a colour it doesn't write is black [AD: the reporter's sheet]. */
const col = (bag: PropertyBag, key: string): Rgb => fromBgr(bag.int(key));

/** Konium's own palette: the document's colours turned off, the sheet without AREACOLOR. */
export const SCH_DEFAULTS = {
  wire: 0x1d4f91, bus: 0x1d4f91, line: 0x2b3a4a, body: 0x6b2f2a, bodyFill: 0xf4f1e2,
  pin: 0x22252a, text: 0x1d3557, junction: 0x1d4f91, power: 0x1d4f91, port: 0x6b2f2a, portFill: 0xf4f1e2,
  sheet: 0xffffff,
};

function points(bag: PropertyBag): Vec2[] {
  const n = bag.int('LOCATIONCOUNT');
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) out.push(schPoint(bag, `X${i}`, `Y${i}`));
  return out;
}

/**
 * AD's harness documents (Harness Wiring Diagram .WirDoc, Harness Layout Drawing .LdrDoc) are
 * schematic files with records of their own: their sheet (104, 105), connectors (106, a part
 * with its graphics) and their pins (113), wires (107) and the layout's bundles (111), splices
 * (108) and connection points (110), cables (123), shields (117) and twists (118) as the bands
 * across the wires they take, no-connects (119), the layout's labels (109); the rest (wires,
 * splices, cables … of the layout tied to the diagram's, logical signal connections) have no
 * place on the sheet.
 */
export const HR = { WIRING_SHEET: 104, LAYOUT_SHEET: 105, CONNECTOR: 106, WIRE: 107, SPLICE: 108, LABEL: 109, CONNECTION_POINT: 110, BUNDLE: 111,
  SIGNAL_LINK: 112, CONNECTOR_PIN: 113, LAYOUT_WIRE: 115, LAYOUT_SPLICE: 116, SHIELD: 117, TWIST: 118, NO_CONNECT: 119, LAYOUT_NO_CONNECT: 120,
  LAYOUT_SHIELD: 121, LAYOUT_TWIST: 122, CABLE: 123, LAYOUT_CABLE: 124 } as const;
/** Harness records that behave as schematic ones (a connector as a part, its pins as pins, the sheet as the sheet). */
const AS_SCH: Record<number, number> = { [HR.WIRING_SHEET]: SR.SHEET, [HR.LAYOUT_SHEET]: SR.SHEET, [HR.CONNECTOR]: SR.COMPONENT, [HR.CONNECTOR_PIN]: SR.PIN };

export function deriveObject(bag: PropertyBag, index: number): SchObject {
  const raw = bag.int('RECORD', -1);
  const record = AS_SCH[raw] ?? raw;
  const base: SchObjectBase = {
    index, record,
    owner: bag.has('OWNERINDEX') ? bag.int('OWNERINDEX') : -1,
    ownerPartId: bag.int('OWNERPARTID', -1),
    ownerDisplayMode: bag.int('OWNERPARTDISPLAYMODE', 0),
    // A harness connector's view (a parameter holding the picture's settings) isn't shown as text
    hidden: bag.bool('ISHIDDEN') || bag.bool('ISIMAGEPARAMETER'),
  };
  const loc = () => schPoint(bag, 'LOCATION.X', 'LOCATION.Y');
  const corner = () => schPoint(bag, 'CORNER.X', 'CORNER.Y');
  const text = (role: TextRole): SchObject => ({
    ...base, kind: 'text', role, at: loc(), text: bag.get('TEXT') ?? '', font: bag.int('FONTID', 1),
    orient: bag.int('ORIENTATION'), justify: bag.int('JUSTIFICATION'), color: col(bag, 'COLOR'),
    mirrored: bag.bool('ISMIRRORED'),
  });

  switch (record) {
    case HR.WIRE: case HR.BUNDLE: return { ...base, kind: 'polyline', pts: points(bag), width: Math.max(lw(bag), mil(raw === HR.BUNDLE ? 20 : 10)), color: col(bag, 'COLOR') };
    case HR.SHIELD: case HR.TWIST: case HR.CABLE:
      return { ...base, kind: 'rect', a: loc(), b: corner(), width: lw(bag), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'), r: 0, ry: 0, transparent: false };
    case HR.NO_CONNECT: return { ...base, kind: 'noerc', at: loc(), color: col(bag, 'COLOR'), symbol: bag.get('STYLE'), orient: bag.int('ORIENTATION') & 3 };
    case HR.SPLICE: case HR.CONNECTION_POINT:
      return { ...base, kind: 'splice', at: loc(), name: bag.get('TEXT') ?? '', showName: bag.bool('SHOWNAME'), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'),
        border: col(bag, 'BORDERCOLOR'), font: bag.int('FONTID', 1), point: raw === HR.CONNECTION_POINT };
    case HR.LABEL: return text('label');
    case SR.WIRE: return { ...base, kind: 'wire', pts: points(bag), width: lw(bag), color: col(bag, 'COLOR') };
    case SR.BUS: return { ...base, kind: 'bus', pts: points(bag), width: Math.max(lw(bag), mil(30)), color: col(bag, 'COLOR') };
    case SR.POLYLINE: return { ...base, kind: 'polyline', pts: points(bag), width: lw(bag), color: col(bag, 'COLOR'), style: lineStyle(bag) };
    case SR.BEZIER: return { ...base, kind: 'bezier', pts: points(bag), width: lw(bag), color: col(bag, 'COLOR') };
    case SR.LINE: return { ...base, kind: 'polyline', pts: [loc(), corner()], width: lw(bag), color: col(bag, 'COLOR'), style: lineStyle(bag) };
    case SR.POLYGON:
      return { ...base, kind: 'polygon', pts: points(bag), width: lw(bag), color: col(bag, 'COLOR'),
        fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'), transparent: bag.bool('TRANSPARENT') };
    case SR.RECTANGLE:
    case SR.ROUND_RECTANGLE: {
      const a = loc(), b = corner(), round = record === SR.ROUND_RECTANGLE;
      const r = round ? Math.max(0, Math.min(schCoord(bag, 'CORNERXRADIUS'), Math.abs(b.x - a.x) / 2)) : 0;
      const ry = round ? Math.max(0, Math.min(schCoord(bag, 'CORNERYRADIUS'), Math.abs(b.y - a.y) / 2)) : 0;
      return { ...base, kind: 'rect', a, b, width: lw(bag), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'),
        r: r && ry ? r : 0, ry: r && ry ? ry : 0, transparent: bag.bool('TRANSPARENT') };
    }
    case SR.ELLIPSE:
      return { ...base, kind: 'ellipse', c: loc(), rx: schCoord(bag, 'RADIUS'), ry: schCoord(bag, 'SECONDARYRADIUS'),
        width: lw(bag), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'), transparent: bag.bool('TRANSPARENT') };
    case SR.ARC:
    case SR.ELLIPTICAL_ARC: {
      const rx = schCoord(bag, 'RADIUS');
      return { ...base, kind: 'arc', c: loc(), rx, ry: record === SR.ARC ? rx : schCoord(bag, 'SECONDARYRADIUS'),
        start: bag.float('STARTANGLE', 0), end: bag.float('ENDANGLE', 360), width: lw(bag), color: col(bag, 'COLOR') };
    }
    case SR.LABEL: return text('label');
    case SR.NET_LABEL: return text('netlabel');
    case SR.DESIGNATOR: return text('designator');
    case SR.PARAMETER: return text('parameter');
    case SR.SHEET_NAME: return text('sheetname');
    case SR.FILE_NAME: return text('filename');
    case SR.PIN: {
      const pc = bag.int('PINCONGLOMERATE');
      return { ...base, kind: 'pin', at: loc(), length: schCoord(bag, 'PINLENGTH'), orient: pc & 3,
        name: bag.get('NAME') ?? '', designator: bag.get('DESIGNATOR') ?? '',
        showName: (pc & 0x08) !== 0, showDesignator: (pc & 0x10) !== 0, electrical: bag.int('ELECTRICAL'),
        color: col(bag, 'COLOR'), hidden: base.hidden || (pc & 0x04) !== 0,
        symbols: { inner: bag.int('SYMBOL_INNER'), innerEdge: bag.int('SYMBOL_INNEREDGE'), outerEdge: bag.int('SYMBOL_OUTEREDGE'), outer: bag.int('SYMBOL_OUTER') } };
    }
    // SIZE: 0 smallest … 3 large (absent = smallest)
    case SR.JUNCTION: return { ...base, kind: 'junction', at: loc(), color: col(bag, 'COLOR'), size: Math.min(3, Math.max(0, bag.int('SIZE'))) };
    case SR.POWER_PORT:
      return { ...base, kind: 'power', at: loc(), text: bag.get('TEXT') ?? '', style: bag.int('STYLE'), orient: bag.int('ORIENTATION'),
        showText: bag.has('SHOWNETNAME') ? bag.bool('SHOWNETNAME') : true, color: col(bag, 'COLOR'),
        crossSheet: bag.bool('ISCROSSSHEETCONNECTOR'), font: bag.int('FONTID') };
    case SR.PORT:
      return { ...base, kind: 'port', at: loc(), width: bag.int('WIDTH', 50) * SCH_UNIT, height: bag.int('HEIGHT', 10) * SCH_UNIT,
        name: bag.get('NAME') ?? '', style: bag.int('STYLE'), io: bag.int('IOTYPE'), align: bag.int('ALIGNMENT'), color: col(bag, 'COLOR'),
        fill: col(bag, 'AREACOLOR'), textColor: col(bag, 'TEXTCOLOR'), font: bag.int('TEXTFONTID') || bag.int('FONTID') };
    // DISTANCEFROMTOP is in 100 mil units with a _FRAC1 remainder (unlike every other coordinate)
    case SR.SHEET_ENTRY:
      return { ...base, kind: 'sheetentry', side: bag.int('SIDE'), distance: bag.int('DISTANCEFROMTOP') * 10 * SCH_UNIT + bag.int('DISTANCEFROMTOP_FRAC1'),
        name: bag.get('NAME') ?? '', io: bag.int('IOTYPE'), style: bag.int('STYLE'), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'),
        textColor: col(bag, 'TEXTCOLOR'), font: bag.int('TEXTFONTID') };
    case SR.NO_ERC: return { ...base, kind: 'noerc', at: loc(), color: col(bag, 'COLOR'), symbol: bag.get('SYMBOL'), orient: bag.int('ORIENTATION') & 3 };
    case SR.BUS_ENTRY: return { ...base, kind: 'busentry', a: loc(), b: corner(), width: lw(bag), color: col(bag, 'COLOR') };
    case SR.SHEET_SYMBOL:
      return { ...base, kind: 'sheetsymbol', at: loc(), w: schCoord(bag, 'XSIZE'), h: schCoord(bag, 'YSIZE'),
        color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), width: lw(bag), device: bag.get('SYMBOLTYPE') === 'DeviceSheet' };
    case SR.TEXT_FRAME:
    case SR.NOTE:
      // Altium writes booleans only when true: no WORDWRAP / CLIPTORECT means off. ALIGNMENT 1 left, 2 centre, 3 right.
      return { ...base, kind: 'textframe', a: loc(), b: corner(), text: (bag.get('TEXT') ?? '').replace(/~1/g, '\n'),
        color: col(bag, 'COLOR'), textColor: col(bag, 'TEXTCOLOR'), fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'),
        border: bag.bool('SHOWBORDER'), font: bag.int('FONTID', 1), wrap: bag.bool('WORDWRAP'), clip: bag.bool('CLIPTORECT'),
        margin: schCoord(bag, 'TEXTMARGIN'), align: bag.int('ALIGNMENT', 1), width: lw(bag) };
    case SR.IMAGE: return { ...base, kind: 'image', a: loc(), b: corner(), file: bag.get('FILENAME') ?? '', embedded: bag.bool('EMBEDIMAGE') };
    // SCALEFACTOR: the Size in the IEEE Symbol dialog [est: 10 mil per step, default 4]
    case SR.IEEE_SYMBOL:
      return { ...base, kind: 'ieee', at: loc(), symbol: bag.int('SYMBOL'), orient: bag.int('ORIENTATION') & 3, mirrored: bag.bool('ISMIRRORED'),
        scale: bag.int('SCALEFACTOR', 4) || 4, width: lw(bag), color: col(bag, 'COLOR') };
    // Place › Directives: a Parameter Set (NAME=DIFFPAIR for Differential Pair), red by default
    case SR.PARAMETER_SET:
      return { ...base, kind: 'directive', at: loc(), name: bag.get('NAME') ?? '', orient: bag.int('ORIENTATION') & 3, color: col(bag, 'COLOR'), style: bag.int('STYLE') };
    case SR.PIECHART:
      return { ...base, kind: 'piechart', c: loc(), r: schCoord(bag, 'RADIUS'), start: bag.float('STARTANGLE', 0), end: bag.float('ENDANGLE', 360),
        width: lw(bag), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID') };
    case SR.COMPILE_MASK:
      return { ...base, kind: 'compilemask', a: loc(), b: corner(), color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'), collapsed: bag.bool('ISCOLLAPSED') };
    case SR.BLANKET: {
      const pts = points(bag);
      const a = loc(), b = corner();
      return { ...base, kind: 'blanket', pts: pts.length >= 3 ? pts : [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], color: col(bag, 'COLOR'),
        fill: col(bag, 'AREACOLOR'), solid: bag.bool('ISSOLID'), dashed: bag.int('LINESTYLE') > 0 || bag.int('LINESTYLEEXT') > 0, collapsed: bag.bool('ISCOLLAPSED') };
    }
    case SR.HARNESS_CONNECTOR:
      return { ...base, kind: 'harness', at: loc(), w: schCoord(bag, 'XSIZE'), h: schCoord(bag, 'YSIZE'), color: col(bag, 'COLOR'),
        fill: col(bag, 'AREACOLOR'), width: lw(bag), primary: schCoord(bag, 'PRIMARYCONNECTIONPOSITION'), side: bag.int('SIDE') };
    case SR.HARNESS_ENTRY:
      return { ...base, kind: 'harnessentry', side: bag.int('SIDE'), distance: bag.int('DISTANCEFROMTOP') * 10 * SCH_UNIT + bag.int('DISTANCEFROMTOP_FRAC1'),
        name: bag.get('NAME') ?? '', color: col(bag, 'COLOR'), fill: col(bag, 'AREACOLOR'),
        textColor: col(bag, 'TEXTCOLOR'), font: bag.int('TEXTFONTID') };
    case SR.HARNESS_TYPE: return text('harnesstype');
    case SR.SIGNAL_HARNESS: return { ...base, kind: 'signalharness', pts: points(bag), width: Math.max(lw(bag), mil(30)), color: col(bag, 'COLOR') };
    case SR.COMPONENT:
      return { ...base, kind: 'component', at: loc(), libRef: bag.get('LIBREFERENCE') ?? bag.get('DESIGNITEMID') ?? '',
        designator: '', partId: bag.int('CURRENTPARTID', 1), partCount: bag.int('PARTCOUNT', 1),
        displayMode: bag.int('DISPLAYMODE', 0), orient: bag.int('ORIENTATION'), mirrored: bag.bool('ISMIRRORED'), children: [] };
    default: return { ...base, kind: 'meta' };
  }
}

export function deriveSheet(bag: PropertyBag | undefined): SchSheet {
  const sheet: SchSheet = {
    width: 1150 * SCH_UNIT, height: 760 * SCH_UNIT, background: SCH_DEFAULTS.sheet, border: true, titleBlock: true,
    fonts: [{ size: 10, name: 'Times New Roman', rotation: 0, bold: false, italic: false }], systemFont: 1,
    snapGrid: mil(100), visibleGrid: mil(100), style: 0, titleStyle: 0, referenceZones: true, zonesX: 4, zonesY: 4, margin: 20 * SCH_UNIT,
    zoneStyle: 0, template: '', showTemplate: false, unit: -1,
  };
  if (!bag) return sheet;
  if (bag.bool('USECUSTOMSHEET')) {
    sheet.width = schCoord(bag, 'CUSTOMX');
    sheet.height = schCoord(bag, 'CUSTOMY');
  } else {
    const [w, h] = SHEET_STYLES[bag.int('SHEETSTYLE')] ?? SHEET_STYLES[0]!;
    // Document Options › Orientation › Portrait: the standard sheet stood on its end
    const portrait = bag.int('WORKSPACEORIENTATION') === 1;
    sheet.width = (portrait ? h : w) * SCH_UNIT;
    sheet.height = (portrait ? w : h) * SCH_UNIT;
  }
  sheet.background = bag.has('AREACOLOR') ? col(bag, 'AREACOLOR') : SCH_DEFAULTS.sheet;
  // Booleans are written only when true: no BORDERON / TITLEBLOCKON means off
  sheet.border = bag.bool('BORDERON');
  sheet.titleBlock = bag.bool('TITLEBLOCKON');
  sheet.style = bag.int('SHEETSTYLE');
  sheet.titleStyle = bag.int('DOCUMENTBORDERSTYLE');
  sheet.referenceZones = !bag.has('REFERENCEZONESON') || bag.bool('REFERENCEZONESON');
  // (a portrait standard sheet: its zones turned with it [est])
  const upright = !bag.bool('USECUSTOMSHEET') && bag.int('WORKSPACEORIENTATION') === 1;
  const [zx, zy] = SHEET_ZONES[sheet.style] ?? [4, 4];
  sheet.zonesX = bag.bool('USECUSTOMSHEET') ? bag.int('CUSTOMXZONES', 6) : upright ? zy : zx;
  sheet.zonesY = bag.bool('USECUSTOMSHEET') ? bag.int('CUSTOMYZONES', 4) : upright ? zx : zy;
  sheet.margin = bag.bool('USECUSTOMSHEET') && bag.has('CUSTOMMARGINWIDTH') ? schCoord(bag, 'CUSTOMMARGINWIDTH') : 20 * SCH_UNIT;
  sheet.zoneStyle = bag.int('REFERENCEZONESTYLE');
  sheet.template = bag.get('TEMPLATEFILENAME') ?? '';
  sheet.showTemplate = bag.bool('SHOWTEMPLATEGRAPHICS');
  sheet.unit = bag.has('DISPLAY_UNIT') ? bag.int('DISPLAY_UNIT') : -1;
  const n = bag.int('FONTIDCOUNT');
  if (n > 0) {
    sheet.fonts = [];
    for (let i = 1; i <= n; i++) {
      sheet.fonts.push({ size: bag.int(`SIZE${i}`, 10), name: bag.get(`FONTNAME${i}`) ?? 'Arial',
        rotation: bag.int(`ROTATION${i}`), bold: bag.bool(`BOLD${i}`), italic: bag.bool(`ITALIC${i}`) });
    }
  }
  sheet.systemFont = bag.int('SYSTEMFONT', 1) || 1;
  if (bag.has('SNAPGRIDSIZE')) sheet.snapGrid = schCoord(bag, 'SNAPGRIDSIZE');
  if (bag.has('VISIBLEGRIDSIZE')) sheet.visibleGrid = schCoord(bag, 'VISIBLEGRIDSIZE');
  return sheet;
}

/** Records Altium keeps in the Additional stream: harness connectors, entries, types, signal harnesses. */
export const ADDITIONAL_RECORDS = new Set<number>([SR.HARNESS_CONNECTOR, SR.HARNESS_ENTRY, SR.HARNESS_TYPE, SR.SIGNAL_HARNESS]);

/** Rebuild objects + sheet from records. Call after any record change. */
export function rederive(doc: SchDocument): void {
  const objs: SchObject[] = [];
  for (let i = 1; i < doc.records.length; i++) {
    const r = doc.records[i]!;
    objs.push(r.bag ? deriveObject(r.bag, i - 1) : { index: i - 1, record: -1, owner: -1, ownerPartId: -1, ownerDisplayMode: 0, hidden: false, kind: 'meta' });
  }
  for (const o of objs) {
    if (o.owner < 0) continue;
    const owner = objs[o.owner];
    if (owner?.kind === 'component') {
      owner.children.push(o.index);
      if (o.kind === 'text' && o.role === 'designator') owner.designator = o.text;
    }
  }
  doc.objects = objs;
  const sheetRec = objs.find((o) => o.record === SR.SHEET);  // a harness document's own sheet record counts as one
  doc.sheet = deriveSheet(sheetRec ? doc.records[sheetRec.index + 1]!.bag : undefined);
}

/** Is this object visible given its owner component's current part and display mode? */
export function isShown(doc: SchDocument, o: SchObject): boolean {
  if (o.hidden || o.kind === 'meta') return false;
  if (o.owner < 0) return true;
  const owner = doc.objects[o.owner];
  // Parameters of a model (simulation kind, netlist template …) live under its records, never drawn
  if (owner?.kind === 'meta') return false;
  if (!owner || owner.kind !== 'component') return true;
  if (o.ownerPartId > 0 && o.ownerPartId !== owner.partId) return false;
  // A part's designator, parameters and models (no part of their own) show in every display mode
  if (o.ownerPartId < 0 && !o.ownerDisplayMode) return true;
  return o.ownerDisplayMode === owner.displayMode;
}

export function bagOf(doc: SchDocument, o: SchObject): PropertyBag | undefined {
  return doc.records[o.index + 1]?.bag;
}

/** A component's kind: COMPONENTKIND, or COMPONENTKINDVERSION2 where Altium writes the newer kinds (5: Standard (No BOM)). */
export function componentKind(bag: { has(k: string): boolean; int(k: string, d?: number): number }): number {
  if (bag.has('COMPONENTKINDVERSION2')) return bag.int('COMPONENTKINDVERSION2');
  return bag.int('COMPONENTKIND');
}

const ownedCache = new WeakMap<SchObject[], Map<number, SchObject[]>>();
/** Each object's own records (one pass over the sheet, kept while its objects are unchanged). */
export function ownedBy(doc: SchDocument): Map<number, SchObject[]> {
  let m = ownedCache.get(doc.objects);
  if (!m) {
    m = new Map();
    for (const o of doc.objects) if (o.owner >= 0) { const l = m.get(o.owner); if (l) l.push(o); else m.set(o.owner, [o]); }
    ownedCache.set(doc.objects, m);
  }
  return m;
}
