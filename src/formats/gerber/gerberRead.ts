/**
 * Reading Gerber (RS-274X, with X2 attributes) and Excellon drill files for the CAM editor:
 * the format and units (FS, MO; M48's METRIC / INCH with LZ / TZ and AD's ;FILE_FORMAT), the
 * apertures (C, R, O, P and aperture macros: circles, vector and centre lines, outlines,
 * polygons, thermals, moirés, with their variables and arithmetic), draws (linear, circular in
 * single- or multi-quadrant mode), flashes, regions (G36/G37), dark and clear polarity (LPD /
 * LPC), step and repeat (SR), the aperture transforms (LM, LR, LS) and image polarity (IPNEG);
 * drills by tool, G85 slots and routed paths (M15 / M16). Everything comes out in board units
 * (1/10000 mil) as objects with their aperture, ready to draw, measure and write again.
 */
import type { Vec2 } from '../../core/geom';

export const UNITS_PER_INCH = 10_000_000;
export const UNITS_PER_MM = UNITS_PER_INCH / 25.4;

/** An aperture as its shape: a circle, a rectangle, an obround, a regular polygon, or a macro's primitives. */
export interface Aperture {
  code: number;
  shape: 'C' | 'R' | 'O' | 'P' | 'M';
  /** Board units: diameter / width and height / outer diameter, vertices and rotation; the hole. */
  w: number; h: number; vertices?: number; rotation?: number; hole?: number;
  /** A macro aperture: its name, its parameters, and the shapes it makes (dark or clear), centred on the flash. */
  macro?: string; params?: number[]; shapes?: { dark: boolean; poly: Vec2[] }[];
  /** As the file defines it (for writing it again). */
  def: string;
}

/**
 * What the CAM editor adds to an object: the group it belongs to (placed text, a polyline, a dimension …),
 * the step-and-repeat block it is in — the block's first copy, or one of its repeats — and, on a composite
 * layer, the sub-layer it is on.
 */
export interface CamTags { grp?: number; sr?: number; srCopy?: boolean; sub?: number }

export type GerberObject = (
  | { kind: 'draw'; a: Vec2; b: Vec2; ap: number; dark: boolean }
  | { kind: 'arc'; a: Vec2; b: Vec2; c: Vec2; cw: boolean; ap: number; dark: boolean }
  | { kind: 'flash'; at: Vec2; ap: number; dark: boolean; rot?: number; mirror?: 'X' | 'Y' | 'XY'; scale?: number }
  | { kind: 'region'; contours: Vec2[][]; dark: boolean }
) & CamTags;

/** A step-and-repeat block (%SR%): nx × ny copies, dx and dy apart. */
export interface StepRepeat { id: number; nx: number; ny: number; dx: number; dy: number }

export interface GerberLayer {
  kind: 'gerber';
  units: 'in' | 'mm';
  /** X2 file attributes (.FileFunction, .FilePolarity, .GenerationSoftware …). */
  attributes: Record<string, string>;
  apertures: Map<number, Aperture>;
  /** Aperture macros as the file defines them (name → its primitives' text). */
  macros: Map<string, string[]>;
  objects: GerberObject[];
  /** %IPNEG*%: the image dark where nothing is drawn. */
  negative: boolean;
  /** Step-and-repeat blocks: their objects (sr = id) are in objects, the repeats marked srCopy. */
  steps?: StepRepeat[];
  warnings: string[];
}

/**
 * A drill hit: a hole, a G85 slot to `slot`, or a G84 canned circle of `circle` diameter routed with the tool;
 * grp ties hits to a group (drilled text, M97 / M98).
 */
export interface DrillHit { tool: number; at: Vec2; slot?: Vec2; circle?: number; grp?: number }

/** A routed path (M15 … M16 in rout mode): the tool's centre line, with arcs where G02 / G03 cut them; a G32 / G33 circle. */
export interface DrillRoute {
  tool: number;
  path: Vec2[];
  /** Arcs between path[i] and path[i + 1]: their centre and direction. */
  arcs?: { i: number; c: Vec2; cw: boolean }[];
  circle?: { c: Vec2; r: number; cw: boolean };
  /** Cutter compensation (G41 left, G42 right). */
  comp?: 'L' | 'R';
}
export interface DrillLayer {
  kind: 'drill';
  units: 'in' | 'mm';
  /** Tool number → diameter (board units), and whether the file says plated. */
  tools: Map<number, number>;
  plated?: boolean;
  hits: DrillHit[];
  /** Routed paths (M15 … M16): a tool's polyline. */
  routes: DrillRoute[];
  /** Drilled text (M97 / M98) as written: the hits it makes carry its group. */
  texts?: { grp: number; text: string; at: Vec2; height: number; vertical?: boolean; tool?: number }[];
  warnings: string[];
}

/* ─── Gerber ───────────────────────────────────────────────────────────────────────── */

interface Fmt { int: number; dec: number; omit: 'L' | 'T' | 'D' }

/** A coordinate as the format writes it (leading or trailing zeros left out, or a decimal point). */
function coord(s: string, f: Fmt): number {
  if (s.includes('.')) return Number(s);
  const neg = s.startsWith('-'), digits = s.replace(/^[+-]/, '');
  const total = f.int + f.dec;
  const padded = f.omit === 'T' ? digits.padEnd(total, '0') : digits.padStart(total, '0');
  const v = Number(padded) / 10 ** f.dec;
  return neg ? -v : v;
}

/** Arithmetic of aperture macros: + − x / and parentheses over numbers and $n. */
function macroValue(expr: string, vars: Map<number, number>): number {
  const src = expr.replace(/\s+/g, '').replace(/X/g, 'x');
  let i = 0;
  const num = (): number => {
    if (src[i] === '(') { i++; const v = sum(); i++; return v; }
    if (src[i] === '-') { i++; return -num(); }
    if (src[i] === '+') { i++; return num(); }
    if (src[i] === '$') { i++; const m = /^\d+/.exec(src.slice(i))!; i += m[0].length; return vars.get(Number(m[0])) ?? 0; }
    const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (!m) return 0;
    i += m[0].length;
    return Number(m[0]);
  };
  const prod = (): number => { let v = num(); while (src[i] === 'x' || src[i] === '/') { const op = src[i++]; const r = num(); v = op === 'x' ? v * r : v / r; } return v; };
  const sum = (): number => { let v = prod(); while (src[i] === '+' || src[i] === '-') { const op = src[i++]; const r = prod(); v = op === '+' ? v + r : v - r; } return v; };
  return sum();
}

const rot = (p: Vec2, deg: number): Vec2 => { if (!deg) return p; const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; };
const circlePoly = (c: Vec2, r: number, n = 32): Vec2[] => Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

/** A macro's primitives evaluated with its parameters: shapes in file units, then scaled. */
function evalMacro(body: string[], params: number[], scale: number): { dark: boolean; poly: Vec2[] }[] {
  const vars = new Map<number, number>(params.map((v, i) => [i + 1, v]));
  const out: { dark: boolean; poly: Vec2[] }[] = [];
  for (const raw of body) {
    const st = raw.trim();
    if (!st || st.startsWith('0')) continue; // comment
    const asg = /^\$(\d+)=(.+)$/.exec(st);
    if (asg) { vars.set(Number(asg[1]), macroValue(asg[2]!, vars)); continue; }
    const f = st.split(',').map((x) => macroValue(x, vars));
    const code = f[0];
    const exp = (v: number) => v !== 0;
    const S = (p: Vec2) => ({ x: p.x * scale, y: p.y * scale });
    if (code === 1) { // circle: exposure, diameter, x, y [, rotation]
      const [, e = 1, d = 0, x = 0, y = 0, r = 0] = f;
      out.push({ dark: exp(e), poly: circlePoly(rot({ x, y }, r), d / 2).map(S) });
    } else if (code === 20 || code === 2) { // vector line: exposure, width, x1, y1, x2, y2, rotation
      const [, e = 1, w = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, r = 0] = f;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1e-12, nx = (-(y2 - y1) / len) * (w / 2), ny = ((x2 - x1) / len) * (w / 2);
      out.push({ dark: exp(e), poly: [{ x: x1 + nx, y: y1 + ny }, { x: x2 + nx, y: y2 + ny }, { x: x2 - nx, y: y2 - ny }, { x: x1 - nx, y: y1 - ny }].map((p) => S(rot(p, r))) });
    } else if (code === 21) { // centre line: exposure, width, height, cx, cy, rotation
      const [, e = 1, w = 0, h = 0, x = 0, y = 0, r = 0] = f;
      out.push({ dark: exp(e), poly: [{ x: x - w / 2, y: y - h / 2 }, { x: x + w / 2, y: y - h / 2 }, { x: x + w / 2, y: y + h / 2 }, { x: x - w / 2, y: y + h / 2 }].map((p) => S(rot(p, r))) });
    } else if (code === 22) { // lower-left line (old): exposure, width, height, x, y, rotation
      const [, e = 1, w = 0, h = 0, x = 0, y = 0, r = 0] = f;
      out.push({ dark: exp(e), poly: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map((p) => S(rot(p, r))) });
    } else if (code === 4) { // outline: exposure, n, x0, y0 … xn, yn, rotation
      const e = f[1] ?? 1, n = Math.round(f[2] ?? 0);
      const pts: Vec2[] = [];
      for (let k = 0; k <= n; k++) pts.push({ x: f[3 + 2 * k] ?? 0, y: f[4 + 2 * k] ?? 0 });
      const r = f[5 + 2 * n] ?? 0;
      out.push({ dark: exp(e), poly: pts.slice(0, -1).map((p) => S(rot(p, r))) });
    } else if (code === 5) { // polygon: exposure, vertices, cx, cy, diameter, rotation
      const [, e = 1, n = 3, x = 0, y = 0, d = 0, r = 0] = f;
      const pts = Array.from({ length: Math.max(3, Math.round(n)) }, (_, k) => { const a = (2 * Math.PI * k) / Math.max(3, Math.round(n)); return { x: x + (d / 2) * Math.cos(a), y: y + (d / 2) * Math.sin(a) }; });
      out.push({ dark: exp(e), poly: pts.map((p) => S(rot(p, r))) });
    } else if (code === 7) { // thermal: cx, cy, outer, inner, gap, rotation
      const [, x = 0, y = 0, od = 0, id = 0, gap = 0, r = 0] = f;
      out.push({ dark: true, poly: circlePoly({ x, y }, od / 2).map((p) => S(rot(p, r))) });
      out.push({ dark: false, poly: circlePoly({ x, y }, id / 2).map((p) => S(rot(p, r))) });
      for (const ang of [0, 90]) {
        const g = [{ x: x - od / 2, y: y - gap / 2 }, { x: x + od / 2, y: y - gap / 2 }, { x: x + od / 2, y: y + gap / 2 }, { x: x - od / 2, y: y + gap / 2 }];
        out.push({ dark: false, poly: g.map((p) => S(rot(rot({ x: p.x - x, y: p.y - y }, ang), r))).map((p) => ({ x: p.x + x * scale, y: p.y + y * scale })) });
      }
    } else if (code === 6) { // moiré: cx, cy, outer, ring thickness, gap, max rings, cross thickness, cross length, rotation
      const [, x = 0, y = 0, od = 0, th = 0, gap = 0, n = 0, ct = 0, cl = 0, r = 0] = f;
      let d = od;
      for (let k = 0; k < n && d > 0; k++, d -= 2 * (th + gap)) {
        out.push({ dark: true, poly: circlePoly({ x, y }, d / 2).map((p) => S(rot(p, r))) });
        if (d - 2 * th > 0) out.push({ dark: false, poly: circlePoly({ x, y }, d / 2 - th).map((p) => S(rot(p, r))) });
      }
      for (const [w, h] of [[cl, ct], [ct, cl]] as const) out.push({ dark: true, poly: [{ x: x - w / 2, y: y - h / 2 }, { x: x + w / 2, y: y - h / 2 }, { x: x + w / 2, y: y + h / 2 }, { x: x - w / 2, y: y + h / 2 }].map((p) => S(rot(p, r))) });
    }
  }
  return out;
}

/** Read a Gerber file (RS-274X; X2 attributes kept). */
/** What a file that doesn't say is taken to be in (CAM editor › File › Setup › Import/Export): units, digits, the zeros left out. */
export interface ReadDefaults { units?: 'in' | 'mm'; int?: number; dec?: number; omit?: 'L' | 'T' }

export function readGerber(text: string, def: ReadDefaults = {}): GerberLayer {
  const L: GerberLayer = { kind: 'gerber', units: def.units ?? 'in', attributes: {}, apertures: new Map(), macros: new Map(), objects: [], negative: false, warnings: [] };
  let fmt: Fmt = { int: def.int ?? 2, dec: def.dec ?? 4, omit: def.omit ?? 'L' };
  let scale = L.units === 'mm' ? UNITS_PER_MM : UNITS_PER_INCH;
  const macros = L.macros;
  let x = 0, y = 0, ap = -1, mode: 'G01' | 'G02' | 'G03' = 'G01', multi = true, dark = true, inRegion = false, incremental = false;
  let lm: 'N' | 'X' | 'Y' | 'XY' = 'N', lr = 0, ls = 1;
  let contour: Vec2[] = [];
  let contours: Vec2[][] = [];
  // Step and repeat: the block's objects, repeated when it closes
  let sr: { nx: number; ny: number; dx: number; dy: number; from: number } | null = null;
  const closeSR = () => {
    if (!sr) return;
    const block = L.objects.slice(sr.from);
    // A block repeated more than once is kept as a block (Tables › Steps); the first copy is its objects, the rest repeats
    const id = sr.nx * sr.ny > 1 && block.length ? (L.steps ??= []).push({ id: (L.steps?.length ?? 0) + 1, nx: sr.nx, ny: sr.ny, dx: sr.dx, dy: sr.dy }) : 0;
    if (id) for (let k = sr.from; k < L.objects.length; k++) L.objects[k] = { ...L.objects[k]!, sr: id };
    for (let i = 0; i < sr.nx; i++) for (let j = 0; j < sr.ny; j++) {
      if (!i && !j) continue;
      const d = { x: i * sr.dx, y: j * sr.dy };
      const mv = (p: Vec2) => ({ x: p.x + d.x, y: p.y + d.y });
      const tag = id ? { sr: id, srCopy: true } : {};
      for (const o of block) {
        if (o.kind === 'draw') L.objects.push({ ...o, a: mv(o.a), b: mv(o.b), ...tag });
        else if (o.kind === 'arc') L.objects.push({ ...o, a: mv(o.a), b: mv(o.b), c: mv(o.c), ...tag });
        else if (o.kind === 'flash') L.objects.push({ ...o, at: mv(o.at), ...tag });
        else L.objects.push({ ...o, contours: o.contours.map((cc) => cc.map(mv)), ...tag });
      }
    }
    sr = null;
  };
  const arcTo = (from: Vec2, to: Vec2, i: number, j: number, cw: boolean): Vec2 => {
    if (multi) return { x: from.x + i, y: from.y + j };
    // Single quadrant: the signs are left to us — the centre at the right radius, under 90°
    let best = { x: from.x + i, y: from.y + j }, err = Infinity;
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      const c = { x: from.x + sx * Math.abs(i), y: from.y + sy * Math.abs(j) };
      const r1 = Math.hypot(from.x - c.x, from.y - c.y), r2 = Math.hypot(to.x - c.x, to.y - c.y);
      let sweep = Math.atan2(to.y - c.y, to.x - c.x) - Math.atan2(from.y - c.y, from.x - c.x);
      if (cw) sweep = -sweep;
      while (sweep < 0) sweep += 2 * Math.PI;
      const e = Math.abs(r1 - r2) + (sweep > Math.PI / 2 + 1e-6 ? 1e12 : 0);
      if (e < err) { err = e; best = c; }
    }
    return best;
  };
  const arcPts = (a: Vec2, b: Vec2, c: Vec2, cw: boolean): Vec2[] => {
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    let s = Math.atan2(a.y - c.y, a.x - c.x), e = Math.atan2(b.y - c.y, b.x - c.x);
    if (cw) { while (e >= s) e -= 2 * Math.PI; } else { while (e <= s) e += 2 * Math.PI; }
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9 * Math.max(1, r)) e = s + (cw ? -2 : 2) * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(e - s) / (Math.PI / 32)));
    return Array.from({ length: n }, (_, k) => { const t = s + ((e - s) * (k + 1)) / n; return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }; });
  };
  const flushContour = () => { if (contour.length > 2) contours.push(contour); contour = []; };

  // Split into extended commands (%…%) and word commands (…*)
  const src = text.replace(/\r/g, '');
  let k = 0;
  const words: { ext: boolean; body: string }[] = [];
  while (k < src.length) {
    if (/\s/.test(src[k]!)) { k++; continue; }
    if (src[k] === '%') {
      const e = src.indexOf('%', k + 1);
      const body = src.slice(k + 1, e < 0 ? src.length : e);
      // An extended block can hold several commands (%FSLAX24Y24*MOIN*%), but a macro's are all one
      if (/^\s*AM/.test(body)) words.push({ ext: true, body: body.trim() });
      else for (const part of body.split('*')) if (part.trim()) words.push({ ext: true, body: part.trim() });
      k = e < 0 ? src.length : e + 1;
    } else {
      const e = src.indexOf('*', k);
      const body = src.slice(k, e < 0 ? src.length : e).replace(/\s+/g, '');
      if (body) words.push({ ext: false, body });
      k = e < 0 ? src.length : e + 1;
    }
  }
  const apScale = () => scale;
  for (const w of words) {
    const b = w.body;
    if (w.ext) {
      const cmd = b.slice(0, 2);
      if (cmd === 'FS') {
        const m = /^FS([LTD])?([AI])?.*X(\d)(\d)Y(\d)(\d)/.exec(b);
        if (m) fmt = { omit: (m[1] as Fmt['omit']) ?? 'L', int: Number(m[3]), dec: Number(m[4]) };
        if (m?.[2] === 'I') incremental = true;
      } else if (cmd === 'MO') { L.units = /MM/.test(b) ? 'mm' : 'in'; scale = L.units === 'mm' ? UNITS_PER_MM : UNITS_PER_INCH; }
      else if (cmd === 'IP') L.negative = /NEG/.test(b);
      else if (cmd === 'LP') dark = !/LPC/.test(b);
      else if (cmd === 'LM') lm = (b.slice(2) || 'N') as typeof lm;
      else if (cmd === 'LR') lr = Number(b.slice(2)) || 0;
      else if (cmd === 'LS') ls = Number(b.slice(2)) || 1;
      else if (cmd === 'TF') { const [key, ...vals] = b.slice(2).split(','); L.attributes[key!] = vals.join(','); }
      else if (cmd === 'AM') {
        const parts = b.split('*').map((s) => s.trim()).filter(Boolean);
        macros.set(parts[0]!.slice(2), parts.slice(1));
      } else if (cmd === 'AD') {
        const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(b);
        if (!m) { L.warnings.push(`aperture definition not read: ${b}`); continue; }
        const code = Number(m[1]), t = m[2]!, args = (m[3] ?? '').split('X').filter((s) => s !== '').map(Number);
        const s = apScale();
        if (t === 'C') L.apertures.set(code, { code, shape: 'C', w: (args[0] ?? 0) * s, h: (args[0] ?? 0) * s, ...(args[1] ? { hole: args[1] * s } : {}), def: b });
        else if (t === 'R' || t === 'O') L.apertures.set(code, { code, shape: t, w: (args[0] ?? 0) * s, h: (args[1] ?? args[0] ?? 0) * s, ...(args[2] ? { hole: args[2] * s } : {}), def: b });
        else if (t === 'P') L.apertures.set(code, { code, shape: 'P', w: (args[0] ?? 0) * s, h: (args[0] ?? 0) * s, vertices: Math.round(args[1] ?? 3), rotation: args[2] ?? 0, ...(args[3] ? { hole: args[3] * s } : {}), def: b });
        else {
          const body = macros.get(t);
          if (!body) { L.warnings.push(`aperture D${code}: macro ${t} not defined`); continue; }
          const params = (m[3] ?? '').split('X').filter((x2) => x2 !== '').map(Number);
          const shapes = evalMacro(body, params, s);
          const xs = shapes.flatMap((sh) => sh.poly.map((p) => Math.abs(p.x))), ys = shapes.flatMap((sh) => sh.poly.map((p) => Math.abs(p.y)));
          L.apertures.set(code, { code, shape: 'M', w: 2 * Math.max(0, ...xs), h: 2 * Math.max(0, ...ys), macro: t, params, shapes, def: b });
        }
      } else if (cmd === 'SR') {
        closeSR();
        const m = /X(\d+)Y(\d+)I([-\d.]+)J([-\d.]+)/.exec(b);
        if (m) sr = { nx: Number(m[1]), ny: Number(m[2]), dx: Number(m[3]) * scale, dy: Number(m[4]) * scale, from: L.objects.length };
      } else if (cmd === 'AB') L.warnings.push('block apertures (AB) are not drawn yet');
      continue;
    }
    // Word commands: G codes, D codes, coordinates
    if (/^G0?4/.test(b)) continue; // comment
    if (b === 'M02' || b === 'M00' || b === 'M2') break;
    const g = /G0?(\d+)/.exec(b);
    if (g) {
      const n = Number(g[1]);
      if (n === 1 || n === 2 || n === 3) mode = (`G0${n}`) as typeof mode;
      else if (n === 74) multi = false;
      else if (n === 75) multi = true;
      else if (n === 36) { inRegion = true; contours = []; contour = []; }
      else if (n === 37) { flushContour(); if (contours.length) L.objects.push({ kind: 'region', contours, dark }); inRegion = false; contours = []; }
      else if (n === 70) { L.units = 'in'; scale = UNITS_PER_INCH; }
      else if (n === 71) { L.units = 'mm'; scale = UNITS_PER_MM; }
      else if (n === 90) incremental = false;
      else if (n === 91) incremental = true;
    }
    const dm = /D0*(\d+)$/.exec(b);
    const d = dm ? Number(dm[1]) : null;
    if (d !== null && d >= 10 && !/[XY]/.test(b)) { ap = d; continue; }
    const xm = /X([-+]?[\d.]+)/.exec(b), ym = /Y([-+]?[\d.]+)/.exec(b), im = /I([-+]?[\d.]+)/.exec(b), jm = /J([-+]?[\d.]+)/.exec(b);
    if (!xm && !ym && d === null) continue;
    const nx = xm ? coord(xm[1]!, fmt) * scale : 0, ny = ym ? coord(ym[1]!, fmt) * scale : 0;
    const to = { x: xm ? (incremental ? x + nx : nx) : x, y: ym ? (incremental ? y + ny : ny) : y };
    const op = d ?? 1;
    const from = { x, y };
    if (op === 1) {
      if (mode === 'G01') {
        if (inRegion) { if (!contour.length) contour.push(from); contour.push(to); }
        else L.objects.push({ kind: 'draw', a: from, b: to, ap, dark });
      } else {
        const ii = im ? coord(im[1]!, fmt) * scale : 0, jj = jm ? coord(jm[1]!, fmt) * scale : 0;
        const c = arcTo(from, to, ii, jj, mode === 'G02');
        if (inRegion) { if (!contour.length) contour.push(from); contour.push(...arcPts(from, to, c, mode === 'G02')); }
        else L.objects.push({ kind: 'arc', a: from, b: to, c, cw: mode === 'G02', ap, dark });
      }
    } else if (op === 2) { if (inRegion) flushContour(); }
    else if (op === 3) L.objects.push({ kind: 'flash', at: to, ap, dark, ...(lr ? { rot: lr } : {}), ...(lm !== 'N' ? { mirror: lm } : {}), ...(ls !== 1 ? { scale: ls } : {}) });
    x = to.x; y = to.y;
  }
  closeSR();
  return L;
}

/* ─── Excellon ─────────────────────────────────────────────────────────────────────── */

/** Read an Excellon drill file (AD's, KiCad's, and the common variants). */
export function readDrill(text: string, def: ReadDefaults = {}): DrillLayer {
  const D: DrillLayer = { kind: 'drill', units: def.units ?? 'in', tools: new Map(), hits: [], routes: [], warnings: [] };
  let fmt: Fmt = { int: def.int ?? (def.units === 'mm' ? 3 : 2), dec: def.dec ?? (def.units === 'mm' ? 3 : 4), omit: def.omit ?? 'L' };
  let fmtGiven = false;
  let scale = D.units === 'mm' ? UNITS_PER_MM : UNITS_PER_INCH;
  let tool = 0, x = 0, y = 0, header = false, routing = false, down = false, comp: 'L' | 'R' | undefined;
  let path: Vec2[] = [];
  let arcs: { i: number; c: Vec2; cw: boolean }[] = [];
  const endPath = () => { if (down && path.length > 1) D.routes.push({ tool, path, ...(arcs.length ? { arcs } : {}), ...(comp ? { comp } : {}) }); down = false; path = []; arcs = []; };
  /** The centre of an arc from `a` to `b`: by I / J (from a), or by its radius A (the shorter way round, as Excellon does). */
  const centreOf = (a: Vec2, b: Vec2, l: string, cw: boolean): Vec2 => {
    const im = /I([-+]?[\d.]+)/.exec(l), jm = /J([-+]?[\d.]+)/.exec(l), am = /A([-+]?[\d.]+)/.exec(l);
    if (im || jm) return { x: a.x + (im ? coord(im[1]!, fmt) * scale : 0), y: a.y + (jm ? coord(jm[1]!, fmt) * scale : 0) };
    const r = am ? coord(am[1]!, fmt) * scale : 0;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
    const s = cw ? -1 : 1;
    return { x: mx - (s * h * dy) / d, y: my + (s * h * dx) / d };
  };
  let textGrp = 0;
  const lines = text.replace(/\r/g, '').split('\n');
  const setUnits = (mm: boolean) => { D.units = mm ? 'mm' : 'in'; scale = mm ? UNITS_PER_MM : UNITS_PER_INCH; if (!fmtGiven) fmt = mm ? { int: 3, dec: 3, omit: fmt.omit } : { int: 2, dec: 4, omit: fmt.omit }; };
  const xy = (s: string): Vec2 => {
    const xm = /X([-+]?[\d.]+)/.exec(s), ym = /Y([-+]?[\d.]+)/.exec(s);
    return { x: xm ? coord(xm[1]!, fmt) * scale : x, y: ym ? coord(ym[1]!, fmt) * scale : y };
  };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith(';')) {
      const ff = /FILE_FORMAT\s*=\s*(\d+)\s*:\s*(\d+)/i.exec(l);
      if (ff) { fmt = { ...fmt, int: Number(ff[1]), dec: Number(ff[2]) }; fmtGiven = true; }
      if (/TYPE\s*=\s*NON_PLATED/i.test(l)) D.plated = false; else if (/TYPE\s*=\s*PLATED/i.test(l)) D.plated = true;
      continue;
    }
    if (l === 'M48') { header = true; continue; }
    if (l === '%' || l === 'M95') { header = false; continue; }
    if (/^(METRIC|INCH)/.test(l)) {
      setUnits(l.startsWith('METRIC'));
      if (/,LZ/.test(l)) fmt = { ...fmt, omit: 'T' }; // leading zeros kept: trailing ones left out
      else if (/,TZ/.test(l)) fmt = { ...fmt, omit: 'L' };
      const f = /,0*(\d+)\.(\d+)/.exec(l);
      if (f) { fmt = { ...fmt, int: f[1]!.length, dec: f[2]!.length }; fmtGiven = true; }
      continue;
    }
    if (l === 'M71') { setUnits(true); continue; }
    if (l === 'M72') { setUnits(false); continue; }
    const td = /^T(\d+)(?:F[\d.]+|S[\d.]+)*C([\d.]+)/.exec(l);
    if (td) { D.tools.set(Number(td[1]), Number(td[2]) * scale); if (!header) tool = Number(td[1]); continue; }
    const ts = /^T(\d+)$/.exec(l);
    if (ts) { tool = Number(ts[1]); continue; }
    if (header) continue;
    if (/^M30|^M00/.test(l)) break;
    if (/^G00/.test(l)) { endPath(); routing = true; const p = xy(l); x = p.x; y = p.y; continue; }
    if (/^M15/.test(l)) { down = true; path = [{ x, y }]; arcs = []; continue; }
    if (/^M16|^M17/.test(l)) { endPath(); continue; }
    if (/^G40/.test(l)) { comp = undefined; continue; }
    if (/^G41/.test(l)) { comp = 'L'; continue; }
    if (/^G42/.test(l)) { comp = 'R'; continue; }
    // G32 / G33: a routed circle about X Y of radius A (clockwise / counter-clockwise)
    const circ = /^(?:(.*?))?G3([23])(.*)$/.exec(l);
    if (circ && /A/.test(circ[3]!)) {
      const c = xy(circ[1] || circ[3]!); x = c.x; y = c.y;
      const am = /A([-+]?[\d.]+)/.exec(circ[3]!);
      const r = am ? coord(am[1]!, fmt) * scale : 0;
      if (r > 0) D.routes.push({ tool, path: [{ x: c.x + r, y: c.y }], circle: { c, r, cw: circ[2] === '2' } });
      continue;
    }
    if (/^G0[123]/.test(l) && routing) {
      const p = xy(l);
      if (down) {
        if (/^G0[23]/.test(l)) arcs.push({ i: path.length - 1, c: centreOf({ x, y }, p, l, /^G02/.test(l)), cw: /^G02/.test(l) });
        path.push(p);
      }
      x = p.x; y = p.y; continue;
    }
    if (/^G05|^G90|^G81/.test(l)) { endPath(); routing = false; continue; }
    // M97 / M98: canned text at the position on the line (or the last one), drilled with the current tool
    const mt = /^(.*?)M9([78]),(.*)$/.exec(l);
    if (mt) {
      const p = xy(mt[1]!); x = p.x; y = p.y;
      textGrp++;
      const grp = -textGrp;
      const height = 0.1 * UNITS_PER_INCH; // [est: Excellon's canned text has no size of its own]
      (D.texts ??= []).push({ grp, text: mt[3]!, at: p, height, tool, ...(mt[2] === '8' ? { vertical: true } : {}) });
      continue;
    }
    // G84: a canned circle (X Y G84 X diameter)
    const g84 = /^(.*?)G84(.*)$/.exec(l);
    if (g84) {
      const a = xy(g84[1]!); x = a.x; y = a.y;
      const dm = /X([-+]?[\d.]+)/.exec(g84[2]!);
      D.hits.push({ tool, at: a, circle: dm ? coord(dm[1]!, fmt) * scale : 0 });
      continue;
    }
    if (/G85/.test(l)) {
      const [first, second] = l.split('G85');
      const a = xy(first!); x = a.x; y = a.y;
      const b = xy(second!); x = b.x; y = b.y;
      D.hits.push({ tool, at: a, slot: b });
      continue;
    }
    if (/^[XY]/.test(l)) {
      const p = xy(l); x = p.x; y = p.y;
      if (routing && down) path.push(p); else D.hits.push({ tool, at: p });
    }
  }
  endPath();
  return D;
}

/** Which a file is: Gerber, Excellon, or neither (by what it says, not its name). */
export function sniffCamFile(text: string): 'gerber' | 'drill' | null {
  const head = text.slice(0, 4000);
  if (/%FS[LTD]?[AI]?.*X\d\dY\d\d\*%|%MO(IN|MM)\*%|%ADD\d+/.test(head) || /^G04/m.test(head) && /\*\s*$/m.test(head)) return 'gerber';
  if (/^M48\s*$/m.test(head) || /^(METRIC|INCH)(,|\s*$)/m.test(head) || /^T\d+C[\d.]+/m.test(head)) return 'drill';
  return null;
}
