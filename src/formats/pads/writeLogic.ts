/**
 * AD schematics as PADS Logic ASCII (PADS Logic V9.0's, in mils, Y up from the sheet's corner as
 * AD's). What goes where:
 *
 *  - Each SchDoc is a sheet (a multi-channel one a sheet for each channel, with that channel's
 *    designators and nets, as AD flattens it), on the PADS sheet size that holds AD's.
 *  - Parts are parts of part types (one per library reference and pin set), a gate per AD part,
 *    each gate drawn by a CAE decal made from the symbol as placed: its graphics, texts and pins
 *    (pin decals by length, dot and clock); hidden pins are the part type's signal pins on their
 *    nets. The designator and comment are the parts' Ref.Des. and Value labels where AD shows
 *    them, the parameters the parts' attributes, the footprint the PCB DECAL attribute.
 *  - Nets: every net is a signal named as the project compiles it (PADS joins nets by name across
 *    sheets, so the names keep AD's connectivity, whatever the net identifier scope); net-label
 *    names stay the nets' names, unnamed nets PADS's $$$ names. Wires run between pins, off-page
 *    references and tie dots, as PADS keeps them: wherever three or more meet, a wire ends free or
 *    a pin is joined to its net by a label alone, a tie dot.
 *  - Power ports are power and ground symbols ($PWR_SYMS, $GND_SYMS: bar, circle, arrow, wave,
 *    power, signal and earth ground); off-sheet connectors, ports and sheet entries off-page
 *    references ($OSR_SYMS), each labelled with its net.
 *  - Drawings (lines, polygons, rectangles, arcs, ellipses, Béziers, text frames, sheet symbols,
 *    bus entries) are line items, free text text; buses buses, named by their labels.
 *
 * Harnesses, images, directives and IEEE symbols have no PADS counterpart and are left out (the
 * warnings say which).
 */
import type { Vec2 } from '../../core/geom';
import { DIR_VECTORS, bagOf, deriveObject, isShown, ownedBy, type SchFont, type SchObject } from '../../model/sch';
import { compileProject, type SheetInput } from '../../model/compile';
import { symbolOf } from '../../model/makeLib';
import { entryPoint } from '../../model/schHierarchy';
import { parametersOf, specialResolver } from '../../model/schSpecial';
import { bezierPts } from '../../editors/sch/powerPort';
import { padsBytes, padsText } from './ascii';
import { keptPadsLogic } from './kept';

export interface PadsLogicInput {
  name: string;
  sheets: SheetInput[];
  /** Net Identifier Scope (HierarchyMode), as the project compiles. */
  hierarchyMode?: number;
  channelFormat?: string;
  channelSeparator?: string;
  /** Project parameters (for special strings). */
  variables?: { name: string; value: string }[];
}
export interface PadsLogicExport { text: string; bytes: Uint8Array; warnings: string[]; stats: { sheets: number; parts: number; nets: number; partTypes: number }; /** Written as PADS wrote it (a design read from PADS Logic, unchanged). */ kept?: boolean }

type P = { x: number; y: number };
/** AD's units as mils. */
const M = (c: number) => Math.round(c / 10000);
const MP = (p: Vec2): P => ({ x: M(p.x), y: M(p.y) });
const key = (p: P) => `${p.x},${p.y}`;
/** A name PADS takes (no spaces; dots part a pin from its part). */
const padsName = (s: string, max = 40) => (s.trim().replace(/[\s.]+/g, '_').replace(/[^\x21-\x7e\xa0-\xff]/g, '_') || '_').slice(0, max);
const pinNum = (s: string) => (s.trim().replace(/[\s.]+/g, '_') || '_').slice(0, 20);
const netName = (s: string) => (s.trim().replace(/\s+/g, '_').replace(/[\x00-\x20\x7f]/g, '_') || '_').slice(0, 47);
const textLine = (s: string) => s.replace(/[\r\n]+/g, ' ');
const FONT = '"Default Font"';

/** AD's justification (h = j % 3, v = j / 3) as PADS's bits: 1 right, 4 centre; 2 top, 8 middle. */
const just = (j: number) => { const h = j % 3, v = Math.floor(j / 3) % 3; return (h === 1 ? 4 : h === 2 ? 1 : 0) | (v === 1 ? 8 : v === 2 ? 2 : 0); };
/** AD's font (points) as PADS's text height (mils): 10 a point. */
const heightOf = (fonts: SchFont[], id: number) => Math.max(40, Math.round((fonts[id - 1]?.size ?? 10) * 10));
/** AD's line widths (smallest, small, medium, large) as PADS's. */
const wid = (w: number) => (w <= 0 ? 5 : Math.max(5, M(w)));

/** PADS's paper (mils): the smallest that holds AD's sheet. */
const PAPER: [string, number, number][] = [
  ['A', 11000, 8500], ['A4', 11690, 8270], ['B', 17000, 11000], ['A3', 16540, 11690], ['C', 22000, 17000], ['A2', 23390, 16540],
  ['D', 34000, 22000], ['A1', 33110, 23390], ['E', 44000, 34000], ['A0', 46810, 33110],
];
const STYLE_PAPER = ['A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'B', 'A', 'B', 'C', 'D', 'E'];

/** AD's electrical types as PADS's pin types. */
const PIN_TYPE = ['L', 'B', 'S', 'C', 'U', 'T', 'C', 'P'];

/* ── pieces (decal and line item graphics), points by `f` ── */

type F = (p: Vec2) => P;
const open = (pts: P[], w: number) => [`OPEN   ${pts.length}   ${w}  255`, ...pts.map((p) => `${p.x} ${p.y}`)];
const closed = (pts: P[], w: number, fill = false) => {
  const l = [...pts];
  if (l.length && key(l[0]!) !== key(l[l.length - 1]!)) l.push(l[0]!);
  return [`${fill ? 'COPCLS' : 'CLOSED'} ${l.length}   ${w}  255`, ...l.map((p) => `${p.x} ${p.y}`)];
};
const circle = (c: P, r: number, w: number, fill = false) => [`${fill ? 'COPCIR' : 'CIRCLE'} 2   ${w}  255`, `${c.x - r} ${c.y}`, `${c.x + r} ${c.y}`];
/** An arc: its start corner carries the start angle, the sweep (tenths, anticlockwise) and the circle's box. */
function arc(c: P, r: number, start: number, end: number, w: number): string[] {
  const sweep = ((end - start) % 360 + 360) % 360 || 360;
  const at = (a: number) => ({ x: Math.round(c.x + r * Math.cos((a * Math.PI) / 180)), y: Math.round(c.y + r * Math.sin((a * Math.PI) / 180)) });
  const s = at(start), e = at(start + sweep);
  return [`OPEN   2   ${w}  255`, `${s.x} ${s.y} ${Math.round(start * 10)} ${Math.round(sweep * 10)} ${c.x - r} ${c.y - r} ${c.x + r} ${c.y + r}`, `${e.x} ${e.y}`];
}
function ring(c: Vec2, rx: number, ry: number, a0 = 0, a1 = 360, n = 48): Vec2[] {
  const sweep = ((a1 - a0) % 360 + 360) % 360 || 360;
  const k = Math.max(6, Math.ceil((n * sweep) / 360));
  return Array.from({ length: k + 1 }, (_, i) => { const a = ((a0 + (sweep * i) / k) * Math.PI) / 180; return { x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) }; });
}

/** A graphic as pieces; null when it has none. */
function piecesOf(o: SchObject, f: F, r: number): string[][] | null {
  switch (o.kind) {
    case 'polyline': case 'wire': case 'bus':
      return o.pts.length >= 2 ? [open(o.pts.map(f), wid(o.width))] : null;
    case 'bezier': {
      const pts: Vec2[] = [];
      const t = (p: Vec2): [number, number] => [p.x, p.y];
      for (let i = 0; i + 3 < o.pts.length; i += 3) pts.push(...bezierPts([t(o.pts[i]!), t(o.pts[i + 1]!), t(o.pts[i + 2]!), t(o.pts[i + 3]!)]).slice(i ? 1 : 0).map(([x, y]) => ({ x, y })));
      return pts.length >= 2 ? [open(pts.map(f), wid(o.width))] : null;
    }
    case 'polygon': {
      if (o.pts.length < 3) return null;
      const out = [closed(o.pts.map(f), wid(o.width), o.solid && !o.transparent && o.fill === o.color)];
      return out;
    }
    case 'rect': {
      const a = f(o.a), b = f(o.b);
      return [closed([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], wid(o.width), o.solid && !o.transparent && o.fill === o.color)];
    }
    case 'ellipse': {
      if (Math.abs(o.rx - o.ry) < 2) return [circle(f(o.c), M(o.rx), wid(o.width), o.solid && !o.transparent && o.fill === o.color)];
      return [closed(ring(o.c, o.rx, o.ry).map(f), wid(o.width))];
    }
    case 'arc': {
      if (Math.abs(o.rx - o.ry) < 2) {
        const sweep = ((o.end - o.start) % 360 + 360) % 360;
        if (sweep < 1e-6 || sweep > 359.9) return [circle(f(o.c), M(o.rx), wid(o.width))];
        // Turned and mirrored frames turn the angles: by the points
        const s = f({ x: o.c.x + o.rx * Math.cos((o.start * Math.PI) / 180), y: o.c.y + o.rx * Math.sin((o.start * Math.PI) / 180) });
        const e = f({ x: o.c.x + o.rx * Math.cos((o.end * Math.PI) / 180), y: o.c.y + o.rx * Math.sin((o.end * Math.PI) / 180) });
        const c = f(o.c), ang = (p: P) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
        return r > 0 ? [arc(c, M(o.rx), ang(s), ang(e), wid(o.width))] : [arc(c, M(o.rx), ang(e), ang(s), wid(o.width))];
      }
      return [open(ring(o.c, o.rx, o.ry, o.start, o.end).map(f), wid(o.width))];
    }
    case 'piechart': return [closed([o.c, ...ring(o.c, o.r, o.r, o.start, o.end)].map(f), wid(o.width), o.solid)];
    case 'busentry': return [open([f(o.a), f(o.b)], wid(o.width))];
    default: return null;
  }
}

/* ── power, ground and off-page symbols ── */

interface Special { decal: string; type: '$PWR_SYMS' | '$GND_SYMS' | '$OSR_SYMS'; variant: number; /** Which way its body lies at angle 0 (AD's orientation). */ base: number; pieces: string[][] }
const SPECIAL: Record<string, Special> = {
  PWRBAR: { decal: 'PWRBAR', type: '$PWR_SYMS', variant: 0, base: 1, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: 100 }], 10), open([{ x: -100, y: 100 }, { x: 100, y: 100 }], 10)] },
  BUBBLE: { decal: 'BUBBLE', type: '$PWR_SYMS', variant: 1, base: 1, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: 60 }], 10), [`CIRCLE 2   10  255`, '0 60', '0 140']] },
  Y: { decal: 'Y', type: '$PWR_SYMS', variant: 2, base: 1, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: 140 }], 10), open([{ x: -50, y: 90 }, { x: 0, y: 140 }, { x: 50, y: 90 }], 10)] },
  PWRWAVE: { decal: 'PWRWAVE', type: '$PWR_SYMS', variant: 3, base: 1, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: 100 }], 10), open([{ x: -100, y: 100 }, { x: -50, y: 130 }, { x: 0, y: 100 }, { x: 50, y: 70 }, { x: 100, y: 100 }], 10)] },
  GND: { decal: 'GND', type: '$GND_SYMS', variant: 0, base: 3, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: -100 }], 10), open([{ x: -100, y: -100 }, { x: 100, y: -100 }], 10), open([{ x: -60, y: -140 }, { x: 60, y: -140 }], 10), open([{ x: -20, y: -180 }, { x: 20, y: -180 }], 10)] },
  AGND: { decal: 'AGND', type: '$GND_SYMS', variant: 1, base: 3, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: -100 }], 10), closed([{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 0, y: -200 }], 10)] },
  CHGND: { decal: 'CHGND', type: '$GND_SYMS', variant: 2, base: 3, pieces: [open([{ x: 0, y: 0 }, { x: 0, y: -100 }], 10), open([{ x: -100, y: -100 }, { x: 100, y: -100 }], 10),
    open([{ x: -100, y: -100 }, { x: -140, y: -160 }], 10), open([{ x: 0, y: -100 }, { x: -40, y: -160 }], 10), open([{ x: 100, y: -100 }, { x: 60, y: -160 }], 10)] },
  REFIN: { decal: 'REFIN', type: '$OSR_SYMS', variant: 0, base: 2, pieces: [open([{ x: 0, y: 0 }, { x: -100, y: 0 }, { x: -150, y: -50 }, { x: -300, y: -50 }, { x: -300, y: 50 }, { x: -150, y: 50 }, { x: -100, y: 0 }], 5)] },
  REFOUT: { decal: 'REFOUT', type: '$OSR_SYMS', variant: 1, base: 2, pieces: [open([{ x: 0, y: 0 }, { x: -50, y: 0 }, { x: -100, y: -50 }, { x: -250, y: -50 }, { x: -300, y: 0 }, { x: -250, y: 50 }, { x: -100, y: 50 }, { x: -50, y: 0 }], 5)] },
};
/** AD's power port styles: 0 circle, 1 arrow, 2 bar, 3 wave, 4 power ground, 5 signal ground, 6 earth, 7–10 GOST arrow, power ground, earth, bar. */
const POWER_DECAL = ['BUBBLE', 'Y', 'PWRBAR', 'PWRWAVE', 'GND', 'AGND', 'CHGND', 'Y', 'GND', 'CHGND', 'PWRBAR'];

function specialDecal(s: Special): string[] {
  const texts = 0;
  return [`${s.decal.padEnd(16)} 33500 33180 100 10 100 10 2 ${s.pieces.length} ${texts} 1 ${s.type === '$OSR_SYMS' ? 24 : 26} 0`, stamp(), FONT, FONT,
    `0 150 0 0 100 10 ${FONT}`, 'REF-DES', `0 100 0 0 100 10 ${FONT}`, 'PART-TYPE', ...s.pieces.flat(), 'T0     0     0 0 0 0 0 0 0 0 0 8 ', 'P0 0 0 0 0 0 0 0 128', ''];
}
function specialType(type: Special['type']): string[] {
  const list = Object.values(SPECIAL).filter((s) => s.type === type).sort((a, b) => a.variant - b.variant);
  const kw = type === '$PWR_SYMS' ? 'PWR' : type === '$GND_SYMS' ? 'GND' : 'OFF';
  return [`${type} UND  0   0   2     0`, stamp(), `${kw} ${list.length}`,
    ...list.map((s) => (type === '$OSR_SYMS' ? `${s.decal} ${s.decal === 'REFOUT' ? 'L' : 'S'} ` : `${s.decal} ${type === '$GND_SYMS' ? 'G' : 'P'} ${type === '$GND_SYMS' ? s.decal : 'VCC'}`)), ''];
}
let STAMP = '';
const stamp = () => `TIMESTAMP ${STAMP}`;

/* ── pin decals ── */

interface PinDecal { name: string; len: number; dot: boolean; clock: boolean }
function pinDecal(d: PinDecal): string[] {
  const L = d.len, pieces: string[][] = [];
  if (d.dot) { pieces.push(open([{ x: 0, y: 0 }, { x: L - 50, y: 0 }], 10)); pieces.push([`CIRCLE 2   10  255`, `${L - 50} 0`, `${L} 0`]); }
  else pieces.push(open([{ x: 0, y: 0 }, { x: L, y: 0 }], 10));
  if (d.clock) pieces.push(open([{ x: L, y: 30 }, { x: L + 60, y: 0 }, { x: L, y: -30 }], 10));
  return [`${d.name.padEnd(16)} 34000 34000 100 10 100 10 2 ${pieces.length} 0 0 0 1`, stamp(), FONT, FONT,
    `${Math.max(10, L - 60)} 20 0 1 100 10 ${FONT}`, 'REF-DES', `${L + (d.clock ? 90 : 30)} 0 0 8 100 10 ${FONT}`, 'PART-TYPE', ...pieces.flat(), ''];
}

/* ── the export ── */

interface Gate { decal: string; pins: { num: string; type: string; name: string }[] }
interface PartType { name: string; category: string; gates: Gate[]; sigPins: { num: string; net: string }[]; flags: number }

export function exportPadsLogic(input: PadsLogicInput): PadsLogicExport {
  // A design read from PADS Logic and still what the import made of it: the file PADS wrote (kept.ts)
  const kept = keptPadsLogic(input.sheets.map((s) => s.doc));
  if (kept) return { text: padsText(kept), bytes: kept, warnings: [], stats: { sheets: input.sheets.length, parts: 0, nets: 0, partTypes: 0 }, kept: true };
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  STAMP = `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}.${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;

  // The nets as the project compiles them: each object's net
  const sheets = input.sheets;
  const c = compileProject(sheets, { scope: input.hierarchyMode ?? 0, channelFormat: input.channelFormat, channelSeparator: input.channelSeparator, checkBounds: false });
  const used = new Set<string>();
  const nameOf = new Map<(typeof c.nets)[number], string>();
  let auto = 0;
  // An unnamed net on a port, an off-sheet connector or a sheet entry: named after it (PADS's
  // off-page references show their nets' names)
  const docOf = new Map(sheets.map((s) => [s.name, s.doc]));
  const portName = (n: (typeof c.nets)[number]): string | null => {
    for (const r of n.refs) {
      const o = docOf.get(r.sheet)?.objects[r.index];
      if (o?.kind === 'port' || o?.kind === 'sheetentry') return o.name;
      if (o?.kind === 'power' && o.crossSheet) return o.text;
    }
    return null;
  };
  for (const n of c.nets) {
    const multi = new Set(n.sheets).size > 1;
    const pn = n.auto ? portName(n) : null;
    const taken = (x: string) => used.has(x.toUpperCase()) || c.nets.some((m) => m !== n && !m.auto && netName(m.name).toUpperCase() === x.toUpperCase());
    let nm = pn && !taken(netName(pn)) ? netName(pn) : n.auto && !multi ? `$$$${++auto}` : netName(n.name);
    for (let k = 2; used.has(nm.toUpperCase()); k++) nm = `${netName(n.name).slice(0, 44)}_${k}`;
    used.add(nm.toUpperCase());
    nameOf.set(n, nm);
  }
  // Each object's net and part, in each instance of its sheet ("instance|sheet:index"; a sheet used
  // more than once, multi-channel, is written once for each channel, as AD flattens it)
  const key2 = (inst: string | undefined, r: { sheet: string; index: number }) => `${inst ?? r.sheet}|${r.sheet}:${r.index}`;
  const pagesOf = new Map<string, string[]>();   // sheet → its instances, in order
  const sawInst = (sheet: string, inst: string | undefined) => { const l = pagesOf.get(sheet) ?? []; const k = inst ?? sheet; if (!l.includes(k)) l.push(k); pagesOf.set(sheet, l); };
  const netAt = new Map<string, string>();
  for (const n of c.nets) {
    for (const ir of n.instRefs ?? n.refs.map((ref) => ({ ref, inst: ref.sheet }))) { sawInst(ir.ref.sheet, ir.inst); const k = key2(ir.inst, ir.ref); if (!netAt.has(k)) netAt.set(k, nameOf.get(n)!); }
    for (const p of n.pins) { sawInst(p.ref.sheet, p.inst); const k = key2(p.inst, p.ref); if (!netAt.has(k)) netAt.set(k, nameOf.get(n)!); }
  }
  const multiPin = new Set(c.nets.filter((n) => n.pins.length > 1 || !n.auto).map((n) => nameOf.get(n)!));
  const compAt = new Map<string, (typeof c.components)[number]>();
  const roomOf = new Map<string, string>();
  for (const comp of c.components) comp.refs.forEach((r, i) => {
    // Each part's own instance (a package's parts may lie on other sheets)
    const inst = comp.refInsts?.[i] || comp.inst;
    sawInst(r.sheet, inst);
    const k = key2(inst, r);
    if (!compAt.has(k)) compAt.set(k, comp);
    if (comp.channel && inst) roomOf.set(inst, comp.channel);
  });
  // The pages: each sheet once per instance
  const pages: { s: SheetInput; inst: string; title: string }[] = [];
  for (const s of sheets) {
    const list = pagesOf.get(s.name) ?? [s.name];
    const stem = s.name.replace(/\.schdoc$/i, '');
    list.forEach((inst, k) => pages.push({ s, inst, title: list.length > 1 ? `${stem}_${roomOf.get(inst) ?? k + 1}` : stem }));
    if (list.length > 1) warnings.push(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} sheets with each channel's designators and nets`);
  }

  // The variables special strings read
  const vars = new Map((input.variables ?? []).map((v) => [v.name.toUpperCase(), v.value]));

  const partTypes = new Map<string, PartType>();     // by library reference and pins
  const typeNames = new Set<string>();
  const decals = new Map<string, string[]>();         // name → its lines
  const decalNames = new Set<string>([...Object.keys(SPECIAL)]);
  const pinDecals = new Map<string, PinDecal>();
  const decalPins = new Map<string, Set<string>>();   // a gate's decal → its pin decals
  let nParts = 0;
  // References: PADS's names for the designators, each designator its own (long ones cut, kept apart)
  const bases = new Map<string, string>(), baseTaken = new Set<string>();
  const refBase = (des: string): string => {
    let b = bases.get(des);
    if (b) return b;
    const d0 = des.split('\u0000')[0]!.replace(/\?/g, '');
    b = padsName(d0 || 'U', 37);
    for (let k = 2; baseTaken.has(b.toUpperCase()); k++) b = `${padsName(d0 || 'U', 33)}_${k}`;
    baseTaken.add(b.toUpperCase());
    bases.set(des, b);
    return b;
  };
  const allNets = new Set<string>();

  const out: string[] = [];
  const w = (...l: (string | string[])[]) => { for (const x of l) if (Array.isArray(x)) for (const y of x) out.push(y); else out.push(x); };

  // Sheet size: the largest sheet's
  let paper = 'A';
  for (const s of sheets) {
    const sh = s.doc.sheet, wm = M(sh.width), hm = M(sh.height);
    const named = STYLE_PAPER[sh.style] ?? '';
    const fit = PAPER.find(([n, pw, ph]) => (named ? n === named : true) && pw >= wm && ph >= hm) ?? PAPER.find(([, pw, ph]) => pw >= wm && ph >= hm) ?? PAPER[PAPER.length - 1]!;
    if (PAPER.findIndex((p) => p[0] === fit[0]) > PAPER.findIndex((p) => p[0] === paper)) paper = fit[0];
  }

  w(`*PADS-LOGIC-V9.0* DESIGN EXPORT FILE FROM KONIUM DESIGNER`, `*SCH*        GENERAL PARAMETERS OF THE SCHEMATIC DESIGN`, '',
    'CUR SHEET    0              Current Active Sheet', 'USERGRID     100    10      Design and Label/Text grid settings', 'LINEWIDTH    10             Width items will be created with',
    'CONNWIDTH    10             Width used to plot connections', 'BUSWIDTH     25             Width used to plot buses', 'BUSANGLE     25             Angle used when plotting buses',
    'PINNAMESIZE  100    10      Height and LineWidth used by pin names', 'TEXTSIZE     100    10      Height and LineWidth text will be created width',
    'TIEDOTSIZE   50             Diameter of tiedot point', 'REFNAMESIZE  100    10      Height and LineWidth used by part ref. names',
    'PARTNAMESIZE 100    10      Height and LineWidth used by part type names', 'PINNOSIZE    100    10      Height and LineWidth used by pin numbers',
    'NETNAMESIZE  100    10      Height and LineWidth used by net names', `SHEET SIZE   ${paper}`, 'UNITS        0              Rules units type',
    `JOBNAME      ${padsName(input.name, 60)}`, '');

  // Fields: the first sheet's document parameters PADS has fields for
  const first = sheets[0]?.doc;
  if (first) {
    const dp = parametersOf(first, 'document');
    const FIELDS: [string, string][] = [['Title', 'TITLE'], ['Drawn By', 'DRAWNBY'], ['Checked By', 'CHECKEDBY'], ['Company Name', 'COMPANYNAME'], ['Drawing Number', 'DOCUMENTNUMBER'], ['Revision', 'REVISION'], ['Drawn Date', 'DATE']];
    w('*FIELDS*    USER FIELDS', '', ...FIELDS.map(([n, k]) => `"${n}" ${textLine(dp.get(k) ?? vars.get(k) ?? '')}`), '');
  }

  pages.forEach(({ s, inst: page, title }, si) => {
    const doc = s.doc, objs = doc.objects;
    const fonts = doc.sheet.fonts;
    const owned = ownedBy(doc);
    const ref = (o: SchObject) => `${page}|${s.name}:${o.index}`;
    const resolve = specialResolver(doc, { docName: s.name, projectName: input.name, projectParams: vars }, true);
    const special = (t: string, owner = -1) => {
      const k = t.trim().toUpperCase();
      if (k === '=SHEETNUMBER') return String(si + 1);
      if (k === '=SHEETTOTAL') return String(pages.length);
      return resolve(t, owner);
    };

    const texts: string[] = [], lineItems: string[] = [], parts: string[] = [];
    const usedDecals = new Set<string>(), usedTypes = new Set<string>();
    let drw = 0;
    const item = (pieces: string[][], txt: string[][] = []) => {
      if (!pieces.length && !txt.length) return;
      lineItems.push(`DRW${++drw}`.padEnd(16) + ` LINES    0      0      ${pieces.length}  ${txt.length}`, ...pieces.flat(), ...txt.flat());
    };
    const textEntry = (at: P, orient: number, j: number, h: number, t: string, angleDeg = false) => [`${at.x} ${at.y} ${angleDeg ? (orient & 3) * 90 : orient & 3} ${just(j)} ${h} ${Math.max(5, Math.round(h / 10))} 0 ${FONT}`, textLine(t)];

    /* Free graphics and text */
    const ident: F = MP;
    for (const o of objs) {
      if (o.owner >= 0 && objs[o.owner]?.kind === 'component') continue;
      if (!isShown(doc, o)) continue;
      switch (o.kind) {
        case 'text':
          if (o.role === 'label' && o.owner < 0 && o.text.trim()) texts.push(...textEntry(MP(o.at), o.orient, o.justify, heightOf(fonts, o.font), special(o.text)));
          break;
        case 'polyline': case 'bezier': case 'polygon': case 'rect': case 'ellipse': case 'arc': case 'piechart': case 'busentry': {
          const pc = piecesOf(o, ident, 1);
          if (pc) item(pc);
          break;
        }
        case 'textframe': {
          const a = MP(o.a), b = MP(o.b);
          const pcs = o.border || o.solid ? [closed([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], wid(o.width))] : [];
          const h = heightOf(fonts, o.font), top = Math.max(a.y, b.y), left = Math.min(a.x, b.x) + M(o.margin);
          // AD wraps a frame's text at its width, a line an em apart: here by half an em a character [est]
          const fnt = fonts[o.font - 1] ?? fonts[0];
          const em = ((fnt?.size ?? 10) * 5) / (/times|serif/i.test(fnt?.name ?? '') && !/sans/i.test(fnt?.name ?? '') ? 0.662 : 0.716);
          const room = Math.abs(b.x - a.x) - 2 * M(o.margin), per = Math.max(4, Math.floor(room / (em * 0.5)));
          const lines: string[] = [];
          for (const para of o.text.split(/~1|\r?\n/)) {
            if (!o.wrap || para.length <= per) { lines.push(para); continue; }
            let line = '';
            for (const word of para.split(' ')) {
              if (line && (line + ' ' + word).length > per) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
            }
            lines.push(line);
          }
          while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
          item(pcs, lines.map((l, i) => textEntry({ x: left, y: Math.round(top - M(o.margin) - em * (i + 0.85)) }, 0, 0, h, l)));
          break;
        }
        case 'sheetsymbol': {
          const a = MP(o.at), b = { x: a.x + M(o.w), y: a.y - M(o.h) };
          const txt = (owned.get(o.index) ?? []).filter((k) => k.kind === 'text' && !k.hidden && k.text.trim()).map((k) => k as SchObject & { kind: 'text' })
            .map((k) => textEntry(MP(k.at), k.orient, k.justify, heightOf(fonts, k.font), k.text));
          item([closed([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], wid(o.width))], txt);
          break;
        }
        case 'image': warnOnce(`${s.name}: images left out`); break;
        case 'harness': case 'harnessentry': case 'signalharness': warnOnce(`${s.name}: harnesses left out (their nets are kept)`); break;
        case 'ieee': warnOnce(`${s.name}: IEEE symbols left out`); break;
        default:
      }
    }

    /* Parts */
    const terminals = new Map<string, { id: string; net: string; at: P }[]>();
    const addTerminal = (at: P, id: string, net: string) => { const k = key(at); if (!terminals.has(k)) terminals.set(k, []); terminals.get(k)!.push({ id, net, at }); };
    const designators = new Set<string>();
    for (const o of objs) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const kids = (owned.get(o.index) ?? []).filter((k) => isShown(doc, k));
      const pinsHere = kids.filter((k): k is SchObject & { kind: 'pin' } => k.kind === 'pin');
      const compiled = compAt.get(ref(o));
      const des0 = (compiled?.designator || o.designator) || 'U?';
      const made = symbolOf(doc, o.index);
      const mobjs = made.bags.map((b, i) => (i > 0 ? deriveObject(b, i) : null)).filter((x): x is SchObject => !!x);
      const gates = Math.max(1, o.partCount - 1);
      // The part type: by library reference and pins
      const mpins = mobjs.filter((x): x is SchObject & { kind: 'pin' } => x.kind === 'pin' && x.ownerDisplayMode === 0);
      const sig = mpins.map((p) => `${p.designator}@${p.ownerPartId}:${p.at.x},${p.at.y},${p.orient},${p.length},${p.hidden ? 1 : 0}`).sort().join('|');
      const tkey = `${o.libRef}\u0000${sig}`;
      let pt = partTypes.get(tkey);
      if (!pt) {
        // Its name: no $ first (PADS's own symbols' types), no @ (PADS's type@decal)
        const base0 = (o.libRef || 'PART').replace(/@/g, '_').replace(/^\$/, '_');
        let nm = padsName(base0);
        for (let k = 2; typeNames.has(nm.toUpperCase()); k++) nm = `${padsName(base0, 36)}_${k}`;
        typeNames.add(nm.toUpperCase());
        const prefix = des0.replace(/[\d?].*$/, '').toUpperCase();
        const category = ({ R: 'RES', RN: 'RES', C: 'CAP', L: 'IND', D: 'DIO', LED: 'DIO', Q: 'TRX', T: 'TRX', U: 'ICS', IC: 'ICS' } as Record<string, string>)[prefix] ?? 'UND';
        pt = { name: nm, category, gates: [], sigPins: [], flags: 2 };
        const allPins = mpins.filter((p) => !p.hidden);
        if (allPins.length && allPins.every((p) => !p.showName || !p.name.trim() || p.name === p.designator)) pt.flags |= 8;
        if (allPins.length && allPins.every((p) => !p.showDesignator)) pt.flags |= 16;
        const hidden = mpins.filter((p) => p.hidden);
        const sigSeen = new Set<string>();
        for (const p of hidden) {
          const b = made.bags[p.index];
          const hn = b?.get('HIDDENNETNAME')?.trim() ?? '';
          if (!hn) continue;   // connected to nothing (AD's hidden pin with no net to connect to)
          // The net as compiled (a hidden pin's net may go by another name it has)
          const onSheet = (owned.get(o.index) ?? []).find((k) => k.kind === 'pin' && k.hidden && k.designator === p.designator);
          const net = (onSheet && netAt.get(ref(onSheet))) || netName(hn);
          const num = pinNum(p.designator);
          if (!sigSeen.has(num) && net !== '_') { sigSeen.add(num); pt.sigPins.push({ num, net }); }
        }
        for (let g = 0; g < gates; g++) {
          let dn = gates > 1 ? `${nm.slice(0, 37)}-${String.fromCharCode(65 + (g % 26))}` : nm;
          for (let k = 2; decalNames.has(dn.toUpperCase()); k++) dn = `${nm.slice(0, 34)}_${k}${gates > 1 ? `-${String.fromCharCode(65 + (g % 26))}` : ''}`;
          decalNames.add(dn.toUpperCase());
          const mine = mobjs.filter((x) => (x.ownerPartId === g + 1 || x.ownerPartId <= 0) && (x.ownerDisplayMode ?? 0) === 0);
          // Its pins (pins every part shows, the first gate's: PADS's pins are each one gate's)
          const gp = mine.filter((x): x is SchObject & { kind: 'pin' } => x.kind === 'pin' && !x.hidden && (x.ownerPartId === g + 1 || (g === 0 && x.ownerPartId <= 0)));
          pt.gates.push({ decal: dn, pins: gp.map((p) => ({ num: pinNum(p.designator), type: PIN_TYPE[p.electrical] ?? 'U', name: p.name.trim() ? padsName(p.name, 40) : '' })) });
          // The decal
          const pieces: string[][] = [], dtexts: string[] = [], tlines: string[] = [];
          for (const x of mine) {
            if (x.kind === 'pin' || (x.kind === 'text' && x.role !== 'label')) continue;
            if (x.kind === 'text') { if (x.text.trim() && !x.hidden) dtexts.push(`${M(x.at.x)} ${M(x.at.y)} ${(x.orient & 3) * 90} ${just(x.justify)} ${heightOf(fonts, x.font)} 10`, textLine(x.text)); continue; }
            const pc = piecesOf(x, MP, 1);
            if (pc) pieces.push(...pc);
          }
          for (const p of gp) {
            const dv = DIR_VECTORS[p.orient]!, L = M(p.length);
            const hot = MP({ x: p.at.x + dv.x * p.length, y: p.at.y + dv.y * p.length });
            const dot = p.symbols.outerEdge === 1, clock = p.symbols.innerEdge === 3;
            const len = Math.max(10, L);
            const pdn = `${clock ? 'PCLK' : 'PIN'}${len === 200 ? '' : len}${dot ? 'B' : ''}`;
            if (!pinDecals.has(pdn)) pinDecals.set(pdn, { name: pdn, len, dot, clock });
            if (!decalPins.has(dn)) decalPins.set(dn, new Set());
            decalPins.get(dn)!.add(pdn);
            // Hot end to body: along +x side 0, −x side 1, +y angle 90 side 0, −y angle 90 side 2
            const bx = -dv.x, by = -dv.y;
            const [angle, side] = bx > 0 ? [0, 0] : bx < 0 ? [0, 1] : by > 0 ? [90, 0] : [90, 2];
            tlines.push(`T${hot.x} ${hot.y} ${angle} ${side} ${Math.max(10, len - 60)} 20 0 1 ${len + (clock ? 90 : 30)} 0 0 8 ${pdn}`,
              `P-520 0 0 1 -80 0 0 1 ${p.showName && p.name.trim() && p.name !== p.designator ? 0 : 128}`);
          }
          const label = (role: string, nm2?: string) => mine.find((x) => x.kind === 'text' && x.role === role && (!nm2 || made.bags[x.index]?.get('NAME')?.toUpperCase() === nm2)) as (SchObject & { kind: 'text' }) | undefined;
          const dl = label('designator'), cl = label('parameter', 'COMMENT');
          const attr = (t: (SchObject & { kind: 'text' }) | undefined, dflt: P) => t ? `${M(t.at.x)} ${M(t.at.y)} ${(t.orient & 3) * 90} ${just(t.justify)} ${heightOf(fonts, t.font)} 10 ${FONT}` : `${dflt.x} ${dflt.y} 0 0 100 10 ${FONT}`;
          decals.set(dn, [`${dn.padEnd(16)} 32000 32000 100 10 100 10 2 ${pieces.length} ${dtexts.length / 2} ${gp.length} ${pt.flags} 0`, stamp(), FONT, FONT,
            attr(dl, { x: 0, y: 100 }), 'REF-DES', attr(cl, { x: 0, y: -100 }), 'PART-TYPE', ...pieces.flat(), ...dtexts, ...tlines, '']);
        }
        partTypes.set(tkey, pt);
      }
      usedTypes.add(tkey);
      const g = Math.max(0, Math.min(gates - 1, o.partId - 1));
      const gate = pt.gates[g]!;
      usedDecals.add(gate.decal);
      for (const pd of decalPins.get(gate.decal) ?? []) usedDecals.add(pd);
      // Its reference: the designator, a gate's letter after it
      // (an unannotated part, U?, a reference of its own)
      const base = des0.includes('?') ? refBase(`${des0}\u0000${ref(o)}`) : refBase(des0);
      const refName = gates > 1 ? `${base}-${String.fromCharCode(65 + (g % 26))}` : base;
      if (designators.has(refName.toUpperCase())) warnOnce(`${s.name}: ${refName} more than once`);
      designators.add(refName.toUpperCase());
      nParts++;
      // Placement: AD's R(o)·Mx^m is PADS's turned by −o after a left-to-right mirror
      const angle = o.mirrored ? ((4 - (o.orient & 3)) % 4) * 90 : (o.orient & 3) * 90;
      const at = MP(o.at);
      // Labels (offsets on the sheet [est]) and attributes
      const kidText = (role: string, nm2?: string) => kids.find((k) => k.kind === 'text' && k.role === role && (!nm2 || bagOf(doc, k)?.get('NAME')?.toUpperCase() === nm2)) as (SchObject & { kind: 'text' }) | undefined;
      const dt = kidText('designator'), ct = kidText('parameter', 'COMMENT');
      const labelLine = (t: (SchObject & { kind: 'text' }) | undefined, hidden: boolean) => {
        const p = t ? MP(t.at) : at;
        return `${p.x - at.x} ${p.y - at.y} ${t ? (t.orient & 3) * 90 : 0} ${t ? just(t.justify) : 0} ${t ? heightOf(fonts, t.font) : 100} 10 ${hidden ? 8 : 0} ${FONT}`;
      };
      // The comment as PADS's Value, or its Comment where the part has a Value of its own that differs
      const comment = special(ct?.text ?? compiled?.comment ?? '', o.index);
      const params = (owned.get(o.index) ?? []).filter((k): k is SchObject & { kind: 'text' } => k.kind === 'text' && k.role === 'parameter');
      const pv = params.find((k) => /^value$/i.test(bagOf(doc, k)?.get('NAME') ?? ''));
      const asValue = !pv || special(pv.text, o.index) === comment;
      const values: [string, string][] = asValue ? [['Value', comment]] : [['Comment', comment]];
      const labels: string[] = [labelLine(dt, !dt || dt.hidden), 'REF-DES', labelLine(ct, true), 'PART-TYPE', labelLine(ct, !ct || ct.hidden || !comment), asValue ? 'Value' : 'Comment'];
      const seen = new Set(['COMMENT', 'PCB DECAL', 'DESCRIPTION']);
      for (const prm of params) {
        const n = (bagOf(doc, prm)?.get('NAME') ?? '').replace(/"/g, "'");
        if (!n || seen.has(n.toUpperCase()) || (asValue && /^value$/i.test(n))) continue;
        seen.add(n.toUpperCase());
        values.push([n, special(prm.text, o.index)]);
        if (isShown(doc, prm)) labels.push(labelLine(prm, false), n);
      }
      if (compiled?.description) values.push(['Description', compiled.description]);
      if (compiled?.footprint) values.push(['PCB DECAL', padsName(compiled.footprint)]);
      const npins = gate.pins.length;
      parts.push(`${refName.padEnd(12)} ${pt.name.padEnd(16)} ${at.x} ${at.y} ${angle} ${o.mirrored ? 1 : 0} 100 10 100 10 ${labels.length / 2} ${values.length} ${npins} 0 0 ${pt.flags}`,
        FONT, FONT, ...labels, ...values.map(([k, v]) => `"${k}" ${textLine(v)}`),
        ...gate.pins.map((_, i) => `${i} 140 20 0 1`), '');
      // Its pins' ends: what wires join
      for (const p of pinsHere) {
        if (p.hidden) continue;
        const dv = DIR_VECTORS[p.orient]!;
        const hot = MP({ x: p.at.x + dv.x * p.length, y: p.at.y + dv.y * p.length });
        addTerminal(hot, `${p.ownerPartId <= 0 && gates > 1 ? `${base}-A` : refName}.${pinNum(p.designator)}`, netAt.get(ref(p)) ?? '');
      }
    }

    /* Power ports, off-sheet connectors, ports and sheet entries: off-page references */
    const opcs: string[] = [], netNames: string[] = [];
    let nOpc = 0;
    const wireEnds = new Set<string>();
    for (const o of objs) if (o.kind === 'wire' && isShown(doc, o)) for (const p of [o.pts[0], o.pts[o.pts.length - 1]]) if (p) wireEnds.add(key(MP(p)));
    const opc = (at: P, net: string, sp: Special, orient: number, label: P, j: number) => {
      const id = `@@@O${nOpc++}`;
      const angle = (((orient - sp.base) % 4) + 4) % 4 * 90;
      usedDecals.add(sp.decal);
      usedTypes.add(sp.type);
      opcs.push(`${id.padEnd(8)} ${net} ${sp.type} ${at.x} ${at.y} ${angle} 0 ${sp.variant}`);
      netNames.push(`${net.padEnd(12)} ${id.padEnd(12)} ${label.x} ${label.y} 0 ${j} 0 0 0 ${sp.type === '$OSR_SYMS' ? 3 : 6} -1 10 100 ${FONT}`);
      addTerminal(at, id, net);
    };
    const lab = (orient: number, d: number) => { const v = DIR_VECTORS[orient & 3]!; return { x: v.x * d, y: v.y * d }; };
    for (const o of objs) {
      if (!isShown(doc, o)) continue;
      if (o.kind === 'power') {
        const net = netAt.get(ref(o)) ?? netName(o.text);
        const at = MP(o.at);
        if (o.crossSheet) { const l = lab(o.orient, 340); opc(at, net, SPECIAL.REFIN!, o.orient, l, l.x < 0 ? 1 : l.y ? 4 : 0); }
        else { const l = lab(o.orient, 160); opc(at, net, SPECIAL[POWER_DECAL[o.style] ?? 'PWRBAR']!, o.orient, l, o.orient === 1 ? 4 : o.orient === 3 ? 6 : o.orient === 2 ? 9 : 8); }
      } else if (o.kind === 'port') {
        const net = netAt.get(ref(o)) ?? netName(o.name);
        const a = MP(o.at), vertical = o.style >= 4;
        const b = vertical ? { x: a.x, y: a.y + M(o.width) } : { x: a.x + M(o.width), y: a.y };
        const atB = !wireEnds.has(key(a)) && wireEnds.has(key(b));
        const at = atB ? b : a;
        const orient = vertical ? (atB ? 3 : 1) : (atB ? 2 : 0);
        const l = lab(orient, 340);
        opc(at, net, o.io === 2 ? SPECIAL.REFOUT! : SPECIAL.REFIN!, orient, l, l.x < 0 ? 1 : l.y ? 4 : 0);
      } else if (o.kind === 'sheetentry') {
        const p = entryPoint(doc, o);
        if (!p) continue;
        const net = netAt.get(ref(o)) ?? netName(o.name);
        // Into the symbol: from its left side right, right side left, top down, bottom up
        const orient = o.side === 1 ? 2 : o.side === 2 ? 3 : o.side === 3 ? 1 : 0;
        const l = lab(orient, 340);
        opc(MP(p), net, o.io === 2 ? SPECIAL.REFOUT! : SPECIAL.REFIN!, orient, l, l.x < 0 ? 1 : l.y ? 4 : 0);
      }
    }

    /* Buses, named by a net label on them */
    const busLines: string[] = [];
    let nBus = 0;
    const busLabels = objs.filter((o): o is SchObject & { kind: 'text' } => o.kind === 'text' && o.role === 'netlabel' && isShown(doc, o));
    for (const o of objs) {
      if (o.kind !== 'bus' || !isShown(doc, o) || o.pts.length < 2) continue;
      const on = busLabels.find((l) => o.pts.some((p, i) => i > 0 && onSeg(l.at, o.pts[i - 1]!, p)));
      busLines.push(`@@@B${nBus++} ${on ? netName(on.text) : `BUS${nBus}`} ${o.pts.length}`, ...o.pts.map((p) => { const q = MP(p); return `${q.x} ${q.y}`; }));
    }

    /* Wires: split where things join, joined pin to pin through tie dots */
    type Edge = { a: string; b: string; net: string; done: boolean };
    const pts = new Map<string, P>();
    const segs: { a: P; b: P; net: string }[] = [];
    for (const o of objs) {
      if (o.kind !== 'wire' || !isShown(doc, o) || o.pts.length < 2) continue;
      const net = netAt.get(ref(o)) ?? '';
      const l = o.pts.map(MP);
      for (let i = 1; i < l.length; i++) if (key(l[i - 1]!) !== key(l[i]!)) segs.push({ a: l[i - 1]!, b: l[i]!, net });
    }
    const manual = new Set(objs.filter((o) => o.kind === 'junction' && isShown(doc, o)).map((o) => key(MP((o as { at: Vec2 }).at))));
    // Where segments split: ends, terminals, junctions (on a 500 mil grid)
    const splitPts = new Map<string, P>();
    for (const sg of segs) { splitPts.set(key(sg.a), sg.a); splitPts.set(key(sg.b), sg.b); }
    for (const [k, t] of terminals) splitPts.set(k, t[0]!.at);
    for (const k of manual) { const [x, y] = k.split(',').map(Number); splitPts.set(k, { x: x!, y: y! }); }
    const CELL = 500, grid = new Map<string, P[]>();
    for (const p of splitPts.values()) { const gk = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`; if (!grid.has(gk)) grid.set(gk, []); grid.get(gk)!.push(p); }
    const edges: Edge[] = [];
    const adj = new Map<string, number[]>();
    const link = (a: P, b: P, net: string) => {
      const ka = key(a), kb = key(b);
      pts.set(ka, a); pts.set(kb, b);
      edges.push({ a: ka, b: kb, net, done: false });
      for (const k of [ka, kb]) { if (!adj.has(k)) adj.set(k, []); adj.get(k)!.push(edges.length - 1); }
    };
    for (const sg of segs) {
      const on: P[] = [];
      const x0 = Math.floor(Math.min(sg.a.x, sg.b.x) / CELL), x1 = Math.floor(Math.max(sg.a.x, sg.b.x) / CELL);
      const y0 = Math.floor(Math.min(sg.a.y, sg.b.y) / CELL), y1 = Math.floor(Math.max(sg.a.y, sg.b.y) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) for (const p of grid.get(`${gx},${gy}`) ?? []) {
        if (key(p) !== key(sg.a) && key(p) !== key(sg.b) && onSeg(p, sg.a, sg.b)) on.push(p);
      }
      const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y;
      on.sort((p, q) => ((p.x - sg.a.x) * dx + (p.y - sg.a.y) * dy) - ((q.x - sg.a.x) * dx + (q.y - sg.a.y) * dy));
      let prev = sg.a;
      for (const p of [...on, sg.b]) { if (key(p) !== key(prev)) link(prev, p, sg.net); prev = p; }
    }
    // Nodes: terminals, junctions, ends, forks; each a pin, an off-page reference or a tie dot
    const dots: string[] = [];
    const nodeId = new Map<string, string>();
    const signals = new Map<string, string[]>();
    const wire = (net: string, a: string, b: string, path: P[]) => {
      const n = net || `$$$${++auto}`;
      if (!signals.has(n)) signals.set(n, []);
      signals.get(n)!.push(`${a.padEnd(12)} ${b.padEnd(12)} ${path.length} 0`, ...path.map((p) => `${p.x} ${p.y}`));
    };
    let nDot = 0;
    const dotAt = (p: P) => { const id = `@@@D${nDot++}`; dots.push(`${id.padEnd(8)} ${p.x} ${p.y}`); return id; };
    const idOf = (k: string): string => {
      let id = nodeId.get(k);
      if (id) return id;
      const t = terminals.get(k);
      id = t?.length ? t[0]!.id : dotAt(pts.get(k)!);
      nodeId.set(k, id);
      return id;
    };
    const isNode = (k: string) => terminals.has(k) || manual.has(k) || (adj.get(k)?.length ?? 0) !== 2 || nodeId.has(k);
    const walk = (start: string, e0: number) => {
      const path: P[] = [pts.get(start)!];
      let cur = start, e = e0;
      const net = edges[e0]!.net;
      for (;;) {
        const ed = edges[e]!;
        ed.done = true;
        cur = ed.a === cur ? ed.b : ed.a;
        path.push(pts.get(cur)!);
        if (isNode(cur)) break;
        const nxt = adj.get(cur)!.find((i) => !edges[i]!.done);
        if (nxt === undefined) break;
        e = nxt;
      }
      wire(net, idOf(start), idOf(cur), path);
    };
    for (const [k, list] of adj) if (isNode(k)) for (const e of list) if (!edges[e]!.done) walk(k, e);
    // Loops with no node on them: a tie dot on each
    for (let i = 0; i < edges.length; i++) if (!edges[i]!.done) { nodeId.set(edges[i]!.a, dotAt(pts.get(edges[i]!.a)!)); walk(edges[i]!.a, i); }
    // Things at one point: joined by wires of no length; a pin on its net by a label alone, by a tie dot
    for (const [k, list] of terminals) {
      const id = idOf(k);
      for (const t of list.slice(1)) wire(t.net || list[0]!.net, id, t.id, [t.at, t.at]);
      if (list.length === 1 && !adj.has(k) && list[0]!.id.includes('.') && multiPin.has(list[0]!.net) && list[0]!.net && !list[0]!.net.startsWith('$$$')) {
        wire(list[0]!.net, id, dotAt(list[0]!.at), [list[0]!.at, list[0]!.at]);
      }
    }

    /* The sheet */
    w(`*SHT*   ${si + 1} ${padsName(title, 40)} -1 $$$NONE`, '*CAE*        GENERAL PARAMETERS FOR THE SHEET', '',
      '*TEXT*       FREE TEXT', '', texts, '', '*LINES*      LINES ITEMS', '', lineItems, '', '*CAEDECAL*  ITEMS', '');
    for (const dn of usedDecals) {
      const pd = pinDecals.get(dn);
      if (pd) w(pinDecal(pd));
    }
    for (const dn of usedDecals) {
      const sp = SPECIAL[dn];
      if (sp) w(specialDecal(sp));
      else if (decals.has(dn)) w(decals.get(dn)!);
    }
    w('', '*PARTTYPE*   ITEMS', '');
    for (const t of ['$OSR_SYMS', '$GND_SYMS', '$PWR_SYMS'] as const) if (usedTypes.has(t)) w(specialType(t));
    for (const [k, pt] of partTypes) {
      if (!usedTypes.has(k)) continue;
      w(`${pt.name} ${pt.category}  ${pt.gates.length}   ${pt.sigPins.length}   0     0`, stamp());
      for (const g of pt.gates) w(`GATE 1 ${g.pins.length} 0`, g.decal, ...g.pins.map((p) => `${p.num} 0 ${p.type}${p.name ? ` ${p.name}` : ''}`));
      for (const sp of pt.sigPins) w(`SIGPIN ${sp.num} ${sp.net}`);
      w('');
    }
    w('*PART*       ITEMS', '', parts, '*BUSSES*', '', busLines, '', '*OFFPAGE REFS*', '', opcs, '', '*TIEDOTS*', '', dots, '', '*CONNECTION*', '');
    for (const [n, l] of signals) { allNets.add(n); w(`*SIGNAL* ${n} ${n.startsWith('$$$') ? 64 : 0} 0`, l); }
    w('', '*NETNAMES*', '', netNames, '');
  });
  w('*END*     OF ASCII OUTPUT FILE', '');
  const text = out.join('\r\n');
  return { text, bytes: padsBytes(text), warnings, stats: { sheets: pages.length, parts: nParts, nets: allNets.size, partTypes: partTypes.size } };
}

function onSeg(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) return false;
  if (a.x === b.x || a.y === b.y) return true;
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) <= Math.hypot(b.x - a.x, b.y - a.y) * 0.5;
}
