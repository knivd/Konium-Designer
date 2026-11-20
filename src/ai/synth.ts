/**
 * Land-pattern drawings made up, their answers known: footprints of the kinds datasheets draw
 * (two rows of pads, quad packages, chips, SOT, through-hole headers, connectors with staggered
 * rows, shield slots and locating posts, flex connectors with mounting tabs, ball grids), drawn the
 * ways datasheets draw them (pads filled, grey, outlined or hatched; dimension chains with arrows,
 * "PITCH=0.50", "24X 0.30", "2X Ø0.65"; millimetres or inches; turned), each with the package
 * job's answer that reads it right. For measuring how well a model, or Konium's own measuring,
 * reads a drawing, and as examples to train a model on. A drawing is a list of primitives in
 * pixels: as SVG (to render), as the lines a PDF of it would draw (vector.ts's segments), or as a
 * rough grey picture (for tests without a browser: text as blobs).
 */
import { PACKAGE, type LandPad, type LeadForm, type PackageFamily, type PackageInput, type PackageRead } from './jobs';
import { rowsOf, type Grey } from './snap';
import type { Seg } from './vector';

export type Rand = () => number;
/** A seeded random source (mulberry32): the same seed, the same drawing. */
export function rand(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: Rand, a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(r() * a.length))]!;
const uni = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);
const fx = (v: number) => +v.toFixed(4) || 0;

export type SynthKind = 'dual' | 'quad' | 'chip' | 'sot' | 'header' | 'stagger' | 'fpc' | 'bga';
export const SYNTH_KINDS: SynthKind[] = ['dual', 'quad', 'chip', 'sot', 'header', 'stagger', 'fpc', 'bga'];
type Units = 'mm' | 'inch';
type Dir = 'right' | 'left' | 'up' | 'down';
type Side = 'top' | 'bottom' | 'left' | 'right';

/** A row of pads as the package job's answer gives it. */
export interface AnswerRow { first: string; last: string; count: number; pitch: number; direction: Dir; x: number; y: number; w: number; h: number; shape: LandPad['shape']; hole: number; names: string[] | null }
/** A single pad as the answer gives it. */
export interface AnswerPad { name: string; x: number; y: number; w: number; h: number; shape: LandPad['shape']; hole: number; slot: number; plated: boolean }

/**
 * A dimension the drawing shows: along x or y from a to b (mm), its extension lines from the
 * features at ea and eb (on the other axis), on a side of the pattern; or a hole's diameter (a
 * slot's width × length). `what` says what it measures (the answer's words).
 */
export type Dim = ({ t: 'lin'; axis: 'x' | 'y'; a: number; b: number; ea: number; eb: number; side: Side; pitch?: boolean }
  | { t: 'dia'; x: number; y: number; d: number; slot?: number; plated: boolean }) & { what: string; count?: number; text?: string };

/** A pin's label: at a pad (mm), on its side `out` (a unit step), `ext` mm from its centre to its edge that way. */
export interface Label { text: string; x: number; y: number; out: { x: number; y: number }; ext: number; main: boolean }

/** A made-up land pattern: the answer's parts, and what its drawing dimensions and labels. */
export interface Pattern {
  kind: SynthKind; family: PackageFamily; units: Units; pins: number; pitch: number | null;
  pinsPerSide: number | null; grid: { rows: number; cols: number } | null;
  package: string; leadForm: LeadForm; thermalPad: boolean;
  rows: AnswerRow[]; pads: AnswerPad[]; outline: { x: number; y: number; w: number; h: number } | null;
  dims: Dim[]; labels: Label[];
}

interface Gen { r: Rand; units: Units; q: (v: number) => number }

const STEP: Record<Dir, [number, number]> = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };

/* ─── Patterns ─────────────────────────────────────────────────────────────────────── */

/** Two rows of pads either side (SOIC, SOP, SON with its exposed pad), pins down the left and up the right. */
function dual({ r, q, units }: Gen): Pattern {
  const inch = units === 'inch';
  const pitch = inch ? pick(r, [1.27, 1.27, 0.635]) : pick(r, [0.4, 0.5, 0.5, 0.65, 0.65, 0.8, 0.95, 1.27, 1.27]);
  const side = pick(r, [3, 4, 4, 5, 6, 7, 8, 10, 12, 14]), n = 2 * side;
  const h = q(Math.max(0.2, Math.min(pitch * uni(r, 0.45, 0.62), pitch - 0.15)));
  const w = q(uni(r, 0.6, 2.2)), G = q(uni(r, 1.2, 7.5)), C = fx(G + w);
  const ep = r() < (pitch < 1 ? 0.45 : 0.2);
  const top = fx(((side - 1) * pitch) / 2);
  const shape = pick(r, ['rect', 'rect', 'roundrect', 'round'] as const);
  const L = fx(-C / 2 - w / 2), R = fx(C / 2 + w / 2), bot = fx(-top - h / 2);
  const p: Pattern = {
    kind: 'dual', family: pitch === 1.27 ? 'SOIC' : ep ? 'SON' : 'SOP', units, pins: n, pitch, pinsPerSide: null, grid: null,
    package: '', leadForm: ep ? 'no-lead' : 'gull-wing', thermalPad: ep,
    rows: [
      { first: '1', last: `${side}`, count: side, pitch, direction: 'down', x: fx(-C / 2), y: top, w, h, shape, hole: 0, names: null },
      { first: `${side + 1}`, last: `${n}`, count: side, pitch, direction: 'up', x: fx(C / 2), y: -top, w, h, shape, hole: 0, names: null },
    ],
    pads: [], outline: null, dims: [], labels: [],
  };
  p.package = `${p.family}-${n}${ep ? ' EP' : ''}`;
  p.dims.push({ t: 'lin', axis: 'y', a: top, b: fx(top - pitch), ea: L, eb: L, side: 'left', what: 'between neighbouring pads of a row', pitch: true });
  p.dims.push({ t: 'lin', axis: 'x', a: L, b: fx(-C / 2 + w / 2), ea: fx(top + h / 2), eb: fx(top + h / 2), side: 'top', what: 'pad length', count: n });
  p.dims.push({ t: 'lin', axis: 'y', a: fx(-top + h / 2), b: bot, ea: R, eb: R, side: 'right', what: 'pad width', count: n });
  const span = pick(r, ['C', 'Z', 'G', 'ZG'] as const);
  if (span === 'C') p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2), b: fx(C / 2), ea: bot, eb: bot, side: 'bottom', what: 'between the rows\' pad centres' });
  if (span.includes('Z')) p.dims.push({ t: 'lin', axis: 'x', a: L, b: R, ea: bot, eb: bot, side: 'bottom', what: 'across the outer ends of the pads' });
  if (span.includes('G')) p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2 + w / 2), b: fx(C / 2 - w / 2), ea: bot, eb: bot, side: 'bottom', what: 'between the rows\' inner ends' });
  if (r() < 0.4 && side > 2) p.dims.push({ t: 'lin', axis: 'y', a: top, b: -top, ea: L, eb: L, side: 'left', what: `between the centres of pads 1 and ${side}` });
  if (ep) {
    const ew = q(Math.max(0.6, uni(r, 0.4, 0.8) * (G - 0.4))), eh = q(Math.max(0.6, uni(r, 0.5, 0.9) * (2 * top + h)));
    p.pads.push({ name: `${n + 1}`, x: 0, y: 0, w: ew, h: eh, shape: 'rect', hole: 0, slot: 0, plated: true });
    p.dims.push({ t: 'lin', axis: 'x', a: fx(-ew / 2), b: fx(ew / 2), ea: fx(-eh / 2), eb: fx(-eh / 2), side: 'bottom', what: 'exposed pad, along x' });
    p.dims.push({ t: 'lin', axis: 'y', a: fx(eh / 2), b: fx(-eh / 2), ea: fx(ew / 2), eb: fx(ew / 2), side: 'right', what: 'exposed pad, along y' });
  }
  if (r() < 0.5) p.outline = { x: 0, y: 0, w: q(G + uni(r, 0, 0.6) * w), h: q(2 * top + h + uni(r, 0.3, 1.2)) };
  for (let k = 0; k < n; k++) {
    const left = k < side, i = left ? k : k - side;
    p.labels.push({ text: `${k + 1}`, x: left ? -C / 2 : C / 2, y: left ? top - i * pitch : -top + i * pitch, out: { x: left ? -1 : 1, y: 0 }, ext: w / 2, main: k === 0 || k === side - 1 || k === n - 1 });
  }
  return p;
}

/** Pads on four sides (QFN, QFP), counted anticlockwise from the top of the left side. */
function quad({ r, q, units }: Gen): Pattern {
  const pitch = units === 'inch' ? 0.635 : pick(r, [0.4, 0.5, 0.5, 0.65, 0.8]);
  const k = pick(r, [3, 4, 5, 6, 7, 8, 9, 10, 12, 16]), n = 4 * k;
  const h = q(Math.max(0.2, Math.min(pitch * uni(r, 0.45, 0.6), pitch - 0.15))), w = q(uni(r, 0.5, 1.8));
  const span = fx((k - 1) * pitch), C = q(span + h + w + uni(r, 0.6, 3.0)), s2 = fx(span / 2);
  const ep = r() < 0.6;
  const shape = pick(r, ['rect', 'rect', 'roundrect', 'round'] as const);
  const p: Pattern = {
    kind: 'quad', family: ep || w < 1 ? 'QFN' : 'QFP', units, pins: n, pitch, pinsPerSide: k, grid: null,
    package: '', leadForm: ep || w < 1 ? 'no-lead' : 'gull-wing', thermalPad: ep,
    rows: [
      { first: '1', last: `${k}`, count: k, pitch, direction: 'down', x: fx(-C / 2), y: s2, w, h, shape, hole: 0, names: null },
      { first: `${k + 1}`, last: `${2 * k}`, count: k, pitch, direction: 'right', x: -s2, y: fx(-C / 2), w: h, h: w, shape, hole: 0, names: null },
      { first: `${2 * k + 1}`, last: `${3 * k}`, count: k, pitch, direction: 'up', x: fx(C / 2), y: -s2, w, h, shape, hole: 0, names: null },
      { first: `${3 * k + 1}`, last: `${n}`, count: k, pitch, direction: 'left', x: s2, y: fx(C / 2), w: h, h: w, shape, hole: 0, names: null },
    ],
    pads: [], outline: null, dims: [], labels: [],
  };
  p.package = `${p.family}-${n}${ep ? ' EP' : ''}`;
  const L = fx(-C / 2 - w / 2), T = fx(C / 2 + w / 2), B = fx(-C / 2 - w / 2);
  p.dims.push({ t: 'lin', axis: 'x', a: s2, b: fx(s2 - pitch), ea: T, eb: T, side: 'top', what: 'between neighbouring pads of a row', pitch: true });
  p.dims.push({ t: 'lin', axis: 'y', a: fx(s2 + h / 2), b: fx(s2 - h / 2), ea: L, eb: L, side: 'left', what: 'pad width', count: n });
  p.dims.push({ t: 'lin', axis: 'x', a: L, b: fx(-C / 2 + w / 2), ea: fx(s2 + h / 2), eb: fx(s2 + h / 2), side: 'top', what: 'pad length', count: n });
  if (r() < 0.6) {
    p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2), b: fx(C / 2), ea: fx(-s2 - h / 2), eb: fx(-s2 - h / 2), side: 'bottom', what: 'between the left and right rows\' pad centres' });
    p.dims.push({ t: 'lin', axis: 'y', a: fx(C / 2), b: fx(-C / 2), ea: fx(s2 + h / 2), eb: fx(s2 + h / 2), side: 'right', what: 'between the top and bottom rows\' pad centres' });
  } else {
    p.dims.push({ t: 'lin', axis: 'x', a: L, b: fx(C / 2 + w / 2), ea: fx(-s2 - h / 2), eb: fx(-s2 - h / 2), side: 'bottom', what: 'across the outer ends of the left and right pads' });
    p.dims.push({ t: 'lin', axis: 'y', a: T, b: B, ea: fx(s2 + h / 2), eb: fx(s2 + h / 2), side: 'right', what: 'across the outer ends of the top and bottom pads' });
  }
  if (ep) {
    const e = q(Math.max(0.6, Math.min(C - w - 0.7, uni(r, 0.5, 0.9) * (C - w))));
    const e2 = r() < 0.7 ? e : q(Math.max(0.6, e * uni(r, 0.7, 1)));
    p.pads.push({ name: `${n + 1}`, x: 0, y: 0, w: e, h: e2, shape: 'rect', hole: 0, slot: 0, plated: true });
    p.dims.push({ t: 'lin', axis: 'x', a: fx(-e / 2), b: fx(e / 2), ea: fx(-e2 / 2), eb: fx(-e2 / 2), side: 'bottom', what: 'exposed pad, along x' });
    if (e2 !== e || r() < 0.5) p.dims.push({ t: 'lin', axis: 'y', a: fx(e2 / 2), b: fx(-e2 / 2), ea: fx(e / 2), eb: fx(e / 2), side: 'right', what: 'exposed pad, along y' });
  }
  if (r() < 0.4) p.outline = { x: 0, y: 0, w: q(C - w * uni(r, 0.2, 0.8)), h: 0 };
  if (p.outline) p.outline.h = p.outline.w;
  const outs = [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  p.rows.forEach((row, ri) => {
    const [dx, dy] = STEP[row.direction];
    for (let i = 0; i < k; i++) p.labels.push({ text: `${ri * k + i + 1}`, x: row.x + dx * pitch * i, y: row.y + dy * pitch * i, out: outs[ri]!, ext: w / 2, main: ri * k + i === 0 || i === k - 1 });
  });
  return p;
}

/** Two pads (chip resistors and capacitors, moulded bodies, SOD). */
function chip({ r, q, units }: Gen): Pattern {
  const w = q(uni(r, 0.3, 1.6)), h = q(uni(r, 0.3, 3.2)), G = q(uni(r, 0.2, 2.6)), C = fx(G + w);
  const family = pick(r, ['CHIP', 'CHIP', 'MOLDED', 'SOD'] as const);
  const shape = pick(r, ['rect', 'rect', 'roundrect'] as const);
  const p: Pattern = {
    kind: 'chip', family, units, pins: 2, pitch: null, pinsPerSide: null, grid: null, package: family === 'CHIP' ? 'Chip 2 pads' : family === 'SOD' ? 'SOD' : 'Moulded body', leadForm: 'other', thermalPad: false,
    rows: [], pads: [
      { name: '1', x: fx(-C / 2), y: 0, w, h, shape, hole: 0, slot: 0, plated: true },
      { name: '2', x: fx(C / 2), y: 0, w, h, shape, hole: 0, slot: 0, plated: true },
    ], outline: null, dims: [], labels: [],
  };
  p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2 - w / 2), b: fx(-C / 2 + w / 2), ea: fx(h / 2), eb: fx(h / 2), side: 'top', what: 'pad length', count: 2 });
  p.dims.push({ t: 'lin', axis: 'y', a: fx(h / 2), b: fx(-h / 2), ea: fx(C / 2 + w / 2), eb: fx(C / 2 + w / 2), side: 'right', what: 'pad width', count: 2 });
  const span = pick(r, ['G', 'C', 'Z', 'GZ'] as const);
  if (span.includes('G')) p.dims.push({ t: 'lin', axis: 'x', a: fx(-G / 2), b: fx(G / 2), ea: fx(-h / 2), eb: fx(-h / 2), side: 'bottom', what: 'between the pads' });
  if (span === 'C') p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2), b: fx(C / 2), ea: fx(-h / 2), eb: fx(-h / 2), side: 'bottom', what: 'between the pads\' centres' });
  if (span.includes('Z')) p.dims.push({ t: 'lin', axis: 'x', a: fx(-C / 2 - w / 2), b: fx(C / 2 + w / 2), ea: fx(-h / 2), eb: fx(-h / 2), side: 'bottom', what: 'across the pads\' outer ends' });
  p.labels.push({ text: '1', x: -C / 2, y: 0, out: { x: 0, y: 1 }, ext: h / 2, main: true }, { text: '2', x: C / 2, y: 0, out: { x: 0, y: 1 }, ext: h / 2, main: true });
  return p;
}

/** SOT-23 (3, 5 or 6 leads) and SOT-223. */
function sot({ r, q, units }: Gen): Pattern {
  const kind = pick(r, ['3', '5', '6', '223'] as const);
  const big = kind === '223', pitch = big ? 2.3 : 0.95;
  const w = big ? q(uni(r, 0.8, 1.2)) : q(uni(r, 0.5, 0.7)), h = big ? q(uni(r, 1.5, 2.2)) : q(uni(r, 0.9, 1.3));
  const C = big ? q(uni(r, 5.6, 6.6)) : q(uni(r, 2.0, 2.7)), y = fx(C / 2);
  const p: Pattern = {
    kind: 'sot', family: big ? 'SOT223' : 'SOT23', units, pins: big ? 4 : Number(kind), pitch, pinsPerSide: null, grid: null,
    package: big ? 'SOT-223' : `SOT-23-${kind}`, leadForm: 'gull-wing', thermalPad: false, rows: [], pads: [], outline: null, dims: [], labels: [],
  };
  const pad = (name: string, x: number, yy: number, pw = w, ph = h) => {
    p.pads.push({ name, x: fx(x), y: fx(yy), w: pw, h: ph, shape: 'rect', hole: 0, slot: 0, plated: true });
    p.labels.push({ text: name, x, y: yy, out: { x: 0, y: yy < 0 ? -1 : 1 }, ext: ph / 2, main: true });
  };
  if (kind === '3') { pad('1', -pitch, -y); pad('2', pitch, -y); pad('3', 0, y); }
  else {
    pad('1', -pitch, -y); pad('2', 0, -y); pad('3', pitch, -y);
    if (kind === '5') { pad('4', pitch, y); pad('5', -pitch, y); }
    else if (kind === '6') { pad('4', pitch, y); pad('5', 0, y); pad('6', -pitch, y); }
    else { const tw = q(uni(r, 3.2, 3.8)), th = q(uni(r, 1.8, 2.4)); pad('4', 0, y, tw, th); p.dims.push({ t: 'lin', axis: 'x', a: fx(-tw / 2), b: fx(tw / 2), ea: fx(y + th / 2), eb: fx(y + th / 2), side: 'top', what: 'tab pad width' }, { t: 'lin', axis: 'y', a: fx(y + th / 2), b: fx(y - th / 2), ea: fx(tw / 2), eb: fx(tw / 2), side: 'right', what: 'tab pad length' }); }
  }
  p.dims.push({ t: 'lin', axis: 'x', a: -pitch, b: 0, ea: fx(-y - h / 2), eb: fx(-y - h / 2), side: 'bottom', what: 'between neighbouring pads', pitch: true });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(pitch - w / 2), b: fx(pitch + w / 2), ea: fx(-y - h / 2), eb: fx(-y - h / 2), side: 'bottom', what: 'pad width' });
  p.dims.push({ t: 'lin', axis: 'y', a: fx(-y + h / 2), b: fx(-y - h / 2), ea: fx(-pitch - w / 2), eb: fx(-pitch - w / 2), side: 'left', what: 'pad length' });
  const topEdge = kind === '3' ? -w / 2 : big ? -p.pads[3]!.w / 2 : -pitch - w / 2;
  p.dims.push({ t: 'lin', axis: 'y', a: y, b: -y, ea: fx(topEdge), eb: fx(-pitch - w / 2), side: 'left', what: 'between the rows\' pad centres' });
  return p;
}

/** Through-hole pins: DIP rows, a single row, or a two-row header numbered odd and even; pin 1 square. */
function header({ r, q }: Gen): Pattern {
  const type = pick(r, ['dip', 'single', 'double'] as const);
  const pitch = type === 'dip' ? 2.54 : pick(r, [2.54, 2.54, 2.0, 1.27]);
  const hole = q(Math.min(uni(r, 0.6, 1.1), pitch * 0.45)), pad = q(Math.min(hole + uni(r, 0.4, 0.8), pitch - 0.3));
  const round = (name: string) => ({ shape: 'round' as const, hole, w: pad, h: pad, names: null, name });
  const p: Pattern = {
    kind: 'header', family: type === 'dip' ? 'DIP' : 'OTHER', units: 'mm', pins: 0, pitch, pinsPerSide: null, grid: null,
    package: '', leadForm: 'through-hole', thermalPad: false, rows: [], pads: [], outline: null, dims: [], labels: [],
  };
  const one = (x: number, y: number) => p.pads.push({ name: '1', x: fx(x), y: fx(y), w: pad, h: pad, shape: 'rect', hole, slot: 0, plated: true });
  if (type === 'single') {
    const n = pick(r, [3, 4, 5, 6, 8, 10, 12, 16]), s2 = fx(((n - 1) * pitch) / 2);
    p.pins = n; p.package = `Header 1x${n}`;
    one(-s2, 0);
    const { name: _, ...rest } = round('');
    p.rows.push({ first: '2', last: `${n}`, count: n - 1, pitch, direction: 'right', x: fx(-s2 + pitch), y: 0, ...rest });
    p.dims.push({ t: 'lin', axis: 'x', a: -s2, b: fx(-s2 + pitch), ea: fx(pad / 2), eb: fx(pad / 2), side: 'top', what: 'pitch', pitch: true });
    if (r() < 0.6) p.dims.push({ t: 'lin', axis: 'x', a: -s2, b: s2, ea: fx(-pad / 2), eb: fx(-pad / 2), side: 'bottom', what: `between the centres of pins 1 and ${n}` });
    for (let i = 0; i < n; i++) p.labels.push({ text: `${i + 1}`, x: -s2 + i * pitch, y: 0, out: { x: 0, y: 1 }, ext: pad / 2, main: i === 0 || i === n - 1 });
  } else {
    const k = pick(r, type === 'dip' ? [4, 7, 8, 10, 12, 14] : [3, 4, 5, 6, 8, 10]);
    const sp = type === 'dip' ? pick(r, [7.62, 7.62, 10.16, 15.24]) : pitch, x = fx(sp / 2), top = fx(((k - 1) * pitch) / 2);
    p.pins = 2 * k; p.package = type === 'dip' ? `DIP-${2 * k}` : `Header 2x${k}`;
    one(-x, top);
    const { name: _, ...rest } = round('');
    if (type === 'dip') {
      p.rows.push({ first: '2', last: `${k}`, count: k - 1, pitch, direction: 'down', x: -x, y: fx(top - pitch), ...rest });
      p.rows.push({ first: `${k + 1}`, last: `${2 * k}`, count: k, pitch, direction: 'up', x, y: -top, ...rest });
      for (let i = 0; i < 2 * k; i++) { const left = i < k, j = left ? i : i - k; p.labels.push({ text: `${i + 1}`, x: left ? -x : x, y: left ? top - j * pitch : -top + j * pitch, out: { x: left ? -1 : 1, y: 0 }, ext: pad / 2, main: i === 0 || i === k - 1 || i === 2 * k - 1 }); }
    } else {
      const odd = Array.from({ length: k - 1 }, (_, i) => `${2 * i + 3}`), even = Array.from({ length: k }, (_, i) => `${2 * i + 2}`);
      p.rows.push({ first: '3', last: odd.at(-1)!, count: k - 1, pitch, direction: 'down', x: -x, y: fx(top - pitch), ...rest, names: odd });
      p.rows.push({ first: '2', last: even.at(-1)!, count: k, pitch, direction: 'down', x, y: top, ...rest, names: even });
      for (let i = 0; i < 2 * k; i++) { const left = i % 2 === 0, j = i >> 1; p.labels.push({ text: `${i + 1}`, x: left ? -x : x, y: top - j * pitch, out: { x: left ? -1 : 1, y: 0 }, ext: pad / 2, main: i < 2 || i >= 2 * k - 2 }); }
    }
    p.dims.push({ t: 'lin', axis: 'y', a: top, b: fx(top - pitch), ea: fx(-x - pad / 2), eb: fx(-x - pad / 2), side: 'left', what: 'pitch', pitch: true });
    p.dims.push({ t: 'lin', axis: 'x', a: -x, b: x, ea: fx(-top - pad / 2), eb: fx(-top - pad / 2), side: 'bottom', what: 'between the rows\' centres' });
    if (r() < 0.4) p.dims.push({ t: 'lin', axis: 'y', a: top, b: -top, ea: fx(x + pad / 2), eb: fx(x + pad / 2), side: 'right', what: `between the first and last pins' centres of a row` });
  }
  const at = p.rows[0]!;
  p.dims.push({ t: 'dia', x: at.x, y: at.y, d: hole, plated: true, what: 'hole diameter', count: p.pins });
  p.dims.push({ t: 'dia', x: p.pads[0]!.x, y: p.pads[0]!.y, d: pad, plated: true, what: 'pad diameter (pin 1 square)', count: p.pins });
  return p;
}

/** A connector's two staggered rows (a USB-C receptacle's A and B rows), shield slots and locating posts. */
function stagger({ r, q }: Gen): Pattern {
  const k = pick(r, [6, 8, 10, 12, 12, 14]), pitch = pick(r, [0.5, 0.5, 0.6, 0.8]);
  const st = pick(r, [pitch / 2, pitch / 2, 0]);
  const w = q(Math.min(pitch * uni(r, 0.5, 0.65), pitch - 0.18)), h = q(uni(r, 0.6, 1.2));
  const d = q(h + uni(r, 0.3, 1.0)), s2 = ((k - 1) * pitch) / 2;
  const ya = fx(d / 2), yb = fx(-d / 2), xa = fx(-s2 + st / 2), xb = fx(-s2 - st / 2);
  const post = q(uni(r, 0.5, 0.8)), px = q(s2 + uni(r, 0.4, 0.8)), py = q(yb - h / 2 - post / 2 - uni(r, 0.3, 0.9));
  const sw = q(uni(r, 0.5, 0.7)), sl = q(uni(r, 1.0, 1.8)), pw = q(sw + uni(r, 0.3, 0.5)), ph = q(sl + uni(r, 0.3, 0.5));
  const sx = q(px + post / 2 + pw / 2 + uni(r, 0.3, 1.0)), sy = q(py - uni(r, 0.4, 1.6));
  const four = r() < 0.4, sy2 = q(sy - ph - uni(r, 1.0, 2.5));
  const sh = pick(r, ['SH', 'S'] as const);
  const p: Pattern = {
    kind: 'stagger', family: 'OTHER', units: 'mm', pins: 2 * k, pitch, pinsPerSide: null, grid: null, package: `Receptacle ${2 * k}P`, leadForm: 'other', thermalPad: false,
    rows: [
      { first: 'A1', last: `A${k}`, count: k, pitch, direction: 'right', x: xa, y: ya, w, h, shape: 'rect', hole: 0, names: null },
      { first: `B${k}`, last: 'B1', count: k, pitch, direction: 'right', x: xb, y: yb, w, h, shape: 'rect', hole: 0, names: null },
    ],
    pads: [
      { name: '', x: -px, y: py, w: post, h: post, shape: 'round', hole: post, slot: 0, plated: false },
      { name: '', x: px, y: py, w: post, h: post, shape: 'round', hole: post, slot: 0, plated: false },
    ], outline: null, dims: [], labels: [],
  };
  const shields = four ? [[-sx, sy], [sx, sy], [-sx, sy2], [sx, sy2]] : [[-sx, sy], [sx, sy]];
  // Shields: all one name (one net), or numbered
  const shared = sh === 'S' || r() < 0.4;
  shields.forEach(([x, y], i) => {
    const name = shared ? (sh === 'S' ? 'SH' : 'SHIELD') : `SH${i + 1}`;
    p.pads.push({ name, x: fx(x!), y: fx(y!), w: pw, h: ph, shape: 'round', hole: sw, slot: sl, plated: true });
    p.labels.push({ text: name, x: x!, y: y!, out: { x: Math.sign(x!), y: 0 }, ext: pw / 2, main: true });
  });
  const T = fx(ya + h / 2);
  p.dims.push({ t: 'lin', axis: 'x', a: xa, b: fx(xa + pitch), ea: T, eb: T, side: 'top', what: 'between neighbouring pads of a row', pitch: true });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(xa + (k - 1) * pitch - w / 2), b: fx(xa + (k - 1) * pitch + w / 2), ea: T, eb: T, side: 'top', what: 'pad width', count: 2 * k });
  p.dims.push({ t: 'lin', axis: 'y', a: T, b: fx(ya - h / 2), ea: fx(xa + (k - 1) * pitch + w / 2), eb: fx(xa + (k - 1) * pitch + w / 2), side: 'right', what: 'pad length', count: 2 * k });
  p.dims.push({ t: 'lin', axis: 'y', a: ya, b: yb, ea: fx(xb - w / 2), eb: fx(xb - w / 2), side: 'left', what: 'between the rows\' pad centres' });
  if (st) p.dims.push({ t: 'lin', axis: 'x', a: xb, b: xa, ea: fx(yb - h / 2), eb: T, side: 'top', what: 'the bottom row\'s offset from the top row' });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(-sx), b: fx(sx), ea: fx((four ? sy2 : sy) - ph / 2), eb: fx((four ? sy2 : sy) - ph / 2), side: 'bottom', what: 'between the shield slots\' centres' });
  p.dims.push({ t: 'lin', axis: 'x', a: -px, b: px, ea: fx(py - post / 2), eb: fx(py - post / 2), side: 'bottom', what: 'between the locating posts\' centres' });
  p.dims.push({ t: 'lin', axis: 'y', a: yb, b: py, ea: fx(-px - post / 2), eb: fx(-px - post / 2), side: 'left', what: 'from the bottom row\'s centres to the posts\'' });
  p.dims.push({ t: 'lin', axis: 'y', a: py, b: sy, ea: fx(-sx - pw / 2), eb: fx(-sx - pw / 2), side: 'left', what: 'from the posts\' centres to the shield slots\'' });
  if (four) p.dims.push({ t: 'lin', axis: 'y', a: sy, b: sy2, ea: fx(sx + pw / 2), eb: fx(sx + pw / 2), side: 'right', what: 'between the shield slots\' centres, along y' });
  p.dims.push({ t: 'dia', x: px, y: py, d: post, plated: false, what: 'locating post holes, unplated', count: 2 });
  p.dims.push({ t: 'dia', x: sx, y: sy, d: sw, slot: sl, plated: true, what: 'shield slot (drill × length)', count: shields.length });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(sx - pw / 2), b: fx(sx + pw / 2), ea: fx(sy + ph / 2), eb: fx(sy + ph / 2), side: 'top', what: 'shield pad width', count: shields.length });
  for (let i = 0; i < k; i++) {
    p.labels.push({ text: `A${i + 1}`, x: xa + i * pitch, y: ya, out: { x: 0, y: 1 }, ext: h / 2, main: i === 0 || i === k - 1 });
    p.labels.push({ text: `B${k - i}`, x: xb + i * pitch, y: yb, out: { x: 0, y: -1 }, ext: h / 2, main: i === 0 || i === k - 1 });
  }
  return p;
}

/** A flex (FPC) connector: one row of fine-pitch pads, two mounting tabs. */
function fpc({ r, q }: Gen): Pattern {
  const pitch = pick(r, [0.3, 0.5, 0.5, 0.8, 1.0, 1.25]);
  const k = pick(r, pitch <= 0.5 ? [6, 10, 12, 16, 20, 24, 30, 40] : [4, 6, 8, 10, 12, 15]);
  const w = q(Math.max(0.15, Math.min(pitch * uni(r, 0.5, 0.65), pitch - 0.12))), h = q(uni(r, 0.8, 1.8));
  const s2 = ((k - 1) * pitch) / 2;
  const tw = q(uni(r, 1.0, 2.2)), th = q(uni(r, 1.2, 2.8)), tx = q(s2 + w / 2 + uni(r, 0.8, 1.8) + tw / 2);
  const ty = q((r() < 0.7 ? -1 : 1) * (h / 2 + uni(r, 0.4, 1.6) + th / 2));
  const down = r() < 0.3;
  const tab = pick(r, ['MP', 'MH', 'SH'] as const);
  const p: Pattern = {
    kind: 'fpc', family: 'OTHER', units: 'mm', pins: k, pitch, pinsPerSide: null, grid: null, package: `FPC ${k}P ${pitch}`, leadForm: 'other', thermalPad: false,
    rows: [down
      ? { first: `${k}`, last: '1', count: k, pitch, direction: 'right', x: fx(-s2), y: 0, w, h, shape: 'rect', hole: 0, names: null }
      : { first: '1', last: `${k}`, count: k, pitch, direction: 'right', x: fx(-s2), y: 0, w, h, shape: 'rect', hole: 0, names: null }],
    pads: [
      { name: `${tab}1`, x: -tx, y: ty, w: tw, h: th, shape: 'rect', hole: 0, slot: 0, plated: true },
      { name: `${tab}2`, x: tx, y: ty, w: tw, h: th, shape: 'rect', hole: 0, slot: 0, plated: true },
    ], outline: null, dims: [], labels: [],
  };
  const T = fx(h / 2), B = fx(-h / 2);
  p.dims.push({ t: 'lin', axis: 'x', a: fx(-s2), b: fx(-s2 + pitch), ea: T, eb: T, side: 'top', what: 'between neighbouring pads', pitch: true });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(s2 - w / 2), b: fx(s2 + w / 2), ea: T, eb: T, side: 'top', what: 'pad width', count: k });
  p.dims.push({ t: 'lin', axis: 'y', a: T, b: B, ea: fx(s2 + w / 2), eb: fx(s2 + w / 2), side: 'right', what: 'pad length', count: k });
  if (r() < 0.6) p.dims.push({ t: 'lin', axis: 'x', a: fx(-s2), b: fx(s2), ea: T, eb: T, side: 'top', what: 'between the first and last pads\' centres' });
  const te = fx(ty + (ty < 0 ? -th / 2 : th / 2));
  p.dims.push({ t: 'lin', axis: 'x', a: -tx, b: tx, ea: te, eb: te, side: ty < 0 ? 'bottom' : 'top', what: 'between the mounting tabs\' centres' });
  p.dims.push({ t: 'lin', axis: 'x', a: fx(tx - tw / 2), b: fx(tx + tw / 2), ea: te, eb: te, side: ty < 0 ? 'bottom' : 'top', what: 'mounting tab width', count: 2 });
  p.dims.push({ t: 'lin', axis: 'y', a: fx(ty + th / 2), b: fx(ty - th / 2), ea: fx(tx + tw / 2), eb: fx(tx + tw / 2), side: 'right', what: 'mounting tab length', count: 2 });
  p.dims.push({ t: 'lin', axis: 'y', a: 0, b: ty, ea: fx(-s2 - w / 2), eb: fx(-tx - tw / 2), side: 'left', what: 'from the pads\' centres to the tabs\'' });
  for (let i = 0; i < k; i++) p.labels.push({ text: `${down ? k - i : i + 1}`, x: -s2 + i * pitch, y: 0, out: { x: 0, y: ty < 0 ? 1 : -1 }, ext: h / 2, main: i === 0 || i === k - 1 });
  p.labels.push({ text: `${tab}1`, x: -tx, y: ty, out: { x: -1, y: 0 }, ext: tw / 2, main: true }, { text: `${tab}2`, x: tx, y: ty, out: { x: 1, y: 0 }, ext: tw / 2, main: true });
  return p;
}

const BGA_ROWS = 'ABCDEFGHJKLMNPRTUVWY';
/** A ball grid's pads: rows lettered from the top (no I, O, Q, S, X, Z), columns numbered from the left. */
function bga({ r }: Gen): Pattern {
  const pitch = pick(r, [0.4, 0.5, 0.65, 0.8, 0.8, 1.0]);
  const rows = pick(r, [3, 4, 5, 6, 7, 8, 9, 10]), cols = pick(r, [3, 4, 5, 6, 7, 8, 9, 10]);
  const d = +(Math.max(0.2, pitch * uni(r, 0.45, 0.55))).toFixed(2);
  const x0 = fx(-((cols - 1) * pitch) / 2), y0 = fx(((rows - 1) * pitch) / 2);
  const p: Pattern = {
    kind: 'bga', family: 'BGA', units: 'mm', pins: rows * cols, pitch, pinsPerSide: null, grid: { rows, cols }, package: `BGA-${rows * cols}`, leadForm: 'ball', thermalPad: false,
    rows: Array.from({ length: rows }, (_, i) => ({ first: `${BGA_ROWS[i]}1`, last: `${BGA_ROWS[i]}${cols}`, count: cols, pitch, direction: 'right' as const, x: x0, y: fx(y0 - i * pitch), w: d, h: d, shape: 'round' as const, hole: 0, names: null })),
    pads: [], outline: null, dims: [], labels: [],
  };
  p.dims.push({ t: 'lin', axis: 'x', a: x0, b: fx(x0 + pitch), ea: fx(y0 + d / 2), eb: fx(y0 + d / 2), side: 'top', what: 'pitch along a row', pitch: true });
  p.dims.push({ t: 'lin', axis: 'y', a: y0, b: fx(y0 - pitch), ea: fx(-x0 + d / 2), eb: fx(-x0 + d / 2), side: 'right', what: 'pitch between rows', pitch: true });
  p.dims.push({ t: 'lin', axis: 'x', a: x0, b: -x0, ea: fx(-y0 - d / 2), eb: fx(-y0 - d / 2), side: 'bottom', what: 'between the first and last columns\' centres' });
  p.dims.push({ t: 'lin', axis: 'y', a: y0, b: -y0, ea: fx(x0 - d / 2), eb: fx(x0 - d / 2), side: 'left', what: 'between the first and last rows\' centres' });
  p.dims.push({ t: 'dia', x: -x0, y: -y0, d, plated: true, what: 'pad diameter', count: rows * cols });
  for (let c = 0; c < cols; c++) p.labels.push({ text: `${c + 1}`, x: x0 + c * pitch, y: y0, out: { x: 0, y: 1 }, ext: d / 2, main: true });
  for (let i = 0; i < rows; i++) p.labels.push({ text: BGA_ROWS[i]!, x: x0, y: y0 - i * pitch, out: { x: -1, y: 0 }, ext: d / 2, main: true });
  return p;
}

const GENS: Record<SynthKind, (g: Gen) => Pattern> = { dual, quad, chip, sot, header, stagger, fpc, bga };

/** The pattern's pads as the app reads them (the answer through the package job's own check). */
function landOf(p: Pattern): LandPad[] {
  return PACKAGE.check({ family: p.family, pins: p.pins, pitch: p.pitch, landPattern: { rows: p.rows, pads: p.pads } }, { pageCount: 1, variant: { pins: p.pins } } as PackageInput).land;
}

/** Everything moved by (dx, dy). */
function shift(p: Pattern, dx: number, dy: number): void {
  for (const o of [...p.rows, ...p.pads, ...p.labels]) { o.x = fx(o.x + dx); o.y = fx(o.y + dy); }
  if (p.outline) { p.outline.x = fx(p.outline.x + dx); p.outline.y = fx(p.outline.y + dy); }
  for (const d of p.dims) {
    if (d.t === 'dia') { d.x = fx(d.x + dx); d.y = fx(d.y + dy); continue; }
    const [u, v] = d.axis === 'x' ? [dx, dy] : [dy, dx];
    d.a = fx(d.a + u); d.b = fx(d.b + u); d.ea = fx(d.ea + v); d.eb = fx(d.eb + v);
  }
}

/** Everything turned a quarter anticlockwise: (x, y) → (−y, x). */
function turn(p: Pattern): void {
  const T = (o: { x: number; y: number }) => { const x = o.x; o.x = fx(-o.y); o.y = fx(x); };
  const DIR: Record<Dir, Dir> = { right: 'up', up: 'left', left: 'down', down: 'right' };
  const SIDE: Record<Side, Side> = { top: 'left', left: 'bottom', bottom: 'right', right: 'top' };
  for (const o of [...p.rows, ...p.pads]) { T(o); const w = o.w; o.w = o.h; o.h = w; }
  for (const row of p.rows) row.direction = DIR[row.direction];
  for (const l of p.labels) { T(l); T(l.out); }
  if (p.outline) { T(p.outline); const w = p.outline.w; p.outline.w = p.outline.h; p.outline.h = w; }
  for (const d of p.dims) {
    if (d.t === 'dia') { T(d); continue; }
    d.side = SIDE[d.side];
    // An x dimension at features' y becomes a y dimension at their −y; a y dimension, an x one at −y
    if (d.axis === 'x') { d.axis = 'y'; d.ea = fx(-d.ea); d.eb = fx(-d.eb); }
    else { d.axis = 'x'; d.a = fx(-d.a); d.b = fx(-d.b); }
  }
}

/* ─── Styles ───────────────────────────────────────────────────────────────────────── */

/** How a drawing is drawn: the many ways datasheets draw a land pattern. */
export interface Style {
  /** mm; inches; mm with inches in brackets. */
  units: Units; brackets: boolean;
  pad: 'fill' | 'grey' | 'outline' | 'hatch'; grey: string; stroke: number; line: number;
  font: string; size: number; arrow: 'filled' | 'open' | 'tick'; turnText: boolean;
  minDecimals: 1 | 2; comma: boolean; countForm: number; pitchForm: number; diaForm: number;
  labels: 'main' | 'all' | 'none'; centreLines: boolean; outline: 'dashed' | 'solid'; frame: boolean;
  title: string | null; note: string | null; npthCross: boolean;
}

const FONTS = ['Arial, Helvetica, sans-serif', '"Times New Roman", Times, serif', '"Courier New", Courier, monospace', '"DejaVu Sans", Verdana, sans-serif'];
const TITLES = ['RECOMMENDED LAND PATTERN', 'RECOMMENDED PCB LAYOUT', 'PCB FOOTPRINT', 'Recommended Land Pattern', 'Suggested Pad Layout', 'RECOMMENDED SOLDER PAD LAYOUT', 'PCB LAYOUT (TOP VIEW)', 'Recommended PCB Layout (Top View)'];

/** A plain style: grey pads outlined, every pad named, millimetres. */
export const PLAIN: Style = {
  units: 'mm', brackets: false, pad: 'grey', grey: '#c8c8c8', stroke: 1, line: 0.8, font: 'Arial, Helvetica, sans-serif', size: 13, arrow: 'filled', turnText: true,
  minDecimals: 2, comma: false, countForm: 0, pitchForm: 0, diaForm: 0, labels: 'all', centreLines: false, outline: 'dashed', frame: false, title: null, note: 'UNIT: mm', npthCross: true,
};

function styleFor(r: Rand, units: Units): Style {
  const pad = pick(r, ['fill', 'fill', 'grey', 'outline', 'outline', 'hatch', 'hatch'] as const);
  return {
    units, brackets: units === 'mm' && r() < 0.1,
    pad, grey: pick(r, ['#808080', '#999999', '#c8c8c8']), stroke: pad === 'fill' ? pick(r, [0, 0, 1]) : pick(r, [1, 1.5, 2, 3]), line: pick(r, [0.6, 0.8, 1, 1.2]),
    font: pick(r, FONTS), size: Math.round(uni(r, 11, 19)), arrow: pick(r, ['filled', 'filled', 'filled', 'open', 'tick'] as const), turnText: r() < 0.6,
    minDecimals: r() < 0.7 ? 2 : 1, comma: r() < 0.04, countForm: Math.floor(r() * 4), pitchForm: Math.floor(r() * 6), diaForm: Math.floor(r() * 4),
    labels: pick(r, ['main', 'main', 'all', 'none'] as const), centreLines: r() < 0.4, outline: r() < 0.7 ? 'dashed' : 'solid', frame: r() < 0.35,
    title: r() < 0.75 ? pick(r, TITLES) : null, note: r() < 0.6 ? pick(r, units === 'inch' ? ['UNIT: INCH', 'Dimensions in inches', 'UNITS: INCHES'] : ['UNIT: mm', 'Unit: mm', 'DIMENSIONS IN MILLIMETRES', 'All dimensions in mm', 'UNIT: MM  TOLERANCE: ±0.05']) : null,
    npthCross: r() < 0.5,
  };
}

/** A length as the drawing writes it: millimetres to the decimals it needs (at least the style's), or inches to three. */
function num(mm: number, st: Style): string {
  const v = Math.abs(mm);
  let s: string;
  if (st.units === 'inch') s = (v / 25.4).toFixed(3);
  else {
    let d: number = st.minDecimals;
    while (d < 3 && Math.abs(+v.toFixed(d) - v) > 1e-6) d++;
    s = v.toFixed(d);
    if (st.brackets) s += ` [${(v / 25.4).toFixed(3)}]`;
  }
  return st.comma ? s.replace('.', ',') : s;
}

/** A dimension's text as the style writes it (and its count, pitch, diameter marks). */
export function dimText(d: Dim, st: Style): string {
  const v = d.t === 'lin' ? num(d.b - d.a, st) : d.slot ? `${num(d.d, st)}×${num(d.slot, st)}` : num(d.d, st);
  const n = d.count && d.count > 1 ? d.count : 0;
  const counted = (s: string) => (!n ? s : [`${n}X ${s}`, `${s} ${n}X`, `${n}x ${s}`, `${s} (${n}X)`][st.countForm]!);
  if (d.t === 'dia') {
    const hole = !/^pad/.test(d.what);
    const base = d.slot ? [`SLOT ${v}`, `${v} SLOT`, `${v}`, `Ø${v}`][st.diaForm]! : [`Ø${v}`, `Ø${v}`, `${v} DIA`, hole ? `Ø${v} ${d.plated ? 'PTH' : 'NPTH'}` : `Ø${v}`][st.diaForm]!;
    return counted(base);
  }
  if (d.pitch) return [`PITCH=${v}`, `P=${v}`, `${v} PITCH`, v, `e=${v}`, `${v} (PITCH)`][st.pitchForm]!;
  return counted(v);
}

/* ─── Drawing ──────────────────────────────────────────────────────────────────────── */

export type P = { x: number; y: number };
/** What a drawing is made of, in pixels (y down). A shape: a rectangle with corners rounded by rx (a circle or a slot when rx is half its smaller side). */
export type Prim =
  | { t: 'shape'; cx: number; cy: number; w: number; h: number; rx: number; fill: string | null; stroke: number; hatch: number; dash?: number[] }
  | { t: 'line'; a: P; b: P; w: number; dash?: number[] }
  | { t: 'arrow'; tip: P; u: P; len: number; style: Style['arrow']; w: number }
  | { t: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; turn: boolean; font: string };

export interface Drawing { width: number; height: number; scale: number; origin: P; prims: Prim[] }

const tw = (s: string, size: number) => 0.56 * size * s.length;

/** A pattern drawn: its pads, outline, labels and dimensions (their texts written), fitted to a picture `width` × `height` (ranges to pick from). */
export function drawPattern(p: Pick<Pattern, 'outline' | 'dims' | 'labels'>, land: LandPad[], st: Style, r: Rand, size: { width: [number, number]; height: [number, number] }): Drawing {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const grow = (x: number, y: number, w: number, h: number) => { x0 = Math.min(x0, x - w / 2); x1 = Math.max(x1, x + w / 2); y0 = Math.min(y0, y - h / 2); y1 = Math.max(y1, y + h / 2); };
  for (const q of land) grow(q.x, q.y, q.w, q.h);
  if (p.outline) grow(p.outline.x, p.outline.y, p.outline.w, p.outline.h);
  const lins = p.dims.filter((d): d is Extract<Dim, { t: 'lin' }> => d.t === 'lin');
  const bySide: Record<Side, typeof lins> = { top: [], bottom: [], left: [], right: [] };
  for (const d of lins) bySide[d.side].push(d);
  for (const s of Object.values(bySide)) s.sort((a, b) => Math.abs(a.b - a.a) - Math.abs(b.b - b.a));
  const gap = st.size + 12, labelRoom = st.labels === 'none' ? 4 : st.size + 8;
  const widest = (s: Side) => Math.max(0, ...bySide[s].map((d) => tw(d.text ?? '', st.size)));
  const tierGap = (s: Side) => (s === 'left' || s === 'right') && !st.turnText ? Math.max(gap, widest(s) + 16) : gap;
  const need = (s: Side) => 48 + labelRoom + bySide[s].length * tierGap(s);
  const titleH = st.title ? st.size * 2.4 : 16, noteH = st.note ? st.size * 2 : 0;
  let W = Math.round(uni(r, ...size.width)), H = Math.round(uni(r, ...size.height));
  const bw = Math.max(x1 - x0, 0.5), bh = Math.max(y1 - y0, 0.5);
  const fixedW = need('left') + need('right'), fixedH = need('top') + need('bottom') + titleH + noteH;
  let s = Math.min((W - fixedW) / bw, (H - fixedH) / bh, 400);
  // Room for the pads: no smaller than 30 px to the millimetre (the picture grows instead)
  if (!(s >= 30)) { s = 30; W = Math.max(W, Math.ceil(fixedW + bw * s)); H = Math.max(H, Math.ceil(fixedH + bh * s)); }
  const ox = need('left') + (W - fixedW - bw * s) / 2 - x0 * s;
  const oy = titleH + need('top') + (H - fixedH - bh * s) / 2 + y1 * s;
  const X = (v: number) => ox + v * s, Y = (v: number) => oy - v * s;
  const prims: Prim[] = [];
  const line = (a: P, b: P, w = st.line, dash?: number[]) => prims.push({ t: 'line', a, b, w, ...(dash ? { dash } : {}) });
  const text = (x: number, y: number, t: string, anchor: 'start' | 'middle' | 'end' = 'middle', turned = false, sz = st.size) => prims.push({ t: 'text', x, y, text: t, size: sz, anchor, turn: turned, font: st.font });
  const arrow = (tip: P, u: P) => prims.push({ t: 'arrow', tip, u, len: Math.max(7, Math.min(14, 0.8 * st.size)), style: st.arrow, w: st.line });
  if (st.frame) prims.push({ t: 'shape', cx: W / 2, cy: H / 2, w: W - 16, h: H - 16, rx: 0, fill: null, stroke: 1.5, hatch: 0 });
  if (st.title) text(W / 2, st.size * 1.6, st.title, 'middle', false, Math.round(st.size * 1.15));
  if (st.note) text(16 + (st.frame ? 8 : 0), H - st.size * 0.8 - (st.frame ? 8 : 0), st.note, 'start');
  if (st.centreLines) {
    line({ x: X(0), y: Y(y1) - 24 }, { x: X(0), y: Y(y0) + 24 }, st.line, [14, 3, 3, 3]);
    line({ x: X(x0) - 24, y: Y(0) }, { x: X(x1) + 24, y: Y(0) }, st.line, [14, 3, 3, 3]);
  }
  if (p.outline) { const o = p.outline; prims.push({ t: 'shape', cx: X(o.x), cy: Y(o.y), w: o.w * s, h: o.h * s, rx: 0, fill: null, stroke: st.line * 1.2, hatch: 0, ...(st.outline === 'dashed' ? { dash: [8, 5] } : {}) }); }
  const fill = st.pad === 'fill' ? '#000' : st.pad === 'grey' ? st.grey : null;
  const hatch = st.pad === 'hatch' ? Math.max(4, Math.round(st.size * 0.45)) : 0;
  for (const q of land) {
    const copper = q.plated && (q.w > q.hole + 1e-3 || q.h > (q.slot || q.hole) + 1e-3);
    const rx = q.shape === 'round' ? Math.min(q.w, q.h) * s / 2 : q.shape === 'roundrect' ? Math.min(q.w, q.h) * s * 0.25 : 0;
    if (copper) prims.push({ t: 'shape', cx: X(q.x), cy: Y(q.y), w: q.w * s, h: q.h * s, rx, fill, stroke: st.stroke || (fill === st.grey && st.grey === '#c8c8c8' ? 1 : 0), hatch });
    if (q.hole) {
      const hw = q.hole * s, hh = (q.slot || q.hole) * s;
      // A slot runs along the pad's longer side
      const [w, h] = q.w >= q.h ? [hh, hw] : [hw, hh];
      prims.push({ t: 'shape', cx: X(q.x), cy: Y(q.y), w, h, rx: Math.min(w, h) / 2, fill: copper ? '#fff' : null, stroke: copper ? st.line : Math.max(st.stroke, 1), hatch: 0 });
      if (!copper && st.npthCross) { line({ x: X(q.x) - w * 0.7, y: Y(q.y) }, { x: X(q.x) + w * 0.7, y: Y(q.y) }); line({ x: X(q.x), y: Y(q.y) - h * 0.7 }, { x: X(q.x), y: Y(q.y) + h * 0.7 }); }
    }
  }
  // Pin labels
  if (st.labels !== 'none') for (const l of p.labels) {
    if (st.labels === 'main' && !l.main) continue;
    const off = l.ext * s + 0.6 * st.size + 3;
    const sz = Math.round(st.size * (st.labels === 'all' ? 0.8 : 0.9));
    text(X(l.x) + l.out.x * (off + (l.out.x ? tw(l.text, sz) / 2 - 2 : 0)), Y(l.y) - l.out.y * off + 0.35 * sz, l.text, 'middle', false, sz);
  }
  // Dimensions, the smaller nearer the pattern
  const tier: Record<Side, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const d of lins) {
    const t = d.text ?? '', k = tier[d.side]++, len = Math.max(7, Math.min(14, 0.8 * st.size));
    const off = 18 + labelRoom + k * tierGap(d.side);
    if (d.axis === 'x') {
      const ly = d.side === 'top' ? Y(y1) - off : Y(y0) + off, sg = d.side === 'top' ? -1 : 1;
      const xa = X(Math.min(d.a, d.b)), xb = X(Math.max(d.a, d.b)), [fa, fb] = d.a <= d.b ? [d.ea, d.eb] : [d.eb, d.ea];
      for (const [x, f] of [[xa, Y(fa)], [xb, Y(fb)]] as const) if (Math.abs(f - ly) > 6) line({ x, y: f + sg * 3 }, { x, y: ly + sg * 5 }, st.line * 0.8);
      const roomy = xb - xa >= tw(t, st.size) + 2 * len + 6;
      if (xb - xa >= 2 * len + 4) { line({ x: xa, y: ly }, { x: xb, y: ly }); arrow({ x: xa, y: ly }, { x: -1, y: 0 }); arrow({ x: xb, y: ly }, { x: 1, y: 0 }); }
      else { line({ x: xa - len - 10, y: ly }, { x: xb + len + 10, y: ly }); arrow({ x: xa, y: ly }, { x: 1, y: 0 }); arrow({ x: xb, y: ly }, { x: -1, y: 0 }); }
      if (roomy) text((xa + xb) / 2, ly - 5, t);
      else text(xb + len + 14, ly - 4, t, 'start');
    } else {
      const lx = d.side === 'left' ? X(x0) - off : X(x1) + off, sg = d.side === 'left' ? -1 : 1;
      const ya = Y(Math.max(d.a, d.b)), yb = Y(Math.min(d.a, d.b)), [fa, fb] = d.a >= d.b ? [d.ea, d.eb] : [d.eb, d.ea];
      for (const [y, f] of [[ya, X(fa)], [yb, X(fb)]] as const) if (Math.abs(f - lx) > 6) line({ x: f + sg * 3, y }, { x: lx + sg * 5, y }, st.line * 0.8);
      const roomy = yb - ya >= (st.turnText ? tw(t, st.size) : st.size) + 2 * len + 6;
      if (yb - ya >= 2 * len + 4) { line({ x: lx, y: ya }, { x: lx, y: yb }); arrow({ x: lx, y: ya }, { x: 0, y: -1 }); arrow({ x: lx, y: yb }, { x: 0, y: 1 }); }
      else { line({ x: lx, y: ya - len - 10 }, { x: lx, y: yb + len + 10 }); arrow({ x: lx, y: ya }, { x: 0, y: 1 }); arrow({ x: lx, y: yb }, { x: 0, y: -1 }); }
      if (st.turnText) {
        // Turned text reads from below: beside the line on the side away from the pads
        const tx = d.side === 'left' ? lx - 5 : lx + st.size * 0.85 + 3;
        if (roomy) text(tx, (ya + yb) / 2, t, 'middle', true);
        else text(tx, yb + len + 14, t, 'end', true);
      } else text(lx + (d.side === 'left' ? -6 : 6), roomy ? (ya + yb) / 2 + 0.35 * st.size : yb + len + 10 + st.size, t, d.side === 'left' ? 'end' : 'start');
    }
  }
  // Diameters: a leader out of the hole, away from the middle
  for (const d of p.dims) {
    if (d.t !== 'dia') continue;
    const c = { x: X(d.x), y: Y(d.y) }, rad = (d.d * s) / 2, ux = d.x >= (x0 + x1) / 2 ? 0.7071 : -0.7071, uy = d.y >= (y0 + y1) / 2 ? -0.7071 : 0.7071;
    const a = { x: c.x + ux * rad, y: c.y + uy * rad }, b = { x: c.x + ux * (rad + 34), y: c.y + uy * (rad + 34) }, e = { x: b.x + Math.sign(ux) * 14, y: b.y };
    line(a, b); line(b, e); arrow(a, { x: -ux, y: -uy });
    text(e.x + Math.sign(ux) * 3, e.y + (uy < 0 ? -3 : st.size * 0.8), d.text ?? '', ux > 0 ? 'start' : 'end');
  }
  return fit({ width: W, height: H, scale: s, origin: { x: ox, y: oy }, prims });
}

/** The picture grown, and everything moved, so that nothing is cut off at its edges. */
function fit(d: Drawing): Drawing {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const at = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const p of d.prims) {
    if (p.t === 'shape') { if (p.w < d.width - 20) { at(p.cx - p.w / 2 - p.stroke, p.cy - p.h / 2 - p.stroke); at(p.cx + p.w / 2 + p.stroke, p.cy + p.h / 2 + p.stroke); } }
    else if (p.t === 'line') { at(p.a.x, p.a.y); at(p.b.x, p.b.y); }
    else if (p.t === 'arrow') { at(p.tip.x, p.tip.y); for (const w of arrowWings(p)) at(w.x, w.y); }
    else {
      const w = tw(p.text, p.size), lo = p.anchor === 'start' ? 0 : p.anchor === 'end' ? -w : -w / 2;
      if (p.turn) { at(p.x - p.size, p.y - lo - w); at(p.x + 2, p.y - lo); } else { at(p.x + lo, p.y - p.size); at(p.x + lo + w, p.y + 3); }
    }
  }
  const m = 10, dx = Math.max(0, m - x0), dy = Math.max(0, m - y0);
  const W = Math.ceil(Math.max(d.width + dx, x1 + dx + m)), H = Math.ceil(Math.max(d.height + dy, y1 + dy + m));
  if (!dx && !dy && W === d.width && H === d.height) return d;
  const mv = (q: P) => ({ x: q.x + dx, y: q.y + dy });
  const prims = d.prims.map((p): Prim => {
    if (p.t === 'shape') return p.w >= d.width - 20 ? { ...p, cx: W / 2, cy: H / 2, w: W - 16, h: H - 16 } : { ...p, cx: p.cx + dx, cy: p.cy + dy };
    if (p.t === 'line') return { ...p, a: mv(p.a), b: mv(p.b) };
    if (p.t === 'arrow') return { ...p, tip: mv(p.tip) };
    return { ...p, x: p.x + dx, y: p.y + dy };
  });
  return { width: W, height: H, scale: d.scale, origin: mv(d.origin), prims };
}

/* ─── Out: SVG, the lines a PDF would draw, a rough picture ────────────────────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v: number) => +v.toFixed(2);

/** The drawing as SVG. */
export function toSvg(d: Drawing): string {
  const hatches = new Set<number>();
  const body: string[] = [];
  for (const p of d.prims) {
    if (p.t === 'shape') {
      if (p.hatch) hatches.add(p.hatch);
      const fill = p.hatch ? `url(#h${p.hatch})` : p.fill ?? 'none';
      body.push(`<rect x="${n2(p.cx - p.w / 2)}" y="${n2(p.cy - p.h / 2)}" width="${n2(p.w)}" height="${n2(p.h)}"${p.rx ? ` rx="${n2(p.rx)}"` : ''} fill="${fill}"${p.stroke ? ` stroke="#000" stroke-width="${p.stroke}"` : ''}${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`);
    } else if (p.t === 'line') body.push(`<line x1="${n2(p.a.x)}" y1="${n2(p.a.y)}" x2="${n2(p.b.x)}" y2="${n2(p.b.y)}" stroke="#000" stroke-width="${p.w}"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`);
    else if (p.t === 'arrow') {
      const [a, b] = arrowWings(p);
      if (p.style === 'filled') body.push(`<polygon points="${n2(p.tip.x)},${n2(p.tip.y)} ${n2(a.x)},${n2(a.y)} ${n2(b.x)},${n2(b.y)}" fill="#000"/>`);
      else if (p.style === 'open') body.push(`<polyline points="${n2(a.x)},${n2(a.y)} ${n2(p.tip.x)},${n2(p.tip.y)} ${n2(b.x)},${n2(b.y)}" fill="none" stroke="#000" stroke-width="${p.w}"/>`);
      else { const t = tick(p); body.push(`<line x1="${n2(t[0].x)}" y1="${n2(t[0].y)}" x2="${n2(t[1].x)}" y2="${n2(t[1].y)}" stroke="#000" stroke-width="${p.w * 1.6}"/>`); }
    } else body.push(`<text x="${n2(p.x)}" y="${n2(p.y)}" font-family="${esc(p.font)}" font-size="${p.size}" text-anchor="${p.anchor}"${p.turn ? ` transform="rotate(-90 ${n2(p.x)} ${n2(p.y)})"` : ''}>${esc(p.text)}</text>`);
  }
  const defs = [...hatches].map((h) => `<pattern id="h${h}" patternUnits="userSpaceOnUse" width="${h}" height="${h}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${h}" stroke="#000" stroke-width="1"/></pattern>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}"><defs>${defs}</defs><rect width="${d.width}" height="${d.height}" fill="#fff"/>${body.join('')}</svg>`;
}

function arrowWings(a: Extract<Prim, { t: 'arrow' }>): [P, P] {
  const bx = a.tip.x - a.u.x * a.len, by = a.tip.y - a.u.y * a.len, wx = -a.u.y * a.len * 0.32, wy = a.u.x * a.len * 0.32;
  return [{ x: bx + wx, y: by + wy }, { x: bx - wx, y: by - wy }];
}
function tick(a: Extract<Prim, { t: 'arrow' }>): [P, P] {
  const k = a.len * 0.45, dx = (a.u.x - a.u.y) * k * 0.7071, dy = (a.u.y + a.u.x) * k * 0.7071;
  return [{ x: a.tip.x - dx, y: a.tip.y - dy }, { x: a.tip.x + dx, y: a.tip.y + dy }];
}

/** A shape's outline as a polygon (its rounded corners in short pieces). */
function outline(p: Extract<Prim, { t: 'shape' }>): P[] {
  const rx = Math.min(p.rx, p.w / 2, p.h / 2), out: P[] = [];
  const corners: [number, number, number][] = [[p.cx + p.w / 2 - rx, p.cy - p.h / 2 + rx, -90], [p.cx + p.w / 2 - rx, p.cy + p.h / 2 - rx, 0], [p.cx - p.w / 2 + rx, p.cy + p.h / 2 - rx, 90], [p.cx - p.w / 2 + rx, p.cy - p.h / 2 + rx, 180]];
  for (const [x, y, a0] of corners) {
    if (rx <= 0) { out.push({ x, y }); continue; }
    for (let i = 0; i <= 6; i++) { const a = ((a0 + (90 * i) / 6) * Math.PI) / 180; out.push({ x: x + rx * Math.cos(a), y: y + rx * Math.sin(a) }); }
  }
  return out;
}
function insideShape(p: { cx: number; cy: number; w: number; h: number; rx: number }, x: number, y: number): boolean {
  const dx = Math.abs(x - p.cx) - p.w / 2, dy = Math.abs(y - p.cy) - p.h / 2;
  if (dx > 0 || dy > 0) return false;
  const rx = Math.min(p.rx, p.w / 2, p.h / 2);
  if (rx <= 0) return true;
  const ex = dx + rx, ey = dy + rx;
  return ex <= 0 || ey <= 0 || ex * ex + ey * ey <= rx * rx;
}

/** The lines a PDF of the drawing draws (paths: outlines, hatching, lines, arrows; text isn't paths), in its pixels. */
export function segmentsOf(d: Drawing): Seg[] {
  const out: Seg[] = [];
  const add = (a: P, b: P) => { if (a.x !== b.x || a.y !== b.y) out.push({ a, b }); };
  for (const p of d.prims) {
    if (p.t === 'shape') {
      const o = outline(p);
      for (let i = 0; i < o.length; i++) add(o[i]!, o[(i + 1) % o.length]!);
      if (p.hatch) {
        // Lines at 45° across it, cut to its outline (one stretch each: the shape is convex)
        for (let c = Math.floor((p.cx - p.w / 2 + p.cy - p.h / 2) / p.hatch) * p.hatch; c <= p.cx + p.w / 2 + p.cy + p.h / 2; c += p.hatch) {
          let first: P | null = null, last: P | null = null;
          for (let x = p.cx - p.w / 2; x <= p.cx + p.w / 2; x += 0.5) { const y = c - x; if (insideShape(p, x, y)) { first ??= { x, y }; last = { x, y }; } }
          if (first && last) add(first, last);
        }
      }
    } else if (p.t === 'line') add(p.a, p.b);
    else if (p.t === 'arrow') {
      const [a, b] = arrowWings(p);
      if (p.style === 'filled') { add(p.tip, a); add(a, b); add(b, p.tip); } else if (p.style === 'open') { add(a, p.tip); add(p.tip, b); } else { const t = tick(p); add(t[0], t[1]); }
    }
  }
  return out;
}

/** A rough grey picture of the drawing (no browser): shapes, lines, arrows; each letter a small hollow box. */
export function rasterise(d: Drawing): Grey {
  const W = d.width, H = d.height, data = new Uint8Array(W * H).fill(255);
  const put = (x: number, y: number, v = 0) => { if (x >= 0 && y >= 0 && x < W && y < H) { const i = y * W + x; if (data[i]! > v) data[i] = v; } };
  const stamp = (x: number, y: number, w: number) => { const r = Math.max(0.5, w / 2); for (let i = Math.floor(x - r + 0.5); i < x + r; i++) for (let j = Math.floor(y - r + 0.5); j < y + r; j++) put(i, j); };
  const seg = (a: P, b: P, w: number, dash?: number[]) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L * 2));
    const period = dash ? dash.reduce((s, v) => s + v, 0) : 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (dash) { let at = (t * L) % period, on = true; for (const v of dash) { if (at < v) break; at -= v; on = !on; } if (!on) continue; }
      stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, w);
    }
  };
  for (const p of d.prims) {
    if (p.t === 'shape') {
      const sw = p.stroke / 2;
      const outer = { ...p, w: p.w + 2 * sw, h: p.h + 2 * sw, rx: p.rx ? p.rx + sw : 0 }, inner = { ...p, w: p.w - 2 * sw, h: p.h - 2 * sw, rx: Math.max(0, p.rx - sw) };
      const fv = !p.fill ? -1 : p.fill === '#fff' ? 255 : p.fill === '#000' ? 0 : parseInt(p.fill.slice(1, 3), 16);
      for (let y = Math.floor(p.cy - outer.h / 2); y <= p.cy + outer.h / 2; y++) for (let x = Math.floor(p.cx - outer.w / 2); x <= p.cx + outer.w / 2; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        if (!insideShape(outer, cx, cy)) continue;
        const inside = insideShape(p, cx, cy);
        if (p.stroke && !insideShape(inner, cx, cy)) { if (!p.dash || Math.floor((cx + cy) / 6) % 2 === 0) put(x, y); continue; }
        if (!inside) continue;
        if (fv >= 0) { const i = y * W + x; if (x >= 0 && y >= 0 && x < W && y < H) data[i] = fv; }
        if (p.hatch && Math.abs(((cx + cy) % p.hatch + p.hatch) % p.hatch) < 1) put(x, y);
      }
    } else if (p.t === 'line') seg(p.a, p.b, p.w, p.dash);
    else if (p.t === 'arrow') {
      const [a, b] = arrowWings(p);
      if (p.style === 'filled') {
        const xs = [p.tip.x, a.x, b.x], ys = [p.tip.y, a.y, b.y];
        const s = (u: P, v: P, x: number, y: number) => (v.x - u.x) * (y - u.y) - (v.y - u.y) * (x - u.x);
        for (let y = Math.floor(Math.min(...ys)); y <= Math.max(...ys); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.max(...xs); x++) {
          const k1 = s(p.tip, a, x + 0.5, y + 0.5), k2 = s(a, b, x + 0.5, y + 0.5), k3 = s(b, p.tip, x + 0.5, y + 0.5);
          if ((k1 >= 0 && k2 >= 0 && k3 >= 0) || (k1 <= 0 && k2 <= 0 && k3 <= 0)) put(x, y);
        }
      } else if (p.style === 'open') { seg(a, p.tip, p.w); seg(p.tip, b, p.w); } else { const t = tick(p); seg(t[0], t[1], p.w * 1.6); }
    } else {
      // Letters as hollow boxes (what makes text look like small shapes to the measuring)
      const cw = 0.56 * p.size, chH = 0.7 * p.size, total = cw * p.text.length;
      const start = p.anchor === 'middle' ? -total / 2 : p.anchor === 'end' ? -total : 0;
      [...p.text].forEach((ch, i) => {
        if (ch === ' ') return;
        const u0 = start + i * cw + 0.08 * p.size, u1 = u0 + cw - 0.16 * p.size;
        const box = (a: number, b: number, c: number, e: number) => {
          // (along, up) → pixels
          const at = (u: number, v: number): P => (p.turn ? { x: p.x - v, y: p.y - u } : { x: p.x + u, y: p.y - v });
          const q = [at(a, b), at(c, b), at(c, e), at(a, e)];
          for (let k = 0; k < 4; k++) seg(q[k]!, q[(k + 1) % 4]!, 1);
        };
        if (/[\w]/.test(ch)) box(u0, 0, u1, chH); else if (ch === '.' || ch === ',') box(u0, 0, u0 + 1.5, 1.5); else box(u0, chH * 0.4, u1, chH * 0.5);
      });
    }
  }
  return { width: W, height: H, data };
}

/** The page's text as pdf.js would read it: the drawing's words, top to bottom. */
export function textOf(d: Drawing): string {
  return d.prims.filter((p): p is Extract<Prim, { t: 'text' }> => p.t === 'text').sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.text).join('\n');
}

/* ─── A made-up drawing and its answer ─────────────────────────────────────────────── */

export interface Synth {
  seed: number; kind: SynthKind; pattern: Pattern; style: Style; drawing: Drawing;
  /** The package job's answer that reads the drawing right, and the read it cleans to. */
  answer: Record<string, unknown>; read: PackageRead;
  /** The job's input for the drawing (its picture added by whoever renders it). */
  input: PackageInput;
}

export interface SynthOptions {
  kind?: SynthKind;
  /** The picture's size ranges (px). */
  width?: [number, number]; height?: [number, number];
  /** Turned a quarter: never, always, or sometimes (default). */
  turned?: boolean;
}

/** A made-up land-pattern drawing from a seed, with the answer that reads it right. */
export function synth(seed: number, o: SynthOptions = {}): Synth {
  const r = rand(seed);
  const kind = o.kind ?? pick(r, SYNTH_KINDS);
  const units: Units = ['dual', 'quad', 'chip'].includes(kind) && r() < 0.15 ? 'inch' : 'mm';
  const q = (v: number) => (units === 'inch' ? fx(Math.round(v / 0.127) * 0.127) : fx(Math.round(v / 0.05) * 0.05));
  const p = GENS[kind]({ r, units, q });
  // From the middle of its pads
  let land = landOf(p);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const a of land) { x0 = Math.min(x0, a.x - a.w / 2); x1 = Math.max(x1, a.x + a.w / 2); y0 = Math.min(y0, a.y - a.h / 2); y1 = Math.max(y1, a.y + a.h / 2); }
  shift(p, -(x0 + x1) / 2, -(y0 + y1) / 2);
  if (o.turned ?? r() < 0.25) turn(p);
  land = landOf(p);
  const st = styleFor(r, units);
  for (const d of p.dims) d.text = dimText(d, st);
  const drawing = drawPattern(p, land, st, r, { width: o.width ?? [900, 1500], height: o.height ?? [700, 1150] });
  const answer: Record<string, unknown> = {
    family: p.family, standard: false, units, pins: p.pins, pinsPerSide: p.pinsPerSide, pitch: p.pitch,
    body: null, leads: null, thermalPad: null, ball: null, grid: p.grid,
    landPattern: { dimensions: p.dims.map((d) => `${d.text}: ${d.what}`), rows: p.rows, pads: p.pads, outline: p.outline },
    pages: [1], notes: '',
  };
  const input: PackageInput = {
    device: `SYN-${seed}`, pageCount: 1, pictures: [],
    variant: { partNumbers: [`SYN-${seed}`], package: p.package, pins: p.pins, leadForm: p.leadForm, body: { length: null, width: null, height: null }, pitch: p.pitch, thermalPad: p.thermalPad },
    pages: [{ page: 1, text: textOf(drawing), drawing: true }],
  };
  return { seed, kind, pattern: p, style: st, drawing, answer, read: PACKAGE.check(answer, input), input };
}

/* ─── Judging a read against the answer ────────────────────────────────────────────── */

/**
 * A read's pads against the right ones: paired by name (unnamed holes by place), lined up by the
 * pairs' median offset (where the pattern's middle is doesn't count), how many found, how many
 * more, the worst place and size errors (mm), how many are off by more than 0.02 mm, and whether
 * it is right (every pad, no more, none off).
 */
export function compareLand(truth: LandPad[], got: LandPad[]): { matched: number; total: number; extra: number; off: number; pos: number; size: number; ok: boolean } {
  const centre = (l: LandPad[]) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const a of l) { x0 = Math.min(x0, a.x - a.w / 2); x1 = Math.max(x1, a.x + a.w / 2); y0 = Math.min(y0, a.y - a.h / 2); y1 = Math.max(y1, a.y + a.h / 2); }
    return l.map((a) => ({ ...a, x: a.x - (x0 + x1) / 2, y: a.y - (y0 + y1) / 2 }));
  };
  const t = centre(truth), g = centre(got), used = new Set<number>(), pairs: [LandPad, LandPad][] = [];
  for (const a of t) {
    let best = -1, d = Infinity;
    g.forEach((b, j) => {
      if (used.has(j) || b.name !== a.name || (!a.name && Math.abs(b.hole - a.hole) > 0.05)) return;
      const e = Math.hypot(a.x - b.x, a.y - b.y);
      if (e < d) { d = e; best = j; }
    });
    if (best >= 0) { used.add(best); pairs.push([a, g[best]!]); }
  }
  const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[a.length >> 1]! : 0; };
  const dx = med(pairs.map(([a, b]) => b.x - a.x)), dy = med(pairs.map(([a, b]) => b.y - a.y));
  let pos = 0, size = 0, off = 0;
  for (const [a, b] of pairs) {
    const e = Math.hypot(b.x - dx - a.x, b.y - dy - a.y);
    pos = Math.max(pos, e); size = Math.max(size, Math.abs(b.w - a.w), Math.abs(b.h - a.h));
    if (e > 0.02 || Math.abs(b.w - a.w) > 0.02 || Math.abs(b.h - a.h) > 0.02) off++;
  }
  const extra = got.length - used.size;
  return { matched: pairs.length, total: truth.length, extra, off, pos: +pos.toFixed(4), size: +size.toFixed(4), ok: pairs.length === truth.length && !extra && !off };
}

/** A read as a model might get it wrong: each row moved as a whole (up to a quarter pitch), single pads moved up to `single` mm. */
export function perturb(read: PackageRead, r: Rand, single = 0.2): PackageRead {
  const land = read.land.map((p) => ({ ...p }));
  const inRow = new Set<number>();
  const step = Math.min(read.pitch ?? 1, 1) * 0.25;
  for (const row of rowsOf(land)) {
    const dx = uni(r, -step, step), dy = uni(r, -step, step);
    for (const j of row) { land[j]!.x = fx(land[j]!.x + dx); land[j]!.y = fx(land[j]!.y + dy); inRow.add(j); }
  }
  land.forEach((p, j) => { if (!inRow.has(j)) { p.x = fx(p.x + uni(r, -single, single)); p.y = fx(p.y + uni(r, -single, single)); } });
  return { ...read, land };
}
