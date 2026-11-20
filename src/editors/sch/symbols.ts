/**
 * Schematic symbol geometry other than power ports (see powerPort.ts), in mil.
 *
 * Sources, best first:
 *   [py]  python-altium's renderer (vadmium/python-altium), built against real Altium files
 *   [kc]  KiCad's Altium importer
 *   [ad]  Altium documentation (option names, units)
 *   [est] estimated from Altium's on-screen look; verify against Symbols.SchDoc opened in Altium
 *
 * Pin frame: a runs from the body edge (pin LOCATION) outward along the pin, so a < 0 is inside
 * the body; +b is "above" the pin as read: up for horizontal pins, left for vertical ones.
 */
import type { Pt } from './powerPort';

export interface Glyph {
  lines: Pt[][];                                   // open polylines (closed ones repeat the first point)
  fills?: Pt[][];                                  // filled polygons
  circles?: { c: Pt; r: number }[];
  w: number;                                       // stroke, mil
}

/* ── Pins ─────────────────────────────────────────────────────────────────────────── */

/** SYMBOL_* values (same numbering for all four slots) [kc]. */
export const PIN_SYM = {
  NONE: 0, DOT: 1, RIGHT_LEFT: 2, CLOCK: 3, LOW_INPUT: 4, ANALOG_IN: 5, NO_LOGIC: 6, POSTPONED: 8,
  OPEN_COLLECTOR: 9, HIZ: 10, HIGH_CURRENT: 11, PULSE: 12, SCHMITT: 13, LOW_OUTPUT: 17,
  OPEN_COLLECTOR_PULLUP: 22, OPEN_EMITTER: 23, OPEN_EMITTER_PULLUP: 24, DIGITAL_IN: 25,
  SHIFT_LEFT: 30, OPEN_OUTPUT: 32, LEFT_RIGHT: 33, BIDI: 34,
} as const;

export interface PinSymbols { inner: number; innerEdge: number; outerEdge: number; outer: number }

export interface PinGlyph {
  /** Where the pin line starts (a); the line always ends at the pin length. */
  lineFrom: number;
  parts: Glyph[];
}

const THIN = 6; // decoration stroke [py: clock, dot at 0.6 DXP]
const diamond = (u0: number, s: number): Pt[] => [[u0, 0], [u0 - s / 2, s / 2], [u0 - s, 0], [u0 - s / 2, -s / 2], [u0, 0]];

/**
 * Decorations for one pin. `electrical` is ELECTRICAL (0 input, 1 I/O, 2 output, …);
 * `direction` is Altium's Preferences › Schematic › Pin Direction.
 */
export function pinGlyph(sym: PinSymbols, electrical: number, direction: boolean): PinGlyph {
  const parts: Glyph[] = [];
  let a = 0;        // outward cursor along the pin
  let lineFrom = 0;

  // Outside edge, against the body
  switch (sym.outerEdge) {
    case PIN_SYM.DOT:          // [py] circle Ø57 centred 31.5 out, pin line starts after it
      parts.push({ lines: [], circles: [{ c: [31.5, 0], r: 28.5 }], w: THIN });
      a = lineFrom = 60;
      break;
    case PIN_SYM.LOW_INPUT:    // [est, IEEE 91] right triangle, upright side away from the body
      parts.push({ lines: [[[0, 0], [60, 30], [60, 0]]], w: THIN });
      a = 60;
      break;
    case PIN_SYM.LOW_OUTPUT:   // [est, IEEE 91] single stroke falling away from the body
      parts.push({ lines: [[[0, 30], [60, 0]]], w: THIN });
      a = 60;
      break;
  }

  // One hollow arrow at the body edge (outside the dot), as AD17 draws it: the outside symbol's
  // signal flow when there is one, else (Preferences › Pin Direction) the pin's electrical type.
  // Inward points at the body (input), outward away from it (output), both back to back (I/O).
  const L = 60, H = 18;
  const arrow = (inward: boolean, at: number): Pt[] => (inward ? [[at, 0], [at + L, H], [at + L, -H], [at, 0]] : [[at + L, 0], [at, H], [at, -H], [at + L, 0]]);
  const flowOf = (k: number): 'in' | 'out' | 'both' | null =>
    k === PIN_SYM.RIGHT_LEFT ? 'in' : k === PIN_SYM.LEFT_RIGHT ? 'out' : k === PIN_SYM.BIDI ? 'both' : null;
  const flow = flowOf(sym.outer) ?? (sym.outer === 0 && direction ? (electrical === 0 ? 'in' : electrical === 2 ? 'out' : electrical === 1 ? 'both' : null) : null);
  if (flow === 'in') parts.push({ lines: [arrow(true, a)], w: THIN });
  else if (flow === 'out') parts.push({ lines: [arrow(false, a)], w: THIN });
  else if (flow === 'both') parts.push({ lines: [arrow(true, a), arrow(false, a + L)], w: THIN });
  if (flow) { a += flow === 'both' ? 2 * L : L; lineFrom = a; } // the pin line stops at the arrow: it stays hollow

  // Other outside symbols, along the pin [est]
  switch (sym.outer) {
    case PIN_SYM.NO_LOGIC: parts.push({ lines: [[[a + 10, -20], [a + 50, 20]], [[a + 10, 20], [a + 50, -20]]], w: THIN }); break;
    case PIN_SYM.ANALOG_IN: // small ∩ above the pin
      parts.push({ lines: [[[a + 10, 0], [a + 10, 20], [a + 20, 30], [a + 40, 30], [a + 50, 20], [a + 50, 0]]], w: THIN }); break;
    case PIN_SYM.DIGITAL_IN: // # above the pin
      parts.push({ lines: [[[a + 20, 5], [a + 20, 45]], [[a + 40, 5], [a + 40, 45]], [[a + 10, 18], [a + 50, 18]], [[a + 10, 32], [a + 50, 32]]], w: THIN }); break;
  }

  // Inside edge [py: clock (0,±30) apex 50 in]
  let u = 0; // inward cursor (positive = further inside)
  if (sym.innerEdge === PIN_SYM.CLOCK) {
    parts.push({ lines: [[[0, 30], [-50, 0], [0, -30]]], w: THIN });
    u = 60;
  }

  // Inside, IEEE qualifying symbols [est], each in a 50 mil cell
  const s = 50, i0 = -(u + 10), i1 = i0 - s; // cell spans a = i1 … i0
  const cell: Glyph | null = (() => {
    switch (sym.inner) {
      case PIN_SYM.OPEN_COLLECTOR: return { lines: [diamond(i0, s), [[i0, -s / 2], [i1, -s / 2]]], w: THIN };
      case PIN_SYM.OPEN_COLLECTOR_PULLUP: return { lines: [diamond(i0, s), [[i0, -s / 2], [i1, -s / 2]], [[i0, 0], [i1, 0]]], w: THIN };
      case PIN_SYM.OPEN_EMITTER: return { lines: [diamond(i0, s), [[i0, s / 2], [i1, s / 2]]], w: THIN };
      case PIN_SYM.OPEN_EMITTER_PULLUP: return { lines: [diamond(i0, s), [[i0, s / 2], [i1, s / 2]], [[i0, 0], [i1, 0]]], w: THIN };
      case PIN_SYM.OPEN_OUTPUT: return { lines: [diamond(i0, s)], w: THIN };
      case PIN_SYM.HIZ: return { lines: [[[i0, s / 2], [i1, s / 2], [(i0 + i1) / 2, -s / 2], [i0, s / 2]]], w: THIN };
      case PIN_SYM.HIGH_CURRENT: return { lines: [[[i1, s / 2], [i0, 0], [i1, -s / 2], [i1, s / 2]]], w: THIN };
      case PIN_SYM.PULSE: return { lines: [[[i0, -15], [i0 - 12, -15], [i0 - 12, 15], [i1 + 12, 15], [i1 + 12, -15], [i1, -15]]], w: THIN };
      case PIN_SYM.SCHMITT: return { lines: [[[i0, -15], [i0 - 35, -15], [i0 - 35, 15]], [[i0 - 15, -15], [i0 - 15, 15], [i1, 15]]], w: THIN };
      case PIN_SYM.POSTPONED: return { lines: [[[i0, 20], [i1 + 10, 20], [i1 + 10, -20]]], w: THIN };
      case PIN_SYM.SHIFT_LEFT: return { lines: [[[i1, 0], [i0, 0]], [[i0 + 0, 0], [i0 - 15, 12]], [[i0, 0], [i0 - 15, -12]]], w: THIN };
      default: return null;
    }
  })();
  if (cell) parts.push(cell);

  return { lineFrom, parts };
}

/* ── Junctions ────────────────────────────────────────────────────────────────────── */

/** Junction SIZE (0 smallest … 3 large) → diameter, mil. Smallest [py: Ø40]; others [est]. */
export const JUNCTION_DIAMETER = [40, 60, 90, 130] as const;
export const JUNCTION_SIZES = ['smallest', 'small', 'medium', 'large'] as const;
export type JunctionSize = (typeof JUNCTION_SIZES)[number];

/* ── No ERC ───────────────────────────────────────────────────────────────────────── */

/** Thin cross ±40 mil, 6 mil stroke [est: ±4 grid units in an AD screenshot; was ±30 py]. */
export const NO_ERC = { half: 40, w: 6 } as const;

/**
 * No ERC SYMBOL (AD writes the name; absent on older records → Thin Cross) in mil about LOCATION, for ORIENTATION 0;
 * ORIENTATION turns it in quarters [AD: the five names; Thick / Small Cross, Checkbox and Triangle shapes est].
 */
export function noErcGlyph(symbol: string | undefined): Glyph {
  const h = NO_ERC.half;
  const cross = (r: number, w: number): Glyph => ({ lines: [[[-r, -r], [r, r]], [[-r, r], [r, -r]]], w });
  switch ((symbol ?? '').toLowerCase().replace(/\s+/g, '')) {
    case 'thickcross': return cross(h, 20);
    case 'smallcross': return cross(h / 2, NO_ERC.w);
    case 'checkbox': {
      const b = 30;
      return { lines: [[[-b, -b], [b, -b], [b, b], [-b, b], [-b, -b]], [[-18, 2], [-5, -14], [18, 16]]], w: NO_ERC.w };
    }
    case 'triangle': return { lines: [[[32, 0], [-24, 32], [-24, -32], [32, 0]]], w: NO_ERC.w };
    default: return cross(h, NO_ERC.w);
  }
}

/* ── Ports ────────────────────────────────────────────────────────────────────────── */

/**
 * Port outline in its own frame: a along the port from LOCATION (0 … width), b across.
 * STYLE % 4: 0 none, 1 left/top, 2 right/bottom, 3 both [kc]; the point is height/2 deep [py].
 * Vertical styles (4–7) run upward from LOCATION [kc].
 */
export function portOutline(style: number, width: number, height: number): Pt[] {
  // Vertical ports run upward, so "top" (5) points at the far end and "bottom" (6) at LOCATION
  const t = height / 2, st = style >= 4 ? [0, 2, 1, 3][style % 4]! : style % 4;
  const startPoint = st === 1 || st === 3, endPoint = st === 2 || st === 3;
  const pts: Pt[] = [];
  pts.push(startPoint ? [0, 0] : [0, -t]);
  if (startPoint) pts.push([t, -t]);
  pts.push(endPoint ? [width - t, -t] : [width, -t]);
  if (endPoint) pts.push([width, 0]);
  pts.push(endPoint ? [width - t, t] : [width, t]);
  pts.push(startPoint ? [t, t] : [0, t]);
  return pts;
}

/* ── Sheet entries ────────────────────────────────────────────────────────────────── */

/**
 * Sheet-entry outline, measured inward from the sheet-symbol edge: 150 mil long, 80 mil tall,
 * points 40 mil deep, the name 200 mil in (measured off an AD17 screen: entries 100 mil apart
 * leave a 20 mil gap). IOTYPE 0 unspecified (box), 1 output (points out), 2 input (points in),
 * 3 bidirectional.
 */
export function sheetEntryOutline(io: number): Pt[] {
  switch (io) {
    case 1: return [[0, 0], [40, -40], [150, -40], [150, 40], [40, 40]];
    case 2: return [[0, -40], [110, -40], [150, 0], [110, 40], [0, 40]];
    case 3: return [[0, 0], [40, -40], [110, -40], [150, 0], [110, 40], [40, 40]];
    default: return [[0, -40], [150, -40], [150, 40], [0, 40]];
  }
}
export const SHEET_ENTRY_TEXT_AT = 200; // mil from the edge

/* ── Off-sheet connector (power port with ISCROSSSHEETCONNECTOR) ──────────────────── */

/** Stem 50, two chevrons 30 apart opening away from the wire, ±40 [py]. Label 140 out. */
export const OFF_SHEET = {
  lines: [[[0, 0], [50, 0]], [[80, 40], [50, 0], [80, -40]], [[110, 40], [80, 0], [110, -40]]] as Pt[][],
  labelAt: 140,
};

/* ── Directives (Parameter Sets) ──────────────────────────────────────────────────── */

/**
 * Differential Pair directive (NAME=DIFFPAIR): a lead rising from the wire to two lines that
 * part and close again, 200 mil long, measured off an AD17 screen. ORIENTATION turns it.
 */
export const DIFF_PAIR: Pt[][] = [
  [[0, 0], [40, 40], [90, 40], [110, 20], [150, 20], [170, 40], [200, 40]],
  [[40, 70], [90, 70], [110, 90], [150, 90], [170, 70], [200, 70]],
];
/**
 * Any other Parameter Set (Parameter Set, PCB Layout, Net Class …): a 60 mil stem up from
 * the wire to a 60 mil circle with an "i" in it, the name centred above it (character cell 200 mil up, baseline about 220); lines 10 mil.
 * Measured off AD17.
 */
export const PARAMETER_SET = {
  stem: [[0, 0], [0, 60]] as Pt[],
  circle: { c: [0, 120] as Pt, r: 60 },
  info: { dot: [0, 148] as Pt, dotR: 4, bar: [[-6, 128], [0, 130], [0, 94]] as Pt[], foot: [[-6, 94], [6, 94]] as Pt[] },
  labelAt: [0, 200] as Pt,
};
