/**
 * A Draftsman page drawn as SVG (in the document's own units, 1/96 inch, y down): the sheet with
 * its border and zones, then each item — board assembly views (top or bottom) and fabrication
 * views (the drill drawing) drawn from the board at their scale, the drill table, bill of
 * materials and layer stack table from the board, text, the title block from the document's
 * parameters — and, for an item Konium doesn't draw, a box named by its type. Each item's box
 * comes back for picking and moving.
 */
import { locale } from '../core/locale';
import type { PcbDocument } from '../model/pcb';
import { drillRows } from '../model/boardTables';
import { readStack, DIEL_TYPES } from '../model/pcbStack';
import { defaultJob } from '../model/printouts';
import { boardThickness } from './gl3d/boardModel';
import { printJobPages, type PrintPage } from './pcbPrint';
import { layerName } from '../model/layers';
import { PX_PER_MM, itemLocation, itemRotation, itemScale, itemSide, itemType, pageItems, scaleText, type DraftDocument, type DraftPage } from '../formats/altium/pcbdwf';
import { xkid, xnum, xstr, type XNode } from '../formats/xmlTree';

export interface DraftBox { x: number; y: number; w: number; h: number }
export interface DrawnItem { node: XNode; type: string; label: string; box: DraftBox }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MM = 25.4 / 10_000_000;
const f = (v: number) => (Math.round(v * 100) / 100).toString();

/* ─── The board's views and tables ───────────────────────────────────────────────── */

const viewCache = new WeakMap<object, Map<string, PrintPage[]>>();
/** The board's assembly (top, bottom) and drill drawings, once per version of its objects. */
function boardViews(doc: PcbDocument, kind: 'assembly' | 'drill', when: Date): PrintPage[] {
  let m = viewCache.get(doc.prims);
  if (!m) { m = new Map(); viewCache.set(doc.prims, m); }
  let v = m.get(kind);
  if (!v) { v = printJobPages(doc, defaultJob(doc, kind), 'mono', when); m.set(kind, v); }
  return v;
}

export function bomRows(doc: PcbDocument): string[][] {
  const groups = new Map<string, { comment: string; fp: string; refs: string[] }>();
  doc.components.forEach((c, ci) => {
    const comment = (doc.prims.find((p) => p.kind === 'text' && p.component === ci && p.isComment) as { text?: string } | undefined)?.text ?? '';
    const key = `${comment}|${c.pattern}`;
    const g = groups.get(key) ?? { comment, fp: c.pattern, refs: [] };
    g.refs.push(c.designator); groups.set(key, g);
  });
  return [...groups.values()].map((g) => [g.refs.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).join(', '), g.comment, g.fp, String(g.refs.length)]);
}
export function stackRows(doc: PcbDocument): string[][] {
  if (!doc.board.bag) return [];
  return readStack(doc.board.bag, doc.board.copperStack).filter((r) => r.kind !== 'paste' && r.kind !== 'overlay').map((r) => [
    r.layer !== null ? doc.board.layerNames.get(r.layer) ?? r.name ?? layerName(r.layer) : r.name || 'Dielectric',
    r.kind === 'dielectric' ? DIEL_TYPES[r.dielType] ?? 'Dielectric' : r.kind === 'solder' ? 'Solder Mask' : r.kind === 'coverlay' ? 'Coverlay' : r.kind === 'plane' ? 'Plane' : 'Signal',
    ((r.kind === 'signal' || r.kind === 'plane' ? r.copper : r.height) * MM).toFixed(4)]);
}

/** A table at x, y (px): its title above, headings, rows; font size in px. */
function table(x: number, y: number, title: string, cols: [string, number][], rows: string[][], size: number): { svg: string; w: number; h: number } {
  const rh = size * 1.6, w = cols.reduce((a, [, cw]) => a + cw, 0);
  const top = y + size * 1.6;
  const out = [`<text x="${f(x)}" y="${f(y + size * 1.15)}" font-size="${f(size * 1.15)}" font-weight="bold">${esc(title)}</text>`];
  const all = [cols.map(([h]) => h), ...rows];
  all.forEach((r, i) => {
    let cx = x;
    const ty = top + i * rh + rh * 0.72;
    r.forEach((cell, j) => { out.push(`<text x="${f(cx + size * 0.4)}" y="${f(ty)}" font-size="${f(size)}"${i === 0 ? ' font-weight="bold"' : ''}>${esc(cell)}</text>`); cx += cols[j]![1]; });
  });
  const h = all.length * rh;
  out.push(`<rect x="${f(x)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="#000" stroke-width="0.8"/>`);
  for (let i = 1; i < all.length; i++) out.push(`<line x1="${f(x)}" y1="${f(top + i * rh)}" x2="${f(x + w)}" y2="${f(top + i * rh)}" stroke="#000" stroke-width="${i === 1 ? 0.8 : 0.35}"/>`);
  let cx = x;
  for (const [, cw] of cols.slice(0, -1)) { cx += cw; out.push(`<line x1="${f(cx)}" y1="${f(top)}" x2="${f(cx)}" y2="${f(top + h)}" stroke="#000" stroke-width="0.35"/>`); }
  return { svg: out.join(''), w, h: h + size * 1.6 };
}
/** A column's width for its longest cell. */
const colW = (rows: string[][], j: number, head: string, size: number) => Math.max(head.length, ...rows.map((r) => (r[j] ?? '').length)) * size * 0.56 + size;

/* ─── The sheet ─────────────────────────────────────────────────────────────────── */

const ZONE = 5 * PX_PER_MM;

function sheet(p: DraftPage, lettersOnColumns: boolean): string {
  const { w, h, margin: m } = p;
  const out = [`<rect x="0" y="0" width="${f(w)}" height="${f(h)}" fill="#fff"/>`, `<rect x="${f(m)}" y="${f(m)}" width="${f(w - 2 * m)}" height="${f(h - 2 * m)}" fill="none" stroke="#000" stroke-width="1.5"/>`];
  if (!p.showZones || !p.hZones || !p.vZones) return out.join('');
  const i = m + ZONE;
  out.push(`<rect x="${f(i)}" y="${f(i)}" width="${f(w - 2 * i)}" height="${f(h - 2 * i)}" fill="none" stroke="#000" stroke-width="1"/>`);
  const label = (k: number, letters: boolean) => (letters ? String.fromCharCode(65 + (k % 26)) : String(k + 1));
  const cw = (w - 2 * i) / p.hZones, rh = (h - 2 * i) / p.vZones;
  for (let k = 0; k < p.hZones; k++) {
    const x = i + k * cw;
    if (k) for (const [y1, y2] of [[m, i], [h - i, h - m]] as const) out.push(`<line x1="${f(x)}" y1="${f(y1)}" x2="${f(x)}" y2="${f(y2)}" stroke="#000" stroke-width="0.8"/>`);
    for (const y of [m + ZONE * 0.72, h - m - ZONE * 0.28]) out.push(`<text x="${f(x + cw / 2)}" y="${f(y)}" font-size="${f(ZONE * 0.7)}" text-anchor="middle">${label(k, lettersOnColumns)}</text>`);
  }
  for (let k = 0; k < p.vZones; k++) {
    const y = i + k * rh;
    if (k) for (const [x1, x2] of [[m, i], [w - i, w - m]] as const) out.push(`<line x1="${f(x1)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y)}" stroke="#000" stroke-width="0.8"/>`);
    for (const x of [m + ZONE / 2, w - m - ZONE / 2]) out.push(`<text x="${f(x)}" y="${f(y + rh / 2 + ZONE * 0.25)}" font-size="${f(ZONE * 0.7)}" text-anchor="middle">${label(k, !lettersOnColumns)}</text>`);
  }
  return out.join('');
}

/* ─── Items ─────────────────────────────────────────────────────────────────────── */

export interface PageContext { board: PcbDocument | null; pageNo: number; pages: number; when: Date; docName: string }

/** The board outline AD last imported into the drawing (px, board y up): its bounds and segments' end points. */
function cachedBounds(d: DraftDocument): { x: number; y: number; w: number; h: number } | null {
  const info = xkid(d.root, 'BoardFabricationInformation') ?? xkid(d.root, 'BoardAssemblyInformation');
  const b = xkid(info, 'BoardOutlineBounds');
  const w = xnum(b, 'Width'), h = xnum(b, 'Height');
  return w > 0 && h > 0 ? { x: xnum(b, 'X'), y: xnum(b, 'Y'), w, h } : null;
}
function cachedOutline(d: DraftDocument, x0: number, y0: number, s: number): string | null {
  const info = xkid(d.root, 'BoardFabricationInformation') ?? xkid(d.root, 'BoardAssemblyInformation');
  const bb = cachedBounds(d);
  const segs = (xkid(xkid(info, 'BoardOutline'), 'Segments')?.kids ?? []).filter((k): k is XNode => typeof k !== 'string');
  if (!bb || segs.length < 2) return null;
  const pts = segs.map((g) => `${f(x0 + (xnum(g, 'Point/X') - bb.x) * s)},${f(y0 + (bb.y + bb.h - xnum(g, 'Point/Y')) * s)}`);
  return `<polygon points="${pts.join(' ')}" fill="none" stroke="#000" stroke-width="1.2"/>`;
}

/** The font size of a style (px; AD keeps styles by Id). */
function fontSize(d: DraftDocument, id: number, def = 12): number {
  const fs = (xkid(d.root, 'FontStyles')?.kids ?? []).find((k) => typeof k !== 'string' && xnum(k, 'Id') === id) as XNode | undefined;
  const s = xnum(fs, 'Size', def);
  return s >= 4 ? s : def;
}

/** A title's =Parameter references filled in. */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/=([A-Za-z_]\w*)/g, (m, k: string) => values[k] ?? m);
}

function drawItem(d: DraftDocument, it: XNode, c: PageContext): { svg: string; item: DrawnItem } {
  const type = itemType(it);
  const at = itemLocation(it);
  const centred = /center|centre/i.test(xstr(it, 'Anchor'));
  const titleSize = fontSize(d, xnum(it, 'TitleFontStyleId', 7));
  const showTitle = xstr(it, 'ShowTitle', 'true') !== 'false';
  const place = (w: number, h: number): DraftBox => (centred ? { x: at.x - w / 2, y: at.y - h / 2, w, h } : { x: at.x, y: at.y, w, h });
  const b = c.board;
  // Views of the board
  if (/^Board(Assembly|Fabrication)ViewData$/.test(type)) {
    const fab = type === 'BoardFabricationViewData';
    const side = itemSide(it);
    const pages = b ? boardViews(b, fab ? 'drill' : 'assembly', c.when) : [];
    const pg = fab ? pages[0] : pages[side === 'Bottom' ? 1 : 0];
    const s = itemScale(it);
    const cached = cachedBounds(d);
    const bw = pg ? (pg.box.maxX - pg.box.minX) * MM * s * PX_PER_MM : (cached?.w ?? 200) * s, bh = pg ? (pg.box.maxY - pg.box.minY) * MM * s * PX_PER_MM : (cached?.h ?? 120) * s;
    const rot = itemRotation(it) % 360;
    const [vw, vh] = rot === 90 || rot === 270 ? [bh, bw] : [bw, bh];
    const box = place(vw, vh);
    const title = showTitle ? fill(xstr(it, 'Title', fab ? 'Fabrication View' : 'View from =ViewSide side (Scale =ViewScale)'), { ViewSide: side, ViewScale: scaleText(s) }) : '';
    let body: string;
    if (pg) {
      const inner = pg.svg.replace('width="100%" height="100%"', `x="${f(box.x + (vw - bw) / 2)}" y="${f(box.y + (vh - bh) / 2)}" width="${f(bw)}" height="${f(bh)}"`);
      body = rot ? `<g transform="rotate(${-rot} ${f(box.x + vw / 2)} ${f(box.y + vh / 2)})">${inner}</g>` : inner;
    } else body = cachedOutline(d, box.x, box.y, s) ?? `<rect x="${f(box.x)}" y="${f(box.y)}" width="${f(vw)}" height="${f(vh)}" fill="none" stroke="#888" stroke-dasharray="6 4"/>`;
    if (!pg) body += `<text x="${f(box.x + 4)}" y="${f(box.y - 4)}" font-size="10" fill="#888">${esc(xstr(it, 'BoardSourceName').split(/[\\/]/).pop() || 'The board')} isn't open in the project: its outline as last imported</text>`;
    const cap = title ? `<text x="${f(box.x + vw / 2)}" y="${f(box.y + vh + titleSize * 1.4)}" font-size="${f(titleSize)}" text-anchor="middle">${esc(title)}</text>` : '';
    const full = { ...box, h: box.h + (title ? titleSize * 1.8 : 0) };
    return { svg: body + cap, item: { node: it, type, label: fab ? 'Board Fabrication View' : `Board Assembly View (${side})`, box: full } };
  }
  const size = fontSize(d, xnum(it, 'FontStyleId', 7), 12) * 0.75;
  const tableOf = (title: string, heads: string[], rows: string[][], label: string) => {
    const cols = heads.map((h, j) => [h, colW(rows, j, h, size)] as [string, number]);
    const t0 = table(0, 0, title, cols, rows, size);
    const box = place(t0.w, t0.h);
    const t = table(box.x, box.y, showTitle ? xstr(it, 'Title', title) : '', cols, rows, size);
    return { svg: t.svg, item: { node: it, type, label, box } };
  };
  if (type === 'DrillTableData' && b) {
    const rows = drillRows(b);
    return tableOf('Drill Table', ['Symbol', 'Count', 'Hole Size', 'Plated', 'Hole Type', 'Layer Pair'],
      [...rows.map((r) => [r.symbol, String(r.count), `${(r.size * MM).toFixed(3)} mm`, r.plated ? 'PTH' : 'NPTH', `${r.kind} ${r.type}`, r.pair]), ['', String(rows.reduce((a, r) => a + r.count, 0)), '', '', 'Total', '']], 'Drill Table');
  }
  if (type === 'BillOfMaterialsTableData' && b) return tableOf('Bill of Materials', ['Designator', 'Comment', 'Footprint', 'Quantity'], bomRows(b), 'Bill of Materials');
  if (type === 'LayerStackTableData' && b) {
    const rows = stackRows(b);
    return tableOf(`Layer Stack (${boardThickness(b).toFixed(3)} mm)`, ['Layer', 'Type', 'Thickness (mm)'], [...rows, ['Total', '', boardThickness(b).toFixed(4)]], 'Layer Stack Table');
  }
  if (type === 'TextDrawingItemData' || type === 'NoteDrawingItemData') {
    const fs = fontSize(d, xnum(it, 'FontStyleId', 7), 12);
    const lines = fill(xstr(it, 'Text', 'Text'), params(d, c)).split(/\r?\n/);
    const w = Math.max(...lines.map((l) => l.length)) * fs * 0.55 + 2, h = lines.length * fs * 1.25;
    const box = place(w, h);
    const svg = lines.map((l, i) => `<text x="${f(box.x)}" y="${f(box.y + fs * (i + 0.95) * 1.25 - fs * 0.25)}" font-size="${f(fs)}">${esc(l)}</text>`).join('');
    return { svg, item: { node: it, type, label: 'Text', box } };
  }
  if (type === 'TitleBlockData') {
    const k = PX_PER_MM;
    const box = place(120 * k, 36 * k);
    const v = params(d, c);
    const cell = (x: number, y: number, w: number, h: number, label: string, value: string, big = false) =>
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="#000" stroke-width="0.8"/><text x="${f(x + 1.2 * k)}" y="${f(y + 3.2 * k)}" font-size="${f(2.1 * k)}" fill="#555">${esc(label)}</text><text x="${f(x + 2 * k)}" y="${f(y + h - 2.2 * k)}" font-size="${f((big ? 5 : 3) * k)}"${big ? ' font-weight="bold"' : ''}>${esc(value)}</text>`;
    const { x, y } = box;
    const svg = `<rect x="${f(x)}" y="${f(y)}" width="${f(120 * k)}" height="${f(36 * k)}" fill="#fff" stroke="#000" stroke-width="1.5"/>`
      + cell(x, y, 120 * k, 14 * k, 'Title', v.Title!, true)
      + cell(x, y + 14 * k, 60 * k, 11 * k, 'Document', v.DocumentName!) + cell(x + 60 * k, y + 14 * k, 30 * k, 11 * k, 'Revision', v.Revision!) + cell(x + 90 * k, y + 14 * k, 30 * k, 11 * k, 'Sheet', `${v.SheetNumber} of ${v.SheetTotal}`)
      + cell(x, y + 25 * k, 60 * k, 11 * k, 'Drawn by', v.DrawnBy!) + cell(x + 60 * k, y + 25 * k, 30 * k, 11 * k, 'Date', v.CurrentDate!) + cell(x + 90 * k, y + 25 * k, 30 * k, 11 * k, 'Board', v.PCBName!);
    return { svg, item: { node: it, type, label: 'Title Block', box } };
  }
  // Not drawn here: its place and type
  const w = xnum(it, 'Size/Width', 0) || 150, h = xnum(it, 'Size/Height', 0) || 80;
  const box = place(w, h);
  const name = type.replace(/Data$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return { svg: `<rect x="${f(box.x)}" y="${f(box.y)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="#999" stroke-dasharray="5 4"/><text x="${f(box.x + 4)}" y="${f(box.y + 14)}" font-size="11" fill="#777">${esc(name)}</text>`, item: { node: it, type, label: name, box } };
}

/** The values a title or text names with =Name: the document's parameters, then the drawing's own. */
function params(d: DraftDocument, c: PageContext): Record<string, string> {
  const own: Record<string, string> = {};
  for (const p of (xkid(d.root, 'Parameters')?.kids ?? []) as (XNode | string)[]) {
    if (typeof p === 'string') continue;
    const n = xstr(p, 'Name'), v = xstr(p, 'Value');
    if (n && v) own[n] = v;
  }
  const stem = c.docName.replace(/\.[^.]+$/, '');
  return {
    DocumentName: c.docName, PCBName: c.board?.name ?? '', CurrentDate: c.when.toLocaleDateString(locale()), CurrentTime: c.when.toLocaleTimeString(locale()),
    SheetNumber: String(c.pageNo), SheetTotal: String(c.pages), Title: own.Title || stem, Revision: own.Revision || '1', DrawnBy: own.DrawnBy || own.Author || '',
    DocumentUnits: 'mm', ...own,
  };
}

/** A page as SVG (the document's units) and where each item is. */
export function drawPage(d: DraftDocument, p: DraftPage, c: PageContext): { svg: string; items: DrawnItem[] } {
  const letters = /column/i.test(xstr(xkid(d.root, 'DocumentOptions'), 'ZoneLetterPosition', 'Rows'));
  const parts = [sheet(p, letters)];
  const items: DrawnItem[] = [];
  for (const it of pageItems(p.node)) {
    try {
      const r = drawItem(d, it, c);
      parts.push(`<g data-item="${items.length}">${r.svg}</g>`);
      items.push(r.item);
    } catch (e) {
      const at = itemLocation(it);
      parts.push(`<text x="${f(at.x)}" y="${f(at.y)}" font-size="10" fill="#c00">${esc(`${itemType(it)}: ${(e as Error).message}`)}</text>`);
    }
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(p.w)} ${f(p.h)}" width="100%" height="100%" font-family="Arial, sans-serif">${parts.join('')}</svg>`, items };
}

/** A page for printing: the print pipeline sizes pages by a box in board units. */
export function printablePage(d: DraftDocument, p: DraftPage, c: PageContext): { name: string; svg: string; box: { minX: number; minY: number; maxX: number; maxY: number } } {
  const { svg } = drawPage(d, p, c);
  return { name: `${d.name} — sheet ${c.pageNo}`, svg, box: { minX: 0, minY: 0, maxX: p.w / PX_PER_MM / MM, maxY: p.h / PX_PER_MM / MM } };
}

