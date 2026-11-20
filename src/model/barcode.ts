/**
 * Barcode strings (a String's Font: BarCode): Code 39 or Code 128 bars in a box at the text's
 * position, turned and mirrored with it. The box is Full Width by Height (Render Mode By Full
 * Width: the bars share the width inside the margins) or as wide as the bars at Min Width each
 * (By Min Width). Inverted fills the box and leaves the bars out. Show Text adds the String's
 * height under the bars for the words, each character centred in an equal share of the bars'
 * width. Code 39 is Full ASCII (lower case as +A…+Z), wide elements twice the narrow. Measured
 * from AD17's own render of a 1050 × 210 mil "Test 123"; Texts6 keeps the settings after the
 * TrueType block.
 */
import type { Vec2 } from '../core/geom';

export interface BarcodeSpec {
  type: 'code39' | 'code128';
  render: 'full' | 'min';
  /** Board units. */
  fullWidth: number; height: number; minWidth: number; marginX: number; marginY: number;
  inverted: boolean; showText: boolean;
  /** The words' TrueType font when shown. */
  font: string;
}

/* ── Code 39: 9 elements a character (bar, space, …), three of them wide ── */
const C39 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
const C39_WIDE = [
  0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064, 0x109, 0x049, 0x148, 0x019, 0x118, 0x058, 0x00d, 0x10c, 0x04c, 0x01c,
  0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016, 0x181, 0x0c1, 0x1c0, 0x091, 0x190, 0x0d0, 0x085, 0x184, 0x0c4, 0x0a8,
  0x0a2, 0x08a, 0x02a, 0x094,
];
/** Wide elements are twice the narrow (AD17's render). */
const RATIO = 2;

/** Full ASCII Code 39: what stands for each character (one or two symbols) [est: the punctuation, the standard table]. */
const FULL39: Record<string, string> = {
  '!': '/A', '"': '/B', '#': '/C', '$': '/D', '%': '/E', '&': '/F', "'": '/G', '(': '/H', ')': '/I', '*': '/J', '+': '/K', ',': '/L', '/': '/O', ':': '/Z',
  ';': '%F', '<': '%G', '=': '%H', '>': '%I', '?': '%J', '@': '%V', '[': '%K', '\\': '%L', ']': '%M', '^': '%N', '_': '%O', '`': '%W',
  '{': '%P', '|': '%Q', '}': '%R', '~': '%S',
};
const full39 = (c: string): string => {
  if (/^[0-9A-Z .-]$/.test(c)) return c;
  if (/^[a-z]$/.test(c)) return `+${c.toUpperCase()}`;
  return FULL39[c] ?? '';
};

/** The characters Code 39 shows (printable ASCII, as typed). */
export const code39Text = (s: string): string => s.split('').filter((c) => full39(c) !== '').join('');

function code39(text: string): boolean[] {
  const out: boolean[] = [];
  const chars = `*${[...code39Text(text)].map(full39).join('')}*`;
  [...chars].forEach((c, k) => {
    const bits = C39_WIDE[C39.indexOf(c)]!;
    for (let i = 0; i < 9; i++) {
      const wide = (bits >> (8 - i)) & 1;
      for (let n = 0; n < (wide ? RATIO : 1); n++) out.push(i % 2 === 0);
    }
    if (k < chars.length - 1) out.push(false);
  });
  return out;
}

/* ── Code 128 (set B): 11 modules a symbol, the stop 13 ── */
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const code128Text = (s: string): string => s.split('').filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).join('');

function code128(text: string): boolean[] {
  const vals = [...code128Text(text)].map((c) => c.charCodeAt(0) - 32);
  const sum = vals.reduce((a, v, i) => a + v * (i + 1), 104) % 103;
  const out: boolean[] = [];
  for (const v of [104, ...vals, sum, 106]) [...C128[v]!].forEach((w, i) => { for (let n = 0; n < Number(w); n++) out.push(i % 2 === 0); });
  return out;
}

/** The modules left to right, true where a bar is. */
export const barcodeModules = (text: string, type: BarcodeSpec['type']): boolean[] => (type === 'code128' ? code128(text) : code39(text));

export interface BarcodeShape {
  /** The box (four corners, board units). */
  box: Vec2[];
  /** What is drawn: each a quadrilateral (the bars, or with Inverted the box less the bars). */
  rects: Vec2[][];
  /**
   * Show Text: the words under the bars, each character centred in its share of the width
   * (`chars`, on the baseline); `height` the capitals', `em` the font size. Inverted: cut out of the box.
   */
  label?: { text: string; chars: { at: Vec2; text: string }[]; height: number; em: number; rotation: number; mirrored: boolean; knockout: boolean };
}

/** A TrueType String's height is its font's ascent and descent; Arial's, in ems [est: the barcode font taken as Arial]. */
const CELL = 1.117, DESCENT = 0.212, CAPS = 0.716;

/**
 * The barcode of a String at `at` (the box's lower-left corner before turning), `rotation`
 * degrees, mirrored as the text is; `textHeight` is the String's height (the words' size).
 */
export function barcodeShape(text: string, at: Vec2, rotation: number, mirrored: boolean, textHeight: number, b: BarcodeSpec): BarcodeShape {
  const mods = barcodeModules(text, b.type);
  const n = Math.max(1, mods.length);
  const module = b.render === 'min' ? Math.max(1, b.minWidth) : Math.max(1, (b.fullWidth - 2 * b.marginX) / n);
  const width = b.render === 'min' ? n * module + 2 * b.marginX : b.fullWidth;
  const shown = b.type === 'code39' ? code39Text(text) : code128Text(text);
  // Show Text: the box grows by the String's height; the bars come down to the words' capitals
  const words = b.showText && shown ? Math.max(1, textHeight) : 0;
  const height = Math.max(b.height, 2 * b.marginY + 1) + words;
  const em = words / CELL, base = em * DESCENT;
  const barLo = words ? base + em * CAPS : b.marginY, barHi = height - b.marginY;
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), m = mirrored ? -1 : 1;
  const P = (x: number, y: number): Vec2 => ({ x: Math.round(at.x + (x * m) * c - y * s), y: Math.round(at.y + (x * m) * s + y * c) });
  const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (!mods[i]) continue;
    const x0 = b.marginX + i * module;
    const last = runs.at(-1);
    if (last && Math.abs(last[1] - x0) < 1e-6) last[1] = x0 + module; else runs.push([x0, x0 + module]);
  }
  let rects: Vec2[][];
  if (!b.inverted) rects = runs.map(([x0, x1]) => rect(x0, barLo, x1, barHi));
  else {
    // The box filled, the bars left out: the spaces between and the frame round them
    rects = [rect(0, 0, width, barLo), rect(0, barHi, width, height)];
    let x = 0;
    for (const [x0, x1] of runs) { if (x0 > x) rects.push(rect(x, barLo, x0, barHi)); x = x1; }
    if (x < width) rects.push(rect(x, barLo, width, barHi));
  }
  const slot = (width - 2 * b.marginX) / Math.max(1, shown.length);
  const chars = [...shown].map((ch, i) => ({ at: P(b.marginX + (i + 0.5) * slot, base), text: ch })).filter((c) => c.text !== ' ');
  return {
    box: rect(0, 0, width, height), rects,
    label: words ? { text: shown, chars, height: em * CAPS, em, rotation, mirrored, knockout: b.inverted } : undefined,
  };
}
