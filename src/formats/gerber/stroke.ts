import type { Vec2 } from '../../core/geom';
import { SIMPLEX } from './strokeFont';

/** Characters past '~' that dimensions and strings use (°, ±, µ, Ø, ø), in the same glyph units. */
const EXTRA: Record<number, [number, string]> = {
  0xb0: [7, '6,1 8,1 10,3 10,5 8,7 6,7 4,5 4,3 6,1'],
  0xb1: [13, '13,4 13,16;4,10 22,10;4,22 22,22'],
  0xb5: [10, '4,8 4,29;4,18 5,21 7,22 10,22 12,21 15,18;15,8 15,22'],
  0xd8: [11, '9,1 7,2 5,4 4,6 3,9 3,14 4,17 5,19 7,21 9,22 13,22 15,21 17,19 18,17 19,14 19,9 18,6 17,4 15,2 13,1 9,1;19,-1 3,24'],
  0xf8: [10, '8,8 6,9 4,11 3,14 3,16 4,19 6,21 8,22 11,22 13,21 15,19 16,16 16,14 15,11 13,9 11,8 8,8;17,6 2,24'],
};

const glyphs = new Map<number, { half: number; strokes: Vec2[][]; left: number; ink: number }>();
function glyph(code: number) {
  let g = glyphs.get(code);
  if (g) return g;
  const src = (code > 126 ? EXTRA[code] : SIMPLEX[code - 33]) ?? SIMPLEX['?'.charCodeAt(0) - 33]!;
  const strokes = src[1].split(';').map((s) => s.split(' ').map((p) => { const [x, y] = p.split(',').map(Number); return { x: x!, y: y! }; }));
  const xs = strokes.flat().map((p) => p.x);
  g = { half: src[0], strokes, left: Math.min(...xs), ink: Math.max(...xs) - Math.min(...xs) };
  glyphs.set(code, g);
  return g;
}

const CAP = 21;      // glyph units from cap top (y = 1) to baseline (y = 22)
const SPACE = 8;     // half advance of a space
/**
 * AD's spacing (its prints): each glyph's ink starts at the pen, which then moves on by the ink
 * plus a third of the height, at least five sixths of it — digits advance one height, '.' and
 * '1' five sixths [est for letters].
 */
const advance = (g: { ink: number }, k: number) => Math.max((g.ink + CAP / 3) * k, ((5 * CAP) / 6) * k);

/**
 * Text as stroke polylines in board units: anchored at its bottom-left (Altium's text
 * position: the first glyph's ink starts there, as AD draws it), `height` is
 * the capital height, rotation in degrees counter-clockwise, mirrored for bottom-side text.
 * Multi-line text steps down 1.4 × height per line.
 */
export function strokeText(text: string, at: Vec2, height: number, rotation = 0, mirrored = false): Vec2[][] {
  const k = height / CAP;
  const r = (rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const out: Vec2[][] = [];
  const lines = text.split('\n');
  lines.forEach((line, li) => {
    let pen = 0;
    const base = -(lines.length - 1 - li) * height * 1.4;
    for (const ch of line) {
      const code = ch.codePointAt(0)!;
      if (code < 33) { pen += 2 * SPACE * k; continue; }
      const g = glyph(code);
      for (const s of g.strokes) {
        out.push(s.map((p) => {
          const lx = (pen + (p.x - g.left) * k) * (mirrored ? -1 : 1);
          const ly = base + (22 - p.y) * k;
          return { x: at.x + lx * cos - ly * sin, y: at.y + lx * sin + ly * cos };
        }));
      }
      pen += advance(g, k);
    }
  });
  return out;
}

/**
 * The capital height to draw a text in the stroke font: its height for stroke text; for TrueType
 * text the capital height the editor shows (Arial's 0.63 of the height, other fonts' 0.5), so
 * plotted TrueType text is the size it is on screen [est].
 */
export function strokeCapHeight(t: { height: number; fontType?: number; fontName?: string }): number {
  return t.fontType === 1 ? t.height * (/arial/i.test(t.fontName ?? '') ? 0.63 : 0.5) : t.height;
}

/** The advance width of stroke text (the longest line), in board units for a capital height. */
export function strokeTextWidth(text: string, height: number): number {
  const k = height / CAP;
  return Math.max(0, ...text.split('\n').map((line) => {
    let pen = 0;
    for (const ch of line) { const code = ch.codePointAt(0)!; pen += code < 33 ? 2 * SPACE * k : advance(glyph(code), k); }
    return pen;
  }));
}

const extents = new Map<string, number>();
/** How far the glyphs of one-line text reach from its position (the ink, not the advance). */
export function strokeTextExtent(text: string, height: number): number {
  const key = `${height}|${text}`;
  let e = extents.get(key);
  if (e === undefined) {
    e = Math.max(0, ...strokeText(text, { x: 0, y: 0 }, height).flat().map((p) => p.x));
    if (extents.size > 2000) extents.clear();
    extents.set(key, e);
  }
  return e;
}
