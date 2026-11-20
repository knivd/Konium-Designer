/**
 * A drawing's filled shapes (SVG), for a logo or an outline on an enclosure's face: each filled
 * path, polygon, polyline, rectangle (rounded or not), circle and ellipse flattened to closed
 * outlines with its fill rule, in millimetres, y up, with the transforms of the shapes and their
 * groups applied (matrix, translate, scale, rotate, skewX, skewY). Sizes come from the drawing's
 * width and height with their units and its viewBox; without units a user unit is a CSS pixel
 * (1/96 inch); presentation properties from style attributes, the drawing's style sheets (class and
 * id rules) and attributes. A white (or near-white) fill takes away what is under it, as it looks [est: a
 * one-colour logo's background and knock-outs]. Left out: shapes with no fill (strokes are not
 * outlined), hidden ones, and what <defs>, <clipPath>, <mask>, <symbol>, <pattern> and <marker>
 * hold; <use> and <text> are not followed [est: text turned into paths first, as drawing programs
 * do on export].
 */
import { parseTree, localName, xkids, type XNode } from './xmlTree';
import { pathPolylines } from './svgStrokes';

type Pt = [number, number];
/** One filled shape: its outlines (closed, the last point not repeated), how they fill, and whether it is white (taking away what is under it). */
export interface SvgShape { rings: Pt[][]; evenOdd: boolean; knock?: boolean }
/** a b c d e f, as SVG's matrix(): x' = a x + c y + e, y' = b x + d y + f. */
type Mat = [number, number, number, number, number, number];

const ID: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const UNIT: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'pattern', 'marker', 'metadata', 'title', 'desc', 'style', 'script', 'text', 'use', 'image', 'foreignObject']);

/** A transform attribute's matrix. */
export function transformOf(t: string | undefined): Mat {
  let m = ID;
  for (const x of (t ?? '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = x[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const r = (d: number) => (d * Math.PI) / 180;
    let n: Mat = ID;
    switch (x[1]) {
      case 'matrix': if (v.length === 6) n = v as Mat; break;
      case 'translate': n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = r(v[0] ?? 0), c = Math.cos(a), s = Math.sin(a), cx = v[1] ?? 0, cy = v[2] ?? 0;
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan(r(v[0] ?? 0)), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan(r(v[0] ?? 0)), 0, 1, 0, 0]; break;
    }
    if (v.some((q) => !Number.isFinite(q))) continue;
    m = mul(m, n);
  }
  return m;
}

const get = (e: XNode, name: string): string | undefined => e.attrs.find(([k]) => localName(k) === name)?.[1];
/** Declarations ("fill: none; …") as a map. */
function decls(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of s.split(';')) { const i = d.indexOf(':'); if (i > 0) m.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).replace(/!important/i, '').trim()); }
  return m;
}
/** The drawing's style sheets' rules for classes and ids (".cls-1, .cls-2 { fill: #fff }", as drawing programs write them). */
export function styleRules(root: XNode): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  const text: string[] = [];
  const find = (e: XNode) => { for (const c of xkids(e)) { if (localName(c.name) === 'style') text.push(c.kids.map((k) => (typeof k === 'string' ? k : '')).join('')); else find(c); } };
  find(root);
  const css = text.join('\n').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const r of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const d = decls(r[2]!);
    for (const sel of r[1]!.split(',').map((x) => x.trim())) {
      if (!/^[.#][\w-]+$/.test(sel)) continue;
      const m = rules.get(sel) ?? new Map<string, string>();
      for (const [k, v] of d) m.set(k, v);
      rules.set(sel, m);
    }
  }
  return rules;
}
/** A presentation property: from the style attribute, else the style sheets' rules for its classes and id, else the attribute of that name. */
function prop(e: XNode, name: string, rules?: Map<string, Map<string, string>>): string | undefined {
  const st = get(e, 'style');
  const v = st ? decls(st).get(name) : undefined;
  if (v !== undefined) return v;
  if (rules?.size) {
    let found: string | undefined;
    const id = get(e, 'id');
    for (const c of (get(e, 'class') ?? '').split(/\s+/).filter(Boolean)) { const r = rules.get(`.${c}`)?.get(name); if (r !== undefined) found = r; }
    const ri = id ? rules.get(`#${id}`)?.get(name) : undefined;
    if (ri !== undefined) found = ri;
    if (found !== undefined) return found;
  }
  return get(e, name);
}
/** A fill colour light enough to read as the paper: white, or near it. */
export function isLight(c: string): boolean {
  const s = c.trim().toLowerCase();
  if (s === 'white') return true;
  let rgb: number[] | null = null;
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (h) rgb = h[1]!.length === 3 ? [...h[1]!].map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(h[1]!.slice(i, i + 2), 16));
  const r = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/.exec(s);
  if (r) rgb = [r[1]!, r[2]!, r[3]!].map((v) => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v)));
  return !!rgb && 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]! > 0.85 * 255;
}
const len = (s: string | undefined, dflt = 0) => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : dflt; };

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 64): Pt[] {
  return Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as Pt);
}
function roundRectPts(x: number, y: number, w: number, h: number, rx: number, ry: number): Pt[] {
  if (rx <= 0 || ry <= 0) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const out: Pt[] = [], n = 12;
  const corner = (cx: number, cy: number, a0: number) => { for (let k = 0; k <= n; k++) { const a = a0 + (k / n) * (Math.PI / 2); out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } };
  corner(x + w - rx, y + ry, -Math.PI / 2); corner(x + w - rx, y + h - ry, 0); corner(x + rx, y + h - ry, Math.PI / 2); corner(x + rx, y + ry, Math.PI);
  return out;
}

/** The outlines of one element in its own user units (before its transform), or null when it draws none. */
function outlines(e: XNode): Pt[][] | null {
  switch (localName(e.name)) {
    case 'path': return pathPolylines(get(e, 'd') ?? '', 16).map((l) => l.map((p) => [p.x, p.y] as Pt));
    case 'polygon': case 'polyline': {
      const v = (get(e, 'points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number), pts: Pt[] = [];
      for (let j = 0; j + 1 < v.length; j += 2) pts.push([v[j]!, v[j + 1]!]);
      return [pts];
    }
    case 'rect': {
      const w = len(get(e, 'width')), h = len(get(e, 'height'));
      if (!(w > 0 && h > 0)) return null;
      let rx = len(get(e, 'rx'), NaN), ry = len(get(e, 'ry'), NaN);
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      return [roundRectPts(len(get(e, 'x')), len(get(e, 'y')), w, h, Math.min(rx, w / 2), Math.min(ry, h / 2))];
    }
    case 'circle': { const r = len(get(e, 'r')); return r > 0 ? [ellipsePts(len(get(e, 'cx')), len(get(e, 'cy')), r, r)] : null; }
    case 'ellipse': { const rx = len(get(e, 'rx')), ry = len(get(e, 'ry')); return rx > 0 && ry > 0 ? [ellipsePts(len(get(e, 'cx')), len(get(e, 'cy')), rx, ry)] : null; }
    default: return null;
  }
}

/** Points closer than tol to the line through their neighbours dropped (Douglas–Peucker), a closed ring. */
function thin(ring: Pt[], tol: number): Pt[] {
  // Points closer than a quarter of tol to the last one kept dropped
  const pts: Pt[] = [];
  for (const p of ring) { const q = pts.at(-1); if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > tol / 4) pts.push(p); }
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = 1;
  // Split at the point furthest from the first, then simplify each half
  let far = 1, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]); if (d > fd) { fd = d; far = i; } }
  keep[far] = 1;
  const dp = (a: number, b: number) => {
    const A = pts[a]!, B = pts[b % pts.length]!, dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) { const P = pts[i]!, d = Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / L; if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; dp(a, best); dp(best, b); }
  };
  dp(0, far); dp(far, pts.length);
  return pts.filter((_, i) => keep[i]);
}

/** The drawing's filled shapes, in mm, y up, as drawn (not centred). Empty when it holds none. */
export function svgShapes(svg: string, tol = 0.02): SvgShape[] {
  if (!/<svg[\s>]/i.test(svg)) return [];
  let root: XNode;
  try { root = parseTree(svg).root; } catch { return []; }
  if (localName(root.name) !== 'svg') { const s = findSvg(root); if (!s) return []; root = s; }
  // User units to mm, from the root's size and viewBox; y turned up
  const vb = (get(root, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const dim = (s: string | undefined) => { const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(s ?? ''); return m ? Number(m[1]) * (UNIT[m[2]!.toLowerCase()] ?? NaN) : NaN; };
  const W = dim(get(root, 'width')), H = dim(get(root, 'height'));
  let base: Mat = [UNIT.px!, 0, 0, UNIT.px!, 0, 0];
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) {
    const sx = Number.isFinite(W) ? W / vb[2]! : Number.isFinite(H) ? H / vb[3]! : UNIT.px!;
    const sy = Number.isFinite(H) ? H / vb[3]! : sx;
    // preserveAspectRatio's default (meet): one scale for both
    const k = Math.min(sx, sy);
    base = [k, 0, 0, k, -vb[0]! * k, -vb[1]! * k];
  }
  base = mul([1, 0, 0, -1, 0, 0], base);
  const out: SvgShape[] = [];
  const rules = styleRules(root);
  const walk = (e: XNode, m: Mat, fill: string, rule: string) => {
    const name = localName(e.name);
    if (SKIP.has(name)) return;
    if (prop(e, 'display', rules) === 'none' || prop(e, 'visibility', rules) === 'hidden') return;
    const mm = mul(m, transformOf(get(e, 'transform')));
    const f = prop(e, 'fill', rules) ?? fill, r = prop(e, 'fill-rule', rules) ?? rule;
    if (name === 'svg' || name === 'g' || name === 'a' || name === 'switch') { for (const c of xkids(e)) walk(c, mm, f, r); return; }
    const op = parseFloat(prop(e, 'fill-opacity', rules) ?? prop(e, 'opacity', rules) ?? '1');
    if (f === 'none' || f === 'transparent' || op === 0) return;
    const ls = outlines(e);
    if (!ls) return;
    const rings = ls.map((l) => {
      const pts = l.map(([x, y]) => apply(mm, x, y));
      const a = pts[0], b = pts.at(-1);
      if (a && b && pts.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
      return thin(pts, tol);
    }).filter((p) => p.length >= 3 && Math.abs(area(p)) > tol * tol);
    if (rings.length) out.push({ rings, evenOdd: r === 'evenodd', ...(isLight(f) ? { knock: true } : {}) });
  };
  walk(root, base, 'black', 'nonzero');
  return out;
}

function findSvg(e: XNode): XNode | undefined {
  for (const c of xkids(e)) { if (localName(c.name) === 'svg') return c; const d = findSvg(c); if (d) return d; }
  return undefined;
}

const area = (p: Pt[]) => p.reduce((t, a, i) => { const b = p[(i + 1) % p.length]!; return t + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;

/** The shapes' extent. */
export function shapesBox(sh: SvgShape[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of sh) for (const r of s.rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}
