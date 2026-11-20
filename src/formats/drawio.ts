/**
 * Diagrams (.drawio, draw.io's own files): an mxfile of pages (<diagram>), each an mxGraphModel —
 * plain, or compressed (base64 of the raw-deflated, URI-encoded XML) — whose <root> lists its cells
 * (mxCell, or a UserObject / object holding one with its label and properties): the two root
 * cells (0, and the layer 1), vertices (a style "key=value;…", a value, an mxGeometry in its
 * parent's frame) and edges (source, target, waypoints). A bare mxGraphModel file is read too.
 *
 * Kept losslessly as an XML tree: what isn't changed is written back as it was; a compressed page
 * that is changed is written plain (draw.io reads both). A block linked to a schematic sheet keeps
 * the sheet in its UserObject's koniumSheet property (a custom property, which draw.io keeps).
 */
import { charOf } from './codePoint';
import { escapeText, localName, parseTree, writeTree, xkid, xkids, type XNode } from './xmlTree';
import { FORMERS } from '../core/former';
/** A block's linked sheet as diagrams saved under the app's earlier names have it (read, and taken out when linked again). */
const FORMER_SHEETS = FORMERS.map((f) => `${f}Sheet`);
import { inflateRawSync } from './inflate';

export interface P { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface DiagramPage {
  /** <diagram> (null for a bare mxGraphModel file). */
  node: XNode | null;
  model: XNode;
  /** Was compressed in the file: written as read until changed. */
  compressed: boolean;
  changed: boolean;
  /** Its content couldn't be read (shown blank): written as it was unless drawn on. */
  unreadable?: boolean;
  /** The layer new cells go into (the first when unset). */
  current?: string;
}

export interface DrawioDocument {
  kind: 'Diagram';
  name: string;
  prolog: string;
  root: XNode;
  /** What follows the root element (a line end). */
  tail?: string;
  pages: DiagramPage[];
  undo: { label: string; state: string }[];
  redo: { label: string; state: string }[];
  dirty: boolean;
}

export interface Cell {
  id: string;
  parent: string;
  vertex: boolean;
  edge: boolean;
  source: string;
  target: string;
  /** The label as written (HTML when the style says html=1). */
  value: string;
  style: Style;
  /** The geometry in the parent's frame. */
  rect: Rect;
  relative: boolean;
  points: P[];
  sourcePoint?: P;
  targetPoint?: P;
  offset?: P;
  sheet: string;
  /** Its link (a web address, or another page: data:page/id,…). */
  link: string;
  node: XNode;
  wrap: XNode | null;
}

/* ─── Text ─── */

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
export const unescapeXml = (s: string) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, x: string) => (x[0] === '#' ? charOf(x[1] === 'x' || x[1] === 'X' ? parseInt(x.slice(2), 16) : Number(x.slice(1))) : ENT[x.toLowerCase()] ?? m)));
export const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#xa;').replace(/\r/g, '&#xd;');
export const attr = (e: XNode | null | undefined, k: string): string | undefined => { const a = e?.attrs.find(([n]) => n === k); return a ? unescapeXml(a[1]) : undefined; };
export function setAttr(e: XNode, k: string, v: string | null): void {
  const i = e.attrs.findIndex(([n]) => n === k);
  if (v === null) { if (i >= 0) e.attrs.splice(i, 1); return; }
  if (i >= 0) e.attrs[i]![1] = escapeAttr(v); else e.attrs.push([k, escapeAttr(v)]);
}

/** A label's text: HTML (html=1) to lines — <br>, block ends as new lines, tags dropped, entities read. */
export function labelText(c: Pick<Cell, 'value' | 'style'> & { wrap?: XNode | null }): string {
  // placeholders=1: %name% stands for the object's property of that name
  const v = c.wrap && c.style.get('placeholders') === '1' ? c.value.replace(/%([^%\s<>]+)%/g, (m, k: string) => attr(c.wrap, k) ?? m) : c.value;
  if (c.style.get('html') !== '1') return v;
  return unescapeXml(v.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h\d)>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/\n+$/, '');
}
/** A label as written, its %name% placeholders filled in (HTML when the style says html=1). */
export function labelSource(c: Pick<Cell, 'value' | 'style'> & { wrap?: XNode | null }): string {
  return c.wrap && c.style.get('placeholders') === '1' ? c.value.replace(/%([^%\s<>]+)%/g, (m, k: string) => attr(c.wrap, k) ?? m) : c.value;
}
/** Text written as a label: as HTML when the style is html=1. */
export const labelValue = (c: Pick<Cell, 'style'>, text: string) => (c.style.get('html') === '1' ? escapeText(text).replace(/\n/g, '<br>') : text);

/* ─── Styles ─── */

/** draw.io's style: "name;key=value;…" — the leading names (ellipse, text, swimlane …) and keys, in order. */
export class Style {
  constructor(public parts: [string, string | null][]) {}
  static parse(s: string): Style { return new Style(s.split(';').filter((p) => p.trim() !== '').map((p) => { const i = p.indexOf('='); return i < 0 ? [p.trim(), null] : [p.slice(0, i).trim(), p.slice(i + 1)]; })); }
  get(k: string): string | undefined { const p = this.parts.find(([n, v]) => n === k && v !== null); return p?.[1] ?? undefined; }
  has(name: string): boolean { return this.parts.some(([n, v]) => n === name && v === null); }
  /** The shape: shape=…, else a leading name that is one, else rectangle. */
  shape(): string {
    const s = this.get('shape');
    if (s) return s;
    const lead = this.parts.find(([, v]) => v === null)?.[0];
    return lead ?? 'rectangle';
  }
  set(k: string, v: string | null): void {
    const i = this.parts.findIndex(([n, x]) => n === k && x !== null);
    if (v === null) { if (i >= 0) this.parts.splice(i, 1); return; }
    if (i >= 0) this.parts[i]![1] = v; else this.parts.push([k, v]);
  }
  toString(): string { return this.parts.map(([n, v]) => (v === null ? n : `${n}=${v}`)).join(';') + (this.parts.length ? ';' : ''); }
}

/* ─── Reading ─── */

/** A compressed page's XML: base64 → raw deflate → URI-encoded text. */
export function decompressPage(text: string): string {
  const bin = atob(text.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return decodeURIComponent(new TextDecoder().decode(inflateRawSync(bytes)));
}

export const isDrawio = (bytes: Uint8Array) => /^\s*(<\?xml[^>]*>\s*)?<(mxfile|mxGraphModel)\b/.test(new TextDecoder().decode(bytes.subarray(0, 400)));

export function readDrawio(bytes: Uint8Array, name: string): DrawioDocument {
  const text = new TextDecoder().decode(bytes);
  const { prolog, root } = parseTree(text);
  const d: DrawioDocument = { kind: 'Diagram', name, prolog, root, tail: text.slice(text.trimEnd().length), pages: [], undo: [], redo: [], dirty: false };
  if (localName(root.name) === 'mxGraphModel') { d.pages.push({ node: null, model: root, compressed: false, changed: false }); return d; }
  for (const dg of xkids(root).filter((k) => k.name === 'diagram')) {
    let model = xkid(dg, 'mxGraphModel'), compressed = false, unreadable = false;
    if (!model) {
      const t = dg.kids.filter((k): k is string => typeof k === 'string').join('').trim();
      if (t) { try { model = parseTree(decompressPage(t)).root; compressed = true; } catch { unreadable = true; } }
    }
    // An empty page (or one that can't be read) is drawn on a new, empty model: put in the file when drawn on (writeDrawio)
    d.pages.push({ node: dg, model: model ?? emptyModel(), compressed, changed: false, ...(unreadable ? { unreadable } : {}) });
  }
  if (!d.pages.length) { const dg = newDiagramNode('Page-1'); root.kids.push(dg); d.pages.push({ node: dg, model: xkid(dg, 'mxGraphModel')!, compressed: false, changed: true }); }
  return d;
}

export function writeDrawio(d: DrawioDocument): Uint8Array {
  for (const p of d.pages) {
    if (!p.node || (p.compressed && !p.changed)) continue;
    if (p.compressed) { p.node.kids = [p.model]; p.compressed = false; if (attr(d.root, 'compressed') === 'true') setAttr(d.root, 'compressed', 'false'); }
    // A page that was empty or unreadable, drawn on: its model goes into the file
    else if (p.changed && !p.node.kids.includes(p.model)) { p.node.kids = [p.model]; delete p.unreadable; }
  }
  return new TextEncoder().encode(writeTree(d.root, d.prolog) + (d.tail ?? ''));
}

const emptyModel = (): XNode => parseTree('<mxGraphModel dx="1000" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>').root;
const newId = (len = 20) => Array.from({ length: len }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
function newDiagramNode(name: string): XNode {
  const dg: XNode = { name: 'diagram', attrs: [['id', newId()], ['name', escapeAttr(name)]], kids: [emptyModel()], empty: false };
  return dg;
}

/** A new diagram: one page, A4 landscape, its grid on. */
export function newDrawio(name: string): DrawioDocument {
  const root: XNode = { name: 'mxfile', attrs: [['host', 'Konium'], ['agent', 'Konium Designer'], ['version', '24.0.0']], kids: [newDiagramNode('Page-1')], empty: false };
  return { kind: 'Diagram', name, prolog: '', root, pages: [{ node: root.kids[0] as XNode, model: xkid(root.kids[0] as XNode, 'mxGraphModel')!, compressed: false, changed: true }], undo: [], redo: [], dirty: true };
}

export const pageName = (p: DiagramPage, i: number) => attr(p.node, 'name') ?? `Page-${i + 1}`;
const rootOf = (p: DiagramPage) => { let r = xkid(p.model, 'root'); if (!r) { r = { name: 'root', attrs: [], kids: [], empty: false }; p.model.kids.push(r); } return r; };
const num = (e: XNode | undefined, k: string, def = 0) => { const v = Number(attr(e, k)); return Number.isFinite(v) ? v : def; };
const pt = (e: XNode | undefined): P | undefined => (e ? { x: num(e, 'x'), y: num(e, 'y') } : undefined);

/** The page's cells, in drawing order. */
export function cells(p: DiagramPage): Cell[] {
  const out: Cell[] = [];
  for (const k of xkids(rootOf(p))) {
    const wrap = k.name === 'mxCell' ? null : k;
    const cell = wrap ? xkid(wrap, 'mxCell') : k;
    if (!cell) continue;
    const geo = xkids(cell).find((g) => g.name === 'mxGeometry');
    const arr = xkids(geo).find((g) => g.name === 'Array' && attr(g, 'as') === 'points');
    const pts = xkids(geo).filter((g) => g.name === 'mxPoint');
    out.push({
      id: attr(wrap, 'id') ?? attr(cell, 'id') ?? '', parent: attr(cell, 'parent') ?? '', vertex: attr(cell, 'vertex') === '1', edge: attr(cell, 'edge') === '1',
      source: attr(cell, 'source') ?? '', target: attr(cell, 'target') ?? '', value: (wrap ? attr(wrap, 'label') : attr(cell, 'value')) ?? '',
      style: Style.parse(attr(cell, 'style') ?? ''), rect: { x: num(geo, 'x'), y: num(geo, 'y'), w: num(geo, 'width'), h: num(geo, 'height') }, relative: attr(geo, 'relative') === '1',
      points: xkids(arr).filter((g) => g.name === 'mxPoint').map((g) => pt(g)!), sourcePoint: pt(pts.find((g) => attr(g, 'as') === 'sourcePoint')),
      targetPoint: pt(pts.find((g) => attr(g, 'as') === 'targetPoint')), offset: pt(pts.find((g) => attr(g, 'as') === 'offset')), sheet: attr(wrap, 'koniumSheet') ?? FORMER_SHEETS.map((a) => attr(wrap, a)).find((v) => v !== undefined) ?? '', link: attr(wrap, 'link') ?? '', node: cell, wrap,
    });
  }
  return out;
}

/* ─── Geometry ─── */

export interface Layout { byId: Map<string, Cell>; abs: Map<string, Rect>; layers: Set<string> }
/** Each vertex's rectangle on the page (a child's geometry is in its parent's frame). */
export function layout(list: Cell[]): Layout {
  const byId = new Map(list.map((c) => [c.id, c]));
  const layers = new Set(list.filter((c) => !c.vertex && !c.edge && byId.get(c.parent) && !byId.get(byId.get(c.parent)!.parent)).map((c) => c.id));
  for (const c of list) if (!c.parent) layers.add(c.id);
  const abs = new Map<string, Rect>();
  const of = (c: Cell, depth = 0): Rect => {
    const k = abs.get(c.id);
    if (k) return k;
    const par = byId.get(c.parent);
    const o = par && par.vertex && depth < 50 ? of(par, depth + 1) : { x: 0, y: 0, w: 0, h: 0 };
    const r = { x: o.x + c.rect.x, y: o.y + c.rect.y, w: c.rect.w, h: c.rect.h };
    abs.set(c.id, r);
    return r;
  };
  for (const c of list) if (c.vertex && !c.relative) of(c);
  return { byId, abs, layers };
}

const centre = (r: Rect): P => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** Where the line from inside a rectangle's centre towards p leaves it. */
export function clip(r: Rect, from: P, to: P): P {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (!dx && !dy) return from;
  const tx = dx ? ((dx > 0 ? r.x + r.w : r.x) - from.x) / dx : Infinity, ty = dy ? ((dy > 0 ? r.y + r.h : r.y) - from.y) / dy : Infinity;
  const t = Math.max(0, Math.min(tx, ty, 1));
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** A shape's outline as a polygon (fractions of its box), for the shapes whose connectors end on it; null: an ellipse, or the box. */
function outlinePoly(st: Style): [number, number][] | null | 'ellipse' {
  const per = st.get('perimeter') ?? '';
  const shape = st.shape();
  const lead = st.parts.find(([, v]) => v === null)?.[0];
  if (/ellipse/i.test(per) || shape === 'ellipse' || shape === 'doubleEllipse' || (shape === 'cloud' && lead === 'ellipse')) return 'ellipse';
  if (/rhombus/i.test(per) || shape === 'rhombus') return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  if (/triangle/i.test(per) || shape === 'triangle') return [[0, 0], [1, 0.5], [0, 1]];
  if (/hexagon/i.test(per) || shape === 'hexagon') return [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]];
  return null;
}
/** Where the line from a shape's centre towards p leaves its outline (its box, an ellipse, a diamond, a triangle, a hexagon), the shape turned as it is. */
export function perimeterPoint(r: Rect, st: Style, toward: P): P {
  const c = centre(r);
  const rot = Number(st.get('rotation') ?? 0) || 0;
  const dir = st.get('direction') ?? 'east';
  const turnBy = (q: P, deg: number): P => { const a = (deg * Math.PI) / 180; return { x: c.x + (q.x - c.x) * Math.cos(a) - (q.y - c.y) * Math.sin(a), y: c.y + (q.x - c.x) * Math.sin(a) + (q.y - c.y) * Math.cos(a) }; };
  const t = rot ? turnBy(toward, -rot) : toward;
  const kind = outlinePoly(st);
  let out: P;
  if (kind === 'ellipse') {
    const dx = t.x - c.x, dy = t.y - c.y, a = r.w / 2, b = r.h / 2;
    const k = dx || dy ? 1 / Math.sqrt((dx * dx) / (a * a || 1) + (dy * dy) / (b * b || 1)) : 0;
    out = { x: c.x + dx * k, y: c.y + dy * k };
  } else if (kind) {
    // The polygon in the box, turned by its direction
    const dturn = dir === 'south' ? 90 : dir === 'west' ? 180 : dir === 'north' ? 270 : 0;
    const swap = dturn % 180 !== 0;
    const w = swap ? r.h : r.w, h = swap ? r.w : r.h;
    const pts = kind.map(([fx, fy]) => turnBy({ x: c.x - w / 2 + fx * w, y: c.y - h / 2 + fy * h }, dturn));
    out = clip(r, c, t);
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i]!, p2 = pts[(i + 1) % pts.length]!;
      const q = hit(c, t, p1, p2);
      if (q && q.k < best) { best = q.k; out = q.p; }
    }
  } else out = clip(r, c, t);
  return rot ? turnBy(out, rot) : out;
}
/** A point turned about a centre by deg degrees (clockwise on the page). */
export function turnAbout(q: P, c: P, deg: number): P {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return { x: c.x + (q.x - c.x) * cos - (q.y - c.y) * sin, y: c.y + (q.x - c.x) * sin + (q.y - c.y) * cos };
}
/**
 * Where a connection point (fractions of a shape's box, plus an offset) is on the page, as the
 * format places it: turned with the shape's direction and rotation; on its outline (perimeter),
 * else exactly there and mirrored with the shape's flips.
 */
export function portPoint(r: Rect, st: Style, f: P, off: P = { x: 0, y: 0 }, perimeter = true): P {
  const c = centre(r);
  const dir = st.get('direction');
  const r1 = st.get('anchorPointDirection') === '0' ? 0 : dir === 'north' ? 270 : dir === 'west' ? 180 : dir === 'south' ? 90 : 0;
  const b = r1 % 180 ? { x: c.x - r.h / 2, y: c.y - r.w / 2, w: r.h, h: r.w } : r;
  let q = { x: b.x + f.x * b.w + off.x, y: b.y + f.y * b.h + off.y };
  const rot = Number(st.get('rotation') ?? 0) || 0;
  if (perimeter) {
    if (r1) q = turnAbout(q, c, r1);
    // perimeterPoint takes the point as turned with the shape
    return perimeterPoint(r, st, rot ? turnAbout(q, c, rot) : q);
  }
  let fh = st.get('flipH') === '1' || st.get('stencilFlipH') === '1', fv = st.get('flipV') === '1' || st.get('stencilFlipV') === '1';
  if (dir === 'north' || dir === 'south') [fh, fv] = [fv, fh];
  if (fh) q = { x: 2 * c.x - q.x, y: q.y };
  if (fv) q = { x: q.x, y: 2 * c.y - q.y };
  return rot + r1 ? turnAbout(q, c, rot + r1) : q;
}

/** Where the ray from a through b first crosses the segment p1-p2 (k: how far along the ray). */
function hit(a: P, b: P, p1: P, p2: P): { p: P; k: number } | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = p2.x - p1.x, sy = p2.y - p1.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const k = ((p1.x - a.x) * sy - (p1.y - a.y) * sx) / den, u = ((p1.x - a.x) * ry - (p1.y - a.y) * rx) / den;
  return k >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? { p: { x: a.x + rx * k, y: a.y + ry * k }, k } : null;
}

type Dir = { x: number; y: number };
/** The way out of a box from a point on (or in) it: the side it is nearest. */
function sideOf(r: Rect, q: P): Dir {
  const d = [[Math.abs(q.x - r.x), -1, 0], [Math.abs(r.x + r.w - q.x), 1, 0], [Math.abs(q.y - r.y), 0, -1], [Math.abs(r.y + r.h - q.y), 0, 1]] as const;
  const m = [...d].sort((a, b) => a[0] - b[0])[0]!;
  return { x: m[1], y: m[2] };
}
/** Points on one line dropped (and repeats): a route's corners only. */
function corners(pts: P[]): P[] {
  const out: P[] = [];
  for (const q of pts) {
    if (out.length && Math.abs(out[out.length - 1]!.x - q.x) < 1e-6 && Math.abs(out[out.length - 1]!.y - q.y) < 1e-6) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!, b = out[out.length - 1]!;
      if ((Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - q.x) < 1e-6) || (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - q.y) < 1e-6)) out.pop();
    }
    out.push(q);
  }
  return out;
}
/** An orthogonal route between two ports, each leaving its shape the way it faces. */
function portRoute(a: P, da: Dir, b: P, db: Dir, jetty = 20): P[] {
  const s1 = { x: a.x + da.x * jetty, y: a.y + da.y * jetty }, t1 = { x: b.x + db.x * jetty, y: b.y + db.y * jetty };
  const mid: P[] = [];
  const ha = da.x !== 0, hb = db.x !== 0;
  if (ha && hb) {
    if (da.x * (t1.x - s1.x) > 0 && db.x * (s1.x - t1.x) > 0) { const mx = (s1.x + t1.x) / 2; mid.push({ x: mx, y: s1.y }, { x: mx, y: t1.y }); } else { const my = (s1.y + t1.y) / 2; mid.push({ x: s1.x, y: my }, { x: t1.x, y: my }); }
  } else if (!ha && !hb) {
    if (da.y * (t1.y - s1.y) > 0 && db.y * (s1.y - t1.y) > 0) { const my = (s1.y + t1.y) / 2; mid.push({ x: s1.x, y: my }, { x: t1.x, y: my }); } else { const mx = (s1.x + t1.x) / 2; mid.push({ x: mx, y: s1.y }, { x: mx, y: t1.y }); }
  } else if (ha) mid.push(da.x * (t1.x - s1.x) >= 0 ? { x: t1.x, y: s1.y } : { x: s1.x, y: t1.y });
  else mid.push(da.y * (t1.y - s1.y) >= 0 ? { x: s1.x, y: t1.y } : { x: t1.x, y: s1.y });
  return corners([a, s1, ...mid, t1, b]);
}

/** The routes Konium draws (edgeStyle): their names in the Waypoints menu. */
export type RouteKind = 'straight' | 'orthogonal' | 'elbow' | 'elbowVertical' | 'isometric' | 'entityRelation';
export function routeKind(st: Style): RouteKind {
  const es = st.get('edgeStyle') ?? '';
  if (/orthogonal|segment/i.test(es)) return 'orthogonal';
  if (/elbow/i.test(es)) return st.get('elbow') === 'vertical' ? 'elbowVertical' : 'elbow';
  if (/isometric/i.test(es)) return 'isometric';
  if (/entityRelation/i.test(es)) return 'entityRelation';
  return 'straight';
}

/**
 * An edge's route on the page: its ends on its shapes' outlines (or fixed points), through its
 * waypoints, as its style routes it (straight, orthogonal, elbow, isometric, entity relation).
 */
export function edgeRoute(e: Cell, l: Layout): P[] {
  const sr = l.abs.get(e.source), tr = l.abs.get(e.target);
  const sc = l.byId.get(e.source), tc = l.byId.get(e.target);
  const fixed = (r: Rect | undefined, cell: Cell | undefined, kx: string, ky: string): P | null => {
    const fx = Number(e.style.get(kx)), fy = Number(e.style.get(ky)), pre = kx.slice(0, -1);
    if (!r || !cell || e.style.get(kx) === undefined || e.style.get(ky) === undefined || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    return portPoint(r, cell.style, { x: fx, y: fy }, { x: Number(e.style.get(`${pre}Dx`)) || 0, y: Number(e.style.get(`${pre}Dy`)) || 0 }, e.style.get(`${pre}Perimeter`) !== '0');
  };
  const s0 = fixed(sr, sc, 'exitX', 'exitY'), t0 = fixed(tr, tc, 'entryX', 'entryY');
  // An edge inside a group: its points in the group's frame
  const o = l.byId.get(e.parent)?.vertex ? l.abs.get(e.parent) : undefined;
  const at = (q: P | undefined): P | undefined => (q && o ? { x: q.x + o.x, y: q.y + o.y } : q);
  let a = s0 ?? (sr ? centre(sr) : at(e.sourcePoint) ?? { x: 0, y: 0 }), b = t0 ?? (tr ? centre(tr) : at(e.targetPoint) ?? { x: 0, y: 0 });
  const way = e.points.map((q) => at(q)!);
  const kind = routeKind(e.style);
  let pts: P[] = [a, ...way, b];
  let clipS = !!sr && !s0, clipT = !!tr && !t0;
  if (kind === 'orthogonal') {
    if (way.length) {
      const out: P[] = [pts[0]!];
      for (let i = 1; i < pts.length; i++) { const p = out[out.length - 1]!, q = pts[i]!; if (p.x !== q.x && p.y !== q.y) out.push(i % 2 ? { x: q.x, y: p.y } : { x: p.x, y: q.y }); out.push(q); }
      pts = out;
    } else if ((s0 && sr) || (t0 && tr)) {
      // A fixed end leaves its side square to it; a loose end faces the other
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const toward = (from: P, to: P): Dir => (horiz ? { x: Math.sign(to.x - from.x) || 1, y: 0 } : { x: 0, y: Math.sign(to.y - from.y) || 1 });
      const da = s0 && sr ? sideOf(sr, s0) : toward(a, b), db = t0 && tr ? sideOf(tr, t0) : toward(b, a);
      if (!s0 && sr) a = { x: da.x ? (da.x > 0 ? sr.x + sr.w : sr.x) : a.x, y: da.y ? (da.y > 0 ? sr.y + sr.h : sr.y) : a.y };
      if (!t0 && tr) b = { x: db.x ? (db.x > 0 ? tr.x + tr.w : tr.x) : b.x, y: db.y ? (db.y > 0 ? tr.y + tr.h : tr.y) : b.y };
      pts = portRoute(a, da, b, db);
      if (sr && !s0) pts[0] = perimeterPoint(sr, sc!.style, pts[1]!);
      clipS = false; clipT = false;
      if (tr && !t0) pts[pts.length - 1] = perimeterPoint(tr, tc!.style, pts[pts.length - 2]!);
    } else {
      const horiz = sr && tr ? (Math.max(sr.x, tr.x) > Math.min(sr.x + sr.w, tr.x + tr.w)) : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const vertical = e.style.get('elbow') === 'vertical' || (!horiz && !!sr && !!tr);
      if (vertical) { const my = (a.y + b.y) / 2; pts = [a, { x: a.x, y: my }, { x: b.x, y: my }, b]; } else { const mx = (a.x + b.x) / 2; pts = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]; }
    }
  } else if (kind === 'elbow' || kind === 'elbowVertical') {
    const w = way[0];
    if (kind === 'elbow') { const mx = w?.x ?? (a.x + b.x) / 2; pts = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]; } else { const my = w?.y ?? (a.y + b.y) / 2; pts = [a, { x: a.x, y: my }, { x: b.x, y: my }, b]; }
  } else if (kind === 'entityRelation') {
    // Out of the sides facing each other, a stub each, then across
    const seg = Number(e.style.get('segment') ?? 30) || 30;
    const sx = sr ? (b.x >= centre(sr).x ? 1 : -1) : 1, tx = tr ? (a.x > centre(tr).x ? 1 : -1) : -1;
    const sa = s0 ?? (sr ? { x: sx > 0 ? sr.x + sr.w : sr.x, y: centre(sr).y } : a), tb = t0 ?? (tr ? { x: tx > 0 ? tr.x + tr.w : tr.x, y: centre(tr).y } : b);
    pts = [sa, { x: sa.x + sx * seg, y: sa.y }, ...way, { x: tb.x + tx * seg, y: tb.y }, tb];
    clipS = false; clipT = false;
  } else if (kind === 'isometric') {
    // Up or down at 30° across, then straight on
    const dx = b.x - a.x, k = Math.tan(Math.PI / 6) * Math.abs(dx), dy = b.y - a.y;
    const bend = Math.abs(dy) > k ? { x: b.x, y: a.y + Math.sign(dy) * k } : { x: a.x + Math.sign(dx) * (Math.abs(dy) / Math.tan(Math.PI / 6)), y: b.y };
    pts = way.length ? [a, ...way, b] : [a, bend, b];
  }
  // The ends on the shapes' outlines, unless fixed
  if (clipS && sc && pts.length > 1) pts[0] = perimeterPoint(sr!, sc.style, pts[1]!);
  if (clipT && tc && pts.length > 1) pts[pts.length - 1] = perimeterPoint(tr!, tc.style, pts[pts.length - 2]!);
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

/** The point at a fraction (-1 … 1, 0 the middle) along a route, as draw.io places an edge's label. */
export function alongRoute(pts: P[], f: number): P { return along(pts, f).at; }
function along(pts: P[], f: number): { at: P; d: P } {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));
  const total = lens.reduce((a, b) => a + b, 0);
  let want = ((f + 1) / 2) * total;
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i]! || i === lens.length - 1) {
      const t = lens[i] ? Math.min(1, want / lens[i]!) : 0, dx = pts[i + 1]!.x - pts[i]!.x, dy = pts[i + 1]!.y - pts[i]!.y;
      return { at: { x: pts[i]!.x + dx * t, y: pts[i]!.y + dy * t }, d: lens[i] ? { x: dx / lens[i]!, y: dy / lens[i]! } : { x: 0, y: 0 } };
    }
    want -= lens[i]!;
  }
  return { at: pts[0] ?? { x: 0, y: 0 }, d: { x: 0, y: 0 } };
}
/** Where a connector's label goes: along its route (its geometry's x, -1 … 1) and across it (its y: to the left of the way the route runs), as the format places it. */
export function labelPoint(pts: P[], x: number, y: number): P {
  const { at, d } = along(pts, x);
  return y ? { x: at.x + d.y * y, y: at.y - d.x * y } : at;
}

/* ─── Changes (each one undoable) ─── */

const state = (d: DrawioDocument) => JSON.stringify(d.pages.map((p) => [p.node ? writeTree(p.node) : '', writeTree(p.model), p.compressed, !!p.unreadable && !p.changed]));
function restore(d: DrawioDocument, s: string): void {
  const list = JSON.parse(s) as [string, string, boolean, boolean?][];
  const nodes: XNode[] = [];
  d.pages = list.map(([node, model, compressed, keep]) => {
    const n = node ? parseTree(node).root : null;
    const m = parseTree(model).root;
    if (n && !compressed) { const i = n.kids.findIndex((k) => typeof k !== 'string' && k.name === 'mxGraphModel'); if (i >= 0) n.kids[i] = m; }
    if (n) nodes.push(n);
    // An unreadable page not drawn on stays as it was in the file
    return { node: n, model: m, compressed, changed: !keep, ...(keep ? { unreadable: true } : {}) };
  });
  // A bare mxGraphModel file (or one made an mxfile since, undone): the model is the file
  if (d.pages.length === 1 && !d.pages[0]!.node) { d.root = d.pages[0]!.model; return; }
  // A bare file made an mxfile again (redone)
  if (localName(d.root.name) === 'mxGraphModel') d.root = { name: 'mxfile', attrs: [['host', 'Konium'], ['agent', 'Konium Designer'], ['version', '24.0.0']], kids: [], empty: false };
  d.root.kids = [...d.root.kids.filter((k) => typeof k === 'string' || k.name !== 'diagram'), ...nodes];
}
/** Changes the document, undoably: `fn` changes it; returns its label. */
export function change(d: DrawioDocument, label: string, fn: () => void, page?: DiagramPage): void {
  d.undo.push({ label, state: state(d) });
  if (d.undo.length > 200) d.undo.shift();
  d.redo = [];
  const scope = page ? [page] : d.pages;
  const before = scope.map(stacks);
  fn();
  // Stacks (a list's items) the change touched laid out again
  scope.forEach((p, i) => restack(p, before[i]));
  if (page) page.changed = true; else for (const p of d.pages) p.changed = true;
  d.dirty = true;
}
export function undoDiagram(d: DrawioDocument): string | null {
  const u = d.undo.pop();
  if (!u) return null;
  d.redo.push({ label: u.label, state: state(d) });
  restore(d, u.state);
  d.dirty = true;
  return u.label;
}
export function redoDiagram(d: DrawioDocument): string | null {
  const r = d.redo.pop();
  if (!r) return null;
  d.undo.push({ label: r.label, state: state(d) });
  restore(d, r.state);
  d.dirty = true;
  return r.label;
}

const geometry = (c: XNode): XNode => {
  let g = xkids(c).find((k) => k.name === 'mxGeometry');
  if (!g) { g = { name: 'mxGeometry', attrs: [['as', 'geometry']], kids: [], empty: true }; c.kids.push(g); c.empty = false; }
  return g;
};
const r2 = (v: number) => String(Math.round(v * 100) / 100);
function setRect(c: Cell, r: Rect): void {
  const g = geometry(c.node);
  for (const [k, v] of [['x', r.x], ['y', r.y], ['width', r.w], ['height', r.h]] as const) setAttr(g, k, v || k === 'width' || k === 'height' ? r2(v) : null);
}
function shiftPoints(c: Cell, dx: number, dy: number): void {
  const g = xkids(c.node).find((k) => k.name === 'mxGeometry');
  if (!g) return;
  const move = (p: XNode) => { setAttr(p, 'x', r2(num(p, 'x') + dx)); setAttr(p, 'y', r2(num(p, 'y') + dy)); };
  for (const k of xkids(g)) {
    if (k.name === 'mxPoint' && (attr(k, 'as') === 'sourcePoint' || attr(k, 'as') === 'targetPoint')) move(k);
    if (k.name === 'Array') xkids(k).forEach(move);
  }
}

/** The layer new cells go into: the one chosen (Layers), else the first (cell 1, usually). */
export function defaultLayer(p: DiagramPage): string {
  const list = cells(p);
  if (p.current && list.some((c) => c.id === p.current && !c.vertex && !c.edge)) return p.current;
  return list.find((c) => !c.vertex && !c.edge && c.parent && !list.find((x) => x.id === c.parent)?.parent)?.id ?? '1';
}

export function addVertex(p: DiagramPage, r: Rect, value: string, style: string, parent = defaultLayer(p)): string {
  const id = newId();
  const cell: XNode = { name: 'mxCell', attrs: [['id', id], ['value', escapeAttr(value)], ['style', escapeAttr(style)], ['vertex', '1'], ['parent', escapeAttr(parent)]], kids: [], empty: false };
  cell.kids.push({ name: 'mxGeometry', attrs: [['x', r2(r.x)], ['y', r2(r.y)], ['width', r2(r.w)], ['height', r2(r.h)], ['as', 'geometry']], kids: [], empty: true });
  rootOf(p).kids.push(cell);
  return id;
}

export function addEdge(p: DiagramPage, source: string, target: string, style: string, targetPoint?: P): string {
  const id = newId();
  const cell: XNode = { name: 'mxCell', attrs: [['id', id], ['value', ''], ['style', escapeAttr(style)], ['edge', '1'], ['parent', escapeAttr(defaultLayer(p))], ['source', escapeAttr(source)], ...(target ? [['target', escapeAttr(target)] as [string, string]] : [])], kids: [], empty: false };
  const g: XNode = { name: 'mxGeometry', attrs: [['relative', '1'], ['as', 'geometry']], kids: [], empty: true };
  if (targetPoint) { g.kids.push({ name: 'mxPoint', attrs: [['x', r2(targetPoint.x)], ['y', r2(targetPoint.y)], ['as', 'targetPoint']], kids: [], empty: true }); g.empty = false; }
  cell.kids.push(g);
  rootOf(p).kids.push(cell);
  return id;
}

/** A free edge (the palette's lines and arrows): its ends at points (or on shapes), through waypoints. */
export function addFreeEdge(p: DiagramPage, style: string, value: string, from: P, to: P, points: P[] = []): string {
  const id = newId();
  const cell: XNode = { name: 'mxCell', attrs: [['id', id], ['value', escapeAttr(value)], ['style', escapeAttr(style)], ['edge', '1'], ['parent', escapeAttr(defaultLayer(p))]], kids: [], empty: false };
  const g: XNode = { name: 'mxGeometry', attrs: [['width', '50'], ['height', '50'], ['relative', '1'], ['as', 'geometry']], kids: [], empty: false };
  const point = (q: P, as?: string): XNode => ({ name: 'mxPoint', attrs: [['x', r2(q.x)], ['y', r2(q.y)], ...(as ? [['as', as] as [string, string]] : [])], kids: [], empty: true });
  g.kids.push(point(from, 'sourcePoint'), point(to, 'targetPoint'));
  if (points.length) g.kids.push({ name: 'Array', attrs: [['as', 'points']], kids: points.map((q) => point(q)), empty: false });
  cell.kids.push(g);
  rootOf(p).kids.push(cell);
  return id;
}

/** Cells' whole styles replaced (Edit Style, Paste Style). */
export function setCellStyle(p: DiagramPage, ids: Iterable<string>, style: string): void {
  const set = new Set(ids);
  for (const c of cells(p)) if (set.has(c.id)) setAttr(c.node, 'style', Style.parse(style).toString());
}

/** Several style keys of cells at once (a swatch: fill, line and font colours). */
export function setStyles(p: DiagramPage, ids: Iterable<string>, keys: Record<string, string | null>): void {
  const set = new Set(ids);
  for (const c of cells(p)) {
    if (!set.has(c.id)) continue;
    const s = c.style;
    for (const [k, v] of Object.entries(keys)) s.set(k, v);
    setAttr(c.node, 'style', s.toString());
  }
}

/** A page option: the mxGraphModel's attribute (grid, gridSize, page, pageWidth, background, shadow, connect …). */
export function setModelAttr(p: DiagramPage, k: string, v: string | null): void { setAttr(p.model, k, v); }

const nodeId = (k: XNode) => (k.name === 'mxCell' ? attr(k, 'id') : attr(k, 'id') ?? attr(xkid(k, 'mxCell'), 'id')) ?? '';
const nodeParent = (k: XNode) => attr(k.name === 'mxCell' ? k : xkid(k, 'mxCell'), 'parent') ?? '';
/**
 * Cells to the front or back among the cells of their parent (draw.io draws a parent's cells in the
 * order they are written), or a step forward or backward.
 */
export function orderCells(p: DiagramPage, ids: Set<string>, how: 'front' | 'back' | 'forward' | 'backward'): void {
  const r = rootOf(p);
  const els = () => r.kids.filter((k): k is XNode => typeof k !== 'string');
  const parents = new Set(els().filter((k) => ids.has(nodeId(k))).map(nodeParent));
  for (const par of parents) {
    const sib = els().filter((k) => nodeParent(k) === par);
    const moving = sib.filter((k) => ids.has(nodeId(k)));
    if (!moving.length || moving.length === sib.length) continue;
    let order: XNode[];
    if (how === 'front') order = [...sib.filter((k) => !moving.includes(k)), ...moving];
    else if (how === 'back') order = [...moving, ...sib.filter((k) => !moving.includes(k))];
    else {
      order = [...sib];
      const step = how === 'forward' ? 1 : -1;
      const list = how === 'forward' ? [...moving].reverse() : moving;
      for (const m of list) {
        const i = order.indexOf(m), j = i + step;
        if (j < 0 || j >= order.length || moving.includes(order[j]!)) continue;
        order[i] = order[j]!; order[j] = m;
      }
    }
    // The siblings take the places they had, in the new order (other cells stay where they are)
    const slots = r.kids.map((k, i) => (typeof k !== 'string' && sib.includes(k) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((i, n) => { r.kids[i] = order[n]!; });
  }
}

/** The cells in draw.io's drawing order: each layer, then each cell's children after it. */
export function drawOrder(list: Cell[]): Cell[] {
  const kids = new Map<string, Cell[]>();
  const ids = new Set(list.map((c) => c.id));
  for (const c of list) { const k = ids.has(c.parent) ? c.parent : ''; if (!kids.has(k)) kids.set(k, []); kids.get(k)!.push(c); }
  const out: Cell[] = [], seen = new Set<string>();
  const walk = (id: string, depth: number) => { for (const c of kids.get(id) ?? []) { if (seen.has(c.id) || depth > 60) continue; seen.add(c.id); out.push(c); walk(c.id, depth + 1); } };
  walk('', 0);
  for (const c of list) if (!seen.has(c.id)) out.push(c);
  return out;
}

/**
 * A connector's end moved: onto a shape (at a connection point, `fixed`, as fractions of its box;
 * else to its outline), or loose at a point (`at`, in the connector's frame).
 */
export function setTerminal(p: DiagramPage, id: string, source: boolean, cell: string | null, at?: P, fixed?: (P & { perimeter?: boolean }) | null): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c?.edge) return;
  setAttr(c.node, source ? 'source' : 'target', cell);
  const g = geometry(c.node);
  const as = source ? 'sourcePoint' : 'targetPoint';
  g.kids = g.kids.filter((k) => typeof k === 'string' || !(k.name === 'mxPoint' && attr(k, 'as') === as));
  if (!cell && at) g.kids.push({ name: 'mxPoint', attrs: [['x', r2(at.x)], ['y', r2(at.y)], ['as', as]], kids: [], empty: true });
  g.empty = !g.kids.some((k) => typeof k !== 'string');
  if (attr(g, 'relative') !== '1') setAttr(g, 'relative', '1');
  const st = c.style, pre = source ? 'exit' : 'entry';
  for (const k of ['X', 'Y', 'Dx', 'Dy', 'Perimeter']) st.set(pre + k, null);
  if (cell && fixed) { st.set(`${pre}X`, String(Math.round(fixed.x * 1e4) / 1e4)); st.set(`${pre}Y`, String(Math.round(fixed.y * 1e4) / 1e4)); st.set(`${pre}Dx`, '0'); st.set(`${pre}Dy`, '0'); if (fixed.perimeter === false) st.set(`${pre}Perimeter`, '0'); }
  setAttr(c.node, 'style', st.toString());
}

/** A connector's waypoints (in its frame); none: as its route goes by itself. */
export function setEdgePoints(p: DiagramPage, id: string, pts: P[]): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c?.edge) return;
  const g = geometry(c.node);
  g.kids = g.kids.filter((k) => typeof k === 'string' || !(k.name === 'Array' && attr(k, 'as') === 'points'));
  if (pts.length) g.kids.push({ name: 'Array', attrs: [['as', 'points']], kids: pts.map((q) => ({ name: 'mxPoint', attrs: [['x', r2(q.x)], ['y', r2(q.y)]], kids: [], empty: true })), empty: false });
  g.empty = !g.kids.some((k) => typeof k !== 'string');
}

/** A connector's label (or a label on it) placed: how far along (-1 … 1, 0 the middle) and how far off its line. */
export function setLabelPosition(p: DiagramPage, id: string, along: number, offset: P): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c) return;
  const g = geometry(c.node);
  setAttr(g, 'x', Math.abs(along) < 1e-6 ? null : r2(along));
  // Across the line: all in the offset now
  setAttr(g, 'y', null);
  if (attr(g, 'relative') !== '1') setAttr(g, 'relative', '1');
  g.kids = g.kids.filter((k) => typeof k === 'string' || !(k.name === 'mxPoint' && attr(k, 'as') === 'offset'));
  if (offset.x || offset.y) g.kids.push({ name: 'mxPoint', attrs: [['x', r2(offset.x)], ['y', r2(offset.y)], ['as', 'offset']], kids: [], empty: true });
  g.empty = !g.kids.some((k) => typeof k !== 'string');
}

/** The point on a route nearest q: how far along it (-1 … 1) and the point. */
export function nearestOnRoute(pts: P[], q: P): { along: number; at: P } {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let best = { d: Infinity, s: 0, at: pts[0] ?? q }, run = 0;
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, L = lens[i]!;
    const t = L ? Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (L * L))) : 0;
    const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d < best.d) best = { d, s: run + L * t, at };
    run += L;
  }
  return { along: (best.s / total) * 2 - 1, at: best.at };
}

/** Cells moved: vertices by their geometry (not those whose parent moves too), edges' waypoints when the edge or both its ends move. */
export function moveCells(p: DiagramPage, ids: Set<string>, dx: number, dy: number): void {
  const list = cells(p);
  const byId = new Map(list.map((c) => [c.id, c]));
  const moved = (id: string): boolean => { let c = byId.get(id); for (let n = 0; c && n < 50; n++) { if (ids.has(c.id)) return true; c = byId.get(c.parent); } return false; };
  // A cell whose parent shape moves goes with it (its geometry is in its parent's frame); a connector's label stays on it
  const carried = (c: Cell) => !!byId.get(c.parent)?.vertex && moved(c.parent);
  for (const c of list) {
    if (c.vertex && !c.relative && ids.has(c.id) && !carried(c)) setRect(c, { ...c.rect, x: c.rect.x + dx, y: c.rect.y + dy });
    if (c.edge && !carried(c) && (ids.has(c.id) || ((!c.source || moved(c.source)) && (!c.target || moved(c.target)) && (c.source || c.target)))) shiftPoints(c, dx, dy);
  }
}

export function resizeCell(p: DiagramPage, id: string, r: Rect): void {
  const c = cells(p).find((x) => x.id === id);
  if (c) setRect(c, { ...r, w: Math.max(10, r.w), h: Math.max(10, r.h) });
}

/** A label written as it is given (a formatted label's HTML). */
export function setLabelRaw(p: DiagramPage, id: string, value: string): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c) return;
  if (c.wrap) setAttr(c.wrap, 'label', value); else setAttr(c.node, 'value', value);
}

export function setLabel(p: DiagramPage, id: string, text: string): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c) return;
  const v = labelValue(c, text);
  if (c.wrap) setAttr(c.wrap, 'label', v); else setAttr(c.node, 'value', v);
}

export function setStyle(p: DiagramPage, ids: Iterable<string>, key: string, value: string | null): void {
  const set = new Set(ids);
  for (const c of cells(p)) if (set.has(c.id)) { const s = c.style; s.set(key, value); setAttr(c.node, 'style', s.toString()); }
}

/** The cells and everything in them, and the edges they leave without an end, removed. */
export function removeCells(p: DiagramPage, ids: Set<string>): void {
  const list = cells(p);
  const gone = new Set(ids);
  for (let grew = true; grew;) { grew = false; for (const c of list) if (!gone.has(c.id) && (gone.has(c.parent) || (c.edge && (gone.has(c.source) || gone.has(c.target))))) { gone.add(c.id); grew = true; } }
  const r = rootOf(p);
  r.kids = r.kids.filter((k) => typeof k === 'string' || !gone.has((k.name === 'mxCell' ? attr(k, 'id') : attr(k, 'id') ?? attr(xkid(k, 'mxCell'), 'id')) ?? ''));
}

/** The cell inside a UserObject (which takes its id and label, as the format keeps properties): made so when it isn't. */
function wrapOf(p: DiagramPage, c: Cell): XNode {
  if (c.wrap) return c.wrap;
  const w: XNode = { name: 'UserObject', attrs: [['label', escapeAttr(c.value)], ['id', escapeAttr(c.id)]], kids: [c.node], empty: false };
  setAttr(c.node, 'id', null); setAttr(c.node, 'value', null);
  const r = rootOf(p);
  r.kids[r.kids.indexOf(c.node)] = w;
  return w;
}

/** A block linked to a schematic sheet (its UserObject's koniumSheet), or unlinked (''). */
export function setSheet(p: DiagramPage, id: string, sheet: string): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c || (!c.wrap && !sheet)) return;
  const w = wrapOf(p, c);
  // The link as saved under the app's earlier name: this one takes its place
  for (const a of FORMER_SHEETS) setAttr(w, a, null);
  setAttr(w, 'koniumSheet', sheet || null);
}

/** Names a cell's properties can't take (they are its own). */
export const RESERVED = new Set(['label', 'id', 'placeholders', 'koniumSheet', ...FORMER_SHEETS, 'link', 'tooltip']);
/** A cell's own properties (Edit Data), in their order. */
export function cellProps(c: Cell): [string, string][] {
  return (c.wrap?.attrs ?? []).filter(([k]) => !RESERVED.has(k)).map(([k]) => [k, attr(c.wrap, k) ?? '']);
}
/** A property set (or removed, null): the cell kept in a UserObject; its link and tooltip too. */
export function setProperty(p: DiagramPage, id: string, key: string, value: string | null): void {
  const c = cells(p).find((x) => x.id === id);
  if (!c || !/^[A-Za-z_][\w.-]*$/.test(key) || key === 'label' || key === 'id') return;
  if (!c.wrap && value === null) return;
  setAttr(wrapOf(p, c), key, value);
}

/** A page's whole XML replaced (Edit Diagram): its mxGraphModel; false when it isn't one. */
export function readModel(xml: string): XNode | null {
  let m: XNode;
  try { m = parseTree(xml).root; } catch { return null; }
  return localName(m.name) === 'mxGraphModel' && xkid(m, 'root') ? m : null;
}
export function replaceModel(d: DrawioDocument, page: DiagramPage, xml: string): boolean {
  const m = readModel(xml);
  if (!m) return false;
  if (page.node) page.node.kids = [m];
  else d.root = m;
  page.model = m;
  page.compressed = false;
  delete page.unreadable;
  return true;
}

/** A bare mxGraphModel file made an mxfile of one page, so it can take more pages and page names (as draw.io saves it). */
function ensureFile(d: DrawioDocument): void {
  if (localName(d.root.name) !== 'mxGraphModel' || !d.pages[0] || d.pages[0].node) return;
  const p = d.pages[0];
  const dg: XNode = { name: 'diagram', attrs: [['id', newId()], ['name', 'Page-1']], kids: [p.model], empty: false };
  d.root = { name: 'mxfile', attrs: [['host', 'Konium'], ['agent', 'Konium Designer'], ['version', '24.0.0']], kids: [dg], empty: false };
  p.node = dg;
}

export function addPage(d: DrawioDocument, name: string): DiagramPage {
  ensureFile(d);
  const dg = newDiagramNode(name);
  d.root.kids.push(dg);
  const p: DiagramPage = { node: dg, model: xkid(dg, 'mxGraphModel')!, compressed: false, changed: true };
  d.pages.push(p);
  return p;
}
export function removePage(d: DrawioDocument, p: DiagramPage): void {
  if (d.pages.length < 2 || !p.node) return;
  d.root.kids = d.root.kids.filter((k) => k !== p.node);
  d.pages = d.pages.filter((x) => x !== p);
}
export function renamePage(d: DrawioDocument, p: DiagramPage, name: string): void { ensureFile(d); if (p.node) setAttr(p.node, 'name', name); }

/** The page's extent: every vertex and edge, with a margin. */
export function extent(list: Cell[], l: Layout): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: P) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  for (const c of list) {
    const r = l.abs.get(c.id);
    if (c.vertex && r) { add(r); add({ x: r.x + r.w, y: r.y + r.h }); }
    if (c.edge) edgeRoute(c, l).forEach(add);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/* ─── D2: copy and paste, groups, containers, alignment, layers ─── */

/** A cell and everything inside it (children, their children …). */
function withDescendants(list: Cell[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  for (let grew = true; grew;) { grew = false; for (const c of list) if (!out.has(c.id) && out.has(c.parent)) { out.add(c.id); grew = true; } }
  return out;
}
/** Where a cell's frame sits on the page (0,0 for a layer). */
function frameOf(list: Cell[], id: string): P {
  const l = layout(list);
  const c = l.byId.get(id);
  return c?.vertex ? { x: l.abs.get(id)?.x ?? 0, y: l.abs.get(id)?.y ?? 0 } : { x: 0, y: 0 };
}
/** A cell's geometry (and an edge's points) moved from one frame to another. */
function reframe(c: Cell, from: P, to: P): void {
  const dx = from.x - to.x, dy = from.y - to.y;
  if (c.vertex && !c.relative) setRect(c, { ...c.rect, x: c.rect.x + dx, y: c.rect.y + dy });
  if (c.edge) shiftPoints(c, dx, dy);
}
const setParent = (c: Cell, parent: string) => setAttr(c.node, 'parent', parent);

/**
 * The cells, everything in them and the connectors between them, as the clipboard keeps them: an
 * mxGraphModel of their own (the top ones in page coordinates).
 */
export function copyCells(p: DiagramPage, ids: Set<string>): string {
  const list = cells(p);
  const l = layout(list);
  // A connector's label goes with its connector, not on its own
  const top = list.filter((c) => ids.has(c.id) && !ids.has(c.parent) && !(c.vertex && c.relative && l.byId.get(c.parent)?.edge));
  let all = withDescendants(list, top.map((c) => c.id));
  // Connectors whose both ends are copied come too, with their labels
  for (const c of list) if (c.edge && !all.has(c.id) && all.has(c.source) && all.has(c.target)) all.add(c.id);
  all = withDescendants(list, all);
  const kept = list.filter((c) => all.has(c.id));
  const out: XNode[] = [];
  for (const c of kept) {
    const node = parseTree(writeTree(c.wrap ?? c.node)).root;
    const inner = node.name === 'mxCell' ? node : xkid(node, 'mxCell')!;
    // The top cells in page coordinates, under the copy's own layer
    const topLevel = !all.has(c.parent);
    if (topLevel) {
      setAttr(inner, 'parent', '1');
      const o = l.byId.get(c.parent)?.vertex ? l.abs.get(c.parent) : undefined;
      if (o) {
        const tmp: Cell = { ...c, node: inner, wrap: null };
        reframe(tmp, o, { x: 0, y: 0 });
      }
    }
    // A connector's end on a shape not copied: loose, where it was
    const looseS = !!c.source && !all.has(c.source), looseT = !!c.target && !all.has(c.target);
    if (c.edge && (looseS || looseT)) {
      const route = edgeRoute(c, l);
      const f = !topLevel && l.byId.get(c.parent)?.vertex ? l.abs.get(c.parent) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      const g = geometry(inner), st = Style.parse(attr(inner, 'style') ?? '');
      for (const [loose, k, pre, q] of [[looseS, 'source', 'exit', route[0]], [looseT, 'target', 'entry', route[route.length - 1]]] as const) {
        if (!loose || !q) continue;
        setAttr(inner, k, null);
        for (const s of ['X', 'Y', 'Dx', 'Dy', 'Perimeter']) st.set(pre + s, null);
        g.kids = g.kids.filter((x) => typeof x === 'string' || !(x.name === 'mxPoint' && attr(x, 'as') === `${k}Point`));
        g.kids.push({ name: 'mxPoint', attrs: [['x', r2(q.x - f.x)], ['y', r2(q.y - f.y)], ['as', `${k}Point`]], kids: [], empty: true });
        g.empty = false;
      }
      setAttr(inner, 'style', st.toString());
    }
    out.push(node);
  }
  return writeTree({ name: 'mxGraphModel', attrs: [], kids: [{ name: 'root', attrs: [], kids: [parseTree('<mxCell id="0"/>').root, parseTree('<mxCell id="1" parent="0"/>').root, ...out], empty: false }], empty: false });
}

/** The clipboard's cells pasted onto the page, moved by dx, dy, with new ids: the ids of the top ones. */
export function pasteCells(p: DiagramPage, xml: string, dx: number, dy: number, layer = defaultLayer(p)): string[] {
  const model = parseTree(xml).root;
  const src = xkids(xkid(model, 'root'));
  const ids = new Map<string, string>();
  for (const k of src) { const id = nodeId(k); if (id && id !== '0' && id !== '1') ids.set(id, newId()); }
  const top: string[] = [];
  const r = rootOf(p);
  for (const k of src) {
    const id = nodeId(k);
    if (!ids.has(id)) continue;
    const inner = k.name === 'mxCell' ? k : xkid(k, 'mxCell')!;
    setAttr(k, 'id', ids.get(id)!);
    const par = attr(inner, 'parent') ?? '1';
    if (ids.has(par)) setAttr(inner, 'parent', ids.get(par)!);
    else { setAttr(inner, 'parent', layer); top.push(ids.get(id)!); }
    for (const t of ['source', 'target']) { const v = attr(inner, t); if (v !== undefined) setAttr(inner, t, ids.has(v) ? ids.get(v)! : null); }
    r.kids.push(k);
  }
  // The top cells (and loose connectors' points) moved
  const list = cells(p);
  for (const c of list) {
    if (!top.includes(c.id)) continue;
    if (c.vertex && !c.relative) setRect(c, { ...c.rect, x: c.rect.x + dx, y: c.rect.y + dy });
    if (c.edge) shiftPoints(c, dx, dy);
  }
  return top;
}

/** Cells (of one parent) grouped: a group cell round them, their geometry now in its frame. */
export function groupCells(p: DiagramPage, ids: Set<string>, border = 0): string {
  const list = cells(p);
  const l = layout(list);
  const picked = list.filter((c) => ids.has(c.id) && !ids.has(c.parent) && (c.vertex || c.edge));
  if (picked.length < 1) return '';
  const parent = picked[0]!.parent;
  const mine = picked.filter((c) => c.parent === parent);
  // Connectors between the grouped shapes come into the group
  const set = new Set(mine.map((c) => c.id));
  for (const c of list) if (c.edge && c.parent === parent && !set.has(c.id) && set.has(c.source) && set.has(c.target)) { set.add(c.id); mine.push(c); }
  const box = extent(mine, l);
  if (!box) return '';
  const o = frameOf(list, parent);
  const g: Rect = { x: box.x - o.x - border, y: box.y - o.y - border, w: box.w + 2 * border, h: box.h + 2 * border };
  const gid = addVertex(p, g, '', 'group;', parent);
  // The group takes the place of the first of them in the drawing order
  const r = rootOf(p);
  const gnode = r.kids.pop() as XNode;
  const first = r.kids.findIndex((k) => typeof k !== 'string' && set.has(nodeId(k)));
  r.kids.splice(first < 0 ? r.kids.length : first, 0, gnode);
  const gAbs = { x: o.x + g.x, y: o.y + g.y };
  for (const c of mine) { reframe(c, o, gAbs); setParent(c, gid); }
  // The children follow the group in the file (a cell comes after its parent)
  const moving = r.kids.filter((k): k is XNode => typeof k !== 'string' && set.has(nodeId(k)));
  r.kids = r.kids.filter((k) => typeof k === 'string' || !set.has(nodeId(k)));
  r.kids.splice(r.kids.indexOf(gnode) + 1, 0, ...moving);
  return gid;
}

/** Groups taken apart: their cells back in the group's parent, where they were on the page; the empty groups removed. */
export function ungroupCells(p: DiagramPage, ids: Set<string>): string[] {
  // The innermost first, the page read again for each (a group taken apart moves its cells to its parent)
  const list0 = cells(p), by0 = new Map(list0.map((c) => [c.id, c]));
  const depth = (c: Cell) => { let n = 0; for (let x = by0.get(c.parent); x && n < 60; x = by0.get(x.parent)) n++; return n; };
  const order = list0.filter((c) => ids.has(c.id) && c.vertex && !c.relative).sort((a, b) => depth(b) - depth(a)).map((c) => c.id);
  const freed = new Set<string>();
  for (const id of order) {
    const list = cells(p);
    const g = list.find((c) => c.id === id);
    if (!g) continue;
    const kids = list.filter((c) => c.parent === g.id);
    if (!kids.length) continue;
    const from = frameOf(list, g.id), to = frameOf(list, g.parent);
    for (const c of kids) { reframe(c, from, to); setParent(c, g.parent); freed.add(c.id); }
    // A plain group goes; a container keeps its shape
    if (g.style.shape() === 'group' || g.style.has('group')) { removeCells(p, new Set([g.id])); freed.delete(g.id); }
  }
  return [...freed];
}

/** Cells into a container (or out of it to a layer), staying where they are on the page; in front of the container's other cells. */
export function reparentCells(p: DiagramPage, ids: Iterable<string>, parent: string): void {
  const list = cells(p);
  const to = frameOf(list, parent);
  const r = rootOf(p);
  for (const id of ids) {
    const c = list.find((x) => x.id === id);
    if (!c || c.parent === parent || c.id === parent || withDescendants(list, [c.id]).has(parent)) continue;
    reframe(c, frameOf(list, c.parent), to);
    setParent(c, parent);
    // It and its cells to the end of the file: after their new parent, in front of its other cells
    const block = withDescendants(list, [c.id]);
    const nodes = r.kids.filter((k): k is XNode => typeof k !== 'string' && block.has(nodeId(k)));
    r.kids = [...r.kids.filter((k) => typeof k === 'string' || !block.has(nodeId(k))), ...nodes];
  }
}

/** Shapes lined up on the selection's bounds: left sides, centres, right sides, tops, middles or bottoms. */
export function alignCells(p: DiagramPage, ids: Set<string>, how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
  const list = cells(p);
  const l = layout(list);
  const vs = list.filter((c) => ids.has(c.id) && c.vertex && !c.relative && !ids.has(c.parent));
  if (vs.length < 2) return;
  const rs = vs.map((c) => l.abs.get(c.id)!);
  const x0 = Math.min(...rs.map((r) => r.x)), x1 = Math.max(...rs.map((r) => r.x + r.w)), y0 = Math.min(...rs.map((r) => r.y)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  vs.forEach((c, i) => {
    const r = rs[i]!;
    const nx = how === 'left' ? x0 : how === 'right' ? x1 - r.w : how === 'center' ? (x0 + x1) / 2 - r.w / 2 : r.x;
    const ny = how === 'top' ? y0 : how === 'bottom' ? y1 - r.h : how === 'middle' ? (y0 + y1) / 2 - r.h / 2 : r.y;
    setRect(c, { ...c.rect, x: c.rect.x + nx - r.x, y: c.rect.y + ny - r.y });
  });
}

/** Shapes spread evenly between the outermost two: their centres equally apart. */
export function distributeCells(p: DiagramPage, ids: Set<string>, horizontal: boolean): void {
  const list = cells(p);
  const l = layout(list);
  const vs = list.filter((c) => ids.has(c.id) && c.vertex && !c.relative && !ids.has(c.parent));
  if (vs.length < 3) return;
  const mid = (c: Cell) => { const r = l.abs.get(c.id)!; return horizontal ? r.x + r.w / 2 : r.y + r.h / 2; };
  const sorted = [...vs].sort((a, b) => mid(a) - mid(b));
  const a = mid(sorted[0]!), b = mid(sorted[sorted.length - 1]!);
  sorted.forEach((c, i) => {
    const want = a + ((b - a) * i) / (sorted.length - 1), d = want - mid(c);
    setRect(c, { ...c.rect, x: c.rect.x + (horizontal ? d : 0), y: c.rect.y + (horizontal ? 0 : d) });
  });
}

/* Layers: the cells whose parent is the root cell (0) */

export interface LayerInfo { id: string; name: string; visible: boolean; locked: boolean }
export function layers(p: DiagramPage): LayerInfo[] {
  const list = cells(p);
  const root = list.find((c) => !c.parent)?.id ?? '0';
  return list.filter((c) => c.parent === root && !c.vertex && !c.edge).map((c, i) => ({ id: c.id, name: c.value || (i ? `Layer ${i}` : 'Background'), visible: attr(c.node, 'visible') !== '0', locked: c.style.get('locked') === '1' }));
}
export function addLayer(p: DiagramPage, name: string): string {
  const id = newId();
  const root = cells(p).find((c) => !c.parent)?.id ?? '0';
  rootOf(p).kids.push({ name: 'mxCell', attrs: [['id', id], ['value', escapeAttr(name)], ['parent', escapeAttr(root)]], kids: [], empty: true });
  return id;
}
export function setLayer(p: DiagramPage, id: string, k: 'name' | 'visible' | 'locked', v: string | boolean): void {
  const n = cells(p).find((c) => c.id === id);
  if (!n) return;
  if (k === 'name') setAttr(n.node, 'value', String(v));
  if (k === 'visible') setAttr(n.node, 'visible', v ? null : '0');
  if (k === 'locked') { const s = n.style; s.set('locked', v ? '1' : null); setAttr(n.node, 'style', s.toString() || null); }
}
/** Cells moved to a layer (their top cells re-parented; on the page they stay where they are). */
export function moveToLayer(p: DiagramPage, ids: Set<string>, layer: string): void {
  const list = cells(p);
  const top = list.filter((c) => ids.has(c.id) && !ids.has(c.parent) && (c.vertex || c.edge));
  reparentCells(p, top.map((c) => c.id), layer);
}

/* Containers that stack their cells (childLayout=stackLayout, as a list does), laid out as the format's stack layout does */

const STACK_KEYS = ['childLayout', 'horizontalStack', 'horizontal', 'startSize', 'resizeParent', 'resizeParentMax', 'resizeLast', 'marginLeft', 'marginTop', 'marginRight', 'marginBottom', 'stackSpacing', 'stackBorder', 'allowGaps'];
const isStack = (c: Cell) => c.vertex && c.style.get('childLayout') === 'stackLayout';
const stackKids = (list: Cell[], box: Cell) => list.filter((c) => c.parent === box.id && c.vertex && !c.relative && attr(c.node, 'visible') !== '0');
/** What a stack's layout depends on: its size, its layout's keys, its cells' places and sizes. */
const stackSig = (list: Cell[], box: Cell) => JSON.stringify([box.rect.w, box.rect.h, attr(box.node, 'collapsed') ?? '', STACK_KEYS.map((k) => box.style.get(k) ?? ''), stackKids(list, box).map((c) => [c.id, c.rect.x, c.rect.y, c.rect.w, c.rect.h])]);
/** The page's stacks as they are (to lay out again only those a change touches). */
export function stacks(p: DiagramPage): Map<string, string> {
  const list = cells(p);
  return new Map(list.filter(isStack).map((b) => [b.id, stackSig(list, b)]));
}

/**
 * Stacks laid out: their cells one after another (side by side unless horizontalStack=0) after
 * the title and margins, filling the stack across; the stack grown (or shrunk) to them
 * (resizeParent, resizeParentMax), else the last cell stretched to its end (resizeLast). Given
 * the stacks as they were before a change, only those the change touched (as the other editors
 * lay out only what changes); the innermost first; folded ones (collapsed) left as they are.
 */
export function restack(p: DiagramPage, before?: Map<string, string>): void {
  const list0 = cells(p), by0 = new Map(list0.map((c) => [c.id, c]));
  const depth = (c: Cell) => { let n = 0; for (let x = by0.get(c.parent); x && n < 60; x = by0.get(x.parent)) n++; return n; };
  const order = list0.filter(isStack).sort((a, b) => depth(b) - depth(a)).map((c) => c.id);
  for (const id of order) {
    const list = cells(p);
    const box = list.find((c) => c.id === id);
    if (!box || attr(box.node, 'collapsed') === '1') continue;
    if (before && (!before.has(id) || before.get(id) === stackSig(list, box))) continue;
    stackOne(stackKids(list, box), box);
  }
}
function stackOne(kids: Cell[], box: Cell): void {
  const st = box.style, B = box.rect;
  const n = (k: string, def = 0) => { const v = Number(st.get(k) ?? def); return Number.isFinite(v) ? v : def; };
  const across = (st.get('horizontalStack') ?? '1') === '1';
  const mL = n('marginLeft'), mT = n('marginTop'), mR = n('marginRight'), mB = n('marginBottom'), border = n('stackBorder'), spacing = n('stackSpacing'), gaps = n('allowGaps') > 0;
  let fill = (across ? B.h - mT - mB : B.w - mL - mR) - 2 * border;
  let x0 = border + mL, y0 = border + mT;
  if (st.shape() === 'swimlane' || st.has('swimlane')) {
    // The title: along the top (horizontal=1) or down the left side
    const top = st.get('horizontal') !== '0';
    const start = Math.min(n('startSize', 23), top ? B.h : B.w);
    if (across === top) fill -= start;
    if (top) y0 += start; else x0 += start;
  }
  let last: Rect | null = null, lastKid: Cell | null = null;
  for (const k of kids) {
    const g = { ...k.rect };
    if (last) { const t = (across ? last.x + last.w : last.y + last.h) + spacing; if (across) g.x = gaps ? Math.max(t, g.x) : t; else g.y = gaps ? Math.max(t, g.y) : t; }
    else if (across) g.x = gaps && g.x > x0 ? g.x : x0;
    else g.y = gaps && g.y > y0 ? g.y : y0;
    if (across) { g.y = y0; g.h = Math.max(1, fill); } else { g.x = x0; g.w = Math.max(1, fill); }
    if (g.x !== k.rect.x || g.y !== k.rect.y || g.w !== k.rect.w || g.h !== k.rect.h) setRect(k, g);
    last = g; lastKid = k;
  }
  if (!last || !lastKid) return;
  if ((st.get('resizeParent') ?? '1') === '1') {
    const end = across ? last.x + last.w + mR + border : last.y + last.h + mB + border;
    const size = (st.get('resizeParentMax') ?? '1') === '1' ? Math.max(across ? B.w : B.h, end) : end;
    if (size !== (across ? B.w : B.h)) setRect(box, across ? { ...B, w: size } : { ...B, h: size });
  } else if (st.get('resizeLast') === '1') {
    const g = across ? { ...last, w: B.w - last.x - spacing - mR - mL } : { ...last, h: B.h - last.y - spacing - mB };
    if (g.w > 0 && g.h > 0) setRect(lastKid, g);
  }
}
