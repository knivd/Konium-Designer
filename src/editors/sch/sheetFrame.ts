import type { Vec2 } from '../../core/geom';
import { SCH_UNIT } from '../../core/units';
import type { SchSheet } from '../../model/sch';

/**
 * The sheet's border, reference zones and title block, as Document Options set them: an outline
 * at the sheet's edge; with reference zones on, an inner border one margin in and the zones
 * between, numbered 1… left to right and lettered A… top to bottom (ASME Y14 style counts from
 * the bottom right); the title block in the inner border's bottom-right corner.
 *
 * Title block geometry is Konium's reading of Altium Designer 17's Standard block [est]:
 * 350 × 80 units (10 mil): Title on top; Size, Number, Revision; then Date / File and Sheet of /
 * Drawn By. ANSI uses the same block until its own geometry is known.
 */
export interface FrameText { at: Vec2; text: string; h: 0 | 1 | 2; v: 0 | 1 | 2; role: 'zone' | 'label' | 'value' }
export interface SheetFrame { lines: [Vec2, Vec2][]; texts: FrameText[] }

const U = SCH_UNIT;
const SIZES = ['A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'Letter', 'Legal', 'Tabloid', 'OrCAD A', 'OrCAD B', 'OrCAD C', 'OrCAD D', 'OrCAD E'];

export const TITLE_BLOCK = { w: 350, h: 80, rows: [50, 20], sizeCol: 50, revCol: 250, sheetCol: 200 } as const;

export function sheetFrame(sh: SchSheet, custom: boolean, values: { date: string; file: string }): SheetFrame {
  const W = sh.width, H = sh.height;
  const lines: [Vec2, Vec2][] = [];
  const texts: FrameText[] = [];
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    lines.push([{ x: x0, y: y0 }, { x: x1, y: y0 }], [{ x: x1, y: y0 }, { x: x1, y: y1 }], [{ x: x1, y: y1 }, { x: x0, y: y1 }], [{ x: x0, y: y1 }, { x: x0, y: y0 }]);
  };
  let inner = { x0: 0, y0: 0, x1: W, y1: H };
  if (sh.border) {
    box(0, 0, W, H);
    if (sh.referenceZones && sh.margin > 0) {
      const m = sh.margin;
      inner = { x0: m, y0: m, x1: W - m, y1: H - m };
      box(m, m, W - m, H - m);
      const nx = Math.max(1, sh.zonesX), ny = Math.max(1, sh.zonesY);
      const zw = (W - 2 * m) / nx, zh = (H - 2 * m) / ny;
      const asme = sh.zoneStyle === 1;
      for (let i = 0; i < nx; i++) {
        const x = m + i * zw;
        if (i > 0) { lines.push([{ x, y: 0 }, { x, y: m }], [{ x, y: H - m }, { x, y: H }]); }
        const label = String(asme ? nx - i : i + 1);
        texts.push({ at: { x: x + zw / 2, y: H - m / 2 }, text: label, h: 1, v: 1, role: 'zone' }, { at: { x: x + zw / 2, y: m / 2 }, text: label, h: 1, v: 1, role: 'zone' });
      }
      for (let j = 0; j < ny; j++) {
        const y = H - m - j * zh;
        if (j > 0) { lines.push([{ x: 0, y }, { x: m, y }], [{ x: W - m, y }, { x: W, y }]); }
        const label = zoneLetter(asme ? ny - 1 - j : j);
        texts.push({ at: { x: m / 2, y: y - zh / 2 }, text: label, h: 1, v: 1, role: 'zone' }, { at: { x: W - m / 2, y: y - zh / 2 }, text: label, h: 1, v: 1, role: 'zone' });
      }
    }
  }
  if (sh.titleBlock) {
    const T = TITLE_BLOCK;
    const x0 = inner.x1 - T.w * U, y0 = inner.y0, x1 = inner.x1, y1 = y0 + T.h * U;
    box(x0, y0, x1, y1);
    const X = (u: number) => x0 + u * U, Y = (u: number) => y0 + u * U;
    lines.push([{ x: x0, y: Y(T.rows[0]) }, { x: x1, y: Y(T.rows[0]) }], [{ x: x0, y: Y(T.rows[1]) }, { x: x1, y: Y(T.rows[1]) }]);
    lines.push([{ x: X(T.sizeCol), y: Y(T.rows[1]) }, { x: X(T.sizeCol), y: Y(T.rows[0]) }], [{ x: X(T.revCol), y: Y(T.rows[1]) }, { x: X(T.revCol), y: Y(T.rows[0]) }]);
    const label = (u: number, v: number, text: string) => texts.push({ at: { x: X(u), y: Y(v) }, text, h: 0, v: 0, role: 'label' });
    const value = (u: number, v: number, text: string) => texts.push({ at: { x: X(u), y: Y(v) }, text, h: 0, v: 0, role: 'value' });
    label(1, 72, 'Title');
    label(1, 42, 'Size'); label(T.sizeCol + 1, 42, 'Number'); label(T.revCol + 1, 42, 'Revision');
    value(10, 25, custom ? 'Custom' : SIZES[sh.style] ?? 'A4');
    label(1, 11, 'Date:'); value(30, 11, values.date);
    label(1, 1, 'File:'); value(30, 1, values.file);
    label(T.sheetCol, 11, 'Sheet'); label(T.sheetCol + 40, 11, 'of');
    label(T.sheetCol, 1, 'Drawn By:');
  }
  return { lines, texts };
}

/** Row letters A, B … (skipping I and O as drawing standards do). */
function zoneLetter(i: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return letters[i] ?? String(i + 1);
}
