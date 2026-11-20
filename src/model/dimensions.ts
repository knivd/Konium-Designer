/**
 * Dimensions (Dimensions6): Place › Dimension › Linear, Angular, Radial, Leader, Datum, Baseline,
 * Center, Linear Diameter, Radial Diameter and Dimension. Each record is a 2-byte prefix (the
 * dimension kind, u16) then a property record, as in the AD17–AD20 boards read so far:
 * - DIMENSIONKIND 1 linear, 2 angular, 3 radial, 4 leader, 5 datum, 6 baseline, 7 center,
 *   8 dimension (the original kind), 9 linear diameter, 10 radial diameter;
 * - REFERENCES_COUNT and REFERENCEnPOINTX / Y (the points measured; REFERENCEnPRIM / OBJECTID /
 *   OBJECTSTRING / ANCHOR name the object picked, -1 / NoObject when none);
 * - X1, Y1: where the dimension line runs (linear: a point on it; radial: the arrow's point on
 *   the arc; center: the centre); ANGLE: the direction measured; HEIGHT: a center mark's size;
 * - TEXTnX / Y / ANGLE / MIRROR: where AD put each value; LX, LY, HX, HY: the bounding box;
 * - text: TEXTHEIGHT, TEXTLINEWIDTH, TEXTGAP, TEXTPOSITION, TEXTFORMAT ("10", "10 (mil)" …),
 *   TEXTDIMENSIONUNIT (Mils, Millimeters, Inches, Centimeters), TEXTPRECISION, TEXTPREFIX / SUFFIX;
 * - lines: LINEWIDTH, ARROWSIZE, ARROWLINEWIDTH, ARROWLENGTH, ARROWPOSITION (Inside / Outside),
 *   EXTENSIONOFFSET, EXTENSIONLINEWIDTH, EXTENSIONPICKGAP.
 * The value is never stored: it comes from the points, as AD shows it. Linear and radial match the
 * boards read; angular, leader, datum, baseline and center keep the same keys with a layout of
 * Konium's own [est].
 */
import type { BBox, Vec2 } from '../core/geom';
import { PropertyBag } from '../formats/altium/props';
import { BinReader, BinWriter } from '../formats/bin';
import { altiumFloat } from '../formats/altium/pcbTransform';
import { formatAltiumLength, mil, parseLength } from '../core/units';
import { changedBagDefaults, type BagKind } from './bagDefaults';
import { strokeText, strokeTextExtent, strokeTextWidth } from '../formats/gerber/stroke';
import type { Change } from '../core/undo';
import { L, type LayerId } from './layers';
import { layerFromName, layerToName } from '../formats/altium/pcbdoc';
import type { PcbPrim } from './pcb';

export const DIM_KINDS: [number, string][] = [
  [1, 'Linear'], [2, 'Angular'], [3, 'Radial'], [4, 'Leader'], [5, 'Datum'], [6, 'Baseline'], [7, 'Centre'], [8, 'Dimension'], [9, 'Linear Diameter'], [10, 'Radial Diameter'],
];
export const dimKindName = (k: number) => DIM_KINDS.find(([n]) => n === k)?.[1] ?? 'Dimension';

export interface PcbDimension {
  index: number;
  prefix: Uint8Array;
  bag: PropertyBag;
  kind: number;
  layer: LayerId;
  refs: Vec2[];
  at: Vec2;
  angle: number;
  locked: boolean;
}

const len = (b: PropertyBag, k: string, d: string) => parseLength(b.getRaw(k) ?? d) ?? parseLength(d)!;
const L_ = (v: number) => formatAltiumLength(Math.round(v));

export function dimensionFromBag(bag: PropertyBag, index: number, prefix?: Uint8Array): PcbDimension {
  const n = bag.int('REFERENCES_COUNT');
  const refs: Vec2[] = [];
  for (let i = 0; i < n; i++) refs.push({ x: len(bag, `REFERENCE${i}POINTX`, '0mil'), y: len(bag, `REFERENCE${i}POINTY`, '0mil') });
  const kind = bag.int('DIMENSIONKIND', 1);
  return {
    index, bag, kind, refs, prefix: prefix ?? new Uint8Array([kind & 0xff, kind >> 8]),
    layer: layerFromName(bag.get('LAYER') ?? '') ?? layerFromName(bag.get('DIMENSIONLAYER') ?? '') ?? L.MECH1,
    at: { x: len(bag, 'X1', '0mil'), y: len(bag, 'Y1', '0mil') }, angle: bag.float('ANGLE', 0), locked: bag.bool('DIMENSIONLOCKED'),
  };
}

export function readDimensions(data: Uint8Array | undefined): PcbDimension[] {
  if (!data) return [];
  const r = new BinReader(data);
  const out: PcbDimension[] = [];
  while (r.remaining >= 6) {
    const prefix = r.bytes(2).slice();
    const n = r.u32() & 0x00ffffff;
    out.push(dimensionFromBag(PropertyBag.parse(r.bytes(Math.min(n, r.remaining))), out.length, prefix));
  }
  return out;
}

export function joinDimensions(dims: PcbDimension[]): Uint8Array {
  const w = new BinWriter(dims.length * 1400 + 16);
  dims.forEach((d, i) => {
    d.bag.set('VINDEXFORSAVE', String(i));
    const b = d.bag.toBytes();
    w.u8(d.kind & 0xff).u8(d.kind >> 8).u32(b.length).bytes(b);
  });
  return w.finish();
}

/* ── the value ── */

const UNIT: Record<string, [number, string]> = { Mils: [1e4, 'mil'], Millimeters: [1e7 / 25.4, 'mm'], Inches: [1e7, 'in'], Centimeters: [1e7 / 2.54, 'cm'] };
export const DIM_UNITS = Object.keys(UNIT);
/** Format choices as the dialog shows them, with the unit written out [est: the values AD keeps]. */
export const DIM_FORMATS = ['None', '10', '10mil', '10 (mil)'];

/** The text a dimension shows for a measured length (or angle, in degrees). */
export function dimensionText(bag: PropertyBag, value: number, angular = false): string {
  const fmt = (bag.get('TEXTFORMAT') ?? '10').trim();
  if (/^none$/i.test(fmt)) return '';
  const prec = bag.int('TEXTPRECISION', 2);
  const [k, abbr] = UNIT[bag.get('TEXTDIMENSIONUNIT') ?? 'Millimeters'] ?? UNIT.Millimeters!;
  const num = angular ? value.toFixed(prec) : (value / k).toFixed(prec);
  // Angular formats are printf-style: AD17 writes '%d°' (whole degrees, whatever the precision)
  const shown = angular ? (/%d/.test(fmt) ? fmt.replace(/%d/g, String(Math.round(value))) : `${num}°`)
    : /\(/.test(fmt) ? `${num} (${abbr})` : /[a-z]$/i.test(fmt) ? `${num}${abbr}` : num;
  const clean = (s: string) => s.replace(/ÿ/g, '');
  return `${clean(bag.get('TEXTPREFIX') ?? '')}${shown}${clean(bag.get('TEXTSUFFIX') ?? '')}`;
}

/* ── geometry ── */

export interface DimGeometry {
  lines: { a: Vec2; b: Vec2; w: number }[];
  arcs: { c: Vec2; r: number; start: number; end: number; w: number }[];
  texts: { text: string; at: Vec2; height: number; rotation: number; mirrored: boolean; w: number }[];
}

/**
 * How far the object a reference point was picked on reaches from that point along a direction
 * (its edge), so the extension line's pick gap starts there, as AD draws it. Without one (or
 * for points picked on nothing) the gap starts at the point.
 */
export type DimEdge = (d: PcbDimension, ref: number, dir: Vec2) => number;

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const norm = (a: Vec2): Vec2 => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
const rot = (a: Vec2, deg: number): Vec2 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }; };
const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
const dirOf = (deg: number): Vec2 => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
const angleOf = (v: Vec2) => (Math.atan2(v.y, v.x) * 180) / Math.PI;
const wrap = (deg: number) => ((deg % 360) + 360) % 360;
/** Text width as the stroke font advances it. */
export const textWidth = (t: string, h: number) => strokeTextWidth(t, h);
/** How far the glyphs reach (what AD centres and breaks the line around). */
const inkWidth = (t: string, h: number) => strokeTextExtent(t, h);
/** An angle turned so text reads from below or the right. */
const readable = (deg: number) => { const a = wrap(deg); return a > 90 && a <= 270 ? a - 180 : a; };

interface Style { lw: number; aw: number; ew: number; arrow: number; tail: number; outside: boolean; ext: number; gap: number; th: number; tw: number; tgap: number }
function style(b: PropertyBag): Style {
  return {
    lw: len(b, 'LINEWIDTH', '10mil'), aw: len(b, 'ARROWLINEWIDTH', '10mil'), ew: len(b, 'EXTENSIONLINEWIDTH', '10mil'),
    arrow: len(b, 'ARROWSIZE', '60mil'), tail: len(b, 'ARROWLENGTH', '100mil'), outside: /outside/i.test(b.get('ARROWPOSITION') ?? 'Inside'),
    ext: len(b, 'EXTENSIONOFFSET', '10mil'), gap: len(b, 'EXTENSIONPICKGAP', '10mil'), th: len(b, 'TEXTHEIGHT', '60mil'),
    tw: len(b, 'TEXTLINEWIDTH', '6mil'), tgap: len(b, 'TEXTGAP', '10mil'),
  };
}

/** An open arrowhead at `tip`, its wings ARROWSIZE back along `back` and a third of it either side (AD's print). */
function arrowhead(g: DimGeometry, tip: Vec2, back: Vec2, s: Style): void {
  const u = norm(back), n = perp(u);
  for (const k of [1, -1]) g.lines.push({ a: tip, b: add(add(tip, mul(u, s.arrow)), mul(n, (k * s.arrow) / 3)), w: s.aw });
}

/** Stored text positions (TEXT1X …), when the record has them. */
function storedTexts(b: PropertyBag): { at: Vec2; angle: number; mirrored: boolean }[] {
  const out: { at: Vec2; angle: number; mirrored: boolean }[] = [];
  for (let i = 1; b.has(`TEXT${i}X`) && b.has(`TEXT${i}Y`); i++) out.push({ at: { x: len(b, `TEXT${i}X`, '0mil'), y: len(b, `TEXT${i}Y`, '0mil') }, angle: b.float(`TEXT${i}ANGLE`, 0), mirrored: b.bool(`TEXT${i}MIRROR`) });
  return out;
}
/** TEXTX / TEXTY: the last click when placing (the datum line, the angular radius and sector). */
const pickOf = (b: PropertyBag): Vec2 | null => (b.has('TEXTX') && b.has('TEXTY') ? { x: len(b, 'TEXTX', '0mil'), y: len(b, 'TEXTY', '0mil') } : null);

type Text = DimGeometry['texts'][number];
/**
 * A value centred on a point of its line, as AD's Auto position puts it: the text box (the
 * advance plus the stroke width each way) centred there, so the ink sits a sixth of the height
 * plus the stroke width back along the text and the stroke width below the line [AD prints].
 */
function autoText(text: string, mid: Vec2, deg: number, s: Style): Text {
  const r = readable(deg), u = dirOf(r), up = perp(u);
  const at = sub(sub(mid, mul(u, inkWidth(text, s.th) / 2 + s.th / 6 + s.tw)), mul(up, s.th / 2 + s.tw));
  return { text, at, height: s.th, rotation: r, mirrored: false, w: s.tw };
}
const storedText = (text: string, st: { at: Vec2; angle: number; mirrored: boolean }, s: Style): Text => ({ text, at: st.at, height: s.th, rotation: st.angle, mirrored: st.mirrored, w: s.tw });
/** Where a text's ink is centred. */
function inkCentre(t: Text): Vec2 {
  const u = dirOf(t.rotation), up = perp(u);
  return add(add(t.at, mul(u, (inkWidth(t.text, t.height) / 2) * (t.mirrored ? -1 : 1))), mul(up, t.height / 2));
}

/** The extension line from a picked point out to (and EXTENSIONOFFSET past) `to`, its pick gap from the object's edge. */
function extension(g: DimGeometry, d: PcbDimension, i: number, p: Vec2, to: Vec2, s: Style, edge?: DimEdge, over = s.ext): void {
  const v = sub(to, p), l = Math.hypot(v.x, v.y);
  if (l === 0) return;
  const e = mul(v, 1 / l), start = (edge?.(d, i, e) ?? 0) + s.gap;
  if (l + over <= start) return;
  g.lines.push({ a: add(p, mul(e, start)), b: add(to, mul(e, over)), w: s.ew });
}

/** A linear measurement between p0 and p1 along `deg`, its line through `at`. */
function linear(g: DimGeometry, d: PcbDimension, i0: number, i1: number, at: Vec2, deg: number, s: Style, edge?: DimEdge): { value: number; mid: Vec2; line: number } {
  const p0 = d.refs[i0]!, p1 = d.refs[i1]!, u = dirOf(deg);
  const q0 = add(at, mul(u, dot(sub(p0, at), u))), q1 = add(at, mul(u, dot(sub(p1, at), u)));
  extension(g, d, i0, p0, q0, s, edge); extension(g, d, i1, p1, q1, s, edge);
  const v = sub(q1, q0), vl = Math.hypot(v.x, v.y);
  const line = g.lines.length;
  g.lines.push({ a: q0, b: q1, w: s.lw });
  if (vl > 0) {
    const e = norm(v);
    if (s.outside) {
      arrowhead(g, q0, mul(e, -1), s); arrowhead(g, q1, e, s);
      g.lines.push({ a: q0, b: add(q0, mul(e, -s.tail)), w: s.lw }, { a: q1, b: add(q1, mul(e, s.tail)), w: s.lw });
    } else { arrowhead(g, q0, e, s); arrowhead(g, q1, mul(e, -1), s); }
  }
  return { value: Math.abs(dot(sub(p1, p0), u)), mid: mul(add(q0, q1), 0.5), line };
}

/** A line that runs under its text is broken there, the text gap plus the stroke width either side of the ink. */
function breakUnderText(g: DimGeometry, line: number, s: Style): void {
  const l = g.lines[line], t = g.texts.at(-1);
  if (!l || !t) return;
  const v = sub(l.b, l.a), length = Math.hypot(v.x, v.y);
  if (length === 0) return;
  const u = mul(v, 1 / length), n = perp(u);
  const box = textBox(t);
  const across = box.map((p) => dot(sub(p, l.a), n));
  if (Math.min(...across) > l.w / 2 || Math.max(...across) < -l.w / 2) return;
  const along = box.map((p) => dot(sub(p, l.a), u));
  const lo = Math.max(0, Math.min(...along) - s.tgap - s.tw), hi = Math.min(length, Math.max(...along) + s.tgap + s.tw);
  if (hi <= lo) return;
  const parts = [[0, lo], [hi, length]].filter(([a, b]) => b! - a! > 1).map(([a, b]) => ({ a: add(l.a, mul(u, a!)), b: add(l.a, mul(u, b!)), w: l.w }));
  g.lines.splice(line, 1, ...parts);
}

/** The arc from `start` sweeping `sweep` degrees counter-clockwise, broken under the text when the text sits on it. */
function arcUnderText(g: DimGeometry, c: Vec2, r: number, start: number, sweep: number, w: number, t: Text | undefined, s: Style): void {
  const push = (a: number, b: number) => g.arcs.push({ c, r, start: wrap(a), end: wrap(b), w });
  if (t) {
    const m = inkCentre(t), off = Math.hypot(m.x - c.x, m.y - c.y) - r;
    if (Math.abs(off) < t.height) {
      const half = ((inkWidth(t.text, t.height) / 2 + s.tgap + s.tw) / r) * (180 / Math.PI);
      const at = wrap(angleOf(sub(m, c)) - start);
      const lo = at - half, hi = at + half;
      if (lo > 0 && hi < sweep) { push(start, start + lo); push(start + hi, start + sweep); return; }
    }
  }
  push(start, start + sweep);
}

/** The point where two lines (through a along u, through b along v) cross, or null when parallel. */
export function armsCross(a: Vec2, u: Vec2, b: Vec2, v: Vec2): Vec2 | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.x - a.x) * v.y - (b.y - a.y) * v.x) / den;
  return add(a, mul(u, t));
}

/**
 * Angular: the vertex X1 / Y1 (where the arms cross), the arc at RADIUS in the sector holding
 * the last click (TEXTX / TEXTY). Each arm is a pair of points (REFERENCE0–1, REFERENCE2–3),
 * as AD picks two points on each object. An arm picked with one point twice has no direction:
 * AD then shows 180° with the arc where its text lies, which is kept.
 */
function angular(g: DimGeometry, d: PcbDimension, s: Style, stored: { at: Vec2; angle: number; mirrored: boolean }[], edge?: DimEdge, orient = stored): void {
  const b = d.bag, c = d.at, refs = d.refs, pick = pickOf(b);
  const four = refs.length >= 4;
  const arm = (k: 0 | 1): Vec2 => (four ? sub(refs[2 * k + 1]!, refs[2 * k]!) : sub(refs[k] ?? c, c));
  const u1 = arm(0), u2 = arm(1);
  const r = len(b, 'RADIUS', '0mil') || (pick ? Math.hypot(pick.x - c.x, pick.y - c.y) : 0) || len(b, 'HEIGHT', '0mil') || mil(100);
  const text0 = orient[0] ? storedText('', orient[0], s) : null;
  // Which way the arc lies: towards the last click, else the stored text
  const toward = pick && Math.hypot(pick.x - c.x, pick.y - c.y) > 1 ? angleOf(sub(pick, c)) : text0 ? angleOf(sub(inkCentre({ ...text0, text: '0' }), c)) : null;
  const towardText = text0 ? angleOf(sub(inkCentre({ ...text0, text: '0' }), c)) : toward;
  let start: number, sweep: number;
  if (Math.hypot(u1.x, u1.y) > 0 && Math.hypot(u2.x, u2.y) > 0 && Math.abs(u1.x * u2.y - u1.y * u2.x) > 1e-9 * Math.hypot(u1.x, u1.y) * Math.hypot(u2.x, u2.y)) {
    const rays = [angleOf(u1), angleOf(u1) + 180, angleOf(u2), angleOf(u2) + 180].map(wrap).sort((x, y) => x - y);
    const sectors = rays.map((a, i) => ({ start: a, sweep: wrap((rays[(i + 1) % 4]! - a)) }));
    const pickS = toward === null ? sectors[0]! : sectors.find((x) => wrap(toward - x.start) <= x.sweep) ?? sectors[0]!;
    start = pickS.start; sweep = pickS.sweep;
  } else {
    // No direction: 180°, centred on the text (its angle is the tangent there)
    let mid = towardText ?? 90;
    if (orient[0]) {
      const cands = [orient[0].angle + 90, orient[0].angle - 90];
      mid = cands.reduce((best, a) => (Math.abs(wrap(a - mid + 180) - 180) < Math.abs(wrap(best - mid + 180) - 180) ? a : best));
    }
    start = mid - 90; sweep = 180;
  }
  const e0 = add(c, mul(dirOf(start), r)), e1 = add(c, mul(dirOf(start + sweep), r));
  // Extension lines from the arms' picked points out to the arc ends (each arm to the end it reaches)
  const pairs = four ? [[0, 1], [2, 3]] : [[0], [1]];
  const nearest = (idx: number[], to: Vec2) => idx.filter((i) => refs[i]).sort((x, y) => Math.hypot(refs[x]!.x - to.x, refs[x]!.y - to.y) - Math.hypot(refs[y]!.x - to.x, refs[y]!.y - to.y))[0];
  const cost = (a: number[], e: Vec2) => { const i = nearest(a, e); return i === undefined ? 0 : Math.hypot(refs[i]!.x - e.x, refs[i]!.y - e.y); };
  const swap = cost(pairs[0]!, e1) + cost(pairs[1]!, e0) < cost(pairs[0]!, e0) + cost(pairs[1]!, e1);
  for (const [k, e] of [[0, swap ? e1 : e0], [1, swap ? e0 : e1]] as [number, Vec2][]) {
    const i = nearest(pairs[k]!, e);
    if (i !== undefined) extension(g, d, i, refs[i]!, e, s, edge);
  }
  // Arrows on the tangents at the arc ends
  const t0 = perp(dirOf(start)), t1 = mul(perp(dirOf(start + sweep)), -1);
  if (s.outside) {
    arrowhead(g, e0, mul(t0, -1), s); arrowhead(g, e1, mul(t1, -1), s);
    g.lines.push({ a: e0, b: add(e0, mul(t0, -s.tail)), w: s.lw }, { a: e1, b: add(e1, mul(t1, -s.tail)), w: s.lw });
  } else { arrowhead(g, e0, t0, s); arrowhead(g, e1, t1, s); }
  const text = dimensionText(b, sweep, true);
  const mid = start + sweep / 2;
  const t = !text ? undefined : stored[0] ? storedText(text, stored[0], s) : autoText(text, add(c, mul(dirOf(mid), r)), mid - 90, s);
  arcUnderText(g, c, r, start, sweep, s.lw, t, s);
  if (t) g.texts.push(t);
}

/**
 * Datum: each point's distance from the first along ANGLE. The lines run square to it from each
 * point (its pick gap off the object's edge) to the line through TEXTX / TEXTY; each value sits
 * past the end of its line, centred on it [AD prints].
 */
function datum(g: DimGeometry, d: PcbDimension, s: Style, stored: { at: Vec2; angle: number; mirrored: boolean }[], edge?: DimEdge): void {
  const p0 = d.refs[0];
  if (!p0) return;
  const u = dirOf(d.angle), n = perp(u), line = pickOf(d.bag) ?? d.at;
  d.refs.forEach((p, i) => {
    const q = add(p, mul(n, dot(sub(line, p), n))), v = sub(q, p);
    const e = Math.hypot(v.x, v.y) > 0 ? norm(v) : mul(n, -1);
    extension(g, d, i, p, q, s, edge, 0);
    const text = dimensionText(d.bag, Math.abs(dot(sub(p, p0), u)));
    if (!text) return;
    if (stored[i]) { g.texts.push(storedText(text, stored[i]!, s)); return; }
    const r = readable(d.angle), tu = dirOf(r), up = perp(tu);
    const x = mul(tu, inkWidth(text, s.th) / 2 + s.tw);
    const at = dot(e, up) < 0 ? sub(sub(q, x), mul(up, s.tgap + 2 * s.tw + s.th)) : add(sub(q, x), mul(up, s.tgap));
    g.texts.push({ text, at, height: s.th, rotation: r, mirrored: false, w: s.tw });
  });
}

/** What a dimension draws: lines, arcs and its value text. `edge` finds the picked objects' edges. */
export function dimensionGeometry(d: PcbDimension, fresh = false, edge?: DimEdge): DimGeometry {
  const b = d.bag, s = style(b), g: DimGeometry = { lines: [], arcs: [], texts: [] };
  const stored = fresh ? [] : storedTexts(b);
  const [p0, p1] = d.refs;
  switch (d.kind) {
    case 2: angular(g, d, s, stored, edge, storedTexts(b)); break;
    case 3: case 10: { // Radial: centre REFERENCE0, arrow on the arc at X1, leader to REFERENCE1, then a shoulder under the text
      if (!p0) break;
      const elbow = p1 ?? d.at;
      const rr = Math.hypot(d.at.x - p0.x, d.at.y - p0.y);
      g.lines.push({ a: d.at, b: elbow, w: s.lw });
      arrowhead(g, d.at, sub(elbow, d.at), s);
      const text = dimensionText(b, d.kind === 10 ? 2 * rr : rr);
      const right = elbow.x >= p0.x ? 1 : -1, w = textWidth(text, s.th) + 2 * s.tgap;
      const end = { x: elbow.x + right * w, y: elbow.y };
      g.lines.push({ a: elbow, b: end, w: s.lw });
      if (stored[0] && text) g.texts.push(storedText(text, stored[0], s));
      else if (text) g.texts.push({ text, at: { x: Math.min(elbow.x, end.x) + s.tgap, y: elbow.y + s.tgap }, height: s.th, rotation: 0, mirrored: false, w: s.tw });
      break;
    }
    case 4: { // Leader: the arrow at REFERENCE0, through the points, the text after the last
      if (!p0) break;
      for (let i = 1; i < d.refs.length; i++) g.lines.push({ a: d.refs[i - 1]!, b: d.refs[i]!, w: s.lw });
      if (p1) arrowhead(g, p0, sub(p1, p0), s);
      const text = (b.get('TEXTFORMAT') ?? '').trim();
      const last = d.refs.at(-1)!;
      if (stored[0] && text) g.texts.push(storedText(text, stored[0], s));
      else if (text) g.texts.push({ text, at: { x: last.x + s.tgap, y: last.y - s.th / 2 }, height: s.th, rotation: 0, mirrored: false, w: s.tw });
      break;
    }
    case 5: datum(g, d, s, stored, edge); break;
    case 6: { // Baseline [est]: from the first point to each of the others, the lines stacked from X1
      if (!p0) break;
      const u = dirOf(d.angle);
      let n = perp(u);
      if (dot(sub(d.at, p0), n) < 0) n = mul(n, -1);
      const step = 2 * s.th + 2 * s.tgap;
      d.refs.slice(1).forEach((_, k) => {
        const r = linear(g, d, 0, k + 1, add(d.at, mul(n, k * step)), d.angle, s, edge);
        const text = dimensionText(b, r.value);
        if (!text) return;
        g.texts.push(stored[k] ? storedText(text, stored[k]!, s) : autoText(text, r.mid, d.angle, s));
        breakUnderText(g, r.line, s);
      });
      break;
    }
    case 7: { // Center: a cross of HEIGHT through X1, turned by ANGLE
      const h = len(b, 'HEIGHT', '100mil') / 2, u = dirOf(d.angle), v = rot(u, 90);
      g.lines.push({ a: sub(d.at, mul(u, h)), b: add(d.at, mul(u, h)), w: s.lw }, { a: sub(d.at, mul(v, h)), b: add(d.at, mul(v, h)), w: s.lw });
      break;
    }
    default: { // Linear (1), Dimension (8), Linear Diameter (9)
      if (!p0 || !p1) break;
      const r = linear(g, d, 0, 1, d.at, d.angle, s, edge);
      const text = dimensionText(b, r.value);
      if (!text) break;
      g.texts.push(stored[0] ? storedText(text, stored[0], s) : autoText(text, r.mid, d.angle, s));
      breakUnderText(g, r.line, s);
    }
  }
  return g;
}

/** The text's box corners: its ink across, the height up (hit tests, the bounding box, line breaks). */
export function textBox(t: DimGeometry['texts'][number]): Vec2[] {
  const w = inkWidth(t.text, t.height) * (t.mirrored ? -1 : 1);
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t.height }, { x: 0, y: t.height }].map((p) => add(t.at, rot(p, t.rotation)));
}

/* ── the objects points were picked on ── */

/** REFERENCEnOBJECTID → the stream REFERENCEnPRIM indexes. */
const REF_STORAGE: Record<number, string> = { 1: 'Arcs6', 2: 'Pads6', 3: 'Vias6', 4: 'Tracks6', 6: 'Fills6' };
const primIndex = new WeakMap<object, Map<string, PcbPrim>>();
function inside(p: PcbPrim, q: Vec2): boolean {
  switch (p.kind) {
    case 'track': { const v = sub(p.b, p.a), l2 = dot(v, v), t = l2 ? Math.max(0, Math.min(1, dot(sub(q, p.a), v) / l2)) : 0; return Math.hypot(q.x - p.a.x - v.x * t, q.y - p.a.y - v.y * t) <= p.width / 2; }
    case 'arc': return Math.abs(Math.hypot(q.x - p.c.x, q.y - p.c.y) - p.r) <= p.width / 2;
    case 'via': return Math.hypot(q.x - p.at.x, q.y - p.at.y) <= Math.max(p.diameter, p.hole) / 2;
    case 'fill': { const c = mul(add(p.a, p.b), 0.5), l = rot(sub(q, c), -p.rotation); return Math.abs(l.x) <= Math.abs(p.b.x - p.a.x) / 2 && Math.abs(l.y) <= Math.abs(p.b.y - p.a.y) / 2; }
    case 'pad': {
      if (Math.hypot(q.x - p.at.x, q.y - p.at.y) <= p.hole / 2) return true;
      const sh = p.top, l = rot(sub(q, p.at), -p.rotation), hw = sh.w / 2, hh = sh.h / 2;
      if (sh.shape !== 'round') return Math.abs(l.x) <= hw && Math.abs(l.y) <= hh;
      const r = Math.min(hw, hh), dx = Math.max(0, Math.abs(l.x) - (hw - r)), dy = Math.max(0, Math.abs(l.y) - (hh - r));
      return Math.hypot(dx, dy) <= r;
    }
    default: return false;
  }
}
/**
 * The edges of the objects a board's dimensions were picked on: from the point along the
 * direction to where the object (a track's width, a pad's shape or hole, a via) ends.
 */
export function dimensionEdges(prims: readonly PcbPrim[]): DimEdge {
  let index = primIndex.get(prims);
  if (!index) {
    index = new Map();
    for (const p of prims) if ('src' in p && p.src) index.set(`${p.src.storage}:${p.src.index}`, p);
    primIndex.set(prims, index);
  }
  const map = index;
  return (d, i, dir) => {
    const storage = REF_STORAGE[d.bag.int(`REFERENCE${i}OBJECTID`, -1)], at = d.refs[i];
    const p = storage ? map.get(`${storage}:${d.bag.int(`REFERENCE${i}PRIM`, -1)}`) : undefined;
    if (!p || !at || !inside(p, at)) return 0;
    let hi = mil(1);
    while (inside(p, add(at, mul(dir, hi))) && hi < 1e9) hi *= 2;
    let lo = 0;
    for (let k = 0; k < 40 && hi - lo > 1; k++) { const m = (lo + hi) / 2; if (inside(p, add(at, mul(dir, m)))) lo = m; else hi = m; }
    return lo;
  };
}

export function geometryBox(g: DimGeometry): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (p: Vec2, r = 0) => { b.minX = Math.min(b.minX, p.x - r); b.minY = Math.min(b.minY, p.y - r); b.maxX = Math.max(b.maxX, p.x + r); b.maxY = Math.max(b.maxY, p.y + r); };
  for (const l of g.lines) { grow(l.a, l.w / 2); grow(l.b, l.w / 2); }
  for (const a of g.arcs) { grow(a.c, a.r + a.w / 2); }
  for (const t of g.texts) for (const p of textBox(t)) grow(p);
  return b;
}

/** Strokes of the geometry as polylines with widths (outputs, Explode). */
export function geometryStrokes(g: DimGeometry): { pts: Vec2[]; w: number }[] {
  const out: { pts: Vec2[]; w: number }[] = g.lines.map((l) => ({ pts: [l.a, l.b], w: l.w }));
  for (const t of g.texts) for (const pl of strokeText(t.text, t.at, t.height, t.rotation, t.mirrored)) out.push({ pts: pl, w: t.w });
  return out;
}

/* ── writing ── */

/**
 * A record laid out again after its points or style changed: the text positions (TEXTn…) and the
 * bounding box (LX … HY) recomputed, as AD keeps them.
 */
export function layoutDimension(d: PcbDimension, edge?: DimEdge): PropertyBag {
  const b = d.bag.clone();
  b.replaceGroup((k) => /^TEXT\d+(X|Y|ANGLE|MIRROR)$/.test(k), []);
  const g = dimensionGeometry(d, true, edge);
  const at = b.keys().indexOf('USETTFONTS');
  const kv: [string, string][] = g.texts.flatMap((t, i) => [[`TEXT${i + 1}X`, L_(t.at.x)], [`TEXT${i + 1}Y`, L_(t.at.y)], [`TEXT${i + 1}ANGLE`, altiumFloat(t.rotation)], [`TEXT${i + 1}MIRROR`, t.mirrored ? 'TRUE' : 'FALSE']] as [string, string][]);
  if (at >= 0) b.replaceGroup((k) => k === 'USETTFONTS', [...kv, ['USETTFONTS', b.get('USETTFONTS') ?? 'FALSE']]);
  else for (const [k, v] of kv) b.set(k, v);
  const box = geometryBox(g);
  if (Number.isFinite(box.minX)) { b.set('LX', L_(box.minX)); b.set('LY', L_(box.minY)); b.set('HX', L_(box.maxX)); b.set('HY', L_(box.maxY)); }
  return b;
}

/** The points written back: REFERENCES_COUNT and each REFERENCEn group, X1 / Y1, ANGLE (where the record has one). */
export function withPoints(bag: PropertyBag, refs: Vec2[], at: Vec2, angle: number): PropertyBag {
  const b = bag.clone();
  const old = b.int('REFERENCES_COUNT');
  const groups: [string, string][] = [['REFERENCES_COUNT', String(refs.length)]];
  refs.forEach((p, i) => {
    const keep = i < old;
    groups.push([`REFERENCE${i}PRIM`, keep ? b.get(`REFERENCE${i}PRIM`) ?? '-1' : '-1'], [`REFERENCE${i}OBJECTID`, keep ? b.get(`REFERENCE${i}OBJECTID`) ?? '-1' : '-1'],
      [`REFERENCE${i}OBJECTSTRING`, keep ? b.get(`REFERENCE${i}OBJECTSTRING`) ?? 'NoObject' : 'NoObject'],
      [`REFERENCE${i}POINTX`, L_(p.x)], [`REFERENCE${i}POINTY`, L_(p.y)], [`REFERENCE${i}ANCHOR`, keep ? b.get(`REFERENCE${i}ANCHOR`) ?? '-1' : '-1']);
  });
  b.replaceGroup((k) => k === 'REFERENCES_COUNT' || /^REFERENCE\d+(PRIM|OBJECTID|OBJECTSTRING|POINTX|POINTY|ANCHOR)$/.test(k), groups);
  b.set('X1', L_(at.x)); b.set('Y1', L_(at.y));
  if (b.has('ANGLE')) b.set('ANGLE', altiumFloat(angle));
  return b;
}

export interface NewDimension {
  kind: number; layer: LayerId; refs: Vec2[];
  /** Linear, baseline: a point the line runs through; angular: the vertex; radial: the arrow's point on the arc; leader: the arrow; center: the centre. */
  at: Vec2;
  angle: number; metric: boolean; text?: string; height?: number;
  /** The last click (TEXTX / TEXTY): the datum line, the angular radius and sector. Defaults to `at`. */
  pick?: Vec2;
  /** The object each point was picked on (REFERENCEnPRIM / OBJECTID / OBJECTSTRING / ANCHOR). */
  objects?: (RefObject | null)[];
}

/** A picked object as a dimension keeps it: its index in its stream, AD's object id and name, the anchor (1 start / centre, 2 end, 0 elsewhere [est]). */
export interface RefObject { prim: number; id: number; name: string; anchor: number }
const OBJECT_IDS: Record<string, [number, string]> = { arc: [1, 'Arc'], pad: [2, 'Pad'], via: [3, 'Via'], track: [4, 'Track'], fill: [6, 'Fill'] };
/** The object a point was picked on, as a dimension reference keeps it (null for nothing it measures from). */
export function refObject(p: PcbPrim, at: Vec2): RefObject | null {
  const id = OBJECT_IDS[p.kind];
  if (!id || !('src' in p) || !p.src) return null;
  const near = (q: Vec2) => Math.hypot(q.x - at.x, q.y - at.y) < 2;
  const anchor = p.kind === 'track' ? (near(p.a) ? 1 : near(p.b) ? 2 : 0) : p.kind === 'pad' || p.kind === 'via' ? (near(p.at) ? 1 : 0) : 0;
  return { prim: p.src.index, id: id[0], name: id[1], anchor };
}

/** AD's SECTOR for the side of the arms a click is on [est: numbering]. */
function sectorOf(refs: Vec2[], c: Vec2, pick: Vec2): number {
  const u1 = sub(refs[1] ?? c, refs[0] ?? c), u2 = sub(refs[3] ?? c, refs[2] ?? c), v = sub(pick, c);
  const a = dot(v, u1) >= 0, b2 = dot(v, u2) >= 0;
  return a && b2 ? 1 : !a && b2 ? 2 : !a && !b2 ? 3 : 4;
}

/**
 * A new record with the keys AD17 writes (an AD17 board's dimension, key for key), laid out.
 * X1 / Y1 as AD keeps them: linear and baseline, where the line starts (the first point's foot);
 * datum, where the first point's line starts; angular, the vertex (with RADIUS and SECTOR in
 * place of ANGLE); TEXTX / TEXTY, the last click.
 */
export function newDimension(o: NewDimension, index: number, edge?: DimEdge, userDefaults = false): PcbDimension {
  const layer = layerToName(o.layer);
  const prefix = o.kind === 3 ? 'R' : o.kind === 10 || o.kind === 9 ? 'Ø' : '';
  const angularKind = o.kind === 2;
  const pick = o.pick ?? o.at;
  const u = dirOf(o.angle), n = perp(u), p0 = o.refs[0];
  let x1 = o.at, x2: Vec2 = { x: 0, y: 0 };
  if (p0 && (o.kind === 1 || o.kind === 8 || o.kind === 9 || o.kind === 6)) x1 = add(o.at, mul(u, dot(sub(p0, o.at), u)));
  if (p0 && o.kind === 5) {
    const q = add(p0, mul(n, dot(sub(pick, p0), n))), v = sub(q, p0);
    x1 = Math.hypot(v.x, v.y) > mil(10) ? add(p0, mul(norm(v), mil(10))) : p0;
    const along = dot(p0, n);
    x2 = { x: along, y: along };   // [est: what AD keeps there]
  }
  const r = angularKind ? Math.hypot(pick.x - o.at.x, pick.y - o.at.y) : 0;
  const bag = PropertyBag.fromEntries([
    ['SELECTION', 'FALSE'], ['LAYER', layer], ['LOCKED', 'FALSE'], ['POLYGONOUTLINE', 'FALSE'], ['USERROUTED', 'TRUE'], ['KEEPOUT', 'FALSE'], ['UNIONINDEX', '0'],
    ['PRIMITIVELOCK', 'TRUE'], ['DIMENSIONLAYER', layer], ['DIMENSIONLOCKED', 'FALSE'], ['OBJECTID', '13'], ['DIMENSIONKIND', String(o.kind)], ['DRCERROR', 'FALSE'],
    ['VINDEXFORSAVE', String(index)], ['LX', '0mil'], ['LY', '0mil'], ['HX', '0mil'], ['HY', '0mil'], ['X1', '0mil'], ['Y1', '0mil'], ['X2', L_(x2.x)], ['Y2', L_(x2.y)],
    ['TEXTX', L_(pick.x)], ['TEXTY', L_(pick.y)], ['HEIGHT', L_(o.height ?? (o.kind === 7 ? mil(100) : mil(10)))], ['LINEWIDTH', '10mil'], ['TEXTHEIGHT', '60mil'], ['TEXTWIDTH', '6mil'],
    ['FONT', 'DEFAULT'], ['STYLE', 'None'], ['TEXTLINEWIDTH', '6mil'], ['TEXTPOSITION', o.kind === 3 || o.kind === 10 || o.kind === 5 ? 'UniDirectional' : 'Auto'], ['TEXTGAP', '10mil'],
    ['TEXTFORMAT', o.kind === 4 ? o.text ?? 'String' : angularKind ? '%d°' : '10'], ['TEXTDIMENSIONUNIT', angularKind ? 'Degrees' : o.metric ? 'Millimeters' : 'Mils'],
    ['TEXTPRECISION', '2'],
    ['TEXTPREFIX', prefix], ['TEXTSUFFIX', ''], ['ARROWSIZE', '60mil'], ['ARROWLINEWIDTH', '10mil'], ['ARROWLENGTH', '100mil'], ['ARROWPOSITION', 'Inside'],
    ['EXTENSIONOFFSET', '10mil'], ['EXTENSIONLINEWIDTH', '10mil'], ['EXTENSIONPICKGAP', '10mil'], ['REFERENCES_COUNT', '0'],
    ['USETTFONTS', 'FALSE'], ['BOLD', 'FALSE'], ['ITALIC', 'FALSE'], ['FONTNAME', 'Arial'],
    ...(angularKind ? [['RADIUS', L_(r)], ['SECTOR', String(sectorOf(o.refs, o.at, pick))]] as [string, string][] : [['ANGLE', altiumFloat(o.angle)]] as [string, string][]),
  ]);
  // Preferences › Defaults › Dimension: what was changed from AD17's (the text's line width goes with its width)
  // Preferences › Defaults › Dimension, for one placed (the demo board keeps AD17's)
  // …and then what its own kind has otherwise (Preferences › Defaults › Linear Dimension and the rest, 26.185)
  if (userDefaults) for (const kind of ['Dimension', ...(o.kind === 8 ? [] : [`${dimKindName(o.kind)} Dimension`])] as BagKind[]) {
    for (const [k, v] of Object.entries(changedBagDefaults(kind))) { bag.set(k, v); if (k === 'TEXTWIDTH') bag.set('TEXTLINEWIDTH', v); }
  }
  const b = withPoints(bag, o.refs, x1, o.angle);
  o.objects?.forEach((r, i) => {
    if (!r || i >= o.refs.length) return;
    b.set(`REFERENCE${i}PRIM`, String(r.prim)); b.set(`REFERENCE${i}OBJECTID`, String(r.id)); b.set(`REFERENCE${i}OBJECTSTRING`, r.name); b.set(`REFERENCE${i}ANCHOR`, String(r.anchor));
  });
  return dimensionFromBag(layoutDimension(dimensionFromBag(b, index), edge), index);
}

/** Points and text moved by a map (move, rotate, mirror), the text turned with them. */
export function transformDimension(d: PcbDimension, map: (v: Vec2) => Vec2, turn: number, mirror = false): PcbDimension {
  const refs = d.refs.map(map), at = map(d.at);
  const angle = (((mirror ? 180 - d.angle : d.angle) + turn) % 360 + 360) % 360;
  let b = withPoints(d.bag, refs, at, angle);
  const pick = pickOf(b);
  if (pick) { const p = map(pick); b.set('TEXTX', L_(p.x)); b.set('TEXTY', L_(p.y)); }
  for (let i = 1; b.has(`TEXT${i}X`); i++) {
    const p = map({ x: len(b, `TEXT${i}X`, '0mil'), y: len(b, `TEXT${i}Y`, '0mil') });
    b.set(`TEXT${i}X`, L_(p.x)); b.set(`TEXT${i}Y`, L_(p.y));
    b.set(`TEXT${i}ANGLE`, altiumFloat((((mirror ? 180 - b.float(`TEXT${i}ANGLE`) : b.float(`TEXT${i}ANGLE`)) + turn) % 360 + 360) % 360));
  }
  const moved = dimensionFromBag(b, d.index, d.prefix);
  // A turn other than a quarter, or a mirror, lays the text out again
  if (mirror || Math.abs(turn % 90) > 1e-9) b = layoutDimension(moved);
  else {
    const box = geometryBox(dimensionGeometry(moved));
    if (Number.isFinite(box.minX)) { b.set('LX', L_(box.minX)); b.set('LY', L_(box.minY)); b.set('HX', L_(box.maxX)); b.set('HY', L_(box.maxY)); }
  }
  return dimensionFromBag(b, d.index, d.prefix);
}

/* ── document changes ── */

interface DimDoc { dimensions: PcbDimension[]; dirty: Set<string> }
const reindex = (doc: DimDoc) => { doc.dimensions = doc.dimensions.map((d, i) => (d.index === i ? d : dimensionFromBag(d.bag, i, d.prefix))); };

export function addDimension(doc: DimDoc, d: PcbDimension): Change {
  const was = doc.dirty.has('Dimensions6');
  return {
    apply() { doc.dimensions = [...doc.dimensions, dimensionFromBag(d.bag, doc.dimensions.length, d.prefix)]; doc.dirty.add('Dimensions6'); },
    revert() { doc.dimensions = doc.dimensions.slice(0, -1); if (!was) doc.dirty.delete('Dimensions6'); },
  };
}

export function setDimension(doc: DimDoc, index: number, bag: PropertyBag): Change {
  const before = doc.dimensions[index]!;
  const was = doc.dirty.has('Dimensions6');
  return {
    apply() { const l = [...doc.dimensions]; l[index] = dimensionFromBag(bag, index, before.prefix); doc.dimensions = l; doc.dirty.add('Dimensions6'); },
    revert() { const l = [...doc.dimensions]; l[index] = before; doc.dimensions = l; if (!was) doc.dirty.delete('Dimensions6'); },
  };
}

export function removeDimensions(doc: DimDoc, indices: number[]): Change {
  const before = doc.dimensions;
  const drop = new Set(indices);
  const was = doc.dirty.has('Dimensions6');
  return {
    apply() { doc.dimensions = before.filter((d) => !drop.has(d.index)); reindex(doc); doc.dirty.add('Dimensions6'); },
    revert() { doc.dimensions = before; if (!was) doc.dirty.delete('Dimensions6'); },
  };
}
