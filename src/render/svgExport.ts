import type { BBox } from '../core/geom';
import { INSTANCE_FLOATS, Kind, type Scene, type TextItem } from './Scene';

/**
 * A Scene as SVG, for File › Print, Print Preview and Smart PDF (through the browser's print):
 * the same display list the screen draws — segments, arcs, rectangles, filled triangles,
 * Transparent fills (darken), text and pictures — in world units, y up. Hairlines (width 0)
 * print at minStroke.
 */
export interface SvgOptions {
  /** World units for a hairline (Altium prints the smallest width at about 0.1 mm). */
  minStroke: number;
  /** Colours: as drawn, greyscale, or black on white (Page Setup › Color Set). */
  colours?: 'colour' | 'grey' | 'mono';
  /** Leave out these groups (the workspace background, selection overlays). */
  skip?: (key: string) => boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n: number) => (Math.round(n * 100) / 100).toString();
/** World units per SVG unit: coordinates in the 1e8 range upset browsers' SVG, so draw in mils. */
let K = 1;
const S = (n: number) => f(n / K);

function rgbaCss(u: number, mode: SvgOptions['colours']): { c: string; a: number } {
  let r = u & 0xff, g = (u >>> 8) & 0xff, b = (u >>> 16) & 0xff;
  const a = ((u >>> 24) & 0xff) / 255;
  if (mode === 'grey') { const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b); r = g = b = y; }
  if (mode === 'mono') { const light = 0.299 * r + 0.587 * g + 0.114 * b > 200; r = g = b = light ? 255 : 0; }
  return { c: `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`, a };
}
function cssColour(s: string, mode: SvgOptions['colours']): string {
  if (!mode || mode === 'colour') return s;
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  if (!m) return mode === 'mono' ? '#000' : s;
  const v = parseInt(m[1]!, 16);
  const r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  if (mode === 'mono') return 0.299 * r + 0.587 * g + 0.114 * b > 200 ? '#fff' : '#000';
  const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return `rgb(${y},${y},${y})`;
}

/** Text with Altium overlines (a character followed by '\' gets a bar): tspans with text-decoration. */
function textBody(t: TextItem): string {
  if (!t.overline || !t.text.includes('\\')) return esc(t.text.replace(/\\/g, ''));
  let out = '', run = '', over = false;
  const flush = () => { if (run) out += over ? `<tspan text-decoration="overline">${esc(run)}</tspan>` : esc(run); run = ''; };
  const chars = [...t.text];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\') continue;
    const o = chars[i + 1] === '\\';
    if (o !== over) { flush(); over = o; }
    run += chars[i];
  }
  flush();
  return out;
}

function textSvg(t: TextItem, ox: number, oy: number, mode: SvgOptions['colours']): string {
  const x = t.x + ox, y = t.y + oy;
  // A font's name comes from the file: only what a name is made of goes into the style (letters, digits, spaces, . _ -), in quotes
  const name = (t.family ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80);
  const fam = name ? `'${name}', Arial, sans-serif` : 'Arial, sans-serif';
  const style = `font-family:${esc(fam)};font-size:${S(t.size)}px;${t.bold ? 'font-weight:700;' : ''}${t.italic ? 'font-style:italic;' : ''}`;
  const fill = cssColour(t.color, mode);
  if (t.frame) {
    // A text frame: lines from the top, wrapped by an estimate of the glyph width
    const fr = t.frame, m = fr.margin, w = fr.maxX - fr.minX - 2 * m;
    const lines: string[] = [];
    for (const para of t.text.split('\n')) {
      if (!fr.wrap) { lines.push(para); continue; }
      let cur = '';
      for (const word of para.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (cur && next.length * t.size * 0.5 > w) { lines.push(cur); cur = word; } else cur = next;
      }
      lines.push(cur);
    }
    const anchor = ['start', 'middle', 'end'][t.h];
    const tx = t.h === 0 ? fr.minX + m : t.h === 1 ? (fr.minX + fr.maxX) / 2 : fr.maxX - m;
    return lines.map((l, i) => `<text x="${S(tx + ox)}" y="${S(-(fr.maxY + oy - m - t.size * (i + 0.85)))}" text-anchor="${anchor}" style="${style}" fill="${fill}">${esc(l)}</text>`).join('');
  }
  const anchor = ['start', 'middle', 'end'][t.h];
  const base = t.anchor === 'cell' ? ['text-after-edge', 'central', 'text-before-edge'][t.v] : ['alphabetic', 'central', 'hanging'][t.v];
  const rot = t.rot ? ` rotate(${f(-t.rot)})` : '';
  const mir = t.mirrored ? ' scale(-1,1)' : '';
  return `<text transform="translate(${S(x)},${S(-y)})${rot}${mir}" text-anchor="${anchor}" dominant-baseline="${base}" style="${style}" fill="${fill}">${textBody(t)}</text>`;
}

export function sceneToSvg(scene: Scene, box: BBox, opts: SvgOptions): string {
  const ox = scene.origin.x, oy = scene.origin.y;
  const mode = opts.colours ?? 'colour';
  const out: string[] = [];
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  K = Math.max(w, h) > 1e6 ? 10_000 : 1;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${S(box.minX)} ${S(-box.maxY)} ${S(w)} ${S(h)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`);
  for (const g of scene.ordered()) {
    if (!g.visible || opts.skip?.(g.key)) continue;
    out.push(`<g${g.alpha < 1 ? ` opacity="${f(g.alpha)}"` : ''}>`);
    // Triangles batched outside record order (boards): under the rest of the group
    const tp = g.tris.pos, tc = g.tris.col;
    for (let i = 0; i + 2 < tc.length; i += 3) {
      const { c, a } = rgbaCss(tc[i]!, mode);
      out.push(`<polygon points="${S(tp[i * 2]! + ox)},${S(-(tp[i * 2 + 1]! + oy))} ${S(tp[i * 2 + 2]! + ox)},${S(-(tp[i * 2 + 3]! + oy))} ${S(tp[i * 2 + 4]! + ox)},${S(-(tp[i * 2 + 5]! + oy))}" fill="${c}"${a < 1 ? ` fill-opacity="${f(a)}"` : ''}/>`);
    }
    const p = g.prims, F = p.f32, U = p.u32;
    const runs = p.runs.length ? p.runs : [{ start: 0, min: false }];
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri]!, end = runs[ri + 1]?.start ?? p.count;
      if (run.min) out.push('<g style="mix-blend-mode:darken">');
      for (let i = run.start; i < end; i++) {
        const o = i * INSTANCE_FLOATS;
        const kind = F[o + 8]!, x0 = F[o]! + ox, y0 = F[o + 1]! + oy, x1 = F[o + 2]!, y1 = F[o + 3]!, hw = F[o + 4]!;
        const { c, a } = rgbaCss(U[o + 9]!, mode);
        const op = a < 1 ? ` opacity="${f(a)}"` : '';
        if (kind === Kind.Capsule) {
          const X1 = x1 + ox, Y1 = y1 + oy;
          if (x0 === X1 && y0 === Y1) { out.push(`<circle cx="${S(x0)}" cy="${S(-y0)}" r="${S(Math.max(hw, opts.minStroke / 2))}" fill="${c}"${op}/>`); continue; }
          out.push(`<line x1="${S(x0)}" y1="${S(-y0)}" x2="${S(X1)}" y2="${S(-Y1)}" stroke="${c}" stroke-width="${S(Math.max(2 * hw, opts.minStroke))}" stroke-linecap="round"${op}/>`);
        } else if (kind === Kind.Arc) {
          const r = x1, s = F[o + 5]!, sw = F[o + 6]!;
          const sw2 = Math.min(sw, Math.PI * 2 - 1e-4);
          const ax = x0 + r * Math.cos(s), ay = y0 + r * Math.sin(s), bx = x0 + r * Math.cos(s + sw2), by = y0 + r * Math.sin(s + sw2);
          const sweepFlag = 0; // CCW in world = clockwise after the y flip
          out.push(`<path d="M${S(ax)},${S(-ay)} A${S(r)},${S(r)} 0 ${sw2 > Math.PI ? 1 : 0},${sweepFlag} ${S(bx)},${S(-by)}${sw >= Math.PI * 2 - 1e-3 ? 'Z' : ''}" fill="none" stroke="${c}" stroke-width="${S(Math.max(2 * hw, opts.minStroke))}" stroke-linecap="round"${op}/>`);
        } else if (kind === Kind.Rect) {
          const rot = F[o + 5]!, cr = F[o + 7]!;
          const tr = rot ? ` transform="rotate(${f((-rot * 180) / Math.PI)} ${S(x0)} ${S(-y0)})"` : '';
          out.push(`<rect x="${S(x0 - x1)}" y="${S(-y0 - y1)}" width="${S(2 * x1)}" height="${S(2 * y1)}"${cr ? ` rx="${S(cr)}"` : ''} fill="${c}"${tr}${op}/>`);
        } else if (kind === Kind.Tri) {
          out.push(`<polygon points="${S(x0)},${S(-y0)} ${S(x1 + ox)},${S(-(y1 + oy))} ${S(hw + ox)},${S(-(F[o + 5]! + oy))}" fill="${c}"${op}/>`);
        }
      }
      if (run.min) out.push('</g>');
    }
    for (const im of g.images) {
      try {
        const cv = document.createElement('canvas');
        const src = im.src as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
        cv.width = (src as { width: number }).width; cv.height = (src as { height: number }).height;
        cv.getContext('2d')!.drawImage(src, 0, 0);
        out.push(`<image href="${cv.toDataURL()}" x="${S(im.minX + ox)}" y="${S(-(im.maxY + oy))}" width="${S(im.maxX - im.minX)}" height="${S(im.maxY - im.minY)}" preserveAspectRatio="none"/>`);
      } catch { /* a picture that can't be read back prints as its frame */ }
    }
    for (const t of g.texts) out.push(textSvg(t, ox, oy, mode));
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('');
}
