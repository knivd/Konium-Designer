/**
 * Field offsets inside PCB primitive subrecords. One table drives both decoding and
 * in-place patching, so a correction here fixes read and write together.
 *
 * Source: KiCad's documented Altium importer read order (packed, little-endian), checked since
 * on boards saved by the desktop software; docs/FORMATS.md says for each field what its reading
 * rests on, and an estimate is marked [est] where it stands. Unknown bytes are never
 * touched when patching — edited records keep whatever Altium originally wrote there.
 */

export type FieldType = 'u8' | 'u16' | 'u32' | 'i32' | 'f64';
export interface Field { off: number; t: FieldType }
const f = (off: number, t: FieldType): Field => ({ off, t });

const SIZE: Record<FieldType, number> = { u8: 1, u16: 2, u32: 4, i32: 4, f64: 8 };

export const TRACK = {
  minLen: 36, templateLen: 46,
  layer: f(0, 'u8'), flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'), polygon: f(5, 'u16'), component: f(7, 'u16'),
  x1: f(13, 'i32'), y1: f(17, 'i32'), x2: f(21, 'i32'), y2: f(25, 'i32'), width: f(29, 'i32'),
  subpoly: f(33, 'u16'), layerV7: f(41, 'u32'),
  /** A keep-out's restrictions (≥ 46 bytes): 0x01 vias, 0x02 tracks, 0x04 copper, 0x08 SMD pads, 0x10 through pads [KiCad's reader]. */
  restrict: f(45, 'u8'),
} as const;

export const ARC = {
  minLen: 45, templateLen: 56,
  layer: f(0, 'u8'), flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'), polygon: f(5, 'u16'), component: f(7, 'u16'),
  cx: f(13, 'i32'), cy: f(17, 'i32'), radius: f(21, 'i32'), start: f(25, 'f64'), end: f(33, 'f64'), width: f(41, 'i32'),
  subpoly: f(45, 'u16'), layerV7: f(52, 'u32'),
  /** A keep-out's restrictions (≥ 57 bytes), as tracks'. */
  restrict: f(56, 'u8'),
} as const;

export const VIA = {
  minLen: 31, templateLen: 74,
  /**
   * AD17's full via (subrecord ≥ 203 bytes): the diameter per layer (32 × i32, top first, bottom
   * last) from here, after the diameter mode at 74 (checked on AD17 boards: i32 at 75 = the diameter).
   */
  layerDiameters: 75,
  flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'),
  /** The component a footprint's own via belongs to (0xFFFF: none), where every primitive keeps it [seen on boards saved by the desktop software]. */
  component: f(7, 'u16'),
  x: f(13, 'i32'), y: f(17, 'i32'), diameter: f(21, 'i32'), hole: f(25, 'i32'), layerStart: f(29, 'u8'), layerEnd: f(30, 'u8'),
  /** Solder mask: top expansion, the mode (1 from rules, 2 specified), the bottom one when not linked (≥ 246 bytes). */
  maskTop: f(54, 'i32'), maskMode: f(66, 'u8'), maskLinked: f(241, 'u8'), maskBottom: f(242, 'i32'),
  /** Simple 0, Top-Middle-Bottom 1, Full Stack 2. */
  mode: f(74, 'u8'),
  /**
   * Its connection to internal planes, as AD keeps it in every via: the connect style (0 none, 1 relief,
   * 2 direct, as AD works it out when it applies the rules), relief air gap, entries, conductor width and
   * expansion, and the plane clearance (AD17's own boards: their Power Plane Connect and Plane Clearance
   * rules' values).
   */
  relief: { style: f(31, 'u8'), gap: f(32, 'i32'), entries: f(36, 'u8'), width: f(38, 'i32'), expansion: f(42, 'i32'), clearance: f(46, 'i32') },
  /** Hole tolerances (≥ 299 bytes): 0x7FFFFFFF is N/A. */
  tolPlus: f(291, 'i32'), tolMinus: f(295, 'i32'),
  /** Unused pad shape removed, a byte per layer (by layer id − 1; ≥ 241 bytes) [checked against the pours' clearances on AD boards]. */
  removed: 209,
} as const;

export const FILL = {
  minLen: 37, templateLen: 46,
  layer: f(0, 'u8'), flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'), component: f(7, 'u16'),
  x1: f(13, 'i32'), y1: f(17, 'i32'), x2: f(21, 'i32'), y2: f(25, 'i32'), rotation: f(29, 'f64'), layerV7: f(42, 'u32'),
  /** A keep-out's restrictions (≥ 47 bytes), as tracks'. */
  restrict: f(46, 'u8'),
} as const;

/**
 * Texts6 subrecord 1. Subrecord 2 holds the legacy 8-bit string; when `wideIndex` resolves in
 * WideStrings6, that Unicode string wins. Extended fields exist when the subrecord is ≥ 123 bytes.
 * Offsets cross-checked against KiCad's ATEXT6 reader.
 */
export const TEXT = {
  minLen: 40, extendedLen: 123, templateLen: 123,
  layer: f(0, 'u8'), net: f(3, 'u16'), component: f(7, 'u16'), x: f(13, 'i32'), y: f(17, 'i32'), height: f(21, 'i32'),
  font: f(25, 'u16'), rotation: f(27, 'f64'), mirrored: f(35, 'u8'), strokeWidth: f(36, 'i32'),
  isComment: f(40, 'u8'), isDesignator: f(41, 'u8'), fontType: f(43, 'u8'), bold: f(44, 'u8'), italic: f(45, 'u8'),
  fontName: 46, /* 64 bytes UTF-16LE */ inverted: f(110, 'u8'), wideIndex: f(115, 'u32'),
  /**
   * AD17's longer texts (≥ 230 bytes): the barcode settings, the kind again (0 stroke, 1
   * TrueType, 2 barcode), the barcode's font and the V7 layer [est: from KiCad's reader and the
   * defaults every AD17 text carries — 1050 × 210 mil, margins 20 mil, Code 39, By Full Width].
   */
  barcodeLen: 230,
  bcFullWidth: f(137, 'i32'), bcHeight: f(141, 'i32'), bcMarginX: f(145, 'i32'), bcMarginY: f(149, 'i32'), bcMinWidth: f(153, 'i32'),
  bcType: f(157, 'u8'), bcRender: f(158, 'u8'), bcInverted: f(159, 'u8'), kind: f(160, 'u8'), bcFont: 161, /* 64 bytes UTF-16LE */
  bcShowText: f(225, 'u8'), layerV7: f(226, 'u32'),
} as const;

/**
 * Regions6 / ShapeBasedRegions6 subrecord 1: fixed header, then a u32-length property block,
 * then a u32 vertex count and vertices. Regions6 vertices are (f64 x, f64 y); ShapeBasedRegions6
 * vertices are (u8 round, i32 x, i32 y, i32 cx, i32 cy, i32 r, f64 a1, f64 a2) plus a closing vertex.
 * Holes follow as u32 count + (f64 x, f64 y) pairs. Cross-checked against KiCad's AREGION6 reader.
 */
export const REGION = {
  layer: f(0, 'u8'), flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'), polygon: f(5, 'u16'), component: f(7, 'u16'),
  holeCount: f(14, 'u16'), propsAt: 18,
} as const;

/** Pads6 subrecord 5 (index 4). */
export const PAD = {
  minLen: 63, templateLen: 120,
  layer: f(0, 'u8'), flags1: f(1, 'u8'), flags2: f(2, 'u8'), net: f(3, 'u16'), component: f(7, 'u16'),
  x: f(13, 'i32'), y: f(17, 'i32'),
  topX: f(21, 'i32'), topY: f(25, 'i32'), midX: f(29, 'i32'), midY: f(33, 'i32'), botX: f(37, 'i32'), botY: f(41, 'i32'),
  hole: f(45, 'i32'), topShape: f(49, 'u8'), midShape: f(50, 'u8'), botShape: f(51, 'u8'),
  rotation: f(52, 'f64'), plated: f(60, 'u8'), padMode: f(62, 'u8'),
  /** Electrical Type: 0 Load, 1 Terminator, 2 Source [est: the byte KiCad skips after Plated; AD's ASCII DAISYCHAIN]. */
  electrical: f(61, 'u8'),
  /** Its connection to internal planes, as a via's (VIA.relief), in every pad AD writes. */
  relief: { style: f(67, 'u8'), gap: f(68, 'i32'), entries: f(72, 'u8'), width: f(74, 'i32'), expansion: f(78, 'i32'), clearance: f(82, 'i32') },
  /** Mask expansions: specified values, then the modes (1 from rules, 2 specified). */
  pasteManual: f(86, 'i32'), solderManual: f(90, 'i32'), pasteMode: f(101, 'u8'), solderMode: f(102, 'u8'),
  /** Jumper ID (0: none; pads of a component with the same ID are joined) and the V7 layer (≥ 118 bytes) [jumper: AltiumSharp's reading]. */
  jumperId: f(110, 'u16'), layerV7: f(114, 'u32'),
  /** Pin/Pkg Length (≥ 202 bytes); hole tolerances (≥ 170 bytes, 0x7FFFFFFF is N/A). */
  pinLength: f(158, 'i32'), tolPlus: f(162, 'i32'), tolMinus: f(166, 'i32'),
} as const;

/** Testpoint and tenting bits of a pad's or via's flags (flags1 0x80 / flags2 0x01: Fabrication testpoint top / bottom). */
export const FLAG = { fabTop: 0x80, tentBottom: 0x40, tentTop: 0x20, unlocked: 0x04, fabBottom: 0x01 } as const;
/** "N/A" in a tolerance. */
export const NO_TOLERANCE = 0x7fffffff;

/** Pads6 subrecord 6 (index 5): full-stack data. Arrays indexed by V6 layer − 1. */
export const PAD_STACK = {
  minLen: 596, holeShape: 262, altShape: 532, cornerRadius: 564,
  /** Per-layer sizes: 29 inner layers' X then Y (i32), their shapes (u8); slot length (i32) and rotation (f64); hole offsets X then Y per layer (32 × i32). */
  innerX: 0, innerY: 116, innerShape: 232, slotLength: 263, slotRotation: 267, offsetX: 275, offsetY: 403,
  /** Unused pad shape removed, a byte per layer (by layer id − 1; stacks of ≥ 628 bytes) [checked against the pours' clearances on AD boards]. */
  removed: 596,
} as const;

export function get(b: Uint8Array, fl: Field): number | undefined {
  if (fl.off + SIZE[fl.t] > b.length) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (fl.t) {
    case 'u8': return dv.getUint8(fl.off);
    case 'u16': return dv.getUint16(fl.off, true);
    case 'u32': return dv.getUint32(fl.off, true);
    case 'i32': return dv.getInt32(fl.off, true);
    case 'f64': return dv.getFloat64(fl.off, true);
  }
}

export function put(b: Uint8Array, fl: Field, v: number): boolean {
  if (fl.off + SIZE[fl.t] > b.length) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (fl.t) {
    case 'u8': dv.setUint8(fl.off, v); break;
    case 'u16': dv.setUint16(fl.off, v, true); break;
    case 'u32': dv.setUint32(fl.off, v >>> 0, true); break;
    case 'i32': dv.setInt32(fl.off, Math.round(v), true); break;
    case 'f64': dv.setFloat64(fl.off, v, true); break;
  }
  return true;
}

/**
 * The header every new primitive gets when the file has none to copy (as AD17 writes it): flags1
 * 0x0c (unlocked), polygon and component 0xFFFF, bytes 9–12 0xFF. Callers set layer and net.
 */
export function freshHeader(s: Uint8Array): void {
  if (s.length < 13) return;
  s[1] = 0x0c; s[2] = 0;
  s[5] = s[6] = s[7] = s[8] = 0xff;
  s.fill(0xff, 9, 13);
}

/** A via's diameter, and the per-layer diameters AD17 keeps beside it (else the via keeps showing its old size). */
export function setViaDiameter(s: Uint8Array, d: number): void {
  put(s, VIA.diameter, d);
  for (let i = 0; i < 32 && VIA.layerDiameters + 4 * i + 4 <= s.length; i++) put(s, { off: VIA.layerDiameters + 4 * i, t: 'i32' }, d);
}

/** flags1 bit 2 CLEAR means locked (per importer notes). */
export const isLocked = (flags1: number | undefined): boolean => flags1 !== undefined && (flags1 & 0x04) === 0;
