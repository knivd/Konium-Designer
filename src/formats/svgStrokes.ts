/**
 * A drawing copied in another application (SVG, the browser's stand-in for a metafile) as lines:
 * each path, line, polyline, polygon, rectangle, circle and ellipse flattened to points, in
 * inches, y up, centred on the drawing's middle. Sizes come from the drawing's width and height
 * with their units and its viewBox; without units a user unit is a CSS pixel (1/96 inch).
 * Transforms are not applied [est: enough for logos and simple drawings].
 */
import type { Vec2 } from '../core/geom';

const UNIT: Record<string, number> = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6, px: 1 / 96, '': 1 / 96 };
const num = (s: string | undefined) => (s === undefined ? NaN : parseFloat(s));
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(tag)?.[2];

/** Inches a user unit is worth. */
function scaleOf(svg: string): number {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = attr(root, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  const w = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(attr(root, 'width') ?? '');
  if (w && vb && vb.length === 4 && vb[2]! > 0) return (Number(w[1]) * (UNIT[w[2]!.toLowerCase()] ?? UNIT.px!)) / vb[2]!;
  return UNIT.px!;
}

/** The SVG path data flattened: one polyline per subpath. */
export function pathPolylines(d: string, steps = 12): Vec2[][] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Vec2[][] = [];
  let cur: Vec2[] = [], p = { x: 0, y: 0 }, start = p, lastCtl: Vec2 | null = null, cmd = '', i = 0;
  const n = () => Number(toks[i++]);
  const flush = () => { if (cur.length > 1) out.push(cur); cur = []; };
  const line = (q: Vec2) => { if (!cur.length) cur.push(p); cur.push(q); p = q; };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const pt = (x: number, y: number): Vec2 => (rel ? { x: p.x + x, y: p.y + y } : { x, y });
    if (C === 'Z') { if (cur.length) { cur.push(start); flush(); } p = start; lastCtl = null; continue; }
    if (C === 'M') { flush(); p = pt(n(), n()); start = p; cur = [p]; cmd = rel ? 'l' : 'L'; lastCtl = null; continue; }
    if (C === 'L') { line(pt(n(), n())); lastCtl = null; continue; }
    if (C === 'H') { const x = n(); line({ x: rel ? p.x + x : x, y: p.y }); lastCtl = null; continue; }
    if (C === 'V') { const y = n(); line({ x: p.x, y: rel ? p.y + y : y }); lastCtl = null; continue; }
    if (C === 'C' || C === 'S') {
      const c1: Vec2 = C === 'S' ? (lastCtl ? { x: 2 * p.x - lastCtl.x, y: 2 * p.y - lastCtl.y } : p) : pt(n(), n());
      const c2 = pt(n(), n()), e = pt(n(), n()), a = p;
      for (let k = 1; k <= steps; k++) { const t = k / steps, u = 1 - t; line({ x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y }); }
      lastCtl = c2;
      continue;
    }
    if (C === 'Q' || C === 'T') {
      const c: Vec2 = C === 'T' ? (lastCtl ? { x: 2 * p.x - lastCtl.x, y: 2 * p.y - lastCtl.y } : p) : pt(n(), n());
      const e = pt(n(), n()), a = p;
      for (let k = 1; k <= steps; k++) { const t = k / steps, u = 1 - t; line({ x: u * u * a.x + 2 * u * t * c.x + t * t * e.x, y: u * u * a.y + 2 * u * t * c.y + t * t * e.y }); }
      lastCtl = c;
      continue;
    }
    if (C === 'A') {
      let rx = Math.abs(n()), ry = Math.abs(n());
      const phi = (n() * Math.PI) / 180, large = n() !== 0, sweep = n() !== 0, e = pt(n(), n()), a = p;
      if (!rx || !ry) { line(e); continue; }
      // Endpoint to centre (SVG 1.1 F.6.5)
      const cs = Math.cos(phi), sn = Math.sin(phi), dx = (a.x - e.x) / 2, dy = (a.y - e.y) / 2;
      const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
      const sq = Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1));
      const co = (large === sweep ? -1 : 1) * Math.sqrt(sq), cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
      const cx = cs * cx1 - sn * cy1 + (a.x + e.x) / 2, cy = sn * cx1 + cs * cy1 + (a.y + e.y) / 2;
      const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
      let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
      if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
      const m = Math.max(4, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * steps / 2));
      for (let k = 1; k <= m; k++) { const t = t1 + (dt * k) / m; const ex = rx * Math.cos(t), ey = ry * Math.sin(t); line(k === m ? e : { x: cs * ex - sn * ey + cx, y: sn * ex + cs * ey + cy }); }
      p = e;
      lastCtl = null;
      continue;
    }
    i++; // an unknown command's number
  }
  flush();
  return out;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, steps = 48): Vec2[] =>
  Array.from({ length: steps + 1 }, (_, k) => ({ x: cx + rx * Math.cos((2 * Math.PI * k) / steps), y: cy + ry * Math.sin((2 * Math.PI * k) / steps) }));

/** Every shape in the drawing as polylines, in inches, y up, centred. Empty when it holds none. */
export function svgStrokes(svg: string): Vec2[][] {
  if (!/<svg[\s>]/i.test(svg)) return [];
  const k = scaleOf(svg);
  const lines: Vec2[][] = [];
  for (const m of svg.matchAll(/<(path|line|polyline|polygon|rect|circle|ellipse)\b[^>]*>/gi)) {
    const tag = m[0], kind = m[1]!.toLowerCase();
    if (kind === 'path') lines.push(...pathPolylines(attr(tag, 'd') ?? ''));
    else if (kind === 'line') lines.push([{ x: num(attr(tag, 'x1')) || 0, y: num(attr(tag, 'y1')) || 0 }, { x: num(attr(tag, 'x2')) || 0, y: num(attr(tag, 'y2')) || 0 }]);
    else if (kind === 'polyline' || kind === 'polygon') {
      const v = (attr(tag, 'points') ?? '').trim().split(/[\s,]+/).map(Number);
      const pts: Vec2[] = [];
      for (let j = 0; j + 1 < v.length; j += 2) pts.push({ x: v[j]!, y: v[j + 1]! });
      if (kind === 'polygon' && pts.length > 2) pts.push(pts[0]!);
      if (pts.length > 1) lines.push(pts);
    } else if (kind === 'rect') {
      const x = num(attr(tag, 'x')) || 0, y = num(attr(tag, 'y')) || 0, w = num(attr(tag, 'width')), h = num(attr(tag, 'height'));
      if (w > 0 && h > 0) lines.push([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]);
    } else if (kind === 'circle') {
      const r = num(attr(tag, 'r'));
      if (r > 0) lines.push(ellipse(num(attr(tag, 'cx')) || 0, num(attr(tag, 'cy')) || 0, r, r));
    } else {
      const rx = num(attr(tag, 'rx')), ry = num(attr(tag, 'ry'));
      if (rx > 0 && ry > 0) lines.push(ellipse(num(attr(tag, 'cx')) || 0, num(attr(tag, 'cy')) || 0, rx, ry));
    }
  }
  const all = lines.flat().filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
  if (!all.length) return [];
  const mx = (Math.min(...all.map((v) => v.x)) + Math.max(...all.map((v) => v.x))) / 2, my = (Math.min(...all.map((v) => v.y)) + Math.max(...all.map((v) => v.y))) / 2;
  return lines.map((l) => l.filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y)).map((v) => ({ x: (v.x - mx) * k, y: -(v.y - my) * k }))).filter((l) => l.length > 1);
}
