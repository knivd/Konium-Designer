import type { Vec2 } from '../../core/geom';

/**
 * AD's Default stroke font as its DRC measures it [est: fitted to the distances its DRC reports
 * give between texts, pads, arcs and tracks; 214 of 218 to the 0.001 mil it prints]: capitals and
 * digits drawn on a grid 4 units wide and 6 high (a unit is a sixth of the text's height),
 * rounded corners cut off by one unit; 'I' and '1' 2 units wide with bars top and bottom, '.' a
 * unit square. Glyphs whose shape no report pinned down (B, Q, X, Z and the punctuation) follow
 * the same pattern [est]. Each entry: polylines 'x,y x,y;…' with y up from the baseline.
 */
export const GRID_GLYPHS: Readonly<Record<string, string>> = {
  '0': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  '1': '0,5 1,6 1,0;0,0 2,0',
  '2': '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
  '3': '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1;1,3 3,3',
  '4': '3,0 3,6 0,2 4,2',
  '5': '4,6 0,6 0,3 3,3 4,2 4,1 3,0 1,0 0,1',
  '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3',
  '7': '0,6 4,6 4,5 1,0',
  '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
  A: '0,0 0,5 1,6 3,6 4,5 4,0;0,3 4,3',
  B: '0,0 0,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 0,0;0,3 3,3',
  C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
  D: '0,0 0,6 3,6 4,5 4,1 3,0 0,0',
  E: '4,6 0,6 0,0 4,0;0,3 3,3',
  F: '4,6 0,6 0,0;0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
  H: '0,0 0,6;4,0 4,6;0,3 4,3',
  I: '0,6 2,6;1,6 1,0;0,0 2,0',
  J: '4,6 4,1 3,0 1,0 0,1',
  K: '0,0 0,6;4,6 0,3 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,3 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0',
  P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
  Q: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0;2,2 4,0',
  R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3;2,3 4,0',
  S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
  T: '0,6 4,6;2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 0,0 2,2 4,0 4,6',
  X: '0,6 4,0;0,0 4,6',
  Y: '0,6 2,3 4,6;2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  '.': '0,0 1,0 1,1 0,1 0,0',
  '-': '0,3 4,3',
  '_': '0,0 4,0',
  '+': '2,1 2,5;0,3 4,3',
  '/': '0,0 4,6',
};

/** The glyphs' scale from the text's position, a unit a hair under a sixth of its height [est: fitted, the same at every height measured]. */
const SCALE = 0.999686;

const parsed = new Map<string, { pts: Vec2[][]; w: number }>();
function glyph(ch: string) {
  let g = parsed.get(ch);
  if (!g) {
    const src = GRID_GLYPHS[ch];
    if (src === undefined) return undefined;
    const pts = src.split(';').map((pl) => pl.split(' ').map((s) => { const [x, y] = s.split(',').map(Number); return { x: x!, y: y! }; }));
    g = { pts, w: Math.max(...pts.flat().map((p) => p.x)) };
    parsed.set(ch, g);
  }
  return g;
}

/** Whether every character of the text has a grid glyph (spaces and line breaks aside). */
export const gridCovers = (text: string): boolean => [...text].every((ch) => ch === ' ' || ch === '\n' || ch === '\r' || GRID_GLYPHS[ch] !== undefined);

/**
 * Text in the grid font as polylines in board units, or null when a character has no glyph.
 * Laid out as strokeText lays it out: anchored at its bottom-left (bottom-right mirrored), the pen
 * moving on by the glyph's width and a third of the height, at least five sixths of it (a space
 * a whole height [est]), lines 1.4 heights apart [est].
 */
export function gridStrokeText(text: string, at: Vec2, height: number, rotation = 0, mirrored = false): Vec2[][] | null {
  if (!gridCovers(text)) return null;
  const u = (height / 6) * SCALE;
  const r = (rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const out: Vec2[][] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  lines.forEach((line, li) => {
    let pen = 0;
    const base = -(lines.length - 1 - li) * height * 1.4;
    for (const ch of line) {
      if (ch === ' ') { pen += 6; continue; }
      const g = glyph(ch)!;
      for (const pl of g.pts) {
        out.push(pl.map((p) => {
          const lx = (pen + p.x) * u * (mirrored ? -1 : 1), ly = base + p.y * u;
          return { x: at.x + lx * cos - ly * sin, y: at.y + lx * sin + ly * cos };
        }));
      }
      pen += Math.max(g.w + 2, 5);
    }
  });
  return out;
}
