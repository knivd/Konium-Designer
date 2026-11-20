/**
 * What the diagram editor does to a page beyond single edits: a library entry placed (with its
 * items, or as a connector), the default style for new shapes (Set as Default Style), the
 * style clipboard (Copy / Paste Style), paper sizes and the page view's pages.
 */
import { addFreeEdge, addVertex, attr, setSheet, Style, type DiagramPage, type P, type Rect } from '../../formats/drawio';
import type { Entry } from './library';

/* ─── Placing a library entry ─── */

/** An entry placed with its box's top left at `at`: the ids made (the first is the shape or connector). */
export function insertEntry(p: DiagramPage, x: Entry, at: P): string[] {
  if (x.edge) {
    const q = (o: P) => ({ x: at.x + o.x, y: at.y + o.y });
    return [addFreeEdge(p, withDefaults(x.style, 'edge'), x.value ?? '', q(x.edge.from), q(x.edge.to), (x.edge.points ?? []).map(q))];
  }
  const id = addVertex(p, { x: at.x, y: at.y, w: x.w, h: x.h }, x.value ?? '', withDefaults(x.style, 'vertex'));
  const ids = [id];
  for (const k of x.kids ?? []) ids.push(addVertex(p, k.rect, k.value, k.style, id));
  if (x.sheet) setSheet(p, id, x.sheet);
  return ids;
}

/* ─── Default style (Set as Default Style) ─── */

/** The keys a default style carries to new shapes and connectors. */
export const DEFAULT_KEYS = ['fillColor', 'strokeColor', 'gradientColor', 'gradientDirection', 'fontColor', 'fontFamily', 'fontSize', 'fontStyle', 'strokeWidth', 'dashed', 'dashPattern',
  'shadow', 'rounded', 'opacity', 'labelBackgroundColor', 'endArrow', 'startArrow', 'endFill', 'startFill', 'endSize', 'startSize', 'edgeStyle', 'curved'];
const VERTEX_ONLY = new Set(['fillColor', 'gradientColor', 'gradientDirection']);
const EDGE_ONLY = new Set(['endArrow', 'startArrow', 'endFill', 'startFill', 'endSize', 'startSize', 'edgeStyle', 'curved']);
const STORE = 'konium.diagram.defaultStyle';
type Defaults = { vertex: Record<string, string>; edge: Record<string, string> };
let defaults: Defaults | null = null;
function load(): Defaults {
  if (defaults) return defaults;
  defaults = { vertex: {}, edge: {} };
  try { const v = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? 'null') as Defaults | null; if (v?.vertex && v.edge) defaults = v; } catch { /* kept for this session only */ }
  return defaults;
}
function save(): void { try { globalThis.localStorage?.setItem(STORE, JSON.stringify(defaults)); } catch { /* kept for this session only */ } }

/** The shape's (or connector's) style as the default for new ones. */
export function setDefaultStyle(kind: 'vertex' | 'edge', style: Style): void {
  const d = load();
  const keep: Record<string, string> = {};
  for (const k of DEFAULT_KEYS) {
    if (kind === 'vertex' ? EDGE_ONLY.has(k) : VERTEX_ONLY.has(k)) continue;
    const v = style.get(k);
    if (v !== undefined) keep[k] = v;
  }
  d[kind] = keep;
  save();
}
export function clearDefaultStyle(): void { defaults = { vertex: {}, edge: {} }; save(); }
export const hasDefaultStyle = () => { const d = load(); return Object.keys(d.vertex).length + Object.keys(d.edge).length > 0; };

/** A new cell's style with the default's keys (a text with no fill or line keeps none). */
export function withDefaults(style: string, kind: 'vertex' | 'edge'): string {
  const d = load()[kind];
  if (!Object.keys(d).length) return style;
  const s = Style.parse(style);
  const bare = s.get('fillColor') === 'none' && s.get('strokeColor') === 'none';
  for (const [k, v] of Object.entries(d)) {
    if (bare && (k === 'fillColor' || k === 'strokeColor' || k === 'gradientColor' || k === 'shadow')) continue;
    s.set(k, v);
  }
  return s.toString();
}

/* ─── Copy / Paste Style ─── */

let copied: string | null = null;
export const copyStyle = (style: Style) => { copied = style.toString(); };
export const copiedStyle = () => copied;

/* ─── Paper and pages ─── */

/** Paper sizes (the format's units: 1/100 inch). */
export const PAPER: { id: string; title: string; w: number; h: number }[] = [
  { id: 'letter', title: 'US Letter (8.5" × 11")', w: 850, h: 1100 },
  { id: 'legal', title: 'US Legal (8.5" × 14")', w: 850, h: 1400 },
  { id: 'tabloid', title: 'US Tabloid (11" × 17")', w: 1100, h: 1700 },
  { id: 'executive', title: 'US Executive (7" × 10")', w: 700, h: 1000 },
  { id: 'a0', title: 'A0 (841 mm × 1189 mm)', w: 3300, h: 4681 },
  { id: 'a1', title: 'A1 (594 mm × 841 mm)', w: 2339, h: 3300 },
  { id: 'a2', title: 'A2 (420 mm × 594 mm)', w: 1654, h: 2336 },
  { id: 'a3', title: 'A3 (297 mm × 420 mm)', w: 1169, h: 1654 },
  { id: 'a4', title: 'A4 (210 mm × 297 mm)', w: 827, h: 1169 },
  { id: 'a5', title: 'A5 (148 mm × 210 mm)', w: 583, h: 827 },
  { id: 'a6', title: 'A6 (105 mm × 148 mm)', w: 413, h: 583 },
  { id: 'a7', title: 'A7 (74 mm × 105 mm)', w: 291, h: 413 },
  { id: 'b4', title: 'B4 (250 mm × 353 mm)', w: 980, h: 1390 },
  { id: 'b5', title: 'B5 (176 mm × 250 mm)', w: 690, h: 980 },
  { id: '16-9', title: '16:9 (1600 × 900)', w: 1600, h: 900 },
  { id: '16-10', title: '16:10 (1920 × 1200)', w: 1920, h: 1200 },
  { id: '4-3', title: '4:3 (1600 × 1200)', w: 1600, h: 1200 },
];
/** A page's size (pageWidth × pageHeight × pageScale; A4 landscape when unset). */
export function pageSize(model: DiagramPage['model']): { w: number; h: number } {
  const n = (k: string, def: number) => { const v = Number(attr(model, k)); return Number.isFinite(v) && v > 0 ? v : def; };
  const k = n('pageScale', 1);
  return { w: n('pageWidth', 1169) * k, h: n('pageHeight', 827) * k };
}
/** The paper a size is (either way round), or custom. */
export function paperOf(w: number, h: number): { id: string; landscape: boolean } {
  const f = PAPER.find((x) => (x.w === w && x.h === h) || (x.w === h && x.h === w));
  return { id: f?.id ?? 'custom', landscape: w > h };
}
/** The page view's pages: whole pages covering the content (one at the origin when there's none). */
export function pageLayout(size: { w: number; h: number }, content: Rect | null): Rect[] {
  const b = content ?? { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.floor(b.x / size.w), y0 = Math.floor(b.y / size.h);
  const nx = Math.max(1, Math.ceil((b.x + b.w) / size.w) - x0), ny = Math.max(1, Math.ceil((b.y + b.h) / size.h) - y0);
  const out: Rect[] = [];
  for (let j = 0; j < Math.min(ny, 50); j++) for (let i = 0; i < Math.min(nx, 50); i++) out.push({ x: (x0 + i) * size.w, y: (y0 + j) * size.h, w: size.w, h: size.h });
  return out;
}
/** Whether the page view is on (unless page="0"). */
export const pageView = (model: DiagramPage['model']) => attr(model, 'page') !== '0';
