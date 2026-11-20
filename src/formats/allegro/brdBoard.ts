/**
 * Cadence Allegro boards (.brd, Allegro and OrCAD PCB Editor 16.0 to 19) as AD boards: the copper
 * layers in stack order with their names, the board outline and cut-outs, the nets, the placed
 * symbols as components (their pads from the padstacks, through-hole, surface-mount and slotted,
 * with their mask and paste openings; their silkscreen, assembly and place-bound drawings and
 * text, the reference designator and value as the designator and comment), the tracks and arcs,
 * vias (blind and buried too), the dynamic shapes as polygon pours with their poured copper, the
 * static copper shapes as regions, route and via keep-outs, and the other classes' drawings and
 * text on mechanical layers named after them. The symbols become a PcbLib. Allegro's negative
 * planes come in as signal layers with their copper (Allegro has cut their voids), its
 * constraints as AD's default rules [est].
 */
import { readBrd, V, type Blk, type BrdDb, type LayerInfo, type PadComp } from './brdRead';
import { newBoardRecord } from '../altium/board6';
import { assemblePcbDoc, applyStackLayers } from '../altium/assemble';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, flattenVertices, layerToName, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import type { FootprintDef } from '../altium/pcblib';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { boardRules, uniqueIdFor } from '../kicad/board';
import { footprintsFromBoard } from '../../model/pcbLib';
import { L, mechLayer, type LayerId } from '../../model/layers';
import { formatAltiumLength, mil, mm, UNITS_PER_MIL, UNITS_PER_MM } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import type { PolyVertex } from '../../model/pcb';
import { strokeTextWidth } from '../gerber/stroke';

export interface BrdResult {
  bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[];
  stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number; pours: number };
}

/* ── Allegro's classes and subclasses ── */
const C = {
  BGEOM: 0x01, COMPVAL: 0x02, DEVTYPE: 0x03, DFMT: 0x04, DRC: 0x05, ETCH: 0x06, MFG: 0x07, ANALYSIS: 0x08, PGEOM: 0x09,
  PKG_KEEPIN: 0x0a, PKG_KEEPOUT: 0x0b, PIN: 0x0c, REFDES: 0x0d, ROUTE_KEEPIN: 0x0e, ROUTE_KEEPOUT: 0x0f, TOL: 0x10, UPN: 0x11,
  VIA_CLASS: 0x12, VIA_KEEPOUT: 0x13, ANTI_ETCH: 0x14, BOUNDARY: 0x15, CREG: 0x16,
} as const;
const CLASS_NAMES: Record<number, string> = {
  0x01: 'Board Geometry', 0x02: 'Component Value', 0x03: 'Device Type', 0x04: 'Drawing Format', 0x06: 'Etch', 0x07: 'Manufacturing', 0x08: 'Analysis',
  0x09: 'Package Geometry', 0x0a: 'Package Keepin', 0x0b: 'Package Keepout', 0x0c: 'Pin', 0x0d: 'Ref Des', 0x0e: 'Route Keepin', 0x0f: 'Route Keepout',
  0x10: 'Tolerance', 0x11: 'User Part Number', 0x12: 'Via Class', 0x13: 'Via Keepout', 0x14: 'Anti Etch', 0x15: 'Boundary', 0x16: 'Constraint Region',
};
const BGEOM_SUB: Record<number, string> = {
  0xea: 'Outline', 0xeb: 'Constraint Area', 0xec: 'Off Grid Area', 0xed: 'Soldermask Bottom', 0xee: 'Soldermask Top', 0xef: 'Assembly Detail',
  0xf0: 'Silkscreen Bottom', 0xf1: 'Silkscreen Top', 0xf2: 'Switch Area Bottom', 0xf3: 'Switch Area Top', 0xf4: 'Both Rooms', 0xf5: 'Bottom Room',
  0xf6: 'Top Room', 0xf7: 'Place Grid Bottom', 0xf8: 'Place Grid Top', 0xf9: 'Dimension', 0xfa: 'Tooling Corners', 0xfb: 'Assembly Notes',
  0xfc: 'Plating Bar', 0xfd: 'Design Outline',
};
const TEXT_SUB: Record<number, string> = { 0xf8: 'Display Bottom', 0xf9: 'Display Top', 0xfa: 'Silkscreen Bottom', 0xfb: 'Silkscreen Top', 0xfc: 'Assembly Bottom', 0xfd: 'Assembly Top' };
const DFMT_SUB: Record<number, string> = { 0xf9: 'Revision Data', 0xfa: 'Revision Block', 0xfb: 'Title Data', 0xfc: 'Title Block', 0xfd: 'Outline' };
const PGEOM_SUB: Record<number, string> = {
  0xec: 'Pastemask Bottom', 0xed: 'Pastemask Top', 0xee: 'DFA Bound Bottom', 0xef: 'DFA Bound Top', 0xf1: 'Display Bottom', 0xf2: 'Display Top',
  0xf3: 'Soldermask Bottom', 0xf4: 'Soldermask Top', 0xf5: 'Body Centre', 0xf6: 'Silkscreen Bottom', 0xf7: 'Silkscreen Top', 0xf8: 'Pad Stack Name',
  0xf9: 'Pin Number', 0xfa: 'Place Bound Bottom', 0xfb: 'Place Bound Top', 0xfc: 'Assembly Bottom', 0xfd: 'Assembly Top',
};
const MFG_SUB: Record<number, string> = {
  0xf0: 'X-Section Chart', 0xf1: 'No Probe Bottom', 0xf2: 'No Probe Top', 0xf3: 'AutoSilk Bottom', 0xf4: 'AutoSilk Top', 0xf5: 'Probe Bottom',
  0xf6: 'Probe Top', 0xf7: 'NC Drill Figure', 0xf8: 'NC Drill Legend', 0xf9: 'No Gloss Internal', 0xfa: 'No Gloss Bottom', 0xfb: 'No Gloss Top',
  0xfc: 'No Gloss All', 0xfd: 'Photoplot Outline',
};
const KEEP_SUB: Record<number, string> = { 0xfb: 'Bottom', 0xfc: 'Top', 0xfd: 'All' };
const subName = (cls: number, sub: number): string | undefined => {
  switch (cls) {
    case C.BGEOM: return BGEOM_SUB[sub];
    case C.COMPVAL: case C.DEVTYPE: case C.REFDES: case C.TOL: case C.UPN: return TEXT_SUB[sub];
    case C.DFMT: return DFMT_SUB[sub];
    case C.PGEOM: return PGEOM_SUB[sub];
    case C.MFG: return MFG_SUB[sub];
    case C.PKG_KEEPIN: case C.PKG_KEEPOUT: case C.ROUTE_KEEPIN: case C.ROUTE_KEEPOUT: case C.VIA_KEEPOUT: case C.CREG: return KEEP_SUB[sub];
  }
  return undefined;
};

/* ── padstack shapes ── */
const PAD = { NULL: 0, CIRCLE: 2, OCTAGON: 3, CROSS: 4, SQUARE: 5, RECT: 6, DIAMOND: 7, PENTAGON: 0x0a, OBLONG_X: 0x0b, OBLONG_Y: 0x0c, HEX_X: 0x0f, HEX_Y: 0x10, TRIANGLE: 0x12, SHAPE: 0x16, DONUT: 0x19, ROUNDRECT: 0x1b, CHAMFER: 0x1c, NSIDED: 0x1e } as const;

/** Mechanical layers taken by fixed meanings (the rest are handed out in order). */
const MECH_FREE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

export interface BrdOptions {
  /** The schematic's nets at its pins ("designator\u0000pin" → net name, as the project compiles them): the board's nets take those names. */
  pinNets?: Map<string, string>;
  /** The schematic's comments by designator: the board's comments (Allegro keeps values in capitals). */
  comments?: Map<string, string>;
}

export function convertAllegroBrd(bytes: Uint8Array, fileName: string, opts: BrdOptions = {}): BrdResult {
  const db = readBrd(bytes);
  // Anything still left of or below AD's positive space (text running past its anchor, arcs): moved again
  const first = build(db, fileName, opts, { x: 0, y: 0 });
  const edge = mil(100);
  if (first.lo.x >= edge && first.lo.y >= edge) return first.result;
  return build(db, fileName, opts, { x: Math.max(0, edge - first.lo.x), y: Math.max(0, edge - first.lo.y) }).result;
}

function build(db: BrdDb, fileName: string, opts: BrdOptions, nudge: Vec2): { result: BrdResult; lo: Vec2 } {
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'Board';
  const warnings: string[] = [...db.warnings];
  const tally = new Map<string, number>();
  const note = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
  const S = (id: unknown): string => (typeof id === 'number' ? db.strings.get(id) ?? '' : typeof id === 'string' ? id : '');
  const B = (k: unknown): Blk | undefined => (typeof k === 'number' && k ? db.blocks.get(k) : undefined);
  /** A linked list from its head to its tail (or its end), each once. */
  const chain = (head: unknown, tail: number, next: (b: Blk) => number = (b) => b.next): Blk[] => {
    const out: Blk[] = [];
    const seen = new Set<number>();
    let k = typeof head === 'number' ? head : 0;
    while (k && k !== tail && !seen.has(k) && out.length < 5_000_000) {
      seen.add(k);
      const b = db.blocks.get(k);
      if (!b) break;
      out.push(b);
      k = next(b);
    }
    return out;
  };
  const ll = (n: string) => { const l = db.header.ll[n]; return l ? chain(l.head, l.tail) : []; };

  /* ── units: Allegro's (its unit ÷ the divisor, Y up) → AD's ── */
  const per = ({ 1: UNITS_PER_MIL, 2: UNITS_PER_MIL * 1000, 3: UNITS_PER_MM, 4: UNITS_PER_MM * 10, 5: UNITS_PER_MM / 1000 } as Record<number, number>)[db.units] ?? UNITS_PER_MIL;
  const f = per / db.divisor;
  const len = (v: number) => Math.round(Math.abs(v) * f);

  /* ── layers ── */
  const lists = new Map<number, { key: number; names: string[]; props: number[] }>();
  db.header.layerMap.forEach((m, cls) => {
    const l = B(m.list);
    if (!l || l.t !== 0x2a) return;
    const es = (l.entries as { name: string | number; props: number }[]) ?? [];
    lists.set(cls, { key: l.key, names: es.map((e) => (typeof e.name === 'number' ? S(e.name) : e.name)), props: es.map((e) => e.props) });
  });
  const etch = lists.get(C.ETCH);
  let copperNames = etch?.names.slice() ?? [];
  if (copperNames.length < 2) { warnings.push('No copper layer list: a two-layer board'); copperNames = ['TOP', 'BOTTOM']; }
  if (copperNames.length > 32) { warnings.push(`${copperNames.length} copper layers: the first 32 taken, the rest left out`); }
  const nCu = copperNames.length;
  const copperIds: LayerId[] = copperNames.map((_, i) => (i === 0 ? L.TOP : i === nCu - 1 ? L.BOTTOM : i <= 30 ? (L.MID1 + i - 1) as LayerId : L.BOTTOM));
  const copperOf = (i: number): LayerId | null => (i >= 0 && i < nCu && (i === nCu - 1 || i <= 30) ? copperIds[i]! : null);
  /** Whether a class's subclasses are copper layers (classes sharing the etch list). */
  const onEtchList = (cls: number) => cls === C.ETCH || cls === C.BOUNDARY || (!!etch && lists.get(cls)?.key === etch.key);

  const mechNames = new Map<number, string>([[1, 'Board Outline']]);
  const mechByName = new Map<string, number>();
  let mechNext = 0;
  const mech = (n: number, nm: string): LayerId => { if (!mechNames.has(n)) mechNames.set(n, nm); return mechLayer(n); };
  const namedMech = (nm: string): LayerId => {
    let n = mechByName.get(nm);
    if (n === undefined) {
      if (mechNext < MECH_FREE.length) { n = MECH_FREE[mechNext++]!; mechNames.set(n, nm); }
      else { n = 32; mechNames.set(32, 'Other Allegro Layers'); note('Allegro layers past the mechanical layers, put on Mechanical 32'); }
      mechByName.set(nm, n);
    }
    return mechLayer(n);
  };
  const displayName = (li: LayerInfo) => {
    const custom = lists.get(li.cls);
    const sub = custom && li.sub < custom.names.length && !onEtchList(li.cls) ? custom.names[li.sub] : subName(li.cls, li.sub) ?? `Subclass ${li.sub.toString(16).toUpperCase()}`;
    return `${CLASS_NAMES[li.cls] ?? `Class ${li.cls.toString(16).toUpperCase()}`} / ${sub}`;
  };
  const layerCache = new Map<number, LayerId | null>();
  /** An Allegro class and subclass's AD layer (null: not carried over). */
  const layerFor = (li: LayerInfo | undefined): LayerId | null => {
    if (!li) return null;
    const key = (li.cls << 8) | li.sub;
    let v = layerCache.get(key);
    if (v !== undefined) return v;
    v = resolve(li);
    layerCache.set(key, v);
    return v;
  };
  function resolve(li: LayerInfo): LayerId | null {
    const { cls, sub } = li;
    if (cls === C.DRC || cls === C.ANALYSIS || cls === C.PIN || cls === C.VIA_CLASS || cls === C.ANTI_ETCH) return null;
    // Areas of rules are never copper, even on a copper layer's subclass
    if (cls === C.CREG || cls === C.PKG_KEEPIN || cls === C.PKG_KEEPOUT || cls === C.ROUTE_KEEPIN) return namedMech(CLASS_NAMES[cls]!);
    if (onEtchList(cls) && sub < nCu) return copperOf(sub);
    switch (cls) {
      case C.BGEOM:
        if (sub === 0xea || sub === 0xfd) return mech(1, 'Board Outline');
        if (sub === 0xf1) return L.TOP_OVERLAY;
        if (sub === 0xf0) return L.BOTTOM_OVERLAY;
        if (sub === 0xee) return L.TOP_SOLDER;
        if (sub === 0xed) return L.BOTTOM_SOLDER;
        break;
      case C.COMPVAL: case C.DEVTYPE: case C.REFDES: case C.TOL: case C.UPN:
        // Only reference designators go to the silkscreen: values, device types and the like on its subclasses
        // are seldom on the silkscreen's film (as KiCad reads them too) [est]
        if (sub === 0xfb) return cls === C.REFDES ? L.TOP_OVERLAY : namedMech(`${CLASS_NAMES[cls]} / Silkscreen Top`);
        if (sub === 0xfa) return cls === C.REFDES ? L.BOTTOM_OVERLAY : namedMech(`${CLASS_NAMES[cls]} / Silkscreen Bottom`);
        if (sub === 0xfd) return mech(13, 'Assembly Top');
        if (sub === 0xfc) return mech(14, 'Assembly Bottom');
        if (sub === 0xf9) return namedMech('Display Top');
        if (sub === 0xf8) return namedMech('Display Bottom');
        break;
      case C.PGEOM:
        if (sub === 0xf7) return L.TOP_OVERLAY;
        if (sub === 0xf6) return L.BOTTOM_OVERLAY;
        if (sub === 0xfd) return mech(13, 'Assembly Top');
        if (sub === 0xfc) return mech(14, 'Assembly Bottom');
        if (sub === 0xfb) return mech(15, 'Place Bound Top');
        if (sub === 0xfa) return mech(16, 'Place Bound Bottom');
        if (sub === 0xed) return L.TOP_PASTE;
        if (sub === 0xec) return L.BOTTOM_PASTE;
        if (sub === 0xf4) return L.TOP_SOLDER;
        if (sub === 0xf3) return L.BOTTOM_SOLDER;
        if (sub === 0xf2) return namedMech('Display Top');
        if (sub === 0xf1) return namedMech('Display Bottom');
        break;
      case C.MFG:
        if (sub === 0xf4) return L.TOP_OVERLAY;
        if (sub === 0xf3) return L.BOTTOM_OVERLAY;
        if (sub === 0xf7 || sub === 0xf8) return L.DRILL_DRAWING;
        break;
      case C.ROUTE_KEEPOUT: case C.VIA_KEEPOUT: case C.ROUTE_KEEPIN:
        if (sub === 0xfd) return L.KEEPOUT;
        if (sub === 0xfc) return L.TOP;
        if (sub === 0xfb) return L.BOTTOM;
        break;
    }
    // Drawing format, manufacturing, keep-in and keep-out drawings: one layer a class
    if (cls === C.DFMT || cls === C.MFG || cls === C.PKG_KEEPIN || cls === C.PKG_KEEPOUT || cls === C.CREG || cls === C.ROUTE_KEEPIN || cls === C.ROUTE_KEEPOUT || cls === C.VIA_KEEPOUT) return namedMech(CLASS_NAMES[cls]!);
    return namedMech(displayName(li));
  }

  /* ── coordinates: the board's lower left at 1000 mil (AD's origin where Allegro's is) ── */
  // Found from the outline (else everything) before anything is placed
  let minX = Infinity, minY = Infinity;
  const widen = (x: number, y: number) => { if (x < minX) minX = x; if (y < minY) minY = y; };
  const outlineBlocks = [...ll('0x24_0x28'), ...ll('shapes'), ...ll('0x14')].filter((b) => { const li = b.layer as LayerInfo | undefined; return li?.cls === C.BGEOM && (li.sub === 0xea || li.sub === 0xfd); });
  for (const b of outlineBlocks) {
    if (b.t === 0x24 || b.t === 0x0e) { const c = b.coords as number[]; widen(Math.min(c[0]!, c[2]!), Math.min(c[1]!, c[3]!)); continue; }
    for (const s of chain(b.t === 0x14 ? b.segment : b.firstSeg, b.key)) {
      if (!(s.t >= 0x15 && s.t <= 0x17 || s.t === 0x01)) continue;
      widen(s.sx as number, s.sy as number); widen(s.ex as number, s.ey as number);
      if (s.t === 0x01) for (const q of arcExtremes(s)) widen(q.x, q.y);
    }
  }
  if (!Number.isFinite(minX)) for (const fp of db.byType.get(0x2d) ?? []) widen(fp.x as number, fp.y as number);
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
  // Drawings far left of or below the outline (a drawing format, notes) moved into AD's positive space: their extent first
  let fx = Infinity, fy = Infinity;
  const see = (x: unknown, y: unknown) => { if (typeof x === 'number' && x < fx) fx = x; if (typeof y === 'number' && y < fy) fy = y; };
  const segs = (first: unknown, tail: number) => { for (const s of chain(first, tail)) if (s.t >= 0x15 && s.t <= 0x17 || s.t === 0x01) { see(s.sx, s.sy); see(s.ex, s.ey); } };
  for (const b of ll('0x14')) if (b.t === 0x14) segs(b.segment, b.key);
  for (const b of [...ll('0x24_0x28'), ...ll('shapes')]) { if (b.t === 0x28) segs(b.firstSeg, b.key); else if (b.t === 0x24 || b.t === 0x0e) { const c = b.coords as number[]; see(Math.min(c[0]!, c[2]!), Math.min(c[1]!, c[3]!)); } }
  for (const t of [...ll('0x03_0x30'), ...(db.byType.get(0x30) ?? []).filter((x) => x.group as number), ...(db.byType.get(0x2d) ?? [])]) if (t.t === 0x30 || t.t === 0x2d) see(t.x, t.y);
  const base = { x: mil(1000) - minX * f, y: mil(1000) - minY * f };
  const lift = (v: number, b0: number) => (Number.isFinite(v) ? Math.max(0, mil(200) - (v * f + b0)) : 0);
  const ox = base.x + lift(fx, base.x) + nudge.x, oy = base.y + lift(fy, base.y) + nudge.y;
  // Every board point's extent: the sheet, and whether anything lies outside AD's positive space
  const lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
  const P = (x: number, y: number): Vec2 => {
    const q = { x: Math.round(x * f + ox), y: Math.round(y * f + oy) };
    if (q.x < lo.x) lo.x = q.x; if (q.y < lo.y) lo.y = q.y; if (q.x > hi.x) hi.x = q.x; if (q.y > hi.y) hi.y = q.y;
    return q;
  };

  /* ── nets ── */
  const nets: string[] = [];
  const netIndex = new Map<number, number>();
  const used = new Set<string>();
  const netBlocks = ll('nets').filter((n) => n.t === 0x1b);
  for (const n of netBlocks) {
    let nm = S(n.name);
    // An unnamed net of one pin and nothing else (an unconnected pin): no net
    if (!nm) {
      const items = chain(n.assignment, n.key).flatMap((a) => (a.t === 0x04 ? chain(a.connItem, a.key) : []));
      if (items.every((c) => c.t === 0x32 || c.t === 0x2e) && items.filter((c) => c.t === 0x32).length <= 1) continue;
    }
    if (!nm || used.has(nm)) nm = nm ? `${nm}_${n.key.toString(16)}` : `Net_${nets.length + 1}`;
    used.add(nm);
    netIndex.set(n.key, nets.length);
    nets.push(nm);
  }
  const netOfAssign = (k: unknown): number | undefined => { const a = B(k); return a?.t === 0x04 ? netIndex.get(a.net as number) : undefined; };

  /* ── fonts (1-based) ── */
  type Font = { h: number; w: number; stroke: number };
  const fontBlock = ll('0x36').find((b) => b.code === 0x08) ?? (db.byType.get(0x36) ?? []).find((b) => b.code === 0x08);
  const fonts: Font[] = (fontBlock?.fonts as Font[] | undefined) ?? [];

  /* ── the records ── */
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], texts: PcbRawRecord[] = [], regions: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const comps: PropertyBag[] = [];
  let nTracks = 0;
  const done = new Set<number>();

  const widthFor = (layer: LayerId, w: number) => (w > 0 ? Math.max(1, len(w)) : layer === L.TOP_OVERLAY || layer === L.BOTTOM_OVERLAY ? mil(5) : mil(1));
  const ang = (c: Vec2, p: Vec2) => (((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI) % 360 + 360) % 360;
  /** An Allegro arc block in AD's terms (or null when it's too flat to be one). */
  const arcGeom = (s: Blk): { c: Vec2; r: number; start: number; end: number; a: Vec2; b: Vec2 } | null => {
    const a = P(s.sx as number, s.sy as number), b = P(s.ex as number, s.ey as number);
    const c = P(s.cx as number, s.cy as number);
    const r = Math.round(Math.abs(s.r as number) * f) || Math.round(Math.hypot(a.x - c.x, a.y - c.y));
    if (!Number.isFinite(r) || r <= 0 || r > 2 ** 30) return null;
    if (a.x === b.x && a.y === b.y) return { c, r, start: 0, end: 360, a, b };
    const cw = ((s.subType as number) & 0x40) !== 0;
    return cw ? { c, r, start: ang(c, b), end: ang(c, a), a, b } : { c, r, start: ang(c, a), end: ang(c, b), a, b };
  };
  /** A segment chain's lines and arcs as tracks and arcs on a layer. */
  const drawChain = (first: unknown, tail: number, layer: LayerId, net?: number, component?: number) => {
    for (const s of chain(first, tail)) {
      if (s.t >= 0x15 && s.t <= 0x17) {
        tracks.push(encodeTrack({ layer, a: P(s.sx as number, s.sy as number), b: P(s.ex as number, s.ey as number), width: widthFor(layer, s.width as number), net, component })); nTracks++;
      } else if (s.t === 0x01) {
        const g = arcGeom(s);
        if (g) arcs.push(encodeArc({ layer, c: g.c, r: g.r, start: g.start, end: g.end, width: widthFor(layer, s.width as number), net, component }));
        else tracks.push(encodeTrack({ layer, a: P(s.sx as number, s.sy as number), b: P(s.ex as number, s.ey as number), width: widthFor(layer, s.width as number), net, component }));
        nTracks++;
      } else break;
    }
  };
  /** A segment chain as a closed outline's vertices (arcs kept). */
  const ring = (first: unknown, map: (x: number, y: number) => Vec2 = P, mirrored = false, open = false): PolyVertex[] => {
    const out: PolyVertex[] = [];
    const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
    let k = typeof first === 'number' ? first : 0;
    const seen = new Set<number>();
    while (k && !seen.has(k)) {
      seen.add(k);
      const s = db.blocks.get(k);
      if (!s) break;
      const a = map(s.sx as number, s.sy as number), b = map(s.ex as number, s.ey as number);
      if (s.t >= 0x15 && s.t <= 0x17) {
        if (!out.length || !same(out[out.length - 1]!.p, a)) out.push({ p: a });
        out.push({ p: b });
      } else if (s.t === 0x01) {
        const c = map(s.cx as number, s.cy as number);
        const r = Math.round(Math.hypot(a.x - c.x, a.y - c.y));
        if (!out.length || !same(out[out.length - 1]!.p, a)) out.push({ p: a });
        const v = out[out.length - 1]!;
        const cw = (((s.subType as number) & 0x40) !== 0) !== mirrored;
        if (same(a, b)) v.arc = { c, r, sa: ang(c, a), ea: ang(c, a) + 360 };
        else if (r > 0 && r < 2 ** 30) { const a0 = ang(c, a), a1 = ang(c, b); v.arc = cw ? { c, r, sa: a1, ea: a1 > a0 ? a0 + 360 : a0 } : { c, r, sa: a0, ea: a0 > a1 ? a1 + 360 : a1 }; }
        if (!same(a, b)) out.push({ p: b });
      } else break;
      k = s.next;
    }
    if (!open && out.length > 1 && !out[out.length - 1]!.arc && same(out[0]!.p, out[out.length - 1]!.p)) out.pop();
    return out;
  };
  const flat = (vs: PolyVertex[]): Vec2[] => flattenVertices(vs);
  /** A void's outline with its arcs' chords outside the arcs (a void flattened inside its arc would sit closer than drawn). */
  const flatOut = (vs: PolyVertex[]): Vec2[] => {
    const out: Vec2[] = [];
    vs.forEach((v) => {
      out.push(v.p);
      if (!v.arc) return;
      const { c, r } = v.arc;
      const a0 = Math.atan2(v.p.y - c.y, v.p.x - c.x);
      // From the arc's start angle anticlockwise, else from its end clockwise
      const ccw = Math.abs(((((a0 * 180) / Math.PI - v.arc.sa) % 360) + 540) % 360 - 180) < 0.5;
      const sweep = ((ccw ? 1 : -1) * (v.arc.ea - v.arc.sa) * Math.PI) / 180;
      const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
      const step = sweep / n, rr = r / Math.cos(step / 2);
      for (let k = 0; k < n; k++) { const a = a0 + step * (k + 0.5); out.push({ x: Math.round(c.x + rr * Math.cos(a)), y: Math.round(c.y + rr * Math.sin(a)) }); }
    });
    return out;
  };
  /** A shape's (0x28) holes: its void chain. */
  const holesOf = (s: Blk): Vec2[][] => {
    const out: Vec2[][] = [];
    let k = s.firstKeepout as number;
    const seen = new Set<number>();
    while (k && !seen.has(k)) {
      seen.add(k);
      const h = db.blocks.get(k);
      if (!h || h.t !== 0x34) break;
      const pts = flatOut(ring(h.firstSeg));
      if (pts.length >= 3) out.push(pts);
      k = h.next;
    }
    return out;
  };
  const rectOutline = (b: Blk): Vec2[] => {
    const c = b.coords as number[];
    const corners = [[c[0]!, c[1]!], [c[2]!, c[1]!], [c[2]!, c[3]!], [c[0]!, c[3]!]];
    const th = (((b.rotation as number) ?? 0) / 1000) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    return corners.map(([x, y]) => { const dx = x - c[0]!, dy = y - c[1]!; return P(c[0]! + dx * cs - dy * sn, c[1]! + dx * sn + dy * cs); });
  };
  const keepoutRegion = (layer: LayerId, outline: Vec2[], component?: number) => {
    const rec = encodeRegion({ layer, outline, component });
    rec.subs[0]![2] = 2;
    regions.push(rec);
  };
  /** A drawing block (0x14 lines, 0x0E/0x24 rectangles, 0x28 shapes, 0x30 text) on its layer. */
  const drawBlock = (b: Blk, component?: number, filled = true) => {
    if (done.has(b.key)) return;
    done.add(b.key);
    const li = b.layer as LayerInfo | undefined;
    if (b.t === 0x30) { textOf(b, component); return; }
    if (!li) return;
    if (li.cls === C.ANTI_ETCH) { note('Anti-etch (plane void) drawings'); return; }
    if (li.cls === C.BOUNDARY) return;
    // Via keep-outs as drawings (AD's keep-outs keep out tracks too)
    const layer = li.cls === C.VIA_KEEPOUT ? namedMech(CLASS_NAMES[C.VIA_KEEPOUT]!) : layerFor(li);
    if (layer === null) return;
    const keep = li.cls === C.ROUTE_KEEPOUT;
    switch (b.t) {
      // A keep-out's lines: drawn on a mechanical layer (on copper they would be copper)
      case 0x14: drawChain(b.segment, b.key, keep ? namedMech(CLASS_NAMES[li.cls]!) : layer, undefined, component); break;
      case 0x0e: case 0x24: {
        const pts = rectOutline(b);
        if (keep) { keepoutRegion(layer, pts, component); break; }
        for (let i = 0; i < 4; i++) { tracks.push(encodeTrack({ layer, a: pts[i]!, b: pts[(i + 1) % 4]!, width: widthFor(layer, 0), component })); nTracks++; }
        break;
      }
      case 0x28: {
        const outline = flat(ring(b.firstSeg));
        if (outline.length < 3) break;
        if (keep) { keepoutRegion(layer, outline, component); break; }
        if (!filled || !(layer >= L.TOP && layer <= L.BOTTOM_SOLDER)) {
          // Drawings' shapes as outlines (filled only on copper, silkscreen, paste and mask)
          for (let i = 0; i < outline.length; i++) { tracks.push(encodeTrack({ layer, a: outline[i]!, b: outline[(i + 1) % outline.length]!, width: widthFor(layer, 0), component })); nTracks++; }
          break;
        }
        regions.push(encodeRegion({ layer, outline, holes: holesOf(b), component }));
        break;
      }
      case 0x0c: break; // drill figures: AD draws its own
      default: note(`Drawing objects of type 0x${b.t.toString(16)}`);
    }
  };

  /** Text (0x30 → 0x31) on its layer: AD's stroke text, placed by its baseline anchor and alignment. */
  function textOf(t: Blk, component?: number, role?: 'designator' | 'comment', layerOverride?: LayerId, value?: string): void {
    const li = t.layer as LayerInfo;
    const layer = layerOverride ?? layerFor(li);
    if (layer === null) return;
    const sg = B(t.strGraphic);
    const s = value ?? (sg?.t === 0x31 ? String(sg.value ?? '') : '');
    if (!s) return;
    const props = t.font as { font: number; align: number; reversal: number } | undefined;
    const fd = props ? fonts[props.font - 1] : undefined;
    const h = fd ? Math.max(mil(4), len(fd.h)) : mil(50);
    const stroke = fd?.stroke ? Math.max(1, len(fd.stroke)) : Math.max(1, Math.round(h / 10));
    const rot = ((((t.rotation as number) ?? 0) / 1000) % 360 + 360) % 360;
    const mirrored = props?.reversal === 1 || props?.reversal === 3;
    const anchor = P(t.x as number, t.y as number);
    const w = strokeTextWidth(s, h);
    const k = props?.align === 2 ? 1 : props?.align === 3 ? 0.5 : 0;
    const th = (rot * Math.PI) / 180, dir = mirrored ? -1 : 1;
    const at = { x: Math.round(anchor.x - k * w * dir * Math.cos(th)), y: Math.round(anchor.y - k * w * dir * Math.sin(th)) };
    texts.push(encodeText({ layer, at, height: h, text: s, rotation: rot, strokeWidth: stroke, mirrored, component, isDesignator: role === 'designator', isComment: role === 'comment' }));
  }

  /* ── padstacks ── */
  /** A padstack: its hole, its copper layers' pads and its mask and paste openings (top, bottom; undefined: no slot known). */
  interface Stack { name: string; drill: number; drillH: number; plated: boolean; smd: boolean; count: number; start: number; copper: (PadComp | null)[]; mask: [PadComp | null, PadComp | null]; paste: [PadComp | null, PadComp | null | undefined] }
  const stacks = new Map<number, Stack>();
  const stackOf = (k: unknown): Stack | null => {
    const b = B(k);
    if (!b || b.t !== 0x1c) return null;
    let s = stacks.get(b.key);
    if (s) return s;
    const comps = b.comps as PadComp[], fixed = b.fixed as number, perL = b.per as number, count = b.layerCount as number;
    const comp = (i: number) => { const c = comps[i]; return c && c.type !== PAD.NULL ? c : null; };
    const copper = Array.from({ length: count }, (_, i) => comp(fixed + i * perL + 2));
    let dw = (b.drill as number) ?? 0, dh = 0;
    if ((b.slotY as number) > 0) { dw = b.slotX as number; dh = b.slotY as number; }
    if (!dh) dh = dw;
    const first = copper.find((c) => c);
    if (dw !== dh && first && (Math.abs(first.h) > Math.abs(first.w)) !== (dh > dw)) [dw, dh] = [dh, dw];
    const v17 = db.ver >= V.V172;
    s = {
      name: S(b.name), drill: dw, drillH: dh, plated: !!b.plated, smd: dw === 0 || count === 1, count, start: (b.startLayer as number) ?? 0, copper,
      mask: v17 ? [comp(14), comp(15)] : [comp(1), comp(5)], paste: v17 ? [comp(16), comp(17)] : [comp(6), undefined],
    };
    stacks.set(b.key, s);
    return s;
  };
  /** A pad component as AD's pad shape (raw sizes; an outline for shapes AD's pads haven't). */
  const shapeOf = (c: PadComp): { shape: PadFields['shape']; w: number; h: number; cornerPct?: number; outline?: { x: number; y: number }[] } => {
    const w = Math.abs(c.w), h = Math.abs(c.h) || Math.abs(c.w);
    switch (c.type) {
      case PAD.CIRCLE: case PAD.OBLONG_X: case PAD.OBLONG_Y: case PAD.DONUT: case PAD.NSIDED: return { shape: 'round', w, h };
      case PAD.SQUARE: return { shape: 'rect', w, h: w };
      case PAD.RECT: case PAD.CROSS: return { shape: 'rect', w, h };
      case PAD.OCTAGON: case PAD.CHAMFER: return { shape: 'octagon', w, h };
      case PAD.ROUNDRECT: { const m = Math.min(w, h); return { shape: 'roundrect', w, h, cornerPct: c.z1 > 0 && m > 0 ? Math.max(1, Math.min(100, Math.round((c.z1 / (m / 2)) * 100))) : 50 }; }
      case PAD.DIAMOND: return { shape: 'rect', w, h, outline: [{ x: w / 2, y: 0 }, { x: 0, y: h / 2 }, { x: -w / 2, y: 0 }, { x: 0, y: -h / 2 }] };
      case PAD.TRIANGLE: return { shape: 'rect', w, h, outline: [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: 0, y: h / 2 }] };
      case PAD.HEX_X: return { shape: 'rect', w, h, outline: [{ x: w / 2, y: 0 }, { x: w / 4, y: h / 2 }, { x: -w / 4, y: h / 2 }, { x: -w / 2, y: 0 }, { x: -w / 4, y: -h / 2 }, { x: w / 4, y: -h / 2 }] };
      case PAD.HEX_Y: return { shape: 'rect', w, h, outline: [{ x: 0, y: h / 2 }, { x: w / 2, y: h / 4 }, { x: w / 2, y: -h / 4 }, { x: 0, y: -h / 2 }, { x: -w / 2, y: -h / 4 }, { x: -w / 2, y: h / 4 }] };
      case PAD.PENTAGON: return { shape: 'rect', w, h, outline: [{ x: 0, y: -h / 2 }, { x: w / 2, y: -h / 6 }, { x: w / 3, y: h / 2 }, { x: -w / 3, y: h / 2 }, { x: -w / 2, y: -h / 6 }] };
      case PAD.SHAPE: {
        const sh = B(c.shapePtr);
        const raw: { x: number; y: number }[] = [];
        if (sh?.t === 0x28) for (const v of flat(ring(sh.firstSeg, (x, y) => ({ x: Math.round(x * 1000), y: Math.round(y * 1000) })))) raw.push({ x: v.x / 1000 + c.offX, y: v.y / 1000 + c.offY });
        if (raw.length >= 3) {
          const xs = raw.map((p) => p.x), ys = raw.map((p) => p.y);
          return { shape: 'rect', w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), outline: raw };
        }
        return { shape: 'rect', w, h };
      }
    }
    note(`Pad shapes of type 0x${c.type.toString(16)} (as rectangles)`);
    return { shape: 'rect', w, h };
  };

  /** A pad component's outline in its padstack's space (offset included): its own outline, else its shape's [est for octagons]. */
  const polyOf = (c: PadComp): { x: number; y: number }[] => {
    const sh = shapeOf(c);
    if (c.type === PAD.SHAPE) return sh.outline ?? [];
    let pts: { x: number; y: number }[];
    const w = sh.w, h = sh.h, m = Math.min(w, h);
    if (sh.outline) pts = sh.outline;
    else if (sh.shape === 'rect') pts = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
    else if (sh.shape === 'octagon') { const k = m / 4; pts = [{ x: -w / 2 + k, y: -h / 2 }, { x: w / 2 - k, y: -h / 2 }, { x: w / 2, y: -h / 2 + k }, { x: w / 2, y: h / 2 - k }, { x: w / 2 - k, y: h / 2 }, { x: -w / 2 + k, y: h / 2 }, { x: -w / 2, y: h / 2 - k }, { x: -w / 2, y: -h / 2 + k }]; }
    else {
      // Round, oblong and rounded rectangles: quarter arcs at the corners
      const r = sh.shape === 'round' ? m / 2 : (((sh.cornerPct ?? 50) / 100) * m) / 2;
      pts = [];
      for (const [qx, qy, a0] of [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]] as const) {
        const cx = qx * (w / 2 - r), cy = qy * (h / 2 - r);
        for (let k = 0; k <= 8; k++) { const a = ((a0 + (k * 90) / 8) * Math.PI) / 180; const q = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; const l = pts[pts.length - 1]; if (!l || Math.abs(l.x - q.x) > 1e-9 || Math.abs(l.y - q.y) > 1e-9) pts.push(q); }
      }
    }
    return pts.map((p) => ({ x: p.x + c.offX, y: p.y + c.offY }));
  };

  /* ── footprints ── */
  const patternOf = new Map<number, string>();
  for (const d of db.byType.get(0x2b) ?? []) for (const i of chain(d.firstInst, d.key)) if (i.t === 0x2d) patternOf.set(i.key, S(d.name));
  const partOf = new Map<number, Blk>();
  for (const c of db.byType.get(0x06) ?? []) for (const i of chain(c.firstInst, c.key)) if (i.t === 0x07) partOf.set(i.key, c);
  const fieldStr = (first: unknown, tail: number, code: number): string | undefined => {
    for (const x of chain(first, tail)) if (x.t === 0x03 && x.code === code && typeof x.value === 'string') return x.value;
    return undefined;
  };

  /** A pad's AD record(s): the padstack placed at its board position and turn. */
  const placePad = (st: Stack, at: Vec2, rot: number, back: boolean, padName: string, net: number | undefined, component: number | undefined) => {
    const flip = (i: number) => (back ? st.count - 1 - i : i);
    const shapeAt = (i: number) => { const c = st.copper[flip(i)]; return c ? shapeOf(c) : null; };
    const custom: { layer: LayerId; outline: { x: number; y: number }[]; copper: boolean }[] = [];
    // Shape offsets: the pad's copper off its hole (surface-mount pads move with it)
    const offOf = (c: PadComp | null) => {
      if (!c || (!c.offX && !c.offY)) return { x: 0, y: 0 };
      const th = (rot * Math.PI) / 180, ox2 = (back ? -1 : 1) * c.offX * f, oy2 = c.offY * f;
      return { x: Math.round(ox2 * Math.cos(th) - oy2 * Math.sin(th)), y: Math.round(ox2 * Math.sin(th) + oy2 * Math.cos(th)) };
    };
    // The padstack's own side's mask and paste (a pad on the bottom uses its top's)
    const maskOf = (top: boolean) => st.mask[back === top ? 1 : 0];
    const pasteOf = (top: boolean) => st.paste[back === top ? 1 : 0];
    /** Solder mask expansion: no opening in the padstack is a tented pad; the same size, none. */
    const mask = (top: boolean, c: PadComp | null) => {
      if (!c) return undefined;
      const m = maskOf(top);
      if (!m) return -Math.max(len(c.w), len(c.h || c.w));
      return Math.round((Math.abs(m.w) - Math.abs(c.w)) * f / 2);
    };
    const paste = (top: boolean, c: PadComp | null) => {
      const p = pasteOf(top);
      if (!c || p === undefined) return undefined;
      if (!p) return -Math.max(len(c.w), len(c.h || c.w));
      const d = Math.round((Math.abs(p.w) - Math.abs(c.w)) * f / 2);
      return d !== 0 ? d : undefined;
    };
    /** A custom (or offset) pad's mask and paste openings as regions of their own shapes (its anchor pad has none). */
    const openings = (top: boolean, withPaste: boolean) => {
      const m = maskOf(top), p = withPaste ? pasteOf(top) : undefined;
      if (m) custom.push({ layer: top ? L.TOP_SOLDER : L.BOTTOM_SOLDER, outline: polyOf(m), copper: false });
      if (p) custom.push({ layer: top ? L.TOP_PASTE : L.BOTTOM_PASTE, outline: polyOf(p), copper: false });
    };
    if (st.smd) {
      const idx = st.count === 1 && st.start < nCu ? (back ? nCu - 1 - st.start : st.start) : back ? nCu - 1 : 0;
      const layer = copperOf(idx) ?? (back ? L.BOTTOM : L.TOP);
      const c = st.copper.find((x) => x) ?? null;
      if (!c) { note('Pads with no copper and no hole'); return; }
      const sh = shapeOf(c);
      const o = offOf(c);
      const top = layer === L.TOP, outer = layer === L.TOP || layer === L.BOTTOM;
      const anchor = sh.outline ? Math.max(1, Math.round(len(Math.min(sh.w, sh.h)) / 2)) : 0;
      if (sh.outline) { custom.push({ layer, outline: polyOf(c), copper: true }); if (outer) openings(top, true); }
      pads.push(encodePad({ name: padName, layer, at: { x: at.x + o.x, y: at.y + o.y }, w: sh.outline ? anchor : Math.max(1, len(sh.w)), h: sh.outline ? anchor : Math.max(1, len(sh.h)),
        shape: sh.outline ? 'round' : sh.shape, rotation: rot, cornerPct: sh.cornerPct, net, component,
        solderExpansion: !outer ? undefined : sh.outline ? -anchor : mask(top, c), pasteExpansion: !outer ? undefined : sh.outline ? -anchor : paste(top, c) }));
    } else {
      const hole = Math.max(1, len(Math.min(st.drill, st.drillH)));
      const slot = st.drill !== st.drillH ? { length: len(Math.max(st.drill, st.drillH)), rotation: st.drill >= st.drillH ? 0 : 90 } : undefined;
      // A custom or offset outer pad: its copper a region, the pad a small ring round the hole [est]
      const ringW = hole + mil(4), anchor = slot ? (slot.rotation === 0 ? { w: slot.length + mil(4), h: ringW } : { w: ringW, h: slot.length + mil(4) }) : { w: ringW, h: ringW };
      const odd = (i: number) => { const c = st.copper[flip(i)]; return !!c && (c.type === PAD.SHAPE || !!c.offX || !!c.offY); };
      const topS = shapeAt(0), botS = shapeAt(st.count - 1), midS = st.count > 2 ? shapeAt(1) : null;
      const anyS = topS ?? midS ?? botS;
      const size = (s: ReturnType<typeof shapeOf> | null) => (s ? { w: Math.max(hole + 1, len(s.w)), h: Math.max(hole + 1, len(s.h)), shape: s.shape } : null);
      const sizeAt = (i: number, s: ReturnType<typeof shapeOf> | null) => (odd(i) ? { ...anchor, shape: 'round' as const } : size(s));
      const none = { w: slot?.rotation === 0 ? slot.length : hole, h: slot?.rotation === 90 ? slot.length : hole, shape: 'round' as const };
      const t = sizeAt(0, topS) ?? size(anyS) ?? none;
      const m = size(midS) ?? size(anyS) ?? t, bo = sizeAt(st.count - 1, botS) ?? size(anyS) ?? t;
      let shaped = false;
      for (const i of [0, st.count - 1]) if (odd(i)) { custom.push({ layer: i === 0 ? L.TOP : L.BOTTOM, outline: polyOf(st.copper[flip(i)]!), copper: true }); shaped = true; }
      if (shaped) { openings(true, false); openings(false, false); }
      pads.push(encodePad({ name: padName, layer: L.MULTI, at, w: t.w, h: t.h, shape: t.shape, rotation: rot, cornerPct: odd(0) ? undefined : topS?.cornerPct ?? anyS?.cornerPct, hole, plated: st.plated,
        slot, mid: st.count > 2 ? m : undefined, bot: bo, net, component,
        solderExpansion: shaped ? -Math.max(t.w, t.h, bo.w, bo.h) : mask(true, st.copper[flip(0)] ?? null) }));
    }
    // Custom pad shapes: the outline as copper with the pad (mask and paste openings as regions of those layers)
    for (const cu of custom) {
      const th = (rot * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
      const pts = cu.outline.map((p) => { const x = (back ? -p.x : p.x) * f, y = p.y * f; return { x: Math.round(at.x + x * cs - y * sn), y: Math.round(at.y + x * sn + y * cs) }; });
      if (pts.length >= 3) regions.push(encodeRegion({ layer: cu.layer, outline: pts, net: cu.copper ? net : undefined, component }));
    }
  };

  let nComps = 0, nPads = 0;
  const padNets: { key: string; net: number }[] = [];
  const values = new Map<number, string>();
  for (const fp of db.byType.get(0x2d) ?? []) {
    const inst = B(fp.instRef);
    const ref = inst?.t === 0x07 ? S(inst.refDes) : '';
    const back = (fp.side as number) !== 0;
    const theta = ((((fp.rotation as number) ?? 0) / 1000) % 360 + 360) % 360;
    const pos = P(fp.x as number, fp.y as number);
    const th = (theta * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    const pattern = patternOf.get(fp.key) ?? '';
    const part = inst ? partOf.get(inst.key) : undefined;
    let ci: number | undefined;
    if (ref) {
      ci = comps.length;
      const value = opts.comments?.get(ref) ?? (part ? fieldStr(part.fields, part.key, 0x02) ?? '' : '');
      const partName = part ? fieldStr(part.fields, part.key, 0xc4) ?? S(part.deviceType) : '';
      comps.push(PropertyBag.from({
        LAYER: back ? 'BOTTOM' : 'TOP', PATTERN: pattern, SOURCEDESIGNATOR: ref, SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`, FOOTPRINTDESCRIPTION: '',
        X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(back ? (theta + 180) % 360 : theta), HEIGHT: '0mil',
        NAMEON: 'FALSE', COMMENTON: 'FALSE', LOCKED: 'FALSE', COMPONENTKIND: 0, SOURCELIBREFERENCE: partName, SOURCEUNIQUEID: `\\${uniqueIdFor(`orcad:${ref}`)}`,
      }));
      values.set(ci, value);
      nComps++;
    }
    // Pads, in the symbol's own space: mirrored (bottom), turned, moved
    for (const pp of chain(fp.firstPad, fp.key, (b) => b.nextInFp as number)) {
      if (pp.t !== 0x32) break;
      const pd = B(pp.pad);
      if (!pd || pd.t !== 0x0d) continue;
      const st = stackOf(pd.padstack);
      if (!st) continue;
      const lx = (back ? -(pd.x as number) : (pd.x as number)) * f, ly = (pd.y as number) * f;
      const at = { x: Math.round(pos.x + lx * cs - ly * sn), y: Math.round(pos.y + lx * sn + ly * cs) };
      const phi = (((pd.rotation as number) ?? 0) / 1000);
      const rot = (((back ? theta - phi : theta + phi) % 360) + 360) % 360;
      const pnet = netOfAssign(pp.net);
      placePad(st, at, rot, back, S(pd.name), pnet, ci);
      if (ref && pnet !== undefined) padNets.push({ key: `${ref}\u0000${S(pd.name)}`, net: pnet });
      nPads++;
    }
    // Drawings (board coordinates already): lines, assembly, areas
    for (const g of chain(fp.graphic, fp.key)) if (g.t === 0x14) drawBlock(g, ci);
    // The assembly list's shapes are outlines, the areas list's areas (as KiCad reads them)
    for (const a of chain(fp.assembly, fp.key)) drawBlock(a, ci, false);
    for (const a of chain(fp.areas, fp.key)) drawBlock(a, ci);
    // Text: the silkscreen reference designator is the designator, the value the comment
    let desig = false, comment = false;
    const value = ci !== undefined ? values.get(ci) ?? '' : '';
    for (const t of chain(fp.text, fp.key)) {
      if (t.t !== 0x30 || done.has(t.key)) continue;
      done.add(t.key);
      const li = t.layer as LayerInfo;
      const silk = li.sub === 0xfb || li.sub === 0xfa, assy = li.sub === 0xfd || li.sub === 0xfc;
      if (ci !== undefined && li.cls === C.REFDES && silk && !desig) { textOf(t, ci, 'designator', undefined, ref); desig = true; comps[ci]!.set('NAMEON', 'TRUE'); continue; }
      if (ci !== undefined && li.cls === C.COMPVAL && silk && !comment) {
        // The comment (hidden) where the value is, the value's own drawing as AD's special string
        textOf(t, ci, 'comment', li.sub === 0xfa ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, value || undefined);
        textOf(t, ci, undefined, undefined, '.Comment');
        comment = true; continue;
      }
      // On assembly drawings: AD's special strings
      if (ci !== undefined && li.cls === C.REFDES && assy) { textOf(t, ci, undefined, undefined, '.Designator'); continue; }
      if (ci !== undefined && li.cls === C.COMPVAL && assy) { textOf(t, ci, undefined, undefined, '.Comment'); continue; }
      textOf(t, ci);
    }
    if (ci !== undefined) {
      const silkL = back ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
      if (!desig) texts.push(encodeText({ layer: silkL, at: pos, height: mil(40), text: ref, component: ci, isDesignator: true, mirrored: back }));
      if (!comment) texts.push(encodeText({ layer: silkL, at: pos, height: mil(40), text: value, component: ci, isComment: true, mirrored: back }));
    }
  }

  /* ── net names as the schematic compiles them (each board net the name most of its pins have there) ── */
  if (opts.pinNets?.size) {
    const votes = new Map<number, Map<string, number>>();
    for (const { key, net } of padNets) {
      const nm = opts.pinNets.get(key);
      if (!nm) continue;
      if (!votes.has(net)) votes.set(net, new Map());
      votes.get(net)!.set(nm, (votes.get(net)!.get(nm) ?? 0) + 1);
    }
    const ranked = [...votes].flatMap(([k, m]) => [...m].map(([nm, n]) => ({ k, nm, n }))).sort((a, b) => b.n - a.n);
    const to = new Map<number, string>(), taken = new Set<string>();
    for (const { k, nm } of ranked) if (!to.has(k) && !taken.has(nm)) { to.set(k, nm); taken.add(nm); }
    // A name a net keeps isn't given to another
    const kept = new Set(nets.filter((_, i) => !to.has(i)));
    for (const [k, nm] of to) if (nets[k] !== nm && !kept.has(nm)) nets[k] = nm;
  }

  /* ── routing: each net's tracks, vias and copper ── */
  let minRouted = Infinity, maxRouted = 0;
  const fills = new Map<number, { shape: Blk; net: number | undefined }>();
  for (const n of netBlocks) {
    const net = netIndex.get(n.key);
    for (const a of chain(n.assignment, n.key)) {
      if (a.t !== 0x04) continue;
      for (const c of chain(a.connItem, a.key)) {
        switch (c.t) {
          case 0x05: {
            const li = c.layer as LayerInfo;
            if (li.cls === C.ANTI_ETCH) { note('Anti-etch (thermal) tracks'); break; }
            const layer = layerFor(li);
            if (layer !== null) drawChain(c.firstSeg, c.key, layer, layer >= L.TOP && layer <= L.BOTTOM ? net : undefined);
            if (layer !== null && layer >= L.TOP && layer <= L.BOTTOM) for (const sg of chain(c.firstSeg, c.key)) { const w = sg.width as number; if (w > 0) { if (w < minRouted) minRouted = w; if (w > maxRouted) maxRouted = w; } }
            break;
          }
          case 0x33: {
            const st = stackOf(c.padstack);
            if (!st) break;
            const top = st.copper.find((x) => x);
            const s0 = Math.max(0, Math.min(nCu - 1, st.start)), s1 = Math.max(s0, Math.min(nCu - 1, st.start + st.count - 1));
            let hole = len(st.drill), d = top ? len(top.w) : 0;
            if (!hole) hole = Math.round(d / 2);
            if (!d) d = hole * 2;
            const span = st.count > 1 && st.count < nCu;
            vias.push(encodeVia({ at: P(c.x as number, c.y as number), diameter: Math.max(d, hole + 1), hole: Math.max(1, hole), net, layerStart: span ? copperOf(s0) ?? L.TOP : L.TOP, layerEnd: span ? copperOf(s1) ?? L.BOTTOM : L.BOTTOM }));
            break;
          }
          case 0x28: fills.set(c.key, { shape: c, net }); break;
          case 0x0e: case 0x24: {
            // A copper rectangle on the net
            const layer = layerFor(c.layer as LayerInfo);
            if (layer !== null && layer >= L.TOP && layer <= L.BOTTOM) { regions.push(encodeRegion({ layer, outline: rectOutline(c), net })); done.add(c.key); }
            break;
          }
          case 0x32: case 0x2e: break;
          default: note(`Connected objects of type 0x${c.t.toString(16)}`);
        }
      }
    }
  }

  /* ── dynamic shapes: AD polygon pours, their poured copper from the file ── */
  const usedFill = new Set<number>();
  let unpoured = 0;
  const shapeBlocks = ll('shapes');
  const boundaries = shapeBlocks.filter((b) => b.t === 0x28 && (b.layer as LayerInfo | undefined)?.cls === C.BOUNDARY)
    .map((b) => ({ b, sub: (b.layer as LayerInfo).sub, at: flat(ring(b.firstSeg))[0] }));
  for (const b of shapeBlocks) {
    const li = b.layer as LayerInfo | undefined;
    if (b.t !== 0x28 || li?.cls !== C.BOUNDARY) continue;
    done.add(b.key);
    const layer = copperOf(li.sub);
    if (layer === null) continue;
    const vs = ring(b.firstSeg);
    if (flat(vs).length < 3) continue;
    // The shape's net and fills: through its table (or the table a 0x26 points at)
    let net: number | undefined;
    const related: Blk[] = [];
    let tbl = B(b.table);
    if (tbl?.t === 0x26) tbl = B(tbl.member)?.t === 0x2c ? B(tbl.member) : B(tbl.group);
    const arr = tbl?.t === 0x2c ? B(tbl.ptr1) : undefined;
    if (arr?.t === 0x37) for (const p of ((arr.ptrs as number[]) ?? []).slice(0, Math.min(100, (arr.count as number) ?? 0))) { const x = B(p); if (x) related.push(x); }
    for (const x of related) if (x.t === 0x1b && netIndex.has(x.key)) net = netIndex.get(x.key);
    const index = polygons.length;
    const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, `${net !== undefined ? nets[net] : 'NoNet'}_${copperNames[li.sub]}_P${String(index).padStart(3, '0')}`, index);
    writeVertices(bag, vs);
    polygons.push(bag);
    let poured = false;
    for (const x of related) {
      if (x.t !== 0x28 || usedFill.has(x.key)) continue;
      const outline = flat(ring(x.firstSeg));
      if (outline.length < 3) continue;
      usedFill.add(x.key);
      regions.push(encodeRegion({ layer: copperOf((x.layer as LayerInfo).sub) ?? layer, outline, holes: holesOf(x), net: fills.get(x.key)?.net ?? net, polygon: index }));
      poured = true;
    }
    // The shape's own voids: polygon cut-outs (not round another shape poured inside the void)
    for (const h of holesOf(b)) if (!boundaries.some((o) => o.b !== b && o.sub === li.sub && o.at && pointIn(o.at, h))) regions.push(encodeRegion({ layer, outline: h, kind: 1 }));
    if (!poured) unpoured++;
  }
  if (unpoured) warnings.push(`${unpoured} dynamic shape${unpoured === 1 ? '' : 's'} with no copper in the file: repour ${unpoured === 1 ? 'it' : 'them'} (Tools › Polygon Pours)`);
  // Static copper shapes and fills no boundary claimed: regions
  for (const { shape, net } of fills.values()) {
    if (usedFill.has(shape.key)) continue;
    const layer = layerFor(shape.layer as LayerInfo);
    if (layer === null) continue;
    const outline = flat(ring(shape.firstSeg));
    if (outline.length >= 3) regions.push(encodeRegion({ layer, outline, holes: holesOf(shape), net: layer >= L.TOP && layer <= L.BOTTOM ? net : undefined }));
    done.add(shape.key);
  }

  /* ── the board outline: the largest closed outline (Outline, else Design Outline), the rest inside it cut-outs ── */
  const loops: PolyVertex[][] = [];
  const outlineSub = outlineBlocks.some((b) => (b.layer as LayerInfo).sub === 0xea) ? 0xea : 0xfd;
  const openChains: PolyVertex[][] = [];
  for (const b of outlineBlocks) {
    if ((b.layer as LayerInfo).sub !== outlineSub) continue;
    if (b.t === 0x24 || b.t === 0x0e) { loops.push(rectOutline(b).map((p) => ({ p }))); continue; }
    if (b.t === 0x28) { const vs = ring(b.firstSeg); if (flat(vs).length >= 3) loops.push(vs); continue; }
    const vs = ring(b.segment, P, false, true);
    if (vs.length >= 2) openChains.push(vs);
  }
  loops.push(...joinChains(openChains));
  const area = (vs: PolyVertex[]) => { const p = flat(vs); let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j]!.x + p[i]!.x) * (p[j]!.y - p[i]!.y); return Math.abs(a / 2); };
  loops.sort((a, b) => area(b) - area(a));
  let outline: PolyVertex[] = loops[0] ?? [];
  if (flat(outline).length < 3) {
    warnings.push('No board outline (Board Geometry / Outline): the board shape is drawn round its contents');
    // Round what is placed so far (components, routing), 100 mil clear of it
    const m = mil(100), [x0, y0, x1, y1] = Number.isFinite(lo.x) ? [lo.x - m, lo.y - m, hi.x + m, hi.y + m] : [mil(1000), mil(1000), mil(5000), mil(4000)];
    outline = [{ p: { x: x0, y: y0 } }, { p: { x: x1, y: y0 } }, { p: { x: x1, y: y1 } }, { p: { x: x0, y: y1 } }];
  } else {
    const main = flat(outline);
    for (const l of loops.slice(1)) {
      const pts = flat(l);
      if (pts.length >= 3 && pointIn(pts[0]!, main)) regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true }));
    }
  }

  /* ── everything else: board drawings, shapes and text ── */
  for (const b of ll('0x14')) if (b.t === 0x14) drawBlock(b);
  for (const b of [...ll('0x24_0x28'), ...shapeBlocks]) {
    if (b.t !== 0x24 && b.t !== 0x28 && b.t !== 0x0e) continue;
    const li = b.layer as LayerInfo | undefined;
    if (li?.cls === C.ETCH && b.t === 0x28 && !done.has(b.key)) {
      // Copper shapes with no net
      const layer = layerFor(li);
      const o = flat(ring(b.firstSeg));
      done.add(b.key);
      if (layer !== null && o.length >= 3) regions.push(encodeRegion({ layer, outline: o, holes: holesOf(b) }));
      continue;
    }
    drawBlock(b);
  }
  for (const t of ll('0x03_0x30')) if (t.t === 0x30 && !done.has(t.key)) { done.add(t.key); textOf(t); }
  // Text in no list (in groups): every text not yet placed
  for (const t of db.byType.get(0x30) ?? []) if (!done.has(t.key) && (t.group as number)) { done.add(t.key); textOf(t); }

  /** Allegro's physical constraint sets (0x1D: line width and spacing, the first layer's) as rules: mm. */
  function constraintRules() {
    const toMm = (v: number) => (v * f) / mm(1);
    const v17 = db.ver >= V.V172;
    const sets = new Map<string, { key: number; width?: number; clearance?: number }>();
    let i = 0;
    for (const b of db.byType.get(0x1d) ?? []) {
      let nm = S(b.name);
      if (!nm) { const fb = B(b.field); const raw = fb?.t === 0x03 && typeof fb.value === 'string' ? fb.value : ''; const at = raw.indexOf(':\\'); nm = at >= 0 ? raw.slice(at + 2).replace(/\\$/, '') : ''; }
      if (!nm) nm = `CS_${i}`;
      i++;
      const rec = (b.dataB as Int32Array[] | undefined)?.[0];
      if (!rec) continue;
      const w = v17 ? rec[1]! : rec[0]!, c = v17 ? rec[4]! : rec[1]!;
      sets.set(nm, { key: b.name as number, width: w > 0 ? toMm(w) : undefined, clearance: c > 0 ? toMm(c) : undefined });
    }
    // DEFAULT, else the first set (Allegro's first is its default; 16.x boards may not name it) [est]
    const def = [...sets].find(([n]) => /^default$/i.test(n))?.[1] ?? [...sets.values()][0];
    // The vias most used, the narrowest track
    const viaCount = new Map<string, number>();
    for (const v of db.byType.get(0x33) ?? []) { const st = stackOf(v.padstack); const top = st?.copper.find((x) => x); if (st && top && st.drill) { const k = `${top.w}/${st.drill}`; viaCount.set(k, (viaCount.get(k) ?? 0) + 1); } }
    const via = [...viaCount].sort((a, b) => b[1] - a[1])[0]?.[0].split('/').map(Number);
    const minTrack = minRouted;
    const byKey = new Map([...sets].map(([n, x]) => [x.key, n]));
    const members = new Map<string, string[]>();
    for (const n of netBlocks) {
      const k = netIndex.get(n.key);
      if (k === undefined) continue;
      const fld = chain(n.fields, n.key).find((x) => x.t === 0x03 && x.code === 0x1a0);
      const set = typeof fld?.value === 'string' ? (sets.has(fld.value) ? fld.value : undefined) : typeof fld?.value === 'number' ? byKey.get(fld.value) : undefined;
      if (!set || /^default$/i.test(set) || sets.get(set) === def) continue;
      if (!members.has(set)) members.set(set, []);
      members.get(set)!.push(nets[k]!);
    }
    return {
      clearance: def?.clearance, trackWidth: def?.width, minTrack: Number.isFinite(minTrack) ? toMm(minTrack) : undefined,
      viaDiameter: via ? toMm(via[0]!) : undefined, viaDrill: via ? toMm(via[1]!) : undefined,
      classes: [...members].map(([n, ns]) => ({ name: n.replace(/[^\w-]/g, '_'), nets: ns, trackWidth: sets.get(n)?.width, clearance: sets.get(n)?.clearance })),
    };
  }

  /* ── the board ── */
  const xs = flat(outline).map((p) => p.x), ys = flat(outline).map((p) => p.y);
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: { x: Math.round(ox), y: Math.round(oy) }, outline,
    sheet: { x: 0, y: 0, width: Math.max(Math.max(...xs) + mil(2000), hi.x + mil(500)), height: Math.max(Math.max(...ys) + mil(2000), hi.y + mil(500)) }, mechanical: [...mechNames.keys()] });
  for (const [n, nm] of mechNames) board.set(`LAYER${mechLayer(n)}NAME`, nm);
  // Rules: the physical constraint sets' widths and spacings (DEFAULT the board's, the rest net classes), vias from what the board uses most
  const { rules, classes } = boardRules(constraintRules(), nets, nets);
  // Width rules wide enough for every routed track (Allegro's line widths are per net and layer) [est]
  if (maxRouted > 0) for (const r of rules) {
    if (r.bag.get('RULEKIND') !== 'Width') continue;
    const mmOf = (k: string) => { const v = r.bag.get(k) ?? ''; const n = Number.parseFloat(v); return /mil$/i.test(v) ? n * 0.0254 : n; };
    const lo = (minRouted * f) / mm(1), hi = (maxRouted * f) / mm(1);
    if (Number.isFinite(lo) && lo < mmOf('MINLIMIT')) r.bag.set('MINLIMIT', `${Math.round(lo * 10000) / 10000}mm`);
    if (hi > mmOf('MAXLIMIT')) r.bag.set('MAXLIMIT', `${Math.round(hi * 10000) / 10000}mm`);
  }
  const pcb = assemblePcbDoc({ board, nets, comps, polygons, pads, tracks, vias, arcs, texts, regions, rules, classes }, `${name}.PcbDoc`);
  applyStackLayers(pcb, copperNames.slice(0, Math.min(32, nCu)).map((n) => ({ name: n })), []);
  for (const [n, nm] of mechNames) pcb.board.layerNames.set(mechLayer(n), nm);
  for (const [k, n] of tally) warnings.push(`Left out or approximated: ${k} (${n})`);
  const footprints = footprintsFromBoard(pcb);
  return {
    result: { bytes: writePcbDoc(pcb), name, footprints, warnings,
      stats: { components: nComps, pads: nPads, vias: vias.length, tracks: nTracks, nets: nets.length, layers: nCu, pours: polygons.length } },
    lo: { x: Math.min(lo.x, ...xs), y: Math.min(lo.y, ...ys) },
  };
}

/** An Allegro arc's (0x01) extreme points on the axes its sweep crosses (its own coordinates). */
function arcExtremes(s: Blk): Vec2[] {
  const cx = s.cx as number, cy = s.cy as number, sx = s.sx as number, sy = s.sy as number, ex = s.ex as number, ey = s.ey as number;
  const r = Math.hypot(sx - cx, sy - cy);
  if (!Number.isFinite(r) || r <= 0) return [];
  const deg = (y: number, x: number) => ((((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360;
  const a0 = deg(sy - cy, sx - cx), a1 = deg(ey - cy, ex - cx), full = sx === ex && sy === ey;
  const cw = ((s.subType as number) & 0x40) !== 0;
  const mod = (v: number) => ((v % 360) + 360) % 360;
  return [0, 90, 180, 270].filter((q) => full || (cw ? mod(a0 - q) <= mod(a0 - a1) : mod(q - a0) <= mod(a1 - a0)))
    .map((q) => ({ x: cx + r * Math.cos((q * Math.PI) / 180), y: cy + r * Math.sin((q * Math.PI) / 180) }));
}

/** Open chains joined end to end into closed loops (the board outline drawn as separate lines). */
function joinChains(chains: PolyVertex[][]): PolyVertex[][] {
  const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) <= 50 && Math.abs(a.y - b.y) <= 50;
  const rev = (c: PolyVertex[]): PolyVertex[] => c.map((_, j) => ({ p: c[c.length - 1 - j]!.p, arc: j < c.length - 1 ? c[c.length - 2 - j]!.arc : undefined }));
  const pool = chains.map((c) => c.slice());
  const out: PolyVertex[][] = [];
  while (pool.length) {
    let cur = pool.shift()!;
    for (let grew = true; grew && !near(cur[0]!.p, cur[cur.length - 1]!.p);) {
      grew = false;
      const end = cur[cur.length - 1]!.p;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i]!;
        if (near(c[0]!.p, end)) { cur = [...cur.slice(0, -1), { ...cur[cur.length - 1]!, arc: c[0]!.arc }, ...c.slice(1)]; pool.splice(i, 1); grew = true; break; }
        if (near(c[c.length - 1]!.p, end)) { const r = rev(c); cur = [...cur.slice(0, -1), { ...cur[cur.length - 1]!, arc: r[0]!.arc }, ...r.slice(1)]; pool.splice(i, 1); grew = true; break; }
      }
    }
    if (cur.length >= 3 && near(cur[0]!.p, cur[cur.length - 1]!.p)) {
      const last = cur[cur.length - 1]!;
      if (!last.arc) cur = cur.slice(0, -1);
      out.push(cur);
    }
  }
  return out;
}

function pointIn(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

