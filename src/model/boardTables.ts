/**
 * Place › Drill Table, Place › Layer Stack Table and Place › Coordinate, drawn as tracks and
 * text in one union ("Drill Tables", "Layer Stack Tables", "Coordinates") as AD17 groups them
 * [est: AD17 keeps a drill table as a smart union that rebuilds itself, and a coordinate as its
 * own object; Konium writes plain unions of what they draw].
 *
 * Drill Table: a row per kind of hole (size, plated, round or slot, layer pair, via or pad):
 * Symbol (A, B, C …), Count, Hole Size (with the other unit), Plated, Hole Type, Drill Layer Pair,
 * Via/Pad, and the total.
 */
import type { Vec2 } from '../core/geom';
import { L, layerName, type LayerId } from './layers';
import type { PcbDocument } from './pcb';
import { readStack, stackThickness } from './pcbStack';

export interface TableLine { a: Vec2; b: Vec2 }
export interface TableText { at: Vec2; text: string }
export interface Drawn { lines: TableLine[]; texts: TableText[]; width: number; height: number }

const mils = (c: number) => c / 10_000;
const fmtMil = (c: number) => `${mils(c).toFixed(2)}mil`;
const fmtMm = (c: number) => `${(c / 393_700.787).toFixed(3)}mm`;

export interface DrillRow { symbol: string; count: number; size: number; plated: boolean; type: string; pair: string; kind: 'Via' | 'Pad' }

export function drillRows(doc: PcbDocument): DrillRow[] {
  const name = (l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);
  const rows = new Map<string, DrillRow>();
  for (const p of doc.prims) {
    if ((p.kind !== 'pad' && p.kind !== 'via') || p.hole <= 0) continue;
    const plated = p.kind === 'via' ? true : p.plated;
    const pair = p.kind === 'via' ? `${name(p.layerStart)} - ${name(p.layerEnd)}` : `${name(L.TOP)} - ${name(L.BOTTOM)}`;
    const kind = p.kind === 'via' ? 'Via' : 'Pad';
    const key = `${p.hole}|${plated}|${pair}|${kind}`;
    const r = rows.get(key);
    if (r) r.count++; else rows.set(key, { symbol: '', count: 1, size: p.hole, plated, type: 'Round', pair, kind });
  }
  const out = [...rows.values()].sort((a, b) => a.size - b.size || a.count - b.count);
  out.forEach((r, i) => { r.symbol = i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`; });
  return out;
}

/** A table's lines and texts, its top left at `at`. */
function table(at: Vec2, rows: string[][], textH: number): Drawn {
  const pad = textH * 0.5, rowH = textH * 1.8, charW = textH * 0.72;
  const cols = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)) * charW + pad * 2);
  const width = cols.reduce((a, b) => a + b, 0), height = rows.length * rowH;
  const lines: TableLine[] = [], texts: TableText[] = [];
  const r = (v: number) => Math.round(v);
  for (let i = 0; i <= rows.length; i++) lines.push({ a: { x: r(at.x), y: r(at.y - i * rowH) }, b: { x: r(at.x + width), y: r(at.y - i * rowH) } });
  let x = at.x;
  for (let c = 0; c <= cols.length; c++) { lines.push({ a: { x: r(x), y: r(at.y) }, b: { x: r(x), y: r(at.y - height) } }); x += cols[c] ?? 0; }
  rows.forEach((row, i) => {
    let cx = at.x;
    row.forEach((t, c) => { if (t) texts.push({ at: { x: r(cx + pad), y: r(at.y - (i + 1) * rowH + (rowH - textH) / 2) }, text: t }); cx += cols[c]!; });
  });
  return { lines, texts, width, height };
}

export function drillTable(doc: PcbDocument, at: Vec2, textH = 600_000): Drawn {
  const rows = drillRows(doc);
  const head = ['Symbol', 'Count', 'Hole Size', 'Plated', 'Hole Type', 'Drill Layer Pair', 'Via/Pad'];
  const body = rows.map((r) => [r.symbol, String(r.count), `${fmtMil(r.size)} (${fmtMm(r.size)})`, r.plated ? 'PTH' : 'NPTH', r.type, r.pair, r.kind]);
  const total = ['', String(rows.reduce((s, r) => s + r.count, 0)), 'Total', '', '', '', ''];
  return table(at, [head, ...body, total], textH);
}

export function layerStackTable(doc: PcbDocument, at: Vec2, textH = 600_000): Drawn {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const head = ['Layer', 'Name', 'Material', 'Thickness', 'Constant'];
  let n = 0;
  const body = rows.filter((r) => r.kind !== 'paste' && r.kind !== 'overlay').map((r) => {
    const copper = r.kind === 'signal' || r.kind === 'plane';
    const t = copper ? r.copper : r.height;
    return [copper ? String(++n) : '', r.name, copper ? 'Copper' : r.dielMaterial || (r.kind === 'solder' ? 'Solder Resist' : 'FR-4'), `${fmtMil(t)} (${fmtMm(t)})`, copper ? '' : r.dielConst ? r.dielConst.toFixed(1) : ''];
  });
  const tot = stackThickness(rows);
  return table(at, [head, ...body, ['', 'Total thickness', '', `${fmtMil(tot)} (${fmtMm(tot)})`, '']], textH);
}

/** Place › Coordinate: a small cross and its position from the origin. */
export function coordinateMarker(doc: PcbDocument, at: Vec2, units: 'mil' | 'mm', textH = 400_000, size = textH): Drawn {
  const r = Math.round(size * 0.5), o = doc.board.origin;
  const f = (v: number) => (units === 'mm' ? `${(v / 393_700.787).toFixed(3)}mm` : `${mils(v).toFixed(2)}mil`);
  return {
    lines: [{ a: { x: at.x - r, y: at.y }, b: { x: at.x + r, y: at.y } }, { a: { x: at.x, y: at.y - r }, b: { x: at.x, y: at.y + r } }],
    texts: [{ at: { x: at.x + Math.round(r * 1.4), y: at.y + Math.round(r * 0.4) }, text: `${f(at.x - o.x)}, ${f(at.y - o.y)}` }],
    width: r * 2, height: r * 2,
  };
}
