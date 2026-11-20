/**
 * Inline stencils (a style's shape=stencil(…)): a shape's drawing as the format's stencil XML,
 * kept in the style as base64 of raw-deflated, URI-encoded XML. Read (any deflate) and written
 * (stored deflate blocks: no compression, read by any inflater), and the stencil read into what
 * to draw: its size, connection points, and steps (shapes: paths, rectangles, ellipses, text;
 * paints: fill, stroke, both; colour and width changes).
 */
import { inflateRawSync } from './inflate';
import { parseTree, xkids, type XNode } from './xmlTree';

/** Raw deflate of stored blocks (no compression). */
function storedDeflate(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length || i === 0; i += 65535) {
    const n = Math.min(65535, b.length - i), last = i + 65535 >= b.length;
    out.push(last ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255);
    for (let k = 0; k < n; k++) out.push(b[i + k]!);
    if (last) break;
  }
  return Uint8Array.from(out);
}
const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

/** A stencil's XML as a style's shape: stencil(…). */
export function stencilStyle(xml: string): string {
  return `stencil(${b64(storedDeflate(new TextEncoder().encode(encodeURIComponent(xml.replace(/>\s+</g, '><').trim()))))})`;
}
/** A stencil(…) shape's XML (or the XML itself when it isn't compressed). */
export function stencilXml(shape: string): string | null {
  const m = /^stencil\(([\s\S]*)\)$/.exec(shape);
  if (!m) return null;
  const t = m[1]!.trim();
  if (t.startsWith('<')) return t;
  try {
    const bin = atob(t);
    return decodeURIComponent(new TextDecoder().decode(inflateRawSync(Uint8Array.from(bin, (c) => c.charCodeAt(0)))));
  } catch { return null; }
}

export type Op =
  /** A shape: its SVG path for a scale and offset (stencil units to the page). */
  | { k: 'path'; d: (t: Fit) => string }
  | { k: 'paint'; fill: boolean; stroke: boolean }
  | { k: 'strokecolor' | 'fillcolor' | 'fontcolor'; c: string }
  | { k: 'strokewidth'; w: number; fixed: boolean }
  | { k: 'dashed'; on: boolean }
  | { k: 'text'; s: string; x: number; y: number; align: string; valign: string }
  | { k: 'fontsize'; n: number }
  | { k: 'save' } | { k: 'restore' };
export interface Fit { sx: number; sy: number; ox: number; oy: number }
export interface Stencil { w: number; h: number; aspect: 'fixed' | 'variable'; strokewidth: 'inherit' | number; points: { x: number; y: number; perimeter?: true }[]; background: Op[]; foreground: Op[] }

const n = (e: XNode, k: string, def = 0) => { const a = e.attrs.find(([x]) => x === k)?.[1]; const v = Number(a); return a !== undefined && Number.isFinite(v) ? v : def; };
const s = (e: XNode, k: string) => e.attrs.find(([x]) => x === k)?.[1];
const f2 = (v: number) => Math.round(v * 100) / 100;
/** A path element's steps as an SVG path on the page. */
function pathOf(e: XNode, t: Fit): string {
  const X = (v: number) => f2(t.ox + v * t.sx), Y = (v: number) => f2(t.oy + v * t.sy);
  let d = '';
  for (const c of xkids(e)) {
    if (c.name === 'move') d += `M${X(n(c, 'x'))},${Y(n(c, 'y'))} `;
    else if (c.name === 'line') d += `L${X(n(c, 'x'))},${Y(n(c, 'y'))} `;
    else if (c.name === 'quad') d += `Q${X(n(c, 'x1'))},${Y(n(c, 'y1'))} ${X(n(c, 'x2'))},${Y(n(c, 'y2'))} `;
    else if (c.name === 'curve') d += `C${X(n(c, 'x1'))},${Y(n(c, 'y1'))} ${X(n(c, 'x2'))},${Y(n(c, 'y2'))} ${X(n(c, 'x3'))},${Y(n(c, 'y3'))} `;
    else if (c.name === 'arc') d += `A${f2(n(c, 'rx') * t.sx)},${f2(n(c, 'ry') * t.sy)} ${n(c, 'x-axis-rotation')} ${n(c, 'large-arc-flag')} ${n(c, 'sweep-flag')} ${X(n(c, 'x'))},${Y(n(c, 'y'))} `;
    else if (c.name === 'close') d += 'Z ';
  }
  return d.trim();
}
function ops(e: XNode | undefined): Op[] {
  const out: Op[] = [];
  for (const c of xkids(e)) {
    switch (c.name) {
      case 'path': out.push({ k: 'path', d: (t) => pathOf(c, t) }); break;
      case 'rect': out.push({ k: 'path', d: (t) => { const x = t.ox + n(c, 'x') * t.sx, y = t.oy + n(c, 'y') * t.sy, w = n(c, 'w') * t.sx, h = n(c, 'h') * t.sy; return `M${f2(x)},${f2(y)} h${f2(w)} v${f2(h)} h${f2(-w)} Z`; } }); break;
      case 'roundrect': out.push({ k: 'path', d: (t) => { const x = t.ox + n(c, 'x') * t.sx, y = t.oy + n(c, 'y') * t.sy, w = n(c, 'w') * t.sx, h = n(c, 'h') * t.sy, r = Math.min(w, h) * (n(c, 'arcsize', 15) / 100) / 2; return `M${f2(x + r)},${f2(y)} H${f2(x + w - r)} Q${f2(x + w)},${f2(y)} ${f2(x + w)},${f2(y + r)} V${f2(y + h - r)} Q${f2(x + w)},${f2(y + h)} ${f2(x + w - r)},${f2(y + h)} H${f2(x + r)} Q${f2(x)},${f2(y + h)} ${f2(x)},${f2(y + h - r)} V${f2(y + r)} Q${f2(x)},${f2(y)} ${f2(x + r)},${f2(y)} Z`; } }); break;
      case 'ellipse': out.push({ k: 'path', d: (t) => { const x = t.ox + n(c, 'x') * t.sx, y = t.oy + n(c, 'y') * t.sy, w = n(c, 'w') * t.sx, h = n(c, 'h') * t.sy; return `M${f2(x)},${f2(y + h / 2)} A${f2(w / 2)},${f2(h / 2)} 0 1 1 ${f2(x + w)},${f2(y + h / 2)} A${f2(w / 2)},${f2(h / 2)} 0 1 1 ${f2(x)},${f2(y + h / 2)} Z`; } }); break;
      case 'fillstroke': out.push({ k: 'paint', fill: true, stroke: true }); break;
      case 'stroke': out.push({ k: 'paint', fill: false, stroke: true }); break;
      case 'fill': out.push({ k: 'paint', fill: true, stroke: false }); break;
      case 'strokecolor': case 'fillcolor': case 'fontcolor': out.push({ k: c.name, c: s(c, 'color') ?? 'none' }); break;
      case 'strokewidth': out.push({ k: 'strokewidth', w: n(c, 'width', 1), fixed: s(c, 'fixed') === '1' }); break;
      case 'dashed': out.push({ k: 'dashed', on: s(c, 'dashed') === '1' }); break;
      case 'fontsize': out.push({ k: 'fontsize', n: n(c, 'size', 12) }); break;
      case 'text': out.push({ k: 'text', s: s(c, 'str') ?? '', x: n(c, 'x'), y: n(c, 'y'), align: s(c, 'align') ?? 'center', valign: s(c, 'valign') ?? 'middle' }); break;
      case 'save': case 'restore': out.push({ k: c.name }); break;
    }
  }
  return out;
}
/** Where a stencil goes in a box: stretched, or (aspect fixed) as large as fits, centred. */
export function fitStencil(st: Stencil, x: number, y: number, w: number, h: number): Fit {
  let sx = w / st.w, sy = h / st.h, ox = x, oy = y;
  if (st.aspect === 'fixed') { const k = Math.min(sx, sy); ox += (w - st.w * k) / 2; oy += (h - st.h * k) / 2; sx = sy = k; }
  return { sx, sy, ox, oy };
}
const cache = new Map<string, Stencil | null>();
/** A stencil(…) shape read (kept once read). */
export function readStencil(shape: string): Stencil | null {
  if (cache.has(shape)) return cache.get(shape)!;
  let st: Stencil | null = null;
  const xml = stencilXml(shape);
  if (xml) {
    try {
      let root = parseTree(xml).root;
      if (root.name === 'shapes') root = xkids(root).find((k) => k.name === 'shape') ?? root;
      if (root.name === 'shape') {
        const sw = s(root, 'strokewidth');
        st = {
          w: n(root, 'w', 100) || 100, h: n(root, 'h', 100) || 100, aspect: s(root, 'aspect') === 'fixed' ? 'fixed' : 'variable', strokewidth: sw === 'inherit' || sw === undefined ? 'inherit' : Number(sw) || 1,
          points: xkids(xkids(root).find((k) => k.name === 'connections')).filter((k) => k.name === 'constraint').map((k) => ({ x: n(k, 'x'), y: n(k, 'y'), ...(s(k, 'perimeter') === '1' ? { perimeter: true as const } : {}) })),
          background: ops(xkids(root).find((k) => k.name === 'background')), foreground: ops(xkids(root).find((k) => k.name === 'foreground')),
        };
      }
    } catch { st = null; }
  }
  if (cache.size > 500) cache.clear();
  cache.set(shape, st);
  return st;
}
