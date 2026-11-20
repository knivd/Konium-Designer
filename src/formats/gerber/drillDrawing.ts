/**
 * Drill Drawing and Drill Guide layers as outputs draw them (Gerber .GD1 / .GG1, drill drawing
 * prints): a symbol at every hole, one symbol per hole size and plating, and the drill table at
 * the ".Legend" special string on the Drill Drawing layer, as Altium places it.
 * - Symbols: Graphic symbols (Altium's DrillDrawingSymbol=GraphicsSymbol; the first a square of
 *   the symbol size, drawn a tenth of it wide, as AD17 prints it; the others' shapes and order
 *   [est]), Characters (A, B, C …) or Size of hole string (the size in the board's unit).
 *   Prints take the board's own setting (Board6 DRILLSYMBOLASENUM, DRILLSYMBOLSIZE: 20 mil in a
 *   new AD17 board); Gerber setups carry their own (50 mil by default).
 * - Table: Symbol, Hit Count, Tool Size, Plated, Hole Type, then the total [est: layout].
 * - Drill guide: a cross at each hole, half the hole's size across, 5 mil wide (AD17's print of a
 *   10 mm hole) [est: other sizes].
 */
import type { Vec2 } from '../../core/geom';
import type { PcbDocument, PcbText } from '../../model/pcb';
import { L } from '../../model/layers';
import { mil } from '../../core/units';
import { strokeText, strokeTextWidth } from './stroke';
import type { PlotSink } from './gerber';

export type DrillSymbolKind = 'graphic' | 'characters' | 'size';
export interface DrillSymbols {
  kind: DrillSymbolKind;
  /** Symbol size in board units (Altium's default 50 mil). */
  size: number;
}
export const defaultDrillSymbols = (): DrillSymbols => ({ kind: 'graphic', size: mil(50) });
const BOARD_KINDS: DrillSymbolKind[] = ['graphic', 'characters', 'size'];
/** The board's drill symbols (Board6 DRILLSYMBOLASENUM 0 graphic, 1 characters, 2 size [est: 1, 2]; DRILLSYMBOLSIZE). */
export function boardDrillSymbols(doc: PcbDocument): DrillSymbols {
  const b = doc.board.bag;
  const size = b?.int('DRILLSYMBOLSIZE', 0) ?? 0;
  return { kind: BOARD_KINDS[b?.int('DRILLSYMBOLASENUM', 0) ?? 0] ?? 'graphic', size: size > 0 ? size : mil(20) };
}

/** A hole of the drill table: size, plating, slot or round, where. */
export interface DrillHole { at: Vec2; size: number; plated: boolean }
export interface DrillGroup { size: number; plated: boolean; holes: DrillHole[]; symbol: number }

export function drillHoles(doc: PcbDocument): DrillHole[] {
  const out: DrillHole[] = [];
  for (const p of doc.prims) {
    if (p.kind === 'pad' && p.hole > 0) out.push({ at: p.at, size: p.hole, plated: p.plated });
    else if (p.kind === 'via' && p.hole > 0) out.push({ at: p.at, size: p.hole, plated: true });
  }
  return out;
}

/** Holes grouped by size, then plated before non-plated; each group its symbol. */
export function drillGroups(doc: PcbDocument): DrillGroup[] {
  const map = new Map<string, DrillGroup>();
  for (const h of drillHoles(doc)) {
    const k = `${h.size}:${h.plated ? 1 : 0}`;
    let g = map.get(k);
    if (!g) map.set(k, (g = { size: h.size, plated: h.plated, holes: [], symbol: 0 }));
    g.holes.push(h);
  }
  const list = [...map.values()].sort((a, b) => a.size - b.size || Number(b.plated) - Number(a.plated));
  list.forEach((g, i) => { g.symbol = i; });
  return list;
}

/** The graphic symbols, as strokes in a unit square (−1 … 1), cycling with a ring added. */
const SHAPES: number[][][] = [
  [[-1, -1, 1, -1, 1, 1, -1, 1, -1, -1]],                                     // square (AD17's first)
  [[-1, 0, 1, 0], [0, -1, 0, 1]],                                             // +
  [[-1, -1, 1, 1], [-1, 1, 1, -1]],                                           // ×
  [[0, 1, 1, -0.75, -1, -0.75, 0, 1]],                                        // triangle
  [[0, 1, 1, 0, 0, -1, -1, 0, 0, 1]],                                         // diamond
  [[-1, -1, 1, -1, 1, 1, -1, 1, -1, -1], [-1, -1, 1, 1], [-1, 1, 1, -1]],     // square with ×
  [[-1, -1, 1, -1, 1, 1, -1, 1, -1, -1], [-1, 0, 1, 0], [0, -1, 0, 1]],       // square with +
  [[0, 1, 1, 0, 0, -1, -1, 0, 0, 1], [-1, 0, 1, 0], [0, -1, 0, 1]],           // diamond with +
  [[-1, 1, 1, 1, 0, -1, -1, 1]],                                              // triangle down
  [[-1, -1, 1, 1], [-1, 1, 1, -1], [-1, 0, 1, 0]],                            // asterisk
  [[-1, 0, 1, 0], [0, -1, 0, 1], [-0.6, -1, 0.6, -1], [-0.6, 1, 0.6, 1]],     // + with bars
  [[-1, -1, -1, 1], [1, -1, 1, 1], [-1, 0, 1, 0]],                            // H
];
const RING = (n: number) => Array.from({ length: n + 1 }, (_, i) => [Math.cos((i / n) * 2 * Math.PI), Math.sin((i / n) * 2 * Math.PI)]).flat();

const fmtSize = (size: number, metric: boolean) => (metric ? ((size * 25.4) / 1e7).toFixed(2) : String(Math.round(size / 1e4)));
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`);

/** Draw group i's symbol at p. */
export function drawSymbol(plot: PlotSink, at: Vec2, i: number, s: DrillSymbols, holeSize: number, metric: boolean): void {
  const r = s.size / 2, w = Math.max(s.size / 10, mil(1));
  if (s.kind === 'graphic') {
    const shape = SHAPES[i % SHAPES.length]!;
    const strokes = Math.floor(i / SHAPES.length) % 2 === 1 ? [...shape, RING(24)] : shape;
    for (const st of strokes) {
      const pts: Vec2[] = [];
      for (let k = 0; k + 1 < st.length; k += 2) pts.push({ x: at.x + st[k]! * r, y: at.y + st[k + 1]! * r });
      plot.polyline(pts, w);
    }
    return;
  }
  const text = s.kind === 'characters' ? letter(i) : fmtSize(holeSize, metric);
  const h = s.size * (s.kind === 'characters' ? 0.8 : 0.5);
  const wide = strokeTextWidth(text, h);
  for (const pl of strokeText(text, { x: at.x - wide / 2, y: at.y - h / 2 }, h)) plot.polyline(pl, w);
}

const isLegend = (t: PcbText) => t.layer === L.DRILL_DRAWING && /^\.legend$/i.test(t.text.trim());
export const legendStrings = (doc: PcbDocument): PcbText[] => doc.prims.filter((p): p is PcbText => p.kind === 'text' && isLegend(p));

/** Symbols at every hole, and the drill table at each .Legend string. */
export function drawDrillSymbols(plot: PlotSink, doc: PcbDocument, s: DrillSymbols): void {
  const metric = doc.board.bag?.int('DISPLAYUNIT', 1) === 0;
  const groups = drillGroups(doc);
  for (const g of groups) for (const h of g.holes) drawSymbol(plot, h.at, g.symbol, s, g.size, metric);
  for (const t of legendStrings(doc)) drawLegend(plot, doc, groups, s, t.at, t.height || mil(60), metric);
}

/** The drill table, its top left at `at` [est: Altium's anchor]. */
export function drawLegend(plot: PlotSink, doc: PcbDocument, groups: DrillGroup[], s: DrillSymbols, at: Vec2, height: number, metric: boolean): void {
  const unit = metric ? 'mm' : 'mil';
  const rows = [['Symbol', 'Hit Count', 'Tool Size', 'Plated', 'Hole Type'],
    ...groups.map((g) => ['', String(g.holes.length), `${fmtSize(g.size, metric)}${unit}`, g.plated ? 'PTH' : 'NPTH', 'Round'])];
  const total = groups.reduce((n, g) => n + g.holes.length, 0);
  rows.push(['', String(total), 'Totals', '', '']);
  const pad = height * 0.6, rowH = height * 2;
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => strokeTextWidth(r[c]!, height))) + 2 * pad);
  widths[0] = Math.max(widths[0]!, s.size + 2 * pad);
  const W = widths.reduce((a, b) => a + b, 0), H = rows.length * rowH;
  const w = Math.max(height / 10, mil(2));
  const x0 = at.x, y0 = at.y;
  // Frame and rules
  plot.polyline([{ x: x0, y: y0 }, { x: x0 + W, y: y0 }, { x: x0 + W, y: y0 - H }, { x: x0, y: y0 - H }, { x: x0, y: y0 }], w);
  for (let r = 1; r < rows.length; r++) plot.line({ x: x0, y: y0 - r * rowH }, { x: x0 + W, y: y0 - r * rowH }, w);
  let x = x0;
  for (let c = 0; c < widths.length - 1; c++) { x += widths[c]!; plot.line({ x, y: y0 }, { x, y: y0 - H }, w); }
  rows.forEach((row, r) => {
    let cx = x0;
    row.forEach((cell, c) => {
      const base = { x: cx + pad, y: y0 - (r + 1) * rowH + (rowH - height) / 2 };
      if (cell) for (const pl of strokeText(cell, base, height)) plot.polyline(pl, w);
      cx += widths[c]!;
    });
    const g = groups[r - 1];
    if (g) drawSymbol(plot, { x: x0 + widths[0]! / 2, y: y0 - (r + 0.5) * rowH }, g.symbol, { ...s, size: Math.min(s.size, rowH * 0.8) }, g.size, metric);
  });
  void doc;
}

/** Drill guide: a cross at each hole, half its size across [AD17 print; est for other sizes]. */
export function drawDrillGuide(plot: PlotSink, doc: PcbDocument): void {
  for (const h of drillHoles(doc)) {
    const a = h.size / 4, w = mil(5);
    plot.line({ x: h.at.x - a, y: h.at.y }, { x: h.at.x + a, y: h.at.y }, w);
    plot.line({ x: h.at.x, y: h.at.y - a }, { x: h.at.x, y: h.at.y + a }, w);
  }
}
